import { AuthController } from '@/modules/auth/controller';
import {
  sendCorporateEmailVerificationOTPSchema,
  sendEmailVerificationOTPSchema,
  sendOTPSchema,
  userTypeParamSchema,
  verifyCorporateEmailVerificationOTPSchema,
  verifyEmailVerificationOTPSchema,
  verifyOTPSchema,
  selectPartnerSchema,
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

// Sign out on all devices (customers): every token issued so far stops working; sign in again with OTP.
authRouterV1.post(
  '/sessions/revoke',
  authenticate,
  catchAsync(authController.revokeSessions)
);

// D4: web sessions (cookie). Origin + X-Jansetu-Session header required; no bearer.
authRouterV1.post('/session/refresh', catchAsync(authController.refreshSession));
authRouterV1.post('/session/logout', catchAsync(authController.logoutSession));
// N1: phone app sessions. X-Jansetu-Native header + JSON body {app, refreshToken}; no cookie.
authRouterV1.post('/session/native/refresh', catchAsync(authController.refreshNativeSession));
authRouterV1.post('/session/native/logout', catchAsync(authController.logoutNativeSession));

// Q7: choose the partner workspace after a multi-membership OTP sign-in.
authRouterV1.post('/partner/select', validate(selectPartnerSchema, 'body'), catchAsync(authController.selectPartner));

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
