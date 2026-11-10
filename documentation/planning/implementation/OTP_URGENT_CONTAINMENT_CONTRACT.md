# Urgent OTP account-takeover containment

10 November 2026. Baseline `525d435332eb1ff0d904f7aac4996a32a74fe0ba`, branch `m0/f01-app-isolation`. The owner independently confirmed the login bypass and public raw OTP mint and requested an immediate operating decision. This supersedes deferral of these two containment changes in the [broader draft](M0_OTP_AUTHORITY_CONTRACT_DRAFT.md); it does not select its remaining lifecycle or membership policies.

## Decision and authority

Treat the fixed-code verifier and public raw challenge API as critical account-takeover defects. Prepare and independently review their narrow local source amendment now, ahead of the remaining M0 sequence. If the affected revision is publicly reachable, the deployment/security operator should apply a specifically authorized emergency patch or restrict affected authentication access until safe. Last owner-reported pre-launch status does not establish absence of public reachability. No operational deployment, database mutation, log/mailbox access or credential action is authorized by this source contract.

The connected GitHub repository readback on 10 November reports `nitianbit/SwasthaDisha`, ID `1452083010`, visibility `public`. Published store links are not deployment-version evidence. Current exposure, deployed source and exploitation remain unestablished; owner questions are pending.

## Frozen source scope

| Surface | Required amendment and preserved behavior |
| --- | --- |
| `OTPService.verifyOTP` | Delete the fixed-code selector and its target-only lookup branch. Every supplied code must use the existing `findByUserIdAndOTP(userId, otp, target, targetValue)` path |
| Verifier guards | Preserve missing/already-verified result handling; remove bypass conditions from the existing expiry and stored-code comparisons so both apply to every submitted value |
| Valid generated proof | Preserve current success/error envelope and `markAsVerified` call. The former bypass value has no special treatment: if independently generated/stored as a valid current code it follows the ordinary path; do not replace the bypass with a blacklist, development flag or alternate secret |
| Public raw OTP API | Delete the central `otpRouter` import and `/api/v1/otp` mount in `src1/routes/index.ts`. Both raw POST routes then fall through to the existing terminal `404` JSON response, without constructing their controller through that import |
| Supported generated flows | Leave the three authentication-service issuance/verifier callers, public generated login routes, authenticated email/corporate verification routes, DTOs and their explicit recipients byte-identical |

Only `src1/modules/otp/services/index.ts` and `src1/routes/index.ts` may change in production. No schema, repository predicate, dependency, runtime/startup, JWT, provider or remaining field-authorization change is included. Raw caller-chosen mint is intentionally withdrawn, including for clients that may have depended on it; unknown client revisions do not justify retaining that authority. Clients must use the existing generated authentication flow and verified-contact flows as appropriate. Broader client compatibility and the route response remain to be exercised under admitted fixtures.

## Verification boundary

Obtain direct independent preimplementation review, then direct final Standards and Spec review of the actual source/hash inventory and evidence. Preserve the six staged Ruflo files and all handover artifacts. Do not activate Ruflo or run the unrelated Docker diagnostic.

This initial verification treats all TypeScript as source data. Retain a reproducible standard-library command that compares the candidate against a precisely constructed minimal baseline amendment, checks unconditional code-bound lookup/expiry/equality and withdrawn import/mount, and verifies untouched auth callers/root dependencies/foundation sources. Negative controls must reject the baseline and each reintroduced bypass, expiry/equality exemption and raw mount. Never record the bypass literal in generated artifacts or execute an extracted verifier as a shortcut around C3.

Complete C3 admission is still required before importing/evaluating the application, using a DB/provider client or executing an extracted method. Required mounted-flow regressions remain NOT_RUN: wrong/expired/used/missing and former-bypass proof denial for supported roles including admin, unchanged valid generated proof, no token or privileged/provider effects on denial, and raw-route 404 with zero challenge writes. A genuinely generated code equal to the former special value must be checked normally. Source comparison is neither a runtime regression nor deployment readiness.

## Activation and unresolved security work

Removing these source paths does not revoke issued JWTs or invalidate pending challenges already minted through the raw API. The operational owner must assess and authorize invalidation of outstanding challenges, including arbitrary far-future expiries, and decide existing-session revocation/reverification from exposure evidence before restoring an exposed environment. Do not invent a cutover timestamp, mutate an ambient database or rotate keys locally. Restrict affected authentication if those prerequisites cannot be established safely.

Purpose/target binding, atomic consumption/resend, cryptographic storage/generation, abuse limits, contact recovery and corporate authority remain the separately reviewed lifecycle work in the broader draft. The narrow patch does not close TC-REV-001 or TC-SEC-001 and does not remediate earlier misuse. Preserve all 115 scenario outcome and automation statuses. Protected auth-log review and past sensitive-mail exposure assessment need a named security/account owner; see the [operating decision](OTP_EMERGENCY_OPERATING_DECISION.md). C2 adoption, full C3, M0 and release acceptance remain separate gates.
