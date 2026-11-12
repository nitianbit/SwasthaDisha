# Delegated prescription and recovery policy decisions

12 November 2026. The owner answered the clinical/finance decision question: “you cna decide yourself”. Root accepts responsibility for selecting product and technical policy. These are the selected development defaults; exact implementation contracts and independent reviews still precede code. This delegation does not make an AI a pharmacist, verify a professional, approve a real prescription, deploy code or authorize real money/stock actions. Qualified human decisions on individual cases remain part of the implemented workflow.

## Selected operating policy

| Boundary | Decision |
| --- | --- |
| Reviewer identity | Use an individual authenticated person, not a shared pharmacy business login. Require current active account, explicit current business/branch review capability and independently verified professional eligibility. OTP verification, customer linkage, business verification and administrator status alone confer no clinical-review authority. |
| Grant/verification authority | Separate membership/capability grants, credential verification and clinical review. No user may verify themselves or gain authority through a profile field. Existing self-editable Admin.permissions is not a trusted capability registry. Provision protected grants through separately reviewed authority/bootstrap controls; absent grants fail closed. |
| Clinical decision | A verified authorized pharmacist approves/rejects the actual prescription. The application and AI do not decide medical validity. Require protected reviewer identity/time/reason/evidence references; bind the decision to immutable document, patient and order-item versions. Reject mismatched, stale, revoked or unknown evidence. Attachment alone never approves dispensing. |
| Progress | Block packed, ready-for-pickup, dispatch and completion unless the required current review is eligible. Keep payment requirements separate. A new order may remain awaiting review, with truthful customer status and a controlled cancellation path; never auto-approve or relabel it not_required to unblock it. |
| Patient/payer | Keep the clinical patient distinct from login, payer, pharmacy customer link and dependent-account ownership. No phone/name merge or assumed guardian consent. Verification and purpose-bound representation are explicit dependencies of clinical enablement. |
| Before handover | Cancellation must establish controlled custody/no handover, claim the transition once, release only the exact live reservation and durably create any money-return obligation. A stock release is not a financial refund. |
| After dispatch/handover | Use a separate return/failed-delivery/exception workflow. Do not put physically dispatched or returned goods directly into saleable stock. Inspection/quality disposition and financial settlement are separate recorded decisions. |
| Legacy ready/out orders | Keep an accountable recovery case/worklist. Reconcile actual custody, reservation and payment facts per order. No blanket completion, database backfill, deletion, forced cancellation or assumed refund. Unknown facts remain blocked for an authorized operator. |
| Funds proof | Treat authorization, capture, settlement, wallet debit, cash collection and refund as distinct facts. The existing paid/refunded labels are not sufficient proof. Bind server-side resource, payer, amount, currency and provider references; ignore client-selected fulfillment context. |
| Refund destination | Return each verified funded component to its original instrument by default. Do not silently replace a gateway refund with application wallet credit. An alternate destination requires a separately recorded, explicit customer choice and verified authority. |
| Amount/budget | Use explicit currency and integer minor units in new intents, with reviewed conversions at legacy rupee boundaries. Reserve outstanding refund budget transactionally against verified capture/debit facts. No rounding, omitted amount, duplicate payout or provider-fee deduction is used to repair uncertain records. |
| Completion/retry | Persist one operation identity and payload hash before effects. Mark refunded only after a matching confirmed financial effect. Pending, failed and unknown are not completed. Reconcile ambiguous provider outcomes; do not generate a new operation key or blindly repeat an unproved effect. |
| Financial/operations roles | Explicit current finance/recovery and pharmacy-operations capabilities authorize their own decisions. Clinical approval does not grant refund authority, and financial authority does not approve a prescription or stock quality. All privileged decisions use protected audit references. |

Existing source requires repair before it can implement this policy: no individual pharmacist membership/credential system exists; authorized gateway payments are currently accepted as paid; pharmacy timeout recovery credits an application wallet instead of a gateway refund; duplicate ledger errors can be mistaken for completed refunds. See [the source baseline](PHARMACY_AUTHORITY_RECOVERY_BASELINE.md). Do not reuse these labels or helpers as trusted proof without their separate hardening contracts.

## Provider facts checked for the policy

Razorpay's payment fetch schema distinguishes authorized/captured states and exposes captured flag, order reference, currency, payment amount and refunded amount in currency subunits. A local paid flag or a valid callback signature alone does not establish the selected application's capture invariant. [Payment API](https://razorpay.com/docs/api/payments/fetch-with-id/), [integration capture guidance](https://razorpay.com/docs/server-integration/python/test-app/).

The Normal Refund API requires eligible captured funds, positive integer subunits and supported payment methods; an omitted amount can request the full refund. Its receipt detects reuse on the same payment. Our adapter must reconcile the existing operation on duplicates/uncertain responses, not assume a universal idempotency header. Exact endpoint/SDK behavior must be frozen before implementation. [Normal Refund API](https://razorpay.com/docs/api/refunds/create-normal/).

## Implementation sequence and retained gates

1. Contract the existing false-paid/false-refunded and privilege-write hazards before using them as authority.
2. Freeze shared person, business membership/capability, professional verification and protected decision interfaces; reuse them across pharmacy and lab roles rather than duplicate identity systems.
3. Implement version-bound prescription review/revocation and guarded progress with separately scoped staff authority.
4. Implement durable cancellation/recovery/refund coordination, exact reservation effects, provider reconciliation and honest client-facing states. Preserve legacy records until a reviewed recovery decision exists.
5. Obtain focused success/denial, index/transaction, replay/race/crash and source-composition evidence under C3. Root dependency/runtime/start adoption still retains C2. Final cross-module integration campaign remains DEFERRED_BY_OWNER.

F1 stays HIGH/open until approval and legacy recovery paths actually exist and the required evidence is accepted. The earlier progress gate only mitigates entry into the dead end. Real clinical/financial/operator provisioning and release approvals remain explicit; no names or credentials are fabricated. We will not stop technical development for another product-policy confirmation, but new policies do not authorize live effects or waive application/security gates. Corporate/HR/hospital expansion remains deferred.
