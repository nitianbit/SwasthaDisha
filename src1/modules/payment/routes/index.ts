import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { PaymentController } from '@/modules/payment/controller';
import { verifyPaymentSchema } from '@/modules/payment/validation';

const paymentRouter = Router();
const paymentController = new PaymentController();

paymentRouter.post(
  '/verify',
  validate(verifyPaymentSchema, 'body'),
  catchAsync(paymentController.verify)
);

export default paymentRouter;
