import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { requireAdminOrOperationalPharmacy } from '@/modules/middleware/auth';
import { PharmacyTrackingController } from '@/modules/pharmacyTracking/controller';

const pharmacyTrackingRouter = Router();
const controller = new PharmacyTrackingController();

pharmacyTrackingRouter.get('/summary', requireAdminOrOperationalPharmacy, catchAsync(controller.getSummary));
pharmacyTrackingRouter.get('/summary/:pharmacyId', requireAdminOrOperationalPharmacy, catchAsync(controller.getSummary));

export default pharmacyTrackingRouter;
