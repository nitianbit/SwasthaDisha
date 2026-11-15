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
    // Q8: admin creation exactly once per (admin, request key).
    createdBy: { type: String },
    createRequestKey: { type: String },
    createRequestHash: { type: String },
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
partnerSchema.index({ createdBy: 1, createRequestKey: 1 }, { unique: true, partialFilterExpression: { createRequestKey: { $type: 'string' } } });
partnerSchema.index({ name: 1 });
// Q6: one solo practice per doctor.
partnerSchema.index({ soloDoctorId: 1 }, { unique: true, partialFilterExpression: { soloDoctorId: { $type: 'string' } } });
partnerSchema.index({ 'verification.state': 1, isActive: 1 });

const PartnerModel: Model<IPartner> = model<IPartner>('PartnerOrg', partnerSchema, 'partner_orgs');

export default PartnerModel;
