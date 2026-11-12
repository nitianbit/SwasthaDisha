# Individual diagnostics history — bounded draft and access findings

12 November 2026. Author internal Codex `/root/payment_ctor_contract`. DRAFT_ONLY. Freeze baseline `67513f4a569d2fe5de130fc9ed6bac3314dfb120`, focus worktree `/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab`; initial trace at `4dd824ad2e6733828a779e0c78a7763315675b28`, selected lab bytes unchanged. Two actual independent NONAUTHOR contract decisions precede implementation, two fresh exact source decisions follow. No application edit, commit or execution. Preserve others, driver draft, original staged six/archive. This is next-batch preparation outside R8's completed six milestones; no R8 source refresh.

## Actual gap, without inventing an owner bypass

Graph-first getAll/getById externalBookings search returned no nodes; known swasthadisha index identifies originalbfb608e. Exact current source controls. Actual names are listBookings/getAccessibleBooking/findCustomerDiagnosticsProgress.

Normal signed customers already have req.user._id forced into list query.userId; caller userId cannot override it. Corporate/integration/status/date filters are conjunctive. No normal customer cross-account read is established. Missing/malformed trusted claims can omit downstream truthy owner filters; no normally emitted-token exploit is demonstrated and this additive slice does not repair that legacy route.

Existing owned diagnostics progress is correctly combined/projected and needs no second detail endpoint. Legacy GET `/bookings` permits unpaginated reads, broad rest-spread DTO/corporate enrichment and default-adapter filtering. It also serves consultation/report clients described in FRONTEND_REPORT_FLOW.md. Report helpers pre-read IDs before owner/kind checks and can contact providers/write files; they are not safe history helpers. Their privacy/existence/report gaps, client migration and direct/panel lab work remain separate. Association/dependent/logging/progress work is not reopened.

Ready feature: additive provider-free finite diagnostics history across stored adapters, using the existing progress DTO; leave the mixed legacy list intact.

## Minimal source and endpoint

GET `/api/v1/external-bookings/diagnostics/bookings` beside existing POST resource, under unchanged authenticate. Only six existing externalBookings index.ts files may change: routes/controller/services/repository/types/validation. Add one route/handler, one delegation, one mandatory-owner aggregate, query/page types and dedicated Joi. Reuse CustomerDiagnosticsProgress and its status vocabulary; no new row DTO, module/framework/model/index/dependency or provider policy.

For authoritative reuse, extract only the current service's exact actor-class checks into one private resolver shared by progress/history, and the repository's existing required-row validation/11-field mapping into one fixed mapper shared by both. Preserve progress owner-before-ID errors, query/projection/timeout, encodings, response and no-provider behavior. Never call its single-row read per history row or duplicate mapping. Old methods remain byte-preserved apart from imports and those two explicit extractions; no broad list/corporate/report/payment helper. Fresh review binds this refactor; earlier approvals do not approve unseen bytes.

## Closed authority/query/read

Same service actor policy as progress: missing/nonobject/array principal401 UNAUTHORIZED / Authentication is required; nonexact-user403 FORBIDDEN / Individual customer access is required. Mandatory primitive lowercase24hex signed owner; invalid owner403 FORBIDDEN / Access denied before DB. No trim/coercion/query/dependent/corporate fallback. Existing JWT/activity/revocation limits remain; account ownership is not clinical consent or staff authority.

Only page1..1000 default1/limit1..50 default20. New Joi schema validates integers/bounds and forbids userId. Common stripUnknown remains; unsupported raw filters may be stripped but never forwarded. Controller builds only page/limit and forwards req.user. Mounted auth/Joi precede service; malformed query can400 before actor403. Repository `(customerId:unknown,query:unknown)` first validates owner403, then plain non-array page/limit-only own-enumerable-data-descriptor object; symbols/accessors/unknown keys/wrong types/bounds give400 VALIDATION_ERROR / Invalid diagnostics history query. No optional owner/FilterQuery/pipeline/projection/session selector.

Exactly one ExternalBookingModel aggregate: first match signed userId string, providerType DIAGNOSTICS, and expression guards requiring both stored fields scalar strings. No array equality, ownerless prefetch or integration default/filter; include all owned diagnostics adapters, mapping unknown labels honestly. Project exactly existing progress fields. One facet counts this stream before data sort `_id:-1`, skip/limit. This is order-ID ordering, not event chronology. maxTimeMS2000,allowDiskUse:false; no joins/populate/second count/application-wide list/retry/index creation.

Validate one closed metadata/data facet, at most one safe nonnegative count, exact page length min(limit,max(0,total-skip)); beyond-end empty pages keep positive totals. Require actual scalar BSON ObjectId row IDs, signed owner and DIAGNOSTICS before shared mapping. Malformed required identity/facet503 DIAGNOSTICS_PROGRESS_UNAVAILABLE / Diagnostics booking progress is unavailable; no fabricated IDs, row dropping/repair or partial success. DB errors propagate. Count is matching stored rows, not certified clinical outcomes; malformed page rows may fail503.

## Response, evidence and retained work

HTTP200 Cache-Control private,no-store, exactly `{success:true,data:[existingProgressDTO],pagination:{page,limit,total,totalPages}}`; totalPages=Math.ceil(total/limit). Same11 fields/null/unknown encodings as progress. sampleState/reportReleaseState remain unknown. Paid/refunded/report_delivered/providerReferenceRecorded grant no capture/refund/provider-acceptance/specimen/release truth. No raw row spread, meta/patient/contact/test/result/document/provider URL/payload/payment amount. Serialize compactly, measure and send identical bytes below256KiB. Existing4096-byte progress-row bound gives50*4096+1024=205824<262144; actual HTTP measurement remains required, not scan/AR-31/100RPS acceptance.

No provider polling/report refresh/file/payment/wallet/queue/notification/write/background effects. Legacy list/report risks remain; no supported-client migration is claimed. New client uses bookingId for the already-owned progress route; no legacy response or consultation flow is removed. No lab membership, callback HMAC, human qualification or report release fact is invented.

Later focused evidence, after independent source review and separate complete C3: two-customer scalar-owner/kind rows/counts; all adapters/unknown labels; pagination/defaults/caps/beyond-end; actor/Joi/direct errors and malformed rows; exact11-field privacy/header/bytes; no provider/write/file/financial effects; preserved progress and legacy behavior after extraction. Actual-source controls must detect owner/kind/scalar removal, raw-row exposure, unbounded list and report-helper substitution. All type/HTTP/ODM/runtime checks are NOT_RUN. C2/fullC3 retained; final integration DEFERRED_BY_OWNER; direct/panel, named-owner, module/M0/deployment/release acceptance remains open.

## Exact selected pins

Preparation provenance only; recheck drift before assignment, never silently refresh a vote.

| Path | SHA-256 |
| --- | --- |
| src1/modules/externalBookings/routes/index.ts | fe3d4181c3424638cad98b2cc61bbcad5b72f48258ae1c02f76f5b3fdcbba146 |
| src1/modules/externalBookings/controller/index.ts | 360836e0d5e98223de26c5faf1777f420d1991afdce7b3f7b5bfe2eada05b041 |
| src1/modules/externalBookings/services/index.ts | aa1ac1b90f91dab278bad594d5a3a82f931cf6443fb24af819faf707c89a9a66 |
| src1/modules/externalBookings/repository/index.ts | b34199b2e0c767e309c28c6d147b6de1d5ae59bbcef363aca3668371b13d582c |
| src1/modules/externalBookings/types/index.ts | 878f539e702ee998176acbfc4c6a38b7b711d2447e4608fe14a5647b40d7e862 |
| src1/modules/externalBookings/validation/index.ts | 49c3aa3449e61655d9a34b6a201de9874e83003df8737b5aa5dfdab09bd6dcc6 |
| src1/modules/externalBookings/model/index.ts | 873239e9ebd6201cf632deafac86d76ab6a6a84b729e23332e29658a898291f1 |
| src1/modules/common/repository/BaseRepository.ts | 14a0fe5fdc9abd7a54b913bca4816a631b4bb263c11ad21ec37da0ee6c3f723a |
| src1/modules/common/middleware/validation.ts | 8be55cee7485531491ff095ed1d9f36af443987690f22d04dd67ef9318a0a5ef |
| src1/modules/middleware/auth.ts | db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2 |
| src1/routes/index.ts | 50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056 |
| documentation/planning/implementation/LAB_CUSTOMER_BOOKING_PROGRESS_CONTRACT.md | f606545cd262de4b3429165024a2b8545f50f74b7be4fae66b0da6e3dd2d0de9 |
| documentation/labstack/FRONTEND_REPORT_FLOW.md | ed137adefba27701b0d407f7ea2bcaff278da20fac3e3b59ac0e1abc37d81f75 |
| documentation/planning/SYSTEM_DESIGN.md | cbd899f6fb442b13db28c389143b529b90da364165dc17291cc829814810bc84 |
