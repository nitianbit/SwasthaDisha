import { appointmentIntervalOf, consultationEndOf, type SlotTimes } from '@/modules/assisted/rxAccess';
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
