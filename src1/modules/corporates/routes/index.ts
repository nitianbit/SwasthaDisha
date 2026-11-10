import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin } from '@/modules/middleware/auth';
import { CorporateController } from '@/modules/corporates/controller';
import {
  createCorporateSchema,
  updateCorporateSchema,
  corporateQuerySchema,
  idParamSchema,
  industryParamSchema,
} from '@/modules/corporates/validation';

const corporateRouter = Router();

const corporateController = new CorporateController();

// Create corporate
corporateRouter.post(
  '/',
  requireAdmin,
  validate(createCorporateSchema, 'body'),
  catchAsync(corporateController.create)
);

// Get all corporates (with optional query params)
// Supports: ?industry=IT&city=Mumbai&isVerified=true&search=tech&page=1&limit=10
corporateRouter.get(
  '/',
  validate(corporateQuerySchema, 'query'),
  catchAsync(corporateController.getAll)
);

// Get verified corporates
corporateRouter.get(
  '/verified',
  catchAsync(corporateController.getVerifiedCorporates)
);

// Get corporates by industry
corporateRouter.get(
  '/industry/:industry',
  validate(industryParamSchema, 'params'),
  catchAsync(corporateController.getByIndustry)
);

// Get specialists for a corporate
corporateRouter.get(
  '/:id/specialists',
  validate(idParamSchema, 'params'),
  catchAsync(corporateController.getSpecialists)
);

// Add a specialist to a corporate
corporateRouter.post(
  '/:id/specialists/:specialistId',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(corporateController.addSpecialist)
);

// Remove a specialist from a corporate
corporateRouter.delete(
  '/:id/specialists/:specialistId',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(corporateController.removeSpecialist)
);

// Get wellness packages for a corporate
corporateRouter.get(
  '/:id/wellness-packages',
  validate(idParamSchema, 'params'),
  catchAsync(corporateController.getWellnessPackages)
);

// Add a wellness package to a corporate
corporateRouter.post(
  '/:id/wellness-packages/:packageId',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(corporateController.addWellnessPackage)
);

// Remove a wellness package from a corporate
corporateRouter.delete(
  '/:id/wellness-packages/:packageId',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(corporateController.removeWellnessPackage)
);

// Get corporate by ID
corporateRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(corporateController.getById)
);

// Update corporate
corporateRouter.put(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(updateCorporateSchema, 'body'),
  catchAsync(corporateController.update)
);

// Delete corporate
corporateRouter.delete(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(corporateController.delete)
);

export default corporateRouter;
