import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireOperationalPharmacy } from '@/modules/middleware/auth';
import { PharmacySubscriptionController } from '@/modules/pharmacySubscriptions/controller';
import {
  createSubscriptionSchema,
  updateSubscriptionSchema,
  pauseSubscriptionSchema,
  idParamSchema,
} from '@/modules/pharmacySubscriptions/validation';

const pharmacySubscriptionRouter = Router();
const controller = new PharmacySubscriptionController();

pharmacySubscriptionRouter.post(
  '/',
  requireOperationalPharmacy,
  validate(createSubscriptionSchema, 'body'),
  catchAsync(controller.create)
);

pharmacySubscriptionRouter.get('/due', (_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store'); next();
}, requireOperationalPharmacy, catchAsync(controller.due));

pharmacySubscriptionRouter.get('/', requireOperationalPharmacy, catchAsync(controller.list));

pharmacySubscriptionRouter.put(
  '/:id',
  requireOperationalPharmacy,
  validate(idParamSchema, 'params'),
  validate(updateSubscriptionSchema, 'body'),
  catchAsync(controller.update)
);

pharmacySubscriptionRouter.post(
  '/:id/pause',
  requireOperationalPharmacy,
  validate(idParamSchema, 'params'),
  validate(pauseSubscriptionSchema, 'body'),
  catchAsync(controller.pause)
);

pharmacySubscriptionRouter.delete(
  '/:id',
  requireOperationalPharmacy,
  validate(idParamSchema, 'params'),
  catchAsync(controller.delete)
);

export default pharmacySubscriptionRouter;
