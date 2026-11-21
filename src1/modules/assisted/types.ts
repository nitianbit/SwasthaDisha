/**
 * Assisted booking phase 1a (ASSISTED_BOOKING_DESIGN.md §5.1, §17): the `assisted` block stored on a booking a partner
 * made and paid. All money is integer paise (`…Minor`). Phase 1a writes only pharmacy bookers, wallet funding, a cut of
 * 0 and `referral: null`.
 */
export type BookerKind = 'pharmacy' | 'lab' | 'doctor';

export interface AssistedRefundRow {
  refundId: string;
  /** booker | patient | doctor | admin (who cancelled), as the cancellation cause. */
  cause: string;
  amountMinor: number;
  method: 'wallet';
  sourceRef: string;
  state: 'processed';
  walletEntryId?: string;
  attemptId: string;
  at: Date;
}

export interface AssistedFunding {
  method: 'wallet';
  payerKind: BookerKind;
  payerId: string;
  amountMinor: number;
  /** captured: paid from the wallet; refunded: returned in full; forfeited: kept (admin cancel of a moved no-show). */
  state: 'captured' | 'refunded' | 'forfeited';
  walletEntryId?: string;
  refunds: AssistedRefundRow[];
}

export interface AssistedSplit {
  listMinor: number;
  couponCode?: string;
  couponFundedBy?: 'provider' | 'platform';
  discountMinor: number;
  baseMinor: number;
  cutMinor: number;
  providerMinor: number;
  rule: 'provider_coupon_v2';
}

export interface AssistedBlock {
  bookedBy: { kind: BookerKind; id: string; branchId?: string; actorKind: string; actorId: string; name: string };
  consent: { method: 'partner_attested'; statementVersion: string; statementLanguage: string; at: Date; actorId: string };
  preferredLanguage: string;
  identity: { attested: true; newAccount: boolean; disputed?: { at: Date; state: 'open' | 'moved' | 'dismissed'; resolvedAt?: Date } };
  join?: { on: 'partner_device' | 'patient_phone'; phone?: string; linkVersion: number };
  funding: AssistedFunding;
  split: AssistedSplit;
  /** null until phase 4 (cuts), §17.1 P5. */
  referral: null;
  shortRef: string;
  recommendationId?: string;
  requestKey: string;
  requestHash: string;
  /** P9: booker reschedules, exactly once per request key. */
  reschedules?: { requestKey: string; requestHash: string; at: Date; fromSlotId?: string; toSlotId: string; by: string }[];
  /** §17.5: account moves by an admin (history). */
  moves?: { at: Date; by: string; fromUserId: string; toUserId: string; requestKey: string }[];
}
