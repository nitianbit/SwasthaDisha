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
    // S3: the patient's agreement to the link (who recorded it and when). Links made before S3 have none.
    consent: { type: String, enum: ['patient_agreed', 'not_recorded', 'customer_order'] },
    consentRecordedAt: { type: Date },
    consentRecordedById: { type: String },
    // Assisted booking (§17.4): the name the pharmacy first typed for the account holder. Pharmacy-facing lists show it
    // (or the masked account name), never the account's own name or email.
    typedName: { type: String, trim: true, maxlength: 200 },
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
