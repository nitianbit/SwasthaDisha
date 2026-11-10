import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { BookingController } from '@/modules/bookings/controller';
import {
  cancelBookingSchema,
  createBookingSchema,
  rescheduleBookingSchema,
  createWellnessPackageBookingSchema,
  createSpecialistBookingSchema,
  updateBookingSchema,
  bookingQuerySchema,
  idParamSchema,
  retryPaymentBodySchema,
  userIdParamSchema,
} from '@/modules/bookings/validation';

const bookingRouter = Router();

const bookingController = new BookingController();

// Create wellness package booking
bookingRouter.post(
  '/wellness-package',
  validate(createWellnessPackageBookingSchema, 'body'),
  catchAsync(bookingController.createWellnessPackageBooking)
);

// Create specialist booking
bookingRouter.post(
  '/specialist',
  validate(createSpecialistBookingSchema, 'body'),
  catchAsync(bookingController.createSpecialistBooking)
);

// Unified create booking API
bookingRouter.post(
  '/',
  validate(createBookingSchema, 'body'),
  catchAsync(bookingController.createBooking)
);

// Get all bookings (with optional query params)
// Supports: ?userId=xxx&bookingType=package&status=confirmed&page=1&limit=10
bookingRouter.get(
  '/',
  validate(bookingQuerySchema, 'query'),
  catchAsync(bookingController.getAll)
);

// Get bookings by userId
bookingRouter.get(
  '/user/:userId',
  validate(userIdParamSchema, 'params'),
  catchAsync(bookingController.getByUserId)
);

// Get upcoming bookings
bookingRouter.get(
  '/upcoming',
  validate(bookingQuerySchema, 'query'),
  catchAsync(bookingController.getUpcomingBookings)
);

// Retry payment for an existing booking
bookingRouter.post(
  '/:id/retry-payment',
  validate(idParamSchema, 'params'),
  validate(retryPaymentBodySchema, 'body'),
  catchAsync(bookingController.retryPayment)
);

bookingRouter.post(
  '/:id/cancel',
  validate(idParamSchema, 'params'),
  validate(cancelBookingSchema, 'body'),
  catchAsync(bookingController.cancelBooking)
);

bookingRouter.post(
  '/:id/reschedule',
  validate(idParamSchema, 'params'),
  validate(rescheduleBookingSchema, 'body'),
  catchAsync(bookingController.rescheduleBooking)
);

// Get booking by ID (optionally filter by userId in query)
bookingRouter.get(
  '/:id/payment-details',
  validate(idParamSchema, 'params'),
  catchAsync(bookingController.getPaymentDetails)
);

// Get booking by ID (optionally filter by userId in query)
bookingRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(bookingQuerySchema, 'query'),
  catchAsync(bookingController.getById)
);

// Update booking (optionally filter by userId in query)
bookingRouter.put(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updateBookingSchema, 'body'),
  validate(bookingQuerySchema, 'query'),
  catchAsync(bookingController.update)
);

// Delete booking (optionally filter by userId in query)
bookingRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(bookingQuerySchema, 'query'),
  catchAsync(bookingController.delete)
);

export default bookingRouter;
