import type { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import type { WorkspaceGuard } from '@/modules/partners/routes';
import * as v from '@/modules/assisted/validation';
import * as c from '@/modules/assisted/controller/phase2e';

/**
 * Round 2e (§24.8.2): a lab books doctor consultations for walk-in patients, inside the partner workspace (members at
 * `/api/v1/partner-workspace/assisted/*`, admins acting as owner under `…/admin/:partnerId/workspace/assisted/*`).
 * Permission `assisted.book` (L13; owners hold it; never granted by migration), an operational lab (the workspace
 * guard), the member's branch scope (the commands). The wallet, its top-ups and the payment verify/reconcile of a card
 * booking are 2d's routes under the same prefix.
 */
export function registerLabBookerRoutes(r: Router, guard: WorkspaceGuard): void {
  const book = guard('assisted.book');
  r.post('/assisted/patients/lookup', ...book, validate(v.lookupSchema, 'body'), catchAsync(c.lookup));
  r.get('/assisted/doctors', ...book, validate(v.labDoctorQuerySchema, 'query'), catchAsync(c.doctors));
  r.get('/assisted/doctors/:doctorId/slots', ...book, validate(v.doctorSlotsParamSchema, 'params'), validate(v.labDoctorSlotsQuerySchema, 'query'),
    catchAsync(c.doctorSlots));
  r.post('/assisted/consultations', ...book, validate(v.labConsultationSchema, 'body'), catchAsync(c.createConsultation));
  r.get('/assisted/bookings', ...book, validate(v.pharmacyBookingQuerySchema, 'query'), catchAsync(c.bookings));
  r.get('/assisted/bookings/by-key/:key', ...book, validate(v.keyParamSchema, 'params'), catchAsync(c.byKey));
  r.post('/assisted/bookings/by-key/:key/abandon', ...book, validate(v.keyParamSchema, 'params'), catchAsync(c.abandonKey));
  r.get('/assisted/bookings/:id', ...book, validate(v.idParamSchema, 'params'), catchAsync(c.booking));
  r.post('/assisted/bookings/:id/cancel', ...book, validate(v.idParamSchema, 'params'), validate(v.bookerCancelSchema, 'body'), catchAsync(c.cancel));
  r.post('/assisted/bookings/:id/reschedule', ...book, validate(v.idParamSchema, 'params'), validate(v.bookerRescheduleSchema, 'body'), catchAsync(c.reschedule));
}
