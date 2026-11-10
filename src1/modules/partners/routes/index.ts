import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin } from '@/modules/middleware/auth';
import { PartnerController } from '@/modules/partners/controller';
import {
  createPartnerSchema,
  updatePartnerSchema,
  partnerQuerySchema,
  idParamSchema,
  partnerTypeParamSchema,
} from '@/modules/partners/validation';

const partnerRouter = Router();

const partnerController = new PartnerController();

// Create partner
partnerRouter.post(
  '/',
  requireAdmin,
  validate(createPartnerSchema, 'body'),
  catchAsync(partnerController.create)
);

// Get all partners (with optional query params)
// Supports: ?partnerType=hospital&isVerified=true&city=Mumbai&page=1&limit=10
partnerRouter.get(
  '/',
  validate(partnerQuerySchema, 'query'),
  catchAsync(partnerController.getAll)
);

// Get verified partners
partnerRouter.get(
  '/verified',
  catchAsync(partnerController.getVerifiedPartners)
);

// Get partners by partner type
partnerRouter.get(
  '/type/:partnerType',
  validate(partnerTypeParamSchema, 'params'),
  catchAsync(partnerController.getByPartnerType)
);

// Get partner by ID
partnerRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(partnerController.getById)
);

// Update partner
partnerRouter.put(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(updatePartnerSchema, 'body'),
  catchAsync(partnerController.update)
);

// Delete partner
partnerRouter.delete(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(partnerController.delete)
);

export default partnerRouter;
