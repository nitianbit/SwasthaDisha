# Repository review and gap baseline

**Reviewed:** 8 November 2026. **Repository:** `/Users/shubham/Desktop/SwasthaDisha/ewa_backend`. **Branch/commit:** `pharmyx-fixes` / `9ca8b54606581f2158e760cad79aa7b845529184`. The working tree was clean before planning documents were added.

Second source cross-check: [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md) distinguishes existing APIs, partial workflows, missing modules and runtime evidence not available. It clarifies that low-stock queries, counter cash marking, basic prescription fields, assisted in-person booking and specialist disbursal records already exist. Refill-date preferences do not establish an implemented reminder dispatcher.

Lab scope clarification: the existing third-party API integrations remain part of the product. Labs without APIs receive a Jansetu partner panel for assigned orders/sample status/report release; that panel is missing in this checkout. A complete LIS/analyzer system is optional later scope, not the default response to a partner lacking APIs.

Expanded business scope: every pharmacy, lab, clinic/doctor and hospital must manage direct in-house services/sales, billing and inventory, with optional marketplace publication. Current stock classes/models are pharmacy/medicine-specific and refill subscriptions are not SaaS plans. New supplies/consumption, standalone-business and software-plan requirements are tracked separately in [BUSINESS_OPERATIONS.md](BUSINESS_OPERATIONS.md) and the nine added capability checks; no underlying code capability was changed by this scope update.

## Scope and method

Used the codebase-memory graph for architecture, symbol discovery, call tracing and source snippets, followed by source/schema/route reads and a Git-tracked inventory. The graph's recorded head matched the working checkout. Counts below describe the baseline before these planning documents:

| Inventory | Result |
| --- | --- |
| Tracked files | 436 |
| TypeScript files under `src1` | 354 |
| TypeScript lines under `src1` | 62,920, including comments/blank lines |
| Immediate feature/support directories under `src1/modules` | 53 |
| Module route files | 45, plus central route composition |
| Pharmacy database integration cases | 16; conditional on dedicated test MongoDB URI |
| Tracked CI, Docker/Compose/Terraform/process-manager definitions found | None in this checkout |
| Root license file found | None; package metadata declares ISC, which does not establish external-module license compatibility |

Every module is represented in the inventory below. Depth differs: critical identity/access, order/stock, booking/payment, prescription/report and job paths were read in detail; peripheral content/support modules were reviewed structurally through their symbols, routes and schemas. This is a repository-wide planning review, not a line-by-line proof of all 63,000 lines or a penetration test. Current client applications, production settings, database contents and infrastructure were not available in this checkout.

Documentation consulted includes the TypeScript guide, pharmacy product/API/hardening guides and issue lists, automation overview, specialist flow designs/curls, upload flow, LabStack/Healthians notes, health-assessment guide, HIPAA remediation note, test scripts and API collections. Historical docs are not accepted as proof that an issue is fixed or a proposed feature exists. In particular, the HIPAA note references an older OTP literal and a webhook middleware path absent from this checkout; the current findings below use current code instead.

Archives were enumerated without extraction or execution: `Archive.zip` contains 364 entries primarily under `.git`; `remaining.tar.gz` contains 209 entries under files/uploads plus a credential file/log. No application `.ts`/`.js` source entries were identified in either archive. Uploaded documents, logs, sample data and stored API results were treated as potentially sensitive artifacts, not current test evidence. Their contents were not copied into this plan or exhaustively reviewed as patient records.

## What can be retained

| Area | Implementation evidence | Practical limit |
| --- | --- | --- |
| Layered backend | Express/TypeDI controllers, services, repositories, Joi validation and Mongoose models in `src1` | Good extension point; inconsistent authorization must be fixed before adding more roles |
| Pharmacy catalogue and stock | [Inventory model](../../src1/modules/pharmacyInventory/model/index.ts), [reservation repository](../../src1/modules/pharmacyInventory/repository/index.ts), `reserveBatches` | Embedded batches, FEFO, expiry/status filtering and transaction-based reservation exist; full procurement, returns and regulatory dispensing workflow are not demonstrated |
| Shared daily-business foundations | Pharmacy stock/prices/imports, booking fees, manual paid marking and scoped specialist/pharmacy roles | Reuse patterns and proven safety rules; no general lab/clinic/hospital supplies ledger, consumption, department transfer, private/public business settings or SaaS plan domain was identified |
| App and counter orders | [Order service](../../src1/modules/pharmacyOrders/services/index.ts), `create`, `resolveOrderItemsPricing`, [cart routes](../../src1/modules/pharmacyCart/routes/index.ts) | Current code has online/in-store channels and customer/pharmacy buyer distinctions; this is not proof of a complete POS application |
| Money calculations | Order paise fields, HSN/GST snapshots; [payment verification](../../src1/modules/payment/services/index.ts), `verifyAndMarkPaid` | Reuse signature/payment checks; collection, invoice, refunds and settlement still require unified reconciliation and failure tests |
| Doctor workspace API | [Specialist routes](../../src1/modules/specialists/routes/index.ts), [portal service](../../src1/modules/specialistPortal/services/index.ts) | Profile/slots/appointments/status/prescription/history exist; no full dashboard client or unified EHR here |
| External diagnostics | [External booking service](../../src1/modules/externalBookings/services/index.ts), LabStack and Healthians clients | Supports provider booking/report coordination; native accession, specimens, lab signatory and QC are separate capabilities |
| Notifications and asynchronous records | Existing notification idempotency, persisted jobs and pharmacy side-effect state | Useful foundations; worker draining, delivery/retry and outbox durability need work |
| Assisted pharmacy users | [Pharmacy customer service](../../src1/modules/pharmacyCustomers/services/index.ts), `createCustomer` | Reuses a user by phone and creates a pharmacy relationship; still assumes a phone and cannot substitute for a master patient identity |

## Findings that determine delivery order

Priorities here refer to release readiness, not a claim of exploitation. Fixes are proposed; **no application fixes were made in this review**.

| ID / priority | Observed evidence and consequence | Remediation / validation |
| --- | --- | --- |
| R01 / P0 | Three tracked root JSON files are service accounts with non-empty private-key fields: the two `ewa-health-care-firebase-adminsdk-*.json` files and `hybrid-flame-469909-r0-e32a5b65e2b9.json`. Credential values were not printed or reproduced. | Authorized owners revoke/rotate keys, replace file-based secret distribution, sanitize release artifacts and add secret scanning. Removal from the working tree alone does not revoke a credential. Coordinate any history cleanup separately. |
| R02 / P0 | [OTP service](../../src1/modules/otp/services/index.ts), `verifyOTP`, accepts a fixed bypass and skips expiry for it. OTPs are stored directly; the OTP router is publicly mounted. | Remove bypass, secure challenge creation/verification, hash challenges, bound attempts/resends/expiry and test reuse/rate limits. Do not retain a production bypass for testing. |
| R03 / P0 | [Route composition](../../src1/routes/index.ts) exposes `/api/static/*` without authentication. [File controller](../../src1/modules/file/controller/index.ts), `serveFileByPath`, reads local files synchronously and sets one-year public caching. Clinical prescriptions/reports use this namespace. | Separate public marketing media from private clinical documents; object/consent authorization, private/no-store policy, private storage and auditable expiring access. Retire legacy public links through a migration. |
| R04 / P0 | [User routes](../../src1/modules/user/routes/index.ts) inherit authentication but no general ownership guard. [User controller](../../src1/modules/user/controller/index.ts), `ensureHRCanAccessUser`, restricts HR only and returns early for other roles; CRUD passes caller-supplied IDs into the service. | Deny unauthorized list/read/update/delete across users and staff. Audit adjacent dependents/bookings/wallet/notifications/file paths using a complete actor/resource matrix; do not assume authentication supplies authorization. |
| R05 / P0 | [Webhook routes](../../src1/modules/webhooks/routes/index.ts) have payload validation but no origin authentication/signature check. [Webhook service](../../src1/modules/webhooks/services/index.ts) calls `syncBookingFromWebhook`, which can change booking state, fetch reports and trigger wallet refunds. Raw headers/body are stored. | Authenticate per provider contract; durable inbox, dedupe and ordering, redact secrets and minimize retained payloads, asynchronous processing and replay tests. Confirm edge protections separately; none are established by this checkout. |
| R06 / P0 | [Configuration](../../src1/config/config.ts) has a fallback JWT secret and validates only MongoDB URL in production. [Meet routes](../../src1/modules/meet/routes/index.ts) expose OAuth administration/test endpoints without access guards. | Fail startup without required secrets, restrict administration/test routes, use state-bound OAuth callbacks, session rotation/revocation and staff MFA. Verify external effects only in a sandbox. |
| R07 / P0 before clinic expansion | [Booking creation](../../src1/modules/bookings/services/index.ts), `createSpecialistBooking`, saves the booking before separately incrementing slot count; increment errors are logged and ignored. [Slot repository](../../src1/modules/slots/repository/index.ts), `incrementBookingCount`, increments without an atomic capacity predicate. Follow-up benefit, wallet and booking writes also cross failure boundaries. | Atomic capacity hold + booking, scoped idempotency and explicit compensation/reconciliation for failed payments/benefit use. Test concurrent app/walk-in claims and failures after each write. |
| R08 / P0 before prescribing/dispensing | [Order service](../../src1/modules/pharmacyOrders/services/index.ts), `assertPrescriptionProvided`, establishes attachment/pending state; no pharmacist approval endpoint is exposed in the order router. [Portal prescription](../../src1/modules/specialistPortal/services/index.ts), `createAppointmentPrescription`, updates the booking prescription in place. Booking creation checks clinician activity but no verification gate in that inspected path. | Authorized review and fulfilment gate; clinician verification enforcement; signed/finalized clinical versions with amendment trail, minimum necessary pharmacy data and complete medication details. |
| R09 / P0 build gate | Clean `npm ci` fails: lockfile is missing `xlsx@0.18.5` and its dependencies. [`package.json`](../../package.json) starts legacy [`server.js`](../../server.js), whose imports target absent `src/`; maintained code lives in `src1/`. | Repair/review lockfile, pin runtime, establish one supported production build/start command and compiled alias resolution; verify on a clean isolated checkout. |
| R10 / P1 platform prerequisite | [Queue](../../src1/modules/queue/service/TaskQueue.ts) schedules every ten seconds. [Consumer](../../src1/modules/queue/service/JobConsumer.ts) claims one due job per `init`, with a 120-second lease and process-local running flag. `publishNow` can await consumption inline. No explicit dead-letter/retry-count/heartbeat model is present. | Dedicated workers, bounded draining/concurrency, lease recovery, retry/backoff/dead letters, event durability and queue-lag monitoring. Retain idempotent business effects. Compare a hardened Mongo worker with BullMQ only if justified. |
| R11 / P1 clinical foundation | [User](../../src1/modules/user/model/index.ts) and [dependent](../../src1/modules/dependents/model/index.ts) are account/family models. No dedicated consent, master patient, encounter, clinical referral, support case or full lab/hospital operations module was identified. Specialist history is scoped to that specialist's bookings. | Patient/account mapping, consent/authorization, encounter and task model. Add clinical referrals separately from acquisition rewards. Keep historical IDs and payment links during migration. |
| R12 / P1 runtime/scale | [`src1/index.ts`](../../src1/index.ts) listens before the asynchronous DB/backfill initialization finishes. `/health` always returns process success. Schedulers/backfill start inside each API process; file/PDF work uses local disk. | Readiness and graceful SIGTERM; deploy-time migration ownership; separate workers; private shared object storage and centralized observability. Test two instances and worker restart. |
| R13 / P1 operational completeness | No tracked CI/deployment/load-test definition found. `npm test` intentionally fails; `test:api`/curl/Postman results are not a hermetic regression suite. Pharmacy integration tests skip without a test replica-set URI. | CI with type/build, real integration and role/contract tests; safe provider stubs; repeatable load/restore harness. Preserve artifacts distinguishing passed, failed, blocked and skipped. |
| R14 / P0 money recovery | Payment route is client `/api/v1/payments/verify`; `validateSignature` persists failed on bad input, `handleGatewayTerminalStatus` accepts authorized/captured, `createOrder` calls gateway before local save, cancelled/missing contexts are not a safe recovery boundary. Native 35-minute abandonment has no independent gateway reconciliation. Inspected cancellation refunds credit customer wallets and mark refunded. | M0 F11: raw-body webhook plus independent polling/sweep, captured-only collection, durable creating attempt, gateway-aware bounded expiry and cancelled/deleted/surplus-payment recovery. Do not treat wallet credit as gateway refund; inspect actual deployed capture settings separately. |
| R15 / P0 report integrity | `persistReportsOnDeliveredWebhook` writes stable `diagnostics-report-{id}`/Healthians filenames through `persistDiagnosticsReportPdf`, retaining the same public URL; Healthians allows partial reports. Later bytes can replace evidence a clinician already reviewed. | M0 F12/F05: immutable tenant/order/version-scoped bytes and manifest, explicit preliminary/final/unknown provenance, exact-version review and corrected-release task. Legacy overwritten history is unknown, not reconstructed from assumptions. |
| R16 / P1 before affected pharmacy release | Pharmacy keeps embedded batches but eligible expiry compares string dates to UTC today. A local-day expiry policy can differ at the boundary; new per-lot supply indexes cannot be applied as if existing pharmacy were already per-lot. | Preserve embedded medicine batches; define pharmacist-approved local expiry/precision and test reserve/consume/release/list boundaries. M3 parity and any current-path correction precede affected live release. |
| R17 / P1 customer-wallet atomicity | Seven cited booking/external/payment/wallet paths read balance, insert movement and overwrite absolute balance separately; customer refund uniqueness is scoped only to pharmacy_order in the current schema. Concurrent spending/refunds or crash gaps can disagree with movement history. Production index presence and occurrence frequency were not verified. | M0 F11/F13: one customer-wallet operation with stable effect identity across reference types, guarded debit/atomic credit plus movement/local state/outbox in one transaction. Verify wallet-effect and pharmacy+medicine indexes; test concurrent debits, duplicate and legitimate partial refunds, crash rollback and missing-index refusal. |

These additions follow the [supplied architecture review and disposition](ARCHITECTURE_REVIEW.md). Existing gateway lookup occurs inside client verification; the gap is independent recovery, not absence of every gateway fetch. Runtime balances/provider settings and actual incident frequency were not observed.

Existing pharmacy fixes deserve retention: transactional FEFO reservation/order creation, exact allocation release/consumption, archive rather than physical deletes, import-row recovery and payment/notification idempotency appear in source. These should be tested and extended, not described as absent because an older issue file listed them.

**AR-21 source clarification:** PharmacyWalletService.payConsultation is an existing unrouted sponsorship primitive, not the requested patient top-up/phone feature. Its transaction and conditional paid-state write protect against competing paid transitions; the review's blanket absence-of-duplicate-protection claim is too broad. It still trusts the supplied amount and has no dedicated exposed validation/idempotent-result contract. Retain the guard and keep the method unexposed pending F14/P1 and M1 identity work.

## All module dispositions

Counts are tracked TypeScript files, not maturity scores. “Extend” includes verification/hardening of existing code. Modules sharing a row are still separately named and counted. Core rows received detailed flow reads; peripheral rows are structural review and need normal implementation-time validation.

| Module | TS files | Current responsibility / proposed disposition |
| --- | ---: | --- |
| `addresses` | 7 | User addresses/default location; extend ownership and rural administrative geography |
| `admin` | 7 | Administrator records; individual staff/MFA/permission review |
| `appVersions` | 7 | Version policy; retain for client compatibility and staged rollout |
| `auth` | 6 | Role login/OTP/JWT; harden and add membership/session lifecycle |
| `banners` | 7 | Marketing content; retain, restrict authoring, separate public media from clinical files |
| `blogs` | 7 | Authenticated management/public content; retain with editorial permissions |
| `bookings` | 13 | Internal consultation/packages and provider clients; retain, isolate adapters and fix slot/money failure boundaries |
| `camps` | 6 | External camp discovery/order/bulk flows; retain with organization scope and safe bulk retries |
| `common` | 12 | Validation, repositories, error/query/date helpers; retain without assuming generic repository methods enforce authorization |
| `config` | 3 | Module configuration service/types; reconcile with root `src1/config` and settings |
| `corporates` | 8 | Corporate customer association; retain, do not repurpose as universal vendor tenancy |
| `coupon` | 7 | Discount eligibility/usage; retain and test concurrent redemption and money rounding |
| `dashboard` | 5 | Admin/operations summaries including pharmacy health; extend to pending-care and clinical/financial operations |
| `dependents` | 7 | Family/dependent records; map each person to patient identity and representative authorization |
| `email` | 1 | Email delivery; preserve templates, add consent-aware durable retries/minimal content |
| `externalBookings` | 12 | External order/payment/status/report orchestration; retain adapters, harden inbox, retries, report access and reconciliation |
| `externalCatalogItems` | 7 | Provider catalogue overrides/metadata; add scoped vendor proposals/versioned sold-price snapshots |
| `fcm` | 7 | Device/token registration; review ownership, minimize push data and lifecycle/revocation |
| `file` | 5 | Generic upload/local download; replace clinical public-file model with controlled document access |
| `healthAssessments` | 9 | Questionnaires, scoring and recommendations; separate clinical governance/decision support from core release scope |
| `healthTips` | 7 | Health content; retain, review publication roles and clinical content ownership |
| `hr` | 7 | Corporate HR operations; retain limited corporate scope, prevent general clinical privilege |
| `meet` | 5 | Google OAuth/Meet integration/testing; restrict administration and move slow creation into managed work |
| `middleware` | 3 | Authentication/role guards/error handling; add consistent resource/membership checks |
| `news` | 7 | News content; retain and restrict authoring |
| `notification` | 7 | In-app/push notifications and some idempotency; extend preferences, event retries and care-task links |
| `orderHealthChecks` | 7 | Pharmacy-linked health observations; link source/author/patient to clinical record without chemist diagnosis |
| `otp` | 7 | OTP persistence/verification; remove bypass and harden challenge lifecycle |
| `partners` | 7 | Partner profile/type/verification CRUD; extend through organization/staff/assignment services |
| `patientTracking` | 3 | Pharmacy-linked orders/subscriptions/health-check summary; retain scoped view, not a longitudinal EHR |
| `payment` | 7 | Gateway records/verification/context processing/refunds; retain checks, extend robust reconciliation and cash/refund policy |
| `payouts` | 7 | Specialist billing/disbursal records and invoice/receipt assets; distinguish calculation, payable and confirmed settlement |
| `pharmacies` | 7 | Pharmacy onboarding/profiles/verification and public discovery; add branches/individual staff/licence lifecycle |
| `pharmacyCart` | 7 | Actor-scoped cart and checkout; retain fresh pricing checks and stock transaction boundary |
| `pharmacyCustomers` | 7 | Pharmacy-to-user relation and assisted creation; replace phone-as-identity assumption with patient mapping |
| `pharmacyInventory` | 7 | Embedded batch stock, allocation and adjustments; retain, extend purchasing/returns/UOM and measured query performance |
| `pharmacyInventoryImports` | 6 | Preview/commit/retry/error download and cleanup; retain recovery, move large work off API |
| `pharmacyMedicines` | 8 | Catalogue, tax/prescription flags, discovery/name migration; retain and govern master data/units |
| `pharmacyOrders` | 9 | Online/in-store, retail/pharmacy buyers, payments and side effects; extend invoices/review/returns/shift closure |
| `pharmacySubscriptions` | 7 | Recurring medicine/refill records and reminder preferences; retain, add missing due-date dispatch and separate clinician follow-up |
| `pharmacyTracking` | 3 | Pharmacy sales/customer/subscription summaries; retain with branch/vendor scope and rollups if needed |
| `pharmacyWallet` | 7 | Prepaid pharmacy wallet/ledger/top-up and atomic helpers; preserve transaction/idempotency and reconcile to collection/settlement. Unrouted payConsultation transaction conditionally guards booking paid but trusts req.amount. Before exposure require authoritative server fee, payment validation/durable idempotent result and eligibility; no lab/hospital funding or phone-only flow is established |
| `queue` | 7 | Persisted scheduled jobs/consumers; harden worker execution and recovery before scale-out |
| `referral` | 5 | Acquisition codes/reward earnings; retain separately from new clinical-referral domain |
| `settings` | 3 | Settings types/services; consolidate authoritative config ownership and production validation |
| `slots` | 7 | Specialist/package capacity; add atomic holds, doctor/branch ownership and app/walk-in race tests |
| `sms` | 1 | SMS delivery; add consent/local-language/delivery control and abuse protection |
| `specialistPortal` | 2 | Doctor-facing use cases/validation; extend walk-ins, shared EHR, review, note versions and finance visibility |
| `specialists` | 7 | Credentials, self routes and statistics; enforce verified activation/assignment and staff delegation |
| `user` | 7 | Account/demographics/corporate association; fix object access, keep account distinct from patient identity |
| `wallet` | 7 | User wallet/transactions/recharge; verify all debit/credit/refund failure boundaries and ownership |
| `webhooks` | 7 | Raw callback storage and booking sync; authenticate, dedupe/order and decouple processing |
| `wellnessPackages` | 7 | Internal service/packages; retain governed catalogue/tariff and appointment compatibility |

Supporting paths reviewed: `src1/index.ts`, central routes, config/container, DB connection, logger, Firebase integration structure, index synchronization and batch migration scripts, root package/TypeScript/environment setup and test/documentation assets. No private keys, patient payloads or log contents are included in this report.

## Verification record and practical limits

| Check | Observed result |
| --- | --- |
| Git and graph baseline | Same commit; working tree initially clean |
| Dependency installation, restricted environment | DNS resolution blocked registry access on initial attempt |
| Dependency installation with network access | `npm ci --ignore-scripts --no-audit --no-fund` failed with EUSAGE: missing `xlsx` and transitive entries in lockfile |
| `npm run type-check` | Blocked: `tsc: command not found` after failed install; no compilation conclusion |
| `npm run test:pharmacy` | Blocked: `tsx: command not found`; none of the 16 cases executed |
| Database/provider/payment/live API checks | Not run; no production endpoints or databases were exercised |
| Load/failover/restore checks | Not run; 100 RPS, availability and recovery targets remain unverified |
| Source changes | Documentation only; no secret rotation, migration, source import or security fix performed |

The findings are enough to sequence implementation, not to approve production use. Re-run the baseline after F01 and retain actual test results. The [roadmap](ROADMAP.md) maps every blocker and requested service area to delivery work and acceptance.
