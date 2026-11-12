import { createHash } from 'crypto';
import { types } from 'util';
import { Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { AssetIdentity, DOCUMENT_BYTES, DocumentActor, FileAsset, FileVersion, Label, MediaType, VersionDTO } from '../documentTypes';

export function documentError(status = 503, code = 'DOCUMENT_STORAGE_UNAVAILABLE'): AppError {
  const message = status === 404 ? 'Document not found' : status === 400 ? 'Invalid document input' :
    status === 403 ? 'Document access is not permitted' : status === 409 ? 'Document version changed' :
    status === 413 ? 'Document exceeds the size limit' : status === 415 ? 'Unsupported document media' : 'Document is unavailable';
  return new AppError({ status, code, message });
}
export function input(ok: unknown): asserts ok { if (!ok) throw documentError(400, 'DOCUMENT_INPUT_INVALID'); }
export function closed(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  input(value !== null && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value));
  const object = value as object;
  input(Object.getPrototypeOf(object) === Object.prototype || Object.getPrototypeOf(object) === null);
  const descriptors = Object.getOwnPropertyDescriptors(object);
  input(Reflect.ownKeys(descriptors).every(key => typeof key === 'string' && allowed.includes(key) && 'value' in descriptors[key]));
  return object as Record<string, unknown>;
}
export function objectId(value: unknown): string {
  input(typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value));
  return (value as string).toLowerCase();
}
export function uuid(value: unknown): string {
  input(typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
  return value as string;
}
export function actor(value: unknown): DocumentActor {
  if (!value || typeof value !== 'object' || types.isProxy(value)) throw documentError(403, 'DOCUMENT_ACTOR_FORBIDDEN');
  const d = Object.getOwnPropertyDescriptors(value);
  if (!d._id || !('value' in d._id) || !d.userType || !('value' in d.userType) || d.userType.value !== 'user') {
    throw documentError(403, 'DOCUMENT_ACTOR_FORBIDDEN');
  }
  return { _id: objectId(d._id.value), userType: 'user' };
}
export function revision(value: unknown): number {
  input(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER);
  return value as number;
}
export function opaque(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 1 && Buffer.byteLength(value, 'utf8') <= 256 &&
    !/[\x00-\x1f\x7f]/.test(value) && value.trim() === value;
}
function label(value: Label): Label {
  if (value && value.kind === 'unknown' && Object.keys(value).length === 1) return { kind: 'unknown' };
  if (value && value.kind === 'recorded' && opaque(value.value) && Object.keys(value).length === 2) return { kind: 'recorded', value: value.value };
  throw documentError();
}
export function assetKey(identity: AssetIdentity): string {
  return hash(JSON.stringify(['sd-file-asset:v1', identity.resourceKind, identity.resourceId, identity.ownerUserId,
    identity.sourceSystem, identity.sourceDocumentReference]));
}
export function versionKey(v: Pick<FileVersion, 'assetId' | 'contentSha256' | 'completeness' | 'sourceVersionLabel' | 'sourceStageLabel' | 'amendsVersionId' | 'amendmentReason'>): string {
  return hash(JSON.stringify(['sd-file-version:v1', v.assetId.toHexString(), v.contentSha256, v.completeness,
    label(v.sourceVersionLabel), label(v.sourceStageLabel), v.amendsVersionId?.toHexString() ?? null, v.amendmentReason]));
}
export function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function media(header: Buffer): MediaType {
  if (header.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'application/pdf';
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (header.length >= 3 && header[0] === 255 && header[1] === 216 && header[2] === 255) return 'image/jpeg';
  if (header.length >= 12 && header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw documentError(415, 'DOCUMENT_MEDIA_UNSUPPORTED');
}
export function assertAsset(a: FileAsset): void {
  if (a?.purpose === 'public_image') throw documentError(503, 'DOCUMENT_POLICY_UNAVAILABLE');
  if (!a || !(a._id instanceof Types.ObjectId) || a.schemaVersion !== 1 || !['unbound_upload', 'booking', 'external_booking'].includes(a.resourceKind) ||
    typeof a.ownerUserId !== 'string' || !/^[a-f0-9]{24}$/.test(a.ownerUserId) ||
    typeof a.resourceId !== 'string' || !/^[a-f0-9]{24}$/.test(a.resourceId) || typeof a.identityKey !== 'string' || !opaque(a.sourceDocumentReference) ||
    !['owned_upload', 'labstack', 'healthians', 'legacy_import'].includes(a.sourceSystem) ||
    !['private_attachment', 'clinical_document', 'public_image'].includes(a.purpose) || a.identityKey !== assetKey(a) ||
    a._id.toHexString() !== a.identityKey.slice(0, 24) || !Number.isSafeInteger(a.revision) || a.revision < 0 ||
    !(a.createdAt instanceof Date) || !Number.isFinite(a.createdAt.getTime()) || a.createdByUserId !== a.ownerUserId ||
    (a.revokedAt !== null && (!(a.revokedAt instanceof Date) || !Number.isFinite(a.revokedAt.getTime()))) ||
    ![a.currentCapturedVersionId, a.currentReadableVersionId].every(id => id === null || id instanceof Types.ObjectId) ||
    (a.resourceKind === 'unbound_upload') !== (a.purpose === 'private_attachment') ||
    (a.resourceKind === 'unbound_upload' && a.resourceId !== a.ownerUserId)) throw documentError();
}
export function assertVersion(a: FileAsset, v: FileVersion): void {
  if (!v || !(v._id instanceof Types.ObjectId) || !(v.assetId instanceof Types.ObjectId) || !v.assetId.equals(a._id) ||
    v.identityKey !== a.identityKey || typeof v.storageKey !== 'string' || typeof v.versionKey !== 'string' ||
    typeof v.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.contentSha256) || !Number.isSafeInteger(v.actualSize) ||
    v.actualSize < 1 || v.actualSize > DOCUMENT_BYTES || !['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(v.mediaType) ||
    v.sourceSystem !== a.sourceSystem || v.sourceDocumentReference !== a.sourceDocumentReference || v.createdByUserId !== a.ownerUserId ||
    !['preliminary', 'final', 'unknown'].includes(v.completeness) || !(v.capturedAt instanceof Date) || !Number.isFinite(v.capturedAt.getTime()) ||
    !(v.amendsVersionId === null || v.amendsVersionId instanceof Types.ObjectId) || !(v.amendmentReason === null || opaque(v.amendmentReason)) ||
    !Number.isSafeInteger(v.stateRevision) || v.stateRevision < 0 || v.versionKey !== versionKey(v) ||
    !v.validation || !['quarantined', 'validated', 'rejected'].includes(v.validation.state) ||
    (v.validation.state === 'quarantined' && v.validation.evidenceRef !== null) ||
    !v.publication || !['unreleased', 'released', 'legacy_access_unknown'].includes(v.publication.state) ||
    (v.publication.state === 'unreleased' && v.publication.evidenceRef !== null) ||
    (v.validation.state !== 'quarantined' && !opaque(v.validation.evidenceRef)) ||
    (v.publication.state !== 'unreleased' && !opaque(v.publication.evidenceRef)) ||
    !new RegExp('^' + a._id.toHexString() + '/' + v._id.toHexString() + '/[a-f0-9]{64}$').test(v.storageKey)) throw documentError();
}
export function readable(a: FileAsset, v: FileVersion): boolean {
  return a.revokedAt === null && v.validation.state === 'validated' &&
    ((a.purpose === 'private_attachment' && a.resourceKind === 'unbound_upload' && v.publication.state === 'unreleased') ||
     (a.purpose === 'clinical_document' && v.publication.state === 'released'));
}
export function dto(a: FileAsset, v: FileVersion): VersionDTO {
  assertAsset(a); assertVersion(a, v);
  return { assetId: a._id.toHexString(), versionId: v._id.toHexString(), resourceKind: a.resourceKind, resourceId: a.resourceId,
    purpose: a.purpose, mediaType: v.mediaType, byteLength: v.actualSize, capturedAt: v.capturedAt.toISOString(),
    completeness: v.completeness, validationState: v.validation.state, publicationState: v.publication.state,
    isCurrentReadable: a.currentReadableVersionId?.equals(v._id) === true,
    contentUrl: readable(a, v) ? `/api/v1/file/assets/${a._id.toHexString()}/versions/${v._id.toHexString()}/content` : null };
}
