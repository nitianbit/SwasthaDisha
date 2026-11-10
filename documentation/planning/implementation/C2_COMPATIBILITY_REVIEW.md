# C2 runtime and ODM decision packet

**10 November 2026. Status: STATIC INVESTIGATION COMPLETE; target and root migration not adopted.** This is the next decision gate before root dependency, lockfile, build/start or runtime-pin edits. It does not request another general M0 start approval. The existing [deployment baseline](../M0_DEPLOYMENT_BASELINE.md) and [C2 condition](../M0_START_APPROVAL_STATUS.md#c2-deployed-baseline-before-script-or-dependency-changes) remain authoritative.

## Current decision, 10 November 2026

The owner selected **retain the existing server; DevOps will provide its details**. A new managed MongoDB deployment is not selected. MongoDB 8 remains a local test fixture/candidate only; the proposed fresh target below is not evidence about that server.

Two internal technical reviews approved a **static-only compatibility investigation** under existing M0-A authorization. This permits owned, script-disabled public dependency installation and direct noEmit analysis of a reviewed source closure. It does not permit application module evaluation, database/provider connections, root adoption or startup. Current and candidate major lines in the root remain unchanged.

The [probe usage contract](../../../test/compatibility/README.md) describes the eight source files, workspace-only normalizer extraction and compiler controls. Deployment facts still gate the affected root changes; the [DevOps baseline handoff](DEVOPS_BASELINE_REQUEST.md) lists the exact missing fields. The earlier external Review-A/Review-B approvals are not being replaced by these internal investigation reviews.

The [executed comparison](C2_STATIC_RESULTS.md) records a clean selected-source baseline and eight candidate diagnostics across three migration groups. Root adoption still waits for the existing-server baseline and reviewed migration contracts/diff.

## Original proposal to investigate

Review a fresh local/CI target using **Node 22.23.4, a digest-pinned MongoDB 8.0 replica set, and a supported Mongoose major**. Prefer a bounded compatibility investigation of current Mongoose **9.12.0**, proceeding through the documented 6→7→8→9 migration steps. Compare **8.24.8** as a temporary bridge if measured impact makes 9 unsuitable for this foundation slice. Neither option is a drop-in upgrade. Select one exact root candidate only after that investigation and review its actual package/lock/source diff separately.

This recommendation favors a supported long-term line for a pre-launch product. It is an engineering recommendation, not a result from application tests. Do not infer the required source effort from the number of textual matches.

## Facts and limits

| Item | Observed or reported | Meaning for this decision |
| --- | --- | --- |
| Release state | Owner: pre-launch, no real patients/payments | No urgent live-service branch is selected; containment still precedes live use |
| Owner target | Node major 22, `pm2 start server`, Mumbai | Exact deployment resolution, MongoDB hosting/version/topology and supported client revisions remain unknown |
| Local tool | Checksum-verified Node 22.23.4 | Used for foundation checks; no production pin adopted |
| Root ODM/driver | Manifest Mongoose `^6.6.2`; lock 6.13.8 with driver 4.17.2 | Existing stack unchanged; Node 22 support and proposed MongoDB 8 compatibility need resolution |
| Local DB fixture | MongoDB 8.0.34, digest in `test/mongo/image.json`; commit/rollback measured | Fixture-only evidence; not application compatibility or proof of a Mumbai deployment |
| Build/start | `tsc`; `nodemon server.js`; compiled output `dist`, aliases `@/*` | Resolve compiled aliases and reconcile PM2 entry point after C2 review; do not start either current entry point |
| Manifest consistency | `xlsx` declared but missing its lock entry; obsolete `@types/mongoose` declared | Review controlled lock repair and bundled types; no unrelated upgrades |

The current driver matrix does not list driver 4.x with Node 22 as supported. The Mongoose table lists 8.7+ or 9.x for MongoDB 8.x. These are support facts, not reproduced application failures. [MongoDB driver matrix](https://www.mongodb.com/docs/drivers/compatibility/?driver-language=javascript&javascript-driver-framework=nodejs), [Mongoose server matrix](https://mongoosejs.com/docs/compatibility.html).

Mongoose identifies 9 as current and 6 as limited maintenance, ending 1 February 2027. Its support page's stated minimum window for 8 is already past; do not promise a new future maintenance window for that bridge. [Mongoose support policy](https://mongoosejs.com/docs/version-support.html).

## Candidates and concrete source impact

Public npm metadata inspected on 10 November lists 9.12.0 requiring Node ≥20.19.0 and depending on driver `~7.8`; 8.24.8 depends on `~6.20.0`. These are declared ranges, not a newly resolved lockfile. [9.12.0 package metadata](https://registry.npmjs.org/mongoose/9.12.0), [8.24.8 package metadata](https://registry.npmjs.org/mongoose/8.24.8). Revalidate support and integrity when installing the chosen candidate; no packages were installed for this packet.

| Candidate | Known migration surface | Required decision |
| --- | --- | --- |
| 9.12.0, preferred investigation | All 6→7→8 changes, plus callback pre-hook removal and `FilterQuery` rename | Determine actual type/runtime repairs, preserve required semantics, review before root adoption |
| 8.24.8, bridge only | Still crosses 6→7→8; avoids the additional 9 changes | Accept only with a named owner and exit milestone for the bridge; verify maintenance/security suitability |
| Existing 6.13.8 | Least immediate source change; does not resolve the proposed supported target | Retain during investigation; do not describe it as the approved Node 22/MongoDB 8 stack |

Confirmed source examples, not an exhaustive migration audit:

- `src1/modules/common/repository/BaseRepository.ts` imports `LeanDocument`, uses generic filters, returns lean reads and `toObject()` saves, passes sessions on some operations, and defaults updates to the returned new document. The 7 migration removes `LeanDocument`; this shared interface needs an explicit replacement contract rather than casts that hide errors.
- `src1/modules/blogs/repository/index.ts` and the base repository use `FilterQuery`, renamed in 9.
- `src1/modules/pharmacyMedicines/model/index.ts:84` has a `pre('validate', function(next))` hook that derives the medicine name key. Preserve normalization and the unique partial index when changing the hook for 9.
- `src1/index.ts` imports queue consumers and starts other effectful components; both it and configuration load `.env`. The current DB module reads operational configuration. None is admitted by the current fixture controller.

The migration guides describe query defaults and callback changes in 7, result/validation changes in 8, and middleware/filter changes in 9. [6→7](https://mongoosejs.com/docs/migrating_to_7.html), [7→8](https://mongoosejs.com/docs/migrating_to_8.html), [8→9](https://mongoosejs.com/docs/migrating_to_9.html).

## Proposed next slice and exit evidence

1. Record whether the reviewed target is fresh local/CI only or also the intended future deployment. Backend/DevOps must resolve hosting, server version/topology, exact PM2 script/working directory and relevant client revisions before affected root edits; no operational connection or guessed server facts.
2. Approve the scope of an isolated compatibility investigation. Stage only reviewed pure model/repository code or synthetic contracts in a fresh owned workspace. Dependency downloads must use public metadata, an owned cache, exact versions/integrities, no inherited npm credentials and no lifecycle scripts. Installation must not execute application startup.
3. Before any model import that can connect, implement and test application-child admission: derive the destination from the owned resource; constrain network/files/provider access; stub queues, timers, payment/SMS/call/storage clients; prohibit `.env` fallback. The current MongoDB controller deliberately offers no arbitrary application connection API. Do not weaken it to run existing suites early.
4. Use disposable fixtures to compare legitimate success and rejection behavior: lean/save return shapes, filters and empty/unknown-field queries, ObjectId/enum validation, medicine normalization/index conflicts, update result/options, sessions, transaction rollback and retry boundaries. Contract expected behavior explicitly; do not preserve a known unsafe query merely for parity. Required skips block acceptance.
5. Submit exact root package/lock/source repairs with install/type-check/build/compiled-start and compatibility evidence. Remove obsolete types only when replacement types compile. Keep unrelated dependency churn out; retain a reproducible baseline and rollback to the unshipped candidate branch. No production migration is included.

The 100 RPS target needs a later representative load test; a single-node local transaction probe establishes no throughput or availability claim. Full C3, F01 exit, security/financial/clinical gates and pilot acceptance remain open.

## Review response required

State **APPROVE INVESTIGATION**, **REQUEST CHANGES**, or **BLOCKED BY A NAMED FACT**. Separately decide the proposed local/CI target, the preferred ODM investigation candidate, the missing intended-deployment facts, and the evidence needed before root adoption. Name the owner/latest gate of each unresolved item. Approval of this packet alone must not be reported as approval of an unseen root migration diff or deployment.
