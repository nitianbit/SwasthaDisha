import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { NotificationController } from '@/modules/notification/controller';
import { requireSpecialist } from '@/modules/middleware/auth';
import {
  createNotificationSchema,
  createGeneralNotificationSchema,
  updateNotificationSchema,
  notificationQuerySchema,
  idParamSchema,
  userIdParamSchema,
} from '@/modules/notification/validation';

const notificationRouter = Router();

const notificationController = new NotificationController();

// Create notification (single user)
notificationRouter.post(
  '/',
  validate(createNotificationSchema, 'body'),
  catchAsync(notificationController.create)
);

// Create and send notification to userIds, corporate users, or all users
notificationRouter.post(
  '/send',
  validate(createGeneralNotificationSchema, 'body'),
  catchAsync(notificationController.createGeneral)
);

// Get all notifications (with optional query params)
// Supports: ?userId=xxx&type=booking_created&isRead=false&page=1&limit=10
notificationRouter.get(
  '/',
  validate(notificationQuerySchema, 'query'),
  catchAsync(notificationController.getAll)
);

// Get notifications by user ID
notificationRouter.get(
  '/user/:userId',
  validate(userIdParamSchema, 'params'),
  catchAsync(notificationController.getByUserId)
);

notificationRouter.get(
  '/specialist/me',
  requireSpecialist,
  catchAsync(notificationController.getMySpecialistNotifications)
);

notificationRouter.get(
  '/specialist/me/unread',
  requireSpecialist,
  catchAsync(notificationController.getMySpecialistUnreadNotifications)
);

notificationRouter.get(
  '/specialist/me/unread-count',
  requireSpecialist,
  catchAsync(notificationController.getMySpecialistUnreadCount)
);

notificationRouter.patch(
  '/specialist/me/read-all',
  requireSpecialist,
  catchAsync(notificationController.markAllMySpecialistNotificationsAsRead)
);

notificationRouter.patch(
  '/specialist/:id/read',
  requireSpecialist,
  validate(idParamSchema, 'params'),
  catchAsync(notificationController.markMySpecialistNotificationAsRead)
);

// Get unread notifications by user ID
notificationRouter.get(
  '/user/:userId/unread',
  validate(userIdParamSchema, 'params'),
  catchAsync(notificationController.getUnreadByUserId)
);

// Get unread count by user ID
notificationRouter.get(
  '/user/:userId/unread-count',
  validate(userIdParamSchema, 'params'),
  catchAsync(notificationController.getUnreadCount)
);

// Get notification by ID
notificationRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(notificationController.getById)
);

// Update notification
notificationRouter.put(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updateNotificationSchema, 'body'),
  catchAsync(notificationController.update)
);

// Mark notification as read
notificationRouter.patch(
  '/:id/read',
  validate(idParamSchema, 'params'),
  catchAsync(notificationController.markAsRead)
);

// Mark all notifications as read for a user
notificationRouter.patch(
  '/user/:userId/read-all',
  validate(userIdParamSchema, 'params'),
  catchAsync(notificationController.markAllAsRead)
);

// Delete notification
notificationRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(notificationController.delete)
);

export default notificationRouter;
