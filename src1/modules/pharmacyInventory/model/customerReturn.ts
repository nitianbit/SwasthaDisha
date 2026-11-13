import { Schema, model, Model } from 'mongoose';

export type CustomerReturnDisposition = 'restock' | 'discard';
export interface ICustomerReturnLine {
  medicineId: string;
  medicineName?: string;
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  quantity: number;
  /** restock: units went back into the same batch (sellable only if that batch is active); discard: destroyed. */
  disposition: CustomerReturnDisposition;
  /** Batch status when the units came back (e.g. 'recalled'), for the recall trace. */
  batchStatusAtReturn?: string;
  /** Value of the returned units at the price the customer paid, in paise. */
  valuePaise: number;
}

/** Medicines a customer brought back from a completed order (P3b). Immutable record; refund decided by staff. */
export interface ICustomerReturn {
  _id?: string;
  pharmacyId: string;
  orderId: string;
  orderNumber?: string;
  customerId?: string;
  requestKey: string;
  lines: ICustomerReturnLine[];
  reason: string;
  returnValuePaise: number;
  /** Staff-chosen wallet refund (0 = none), in paise. */
  refundPaise: number;
  walletTransactionId?: string;
  createdBy: string;
  createdAt?: Date;
}

const lineSchema = new Schema<ICustomerReturnLine>({
  medicineId: { type: String, required: true },
  medicineName: { type: String, trim: true },
  batchId: { type: String, required: true },
  batchNumber: { type: String, required: true },
  expiryDate: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  disposition: { type: String, required: true, enum: ['restock', 'discard'] },
  batchStatusAtReturn: { type: String },
  valuePaise: { type: Number, required: true, min: 0 },
}, { _id: false });

const customerReturnSchema = new Schema<ICustomerReturn>({
  pharmacyId: { type: String, required: true },
  orderId: { type: String, required: true, index: true },
  orderNumber: { type: String },
  customerId: { type: String },
  requestKey: { type: String, required: true },
  lines: { type: [lineSchema], required: true },
  reason: { type: String, required: true, trim: true, maxlength: 500 },
  returnValuePaise: { type: Number, required: true, min: 0 },
  refundPaise: { type: Number, required: true, min: 0 },
  walletTransactionId: { type: String },
  createdBy: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
customerReturnSchema.index({ pharmacyId: 1, createdAt: -1 });
// A retried submission (same key) returns the first record instead of returning stock / refunding twice.
customerReturnSchema.index({ pharmacyId: 1, requestKey: 1 }, { unique: true });
customerReturnSchema.index({ pharmacyId: 1, 'lines.batchId': 1 });

export const CustomerReturnModel: Model<ICustomerReturn> = model<ICustomerReturn>('PharmacyCustomerReturn', customerReturnSchema, 'pharmacy_customer_returns');
