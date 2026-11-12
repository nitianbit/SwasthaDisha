import { Service } from 'typedi';
import { Model } from 'mongoose';
import BookingModel from '@/modules/bookings/model';
import {
  IBooking,
  BookingQueryParams,
  BookingType,
} from '@/modules/bookings/types';
import { BaseRepository } from '@/modules/common/repository';
import { AppError } from '@/modules/common/types';

@Service()
export class BookingRepository extends BaseRepository<IBooking> {
  constructor() {
    super(BookingModel as Model<IBooking>);
  }

  async deleteByIdAndUserId(id: string, userId: string): Promise<boolean> {
    if (typeof userId !== 'string' || userId.trim().length === 0) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }
    if (typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id)) {
      throw new AppError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid ID format',
      });
    }

    const result = await BookingModel.deleteOne({
      _id: id,
      userId: { $eq: userId },
      $expr: { $eq: [{ $type: '$userId' }, 'string'] },
    });
    return result.acknowledged === true && result.deletedCount === 1;
  }

  async getConsultationStatsBySpecialistId(
    specialistId: string,
    options: {
      from?: string;
      to?: string;
    } = {}
  ): Promise<{
    totalAppointments: number;
    totalPatients: number;
    totalUniquePatients: number;
    totalFollowUpAppointments: number;
  }> {
    const match: Record<string, unknown> = {
      specialistId,
      bookingType: 'consultation',
    };

    if (options.from || options.to) {
      match.bookingDate = {} as Record<string, string>;
      if (options.from) {
        (match.bookingDate as Record<string, string>).$gte = options.from;
      }
      if (options.to) {
        (match.bookingDate as Record<string, string>).$lte = options.to;
      }
    }

    const [stats] = await BookingModel.aggregate([
      {
        $match: match,
      },
      {
        $group: {
          _id: null,
          totalAppointments: { $sum: 1 },
          totalFollowUpAppointments: {
            $sum: {
              $cond: [{ $eq: ['$followUp.isFollowUp', true] }, 1, 0],
            },
          },
          patientKeys: {
            $addToSet: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$dependentId', null] },
                    { $ne: ['$dependentId', ''] },
                  ],
                },
                { $concat: ['dependent:', '$dependentId'] },
                { $concat: ['user:', '$userId'] },
              ],
            },
          },
          userIds: {
            $addToSet: '$userId',
          },
        },
      },
      {
        $project: {
          _id: 0,
          totalAppointments: 1,
          totalFollowUpAppointments: 1,
          totalPatients: { $size: '$patientKeys' },
          totalUniquePatients: { $size: '$userIds' },
        },
      },
    ]);

    return {
      totalAppointments: stats?.totalAppointments || 0,
      totalPatients: stats?.totalPatients || 0,
      totalUniquePatients: stats?.totalUniquePatients || 0,
      totalFollowUpAppointments: stats?.totalFollowUpAppointments || 0,
    };
  }

  async findByIdWithModel(id: string) {
    return BookingModel.findById(id);
  }

  async findByUserId(userId: string): Promise<IBooking[]> {
    return this.findAll(
      { userId },
      { sort: { bookingDate: -1, createdAt: -1 } }
    );
  }

  async findByDependentId(dependentId: string): Promise<IBooking[]> {
    return this.findAll(
      { dependentId },
      { sort: { bookingDate: -1, createdAt: -1 } }
    );
  }

  async findByWellnessPackageId(
    wellnessPackageId: string
  ): Promise<IBooking[]> {
    return this.findAll(
      { wellnessPackageId, bookingType: 'package' },
      { sort: { bookingDate: -1 } }
    );
  }

  async findBySpecialistId(specialistId: string): Promise<IBooking[]> {
    return this.findAll(
      { specialistId, bookingType: 'consultation' },
      { sort: { bookingDate: -1 } }
    );
  }

  async findConsultationsForSpecialist(
    specialistId: string,
    options: {
      bookingDate?: string;
      yearMonth?: string;
      page?: number;
      limit?: number;
    }
  ): Promise<{
    data: IBooking[];
    total: number;
    page?: number;
    totalPages?: number;
  }> {
    const query: Record<string, unknown> = {
      specialistId,
      bookingType: 'consultation',
    };

    if (options.bookingDate) {
      query.bookingDate = options.bookingDate;
    } else if (options.yearMonth) {
      query.bookingDate = new RegExp(`^${options.yearMonth}`);
    }

    const sort: Record<string, 1 | -1> = {
      bookingDate: -1,
      createdAt: -1,
    };

    if (options.page !== undefined && options.limit !== undefined) {
      const skip = (options.page - 1) * options.limit;
      const [data, total] = await Promise.all([
        BookingModel.find(query)
          .sort(sort)
          .skip(skip)
          .limit(options.limit)
          .lean(),
        BookingModel.countDocuments(query),
      ]);
      return {
        data: data as IBooking[],
        total,
        page: options.page,
        totalPages: Math.ceil(total / options.limit) || 0,
      };
    }

    const data = await BookingModel.find(query).sort(sort).lean();
    const list = data as IBooking[];
    return { data: list, total: list.length };
  }

  async findConsultationsBySpecialistAndUserId(
    specialistId: string,
    userId: string
  ): Promise<IBooking[]> {
    return this.findAll(
      {
        specialistId,
        userId,
        bookingType: 'consultation',
      },
      { sort: { bookingDate: -1, createdAt: -1 } }
    );
  }

  async findByStatus(status: string): Promise<IBooking[]> {
    return this.findAll({ status }, { sort: { bookingDate: -1 } });
  }

  async findByBookingType(bookingType: BookingType): Promise<IBooking[]> {
    return this.findAll(
      { bookingType },
      { sort: { bookingDate: -1 } }
    );
  }

  async findUpcomingBookings(userId?: string): Promise<IBooking[]> {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // Get today in YYYYMMDD format
    const query: any = {
      bookingDate: { $gte: today },
      status: { $in: ['pending', 'confirmed'] },
    };

    if (userId) {
      query.userId = userId;
    }

    return this.findAll(query, {
      sort: { bookingDate: 1, bookingTime: 1 },
    });
  }

  async findWithPagination(
    filter: BookingQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{
    data: IBooking[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const query: any = {};

    if (filter.userId) {
      query.userId = filter.userId;
    }

    if (filter.dependentId) {
      query.dependentId = filter.dependentId;
    }

    if (filter.forUser) {
      query.corporateId = { $exists: false };
    } else if (filter.corporateId) {
      query.corporateId = filter.corporateId;
    }

    if (filter.bookingType) {
      query.bookingType = filter.bookingType;
    }

    if (filter.wellnessPackageId) {
      query.wellnessPackageId = filter.wellnessPackageId;
    }

    if (filter.specialistId) {
      query.specialistId = filter.specialistId;
    }

    if (filter.status) {
      query.status = filter.status;
    }

    if (filter.paymentStatus) {
      query.paymentStatus = filter.paymentStatus;
    }

    if (filter.bookingDateFrom || filter.bookingDateTo) {
      query.bookingDate = {};
      if (filter.bookingDateFrom) {
        query.bookingDate.$gte = filter.bookingDateFrom;
      }
      if (filter.bookingDateTo) {
        query.bookingDate.$lte = filter.bookingDateTo;
      }
    }

    const skip = (page - 1) * limit;
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.bookingDate = -1;
      sort.createdAt = -1;
    }

    const [data, total] = await Promise.all([
      BookingModel.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      BookingModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }
}
