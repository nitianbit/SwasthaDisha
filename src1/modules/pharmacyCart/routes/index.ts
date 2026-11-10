import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { PharmacyCartController } from '@/modules/pharmacyCart/controller';
import {
  addCartItemSchema,
  checkoutCartSchema,
  medicineIdParamSchema,
} from '@/modules/pharmacyCart/validation';

const pharmacyCartRouter = Router();
const controller = new PharmacyCartController();

pharmacyCartRouter.get('/', catchAsync(controller.getCart));

pharmacyCartRouter.post(
  '/checkout',
  validate(checkoutCartSchema, 'body'),
  catchAsync(controller.checkout)
);

pharmacyCartRouter.post(
  '/items',
  validate(addCartItemSchema, 'body'),
  catchAsync(controller.addItem)
);

pharmacyCartRouter.delete(
  '/items/:medicineId',
  validate(medicineIdParamSchema, 'params'),
  catchAsync(controller.removeItem)
);

pharmacyCartRouter.delete('/', catchAsync(controller.clearCart));

export default pharmacyCartRouter;
