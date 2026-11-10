# EWA Pharmacy Backend Product README

## Overview

This backend already powers the wider EWA healthcare platform. The pharmacy app should be added as a dedicated first-class domain, similar to `specialists`, not as a subtype under another module.

The pharmacy product should support:

- pharmacy profile and discovery
- medicine catalog and inventory
- retail and wholesale pricing
- Excel-based bulk inventory update
- in-shop and online medicine orders
- wholesale pharmacy-to-pharmacy orders
- pharmacy-created consultation orders
- pharmacy-created diagnostic orders
- pharmacy wallet for consultation payments
- BP and sugar result capture inside orders
- recurring medicine tracking
- user history and pharmacy history
- strict relationship-based privacy

## Current Backend Foundation

The existing backend already provides the core healthcare building blocks in `src1/`:

- auth, OTP, users, dependents, addresses
- specialists, slots, bookings, meet
- external consultations and diagnostics
- health assessments with vitals
- payments, wallet, coupons, notifications, referrals
- admin, dashboard, webhooks

Main route registration: [src1/routes/index.ts](/Users/shubhamgoyal/Desktop/ewa_backend/src1/routes/index.ts:1)  
App bootstrap: [src1/index.ts](/Users/shubhamgoyal/Desktop/ewa_backend/src1/index.ts:1)  
Config: [src1/config/config.ts](/Users/shubhamgoyal/Desktop/ewa_backend/src1/config/config.ts:1)

## Local Run

```bash
npm install
npm run dev
```

Useful scripts:

```bash
npm run dev:ts
npm run build
npm run type-check
```

Health check:

```bash
GET /health
```

## Product Flows

The pharmacy app should support five main order families:

1. Retail medicine orders for end users.
2. In-shop walk-in orders created by the pharmacy.
3. Online orders linked to a pharmacy.
4. Wholesale orders between pharmacies.
5. Healthcare-assisted orders, including consultations and diagnostics created by the pharmacy for a user.

## Roles

### Admin

- manage pharmacies and verification
- manage medicine master data and policies
- monitor orders, consultations, diagnostics, and payments
- audit access and visibility rules

### Pharmacy

- manage profile, wallet, medicine inventory, and pricing
- update inventory through Excel sheet upload
- create customers for walk-in users
- create shop, online, wholesale, consultation-linked, and diagnostic-linked orders
- add BP and sugar readings
- track repeat patients and recurring medicines

### Retail User

- browse pharmacies and retail prices
- place or receive orders
- see pharmacy-created consultations and diagnostics linked to them
- log in later and view older pharmacy-created activity on the same account

### Wholesale Pharmacy

- view wholesale pricing
- place bulk orders
- track order and purchase history

## Pharmacy Module Design

Pharmacy should be implemented as a dedicated module like `specialists`.

Suggested new modules under `src1/modules/`:

- `pharmacies`
- `pharmacyMedicines`
- `pharmacyInventory`
- `pharmacyInventoryImports`
- `pharmacyCustomers`
- `pharmacyOrders`
- `pharmacyWallet`
- `pharmacySubscriptions`
- `orderHealthChecks`
- `patientTracking`
- `pharmacyTracking`

The `pharmacies` module should have its own:

- model
- repository
- service
- controller
- routes
- validation
- types

Reference structure: [src1/modules/specialists](/Users/shubhamgoyal/Desktop/ewa_backend/src1/modules/specialists)

## Pharmacy Profile

Recommended pharmacy fields:

- pharmacy name
- nickname
- owner or contact name
- phone and email
- address, city, state, pincode
- latitude and longitude
- GST number
- drug license number
- opening hours
- pickup availability
- delivery availability
- verification status
- wallet status

Pharmacy discovery should come from `/api/v1/pharmacies`, including nearby listing and verified listing.

## Inventory and Catalog

Recommended core entities:

- `Pharmacy`
- `Medicine`
- `MedicineBatch`
- `InventoryItem`
- `InventoryAdjustment`
- `PharmacyOrder`
- `PharmacyOrderItem`

Recommended medicine fields:

- medicine name
- generic name
- brand name
- category
- dosage form
- strength
- manufacturer
- batch number
- expiry date
- HSN code
- GST percent
- prescription required
- active flag

Recommended inventory fields:

- pharmacy id
- medicine id
- available quantity
- reserved quantity
- free quantity
- reorder threshold
- rack or shelf location
- purchase price
- retail price
- wholesale price
- batch mapping

Recommended inventory operations:

- `reserve_item`
- `release_item`
- `free_item`
- `deduct_item`
- `return_item`
- `adjust_item`

## Excel Inventory Import

Bulk inventory update must be supported.

Supported formats:

- `.xlsx`
- `.xls`
- `.csv`

Recommended use cases:

- initial catalog import
- stock update
- retail price update
- wholesale price update
- batch and expiry update
- rack mapping update
- bulk activation or deactivation

Recommended import columns:

- medicine name
- generic name
- brand name
- SKU or internal code
- batch number
- expiry date
- available quantity
- purchase price
- retail price
- wholesale price
- GST percent
- rack location
- prescription required
- active status

Recommended import behavior:

- preview before commit
- row-level validation errors
- create-only, update-only, or upsert mode
- import audit trail
- uploader and timestamp history

## Pricing Rules

Each medicine should support:

- `retailPrice`
- `wholesalePrice`

Visibility:

| Viewer | Retail Price | Wholesale Price |
|---|---|---|
| Retail user | Yes | No |
| Pharmacy | No or optional | Yes |
| Admin | Yes | Yes |

This must be enforced in backend responses, not just frontend UI.

## Customer and User Creation

The pharmacy should be able to create a registered customer with:

- name
- phone
- age
- disease or condition notes if shared by the patient
- recurring medicine flag
- recurring interval in days

Rules:

- if the phone already belongs to an existing user, link to that user
- if not, create a real user account from the pharmacy app
- OTP should not be required at pharmacy-side creation time
- later, when the user logs in with OTP, the same account should open with the earlier history intact

Suggested user flags:

- `createdSource: pharmacy_app`
- `createdByRole: pharmacy`
- `createdById`
- `otpVerified: false`
- `linkedPharmacyId`

## Privacy Boundary

This is mandatory.

- a pharmacy must not be able to browse all platform users
- a pharmacy should gain access to a user only after a direct relationship exists
- valid relationship triggers include in-shop visit, pharmacy-created order, order placed with that pharmacy, pharmacy-created consultation, or pharmacy-created diagnostic order
- pharmacy-side search must be limited to that pharmacy's own linked users
- once linked, access should stay limited to the minimum data needed for service and follow-up

## Patient Tracking

Shared user-pharmacy tracking should support:

- disease notes
- chronic condition flag
- recurring medicine flag
- recurring interval in days
- preferred follow-up date
- pharmacy notes
- last consultation summary
- last diagnostic order summary
- last shop order summary
- last online order summary
- last wholesale order summary

Suggested patient tracking APIs:

- `GET /api/v1/patient-tracking/:userId`
- `PUT /api/v1/patient-tracking/:userId`
- `GET /api/v1/patient-tracking/:userId/timeline`

## Order Management

Recommended order types:

- `retail`
- `wholesale`
- `consultation-linked`
- `diagnostic-linked`
- `in_shop`
- `online`

Recommended statuses:

- `draft`
- `placed`
- `accepted`
- `packed`
- `ready_for_pickup`
- `out_for_delivery`
- `completed`
- `cancelled`
- `rejected`

Recommended order operations:

- create order
- update order
- cancel order
- reserve item
- release item
- add free item
- replace item
- remove item
- mark billed
- mark packed
- mark delivered
- complete order

Recommended order fields:

- order id
- pharmacy id
- customer id or buyer pharmacy id
- created by id
- created by role
- items
- quantities
- free items
- pricing snapshot
- payment mode
- payment status
- payment source
- delivery or pickup mode
- prescription files
- notes
- walk-in flag
- linked consultation id
- linked diagnostic order id
- linked health-check record id
- pharmacy nickname snapshot if needed

Recommended order item fields:

- medicine id
- ordered quantity
- reserved quantity
- billed quantity
- free quantity
- unit price
- discount
- line total
- item status

Supported payment modes:

- `online_payment`
- `in_store_payment`
- `cash_on_delivery`

Recommended payment statuses:

- `pending`
- `authorized`
- `paid`
- `failed`
- `refunded`
- `partially_paid`

## In-Shop Orders

In-shop flow:

1. Pharmacy creates or finds the customer by phone.
2. If needed, backend creates the user without OTP verification at that moment.
3. Pharmacy places the order on behalf of the customer.
4. The order is stored against the same user account.
5. When the user later logs in, earlier pharmacy-created orders and linked activity are visible.

## Consultation Orders

The pharmacy can create consultation orders for a user.

The pharmacy should be able to view:

- consultation status
- doctor or specialist details
- slot and mode
- prescription
- consultation summary or notes, subject to privacy rules
- related consultation documents

Current backend support already exists in:

- `/api/v1/bookings`
- `/api/v1/specialists`
- `/api/v1/slots`
- `/api/v1/external-bookings`

Recommended consultation metadata:

- `createdSource: pharmacy_app`
- `createdByRole: pharmacy`
- `createdById`
- `pharmacyId`
- `pharmacyOrderId`
- `customerRelationship: self | walk_in | assisted`
- `paymentSource: pharmacy_wallet | user_online | unpaid`

## Diagnostic Orders

The pharmacy should also be able to place diagnostic orders for a user.

These should:

- be visible to the creating pharmacy
- be visible to the linked user
- expose reports and documents as allowed
- be tracked in both patient and pharmacy timelines
- support payment tracking as part of the order lifecycle

Diagnostic orders should also support payment handling, for example:

- online payment
- in-store payment
- cash on delivery when applicable
- pending, paid, failed, and refunded states
- payment reference and transaction tracking

Current backend support already exists in:

- `/api/v1/external-bookings/diagnostics/bookings`
- `/api/v1/external-bookings/diagnostics/bookings/:id/report`
- `/api/v1/external-bookings/diagnostics/bookings/:id/report/document`

Recommended diagnostic metadata:

- `createdSource: pharmacy_app`
- `createdByRole: pharmacy`
- `createdById`
- `pharmacyId`
- `pharmacyOrderId`
- `linkedUserId`
- `paymentSource`
- `paymentStatus`
- `paymentTransactionId`

## Pharmacy Wallet

The pharmacy should have its own wallet for assisted healthcare flows.

Primary use cases:

- pay for doctor consultations initiated by the pharmacy
- support walk-in assisted bookings
- support reconciliation and refunds

Recommended wallet capabilities:

- wallet balance
- credit and debit ledger
- admin top-up or adjustment
- payment reference tracking
- booking-linked transactions
- refund support

Recommended wallet transaction types:

- `credit`
- `debit`
- `consultation_payment`
- `refund`
- `adjustment`

## Order Health Checks

Orders should support health-check capture, especially:

- systolic BP
- diastolic BP
- fasting sugar
- post-meal sugar
- HbA1c

The backend already has corresponding assessment vitals in:

- [src1/modules/healthAssessments/types/index.ts](/Users/shubhamgoyal/Desktop/ewa_backend/src1/modules/healthAssessments/types/index.ts:1)
- [src1/modules/healthAssessments/validation/index.ts](/Users/shubhamgoyal/Desktop/ewa_backend/src1/modules/healthAssessments/validation/index.ts:1)

Recommended `OrderHealthCheck` fields:

- order id
- pharmacy id
- user id
- checked by
- systolic BP
- diastolic BP
- fasting sugar
- post-meal sugar
- HbA1c
- notes
- checked at

## Recurring Medicines

Recurring medicine support should include:

- user id
- pharmacy id
- medicine id
- frequency
- recurring interval in days
- next refill date
- reminder channel
- active flag

Behavior:

- notify before refill date
- allow quick reorder
- support pharmacy follow-up
- keep recurrence visible to both pharmacy and user

## History and Tracking Views

### Pharmacy View

The pharmacy should be able to see, for linked users only:

- previous medicine orders
- consultation history
- diagnostic order history
- consultation prescriptions and documents
- diagnostic reports and documents
- BP and sugar results
- disease notes
- recurring medicines

The pharmacy should also have its own timeline and summary for:

- consultations created
- diagnostic orders created
- in-shop orders created
- online orders fulfilled
- wholesale orders fulfilled
- repeat patients
- recurring follow-ups

Suggested pharmacy tracking APIs:

- `GET /api/v1/pharmacy-tracking/:pharmacyId`
- `GET /api/v1/pharmacy-tracking/:pharmacyId/timeline`
- `GET /api/v1/pharmacy-tracking/:pharmacyId/summary`

### User View

The user should be able to see:

- all medicine orders linked to their account
- in-shop orders created on their behalf
- pharmacy-created consultations
- pharmacy-created diagnostic orders
- prescriptions and reports
- BP and sugar results
- recurring medicine schedule
- recorded disease notes when allowed

## Suggested Route Layout

```text
/api/v1/pharmacies
/api/v1/pharmacy-medicines
/api/v1/pharmacy-inventory
/api/v1/pharmacy-inventory-imports
/api/v1/pharmacy-customers
/api/v1/pharmacy-orders
/api/v1/pharmacy-wallet
/api/v1/pharmacy-subscriptions
/api/v1/order-health-checks
/api/v1/patient-tracking
/api/v1/pharmacy-tracking
```

## Suggested APIs

### Pharmacy

- `POST /api/v1/pharmacies`
- `GET /api/v1/pharmacies`
- `GET /api/v1/pharmacies/:id`
- `PUT /api/v1/pharmacies/:id`
- `GET /api/v1/pharmacies/nearby`
- `GET /api/v1/pharmacies/verified`

### Medicines and Inventory

- `POST /api/v1/pharmacy-medicines`
- `GET /api/v1/pharmacy-medicines`
- `PUT /api/v1/pharmacy-medicines/:id`
- `POST /api/v1/pharmacy-inventory/adjust`
- `GET /api/v1/pharmacy-inventory/low-stock`
- `POST /api/v1/pharmacy-inventory/import`
- `POST /api/v1/pharmacy-inventory/import/preview`
- `GET /api/v1/pharmacy-inventory/imports`
- `GET /api/v1/pharmacy-inventory/imports/:id`

### Pharmacy Customers

- `POST /api/v1/pharmacy-customers`
- `GET /api/v1/pharmacy-customers`
- `GET /api/v1/pharmacy-customers/:id/history`
- `PUT /api/v1/pharmacy-customers/:id/medical-notes`

### Orders

- `POST /api/v1/pharmacy-orders`
- `GET /api/v1/pharmacy-orders`
- `GET /api/v1/pharmacy-orders/:id`
- `PUT /api/v1/pharmacy-orders/:id`
- `POST /api/v1/pharmacy-orders/:id/status`
- `POST /api/v1/pharmacy-orders/:id/consultation`
- `POST /api/v1/pharmacy-orders/:id/diagnostics`
- `POST /api/v1/pharmacy-orders/:id/reserve-items`
- `POST /api/v1/pharmacy-orders/:id/release-items`
- `POST /api/v1/pharmacy-orders/:id/free-items`

### Pharmacy Wallet

- `GET /api/v1/pharmacy-wallet`
- `GET /api/v1/pharmacy-wallet/transactions`
- `POST /api/v1/pharmacy-wallet/topup`
- `POST /api/v1/pharmacy-wallet/consultation-payment`

### Health Checks

- `POST /api/v1/pharmacy-orders/:id/health-check`
- `PUT /api/v1/pharmacy-orders/:id/health-check`
- `GET /api/v1/pharmacy-orders/:id/health-check`

### Tracking

- `GET /api/v1/patient-tracking/:userId`
- `PUT /api/v1/patient-tracking/:userId`
- `GET /api/v1/patient-tracking/:userId/timeline`
- `GET /api/v1/pharmacy-tracking/:pharmacyId`
- `GET /api/v1/pharmacy-tracking/:pharmacyId/timeline`
- `GET /api/v1/pharmacy-tracking/:pharmacyId/summary`

### Subscriptions

- `POST /api/v1/pharmacy-subscriptions`
- `GET /api/v1/pharmacy-subscriptions`
- `PUT /api/v1/pharmacy-subscriptions/:id`
- `POST /api/v1/pharmacy-subscriptions/:id/pause`

## Visibility Rules

These rules should be enforced across APIs:

- pharmacy cannot browse unrelated platform users
- pharmacy user-search must be scoped to linked users only
- pharmacy-created consultation must be visible to the creating pharmacy and linked user
- pharmacy-created diagnostic order must be visible to the creating pharmacy and linked user
- pharmacy-created diagnostic order payment state must be visible to the creating pharmacy and linked user as allowed by role
- in-shop orders created by pharmacy must become visible to the linked user after login
- consultation prescription and related documents should be visible to the creating pharmacy for that flow
- diagnostic reports and related documents should be visible to the creating pharmacy for that flow
- BP and sugar results should be visible to the pharmacy and linked user
- every consultation, diagnostic order, shop order, and online order should carry `createdByRole` and `createdById`
- every such event should be trackable in pharmacy activity history
- normal users must not see wholesale pricing
- pharmacies must not see another pharmacy's retail selling price
- admin can audit everything

## Existing Backend Modules Useful for Pharmacy

- `/api/v1/auth`
- `/api/v1/otp`
- `/api/v1/users`
- `/api/v1/dependents`
- `/api/v1/addresses`
- `/api/v1/bookings`
- `/api/v1/specialists`
- `/api/v1/slots`
- `/api/v1/meet`
- `/api/v1/external-bookings`
- `/api/v1/external-catalog-items`
- `/api/v1/payments`
- `/api/v1/wallet`
- `/api/v1/coupons`
- `/api/v1/referrals`
- `/api/v1/notifications`
- `/api/v1/admins`
- `/api/v1/dashboard`
- `/api/v1/webhooks`

## Recommended Development Approach

1. Build `pharmacies` as a dedicated module following the `specialists` structure.
2. Build `pharmacyMedicines` and `pharmacyInventory` next, including atomic stock adjustment rules.
3. Build `pharmacyCustomers` and relationship-based user linking.
4. Build `pharmacyOrders` once inventory and customer linkage are stable.
5. Reuse existing `users`, `bookings`, `externalBookings`, `payments`, and `notifications`.
6. Link pharmacy orders with consultation and diagnostic bookings through IDs.
7. Add pharmacy wallet ledger support for auditable consultation and diagnostic payments.
8. Add order-linked health checks with optional sync to health assessments.
9. Enforce price visibility and user-privacy rules in serializers or DTO layers, not scattered controller logic.
10. Add Excel inventory import with preview, validation, and import history.
11. Add patient and pharmacy tracking timelines only after orders and linking rules are stable.
12. Add subscriptions and recurrence follow-up on top of the stable order and patient graph.

## Risks and Gaps to Watch

### 1. Inventory Concurrency

The spec includes `available quantity`, `reserved quantity`, and stock operations, but inventory updates must be atomic. If these fields are updated independently during concurrent order placement, overselling can happen.

Recommended guardrail:

- use a single atomic stock adjustment flow at the database layer
- avoid split read-then-write reservation logic
- if the datastore supports it, use row-level locking or equivalent transactional protection

### 2. Pricing Visibility Enforcement Location

Price visibility must be enforced in serializers, DTOs, or a response-shaping layer, not scattered across controllers.

Why this matters:

- medicine data can leak through order history, search, detail pages, or nested payloads
- controller-level checks are easy to miss on secondary endpoints

### 3. `createdByRole` / `createdById` on Existing Models

Pharmacy-created consultation and diagnostic flows may need extra linkage fields such as:

- `pharmacyId`
- `pharmacyOrderId`
- `createdByRole`
- `createdById`

This should be decided upfront:

- extend existing `bookings` and `externalBookings` models directly
- or use dedicated linking tables or collections

The second option is cleaner if nullable linkage fields start spreading too widely.

### 4. Pharmacy Wallet vs Existing User Wallet

The pharmacy wallet must remain a separate entity from the user wallet.

Recommended rule:

- shared utility code is fine
- shared balance storage or shared ledger is not fine

This keeps:

- balance isolation
- clean audit history
- simpler reconciliation

### 5. Wholesale Order Ownership

Wholesale orders involve two pharmacies, so `pharmacyId` alone is not enough.

Recommended order role fields:

- `sellerPharmacyId`
- `buyerPharmacyId`

Recommended behavior:

- the same wholesale order should be visible in both pharmacies' histories
- each pharmacy should see the order from its own operational perspective

### 6. Module Count and Sequencing

The number of suggested modules is high, so sequencing matters.

Recommended build order:

1. `pharmacies`
2. `pharmacyMedicines`
3. `pharmacyInventory`
4. `pharmacyCustomers`
5. `pharmacyOrders`
6. `pharmacyWallet`
7. `orderHealthChecks`
8. `patientTracking`
9. `pharmacyTracking`
10. `pharmacySubscriptions`

## Summary

`ewa_backend` already has the healthcare base needed for the pharmacy app. The pharmacy layer should now be added as a dedicated domain with inventory, orders, consultations, diagnostics, wallets, health checks, recurrence tracking, privacy-safe user linking, and pharmacy-side operational tracking.
