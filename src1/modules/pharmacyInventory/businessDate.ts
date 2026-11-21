
/**
 * Q16c: "today" for every pharmacy expiry check is the India calendar date (Asia/Kolkata, UTC+05:30, no daylight
 * saving), whatever the server's time zone. Before Q16c some checks used the UTC date and one the process-local date,
 * so between 00:00 and 05:30 IST a batch that expired "yesterday" still counted as sellable on a UTC server.
 *
 * Q16d (F10): the helper and its clock live in common/utils/istDate (the one IST date helper of the backend); this
 * module re-exports them for the pharmacy code (`businessClock` is the same object, so tests that move it move both).
 */
export { IST_OFFSET_MS, businessClock, istTodayYyyymmdd, istYear } from '@/modules/common/utils/istDate';
