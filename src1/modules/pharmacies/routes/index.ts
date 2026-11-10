import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import {
  requireAdmin,
  requireAdminOrOperationalPharmacy,
  requirePharmacy,
} from '@/modules/middleware/auth';
import { PharmacyController } from '@/modules/pharmacies/controller';
import {
  createPharmacySchema,
  medicineAvailabilityQuerySchema,
  pharmacyQuerySchema,
  updatePharmacySchema,
  updateMyPharmacySchema,
  idParamSchema,
} from '@/modules/pharmacies/validation';

const pharmacyRouter = Router();
const publicPharmacyRouter = Router();
const pharmacyController = new PharmacyController();

// Admin/pharmacy: create pharmacy
pharmacyRouter.post(
  '/',
  requireAdminOrOperationalPharmacy,
  validate(createPharmacySchema, 'body'),
  catchAsync(pharmacyController.create)
);

publicPharmacyRouter.get(
  '/medicine-availability',
  validate(medicineAvailabilityQuerySchema, 'query'),
  catchAsync(pharmacyController.getMedicineAvailability)
);

publicPharmacyRouter.get(
  '/',
  validate(pharmacyQuerySchema, 'query'),
  catchAsync(pharmacyController.getAll)
);

// Pharmacy self-service: get own profile
pharmacyRouter.get(
  '/me/profile',
  requirePharmacy,
  catchAsync(pharmacyController.getMyProfile)
);

// Pharmacy self-service: update own profile (limited fields, no isVerified/walletEnabled)
pharmacyRouter.put(
  '/me/profile',
  requirePharmacy,
  validate(updateMyPharmacySchema, 'body'),
  catchAsync(pharmacyController.updateMyProfile)
);

pharmacyRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(pharmacyController.getById)
);

// Admin: update pharmacy
pharmacyRouter.put(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(updatePharmacySchema, 'body'),
  catchAsync(pharmacyController.update)
);

// Admin: delete pharmacy
pharmacyRouter.delete(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(pharmacyController.delete)
);

export default pharmacyRouter;
export { publicPharmacyRouter };
