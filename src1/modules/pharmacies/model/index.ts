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
    // P9: the pharmacy's registered pharmacist, recorded on every one-button prescription approval.
    pharmacist: {
      type: new Schema({
        name: { type: String, trim: true, required: true },
        registrationNumber: { type: String, trim: true, required: true },
        updatedAt: { type: Date, required: true },
      }, { _id: false }),
      default: undefined,
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
    // Q15: an admin create made under a request key (exactly once per admin and key; replay by content hash).
    createdBy: { type: String },
    createRequestKey: { type: String },
    createRequestHash: { type: String },
  },
  {
    timestamps: true,
  }
);

pharmacySchema.index({ name: 'text', city: 'text', address: 'text' });
pharmacySchema.index({ city: 1, state: 1, isActive: 1 });
pharmacySchema.index({ isVerified: 1, isActive: 1 });
pharmacySchema.index({ latitude: 1, longitude: 1 });
// Q15: one pharmacy per (admin, create key). Declared here so `npm run sync-indexes` builds it.
pharmacySchema.index({ createdBy: 1, createRequestKey: 1 }, { unique: true, partialFilterExpression: { createRequestKey: { $type: 'string' } } });

const PharmacyModel: Model<IPharmacy> = model<IPharmacy>('Pharmacy', pharmacySchema);

export default PharmacyModel;
