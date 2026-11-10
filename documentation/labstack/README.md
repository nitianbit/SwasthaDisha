# LabStack Integration Notes

This document captures the current understanding of the LabStack integration based on:

- `LabStack Provider API V1.0.9.pdf`

It combines:

- the user journey discussed for diagnostics and teleconsult
- the APIs confirmed in the PDF
- the gaps that are still not covered by this document

## Purpose

This README is meant to help us:

- understand the end-to-end LabStack flow
- identify which APIs can already be integrated
- identify which additional documents or APIs are still needed

## High-Level Summary

The shared LabStack PDF is primarily a provider and appointment API document.

It clearly supports:

- provider discovery
- speciality discovery
- slot discovery
- appointment booking
- appointment tracking
- cancel and reschedule
- meeting link retrieval for online consults
- appointment status webhooks
- document download and upload

It does not clearly provide dedicated APIs for:

- lab test search
- package search
- package pricing
- diagnostics catalog
- payment collection
- phlebo-specific assignment lifecycle
- sample pickup lifecycle
- report JSON delivery for diagnostics

## API Key Requirement

The document states that the API requires an API key issued by the LabStack account manager.

## Confirmed API Groups

### Availability APIs

- `GET /v1.0/availability/getSpecialities`
- `GET /v1.0/availability/getProviders`
- `GET /v1.0/availability/getAppointmentSlots`

### Appointment APIs

- `POST /v1.0/appointment/bookAppointment`
- `GET /v1.0/appointment/getAuthenticatedMeetingLink`
- `GET /v1.0/appointment/getAppointments`
- `GET /v1.0/appointment/cancelAppointment`
- `GET /v1.0/appointment/rescheduleAppointment`
- `GET /v1.0/appointment/getAppointmentDetails`
- `GET /v1.0/appointment/getDocument`
- `GET /v1.0/appointment/testWebhook`
- `POST /v1.0/appointment/uploadDocument`

### Network APIs

- `GET /v1.0/network/getProviderDetails`

### Admin APIs

- `GET /v1.0/admin/getBalance`
- `GET /v1.0/admin/status`

## Confirmed Enums

### Appointment Types

- `ONLINE`
- `CENTER_VISIT`
- `HOME_VISIT`

### Appointment Statuses

- `PENDING`
- `CREATED`
- `CONFIRMED`
- `CANCELED`
- `RESCHEDULED`
- `COMPLETED`

### Common Provider Types Seen in the Doc

- `DOCTOR`
- `DENTIST`
- `NUTRIONIST`
- `HEALTH_COACH`
- `PSYCHOLOGIST`
- `MENTAL_HEALTH_COUNSELLOR`
- `PHYSIOTHERAPIST`
- `CHIROPRACTOR`
- `SPEECH_THERAPIST`
- `PHLEBOTOMIST`
- others listed in the appendix

Note:

- not every provider type supports direct provider ID selection
- the appendix indicates `PHLEBOTOMIST` does not support direct provider ID selection
- in such cases, group-based selection may be required

## Teleconsult Flow

This flow is well supported by the shared PDF.

### 1. Search doctor or specialization

Use:

- `GET /v1.0/availability/getSpecialities`

This returns specialities and sub-specialities that can be used for filtering.

### 2. Get providers and prioritize previously booked doctors

Use:

- `GET /v1.0/availability/getProviders`

Recommended request shape:

- `providerType=DOCTOR`
- `appointmentType=ONLINE`
- optional `speciality`
- optional `subSpeciality`
- optional `preferredGender`
- optional `userUniqueId`

Important note:

- the document says `userUniqueId` can be passed so providers are sorted based on the most recent appointments for that patient

This aligns with the requirement to show providers along with past booked doctors.

### 3. Choose provider and book appointment

Optional before booking:

- `GET /v1.0/network/getProviderDetails`
- `GET /v1.0/availability/getAppointmentSlots`

Then book using:

- `POST /v1.0/appointment/bookAppointment`

Important booking notes from the document:

- either `lsProviderId` or `lsGroupId` must be passed
- `appointmentType` should be `ONLINE`
- `meetingType` can be `VIDEO` or `AUDIO_ONLY`
- booking can happen even without checking slots first
- patient identity is tied to `uniqueId`
- if `uniqueId` is missing, LabStack derives it from `{mobile}-{email}`

### 4. Track appointment state

Use both:

- appointment status webhook callbacks
- `GET /v1.0/appointment/getAppointmentDetails`
- `GET /v1.0/appointment/getAppointments`

Important status note:

- the book appointment response may not mean final confirmation
- the document explicitly notes that `apiError: null` does not itself guarantee the appointment is finalized
- `PENDING` means it may still be awaiting provider confirmation

### 5. Notify before appointment time

This is a product/application responsibility.

The shared PDF does not provide a dedicated reminder API.

Recommended approach:

- store appointment time returned by booking or details APIs
- trigger your own reminder notifications before the appointment

### 6. Join video consult

Use:

- `GET /v1.0/appointment/getAuthenticatedMeetingLink`

Important details:

- valid only for online appointments
- available 10 minutes before start time
- available until 30 minutes after the designated appointment end time

The document also supports embedding the meeting in an iframe using:

- `headless=true`

### 7. Receive prescription

Use:

- `GET /v1.0/appointment/getAppointmentDetails`
- `GET /v1.0/appointment/getDocument`

The document shows prescription-oriented fields in appointment details, including:

- `chiefComplaints`
- `doctorNotes`
- `followUpAdvice`
- `medication`
- `labTests`

Documents can also be downloaded using `getDocument`.

## Diagnostics Flow

The diagnostics flow is only partially supported by this PDF.

### 1. Search test or package

Not found in this document.

There is no clearly defined API here for:

- test catalog search
- package catalog search
- package details
- package pricing

The only indirect reference is that some returned data structures mention lab tests with types like:

- `TEST`
- `PACKAGE`

But this is not a searchable catalog API.

### 2. Get providers by pincode or latitude/longitude

Use:

- `GET /v1.0/availability/getProviders`

For diagnostics-style service discovery, this can be used with:

- `appointmentType=HOME_VISIT`
- `appointmentType=CENTER_VISIT`

Location rules confirmed by the doc:

- for `HOME_VISIT` and `CENTER_VISIT`, location is required
- location can be passed using `pincode`
- or by `latitude` and `longitude`
- for `ONLINE`, location is optional

### 3. Choose home sample collection or centre visit

This maps to:

- `HOME_VISIT`
- `CENTER_VISIT`

### 4. Choose date and slot

Use:

- `GET /v1.0/availability/getAppointmentSlots`

This returns available appointment slots by date and location.

Note:

- the doc explicitly says appointments can also be placed without checking slots first

### 5. Place booking

Use:

- `POST /v1.0/appointment/bookAppointment`

For non-online appointments, address data is important.

The request body includes patient details plus address fields such as:

- `unitFloorBuilding`
- `address`
- `locality`
- `city`
- `state`
- `pincode`
- optional `latitude`
- optional `longitude`

### 6. Track lifecycle after booking

Use:

- appointment status webhook callbacks
- `GET /v1.0/appointment/getAppointmentDetails`
- `GET /v1.0/appointment/getAppointments`

The status values confirmed by the PDF are only:

- `PENDING`
- `CREATED`
- `CONFIRMED`
- `CANCELED`
- `RESCHEDULED`
- `COMPLETED`

### 7. Report or documents

Use:

- `GET /v1.0/appointment/getAppointmentDetails`
- `GET /v1.0/appointment/getDocument`

The document confirms file retrieval for attached documents.

## What Is Missing For Diagnostics

The following requirements are not clearly covered in `LabStack Provider API V1.0.9.pdf`:

- test search API
- package search API
- package details API
- package price API
- payment collection API
- separate order confirmation API
- phlebo assignment API or dedicated phlebo assignment webhook status
- sample pickup webhook status
- diagnostic report JSON payload API
- lab order-specific status model beyond generic appointment statuses

Because of that, the full diagnostics flow cannot yet be finalized from this PDF alone.

## Webhook Understanding

The document confirms appointment status webhooks sent to the callback URL configured in LabStack Console.

This webhook includes fields such as:

- appointment ID
- appointment status
- appointment type
- appointment date
- reference ID
- provider details
- patient details
- documents
- cancellation reason

This is useful for keeping our local order or appointment state in sync.

However, the webhook examples in this PDF still look appointment-oriented rather than full diagnostics-order oriented.

## Practical Integration Recommendation

### Teleconsult

This can be integrated now using the current PDF.

Suggested sequence:

1. Fetch specialities if needed
2. Fetch providers using `appointmentType=ONLINE`
3. Optionally fetch provider details
4. Optionally fetch slots
5. Book appointment
6. Sync status through webhook plus details API
7. Fetch authenticated meeting link near appointment time
8. Fetch prescription and documents after consult

### Diagnostics

This should be split into two layers:

1. provider and appointment orchestration from the current PDF
2. diagnostics catalog, payment, lab order, phlebo, pickup, and reports from additional APIs or documents

Suggested currently-known sequence:

1. Discover providers by location
2. Discover slots
3. Book appointment
4. Sync status via webhook and detail APIs
5. Download any attached report documents

Suggested missing document request list:

- diagnostics catalog API
- test and package search API
- payment API
- lab order status webhook document
- phlebo assignment and sample pickup event definitions
- report JSON delivery specification

## Final Conclusion

From the current LabStack Provider API PDF:

- teleconsult flow is mostly clear and implementable
- diagnostics flow is only partially clear
- there is no dedicated package API documented here

If more LabStack documents are shared, this README should be extended with:

- package and test catalog flow
- diagnostics payment flow
- webhook event mapping
- final end-to-end state machine for both journeys
