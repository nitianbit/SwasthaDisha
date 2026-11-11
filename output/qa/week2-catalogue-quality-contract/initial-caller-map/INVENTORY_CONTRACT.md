# Inventory quantity operations preserve existing quality restrictions

11 November 2026. ROOT CONTRACT CANDIDATE; two independent direct internal
technical implementation-only decisions required before source edit. No runtime
admission. Others share this repository; preserve all edits, six staged files,
eleven handover files, approvals, failures and prior results. Root owns Git,
integration, final contracts and evidence. No root dependency/runtime/build/start,
provider, deployment, secrets, live data or external account action.

Approved policy: documentation/planning/M0_IMPLEMENTATION_APPROVAL.md, current
command authority table catalogue/stock and stable422 migration rule;
documentation/planning/SYSTEM_DESIGN.md AR26 and AR27/31;
documentation/planning/PRINCIPAL_REVIEW_DISPOSITION.md Review-B PA07/PA09/PA20;
documentation/planning/qa/TEST_SCENARIOS.md TC-REV-006. Current actor/field policy
already exists; these slices enforce it without selecting new clinical release,
price, tax, units, race, idempotency, ownership or finance policy.

Only source-data checks (Python/JSON/source bytes/diffs) are admitted. No domain,
Joi, TS, extracted/copied application helper, parser/compiler, app/server, DB,
Docker, provider or model/auth execution. Baseline rejection before source edit,
exact whole-file transform/scope and meaningful weakened-source sensitivity
controls must be retained. Scope must survive commits: explicit exact non-QA
file union and owned QA paths, no precommit/untracked-file assumption. Never
claim source text controls prove behavior or types. Complete later C3 must cover
actual route/service/ODM/provider/model closure before real application tests.

After implementation, freeze exact source/QA/check commands and obtain independent
Standards and Spec nonauthor source reviews; fix material findings and have both
confirm final bytes. Commit coherent bounded result and update progress with
SOURCE_ONLY limitation. No mutation of the original115 register, false PASS,
whole M0/Week2/C2, supported-client, human owner, production or release claim.
The currently accepted83/27 fixture and pending specialist90/33 do not import
these modules; neither supplies clinical/catalogue/inventory runtime evidence.

## Exact source and preserved algorithms

Baseline1355bd9af2c9d8d5170527c8c0fc565de997b6fe. Own ONLY
src1/modules/pharmacyInventory/repository/index.ts and new
output/qa/week2-inventory-quality-source/. No imports/types/models/quantity math,
source inputs, transaction/session options, caller, schema/route, date, pricing,
reservation, movement, ledger or quality-release command changes.

Inside InventoryItemRepository.adjustBatchStock, wrap only the existing adjacent
batch.status assignment and batch.depletedAt assignment in a condition which
skips both assignments if pre-existing status is exactly recalled, quarantined
or expired. In releaseBatchAllocations wrap only its corresponding adjacent two
assignments with the same condition. Preserve that status/depletedAt pair exactly
for these three restrictions regardless of resulting quantity, past/future expiry
or existing/absent depletedAt. An expired date must not erase an explicit recall
or quarantine marker, and a future date cannot reactivate an already expired
marker. No automatic release or correction of inconsistent historical state.

For active/depleted and all other prior states, keep both original assignments
byte-identical inside the new condition: adjust picks depleted iff resulting
available and reserved are zero otherwise active, timestamp as before; release
picks expired iff expiryDate<today else active and clears depletedAt as before.
New batches still start active and use the same existing adjustment logic.
No other statement moves or changes; whole-file inverse must reconstruct exact
baseline. Quantities/counters/prices/reorder/rack/document.isActive/markModified/
save/session/results/null guards/expiry comparison remain exact. Preserving an
existing quality marker does not claim all consumers/public projections/usable
quantity semantics are correct. reserveBatches already filters active/nonexpired;
consumeBatchAllocations already rejects nonactive; their code stays unchanged.

Callers: PharmacyInventoryService.saveItem and inventory import processing call
adjustBatchStock; releaseOrderStockBulk (from PharmacyOrderService) calls release.
These existing callers need no signature/DTO change. Stock race/idempotency,
quality-release policy and full F06/AR27/31 remain separately gated.

Required future real grid: each recalled/quarantined/expired × positive/zero/
negative allowed adjustment × resulting zero/nonzero/reserved combinations,
with present/absent depletedAt; each restriction × reservation release past/
future expiry × present/absent depletedAt; active/depleted and newly created
batch positives preserve original transition/timestamp behavior; existing null/
underflow/missing batch/insufficient reserved/save-session paths stay exact.
Assert actual persisted status+marker, unchanged quantities/counters/prices/
other fields except existing allowed math, all siblings untouched, no provider
or quality-release event. NOT_RUN pending separate complete C3. Static controls
remove each restriction independently in each guard, remove one/both guards,
mutate their branch sense, protect status but clear marker, alter original
normal-state math or unrelated code; all must be source-rejected. Do not execute
copied/extracted mutation logic or application code as a host test.
