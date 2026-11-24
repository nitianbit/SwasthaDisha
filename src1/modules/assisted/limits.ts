import { createHash, createHmac } from 'crypto';
import { ClientSession } from 'mongoose';
import { CONFIG } from '@/config/config';
import { AppError } from '@/modules/common/types';
import { IST_OFFSET_MS, businessClock, istDateIso } from '@/modules/common/utils/istDate';
import { AssistedAlertModel, AssistedCounterModel } from '@/modules/assisted/model';
import { assistedLimits } from '@/modules/assisted/flags';

/**
 * Assisted booking phase 1a (design §6.2, §8.7, P7, P10, ASSUMED D10): limits per ORGANISATION (not per actor), per
 * phone number and per booker, on Mongo counters shared by every instance (the O1 pattern). Day windows are India
 * calendar days. A hit answers 429 ASSISTED_LIMIT_REACHED with `limit` naming the limit.
 */
/** r10g: the lookup limit is the only one left (owner, 23 Nov). */
export type LimitName = 'lookups';

export class AssistedLimitError extends AppError {
  limit: LimitName;
  retryAfter: number;
  constructor(limit: LimitName, retryAfter: number) {
    super({ status: 429, code: 'ASSISTED_LIMIT_REACHED', message: limitMessage(limit) });
    this.limit = limit;
    this.retryAfter = Math.max(1, retryAfter);
  }
}

function limitMessage(limit: LimitName): string {
  void limit;
  return 'Too many patient lookups this hour; try again later';
}

const keyMaterial = () => createHash('sha256').update(`${CONFIG.JWT_SECRET_KEY}:assisted-limits-v1`).digest();
/** A stable, non-reversible counter name for a phone number (no phone is ever stored in a key). */
export const phoneKey = (phone: string) => createHmac('sha256', keyMaterial()).update(`phone|${phone}`).digest('base64url').slice(0, 32);

const DAY_MS = 86_400_000;
/** The end of the India day containing `now` (ms). */
const istDayEnd = (now: number) => Math.floor((now + IST_OFFSET_MS) / DAY_MS) * DAY_MS + DAY_MS - IST_OFFSET_MS;
const dayId = (kind: string, name: string, now: number) => `${kind}:${istDateIso(now)}:${name}`;

async function bump(id: string, by: number, expireAt: Date, s?: ClientSession): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      const row = await AssistedCounterModel.findOneAndUpdate({ _id: id }, { $inc: { count: by }, $setOnInsert: { expireAt } },
        { upsert: true, new: true, session: s ?? null }).lean();
      return Number(row?.count ?? 0);
    } catch (e) {
      if ((e as { code?: number }).code === 11000 && attempt < 3 && !s) continue;
      throw e;
    }
  }
}

const now = () => businessClock.now();

/** Lookups: at most N per organisation and clock hour; every call counts (refused ones too). */
export async function hitLookup(orgKey: string): Promise<void> {
  const t = now();
  const hour = 3_600_000;
  const index = Math.floor(t / hour);
  const count = await bump(`lookups:${index}:${orgKey}`, 1, new Date((index + 1) * hour + 60_000));
  if (count > assistedLimits.lookupsPerHour()) throw new AssistedLimitError('lookups', Math.ceil(((index + 1) * hour - t) / 1000));
}

// r10g (owner, 23 Nov): the new-account, per-phone and booker-cancellation STOPS are removed; only the hourly lookup
// limit above still refuses. Booker cancellations are still counted, for the alert below.
const cancelId = (orgKey: string, t: number) => dayId('booker_cancellations', orgKey, t);

/** In the cancellation transaction: counts a booker cancellation; at the threshold an alert is raised (P10; alert only since r10g). */
export async function countBookerCancellationIn(orgKind: string, orgId: string, s: ClientSession): Promise<number> {
  const t = now();
  const count = await bump(cancelId(`${orgKind}:${orgId}`, t), 1, new Date(istDayEnd(t) + DAY_MS), s);
  if (count === assistedLimits.bookerCancellationsPerDay()) {
    await raiseAlertIn({ kind: 'booker_cancellations', bookerKind: orgKind, bookerId: orgId, detail: { cancellations: count } }, s);
  }
  return count;
}

/** P10: the same booker–doctor pair alerts at N bookings in a day (the booking is never refused for it). */
export async function countPairBookingIn(orgKind: string, orgId: string, doctorId: string, s: ClientSession): Promise<void> {
  const t = now();
  const count = await bump(dayId('pair_bookings', `${orgKind}:${orgId}:${doctorId}`, t), 1, new Date(istDayEnd(t) + DAY_MS), s);
  if (count === assistedLimits.samePairAlertPerDay()) {
    await raiseAlertIn({ kind: 'same_pair_bookings', bookerKind: orgKind, bookerId: orgId, detail: { doctorId, bookings: count } }, s);
  }
}

/** One alert per (kind, subject, India day); a repeat changes nothing. */
export async function raiseAlertIn(a: { kind: string; bookerKind?: string; bookerId?: string; detail?: Record<string, unknown>; subject?: string },
  s?: ClientSession | null): Promise<void> {
  const day = istDateIso(now());
  const key = `${a.kind}:${a.subject ?? `${a.bookerKind ?? ''}:${a.bookerId ?? ''}`}:${day}`;
  await AssistedAlertModel.updateOne({ key }, { $setOnInsert: { key, kind: a.kind, bookerKind: a.bookerKind, bookerId: a.bookerId, day,
    detail: a.detail ?? {}, at: new Date(now()) } }, { upsert: true, session: s ?? null });
}

/** Today's booker cancellation count (reconciliation report). */
export async function bookerCancellationsToday(orgKey: string): Promise<number> {
  const row = await AssistedCounterModel.findById(cancelId(orgKey, now())).lean();
  return Number(row?.count ?? 0);
}
