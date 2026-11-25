import cron from 'node-cron';
import logger from '@/services/logger';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { freeLease } from '@/modules/common/utils/lease';
import { raiseAlertIn } from '@/modules/assisted/limits';
import { finishedFields, SMS_NOTICE_KEY, SmsNoticeModel, type ISmsNotice } from '@/modules/smsNotices/model';
import { smsFlags } from '@/modules/smsNotices/flags';
import { sendBounded, smsProvider } from '@/modules/smsNotices/provider';
import { composerOf, prepareSms } from '@/modules/smsNotices/outbox';

/**
 * Phase 5 (ASSISTED_BOOKING_DESIGN.md §27.5.3): the drain loop. Every 15 s it takes up to 50 due rows; each is claimed
 * (a 60 s lease judged on the wall clock, as the Meet retry) before at most one bounded gateway call, and its outcome is
 * written only by the claim that holds it. Retryable failures come back after 2, then 10 minutes, up to
 * SMS_NOTICE_MAX_ATTEMPTS; then the row fails and one `sms_failed` alert is raised for the day. Three retryable failures
 * in a row end the tick (gateway down). Delivery is at least once: a crash between the gateway's answer and the outcome
 * write sends again after the lease. Logs carry codes and counts only.
 */
const LEASE_MS = 60_000;
const BATCH = 50;
const BACKOFF_MS = [2 * 60_000, 10 * 60_000];

type Outcome = 'sent' | 'retry' | 'failed' | 'skipped' | 'deferred';

async function finish(_id: unknown, lease: Date, set: Partial<ISmsNotice>, unset: Record<string, ''> = {}): Promise<boolean> {
  const r = await SmsNoticeModel.collection.updateOne({ _id: _id as never, state: 'sending', leaseUntil: lease },
    { $set: { ...set, updatedAt: new Date() }, $unset: { leaseUntil: '', ...unset } });
  return r.modifiedCount === 1;
}
const done = (state: 'sent' | 'failed' | 'skipped', extra: Partial<ISmsNotice> = {}) => ({ state, ...finishedFields(new Date()), ...extra });
type Result = { outcome: Outcome; reason?: string; retryable?: boolean };

/** A failed call (or an unexpected error): back after 2, then 10 minutes, until the attempts run out. */
async function failure(row: ISmsNotice, lease: Date, now: Date, reason: string, retryable: boolean, extra: Partial<ISmsNotice> = {}): Promise<Result> {
  if (retryable && row.attempts < smsFlags.maxAttempts()) {
    const wait = BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length) - 1]!;
    await finish(row._id, lease, { state: 'queued', reason, dueAt: new Date(now.getTime() + wait), ...extra });
    return { outcome: 'retry', reason, retryable };
  }
  await finish(row._id, lease, done('failed', { reason, ...extra }));
  return { outcome: 'failed', reason, retryable };
}

/** One claimed row: compose, send once (bounded), record. */
async function handle(row: ISmsNotice, lease: Date, now: Date): Promise<Result> {
  const skip = async (reason: string) => { await finish(row._id, lease, done('skipped', { reason })); return { outcome: 'skipped' as const, reason }; };
  if (!smsFlags.enabled()) return skip('switched_off');
  if (!smsProvider().configured()) return skip('provider_not_configured');
  const composer = composerOf(row.event);
  if (!composer) return skip('no_composer');
  const c = await composer(row, now);
  if ('skip' in c) return skip(c.skip);
  if ('later' in c) {
    await finish(row._id, lease, { state: 'queued', dueAt: c.later, attempts: row.attempts - 1 });
    return { outcome: 'deferred' };
  }
  const sms = await prepareSms(row.recipientUserId ?? c.userId, c.lang, c.messages, c.values);
  if ('skip' in sms) return skip(sms.skip);
  const r = await sendBounded({ to: sms.to, text: sms.text, templateId: sms.template.templateId, unicode: sms.unicode });
  const chosen = { message: sms.template.message, lang: sms.template.lang, ...(r.status ? { providerStatus: r.status } : {}) };
  if (!r.ok) return failure(row, lease, now, r.code, r.retryable, chosen);
  await finish(row._id, lease, done('sent', { ...chosen, sentAt: new Date() }), { reason: '' });
  return { outcome: 'sent' };
}

/** One tick. `now` is when rows count as due (tests move it); leases are always judged on the wall clock. */
export async function drainSmsOnce(now: Date = new Date()): Promise<Record<Outcome, number> & { claimed: number; stopped: boolean }> {
  const out = { sent: 0, retry: 0, failed: 0, skipped: 0, deferred: 0, claimed: 0, stopped: false };
  if (smsFlags.enabled()) await assertUniqueIndex(SmsNoticeModel, SMS_NOTICE_KEY);
  const rows = await SmsNoticeModel.find({ state: { $in: ['queued', 'sending'] }, dueAt: { $lte: now } })
    .sort({ dueAt: 1 }).limit(BATCH).lean() as ISmsNotice[];
  let downInARow = 0;
  for (const row of rows) {
    const lease = new Date(Date.now() + LEASE_MS);
    const claimed = await SmsNoticeModel.findOneAndUpdate(
      { _id: row._id, state: { $in: ['queued', 'sending'] }, dueAt: { $lte: now }, ...freeLease('leaseUntil') },
      { $set: { state: 'sending', leaseUntil: lease }, $inc: { attempts: 1 } }, { new: true }).lean() as ISmsNotice | null;
    if (!claimed) continue;
    out.claimed += 1;
    // An unexpected error (the database, a composer) is retried like a gateway failure.
    const r = await handle(claimed, lease, now).catch(() => failure(claimed, lease, now, 'error', true).catch((): Result => ({ outcome: 'retry', retryable: true })));
    out[r.outcome] += 1;
    if (r.outcome === 'failed') {
      await raiseAlertIn({ kind: 'sms_failed', subject: 'sms', detail: { reason: r.reason } }).catch(() => undefined);
    }
    downInARow = r.retryable ? downInARow + 1 : 0;
    if (downInARow >= 3) { out.stopped = true; break; }
  }
  return out;
}

let started = false;
let running = false;
/** Started with the other schedulers (src1/index.ts); several instances only contend for the per-row lease. */
export function runSmsNoticeScheduler(): void {
  if (started) return;
  started = true;
  cron.schedule('*/15 * * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const out = await drainSmsOnce();
      if (out.claimed) logger.info('SMS notices', out);
    } catch (error) {
      logger.warn('SMS notices tick skipped', { reason: (error as { code?: string })?.code === 'INDEXES_OUTDATED' ? 'indexes_outdated' : 'error' });
    } finally { running = false; }
  });
}
