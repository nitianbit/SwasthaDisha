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

## Next work after the first batch (historical)

Foundation needs a separately reviewed bounded process-network-namespace interface/route observation contract and negative parser fixtures before any new read grant, guard change or invocation. The sampled names/down states are not an admission allowlist. Full C3 remains incomplete.

OTP storage/purpose/target/attempt/resend/atomicity and recovery remain separate scoped work. Notification general listing, ID-based operations, creation/broadcast and FCM sender capability also remain open; this batch does not close F03/F04 or their scenarios.

The publicly reachable deployment's revision remains withheld/unverified. No deployment, protected log/mailbox access, challenge/session invalidation or operational provider action occurred. Retained-server C2 facts still precede root dependency/build/start adoption. All existing M0, clinical/finance/security-owner, release and 100 RPS gates remain open.

Worktrees are retained under `/private/tmp/swasthadisha-parallel-p1qom53w/` (`otp`, `authority`, `foundation`, `integration`, plus clean historical `diagnostic-41539`). Feature commits remain independently mergeable. This integration branch is a source/evidence candidate, not a production deployment.

## Second batch, 10 November

Baseline `9ea963f1f7b51aadedcfa7fc9918eb39a2fd737d`. The lead owned integration and shared records. Three native workers authored separate lanes, and nonauthor reviewers handled every contract and implementation. No Ruflo connection, hosted worker or extra account was used.

| Branch | Reviewed head | Result |
| --- | --- | --- |
| `m0/authority-next` | `ea0710c405749dbc60cff2e1045fa87c68ef5789` | Users router: patients may only read, update or delete their own record; HR needs a corporate and stays within it; self-set status/corporate fields return 422 |
| `m0/money-provider-clinical` | `8409858a9e471812cba2aaa99d1004c8a22ee6e4` | Wallet create, credit/debit, update/freeze and listing are admin-only; by-user reads are own-or-admin |
| `m0/authority-jwt-secret` | `843bdb056ba3c481464ce8cd926ca28ab7ca0f33` | Configuration throws at load on a missing, empty or published placeholder `JWT_SECRET_KEY`; no literal fallback |
| `m0/foundation-network-admission` | `baaf071babae538d2bf9096e980b8e0155c9af82` | Harness: fail-closed device-state interface rule, controller cross-check and `ENETUNREACH`-only canary; no new grant; offline only |

The [combined verifier](../../../output/qa/parallel-integration-2/verify-source.py) checks:

- each merged file against its reviewed lane head, and that no file was changed by two lanes;
- the exact three-file production union and the protected root, harness and register files;
- that the original checkout's six staged files and eleven handover files are preserved.

The foundation unit gate passes 324/324 on the integrated tree on both runtimes. Reviews, findings and dispositions are in the [batch review record](../../../output/qa/parallel-integration-2/REVIEW.md).

### Open facts and decisions

| Item | Owner | Blocks |
| --- | --- | --- |
| Which code the deployed process runs: `server.js` imports a missing `./src`, `tsc` emits to `./dist`; the PM2 working directory | Owner / DevOps | Whether any source fix here protects the deployment |
| A secret, non-placeholder `JWT_SECRET_KEY` in the deployed environment; rotation invalidates existing tokens | Owner / security | Every role and ownership guard; deploying the fail-closed config |
| Prior use of the open users/wallet routes; contact details rewritten through the users defect; outstanding 30-day tokens | Owner / security, through protected logs | Operational remediation |
| Public `/api/static` clinical files, cached publicly for a year | Security + clinical/privacy + mobile (F05, C1) | File access containment |
| Unsigned lab webhooks that can trigger wallet refunds | Integration / operations (provider callback authentication, F06) | Webhook containment |
| Booking create for any `userId` (pharmacy wallet debit) and booking PUT cancel without refund | Product + finance + clinical (per-role field rules) | Booking actor/field containment |
| Account takeover by contact change: admin or HR can rewrite a patient's phone or email and then log in as them; a patient can change their own contact without verification, which allows pre-hijacking a future user's account | Identity / security owner | Contact-change verification and dedicated admin/HR commands |
| Non-atomic balances and duplicate refunds; authorized-but-uncaptured payments; recharge coupon over-credit | Backend + DevOps (F11/F13, C2 topology); finance (D3, D2) | Money recovery work |

### Next ready assignments

- **Foundation:** prepare an exact operator recipe for one real invocation of the new admission rule, and obtain its review. Running it needs the recorded Docker engine to be reachable.
- **Authority, decision-free, in priority order:**
  1. Notification `POST /send` lets any signed-in user push an arbitrary title and message to every patient by FCM (`notification/routes/index.ts:28-32`, `services/index.ts:365-410`), and `POST /` lets them send one to any chosen user. Interim containment: admin-only on both.
  2. Meet router: mounted with no authentication (`src1/routes/index.ts:66`), and it uses the server's Google refresh token. Containment needs `authenticate` and `requireAdmin` on the invite routes, matching the commented-out import at `meet/routes/index.ts:4`. The `/google-oauth/callback` route is reached by Google's browser redirect without a bearer token, so it must be handled separately, not covered by a router-wide guard.
  3. Dependents: own-or-admin, with everyone else getting 403, and `create` forcing `userId` to the caller. HR access to dependents would be a product decision.
  4. Notification general listing and ID-based operations, and the fixed-text FCM `/test` sender.
- **Money:** a post-fetch ownership check for wallet `GET /:id` and `GET /transactions/:id`. Everything else waits for the decisions above.

Worktrees for this batch are under `/private/tmp/swasthadisha-parallel-p1qom53w/` (`authority-next`, `money-clinical`, `authority-jwt`, `net-admission`). Commits are stored in the shared repository; nothing has been pushed.

## Third batch, 10 November

Resumed from `eba7e5c82e3ff63af9e9a958fbd100733e1fc439`. Before new work, direct internal Codex nonauthor reviewers inspected the second batch's production/security and network amendments. The retained second-batch composition verifier passed at that exact clean head, including all 36 lane mappings, 20 protected files and original staged/handover preservation. The network reviewer checked the earlier memory-only kernel/libuv assumptions against primary sources; actual local namespace/kernel/IPv6 conditions remain unmeasured. No new full-C3 or deployment acceptance follows.

| Local branch | Reviewed commit | Result |
| --- | --- | --- |
| `m0/batch3-outbound-guards` | `2ea38267c361e6b3322459bcd22c2be1dc22e09c` | Notification `POST /` and `/send` are admin-only; four non-callback Meet routes authenticate then require admin; callback registration and internal service callers unchanged |
| `m0/batch3-wallet-reads` | `d3a1f82147c0b3346abab43e6e34d260171b0c25` | Wallet and single-transaction ID reads validate the principal, fetch once and authorize against the returned stored `userId` or exact admin before serialization |

Each contract received two nonauthor pre-reviews. Each implementation received independent Standards/security and Spec reviews from `/root/batch2_security_check` and `/root/outbound_spec_review`, both **APPROVE_SOURCE_ONLY**, before its local merge. The lead authored outbound guards; `/root/wallet_read_contract` authored wallet reads. Actual source checks and limits are recorded in the [outbound reviews](../../../output/qa/batch3-outbound-guards/REVIEW.md) and [wallet reviews](../../../output/qa/batch3-wallet-reads/REVIEW.md).

The [third-batch composition verifier](../../../output/qa/batch3-integration/verify-source.py) binds merged files/modes to the reviewed lane heads, rejects unexplained changes and overlapping writers, checks the exact three-file production union, and verifies the original six staged files and eleven handover files. Per-lane scope checks are intentionally run on their own branches; their unrelated-file exclusions are replaced by the composition check on integration.

Source-only evidence: baseline rejection, exact amended acceptance and 25 outbound negative source controls; 22 wallet negative source controls plus five structural scope/input controls. These are checks over source data. No mounted API/JWT/client behavior, actual zero-provider effects or domain acceptance is inferred. The required runtime cases remain NOT_RUN under complete C3 admission. Foundation unit sources remain unchanged from the second batch, so the retained 324-case evidence is reused rather than rerun for these TypeScript route/controller changes.

All commits in this continuation remain local. The eight-week plan remains a proposal; C2 target facts, actual deployment/key/session/exposure response, full C3/M0 and named clinical/finance/security/release gates remain open. No withheld operating fact has been requested again.

Next authority contracts: dependents owner-or-admin, notification general listing and ID operations, and the FCM test sender. Booking/callback/contact/clinical-file and money-recovery decisions retain their assigned owners above; a source fix on a different path does not close them.

### Foundation continuation after source integration

The exact amended network operator ran once on clean detached `eba7e5c` after separate Standards and Spec **APPROVE_ONE_FIXED_NO_DB_RUN** decisions. It **PASSed** the bounded no-DB sandbox smoke: network/permission assertions, the real pure search helper and seven recording-only receipts. Same-engine exact-container/workspace absence and zero labels were independently read back by the operator. The run approval is consumed; the historical strict-guard failures remain preserved.

Raw evidence: `/private/tmp/sd-network-admission-run-0_ws9v0p`, operator result SHA-256 `95117a73da1eda185e65df2af2e425893c4c7f7f2b2e5ae0743cde34371a3dc9`. The preparation/evidence branch `m0/batch3-network-recipe`, commit `aab5188af3c3dc1223a30c7bd767913f80eaee47`, is integrated after both nonauthor reviewers returned **ACCEPT_BOUNDED_RUNTIME_EVIDENCE**. Its [frozen packet, review and archive](../../../output/qa/batch3-network-recipe/REVIEW.md) retain the initial Spec finding, amendment, exact approvals, consumed claim and 24 byte-identical execution files. No real provider/DB or domain route ran; this result cannot accept the source-only security fixes or full C3/M0. The next foundation work is a separately contracted bridge to actual app/DB/provider recording boundaries and compatible synthetic configuration, rather than another run of this consumed recipe.
