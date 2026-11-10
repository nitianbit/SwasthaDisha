import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireOperationalPharmacy } from '@/modules/middleware/auth';
import { PharmacyCustomerController } from '@/modules/pharmacyCustomers/controller';
import { createPharmacyCustomerSchema } from '@/modules/pharmacyCustomers/validation';

const pharmacyCustomerRouter = Router();
const controller = new PharmacyCustomerController();

// Create / link customer (pharmacy only)
pharmacyCustomerRouter.post(
  '/',
  requireOperationalPharmacy,
  validate(createPharmacyCustomerSchema, 'body'),
  catchAsync(controller.create)
);

// List pharmacy's linked customers (pharmacy only)
pharmacyCustomerRouter.get(
  '/',
  requireOperationalPharmacy,
  catchAsync(controller.list)
);

export default pharmacyCustomerRouter;
