import { Schema, model, Model } from 'mongoose';
import { IPartner } from '@/modules/partners/types';

const partnerSchema = new Schema<IPartner>(
  {
    kind: {
      type: String,
      required: true,
      enum: ['lab', 'clinic'],
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    legalName: {
      type: String,
      trim: true,
    },
    gstin: {
      type: String,
      trim: true,
      sparse: true,
      index: true,
    },
    pan: {
      type: String,
      trim: true,
    },
    contact: {
      phone: { type: String, required: true, trim: true },
      email: { type: String, trim: true, lowercase: true },
    },
    logo: {
      type: String,
      trim: true,
    },
    verification: {
      state: {
        type: String,
        enum: ['pending', 'verified', 'suspended'],
        default: 'pending',
      },
      documents: [{ type: String }],
      verifiedAt: Date,
      verifiedBy: String,
    },
    taxRegime: {
      type: String,
      enum: ['regular', 'composition', 'unregistered'],
      default: 'unregistered',
    },
    invoiceSeries: {
      prefix: { type: String, required: true, trim: true, maxlength: 6 },
    },
    activeOwnerCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    solo: {
      type: Boolean,
    },
    soloDoctorId: {
      type: String,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

partnerSchema.index({ kind: 1, isActive: 1 });
partnerSchema.index({ 'verification.state': 1, isActive: 1 });

const PartnerModel: Model<IPartner> = model<IPartner>('Partner', partnerSchema);

export default PartnerModel;
