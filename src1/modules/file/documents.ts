import { Service } from 'typedi';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { FileDocumentRepository, FileDocumentPolicy } from './repository';
import { FileDocumentStorage } from './storage';
import { DocumentActor, DocumentAudit, DocumentScope, FileAsset, FileVersion, ValidationResult, VerifiedObject, VersionDTO } from './documentTypes';
import { actor, assetKey, closed, documentError, dto, input, objectId, opaque, readable, revision, uuid, versionKey } from './validation';

function duplicateIdentity(error: unknown): boolean {
  const e = error as { code?: unknown; keyPattern?: unknown };
  if (e?.code !== 11000) return false;
  const pattern = JSON.stringify(e.keyPattern);
  return ['{"_id":1}', '{"identityKey":1}', '{"assetId":1,"versionKey":1}'].includes(pattern);
}
function sameCapture(a: FileVersion, b: FileVersion): boolean {
  return a.assetId.equals(b.assetId) && a.identityKey === b.identityKey && a.versionKey === b.versionKey &&
    a.contentSha256 === b.contentSha256 && a.actualSize === b.actualSize && a.mediaType === b.mediaType &&
    a.sourceSystem === b.sourceSystem && a.sourceDocumentReference === b.sourceDocumentReference && a.completeness === b.completeness &&
    a.sourceVersionLabel.kind === b.sourceVersionLabel.kind &&
    (a.sourceVersionLabel.kind !== 'recorded' || (b.sourceVersionLabel.kind === 'recorded' && a.sourceVersionLabel.value === b.sourceVersionLabel.value)) &&
    a.sourceStageLabel.kind === b.sourceStageLabel.kind &&
    (a.sourceStageLabel.kind !== 'recorded' || (b.sourceStageLabel.kind === 'recorded' && a.sourceStageLabel.value === b.sourceStageLabel.value)) &&
    (a.amendsVersionId?.toHexString() ?? null) === (b.amendsVersionId?.toHexString() ?? null) && a.amendmentReason === b.amendmentReason;
}
function audit(a: FileAsset, actorId: string, operationId: string, phase: DocumentAudit['phase'], outcome: DocumentAudit['outcome'], versionId: Types.ObjectId | null, byteCount: number | null = null): DocumentAudit {
  return { operationId, phase, actorUserId: actorId, resourceKind: a.resourceKind, resourceId: a.resourceId,
    assetId: a._id, versionId, outcome, createdAt: new Date(), correlationId: operationId, byteCount };
}

@Service()
export class FileDocumentService {
  constructor(private repository: FileDocumentRepository, private storage: FileDocumentStorage, private policy: FileDocumentPolicy) {}

  async upload(requestActor: unknown, rawQuery: unknown, kind: unknown, resourceId: unknown, req: Request): Promise<{ created: boolean; data: VersionDTO }> {
    const principal = actor(requestActor);
    const query = closed(rawQuery, ['documentKey']);
    const documentKey = uuid(query.documentKey);
    input(kind === 'unbound_upload' || kind === 'booking' || kind === 'external_booking');
    const scope: DocumentScope = { resourceKind: kind, resourceId: kind === 'unbound_upload' ? principal._id : objectId(resourceId), ownerUserId: principal._id };
    await this.repository.ownedResource(scope);
    await this.repository.ready();
    const identity = { ...scope, sourceSystem: 'owned_upload' as const, sourceDocumentReference: documentKey };
    const key = assetKey(identity);
    const a: FileAsset = { ...identity, _id: new Types.ObjectId(key.slice(0, 24)), schemaVersion: 1, identityKey: key,
      purpose: kind === 'unbound_upload' ? 'private_attachment' : 'clinical_document', createdByUserId: principal._id,
      createdAt: new Date(), revision: 0, currentCapturedVersionId: null, currentReadableVersionId: null, revokedAt: null };
    const versionId = new Types.ObjectId();
    input(typeof req.headers['content-type'] === 'string' && /^multipart\/form-data;/.test(req.headers['content-type']));
    // One immutable file/ID outside retried transaction callbacks. Failed/duplicate files remain private orphans.
    const captured = await this.storage.capture(req, a._id.toHexString(), versionId.toHexString());
    const v: FileVersion = { _id: versionId, assetId: a._id, identityKey: key, versionKey: '', ...captured,
      sourceSystem: identity.sourceSystem, sourceDocumentReference: documentKey, sourceVersionLabel: { kind: 'unknown' }, sourceStageLabel: { kind: 'unknown' },
      completeness: 'unknown', amendsVersionId: null, amendmentReason: null, capturedAt: new Date(), createdByUserId: principal._id,
      stateRevision: 0, validation: { state: 'quarantined', evidenceRef: null }, publication: { state: 'unreleased', evidenceRef: null } };
    v.versionKey = versionKey(v);
    const operationId = randomUUID();
    const capture = async (reconcile: boolean) => {
      this.storage.assertCaptureAdmission(captured, req);
      return this.repository.transaction(async tx => {
        this.storage.assertCaptureAdmission(captured, req);
        await this.repository.ownedResource(scope, tx);
        const existing = await this.repository.assetByIdentity(a, tx);
        if (reconcile && !existing) throw documentError(409, 'DOCUMENT_VERSION_CONFLICT');
        const current = existing ?? a;
        const prior = existing ? await this.repository.duplicate(current, v.versionKey, tx) : null;
        if (prior) {
          if (!sameCapture(prior, v)) throw documentError(409, 'DOCUMENT_VERSION_CONFLICT');
          this.storage.assertCaptureAdmission(captured, req);
          return { created: false, data: dto(current, prior) };
        }
        if (reconcile) throw documentError(409, 'DOCUMENT_VERSION_CONFLICT');
        this.storage.assertCaptureAdmission(captured, req);
        if (!existing) await this.repository.insertAsset(a, tx);
        this.storage.assertCaptureAdmission(captured, req);
        await this.repository.insertVersion(v, tx);
        this.storage.assertCaptureAdmission(captured, req);
        const next = await this.repository.pointer(current, { currentCapturedVersionId: v._id }, tx);
        this.storage.assertCaptureAdmission(captured, req);
        await this.repository.audit(audit(next, principal._id, operationId, 'capture', 'captured', v._id), tx);
        this.storage.assertCaptureAdmission(captured, req);
        return { created: true, data: dto(next, v) };
      });
    };
    try { return await capture(false); } catch (error) {
      // A failed transaction is over before a single fresh bounded read/reconciliation transaction.
      if (!duplicateIdentity(error)) throw error;
      return capture(true);
    }
  }

  async list(requestActor: unknown, assetId: unknown, rawQuery: unknown): Promise<{ assetId: string; versions: VersionDTO[]; nextCursor: string | null }> {
    const principal = actor(requestActor); const id = objectId(assetId); const query = closed(rawQuery, ['limit', 'after']);
    input(query.limit === undefined || (typeof query.limit === 'string' && /^(?:[1-9]|[1-4][0-9]|50)$/.test(query.limit)));
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    const after = query.after === undefined ? undefined : objectId(query.after);
    input(query.after === undefined || query.after === after);
    const a = await this.repository.ownedAsset(id, principal._id);
    await this.repository.ready();
    const rows = await this.repository.versions(a, limit, after);
    const data = rows.slice(0, limit);
    return { assetId: id, versions: data.map(v => dto(a, v)), nextCursor: rows.length > limit ? data[data.length - 1]._id.toHexString() : null };
  }

  async revoke(requestActor: unknown, assetId: unknown, rawBody: unknown): Promise<{ assetId: string; revoked: true; revision: number }> {
    const principal = actor(requestActor); const id = objectId(assetId); const body = closed(rawBody, ['expectedRevision', 'operationId']);
    const expected = revision(body.expectedRevision); const operationId = uuid(body.operationId);
    const before = await this.repository.ownedAsset(id, principal._id, undefined, true);
    if (before.purpose !== 'private_attachment' || before.resourceKind !== 'unbound_upload') throw documentError(503, 'DOCUMENT_POLICY_UNAVAILABLE');
    await this.repository.ready();
    return this.repository.transaction(async tx => {
      const a = await this.repository.ownedAsset(id, principal._id, tx, true);
      const receipt = await this.repository.revokeReceipt(operationId, tx);
      if (receipt) {
        if (!(receipt.assetId instanceof Types.ObjectId) || !receipt.assetId.equals(a._id) || receipt.actorUserId !== principal._id ||
          receipt.resourceKind !== a.resourceKind || receipt.resourceId !== a.resourceId || receipt.versionId !== null ||
          receipt.operationId !== operationId || receipt.phase !== 'revoke' || receipt.outcome !== 'revoked' || receipt.byteCount !== null || !(receipt.createdAt instanceof Date) ||
          !Number.isFinite(receipt.createdAt.getTime()) || receipt.correlationId !== operationId || a.revokedAt === null || expected !== a.revision - 1) throw documentError(409, 'DOCUMENT_VERSION_CONFLICT');
        return { assetId: id, revoked: true as const, revision: a.revision };
      }
      if (a.revokedAt !== null || a.revision !== expected) throw documentError(409, 'DOCUMENT_VERSION_CONFLICT');
      const next = await this.repository.pointer(a, { revokedAt: new Date(), currentReadableVersionId: null }, tx);
      await this.repository.audit(audit(next, principal._id, operationId, 'revoke', 'revoked', null), tx);
      return { assetId: id, revoked: true as const, revision: next.revision };
    });
  }

  /** Internal composition only; no HTTP validation/release endpoint or client evidence boolean. */
  async validateVersion(requestActor: unknown, assetId: unknown, versionId: unknown, expectedAssetRevision: unknown, expectedStateRevision: unknown): Promise<VersionDTO> {
    const principal = actor(requestActor); const id = objectId(assetId); const version = objectId(versionId);
    const ar = revision(expectedAssetRevision); const vr = revision(expectedStateRevision);
    const a = await this.repository.ownedAsset(id, principal._id); await this.repository.ready();
    const v = await this.repository.version(a, version);
    if (a.revision !== ar || v.stateRevision !== vr || v.validation.state !== 'quarantined') throw documentError(409, 'DOCUMENT_VERSION_CONFLICT');
    const verified = await this.storage.verified(v); let active = true;
    let result: ValidationResult;
    try {
      result = await this.policy.evaluateValidation({ assetId: id, versionId: version, contentSha256: v.contentSha256, actualSize: v.actualSize,
        mediaType: v.mediaType, read: async (position, length) => { if (!active) throw documentError(); return this.storage.boundedRead(verified, position, length); } });
    } finally { active = false; await verified.handle.close(); }
    if (result.decision === 'unavailable') throw documentError(503, 'DOCUMENT_POLICY_UNAVAILABLE');
    if (!['validated', 'rejected'].includes(result.decision) || !opaque(result.evidenceRef)) throw documentError();
    const state = result.decision; const evidenceRef = result.evidenceRef; const operationId = randomUUID();
    return this.repository.transaction(async tx => {
      const current = await this.repository.ownedAsset(id, principal._id, tx); const previous = await this.repository.version(current, version, tx);
      if (current.revision !== ar || previous.stateRevision !== vr || previous.contentSha256 !== v.contentSha256 || previous.validation.state !== 'quarantined') {
        throw documentError(409, 'DOCUMENT_VERSION_CONFLICT');
      }
      const next = await this.repository.transition(current, previous, { validation: { state, evidenceRef } }, tx);
      const updated = await this.repository.pointer(current, current.purpose === 'private_attachment' && state === 'validated' ? { currentReadableVersionId: next._id } : {}, tx);
      await this.repository.audit(audit(updated, principal._id, operationId, 'validation', state, next._id), tx);
      return dto(updated, next);
    });
  }

  async releaseVersion(requestActor: unknown, assetId: unknown, versionId: unknown, expectedAssetRevision: unknown, expectedStateRevision: unknown): Promise<VersionDTO> {
    const principal = actor(requestActor); const id = objectId(assetId); const version = objectId(versionId);
    const ar = revision(expectedAssetRevision); const vr = revision(expectedStateRevision);
    const a = await this.repository.ownedAsset(id, principal._id); await this.repository.ready(); const v = await this.repository.version(a, version);
    if (a.revision !== ar || v.stateRevision !== vr) throw documentError(409, 'DOCUMENT_VERSION_CONFLICT');
    if (a.purpose !== 'clinical_document' || v.validation.state !== 'validated' || v.publication.state !== 'unreleased') {
      throw documentError(503, 'DOCUMENT_POLICY_UNAVAILABLE');
    }
    const result = await this.policy.evaluateRelease({ assetId: id, versionId: version, contentSha256: v.contentSha256, resourceKind: a.resourceKind,
      resourceId: a.resourceId, ownerUserId: a.ownerUserId, expectedAssetRevision: ar, expectedStateRevision: vr });
    if (result.decision !== 'eligible') throw documentError(503, 'DOCUMENT_POLICY_UNAVAILABLE');
    if (!opaque(result.evidenceRef)) throw documentError();
    const evidenceRef = result.evidenceRef; const operationId = randomUUID();
    return this.repository.transaction(async tx => {
      const current = await this.repository.ownedAsset(id, principal._id, tx); const previous = await this.repository.version(current, version, tx);
      if (current.revision !== ar || previous.stateRevision !== vr || previous.contentSha256 !== v.contentSha256 ||
        previous.validation.state !== 'validated' || previous.publication.state !== 'unreleased') throw documentError(409, 'DOCUMENT_VERSION_CONFLICT');
      const next = await this.repository.transition(current, previous, { publication: { state: 'released', evidenceRef } }, tx);
      const updated = await this.repository.pointer(current, { currentReadableVersionId: next._id }, tx);
      await this.repository.audit(audit(updated, principal._id, operationId, 'release', 'released', next._id), tx);
      return dto(updated, next);
    });
  }

  async content(requestActor: unknown, assetId: unknown, versionId: unknown, rawQuery: unknown, req: Request, res: Response): Promise<void> {
    const principal: DocumentActor = actor(requestActor); const id = objectId(assetId); const version = objectId(versionId); closed(rawQuery, []);
    const before = await this.repository.ownedAsset(id, principal._id); await this.repository.ready();
    const prior = await this.repository.version(before, version);
    if (!readable(before, prior)) throw documentError(503, 'DOCUMENT_NOT_AVAILABLE');
    if (req.headers.range !== undefined) throw documentError(416, 'DOCUMENT_INPUT_INVALID');
    const operationId = randomUUID();
    const admitted = await this.repository.transaction(async tx => {
      const a = await this.repository.ownedAsset(id, principal._id, tx); const v = await this.repository.version(a, version, tx);
      if (!readable(a, v)) throw documentError(503, 'DOCUMENT_NOT_AVAILABLE');
      await this.repository.audit(audit(a, principal._id, operationId, 'read_admitted', 'admitted', v._id), tx);
      return { a, v };
    });
    let bytes = 0; let outcome: 'completed' | 'failed' | 'disconnected' = 'failed';
    let verified: VerifiedObject | undefined;
    const contentDeadline = performance.now() + 30000;
    try {
      verified = await this.storage.verified(admitted.v, contentDeadline);
      res.setHeader('Content-Type', verified.mediaType); res.setHeader('Content-Length', String(verified.size));
      res.setHeader('Content-Disposition', `attachment; filename="document-${version}"`);
      await this.storage.stream(verified, req, res, n => { bytes = n; }, contentDeadline); outcome = 'completed';
    } catch (error) {
      outcome = req.aborted || res.destroyed ? 'disconnected' : 'failed';
      if (res.headersSent && !res.destroyed) res.destroy();
      if (!res.headersSent) { res.removeHeader('Content-Length'); res.removeHeader('Content-Type'); res.removeHeader('Content-Disposition'); }
      throw error;
    } finally {
      let closeFailed = false;
      if (verified) { try { await verified.handle.close(); } catch { closeFailed = true; outcome = 'failed'; } }
      // This runs even after disconnect/failure; already transmitted bytes are never represented as zero.
      try {
        await this.repository.transaction(async tx => {
          await this.repository.audit(audit(admitted.a, principal._id, operationId, 'read_finished', outcome, admitted.v._id, bytes), tx);
          return true;
        });
      } catch {
        // The durable admitted event remains unresolved. No raw driver/patient details enter this diagnostic.
        process.emitWarning('DOCUMENT_READ_AUDIT_UNRESOLVED');
        throw documentError();
      }
      if (closeFailed) throw documentError();
    }
  }
}
