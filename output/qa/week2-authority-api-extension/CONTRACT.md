# C3 authority API extension: Dependents, Notification and FCM

Status: DRAFT_REVIEW_REQUIRED. Contract and read-only source analysis only; no
fixture/application implementation or execution is approved by this document.
Baseline: clean `m0/week2-authority-api-extension` at
`94f8804916850caf9c716fae2cc49c6c0d218202`, after accepted dependents and
notification/FCM source integration. These guards have source-only reviews;
this proposal supplies their missing actual HTTP/database evidence boundary.

## 1. Existing authority and execution limits

Apply the existing C3 API contract, accepted test-only index-space profile-2
amendment, dependents and notification contracts, development workflow, current
M0 progress and C2/release gates.
This is a test-only extension of FOCUSED_PRODUCTION_ROUTERS, with the same
`auth-user-wallet-api` role and exact closed result/error schemas. It is not
full-server startup, root compatibility adoption, production protection,
clinical/finance/privacy acceptance, a load test, or completion of Week 2.

Core execution-2 failed at DB_INDEX_CREATE_SERVER before HTTP. Execution-3
then measured strict numeric14031, DB_INDEX_CREATE_OUT_OF_DISK_SPACE; actual
available bytes, previous effective threshold and affected index were not
measured. Both failures, consumed approvals and cleanup records remain preserved.
The separately reviewed profile-2 amendment fixed the owned fixture's startup
indexBuildMinAvailableDiskSpaceMB at nonzero64, retaining every existing resource
and grant bound. It is a deliberate test-only setting, not a production setting.

Execution-4 at clean `1543658ff53e3906f71f4fa8b92a5756b97a7ee1`, template
`067c3c39f574f439c48f6c6f70e031306fc7c4ea5a6d5934e610b9213006ffde`,
returned FOCUSED_API_PASS: all36 real HTTP/DB nominal cases passed, all four
actual-source regressions were detected, zero failed/skipped/unexpected effects.
Both independent nonauthors accepted the bounded result, receipts and cleanup
record. Parent plus separate root readback verified same engine, exact two IDs
absent, zero purpose labels and workspace absent; reviewers did not claim their
own live Docker observation. This achieves the focused auth/OTP/user/wallet
milestone. It does not execute Dependents/Notification/FCM routes, accept full
M0/Week2 or supply a reusable run approval. No rerun is authorized by that PASS.

This extension preserves accepted profile2's fixed64 parameter, 512 MiB database
tmpfs, 1 GiB Mongo RAM and all other bounds. It neither retries an earlier claim
nor changes profile parameters. Its new source, preparation artifact and exact
single-run invocation still require separate decisions; existing36/4 PASS is
historical evidence and all new17/10 groups remain NOT_RUN.

Preserve exact Node 22.23.4, Mongoose 9.12.0, MongoDB 8.0.34 and TS 5.9.3,
public dependency lock, image digests, recorded Docker endpoint/engine, two
owned containers, no published ports and Mongo network-none/Node-owned-Mongo
namespace. Preserve the 180-second child bound, eight-second HTTP bound,
128 KiB response bound, input/file/resource limits, readonly bundle and current
permission grants. No new package, native module, process/worker/addon grant,
network/filesystem/provider capability, database/connection, unique/index policy,
root install/build/start or production operation. If a bound fails, retain the
failure for review; do not silently extend it or skip cases.

Meet is excluded: it requires a separate Google/calendar recording contract and
admission. Raw OTP, bookings, contact changes, clinical documents, monetary
policy and their owner decisions remain outside this extension.

## 2. Discovery and exact source boundary

Graph-first discovery used project `swasthadisha`; the ready graph belongs to the
canonical checkout at `bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7`, not this newer
integration. It found DependentController, NotificationController, FcmController
and route variables. Outbound controller traces were empty because their arrow
handlers are not represented; this is not evidence of no callers. Actual current
imports, all route registrations, controllers, DTO/Joi, services, repositories,
models and central mount bytes govern the contract.

A read-only, standard-library literal TypeScript import walk, stopping at the
existing exact recording/excluded modules, found 64 old sources and 77 with the
three new router roots. It conservatively includes imports erased as types; it
is not compiler output or application evaluation. The only added literal model
registration is Dependent; old 12 plus Dependent equals 13. No added external
package name was found. The 13 added source files are:

- Dependents: controller, model, repository, routes, services, types, validation
  (`src1/modules/dependents/<part>/index.ts`).
- FCM: controller, routes, validation (`src1/modules/fcm/<part>/index.ts`).
- Notification: controller, routes, validation
  (`src1/modules/notification/<part>/index.ts`).

Dependent is runtime-reachable through routes -> controller -> service ->
repository -> model; the actual imported value registers `model('Dependent',
dependentSchema)`. Notification and FcmToken are already reached by AuthService's
NotificationService/FcmService closure. WellnessPackage remains an actual eager
CorporateRepository import; retain it. The genuine TS-AST emitted-require/model
reconciliation must independently establish exact name/source equality before a
new template is accepted; no regex analysis substitutes for that check.

Append only these roots to the existing five:

| Actual router alias | Actual production mount |
| --- | --- |
| `@/modules/dependents/routes` | `/api/v1/dependents`, real `authenticate` |
| `@/modules/notification/routes` | `/api/v1/notifications`, real `authenticate` |
| `@/modules/fcm/routes` | `/api/v1/fcm`, real `authenticate` |

Use the same real JWT middleware, Joi middleware, TypeDI constructors,
controllers/services/repositories, Mongoose/driver and final real error handler.
Do not import `src1/index.ts` or call full `configureRoutes`. Add the focused
mounts before the unchanged error handler, using actual imported router exports.
Do not replace exercised auth/authority/domain methods or repository results.

The only model-map addition is:

```json
{"name":"Dependent","collection":"dependents","source":"src1/modules/dependents/model/index.ts","indexes":[]}
```

All old 12 entries and their correctness indexes remain byte/semantically
unchanged; admission expected model/collection counts become exactly 13. Keep
ODM autoCreate/autoIndex false and actual registration/collection/source checks
before writers. No dependent unique constraint is invented: existing duplicate
and Me checks are service checks with no claimed concurrency guarantee. Its
performance/text indexes are not required by the admitted routes and stay
uncreated, like existing excluded performance indexes. Preserve the emitted
AST metadata controls; add a missing-Dependent rejection control. Reject an
undeclared/unreachable/duplicate/wrong-source model before runtime, not by
excluding a real imported module.

## 3. Recording ports and effect evidence

Install the existing closed logger/Firebase substitutes and Axios recorder
before ANY eager router/domain import. Keep the PaymentService/CouponService
throwing sentinels excluded, with zero excluded/unexpected counts. No service
account, Firebase SDK initialization, real SMS/email/push, queue or storage.

Extend only the existing Firebase recorder to retain synthetic
`sendEachForMulticast` arguments privately in memory and increment push once per
actual call. Retain its existing fixed SDK-shaped recording response, not a real
delivery claim. Assert exact tokens/title/body/data against the request's owned
fixtures. Unexpected calls/payloads must increment the terminal unexpected
counter even when the real best-effort sender catches an error. Do not intercept
or replace FcmService/FcmRepository or NotificationService; their actual lookup,
batching and mutations run. Logger keeps counts only, never arguments.

Success output retains the same ten provider keys:
`email,sms,push,logger,payments,calendar,storage,queue,deniedCapabilities,unexpected`.
All counts are nonnegative safe integers; excluded/unexpected remain zero.
Capture nominal provider summary after all 53 nominal groups and before any
sensitivity phase. Original login push-zero checks still run before new token
registration/push positives. Sensitivity recordings are separate private counters
and must not contaminate nominal summaries.

For each denied request, snapshot all 13 admitted collections, sorted by ID,
into an in-memory hash before/after; do not expose rows/hashes or assert operands.
Retain existing OTP-specific TTL assertions and exact expired-proof cleanup.
Additionally track each synthetic challenge() proof _id together with its owning
synthetic identity in private fixture memory. After ALL corresponding core
predicates/scheduling have completed, delete only those exact completed owned
proofs (ID plus owner predicate), before the longer extension's fresh snapshots
and counter baselines. Apply the same cleanup after each completed sensitivity
phase, before the next phase's snapshots/counters. A proof already removed by
server TTL may be absent; this does not permit ignoring a mutation during an
HTTP assertion. Never delete an active overlap/in-flight proof, broaden to a
user/target query, clear a collection, change expiry/TTL/indexes, or suppress a
snapshot difference. Preserve old36/four predicates and scheduling. Existing
core race write counters and all old assertions remain intact. New denied requests require
zero domain writes, JWT issuance, SMS/email/push, payment/coupon or unexpected
capability advancement. The unchanged error handler calls logger.error once:
assert exactly that one recording logger call rather than claiming no logging.
Successes assert only the intended rows/fields/counts changed and unrelated
collections/rows stayed unchanged; read-only successes also require no writes.

Extend driver commandStarted observation with per-collection integer read
counters for actual find/aggregate/count/getMore commands. Never record commands,
filters, cursor IDs, rows or raw payloads. Measure after pre-snapshot and before
request, then after HTTP completion before post-snapshot, excluding fixture setup
and snapshot reads. This proves pre-lookup denials where the contract promises
one. Object-authorization denials intentionally perform the scoped/unscoped
lookup described below; do not falsely require zero reads there. No driver
result/success is fabricated by this instrumentation.

Every denied HTTP response must match the actual strict `{error,message,code}`
envelope with exact status/code and string message, and no extra resource/data,
OTP/token or patient-bearing fields. Keep messages private. Anonymous requests
use 401 UNAUTHORIZED; bad/expired JWTs retain 401 INVALID_TOKEN/TOKEN_EXPIRED;
Joi failures retain 400 VALIDATION_ERROR. Use valid IDs/payloads for assertions
that occur after validators. Do not impose new precedence on old routes.

## 4. Actors and preserved application policies

Use fresh synthetic users/IDs/rows/tokens for extension groups and each mutant.
Ordinary owner tokens must come from the genuine send -> recording delivery ->
verify flow, not a bypass. Reuse actual core helpers with current ephemeral key;
admin and other role fixtures may use the existing genuine JWT signing helper
and owned model rows where needed. Such signed claims test middleware authority,
not real-world clinical/employee provisioning. No secrets, keys, JWTs, OTPs,
contacts, FCM token values or raw JSON responses enter output/Git.

Do not change accepted production bytes, DTOs, permissions or error semantics:

- Dependents admits exact user/admin with nonblank string `_id`, before all
  seven route validators. Other roles (HR, specialist, pharmacy, unknown,
  case-mismatched Admin) deny even if an owned record's userId equals their ID.
  Ordinary creation binds canonical actor ID and rejects a different supplied
  owner with 422 FORBIDDEN_FIELD; required body owner remains required. Exact
  admin retains validated on-behalf create and optional/global query scope.
- Dependents foreign explicit query/path owner denies 403 FORBIDDEN before DB;
  omitted/own selector plus another owner's ID is scoped 404
  DEPENDENT_NOT_FOUND, with no unscoped classification read. Raw PUT own-property
  `userId` is checked after scoped object authorization and before stripUnknown:
  owned object ->422; inaccessible/absent object ->404; foreign selector ->403.
  Model/service split-read/ID-write remains safe only under the accepted
  no-supported-owner-transfer assumption; no out-of-band atomicity claim.
- The five generic Notification handlers accept a nonblank canonical string ID.
  Exact lowercase admin retains global generic scope; every other authenticated
  role is canonical-owner-only, without alias/corporate delegation. List foreign
  selector denies403 before DB. Generic ID lookup retains absent404
  NOTIFICATION_NOT_FOUND; stored foreign recipient denies403 before serialization
  or mutation. Generic successful update remains isRead/readAt-only; stripUnknown
  must not turn ignored owner/content fields into transfers. No new 422 rule.
- Preserve four pre-existing strict-own recipient methods WITHOUT any admin
  bypass, five specialist methods and their signed specialistId fallback/scoped
  404, both prior admin send guards, and FCM `/token` self-registration. Specialist
  aliases grant nothing on generic canonical-ID routes. Counts/filters, repeated
  readAt behavior, hard deletion, duplicate rules and best-effort push remain
  existing behavior, not newly approved product policy.
- FCM `/test` keeps exact requireAdmin before body validation and token lookup.
  It does not acquire a stronger principal freshness policy than existing
  requireAdmin. `/token` stays ordinary authenticated self-registration; use
  unique synthetic tokens and do not invent a device-proof/rebinding policy.
  FcmRepository's 'active' helper currently does not filter isActive: preserve
  that behavior rather than silently repair it. HTTP200 is not delivery proof.

## 5. Required nominal HTTP cases

Preserve all old 36 requiredCaseIds, their relative order, predicates, real OTP
race/final-expiry scheduling and original four sensitivity IDs from the pinned
ports manifest. Execute all old nominal cases first, then append the following
17 groups in order: exactly 53 nominal IDs total. A group PASS requires every
listed request/assertion; group count is not raw HTTP request count. No skip or
partial group passes. Use fresh sibling rows where a prior mutation/deletion
would otherwise mask a later guard.

| Appended ID | Mandatory real HTTP/database assertions |
| --- | --- |
| DEPENDENT_OWNER_CRUD_LIST | Own POST201, GET by ID200, PUT200, DELETE200; own GET root, `/user/:userId`, `/user/:userId/active`200. Omitted and own query selectors; rows and paginated total contain only actor's dependents. Include mobile's delete-without-query flow. Check exact state fields and only target deletion. |
| DEPENDENT_ADMIN_ON_BEHALF | Exact admin successfully exercises all seven routes including validated create for a different owner, global list and optional owner-filtered list/ID operations. Include active and inactive fixtures; global results may span owners as before. |
| DEPENDENT_ROLE_AND_PRINCIPAL_DENIALS | HR/specialist/pharmacy/unknown/Admin each exercise all seven routes against records owned by that same signed ID:403 FORBIDDEN, zero DB commands/effects. Include malformed body/path to establish role-before-validator precedence. On valid-format routes, absent/empty/blank/number/object `_id` signed claims yield401 UNAUTHORIZED. Anonymous and invalid-JWT boundary checks. |
| DEPENDENT_OWNER_SELECTORS_DENIED | Ordinary user supplies a different valid owner on all recognized root/ID query and `/user/:userId` path selectors:403 before DB; attempts POST with another valid owner:422 before DB. Never broaden an ignored query on a route that has no such selector into new policy. |
| DEPENDENT_HIDDEN_ID_DENIALS | Other owner's existing ID for GET/PUT/DELETE, with omitted and own query:404 DEPENDENT_NOT_FOUND after owner-scoped lookup, unchanged state/effects. Absent valid ID404 and malformed ID400 with actual envelopes. |
| DEPENDENT_RAW_OWNER_FIELD_DENIALS | On owned rows, ordinary user and admin raw PUT userId same/other/null/number/object/array/empty values:422 FORBIDDEN_FIELD before stripUnknown, no write. Valid non-owner field accompanies payload so removing guard would produce an actual update. Inaccessible/absent rows404 and foreign query403 take precedence; body without userId preserves normal update. |
| DEPENDENT_LEGACY_VALIDATION | Omitted required create userId400 VALIDATION_ERROR; active Me duplicate400 ME_DEPENDENT_EXISTS; case-insensitive trimmed same-name/same-relationship duplicate400 DEPENDENT_ALREADY_EXISTS; valid relationship aliases preserved. Nonpaginated owner helper stays active-only even with isActive=false, while paginated filter/count honor isActive. No new uniqueness/race claim. |
| NOTIFICATION_GENERIC_OWNER_FLOWS | Real GET root/list and GET ID, PUT ID isRead, PATCH ID/read, DELETE ID. Canonical own scope; optional same owner selector; readonly operations zero writes, writes only target/readAt fields and exact delete. PUT extra owner/content fields together with a valid isRead cannot transfer/change content; original true/false/repeated-read behavior retained. |
| NOTIFICATION_GENERIC_ADMIN_FLOWS | Exact admin all five generic handlers across owners; global and explicit filtered list/pagination retain current global authority. Do not infer this bypass for older strict-own paths. |
| NOTIFICATION_GENERIC_DENIALS | Foreign list selector403 before DB; foreign stored recipient on each of GET/PUT/PATCH/DELETE403 before resource serialization/write, with actual read but zero effects. Absent ID404 NOTIFICATION_NOT_FOUND; bad ID400. Valid-format generic calls with absent/empty/blank/number/object `_id`401; HR/specialist/pharmacy/unknown/Admin own canonical rows allowed but other owner denied; signed specialist/pharmacy alias matching target does not authorize generic access. |
| NOTIFICATION_PAGINATION_AND_COUNTS | Owner-paginated rows/total/page bounds cannot count another recipient; preserve type/isRead filters. Reference fields affect paginated query but remain ignored in nonpaginated helper. Strict-own unread count reflects owned unread fixtures; separately insert at most 1001 tiny synthetic notifications for one isolated recipient to assert existing 1000 cap (not a full-count claim), then delete precisely those fixture IDs before later snapshots. Never request a huge unpaginated response. |
| NOTIFICATION_PRIOR_STRICT_OWN_PATHS | All four `/user/:userId` list/unread/unread-count/read-all paths: matching canonical actor success and foreign403 before DB, including exact admin foreign403. Check read-all only target unread rows; no generic-admin expansion. |
| NOTIFICATION_PRIOR_SPECIALIST_PATHS | All five specialist list/unread/count/read-all/ID-read routes: actual requireSpecialist, existing signed specialistId or canonical fallback; owned rows only; foreign/absent ID404 NOTIFICATION_NOT_FOUND, non-specialist403 before effects. Demonstrate generic alias denial separately. No clinician provisioning/clinical record claim. |
| NOTIFICATION_PRIOR_ADMIN_SENDERS | Both POST `/notifications` and `/notifications/send`: exact admin201 with explicit fresh target IDs and exact synthetic created rows. Single-create has no push; `/send` invokes actual recorded push iff targets have owned tokens. Nonadmin valid/malformed bodies403 before DB/provider. Use explicit userIds for `/send`, not unbounded all-user/corporate broadcast. Do not claim untested broadcast selector semantics. |
| FCM_TEST_ADMIN_RECORDING | Exact admin POST `/fcm/test`200 with actual token repository lookup and one recorded transport call to precisely owned synthetic token(s); exact fixed Booking Successful title/body/data.type=test. Unrelated tokens excluded; no Notification/domain write/JWT/SMS/email. No-token target200 with zero transport; SDK recording response is not real delivery. |
| FCM_TEST_DENIALS | Each ordinary/HR/specialist/pharmacy/unknown/Admin role valid and malformed bodies403 FORBIDDEN before token DB/provider; anonymous401, wrong JWT401 INVALID_TOKEN; exact admin malformed target400 VALIDATION_ERROR. Each denial snapshots all13 collections/effects and exact error envelope. |
| FCM_TOKEN_REGISTRATION_COMPAT | Authenticated nonadmin `/fcm/token`201 persists one unique trimmed synthetic token/platform/deviceId under the authenticated canonical owner/type, ignoring extra DTO owner fields; ordinary route remains usable. Invalid payload400, anonymous401, no push. Do not test/claim a new cross-user existing-token rebind policy. |

All 25 route registrations (7+16+2) thus have positive admitted behavior and
denial coverage appropriate to their existing rules. Parameterized denials need
per-request assertions, not one summary status per route family. Ordinary actors
are separate from the core fixtures; explicit sends/count fixtures must not
change core login/race actor state. Delete only exact owned fixture IDs, never
flush a database/collection or disable constraints. No patient/client execution.

## 6. Required actual-source sensitivity

Preserve original four sensitivity IDs and probes exactly. Append ten IDs below,
for exactly 14 total. Each new variant is an emitted edit of an exact admitted
production source file, with original and mutant hashes/manifested bytes; never
handwritten copied domain logic, production edits, fake repositories, feature
flags, runtime monkey-patched authority results or mutations of source on disk.

| New ID | Actual source weakening / fixed behavior that must reject it |
| --- | --- |
| DEPENDENT_UNBOUND_CREATE_OWNER | Remove ordinary-owner mismatch rejection AND change canonical create assignment to validated body owner; same foreign-owner POST denial predicate must fail because another owner's dependent is actually created. |
| DEPENDENT_UNSCOPED_LIST | Change getAll effective owner to client selector/undefined; omitted-selector ordinary root list and paginated total predicates must each expose cross-owner rows/counts and fail. |
| DEPENDENT_UNSCOPED_ID_CALLS | Remove canonical owner binding for ID GET/update/delete calls; independently rerun each other-owner scoped404 predicate with fresh rows and omitted selector; each must fail on actual read/mutation. Do not stop after GET and claim mutator sensitivity. |
| DEPENDENT_FORBIDDEN_ROLE_ADMISSION | Disable requireActor's exact user/admin rejection; same-owner forbidden-role route predicates must fail (before-validation malformed request precedence included). Other request semantics remain actual. |
| DEPENDENT_RAW_OWNER_STRIPPED | Move rejectOwnershipChange after the unchanged body validator; a raw owner field accompanying valid editable name is stripped, causing the fixed owned-object422 predicate to fail on actual accepted update. |
| NOTIFICATION_UNSCOPED_LIST | Replace canonical resolveListRecipient binding with client selector/undefined; omitted-selector rows and paginated total each fail their actual cross-recipient isolation predicates. |
| NOTIFICATION_ID_OWNER_GUARD_REMOVED | Remove stored-recipient guard from getAuthorizedNotification; each foreign GET/PUT/PATCH/DELETE denial predicate independently fails with fresh actual rows. |
| NOTIFICATION_PRIOR_STRICT_OWN_ADMIN_EXPANSION | Add an exact-admin bypass to existing assertOwnRecipient; the older foreign-recipient admin403 predicates fail, proving compatibility checks would detect an accidental expansion. No nominal bypass is added. |
| FCM_TEST_ADMIN_GUARD_REMOVED | Remove only requireAdmin from actual `/test` registration; valid nonadmin fixed denial predicate fails, and the actual transport recorder proves invocation against an owned synthetic token. |
| FCM_TEST_ADMIN_GUARD_AFTER_VALIDATION | Move only requireAdmin after actual validator; malformed nonadmin request yields400 rather than fixed403, detecting precedence loss even with zero provider effects. |

For each new variant execute the same nominal assertion predicate, catch only its
expected fixed-literal assertion failure, and separately verify the precise
forbidden behavior described above. Infrastructure/DB/setup/provider-admission
failure or an unrelated thrown error is NOT detected:true. Multi-operation
variants must exercise every promised operation independently, collecting the
expected predicate failure for each. Result rows remain only `{id,detected:true}`;
no mutant is labeled a nominal PASS and no raw requests/state leave memory.

Each phase gets fresh actual production classes/TypeDI/HTTP server and fresh
synthetic target rows; preserve actual model registrations/owned connection.
Restore a fresh nominal server/cache between phases and rerun relevant guard
predicates to prove restoration. Existing OTP scheduler wraps only real queries
and returns their unchanged DB results; do not generalize it into a fake domain.
Snapshots for intentional mutant writes establish those exact effects, not a
false unchanged-state assertion. Mutant effects cannot reach later phases' data
or nominal provider summary. Excluded/unexpected capabilities remain zero.

## 7. Implementation, review and acceptance sequence

Current ownership is this CONTRACT.md and read-only evidence only. No writes to
production, fixture, parent/platform/profile, Git metadata or other workers.
Root owns eventual shared parent/profile/model/ports/admission interfaces and
integration; a later explicit assignment must allocate scenario/bootstrap/
compiler/unit writers without overlap. No implementation before two independent
contract decisions and root assignment. This contract grants no named-owner,
external Claude-model, preparation or actual-runtime approval.

After contract acceptance, the concrete source candidate must include:

1. Append-only roots/models/case IDs and necessary focused mounts/recordings;
   exact source closure and emitted literal-require/model reconciliation.
2. Required real HTTP predicates and actual-source variants with state/effect
   evidence; old 36/four preserved, not replaced by text checks.
3. Dependency-free admission negatives for omitted/extra/wrong model, missing
   router/recording port, altered files/source/lock/ports, missing required IDs,
   malformed or duplicate result rows/provider keys, and denied real capabilities.
   Rejections require zero domain import/connection/write through hard fake
   ports. Preserve existing lock/diagnostic/cleanup/network unit cases. Parser
   checks do not evaluate packages/application. Guard telemetry and recorder
   pure tests can use bounded synthetic input; no app imports in unit mode.
4. Exact source freeze/full patch hashes, two nonauthor Standards/Spec source
   reviews, local coherent commit/integration and honest evidence status.
5. Two exact approvals for locked public install/emission on a clean committed
   checkout; genuine compiler only there, no application evaluation. Retain all
   focused semantic diagnostics and TRANSPILE_ONLY_NOT_TYPECHECKED/fullBuild:false.
   Existing 703 diagnostics are historical, not a promise that adding13 sources
   leaves their number unchanged. Any new closure/diagnostic discrepancy is
   reported, never silently repaired or called full type acceptance.
6. Fresh artifact reconciliation: exact13 model map/reachability, old correctness
   indexes, 53/14 IDs, immutable regular-file manifest and actual public lock;
   two exact one-run invocation decisions, current accepted profile2/setup binding and
   exclusive unconsumed claim before any owned allocation/application execution.
7. One real bounded run; retain any post-create failure/cleanup and obtain two
   postreviews before another attempt. Actual admission/network/no-egress/file
   canaries plus zero skips, all53 nominal PASS and14 detected sensitivities,
   zero unexpected/excluded effects, exit0 and independently reviewed owned
   cleanup evidence are required. No source-only or fake-unit PASS promotes a
   NOT_RUN runtime case. No success if cleanup fails.

Named deployment, compatibility, security/privacy, clinical, finance, restore,
pilot and 100 RPS gates remain independent. Source implementation acceptance,
fixture evidence and release acceptance must be reported separately.

## 8. Frozen input pins (SHA-256)

All pins below were read as bytes at baseline94f8804; no executable application
code was run. The two accepted source-freeze manifests bind their detailed
controller/route/unchanged model/service/Joi/caller pins. Source contract/rules
and current baseline commit remain authoritative, not graph snippets.

| Path | SHA-256 |
| --- | --- |
| documentation/planning/implementation/C3_AUTH_API_RUNTIME_CONTRACT.md | 73301872982a0f79fa805538f679c08e53ce6ef0528790cc75144ed7e2a7d0ee |
| output/qa/week2-dependents/CONTRACT.md | 7ae9f137a64c037416eb401768de52b3b0936a3a68d7b6ccd9d232f4f0e4232f |
| output/qa/week2-dependents/source-freeze.json | 39b49c243d73988669e506d0013b39d94d1c68219ea75bf6ad03bf104fdd063e |
| output/qa/week2-notification-reads/CONTRACT.md | f24cd44e9ae5a9734b255c426854f5a0cb8efb56b3c9be6f911a2a3435b2aeb1 |
| output/qa/week2-notification-reads/source-freeze.json | e032da4f4484f81b4068ee9a0c0f468a81739e6e466edb584ab8b19e3cb64db0 |
| output/qa/week2-api-runtime/execution-2/REVIEW.md | 013e75bcce96826ff9c088f9a269ed0a651f7ee143b7091f3715d82d15e28e73 |
| output/qa/week2-api-runtime/execution-2/verification.json | ce62cd803ad890ff1d788aad385127116e349d7cac03b2769a04cb979609f9f0 |
| output/qa/week2-api-runtime/execution-2/operator-result.json | 549fa88e7d3890e439ffbb172b76f3ccd0a8f1d9542751d1af3287afac47686b |
| test/api-runtime/profile.json | bb310dd4909678d239a37975b7326960ffce1fb9b788bbe41beb65c7bcfdad54 |
| test/api-runtime/platform.mjs | b5117065c90c4698cb9604a8da0cb673a38249d8eee07a8ac39e11040a56e29f |
| test/api-runtime/launch.mjs | 9c6d1c805de4c50542667b90532219c54666b8a764ee5672055f641938b099ed |
| test/api-runtime/scenario/bootstrap.cjs | 861be44d5f28beebbde9bd81c75c4e8fe575bb76f67d5c16451bdcf6d01bbb4f |
| test/api-runtime/scenario/bootstrap-unit.cjs | 29b50ff0e754988c46be8a25ae2c7706447a0006914d0fb7607193bbcce08f61 |
| test/api-runtime/scenario/compile.cjs | 76383b2161dc19d4675f7c21edc1a4fa799cd0287b80628f63bc2d19b38a3a2a |
| test/api-runtime/scenario/scenario.cjs | 95c44306f9ab7bddadc7e5be5d9a5e80b9816234167d1a83402a6591f3a88947 |
| test/api-runtime/scenario/ports-manifest.json | 993003d7ec316a99c8189acde7e45277c6f79f9f567a1e26cfed9a7d3d855f94 |
| test/api-runtime/scenario/package-plan.json | d7830a9ce688235bb64f3f9f7ac3d5dd604bb63641cdae97b8b7250bfd957227 |
| test/api-runtime/scenario/prepare.py | 39b4085370a09a34069b9f1c4f45cfd8fa38a3a1f0e380abcef9c469a5add598 |
| test/api-runtime/scenario/offline-unit.py | 026dd325cdf7ecbabaa375de428087b0dcf7bcd16077e30d1107cc6fcaecb906 |
| test/api-runtime/scenario/README.md | 619ed9faab1917e80cf801263609027f029397861eeb1ae0bcc8641956080f55 |
| package-lock.json | 0f8d4fe081e8de1cf87673f743b73ee404be2483fbc144416039ca3076822080 |
| src1/routes/index.ts | 50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056 |
| src1/modules/dependents/controller/index.ts | 5fd4f41f923e38ea8545499f6976b64ecda6070e2ba0eab72ac31608535e47f5 |
| src1/modules/dependents/routes/index.ts | a3ade302e3d7453b29135f4347d7ddf2b4b1fbad75aa7c0f5a5c6bc178573344 |
| src1/modules/dependents/services/index.ts | adc2f3cf156bfa807bf125904ecd83c8f84dee38a072c7b78d1e90c8822cc044 |
| src1/modules/dependents/repository/index.ts | cda1c7463c2dae2b692e8f629c7395ef23f1af20340401fae63b186ba7960845 |
| src1/modules/dependents/model/index.ts | 6e517f2882822cfd587111a5fb5f1bf959a7cd2772026ccb943ad758e1b4071e |
| src1/modules/dependents/validation/index.ts | 6174811e3981865a75ff4a3fb195c4be0ad5bb9b0645761b474b1532fda9030d |
| src1/modules/notification/controller/index.ts | e9b58d50978062ebe7a52b5a2259b9e862415e6e17fd69599ba8945d1f25934f |
| src1/modules/notification/routes/index.ts | d9fe35d82ebda24be5a1f9dd5dcd0d957dbe08bccc81969dac1eb2d834649d6b |
| src1/modules/notification/services/index.ts | dd343357282c5c80fb02da2913d9eaf1ec772e7df0daa39f9a4b0bfc87c9311d |
| src1/modules/notification/model/index.ts | ef6c56aec1cecaac2c0248b76faf1dd4721f4c00a45b2fa8f45c8b79836c1ca9 |
| src1/modules/fcm/routes/index.ts | bfd18b39dd716a2f34dad8c287670789d56d313eff5879bdc70cf9820a7121c4 |
| src1/modules/fcm/controller/index.ts | 53544029ca0616db46a326d9f1414c91252178f5ddfd2e15a6c337328335b464 |
| src1/modules/fcm/services/index.ts | 5721b5de514461bdc1197cb721bf99440b79df9bf8c889087b691ba47d6c55ec |
| src1/modules/fcm/repository/index.ts | 8c472a507a1ae97ba683db83bb8e6d07112f243f91eb0b7eb39ea36abb74baca |
| src1/modules/fcm/model/index.ts | 7082276e9d66a64ad7dc510dcc37782bb1a4e7ee80accbd1322f5c2d8a6f6b37 |
| src1/modules/middleware/auth.ts | db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2 |
| output/qa/week2-fixture-index-space/CONTRACT.md | c6e31ba43133cd6ccb3da6d4f2bdaad134c30fdd49da2e78bf84ed24e49c7124 |
| output/qa/week2-fixture-index-space/REVIEW.md | 29de817145abe46fff47c3f49bc12f9db5f0e5b1e57596e3a250e5f50a344019 |
| output/qa/week2-api-runtime/execution-3/REVIEW.md | e7436fd194d6ce498c6f257d0947cae6d5806080601f1a282a72c1fb483ae557 |
| output/qa/week2-api-runtime/execution-4/REVIEW.md | 974cd7afe16aa580b49ba8677ca82015faec5919e8b8dcdd1132f848ce5aad40 |
| output/qa/week2-api-runtime/execution-4/verification.json | 68b3738eca6266d5bfe1c5ca4740d797b5a0095db82aa8d84ab81196df49347f |
| output/qa/week2-api-runtime/execution-4/operator-result.json | 7b6d246d5a81666131aa652326c40173ccfb0d253505865000af74fb3b9a0cc1 |

## 9. Writer interface appendix (freeze before source implementation)

Proposed split after both final contract confirmations and root assignment:
root exclusively owns ports-manifest.json, bootstrap.cjs, bootstrap-unit.cjs,
offline-unit.py and any necessary parent/shared admission changes. API scenario
author exclusively owns scenario.cjs, compile.cjs, scenario README and assigned
QA. Production sources and all other writers remain outside either change.
These are planned interfaces, not permission to edit before assignment.

Existing context fields/methods keep their semantics. Root bootstrap adds only:

- `ctx.readOps`: same stable per-collection object shape as existing writeOps,
  with the exact13 manifest collection names and cumulative nonnegative safe
  integer counts. Increment once for actual commandStarted find/aggregate/count/
  getMore commands in the owned database; command collection is read only to
  select its admitted key. Unknown collection increments terminal unexpected.
  No raw command/filter/cursor/row is stored. Counter copies before/after are
  private in scenario; fixture/snapshot reads are excluded by measurement order.
- `get ctx.pushes()`: current phase's private array of recorded actual Firebase
  multicast request arguments, reset together with existing phase recorder.
  Preserve tokens/notification/data privately for exact synthetic assertions;
  no response/output/receipt field is added. Existing push counter increments
  exactly once per call; retain fixed recording response. Invalid/undeclared
  payload increments unexpected before any throw so best-effort catches cannot
  turn unexpected access into accepted evidence. No raw logger argument capture.
- `ctx.nextPhase(overrides)` retains actual fresh server/TypeDI/nonmodel cache
  behavior. Scenario tracks/removes exact completed synthetic proof IDs through
  real admitted model operations between phases; bootstrap does not implement
  an OTP shortcut or broad cleanup endpoint. No new privileged context method.

Compiler reads the same ports models/roots/required IDs as bootstrap and emits
all declared variants to the existing `runtime-plan.mutants` shape. New variant
file names/bytes/original/source hashes are closed manifested compiler outputs,
not caller-provided aliases or paths. The ten appended mutation source owners:

```json
{
  "DEPENDENT_UNBOUND_CREATE_OWNER": "src1/modules/dependents/controller/index.ts",
  "DEPENDENT_UNSCOPED_LIST": "src1/modules/dependents/controller/index.ts",
  "DEPENDENT_UNSCOPED_ID_CALLS": "src1/modules/dependents/controller/index.ts",
  "DEPENDENT_FORBIDDEN_ROLE_ADMISSION": "src1/modules/dependents/controller/index.ts",
  "DEPENDENT_RAW_OWNER_STRIPPED": "src1/modules/dependents/routes/index.ts",
  "NOTIFICATION_UNSCOPED_LIST": "src1/modules/notification/controller/index.ts",
  "NOTIFICATION_ID_OWNER_GUARD_REMOVED": "src1/modules/notification/controller/index.ts",
  "NOTIFICATION_PRIOR_STRICT_OWN_ADMIN_EXPANSION": "src1/modules/notification/controller/index.ts",
  "FCM_TEST_ADMIN_GUARD_REMOVED": "src1/modules/fcm/routes/index.ts",
  "FCM_TEST_ADMIN_GUARD_AFTER_VALIDATION": "src1/modules/fcm/routes/index.ts"
}
```

Authoritative ordered append arrays for both writers (old arrays retain every
entry and relative order before these values):

```json
{
  "appendRequiredCaseIds": [
    "DEPENDENT_OWNER_CRUD_LIST",
    "DEPENDENT_ADMIN_ON_BEHALF",
    "DEPENDENT_ROLE_AND_PRINCIPAL_DENIALS",
    "DEPENDENT_OWNER_SELECTORS_DENIED",
    "DEPENDENT_HIDDEN_ID_DENIALS",
    "DEPENDENT_RAW_OWNER_FIELD_DENIALS",
    "DEPENDENT_LEGACY_VALIDATION",
    "NOTIFICATION_GENERIC_OWNER_FLOWS",
    "NOTIFICATION_GENERIC_ADMIN_FLOWS",
    "NOTIFICATION_GENERIC_DENIALS",
    "NOTIFICATION_PAGINATION_AND_COUNTS",
    "NOTIFICATION_PRIOR_STRICT_OWN_PATHS",
    "NOTIFICATION_PRIOR_SPECIALIST_PATHS",
    "NOTIFICATION_PRIOR_ADMIN_SENDERS",
    "FCM_TEST_ADMIN_RECORDING",
    "FCM_TEST_DENIALS",
    "FCM_TOKEN_REGISTRATION_COMPAT"
  ],
  "appendRequiredSensitivityIds": [
    "DEPENDENT_UNBOUND_CREATE_OWNER",
    "DEPENDENT_UNSCOPED_LIST",
    "DEPENDENT_UNSCOPED_ID_CALLS",
    "DEPENDENT_FORBIDDEN_ROLE_ADMISSION",
    "DEPENDENT_RAW_OWNER_STRIPPED",
    "NOTIFICATION_UNSCOPED_LIST",
    "NOTIFICATION_ID_OWNER_GUARD_REMOVED",
    "NOTIFICATION_PRIOR_STRICT_OWN_ADMIN_EXPANSION",
    "FCM_TEST_ADMIN_GUARD_REMOVED",
    "FCM_TEST_ADMIN_GUARD_AFTER_VALIDATION"
  ]
}
```

No result schema/provider key, role/profile/image/version/registry lock,
resource/timeout/grant or production API field changes are proposed. Any needed
change to these interfaces requires explicit amended-source review and writer
coordination, not overlapping edits or an ad-hoc runtime option.
