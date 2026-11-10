import { AppError } from '@/modules/common/types';
import { compareYyyymmdd, getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import { CouponRepository } from '@/modules/coupon/repository';
import {
  ApplicableTo,
  CouponForUser,
  CouponQueryParams,
  CouponUsageQueryParams,
  CouponUsageSummary,
  CreateCouponRequest,
  EligibleFor,
  ICoupon,
  UserCouponUsageSummary,
  UpdateCouponRequest,
  ValidateCouponRequest,
  ValidateWalletCouponRequest,
} from '@/modules/coupon/types';
import { Service } from 'typedi';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class CouponService {
  constructor(
    private couponRepository: CouponRepository,
  ) {}

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

  private mapBookingTypeToApplicableTo(
    bookingType:
      | 'package'
      | 'consultation'
      | 'second-opinion'
      | 'surgery'
      | 'external_specialist'
      | 'external_diagnostics'
  ): ApplicableTo {
    return bookingType === 'package' ? 'wellnessPackage' : 'consultation';
  }

  private isCouponEligibleForBookingType(
    coupon: ICoupon,
    bookingType:
      | 'package'
      | 'consultation'
      | 'second-opinion'
      | 'surgery'
      | 'external_specialist'
      | 'external_diagnostics'
  ): boolean {
    if (coupon.eligibleFor === 'all') {
      return true;
    }

    const expectedEligibleFor = this.mapBookingTypeToEligibleFor(bookingType);
    if (coupon.eligibleFor && coupon.eligibleFor !== expectedEligibleFor) {
      return false;
    }

    if (
      !coupon.eligibleFor &&
      (bookingType === 'external_specialist' || bookingType === 'external_diagnostics')
    ) {
      return false;
    }

    return true;
  }

  private isCouponApplicableToTarget(
    coupon: ICoupon,
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
  ): boolean {
    const applicableToForCheck = this.mapBookingTypeToApplicableTo(bookingType);

    if (coupon.applicableTo === 'all') {
      return true;
    }

    if (
      coupon.applicableTo === applicableToForCheck &&
      bookingType !== 'external_specialist' &&
      bookingType !== 'external_diagnostics'
    ) {
      return true;
    }

    if (coupon.applicableTo === 'specific') {
      const vendorConfigured = !!coupon.applicableIds?.length;
      const packageConfigured =
        bookingType === 'external_diagnostics' &&
        !!coupon.applicablePackageIds?.length;
      const testConfigured =
        bookingType === 'external_diagnostics' &&
        !!coupon.applicableTestIds?.length;
      const itemConfigured = packageConfigured || testConfigured;

      const vendorMatch = !!bookingId && !!coupon.applicableIds?.includes(bookingId);
      const packageMatch =
        bookingType === 'external_diagnostics' &&
        !!packageIds?.length &&
        !!coupon.applicablePackageIds?.some((packageId) =>
          packageIds.includes(packageId)
        );
      const testMatch =
        bookingType === 'external_diagnostics' &&
        !!testIds?.length &&
        !!coupon.applicableTestIds?.some((testId) => testIds.includes(testId));
      const itemMatch = packageMatch || testMatch;

      if (coupon.isBothRequired && vendorConfigured && itemConfigured) {
        return vendorMatch && itemMatch;
      }

      if (vendorConfigured && itemConfigured) {
        return vendorMatch || itemMatch;
      }

      if (vendorConfigured) {
        return vendorMatch;
      }

      if (itemConfigured) {
        return itemMatch;
      }

      return false;
    }

    return false;
  }

  private isCouponAllowedForBookingUser(
    coupon: ICoupon,
    data: Partial<Pick<ValidateCouponRequest, 'userId' | 'dependentId' | 'corporateId'>>
  ): { allowed: boolean; message?: string } {
    const forUser: CouponForUser = coupon.forUser || 'all';
    if (forUser === 'self' && data.dependentId) {
      return {
        allowed: false,
        message: 'Coupon is valid only for self bookings',
      };
    }

    if (coupon.userIds?.length) {
      if (!data.userId || !coupon.userIds.includes(data.userId)) {
        return {
          allowed: false,
          message: 'Coupon is not applicable to this user',
        };
      }
    }

    if (coupon.corporateIds?.length) {
      if (!data.corporateId || !coupon.corporateIds.includes(data.corporateId)) {
        return {
          allowed: false,
          message: 'Coupon is not applicable to this user',
        };
      }
    }

    return { allowed: true };
  }

  async create(data: CreateCouponRequest): Promise<ICoupon> {
    // Check if coupon code already exists
    const existingCoupon = await this.couponRepository.findByCode(data.code);

    if (existingCoupon) {
      throw new AppError({
        status: 400,
        code: 'COUPON_CODE_EXISTS',
        message: 'A coupon with this code already exists',
      });
    }

    // Validate dates
    if (compareYyyymmdd(data.startDate, data.endDate) > 0) {
      throw new AppError({
        status: 400,
        code: 'INVALID_DATE_RANGE',
        message: 'End date cannot be earlier than start date',
      });
    }

    // Validate percentage discount
    if (data.discountType === 'percentage' && data.discountValue > 100) {
      throw new AppError({
        status: 400,
        code: 'INVALID_DISCOUNT_VALUE',
        message: 'Percentage discount cannot exceed 100%',
      });
    }

    // Validate applicableIds for specific coupons
    if (
      data.applicableTo === 'specific' &&
      (!data.applicableIds || data.applicableIds.length === 0) &&
      (!data.applicablePackageIds || data.applicablePackageIds.length === 0) &&
      (!data.applicableTestIds || data.applicableTestIds.length === 0)
    ) {
      throw new AppError({
        status: 400,
        code: 'MISSING_APPLICABLE_IDS',
        message:
          'Applicable IDs, applicable package IDs, or applicable test IDs are required when applicableTo is "specific"',
      });
    }

    const coupon: ICoupon = {
      code: data.code.toUpperCase(),
      title: data.title,
      description: data.description,
      corporateIds: Array.from(new Set((data.corporateIds || []).map((id) => id.trim()))),
      userIds: Array.from(new Set((data.userIds || []).map((id) => id.trim()))),
      discountType: data.discountType,
      discountValue: data.discountValue,
      minimumPurchaseAmount: data.minimumPurchaseAmount,
      maximumDiscountAmount: data.maximumDiscountAmount,
      eligibleFor: data.eligibleFor,
      forUser: data.forUser || 'all',
      applicableTo: data.applicableTo,
      applicableIds: data.applicableIds || [],
      applicablePackageIds: data.applicablePackageIds || [],
      applicableTestIds: data.applicableTestIds || [],
      isBothRequired: data.isBothRequired || false,
      startDate: data.startDate,
      endDate: data.endDate,
      usageLimitPerUser: data.usageLimitPerUser,
      totalUsageLimit: data.totalUsageLimit,
      currentUsageCount: 0,
      isActive: data.isActive !== undefined ? data.isActive : true,
    };

    return this.couponRepository.save(coupon);
  }

  async getById(id: string): Promise<ICoupon> {
    const coupon = await this.couponRepository.findById(id);

    if (!coupon) {
      throw new AppError({
        status: 404,
        code: 'COUPON_NOT_FOUND',
        message: 'Coupon not found',
      });
    }

    return coupon;
  }

  async getByCode(code: string): Promise<ICoupon> {
    const coupon = await this.couponRepository.findByCode(code);

    if (!coupon) {
      throw new AppError({
        status: 404,
        code: 'COUPON_NOT_FOUND',
        message: 'Coupon not found',
      });
    }

    return coupon;
  }

  async getCouponUsageByCode(
    code: string,
    queryParams: CouponUsageQueryParams = {}
  ): Promise<CouponUsageSummary> {
    const page = queryParams.page || 1;
    const limit = queryParams.limit || 20;

    return this.couponRepository.getCouponUsageSummary(
      code,
      page,
      limit,
      queryParams.userIds
    );
  }

  async getCouponUsageByUserId(
    userId: string,
    queryParams: CouponUsageQueryParams = {}
  ): Promise<UserCouponUsageSummary> {
    const page = queryParams.page || 1;
    const limit = queryParams.limit || 20;

    return this.couponRepository.getUserCouponUsageSummary(userId, page, limit);
  }

  async getAll(
    queryParams: CouponQueryParams = {},
    requester?: { userType: string; corporateId?: string }
  ): Promise<{
    data: ICoupon[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    if (requester && requester.userType !== 'admin') {
      if (requester.corporateId) {
        const corporateFilter: any = {
          $or: [
            { corporateIds: requester.corporateId },
            { corporateIds: { $size: 0 } },
            { corporateIds: { $exists: false } },
          ],
        };

        if (queryParams.code) {
          corporateFilter.code = buildContainsRegex(queryParams.code.toUpperCase());
        }
        if (queryParams.title) {
          corporateFilter.title = buildContainsRegex(queryParams.title);
        }
        if (queryParams.discountType) {
          corporateFilter.discountType = queryParams.discountType;
        }
        if (queryParams.eligibleFor) {
          corporateFilter.eligibleFor = queryParams.eligibleFor;
        }
        if (queryParams.applicableTo) {
          corporateFilter.applicableTo = queryParams.applicableTo;
        }
        if (queryParams.isActive !== undefined) {
          corporateFilter.isActive = queryParams.isActive;
        }

        const sort: any = {};
        if (queryParams.sortBy) {
          sort[queryParams.sortBy] = queryParams.sortOrder === 'desc' ? -1 : 1;
        } else {
          sort.createdAt = -1;
        }

        if (queryParams.page && queryParams.limit) {
          const skip = (queryParams.page - 1) * queryParams.limit;
          const [data, total] = await Promise.all([
            this.couponRepository
              .findMany(corporateFilter)
              .sort(sort)
              .skip(skip)
              .limit(queryParams.limit)
              .lean(),
            this.couponRepository.findMany(corporateFilter).countDocuments(),
          ]);
          return {
            data,
            total,
            page: queryParams.page,
            totalPages: Math.ceil(total / queryParams.limit),
          };
        }

        const data = await this.couponRepository.findMany(corporateFilter).sort(sort).lean();
        return { data };
      }

      const normalUserFilter: any = {
        $or: [
          { corporateIds: { $size: 0 } },
          { corporateIds: { $exists: false } },
        ],
      };

      if (queryParams.code) {
        normalUserFilter.code = buildContainsRegex(queryParams.code.toUpperCase());
      }
      if (queryParams.title) {
        normalUserFilter.title = buildContainsRegex(queryParams.title);
      }
      if (queryParams.discountType) {
        normalUserFilter.discountType = queryParams.discountType;
      }
      if (queryParams.eligibleFor) {
        normalUserFilter.eligibleFor = queryParams.eligibleFor;
      }
      if (queryParams.applicableTo) {
        normalUserFilter.applicableTo = queryParams.applicableTo;
      }
      if (queryParams.isActive !== undefined) {
        normalUserFilter.isActive = queryParams.isActive;
      }

      const sort: any = {};
      if (queryParams.sortBy) {
        sort[queryParams.sortBy] = queryParams.sortOrder === 'desc' ? -1 : 1;
      } else {
        sort.createdAt = -1;
      }

      if (queryParams.page && queryParams.limit) {
        const skip = (queryParams.page - 1) * queryParams.limit;
        const [data, total] = await Promise.all([
          this.couponRepository
            .findMany(normalUserFilter)
            .sort(sort)
            .skip(skip)
            .limit(queryParams.limit)
            .lean(),
          this.couponRepository.findMany(normalUserFilter).countDocuments(),
        ]);
        return {
          data,
          total,
          page: queryParams.page,
          totalPages: Math.ceil(total / queryParams.limit),
        };
      }

      const data = await this.couponRepository.findMany(normalUserFilter).sort(sort).lean();
      return { data };
    }

    if (queryParams.page && queryParams.limit) {
      return this.couponRepository.findWithPagination(
        queryParams,
        queryParams.page,
        queryParams.limit
      );
    }

    const filter: any = {};

    if (queryParams.code) {
      filter.code = buildContainsRegex(queryParams.code.toUpperCase());
    }

    if (queryParams.title) {
      filter.title = buildContainsRegex(queryParams.title);
    }

    if (queryParams.corporateId) {
      filter.corporateIds = queryParams.corporateId;
    }

    if (queryParams.discountType) {
      filter.discountType = queryParams.discountType;
    }

    if (queryParams.eligibleFor) {
      filter.eligibleFor = queryParams.eligibleFor;
    }

    if (queryParams.applicableTo) {
      filter.applicableTo = queryParams.applicableTo;
    }

    if (queryParams.isActive !== undefined) {
      filter.isActive = queryParams.isActive;
    }

    const sort: any = {};
    if (queryParams.sortBy) {
      sort[queryParams.sortBy] = queryParams.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.createdAt = -1;
    }

    const data = await this.couponRepository.findAll(filter, { sort });
    return { data };
  }

  async update(id: string, data: UpdateCouponRequest): Promise<ICoupon> {
    const coupon = await this.couponRepository.findById(id);

    if (!coupon) {
      throw new AppError({
        status: 404,
        code: 'COUPON_NOT_FOUND',
        message: 'Coupon not found',
      });
    }

    // Validate dates if both are provided
    if (data.startDate && data.endDate) {
      if (compareYyyymmdd(data.startDate, data.endDate) > 0) {
        throw new AppError({
          status: 400,
          code: 'INVALID_DATE_RANGE',
          message: 'End date cannot be earlier than start date',
        });
      }
    } else if (data.startDate) {
      // Only startDate provided, compare with existing endDate
      if (compareYyyymmdd(data.startDate, coupon.endDate) > 0) {
        throw new AppError({
          status: 400,
          code: 'INVALID_DATE_RANGE',
          message: 'Start date cannot be later than end date',
        });
      }
    } else if (data.endDate) {
      // Only endDate provided, compare with existing startDate
      if (compareYyyymmdd(coupon.startDate, data.endDate) > 0) {
        throw new AppError({
          status: 400,
          code: 'INVALID_DATE_RANGE',
          message: 'End date cannot be earlier than start date',
        });
      }
    }

    // Validate percentage discount
    const discountType = data.discountType || coupon.discountType;
    const discountValue = data.discountValue !== undefined ? data.discountValue : coupon.discountValue;
    if (discountType === 'percentage' && discountValue > 100) {
      throw new AppError({
        status: 400,
        code: 'INVALID_DISCOUNT_VALUE',
        message: 'Percentage discount cannot exceed 100%',
      });
    }

    // Validate applicableIds for specific coupons
    const applicableTo = data.applicableTo || coupon.applicableTo;
    const applicableIds = data.applicableIds !== undefined ? data.applicableIds : coupon.applicableIds;
    const applicablePackageIds =
      data.applicablePackageIds !== undefined
        ? data.applicablePackageIds
        : coupon.applicablePackageIds;
    const applicableTestIds =
      data.applicableTestIds !== undefined
        ? data.applicableTestIds
        : coupon.applicableTestIds;
    if (
      applicableTo === 'specific' &&
      (!applicableIds || applicableIds.length === 0) &&
      (!applicablePackageIds || applicablePackageIds.length === 0) &&
      (!applicableTestIds || applicableTestIds.length === 0)
    ) {
      throw new AppError({
        status: 400,
        code: 'MISSING_APPLICABLE_IDS',
        message:
          'Applicable IDs, applicable package IDs, or applicable test IDs are required when applicableTo is "specific"',
      });
    }

    if (data.corporateIds) {
      data.corporateIds = Array.from(new Set(data.corporateIds.map((item) => item.trim())));
    }

    if (data.userIds) {
      data.userIds = Array.from(new Set(data.userIds.map((item) => item.trim())));
    }

    const updated = await this.couponRepository.update({ _id: id }, data);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update coupon',
      });
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    const coupon = await this.couponRepository.findById(id);

    if (!coupon) {
      throw new AppError({
        status: 404,
        code: 'COUPON_NOT_FOUND',
        message: 'Coupon not found',
      });
    }

    await this.couponRepository.delete({ _id: id });
  }

  async validateCoupon(data: ValidateCouponRequest): Promise<{
    isValid: boolean;
    coupon?: ICoupon;
    discountAmount?: number;
    finalAmount?: number;
    message?: string;
  }> {
    if (data.bookingType === 'wallet_recharge') {
      return this.validateWalletCoupon({
        code: data.code,
        userId: data.userId,
        purchaseAmount: data.purchaseAmount,
      });
    }

    const coupon = await this.couponRepository.findByCode(data.code);

    if (!coupon) {
      return {
        isValid: false,
        message: 'Invalid coupon code',
      };
    }

    // Check if coupon is active
    if (!coupon.isActive) {
      return {
        isValid: false,
        coupon,
        message: 'Coupon is not active',
      };
    }

    // Check validity dates
    const today = getTodayYyyymmdd();
    if (compareYyyymmdd(today, coupon.startDate) < 0) {
      return {
        isValid: false,
        coupon,
        message: 'Coupon is not yet valid',
      };
    }

    if (compareYyyymmdd(today, coupon.endDate) > 0) {
      return {
        isValid: false,
        coupon,
        message: 'Coupon has expired',
      };
    }

    // Check total usage limit
    if (coupon.totalUsageLimit && coupon.currentUsageCount >= coupon.totalUsageLimit) {
      return {
        isValid: false,
        coupon,
        message: 'Coupon usage limit has been reached',
      };
    }

    // Check minimum purchase amount
    if (coupon.minimumPurchaseAmount && data.purchaseAmount < coupon.minimumPurchaseAmount) {
      return {
        isValid: false,
        coupon,
        message: `Minimum purchase amount of ₹${coupon.minimumPurchaseAmount} required`,
      };
    }

    if (!this.isCouponEligibleForBookingType(coupon, data.bookingType)) {
      return {
        isValid: false,
        coupon,
        message: 'Coupon is not applicable to this booking type',
      };
    }

    const userEligibility = this.isCouponAllowedForBookingUser(coupon, {
      userId: data.userId,
      dependentId: data.dependentId,
      corporateId: data.corporateId,
    });
    if (!userEligibility.allowed) {
      return {
        isValid: false,
        coupon,
        message: userEligibility.message,
      };
    }

    if (
      !this.isCouponApplicableToTarget(
        coupon,
        data.bookingType,
        data.bookingId,
        data.packageIds,
        data.testIds
      )
    ) {
      return {
        isValid: false,
        coupon,
        message: 'Coupon is not applicable to this booking',
      };
    }

    // Check per-user usage limit
    if (coupon.usageLimitPerUser) {
      const userUsageCount = await this.couponRepository.countUserCouponUsage(
        data.userId,
        coupon.code
      );

      if (userUsageCount >= coupon.usageLimitPerUser) {
        return {
          isValid: false,
          coupon,
          message: `You have reached the maximum usage limit of ${coupon.usageLimitPerUser} time(s) for this coupon`,
        };
      }
    }

    // Calculate discount amount
    let discountAmount = 0;
    if (coupon.discountType === 'percentage') {
      discountAmount = (data.purchaseAmount * coupon.discountValue) / 100;
      // Apply maximum discount limit if set
      if (coupon.maximumDiscountAmount && discountAmount > coupon.maximumDiscountAmount) {
        discountAmount = coupon.maximumDiscountAmount;
      }
    } else {
      // Fixed discount
      discountAmount = coupon.discountValue;
      // Don't exceed purchase amount
      if (discountAmount > data.purchaseAmount) {
        discountAmount = data.purchaseAmount;
      }
    }

    const finalAmount = Math.max(0, data.purchaseAmount - discountAmount);

    return {
      isValid: true,
      coupon,
      discountAmount,
      finalAmount,
      message: 'Coupon is valid',
    };
  }

  async validateWalletCoupon(data: ValidateWalletCouponRequest): Promise<{
    isValid: boolean;
    coupon?: ICoupon;
    discountAmount?: number;
    finalAmount?: number;
    message?: string;
  }> {
    const coupon = await this.couponRepository.findByCode(data.code);

    if (!coupon) {
      return {
        isValid: false,
        message: 'Invalid coupon code',
      };
    }

    if (!coupon.isActive) {
      return {
        isValid: false,
        coupon,
        message: 'Coupon is not active',
      };
    }

    if (coupon.applicableTo !== 'all') {
      return {
        isValid: false,
        coupon,
        message: 'Coupon is not applicable for wallet recharge',
      };
    }

    const today = getTodayYyyymmdd();
    if (compareYyyymmdd(today, coupon.startDate) < 0) {
      return {
        isValid: false,
        coupon,
        message: 'Coupon is not yet valid',
      };
    }

    if (compareYyyymmdd(today, coupon.endDate) > 0) {
      return {
        isValid: false,
        coupon,
        message: 'Coupon has expired',
      };
    }

    if (coupon.totalUsageLimit && coupon.currentUsageCount >= coupon.totalUsageLimit) {
      return {
        isValid: false,
        coupon,
        message: 'Coupon usage limit has been reached',
      };
    }

    if (coupon.minimumPurchaseAmount && data.purchaseAmount < coupon.minimumPurchaseAmount) {
      return {
        isValid: false,
        coupon,
        message: `Minimum purchase amount of ₹${coupon.minimumPurchaseAmount} required`,
      };
    }

    if (coupon.usageLimitPerUser) {
      const userUsageCount = await this.couponRepository.countUserCouponUsage(
        data.userId,
        coupon.code
      );

      if (userUsageCount >= coupon.usageLimitPerUser) {
        return {
          isValid: false,
          coupon,
          message: `You have reached the maximum usage limit of ${coupon.usageLimitPerUser} time(s) for this coupon`,
        };
      }
    }

    let discountAmount = 0;
    if (coupon.discountType === 'percentage') {
      discountAmount = (data.purchaseAmount * coupon.discountValue) / 100;
      if (coupon.maximumDiscountAmount && discountAmount > coupon.maximumDiscountAmount) {
        discountAmount = coupon.maximumDiscountAmount;
      }
    } else {
      discountAmount = coupon.discountValue;
      if (discountAmount > data.purchaseAmount) {
        discountAmount = data.purchaseAmount;
      }
    }

    const finalAmount = Math.max(0, data.purchaseAmount - discountAmount);

    return {
      isValid: true,
      coupon,
      discountAmount,
      finalAmount,
      message: 'Coupon is valid',
    };
  }

  async getActiveCoupons(): Promise<ICoupon[]> {
    return this.couponRepository.findActiveCoupons();
  }

  async getApplicableCoupons(
    bookingType:
      | 'package'
      | 'consultation'
      | 'second-opinion'
      | 'surgery'
      | 'external_specialist'
      | 'external_diagnostics',
    bookingId?: string,
    packageIds?: string[],
    testIds?: string[],
    requester?: { corporateId?: string; userId?: string },
    dependentId?: string
  ): Promise<ICoupon[]> {
    const coupons = await this.couponRepository.findApplicableCoupons(
      bookingType,
      bookingId,
      packageIds,
      testIds
    );

    const applicableCoupons: ICoupon[] = [];

    for (const coupon of coupons) {
      if (
        !this.isCouponEligibleForBookingType(coupon, bookingType) ||
        !this.isCouponApplicableToTarget(
          coupon,
          bookingType,
          bookingId,
          packageIds,
          testIds
        )
      ) {
        continue;
      }

      const userEligibility = this.isCouponAllowedForBookingUser(coupon, {
        userId: requester?.userId,
        dependentId,
        corporateId: requester?.corporateId,
      });
      if (!userEligibility.allowed) {
        continue;
      }

      if (
        coupon.totalUsageLimit &&
        coupon.currentUsageCount >= coupon.totalUsageLimit
      ) {
        continue;
      }

      if (coupon.usageLimitPerUser && requester?.userId) {
        const userUsageCount = await this.couponRepository.countUserCouponUsage(
          requester.userId,
          coupon.code
        );

        if (userUsageCount >= coupon.usageLimitPerUser) {
          continue;
        }
      }

      applicableCoupons.push(coupon);
    }

    return applicableCoupons;
  }

  async incrementUsage(couponId: string): Promise<ICoupon> {
    const coupon = await this.couponRepository.incrementUsageCount(couponId);

    if (!coupon) {
      throw new AppError({
        status: 404,
        code: 'COUPON_NOT_FOUND',
        message: 'Coupon not found',
      });
    }

    return coupon;
  }

  async decrementUsage(couponId: string): Promise<ICoupon> {
    const coupon = await this.couponRepository.decrementUsageCount(couponId);

    if (!coupon) {
      throw new AppError({
        status: 404,
        code: 'COUPON_NOT_FOUND',
        message: 'Coupon not found',
      });
    }

    return coupon;
  }

  async getByCorporateId(corporateId: string): Promise<ICoupon[]> {
    return this.couponRepository.findByCorporateId(corporateId);
  }
}
