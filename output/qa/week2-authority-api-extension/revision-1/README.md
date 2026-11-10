# Authority API extension source candidate

The frozen contract has two direct nonauthor internal Codex implementation
pre-approvals: Standards `/root/backend_boot_path` and Spec
`/root/local_claude_review_prep`, each confirming final
23f37d31fe77565ce7d5d04689b777d5f539dd079d787b26ca6346e5e42c4f90.
These are neither Claude-model reviews nor runtime/owner/release approvals.

Author owns only scenario.cjs, compile.cjs, scenario README and this QA directory.
The composed branch includes root's separately approved shared bootstrap, pure
unit and ports changes. Old36 main statements, four probe definitions, overlap,
target-binding and rejectChallenge predicates are byte-preserved. Existing
snapshot scope is strengthened to all13 admitted models (OTP excluded only for
its original explicit expiry assertions). Exact completed synthetic proof IDs
plus owner are cleaned only between completed assertions/phases.

The new17 nominal groups and10 actual-source variants declare53/14 totals.
All new runtime behavior and genuine TS-AST model/mutant emission remain NOT_RUN.
Accepted execution4's core36/four PASS is historical evidence, not approval for
this extended fixture. No install/compiler/application/DB/provider/Docker/client
execution occurred while authoring this candidate. No production/dependency/
profile/grant/resource limit changed.

Checks performed on the composed source:

- Permissioned pure bootstrap suite189 PASS:29 admission,117 safe diagnostics,
  12 cleanup and31 recording/read-counter cases; zero app imports/connections/
  writes and no child/worker/addon/fs-write grants.
- Existing16 standard-library public-lock fake tests PASS.
- Three CJS parser checks PASS; no module evaluation.
- Inspected standard-library source/data checker PASS: actual Git baseline
  rejected,17 deliberately weakened fixture-source controls rejected, old36/four
  and core predicates/diagnostic tail preserved, exact53/14 declarations,
  immutable contract and unchanged production/dependencies verified.

The source controls prove textual preservation and candidate shape, not MongoDB
atomicity, real routing/access denial, delivery or emitted mutant sensitivity.
All53/14 predicates must pass in a freshly admitted exact future run after two
source reviews, fresh locked preparation/artifact reviews and two exact one-run
decisions. Retain semantic diagnostics honestly, no root type/build claim, no
automatic retry or expanded limits. Every failed invocation and owned cleanup
requires its own evidence/reviews.

Reproduce source and fake checks without evaluating application code:

```sh
env -i PATH=/usr/bin:/bin /opt/homebrew/bin/python3 -I -B output/qa/week2-authority-api-extension/verify-source.py
/private/tmp/m0-node22/node --permission --allow-fs-read="$PWD/test/api-runtime/scenario" test/api-runtime/scenario/bootstrap-unit.cjs
/opt/homebrew/bin/python3 -I -B test/api-runtime/scenario/offline-unit.py
/private/tmp/m0-node22/node --check test/api-runtime/scenario/scenario.cjs
/private/tmp/m0-node22/node --check test/api-runtime/scenario/compile.cjs
```
