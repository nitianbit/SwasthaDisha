# Customer generic booking write ownership — draft

12 November 2026. **DRAFT ONLY. Two independent nonauthor Spec/Standards decisions are required before implementation.** Author: internal Codex `/root/customer_booking_writer`. No application edit or execution is authorized by this document. Root owns integration, Git and review records.

## Baseline and scope

Active repository `nitianbit/SwasthaDisha`; durable branch `m0/customer-pharmacy-lab-focus`, worktree `/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab`, observed HEAD `cc66925e59dbb5d209bdd66776e7d13b0337d7a4`. Current booking controller SHA-256 is `bbe2d226d0192b91389675dd5e66f2b385dc157bba0010715bbe4b29b0e2848b`, the reviewed customer-read candidate. Shared booking services retain their earlier bytes.

Read with [current progress](M0_A_PROGRESS.md), [focused plan](CUSTOMER_PHARMACY_LAB_PLAN.md), [execution addendum](CUSTOMER_PHARMACY_LAB_EXECUTION.md), [customer read contract](CUSTOMER_BOOKING_READ_CONTRACT_DRAFT.md), [parallel workflow](PARALLEL_DEVELOPMENT_WORKFLOW.md), [C2/C3 conditions](../M0_START_APPROVAL_STATUS.md) and [fixture limits](C3_MONGO_FIXTURE_CONTRACT.md). Preserve other workers' operator/recovery artifacts, prior source/read evidence, and the original checkout's six staged/working files, exact patch and eleven handover files.

Proposed production scope is **only** `src1/modules/bookings/controller/index.ts`: signed ordinary-customer ownership for existing `PUT /api/v1/bookings/:id` and `DELETE /api/v1/bookings/:id`, with a small shared-helper refactor preserving the two already-reviewed reads. No route, Joi, service/repository/model, middleware, DTO, payment, deletion, refund or field-permission change is proposed. No corporate/HR expansion. New field permissions require their own contract and applicable owners.

The genuine Claude read-source review may still be consuming its frozen snapshot. This draft must not trigger application edits or silently replace that review's controller hash. Root first resolves the snapshot dependency, rechecks this baseline, records both actual preimplementation decisions and separately authorizes the exact source candidate. An eventual amended controller needs fresh independent source reviews; earlier read approvals do not approve an unseen refactor.

## Exact source map and existing behavior

The MCP index reports the original checkout at `bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7`, rather than this worktree; the targeted graph search returned no symbols. Exact durable source reads and a targeted whole-src1 literal caller scan are authoritative here. No graph absence proves absence of external/direct callers.

| Boundary | Current source | Observation |
| --- | --- | --- |
| Mount | `src1/routes/index.ts:65` | `authenticate` precedes booking router. |
| PUT | `bookings/routes/index.ts:104–110` | Params validator → update body validator → booking query validator → controller. |
| DELETE | `bookings/routes/index.ts:113–118` | Params validator → booking query validator → controller. |
| Controllers | `bookings/controller/index.ts:362–386` | Existing HR readonly denial, then optional caller query userId forwarded to update/delete. No mandatory ordinary-customer binding here yet. |
| Scoped prefetch | `bookings/services/index.ts:1233–1251`, `:1525–1530`, `:1646–1647` | Each write calls `getById(id, userId)` once before its write/effects. The read uses one combined `{ _id: id, userId }` filter when owner is supplied; no match throws existing 404. |
| Final mutation | `bookings/services/index.ts:1587`, `:1666` | Update and delete use `{ _id: id }`, without owner, version or transaction predicate. |
| Shared caller | `specialistPortal/services/index.ts:214–244` | `updateAppointmentStatus` performs its specialist/booking check, then invokes `BookingService.update(bookingId, data)` without owner. |
| Repository | `bookings/repository/index.ts:12–15`; `common/repository/BaseRepository.ts:33–39`, `:65–76` | Inherited lean findOne, findOneAndUpdate, deleteOne. No override supplies final owner scoping. |

Abbreviated module paths above are under `src1/modules/`. The literal scan found update calls in the booking controller and SpecialistPortalService, and the delete call in the booking controller. ExternalBookingService is a different class. Do not globally tighten BookingService signatures: that would change shared callers and exceed this contract.

## Actor and owner rule

An ordinary customer is **exact** authenticated `userType === 'user'`. The account owner is the signed `_id`, unchanged. A dependent reference does not confer another account's booking authority.

After existing route validation, both writes must reject absent/null principal, missing/nonstring/whitespace-only `_id`, or missing/nonstring/whitespace-only `userType` with **401 `UNAUTHORIZED` / `Authentication is required`**, before HR readonly dispatch or any BookingService call. Reuse the current read-actor guard's exact validation. Trimming detects blank actor fields only; never rewrite signed IDs or add ObjectId validation to them.

For an exact customer, an omitted validated query `userId` or a value strictly equal to signed `_id` selects signed `_id`. Every other supplied value throws **403 `FORBIDDEN` / `Access to bookings owned by another user is not permitted`**, before service/query/effect dispatch, regardless of whether the booking exists. Do not echo supplied IDs. Query self cannot grant ownership of a foreign resource. No preliminary unscoped read, user existence check, owner retry/fallback or extra prefetch is allowed.

Preserve PUT → `bookingService.update(id, validatedBody, signedOwner)` exactly once, and DELETE → `bookingService.delete(id, signedOwner)` exactly once. The existing service then performs its existing single scoped getById prefetch. An existing foreign booking ID and a missing booking ID both yield **404 `BOOKING_NOT_FOUND` / `Booking not found`**, before downstream write/scheduler/slot/meeting work. This is an initial-read guarantee subject to the race limit below.

For well-shaped other actors, preserve query-owner forwarding and existing behavior. Exact HR still gets **403 `FORBIDDEN` / `HR has view-only access to bookings`**, before service. Unknown nonempty roles and other role paths remain unresolved authority risks; preserving them is not approval. Malformed actors cannot fall through to any preserved branch.

## Minimal shared implementation proposal for review

Rename the existing private synchronous `requireBookingReadActor` to `requireBookingActor`, retaining its implementation unchanged. Keep by-user's distinct path check and typed/trimmed optional query check exactly as reviewed; change only its actor-helper reference.

Introduce one private synchronous `resolveBookingOwnerScope(req: AuthRequest): string | undefined`, used **only** by detail/getById, update and delete:

1. Obtain the validated actor from `requireBookingActor(req)`.
2. Read the already-validated optional query userId using its existing string/undefined type.
3. For exact ordinary customers, reject any supplied nonmatching owner with the fixed 403 above and return the signed `_id`.
4. For all other well-shaped actors, return the original optional query owner unchanged.

This removes the existing detail predicate/forwarding duplication and shares it with both writes. It is not a generic role framework or a second business implementation. No async guard, try/catch recovery, request mutation or global service wrapper.

Detail resolves owner before the unchanged `ensureHRCanAccessBooking(req, id)`, then invokes its existing service once. Update/delete resolve owner first, retain `ensureHRReadOnly(req)` before their existing service calls, and otherwise retain their bodies and envelopes. No helper use on create, getAll, upcoming, payment-details, cancel, reschedule or retry-payment. If implementation requires broader changes or different semantics, stop and re-review the contract.

## Validation, success and error compatibility

Upstream authentication remains unchanged: missing token 401 `UNAUTHORIZED` / `Authorization token is required`; expired token 401 `TOKEN_EXPIRED` / `Token has expired`; invalid token 401 `INVALID_TOKEN` / `Invalid token`. This ownership slice trusts the verified request actor and does not establish current account state, secret quality, claim freshness or revocation.

Retain authentication/params/body/query order exactly. `idParamSchema` requires 24 hex characters; `bookingQuerySchema.userId` is an optional trimmed string. Existing malformed path/query, and malformed/empty PUT body, remain **400 `VALIDATION_ERROR`** before controller guards, with existing Joi message output. Array/object/null/blank query cases must be measured through actual Joi; do not replace their validator error with customer 403 or assume direct-controller inputs describe HTTP behavior. Query whitespace normalized by current Joi is preserved; signed IDs are compared exactly afterward. Do not add query middleware to by-user, whose contract differs.

PUT success remains 200 `{success:true,message:'Booking updated successfully',data:result}`. DELETE success remains 200 `{success:true,message:'Booking deleted successfully'}`. Errors remain `{error:statusCode,message,code}` through current middleware, including its existing logging. Existing update errors include 400 `INVALID_BOOKING_DATE` / `Booking date cannot be in the past`, and 500 `UPDATE_FAILED` / `Failed to update booking`; no new financial or clinical error policy is added.

## P0 limits that this ownership contract does not approve

**Own-write field authority remains P0.** Existing update Joi admits `paymentStatus` including `paid`/`refunded`, booking `status` including completed/cancelled, `corporateId`, `slotId`, prescription/report/followUp/documents and other fields. The service derives lifecycle state and can set a cancellation to `refunded`. Caller `lifecycle` is not a directly admitted Joi field, although the service derives lifecycle patches and the internal DTO contains it. Do not invent a new allowlist/denylist, strip fields, or treat own-resource access as authorization to self-assert payment, clinical authorship, corporate affiliation, completion, follow-up benefits or lifecycle transitions. Source and eventual narrow owner checks cannot close these separate actor/field/finance/clinical risks.

**Effects are real implementation paths, not approved business policies.** Update can clear/schedule reminders, activate follow-up benefits, mutate refund-marked state and cancel/sync meetings. Delete clears reminder jobs, can cancel an existing Google Calendar event and update virtualMeeting metadata, can read/decrement a slot count, then hard-deletes the booking. Slot-decrement errors are logged and caught before delete. A meeting/queue/slot error can occur after earlier effects; no transaction/rollback/compensation or refund guarantee is supplied by this slice. A `refunded` field is not evidence of returned money. Successful own deletion, retention/audit, paid cancellation and provider/resource cleanup policy need their separate finance/clinical/privacy decisions. No new deletion/refund rule is invented here.

**Read-then-write race remains P0.** The initial scoped prefetch is followed by ownerless `{_id:id}` mutations and, on applicable paths, ownerless follow-up/meeting writes or effects. This is not an atomic ownership predicate at the final write, a lock, a version check or a transaction. Intervening owner reassignment/replacement or concurrent state changes can invalidate the prefetched snapshot; concurrent delete can also follow earlier effects. Stable ownership in synthetic fixtures is a fixture assumption, not a proven invariant for all production writers. This contract does not claim race-safe authorization and must not be accepted as one. A separate repository/transaction/state contract must establish any stronger invariant before that risk is closed.

## Required evidence and gates

No runtime or application execution is admitted by this draft. First obtain two actual independent nonauthor internal Codex Spec/Standards decisions on this exact draft/hash, then Root authorizes the bounded controller edit after snapshot coordination. Before/after/diff and source pins must preserve earlier customer/lab evidence. Source-only checks may establish scope, first guard ordering, owner forwarding, unchanged shared bytes and rejection of in-memory source variants; they do not prove type validity or behavior. Record initial failures and stop dependent execution on failure; never replace earlier receipts.

Before any application import or focused fixture, separately prepare/review complete C3 closure with exact source/dependency/config hashes, owned disposable DB resources/indexes, provider/file/network denials, timer/queue/meeting/slot recording ports and bounded logging. Existing foundation/Mongo smoke or historical90/33 does not admit these real methods. Root package/runtime/build/start adoption retains C2. Required future focused evidence:

| Case | Required observation |
| --- | --- |
| A owns booking, omitted/self owner | PUT uses a benign existing notes change and DELETE uses an independently owned synthetic booking; service gets exact signed A once, with one existing combined-scope prefetch, unchanged success envelope and documented effects. No privileged-field approval follows. |
| A supplies foreign query owner | Both writes 403 before any BookingService/read/write/effect dispatch, whether requested booking exists or not. |
| A targets B or missing ID with omitted/self owner | Both 404 after one combined `{_id,userId:A}` prefetch; no fallback, write, reminder, slot or meeting effect. A dependent link does not change this result. |
| Missing/malformed actor | All missing/null/nonstring/blank principal fields return controller 401 before HR/service; separately measure upstream JWT errors. |
| Actual validation order | Invalid ID, invalid query types, trimmed/blank query and invalid/empty PUT body retain current Joi behavior and precedences; compare exact error envelopes without inventing message text. |
| Preserved roles | Well-shaped HR remains readonly with zero service dispatch; other well-shaped noncustomer dispatch remains source-compatible without certifying role authorization. |
| Existing reads | Own/foreign/missing detail outcomes, early denials, one scoped detail call, and distinct by-user path/query semantics survive helper refactor. |
| Effects and siblings | Record exact method/predicate and counter order, unchanged B/sibling/all-document snapshots on denials, and fixture-appropriate expected writes/effects on successes. Own DELETE does not imply zero queue calls: existing reminder clearing remains. Provider/DB activity uses only admitted recording/owned ports. |
| Defect controls | Independently remove signed owner forwarding from PUT/DELETE, trust query owner, add unscoped fallback, weaken/late-place actor/foreign-hint checks or bypass HR denial; each must fail relevant focused assertions. Fresh restored positive controls must pass. Include read/by-user refactor regressions. |

Keep final-write predicates visible in focused evidence; a successful initial-owner fixture does not prove the race absent. Limit the execution recipe to its reviewed actual scope, with owned cleanup and independent post-execution decisions. Failure does not authorize retries or weaker admission.

All focused checks remain **NOT_RUN**. Final cross-module integration is **DEFERRED_BY_OWNER**, separately from required focused checks. This contract cannot complete CUSTOMER/LAB/PHARMACY, close the privileged-write/clinical/payment/deletion/race risks, change historical scenario totals, certify supported clients or supply named-owner/M0/deployment/release acceptance. No Claude approval is claimed.

## Source bindings (SHA-256)

These exact durable files were read for navigation/behavior and pinned during draft creation. Recheck all drift before implementation; do not silently refresh bindings. The table is source provenance, not a complete C3 import/effect closure.

| Path | SHA-256 |
| --- | --- |
| `src1/modules/bookings/controller/index.ts` | `bbe2d226d0192b91389675dd5e66f2b385dc157bba0010715bbe4b29b0e2848b` |
| `src1/modules/bookings/services/index.ts` | `d32c2a8a7e0af52d6e062e29c82e7fee87dcb6dcdfe4488e89e7d09c4cc2c8cf` |
| `src1/modules/bookings/routes/index.ts` | `b2ed40c971e35ceb28eeccb8b491bcf7c4b2dcaf35a7267c783a8345760e3cfb` |
| `src1/modules/bookings/validation/index.ts` | `ce9743b4cc50af6b230089c0ff0523f490f8685c6fbb48cc475f4b8e52e6f728` |
| `src1/modules/bookings/types/index.ts` | `30d1a615c3f157ec9a73f9a13968c3afcec59f84bdfa0178413f22c906f42a79` |
| `src1/modules/bookings/repository/index.ts` | `d54ebba522cd290589296918eb2dcb4f7609e42d836ef3f23dfb89114b375713` |
| `src1/modules/bookings/model/index.ts` | `219f8115e5eec4bebd7205c763638e8755bde57122866430a1b3bcd0f69ead72` |
| `src1/modules/middleware/auth.ts` | `db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2` |
| `src1/modules/middleware/errorHandler.ts` | `1e06885f2c5b8df8ed186dba28cd975aaf4f4d5233a2daa277e6b7f7b15fad51` |
| `src1/modules/common/middleware/validation.ts` | `8be55cee7485531491ff095ed1d9f36af443987690f22d04dd67ef9318a0a5ef` |
| `src1/modules/common/types/error.ts` | `3f69860897913c1d8467e3f8aaca7d083e9d50a841553adce33ec6421a0fda07` |
| `src1/modules/common/repository/BaseRepository.ts` | `14a0fe5fdc9abd7a54b913bca4816a631b4bb263c11ad21ec37da0ee6c3f723a` |
| `src1/modules/specialistPortal/services/index.ts` | `631a2bc6e92e522db35bad35eacd9f7d46aa8e4dcdb508acc16dc44891fef27c` |
| `src1/modules/bookings/services/bookingReminderScheduler.ts` | `adf043d0fa1c80f78e42b1b1b1b2f62bad5f424b843a3edaf3190a987d4857c1` |
| `src1/modules/meet/service/index.ts` | `edc6972866223a641027fcddc3b1b3bcec47bb31cb189bf4d7b097da33a24644` |
| `src1/modules/slots/services/index.ts` | `9d9f2c7eff6bc593f312609b9587ce074a6ea1b9a5bcc305ac1cdd44457f2d57` |
| `src1/routes/index.ts` | `50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056` |

Disposition: **DRAFT_ONLY / IMPLEMENTATION_NOT_AUTHORIZED / ALL_FOCUSED_EXECUTION_NOT_RUN**. Writes stop after this draft and its bounded link/hash verification.
