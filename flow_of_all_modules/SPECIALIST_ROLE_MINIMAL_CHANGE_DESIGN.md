# Specialist Role Minimal-Change Design

## Purpose

This document proposes a minimum-change design for adding a new `specialist` user role to the existing backend.

The goal is to reuse as much of the current system as possible while enabling specialists to:

- login with the same OTP-based flow style used by `user` and `admin`
- manage their own slots
- view and filter their own appointments
- update appointment status
- view patient history
- add consultation notes, medicines, and suggested tests
- upload prescription files and report files
- optionally generate a fixed-format prescription PDF and store its URL
- view basic dashboard stats
- support one-time follow-up logic already added to booking

This document is intentionally design-first so we can review and minimize unnecessary code changes before implementation.

## Design Goal

Use the existing system structure wherever possible.

Preferred direction:

- keep existing `bookings` collection as the appointment source of truth
- keep existing `slots` collection for availability management
- keep existing `specialists` collection as the specialist profile source
- extend auth to allow `specialist` login
- add specialist-only APIs rather than redesigning all existing user/admin flows
- keep doctor-written clinical data inside booking rather than creating a completely new consultation collection

This is the minimum-change path.

## Existing Reusable Parts

The current backend already has:

- OTP auth flow for `user` and `admin`
- specialist module and specialist collection
- slot module
- bookings module
- booking status updates
- file upload support
- reminder and queue system
- payment flow
- Google Meet flow
- one-time follow-up logic under booking
- separated booking file fields:
  - `documents` for user-uploaded support files
  - `prescription.fileUrls`
  - `report.fileUrls`

Because of this, we do not need to create a brand-new appointment system.

## Recommended Overall Strategy

### Keep booking as the central appointment record

Every specialist appointment should continue to be represented by a booking.

Reason:

- less migration
- less duplication
- existing payment flow already attaches to booking
- existing reminders already attach to booking
- existing Google Meet already attaches to booking
- existing follow-up logic already attaches to booking

### Add specialist as a new auth role

Instead of redesigning identity entirely, extend current auth flow to include `specialist`.

### Add specialist-only actions on top of current booking model

Instead of building a separate consultation entity, add specialist actions like:

- view own bookings
- update own booking status
- add consultation details
- upload prescription/report
- view patient history

### Keep doctor consultation data nested inside booking

This is the cleanest minimum-change design because doctor consultation details are appointment-specific.

## Specialist Role Design

## Authentication Model

### Recommended choice

Use the current OTP auth style and add `specialist` as another allowed `userType`.

That means auth should support:

- `user`
- `admin`
- `specialist`

### Why this is the smallest change

Because current auth already does:

- send OTP
- verify OTP
- generate JWT with `userType`

So the smallest extension is:

- allow `specialist` in auth validation
- lookup specialist record from `specialists` collection during send/verify
- issue JWT with `userType = specialist`

### Suggested access behavior

A specialist token should only be allowed to access specialist-owned resources.

Examples:

- only own slots
- only own appointments
- only patients connected through own bookings

## Booking Design for Specialist Work

### Keep booking as the appointment entity

Booking already contains:

- specialist id
- slot
- date/time
- payment state
- follow-up state
- prescription/report files
- Google Meet state

This should remain the central appointment record.

### Add one new nested object for doctor-entered consultation data

Recommended field on booking:

```ts
doctorConsultation?: {
  patientComplaints?: string;
  diagnosis?: string;
  doctorNotes?: string;
  advice?: string;
  medicines?: Array<{
    name: string;
    dosage?: string;
    frequency?: string;
    duration?: string;
    instructions?: string;
  }>;
  suggestedTests?: Array<{
    name: string;
    notes?: string;
  }>;
  prescriptionPdfUrl?: string;
  updatedBySpecialistId?: string;
  updatedAt?: string;
}
```

### Why keep this inside booking

Because these are appointment-level details, not user-level master profile details.

Examples:

- what patient said during this consultation
- what doctor prescribed during this appointment
- what tests were suggested on that date
- what advice was given on that visit

This belongs to booking.

## File Design

### Current file separation is already good

Current direction should stay:

- `documents`: user-uploaded supporting files
- `prescription.fileUrls`: doctor prescription files
- `report.fileUrls`: lab report files or doctor report files

### Add generated prescription PDF URL

Recommended addition:

```ts
prescription?: {
  fileUrls?: string[];
  generatedPdfUrl?: string;
}
```

This gives two modes:

- specialist uploads prescription files manually
- system generates a standard PDF and stores its URL

### Why this is better than using only one file field

Because you want to separate:

- what patient uploaded
- what doctor uploaded/generated
- what lab uploaded/generated

This separation is already aligned with the current booking model changes.

## Follow-Up Design

Follow-up should remain exactly as currently designed.

Rules:

- one paid completed consultation gives one free follow-up
- follow-up booking is a new booking
- follow-up booking itself cannot generate another follow-up
- specialist may control whether appointment is completed, which triggers follow-up eligibility

### Specialist control over follow-up

You mentioned:

- specialist can mark follow-up true or false

There are two ways to interpret this.

### Option A: specialist decides whether patient gets follow-up benefit

If you want this, add one field to booking, for example:

```ts
followUp?: {
  isFollowUp?: boolean;
  parentConsultationId?: string;
  eligibilityExpiresAt?: string;
  benefitUsed?: boolean;
  completedAt?: string;
  allowedBySpecialist?: boolean;
}
```

Then follow-up benefit is activated only if:

- consultation is completed
- paid
- non-follow-up
- `allowedBySpecialist = true`

This is a good business control if you do not want every completed consultation to automatically allow follow-up.

### Option B: automatic follow-up for all eligible consultations

This is simpler and already closer to current code.

For minimum changes, Option B is easier.

For business flexibility, Option A is better.

My recommendation:

- implement `allowedBySpecialist?: boolean` inside `followUp`
- default to `false`
- specialist explicitly enables it when completing consultation

That gives you better operational control.

## Slot Management Design

### Reuse existing slots module

Do not create a second slot system.

Current slot entity already works.

Specialist slot APIs should be wrappers around current slot service with ownership checks.

### Specialist slot permissions

A specialist should only be able to:

- create slots for self
- update own slots
- delete own slots
- list own slots

### Minimum-change approach

Reuse `slots` collection and add specialist-side route layer.

No schema redesign is needed unless current slot ownership mapping is unclear.

## Appointment View Design

### Specialist should see only own appointments

Add specialist-facing appointment list endpoints that internally filter by:

- `specialistId = logged-in specialist`

### Common filters needed

Recommended filters:

- `date`
- `dateFrom`
- `dateTo`
- `today=true`
- `month=YYYYMM`
- `status`
- `followUp.isFollowUp`
- patient search by name/phone if available via joined/linked fetch

### Suggested grouped views

- today's appointments
- day-wise appointments
- month-wise appointments
- all appointments

This does not need separate storage, only filtered queries.

## Appointment Status Update Design

Specialist should be able to update appointment status.

Recommended allowed actions:

- mark `completed`
- mark `cancelled`
- optionally mark `confirmed` if business needs it

### Important behavior when marking completed

When specialist marks a consultation completed:

- reminder jobs should stop
- Meet should be closed/cancelled if that is current behavior
- follow-up benefit activation should run if eligible
- optionally require specialist consultation notes before completion

### Recommended business rule

Before completing consultation, specialist should be able to save:

- patient complaints
- diagnosis
- medicines
- suggested tests
- advice

Then mark appointment completed.

## Patient History Design

### Minimum-change approach

Do not create a separate patient-history table initially.

Build patient history from existing bookings.

Fetch all previous bookings for the same:

- `userId`
- or dependent relationship if relevant

### Structured patient history response

Return:

- basic patient info
- previous bookings with dates/status
- previous doctorConsultation data
- previous prescription files
- previous report files
- previous follow-up links

### Why this is enough initially

It avoids extra schema complexity and still gives specialists what they need.

## Search and Filter Patients

### Minimum-change approach

Do not create a separate patient directory first.

Use specialist appointment history to derive visible patients.

Specialist can search patients across own bookings by:

- patient name
- phone
- email
- booking date range

If later needed, create a dedicated aggregation endpoint.

## Dashboard / Stats Design

### Suggested minimum stats

Specialist dashboard can be derived from bookings.

Recommended first version:

- today's appointments count
- today's completed count
- today's cancelled count
- monthly appointments count
- total completed appointments
- total unique patients treated
- follow-up appointments count

### Minimum-change approach

Use aggregation on bookings collection.

No separate dashboard storage needed.

## Suggested API Surface

This is the minimum-change API shape I recommend.

## Auth APIs

```http
POST /api/v1/auth/specialist/send
POST /api/v1/auth/specialist/verify
```

## Specialist Slot APIs

```http
GET    /api/v1/specialist/slots
POST   /api/v1/specialist/slots
PUT    /api/v1/specialist/slots/:id
DELETE /api/v1/specialist/slots/:id
```

## Specialist Appointment APIs

```http
GET   /api/v1/specialist/appointments
GET   /api/v1/specialist/appointments/:id
PATCH /api/v1/specialist/appointments/:id/status
PATCH /api/v1/specialist/appointments/:id/consultation
PATCH /api/v1/specialist/appointments/:id/prescription
PATCH /api/v1/specialist/appointments/:id/report
POST  /api/v1/bookings/:id/reschedule
```

## Specialist Patient APIs

```http
GET /api/v1/specialist/patients
GET /api/v1/specialist/patients/:userId/history
```

## Specialist Dashboard API

```http
GET /api/v1/specialist/dashboard
```

## Prescription and PDF Design

### Recommended flow

Specialist completes consultation form:

- complaints
- medicines and dosage
- suggested tests
- advice
- optional uploaded prescription files

If specialist uploads file manually:

- store in `prescription.fileUrls`

If system-generated prescription PDF is needed:

- generate standard layout PDF from `doctorConsultation`
- upload/store PDF
- save URL in `doctorConsultation.prescriptionPdfUrl`
- optionally also mirror into `prescription.generatedPdfUrl`

### Suggested best choice

Store generated prescription PDF URL at one place only.

I recommend:

```ts
doctorConsultation.prescriptionPdfUrl
```

Reason:

- it is derived from doctor consultation data
- it avoids mixing generated documents with manually uploaded files

## Minimum-Change Schema Recommendation

### Existing booking fields to keep as-is

- `documents`
- `prescription.fileUrls`
- `report.fileUrls`
- `followUp`
- `virtualMeeting`

### New booking field to add

```ts
doctorConsultation?: {
  patientComplaints?: string;
  diagnosis?: string;
  doctorNotes?: string;
  advice?: string;
  medicines?: Array<{
    name: string;
    dosage?: string;
    frequency?: string;
    duration?: string;
    instructions?: string;
  }>;
  suggestedTests?: Array<{
    name: string;
    notes?: string;
  }>;
  prescriptionPdfUrl?: string;
  updatedBySpecialistId?: string;
  updatedAt?: string;
}
```

### Optional follow-up enhancement

If specialist should decide whether follow-up is allowed:

```ts
followUp?: {
  isFollowUp?: boolean;
  parentConsultationId?: string;
  eligibilityExpiresAt?: string;
  benefitUsed?: boolean;
  completedAt?: string;
  allowedBySpecialist?: boolean;
}
```

## Recommended Rollout Order

To minimize change risk, implement in this order:

1. Add specialist auth role
2. Add specialist-only appointment list APIs
3. Add specialist-only slot management APIs
4. Add `doctorConsultation` nested schema in booking
5. Add specialist update APIs for consultation notes, medicines, tests, prescription/report files
6. Add specialist appointment status update flow
7. Add patient history API
8. Add dashboard API
9. Add optional prescription PDF generation
10. Add optional specialist-controlled follow-up permission if needed

## Things We Should Avoid Right Now

To keep changes minimal, avoid these for now:

- creating a separate consultations collection
- redesigning whole auth into a central identity system
- moving patient history into a new database model
- adding a separate dashboard storage table
- creating a second slot system
- creating a separate prescription module unless later needed

## Recommended Final Direction

For minimum changes, I recommend this exact plan:

- add `specialist` as a new auth role
- keep using `specialists` collection for specialist profile
- keep `bookings` as the appointment record
- add `doctorConsultation` nested object inside booking
- keep `prescription.fileUrls` and `report.fileUrls`
- optionally generate prescription PDF from doctor consultation data
- derive patient history and dashboard from bookings
- keep follow-up as already implemented in booking

## Questions To Finalize Before Coding

These are the few decisions we should lock first:

1. Should specialist login use existing `specialists` collection directly?
2. Should follow-up be automatic or specialist-controlled?
3. Should prescription PDF be generated automatically on every save or via a separate action?
4. Should specialist be allowed to cancel only pending/confirmed appointments, or also completed ones under exception rules?
5. Should patient history include only this specialist's appointments or all appointments across the platform?

## Suggested Next Step

After you review this document, the cleanest next move is:

1. finalize the 5 questions above
2. implement only phase 1:
   - specialist auth
   - specialist appointment list
   - specialist slot CRUD
3. then add doctor consultation fields in phase 2

That will keep the rollout controlled and low-risk.
