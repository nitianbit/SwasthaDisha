# Individual lab booking association containment — DRAFT

12 November 2026. Status: **DRAFT; two independent nonauthor preimplementation decisions pending; no application change authorized by this draft alone.** Author: internal Codex `/root/lab_individual_contract`. Root owns shared source, integration and Git. Writes stop after this draft is created and hashed.

## Baseline and bounded purpose

Repository: `nitianbit/SwasthaDisha`; durable focus worktree `/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab`; HEAD `2a26c6b5dfaca710ab3377ef78730c7ce9d1e9c1`. Other workers' booking-read source/evidence and the execution addendum are present and outside this author's ownership. Preserve them and the original checkout's six staged/working files, exact staged patch and eleven handover files. This draft changes no source, packages, tests, gates or historical result.

Read together with [current progress](M0_A_PROGRESS.md), [focused plan](CUSTOMER_PHARMACY_LAB_PLAN.md), [source gaps](CUSTOMER_PHARMACY_LAB_GAPS.md), [owner execution addendum](CUSTOMER_PHARMACY_LAB_EXECUTION.md), [parallel workflow](PARALLEL_DEVELOPMENT_WORKFLOW.md) and [original ROADMAP U4](../ROADMAP.md#u4-lab-partner-services-api-integrations-and-panel). New corporate/HR expansion remains deferred. Preventing a fabricated corporate association in individual checkout is part of included customer/lab authority work. `corporateId` is a customer association, not lab/business tenancy.

The smallest candidate changes **only** the two nonadmin request-body `corporateId` fallbacks in `src1/modules/externalBookings/controller/index.ts`, at baseline lines 379 and 451. It uses the same DTOs, controller normalizers, services, repository, coupon validation and payment path. No helper, duplicate DTO, generic authorization framework or membership policy is needed for this two-expression removal. Existing consultation compatibility uses the same rule and is included; a full doctor-workspace implementation is outside this slice.

## Source discovery and caller map

MCP project `swasthadisha` reports root `/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha` at `bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7`, not this focus worktree. Its symbol/snippet/trace results were navigation only. The exact focus-worktree files and line ranges below were read directly and hashed. Graph traces show zero inbound service edges despite the actual controller calls, so zero graph callers is not absence-of-callers evidence. A targeted literal fallback scan of `src1`, `test` and `testing_setup` found the two controller service invocations below, with no additional direct `createDiagnosticsBooking` call. This is a repository source map, not a deployed/frontend caller inventory.

| Boundary | Exact focus-worktree source | Existing behavior retained |
| --- | --- | --- |
| Mounted API | `src1/routes/index.ts:101` | `/api/v1/external-bookings` mounts `authenticate` before router dispatch. |
| Auth actor | `src1/modules/middleware/auth.ts:19`, `:29` | `jwt.verify` supplies `req.user`; `_id`, `userType`, optional `corporateId` are token claims. No membership/database reload here. |
| Consultation create | `externalBookings/routes/index.ts:100`; controller `:344`, service call `:410` | `POST /api/v1/external-bookings/bookings` → `validate(createExternalBookingSchema, 'body')` → `catchAsync(createBooking)` → service `createBooking(data)`. |
| Diagnostics create | `externalBookings/routes/index.ts:106`; controller `:421`, service call `:488` | `POST /api/v1/external-bookings/diagnostics/bookings` → `validate(createExternalDiagnosticsBookingSchema, 'body')` → `catchAsync(createDiagnosticsBooking)` → service `createDiagnosticsBooking(data)`. |
| DTO fields | `externalBookings/types/index.ts:306`, `:380` | Both requests retain required `userId`, optional `corporateId` and optional `dependentId`. |
| Body validation | `externalBookings/validation/index.ts:189`, `:319` | Both schemas accept optional trimmed string `corporateId`, `userId`, `dependentId`; association fields do not enforce membership or ObjectId format. |
| Validation middleware | `src1/modules/common/middleware/validation.ts:12` | Joi uses `abortEarly: false`, `stripUnknown: true`; errors throw 400 `VALIDATION_ERROR` with joined Joi messages; sanitized result replaces body. |
| Persisted association | `externalBookings/services/index.ts:1468`, `:1729` | Both draft builders persist normalized `data.userId`, `data.dependentId`, `data.corporateId`. |
| Coupon context | `externalBookings/services/index.ts:720`, `:766`, `:797` | Settlement passes normalized `corporateId` into actor context; coupon validation receives that actor association and the booking's user/dependent IDs. |
| Corporate restriction | `src1/modules/coupon/services/index.ts:161`, `:681` | Existing `isCouponAllowedForBookingUser` denies a corporate-restricted coupon if association is absent or outside `coupon.corporateIds`. |

`externalBookings/...` paths in the table abbreviate `src1/modules/externalBookings/...`. Admin and other authenticated roles currently use the same mounted router; this slice adds no role gate. Any external/direct service caller would remain responsible for trusted input because service methods receive DTOs without an authenticated actor parameter; no service-wide authority guarantee is claimed.

## Exact candidate and actor/field contract

At **both** create handlers replace only the nonadmin expression:

```ts
// Before
: req.user?.corporateId || (req.body.corporateId as string | undefined),
// Candidate
: req.user?.corporateId,
```

Retain the surrounding administrator conditional:

```ts
corporateId:
  req.user?.userType === 'admin'
    ? (req.body.corporateId as string | undefined)
    : req.user?.corporateId,
```

This explicit property must remain **after** `...req.body`; otherwise the untrusted body association could survive. Retain the `userId` property after the spread and its current resolver: authenticated nonadmin always uses `req.user._id`; administrator uses a truthy body `userId` or its own `_id`. Do not add a body reassignment, second normalization path or downstream corporate fallback.

| Actor/input after existing validation | Normalized association | Normalized owner |
| --- | --- | --- |
| Authenticated `user`, no actor association, body association omitted | `undefined` | Actor `_id` |
| Same actor, valid body association supplied | `undefined`; body value ignored | Actor `_id`, including when foreign body `userId` is supplied |
| Nonadmin with actor association A; body omitted, A or B | Actor association A | Actor `_id` |
| Other authenticated nonadmin role, no actor association | `undefined`; body value ignored | Actor `_id` |
| Administrator with body association B | Body association B | Existing body-owner-or-admin resolver |
| Administrator with no body association, even when actor has A | `undefined`, preserving existing administrator behavior | Existing body-owner-or-admin resolver |

“Trusted actor” means the existing JWT-verified request actor at this boundary. It does not establish fresh corporate membership, legitimate issuance of every existing token claim, business tenancy, caregiver authority or enrollment policy. Those remain separate work. Preserve exact optional-value behavior; no new normalization/coalescing is added to the actor claim.

The unauthenticated controller fallback (`body.userId || 'test-user'`) is historical direct-call behavior, not an anonymous API contract. Leave that owner resolver untouched. Under the exact candidate a direct call without `req.user` also cannot select a body corporate association. Normal HTTP missing/invalid/expired credentials continue through existing auth errors; the candidate adds no alternate admission path or new authentication error.

## Success, errors and effects

A valid individual request with a supplied corporate association is **normalized**, not rejected solely for that field. There is no new 403/422, required association or body schema change. Existing malformed association values still fail Joi with 400 `VALIDATION_ERROR` before the controller; retaining the field in the schema preserves admin compatibility. Exact dynamic Joi text remains the existing middleware output and must not be replaced by an invented fixed message.

For successful service completion, keep status 201 and `{ success: true, message, data: created }`. Consultation messages remain `External booking created; complete payment to confirm with the provider` / `External booking created successfully`. Diagnostics messages remain `External diagnostics booking created; complete payment to confirm the order` / `External diagnostics booking created successfully`, selected by `created.paymentRequired`. Existing DTO, patient/address/alias normalization, integration selection, provider/slot handling and payment confirmation-pending behavior stay unchanged.

Where a positive-priced checkout supplies a corporate-restricted coupon for the fabricated body association, existing coupon eligibility now receives no association for an unassociated actor. With a fixture that satisfies the other coupon checks, it returns `Coupon is not applicable to this user`; the existing external wrapper throws **400 `INVALID_COUPON`** with that message (`services/index.ts:809`). A fixture without a coupon or with nonpositive gross amount skips this validation (`:773`), so it must not be described as a coupon-denial control. Public/general coupons and trusted actor/admin associations retain their ordinary existing eligibility checks; this slice sets no discount or finance policy.

**Existing effects precede coupon denial.** Consultation saves its draft (`services/index.ts:1395`) before settlement. Diagnostics obtains provider/catalogue pricing (`:1589`), saves its draft (`:1608`) and can call the Healthians slot-freeze path (`:1609`, `:1760`) before settlement. The coupon denial occurs later inside settlement. This contract therefore promises no fabricated association in normalized/persisted/coupon-context fields, **not** zero writes, zero provider calls, rollback of the saved draft or a new compensation rule on `INVALID_COUPON`. Do not add or remove any of those effects in this slice. A recording fixture must distinguish these preexisting calls from downstream wallet/gateway effects after successful coupon validation; never report all denial counters as zero by assumption.

Missing authorization remains 401 `UNAUTHORIZED` / `Authorization token is required`; expired JWT remains 401 `TOKEN_EXPIRED` / `Token has expired`; malformed JWT remains 401 `INVALID_TOKEN` / `Invalid token`, under existing middleware. Other service, provider, pricing, slot and payment errors continue unchanged. A successful normalized request may invoke the same existing effects as an ordinary checkout; ignored association is not a rejected booking.

## Focused review and verification requirements

Obtain two actual independent **nonauthor internal Codex Standards and Spec** decisions on this exact draft and its hash **before application edits**. Reviewers inspect exact source, actor/field/error/effect compatibility and preservation scope. Root records identities, candidate hashes, findings, decisions and bounded scope. This author's draft is neither decision. Then Root may implement the two reviewed deletions, capture exact diff/hashes, run admitted focused checks and obtain two independent source/composition decisions. Material amendments need renewed review.

Required cases apply to **both handlers**, with actual payload capture at the existing service seam when a properly admitted fixture is available:

| Case | Required observation |
| --- | --- |
| Ordinary individual | No association in service DTO; actor owner retained; existing service result/201 envelope forwarded. |
| Fabricated association + foreign owner | Body corporate and owner IDs cannot replace normalized association/owner; all unrelated normalized fields retain existing behavior. |
| Trusted association compatibility | Actor A wins against body B and against omitted body; actor owner retained. |
| Admin compatibility | Explicit body association/owner retained; omitted body association does not default to actor association; omitted body owner uses admin ID. |
| Other nonadmin role | Same association/owner rule as before except body-association fallback removal; no invented role restriction. |
| Joi/auth controls | Invalid field type and empty trimmed association preserve 400; missing/invalid/expired credentials preserve existing 401 routing, with controller/service not reached. |
| Coupon denial | Positive amount and otherwise valid corporate-only coupon; unassociated actor + matching fabricated body association receives existing `INVALID_COUPON`; persisted association absent; record existing pre-denial saves/pricing/freeze calls. |
| Coupon compatibility | General coupon and valid actor/admin-associated coupon retain existing result; zero amount/no coupon retains skip behavior. |
| Payment/provider compatibility | Existing payment-required and no-payment service result branches and integration/slot/alias normalization remain; do not infer live provider or financial correctness from a controller recording seam. |
| Defect reintroduction | Restore either fallback independently and prove the relevant fabricated-association assertion fails; restore the good source as a same-trial positive control. Also catch moving the explicit property before the body spread and removing/overwriting actor user binding. |

Source-only evidence can first prove an exact two-deletion transform, ordering and unchanged surrounding bytes; it must identify old-source failure, fixed-source result and reintroduced variants separately. Text/source checks do not establish TypeScript/Joi/HTTP/ODM/provider behavior. Do not run Node, npm, compiler, app imports, tests, Docker, DB or providers for this draft. Allowed work here is read-only graph navigation and standard-library metadata/source reads/hashes plus this one new document. No application code was executed.

All actual runtime cases above are **NOT_RUN**. Complete pre-import C3 admission, including real module dependencies and provider/queue/timer/file isolation, precedes any executable application fixture. Existing foundation or Mongo smoke evidence does not admit this path. Root dependency/runtime/build/start adoption retains C2. The owner's final cross-module integration campaign is **DEFERRED_BY_OWNER** per the execution addendum; focused checks remain required. No historical scenario outcome, 90/33 source binding, original 115 totals, owner/client acceptance, deployment, 100 RPS or release status changes.

## Separate risks and remaining original scope

This slice does not close dependent membership: both request schemas accept `dependentId`, draft builders persist it, and coupon context uses it. A separate patient/dependent/caregiver authority contract must bind the patient and authorized representative before dependent acceptance. No caregiver/clinical policy is invented here.

Both controllers still log raw and normalized payloads; patient/contact/report privacy, public clinical file serving, immutable report versions and protected-log handling remain separate risks. JWT association issuance/refresh and profile-field authority need their own contracts. Do not claim verified membership from the token-local containment.

Provider callbacks still require **provider-specific** authentication, integration-scoped lookup, durable deduplication/order handling and recovery; no universal HMAC is invented. Refund/paid-cancel atomicity and clinical/signatory/critical-result policies retain their applicable owner decisions. The existing save/freeze-before-coupon-denial behavior is explicitly retained for separate recovery work.

Original ROADMAP U4 completion still includes API-connected **and** panel-managed labs, assigned staff/signatory permissions, direct/walk-in/phone/referral customers at private/unlisted labs without app login, sample/recollection lineage, private immutable report release/corrections/review, critical-result acknowledgment, billing/receipts/recovery and basic supply purchasing/consumption/waste. This two-expression containment and its later focused checks cannot mark the LAB module or those journeys complete.

## Source binding (SHA-256)

The following bytes were read at the baseline worktree during draft preparation; recheck before implementation. Shared worker changes elsewhere do not update these source bindings silently.

| Path | SHA-256 |
| --- | --- |
| `src1/modules/externalBookings/controller/index.ts` | `67ebcef4ec0b7f21c9bf2c9c274a6d6066499ef34f0637fa3fa0ee36fde2acd3` |
| `src1/modules/externalBookings/routes/index.ts` | `c85d540083d25d7c00bf1fc969e20bccbea09b33d915fb9cac9b19e73ae67b06` |
| `src1/modules/externalBookings/services/index.ts` | `4a13a02cca31c0d4833937643e362b78096f4135933a59ed3372577635a24f83` |
| `src1/modules/externalBookings/validation/index.ts` | `49c3aa3449e61655d9a34b6a201de9874e83003df8737b5aa5dfdab09bd6dcc6` |
| `src1/modules/externalBookings/types/index.ts` | `a9306564c5ce3572d15eaaa589831df12db483ce56a181af2a3c484f2d3656cf` |
| `src1/modules/middleware/auth.ts` | `db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2` |
| `src1/modules/common/middleware/validation.ts` | `8be55cee7485531491ff095ed1d9f36af443987690f22d04dd67ef9318a0a5ef` |
| `src1/modules/coupon/services/index.ts` | `b9f478e13aaed8e78599c91b819d8d54af8f17c1570321bace427571e58dc226` |
| `src1/routes/index.ts` | `50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056` |

Disposition: **DRAFT_ONLY / SOURCE_DISCOVERY; implementation and all focused runtime checks NOT_RUN; final cross-module integration DEFERRED_BY_OWNER.**
