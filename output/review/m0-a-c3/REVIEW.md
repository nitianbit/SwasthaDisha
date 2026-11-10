# F01 fixture increment: review and disposition

**10 November 2026.** Internal coding-agent reviews under the Code Review skill; neither reviewer is Claude or the project's earlier external Review-A/Review-B. These approve the bounded code increment, not M0-A acceptance, full C3, deployment or production target selection.

Base: `9ca8b54606581f2158e760cad79aa7b845529184`; branch: `m0/f01-foundations`. No implementation commits exist yet. The implementation was untracked WIP, so a bounded explicit diff was frozen instead of presenting an empty HEAD diff. Final ten-file inventory: [final.json](final.json); patch: [final.diff](final.diff), SHA-256 `3a7b2cd8533851e12abc8c23d1fe47dbf2c24eef85b313bdbb722c1200fb7e18`.

## Standards

**Verdict: APPROVE** for the bounded fixture test slice.

**Standards violations:** None found against the supplied graph-first AGENTS instructions or Ponytail's requirements for scope, validation, error handling and meaningful checks.

**Code smells:** No actionable baseline smells. The diagnostics, measured transaction counts and four rejection cases address concrete runtime failures without adding unnecessary abstractions.

**Additional material risks:** No new material regression identified. Recorded real MongoDB 8.0.34 evidence shows `committed: 1`, `aborted: 0` and cleanup acknowledgement; separate cleanup evidence records both exact IDs absent and zero fixture-purpose leftovers. This is distinct from the mocked unit evidence and establishes neither application-driver compatibility nor full C3/M0 acceptance.

Inspected the final diff, changed source, documentation, TAP summaries, negative-canary results and smoke/cleanup records. All 10 source hashes and eight evidence hashes match; the patch hash matches `3a7b2cd…fb7e18`. Recorded results show 56 passing tests on each runtime and 18 rejected negative canaries.

I reran only read-only hash verification. No tests, Docker, application or legacy suites were rerun; no files changed.

## Spec

**Verdict: APPROVE** the frozen code slice at patch SHA `3a7b2cd8533851e12abc8c23d1fe47dbf2c24eef85b313bdbb722c1200fb7e18`.

**Spec misses:** None found within filesystem admission and the independently owned MongoDB fixture lifecycle. The prior image-admission and empty-entry findings remain closed. The corrected probe returns measured counts; Node rejects incorrect commit, rollback, namespace or replica-set evidence. Recorded real-run evidence now satisfies the bounded transaction-and-cleanup requirement: MongoDB 8.0.34, committed `1`, aborted `0`, cleanup acknowledged, both reported container IDs absent, and zero fixture-purpose leftovers. Earlier probe failures are disclosed.

**Overbuild:** None found. Diagnostics, failure identifiers and fixture instructions support the required lifecycle. Application integration, production database selection, root dependencies, startup changes and ODM adoption remain outside this increment.

**Inspected/reran:** Read the final diff, contract, changed source/tests/docs, TAP output, negative-canary records and real smoke/cleanup evidence. Independently recomputed all 10 source hashes, eight evidence hashes and the patch hash; all match. Both TAP summaries show 56 passing tests, and all 18 executable-canary records show the intended rejection. Evidence JSON agrees across the manifests. HEAD and branch match the stated baseline.

No tests, Docker operations, application imports or legacy suites were rerun during this read-only review. Approval does not establish full C3, application-driver compatibility or M0 acceptance.

## Development and review cycle

| Stage | Finding or evidence | Disposition |
| --- | --- | --- |
| Initial Standards review | Empty test files could count as passing entries after the runner grew to two suites | Reproduced both-empty and one-empty false passes; reject each entry's empty-file TAP fallback; six final executable cases across two runtimes reject them |
| Initial Spec review | Request getters could change the image between validation and Docker create | Snapshot once before validation; getter and mutation regressions; executable mutation canary detects the original ordering |
| Revised code review | Both axes approved the fixes; real MongoDB evidence still outstanding | Ran the independently owned fixture only after this review |
| Real runtime check | Legacy `assert.eq` shell helper unavailable; initial synthetic transaction probe failed | Added bounded diagnostics, returned measured counts to Node, added four rejection cases and reran the real probe successfully |
| Final verification | 56 PASS per runtime; 18 negative canaries; real commit/rollback and cleanup evidence | [Dated evidence manifest](../../qa/m0-a/2026-11-10/verification.json); source frozen and both axes re-reviewed |

Final outstanding findings: Standards **0**; Spec **0**. Both axes approve this increment only.
