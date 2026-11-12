# Customer, pharmacy and lab delivery board

13 November 2026. Working source snapshot9debdd25ae4079fa73f5052afe3a0fd62d4feb0f. Original eight-week TOTAL target retained; it does not restart at this checkpoint. Previous unsupported remaining-duration figures are withdrawn. No verified engineer-hour ledger or complete feature throughput baseline exists, so no numerical remaining estimate is asserted. Forecast checkpoint: after the next complete feature milestone and its focused evidence, report actual scope, effort/review waits and unresolved dependencies. Calendar targets are not completion evidence.

## Execution and ownership

Use at most two implementation workers concurrently, rotating independent reviewers; Root owns shared interfaces/merges/forecast. Reuse existing services and one authoritative implementation of shared rules. Codebase Memory MCP is disabled by owner instruction; use direct source reads and rg. Saved graph remains untouched. All implementation remains local until separately authorized push/release.

| Lane | Current concrete work | Ownership | Done signal |
| --- | --- | --- | --- |
| Pharmacy recovery | Party fence and legacy-case alignment merged, two independent source reviews each plus composition | Root integration; source authorscustomer_remaining_audit andlab_remaining_audit | Source milestone only: hashes and decisions in output/qa/pharmacy-recovery-party-fence and pharmacy-legacy-test-alignment; real transaction/HTTP checks outstanding |
| Independent model review | R10 xhigh live review: history, supplier, recovery fence, test alignment; R9max interrupted after owner correction | milestone_composition_r9 owns revision-9 only | Genuine Opus5.5 requestedxhigh (extra high), explicitly notmax; actual model/tool/mailbox/process evidence and independent acceptance; no unsupported effective-effort claim |
| Customer identity | Destination-proven signed customer contact-change contract | customer_remaining_audit owns draft only until two contract votes | Complete reusable actor/target/purpose/expiry/single-use/unique-contact/session contract and focused tests before completion |
| Shared verification | Existing core semantic candidate and supplier DB readiness remain separately pending | Root assigns exact review/admission when required | Actual evidence under existing C2/C3; no root runtime adoption |

## Remaining implementation packets

Status describes current known gaps, not a percentage. Existing catalogue/cart/account/address/dependent/notification/order/provider primitives are reused. Group related changes into coherent milestones; do not recreate source or rerun accepted unchanged campaigns.

| Packet | Reuse | Remaining result | Dependency / evidence |
| --- | --- | --- | --- |
| C1 contact changes and recovery | OTP generation/conditional consume, existing auth/email verification/user update | Destination-proven change, purpose/actor binding, safe recovery and session lifecycle | Current contract draft; unique-contact/replay/race evidence |
| C2 patient/caregiver | Account/dependent/pharmacy-customer records | Permanent identity, no-phone assisted registration, authorized linkage/merge, caregiver grants and versioned consent/withdrawal | Shared actor/patient contract; clinical/privacy policy acceptance |
| C3 customer lifecycle/support | Existing booking cancellation, reminder/Meet/slot paths and recovery receipt | Truthful refund status, safe retries/deletion effects/retention and included accountable support cases | Shared financial effects; focused fault/race checks |
| S1 private clinical documents | Current storage/download/provider report fetch | Authorized bytes, immutable original/corrected versions and release provenance | Shared customer+lab implementation once, privacy/signatory gates |
| P1 prescription fulfilment | Existing explicit fail-closed commerce and order states | Qualified review/reject/release and permitted dispensing | Reviewer eligibility/clinical acceptance; positive+forbidden fulfilment tests |
| P2 money/recovery | Payment capture guards, recovery intake/worklist | Accountable paid cancellation/recovery/refunds, shared budget/coupon/wallet correctness | Financial/provider facts; replay/race/rollback reconciliation |
| P3 stock/returns/recalls | FEFO reservation/consume/release, quality/low-stock reads | Exact batch return/quarantine/restock, recall operations, reservation and cancellation conservation | Real replica-set concurrency/rollback and retained evidence failures |
| P4 purchasing | Reviewed supplier contact CRUD | PO, goods receipt, supplier invoice/payable and purchase returns | Stock units and shared purchasing/billing contract |
| P5 counter billing | Counter orders/manual paid marking and price/tax snapshots | Sales invoice/receipt/credit, collection reconciliation and shift close | Shared billing; entity/numbering/tax/finance acceptance |
| P6 wholesale and units | Existing retail/wholesale fields and channel routing | Verified entitlement, pack/strip/unit conversion, versioned prices/overrides; credit only when enabled | Unit/rounding rules; channel/buyer denial and conservation tests |
| P7 operational delivery | Order status/subscription preferences/jobs | Pickup/delivery exceptions, due-refill dispatch and low-stock communication/purchasing handoff | Scoped job/idempotency checks |
| L1 provider events | Existing adapters/callback parsing/booking sync | Provider-specific authentication, durable duplicate/order fencing and safe effects | Actual provider event/auth contract; no invented HMAC |
| L2 panel and specimens | Existing external bookings/actor guards | Canonical assigned lab/branch/staff worklists, sample collection/rejection/recollection | Shared staff provisioning; isolated assignment/sample checks |
| L3 reports and critical results | S1 document boundary and report retrieval | Upload/quarantine, qualified signatory release/correction, clinician review and escalation acknowledgment | Clinical/signatory rules; no release from upload alone |
| L4 direct billing and supplies | Existing tariffs, payment and supplier/purchasing patterns | Walk-in/no-app private orders, invoice/receipt/balances and reagent/consumable receipt/use/waste/count | Shared C2/P4/P5; unit and duplicate-effect reconciliation |
| S2 business/staff/client closure | Existing organization authority rules and84 bounded cases | Business/branch/staff provisioning and required client compatibility | Do not infer UI availability; source inventory and actual supported-client checks |

## Completion boundaries

For each packet record separately: implementation, focused executable evidence, independent technical/model review and applicable owner acceptance. Source-only and NOT_RUN do not become PASS. Clinical/provider/finance facts remain separate from decision-free source work; keep other ready lanes moving. Root dependency/build/start adoption and actual deployment retain C2 and operational gates. Corporate/HR/hospital expansion, optional analyzer automation and the final cross-module integration campaign remain deferred. A final integration backlog is retained rather than silently declared complete.

Original checkout stagedsix, full-index patch and handover remain preserved. The completed party/test milestone fixes a bounded reviewed defect; it does not complete the business modules or reset the delivery clock.
