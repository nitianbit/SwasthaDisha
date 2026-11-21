import 'reflect-metadata';
import { getMySchedule, putMySchedule, addMyLeave, removeMyLeave, rescheduleMyNoShow, adminRescheduleNoShow, adminCancelNoShow } from '@/modules/doctors/controller';
import { scheduleTemplateSchema, leaveSchema, leaveParamSchema, presenceSchema, requestIdParamSchema, bookingIdParamSchema, extendSchema } from '@/modules/doctors/validation';
import * as instantDoctor from '@/modules/doctors/controller/instant';
import * as fin from '@/modules/partners/controller/finance';
import * as clinicDoc from '@/modules/partners/controller/clinic';
import * as clinicV from '@/modules/partners/validation/clinic';
import * as finV from '@/modules/partners/validation/finance';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin, requireSpecialist } from '@/modules/middleware/auth';
import { SpecialistController } from '@/modules/specialists/controller';
// S5: only verified, active doctors do what patients see or book; identity fields are admin-only after verification.
import { requireEligibleDoctor, lockVerifiedIdentity } from '@/modules/specialists/eligibility';
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
specialistRouter.put('/me/schedule', requireSpecialist, validate(scheduleTemplateSchema, 'body'), catchAsync(putMySchedule));
specialistRouter.post('/me/leave', requireSpecialist, validate(leaveSchema, 'body'), catchAsync(addMyLeave));
specialistRouter.delete('/me/leave/:date', requireSpecialist, validate(leaveParamSchema, 'params'), catchAsync(removeMyLeave));
// Q6: the clinics a doctor consults with (invitations to accept/decline, leave) and their own solo practice.
// Q14: a no-show moved once to a later slot (the booking's doctor; admins for any booking).
specialistRouter.post('/me/bookings/:bookingId/reschedule-no-show', requireSpecialist, validate(bookingIdParamSchema, 'params'),
  validate(clinicV.noShowRescheduleSchema, 'body'), catchAsync(rescheduleMyNoShow));
specialistRouter.post('/admin/bookings/:bookingId/reschedule-no-show', requireAdmin, validate(bookingIdParamSchema, 'params'),
  validate(clinicV.noShowRescheduleSchema, 'body'), catchAsync(adminRescheduleNoShow));
// Q16a: only an admin cancels a moved no-show; `refund` (required) chooses whether the patient is refunded.
specialistRouter.post('/admin/bookings/:bookingId/cancel-no-show', requireAdmin, validate(bookingIdParamSchema, 'params'),
  validate(clinicV.adminCancelNoShowSchema, 'body'), catchAsync(adminCancelNoShow));
specialistRouter.get('/me/clinics', requireSpecialist, catchAsync(clinicDoc.myClinics));
specialistRouter.post('/me/clinic-invites/:inviteId/accept', requireSpecialist, validate(clinicV.inviteIdParamSchema, 'params'), catchAsync(clinicDoc.acceptInvite));
specialistRouter.post('/me/clinic-invites/:inviteId/decline', requireSpecialist, validate(clinicV.inviteIdParamSchema, 'params'), catchAsync(clinicDoc.declineInvite));
specialistRouter.post('/me/clinics/:partnerId/leave', requireSpecialist, validate(clinicV.partnerIdParamSchema, 'params'), catchAsync(clinicDoc.leaveClinic));
specialistRouter.get('/me/practice', requireSpecialist, catchAsync(clinicDoc.getMyPractice));
specialistRouter.post('/me/practice', requireSpecialist, validate(clinicV.soloPracticeSchema, 'body'), catchAsync(clinicDoc.createMyPractice));
// Q14: a doctor creates their own clinic (owner + linked doctor at its first branch, pending admin verification).
specialistRouter.get('/me/clinic', requireSpecialist, catchAsync(clinicDoc.getMyPractice));
specialistRouter.post('/me/clinic', requireSpecialist, validate(clinicV.doctorClinicSchema, 'body'), catchAsync(clinicDoc.createMyClinic));
specialistRouter.get('/me/clinic/by-key/:key', requireSpecialist, validate(clinicV.doctorClinicKeyParamSchema, 'params'), catchAsync(clinicDoc.myClinicByKey));
// Q5: the doctor's own earnings — balance, statement (+CSV), payouts, legacy history, payout destination.
specialistRouter.get('/me/finance', requireSpecialist, catchAsync(fin.doctorFinance));
specialistRouter.get('/me/finance/statement', requireSpecialist, validate(finV.statementQuerySchema, 'query'), catchAsync(fin.doctorStatement));
specialistRouter.get('/me/finance/statement.csv', requireSpecialist, validate(finV.csvQuerySchema, 'query'), catchAsync(fin.doctorStatementCsv));
specialistRouter.get('/me/finance/payouts', requireSpecialist, validate(finV.pageQuerySchema, 'query'), catchAsync(fin.doctorPayouts));
specialistRouter.get('/me/finance/history', requireSpecialist, catchAsync(fin.doctorHistory));
specialistRouter.get('/me/finance/events', requireSpecialist, validate(finV.pageQuerySchema, 'query'), catchAsync(fin.doctorEvents));
specialistRouter.put('/me/finance/payout-details', requireSpecialist, validate(finV.payoutDetailsSchema, 'body'), catchAsync(fin.putDoctorPayoutDetails));
// Q4b: instant consultations — "available now", heartbeat, offers, accept, extend.
specialistRouter.get('/me/presence', requireSpecialist, catchAsync(instantDoctor.getPresence));
specialistRouter.put('/me/presence', requireSpecialist, validate(presenceSchema, 'body'), catchAsync(instantDoctor.putPresence));
specialistRouter.post('/me/presence/heartbeat', requireSpecialist, catchAsync(instantDoctor.postHeartbeat));
specialistRouter.get('/me/instant/offers', requireSpecialist, catchAsync(instantDoctor.getOffers));
specialistRouter.post('/me/instant/:requestId/accept', requireSpecialist, validate(requestIdParamSchema, 'params'), catchAsync(instantDoctor.acceptOffer));
specialistRouter.get('/me/instant/bookings/:bookingId', requireSpecialist, validate(bookingIdParamSchema, 'params'), catchAsync(instantDoctor.getInstantBooking));
specialistRouter.post('/me/instant/bookings/:bookingId/extend', requireSpecialist, validate(bookingIdParamSchema, 'params'), validate(extendSchema, 'body'),
  catchAsync(instantDoctor.extendConsult));

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
  catchAsync(requireEligibleDoctor),
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
