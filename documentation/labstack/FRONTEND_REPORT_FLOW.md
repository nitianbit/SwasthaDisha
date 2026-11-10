# Frontend Report Flow

This file explains how the frontend should fetch reports and documents for external bookings.

Base backend URL:

- `https://api.myewacare.com`

All endpoints below require the normal user bearer token.

## 1. First Get The User's External Bookings

Frontend should first fetch the user's external bookings and identify the booking to open.

API:

- `GET /api/v1/external-bookings/bookings`

Example:

```bash
curl --location 'https://api.myewacare.com/api/v1/external-bookings/bookings?page=1&limit=10' \
  --header 'Authorization: Bearer YOUR_USER_TOKEN'
```

Frontend needs the internal booking id:

- `data[i]._id`

This internal `_id` is what frontend will use in the next APIs.

## 2. Consultation Report Flow

Use this for doctor/consultation bookings.

### Step 1. Get report details

API:

- `GET /api/v1/external-bookings/bookings/:id/report`

Example:

```bash
curl --location 'https://api.myewacare.com/api/v1/external-bookings/bookings/BOOKING_DB_ID/report' \
  --header 'Authorization: Bearer YOUR_USER_TOKEN'
```

What frontend gets from this API:

- booking summary
- raw LabStack details payload
- `documents` array
- `notes` object when available

Frontend should read:

- `data.documents`

Each item may contain fields like:

- `documentId`
- `documentName`
- other provider fields

### Step 2. Download a consultation document

Once frontend gets a `documentId` from `data.documents`, call:

- `GET /api/v1/external-bookings/bookings/:id/report/document?documentId=...`

Example:

```bash
curl --location 'https://api.myewacare.com/api/v1/external-bookings/bookings/BOOKING_DB_ID/report/document?documentId=DOC123' \
  --header 'Authorization: Bearer YOUR_USER_TOKEN'
```

Expected frontend behavior:

- if backend returns a direct file URL in `data.documentUrl`, open it or download it
- otherwise render whatever LabStack payload is returned and map fields accordingly

## 3. Diagnostics Report Flow

Use this for tests/packages bookings.

Important:

- diagnostics report PDF download does not use consultation `documentId`
- diagnostics report PDF uses `reportId`
- the provider API behind this is `GET /v1.3/order/getReport`

### Step 1. Get diagnostics report metadata

API:

- `GET /api/v1/external-bookings/diagnostics/bookings/:id/report`

Example:

```bash
curl --location 'https://api.myewacare.com/api/v1/external-bookings/diagnostics/bookings/BOOKING_DB_ID/report' \
  --header 'Authorization: Bearer YOUR_USER_TOKEN'
```

What frontend gets from this API:

- booking summary
- raw details payload
- extracted `documents`
- extracted `notes` when available

Frontend should inspect:

- `data.details`
- `data.documents`

For diagnostics, frontend must look for report identifiers from:

- webhook-driven report metadata stored in the provider payload
- any `reports` array or similar field inside `data.details`

The key required for PDF download is:

- `reportId`

### Step 2. Download diagnostics report PDF

Once frontend has `reportId`, call:

- `GET /api/v1/external-bookings/diagnostics/bookings/:id/report/document?reportId=...`

Example:

```bash
curl --location 'https://api.myewacare.com/api/v1/external-bookings/diagnostics/bookings/BOOKING_DB_ID/report/document?reportId=REP456' \
  --header 'Authorization: Bearer YOUR_USER_TOKEN'
```

Expected frontend behavior:

- if backend returns a provider file URL, open/download it
- if backend returns raw PDF metadata, use that response structure directly

## 4. Recommended Frontend Decision Logic

If booking is consultation:

1. Call `GET /bookings/:id/report`
2. Read `data.documents`
3. Pick a `documentId`
4. Call `GET /bookings/:id/report/document?documentId=...`

If booking is diagnostics:

1. Call `GET /diagnostics/bookings/:id/report`
2. Find `reportId` in report metadata
3. Call `GET /diagnostics/bookings/:id/report/document?reportId=...`

## 5. Important Difference

Consultation flow:

- report file key is `documentId`
- backend calls LabStack appointment document API

Diagnostics flow:

- report file key is `reportId`
- backend calls LabStack order report API

Frontend must not use `documentId` for diagnostics PDF download.

## 6. Minimum Fields Frontend Should Store Per Booking Row

Frontend should keep:

- `_id`
- `providerType`
- `appointmentType`
- `status`
- `externalBookingId`

This is enough to decide which report flow to call.

## 7. Suggested UI Behavior

For consultation bookings:

- show a "Prescription / Documents" button
- open report details first
- show available documents

For diagnostics bookings:

- show a "Reports" button
- open report details first
- show available reports
- download using `reportId`

## 8. Known Limitation

Diagnostics report metadata depends on what LabStack returns in details or webhook payloads.

So frontend should:

- call the report details endpoint first
- not assume `reportId` is already present in the booking list API
