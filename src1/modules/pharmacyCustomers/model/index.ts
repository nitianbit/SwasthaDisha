import { Schema, model, Model } from 'mongoose';
import { IPharmacyCustomer } from '@/modules/pharmacyCustomers/types';

const pharmacyCustomerSchema = new Schema<IPharmacyCustomer>(
  {
    pharmacyId: {
      type: Schema.Types.ObjectId as any,
      ref: 'Pharmacy',
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId as any,
      ref: 'User',
      required: true,
      index: true,
    },
    diseaseNotes: { type: String, trim: true },
    chronicCondition: { type: Boolean, default: false },
    recurringMedicine: { type: Boolean, default: false },
    recurringIntervalDays: { type: Number, min: 1 },
    preferredFollowUpDate: {
      type: String,
      match: /^\d{8}$/,
    },
    pharmacyNotes: { type: String, trim: true },
    createdByRole: { type: String, trim: true },
    createdById: { type: Schema.Types.ObjectId as any, ref: 'User' },
  },
  { timestamps: true }
);

// A pharmacy can only have one record per user
pharmacyCustomerSchema.index({ pharmacyId: 1, userId: 1 }, { unique: true });

const PharmacyCustomerModel: Model<IPharmacyCustomer> = model<IPharmacyCustomer>(
  'PharmacyCustomer',
  pharmacyCustomerSchema
);

export default PharmacyCustomerModel;
