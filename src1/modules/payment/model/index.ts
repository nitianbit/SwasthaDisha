import { Schema, model, Model } from 'mongoose';
import { IPaymentRecord } from '@/modules/payment/types';

const paymentRecordSchema = new Schema<IPaymentRecord>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    payerUserId: {
      type: String,
      index: true,
    },
    payerPharmacyId: {
      type: String,
      index: true,
    },
    context: {
      type: String,
      enum: ['wallet_recharge', 'booking', 'external_booking', 'pharmacy_order', 'lab_booking', 'instant_request', 'assisted_booking'],
      required: true,
      index: true,
    },
    contextId: {
      type: String,
      required: true,
      index: true,
    },
    baseAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    discountAmount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    finalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    baseAmountPaise: { type: Number, min: 0 },
    discountAmountPaise: { type: Number, min: 0 },
    finalAmountPaise: { type: Number, min: 0 },
    currency: {
      type: String,
      required: true,
      default: 'INR',
      uppercase: true,
      trim: true,
    },
    paymentGateway: {
      type: String,
      enum: ['razorpay', 'internal'],//internal will be there if 0 payable amount
      required: true,
      default: 'razorpay',
      index: true,
    },
    couponCode: {
      type: String,
      uppercase: true,
      trim: true,
      index: true,
    },
    // Coupon usage state of this record (see coupon/usage.ts); absent on gateway and pre-A2a records.
    couponUsage: {
      type: String,
      enum: ['pending', 'counted', 'void', 'reversed'],
    },
    razorpayOrderId: {
      type: String,
      sparse: true,
      unique: true,
      index: true,
    },
    razorpayPaymentId: {
      type: String,
      trim: true,
      index: true,
    },
    razorpaySignature: {
      type: String,
      trim: true,
    },
    // Assisted booking phase 1a (§5.3, P2): Razorpay's `fee` (GST included) for the capture, in paise, when reported.
    gatewayFeeMinor: { type: Number, min: 0 },
    status: {
      type: String,
      enum: ['created', 'paid', 'failed', 'refunded'],
      required: true,
      default: 'created',
      index: true,
    },
    isProcessed: {
      type: Boolean,
      default: false,
      index: true,
    },
    notes: {
      type: Schema.Types.Mixed,
    },
    paidAt: {
      type: Date,
    },
    // Background recovery (W3b): when this unsettled attempt is next checked with the gateway, and how often it was.
    recoveryNextAt: { type: Date },
    // r10e: assisted card orders are checked for another capture for a while after payment (back-off).
    extraCheckNextAt: { type: Date },
    extraChecks: { type: Number, default: undefined },
    recoveryChecks: { type: Number, default: undefined },
    // D3: the one decision for a pharmacy order capture - applied to the order, or returned to the wallet. Claimed by a
    // compare-and-set from absent; the payment commit and the late-payment refund both go through it.
    pharmacySettlement: { type: String, enum: ['applied', 'returned'], default: undefined },
    // Assisted booking phase 1a (review of db252c1, item a): a pharmacy top-up is credited once, by the transaction that
    // sets `walletCreditedAt` from absent while the record is paid and not charged back; a card dispute lost on a top-up
    // never credited sets `chargebackAt` (and `failed`) so it is never credited, verified or reconciled afterwards.
    walletCreditedAt: { type: Date },
    chargebackAt: { type: Date },
    // r9 (owner decision): support already paid the pharmacy by hand for a top-up that never arrived; an admin closed it
    // as compensated (`compensatedAt`, and `failed`) so it is never credited, verified or reconciled afterwards.
    compensatedAt: { type: Date },
    compensation: {
      type: new Schema({ by: { type: String, required: true }, reason: { type: String, required: true }, requestKey: { type: String, required: true },
        requestHash: { type: String, required: true }, previousStatus: { type: String, required: true },
        // r9b: the amount support paid by hand (a later lost dispute takes it back).
        amountPaise: { type: Number } }, { _id: false }),
      default: undefined,
    },
  },
  { timestamps: true }
);

paymentRecordSchema.index({ userId: 1, context: 1, contextId: 1 });
paymentRecordSchema.index({ payerUserId: 1, context: 1, contextId: 1 });
paymentRecordSchema.index({ status: 1, isProcessed: 1 });
// Due-first scan of unsettled booking attempts by the recovery sweep (W3b).
paymentRecordSchema.index({ context: 1, status: 1, recoveryNextAt: 1, createdAt: 1 });
// r9: an admin close-as-compensated is once per (admin, request key): `compensation.requestKey` is `<adminId>:<key>`.
paymentRecordSchema.index({ 'compensation.requestKey': 1 }, { unique: true, partialFilterExpression: { 'compensation.requestKey': { $type: 'string' } } });

const PaymentRecordModel: Model<IPaymentRecord> = model<IPaymentRecord>(
  'PaymentRecord',
  paymentRecordSchema
);

export { PaymentRecordModel };
export default PaymentRecordModel;
