import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin, requireOperationalPharmacy } from '@/modules/middleware/auth';
import * as c from '@/modules/assisted/controller/phase1a';
import * as v from '@/modules/assisted/validation';
import * as lab from '@/modules/assisted/controller/phase2a';
import { pharmacyRecommendation } from '@/modules/testRecommendations/controller';
import { recommendationLookupSchema } from '@/modules/testRecommendations/validation';
import * as instant from '@/modules/assisted/controller/phase3e';
import * as referral from '@/modules/referralCuts/controller';
import * as rv from '@/modules/referralCuts/validation';

/**
 * Assisted booking phase 1a routes (§17.6).
 * - `/api/v1/pharmacy-assisted/*`: operational, verified pharmacies (access ends with the pharmacy's authority).
 * - `/api/v1/admin/*`: admins (the move tool, the "not mine" queue, reconciliation, stuck money, top-ups, freeze).
 */
export const pharmacyAssistedRouter = Router();
pharmacyAssistedRouter.use(requireOperationalPharmacy);
pharmacyAssistedRouter.post('/patients/lookup', validate(v.lookupSchema, 'body'), catchAsync(c.lookup));
pharmacyAssistedRouter.get('/doctors', validate(v.doctorQuerySchema, 'query'), catchAsync(c.doctors));
pharmacyAssistedRouter.get('/doctors/:doctorId/slots', validate(v.doctorSlotsParamSchema, 'params'), validate(v.doctorSlotsQuerySchema, 'query'),
  catchAsync(c.doctorSlots));
pharmacyAssistedRouter.post('/consultations', validate(v.consultationSchema, 'body'), catchAsync(c.createConsultation));
pharmacyAssistedRouter.get('/bookings/by-key/:key', validate(v.keyParamSchema, 'params'), catchAsync(c.byKey));
pharmacyAssistedRouter.post('/bookings/by-key/:key/abandon', validate(v.keyParamSchema, 'params'), catchAsync(c.abandonKey));
pharmacyAssistedRouter.post('/bookings/:id/cancel', validate(v.idParamSchema, 'params'), validate(v.bookerCancelSchema, 'body'), catchAsync(c.cancel));
pharmacyAssistedRouter.post('/bookings/:id/reschedule', validate(v.idParamSchema, 'params'), validate(v.bookerRescheduleSchema, 'body'),
  catchAsync(c.reschedule));
// r11 (§24.4.2): pharmacy → lab test bookings, paid from the pharmacy wallet. Static paths before `/:id`.
pharmacyAssistedRouter.get('/labs', validate(v.labListQuerySchema, 'query'), catchAsync(lab.labs));
pharmacyAssistedRouter.get('/labs/branches/:branchId/slots', validate(v.labBranchParamSchema, 'params'), validate(v.labSlotsQuerySchema, 'query'),
  catchAsync(lab.labSlots));
pharmacyAssistedRouter.get('/labs/:partnerId/catalogue', validate(v.labPartnerParamSchema, 'params'), validate(v.labCatalogueQuerySchema, 'query'),
  catchAsync(lab.labCatalogue));
pharmacyAssistedRouter.post('/lab-bookings', validate(v.labBookingSchema, 'body'), catchAsync(lab.createLabBooking));
pharmacyAssistedRouter.get('/lab-bookings', validate(v.pharmacyLabBookingQuerySchema, 'query'), catchAsync(lab.listLabBookings));
pharmacyAssistedRouter.get('/lab-bookings/by-key/:key', validate(v.keyParamSchema, 'params'), catchAsync(lab.labByKey));
pharmacyAssistedRouter.post('/lab-bookings/by-key/:key/abandon', validate(v.keyParamSchema, 'params'), catchAsync(lab.abandonLabKey));
pharmacyAssistedRouter.get('/lab-bookings/:id', validate(v.idParamSchema, 'params'), catchAsync(lab.getLabBooking));
pharmacyAssistedRouter.post('/lab-bookings/:id/cancel', validate(v.idParamSchema, 'params'), validate(v.labBookerCancelSchema, 'body'), catchAsync(lab.cancelLab));
pharmacyAssistedRouter.post('/lab-bookings/:id/accept-reschedule', validate(v.idParamSchema, 'params'), validate(v.labAcceptRescheduleSchema, 'body'),
  catchAsync(lab.acceptLabReschedule));
// Phase 3d (§25.7.4): a doctor's recommended tests, by the printed code and the patient's mobile number.
pharmacyAssistedRouter.post('/recommendations/lookup', validate(recommendationLookupSchema, 'body'), catchAsync(pharmacyRecommendation));
// r17 (§25.8.3): instant "Consult now" for a patient, paid from the pharmacy wallet. Static paths before `/:id`.
pharmacyAssistedRouter.get('/instant/specialities', validate(v.instantSpecialitiesQuerySchema, 'query'), catchAsync(instant.specialities));
pharmacyAssistedRouter.get('/instant/doctors', validate(v.instantDoctorsQuerySchema, 'query'), catchAsync(instant.doctors));
pharmacyAssistedRouter.get('/instant/quote', validate(v.instantQuoteQuerySchema, 'query'), catchAsync(instant.quote));
pharmacyAssistedRouter.post('/instant/requests', validate(v.instantRequestSchema, 'body'), catchAsync(instant.createRequest));
pharmacyAssistedRouter.get('/instant/requests', validate(v.instantListQuerySchema, 'query'), catchAsync(instant.listRequests));
pharmacyAssistedRouter.get('/instant/requests/by-key/:key', validate(v.keyParamSchema, 'params'), catchAsync(instant.byKey));
pharmacyAssistedRouter.post('/instant/requests/by-key/:key/abandon', validate(v.keyParamSchema, 'params'), catchAsync(instant.abandonKey));
pharmacyAssistedRouter.get('/instant/requests/:id', validate(v.idParamSchema, 'params'), catchAsync(instant.getRequest));
pharmacyAssistedRouter.post('/instant/requests/:id/reoffer', validate(v.idParamSchema, 'params'), validate(v.instantReofferSchema, 'body'), catchAsync(instant.reoffer));
pharmacyAssistedRouter.post('/instant/requests/:id/activity', validate(v.idParamSchema, 'params'), catchAsync(instant.activity));
pharmacyAssistedRouter.post('/instant/requests/:id/refund', validate(v.idParamSchema, 'params'), validate(v.instantRefundSchema, 'body'), catchAsync(instant.refund));
// Phase 4a/4b (§26.5.4, §26.6.2): the pharmacy's referral rates (read-only) and what its cuts earned.
pharmacyAssistedRouter.get('/referral-rules', catchAsync(referral.pharmacyRules));
pharmacyAssistedRouter.get('/referral', catchAsync(referral.pharmacyReferral));
pharmacyAssistedRouter.get('/referral/statement', validate(rv.statementQuerySchema, 'query'), catchAsync(referral.pharmacyReferralStatement));

export const adminAssistedRouter = Router();
adminAssistedRouter.use(requireAdmin);
// Phase 4a (§26.5.4): referral rules per partner and category (writes need ASSISTED_ADMIN_TOOLS_ENABLED).
adminAssistedRouter.get('/referral-rules', validate(rv.rulesQuerySchema, 'query'), catchAsync(referral.adminRules));
adminAssistedRouter.put('/referral-rules/:bookerKind/:bookerId/:category', validate(rv.ruleParamSchema, 'params'), validate(rv.ruleBodySchema, 'body'),
  catchAsync(referral.adminPutRule));
adminAssistedRouter.get('/referral-rules/:bookerKind/:bookerId/:category/events', validate(rv.ruleParamSchema, 'params'), catchAsync(referral.adminRuleEvents));
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
// r9: a top-up support already paid by hand is closed as compensated (never credited); and its by-key read.
adminAssistedRouter.get('/wallet-payments/close-compensated/by-key/:key', validate(v.keyParamSchema, 'params'), catchAsync(c.closeCompensatedByKey));
adminAssistedRouter.post('/wallet-payments/:paymentId/close-compensated', validate(v.paymentIdParamSchema, 'params'), validate(v.closeCompensatedSchema, 'body'),
  catchAsync(c.closeCompensated));
// Phase 1b: assisted card payments — the refund operator queue, a failed refund to the wallet, a lost card dispute.
adminAssistedRouter.get('/assisted/card-refunds', validate(v.cardRefundQuerySchema, 'query'), catchAsync(c.cardRefunds));
adminAssistedRouter.post('/assisted/card-refunds/:id/to-wallet', validate(v.idParamSchema, 'params'), validate(v.cardRefundToWalletSchema, 'body'),
  catchAsync(c.cardRefundWallet));
// r10b: ask Razorpay now; mark failed only after Razorpay was read (then to-wallet may follow).
adminAssistedRouter.get('/assisted/card-refunds/:id', validate(v.idParamSchema, 'params'), catchAsync(c.cardRefundOne));
adminAssistedRouter.post('/assisted/card-refunds/:id/recheck', validate(v.idParamSchema, 'params'), catchAsync(c.cardRefundRecheck));
adminAssistedRouter.post('/assisted/card-refunds/:id/mark-failed', validate(v.idParamSchema, 'params'), validate(v.chargebackSchema, 'body'),
  catchAsync(c.cardRefundMarkFailed));
adminAssistedRouter.post('/assisted-payments/:paymentId/chargeback', validate(v.paymentIdParamSchema, 'params'), validate(v.chargebackSchema, 'body'),
  catchAsync(c.cardChargeback));
adminAssistedRouter.put('/pharmacies/:id/wallet/freeze', validate(v.idParamSchema, 'params'), validate(v.freezeSchema, 'body'), catchAsync(c.freeze));
