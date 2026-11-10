import { Schema, model, Model } from 'mongoose';
import { IWellnessPackage, ITestCategory } from '@/modules/wellnessPackages/types';

const testCategorySchema = new Schema<ITestCategory>(
  {
    categoryName: {
      type: String,
      required: true,
      trim: true,
    },
    categoryTestsCount: {
      type: Number,
      required: true,
      min: 0,
    },
    subTests: {
      type: [String],
      default: [],
    },
  },
  { _id: false }
);

const wellnessPackageSchema = new Schema<IWellnessPackage>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
    },
    bookingProcedure: {
      type: String,
      trim: true,
    },
    imageUrl: {
      type: String,
      trim: true,
    },
    originalPrice: {
      type: Number,
      required: true,
      min: 0,
      index: true,
    },
    discountedPrice: {
      type: Number,
      required: true,
      min: 0,
      index: true,
    },
    totalTestsCount: {
      type: Number,
      required: true,
      min: 0,
    },
    hasFreeDoctorConsultation: {
      type: Boolean,
      default: false,
    },
    testsIncluded: {
      type: [testCategorySchema],
      default: [],
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
    isPopular: {
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
wellnessPackageSchema.index({ category: 1, isActive: 1 });
wellnessPackageSchema.index({ isPopular: 1, isActive: 1 });
wellnessPackageSchema.index({ order: 1 });
wellnessPackageSchema.index({ discountedPrice: 1 });
wellnessPackageSchema.index({ name: 'text', description: 'text' }); // Text search index

const WellnessPackageModel: Model<IWellnessPackage> = model<IWellnessPackage>(
  'WellnessPackage',
  wellnessPackageSchema
);

export default WellnessPackageModel;
