import { Schema, model, Model } from 'mongoose';
import { IAddress } from '@/modules/addresses/types';

const addressSchema = new Schema<IAddress>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['Home', 'Work', 'Other'],
      default: 'Home',
      trim: true,
      index: true,
    },
    label: {
      type: String,
      trim: true,
    },
    address: {
      type: String,
      required: true,
      trim: true,
    },
    landmark: {
      type: String,
      trim: true,
    },
    city: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    state: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    pincode: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    country: {
      type: String,
      trim: true,
      default: 'India',
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
    isDefault: {
      type: Boolean,
      default: false,
      index: true,
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

addressSchema.index({ userId: 1, isActive: 1 });
addressSchema.index({ userId: 1, isDefault: 1 });
addressSchema.index({ userId: 1, type: 1 });

const AddressModel: Model<IAddress> = model<IAddress>('Address', addressSchema);

export default AddressModel;
