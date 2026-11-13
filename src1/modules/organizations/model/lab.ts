import { Connection, Model, Schema } from 'mongoose';
import { LabAuthorityError } from '../types';

const models = new WeakMap<Connection, Model<Record<string, unknown>>>();
export function createLabBusinessModel(connection: Connection): Model<Record<string, unknown>> {
  const previous = models.get(connection);
  if (previous) return previous;
  if (connection.models.LabBusiness) throw new LabAuthorityError('LAB_AUTHORITY_UNAVAILABLE');
  const id = { type: String, required: true, match: /^[0-9a-f]{24}$/, immutable: true };
  const schema = new Schema<Record<string, unknown>>({
    _id: id, schemaVersion: { type: Number, required: true, enum: [1], immutable: true },
    revision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
    organizationId: id,
    legalName: { type: String, required: true, maxlength: 320 },
    registrationReference: { type: String, required: true, maxlength: 256 },
    state: { type: String, required: true, enum: ['active', 'suspended', 'revoked'] },
    verificationValidFrom: { type: Date, required: true }, verificationExpiresAt: { type: Date, required: true },
    verificationEvidence: { type: new Schema({ evidenceVersionId: id,
      evidenceSha256: { type: String, required: true, match: /^[0-9a-f]{64}$/ } }, { _id: false, strict: 'throw' }), required: true },
  }, { timestamps: true, strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false });
  schema.index({ organizationId: 1 }, { unique: true });
  const model = connection.model('LabBusiness', schema, 'labs'); models.set(connection, model); return model;
}
