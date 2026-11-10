# M0 deployment baseline and local observations

**Recorded 9 November 2026.** This records non-secret facts for Review-B condition C2. Local CLI diagnostics and repository metadata are not evidence about a running service. No application code/import/startup, test runner, Docker daemon, database or provider was invoked.

| Fact | Observed local/repository value | Owner-reported or target value |
| --- | --- | --- |
| Branch and HEAD | pharmyx-fixes at 9ca8b54606581f2158e760cad79aa7b845529184; no tracked/staged edits | UNKNOWN; owner/DevOps |
| Node | Local CLI v24.19.0 | Owner-selected target major: Node 22; exact patch and target-host runtime not yet verified |
| npm | Local CLI 11.17.0 | UNKNOWN/build image tooling |
| Runtime pin | No package engines/packageManager, .nvmrc or .node-version in checked paths | UNKNOWN |
| Declared start/build | npm start = nodemon server.js; build = tsc; dev:ts = tsx watch src1/index.ts | Owner reports `pm2 start server`; PM2 is the reported process manager. Working directory, resolved script, build command and PM2 version remain unverified |
| Entry-point consistency | Root server.js imports absent src/config/config.js, src/db/index.js and src/routes/index.js; tsconfig rootDir is src1 and outDir is dist | F01 must reconcile the PM2 target with the compiled application; no PM2/application startup was attempted |
| ODM | Manifest mongoose ^6.6.2; lock resolved 6.13.8 | Actual installed ODM revision UNKNOWN |
| MongoDB driver | Root lock resolved mongodb 4.17.2 | Actual installed driver UNKNOWN |
| MongoDB server/topology | Not queried; mongod/mongosh not found on PATH | Owner reports Mumbai server location; hosting type, MongoDB version and replica-set/sharded/standalone topology remain UNKNOWN |
| Lock consistency | Manifest xlsx ^0.18.5; no node_modules/xlsx lock entry | Build/deploy dependency resolution UNKNOWN |
| Local tools | node_modules/.bin/tsc, tsx and nodemon absent | CI/build tools UNKNOWN |
| Container tooling | docker binary /usr/local/bin/docker; no daemon/context/container probe performed | Hosting/container topology UNKNOWN |
| Deployment files | No tracked matching YAML/Dockerfile/Procfile/ecosystem/service definitions found; named root Docker/Compose/PM2/CI paths absent | External deployment configuration UNKNOWN |
| Live exposure | Source wording is not deployment evidence | Owner confirmed: pre-launch, not serving real patients or taking payments, on 9 November 2026 |
| Client builds | Prior review mentions one mobile source branch only | Supported deployed patient/doctor/admin clients UNKNOWN |

## Required owner or DevOps record

The owner has supplied pre-launch status, `pm2 start server`, Node 22 and Mumbai server location. Still record the intended target's MongoDB hosting type, server version/topology, exact Node patch, working directory/resolved PM2 script, build command and source/client revision. A non-secret config path or existing deployment runbook is sufficient as the entry point. Do not paste .env, private keys, tokens, patient data or credential-bearing MongoDB URLs.

Pre-launch status resolves the live-exposure question; the intended target remains partial: Node major 22 is selected, while MongoDB details remain unknown. Record the missing target facts before F01 script/dependency edits. A supported dependency/runtime choice needs compatibility verification against that target. The current local Node CLI does not justify a production pin or a major Mongoose migration.

The owner answered “not sure” about MongoDB hosting/version/topology. This remains UNKNOWN; Mumbai is a location, not proof of Atlas or replica-set topology. Do not ask the owner to guess or connect to an operational database to infer the answer.

## Proposed fresh deployment target

For a new deployment, the engineering recommendation is Node 22 with PM2 running the verified compiled application, and a managed MongoDB replica set in Mumbai. Atlas supports AWS Mumbai (`ap-south-1`); a replica set supports the multi-document transactions the design needs, whereas standalone MongoDB does not. This is a proposed target, not a claim about an existing server or authorization to provision a paid cluster. [Atlas regions](https://www.mongodb.com/docs/atlas/reference/amazon-aws/), [transaction requirements](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/).

MongoDB 8.x is a candidate server line for the fresh target. It is not a compatible drop-in decision for this lockfile: Mongoose's current table lists Mongoose 8.7+ or 9.x for MongoDB 8.x. Mongoose 6 is in limited maintenance, with announced end of life on 1 February 2027. Select exact supported versions only in a separate reviewed compatibility slice; retain current majors during F01 investigation. [Server compatibility](https://mongoosejs.com/docs/compatibility.html), [maintenance policy](https://mongoosejs.com/docs/version-support.html).

The official driver matrix does not list driver 4.17 with Node 22 as a tested compatible combination; later driver lines do list Node 22. This is a support gap, not an observed application failure. A newer Mongoose major also changes behavior: its migration guide calls for staged upgrades and documents middleware/query changes. No major upgrade, independent driver override, or new server version is silently included in the approved F01 work. [Driver compatibility](https://www.mongodb.com/docs/drivers/compatibility/?driver-language=javascript&javascript-driver-framework=nodejs), [Mongoose migration guide](https://mongoosejs.com/docs/migrating_to_9.html).

Before adoption, backend/DevOps must settle hosting and server version, review the exact dependency and migration diff, and prove C3 isolation before any install/start/test that can execute effects. Contract fixtures must cover query/validation behavior, middleware, indexes, transactions, rollback/retry and existing legitimate journeys. Cluster size and the 100 RPS claim require measurement; no tier or cost is selected here. Read-only investigation can continue while this decision remains open.

Read-only evidence: package/lock parsing, file-presence/tracked-config inventory, node --version, npm --version and binary lookup. No dependencies installed, application checks executed or deployment settings changed. The historical missing-tsc check remains BLOCKED; no new PASS/FAIL is claimed.

## Implementation follow-up, 9 November 2026

The observations above precede implementation. The owner subsequently requested development start. A checksum-verified local Node 22.23.4 runtime now runs the dependency-free foundation preflight tests; Node 24.19.0 also passes the same 18 checks. This is local unit-test tooling evidence, not a host/runtime pin or proof of MongoDB-driver compatibility. The [implementation log](implementation/M0_A_PROGRESS.md) records the exact scope and remaining C2/C3 gates. No application or database/provider operation has run.

## Implementation follow-up, 10 November 2026

The bounded foundation suite now has 56 passing checks on each runtime and 18 executable rejection canaries. A separately owned local Docker fixture ran MongoDB 8.0.34 with measured transaction commit/rollback; cleanup acknowledgement and independent absence readback are recorded. This is a new local test resource, not an existing deployment probe or application-driver compatibility proof. No application startup, real provider, root install/dependency or deployment change occurred. See the [dated implementation evidence](implementation/M0_A_PROGRESS.md#second-increment-10-november-owned-mongodb-fixture).

The [C2 decision packet](implementation/C2_COMPATIBILITY_REVIEW.md) is ready for the separately scoped compatibility review. Its local/CI target and ODM candidates remain proposals; missing intended-deployment facts above remain UNKNOWN.

## Owner target update, 10 November 2026

The owner chose to **retain the existing server** and obtain its details from DevOps. The fresh managed Mumbai replica-set recommendation above is therefore not the selected deployment plan. MongoDB server version/topology/hosting and exact Node/PM2/build facts remain unknown. The local MongoDB 8.0.34 fixture establishes no such deployment facts.

The [DevOps handoff](implementation/DEVOPS_BASELINE_REQUEST.md) is the required non-secret baseline input. Internal technical reviews approve a static-only Mongoose type comparison in owned temporary resources; root package/lock/start/runtime edits still await the intended-server facts and reviewed adoption diff.
