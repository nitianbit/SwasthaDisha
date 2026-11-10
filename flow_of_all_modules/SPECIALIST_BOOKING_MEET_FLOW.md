# Specialist Booking, Payment, Google Meet, Cancel, Reschedule, and Follow-Up Flow

## Overview

This document explains the end-to-end flow for internal specialist bookings in the backend, including:

- booking creation
- payment handling
- Google Meet link generation
- cancellation
- rescheduling
- one-time free follow-up consultation
- booking response shape
- required Google setup
- code changes made in the backend

This flow applies to internal specialist bookings created through:

- `POST /api/v1/bookings/specialist`
- `POST /api/v1/bookings` with `bookingType = consultation`
- `POST /api/v1/bookings` with `bookingType = second-opinion`

This document does not apply to external Labstack bookings under `/api/v1/external-bookings/*`.

## Applicable Booking Types

Google Meet integration is currently applied only for:

- `consultation`
- `second-opinion`

And only when `consultationMode` is one of:

- `call`
- `video`

`chat` and `in-person` remain valid consultation modes in the schema, but they do not trigger Google Meet link creation right now

One-time free follow-up is currently applied only for:

- `consultation`

It is not applied to:

- `package`
- `surgery`
- `second-opinion`

## High-Level Flow

1. User creates a specialist booking.
2. Backend validates specialist, slot, and request payload.
3. Backend creates the booking.
4. If payment is needed:
   - booking remains `pending`
   - payment order details are returned
5. After successful payment verification:
   - booking becomes `confirmed`
   - payment becomes `paid`
   - reminder jobs are scheduled
   - Google Meet event creation is attempted only for `call` and `video` consultation modes
6. If booking is free or fully covered by wallet:
   - booking is directly `confirmed`
   - Google Meet event creation is attempted immediately only for `call` and `video` consultation modes
7. If booking is rescheduled:
   - slot counts are updated
   - reminder jobs are updated
   - Google Calendar event is updated
8. If booking is cancelled:
   - booking is marked cancelled
   - slot capacity is released
   - reminder jobs are cleared
   - Google Calendar event is deleted
9. If a paid consultation is completed:
   - backend activates one free follow-up window for 14 days
10. If user books follow-up within the valid window:
   - new consultation booking is created as free
   - parent consultation is marked as having consumed its follow-up benefit

## API Summary

### Create specialist booking

```http
POST /api/v1/bookings/specialist
Authorization: Bearer <token>
Content-Type: application/json
```

### Create specialist booking via unified endpoint

```http
POST /api/v1/bookings
Authorization: Bearer <token>
Content-Type: application/json
```

Use:

```json
{
  "bookingType": "consultation"
}
```

or

```json
{
  "bookingType": "second-opinion"
}
```

### Verify payment

```http
POST /api/v1/payments/verify
Authorization: Bearer <token>
Content-Type: application/json
```

### Cancel booking

```http
POST /api/v1/bookings/:id/cancel
Authorization: Bearer <token>
Content-Type: application/json
```

### Reschedule booking

```http
POST /api/v1/bookings/:id/reschedule
Authorization: Bearer <token>
Content-Type: application/json
```

### Fetch booking details

```http
GET /api/v1/bookings/:id
Authorization: Bearer <token>
```

## Current Booking Data Shape

Important booking fields now include:

- `bookingType`
- `userId`
- `dependentId`
- `corporateId`
- `specialistId`
- `slotId`
- `bookingDate`
- `bookingTime`
- `consultationMode`
- `serviceMode`
- `documents`
- `prescription`
- `report`
- `followUp`
- `price`
- `paymentStatus`
- `status`
- `virtualMeeting`

### Meaning of file-related fields

- `documents`: user-uploaded supporting files
- `prescription.fileUrls`: doctor prescription file URLs
- `report.fileUrls`: lab report or doctor report file URLs

### Follow-up object shape

```json
{
  "followUp": {
    "isFollowUp": false,
    "parentConsultationId": "PARENT_BOOKING_ID",
    "eligibilityExpiresAt": "20260416",
    "benefitUsed": false,
    "completedAt": "20260402"
  }
}
```

Meaning:

- `isFollowUp`: whether this booking itself is a follow-up booking
- `parentConsultationId`: original completed consultation that granted the benefit
- `eligibilityExpiresAt`: last day user can book the free follow-up
- `benefitUsed`: whether the original consultation has already consumed its one free follow-up
- `completedAt`: when the original eligible consultation was completed

## Create Specialist Booking Flow

### Input validation

The specialist booking API validates:

- `specialistId`
- `primaryConcern`
- `consultationMode`
- `slotId`
- `bookingDate`
- `bookingTime`
- optional contact and notes fields
- optional `followUp` object

### Backend validation steps

When a specialist booking request comes in, the backend:

1. fetches the specialist
2. confirms the specialist is active
3. fetches the slot
4. ensures slot is active and available
5. ensures booking date is not in the past
6. calculates price
7. applies coupon if provided
8. applies wallet deduction if requested
9. if `followUp.isFollowUp = true`, validates parent consultation eligibility before price is finalized

### Booking creation outcomes

There are three main outcomes.

#### Outcome 1: payment required

If there is still payable amount after coupon and wallet deduction:

- booking is created with:
  - `status = pending`
  - `paymentStatus = pending`
- payment order metadata is returned
- Google Meet is not created yet

#### Outcome 2: no further payment required

If payable amount becomes zero:

- booking is created with:
  - `status = confirmed`
  - `paymentStatus = paid`
- reminder jobs are scheduled
- Google Meet event creation is attempted immediately

#### Outcome 3: valid follow-up booking

If the request is a valid follow-up booking:

- backend forces consultation price to `0`
- backend skips paid consultation pricing behavior
- booking is created with:
  - `status = confirmed`
  - `paymentStatus = paid`
  - `followUp.isFollowUp = true`
  - `followUp.parentConsultationId = original consultation id`
- parent consultation is marked with `followUp.benefitUsed = true`
- reminder jobs are scheduled
- Google Meet event creation is attempted immediately

## Example Standard Specialist Booking Request

```json
{
  "specialistId": "SPECIALIST_ID",
  "primaryConcern": "Fever and weakness",
  "consultationMode": "call",
  "slotId": "SLOT_ID",
  "bookingDate": "20260410",
  "bookingTime": "11:30 AM",
  "contactNo": "9876543210",
  "alternateContactNo": "9876543211",
  "documents": [
    {
      "type": "report",
      "url": "/api/static/bookings/report.pdf",
      "fileName": "report.pdf"
    }
  ],
  "couponCode": "SAVE10",
  "useWalletBalance": true,
  "notes": "Please call on primary number"
}
```

## Example Follow-Up Booking Request

Use the same specialist booking API with the same schema, plus `followUp`:

```json
{
  "specialistId": "SPECIALIST_ID",
  "primaryConcern": "Need follow-up review",
  "consultationMode": "call",
  "slotId": "NEW_SLOT_ID",
  "bookingDate": "20260410",
  "bookingTime": "11:00 AM",
  "documents": [],
  "prescription": {
    "fileUrls": [
      "/api/static/bookings/prescription-1.pdf"
    ]
  },
  "report": {
    "fileUrls": [
      "/api/static/bookings/report-1.pdf"
    ]
  },
  "notes": "Follow-up consultation",
  "followUp": {
    "isFollowUp": true,
    "parentConsultationId": "ORIGINAL_CONSULTATION_BOOKING_ID"
  }
}
```

## Payment Flow

### When payment is required

If the specialist booking is not free and wallet/coupon do not fully cover the amount:

1. booking is stored with `pending` payment state
2. backend returns Razorpay order details
3. client completes payment
4. client calls payment verification API

### Payment verification

After successful verification:

- payment record becomes `paid`
- booking becomes:
  - `status = confirmed`
  - `paymentStatus = paid`
- reminder jobs are scheduled
- Google Meet event creation is attempted

### Important rule

Google Meet generation for specialist bookings happens only when:

- booking type is `consultation` or `second-opinion`
- `consultationMode` is `call` or `video`
- booking status is `confirmed`
- payment status is `paid`

## Google Meet Generation Flow

### Trigger points

Google Meet creation or update is attempted in these cases:

1. specialist booking becomes immediately confirmed during create flow for `call` or `video` mode
2. payment verification confirms a specialist booking in `call` or `video` mode
3. confirmed specialist booking is rescheduled and remains in `call` or `video` mode
4. valid follow-up booking is created and immediately confirmed in `call` or `video` mode

### Backend checks before creating Meet

Before creating the Google Calendar event, the backend checks:

- Google Calendar config is present
- patient email exists
- specialist email exists
- slot exists

### Failure behavior

If Google Meet setup fails:

- booking still succeeds
- booking remains valid
- meeting metadata is stored as:
  - `virtualMeeting.status = failed`
  - `virtualMeeting.error = <reason>`

## Cancel Booking Flow

### API

```http
POST /api/v1/bookings/:id/cancel
Authorization: Bearer <token>
Content-Type: application/json
```

### Example request

```json
{
  "cancellationReason": "Patient requested cancellation"
}
```

### Backend behavior

When cancel is called:

1. backend verifies requester can access booking
2. if already cancelled, current booking is returned
3. booking is updated to:
   - `status = cancelled`
   - `cancellationReason = provided reason or default reason`
   - `cancelledAt = current date in YYYYMMDD`
4. reminder jobs are cleared
5. slot booking count is decremented if applicable
6. if a Google Calendar event exists, backend attempts to delete it
7. booking meeting metadata is updated to:
   - `virtualMeeting.status = cancelled`

## Reschedule Booking Flow

### API

```http
POST /api/v1/bookings/:id/reschedule
Authorization: Bearer <token>
Content-Type: application/json
```

### Example request

```json
{
  "slotId": "NEW_SLOT_ID",
  "bookingDate": "20260412",
  "bookingTime": "04:00 PM",
  "consultationMode": "call",
  "notes": "Moved to a later slot"
}
```

### Backend behavior

When reschedule is called:

1. backend verifies requester can access booking
2. backend rejects cancelled bookings
3. backend rejects completed bookings
4. backend fetches new slot
5. backend validates new slot and date
6. if slot changed:
   - increments new slot booking count
   - decrements old slot booking count
7. booking is updated with the new values
8. if booking is already confirmed:
   - reminder jobs are rescheduled
   - Google Calendar event is updated

## Follow-Up Consultation Flow

### Business rule

One paid completed consultation gives exactly one free follow-up consultation.

Rules:

- only `consultation` qualifies
- parent consultation must be `completed`
- parent consultation must be `paid`
- parent consultation must not itself be a follow-up
- follow-up must be booked within 14 days of parent completion
- follow-up must be with the same specialist
- one parent consultation can give only one free follow-up
- follow-up bookings do not generate another follow-up cycle

### When follow-up benefit becomes active

When a booking transitions to `completed`, backend checks if it is eligible to generate follow-up benefit.

A booking is eligible only when:

- `bookingType = consultation`
- `paymentStatus = paid`
- `followUp.isFollowUp != true`

If eligible, backend sets on the completed booking:

- `followUp.completedAt = today`
- `followUp.eligibilityExpiresAt = completedAt + 14 days`
- `followUp.benefitUsed = false`
- `followUp.isFollowUp = false`

### How follow-up is booked

Use the normal consultation booking API and pass:

```json
"followUp": {
  "isFollowUp": true,
  "parentConsultationId": "ORIGINAL_CONSULTATION_BOOKING_ID"
}
```

### Backend validation for follow-up

When `followUp.isFollowUp = true`, backend validates:

1. `parentConsultationId` is present
2. parent booking exists
3. parent belongs to the same user
4. parent booking type is `consultation`
5. parent booking is `completed`
6. parent booking is `paid`
7. parent booking is not itself a follow-up
8. parent booking's follow-up benefit has not been used
9. requested booking date is within the follow-up eligibility window
10. requested specialist matches the parent consultation specialist

### What backend does for a valid follow-up

If follow-up is valid, backend:

1. forces price to `0`
2. treats payment as already paid
3. creates the booking as confirmed
4. links new booking to parent consultation with:
   - `followUp.isFollowUp = true`
   - `followUp.parentConsultationId = parent booking id`
5. updates parent consultation:
   - `followUp.benefitUsed = true`
6. schedules reminders
7. creates Google Meet link if the consultation mode is `call` or `video`

### Why follow-up is implemented this way

This avoids using reschedule for follow-up, because follow-up is a new consultation instance with:

- its own slot
- its own history
- its own reminders
- its own Meet link
- its own uploaded files
- traceability back to the original consultation

## Slot Count Behavior

Slot counts are updated in these cases:

- on create: slot booking count is incremented
- on cancel: slot booking count is decremented
- on reschedule:
  - new slot incremented
  - old slot decremented
- on delete: slot booking count is decremented
- on follow-up create: new slot booking count is incremented like a normal booking

## Example Booking Response with Meeting and Follow-Up Data

```json
{
  "success": true,
  "data": {
    "booking": {
      "_id": "BOOKING_ID",
      "bookingType": "consultation",
      "userId": "USER_ID",
      "specialistId": "SPECIALIST_ID",
      "slotId": "SLOT_ID",
      "bookingDate": "20260410",
      "bookingTime": "11:30 AM",
      "status": "confirmed",
      "paymentStatus": "paid",
      "prescription": {
        "fileUrls": [
          "/api/static/bookings/prescription-1.pdf"
        ]
      },
      "report": {
        "fileUrls": [
          "/api/static/bookings/report-1.pdf"
        ]
      },
      "followUp": {
        "isFollowUp": true,
        "parentConsultationId": "PARENT_BOOKING_ID"
      },
      "virtualMeeting": {
        "provider": "google_meet",
        "status": "active",
        "joinUrl": "https://meet.google.com/abc-defg-hij",
        "meetingCode": "abc-defg-hij",
        "calendarEventId": "google-calendar-event-id",
        "startDateTime": "2026-04-10T11:30:00",
        "endDateTime": "2026-04-10T12:00:00"
      }
    }
  }
}
```

## Google Configuration Required

To enable Google Meet generation, set these environment variables:

```env
GOOGLE_CALENDAR_ID=primary
GOOGLE_MEET_TIMEZONE=Asia/Kolkata
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@project-id.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_SERVICE_ACCOUNT_IMPERSONATED_USER=
GOOGLE_SERVICE_ACCOUNT_FILE=
```

### Functional requirements for Meet to work

These fields must exist:

- patient user email
- specialist email
- valid Google Calendar credentials
- accessible target calendar

## Changes Made in Code

### Booking schema and validation changes

Added or updated:

- `booking.prescription.fileUrls`
- `booking.report.fileUrls`
- `booking.followUp`

Files changed:

- `src1/modules/bookings/types/index.ts`
- `src1/modules/bookings/model/index.ts`
- `src1/modules/bookings/validation/index.ts`

### Booking service changes

Added follow-up business logic in:

- `src1/modules/bookings/services/index.ts`

Implemented:

- default follow-up state for new bookings
- one-time 14-day follow-up benefit activation on completion
- parent consultation validation for follow-up create
- free follow-up booking creation using same consultation booking flow
- parent consultation benefit consumption tracking

### Shared date utility changes

Added helper in:

- `src1/modules/common/utils/dateUtils.ts`

Used for:

- calculating `eligibilityExpiresAt = completedAt + 14 days`

### Previously added booking flow changes still active

Also already implemented in the booking flow:

- Google Meet creation and update
- booking cancel API
- booking reschedule API
- meeting cancellation on booking cancel and completion

## Files Involved in This Flow

- [src1/modules/bookings/routes/index.ts](/home/ocnsw/Documents/shubham/ewa_backend/src1/modules/bookings/routes/index.ts)
- [src1/modules/bookings/controller/index.ts](/home/ocnsw/Documents/shubham/ewa_backend/src1/modules/bookings/controller/index.ts)
- [src1/modules/bookings/services/index.ts](/home/ocnsw/Documents/shubham/ewa_backend/src1/modules/bookings/services/index.ts)
- [src1/modules/bookings/model/index.ts](/home/ocnsw/Documents/shubham/ewa_backend/src1/modules/bookings/model/index.ts)
- [src1/modules/bookings/types/index.ts](/home/ocnsw/Documents/shubham/ewa_backend/src1/modules/bookings/types/index.ts)
- [src1/modules/bookings/validation/index.ts](/home/ocnsw/Documents/shubham/ewa_backend/src1/modules/bookings/validation/index.ts)
- [src1/modules/bookings/services/MeetingService.ts](/home/ocnsw/Documents/shubham/ewa_backend/src1/modules/bookings/services/MeetingService.ts)
- [src1/modules/payment/services/index.ts](/home/ocnsw/Documents/shubham/ewa_backend/src1/modules/payment/services/index.ts)
- [src1/modules/common/utils/dateUtils.ts](/home/ocnsw/Documents/shubham/ewa_backend/src1/modules/common/utils/dateUtils.ts)
- [src1/config/config.ts](/home/ocnsw/Documents/shubham/ewa_backend/src1/config/config.ts)
- [.env.example](/home/ocnsw/Documents/shubham/ewa_backend/.env.example)

## Suggested Test Sequence

1. create a normal paid consultation
2. complete payment verification if needed
3. mark booking as completed
4. fetch booking and confirm `followUp.eligibilityExpiresAt` is set
5. create a follow-up consultation using same specialist and parent consultation id
6. confirm follow-up booking is free and confirmed
7. confirm parent consultation now has `followUp.benefitUsed = true`
8. try booking another follow-up from same parent and confirm backend rejects it
9. reschedule the follow-up booking and confirm reminders and Meet are updated
10. cancel the follow-up booking and confirm slot and meeting are released
