import { Schema, model, Model } from 'mongoose';
import { IOrderHealthCheck } from '@/modules/orderHealthChecks/types';

const orderHealthCheckSchema = new Schema<IOrderHealthCheck>(
  {
    orderId: { type: Schema.Types.ObjectId as any, ref: 'PharmacyOrder', required: true },
    pharmacyId: { type: Schema.Types.ObjectId as any, ref: 'Pharmacy', required: true, index: true },
    userId: { type: Schema.Types.ObjectId as any, ref: 'User', required: true, index: true },
    checkedBy: { type: Schema.Types.ObjectId as any, ref: 'User', required: true },
    systolicBP: { type: Number, min: 0, max: 300 },
    diastolicBP: { type: Number, min: 0, max: 200 },
    fastingSugar: { type: Number, min: 0 },
    postMealSugar: { type: Number, min: 0 },
    hba1c: { type: Number, min: 0, max: 20 },
    notes: { type: String, trim: true },
    checkedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

orderHealthCheckSchema.index({ pharmacyId: 1, userId: 1 });
orderHealthCheckSchema.index({ orderId: 1 }, { unique: true });

const OrderHealthCheckModel: Model<IOrderHealthCheck> = model<IOrderHealthCheck>(
  'OrderHealthCheck',
  orderHealthCheckSchema
);

export default OrderHealthCheckModel;
