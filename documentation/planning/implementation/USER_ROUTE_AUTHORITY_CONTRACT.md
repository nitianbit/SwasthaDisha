# User route authority contract

10 November 2026. Branch `m0/authority-next`; baseline `9ea963f1f7b51aadedcfa7fc9918eb39a2fd737d`.

**Status: pre-reviewed APPROVE WITH REQUIRED AMENDMENTS.** An internal Claude subagent reviewed `ad6d69d` (`aca52d0b…`); its amendments are applied here. This is not a named-owner approval.

Graph-indexed `bfb608e` matches the baseline for the user module, middleware, `common/` and `src1/routes/index.ts`. `auth/services/index.ts` differs there by one net line (the OTP crypto change), so its cited lines are from `9ea963f`. Production scope: `src1/modules/user/controller/index.ts` only.

## Defect in current source

`/api/v1/users` is mounted with `authenticate` only (`src1/routes/index.ts:58`). Its five routes (`user/routes/index.ts:19-52`) have no role guard. The controller constrains only `hr` (`user/controller/index.ts:16-42`). Tokens of type `user`, `specialist` and `pharmacy` reach the service with caller-chosen IDs and fields:

- `GET /` lists patients without a default limit (`controller:86-107`, `services:214-246`).
- `GET /:id` and `DELETE /:id` read or delete any patient (`controller:58-68`, `109-118`).
- `PUT /:id` updates any patient (`controller:70-84`). Rewriting another patient's `phone`/`email` lets the caller finish the generated OTP login as that patient: account takeover. The schema also admits `isActive`, `isVerified`, `isCorporateEmailVerified`, `corporateId` and `isCorporateUser` (`validation:112-123`). `isCorporateUser` plus a domain-matching email assigns `corporateId` without proof (`services:150-173`).
- `POST /` creates patients with arbitrary flags or `corporateId` (`controller:44-56`, `validation:54-63`).
- HR scope leaks two ways:
  - `forUser=true` replaces the corporate filter with `corporateId: {$exists: false}` (`controller:92-98`, `services:229-233`).
  - An HR token without a `corporateId` skips scoping on list and create, because `getHRCorporateId` returns undefined (`controller:16-18,47,92-93`). That field is optional on HR records and in the token (`hr/model:143-146`, `auth/services:391`); `requireAdminOrHR` already denies this case (`middleware/auth.ts:175-181`).

The collection stores only `userType: 'user'` (`user/model/index.ts:37-43`). Admin, HR and specialists are stored separately, so this is cross-patient takeover, not admin escalation. A patient token's `_id` is its document ID (`auth/services/index.ts:405-412`). The defect breaches the M0-B user/contact row and AR-26. Scenario: TC-SEC-002.

## Required behaviour

The actor is `req.user.userType` from the verified token.

| Actor | `POST /` | `GET /` | `GET /:id` | `PUT /:id` | `DELETE /:id` |
| --- | --- | --- | --- | --- | --- |
| No `req.user._id` | 401 | 401 | 401 | 401 | 401 |
| `admin` | unchanged | unchanged | unchanged | unchanged | unchanged |
| `hr` with `corporateId` | unchanged | unchanged; `forUser=true` → 403 | unchanged | unchanged | unchanged |
| `hr` without `corporateId` | 403 HR | 403 HR | 403 HR | 403 HR | 403 HR |
| `user`, `id === req.user._id` | n/a | n/a | existing 200 | existing 200; forbidden field → 422 | existing 200 |
| `user`, other ID or target-less | 403 | 403 | 403 | 403 | 403 |
| Any other or unknown type | 403 | 403 | 403 | 403 | 403 |

Errors use the existing `AppError`/`errorHandler` envelope `{error, message, code}`. Messages are fixed and echo no ID or value:

- 401 `UNAUTHORIZED`: "Authentication is required".
- 403 `FORBIDDEN`: "Access to this user resource is not permitted".
- 403 HR (`HR_CORPORATE_REQUIRED`): "HR account must be linked to a corporate".
- 403 `FORBIDDEN` for HR `forUser=true`: "HR can only access users from their own corporate".
- 422 `FORBIDDEN_FIELD`: "One or more fields cannot be changed through this endpoint".

Checks run in order: identity, actor/object (including HR corporate), forbidden fields, then the existing HR check and service. Each new denial happens before any `userService` or DB access, so it reveals nothing about whether a record exists. The retained HR path (`ensureHRCanAccessUser`) still reads the record first; its 404 still reveals existence.

On a `user` self-update, sending any of these keys is forbidden, whatever the value (rejected, not stripped; AR-26): `isActive`, `isVerified`, `isCorporateEmailVerified`, `corporateId`, `isCorporateUser`. Corporate membership stays with `/api/v1/auth/corporate-email/*`.

The five-key list is sufficient only because the shared validator strips unknown keys (`common/middleware/validation.ts:17-20`). That silently drops `otpVerified`, `referralCode`, `referredByUserId`, `linkedPharmacyId`, `createdSource`, `createdByRole` and `createdById` (`user/model/index.ts:126-177`). The silent drop is a residual AR-26 gap. The source check therefore pins the validator byte for byte.

## Amendment

1. Add a module constant `SELF_FORBIDDEN_FIELDS`.
2. Add three synchronous `void` private methods: `assertUserRouteActor(req, targetId?)`, `assertNoSelfPrivilegeFields(req)` and `assertHRListScope(req)`. The actor guard is an allow-list (`admin`; `hr` with `corporateId`; `user` with strict string `req.user._id === targetId`) ending in a default 403. It uses no cast, `await` or try/catch.
3. Wire the guards into the handlers:
   - `create` and `getAll`: the actor guard is the first statement of the handler body.
   - ID handlers: the actor guard immediately follows `const { id } = req.params;`.
   - `getAll` then calls the HR list guard; `update` then calls the field guard.

The exact text is frozen in the source check (`CONST_BLOCK` + `HELPERS`, SHA-256 `6bcedaf84c6acc8e7021df3575e89b79abc9e75d6de37fd33aa4eded8ba8fb1a`). Expected controller SHA-256: `25aef90efe3e5142011789dd48d55452d5b1fef9f2e56d70c355e7606e191d74`.

## Surfaces unchanged

- Joi validation (`400 VALIDATION_ERROR`).
- All admin behaviour, including flag/contact writes.
- HR corporate scoping and flag writes.
- Patient self-change of `phone`/`email`/`corporateEmail`, and patient self-delete.
- `/api/v1/auth/profile` and the auth verification flows.
- Direct `UserRepository` use in `pharmacyCustomers`/`pharmacies`.
- Success envelopes.

## Client-compatibility risk

Legacy `test/test-api.ts:545-557` updates the patient's own profile (`name`/`city`/`state`) through `PUT /api/v1/users/:id`; that call is preserved. The same suite's `GET /api/v1/users` with the login token (`:1581`) becomes 403. Supported client revisions are unverified ([baseline handoff](DEVOPS_BASELINE_REQUEST.md)). These clients would now be denied:

- patient clients that echo whole user objects into PUT, or call list/create;
- doctor or pharmacy clients that use this router;
- HR clients that send `forUser=true`;
- HR accounts that lack a corporate.

The denials are intentional. Obtain client facts before activation; do not reintroduce silent stripping.

## Source-data verification plan

The evidence is `output/qa/user-route-authority/source-check.py` (stdlib, `-I`, sanitized environment) and `source-verification.json` (argv, cwd, exit, stdout/stderr, candidate/pin/script hashes). The check reads the TypeScript as text.

**Before the edit:** the baseline is rejected (`HELPER_PRESENT`). **After the edit:** the amendment is accepted.

**Named semantic checks.** These run before every exact comparison:
- Lexical and structural: helper presence, signature and synchronicity; no try/catch; strict equality; fixed messages; forbidden-list completeness; raw `req.body` source; reject-not-strip.
- A closed vocabulary of literal condition atoms.
- A Python decision model built from those atoms and run over a synthetic actor/field/query matrix, which covers over-restriction: admin, own ID, admin `forUser`, and profile fields.
- Handler wiring: order and target.

Only after these do the byte pins run (user module, `middleware/auth.ts`, `errorHandler.ts`, `middleware/index.ts`, `validation.ts`, `asyncHandler.ts`, `routes/index.ts`, auth module, root manifests), followed by the `src1` diff scope and the exact controller match.

**Negative controls.** Each must be rejected by its intended named check, never by the exact comparison, and the receipt records that check:
- the baseline;
- actor guard removed or moved after the service, per handler;
- inverted, cast or loose ID comparison;
- identity disabled;
- target-less or no-target admission;
- non-`user` admitted;
- deny-list admitting unknown types;
- HR without corporate admitted;
- an ID-echoing message;
- async unawaited guard;
- try/catch wrapper;
- each forbidden field omitted, and over-reach;
- truthiness check, merged-data source, stripping;
- field guard misordered or applied to admin;
- HR denial removed, boolean `forUser`, admin `forUser` denied;
- admin denied, own ID denied.

`git diff --check` must pass. This proves source shape only; no TypeScript, compiler, suite, DB or provider is run.

## Runtime fixtures deferred until full C3 admission

- Patient A: own GET/PUT/DELETE succeed with unchanged envelopes; list/create 403; self-PUT with each forbidden field 422, A unchanged.
- A against B on every ID route: 403, B unchanged, zero repository calls; an attacker-contact OTP login cannot reach B.
- Specialist/pharmacy/unknown types: 403 everywhere.
- Missing principal: 401.
- HR without corporate: 403 `HR_CORPORATE_REQUIRED` on all five, zero DB access.
- HR own-corporate requests succeed; cross-corporate and `forUser=true` requests return 403.
- Admin behaviour is unchanged.
- Reintroducing each defect fails a mounted regression.

## Remaining risks and owner decisions (no code change here)

- Admin, or HR within its corporate, can rewrite a patient's `phone`/`email` and then log in as that patient. Dedicated, verified admin/HR commands for contact, verification, activity and corporate changes are needed (AR-26; product/security owner).
- `phone` is not unique (`user/model/index.ts:31-36`). A patient who sets their own phone to someone else's number may capture that person's OTP login, depending on lookup order (unverified). This needs the identity/security owner, with contact-change verification ([OTP draft](M0_OTP_AUTHORITY_CONTRACT_DRAFT.md)).
- Aggravating factor: specialist and pharmacy accounts can be self-created through public OTP signup (`auth/services/index.ts:147-157`), so any caller can obtain those token types.
- Retained patient self-delete is a hard `deleteOne` (`common/repository/BaseRepository.ts:74-76`). Keeping it is a data-retention owner decision.

This slice does not close TC-SEC-002, F03/F04 or M0-B. Scenario statuses are unchanged.
