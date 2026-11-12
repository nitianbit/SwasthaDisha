# SD-CLAUDE-SIX-INCREMENT-REVIEW-8 (claude-reviewer -> codex-lead)

**Result:** all six increments and their integrated composition are **APPROVE_SOURCE_ONLY**. I found no source deviation from the supplied contracts.

- **New MEDIUM finding, R8-F2-1 (activation gate).** The recovery intake (R8-2), the worklist (R8-6) and the unchanged `PharmacyOrderService.update` writer together create a reachable, permanent dead end. It comes from the contract design, not a source defect.
- **R8-5 pure evidence.** The recorded run is internally consistent and bound to the current harness bytes, within its stated scope: Mongoose-free, injected ports.
- **Open items.** F1 HIGH and F5-1 MEDIUM remain OPEN; nothing here resolves them.

| # | Increment | Verdict | Evidence class |
| --- | --- | --- | --- |
| R8-1 | customer lab booking progress | APPROVE_SOURCE_ONLY | source only; runtime NOT_RUN |
| R8-2 | customer pharmacy recovery intake | APPROVE_SOURCE_ONLY (see R8-F2-1) | source plus declared data vectors; runtime NOT_RUN |
| R8-3 | generic booking write boundary | APPROVE_SOURCE_ONLY | source only; runtime NOT_RUN |
| R8-4 | PaymentService constructor compatibility | APPROVE_SOURCE_ONLY (call shape only) | source only; legacy suite NOT_RUN |
| R8-5 | authority fixture and actual pure run | APPROVE_SOURCE_ONLY; recorded pure evidence consistent | source plus one recorded real pure run |
| R8-6 | pharmacy recovery-request worklist | APPROVE_SOURCE_ONLY (see R8-F2-1) | source only; runtime NOT_RUN |
| C | integrated composition at 258ec457 | APPROVE_SOURCE_ONLY | source only; final integration DEFERRED_BY_OWNER |

## Binding context

Values are as received and were compared as text only. I computed no hashes; Root verifies the bytes.

- Team: swasthadisha-local.
- Challenge: msg_1794492602497_rlwbsoly (SD-CLAUDE-SIX-INCREMENT-CHALLENGE-8). It is the only inbox message carrying this sessionId; R2-R7 and the connectivity message were ignored as stale.
- sessionId 99c211d0-4e14-42fa-9649-6a785bd2df36; nonce f46a9d70-f66e-486b-9733-5f479c1b59e9 (ACK sent as msg_1794493376220_uljcd3po).
- sourceCommit 258ec457c3bda0b95eea9e8838507e09ae08ef30, the same in packet and challenge.
- packetSha256, as given in the challenge: 15c50a61b36e42b59e95b48252c338ab96f6e421ba16237f8abfdfb9333a77d9.
- contractBundleSha256 1eea72cdd7d883f16261fefedcc0ef9c74d40527476e873e4b13f5ddf50acebd, equal to the challenge contractSha256.
- controllerSha256 1c330cdb65aed728defe615371f01e74556d2035ea01acb4f4a4e3f016df6e0a.
- Model: claude-opus-5-5, per the session identity statement. Requested effort xhigh; effective effort UNPROVEN.
- Route: a local CLI agent session using only Ruflo MCP mailbox tools (one inbox peek, two sends). No native webview, shell, filesystem, browser, hosted worker or delegation. clientKind as received is local-bundled-CLI; I cannot observe it from inside the session.

Source map (24 entries, textually equal to the challenge):
- src1/modules/bookings/controller/index.ts 1c330cdb65aed728defe615371f01e74556d2035ea01acb4f4a4e3f016df6e0a
- src1/modules/bookings/repository/index.ts 3083722a941065a5a87ddc222772305c0c58de57e2ce140bb38dfd4721713ee5
- src1/modules/bookings/services/index.ts 279020eb382d7566e737cee88eb8b7b670ebcf6aeb6e7b968010aabb9bc9f6cd
- src1/modules/externalBookings/controller/index.ts 360836e0d5e98223de26c5faf1777f420d1991afdce7b3f7b5bfe2eada05b041
- src1/modules/externalBookings/repository/index.ts b34199b2e0c767e309c28c6d147b6de1d5ae59bbcef363aca3668371b13d582c
- src1/modules/externalBookings/routes/index.ts fe3d4181c3424638cad98b2cc61bbcad5b72f48258ae1c02f76f5b3fdcbba146
- src1/modules/externalBookings/services/index.ts aa1ac1b90f91dab278bad594d5a3a82f931cf6443fb24af819faf707c89a9a66
- src1/modules/externalBookings/types/index.ts 878f539e702ee998176acbfc4c6a38b7b711d2447e4608fe14a5647b40d7e862
- src1/modules/pharmacyOrders/controller/index.ts e1cca25dc7c45fd2048f014c6b47191cda1044eca8b8f4cf5c9f061c3d2a3446
- src1/modules/pharmacyOrders/model/index.ts f054a220020c66a83c49ea8658bd0d002cb3a9fd28c9b7771b0584c53471ac14
- src1/modules/pharmacyOrders/repository/index.ts df77e35abeb00913d6353e0bf76a3651b3a1b78b6e669548439472347c4b084f
- src1/modules/pharmacyOrders/routes/index.ts cfb13044228699be2fa37ce9635dcaf9f5874e3fe2ce02eeb846407be0e088fe
- src1/modules/pharmacyOrders/services/index.ts 83ca486a250403a777f0548ec57c98bd1e99e154b6f2034754ddc9aedbc3f35e
- src1/modules/pharmacyOrders/types/index.ts 6f3c1171b5ab154bc566ec7dcedaf3da4cd614d1bb7402fa5534b7a5e575e423
- src1/modules/pharmacyOrders/validation/index.ts 70381b52ca88dc35782850f662423ee423dbaebe67122641c1219fdee8f84402
- test/application/README.md dbe1014862ce0e192eaf6d2992c7e42efdc3d7f690e2008f9c6cafcf150be8e7
- test/application/app-bundle.mjs 993634db7d05213208ddda434d8d4c21f679ae342f46a1836dda115c7d3b5817
- test/application/app-bundle.test.mjs dd2bc927c1f0f4d1932929aa4294a6df3c74a1db6536a7bb56902d259d163e75
- test/application/app-container.mjs 4c2a061a45a30478d4fc04d6cd28bb88aa2fd679e4346136b7714f29142948aa
- test/application/app-container.test.mjs 79c6b65b39c7336718ad563b175e48f5fda76035b77b5028fb83bbcaa6a7dd14
- test/application/authority-scenario.mjs 806d39428cc6512c527581a46d00f49b4c15d348efa9457e5cbab3369b91d3ee
- test/application/bootstrap.mjs b9016bbddd345ed562e7820ae391f96180397a6ae84c20fc92c1d36a74467b4c
- test/application/run-authority.mjs a4b7c9e31f0ecc92f57d7d324dd3f36896d188ffe5e06e5cc159577549e31af9
- test/pharmacy.integration.test.ts e123eab6f5bde08475605f8ed47a1f3830cd97ecdd9c8fe2dd0f2aa49507d35e

Contract map (15 entries, textually equal to the challenge):
- documentation/planning/implementation/ APP_NETWORK_ADMISSION_CONTRACT.md 003156a5935912eca7794c4fe312e51a93991162a9bf438cacfc40a315abe291
- AUTHORITY_PURE_RUNTIME_CONTRACT.md 3b433b9f203b1c66b6a30c17e51c084e8d06e88f1e8a761b4d605ee6c7f0712a
- BUSINESS_STAFF_AUTHORITY_CONTRACT.md 69dba46528295f55e184b95e1fb6ea451ee2371254d76eb7ac9fd6573068f9fd
- C3_APP_ISOLATION_CONTRACT.md 0a93e0d16625bd43b983f037d2c75f70cc336b78bd6bc4ba1c19a4cf3fe3613e
- CUSTOMER_BOOKING_FIELDS_CONTRACT.md b7a82e761ebeacd808dfe11fbb66d7e467631c2aa062f91a8a34deaa8f2d94ea
- CUSTOMER_BOOKING_WRITE_BOUNDARY_CONTRACT_DRAFT.md f3d100d7981d65e92c9ba144523534b54d309b7cfb400ba387497c25113bcf22
- CUSTOMER_BOOKING_WRITE_OWNER_CONTRACT_DRAFT.md 723af082952ee39d39342080d2ba72205687f94244458a5e5dabf0d9c7ee8698
- GATEWAY_CAPTURE_ADMISSION_CONTRACT.md e6956ec56ec5ce07d1208cf9cd0310a6fa4600212f2e02973828289c19ab633e
- LAB_CUSTOMER_BOOKING_PROGRESS_CONTRACT.md f606545cd262de4b3429165024a2b8545f50f74b7be4fae66b0da6e3dd2d0de9
- PHARMACY_CANCELLATION_RECOVERY_CONTRACT_DRAFT.md e43bb8170b644cdc93ceeae9d8f66e8abb739f1cb35079e1076147aa88b4e910
- PHARMACY_QUALITY_WORKLIST_CONTRACT.md 710f300d1d335540599a912fcec1582ce6c7d636cc9a5f20a386615bbb9c12ee
- PHARMACY_RECOVERY_WORKLIST_CONTRACT_DRAFT.md 0d5e215e4376987e7b5d33114d243685cb5c1ee3302e69ceef4dc167cd7b8b86
- PHARMACY_REFUND_ERROR_PROPAGATION_CONTRACT.md 6e34cc83c22347b4ff6e13cbbb2a446de42696a787b1036010e20cef5d1854dd
- PRESCRIPTION_CHECKOUT_ENABLEMENT_CONTRACT.md e3deb08a9002e4b11bf0d168dbce369312727841e5c96fa5c3a25503ea1781a7
- output/qa/payment-constructor-compatibility/CONTRACT.md afe1861ef7f256a495304e39c5f2a768abd66c3ce80ade2663b9004ba5d7242f

## Method

This was a read-only inspection of the packet text.

- **Inspected in full:** all 24 changed files, all 15 contracts, and the supplied context files. The context covers routes, the auth, validation and error middleware, BaseRepository, models, the three organizations modules, PaymentService, inventory, the medicine repository and the specialist portal.
- **Read as provenance only:** the historical evidence (decisions, freezes, diffs, R4/R6/R7 reviews and dispositions, and the authority run records). Native Codex approvals were treated as internal evidence, not as review.
- **Not used:** shell, filesystem, git, compiler, Node, database, provider or any hashing.
- **Limits:** SYSTEM_DESIGN is supplied as excerpts only. The provider and application import graph is not supplied.
- **Line references:** taken from the supplied whole files. `~L` marks positions derived from diff hunk headers or hand counts.

## R8-1 Customer lab progress: APPROVE_SOURCE_ONLY

Verified:

- **Route** (externalBookings/routes L138-142): GET `/diagnostics/bookings/:id/progress` with `catchAsync` only.
  - It sits behind the central `authenticate` mount (src1/routes/index.ts L101).
  - No earlier GET matches this path, and the route shadows no existing route.
  - No Joi schema, query or body reaches the service.
- **Controller** (L586-590): forwards only `req.user` and `req.params.id`, sets `Cache-Control: private, no-store`, returns `{success:true,data}` and logs nothing.
- **Service** (L2466-2475):
  - A non-object or array actor gets 401.
  - `userType !== 'user'` gets 403 "Individual customer access is required".
  - It then delegates `(id, principal._id)` and makes no provider, report, payment or wallet call.
- **Repository** (L23-71):
  - A non-lowercase-24-hex scope gets 403 before the ID check; a bad ID gets 400; both happen before any query is built.
  - It runs one `findOne` on an ObjectId `_id`, the literal `userId` and the literal `DIAGNOSTICS`, with `$expr` guards requiring both `userId` and `providerType` to be scalar strings.
  - The read uses a 10-field select with `maxTimeMS(2000).lean()`.
  - Missing, foreign and non-diagnostics bookings all get the same 404.
  - After the read (L44-49), it returns 503 for a non-ObjectId `_id`, a hex mismatch, or an owner or kind mismatch.
- **DTO:** exactly 11 constructed fields, with the contracted encodings.
  - `integration` is a closed set.
  - `bookingDateRaw` must match `^[0-9]{8}$`; `bookingTimeRaw` must be 1-32 characters.
  - `bookingStatus` is the closed 9-status vocabulary including `phlebo_assigned`; `paymentStatus` uses the closed labels.
  - `providerReferenceRecorded` is false for undefined or null; for a string of at most 512 characters it reports whether the string is non-blank; it is null otherwise, so an overlong whitespace string gives null.
  - `sampleState` and `reportReleaseState` are always `unknown`, and `source` is `local_record`.
  - `lastRecordedAt` is set only for a real Date with a safe epoch from 0 to 8.64e15 (at most 27 ISO characters).
  - No external ID, URL, patient field or amount is returned.
- **Scope of change:** the candidate diff is purely additive (imports plus new methods); legacy methods and routes are preserved.

Findings:

- **R8-F1-1 INFO (runtime).** The scalar-owner guard depends on Mongoose 6.13.8 passing a top-level `$expr` through query casting under the default `strictQuery`. The `instanceof Types.ObjectId` check depends on there being a single bson copy. Both fail closed here:
  - if `$expr` were dropped, an array owner would pass the query but hit the 503 at L44-49;
  - with a duplicate bson copy, every hit becomes a 503.

  Checks: an array `userId` containing the caller must give 503 or 404, never 200; a clean owned record must give 200.
- **R8-F1-2 LOW (compatibility).** Both ID and scope must be lowercase hex (repository L24 and L27). Sibling external routes accept any trimmed string and cast it case-insensitively.
  - Trigger: a client sends an uppercase ObjectId.
  - Consequence: 400, a client-visible inconsistency only.
  - Fix: either document the client contract, or accept `[0-9a-fA-F]{24}` and canonicalize it for the query only.

Limits (unchanged): stored status labels remain untrusted, and `report_delivered` does not mean release. HTTP, Joi, driver, response-byte and no-provider behaviour are NOT_RUN.

## R8-2 Customer pharmacy recovery intake: APPROVE_SOURCE_ONLY

Verified:

- **Routes** (L35-43): POST and GET `/:id/recovery-request`, with no guard or Joi, placed before `/:id` (L52). Authentication comes from the central mount.
- **Controller** (L27-37): forwards `req.user` and `req.params.id`, sets private/no-store, and returns 200 `{success,data}`.
- **Service `customerRecovery`** (~L773-810):
  - Checks run in this order: non-object actor 401; non-user 403; non-canonical signed `_id` 403; non-canonical order ID 400. All happen before `startSession`.
  - It opens one default-connection session and runs one `withTransaction` with readConcern `snapshot`.
  - `candidate`, `completed` and `transaction` are reset on every attempt, so a stale result from an earlier aborted attempt cannot be returned.
  - After a normal return it requires: `completed` set, a defined candidate, the same Transaction object, and `state === 'TRANSACTION_COMMITTED'`; anything else gives 503.
  - `endSession` runs in `finally`. The code correctly does not rely on the return value of driver 4 `withTransaction`.
- **Repository:**
  - `assertRecoverySession` (~L69-76) requires `instanceof mongo.ClientSession`, `client === PharmacyOrderModel.db.getClient()`, `inTransaction()`, the `snapshot` level, and an unchanged Transaction identity around every read and write.
  - `readCustomerRecoveryOrder` (~L78-93):
    - Scope 403, then ID 400.
    - One `findOne` on an ObjectId `_id` and ObjectId `customerId` with `$expr` objectId type guards, a 7-field projection, the session, `maxTimeMS` 2000 and `lean`.
    - Missing, foreign and wholesale (no `customerId`) orders get 404.
    - It returns 503 unless `_id`, `customerId` and `pharmacyId` are all ObjectIds that match.
- **Null versus absent marker:**
  - GET returns `null` only when the `recoveryRequest` key is absent (`hasOwnProperty`); a stored `null` goes to `recoveryReceipt(null)` and gets 503.
  - On POST, a present null or malformed marker gets 503 before the CAS, and `{$exists:false}` can never match a null marker. Malformed records are therefore never overwritten or repaired.
- **CAS** (~L120-124):
  - The filter repeats the same owner and type predicate and adds `recoveryRequest:{$exists:false}`.
  - The update is a `$set` of a newly built closed record only, with `upsert:false`, `runValidators:true`, a fixed projection and `maxTimeMS` 2000.
  - Afterwards it checks identity again and re-validates the receipt.
  - On a miss it does one scoped re-read in the same snapshot session; an absent marker then gives 503. It never uses an alternate key or an ownerless read.
- **Record** (`recoveryReceipt` ~L39-61, plus the model):
  - Exact own-data-key shapes for the record and the observation.
  - A deterministic operationId and an order/customer binding.
  - Closed labels, with the reference state consistent with the stored ID.
  - Amount and currency null, instrument `unknown`, destination `original_instrument`, and a safe epoch.
  - Payload and observation digests recomputed over fixed arrays. Both array layouts match the declared serializations in `SERIALIZATION_VECTORS.json` as text; I did not compute the hashes.
  - The model subschemas use `_id:false`, `strict:'throw'` and `default: undefined`, with no backfill.
- **DTO:** exactly 7 fields, with no customer ID, payment reference or gateway data.
- **Effects:** the new methods make no cancel, stock, payment, wallet, provider or queue call. Existing writers are byte-unchanged.

Findings:

- **R8-F2-1 MEDIUM (contract-design composition across R8-2, R8-6 and an unchanged writer).**
  - **Where:**
    - `pharmacyOrders/services` `update()` ~L881-897: `customerId` is an allowed "financial" edit while `status==='placed' && paymentStatus==='pending' && !paymentTransactionId`.
    - ~L985-990: `updatePayload.customerId = nextCustomerId`.
    - ~L1065: the final write uses only `{ _id: id }`, with no marker or owner predicate.
    - `recoveryReceipt` ~L45-46 binds `requestingCustomerId === customerId`.
    - The worklist validates each row against the row's current `customerId` (repository ~L189-205, call at L194).
  - **Trigger:** customer A files a request on A's own placed, non-Rx COD or in-store order (no payment transaction). The owning pharmacy then PUTs `customerId: B`, which the R7 commerce gate allows for non-Rx orders. Joi strips nothing relevant, so the marker is preserved but no longer consistent with the order.
  - **Consequences:**
    - (a) A now gets 404. That is correct authorization, but A loses the durable receipt.
    - (b) B gets 503 on GET and POST permanently, so B can never file a request for that order.
    - (c) Every worklist page containing that order returns a whole-page 503, hiding up to 49 valid requests. Because ordering is by `_id`, this never clears. No repair path exists.
  - **Assessment:** this is not a source deviation. Both contracts mandate a fail-closed 503 and byte-preserve the existing writers. It is still a reachable dead end caused by a legitimate existing command.
  - **Minimum fix (contract amendment, then source):** in `update()`, refuse any party change (customerId or buyerPharmacyId) when `order.recoveryRequest` exists (409). Also add `customerId: order.customerId` to the final write filter whenever the party changes, so the intake race is fenced. The alternative is an explicitly recorded reconciliation disposition.
  - **Checks:**
    - Record the current behaviour as evidence: a marker followed by reassignment gives A 404, B 503 and a page-wide 503.
    - With the fix, the reassignment gets 409.
    - Concurrent intake against reassignment.
    - Worklist pages that do not contain the order stay 200.
- **R8-F2-2 INFO (runtime).** Under snapshot isolation, a concurrent first writer normally surfaces as a WriteConflict (TransientTransactionError). The driver then re-runs the callback, and the loser takes the replay branch. The CAS-miss re-read branch is therefore mostly defensive.
  - Replay correctness depends on driver retry within its 120 s window.
  - An `UnknownTransactionCommitResult` that exhausts its retries propagates as 500 while the marker may already be committed; a client retry then replays it.

  Checks: two concurrent POSTs produce one marker, and either both responses are 200 with identical receipts or one surfaces a driver error. A forced unknown commit followed by a retry must replay the stored receipt.
- **Compatibility:** the same lowercase-only ID rule as R8-F1-2 applies here, whereas the module's `idParamSchema` accepts `[0-9a-fA-F]`.

## R8-3 Generic booking write boundary: APPROVE_SOURCE_ONLY

Verified:

- **Controller:** `resolveGenericBookingWriteScope` (L62-74) is the first statement of `update` (L378-379) and `delete` (L393-394).
  - The unchanged resolver runs first: 401 for a malformed actor, and 403 for a foreign owner hint from an exact user.
  - The unchanged HR 403 follows.
  - Any role other than exact `user` or `admin`, including padded or case variants, then gets 403 "Access to this booking resource is not permitted", before any service call.
  - A customer PUT still dispatches once to `updateCustomerNotes`, which is byte-unchanged. An admin keeps the shared `update` with the optional query owner, including when it is omitted.
- **Repository `deleteByIdAndUserId`** (L18-40):
  - A non-string or blank owner gets 401; a non-24-hex ID gets 400.
  - It then runs one `deleteOne({_id, userId:{$eq}, $expr:{$type of '$userId' is 'string'}})`.
  - It returns true only for `acknowledged===true && deletedCount===1`. Errors propagate, and there is no fallback.
- **Service `delete`** (~L1699-1734):
  - A supplied but invalid scope gets 401 before `getById`.
  - The pre-read and the reminder, Meet and slot sequence are byte-identical.
  - An omitted scope keeps the legacy unscoped `delete`. A supplied scope uses the scoped method, and `false` gives 409 BOOKING_DELETE_CONFLICT with no retry, re-read or fallback.
- **Specialist path:** specialist `updateAppointmentStatus` calls the shared `update`, which is untouched. The new guard lives only in the controller.

Findings: none introduced. These contracted residuals remain:

- Effects that run before a final 409 are not rolled back.
- A dirty array owner can pass the pre-read `getById` and trigger effects before the scalar final guard denies.
- A 12-character direct-call ID can match in `getById` and then get 400 after effects have run.
- An admin delete with omitted scope is unscoped and ignores the result.
- A customer can still hard-delete an own booking in any status (R4 B-C3).

- **R8-F3-1 INFO (runtime).** This has the same `$expr` dependency as R8-F1-1, but with no post-read fallback. If Mongoose ever stripped a top-level `$expr`, `{userId:{$eq}}` would match a dirty array containing the owner, and the booking would be deleted.

  Checks: dirty array, number, null and missing owners must give `deletedCount` 0 and 409; an exact scalar owner gives 200.

## R8-4 Constructor compatibility: APPROVE_SOURCE_ONLY (call shape only)

Verified:

- The PaymentService constructor has 19 parameters, ending with `medicineRepository`.
- The test call (test/pharmacy.integration.test.ts ~L528-548) supplies, in order:
  - `paymentRepository`;
  - 15 `{} as never` (positions 2-16);
  - `PharmacyWalletRepository` (17) and `PharmacyWalletTransactionRepository` (18);
  - a genuine new `MedicineRepository()` (19), using the existing import at L21 and its zero-argument constructor.
- The +30 bytes are consistent with that single added line. Production code is unchanged.
- The case uses `wallet_recharge` with an overridden `verifyAndMarkPaid`, so the new pharmacy_order gate and its catalogue read are not exercised.
- F5-3 is repaired at source level only. There is no TypeScript, TypeDI, 503-versus-TypeError or runtime proof.

Finding:

- **R8-F4-1 LOW (legacy-suite staleness).** This predates the delta: it comes from the R7 Rx-commerce increment and is only surfaced here. Two cases in this file encode pre-R7 behaviour that the current source no longer produces.
  - (a) "prescription medicines cannot be ordered without a prescription" (L304; predicate L339) expects `PRESCRIPTION_REQUIRED`. `create()` now reaches the `new_items` gate first and throws 503 `PRESCRIPTION_CHECKOUT_UNAVAILABLE`.
  - (b) "only one concurrent manual payment claim succeeds" (L214-239) uses `items: []` (L222). `markPaid` now runs the `stored_order` gate, which rejects empty items with 503 for both calls. The "exactly one fulfilled" assertion (L237) therefore fails, and the CAS race is no longer tested.
  - **Consequence:** if the suite is ever admitted, both cases fail for reasons unrelated to their names, and (b) silently loses its race coverage.
  - **Minimum fix (separate test-only contract):** give (b) an explicit active non-Rx line referencing an active catalogue medicine, with empty `prescriptionUrls`. Change (a) to expect 503 with inventory unchanged.
  - **Checks:** review the test-only diff now; run it only under a future C3 admission. I did not execute the suite or reinterpret its name or skip guards.

## R8-5 Authority fixture and actual pure evidence: APPROVE_SOURCE_ONLY

### Source: the 8 harness files against AUTHORITY_PURE_RUNTIME_CONTRACT

- **app-bundle.mjs:**
  - A fixed role with a sorted 9-name list.
  - Per-role caps: compiler under 10 MiB, every other file under 128 KiB, total under 12 MiB, manifest under 64 KiB. The default 6-file / 128 KiB profile is unchanged.
  - `assertBundle` accepts a 2- or 3-key expectation and requires nlink 1.
  - `AUTHORITY_CASE_IDS` contains 84 IDs (I recounted the group table) and there are 5 ordered controls.
  - `verifyAuthorityResult` checks exact keys in every block, recomputes the options hash, and requires each mutant hash to differ from the nominal hash of the affected module.
- **app-container.mjs:**
  - One shared lifecycle; `createAuthorityFixture` accepts `{endpoint}` only.
  - A simulated authority run requires an explicit executor, a plain bundle and an exact-key expectation, with no fallback to real sources.
  - The real path pins the compiler (size, uid, mode and SHA) and the 3 sources plus the vectors. The expectation must equal the staged manifest.
  - The result must have exactly 9 keys, be under 16 KiB, and contain no calls or scenario block.
  - Child stderr at start is forwarded, with a 32 KiB overflow record.
  - Network none, capabilities, mounts, tmpfs and the 20 s command timeout are unchanged.
- **bootstrap.mjs:** the role must be default or authority. Network admission and the canaries run before the authority import, and the default branch is intact.
- **authority-scenario.mjs:**
  - Re-admission and pin checks run before compilation and before every graph.
  - The compiler loads via `compileFunction` with `process` and `performance` shadowed and a `require` that rejects everything. The scenario asserts version 5.9.3, `sys===undefined`, and zero require attempts before and after each emit.
  - `transpileModule` runs with reportDiagnostics, the exact options and logical filenames, and no post-processing.
  - A fixed linker allows exactly 4 edges and a frozen `{createHash}`, with a per-graph module cache and exact export sets.
  - The recording ports assert a frozen lookup, the transaction identity and `now`. Falsy rejections are preserved, and denials assert both class and category.
  - Relation fixtures re-hash the declared arrays independently rather than through the production serializer.
  - Each mutant substitutes a unique literal and runs on a fresh graph. The target leaf must fail with an AssertionError carrying the intended marker, and a fresh nominal graph must then restore it.
- **run-authority.mjs, README and tests:** a fixed entry point. The fake-only authority tests reject drifted or null seams before any allocation.

### Recorded actual evidence

I read the evidence as text; I saw no raw bytes beyond the packet and recomputed no hash.

- **launcher.stderr:** one created line, then 103 AUTHORITY records:
  - 3 nominal EMIT records;
  - 84 nominal LEAF records, all `completed:true`, whose order, calls and expected values equal the REAL_RUN_MANIFEST leafProofs, including A30 at 2/2/2 and the zero-port leaves;
  - 5 x (mutant EMIT, mutant LEAF `completed:false`, restoration LEAF `completed:true`);
  - 1 PHASE record: 603.09 ms, 1 compiler load, 3+5 emits, 11 graphs, 11 evaluations per module.
- **launcher.stdout:**
  - Emit hashes equal the stderr EMIT hashes.
  - caseIds are in the exact order, with 84 passed, 0 failed and 0 skipped.
  - All 5 controls are detected and restored. Evaluations are 11/33 and boundary probes are 2.
  - The network summary is the measured 11-entry record.
  - The container ID and workspace equal the created line, and `cleanupAcknowledged` is true.
- **result.json:** PASS, with 16 commands, 1 launcher invocation, every capture complete, at EOF and owned, and all four postchecks true.
- **ARCHIVE_MANIFEST:** binds result 35a54173..., stdout 719e4bbd... and stderr 87c0e537..., with 33 files byte-identical.
- **REAL_POST_DECISIONS:** records two run approvals bound to c04c1cd, operator 1a589cc9 and manifest 0a19d8ff, plus two independent outcome acceptances.
- **Binding to current source:** REAL_RUN_MANIFEST and SOURCE_FREEZE pin exactly the current hashes of all 8 harness files and the 3 organizations modules, so the recorded run applies to these source bytes.
- **Separation of evidence classes:**
  - the 700 offline fake cases (350 each on Node 22 and Node 24) are a separate, harness-only campaign;
  - the 84 cases are actual whole-module behaviour under injected ports;
  - both differ from source review.
- **Provenance only:** the fc45 startup-locale guard failure (before allocation) and the host Node 24 rebind are preserved history, not retries or new grants.

### Findings (evidence semantics, non-blocking)

- **R8-F5-1 INFO.**
  - (a) `effects.{database,provider,sourceWrites,domainNativeImports}` are initialized to 0 in authority-scenario (~L34-36) and never incremented. They are structural constants, not measurements; their meaning comes from the closed linker plus admission, as REAL_POST_DECISIONS already says. Do not cite them as observed counters.
  - (b) A31.compiler-fs calls the rejector directly with a local array and increments `state.probes` by hand. It proves the rejector rejects, not that the compiler cannot import; that proof comes from `requireAttempts:0` together with `sysAbsent:true`.
  - (c) The 79 unmutated negative leaves assert the denial category only. Only the 5 mutated relations are proven sensitive; the other denials could in principle come from an earlier predicate, although the fixtures look coherent for their intended relations.
  - (d) Emit hashes are reported by the child; there is no host-side re-emission.

  Fix: none required within this scope. Rename or annotate these fields in any future schema revision.
- **R8-F5-2 INFO (documentation).** The README section "Fixed staff-authority role (source candidate, NOT RUN)" is stale relative to the accepted run, but it is a pinned run input. Update it in a later docs-only change, and record that the pin is superseded for documentation only.

Not proved (unchanged):

- real ClientSession, driver, indexes, readiness, provenance, qualification, provisioning and revocation;
- HTTP, JWT and Joi behaviour;
- semantic TypeScript validity;
- clinical, funding, module and release acceptance.

## R8-6 Pharmacy recovery worklist: APPROVE_SOURCE_ONLY

Verified:

- **Route** (L45-50): placed before `/:id` (L52) and after the two-segment customer routes, with no overlap.
  - It runs `requireOperationalPharmacy`, then `recoveryWorklistQuerySchema` (page 1-1000, limit 1-50, pharmacyId forbidden), then the handler.
  - An admin gets 403; there is no bypass.
- **Controller** (L39-55):
  - It uses only the guard-resolved `pharmacyId` and explicit page and limit.
  - It serializes once with `JSON.stringify`; a body of 64 KiB or more gives 503.
  - It sets private/no-store and sends as `application/json`.
- **Repository** (L138-207):
  - Scope check 403, then a closed plain query (only own enumerable data descriptors `page` and `limit`) with 400 otherwise.
  - One aggregate (L159-176):
    - `$match` on the ObjectId owner plus `recoveryRequest:{$exists:true}` and an `$expr` objectId owner type guard;
    - a 4-field `$project`;
    - a `$facet` with a pre-page `$count` and an `_id`-sorted skip and limit;
    - options `maxTimeMS` 2000 and `allowDiskUse` false.
  - Result checks:
    - the facet shape is exact, with at most one metadata row holding an exact `{total}` safe integer;
    - `data.length` must equal `min(limit, max(0, total - skip))`;
    - every row must have exactly 4 keys, ObjectId identities and an owner equal to the scope, and must pass the unchanged `recoveryReceipt`;
    - any failure gives a whole-response 503.
  - Each row maps to exactly 8 fields, with null money.
- **Effects:** no writes, no assignment and no settlement inference.

Findings:

- **R8-F2-1** (described under R8-2) is the main consequence here: a single ownership-inconsistent marker turns its whole page into a 503.
- **R8-F6-1 LOW (capacity, runtime).**
  - (a) The first `$match` uses the `pharmacyId` index but must examine every order of that pharmacy to test `recoveryRequest`. Cost therefore grows with lifetime orders, not with marker count. A `maxTimeMS` expiry propagates unmapped (errorHandler gives 500), not as the contract's 503.
  - (b) The `$sort` inside the facet cannot use an index and is limited to the 100 MB in-memory sort budget, with spill disabled.

  Fix (before activation, separate contract): a partial index `{pharmacyId:1, _id:1}` with `partialFilterExpression {recoveryRequest:{$exists:true}}`, or an explain-based capacity budget. Check: explain, time and bytes on a representative long-lived pharmacy.

## C Integrated composition: APPROVE_SOURCE_ONLY

- **Routes compose cleanly.** The external `/progress` route is disjoint from the report routes. The pharmacyOrders customer routes and the worklist both precede `/:id` without overlapping.
- **Shared helpers.** R8-2 and R8-6 share the byte-unchanged `recoveryReceipt` and digest helpers.
- **No new DI or import cycle.** The repository adds only `mongo`, `PipelineStage` and `crypto`, and the service only delegates.
- **Independence.**
  - The bookings and externalBookings changes are independent of the pharmacy modules.
  - R8-4 touches only the test file.
  - R8-5 touches only harness files and evaluates only the three pinned organizations modules, inside the container.
  - The R7 captured-only, refund-propagation and Rx-commerce code is untouched.
- **No resolution of financial facts.** Intake and the worklist only record and discover requests. They verify no cash, capture, funding, custody or stock fact and resolve no request, so F1 and F5-1 are unchanged.

## Retained open items

- **F1 HIGH, OPEN:**
  - qualified Rx decisions and provisioning;
  - existing gateway, captured, paid, legacy and dispatched custody;
  - original-instrument funded recovery.
- **F5-1 MEDIUM, OPEN:** current catalogue or snapshot denial can block manual-paid recording and completion on ready or out-for-delivery COD and legacy orders. The intake receipt and pharmacy discovery do not satisfy this gate.
- **Existing dispositions:** F1-1/2/3, F3-1, F5-2/3/4 and F6-1/2 stay as recorded, narrower than activation evidence. F5-3 is now repaired at source level only.
- **New:** R8-F2-1 MEDIUM (an activation gate), R8-F4-1 LOW, R8-F6-1 LOW, R8-F1-2 LOW, plus INFO items R8-F1-1, R8-F2-2, R8-F3-1, R8-F5-1 and R8-F5-2.
- No model decides real clinical or financial facts.

## Non-claims and limits

- **No acceptance is given for:**
  - TypeScript, compiler or types; Joi; HTTP; Mongoose or the driver; database, indexes or transactions;
  - providers, the application, races or runtime behaviour;
  - clinical, financial or security-owner decisions; supported clients;
  - module, M0, deployment or release acceptance.
- R8-5 is the only increment with recorded execution, and only within its Mongoose-free, injected-port scope.
- Final cross-module integration is DEFERRED_BY_OWNER, not PASS.
- **Coverage limits:** I inspected only the supplied text. SYSTEM_DESIGN was excerpted, and the provider and application import graph was omitted; nothing outside the packet was audited.
- **Provenance:** hashes were compared as text only. Native Codex decisions are internal evidence. No private reasoning is included.