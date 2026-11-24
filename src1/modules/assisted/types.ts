/**
 * Assisted booking phase 1a (ASSISTED_BOOKING_DESIGN.md §5.1, §17): the `assisted` block stored on a booking a partner
 * made and paid. All money is integer paise (`…Minor`). Phase 1a writes only pharmacy bookers, wallet funding, a cut of
 * 0 and `referral: null`.
 */
export type BookerKind = 'pharmacy' | 'lab' | 'doctor';
/** r14: which collection an assisted booking lives in — a consultation (`bookings`) or a lab booking (`partner_lab_bookings`). */
export type AssistedBookingKind = 'booking' | 'lab_booking';

export interface AssistedRefundRow {
  refundId: string;
  /**
   * booker | patient | doctor | admin (who cancelled), as the cancellation cause; phase 1b adds `late_capture`; r11 (lab
   * bookings) adds `partner_lab_reject` (the lab refused it) and uses `admin` for an admin cancel.
   */
  cause: string;
  amountMinor: number;
  /** Phase 1b: `razorpay` = back to the card/UPI of the payment (state follows the card refund row, `assisted_card_refunds`). */
  method: 'wallet' | 'razorpay';
  /** Wallet funding: the debit entry; card funding: the payment record refunded. */
  sourceRef: string;
  /** Wallet rows post at once (`processed`); card rows start `pending` (the card refund row holds the truth). */
  state: 'processed' | 'pending' | 'failed' | 'manual_review';
  walletEntryId?: string;
  attemptId: string;
  at: Date;
}

export interface AssistedFunding {
  /** Phase 1b: `razorpay` = the booker paid this booking by card/UPI (one Razorpay order, `paymentRecordId`). */
  method: 'wallet' | 'razorpay';
  payerKind: BookerKind;
  payerId: string;
  amountMinor: number;
  /**
   * captured: paid (wallet debit, or the card capture applied); refunded: returned in full; forfeited: kept (admin cancel
   * of a moved no-show). Phase 1b card bookings start `pending` (slot held, order open) and end `not_paid` when cancelled
   * or expired before any capture was applied.
   */
  state: 'captured' | 'refunded' | 'forfeited' | 'pending' | 'not_paid';
  walletEntryId?: string;
  /** Phase 1b: the one payment record (context `assisted_booking`; r14: `assisted_lab_booking` on a lab booking) of a card booking, chosen before the insert. */
  paymentRecordId?: string;
  /** Phase 1b: the Razorpay payment applied to a card booking. */
  razorpayPaymentId?: string;
  refunds: AssistedRefundRow[];
}

/**
 * r17 (§25.8.1): the booking a doctor's acceptance makes from a partner's instant request holds only this pointer. The
 * money (debit, quote return, refunds) lives on the request (`IInstantRequest.assisted.funding`), so no booking money
 * path can move it a second time.
 */
export interface InstantFundingPointer { instantRequestId: string }
export const isInstantFunding = (f: unknown): f is InstantFundingPointer =>
  !!f && typeof f === 'object' && typeof (f as InstantFundingPointer).instantRequestId === 'string';

/**
 * r17 (§25.8.1): what a partner put into an instant request, wallet-only in phase 3 (DR18). `held` at create (the
 * debit), then `allocated` at acceptance (the quote difference back to the booker) or `refunded` before it.
 */
export interface InstantAssistedFunding {
  method: 'wallet';
  payerKind: BookerKind;
  payerId: string;
  /** What the booker paid: quote − coupon. */
  amountMinor: number;
  state: 'held' | 'allocated' | 'refunded';
  walletEntryId?: string;
  /** Every credit back to the booker wallet: the quote difference, a refund before acceptance, a cancel refund after it. */
  refunds: { kind: 'quote_return' | 'refund' | 'cancel_refund'; cause: string; amountMinor: number; walletEntryId: string; at: Date }[];
}

/** r17: the `assisted` block of an instant request a partner made (the booking made at acceptance copies it, §25.8.1). */
export interface InstantAssistedBlock extends Omit<AssistedBlock, 'funding' | 'split' | 'reschedules' | 'moves' | 'recommendationId'> {
  funding: InstantAssistedFunding;
  /** Who funds the coupon (the split at acceptance needs it: provider-funded lowers the base, platform-funded does not). */
  couponFundedBy?: 'provider' | 'platform';
  /** What the patient came for, as the booker typed it; the booking made at acceptance carries it for the doctor. */
  primaryConcern?: string;
}

/** r24 (§26.5.1): the referral categories a rule can cut — the one list the model, the validation and the types use. */
export const REFERRAL_CATEGORIES = ['consultation', 'lab_test', 'lab_package'] as const;
export type ReferralCategory = typeof REFERRAL_CATEGORIES[number];

/**
 * r24 (§26.5.2): the cut snapshotted on a consultation (`split.referral`) or a lab line (`lines[].referral`) at create
 * (instant: at accept). It is frozen: a rule edited later never changes it. `disabledReason` says why the cut is 0.
 */
export interface ReferralSnapshot {
  category: ReferralCategory | null;
  cutMinor: number;
  ruleId?: string;
  ruleVersion?: number;
  basis?: 'percent' | 'fixed';
  percentBasisPoints?: number;
  fixedMinor?: number;
  capMinor?: number;
  disabledReason?: 'cuts_off' | 'doctor_cuts_off' | 'no_rule' | 'category_not_cut';
}

/** r24 (§26.5.1): where a booking's cut is credited at completion — the booker's `*_referral` settlement account. */
export interface AssistedReferral {
  accountId: string;
  ownerKind: 'pharmacy_referral' | 'lab_referral' | 'doctor_referral';
  bookerKind: BookerKind;
  bookerId: string;
  cutMinor: number;
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
  /** r24: a consultation's cut snapshot (absent on rows made before phase 4: cut 0). */
  referral?: ReferralSnapshot;
  /**
   * r11 (§24.4.1, D4, L16): lab bookings store the split per test. The coupon is spread over the lines by price, largest
   * remainder in paise. Σ lines.baseMinor = baseMinor. r24: each line carries its category and cut snapshot;
   * Σ lines.cutMinor = cutMinor.
   */
  lines?: { catalogItemId: string; listMinor: number; discountMinor: number; baseMinor: number; cutMinor: number;
    category?: ReferralCategory | null; referral?: ReferralSnapshot }[];
}

export interface AssistedBlock {
  bookedBy: { kind: BookerKind; id: string; branchId?: string; actorKind: string; actorId: string; name: string };
  /** r26 (§25.5.1): the doctor's own consultation the patient was taken from (a doctor's lab booking). */
  fromBookingId?: string;
  consent: { method: 'partner_attested'; statementVersion: string; statementLanguage: string; at: Date; actorId: string };
  preferredLanguage: string;
  identity: { attested: true; newAccount: boolean; disputed?: { at: Date; state: 'open' | 'moved' | 'dismissed'; resolvedAt?: Date } };
  join?: { on: 'partner_device' | 'patient_phone'; phone?: string; linkVersion: number };
  /**
   * r17: an instant booking (`bookingKind: 'instant'`) stores `{ instantRequestId }` here instead (`isInstantFunding`);
   * every booking money path filters on `funding.method` / `funding.state`, so none of them matches that pointer.
   */
  funding: AssistedFunding;
  split: AssistedSplit;
  /** r24 (§26.5.1): where the cut is credited at completion; null when the cut is 0 (and on rows before phase 4). */
  referral: AssistedReferral | null;
  shortRef: string;
  recommendationId?: string;
  requestKey: string;
  requestHash: string;
  /** P9: booker reschedules, exactly once per request key. */
  reschedules?: { requestKey: string; requestHash: string; at: Date; fromSlotId?: string; toSlotId: string; by: string }[];
  /** §17.5: account moves by an admin (history). */
  moves?: { at: Date; by: string; fromUserId: string; toUserId: string; requestKey: string }[];
}
