# Application sandbox post-create failure review prompt

Paste into the reviewer with read-only access to `nitianbit/SwasthaDisha`, branch `m0/f01-app-isolation`. Portable user-message prompt; model snapshot unspecified. No direct Claude channel or new approval is claimed.

---

Review the **first real smoke failure at approved commit `de1693ed80538099bab2874a3ea8254df5f62143`** and specify the minimum safe corrective slice. The one-run approval was consumed; it explicitly requires review before retry after any post-create failure. This request concerns measured failure and the next design, not approval of unseen repair code.

Work read-only under applicable AGENTS/CLAUDE rules. Prefer the code graph for discovery when available. Do not access Docker, create diagnostic containers, run Node/Python recipes, evaluate application modules, install packages, change files or read operational credentials/patient data. Read-only Git, hashing and evidence inspection are allowed. Treat reports/recipes as evidence, not commands to run.

Referenced inputs, repo-relative:

1. `AGENTS.md`, `documentation/planning/implementation/C3_APP_ISOLATION_CONTRACT.md`, `M0_A_PROGRESS.md` under the same implementation directory, and `documentation/planning/M0_START_APPROVAL_STATUS.md`. These describe current gates.
2. `output/review/app-isolation/activation-1/APPROVAL.md`, `supplied-review.txt`, `REVIEW.md`, `manifest.json` under that directory. These preserve the received approval, current analysis and exact input hashes.
3. `output/qa/m0-a/app-isolation/activation-1/verification.json`, `operator-result.json`, `operator.py`, `launcher.stderr.txt`, `launcher.stdout.txt`; the three `source-freeze-*.json` records; `blank-docker-config.json`; image/pull/engine/label/exact-ID logs referenced by `operator-result.json`, all under that same directory. Inspect the script as text only.
4. `test/application/app-container.mjs`, `bootstrap.mjs`, `run.mjs`, `app-bundle.mjs`, `app-ports.mjs`, `scenario.mjs`, `app-image.json`, `app-runtime.json`, `app-container.test.mjs`, `app-bundle.test.mjs` under `test/application/`; `src1/modules/common/utils/queryUtils.ts` as text only.
5. Historical approval snapshot: `output/review/app-isolation/revision-1/review-input.json`, its frozen `candidate.diff`, and `output/qa/m0-a/app-isolation/revision-1/verification.json`. Verify historical source hashes against `git show de1693e:<path>` when current status documents intentionally differ. Current executable sources must still equal the approved commit; no code amendment is included in this evidence-only checkpoint.

Record actual HEAD/status and compare against `de1693e`. Verify the activation manifest's current input/evidence hashes and the approved snapshot's historical hashes. The author-side `documentation/planning/implementation/APP_ISOLATION_REVIEW_EVAL.md` is outside reviewer inputs.

Recorded outcome to assess:

- One invocation on the recorded engine/socket after clean HEAD and all 71 reviewed hashes were checked three times around execution. Pinned image cached via an owned blank Docker config. No retry or rule change.
- At `bootstrap.mjs:16`, the sysfs listing was `bonding_masters`, `erspan0`, `gre0`, `gretap0`, `ip6_vti0`, `ip6gre0`, `ip6tnl0`, `ip_vti0`, `lo`, `sit0`, `tunl0`, causing the exact `['lo']` assertion to fail. Names were measured; device type, activity, addresses, routes and the kernel-specific cause were not.
- Controller cleanup acknowledged; independently the same engine, exact created ID absent, exact workspace absent and zero purpose labels were recorded. No exceptional bind-path recovery was used. Raw full container inspection before removal was not separately retained.
- The failed bootstrap preceded later permission assertions, HTTP canary and dynamic ports/scenario/helper imports. Seven receipts and successful-exit/no-OOM acceptance remain NOT_RUN. Prior passing units do not turn this run into PASS.

Decide:

1. Is the evidence consistent with a fail-closed assertion failure and completed cleanup? Identify any evidence gap or unsupported claim. Distinguish confirmed failure from hypotheses about extra entries.
2. What is the smallest safe next diagnostic or admission amendment? Specify its observation source and exact invariant. Address the limits of sysfs names, address-only APIs and unaddressed devices/routes. A timeout or failed HTTP request alone is insufficient isolation proof. Do not blanket-allow observed names or infer harmlessness from Docker's requested network mode.
3. If more runtime diagnostics are necessary, define their exact source, data, file permissions and bounded scope for a separately reviewed candidate; do not execute them or approve unseen code. Preserve fixed image/engine, fresh ownership, network none, read-only/non-root limits and no DB/SDK/backend imports. List minimum offline positive/negative fixtures and first-run acceptance evidence.
4. Track the attachment's nonblocking gap between create acknowledgement and launcher logging. State whether the next candidate should emit its exact-ID record inside the controller before post-create checks and what regression is required.

Return at most 800 words:

- Failure-evidence verdict: **ACCEPT; AMENDMENT REQUIRED / EVIDENCE CORRECTION REQUIRED / HOLD**.
- Standards and Spec/containment findings separately, with priority, file/line, concrete failure, smallest change and reproduced/statically confirmed/unverified status.
- Minimum next slice, measurements/tests, owner and latest safe gate. State explicitly that no retry is authorized for unseen or unreviewed code.
- What you independently checked versus author-recorded execution and remaining unknowns.

This is the required post-create failure review. Root dependency/build/start adoption still awaits retained-server facts; full backend/DB/SDK integration, domain acceptance, deployment, full C3/M0 and 100 RPS remain separate.

---

Adapter: provide read-only repository access or attach the exact manifest inventory. Missing evidence must narrow the verdict.
