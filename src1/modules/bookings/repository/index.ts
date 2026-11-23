import { UNPAID_CARD_QUERY } from '@/modules/assisted/views';
import { Service } from 'typedi';
import { Model } from 'mongoose';
import BookingModel from '@/modules/bookings/model';
import {
  IBooking,
  BookingOwnerScope,
  BookingQueryParams,
  BookingType,
} from '@/modules/bookings/types';
import { BaseRepository } from '@/modules/common/repository';
import { AppError } from '@/modules/common/types';
import { istTodayYyyymmdd } from '@/modules/common/utils/istDate';

/**
 * Q14 review: a no-show marked under the Q14 rule (status no_show with a recorded `noShow.at`) earns the doctor nothing,
 * so the legacy monthly payout neither counts nor pays it. `noShow` is new in Q14: no-shows marked before it keep
 * counting, so months already computed do not change. A no-show moved and then completed is `completed` and counts.
 */
export const EXCLUDE_Q14_NO_SHOWS = Object.freeze({ $nor: [{ status: 'no_show', 'noShow.at': { $type: 'date' } }] });

/**
 * Q16a (item 3): the legacy monthly payout bills a booking in the month of its ORIGINAL appointment. A booking moved
 * after a no-show keeps that month (`noShows[0].fromDate`), so a month billed before the move and the month it moved to
 * can never both pay for it. Every other booking is billed by its `bookingDate`.
 */
export function legacyBillingMonthFilter(from?: string, to?: string): Record<string, unknown> {
  const range: Record<string, string> = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  if (!from && !to) return {};
  return { $or: [
    { 'noShows.0.fromDate': range },
    { 'noShows.0.fromDate': { $exists: false }, bookingDate: range },
  ] };
}

/**
 * Q16a re-review (E): a legacy booking moved after a no-show is billed in its ORIGINAL month. When it later changes in
 * a way the bill counts (moved back to confirmed, completed, a second no-show), an already computed billing row of that
 * month is flagged `needsRecalculation` in the same transaction (the booking id is listed; ids only). The admin
 * recalculates the month (calculate billings clears the flag); the booking is never billed in the month it moved to.
 */
export async function flagLegacyOriginalMonth(b: { _id?: unknown; specialistId?: string; settlementSystem?: string; noShows?: { fromDate?: string }[] },
  session?: import('mongoose').ClientSession): Promise<void> {
  const from = b.noShows?.[0]?.fromDate;
  if (!b.specialistId || !from || !/^\d{8}$/.test(from) || ['ledger', 'clinic'].includes(String(b.settlementSystem ?? 'legacy'))) return;
  const { PayoutBillingModel } = await import('@/modules/payouts/model');
  await PayoutBillingModel.updateOne({ specialistId: { $in: [String(b.specialistId), String(b.specialistId).toLowerCase()] }, month: Number(from.slice(0, 6)) },
    { $set: { needsRecalculation: true }, $addToSet: { recalculationReasons: String(b._id) } }, { session: session ?? undefined });
}

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
      /** Q3 §7a: only bookings settled by the legacy payout system. */
      legacyOnly?: boolean;
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
      ...(options.legacyOnly ? { settlementSystem: { $nin: ['ledger', 'clinic'] }, ...EXCLUDE_Q14_NO_SHOWS } : {}),
    };

    if (options.legacyOnly) {
      Object.assign(match, legacyBillingMonthFilter(options.from, options.to));
    } else if (options.from || options.to) {
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
      // r10b: a card-paid assisted booking never confirmed is not the doctor's to see.
      $nor: [UNPAID_CARD_QUERY],
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
        // r10b: a card-paid assisted booking never confirmed is not the doctor's to see.
        $nor: [UNPAID_CARD_QUERY],
      } as never,
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
    const today = istTodayYyyymmdd(); // Q16d: upcoming from the IST date (was the UTC date)
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
    const query = this.listQuery(filter);
    const skip = (page - 1) * limit;
    const sort = this.listSort(filter);

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

  /** Mongo filter of `findWithPagination` (pharmacyId is not one of its filters). */
  private listQuery(filter: BookingQueryParams): any {
    const query: any = {};

    if (filter.userId) {
      query.userId = filter.userId;
    }

    // Assisted booking phase 1a (§17.5): reported "not mine" (open) bookings leave the holder's lists.
    if (filter.hideDisputed) {
      query['assisted.identity.disputed.state'] = { $ne: 'open' };
    }
    // r10b: a card-paid assisted booking never confirmed is the booker's alone (patients and doctors never list it).
    if (filter.hideUnpaidCard) query.$nor = [UNPAID_CARD_QUERY];

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

    return query;
  }

  private listSort(filter: BookingQueryParams): any {
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.bookingDate = -1;
      sort.createdAt = -1;
    }
    return sort;
  }

  /**
   * S2: the list a specialist or pharmacy may see. Every list filter (pharmacyId included) only narrows it, and the
   * caller's own specialistId / pharmacyId is always ANDed on, paginated or not, so no filter reaches another owner.
   */
  async findInOwnerScope(filter: BookingQueryParams, owner: BookingOwnerScope): Promise<{
    data: IBooking[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    const narrowed = this.listQuery(filter);
    if (filter.pharmacyId) narrowed.pharmacyId = filter.pharmacyId;
    const query = { $and: [narrowed, bookingOwnerFilter(owner)] };
    const sort = this.listSort(filter);

    if (filter.page && filter.limit) {
      const [data, total] = await Promise.all([
        BookingModel.find(query).sort(sort).skip((filter.page - 1) * filter.limit).limit(filter.limit).lean(),
        BookingModel.countDocuments(query),
      ]);
      return { data: data as IBooking[], total, page: filter.page, totalPages: Math.ceil(total / filter.limit) };
    }

    return { data: (await BookingModel.find(query).sort(sort).lean()) as IBooking[] };
  }

  /** S2: whether this booking carries the caller's own specialistId / pharmacyId. */
  /** `ownCustomerId` (S3): the booking also counts as the caller's when it is that caller's own booking as a customer. */
  async existsInOwnerScope(id: string, owner: BookingOwnerScope, ownCustomerId?: string): Promise<boolean> {
    if (typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id)) return false;
    const scope = typeof ownCustomerId === 'string' && ownCustomerId.trim().length > 0
      ? { $or: [bookingOwnerFilter(owner), { userId: { $eq: ownCustomerId } }] }
      : bookingOwnerFilter(owner);
    return (await BookingModel.exists({ $and: [{ _id: id }, scope] })) !== null;
  }
}

/** S2: exact match on the owner's id (a missing or empty owner id matches nothing). */
export function bookingOwnerFilter(owner: BookingOwnerScope): Record<string, unknown> {
  const [field, value] = 'specialistId' in owner ? ['specialistId', owner.specialistId] : ['pharmacyId', owner.pharmacyId];
  if (typeof value !== 'string' || value.trim().length === 0) return { _id: { $exists: false } };
  return { [field]: { $eq: value } };
}
