import { ClientSession } from 'mongoose';
import { Container } from 'typedi';
import logger from '@/services/logger';
import { AssistedAuditEventModel, IAssistedAuditEvent } from '@/modules/assisted/model';
import type { IBooking } from '@/modules/bookings/types';
import type { NotificationType } from '@/modules/notification/types';

/**
 * Assisted booking phase 1a: the audit written inside each command's transaction (§6.1; ids and codes only), the
 * in-app notices sent after the commit (§6.5; best effort, idempotent keys, never health details for the booker) and the
 * booking side effects after the commit (Meet, reminders). Notices and effects are replaceable (tests).
 */
export async function auditIn(e: Omit<IAssistedAuditEvent, 'at'>, s: ClientSession | null): Promise<void> {
  await AssistedAuditEventModel.create([{ ...e, at: new Date() }], { session: s ?? undefined });
}

export interface AssistedNotice {
  audience: 'customer' | 'doctor' | 'booker';
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  bookingId: string;
  key: string;
  data?: Record<string, unknown>;
}
export type AssistedNotifier = (n: AssistedNotice) => Promise<void>;

export const defaultAssistedNotifier: AssistedNotifier = async (n) => {
  const { NotificationService } = await import('@/modules/notification/services');
  await Container.get(NotificationService).create({ userId: n.userId, type: n.type, title: n.title, message: n.message,
    referenceType: 'booking', referenceId: n.bookingId, idempotencyKey: n.key, data: { bookingId: n.bookingId, ...(n.data ?? {}) } });
};
let notifier: AssistedNotifier = defaultAssistedNotifier;
export function setAssistedNotifier(n?: AssistedNotifier): AssistedNotifier {
  const prev = notifier;
  notifier = n ?? defaultAssistedNotifier;
  return prev;
}

/** After the commit only; a failure is logged by kind and never fails or undoes the operation. */
export async function sendAssistedNotices(notices: AssistedNotice[]): Promise<void> {
  for (const n of notices) {
    try { await notifier(n); } catch (e) { logger.warn('assisted notice failed', { audience: n.audience, type: n.type, error: (e as Error)?.message }); }
  }
}

export interface AssistedEffects {
  /** Creates or moves the Meet event (neutral text for assisted rows); returns the booking as stored after it. */
  /** r10f: `signal` bounds the Google calls (the card follow-up passes one shorter than its lease). */
  meet: (b: IBooking, opts?: { signal?: AbortSignal }) => Promise<IBooking>;
  cancelMeet: (b: IBooking, reason: string) => Promise<IBooking>;
  reminders: (b: IBooking) => Promise<void>;
  clearReminders: (bookingId: string) => Promise<void>;
}

export const defaultAssistedEffects: AssistedEffects = {
  meet: async (b, opts) => {
    const [{ syncBookingMeet }, { BookingRepository }, { UserRepository }, { SpecialistRepository }, { SlotRepository }] = await Promise.all([
      import('@/modules/meet/service'), import('@/modules/bookings/repository'), import('@/modules/user/repository'),
      import('@/modules/specialists/repository'), import('@/modules/slots/repository')]);
    return syncBookingMeet({ booking: b, bookingRepository: new BookingRepository(), userRepository: new UserRepository(),
      specialistRepository: new SpecialistRepository(), slotRepository: new SlotRepository(), ...(opts?.signal ? { signal: opts.signal } : {}) });
  },
  cancelMeet: async (b, reason) => {
    const [{ cancelBookingMeet }, { BookingRepository }] = await Promise.all([import('@/modules/meet/service'), import('@/modules/bookings/repository')]);
    return cancelBookingMeet({ booking: b, reason, bookingRepository: new BookingRepository() });
  },
  reminders: async (b) => {
    const { BookingReminderScheduler } = await import('@/modules/bookings/services/bookingReminderScheduler');
    await new BookingReminderScheduler().scheduleBookingReminders(b);
  },
  clearReminders: async (id) => {
    const { BookingReminderScheduler } = await import('@/modules/bookings/services/bookingReminderScheduler');
    await new BookingReminderScheduler().clearBookingReminders(id);
  },
};
let effects: AssistedEffects = defaultAssistedEffects;
export function setAssistedEffects(e?: Partial<AssistedEffects>): AssistedEffects {
  const prev = effects;
  effects = e ? { ...defaultAssistedEffects, ...e } : defaultAssistedEffects;
  return prev;
}
export const assistedEffects = (): AssistedEffects => effects;

/** Runs one side effect after the commit; failures are logged and swallowed. */
export async function bestEffort<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (e) { logger.warn(`assisted ${what} failed`, { error: (e as Error)?.message }); return fallback; }
}
