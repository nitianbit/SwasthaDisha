# Focused production-router API fixture

This candidate stages and exercises the actual production auth/OTP/user/wallet/dependents/notification/FCM
routers, controllers, services, repositories and models. It uses real HTTP, a
separately admitted owned MongoDB replica set, genuine random OTP generation and
JWT signing. Email/SMS methods use a recording Axios adapter; logger/FCM transport
ports are recording only. Payment and coupon services are explicit throwing
exclusions. No application entry point or production provider is admitted.

The accepted core run passed its original36 nominal cases/four actual-source
sensitivity checks under test-only profile2; see
[execution4](../../../output/qa/week2-api-runtime/execution-4/REVIEW.md).
The reviewed authority-extension contract appends17 groups/ten variants for
53 nominal IDs/14 sensitivity IDs and13 models (Dependent is the sole addition).
These new cases and emitted AST controls are NOT_RUN in this source candidate.
`ports-manifest.json` fixes the exact IDs/models/correctness indexes/package roots,
recording ports and safe output counters. `compile.cjs` stages the declared source
closure with TypeScript 5.9.3 legacy decorators and emitted metadata. A static AST traversal of emitted nominal CommonJS follows actual literal require
edges and requires every reachable model declaration to match the model/source
manifest, including WellnessPackage imported by CorporateRepository and the
additional actual Dependent registration. Its five metadata rejection controls
(the existing four plus missingDependent) run only during separately approved emit. It preserves
syntactic and focused semantic diagnostics, including missing/excluded types,
and reports `TRANSPILE_ONLY_NOT_TYPECHECKED` with `fullBuild:false`. This is not a
root build/type-check or a production compatibility claim.

`bootstrap.cjs` checks the complete run/file/env/port/network/permission admission
before any domain import or DB connection. It installs a closed CJS map and ODM/
driver URI/database/collection guards before eager router construction. The
bootstrap generates its JWT key and own URI in memory. `scenario.cjs` reports
case IDs and safe counts only; raw HTTP responses, OTPs, tokens, keys, synthetic
identity rows and assertion operands are never printed or persisted.

Database setup retains its original CONNECT, HELLO, COLLECTION_CREATE and
INDEX_CREATE actions, arguments and results. A wrapper calls each action once and
maps only finite known error names/codes to 48 fixed public step/category literals;
known guard codes are preserved. Exact numeric codes 14031, 67 and 72 have
separate OUT_OF_DISK_SPACE, CANNOT_CREATE_INDEX and INVALID_OPTIONS categories.
Numeric strings do not match. Actual execution3 measured strict numeric14031;
the separately accepted profile2 fixes the owned fixture
indexBuildMinAvailableDiskSpaceMB at nonzero64, with unchanged512 MiB data tmpfs.
Execution4 subsequently passed. Those facts authorize no further parameter,
capacity, index or production changes.
It examines at most the original error plus two
cause objects, reads data descriptors without invoking error accessors, and retains
the original thrown value only in a non-enumerable in-memory cause. The existing
seven-field failure protocol is unchanged; new failures contain no original
message, URI, path, row or validation fields. No retry or permission change follows
from these diagnostics.

The owned HTTP and ODM handles both receive one cleanup attempt after the action.
An earlier terminal error remains primary even when either cleanup fails; secondary
causes stay in non-enumerable memory metadata. Cleanup failure without an earlier
error uses one fixed public failure code. Success JSON is emitted only after both
handle closures succeed. The dependency-free fake action matrix checks these
paths; no new real invocation is authorized.

Nominal denials assert the exact error envelope/status/code, unchanged state
across all13 manifested collections and no JWT, delivery or DB-write effects.
New authority denials require exactly one recording logger call from the actual
error handler. Read counters are measured between snapshots, proving pre-lookup
denials where promised. Successful mutations allow only exact target rows and
fields; other collection/row state and effect counters remain unchanged. Two-reader barriers wrap actual completed MongoDB
query reads; final-expiry scheduling wraps an actual completed conditional update.
Neither changes a result. Race checks count actual per-collection MongoDB write
commands and provider deltas, including exactly one user update and notification
insertion for the nominal winner. Source mutants are separately emitted, manifested and
run only in explicit negative phases with fresh TypeDI classes/server/module
caches. Nominal source is restored between every phase. Detected defects appear
only in separate `sensitivity` rows. Output provider counts cover nominal cases;
negative-phase effects are asserted separately in memory and excluded from those counts.

New authority cases preserve all seven Dependent registrations, all sixteen
Notification registrations and both FCM routes. Exact admin global generic
notification scope does not expand old strict-own routes; specialist aliases
remain specific to their existing routes. Single notification create has no
push; explicit-target general send and admin FCM/test reach actual services and
the private recording Firebase port. Payload mismatch latches unexpected even
when the best-effort domain sender catches an error. No real delivery is claimed.

Synthetic60-second challenge proof IDs and owning fixture identity are tracked
privately; exact completed proofs are removed only after associated core
assertions/scheduling and between completed phases, before fresh snapshots.
No active race/expiry proof, expiry value, TTL/index or unrelated row is changed.
Each new mutant must fail the same nominal predicate for the precise expected
reason, establish actual forbidden HTTP/DB/recording behavior for every promised
operation, restore nominal classes, repeat the fixed predicate, and delete only
its exact newly-created identity-bound fixture rows. No arbitrary exception is
a detected regression. Nominal provider summary excludes every negative phase.

Offline checks require no package installation or application evaluation. The
shared pure admission/diagnostic/cleanup/recorder suite blocks all domain imports,
connections and writes;16 pure lock cases cover public URLs/integrities and root
closure drift. The owned Python source-data checker validates preservation/ID/
transformation scope and deliberately weakened source controls; it proves no
HTTP/database behavior or emitted AST result:

```sh
env -i PATH=/usr/bin:/bin /opt/homebrew/bin/python3 -I -B test/api-runtime/scenario/offline-unit.py
/private/tmp/m0-node22/node --permission --allow-fs-read="$PWD/test/api-runtime/scenario" test/api-runtime/scenario/bootstrap-unit.cjs
/private/tmp/m0-node22/node --check test/api-runtime/scenario/bootstrap.cjs
/private/tmp/m0-node22/node --check test/api-runtime/scenario/compile.cjs
/private/tmp/m0-node22/node --check test/api-runtime/scenario/scenario.cjs
```

Preparation has two closed modes, both disabled without exact direct independent
review receipts. First `prepare.py --resolve-lock` requires the fixed private
`/private/tmp/sd-auth-api-preparation-approval.json` receipt with decision
`APPROVE_PUBLIC_LOCK_RESOLUTION_ONLY`. It resolves public metadata with scripts
disabled in a new private workspace, validates registry URLs/integrities and
unchanged ordinary root-lock closures, and exclusively writes the fixed public
`/private/tmp/sd-auth-api-resolved-lock.json`. It does not install or compile.

Then `prepare.py --install-emit` requires the fixed private
`/private/tmp/sd-auth-api-emission-approval.json` receipt with decision
`APPROVE_LOCKED_INSTALL_AND_EMIT_ONLY` plus the reviewed `resolvedLockSha`.
It creates a different private workspace, installs only that exact public lock
with `npm ci --ignore-scripts --omit=optional`, removes bin links, rejects native
addons/symlinks, and emits without evaluating any app module. Both receipts use
schema `SD-AUTH-API-PREP-APPROVAL-1` and bind clean source root/commit,
`prepareSha`, `compilerSha`, `packagePlanSha`, and two distinct actual nonauthor
reviewer IDs/decisions. No supplied path, URI, command or existing workspace is
accepted. Source uses the accepted OTP hash pins.

The ignored `runtime-template.json` descriptor uses schema
`SD-AUTH-API-TEMPLATE-1` and `directory`, pointing only to its newly created
`/private/tmp/sd-auth-api-build-UUID/runtime`. All descriptor creation is
exclusive. The parent copies it as immutable input into a separate owned runtime
bundle; preparation does not create/start Docker containers or evaluate a driver.
Exact later Docker execution requires its own two direct reviews/admission.

New authority17/ten cases and detections remain **NOT_RUN** until fresh
preparation/artifact/two exact single-run decisions and actual execution succeed.
Core36/four PASS is preserved historical evidence, not approval for this new run. Full application startup,
root dependency adoption, retained-server C2 facts, broader OTP/money policy,
owner acceptance, deployment and release gates remain open.
