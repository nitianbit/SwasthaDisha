# Cross-check: what exists and what still needs work

**Second source review:** 8 November 2026. **Baseline:** `pharmyx-fixes`, commit `9ca8b54606581f2158e760cad79aa7b845529184`. No application changes occurred between the first review and this cross-check.

This document answers whether the requested capabilities are present in this backend. It does not equate a database field, helper, API or status label with a complete working product. Existing source has not passed a runtime verification in this environment: clean install remains blocked by the committed lockfile mismatch.

The expanded requirement adds daily in-house business operations and inventory for labs, clinics/doctors and hospitals as well as pharmacies. Nine additional bounded checks are recorded in section H; the original 60 remain as the earlier baseline. The earlier expanded baseline had 69 checks. The new basic-phone requirement adds C11, making 70 checks: 19 Existing, 18 Partial, 30 Missing and 3 Unverified. Counts describe the chosen requirements, not a completion percentage. See [BUSINESS_OPERATIONS.md](BUSINESS_OPERATIONS.md).

## Status definitions

- **Existing:** a backend route/use case and supporting source were identified for the specifically named capability. Reuse and test it; this does not certify security or production correctness.
- **Partial:** useful code or data exists, but the named workflow has material gaps.
- **Missing:** no dedicated implementation of the named workflow was identified after graph discovery, source/route review and targeted fallback searches. This is a finding about this checkout, not every EWA/client repository.
- **Unverified:** cannot be established from this checkout without client code, deployment evidence or execution.

Statuses apply to the bounded capability in each row. They are not completion percentages. Delivery references M0-M8 point to the [roadmap](ROADMAP.md).

## Six-area result

| Requested area | Result | What can be reused / what is missing |
| --- | --- | --- |
| App pharmacy and in-house sales | Partial | Catalogue, stock, cart, orders, counter-sale data and manual collection exist. Pharmacist review, complete POS interface, sales invoices, shifts and returns need work. |
| Retail and wholesale through app/counter | Partial | Both price fields and buyer/channel routing exist. Full price-list policy, purchasing, UOM conversion, trade credit and accounting documents are missing. |
| Hospital HMS | Missing dedicated HMS | In-person visits/documents are reusable. Facility OPD, tariffs/billing and central/department supply stores/consumption are missing; basic stores are initial scope. |
| Lab management | Partial | API booking/report/callback services exist. The missing panel now includes direct lab customers, invoices/receipts, consumable stock and signatory/review, as well as app assignments. |
| Doctor dashboard | Partial product; existing portal APIs | Profile/slot/appointment/status/prescription/history/stats APIs exist. Shared EHR, queue, business billing, clinic supplies and complete UI need work. |
| Third-party vendor dashboard | Missing general workspace | Partner CRUD/adapters/scoped roles are foundations. Standalone business/module/publication controls, staff, private catalogue, stock and commercial self-service remain incomplete. |

## Confirmed lab delivery model

Labs are third-party vendors with two delivery routes: **API-connected third-party labs** use provider adapters; **panel-managed third-party labs** without APIs use the Jansetu lab partner panel. The existing API adapters remain reuse scope. The missing deliverable is the lab-specific staff/order/report panel and its backend permissions, not a requirement that every partner install a full laboratory information system.

Both routes share patient/order identifiers, assigned lab/branch scope, sample and report status, original/corrected report versions, clinician-review tasks, payments and audit. Panel report release triggers the same notifications/events and optional outgoing webhooks as an API-supplied report. A lab-owned API or webhook endpoint is not needed for the panel route. API-to-panel handover must be explicit and auditable to avoid duplicate orders or competing status updates. The minimum panel ships in M4; broader vendor self-service expands in M5.

The panel must also support a lab's own unlisted walk-in/referral business, private billing and basic reagent/consumable purchasing/usage. API availability does not determine marketplace listing or stock ownership; choose one authoritative writer for each resource.

## A. Pharmacy ordering, inventory and counter sales

| ID | Capability | Status | Verified scope and remaining work |
| --- | --- | --- | --- |
| A01 | Pharmacy onboarding and verification data | Existing | Pharmacy profile, document/licence fields and active/verified operational guards exist. Add individual staff, branch/licence expiry and verification history. Evidence SRC01. |
| A02 | Medicine catalogue and discovery | Existing | Medicine models, search/nearby APIs and prescription/tax flags exist. Master-data governance and responsive client experience still need validation. SRC02. |
| A03 | Patient/pharmacy app cart and checkout | Existing | Actor-scoped cart, current-price refresh/conflict and order creation exist; pharmacy buyers cannot buy from themselves. SRC03. |
| A04 | Batch FEFO stock and order reservation | Existing | Batch expiry/status filter, ordered allocation, reservation/consumption/release and transactional order creation exist. Concurrency tests must run on a replica set. SRC04. |
| A05 | Low-stock query and adjustment history | Existing | `/pharmacy-inventory/low-stock` and `/adjustments`, reorder threshold and adjustment records exist. This proves a worklist/query, not automated replenishment messages or purchasing. SRC04. |
| A06 | Inventory spreadsheet import/retry | Existing | Preview, commit, failed-row download, retry and cleanup exist. Large imports need bounded worker execution and real recovery tests. SRC05. |
| A07 | Counter sale backend and cash/COD marking | Existing | `in_store`, `isWalkIn`, customer/buyer references, `markPaid`, actor checks and conditional paid-state update exist. Complete cashier shifts and financial receipt workflow do not. SRC06. |
| A08 | Prescription review before dispensing | Partial | Prescription URLs, required-medicine check and pending/approved/rejected enum exist. No exposed pharmacist review/release workflow was identified. SRC06. |
| A09 | Pickup/delivery operations | Partial | Pickup/delivery modes and packed/ready/out-for-delivery/completed states exist. Dispatch assignment, proof of delivery and service-level exceptions are not established. SRC06. |
| A10 | Recurring medicine and refill reminders | Partial | Subscriptions, next-refill dates, reminder channel, pause/update and order reconciliation exist. No due-date refill dispatch scheduler/consumer was identified; booking reminders are different. SRC07. |
| A11 | Completed-sale return, batch restock and credit | Partial | Generic `returnStock`/`atomicReturn` helpers and adjustment reason `return` exist. `atomicReturn` increments aggregate available quantity; a customer-return workflow that restores the correct batch, issues credit and reconciles refund was not identified. SRC04/SRC06. |
| A12 | Cashier register/shift close and sales invoice | Missing | No dedicated register/shift or pharmacy sales invoice/credit-note workflow found. Order numbers and specialist payout invoices do not supply these functions. SRC06/SRC12. |

## B. Retail, wholesale and commercial backoffice

| ID | Capability | Status | Verified scope and remaining work |
| --- | --- | --- | --- |
| B01 | Retail and wholesale prices | Existing | Inventory stores both; `resolveOrderItemsPricing` selects using the buyer pharmacy reference and has fallback behavior. Batch prices are stored, but checkout selects top-level inventory prices. SRC04/SRC06. |
| B02 | App and counter sales channels | Existing | `orderType` supports online/in-store separately from customer/pharmacy buyer. Do not rebuild the basic channel split. SRC06. |
| B03 | Server pricing and override governance | Partial | App checkout passes no client unit price and disables overrides. Counter create can allow unit-price overrides; approval/audit policy and versioned price-list entitlements need work. SRC03/SRC06. |
| B04 | Discounts, tax snapshots and paise totals | Existing | Order item discount, HSN/GST and minor-unit amount fields/calculations exist. Finance must validate rounding, tax interpretation and invoice treatment. SRC06. |
| B05 | Pack/strip/unit conversion | Missing | Current stock uses numeric quantities; no explicit stock/sale UOM conversion model or conversion workflow identified. SRC04/SRC06. |
| B06 | Purchase order, GRN and supplier payable | Missing | Purchase price and `purchase` adjustment reason exist, but no supplier/PO/GRN/vendor-invoice chain was found. SRC04. |
| B07 | Wholesale credit limit and receivable aging | Missing | Pending/partially-paid labels and wallets are not a trade-credit facility. No credit approval/limit/aging workflow found. SRC06/SRC11. |
| B08 | Customer price lists, slabs and sales credit notes | Missing | No dedicated effective-dated buyer price-list/slab or linked sales credit-note implementation identified. Extend existing price routing. SRC06. |

## C. Doctor and consultation management

| ID | Capability | Status | Verified scope and remaining work |
| --- | --- | --- | --- |
| C01 | Doctor self profile, slots, appointments and stats | Existing | Specialist `me` routes cover profile, slots, day/month/all appointments, status, history, prescription and stats. SRC08. |
| C02 | In-person and assisted booking foundation | Partial | Consultation mode includes in-person; pharmacy/admin actors can create bookings for a user. Dedicated reception/walk-in queue, triage and clinician intake workflow are not implemented. SRC09. |
| C03 | Prescription medicine fields and PDF | Existing | Name, dosage, frequency, duration, instructions, diagnosis, advice, tests advised and generated PDF already exist. Separate strength/route fields, finalization and immutable amendments remain to add. SRC08/SRC09. |
| C04 | Patient consultation history | Partial | Specialist-local consultation history and pharmacy-linked summaries exist. They are not a consent-controlled longitudinal EHR across clinicians, labs and hospitals. SRC08/SRC15. |
| C05 | Free-follow-up rule and appointment reminders | Existing | One-level benefit rules and scheduled booking reminders exist. Preserve the benefit rule while testing failure recovery; general care task follow-up is separate. SRC09/SRC14. |
| C06 | Consultation collection/payment integration | Existing | Fee, coupon/wallet and gateway-payment flows are implemented. M0 now gates atomic customer-wallet effects (R17), resume-before-retry, captured-only webhook/reconciliation and safe late/cancelled-payment recovery; receipts/cash and approved liability mappings expand later. Integration existence is not collection correctness. SRC09/SRC11. |
| C07 | Specialist payout accounting | Existing | Admin APIs calculate billings, record partial/full disbursals and generate invoice/receipt assets. They do not execute or confirm a bank transfer. Doctor-accessible settlement self-service is not supplied by admin-only APIs. SRC12. |
| C08 | Atomic shared app/walk-in capacity | Partial | Capacity fields/availability checks exist, but booking save and slot increment are separate; increment lacks a capacity condition. Must fix before concurrent expansion. SRC09. |
| C09 | Clinical sign-off, amendment and report-review inbox | Missing | Prescriptions update the current booking object; no dedicated immutable clinical-version and clinician report-review task workflow found. SRC08/SRC09. |
| C10 | Finished doctor application UI | Unverified | `doctor_app` contains API documentation, not dashboard source. Other client repositories were not reviewed in this checkout. |
| C11 | Basic-phone doctor helpline and partner-assisted patient top-ups | Missing | Existing recharge and unrouted PharmacyWalletService.payConsultation are reuse primitives: pharmacy linkage, transactional debit and conditional booking-paid guard exist. The latter trusts req.amount and lacks a dedicated validated/idempotent route contract. No complete partner-to-patient top-up, lab/hospital wallet or IVR bridge/clinical-charge workflow is established. F14/P1 select Partner-paid consultation, Consultation-only balance or General patient wallet; M1 identity remains required. |

Review update: [AR-01–AR-36](ARCHITECTURE_REVIEW.md) adds payment/report/refund-budget and enforcement precision. C11 remains a Missing end-to-end requirement despite the newly acknowledged sponsorship primitive; the 70-row counts do not change. AR-21 corrects the earlier incomplete reuse description, not the live capability status. [Phone specification](PHONE_CONSULTATIONS.md).

## D. Laboratory orders, reports and webhooks

| ID | Capability | Status | Verified scope and remaining work |
| --- | --- | --- | --- |
| D01 | API-connected third-party lab booking | Existing | LabStack/Healthians integration, catalogue/pricing and booking/payment/cancel/retry/report paths exist. These cover the API-capable route; real provider behavior remains untested here. SRC10. |
| D02 | Report retrieval/storage and generic file upload | Existing | External report retrieval/persistence and booking report/file structures exist. Preserve retrieval but fix stable-name overwrite/public cache in M0. Partial/final and corrected bytes need immutable versions; legacy overwritten history is unknown. SRC09/SRC10/SRC13. |
| D03 | Incoming booking-status callback processing | Partial | Callback routes, payload validation, raw storage and booking/report sync exist. Provider authentication, durable dedupe/order checks and processing isolation are incomplete. SRC10. |
| D04 | Outgoing webhook subscriptions and delivery | Missing | No general subscriber/secret/event delivery-attempt/replay workspace identified. Existing incoming callbacks are not an outbound event platform. SRC10/SRC14. |
| D05 | Partner panel and direct lab operations | Missing | No dedicated lab staff/order/sample/report workbench found. Expand the panel to direct/private test billing and consumable stock using shared business scope; existing file/provider services are foundations. Full analyzer/LIS is not a prerequisite. SRC10/SRC16/SRC19. |
| D06 | Signatory verification and report amendments | Missing | Upload/storage does not supply signatory release, original/version linkage and reasoned corrected report workflow. SRC09/SRC10/SRC13. |
| D07 | Critical result escalation and acknowledgment | Missing | Generic notification delivery does not establish named clinical escalation, direct communication and acknowledgment. SRC14/SRC16. |
| D08 | Optional analyzer/QC/instrument workflows | Missing | Full LIS/instrument automation is absent and optional; basic reagent/consumable stock belongs to initial daily operations scope, covered in section H. SRC16/SRC19. |

## E. Hospital management

| ID | Capability | Status | Verified scope and remaining work |
| --- | --- | --- | --- |
| H01 | In-person visit and external documents | Partial | Reuse consultation mode, clinicians, booking files/reports and payment foundations. A specialist's hospital/clinic text field is not a hospital organization. SRC09/SRC13. |
| H02 | Hospital branches, departments and staff | Missing | No dedicated facility/department/staff-membership model/workflow identified. SRC16. |
| H03 | OPD registration/queue, tariffs and billing | Missing | Appointment creation is not a facility OPD workflow. No dedicated queue, tariff, hospital invoice/cash register implementation found. SRC09/SRC16. |
| H04 | Clinical referral, acceptance and discharge | Missing | Generic documents can store a discharge file. No dedicated clinical referral/acceptance/outcome workflow found; the existing referral module awards acquisition rewards. SRC15. |
| H05 | IPD, beds, nursing and OT | Missing | No dedicated admission/transfer/bed/ward/nursing/OT modules found. User approved these as later scope. SRC16. |

## F. General vendor self-service

| ID | Capability | Status | Verified scope and remaining work |
| --- | --- | --- | --- |
| F01 | Partner directory and provider adapters | Existing | Partner type/profile/verification fields and external provider clients exist. SRC10/SRC15. |
| F02 | Scoped specialist/pharmacy actor patterns | Partial | Specific roles and own pharmacy/specialist guards exist. General vendor organization, branch and individual staff memberships are missing. SRC01/SRC08/SRC16. |
| F03 | Vendor staff/catalogue/capacity/assigned-service workspace | Missing | No general vendor login/staff/assignment/self-service domain found. The lab-specific panel is an M4 slice of this shared partner model; broader self-service follows in M5. SRC15/SRC16. |
| F04 | Vendor statements, disputes and settlements | Missing | Specialist admin billing and pharmacy wallets are reusable but do not supply a general vendor settlement/dispute portal. SRC11/SRC12/SRC16. |
| F05 | Scoped third-party API clients and webhook settings | Missing | Provider integration credentials do not establish a customer-facing API-client scope/revocation/quota/subscription model. SRC10/SRC16. |

## G. Shared patient, security and platform capabilities

| ID | Capability | Status | Verified scope and remaining work |
| --- | --- | --- | --- |
| G01 | User, dependent and pharmacy-customer records | Existing | Account/dependent profiles and pharmacy relationships exist. They are the starting point for identity migration, not a complete master-patient implementation. SRC15. |
| G02 | Permanent patient ID, no-phone assisted identity and merge | Missing | No dedicated permanent Jansetu patient key, authorized duplicate-merge history or no-phone assisted identification workflow found. Pharmacy customer creation currently matches by phone. SRC15. |
| G03 | Versioned consent, withdrawal and caregiver authority | Missing | No dedicated clinical/privacy consent-event and representative-authorization implementation found. OAuth consent is unrelated. SRC16. |
| G04 | Complete clinical EHR/episodes and care timeline | Partial | Booking clinical fields, reports, health checks and scoped summaries exist. Cross-service encounter/provenance/version/consent and outstanding-task linkage is missing. SRC08/SRC09/SRC15. |
| G05 | Follow-up, clinical emergency and grievance cases | Missing | Appointment reminders/refill preferences/reward referrals exist, but no shared care-task/clinical emergency/grievance case domain identified. SRC14/SRC15/SRC16. |
| G06 | Authentication and role/resource enforcement | Partial | JWT and selected role/HR/pharmacy guards exist. OTP bypass, fallback secret and user object-access gaps remain release blockers. SRC16/SRC17. |
| G07 | Clinical file authorization | Partial | Upload/download APIs exist; public static clinical-file access and caching do not meet the proposed private-record boundary. SRC13/SRC17. |
| G08 | Persisted jobs and notifications | Partial | Mongo jobs, booking reminders and order side-effect consumers exist. Leases/retry/dead letters/outbox/worker draining need hardening; refill dispatch is not wired. SRC07/SRC14. |
| G09 | Record-access audit, retention and privileged lifecycle | Missing | Transaction/adjustment ledgers and ordinary logger exist. No comprehensive purpose-based read/export/clinical-amendment audit and retention/hold workflow found. SRC16/SRC17. |
| G10 | ABDM/ABHA health information exchange | Missing | No dedicated consent-driven ABDM exchange implementation found. Optional future integration must not be inferred from ordinary patient/report fields. SRC16. |
| G11 | 100 RPS, production encryption, backup/restore and UI completion | Unverified | No benchmark/restore/deployment evidence or full clients were exercised. Their absence from this checkout is not evidence that no external infrastructure exists. |
| G12 | Clean install, type-check and integration execution | Unverified | Lockfile omits `xlsx` dependencies; prior `npm ci` failed, leaving `tsc`/`tsx` unavailable. No tests passed in this review. SRC18. |

## H. Expanded in-house business operations

These nine checks cover the latest product direction. Pharmacy-only helpers and recurring-medicine subscriptions do not prove a general business operations/SaaS implementation.

| ID | Capability | Status | Verified scope and remaining work |
| --- | --- | --- | --- |
| I01 | Standalone business and optional listing | Missing | No general business/module/publication settings identified. Internal operations must work with public listing off, retaining private patient and commercial data. SRC16/SRC19. |
| I02 | Direct/app/phone/import origin and referrals | Partial | Pharmacy online/in-store and in-person/assisted consultation foundations exist. Add consistent cross-business origin, independent referrer and commission attribution without rewriting old references. SRC06/SRC09/SRC19. |
| I03 | Lab/clinic/hospital supplies inventory | Missing | Inventory models/services discovered are pharmacy/medicine-specific. Add non-medicine items/units, stock locations/lots and movement balances; preserve medicine safety rules. SRC04/SRC19. |
| I04 | Department stores and issue/receive transfers | Missing | A generic transfer adjustment reason is not a complete branch/location dispatch-receipt/custody workflow. Add stores, permissions, in-transit balance and receiving reconciliation. SRC04/SRC19. |
| I05 | Visit/test/procedure supply consumption | Missing | No dedicated per-service consumable usage/waste/reversal workflow identified. Post once against a test/visit/procedure; avoid duplicate consumption or unintended duplicate patient charge. SRC19. |
| I06 | Shared private business billing and cash close | Partial | Fees, order totals, manual paid marking, wallets and specialist payout documents exist. Full cross-business invoices/credits/receipts/dues/cashier close remain incomplete. SRC06/SRC11/SRC12/SRC19. |
| I07 | Private versus public tariff/catalogue | Partial | Retail/wholesale fields and provider catalogue overrides exist. Add controlled publication, private tariffs and immutable sold-price/source snapshots across business types. SRC04/SRC06/SRC10/SRC19. |
| I08 | Business software subscriptions and entitlements | Missing | Existing subscriptions track recurring medicines. No general SaaS plan/module/billing-period entitlement implementation found; keep platform fees separate from customer bills/marketplace commission. SRC07/SRC19. |
| I09 | Private business onboarding and opening balances | Missing | Pharmacy medicine imports provide a limited reusable pattern. No complete cross-business private patient/service/item, opening supply stock/dues import and reconciliation workflow found. SRC05/SRC15/SRC19. |

## Corrections to the first plan

1. **Low stock is already implemented as an API query.** Retain it; build alert delivery/replenishment operations only where needed.
2. **Prescription dosage/frequency/duration/instructions exist.** Add explicit strength/route, stronger finalization and amendment rules; do not recreate the fields.
3. **Connected counter order and manual cash/COD marking exist.** The remaining gap is a complete POS/register/invoice/reconciliation workflow.
4. **In-person mode and pharmacy-assisted consultation booking exist.** A reception/walk-in queue and safe shared capacity still need implementation.
5. **Specialist payout accounting and invoice/receipt assets exist.** Doctor self-service visibility, general vendor settlement and bank confirmation are distinct work.
6. **Refill reminder preferences are not scheduled dispatch.** The source registers booking-reminder and pharmacy-order side-effect consumers, but no due-refill dispatcher was identified.
7. **Stock-return helper presence is not an end-to-end sales return.** Batch identity, credit document, return authorization and refund reconciliation still need a designed workflow.
8. **Basic report upload/retrieval and API lab integrations exist.** The missing lab work includes the partner panel for labs without APIs, assigned order/sample status, signatory/amendments/review and secure event delivery. A full LIS remains optional.

## Source evidence register

All paths below resolve in the reviewed checkout. Function/field names identify the evidence; the root planning docs are not used as proof of their own claims.

- **SRC01:** [pharmacy model](../../src1/modules/pharmacies/model/index.ts), [pharmacy routes](../../src1/modules/pharmacies/routes/index.ts), [role guards](../../src1/modules/middleware/auth.ts): active/verified pharmacy guards, document fields.
- **SRC02:** [medicine model](../../src1/modules/pharmacyMedicines/model/index.ts), [medicine routes](../../src1/modules/pharmacyMedicines/routes/index.ts): catalogue, prescription/tax metadata and discovery.
- **SRC03:** [cart service](../../src1/modules/pharmacyCart/services/index.ts), `checkout`: actor/buyer routing, refreshed prices, `allowPriceOverride: false`, self-purchase denial; [cart routes](../../src1/modules/pharmacyCart/routes/index.ts).
- **SRC04:** [inventory types](../../src1/modules/pharmacyInventory/types/index.ts), [inventory repository](../../src1/modules/pharmacyInventory/repository/index.ts), `reserveBatches`, `atomicReturn`; [inventory routes](../../src1/modules/pharmacyInventory/routes/index.ts): low-stock and adjustment endpoints.
- **SRC05:** [import service](../../src1/modules/pharmacyInventoryImports/services/index.ts), [import routes](../../src1/modules/pharmacyInventoryImports/routes/index.ts): preview/commit/retry/error download/cleanup.
- **SRC06:** [order model](../../src1/modules/pharmacyOrders/model/index.ts), [order service](../../src1/modules/pharmacyOrders/services/index.ts), `create`, `markPaid`, `resolveOrderItemsPricing`, `assertPrescriptionProvided`; [order routes](../../src1/modules/pharmacyOrders/routes/index.ts).
- **SRC07:** [subscription model](../../src1/modules/pharmacySubscriptions/model/index.ts), [subscription service](../../src1/modules/pharmacySubscriptions/services/index.ts), `reconcileForOrder`; [registered consumers](../../src1/modules/queue/service/consumers.ts): two consumer types, no identified refill dispatcher.
- **SRC08:** [specialist routes](../../src1/modules/specialists/routes/index.ts), [portal service](../../src1/modules/specialistPortal/services/index.ts), [prescription validation](../../src1/modules/specialistPortal/validation/index.ts): portal operations, current-object prescription updates and PDF generation.
- **SRC09:** [booking types](../../src1/modules/bookings/types/index.ts), `IBookingPrescriptionMedicine`; [booking controller](../../src1/modules/bookings/controller/index.ts), `resolveBookingUserId`; [booking service](../../src1/modules/bookings/services/index.ts), `createSpecialistBooking`; [slot repository](../../src1/modules/slots/repository/index.ts), `incrementBookingCount`.
- **SRC10:** [external booking service](../../src1/modules/externalBookings/services/index.ts), [LabStack client](../../src1/modules/bookings/services/labstack/index.ts), [Healthians client](../../src1/modules/bookings/services/healthians/index.ts), [webhook routes](../../src1/modules/webhooks/routes/index.ts), [webhook service](../../src1/modules/webhooks/services/index.ts).
- **SRC11:** [payment service](../../src1/modules/payment/services/index.ts), `verifyAndMarkPaid`, context processing and wallet refund methods; [user wallet](../../src1/modules/wallet/services/index.ts), [pharmacy wallet](../../src1/modules/pharmacyWallet/services/index.ts).
- **SRC12:** [payout routes](../../src1/modules/payouts/routes/index.ts), admin guard; [payout service](../../src1/modules/payouts/services/index.ts), `createDisbursal`, `getInvoice`, receipt generation; [payout types](../../src1/modules/payouts/types/index.ts).
- **SRC13:** [file routes](../../src1/modules/file/routes/index.ts), [file controller](../../src1/modules/file/controller/index.ts), `serveFileByPath`; [central routes](../../src1/routes/index.ts): public static mount.
- **SRC14:** [booking reminder scheduler](../../src1/modules/bookings/services/bookingReminderScheduler.ts), [task queue](../../src1/modules/queue/service/TaskQueue.ts), [job consumer](../../src1/modules/queue/service/JobConsumer.ts), [notification service](../../src1/modules/notification/services/index.ts).
- **SRC15:** [user model](../../src1/modules/user/model/index.ts), [dependent model](../../src1/modules/dependents/model/index.ts), [pharmacy customer service](../../src1/modules/pharmacyCustomers/services/index.ts), [patient tracking](../../src1/modules/patientTracking/services/index.ts), [partner model](../../src1/modules/partners/model/index.ts), [reward referral service](../../src1/modules/referral/services/index.ts).
- **SRC16:** Complete module/schema/route inventory plus code-only graph searches for patient/consent/encounter/organization/purchasing/invoice/specimen/hospital/care-task symbols. Targeted fallback code searches found no `specimen`, `accession`, `clinicalReferral`, `consentVersion`, `cashRegister`, `purchaseOrder`, `goodsReceived`, `creditLimit`, `invoiceNumber`, `tenantId`, `organizationId`, `wardId` or `bedId` implementations. Absence claims are limited to these workflows and this checkout, and account for unrelated OAuth/reward-referral symbols.
- **SRC17:** [OTP service](../../src1/modules/otp/services/index.ts), [configuration](../../src1/config/config.ts), [user controller](../../src1/modules/user/controller/index.ts), [Meet routes](../../src1/modules/meet/routes/index.ts), [central routes](../../src1/routes/index.ts). Credential findings were validated by file/key-presence metadata without copying secret values.
- **SRC18:** [package manifest](../../package.json), [lockfile](../../package-lock.json), [legacy entry](../../server.js), [maintained entry](../../src1/index.ts), [pharmacy integration cases](../../test/pharmacy.integration.test.ts). See the prior exact failed-command results in [repository review](REPOSITORY_REVIEW.md).
- **SRC19:** Expanded-scope graph search found inventory/import classes under pharmacy modules and subscription classes under `pharmacySubscriptions`, with no dedicated supplies/warehouse/stock-consumption/software-plan classes. [Inventory model](../../src1/modules/pharmacyInventory/model/index.ts) and [types](../../src1/modules/pharmacyInventory/types/index.ts) use pharmacy/medicine references; [subscription model](../../src1/modules/pharmacySubscriptions/model/index.ts) uses medicine/refill fields. Generic lab/clinic/hospital business workflows are requirements, not inferred implementations. The complete module inventory remains in [repository review](REPOSITORY_REVIEW.md).

## Plan impact

The expanded scope adds private business/module/publication controls, supplies inventory/consumption, business billing and SaaS plan records. M2/M3 deliver clinic/pharmacy and shared supply foundations; M4 adds direct lab operations plus API/panel routes; M5 adds hospital stores and broader business workspaces. M0 must be re-estimated; T0 is its accepted completion. M1 weeks 1–3 are provisional and require a finance-cutover-inclusive re-estimate; rebase later windows if needed. F14 phone access is separately estimated after M1/M2; any M4 pilot is conditional on staffing and its funding/clinical/telecom gates. Indicative pilot post-M0 weeks 11–12 and broader rollout weeks 19–24 replace project-start calendar ranges, subject to the same team and release gates. Existing source is still reuse-and-verify scope; no application features were added by this documentation change.

No arbitrary percentage-complete score is assigned. Runtime correctness, frontend completeness, real-provider behavior and the 100 RPS claim remain unverified. The [performance plan](PERFORMANCE_PLAN.md) defines how to establish that evidence.
