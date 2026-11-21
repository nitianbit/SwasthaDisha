/**
 * Q16d (F10): the ONE India business date helper. "Today" for coupons, refills, low stock, slot dates, cancellation
 * labels, scheduling and every pharmacy expiry check is the India calendar date (Asia/Kolkata, UTC+05:30, no daylight
 * saving), whatever the server's time zone. Q16a's `istDate` (partners/services/slots) and Q16c's `istTodayYyyymmdd`
 * (pharmacyInventory/businessDate) are both this helper now.
 *
 * `businessClock.now` is the clock read when no time is given (tests move it; production never changes it).
 */
export const IST_OFFSET_MS = 330 * 60 * 1000;

export const businessClock = { now: (): number => Date.now() };

const atMs = (at?: Date | number): number => (at === undefined ? businessClock.now() : typeof at === 'number' ? at : at.getTime());

/** The IST calendar date as YYYY-MM-DD. */
export function istDateIso(at?: Date | number): string {
  return new Date(atMs(at) + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The IST calendar date as YYYYMMDD. */
export function istTodayYyyymmdd(at?: Date | number): string {
  return istDateIso(at).replace(/-/g, '');
}

/** The IST calendar year. */
export function istYear(at?: Date | number): number {
  return new Date(atMs(at) + IST_OFFSET_MS).getUTCFullYear();
}
