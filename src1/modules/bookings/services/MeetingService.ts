import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Service } from 'typedi';

import { CONFIG } from '@/config/config';
import { AppError } from '@/modules/common/types';
import { IBooking, IVirtualMeeting } from '@/modules/bookings/types';
import { BookingRepository } from '@/modules/bookings/repository';
import { UserRepository } from '@/modules/user/repository';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { SlotRepository } from '@/modules/slots/repository';
import logger from '@/services/logger';

interface ServiceAccountCredentials {
  clientEmail: string;
  privateKey: string;
}

interface CalendarEventResponse {
  id: string;
  hangoutLink?: string;
  conferenceData?: {
    conferenceId?: string;
    entryPoints?: Array<{
      entryPointType?: string;
      uri?: string;
    }>;
  };
  start?: {
    dateTime?: string;
  };
  end?: {
    dateTime?: string;
  };
}

@Service()
export class MeetingService {
  private cachedAccessToken?: {
    token: string;
    expiresAt: number;
  };

  constructor(
    private bookingRepository: BookingRepository,
    private userRepository: UserRepository,
    private specialistRepository: SpecialistRepository,
    private slotRepository: SlotRepository
  ) {}

  async syncMeetingForBooking(booking: IBooking): Promise<IBooking> {
    if (!this.isVirtualMeetingApplicable(booking)) {
      return booking;
    }

    try {
      const credentials = this.getServiceAccountCredentials();
      if (!credentials || !CONFIG.GOOGLE_CALENDAR_ID) {
        return this.markMeetingFailure(
          booking,
          'Google Calendar / Meet is not configured'
        );
      }

      const [user, specialist, slot] = await Promise.all([
        this.userRepository.findById(booking.userId),
        booking.specialistId
          ? this.specialistRepository.findById(booking.specialistId)
          : Promise.resolve(null),
        booking.slotId ? this.slotRepository.findById(booking.slotId) : Promise.resolve(null),
      ]);

      if (!user?.email) {
        return this.markMeetingFailure(
          booking,
          'Cannot generate Google Meet link because patient email is missing'
        );
      }

      if (!specialist?.email) {
        return this.markMeetingFailure(
          booking,
          'Cannot generate Google Meet link because specialist email is missing'
        );
      }

      if (!slot) {
        return this.markMeetingFailure(
          booking,
          'Cannot generate Google Meet link because slot details are missing'
        );
      }

      const eventPayload = this.buildEventPayload({
        booking,
        patient: user,
        specialist,
        slot,
      });

      let event: CalendarEventResponse;
      if (booking.virtualMeeting?.calendarEventId) {
        event = await this.updateCalendarEvent(
          booking.virtualMeeting.calendarEventId,
          eventPayload
        );
      } else {
        event = await this.createCalendarEvent(eventPayload);
      }

      const joinUrl =
        event.hangoutLink ||
        event.conferenceData?.entryPoints?.find(
          (entryPoint) => entryPoint.entryPointType === 'video'
        )?.uri;

      if (!joinUrl) {
        return this.markMeetingFailure(
          booking,
          'Google Calendar event was created, but no Meet join URL was returned'
        );
      }

      const virtualMeeting: IVirtualMeeting = {
        provider: 'google_meet',
        status: 'active',
        joinUrl,
        meetingCode: this.extractMeetingCode(joinUrl, event.conferenceData?.conferenceId),
        calendarEventId: event.id,
        startDateTime: event.start?.dateTime || eventPayload.start.dateTime,
        endDateTime: event.end?.dateTime || eventPayload.end.dateTime,
        error: undefined,
        createdAt: booking.virtualMeeting?.createdAt || new Date(),
        updatedAt: new Date(),
      };

      const updatedBooking = await this.bookingRepository.update(
        { _id: booking._id },
        { virtualMeeting }
      );

      return updatedBooking || { ...booking, virtualMeeting };
    } catch (error: any) {
      logger.error('Failed to sync Google Meet event', {
        bookingId: booking._id,
        error: error?.message || error,
      });
      return this.markMeetingFailure(
        booking,
        error?.message || 'Failed to sync Google Meet event'
      );
    }
  }

  async cancelMeetingForBooking(
    booking: IBooking,
    reason?: string
  ): Promise<IBooking> {
    const existingMeeting = booking.virtualMeeting;
    if (!existingMeeting) {
      return booking;
    }

    try {
      if (
        existingMeeting.calendarEventId &&
        this.getServiceAccountCredentials() &&
        CONFIG.GOOGLE_CALENDAR_ID
      ) {
        await this.deleteCalendarEvent(existingMeeting.calendarEventId);
      }
    } catch (error: any) {
      logger.error('Failed to cancel Google Meet event', {
        bookingId: booking._id,
        eventId: existingMeeting.calendarEventId,
        error: error?.message || error,
      });
    }

    const virtualMeeting: IVirtualMeeting = {
      ...existingMeeting,
      provider: 'google_meet',
      status: 'cancelled',
      error: reason,
      updatedAt: new Date(),
      cancelledAt: new Date(),
    };

    const updatedBooking = await this.bookingRepository.update(
      { _id: booking._id },
      { virtualMeeting }
    );

    return updatedBooking || { ...booking, virtualMeeting };
  }

  private isVirtualMeetingApplicable(booking: IBooking): boolean {
    return (
      (booking.bookingType === 'consultation' ||
        booking.bookingType === 'second-opinion') &&
      (booking.consultationMode === 'call' ||
        booking.consultationMode === 'video') &&
      booking.status === 'confirmed' &&
      booking.paymentStatus === 'paid'
    );
  }

  private async markMeetingFailure(
    booking: IBooking,
    message: string
  ): Promise<IBooking> {
    const virtualMeeting: IVirtualMeeting = {
      provider: 'google_meet',
      status: 'failed',
      joinUrl: booking.virtualMeeting?.joinUrl,
      meetingCode: booking.virtualMeeting?.meetingCode,
      calendarEventId: booking.virtualMeeting?.calendarEventId,
      startDateTime: booking.virtualMeeting?.startDateTime,
      endDateTime: booking.virtualMeeting?.endDateTime,
      error: message,
      createdAt: booking.virtualMeeting?.createdAt || new Date(),
      updatedAt: new Date(),
    };

    const updatedBooking = await this.bookingRepository.update(
      { _id: booking._id },
      { virtualMeeting }
    );

    return updatedBooking || { ...booking, virtualMeeting };
  }

  private buildEventPayload(params: {
    booking: IBooking;
    patient: {
      name?: string;
      email?: string;
      phone?: string;
    };
    specialist: {
      name: string;
      email?: string;
      specialization?: string;
    };
    slot: {
      date: string;
      startTime: string;
      endTime: string;
      duration?: number;
    };
  }) {
    const startDateTime = this.buildCalendarDateTime(
      params.slot.date,
      params.slot.startTime
    );
    const endDateTime = this.buildCalendarEndDateTime(
      params.slot.date,
      params.slot.startTime,
      params.slot.endTime,
      params.slot.duration
    );
    const patientDisplayName =
      params.patient.name || params.patient.phone || 'Patient';

    return {
      summary: `${params.specialist.name} consultation with ${patientDisplayName}`,
      description: [
        `Booking ID: ${params.booking._id}`,
        `Booking Type: ${params.booking.bookingType}`,
        params.booking.primaryConcern
          ? `Primary Concern: ${params.booking.primaryConcern}`
          : undefined,
        params.specialist.specialization
          ? `Specialization: ${params.specialist.specialization}`
          : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
      start: {
        dateTime: startDateTime,
        timeZone: CONFIG.GOOGLE_MEET_TIMEZONE,
      },
      end: {
        dateTime: endDateTime,
        timeZone: CONFIG.GOOGLE_MEET_TIMEZONE,
      },
      attendees: this.buildAttendees(
        params.patient.email!,
        params.specialist.email!
      ),
      conferenceData: {
        createRequest: {
          requestId: `booking-${params.booking._id}-${Date.now()}`,
          conferenceSolutionKey: {
            type: 'hangoutsMeet',
          },
        },
      },
    };
  }

  private buildAttendees(patientEmail: string, specialistEmail: string) {
    const uniqueEmails = Array.from(
      new Set([patientEmail.trim().toLowerCase(), specialistEmail.trim().toLowerCase()])
    );

    return uniqueEmails.map((email) => ({ email }));
  }

  private buildCalendarDateTime(dateYyyymmdd: string, time: string): string {
    const year = dateYyyymmdd.slice(0, 4);
    const month = dateYyyymmdd.slice(4, 6);
    const day = dateYyyymmdd.slice(6, 8);
    const normalizedTime = this.parse12HourTime(time);

    return `${year}-${month}-${day}T${normalizedTime}:00`;
  }

  private buildCalendarEndDateTime(
    dateYyyymmdd: string,
    startTime: string,
    endTime: string,
    duration?: number
  ): string {
    const year = dateYyyymmdd.slice(0, 4);
    const month = dateYyyymmdd.slice(4, 6);
    const day = dateYyyymmdd.slice(6, 8);

    if (endTime) {
      return `${year}-${month}-${day}T${this.parse12HourTime(endTime)}:00`;
    }

    const [hours, minutes] = this.parse12HourTime(startTime)
      .split(':')
      .map((value) => Number(value));
    const endDate = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      hours,
      minutes + (duration || 30)
    );

    const endYear = String(endDate.getFullYear());
    const endMonth = String(endDate.getMonth() + 1).padStart(2, '0');
    const endDay = String(endDate.getDate()).padStart(2, '0');
    const endHours = String(endDate.getHours()).padStart(2, '0');
    const endMinutes = String(endDate.getMinutes()).padStart(2, '0');

    return `${endYear}-${endMonth}-${endDay}T${endHours}:${endMinutes}:00`;
  }

  private parse12HourTime(time: string): string {
    const trimmed = time.trim().toUpperCase();
    const match = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
    if (!match) {
      throw new AppError({
        status: 400,
        code: 'INVALID_BOOKING_TIME',
        message: `Unsupported booking time format: ${time}`,
      });
    }

    let hours = Number(match[1]);
    const minutes = match[2];
    const meridiem = match[3];

    if (meridiem === 'AM') {
      hours = hours === 12 ? 0 : hours;
    } else if (hours !== 12) {
      hours += 12;
    }

    return `${String(hours).padStart(2, '0')}:${minutes}`;
  }

  private extractMeetingCode(
    joinUrl?: string,
    fallbackConferenceId?: string
  ): string | undefined {
    if (fallbackConferenceId) {
      return fallbackConferenceId;
    }

    if (!joinUrl) {
      return undefined;
    }

    const segments = joinUrl.split('/').filter(Boolean);
    return segments[segments.length - 1];
  }

  private getServiceAccountCredentials(): ServiceAccountCredentials | null {
    if (
      CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      CONFIG.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
    ) {
      return {
        clientEmail: CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        privateKey: CONFIG.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(
          /\\n/g,
          '\n'
        ),
      };
    }

    const configuredFile =
      CONFIG.GOOGLE_SERVICE_ACCOUNT_FILE ||
      path.resolve(process.cwd(), 'google-service-account.json');

    if (!fs.existsSync(configuredFile)) {
      return null;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(configuredFile, 'utf-8'));
      if (parsed.client_email && parsed.private_key) {
        return {
          clientEmail: parsed.client_email,
          privateKey: String(parsed.private_key).replace(/\\n/g, '\n'),
        };
      }
    } catch (error) {
      logger.error('Failed to read Google service account file', { error });
    }

    return null;
  }

  private async getAccessToken(): Promise<string> {
    const cachedToken = this.cachedAccessToken;
    const now = Math.floor(Date.now() / 1000);

    if (cachedToken && cachedToken.expiresAt > now + 60) {
      return cachedToken.token;
    }

    const credentials = this.getServiceAccountCredentials();
    if (!credentials) {
      throw new AppError({
        status: 500,
        code: 'GOOGLE_MEET_NOT_CONFIGURED',
        message: 'Google service account credentials are not configured',
      });
    }

    const jwtAssertion = this.buildSignedJwt(credentials, now);
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwtAssertion,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new AppError({
        status: 502,
        code: 'GOOGLE_AUTH_FAILED',
        message: `Failed to obtain Google access token: ${text}`,
      });
    }

    const tokenResponse = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    this.cachedAccessToken = {
      token: tokenResponse.access_token,
      expiresAt: now + tokenResponse.expires_in,
    };

    return tokenResponse.access_token;
  }

  private buildSignedJwt(
    credentials: ServiceAccountCredentials,
    now: number
  ): string {
    const header = {
      alg: 'RS256',
      typ: 'JWT',
    };
    const payload: Record<string, string | number> = {
      iss: credentials.clientEmail,
      scope: 'https://www.googleapis.com/auth/calendar',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };

    if (CONFIG.GOOGLE_SERVICE_ACCOUNT_IMPERSONATED_USER) {
      payload.sub = CONFIG.GOOGLE_SERVICE_ACCOUNT_IMPERSONATED_USER;
    }

    const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
    const encodedPayload = this.base64UrlEncode(JSON.stringify(payload));
    const unsignedToken = `${encodedHeader}.${encodedPayload}`;

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsignedToken);
    signer.end();

    const signature = signer.sign(credentials.privateKey);
    return `${unsignedToken}.${this.base64UrlEncode(signature)}`;
  }

  private base64UrlEncode(value: string | Buffer): string {
    return Buffer.from(value)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  private async createCalendarEvent(payload: Record<string, unknown>) {
    return this.calendarRequest<CalendarEventResponse>(
      'POST',
      `/calendars/${encodeURIComponent(
        CONFIG.GOOGLE_CALENDAR_ID!
      )}/events?conferenceDataVersion=1&sendUpdates=all`,
      payload
    );
  }

  private async updateCalendarEvent(
    eventId: string,
    payload: Record<string, unknown>
  ) {
    const { conferenceData, ...updatePayload } = payload;
    void conferenceData;

    return this.calendarRequest<CalendarEventResponse>(
      'PATCH',
      `/calendars/${encodeURIComponent(
        CONFIG.GOOGLE_CALENDAR_ID!
      )}/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=all`,
      updatePayload
    );
  }

  private async deleteCalendarEvent(eventId: string): Promise<void> {
    await this.calendarRequest(
      'DELETE',
      `/calendars/${encodeURIComponent(
        CONFIG.GOOGLE_CALENDAR_ID!
      )}/events/${encodeURIComponent(eventId)}?sendUpdates=all`
    );
  }

  private async calendarRequest<T = void>(
    method: 'POST' | 'PATCH' | 'DELETE',
    endpoint: string,
    payload?: Record<string, unknown>
  ): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(`https://www.googleapis.com/calendar/v3${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new AppError({
        status: 502,
        code: 'GOOGLE_CALENDAR_REQUEST_FAILED',
        message: `Google Calendar request failed: ${text}`,
      });
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}
