import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { NotificationService } from '@/modules/notification/services';
import { AuthRequest } from '@/modules/middleware/auth';
import {
  CreateNotificationRequest,
  CreateGeneralNotificationRequest,
  UpdateNotificationRequest,
  NotificationQueryParams,
} from '@/modules/notification/types';

export class NotificationController {
  private notificationService: NotificationService;

  constructor() {
    this.notificationService = Container.get(NotificationService);
  }

  create = async (req: Request, res: Response, _next: NextFunction) => {
    const data: CreateNotificationRequest = req.body;
    const result = await this.notificationService.create(data);

    res.status(201).json({
      success: true,
      message: 'Notification created successfully',
      data: result,
    });
  };

  /** Send notification to specific userIds, all users of a corporate, or all users. */
  createGeneral = async (req: Request, res: Response, _next: NextFunction) => {
    const data: CreateGeneralNotificationRequest = req.body;
    const result =
      await this.notificationService.createGeneralNotification(data);

    res.status(201).json({
      success: true,
      message: 'Notification sent successfully',
      data: result,
    });
  };

  getById = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.notificationService.getById(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAll = async (req: Request, res: Response, _next: NextFunction) => {
    const queryParams: NotificationQueryParams = {
      userId: req.query.userId as string,
      type: req.query.type as any,
      isRead:
        req.query.isRead !== undefined
          ? req.query.isRead === 'true'
          : undefined,
      referenceType: req.query.referenceType as string,
      referenceId: req.query.referenceId as string,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      limit: req.query.limit
        ? parseInt(req.query.limit as string)
        : undefined,
      sortBy: req.query.sortBy as string,
      sortOrder: req.query.sortOrder as 'asc' | 'desc',
    };

    const result = await this.notificationService.getAll(queryParams);

    if (result.total !== undefined) {
      res.status(200).json({
        success: true,
        data: result.data,
        pagination: {
          page: result.page!,
          limit: queryParams.limit!,
          total: result.total,
          totalPages: result.totalPages!,
        },
      });
    } else {
      res.status(200).json({
        success: true,
        data: result.data,
      });
    }
  };

  getByUserId = async (req: Request, res: Response, _next: NextFunction) => {
    const { userId } = req.params;
    const result = await this.notificationService.getByUserId(userId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getUnreadByUserId = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const { userId } = req.params;
    const result = await this.notificationService.getUnreadByUserId(userId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getUnreadCount = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const { userId } = req.params;
    const count = await this.notificationService.getUnreadCount(userId);

    res.status(200).json({
      success: true,
      data: { count },
    });
  };

  update = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const data: UpdateNotificationRequest = req.body;
    const result = await this.notificationService.update(id, data);

    res.status(200).json({
      success: true,
      message: 'Notification updated successfully',
      data: result,
    });
  };

  markAsRead = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.notificationService.markAsRead(id);

    res.status(200).json({
      success: true,
      message: 'Notification marked as read',
      data: result,
    });
  };

  markAllAsRead = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const { userId } = req.params;
    await this.notificationService.markAllAsRead(userId);

    res.status(200).json({
      success: true,
      message: 'All notifications marked as read',
    });
  };

  getMySpecialistNotifications = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const specialistId = req.user?.specialistId || req.user?._id || '';
    const result = await this.notificationService.getBySpecialistId(specialistId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getMySpecialistUnreadNotifications = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const specialistId = req.user?.specialistId || req.user?._id || '';
    const result =
      await this.notificationService.getUnreadBySpecialistId(specialistId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getMySpecialistUnreadCount = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const specialistId = req.user?.specialistId || req.user?._id || '';
    const count =
      await this.notificationService.getUnreadCountBySpecialistId(specialistId);

    res.status(200).json({
      success: true,
      data: { count },
    });
  };

  markAllMySpecialistNotificationsAsRead = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const specialistId = req.user?.specialistId || req.user?._id || '';
    await this.notificationService.markAllAsReadForSpecialist(specialistId);

    res.status(200).json({
      success: true,
      message: 'All specialist notifications marked as read',
    });
  };

  markMySpecialistNotificationAsRead = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const specialistId = req.user?.specialistId || req.user?._id || '';
    const result = await this.notificationService.markSpecialistNotificationAsRead(
      req.params.id,
      specialistId
    );

    res.status(200).json({
      success: true,
      message: 'Notification marked as read',
      data: result,
    });
  };

  delete = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    await this.notificationService.delete(id);

    res.status(200).json({
      success: true,
      message: 'Notification deleted successfully',
    });
  };
}
