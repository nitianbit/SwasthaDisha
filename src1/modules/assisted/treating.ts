import { AppError } from '@/modules/common/types';
import BookingModel from '@/modules/bookings/model';
import { AssistedReviewItemModel } from '@/modules/assisted/model';
import { appointmentIntervalOf, consultationEndOf, slotsOf, type SlotTimes } from '@/modules/assisted/rxAccess';
import { unpaidCardBooking } from '@/modules/assisted/views';

/**
 * r26 (§25.9.1, D5, N8): the treating window of a doctor's consultation — while the doctor treats the patient of that
 * booking. Pure; 3b uses it for a lab booking made from a consultation (`fromBookingId`), 3f for history and files.
 * - Opens: video, call or chat at the slot start − 10 min; an instant consultation at its acceptance (`createdAt`); in
 *   person at the desk check-in (`clinicDesk.arrivedAt`), else at the slot start.
 * - Never opens for an unpaid pending booking (r26b) or an unpaid card booking.
 * - Closes: 30 days after completion; if not completed, 7 days after the consultation's end; at once on cancellation or
 *   no-show (a booking cancelled before it starts never opens one). An unpaid card booking never opens one.
 */
type Row = Record<string, any>;
const MIN = 60_000;
const DAY = 86_400_000;

export function treatingWindowOf(b: Row, slot?: SlotTimes | null, now: Date = new Date()): { open: boolean; opensAt: Date | null; closesAt: Date | null } {
  const closed = { open: false, opensAt: null, closesAt: null };
  // r26b: an unpaid customer booking (still pending) never opens one; pay-at-clinic rows may be confirmed and unpaid.
  if (!b || unpaidCardBooking(b) || ['cancelled', 'no_show'].includes(String(b.status)) || (b.status === 'pending' && b.paymentStatus !== 'paid')) return closed;
  const interval = appointmentIntervalOf(b, slot);
  const arrived = b.clinicDesk?.arrivedAt ? new Date(b.clinicDesk.arrivedAt) : null;
  const opensAt = b.instantRequestId ? new Date(b.createdAt)
    : b.consultationMode === 'in-person' ? (arrived ?? interval?.start ?? null)
      : interval ? new Date(interval.start.getTime() - 10 * MIN) : null;
  const completedAt = Date.parse(String(b.lifecycle?.completed?.at ?? ''));
  const end = consultationEndOf(b, slot);
  const closesAt = Number.isFinite(completedAt) ? new Date(completedAt + 30 * DAY) : end ? new Date(end.getTime() + 7 * DAY) : null;
  if (!opensAt || !closesAt || Number.isNaN(opensAt.getTime())) return closed;
  return { open: now >= opensAt && now < closesAt, opensAt, closesAt };
}

export type TreatingWindow = ReturnType<typeof treatingWindowOf>;
export const treatingWindowClosed = () => new AppError({ status: 409, code: 'TREATING_WINDOW_CLOSED', message: 'This consultation is not open for treatment now' });

/**
 * r30: the doctor's OWN bookings matching `filter`, each with its treating window. An unpaid card booking and one with an
 * open "not mine" report are left out (the caller answers them like a missing booking). 3b's `fromBookingId` and 3f's
 * history, request, approval and file reads share it.
 */
export async function ownTreatingBookings(specialistId: string, filter: Record<string, unknown>, now: Date = new Date()): Promise<{ booking: Row; window: TreatingWindow }[]> {
  const sid = String(specialistId);
  const rows = (await BookingModel.find({ ...filter, specialistId: { $in: [sid.toLowerCase(), sid.toUpperCase()] } }).lean() as Row[])
    .filter((b) => !unpaidCardBooking(b));
  if (!rows.length) return [];
  const disputed = new Set((await AssistedReviewItemModel.find({ kind: 'not_mine', bookingKind: 'booking', state: 'open',
    bookingId: { $in: rows.map((b) => String(b._id).toLowerCase()) } }).select({ bookingId: 1 }).lean()).map((r) => r.bookingId));
  const slots = await slotsOf(rows);
  return rows.filter((b) => !disputed.has(String(b._id).toLowerCase()))
    .map((b) => ({ booking: b, window: treatingWindowOf(b, slots.get(String(b.slotId)), now) }));
}

/**
 * r30: the doctor's own booking `bookingId` while it treats that booking's patient. 404 BOOKING_NOT_FOUND for a missing,
 * another doctor's, an unpaid card or a disputed booking, and for one `belongs` refuses (another account or person);
 * 409 TREATING_WINDOW_CLOSED outside its window.
 */
export async function openOwnTreatingBooking(specialistId: string, bookingId: unknown, now: Date = new Date(),
  belongs: (b: Row) => boolean = () => true): Promise<{ booking: Row; window: TreatingWindow }> {
  const own = /^[0-9a-fA-F]{24}$/.test(String(bookingId)) ? (await ownTreatingBookings(specialistId, { _id: String(bookingId) }, now))[0] : undefined;
  if (!own || !belongs(own.booking)) throw new AppError({ status: 404, code: 'BOOKING_NOT_FOUND', message: 'Booking not found' });
  if (!own.window.open) throw treatingWindowClosed();
  return own;
}
