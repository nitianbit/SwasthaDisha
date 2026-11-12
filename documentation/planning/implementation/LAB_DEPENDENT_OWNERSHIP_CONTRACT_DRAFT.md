# Individual lab booking dependent ownership — draft

12 November 2026. **DRAFT ONLY; two independent nonauthor Spec/Standards preimplementation decisions are required.** Author: internal Codex `/root/customer_booking_writer`. Root owns Git/integration. This document authorizes no application edit or execution; the R4 combined review snapshot remains frozen.

## Scope and supported requirement

Repository `nitianbit/SwasthaDisha`; durable branch `m0/customer-pharmacy-lab-focus`, worktree `/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab`; observed HEAD `161537a34b9cfecf3499b39e2d8624d641009cf7`. External controller baseline SHA-256 is `b036cc91db6abf4cecfc2963fa02ab04b12bd8c8048c7c979468080a778942ce`. Preserve the current booking controller `c3b500…`, pharmacy service `54bbff…`, all earlier evidence/operator/recovery artifacts, and the original checkout's six staged/working files, patch and eleven handover files.

Read [current progress](M0_A_PROGRESS.md), [focused scope](CUSTOMER_PHARMACY_LAB_PLAN.md), [execution direction](CUSTOMER_PHARMACY_LAB_EXECUTION.md), [source gaps](CUSTOMER_PHARMACY_LAB_GAPS.md), [association contract](LAB_INDIVIDUAL_ASSOCIATION_CONTRACT_DRAFT.md) and [parallel workflow](PARALLEL_DEVELOPMENT_WORKFLOW.md). Final cross-module integration remains DEFERRED_BY_OWNER; focused checks and C2/C3 are separate gates.

Existing design supports a narrow account relationship check: [SYSTEM_DESIGN §5](../SYSTEM_DESIGN.md#5-business-tenancy-patient-identity-and-access), lines 115–133, requires explicit own/represented relationships and distinguishes payer from patient; [TC-SEC-002](../qa/TEST_SCENARIOS.md), line 39, requires object isolation. [ROADMAP](../ROADMAP.md), lines 77 and 139–140, requires the correct lab patient link while retaining permanent-patient/consent work. [CAPABILITY_MATRIX G01–G03](../CAPABILITY_MATRIX.md) explicitly identifies existing account/dependent records and missing permanent-patient/caregiver-consent capabilities. Ownership is a necessary account-binding condition, not consent or clinical authorization.

Proposed production change is **only `src1/modules/externalBookings/controller/index.ts`**: one awaited shared guard for existing consultation `POST /api/v1/external-bookings/bookings` and diagnostics `POST /api/v1/external-bookings/diagnostics/bookings`. Exact ordinary user requests with a supplied dependentId must establish that the dependent belongs to signed `_id` before downstream request work. Consultation compatibility is included because these share the existing create boundary; no doctor workspace, admin/corporate/HR expansion, new patient module or clinical policy is proposed. No service/DTO/schema/model/repository API change.

## Exact source trace

Fresh MCP discovery returned no matching symbols; index status still identifies the original checkout at `bfb608e`, not this worktree. Exact files and targeted whole-src1/test literal scans were read instead. ExternalBookingService is distinct from internal BookingService. The two controller methods are the identified direct create callers; its other imported consumers use webhook sync, timeout cancellation or specialist discovery, not those creates. Repository scanning does not establish deployed/client caller completeness.

| Boundary | Current source under `src1/modules/` | Observation |
| --- | --- | --- |
| Auth and validation | `src1/routes/index.ts:101`; `externalBookings/routes/index.ts:100–110` | Authentication → body Joi → catchAsync controller. Both schemas accept optional trimmed string dependentId, without 24-hex validation. |
| Owner/DTO | `externalBookings/controller/index.ts:344–410`, `:421–488` | Nonadmin userId is signed `_id`; admin keeps body-owner-or-admin fallback. Post-spread corporateId uses actor association for nonadmin. Body dependentId survives spread unchanged. |
| Patient mapping | Same controller | Required request patientName and supplied patient demographics remain authoritative; some missing demographic/contact/address fields fall back to the account UserModel record. No Dependent lookup or demographic comparison occurs. |
| Consultation effects | `externalBookings/services/index.ts:1353–1420`, draft `:1444–1493` | Validates integration/slot/provider requirements, saves draft containing userId/dependentId, then payment settlement or provider order/email. |
| Diagnostics effects | Same service `:1584–1639`, draft `:1729–1748` | Provider/catalogue pricing precedes draft save and conditional Healthians slot freeze, followed by settlement or provider order. |
| Coupon/payer | Same service `:720–817` | Coupon context forwards the saved booking's userId/dependentId; wallet/payment settlement uses account userId. No dependent membership check was found here. |
| Dependent ownership | `dependents/model/index.ts:5–10`; `dependents/types/index.ts:1–6` | userId is a required string: the account that added the dependent. Relationship can include Me/Friend/Other; it is not legal guardian evidence. |
| Reusable lookup | `dependents/services/index.ts:82–102`; repository `:11–15`; `common/repository/BaseRepository.ts:33–39` | getById(id, owner) uses one findOne with `_id` and supplied userId; no match throws fixed 404 DEPENDENT_NOT_FOUND / Dependent not found. |
| Current dependent authority | `dependents/controller/index.ts:20–78`, `:85–109`; routes | User/admin guards and signed owner binding already exist; ordinary owner reassignment is rejected. getById does not filter isActive. This is existing account ownership, not a consent ledger. |

Both external DTOs retain optional string dependentId; the persisted external model also stores it as string. There is no dependent-driven replacement of patient demographics in either builder. Retrying payment/recovering an existing saved booking uses separate service paths and is not protected retrospectively by a new controller create guard.

## Minimal implementation proposal and precise query

Reuse **existing DependentService.getById(id, signedOwner)**, which reuses DependentRepository/BaseRepository. Do not duplicate that scoped lookup/error rule or add a repository method. Add one private DependentService field/import resolved in the current controller constructor with the existing Container.get pattern, plus one private async `assertCustomerDependentOwner(req): Promise<void>` used only by the two creates. Import the existing AppError from common/types for early fixed denials; no new error wrapper.

The helper must run as the **first awaited statement** of each create handler, before existing userId resolution/UserModel read, normalization, raw/normalized payload logging and ExternalBookingService dispatch:

1. If actor userType is not exactly `user`, return without a new lookup or role decision. Preserve current admin/other-role paths and historical unauthenticated direct-call fallback; that fallback is not an anonymous mounted-API contract. Unknown/malformed noncustomer claims remain separate auth risks, not approved authority.
2. For exact `user`, require signed `_id` to be a nonblank string, otherwise throw existing-style **401 UNAUTHORIZED / Authentication is required**, before any dependent/account lookup. Trim only to detect blank; never rewrite signed owner or take it from body/query. This actor check also applies when dependentId is omitted.
3. If validated body dependentId is undefined, return; zero dependent queries and unchanged ordinary no-dependent request behavior.
4. For supplied ID, require a string with the same lexical 24-hex form as existing dependent ID routes (`^[0-9a-fA-F]{24}$`). Invalid form produces the same **404 DEPENDENT_NOT_FOUND / Dependent not found**, without DB query. This local customer guard prevents a cast error; do not globally tighten Joi or impose it on admin/other-role DTOs. Do not interpret self/Me/phone/name/account-ID aliases.
5. Await existing getById once with **both** original validated dependentId and exact signed owner. Its single repository predicate must be `{_id: dependentId, userId: signedOwner}`. Do not use one-argument getById, findById followed by owner comparison, an existence probe, list scan, client owner, fallback, retry or alternate ID. Missing and foreign valid IDs must be indistinguishable fixed 404s.

Do not mutate the request, dependent, normalizer or output DTO after this lookup. Preserve original dependentId spelling/case, signed account binding, explicit post-spread userId/corporateId, integration aliases, patient fields and service APIs. The lookup record is only a membership result, not new patient data. For a dependent owned by A, a supplied body userId B remains ignored by the existing customer resolver; the lookup still uses signed A.

The current getById does not require isActive, and this **ownership-only** contract adds no activity filter. An owned inactive record therefore is not newly denied solely for activity. Account ownership, clinical eligibility, current representative authority and activity/revocation rules are distinct. Reviewers must not silently add an active/guardian/age policy or a demographics rewrite; any such requirement needs its own explicit contract/owner decision.

## Compatibility, error priority and effect boundary

Retain upstream missing/invalid/expired JWT errors and existing Joi validation order/envelope. Invalid body types, empty trimmed dependentId and unrelated malformed required fields retain actual Joi **400 VALIDATION_ERROR** before the helper; record real messages rather than inventing text. A valid string that is non-hex/wrong length now receives the proposed local fixed 404 for customers, although existing Joi admitted its string shape. This is intentional containment. Unverified supported clients may currently send aliases or another account's dependent; they will need compatible actual IDs. No client inventory/acceptance is established.

After body validation, malformed exact-user identity401 precedes dependent404. Foreign, missing or malformed dependent denial precedes account reads and service-level integration/slot/pricing/coupon errors; an unrelated later 400 does not take priority over this pre-effect relationship guard. Repository/service failures propagate through existing error middleware, stop dispatch and are not swallowed or converted into fallback success. No retry is added.

For successful owned or omitted-dependent requests, preserve existing 201 envelopes/messages and payment-required versus no-payment branches. Preserve the association containment, administrator body owner/association handling and all existing noncustomer context without certifying those roles' scope. No dependent lookup for those preserved roles.

On new customer ownership denial, the only permitted application DB read is the **one scoped dependent read** for a well-shaped supplied ID; malformed IDs perform none. No UserModel read, create-service call, payload logger, booking persistence, provider pricing/create/freeze, coupon validation, wallet/payment mutation, queue, file or delivery work follows. Existing error-middleware logging remains separately bounded; never claim zero logging. This is a request-dispatch boundary, not proof that module constructors/startup have no effects. Accepted requests retain existing saves/pricing/freeze/payment/provider behavior; no zero-effects success or coupon-denial rollback promise is added.

## Constructor/admission and TOCTOU limits

The new TypeDI resolution expands the controller's actual construction/import closure: DependentService → DependentRepository → DependentModel → BaseRepository, with AppError/types, Mongoose/TypeDI and their pinned dependencies. The controller already resolves ExternalBookingService and its provider/payment/wallet clients. Constructor resolution occurs when the router constructs the controller, before a request guard; do not call the added import harmless or execute it to find out without admission.

Before any application import/fixture, independently freeze the complete real closure, source/dependency/config hashes, exact TypeDI/alias construction, owned Mongo resources/indexes and provider/queue/timer/file/network isolation under [C3](C3_MONGO_FIXTURE_CONTRACT.md). A recording substitute can prove controller dispatch order only; actual scoped-query/cast/model behavior needs the real admitted repository/model path. Existing foundation/Mongo smoke/historical90-33 recipes and consumed claims do not admit the expanded closure. Root dependency/runtime/build/start adoption retains [C2](C2_COMPATIBILITY_REVIEW.md).

This is a read-time relationship check, **not** an atomic relationship constraint on booking save, wallet debit or external provider work. Deletion, out-of-band reassignment or representation/consent changes can race the lookup; no owner/version/CAS/session binds later effects. The dependent API's owner-change rejection is not proof of immutable ownership across every writer. Existing saved bookings/retries/payment recovery/report access are not retroactively revalidated by this guard. No transaction across provider effects or new consent mechanism is invented.

The required patient/representative mapping remains incomplete: an account-added record is not a permanent patient ID, correct specimen identity, legal guardian, patient agreement, clinical eligibility or permission to receive a report. Unrelated demographics can still be supplied alongside an owned ID; account-profile defaults can still describe the wrong person. Qualified identity/clinical/privacy owners must define patient/payer separation, demographics verification, adult/minor/guardian authority, active/revoked relationships, purpose/version/expiry and revalidation at later sensitive operations. Product/client owners must supply actual ID conventions. These remain visible P0 affected-workflow decisions, not closure supplied by this containment.

## Required evidence and decisions

First obtain two actual independent nonauthor Spec/Standards decisions on this exact draft/hash. Root must resolve/rebind the frozen R4 review packet before authorizing any application edit. Then archive the smallest controller diff and expanded constructor/source binding, obtain two independent source reviews and separately admit focused execution. No existing source/test file is authorized by this draft.

Required future controls for **both** creates:

| Case | Required observation |
| --- | --- |
| Omitted / owned dependent | No-dependent has zero dependent reads; owned has exactly one combined ID/signed-owner lookup before account read/service dispatch. DTO, account/association binding, original patient normalization and 201/payment branches remain unchanged. |
| Foreign / missing / malformed | Identical fixed404 where applicable; exact lookup count0or1, zero later account/service/booking/provider/coupon/wallet/payment effects. Independent B/sibling/all-document snapshots unchanged. |
| Overposted owner / malformed actor | Body/query owner cannot replace signed A. Nonstring/blank exact-user signed owner gives401 before lookup; actual JWT/Joi errors retain precedence. |
| Compatibility | Preserve admin/other-role/omitted paths without approving their authority. Verify owned inactive behavior explicitly as the limited current rule. Measure actual Joi array/object/null/blank/trimmed and ID-case behavior; no fake normalization claim. |
| Constructor/denial ports | Before-import isolation and real TypeDI construction are evidenced separately; denied request counters prove the stated request boundary, including bounded middleware logging. |
| Defect controls | Remove/unawait/late-place guard in either handler; omit owner, trust body owner, use unscoped lookup/fallback, or continue after missing dependent. Relevant source/actual assertions must fail; fresh restored positive controls pass within their admitted scope. |

Source-only lexical/hash checks cannot establish type validity, actual 201/400/401/404, query counts or provider/money denial. Preserve first failures; no automatic retry, weakened guard or silently refreshed fixture. All focused execution remains **NOT_RUN**; final cross-module integration **DEFERRED_BY_OWNER**. No clinical/guardian/consent, supported-client, CUSTOMER/LAB module, original scenario, M0, deployment or release acceptance follows.

## Source/design bindings (SHA-256)

Exact durable files read and hashed for this draft; not a complete import/clinical-authority closure. Reconcile drift before implementation rather than silently updating these pins.

| Path | SHA-256 |
| --- | --- |
| `src1/modules/externalBookings/controller/index.ts` | `b036cc91db6abf4cecfc2963fa02ab04b12bd8c8048c7c979468080a778942ce` |
| `src1/modules/externalBookings/services/index.ts` | `4a13a02cca31c0d4833937643e362b78096f4135933a59ed3372577635a24f83` |
| `src1/modules/externalBookings/routes/index.ts` | `c85d540083d25d7c00bf1fc969e20bccbea09b33d915fb9cac9b19e73ae67b06` |
| `src1/modules/externalBookings/validation/index.ts` | `49c3aa3449e61655d9a34b6a201de9874e83003df8737b5aa5dfdab09bd6dcc6` |
| `src1/modules/externalBookings/types/index.ts` | `a9306564c5ce3572d15eaaa589831df12db483ce56a181af2a3c484f2d3656cf` |
| `src1/modules/externalBookings/model/index.ts` | `873239e9ebd6201cf632deafac86d76ab6a6a84b729e23332e29658a898291f1` |
| `src1/modules/externalBookings/repository/index.ts` | `f55d857c624d4703b0faea866dd9081d1cd04238ee43b0bccd9bc5034b498ed1` |
| `src1/modules/externalBookings/services/diagnosticsPricing.ts` | `e862b598d3249f09cdfc96ffd103475cd71bd0269a33c72eb7e73a35251ca4e8` |
| `src1/modules/externalBookings/services/externalBookingPaymentFinalize.ts` | `1480f9885624363e842c4b3b38ad0e136756bd1a39e81b75138c972222a1416a` |
| `src1/modules/dependents/model/index.ts` | `6e517f2882822cfd587111a5fb5f1bf959a7cd2772026ccb943ad758e1b4071e` |
| `src1/modules/dependents/repository/index.ts` | `cda1c7463c2dae2b692e8f629c7395ef23f1af20340401fae63b186ba7960845` |
| `src1/modules/dependents/services/index.ts` | `adc2f3cf156bfa807bf125904ecd83c8f84dee38a072c7b78d1e90c8822cc044` |
| `src1/modules/dependents/controller/index.ts` | `5fd4f41f923e38ea8545499f6976b64ecda6070e2ba0eab72ac31608535e47f5` |
| `src1/modules/dependents/routes/index.ts` | `a3ade302e3d7453b29135f4347d7ddf2b4b1fbad75aa7c0f5a5c6bc178573344` |
| `src1/modules/dependents/types/index.ts` | `ce0d110b55330c5dadd24fdbea2dd1313a818deb4828723a64b151334a9b8717` |
| `src1/modules/dependents/validation/index.ts` | `6174811e3981865a75ff4a3fb195c4be0ad5bb9b0645761b474b1532fda9030d` |
| `src1/modules/common/repository/BaseRepository.ts` | `14a0fe5fdc9abd7a54b913bca4816a631b4bb263c11ad21ec37da0ee6c3f723a` |
| `src1/modules/common/middleware/validation.ts` | `8be55cee7485531491ff095ed1d9f36af443987690f22d04dd67ef9318a0a5ef` |
| `src1/modules/middleware/errorHandler.ts` | `1e06885f2c5b8df8ed186dba28cd975aaf4f4d5233a2daa277e6b7f7b15fad51` |
| `src1/modules/middleware/auth.ts` | `db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2` |
| `src1/modules/common/types/error.ts` | `3f69860897913c1d8467e3f8aaca7d083e9d50a841553adce33ec6421a0fda07` |
| `src1/routes/index.ts` | `50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056` |
| `src1/modules/healthAssessments/services/index.ts` | `dc460c824df3fa71db7aeb0ca7e58ee940e2e2ea5225a6e5972ff09983ae868c` |
| `src1/modules/webhooks/services/index.ts` | `4bb9e9824badf74c8f16051e5f186c307116cf5b336a45cab14fb0afb14871a3` |
| `documentation/planning/SYSTEM_DESIGN.md` | `cbd899f6fb442b13db28c389143b529b90da364165dc17291cc829814810bc84` |
| `documentation/planning/ROADMAP.md` | `6a5b2e5bfdb42d16021cb28f83531389977d535d9743ae8908ab75ceeabd37cf` |
| `documentation/planning/CAPABILITY_MATRIX.md` | `05ab06d569b8dad2a690ac434922738bd20ce15d9484b60e4bf55e62e14e7fea` |
| `documentation/planning/qa/TEST_SCENARIOS.md` | `bd8c6e8952a8c1cc2f2c2063a4d7a79000dc5566b966a6650d49d60ff841f09e` |

Disposition: **DRAFT_ONLY / TWO_PREIMPLEMENTATION_DECISIONS_PENDING / ALL_FOCUSED_EXECUTION_NOT_RUN**. Writes stop after draft/link/hash verification.
