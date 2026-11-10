import { IBooking } from '@/modules/bookings/types';
import TaskQueue from '@/modules/queue/service/TaskQueue';
import {
  BookingReminderPayload,
  ConsumerType,
  ReminderType,
} from '@/modules/queue/types';
import { Service } from 'typedi';

@Service()
export class BookingReminderScheduler {
  private parseBookingDateTime(bookingDate: string, bookingTime: string): Date | null {
    if (!/^\d{8}$/.test(bookingDate)) {
      return null;
    }

    const match = bookingTime.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) {
      return null;
    }

    const [, hourStr, minuteStr, meridiem] = match;
    let hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);

    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
      return null;
    }

    const upperMeridiem = meridiem.toUpperCase();
    if (upperMeridiem === 'AM') {
      hour = hour === 12 ? 0 : hour;
    } else {
      hour = hour === 12 ? 12 : hour + 12;
    }

    const year = parseInt(bookingDate.slice(0, 4), 10);
    const monthIndex = parseInt(bookingDate.slice(4, 6), 10) - 1;
    const day = parseInt(bookingDate.slice(6, 8), 10);

    const parsed = new Date(year, monthIndex, day, hour, minute, 0, 0);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private reminderUniqueId(bookingId: string, reminderType: ReminderType): string {
    return `${bookingId}:${reminderType}`;
  }

  async clearBookingReminders(bookingId: string): Promise<void> {
    await TaskQueue.deleteUniqueJob(
      ConsumerType.BOOKING_REMINDER,
      this.reminderUniqueId(bookingId, 'one_day')
    );
    await TaskQueue.deleteUniqueJob(
      ConsumerType.BOOKING_REMINDER,
      this.reminderUniqueId(bookingId, 'thirty_minutes')
    );
  }

  async scheduleBookingReminders(booking: IBooking): Promise<void> {
    if (!booking._id || !booking.userId || booking.status !== 'confirmed') {
      return;
    }

    const appointmentAt = this.parseBookingDateTime(
      booking.bookingDate,
      booking.bookingTime
    );
    if (!appointmentAt) {
      return;
    }

    const bookingId = booking._id;
    const nowSec = Math.floor(Date.now() / 1000);
    const appointmentSec = Math.floor(appointmentAt.getTime() / 1000);
    const reminders: Array<{ reminderType: ReminderType; processAfterSec: number }> = [
      { reminderType: 'one_day', processAfterSec: appointmentSec - 24 * 60 * 60 },
      { reminderType: 'thirty_minutes', processAfterSec: appointmentSec - 30 * 60 },
    ];

    for (const reminder of reminders) {
      const uniqueId = this.reminderUniqueId(bookingId, reminder.reminderType);

      if (reminder.processAfterSec <= nowSec) {
        await TaskQueue.deleteUniqueJob(ConsumerType.BOOKING_REMINDER, uniqueId);
        continue;
      }

      const payload: BookingReminderPayload = {
        bookingId,
        userId: booking.userId,
        reminderType: reminder.reminderType,
      };

      await TaskQueue.publishUniqueLater(
        ConsumerType.BOOKING_REMINDER,
        uniqueId,
        reminder.processAfterSec,
        payload
      );
    }
  }
}
