import { model, Schema } from 'mongoose';

/** D1: who uploaded a legacy upload-dir file (recorded in the upload request). The only source of uploader identity. */
export interface FileUpload {
  path: string;
  uploaderType: string;
  uploaderId: string;
  createdAt: Date;
}

export const GRANT_KINDS = ['public', 'booking', 'pharmacy_order', 'specialist', 'pharmacy', 'hr', 'user',
  'partner_lab_report_draft', 'partner_lab_report'] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

/**
 * D1: a binding of a file to ONE field of ONE record, written only when the attaching account uploaded the file (or is an
 * admin), or by the curated legacy manifest. It is honoured at read time only while that field still holds the file, so
 * removing, replacing or deleting the record withdraws it, and a delayed or orphaned binding is inert.
 */
export interface FileGrant {
  path: string;
  kind: GrantKind;
  /** Mongoose model name of the record, e.g. 'Booking', 'Pharmacy'. */
  model: string;
  resourceId: string;
  /** Dotted field path inside the record, e.g. 'documents.url', 'profilePictureUrl'. */
  field: string;
  source: 'attach' | 'legacy_manifest';
  /**
   * 'revoked' is a tombstone: a withdrawal never deletes the slot. Every change bumps `gen`, and a grant applies only at
   * the generation seen when its authority was checked, so a delayed grant cannot revive a withdrawn binding.
   */
  state: 'active' | 'revoked';
  gen: number;
  createdByType: string;
  createdById: string;
  createdAt: Date;
}

const options = { versionKey: false as const, strict: 'throw' as const, autoIndex: false, autoCreate: false };

const uploadSchema = new Schema<FileUpload>({
  path: { type: String, required: true, immutable: true },
  uploaderType: { type: String, required: true, immutable: true },
  uploaderId: { type: String, required: true, immutable: true },
  createdAt: { type: Date, required: true, immutable: true },
}, { ...options, collection: 'file_uploads' });
uploadSchema.index({ path: 1 }, { unique: true });

const grantSchema = new Schema<FileGrant>({
  path: { type: String, required: true, immutable: true },
  kind: { type: String, enum: GRANT_KINDS, required: true, immutable: true },
  model: { type: String, required: true, immutable: true },
  resourceId: { type: String, required: true, immutable: true },
  field: { type: String, required: true, immutable: true },
  source: { type: String, enum: ['attach', 'legacy_manifest'], required: true, immutable: true },
  state: { type: String, enum: ['active', 'revoked'], required: true },
  gen: { type: Number, required: true, min: 1 },
  createdByType: { type: String, required: true, immutable: true },
  createdById: { type: String, required: true, immutable: true },
  createdAt: { type: Date, required: true, immutable: true },
}, { ...options, collection: 'file_grants' });
grantSchema.index({ path: 1, model: 1, resourceId: 1, field: 1 }, { unique: true });
grantSchema.index({ path: 1, state: 1, kind: 1 });

export const FileUploadModel = model<FileUpload>('FileUpload', uploadSchema);
export const FileGrantModel = model<FileGrant>('FileGrant', grantSchema);
