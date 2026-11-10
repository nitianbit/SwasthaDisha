# SwasthaDisha

Active development repository: **[nitianbit/SwasthaDisha](https://github.com/nitianbit/SwasthaDisha)**. Backend, planning, architecture, QA and future product work continue here. See the [repository transition record](documentation/planning/implementation/REPOSITORY_TRANSITION.md) for source provenance, exclusions and verification.

The product review below originated on **8 November 2026** in `nitianbit/ewa_backend`, commit `9ca8b54606581f2158e760cad79aa7b845529184`. Historical reviews retain that baseline; it is not this repository's HEAD.

This existing TypeScript healthcare backend can become Jansetu's daily business-management platform and patient marketplace. Pharmacies, labs, doctors/clinics and hospitals must be able to manage their own in-house sales/services, billing, purchases and inventory, including business received outside the app. Public marketplace listing is optional. Existing pharmacy, doctor, payment and external lab APIs provide foundations; the shared business workspace and non-medicine stock capabilities still require development. **The roadmap describes planned scope. Current implementation evidence is in the M0-A progress log; 100 RPS capacity is not yet verified.**

## Start here

| Document | Purpose |
| --- | --- |
| [M0-A development progress](documentation/planning/implementation/M0_A_PROGRESS.md) | Amended application-sandbox candidate: 161 unit checks pass on Node 22/24; first real activation awaits review of the revised commit. Full application/build gates remain open |
| [Application sandbox activation review](documentation/planning/implementation/APP_ISOLATION_REVIEW_PROMPT.md) | Exact review prompt, source inventory and evidence for the first local synthetic/no-DB smoke; real execution NOT_RUN |
| [Static compatibility results](documentation/planning/implementation/C2_STATIC_RESULTS.md) | Selected source passes with current Mongoose; candidate 9 has eight diagnostics across three migration groups. Root adoption awaits the [existing-server baseline](documentation/planning/implementation/DEVOPS_BASELINE_REQUEST.md) and reviewed migration diff |
| [Operations prospectus](output/pdf/SwasthaDisha_Operations_Prospectus.pdf) / [editable Word](output/docx/SwasthaDisha_Operations_Prospectus.docx) / [source text](documentation/operations/SWASTHADISHA_PROSPECTUS.md) | Illustrated feature prospectus for operations: services, private business workflows, phone access, delivery phases and honest pre-launch readiness |
| [System design and architecture](documentation/planning/SYSTEM_DESIGN.md) | Module/data ownership, tenancy, transactions, pharmacy/lab/booking/payment flows, APIs/events, deployment, migration and release gates |
| [Architecture review and disposition](documentation/planning/ARCHITECTURE_REVIEW.md) | AR-01–AR-36, source rechecks, qualified amendments and remaining implementation/owner gates |
| [Test coverage and late change review](documentation/planning/TEST_COVERAGE_AND_SURPRISE_REVIEW.md) | Decision deadlines, 115 selected scenarios, capability/review traceability and actual execution status |
| [Principal review disposition](documentation/planning/PRINCIPAL_REVIEW_DISPOSITION.md) | Distinct review IDs, evidence-qualified decisions and mapped current/future gates |
| [M0 approvals and start conditions](documentation/planning/M0_START_APPROVAL_STATUS.md) | Both technical approvals received; bounded local M0-A follows the owner request; pre-launch, Node 22, PM2 and Mumbai recorded; MongoDB target facts pending |
| [Deployment baseline](documentation/planning/M0_DEPLOYMENT_BASELINE.md) | Local observations separated from required deployed or pre-launch target facts |
| [M0 implementation approval](documentation/planning/M0_IMPLEMENTATION_APPROVAL.md) | Concrete scope for starting source work, first slice, remaining policy gates and acceptance/release separation |
| [M0 approval review prompt](documentation/planning/M0_APPROVAL_REVIEW_PROMPT.md) | Focused follow-up approval request for the revised design and bounded implementation start |
| [Architecture review prompt](documentation/planning/ARCHITECTURE_REVIEW_PROMPT.md) | Case-free review with its input manifest, evidence rules, adversarial scenarios and output contract |
| [Independent principal architect review prompt](documentation/planning/INDEPENDENT_PRINCIPAL_ARCHITECT_REVIEW_PROMPT.md) | Fresh assessment of late redesign risks, detailed schemas/API contracts, test evidence and documented industry practices |
| [Basic-phone consultations](documentation/planning/PHONE_CONSULTATIONS.md) | Partner-assisted funded top-ups, patient verification, helpline/doctor bridge, charging/reconnect, owners and pilot gates |
| [Daily business operations](documentation/planning/BUSINESS_OPERATIONS.md) | In-house workflows for each business type, optional listing, shared supply inventory/billing and revised delivery scope |
| [Existing, partial and missing capabilities](documentation/planning/CAPABILITY_MATRIX.md) | Second source cross-check of the requested functionality, with evidence and corrections |
| [Requirements and roadmap](documentation/planning/ROADMAP.md) | Six requested service areas, SOP traceability, architecture, phases, acceptance gates and decisions |
| [Repository review](documentation/planning/REPOSITORY_REVIEW.md) | Current capabilities, concrete gaps, launch blockers, all 53 modules and verification limits |
| [100 RPS plan](documentation/planning/PERFORMANCE_PLAN.md) | Workload, proposed SLOs, deployment starting point, concurrency and load-test acceptance |
| [Open source options](documentation/planning/OPEN_SOURCE_OPTIONS.md) | 35-project comparison, package versus API reuse, current license limits and trial gates |
| [Refined planning prompt](documentation/planning/PLANNING_PROMPT.md) | Rephrased request, context contract, reusable prompt and evaluation checklist |

The [shareable PDF](output/pdf/Jansetu_Cross_Checked_Roadmap.pdf) includes the capability cross-check, daily business operations specification, complete roadmap, repository findings, performance plan and open source assessment.

The [system design PDF](output/pdf/Jansetu_System_Design_and_Architecture.pdf) contains the proposed architecture and review prompt. [Domain terms](GLOSSARY.md) and the [proposed architecture decision](documentation/planning/adr/0001-jansetu-core-and-authority.md) define the core vocabulary and authority choice. Design v1.7 incorporates eight supplied review passes and basic-phone consultation scope: principal-review restore/authority, quality/resource, catalogue/price, finance-freeze and assertion-level QA amendments; independently verified patient/contact binding, masked readback/reuse checks and named PIN-key/prescribing approvals; restored cumulative F14 scope, private PIN setup/bounded recovery, staged abuse continuity, same-practitioner follow-up evidence, canonical funding labels, keyed/transient PIN handling, explicit phone funding choices, qualified pharmacy sponsorship reuse, held-fund and prescribing guards, a common cross-destination refund budget, separately estimated F14 phone access, and M0 atomic-wallet/payment/report recovery, resume-before-retry, pre-M2 financial openings, explicit post-M0 scheduling, scoped repositories and case-free reviewer inputs. These are design artifacts; no application fixes or deployments are implemented by them.

The scenario/CSV registers and full principal disposition remain editable companion evidence; v1.7 PDFs include the architecture amendments and the pre-approval M0 scope. The later start-approval ledger/source addendum supersedes their approval/scheduling status only. Neither PDF establishes implementation, M0 acceptance or release approval.

## Agreed product scope

1. Pharmacy in the patient app and at the counter: discovery, prescriptions, stock, checkout, dispensing, pickup/delivery and payments.
2. Retail and wholesale pricing through both app and counter channels, with purchasing, invoices, returns and reconciliation added in stages.
3. Hospital management starting with **OPD, registration, billing, referrals and discharge documents**. IPD, beds, nursing and OT follow later.
4. Lab partners: API integration where available and a panel otherwise; direct/walk-in/referral/app test orders, private tariffs, invoices/receipts, consumable/reagent stock, sample status and verified reports. Both routes feed the same timeline, review and events.
5. Doctor/clinic workspace: own and app appointments, walk-ins, clinical notes, prescriptions, follow-up, fees/invoices/receipts and clinic supplies/consumption.
6. Business/vendor workspace: staff/branches, private catalogue/tariffs, own daily business, purchases/inventory, marketplace publication, documents, statements and support. Hospital OPD includes department stores and usage.

**User-confirmed:** counter sales require connectivity initially; sales during internet outages and subsequent sync are a separate stage. Hospital OPD and billing come first. Payment handling is part of the requested initial commercial scope, even though the SOP labels payments P1.

**Lab model confirmed:** third-party lab vendors may use API integration or the Jansetu lab partner panel. A lab does not need its own API or a full LIS to join. The minimum lab panel is part of the lab milestone; broader vendor commercial self-service follows in stages.

**Daily operations direction:** support standalone management for owned or partner businesses, with optional public listing. Track marketplace, walk-in, phone and import/API origins plus referrals separately. Each balance has one stock authority across channels; private patients, internal prices and stock are not made public. Proposed business subscriptions and marketplace commissions are distinct; pricing and final contracts remain undecided.

The proposed master SOP also adds patient identity, consent, EHR, rural assisted access, care continuity, emergency escalation, grievances, audit and restore requirements. These are launch requirements for the corresponding workflows, not optional dashboard enhancements.

## Recommended direction

Keep a **modular monolith** using the current Express, TypeScript, TypeDI and Mongoose structure. Add organization/branch/module/publication settings, patient identity separate from app login, shared clinical and billing contracts, and focused supplies inventory for labs/clinics/hospital stores. Retain pharmacy-specific safety and one stock/clinical/financial writer; run API and workers separately. Software-plan subscriptions remain separate from medicine-refill subscriptions.

Extend the existing pharmacy and booking modules first. The 35-project upstream review prioritizes CASL for a permission-library trial, Refine Core for a panel trial (react-admin as alternative), k6 for verification and BullMQ only after comparison with hardened Mongo jobs. Evaluate ERPNext/Marley for substantial hospital/backoffice requirements, InvenTree for supplies and OpenELIS for a full LIS through separate integration trials. Select systems only after those demonstrations; no whole-application merge is recommended yet. See the [comparison and license sources](documentation/planning/OPEN_SOURCE_OPTIONS.md), [research notes and method](documentation/planning/oss-research/METHOD.md) and [independent counter-review](documentation/planning/oss-research/counter-review.md).

## Delivery outline

Planning assumption: two backend engineers, two frontend engineers, one QA engineer, part-time DevOps, and available product, clinical, pharmacy and lab reviewers. Estimates include building the missing interfaces; this checkout contains backend APIs and API documentation, not the finished dashboards.

| Stage | Indicative window | Exit result |
| --- | --- | --- |
| Foundation and safety | Re-estimate at kickoff; ends at T0 | Credential/access remediation, reproducible build, safe immutable files, gateway recovery, correctness indexes/readiness, staging and tests |
| Shared business and patient model | Post-M0 weeks 1–3 provisional; re-estimate including financial cutover | Identity/consent, private operations/publication settings, staff/branch scope, billing/item/location contracts and reconciled financial openings before M2 |
| Doctor, pharmacy and supply operations | Post-M0 weeks 4–8 | Direct/app clinic billing and pharmacy/POS; supply purchasing, stock/usage/transfers, returns and cash close |
| Lab business and continuity | Post-M0 weeks 9–12 | API/panel plus direct lab orders, private billing, consumable stock and reports; gated pilot in post-M0 weeks 11–12 |
| Hospital stores and business workspaces | Post-M0 weeks 13–18 | OPD/department stock, vendor private/public catalogue/statements, software-plan records and business reporting |
| Reliability and expanded rollout | Post-M0 weeks 19–24 | Measured 100 RPS across private/business/marketplace workflows, restore/migration, training and staged rollout |
| Basic-phone consultation pilot | Separate estimate after M1/M2; conditional M4 pilot | Partner top-ups, patient verification, voice menu/callback, doctor connection and exact charging; finance/clinical/telecom acceptance first |
| Disconnected sales / deeper HMS | Separate releases after core stability | Device sync proof first; IPD scope and specialist-system decision before scheduling full delivery |

T0 is accepted M0 completion, whose duration must be re-estimated at kickoff. M1 includes financial classification/reconciliation/cutover and must be re-estimated; rebase dependent dates if it extends. Phone scope is not absorbed into these windows. Earlier project-start pilot/rollout ranges are superseded; dates are calculated from T0 using the same assumed team and rechecked dependencies; basic lab/clinic/hospital stock is initial scope, while disconnected sync and advanced IPD/analyzer/QC remain later releases. A pilot must pass 100 RPS for its released-endpoint mix; broader rollout repeats the gate. See the [roadmap](documentation/planning/ROADMAP.md) for dependencies and acceptance.

## Current repository

- Entry point: [`src1/index.ts`](src1/index.ts); routes: [`src1/routes/index.ts`](src1/routes/index.ts).
- Feature modules: `src1/modules/<module>/{routes,controller,validation,services,repository,model,types}`; some use singular `service`.
- Persistence: MongoDB/Mongoose. Existing stock/payment transactions need a **replica set** or suitable managed cluster.
- Integrations: Razorpay, LabStack, Healthians, Google Calendar/Meet, Firebase push, SMS and email.
- Documents currently use local disk and `/api/static/*`; this needs remediation before clinical deployment.
- Existing guides: [TypeScript conventions](README_TYPESCRIPT.md), [pharmacy API](documentation/pharmacy_api_reference.md), [pharmacy hardening](documentation/PHARMACY_HARDENING_IMPLEMENTATION.md), [LabStack](documentation/labstack/README.md), [Healthians](documentation/healthians-api.md).

## Development and verification

M0-A is in progress. The [C2 compatibility packet](documentation/planning/implementation/C2_COMPATIBILITY_REVIEW.md) precedes root dependency, lockfile, runtime and build/start changes. The [C3 fixture contract](documentation/planning/implementation/C3_MONGO_FIXTURE_CONTRACT.md) and complete application-child/provider/file/network admission precede application imports or integration execution.

The available dependency-free unit gate uses Node 22.13+ and creates only owned temporary filesystem fixtures:

```bash
FOUNDATION_NODE="$(command -v node)"
env -i TMPDIR=/tmp "$FOUNDATION_NODE" test/foundation/run.mjs
```

See [foundation usage](test/foundation/README.md) for the eleven-file staging boundary and separate MongoDB smoke check. The amended standalone unit gate passes 161 checks on Node 22 and Node 24; the application-sandbox activation awaits amended review; [migration evidence](output/migration/verification.json) and [M0-A progress](documentation/planning/implementation/M0_A_PROGRESS.md) separate this result from application acceptance.

Legacy application findings remain open: the lock omits the declared `xlsx` dependency, the root default test command is a placeholder, compiled aliases need resolution, and `npm start` targets the legacy `server.js` with absent `src/` imports. The owner selected Node major 22; a supported runtime/ODM target still needs C2 resolution. No root install, type-check, application build or startup was performed for this import.

The pharmacy integration entry currently imports application services before adequate resource admission and can rebuild its configured database. A supplied URI or database named test does not establish ownership; keep this suite unexecuted until complete C3 admission. Required skips remain blocking. Existing API/image helper guides describe effectful utilities and are not authorized test gates.

The current `/health` response establishes process liveness only. Index synchronization and batch migrations retain their separately reviewed fixture/staging/release gates; this migration runs neither.

## Review result and next work

Static review covered the tracked-file inventory, all module boundaries and critical patient, pharmacy, booking, payment, report, authorization and worker paths. It found launch blockers involving committed service-account keys, OTP verification, object access, public clinical documents and incoming webhooks. Detailed evidence and remediation gates are in the [repository review](documentation/planning/REPOSITORY_REVIEW.md).

**Historical application verification:** clean install was blocked by lockfile mismatch; type-check and pharmacy execution were blocked by missing `tsc`/`tsx`. The import preserves those outstanding checks. The new checkout passes the bounded foundation gate only. No live API, payment, restore or load tests ran. **100 RPS remains an acceptance target.** Start implementation with the foundation backlog in the roadmap, then deliver one complete synthetic patient journey before widening the rollout.
