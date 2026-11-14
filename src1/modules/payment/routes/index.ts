import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { PaymentController } from '@/modules/payment/controller';
import { reconcilePaymentSchema, verifyPaymentSchema } from '@/modules/payment/validation';

const paymentRouter = Router();
const paymentController = new PaymentController();

paymentRouter.post(
  '/verify',
  validate(verifyPaymentSchema, 'body'),
  catchAsync(paymentController.verify)
);

// Settles a payment from Razorpay's own record of the order when the browser's verification never arrived (W3b).
paymentRouter.post(
  '/reconcile',
  validate(reconcilePaymentSchema, 'body'),
  catchAsync(paymentController.reconcile)
);

export default paymentRouter;
