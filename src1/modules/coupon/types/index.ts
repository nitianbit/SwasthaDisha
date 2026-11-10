/**
 * Coupon Module Types
 * 
 * Coupon System:
 * - Coupons provide discounts on bookings (wellness packages or consultations)
 * - Discount can be percentage-based or fixed amount
 * - Coupons have validity dates and usage limits
 * - Can be applicable to specific services or all services
 * 
 * Discount Types:
 * - 'percentage': Discount is a percentage (e.g., 10% off)
 * - 'fixed': Discount is a fixed amount (e.g., ₹500 off)
 * 
 * Applicable To:
 * - 'all': Applicable to all bookings
 * - 'wellnessPackage': Only for wellness package bookings
 * - 'consultation': Only for consultation bookings
 * - 'specific': For specific package/specialist IDs (stored in applicableIds)
 */

export type DiscountType = 'percentage' | 'fixed';

export type ApplicableTo = 'all' | 'wellnessPackage' | 'consultation' | 'specific';
export type EligibleFor =
  | 'all'
  | 'specialist'
  | 'package'
  | 'external_specialist'
  | 'external_diagnostics';
export type CouponForUser = 'self' | 'all';

export interface ICoupon {
  _id?: string;
  code: string; // Unique coupon code (e.g., "WELCOME10", "SUMMER50")
  title?: string; // Display title for the coupon
  description?: string; // Description of the coupon offer
  corporateIds?: string[]; // Corporate IDs if coupon is specific to one or more corporates
  userIds?: string[]; // Specific user IDs allowed to use this coupon
  discountType: DiscountType; // 'percentage' or 'fixed'
  discountValue: number; // Discount percentage (e.g., 10) or fixed amount (e.g., 500)
  minimumPurchaseAmount?: number; // Minimum purchase amount required to use this coupon
  maximumDiscountAmount?: number; // Maximum discount amount (for percentage discounts, e.g., max ₹1000 off)
  eligibleFor?: EligibleFor; // Broad product/category eligibility bucket
  forUser?: CouponForUser; // Whether the coupon is only for self bookings or self + dependents
  applicableTo: ApplicableTo; // 'all', 'wellnessPackage', 'consultation', or 'specific'
  applicableIds?: string[]; // Existing specific IDs, used as vendor/provider/lab targeting
  applicablePackageIds?: string[]; // Specific package IDs, primarily for external diagnostics
  applicableTestIds?: string[]; // Specific test IDs, primarily for external diagnostics
  isBothRequired?: boolean; // When both vendor/lab and package targeting are configured, require both to match
  startDate: string; // YYYYMMDD format - Coupon validity start date
  endDate: string; // YYYYMMDD format - Coupon validity end date
  usageLimitPerUser?: number; // Maximum times a single user can use this coupon (null = unlimited)
  totalUsageLimit?: number; // Maximum total times this coupon can be used (null = unlimited)
  currentUsageCount: number; // Current number of times this coupon has been used
  isActive: boolean; // Whether coupon is currently active
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateCouponRequest {
  code: string;
  title?: string;
  description?: string;
  corporateIds?: string[]; // Corporate IDs if coupon is specific to one or more corporates
  userIds?: string[]; // Specific user IDs allowed to use this coupon
  discountType: DiscountType;
  discountValue: number;
  minimumPurchaseAmount?: number;
  maximumDiscountAmount?: number;
  eligibleFor?: EligibleFor;
  forUser?: CouponForUser;
  applicableTo: ApplicableTo;
  applicableIds?: string[]; // Vendor/provider/lab specific IDs
  applicablePackageIds?: string[]; // Package-specific IDs
  applicableTestIds?: string[]; // Test-specific IDs
  isBothRequired?: boolean;
  startDate: string; // YYYYMMDD format
  endDate: string; // YYYYMMDD format
  usageLimitPerUser?: number;
  totalUsageLimit?: number;
  isActive?: boolean;
}

export interface UpdateCouponRequest {
  title?: string;
  description?: string;
  corporateIds?: string[]; // Corporate IDs if coupon is specific to one or more corporates
  userIds?: string[]; // Specific user IDs allowed to use this coupon
  discountType?: DiscountType;
  discountValue?: number;
  minimumPurchaseAmount?: number;
  maximumDiscountAmount?: number;
  eligibleFor?: EligibleFor;
  forUser?: CouponForUser;
  applicableTo?: ApplicableTo;
  applicableIds?: string[];
  applicablePackageIds?: string[];
  applicableTestIds?: string[];
  isBothRequired?: boolean;
  startDate?: string; // YYYYMMDD format
  endDate?: string; // YYYYMMDD format
  usageLimitPerUser?: number;
  totalUsageLimit?: number;
  isActive?: boolean;
}

export interface ValidateCouponRequest {
  code: string;
  userId: string; // User trying to use the coupon
  bookingType:
    | 'package'
    | 'consultation'
    | 'second-opinion'
    | 'surgery'
    | 'wallet_recharge'
    | 'external_specialist'
    | 'external_diagnostics'; // Type of booking
  bookingId?: string; // ID of wellness package or specialist
  packageIds?: string[]; // Selected package IDs, primarily for external diagnostics
  testIds?: string[]; // Selected test IDs, primarily for external diagnostics
  dependentId?: string; // Present when the booking is for a dependent
  corporateId?: string; // Corporate context of the user
  purchaseAmount: number; // Total purchase amount
}

export interface ValidateWalletCouponRequest {
  code: string;
  userId: string;
  purchaseAmount: number;
}

export interface CouponQueryParams {
  code?: string;
  title?: string;
  corporateId?: string; // Filter by a corporate ID present in corporateIds
  discountType?: DiscountType;
  eligibleFor?: EligibleFor;
  applicableTo?: ApplicableTo;
  isActive?: boolean;
  startDateFrom?: string; // YYYYMMDD format
  startDateTo?: string; // YYYYMMDD format
  endDateFrom?: string; // YYYYMMDD format
  endDateTo?: string; // YYYYMMDD format
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface CouponUsageQueryParams {
  page?: number;
  limit?: number;
  corporateId?: string;
  userIds?: string[];
}

export interface CouponUsageUserSummary {
  userId: string;
  usageCount: number;
  totalDiscountAmount: number;
  contexts: string[];
  firstUsedAt?: Date;
  lastUsedAt?: Date;
}

export interface CouponUsageSummary {
  couponCode: string;
  totalUses: number;
  totalUsers: number;
  users: CouponUsageUserSummary[];
  page: number;
  limit: number;
  totalPages: number;
}

export interface UserCouponUsageSummaryItem {
  couponCode: string;
  usageCount: number;
  totalDiscountAmount: number;
  contexts: string[];
  firstUsedAt?: Date;
  lastUsedAt?: Date;
}

export interface UserCouponUsageSummary {
  userId: string;
  totalUses: number;
  totalCoupons: number;
  coupons: UserCouponUsageSummaryItem[];
  page: number;
  limit: number;
  totalPages: number;
}
