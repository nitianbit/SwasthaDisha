import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireOperationalPharmacy } from '@/modules/middleware/auth';
import { PharmacyCustomerController } from '@/modules/pharmacyCustomers/controller';
import { createPharmacyCustomerSchema, customerSearchSchema, typedNameSchema } from '@/modules/pharmacyCustomers/validation';

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

// r36 (WQ50): the same list and guards with the search in the body (a phone or name never in a URL or proxy log).
pharmacyCustomerRouter.post(
  '/search',
  requireOperationalPharmacy,
  validate(customerSearchSchema, 'body'),
  catchAsync(controller.search)
);

// Assisted booking (§17.4): edit the name this pharmacy typed for a linked account holder.
pharmacyCustomerRouter.put(
  '/:id/typed-name',
  requireOperationalPharmacy,
  validate(typedNameSchema, 'body'),
  catchAsync(controller.setTypedName)
);

export default pharmacyCustomerRouter;
