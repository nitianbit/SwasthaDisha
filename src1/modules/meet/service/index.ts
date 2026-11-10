import crypto from 'crypto';
import { CONFIG } from '@/config/config';
import { BookingRepository } from '@/modules/bookings/repository';
import { IBooking, IVirtualMeeting } from '@/modules/bookings/types';
import { AppError } from '@/modules/common/types';
import { SlotRepository } from '@/modules/slots/repository';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { UserRepository } from '@/modules/user/repository';
import logger from '@/services/logger';
import {
  OAuthAuthorizationUrlParams,
  OAuthCodeExchangeParams,
  OAuthRefreshParams,
  ServiceAccountJwtParams,
  MeetEventPayloadParams,
  CreateMeetEventParams,
  MeetEventPayload,
  PaidBookingEmailContentParams,
  PaidBookingEmailContent,
} from '@/modules/meet/types';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_BASE_URL = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
let cachedMeetOAuthAccessToken: { token: string; expiresAt: number } | undefined;

export function buildOAuthAuthorizationUrl({
  clientId,
  redirectUri,
  state,
  scope = GOOGLE_CALENDAR_SCOPE,
}: OAuthAuthorizationUrlParams): { authorizationUrl: string; state: string } {
  if (!clientId || !redirectUri) {
    throw new Error('clientId and redirectUri are required');
  }

  const effectiveState = state || crypto.randomBytes(16).toString('hex');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', effectiveState);

  return {
    authorizationUrl: url.toString(),
    state: effectiveState,
  };
}

export async function exchangeOAuthCode({
  code,
  clientId,
  clientSecret,
  redirectUri,
}: OAuthCodeExchangeParams): Promise<Record<string, any>> {
  if (!code || !clientId || !clientSecret || !redirectUri) {
    throw new Error('code, clientId, clientSecret and redirectUri are required');
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OAuth code exchange failed: ${text}`);
  }

  return JSON.parse(text);
}

export async function refreshOAuthAccessToken({
  clientId,
  clientSecret,
  refreshToken,
}: OAuthRefreshParams): Promise<string> {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('clientId, clientSecret and refreshToken are required');
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OAuth refresh failed: ${text}`);
  }

  const tokenResponse = JSON.parse(text) as { access_token: string };
  return tokenResponse.access_token;
}

export function buildServiceAccountJwt({
  clientEmail,
  privateKey,
  impersonatedUser,
  now = Math.floor(Date.now() / 1000),
}: ServiceAccountJwtParams): string {
  if (!clientEmail || !privateKey) {
    throw new Error('clientEmail and privateKey are required');
  }

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload: Record<string, string | number> = {
    iss: clientEmail,
    scope: GOOGLE_CALENDAR_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  if (impersonatedUser) {
    payload.sub = impersonatedUser;
  }

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedToken);
  signer.end();
  const signature = signer.sign(privateKey.replace(/\\n/g, '\n'));

  return `${unsignedToken}.${base64UrlEncode(signature)}`;
}

export async function exchangeServiceAccountJwtForToken(
  jwtAssertion: string
): Promise<string> {
  if (!jwtAssertion) {
    throw new Error('jwtAssertion is required');
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwtAssertion,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Service account token exchange failed: ${text}`);
  }

  return (JSON.parse(text) as { access_token: string }).access_token;
}

export function buildMeetEventPayload({
  summary,
  description,
  startDateTime,
  endDateTime,
  timeZone = 'Asia/Kolkata',
  attendees = [],
  requestId,
}: MeetEventPayloadParams): MeetEventPayload {
  if (!summary || !startDateTime || !endDateTime) {
    throw new Error('summary, startDateTime and endDateTime are required');
  }

  return {
    summary,
    description,
    start: {
      dateTime: startDateTime,
      timeZone,
    },
    end: {
      dateTime: endDateTime,
      timeZone,
    },
    ...(attendees.length > 0 ? { attendees } : {}),
    conferenceData: {
      createRequest: {
        requestId: requestId || `meet-${Date.now()}`,
        conferenceSolutionKey: {
          type: 'hangoutsMeet',
        },
      },
    },
  };
}

export async function createMeetEvent({
  accessToken,
  calendarId = 'primary',
  eventPayload,
}: CreateMeetEventParams): Promise<{
  event: Record<string, any>;
  joinUrl?: string;
  meetingCode?: string;
}> {
  if (!accessToken || !calendarId || !eventPayload) {
    throw new Error('accessToken, calendarId and eventPayload are required');
  }

  const sendUpdates =
    Array.isArray((eventPayload as any).attendees) &&
    (eventPayload as any).attendees.length > 0
      ? 'all'
      : 'none';

  const url = `${GOOGLE_CALENDAR_BASE_URL}/calendars/${encodeURIComponent(
    calendarId
  )}/events?conferenceDataVersion=1&sendUpdates=${sendUpdates}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(eventPayload),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Calendar create event failed: ${text}`);
  }

  const event = JSON.parse(text) as Record<string, any>;
  const joinUrl =
    event.hangoutLink ||
    event.conferenceData?.entryPoints?.find(
      (entry: any) => entry.entryPointType === 'video'
    )?.uri;

  return {
    event,
    joinUrl,
    meetingCode: extractMeetingCode(joinUrl, event.conferenceData?.conferenceId),
  };
}

export function extractMeetingCode(
  joinUrl?: string,
  fallbackConferenceId?: string
): string | undefined {
  if (fallbackConferenceId) return fallbackConferenceId;
  if (!joinUrl) return undefined;
  const parts = joinUrl.split('/').filter(Boolean);
  return parts[parts.length - 1];
}

export function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function buildPaidBookingEmailContent(
  params: PaidBookingEmailContentParams
): PaidBookingEmailContent {
  const displayName = params.userName?.trim() || 'User';
  const bookingType = params.bookingType.replace('-', ' ');
  const subject = `Booking confirmed - ${bookingType}`;
  const accentTitle =
    bookingType === 'consultation' || bookingType === 'second opinion'
      ? 'Your Appointment is Confirmed'
      : 'Your Booking is Confirmed';

  const modeLabel = params.consultationMode || params.serviceMode;
  const modeLine = modeLabel ? `Mode: ${modeLabel}\n` : '';
  const meetLine = params.meetJoinUrl
    ? `Google Meet link: ${params.meetJoinUrl}\n`
    : '';
  const bookingIdLine = params.bookingId ? `Booking ID: ${params.bookingId}\n` : '';

  const textBody =
    `Hi ${displayName},\n\n` +
    `Your booking payment was successful and your booking is confirmed.\n\n` +
    `${bookingIdLine}` +
    `Booking type: ${bookingType}\n` +
    `Date: ${params.bookingDate}\n` +
    `Time: ${params.bookingTime}\n` +
    `${modeLine}` +
    `${meetLine}` +
    `\nThanks,\nEWA Healthcare`;

  const htmlBody =
    `<div style="margin:0;padding:32px 0;background:linear-gradient(180deg,#eef8ff 0%,#ffffff 100%);font-family:Arial,sans-serif;color:#111827;">` +
    `<div style="max-width:760px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 18px 45px rgba(37,99,235,0.12);">` +
    `<div style="background:linear-gradient(90deg,#6d28d9 0%,#7c3aed 45%,#2563eb 100%);padding:28px 32px;">` +
    `<h1 style="margin:0;color:#ffffff;font-size:36px;line-height:1.2;font-weight:700;">${accentTitle}</h1>` +
    `</div>` +
    `<div style="padding:32px;color:#111827;font-size:16px;line-height:1.7;">` +
    `<p style="margin:0 0 18px;">Dear ${displayName},</p>` +
    `<p style="margin:0 0 18px;">Your booking payment was successful and your booking is confirmed.</p>` +
    `<div style="margin:24px 0;padding:22px 24px;background:#f8fbff;border:1px solid #dbeafe;border-radius:14px;">` +
    `${params.bookingId ? `<p style="margin:0 0 10px;"><strong>Booking ID:</strong> ${params.bookingId}</p>` : ''}` +
    `<p style="margin:0 0 10px;"><strong>Booking type:</strong> ${bookingType}</p>` +
    `<p style="margin:0 0 10px;"><strong>Date:</strong> ${params.bookingDate}</p>` +
    `<p style="margin:0 0 10px;"><strong>Time:</strong> ${params.bookingTime}</p>` +
    `${modeLabel ? `<p style="margin:0 0 10px;"><strong>Mode:</strong> ${modeLabel}</p>` : ''}` +
    `${params.meetJoinUrl ? `<p style="margin:0;"><strong>Google Meet link:</strong> <a href="${params.meetJoinUrl}" style="color:#2563eb;text-decoration:none;">${params.meetJoinUrl}</a></p>` : ''}` +
    `</div>` +
    `<p style="margin:24px 0 0;">Thanks,<br/><strong>Myewacare</strong></p>` +
    `</div>` +
    `</div>` +
    `</div>`;

  return {
    subject,
    textBody,
    htmlBody,
  };
}

function isInternalMeetApplicable(booking: IBooking): boolean {
  return (
    (booking.bookingType === 'consultation' ||
      booking.bookingType === 'second-opinion') &&
    (booking.consultationMode === 'call' || booking.consultationMode === 'video') &&
    booking.status === 'confirmed' &&
    booking.paymentStatus === 'paid'
  );
}

function hasOAuthMeetConfig(): boolean {
  return Boolean(
    CONFIG.GOOGLE_OAUTH_CLIENT_ID &&
      CONFIG.GOOGLE_OAUTH_CLIENT_SECRET &&
      CONFIG.GOOGLE_OAUTH_REFRESH_TOKEN &&
      CONFIG.GOOGLE_CALENDAR_ID
  );
}

async function getMeetOAuthAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedMeetOAuthAccessToken && cachedMeetOAuthAccessToken.expiresAt > now + 60) {
    return cachedMeetOAuthAccessToken.token;
  }

  if (
    !CONFIG.GOOGLE_OAUTH_CLIENT_ID ||
    !CONFIG.GOOGLE_OAUTH_CLIENT_SECRET ||
    !CONFIG.GOOGLE_OAUTH_REFRESH_TOKEN
  ) {
    throw new AppError({
      status: 500,
      code: 'GOOGLE_MEET_NOT_CONFIGURED',
      message: 'Google OAuth credentials are not configured',
    });
  }

  const token = await refreshOAuthAccessToken({
    clientId: CONFIG.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: CONFIG.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: CONFIG.GOOGLE_OAUTH_REFRESH_TOKEN,
  });

  cachedMeetOAuthAccessToken = {
    token,
    expiresAt: now + 3500,
  };

  return token;
}

function parse12HourTime(time: string): string {
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

function buildDateTime(dateYyyymmdd: string, time: string): string {
  const year = dateYyyymmdd.slice(0, 4);
  const month = dateYyyymmdd.slice(4, 6);
  const day = dateYyyymmdd.slice(6, 8);
  return `${year}-${month}-${day}T${parse12HourTime(time)}:00`;
}

function buildEndDateTime(
  dateYyyymmdd: string,
  startTime: string,
  endTime?: string,
  duration?: number
): string {
  if (endTime) return buildDateTime(dateYyyymmdd, endTime);

  const [hours, minutes] = parse12HourTime(startTime).split(':').map(Number);
  const year = Number(dateYyyymmdd.slice(0, 4));
  const month = Number(dateYyyymmdd.slice(4, 6)) - 1;
  const day = Number(dateYyyymmdd.slice(6, 8));
  const endDate = new Date(year, month, day, hours, minutes + (duration || 30));
  return `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(
    2,
    '0'
  )}-${String(endDate.getDate()).padStart(2, '0')}T${String(endDate.getHours()).padStart(
    2,
    '0'
  )}:${String(endDate.getMinutes()).padStart(2, '0')}:00`;
}

function buildBookingFailureVirtualMeeting(
  booking: IBooking,
  message: string
): IVirtualMeeting {
  return {
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
}

export async function syncBookingMeet(params: {
  booking: IBooking;
  bookingRepository: BookingRepository;
  userRepository: UserRepository;
  specialistRepository: SpecialistRepository;
  slotRepository: SlotRepository;
}): Promise<IBooking> {
  const { booking, bookingRepository, userRepository, specialistRepository, slotRepository } = params;

  if (!isInternalMeetApplicable(booking)) return booking;
  if (!hasOAuthMeetConfig()) {
    const virtualMeeting = buildBookingFailureVirtualMeeting(
      booking,
      'Google Calendar / Meet is not configured'
    );
    return (
      (await bookingRepository.update({ _id: booking._id }, { virtualMeeting })) || {
        ...booking,
        virtualMeeting,
      }
    );
  }

  try {
    const [user, specialist, slot] = await Promise.all([
      userRepository.findById(booking.userId),
      booking.specialistId
        ? specialistRepository.findById(booking.specialistId)
        : Promise.resolve(null),
      booking.slotId ? slotRepository.findById(booking.slotId) : Promise.resolve(null),
    ]);

    if (!user?.email || !specialist?.email || !slot) {
      const reason = !user?.email
        ? 'Cannot generate Google Meet link because patient email is missing'
        : !specialist?.email
        ? 'Cannot generate Google Meet link because specialist email is missing'
        : 'Cannot generate Google Meet link because slot details are missing';
      const virtualMeeting = buildBookingFailureVirtualMeeting(booking, reason);
      return (
        (await bookingRepository.update({ _id: booking._id }, { virtualMeeting })) || {
          ...booking,
          virtualMeeting,
        }
      );
    }

    const startDateTime = buildDateTime(slot.date, slot.startTime);
    const endDateTime = buildEndDateTime(
      slot.date,
      slot.startTime,
      slot.endTime,
      slot.duration
    );

    const eventPayload = buildMeetEventPayload({
      summary: `${specialist.name} consultation with ${user.name || user.phone || 'Patient'}`,
      description: [
        `Booking ID: ${booking._id}`,
        `Booking Type: ${booking.bookingType}`,
        booking.primaryConcern ? `Primary Concern: ${booking.primaryConcern}` : undefined,
        specialist.specialization ? `Specialization: ${specialist.specialization}` : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
      startDateTime,
      endDateTime,
      timeZone: CONFIG.GOOGLE_MEET_TIMEZONE || 'Asia/Kolkata',
      attendees: Array.from(
        new Set([user.email.trim().toLowerCase(), specialist.email.trim().toLowerCase()])
      ).map((email) => ({ email })),
      requestId: `booking-${booking._id}-${Date.now()}`,
    });

    const accessToken = await getMeetOAuthAccessToken();
    let event: Record<string, any>;
    let joinUrl: string | undefined;

    if (booking.virtualMeeting?.calendarEventId) {
      const { conferenceData, ...updatePayload } = eventPayload;
      void conferenceData;
      const response = await fetch(
        `${GOOGLE_CALENDAR_BASE_URL}/calendars/${encodeURIComponent(
          CONFIG.GOOGLE_CALENDAR_ID!
        )}/events/${encodeURIComponent(
          booking.virtualMeeting.calendarEventId
        )}?conferenceDataVersion=1&sendUpdates=all`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(updatePayload),
        }
      );
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Google Calendar request failed: ${text}`);
      }
      event = JSON.parse(text);
      joinUrl =
        event.hangoutLink ||
        event.conferenceData?.entryPoints?.find(
          (entry: any) => entry.entryPointType === 'video'
        )?.uri;
    } else {
      const created = await createMeetEvent({
        accessToken,
        calendarId: CONFIG.GOOGLE_CALENDAR_ID!,
        eventPayload,
      });
      event = created.event;
      joinUrl = created.joinUrl;
    }

    if (!joinUrl) {
      throw new Error(
        'Google Calendar event was created, but no Meet join URL was returned'
      );
    }

    const virtualMeeting: IVirtualMeeting = {
      provider: 'google_meet',
      status: 'active',
      joinUrl,
      meetingCode: extractMeetingCode(joinUrl, event.conferenceData?.conferenceId),
      calendarEventId: event.id,
      startDateTime: event.start?.dateTime || startDateTime,
      endDateTime: event.end?.dateTime || endDateTime,
      error: undefined,
      createdAt: booking.virtualMeeting?.createdAt || new Date(),
      updatedAt: new Date(),
    };

    return (
      (await bookingRepository.update({ _id: booking._id }, { virtualMeeting })) || {
        ...booking,
        virtualMeeting,
      }
    );
  } catch (error: any) {
    logger.error('Failed to sync Google Meet event', {
      bookingId: booking._id,
      error: error?.message || error,
    });
    const virtualMeeting = buildBookingFailureVirtualMeeting(
      booking,
      error?.message || 'Failed to sync Google Meet event'
    );
    return (
      (await bookingRepository.update({ _id: booking._id }, { virtualMeeting })) || {
        ...booking,
        virtualMeeting,
      }
    );
  }
}

export async function cancelBookingMeet(params: {
  booking: IBooking;
  reason?: string;
  bookingRepository: BookingRepository;
}): Promise<IBooking> {
  const { booking, reason, bookingRepository } = params;
  const existingMeeting = booking.virtualMeeting;
  if (!existingMeeting) return booking;

  try {
    if (existingMeeting.calendarEventId && hasOAuthMeetConfig()) {
      const accessToken = await getMeetOAuthAccessToken();
      await fetch(
        `${GOOGLE_CALENDAR_BASE_URL}/calendars/${encodeURIComponent(
          CONFIG.GOOGLE_CALENDAR_ID!
        )}/events/${encodeURIComponent(existingMeeting.calendarEventId)}?sendUpdates=all`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
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

  return (
    (await bookingRepository.update({ _id: booking._id }, { virtualMeeting })) || {
      ...booking,
      virtualMeeting,
    }
  );
}
