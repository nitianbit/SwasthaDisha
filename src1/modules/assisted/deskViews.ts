/**
 * r12 (§24.6): how a lab DESK booking (the lab's own tests for a walk-in patient, paid at the lab) looks to the lab and
 * to the patient. Pure functions (no reads), so the lab service can use them on every answer. Rows that are not desk
 * rows pass unchanged (a stray `desk` key is dropped).
 */
import { Types } from 'mongoose';

type Row = Record<string, any>;

/** A desk row: paid at the lab, so no payment deadline, earning, payout or refund ever runs through Jansetu (§5.5). */
export const isDeskRow = (b: Row | null | undefined): boolean => b?.settlement?.settlementSystem === 'lab_desk';

/** A desk walk-in: tested on arrival, no seat (L11). */
export const isWalkIn = (b: Row | null | undefined): boolean => b?.slot?.walkIn === true;

/**
 * r12b: who made a partner-made row, and where its identity review lives: `assisted` (a partner booked and paid it) or
 * `desk` (the lab desk booked it, paid at the lab: no money ever moves with a review or a move). `notifyId` is who
 * hears about it (the booker; the desk member who booked, none when an admin did). Null: a customer's own booking.
 * r31: moved here from assisted/review.ts, so the SMS notices read the same (a consultation's `assisted` block reads alike).
 */
export function partnerOriginOf(b: Row | null | undefined) {
  if (b?.assisted) {
    const a = b.assisted as Row;
    return { root: 'assisted' as const, org: { kind: a.bookedBy.kind, id: a.bookedBy.id }, name: a.bookedBy.name as string | null, notifyId: a.bookedBy.id as string | null,
      ref: a.shortRef as string, disputed: a.identity?.disputed as Row | undefined, moves: (a.moves ?? []) as Row[], preferredLanguage: a.preferredLanguage as string };
  }
  if (b && isDeskRow(b) && b.desk) {
    const d = b.desk as Row;
    return { root: 'desk' as const, org: { kind: 'lab' as const, id: String(b.partnerId ?? '').toLowerCase() }, name: null,
      notifyId: Types.ObjectId.isValid(d.memberId) ? d.memberId as string : null,
      ref: String(b._id).slice(-8).toUpperCase(), disputed: d.identity?.disputed as Row | undefined, moves: (d.moves ?? []) as Row[], preferredLanguage: d.preferredLanguage as string };
  }
  return null;
}

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

/** The patient's view of a desk row (§24.6.3): "pay at the lab", the lab's price as information, a "not mine" review; no desk internals. */
export function deskCustomerPart(view: Row, b: Row): Row {
  const { desk: _d, ...rest } = view;
  if (!isDeskRow(b)) return rest;
  const disputed = b.desk?.identity?.disputed;
  return { ...rest, source: 'lab_desk', payAtLab: true, ...(disputed ? { disputed: { state: disputed.state, at: disputed.at } } : {}) };
}
