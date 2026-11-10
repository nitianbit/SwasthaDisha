import { Schema, model, Model } from 'mongoose';
import { IHealthTip } from '@/modules/healthTips/types';

const healthTipSchema = new Schema<IHealthTip>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    shortDescription: {
      type: String,
      trim: true,
    },
    icon: {
      type: String,
      trim: true,
    },
    imageUrl: {
      type: String,
      trim: true,
    },
    category: {
      type: String,
      trim: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    order: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
healthTipSchema.index({ category: 1, isActive: 1 });
healthTipSchema.index({ order: 1 });

const HealthTipModel: Model<IHealthTip> = model<IHealthTip>(
  'HealthTip',
  healthTipSchema
);

export default HealthTipModel;
