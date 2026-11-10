import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { WebhookController } from '@/modules/webhooks/controller';
import { labstackBookingStatusWebhookSchema } from '@/modules/webhooks/validation';

const webhookRouter = Router();
const webhookController = new WebhookController();

webhookRouter.post(
  '/booking',
  validate(labstackBookingStatusWebhookSchema, 'body'),
  catchAsync(webhookController.processBookingStatusWebhook)
);

webhookRouter.post(
  '/labstack/booking-status',
  validate(labstackBookingStatusWebhookSchema, 'body'),
  catchAsync(webhookController.processBookingStatusWebhook)
);

export default webhookRouter;
