# Google Cloud Setup for Meet OAuth

This guide explains how to configure Google Cloud and Google Auth Platform for `api/v1/meet` OAuth flow.

## 1) Create or Select Google Cloud Project

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Select existing project or create a new project.

## 2) Enable Google Calendar API

1. Go to **APIs & Services** > **Library**.
2. Search for **Google Calendar API**.
3. Click **Enable**.

## 3) Configure OAuth Consent Screen

1. Go to **Google Auth Platform** > **Branding / Audience / Data Access** (or **APIs & Services** > **OAuth consent screen**, depending on UI).
2. App type: **External** (for personal Gmail accounts).
3. Fill required app details:
   - App name
   - Support email
   - Developer contact email
4. Add test users in **Audience**:
   - Add the Google account(s) you will use for login.
5. Add scopes in **Data Access**:
   - Recommended: `https://www.googleapis.com/auth/calendar`

## 4) Create OAuth Client

1. Go to **Google Auth Platform** > **Clients**.
2. Click **Create OAuth client**.
3. Application type: **Web application**.
4. Add **Authorized redirect URI**:

   - `http://localhost:4030/api/v1/meet/google-oauth/callback`

5. Save.
6. Copy:
   - **Client ID**
   - **Client Secret**

## 5) Configure Backend `.env`

Update `ewa_backend/.env`:

```env
GOOGLE_CALENDAR_ID=primary
GOOGLE_MEET_TIMEZONE=Asia/Kolkata

GOOGLE_OAUTH_CLIENT_ID=PASTE_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET=PASTE_CLIENT_SECRET
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:4030/api/v1/meet/google-oauth/callback
GOOGLE_OAUTH_REFRESH_TOKEN=
```

Restart backend after changes.

## 6) Generate Refresh Token (one-time setup)

1. Call:
   - `GET /api/v1/meet/google-oauth/url` (admin auth required)
2. Open returned `authorizationUrl` in browser.
3. Sign in and grant consent.
4. Google redirects to:
   - `GET /api/v1/meet/google-oauth/callback?...`
5. Copy `code` from response.
6. Exchange:
   - `POST /api/v1/meet/google-oauth/exchange`
7. Copy `refresh_token` from response.
8. Put it in `.env`:
   - `GOOGLE_OAUTH_REFRESH_TOKEN=...`
9. Restart backend.

## 7) Verify Setup

1. Test refresh token:
   - `POST /api/v1/meet/google-oauth/refresh`
2. Create meet test event:
   - `POST /api/v1/meet/google-meet/oauth`

## Common Issues

- `invalid_grant` on refresh:
  - wrong refresh token
  - client ID/secret mismatch with token
  - token revoked
  - app still not allowed for that user (test users missing)
- Redirect URI mismatch:
  - URI in Google client and `.env` must be exactly the same.
- Missing auth on protected routes:
  - use app admin JWT in `Authorization: Bearer ...`
  - do not use Google access token as backend JWT.
