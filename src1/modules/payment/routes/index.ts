import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { PaymentController } from '@/modules/payment/controller';
import { AuthRequest, assertOperationalPharmacy } from '@/modules/middleware/auth';
import { reconcilePaymentSchema, verifyPaymentSchema } from '@/modules/payment/validation';

const paymentRouter = Router();
const paymentController = new PaymentController();

// Review (phase 0 leftover; verify: review of 800dfc0, item 3): a pharmacy that is not operational (inactive, archived or
// not verified) is answered 403 on verify and reconcile, as on the booking reads. A top-up it already paid is still
// credited by the recovery sweep (WALLET_RECHARGE_SWEEP_FROM) or listed for admins as uncredited (credits always post).
const operationalPharmacyOnly = catchAsync(async (req: AuthRequest, _res, next) => {
  if (req.user?.userType === 'pharmacy') await assertOperationalPharmacy(req);
  next();
});

paymentRouter.post(
  '/verify',
  operationalPharmacyOnly,
  validate(verifyPaymentSchema, 'body'),
  catchAsync(paymentController.verify)
);

// Settles a payment from Razorpay's own record of the order when the browser's verification never arrived (W3b).
paymentRouter.post(
  '/reconcile',
  operationalPharmacyOnly,
  validate(reconcilePaymentSchema, 'body'),
  catchAsync(paymentController.reconcile)
);

export default paymentRouter;
