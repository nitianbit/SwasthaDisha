/**
 * Assisted booking phase 1a (§6.7, §17.6, ASSUMED D8): how a partner-paid booking looks on the generic booking routes to
 * everyone except the booker (who gets the booker view) and admins (who see it whole, minus request keys):
 * - no money of the partner: `price`, `originalPrice`, `paymentTransactionId`, `walletFunding`, `createTerms`,
 *   `noShowCancel.forfeitedAmount` (r9), and of the
 *   `assisted` block no `funding`, `split`, `referral`, `requestKey`, `requestHash`, consent actor or move history;
 *   instead `paidBy` (the partner's name). `paymentStatus` stays (it is not an amount; the released app reads it to
 *   decide whether to offer payment, which it must not);
 * - the identity line for the doctor: "Identity attested by the partner, not verified".
 * Rows without an `assisted` block pass unchanged.
 */
type Row = Record<string, any>;
export const IDENTITY_NOTE = 'Identity attested by the partner, not verified';

function one(row: Row): Row {
  if (!row || typeof row !== 'object' || !row.assisted || typeof row.assisted !== 'object') return row;
  const { price: _p, originalPrice: _o, paymentTransactionId: _t, walletFunding: _w, createTerms: _c, assisted, ...rest } = row;
  const a = assisted as Row;
  // Review 5: lifecycle events keep their time (and a cancellation reason), never the amount paid or who paid it.
  const lifecycle = rest.lifecycle && typeof rest.lifecycle === 'object'
    ? Object.fromEntries(Object.entries(rest.lifecycle as Row).map(([k, v]) => [k, v && typeof v === 'object'
      ? { ...(v.at !== undefined ? { at: v.at } : {}), ...(typeof v.reason === 'string' ? { reason: v.reason } : {}) } : v]))
    : rest.lifecycle;
  // r9 (A10): a kept (forfeited) partner payment records its amount on the cancel; that is the partner's money too.
  const noShowCancel = rest.noShowCancel && typeof rest.noShowCancel === 'object'
    ? Object.fromEntries(Object.entries(rest.noShowCancel as Row).filter(([k]) => k !== 'forfeitedAmount')) : rest.noShowCancel;
  return {
    ...rest,
    ...(lifecycle !== undefined ? { lifecycle } : {}),
    ...(noShowCancel !== undefined ? { noShowCancel } : {}),
    source: row.source ?? 'pharmacy_assisted',
    paidBy: a.bookedBy?.name ?? null,
    assisted: {
      shortRef: a.shortRef,
      bookedBy: a.bookedBy ? { kind: a.bookedBy.kind, name: a.bookedBy.name } : undefined,
      preferredLanguage: a.preferredLanguage,
      ...(a.join ? { join: { on: a.join.on } } : {}),
      identity: a.identity ? { attested: a.identity.attested === true, newAccount: a.identity.newAccount === true,
        ...(a.identity.disputed ? { disputed: { state: a.identity.disputed.state, at: a.identity.disputed.at } } : {}),
        note: IDENTITY_NOTE } : undefined,
    },
  };
}

export function assistedPublicView<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => one(v as Row)) as unknown as T;
  const row = value as unknown as Row;
  if (row && typeof row === 'object' && row.booking && typeof row.booking === 'object' && !row.assisted) {
    return { ...row, booking: one(row.booking) } as unknown as T;
  }
  return one(row) as unknown as T;
}

/** Admins see the block whole except the request key and hash. */
export function assistedAdminView<T>(value: T): T {
  const strip = (r: Row) => {
    if (!r || typeof r !== 'object' || !r.assisted) return r;
    const { requestKey: _k, requestHash: _h, ...a } = r.assisted as Row;
    return { ...r, assisted: a };
  };
  return (Array.isArray(value) ? value.map((v) => strip(v as Row)) : strip(value as unknown as Row)) as unknown as T;
}

/** §17.5: a booking reported as not mine (still open) leaves the holder's lists; direct reads still work. */
export const notDisputed = (r: Row) => r?.assisted?.identity?.disputed?.state !== 'open';
