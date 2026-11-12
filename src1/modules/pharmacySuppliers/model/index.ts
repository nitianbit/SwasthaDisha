import { Schema, model } from 'mongoose';
import { IPharmacySupplier, SUPPLIER_TEXT_LIMITS } from '@/modules/pharmacySuppliers/types';

const supplierSchema = new Schema<IPharmacySupplier>({
  schemaVersion: { type: Number, required: true, enum: [1], immutable: true },
  pharmacyId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  displayName: { type: String, required: true, maxlength: SUPPLIER_TEXT_LIMITS.displayName },
  contactName: { type: String, default: null, maxlength: SUPPLIER_TEXT_LIMITS.contactName },
  phone: { type: String, default: null, maxlength: SUPPLIER_TEXT_LIMITS.phone },
  email: { type: String, default: null, maxlength: SUPPLIER_TEXT_LIMITS.email },
  address: { type: String, default: null, maxlength: SUPPLIER_TEXT_LIMITS.address },
  state: { type: String, required: true, enum: ['active', 'archived'] },
  revision: { type: Number, required: true, min: 1, max: Number.MAX_SAFE_INTEGER, validate: Number.isSafeInteger },
  createdByActorId: { type: String, required: true, immutable: true, match: /^[0-9a-f]{24}$/ },
  updatedByActorId: { type: String, required: true, match: /^[0-9a-f]{24}$/ },
  archivedAt: { type: Date, default: null },
}, { strict: 'throw', timestamps: true, versionKey: false, autoCreate: false, autoIndex: false });

// A future admitted first insert may create the namespace/default _id index.
export default model<IPharmacySupplier>('PharmacySupplier', supplierSchema, 'pharmacy_suppliers');
