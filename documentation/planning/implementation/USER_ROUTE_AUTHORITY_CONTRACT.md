# User route authority contract

10 November 2026. Branch `m0/authority-next`; baseline `9ea963f1f7b51aadedcfa7fc9918eb39a2fd737d`. **PROPOSED; preimplementation review required.** Traced files match graph-indexed `bfb608e`; the user router is `UserController`'s only inbound reference. Production scope: `src1/modules/user/controller/index.ts` only.

## Defect in current source

`/api/v1/users` is mounted with `authenticate` only (`src1/routes/index.ts:58`). Its five routes (`user/routes/index.ts:19-52`) have no role guard. The controller constrains only `hr` (`user/controller/index.ts:16-42`). Tokens of type `user`, `specialist` and `pharmacy` reach the service with caller-chosen IDs and fields:

- `GET /` lists patients without a default limit (`controller:86-107`, `services:214-246`).
- `GET /:id` and `DELETE /:id` read or delete any patient (`controller:58-68`, `109-118`).
- `PUT /:id` updates any patient (`controller:70-84`). Rewriting another patient's `phone`/`email` lets the caller finish the generated OTP login as that patient: account takeover. The schema also admits `isActive`, `isVerified`, `isCorporateEmailVerified`, `corporateId` and `isCorporateUser` (`validation:112-123`). `isCorporateUser` plus a domain-matching email assigns `corporateId` without proof (`services:150-173`).
- `POST /` creates patients with arbitrary flags or `corporateId` (`controller:44-56`, `validation:54-63`).
- HR `forUser=true` replaces the corporate filter with `corporateId: {$exists: false}` (`controller:92-98`, `services:229-233`), so HR can list every non-corporate patient.

The collection stores only `userType: 'user'` (`user/model/index.ts:37-43`). Admin, HR and specialists are stored separately, so this is cross-patient takeover, not admin escalation. A patient token's `_id` is its document ID (`auth/services/index.ts:405-412`). The defect breaches the M0-B user/contact row and AR-26. Scenario: TC-SEC-002.

## Required behaviour

The actor is `req.user.userType` from the verified token.

| Actor | `POST /` | `GET /` | `GET /:id` | `PUT /:id` | `DELETE /:id` |
| --- | --- | --- | --- | --- | --- |
| No `req.user._id` | 401 | 401 | 401 | 401 | 401 |
| `admin` | unchanged | unchanged | unchanged | unchanged | unchanged |
| `hr` | unchanged | unchanged; `forUser=true` → 403 | unchanged | unchanged | unchanged |
| `user`, `id === req.user._id` | n/a | n/a | existing 200 | existing 200; forbidden field → 422 | existing 200 |
| `user`, other ID or target-less | 403 | 403 | 403 | 403 | 403 |
| Any other type | 403 | 403 | 403 | 403 | 403 |

Errors use the existing `AppError`/`errorHandler` envelope `{error, message, code}` with fixed messages:

- 401 `UNAUTHORIZED`: "Authentication is required".
- 403 `FORBIDDEN`.
- 422 `FORBIDDEN_FIELD`: "One or more fields cannot be changed through this endpoint". No values are echoed.

Checks run in order: identity, actor/object, forbidden fields, then the existing HR check and service. Every denial comes before `ensureHRCanAccessUser` and any `userService` call. A denied request therefore reads and writes nothing, and no 404 can reveal whether a record exists.

A `user` self-update must not contain any of these keys, whatever their value: `isActive`, `isVerified`, `isCorporateEmailVerified`, `corporateId`, `isCorporateUser`. Such requests are rejected, not stripped (AR-26). Corporate membership stays with the existing `/api/v1/auth/corporate-email/*` verification flow.

Amendment: add two private `UserController` methods, `assertUserRouteActor(req, targetId?)` and `assertNoSelfPrivilegeFields(req)`, and an HR `forUser` denial in `getAll`. The actor guard is the first statement after parameter extraction in all five handlers. In `update`, the field guard comes second. No other files change.

## Surfaces unchanged

Joi validation (`400 VALIDATION_ERROR`, runs first); all admin behaviour, including flag/contact writes; HR corporate scoping and flag writes; patient self-change of `phone`/`email`/`corporateEmail`; `/api/v1/auth/profile` and auth verification flows; direct `UserRepository` use in `pharmacyCustomers`/`pharmacies`; success envelopes.

## Client-compatibility risk

Legacy `test/test-api.ts:545-557` updates the patient's own profile (`name`/`city`/`state`) through `PUT /api/v1/users/:id`. That call is preserved. The same suite's `GET /api/v1/users` with the login token (`:1581`) becomes 403. Supported client revisions are unverified ([baseline handoff](DEVOPS_BASELINE_REQUEST.md)). A patient client echoing whole user objects (flags/`corporateId`) into PUT, any client calling list/create, and doctor/pharmacy clients using this router would be denied. That is intentional: obtain client facts before activation; do not reintroduce silent stripping.

## Source-data verification plan

Retain `output/qa/user-route-authority/source-check.py` (Python stdlib, `-I`) and `source-verification.json` (argv, cwd, exit code, stdout, hashes, `typescript_evaluations: 0`). The recipe reads the controller as text through `git show 9ea963f:<path>` and asserts baseline SHA-256 `7822f77598b7ad7ff1fa7ab32fca35d19a973de5d98ba43fca276f477525c5fc`. It builds the expected candidate by exact string transforms and requires a byte-for-byte match.

1. **Before the edit:** the baseline is rejected (exit 1).
2. **After the edit:** the amendment is accepted (exit 0). Every handler calls the actor guard before `ensureHRCanAccessUser`/`this.userService.`; `update` calls the field guard between the actor guard and service; the HR denial precedes `findAll`. Other user-module files, `middleware/auth.ts`, `routes/index.ts` and the auth module match the baseline byte for byte.
3. **Negative controls**, each rejected:
   - the baseline;
   - actor guard removed (×5) or moved after the service (×5);
   - inverted own-ID comparison;
   - identity check disabled;
   - target-less `user` admitted;
   - non-`user` admitted as owner;
   - each forbidden field omitted (×5);
   - field guard before the actor guard, or after the service;
   - stripping instead of 422;
   - HR denial removed.
4. `git diff --check` passes.

This proves source shape only, not mounted behaviour, absent DB effects or client acceptance. No TypeScript import/evaluation, compiler, suite, DB or provider.

## Runtime fixtures deferred until full C3 admission

- Patient A: own GET/PUT/DELETE succeed with unchanged envelopes; list/create 403; self-PUT with each forbidden field 422, A unchanged.
- A against B on every ID route: 403, B's contacts/flags/existence unchanged, zero repository calls; an attacker-contact OTP login cannot reach B.
- Specialist/pharmacy: 403 everywhere; missing principal 401; admin unchanged; HR own-corporate success, cross-corporate and `forUser=true` 403.
- Reintroducing each defect fails a mounted regression.

## Open, not decided here

- AR-26 dedicated admin/HR commands for verification, activity, corporate assignment and HR edits to employee contacts.
- Verification of patient self contact-change, and phone uniqueness. These belong to the identity/security owner ([OTP draft](M0_OTP_AUTHORITY_CONTRACT_DRAFT.md)).

This slice does not close TC-SEC-002, F03/F04 or M0-B. Scenario statuses are unchanged.
