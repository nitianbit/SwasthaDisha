import { Schema, model, Model } from 'mongoose';
import { ICoupon } from '@/modules/coupon/types';

const couponSchema = new Schema<ICoupon>(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    }, // Unique coupon code (e.g., "WELCOME10", "SUMMER50") - stored in uppercase
    title: {
      type: String,
      trim: true,
    }, // Display title for the coupon
    description: {
      type: String,
      trim: true,
    }, // Description of the coupon offer
    corporateIds: {
      type: [String],
      default: [],
      index: true,
    }, // Corporate IDs if coupon is specific to one or more corporates
    userIds: {
      type: [String],
      default: [],
      index: true,
    }, // Specific user IDs allowed to use this coupon
    discountType: {
      type: String,
      enum: ['percentage', 'fixed'],
      required: true,
      index: true,
    }, // 'percentage' (e.g., 10% off) or 'fixed' (e.g., ₹500 off)
    discountValue: {
      type: Number,
      required: true,
      min: 0,
    }, // Discount percentage (e.g., 10) or fixed amount (e.g., 500)
    minimumPurchaseAmount: {
      type: Number,
      min: 0,
      index: true,
    }, // Minimum purchase amount required to use this coupon
    maximumDiscountAmount: {
      type: Number,
      min: 0,
    }, // Maximum discount amount (for percentage discounts, e.g., max ₹1000 off)
    eligibleFor: {
      type: String,
      enum: ['all', 'specialist', 'package', 'external_specialist', 'external_diagnostics'],
      index: true,
    }, // Broad product/category eligibility bucket
    forUser: {
      type: String,
      enum: ['self', 'all'],
      default: 'all',
      index: true,
    }, // Whether the coupon is only for self bookings or self + dependents
    applicableTo: {
      type: String,
      enum: ['all', 'wellnessPackage', 'consultation', 'specific'],
      required: true,
      index: true,
    }, // 'all' (all bookings), 'wellnessPackage', 'consultation', or 'specific' (specific IDs)
    applicableIds: {
      type: [String],
      default: [],
    }, // Existing specific IDs, used as vendor/provider/lab targeting
    applicablePackageIds: {
      type: [String],
      default: [],
    }, // Specific package IDs, primarily for external diagnostics
    applicableTestIds: {
      type: [String],
      default: [],
    }, // Specific test IDs, primarily for external diagnostics
    isBothRequired: {
      type: Boolean,
      default: false,
    }, // When both vendor/lab and package targeting are configured, require both to match
    startDate: {
      type: String,
      required: true,
      match: /^\d{8}$/, // YYYYMMDD format
      index: true,
    }, // Coupon validity start date (YYYYMMDD format)
    endDate: {
      type: String,
      required: true,
      match: /^\d{8}$/, // YYYYMMDD format
      index: true,
    }, // Coupon validity end date (YYYYMMDD format)
    usageLimitPerUser: {
      type: Number,
      min: 1,
    }, // Maximum times a single user can use this coupon (null = unlimited)
    totalUsageLimit: {
      type: Number,
      min: 1,
    }, // Maximum total times this coupon can be used (null = unlimited)
    currentUsageCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    }, // Current number of times this coupon has been used
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    }, // Whether coupon is currently active
  },
  {
    timestamps: true,
  }
);

// Indexes for better query performance
couponSchema.index({ code: 1, isActive: 1 });
couponSchema.index({ corporateIds: 1, isActive: 1 });
couponSchema.index({ userIds: 1, isActive: 1 });
couponSchema.index({ corporateIds: 1, startDate: 1, endDate: 1 });
couponSchema.index({ eligibleFor: 1, isActive: 1 });
couponSchema.index({ applicableTo: 1, isActive: 1 });
couponSchema.index({ startDate: 1, endDate: 1 });
couponSchema.index({ isActive: 1, startDate: 1, endDate: 1 }); // For finding active coupons in date range

const CouponModel: Model<ICoupon> = model<ICoupon>('Coupon', couponSchema);

export { CouponModel };
export default CouponModel;
