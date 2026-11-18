/**
 * Q14: what the generic booking routes (customers, HR, pharmacy) may see of a booking's no-show history — when it
 * happened and where it moved — never who marked or moved it, nor the request key/hash of the reschedule.
 */
type Row = Record<string, any>;

function scrubOne<T>(b: T): T {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b;
  const row = b as unknown as Row;
  if (row.noShow === undefined && row.noShows === undefined) return b;
  const out: Row = { ...row };
  if (row.noShow) out.noShow = { at: row.noShow.at };
  if (Array.isArray(row.noShows)) {
    out.noShows = row.noShows.map((n: Row) => ({
      at: n.at, rescheduledAt: n.rescheduledAt, fromSlotId: n.fromSlotId, fromDate: n.fromDate, fromTime: n.fromTime, toSlotId: n.toSlotId,
    }));
  }
  return out as T;
}

/** Scrubs one booking or a list of bookings (other values pass through unchanged). */
export function publicNoShowView<T>(value: T): T {
  if (Array.isArray(value)) return value.map(scrubOne) as unknown as T;
  return scrubOne(value);
}
