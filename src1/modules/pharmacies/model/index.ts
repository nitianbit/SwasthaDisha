import { Schema, model, Model } from 'mongoose';
import { IPharmacy } from '@/modules/pharmacies/types';

const openingHoursDaySchema = new Schema(
  {
    open: { type: String, trim: true },
    close: { type: String, trim: true },
    isClosed: { type: Boolean, default: false },
  },
  { _id: false }
);

const weeklyHoursSchema = new Schema(
  {
    monday: { type: openingHoursDaySchema },
    tuesday: { type: openingHoursDaySchema },
    wednesday: { type: openingHoursDaySchema },
    thursday: { type: openingHoursDaySchema },
    friday: { type: openingHoursDaySchema },
    saturday: { type: openingHoursDaySchema },
    sunday: { type: openingHoursDaySchema },
  },
  { _id: false }
);

const pharmacySchema = new Schema<IPharmacy>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    nickname: {
      type: String,
      trim: true,
    },
    ownerName: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
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
      index: true,
    },
    latitude: {
      type: Number,
    },
    longitude: {
      type: Number,
    },
    gstNumber: {
      type: String,
      trim: true,
      sparse: true,
      index: true,
    },
    drugLicenseNumber: {
      type: String,
      trim: true,
      sparse: true,
      index: true,
    },
    gstCertificateUrl: {
      type: String,
      trim: true,
    },
    drugLicenseDocumentUrl: {
      type: String,
      trim: true,
    },
    ownerIdProofUrl: {
      type: String,
      trim: true,
    },
    shopFrontPhotoUrl: {
      type: String,
      trim: true,
    },
    openingHours: {
      type: weeklyHoursSchema,
    },
    pickupAvailable: {
      type: Boolean,
      default: false,
      index: true,
    },
    deliveryAvailable: {
      type: Boolean,
      default: false,
      index: true,
    },
    isVerified: {
      type: Boolean,
      default: false,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    archivedAt: { type: Date, index: true },
    archivedBy: { type: Schema.Types.ObjectId as any, ref: 'Admin' },
    archiveReason: { type: String, trim: true },
    walletEnabled: {
      type: Boolean,
      default: false,
    },
    profilePictureUrl: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

pharmacySchema.index({ name: 'text', city: 'text', address: 'text' });
pharmacySchema.index({ city: 1, state: 1, isActive: 1 });
pharmacySchema.index({ isVerified: 1, isActive: 1 });
pharmacySchema.index({ latitude: 1, longitude: 1 });

const PharmacyModel: Model<IPharmacy> = model<IPharmacy>('Pharmacy', pharmacySchema);

export default PharmacyModel;
