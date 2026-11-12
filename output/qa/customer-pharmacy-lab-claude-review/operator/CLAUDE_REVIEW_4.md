# SD-CLAUDE-THREE-MILESTONE-REVIEW-4 — Claude source-only review

**Overall decision: APPROVE_SOURCE_ONLY.** This covers only whether the three bounded source changes conform to their contracts. One finding (F1, pharmacy) is a direct consequence of the change and needs an owner/clinical decision before any prescription order is enabled or the pharmacy module is released. It is not a conformance defect. This review supplies no runtime, clinical, pharmacist, finance, privacy, security-owner, C2/C3, module, deployment or release acceptance.

## 1. Binding context

- Selected challenge: `msg_1794464372502_vmbvz2nz` (`SD-CLAUDE-THREE-MILESTONE-CHALLENGE-4`, from `codex-lead`). sessionId `be854944-2d46-4991-a27c-e2450eee3c15`; nonce `1a6ef71f-9eae-400f-b17b-a90a03909c13`, ACKed in the previous send; clientKind as received `local-bundled-CLI`.
- Packet `SD-CLAUDE-THREE-MILESTONE-SOURCE-PACKET-4`. packetSha256 as given in the challenge: `c1277a6d678d95261614b4726bd3a1aa946e68c7819ed5654323fdc5aea85732`. I did not recompute it; no hashing tool was in scope.
- sourceCommit `abd1e90be9dfd7012dd20b9646ed4f494778726a`, the same in packet and challenge.
- Source hashes are identical in packet and challenge:
  - bookings controller `c3b500d9343150d5edff79980f10825ce6592d02f1a1c7ea652f8c852c0ca76c`
  - pharmacyOrders service `54bbff59b46586120f107472265d116a6754782aea6d632295ecea88983f5ddc`
  - externalBookings controller `b036cc91db6abf4cecfc2963fa02ab04b12bd8c8048c7c979468080a778942ce`
- Contract hashes are identical in packet and challenge:
  - read `52a6f33e76db70a2a7ae8d29d2f45714107d750911fc2d4b2cdcef27840cdf4c`
  - write-owner `723af082952ee39d39342080d2ba72205687f94244458a5e5dabf0d9c7ee8698`
  - pharmacy `60b0f2e140857b68936d629ca5ce37bca10f9e114a0f9b3c99154e8cdc0d56f3`
  - lab `79e5ec32ea34a30b3859676f1297b8553e81add2f314ea214d9bbe0e3cfd7a05`
  - bundle `45af4215f5cbc901c54fe980e9828908e96ff9bfb82a33311c6b6c99af81cb61`, matching the challenge `contractSha256`.
- Ignored as stale: `msg_1794461150814_in7ljrxb` and `msg_1794462964520_jc1ye2xg` (revisions 2/3 at commit 11e9c8b, controller bbe2d226), and connectivity-only `msg_1794338990732_89plt10f`.
- Requested model `claude-opus-5-5` and effort `xhigh`. I make no claim about the effective model or effort. Both are UNPROVEN because there is no supported observation.

## 2. Method

Read-only review of the packet text. Tool use: one inbox peek and two sends. No filesystem, shell, git, compiler, application, DB or provider access. Line numbers cite the original files. I got them by counting inside the line-numbered excerpts, then cross-checked them against diff hunk headers (bookings controller 267/364/378/390; pharmacy 1022/1039; external controller 376/448) and the line references in the contracts (bookings service 1530/1587/1647/1666; external service 1395/1468/1729/766/797; external controller 410/488). Native Codex decisions and lexical checks were treated as prior internal evidence only.

## 3. Milestone 1 — customer booking read + write owner

**Disposition: APPROVE_SOURCE_ONLY (bounded change).** Composition: applying the read diff and then the write diff (`requireBookingReadActor`→`requireBookingActor`, plus the new `resolveBookingOwnerScope`) reproduces the shown regions. I checked this by reading the diffs, not by applying them.

Confirmed in source:
- `requireBookingActor` (controller 26–43) rejects a missing actor, or a non-string/blank `_id` or `userType`, with a fixed 401 `UNAUTHORIZED` / `Authentication is required`. It is synchronous and uses trim only to detect blanks. The signed values are returned unchanged.
- `resolveBookingOwnerScope` (45–60) validates the actor first. For an exact `user`, any defined query `userId` that is not strictly equal to the signed `_id` gets a fixed 403 `FORBIDDEN` with no echo; otherwise it returns the signed `_id`. Other well-shaped actors get the original query value unchanged (59). There is no I/O, retry or fallback.
- `getById` (267–271) resolves the owner before `ensureHRCanAccessBooking`. That helper returns immediately for `user`; its unscoped HR prefetch at 161 is unchanged. Then exactly one `getById(id, userId)` runs. For a customer this is one combined `{_id, userId}` `findOne` (services 1233–1251), and foreign and missing IDs give the same 404.
- `update` (364–369) and `delete` (378–382) resolve the owner before `ensureHRReadOnly` and make exactly one service call each with the signed owner. Malformed actors get 401 before the HR check; well-shaped HR still gets 403 before the service. Envelopes are unchanged.
- `getByUserId` (390–418): the only change from the read-reviewed version is the helper rename. The path value must equal the signed `_id`. The unvalidated query must be undefined or a string whose trim equals the signed `_id`; non-string, blank and foreign values get 403 before HR scope or the service. The customer path calls `getByUserId(actor._id)` (409, 418). HR and other non-customer branches are unchanged. This deliberately stays distinct from detail's Joi-validated query.
- Route order is unchanged (routes 96–101, 104–110, 113–118), so malformed params, body or query (validation 432 `userId: Joi.string().trim().optional()`) keep their 400 before controller 401/403.

Introduced defects: **none found.** Low-severity compatibility notes (not defects, consistent with the contract):
- **L-C1** — The Joi-trimmed hint is compared strictly with the unmodified signed `_id` (49, 398). A self hint that differs only in hex case therefore gets 403 on all four handlers. Confirm that supported clients send the canonical string.
- **L-C2** — The customer comparison on detail/PUT/DELETE depends on `validate()` reassigning `req.query` (common/middleware/validation.ts:32). This works on Express 4. On Express 5, `req.query` is getter-only and the assignment would throw on every query-validated route; that would be pre-existing and global. Pin the Express major version in the C3 closure. Also confirm that no legitimate issuer (admin, service or integration tokens) lacks a string `_id`/`userType`, because those requests now get 401 on these four handlers.

Known risks still open (reported here, not certified as fixed):
- **B-C1 Ownerless write race.** The scoped prefetch (services 1530, 1647) is followed by ownerless `{_id:id}` writes (1587 update, 1666 delete), with reminder, follow-up, meeting and slot effects in between (1600–1640, 1648–1664). There is no owner, version or transaction predicate at the final write, so this is an initial-read guarantee only.
- **B-C2 Field authority on own bookings.** `updateBookingSchema` (validation 366–404) lets the owner set `corporateId` (367), `slotId` (368), prescription/report/followUp (379–381), `status` completed/cancelled (386–392) and `paymentStatus` paid/refunded (393–399). Effects visible in source:
  - Cancelling via PUT forces `paymentStatus='refunded'` and calls `ensureCancelledBookingPaymentStatus` (1543–1548, 1613–1615), outside the dedicated `POST /:id/cancel` path.
  - `completed` activates follow-up benefits (1600–1604).
  - Confirmed status and date/time changes reschedule reminders and sync meetings (1625–1640).
  Owner scoping does not make any of these authorized.
- **B-C3 Own hard delete.** A customer can hard-delete their own booking in any state (1666), including paid/completed, with no refund, retention or audit. Reminder and meeting effects run first. The slot decrement (1655–1664) runs whatever the prior status was. The packet does not show whether earlier cancel paths already decremented, so possible double-decrement and capacity drift is unverified.
- **B-C4 Broadest remaining exposure in these handlers.** Any well-shaped `userType` other than exact `user`/`hr` (admin, pharmacy, specialist, case variants, unknown strings) gets `undefined` from 59 when no hint is sent. That makes detail, PUT and DELETE unscoped by ID, and routes 96–118 have no role gate. This is preserved behavior, not approved behavior, and needs its own role contract with priority.
- **B-C5 Same fallback remains in sibling bookings handlers.** Bookings create handlers still use `req.user?.corporateId || req.body.corporateId` (controller 183–186, 217–220, 248–251). Whether the create schemas accept `corporateId` is outside the packet, but own-booking PUT accepts it (validation 367). Milestone 3's containment must not be claimed for first-party bookings.

## 4. Milestone 2 — pharmacy prescription state at completion

**Disposition: APPROVE_SOURCE_ONLY (contract-conformant); F1 needs an owner decision.**

Confirmed in source (`pharmacyOrders/services/index.ts`):
- The guard (1022–1032) applies only to completion. It is a closed allowlist (`approved` | `not_required`) built from two strict inequalities, so undefined, null, '', pending, rejected and unknown values all get a fixed 409 `ORDER_PRESCRIPTION_APPROVAL_REQUIRED` with no value echoed.
  - It runs after: not found (985), store 403 (988), terminal (991), transition (995–1001), and both payment checks (1003–1020).
  - It runs before: `buildInventoryItems` (1034), the transaction (1039), any order write, release/consume, and the post-commit queues.
  - So unpaid+pending still gets the payment 409.
- CAS filter (1040–1050) is `{_id, status: observed}`, plus `prescriptionStatus: <observed exact value>` only when completing. The predicate is in the filter, not the update body. The update body and `{new:true, session}` are unchanged. For non-completion targets the filter is equivalent to the old `{_id, status}`.
- A CAS miss throws 500 `UPDATE_FAILED` (1052–1054) inside the callback, before release (1056–1058) and consume (1060–1062). Because the predicate binds the observed value, a transient `withTransaction` retry re-runs against the same captured `order` and cannot match a state that has since changed.
- `BaseRepository.findById` is `.lean()` (BaseRepository 41–47), which does not apply schema defaults. A stored document without `prescriptionStatus` therefore reads as undefined and fails closed, as the contract requires. A `PharmacyOrderRepository.findById` override is not visible (repository excerpt is lines 1–35 only).
- The candidate diff touches only these two hunks. The consume helper (220–234), inventory leaf (inventory service 430–451, repository 227–260), controller and routes are unchanged.

**F1 — introduced consequence: unrecoverable non-terminal orders (severity HIGH, operational; owner/clinical decision; not a conformance defect).**
- Scenario:
  - Every order with a prescription-required medicine is created with `pending` (462–478, called at 575). Repricing only re-derives pending/not_required (911).
  - The contract's whole-src1 scan found no first-party command that sets `approved`.
  - The packed, ready and out-for-delivery transitions remain ungated for prescription state (1003–1013). The order can therefore be accepted, packed and moved to `ready_for_pickup` or `out_for_delivery`.
  - From those states `ALLOWED_STATUS_TRANSITIONS` allows only `completed` (30–31). The new guard denies it, and cancel (controller 84–91 → `updateStatus('cancelled')`) fails the transition check with 409.
- Consequence:
  - The order is permanently non-terminal and has no exit in the product.
  - Reserved batch stock is never consumed or released.
  - Payment stays captured.
  - The goods may already have been handed over or dispatched.
  - Scope: every prescription order on the app and in-store counter paths, plus any legacy document missing the field. Before this change the same order completed: clinically unsafe, but recoverable.
- Minimum fix (requires a decision; I am not choosing a policy): any one of:
  - (a) amend the contract so the same closed gate also applies to transitions into `ready_for_pickup`/`out_for_delivery`, or into `packed`, while cancellation is still allowed;
  - (b) deliver the separately contracted pharmacist approval/rejection command before prescription orders are enabled;
  - (c) explicitly accept and record the dead end, with a reviewed recovery procedure.
  Until then, treat F1 as a release blocker for prescription dispensing. Given the owner's recorded pre-launch status, no live impact is asserted.
- **L-P1** — A CAS miss (for example a concurrent revocation) surfaces as a generic 500 `UPDATE_FAILED` and is logged as a server error. The contract accepted this; triage and monitoring should not treat it as an infrastructure fault.

Known risks still open:
- Stored `approved` is not pharmacist authorization or versioned clinical evidence.
- There is no approval command and no provenance.
- Replacing prescription URLs keeps `approved` (925–935). ABA changes and catalogue `prescriptionRequired` defaults are also open.
- Consume uses the pre-transaction snapshot `order.items` (1061), not `nextOrder.items`. The CAS does not bind items, allocations or a version, so correctness relies on `update()` gating item edits by status; that code is not in the packet.
- Packed/release safeguards are open.
- Edit-time available-stock debits on legacy orders (176–194, 937–960) are open.
- Paid cancellation/refund is open.
- The UTC expiry comparison in `consumeBatchAllocations` (inventory repository 237–247) can fail completion with `BATCH_RESERVATION_CONSUME_FAILED` for a lot that expired after reservation. That is another pre-existing stuck path at ready/out.

## 5. Milestone 3 — lab individual association

**Disposition: APPROVE_SOURCE_ONLY.**

Confirmed in source (`externalBookings/controller/index.ts`):
- `createBooking`:
  - `...req.body` (371) comes before the explicit `userId` (375) and `corporateId` (376–379).
  - Non-admin uses `req.user?.corporateId`; admin keeps the body value.
  - Because the explicit property follows the spread, an undefined claim still overwrites any body association.
  - The owner resolver (349–353) is unchanged: non-admin uses the signed `_id`, admin uses the body `userId` or its own `_id`.
  - The service call at 410 receives the normalized DTO.
- `createDiagnosticsBooking` has the same structure: spread 446, `userId` 447, `corporateId` 448–451; owner 426–430; service call 488.
- Downstream:
  - Drafts persist the normalized value (external services 1471, 1732).
  - The settlement actor (1403/1621 → 746) and coupon context (805) take only that value. For non-admins, a body association can no longer unlock corporate-restricted coupons.
- The diff is exactly two expression replacements. Joi, DTOs and services are unchanged.
- Pre-existing save (1395, 1608), pricing (1589) and conditional Healthians freeze (1609) still happen before coupon validation (797–815). No zero-write, zero-provider or rollback claim is made or implied.

Introduced defects: **none found.** Low note:
- **L-L1** — Under the old `||`, a falsy non-undefined claim (`corporateId` of '' or null in a token) fell back to the body value or undefined. Now it is forwarded unchanged to the DTO, persistence (1471/1732) and coupon context (746/805). Coupon logic treats it as absent. How persistence casts '' depends on the external-booking model, which is not in the packet. This matches the contract's no-coalescing rule. Check the token-issuance shape and the model cast.

Known risks still open:
- The token claim is not fresh membership.
- `dependentId` from the body (validation 191, 321) is persisted (1470, 1731) and passed into the coupon context (804) without a relationship check.
- Raw and normalized payloads are logged, including patient contact data and the ignored body association (controller 403–408, 481–486).
- Pre-coupon saves, pricing and freeze have no compensation.
- Drafts created before this change may already carry fabricated associations; they are not remediated.
- Also open: provider callbacks, private immutable reports, signatory/critical-result roles, and API/panel/direct journeys.

## 6. Required focused checks (all NOT_RUN; complete C3 admission first)

- **M1**
  - Own detail/PUT/DELETE with omitted or self hint: exactly one combined `{_id, userId:A}` prefetch, the documented effects, and unchanged envelopes.
  - Foreign hint: 403 with zero service, read or effect dispatch, whether or not the booking exists.
  - Foreign or missing booking ID: 404 with zero writes, reminder, meeting or slot effects.
  - Malformed actor: 401 before HR. HR: 403 with zero dispatch.
  - By-user path/query matrix.
  - Actual Joi behavior for array/object/blank query values and invalid or empty body.
  - Express major version (L-C2), hex-case self hint (L-C1), and an inventory of token issuers.
  - Defect variants (owner forwarding removed, query trusted, unscoped fallback, late or weakened guards, HR bypass) must fail; restored controls must pass.
- **M2**
  - Paid `approved`/`not_required` from both predecessor statuses: one exact CAS, then one same-session consume.
  - Paid pending/rejected/missing/null/''/unknown: 409 with zero transaction, write or queue activity.
  - Unpaid+pending: payment 409.
  - Real-predicate CAS race on an owned replica set: `UPDATE_FAILED` with no consume.
  - Transient-retry behavior.
  - Consume-failure rollback.
  - Duplicate completion consumes at most once.
  - Release paths unchanged under pending/rejected.
  - Reproduce F1 (pending order at ready/out, where completion and cancel are both refused) as evidence for the owner decision.
  - Lean read of a document missing the field.
- **M3**, both handlers:
  - Unassociated user plus body association: no association in the DTO, persisted record or coupon context.
  - Actor A beats body B.
  - Admin: body value retained; omitted body gives undefined.
  - Non-admin foreign body `userId` ignored.
  - Positive-amount corporate-only coupon gives `INVALID_COUPON`, with the pre-existing save, pricing and freeze recorded.
  - Zero amount or no coupon skips validation.
  - '' and null claims (L-L1).
  - Reintroduced fallback, or association/owner placed before the spread: must fail.

## 7. Limitations

- I reviewed packet text only. I recomputed no hashes (packet, whole-file, excerpt) and did not compare against repository bytes.
- Full baseline files were not supplied. Conformance of unchanged regions relies on the supplied diffs and the native checks.
- Not in the packet:
  - bookings service outside 1233–1252/1525–1672, including `ensureCancelledBookingPaymentStatus`, `activateFollowUpBenefitIfEligible`, `cancelBooking` and the slot service;
  - bookings create schemas;
  - pharmacy service 123–175, 260–449, 481–559, 641–899 and 1093+, including the status gates in `update()`;
  - `PharmacyOrderRepository` beyond lines 1–35;
  - the payment service;
  - pharmacy and external types and models;
  - external service outside the cited ranges, including the retry-payment path;
  - external controller outside 1–42/344–505;
  - coupon service outside 155–175/650–700;
  - auth middleware 69–306;
  - Express, Joi and Mongoose versions.
- This review establishes no TypeScript, HTTP, Joi, DB, transaction, stock, provider or client behavior. Type validity and focused checks are NOT_RUN. Final cross-module integration is DEFERRED_BY_OWNER.
- I cannot independently observe this session's identifier, client kind, effective model or effort. The values above are as received or requested.
- No clinical, pharmacist, finance, privacy or security-owner decision, C2/C3 admission, or module, deployment or release acceptance is supplied by this review.