import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin } from '@/modules/middleware/auth';
import { WellnessPackageController } from '@/modules/wellnessPackages/controller';
import {
  createWellnessPackageSchema,
  updateWellnessPackageSchema,
  wellnessPackageQuerySchema,
  idParamSchema,
} from '@/modules/wellnessPackages/validation';

const wellnessPackageRouter = Router();

const wellnessPackageController = new WellnessPackageController();

// Create wellness package
wellnessPackageRouter.post(
  '/',
  requireAdmin,
  validate(createWellnessPackageSchema, 'body'),
  catchAsync(wellnessPackageController.create)
);

// Get all wellness packages (with optional query params)
// Supports: ?isPopular=true&isActive=true&category=diagnostics&search=checkup&page=1&limit=10
wellnessPackageRouter.get(
  '/',
  validate(wellnessPackageQuerySchema, 'query'),
  catchAsync(wellnessPackageController.getAll)
);

// Get wellness package by ID
wellnessPackageRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(wellnessPackageController.getById)
);

// Update wellness package
wellnessPackageRouter.put(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(updateWellnessPackageSchema, 'body'),
  catchAsync(wellnessPackageController.update)
);

// Delete wellness package
wellnessPackageRouter.delete(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(wellnessPackageController.delete)
);

export default wellnessPackageRouter;
