# SD-CLAUDE-FOUR-INCREMENT-REVIEW-10 (claude-reviewer -> codex-lead)

**Result:** R10-1 to R10-4 and the integrated composition are all **APPROVE_SOURCE_ONLY**. I found no deviation from the ten supplied contracts.

- **New findings:** two LOW items in the supplier master (R10-F2-1, a latent 503 after a committed write; R10-F2-2, an unindexed cross-tenant list) and several INFO items.
- **Prior findings:** R10-3 is a source repair of R8-F2-1 and R10-4 is a source alignment of R8-F4-1. Neither is activation or runtime evidence.
- **Still open:** F1 HIGH and F5-1 MEDIUM; this snapshot does not touch them.

| # | Increment | Verdict | Evidence class |
| --- | --- | --- | --- |
| R10-1 | bounded diagnostics history | APPROVE_SOURCE_ONLY | source only; runtime NOT_RUN |
| R10-2 | pharmacy supplier contact master | APPROVE_SOURCE_ONLY (R10-F2-1, R10-F2-2 LOW) | source only; runtime NOT_RUN |
| R10-3 | recovery party-write fence | APPROVE_SOURCE_ONLY; R8-F2-1 source-repaired, activation gate open | source only; race/rollback NOT_RUN |
| R10-4 | legacy pharmacy test alignment | APPROVE_SOURCE_ONLY; R8-F4-1 source-aligned, suite NOT_RUN | source only |
| C | composition at 9debdd25 | APPROVE_SOURCE_ONLY | source only; final integration DEFERRED_BY_OWNER |

## Binding context
I compared the values below as text only and computed no hashes; Root verifies the bytes.

- **Team and challenge:** swasthadisha-local; msg_1794512953778_ezfy07g5 (SD-CLAUDE-FOUR-INCREMENT-CHALLENGE-10), the only inbox message carrying this sessionId.
  - Ignored as stale: the R2-R8 challenges, the connectivity probe, and the interrupted R9 max challenge (session 159654a8-3514-4195-bf73-487de95fcaa9, same snapshot).
- **sessionId** 6565807e-21b1-4553-8901-524e92a97fee. **Nonce** e4f29131-712f-4151-b110-e2edc7c0f79c, ACKed in msg_1794513588260_nbdr3pbd.
- **sourceCommit** 9debdd25ae4079fa73f5052afe3a0fd62d4feb0f, the same in packet and challenge.
- **packetSha256**, as given in the challenge: d64722233875b6a64f86f273ef9da5f6be4f62e2102a88bf6071a7037ee1c957.
- **contractBundleSha256** 7dd7185cdb877168a11559b9a394a1d551be577ef790c0d0af59fd881d25fcf0, equal to the challenge contractSha256. **controllerSha256** ec4f8f2ec93ddae43c818907efcc4f732229d749afd2ae5130e92d1e0eb65364.
- **Model and effort:** claude-opus-5-5, per the session identity statement. Requested effort xhigh (explicitly not max); effective effort UNPROVEN.
- **Route:** a local CLI agent session using only Ruflo MCP mailbox tools (one inbox peek, two sends). No native webview, shell, filesystem, git, browser, hosted worker or delegation. clientKind as received is local-bundled-CLI; I cannot observe it from inside the session.

Source map (16 entries, textually equal to the challenge):
- src1/modules/externalBookings/controller/index.ts ec4f8f2ec93ddae43c818907efcc4f732229d749afd2ae5130e92d1e0eb65364
- src1/modules/externalBookings/repository/index.ts c21359e9617f5299783d6244b890e25449e9a446d82243a6a9ad03b37a639e1c
- src1/modules/externalBookings/routes/index.ts 1cd7076065163f605483925d16f607fdff8c3e01f6825d48bcdd5d612c23d1e2
- src1/modules/externalBookings/services/index.ts fe4bcb1ca46ec5462ec63dfcba5a5babb43ec0ff5c87369ccaafeff4873da426
- src1/modules/externalBookings/types/index.ts 12897bc8923393793a7a8526a5bf4a0a696edc90fefe187a64698306bee4130f
- src1/modules/externalBookings/validation/index.ts 69af22ccd2be50053838288d183fb3219b171efb4fcc856304f8407f41df78f1
- src1/modules/pharmacyOrders/services/index.ts d8e69bb1d7afed4c2d45c8c1aa3e328f9ae355be00e2132a9936c5c34f7a5d55
- src1/modules/pharmacySuppliers/controller/index.ts 818de45cc850843328bb2cf6c0ca7c3361fe3510a540d34c6c8573a72ed9aff4
- src1/modules/pharmacySuppliers/model/index.ts 2f04e027aa296a09c5b6c04318caf2601a8974726126f30eecdad420bdff31b7
- src1/modules/pharmacySuppliers/repository/index.ts 8834a635fcc5835a26c6f423e4a2deffc433435ea11549f51c9368de7f7537c8
- src1/modules/pharmacySuppliers/routes/index.ts e226c5efa260117950cc47762500577e580b26cbc18f78b14009a285368467c0
- src1/modules/pharmacySuppliers/services/index.ts f50a9993eb05132a546a8b73397da1f4c773fe0e41361d5323584097e44096d8
- src1/modules/pharmacySuppliers/types/index.ts d7688797cbbc8e1bba9395ded10447991e07d671d6405fcf9686074bda98c427
- src1/modules/pharmacySuppliers/validation/index.ts 1e52df9798f92780907eaa622633ebe934d9858f34a668bdf07f5bec451e0c42
- src1/routes/index.ts 17308ce9d78ed135e9e1aba4e1a0c692b4204932fc0c863981b3137b4afcb002
- test/pharmacy.integration.test.ts 40a5e341214044da49a1e4849b2bde6d2ec0972215e54a612029c4c4caf1f02c

Contract map (10 entries under documentation/planning/implementation/, textually equal to the challenge):
- BUSINESS_STAFF_AUTHORITY_CONTRACT.md 69dba46528295f55e184b95e1fb6ea451ee2371254d76eb7ac9fd6573068f9fd
- GATEWAY_CAPTURE_ADMISSION_CONTRACT.md e6956ec56ec5ce07d1208cf9cd0310a6fa4600212f2e02973828289c19ab633e
- LAB_CUSTOMER_BOOKING_PROGRESS_CONTRACT.md f606545cd262de4b3429165024a2b8545f50f74b7be4fae66b0da6e3dd2d0de9
- LAB_CUSTOMER_HISTORY_CONTRACT_DRAFT.md f552a3cd42474e81ca9b80a5c74f10ca3486f2cb64898923da96afa6f17c407e
- PHARMACY_CANCELLATION_RECOVERY_CONTRACT_DRAFT.md e43bb8170b644cdc93ceeae9d8f66e8abb739f1cb35079e1076147aa88b4e910
- PHARMACY_LEGACY_TEST_ALIGNMENT_CONTRACT_DRAFT.md 944f172f5780dd1977af4a5357bb17e969cd3ac2a04bae11fc6ec97e7cc788d3
- PHARMACY_RECOVERY_PARTY_FENCE_CONTRACT_DRAFT.md 2dd63dc7c01d87083bd490d1adadcbb8c1f6619d24463a2456376f3eb84fda93
- PHARMACY_RECOVERY_WORKLIST_CONTRACT_DRAFT.md 0d5e215e4376987e7b5d33114d243685cb5c1ee3302e69ceef4dc167cd7b8b86
- PHARMACY_SUPPLIER_MASTER_CONTRACT_DRAFT.md c47d541e60747f262e6828b912b2016c61c1e2b2f5a4dfcffc1f4bee8b4157b7
- PRESCRIPTION_CHECKOUT_ENABLEMENT_CONTRACT.md e3deb08a9002e4b11bf0d168dbce369312727841e5c96fa5c3a25503ea1781a7

## Method
This was a read-only inspection of the packet text.

- **Inspected in full:** all 16 changed files, all 10 contracts, and the supplied unchanged context. The context covers the auth, validation and error middleware, BaseRepository, models, the pharmacyOrders repository, controller, routes and types, and the payment, inventory, medicine, customer, bookings and specialist-portal services.
- **Read as provenance only:** historical decisions, freezes, diffs and reviews. Native Codex approvals were treated as internal evidence, not as review.
- **Not used:** shell, filesystem, git, compiler, Node, database, provider or any hashing.
- **Line references:** taken from the supplied whole files. `~L` marks positions derived from diff hunk headers or hand counts.

## R10-1 Bounded diagnostics history: APPROVE_SOURCE_ONLY
Verified:

- **Route** (externalBookings/routes ~L107-111): GET `/diagnostics/bookings` runs `validate(customerDiagnosticsHistoryQuerySchema)` and then `catchAsync`, under the central `authenticate` mount (src1/routes L103).
  - No earlier GET matches the path. It shadows neither `/diagnostics/bookings/:id/progress` nor the legacy GET `/bookings`.
- **Joi** (validation ~L365-369): page is an integer 1..1000, limit an integer 1..50, and `userId` is forbidden.
  - Shared stripUnknown removes any other key, and nothing from the raw query reaches the service.
  - A Joi 400 can precede the actor 403, as the contract allows.
- **Controller** (~L587-603): builds only `{page, limit}` and forwards `req.user`.
  - It serializes once, returns 503 at or above 256 KiB, sets `Cache-Control: private, no-store`, and sends the same string.
  - The envelope is exactly `{success, data, pagination{page, limit, total, totalPages}}`.
- **Service** (~L2467-2485):
  - The actor checks moved verbatim into `diagnosticsCustomerId`: a non-object or array actor gets 401, and `userType !== 'user'` gets 403 "Individual customer access is required".
  - Progress still runs this check before the repository's owner-then-ID checks; history evaluates it before the repository call.
  - There are no provider, report, payment, wallet or file calls.
- **Repository mapper** (L18-46): `toCustomerDiagnosticsProgress` is the old block, only dedented.
  - The progress findOne predicate, 10-field select, `maxTimeMS` and 404 path are unchanged; progress now passes its validated id to the mapper.
- **Repository history input checks** (L78-97):
  - Owner 403 first.
  - Then the query must be a plain or null-prototype object whose own keys are only the strings `page` and `limit`, as enumerable data descriptors (no getter is read), with safe-integer bounds; otherwise 400.
- **Repository history aggregate** (L99-121): exactly one aggregate.
  - `$match` on the literal `userId` string and `DIAGNOSTICS`, with `$expr` string-type guards; there is no integration filter.
  - `$project` of the same 10 fields as progress.
  - One `$facet`: a pre-page `$count`, then `_id:-1` sort, skip and limit.
  - Options `maxTimeMS` 2000 and `allowDiskUse` false.
- **Repository history result checks** (L122-152):
  - Exact facet keys, and at most one metadata row with exactly `{total}` as a safe integer.
  - Page length must equal min(limit, max(0, total - skip)).
  - Each row needs an actual ObjectId `_id`; the mapper then checks owner and kind. Any failure gives 503 DIAGNOSTICS_PROGRESS_UNAVAILABLE.
  - `totalPages = Math.ceil(total/limit)`.
- **No casting of the pipeline:** `Model.aggregate` does not cast pipelines, so the `$expr` guards and the literal string owner reach the server unchanged. For this path that removes the casting dependency R8-F1-1 recorded for progress. Only the single-bson-copy `instanceof` dependency remains, and it fails closed with 503.

Findings:

- **R10-F1-1 INFO (capacity, runtime).**
  - `{userId:1}` narrows the scan, but the in-facet `$count` and `_id:-1` sort run on every request over all of the customer's diagnostics rows.
  - A `MaxTimeMSExpired` propagates as an unmapped 500 (errorHandler echoes the driver message), not 503.
  - Unbounded stored strings (status, bookingTime, externalBookingId) still count toward the single 16 MiB facet document, although the DTO truncates them.
  - Fix: nothing in source. Before activation, measure explain, time and bytes for a heavy customer; an optional later fix is a create-only `{userId:1, providerType:1, _id:-1}` index installed through the readiness manifest.
  - Checks: two customers; both adapters plus unknown labels; a page beyond the end; limit 51 rejected; an array-valued owner excluded; the mapper's 503 on a mismatched row.
- **R10-F1-2 INFO (compatibility, inherited from R8-F1-2).** The signed `_id` must be lowercase hex; an uppercase subject gets 403. This keeps Root's recorded choice.
- The legacy mixed list, report privacy gaps and supported-client migration are untouched and remain open.

## R10-2 Pharmacy supplier contact master: APPROVE_SOURCE_ONLY
Verified:

- **Mount and guards:**
  - Mount at src1/routes L96: `/api/v1/pharmacy-suppliers` with `authenticate`, a distinct prefix from pharmacy-orders, placed before the 404 catch-all.
  - All four routes (routes L12-16) run `requireOperationalPharmacy` first: 401, non-pharmacy 403, inactive, unverified; there is no admin bypass.
  - Only GET has Joi (`pharmacyId` forbidden). The write routes have no Joi and no stripUnknown, so raw keys reach the authoritative normalizer.
- **Controller:** forwards only the guard-resolved `pharmacyId`, the signed `_id`, `req.params.id` and `req.body`.
  - One reply helper serializes once, returns 503 at or above 512 KiB, and sets private/no-store.
  - Create returns 201 and the others 200, with exact envelopes.
- **Write order** (repository L65-119; validation L37-69):
  1. Pharmacy scope 403, then actor 403.
  2. On edit and archive only: supplier ID 400, then body shape 400.
  3. On edit and archive only: one owned lookup, 404 if absent or foreign, then 503 if the stored record is malformed.
  4. All key names: any symbol or unknown name gives 422.
  5. Descriptors: an accessor or non-enumerable property gives 400, without invoking getters.
  6. Any own `undefined` value gives 400.
  7. Trim, then content checks via Joi with `convert:false` and `stripUnknown:false`; failures give 400.
  8. `expectedRevision` must be a safe integer from 1 to MAX_SAFE_INTEGER - 1, else 400.
  9. PATCH on an archived supplier, or a stale revision, gives 409.
  10. The final CAS.
- **Replay and field semantics:**
  - Archive on an already archived supplier returns the pre-read DTO only after full body validation, with no write.
  - Create maps an omitted, null or blank optional field to null. PATCH preserves omitted fields and clears null or blank ones.
  - displayName can never be cleared, and PATCH must be nonempty (`.min(1)`).
- **Reads:**
  - The owned filter (L48-56) uses literal ObjectIds plus `$expr` objectId guards, a 15-field projection and `maxTimeMS`.
  - The DTO validator requires:
    - exactly 15 own keys, ObjectId identity and owner;
    - schemaVersion 1, canonical actor IDs and a safe-integer revision;
    - consistency between state and archivedAt, valid Dates, and text re-validated by Joi.
  - It returns a 12-field DTO with `verificationState: not_evaluated` and no owner or actor fields.
  - The findOne and findOneAndUpdate filters rely on Mongoose 6 passing a top-level `$expr` through casting (the R8-F1-1 class; NOT_RUN).
- **Writes:**
  - Create inserts one explicit literal document (strict throw, versionKey false, autoCreate and autoIndex false).
  - Edit and archive use a CAS on `_id, pharmacyId, state:'active', revision:expected`, with scalar owner and state guards.
  - Each write does `$set` metadata, actor and time, plus `$inc` revision by 1, with new:true, upsert:false and runValidators.
  - There is no delete, and no stock, payment, provider, organization or patient effect.
- **List:**
  - One aggregate: literal owner and state filters with scalar guards, `$project`, and one `$facet` (count, then `_id:1` sort).
  - Exact facet checks; `maxTimeMS` 2000 and no disk spill.

Findings:

- **R10-F2-1 LOW latent** (repository L94-97, L112-116).
  - **Where:** the pre-read uses `supplierProjection`, but neither `findOneAndUpdate` sets a projection or `maxTimeMS`, while `supplierDto` requires exactly 15 own keys.
  - **Trigger:** a stored supplier with any extra field, from a raw or migration write. This module does not produce such records.
  - **Consequence:** the CAS commits (revision incremented, metadata written) but the response is 503. A client retry with the old `expectedRevision` then gets 409, so the caller never sees the committed result.
  - **Minimum fix:** add `projection: supplierProjection, maxTimeMS: 2000` to both writes, as recovery intake does.
  - **Checks:** seed an extra field through the driver and PATCH. Today that returns 503 with the revision incremented; after the fix it returns 200 with the exact DTO.
- **R10-F2-2 LOW (capacity and activation)** (model L6, L17; list L121-138).
  - **Where:** by contract there is no `pharmacyId` index.
  - **Consequence:** every list is a collection scan across all pharmacies' suppliers, bounded only by `maxTimeMS` 2000. Expiry surfaces as a 500 carrying the driver message, so growth at unrelated tenants degrades availability.
  - **Fix before activation:** a create-only `{pharmacyId:1, state:1, _id:1}` index installed through the reviewed readiness manifest, or an accepted explain/time budget.
  - **Check:** explain and timing on a representative multi-tenant volume.
- **R10-F2-3 INFO.** The CAS equality on `revision` has no `$type` scalar guard; the contract requires only owner and state guards.
  - A dirty array revision cannot produce a successful write: the pre-read DTO requires a numeric revision, and the server rejects `$inc` on non-numeric values.
  - A guard could be added for symmetry; it is optional.
- **R10-F2-4 INFO.**
  - Two concurrent identical archives: the loser gets 409 from the CAS miss, and a later retry returns the archived replay. This matches the contract; document it for clients.
  - The timestamps plugin overwrites `$set.updatedAt`, so archivedAt and updatedAt can differ by milliseconds.
  - The actor fields record the pharmacy business token subject, not an individual, as the contract acknowledges.
- **Still open:** first-insert implicit namespace and `_id` index creation; B06 PO, GRN, invoices and payables; KYC and credit.

## R10-3 Recovery party-write fence: APPROVE_SOURCE_ONLY
Verified (pharmacyOrders/services ~L869-1112):

- **Validation and error order:**
  1. A primitive 24-hex ID (either case) is required, else 400, before any query (~L870).
  2. findById, else 404.
  3. A primitive hex owner that also passes the retained `String(order.pharmacyId) === pharmacyId` comparison, else 403 (~L877).
  4. Terminal status, else 400.
  5. Party-command presence is tested as an own key over exactly customerId, buyerPharmacyId and orderType. Marker presence is an own `recoveryRequest` on the lean pre-read; null, undefined and malformed markers all count. Both present gives 409 ORDER_RECOVERY_PARTY_LOCKED (~L887-895).
  - This 409 precedes the financial lock, the Rx commerce gate, linked-reference reads, ensureLinked and session allocation.
- **Payload** (~L1001-1006):
  - It spreads `data`; each party key is written only when it is an own key, with the existing next-value semantics.
  - Omitted party keys are absent, so there is no snapshot echo.
  - `recoveryRequest` is not writable: Joi strips it and the request type excludes it.
- **Final filter** (~L1062-1070):
  - Literal ObjectId `_id`, `pharmacyId $eq ObjectId`, and `$expr` objectId type guards on both fields.
  - `recoveryRequest $exists:false` is added only for party commands.
  - There is no `$in`, upsert or ownerless fallback.
- **Inside the transaction callback** (~L1091-1099):
  - One update with the session. A null result throws 409 ORDER_UPDATE_CONFLICT inside the callback, after the batch release and re-reserve or the legacy delta, so `withTransaction` aborts that same session.
  - The old post-callback 500 branch is removed.
  - Subscription sync happens only after success, and database errors propagate unchanged.
- **Unchanged behaviour:** notes-only and other non-party commands keep every earlier gate, and their filter has no marker predicate.
- **Race reasoning (source only):**
  - If intake commits first, the party write's final filter misses: 409 and rollback.
  - If the party write commits first, intake (a snapshot transaction with a customer-scoped CAS) hits a WriteConflict and retries, its customer-A read then gives 404, and no mismatched marker is ever written.
  - If the party writer itself retries after a TransientTransactionError, it re-runs the inventory work and then hits the marker predicate: 409.
- **Composition:** the intake, worklist and `recoveryReceipt` bytes are unchanged; markers now stay customer-consistent going forward.

Findings:

- **R10-F3-1 INFO (fail-closed ambiguity).**
  - **Trigger:** a dirty stored owner (a string, or a single-element array) passes the pre-read `String()` comparison.
  - **Consequence:** for a party command it may already have run ensureLinked. It then permanently returns ORDER_UPDATE_CONFLICT "Order changed...", which is indistinguishable from a real race, and retries never succeed.
  - **Assessment:** fail-closed, as the contract intends. Suggestion: conflict telemetry or operator triage, not repair.
- **R10-F3-2 INFO (client compatibility).**
  - **Trigger:** because detection uses own keys, a client that echoes orderType, customerId or buyerPharmacyId on a notes edit gets 409 once a marker exists.
  - **Reach:** only placed, pending, no-transaction orders; others already hit ORDER_FINANCIALS_LOCKED.
  - **Assessment:** contract-intended. Supported clients must send notes-only bodies. Check: real client payloads.
- **R10-F3-3 INFO (omitted context).**
  - The fence exists only in `update`.
  - In the supplied source no other writer changes the party fields of an existing order: updateStatus, markPaid, payment claim, timeout and abandonment, sideEffects and linkHealthCheck all write other fields.
  - The whole-repository writer search was not supplied. Any future writer must adopt the same predicate.
- **Retained limits:**
  - ensureLinked runs outside the transaction and can persist before a late conflict.
  - Validations and subscription decisions still use the stale pre-read; party-versus-party and other races remain.
  - No zero-effect or whole-operation atomicity is claimed.
  - Existing inconsistent markers (and their page-wide worklist 503) need separately authorized recovery; no marker deletion, repair or rebinding.
  - Actual Mongoose `$expr` pass-through, abort, rollback and retry behaviour are NOT_RUN.

## R10-4 Legacy pharmacy test alignment: APPROVE_SOURCE_ONLY
Verified (test/pharmacy.integration.test.ts):

- **Manual-payment case** (~L214-244):
  - It adds a real `createMedicine('Manual payment')`: active, with the schema default false classification stored.
  - It adds one explicit active non-Rx line, `prescriptionStatus: not_required` and `prescriptionUrls: []`.
  - markPaid now passes the 404, 403, mode, paid, refunded and terminal checks and the `stored_order` gate:
    - exact `_id` and own fields;
    - one batch catalogue read;
    - own false flags, active and not archived.
  - It therefore reaches the existing CAS. With no customerId, no notification is queued. Stubs are unchanged.
  - The `allSettled` exactly-one-fulfilled and exactly-one-rejected assertions are unchanged.
- **Rx case** (~L306-352):
  - The snapshot is taken after `InventoryItemModel.create` (~L330).
  - The predicate requires status 503 and code PRESCRIPTION_CHECKOUT_UNAVAILABLE (~L344-345). create reaches the `new_items` gate after read-only pricing and before ensureLinked or any transaction.
  - It then checks deepEqual (~L349) and the 3/0 totals.
- **Scope:** only these two case bodies changed. The nineteenth `new MedicineRepository()` constructor argument, imports, helpers, admission and cleanup are unchanged.
- **Composition with R10-3:**
  - These two cases call create and markPaid, which the party edit does not touch.
  - The "paid order financials" case still reaches ORDER_FINANCIALS_LOCKED before any new gate; real ObjectId strings satisfy the new ID and owner guards.
  - The cancellation case uses the unchanged updateStatus.
  - The superseded isolated service pin is therefore benign.

Findings:

- **R10-F4-1 INFO.** The loser's rejection code and the final paymentStatus are not asserted, so an unrelated rejection (for example a transient database error) also satisfies "exactly one".
  - The contract deliberately adds no loser-code guarantee.
  - A future test contract could assert that the loser's code is ORDER_PAYMENT_STATE_CHANGED or ORDER_ALREADY_PAID, and that the stored order is paid exactly once.
- **R10-F4-2 INFO.** deepEqual relies on deep-strict equality between two lean reads (BSON ObjectId and Date, single bson copy). It also detects any write, through updatedAt.
- **Naming:** the case name still says "without a prescription" although the case now tests the commerce-unavailable gate; the contract preserves the name.
- **Admission:** the suite is still unadmitted. It imports effect-capable modules at top level before checking the URI, uses a weak database-name check, and drops the database. No execution, race, type or financial proof exists.

## C Integrated composition: APPROVE_SOURCE_ONLY
- **R10-1** is additive and preserves progress; it adds no pharmacy or payment dependency.
- **R10-2** is an isolated module behind the authenticated mount and the operational guard. Its DI is only service to repository, with no cycle, and it touches no shared writer.
- **R10-3** is a single-method edit. It composes with the unchanged intake, worklist and `recoveryReceipt`, and its party 409 precedes the Rx commerce gate.
- **R10-4** is test-only; its composition with R10-3 is covered above.
- Final cross-module integration is DEFERRED_BY_OWNER, not PASS.

## Retained open items
- **F1 HIGH, OPEN:**
  - qualified Rx review and provisioning;
  - paid, COD and legacy custody;
  - verified cash and funding;
  - stock, refund and original-instrument obligations.
- **F5-1 MEDIUM, OPEN.**
- None of the metadata intake, contact master, history read or fence settles F1 or F5-1.
- **R8-F2-1:** the source repair is present in R10-3. The activation gate stays open for:
  - real race and rollback evidence;
  - the ensureLinked residual;
  - accountable recovery of pre-existing inconsistent markers.
- **R8-F4-1:** the source alignment is present in R10-4. The suite remains unadmitted and NOT_RUN, and pre-import admission has not improved.
- **Earlier dispositions, unchanged:** R8-F6-1 worklist capacity; R8-F1-2 lowercase IDs (now also history); R8-F1-1 and R8-F3-1 runtime `$expr`; R8-F2-2 snapshot retry; R8-F5-1 and R8-F5-2.
- **New in R10:** R10-F2-1 LOW, R10-F2-2 LOW, plus INFO items R10-F1-1, R10-F1-2, R10-F2-3, R10-F2-4, R10-F3-1, R10-F3-2, R10-F3-3, R10-F4-1 and R10-F4-2.

## Non-claims and limits
- **No acceptance is given for:**
  - TypeScript or types; Joi; HTTP; Mongoose or the driver;
  - database, indexes, transactions, races or rollback; capacity;
  - providers, clients, clinical, financial or privacy decisions, the owner, the module, M0, deployment or release.
- The historical 84 pure and 700 fake checks do not verify these paths.
- Corporate, HR and hospital expansion is excluded.
- I inspected only the supplied packet text; the whole-repository call graph was not supplied.
- Hashes were compared as text only, and native Codex decisions are internal evidence. No private reasoning is included.
