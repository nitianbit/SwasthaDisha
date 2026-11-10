import { Schema, model, Model } from 'mongoose';
import { IHealthAssessment } from '@/modules/healthAssessments/types';

const riskSchema = new Schema(
  {
    category: {
      type: String,
      required: true,
      index: true,
    },
    score: {
      type: Number,
      required: true,
      min: 0,
    },
    level: {
      type: String,
      enum: ['low', 'moderate', 'high'],
      required: true,
    },
    reasons: {
      type: [String],
      default: [],
    },
  },
  { _id: false }
);

const healthAssessmentSchema = new Schema<IHealthAssessment>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    dependentId: {
      type: String,
      trim: true,
      index: true,
    },
    assessmentVersion: {
      type: String,
      required: true,
      default: '1.0',
    },
    profileSnapshot: {
      type: Schema.Types.Mixed,
      default: {},
    },
    answers: {
      type: Schema.Types.Mixed,
      default: {},
    },
    computedMetrics: {
      type: Schema.Types.Mixed,
      default: {},
    },
    risks: {
      type: [riskSchema],
      default: [],
    },
    overallRiskLevel: {
      type: String,
      enum: ['low', 'moderate', 'high'],
      required: true,
      index: true,
    },
    recommendations: {
      type: Schema.Types.Mixed,
      required: true,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

healthAssessmentSchema.index({ userId: 1, createdAt: -1 });
healthAssessmentSchema.index({ dependentId: 1, createdAt: -1 });
healthAssessmentSchema.index({ overallRiskLevel: 1, createdAt: -1 });

const HealthAssessmentModel: Model<IHealthAssessment> = model<IHealthAssessment>(
  'HealthAssessment',
  healthAssessmentSchema
);

export default HealthAssessmentModel;
