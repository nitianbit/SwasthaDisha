import { AppError } from '@/modules/common/types';

type CancellationAppointment = {
  bookingDate: string;
  bookingTime: string;
};

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export function parseAppointment({
  bookingDate,
  bookingTime,
}: CancellationAppointment): { at: Date; weekday: number } | null {
  if (
    typeof bookingDate !== 'string' ||
    typeof bookingTime !== 'string' ||
    !/^\d{8}$/.test(bookingDate)
  ) {
    return null;
  }

  const match = bookingTime
    .trim()
    .match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return null;

  const year = Number(bookingDate.slice(0, 4));
  const month = Number(bookingDate.slice(4, 6));
  const day = Number(bookingDate.slice(6, 8));
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  const meridiem = match[4]?.toUpperCase();

  if (
    month < 1 || month > 12 ||
    minute > 59 || second > 59 ||
    (meridiem ? hour < 1 || hour > 12 : hour > 23)
  ) {
    return null;
  }

  if (meridiem) {
    hour = hour % 12 + (meridiem === 'PM' ? 12 : 0);
  }

  const localDate = new Date(Date.UTC(year, month - 1, day));
  if (
    localDate.getUTCFullYear() !== year ||
    localDate.getUTCMonth() !== month - 1 ||
    localDate.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    at: new Date(
      Date.UTC(year, month - 1, day, hour, minute, second) - IST_OFFSET_MS
    ),
    weekday: localDate.getUTCDay(),
  };
}

export function enforceUserCancellationWindow(
  appointments: CancellationAppointment[],
  userType: string,
  now = new Date()
): void {
  const parsed = appointments.map(parseAppointment);
  if (!parsed.length || parsed.some((appointment) => !appointment)) {
    throw new AppError({
      status: 400,
      code: 'INVALID_BOOKING_DATETIME',
      message: 'Booking cannot be cancelled because its appointment time is invalid',
    });
  }

  const appointmentsByTime = parsed
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((left, right) => left.at.getTime() - right.at.getTime());
  const earliestAppointment = appointmentsByTime[0];

  if (earliestAppointment.at.getTime() <= now.getTime()) {
    throw new AppError({
      status: 400,
      code: 'BOOKING_ALREADY_STARTED',
      message: 'Booking cannot be cancelled once the appointment time has passed',
    });
  }

  if (userType !== 'user') return;

  const cancellationDeadline = appointmentsByTime
    .map((appointment) => {
      const cutoffHours = appointment.weekday === 1 ? 48 : 24;
      return {
        cutoffHours,
        at: appointment.at.getTime() - cutoffHours * HOUR_MS,
      };
    })
    .sort((left, right) => left.at - right.at)[0];

  if (now.getTime() >= cancellationDeadline.at) {
    throw new AppError({
      status: 400,
      code: 'CANCELLATION_WINDOW_CLOSED',
      message: `Booking cannot be cancelled within ${cancellationDeadline.cutoffHours} hours of the appointment time`,
    });
  }
}
