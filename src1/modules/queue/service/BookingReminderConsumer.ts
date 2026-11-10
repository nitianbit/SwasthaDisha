import { BookingRepository } from '@/modules/bookings/repository';
import { FcmService } from '@/modules/fcm/services';
import { NotificationService } from '@/modules/notification/services';
import JobConsumer from '@/modules/queue/service/JobConsumer';
import {
  BookingReminderPayload,
  ConsumerType,
  JobPayload,
} from '@/modules/queue/types';
import { Container } from 'typedi';

class BookingReminderConsumer extends JobConsumer {
  constructor() {
    super(ConsumerType.BOOKING_REMINDER);
  }

  async consume(payload: JobPayload): Promise<boolean> {
    const data = payload as BookingReminderPayload;
    if (!data.bookingId || !data.userId || !data.reminderType) {
      return true;
    }

    const bookingRepository = Container.get(BookingRepository);
    const notificationService = Container.get(NotificationService);
    const fcmService = Container.get(FcmService);

    const booking = await bookingRepository.findById(data.bookingId);
    if (!booking) {
      return true;
    }

    if (booking.status !== 'confirmed') {
      return true;
    }

    const title = 'Booking Reminder';
    const message =
      data.reminderType === 'one_day'
        ? `Reminder: You have a ${booking.bookingType} booking tomorrow at ${booking.bookingTime}.`
        : `Reminder: You have a ${booking.bookingType} booking in 30 minutes at ${booking.bookingTime}.`;

    await notificationService.create({
      userId: data.userId,
      type: 'reminder',
      title,
      message,
      data: {
        bookingId: booking._id,
        bookingType: booking.bookingType,
        bookingDate: booking.bookingDate,
        bookingTime: booking.bookingTime,
        reminderType: data.reminderType,
      },
      referenceType: 'booking',
      referenceId: booking._id,
    });

    await fcmService.sendNotificationToUser(data.userId, {
      title,
      body: message,
      data: {
        type: 'booking_reminder',
        bookingId: booking._id || '',
        reminderType: data.reminderType,
      },
    }, 'user');

    if (booking.specialistId) {
      await notificationService.createSpecialistUpcomingAppointmentNotification(
        booking.specialistId,
        booking._id!,
        {
          bookingType: booking.bookingType,
          bookingDate: booking.bookingDate,
          bookingTime: booking.bookingTime,
          reminderType: data.reminderType,
          userId: booking.userId,
        }
      );

      await fcmService.sendNotificationToUser(
        booking.specialistId,
        {
          title: 'Upcoming Appointment',
          body:
            data.reminderType === 'one_day'
              ? `Reminder: You have an appointment tomorrow at ${booking.bookingTime}.`
              : `Reminder: You have an appointment in 30 minutes at ${booking.bookingTime}.`,
          data: {
            type: 'specialist_upcoming_appointment',
            bookingId: booking._id || '',
            reminderType: data.reminderType,
          },
        },
        'specialist'
      );
    }

    return true;
  }
}

const bookingReminderConsumer = new BookingReminderConsumer();
export default bookingReminderConsumer;
