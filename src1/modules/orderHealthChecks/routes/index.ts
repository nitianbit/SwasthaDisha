import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requirePharmacy } from '@/modules/middleware/auth';
import { OrderHealthCheckController } from '@/modules/orderHealthChecks/controller';
import {
  createHealthCheckSchema,
  updateHealthCheckSchema,
  orderIdParamSchema,
} from '@/modules/orderHealthChecks/validation';

const orderHealthCheckRouter = Router({ mergeParams: true });
const controller = new OrderHealthCheckController();

// These routes are mounted under /api/v1/pharmacy-orders/:orderId/health-check
orderHealthCheckRouter.post(
  '/',
  requirePharmacy,
  validate(orderIdParamSchema, 'params'),
  validate(createHealthCheckSchema, 'body'),
  catchAsync(controller.create)
);

orderHealthCheckRouter.put(
  '/',
  requirePharmacy,
  validate(orderIdParamSchema, 'params'),
  validate(updateHealthCheckSchema, 'body'),
  catchAsync(controller.update)
);

orderHealthCheckRouter.get(
  '/',
  validate(orderIdParamSchema, 'params'),
  catchAsync(controller.getByOrder)
);

export default orderHealthCheckRouter;
