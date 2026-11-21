import { IBooking } from '@/modules/bookings/types';
import TaskQueue from '@/modules/queue/service/TaskQueue';
import {
  BookingReminderPayload,
  ConsumerType,
  ReminderType,
} from '@/modules/queue/types';
import { Service } from 'typedi';
import { parseAppointment } from '@/modules/common/utils/cancellationWindow';

@Service()
export class BookingReminderScheduler {
  /**
   * Q16a (M3): the appointment instant in India time, from either stored slot format (`h:mm AM/PM` from the slot API,
   * `HH:mm` from weekly templates) — the one appointment parser every other path uses.
   */
  private parseBookingDateTime(bookingDate: string, bookingTime: string): Date | null {
    return parseAppointment({ bookingDate: String(bookingDate ?? ''), bookingTime: String(bookingTime ?? '') })?.at ?? null;
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
      // Q16a: a time that cannot be read schedules nothing, and the jobs of the booking's earlier time are removed.
      await this.clearBookingReminders(booking._id);
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
