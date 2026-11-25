import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { PaymentController } from '@/modules/payment/controller';
import { AuthRequest, assertOperationalPharmacy } from '@/modules/middleware/auth';
import { reconcilePaymentSchema, verifyPaymentSchema } from '@/modules/payment/validation';
import PaymentRecordModel from '@/modules/payment/model';
import { isAssistedCardContext } from '@/modules/payment/types';
import { assertEligibleDoctor } from '@/modules/specialists/eligibility';

const paymentRouter = Router();
const paymentController = new PaymentController();

// Review (phase 0 leftover; verify: review of 800dfc0, item 3; narrowed: review of db252c1, item b): a pharmacy that is
// not operational (inactive, archived or not verified) is answered 403 on verify and reconcile of a BOOKING payment (the
// answer carries the booker view, as on the booking reads). Its own wallet top-up still settles and is credited (its
// own money); the wallet funds nothing while the pharmacy is not operational (every spending route requires it).
//
// r29 (§25.6, the same gate for doctors): a doctor no longer verified and active is answered 403 SPECIALIST_NOT_VERIFIED on
// verify and reconcile of an assisted card payment (a lab booking it paid by card; the answer carries its booker view).
// Its capture is not lost: the sweeps return it to the card (DR9). Its own wallet top-ups still settle (DR3).
const operationalPharmacyForBookings = catchAsync(async (req: AuthRequest, _res, next) => {
  const userType = req.user?.userType;
  if (userType === 'pharmacy' || userType === 'specialist') {
    const id = String(req.body?.paymentTransactionId ?? '');
    const record = /^[0-9a-fA-F]{24}$/.test(id)
      ? await PaymentRecordModel.findById(id).select({ context: 1 }).lean() as { context?: string } | null : null;
    // Phase 1b: an assisted card payment of a booking is a booking payment too (its answer carries the booker view); r14: lab bookings too.
    if (userType === 'pharmacy' && (!record || record.context === 'booking' || isAssistedCardContext(record.context))) await assertOperationalPharmacy(req);
    if (userType === 'specialist' && record && isAssistedCardContext(record.context)) await assertEligibleDoctor(req);
  }
  next();
});

paymentRouter.post(
  '/verify',
  operationalPharmacyForBookings,
  validate(verifyPaymentSchema, 'body'),
  catchAsync(paymentController.verify)
);

// Settles a payment from Razorpay's own record of the order when the browser's verification never arrived (W3b).
paymentRouter.post(
  '/reconcile',
  operationalPharmacyForBookings,
  validate(reconcilePaymentSchema, 'body'),
  catchAsync(paymentController.reconcile)
);

export default paymentRouter;
