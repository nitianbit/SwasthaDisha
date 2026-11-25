import { Schema, model, Model } from 'mongoose';

/**
 * r30 (round 3f, §25.9.2): records access while a doctor treats a patient. Ids and codes only — never names, phones or
 * clinical text.
 * - `record_reads`: every history read and every other-provider file read, written BEFORE the answer (DR25); kept for good.
 * - `record_access_requests`: the doctor's request for the account holder's approval (one pending per booking and doctor).
 * - `record_access_grants`: the holder's approval, one row per doctor and person, renewed in place (12 months).
 * The `personKey` is the family member's id, or `'self'` for the account holder (`'account'` on a read of the whole account).
 */
export type RecordReadScope = 'own_history' | 'other_history' | 'file';
export interface IRecordRead {
  doctorId: string;
  holderUserId: string;
  personKey: string;
  treatingBookingId: string | null;
  scope: RecordReadScope;
  /** `file`: the upload-dir path read. */
  path?: string;
  /** `file`: the booking (consultation or partner-lab booking) the file belongs to. */
  sourceBookingId?: string;
  at: Date;
}
const readSchema = new Schema<IRecordRead>({
  doctorId: { type: String, required: true },
  holderUserId: { type: String, required: true },
  personKey: { type: String, required: true },
  treatingBookingId: { type: String, default: null },
  scope: { type: String, required: true, enum: ['own_history', 'other_history', 'file'] },
  path: { type: String },
  sourceBookingId: { type: String },
  at: { type: Date, required: true },
}, { versionKey: false, strict: 'throw' });
readSchema.index({ doctorId: 1, at: -1 });
readSchema.index({ holderUserId: 1, personKey: 1, at: -1 });
readSchema.index({ treatingBookingId: 1 });
export const RecordReadModel: Model<IRecordRead> = model<IRecordRead>('RecordRead', readSchema, 'record_reads');

export type RecordRequestState = 'pending' | 'approved' | 'denied' | 'expired' | 'replaced';
export type RecordGrantVia = 'app' | 'sms_code';
export interface IRecordAccessRequest {
  _id?: unknown;
  holderUserId: string;
  personKey: string;
  dependentId?: string;
  specialistId: string;
  treatingBookingId: string;
  state: RecordRequestState;
  via?: RecordGrantVia;
  /** Phase 5 seam (§27.9): the HMAC of a sent code and its expiry; never written while no code sender exists. */
  codeHash?: string;
  codeExpiresAt?: Date;
  wrongTries: number;
  /** The earlier of 24 hours and the treating window's close (DR21). */
  expiresAt: Date;
  decidedAt?: Date;
  createdAt: Date;
}
const requestSchema = new Schema<IRecordAccessRequest>({
  holderUserId: { type: String, required: true },
  personKey: { type: String, required: true },
  dependentId: { type: String },
  specialistId: { type: String, required: true },
  treatingBookingId: { type: String, required: true },
  state: { type: String, required: true, enum: ['pending', 'approved', 'denied', 'expired', 'replaced'] },
  via: { type: String, enum: ['app', 'sms_code'] },
  codeHash: { type: String },
  codeExpiresAt: { type: Date },
  wrongTries: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true },
  decidedAt: { type: Date },
  createdAt: { type: Date, required: true },
}, { versionKey: false, strict: 'throw' });
/** One open request per booking and doctor (asserted before every write, §25.9.7). */
requestSchema.index({ treatingBookingId: 1, specialistId: 1 }, { unique: true, partialFilterExpression: { state: 'pending' } });
requestSchema.index({ holderUserId: 1, state: 1, createdAt: -1 });
/** The doctor's latest request of a booking (history `access.request`). */
requestSchema.index({ treatingBookingId: 1, createdAt: -1 });
export const RecordAccessRequestModel: Model<IRecordAccessRequest> = model<IRecordAccessRequest>(
  'RecordAccessRequest', requestSchema, 'record_access_requests');

export interface IRecordAccessGrant {
  _id?: unknown;
  holderUserId: string;
  personKey: string;
  dependentId?: string;
  specialistId: string;
  via: RecordGrantVia;
  requestId: string;
  at: Date;
  expiresAt: Date;
  revokedAt?: Date | null;
  revokedBy?: string;
  revokedByKind?: 'holder' | 'admin';
  /** The admin's reason (an admin revokes on the holder's request). */
  revokeReason?: string;
}
const grantSchema = new Schema<IRecordAccessGrant>({
  holderUserId: { type: String, required: true },
  personKey: { type: String, required: true },
  dependentId: { type: String },
  specialistId: { type: String, required: true },
  via: { type: String, required: true, enum: ['app', 'sms_code'] },
  requestId: { type: String, required: true },
  at: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  revokedBy: { type: String },
  revokedByKind: { type: String, enum: ['holder', 'admin'] },
  revokeReason: { type: String },
}, { versionKey: false, strict: 'throw' });
/** One grant per doctor and person (asserted before every write, §25.9.7). */
grantSchema.index({ holderUserId: 1, personKey: 1, specialistId: 1 }, { unique: true });
grantSchema.index({ specialistId: 1, holderUserId: 1 });
export const RecordAccessGrantModel: Model<IRecordAccessGrant> = model<IRecordAccessGrant>('RecordAccessGrant', grantSchema, 'record_access_grants');
