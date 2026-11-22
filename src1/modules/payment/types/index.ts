export type PaymentContext = 'wallet_recharge' | 'booking' | 'external_booking' | 'pharmacy_order' | 'lab_booking' | 'instant_request';
export type PaymentRecordStatus = 'created' | 'paid' | 'failed' | 'refunded';

export interface IPaymentRecord {
  _id?: string;
  userId: string;
  payerUserId?: string;
  payerPharmacyId?: string;
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
  notes?: Record<string, unknown>;
  paidAt?: Date;
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
  context: PaymentContext;
  contextId: string;
  baseAmount: number;
  discountAmount?: number;
  finalAmount: number;
  currency?: string;
  couponCode?: string;
  notes?: Record<string, unknown>;
}

export interface VerifyPaymentRequest {
  paymentTransactionId: string;
  userId: string;
  requesterUserType?: string;
  requesterPharmacyId?: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
  /** When `external-bookings`, resolves fulfillment against ExternalBooking instead of Booking. */
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
