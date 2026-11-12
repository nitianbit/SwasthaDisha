# Pharmacy prescription progress gate — F1 amendment draft

12 November 2026. **DRAFT ONLY. F1 remains OPEN / HIGH_OPERATIONAL_RELEASE_BLOCKER.** Author: internal Codex `/root/customer_booking_writer`. Root owns Git/integration. No source, workflow activation, recovery, clinical approval or execution is authorized here.

## Baseline and reason

Worktree `/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab`, branch `m0/customer-pharmacy-lab-focus`; observed HEAD `5722ab42a049eb924befc00570a5fe83a5d718a5`. Pharmacy service baseline SHA-256: `54bbff59b46586120f107472265d116a6754782aea6d632295ecea88983f5ddc`.

The published [genuine R4 review, F1](../../../output/qa/customer-pharmacy-lab-claude-review/operator/CLAUDE_REVIEW_4.md) approves the earlier source against its contract and identifies an operational consequence: pending Rx orders can reach ready_for_pickup/out_for_delivery, where completion is blocked and cancellation is not a permitted transition. [Root acceptance](../../../output/qa/customer-pharmacy-lab-claude-review/operator/ROOT_ACCEPTANCE_4.json) accepts the source-review provenance and keeps F1 open. That is not runtime, clinical or release acceptance. No protected records/deployment were inspected, so actual live impact is unknown. No private captured thinking is part of this draft or its source binding.

Preserve the [earlier consumption contract](PHARMACY_PRESCRIPTION_CONSUMPTION_CONTRACT_DRAFT.md), all prior source QA/reviews, current lab/customer changes and operator/recovery records. This is a new proposed amendment, not a rewrite of their historical scope. Read [focused scope](CUSTOMER_PHARMACY_LAB_PLAN.md), [execution direction](CUSTOMER_PHARMACY_LAB_EXECUTION.md), [progress](M0_A_PROGRESS.md) and [workflow](PARALLEL_DEVELOPMENT_WORKFLOW.md).

## Current paths and design support

[ROADMAP U1](../ROADMAP.md#u1-pharmacy-app-ordering-and-in-house-sales), lines40–42, requires authorized review and a fulfilment gate before dispensing. [SYSTEM_DESIGN §8.1](../SYSTEM_DESIGN.md#81-pharmacy-and-connected-counter), lines230–250, separates prescription/payment gates. [TC-PHA-001 and TC-REV-007](../qa/TEST_SCENARIOS.md), lines94/219, specifically require pending/rejected denial at packed/dispense/completed. These support the earlier necessary state check; they do not select reviewer identity, clinical evidence or a refund/recovery policy.

The stale graph query returned no symbols; exact source and whole-src1 caller scans were used. Current transition map (`pharmacyOrders/services/index.ts:26–36`):

| Current state | Permitted targets |
| --- | --- |
| placed | accepted, rejected, cancelled, abandoned |
| accepted | packed, cancelled |
| packed | ready_for_pickup, out_for_delivery, cancelled |
| ready_for_pickup | completed |
| out_for_delivery | completed |
| completed, abandoned, cancelled, rejected | none |

The only production `.updateStatus(...)` callers are controller.updateStatus (request target) and controller.cancel (literal cancelled). The mounted routes retain authenticate/requireOperationalPharmacy/Joi. The operational pharmacy guard is not a pharmacist/clinical approval command. Creation and item repricing derive pending for prescription-required items with an attachment, otherwise not_required; no first-party approved-state command was found. Model default not_required is not permission to infer that missing legacy data is unrestricted.

The sole consumeOrderInventory caller is completion in updateStatus; it consumes active batch allocations in the existing transaction. Earlier progress does not consume those held lots. There is also an unchanged legacy item-edit available-stock debit outside this helper. Create/free-price/payment-confirmation/manual-paid paths can place or accept and collect payment without passing the proposed progress gate. The stale-unpaid scheduler selects online placed/pending orders; it is not recovery for captured, accepted, ready or out orders. Payment-setup compensation is also scoped to placed, not a general escape.

## Minimum technical amendment for review

Proposed production scope: **only `src1/modules/pharmacyOrders/services/index.ts`**, one existing rule broadened to earlier progress. No new clinical command, helper/module, enum, transition, stock/payment algorithm, DTO, role or repository change.

1. Define **one module-private `PRESCRIPTION_GATED_STATUSES: OrderStatus[]` list** containing exactly `packed`, `ready_for_pickup`, `out_for_delivery`, `completed`. No accepted/release/terminal targets in that list.
2. After both existing payment checks, derive exactly `const requiresPrescriptionCheck = PRESCRIPTION_GATED_STATUSES.includes(payload.status);`. Use that same boolean in **both** the closed prescription guard and the conditional CAS prescription predicate. Do not duplicate target lists or independently calculate clinical eligibility in a second helper.
3. For a gated target, retain the exact eligible states approved/not_required; pending/rejected/missing/null/blank/unknown deny before inventory construction, transaction allocation or order mutation. Preserve **409 ORDER_PRESCRIPTION_APPROVAL_REQUIRED / Prescription approval is required before the order can be completed**. The inherited fixed message remains for existing completion API compatibility and newly denied earlier targets; no per-target error variants.
4. For those same gated targets, extend the existing `{_id, status:observed}` transactional CAS with exact `prescriptionStatus:observed`. No broad eligible-state `$in`, client status, fallback, reload/retry, missing-field default or predicate in the update body. All nongated targets retain their original filter.

Keep current error priority: not found → store denial → terminal → illegal transition → existing payment checks → prescription check. Preserve online/in-store paid requirements and the cash_on_delivery advancement exception; COD still requires paid at completion. Thus unpaid online+pending Rx packed gets the existing payment409; COD unpaid+pending packed gets prescription409; COD unpaid completion keeps payment409. The payment target list has a different existing purpose and stays unchanged rather than being replaced by the new Rx list.

Preserve status/notes update, `{new:true,session}`, and CAS-before-release/consume order. No nextOrder retains **500 UPDATE_FAILED / Failed to update status** before inventory/queues. Completion alone still consumes; no newly gated earlier target may consume, release or charge. Existing successful response/side-effect queues and failure logging remain. Cancellation/rejection/abandonment stay nongated and retain existing legal-transition and exact-reservation/legacy release behavior. Do not add cancellation to ready/out, mark refunded, authorize release of physically dispatched goods or change payments in this amendment.

At the early boundary this keeps an unapproved newly progressing order at a state with its existing cancellation transition (accepted or packed). It does not establish that cancellation returns captured money, that stock is physically returnable, or that ordering/collection is suitable while approval is unavailable.

## F1 remains open: required owner decisions

| Situation | What this amendment supplies | Decision still required; named person not supplied |
| --- | --- | --- |
| Newly created Rx remains pending forever | Blocks packing and later progress; existing earlier cancellation path remains | Qualified pharmacist/clinical owner with identity/security: authorized review/rejection, evidence/reason, version/revocation and who may act; or an explicitly approved decision to keep Rx disabled pending that workflow. |
| Legacy already packed | Blocks ready/out/completed if state is ineligible; existing packed→cancelled remains | Clinical/operations and finance: determine physical fulfilment/stock condition and captured-money obligation before any operational action. Current cancellation is not a complete recovery policy. |
| Legacy ready/out pending/rejected/missing | Completion still denied; cancellation still invalid | Named clinical/pharmacy operations and finance/recovery owners must select an accountable recovery disposition. No exit or remediation is implemented here. |
| Captured money and reserved stock at any blocked state | No new collection, release or refund rule | Finance and pharmacy operations: reconcile verified collection, actual handover, reservation and remaining obligation; approve destination/budget/timing and customer handling under separate money/stock contracts. |
| Missing field or approved with no provenance | Fails closed on missing; stored approved remains only a necessary value check | Qualified clinical/catalogue and data-migration owners: classify evidence and provenance. No bulk not_required/approved backfill or direct DB command is authorized. |

F1 cannot be marked fully closed from the earlier guard alone. Before enabling prescription orders or releasing the pharmacy module, record actual named clinical/pharmacist and finance/recovery decisions plus their evidence and operational ownership. Root/internal technical reviewers are not substitutes for those authorities. If an applicable decision requires an approval endpoint, new cancellation transition, recovery override or money/stock effect, freeze/review that separate contract before its code or activation. This draft chooses none of those policies.

Existing ready/out orders remain visibly blocked; do not silently force completion, delete/reclassify them, release reservations, refund, or assume undispensed stock. Goods may already have been dispatched or handed over. No live records or provider facts were accessed to determine that here. A manual worklist/process, if selected by authorized owners, needs its own permitted access, evidence and execution scope; no procedure or DB mutation is invented in this draft.

## Other retained limits and verification gate

Value equality is not versioned approval: ABA, URL-only amendment retaining approved, patient/medicine evidence changes and catalogue classification remain unresolved. Payment/ownership/item-allocation races, legacy item-edit debit, paid cancellation/refund and stock expiry after reservation remain separate. An approved lot can still fail its existing quality/expiry consume guard at ready/out; this amendment supplies no new recovery exit. Source conformity cannot certify TC-PHA-001/TC-REV-007 or safe physical dispensing.

Before code, obtain **two actual independent nonauthor Spec/Standards decisions** on this exact draft/hash, reconcile applicable owner-decision scope and receive separate Root authorization. An offline source-only containment candidate does not authorize Rx enablement or recovery. Preserve historical contracts/QA rather than rerunning or relabeling them. Before imports/executable checks, freeze complete current service/DB/provider/queue/config/dependency closure under C3; C2 still gates root build/runtime changes. No application edit/test execution, Node/npm, DB/provider/network access, model call or Git mutation was performed for this draft.

Fixtures must explicitly identify intentional approved/not_required cases and preserve raw missing-state denial controls; no blanket approval/default may be added to make them pass. No fixture edits are authorized by this draft.

Required focused evidence, all NOT_RUN:

- Every gated legal predecessor/target with paid approved/not_required succeeds as currently intended; pending/rejected/missing/null/blank/unknown denies before transaction/effects. One authoritative list/boolean must control guard **and** exact observed-state CAS.
- Payment priority/COD, terminal/foreign/invalid-jump errors and original error/response text remain. All legal nongated releases remain prescription-independent with unchanged counters, reservation quantities and sibling states; money-return claims need their separate evidence.
- Actual predicate races on each newly gated target reject changed approval state before side effects. Preserve same-session order/inventory rollback and duplicate-completion controls; source text is insufficient.
- Reproduce original F1 for legacy ready/out and show it remains explicitly unresolved; demonstrate new pending orders cannot pass packed. Paid accepted/packed cancellation evidence must distinguish reservation release from actual refund.
- Reintroduced completion-only gate/CAS, divergent/omitted target, missing-state allow, broad eligible-set CAS, gate before payment, late guard or consume-before-CAS must fail relevant assertions. Restored controls must pass within their separately admitted scope.

Final cross-module integration remains **DEFERRED_BY_OWNER**, separate from focused checks. No F1 closure, clinical/finance/client/module/M0/deployment/release acceptance is claimed. Author stops writes at this draft for review and applicable owner decisions.

## Source/design/review bindings (SHA-256)

Current exact source, design, predecessor contract/QA and published R4 records only; no private captured content. Reconcile drift before implementation. This is not a complete C3 closure.

| Path | SHA-256 |
| --- | --- |
| `src1/modules/pharmacyOrders/services/index.ts` | `54bbff59b46586120f107472265d116a6754782aea6d632295ecea88983f5ddc` |
| `src1/modules/pharmacyOrders/controller/index.ts` | `e168f02e3ed0afce7587b2f4f0d40982c9c0fdfa5bd4062309c7c27a5601ef28` |
| `src1/modules/pharmacyOrders/routes/index.ts` | `057900f3675521cbfaa7c31e003d38a036ba46c6e2fa7fab4d7ee7b6a48ec815` |
| `src1/modules/pharmacyOrders/validation/index.ts` | `6c4d01ebcb9db52c88bc8b0883dc679816f6b232a2c53ee5819d8f9e6f5afd64` |
| `src1/modules/pharmacyOrders/types/index.ts` | `d9721c2b901acd559c224e88cf529aa1d4eb9617dd10f58d31073301575118a7` |
| `src1/modules/pharmacyOrders/model/index.ts` | `86b2bb62e2e2191aff1f624f8dc344e97f519add9bd9ba02cfd2fffb37c7a2b8` |
| `src1/modules/pharmacyOrders/repository/index.ts` | `3b2c068fe8bcb9679811e6d44ccb265d162df4b3158d66ee051d1c83ceea9d44` |
| `src1/modules/pharmacyInventory/services/index.ts` | `bb02c3bf808ad4101a156be755bb39d26e6585ee1fcfaa5d12cb0000f5efee06` |
| `src1/modules/pharmacyInventory/repository/index.ts` | `2cc825908777950cbfcf1cf4dea6cc12f0e6e97a41660fb413565db3fdd6e659` |
| `src1/modules/pharmacyCart/services/index.ts` | `6c6f50cecfd60e7e404d6138329d5573b8075efe027ed1b4930a99db46c3f0e5` |
| `src1/modules/payment/services/index.ts` | `39c29b050dbca15db431f5415ebaa5dec8bbf77c31637ee13112796cf13ab5a0` |
| `src1/modules/middleware/auth.ts` | `db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2` |
| `src1/modules/common/repository/BaseRepository.ts` | `14a0fe5fdc9abd7a54b913bca4816a631b4bb263c11ad21ec37da0ee6c3f723a` |
| `src1/modules/common/middleware/validation.ts` | `8be55cee7485531491ff095ed1d9f36af443987690f22d04dd67ef9318a0a5ef` |
| `src1/modules/middleware/errorHandler.ts` | `1e06885f2c5b8df8ed186dba28cd975aaf4f4d5233a2daa277e6b7f7b15fad51` |
| `src1/routes/index.ts` | `50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056` |
| `test/pharmacy.integration.test.ts` | `49f97bb67d22423e58412b291d8019c0eb52ab0232a49e0909dd55b1b52565c3` |
| `documentation/planning/implementation/PHARMACY_PRESCRIPTION_CONSUMPTION_CONTRACT_DRAFT.md` | `60b0f2e140857b68936d629ca5ce37bca10f9e114a0f9b3c99154e8cdc0d56f3` |
| `output/qa/pharmacy-prescription-consumption/SOURCE_FREEZE.json` | `685d908570afc14161c3adb43a191ff2018bff82ad9955a9dcc8fb390579fc7d` |
| `output/qa/pharmacy-prescription-consumption/baseline.ts.txt` | `a03cf441e9638edfd6ee48d6a8c407096c257348e37e157904d9f42642940b94` |
| `output/qa/pharmacy-prescription-consumption/candidate.diff` | `7b50974ed752b0556389a95c0d487ee39496c62660075b1700e9e03065823eec` |
| `documentation/planning/ROADMAP.md` | `6a5b2e5bfdb42d16021cb28f83531389977d535d9743ae8908ab75ceeabd37cf` |
| `documentation/planning/SYSTEM_DESIGN.md` | `cbd899f6fb442b13db28c389143b529b90da364165dc17291cc829814810bc84` |
| `documentation/planning/qa/TEST_SCENARIOS.md` | `bd8c6e8952a8c1cc2f2c2063a4d7a79000dc5566b966a6650d49d60ff841f09e` |
| `output/qa/customer-pharmacy-lab-claude-review/operator/CLAUDE_REVIEW_4.md` | `4f75b41dd0342d91259764b678f488b4001e1127c29da1a699d2f086b8fd0170` |
| `output/qa/customer-pharmacy-lab-claude-review/operator/ROOT_ACCEPTANCE_4.json` | `bdfa3539ddb39ae4335aa0e3b6478131e332e3e65335600a51476b7c72187cfa` |
| `documentation/planning/implementation/CUSTOMER_PHARMACY_LAB_PLAN.md` | `b3fe87439052e8b22975e736016e8739dd8948192899a7e26be150aa4c7a2978` |
| `documentation/planning/implementation/CUSTOMER_PHARMACY_LAB_EXECUTION.md` | `3bfc2bedca676a641b1def8f8538042eedfd1a5cacc99d9ea23bf8d2532f42ef` |
