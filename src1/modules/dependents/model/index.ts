import { Schema, model, Model } from 'mongoose';
import { IDependent } from '@/modules/dependents/types';

const dependentSchema = new Schema<IDependent>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    relationship: {
      type: String,
      required: true,
      trim: true,
      enum: [
        'Me',
        'Father',
        'Mother',
        'Spouse',
        'wife',
        'Wife',
        'husband',
        'Husband',
        'Son',
        'Daughter',
        'Brother',
        'Sister',
        'Friend',
        'Grandfather',
        'Grandmother',
        'Other',
      ],
      index: true,
    },
    age: {
      type: Number,
      min: 0,
      max: 150,
    },
    gender: {
      type: String,
      enum: ['Male', 'Female', 'Other'],
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    dateOfBirth: {
      type: String,
      match: /^\d{8}$/, // YYYYMMDD format
    },
    bloodGroup: {
      type: String,
      enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
      trim: true,
    },
    address: {
      type: String,
      trim: true,
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

// Indexes for better query performance
dependentSchema.index({ userId: 1, isActive: 1 });
dependentSchema.index({ userId: 1, relationship: 1 });
dependentSchema.index({ name: 'text' }); // Text search index

const DependentModel: Model<IDependent> = model<IDependent>(
  'Dependent',
  dependentSchema
);

export default DependentModel;
