# Individual customer verified contact change — milestone contract draft

13 November 2026. Author: internal Codex `/root/customer_remaining_audit`. DRAFT, not implementation admission. Baseline current focus HEAD `19ab450d159b241e9aa005f8b25dac816feebbd2`, customer source unchanged from merged snapshot `9debdd25ae4079fa73f5052afe3a0fd62d4feb0f`. Root must inspect and obtain two actual independent nonauthor contract decisions before freezing an implementation candidate. No author self-approval.

## Outcome and scope

A signed individual customer can replace or add one personal phone/email only after a fresh login proof for a currently bound contact and a distinct single-use proof delivered to the proposed destination. The server commits the contact, uniqueness keys, consumed proof and credential generation together. Previously issued customer tokens and pending old-generation customer proofs then lose authority. A delivery, wrong-code attempt or recovery request alone never changes contacts or invalidates existing sessions. Re-login through a remaining bound contact remains available; losing every contact requires a separately accountable identity-recovery process, not possession of a newly supplied number.

This is an account credential milestone, not permanent patient identity, patient/caregiver consent, duplicate-patient merge, clinical access or corporate/HR expansion. Staff-entered numbers remain contact hints; OTP possession does not grant a pharmacy-created account a patient relationship. Admin/HR/pharmacy/specialist role permissions and their login response contracts stay unchanged. No clinician, identity evidence, funding fact, deployment fact or provider capability is invented.

Reuse existing auth, OTP, user repositories, Joi, AppError, `randomInt`, Mongoose sessions, EmailService/SMSService and notification storage. Add no library, generic workflow engine, account service or parallel credential store. The existing individual email-verification route is a migration boundary, not an independent credential writer.

## Current source facts that the milestone must close

- `UserController.update` correctly restricts ownership and privilege fields, but personal phone/email still reach `UserService.update` without destination proof. User phone/email indexes are not unique.
- Auth email-verification already sends an email code and applies the verified destination, but OTP consumption and user update are separate writes and can race. It mints another 30-day JWT.
- OTP records have actor ID, target/value, expiry and consumed state, but no purpose, generation or attempt allowance. Existing generic lookups can select any matching purpose; new contact proofs must be excluded from them.
- `authenticate` and `authenticateOptional` currently accept a verified JWT without consulting current customer credential generation. No per-customer revocation primitive exists.
- Customer identity writers include AuthService signup, UserService create/update, the AuthRepository save wrapper and PharmacyCustomerService creation. Referral/address updates are noncontact writers and must not recompute or overwrite identity fields.

## One shared identity boundary, not several check-then-update implementations

Add a small pure `src1/modules/user/contactIdentity.ts` for normalization/derived contact keys and one explicit identity-write API in UserRepository. Reuse it at every existing user contact-creation/change site. Nonidentity BaseRepository uses remain unchanged. Do not override generic update to make every profile/address/referral call a contact migration.

Personal phone retains existing Indian login representation: exactly ten ASCII digits, no coercion or country-prefix inference. Personal/corporate emails use existing Joi syntax and trim/lowercase normalization; no mailbox/provider-specific alias folding. An empty/null destination is not contact deletion. New customer contact requests select exactly one of phone or email. Identical canonical current destination returns409 `CONTACT_UNCHANGED`; it is not a resend or implicit verification.

New internal User fields: `authVersion` (nonnegative safe integer, new users zero); `contactKeys` (deduplicated canonical `phone:<value>` and `email:<value>` keys from phone, email and corporateEmail); and a bounded `contactChangeState` containing active challenge ID, last-send time, fixed-window start/count. Keep these fields `select:false`; only explicit internal identity reads select them. Existing public profile/user responses must not leak them, proof codes or attempt counters.

Create/save paths derive keys after caller data and reject caller-supplied internal fields. Sensitive existing authorized admin/HR updates retain their permissions but use the identity API with expected generation, recomputed keys, generation increment and active-challenge removal when phone/email/corporateEmail actually changes. A losing CAS returns409 `CONTACT_CHANGED`; do not silently retry a stale privileged update. Noncontact updates do not write generation, keys or challenge state. Existing customer self-PUT must reject own phone/email keys after actor/object authorization with422 `CONTACT_CHANGE_REQUIRED`, including unchanged echoes; other profile fields remain useful. The dedicated replacement flow supplies the missing functionality.

Race-safe uniqueness requires one named unique multikey index on `{ contactKeys: 1 }`, `name: user_contact_keys_v1`, simple collation, partial filter `{ contactKeys: { $type: 'array' } }`. It enforces phone uniqueness and email-versus-corporateEmail conflicts across individual accounts; a preflight lookup is only an early friendly denial. Multiple same-account alias keys are deduplicated; existing same-pair business rules remain. Map only a verified collision on this exact index to409 `CONTACT_UNAVAILABLE`; unrelated driver/index errors propagate. Do not expose another account ID, source, patient data or matched field.

The manifest is new `src1/modules/user/contactIndexManifest.ts`; reuse the existing pure `evaluateIndexReadiness` contract through a separately reviewed bounded metadata reader. Do not activate schema auto-indexing, call `syncIndexes`, drop/rebuild indexes or mutate production startup. Existing noncanonical/duplicate/missing derived keys require a separately reviewed dry-run/backfill/create-only installation plan and owner-controlled migration; no automatic merge, record deletion or contact reassignment. A missing/in-progress/wrong/incomplete index observation returns503 `CONTACT_IDENTITY_NOT_READY` before contact dispatch. Readiness must cover all existing accounts and all identity writers; an empty manifest is never readiness. Actual replica-set transactions and exact unique-index behavior remain focused-test prerequisites.

## Fresh login and revocable customer sessions

Successful new individual-customer login issuance carries `authVersion`, `loginTarget` and `loginTargetValue` derived only from the actually consumed, current-contact login proof; the signed JWT `iat` supplies freshness. Include no proof code or challenge ID. All customer token issuers use one existing-auth helper to include current generation; email/corporate verification must not fabricate recent-login claims. Staff-role token payloads stay unchanged.

For both mandatory and optional authentication, an exact `user` token must have a primitive canonical account ID and a current User row; read the selected generation, fail closed on malformed state/read failure, and require token generation equality before `next`. Existing token/row missing generation is interpreted as zero only while the row has no nonzero generation; the contact endpoints still require explicit fresh-login claims. A customer with absent/inactive record is denied401. Unknown malformed role/principal does not acquire customer authority. Staff role decoding and guards remain byte-preserved outside necessary shared dispatch. Database failures yield503 `AUTH_STATE_UNAVAILABLE`, never anonymous fallback in optional authentication.

Individual-login OTPs gain explicit `purpose: customer_login`, `subjectType: user`, expected generation and target/value. Fresh individual login sends/consumes only this purpose and current identity; older unpurposed pending user challenges require a fresh code. Leave existing other-role OTP issuance usable through the legacy path, but generic legacy reads/consumes must exclude both new purposes. Purpose-aware creation invalidates only its own subject/purpose; it cannot delete a contact-change proof or another role's legacy proof. User login consumption and a conditional current-user/generation/target checkpoint share a session: an old proof cannot be relabeled with a newly read generation after a concurrent change. A token issued just before a later committed change remains safely stale. Do not change 30-day expiry or claim that this closes all login abuse/rate controls.

New contact commands additionally require an explicit customer login generation, verified login target/value equal to the current corresponding stored contact, and `iat` no more than ten minutes old or sixty seconds in the future. Otherwise401 `REAUTHENTICATION_REQUIRED`, with no code send or mutation. Existing remaining-contact OTP login is the normal recovery path. This strengthens account credentials only; it does not resolve recycled/shared-number patient binding.

## API and compatibility

Register explicit routes before the `/:userType/...` routes:

- `POST /api/v1/auth/contact-change/send`: authenticate, exact individual-customer guard, raw-body own-key allowlist, existing validation, controller/service. Body `{ target: 'phone' | 'email', targetValue: string }` only.
- `POST /api/v1/auth/contact-change/verify`: same actor/validation chain. Body `{ challengeId: '<24hex>', otp: '<6digits>' }` only; destination, actor, version, purpose and request state come from stored facts.

Unauthorized/missing/expired token retains existing401 behavior; wrong authenticated role403 `FORBIDDEN`. Raw foreign ownership/internal/purpose/version/code-on-send fields return422 `FORBIDDEN_FIELD` after actor validation, before Joi strips unknown keys. Invalid required scalar/shape returns400 `VALIDATION_ERROR`. Services recheck their typed/direct-call actor and input contract; request-supplied owner/filter/update operators never reach Mongo.

Send success202: `{ success: true, message: 'Contact verification requested', data: { challengeId, target, maskedTarget, expiresAt, resendAfterSeconds: 60 } }`. Verify success200: `{ success: true, message: 'Contact changed successfully', data: { token, user: { _id, phone?, email?, userType: 'user' }, reauthenticationRequired: false } }`. Responses use `Cache-Control: private, no-store`; no raw OTP/current-other-contact disclosure. Preserve the standard AppError envelope.

Existing individual `/email-verification/send` and `/verify` may continue verifying the already stored personal email under their existing response contract, but must not replace personal email through the old nonatomic writer. A differing requested/proven email returns409 `CONTACT_CHANGE_REQUIRED` directing the new flow; no proof is consumed and no corporate flags change. The new endpoints provide the replacement feature. Existing separate corporate-email commands retain their role/domain behavior and use the shared identity writer and token-generation helper when they touch the User record. This adds no corporate feature. Clients that previously changed phone/email via profile PUT or old email verification must use the new send/verify sequence; do not silently ignore fields. API_SCHEMAS records exact errors, retry instructions and new shapes. Client implementation/acceptance is separate and cannot be inferred from backend source.

## Challenge issuance and abuse bounds

Use the existing OTP collection for `purpose: contact_change`, `subjectType: user`, server-generated random six-digit code, fixed target/value, actor ID, expected authVersion, old target value/presence, and five remaining attempts. Expiry is exactly ten minutes from creation; never trust TTL deletion as expiry enforcement. Only this actor's current `contactChangeState.activeChallengeId` is usable. A resend creates a new ID and invalidates older proof authority through that pointer; no purpose-global deletion.

A transaction conditionally updates the same User row, checks current generation/contact snapshot and atomically claims the send allowance: at least60 seconds since last send, maximum3 issued contact challenges per fixed15-minute account window shared across destinations/devices/processes. Reset an expired window atomically; a losing concurrent claim receives429 `CONTACT_RATE_LIMITED` and bounded Retry-After. Store the proof and active pointer in that same session. Generation is not incremented by issuance. No provider call occurs inside the callback. After acknowledged commit send only to the stored proposed destination using existing EmailService or the existing approved OTP SMS template. Failure/unknown delivery consumes send quota and returns503 `CONTACT_DELIVERY_UNAVAILABLE`; do not claim nondelivery or immediately retry. A delivered code remains usable if the caller recovered its challenge ID; an unknown response is resolved by a later allowed resend. No real provider invocation follows from this document.

The per-challenge five-attempt cap and account send budget are cluster-shared; resends cannot create an unbounded account guessing allowance. Invalid-code attempts atomically decrement the bound stored counter before returning400 `CONTACT_PROOF_INVALID`; a terminal fifth failure removes/invalidates only that challenge's authority. Critically, do not throw inside a transaction in a way that rolls back the attempt decrement: commit a typed denial result, then map it to AppError outside. Unknown/foreign/obsolete IDs yield the same400 without consuming another actor's allowance. Expired consumed proofs also yield400 `CONTACT_PROOF_INVALID`; exhaustion/rate ceiling yields429. Account/current sessions remain usable after bad attempts. In-memory/IP-only counters are not the sole enforcement. Infrastructure/global destination-send abuse controls remain an activation concern; no global protection is claimed from these account limits.

Current OTP plaintext-at-rest representation is retained for compatibility; never log/export codes or put them into notifications/evidence. This contract does not claim resistance to protected database compromise or silently invent a new encryption key. If credential-storage policy requires keyed OTP storage before activation, freeze that independently rather than mislabeling an ordinary hash as protection for six-digit codes.

## Atomic application, notification and replay

Use one actual same-client Mongoose transaction for the selected customer User, OTP proof and one existing general Notification record. The service reads only the owned active proof and requires purpose/subject/target/value/generation/snapshot, remaining allowance, `isVerified: false`, valid expiry and correct code. Final conditional proof consumption includes observed expiry and a fresh callback checkpoint; final User predicate includes scalar ObjectId identity, exact userType, expected authVersion/missing-zero representation, active challenge ID and original target value/presence. No ownerless fallback/upsert or recovery by a newly supplied contact.

The final User write sets only the selected destination and authoritative derived keys, increments authVersion once and clears the active challenge ID. Do not turn general isVerified/otpVerified into a clinical/caregiver/whole-account proof. A final miss returns409 `CONTACT_CHANGED` inside the callback and aborts contact/proof/notice writes. Duplicate-key contact conflict aborts the same transaction and maps to the generic409 above. Proof comparisons and account mutation are never separated by a committed standalone consume.

Add one narrow NotificationService method using its existing repository save with `{ session }`, without FCM/provider effects, to store a `general` security notice with bounded masked text, referenceType `contact_change` and referenceId equal to challenge ID. Same transaction/generation conflict supplies single local event creation; existing idempotency index must be verified if idempotencyKey is used. No raw destination/code/JWT in notification payload. This is a durable in-app notice, not proof of out-of-band delivery. Actual notification to a previously verified safe email can reuse existing EmailService after commit; phone security-notice delivery needs an approved non-OTP SMS template/adapter contract. Do not reuse an OTP template with invented text or infer safety of every stored contact. Out-of-band destination selection/delivery readiness remains explicitly required for full activation, separate from the committed local notice.

Sign a replacement JWT from the committed new user generation/contact, using the same token builder and existing secret; only the newly verified destination may supply its recent-proof claim. Old tokens, including the request token, then fail their next admission. Request failures after commit, unknown commit and lost response do not undo a real change: client re-logins through the new destination or an unchanged bound contact and fetches profile. A repeated old token gets401; a freshly authenticated replay of the consumed challenge gets400 and causes no second generation increment, notice or send. No stored raw JWT or exactly-once API-response guarantee. An unknown transaction result is not an automatic replay with a new challenge or a contact rollback.

## Owned files and implementation sequencing

After contract review and exact input refreeze, three coherent dependent increments may be implemented/reviewed; none alone declares the feature complete:

1. Shared customer identity/generation/uniqueness primitives and all enumerated current identity writers; bounded pure normalization checks and separately admitted real index/transaction evidence.
2. Purpose-bound customer login/contact proofs, strict send/verify APIs, current-generation mandatory/optional admission, attempt/send limits and atomic apply/local notice.
3. Profile/email-verification compatibility, schema/client documentation and the focused success/denial/replay/race verification package; supported-client and safe-notice readiness recorded honestly.

Production ownership is limited to: `src1/modules/auth/{routes,controller,services,types,validation}/index.ts`; `src1/modules/auth/repository/index.ts`; `src1/modules/otp/{model,types,repository,services}/index.ts`; `src1/modules/user/{model,types,repository,services,controller}/index.ts`; new `src1/modules/user/contactIdentity.ts` and `contactIndexManifest.ts`; `src1/modules/middleware/auth.ts`; `src1/modules/pharmacyCustomers/services/index.ts` (existing individual customer creation only); and `src1/modules/notification/services/index.ts` (same-session local notice only). `API_SCHEMAS.md` is owned documentation. Existing `common/utils/indexReadiness.ts`, BaseRepository, provider adapters, package/lock/start, central mount and all other modules are read-only context. A future create-only index/backfill operator and executable fixture files require separately named contracts and review before edits; they are not implicitly owned by this draft.

Do not change constructor argument order or add another AuthService dependency when existing services suffice. Preserve other workers, original six staged files and the entire handover. Root owns shared integration/progress and exact evidence freezing; this author owns only this draft today. No source write/commit/merge/push/deployment, app/Node/compiler/DB/Docker/provider/model execution is admitted by this document. Codebase Memory MCP is owner-disabled and was not used.

## Required focused acceptance and negative controls

- Individual phone and email changes, adding a missing secondary contact, normalization, unchanged destination, and own-profile noncontact update; replay old email/profile client shapes receives explicit migration error. Existing staff-role positive/denial behavior remains unchanged.
- No/expired/foreign role/token; malformed principal/generation; optional-auth cannot downgrade stale/read-failed customer token to anonymous; legacy-zero compatibility; stale/absent fresh-login proof and future iat; current-target mismatch; account inactive/deleted. No send/mutation on admission denial.
- New purpose proof never authenticates generic login/email/corporate verification, and generic/foreign-purpose codes never change contact. Actor/destination/challenge/generation substitutions, missing/invalid expiry, consumed/superseded proof, same-code collision across actors and old pending user OTPs all fail.
- Wrong code allowance persists across requests and restarts; last failure invalidates only the challenge; parallel attempts cannot exceed the limit. Fifteen-minute/60-second boundaries and concurrent resends share one allowance and one active pointer; unknown provider delivery retains quota and causes no in-transaction provider call.
- Two users race for the same phone/email, including email-versus-corporateEmail and simultaneous signup/pharmacy-assisted/admin writers: only one identity owns the derived key; loser cannot consume a successful proof or mutate contact. Existing duplicates/noncanonical/missing-key/index-in-progress data is blocked by readiness with no automatic repair.
- Barriers between snapshot, proof claim and user write exercise concurrent contact/admin changes, resend, generation increment and login proof consumption; exactly one allowed change increments version once. Real stored scalar versus array/string/null cases cannot satisfy authority selectors.
- Force failures at proof consume, user update, unique collision, notification save, transaction retry and commit acknowledgment. Same-client/session evidence proves rollback where observed. A failure after acknowledged commit does not erase it. No provider runs inside retried transaction callbacks.
- All prior tokens and pending old-generation user proofs fail after committed change, while new/remaining-contact login and unchanged staff roles work. Readmitted replay adds no notice/generation/write; lost response recovers by current-contact login/profile without old-token grace.
- Real-source negative controls remove purpose, owner, expiry, attempt or generation predicate; omit unique index/readiness; restore direct contact PUT; move proof consume outside transaction; roll back wrong-attempt accounting; let optional-auth bypass revocation. They must fail behavioral assertions, not merely a source hash.

Typecheck, HTTP/Joi, actual Mongo/Mongoose/index/session/race/rollback, provider-recording and supported-client results are NOT_RUN. C2 root runtime/start adoption, complete C3 pre-import fixtures, independent source/composition reviews, clinical/privacy/security and release gates remain. Final cross-module integration and corporate/HR/hospital expansion remain DEFERRED_BY_OWNER.

## Ready versus dependent decisions

Ready for independent contract review: customer-only role boundary, new API contract, recent-login plus destination proof, purpose/generation revocation, owned writer inventory, account attempt/send limits, atomic-apply/replay semantics and minimal-code ownership above. These are proposed Root technical/product choices, not an assertion of existing implementation.

Must be frozen before affected source activation: authoritative create-only unique-index/backfill/readiness reader plus all-writer coverage; admitted same-client replica-set test profile; supported-client migration; safe out-of-band security-notice delivery (notably non-OTP SMS contract); duplicate/unverified legacy-account handling by accountable identity/security owner. Complete loss of all contacts and patient-binding evidence remain a separate accountable recovery design. No repeated request for withheld deployment facts is made; production adoption still needs its existing owner-controlled gates.

## Selected current source pins

Source data only, not an executable dependency closure. Rebind exact files before any source implementation; baseline annotations alone do not waive drift.

| Path | SHA-256 |
| --- | --- |
| `src1/modules/auth/routes/index.ts` | `1f3e6a8076fa0c8aa5f5edc1d95787fd955e81b40c6323a87a97197b54a73893` |
| `src1/modules/auth/controller/index.ts` | `2fd46a2824e9842eb820b2a49714245ccd521a7880612ae6b48c2b6e9aed4528` |
| `src1/modules/auth/services/index.ts` | `d59d5ea23df586fbbdb5b9c4615bcbe0b716f649bdc02f3738088f87b0fbae56` |
| `src1/modules/auth/types/index.ts` | `f6cbff24776d23b029244526d07d6a9af290aec66020d414469388c6f11118e9` |
| `src1/modules/auth/validation/index.ts` | `c0424a7bf6fb49226dec0aa39babec98221f50fcd842c4137120b8a30a3d3527` |
| `src1/modules/auth/repository/index.ts` | `20b03e2c59a33ff981fbfd8dbb3e04616974415e5f36c9db820e7702cd5129d5` |
| `src1/modules/otp/model/index.ts` | `9891e0b34bbd3b21502540d86a8001c4f666223ddb8628c2922a1953ede6506d` |
| `src1/modules/otp/types/index.ts` | `7ee33890ffbbfeefb0921fec4faf53c0af775b963e90202199a542c642ac15fd` |
| `src1/modules/otp/repository/index.ts` | `8d59e92cb0d019a2d777d9b794278f126714205dce774caee5cd6e96d14a6841` |
| `src1/modules/otp/services/index.ts` | `cf59555cb618ace73e78e7fb35ca5ce780075ed30d5c3f7c633b1777b4b07971` |
| `src1/modules/user/model/index.ts` | `8ab08c867008d9788fd2105b6ac840794fcd5d8b2c518de500119aa2536cf5c4` |
| `src1/modules/user/types/index.ts` | `91d4b48e4749d113733f471d64093c7269dffcf13bf48577c8dbc2edce7d5b71` |
| `src1/modules/user/repository/index.ts` | `e730c52b26fbc773bcf92673190b68fe00c91162cb97f37eac1570cbbb85c4e1` |
| `src1/modules/user/services/index.ts` | `e649883d1728b6a39a129d1cde08152628d7a8f13ba68da3de7764799f799290` |
| `src1/modules/user/controller/index.ts` | `25aef90efe3e5142011789dd48d55452d5b1fef9f2e56d70c355e7606e191d74` |
| `src1/modules/middleware/auth.ts` | `db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2` |
| `src1/modules/pharmacyCustomers/services/index.ts` | `ab1cc1893fc2c8e3c369120ae6f5d9393c30a0ecb1a7f59d0c6ca80165e8e386` |
| `src1/modules/notification/services/index.ts` | `dd343357282c5c80fb02da2913d9eaf1ec772e7df0daa39f9a4b0bfc87c9311d` |
| `src1/modules/notification/model/index.ts` | `ef6c56aec1cecaac2c0248b76faf1dd4721f4c00a45b2fa8f45c8b79836c1ca9` |
| `src1/modules/notification/types/index.ts` | `7c755170cacc5ce208c1522b152543ccbbefba3cc03a9f28f99a3d6d325a6b68` |
| `src1/modules/common/utils/indexReadiness.ts` | `050ecc993c862638cf4912bb854e04baa5d80241cb124e7831fc3c95a78db5bd` |
| `API_SCHEMAS.md` | `071c133ad9fc86cc561b18fb944d1a66b8ed5a10cfda2a4948e67d3da4a658b9` |
