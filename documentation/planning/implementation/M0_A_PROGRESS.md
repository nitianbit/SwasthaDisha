# M0-A implementation progress

**Repository transition, 10 November 2026:** active work now continues in `nitianbit/SwasthaDisha`. Branch/commit references in the dated records below describe the legacy source review. Read the [transition record](REPOSITORY_TRANSITION.md) for the new repository baseline and current execution location.

**Started 9 November 2026; updated 10 November. Branch: `m0/f01-foundations`. Base commit: `9ca8b54606581f2158e760cad79aa7b845529184`. Status: IN PROGRESS; M0-A and M0 are not accepted.** The owner's development-start request confirms the bounded scope already technically approved by both reviewers. The latest instruction authorizes bounded development/review cycles. Current evidence and next gate appear in the 10 November addendum below.

## First increment, 9 November: foundation unit-test admission

Implemented [preflight](../../../test/foundation/preflight.mjs), a [fixed runner](../../../test/foundation/run.mjs), [assertion tests](../../../test/foundation/preflight.test.mjs) and [usage/boundary notes](../../../test/foundation/README.md). No application/package/startup or database-library changes are part of this increment.

The runner creates and owns a new filesystem fixture, holds its identity in memory, stages only regular allowlisted unit source files, rejects unexpected/symlinked files and constructs a clean child environment. It validates before spawning the fixed test entry. Filesystem permissions restrict the child to the fixture; it receives no child-process, worker or native-addon permissions. Cleanup requires the original directory and ownership evidence. Required skips, TODOs, empty runs and abnormal/test failures cannot produce a passing gate.

An empty file is significant: Node can report it as one passing file test. The gate therefore requires explicit cases beyond that fallback as well as a complete passing summary. Negative canaries exercise the executable runner rather than only testing its summary parser.

## Executed evidence, 9 November snapshot

| Check | Observed result | Evidence |
| --- | --- | --- |
| Node 22.23.4 foundation run | 18 PASS; 0 FAIL; 0 skipped/TODO | [TAP](../../../output/qa/m0-a/node22.tap) |
| Node 24.19.0 foundation run | 18 PASS; 0 FAIL; 0 skipped/TODO | [TAP](../../../output/qa/m0-a/node24.tap) |
| Six executable negative canaries | Each returns nonzero as expected: assertion failure, required skip, required TODO, empty suite, bypassed preflight and symlinked staged source | [Verification manifest](../../../output/qa/m0-a/verification.json) |
| Ownership/admission tests | Reject copied identity, directory replacement, changed marker, wrong cwd/run, operational settings and `.env`; denied fake import/connector counters remain zero | Included in both TAP runs |
| Filesystem/process restrictions | Child cannot read parent files, create symlinks or spawn another process; parent bootstrap denies an existing symlink before test loading | Included in the runner/TAP evidence |

The historical manifest records that increment's source SHA-256 values. Those runs used fresh child configuration and no application imports, Docker, database or provider operations. Node 22 was downloaded from the official distribution into `/private/tmp`; its archive matched the official SHA-256 `c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428`. This verifies the local test tool, not a deployed Node version or a production runtime pin. [Official distribution checksums](https://nodejs.org/dist/v22.23.4/SHASUMS256.txt).

The existing selected 115-scenario register is unchanged: **0 PASS, 1 FAIL, 1 BLOCKED, 110 NOT_RUN, 3 DEFERRED**. These new foundation checks supplement that evidence; they do not mark an entire integration/build/security scenario passed. The operations prospectus and v1.7 PDF snapshots retain their publication-time evidence.

## Entry gates at the 9 November checkpoint

- **C2 / compatibility:** pre-launch, Node 22, PM2 and Mumbai are owner-reported. MongoDB hosting/version/topology remain unknown. The proposed fresh MongoDB 8.x target needs a separately reviewed supported ODM/driver combination; current Mongoose/driver majors remain unchanged. Package, lockfile, runtime pin, compiled start/alias and PM2 edits have not begun.
- **C3 / integration admission:** this increment owns a filesystem fixture, not a MongoDB replica set. The legacy pharmacy suite still imports application services before its weak name guard and can rebuild/drop its configured database. It was not executed. Implement independently owned disposable MongoDB resources and provider/file stubs, then prove admission before application imports before running any affected suite.
- **F01 exit:** clean install, type-check, build, compiled application start, a wired default assertion-running test gate and isolated CI/integration evidence are outstanding. The root `npm test` placeholder is unchanged.

Node's permission model is a guard for trusted code, not a malicious-code sandbox, and Node 22 does not supply network denial here. The staged suite contains only reviewed standard-library unit code. Do not use this runner to admit application imports or provider clients. [Official permission model and limitations](https://nodejs.org/docs/latest-v22.x/api/permissions.html).

Continue with the compatible target/ODM decision and owned MongoDB/provider test setup, then the remaining F01 build/start/default-test changes. Later money, clinical and authority slices retain their contract gates. No deployment, external credential action, real payment/message or M0 acceptance is authorized or performed by this increment.

## Second increment, 10 November: owned MongoDB fixture

Implemented the [fixture controller](../../../test/foundation/mongo-fixture.mjs), its simulated-transport unit tests and a separate [real smoke entry](../../../test/mongo/smoke.mjs), under the [C3 fixture contract](C3_MONGO_FIXTURE_CONTRACT.md). The controller captures a newly created container's full ID and per-run namespace; it revalidates daemon, ownership and isolation before start, database execution and removal. It rejects operational/remote overrides and does not adopt existing resources. The container has no external network, published host port or host volume, and uses bounded tmpfs storage. tmpfs is not a secure-erasure guarantee.

The unit runner now stages four fixed source files and runs two entries; it rejects each entry's empty-file fallback. It still imports no application/provider modules. Its controller tests use a fake Docker executor; the real smoke runs separately with an explicit local Unix socket and a digest-pinned, cached image.

| Final check | Observed result | Evidence |
| --- | --- | --- |
| Node 22.23.4 | 56 PASS; zero failures, skips, TODOs or cancellations | [TAP](../../../output/qa/m0-a/2026-11-10/node22-final.tap) |
| Node 24.19.0 | 56 PASS; zero failures, skips, TODOs or cancellations | [TAP](../../../output/qa/m0-a/2026-11-10/node24-final.tap) |
| Executable negative checks | 18 expected nonzero exits: failure/skip/TODO, either/both empty suites, bypassed preflight, symlinked source and the original image-snapshot regression, on both runtimes | [Canary manifest](../../../output/qa/m0-a/2026-11-10/negative-canaries-final.json) |
| Real local MongoDB 8.0.34 | Generated single-node replica set; committed record count 1, aborted record count 0; cleanup acknowledged | [Smoke result](../../../output/qa/m0-a/2026-11-10/mongo-smoke.json) |
| Cleanup readback | Same daemon; two specifically reported test IDs absent; zero remaining containers with the fixture-purpose label | [Independent readback](../../../output/qa/m0-a/2026-11-10/cleanup-verification.json) |
| Internal review | Standards APPROVE; Spec APPROVE, bounded increment only | [Separate review reports and dispositions](../../../output/review/m0-a-c3/REVIEW.md) |

The [dated verification manifest](../../../output/qa/m0-a/2026-11-10/verification.json) records current source and evidence hashes. The real check initially failed because mongosh did not supply the legacy `assert.eq` helper; diagnostics identified that defect. The corrected probe returns measured counts for Node assertions, includes four wrong-result regressions, and passed the real rerun. Earlier failures are retained in the verification record. Neither the mock transport nor the unit passes substitute for real transaction evidence.

Two code-review findings were corrected before the real run: empty required entries could falsely pass, and a getter could change an image between validation and creation. Both were reproduced or independently confirmed, covered by regressions, and closed in revised and final review. Final patch SHA-256: `3a7b2cd8533851e12abc8c23d1fe47dbf2c24eef85b313bdbb722c1200fb7e18`; ten-file snapshot in [final.json](../../../output/review/m0-a-c3/final.json). The reviews were by internal coding agents; no Claude/external review is claimed. No implementation commit has been made.

## Current next gate and remaining work

- **C2:** root packages, lockfile, runtime pin and startup/build edits remain untouched. The next concrete review is the [runtime/ODM decision packet](C2_COMPATIBILITY_REVIEW.md), with a [portable review prompt](C2_REVIEW_PROMPT.md). Current target facts remain partial. The packet proposes a supported local/CI investigation and identifies the missing intended-deployment facts; it is not an adopted database or migration decision.
- **C3:** owned MongoDB fixture lifecycle and its fixed transaction probe are evidenced. Application-child destination admission, provider/queue/timer/file stubs and pre-import isolation are still required. The fixed smoke controller does not admit arbitrary app/database clients. Legacy pharmacy/API suites remain unexecuted.
- **F01 exit:** clean install, root type-check/build, compiled application start, default assertion-running test command and isolated CI/application integration remain outstanding. The root `npm test` placeholder is unchanged.

The selected 115-scenario register remains **0 PASS, 1 FAIL, 1 BLOCKED, 110 NOT_RUN, 3 DEFERRED**. Foundation checks do not change those statuses. No operational databases, real providers, application startup, deployment, production migration or external account action were used. The frozen v1.7 and prospectus PDFs remain publication-time snapshots. The 100 RPS target has not been load-tested.

## Third increment, 10 November: static compatibility evidence

Active branch: `m0/f01-static-compatibility` in `nitianbit/SwasthaDisha`, base `b06be010c8bee7468eaaeb432952c787b300a5b4`. The owner selected retaining the existing server; [DevOps baseline fields](DEVOPS_BASELINE_REQUEST.md) remain pending. The local MongoDB 8 fixture is not a selected deployment target.

Internal technical reviews approved the narrowed static-only investigation. Implemented the [probe](../../../test/compatibility/static_mongoose.py) and five offline safety regressions, corrected review findings before public package installation, then ran the real restricted compiler comparison in owned temporary resources. No application modules, validations, queries or provider clients were executed.

- Same compiler/declarations: TypeScript 5.9.3 and @types/node 20.19.31 under Node 22.23.4. Eight actual source files plus the explicitly extracted normalizer and evaluation canary were checked.
- Mongoose 6.13.8: zero selected-source diagnostics. Mongoose 9.12.0: eight diagnostics in three migration groups (removed types, operation/session options, pre-validation hook). This is not a full backend build or runtime result.
- Both real compiler semantic negatives were rejected. Five offline controller regressions pass; the same regressions reject the original controller (three failures, one error).
- Temporary locks/metadata/configs/diagnostics are retained; owned resources were removed and independently checked absent. Root app/package hashes remain unchanged.

See [executed results and evidence](C2_STATIC_RESULTS.md). Root ODM/driver adoption, clean install/build/start and full C3 application admission remain gated. The 115-scenario statuses and 100 RPS acceptance remain unchanged. No deployment or M0 acceptance occurred.

## Fourth increment, 10 November: application sandbox candidate

Branch `m0/f01-app-isolation`, base `555bec4b4729fb14487bcfc48c40c53b6f85421f`. Implemented a local Node container controller, fixed-bundle admission, bootstrap, recording ports and a proposed pure-helper scenario. The candidate explicitly permits one owned read-only source bind on the previously recorded local Docker Desktop profile; it does not alter the existing no-host-mount MongoDB fixture. Root packages, startup/configuration and application source remain unchanged.

**Executed:** the expanded dependency-free gate passes **127** checks on Node 22.23.4 and 24.19.0. All four required entries run with zero skips/TODOs/cancellations. New application cases use fake Docker and synthetic bundles. Two positive runner controls and twenty expected negative rejections pass. Trusted bootstrap/scenario/launcher syntax checks are separate parser-only evidence. The public image manifest/index digest was verified without pulling the image.

**Review pending / NOT RUN:** any new real Docker call, image pull, container creation/start, real bootstrap/scenario, production search-helper runtime import or real sandbox cleanup readback. Unit checks do not establish actual egress isolation, real mount behavior, SDK coverage, full C3, domain acceptance or 100 RPS. Prior standalone runner snapshots are historical; this slice intentionally updates its staging guard/runner and retains all earlier test cases.

The genuine next gate is [first isolated smoke activation](C3_APP_ISOLATION_CONTRACT.md), with a [ready-to-paste review prompt](APP_ISOLATION_REVIEW_PROMPT.md). Review the exact new code/evidence before caching the image and running the fixed smoke. Approval would cover only that synthetic no-DB scenario and exact-ID/workspace cleanup proof; legacy entry points, DB clients, real SDK/provider callbacks and operational resources stay unadmitted.

C2 adoption still awaits the [retained-server baseline](DEVOPS_BASELINE_REQUEST.md). The selected 115-scenario register remains 0 PASS, 1 FAIL, 1 BLOCKED, 110 NOT_RUN, 3 DEFERRED. No generic M0-start approval is being requested again.
