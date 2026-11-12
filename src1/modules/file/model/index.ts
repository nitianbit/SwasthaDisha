import { model, Schema } from 'mongoose';
import { DocumentAudit, FileAsset, FileVersion } from '../documentTypes';

const options = { versionKey: false as const, strict: 'throw' as const, autoIndex: false, autoCreate: false };
const id = Schema.Types.ObjectId;
const assetSchema = new Schema<FileAsset>({
  schemaVersion: { type: Number, required: true, enum: [1], immutable: true },
  identityKey: { type: String, required: true, immutable: true },
  resourceKind: { type: String, enum: ['unbound_upload', 'booking', 'external_booking'], required: true, immutable: true },
  resourceId: { type: String, required: true, immutable: true }, ownerUserId: { type: String, required: true, immutable: true },
  sourceSystem: { type: String, enum: ['owned_upload', 'labstack', 'healthians', 'legacy_import'], required: true, immutable: true }, sourceDocumentReference: { type: String, required: true, immutable: true },
  purpose: { type: String, enum: ['private_attachment', 'clinical_document', 'public_image'], required: true, immutable: true }, createdByUserId: { type: String, required: true, immutable: true },
  createdAt: { type: Date, required: true, immutable: true }, revision: { type: Number, required: true },
  currentCapturedVersionId: { type: id, default: null }, currentReadableVersionId: { type: id, default: null }, revokedAt: { type: Date, default: null },
}, options);
const label = new Schema({ kind: { type: String, required: true, enum: ['unknown', 'recorded'] }, value: String }, { _id: false, strict: 'throw' });
const versionSchema = new Schema<FileVersion>({
  assetId: { type: id, required: true, immutable: true }, identityKey: { type: String, required: true, immutable: true },
  versionKey: { type: String, required: true, immutable: true }, storageKey: { type: String, required: true, immutable: true },
  contentSha256: { type: String, required: true, immutable: true }, actualSize: { type: Number, required: true, immutable: true },
  mediaType: { type: String, enum: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'], required: true, immutable: true }, sourceSystem: { type: String, enum: ['owned_upload', 'labstack', 'healthians', 'legacy_import'], required: true, immutable: true },
  sourceDocumentReference: { type: String, required: true, immutable: true },
  sourceVersionLabel: { type: label, required: true, immutable: true }, sourceStageLabel: { type: label, required: true, immutable: true },
  completeness: { type: String, enum: ['preliminary', 'final', 'unknown'], required: true, immutable: true }, amendsVersionId: { type: id, default: null, immutable: true },
  amendmentReason: { type: String, default: null, immutable: true }, capturedAt: { type: Date, required: true, immutable: true },
  createdByUserId: { type: String, required: true, immutable: true }, stateRevision: { type: Number, required: true },
  validation: { state: { type: String, enum: ['quarantined', 'validated', 'rejected'], required: true }, evidenceRef: { type: String, default: null } },
  publication: { state: { type: String, enum: ['unreleased', 'released', 'legacy_access_unknown'], required: true }, evidenceRef: { type: String, default: null } },
}, options);
const auditSchema = new Schema<DocumentAudit>({
  operationId: { type: String, required: true }, phase: { type: String, required: true }, actorUserId: { type: String, required: true },
  resourceKind: { type: String, required: true }, resourceId: { type: String, required: true },
  assetId: { type: id, required: true }, versionId: { type: id, default: null }, outcome: { type: String, required: true },
  createdAt: { type: Date, required: true }, correlationId: { type: String, required: true }, byteCount: { type: Number, default: null },
}, options);
assetSchema.index({ identityKey: 1 }, { unique: true });
versionSchema.index({ assetId: 1, versionKey: 1 }, { unique: true });
versionSchema.index({ assetId: 1, _id: -1 });
auditSchema.index({ operationId: 1, phase: 1 }, { unique: true });
export const FileAssetModel = model<FileAsset>('FileAsset', assetSchema);
export const FileAssetVersionModel = model<FileVersion>('FileAssetVersion', versionSchema);
export const FileDocumentAuditModel = model<DocumentAudit>('FileDocumentAudit', auditSchema);
