import { model, Schema } from 'mongoose';

/**
 * D4: one claim per once-only operation key. 'used' is written inside the transaction that performs the operation;
 * 'abandoned' by an explicit abandon. The unique key means exactly one of them can ever exist, so an abandoned key can
 * never be performed later, and a performed key can never be abandoned.
 */
export interface RequestKeyClaim { scope: string; key: string; state: 'used' | 'abandoned'; at: Date }

const schema = new Schema<RequestKeyClaim>({
  scope: { type: String, required: true, immutable: true },
  key: { type: String, required: true, immutable: true },
  state: { type: String, enum: ['used', 'abandoned'], required: true, immutable: true },
  at: { type: Date, required: true, immutable: true },
}, { collection: 'request_keys', versionKey: false, strict: 'throw', autoIndex: false, autoCreate: false });
schema.index({ scope: 1, key: 1 }, { unique: true });

export const RequestKeyModel = model<RequestKeyClaim>('RequestKey', schema);
