# Daily business operations and optional marketplace

**Product direction:** support pharmacies, laboratories, doctors/clinics and hospitals as daily business-management customers, including sales and services received outside the Jansetu app. **Planning update:** 8 November 2026. **Code baseline:** `9ca8b54606581f2158e760cad79aa7b845529184`; the capabilities below are requirements, not new implementations.

The platform has two connected uses: private business operations and the patient-facing marketplace. A business can start with its internal workspace and later enable approved marketplace services. The same model supports Jansetu-operated facilities and independent partners; ownership is recorded separately from the services a business provides. See the [roadmap](ROADMAP.md) and [current capability evidence](CAPABILITY_MATRIX.md).

## 1. Scope decisions and working rules

| Decision | Planning rule |
| --- | --- |
| Daily operations | Each business can manage its own patients/customers, walk-ins, appointments/orders, invoices, receipts, purchases, stock, returns and staff within enabled modules. A Jansetu-generated order is not required. |
| Optional public listing | Internal operations do not require a public marketplace listing. Publication is explicitly enabled for approved branches/services; disabling discovery does not discard accepted bookings or private records. |
| Business types | A business may operate a pharmacy, lab, clinic, hospital or several of these. A hospital's pharmacy/lab can be departments under that business; independent suppliers retain their own business ownership. |
| Channels and attribution | Record the primary origin channel: marketplace app, walk-in, phone or approved import/API. Record a referring person/business independently, since a referral may arrive through any channel. An online payment does not automatically make a walk-in a marketplace sale. |
| Operations versus integration | Marketplace participation and API availability are separate choices. A listed lab can use its APIs or the panel; an unlisted lab can use the panel for its own direct customers. |
| Stock authority | One authoritative owner for each business/branch/item/location balance. App, counter and procedure consumption affect that owner's stock; an external ERP-owned balance remains an integration/read projection unless authority is deliberately transferred. |
| Patient identity and privacy | A patient can have one permanent Jansetu identity plus business-local references. An internal customer does not need an app login or public profile. Record linkage does not grant another business access to clinical history. |
| Basic-phone access | Approved pharmacies/labs/hospitals can identify a patient and fund a consultation account under the selected arrangement; a basic-phone helpline reaches doctors without an app. Patient identity, partner funding, care consent and clinical access remain separate. See PHONE_CONSULTATIONS.md. |
| Adoption and continuity | Make daily workflows useful through onboarding/imports, fast counters, connected records, worklists and reports. Include authorized export, backup and recovery as normal capabilities. |
| Commercial model | Proposed: business software subscription plus separately configured commission on marketplace-attributed transactions. Rates, plans, collection responsibility and settlement contracts remain decisions to approve; do not assume commission on direct business. |

The optional-marketplace rule is the planning default adopted from the preceding discussion. Commercial prices, feature packages and final invoicing entities remain open decisions.

## 2. Workspace requirements by business

| Workspace | Daily services and sales | Inventory and purchasing | Financial and operations views |
| --- | --- | --- | --- |
| Pharmacy | Walk-in/app sales, retail/wholesale entitlement, prescription review, dispensing, pickup/delivery and returns | Medicines, batches, expiry/recall/quarantine, UOM, suppliers, purchase/receive, reservation, transfer and approved return/restock | Sales invoice/credit note, cash/online receipts, shift close, supplier balances, margin and stock movement |
| Laboratory | Direct/walk-in/referral/app test orders, appointment/collection worklist, sample status, original/corrected reports, signatory release and clinician review | Reagents, kits, vials and consumables; purchase/receive, units, lots/expiry where applicable, consumption, wastage and stock count | Test invoice, receipts/refund, receivables, referral/marketplace attribution, turnaround backlog and partner statement |
| Doctor / clinic | Own appointments, walk-ins and app visits, clinical records, prescriptions, procedures, fees and follow-up | Clinic consumables and supplies; receipt, use against visit/procedure, wastage, stock count and low-stock worklist. Medication dispensing uses the pharmacy-specific workflow when enabled | Visit/procedure invoice, receipts, day-close, pending dues and separate marketplace earnings/settlements |
| Hospital | Registration, reception/OPD queue, consultations, procedures, diagnostics/pharmacy coordination and service billing | Central/department stores, receipt, issue/receive transfers, consumption, count/adjustment, lot/expiry where applicable; medication stock retains pharmacy rules | Department tariff/invoice, receipts/refunds, cashier close, purchases/payables, department usage and OPD operations. IPD/nursing/OT remain later scope |

Basic lab/clinic/hospital inventory is now initial business scope. It must not be deferred under the label of optional full LIS or future IPD. Analyzer interfaces, QC/calibration, instrument-generated consumption, full general ledger accounting, insurance/claims and advanced asset maintenance remain separate extensions unless specifically selected.

### Typical daily journeys

- **Pharmacy:** receive a supplier batch, sell at the counter and through the app, reconcile the same stock, then close cash and process an authorized return.
- **Lab:** register a direct patient without an app account, book a test, collect a sample, post approved supply consumption, receive payment and release a verified report. An app-origin order uses the same lab worklist and record rules.
- **Clinic:** add a walk-in, record a visit/procedure, issue applicable supplies, take a payment, print/send an authorized receipt and schedule follow-up.
- **Hospital:** register an OPD visit, issue supplies from a department store, collect the service charge, receive an internal stock transfer and reconcile the cashier's day.

## 3. Shared product and data boundaries

| Concept | Required meaning and rules |
| --- | --- |
| Business, branch and department | Scope staff, finances, catalogue and records by trusted membership. A branch can have multiple stock locations or departments without becoming an unrelated business. |
| Enabled modules | Configure clinic, lab, pharmacy, hospital and inventory capabilities explicitly. Do not assume every business needs all modules or build one identical screen for every role. |
| Private and public catalogue | Keep internal service/items and private tariffs separate from approved marketplace publication. An internal price or stock quantity does not become public by enabling a staff workspace. |
| Order/visit origin | Preserve source, business, branch, creator, external reference and referring party. Keep commission attribution separate from price class and payment method. Retain legacy online/in-store fields through compatibility mapping. |
| Item and service | A billable test/consultation is a service. A vial, glove or reagent is an inventory item. A service can consume items without selling each item separately to the patient. |
| Inventory location and lot | Identify item, stock unit, business/branch/location, optional lot/batch/expiry and quality status. Reagents may use fractional units such as mL; define conversion, decimal precision and rounding explicitly instead of inheriting integer medicine quantities. Medicine prescription/allocation rules remain in the pharmacy boundary. |
| Stock movement | Append attributable receive, reserve, release, consume, sale, return, transfer, waste, count adjustment and reversal records. Balances must reconcile to movements; edits cannot silently erase previously accepted stock effects. |
| Service consumption | Link a consumption record to its visit/test/procedure and authorized actor. Start with explicit quantities or an approved configurable usage list; allow documented differences and waste. Replayed status/report events cannot consume stock twice. |
| Billing and collection | Distinguish service/product invoice, credit note, cash/gateway receipt, outstanding balance and refund. A completed clinical service or report release is not itself evidence of payment. |
| Business and platform finance | Separate the business's customer/supplier balances from Jansetu's subscription invoices and marketplace commission/settlement records. Cash collected by a business is not a receipt into Jansetu's bank account. |
| Software subscription | Track plan, enabled modules/limits, billing period and subscription state separately from medicine-refill subscriptions. Start with reviewed plan assignment and billing records; automated recurring collections can be a separate integration. |

### Architecture extension

Retain the existing pharmacy services, FEFO transactions and safety rules. Introduce a focused non-medicine supplies inventory boundary for lab/clinic/hospital stock and a shared purchasing/billing contract. Share movement/idempotency primitives only where doing so preserves domain rules; do not replace the pharmacy engine with a generic item table before parity tests pass.

`organizations` owns business/branch/staff membership and module/publication settings. `billing` owns business invoices/receipts/credits. Proposed `suppliesInventory` owns non-medicine item/location/lot/movement and consumption. `procurement` owns supplier/purchase/receive references. Existing pharmacy modules retain medicine stock authority. Proposed `businessSubscriptions` owns software-plan records; existing `pharmacySubscriptions` continues to mean recurring medicines.

One order/visit can reference one commercial invoice, payment records, authorized stock movements and clinical documents without merging those states. Each aggregate has one authoritative writer. Integration adapters may read projections or issue commands to that writer rather than independently adjusting balances.

## 4. Laboratory API and panel rules under the expanded scope

1. Keep **API-connected third-party labs** and **panel-managed third-party labs**. Lack of an API does not prevent participation or force a complete LIS installation.
2. The panel now handles the lab's direct/walk-in/referral work as well as Jansetu assignments. Add lab-local registration, service tariffs, invoices/receipts and consumables inventory to the earlier order/report panel scope.
3. Record origin separately from `fulfillmentMode: api` or `panel`. A direct panel order must not automatically create a duplicate order at an API provider. An app order routed through an API must retain its provider reference.
4. Choose the owner of each stock/result/order resource. If the lab's existing system owns reagents, use a permitted integration projection; if Jansetu owns supplies stock, post its movements only in Jansetu. A provider callback cannot independently decrement the same balance twice.
5. Both routes preserve report verification, original/amended versions, clinician review, critical-result acknowledgment and the same durable release events. Internal lab use does not grant unrestricted access to another business's patient records.
6. Manual or configured supply consumption is in scope. Analyzer connectivity, automatic instrument consumption, QC and calibration stay optional later integrations.

### Basic-phone consultations and counter top-ups

[The phone-channel specification](PHONE_CONSULTATIONS.md) defines registration and patient/PIN verification, funded partner top-ups with SMS/printed receipts, language selection, disclosed fixed-fee reservation, doctor bridge/callback, no-answer release and dropped-call reconnect. Shared phones do not imply shared balances/charts; no-phone patients retain assisted/caregiver access. Reception/cashier permission does not confer clinical access or PIN reset. Partner cash is reconciled separately from platform-held funds; a top-up is spendable only through the approved funding contract. This is F14, separately estimated after accepted M1/M2 foundations and finance/legal/clinical/telecom decisions, with a conditional staffed M4 pilot. P1 chooses Partner-paid consultation, Consultation-only balance or General patient wallet before F14 sizing. Existing unrouted pharmacy sponsorship is qualified reuse with a paid-state guard; pricing, validation and durable idempotency remain prerequisites. PIN provider payloads are transient, wallet debits exclude held funds, and clinical UI/backend enforce mode/type prescribing with disclosed referral-only fee policy. Private patient/caregiver PIN setup and bounded recovery, independent contact proof, staged abuse continuity and same-practitioner/prior in-person follow-up evidence are explicit F14 gates. The backlog retains every original top-up/receipt, queue/capacity, one-charge/reconnect and authorized outcome deliverable alongside these controls. No new M0 dependency or automatic ABHA prerequisite is added.

## 5. Commercial, access and lifecycle decisions

- Keep subscription charges for using the software distinguishable from marketplace commissions. Proposed default: direct orders have no marketplace commission; a business software subscription may still apply. Final rates and eligibility need a commercial decision.
- Record who issued the customer invoice, collected the payment and owes the refund. Preserve financial-period numbering, original invoices and linked reversals. Finance must approve the configured seller/invoice entities and tax treatment before release.
- API capability does not determine the business's subscription or public listing. A business may buy internal modules and selectively publish services later.
- Revoking marketplace listing stops new public discovery/bookings according to policy; accepted orders, refunds, support cases and authorized record access still require completion. A subscription state change cannot silently delete clinical or financial history.
- Require individual staff accounts, role/branch/location scope, authorized exports, joiner/leaver controls and reasons for price/stock/financial overrides. Reception, cashier and inventory access do not automatically grant clinical editing rights.
- Import private patients, item/service masters, opening balances and receivables using reviewable templates and deterministic import keys. Never assume phone equality authorizes a patient merge, or invent clinical consent, lot/expiry or payment evidence during import.

**Architecture-review clarification:** preserve existing platform-configured gateway collection and wallet-credit evidence during migration; record customer wallet liability and platform-business dues, rather than labelling a wallet credit as an original-method refund. M0 applies atomic wallet effects and factual classification without choosing new refund destinations; finance approves the future account map and reconciled opening balances before M2 business posting. Lab reports preserve preliminary/final/unknown completeness and immutable corrected versions; M0 fixes current gateway recovery and report overwrite before later suite expansion. Counter price overrides remain authorized, limited and actor/reason-audited with server-recomputed totals.

## 6. Scope, sequence and acceptance

M0 duration is **re-estimate at kickoff**. T0 is accepted M0 completion; subsequent windows below are relative to T0, not project start. The limited pilot is tentatively post-M0 weeks 11–12 and expanded rollout weeks 19–24, using the same team and dependency assumptions. M1 must include financial classification, review and cutover in its estimate; rebase downstream windows if it extends. F14 phone work needs a separate staffed estimate and is not included in the stated windows. Earlier project-start estimates are superseded; recalculate dates after M0, shared contracts and the first import rehearsal.

| Stage | Expanded deliverable |
| --- | --- |
| M0, re-estimate at kickoff; ends T0 | Build/security/access, current-flow payment recovery, immutable-report bridge, create-only correctness-index/readiness gates and safe staging |
| M1, post-M0 weeks 1–3 provisional; re-estimate including financial cutover | Business/branch/membership, standalone/publication settings, patient identity/consent and common billing/item/location contracts |
| M2, post-M0 weeks 4–6 | Doctor/clinic appointments, clinical workflow, direct/app attribution, fees, business invoices and receipt foundations |
| M3, post-M0 weeks 4–8 | Pharmacy/POS plus supplies inventory/purchasing, location balances, manual consumption, returns and cashier close; integrates M2 billing |
| M4, post-M0 weeks 9–12 | API/panel lab routes plus direct lab orders, billing, consumables, report release and care continuity; gated pilot |
| M5, post-M0 weeks 13–18 | Hospital OPD/department stores, broader vendor workspace, subscription-plan/billing records, private/public tariffs and business reporting |
| M6, post-M0 weeks 19–24 | Cross-business regression, migration/restore, useful 100 RPS mixed load and staged rollout |

F14 phone pilot follows M1/M2 and P1–P3 acceptance; joining M4 is conditional on staffing/re-estimation. The separate phone specification owns the full acceptance list.

Before each business type goes live, demonstrate:

1. An unlisted business registers a direct customer and completes an in-house service/sale without public app listing or patient app login.
2. Public discovery and other businesses' searches do not expose that business's private patients, prices, stock, invoices or reports.
3. App and direct orders use the correct business/branch, tariff and source. A refund, referral or payment retry does not rewrite the original attribution or duplicate commission.
4. Simultaneous sale/consumption/transfer commands cannot overdraw stock; warehouse transfer dispatch/receipt and stock-count adjustments reconcile to the movement history.
5. A lab test or clinic procedure posts approved consumables once, including documented waste/reversal. Consumables included in a service price are not billed again unintentionally.
6. Sales, receipts, credits, outstanding balances, supplier payables and cash close reconcile. Subscription bills and marketplace settlements remain separately identifiable.
7. A business can enable or disable eligible public services while completing existing orders and preserving authorized records.
8. Imports/replays preserve source IDs, opening quantities, lot/expiry provenance and financial totals. Staff revocation, export, backup and restore behave as documented.

Use the [performance plan](PERFORMANCE_PLAN.md) for a workload that includes private business operations as well as marketplace requests. No software implementation, subscription charging, partner onboarding or production migration is performed by this documentation update.

**Phone contact authority (AR-25):** a counter-entered number stays unverified until handset possession and independent patient/caregiver binding are approved under M1 identity policy. Cashiers cannot self-approve contacts, set/recover PINs or obtain protected verification priority; legitimate shared phones remain supported. The disposable setup slip shows the masked contact for readback. Follow [phone3.4](PHONE_CONSULTATIONS.md#34-contact-verification-and-patient-binding-ar-25), including staff-number/unrelated-patient reuse review and separate key-lifecycle approvals in P3.

**v1.7 current-path and restore contracts:** shared catalogue authority is separate from local stock/offer permission; quantity commands retain quality holds, lot-based applicable price ceilings and confirmed quote versions govern sales, and appointments bind the correct practitioner/resource interval. Restored stale authority/stock/money is held behind D9 admission and per-effect reconciliation. D1/D4 precede M1 billing/settlement contract freeze, then M2 posting. See [principal review disposition](PRINCIPAL_REVIEW_DISPOSITION.md) and [M0 approval scope](M0_IMPLEMENTATION_APPROVAL.md).
