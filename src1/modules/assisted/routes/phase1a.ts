import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin, requireOperationalPharmacy } from '@/modules/middleware/auth';
import * as c from '@/modules/assisted/controller/phase1a';
import * as v from '@/modules/assisted/validation';

/**
 * Assisted booking phase 1a routes (§17.6).
 * - `/api/v1/pharmacy-assisted/*`: operational, verified pharmacies (access ends with the pharmacy's authority).
 * - `/api/v1/admin/*`: admins (the move tool, the "not mine" queue, reconciliation, stuck money, top-ups, freeze).
 */
export const pharmacyAssistedRouter = Router();
pharmacyAssistedRouter.use(requireOperationalPharmacy);
pharmacyAssistedRouter.post('/patients/lookup', validate(v.lookupSchema, 'body'), catchAsync(c.lookup));
pharmacyAssistedRouter.get('/doctors', validate(v.doctorQuerySchema, 'query'), catchAsync(c.doctors));
pharmacyAssistedRouter.post('/consultations', validate(v.consultationSchema, 'body'), catchAsync(c.createConsultation));
pharmacyAssistedRouter.get('/bookings/by-key/:key', validate(v.keyParamSchema, 'params'), catchAsync(c.byKey));
pharmacyAssistedRouter.post('/bookings/by-key/:key/abandon', validate(v.keyParamSchema, 'params'), catchAsync(c.abandonKey));
pharmacyAssistedRouter.post('/bookings/:id/cancel', validate(v.idParamSchema, 'params'), validate(v.bookerCancelSchema, 'body'), catchAsync(c.cancel));
pharmacyAssistedRouter.post('/bookings/:id/reschedule', validate(v.idParamSchema, 'params'), validate(v.bookerRescheduleSchema, 'body'),
  catchAsync(c.reschedule));

export const adminAssistedRouter = Router();
adminAssistedRouter.use(requireAdmin);
adminAssistedRouter.post('/assisted-bookings/:id/move', validate(v.idParamSchema, 'params'), validate(v.moveSchema, 'body'), catchAsync(c.move));
adminAssistedRouter.get('/assisted/review-items', validate(v.reviewQuerySchema, 'query'), catchAsync(c.reviewItems));
adminAssistedRouter.post('/assisted/review-items/:id/dismiss', validate(v.idParamSchema, 'params'), validate(v.dismissSchema, 'body'), catchAsync(c.dismiss));
adminAssistedRouter.get('/assisted/reconciliation', catchAsync(c.reconciliation));
adminAssistedRouter.get('/assisted/stuck-money', catchAsync(c.stuck));
adminAssistedRouter.get('/assisted/alerts', catchAsync(c.alerts));
adminAssistedRouter.get('/assisted/meet-guest-check/:id', validate(v.idParamSchema, 'params'), catchAsync(c.meetGuestCheck));
adminAssistedRouter.get('/wallet-recharges/uncredited', catchAsync(c.uncredited));
adminAssistedRouter.get('/pharmacies/:id/wallet/lots', validate(v.idParamSchema, 'params'), catchAsync(c.lots));
adminAssistedRouter.post('/wallet-lots/:lotId/chargeback', validate(v.lotIdParamSchema, 'params'), validate(v.chargebackSchema, 'body'), catchAsync(c.chargeback));
adminAssistedRouter.post('/wallet-payments/:paymentId/chargeback', validate(v.paymentIdParamSchema, 'params'), validate(v.chargebackSchema, 'body'),
  catchAsync(c.paymentChargeback));
adminAssistedRouter.put('/pharmacies/:id/wallet/freeze', validate(v.idParamSchema, 'params'), validate(v.freezeSchema, 'body'), catchAsync(c.freeze));
