import { Service } from 'typedi';
import { ClientSession, Model, PipelineStage, Types, mongo } from 'mongoose';
import { createHash } from 'crypto';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import {
  IPharmacyOrder, OrderQueryParams, PharmacyRecoveryReceipt, PharmacyRecoveryRequest,
  PharmacyRecoveryWorklistPage, PharmacyRecoveryWorklistRow,
  PHARMACY_RECOVERY_ORDER_LABELS, PHARMACY_RECOVERY_PAYMENT_LABELS,
} from '@/modules/pharmacyOrders/types';
import { AppError } from '@/modules/common/types';
import { BaseRepository } from '@/modules/common/repository';

const recoveryProjection = {
  _id: 1, customerId: 1, pharmacyId: 1, status: 1, paymentStatus: 1,
  paymentTransactionId: 1, recoveryRequest: 1,
};
const recoveryId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{24}$/.test(value);
const recoveryUnavailable = (): never => {
  throw new AppError({ status: 503, code: 'PHARMACY_RECOVERY_UNAVAILABLE', message: 'Pharmacy recovery is unavailable' });
};
const recoveryShape = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return recoveryUnavailable();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || !own.every(key => typeof key === 'string' && keys.includes(key) &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    'value' in Object.getOwnPropertyDescriptor(value, key)!)) return recoveryUnavailable();
  return value as Record<string, unknown>;
};
const recoveryDigest = (value: unknown[]): string => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const recoveryPayloadDigest = (id: string, customerId: string): string => recoveryDigest([
  'pharmacy-customer-recovery', 1, 'customer_recovery_request', ['orderId', id], ['requestingCustomerId', customerId],
]);
const recoveryObservationDigest = (epoch: number, observation: Record<string, unknown>): string => recoveryDigest([
  'pharmacy-recovery-observation', 1, ['requestedAt', epoch],
  ['orderStatusLabel', observation.orderStatusLabel], ['paymentStatusLabel', observation.paymentStatusLabel],
  ['paymentRecordId', observation.paymentRecordId], ['paymentRecordReferenceState', observation.paymentRecordReferenceState],
]);

function recoveryReceipt(value: unknown, id: string, customerId: string): PharmacyRecoveryReceipt {
  const record = recoveryShape(value, ['schemaVersion', 'operationKind', 'operationId', 'requestingCustomerId', 'orderId',
    'status', 'requestedAt', 'observation', 'amountMinor', 'currency', 'instrument', 'destinationPolicy', 'payloadSha256', 'observationSha256']);
  const observation = recoveryShape(record.observation, ['orderStatusLabel', 'paymentStatusLabel', 'paymentRecordId', 'paymentRecordReferenceState']);
  const date = record.requestedAt;
  const epoch = date instanceof Date ? date.getTime() : NaN;
  if (record.schemaVersion !== 1 || record.operationKind !== 'customer_recovery_request' ||
    record.operationId !== 'pharmacy-recovery-request:v1:' + id || record.orderId !== id || record.requestingCustomerId !== customerId ||
    record.status !== 'reconciliation_required' || record.amountMinor !== null || record.currency !== null ||
    record.instrument !== 'unknown' || record.destinationPolicy !== 'original_instrument' ||
    !Number.isSafeInteger(epoch) || epoch < 0 || epoch > 8640000000000000 ||
    !PHARMACY_RECOVERY_ORDER_LABELS.some(label => label === observation.orderStatusLabel) ||
    !PHARMACY_RECOVERY_PAYMENT_LABELS.some(label => label === observation.paymentStatusLabel) ||
    (observation.paymentRecordReferenceState === 'recorded'
      ? !recoveryId(observation.paymentRecordId)
      : !['missing', 'malformed'].includes(observation.paymentRecordReferenceState as string) || observation.paymentRecordId !== null) ||
    record.payloadSha256 !== recoveryPayloadDigest(id, customerId) ||
    record.observationSha256 !== recoveryObservationDigest(epoch, observation)) return recoveryUnavailable();
  return {
    operationId: record.operationId as string, status: 'reconciliation_required', requestedAt: (date as Date).toISOString(),
    amountMinor: null, currency: null, instrument: 'unknown', destinationPolicy: 'original_instrument',
  };
}

@Service()
export class PharmacyOrderRepository extends BaseRepository<IPharmacyOrder> {
  constructor() {
    super(PharmacyOrderModel as Model<IPharmacyOrder>);
  }

  private assertRecoverySession(session: ClientSession, expectedTransaction?: unknown): unknown {
    const Session = mongo.ClientSession;
    const held = session as unknown as { client?: unknown; transaction?: { options?: { readConcern?: { level?: unknown } } } };
    if (typeof Session !== 'function' || !(session instanceof Session) || held.client !== PharmacyOrderModel.db.getClient() ||
      !session.inTransaction() || held.transaction?.options?.readConcern?.level !== 'snapshot' ||
      (expectedTransaction !== undefined && held.transaction !== expectedTransaction)) return recoveryUnavailable();
    return held.transaction;
  }

  private async readCustomerRecoveryOrder(id: string, customerId: string, session: ClientSession): Promise<{ row: Record<string, unknown>; transaction: unknown }> {
    if (!recoveryId(customerId)) throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    if (!recoveryId(id)) throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid pharmacy order ID' });
    const transaction = this.assertRecoverySession(session);
    const row = await PharmacyOrderModel.findOne({
      _id: new Types.ObjectId(id), customerId: new Types.ObjectId(customerId),
      $expr: { $and: [{ $eq: [{ $type: '$_id' }, 'objectId'] }, { $eq: [{ $type: '$customerId' }, 'objectId'] }] },
    }).select(recoveryProjection).session(session).maxTimeMS(2000).lean().exec();
    this.assertRecoverySession(session, transaction);
    if (!row) throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    const record = row as unknown as Record<string, unknown>;
    if (!(record._id instanceof Types.ObjectId) || record._id.toHexString() !== id ||
      !(record.customerId instanceof Types.ObjectId) || record.customerId.toHexString() !== customerId ||
      !(record.pharmacyId instanceof Types.ObjectId)) return recoveryUnavailable();
    return { row: record, transaction };
  }

  async getCustomerRecovery(id: string, customerId: string, session: ClientSession): Promise<PharmacyRecoveryReceipt | null> {
    const { row } = await this.readCustomerRecoveryOrder(id, customerId, session);
    return Object.prototype.hasOwnProperty.call(row, 'recoveryRequest') ? recoveryReceipt(row.recoveryRequest, id, customerId) : null;
  }

  async requestCustomerRecovery(id: string, customerId: string, session: ClientSession): Promise<PharmacyRecoveryReceipt> {
    const { row, transaction } = await this.readCustomerRecoveryOrder(id, customerId, session);
    this.assertRecoverySession(session, transaction);
    if (Object.prototype.hasOwnProperty.call(row, 'recoveryRequest')) return recoveryReceipt(row.recoveryRequest, id, customerId);
    const reference = row.paymentTransactionId;
    const observation = {
      orderStatusLabel: PHARMACY_RECOVERY_ORDER_LABELS.find(label => label === row.status) ?? 'unknown',
      paymentStatusLabel: PHARMACY_RECOVERY_PAYMENT_LABELS.find(label => label === row.paymentStatus) ?? 'unknown',
      paymentRecordId: recoveryId(reference) ? reference : null,
      paymentRecordReferenceState: recoveryId(reference) ? 'recorded' as const : reference === undefined || reference === null ? 'missing' as const : 'malformed' as const,
    };
    const requestedAt = new Date();
    const request: PharmacyRecoveryRequest = {
      schemaVersion: 1, operationKind: 'customer_recovery_request', operationId: 'pharmacy-recovery-request:v1:' + id,
      requestingCustomerId: customerId, orderId: id, status: 'reconciliation_required', requestedAt, observation,
      amountMinor: null, currency: null, instrument: 'unknown', destinationPolicy: 'original_instrument',
      payloadSha256: recoveryPayloadDigest(id, customerId),
      observationSha256: recoveryObservationDigest(requestedAt.getTime(), observation),
    };
    recoveryReceipt(request, id, customerId);
    this.assertRecoverySession(session, transaction);
    const updated = await PharmacyOrderModel.findOneAndUpdate({
      _id: new Types.ObjectId(id), customerId: new Types.ObjectId(customerId), recoveryRequest: { $exists: false },
      $expr: { $and: [{ $eq: [{ $type: '$_id' }, 'objectId'] }, { $eq: [{ $type: '$customerId' }, 'objectId'] }] },
    }, { $set: { recoveryRequest: request } }, { session, new: true, upsert: false, runValidators: true, projection: recoveryProjection, maxTimeMS: 2000 }).lean().exec();
    this.assertRecoverySession(session, transaction);
    if (updated) {
      const current = updated as unknown as Record<string, unknown>;
      if (!(current._id instanceof Types.ObjectId) || current._id.toHexString() !== id ||
        !(current.customerId instanceof Types.ObjectId) || current.customerId.toHexString() !== customerId) return recoveryUnavailable();
      return recoveryReceipt(current.recoveryRequest, id, customerId);
    }
    const { row: current } = await this.readCustomerRecoveryOrder(id, customerId, session);
    this.assertRecoverySession(session, transaction);
    if (!Object.prototype.hasOwnProperty.call(current, 'recoveryRequest')) return recoveryUnavailable();
    return recoveryReceipt(current.recoveryRequest, id, customerId);
  }

  async findRecoveryRequests(pharmacyId: unknown, query: unknown): Promise<PharmacyRecoveryWorklistPage> {
    if (!recoveryId(pharmacyId)) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
    const invalidQuery = () => new AppError({
      status: 400, code: 'VALIDATION_ERROR', message: 'Invalid recovery worklist query',
    });
    if (!query || typeof query !== 'object' || Array.isArray(query) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(query))) throw invalidQuery();
    for (const key of Reflect.ownKeys(query)) {
      const descriptor = Object.getOwnPropertyDescriptor(query, key)!;
      if (typeof key !== 'string' || !['page', 'limit'].includes(key) ||
        !descriptor.enumerable || !('value' in descriptor)) throw invalidQuery();
    }
    const requestedPage = Object.getOwnPropertyDescriptor(query, 'page')?.value;
    const requestedLimit = Object.getOwnPropertyDescriptor(query, 'limit')?.value;
    const page = requestedPage === undefined ? 1 : requestedPage;
    const limit = requestedLimit === undefined ? 20 : requestedLimit;
    if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > 1000 ||
      typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw invalidQuery();
    const skip = (page - 1) * limit;
    const pipeline: PipelineStage[] = [
      {
        $match: {
          pharmacyId: new Types.ObjectId(pharmacyId),
          recoveryRequest: { $exists: true },
          $expr: { $eq: [{ $type: '$pharmacyId' }, 'objectId'] },
        },
      },
      { $project: { _id: 1, pharmacyId: 1, customerId: 1, recoveryRequest: 1 } },
      {
        $facet: {
          metadata: [{ $count: 'total' }],
          data: [{ $sort: { _id: 1 } }, { $skip: skip }, { $limit: limit }],
        },
      },
    ];
    const result = await PharmacyOrderModel.aggregate<unknown>(pipeline)
      .option({ maxTimeMS: 2000, allowDiskUse: false }).exec();
    if (!Array.isArray(result) || result.length !== 1) return recoveryUnavailable();
    const facet = recoveryShape(result[0], ['metadata', 'data']);
    const metadata = facet.metadata;
    const rows = facet.data;
    if (!Array.isArray(metadata) || metadata.length > 1 || !Array.isArray(rows) || rows.length > limit) return recoveryUnavailable();
    let total = 0;
    if (metadata.length) {
      const count = recoveryShape(metadata[0], ['total']);
      if (typeof count.total !== 'number' || !Number.isSafeInteger(count.total) || count.total < 0) return recoveryUnavailable();
      total = count.total;
    }
    if (rows.length !== Math.min(limit, Math.max(0, total - skip))) return recoveryUnavailable();
    const data = rows.map((value: unknown): PharmacyRecoveryWorklistRow => {
      const row = recoveryShape(value, ['_id', 'pharmacyId', 'customerId', 'recoveryRequest']);
      if (!(row._id instanceof Types.ObjectId) || !(row.customerId instanceof Types.ObjectId) ||
        !(row.pharmacyId instanceof Types.ObjectId) || row.pharmacyId.toHexString() !== pharmacyId) return recoveryUnavailable();
      const orderId = row._id.toHexString();
      const receipt = recoveryReceipt(row.recoveryRequest, orderId, row.customerId.toHexString());
      return {
        orderId,
        operationId: receipt.operationId,
        status: receipt.status,
        requestedAt: receipt.requestedAt,
        amountMinor: receipt.amountMinor,
        currency: receipt.currency,
        instrument: receipt.instrument,
        destinationPolicy: receipt.destinationPolicy,
      };
    });
    return { data, page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  private applyCommonFilters(query: Record<string, unknown>, filter: OrderQueryParams): Record<string, unknown> {
    const effectiveCustomerId = filter.userId || filter.customerId;
    if (effectiveCustomerId) {
      query.customerId = effectiveCustomerId;
    }
    if (filter.buyerPharmacyId) {
      query.buyerPharmacyId = filter.buyerPharmacyId;
    }
    if (filter.orderType) {
      query.orderType = filter.orderType;
    }
    if (filter.orderFor === 'consultation') {
      query.linkedConsultationId = { $exists: true, $ne: null };
    }
    if (filter.orderFor === 'diagnostic') {
      query.linkedDiagnosticOrderId = { $exists: true, $nin: [null, ''] };
    }
    if (filter.status) query.status = filter.status;
    if (filter.paymentStatus) query.paymentStatus = filter.paymentStatus;
    if (filter.prescriptionStatus) query.prescriptionStatus = filter.prescriptionStatus;

    return query;
  }

  private buildAdminQuery(filter: OrderQueryParams): Record<string, unknown> {
    const query: Record<string, unknown> = {};

    if (filter.pharmacyId) {
      query.pharmacyId = filter.pharmacyId;
    }

    return this.applyCommonFilters(query, filter);
  }

  private buildPharmacyViewerQuery(filter: OrderQueryParams): Record<string, unknown> {
    const query: Record<string, unknown> = {
      $or: [
        { pharmacyId: filter.viewerPharmacyId },
        { buyerPharmacyId: filter.viewerPharmacyId },
      ],
    };

    return this.applyCommonFilters(query, filter);
  }

  private buildUserQuery(filter: OrderQueryParams): Record<string, unknown> {
    return this.applyCommonFilters({}, filter);
  }

  private buildQuery(filter: OrderQueryParams): Record<string, unknown> {
    if (filter.viewerPharmacyId) {
      return this.buildPharmacyViewerQuery(filter);
    }

    if (filter.userId || filter.customerId) {
      return this.buildUserQuery(filter);
    }

    return this.buildAdminQuery(filter);
  }

  async findWithPagination(
    filter: OrderQueryParams,
    page: number = 1,
    limit: number = 20
  ): Promise<{ data: IPharmacyOrder[]; total: number; page: number; totalPages: number }> {
    const query = this.buildQuery(filter);

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      PharmacyOrderModel.find(query)
        .populate('customerId', 'name phone')
        .populate('buyerPharmacyId', 'name phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PharmacyOrderModel.countDocuments(query),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async findByCustomer(customerId: string, page = 1, limit = 20) {
    return this.findWithPagination({ customerId }, page, limit);
  }

  async findStalePendingOnlineOrders(
    cutoff: Date,
    limit = 200
  ): Promise<IPharmacyOrder[]> {
    const rows = await PharmacyOrderModel.find({
      orderType: 'online',
      paymentMode: 'online_payment',
      paymentStatus: 'pending',
      status: 'placed',
      createdAt: { $lt: cutoff },
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean()
      .exec();

    return rows as IPharmacyOrder[];
  }
}
