import { AuthController } from '@/modules/auth/controller';
import {
  sendCorporateEmailVerificationOTPSchema,
  sendEmailVerificationOTPSchema,
  sendOTPSchema,
  userTypeParamSchema,
  verifyCorporateEmailVerificationOTPSchema,
  verifyEmailVerificationOTPSchema,
  verifyOTPSchema,
} from '@/modules/auth/validation';
import { validate } from '@/modules/common/middleware/validation';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { authenticate } from '@/modules/middleware/auth';
import { Router } from 'express';

const authRouterV1 = Router();

const authController = new AuthController();

//require authentication
authRouterV1.post(
  '/email-verification/send',
  authenticate,
  validate(sendEmailVerificationOTPSchema, 'body'),
  catchAsync(authController.sendEmailVerificationOTP)
);

//require authentication
authRouterV1.post(
  '/email-verification/verify',
  authenticate,
  validate(verifyEmailVerificationOTPSchema, 'body'),
  catchAsync(authController.verifyEmailVerificationOTP)
);

authRouterV1.post(
  '/corporate-email/send',
  authenticate,
  validate(sendCorporateEmailVerificationOTPSchema, 'body'),
  catchAsync(authController.sendCorporateEmailVerificationOTP)
);

authRouterV1.post(
  '/corporate-email/verify',
  authenticate,
  validate(verifyCorporateEmailVerificationOTPSchema, 'body'),
  catchAsync(authController.verifyCorporateEmailVerificationOTP)
);

authRouterV1.post(
  '/:userType/send',
  validate(userTypeParamSchema, 'params'),
  validate(sendOTPSchema, 'body'),
  catchAsync(authController.sendOTP)
);

authRouterV1.post(
  '/:userType/verify',
  validate(userTypeParamSchema, 'params'),
  validate(verifyOTPSchema, 'body'),
  catchAsync(authController.verifyOTP)
);

// Profile endpoint - requires authentication
authRouterV1.get(
  '/profile',
  authenticate,
  catchAsync(authController.getProfile)
);

export default authRouterV1;
