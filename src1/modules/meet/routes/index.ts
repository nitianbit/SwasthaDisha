import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { authenticate, requireAdmin } from '@/modules/middleware/auth';
import { MeetController } from '@/modules/meet/controller';
import {
  googleOAuthQuerySchema,
  googleOAuthCallbackQuerySchema,
  googleOAuthExchangeSchema,
  googleOAuthRefreshTestSchema,
  testGoogleMeetSchema,
} from '@/modules/meet/validation';

const meetRouter = Router();
const meetController = new MeetController();

meetRouter.get(
  '/google-oauth/callback',
  validate(googleOAuthCallbackQuerySchema, 'query'),
  catchAsync(meetController.googleOAuthCallback)
);

meetRouter.get(
  '/google-oauth/url',
  authenticate,
  requireAdmin,
  validate(googleOAuthQuerySchema, 'query'),
  catchAsync(meetController.getGoogleOAuthAuthorizationUrl)
);

meetRouter.post(
  '/google-oauth/exchange',
  authenticate,
  requireAdmin,
  validate(googleOAuthExchangeSchema, 'body'),
  catchAsync(meetController.exchangeGoogleOAuthCode)
);

meetRouter.post(
  '/google-oauth/refresh',
  authenticate,
  requireAdmin,
  validate(googleOAuthRefreshTestSchema, 'body'),
  catchAsync(meetController.testGoogleOAuthRefresh)
);

meetRouter.post(
  '/google-meet/oauth',
  authenticate,
  requireAdmin,
  validate(testGoogleMeetSchema, 'body'),
  catchAsync(meetController.testGoogleMeetWithOAuth)
);

export default meetRouter;
