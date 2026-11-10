# Static compatibility investigation results

**10 November 2026. Complete for the approved static-only slice; root adoption remains unapproved.** Branch `m0/f01-static-compatibility`, base `b06be010c8bee7468eaaeb432952c787b300a5b4`. The owner selected retaining the existing server; DevOps will provide its baseline. No MongoDB 8 production target is selected.

## Observed comparison

| Input / result | Current baseline | Candidate |
| --- | --- | --- |
| Mongoose | 6.13.8 | 9.12.0 |
| Resolved temporary MongoDB driver | 4.17.2 | 7.8.0 |
| Node / compiler / declarations | Node 22.23.4 / TypeScript 5.9.3 / @types/node 20.19.31 | Identical |
| Selected source type-check | Exit 0; zero diagnostics | Exit 2; eight migration diagnostics |
| Independent invalid-type canary | Expected TS2322 from negative.ts | Expected TS2322 from negative.ts |

The [verification record](../../../output/qa/m0-a/c2-static/67466c79-36a5-44ab-abc5-16df26100529/verification.json), exact package locks and configs, registry metadata and full diagnostics are retained under the same run directory. Public packages were installed only into owned temporary resources with lifecycle scripts disabled. The exact compiler ran with noEmit and filesystem restrictions. Root source/package hashes remained unchanged. The controller removed the workspace; [separate absence readback](../../../output/qa/m0-a/c2-static/67466c79-36a5-44ab-abc5-16df26100529/cleanup-readback.json) confirms it is gone.

## Migration work now confirmed

Eight diagnostics represent three groups, not eight independently reproduced application bugs:

1. **Removed or renamed types:** blogs repository and shared BaseRepository import FilterQuery; BaseRepository also imports LeanDocument. A future migration must use the new filter interface and an explicit plain-record return contract. Replacing lean records with hydrated documents or suppressing errors with casts would change the interface rather than prove compatibility.
2. **Operation/session options:** BaseRepository deleteOne, deleteMany and updateMany pass QueryOptions whose session accepts null; the candidate driver operation types accept a session or undefined. Review operation-specific options and null/unset/session semantics before changing them. Transaction propagation needs admitted behavioral fixtures, not only a type repair.
3. **Medicine validation middleware:** the existing next() call is incompatible with the candidate pre-hook signature. Preserve name trimming/nameKey normalization and unique partial-index behavior in the eventual runtime migration fixtures.

These are real compiler observations on the selected source. No production module was executed, no queries or validations ran, and there is no whole-backend type-check/build claim. Mongoose 8 was not installed: this first comparison quantifies the preferred candidate's impact; a bridge is not selected without server facts and a justified owner/exit milestone.

## Scope and safety evidence

Eight byte-identical source files cover the shared repository, blog model/repository/types, regex helper and medicine model/types. The three-line normalizer was explicitly extracted into a workspace-only module, excluding its effectful migration/logger imports. The report records this adaptation and original hashes. A source canary that would throw on evaluation was included only as compiler input.

Five offline controller regressions pass. They cover invalid tool metadata before allocation, failure-time readback/cleanup, infrastructure diagnostic rejection, the exact negative fixture and legitimate migration diagnostics. Running the same regressions against the original controller returns nonzero (three failures and one error), demonstrating detection of the reviewed defects. [Offline evidence](../../../output/review/c2-static/offline-verification.json).

The source review corrected allocation/finalization gaps, failure evidence loss and false completion after unresolved imports. The final separate review dispositions live in [the review record](../../../output/review/c2-static/REVIEW.md). These are internal coding-agent reviews, not new external Review-A/Review-B approval.

## What proceeds next

- DevOps supplies [the existing-server baseline](DEVOPS_BASELINE_REQUEST.md) before root runtime/dependency/build/start adoption. Keep current root Mongoose/driver majors meanwhile.
- Backend/QA can continue C3 application-child admission and provider/queue/timer/file/network isolation under the retained gates. The fixed MongoDB smoke controller does not admit the application.
- Once the target is known, review a specific supported stack and the shared repository/model migration contracts, then implement the actual root package/lock/source diff with isolated runtime evidence. Type-check success alone cannot approve finance, stock, clinical or release behavior.

Full clean install, whole-backend type-check/build, compiled startup, wired default test command, 115-scenario regressions, security/financial/clinical fixes and 100 RPS acceptance remain outstanding. Their statuses were not changed by this comparison.
