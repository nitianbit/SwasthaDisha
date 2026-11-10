import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '@/modules/middleware/auth';
import { CONFIG } from '@/config/config';
import {
  buildOAuthAuthorizationUrl,
  exchangeOAuthCode,
  refreshOAuthAccessToken,
  buildMeetEventPayload,
  createMeetEvent,
} from '@/modules/meet/service';

export class MeetController {
  getGoogleOAuthAuthorizationUrl = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    if (!CONFIG.GOOGLE_OAUTH_CLIENT_ID || !CONFIG.GOOGLE_OAUTH_REDIRECT_URI) {
      res.status(500).json({
        success: false,
        message: 'Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_REDIRECT_URI',
      });
      return;
    }

    const result = buildOAuthAuthorizationUrl({
      clientId: CONFIG.GOOGLE_OAUTH_CLIENT_ID,
      redirectUri: CONFIG.GOOGLE_OAUTH_REDIRECT_URI,
      state: req.query.state as string | undefined,
    });

    res.status(200).json({
      success: true,
      message: 'Open authorizationUrl in browser and complete consent',
      data: result,
    });
  };

  googleOAuthCallback = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const scope = req.query.scope as string | undefined;
    const error = req.query.error as string | undefined;

    if (error) {
      res.status(400).json({
        success: false,
        message: 'Google OAuth callback returned an error',
        data: { error, state },
      });
      return;
    }

    if (!code) {
      res.status(400).json({
        success: false,
        message: 'No code found in callback query params',
        data: { state, scope },
      });
      return;
    }

    res.status(200).json({
      success: true,
      message:
        'Google OAuth callback received. Use this code in POST /api/v1/meet/google-oauth/exchange.',
      data: { code, state, scope },
    });
  };

  exchangeGoogleOAuthCode = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    if (!CONFIG.GOOGLE_OAUTH_CLIENT_ID || !CONFIG.GOOGLE_OAUTH_CLIENT_SECRET) {
      res.status(500).json({
        success: false,
        message: 'Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET',
      });
      return;
    }

    const tokenResponse = await exchangeOAuthCode({
      code: req.body.code as string,
      clientId: CONFIG.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: CONFIG.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri:
        (req.body.redirectUri as string | undefined) ||
        CONFIG.GOOGLE_OAUTH_REDIRECT_URI ||
        '',
    });

    res.status(200).json({
      success: true,
      message:
        'Code exchanged. Save refresh_token to GOOGLE_OAUTH_REFRESH_TOKEN in .env and restart backend.',
      data: tokenResponse,
    });
  };

  testGoogleOAuthRefresh = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    if (!CONFIG.GOOGLE_OAUTH_CLIENT_ID || !CONFIG.GOOGLE_OAUTH_CLIENT_SECRET) {
      res.status(500).json({
        success: false,
        message: 'Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET',
      });
      return;
    }

    const refreshToken =
      (req.body.refreshToken as string | undefined) ||
      CONFIG.GOOGLE_OAUTH_REFRESH_TOKEN;
    if (!refreshToken) {
      res.status(400).json({
        success: false,
        message:
          'refreshToken is required (body.refreshToken or GOOGLE_OAUTH_REFRESH_TOKEN)',
      });
      return;
    }

    const accessToken = await refreshOAuthAccessToken({
      clientId: CONFIG.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: CONFIG.GOOGLE_OAUTH_CLIENT_SECRET,
      refreshToken,
    });

    res.status(200).json({
      success: true,
      message: 'OAuth refresh token is valid',
      data: { accessTokenPreview: `${accessToken.slice(0, 20)}...` },
    });
  };

  testGoogleMeetWithOAuth = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    if (!CONFIG.GOOGLE_OAUTH_CLIENT_ID || !CONFIG.GOOGLE_OAUTH_CLIENT_SECRET) {
      res.status(500).json({
        success: false,
        message: 'Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET',
      });
      return;
    }

    const refreshToken =
      (req.body.refreshToken as string | undefined) ||
      CONFIG.GOOGLE_OAUTH_REFRESH_TOKEN;
    if (!refreshToken) {
      res.status(400).json({
        success: false,
        message:
          'refreshToken is required (body.refreshToken or GOOGLE_OAUTH_REFRESH_TOKEN)',
      });
      return;
    }

    const accessToken = await refreshOAuthAccessToken({
      clientId: CONFIG.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: CONFIG.GOOGLE_OAUTH_CLIENT_SECRET,
      refreshToken,
    });

    const dateYyyymmdd =
      (req.body.dateYyyymmdd as string | undefined) || this.getTomorrowYyyymmdd();
    const startTime = (req.body.startTime as string | undefined) || '10:00 AM';
    const durationMinutes = (req.body.durationMinutes as number | undefined) ?? 30;
    const startDateTime = this.buildCalendarDateTime(dateYyyymmdd, startTime);
    const endDateTime = this.buildCalendarEndDateTime(
      dateYyyymmdd,
      startTime,
      durationMinutes
    );

    const eventPayload = buildMeetEventPayload({
      summary: (req.body.summary as string | undefined) || 'Google Meet test (OAuth)',
      description: 'Created from test OAuth endpoint',
      startDateTime,
      endDateTime,
      timeZone: CONFIG.GOOGLE_MEET_TIMEZONE || 'Asia/Kolkata',
      attendees: [
        { email: req.body.patientEmail as string },
        { email: req.body.specialistEmail as string },
      ],
    });

    const result = await createMeetEvent({
      accessToken,
      calendarId: CONFIG.GOOGLE_CALENDAR_ID || 'primary',
      eventPayload,
    });

    res.status(200).json({
      success: true,
      message: 'Google Meet event created using OAuth flow',
      data: result,
    });
  };

  private getTomorrowYyyymmdd(): string {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
      date.getDate()
    ).padStart(2, '0')}`;
  }

  private buildCalendarDateTime(dateYyyymmdd: string, time12h: string): string {
    const year = dateYyyymmdd.slice(0, 4);
    const month = dateYyyymmdd.slice(4, 6);
    const day = dateYyyymmdd.slice(6, 8);
    const [time, meridiem] = time12h.trim().toUpperCase().split(/\s+/);
    const [h, m] = time.split(':').map(Number);
    let hour = h;
    if (meridiem === 'AM') hour = h === 12 ? 0 : h;
    if (meridiem === 'PM') hour = h === 12 ? 12 : h + 12;
    return `${year}-${month}-${day}T${String(hour).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  }

  private buildCalendarEndDateTime(
    dateYyyymmdd: string,
    startTime12h: string,
    durationMinutes: number
  ): string {
    const start = this.buildCalendarDateTime(dateYyyymmdd, startTime12h);
    const date = new Date(start);
    date.setMinutes(date.getMinutes() + durationMinutes);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate()
    ).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(
      date.getMinutes()
    ).padStart(2, '0')}:00`;
  }
}
