# SD-CLAUDE-SIX-INCREMENT-REVIEW-7 (claude-reviewer -> codex-lead)

**Result:** all six increments and their integrated composition are APPROVE_SOURCE_ONLY. I found no introduced contract violation. The most important finding is F5-1 (MEDIUM): it comes from the contract design, not a source deviation, and it needs a contract amendment or an explicit recovery-register entry before activation. F1 remains HIGH/OPEN.

## Binding context
Values are as received and compared textually only. I computed no hashes; Root verifies byte bindings.
- Team swasthadisha-local; challenge msg_1794476794026_c7qsgm0r (SD-CLAUDE-SIX-INCREMENT-CHALLENGE-7); nonce 9352b0cd-185f-47cf-a7be-42718e15f8c2
- sessionId c5ebf347-27df-460f-9b2f-0c7ff48ff7bb; sourceCommit ea48a35cce0c010bbbe6a112795a090931d6fd8c
- packetSha256 d73c2f97881dded32e3b7e794035603eb5ff6eaf5bf6c53b64d503d001584a92
- contractBundleSha256 fb293160078ca725f966bfb2841d417be5e0f9eb47235cafdb7507b3a86d3b68
- Model claude-opus-5-5 (harness statement); requested effort xhigh; effective effort UNPROVEN.
- Route: local CLI agent session using only Ruflo MCP mailbox tools (one inbox peek, two sends). No native webview, shell, filesystem, browser, hosted worker or delegation. Whether the CLI is the VSCode-bundled build cannot be observed from inside the session.

Source map (16, under src1/modules/, equal to the challenge):
- bookings/controller/index.ts b46f119eb8fbd509f6c29033bbb9546e8e19da84b6a0ba6b2f360510defeaf85
- bookings/services/index.ts 25645bc17bb535e2c3c5b6dcec14917ef5df905fe31838c980431dcf9e591051
- organizations/model/index.ts fb0e49483802ffe7eb64f2194804a2c15ef7e4cbd5a73fd6136af65ebc039ce0
- organizations/repository/index.ts 14532bf2d667e37d4ded33bb3767f744cd524bf385d88341d31f7954ece61d3b
- organizations/rules.ts b404c00381b5bf642aa648105cefb353a97c7ea7283c680059c426b5e4307942
- organizations/services/index.ts ccac5254a6e61c8cce4f14c58005cb39349689e3d0cbafc8ab551ca339397c73
- organizations/types/index.ts e873884e69db46d7de70d3120a5ac30809fe8dc526d118a4640463233c9633ff
- payment/services/index.ts 9c1086e3aa9239855ed3d73a02f941015d869bdb36a689a5294dea367ee7457d
- pharmacyInventory/controller/index.ts 0234b96e739c6e4d13ac92ce4813ce9440f60ae8b6008c03db3598d063cccbc8
- pharmacyInventory/repository/index.ts cee64fd2464b5d5ac6081531a63f9a176e5fc481f33c3a4d6def99a26d97b261
- pharmacyInventory/routes/index.ts cea26e2014545a8a9428e6fb20aa632cb7e80d9de37403f6519b819c0d5536c0
- pharmacyInventory/services/index.ts 98fa27296ef0fdd1066dff2d548de7d3db025504e724432770fe2e49d2907894
- pharmacyInventory/types/index.ts 6edf4cc6b84fde6e93a0310ac401ad71ef6bcee8bebc1fef992836b615891eae
- pharmacyInventory/validation/index.ts f1679413efcd27621a362eda7277a3d0db3edceb8d30fc2c542c075bef8dec53
- pharmacyOrders/prescriptionCommerce.ts 8e6db5fc64d5a5b2fec6437660fb0d308c24d3e1c0aec2ae95efdc2f73fe0058
- pharmacyOrders/services/index.ts aa68cce2580c440f86a65c3c2a26ce78303a69602b6c730b76bbf6e53d1400ae

Contract map (6, under documentation/planning/implementation/, equal to the challenge):
- BUSINESS_STAFF_AUTHORITY_CONTRACT.md 69dba46528295f55e184b95e1fb6ea451ee2371254d76eb7ac9fd6573068f9fd
- CUSTOMER_BOOKING_FIELDS_CONTRACT.md b7a82e761ebeacd808dfe11fbb66d7e467631c2aa062f91a8a34deaa8f2d94ea
- PHARMACY_REFUND_ERROR_PROPAGATION_CONTRACT.md 6e34cc83c22347b4ff6e13cbbb2a446de42696a787b1036010e20cef5d1854dd
- GATEWAY_CAPTURE_ADMISSION_CONTRACT.md e6956ec56ec5ce07d1208cf9cd0310a6fa4600212f2e02973828289c19ab633e
- PRESCRIPTION_CHECKOUT_ENABLEMENT_CONTRACT.md e3deb08a9002e4b11bf0d168dbce369312727841e5c96fa5c3a25503ea1781a7
- PHARMACY_QUALITY_WORKLIST_CONTRACT.md 710f300d1d335540599a912fcec1582ce6c7d636cc9a5f20a386615bbb9c12ee

Method: read-only inspection of the 16 complete current files, the 6 complete contracts and the supplied immediate context (routes, Joi, auth, validation middleware, error handler, models, BaseRepository, wallet/medicine/order context). Historical freeze, verification and decision records were read as provenance only, not as approval. Line numbers refer to the supplied whole files; "~L" marks positions counted from diff hunk headers or by hand.

## Verdicts
| # | Increment | Verdict |
| --- | --- | --- |
| 1 | internal-staff-authority | APPROVE_SOURCE_ONLY |
| 2 | customer-notes-only | APPROVE_SOURCE_ONLY |
| 3 | refund-error-propagation | APPROVE_SOURCE_ONLY |
| 4 | fetched-captured-only | APPROVE_SOURCE_ONLY |
| 5 | prospective-Rx-commerce | APPROVE_SOURCE_ONLY (source conforms; see F5-1) |
| 6 | stored-quality-worklist | APPROVE_SOURCE_ONLY |
| C | integrated composition | APPROVE_SOURCE_ONLY |

Each finding below is labelled latent, contract-design, runtime-unproven or omitted-context, and gives a minimum fix and the focused checks it needs.

## 1 Internal staff authority: APPROVE_SOURCE_ONLY
Verified:
- BSON allowlist (repository L15-46): ObjectId->hex only at legacyUser/legacyPharmacy `_id` (L32-35). Date->epoch only at declared timestamp paths (L16-21), which reject non-Date and negative/unsafe epochs. Any other Date/ObjectId denies (L36). Non-plain prototypes (Long, Decimal128, Binary, Buffer) deny (L42). Bounds are arrays <=100, objects <=32 keys, depth <=10. New authority IDs and revisions cannot be coerced into canonical form, so AUTH-SRC-2 is closed in source. Extra keys, including an own `__proto__`, fail the exact `shape` checks in rules.ts.
- Session (L53-61, L71-84): the session must be a real `mongo.ClientSession` with `client === connection.getClient()`, `inTransaction()` and readConcern `snapshot`. The held transaction object's identity is re-checked before and after every read, and the adapter never starts, commits, ends or retries. Lookup and session validation precede every read, and the readiness generation is re-checked against the lookup (L73-74).
- Predicates and projections match contract items 1-6. `limit(2)` with `single`/`one` makes ambiguity a denial. The fingerprint is compared before membership reads (L95), and a lab org denies before any other business collection is read.
- Rules check:
  - exact key shapes, canonical lowercase IDs, safe-integer revisions and time bounds;
  - mapping, grant and verification payloads against the current records (rules ~L193-227);
  - deciding actor != subject, with unique decision IDs and operation IDs;
  - a digest recomputed over fixed ordered arrays;
  - scope expiresAt = min(membership, eligibility).
- Branding (services L4-7, L21-24): a module-private WeakSet holds the frozen all-scalar scope, so caller-shaped objects never pass. Models use autoIndex/autoCreate false and strict throw, register only through the adapter, and conflicting pre-registration gives NOT_READY. There is no route, writer or wiring.

Findings (non-blocking):
- F1-1 LOW latent (repository L85-91; rules ~L198).
  - Trigger: lab requests return AUTHORITY_DENIED when the org is missing or not a lab. They return AUTHORITY_MAPPING_UNAVAILABLE only after an active lab org with an active branch matched, for any active ordinary user.
  - Consequence: the contract maps MAPPING_UNAVAILABLE to "generic unavailable" and DENIED to a uniform 403. A future public adapter following that mapping would let any signed-in customer probe whether lab orgs and branches exist, which contradicts "without tenant-existence details".
  - Minimum fix before any public adapter: deny `lab.report.release` with MAPPING_UNAVAILABLE before the User read, or collapse it into the uniform 403.
  - Check: a lab capability against a missing org, a pharmacy org and an active lab org gives one identical category with zero org reads.
- F1-2 LOW design (rules ~L213-215; model L29 with immutable canonicalId L5).
  - Trigger: the grant decision binds membershipRevision and the full grants snapshot, while each grant's `grantDecisionId` is immutable.
  - Consequence: any membership revision, such as adding a second branch grant, invalidates every older grant decision. Those grants deny until they are re-pointed. This fails closed and matches the contract.
  - Fix: the future writer contract must define re-issue/re-point semantics and race-test them.
- F1-3 LOW forward (services L5-7).
  - Trigger: `isBusinessScope` checks the brand only, not expiry or revocation.
  - Fix: future consumers must check `expiresAt` against a trusted clock and re-resolve inside the command transaction with a real write fence. A consumer API that takes `now` and refuses expired scopes is recommended.
- Runtime-unproven: the `mongo.ClientSession` export, `session.client`, `transaction.options.readConcern.level` and `Connection.getClient()` on the installed mongoose/mongodb versions are NOT_RUN. The code fails closed if they are absent. Installed indexes and snapshot topology are unproven.

## 2 Customer notes: APPROVE_SOURCE_ONLY
Verified (controller L364-378; services L1525-1576):
- The owner resolver is unchanged (L45-60: 401 for a malformed actor, 403 for a foreign query owner), and the HR read-only check still precedes dispatch.
- Only exact `userType === 'user'` dispatches, once, to `updateCustomerNotes(id, data, signedOwner)`. Every other actor keeps the original `update(id, data, userId)` call.
- The service follows the contract order:
  1. nonblank string owner, else 401;
  2. plain-object shape with no read, else 400;
  3. one owned `getById`, else 404;
  4. `Reflect.ownKeys` check including symbols and non-enumerables, else 422;
  5. own data-descriptor notes string, trimmed to 1..2000, else 400;
  6. status pending or confirmed, else 409;
  7. a single CAS on `{_id, userId, status in eligible}` with a literal `{$set:{notes}}`, `new:true`, `upsert:false`;
  8. a null result gives 409; otherwise the updated booking is returned directly.
- No generic update, lifecycle, reminder, meeting, slot, payment, wallet or notification helper is called, and the owner is used untrimmed in predicates.
- The shared Joi behavior (stripUnknown, min(1), trim, empty-string rejection) is correctly not claimed as raw-key rejection.

Findings: none introduced.
- Omitted-context limitation: BookingRepository and the booking model are not in the packet. The 3-argument call relies on BaseRepository.update (L67-73) not being overridden. Check: the recorded update carries the scoped predicate and `upsert:false`.
- Acknowledged risk, re-confirmed: for non-`user` roles the resolver returns the optional query userId. Pharmacy, specialist and unknown signed roles therefore still reach unscoped generic update, including status, paymentStatus and lifecycle effects. DELETE is unchanged. Note edits remain last-writer-wins.

## 3 Refund error propagation: APPROVE_SOURCE_ONLY
Verified:
- The helper's transaction is now try/finally with an awaited endSession (~L1553) and no catch. Any transaction rejection, including a duplicate key, exits before coupon reversal, the payment-state update and the success return.
- The sole caller, handleTimedOutPharmacyOrderPayment (~L189), awaits the helper before its core order/stock/payment transaction and its queues.
- processPharmacyOrderPayment returns that promise on all five timeout/terminal paths, so ordinary processing cannot continue after a rejection.
- isDuplicateKeyError remains in use by the pharmacy-wallet recharge path.

Findings (non-blocking):
- F3-1 INFO.
  - Trigger: errorHandler L15-21 serializes the propagated duplicate as 409 DUPLICATE_RESOURCE "This record already exists. Please refresh and try again." while the payment stays paid/unprocessed.
  - Consequence: if the conflict is a non-completed row (the unique partial index at wallet/model L108-118 ignores status), every retry repeats the failure. That is a dead-end holding captured money.
  - Fix: keep the contract's listed pending/failed-row case and add a recovery worklist. This is not a safety regression.
- Re-confirmed residuals:
  - completed-row trust;
  - after an in-transaction `alreadyRefunded` early return, the tail still reverses the coupon and returns the computed amount, so concurrent requests can reverse the coupon twice;
  - split wallet/order commits.

## 4 Fetched capture: APPROVE_SOURCE_ONLY
Verified:
- `razorpayPayment.status !== 'captured'` (~L777) rejects after the unchanged fetched failed/refunded branches. The PAYMENT_NOT_COMPLETED code and message are byte-preserved.
- verifyAndMarkPaid keeps its order: cached paid, existing status, signature, fetch, order/amount/currency, guard, markPaid.
- The rejection happens before verifyPaymentAndProcess enters its external-fulfilment try/catch, so no refund handler runs.

Findings: none.
- Re-confirmed open: cached-paid bypass, manual/internal paid labels, invalid-signature state poisoning, the `_id`-only markPaid race, no durable capture provenance and client-selected module routing.

## 5 Prospective Rx commerce: APPROVE_SOURCE_ONLY
Verified:
- Rule (prescriptionCommerce L1-77): the only import is AppError, and there is one export.
  - `new_items` requires a nonempty array, an own `prescriptionRequired === false` on every line (missing, undefined or truthy values deny), and documents omitted or empty.
  - `stored_order` requires:
    - canonical `_id` equality;
    - own `prescriptionStatus === 'not_required'` and an own empty `prescriptionUrls`;
    - nonempty items, each own-false and `itemStatus === 'active'`, with unique canonical medicine IDs (string or ObjectId);
    - one batch catalogue read of exactly those IDs, own-false flags, exact 1:1 correspondence and no inactive or archived medicine.
  - Read errors propagate.
- Raw classification: pricing assigns `medicine.prescriptionRequired` from a lean read without `?? false` (L448). Narrowing to `NonPrescriptionOrderItem` (L50-54) happens only after the gate (L587, L951).
- Placement:
  - create: the gate (L581-585) runs after pure/read checks and pricing, and before the moved ensureLinked (L588-595), the transaction/reservation/save, direct-paid, gateway and queues.
  - update: the gate runs after the 404/403/terminal/financial-lock checks.
    - Any own key other than notes triggers the stored gate plus an effective-URL new_items gate (L849-859).
    - The repricing gate (L945-953) runs before any mutation, and ensureLinked moved after the gates (L979-981).
    - Notes-only updates skip the rule.
  - markPaid: the gate (L1180) runs after the existing denials and before the timestamp, write and queues.
  - PaymentService: `assertNewPharmacyPaymentAllowed` (L420-436) loads the persisted order by a 24-hex contextId only.
    - createOrder calls it before credentials, client, provider call and save (L467, after the amount checks).
    - createDirectPaidTransaction calls it first (L539).
    - Other contexts are unaffected, and the verify/processing/timeout/refund tails are not gated.
- Composition: newly created non-Rx orders persist false flags, active items, not_required and an empty URL list, so the payment-entry stored gate passes unless the catalogue changes. A 503 after the save follows the existing abandonment/release path.

Findings:
- F5-1 MEDIUM contract-design consequence (not a source deviation). Locations: markPaid L1180 with rule L57-74; updateStatus completed-requires-paid ~L1060; ALLOWED_STATUS_TRANSITIONS L37-38.
  - Trigger (either case):
    - a non-Rx COD order already at ready_for_pickup or out_for_delivery whose medicine is later archived, deactivated or reclassified;
    - a legacy order lacking own itemStatus, prescriptionRequired or prescriptionUrls.
  - Consequence:
    - markPaid now returns 503, so `completed` is unreachable.
    - The service offers no exit from those statuses except `completed` (the cancel controller is not in the packet).
    - Reserved batch stock is never consumed or released, and cash already collected cannot be recorded.
    - Before this increment markPaid succeeded.
  - Minimum fix (contract amendment, then source): for markPaid on orders already past accepted, evaluate only the stored snapshot classification, without current isActive/archived/reclassification, or route the order to an accountable reconciliation worklist. At minimum, enumerate this dead-end in the F1/recovery register.
  - Checks: archive or reclassify a medicine after dispatch, then record markPaid, stock and reservation state; repeat with a legacy order missing those fields.
- F5-2 LOW omitted-context: `enrichesCommerce` assumes the controller forwards the Joi-sanitized body without injected keys. PharmacyOrderController (pinned e168f02e...) is not in the packet. Check: a real HTTP notes-only PUT on a legacy Rx order succeeds without a catalogue read.
- F5-3 LOW omitted-context: PaymentService gained a 19th constructor parameter. Any manual `new PaymentService(...)` would leave medicineRepository undefined and fail with a 500 TypeError, not a 503, on pharmacy_order payment creation. Check: whole-repo construction search plus TypeDI resolution.
- F5-4 INFO runtime: the payment-entry gate re-reads the just-committed order without a session. A non-primary read preference could miss it and abandon a legitimate order.
- Precedence change, deliberate and contract-recorded: an enrichment 503 now precedes the party/linked-reference 400s.
- Re-confirmed acknowledged: reads are not version fences; already-issued gateway orders can still capture and reach accepted/paid; there is no qualified review, cancellation refund or full recovery; new non-Rx attachments are disabled. This is prospective containment only, not clinical approval or F1 closure.

## 6 Stored quality worklist: APPROVE_SOURCE_ONLY
Verified:
- Route (routes L68-74): placed before `/:id`; requireOperationalPharmacy runs before the dedicated Joi (status enum, page 1..1000, limit 1..50, pharmacyId forbidden); no admin bypass.
- Controller (L204-219): forwards only the guard-resolved pharmacyId and explicit fields, does not call sanitizeInventoryItem, and returns `expiryEvaluation:'not_evaluated'`. The service only delegates.
- Repository (L314-440):
  - The scope must be lowercase 24-hex, else 403 before the pipeline. The query must be closed and plain (whitelisted string data keys, safe-integer bounds), else 400.
  - The first $match uses the ObjectId owner, an $elemMatch status prefilter, `$isArray` batches and a `$type` objectId owner check. A narrow $map projection follows, then $unwind with includeArrayIndex (L369).
  - A post-unwind status re-match with `$type:'string'` excludes active siblings and array-valued statuses.
  - One $facet runs a pre-page $count and a data branch: $sort {_id, batchPosition} (L375), skip and limit, then a name-only $lookup with $limit 1 that keeps rows whose medicine reference is missing.
  - The aggregate sets maxTimeMS 2000 and allowDiskUse false (L404-405).
- Result guards:
  - exactly one facet with two keys and at most one exact safe-integer metadata row;
  - data length == min(limit, max(0, total-skip)), so a page beyond the end returns empty data with a truthful total;
  - a missing required ID, status or position (L430) gives 503;
  - the DTO has exactly 13 fields with nulls for invalid values.
- There are no writes, clock or date logic, or quality transitions. One status tuple is shared by types, Joi and repository.

Findings (non-blocking):
- F6-1 INFO runtime (L369, L430): includeArrayIndex emits int64. The `typeof === 'number'` check relies on the driver's default promoteLongs; with promotion disabled, every nonempty page would return 503. Check this against the installed driver.
- F6-2 LOW capacity (L375, L404-405): the in-facet sort over all matching rows with allowDiskUse false can exceed the in-memory sort limit for long-lived high-batch pharmacies. The result is a DB error, not bounded degradation (AR-31, acknowledged). Explain, time and byte measurements are still required.
- The existing guard's token/pharmacyId semantics are unchanged and not newly certified.

## C Integrated composition: APPROVE_SOURCE_ONLY
- payment/services composes increments 3, 4 and 5 without overlap: the refund catch is absent, the captured-only predicate is present, and the new guard applies only to new-payment creators.
- Captured-only (4) means a fresh verification reaches the timeout refund helper (3) only after captured evidence. The cached-paid shortcut is the exception.
- The prospective gate (5) leaves already-issued Rx payments observable and processable. They remain blocked by the existing prescription-progress gate, and their cancellation still has no refund, so F1-b persists.
- Staff authority (1) is unwired, so no qualified review command exists.
- Inventory (6) is additive and read-only, and the InventoryService constructor is unchanged. Bookings (2) is independent.
- No new import or DI cycle is visible: prescriptionCommerce imports only AppError, inventory types has no imports, and PaymentService already depended on MedicineRepository transitively via InventoryService.
- Final cross-module integration is DEFERRED_BY_OWNER, not PASS.

## Non-claims and limits
- This is a source/data review only. It gives no acceptance for TypeScript/compiler/type, Joi, HTTP, Mongoose/driver, DB/index/transaction, provider, application, runtime, race, clinical, financial, security-owner, module, deployment or release.
- Omitted context: PharmacyOrderController, PharmacyCartService, BookingRepository/booking model, the specialist-portal caller, wallet services and the whole-repo call graph. Findings that depend on them are marked.
- Earlier internal Codex approvals are provenance, not Claude review. Hashes were compared textually only.