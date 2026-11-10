# Urgent OTP containment: direct internal reviews

10 November 2026. Baseline `525d435332eb1ff0d904f7aac4996a32a74fe0ba`, branch `m0/f01-app-isolation`. The owner's independent review accepted the preceding mail amendment and requested an immediate operating decision on the confirmed OTP takeover paths.

## Decision, findings and ownership

Prioritize narrow source containment now rather than deferring it to M0 completion. If the affected code is reachable, the operational owner must authorize an emergency patch or restrict the affected authentication surface while validation and outstanding-challenge/session containment are established. Deployment, exposure and exploitation remain unknown. A connected GitHub `get_repo` read verified repository `1452083010`, `nitianbit/SwasthaDisha`, visibility `public`; no backend endpoint was probed.

Security review of the baseline confirms two Critical, high-confidence source findings: caller-supplied login proof can select a fixed-code branch that skips code matching/expiry and reaches JWT issuance including active administrators; separately, the public raw router accepts caller-selected challenge data. Route validation does not mitigate these authority defects. The bypass value is deliberately omitted from artifacts. The review used the local security-review skill and source tracing, not an operational exploit test.

Lead `/root` owns the urgent contract, integration, source-data verifier, evidence and status notes. `/root/authority_trace` independently rediscovered current callers and the 404 fallback. `/root/incident_decision_worker` authored the operating decision, amended by the lead to include pending-challenge invalidation and local coordination ownership. `/root/mail_source_worker` owns only OTP service and central-route source changes. Other edits, the six staged Ruflo files and all handover artifacts are preserved. No hosted worker or user-relayed review prompt was used.

## Preimplementation approvals

Both decisions bind [contract](../../../documentation/planning/implementation/OTP_URGENT_CONTAINMENT_CONTRACT.md) SHA-256 `af5d4ddb9d300a92df398ecc59f8ed9e51fe54a666166373aeb3f0d848a70b49` and the baseline above, and arrived before production edits.

**Internal Codex `/root/otp_urgent_security`: APPROVE NARROW SOURCE-ONLY CONTAINMENT.** Independently inspected the service, repository/model, raw and generated auth routes/validators/middleware, three legitimate verifier callers plus the raw controller, M0 scope and C2/C3. Confirmed the Critical public-input paths with high confidence. No material contract finding. Required unconditional exact-code lookup and existing expiry/equality checks, withdrawal of the central raw import/mount, unchanged normal flows, and no blacklist/development flag. Unknown clients do not justify retaining public mint authority. Approval explicitly excludes runtime/deployment acceptance and requires an operational decision on pending challenges/JWTs and protected logs.

**Internal Codex `/root/foundation_readiness`: APPROVE SOURCE-ONLY URGENT CONTAINMENT.** Independently inspected the full urgent contract, operating decision, affected service/repository/router/mount, generated callers and C1–C3 ledger. No material preimplementation Standards/containment finding. Approved only the two-file minimal amendment and source-data/negative controls, preserving remaining production bytes. Unresolved C2/C3 does not block this reviewed source preparation; it still blocks affected adoption/evaluation. Existing challenges and sessions require separate operator authority before restoring exposure.

Graph path/HEAD matched the active checkout. Inbound graph relationships were incomplete, so exact-source reads established callers and route mounting. These are internal Codex decisions, not external Claude, named security-owner or deployment approval.

## Actual amendment and executed source checks

Only `src1/modules/otp/services/index.ts` and `src1/routes/index.ts` change in production. The shared verifier now always uses the existing `findByUserIdAndOTP` with the original arguments; ordinary expiry and stored-code equality checks have no special-code exemption. The central raw-router import/mount are deleted. Other production files and the existing terminal 404 remain byte-identical.

Service SHA-256 `7aa21a23b21b80a8b08f508de0df9b7f916dcf60bdaa7d0b7e9ce51b9897746e`; routes `50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056`. [Source-only recipe](../../qa/m0-b/otp-containment-2026-11-10/source-check.py) and [exact command/environment/stdout/exit receipts](../../qa/m0-b/otp-containment-2026-11-10/source-verification.json) are retained.

The command `/opt/homebrew/bin/python3 output/qa/m0-b/otp-containment-2026-11-10/source-check.py`, with sanitized PATH/TMPDIR, rejected the original source before edits and accepted the amended source afterward. Adding `--negative-controls` rejects seven synthetic source reintroductions: original special-code service, target-only lookup, expiry exemption, equality exemption, raw import, raw mount and original raw routing. No TypeScript, copied method or application dependency is evaluated by those checks. These are source-control sensitivity results, not authentication regressions.

`git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check` passes. The CSV's existing CRLF format is preserved. Only TC-REV-001 references/notes change; all 115 execution and automation statuses remain unchanged. Original staged patch SHA-256 remains `00b2ad0daae9ac54adda82e8a7eb1450ca25340be4412ac76f226bfd6c45ff9a`, and all eleven preserved handover files retain their bytes.

## Final frozen review

`review-input.json` freezes ten production/contract/status/evidence files; this review record is excluded so subsequent reviewer decisions do not create circular hashes. Final Standards and Spec decisions must bind the actual manifest/file hashes before committing as reviewed.

**Final Standards/containment: APPROVE SOURCE-ONLY — internal Codex `/root/foundation_readiness`.** Independently verified manifest `cb7da3dd9e43fa00834aeb1200ad440b0d623929b74083a282306b2e92ccd650`, all ten file hashes and production patch `2e47d8fb1b14db6a2b81e73e77f4873d817d2cf50400f7356bb61ec5e12a880f`. No material findings. Confirmed the minimal two-file amendment, unchanged generated callers/repository/model/mail/root/harness sources, source-only command/negative receipts, accurate operational/lifecycle holds, unchanged scenario statuses/CRLF convention, and preserved six staged/eleven handover files. Diagnostic clarification grants no invocation. Read-only inspection/comparison; no application, extracted-method, compiler/suite, DB/provider/Docker or operational execution. Approval covers committing the reviewed source/docs/evidence only.

**Final Spec/security: APPROVE SOURCE-ONLY CANDIDATE — internal Codex `/root/otp_urgent_security`.** Independently verified the same manifest, ten hashes and production patch. No material finding against the bounded candidate. Confirmed exact-code lookup and unconditional ordinary guards, raw import/mount removal with unchanged terminal 404, no alternate bypass/blacklist/flag, and byte-identical protected sources. Inspected before/after/seven-negative source receipts without evaluating TypeScript or rerunning the recipe. Independently checked register, staged/archive preservation and operational owner/challenge/JWT/log/mailbox/staff-notice limits. The `41539ca` approval remains unconsumed and exact-source-bound. Read-only review. Approval covers commit preparation only, not runtime login/route behavior, safe activation, historical remediation, operational invalidation, scenario closure, deployment or release.

## Operational and acceptance limits

The [operating decision](../../../documentation/planning/implementation/OTP_EMERGENCY_OPERATING_DECISION.md) records the owner questions and pending deployment, protected-log/mailbox, legacy-challenge and session actions. Previously minted challenges, arbitrary future expiry and existing JWTs survive source editing. No live account, mailbox, auth log, DB, provider, Docker or deployment access occurred. No root build/type-check, application/extracted-method import or runtime suite ran.

TC-REV-001 and TC-SEC-001 remain NOT_RUN. The current error envelope is preserved; this patch does not establish the scenario's future uniform-401 contract or complete purpose/target/atomicity/abuse controls. Scenario outcomes remain 0 PASS, 1 FAIL, 1 BLOCKED, 110 NOT_RUN, 3 DEFERRED. Staff notices remain a separate approved-recipient/content decision; no recipient is added to authentication mail. Historical mail exposure is unassessed, not closed.

The diagnostic approval at `41539ca` remains unconsumed and bound to its original clean source/profile, as clarified by the owner. No diagnostic runs here. C2 adoption, full C3/M0, named-owner decisions, deployment/release and 100 RPS acceptance remain open.
