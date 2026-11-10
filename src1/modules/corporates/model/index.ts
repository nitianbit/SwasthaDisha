import { Schema, model, Model } from 'mongoose';
import { ICorporate } from '@/modules/corporates/types';

const corporateSchema = new Schema<ICorporate>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    companyName: {
      type: String,
      trim: true,
      index: true,
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
    contactPerson: {
      type: String,
      trim: true,
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
    country: {
      type: String,
      trim: true,
      index: true,
    },
    logoUrl: {
      type: String,
      trim: true,
      index: true,
    },
    website: {
      type: String,
      trim: true,
    },
    domain: {
      type: String,
      trim: true,
      lowercase: true,
      sparse: true, 
      index: true,
    },
    industry: {
      type: String,
      trim: true,
      index: true,
    },
    employeeCount: {
      type: Number,
      min: 0,
    },
    description: {
      type: String,
      trim: true,
    },
    specialistIds: {
      type: [String],
      default: [],
      index: true,
    },
    wellnessPackageIds: {
      type: [String],
      default: [],
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
  },
  {
    timestamps: true,
  }
);

// Indexes for better query performance
corporateSchema.index({ industry: 1, isActive: 1 });
corporateSchema.index({ city: 1, state: 1, country: 1 });
corporateSchema.index({ isVerified: 1, isActive: 1 });
corporateSchema.index({ name: 'text', companyName: 'text', description: 'text' }); // Text search index

const CorporateModel: Model<ICorporate> = model<ICorporate>(
  'Corporate',
  corporateSchema
);

export default CorporateModel;
