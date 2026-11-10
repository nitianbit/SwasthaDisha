# Owned API platform: review and evidence

10 November 2026. Baseline `1b0a54144d514bd73f03a99724c8b0d02fcfa25a`; root authored the shared contract and platform code. This is a new focused test-only runtime candidate; the old fixture controllers, root dependency/start files and scenario register remain unchanged.

## Independent pre-reviews

Both nonauthors inspected contract SHA-256 `73301872982a0f79fa805538f679c08e53ce6ef0528790cc75144ed7e2a7d0ee` before code:

| Reviewer | Decision | Scope |
| --- | --- | --- |
| `/root/backend_boot_path` | APPROVE_LOCAL_CI_PROFILE_AND_IMPLEMENTATION | Standards/safety; concrete two-resource ownership/isolation and distinct local supported profile |
| `/root/local_claude_review_prep` | APPROVE_LOCAL_CI_PROFILE_AND_IMPLEMENTATION | Spec; actual production behavior, candidate/runtime/type/root-adoption limits and exact later execution gates |

These new decisions do not reuse static-only C2 approval as runtime authority. They permit implementation only; no package preparation or real application/Docker invocation is recorded here.

## Executed offline evidence

`env -i PATH=/usr/bin:/bin TMPDIR=/private/tmp /private/tmp/m0-node22/node test/api-runtime/unit.mjs` passes **51** dependency-free cases with zero failures, skips, cancellations or TODOs. The fixed runner stages four regular source files into a newly owned workspace and launches a child with filesystem access limited to that workspace, no child/worker/addon grants and a clean environment. The explicit fake executor/template must be supplied; no fake seam falls through to real Docker.

Cases exercise two-resource lifecycle/shared-network relationship, exact namespace/actor/config/mount/limit drift, ambiguous creation, source coverage/ownership, required assertions, source identity, mutation sensitivity and safe provider summaries. Neither Docker, MongoDB, application modules nor SDKs run. TAP, stderr source hashes and the command/limits are retained in this directory. The initial absolute test-entry invocation reported file-not-found before any tests; a fixed relative entry matching the existing foundation runner resolved that observed failure, with no grant expansion.

The actual scenario/preparation worker implements the fixed runtime template separately. Before real execution its exact source, dependency/lock, compiler diagnostics, closed IO map, template and full invocation require two further nonauthor decisions. All HTTP/JWT/race/provider/database and full-server acceptance remain unrun. Only the prior separately archived no-DB helper smoke has actual runtime acceptance.

## Implementation review

The initial 32-case candidate received REQUEST_CHANGES from both `/root/backend_boot_path` (Standards) and `/root/local_claude_review_prep` (Spec). Both independently reran its fake-only gate. Standards found missing independent cleanup proof and raw extra result fields. Spec additionally found missing Mongo process/OOM liveness. Initial source, evidence and pre-amendment record remain under `revision-1/`.

Revision 2 closes those findings: after each exact owned-ID removal it requires successful independent `ps` absence and same-engine proofs before proceeding, then zero purpose labels and workspace ENOENT. Unavailable/stale proof preserves the workspace and latches UNRESOLVED to withhold automatic retry. Result/case/sensitivity schemas and reviewed provider key names are closed; invalid JSON returns a fixed error without echoing raw text. Mongo must be running without OOM at readiness, before Node creation/start and at final acceptance. Cleanup still requires ownership, not healthy process state.

The amended 51-case frozen source is now submitted for direct nonauthor confirmation. No real preparation/application/Docker authority follows from this record.


The first amended platform `a3e8b0dc…` received `/root/backend_boot_path` APPROVE_SOURCE_ONLY after an independent 51-case run. A producer/consumer protocol check then found the scenario descriptor also binds its six preparation/scenario files, the pure network helper and root lock. Parent validation now accepts exactly those eight additional source paths, each with current-byte SHA checking; arbitrary test/config/home paths stay rejected. The amended final hash is in verification.json and needs both reviewers' confirmation; the prior decision is not silently extended.


## Final revision-2 decisions

Both direct internal nonauthor reviewers approved final platform `05c11565c2b93e8ef24e5a2a5824bb7daf23471611590cc62f65d3046620b5db` as **APPROVE_SOURCE_ONLY / OFFLINE_ONLY**. `/root/backend_boot_path` independently ran all 51 checks on the preceding amendment and statically confirmed the final exact eight-path allowlist delta. `/root/local_claude_review_prep` independently ran all 51 checks against the final candidate. Tests `60cdddeb1adb20a59c1de108d43be62bb35713d12d3b5d4b14b650221ffa03a9` and runner `541289ce4d86e801a01f6cb089d0253a660bc692691c00a3d87926b33a345f60` are the reviewed versions. Both reviewers explicitly withheld preparation/scenario/real invocation/full-server approval.

These are internal Codex reviews from actual native agent messages, not Claude model or named-owner/release approval. All real API cases remain NOT_RUN at this source commit.
