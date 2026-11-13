export type OrderType = 'in_store' | 'online';

export type OrderStatus =
  | 'placed'
  | 'accepted'
  | 'packed'
  | 'ready_for_pickup'
  | 'out_for_delivery'
  | 'completed'
  | 'abandoned'
  | 'cancelled'
  | 'rejected';

export type PaymentMode = 'online_payment' | 'in_store_payment' | 'cash_on_delivery';

export type PaymentStatus =
  | 'pending'
  | 'authorized'
  | 'paid'
  | 'failed'
  | 'refunded'
  | 'partially_paid';

export type ItemStatus = 'active' | 'replaced' | 'removed';
export type PharmacyOrderSideEffectStatus = 'pending' | 'success' | 'failed';
export type PharmacyOrderSideEffectTrigger =
  | 'order_created'
  | 'order_updated'
  | 'payment_completed'
  | 'status_changed'
  | 'order_marked_paid'
  | 'order_abandoned';

export interface IPharmacyOrderSideEffectState {
  status: PharmacyOrderSideEffectStatus;
  lastError?: string;
  updatedAt?: Date;
}

export interface IPharmacyOrderSideEffects {
  subscriptionSync?: IPharmacyOrderSideEffectState;
  notification?: IPharmacyOrderSideEffectState;
}

export interface IOrderItem {
  medicineId: string;
  medicineName?: string;
  orderedQty: number;
  reservedQty?: number;
  billedQty?: number;
  freeQty?: number;
  unitPrice: number;
  discount?: number;
  lineTotal: number;
  hsnCode?: string;
  gstPercent?: number;
  taxAmount?: number;
  unitPricePaise?: number;
  discountPaise?: number;
  taxPaise?: number;
  lineTotalPaise?: number;
  prescriptionRequired?: boolean;
  batchAllocations?: Array<{
    batchId: string;
    batchNumber: string;
    expiryDate: string;
    quantity: number;
  }>;
  itemStatus?: ItemStatus;
  recurring?: boolean;
  subscriptionFrequency?: string;
  subscriptionIntervalDays?: number;
  subscriptionNextRefillDate?: string;
  subscriptionReminderChannel?: 'sms' | 'push' | 'both' | 'none';
}

export const PHARMACY_RECOVERY_ORDER_LABELS = Object.freeze([
  'placed', 'accepted', 'packed', 'ready_for_pickup', 'out_for_delivery',
  'completed', 'abandoned', 'cancelled', 'rejected', 'unknown',
] as const);
export const PHARMACY_RECOVERY_PAYMENT_LABELS = Object.freeze([
  'pending', 'authorized', 'paid', 'failed', 'refunded', 'partially_paid', 'unknown',
] as const);

export interface PharmacyRecoveryObservation {
  orderStatusLabel: OrderStatus | 'unknown';
  paymentStatusLabel: PaymentStatus | 'unknown';
  paymentRecordId: string | null;
  paymentRecordReferenceState: 'recorded' | 'missing' | 'malformed';
}

export interface PharmacyRecoveryRequest {
  schemaVersion: 1;
  operationKind: 'customer_recovery_request';
  operationId: string;
  requestingCustomerId: string;
  orderId: string;
  status: 'reconciliation_required';
  requestedAt: Date;
  observation: PharmacyRecoveryObservation;
  amountMinor: null;
  currency: null;
  instrument: 'unknown';
  destinationPolicy: 'original_instrument';
  payloadSha256: string;
  observationSha256: string;
}

export interface PharmacyRecoveryReceipt {
  operationId: string;
  status: 'reconciliation_required';
  requestedAt: string;
  amountMinor: null;
  currency: null;
  instrument: 'unknown';
  destinationPolicy: 'original_instrument';
}

export interface PharmacyRecoveryWorklistQuery {
  page?: number;
  limit?: number;
}

export interface PharmacyRecoveryWorklistRow extends PharmacyRecoveryReceipt {
  orderId: string;
}

export interface PharmacyRecoveryWorklistPage {
  data: PharmacyRecoveryWorklistRow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface IPharmacyOrder {
  _id?: string;
  orderNumber?: string;
  pharmacyId: string;
  orderType: OrderType;
  status: OrderStatus;
  customerId?: string;
  buyerPharmacyId?: string;
  createdById: string;
  createdByRole: string;
  // items
  items: IOrderItem[];
  // pricing
  subtotal?: number;
  discountTotal?: number;
  taxTotal?: number;
  grandTotal?: number;
  subtotalPaise?: number;
  discountTotalPaise?: number;
  taxTotalPaise?: number;
  grandTotalPaise?: number;
  // payment
  paymentMode?: PaymentMode;
  paymentStatus?: PaymentStatus;
  paymentSource?: string;
  paymentTransactionId?: string;
  paidAt?: Date;
  sideEffects?: IPharmacyOrderSideEffects;
  recoveryRequest?: PharmacyRecoveryRequest;
  // delivery
  deliveryMode?: 'pickup' | 'delivery';
  deliveryAddress?: string;
  // flags
  isWalkIn?: boolean;
  prescriptionUrls?: string[];
  prescriptionStatus?: 'not_required' | 'pending' | 'approved' | 'rejected';
  prescriptionReview?: PrescriptionReview;
  notes?: string;
  // linked healthcare
  linkedConsultationId?: string;
  linkedDiagnosticOrderId?: string;
  linkedHealthCheckId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateOrderRequest {
  orderType: OrderType;
  customerId?: string;
  buyerPharmacyId?: string;
  items: {
    medicineId: string;
    medicineName?: string;
    orderedQty: number;
    unitPrice?: number;
    discount?: number;
    freeQty?: number;
    recurring?: boolean;
    subscriptionFrequency?: string;
    subscriptionIntervalDays?: number;
    subscriptionNextRefillDate?: string;
    subscriptionReminderChannel?: 'sms' | 'push' | 'both' | 'none';
  }[];
  paymentMode?: PaymentMode;
  deliveryMode?: 'pickup' | 'delivery';
  deliveryAddress?: string;
  isWalkIn?: boolean;
  prescriptionUrls?: string[];
  notes?: string;
  linkedConsultationId?: string;
  linkedDiagnosticOrderId?: string;
}

export interface UpdateOrderRequest {
  orderType?: OrderType;
  customerId?: string;
  buyerPharmacyId?: string;
  items?: {
    medicineId: string;
    medicineName?: string;
    orderedQty: number;
    unitPrice?: number;
    discount?: number;
    freeQty?: number;
    recurring?: boolean;
    subscriptionFrequency?: string;
    subscriptionIntervalDays?: number;
    subscriptionNextRefillDate?: string;
    subscriptionReminderChannel?: 'sms' | 'push' | 'both' | 'none';
  }[];
  notes?: string;
  deliveryAddress?: string;
  paymentMode?: PaymentMode;
  deliveryMode?: 'pickup' | 'delivery';
  isWalkIn?: boolean;
  prescriptionUrls?: string[];
  linkedConsultationId?: string;
  linkedDiagnosticOrderId?: string;
}

export interface UpdateOrderStatusRequest {
  status: OrderStatus;
  notes?: string;
}

export interface MarkOrderPaidRequest {
  paymentSource?: string;
  paidDate?: string;
  paidTime?: string;
  notes?: string;
}

/** Pharmacist decision on an order's prescription; immutable once written. */
export interface PrescriptionReview {
  decision: 'approved' | 'rejected';
  pharmacistName: string;
  pharmacistRegistrationNumber: string;
  reason?: string;
  /** SHA-256 of JSON.stringify(the exact ordered prescriptionUrls reviewed); the list itself stays on the order. */
  reviewedDocumentSetSha256: string;
  reviewedDocumentCount: number;
  reviewedByPharmacyId: string;
  reviewedAt: Date;
  orderStatusAtReview: OrderStatus;
  paymentStatusAtReview: PaymentStatus;
  /** True when a rejected order had money paid/held; settlement is a separate finance step. */
  refundRequired: boolean;
}

export interface PrescriptionReviewRequest {
  decision: 'approve' | 'reject';
  pharmacistName: string;
  pharmacistRegistrationNumber: string;
  reason?: string;
  reviewedPrescriptionUrls: string[];
}

export interface OrderQueryParams {
  pharmacyId?: string;
  customerId?: string;
  userId?: string;
  buyerPharmacyId?: string;
  viewerPharmacyId?: string;
  orderType?: OrderType;
  orderFor?: 'consultation' | 'diagnostic';
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  prescriptionStatus?: 'not_required' | 'pending' | 'approved' | 'rejected';
  page?: number;
  limit?: number;
}
