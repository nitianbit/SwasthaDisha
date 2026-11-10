import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin, requireSpecialist } from '@/modules/middleware/auth';
import { SpecialistController } from '@/modules/specialists/controller';
import {
  createSpecialistSchema,
  updateSpecialistSchema,
  specialistQuerySchema,
  specialistStatsQuerySchema,
  idParamSchema,
  specializationParamSchema,
} from '@/modules/specialists/validation';
import {
  specialistCreateSlotSchema,
  specialistUpdateSlotSchema,
  specialistProfileUpdateSchema,
  specialistSlotsQuerySchema,
  specialistAppointmentsQuerySchema,
  updateAppointmentStatusSchema,
  patientUserIdParamSchema,
  specialistAppointmentPrescriptionSchema,
} from '@/modules/specialistPortal/validation';

const specialistRouter = Router();

const specialistController = new SpecialistController();

// Create specialist
specialistRouter.post(
  '/',
  requireAdmin,
  validate(createSpecialistSchema, 'body'),
  catchAsync(specialistController.create)
);

// Get all specialists (with optional query params)
// Supports: ?specialization=Gynaecologist&isVerified=true&minRating=4&city=Mumbai&page=1&limit=10
specialistRouter.get(
  '/',
  validate(specialistQuerySchema, 'query'),
  catchAsync(specialistController.getAll)
);

// Get verified specialists
specialistRouter.get(
  '/verified',
  catchAsync(specialistController.getVerifiedSpecialists)
);

// Get specialists by specialization
specialistRouter.get(
  '/specialization/:specialization',
  validate(specializationParamSchema, 'params'),
  catchAsync(specialistController.getBySpecialization)
);

// Self-service specialist routes
specialistRouter.get(
  '/me/profile',
  requireSpecialist,
  catchAsync(specialistController.getMyProfile)
);

specialistRouter.get(
  '/me/stats',
  requireSpecialist,
  validate(specialistStatsQuerySchema, 'query'),
  catchAsync(specialistController.getMyStats)
);

specialistRouter.put(
  '/me/profile',
  requireSpecialist,
  validate(specialistProfileUpdateSchema, 'body'),
  catchAsync(specialistController.updateMyProfile)
);

specialistRouter.get(
  '/me/slots',
  requireSpecialist,
  validate(specialistSlotsQuerySchema, 'query'),
  catchAsync(specialistController.listMySlots)
);

specialistRouter.post(
  '/me/slots',
  requireSpecialist,
  validate(specialistCreateSlotSchema, 'body'),
  catchAsync(specialistController.createMySlot)
);

specialistRouter.put(
  '/me/slots/:id',
  requireSpecialist,
  validate(idParamSchema, 'params'),
  validate(specialistUpdateSlotSchema, 'body'),
  catchAsync(specialistController.updateMySlot)
);

specialistRouter.delete(
  '/me/slots/:id',
  requireSpecialist,
  validate(idParamSchema, 'params'),
  catchAsync(specialistController.deleteMySlot)
);

specialistRouter.get(
  '/me/appointments',
  requireSpecialist,
  validate(specialistAppointmentsQuerySchema, 'query'),
  catchAsync(specialistController.listMyAppointments)
);

specialistRouter.get(
  '/me/appointments/:id',
  requireSpecialist,
  validate(idParamSchema, 'params'),
  catchAsync(specialistController.getMyAppointmentById)
);

specialistRouter.patch(
  '/me/appointments/:id/status',
  requireSpecialist,
  validate(idParamSchema, 'params'),
  validate(updateAppointmentStatusSchema, 'body'),
  catchAsync(specialistController.updateMyAppointmentStatus)
);

specialistRouter.post(
  '/me/appointments/:id/prescription',
  requireSpecialist,
  validate(idParamSchema, 'params'),
  validate(specialistAppointmentPrescriptionSchema, 'body'),
  catchAsync(specialistController.createMyAppointmentPrescription)
);

specialistRouter.get(
  '/me/patients/:userId/history',
  requireSpecialist,
  validate(patientUserIdParamSchema, 'params'),
  catchAsync(specialistController.getMyPatientHistory)
);

specialistRouter.get(
  '/:id/stats',
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(specialistStatsQuerySchema, 'query'),
  catchAsync(specialistController.getStatsById)
);

// Get specialist by ID (must be last to avoid route conflicts)
specialistRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(specialistController.getById)
);

// Update specialist
specialistRouter.put(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(updateSpecialistSchema, 'body'),
  catchAsync(specialistController.update)
);

// Delete specialist
specialistRouter.delete(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(specialistController.delete)
);

export default specialistRouter;
