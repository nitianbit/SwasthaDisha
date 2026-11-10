import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin, requireAdminOrHR } from '@/modules/middleware/auth';
import { CouponController } from '@/modules/coupon/controller';
import {
  createCouponSchema,
  updateCouponSchema,
  couponQuerySchema,
  couponUsageQuerySchema,
  validateCouponSchema,
  idParamSchema,
  codeParamSchema,
} from '@/modules/coupon/validation';

const couponRouter = Router();

const couponController = new CouponController();

// Create coupon
couponRouter.post(
  '/',
  requireAdmin,
  validate(createCouponSchema, 'body'),
  catchAsync(couponController.create)
);

// Get all coupons (with optional query params)
// Supports: ?code=xxx&discountType=percentage&applicableTo=all&isActive=true&page=1&limit=10
couponRouter.get(
  '/',
  validate(couponQuerySchema, 'query'),
  catchAsync(couponController.getAll)
);

// Get active coupons (currently valid)
couponRouter.get(
  '/active',
  catchAsync(couponController.getActiveCoupons)
);

// Get applicable coupons for a booking type
// Supports: ?bookingType=package&bookingId=xxx
couponRouter.get(
  '/applicable',
  catchAsync(couponController.getApplicableCoupons)
);

// Get coupon by ID
couponRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(couponController.getById)
);

// Get coupon by code
couponRouter.get(
  '/code/:code',
  validate(codeParamSchema, 'params'),
  catchAsync(couponController.getByCode)
);

// Get coupon usage summary by code
couponRouter.get(
  '/usage/:code',
  requireAdminOrHR,
  validate(codeParamSchema, 'params'),
  validate(couponUsageQuerySchema, 'query'),
  catchAsync(couponController.getUsageByCode)
);

// Get all coupon usage summary by user ID
couponRouter.get(
  '/usage/user/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(couponUsageQuerySchema, 'query'),
  catchAsync(couponController.getUsageByUserId)
);

// Get coupons by corporate ID
// Example: /api/v1/coupons/corporate/6988310b8e6f65fbb238bcc9
couponRouter.get(
  '/corporate/:id',
  validate(idParamSchema, 'params'),
  catchAsync(couponController.getByCorporateId)
);

// Update coupon
couponRouter.put(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(updateCouponSchema, 'body'),
  catchAsync(couponController.update)
);

// Delete coupon
couponRouter.delete(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(couponController.delete)
);

// Validate coupon (check if coupon is valid for a booking)
couponRouter.post(
  '/validate',
  validate(validateCouponSchema, 'body'),
  catchAsync(couponController.validate)
);

export default couponRouter;
