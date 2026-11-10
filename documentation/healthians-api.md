# Healthians API Flow (Frontend -> EWA Backend)

This document describes the **end-to-end frontend flow** to create and manage Healthians bookings using EWA backend APIs.

## Base Details

- Base route: `/api/v1/external-bookings`
- Auth: required (same app auth token used for existing external bookings APIs)
- Integration selector: always pass `integration: "healthians"` in request body/query
- Date format:
  - `bookingDate`: `YYYYMMDD`
  - slot time: display value (for example `9:30 AM`) or `HH:mm` depending on selected slot object

---

## 1) Consultation Booking Flow (Doctor)

### Step 1: Fetch specialists

`GET /api/v1/external-bookings/specialists`

Query params:
- `integration=healthians`
- `providerType` (required)
- `appointmentType` (required)
- `speciality` (optional, recommended)
- `pincode`, `latitude`, `longitude` (optional)

Use response `data[].id` as `externalProviderId`.

### Step 2: Fetch slots for selected specialist

`GET /api/v1/external-bookings/slots`

Query params:
- `integration=healthians`
- `appointmentType` (required)
- `externalProviderId` (required)
- `bookingDate` (required, `YYYYMMDD`)

Use a slot's display/start time as `selectedSlotTime`.

### Step 3: Create consultation booking

`POST /api/v1/external-bookings/bookings`

Body (minimum required by backend validation + flow):
- `integration: "healthians"`
- `providerType`
- `appointmentType`
- `externalProviderId`
- `bookingDate` (`YYYYMMDD`)
- `selectedSlotTime`
- `patientName`

Recommended fields:
- `patientPhone`, `patientEmail`, `patientGender`, `patientDateOfBirth`, `patientAge`
- `primaryConcern`, `address`, `pincode`, `city`, `state`
- `couponCode`, `useWalletBalance`

### Step 4: Handle payment response

Create booking response contains:
- `paymentRequired: false` -> booking already completed, done.
- `paymentRequired: true` -> complete Razorpay flow using `data.payment`.

### Step 5: Retry payment if pending

After successful Razorpay callback/verification, if booking still pending payment:

`POST /api/v1/external-bookings/bookings/:id/retry-payment`

Body (optional):
- `useWalletBalance`
- `couponCode`

### Step 6: Get booking/report details

- List bookings: `GET /api/v1/external-bookings/bookings?integration=healthians`
- Report metadata: `GET /api/v1/external-bookings/bookings/:id/report`
- Report document: `GET /api/v1/external-bookings/bookings/:id/report/document?documentId=<id>`

### Step 7: Cancel or reschedule consultation

- Cancel: `POST /api/v1/external-bookings/bookings/:id/cancel`
  - body: `cancellationReason` (optional)
- Reschedule: `POST /api/v1/external-bookings/bookings/:id/reschedule`
  - body: `bookingDate`, `selectedSlotTime`

---

## 2) Diagnostics Booking Flow

### Step 1: Fetch products (packages/tests) and labs/serviceability

Use as needed for your current UX:

- `GET /api/v1/external-bookings/packages?integration=healthians`
- `GET /api/v1/external-bookings/tests?integration=healthians`
- `GET /api/v1/external-bookings/serviceability?integration=healthians&pincode=<...>&packageIds=<...>&testIds=<...>`
- `GET /api/v1/external-bookings/labs?integration=healthians&pincode=<...>`

### Step 2: Fetch diagnostics slots

`GET /api/v1/external-bookings/diagnostics/slots`

Query params:
- `integration=healthians`
- `bookingDate` (`YYYYMMDD`)
- `pincode` and/or `latitude`,`longitude` (as per UI flow)
- `packageIds` and/or `testIds`
- optional `labId`

### Step 3: Create diagnostics booking

`POST /api/v1/external-bookings/diagnostics/bookings`

Body (minimum):
- `integration: "healthians"`
- `orderType`
- `bookingDate` (`YYYYMMDD`)
- `bookingTime`
- `patientName`
- at least one of `packageIds` or `testIds`

Recommended:
- `patientPhone`, `patientEmail`, `patientGender`, `patientAge`
- `address`, `addressLine`, `city`, `state`, `pincode`, `latitude`, `longitude`
- `labId`, `notes`, `altContact`
- `couponCode`, `useWalletBalance`

### Step 4: Handle payment response

Same as consultation:
- `paymentRequired: false` -> done
- `paymentRequired: true` -> run Razorpay with response payment payload

### Step 5: Retry payment if needed

`POST /api/v1/external-bookings/diagnostics/bookings/:id/retry-payment`

### Step 6: Diagnostics report/status

- List: `GET /api/v1/external-bookings/bookings?integration=healthians&providerType=DIAGNOSTICS`
- Metadata: `GET /api/v1/external-bookings/diagnostics/bookings/:id/report`
- Report doc: `GET /api/v1/external-bookings/diagnostics/bookings/:id/report/document?reportId=<id>`

### Step 7: Cancel or reschedule diagnostics

- Cancel: `POST /api/v1/external-bookings/diagnostics/bookings/:id/cancel`
- Reschedule: `POST /api/v1/external-bookings/diagnostics/bookings/:id/reschedule`
  - body: `bookingDate`, `bookingTime`

---

## Common Frontend Rules

- Keep existing frontend contract unchanged; only include `integration: "healthians"` when calling external booking APIs.
- If your app relies on default integration and does not pass `integration`, behavior depends on backend env:
  - `EXTERNAL_BOOKING_DEFAULT_INTEGRATION=labstack` or `healthians`.
- For payment-required bookings, always:
  1. create booking
  2. complete payment
  3. call retry-payment if booking is still pending

---

## Minimal Consultation Payload Example

```json
{
  "integration": "healthians",
  "providerType": "doctor",
  "appointmentType": "ONLINE",
  "externalProviderId": "nWaxjYygPRjaX44-392k0A",
  "bookingDate": "20260430",
  "selectedSlotTime": "9:30 AM",
  "patientName": "John Doe",
  "patientPhone": "9876543210",
  "patientEmail": "john@example.com"
}
```

## Minimal Diagnostics Payload Example

```json
{
  "integration": "healthians",
  "orderType": "HOME_COLLECTION",
  "bookingDate": "20260430",
  "bookingTime": "09:30",
  "patientName": "John Doe",
  "packageIds": ["package_119"]
}
```
