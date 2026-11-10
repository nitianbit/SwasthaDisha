# Meet API Curl Requests

All routes below use `api/v1/meet` paths.

## Headers

For protected routes, include your admin JWT:

```bash
Authorization: Bearer PASTE_ADMIN_JWT_HERE
```

## 1) Get OAuth Consent URL

```bash
curl --location "http://localhost:4030/api/v1/meet/google-oauth/url" \
  --header "Authorization: Bearer PASTE_ADMIN_JWT_HERE"
```

## 2) OAuth Callback (redirect target)

Google redirects here after consent. This endpoint is public:

```bash
curl --location "http://localhost:4030/api/v1/meet/google-oauth/callback?code=PASTE_CODE&state=PASTE_STATE&scope=PASTE_SCOPE"
```

## 3) Exchange OAuth Code

```bash
curl --location "http://localhost:4030/api/v1/meet/google-oauth/exchange" \
  --header "Authorization: Bearer PASTE_ADMIN_JWT_HERE" \
  --header "Content-Type: application/json" \
  --data '{
    "code": "PASTE_GOOGLE_CODE"
  }'
```

## 4) Test Refresh Token

If refresh token is already saved in `.env`:

```bash
curl --location "http://localhost:4030/api/v1/meet/google-oauth/refresh" \
  --header "Authorization: Bearer PASTE_ADMIN_JWT_HERE" \
  --header "Content-Type: application/json" \
  --data '{}'
```

Or pass refresh token explicitly:

```bash
curl --location "http://localhost:4030/api/v1/meet/google-oauth/refresh" \
  --header "Authorization: Bearer PASTE_ADMIN_JWT_HERE" \
  --header "Content-Type: application/json" \
  --data '{
    "refreshToken": "PASTE_REFRESH_TOKEN"
  }'
```

## 5) Create Meet Event with OAuth

```bash
curl --location "http://localhost:4030/api/v1/meet/google-meet/oauth" \
  --header "Authorization: Bearer PASTE_ADMIN_JWT_HERE" \
  --header "Content-Type: application/json" \
  --data '{
    "patientEmail": "patient@example.com",
    "specialistEmail": "doctor@example.com",
    "dateYyyymmdd": "20260422",
    "startTime": "10:30 AM",
    "durationMinutes": 30,
    "summary": "EWA OAuth Meet Test"
  }'
```
