import 'reflect-metadata';
import { Router, type Response } from 'express';
import Joi from 'joi';
import PharmacyModel from '@/modules/pharmacies/model';
import type { AuthRequest } from '@/modules/middleware/auth';
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

// P9: the pharmacy's registered pharmacist (name + registration number), used by one-button prescription approval.
const pharmacistSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  registrationNumber: Joi.string().trim().pattern(/^[A-Za-z0-9][A-Za-z0-9/\-. ]{2,59}$/).required(),
});
pharmacyRouter.put(
  '/me/pharmacist',
  requirePharmacy,
  validate(pharmacistSchema, 'body'),
  catchAsync(async (req: AuthRequest, res: Response) => {
    const pharmacyId = String(req.user?.pharmacyId || '');
    const pharmacist = { name: String(req.body.name).trim(), registrationNumber: String(req.body.registrationNumber).trim(), updatedAt: new Date() };
    const updated = await PharmacyModel.findOneAndUpdate({ _id: pharmacyId }, { $set: { pharmacist } }, { new: true }).select({ pharmacist: 1 }).lean();
    res.status(200).json({ success: true, data: { pharmacist: updated?.pharmacist ?? null } });
  })
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
