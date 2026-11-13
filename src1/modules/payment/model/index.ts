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
      enum: ['wallet_recharge', 'booking', 'external_booking', 'pharmacy_order'],
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
  },
  { timestamps: true }
);

paymentRecordSchema.index({ userId: 1, context: 1, contextId: 1 });
paymentRecordSchema.index({ payerUserId: 1, context: 1, contextId: 1 });
paymentRecordSchema.index({ status: 1, isProcessed: 1 });

const PaymentRecordModel: Model<IPaymentRecord> = model<IPaymentRecord>(
  'PaymentRecord',
  paymentRecordSchema
);

export { PaymentRecordModel };
export default PaymentRecordModel;
