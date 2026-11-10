import { Schema, model, Model } from 'mongoose';
import { IMissingOffering } from '@/modules/healthAssessments/types';

const missingOfferingSchema = new Schema<IMissingOffering>(
  {
    kind: {
      type: String,
      enum: ['doctor', 'package'],
      required: true,
      index: true,
    },
    riskCategory: {
      type: String,
      required: true,
      index: true,
    },
    desiredLabel: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    reasons: {
      type: [String],
      default: [],
    },
    occurrenceCount: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    firstSuggestedAt: {
      type: Date,
      default: Date.now,
    },
    lastSuggestedAt: {
      type: Date,
      default: Date.now,
    },
    lastTriggeredByUserId: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

missingOfferingSchema.index(
  { kind: 1, riskCategory: 1, desiredLabel: 1 },
  { unique: true }
);

const MissingOfferingModel: Model<IMissingOffering> = model<IMissingOffering>(
  'MissingOffering',
  missingOfferingSchema
);

export default MissingOfferingModel;
