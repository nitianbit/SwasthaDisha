import { Schema, model, Model } from 'mongoose';

/** One return of batch stock to a supplier (P3). Immutable record of what left the pharmacy, when and why. */
export interface ISupplierReturn {
  _id?: string;
  pharmacyId: string;
  supplierId: string;
  inventoryItemId: string;
  medicineId: string;
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  batchStatusAtReturn: string;
  quantity: number;
  unitCost?: number;
  reason: 'expired' | 'damaged' | 'recalled' | 'near_expiry' | 'other';
  notes?: string;
  createdBy: string;
  createdAt?: Date;
}

const supplierReturnSchema = new Schema<ISupplierReturn>({
  pharmacyId: { type: String, required: true, index: true },
  supplierId: { type: String, required: true, index: true },
  inventoryItemId: { type: String, required: true },
  medicineId: { type: String, required: true },
  batchId: { type: String, required: true },
  batchNumber: { type: String, required: true },
  expiryDate: { type: String, required: true },
  batchStatusAtReturn: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  unitCost: { type: Number, min: 0 },
  reason: { type: String, required: true, enum: ['expired', 'damaged', 'recalled', 'near_expiry', 'other'] },
  notes: { type: String, trim: true, maxlength: 500 },
  createdBy: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
supplierReturnSchema.index({ pharmacyId: 1, createdAt: -1 });

export const SupplierReturnModel: Model<ISupplierReturn> = model<ISupplierReturn>('PharmacySupplierReturn', supplierReturnSchema, 'pharmacy_supplier_returns');
