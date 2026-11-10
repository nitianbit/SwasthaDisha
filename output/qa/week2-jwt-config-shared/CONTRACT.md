# Actual JWT configuration-load evidence: bounded C3 extension

Status: DRAFT_REVIEW_REQUIRED; contract only, no implementation or execution.
Baseline `m0/week2-jwt-config-runtime` at
`7517a239b87559d923a2f46583173517ff4a1849`. Author owns only this file and
read-only trace/pins. Root owns future bootstrap/shared admission interfaces;
writer assignment follows two independent contract decisions. Others share this
repository; preserve original six staged files, handover archives and all other
worktrees. No Git metadata, production, fixture or dependency edits here.

## 1. Existing rule, evidence and limits

The accepted JWT_SECRET_FAIL_CLOSED_CONTRACT is policy. At real config-module
load, every environment rejects an absent key, an empty/ECMAScript-trim-blank
value and exactly the two published placeholders after trimming; fixed rejection
message is `JWT_SECRET_KEY must be set to a non-placeholder value`. Acceptance
returns the RAW value unchanged. Exact case-sensitive matching, short values
and other non-placeholders remain accepted. No strength, rotation, session,
additional-placeholder, dotenv precedence or production deployment policy.

Actual authority execution-5 at source `1c58cf5159fe0fbdc0a4309523f26f974644d43f`,
descriptor `0c64ca9950c4219d45e47c816a154df26370c3d68b6c7c662ed31722a9e4b7da`,
passed53 ordered HTTP groups and detected14 actual-source variants. Both
independent internal Codex postreviews accepted the bounded result and recorded
cleanup. Its approval/claim are consumed, with no rerun implied. Preparation
established77 TypeScript sources/63 reachable emitted modules/13 models, zero
transpile diagnostics and816 retained semantic diagnostics; no root typecheck.
This extension preserves those exact IDs, assertions, source mutants, order,
correctness indexes and their historical PASS; its new checks remain NOT_RUN.

This proves actual CONFIG load throws within an admitted child and later rejects
public-key-signed HTTP tokens. Expected module exceptions are caught in that
same child. They do NOT establish a nonzero child exit per bad-key case, full
src1/index startup, a PM2 restart loop, deployed code/secret state, full M0/Week2,
client compatibility, the115 register, named-owner or release/100 RPS acceptance.
The earlier JWT contract's whole-process startup fixtures remain only partially
addressed and must not be relabeled complete. Root C2 adoption/deployed facts and
all production/key/account actions retain their existing separate gates.

No package/lock/version/image, source production policy, model/collection/index,
network/filesystem/process permission, resource/time/output bound, Mongo
parameter, provider or public result/error schema changes. Keep accepted test-only
profile2 (including fixed nonzero64 MB index-space threshold), Node22.23.4,
Mongoose9.12.0, Mongo8.0.34, TS5.9.3, two owned containers, existing public lock and
closed recording/sentinel map. No new child/worker/addon: no subprocess per trial.

## 2. Discovery and exact module boundary

Graph-first discovery found exported CONFIG at src1/config/config.ts. The graph
is indexed at canonical main `bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7`; CONFIG
inbound tracing is empty and is not proof of no consumers. Current bytes govern:
auth/services signs through CONFIG.JWT_SECRET_KEY; actual middleware/auth.ts
verifies through it and maps JsonWebTokenError to401 INVALID_TOKEN. Settings'
getter is unchanged. Do not import other settings/provider/startup code.

Current config.ts calls real dotenv.config for `<cwd>/.env` before initializing
CONFIG, calls requireJwtSecret synchronously in its key initializer, and later
calls process.exit(1) in production if MONGODB_URL is absent. Every trial therefore
MUST retain the actual parent-derived OWNED URI, including production trials.
Do not intercept process.exit to simulate rejection or let an unrelated Mongo
setting exit masquerade as the JWT guard. Cwd remains admitted `/workspace`, with
no .env/service-account/local configuration or inherited operational credential.

Alias `@/config/config` is already manifested at compiled/config/config.js.
Read-only inspection of the actual preparation-7 artifact found literal requires
ONLY `dotenv` and `path`; ISettings is erased. Emitted CONFIG SHA256 is
54c485ca45dba9e25a982d69503b09596d0127793c67cf92d94528f22bd2cf83.
This is byte/source analysis, not module evaluation. Fresh preparation must
reconcile that closure again; retain actual dotenv/path, not a copied validator,
extracted function, modeled decision table or substituted CONFIG. No new source
root, exercised domain stub, package, model or provider is needed. Compiler must
retain exact13-model audit/five controls and all semantic diagnostics honestly.

## 3. Placement, isolation and observed effects

The controller runs only AFTER complete existing file/source/lock/port/run/env,
network/no-egress/permission/filesystem admission, closed loader and ODM/driver
URI/database/collection guards, generated private key and owned URI. Install
existing recording ports before the first CONFIG load. Run it BEFORE first
phase/router construction, real CONFIG domain import, connection, collection/
index creation, HTTP listen or command-side domain work. Bootstrap stage stays
ADMISSION until the existing ROUTER_IMPORT stage; no new public failure stage.
The matrix itself is the first intentional CONFIG domain import.

Load genuine public libraries only under the already admitted manifest. At this
checkpoint mongoose.modelNames() must be empty and connection readyState0, with
no prior listening server. A private preconfig window instruments actual attempt
boundaries and hard-denies them before delegation:

- connection attempts: existing guarded mongoose.connect/createConnection,
  Connection.openUri, driver MongoClient.connect and net.Socket.connect;
- listen attempts: net.Server.prototype.listen (including inherited HTTP listen);
- write attempts: Model.create/insertMany/bulkWrite, Model.prototype.save, and
  Query.exec for updateOne/updateMany/replaceOne/deleteOne/deleteMany/
  findOneAndUpdate/findOneAndReplace/findOneAndDelete. These are temporary fixture
  taps on the exact admitted package, not replacements for any exercised domain.

Capture references AFTER existing guards are installed, so restoration cannot
restore an unguarded connector. Each tap increments a private attempt counter
and terminal unexpected latch before throwing a fixed public fixture code. It
must not invoke the original operation in this preconfig window, even if the
source catches the exception. Missing declared tap points fail admission; no
silent skip. Restore all captured guarded references in an outer finally on
success or failure; normal HTTP/DB paths then delegate unchanged under existing
guards. Do not permit arbitrary callbacks/URIs or globally relax loader/IO.

Take before/after checkpoints around EACH actual CONFIG load: connection/listen/
write attempt counts, dbWrites, email/SMS/push/logger/JWT-issued, excluded and
unexpected counts all unchanged, modelNames still empty and readyState0. Keep
actual recording logger/transport sentinels present; no raw arguments captured.
This proves zero attempted start/connection and no application effects for the
actual admitted load, rather than inferring them from the exception alone.
The fixed synthetic signature assertions below run AFTER the per-load zero-effect
checkpoint through genuine originalSign/jwt.verify; they are intentional fixture
operations, separately private, not app token issuance hidden in a load counter.

Before each trial reset nonmodel compiled module cache (which includes actual
CONFIG and emitted mutants), assert target cache entry absent, activate only the
reviewed alias override if any, and set exact trial env. Use delete for unset
JWT_SECRET_KEY; never assign the string "undefined". Snapshot own-property
presence/value of NODE_ENV/JWT_SECRET_KEY/MONGODB_URL; in each finally restore
presence/value exactly, clear CONFIG/mutant cache and reset overrides. No valid
cached CONFIG may satisfy an invalid case. Positive exports must be a fresh
module object, not an earlier instance. Public library cache may remain.

After the entire nominal/negative matrix, in outer finally restore ephemeral
owned environment and admitted prototype references, clear compiled CONFIG/cache
and overrides. Preserve the first failure through restoration; secondary cleanup
errors stay private/fixed. On any assertion failure do not continue normal domain
startup. Existing owned HTTP/ODM/container teardown handles the failed run; no
retry or extra phase import is introduced by failure cleanup.

On success, NODE_ENV is test, JWT_SECRET_KEY is the original generated raw key,
MONGODB_URL is the derived owned URI, model count is still0, all attempt/effect
counters remain0, and no compiled CONFIG is cached. Only then execute the
unchanged first phase, real routers/model registration, connection and53 HTTP
cases. This is not startup with a missing/rejected key.

## 4. Frozen nominal matrix: 108 real fresh loads

Use exact NODE_ENV strings test, development, production, each with the same
retained owned MONGODB_URL. The ECMAScript set is the already contracted trim
set, explicitly these25 codepoints (no Python str.strip substitution):

```text
0009 000A 000B 000C 000D 0020 00A0 1680
2000 2001 2002 2003 2004 2005 2006 2007 2008 2009 200A
2028 2029 202F 205F 3000 FEFF
```

Per environment execute32 invalid and4 valid values:108 genuine loads total.
A group receives a PASS row only after every unique environment/sample ID in
that group actually loaded fresh compiled CONFIG, met its predicate and zero-
effect/freshness/restoration checks. Correlate exact expected/seen sample sets
and counts; no precomputed PASS rows, missing samples, duplicates or skips.

| Appended case ID | Per-environment samples and mandatory predicates |
| --- | --- |
| JWT_CONFIG_UNSET_DENIED | One unset property: loader.load actual CONFIG throws Error with the exact fixed JWT message; no cached export, attempted operation or effects.3 trials total. |
| JWT_CONFIG_BLANK_DENIED | Empty string, each of the25 whitespace codepoints alone, and their concatenation:27 per env/81 total, same exact immediate module-throw predicate and zero effects. |
| JWT_CONFIG_PLACEHOLDERS_DENIED | Both literal your-secret-key and your-secret-key-change-in-production, plus each padded on both sides by the combined trim set:4 per env/12 total. Fixed JWT module throw, no value logged. |
| JWT_CONFIG_VALID_VALUE | One generated non-placeholder key per env/3 total; exported key strictly equals RAW input, CONFIG.NODE_ENV matches trial and MONGODB_URL remains owned. Genuine originalSign over synthetic claims verifies with the actual exported key. No app-side issuance. |
| JWT_CONFIG_PADDED_VALUE_UNCHANGED | Same generated key with nonempty whitespace prefix/suffix,3 total. Strict raw equality; genuine signature made with raw input verifies through exported key, and verification using its trimmed different value fails. No trim-return policy. |
| JWT_CONFIG_NONPLACEHOLDER_VALUES | The short literal x and case variant Your-Secret-Key,2 per env/6 total. Accepted raw unchanged with the same signature/zero-load-effect checks. This preserves existing no-strength/exact-case policy, not approval to deploy those known values. |
| JWT_PUBLISHED_FALLBACK_TOKEN_DENIED | This seventh group runs later over actual HTTP. Under restored generated current key, sign synthetic existing user claims with EACH of the two published literals and call a previously proven own-user authenticated read. Each response401 INVALID_TOKEN with strict error envelope;13-collection before/after state identical, zero DB reads/writes/JWT/delivery/excluded/unexpected advancement, exactly one real error-handler recording log per denial. Genuine current-key own-read remains successful. No raw JWT escapes memory. |

The first six groups contain108 module trials (96 rejected/12 accepted); the
seventh contains at least two real HTTP denials plus a genuine positive control.
Append these seven IDs after existing53, for exactly60 nominal IDs. Preserve the
existing53 physical request order/predicates and14 mutation probes. Matrix loads
execute before them physically; their six safe PASS rows are carried privately
and appended after existing53 results, before the seventh new HTTP group. No
new top-level result shape, case data field or raw counter/key/exception output.

## 5. Three actual-source sensitivity variants

Compiler emits three additional variants of the REAL src1/config/config.ts using
closed exact transforms/AST boundaries; nominal production bytes never change.
Record original/source/mutant hashes and manifested regular output files. These
variants may be selected only by explicit private config alias phases after full
admission; no production flag, copied function, fake CONFIG or faked load result.

| Appended sensitivity ID | Real source edit and required detection |
| --- | --- |
| JWT_CONFIG_PUBLISHED_FALLBACK | Replace only key initializer with the old process.env.JWT_SECRET_KEY || published your-secret-key fallback. In ALL three envs same nominal unset-rejection predicate must fail specifically because actual CONFIG exports that fallback without throwing; separately verify that exact unsafe result and zero attempted effects. |
| JWT_CONFIG_PRODUCTION_ONLY_GUARD | Change only initializer to validate in production and return raw process.env.JWT_SECRET_KEY otherwise. Same nominal unset-rejection predicate fails specifically in test/development because actual CONFIG exports undefined; production unset must still throw the fixed JWT error as a control, with owned MONGODB_URL retained. |
| JWT_CONFIG_TRIMMED_RETURN | Change only requireJwtSecret's return value to value.trim(). Same nominal padded-raw equality/signature predicate fails in all three envs; actual exported value equals trimmed input rather than raw, and raw-signed token fails verification using that exported key. No infrastructure failure counts as detection. |

Use the IDENTICAL nominal predicates, catch only their expected fixed-literal
assertion failure, and then prove the precise unsafe return/signature behavior.
Unrelated config/loader/DB/permission/process exit/errors are terminal failures,
not detected:true. After each variant clear cache/override/env and repeat its
predicate with fresh nominal CONFIG to prove restoration. No model/router import,
connection, listen, provider or write occurs during these phases. Their module
load effect counters remain0; private signature-control operations are separately
accounted. Append three rows after original14 for exactly17 sensitivities; rows
stay only id/detected. Negative phase effects never enter nominal provider counts.

## 6. Frozen interface proposal and implementation gates

After two exact contract decisions root assigns bootstrap/shared ports/admission/
pure-unit changes; a separately assigned writer owns compiler/scenario/README.
No implementation is authorized by this draft. No changes to .env.example,
config.ts, consumers, src1/index, startup, packages, production settings or owners.

Proposed private `ctx.configurationEvidence` (no public result-schema addition):

```text
{ cases: [{id,status:'PASS'}] for the exact six module groups,
  sensitivity: [{id,detected:true}] for the exact three config variants }
```

It is derived only after all actual loads/predicates/sample-set/counter/cache/
restoration assertions. Freeze it before router phase; scenario validates exact
IDs/uniqueness before appending it, and runs the new real HTTP group before the
existing nominal counter snapshot. Append config sensitivity rows after actual
old14 probes. Do not accept caller-supplied evidence, alternate commands, a skip
mode or a helper path/URI. Use existing actual originalSign only for explicit
private signature fixtures; config module evaluation itself has JWT issuance0.

Source candidate requirements: closed sixty/seventeen required IDs; actual CONFIG
alias/source binding in plan; exact model13/roots/ports/old53/14 preservation;
private helper pure tests with hard fake load/connection/listen/write/provider
ports (zero real IO), proving bad env/cache/missing/duplicate samples, unexpected
or caught-effect attempts, wrong exceptions, restoration including unset,
prototype reference drift and primary-error preservation fail correctly. Fake
units prove their controller boundary, not real CONFIG load behavior.

Then obtain two independent source reviews, coherent local commit, two exact
locked preparation decisions, actual new emitted closure/mutant/diagnostic
reconciliation, two fresh exact one-run decisions and actual result/cleanup
postreviews. Retain initial failures/findings and consumed claims. No root
install/type/build/start adoption, process-per-case grant, extra runtime retry or
release gate follows. Required actual cases never pass as skipped/NOT_RUN, and a
caught expected module throw is never reported as whole-process startup evidence.

## 7. Baseline input pins (SHA-256)

| Path | SHA-256 |
| --- | --- |
| documentation/planning/implementation/JWT_SECRET_FAIL_CLOSED_CONTRACT.md | 832f8246db74c04e22791c5b9c86eb646f089636ffd09d577954263a333737c1 |
| documentation/planning/M0_START_APPROVAL_STATUS.md | 67eea927661cf1a94d8644ede28eaa7315d4774866958ff346b37aac5a559be3 |
| documentation/planning/implementation/C2_COMPATIBILITY_REVIEW.md | e703e7bc43495868edd2ab535cb38b0f5f2ac54b5d572c2c38467b59e2ae67d4 |
| documentation/planning/implementation/C3_AUTH_API_RUNTIME_CONTRACT.md | 73301872982a0f79fa805538f679c08e53ce6ef0528790cc75144ed7e2a7d0ee |
| documentation/planning/implementation/M0_A_PROGRESS.md | 1596c25ce1d73a0785bd4ca6db9f67a7a57479de14868b09ebd908f700963d5b |
| output/qa/week2-authority-api-extension/CONTRACT.md | 23f37d31fe77565ce7d5d04689b777d5f539dd079d787b26ca6346e5e42c4f90 |
| output/qa/week2-authority-api-extension/source-freeze.json | 376c3621581bffe775b95e8583f94ca82df43100407bb89c738bfcb3db8a77e2 |
| output/qa/week2-api-runtime/execution-5/REVIEW.md | 2ef39181c8920e85e97eaa6d08d79f0c5385025c10ede5324f8a398e6b721aab |
| output/qa/week2-api-runtime/execution-5/verification.json | 79e10cc470eedd3894e325f2c50ff376f631cdcf6e9bc83bbf855b59f46748ca |
| output/qa/week2-api-runtime/execution-5/operator-result.json | 54055bebd3673889243145dd548dc27e244de09ea44f75bd7d2dacd12b2d4bb5 |
| src1/config/config.ts | e879b0f9c635283d7c9a271128605c6d8583995356e30f5f1c318d23270d09f6 |
| src1/modules/middleware/auth.ts | db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2 |
| src1/modules/auth/services/index.ts | d59d5ea23df586fbbdb5b9c4615bcbe0b716f649bdc02f3738088f87b0fbae56 |
| src1/index.ts | d4f7af96f4fcda85be1f8ba942c362fb8b4b809a7c0eebd0e861c36f7f7624df |
| test/api-runtime/scenario/bootstrap.cjs | 1e464bfbdfb0ddfa77efea4421bde21fa03eef4d367cc32fa2208ab638063fd6 |
| test/api-runtime/scenario/compile.cjs | f61398a951f17f349dc42a182795c0de46a0f913699631813f28bccfc82662d5 |
| test/api-runtime/scenario/scenario.cjs | 867b0a5206b64dd9b9ecda35a910df060172b533a61d1feb19f79eb706c56fe7 |
| test/api-runtime/scenario/ports-manifest.json | 626d384db90b98ea72b3ed81de3e27857231802ba7a1edd542715e2e3abd885f |
| test/api-runtime/scenario/package-plan.json | d7830a9ce688235bb64f3f9f7ac3d5dd604bb63641cdae97b8b7250bfd957227 |
| test/api-runtime/scenario/prepare.py | 39b4085370a09a34069b9f1c4f45cfd8fa38a3a1f0e380abcef9c469a5add598 |
| test/api-runtime/platform.mjs | b5117065c90c4698cb9604a8da0cb673a38249d8eee07a8ac39e11040a56e29f |
| test/api-runtime/profile.json | bb310dd4909678d239a37975b7326960ffce1fb9b788bbe41beb65c7bcfdad54 |
| package-lock.json | 0f8d4fe081e8de1cf87673f743b73ee404be2483fbc144416039ca3076822080 |
