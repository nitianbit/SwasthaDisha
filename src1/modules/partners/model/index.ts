import { Schema, model, Model } from 'mongoose';
import { IPartner } from '@/modules/partners/types';

const partnerSchema = new Schema<IPartner>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    logoUrl: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    website: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      sparse: true,
      index: true,
    },
    phone: {
      type: String,
      trim: true,
      sparse: true,
      index: true,
    },
    address: {
      type: String,
      trim: true,
    },
    city: {
      type: String,
      trim: true,
      index: true,
    },
    state: {
      type: String,
      trim: true,
      index: true,
    },
    pincode: {
      type: String,
      trim: true,
    },
    partnerType: {
      type: String,
      trim: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isVerified: {
      type: Boolean,
      default: false,
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

// Indexes for better query performance
partnerSchema.index({ partnerType: 1, isActive: 1 });
partnerSchema.index({ partnerType: 1, isVerified: 1 });
partnerSchema.index({ city: 1, state: 1 });
partnerSchema.index({ order: 1 });
partnerSchema.index({ name: 'text', description: 'text' }); // Text search index

const PartnerModel: Model<IPartner> = model<IPartner>(
  'Partner',
  partnerSchema
);

export default PartnerModel;
