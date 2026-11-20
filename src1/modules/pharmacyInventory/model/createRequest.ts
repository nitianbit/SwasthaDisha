import { model, Schema } from 'mongoose';

/**
 * Q15: a pharmacy's keyed create (inventory save, supplier create). Written in the same transaction as the records it
 * made, so a key either made exactly that result or nothing; the unique key makes a concurrent repeat lose and replay.
 * `requestHash` is the content the key is bound to; `resultIds` the records it made (inventory item ids in request
 * order, or the one supplier id).
 */
export type PharmacyCreateKind = 'inventory_items' | 'supplier';
export interface PharmacyCreateRequest {
  pharmacyId: string; kind: PharmacyCreateKind; requestKey: string; requestHash: string; resultIds: string[]; at: Date;
}

const schema = new Schema<PharmacyCreateRequest>({
  pharmacyId: { type: String, required: true, immutable: true },
  kind: { type: String, enum: ['inventory_items', 'supplier'], required: true, immutable: true },
  requestKey: { type: String, required: true, immutable: true },
  requestHash: { type: String, required: true, immutable: true },
  resultIds: { type: [String], required: true, immutable: true },
  at: { type: Date, required: true, immutable: true },
}, { collection: 'pharmacy_create_requests', versionKey: false, strict: 'throw' });
// Declared here so `npm run sync-indexes` builds it.
schema.index({ pharmacyId: 1, kind: 1, requestKey: 1 }, { unique: true });

export const PharmacyCreateRequestModel = model<PharmacyCreateRequest>('PharmacyCreateRequest', schema);

/** The key format accepted for these creates (as catalogue and pharmacy create keys). */
export const PHARMACY_REQUEST_KEY = /^[A-Za-z0-9_-]{8,100}$/;
