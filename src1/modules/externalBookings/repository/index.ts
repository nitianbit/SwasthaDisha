import { Service } from 'typedi';
import { Model, PipelineStage, Types } from 'mongoose';
import ExternalBookingModel from '@/modules/externalBookings/model';
import {
  CUSTOMER_DIAGNOSTICS_PROGRESS_STATUSES,
  CustomerDiagnosticsProgress,
  CustomerDiagnosticsHistoryPage,
  ExternalBookingListQuery,
  IExternalBooking,
} from '@/modules/externalBookings/types';
import { BaseRepository } from '@/modules/common/repository';
import { AppError } from '@/modules/common/types';

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toCustomerDiagnosticsProgress(row: Record<string, unknown>, id: string, customerId: string): CustomerDiagnosticsProgress {
  if (
    !(row._id instanceof Types.ObjectId) || row._id.toHexString() !== id ||
    row.userId !== customerId || row.providerType !== 'DIAGNOSTICS'
  ) {
    throw new AppError({ status: 503, code: 'DIAGNOSTICS_PROGRESS_UNAVAILABLE', message: 'Diagnostics booking progress is unavailable' });
  }
  const reference = row.externalBookingId;
  const providerReferenceRecorded = reference === undefined || reference === null
    ? false
    : typeof reference === 'string' && reference.length <= 512
      ? reference.trim().length > 0
      : null;
  const recordedAt = row.updatedAt;
  const epoch = recordedAt instanceof Date ? recordedAt.getTime() : NaN;
  return {
    bookingId: row._id.toHexString(),
    integration: row.integration === 'labstack' || row.integration === 'healthians' ? row.integration : 'unknown',
    bookingDateRaw: typeof row.bookingDate === 'string' && /^[0-9]{8}$/.test(row.bookingDate) ? row.bookingDate : null,
    bookingTimeRaw: typeof row.bookingTime === 'string' && row.bookingTime.length > 0 && row.bookingTime.length <= 32 ? row.bookingTime : null,
    bookingStatus: CUSTOMER_DIAGNOSTICS_PROGRESS_STATUSES.find(status => status === row.status) ?? 'unknown',
    paymentStatus: (['pending', 'paid', 'cancelled', 'refunded'] as const).find(status => status === row.paymentStatus) ?? 'unknown',
    providerReferenceRecorded,
    sampleState: 'unknown', reportReleaseState: 'unknown', source: 'local_record',
    lastRecordedAt: recordedAt instanceof Date && Number.isSafeInteger(epoch) && epoch >= 0 && epoch <= 8640000000000000
      ? recordedAt.toISOString()
      : null,
  };
}

@Service()
export class ExternalBookingRepository extends BaseRepository<IExternalBooking> {
  constructor() {
    super(ExternalBookingModel as Model<IExternalBooking>);
  }

  async findCustomerDiagnosticsProgress(id: unknown, customerId: unknown): Promise<CustomerDiagnosticsProgress> {
    if (typeof customerId !== 'string' || !/^[0-9a-f]{24}$/.test(customerId)) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
    if (typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id)) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid diagnostics booking ID' });
    }
    const booking = await ExternalBookingModel.findOne({
      _id: new Types.ObjectId(id), userId: customerId, providerType: 'DIAGNOSTICS',
      $expr: { $and: [
        { $eq: [{ $type: '$userId' }, 'string'] },
        { $eq: [{ $type: '$providerType' }, 'string'] },
      ] },
    }).select({
      _id: 1, userId: 1, providerType: 1, integration: 1, bookingDate: 1, bookingTime: 1,
      status: 1, paymentStatus: 1, externalBookingId: 1, updatedAt: 1,
    }).maxTimeMS(2000).lean().exec();
    if (!booking) {
      throw new AppError({ status: 404, code: 'EXTERNAL_BOOKING_NOT_FOUND', message: 'External booking not found' });
    }
    const row = booking as unknown as Record<string, unknown>;
    return toCustomerDiagnosticsProgress(row, id, customerId);
  }

  async findCustomerDiagnosticsHistory(customerId: unknown, query: unknown): Promise<CustomerDiagnosticsHistoryPage> {
    if (typeof customerId !== 'string' || !/^[0-9a-f]{24}$/.test(customerId)) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
    const invalidQuery = () => new AppError({
      status: 400, code: 'VALIDATION_ERROR', message: 'Invalid diagnostics history query',
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
          userId: customerId, providerType: 'DIAGNOSTICS',
          $expr: { $and: [
            { $eq: [{ $type: '$userId' }, 'string'] },
            { $eq: [{ $type: '$providerType' }, 'string'] },
          ] },
        },
      },
      { $project: {
        _id: 1, userId: 1, providerType: 1, integration: 1, bookingDate: 1, bookingTime: 1,
        status: 1, paymentStatus: 1, externalBookingId: 1, updatedAt: 1,
      } },
      {
        $facet: {
          metadata: [{ $count: 'total' }],
          data: [{ $sort: { _id: -1 } }, { $skip: skip }, { $limit: limit }],
        },
      },
    ];
    const result = await ExternalBookingModel.aggregate<unknown>(pipeline)
      .option({ maxTimeMS: 2000, allowDiskUse: false }).exec();
    const unavailable = (): never => {
      throw new AppError({ status: 503, code: 'DIAGNOSTICS_PROGRESS_UNAVAILABLE', message: 'Diagnostics booking progress is unavailable' });
    };
    const record = (value: unknown, keys: string[]): Record<string, unknown> => {
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return unavailable();
      const own = Reflect.ownKeys(value);
      if (own.length !== keys.length || !own.every(key => typeof key === 'string' && keys.includes(key) &&
        Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
        'value' in Object.getOwnPropertyDescriptor(value, key)!)) return unavailable();
      return value as Record<string, unknown>;
    };
    if (!Array.isArray(result) || result.length !== 1) return unavailable();
    const facet = record(result[0], ['metadata', 'data']);
    const metadata = facet.metadata;
    const rows = facet.data;
    if (!Array.isArray(metadata) || metadata.length > 1 || !Array.isArray(rows) || rows.length > limit) return unavailable();
    let total = 0;
    if (metadata.length) {
      const count = record(metadata[0], ['total']);
      if (typeof count.total !== 'number' || !Number.isSafeInteger(count.total) || count.total < 0) return unavailable();
      total = count.total;
    }
    if (rows.length !== Math.min(limit, Math.max(0, total - skip))) return unavailable();
    const data = rows.map((value: unknown): CustomerDiagnosticsProgress => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
      const row = value as Record<string, unknown>;
      if (!(row._id instanceof Types.ObjectId)) return unavailable();
      return toCustomerDiagnosticsProgress(row, row._id.toHexString(), customerId);
    });
    return { data, page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  async findWithPagination(
    filter: ExternalBookingListQuery,
    page: number,
    limit: number
  ): Promise<{
    data: IExternalBooking[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const query: Record<string, unknown> = {};

    if (filter.userId) {
      query.userId = filter.userId;
    }
    if (filter.corporateId) {
      query.corporateId = filter.corporateId;
    }
    if (filter.integration) {
      query.integration = filter.integration;
    }
    if (filter.providerType) {
      query.providerType = filter.providerType;
    }
    if (filter.appointmentType) {
      query.appointmentType = filter.appointmentType;
    }
    if (filter.patientName) {
      query.patientName = {
        $regex: escapeRegex(filter.patientName),
        $options: 'i',
      };
    }
    if (filter.status) {
      query.status = filter.status;
    }
    if (filter.paymentStatus) {
      query.paymentStatus = filter.paymentStatus;
    }
    if (filter.bookingDateFrom || filter.bookingDateTo) {
      query.bookingDate = {} as Record<string, string>;
      if (filter.bookingDateFrom) {
        (query.bookingDate as Record<string, string>).$gte = filter.bookingDateFrom;
      }
      if (filter.bookingDateTo) {
        (query.bookingDate as Record<string, string>).$lte = filter.bookingDateTo;
      }
    }

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      ExternalBookingModel.find(query).sort({ bookingDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      ExternalBookingModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findStaleUnpaidPending(
    cutoff: Date,
    limit = 200
  ): Promise<IExternalBooking[]> {
    const rows = await ExternalBookingModel.find({
      integration: { $in: ['labstack', 'healthians'] },
      status: 'pending_payment',
      paymentStatus: 'pending',
      createdAt: { $lt: cutoff },
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean()
      .exec();
    return rows as IExternalBooking[];
  }

  async findStalePaidPendingConfirmation(
    cutoff: Date,
    limit = 200
  ): Promise<IExternalBooking[]> {
    const rows = await ExternalBookingModel.find({
      integration: { $in: ['labstack', 'healthians'] },
      status: { $in: ['pending', 'pending_payment'] },
      paymentStatus: 'paid',
      paymentTransactionId: { $exists: true, $ne: '' },
      $and: [
        {
          $or: [
            { externalBookingId: { $exists: false } },
            { externalBookingId: '' },
            { externalBookingId: null },
          ],
        },
      ],
      $or: [
        { 'meta.paymentConfirmationPendingAt': { $lt: cutoff.toISOString() } },
        {
          'meta.paymentConfirmationPendingAt': { $exists: false },
          createdAt: { $lt: cutoff },
        },
      ],
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean()
      .exec();

    return rows as IExternalBooking[];
  }

  async findByExternalReference(
    externalBookingId: string
  ): Promise<IExternalBooking | null> {
    const normalizedId = externalBookingId.trim();
    if (!normalizedId) {
      return null;
    }

    const row = await ExternalBookingModel.findOne({
      $or: [
        { externalBookingId: normalizedId },
        {
          'meta.externalPayload.bookingResponse.order.orderId': normalizedId,
        },
        {
          'meta.externalPayload.bookingResponse.appointment.appointmentId':
            normalizedId,
        },
        {
          'meta.externalPayload.bookingResponse.data.order.orderId':
            normalizedId,
        },
        {
          'meta.externalPayload.bookingResponse.data.appointment.appointmentId':
            normalizedId,
        },
      ],
    })
      .lean()
      .exec();

    return (row as IExternalBooking | null) || null;
  }
}
