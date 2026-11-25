/**
 * Phase 1b: `assisted_booking` = a booker (pharmacy) pays an assisted consultation by card/UPI (contextId = the booking).
 * r14 (§24.5): `assisted_lab_booking` = the same for an assisted lab booking (contextId = the `partner_lab_bookings` row).
 */
export type PaymentContext = 'wallet_recharge' | 'booking' | 'external_booking' | 'pharmacy_order' | 'lab_booking' | 'instant_request' | 'assisted_booking'
  | 'assisted_lab_booking';
/** r14: the contexts of a booker's card payment of an assisted booking (verified by the paying organisation, never failed by a bad signature). */
export type AssistedCardContext = 'assisted_booking' | 'assisted_lab_booking';
export const ASSISTED_CARD_CONTEXTS: AssistedCardContext[] = ['assisted_booking', 'assisted_lab_booking'];
export const isAssistedCardContext = (c: unknown): c is AssistedCardContext => c === 'assisted_booking' || c === 'assisted_lab_booking';
export type PaymentRecordStatus = 'created' | 'paid' | 'failed' | 'refunded';

export interface IPaymentRecord {
  _id?: string;
  userId: string;
  payerUserId?: string;
  payerPharmacyId?: string;
  /** r13 (§24.7.2): a partner-paid record (a lab top-up): the paying partner and member. */
  payerPartnerId?: string;
  payerMemberId?: string;
  /** r20 (§25.4.1): a doctor-paid record (a doctor top-up; r29: a card payment of a lab booking the doctor made): the paying doctor. */
  payerSpecialistId?: string;
  /** r13: a keyed order (a lab top-up): the scoped request key and its content hash (exactly one order per key). */
  requestKey?: string;
  requestHash?: string;
  /** Assisted booking phase 1a (P2): Razorpay `fee` of the capture, paise. */
  gatewayFeeMinor?: number;
  context: PaymentContext;
  contextId: string; // Booking ID for booking context, generated reference for wallet recharge
  baseAmount: number;
  discountAmount: number;
  finalAmount: number;
  baseAmountPaise?: number;
  discountAmountPaise?: number;
  finalAmountPaise?: number;
  currency: string;
  paymentGateway: 'razorpay' | 'internal';
  couponCode?: string;
  /** Coupon usage state (coupon/usage.ts). */
  couponUsage?: 'pending' | 'counted' | 'void' | 'reversed';
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  status: PaymentRecordStatus;
  isProcessed: boolean;
  /** D3: pharmacy order captures only - applied to the order or returned to the wallet (set once). */
  pharmacySettlement?: 'applied' | 'returned';
  /** Pharmacy top-ups: when the wallet credit was claimed (once). */
  walletCreditedAt?: Date;
  /** Pharmacy top-ups: a card dispute lost before any credit; never credited afterwards. */
  chargebackAt?: Date;
  /** Pharmacy top-ups (r9): closed by an admin as already compensated by hand; never credited afterwards. */
  compensatedAt?: Date;
  compensation?: { by: string; reason: string; requestKey: string; requestHash: string; previousStatus: string; amountPaise?: number };
  notes?: Record<string, unknown>;
  paidAt?: Date;
  /** r10e: assisted card records — when the order is next checked for another capture, and how often it was. */
  extraCheckNextAt?: Date;
  extraChecks?: number;
  /** Background recovery schedule (W3b). */
  recoveryNextAt?: Date;
  recoveryChecks?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreatePaymentOrderRequest {
  userId: string;
  payerUserId?: string;
  payerPharmacyId?: string;
  /** r13: a lab top-up's paying partner and member, and its scoped request key with the content hash. */
  payerPartnerId?: string;
  payerMemberId?: string;
  /** r20: a doctor top-up's paying doctor. */
  payerSpecialistId?: string;
  requestKey?: string;
  requestHash?: string;
  context: PaymentContext;
  contextId: string;
  baseAmount: number;
  discountAmount?: number;
  finalAmount: number;
  currency?: string;
  couponCode?: string;
  notes?: Record<string, unknown>;
  /** Phase 1b: the record's id chosen by the caller (an assisted card booking stores it before the order exists). */
  recordId?: string;
}

export interface VerifyPaymentRequest {
  paymentTransactionId: string;
  userId: string;
  requesterUserType?: string;
  requesterPharmacyId?: string;
  /** r13: a partner member verifying (the partner-workspace routes). */
  requesterPartnerId?: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
  /** Informational only ('external-bookings' | 'pharmacy-wallet'): the stored record's context decides fulfilment (S6). */
  module?: string;
}

export interface CreateDirectPaidTransactionRequest {
  userId: string;
  payerUserId?: string;
  payerPharmacyId?: string;
  context: PaymentContext;
  contextId: string;
  baseAmount: number;
  discountAmount?: number;
  finalAmount: number;
  currency?: string;
  couponCode?: string;
  notes?: Record<string, unknown>;
  isProcessed?: boolean;
}
