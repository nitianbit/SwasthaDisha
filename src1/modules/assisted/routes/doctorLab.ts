import 'reflect-metadata';
import { Router, type Response } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireSpecialist, type AuthRequest } from '@/modules/middleware/auth';
import { requireEligibleDoctor } from '@/modules/specialists/eligibility';
import * as v from '@/modules/assisted/validation';
import {
  abandonLabByKeyFor, acceptLabRescheduleFor, branchSlotsFor, cancelLabFor, createAssistedLabBooking, findLabByKeyFor, getLabBookingFor, labCatalogueFor,
  listLabBookingsFor, listLabsFor, lookupPatientFor, type LabBooker,
} from '@/modules/assisted/labBookings';

/**
 * r26 (round 3b, §25.5.4): a doctor books a lab test for a patient, paid from its wallet — the 2a routes with a doctor
 * booker, mounted at `/api/v1/specialists/me/assisted` beside the doctor wallet. Every route needs a verified, active
 * doctor (S5); the switches (`ASSISTED_BOOKING_ENABLED_DOCTOR` + `ASSISTED_LAB_BOOKING_ENABLED_DOCTOR`) gate the lookup,
 * the lab reads and new bookings only.
 */
export const doctorLabRouter = Router();
doctorLabRouter.use(requireSpecialist, catchAsync(requireEligibleDoctor));
const doctor = (req: AuthRequest): LabBooker => ({ kind: 'doctor', specialistId: String(req.user?.specialistId || req.user?._id || '').toLowerCase() });
const send = (res: Response, data: unknown, status = 200, extra: Record<string, unknown> = {}) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(status).json({ success: true, data, ...extra });
};
const r = doctorLabRouter;
r.post('/patients/lookup', validate(v.lookupSchema, 'body'), catchAsync(async (req: AuthRequest, res) => send(res, await lookupPatientFor(doctor(req), req.body.phone))));
r.get('/labs', validate(v.labListQuerySchema, 'query'), catchAsync(async (req: AuthRequest, res) => send(res, await listLabsFor(doctor(req), req.query as never))));
r.get('/labs/branches/:branchId/slots', validate(v.labBranchParamSchema, 'params'), validate(v.labSlotsQuerySchema, 'query'),
  catchAsync(async (req: AuthRequest, res) => send(res, await branchSlotsFor(doctor(req), req.params.branchId, req.query as never))));
r.get('/labs/:partnerId/catalogue', validate(v.labPartnerParamSchema, 'params'), validate(v.labCatalogueQuerySchema, 'query'),
  catchAsync(async (req: AuthRequest, res) => send(res, await labCatalogueFor(doctor(req), req.params.partnerId, req.query.visitMode as never))));
r.post('/lab-bookings', validate(v.doctorLabBookingSchema, 'body'), catchAsync(async (req: AuthRequest, res) => {
  const out = await createAssistedLabBooking(doctor(req), req.body);
  send(res, out, out.replayed ? 200 : 201);
}));
r.get('/lab-bookings', validate(v.pharmacyLabBookingQuerySchema, 'query'), catchAsync(async (req: AuthRequest, res) => {
  const out = await listLabBookingsFor(doctor(req), req.query as never);
  send(res, out.items, 200, { pagination: { total: out.total, nextCursor: out.nextCursor } });
}));
r.get('/lab-bookings/by-key/:key', validate(v.keyParamSchema, 'params'), catchAsync(async (req: AuthRequest, res) => send(res, await findLabByKeyFor(doctor(req), req.params.key))));
r.post('/lab-bookings/by-key/:key/abandon', validate(v.keyParamSchema, 'params'),
  catchAsync(async (req: AuthRequest, res) => send(res, await abandonLabByKeyFor(doctor(req), req.params.key))));
r.get('/lab-bookings/:id', validate(v.idParamSchema, 'params'), catchAsync(async (req: AuthRequest, res) => send(res, await getLabBookingFor(doctor(req), req.params.id))));
r.post('/lab-bookings/:id/cancel', validate(v.idParamSchema, 'params'), validate(v.labBookerCancelSchema, 'body'),
  catchAsync(async (req: AuthRequest, res) => send(res, await cancelLabFor(doctor(req), req.params.id, { reason: req.body?.reason, expectedVersion: req.body?.expectedVersion }))));
r.post('/lab-bookings/:id/accept-reschedule', validate(v.idParamSchema, 'params'), validate(v.labAcceptRescheduleSchema, 'body'),
  catchAsync(async (req: AuthRequest, res) => send(res, await acceptLabRescheduleFor(doctor(req), req.params.id, Number(req.body.version)))));
