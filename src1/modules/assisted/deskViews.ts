/**
 * r12 (§24.6): how a lab DESK booking (the lab's own tests for a walk-in patient, paid at the lab) looks to the lab and
 * to the patient. Pure functions (no reads), so the lab service can use them on every answer. Rows that are not desk
 * rows pass unchanged (a stray `desk` key is dropped).
 */
type Row = Record<string, any>;

/** A desk row: paid at the lab, so no payment deadline, earning, payout or refund ever runs through Jansetu (§5.5). */
export const isDeskRow = (b: Row | null | undefined): boolean => b?.settlement?.settlementSystem === 'lab_desk';

/** A desk walk-in: tested on arrival, no seat (L11). */
export const isWalkIn = (b: Row | null | undefined): boolean => b?.slot?.walkIn === true;

/** The lab's view of the desk block: who booked it and how; never the request key or its hash. */
export function deskLabPart(view: Row, b: Row): Row {
  const { desk: _d, ...rest } = view;
  if (!isDeskRow(b) || !b.desk) return rest;
  const d = b.desk as Row;
  return {
    ...rest,
    source: 'lab_desk',
    payAtLab: true,
    desk: {
      memberId: d.memberId, branchId: d.branchId, arrivedAt: d.arrivedAt ?? null, preferredLanguage: d.preferredLanguage, payAtLab: true,
      ...(d.notes ? { notes: d.notes } : {}),
      consent: d.consent ? { method: d.consent.method, statementVersion: d.consent.statementVersion, statementLanguage: d.consent.statementLanguage,
        at: d.consent.at } : null,
    },
  };
}

/** The patient's view of a desk row (§24.6.3): "pay at the lab", the lab's price as information; no desk internals. */
export function deskCustomerPart(view: Row, b: Row): Row {
  const { desk: _d, ...rest } = view;
  if (!isDeskRow(b)) return rest;
  return { ...rest, source: 'lab_desk', payAtLab: true };
}
