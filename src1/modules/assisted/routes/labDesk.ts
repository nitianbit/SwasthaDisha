import type { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import type { WorkspaceGuard } from '@/modules/partners/routes';
import { labBookingIdParamSchema } from '@/modules/partners/validation/labBooking';
import { keyParamSchema, labBookerCancelSchema, lookupSchema } from '@/modules/assisted/validation';
import { deskBookingSchema } from '@/modules/assisted/validation/labDesk';
import * as c from '@/modules/assisted/controller/phase2c';

/**
 * r12 (§24.6.2): the lab front desk, inside the partner workspace (members at `/api/v1/partner-workspace/lab-desk/*`,
 * admins acting as owner at `/api/v1/partner-workspace/admin/:partnerId/workspace/lab-desk/*`). Permission
 * `bookings.manage` (L13); the service refuses non-labs (403 LAB_PARTNER_REQUIRED) and applies the branch scope.
 * The desk reads tests from `GET /catalogue` and seats from `GET /slots`; steps, reports and bills use the existing
 * lab booking and invoice routes.
 */
export function registerLabDeskRoutes(r: Router, guard: WorkspaceGuard): void {
  const desk = guard('bookings.manage');
  r.post('/lab-desk/patients/lookup', ...desk, validate(lookupSchema, 'body'), catchAsync(c.deskLookup));
  r.post('/lab-desk/bookings', ...desk, validate(deskBookingSchema, 'body'), catchAsync(c.deskCreate));
  r.get('/lab-desk/bookings/by-key/:key', ...desk, validate(keyParamSchema, 'params'), catchAsync(c.deskByKey));
  r.post('/lab-desk/bookings/by-key/:key/abandon', ...desk, validate(keyParamSchema, 'params'), catchAsync(c.deskAbandonKey));
  r.post('/lab-desk/bookings/:bookingId/cancel', ...desk, validate(labBookingIdParamSchema, 'params'), validate(labBookerCancelSchema, 'body'),
    catchAsync(c.deskCancel));
}
