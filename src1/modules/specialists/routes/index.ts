import 'reflect-metadata';
import { getMySchedule, putMySchedule, addMyLeave, removeMyLeave, rescheduleMyNoShow, adminRescheduleNoShow, adminCancelNoShow } from '@/modules/doctors/controller';
import { scheduleTemplateSchema, leaveSchema, leaveParamSchema, presenceSchema, requestIdParamSchema, bookingIdParamSchema, extendSchema } from '@/modules/doctors/validation';
import * as instantDoctor from '@/modules/doctors/controller/instant';
import * as fin from '@/modules/partners/controller/finance';
import * as clinicDoc from '@/modules/partners/controller/clinic';
import * as clinicV from '@/modules/partners/validation/clinic';
import * as finV from '@/modules/partners/validation/finance';
import { Router, type NextFunction, type RequestHandler, type Response } from 'express';
import * as dash from '@/modules/specialists/dashboard';
import * as dashV from '@/modules/specialists/validation/dashboard';
import { doctorToday, doctorTodaySearch } from '@/modules/specialists/today';
import { todayQuerySchema, todaySearchSchema, pageQueryOf } from '@/modules/today/validation';
import { mountTodoRoutes } from '@/modules/todos';
import { registerBillingRoutes, type WorkspaceGuard } from '@/modules/partners/routes';
import type { PartnerPermission } from '@/modules/partners/types';
import { lookupPatientFor } from '@/modules/assisted/labBookings';
import { lookupSchema } from '@/modules/assisted/validation';
import SpecialistModel from '@/modules/specialists/model';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin, requireSpecialist, type AuthRequest } from '@/modules/middleware/auth';
import { doctorRecordsRequest } from '@/modules/recordAccess/routes';
import { SpecialistController } from '@/modules/specialists/controller';
// S5: only verified, active doctors do what patients see or book; identity fields are admin-only after verification.
import { requireEligibleDoctor, lockVerifiedIdentity } from '@/modules/specialists/eligibility';
import { requireEligibleDoctorUnlessCancel, restrictIneligibleDoctorReads } from '@/modules/specialists/eligibility';
import { takeVerificationFence, fenceAndRecordVerification } from '@/modules/specialists/verification';
import { adminCloseSchema, adminCloseHandler, adminCloseAuditHandler } from '@/modules/bookings/adminClose';
import { doctorRecommendation } from '@/modules/testRecommendations/controller';
import { recommendationLookupSchema } from '@/modules/testRecommendations/validation';
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
  patientHistoryQuerySchema,
  specialistAppointmentPrescriptionSchema,
} from '@/modules/specialistPortal/validation';

const specialistRouter = Router();
const noStore = (res: Response) => res.setHeader('Cache-Control', 'private, no-store');

const specialistController = new SpecialistController();

// Create specialist
specialistRouter.post(
  '/',
  requireAdmin,
  validate(createSpecialistSchema, 'body'),
  catchAsync(fenceAndRecordVerification),
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
  catchAsync(lockVerifiedIdentity),
  catchAsync(specialistController.updateMyProfile)
);

specialistRouter.get(
  '/me/slots',
  requireSpecialist,
  validate(specialistSlotsQuerySchema, 'query'),
  catchAsync(specialistController.listMySlots)
);

// Q4: weekly schedule (per-mode, per-clinic windows) and leave days, expanded into slots for 30 days.
specialistRouter.get('/me/schedule', requireSpecialist, catchAsync(getMySchedule));
// S5b: saving the weekly schedule creates slots, so only a verified, active doctor may (leave days stay open: they only
// remove availability, and the slot expansion they run creates nothing for an ineligible doctor).
specialistRouter.put('/me/schedule', requireSpecialist, validate(scheduleTemplateSchema, 'body'), catchAsync(requireEligibleDoctor), catchAsync(putMySchedule));
specialistRouter.post('/me/leave', requireSpecialist, validate(leaveSchema, 'body'), catchAsync(addMyLeave));
specialistRouter.delete('/me/leave/:date', requireSpecialist, validate(leaveParamSchema, 'params'), catchAsync(removeMyLeave));
// Q6: the clinics a doctor consults with (invitations to accept/decline, leave) and their own solo practice.
// Q14: a no-show moved once to a later slot (the booking's doctor; admins for any booking).
specialistRouter.post('/me/bookings/:bookingId/reschedule-no-show', requireSpecialist, validate(bookingIdParamSchema, 'params'),
  validate(clinicV.noShowRescheduleSchema, 'body'), catchAsync(requireEligibleDoctor), catchAsync(rescheduleMyNoShow));
specialistRouter.post('/admin/bookings/:bookingId/reschedule-no-show', requireAdmin, validate(bookingIdParamSchema, 'params'),
  validate(clinicV.noShowRescheduleSchema, 'body'), catchAsync(adminRescheduleNoShow));
// Q16a: only an admin cancels a moved no-show; `refund` (required) chooses whether the patient is refunded.
specialistRouter.post('/admin/bookings/:bookingId/cancel-no-show', requireAdmin, validate(bookingIdParamSchema, 'params'),
  validate(clinicV.adminCancelNoShowSchema, 'body'), catchAsync(adminCancelNoShow));
// S5c: an admin closes any pending/confirmed consultation with a full refund (as a doctor cancellation, no window), e.g.
// one whose doctor is no longer verified or active; reason and request key required, audited in the same transaction.
specialistRouter.post('/admin/bookings/:bookingId/close', requireAdmin, validate(bookingIdParamSchema, 'params'),
  validate(adminCloseSchema, 'body'), catchAsync(adminCloseHandler));
// S5e: the closes of a booking with the admin's (internal) reasons - admins only; never in the patient's or doctor's reads.
specialistRouter.get('/admin/bookings/:bookingId/close', requireAdmin, validate(bookingIdParamSchema, 'params'), catchAsync(adminCloseAuditHandler));
specialistRouter.get('/me/clinics', requireSpecialist, catchAsync(clinicDoc.myClinics));
// S5b: accepting (and creating a clinic below) is for verified, active doctors only; declining and leaving stay open.
specialistRouter.post('/me/clinic-invites/:inviteId/accept', requireSpecialist, validate(clinicV.inviteIdParamSchema, 'params'), catchAsync(requireEligibleDoctor),
  catchAsync(clinicDoc.acceptInvite));
specialistRouter.post('/me/clinic-invites/:inviteId/decline', requireSpecialist, validate(clinicV.inviteIdParamSchema, 'params'), catchAsync(clinicDoc.declineInvite));
specialistRouter.post('/me/clinics/:partnerId/leave', requireSpecialist, validate(clinicV.partnerIdParamSchema, 'params'), catchAsync(clinicDoc.leaveClinic));
specialistRouter.get('/me/practice', requireSpecialist, catchAsync(clinicDoc.getMyPractice));
specialistRouter.post('/me/practice', requireSpecialist, validate(clinicV.soloPracticeSchema, 'body'), catchAsync(requireEligibleDoctor), catchAsync(clinicDoc.createMyPractice));
// Q14: a doctor creates their own clinic (owner + linked doctor at its first branch, pending admin verification).
specialistRouter.get('/me/clinic', requireSpecialist, catchAsync(clinicDoc.getMyPractice));
specialistRouter.post('/me/clinic', requireSpecialist, validate(clinicV.doctorClinicSchema, 'body'), catchAsync(requireEligibleDoctor), catchAsync(clinicDoc.createMyClinic));
specialistRouter.get('/me/clinic/by-key/:key', requireSpecialist, validate(clinicV.doctorClinicKeyParamSchema, 'params'), catchAsync(clinicDoc.myClinicByKey));
// Q5: the doctor's own earnings — balance, statement (+CSV), payouts, legacy history, payout destination.
specialistRouter.get('/me/finance', requireSpecialist, validate(dashV.doctorFinanceQuerySchema, 'query'), catchAsync(fin.doctorFinance));
specialistRouter.get('/me/finance/statement', requireSpecialist, validate(finV.statementQuerySchema, 'query'), catchAsync(fin.doctorStatement));
specialistRouter.get('/me/finance/statement.csv', requireSpecialist, validate(finV.csvQuerySchema, 'query'), catchAsync(fin.doctorStatementCsv));
specialistRouter.get('/me/finance/payouts', requireSpecialist, validate(finV.pageQuerySchema, 'query'), catchAsync(fin.doctorPayouts));
specialistRouter.get('/me/finance/history', requireSpecialist, catchAsync(fin.doctorHistory));
specialistRouter.get('/me/finance/events', requireSpecialist, validate(finV.pageQuerySchema, 'query'), catchAsync(fin.doctorEvents));
// S5b: open while pending — a doctor may set up payout details during onboarding; every change waits for an admin's
// verification before any payout, and an unverified doctor earns nothing (cannot be booked).
specialistRouter.put('/me/finance/payout-details', requireSpecialist, validate(finV.payoutDetailsSchema, 'body'), catchAsync(fin.putDoctorPayoutDetails));
// Q4b: instant consultations — "available now", heartbeat, offers, accept, extend.
specialistRouter.get('/me/presence', requireSpecialist, catchAsync(instantDoctor.getPresence));
specialistRouter.put('/me/presence', requireSpecialist, validate(presenceSchema, 'body'), catchAsync(instantDoctor.putPresence));
specialistRouter.post('/me/presence/heartbeat', requireSpecialist, catchAsync(instantDoctor.postHeartbeat));
specialistRouter.get('/me/instant/offers', requireSpecialist, catchAsync(instantDoctor.getOffers));
// S5e: accepting (its replay answers the booking, meeting link included) and extending need a verified, active doctor.
specialistRouter.post('/me/instant/:requestId/accept', requireSpecialist, validate(requestIdParamSchema, 'params'), catchAsync(requireEligibleDoctor),
  catchAsync(instantDoctor.acceptOffer));
specialistRouter.get('/me/instant/bookings/:bookingId', requireSpecialist, validate(bookingIdParamSchema, 'params'),
  catchAsync(restrictIneligibleDoctorReads), catchAsync(instantDoctor.getInstantBooking)); // S5d: no patient details for an ineligible doctor
specialistRouter.post('/me/instant/bookings/:bookingId/extend', requireSpecialist, validate(bookingIdParamSchema, 'params'), validate(extendSchema, 'body'),
  catchAsync(requireEligibleDoctor), catchAsync(instantDoctor.extendConsult));

specialistRouter.post(
  '/me/slots',
  requireSpecialist,
  validate(specialistCreateSlotSchema, 'body'),
  catchAsync(requireEligibleDoctor),
  catchAsync(specialistController.createMySlot)
);

specialistRouter.put(
  '/me/slots/:id',
  requireSpecialist,
  validate(idParamSchema, 'params'),
  validate(specialistUpdateSlotSchema, 'body'),
  catchAsync(requireEligibleDoctor),
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
  catchAsync(restrictIneligibleDoctorReads),
  catchAsync(specialistController.listMyAppointments)
);

// r39 (§26.23): one list of his appointments with filters (before /me/appointments/:id).
specialistRouter.get('/me/appointments/list', requireSpecialist, validate(dashV.appointmentListQuerySchema, 'query'), catchAsync(restrictIneligibleDoctorReads),
  catchAsync(async (req: AuthRequest, res: Response) => {
    const out = await dash.listDoctorAppointments(dash.doctorIdOf(req), req.query as dash.AppointmentListQuery);
    noStore(res);
    res.status(200).json({ success: true, data: out.items, meta: { total: out.items.length, truncated: out.truncated } });
  }));

specialistRouter.get(
  '/me/appointments/:id',
  requireSpecialist,
  validate(idParamSchema, 'params'),
  catchAsync(restrictIneligibleDoctorReads),
  catchAsync(specialistController.getMyAppointmentById)
);

specialistRouter.patch(
  '/me/appointments/:id/status',
  requireSpecialist,
  validate(idParamSchema, 'params'),
  validate(updateAppointmentStatusSchema, 'body'),
  catchAsync(requireEligibleDoctorUnlessCancel),
  catchAsync(restrictIneligibleDoctorReads), // S5f: the cancel's answer carries no patient details for an ineligible doctor
  catchAsync(specialistController.updateMyAppointmentStatus)
);

specialistRouter.post(
  '/me/appointments/:id/prescription',
  requireSpecialist,
  validate(idParamSchema, 'params'),
  validate(specialistAppointmentPrescriptionSchema, 'body'),
  catchAsync(requireEligibleDoctor),
  catchAsync(specialistController.createMyAppointmentPrescription)
);

// Phase 3d (§25.7.4): a recommendation by its printed code and the patient's mobile number (a walk-in patient).
specialistRouter.post('/me/assisted/recommendations/lookup', requireSpecialist, validate(recommendationLookupSchema, 'body'), catchAsync(requireEligibleDoctor),
  catchAsync(doctorRecommendation));

specialistRouter.get(
  '/me/patients/:userId/history',
  requireSpecialist,
  validate(patientUserIdParamSchema, 'params'),
  validate(patientHistoryQuerySchema, 'query'),
  // r30 (§25.9.3): the treating view (`bookingId`) needs a verified, active doctor (403); the plain history is reduced for one.
  catchAsync(async (req: AuthRequest, res: Response, next: NextFunction) => (req.query.bookingId ? requireEligibleDoctor(req, res, next) : next())),
  catchAsync(restrictIneligibleDoctorReads),
  catchAsync(specialistController.getMyPatientHistory)
);

// r30 (§25.9.4): the doctor asks the account holder to let it see other providers' records (inside the treating window).
specialistRouter.post('/me/bookings/:id/records-access/request', requireSpecialist, validate(idParamSchema, 'params'), catchAsync(requireEligibleDoctor),
  catchAsync(doctorRecordsRequest));

// r39 (§26.23): the doctor's own bookings — the counted phone lookup, an appointment at a clinic he consults at (the
// clinic's desk booking), an online consultation or a follow-up for his patient — his Today register and private to-dos.
const eligible = [requireSpecialist, catchAsync(requireEligibleDoctor)];
specialistRouter.post('/me/patients/lookup', ...eligible, validate(lookupSchema, 'body'), catchAsync(async (req: AuthRequest, res: Response) => {
  noStore(res);
  res.status(200).json({ success: true, data: await lookupPatientFor({ kind: 'doctor', specialistId: dash.doctorIdOf(req) }, req.body.phone, { gated: false }) });
}));
specialistRouter.post('/me/clinic-appointments', ...eligible, validate(dashV.doctorClinicBookingSchema, 'body'), catchAsync(async (req: AuthRequest, res: Response) => {
  const out = await dash.bookDoctorClinicAppointment(dash.doctorIdOf(req), req.body);
  noStore(res);
  res.status(out.replayed ? 200 : 201).json({ success: true, data: out });
}));
specialistRouter.post('/me/consultations', ...eligible, validate(dashV.doctorConsultationSchema, 'body'), catchAsync(async (req: AuthRequest, res: Response) => {
  const out = await dash.bookDoctorConsultation(dash.doctorIdOf(req), req.body);
  noStore(res);
  res.status(out.replayed ? 200 : 201).json({ success: true, data: out });
}));
specialistRouter.get('/me/today', ...eligible, validate(todayQuerySchema, 'query'), catchAsync(async (req: AuthRequest, res: Response) => {
  noStore(res);
  res.status(200).json({ success: true, data: await doctorToday(dash.doctorIdOf(req), pageQueryOf(req.query as Record<string, unknown>)) });
}));
specialistRouter.post('/me/today/search', ...eligible, validate(todaySearchSchema, 'body'), catchAsync(async (req: AuthRequest, res: Response) => {
  noStore(res);
  res.status(200).json({ success: true, data: await doctorTodaySearch(dash.doctorIdOf(req), req.body) });
}));
// Private to the doctor (owner kind `doctor`); open to a doctor not yet verified (they are his own notes).
const doctorMe = Router();
mountTodoRoutes(doctorMe, (req: AuthRequest) => {
  const id = dash.doctorIdOf(req);
  return { owner: { kind: 'doctor', id }, actor: async () => ({ kind: 'doctor', id,
    name: (await SpecialistModel.findById(id).select({ name: 1 }).lean() as { name?: string } | null)?.name ?? null }) };
}, [requireSpecialist]);
specialistRouter.use('/me', doctorMe);
// The doctor bills the clinic he OWNS: the workspace's catalogue and bill routes with his owner actor (other clinics
// stay reception-only). Every permission is the owner's.
const doctorOwnerGuard: WorkspaceGuard = Object.assign((..._p: PartnerPermission[]) => [requireSpecialist, catchAsync(requireEligibleDoctor), dash.attachDoctorOwnerActor] as RequestHandler[],
  { any: (..._p: PartnerPermission[]) => [requireSpecialist, catchAsync(requireEligibleDoctor), dash.attachDoctorOwnerActor] as RequestHandler[] });
const doctorClinic = Router();
registerBillingRoutes(doctorClinic, doctorOwnerGuard);
specialistRouter.use('/me/clinic', doctorClinic);

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
  takeVerificationFence,
  validate(idParamSchema, 'params'),
  validate(updateSpecialistSchema, 'body'),
  catchAsync(fenceAndRecordVerification),
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
