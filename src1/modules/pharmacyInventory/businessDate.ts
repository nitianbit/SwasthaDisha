/**
 * Q16c: "today" for every pharmacy expiry check is the India calendar date (Asia/Kolkata, UTC+05:30, no daylight
 * saving), whatever the server's time zone. Before Q16c some checks used the UTC date and one the process-local date,
 * so between 00:00 and 05:30 IST a batch that expired "yesterday" still counted as sellable on a UTC server.
 *
 * `businessClock.now` is the one clock these checks read (tests move it; production never changes it).
 */
export const IST_OFFSET_MS = 330 * 60 * 1000;

export const businessClock = { now: (): number => Date.now() };

/** The IST calendar date as YYYYMMDD. */
export function istTodayYyyymmdd(at: number = businessClock.now()): string {
  return new Date(at + IST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '');
}

/** The IST calendar year. */
export function istYear(at: number = businessClock.now()): number {
  return new Date(at + IST_OFFSET_MS).getUTCFullYear();
}
