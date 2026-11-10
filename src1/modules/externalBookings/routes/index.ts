import 'reflect-metadata';
import { Router } from 'express';

import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { ExternalBookingController } from '@/modules/externalBookings/controller';
import {
  cancelExternalBookingSchema,
  createExternalDiagnosticsBookingSchema,
  createExternalBookingSchema,
  externalBookingIdParamSchema,
  externalBookingListQuerySchema,
  externalDiagnosticsReportQuerySchema,
  externalReportDocumentQuerySchema,
  externalPackageQuerySchema,
  externalDiagnosticsSlotsQuerySchema,
  externalLabsQuerySchema,
  externalPackagePreparationsQuerySchema,
  externalPackagesQuerySchema,
  externalServiceabilityQuerySchema,
  externalSlotsQuerySchema,
  externalSpecialistsQuerySchema,
  externalTestQuerySchema,
  externalTestsQuerySchema,
  providerTypesQuerySchema,
  rescheduleExternalBookingSchema,
  rescheduleExternalDiagnosticsBookingSchema,
  retryExternalPaymentBodySchema,
} from '@/modules/externalBookings/validation';

const externalBookingRouter = Router();
const externalBookingController = new ExternalBookingController();

externalBookingRouter.get(
  '/provider-types',
  validate(providerTypesQuerySchema, 'query'),
  catchAsync(externalBookingController.getProviderTypes)
);

externalBookingRouter.get(
  '/packages',
  validate(externalPackagesQuerySchema, 'query'),
  catchAsync(externalBookingController.getPackages)
);

externalBookingRouter.get(
  '/package',
  validate(externalPackageQuerySchema, 'query'),
  catchAsync(externalBookingController.getPackage)
);

externalBookingRouter.get(
  '/tests',
  validate(externalTestsQuerySchema, 'query'),
  catchAsync(externalBookingController.getTests)
);

externalBookingRouter.get(
  '/test',
  validate(externalTestQuerySchema, 'query'),
  catchAsync(externalBookingController.getTest)
);

externalBookingRouter.get(
  '/labs',
  validate(externalLabsQuerySchema, 'query'),
  catchAsync(externalBookingController.getLabs)
);

externalBookingRouter.get(
  '/serviceability',
  validate(externalServiceabilityQuerySchema, 'query'),
  catchAsync(externalBookingController.getServiceability)
);

externalBookingRouter.get(
  '/package-preparations',
  validate(externalPackagePreparationsQuerySchema, 'query'),
  catchAsync(externalBookingController.getPackagePreparations)
);

externalBookingRouter.get(
  '/diagnostics/slots',
  validate(externalDiagnosticsSlotsQuerySchema, 'query'),
  catchAsync(externalBookingController.getDiagnosticsSlots)
);

externalBookingRouter.get(
  '/specialists',
  validate(externalSpecialistsQuerySchema, 'query'),
  catchAsync(externalBookingController.getSpecialists)
);

externalBookingRouter.get(
  '/slots',
  validate(externalSlotsQuerySchema, 'query'),
  catchAsync(externalBookingController.getSlots)
);

externalBookingRouter.post(
  '/bookings',
  validate(createExternalBookingSchema, 'body'),
  catchAsync(externalBookingController.createBooking)
);

externalBookingRouter.post(
  '/diagnostics/bookings',
  validate(createExternalDiagnosticsBookingSchema, 'body'),
  catchAsync(externalBookingController.createDiagnosticsBooking)
);

externalBookingRouter.post(
  '/bookings/:id/retry-payment',
  validate(externalBookingIdParamSchema, 'params'),
  validate(retryExternalPaymentBodySchema, 'body'),
  catchAsync(externalBookingController.retryConsultationPayment)
);

externalBookingRouter.get(
  '/bookings/:id/payment-details',
  validate(externalBookingIdParamSchema, 'params'),
  catchAsync(externalBookingController.getPaymentDetails)
);

externalBookingRouter.get(
  '/bookings/:id/reports',
  validate(externalBookingIdParamSchema, 'params'),
  catchAsync(externalBookingController.getSavedReports)
);

externalBookingRouter.post(
  '/diagnostics/bookings/:id/retry-payment',
  validate(externalBookingIdParamSchema, 'params'),
  validate(retryExternalPaymentBodySchema, 'body'),
  catchAsync(externalBookingController.retryDiagnosticsBookingPayment)
);

// Diagnostics report metadata endpoint.
// Frontend calls this first to fetch report details and discover available diagnostics reports.
externalBookingRouter.get(
  '/diagnostics/bookings/:id/report',
  validate(externalBookingIdParamSchema, 'params'),
  catchAsync(externalBookingController.getDiagnosticsBookingReport)
);

// Consultation report metadata endpoint.
// Frontend calls this first to fetch prescription/report details and the available document list.
externalBookingRouter.get(
  '/bookings/:id/report',
  validate(externalBookingIdParamSchema, 'params'),
  catchAsync(externalBookingController.getBookingReport)
);

// Consultation document download endpoint.
// Requires a LabStack `documentId` returned by the consultation report metadata API above.
externalBookingRouter.get(
  '/bookings/:id/report/document',
  validate(externalBookingIdParamSchema, 'params'),
  validate(externalReportDocumentQuerySchema, 'query'),
  catchAsync(externalBookingController.getBookingReportDocument)
);

// Diagnostics report PDF endpoint.
// Requires a LabStack `reportId` returned by diagnostics report metadata or webhook payloads.
externalBookingRouter.get(
  '/diagnostics/bookings/:id/report/document',
  validate(externalBookingIdParamSchema, 'params'),
  validate(externalDiagnosticsReportQuerySchema, 'query'),
  catchAsync(externalBookingController.getDiagnosticsBookingReportDocument)
);

externalBookingRouter.post(
  '/bookings/:id/cancel',
  validate(externalBookingIdParamSchema, 'params'),
  validate(cancelExternalBookingSchema, 'body'),
  catchAsync(externalBookingController.cancelBooking)
);

externalBookingRouter.post(
  '/bookings/:id/reschedule',
  validate(externalBookingIdParamSchema, 'params'),
  validate(rescheduleExternalBookingSchema, 'body'),
  catchAsync(externalBookingController.rescheduleBooking)
);

externalBookingRouter.post(
  '/diagnostics/bookings/:id/cancel',
  validate(externalBookingIdParamSchema, 'params'),
  validate(cancelExternalBookingSchema, 'body'),
  catchAsync(externalBookingController.cancelDiagnosticsBooking)
);

externalBookingRouter.post(
  '/diagnostics/bookings/:id/reschedule',
  validate(externalBookingIdParamSchema, 'params'),
  validate(rescheduleExternalDiagnosticsBookingSchema, 'body'),
  catchAsync(externalBookingController.rescheduleDiagnosticsBooking)
);

externalBookingRouter.get(
  '/bookings',
  validate(externalBookingListQuerySchema, 'query'),
  catchAsync(externalBookingController.listBookings)
);

export default externalBookingRouter;
