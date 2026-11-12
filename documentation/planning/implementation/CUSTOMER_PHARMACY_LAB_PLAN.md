# Current priority: individual customers, pharmacy and labs

Owner direction: 12 November 2026. This priority supersedes the all-business-module ordering for new work; historical approvals, failures and scope records remain unchanged. Status: execution plan and discovery in progress, not module completion or release approval.

## Scope and baseline

Active branch `m0/customer-pharmacy-lab-focus`, restored from committed integration `7df9121440813dec14cd4c57d347ee20982c3ec7`. Durable worktree: `/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab`. The original checkout remains on `m0/f01-app-isolation`; preserve its six staged files, exact staged patch and eleven handover files. Prior temporary worktrees are missing. Committed branches/evidence remain in Git; uncommitted cursor/runner edits and their uncommitted QA are not assumed recoverable or accepted. Reconstruct from exact archived source/messages only with explicit provenance, then review and verify again. Do not silently replace lost evidence with reconstructed PASS records.

The last accepted focused API result is90 groups/33 unsafe source variants at historical5901bc20, not coverage of every file in7df9121. Medicine/inventory/HR changes subsequently integrated are source-reviewed; their separate runtime gaps remain open. Historical inventory runtime3 failed; medicine data209 passed and flow-a timed out without a summary. Consumed approvals cannot be replayed. Claude login/review remains deferred, with no auth polling or claimed Claude approval.

## Included and deferred

| Priority | Included completion scope | Deferred work |
| --- | --- | --- |
| Individual customer | Personal account/login/contact recovery; patient/dependent/caregiver authority and consent; addresses; catalogue/service discovery; individual orders/bookings; payment/status/cancellation/refund visibility; authorized prescriptions/reports; notifications, receipts and support needed by these flows | Corporate enrollment, employee benefits, HR dashboards and corporate billing |
| Pharmacy | Own-business staff/access; private and marketplace catalogue/offers; prescription review; embedded-batch inventory and quality holds; reservations/dispensing/returns/recalls; app and counter retail, approved wholesale; purchases/receipts/stock reconciliation; invoices/collections and order lifecycle | Hospital dispensary integration; optional later advanced integrations |
| Labs | API-connected and panel-managed labs; assigned staff/signatory access; private/direct/walk-in and marketplace tests/packages/orders; sample collection/rejection/recollection; report upload/quarantine, verification/release/corrections; patient access/review tasks; clinician-approved critical-result escalation and acknowledgment; billing/payment/recovery; basic supply purchasing/consumption/waste | Hospital LIS integration and optional analyzer/QC/instrument automation |
| Shared foundation | Identity/resource ownership, business/branch isolation, consent, units and financial effects, provider authenticity/idempotency/reconciliation, private immutable clinical documents, audit and supported client contracts required by the three included modules | New standalone hospital, corporate or HR features |

Individual customer is a buyer acting outside an employer-sponsored arrangement; the patient may be a different person. Pharmacy/lab business ownership and staff isolation still apply: an employer corporate association is not a business tenancy identifier. Marketplace participation remains optional; direct business is not dropped to make the scope look complete. Preserve existing consultation compatibility where customer journeys use it; a new full doctor workspace is not added to these three implementation lanes.

Deferral means stop new implementation/expansion and acceptance work for that module. Preserve already merged corporate/HR protections; do not remove authorization, disable APIs, migrate records or change production as a side effect. Historical broad115 status is retained; add a scope applicability map distinguishing included, shared dependency and explicitly deferred scenarios. Never turn blocked cases into PASS or silently remove required ones.

## Parallel ownership and dependencies

| Lane | Owner/write surface after per-slice admission | Can advance concurrently | Done evidence |
| --- | --- | --- | --- |
| Customer | Customer-facing auth/profile/dependent/address/client adapters and owned tests | Read-only discovery now; implementation after shared actor/contact/patient contracts freeze | Owned-person positive flows; unrelated-person/role denials; consent/recovery and documented supported-client behavior |
| Pharmacy | Pharmacy catalogue/inventory/order adapters and owned tests | Source discovery/decision-free containment in parallel; stock/money writers after transaction/index/unit contracts | Prescription and quality controls; actual reservation/dispense/release/return races and reconciliation; app/counter journeys |
| Lab | Lab catalogue/order/sample/report adapters and owned tests | Discovery, provider contract capture and scoped containment in parallel; callback/money/release effects after exact contracts | API and panel journeys; assignment isolation; authenticated replay; immutable report correction/access; payment and supply reconciliation |
| Lead/shared | Shared interfaces, booking/payment services, clinical files, root dependencies, fixture admission, integration and evidence | One shared writer. No three domain writers editing the same booking/payment/file modules | Compatible composition, exact source/evidence bindings, admitted actual checks and independent reviews |

Use four native agents total: lead plus up to three bounded workers on isolated branches/worktrees. Each assignment names ownership and tells authors to preserve others' work. Freeze shared identity, order/status, money-unit/effect, stock and report interfaces before dependent writers. Domain discovery and independent contract preparation may overlap; this does not authorize racing writers against unfinished shared state. Rotate slots to two independent nonauthor Standards and Spec reviews. Ruflo metadata is coordination only; no hosted workers or fabricated model reviews.

## Execution sequence

1. Restore committed baseline in durable storage (done); inventory surviving commits versus missing uncommitted work; preserve original staged/handover state. Complete three source/requirements audits without application execution.
2. Create requirement-to-journey/source/evidence coverage rows for all included original requirements from ROADMAP U1/U2/U4 and applicable patient/consent/SOP requirements, BUSINESS_OPERATIONS and SYSTEM_DESIGN. Every row has actor, ownership, request/state transition, success/denial, client/UI expectation, evidence status, dependency and owner. Existing code is not accepted behavior. Record whether customer/pharmacy/lab client sources exist before assigning UI implementation; missing clients stay a visible completion gap.
3. Pick the smallest reviewed decision-free source slices from those audits. Finish shared customer authority/privacy/provider containment required by included journeys first. Freeze actor/field/error/state compatibility and obtain actual two preimplementation decisions before application edits. Investigate runtime fixture failures independently; avoid repeating unchanged discovery or completed campaigns.
4. Run admitted unit/use-case and isolated API/DB/provider-recording checks for each changed boundary. Critical corrections need real positive/negative controls and reintroduced-defect detection. Stock/money paths require concurrency/crash/replay/index evidence; callback/report paths require authentication, provenance, immutable version and forbidden-access evidence. Do not run app imports, legacy suites or providers without complete pre-import C3 admission. Root dependency/build/start adoption retains C2 conditions.
5. Integrate independently reviewed slices. Execute customer-to-pharmacy and customer-to-lab journeys, including direct/unlisted business and no-phone patient/caregiver where required by original scope. Obtain supported-client evidence and named clinical/pharmacist/finance/privacy approvals for applicable policies. Share the exact completion review prompt and evidence commit here after each module milestone.

No calendar-week advancement is credited merely because a draft or internal review exists. The earlier two-month target is a planning objective; a revised estimate follows requirement coverage and unresolved owner/provider/client facts. Corporate/HR/hospital deferral does not prove these three modules fit an eight-week delivery date.

## Completion gate

Each included module must have: complete original-scope coverage with explicit dispositions; frozen role/field/state/provider contracts; implementation and supported user/client flows; meaningful actual success/denial and changed-defect controls; financial/stock/document reconciliation where applicable; two direct independent source/composition reviews; reproducible source/build/test evidence under current gates; no unresolved critical included-scope defect. Source-only, fake-only, NOT_RUN, failed and owner-blocked evidence remain separately labeled. Backend candidate completion, supported-client acceptance and production release are separate decisions. Deployment, real messages/payments/accounts, protected logs and clinical/finance/release decisions remain specifically gated.

## Review

Use CUSTOMER_PHARMACY_LAB_REVIEW_PROMPT.md. Today the prompt supports a scope/readiness review. It can become a completion review only against a concrete later candidate with actual module evidence. No module is declared complete by this document.
