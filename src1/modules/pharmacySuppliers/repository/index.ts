import { Service } from 'typedi';
import { PipelineStage, Types } from 'mongoose';
import PharmacySupplierModel from '@/modules/pharmacySuppliers/model';
import { AppError } from '@/modules/common/types';
import { SUPPLIER_FIELDS, SupplierDto, SupplierPage } from '@/modules/pharmacySuppliers/types';
import {
  assertSupplierBody, assertSupplierId, assertSupplierScope, isSupplierId,
  normalizeSupplierCommand, normalizeSupplierQuery, supplierConflict,
  supplierUnavailable, validStoredSupplierFields,
} from '@/modules/pharmacySuppliers/validation';

const supplierProjection = {
  _id: 1, schemaVersion: 1, pharmacyId: 1, displayName: 1, contactName: 1, phone: 1, email: 1, address: 1,
  state: 1, revision: 1, createdByActorId: 1, updatedByActorId: 1, createdAt: 1, updatedAt: 1, archivedAt: 1,
};
const supplierKeys = Object.keys(supplierProjection);
const validDate = (value: unknown): value is Date => value instanceof Date &&
  Number.isSafeInteger(value.getTime()) && value.getTime() >= 0 && value.getTime() <= 8640000000000000;

function supplierDto(value: unknown, pharmacyId: string, id?: string): SupplierDto {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw supplierUnavailable();
  const row = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(row);
  if (keys.length !== supplierKeys.length || !keys.every(key => typeof key === 'string' && supplierKeys.includes(key) &&
    Object.getOwnPropertyDescriptor(row, key)?.enumerable === true &&
    'value' in Object.getOwnPropertyDescriptor(row, key)!)) throw supplierUnavailable();
  if (!(row._id instanceof Types.ObjectId) || !(row.pharmacyId instanceof Types.ObjectId) ||
    row.pharmacyId.toHexString() !== pharmacyId || (id !== undefined && row._id.toHexString() !== id) ||
    row.schemaVersion !== 1 || !isSupplierId(row.createdByActorId) || !isSupplierId(row.updatedByActorId) ||
    typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1 ||
    (row.state !== 'active' && row.state !== 'archived') || !validDate(row.createdAt) || !validDate(row.updatedAt)) throw supplierUnavailable();
  const archivedAt = row.archivedAt;
  if (archivedAt !== null && !validDate(archivedAt)) throw supplierUnavailable();
  if ((row.state === 'active' && archivedAt !== null) || (row.state === 'archived' && archivedAt === null)) throw supplierUnavailable();
  const fields = { displayName: row.displayName, contactName: row.contactName, phone: row.phone, email: row.email, address: row.address };
  if (!validStoredSupplierFields(fields)) throw supplierUnavailable();
  return {
    supplierId: row._id.toHexString(), displayName: fields.displayName, contactName: fields.contactName,
    phone: fields.phone, email: fields.email, address: fields.address, state: row.state, revision: row.revision,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    archivedAt: archivedAt === null ? null : archivedAt.toISOString(), verificationState: 'not_evaluated',
  };
}

@Service()
export class PharmacySupplierRepository {
  private owned(pharmacyId: string, id: string) {
    return {
      _id: new Types.ObjectId(id), pharmacyId: new Types.ObjectId(pharmacyId),
      $expr: { $and: [
        { $eq: [{ $type: '$_id' }, 'objectId'] },
        { $eq: [{ $type: '$pharmacyId' }, 'objectId'] },
      ] },
    };
  }

  private async getOwned(pharmacyId: string, id: string): Promise<SupplierDto> {
    const row = await PharmacySupplierModel.findOne(this.owned(pharmacyId, id))
      .select(supplierProjection).maxTimeMS(2000).lean().exec();
    if (!row) throw new AppError({ status: 404, code: 'SUPPLIER_NOT_FOUND', message: 'Supplier not found' });
    return supplierDto(row, pharmacyId, id);
  }

  async create(pharmacyId: unknown, actorId: unknown, body: unknown): Promise<SupplierDto> {
    assertSupplierScope(pharmacyId);
    assertSupplierScope(actorId);
    assertSupplierBody(body);
    const command = normalizeSupplierCommand('create', body);
    const now = new Date();
    const row = new PharmacySupplierModel({
      schemaVersion: 1, pharmacyId: new Types.ObjectId(pharmacyId),
      displayName: command.fields.displayName, contactName: command.fields.contactName,
      phone: command.fields.phone, email: command.fields.email, address: command.fields.address,
      state: 'active', revision: 1, createdByActorId: actorId, updatedByActorId: actorId,
      createdAt: now, updatedAt: now, archivedAt: null,
    });
    await row.save();
    return supplierDto(row.toObject(), pharmacyId);
  }

  async update(pharmacyId: unknown, actorId: unknown, id: unknown, body: unknown): Promise<SupplierDto> {
    assertSupplierScope(pharmacyId);
    assertSupplierScope(actorId);
    assertSupplierId(id);
    assertSupplierBody(body);
    const current = await this.getOwned(pharmacyId, id);
    const command = normalizeSupplierCommand('update', body);
    if (current.state === 'archived' || current.revision !== command.expectedRevision) throw supplierConflict();
    const set: Record<string, unknown> = { updatedByActorId: actorId, updatedAt: new Date() };
    for (const field of SUPPLIER_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(command.fields, field)) set[field] = command.fields[field];
    }
    const row = await PharmacySupplierModel.findOneAndUpdate({
      ...this.owned(pharmacyId, id), state: 'active', revision: command.expectedRevision,
      $and: [{ $expr: { $eq: [{ $type: '$state' }, 'string'] } }],
    }, { $set: set, $inc: { revision: 1 } }, { new: true, upsert: false, runValidators: true, projection: supplierProjection, maxTimeMS: 2000 }).lean().exec();
    if (!row) throw supplierConflict();
    return supplierDto(row, pharmacyId, id);
  }

  async archive(pharmacyId: unknown, actorId: unknown, id: unknown, body: unknown): Promise<SupplierDto> {
    assertSupplierScope(pharmacyId);
    assertSupplierScope(actorId);
    assertSupplierId(id);
    assertSupplierBody(body);
    const current = await this.getOwned(pharmacyId, id);
    const command = normalizeSupplierCommand('archive', body);
    if (current.state === 'archived') return current;
    if (current.revision !== command.expectedRevision) throw supplierConflict();
    const now = new Date();
    const row = await PharmacySupplierModel.findOneAndUpdate({
      ...this.owned(pharmacyId, id), state: 'active', revision: command.expectedRevision,
      $and: [{ $expr: { $eq: [{ $type: '$state' }, 'string'] } }],
    }, { $set: { state: 'archived', archivedAt: now, updatedAt: now, updatedByActorId: actorId }, $inc: { revision: 1 } },
    { new: true, upsert: false, runValidators: true, projection: supplierProjection, maxTimeMS: 2000 }).lean().exec();
    if (!row) throw supplierConflict();
    return supplierDto(row, pharmacyId, id);
  }

  async list(pharmacyId: unknown, input: unknown): Promise<SupplierPage> {
    assertSupplierScope(pharmacyId);
    const query = normalizeSupplierQuery(input);
    const { state, page, limit } = query;
    const states = state === 'all' ? ['active', 'archived'] : [state];
    const skip = (page - 1) * limit;
    const pipeline: PipelineStage[] = [
      { $match: {
        pharmacyId: new Types.ObjectId(pharmacyId), state: { $in: states },
        $expr: { $and: [
          { $eq: [{ $type: '$pharmacyId' }, 'objectId'] },
          { $eq: [{ $type: '$state' }, 'string'] },
        ] },
      } },
      { $project: supplierProjection },
      { $facet: { metadata: [{ $count: 'total' }], data: [{ $sort: { _id: 1 } }, { $skip: skip }, { $limit: limit }] } },
    ];
    const result = await PharmacySupplierModel.aggregate<unknown>(pipeline).option({ maxTimeMS: 2000, allowDiskUse: false }).exec();
    const record = (value: unknown, names: string[]): Record<string, unknown> => {
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw supplierUnavailable();
      const keys = Reflect.ownKeys(value);
      if (keys.length !== names.length || !keys.every(key => typeof key === 'string' && names.includes(key) &&
        Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
        'value' in Object.getOwnPropertyDescriptor(value, key)!)) throw supplierUnavailable();
      return value as Record<string, unknown>;
    };
    if (!Array.isArray(result) || result.length !== 1) throw supplierUnavailable();
    const facet = record(result[0], ['metadata', 'data']);
    const metadata = facet.metadata;
    const rows = facet.data;
    if (!Array.isArray(metadata) || metadata.length > 1 || !Array.isArray(rows) || rows.length > limit) throw supplierUnavailable();
    let total = 0;
    if (metadata.length) {
      const count = record(metadata[0], ['total']);
      if (typeof count.total !== 'number' || !Number.isSafeInteger(count.total) || count.total < 0) throw supplierUnavailable();
      total = count.total;
    }
    if (rows.length !== Math.min(limit, Math.max(0, total - skip))) throw supplierUnavailable();
    const data = rows.map(row => supplierDto(row, pharmacyId));
    return { data, state, page, limit, total, totalPages: Math.ceil(total / limit) };
  }
}
