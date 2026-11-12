import 'reflect-metadata';
import { Router } from 'express';
import { requireOperationalPharmacy } from '@/modules/middleware/auth';
import { validate } from '@/modules/common/middleware/validation';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { PharmacySupplierController } from '@/modules/pharmacySuppliers/controller';
import { supplierListQuerySchema } from '@/modules/pharmacySuppliers/validation';

const supplierRouter = Router();
const controller = new PharmacySupplierController();

supplierRouter.get('/', requireOperationalPharmacy, validate(supplierListQuerySchema, 'query'), catchAsync(controller.list));
// Raw write keys reach the authoritative owned command flow unchanged.
supplierRouter.post('/', requireOperationalPharmacy, catchAsync(controller.create));
supplierRouter.patch('/:id', requireOperationalPharmacy, catchAsync(controller.update));
supplierRouter.post('/:id/archive', requireOperationalPharmacy, catchAsync(controller.archive));

export default supplierRouter;
