import { Schema, model, Model } from 'mongoose';
import { IUser } from '@/modules/user/types';

const emergencyContactSchema = new Schema(
  {
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    relationship: { type: String, trim: true },
  },
  { _id: false }
);

const userSchema = new Schema<IUser>(
  {
    // Authentication & Basic Info
    email: {
      type: String,
      sparse: true,
      index: true,
      trim: true,
      lowercase: true,
    },
    corporateEmail: {
      type: String,
      sparse: true,
      unique: true,
      index: true,
      trim: true,
      lowercase: true,
    },
    phone: {
      type: String,
      sparse: true,
      index: true,
      trim: true,
    },
    userType: {
      type: String,
      required: true,
      enum: ['user'],
      default: 'user',
      index: true,
    },
    name: {
      type: String,
      trim: true,
      index: true,
    },
    age: {
      type: Number,
      min: 0,
      max: 150,
    },
    profilePictureUrl: {
      type: String,
      trim: true,
    },
    
    // User-specific fields (for regular app users)
    dateOfBirth: {
      type: String,
      match: /^\d{8}$/, // YYYYMMDD format
    },
    gender: {
      type: String,
      enum: ['Male', 'Female', 'Other'],
      trim: true,
    },
    bloodGroup: {
      type: String,
      enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
      trim: true,
    },
    height: {
      type: Number,
      min: 0,
      max: 300, // in cm
    },
    weight: {
      type: Number,
      min: 0,
      max: 500, // in kg
    },
    emergencyContact: {
      type: emergencyContactSchema,
    },
    // Address fields
    address: {
      type: String,
      trim: true,
    },
    latitude: {
      type: Number,
      min: -90,
      max: 90,
    },
    longitude: {
      type: Number,
      min: -180,
      max: 180,
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
      default: 'India',
    },
    // Corporate association
    corporateId: {
      type: String,
      index: true,
    },
    referralCode: {
      type: String,
      trim: true,
      uppercase: true,
      sparse: true,
      unique: true,
      index: true,
    },
    referredByUserId: {
      type: String,
      index: true,
    },

    // Status fields
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
    isCorporateEmailVerified: {
      type: Boolean,
      default: false,
      index: true,
    },
    createdSource: {
      type: String,
      enum: ['self_signup', 'pharmacy_app'],
      default: 'self_signup',
      index: true,
    },
    createdByRole: {
      type: String,
      trim: true,
    },
    createdById: {
      type: String,
      index: true,
    },
    otpVerified: {
      type: Boolean,
      default: false,
      index: true,
    },
    linkedPharmacyId: {
      type: String,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for efficient queries
userSchema.index({ phone: 1, userType: 1 });
userSchema.index({ email: 1, userType: 1 });
userSchema.index({ corporateEmail: 1, userType: 1 });
userSchema.index({ corporateId: 1, userType: 1 });
userSchema.index({ corporateId: 1, isActive: 1 });
userSchema.index({ userType: 1, isActive: 1 });
userSchema.index({ userType: 1, isVerified: 1 });
userSchema.index({ name: 'text' }); // Text search index

const UserModel: Model<IUser> = model<IUser>('User', userSchema);

export default UserModel;
