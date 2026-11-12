# Pharmacy recovery-request worklist — bounded contract draft

12 November 2026. Author internal Codex `/root/payment_ctor_contract`. DRAFT_ONLY: two actual independent NONAUTHOR contract decisions precede source assignment; two fresh nonauthor source decisions follow implementation. Root coordinates integration. This document authorizes no application edit, commit or execution.

Baseline: focus `cc5be9a74badf74c6028d1e7e86b74978bf7641d`, worktree `/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab`. Graph-first searches were attempted; current recovery/quality symbols were absent. `list_projects` identifies `swasthadisha` at original checkout `bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7`; exact current files control this draft. No reindex or absence-of-callers claim. Preserve others' files, including the untracked driver-preflight draft, original staged six and handover archive.

## Outcome and authority

Make existing embedded customer recovery requests discoverable to the owning operational pharmacy for commercial triage. Reuse the intake contract, existing `recoveryReceipt` validation/digests, and stored-quality worklist guard/pagination conventions. SYSTEM_DESIGN section5 requires scoped minimum access; read visibility does not establish pharmacist, finance, clinical or refund authority. No funding, collection, capture, custody, reservation, money owed or recovery completion is inferred from order/payment labels or this marker.

GET `/api/v1/pharmacy-orders/recovery-requests`, placed before `/:id`, uses existing central authentication, `requireOperationalPharmacy`, then a dedicated query validator and thin handler. Preserve that guard's exact missing-principal401/nonpharmacy403/inactive/unverified ordering and messages; no admin bypass. Forward only its resolved `req.user.pharmacyId`, never query/body/actor-ID/organization fallback. Existing guard reload semantics and token/membership limitations remain unchanged. This business-account read introduces no individual staff grant or assigned finance queue.

Only six existing pharmacyOrders files may change: routes, controller, services, repository, types and validation `index.ts`. Add one route/handler, one service delegation, one narrow repository read, query/page types and a row extending the existing `PharmacyRecoveryReceipt` with `orderId:string`, plus the dedicated Joi schema. No new module, model/schema/index, collection, framework or dependency. Existing intake/customer GET, transaction/session implementation, digest validator, general order reads and every writer remain byte-preserved apart from necessary imports/additions.

## Closed query and read

Only `page` integer1..1000 default1 and `limit` integer1..50 default20. Joi declares `pharmacyId` forbidden; common stripUnknown stays, so arbitrary raw extras are not promised rejection and cannot broaden the explicit construction. The direct repository method accepts `(pharmacyId:unknown, query:unknown)`: nonprimitive/noncanonical-lowercase24hex scope gives403 `FORBIDDEN` / `Access denied` before model access. Query must be a non-array plain object with only own data-descriptor page/limit keys (Object.prototype or null prototype); symbols, accessors, non-enumerable/unknown keys and wrong typed/bounded values give400 `VALIDATION_ERROR` / `Invalid recovery worklist query`. Preserve exact validated scope, no trim/coercion/default ObjectId.

Use exactly one `PharmacyOrderModel.aggregate`:

1. First `$match` is `pharmacyId:new Types.ObjectId(pharmacyId)`, `recoveryRequest:{$exists:true}`, and `$expr:{$eq:[{$type:'$pharmacyId'},'objectId']}`. No caller spread/filter, optional scope, ownerless pre-read or lookup. Array-valued owners cannot contribute. Include requests regardless of current order/payment/prescription status; no pharmacy-commerce gate or clinical classification.
2. Project only `_id,pharmacyId,customerId,recoveryRequest`. One facet counts this same own marker-bearing document stream before pagination; data sorts `_id:1`, skips `(page-1)*limit`, then limits. This is deterministic order-ID ordering, not request age, urgency or assignment. No unbounded application list, second count, population, joins, transactions, writes or retries.
3. Execute with `maxTimeMS:2000,allowDiskUse:false`. Validate exactly one facet with exact metadata/data keys, at most one exact safe nonnegative count, and `data.length === min(limit,max(0,total-skip))`. Empty beyond-end pages retain positive totals. Count means own documents with an existing marker, including malformed markers; it is not a certified count of valid obligations.
4. For every page row, require exact projected keys and actual scalar `Types.ObjectId` order/customer/pharmacy identities, with pharmacy hex equal to scope. Pass the full stored marker and canonical order/customer IDs through the unchanged `recoveryReceipt`. Construct an explicit DTO; do not spread/return the raw row or marker. Missing/malformed identity, null/array/unknown-version/conflicting marker, bad digest or malformed facet gives existing503 `PHARMACY_RECOVERY_UNAVAILABLE` / `Pharmacy recovery is unavailable`. Do not silently drop/repair a bad page row, manufacture identity or fall back to general order listing. Thrown database errors propagate under existing middleware.

## Minimum response and limits

HTTP200, `Cache-Control: private, no-store`, exactly `{success:true,data:[rows],pagination:{page,limit,total,totalPages}}`; `totalPages=Math.ceil(total/limit)` and zero for total0. Each row has exactly eight fields: `orderId` plus the existing seven receipt fields `operationId,status,requestedAt,amountMinor,currency,instrument,destinationPolicy`. Canonical orderId; deterministic operationId; ISO requestedAt; status `reconciliation_required`; amountMinor/currency null; instrument `unknown`; destinationPolicy `original_instrument`. No customer/patient/pharmacy IDs, raw order, snapshots, documents, payment references, gateway IDs, prices or free text. Null is unknown, never zero; destinationPolicy is a recorded policy label, not a funded payout promise.

All emitted strings are fixed labels or canonical IDs/ISO date bounded by the existing validator. Require compact serialization and body below64KiB; conservative bound50*1024bytes per closed row +1024 envelope =52224bytes <65536. This response bound is not a bound on all database scan work or malformed stored-document size. Mongo size/timeout failures remain errors; no disk-spill or budget widening fallback. No index creation or measured AR-31/100RPS capacity claim.

No claim, acknowledgment, assignment, status transition, refund calculation/payment/wallet/ledger/stock/reservation/coupon/prescription/notification/provider/file/queue/worker effect. This makes requests findable; accountable staffing, protected resolution commands, verified funding/original instrument, clinical qualification and atomic cancellation/refund recovery remain separate prerequisites. No request is resolved by later payment/order changes; observation truth remains historical. Existing raw authorized order DTO/privacy residuals remain. Existing read-time owner predicates do not fence later reassignment or revocation; no cross-request snapshot/atomicity promise.

## Required later evidence

All behavioral/type/HTTP/Joi/ODM/DB checks remain NOT_RUN. After source review and separate full C3 admission, observe two-pharmacy rows/count isolation; default/min/max/invalid/beyond-end pages; guard and query precedence (business reads can precede query denial); absent markers; owned malformed markers/identity/digests yielding503 without partial DTOs; null/unknown amounts and exact eight-field privacy; stable ordering on unchanged data; unchanged customer replay receipts/writers; actual read predicates/facet/time/no-spill options; worst-case response bytes; zero writes/provider effects with honest read/log counters. Controls removing owner/scalar guard, changing count/page order, hiding malformed rows, leaking raw fields or inferring money must fail the intended focused observation.

Two exact nonauthor contract/source decisions remain mandatory; no source hash or lexical check proves runtime behavior. No Node/compiler/app/SDK/Docker/DB/provider/model/test invocation is admitted here. C2 dependency/runtime/start and full C3 remain; final integration is DEFERRED_BY_OWNER. No F1/module/M0/clinical/financial/security-owner/deployment/release acceptance. No missing human qualification or funding fact is invented; neither is needed merely to draft this bounded commercial read.

## Selected exact source/design pins

These are preparation provenance, not an execution closure. Recheck drift before assignment; never silently refresh a vote.

| Path | SHA-256 |
| --- | --- |
| documentation/planning/SYSTEM_DESIGN.md | cbd899f6fb442b13db28c389143b529b90da364165dc17291cc829814810bc84 |
| documentation/planning/implementation/PHARMACY_CANCELLATION_RECOVERY_CONTRACT_DRAFT.md | e43bb8170b644cdc93ceeae9d8f66e8abb739f1cb35079e1076147aa88b4e910 |
| documentation/planning/implementation/PHARMACY_QUALITY_WORKLIST_CONTRACT.md | 710f300d1d335540599a912fcec1582ce6c7d636cc9a5f20a386615bbb9c12ee |
| src1/modules/pharmacyOrders/routes/index.ts | 7ea281b035ecffa82efdc6d530d3a7f06ddb8e8b0772e6f3a1cc1f5d3f18739a |
| src1/modules/pharmacyOrders/controller/index.ts | 4b597ec56652d8d2972cd3c0fb0756772f6c2322bdf0c69b608b302bdc33c14d |
| src1/modules/pharmacyOrders/services/index.ts | 66265f3912d8ebb76aa6c565f3dc9dc0389a4e9fad1bed38b17be0d3578df8bc |
| src1/modules/pharmacyOrders/repository/index.ts | e22c4957a6ffecc82bd6a81a46f7c7c1de358bfb674bc4355b55fbf840fb52e6 |
| src1/modules/pharmacyOrders/types/index.ts | f453c8665c6c646b3b17c90dfa0be50cffb0775d74b9a95b70c92be51623d5d2 |
| src1/modules/pharmacyOrders/validation/index.ts | 6c4d01ebcb9db52c88bc8b0883dc679816f6b232a2c53ee5819d8f9e6f5afd64 |
| src1/modules/pharmacyOrders/model/index.ts | f054a220020c66a83c49ea8658bd0d002cb3a9fd28c9b7771b0584c53471ac14 |
| src1/modules/pharmacyInventory/repository/index.ts | cee64fd2464b5d5ac6081531a63f9a176e5fc481f33c3a4d6def99a26d97b261 |
| src1/modules/pharmacyInventory/validation/index.ts | f1679413efcd27621a362eda7277a3d0db3edceb8d30fc2c542c075bef8dec53 |
| src1/modules/middleware/auth.ts | db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2 |
| src1/modules/common/middleware/validation.ts | 8be55cee7485531491ff095ed1d9f36af443987690f22d04dd67ef9318a0a5ef |
| src1/routes/index.ts | 50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056 |
