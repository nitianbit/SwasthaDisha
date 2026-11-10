# Focused production-router API fixture

This candidate stages and exercises the actual production auth/OTP/user/wallet
routers, controllers, services, repositories and models. It uses real HTTP, a
separately admitted owned MongoDB replica set, genuine random OTP generation and
JWT signing. Email/SMS methods use a recording Axios adapter; logger/FCM transport
ports are recording only. Payment and coupon services are explicit throwing
exclusions. No application entry point or production provider is admitted.

`ports-manifest.json` fixes 36 nominal cases, four actual-source sensitivity
variants, 11 models/collections, exact correctness indexes, package roots,
recording ports and safe output counters. `compile.cjs` stages the declared source
closure with TypeScript 5.9.3 legacy decorators and emitted metadata. It preserves
syntactic and focused semantic diagnostics, including missing/excluded types,
and reports `TRANSPILE_ONLY_NOT_TYPECHECKED` with `fullBuild:false`. This is not a
root build/type-check or a production compatibility claim.

`bootstrap.cjs` checks the complete run/file/env/port/network/permission admission
before any domain import or DB connection. It installs a closed CJS map and ODM/
driver URI/database/collection guards before eager router construction. The
bootstrap generates its JWT key and own URI in memory. `scenario.cjs` reports
case IDs and safe counts only; raw HTTP responses, OTPs, tokens, keys, synthetic
identity rows and assertion operands are never printed or persisted.

Nominal denials assert the exact error envelope/status/code, unchanged DB state and no JWT,
provider or DB-write effects. Two-reader barriers wrap actual completed MongoDB
query reads; final-expiry scheduling wraps an actual completed conditional update.
Neither changes a result. Race checks count actual per-collection MongoDB write
commands and provider deltas, including exactly one user update and notification
insertion for the nominal winner. Source mutants are separately emitted, manifested and
run only in explicit negative phases with fresh TypeDI classes/server/module
caches. Nominal source is restored between every phase. Detected defects appear
only in separate `sensitivity` rows. Output provider counts cover nominal cases;
negative-phase effects are asserted separately in memory and excluded from those counts.

Offline checks require no package installation or application evaluation. The
22 fake admission cases exercise the same pure guard used by bootstrap with all
application imports, connections and writes blocked; 16 fake lock cases cover
public URLs/integrities and root-closure drift:

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

All runtime cases and source-mutant detections remain **NOT_RUN** until the
separate preparation and runtime gates are satisfied. Full application startup,
root dependency adoption, retained-server C2 facts, broader OTP/money policy,
owner acceptance, deployment and release gates remain open.
