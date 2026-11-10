# EWA Automation Overview

## Purpose

This document updates the current EWA automation overview based on the backend repository at `ewa_backend`. It keeps the original platform-evolution summary, while adding the operational areas that were missing or under-documented in the earlier version.

## Executive Summary

EWA is no longer just a booking backend. The current system operates as a multi-layer healthcare operations platform covering:

- onboarding, authentication, OTP, and role-aware access
- internal consultation and package booking workflows
- external diagnostics and consultation booking across partner labs
- camp discovery, camp slot retrieval, and camp order placement
- wallet, coupon, payment, refund, and referral automation
- HR, corporate, admin, and specialist-side operational workflows
- lab address, user address, geolocation, and serviceability-aware flows
- external catalog curation for package/test image, price, markup, pinning, and activation
- specialist payouts, invoice generation, and receipt generation
- app version control, notifications, file handling, and background jobs

In short, EWA already behaves like a healthcare orchestration system with business operations, field operations, and partner integrations built into the backend.

## How The Platform Appears To Have Evolved

This timeline is an inference from the module structure, route wiring, and service depth in the current backend.

### Phase 1: Core platform foundation

The earliest functional layer appears to have included:

- auth and OTP
- users, dependents, and addresses
- specialists and slots
- wellness packages
- partners
- internal bookings
- content modules such as banners, blogs, news, and health tips

### Phase 2: Commercial and transactional automation

The platform then expanded to automate money movement and incentives:

- Razorpay payments
- wallet creation and wallet ledger behavior
- coupon validation and usage accounting
- referral benefits and reward credits
- payment-linked booking finalization

### Phase 3: Communication and workflow automation

The next layer focused on operational continuity:

- email sending
- SMS OTP delivery
- FCM push notifications
- in-app notifications
- booking reminders
- file upload and static file serving
- background queue consumers

### Phase 4: External provider and diagnostics orchestration

This is the point where EWA moved beyond a simple first-party booking system:

- LabStack integration
- Healthians integration
- external package/test discovery
- diagnostics order pricing
- provider slot and lab discovery
- webhook-based status and report sync
- external payment recovery and stale-payment cleanup

### Phase 5: Ops, admin, corporate, and specialist control

The latest maturity layer is the operational tooling around the core workflows:

- dashboards
- HR management
- corporate-scoped operations
- specialist portal flows
- camp workflows
- payout processing
- app-version governance
- external catalog metadata management

## Current Automation Implemented In The Backend

## 1. Authentication and role-aware identity automation

What is automated:

- OTP generation and verification
- login flows for `user`, `admin`, `hr`, and `specialist`
- JWT issuance after verification
- profile lookup by role
- user auto-provisioning in onboarding paths
- specialist placeholder account creation where required
- email verification and corporate-email verification

Operational value:

- reduces manual account setup
- supports multi-role operations from a single backend
- centralizes identity and access enforcement

## 2. Internal consultation and package booking automation

What is automated:

- consultation and wellness-package booking creation
- payment-aware booking finalization
- booking reminders before appointment time
- specialist and user notifications
- Google Meet creation and synchronization for eligible bookings
- paid-booking email flows
- prescription and lifecycle updates through specialist workflows

Operational value:

- reduces manual coordination between patient and specialist
- connects booking, payment, reminders, and consultation delivery
- gives EWA an end-to-end internal care workflow

## 3. External booking automation for LabStack and Healthians

What is automated:

- external diagnostics and consultation booking
- package and test discovery
- lab/provider discovery
- slot lookup and booking placement
- coupon and wallet support in external flows
- zero-payable and paid booking handling
- retry/finalization flows for pending payments
- cancellation and refund handling
- report retrieval and storage
- webhook-based provider status sync

Operational value:

- turns third-party provider services into first-party EWA workflows
- reduces manual vendor coordination
- lets users experience external booking as a native platform capability

## 4. Camp booking and camp operations automation

This was missing from the earlier documentation and is now a dedicated backend capability.

What is automated:

- camp list retrieval
- camp details retrieval
- camp slot retrieval by date/time
- single camp order placement
- bulk camp order placement from uploaded row data
- user matching through mobile lookup for bulk camp placement
- automatic creation of external booking records for camp orders
- storage of camp metadata like camp id, appointment, lab id, VIP flag, and external payload

Operational value:

- supports B2B and on-ground diagnostic camp workflows
- reduces manual coordination for corporate or event-based screenings
- ensures camp bookings still flow through EWA tracking and reporting

## 5. Address, lab location, and serviceability-aware management

This area was also under-documented before.

What is automated:

- user address CRUD
- default-address handling per user
- syncing default address into the user profile
- storage of latitude and longitude alongside address data
- pincode and geo-input support across external diagnostics discovery flows
- location-aware lab/provider lookup in partner integrations

What this means in practice:

- EWA now has both profile-level address management and diagnostics-specific location handling
- service discovery can work from `pincode` or `latitude`/`longitude`
- the platform is prepared for lab address selection, distance-aware listing, and direction-supporting frontend flows

Operational value:

- improves serviceability checks
- helps diagnostics flows choose the right provider or lab
- reduces location mismatch during home collection or center visit bookings

## 6. Lab-wise pricing and diagnostics pricing control

This is a meaningful addition beyond generic external booking support.

What is automated:

- package and test price resolution from external provider data
- fallback price extraction from multiple possible provider fields
- lab-wise price extraction when provider payloads include lab-specific pricing
- price computation across multiple package ids and test ids
- metadata-based price override logic
- support for fixed custom pricing and percentage markup

Operational value:

- allows EWA to control pricing even when partner feeds vary
- supports different pricing by lab rather than one flat diagnostics price
- gives the business a clean way to adjust pricing without changing provider masters

## 7. External catalog metadata management

This is the clearest backend support for package/test curation that was not captured well in the old doc.

What is automated:

- external catalog item creation, listing, update, and deletion
- catalog metadata separation by `integration` and `itemType`
- package/test mapping through `externalItemId`
- custom price overrides
- markup percentage overrides
- image and cover image management
- gender tagging
- pinned item support
- active/inactive control

What this enables operationally:

- package image management
- external package price management
- external diagnostics/test catalog curation
- featured or pinned catalog items in admin experiences
- partner-catalog normalization without changing upstream vendor data

Operational value:

- gives the admin team control over how external packages and tests are presented
- supports merchandising and commercial adjustments on top of vendor feeds
- reduces dependency on raw partner catalog formatting

## 8. Payment, wallet, refund, and referral automation

What is automated:

- Razorpay order creation
- payment verification and finalization
- handling of zero-payable transactions
- wallet creation
- wallet recharge and debit logic
- refund to wallet
- referral credits
- payment-linked notifications and email flows
- coupon usage increment and reversal based on lifecycle events

Operational value:

- creates a transaction system around healthcare operations
- keeps wallet, coupon, and booking state synchronized
- reduces reconciliation overhead

## 9. Coupon and discount automation

What is automated:

- coupon creation and configuration
- eligibility validation across multiple scopes
- minimum purchase checks
- usage-limit enforcement
- booking-type-specific validation
- user-level usage counting
- automatic increment on successful payment
- reversal on refund/cancellation flows where applicable

Operational value:

- supports scalable promotions across multiple products
- prevents overuse and manual coupon policing
- makes pricing rules reusable across internal and external flows

## 10. Notifications, email, SMS, and push automation

What is automated:

- login notifications
- booking lifecycle notifications
- specialist appointment notifications
- wallet credit notifications
- reminder notifications
- FCM token registration and push delivery
- SMS OTP delivery
- transactional email sending
- bulk email route support for admin-led communication

Operational value:

- enables multi-channel operational communication
- reduces follow-up burden on support and ops teams
- supports both transactional messaging and bulk outbound communication

## 11. Webhook, report ingestion, and document automation

What is automated:

- webhook payload persistence
- status normalization from provider callbacks
- sync of provider booking state into EWA external booking records
- report persistence and retrieval
- external document link handling
- file upload and static file serving

Operational value:

- reduces manual provider follow-up
- keeps partner and platform state aligned
- supports report delivery as part of the booking lifecycle

## 12. HR panel and employee management automation

This is a much broader module than the earlier documentation suggested.

What is automated:

- HR employee record creation, retrieval, update, and deletion
- employee id, email, phone, and linked-user uniqueness checks
- joining/leaving date validation
- reporting-manager validation
- filtering by department, employment type, employment status, corporate, and manager
- employee search support
- corporate-level HR overview endpoints

HR corporate overview includes linked operational visibility across:

- users
- HR employees
- internal bookings
- external bookings
- banners
- coupons
- specialists
- wellness packages

Operational value:

- gives EWA a real employee and corporate wellness operations layer
- supports HR-led corporate health programs
- reduces manual spreadsheet-based employee management

## 13. Corporate operations automation

What is automated:

- corporate mappings
- corporate-scoped user and HR relationships
- package and specialist assignment to corporates
- corporate-aware filters in operational modules

Operational value:

- supports B2B and B2B2C business models
- lets EWA run employer-linked wellness programs with proper scoping

## 14. Specialist panel and specialist-side workflow automation

This was another major missing capability in the earlier documentation.

What is automated:

- specialist profile retrieval and update
- specialist-managed slot creation, update, listing, and deletion
- appointment listing by day, month, or paginated all-view
- appointment detail retrieval
- appointment status updates
- prescription creation
- patient history retrieval

Operational value:

- gives specialists a working operational panel instead of relying fully on admin
- reduces back-office intervention for schedule and consultation handling
- supports a cleaner doctor workflow for live consultation operations

## 15. Specialist payout and settlement automation

What is automated:

- payout activity summary generation
- payout billing fetch and calculation
- yearly missing-billing calculation support
- disbursal creation and update
- payout grid views
- invoice generation
- receipt generation
- bulk payout processing

Operational value:

- supports finance workflows around specialist compensation
- reduces manual payout calculations
- provides auditable payout documentation through generated invoice/receipt files

## 16. Health assessment and recommendation automation

What is automated:

- questionnaire handling
- category-level risk scoring
- recommendation generation
- specialist recommendation mapping
- package recommendation support
- missing-offering capture

Operational value:

- moves EWA toward guided preventive care
- provides a base for future personalization and conversion workflows

## 17. App-version and release-control automation

What is automated:

- centralized app-version records
- soft update and hard update control
- Android/iOS version governance
- store URL configuration

Operational value:

- gives product and ops teams release control without app redeployment
- supports safer mobile rollout management

## 18. Background jobs and operational runtime automation

What is automated:

- queued asynchronous processing
- reminder job scheduling
- stale-payment cleanup jobs
- deferred operational task handling through queue consumers

Operational value:

- separates delayed work from synchronous API response handling
- improves platform reliability as automation volume grows

## 19. Admin operational coverage

Based on current routes and modules, the backend supports admin operations across:

- dashboard
- users
- addresses
- dependents
- specialists
- specialist slots and consultation workflows
- wellness packages
- partners
- bookings
- external bookings
- camps
- corporates
- HR
- coupons
- notifications
- banners
- blogs
- news
- health tips
- external catalog items
- payouts
- app versions
- bulk email

This means the admin layer is already broad enough to function as a true operations console rather than a simple CMS.

## Important Additions Missing From The Earlier Documentation

The previous documentation should now explicitly include the following implemented capabilities:

- camp booking and camp order management
- address, latitude/longitude, and location-aware serviceability flows
- lab address and direction-supporting data foundations
- HR panel and employee management
- corporate HR overview reporting
- different lab-wise pricing for diagnostics
- external package/test catalog metadata management
- external package image and cover-image management
- external package custom price and markup management
- pinned and active/inactive external catalog control
- specialist panel / specialist-side operations
- payout and settlement workflows
- bulk email support
- blogs/news/content operations as part of admin coverage

## Final Assessment

The biggest change from the older documentation is this:

EWA is not only automating booking and payment anymore.

It is also automating:

- field and camp diagnostics operations
- employee and corporate wellness management
- specialist-side clinical workflows
- partner-catalog merchandising and pricing control
- finance-side payout operations

That makes the platform meaningfully broader than a standard healthcare booking backend. The documentation should now position EWA as a healthcare operations platform spanning patient, admin, HR, specialist, finance, and partner workflows.

## Future Offerings

The next strategic expansion areas for EWA can be framed as the following future offerings:

### 1. More partner integrations for diagnostics and specialist services

Potential direction:

- integrate additional diagnostics vendors beyond the current partner set
- onboard more specialist consultation partners where needed
- build fallback and routing logic across multiple vendors
- improve partner coverage by city, pincode, specialty, and service type

Expected value:

- improves service availability
- reduces dependency on a limited partner network
- gives EWA stronger pricing and fulfillment flexibility

### 2. Perks and member-benefit offerings through third-party vendors

Potential direction:

- add perks or benefit programs for users through external vendors
- support discounted services, wellness offers, loyalty benefits, and bundled partner deals
- make perks available as part of membership, package purchase, or corporate programs

Expected value:

- increases user retention and repeat engagement
- creates additional monetization opportunities
- strengthens the EWA ecosystem beyond pure booking transactions

### 3. App redesign

Potential direction:

- redesign the user app for a cleaner healthcare journey
- improve discovery for specialists, packages, diagnostics, and camps
- simplify navigation across booking, wallet, reports, and recommendations
- align the frontend more closely with the platform’s current operational depth

Expected value:

- improves user experience and conversion
- better supports the expanded service mix now available in the backend
- helps the product feel more premium and scalable

### 4. EWA APIs for external vendors and partners

Potential direction:

- expose EWA services through partner-facing APIs
- allow other vendors, aggregators, or corporate platforms to consume EWA booking and healthcare workflows
- support external access to specialist booking, package booking, diagnostics booking, report retrieval, and operational status flows
- evolve EWA from an internal product into a platform layer

Expected value:

- opens a B2B2C and platform-business opportunity
- allows EWA to sell infrastructure and service orchestration, not only direct consumer services
- creates a path for white-label or embedded healthcare services

### 5. WhatsApp bot for specialist and package bookings

Potential direction:

- allow users to discover specialists and packages directly through WhatsApp
- support guided booking flows through conversational automation
- send reminders, confirmations, and follow-up actions on WhatsApp
- extend later into diagnostics, camp participation, support, and report-sharing workflows

Expected value:

- reduces user friction in booking journeys
- improves accessibility for users who prefer chat over app navigation
- creates a high-engagement channel for booking and re-engagement automation
