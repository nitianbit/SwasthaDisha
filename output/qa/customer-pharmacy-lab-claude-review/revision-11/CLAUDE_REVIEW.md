# SD-CLAUDE-FOUR-INCREMENT-REVIEW-11 (claude-reviewer -> codex-lead)

**Result:** R11-2 is **REQUEST_CHANGES** for four LOW contract deviations. R11-1, R11-3, R11-4 and the composition are **APPROVE_SOURCE_ONLY**.

- I found no authorization, privacy, cross-owner or integrity defect in R11-2.
- All four R11-2 corrections stay inside the file module.

| # | Increment | Verdict | Evidence class |
| --- | --- | --- | --- |
| R11-1 | single-contact customer enrollment (e6334e8) | APPROVE_SOURCE_ONLY (INFO only) | source only; typecheck, Joi, HTTP, DB and provider NOT_RUN |
| R11-2 | private-document core and scoped pre-auth headers (26128ff) | REQUEST_CHANGES (R11-F2-1 to R11-F2-4, all LOW) | source only; Express, Formidable, fs and transactions NOT_RUN |
| R11-3 | contact-index evaluator and native reader (3678ff7) | APPROVE_SOURCE_ONLY (INFO and checks) | source only; native, BSON and Mongo8 NOT_RUN |
| R11-4 | supplier CAS projection and maxTimeMS (9a339b2) | APPROVE_SOURCE_ONLY | source only; ODM and driver NOT_RUN |
| C | composition at f200491e | APPROVE_SOURCE_ONLY | final integration DEFERRED_BY_OWNER |

## Binding context
I compared the values below as text only and computed no hashes; Root verifies the bytes.

- **Challenge:** team swasthadisha-local, message msg_1794522037149_zs8ihu1w (SD-CLAUDE-FOUR-INCREMENT-CHALLENGE-11). It is the only inbox message carrying this sessionId.
  - Ignored as stale: the challenges for revisions 2 to 10, the connectivity probe, and the interrupted R9 max challenge.
- **sessionId:** 757133e3-cd65-4334-832f-0c217897311b.
- **nonce:** 8c652a2b-751d-497c-af71-3e75b28bb868, acknowledged in msg_1794523438572_vyo6f5kg.
- **sourceCommit:** f200491e08e497d1bda82af010d9854f34b16515, the same in packet and challenge.
- **packetSha256:** 12a51559f5c1dafe260f7f9f2f11ea1a98ed850dbd6c38593a9397be2b4f65a2, as given in the challenge.
- **contractSha256:** 1bd0c206748df65c713df738d73b9e7f0dfde35cee9601e5e0e818f04653bb97, equal to the packet contractBundleSha256.
- **controllerSha256:** 4c19319089f0a5a141fc1473d54956dbdd4127c4b87b1dcca7bde011120ec57f, equal to the packet file/controller entry.
- **Model and effort:** claude-opus-5-5, per the session identity statement. Requested effort xhigh (explicitly not max); effective effort UNPROVEN.
- **Route:** a local agent session that used only Ruflo MCP mailbox tools: one inbox peek and two sends.
  - No native webview, shell, filesystem, git, browser, hosted worker or delegation.
  - The declared host kind is local-bundled-CLI; I cannot observe it from inside the session.

Source map (17 entries). Each is textually equal to the challenge and to the packet file's wholeFileSha256:
- API_SCHEMAS.md 68ba65584b18ebbb3c02f7c7f3c114123fb18ffa53d94c2fb57f67ca95d197a2
- src1/modules/auth/services/index.ts c522444ef80133c136a50d276ae64cdbaca8333049cca9723ff36d9f20bf3c48
- src1/modules/auth/validation/index.ts 752f049481df9de2587c386f8c44e5dc1548073295f36149a3974a3a9513af4c
- src1/modules/file/controller/index.ts 4c19319089f0a5a141fc1473d54956dbdd4127c4b87b1dcca7bde011120ec57f
- src1/modules/file/documentTypes.ts 89c7f2f262367de830b7925a200ae2d0e6c08a6966305ccb96f344fcf0c7d070
- src1/modules/file/documents.ts ad8a6bba2042dd6222d516dcd93c1473983a46ee9048742abf46674082b01276
- src1/modules/file/model/index.ts 44d8003d6324f44b4adba62428bbbb2661e988f60baf267e546ecb8a1923aa91
- src1/modules/file/repository/index.ts c06a2c06d8451d6f8eb622b2e149315c5499df1287682a40068296bb02f76208
- src1/modules/file/routes/index.ts 2934b9f85bcadcfb9c29dfba3d37adbbcd641bac1e004e15b1fe3ffc4a9cd76f
- src1/modules/file/services/index.ts 37a1090fa9389a3120e7371f32c9180d34ec9dc3e38a9ce34b186611f7ac8e96
- src1/modules/file/storage.ts 09315a3816094d291655f9f64e55bce49b0387385c8aef0c863542faf53d46cb
- src1/modules/file/validation/index.ts 1d93adca55ef7665c8ee3dee95c9c38924f2e0b40d52e9df0a4402e96396b85b
- src1/modules/pharmacySuppliers/repository/index.ts 3b4a1b515a60ef3a54ee6631ab8f0c2e340258a071fe6af446574779a01b8a57
- src1/modules/user/contactIndexManifest.ts 5fbaff2e98b38b47cf5645dbb95e322b1d33b988552730f2f4cce4f2a5294b7e
- src1/modules/user/contactIndexReader.ts e3e91b712e04e4d3fd9806c8fc44f3c2331033bcf95b98a118f123a546ecfef6
- src1/modules/user/contactIndexReadiness.ts b0f4300441dc4280220cfbe38a3fa1f2c829a058df0371a900a90136d8284749
- src1/routes/index.ts 9be841178931003004cc53a0285b5c849d82a82dbc798a4a0d38bf69396de6ea

Contract map (8 entries under documentation/planning/implementation/, textually equal to the challenge):
- BUSINESS_STAFF_AUTHORITY_CONTRACT.md 69dba46528295f55e184b95e1fb6ea451ee2371254d76eb7ac9fd6573068f9fd
- CUSTOMER_CONTACT_CHANGE_CONTRACT_DRAFT.md 8826f45a11651dc117ccb3119b6b9093405889324545a1679cf2efe8630e387a
- CUSTOMER_CONTACT_INDEX_ADMISSION_CONTRACT.md 0a3a4628d1ad01fa5603f590d1e0a8062e0b241cd0a3b293e1f0e0dd460ee384
- PHARMACY_SUPPLIER_CAS_RETURN_ADDENDUM.md 63958f07c82437b51763eb09aa4559dd6aa248d43de59b09d130cda56f66c2bc
- PHARMACY_SUPPLIER_MASTER_CONTRACT_DRAFT.md c47d541e60747f262e6828b912b2016c61c1e2b2f5a4dfcffc1f4bee8b4157b7
- PRIVATE_CLINICAL_DOCUMENTS_CONTRACT_DRAFT.md 2c016e285101c8a5852ad85974cd41a343ea59f31661ee8360e12eee192895f1
- PRIVATE_DOCUMENT_AUTH_HEADERS_ADDENDUM.md fe9479b80f66693de2e7f592bc9ab3335dc921595e36639fdb417a9547710b7b
- PRIVATE_DOCUMENT_REVIEW_REMEDIATION.md 8afbcad14c7c500a803beed589398093aabac2108ba19769814205ae6562147a

## Method
This was a read-only inspection of the packet text.

- **Inspected in full:**
  - all 17 changed files and all 8 contracts;
  - the supplied unchanged context: auth routes, controller, types and repository; the OTP model, repository, service and routes; the user model, repository, routes, controller and services; BaseRepository; the shared validator; errorHandler and auth middleware; app bootstrap; booking and external-booking models and repositories; the supplier module; and the lock entries.
- **Provenance only:** historical decisions, candidates, patches and the R10 review. I treated native Codex approvals as prior internal evidence, not as review.
- **Not used:** any form of execution.
- **Line references:** taken from the supplied whole files. `~L` marks hand-counted positions.
- **Third-party behaviour** is from knowledge, not read from package source in this packet, and each item has a matching check. This covers the Formidable 3.x error httpCodes, MongoDB cursor namespaces and BSON 4.7.2 shapes.

## R11-1 Single-contact customer enrollment: APPROVE_SOURCE_ONLY
Verified:

- **HTTP path (auth/routes:50-62), unchanged:**
  1. userType param Joi.
  2. The generic `.or` body schema.
  3. The controller.
  - A body with both contacts therefore still passes Joi, and is rejected by the service.
- **Service admission comes first.**
  - `sendOTP` (auth/services:101-106) and `verifyOTP` (:257-262) call `selectCustomerLoginContact` before OTP generation and before any lookup, create, wallet, notification or provider call.
  - For non-user roles the selector result is `undefined`, and every changed line falls back through `??` to the original expression. Admin, HR, pharmacy and specialist behaviour is therefore unchanged.
  - The legacy `sendOTPSchema` and `verifyOTPSchema` bytes are unchanged.
- **Selector (auth/validation:61-89):**
  - A non-object argument gives 400.
  - A non-undefined, non-string phone or email (null, number, object or array) gives 400.
  - The candidate omits undefined keys and trims and lowercases only the email.
  - It validates with `xor`, `convert:false` and `stripUnknown:false`. Empty or whitespace-only contacts fail `string.empty`.
  - Both or neither contact gives 400 VALIDATION_ERROR "Provide exactly one valid phone or email".
  - VERIFY validates the six-digit code before lookup, and `append` keeps the `xor` peers.
- **Persistence:**
  - The lookup (:133) and the new-user save (:167) use only `{[target]: targetValue}`. The other key is absent, not an undefined own property.
  - The OTP target and value (:210-211), the SMS `to` (:226) and the email recipient (:231-233) all use the selected canonical value.
  - The VERIFY lookup (:286) uses the selected key, and the verification target (:337) checks the selected kind against the stored current destination.
  - Existing-user login appends nothing.
- **OTP interaction (unchanged):** createOTP replaces a pending same-target challenge, and verifyOTP consumes conditionally on id, user, code, target, value and expiry. The raw OTP router is not mounted.
- **Documentation:** API_SCHEMAS lines 7-10 describe exactly this behaviour.

Findings (all INFO):

- **R11-F1-1.** A direct caller with a malformed `otp` gets the contact-oriented message (validation:69). HTTP callers are rejected earlier by the generic Joi schema.
- **R11-F1-2.** The contract's optional route-level `oneOf` branch was not taken. HTTP clients therefore see two different 400 texts (Joi and service) for invalid shapes. Both carry VALIDATION_ERROR and both precede lookup.
- **R11-F1-3.** The unchanged API_SCHEMAS Notes still say that every other endpoint needs a Bearer token. That is untrue for /api/static/*, news, meet, webhooks, public pharmacies and blogs, and app-versions. Pre-existing and outside this increment.
- **Retained, outside this increment:**
  - There is no unique contact index, so concurrent first sends for one new contact can still create two users.
  - Legacy two-contact rows remain.
  - verifyOTP still sets the aggregate isVerified flag.
  - Purpose and generation binding, revocation and the contact-change commands are not implemented.

Checks:
- Two contacts on SEND and VERIFY return 400 with zero user, OTP and provider calls.
- Phone-only and email-only enrollment each persist exactly one contact key.
- A direct call with `{phone, email: undefined}` succeeds.
- null, number, array and empty contacts return 400.
- Uppercase or whitespace-padded email is canonicalized.
- Staff roles behave as before.

## R11-2 Private-document core and pre-auth headers: REQUEST_CHANGES
Verified:

- **Mount (routes/index.ts:71):** exactly `privateDocumentHeaders, authenticate, fileRouter`.
- **Predicate (file/routes:7-10):** a bounded, case-insensitive `assets|clinical` prefix test on the mount-relative `req.path`.
  - Express mount and route matching are case-insensitive by default, so /Assets and /CLINICAL get both the headers and the handlers; /assetsx and /clinicalx get neither.
  - The middleware makes no lookup, body parse or decision.
- **Header helper (file/controller:18-32):**
  - It sets Cache-Control, Pragma and nosniff, and calls `res.vary`, which keeps existing tokens. It also removes ETag and Last-Modified.
  - It deletes If-None-Match and If-Modified-Since, so `req.fresh` is false and no 304 is produced.
  - It installs one WeakSet-guarded `end` wrapper. The wrapper strips regenerated validators before headers are sent and forwards `this`, all arguments and the result.
  - Covered: private JSON (send), errorHandler JSON (including pre-auth 401s and the global 404 for unknown /assets paths) and HEAD.
  - Byte streaming never calls send, and its first write carries these headers.
  - No app setting or serializer changed. **PRIVATE-R1 is resolved.**
- **Error shaping:** `privateRequest` rethrows only `DOCUMENT_*` AppErrors and turns everything else into a 503, so no driver or filesystem text reaches the client.
- **Identity and DTO:**
  - Only user actors are admitted; other actors get 403.
  - Query and body must be closed objects of own data descriptors, and documentKey must be a UUIDv4.
  - The asset and version key tuples are fixed and the asset `_id` is derived on the server; a prefix collision returns 409.
  - The VersionDTO has exactly 13 fields.
  - Listing uses limit+1 `_id` seek pagination and validates the whole page.
  - Revoke applies only to unbound assets and compares the operation receipt.
  - Clinical revoke, validate and release are internal only.
- **Default closure:**
  - In `FileDocumentPolicy` (file/repository:15-26), readiness throws and the scanner and release ports return `unavailable`.
  - Every upload, list, content and revoke path calls `ready()` before any metadata write or byte.
  - The models set autoIndex and autoCreate to false.
  - legacy_access_unknown is never readable.
- **Transactions:**
  - One session per command on the shared connection, with a connection identity check; snapshot read concern and majority write concern; a callback-scoped result; and a session-membership guard on every repository call.
  - Capture writes, in one transaction: the asset (if absent), the version, a pointer CAS and the audit row.
    - The CAS matches owner, identity, revision, `revokedAt: null` and a scalar `$expr`.
  - A duplicate replay returns 200 without changing pointer, revision or audit.
  - Duplicate-key error 11000 on any of the three identity indexes triggers one fresh reconciliation transaction. Losing writes stay as private orphans.
- **Capture lifetime (file/storage:142-279)** resolves PRIVATE-R2 and the Spec items:
  - One monotonic deadline, which is also passed into verification.
  - An abort, socket-close or deadline latch. After the listeners are removed it is still enforced by polling the request properties.
  - The file handle is held before its first stat and closed in `finally`; if that first stat fails, the held handle's stat recovers the identity.
  - Files are deleted only when the inode and staging identity both match; otherwise the orphan is retained.
  - `captured` is frozen and registered in a WeakMap lease bound to the exact Request.
  - `assertCaptureAdmission` runs before the transaction, at callback start, before each metadata write and before both callback returns, including retries and reconciliation (documents.ts:59-90).
- **Content reads:**
  - Checks owner, scope, readability and Range (416).
  - Writes a durable read_admitted record in its own transaction before opening any descriptor.
  - Verifies the full file's hash, type, size and identity before the first byte.
  - Streams bounded, positioned reads from the same descriptor under the same deadline.
  - Writes read_finished in a separate transaction with the real byte count.
  - HEAD verifies the file but sends no body.
- **Legacy isolation:** the static, fetch, upload and delete aliases pass `legacyPath` or `legacyUploadScope` before any byte operation, and reserved-subtree denials get the private headers.

Findings:

- **R11-F2-1 LOW: legacy upload responses changed.**
  - **Where:** file/controller:93 calls `applyPrivateDocumentHeaders(res)` unconditionally at the top of `uploadFiles`.
  - **Effect:** every legacy POST /upload and /upload/:module response, successes included, now carries:
    - private Cache-Control, Pragma, `Vary: Authorization` and nosniff;
    - validator stripping and deletion of the request's conditional headers.
  - **Why it matters:**
    - The core contract says these adapters change only their path guards and remain byte-preserved.
    - The addendum and the remediation both say legacy image handling is unchanged.
    - Practical risk is small for a POST JSON response, but this is the legacy image header effect the packet excludes.
  - **Minimal fix:** drop :93 and apply the helper only when `legacyUploadScope` or `legacyPath` denies: catch the `DOCUMENT_*` AppError around `fileService.uploadFiles`, apply the headers, then rethrow.
  - **Check:** compare baseline and current headers for a successful legacy upload, and confirm that a reserved-subtree module denial still carries the private headers.
- **R11-F2-2 LOW: Formidable input errors are misclassified.**
  - **Where:** storage:151-153 (`cancel`) and :249-252 (the catch) turn every error that is neither an AppError nor httpCode 413 into a 503 DOCUMENT_STORAGE_UNAVAILABLE.
  - **Effect:**
    - Formidable 3.x tags a malformed multipart body, a missing boundary and an empty file with httpCode 400. Clients therefore get a retry-inviting 503 instead of 400 DOCUMENT_INPUT_INVALID.
    - maxFiles, maxFields and maxFieldsSize carry 413 and become DOCUMENT_TOO_LARGE, while the contract treats "exactly one file and no fields" as a 400 case.
  - **Minimal fix:**
    - map httpCode 400 to 400 DOCUMENT_INPUT_INVALID;
    - keep 413 only for the file-size codes;
    - map the count and field limits to 400;
    - leave unknown codes as 503.
  - **Checks:** a bad boundary, a truncated body, an empty file, two files, and one or two extra fields.
- **R11-F2-3 LOW: the clinical route accepts `unbound_upload`.**
  - **Where:** controller:67 forwards `req.params.resourceKind`, and documents.ts:40 admits all three kinds.
  - **Effect:** POST /clinical/unbound_upload/<anything>/uploads silently becomes an unbound private upload and never validates `:resourceId`.
    - There is no authority change: owner, purpose and identity are the same as /assets/uploads.
    - However, the contract fixes this route's resourceKind to booking or external_booking.
  - **Minimal fix:** `uploadClinicalAsset` rejects any other kind with 400 before calling `upload`.
  - **Check:** that URL returns 400 with zero storage or database effects.
- **R11-F2-4 LOW (conditional): reserved-subtree alias on case-folding filesystems.**
  - **Where:** storage:31 compares `part.toLowerCase()` with `__private_assets_v1`, and the lstat walk (:38-47) rejects only symlinks.
  - **Trigger:** a directory that applies Unicode case folding: ext4 or f2fs casefold, and possibly case-insensitive APFS. There, `__private_aſſets_v1` names the private root, because U+017F folds to `s` but `toLowerCase` leaves it unchanged.
  - **Effect:** that alias reaches the private root through /api/static, /fetch and deleteFile.
  - **Mitigations:** reading or deleting still needs the 256-bit random object filename, and default Linux ext4 is unaffected.
  - **Why it still matters:** the contract requires rejecting normalized aliases and not relying on obscurity.
  - **Minimal fix:** record the reserved directory's dev:ino, which `roots()` already derives, and reject in legacyPath any existing path component whose lstat dev:ino matches it. Alternatively, reject non-ASCII segments.
  - **Check:** a fixture directory with casefold enabled.

INFO:

- **Cleanup errors (storage:253-273).** An exception during cleanup (drift in `directory(lstat(staging))`, or a close or unlink failure) replaces the original error or a completed capture. This fails closed and keeps the orphan, but loses the original 400, 413 or 415 code.
- **Errors after bytes are sent.** `privateRequest` destroys the response, then errorHandler attempts to write JSON on it and Express falls back to finalhandler. Benign, but it logs a secondary error.
- **Audit schema (file/model:30-35)** has no enum or pairing for phase and outcome; only the typed call sites constrain them.
- **Audit attribution.** The internal `releaseVersion` and `validateVersion` record the asset owner as the audit actor. A future signatory or scanner adapter must supply its own accountable actor.
- **Legacy compatibility to inventory before activation:**
  - legacyPath (storage:27, :38-47) now refuses decoded names containing `% ? # ~` or control characters, and any symlinked path component, including a symlinked UPLOAD_DIR.
  - `roots()` needs a non-symlink, service-owned root with mode 0700, while FileService creates the root with the default mode. Private storage therefore fails closed until the root is provisioned.
- **Content-type test:** the upload content-type check is case-sensitive (documents.ts:50).
- **Outside the header contract, as stated:** parser errors raised before the mount, and `app.options('*', cors())` preflights.
- **Type-check focus (NOT_RUN):** the `as Response['end']` cast over the overloaded `end`, and the typing of the `res.req` header deletion.

Retained limits:

- Legacy public clinical static paths remain open.
- No scanner, qualified-release or readiness adapter exists yet.
- The filesystem threat boundary excludes a hostile same-uid process.
- A pending syscall or an admitted commit cannot be cancelled.
- Full S1, client and cutover gates remain.

## R11-3 Contact-index evaluator and native reader: APPROVE_SOURCE_ONLY
Verified:

- **Manifest:** recursively frozen, exact data.
- **Evaluator (contactIndexReadiness)** imports only util, buffer and the manifest.
  - It copies the manifest first and deep-compares it.
  - All copies go through own data descriptors. Proxies, accessors, symbols, cycles and foreign prototypes are rejected, within 8192 nodes, depth 16 and 262144 JSON bytes.
  - It checks the exact observation shape, budgets and binding.
  - A non-COMPLETE observation returns its declared failure code.
  - A COMPLETE observation must have:
    - 2 to 6 commands, confirmed cleanup, an ended session and exhausted cursors;
    - the exact listCollections row: options limited to collation, and info containing only readOnly:false and the bound UUID;
    - every index row exactly `{spec}`, where any build marker denies by its presence;
    - only ordinary numeric specs within the frozen option set, plus the exact retained `name_text`, which is the only string-key form;
    - an `_id_` that agrees with idIndex in v, options and collation, and the presence of `name_text`;
    - the exact named, unique, partial contact index with no sparse, hidden or TTL option;
    - an effective collation that is either explicitly simple, or absent with an observed simple default.
  - Only READY sets metadataReady.
- **Reader binding:**
  - Takes zero arguments and is pinned to mongoose 6.13.8.
  - Checks User model, Connection, native Db, MongoClient, wrapper and native collection identity through own data properties and prototype getters. It never reads the URL or credentials.
  - Requires the client profile: direct connection, retryReads false, pool size 1, every timeout ≤250 ms.
  - Owns one session with causalConsistency false, and re-checks identity before every command and before cleanup.
- **Reader commands:**
  - The only commands are:
    - a literal listCollections filtered to the exact name;
    - a UUID-targeted listIndexes with includeIndexBuildInfo;
    - at most four getMores using the held native Long;
    - one exact killCursors.
  - They run with read preference primary, promoteLongs and promoteBuffers false, and UTF-8 validation on.
  - Acquisition stops at 4 s, and no acquisition command starts with less than 1 s before that cutoff. Cleanup ends by 5 s, and no cleanup command starts with less than 500 ms left. There is no retry.
- **Reader BSON copy:**
  - Native Long, Timestamp and Binary values are admitted only at their declared transport paths.
  - The native UUID prototype is admitted only at `cursor/firstBatch/N/info/uuid`, and only with exactly four fields, `__id` undefined, subtype 4 and 16 bytes. It is rebuilt as a fresh Binary.
  - Logical size is accumulated per element and must equal `calculateObjectSize` of the owned copy.
- **Reader results:**
  - An unsupported row fails the whole observation (UNSUPPORTED) rather than being filtered out.
  - The listing is capped at 64 rows: a 65th row or a non-terminal empty batch fails, and no prefix is ever reported COMPLETE.
  - A returned cursor is captured before any copy-time failure, so it can still be killed.
  - Uncertain or unconfirmed cleanup is reported as FAILED/CLEANUP_UNCONFIRMED.
  - The result is frozen, and the module is not imported anywhere.

INFO and checks:

- **R11-F3-1 INFO (check).** header() requires `cursor.ns === <db>.users` (reader ~L198), and getMore and killCursors target `users` (~L257, ~L302).
  - Historically some servers reported listIndexes cursors as `<db>.$cmd.listIndexes.<coll>`.
  - If Mongo 8.0.x does that, every run fails closed with CURSOR_INCOMPLETE and never reaches READY.
  - Confirm the actual reply form in the admitted fixture, including a multi-batch case.
- **R11-F3-2 INFO.** After an uncertain command, CLEANUP_UNCONFIRMED overwrites the primary failure code. This matches the contract but loses the diagnostic.
- **R11-F3-3 INFO.** Wildcard keys such as `{"$**":1}` without wildcardProjection pass as ordinary unrelated rows. They can never satisfy the contact requirement.
- **Retained limits:**
  - metadataReady does not mean all-account, backfill or all-writer coverage, legacy ownership or activation.
  - There is no socket cancellation and no pre-decoder heap bound.
  - The User schema does not yet declare contactKeys or its index. Until the identity writer exists, new single-contact users fall outside the partial index.

## R11-4 Supplier CAS projection and time budget: APPROVE_SOURCE_ONLY
Verified:

- **Change:** pharmacySuppliers/repository:97 (update) and :116 (archive) now pass `projection: supplierProjection, maxTimeMS: 2000` alongside new, upsert and runValidators.
- **Unchanged bytes:**
  - the filters: owned `_id` and pharmacyId with `$expr` objectId guards, state active, expectedRevision, and the `$type` guard on state;
  - `$set`/`$inc`, the pre-read, the archived replay and the 409 paths.
- **Effect:** the 15-field projection equals the full schema field set (versionKey is false).
  - Ordinary records return identical DTOs.
  - A stored extension field no longer causes a 503 after a committed write.
  - **R10-F2-1 is source-repaired.**

INFO and open items:
- MaxTimeMSExpired still reaches errorHandler as an unmapped 500 carrying the driver message.
- A timeout or lost response can follow a committed write. No retry was added and none is claimed.
- R10-F2-2 (owner index and capacity) stays open.

Checks:
- A stored extension field, then PATCH and archive: each returns 200 with the exact DTO, and the extension is still stored.
- A malformed supported field returns 503.
- A stale CAS returns 409.
- Archived replay is unchanged.
- Forced maxTimeMS behaviour is observed.

## C Integrated composition: APPROVE_SOURCE_ONLY
- **Routes:** src1/routes/index.ts changes only the file import and mount.
  - Auth send and verify stay public.
  - The file mount stays authenticated, with the header middleware ahead of authentication.
  - The supplier mount is unchanged.
- **Dependencies:** the file module's DI chain has no cycle with auth or user. That chain runs controller, then service, then repository, storage and policy, then the booking and external-booking repositories.
  - There is no package, start-script or global-middleware change.
- **User model:** the contact-index reader binds to the unchanged User model and its declared `name_text`. R11-1 writes no contactKeys, which keeps metadata and coverage as separate dimensions.
- **Suppliers:** normalization and the DTO are untouched.
- **API_SCHEMAS** adds only the admitted customer-login behaviour and documents none of the default-closed private-document endpoints.
- **R11-2 corrections:** all four are module-local and do not alter the composition.
- Final cross-module integration is DEFERRED_BY_OWNER, not PASS.

## Retained open items
- **F1 HIGH and F5-1 MEDIUM:** OPEN and untouched.
- **R10 evidence:**
  - R10 genuinely covered 9debdd only.
  - Its launcher exit 1, IDENTITY_UNKNOWN and cleanup IDENTITY_CHANGED remain UNPROVEN.
  - The R9 interruption is retained, there is no clean wrapper PASS, and none of these four increments has prior acceptance.
- **R10-F2-2:** open. Earlier R8 and R10 dispositions are unchanged.
- **New in R11:**
  - LOW: R11-F2-1 to R11-F2-4.
  - INFO: R11-F1-1 to R11-F1-3, R11-F3-1 to R11-F3-3, plus the INFO notes under R11-2 and R11-4.

## Non-claims and limits
- **No acceptance is given for:**
  - type checking, HTTP, Joi, Formidable, ODM, driver, BSON;
  - database, indexes, transactions, races, rollback, filesystem, providers, capacity;
  - clinical, privacy, client, owner, module, M0, deployment or release.
- Corporate, HR and hospital expansion is DEFERRED_BY_OWNER, and the mutable fixture sources are excluded.
- I inspected only the supplied packet text. The whole-repository call graph was not supplied; for example, other callers of AuthService or FileService.deleteFile could not be checked.
- Hashes were compared as text only. No private reasoning is included.