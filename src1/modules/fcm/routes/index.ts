import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { FcmController } from '@/modules/fcm/controller';
import { saveFcmTokenSchema, sendTestNotificationSchema } from '@/modules/fcm/validation';

const fcmRouter = Router();
const fcmController = new FcmController();

fcmRouter.post(
  '/token',
  validate(saveFcmTokenSchema, 'body'),
  catchAsync(fcmController.saveToken)
);

// Test endpoint to send a test FCM notification to a given userId
fcmRouter.post(
  '/test',
  validate(sendTestNotificationSchema, 'body'),
  catchAsync(fcmController.sendTestNotification)
);

export default fcmRouter;
