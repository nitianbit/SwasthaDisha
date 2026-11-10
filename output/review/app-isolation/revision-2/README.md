# Network diagnostic candidate review handoff

**Offline candidate only. No new Docker run or activation approval.** The first real smoke remains FAIL; its exact resources were cleaned. The strict interface assertion, fixed image/profile/Node command and all grants remain unchanged.

Use [the candidate review prompt](../../../../documentation/planning/implementation/APP_NETWORK_DIAGNOSTIC_REVIEW_PROMPT.md), [contract](../../../../documentation/planning/implementation/APP_NETWORK_DIAGNOSTIC_CONTRACT.md), [disposition](DISPOSITION.md), `review-input.json` and `candidate.diff`. This requests one combined failure-and-concrete-code review before a single diagnostic-enabled smoke. It does not claim the pending failure review already occurred.

Recorded: 185 unit passes per Node 22/24 runtime, 22 runner controls and 40 offline companion/extracted-block checks; expected old-controller/bootstrap rejections and parser checks. All new runtime metadata is synthetic. Current actual metadata and diagnostic delivery remain NOT_RUN. No admission repair or new name allowlist is implemented.

Frozen amendment base: `58980c698bdfcdee5b2eb68d5c8a7577e6758e4d`. The diff excludes `output/` and author eval notes. Earlier snapshots are historical at their commits; verify them there rather than expecting intentionally amended source/status hashes to match current files. Root dependency/build/start, retained-server C2, full C3/M0, domain acceptance and 100 RPS remain open.
