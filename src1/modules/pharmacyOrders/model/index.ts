import { Schema, model, Model } from 'mongoose';
import { IPharmacyOrder, PHARMACY_RECOVERY_ORDER_LABELS, PHARMACY_RECOVERY_PAYMENT_LABELS } from '@/modules/pharmacyOrders/types';

const batchAllocationSchema = new Schema(
  {
    batchId: { type: Schema.Types.ObjectId as any, required: true },
    batchNumber: { type: String, required: true, trim: true },
    expiryDate: { type: String, required: true, match: /^\d{8}$/ },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const orderItemSchema = new Schema(
  {
    medicineId: { type: Schema.Types.ObjectId as any, ref: 'Medicine', required: true },
    medicineName: { type: String, trim: true },
    orderedQty: { type: Number, required: true, min: 1 },
    reservedQty: { type: Number, default: 0, min: 0 },
    billedQty: { type: Number, default: 0, min: 0 },
    freeQty: { type: Number, default: 0, min: 0 },
    unitPrice: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    lineTotal: { type: Number, required: true, min: 0 },
    hsnCode: { type: String, trim: true },
    gstPercent: { type: Number, min: 0, max: 100 },
    taxAmount: { type: Number, min: 0 },
    unitPricePaise: { type: Number, min: 0 },
    discountPaise: { type: Number, min: 0 },
    taxPaise: { type: Number, min: 0 },
    lineTotalPaise: { type: Number, min: 0 },
    prescriptionRequired: { type: Boolean, default: false },
    batchAllocations: { type: [batchAllocationSchema], default: [] },
    recurring: { type: Boolean, default: false },
    subscriptionFrequency: { type: String, trim: true },
    subscriptionIntervalDays: { type: Number, min: 1 },
    subscriptionNextRefillDate: { type: String, match: /^\d{8}$/ },
    subscriptionReminderChannel: {
      type: String,
      enum: ['sms', 'push', 'both', 'none'],
    },
    itemStatus: {
      type: String,
      enum: ['active', 'replaced', 'removed'],
      default: 'active',
    },
  },
  { _id: false }
);

const sideEffectStateSchema = new Schema(
  {
    status: {
      type: String,
      enum: ['pending', 'success', 'failed'],
      required: true,
    },
    lastError: { type: String, trim: true },
    updatedAt: { type: Date },
  },
  { _id: false }
);

const recoveryObservationSchema = new Schema(
  {
    orderStatusLabel: { type: String, required: true, enum: [...PHARMACY_RECOVERY_ORDER_LABELS] },
    paymentStatusLabel: { type: String, required: true, enum: [...PHARMACY_RECOVERY_PAYMENT_LABELS] },
    paymentRecordId: { type: String, default: null, validate: (value: unknown) => value === null || (typeof value === 'string' && /^[0-9a-f]{24}$/.test(value)) },
    paymentRecordReferenceState: { type: String, required: true, enum: ['recorded', 'missing', 'malformed'] },
  },
  { _id: false, strict: 'throw' }
);

const prescriptionReviewSchema = new Schema(
  {
    decision: { type: String, required: true, enum: ['approved', 'rejected'] },
    pharmacistName: { type: String, required: true, trim: true, maxlength: 120 },
    pharmacistRegistrationNumber: { type: String, required: true, trim: true, maxlength: 60 },
    reason: { type: String, trim: true, maxlength: 1000 },
    reviewedDocumentSetSha256: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    reviewedDocumentCount: { type: Number, required: true, min: 0 },
    reviewedByPharmacyId: { type: Schema.Types.ObjectId as any, ref: 'Pharmacy', required: true },
    reviewedAt: { type: Date, required: true },
    orderStatusAtReview: { type: String, required: true },
    paymentStatusAtReview: { type: String, required: true },
    refundRequired: { type: Boolean, required: true },
  },
  { _id: false }
);

const prescriptionRefundSchema = new Schema(
  {
    cause: { type: String, enum: ['prescription_rejected', 'delivery_not_collected', 'delivery_refused'] },
    status: { type: String, required: true, enum: ['wallet_pending', 'wallet_credited', 'source_processing', 'source_refunded', 'manual_review'] },
    payerUserId: { type: String },
    paymentRecordId: { type: String },
    walletAmount: { type: Number, required: true, min: 0 },
    gatewayAmountPaise: { type: Number, required: true, min: 0 },
    razorpayPaymentId: { type: String },
    walletCreditedAt: { type: Date },
    generation: { type: Number, required: true, min: 0, default: 0 },
    source: {
      type: new Schema({
        attemptId: { type: String },
        requestedAt: { type: Date, required: true },
        leaseUntil: { type: Date },
        attempts: { type: Number, required: true, min: 1 },
        /** Refund-create requests sent to Razorpay for this generation (incremented before sending). */
        submissions: { type: Number, min: 0 },
        lastSubmittedAt: { type: Date },
        razorpayRefundId: { type: String },
        razorpayStatus: { type: String },
        refundedAt: { type: Date },
      }, { _id: false }),
      default: undefined,
    },
    lastError: { type: String },
    updatedAt: { type: Date, required: true },
  },
  { _id: false }
);

const recoveryRequestSchema = new Schema(
  {
    schemaVersion: { type: Number, required: true, enum: [1] },
    operationKind: { type: String, required: true, enum: ['customer_recovery_request'] },
    operationId: { type: String, required: true },
    requestingCustomerId: { type: String, required: true, match: /^[0-9a-f]{24}$/ },
    orderId: { type: String, required: true, match: /^[0-9a-f]{24}$/ },
    status: { type: String, required: true, enum: ['reconciliation_required'] },
    requestedAt: { type: Date, required: true },
    observation: { type: recoveryObservationSchema, required: true },
    amountMinor: { type: Number, default: null, validate: (value: unknown) => value === null },
    currency: { type: String, default: null, validate: (value: unknown) => value === null },
    instrument: { type: String, required: true, enum: ['unknown'] },
    destinationPolicy: { type: String, required: true, enum: ['original_instrument'] },
    payloadSha256: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    observationSha256: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
  },
  { _id: false, strict: 'throw' }
);

const pharmacyOrderSchema = new Schema<IPharmacyOrder>(
  {
    orderNumber: { type: String, trim: true, sparse: true, index: true },
    pharmacyId: { type: Schema.Types.ObjectId as any, ref: 'Pharmacy', required: true, index: true },
    orderType: {
      type: String,
      enum: ['in_store', 'online'],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: [
        'placed', 'accepted', 'packed',
        'ready_for_pickup', 'out_for_delivery', 'delivery_failed',
        'completed', 'abandoned', 'cancelled', 'rejected',
      ],
      default: 'placed',
      index: true,
    },
    customerId: { type: Schema.Types.ObjectId as any, ref: 'User', index: true },
    buyerPharmacyId: { type: Schema.Types.ObjectId as any, ref: 'Pharmacy', index: true },
    createdById: { type: Schema.Types.ObjectId as any, required: true },
    createdByRole: { type: String, required: true, trim: true },
    items: { type: [orderItemSchema], default: [] },
    subtotal: { type: Number, min: 0 },
    discountTotal: { type: Number, min: 0, default: 0 },
    taxTotal: { type: Number, min: 0, default: 0 },
    grandTotal: { type: Number, min: 0 },
    subtotalPaise: { type: Number, min: 0 },
    discountTotalPaise: { type: Number, min: 0 },
    taxTotalPaise: { type: Number, min: 0 },
    grandTotalPaise: { type: Number, min: 0 },
    paymentMode: {
      type: String,
      enum: ['online_payment', 'in_store_payment', 'cash_on_delivery'],
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'authorized', 'paid', 'failed', 'refunded', 'partially_paid'],
      default: 'pending',
      index: true,
    },
    recoveryRequest: { type: recoveryRequestSchema, default: undefined },
    paymentSource: { type: String, trim: true },
    paymentTransactionId: { type: String, trim: true },
    paidAt: { type: Date },
    sideEffects: {
      subscriptionSync: { type: sideEffectStateSchema },
      notification: { type: sideEffectStateSchema },
    },
    deliveryMode: { type: String, enum: ['pickup', 'delivery'] },
    deliveryAddress: { type: String, trim: true },
    isWalkIn: { type: Boolean, default: false },
    prescriptionUrls: { type: [String], default: [] },
    prescriptionStatus: {
      type: String,
      enum: ['not_required', 'pending', 'approved', 'rejected'],
      default: 'not_required',
      index: true,
    },
    prescriptionReview: { type: prescriptionReviewSchema, default: undefined },
    prescriptionRefund: { type: prescriptionRefundSchema, default: undefined },
    // Delivery/pickup exceptions recorded by the pharmacy (P7b), oldest first.
    deliveryExceptions: {
      type: [new Schema({
        type: { type: String, required: true, enum: ['delivery_failed', 'retry_delivery', 'switch_to_pickup', 'not_collected', 'refused_at_door'] },
        reason: { type: String, trim: true, maxlength: 500 },
        at: { type: Date, required: true },
        byPharmacyId: { type: String, required: true },
        fromStatus: { type: String, required: true },
        toStatus: { type: String, required: true },
        refundRequired: { type: Boolean, required: true },
      }, { _id: false })],
      default: undefined,
    },
    // Refill order of a subscription cycle (P7): waits paymentDueBy for the customer's payment.
    refill: {
      type: new Schema({ subscriptionId: { type: String, required: true }, cycleDate: { type: String, required: true, match: /^\d{8}$/ },
        paymentDueBy: { type: Date, required: true } }, { _id: false }),
      default: undefined,
    },
    notes: { type: String, trim: true },
    linkedConsultationId: { type: Schema.Types.ObjectId as any, ref: 'Booking', index: true },
    linkedDiagnosticOrderId: { type: String, index: true },
    linkedHealthCheckId: { type: Schema.Types.ObjectId as any, ref: 'OrderHealthCheck' },
  },
  { timestamps: true }
);

pharmacyOrderSchema.index({ pharmacyId: 1, status: 1 });
pharmacyOrderSchema.index({ pharmacyId: 1, orderType: 1 });
pharmacyOrderSchema.index({ customerId: 1, status: 1 });
pharmacyOrderSchema.index({ pharmacyId: 1, createdAt: -1 });
pharmacyOrderSchema.index({ 'refill.paymentDueBy': 1, status: 1 }, { sparse: true });
// Pharmacist review queue: pending prescriptions per pharmacy, oldest first.
pharmacyOrderSchema.index({ pharmacyId: 1, prescriptionStatus: 1, createdAt: 1 });
// Finance/ops follow-up: refunds that did not settle automatically.
pharmacyOrderSchema.index({ 'prescriptionRefund.status': 1, 'prescriptionRefund.updatedAt': 1 }, { sparse: true });

const PharmacyOrderModel: Model<IPharmacyOrder> = model<IPharmacyOrder>(
  'PharmacyOrder',
  pharmacyOrderSchema
);

export default PharmacyOrderModel;
