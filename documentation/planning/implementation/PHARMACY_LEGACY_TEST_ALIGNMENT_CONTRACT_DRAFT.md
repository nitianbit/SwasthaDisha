# Pharmacy legacy test alignment — draft contract

12 November 2026. Status: DRAFT; two independent nonauthor contract decisions
are required before implementation. This document proposes a test-only repair
for genuine Claude R8 finding R8-F4-1. It neither implements the repair nor
admits execution of the legacy suite.

## Baseline, ownership and scope

- Repository: `nitianbit/SwasthaDisha`; worktree
  `/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab`.
- Exact baseline HEAD: `6543dc9bd7220db43f1de780e2c6ac455dcf0f1e`.
- Proposed implementation owns only two existing case bodies in
  `test/pharmacy.integration.test.ts`. No production, dependency, runtime,
  startup, fixture-controller or shared-helper edit is authorized here.
- Preserve the existing nineteenth `new MedicineRepository()` argument to
  `new PaymentService(...)`, all other constructor arguments, all imports,
  `createMedicine`, `createOrderService`, every other case, case names, suite
  admission/skip logic and cleanup byte-for-byte. Do not introduce another
  no-op, stub, fallback, skip, production bypass or replacement test suite.
- Preserve other workers' files, the original checkout's six staged/working
  files and full-index patch, and its eleven handover files. This draft does
  not own or modify any of those artifacts.

Read prerequisites: `AGENTS.md`, `PARALLEL_DEVELOPMENT_WORKFLOW.md`, current
`M0_A_PROGRESS.md`, `REPOSITORY_TRANSITION.md`, `test/foundation/README.md`,
and `C3_MONGO_FIXTURE_CONTRACT.md`. R8 and Root's dispositions are linked below.

## Source and provenance pins

These are SHA-256 of current file bytes at the baseline; they are source data,
not executed or type-checked evidence. Paths below are repository-relative.

| Path | SHA-256 |
| --- | --- |
| `test/pharmacy.integration.test.ts` | `e123eab6f5bde08475605f8ed47a1f3830cd97ecdd9c8fe2dd0f2aa49507d35e` |
| `src1/modules/pharmacyOrders/prescriptionCommerce.ts` | `8e6db5fc64d5a5b2fec6437660fb0d308c24d3e1c0aec2ae95efdc2f73fe0058` |
| `src1/modules/pharmacyOrders/services/index.ts` | `83ca486a250403a777f0548ec57c98bd1e99e154b6f2034754ddc9aedbc3f35e` |
| `src1/modules/pharmacyOrders/model/index.ts` | `f054a220020c66a83c49ea8658bd0d002cb3a9fd28c9b7771b0584c53471ac14` |
| `src1/modules/pharmacyOrders/repository/index.ts` | `df77e35abeb00913d6353e0bf76a3651b3a1b78b6e669548439472347c4b084f` |
| `src1/modules/pharmacyMedicines/model/index.ts` | `2dd98cd59a4e9a3aaa156d917f7cc131d7e30c7546ad7296b8a0ca4920c70725` |
| `src1/modules/pharmacyMedicines/repository/index.ts` | `2d3f1cc7e21804546bbdaa68d8316c9f3f4ae176f6cebc26626960908a02c2f3` |
| `src1/modules/common/repository/BaseRepository.ts` | `14a0fe5fdc9abd7a54b913bca4816a631b4bb263c11ad21ec37da0ee6c3f723a` |
| `src1/modules/payment/services/index.ts` | `9c1086e3aa9239855ed3d73a02f941015d869bdb36a689a5294dea367ee7457d` |
| `src1/modules/common/types/error.ts` | `3f69860897913c1d8467e3f8aaca7d083e9d50a841553adce33ec6421a0fda07` |
| `output/qa/customer-pharmacy-lab-claude-review/revision-8/operator/CLAUDE_REVIEW_8.md` | `5eaf50279e150016781dde05c27c1ee2520f8a724f65360febbce2a0b1c44188` |
| `output/qa/customer-pharmacy-lab-claude-review/revision-8/operator/FINDING_DISPOSITIONS_8.md` | `ff88b0e0eaae87909f8b143687456041a7415b687869dcf64e85a983c2074f8d` |

The [genuine R8 review](../../../output/qa/customer-pharmacy-lab-claude-review/revision-8/operator/CLAUDE_REVIEW_8.md)
approves source only and identifies these two stale cases. The
[Root dispositions](../../../output/qa/customer-pharmacy-lab-claude-review/revision-8/operator/FINDING_DISPOSITIONS_8.md)
require a separate test-only alignment and retain full C3 before execution.

Graph discovery was attempted first (`index_status`, `search_graph`,
`trace_path`). Project `swasthadisha` reports root
`/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha` at old HEAD
`bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7`, not this worktree or HEAD.
Its markPaid trace omits the current commerce guard. Current exact files,
read as text, therefore establish the facts below; stale graph results are
not current source evidence. No graph refresh or application import occurred.

## Current behavior and fixture route

1. In `PharmacyOrderService.create`, reference/party checks and item pricing
   precede `assertPrescriptionCommerceAvailable({ kind: 'new_items', ... })`.
   A priced Rx item has `prescriptionRequired: true`, so that guard throws
   `AppError` with `status: 503` and code
   `PRESCRIPTION_CHECKOUT_UNAVAILABLE` before the later
   `assertPrescriptionProvided` and inventory transaction. `AppError` exposes
   `status`, not `statusCode`. The existing Rx case expects the obsolete
   `PRESCRIPTION_REQUIRED`, though its current total-quantity assertions already
   expect 3 available and 0 reserved.
2. In `markPaid`, the owning-pharmacy, manual-payment-mode, payment-state and
   terminal-state checks precede `assertNewCommerceForOrder`. Its
   `stored_order` guard requires the exact order identity,
   `prescriptionStatus: 'not_required'`, an empty `prescriptionUrls` array,
   a nonempty list of distinct active lines with explicit
   `prescriptionRequired: false`, and matching current non-Rx catalogue rows
   that are not inactive or archived. The existing `items: []` fixture denies
   both invocations with 503 before any conditional payment mutation.
3. `createMedicine` creates a real `MedicineModel` row with a fresh name and
   `isActive: true`. The current medicine schema stores
   `prescriptionRequired: false` by default; no archive field is supplied.
   Reuse it for this one case. The stored order line below also supplies false
   explicitly, independently of the order-item schema's default.
4. `createOrderService` already supplies a real `MedicineRepository` in its
   eighth slot. Its zero-argument constructor uses the real Medicine model;
   inherited `findAll` uses `.select(...).lean()` for the catalogue guard.
   `PharmacyOrderRepository` uses the real order model and inherited `update`
   uses `findOneAndUpdate(..., { new: true }).lean()`. After admission,
   `markPaid` retains its conditional exclusion of paid/refunded/terminal
   states and `ORDER_PAYMENT_STATE_CHANGED` on a lost final write. A later
   competing pre-read can instead produce `ORDER_ALREADY_PAID`.
5. No inventory row is needed for this manual-payment case: `markPaid` checks
   the real catalogue and updates the existing order; it makes no inventory
   call. The existing queue substitutes in `createOrderService` stay unchanged.
   This proposal restores the intended path to the existing conditional write;
   it does not add a scheduling barrier or prove that both reads overlap.

## Exact proposed test-only delta

Only the following changes inside the two named existing cases are admitted.
The unchanged Rx total assertions remain, with a full same-query lean snapshot
comparison added to catch a batch or other inventory mutation too. The
snapshot is captured immediately before invoking create, after fixture setup.

```diff
 integrationTest('only one concurrent manual payment claim succeeds', async () => {
   const pharmacy = await createPharmacy();
+  const medicine = await createMedicine('Manual payment');
   const order = await PharmacyOrderModel.create({
     pharmacyId: pharmacy._id,
     orderType: 'in_store',
     status: 'placed',
     createdById: new Types.ObjectId(),
     createdByRole: 'pharmacy',
-    items: [],
+    items: [{ medicineId: medicine._id, orderedQty: 1, unitPrice: 10, lineTotal: 10, prescriptionRequired: false, itemStatus: 'active' }],
+    prescriptionStatus: 'not_required',
+    prescriptionUrls: [],
     paymentMode: 'in_store_payment',
     paymentStatus: 'pending',
   });
```

Within `prescription medicines cannot be ordered without a prescription`,
insert the following immediately after the existing InventoryItemModel.create
call and before assert.rejects:

```ts
  const inventoryBefore = await InventoryItemModel.findOne({ pharmacyId: seller._id, medicineId: medicine._id }).lean();
```

Replace only the error predicate and add the one comparison below:

```diff
-    (error: unknown) => (error as { code?: string }).code === 'PRESCRIPTION_REQUIRED'
+    (error: unknown) => (error as { status?: number }).status === 503 &&
+      (error as { code?: string }).code === 'PRESCRIPTION_CHECKOUT_UNAVAILABLE'
   );

   const inventory = await InventoryItemModel.findOne({ pharmacyId: seller._id, medicineId: medicine._id }).lean();
+  assert.deepEqual(inventory, inventoryBefore);
   assert.equal(inventory?.availableQty, 3);
   assert.equal(inventory?.reservedQty, 0);
```

Keep both existing Promise.allSettled calls and exactly-one-fulfilled /
exactly-one-rejected assertions unchanged. No new loser-code guarantee is
introduced. No case is deleted, renamed or weakened.

## Acceptance and evidence boundaries

Before implementation, obtain two independent internal Codex contract decisions
on this exact document/hash. After implementation, bind the exact candidate
test hash and diff, verify this exact delta, verify every production pin above
is unchanged, and obtain two independent source decisions. Text-only diff,
hash and preservation checks are permitted; they establish source alignment.
They must not be labeled type validity, real catalogue admission or race proof.

Runtime acceptance is NOT_RUN. If a future separately reviewed C3 invocation
admits this suite, the Rx case must reject with both the exact status and code
and retain the complete before/after inventory snapshot plus its 3/0 totals.
The manual-payment case must use the real active non-Rx catalogue row and
explicit stored line, with one fulfillment and one rejection. Its present
Promise.allSettled shape alone does not prove simultaneous pre-reads, all
possible schedules, transaction retries or exactly-once financial effects.

The suite imports application/model/provider-capable modules at top level
before it inspects PHARMACY_TEST_MONGODB_URI. Its before hook connects before
the weak database-name-contains-test check; its final case drops the configured
database. An unset URI, selected-name skip or test-name filter does not supply
pre-import isolation. Do not run this suite, Node, a compiler, application,
SDK, Docker, database, provider, model or authentication action under this
contract. No existing smoke or pure-fixture evidence supplies that admission.
No commit, actual test edit or external model request is part of this draft.

The customer/pharmacy/lab objective continues. Corporate/HR/hospital expansion
and the final cross-module integration campaign remain DEFERRED_BY_OWNER;
focused C2/C3 checks, financial/clinical facts, supported-client, module, M0,
owner and release acceptance remain separate open gates. R8-F4-1 can become
source-repaired only after the exact test edit and independent source review;
this draft itself does not close it or any retained F1/F5 finding.
