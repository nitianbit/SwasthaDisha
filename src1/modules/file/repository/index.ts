import { Service } from 'typedi';
import { ClientSession, Connection, FilterQuery, Types } from 'mongoose';
import BookingModel from '@/modules/bookings/model';
import ExternalBookingModel from '@/modules/externalBookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { ExternalBookingRepository } from '@/modules/externalBookings/repository';
import { FileAssetModel, FileAssetVersionModel, FileDocumentAuditModel } from '../model';
import { DocumentAudit, DocumentScope, FileAsset, FileVersion, ReleaseInput, ReleaseResult, ValidationInput, ValidationResult } from '../documentTypes';
import { assertAsset, assertVersion, documentError } from '../validation';

/** Explicit composition port. No request/env boolean or schema declaration supplies index readiness.
 * An independently admitted adapter must observe the exact three collections/indexes on THIS connection.
 * No scanner, release policy or production index observer has been admitted by this source increment.
 */
@Service()
export class FileDocumentPolicy {
  async assertObservedIndexReadiness(_connection: Connection, _collections: readonly string[]): Promise<void> {
    throw documentError();
  }
  async evaluateValidation(_input: ValidationInput): Promise<ValidationResult> {
    return { decision: 'unavailable', evidenceRef: null };
  }
  async evaluateRelease(_input: ReleaseInput): Promise<ReleaseResult> {
    return { decision: 'unavailable', evidenceRef: null };
  }
}

interface Transaction { readonly session: ClientSession }
function scalar(fields: Record<string, string>): Record<string, unknown> {
  return { $and: Object.entries(fields).map(([field, type]) => ({ $eq: [{ $type: '$' + field }, type] })) };
}
function assetScope(a: FileAsset): FilterQuery<FileAsset> {
  return { _id: a._id, ownerUserId: { $eq: a.ownerUserId }, resourceKind: a.resourceKind, resourceId: a.resourceId,
    identityKey: a.identityKey, purpose: a.purpose, revision: a.revision, revokedAt: null,
    $expr: { $and: [scalar({ _id: 'objectId', ownerUserId: 'string', resourceKind: 'string', resourceId: 'string', identityKey: 'string' }),
      { $isNumber: '$revision' }] } };
}

@Service()
export class FileDocumentRepository {
  private readonly activeSessions = new WeakSet<ClientSession>();
  constructor(private bookings: BookingRepository, private externalBookings: ExternalBookingRepository, private policy: FileDocumentPolicy) {}

  private connection(): Connection {
    const connection = FileAssetModel.db;
    if (connection !== FileAssetVersionModel.db || connection !== FileDocumentAuditModel.db || connection !== BookingModel.db || connection !== ExternalBookingModel.db) throw documentError();
    return connection;
  }
  async ready(): Promise<void> {
    await this.policy.assertObservedIndexReadiness(this.connection(), Object.freeze([
      FileAssetModel.collection.name, FileAssetVersionModel.collection.name, FileDocumentAuditModel.collection.name,
    ]));
  }
  private session(tx: Transaction): ClientSession {
    if (!tx || !this.activeSessions.has(tx.session) || !tx.session.inTransaction()) throw documentError();
    return tx.session;
  }
  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const connection = this.connection();
    const session = await connection.startSession();
    this.activeSessions.add(session);
    try {
      let result: T | undefined;
      await session.withTransaction(async () => { result = await work(Object.freeze({ session })); },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      if (result === undefined) throw documentError();
      return result;
    } finally {
      this.activeSessions.delete(session);
      await session.endSession();
    }
  }
  async ownedResource(scope: DocumentScope, tx?: Transaction): Promise<void> {
    if (scope.resourceKind === 'unbound_upload') {
      if (scope.resourceId !== scope.ownerUserId) throw documentError();
      return;
    }
    this.connection();
    const query = { _id: new Types.ObjectId(scope.resourceId), userId: { $eq: scope.ownerUserId },
      $expr: scalar({ _id: 'objectId', userId: 'string' }) };
    const session = tx ? this.session(tx) : undefined;
    const row = scope.resourceKind === 'booking'
      ? await this.bookings.findOne(query, session)
      : await this.externalBookings.findOne(query, session);
    if (!row) throw documentError(404, 'DOCUMENT_NOT_FOUND');
    if (!(row._id instanceof Types.ObjectId) || row._id.toHexString() !== scope.resourceId || row.userId !== scope.ownerUserId) throw documentError();
  }
  async currentScope(a: FileAsset, tx?: Transaction): Promise<void> {
    try { await this.ownedResource(a, tx); } catch (error) {
      if ((error as { code?: string }).code === 'DOCUMENT_NOT_FOUND') throw documentError(503, 'DOCUMENT_SCOPE_CHANGED');
      throw error;
    }
  }
  async ownedAsset(id: string, owner: string, tx?: Transaction, allowRevoked = false): Promise<FileAsset> {
    const row = await FileAssetModel.findOne({ _id: new Types.ObjectId(id), ownerUserId: { $eq: owner },
      ...(allowRevoked ? {} : { revokedAt: null }), $expr: scalar({ _id: 'objectId', ownerUserId: 'string' }) })
      .session(tx ? this.session(tx) : null).maxTimeMS(2000).lean().exec();
    if (!row) throw documentError(404, 'DOCUMENT_NOT_FOUND');
    const a = row as unknown as FileAsset; assertAsset(a);
    if (a.ownerUserId !== owner || a._id.toHexString() !== id) throw documentError();
    await this.currentScope(a, tx);
    return a;
  }
  async assetByIdentity(candidate: FileAsset, tx: Transaction): Promise<FileAsset | null> {
    const row = await FileAssetModel.findById(candidate._id).session(this.session(tx)).maxTimeMS(2000).lean().exec();
    if (!row) return null;
    const a = row as unknown as FileAsset; assertAsset(a);
    if (a.identityKey !== candidate.identityKey || a.ownerUserId !== candidate.ownerUserId || a.resourceKind !== candidate.resourceKind ||
      a.resourceId !== candidate.resourceId || a.sourceSystem !== candidate.sourceSystem ||
      a.sourceDocumentReference !== candidate.sourceDocumentReference || a.purpose !== candidate.purpose || a.revokedAt !== null) {
      throw documentError(409, 'DOCUMENT_VERSION_CONFLICT');
    }
    await this.currentScope(a, tx);
    return a;
  }
  async insertAsset(a: FileAsset, tx: Transaction): Promise<void> {
    await FileAssetModel.create([a], { session: this.session(tx) });
  }
  async version(a: FileAsset, id: string, tx?: Transaction): Promise<FileVersion> {
    const row = await FileAssetVersionModel.findOne({ _id: new Types.ObjectId(id), assetId: { $eq: a._id },
      $expr: scalar({ _id: 'objectId', assetId: 'objectId' }) }).session(tx ? this.session(tx) : null).maxTimeMS(2000).lean().exec();
    if (!row) throw documentError(404, 'DOCUMENT_NOT_FOUND');
    const v = row as unknown as FileVersion; assertVersion(a, v); return v;
  }
  async duplicate(a: FileAsset, key: string, tx: Transaction): Promise<FileVersion | null> {
    const row = await FileAssetVersionModel.findOne({ assetId: { $eq: a._id }, versionKey: key,
      $expr: scalar({ _id: 'objectId', assetId: 'objectId', versionKey: 'string' }) })
      .session(this.session(tx)).maxTimeMS(2000).lean().exec();
    if (!row) return null;
    const v = row as unknown as FileVersion; assertVersion(a, v); return v;
  }
  async versions(a: FileAsset, limit: number, after?: string): Promise<FileVersion[]> {
    const rows = await FileAssetVersionModel.find({ assetId: { $eq: a._id }, ...(after ? { _id: { $lt: new Types.ObjectId(after) } } : {}),
      $expr: scalar({ _id: 'objectId', assetId: 'objectId' }) }).sort({ _id: -1 }).limit(limit + 1).maxTimeMS(2000).lean().exec();
    if (rows.length > limit + 1) throw documentError();
    return rows.map(row => { const v = row as unknown as FileVersion; assertVersion(a, v); return v; });
  }
  async insertVersion(v: FileVersion, tx: Transaction): Promise<void> {
    await FileAssetVersionModel.create([v], { session: this.session(tx) });
  }
  async pointer(a: FileAsset, changes: { currentCapturedVersionId?: Types.ObjectId; currentReadableVersionId?: Types.ObjectId | null; revokedAt?: Date }, tx: Transaction): Promise<FileAsset> {
    if (a.revision >= Number.MAX_SAFE_INTEGER) throw documentError(409, 'DOCUMENT_VERSION_CONFLICT');
    const row = await FileAssetModel.findOneAndUpdate(assetScope(a), { $set: changes, $inc: { revision: 1 } },
      { session: this.session(tx), new: true, runValidators: true }).lean().exec();
    if (!row) throw documentError(409, 'DOCUMENT_VERSION_CONFLICT');
    const updated = row as unknown as FileAsset; assertAsset(updated); return updated;
  }
  async transition(a: FileAsset, v: FileVersion, changes: { validation?: FileVersion['validation']; publication?: FileVersion['publication'] }, tx: Transaction): Promise<FileVersion> {
    if (v.stateRevision >= Number.MAX_SAFE_INTEGER) throw documentError(409, 'DOCUMENT_VERSION_CONFLICT');
    const row = await FileAssetVersionModel.findOneAndUpdate({ _id: v._id, assetId: { $eq: a._id },
      contentSha256: v.contentSha256, stateRevision: v.stateRevision, 'validation.state': v.validation.state, 'publication.state': v.publication.state,
      $expr: { $and: [scalar({ _id: 'objectId', assetId: 'objectId', contentSha256: 'string', 'validation.state': 'string', 'publication.state': 'string' }), { $isNumber: '$stateRevision' }] } },
      { $set: changes, $inc: { stateRevision: 1 } }, { session: this.session(tx), new: true, runValidators: true }).lean().exec();
    if (!row) throw documentError(409, 'DOCUMENT_VERSION_CONFLICT');
    const updated = row as unknown as FileVersion; assertVersion(a, updated); return updated;
  }
  async audit(row: DocumentAudit, tx: Transaction): Promise<void> {
    await FileDocumentAuditModel.create([row], { session: this.session(tx) });
  }
  async revokeReceipt(operationId: string, tx: Transaction): Promise<DocumentAudit | null> {
    return await FileDocumentAuditModel.findOne({ operationId, phase: 'revoke' }).session(this.session(tx)).maxTimeMS(2000).lean().exec() as unknown as DocumentAudit | null;
  }
}
