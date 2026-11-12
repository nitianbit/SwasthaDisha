# SD-CLAUDE-PRIVATE-CORRECTIONS-REVIEW-12 (claude-reviewer -> codex-lead)

**Result:** R12-1 to R12-4 and the composition are all **APPROVE_SOURCE_ONLY**. Each of R11-F2-1 to R11-F2-4 is repaired in source.

- No blocking finding.
- R12-4 is conditional: the case-folding trigger was not observed (NOT_RUN).
- Four INFO notes. R12-I1 records a residual Formidable plugin-selection path that still yields 503 for a crafted Content-Type.

| # | Correction | Verdict | Evidence class |
| --- | --- | --- | --- |
| R12-1 | R11-F2-1 legacy POST headers | APPROVE_SOURCE_ONLY | source only; Express NOT_RUN |
| R12-2 | R11-F2-2 native multipart errors | APPROVE_SOURCE_ONLY (INFO R12-I1, R12-I2) | source plus the six pinned Formidable 3.5.4 members; parser NOT_RUN |
| R12-3 | R11-F2-3 clinical kind | APPROVE_SOURCE_ONLY | source only; HTTP and DB NOT_RUN |
| R12-4 | R11-F2-4 reserved identity guard | APPROVE_SOURCE_ONLY, conditional (INFO R12-I3) | source only; casefold condition NOT_RUN |
| C | composition at 3eab68bb | APPROVE_SOURCE_ONLY (INFO R12-I4) | final integration DEFERRED_BY_OWNER |

## Binding context
I compared the values below as text only and computed no hashes.

- **Challenge:** team swasthadisha-local, message msg_1794526336232_bfaq6a9m (SD-CLAUDE-PRIVATE-CORRECTIONS-CHALLENGE-12). It is the only inbox message carrying this sessionId.
  - Ignored as stale: the challenges for revisions 2 to 11 (including the R9 max request) and the connectivity probe.
- **sessionId:** 175c0268-3367-4483-9616-f5e7abc99428.
- **nonce:** f51c7582-23fb-4b75-a64d-dfb5f08fb17e, acknowledged in my first send.
- **sourceCommit:** 3eab68bb3348b479254d21667caa93cadcea5bec, the same in packet and challenge.
- **packetSha256:** 4d3ef5122fd91c03006be37308b04f61ac88b2ff8ca56e07cb24d76ee3d80747, as given in the challenge. The packet does not state its own hash.
- **contractSha256:** 9afd04e7205cdbe666ff1cec13a29844c9897531b1b76df0299ebe8fba047708, equal to the packet contractBundleSha256.
- **controllerSha256:** fc4e9fbb27f1637a2587082ed4dbceef29a2efb0ad839ca6c89bf2e786da2525, equal to the packet controller entry.
- **Source map (2 entries)**, each textually equal to the challenge, the packet wholeFileSha256 and SOURCE_CANDIDATE afterSha256:
  - src1/modules/file/controller/index.ts fc4e9fbb27f1637a2587082ed4dbceef29a2efb0ad839ca6c89bf2e786da2525
  - src1/modules/file/storage.ts 17e3a9c713e5869fbf9739e698887ea222f4f8d2e0c2a3435a0d8b51a48bd558
- **Contract map (4 entries under documentation/planning/implementation/)**, textually equal to the challenge:
  - PRIVATE_CLINICAL_DOCUMENTS_CONTRACT_DRAFT.md 2c016e285101c8a5852ad85974cd41a343ea59f31661ee8360e12eee192895f1
  - PRIVATE_DOCUMENT_AUTH_HEADERS_ADDENDUM.md fe9479b80f66693de2e7f592bc9ab3335dc921595e36639fdb417a9547710b7b
  - PRIVATE_DOCUMENT_REVIEW_REMEDIATION.md 8afbcad14c7c500a803beed589398093aabac2108ba19769814205ae6562147a
  - PRIVATE_DOCUMENT_R11_SOURCE_CORRECTION_PLAN.json 98bb854464e8665f926c8dff065fb7e2de646367865ebd15f4434482e09524e4
- **BEFORE files (git-history f200491e):** controller 4c19319089f0a5a141fc1473d54956dbdd4127c4b87b1dcca7bde011120ec57f and storage 09315a3816094d291655f9f64e55bce49b0387385c8aef0c863542faf53d46cb. Both equal the plan beforeHashes and the R11 challenge entries.
- **Unchanged context:** documents, documentTypes, model, repository, routes, services and validation in the file module, plus src1/routes/index.ts, are textually equal to the R11 challenge values.
- **Formidable 3.5.4:** the six members' wholeFileSha256 equal NATIVE_FORMIDABLE_INPUTS, and the lock integrity string sha512-YikH+7CU… equals the package-lock formidable entry. The tar hash 335f6f18… is provenance only.
- **Model and effort:** claude-opus-5-5, per the session identity statement. Requested effort xhigh (explicitly not max); effective effort UNPROVEN.
- **Route:** a local agent session that used only Ruflo MCP mailbox tools: one inbox peek and two sends.
  - No native webview, shell, filesystem, git, browser, hosted worker or delegation.
  - The challenge declares clientKind local-bundled-CLI; I cannot observe the host binary from inside the session.

## Method
This was a read-only inspection of the packet text.

- **Read in full:** both AFTER and BEFORE files, SOURCE.patch, the four owning documents, the R11 review, the outcome, plan and source decisions, the standards review, the 30 src1 files in the packet, package.json and package-lock.json, and the six Formidable members.
  - The packet calls the source context "29"; I counted 30 src1 files including the two changed ones and did not reconcile the difference.
- **BEFORE vs AFTER, by reading:** the only changes are the patch hunks.
  - Controller: the import, two lines in uploadClinicalAsset, and the uploadFiles header and catch.
  - Storage: two imports, captureError, the reserved lstat and walk condition, and the two normalizer call sites.
  - Lease, deadline, finalizer, cleanup, verify and stream code reads as byte-identical.
- **Third-party behaviour:**
  - Formidable behaviour is read from the supplied pinned members.
  - Express behaviour (`res.send` ETag, `req.fresh` limited to GET/HEAD) is from knowledge, and each item has a matching check.
- **Native Root and Codex decisions** are context only, not review.
- **Not supplied:** `@/config/config`, `@/services/logger`, @types/formidable, tsconfig, and formidable's package.json exports map.

## R12-1 (R11-F2-1) Legacy POST headers: APPROVE_SOURCE_ONLY
Verified:

- **Unconditional helper removed.** The top-of-handler `applyPrivateDocumentHeaders(res)` is gone (`src1/modules/file/controller/index.ts:94-111`).
  - Unchanged: module and recordId derivation, the single `fileService.uploadFiles(req, module, recordId)` call, status 200 and the body.
- **Denial-only catch (`:99-104`).** Private headers are applied only for `error instanceof AppError && typeof code === 'string' && code.startsWith('DOCUMENT_')`, which is the same predicate as `privateRequest`. The same error object is then rethrown.
  - `FileService.uploadFiles` is `async`, so the synchronous `legacyUploadScope` and `legacyPath` throws (`services/index.ts:68-70`, plus the per-file `legacyPath`) arrive as rejections and are caught.
  - The service's own catch passes AppErrors through unchanged.
- **Which errors get private headers:**
  - Get them: DOCUMENT_INPUT_INVALID (bad or reserved module/recordId, raw path grammar), DOCUMENT_NOT_FOUND (reserved, alias or symlink), DOCUMENT_STORAGE_UNAVAILABLE (the new reserved-lstat failure).
  - Do not: NO_FILES, FILE_TOO_LARGE, INVALID_FILE_TYPE, UPLOAD_FAILED. These ordinary legacy errors keep their original headers.
- **Success responses** no longer carry:
  - private Cache-Control, Pragma, `Vary: Authorization` or nosniff;
  - the `end` wrapper;
  - deletion of the request's conditional headers.
  - Express ETag generation on the POST JSON comes back. `req.fresh` is evaluated only for GET/HEAD, so there is no 304 path for POST either way.
- **Untouched:**
  - the pre-auth `privateDocumentHeaders` assets/clinical scope (`/upload` does not match);
  - `legacyFilePath`;
  - `serveFileByPath` HEAD, error and public-cache behaviour;
  - the mount.

Checks:
- Compare baseline and current headers and body for a successful `POST /upload/bookings`: they must be identical, including ETag and no `Vary: Authorization`.
- NO_FILES, INVALID_FILE_TYPE and UPLOAD_FAILED carry no private headers.
- `/upload/__private_assets_v1`, `/upload/__PRIVATE_ASSETS_V1` and `/upload/a.b` return 400 DOCUMENT_INPUT_INVALID with private headers, zero parse and zero writes.
- A spy shows exactly one service call with unchanged arguments.

## R12-2 (R11-F2-2) Native multipart errors: APPROVE_SOURCE_ONLY
Verified:

- **One helper, both routes.** `captureError` (`src1/modules/file/storage.ts:16-36`) is reused by:
  - the cancellation latch (`:184`, `lease.failure ??= captureError(error)`);
  - the outer catch (`:281`, `throw captureError(error)`).
  - The deadline timer, request abort, socket close, writer error and form error listeners all reach `cancel`.
- **AppError preserved.** The test is `instanceof AppError`, using the same `@/modules/common/types` class that `documentError` builds.
  - It is stricter than the old `name === 'AppError'` duck-type and returns the identical object.
  - Domain 400/413/415 errors therefore survive: the fileBegin guard, field and file counts in the parse callback, `media()` 415, the declared/actual 415, the writer 413 and the request-byte 413.
- **Native classification.**
  - Only `error instanceof Error` with an own data-descriptor `code` is classified. An accessor `code` yields undefined and maps to 503.
  - `switch` uses strict `===` against numeric constants, so string `'1012'`, NaN or any other number falls to the 503 default.
  - `httpCode` is never read.
  - In the pinned FormidableError.js, the constructor sets `this.code = internalCode` as an own data property.

| Pinned constant | Code | Native httpCode | Mapped |
| --- | --- | --- | --- |
| maxFieldsSizeExceeded | 1006 | 413 | 400 |
| maxFieldsExceeded | 1007 | 413 | 400 |
| smallerThanMinFileSize | 1008 | 400 | 400 |
| biggerThanTotalMaxFileSize | 1009 | 413 | 413 |
| noEmptyFiles | 1010 | 400 | 400 |
| missingContentType | 1011 | 400 | 400 |
| malformedMultipart | 1012 | 400 | 400 |
| missingMultipartBoundary | 1013 | 400 | 400 |
| unknownTransferEncoding | 1014 | 501 | 400 |
| maxFilesExceeded | 1015 | 413 | 400 |
| biggerThanMaxFileSize | 1016 | 413 | 413 |
| all others (1000-1005, 1017, 1018) | - | 500/415/409 | 503 |

- **Exports:**
  - `src/index.js` declares `export * as errors from './FormidableError.js'`.
  - `dist/index.cjs` sets `__esModule`, `exports.default = formidable` and `exports.errors = FormidableError$1`, a frozen object that holds all 11 referenced names.
  - TS CommonJS emit (with or without esModuleInterop), esbuild/tsx interop and native ESM therefore all resolve `formidableErrors.<name>` to the numeric constant, whichever entry the unsupplied exports map selects.
  - There is no dependency change; the lock still pins 3.5.4.
- **Reachability with the current options and callers:**
  - **Two files:** Formidable's constructor-registered fileBegin listener raises 1015 before the local guard, giving 400.
  - **Fields:** a second field or more than 4096 field bytes raises 1007 or 1006, giving 400. A single field gets the local 400.
  - **Truncated body that still ends cleanly:** `_flush` raises 1012, giving 400.
  - **Missing or empty boundary:** 1013, giving 400. The first `_error` wins over noParser, and noParser (415) cannot be reached after `documents.ts:50`.
  - **Zero-byte part:** 1010, giving 400.
  - **More than 10 MiB:** 1009, or the local writer or request-byte bound, giving 413.

INFO:

- **R12-I1 (residual Formidable behaviour; not introduced by R12).**
  - **Cause:** `_parseContentType` runs every default plugin, `[octetstream, querystring, multipart, json]`, each a substring test on Content-Type. The last parser assigned wins. `documents.ts:50` checks only the `multipart/form-data;` prefix.
  - **Trigger and effect:**
    - A Content-Type parameter containing `json` (e.g. `boundary=json-x`) installs JSONParser. Its `JSON.parse` SyntaxError has no own `code`, so the client gets 503 instead of 400. A rare legitimate boundary containing "json" would get the same 503.
    - A parameter containing `octet-stream` routes through the octet plugin. That ends in 400 (fileBegin name guard) or 415 (the declared type is the multipart header).
    - Both outcomes fail closed, and no bytes reach anything but the owned writer.
  - **Minimal future fix (outside this frozen plan):** add `enabledPlugins: [multipart]` (the exported plugin) to the capture options, or reject Content-Type values matching `/json|urlencoded|octet-stream/i`.
  - **Check:** send `boundary=json-x` and `boundary=octet-stream-x`.
- **R12-I2: classification keys on the numeric own `code`, not on FormidableError identity.**
  - A collision inside capture is implausible: Node fs error codes are strings.
  - If a referenced constant were ever absent, `case undefined` would map codeless errors to 400. That is not live, because all 11 are present in both pinned entries.
  - Optional hardening: a load-time assertion that all 11 are finite numbers, and/or `instanceof formidableErrors.default`.
  - The typecheck of the named `errors` import against @types/formidable 3.4.6 (not supplied) is NOT_RUN.

Checks:
- The plan regressions:
  - bad boundary, truncated body, empty file, one or two extra fields, and two files each return 400;
  - an actual oversize upload returns 413;
  - unsupported media returns 415.
- A direct test of the helper with forged inputs:
  - an accessor `code`;
  - a string `'1012'`;
  - `{ httpCode: 400 }` with no `code`;
  - AppError passthrough by identity;
  - boolean and undefined values from the socket-close and timeout listeners.
- Exercise each case through both the `form.on('error')` cancel route and the parse-callback catch route.
- A runtime assertion of the constants under the actual loader.

## R12-3 (R11-F2-3) Clinical kind: APPROVE_SOURCE_ONLY
Verified (`src1/modules/file/controller/index.ts:65-72`):

- **Order inside `privateRequest`** (private headers are applied first):
  1. `actor(req.user)` (`:67`).
  2. The kind check `input(...)` (`:68`), with exactly `=== 'booking'` or `=== 'external_booking'`. It is case-sensitive, so `Booking`, `unbound_upload`, `constructor` and an empty value fail.
- **Effect of that order:**
  - A non-user actor gets 403 DOCUMENT_ACTOR_FORBIDDEN before the kind is examined.
  - An unsupported kind gets 400 before `documents.upload`. That is before the query and documentKey checks, `ownedResource` (DB), `ready()`, the content-type check and `storage.capture`.
- **No duplicate authority algorithm.** The handler reuses the existing `actor` and `input` helpers. `upload` recomputes the actor.
- **Unchanged:**
  - `/assets/uploads` still passes `'unbound_upload'` (`:58-63`).
  - `documents.ts:40` still admits all three kinds for direct service use.
  - The pre-auth 401 and the private headers for `/clinical` in any case come from the unchanged mount middleware.
- **Order versus R11:** kind is now checked before documentKey. This is not observable: same status, code and message.

Checks:
- admin, hr, pharmacy and specialist actors, with kind `unbound_upload` and with `booking`, all get 403.
- A user with `unbound_upload`, `Booking` or `constructor` gets 400, with zero calls to upload, ownedResource, capture and parse.
- `booking` with a malformed resourceId gets 400 before any DB call.
- An unbound `/assets/uploads` request still reaches the default readiness 503.
- An untokened `/Clinical/...` request gets 401 with private headers.

## R12-4 (R11-F2-4) Reserved identity guard: APPROVE_SOURCE_ONLY (conditional)
Verified (`src1/modules/file/storage.ts:50-81`):

- **Lexical checks unchanged and still first:** grammar 400, reserved-lowercase 404, containment 404.
- **Reserved lookup (`:61-65`).** A read-only `fs.lstatSync(base/__private_assets_v1)` that creates nothing.
  - Only ENOENT leaves `reserved` undefined.
  - Every other errno produces `documentError()`, i.e. 503 DOCUMENT_STORAGE_UNAVAILABLE.
- **Walk (`:68-79`).** The existing per-component lstat walk now also rejects any component whose (dev, ino) equals the reserved entry, alongside the unchanged symlink rejection.
  - The 404 thrown inside `try` is rethrown because its code is not ENOENT.
  - ENOENT still ends the walk.
- **Trigger covered:** on a case-folding directory, `__private_aſſets_v1` (U+017F) or any other spelling that resolves to the same object lstats to the reserved inode at the first walk step, giving 404.
- **Every legacy alias shares this function:**
  - /api/static and /api/v1/file/static;
  - fetch;
  - getFileInfo and serveFileStructured (not routed);
  - both upload calls;
  - deleteFile.
- **Ordinary paths unaffected.** Unicode legacy names are not banned, and a different directory never shares (dev, ino) with the reserved root, so ordinary public images are unaffected.
- **Dormant by default.** The default `ready()` throws, so `roots()` never runs. The reserved entry is therefore normally absent and the guard stays on its ENOENT branch until readiness is admitted or an operator provisions the subtree.
- **Nothing more is claimed.** There is no TOCTOU, hardlink, same-uid-writer or mount immunity; the code comment claims only case-fold alias detection.

INFO:
- **R12-I3: identity precision and scope.**
  - `Stats.dev` and `Stats.ino` are JS Numbers. Precision loss could only produce a false denial, never an allow. `lstatSync(p, { bigint: true })` would make the comparison exact.
  - Only the reserved root's identity is compared. Deeper private directories exposed through mounts remain under the excluded mount/privilege boundary.

Checks:
- On a casefold-enabled empty directory, where the filesystem supports it:
  - the alias via /api/static, fetch and deleteFile returns 404 with private headers, with zero reads and zero unlinks;
  - an ordinary Unicode file is still served.
- Reserved entry absent: ordinary paths behave as before.
- A reserved lstat that fails with EACCES or ENOTDIR returns 503.
- A symlinked component returns 404.
- Where casefold is unsupported, record the alias case as NOT_RUN and still run the negative controls.

## C Composition at 3eab68bb: APPROVE_SOURCE_ONLY
- **Scope of change.** Only the two production files change.
  - Added imports: `actor` and `input` from validation, `AppError` from common types, and `errors` from formidable.
  - No new import cycle: common/types imports nothing, and validation and documentTypes do not import storage or controller.
- **Unchanged as read:**
  - the capture lease, deadline and finalization;
  - the WeakMap admission checkpoints and the transaction checkpoints;
  - immutable identity and version provenance;
  - DTOs, read audit and streaming.
  - The latch now stores an AppError, which is assignable to `Error | null`.
- **Defaults stay closed.** `FileDocumentPolicy` readiness throws, and the scanner and release ports return unavailable. There is no HTTP validate or release.
  - Routes, the mount and the header addendum are unchanged.
  - There is no package, start or global-middleware change.
- **Retained R11 INFO:**
  - a cleanup failure in the capture `finally` can still replace a 400, 413 or 415 with 503 (fail-closed);
  - the content-type prefix check is case-sensitive;
  - the post-byte destroy followed by errorHandler's second write;
  - the audit schema has no enum or pairing constraint;
  - internal validate/release actor attribution.
- **R12-I4 (pre-existing, outside scope).** Non-ENOENT errnos inside the walk (for example ENOTDIR when a component is a regular file) are rethrown raw.
  - FileService turns them into UPLOAD_FAILED or DELETE_FAILED 500, and the message includes `error.message`, i.e. absolute path text.
  - For reads, `legacyFilePath` converts them to 503.
- **Outside scope, Root-owned:** package.json declares `xlsx ^0.18.5`, but the supplied package-lock.json has no xlsx in its root dependencies or packages map.
  - `npm ci` would reject that pair.
  - This bears on any install or emit admission, not on these two files.

## Retained open items
- **Outside this correction:** F1 HIGH, F5-1 MEDIUM and R10-F2-2 stay OPEN.
- **Separate evidence records:**
  - The genuine R11 clean capture is accepted separately.
  - The historical R10 failed launcher (exit 1, IDENTITY_UNKNOWN, cleanup IDENTITY_CHANGED) is preserved.
  - Neither reclassifies the other.
- **Still open:**
  - effective policies, clinical, public legacy report, provider and supported-client cutover;
  - real HTTP, Formidable, filesystem and Mongo behaviour;
  - full S1, capacity, and owner and release gates.
- **Not acted on by this review:** the fixture two-pin/regression amendment, exact stage/install/emit/run admission, and the 112-package lock metadata.

## Non-claims
- **No acceptance is given for:**
  - typecheck, Node, Express, Formidable, the fs adapter or casefold;
  - Mongo, transactions, races or providers;
  - capacity, privacy, clients, owner, module, M0, deployment or release.
- Source approval is not module completion.
- Corporate, HR and hospital expansion and the final integration campaign are DEFERRED_BY_OWNER.
- No mutable fixture source was included or reviewed.
- I inspected only the supplied packet text. Callers outside it were not checked.
- Hashes were compared as text only. No private reasoning is included.