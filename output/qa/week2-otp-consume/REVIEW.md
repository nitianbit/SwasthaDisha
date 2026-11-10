# Atomic OTP source slice: direct reviews

10 November 2026. Baseline `1b0a54144d514bd73f03a99724c8b0d02fcfa25a`; author `/root/auth_api_fixture_contract`; branch `m0/week2-otp-consume`. These are internal Codex technical decisions, separate from named security/product/clinical/finance, runtime, deployment and release acceptance.

## Contract revisions and pre-reviews

The lead requested replacing the initial server-clock `$expr`/`$$NOW` proposal with the existing portable verification-service-clock policy. The final contract uses exact observed-expiry equality and a fresh service Date in the conditional update, plus a final live-expiry check before proof return. No MongoDB version or database-clock guarantee is selected.

The Standards pre-review requested one further clarification: bound login lookup preserves 404 for unbound/mismatched destination without fallback; only an optional-target caller that actually selects an unbound row gets 400 `OTP_UNAVAILABLE`. The explicit command payload changes only verification state, while existing model-managed timestamps may update. These points were amended before source edits.

Both nonauthors approved final contract SHA-256 `2dc40e1b6d40a735a030415e1ff96d3691c1a8ac29fbb86cda98c0b0f5162e3a`, inspected actual callers and all eight frozen inputs, and confirmed no production edits existed at that time:

| Reviewer | Assigned scope | Decision |
| --- | --- | --- |
| `/root/backend_boot_path` | Standards/safety | **APPROVE_CONTRACT_SOURCE_ONLY**, earlier error-order/timestamp finding resolved |
| `/root/local_claude_review_prep` | Spec/compatibility | **APPROVE_CONTRACT_SOURCE_ONLY**, including supplied-empty versus omitted destination, optional-email compatibility and checkpoint limits |

## Source-data verification

The actual pre-edit sanitized Python command returned 1 at the unchanged repository's missing transformation. After editing, the first source-control run found an ambiguous mutation locator shared with unchanged email callers; it was restricted to the login block. That checker correction changed no production byte. The final command accepts the exact three-file source transformation, reconstructs/rejects the baseline and rejects 25 source variants. It pins the contract and untouched source inputs and checks the complete changed/untracked scope, including ignored files.

Command from the owned worktree:

`env -i PATH=/usr/bin:/bin TMPDIR=/tmp /opt/homebrew/bin/python3 -I -B output/qa/week2-otp-consume/verify-source.py`

These are exact source-transformation and scope checks, not execution of an OTP state machine or MongoDB operation. They do not establish real concurrent single-use behavior, mounted HTTP/JWT/client compatibility, clock scheduling or actual zero-provider effects. The contract's real DB overlap/expiry/target and losing-request side-effect cases remain **NOT_RUN** until separate C2/C3 profile/fixture admission.

| Frozen implementation artifact | SHA-256 |
| --- | --- |
| OTP repository | `8d59e92cb0d019a2d777d9b794278f126714205dce774caee5cd6e96d14a6841` |
| OTP service | `cf59555cb618ace73e78e7fb35ca5ce780075ed30d5c3f7c633b1777b4b07971` |
| Auth service | `d59d5ea23df586fbbdb5b9c4615bcbe0b716f649bdc02f3738088f87b0fbae56` |
| Verifier | `f9adfa0154d132f1b9ef5baeb9f10ba90ae4d8cfb68f4c929a485707ceebf840` |
| Receipt | `12f856a350eb71d2905483d9ece9f3abb97d958c0c23cb41ba84fc3f91261a4e` |
| Full-index production diff | `463c22aa397d0dbd6d14181375ff795b56c254e1356d2d9d09bbd93fad9adbe0` |

## Implementation decisions

Both independent nonauthors returned **APPROVE_SOURCE_ONLY** on the exact artifacts above:

| Reviewer | Assigned scope | Decision and evidence |
| --- | --- | --- |
| `/root/backend_boot_path` | Standards/safety | **APPROVE_SOURCE_ONLY**; inspected all three source changes, BaseRepository/model/callers, exact CAS and fresh final expiry checkpoint; independently reran the inspected sanitized Python verifier, confirming baseline plus all 25 controls rejected and full scope/hashes unchanged. No material finding. |
| `/root/local_claude_review_prep` | Spec/compatibility | **APPROVE_SOURCE_ONLY**; inspected actual callers/schema and complete diff, destination/phone precedence, optional-email and safe error behavior; independently reran the same inspected source-data command with matching hashes and 25 rejected controls. No material finding. |

The lead accepted both actual direct reviews and authorized this local source-only commit. No application, extracted TypeScript, compiler/build/start, DB, provider or Docker code ran. No source outside the three contracted files changed. The broader F03 purpose/resend/attempt/storage/contact/session policies remain open; this is not full OTP/M0 or deployment acceptance.
