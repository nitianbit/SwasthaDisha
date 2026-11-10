import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin, requireAdminOrOperationalPharmacy } from '@/modules/middleware/auth';
import { MedicineController } from '@/modules/pharmacyMedicines/controller';
import {
  createMedicineSchema,
  updateMedicineSchema,
  medicineQuerySchema,
  nearbyMedicineQuerySchema,
  idParamSchema,
} from '@/modules/pharmacyMedicines/validation';

const pharmacyMedicineRouter = Router();
const medicineController = new MedicineController();

// Admin or pharmacy: create medicine in master catalog
pharmacyMedicineRouter.post(
  '/',
  requireAdminOrOperationalPharmacy,
  validate(createMedicineSchema, 'body'),
  catchAsync(medicineController.create)
);

// All authenticated: browse medicine catalog
pharmacyMedicineRouter.get(
  '/nearby',
  validate(nearbyMedicineQuerySchema, 'query'),
  catchAsync(medicineController.getNearby)
);

// All authenticated: browse medicine catalog
pharmacyMedicineRouter.get(
  '/',
  validate(medicineQuerySchema, 'query'),
  catchAsync(medicineController.getAll)
);

// All authenticated: get medicine by ID
pharmacyMedicineRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(medicineController.getById)
);

// Admin or pharmacy: update medicine
pharmacyMedicineRouter.put(
  '/:id',
  requireAdminOrOperationalPharmacy,
  validate(idParamSchema, 'params'),
  validate(updateMedicineSchema, 'body'),
  catchAsync(medicineController.update)
);

// Admin: delete medicine
pharmacyMedicineRouter.delete(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(medicineController.delete)
);

export default pharmacyMedicineRouter;
