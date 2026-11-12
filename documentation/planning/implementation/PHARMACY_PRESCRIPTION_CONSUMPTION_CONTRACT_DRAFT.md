# Pharmacy prescription state at reserved-stock consumption — draft

12 November 2026. **DRAFT ONLY; two current independent nonauthor Spec/Standards decisions are required before implementation.** Author: internal Codex `/root/customer_booking_writer`. No source edit, clinical approval, fixture execution or runtime admission follows from this document. Root owns integration/Git. Writes stop after this source-bound draft.

## Baseline, design basis and narrow purpose

Repository `nitianbit/SwasthaDisha`, durable branch `m0/customer-pharmacy-lab-focus`, worktree `/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab`; observed HEAD `ce27053382d980a68c6444716c8f75882c01dd56`. The customer controller must retain reviewed SHA-256 `bbe2d226d0192b91389675dd5e66f2b385dc157bba0010715bbe4b29b0e2848b` while the genuine Claude read-source review uses its snapshot. The customer write-owner draft, operator/recovery artifacts, existing QA, and original checkout's six staged/working files, patch and eleven handover files remain untouched.

Read [current progress](M0_A_PROGRESS.md), [focused scope](CUSTOMER_PHARMACY_LAB_PLAN.md), [execution direction](CUSTOMER_PHARMACY_LAB_EXECUTION.md), [readiness findings](CUSTOMER_PHARMACY_LAB_GAPS.md), [fixture recovery](PHARMACY_FIXTURE_RECOVERY.md) and [workflow](PARALLEL_DEVELOPMENT_WORKFLOW.md). The historical inventory cursor failure and missing uncommitted correction are unrelated evidence gaps; this draft neither retries nor repairs that fixture.

The existing design explicitly supports a prescription gate: [ROADMAP U1](../ROADMAP.md#u1-pharmacy-app-ordering-and-in-house-sales), lines 40–42, requires authorized pharmacist review and states that attachment alone cannot authorize dispensing. [SYSTEM_DESIGN §8.1](../SYSTEM_DESIGN.md#81-pharmacy-and-connected-counter), lines 230–250, separates prescription/payment gates and checks them before consuming held lots. [TC-PHA-001 and TC-REV-007](../qa/TEST_SCENARIOS.md), lines 94 and 219, require pending/rejected/unapproved denial and no unauthorized stock consumption. They also require broader clinical/packed-transition safeguards that this minimum slice does not complete.

Proposed production scope is **only `src1/modules/pharmacyOrders/services/index.ts`, inside `PharmacyOrderService.updateStatus`**: prevent the existing completed transition from consuming reserved stock unless the observed prescription state is exactly `approved` or `not_required`, and bind that state in the transactional order compare-and-set (CAS). Unknown/missing states fail closed. No new approval command, pharmacist role, clinical policy, enum, schema, stock algorithm, refund, payment, other-transition or release change. Existing service/controller APIs remain unchanged; no helper is needed for one guard and one conditional predicate.

## Actual callers, transitions and state derivation

The graph indexes old original-checkout `bfb608e`, not this worktree; its targeted search returned no symbols. Exact source and whole-src1 literal scans were used instead. A zero graph result is not absence-of-callers evidence. Repository scans do not establish deployed/client/external caller completeness.

| Path | Exact current source under `src1/modules/` | Observation |
| --- | --- | --- |
| Mounted status route | `pharmacyOrders/routes/index.ts:49–56`; `src1/routes/index.ts:94` | Authenticated POST `/:id/status` → requireOperationalPharmacy → params/body Joi → controller.updateStatus → service.updateStatus. |
| Cancellation adapter | `pharmacyOrders/controller/index.ts:84–91` | The only other production `.updateStatus(...)` call sets literal cancelled; it cannot select completed through this adapter. |
| Completion | `pharmacyOrders/services/index.ts:979–1060` | Finds order, checks store, terminal/transition/payment rules, then runs transaction: order status CAS, optional release or completion consume, commit, post-transaction side-effect queues. No prescription-state check currently. |
| Consumption helper | Same service `:220–234`, sole caller `:1043` | Only updateStatus's completed branch calls private consumeOrderInventory. It selects active items with batchAllocations and invokes InventoryService.consumeOrderReservedStockBulk in the same session. No legacy-item debit is added at completion. |
| Inventory leaf | `pharmacyInventory/services/index.ts:430–451`; repository `:227–260` | Sole production bulk-reserved-consume caller is that helper; sole consumeBatchAllocations caller is that bulk method. Batch status/expiry/reservation checks and session save remain separate stock guards. |
| Create from pharmacy/cart | Order service `:462–479`, `:575`, `:591–627`; `pharmacyCart/services/index.ts:439–458` | Medicine catalogue data supplies prescriptionRequired; missing required attachment throws 422 PRESCRIPTION_REQUIRED. Required+attached derives pending; no required medicine derives not_required. Create reserves batch stock; despite an old comment saying consume, the actual call is reserveOrderStockBulk. Cart forwards attachment URLs through that same creation path. |
| Item repricing | Order service `:904–924` | Repricing recomputes prescriptionStatus from medicine requirement and URLs, yielding pending/not_required, not approved. |
| URL-only update | Order service `:925–933` | Rejects clearing all URLs when an item needs a prescription, but replacing URLs alone does not reset an already approved state. This is a separate approval-version gap. |
| Other stock debit | Order service `:176–194`, `:935–960` | A legacy order without batch allocations may debit available stock through applyInventoryDelta during permitted unpaid/placed item edits. This is not a consumeOrderInventory caller and is outside this completion-only guard. No all-stock-consumption claim is allowed. |

The full current transition map is: placed → accepted/rejected/cancelled/abandoned; accepted → packed/cancelled; packed → ready_for_pickup/out_for_delivery/cancelled; ready_for_pickup → completed; out_for_delivery → completed; completed/abandoned/cancelled/rejected → none. Consequently only ready_for_pickup and out_for_delivery can currently reach completion. Invalid jumps and terminal repeats remain their existing errors, not new prescription errors.

PaymentService source was also checked: its pharmacy-order updates claim payment, move placed to accepted, or abandon/refund timed-out orders; no consumeOrderInventory call was found. Other `status:'completed'` hits in its wallet/transaction records are not pharmacy fulfilment transitions. No new prescription check is proposed for payment capture/recovery.

## Existing approval authority is incomplete

The model stores `prescriptionStatus` enum `not_required|pending|approved|rejected`, default not_required; the TypeScript property is optional. The create/update/status Joi schemas do **not** accept prescriptionStatus or reviewer identity. Whole-src1 prescriptionStatus references found only model/type declarations and create/reprice derivation; no first-party approval/rejection command, reviewer assignment/signature, approval provenance or prescription-version fence was found. Existing approved records may originate outside this searched command surface; their provenance is not established here.

The operational route guard requires role pharmacy and reloads the pharmacy profile's active/verified/nonarchived state (`middleware/auth.ts:307–357`). That verifies the business account, not a designated pharmacist, professional license, prescription validity or clinical author. No admin bypass is added; the status route itself uses requireOperationalPharmacy rather than requireAdminOrOperationalPharmacy. No inventory service receives a pharmacist identity at this boundary.

This slice only trusts the **existing stored state value** as a necessary completion precondition. It must not relabel that value as authenticated clinical approval. A qualified pharmacist/clinical/security owner must separately define permitted reviewer, evidence/rejection reason, prescription/medicine/patient version binding, amendments/revocation and permitted packed/dispense operations before clinical or pharmacy acceptance. A paid Rx order that remains pending will be intentionally blocked; do not auto-approve, downgrade to not_required, expose a generic status override or invent a temporary clinical workflow to restore completion.

## Proposed guard, errors and exact CAS

Preserve current order/error priority:

1. Missing order: existing 404 ORDER_NOT_FOUND / Order not found.
2. Wrong owning pharmacy: existing 403 FORBIDDEN / Access denied.
3. Terminal current status: existing 400 ORDER_TERMINAL / Order is already in a terminal state.
4. Illegal transition: existing 409 INVALID_ORDER_STATUS_TRANSITION and existing dynamic message.
5. Existing payment guards: packed/ready/out-for-delivery require paid unless cash_on_delivery; **all completion requires paid**, including cash_on_delivery. Preserve both existing ORDER_PAYMENT_REQUIRED / 409 messages and their priority.
6. **Only for payload.status === completed**, require observed order.prescriptionStatus exactly approved or not_required. Every other value, including pending/rejected/undefined/null/empty/unknown, denies before buildInventoryItems, transaction allocation, order mutation, inventory dispatch or post-commit queue calls. Proposed new fixed error for review: **409 ORDER_PRESCRIPTION_APPROVAL_REQUIRED / Prescription approval is required before the order can be completed**. Do not echo URLs, patient details or arbitrary state values. Creation's existing 422 PRESCRIPTION_REQUIRED is a different attachment check and remains unchanged.

A paid+pending/rejected/unknown valid completion gets the new prescription error; unpaid+pending completion keeps ORDER_PAYMENT_REQUIRED. Do not move prescription denial ahead of store/terminal/transition/payment checks, and do not add it to packed/ready/out-for-delivery or release targets in this minimum slice. Those preserved earlier transitions remain unresolved clinical/physical-release risks, not approved dispensing behavior.

Inside the **same existing transaction/session**, keep status CAS **before** consume. For completion only, extend its current `{_id:id,status:order.status}` filter with **exact equality to the observed eligible prescriptionStatus**. For all other targets retain the original filter. Do not use a broad `$in:['approved','not_required']` instead of the observed value: changing either eligible state after the read must invalidate this attempt too. Preserve status/notes payload and `{new:true,session}` options. Do not trust a payload prescriptionStatus, fall back to another value, reread/retry authorization, or place the predicate in the update body instead of the filter.

If the CAS returns no nextOrder, retain existing **500 UPDATE_FAILED / Failed to update status**, throw before consume/release and let the transaction abort. No reload is added to reclassify that existing conflict. The helper/bulk/repository consume chain and its BATCH_RESERVATION_CONSUME_FAILED error remain unchanged. All related order/inventory writes must still use the existing transaction; no pretransaction inventory debit or separate status write.

Observed approval → pending/rejected/change before the CAS therefore must not complete or consume. Actual concurrent mutation after the transactional update, transient retries and abort behavior need owned Mongo evidence; text alone cannot prove them. Existing withTransaction behavior is retained; do not add application retry or enlarge an execution recipe on failure.

Success remains existing 200 `{success:true,message:'Status updated',data:updated}` through the controller. Existing post-commit subscription sync and customer notification queues remain. Their existing safe-error logging is not changed. No new HTTP envelope, Joi/auth order or other transition semantics are introduced.

## Preserved release paths and material limits

Cancellation/rejection/abandonment follow their existing allowed transitions and release logic even when prescription state is pending/rejected/unknown. Release still returns exact held batch allocations and the existing legacy representation; stock quality/session/quantity behavior is unchanged. Paid cancellation/refund obligations remain separate P0 finance work; this draft does not repair, approve or conceal them. Legacy edit-time available-stock debits also remain separately visible.

An exact value CAS prevents using a stale **different prescriptionStatus** at that order update. It does not detect approved→pending→approved ABA, replacement of prescription URLs while state stays approved, changed clinical contents/patient/medicine version, forged/out-of-band approved or not_required, catalogue classification gaps (`prescriptionRequired ?? false`), ownership/payment races or all other writers. Do not claim versioned approval, full current clinical authority or every stock-consumption path is protected. Do not add unrelated CAS fields or clinical policy in this slice without renewed review.

## Focused evidence and fixture compatibility

All executable checks remain NOT_RUN. First obtain two current actual independent nonauthor internal Codex Spec/Standards decisions on this exact draft/hash before any production edit. Then freeze the smallest one-service diff plus source evidence and obtain two independent source/composition decisions. Draft authorship is not approval; historical inventory/90-33/earlier module decisions are not this contract's implementation or execution admission.

Source-only checks may establish the guard's closed allowlist/order, completion-only exact filter, unchanged other branches/session and named weakening controls. They cannot prove Mongo atomicity, rollback, stock conservation, queue delivery, auth/role behavior or TypeScript validity. Preserve old-source rejection and all first failures without inventing runtime PASS.

Before any test imports, prepare/review full C3 closure with fixed current sources/dependencies/configuration, owned disposable replica set and exact indexes, provider/file/network denial, payment/queue/logger recording and once-owned cleanup. Existing foundation/Mongo smoke does not admit PharmacyOrderService. [Legacy pharmacy integration source](../../../test/pharmacy.integration.test.ts) imports application modules before its weak optional DB guard; do not execute it. Its current cases cover missing attachment, cancelled release and invalid paid jump, **not** paid pending/rejected completion. Fixture recovery's cursor-only source work is a separate gate.

When later constructing an admitted fixture, seed explicitly `not_required` for intentionally unrestricted synthetic orders and `approved` only as a synthetic preexisting state for necessary-state compatibility. That is not a real approval command or permission to mutate live records. Seed pending/rejected and truly missing/null/unknown durable states independently; schema defaults/enum coercion must not silently turn denial controls into not_required. Do not weaken the service guard or assign every test order approved to keep old fixtures passing. Preserve existing 422 attachment fixtures, ordinary noncompletion defaults and both item representations. No existing test file is authorized for editing by this draft; review exact new/changed fixture files before implementation.

Required eventual actual cases:

| Case | Required observation |
| --- | --- |
| Allowed state and both valid predecessor statuses | Paid approved and not_required orders complete through one exact status+observed-prescription CAS, then existing same-session consume once; exact stock/order/queue effects and response preserved. Include active batches and legacy/no-allocation representation without inventing a new completion debit. |
| Invalid prescription states | Paid pending/rejected/missing/null/blank/unknown completion denies new 409 after existing read/checks; zero transaction/order-update/inventory/post-commit-queue dispatch. Existing middleware logging is separately bounded, not assumed zero. |
| Priority compatibility | Unpaid+pending returns payment409; foreign/missing/terminal/invalid transition retain existing errors. Existing cash-on-delivery advancement exception stays, while unpaid completion stays forbidden. |
| Approval race | Change observed approved or not_required to another state before CAS; no match → existing UPDATE_FAILED, no consume/queues and unchanged reservation/status. Demonstrate with the actual predicate/owned DB; a fake that always matches is insufficient. |
| Failure/rollback/replay | Consume failure rolls order status and all inventory writes back; duplicate/concurrent completed attempts consume at most once under current transaction/status rules. Record exact sessions, retries/counters, all sibling documents and permitted cleanup. No new exactly-once claim from text. |
| Unchanged transitions and release | Noncompleted progress stays as currently implemented; each allowed release path preserves reservation/legacy quantities even with pending/rejected. No full prescription/packed-safety acceptance follows. |
| Source defect controls | Remove/invert/loosen gate; allow undefined; move after consume or before payment; trust payload; omit/misplace/replace exact CAS predicate with broad eligible-state set; consume before successful CAS or omit session. Relevant assertion must fail; fresh restored positive source/behavior controls must pass under their own admitted scope. |

Root dependency/runtime/build/start adoption retains C2. Required focused checks are separate from the owner-deferred final cross-module integration campaign (**DEFERRED_BY_OWNER**). No original scenario, TC-PHA-001/TC-REV-007, pharmacy module, clinical/pharmacist/finance/privacy-owner, supported-client, M0, 100 RPS, deployment or release acceptance is established.

## Source/design freeze (SHA-256)

These exact durable files were read and hashed for this draft. The table is source provenance, not the complete C3 import closure. Reconcile drift before implementation; do not refresh pins silently. No application/runtime execution, package operation, provider/network/DB/Docker access or Git mutation occurred for this draft.

| Path | SHA-256 |
| --- | --- |
| `src1/modules/pharmacyOrders/services/index.ts` | `a03cf441e9638edfd6ee48d6a8c407096c257348e37e157904d9f42642940b94` |
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
| `documentation/planning/ROADMAP.md` | `6a5b2e5bfdb42d16021cb28f83531389977d535d9743ae8908ab75ceeabd37cf` |
| `documentation/planning/SYSTEM_DESIGN.md` | `cbd899f6fb442b13db28c389143b529b90da364165dc17291cc829814810bc84` |
| `documentation/planning/qa/TEST_SCENARIOS.md` | `bd8c6e8952a8c1cc2f2c2063a4d7a79000dc5566b966a6650d49d60ff841f09e` |
| `documentation/planning/implementation/PHARMACY_FIXTURE_RECOVERY.md` | `7b4f866aa51d05bce4a93bbfcb5093df98d3827c3f266f02c1abb5dc138a50ed` |

Disposition: **DRAFT_ONLY / TWO_PREIMPLEMENTATION_DECISIONS_PENDING / ALL_EXECUTION_NOT_RUN**. This author stops writes here; any implementation remains separately authorized and snapshot-coordinated.
