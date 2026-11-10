import { Schema, model, Model } from 'mongoose';
import { IPharmacySubscription } from '@/modules/pharmacySubscriptions/types';

const pharmacySubscriptionSchema = new Schema<IPharmacySubscription>(
  {
    pharmacyId: { type: Schema.Types.ObjectId as any, ref: 'Pharmacy', required: true, index: true },
    userId: { type: Schema.Types.ObjectId as any, ref: 'User', required: true, index: true },
    medicineId: { type: Schema.Types.ObjectId as any, ref: 'Medicine', required: true, index: true },
    medicineName: { type: String, trim: true },
    frequency: { type: String, trim: true },
    intervalDays: { type: Number, required: true, min: 1 },
    nextRefillDate: { type: String, match: /^\d{8}$/ },
    reminderChannel: {
      type: String,
      enum: ['sms', 'push', 'both', 'none'],
      default: 'push',
    },
    isActive: { type: Boolean, default: true, index: true },
    pausedUntil: { type: String, match: /^\d{8}$/ },
    sourceOrderId: { type: Schema.Types.ObjectId as any, ref: 'PharmacyOrder', index: true },
    sourceOrderStatus: { type: String, trim: true, index: true },
    lastSyncStatus: {
      type: String,
      enum: ['pending', 'synced', 'failed'],
      default: 'synced',
      index: true,
    },
    lastSyncError: { type: String, trim: true },
    createdById: { type: Schema.Types.ObjectId as any, ref: 'User' },
    createdByRole: { type: String, trim: true },
  },
  { timestamps: true }
);

pharmacySubscriptionSchema.index({ pharmacyId: 1, userId: 1 });
pharmacySubscriptionSchema.index({ pharmacyId: 1, isActive: 1 });
pharmacySubscriptionSchema.index({ nextRefillDate: 1, isActive: 1 });
pharmacySubscriptionSchema.index({ sourceOrderId: 1, medicineId: 1 });

const PharmacySubscriptionModel: Model<IPharmacySubscription> = model<IPharmacySubscription>(
  'PharmacySubscription',
  pharmacySubscriptionSchema
);

export default PharmacySubscriptionModel;
