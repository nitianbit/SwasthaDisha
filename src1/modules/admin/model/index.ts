import { Schema, model, Model } from 'mongoose';
import { IAdmin } from '@/modules/admin/types';

const adminSchema = new Schema<IAdmin>(
  {
    email: {
      type: String,
      sparse: true,
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
      enum: ['admin'],
      default: 'admin',
      index: true,
    },
    name: {
      type: String,
      trim: true,
      index: true,
    },
    profilePictureUrl: {
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
      default: 'India',
    },
    department: {
      type: String,
      trim: true,
    },
    employeeId: {
      type: String,
      trim: true,
      sparse: true,
      index: true,
    },
    permissions: {
      type: [String],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isVerified: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

adminSchema.index({ name: 'text' });

const AdminModel: Model<IAdmin> = model<IAdmin>('Admin', adminSchema);

export default AdminModel;
