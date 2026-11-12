import { FileHandle } from 'fs/promises';
import { Types } from 'mongoose';

export const DOCUMENT_BYTES = 10 * 1024 * 1024;
export const PRIVATE_SUBTREE = '__private_assets_v1';
export type ResourceKind = 'unbound_upload' | 'booking' | 'external_booking';
export type Purpose = 'private_attachment' | 'clinical_document' | 'public_image';
export type MediaType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';
export type Source = 'owned_upload' | 'labstack' | 'healthians' | 'legacy_import';
export type Label = { kind: 'unknown' } | { kind: 'recorded'; value: string };
export interface DocumentActor { _id: string; userType: 'user' }
export interface DocumentScope { resourceKind: ResourceKind; resourceId: string; ownerUserId: string }
export interface AssetIdentity extends DocumentScope { sourceSystem: Source; sourceDocumentReference: string }
export interface FileAsset extends AssetIdentity {
  _id: Types.ObjectId; schemaVersion: 1; identityKey: string; purpose: Purpose;
  createdByUserId: string; createdAt: Date; revision: number;
  currentCapturedVersionId: Types.ObjectId | null; currentReadableVersionId: Types.ObjectId | null; revokedAt: Date | null;
}
export interface FileVersion {
  _id: Types.ObjectId; assetId: Types.ObjectId; identityKey: string; versionKey: string;
  storageKey: string; contentSha256: string; actualSize: number; mediaType: MediaType;
  sourceSystem: Source; sourceDocumentReference: string; sourceVersionLabel: Label; sourceStageLabel: Label;
  completeness: 'preliminary' | 'final' | 'unknown'; amendsVersionId: Types.ObjectId | null; amendmentReason: string | null;
  capturedAt: Date; createdByUserId: string; stateRevision: number;
  validation: { state: 'quarantined' | 'validated' | 'rejected'; evidenceRef: string | null };
  publication: { state: 'unreleased' | 'released' | 'legacy_access_unknown'; evidenceRef: string | null };
}
export type AuditPhase = 'capture' | 'validation' | 'release' | 'read_admitted' | 'read_finished' | 'revoke';
export type AuditOutcome = 'captured' | 'validated' | 'rejected' | 'released' | 'admitted' | 'completed' | 'disconnected' | 'failed' | 'revoked';
export interface DocumentAudit {
  resourceKind: ResourceKind; resourceId: string;
  operationId: string; phase: AuditPhase; actorUserId: string; assetId: Types.ObjectId; versionId: Types.ObjectId | null;
  outcome: AuditOutcome; createdAt: Date; correlationId: string; byteCount: number | null;
}
export interface VersionDTO {
  assetId: string; versionId: string; resourceKind: ResourceKind; resourceId: string; purpose: Purpose;
  mediaType: MediaType; byteLength: number; capturedAt: string; completeness: FileVersion['completeness'];
  validationState: FileVersion['validation']['state']; publicationState: FileVersion['publication']['state'];
  isCurrentReadable: boolean; contentUrl: string | null;
}
export interface CapturedObject { storageKey: string; contentSha256: string; actualSize: number; mediaType: MediaType }
export interface VerifiedObject { handle: FileHandle; size: number; mediaType: MediaType; identity: string }
export interface ValidationInput {
  assetId: string; versionId: string; contentSha256: string; actualSize: number; mediaType: MediaType;
  // Positioned, bounded reads of the verified held descriptor; no raw descriptor/path escape.
  read: (position: number, length: number) => Promise<Buffer>;
}
export interface ReleaseInput extends DocumentScope {
  assetId: string; versionId: string; contentSha256: string; expectedAssetRevision: number; expectedStateRevision: number;
}
export interface ValidationResult { decision: 'validated' | 'rejected' | 'unavailable'; evidenceRef: string | null }
export interface ReleaseResult { decision: 'eligible' | 'denied' | 'unavailable'; evidenceRef: string | null }
