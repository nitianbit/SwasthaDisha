import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requirePharmacy } from '@/modules/middleware/auth';
import { PatientTrackingController } from '@/modules/patientTracking/controller';
import { updateCustomerNotesSchema, userIdParamSchema } from '@/modules/pharmacyCustomers/validation';

const patientTrackingRouter = Router();
const controller = new PatientTrackingController();

// Pharmacy views a linked patient's summary
patientTrackingRouter.get('/:userId', requirePharmacy, catchAsync(controller.getSummary));

patientTrackingRouter.put(
  '/:userId',
  requirePharmacy,
  validate(userIdParamSchema, 'params'),
  validate(updateCustomerNotesSchema, 'body'),
  catchAsync(controller.update)
);

export default patientTrackingRouter;
