# Static compatibility investigation: review and disposition

**10 November 2026.** Internal coding-agent reviews under the development/review cycle. These are not external Claude or the project's earlier named Review-A/Review-B. Fixed base `b06be010c8bee7468eaaeb432952c787b300a5b4`; branch `m0/f01-static-compatibility`. Final eleven-file source diff: [final.diff](final.diff); source/evidence manifest: [final.json](final.json). Patch SHA-256 `9b323b6a766f8335f08469f67bc96f8dc0abf99cb8998ca80269cd2afe6a353d`.

## Investigation entry decision

Both internal technical reviewers approved the narrowed investigation before execution: public metadata, script-disabled installation in owned temporary resources, and static TypeScript analysis under the existing M0-A permission to investigate. Root adoption was excluded. The owner chose retaining the existing server; unknown deployment facts were not presumed. Code review followed before the first download. The revised controller received approval after initial findings were corrected and the required offline regressions were planned; those regressions passed before the actual comparison ran.

## Standards

**Standards verdict: APPROVE** for the completed static investigation slice.

**Violations and smells:** No blocking standards violations or actionable Fowler smells found. The five offline regressions test meaningful controller failures and contain simulated operations inside owned outer fixtures. Saved evidence shows all five pass and reject the original controller with three failures and one error.

Verified all 11 source hashes, 26 evidence hashes, 15 guarded root hashes and patch SHA `9b323b6a…e6a353d`. Saved locks match exact top-level package metadata. Both compiler configurations use `noEmit`; recorded diagnostics support the documented baseline/candidate results, and both negative fixtures produce the required TS2322 error.

The documentation preserves the extracted-helper limitation, distinguishes static results from runtime behavior, and retains the existing-server facts and adoption gates.

Inspected source, regression tests, documentation and saved evidence. Reran only read-only hash/data checks—no tests, downloads, installs, compiler, application, Docker or network operations.

This approval establishes neither root adoption nor C3/M0 acceptance.

## Spec

**Spec verdict: APPROVE — completed static investigation only.**

**Spec misses:** None outstanding. The three initial findings remain closed. Five offline regressions exercise those fixes and reject unrelated negative diagnostics; saved historical-controller results demonstrate detection of the original defects.

The actual compiler evidence supports the reported conclusions: Mongoose 6.13.8/driver 4.17.2 produces zero selected-source diagnostics; 9.12.0/driver 7.8.0 produces eight diagnostics covering removed types, operation/session options and middleware. Both configurations are identical, use `noEmit`, include the required staged inputs, and reject the specific semantic negative. The normalizer substitution and limited source coverage are disclosed.

**Overbuild:** None found. Results, progress updates and the DevOps handoff support the approved slice. The owner's existing-server choice is recorded without selecting MongoDB 8 for deployment or approving root adoption.

**Inspected / reran:** Independently verified all 11 source hashes, 26 evidence hashes and patch SHA `9b323b6a…fe6a353d`. Checked direct dependency versions/integrities against saved metadata, registry-only lock entries, diagnostic counts, source lists and configurations. All 15 guarded root files match both recorded hashes and baseline commit. Both compiler lists identify the same workspace, which I independently checked is absent.

Only read-only inspection, hashing and filesystem metadata checks were performed; no tests, installations, network, application or Docker operations were rerun.

Existing-server facts, root migration review, runtime compatibility, full C3 and M0 acceptance remain open. No external-Claude review is claimed.

## Initial findings and closure

| Axis | Finding | Closure and evidence |
| --- | --- | --- |
| Spec P2 | Invalid tool metadata could fail after allocation but before cleanup | Validate tool metadata first; protect allocation/finalization; offline invalid-metadata regression |
| Spec P2 | Failures skipped final root readback | Read back roots on every finalization and retain failure/cleanup state; registry-outage regression |
| Spec P2 | Unresolved imports or an unrelated TS2322 could falsely complete the comparison | Reject infrastructure diagnostics and require the exact negative fixture; missing-module and unrelated-diagnostic regressions |
| Standards P3 | Failure cleanup could discard useful compiler/lock evidence | Checkpoint available configs, locks, stdout and stderr before validation and cleanup |

[Five current regressions](offline-regressions.txt) pass. [Historical controller canary](historical-controller-canary.txt) fails with three failures and one error, as expected. No source or app compatibility PASS is inferred from mocked tests. The real run supplies separate compiler evidence.

Final outstanding findings: Standards **0**; Spec **0**. C2 root adoption, C3 application admission, M0 acceptance and release remain open.
