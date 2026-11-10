import { Service } from 'typedi';
import { NotificationRepository } from '@/modules/notification/repository';
import { UserRepository } from '@/modules/user/repository';
import { FcmService } from '@/modules/fcm/services';
import {
  INotification,
  CreateNotificationRequest,
  CreateGeneralNotificationRequest,
  UpdateNotificationRequest,
  NotificationQueryParams,
} from '@/modules/notification/types';
import { AppError } from '@/modules/common/types';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';

@Service()
export class NotificationService {
  constructor(
    private notificationRepository: NotificationRepository,
    private userRepository: UserRepository,
    private fcmService: FcmService
  ) {}

  async create(data: CreateNotificationRequest): Promise<INotification> {
    const notification: INotification = {
      userId: data.userId,
      type: data.type,
      title: data.title,
      message: data.message,
      isRead: false,
      data: data.data || {},
      referenceType: data.referenceType,
      referenceId: data.referenceId,
      idempotencyKey: data.idempotencyKey,
    };

    try {
      return await this.notificationRepository.save(notification);
    } catch (error) {
      if (data.idempotencyKey && isDuplicateKeyError(error)) {
        const existing = await this.notificationRepository.findOne({
          idempotencyKey: data.idempotencyKey,
        });
        if (existing) return existing;
      }
      throw error;
    }
  }

  async markFcmSent(id: string): Promise<void> {
    await this.notificationRepository.update({ _id: id }, { fcmSentAt: new Date() });
  }

  async getById(id: string): Promise<INotification> {
    const notification = await this.notificationRepository.findById(id);

    if (!notification) {
      throw new AppError({
        status: 404,
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification not found',
      });
    }

    return notification;
  }

  async getAll(queryParams: NotificationQueryParams = {}): Promise<{
    data: INotification[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    if (queryParams.page && queryParams.limit) {
      return this.notificationRepository.findWithPagination(
        queryParams,
        queryParams.page,
        queryParams.limit
      );
    }

    const filter: any = {};

    if (queryParams.userId) {
      filter.userId = queryParams.userId;
    }

    if (queryParams.type) {
      filter.type = queryParams.type;
    }

    if (queryParams.isRead !== undefined) {
      filter.isRead = queryParams.isRead;
    }

    const sort: any = {};
    if (queryParams.sortBy) {
      sort[queryParams.sortBy] = queryParams.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.createdAt = -1; // Most recent first
    }

    const data = await this.notificationRepository.findAll(filter, { sort });
    return { data };
  }

  async getByUserId(userId: string): Promise<INotification[]> {
    return this.notificationRepository.findByUserId(userId);
  }

  async getUnreadByUserId(userId: string): Promise<INotification[]> {
    return this.notificationRepository.findUnreadByUserId(userId);
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.notificationRepository.getUnreadCount(userId);
  }

  async getBySpecialistId(specialistId: string): Promise<INotification[]> {
    return this.notificationRepository.findByUserId(specialistId);
  }

  async getUnreadBySpecialistId(
    specialistId: string
  ): Promise<INotification[]> {
    return this.notificationRepository.findUnreadByUserId(specialistId);
  }

  async getUnreadCountBySpecialistId(specialistId: string): Promise<number> {
    return this.notificationRepository.getUnreadCount(specialistId);
  }

  async markAllAsReadForSpecialist(specialistId: string): Promise<void> {
    await this.notificationRepository.markAllAsRead(specialistId);
  }

  async markSpecialistNotificationAsRead(
    id: string,
    specialistId: string
  ): Promise<INotification> {
    const notification = await this.notificationRepository.findById(id);
    if (!notification || notification.userId !== specialistId) {
      throw new AppError({
        status: 404,
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification not found',
      });
    }

    return this.markAsRead(id);
  }

  async update(
    id: string,
    data: UpdateNotificationRequest
  ): Promise<INotification> {
    const notification = await this.notificationRepository.findById(id);

    if (!notification) {
      throw new AppError({
        status: 404,
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification not found',
      });
    }

    const updateData: any = {};
    if (data.isRead !== undefined) {
      updateData.isRead = data.isRead;
      if (data.isRead && !notification.isRead) {
        updateData.readAt = new Date();
      }
    }

    const updated = await this.notificationRepository.update(
      { _id: id },
      updateData
    );

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update notification',
      });
    }

    return updated;
  }

  async markAsRead(id: string): Promise<INotification> {
    const notification = await this.notificationRepository.markAsRead(id);

    if (!notification) {
      throw new AppError({
        status: 404,
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification not found',
      });
    }

    return notification;
  }

  async markAllAsRead(userId: string): Promise<void> {
    await this.notificationRepository.markAllAsRead(userId);
  }

  async delete(id: string): Promise<void> {
    const notification = await this.notificationRepository.findById(id);

    if (!notification) {
      throw new AppError({
        status: 404,
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification not found',
      });
    }

    await this.notificationRepository.delete({ _id: id });
  }

  // Helper methods for creating specific notification types

  async createLoginNotification(userId: string): Promise<INotification> {
    return this.create({
      userId,
      type: 'login',
      title: 'Welcome back!',
      message: 'You have successfully logged in to your account.',
      data: { loginTime: new Date().toISOString() },
    });
  }

  async createSpecialistLoginNotification(
    specialistId: string
  ): Promise<INotification> {
    return this.create({
      userId: specialistId,
      type: 'specialist_login',
      title: 'Welcome back!',
      message: 'You have successfully logged in to your specialist account.',
      data: { loginTime: new Date().toISOString() },
    });
  }

  async createBookingCreatedNotification(
    userId: string,
    bookingId: string,
    bookingData?: Record<string, any>
  ): Promise<INotification> {
    return this.create({
      userId,
      type: 'booking_created',
      title: 'Booking Created',
      message: 'Your booking has been created successfully. We will confirm it shortly.',
      data: bookingData || {},
      referenceType: 'booking',
      referenceId: bookingId,
    });
  }

  async createSpecialistNewBookingNotification(
    specialistId: string,
    bookingId: string,
    bookingData?: Record<string, any>
  ): Promise<INotification> {
    return this.create({
      userId: specialistId,
      type: 'specialist_new_booking',
      title: 'New Appointment Booked',
      message: 'A new appointment has been booked with you.',
      data: bookingData || {},
      referenceType: 'booking',
      referenceId: bookingId,
    });
  }

  async createSpecialistUpcomingAppointmentNotification(
    specialistId: string,
    bookingId: string,
    bookingData?: Record<string, any>
  ): Promise<INotification> {
    return this.create({
      userId: specialistId,
      type: 'specialist_upcoming_appointment',
      title: 'Upcoming Appointment',
      message: 'You have an upcoming appointment scheduled soon.',
      data: bookingData || {},
      referenceType: 'booking',
      referenceId: bookingId,
    });
  }

  async createSpecialistAppointmentCancelledNotification(
    specialistId: string,
    bookingId: string,
    bookingData?: Record<string, any>
  ): Promise<INotification> {
    return this.create({
      userId: specialistId,
      type: 'specialist_appointment_cancelled',
      title: 'Appointment Cancelled',
      message: 'An appointment assigned to you has been cancelled.',
      data: bookingData || {},
      referenceType: 'booking',
      referenceId: bookingId,
    });
  }

  async createSpecialistAppointmentConfirmedNotification(
    specialistId: string,
    bookingId: string,
    bookingData?: Record<string, any>
  ): Promise<INotification> {
    return this.create({
      userId: specialistId,
      type: 'specialist_appointment_confirmed',
      title: 'Appointment Confirmed',
      message: 'An appointment assigned to you has been confirmed.',
      data: bookingData || {},
      referenceType: 'booking',
      referenceId: bookingId,
    });
  }

  async createSpecialistAppointmentCompletedNotification(
    specialistId: string,
    bookingId: string,
    bookingData?: Record<string, any>
  ): Promise<INotification> {
    return this.create({
      userId: specialistId,
      type: 'specialist_appointment_completed',
      title: 'Appointment Completed',
      message: 'An appointment assigned to you has been marked completed.',
      data: bookingData || {},
      referenceType: 'booking',
      referenceId: bookingId,
    });
  }

  async createWalletCreditNotification(
    userId: string,
    transactionId: string,
    amount: number,
    transactionData?: Record<string, any>
  ): Promise<INotification> {
    return this.create({
      userId,
      type: 'wallet_credit',
      title: 'Wallet Credited',
      message: `₹${amount} has been credited to your wallet.`,
      data: {
        amount,
        ...transactionData,
      },
      referenceType: 'wallet_transaction',
      referenceId: transactionId,
    });
  }

  /**
   * Create and send a notification to multiple users.
   * - If userIds is provided (non-empty): send only to those users.
   * - Else if corporateId is provided: send to all users belonging to that corporate.
   * - Else: send to all users (userType 'user').
   * Also sends FCM push to each target user if they have a token.
   */
  async createGeneralNotification(
    data: CreateGeneralNotificationRequest
  ): Promise<{ created: number; targetUserIds: string[] }> {
    let targetUserIds: string[] = [];

    if (data.userIds && data.userIds.length > 0) {
      targetUserIds = data.userIds;
    } else if (data.corporateId) {
      const users = await this.userRepository.findAll(
        { userType: 'user', corporateId: data.corporateId },
        { select: { _id: 1 } }
      );
      targetUserIds = users
        .map((u) => (u as any)._id?.toString())
        .filter(Boolean);
    } else {
      const users = await this.userRepository.findAll(
        { userType: 'user' },
        { select: { _id: 1 } }
      );
      targetUserIds = users
        .map((u) => (u as any)._id?.toString())
        .filter(Boolean);
    }

    const notifications: INotification[] = targetUserIds.map((userId) => ({
      userId,
      type: data.type,
      title: data.title,
      message: data.message,
      isRead: false,
      data: data.data ?? {},
      referenceType: data.referenceType,
      referenceId: data.referenceId,
    }));

    const created =
      await this.notificationRepository.insertMany(notifications);

    if (targetUserIds.length > 0) {
      try {
        await this.fcmService.sendNotificationToUsers(targetUserIds, {
          title: data.title,
          body: data.message,
          data: data.data
            ? Object.fromEntries(
                Object.entries(data.data).map(([k, v]) => [k, String(v)])
              )
            : undefined,
        });
      } catch {
        // In-app notifications were created; FCM is best-effort
      }
    }

    return { created, targetUserIds };
  }
}
