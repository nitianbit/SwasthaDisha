export type OAuthAuthorizationUrlParams = {
  clientId: string;
  redirectUri: string;
  state?: string;
  scope?: string;
};

export type OAuthCodeExchangeParams = {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type OAuthRefreshParams = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export type ServiceAccountJwtParams = {
  clientEmail: string;
  privateKey: string;
  impersonatedUser?: string;
  now?: number;
};

export type EventAttendee = { email: string };

export type MeetEventPayloadParams = {
  summary: string;
  description?: string;
  startDateTime: string;
  endDateTime: string;
  timeZone?: string;
  attendees?: EventAttendee[];
  requestId?: string;
};

export type MeetEventPayload = {
  summary: string;
  description?: string;
  start: {
    dateTime: string;
    timeZone: string;
  };
  end: {
    dateTime: string;
    timeZone: string;
  };
  attendees?: EventAttendee[];
  conferenceData: {
    createRequest: {
      requestId: string;
      conferenceSolutionKey: {
        type: 'hangoutsMeet';
      };
    };
  };
};

export type CreateMeetEventParams = {
  accessToken: string;
  calendarId?: string;
  eventPayload: MeetEventPayload;
};

export type PaidBookingEmailContentParams = {
  bookingId?: string;
  bookingType: string;
  bookingDate: string;
  bookingTime: string;
  userName?: string;
  consultationMode?: string;
  serviceMode?: string;
  meetJoinUrl?: string;
};

export type PaidBookingEmailContent = {
  subject: string;
  textBody: string;
  htmlBody: string;
};
