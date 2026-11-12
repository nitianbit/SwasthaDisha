# Pharmacy stored-quality batch worklist — feature contract draft

12 November 2026. DRAFT_ONLY; author internal Codex /root/refund_error_writer. Two independent NONAUTHOR Spec/Standards decisions on these exact bytes precede source assignment. Root owns snapshot coordination/integration. The author cannot approve this contract. No source implementation or execution is admitted by it.

## Outcome and source basis

Add a useful private worklist of the signed pharmacy's embedded batches already marked recalled, quarantined or expired. Show stored quantity/expiry context needed to find the lot. This is a read feature, not a quality release, quantity adjustment, dispense, return, reservation or clinical permission. SYSTEM_DESIGN section6 retains embedded pharmacy batches; section8.1/AR-27 separates quantity from quality approval; AR-31 requires measured growth/query budgets rather than a hidden stock migration.

Graph-first discovery used swasthadisha. index_status confirms the correct original repository path at bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7. Current focus files were then verified directly. InventoryController/InventoryService/InventoryItemRepository and getLowStock/findWithPagination were discovered; the empty outbound trace is incomplete, not absence proof. Current low-stock pagination counts inventory items and returns broad item data through optional generic filters; it cannot implement this held-batch feature unchanged. Medicine name is global catalogue reference data in pharmacyMedicines, not another business's private stock.

No store timezone or approved expiry precision/cutoff exists in current pharmacy model/types. Therefore classify by stored status only. Return uninterpreted source expiry and expiryEvaluation='not_evaluated'. No UTC today, host timezone, assumed Asia/Kolkata default, Date parsing, due-soon label or derived sellability. An active batch with a past-looking date is excluded, not certified usable. Unknown expiry remains unknown. Configured local expiry classification needs its own exact policy/boundary contract.

No stock, quality, order, price, money, clinical, return, audit-history or provider mutation. No organization/branch mapping or individual staff grant is invented. The new staff resolver remains closed/provisioning-pending; this existing business-account inventory read confers no pharmacist authority. Corporate/HR/hospital expansion and final cross-module integration remain deferred.

## Minimal source and endpoint

Only six existing src1/modules/pharmacyInventory files may change:

| File | Addition |
| --- | --- |
| routes/index.ts | GET /quality-holds before /:id, requireOperationalPharmacy, dedicated query schema, catchAsync. |
| controller/index.ts | One handler using only guard-resolved signed pharmacyId and explicit query fields; new narrow response. Do not call sanitizeInventoryItem, which has broader fields and legacy UTC logic. |
| services/index.ts | One getQualityHolds delegation; no duplicated filter/count/expiry algorithm. |
| repository/index.ts | One findQualityHolds with mandatory own-pharmacy scope, closed parameters and restricted read aggregate/DTO mapping. No caller FilterQuery/pipeline or optional-scope BaseRepository call. |
| types/index.ts | One closed status tuple reused by validation/query logic, narrow query/row/page DTOs. Reuse InventoryBatchStatus through a narrowed type. |
| validation/index.ts | One qualityWorklistQuerySchema; existing inventoryQuerySchema unchanged. |

No new module/framework, model/index/auth/root dependency/start change, inventory writer edit, archiving or migration. Existing routes/public/low-stock behavior stays byte-preserved. Compact diff/hash/actual review evidence is enough for source review; no copied controllers or lexical mirror-test framework.

Route: GET /api/v1/pharmacy-inventory/quality-holds. The existing central mount authenticates before this router. Reuse requireOperationalPharmacy BEFORE query validation: existing missing-principal401, nonpharmacy403 and inactive/unverified business errors retain their exact messages/order. No admin bypass. This guard reloads the business and sets pharmacyId; its existing default/null/status semantics and long-lived token limitations are unchanged, not newly certified.

The controller forwards only that resolved req.user.pharmacyId; no second fallback to query/body, actor _id, corporate, organization or branch. The repository requires a primitive lowercase24-hex pharmacyId; absent/nonstring/blank/malformed scope rejects403 FORBIDDEN / Access denied before aggregate construction. Never silently generate an ObjectId for absent scope.

Only query: qualityStatus optional one of recalled/quarantined/expired; page integer1..1000 default1; limit integer1..50 default20. Omitted qualityStatus selects all three. Define the closed list once. The direct repository query must be a non-null, non-array plain object (Object.prototype or null prototype), with only qualityStatus/page/limit own keys; missing optional fields use the stated defaults. Invalid direct shape, unknown own keys (including symbols/non-enumerables) or typed values reject400 VALIDATION_ERROR / Invalid quality worklist query before inventory access. Joi retains the common validation envelope and declares pharmacyId forbidden; earlier Joi messages can win. Shared stripUnknown remains, so do not promise every raw extra query key gives400. No item/batch/medicine selector, search, includeBatches, isActive/sort override, arbitrary operator/filter or export. Explicit fields and restrictive query construction must prevent raw extras from broadening scope.

An authorized pharmacy with no matching own batch occurrences gets200 data=[], total=0,totalPages=0. A valid beyond-end page on a nonempty matching data set returns data=[] while retaining its actual positive total and totalPages; page emptiness never resets the count. Other pharmacies never contribute data or counts. There is no preliminary foreign-record lookup or new detail-existence oracle; existing detail403/404 behavior is outside this feature. Guard business reads/logs can precede query denial: no zero-total-I/O claim.

## Rows, aggregate and exact projection

One row is one stored embedded batch occurrence with exact selected status. Count batch occurrences, not inventory items, medicines or units. Include inactive items and zero-quantity holds; deactivation/quantity cannot hide a recall. Active/depleted/unknown statuses and absent/empty/non-array batches contribute no rows. Do not synthesize batches from aggregate counters.

Use one aggregate:

1. First match mandatory pharmacyId as the validated own ObjectId plus an embedded selected-status prefilter and explicit $expr:{$isArray:'$batches'} before unwind. Absent/null/scalar-object batches are excluded; Mongo unwind treating a scalar as one element must never create a worklist row. No caller criteria spread or optional scope.
2. Project only required item/batch source fields, unwind actual batches with includeArrayIndex=batchPosition, and match the selected stored status AGAIN. An item prefilter alone would include its active sibling batches.
3. One facet from this same filtered stream: metadata count BEFORE pagination/catalogue join; data sorted item _id ascending then batchPosition ascending, skipped by (page-1)*limit, limited to limit. Never paginate items before unwind, sum quantities, or load the complete list into application memory.
4. After the page bound, at most one global medicines _id lookup per row may supply name only through an explicit projection. Preserve rows/count when the catalogue reference is missing; no destructive unwind or private business/patient join.
5. Construct only the following safe DTO, never return/spread a raw item, medicine or batches array.

HTTP200 {success:true,pharmacyId,expiryEvaluation:'not_evaluated',data:[rows],pagination:{page,limit,total,totalPages}}. pharmacyId is exact own scope; total is nonnegative safe integer; totalPages=Math.ceil(total/limit), zero when total0; data.length <= limit. No estimated/truncated count.

| Row field | Meaning / encoding |
| --- | --- |
| inventoryItemId | Actual item ObjectId as lowercase24-hex; malformed required identity makes response unavailable. |
| medicineId | Actual referenced ObjectId as lowercase24-hex, otherwise null. |
| medicineName | Global catalogue name string at most200 UTF-16 code units, otherwise null. |
| inventoryIsActive | Stored boolean, otherwise null; display context only. |
| rackLocation | Exact stored string at most100 UTF-16 units, otherwise null. |
| batchId | Actual embedded ObjectId as lowercase24-hex, otherwise null. Not certified unique. |
| batchPosition | Nonnegative safe integer array index at this read; not a durable lot identity/writer key. |
| batchNumberRaw | Exact stored string at most100 UTF-16 units, otherwise null. No trim/synthesis. |
| expiryDateRaw | Exact stored string at most32 UTF-16 units, otherwise null. No date validation/precision/timezone interpretation; null does not mean unexpired. |
| storedQualityStatus | Exact selected recalled/quarantined/expired stored value. |
| availableQty,reservedQty,freeQty | Each original nonnegative safe-integer JavaScript number, otherwise null. No BSON/string Number coercion, rounding, inferred zero, summation or subtracting reserved twice. Not newly certified usable stock/conservation. |

No purchase/retail/wholesale/MRP, supplier/customer, order/reservation, creator, document URL or clinical fields. Nullable malformed scalars remain unavailable rather than leaking arbitrary objects. Overlong source strings become null, never a partial exact identifier. Missing/duplicate batch IDs do not drop a hold: retain item and position for later authorized reconciliation. Malformed required item identity, batch position, facet shape or count rejects whole response with503 QUALITY_WORKLIST_UNAVAILABLE / Quality worklist is unavailable, without raw data/error echo or partial success. Database errors retain existing middleware handling; no automatic retry/broader fallback.

The common facet avoids separate data/count filter drift; it is not a transaction snapshot across client pages. Array edits between offset pages can duplicate/skip rows. Ordering is deterministic only for unchanged data, not a durable export/reconciliation protocol. This read does not repair dirty data or authorize quality release.

## Cost, effects and focused acceptance

Use existing pharmacy index/embedded layout; install no new indexes. One aggregate has maxTimeMS=2000 and allowDiskUse=false, at most50 narrow returned rows and one count. The fixed row fields and string/scalar limits permit a conservative compact UTF-8 JSON bound of4096 bytes per row including its separator plus1024 bytes for the fixed envelope/pagination: 50*4096+1024=205824 bytes, below256KiB (262144 bytes). Six escaped bytes per UTF-16 code unit covers controls/lone surrogates; valid pairs/BMP/quote/backslash encodings are smaller. The exact data-only reference witness and arithmetic are in output/qa/pharmacy-quality-worklist/contract-review-1/BOUNDS_DATA.json. No second serialization is needed when the exact field/encoding construction is preserved. No added fields, indentation, custom replacer or changed string limits are admitted without a new bound; actual focused checks must measure the emitted response. These calculations are not HTTP/TypeScript evidence. No $out/$merge, executable JavaScript, writes, index operations, startup job, provider/queue/background effect, unbounded retry or disk-spill fallback. These are selected development budgets, not measured production capacity. Count/facet still scans matching own batches; representative long-lived-item explain/time/byte/memory observations remain necessary under AR-31. Existing Mongo document/facet limits are not a chosen business batch cap. No AR-31/100RPS acceptance or batch archiving follows.

All TypeScript/compiler/Joi/HTTP/Mongoose/DB/provider behavior remains NOT_RUN. Two nonauthor contract decisions precede source assignment; two nonauthor implementation/composition reviews precede source-only acceptance. Any actual checks require separately frozen source/import/config/effect closure, bounded launcher, owned fixtures/recording ports and cleanup under C3. Pure438/nine, historical smoke and model reviews supply no new execution admission. No source/hash match substitutes for feature behavior.

Required later focused observations:

- Two pharmacies, multiple items and held/active siblings: exact own rows/counts for default union and each filter; inactive items/zero quantities included; foreign rows/counters undisclosed and unchanged.
- Empty/beyond-end/pages/caps/tied items/array positions: counts are batch-based before page/lookup, nonempty beyond-end pages retain positive totals, scalar-object batches are excluded before unwind, active siblings are excluded and unchanged-data ordering is deterministic; missing medicine references preserve row/count with null name. Measure the50-row worst-escaped response against the declared byte bound.
- Exact field allowlist and null encoding for malformed/overlong/Unicode source values, missing/duplicate lot IDs, invalid quantity types/nonfinite/negative/fractional/unsafe values; malformed required identity/count follows the fixed unavailable error. No private-field leak, fabricated ID or quantity repair.
- Stored expired with future-looking raw date still matches; active with past-looking date is excluded; recalled/quarantined status survives positive/zero quantities. No date/UTC clock evaluation or new quality transition.
- Missing/invalid JWT, every nonpharmacy role including admin, inactive/unverified/missing business, invalid signed scope and forged query scope/operator/status/pagination: measured guard/Joi/direct-method precedence; no broadened query/foreign existence probe.
- Actual first/post-unwind predicates, common facet/count, bounded name-only lookup and timeout/no-spill settings. All source documents unchanged; zero save/update/delete/stock/reservation/quality/payment/coupon/provider/queue effects, with actual reads/logs recorded honestly.
- Actual-source controls removing pharmacy scope, dropping post-unwind match, counting/paginating items, deleting missing-name rows, exposing prices/batches or adding UTC classification must fail for the intended behavioral reason, not solely a hash mismatch.
- Representative owned long-lived batch dataset with explain/time/bytes assesses the stated budget; timeout does not authorize relaxing bounds or operational-data access.

C2 dependency/runtime/start, full C3, supported clients, clinical/security, module/M0 and release gates remain. Final integration stays DEFERRED_BY_OWNER. This is one useful pharmacy feature, not module completion, quality-release acceptance or F1 resolution. No protected data, provider resources or credentials were accessed. Author stops after this draft/read-only binding checks; no source/import/Node/compiler/DB/provider/model call or Git mutation.

## Exact selected bindings

Observed focus HEAD: de2818a71c8401f13a0eb3debbf9318f5baeb876. Selected static provenance only; recheck before implementation without silently changing a review snapshot.

| Path | SHA-256 |
| --- | --- |
| documentation/planning/SYSTEM_DESIGN.md | cbd899f6fb442b13db28c389143b529b90da364165dc17291cc829814810bc84 |
| documentation/planning/ARCHITECTURE_REVIEW.md | 332a676e9ddd05bff38124ca34f9a11c3cb082e6c9a6611f4f640a8ce79b304b |
| documentation/planning/implementation/CUSTOMER_PHARMACY_LAB_PLAN.md | b3fe87439052e8b22975e736016e8739dd8948192899a7e26be150aa4c7a2978 |
| src1/modules/pharmacyInventory/routes/index.ts | 3bd5e0572b21557a7ae26fbbfba44d2130d1870bb864608f73f7ff1db08fd55e |
| src1/modules/pharmacyInventory/controller/index.ts | 370d8b81d4b50e41bfe1d063faec9dadb5c11a1220b2fb0f8fbfaa8aab8a4864 |
| src1/modules/pharmacyInventory/services/index.ts | bb02c3bf808ad4101a156be755bb39d26e6585ee1fcfaa5d12cb0000f5efee06 |
| src1/modules/pharmacyInventory/repository/index.ts | 2cc825908777950cbfcf1cf4dea6cc12f0e6e97a41660fb413565db3fdd6e659 |
| src1/modules/pharmacyInventory/types/index.ts | 83aba7263dd3a97315b63d36ed24f39b9932a6ae578219b35c0b082f20e744c4 |
| src1/modules/pharmacyInventory/model/index.ts | 098fc86bc14e553b60a81fdb7bf33ebacb8c44f799a2cb665420ea5debe52313 |
| src1/modules/pharmacyInventory/validation/index.ts | 2d7df1818275403597684003fdca3f4edb54efeb3dd4b362a4baa45b2f237fd6 |
| src1/modules/middleware/auth.ts | db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2 |
| src1/modules/common/middleware/validation.ts | 8be55cee7485531491ff095ed1d9f36af443987690f22d04dd67ef9318a0a5ef |
| src1/modules/pharmacies/model/index.ts | beda95d89a9773a8d5851dd923c363c83123a573f7391836dec69b13e5cfa177 |
| src1/modules/pharmacies/types/index.ts | e43d4c6e5af5ebc9a21e3a35d41e475e92ab7509961cdafe6bfc3043af0b24f0 |
| src1/modules/pharmacyMedicines/model/index.ts | 2dd98cd59a4e9a3aaa156d917f7cc131d7e30c7546ad7296b8a0ca4920c70725 |
| src1/routes/index.ts | 50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056 |

Authoring readback note: the first data-only binding attempt used an incorrect medicine-model path and stopped before any writes. Graph discovery located pharmacyMedicines/model/index.ts; its actual global schema was read and the corrected binding is above. No source/runtime or Git operation followed from that preparation error.

Contract amendment1: both nonauthor reviews requested changes on c0725016. Its exact draft and actual decisions are preserved under output/qa/pharmacy-quality-worklist/contract-review-1/. Maximum limit is now50 (default20 unchanged), scalar batches are explicitly excluded before unwind, and beyond-end positive counts remain truthful. Two fresh nonauthor approvals remain required; no source or runtime admission follows.
