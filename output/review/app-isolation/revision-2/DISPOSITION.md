# Diagnostic candidate after the first smoke failure

**10 November 2026. Offline candidate complete; runtime review required.** Base `58980c698bdfcdee5b2eb68d5c8a7577e6758e4d`, branch `m0/f01-app-isolation`. The first smoke at `de1693e` remains FAIL with independently verified cleanup. This increment makes no Docker call or runtime retry.

| Issue | Candidate and evidence | Remaining limit |
| --- | --- | --- |
| Extra sysfs entries caused strict guard failure | Replayed the exact original guard: captured/minimal-extra listings fail, loopback control passes. Added a bounded diagnostic before the same assertion. Ten current network-block checks use the actual extracted block with fake readers, including active/unavailable cases. | No interface is newly admitted. Actual type/flags/state/addresses remain NOT_RUN; routes and namespace provenance are not captured. |
| Missing data for safe diagnosis | Capture lstat entry kind and flags/operstate/type beneath the existing sysfs grant, plus selected assigned-address fields from the OS API. Sixteen entry names, validated paths/ports, sanitized unavailable codes, 8-KiB JSON bound plus newline. | An unavailable field remains unknown. Address-only evidence cannot exclude unaddressed devices. No blanket allowlist or interpretation as harmless. |
| Nonblocking gap before launcher resource log | Controller synchronously writes created ID/run/workspace immediately after full ID validation, before post-create info/inspect. Optional simulated reporter requires the same explicit callable executor and is validated before allocation. Launcher duplicate removed. | Unknown create acknowledgements/interruption before ID capture still remain unresolved. A printed record is not ownership or admission proof. |
| Diagnostic truncation in Docker error | Bounded failure text increased from 2,000 to 16,384 characters. Extracted realDocker-body probes replace every sink and preserve a full synthetic 7-KiB diagnostic while checking the cap. | Full real transport and diagnostic delivery NOT_RUN for this candidate. |

Runtime grants, Node command, create options, image/profile, six bundle filenames, eleven unit-staged files and four required test entries are unchanged. Root package/lock/start, `src1`, MongoDB fixture and scenario/port source are unchanged. No new dependency, route-table access, host mount, backend/DB/SDK import or provider operation.

Executed evidence under `output/qa/m0-a/app-isolation/revision-2/`:

- Final `node22.tap` / `node24.tap`: 185 passes each; zero failures, skips, TODOs or cancellations; stderr empty. The preliminary 180-case run and test-first failing run are historical stages, not final results.
- `gate-canaries.json`: 22 runner controls, two positive and twenty expected rejections.
- `companion-probes.json`: 20 owned-link/copied-launcher/addon-metadata checks. The entire launcher factory is replaced in those probes; interruption fixtures are removed by their owning outer directory.
- `network-block-probes.json`: ten checks execute only the extracted network block with synthetic read-only readers, not bootstrap initialization or application modules. Captured interface names are real historical evidence; all flags/state/address values supplied here are synthetic.
- `controller-offline-probes.json`: ten extracted emitter/realDocker-body checks with all filesystem/process sinks replaced. No real executor is called.
- `old-controller.json`: the old controller fails eight early-reporting regressions. `old-bootstrap-probe.json`: the old block fails the required-diagnostic-record assertion. Neither is a live Docker reproduction.
- Eight parser-only checks; three original-guard replay controls. The replay's adjacent two-line recipe belongs to the base snapshot; the instrumented current block is covered separately.

[Contract](../../../../documentation/planning/implementation/APP_NETWORK_DIAGNOSTIC_CONTRACT.md), [review prompt](../../../../documentation/planning/implementation/APP_NETWORK_DIAGNOSTIC_REVIEW_PROMPT.md) and `review-input.json` define the exact candidate. Current source/evidence hashes and the frozen diff must match before approval. Earlier artifacts remain frozen at their recorded commits; current status docs intentionally differ.

Requested decision: **APPROVE ONE DIAGNOSTIC-ENABLED SMOKE / REQUEST CHANGES / HOLD**. The reviewer must assess the recorded failure and this concrete amendment together. No prior post-failure review or new runtime approval is claimed. If approved, use the same recorded engine, already-cached pinned image, fixed six-file no-DB entry and A–D source/baseline/cleanup checks. No new pull or scope widening is requested. On the known listing another FAIL is expected, with diagnostics; record it as such and obtain review before any further change/retry. The callback reporting record does not grant cleanup authority.

The original network problem is not fixed by this candidate. The pending step is evidence collection under unchanged admission, allowing a justified later decision. Retained-server C2, root build/start, full backend/DB/SDK integration, domain scenarios, full C3/M0 and 100 RPS remain separate.
