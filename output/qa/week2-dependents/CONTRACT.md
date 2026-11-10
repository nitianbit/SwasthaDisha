# Dependents: current owner or exact admin

10 November 2026. **DRAFT FOR TWO INDEPENDENT PRE-REVIEWS; NO SOURCE/EXECUTION
AUTHORITY.** Baseline `cca8a5b453a35ce8517694568bd4c5f82c029e7e`; branch
`m0/week2-dependents`; worktree
`/private/tmp/swasthadisha-parallel-p1qom53w/week2-dependents`.
Author `/root/auth_api_fixture_contract`. Current ownership is this contract only.
After both reviews and a lead assignment, the proposed production ownership is
only `src1/modules/dependents/controller/index.ts` and `routes/index.ts`, plus owned
QA source-data checks/evidence. Other agents share the repository; preserve their
work and the original six staged changes/handover archive. No push or integration
is authorized here.

## Authority selected by the existing ready-work queue

`PARALLEL_WORKSTREAMS.md` names dependents owner-or-admin containment next; HR
access needs a separate product decision. `M0_IMPLEMENTATION_APPROVAL.md` requires
actor/resource/field allowlists, safe 401/403 or scoped hidden-object 404, 422 for
forbidden fields after object authorization, and unchanged-state/zero-forbidden-
effect evidence. `PARALLEL_DEVELOPMENT_WORKFLOW.md` requires two direct nonauthor
contract and implementation reviews. The lead explicitly confirmed the precise
admin/404/owner-field boundaries below before this draft was frozen.

**Exact admin exception:** `userType === 'admin'` keeps the current validated
body-selected owner when creating on behalf of a user, unscoped listing, optional
owner filtering and access to any dependent. This is the existing owner-or-admin
technical containment choice; it is not clinical/product acceptance of a future
representative or delegated-care system. An ordinary `user` creates only for its
authenticated ID; every other role is denied. No HR/corporate override is added.

## Discovery, freshness and actual callers

Graph-first discovery used project `swasthadisha`, `search_graph` (35 results, no
pagination), exact controller/service snippets and inbound/both-direction traces.
`index_status` reports ready at the real SwasthaDisha root but at original checkout
HEAD `bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7`, not this integration baseline.
Controller inbound identifies its router; service/repository traces omit the
arrow/property call edges. Missing edges are not absence proof.

Read-only actual source/module-string checks then verified the mounted route,
every controller/service/repository/model/DTO/validator, common repository and
middleware, and `test/test-api.ts`. All 15 inputs below other than the separately
read BaseRepository implementation are byte-identical to graph-base source; the
implementation is separately pinned below. Actual source references to
`modules/dependents`, `DependentController`, `DependentService`,
`DependentRepository`, `DependentModel` and raw `collection('dependents')` show
only this router/controller/service/repository chain plus the central router
import/mount. No other direct source caller/writer was found by these checks.
Booking code stores/queries `dependentId` strings; it does not call this service or
repository. Booking/clinical authority is not repaired by this slice.

The actual seven routes are mounted at `/api/v1/dependents` behind existing
`authenticate`: POST `/`, GET `/`, GET `/user/:userId`, GET
`/user/:userId/active`, GET `/:id`, PUT `/:id`, DELETE `/:id`. The ID is `:id`;
graph route-label artifacts are not substituted for the actual registrations.

Current defects: create accepts body `userId`; ID read/update/delete trust an
optional query `userId`; path lists trust their path owner. General listing derives
the nonadmin token ID but admits every role and can fall back to an unscoped query
when that ID is missing. The service scopes ID lookup only when its optional owner
is truthy. Update/delete first use that lookup and then mutate by `_id` alone.
Ownership is absent from the current update DTO and has no reassignment API.

Observed client contracts, all read only:

- Repository `test/test-api.ts` creates with its current `userId`, lists normally
  and by current-user path, and updates/deletes with that same query owner.
- Local mobile checkout `/Users/shubham/Desktop/myewacare-mobile-app`, clean for the
  three inspected files at `db62e8a960a52ee5354d40d696e40924cccd0129`, was discovered
  via its own graph. `memberApi` lists without query, posts its payload, updates
  with `?userId=<current user>` and deletes by ID without a query. The actual
  `AddMemberScreen.onSubmit` supplies current-user ID on create, excludes `userId`
  from update data and supplies it only as the update query selector. Its generic
  `Partial<CreateMemberPayload>` update type can represent an owner field; such a
  body will now intentionally be rejected. These are observed source contracts,
  not proof of deployed/supported-client coverage or executed UI compatibility.

## Exact source pins

All paths in this table are relative to this baseline repository.

| Input | SHA-256 |
| --- | --- |
| `src1/modules/dependents/routes/index.ts` | `4a5a51619ea7c4d88941e8d06b3b4d74ac69c58842e4174b50d34bf26453c50a` |
| `src1/modules/dependents/controller/index.ts` | `ec3edf39cfdc7260ae2b165c6e05f164bf5fb677326d5b46c84da132cb253da2` |
| `src1/modules/dependents/services/index.ts` | `adc2f3cf156bfa807bf125904ecd83c8f84dee38a072c7b78d1e90c8822cc044` |
| `src1/modules/dependents/repository/index.ts` | `cda1c7463c2dae2b692e8f629c7395ef23f1af20340401fae63b186ba7960845` |
| `src1/modules/dependents/model/index.ts` | `6e517f2882822cfd587111a5fb5f1bf959a7cd2772026ccb943ad758e1b4071e` |
| `src1/modules/dependents/validation/index.ts` | `6174811e3981865a75ff4a3fb195c4be0ad5bb9b0645761b474b1532fda9030d` |
| `src1/modules/dependents/types/index.ts` | `ce0d110b55330c5dadd24fdbea2dd1313a818deb4828723a64b151334a9b8717` |
| `src1/routes/index.ts` | `50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056` |
| `src1/modules/common/repository/index.ts` | `6e13d4d0ced3ad40772c5b2c35034544fe49f0d7b715cf0309f954be7ab5cb77` |
| `src1/modules/common/repository/BaseRepository.ts` | `14a0fe5fdc9abd7a54b913bca4816a631b4bb263c11ad21ec37da0ee6c3f723a` |
| `src1/modules/common/middleware/validation.ts` | `8be55cee7485531491ff095ed1d9f36af443987690f22d04dd67ef9318a0a5ef` |
| `src1/modules/common/utils/asyncHandler.ts` | `59fe49db58678ef81242a654f7457f74b067b2583a3f8dc70918b61f50228bd9` |
| `src1/modules/middleware/auth.ts` | `db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2` |
| `src1/modules/middleware/errorHandler.ts` | `1e06885f2c5b8df8ed186dba28cd975aaf4f4d5233a2daa277e6b7f7b15fad51` |
| `test/test-api.ts` | `bdd96484db4d3c0da5d75c6f01626c758580ba4103a43a60e9b8aeafa99a95f7` |
| `API_SCHEMAS.md` | `e756a47d787f8548ba1d12296bbde88ba0ad959892d90fb106fa8bf3ea7deb95` |

Inspected mobile file hashes, outside this repository and unchanged here:
`memberApi.ts` `3d7dd6894f699e1213d68840d66d8ab4664923dc467d25112ed7b4e9fa3ea4ab`;
`memberTypes.ts` `a6b300ce4bad94af35814a9b808ba6f120df6eb12ca09c7016078f62b077f77d`;
`AddMemberScreen.tsx` `7e873dc9af905a399298c1bf50afd59d5da1d6cd5a3390a898c7b05a8589f639`.

## Proposed two-file transformation

The controller gets a shared actor/owner resolver. Principal `_id` must be a
nonblank string; missing, empty, whitespace-only, object/array or other nonstring
ID denies 401 `UNAUTHORIZED`. Exact `user` and `admin` roles are admitted; HR,
specialist, pharmacy, unknown and differently cased roles deny 403 `FORBIDDEN`,
even if their ID equals a stored owner. IDs are compared as exact strings; no
body/query/path value supplies principal authority or string coercion.

Register a router-specific synchronous actor middleware immediately after controller
construction and before all seven route registrations/validators. It forwards
errors with `next(error)`. Each controller owner resolver also validates the actor
before a service call; the controller does not rely on a truthy optional token ID.
The central `authenticate` mount and all other routers remain unchanged.

For a recognized optional query owner, ordinary users reject a different supplied
owner with 403 before lookup; otherwise the resolver always returns authenticated
ID. Exact admins retain the validated optional owner, including undefined. Query
arrays/objects and invalid legacy DTOs keep existing 400 `VALIDATION_ERROR` behavior
after actor admission. Unsupported extra query fields on routes that never use
them remain non-authoritative; no new selector semantics are introduced.

| Route | Ordinary `user` | Exact `admin` |
| --- | --- | --- |
| POST `/` | Existing required body `userId` remains; a different validated ID gets 422 `FORBIDDEN_FIELD` before duplicate lookup/save. Build a new DTO with server-derived authenticated `userId` after spreading allowed body fields. | Preserve validated body owner, including on-behalf creation; do not introduce an account-existence/membership lookup. |
| GET `/` | Resolve/deny explicit query owner first; pass nonoptional authenticated owner into `getAll`, including pagination/count paths. | Preserve optional owner or unscoped list/count. |
| GET `/user/:userId` and `/active` | Reject a different validated path owner with 403 before service lookup; pass authenticated owner. | Preserve requested validated path owner. |
| GET `/:id` | Resolve query owner before lookup, then existing `getById(id, authenticatedId)`. | Existing optional-filter/unscoped behavior. |
| PUT `/:id` | Resolve owner before any dependent lookup; call existing `update(id, validatedData, authenticatedId)`. | Existing optional-filter/unscoped behavior; owner reassignment is still forbidden. |
| DELETE `/:id` | Resolve owner before lookup; call existing `delete(id, authenticatedId)`. | Existing optional-filter/unscoped behavior. |

Scoped ID absence, including an existing dependent owned by someone else, remains
404 `DEPENDENT_NOT_FOUND`, message `Dependent not found`. Do not perform an unscoped
lookup just to distinguish an inaccessible resource. Explicit wrong owner selectors
get 403; this is distinct from hidden-object ID absence. Missing resources keep the
same 404, validated malformed IDs the same 400, and legitimate success status and
JSON envelopes remain byte-identical outside the added authority/data binding.

### Owner fields must not disappear during validation

Common validation uses `stripUnknown:true`; current update schema excludes
`userId`. Add a small async controller middleware for PUT only, after existing
ID validation and query validation but **before** body validation. It first
resolves the actor/query owner. When the raw body has an own `userId` property,
perform the existing owner-scoped `getById` to establish object authorization,
then throw 422 `FORBIDDEN_FIELD`, with a fixed safe ownership-change message.
Same-value, different, empty, null, numeric, object and array owner fields all
remain forbidden, for both user and admin. If the object is inaccessible/absent,
its scoped 404 precedes field rejection; a forged explicit query owner gets 403
before lookup. This prevents the raw field being silently stripped.

Without that raw field, the middleware forwards with `next()` and performs no
extra resource lookup; normal update retains the service's existing scoped fetch,
duplicate checks and update. Query validation moves ahead of body validation on
PUT to make this preflight safe; simultaneous malformed body/query can select a
different 400 message, while the stable status/code and valid DTOs are preserved.
There is no new writable owner field, transfer command or mutation of `req.user`.

No service/repository/model/type/validation/common-middleware change is proposed.
Keep all descriptive fields, relationship aliases, `Me`/active-name duplicate
rules, soft activity field, timestamps, hard-delete behavior and filters unchanged.
In particular, current nonpaginated owner-list helpers return active records even
when the general `isActive` filter asks otherwise; fixing that existing query
quirk is outside this authority patch. Pagination must remain owner-scoped for
both returned rows and count. No new index, monetary unit, provider or side effect
is added. The model remains `Dependent` / `dependents` with required String owner.

Owner immutability is the bounded current-HTTP assumption: no supported route or
other direct source writer reassigns it. This patch does not turn the service's
separate read/update/delete into a transaction or claim safety against out-of-band
database owner rewrites. Any future ownership transfer needs its own atomic/state/
clinical contract. Booking use of arbitrary dependent IDs, consent, independent
patient identity, relationship-policy changes, retention and caregiver grants
remain separate; none is inferred from an account's family record.

## Source-only acceptance plan after both pre-reviews

Write an inspected stdlib-only Python verifier that treats TypeScript as bytes.
Pin baseline/contract/unchanged inputs and permit exactly the two production files
plus owned QA. Retain actual baseline rejection before editing, exact reviewed
transformation acceptance afterward, whole-tree/protected-file preservation and
negative variants. Variants must remove/reorder router admission, weaken principal
or exact-role checks, accept HR/other roles, restore body-selected user ownership,
drop/misplace post-spread owner binding, remove mismatch rejection, restore query/
path owner authority or optional/unscoped calls in each ID handler, unbind list/
pagination/count owner, drop raw-owner presence or object-authorization checks,
move preflight after stripUnknown, or change error/success behavior. Check exact
registration/order for all seven handlers and unchanged service/repository/schema.

These prove the source transformation and its sensitivity only. No copied
controller/service, extracted TypeScript execution, fake verifier or parser-only
result may count as HTTP/DB authority evidence. Keep all runtime cases NOT_RUN.

## Required later actual HTTP/DB evidence

Use real signed JWTs, actual mounted router/Joi/TypeDI/service/repository and an
admitted owned MongoDB with at least two owners and active/inactive dependents.
No operational env, patient records, provider or full server import is allowed.
Every denial must have exact `{error,message,code}` with no resource/token data,
unchanged scoped and non-scoped rows/timestamps, zero writes and zero forbidden
provider attempts. Authorized writes must affect only the intended owner's row.

| Required group | Concrete assertions |
| --- | --- |
| Legitimate owner | Own create/list/paginated list+count/by-user/active/ID read/update/delete, with absent or same optional owner; preserve observed mobile create/update/delete contracts and successful envelopes. |
| Exact admin | All seven routes, on-behalf create, unscoped and owner-filtered listing/count, filtered/unfiltered ID operations; no new ownership-transfer capability. |
| Forbidden roles | HR, specialist, pharmacy, unknown and differently cased admin on all seven valid request shapes: 403 before any dependent lookup/write/provider action, even with an owner-equal ID. |
| Invalid principal | Anonymous/invalid/expired JWT; signed missing/empty/blank/object/array principal IDs: 401, never a fallback list. No operational token/key is used. |
| Explicit owner forgery | Other owner on both path lists and each recognized query-owner route: 403 before DB access; ordinary create body other owner: 422 before duplicate lookup/save. |
| Hidden object | Other-owner ID GET/PUT/DELETE with omitted or own query owner: scoped 404; truly absent IDs same 404; malformed hex IDs 400. No hidden-object bytes in errors. |
| Ownership fields | PUT userId equal/different/empty/null/number/object/array: own authorized object 422; inaccessible/absent object first 404; forged query first 403. No stripping or transfer, including admin attempts. |
| Preserved validation/state | Missing create owner remains 400, valid relationship aliases and field rules unchanged, duplicate `Me` and duplicate active name/relationship retain current 400 codes. Preserve existing active-filter quirks rather than inventing a policy. |
| Reintroduced defects | Actual manifested source mutants restoring arbitrary-owner creation, unscoped ID access, path-owner trust, missing list principal, forbidden-role admission and raw-field stripping must fail these real assertions. Nominal source restored between phases. |

The already prepared auth/user/wallet fixture does **not** admit this router or
the Dependent model. Extending its source/model/port/index/case/sensitivity manifest
requires a separate reviewed fixture amendment and exact invocation decisions.
No npm, compiler, application/TypeScript, Docker, driver/DB or provider execution
is authorized by this contract or these source-only reviews. No clinical/product
decision blocks this bounded existing owner/admin containment; those missing
decisions block broader HR/caregiver/booking/clinical semantics. C2 production
facts, full C3/M0 acceptance, deployment, load and named release gates stay open.
