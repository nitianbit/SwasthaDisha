import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin } from '@/modules/middleware/auth';
import { HealthTipController } from '@/modules/healthTips/controller';
import {
  createHealthTipSchema,
  updateHealthTipSchema,
  healthTipQuerySchema,
  idParamSchema,
  categoryParamSchema,
} from '@/modules/healthTips/validation';

const healthTipRouter = Router();

const healthTipController = new HealthTipController();

// Create health tip
healthTipRouter.post(
  '/',
  requireAdmin,
  validate(createHealthTipSchema, 'body'),
  catchAsync(healthTipController.create)
);

// Get all health tips (with optional query params)
healthTipRouter.get(
  '/',
  validate(healthTipQuerySchema, 'query'),
  catchAsync(healthTipController.getAll)
);

// Get active health tips only
healthTipRouter.get(
  '/active',
  catchAsync(healthTipController.getActiveTips)
);

// Get health tips by category
healthTipRouter.get(
  '/category/:category',
  validate(categoryParamSchema, 'params'),
  catchAsync(healthTipController.getByCategory)
);

// Get health tip by ID
healthTipRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(healthTipController.getById)
);

// Update health tip
healthTipRouter.put(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(updateHealthTipSchema, 'body'),
  catchAsync(healthTipController.update)
);

// Delete health tip
healthTipRouter.delete(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(healthTipController.delete)
);

export default healthTipRouter;
