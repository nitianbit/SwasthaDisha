/**
 * Q14: what the generic booking routes (customers, HR, pharmacy) may see of a booking's no-show history — when it
 * happened and where it moved — never who marked or moved it, nor the request key/hash of the reschedule.
 * Q16a (L3): nor the clinic desk's internals (the member who booked it, its request key and hash), the settlement
 * account the booking is settled to, or the request keys of instant-consultation extensions.
 * Q16d (F7): nor the admin who cancelled a moved no-show (`noShowCancel.by`).
 */
type Row = Record<string, any>;

function scrubOne<T>(b: T): T {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b;
  const row = b as unknown as Row;
  // A create/payment answer wraps the booking: scrub the booking inside.
  if (row.booking && typeof row.booking === 'object' && !Array.isArray(row.booking) && row.noShow === undefined && row.clinicDesk === undefined) {
    return { ...row, booking: scrubOne(row.booking) } as unknown as T;
  }
  const internal = row.noShow !== undefined || row.noShows !== undefined || row.clinicDesk !== undefined || row.settlement !== undefined
    || row.instantExtensions !== undefined || row.noShowCancel !== undefined;
  if (!internal) return b;
  const out: Row = { ...row };
  if (row.noShow) out.noShow = { at: row.noShow.at };
  if (Array.isArray(row.noShows)) {
    out.noShows = row.noShows.map((n: Row) => ({
      at: n.at, rescheduledAt: n.rescheduledAt, fromSlotId: n.fromSlotId, fromDate: n.fromDate, fromTime: n.fromTime, toSlotId: n.toSlotId,
    }));
  }
  if (row.clinicDesk && typeof row.clinicDesk === 'object') {
    const { createdBy: _c, requestKey: _k, requestHash: _h, ...desk } = row.clinicDesk as Row;
    out.clinicDesk = desk;
  }
  // Q16d (F7): nor which admin cancelled a moved no-show.
  if (row.noShowCancel && typeof row.noShowCancel === 'object') {
    const { by: _b, ...cancel } = row.noShowCancel as Row;
    out.noShowCancel = cancel;
  }
  if (row.settlement && typeof row.settlement === 'object') {
    const { settlementAccountId: _a, ...settlement } = row.settlement as Row;
    out.settlement = settlement;
  }
  if (Array.isArray(row.instantExtensions)) {
    out.instantExtensions = row.instantExtensions.map((x: Row) => {
      const { requestKey: _k, ...rest } = x ?? {};
      return rest;
    });
  }
  return out as T;
}

/** Scrubs one booking or a list of bookings (other values pass through unchanged). */
export function publicNoShowView<T>(value: T): T {
  if (Array.isArray(value)) return value.map(scrubOne) as unknown as T;
  return scrubOne(value);
}
