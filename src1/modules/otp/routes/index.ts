import { validate } from '@/modules/common/middleware/validation';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { OTPController } from '@/modules/otp/controller';
import { createOTPSchema, verifyOTPSchema } from '@/modules/otp/validation';
import { Router } from 'express';
import 'reflect-metadata';


const otpRouter = Router();

const otpController = new OTPController();

otpRouter.post(
  '/',
  validate(createOTPSchema, 'body'),
  catchAsync(otpController.createOTP)
);

otpRouter.post(
  '/verify',
  validate(verifyOTPSchema, 'body'),
  catchAsync(otpController.verifyOTP)
);

export default otpRouter;
