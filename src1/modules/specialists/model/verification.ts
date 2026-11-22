import mongoose, { Schema, model, Model } from 'mongoose';

/** S5 review: one row per admin verification of a doctor (specialists/verification.ts). */
export interface ISpecialistVerification {
  specialistId: string | null;
  verifiedBy: string;
  requestedAt: Date;
  outcome: 'pending' | 'applied' | 'not_applied';
  httpStatus?: number;
  name?: string;
  medicalRegistrationNumber?: string;
  degree?: string;
  specialization?: string;
  fenced: boolean;
}

const verificationSchema = new Schema<ISpecialistVerification>({
  specialistId: { type: String, default: null, index: true },
  verifiedBy: { type: String, required: true },
  requestedAt: { type: Date, required: true },
  outcome: { type: String, required: true, enum: ['pending', 'applied', 'not_applied'] },
  httpStatus: Number,
  name: String,
  medicalRegistrationNumber: String,
  degree: String,
  specialization: String,
  fenced: { type: Boolean, required: true },
}, { versionKey: false });

export const SpecialistVerificationModel: Model<ISpecialistVerification> =
  (mongoose.models.SpecialistVerification as Model<ISpecialistVerification>) || model<ISpecialistVerification>('SpecialistVerification', verificationSchema);

