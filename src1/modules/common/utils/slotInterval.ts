import { parseAppointment } from '@/modules/common/utils/cancellationWindow';

/**
 * India-time interval of an ordinary (doctor/package) slot. Stored slots use YYYYMMDD dates and either `h:mm AM/PM`
 * (the manual slot API) or `HH:mm` (Q4 template expansion) times; both go through the one appointment parser.
 * End = endTime when it parses to a later instant, else start + duration, else start + 30 minutes.
 * Returns null when the start does not parse (callers refuse such a slot rather than guess).
 */
export function slotIntervalOf(slot: { date?: string; startTime?: string; endTime?: string; duration?: number }):
  { start: Date; end: Date } | null {
  if (typeof slot.date !== 'string' || typeof slot.startTime !== 'string') return null;
  const start = parseAppointment({ bookingDate: slot.date, bookingTime: slot.startTime })?.at;
  if (!start) return null;
  const endAt = typeof slot.endTime === 'string' ? parseAppointment({ bookingDate: slot.date, bookingTime: slot.endTime })?.at : undefined;
  const end = endAt && endAt.getTime() > start.getTime() ? endAt
    : new Date(start.getTime() + (Number(slot.duration) > 0 ? Number(slot.duration) : 30) * 60_000);
  return { start, end };
}

/**
 * Q16d (F1): until when a slot takes bookings — the one rule of admission (`reserveSlot`), the lists (`bookableNow`),
 * the service pre-checks and the clinic desk. A multi-seat window (maxBookings > 1: package windows, doctor sessions)
 * until it ENDS; a one-patient slot until it STARTS. Null when the slot's time does not parse (never bookable).
 */
export function bookableUntilOf(slot: { date?: string; startTime?: string; endTime?: string; duration?: number; maxBookings?: number | null }):
  Date | null {
  const w = slotIntervalOf(slot);
  if (!w) return null;
  return Number(slot.maxBookings ?? 1) > 1 ? w.end : w.start;
}
