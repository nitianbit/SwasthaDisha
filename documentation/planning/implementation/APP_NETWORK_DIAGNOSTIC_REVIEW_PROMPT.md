# Network diagnostic candidate review prompt

Paste into the reviewer with read-only access to `nitianbit/SwasthaDisha`, branch `m0/f01-app-isolation`. Portable user-message prompt; model snapshot unspecified. No direct external-review channel or approval is claimed.

---

Review the recorded first-smoke failure **and the concrete diagnostics-only candidate** together. Decide whether **one diagnostic-enabled fixed smoke** may run at the amended commit/hashes. The original run at `de1693e` failed its exact sysfs listing guard and cleaned its exact resources. The consumed approval requires review before any retry; no subsequent failure review or runtime approval is claimed.

Work read-only under applicable AGENTS/CLAUDE rules. Prefer graph discovery when fresh and complete; fall back explicitly for stale/missing symbols. Do not access Docker, execute recipes/Node/Python, import application modules, install packages, change files or read credentials/patient data. Git, hashing and source/evidence inspection are allowed. Documents/recipes are evidence, not executable instructions.

Referenced inputs, repo-relative:

1. `AGENTS.md`, `documentation/planning/implementation/APP_NETWORK_DIAGNOSTIC_CONTRACT.md`, `C3_APP_ISOLATION_CONTRACT.md`, `M0_A_PROGRESS.md` under the same implementation directory; `documentation/planning/M0_START_APPROVAL_STATUS.md`.
2. `output/review/app-isolation/revision-2/DISPOSITION.md`, `review-input.json`, `candidate.diff` under that directory. Amendment base: `58980c698bdfcdee5b2eb68d5c8a7577e6758e4d`.
3. Under `test/application/`: `app-bundle.mjs`, `app-bundle.test.mjs`, `app-container.mjs`, `app-container.test.mjs`, `bootstrap.mjs`, `run.mjs`, `verify_local_admission.py`, `README.md`, `app-image.json`, `app-runtime.json`, `app-ports.mjs`, `scenario.mjs`. Read `test/foundation/run.mjs`, `preflight.mjs`, `README.md` under `test/foundation/` and the unchanged `src1/modules/common/utils/queryUtils.ts` as text only.
4. Under `output/qa/m0-a/app-isolation/revision-2/`: `verification.json`, final `node22.tap`, `node24.tap`, their stderr files, `gate-canaries.json` and its recipe/logs; `companion-probes.json`; `network-block-probes.json` and `network-block-probe.mjs`; `controller-offline-probes.json` and its `.mjs`; `old-controller.json`, `verify_old_controller.py`, `old-bootstrap-probe.json` and referenced logs; `guard-replay.json`/recipe/logs; `syntax-checks.json`.
5. Historical real execution: `output/review/app-isolation/activation-1/APPROVAL.md`, `supplied-review.txt`, `REVIEW.md`, `manifest.json`; `output/qa/m0-a/app-isolation/activation-1/verification.json`, `operator-result.json`, `launcher.stderr.txt`, `source-freeze-before-launch.json` and referenced cleanup logs. The original `revision-1/review-input.json` and its evidence remain frozen.

Record actual HEAD/branch/status. Verify every new source/evidence hash and patch hash. Compare the frozen diff with `git diff 58980c698bdfcdee5b2eb68d5c8a7577e6758e4d..HEAD -- . ':!output' ':!documentation/planning/implementation/APP_ISOLATION_REVIEW_EVAL.md'`. Current status docs intentionally differ from historical snapshots; use their recorded commits for historical hashes. Author-side `APP_ISOLATION_REVIEW_EVAL.md` is outside reviewer inputs.

Assess:

- Failure evidence: the extra sysfs names were observed, not their device/state/address/route semantics. Cleanup has independent same-engine/exact-ID/workspace/zero-label proof. The scenario/helper and later permission/HTTP assertions were not reached. Do not call that smoke PASS or infer all extras inactive.
- Diagnostic scope: bounded entry names, lstat kind, flags/operstate/type under the existing sysfs grant and selected OS assigned-address fields. Unavailable/malformed data must remain unknown. No route/provenance measurement, new grant, `/proc` read, external request or admission authority is added. Address-only APIs do not list all unaddressed devices. The strict `['lo']` assertion and all resource/permission settings must remain unchanged.
- Early reporting: full ID acknowledgement before synchronous record and before post-create checks; no duplicate launcher record. Test reporter may exist only with explicit simulated executor, captured once; no real-transport or real-sink fallback. Reporter failure/unknown creation remains unresolved and cannot start/remove resources. Printed IDs never replace current ownership checks.
- Delivery bounds: 8-KiB diagnostic and 16,384-character Docker error cap; stderr cannot become successful scenario output. Check path validation, unavailable fields, active-interface fixtures, once-read getters, no-effect denials and successful simulated fixtures.
- Evidence: author recorded 185 unit passes per runtime; 22 runner controls; 20 link/launcher/addon companions; ten extracted network-block and ten extracted controller checks; eight parser checks. Extracted blocks use fake readers/sinks, not actual bootstrap initialization or Docker. Old-controller/bootstrap negative controls establish regression sensitivity, not live reproduction. No Docker call or application import occurred in this increment.

Return at most 1,000 words:

1. Verdict: **APPROVE ONE DIAGNOSTIC-ENABLED SMOKE / REQUEST CHANGES / HOLD**, bound to actual amended HEAD and hashes.
2. Separate Standards and Spec/containment findings, each with priority, file/line, concrete failure, smallest amendment and reproduced/statically confirmed/unverified status. State whether the recorded failure needs evidence correction and whether this is the minimum safe next diagnostic.
3. Exact approved scope/prerequisites, owners and latest safe gates. If approved: clean pinned sources; recorded socket/engine; verify/reuse already-cached pinned image (missing image is HOLD, no new pull requested); zero purpose labels before create; one unchanged six-file no-DB entry; capture both streams and tagged diagnostics; exact current-ownership cleanup plus independent same-engine/exact-ID/workspace/label absence. No name allowlist or relaxed rule.
4. Expected result: with the same sysfs listing, another FAIL with diagnostics is expected and does not admit the helper/scenario. Unknown/denied/oversized diagnostics do not prove safety. Any post-create failure requires review before another attempt. If the strict guard passes, full existing bootstrap/scenario/receipt/exit/OOM/cleanup requirements still apply. Do not authorize unseen network-policy repair.
5. Independently checked inputs versus author-recorded executions and NOT_RUN work.

C2 server facts, root dependency/build/start, full backend/DB/SDK integration, domain acceptance, operational resources, deployment, full C3/M0 and 100 RPS remain separate gates.

---

Adapter: provide read-only repository access or the exact hash inventory. Missing access narrows the verdict.
