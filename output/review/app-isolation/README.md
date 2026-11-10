# Application sandbox review handoff

**Status: review required before first real isolated smoke. No activation approval is recorded.**

Read `documentation/planning/implementation/APP_ISOLATION_REVIEW_PROMPT.md` for the complete prompt and exact review scope. The fixed base is `555bec4b4729fb14487bcfc48c40c53b6f85421f`; current branch is `m0/f01-app-isolation`. `candidate.diff` and `review-input.json` freeze the source and evidence. Author-side prompt eval notes are intentionally excluded from review inputs.

Executed evidence: 127 unit checks pass on each Node 22/24 runtime; two positive gate controls and twenty expected negative rejections pass; three parser-only source checks pass. Unit Docker/bundles are fake. The public Node index digest matches its raw response bytes. Local socket metadata matches the proposed operator-owned Unix socket without making a Docker connection.

Not run: image pull, new real Docker call/container, real bootstrap/scenario, application-helper runtime import, actual sandbox mount/network/permission assertions or cleanup readback. Root dependencies/start and application source remain unchanged. Full C3/M0/domain/100 RPS acceptance remains open.

Requested decision: APPROVE FIRST ISOLATED SMOKE / REQUEST CHANGES / HOLD. Approval covers only the recorded local-profile image cache, fixed synthetic/no-DB smoke and exact-ID/workspace cleanup proof. No external Claude review or new external named-reviewer approval is claimed.
