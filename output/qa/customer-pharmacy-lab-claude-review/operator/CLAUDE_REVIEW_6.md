# SD-CLAUDE-FOUR-MILESTONE-REVIEW-6 — Claude source-only review

**Overall decision: APPROVE_SOURCE_ONLY for each of the four milestones.** I found no introduced contract violation. Pharmacy F1 remains **HIGH / OPEN** and is still a release blocker for prescription dispensing. The amendment partly mitigates F1 but does not close it.

This review covers source text and recorded pure-fixture evidence only. It supplies no runtime, type, clinical, pharmacist, finance, privacy, security-owner, C2/C3, module, deployment or release acceptance. I read prior Codex/Root approvals as internal evidence, not as a Claude review.

| Milestone | Decision | Introduced defects | Main open items |
| --- | --- | --- | --- |
| 1 Lab dependent ownership | APPROVE_SOURCE_ONLY | None found | Non-`user` roles unchecked; read-time TOCTOU; inactive dependents accepted; ownership is not consent/guardian authority; constructor closure not admitted |
| 2 Lab log minimization | APPROVE_SOURCE_ONLY | None found | Retained userId; downstream/provider/error logs; historical sinks; no TC-OPS-007 pass |
| 3 Pharmacy Rx progress | APPROVE_SOURCE_ONLY | None found | F1 HIGH/OPEN: legacy ready/out dead end; no approval command, so every new Rx order stops at accepted, possibly after money is collected; cancel issues no refund |
| 4 Pure fixture recovery | APPROVE_SOURCE_ONLY (pure scope) | None found | Driver lifecycle premise unproven; not createDatabaseBoundary/driver/DB evidence; runtime3 cause unknown; lost historical QA still missing |

## 1. Binding context

- Selected challenge: `msg_1794471051061_l8ihbhic` (`SD-CLAUDE-FOUR-MILESTONE-CHALLENGE-6`, from `codex-lead`, 2026-11-12T08:10:51Z). It is the only inbox message carrying this packet's sessionId.
  - sessionId `203d42e1-6703-4755-93f9-78e269e55948`
  - nonce `4bb52ffc-5d7c-43ed-ba62-a08eed714df8`, ACKed in my previous send
  - clientKind as received: `local-bundled-CLI`
- Packet `SD-CLAUDE-FOUR-MILESTONE-SOURCE-PACKET-6`. packetSha256 as given in the challenge: `7c9159422d112f00fe7a44d44c0f152d4c569e5a876de11215034d34a183f18b`. I did not compute it; no hashing tool was in scope.
- sourceCommit `df8fd4ef00cb9d45d081ce760d15cef84a880c4e`, identical in packet and challenge.
- Source hashes, compared as text, are identical in packet and challenge:
  - externalBookings controller `6f2fca9b92a680d7612207c6b1d572f7551a1a6780684198f8997fc5f816ea8d`
  - pharmacyOrders service `75df8dffb4ead5043ab5f7c131302063068ea6b7c79e9b55fb582bd0481c71f5`
  - inventory bootstrap fixture `6470766a88a09763ffc1047daa5d072611ea8783459c2ac76cc668349f5b1968`
- Contract hashes are identical in packet and challenge:
  - dependent ownership `8bfccbdd4baaf64a59e0c2d6a6d019b03cba38c18aa7d23a4845ba9ad3aa3d97`
  - log minimization `177ae43228ea4e75457f7e3d3eeb2d41a14139973d30eef618dd6eafc2b2529a`
  - Rx progress `136041731cdc1a10c3263842d2c12dedcdeeedd850249a0770581746fe7fd53a`
  - pure fixture `d5262defa2dc94e76772b18dcc54e0fbd9b294c9a937653d022efd49ac966b01`
  - bundle `e6ab2e3461450e627e0b78168e40d3c9cdc5d3165dbe7c164b3d4c37974b9c97`, equal to the challenge `contractSha256`
- Ignored as stale:
  - `msg_1794469760104_7uxslc70` (R5, session `4a76a65e…`). Per the packet, that attempt produced no ACK or review; I do not reuse it.
  - `msg_1794464372502_vmbvz2nz` (R4, consumed)
  - `msg_1794461150814_in7ljrxb` and `msg_1794462964520_jc1ye2xg` (R2/R3)
  - connectivity-only `msg_1794338990732_89plt10f`
- The hash chain across the recorded artifacts is internally consistent as text:
  - controller `b036…` → `3a45…` (dependent FREEZE) → `6f2f…` (log SOURCE_FREEZE)
  - pharmacy `54bb…` → `75df…`
  - bootstrap `f4a4…` → `6470…` (SOURCE_RECOVERY, FREEZE_2, RUN_RESULT)
- Requested model `claude-opus-5-5` and effort `xhigh`. I make no claim about the effective model or effort; effective effort is UNPROVEN.

## 2. Method

This is a read-only review of the packet text. Tool use: one inbox peek and two sends. I had no shell, filesystem, git, compiler, Node, DB or provider access.

Line numbers cite the original files. I counted them inside the line-numbered excerpts and cross-checked against diff hunk headers (dependent diff +36/+383/+461; log diff 441/518; pharmacy diff +22/+1025/+1048) and the route block structure. Lines marked `~` are counted estimates.

I compared diffs, current source and recorded evidence as text only. I did not reconstruct bytes or verify raw run streams.

## 3. Milestone 1 — lab dependent ownership

**Disposition: APPROVE_SOURCE_ONLY.**

Confirmed in `src1/modules/externalBookings/controller/index.ts` (6f2f…):
- `AppError` and `DependentService` are imported (6, 8). The field is declared at 39, and the constructor resolves it with `Container.get(DependentService)` (45).
- `assertCustomerDependentOwner` (48–79):
  - 50: returns unless `userType` is exactly `'user'`. A missing actor, admin, case variants and unknown strings all return here.
  - 54–60: an exact user with a non-string or blank `_id` gets a fixed 401 `UNAUTHORIZED` / `Authentication is required`. Trim is used only to detect blanks; the owner is never rewritten. This check also runs when dependentId is omitted.
  - 62–65: an undefined dependentId returns with no query.
  - 67–76: a non-string value, or one failing `/^[0-9a-fA-F]{24}$/`, gets a fixed 404 `DEPENDENT_NOT_FOUND` / `Dependent not found` with no query. Status, code and message are byte-equal to `DependentService.getById`'s own 404 (dependents service 92–98), so malformed, foreign and missing IDs get the same response.
  - 78: exactly one awaited `getById(dependentId, actor._id)`. getById (82–101) starts from `{_id: id}` and adds `userId` only when it is truthy (86–88). Because line 54 guarantees a non-blank string, the single `dependentRepository.findOne` (90) always receives `{_id, userId: signed}`. The returned record is discarded and nothing is mutated.
- The guard is the first statement of `createBooking` (386) and `createDiagnosticsBooking` (462). It runs before:
  - owner resolution (387/463)
  - `UserModel.findById` (394/470)
  - DTO build (408/482)
  - the receipt log (441/518)
  - service dispatch (446/523)
- Routes 100–104 and 106–110 are `validate(body)` → `catchAsync(controller)`, with no role gate.
  - Both Joi schemas declare `dependentId: Joi.string().trim().optional()`.
  - Null, array, object and empty values therefore get Joi 400 before the guard, and whitespace is trimmed first.
  - The guard's `typeof` branch is only defensive.
- The DTO is unchanged. The `...req.body` spread (409/483) carries the validated dependentId into the drafts (external services ~1470, ~1731) and into the coupon context (`dependentId: params.booking.dependentId`, 804). For exact customers, that value is now checked against the signed owner at read time.

Introduced defects: **none found.** Low-severity compatibility notes (not defects):
- **L-D1 Hex case.** The regex admits upper-case hex, and the ObjectId cast is case-insensitive. An upper-case spelling of an owned ID therefore passes and is persisted verbatim, as the contract requires. Downstream exact-string comparisons of dependentId (coupon dependent restrictions, joins, reports) may then fail to match the canonical lower-case ID. The coupon service is not in the packet.
- **L-D2 Owner representation.** Matching relies on `dependents.userId` holding the same string as the signed `_id`. Legacy rows stored as a BSON ObjectId, or with a different spelling, would return 404 to their real owner. The existing dependent routes behave the same way. Check the data before rollout.
- **L-D3 New 401 without a dependent.** Exact-user tokens with a non-string `_id` are now refused on both create routes, even when no dependentId is sent. `authenticate` assigns the `jwt.verify` payload without validating its shape (auth.ts 46). Inventory every issuer of `userType:'user'` tokens.
- **L-D4 Scoping depends on line 54.** Because getById's owner argument is optional, scoping depends on line 54. If that check were removed, an empty-string `_id` would silently drop the owner predicate. Keep the `blank_owner_allowed` control, and add a runtime assertion that the issued filter always contains `userId`.

Known risks still open (not introduced, not certified):
- **B-D1 Other roles bypass the guard.** Any token whose userType is not exactly `user` (admin, hr, corporate, pharmacy, specialist, case variants, unknown strings) skips the guard. Its body dependentId is persisted and sent to coupon validation unchecked. An admin also chooses the body userId. This needs its own role contract.
- **B-D2 Read-time check only.** No owner or version predicate binds the later work: the draft save (external services 1395/1608), the Healthians freeze, and coupon, wallet, payment or provider calls. Deletion or reassignment can race the check.
- **B-D3 Inactive dependents accepted.** getById has no `isActive` filter, unlike the repository's list helpers (20–42). Account ownership is not guardian authority, consent, patient identity or clinical eligibility.
- **B-D4 Demographics unbound.** An owned dependentId can be sent with another person's patientName or contact details, or with the account-profile defaults (418–437).
- **B-D5 No revalidation elsewhere.** Saved bookings, retry-payment (which uses the stored booking), reports, cancel and reschedule are not rechecked.
- **B-D6 Constructor import closure has grown.** Routes line 32 constructs the controller at module load, which resolves DependentService → DependentRepository → DependentModel. This closure is not C3-admitted.
- **B-D7 Auth mount not seen.** The contract cites `src1/routes/index.ts:101` for the authenticate mount of `/api/v1/external-bookings`. The packet excerpt ends at line 100, so I did not see it.

## 4. Milestone 2 — lab booking log minimization

**Disposition: APPROVE_SOURCE_ONLY.**

Confirmed:
- `source.diff` removes exactly four lines (`frontendPayload: req.body` and `normalizedPayload: data`, in both events) and adds none. Hunk headers 441,8→441,6 and 520,8→518,6 match the current file.
- At current lines 441–444 and 518–521, both message strings are unchanged and the metadata is exactly `{ userId, integration: data.integration }`. No replacement key, spread, severity change or console output was added.
- These are the controller's only logger calls.
  - Both still run after the guard (386/462) and before dispatch, outside any catch or finally block.
  - A denied request returns before either event.
  - `data` is still built and passed to the service unchanged.

Introduced defects: **none found.** Notes:
- **L-L1 Retained identifiers.**
  - `userId` is linkable. For an admin it is the selected booking owner, not the acting admin.
  - The historical unauthenticated fallback can log a body userId or `'test-user'`.
  - `integration` is routing context.
  - Whether these are necessary, who can access them and how long they are kept still needs privacy/operations review.
- **L-L2 Denial logging.** Denials reach errorHandler, which logs only `err.message` with empty metadata (errorHandler 13). For the new guard that is the fixed text `Dependent not found` or `Authentication is required`. The visible create schemas give their pattern fields custom messages, so Joi 400s from those fields should not use Joi's default pattern message, which echoes the input value. This is an observation from the schema text, not a runtime claim.

Known risks still open:
- External service failure log (1430–1438): bookingId, providerId, bookingDate, bookingTime and pincode.
- Labstack/Healthians payload logs (cited by the contract, not in the packet).
- `showError` logs `err.response.data` or the whole error (logger 12–32).
- errorHandler logs `err.message` for downstream errors.
- `combined.log`, console collectors and backups: historical exposure, access, retention and holds.
- There is no protected audit store.
- This is neither a TC-OPS-007 pass nor a global logs-safe claim.

## 5. Milestone 3 — pharmacy prescription progress

**Disposition: APPROVE_SOURCE_ONLY. F1 remains HIGH / OPEN.**

Confirmed in `src1/modules/pharmacyOrders/services/index.ts` (75df…):
- Lines 25–30 add a module-private, unexported `PRESCRIPTION_GATED_STATUSES: OrderStatus[]` containing exactly `packed`, `ready_for_pickup`, `out_for_delivery` and `completed`. It has no accepted, release or terminal-release targets. The transition map (32–42) and the existing payment target list (1010) are unchanged.
- Error priority in `updateStatus`:
  1. not found (991)
  2. store 403 (994)
  3. terminal (997)
  4. illegal transition (1001–1007)
  5. non-COD progress payment check (1009–1019)
  6. completion payment check (1020–1026)
  7. single boolean (1028)
  8. closed allowlist `approved` | `not_required` (1029–1039), with the same 409 code and text
- Inventory list construction (1041–1044) and the transaction (1046) both come after the guard.
- The CAS filter (1048–1054) is `{_id, status: observed}`, plus the exact `prescriptionStatus: observed` only when that same boolean is true. The update body (1055) and `{new:true, session}` (1056) are unchanged.
- A CAS miss returns 500 `UPDATE_FAILED` (1059–1061) before release (1063–1065) and consume (1067–1069). Only `completed` consumes stock.
- Because the guard runs first, the CAS value for gated targets is always `approved` or `not_required`, never undefined.
- **The check fails closed whether or not the read is lean.** Suppose the repository's `findById` were not lean. A legacy document lacking the field could then read as the model default `not_required` and pass the guard. The exact CAS would still not match the stored document, so the result is a 500 with no effects. Orders with a missing field therefore cannot advance either way. R4 observed a lean `BaseRepository.findById`; neither repository is in this packet.
- Payment vs prescription priority:
  - online, unpaid, pending → packed: payment 409 (1009)
  - COD, unpaid, pending → packed: prescription 409
  - COD, unpaid, completion: payment 409 (1020)
- Paths that bypass or cannot reach the gate:
  - Cancel, reject and abandon are not gated.
  - `markPaid` only moves placed→accepted.
  - A zero-amount create sets accepted.
  - Joi `updateOrderSchema` has neither `status` nor `prescriptionStatus`, and `stripUnknown` removes them, so `update()` cannot set either field directly.

Introduced defects: **none found.**

**What changes for F1.** New prescription orders are always created `pending` (assertPrescriptionProvided ~468–484, called at ~581), and there is no first-party command to approve them. They now stop at accepted, or at placed. The existing accepted→cancelled and packed→cancelled transitions remain. A legacy packed order with an ineligible prescription state can no longer progress, but it can still be cancelled. This partly mitigates R4 F1.

**F1 residual — HIGH / OPEN; this change cannot close it:**
- **F1-a Legacy ready/out orders.** Orders already at ready_for_pickup or out_for_delivery with a pending, rejected, missing or unknown prescription state still get a completion 409. Cancellation is not a legal transition from those states (36–37). Stock stays reserved, money may already be captured, and goods may already have been handed over. This is the same dead end R4 described.
- **F1-b Rx is effectively disabled, but money is still collected.**
  - Nothing sets `approved`, so no new prescription order can be packed.
  - This includes in-store counter orders, and `buyerPharmacyId` wholesale orders containing `prescriptionRequired` medicines. Create requires prescription URLs and sets pending regardless of party.
  - Online payment and `markPaid` still collect money first.
  - The only exit is cancel. In `updateStatus`, cancel releases stock but does not change payment state or issue a refund. The pharmacy controller's cancel handler is not in the packet; the contract records it as a plain `updateStatus('cancelled')` caller.
  - Before enabling Rx, owners must decide on two things, and I am not choosing among the options:
    - either a qualified approval/rejection command with provenance and versioning, or blocking Rx creation and payment until such a command exists;
    - a refund path for paid cancellations.
- **F1-c Revocation and provenance.**
  - Orders approved and then revoked after packing have no exit.
  - A stored `approved` value is not qualified clinical approval.
  - A URL-only update keeps `approved`: the update `else if` branch (~931–941) only checks that the list is non-empty.
  - Approved→revoked→approved (ABA) changes are not detected.
- **F1-d** Paid cancellation, refund and stock recovery are not implemented.

Low notes:
- **L-P1** A CAS miss on the newly gated targets also surfaces as a generic 500 `UPDATE_FAILED`. Triage should not treat it as an infrastructure fault.
- **L-P2** The inherited message ("…before the order can be completed") is also returned when packed, ready or out is denied, which may confuse clients. The contract keeps this text for compatibility.
- **L-P3** Whether a patient-prescription gate should apply to B2B wholesale orders is a question for regulatory/pharmacy owners.

Known risks still open:
- `paymentStatus` is not part of the CAS, so a concurrent refund can race order progress.
- Consume uses the pre-transaction `order.items` snapshot.
- Legacy item edits debit available stock directly.
- Stock that expires before consumption can leave ready/out orders stuck.
- Catalogue `prescriptionRequired` classification is unresolved.

## 6. Milestone 4 — pharmacy pure fixture recovery

**Disposition: APPROVE_SOURCE_ONLY** for the fixture source and the recorded pure evidence, within the stated scope. I accept the byte-bound slice/VM technique for this pure scope. It is not a sandbox and does not substitute for running the driver.

Confirmed in `test/inventory-runtime/scenario/bootstrap.cjs` (6470…):
- The single changed expression is at 1514–1515, inside `trackCursor` (1512–1524) within `createDatabaseBoundary` (1491+).
  - Conjunct order is unchanged: `cursor` → `client` → `session` → `sessions.has` → namespace → `!leases.has`.
  - The new ternary reads no cursor property, and `command` is trackCursor's own parameter.
  - `leases.add`, `wire.expectCursor` and the close wrapper are unchanged.
- The three callers are closed, and only the first passes `'listCollections'`:
  - listCollections wrapper (~1675–1681): literal `'listCollections', '$cmd.listCollections', control, 3`
  - listIndexes wrapper (~1703–1708): `'listIndexes', name, control, 32`
  - find wrapper (~1709–1723): `'find', name, session, 1|16`
- Reply validation is still strict.
  - In `createWireBoundary` (~1273+), `started` matches the lease on `'$cmd.listCollections'`.
  - `succeeded` requires reply `ns === databaseName + '.$cmd.listCollections'`, `apmCursorZero` (`Object.is(value, 0)`), the exact cursor keys, and the row and byte caps.
  - `getMore` and `killCursors` still need a registered owner.
  - A DB-only namespace is therefore admitted only at cursor creation.
- Inverse binding. In normal mode the new test asserts that:
  - the new expression occurs exactly once;
  - `source.replace(new, old)` equals the baseline (sha `f4a49…`);
  - the four baseline slice hashes match the contract table.

  It refuses fixture bytes outside a ten-hash allowlist. Reverting to the baseline selects `premature-full` mode, which fails at case 2, so a revert cannot pass as normal.
- New test (`cursor-creation-pure.test.cjs`, 1f9f…):
  - requires only `assert`, `fs`, `path`, `crypto`, `vm` and the sibling bootstrap;
  - asserts `--permission` with no child/worker/addon grant;
  - evaluates the four slices in a VM context with explicit fakes and string/wasm code generation disabled;
  - has 47 named cases that match PLAN and the contract's planned groups 1–4.
- The recorded evidence (read as text; I did not see the raw streams) is internally consistent:
  - The three normal entries passed 296/95/47 checks with exit 0, and the new suite reported `sourceMode:'normal'`.
  - Each of the nine controls exits 1 at PLAN's `expectedFailingCase`.
  - Control bootstrap hashes are equal across RUN_RESULT, PLAN and the test's `sources` map.
  - Each control's `completed` count equals the position of its expected failing case in test order: premature-full 1, namespace-union 2, all-db 12, ignored-namespace 2, ignored-client 5, ignored-session 6, changed-lease 1, relaxed-reply 21, swallowed-failure 32.
  - Every stderr hash is the empty-input digest `e3b0c442…`.
  - argv is only `--permission --allow-fs-read=<lease>`.
  - All 12 leases are `VERIFIED_FRESH_ABSENCE`.
- The relaxed-reply and swallowed-failure controls were caught through the actual exported `createWireBoundary` and `collectReadCursor` from the weakened copy.

Introduced defects: **none found.** Notes:
- **L-F1 Driver premise not proven.** The `lazy-special-reply-*` and `failure-after-*` cases simulate namespace adoption by mutating the fake cursor themselves. They show the fixture accepts that sequence, not that the pinned driver 7.8.0 performs it. If the premise is wrong, the amended guard still fails closed (`INVENTORY_CURSOR`) rather than admitting too much.
- **L-F2 Weak error assertions.** `denied` accepts any `/INVENTORY_[A-Z_]+/` code rather than the specific expected one (`INVENTORY_CURSOR`, `INVENTORY_INDEX_PROOF`, `INVENTORY_SESSION`). The new test also reads `ports-manifest.json` and `cases.json` without the in-file hash checks that the APM entry performs; the launcher records those hashes externally. The named controls did fail at their intended cases, so this is not blocking. Tighten both in any future revision.
- **L-F3 Coverage.** The find wrapper's ACTION branch (scope filter, actionSession, singleBatch, rowLimit 1) is not exercised. Its filter comparison references `bson`, which the VM context does not provide. Those bytes are unchanged and inverse-bound.
- **L-F4 Fakes.** `need`, `same` (JSON equality), `sessionIdentity`, `optionsSession` and `ownCollection` are test doubles, so the module-global failure bookkeeping is not exercised. The VM `timeout` covers only the synchronous definition script; the launcher's 30-second limit bounds the rest. The contract acknowledges these points.
- **L-F5 Test discovery.** The integration record says existing entrypoints do not select these `*.test.cjs` files. I would also confirm that no CI job or `node --test` default glob picks them up (Node's defaults can match `test/**/*.cjs`). Outside the lease, the new test fails fast: `baseline-bootstrap.cjs` is missing and the permission assertion fails. If `bootstrap.cjs` is run directly it enters `main()`, whose first environment check rejects any environment other than the fixture container.

Known limits:
- This is not evidence of actual `createDatabaseBoundary`, driver initialization, BSON/SDK, Mongoose, app/HTTP/DB/provider or runtime3 success.
- runtime3's cause is still not established. No retry or new admission follows from consumed receipts.
- The lost historical constructor/296/57 QA remains missing and must not be recreated.
- SOURCE_RECOVERY and PREIMPLEMENTATION describe the pre-run state; RUN_RESULT and POSTEXECUTION are later records.

## 7. Required focused checks (all NOT_RUN; complete C3 admission first)

- **M1**, for both handlers:
  - Omitted dependentId: zero dependent reads.
  - Owned dependentId: exactly one `{_id, userId:A}` findOne, before the UserModel read and dispatch, with unchanged DTO, 201 and payment branches.
  - Foreign, missing and malformed IDs (non-hex, 23 or 25 characters): an identical 404 body, zero or one read, and no UserModel, service, booking, provider, coupon, wallet, payment or receipt-log effect.
  - Upper-case owned ID (L-D1).
  - Numeric, blank or whitespace `_id`: 401, with and without a dependentId.
  - Body userId B together with A's dependent: the lookup uses A.
  - Admin, hr, `'User'` and the unauthenticated direct call: no lookup. Record this as preserved behavior, not approved behavior.
  - Actual Joi results for null, array, object and blank values.
  - An owned inactive dependent is accepted.
  - Defect controls must fail: guard removed, unawaited or placed late in either handler; owner dropped or taken from the body; unscoped lookup; 404 swallowed.
  - Real TypeDI construction under admission.
- **M2**:
  - A recorder must separate these two messages from downstream logs. Their metadata keys must be exactly `{userId, integration}`, and patient canary values must be absent from these two events. No claim is made for all logs.
  - Dependent-denied requests emit neither event, only the bounded errorHandler line.
  - Restored properties, spreads or renames must fail the source assertions.
- **M3**:
  - Paid orders with `approved` or `not_required`, across every legal gated transition: one exact CAS; completion consumes once.
  - Paid orders with pending, rejected, missing, null, '' or unknown state at each gated target: 409, with no session, write or queue activity.
  - The payment/COD priority matrix.
  - A real-predicate race on an owned replica set for each newly gated target: 500 with no effects.
  - A document missing the field, under both lean and default reads.
  - Cancelling a paid, pending order from accepted and from packed: stock is released and paymentStatus is unchanged. Record explicitly that no refund occurs.
  - Reproduce F1-a and F1-b.
  - The contract's defect controls must fail.
- **M4**:
  - No rerun follows from this review.
  - Future strengthening: exact error codes per case, in-test data hashes, and ACTION-branch coverage.
  - Exercise the actual driver 7.8.0 listCollections lifecycle only under a separately admitted C3 runtime.

## 8. Limitations

- I reviewed packet text only. I recomputed no hash (packet, whole-file, excerpt or diff) and compared nothing against repository bytes.
- Not in the packet:
  - BaseRepository and PharmacyOrderRepository
  - the pharmacy controller (cancel) and payment confirmation
  - the coupon service
  - the dependents model, controller and routes
  - asyncHandler
  - `src1/routes/index.ts` from line 101 on
  - auth.ts 69–306
  - the external service outside the cited ranges, including retry-payment
  - Labstack/Healthians logging
  - bootstrap.cjs 66–689, 1001–1179 and 1796+, including `collectReadCursor` and most of `createReadBudget`
  - bootstrap-unit 49–779
  - the `run-pure.py` launcher and its raw RUN_RECORDS streams
  - the archived driver 7.8.0 text
  - Express, Joi, Mongoose and TypeDI versions
- I did not audit unseen code.
- This review establishes no TypeScript, HTTP, Joi, DB, transaction, stock, logger-sink, provider or client behavior. Type validity and focused checks are NOT_RUN. Final cross-module integration is DEFERRED_BY_OWNER.
- I cannot independently observe this session's identifier, client kind, effective model or effort. The values above are as received or requested.
- No clinical, pharmacist, finance, privacy or security-owner decision, no C2/C3 admission, and no module, deployment or release acceptance is supplied.