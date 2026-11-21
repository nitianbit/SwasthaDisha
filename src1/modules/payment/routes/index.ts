import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { PaymentController } from '@/modules/payment/controller';
import { AuthRequest, assertOperationalPharmacy } from '@/modules/middleware/auth';
import { reconcilePaymentSchema, verifyPaymentSchema } from '@/modules/payment/validation';

const paymentRouter = Router();
const paymentController = new PaymentController();

paymentRouter.post(
  '/verify',
  validate(verifyPaymentSchema, 'body'),
  catchAsync(paymentController.verify)
);

// Settles a payment from Razorpay's own record of the order when the browser's verification never arrived (W3b).
// Review (phase 0 leftover): a pharmacy that is not operational is answered 403, as on the booking reads.
paymentRouter.post(
  '/reconcile',
  catchAsync(async (req: AuthRequest, _res, next) => {
    if (req.user?.userType === 'pharmacy') await assertOperationalPharmacy(req);
    next();
  }),
  validate(reconcilePaymentSchema, 'body'),
  catchAsync(paymentController.reconcile)
);

export default paymentRouter;
