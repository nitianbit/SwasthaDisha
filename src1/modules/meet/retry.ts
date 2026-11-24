import cron from 'node-cron';
import { Types } from 'mongoose';
import logger from '@/services/logger';
import BookingModel from '@/modules/bookings/model';
import type { IBooking } from '@/modules/bookings/types';
import { BookingRepository } from '@/modules/bookings/repository';
import { UserRepository } from '@/modules/user/repository';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { SlotRepository } from '@/modules/slots/repository';
import { appointmentStartOf } from '@/modules/bookings/holds';
import { istTodayYyyymmdd } from '@/modules/common/utils/istDate';
import { permanentMeetFailure, syncBookingMeet } from '@/modules/meet/service';
import { raiseAlertIn } from '@/modules/assisted/limits';
import { doctorExistsIneligible } from '@/modules/specialists/eligibility';

/**
 * r10g (M1 of the r10f review): a paid call/video consultation whose Meet link was never made (missing) or whose last
 * attempt failed (`virtualMeeting.status: 'failed'`: a Google error, the follow-up's time limit, missing config) is
 * retried here, for EVERY such booking — customer, clinic online, wallet- and card-paid assisted alike.
 *
 * - Which: confirmed and paid, consultation or second opinion, mode video or call, starting within the next 48 hours
 *   and not ended (start + 60 minutes), with no active link. A booking with an active link is never touched; a missing
 *   link is left alone for 15 minutes after the confirmation (the payment follow-up makes it).
 * - One claimer per booking: `meetRetry.leaseUntil` set only while free (5 minutes); each attempt's Google calls are
 *   bounded well inside it (ASSISTED_MEET_TIMEOUT_MS, default 60 s, at most half the lease), so two workers never
 *   create two events.
 * - Back-off per booking (`meetRetry.attempts`, `nextAt`: 5 minutes doubling, at most 2 hours); after 3 failed
 *   attempts an alert `meet_link_missing` is raised once for admins (assisted alerts list and stuck money).
 * r10h (review of r10g):
 * - Never a second invite: the attempt reuses the event Google already holds for the booking (`reuseExisting`: a failed
 *   record's event is re-read, else the booking's own event is looked up before any create).
 * - S5: a booking whose doctor is not verified and active is skipped (no Google call: the invite names the patient).
 * - No starvation: the query starts today (India time) and the whole due set is scanned (only the attempts are capped);
 *   a booking found ended is marked (`meetRetry.endedFor`: that appointment) and left out of the query until it moves.
 * - A failure no retry can fix (patient or doctor without email, Meet not configured, slot missing) closes the booking
 *   (`closed: 'permanent'`, `closedReason`) after one attempt. Alerts: one per booking, except a customer booking whose
 *   patient has no email (phone-only customers are common; listed in stuck money, no alert) and "not configured" (one
 *   alert a day for all bookings).
 * - Attempts go back to 0 on success; the retry's own writes never change the booking's `updatedAt`.
 */
const LEASE_MS = 5 * 60_000;
const WINDOW_MS = 48 * 3_600_000;
const ASSUMED_LENGTH_MS = 60 * 60_000;
const SETTLE_MS = 15 * 60_000;
export const MEET_ALERT_AFTER = 3;
const bound = () => {
  const v = Number(process.env.ASSISTED_MEET_TIMEOUT_MS);
  return Math.min(Number.isSafeInteger(v) && v > 0 ? v : 60_000, LEASE_MS / 2);
};
const NO_LINK = { $or: [{ virtualMeeting: { $exists: false } }, { virtualMeeting: null }, { 'virtualMeeting.status': 'failed' }] };

/**
 * The candidate filter (shared by the retry and the stuck-money list). r10h: from today (India time) only, and never a
 * booking already found ended at its current appointment; the exact "not ended" test (start + 60 minutes) runs per row.
 */
function candidateFilter(now: Date): Record<string, unknown> {
  return {
    bookingType: { $in: ['consultation', 'second-opinion'] }, consultationMode: { $in: ['video', 'call'] }, status: 'confirmed', paymentStatus: 'paid',
    bookingDate: { $gte: istTodayYyyymmdd(now), $lte: istTodayYyyymmdd(new Date(now.getTime() + WINDOW_MS)) },
    // Found ended at this very appointment (a later move to another slot brings the booking back).
    $expr: { $ne: [{ $ifNull: ['$meetRetry.endedFor', null] }, APPOINTMENT_KEY] },
    ...NO_LINK,
  };
}
const APPOINTMENT_KEY = { $concat: [{ $ifNull: ['$bookingDate', ''] }, ' ', { $ifNull: ['$bookingTime', ''] }] };
const appointmentKeyOf = (b: IBooking) => `${b.bookingDate ?? ''} ${b.bookingTime ?? ''}`;

/** The consultation's start (an instant one: when it was accepted); null when the time does not parse. */
const startOf = (b: IBooking): Date | null => (b.bookingKind === 'instant' && b.createdAt ? new Date(b.createdAt)
  : appointmentStartOf(b));
/** Over (start + 60 minutes), or no start at all: nothing left to link. */
const ended = (b: IBooking, now: Date) => { const start = startOf(b); return !start || start.getTime() + ASSUMED_LENGTH_MS <= now.getTime(); };
const upcoming = (b: IBooking, now: Date) => !ended(b, now) && startOf(b)!.getTime() <= now.getTime() + WINDOW_MS;
function settled(b: IBooking, now: Date): boolean {
  if (b.virtualMeeting?.status === 'failed') return true;
  const confirmedAt = (b.lifecycle as { confirmed?: { at?: string | Date } } | undefined)?.confirmed?.at ?? b.createdAt;
  return !!confirmedAt && new Date(confirmedAt).getTime() <= now.getTime() - SETTLE_MS;
}

/** One `meet_link_missing` alert per booking (`subject` groups a cause shared by every booking, e.g. missing config). */
async function alertOnce(_id: Types.ObjectId, b: (IBooking & { meetRetry?: Record<string, any> }) | null, detail: Record<string, unknown>, subject = String(_id)) {
  if (b?.meetRetry?.alertedAt) return;
  await raiseAlertIn({ kind: 'meet_link_missing', subject, ...(b?.assisted ? { bookerKind: b.assisted.bookedBy.kind, bookerId: b.assisted.bookedBy.id } : {}),
    detail: { bookingId: String(_id), assisted: !!b?.assisted, error: b?.virtualMeeting?.error ?? null, ...detail } }).catch(() => undefined);
  await BookingModel.collection.updateOne({ _id }, { $set: { 'meetRetry.alertedAt': new Date() } });
}

type Sync = (b: IBooking, signal: AbortSignal) => Promise<IBooking>;
const defaultSync: Sync = (booking, signal) => syncBookingMeet({ booking, bookingRepository: new BookingRepository(), userRepository: new UserRepository(),
  specialistRepository: new SpecialistRepository(), slotRepository: new SlotRepository(), signal, reuseExisting: true });

async function bounded(sync: Sync, b: IBooking): Promise<void> {
  const signal = AbortSignal.timeout(bound());
  const gaveUp = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('Meet call timed out')), { once: true }));
  await Promise.race([sync(b, signal), gaveUp]);
}

/** One run: every due candidate, each claimed (lease) before its one bounded attempt. */
export async function retryMissingMeets(now: Date = new Date(), opts: { limit?: number; sync?: Sync } = {}): Promise<{ examined: number; linked: number; failed: number }> {
  const rows = await BookingModel.find({ ...candidateFilter(now), 'meetRetry.closed': { $ne: 'permanent' },
    $and: [{ $or: [{ 'meetRetry.nextAt': { $exists: false } }, { 'meetRetry.nextAt': { $lte: now } }] }] })
    .sort({ bookingDate: 1, bookingTime: 1 }).lean() as unknown as IBooking[];
  let linked = 0; let failed = 0; let attempted = 0;
  for (const row of rows) {
    if (attempted >= (opts.limit ?? 100)) break;
    const _id = new Types.ObjectId(String(row._id));
    // r10h: an ended booking leaves the set for good (it no longer fills a run's batch).
    if (ended(row, now)) { await BookingModel.collection.updateOne({ _id }, { $set: { 'meetRetry.endedFor': appointmentKeyOf(row) } }); continue; }
    if (!upcoming(row, now) || !settled(row, now)) continue;
    // r10h (S5): never an invite for a doctor who is not verified and active (it names the patient and the concern).
    if (row.specialistId && await doctorExistsIneligible(row.specialistId)) continue;
    const claimed = (await BookingModel.collection.updateOne({ _id, status: 'confirmed', paymentStatus: 'paid',
      // The lease is judged on the wall clock (never the run's `now`, which a caller may set ahead).
      $and: [NO_LINK, { $or: [{ 'meetRetry.leaseUntil': { $exists: false } }, { 'meetRetry.leaseUntil': { $lte: new Date() } }] },
        { $or: [{ 'meetRetry.nextAt': { $exists: false } }, { 'meetRetry.nextAt': { $lte: now } }] }] },
    { $set: { 'meetRetry.leaseUntil': new Date(Date.now() + LEASE_MS) } })).modifiedCount === 1;
    if (!claimed) continue;
    attempted += 1;
    const fresh = await BookingModel.findById(_id).lean() as unknown as IBooking;
    try { await bounded(opts.sync ?? defaultSync, fresh); } catch (e) { logger.warn('Meet retry attempt failed', { bookingId: String(_id), error: (e as Error)?.message }); }
    const after = await BookingModel.findById(_id).select({ virtualMeeting: 1, meetRetry: 1, assisted: 1 }).lean() as unknown as IBooking & { meetRetry?: Record<string, any> };
    if (after?.virtualMeeting?.status === 'active') {
      linked += 1;
      await BookingModel.collection.updateOne({ _id }, { $set: { 'meetRetry.doneAt': new Date(), 'meetRetry.attempts': 0 },
        $unset: { 'meetRetry.leaseUntil': '', 'meetRetry.nextAt': '' } });
      continue;
    }
    failed += 1;
    // r10h: a failure no retry can fix closes the booking after this attempt (at most one alert; see the note above).
    const permanent = permanentMeetFailure(after?.virtualMeeting?.error);
    if (permanent) {
      await BookingModel.collection.updateOne({ _id }, { $set: { 'meetRetry.closed': 'permanent', 'meetRetry.closedReason': permanent,
        'meetRetry.attempts': Number(after?.meetRetry?.attempts ?? 0) + 1 }, $unset: { 'meetRetry.leaseUntil': '', 'meetRetry.nextAt': '' } });
      if (!(permanent === 'patient_email_missing' && !after?.assisted)) {
        await alertOnce(_id, after, { permanent }, permanent === 'meet_not_configured' ? 'meet_not_configured' : String(_id));
      }
      continue;
    }
    const attempts = Number(after?.meetRetry?.attempts ?? 0) + 1;
    const t = Date.now();
    await BookingModel.collection.updateOne({ _id }, { $set: { 'meetRetry.attempts': attempts,
      'meetRetry.nextAt': new Date(t + Math.min(2 * 3_600_000, 5 * 60_000 * 2 ** Math.min(attempts - 1, 10))) }, $unset: { 'meetRetry.leaseUntil': '' } });
    if (attempts >= MEET_ALERT_AFTER) await alertOnce(_id, after, { attempts });
  }
  return { examined: rows.length, linked, failed };
}

/** Stuck money / admin: paid call and video bookings of the next 48 hours with no working link (r10h: whole set scanned). */
export async function upcomingMeetsMissing(now: Date = new Date(), limit = 200) {
  const rows = await BookingModel.find(candidateFilter(now)).sort({ bookingDate: 1, bookingTime: 1 })
    .select({ bookingDate: 1, bookingTime: 1, bookingKind: 1, createdAt: 1, consultationMode: 1, specialistId: 1, virtualMeeting: 1, meetRetry: 1, assisted: 1 }).lean() as unknown as (IBooking & { meetRetry?: Record<string, any> })[];
  return rows.filter((b) => upcoming(b, now)).slice(0, limit).map((b) => ({ bookingId: String(b._id), bookingDate: b.bookingDate, bookingTime: b.bookingTime,
    consultationMode: b.consultationMode, specialistId: b.specialistId ?? null, assisted: !!b.assisted, meetStatus: b.virtualMeeting?.status ?? 'missing',
    error: b.virtualMeeting?.error ?? null, attempts: Number(b.meetRetry?.attempts ?? 0), nextAt: b.meetRetry?.nextAt ?? null, alerted: !!b.meetRetry?.alertedAt,
    closed: b.meetRetry?.closed ?? null, closedReason: b.meetRetry?.closedReason ?? null }));
}

let started = false;
let running = false;
/** Every 5 minutes; several instances only contend for the per-booking lease. */
export function runMeetRetryScheduler(): void {
  if (started) return;
  started = true;
  cron.schedule('*/5 * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const out = await retryMissingMeets();
      if (out.linked || out.failed) logger.info('Meet retry', out);
    } catch (error) {
      logger.error('Meet retry failed', { error: error instanceof Error ? error.message : String(error) });
    } finally { running = false; }
  });
}
