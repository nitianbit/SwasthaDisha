# Immediate OTP containment decision

**10 November 2026. Baseline `525d435332eb1ff0d904f7aac4996a32a74fe0ba`. Source containment is urgent; deployment and historical exposure are unresolved.** This records the development lead's decision following the owner's independent account-takeover review. It is not a deployment authorization, confirmed incident or runtime acceptance.

## Decision and known facts

Prepare and independently review the smallest source amendment now: remove the unconditional fixed-code verification branch and withdraw both public raw OTP create/verify routes. Preserve legitimate server-generated authentication flows; introduce no replacement bypass, test flag or privileged raw-mint endpoint. This containment must not wait for the end of M0. The [OTP draft](M0_OTP_AUTHORITY_CONTRACT_DRAFT.md) retains the separate purpose, target, atomic-consumption, abuse and client contracts still required for complete remediation.

The narrow source amendment was committed and pushed as `aa1b15acc9317886d412b80778e824e17d470354` under the [urgent contract](OTP_URGENT_CONTAINMENT_CONTRACT.md). [Source-only evidence](../../../output/qa/m0-b/otp-containment-2026-11-10/source-verification.json) records baseline rejection, amended-source acceptance and seven rejected source reintroductions; [direct review provenance](../../../output/review/otp-containment-2026-11-10/REVIEW.md) is recorded separately. No runtime delivery, mounted-route, deployment or exposure conclusion follows from those checks.

The reviewed baseline exposes the fixed-code path through public authentication send/verify, including the accepted admin role, and separately mounts caller-chosen raw OTP creation/verification. These are confirmed source findings. The connected GitHub repository readback on 10 November identifies `nitianbit/SwasthaDisha`, repository ID `1452083010`, as **public**. This establishes public source visibility, not the deployed revision, exploitation or account access.

**Owner follow-up, 10 November:** asked what is publicly reachable, the owner replied “only images and public intended route.” Asked who controls deployment and protected auth/mail logs, the owner replied “me.” The project owner is therefore identified as the deployment and protected auth/mail-log access controller. This does not establish whether the intended public login send/verify routes are reachable or which revision is deployed; those specific facts have been requested. It is not permission to deploy, inspect protected data or invalidate challenges/sessions.

The earlier owner report was pre-launch with no real patients/payments on 9 November. Published app-store links do not establish a reachable backend or its source revision. Specific authentication-route reachability, deployed code, operational-log evidence and the effect of previously issued sessions remain **UNKNOWN**. No live endpoint was probed and no operational log, mailbox, credential or patient record was accessed for this decision.

If a reachable backend runs the vulnerable revision, the deployment owner must choose immediate containment: authorize the reviewed emergency patch through the known operating procedure, or restrict the affected authentication surfaces while the patch is validated. Do not leave a confirmed reachable bypass available merely to preserve a raw-route client. If exposure is still unknown, establish that fact urgently rather than treating the old pre-launch report as current assurance. Source fixes protect the running service only after deployment; they do not invalidate existing JWTs or repair historical disclosure by themselves.

## Named operating decisions still required

| Responsibility | Current owner/status | Required non-secret result |
| --- | --- | --- |
| Local source containment and review coordination | Development lead `/root`, `SOURCE_PATCH_COMMITTED_AND_PUSHED` | Reviewed source commit `aa1b15a`; runtime/operational remediation remains open |
| Reachability and deployed revision | Project owner, `SPECIFIC_AUTH_REACHABILITY_AND_REVISION_PENDING` | Logical environment, whether the auth surface is reachable, deployed source/build revision and check time |
| Emergency deployment or access restriction | Project owner controls deployment; `ACTION_AUTHORIZATION_PENDING` | Explicit target/change authorization, approved current procedure, bounded validation and safe fallback |
| Protected auth-log and session assessment | Project owner controls access; `REVIEW_AND_SESSION_DECISION_PENDING` | Authorized security reviewer, covered time range and telemetry gaps, findings/action status and an explicit session-invalidation decision |
| Outstanding legacy challenges | Operational decision requested from project owner; `INVALIDATION_DECISION_PENDING` | Authorized invalidation/cutover for pending challenges, including attacker-selected future expiries, before restoring exposed authentication |
| Historical mail-copy exposure | Project owner reports protected mail-log control; `MAILBOX_ASSESSMENT_PENDING` | Authorized security/mail-account reviewer and confirmation of mailbox-review access, access/forwarding scope, preservation and assessment status |
| Legitimate booking/payment staff notices | `UNASSIGNED_AWAITING_OWNER_RESPONSE` | Business-approved recipient capability, minimum content, purpose and retention before any replacement notice is implemented |

The owner has identified operational control. The lead has asked the remaining specific authentication-route reachability, logical-environment and deployed-revision questions. No external message, provider action, deployment, restriction, revocation or log review has been performed. Identifying access control does not establish completion or authorize a protected operational action.

## Operator validation and safe fallback

1. Verify the actual environment and deployed revision through protected deployment metadata; preserve relevant evidence before changes. Do not infer deployment from app listings or test the bypass against real accounts.
2. Bind the emergency change to its exact reviewed source hashes and target. Establish non-production application/DB/provider admission before executable checks; source comparison alone cannot establish successful login or denial. Validate legitimate generated-code login for supported roles/channels, wrong/expired/used proof rejection, withdrawal of both raw routes and absence of token or privileged effects on denial. Use synthetic identities and captured fake-provider effects, never operational patient accounts or databases.
3. The deployment operator separately authorizes and records the existing build/start/release procedure and checks its exact result. This decision adds no root dependency/runtime/start adoption and does not authorize an improvised PM2 command. If safe validation or deployment is unavailable while exposure is confirmed, retain the operator-approved access restriction.
4. Verify the running revision and restricted/withdrawn route behavior without secrets or real-account takeover attempts. If the release fails, keep a safe restriction or roll forward to a corrected patch; do not restore the vulnerable authentication path as an unrestricted rollback.
5. Record whether old tokens remain usable and whether the security owner requires their invalidation. Do not silently rotate signing keys, revoke accounts or clear sessions under source-edit authority.

Previously minted challenge rows also survive a source patch. Their provenance cannot be trusted merely because the raw route is now withdrawn, and attacker-chosen expiry may be far in the future. The operational owner must authorize scoped challenge invalidation/cutover before restoring an exposed environment, without treating old records as legitimate based on expiry alone. This record supplies no ambient-database cleanup command or authority to delete records.

The [C1 operating condition](../M0_START_APPROVAL_STATUS.md#c1-parallel-urgent-containment-decision), [C2 baseline](DEVOPS_BASELINE_REQUEST.md), C3 pre-import admission, existing test-scenario gates and named release owners remain authoritative. No local review alone grants live-system access.

## Protected retrospective review

The authorized security operator should preserve and examine available authentication, gateway/access and relevant privileged-action evidence for the exposed revision's actual time range. Assess raw OTP route usage, authentication issuance/verification patterns and subsequent sensitive actions, including privileged accounts. Correlate only through approved protected tooling. Do not add raw codes, bearer tokens, full request bodies, patient details or mailbox contents to Git, this chat or public reports.

Existing logs may not record a distinct fixed-bypass outcome. Missing entries or a search with no matches cannot establish that the bypass was unused; record the coverage and attribution limits. Report sanitized counts, time ranges, evidence references and action status. The security owner decides session/credential response and any further incident obligations from the assessed facts; this document does not assert compromise or that prior disclosure has been remediated.

The former secondary mailbox may retain earlier authentication and booking/payment content. Its account owner/security reviewer must assess historical access, forwarding/delegation and retention through protected access, preserve required evidence and decide permitted containment/remediation. Removing the CC does not delete those copies. No mailbox purge, forwarding change, account action or retrospective assessment is authorized or claimed here.

## Staff notices and diagnostic scope

The mail amendment removed the shared sender's automatic secondary recipient; existing callers' explicit recipients remain unchanged. Do not restore that implicit copy. If staff need booking/payment notices, review a separate explicit configured recipient and minimum business projection for those callers only. Authentication/OTP mail must never inherit staff recipients. No new staff recipient or notification policy is selected by this decision.

The owner clarified that the diagnostic-smoke approval at `41539ca749c8a9dbf49ecf43bcca00749eccfe3c` remains **unconsumed**: both preflights stopped before launcher invocation. It remains tied to that exact clean checkout and reviewed profile/hashes; a separate clean worktree or fresh review at a new HEAD is necessary. This is distinct from the earlier consumed first-smoke approval and its executed failure. This OTP decision runs no diagnostic smoke, starts no Docker daemon and changes no harness/network grants. Preserve the six staged Ruflo files and complete handover archive.
