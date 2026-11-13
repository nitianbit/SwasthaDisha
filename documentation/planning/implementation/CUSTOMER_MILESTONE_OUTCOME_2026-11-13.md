# Existing customer milestone — implementation and handover

Date: 13 November 2026. Branch: `customer/milestone-2026-11-13`. Baseline: `9c8d1d8f6ecda8d0832f9294c4b1b7a6fdf7077c`. This is a local implementation candidate with focused recording evidence, **not acceptance of the complete customer module or a production release**. Nothing was pushed or deployed.

The owner resumed only this milestone and chose existing flows first, with BetaCura/hybrid later. [Scope](CUSTOMER_MILESTONE_SCOPE_2026-11-13.md), [API behaviour](CUSTOMER_MILESTONE_API_2026-11-13.md), and [copyable review prompt](CUSTOMER_MILESTONE_REVIEW_PROMPT_2026-11-13.md).

## Delivered source

| Area | Result | Remaining boundary |
| --- | --- | --- |
| Signup/login | Existing either-phone-or-email flow reused; further login work explicitly deferred | No new native login, OTP/session or client acceptance claimed |
| Profile | Own/admin edits; customer replacements of stored phone/email ignored while other fields save; missing contact may be added; admin can replace; alternate email verification cannot bypass that rule | Current contact indexes are nonunique; cross-account concurrent uniqueness and broader OTP-purpose/session behaviour remain open |
| Addresses | Existing owner-scoped address editing reused | Unchanged source; no new HTTP/client campaign |
| Booking authority | Signed customer identity/corporate association; owned active dependent before creation effects; owned list/detail paths | Real middleware, Joi, client and deployed identity still need admitted execution |
| Ordinary booking effects | Recorded private slot/payment/wallet/coupon/follow-up effects; transactional local create/confirm/cancel/reschedule; setup expiry/retry; retained history; late capture cannot resurrect cancellation | Native MongoDB transactions, indexes, concurrency and historical reconciliation are not proved by recording adapters |
| Ordinary cancellation | Legacy paid-only IST 24-hour cutoff, 48 hours on Mondays; one recorded local refund to internal wallet, no invented zero-money refund; reminder/meeting cleanup retry | Postcommit notifications/Meet are not durable exactly-once delivery; historical unproven records return 409 |
| Payment details | Pending orders excluded from actual paid totals; bounded captured/refunded attempts and owned completed ledger totals; explicit internal-wallet refund destination | Repository reads are sequential, not a proved consistent snapshot |
| Existing external bookings | LabStack/Healthians retained; both included when list integration omitted; owned sanitized local detail; durable provider attempt, bound result tokens, truthful paid/pending state and genuine cancellation acknowledgement before shared settlement | Unknown provider outcomes require operational reconciliation; no authenticated automatic status/report propagation is delivered |
| Two shared customer wallet writers | Balance and ledger commit together; captured recharge credit has payment-bound replay proof, including processed-repeat verification | No global historical ledger/funding-budget/coupon or manual-command replay guarantee |

The public external callback lacked a verified provider-authentication contract. It now records an untrusted observation instead of changing authoritative status, money or reports. This is a material functional containment: automatic live provider progress/report delivery remains unfinished. A timeout/missing provider ID also remains unknown; the candidate refuses an automatic duplicate create or premature refund. Reconciliation flags do not constitute an implemented operator recovery workflow. Existing public status reads return recorded local state.

## Evidence and actual limits

All new executable checks use clean-environment, pinned Node 24.19.0, exact read grants and closed recording ports. They do not import actual application dependencies, models, SDKs or configuration. Simulated transactions, rollback, callback retry and serial interleavings are source-behaviour checks, not native MongoDB isolation/race proof. No root install/build/start, legacy integration campaign, database/provider access or patient/document data was used.

| Evidence directory under `output/qa/customer-milestone/` | Actual measured result |
| --- | --- |
| `profile/` | 29 service cases, 29 restored, 7 controller cases; four weakening controls detected |
| `email-verification/` | 16 cases and 16 restored; four weakening controls detected |
| `booking-authority/` | 44 cases and 44 restored; four weakening controls detected; historical controller hash binding, with later external additions reviewed/tested separately |
| `ordinary-local/` | Historical exact-source run: 41 cases and 41 restored; four weakening controls detected; tested source/runner snapshot retained |
| `ordinary-local-composition/` | Final shared PaymentService composition: 41 cases and 41 restored; four weakening controls detected |
| `payment-details/` | 33 cases and 33 restored; three weakening controls detected |
| `wallet-writers/` | 23 cases and 23 restored; four weakening controls detected |
| `external/` | 17 cases and 17 restored; three weakening controls detected; finite helper/service/payment/finalizer recording coverage |
| `syntax/` | All 22 changed/new TypeScript files emitted in memory with zero syntactic errors; empty stderr; not semantic typechecking |

Raw outputs, exact source/runner hashes, invocation parameters and independent internal Codex outcomes are retained alongside each run. Two preceding external harness failures remain archived: the loader rejected a dormant `process.cwd()` reference, then a test assumed broader metadata exclusion than the existing response contract. The corrected harness blocks that dormant operation and checks actual raw-payload/internal-state exclusion. Production source stayed unchanged across those attempts. External list/receipt/repository/controller execution is outside that finite external run. These reviews are technical reviews, not finance, clinical, security, client, owner or deployment acceptance. Do not aggregate case counts into a module completion percentage.

Source contracts and decisions: the `CUSTOMER_*_CONTRACT_2026-11-13.md` files beside this report; profile and email records under the evidence directories above; ordinary effects under `output/qa/customer-cancellation-milestone/`; receipt source under `output/qa/customer-booking-receipt/`; final external and wallet decisions under their milestone evidence directories. Exact final production source hashes are in `output/qa/customer-milestone/syntax/INPUTS.json` (22 changed/new TypeScript files). Syntax transpilation is not a semantic typecheck or root build.

## Smallest remaining work, in order

1. Independent review of this exact local candidate using the supplied prompt; fix concrete findings without reopening deferred modules.
2. Under complete existing C2/C3 pre-import admission, check real route/middleware/Joi behaviour for profile mixed updates, address ownership, booking ownership/status and cancellation responses.
3. In an owned MongoDB transaction fixture, verify required native indexes and transaction support, concurrent missing-wallet creation, competing balance/slot changes, rollback and late/duplicate capture schedules. Resolve historical records explicitly instead of guessing effect provenance.
4. Establish authenticated provider events/status lookup and a protected recovery operation for unknown outcomes; verify actual provider cancellation acknowledgement shapes and no orphan remote booking before finance acceptance. Client must handle pending confirmation/cancellation and reconciliation conflicts. This is needed before calling the external lifecycle complete.
5. Obtain client/owner and relevant finance/security acceptance before deployment. Existing C2/runtime/deployment gates remain; no operational action is authorized by a local commit.

BetaCura/hybrid, CRM/events, certificate/report expansion, broader contact recovery/identity workflows and new provider/job infrastructure remain deferred. Unchanged clinical-file core and original tooling/archive are preserved. Existing saved branches are not replaced or merged.
