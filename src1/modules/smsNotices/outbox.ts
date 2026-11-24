import logger from '@/services/logger';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import { canonicalMobile } from '@/modules/common/utils/phone';
import UserModel from '@/modules/user/model';
import { SMS_NOTICE_KEY, SmsNoticeModel, type ISmsNotice, type SmsBookingKind, type SmsEvent } from '@/modules/smsNotices/model';
import { smsFlags } from '@/modules/smsNotices/flags';
import { chooseTemplate, needsUnicode, render, type SendableTemplate, type SmsMessage } from '@/modules/smsNotices/templates';

/**
 * Phase 5 (ASSISTED_BOOKING_DESIGN.md §27.5.2): queue one SMS, after the booking's commit. It never throws, never sends
 * and never runs inside a transaction: SMS can never change or delay a booking. A second enqueue of the same
 * (booking, event, version) changes nothing. Without the outbox's unique index (sync-indexes not run) nothing is queued.
 */
export async function enqueueSms(n: { bookingKind: Exclude<SmsBookingKind, 'admin_test'>; bookingId: string; event: SmsEvent; version: string;
  dueAt?: Date; recipientUserId?: string }): Promise<void> {
  try {
    if (!smsFlags.enabled()) return;
    await assertUniqueIndex(SmsNoticeModel, SMS_NOTICE_KEY);
    await SmsNoticeModel.create({ bookingKind: n.bookingKind, bookingId: String(n.bookingId).toLowerCase(), event: n.event, version: n.version,
      ...(n.recipientUserId ? { recipientUserId: n.recipientUserId } : {}), state: 'queued', dueAt: n.dueAt ?? new Date(), attempts: 0 });
  } catch (e) {
    if (isDuplicateKeyError(e)) return;
    logger.warn('sms enqueue skipped', { event: n.event, bookingKind: n.bookingKind,
      reason: (e as { code?: string })?.code === 'INDEXES_OUTDATED' ? 'indexes_outdated' : 'enqueue_failed' });
  }
}

/**
 * What an event's SMS says, decided by the drain from the booking as it is now (round 5b registers one composer per
 * event). `messages` lists the preferred message first (the link variant, then the plain one); `values` are the
 * template variables by name. `{ skip }` = the event is no longer true (`stale`, `disputed`, …).
 */
export type SmsComposition = { userId: string; lang: string; messages: SmsMessage[]; values: Record<string, string> };
export type SmsComposer = (row: ISmsNotice, now: Date) => Promise<SmsComposition | { skip: string }>;
const composers = new Map<SmsEvent, SmsComposer>();
export function setSmsComposer(event: SmsEvent, c?: SmsComposer): void {
  if (c) composers.set(event, c); else composers.delete(event);
}
export const composerOf = (event: SmsEvent) => composers.get(event);

/** A ready SMS, or why it is skipped (shared by the drain and the admin test send). */
export type PreparedSms = { to: string; text: string; unicode: boolean; template: SendableTemplate } | { skip: string };

export async function prepareSms(userId: string, lang: string, messages: SmsMessage[], values: Record<string, string>): Promise<PreparedSms> {
  const user = await UserModel.findById(userId).select({ phone: 1, isActive: 1 }).lean() as { phone?: string; isActive?: boolean } | null;
  const to = canonicalMobile(user?.phone);
  if (!to) return { skip: 'no_phone' };
  if (user?.isActive === false) return { skip: 'recipient_inactive' };
  return prepareText(to, lang, messages, values);
}

export function prepareText(to: string, lang: string, messages: SmsMessage[], values: Record<string, string>): PreparedSms {
  const template = chooseTemplate(messages, lang);
  return template ? textFor(to, template, values) : { skip: 'no_template' };
}

export function textFor(to: string, template: SendableTemplate, values: Record<string, string>): PreparedSms {
  const text = render(template, values);
  if (!text) return { skip: 'template_values_missing' };
  const unicode = needsUnicode(text);
  if (unicode && !smsFlags.unicodeParam()) return { skip: 'unicode_not_configured' };
  return { to, text, unicode, template };
}
