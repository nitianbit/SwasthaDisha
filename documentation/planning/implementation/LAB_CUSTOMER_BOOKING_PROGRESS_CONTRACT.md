# Individual customer diagnostics booking progress — contract draft

12 November 2026. DRAFT_ONLY. Author internal Codex /root/pharmacist_identity_fields. Root coordinates integration; other workers are active. Two independent NONAUTHOR Spec/Standards approvals of these exact bytes precede application edits. This contract admits no execution or activation and is not module acceptance.

## Bounded design need and reuse comparison

Provide one ordinary individual customer with a small, provider-free view of the currently stored progress of one own external diagnostics booking. Opening its progress view must not fetch a report, contact a lab, mutate a booking or turn a stored label into a verified clinical/financial fact. This advances the API-connected customer order/status journey in ROADMAP U4, CAPABILITY_MATRIX D01/D02 and SYSTEM_DESIGN sections8.3/10. It does not complete the direct/panel staff journey.

Graph-first navigation used swasthadisha; index_status identifies original checkout bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7, not the current focus worktree. Exact current source supplied the comparison below. No network/provider probe or client execution occurred.

| Existing surface | Actual reuse or difference |
| --- | --- |
| GET /api/v1/bookings/:id | BookingController.getById -> BookingService.getById -> BookingRepository/BookingModel reads the separate Booking collection. It does not retrieve ExternalBooking diagnostics. Preserve this route and its reviewed customer owner rules unchanged. |
| GET /api/v1/external-bookings/bookings | Existing list returns local status but loads broad external booking records, has paginated/unpaginated paths and corporate enrichment. Reuse its existing model/status vocabulary, not its broad list algorithm for a single bounded detail. Do not add another list or global filter rewrite. |
| GET /diagnostics/bookings/:id/report and /report/document | getDiagnosticsBookingReport/Pdf contact Healthians/LabStack; PDF persistence can write files/metadata. They are report delivery, not a provider-free progress read. Preserve their contracts; do not call them from the new method. |
| GET /bookings/:id/reports | getSavedReports may return cached URLs, or fetch/persist reports and update booking metadata. It is not an effects-free status helper. |
| documented app flow | documentation/labstack/FRONTEND_REPORT_FLOW.md describes list -> report metadata -> document. There is no existing standalone single-booking progress endpoint. Add a separate progress read without changing this legacy report flow or promising that its unsafe public URLs are fixed. |
| documented direct/panel flow | BUSINESS_OPERATIONS sections2/4 and ROADMAP U4 require direct/no-app registration, assigned lab staff, sample handling, private billing and signatory release. There is no current assigned lab/branch/fulfilment authority aggregate or enabled lab membership adapter. A customer progress read must not impersonate that workbench, require an app login for direct patients or drop the direct workflow from scope. |

Targeted client-manifest/component inventory in this checkout found only the backend root package.json, no identified Flutter/React/Vue app/POS/panel implementation. These documents specify client requirements; they do not prove delivered clients, and external client repositories were not inspected. Supported-client acceptance remains open.

## Source scope and endpoint

Only five existing src1/modules/externalBookings files may change: routes/index.ts, controller/index.ts, services/index.ts, repository/index.ts and types/index.ts. One additive route, thin controller, actor-checking service delegation, mandatory-owner projected repository read and narrow DTO are sufficient. No new module/framework/model/index/dependency, validation framework, shared auth/RBAC, provider/status engine, background worker or copied service. Existing imports may expand only as needed for these additions. All old methods/routes/writers and their behavior remain byte-preserved apart from those import additions.

New GET /api/v1/external-bookings/diagnostics/bookings/:id/progress. The existing central external-bookings mount runs authenticate. Register the specific progress route adjacent to diagnostics report routes; no existing route is removed or shadowed. No public/optional-auth mount. No query/body fields are supported or forwarded; raw extras, including userId/corporateId/integration/labId/dependentId, are ignored and cannot select a target, field, provider or scope. There is no new filter/list/export interface and no new Joi schema or modification of shared stripUnknown behavior.

Controller passes only req.user and req.params.id to the new service and emits its exact DTO. It must not derive identity from query/body, look up a corporate, call existing broad sanitizers/list/report/payment helpers or add logging. The service enforces actor class before resource validation/query. Missing/nonobject principal ->401 UNAUTHORIZED / Authentication is required. Any userType other than exact user, including admin/pharmacy/HR/specialist and any prospective lab role ->403 FORBIDDEN / Individual customer access is required. Existing authenticate token errors/messages take precedence on the mounted HTTP path; do not claim this service verifies signatures itself.

The signed principal _id must be a primitive lowercase24-hex string; absent/malformed/nonstring scope ->403 FORBIDDEN / Access denied before database access. No actor/customer/phone/dependent/corporate fallback. This is existing account-owned booking metadata, not new patient/caregiver consent, staff tenancy or clinical-record access. Account activity/token-revocation limitations of existing authentication remain explicit and are not newly certified. A signed employer association grants no additional scope and is neither consulted nor expanded; a customer's own existing booking is not reclassified by this read.

The repository accepts only the mandatory customer ID and booking ID, never optional scope, caller FilterQuery, projection or pipeline. It independently rejects invalid scope403 before constructing a query. Booking ID must be a primitive lowercase24-hex string; malformed ->400 VALIDATION_ERROR / Invalid diagnostics booking ID. Do not trim/coerce arbitrary values or create ObjectId from absent input.

One read from the existing ExternalBookingModel with combined predicates: _id equals the validated actual ObjectId, userId equals signed customer string, providerType equals DIAGNOSTICS, and expression type guards require stored userId/providerType to be scalar strings. Array-valued malformed ownership/type fields must not match via Mongo array equality. No preliminary findById/foreign lookup, current-user/corporate lookup, populate, provider request or optional-scope BaseRepository helper. Use a literal allowlisted projection: _id,userId,providerType,integration,bookingDate,bookingTime,status,paymentStatus,externalBookingId,updatedAt. No meta/report URLs, patient/dependent/contact/address/test/package/financial reference fields. Use a lean bounded single-record read with maxTimeMS=2000; no new index creation, scan fallback, retry or operational explain invocation. Its _id access/timeout/cost still needs admitted actual evidence.

No match, foreign-owned or non-diagnostics ->404 EXTERNAL_BOOKING_NOT_FOUND / External booking not found, identically. Do not distinguish another owner's existing record, consultation kind or lab assignment. A returned row with malformed required _id, changed/mismatched owner or providerType ->503 DIAGNOSTICS_PROGRESS_UNAVAILABLE / Diagnostics booking progress is unavailable without raw data/error echo. Database errors retain existing middleware handling; no claim of zero total application I/O, because authentication/construction/log middleware may already run.

## Exact response and status truth

HTTP200, Cache-Control: private, no-store. Body exactly {success:true,data:{...the11fieldsbelow}}. Construct each field, never spread a raw record. Maximum compact UTF-8 JSON body4096bytes with these fixed keys/scalars, three bounded date/time strings and closed labels; no indentation/replacer/additional fields without a reviewed bound. Actual emitted response/header checks remain required. No report URL, provider URL/payload/error, prescription/result value, patient identity, phone/email/address, financial amount or token is returned.

| Data field | Exact meaning/encoding |
| --- | --- |
| bookingId | Actual matching BSON ObjectId encoded lowercase24hex, never fabricated/caller echoed without validating the returned row. |
| integration | Exact stored labstack or healthians, otherwise unknown. This identifies the existing adapter label, not assigned lab/branch or verified provenance. |
| bookingDateRaw | Exact stored string matching eight ASCII digits, otherwise null. No calendar/date/cutoff/timezone interpretation. |
| bookingTimeRaw | Exact stored nonempty string at most32 UTF-16 units, otherwise null; no parsing/truncation/format synthesis. |
| bookingStatus | Exact stored member of created,pending,pending_payment,confirmed,completed,cancelled,rescheduled,report_delivered,phlebo_assigned; otherwise unknown. Define one closed new progress vocabulary, reusing an existing status type where compatible. Do not call normalizeWebhookStatus or map arbitrary substrings into evidence. |
| paymentStatus | Exact stored pending,paid,cancelled,refunded, otherwise unknown. Informational legacy label only, not verified capture/refund/receipt/budget proof. No amounts/units are exposed or converted. |
| providerReferenceRecorded | true for a nonblank stored externalBookingId string of at most512 UTF-16 units; false for missing/null or an empty/whitespace-only string of at most512 units; null for any other malformed/overlong value, including an overlong whitespace-only string. Return no external ID. Presence is not provider acceptance/fulfilment, including when status says confirmed. |
| sampleState | Always unknown. Local labels such as phlebo_assigned/completed do not establish specimen identity, collection/receipt or rejection/recollection lineage. |
| reportReleaseState | Always unknown. report_delivered and stored URLs do not establish immutable report completeness, signatory verification, release or permission to download. Do not enable a clinical action on this field. |
| source | Always local_record. No upstream freshness/authenticity/polling guarantee. |
| lastRecordedAt | updatedAt only when it is an actual valid Date with safe nonnegative epoch within the ECMAScript date range; encode ISO UTC at most27 characters, otherwise null. This is the local row update time, not a provider/sample/report event time or clinical review time. |

Unknown/null values remain honest unavailable metadata. Unknown source status/integration is not a successful new lifecycle transition. No lifecycle/clinical sample facts are backfilled or synthesized; no new report-ready claim, promised recovery action, retry button or refund instruction is inferred. No cache, Redis/read-through fetch, automatic refresh/poll timer, file access, queue/notification or signed link. Existing free-form raw/provider status can be inaccurate/untrusted; this read neither authenticates callbacks nor repairs that state.

## Focused acceptance and retained gates

This is source implementation scope only after two actual contract approvals. Two independent NONAUTHOR implementation/composition decisions precede source-only integration. No compiler/Node/TypeScript/Joi/HTTP/Mongoose/DB/provider/driver/app/import execution is authorized by this document. Any actual check needs a separately frozen source/import/config/effect closure, owned recording ports/fixtures, bounded launcher and cleanup under complete C3; root dependency/runtime/build/start changes retain C2. The current controller/service construction imports provider/payment/wallet dependencies before requests; a new read method does not make that existing closure safe to execute.

Required later actual observations under admitted fixtures:

- Two individual customers A/B with same-looking records, own diagnostics/consultation and missing IDs: only the matching owned diagnostics returns200; foreign/kind/missing all identical404; no foreign details, no separate existence lookup or other business/corporate join.
- Missing/malformed/expired JWT and every noncustomer role; missing/malformed direct actor/scope and IDs; measured HTTP versus direct service error precedence; malformed stored array ownership/type fails the restrictive query.
- Every recognized stored status including phlebo_assigned plus unknown/free-form values; completed/report_delivered still yields sampleState/reportReleaseState unknown. A paid/refunded label never creates/claims money evidence; provider reference alone never means confirmed.
- Missing/malformed/overlong/nonfinite/Unicode stored scalars, actual ID/Date handling, fixed503 for required-record mismatch and exact null/unknown encodings. Measure emitted response keys/header/bytes; no raw meta/patient/report/provider/payment fields.
- Forged query/body owner/integration/filter fields cannot alter the literal combined predicates/projection. Existing list/report/create/cancel/retry flows remain unchanged by inverse source comparison and focused regression.
- Provider unavailable: this method still reads its stored row and makes zero provider/report/file/wallet/payment/queue/email/notification/write/index/background calls. Record constructor and middleware reads/logs honestly; method-level no calls is not a global zero-effects guarantee.
- Actual-source controls removing owner/kind/scalar guards, substituting provider report helper, exposing raw record/URLs or mapping completed to sample/release must fail for the intended behavior, not only a source hash mismatch. Actual query timeout and narrow projection require driver/HTTP evidence.

The direct/no-app/panel lab journey remains missing. Its next mutation requires canonical lab/branch/assignment and snapshotted api/panel writer ownership, protected individual staff provisioning plus an enabled lab mapping, patient/representative authority and specimen lineage. Report ingestion/release additionally requires private immutable documents, separate completeness/approval/version/signatory decisions, correction notices and critical-result policy; callbacks need real provider authentication/inbox/order fencing, not invented universal HMAC. Billing/supplies require their own units/price/source-budget/movement contracts. No business/provider/clinical resource may be fabricated to shortcut these dependencies.

Corporate/HR/hospital expansion and final cross-module campaign remain deferred; focused verification, supported clients, privacy/clinical/finance/owner/module/release gates remain. This additive customer status feature is not a panel, sample workflow, immutable report fix, module completion or final integration acceptance. No real provider/PHI records were accessed.

## Exact selected source/design bindings

Observed focus HEAD ea48a35cce0c010bbbe6a112795a090931d6fd8c. Concurrent unrelated work may advance HEAD; rebind these exact files before implementation without silently changing the approved snapshot.

| Path | SHA-256 |
| --- | --- |
| documentation/planning/ROADMAP.md | 6a5b2e5bfdb42d16021cb28f83531389977d535d9743ae8908ab75ceeabd37cf |
| documentation/planning/SYSTEM_DESIGN.md | cbd899f6fb442b13db28c389143b529b90da364165dc17291cc829814810bc84 |
| documentation/planning/CAPABILITY_MATRIX.md | 05ab06d569b8dad2a690ac434922738bd20ce15d9484b60e4bf55e62e14e7fea |
| documentation/planning/BUSINESS_OPERATIONS.md | 154371613be782bf5b31b7d0ae43a360a51b5f972dd66391041d8bc996cd6e5e |
| documentation/planning/implementation/CUSTOMER_PHARMACY_LAB_PLAN.md | b3fe87439052e8b22975e736016e8739dd8948192899a7e26be150aa4c7a2978 |
| documentation/labstack/FRONTEND_REPORT_FLOW.md | ed137adefba27701b0d407f7ea2bcaff278da20fac3e3b59ac0e1abc37d81f75 |
| documentation/pharmacy_api_reference.md | 46877a4a65b2a7763d53627f26a2217ef7a8759232ba26cd1ab66d503618d67b |
| src1/modules/externalBookings/routes/index.ts | c85d540083d25d7c00bf1fc969e20bccbea09b33d915fb9cac9b19e73ae67b06 |
| src1/modules/externalBookings/controller/index.ts | 6f2fca9b92a680d7612207c6b1d572f7551a1a6780684198f8997fc5f816ea8d |
| src1/modules/externalBookings/services/index.ts | 4a13a02cca31c0d4833937643e362b78096f4135933a59ed3372577635a24f83 |
| src1/modules/externalBookings/repository/index.ts | f55d857c624d4703b0faea866dd9081d1cd04238ee43b0bccd9bc5034b498ed1 |
| src1/modules/externalBookings/types/index.ts | a9306564c5ce3572d15eaaa589831df12db483ce56a181af2a3c484f2d3656cf |
| src1/modules/externalBookings/model/index.ts | 873239e9ebd6201cf632deafac86d76ab6a6a84b729e23332e29658a898291f1 |
| src1/modules/externalBookings/validation/index.ts | 49c3aa3449e61655d9a34b6a201de9874e83003df8737b5aa5dfdab09bd6dcc6 |
| src1/modules/middleware/auth.ts | db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2 |
| src1/routes/index.ts | 50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056 |
| src1/modules/bookings/routes/index.ts | b2ed40c971e35ceb28eeccb8b491bcf7c4b2dcaf35a7267c783a8345760e3cfb |
| src1/modules/bookings/services/index.ts | 25645bc17bb535e2c3c5b6dcec14917ef5df905fe31838c980431dcf9e591051 |
| src1/modules/bookings/repository/index.ts | d54ebba522cd290589296918eb2dcb4f7609e42d836ef3f23dfb89114b375713 |
| src1/modules/bookings/model/index.ts | 219f8115e5eec4bebd7205c763638e8755bde57122866430a1b3bcd0f69ead72 |
