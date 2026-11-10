import { BaseRepository } from '@/modules/common/repository';
import { getTodayYyyymmdd, compareYyyymmdd } from '@/modules/common/utils/dateUtils';
import { CouponModel } from '@/modules/coupon/model';
import {
  CouponQueryParams,
  CouponUsageSummary,
  CouponUsageUserSummary,
  EligibleFor,
  ICoupon,
  UserCouponUsageSummary,
  UserCouponUsageSummaryItem,
} from '@/modules/coupon/types';
import PaymentRecordModel from '@/modules/payment/model';
import { Model, PipelineStage } from 'mongoose';
import { Service } from 'typedi';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class CouponRepository extends BaseRepository<ICoupon> {
  constructor() {
    super(CouponModel as Model<ICoupon>);
  }

  async findByCode(code: string): Promise<ICoupon | null> {
    return this.findOne({ code: code.toUpperCase() });
  }

  async findActiveCoupons(): Promise<ICoupon[]> {
    const today = getTodayYyyymmdd();
    return this.findAll(
      {
        isActive: true,
        startDate: { $lte: today },
        endDate: { $gte: today },
      },
      { sort: { createdAt: -1 } }
    );
  }

  async findApplicableCoupons(
    bookingType:
      | 'package'
      | 'consultation'
      | 'second-opinion'
      | 'surgery'
      | 'external_specialist'
      | 'external_diagnostics',
    bookingId?: string,
    packageIds?: string[],
    testIds?: string[]
  ): Promise<ICoupon[]> {
    const today = getTodayYyyymmdd();
    const eligibleFor = this.mapBookingTypeToEligibleFor(bookingType);
    const query: any = {
      isActive: true,
      startDate: { $lte: today },
      endDate: { $gte: today },
      $and: [
        {
          $or: [
            { eligibleFor: 'all' },
            { eligibleFor },
            { eligibleFor: { $exists: false } },
          ],
        },
      ],
      $or: [
        { applicableTo: 'all' },
        { applicableTo: bookingType === 'package' ? 'wellnessPackage' : 'consultation' },
      ],
    };

    // If bookingId is provided and applicableTo is 'specific', check if bookingId is in applicableIds
    if (bookingId) {
      query.$or.push({
        applicableTo: 'specific',
        applicableIds: bookingId,
      });
    }

    if (packageIds?.length) {
      query.$or.push({
        applicableTo: 'specific',
        applicablePackageIds: { $in: packageIds },
      });
    }

    if (testIds?.length) {
      query.$or.push({
        applicableTo: 'specific',
        applicableTestIds: { $in: testIds },
      });
    }

    return this.findAll(query, { sort: { createdAt: -1 } });
  }

  async incrementUsageCount(couponId: string): Promise<ICoupon | null> {
    const coupon = await this.findById(couponId);
    if (!coupon) {
      return null;
    }

    return this.update(
      { _id: couponId },
      { currentUsageCount: (coupon.currentUsageCount || 0) + 1 }
    );
  }

  async decrementUsageCount(couponId: string): Promise<ICoupon | null> {
    const coupon = await this.findById(couponId);
    if (!coupon) {
      return null;
    }

    return this.update(
      { _id: couponId },
      { currentUsageCount: Math.max(0, (coupon.currentUsageCount || 0) - 1) }
    );
  }

  /**
   * Count how many times a specific user has used a specific coupon code
   * Only counts successful processed payment transactions
   */
  async countUserCouponUsage(userId: string, couponCode: string): Promise<number> {
    const count = await PaymentRecordModel.countDocuments({
      userId,
      couponCode: couponCode.toUpperCase(),
      status: 'paid',
      isProcessed: true,
    });
    return count;
  }

  async getCouponUsageSummary(
    couponCode: string,
    page: number,
    limit: number,
    userIds?: string[]
  ): Promise<CouponUsageSummary> {
    const normalizedCode = couponCode.toUpperCase();
    const skip = (page - 1) * limit;

    const groupedUsagePipeline: PipelineStage[] = [
      {
        $match: {
          couponCode: normalizedCode,
          ...(userIds ? { userId: { $in: userIds } } : {}),
          status: 'paid',
          isProcessed: true,
        },
      },
      {
        $group: {
          _id: '$userId',
          usageCount: { $sum: 1 },
          totalDiscountAmount: { $sum: '$discountAmount' },
          contexts: { $addToSet: '$context' },
          firstUsedAt: { $min: { $ifNull: ['$paidAt', '$createdAt'] } },
          lastUsedAt: { $max: { $ifNull: ['$paidAt', '$createdAt'] } },
        },
      },
      {
        $sort: {
          usageCount: -1 as const,
          lastUsedAt: -1 as const,
          _id: 1 as const,
        },
      },
    ];

    const [summary] = await PaymentRecordModel.aggregate([
      ...groupedUsagePipeline,
      {
        $facet: {
          users: [
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                _id: 0,
                userId: '$_id',
                usageCount: 1,
                totalDiscountAmount: 1,
                contexts: 1,
                firstUsedAt: 1,
                lastUsedAt: 1,
              },
            },
          ],
          totals: [
            {
              $group: {
                _id: null,
                totalUses: { $sum: '$usageCount' },
                totalUsers: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]);

    const totals = Array.isArray(summary?.totals) ? summary.totals[0] : undefined;
    const users = (Array.isArray(summary?.users) ? summary.users : []) as CouponUsageUserSummary[];
    const totalUses = totals?.totalUses || 0;
    const totalUsers = totals?.totalUsers || 0;

    return {
      couponCode: normalizedCode,
      totalUses,
      totalUsers,
      users,
      page,
      limit,
      totalPages: totalUsers ? Math.ceil(totalUsers / limit) : 0,
    };
  }

  async getUserCouponUsageSummary(
    userId: string,
    page: number,
    limit: number
  ): Promise<UserCouponUsageSummary> {
    const skip = (page - 1) * limit;

    const groupedUsagePipeline: PipelineStage[] = [
      {
        $match: {
          userId,
          couponCode: { $exists: true, $nin: [null, ''] },
          status: 'paid',
          isProcessed: true,
        },
      },
      {
        $group: {
          _id: '$couponCode',
          usageCount: { $sum: 1 },
          totalDiscountAmount: { $sum: '$discountAmount' },
          contexts: { $addToSet: '$context' },
          firstUsedAt: { $min: { $ifNull: ['$paidAt', '$createdAt'] } },
          lastUsedAt: { $max: { $ifNull: ['$paidAt', '$createdAt'] } },
        },
      },
      {
        $sort: {
          lastUsedAt: -1 as const,
          usageCount: -1 as const,
          _id: 1 as const,
        },
      },
    ];

    const [summary] = await PaymentRecordModel.aggregate([
      ...groupedUsagePipeline,
      {
        $facet: {
          coupons: [
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                _id: 0,
                couponCode: '$_id',
                usageCount: 1,
                totalDiscountAmount: 1,
                contexts: 1,
                firstUsedAt: 1,
                lastUsedAt: 1,
              },
            },
          ],
          totals: [
            {
              $group: {
                _id: null,
                totalUses: { $sum: '$usageCount' },
                totalCoupons: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]);

    const totals = Array.isArray(summary?.totals) ? summary.totals[0] : undefined;
    const coupons = (Array.isArray(summary?.coupons)
      ? summary.coupons
      : []) as UserCouponUsageSummaryItem[];
    const totalUses = totals?.totalUses || 0;
    const totalCoupons = totals?.totalCoupons || 0;

    return {
      userId,
      totalUses,
      totalCoupons,
      coupons,
      page,
      limit,
      totalPages: totalCoupons ? Math.ceil(totalCoupons / limit) : 0,
    };
  }

  async findByCorporateId(corporateId: string): Promise<ICoupon[]> {
    const today = getTodayYyyymmdd();
    const query: any = {
      corporateIds: corporateId,
      isActive: true,
    };

    const coupons = await this.findAll(query, { sort: { createdAt: -1 } });
    
    // Filter coupons that are within date range
    return coupons.filter((coupon) => {
      if (coupon.startDate && compareYyyymmdd(today, coupon.startDate) < 0) {
        return false; // Coupon hasn't started yet
      }
      if (coupon.endDate && compareYyyymmdd(today, coupon.endDate) > 0) {
        return false; // Coupon has expired
      }
      return true;
    });
  }

  async findWithPagination(
    filter: CouponQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{ data: ICoupon[]; total: number; page: number; totalPages: number }> {
    const query: any = {};

    if (filter.code) {
      query.code = buildContainsRegex(filter.code.toUpperCase());
    }

    if (filter.title) {
      query.title = buildContainsRegex(filter.title);
    }

    if (filter.corporateId) {
      query.corporateIds = filter.corporateId;
    }

    if (filter.discountType) {
      query.discountType = filter.discountType;
    }

    if (filter.eligibleFor) {
      query.eligibleFor = filter.eligibleFor;
    }

    if (filter.applicableTo) {
      query.applicableTo = filter.applicableTo;
    }

    if (filter.isActive !== undefined) {
      query.isActive = filter.isActive;
    }

    if (filter.startDateFrom || filter.startDateTo) {
      query.startDate = {};
      if (filter.startDateFrom) {
        query.startDate.$gte = filter.startDateFrom;
      }
      if (filter.startDateTo) {
        query.startDate.$lte = filter.startDateTo;
      }
    }

    if (filter.endDateFrom || filter.endDateTo) {
      query.endDate = {};
      if (filter.endDateFrom) {
        query.endDate.$gte = filter.endDateFrom;
      }
      if (filter.endDateTo) {
        query.endDate.$lte = filter.endDateTo;
      }
    }

    const skip = (page - 1) * limit;
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.createdAt = -1;
    }

    const [data, total] = await Promise.all([
      this.findAll(query, { skip, limit, sort }),
      CouponModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  private mapBookingTypeToEligibleFor(
    bookingType:
      | 'package'
      | 'consultation'
      | 'second-opinion'
      | 'surgery'
      | 'external_specialist'
      | 'external_diagnostics'
  ): EligibleFor {
    switch (bookingType) {
      case 'package':
        return 'package';
      case 'external_specialist':
        return 'external_specialist';
      case 'external_diagnostics':
        return 'external_diagnostics';
      default:
        return 'specialist';
    }
  }
}
