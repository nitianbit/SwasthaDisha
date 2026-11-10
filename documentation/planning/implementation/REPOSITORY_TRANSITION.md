# Active repository and migration record

**10 November 2026.** The owner selected `https://github.com/nitianbit/SwasthaDisha.git` and confirmed that all future project work will happen there. This repository now contains the selected backend, planning/design documents, operations prospectus, brand assets and foundation tests. The sibling legacy checkout remains a reference; it was neither reset nor repointed.

## Repository identity

- Active repository: **nitianbit/SwasthaDisha**; local checkout `/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha`.
- New history starts at README-only commit `f822cdd9150b78a5df2cfbbe2a867d4b4ea7125d`. Record current branch/HEAD from Git; the import commit cannot include its own SHA in this record.
- Legacy source: `nitianbit/ewa_backend`, branch `m0/f01-foundations`, commit `9ca8b54606581f2158e760cad79aa7b845529184`, plus the approved local planning/foundation work. Legacy Git history was not imported.
- Retain the current root layout (`src1`, `test`, `documentation`, `output`) so architecture links and source references remain usable. Frontends and later modules will be added here through their planned slices.

## Transfer and exclusions

The [machine-readable inventory](../../../output/migration/transfer-manifest.json) records selected file hashes, explicit exclusions and import edits. Service-account credentials, patient export data, uploaded files, operational/raw test results, API client exports, machine-local editor/agent state and duplicate archives were excluded. Local `.env` files, dependencies, Git internals and build output were not selected. Published PDFs, the editable prospectus and generated source assets retain their bytes.

A confirmed inline JWT in `test/update-images.ts` was replaced by the required `DEV_AUTH_TOKEN` environment variable with an early missing-token error. That development utility remains unexecuted. Application source in `src1`, package/lock/runtime/start files and the reviewed foundation source were copied unchanged. The ignore rules now cover the excluded credentials/data patterns. No credential rotation or external account action is included in this import.

The README now identifies the active repository. The C2 review prompt identifies the new seed commit and treats the old SHA/snapshot as provenance. Agent instructions route future work to the active checkout and retained gates.

## Evidence continuity and next work

The ten-file fixture snapshot at `output/review/m0-a-c3/final.json` and its separate Standards/Spec reports are historical evidence from the legacy checkout. The snapshot's source hashes must still match the corresponding copied files. Its legacy base SHA is not this repository's HEAD. Prior PDF approvals and scenario registers retain their publication-time meaning; importing them creates no new application acceptance evidence.

Current scope remains **M0-A in progress**. The [C2 runtime/ODM packet](C2_COMPATIBILITY_REVIEW.md) is the next decision gate before affected root dependency/build/start edits. Complete application-child/provider/file/network admission still precedes legacy integration execution. Root install/build/compiled start, domain scenarios and 100 RPS acceptance remain outstanding. Continue the development/review cycle here after the corresponding gate is resolved.

The migration's source/hash checks, relocated foundation run and code-review dispositions are recorded in `output/migration/verification.json` and `output/migration/REVIEW.md`. These prove transfer integrity and the bounded foundation gate, not deployment readiness. No app imports, operational database/provider access, installs or deployment were used for this move.
