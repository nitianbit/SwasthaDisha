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
  },
  {
    timestamps: true,
  }
);

branchSchema.index({ partnerId: 1, isActive: 1 });
branchSchema.index({ geo: '2dsphere' });

const BranchModel: Model<IBranch> = model<IBranch>('Branch', branchSchema);

export default BranchModel;
