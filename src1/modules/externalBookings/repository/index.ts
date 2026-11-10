import { Service } from 'typedi';
import { Model } from 'mongoose';
import ExternalBookingModel from '@/modules/externalBookings/model';
import {
  ExternalBookingListQuery,
  IExternalBooking,
} from '@/modules/externalBookings/types';
import { BaseRepository } from '@/modules/common/repository';

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Service()
export class ExternalBookingRepository extends BaseRepository<IExternalBooking> {
  constructor() {
    super(ExternalBookingModel as Model<IExternalBooking>);
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
