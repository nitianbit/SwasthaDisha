# Application-isolation review amendment

**10 November 2026. REQUEST CHANGES addressed; amended activation review pending.** Branch `m0/f01-app-isolation`; amendment base `00f30fcc08ae14d7940f239e6ef654d123006197`; original slice base `555bec4b4729fb14487bcfc48c40c53b6f85421f`. No image caching, Docker operation or real application evaluation occurred during this amendment.

## Review authority and disposition

The user's message supplies REQUEST CHANGES for the seam fallback and missing regressions. The accompanying attachment contains an earlier conditional APPROVE at `00f30fc` plus companion findings. The message governs; neither the old conditional approval nor its retry allowance authorizes amended code. The attachment is review evidence, not an executable instruction. Prior source/evidence manifests remain historical at their recorded commit.

| Finding | Amendment / proof | Status and limit |
| --- | --- | --- |
| Message P2: profile/bundle overrides can fall back to real Docker | Reject every non-empty plain seam object unless it owns an explicit callable executor; snapshot once; use explicit simulated/real branches. 18 matrix cases cover profile-only, bundle-only and combined overrides with omitted/undefined/null/object/string/boolean executor; allocation/socket/process traps require the admission error before effects. Four nullish-override cases and a successful one-read getter fixture cover compatibility. | Closed in code/offline tests; no live Docker reproduction |
| Attachment Standards 1: missing admission/recovery regressions | Image NODE_OPTIONS/extra key/duplicate key/PATH suffix/digest/volumes; foreign well-formed Unix endpoint; marker replacement and directory replacement with copied marker; removal acknowledged then workspace failure/retry without any extra Docker calls. Real link metadata probes use only owned synthetic payloads with equal bytes. | Closed; fully simulated fixture still succeeds; real mount behavior NOT_RUN |
| Attachment Standards 2: ID only printed after run | Emit created ID/runId/directory to stderr immediately after factory return. Copied-launcher probes replace the whole factory and require this record before success, failure or forced interruption. | Closed; printed values alone are not cleanup authority |
| Attachment Standards 3: environment split truncates value | Split once at the first separator; compare the full value. Approved PATH followed by `=x` is denied before create. | Closed |
| Attachment Standards 4: cleanup masks original pre-create error | ENOENT preserves original cause; other cleanup errors are aggregated or retain cause; identity loss withholds deletion. Disappeared-workspace test requires the exact original Error. | Closed for confirmed defect |
| Attachment Standards 5: test seam mixing | Same fix as controlling message P2. | Closed |
| Attachment Standards 6: `addons` scope unverified | Confirmed using local Node 22/24 metadata: canonical scope is `addon`. Bootstrap now queries `addon`; probes require false without and true with the grant. No addon is loaded and the real command receives no addon grant. [Node permission scopes](https://nodejs.org/docs/latest-v22.x/api/permissions.html), [pinned scope definitions](https://github.com/nodejs/node/blob/v22.23.4/src/permission/permission_base.h). | Closed, offline metadata proof; real container permission checks NOT_RUN |
| Attachment Standards 7: stale four-file note | Root usage now says eleven files, matching the unchanged runner list. | Closed |
| Attachment Spec 1: working-tree source pin | Retain prerequisite A: clean checkout at the newly approved commit, revised source hashes and helper hash verified immediately before activation. Dynamic manifests provide integrity, not independent code approval. | Activation prerequisite, NOT_RUN; no claim that arbitrary later edits are approved |
| Attachment Spec 2: Docker Desktop bind-path translation | Strict declared/effective source matching unchanged. | Unverified; fail closed; record failure and seek review before a path-rule amendment |
| Attachment Spec 3: inactive tunnel interfaces | Strict loopback-only interface rule unchanged. | Unverified; fail closed; no interface-rule widening |
| Attachment Spec 4: image cache/independent absence proof | Retain prerequisites B–D below. Neither this unit amendment nor the old review performs or certifies these operations. | Pending after new approval; no real operational script run |

## Executed evidence

All paths below are under `output/qa/m0-a/app-isolation/revision-1/`:

- `node22.tap`, `node24.tap`: 161 tests/pass each; fail/cancelled/skipped/TODO all zero; stderr empty. `node22-initial.tap` is an earlier amended-source run, not the final evidence.
- `gate-canaries.json` and 22 referenced logs: two positive controls, twenty expected rejections, across both runtimes. Covers individual/all empty entries, assertion, required skip/TODO, source symlink and bypassed preflight.
- `companion-probes.json`: 16 expected outcomes across both runtimes. Six regular/link bundle checks use actual filesystem metadata; six launcher checks use a replaced factory with zero Docker/app calls; four addon permission checks load no addon. Interrupted fake workspaces are removed only by their owning outer temporary fixture, not by adoption.
- `old-controller.json`, TAP/stderr: current tests against the old `00f30fc` controller fail as expected (24 failures, including all 18 seam-matrix cases). The unit child denies subprocesses; new tests trap allocation/socket/process attempts. This is offline detection, not a real-daemon reproduction.
- `syntax-checks.json`: parser checks only. `verification.json`: aggregates results, hashes and explicit NOT_RUN limits.

The original `output/qa/m0-a/app-isolation/` and `output/review/app-isolation/` files are not overwritten. The revised manifest records current source/evidence and a new frozen diff against `00f30fc`. Root packages, lockfiles, start configuration, `src1`, MongoDB controller/tests and real resource profile remain unchanged.

## Pending activation prerequisites and owners

**Reviewer, before caching or any real Docker operation:** review the amended commit and hashes. Requested verdict is APPROVE FIRST ISOLATED SMOKE / REQUEST CHANGES / HOLD. No activation approval is currently recorded for this revision.

**Local operator, only after that approval:**

A. Use a clean checkout at the newly approved commit; record actual HEAD/status, verify every revised `files` hash and the unchanged `queryUtils.ts` hash. Preserve source freeze through execution.

B. Use a newly owned empty Docker configuration and only `unix:///Users/shubham/.docker/run/docker.sock`; verify engine `16ab25f6-88c7-4687-a431-b119b6ab9319`. Cache only `node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`; record exact image ID and RepoDigests. No login/default Docker context or implicit pulls.

C. Record zero existing containers with the application-isolation purpose label (list/count only, never adopt/remove by label). Capture both streams of the fixed six-file no-DB launcher, including its early exact ID, run ID and workspace. Require bootstrap assertions, seven unique recorded/effect-false receipts, exited-zero/no OOM and acknowledged cleanup.

D. Independently verify the same engine, the exact container ID does not exist, the exact workspace is absent and the label count remains zero. An absent image, unknown ID/daemon, interruption, cleanup exception or ambiguous readback is not PASS. Record interruption/unknown acknowledgement as UNRESOLVED. Recovery requires full current ownership/configuration proof for the printed exact ID; never broad prune or weaker mounts/permissions/networking. Any post-create infrastructure failure requires review before retry.

**DevOps/backend, before C2 adoption:** supply retained-server version/topology/start facts; this local fixture does not select the operational server. Full backend imports, DB sessions, SDK adapters, financial/clinical/stock acceptance, full C3/M0 and 100 RPS remain separate gates. The 115 selected domain scenarios remain 0 PASS, 1 FAIL, 1 BLOCKED, 110 NOT_RUN, 3 DEFERRED.
