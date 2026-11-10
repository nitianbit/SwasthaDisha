import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin } from '@/modules/middleware/auth';
import { SlotController } from '@/modules/slots/controller';
import {
  createSlotSchema,
  updateSlotSchema,
  slotQuerySchema,
  idParamSchema,
  specialistIdParamSchema,
  wellnessPackageIdParamSchema,
} from '@/modules/slots/validation';

const slotRouter = Router();

const slotController = new SlotController();

// Create slot
slotRouter.post(
  '/',
  requireAdmin,
  validate(createSlotSchema, 'body'),
  catchAsync(slotController.create)
);

// Get all slots (with optional query params)
// Supports: ?specialistId=xxx&date=2025-07-12&isAvailable=true&page=1&limit=10
slotRouter.get(
  '/',
  validate(slotQuerySchema, 'query'),
  catchAsync(slotController.getAll)
);

// Get available slots
slotRouter.get(
  '/available',
  validate(slotQuerySchema, 'query'),
  catchAsync(slotController.getAvailableSlots)
);

// Get slots by specialist ID
slotRouter.get(
  '/specialist/:specialistId',
  validate(specialistIdParamSchema, 'params'),
  validate(slotQuerySchema, 'query'),
  catchAsync(slotController.getBySpecialistId)
);

// Get slots by wellness package ID
slotRouter.get(
  '/wellness-package/:wellnessPackageId',
  validate(wellnessPackageIdParamSchema, 'params'),
  validate(slotQuerySchema, 'query'),
  catchAsync(slotController.getByWellnessPackageId)
);

// Increment booking count (when a booking is created)
slotRouter.post(
  '/:id/increment-booking',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(slotController.incrementBookingCount)
);

// Decrement booking count (when a booking is cancelled)
slotRouter.post(
  '/:id/decrement-booking',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(slotController.decrementBookingCount)
);

// Get slot by ID
slotRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(slotController.getById)
);

// Update slot
slotRouter.put(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(updateSlotSchema, 'body'),
  catchAsync(slotController.update)
);

// Delete slot
slotRouter.delete(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(slotController.delete)
);

export default slotRouter;
