# M0 OTP authority contract draft

**Urgent containment addendum, 10 November:** the owner's independent review prioritized the fixed-code bypass and public raw challenge API ahead of the remaining M0 work. The [urgent contract](OTP_URGENT_CONTAINMENT_CONTRACT.md) supersedes deferral of those two narrowly scoped source changes; the [operating decision](OTP_EMERGENCY_OPERATING_DECISION.md) governs the unresolved exposure/operator handoff. This broader lifecycle draft remains unapproved for its other implementation. The route descriptions and fourteen source hashes below describe their explicitly recorded historical baseline, not the amended candidate. No runtime or scenario acceptance is implied.

**10 November 2026 — DRAFT_NOT_APPROVED_FOR_IMPLEMENTATION.** Static baseline: `5aecb5578869995063eabad5bc5a4c95c79f017b`, branch `m0/f01-app-isolation`, active `nitianbit/SwasthaDisha` checkout. This records current paths and missing decisions for the next bounded review. It changes no OTP source, schema, API or scenario status.

The [M0 command-authority contract](../M0_IMPLEMENTATION_APPROVAL.md#current-command-authority-contract-for-m0-b), [AR-26](../SYSTEM_DESIGN.md#10-api-contract-and-compatibility), [C2/C3 conditions](../M0_START_APPROVAL_STATUS.md) and [development workflow](PARALLEL_DEVELOPMENT_WORKFLOW.md) govern subsequent work. Existing start authorization does not approve an unseen OTP implementation or its execution.

## Current routes and fields

`configureRoutes` mounts `/api/v1/auth` and `/api/v1/otp` without mount-level authentication. The four contact-verification auth routes below add `authenticate`; the login pair and both raw OTP routes do not. The raw router exposes create and verify, not a complete CRUD API.

| Current POST path | Current actor and exact inputs | Current call and result | Required boundary / unresolved denial mapping |
| --- | --- | --- | --- |
| `/api/v1/otp/` | Public; body `userId`, `otp`, `target`, optional `targetValue`, `expireAt` | `OTPController.createOTP` → `OTPService.createOTP`; replaces one existing unverified match, saves supplied code/expiry and returns `data.otp` containing the row | Public callers cannot mint valid caller-chosen codes, identity or expiry. Withdrawal mechanism and supported-client error/migration mapping require review; admin-only raw mint is not selected as a replacement |
| `/api/v1/otp/verify` | Public; body `userId`, `otp`, `target`; controller forwards no `targetValue` | `OTPController.verifyOTP` → `OTPService.verifyOTP`; marks row verified and returns `data.otp`; this route itself does not issue a login token | No caller-selected identity proof or raw challenge-row disclosure. Determine legitimate callers and withdrawal/denial mapping before route edits |
| `/api/v1/auth/:userType/send` | Public; param `userType` in `user`, `admin`, `specialist`, `hr`, `pharmacy`; body `phone` and/or `email` | `AuthController.sendOTP` → `AuthService.sendOTP`; derives identity, generates code, stores challenge, dispatches SMS/email; returns `success` and `message` | Retain server-generated legitimate login/signup flow; callers cannot supply internal `userId`, raw `otp`, `expireAt`, verified state or recipient authority. Freeze both-contact precedence, target binding and abuse/error behavior |
| `/api/v1/auth/:userType/verify` | Public; same param/contact fields plus required `otp` | `AuthController.verifyOTP` → `AuthService.verifyOTP` → OTP verifier; on success returns `data.token` and `data.user` | Exact identity/target/purpose proof and one consume must precede token/privileged effects. Preserve inactive-account denials; invalid proof must not trigger identity verification, wallet creation or login notifications |
| `/api/v1/auth/email-verification/send` | Authenticated; `req.user._id`; body `email`, optional `isCorporateUser` | `sendEmailVerificationOTP`; normalizes candidate contact, checks availability/domain as applicable, stores challenge and sends email; returns message | Actor ID comes from principal; candidate contact does not itself prove ownership or corporate membership. Freeze contact-change and corporate compatibility contract |
| `/api/v1/auth/email-verification/verify` | Authenticated; `req.user._id`; body required `otp`, optional `email`, `isCorporateUser` | `verifyEmailVerificationOTP`; reads verified challenge target, changes email/verification and possibly corporate fields, returns `data.token` and `data.user` | Require purpose/target/actor-bound proof and authorized contact change. Request flag/domain alone cannot supply corporate authority. Optional target and credential-revocation behavior need review |
| `/api/v1/auth/corporate-email/send` | Authenticated; `req.user._id`; body `corporateEmail` | `sendCorporateEmailVerificationOTP`; candidate differs from personal email, availability and active corporate-domain checks, challenge and email; returns message | Preserve intended target; possession of a domain email is not a general membership policy. Exact eligibility/assignment authority remains to be frozen |
| `/api/v1/auth/corporate-email/verify` | Authenticated; `req.user._id`; body required `otp`, optional `corporateEmail` | `verifyCorporateEmailVerificationOTP`; consumes email-target challenge, updates `corporateEmail`, `isCorporateEmailVerified`, `corporateId`, returns token/user | No cross-purpose reuse or request-selected membership; review membership assignment and existing-client mapping before affected edits |

The validators permit at least one of `phone`/`email`, including both; the login service chooses phone when present. Shared `validate` strips unknown fields and emits `400 VALIDATION_ERROR`. That is current behavior, not implementation of AR-26's explicit forbidden-field `422` after object/action authorization. A global validation change is outside this draft. Auth contact DTOs do not contain `userId`; the raw OTP DTOs do.

## Statically confirmed lifecycle gaps

- `OTPService.verifyOTP` has an unconditional fixed-code branch that finds an unverified row without matching its stored code and skips expiry. No deployment/test flag gates that branch. The literal is deliberately omitted here.
- Login creation records a normalized `targetValue`; login verification passes only `userId`, `otp`, `target`. Raw verification also omits target value. Contact-verification targets are optional on verification; when absent, repository predicates omit them.
- Persistence has `userId`, `otp`, `target`, `targetValue`, `expireAt`, `isVerified` and timestamps, with no purpose field. Login, personal-email and corporate-email challenges use the same email-target store. Purpose isolation is therefore not established by these predicates.
- Verification reads a row, checks `isVerified`/expiry/code in application code, then `markAsVerified` updates only by `_id`. It does not atomically predicate on unused state, expiry, target or purpose. Concurrent single consumption is not established.
- Creation finds/deletes one existing unverified match then saves separately; the compound lookup indexes are not declared unique. Concurrent resend/replacement and delivery-failure recovery need a contract. The service's default lifetime is ten minutes; auth send methods omit `expireAt`, while messages display `CONFIG.OTP_EXPIRY_MINUTES`. TTL cleanup does not replace expiry validation at verification time.
- Codes are stored directly; generation uses `Math.random`. No attempt counter or purpose/version field appears in the inspected OTP model. No route-local limiter is registered in the two inspected route files; wider middleware/infrastructure abuse controls were not established by this trace.
- Generated login can create user/specialist/pharmacy identity rows before delivery; admin/HR missing identities are rejected. Successful login can verify user fields, initialize a wallet and create notifications before returning a token. Provider failure and post-consumption failure recovery therefore require explicit fixtures; a pure verifier unit alone cannot certify the mounted flow.

## Already established safety boundaries

The approved M0 authority packet requires server-generated bounded purpose/target-bound challenges, no public caller-chosen mint, no fixed bypass or reused proof, and no unapproved secondary sensitive-mail recipient. Invalid proof grants no login/contact/corporate authority. Preserve legitimate generated login and inactive-account denials. The separately reviewed [mail-recipient source slice](M0_MAIL_RECIPIENT_CONTRACT.md) is not OTP lifecycle acceptance.

These boundaries do not select new administrator privileges, numerical rate limits, storage/pepper scheme, contact-recovery policy, corporate membership policy, API deprecation response or schema migration. The following facts must be resolved in the next contract review:

| Missing fact/decision | Owner and latest safe gate |
| --- | --- |
| Enabled patient, doctor, pharmacy, HR/admin client revisions and any legitimate raw-route use; both-contact and omitted-target requests | Product/client/backend, using the [baseline handoff](DEVOPS_BASELINE_REQUEST.md), before affected route/DTO compatibility freeze |
| Login versus personal-contact versus corporate-contact purpose, challenge reference/version, issuance/consume/resend state and post-consume failure recovery | Backend/security, before schema/repository/service changes |
| Cryptographic generation, protected verification storage, retention and legacy-row invalidation/migration | Security/backend, before credential-storage migration or activation; no real keys in fixtures/docs |
| Cluster-wide issuance/attempt/resend limits, abuse continuity and safe error/enumeration mapping | Security/product/backend, before bounded public challenge contract acceptance; values are not guessed here |
| Completed contact-change recovery, affected-credential revocation and current corporate eligibility/assignment authority | Identity/security/product and corporate authority owner, before those flows change or activate |
| Complete owned app/DB/provider/queue/timer/file/network admission | Backend/QA, before any application import, extracted-method execution or integration fixture |

## Smallest next review and required evidence

Review a narrowly frozen **login challenge and verifier contract first**, including removal of the fixed bypass and withdrawal of raw mint/verify authority. Inspect all existing OTP callers before changing a shared verifier. Separate any contact/corporate assignment repair into its own reviewed contract; no unreviewed membership policy may ride on a login fix. This draft alone approves none of those source amendments.

Offline work can compare source/DTO/route evidence and prepare synthetic decision tables without evaluating production code. After implementation and its own admission review, meaningful fixtures must cover:

- Server-generated issuance for each supported identity role/channel, intended-target delivery and unchanged documented success envelope; no supplied code/user/expiry or secondary recipient.
- Wrong, expired, fixed-bypass, used, superseded, wrong-target, wrong-purpose and wrong-actor proofs: no token or privileged identity/corporate/wallet/notification effects and zero forbidden provider calls. Purpose isolation must include personal/corporate/login cross-use, not only distinct targets.
- Concurrent verify and resend/verify races: one authorized consumption/effect, reviewed terminal or recoverable result, no resurrection on replay, and a deterministic fake clock at expiry boundaries.
- Supported-client optional/both-contact behavior, inactive accounts, issuance/provider failures, failure after consume and retry; bounded abuse controls with explicit approved fixture limits.
- Reintroduction of each corrected critical defect must fail an appropriate regression. A stubbed verifier, saved HTTP response or source grep is not runtime evidence.

Keep TC-SEC-001, TC-REV-001/002 and affected scenario rows at their actual recorded outcomes; no new execution is recorded here. C2 root dependency/runtime/build/start adoption, full C3, F01/M0 acceptance, named-owner decisions, deployment and release remain separate.

## Source inventory

Graph project `swasthadisha` reported the active path and baseline HEAD above. Symbol discovery/snippets were followed by exact route/validator/model reads where graph relationships were incomplete. SHA-256 values bind this static draft; subsequent edits require fresh inspection.

| Source | SHA-256 |
| --- | --- |
| `src1/routes/index.ts` | `68cd160c9b344c652fac8b4b56c8a26135b1764ab88a0ec656f6e1a370ee5639` |
| `src1/modules/auth/routes/index.ts` | `1f3e6a8076fa0c8aa5f5edc1d95787fd955e81b40c6323a87a97197b54a73893` |
| `src1/modules/auth/controller/index.ts` | `2fd46a2824e9842eb820b2a49714245ccd521a7880612ae6b48c2b6e9aed4528` |
| `src1/modules/auth/services/index.ts` | `cfdc147df14c4bb9f9974d7211a8cabc3b3af5af2a4ec562a71c2bcaadbe03ad` |
| `src1/modules/auth/types/index.ts` | `f6cbff24776d23b029244526d07d6a9af290aec66020d414469388c6f11118e9` |
| `src1/modules/auth/validation/index.ts` | `c0424a7bf6fb49226dec0aa39babec98221f50fcd842c4137120b8a30a3d3527` |
| `src1/modules/otp/routes/index.ts` | `58c9a700511f1f20f84a28fa07fb0d7eeda93dc395a7f3dcf3001da049d019c7` |
| `src1/modules/otp/controller/index.ts` | `35210959387837e201c8427f32804eedc40c3a574aaf5b0af06fba812a4cba93` |
| `src1/modules/otp/services/index.ts` | `5ad862c456c9e02e45965d81a67c12411539df45d8b3c0abed48afa21522dd64` |
| `src1/modules/otp/repository/index.ts` | `5f68f9616f26f9ed8ebe66354d90d5fb25e95c35f9a3f56bec8f6f1a7c4c1306` |
| `src1/modules/otp/types/index.ts` | `7ee33890ffbbfeefb0921fec4faf53c0af775b963e90202199a542c642ac15fd` |
| `src1/modules/otp/validation/index.ts` | `1fa0e519bfd273bc5dc48631353306d7171c0ac823d2860a1fb6572141895a4d` |
| `src1/modules/otp/model/index.ts` | `9891e0b34bbd3b21502540d86a8001c4f666223ddb8628c2922a1953ede6506d` |
| `src1/modules/common/middleware/validation.ts` | `8be55cee7485531491ff095ed1d9f36af443987690f22d04dd67ef9318a0a5ef` |
