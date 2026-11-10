import 'reflect-metadata';
import { Router } from 'express';

import { CampController } from '@/modules/camps/controller';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { authenticate, requireAdmin } from '@/modules/middleware/auth';
import {
  campListQuerySchema,
  campLsIdParamSchema,
  placeCampOrderSchema,
} from '@/modules/camps/validation';

const campRouter = Router();
const campController = new CampController();

campRouter.get(
  '/',
  authenticate,
  requireAdmin,
  validate(campListQuerySchema, 'query'),
  catchAsync(campController.getCamps)
);

campRouter.get(
  '/:campLsId',
  authenticate,
  requireAdmin,
  validate(campLsIdParamSchema, 'params'),
  catchAsync(campController.getCampDetails)
);

campRouter.get(
  '/:campLsId/slots',
  authenticate,
  requireAdmin,
  validate(campLsIdParamSchema, 'params'),
  catchAsync(campController.getCampSlots)
);

campRouter.post(
  '/orders/bulk',
  authenticate,
  requireAdmin,
  catchAsync(campController.bulkPlaceCampOrders)
);

campRouter.post(
  '/orders',
  authenticate,
  requireAdmin,
  validate(placeCampOrderSchema, 'body'),
  catchAsync(campController.placeCampOrder)
);

export default campRouter;
