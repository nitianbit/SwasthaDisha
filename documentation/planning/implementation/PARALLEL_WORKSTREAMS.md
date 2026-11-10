# Parallel development and integration

10 November 2026. The owner authorized separate branches/worktrees followed by reviewed integration. Common baseline `bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7`. The original `m0/f01-app-isolation` checkout remains at that baseline with its six staged Ruflo changes and eleven handover files preserved. No Ruflo connection or hosted worker was introduced.

| Branch | Reviewed commit | Result |
| --- | --- | --- |
| `m0/parallel-otp` | `66de4894f666449331e7c90fb0e94b6c01a54418` | One `node:crypto` import and three six-digit cryptographic OTP generators; all other auth source unchanged |
| `m0/parallel-authority` | `0a1f77a97eede0d8e0b3eb41d85796c817ae9996` | Own-recipient checks before service access in four notification handlers; other endpoints remain open work |
| `m0/parallel-foundation` | `4c38e0b4612e42a800b99bf6c3cc8c184bed24a3` | One approved diagnostic executed at exact historical sources; measured guard failure and precise cleanup archived; no harness-policy change |
| `m0/parallel-integration` | Carries the three non-fast-forward merges and this combined record | Conflict-free source composition; original branch remains untouched |

The lead owns integration and shared progress/operating records. Separate native workers owned the three lanes. Each concrete contract was reviewed before source edits/execution, followed by two direct independent Standards and Spec reviews from agents who did not author that lane. The [OTP review](../../../output/qa/parallel-otp/REVIEW.md), [authority review](../../../output/qa/parallel-authority/REVIEW.md) and [foundation review](../../../output/qa/parallel-foundation/REVIEW.md) identify actual reviewers and frozen hashes. These are internal Codex reviews, not named-owner or release approvals.

## Combined checks and boundaries

The [integration verifier](../../../output/qa/parallel-integration/verify-source.py) checks each merged production file against its reviewed source transformation, all 36 frozen lane-file mappings, feature-commit ancestry, the exact two-file production-change union, unchanged root dependencies/start/harness/register, and original staged/archive preservation. [Exact command and result](../../../output/qa/parallel-integration/verification.json). It evaluates retained Python source-data checks only; no TypeScript or application is imported/evaluated. The feature-scoped OTP singleton-diff assertion is intentionally replaced by union verification on this integrated tree.

Source checks recorded before-edit rejection, amended acceptance and nine OTP plus twelve authority negative source controls. They do not prove mounted login/notification behavior, runtime entropy/delivery, zero provider effects or client compatibility. Runtime scenario outcomes remain 0 PASS, 1 FAIL, 1 BLOCKED, 110 NOT_RUN, 3 DEFERRED.

The existing historical source approval at `41539ca` was consumed by one relocated diagnostic invocation after direct review of the exact operator and all 103 old mappings. It **FAILed** the unchanged interface-directory guard. The matching diagnostic was 1,207 bytes; the listing included a regular control file and devices reporting down, while assigned addresses were loopback-only. Routes and network-namespace provenance remain unmeasured. Same-engine exact-container/workspace absence and zero purpose labels were independently verified. No retry, image pull, daemon startup, guard relaxation or grant expansion occurred.

Source/document whitespace checks pass. The archived `relocation.diff` retains its unified-diff blank-context marker byte-for-byte and is excluded from whitespace normalization; its frozen hash remains verified.

## Next work

Foundation needs a separately reviewed bounded process-network-namespace interface/route observation contract and negative parser fixtures before any new read grant, guard change or invocation. The sampled names/down states are not an admission allowlist. Full C3 remains incomplete.

OTP storage/purpose/target/attempt/resend/atomicity and recovery remain separate scoped work. Notification general listing, ID-based operations, creation/broadcast and FCM sender capability also remain open; this batch does not close F03/F04 or their scenarios.

The publicly reachable deployment's revision remains withheld/unverified. No deployment, protected log/mailbox access, challenge/session invalidation or operational provider action occurred. Retained-server C2 facts still precede root dependency/build/start adoption. All existing M0, clinical/finance/security-owner, release and 100 RPS gates remain open.

Worktrees are retained under `/private/tmp/swasthadisha-parallel-p1qom53w/` (`otp`, `authority`, `foundation`, `integration`, plus clean historical `diagnostic-41539`). Feature commits remain independently mergeable. This integration branch is a source/evidence candidate, not a production deployment.
