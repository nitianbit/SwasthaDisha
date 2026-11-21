import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin } from '@/modules/middleware/auth';
import { adminClearBodySchema, clearBookingPrescription, clearBookingReport } from '@/modules/bookings/adminClear';
import { BookingController } from '@/modules/bookings/controller';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';
import { gatePharmacyBookingCreate, gatePharmacyBookingRetry } from '@/modules/bookings/pharmacyBookingGate';
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
import { dropServerOwnedCreateFields } from '@/modules/bookings/serverOwnedFields';

const bookingRouter = Router();

const bookingController = new BookingController();

// S2: these generic booking routes serve customers, admins, HR, specialists and pharmacies only (partner and any other
// role is refused). Each handler then scopes the booking to the caller.
const BOOKING_ROLES = new Set(['user', 'admin', 'hr', 'specialist', 'pharmacy']);
bookingRouter.use((req: AuthRequest, _res, next) => {
  next(req.user && BOOKING_ROLES.has(req.user.userType)
    ? undefined
    : new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access to this booking resource is not permitted' }));
});

// S4: create bodies never carry the server-owned prescription / report (dropped and logged; see serverOwnedFields).
bookingRouter.use(dropServerOwnedCreateFields);

// Create wellness package booking
bookingRouter.post(
  '/wellness-package',
  validate(createWellnessPackageBookingSchema, 'body'),
  catchAsync(gatePharmacyBookingCreate),
  catchAsync(bookingController.createWellnessPackageBooking)
);

// Create specialist booking
bookingRouter.post(
  '/specialist',
  validate(createSpecialistBookingSchema, 'body'),
  catchAsync(gatePharmacyBookingCreate),
  catchAsync(bookingController.createSpecialistBooking)
);

// Unified create booking API
bookingRouter.post(
  '/',
  validate(createBookingSchema, 'body'),
  catchAsync(gatePharmacyBookingCreate),
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

// Check every payment attempt of a booking with the gateway; applies a capture whose confirmation was lost (W3b)
bookingRouter.post(
  '/:id/reconcile-payments',
  validate(idParamSchema, 'params'),
  catchAsync(bookingController.reconcilePayments)
);

// Retry payment for an existing booking
bookingRouter.post(
  '/:id/retry-payment',
  validate(idParamSchema, 'params'),
  validate(retryPaymentBodySchema, 'body'),
  catchAsync(gatePharmacyBookingRetry),
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

// S5: an admin removes a planted prescription (and its marker) or report; reason required, audited.
bookingRouter.delete(
  '/:id/prescription',
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(adminClearBodySchema, 'body'),
  catchAsync(clearBookingPrescription)
);

bookingRouter.delete(
  '/:id/report',
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(adminClearBodySchema, 'body'),
  catchAsync(clearBookingReport)
);

export default bookingRouter;
