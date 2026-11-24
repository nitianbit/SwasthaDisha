import { IDENTITY_NOTE } from '@/modules/assisted/views';

/**
 * r11 (§24.4.2, §24.4.4): how an assisted (partner-paid) lab booking looks to the patient and to the lab. Rows without
 * an `assisted` block pass unchanged. Pure functions (no reads), so the lab service can use them on every answer.
 */
type Row = Record<string, any>;

/** §24.4.5 (owner, 23 Nov): the booker reads a released report for 90 days from its FIRST release. */
export const BOOKER_REPORT_DAYS = 90;
const DAY_MS = 86_400_000;

/** §5.1: rows written before `source` existed derive it. */
export const labSourceOf = (b: Row): string => (typeof b?.source === 'string' ? b.source : 'self');

/** The first release time of a lab booking's report (null while nothing is released). */
export function firstReleaseAt(b: Row): Date | null {
  const times = ((b?.report?.releases ?? []) as Row[]).map((r) => new Date(r.releasedAt).getTime()).filter((t) => Number.isFinite(t));
  return times.length ? new Date(Math.min(...times)) : null;
}

/** L3: released files only, and only until 90 days after the first release. (The caller checks the booker and its authority.) */
export function bookerReportWindowOpen(b: Row, now: Date = new Date()): boolean {
  const first = firstReleaseAt(b);
  return !!first && now.getTime() < first.getTime() + BOOKER_REPORT_DAYS * DAY_MS;
}

/**
 * The patient's view of an assisted row (§24.4.4, as `assistedPublicView`): no partner money — `pricing`,
 * `paymentTransactionId`, item prices (ASSUMED: the price the partner paid Jansetu is the partner's, as the 1a view hides
 * a consultation's price) and of the `assisted` block no funding, split, referral, keys, consent or moves; instead
 * `paidBy` (the booker's name) and the identity line.
 */
export function assistedLabCustomerPart(view: Row, b: Row): Row {
  if (!b?.assisted || typeof b.assisted !== 'object') return view;
  const { pricing: _p, paymentTransactionId: _t, assisted: _a, items, ...rest } = view;
  const a = b.assisted as Row;
  return {
    ...rest,
    items: Array.isArray(items) ? items.map((i: Row) => ({ catalogItemId: i.catalogItemId, kind: i.kind, name: i.name, code: i.code,
      reportTatHours: i.reportTatHours })) : items,
    source: labSourceOf(b),
    paidBy: a.bookedBy?.name ?? null,
    assisted: {
      shortRef: a.shortRef,
      bookedBy: a.bookedBy ? { kind: a.bookedBy.kind, name: a.bookedBy.name } : undefined,
      preferredLanguage: a.preferredLanguage,
      identity: a.identity ? { attested: a.identity.attested === true, newAccount: a.identity.newAccount === true,
        ...(a.identity.disputed ? { disputed: { state: a.identity.disputed.state, at: a.identity.disputed.at } } : {}), note: IDENTITY_NOTE } : undefined,
    },
  };
}

/** The lab's view of an assisted row (§24.4.4 `partnerView`): who booked it, its Ref and the identity note; no partner money or keys. */
export function assistedLabPartnerPart(view: Row, b: Row): Row {
  if (!b?.assisted || typeof b.assisted !== 'object') return view;
  const a = b.assisted as Row;
  return {
    ...view,
    source: labSourceOf(b),
    assisted: { shortRef: a.shortRef, bookedBy: a.bookedBy ? { name: a.bookedBy.name } : undefined, preferredLanguage: a.preferredLanguage },
    identityNote: IDENTITY_NOTE,
  };
}

/** §17.5: an assisted row (r12b: or a lab desk row) reported as not mine (still open) leaves the holder's lists; direct reads still work. */
export const LAB_NOT_DISPUTED_QUERY = { 'assisted.identity.disputed.state': { $ne: 'open' }, 'desk.identity.disputed.state': { $ne: 'open' } };

/**
 * r14 (§24.5.3, L5; as r10b item 3 for consultations): a card-paid lab booking never confirmed (`lifecycle.confirmedAt`
 * absent: waiting for its payment, or expired or cancelled before it) is the booker's alone — left out of the patient's
 * and the lab's lists, the one 404 on their reads and steps. Once its payment confirms it, it is theirs (and stays so).
 */
export const LAB_UNPAID_CARD_QUERY = { 'assisted.funding.method': 'razorpay', 'lifecycle.confirmedAt': { $exists: false } };
export const isUnpaidCardLab = (b: Row | null | undefined): boolean => b?.assisted?.funding?.method === 'razorpay' && !b?.lifecycle?.confirmedAt;
