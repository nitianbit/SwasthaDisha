import { Schema, model, Model } from 'mongoose';
import { IBranch } from '@/modules/partners/types';

const dayHoursSchema = new Schema(
  {
    open: { type: String, required: true },
    close: { type: String, required: true },
  },
  { _id: false }
);

const branchSchema = new Schema<IBranch>(
  {
    partnerId: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    address: {
      line1: { type: String, required: true, trim: true },
      line2: { type: String, trim: true },
      city: { type: String, required: true, trim: true },
      state: { type: String, required: true, trim: true },
      stateCode: { type: String, required: true, trim: true },
      pincode: { type: String, required: true, trim: true },
    },
    geo: {
      type: { type: String, enum: ['Point'] },
      coordinates: [Number],
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    hours: {
      mon: dayHoursSchema,
      tue: dayHoursSchema,
      wed: dayHoursSchema,
      thu: dayHoursSchema,
      fri: dayHoursSchema,
      sat: dayHoursSchema,
      sun: dayHoursSchema,
    },
    holidays: [{ type: String }],
    services: {
      homeCollection: { type: Boolean, default: false },
      inLab: { type: Boolean, default: false },
      inClinic: { type: Boolean, default: false },
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    // Q16b: POST /branches with a request key is exactly once per (partner, key); a replay answers with this branch.
    createRequestKey: { type: String },
    createRequestHash: { type: String, select: false },
  },
  {
    timestamps: true,
  }
);

branchSchema.index({ partnerId: 1, isActive: 1 });
branchSchema.index({ geo: '2dsphere' });
// Q16b: one branch per (partner, request key) whatever the race (declared here so `npm run sync-indexes` builds it).
branchSchema.index({ partnerId: 1, createRequestKey: 1 }, { unique: true, partialFilterExpression: { createRequestKey: { $type: 'string' } } });

const BranchModel: Model<IBranch> = model<IBranch>('PartnerBranch', branchSchema, 'partner_branches');

export default BranchModel;
