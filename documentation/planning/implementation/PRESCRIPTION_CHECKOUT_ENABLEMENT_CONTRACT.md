# Interim prescription checkout enablement — contract draft

12 November 2026. AUTHORING_ONLY / IMPLEMENTATION_NOT_ADMITTED. Author /root/policy_standards; two actual independent nonauthor Spec/Standards decisions on these exact bytes precede code. Root owns integration and cannot treat the author's draft as an approval. This follows Root's PRESCRIPTION_CHECKOUT_ENABLEMENT_DECISION (ae3596a7...) under the owner's delegated product/technical authority. No further owner naming question is needed. Real clinical judgments, existing captures and application/release gates remain separate.

## Selected boundary

Until qualified immutable-version prescription review and controlled paid cancellation/recovery exist with accepted focused evidence, admit only demonstrably non-prescription NEW pharmacy commerce. Reject new Rx/unknown-classification order creation, Rx/unknown existing-order enrichment, and new payment initiation/manual paid assertion for those orders. Apply equally to individual app, counter/direct, walk-in, zero-payable and wholesale business paths. Stored approved, an admin/business login, uploaded URLs, a zero amount, notes or a client flag never bypass this rule. No environment/test/feature toggle or automatic relabelling to not_required is introduced.

Use fixed503 PRESCRIPTION_CHECKOUT_UNAVAILABLE / Prescription checkout is currently unavailable. The existing error handler supplies {error:503,message,code}; no patient/medicine/document details are echoed. This is a closed feature-unavailable decision, not permission to collect and refund, auto-capture, open another checkout or automatically retry. No new polling/status/202 client contract is invented. Existing upstream validation/authentication/ownership and specified existing state denials retain their precedence.

Genuine Claude R6 approved four older bounded source milestones and explicitly retained F1-b: no qualified approval writer, so new Rx orders can collect funds but cannot progress; cancellation has no refund. Its exact review SHA83b0f6bf... is retained. This source increment would reduce NEW exposure, not close F1, repair already-issued payment opportunities or establish recovery.

## Actual current commerce inventory

Graph project swasthadisha indexes original bfb608e. Method discovery plus exact current source and bounded whole-src1 call searches establish the following inspected paths; empty graph caller results were not treated as proof of absence.

| Path / current canonical facts | Effect order and intervention |
| --- | --- |
| POST /api/v1/pharmacy-orders -> PharmacyOrderController.create -> PharmacyOrderService.create | Operational-pharmacy actor; body may select customer OR buyerPharmacy, in_store/online, cash_on_delivery/in_store_payment/online_payment. Existing validateOrderParty/assertUnique run; ensureLinked can write a customer association; linked checks read care records; pricing reads seller inventory and shared Medicine; transaction reserves stock and saves order; only then direct-zero or gateway payment setup and notifications. Put the new classification gate before customer-link mutation, stock/session/order/funding effects. |
| POST /api/v1/pharmacy-cart/checkout -> PharmacyCartService.checkout -> same create | Exact user or pharmacy actor; user becomes customerId, pharmacy actor becomes buyerPharmacyId. Refreshed cart lines/price checks precede delegation. Cart flags and requiresPrescription are cached display facts, never admission authority. Price-change409 may refresh the cart before delegation; preserve it. Successful delegation alone triggers deleteIfUnchanged(cart), so a503 must leave the cart available. |
| PUT /api/v1/pharmacy-orders/:id -> PharmacyOrderService.update | Owning operational pharmacy, nonterminal order. Financial fields allowed only while placed/pending/no paymentTransactionId. Items are repriced from canonical Medicine; otherwise existing lines/review state remain. Current mutation can change customer links, release/reserve/adjust stock, persist updates and enqueue subscription sync. Guard commerce enrichment before any such mutation. Notes-only maintenance is not a new funding/clinical grant. |
| PharmacyOrderService.create zero-payable branch -> PaymentService.createDirectPaidTransaction | Saves an internal paid record and then marks the order accepted/paid, even for zero payable. Gate creation and independently gate this shared internal payment entry for pharmacy_order. A free Rx order is still disabled. |
| PharmacyOrderService.create online branch -> PaymentService.createOrder | A new Razorpay order is created before its local payment record is saved. Gate on the persisted canonical pharmacy order before credentials/client construction, provider order creation or payment save. Covers a later internal caller as well as the current one. |
| POST /api/v1/pharmacy-orders/:id/mark-paid -> PharmacyOrderService.markPaid | Existing admin-or-owning-operational-pharmacy boundary; COD/in-store only. Supplied source/date/notes currently suffice to assert paid. Gate before that new assertion and before queues. Existing paid/refunded/terminal denials stay earlier. Backdating/manual source is no override. |
| User/pharmacy wallet paths | No inspected first-party pharmacy-order checkout debit or wallet reservation writer exists. PharmacyWalletService.payConsultation debits a consultation booking; wallet topups use wallet_recharge. Payment's pharmacy timeout helper credits a user wallet using legacy walletDeductedAmount notes. These are not new pharmacy-order wallet tender paths; do not invent or widen one. Any future Rx-order debit/internal funding entry must use this rule before money mutation under its own reviewed transaction contract. |
| Existing verify/capture, processPharmacyOrderPayment, timeout/refund and already-processed responses | These observe/process already-issued payment attempts; they are NOT new payment-order creators. Do not insert the prospective checkout denial before capture recording or blanket-disable their visibility. Their existing recovery and dispatch defects remain explicitly open. |

Pricing derives prescriptionRequired from MedicineRepository.findById, but currently substitutes medicine.prescriptionRequired ?? false. Both medicine and stored-order schemas also declare false/not_required defaults. Therefore truthiness, missing properties, hydrated defaults, cart snapshots and body flags cannot establish the chosen explicit non-Rx evidence. The rule must see raw canonical values before a default masks absence. BaseRepository's current findById/findAll are lean reads; preserve that property for these facts.

## Minimal source ownership and shared rule

Only three production files may change:

1. NEW src1/modules/pharmacyOrders/prescriptionCommerce.ts: one shared domain admission rule with closed new_items/stored_order input variants and one narrow callback for a batch current-Medicine fact read. Only shared AppError and type-only structural types are permitted; no typedi/Mongoose/model/service/provider/environment imports, new registry or framework. It may have private normalization/check helpers, but only one exported policy operation and one unavailable error definition. Rule evaluation may perform the explicitly supplied catalogue read; it performs no writes, transactions, logs or other I/O.
2. src1/modules/pharmacyOrders/services/index.ts: preserve raw pricing classification, call the rule for new/repriced items, existing commerce enrichment and markPaid; move existing ensureLinked only as described below. Reuse existing MedicineRepository and order repository. Keep all unrelated money, transition, stock calculation and side-effect code.
3. src1/modules/payment/services/index.ts: add existing MedicineRepository to constructor injection and a narrow private new-pharmacy-payment guard reused by createOrder/createDirectPaidTransaction. That guard loads the canonical order using the existing PharmacyOrderRepository and calls the shared rule. It must not import PharmacyOrderService. Preserve the independently accepted captured-only predicate and refund-error propagation repair.

No route/controller/schema/model/repository/public DTO, cart source, global wallet, auth, organization/staff, root dependency/runtime/start or provider configuration changes. Do not add order/payment state values, a payment API, capture/refund worker or clinical approval endpoint. Source-only QA may retain compact diff/pins/actual decisions; no controller archive or lexical-test framework.

The new file is justified by real use in both services. It must not create an OrderService <-> PaymentService import/DI cycle. The catalogue is shared master reference data; a batch projection through existing MedicineRepository is not a new unscoped private-business gateway. No new generic BaseRepository subclass is introduced.

## Exact facts and closed rule

The operation accepts only literal call-site variants, never a mode/options object forwarded from req.body, cart metadata, payment notes or a token. No role/approved/allowRx parameter exists.

**new_items variant:** input is the just-resolved server pricing lines, preserving raw medicine.prescriptionRequired, plus the effective prescriptionUrls. Require a nonempty array and every raw requirement exactly boolean false. Undefined/null/truthy/falsy strings/numbers, true and missing classification deny503; do not convert them. All new-item medicine IDs must already have resolved to the actual canonical medicine record. Existing missing/inactive/archived-Medicine and price errors from pricing can occur before this gate. prescriptionUrls must be omitted or an empty array. A nonempty or malformed list denies even when the canonical lines are non-Rx: this interim release does not accept new prescription-document workflows. Existing legitimate no-Rx checkout means explicit false classifications with no prescription attachment; the attachment restriction is an intentional compatibility change.

**stored_order variant:** input is an actual lean persisted order, never the payment request/body's claimed prescription facts. Require a nonempty item array; each stored line must have itemStatus exactly active and prescriptionRequired exactly false; prescriptionStatus must be the own stored value not_required; prescriptionUrls must be an own empty array. Missing/unknown/conflicting historical fields, removed/replaced lines, pending/rejected/approved status, or attached prescription documents deny503. Do not filter away a line to make an order pass, overwrite history, remove documents, normalize approved to not_required or pretend an unimplemented qualified-review record exists.

For an otherwise valid stored order, normalize its trusted persisted medicine IDs to canonical24-hex strings (ordinary strings or the existing Mongo ObjectId representation), reject malformed/duplicate identities, and perform one callback batch read of exactly that ID set. The service adapter uses MedicineRepository.findAll({_id:{$in:ids}}, {select:'_id prescriptionRequired isActive archivedAt'}). No request filter, caller-supplied classification, arbitrary projection or extra IDs. Require one matching returned medicine per ID, no duplicates/extras; every returned raw prescriptionRequired must be exactly false and current medicine must not be inactive/archived under the same existing pricing convention. Missing current rows/classification, mismatched IDs or read errors never fall back to the stored false value. Unavailable/invalid facts deny503; genuine database errors propagate, with no commerce continuation.

The shared rule tests both stored snapshot and current catalogue. It does not certify clinical/regulatory correctness of the master flag or supply classification provenance that the catalogue does not yet implement. A current false flag is the inspected master value, not a legal/clinical certification. Snapshot defaults from a hydrated document are not accepted as reconstructed legacy evidence; use the frozen lean adapters and prove the raw-missing cases later.

## Service insertion order and compatibility

### New create and cart checkout

Preserve validateOrderParty and assertUniqueMedicines first. Preserve pure recurring/linked-order restrictions and existing read-only linked-reference validation, but move the existing customerService.ensureLinked mutation until AFTER successful raw pricing + shared new_items admission. Reuse the one existing pricing result; no duplicate catalogue/pricing loop. No new patient/business lookup is added by this move.

To retain absence, change the LOCAL PricedOrderItem.prescriptionRequired type to boolean | undefined and assign medicine.prescriptionRequired directly instead of ?? false. No public type/model change. The rule accepts only explicit false before computeTotals/assertPrescriptionProvided or persistence; allowed no-Rx values still produce the existing not_required through existing logic. This is legitimate derivation from canonical false, not relabelling a legacy pending order. Existing assertPrescriptionProvided need not be globally rewritten or removed; the disabled Rx branch simply no longer reaches it.

Deny before runOrderInventoryTransaction/startSession/reservation/order-number generation/save, zero-paid record, gateway create, order update and new-order queue. Existing read-only medicine/inventory/reference checks may already have occurred. Moving ensureLinked changes precedence for invalid combinations: a pricing/unavailable/linked-reference denial can now occur before the former customer-link validation/write. Record this deliberate order; do not claim every old invalid-request error is preserved. All valid supported no-Rx business effects/amounts/envelopes remain unchanged. Cart price-refresh409 and cached display/add/remove behavior remain unchanged; they do not reserve stock or create an order.

### Existing order enrichment

Retain existing missing404, owning-pharmacy403, terminal400 and applicable ORDER_FINANCIALS_LOCKED409 before the new policy check. Commerce enrichment means any effective own update key other than notes, including items, orderType, customer/buyer, payment/delivery mode/address, walk-in, linked-care IDs or prescriptionUrls. Do not special-case undefined values, equal-to-current payloads or document deletion to bypass the check. Request/Joi field policy remains unchanged; this is not a certification of every direct internal generic-update field.

After those existing denials and before ensureLinked/stock/session/update/queues, evaluate the stored_order variant for enrichment. If repricing is requested, also evaluate new_items on the effective repriced raw facts and effective prescriptionUrls before any mutation. For a non-item change, evaluate effective new prescriptionUrls as well; a previously empty list cannot be enriched with an attachment. Do not clear pending/rejected/approved review state to permit repricing. A legacy Rx order cannot remove all Rx lines through generic enrichment to bootstrap itself into new commerce; that needs the separate reviewed recovery operation.

Notes-only maintenance keeps the existing narrow effect profile and does not call the new rule, so blocked legacy orders can retain operational notes without fabricated payment or review. Existing update code may queue subscription sync for recurring orders; do not claim zero queue effects for an allowed notes-only operation. It still cannot approve a prescription, issue a payment order, mark paid or bypass the progress gate. Read/list, cancel/reject/abandon and the existing qualified-progress containment remain outside this prospective gate; their safety/recovery is not newly accepted.

### New gateway/internal payment opportunities

In PaymentService.createOrder and createDirectPaidTransaction call the same private guard only for canonical data.context === pharmacy_order. Other existing booking/external_booking/wallet_recharge contexts keep their paths. Context comes from existing trusted server callers, not a new request-selected routing field; notes/module/body classifications are ignored for admission. This does not repair the separate client module dispatch defect in verification.

The private guard must load the actual order by data.contextId and reject missing/invalid/mismatched order facts with the same503. It must not accept data.notes.pharmacyId or a body order snapshot as proof. Call the shared stored_order rule with current catalogue callback. Perform it before getRazorpayCredentials/getRazorpayClient/orders.create/paymentRepository.save for gateway setup and before any direct-paid save. Existing pure invalid-amount checks may retain precedence. There is no provider call, new payment record or paid marker after policy rejection. Caller cleanup for a saved non-Rx order whose later new-payment gate fails still follows the existing setup-failure abandonment/release path; that compensation is not new Rx admission or refund proof.

### Manual paid assertion

In markPaid preserve existing404/actor403/payment-mode400/already-paid400/already-refunded400/terminal409 precedence. Then call the shared stored_order rule before paid timestamp/note construction and orderRepo.update or notification/subscription sync. Both admin and owning pharmacy follow it. A paidDate/paymentSource or claim that cash was already collected is not independently verified recovery evidence and cannot bypass it. The existing manual command is disabled for uncertain/Rx orders; genuine cash already received needs an accountable separately authorized reconciliation record, not concealment or invented refund. No such recovery operation is implemented by this slice.

## Existing external funds and races — do not conflate with new commerce

DO NOT add the new rule to validateSignature, fetchRazorpayPayment, verifyAndMarkPaid, markPaymentAsPaid, verifyPaymentAndProcess, processPharmacyOrderPayment, already-processed response or timeout/refund handling in this slice. In particular, do not return503 before recording an independently fetched existing capture merely because its legacy pharmacy order is Rx/unknown. Do not delete/mark failed/refunded a captured payment, hide issued gateway references, erase authorization evidence, cancel externally or invent a wallet/gateway refund to make the disabled checkout look resolved.

Preserve current verification/capture recording and its visible references with the accepted captured-only guard. Existing downstream continuation is not certified; its missing durable recovery, overwritten-status, cached-paid, client-module, manual funding, refund-destination and source-budget defects remain open. Already-issued gateway orders can still accept payment independently of this backend gate. Source edits cannot revoke them; authorized/unknown/captured legacy attempts require an accountable operational reconciliation/worklist and separately contracted durable recovery. Those controls and deployment facts remain unimplemented/unknown, so F1 and affected release gates stay open. No live dashboard/log/data or provider action is authorized here.

Admission reads are not a catalogue/order version fence. Existing classification/status/owner changes can race a check, and payment provider I/O remains outside local atomicity. This slice must not claim serialization, no-new-money under every race, complete cancellation recovery or durable captured-fact retention. The current capture-only/refund-error repairs must remain byte-preserved in composition. Before activation acceptance, separately reviewed exact version/fence, payment-intent, recovery and current authority mechanisms plus race/crash/replay evidence must close the applicable gaps. No permissive toggle is approved on the strength of this source-only containment.

## Required focused checks and acceptance

All executable/type/Joi/HTTP/DB/provider checks are NOT_RUN. After two nonauthor contract decisions, separately assign this exact source scope; require two actual independent nonauthor source/composition reviews before source-only integration. Focused execution needs a separately frozen admitted source/import/port/fixture/launcher closure under C3; no live provider, SDK install, compiler or root start is admitted here.

| Case | Required later behavioral evidence |
| --- | --- |
| App/direct/counter/wholesale; online/COD/in-store; positive and zero payable | Canonical Rx true and raw missing/null/nonboolean classification deny503 before customer-link mutation, order save, inventory transaction/reservation, direct paid, gateway setup and new-order queues. Valid all-false/no-document orders preserve their actual success/effects/envelopes. |
| Cart cached false vs current true; body price/flag/URL spoof | Actual create uses current canonical raw facts; no supplied flag/approved value/attachment/actor changes the decision. On503 no order/funds/reservation and no checkout cart deletion; price-change409 remains its existing explicit cart write. |
| Stored flags/review/history | Every pending/rejected/approved/missing/mismatched review, attached document, missing false flag, nonactive/removed/replaced line or malformed identity denies new commerce. No Rx line is filtered or history relabelled to pass. |
| Existing enrichment | Missing/foreign/terminal/financial-lock precedence preserved; non-Rx -> Rx/unknown repricing or document addition fails before mutation. Legacy Rx -> non-Rx generic replacement is blocked. Valid non-Rx enrichment and allowed notes-only maintenance preserve their separate effect profiles. |
| Shared payment creators | Direct internal call with pharmacy_order independently loads canonical order/current catalogue; fake body/notes cannot substitute it. Missing/changed/Rx facts deny before credentials/client/provider/save. Other contexts remain unchanged. Both direct-zero and gateway creation are covered. |
| Manual markPaid | Admin and pharmacy cannot bypass; blocked cases produce no paid update/queue. Existing terminal/paid/refunded/mode/actor errors keep precedence. Valid non-Rx manual behavior remains its existing, still-unverified collection model. |
| Catalogue port | Exactly one current-ID batch read for valid stored mode, prescribed projection, exact ID correspondence and no extra query scope. Failure/missing/duplicate rows/missing raw flags fails closed; no default or stored-snapshot fallback. New mode performs no second catalogue read after canonical pricing. |
| Existing issued gateway order/capture | Under recording ports, an existing matching captured payment remains observable through unchanged verification/reference storage even when its order is now Rx/unknown; no new checkout503 hides it. Record all existing processing/recovery limitations honestly. No live payment is used. |
| Races | Pause/change catalogue classification, order items/review or owner after admission reads; document any retained race, not a PASS claim of fencing. Full activation waits for separately reviewed current-version/intent/recovery controls and actual race evidence. |
| Meaningful weakening controls | Remove a create/update/payment/manual call, restore ?? false, trust cart/body/approved status, skip current catalogue, filter Rx lines or place the gate after funding/reservation; corresponding focused behavioral checks fail for the intended reason. Do not use hash rejection alone as proof. |

No pure/source/model review upgrades the selected scenario register or establishes clinical/financial/privacy/security, supported-client, module/M0 or deployment/release acceptance. Corporate/HR/hospital expansion and final cross-module integration remain deferred. The final workflow enablement requires a new exact readiness contract; there is no default future allow.

## Exact static bindings

| Selected input | SHA-256 |
| --- | --- |
| documentation/planning/implementation/PRESCRIPTION_CHECKOUT_ENABLEMENT_DECISION.md | ae3596a7d55978dbde43f6e69c99da8704a7eb34fc020301480ed3562c734e7b |
| documentation/planning/implementation/PHARMACY_DELEGATED_POLICY_DECISIONS.md | 3882d1dc976342376ed6729fc877fa80e15b79f225a37b10933c1d3681333f6f |
| documentation/planning/SYSTEM_DESIGN.md | cbd899f6fb442b13db28c389143b529b90da364165dc17291cc829814810bc84 |
| output/qa/customer-pharmacy-lab-claude-review/operator/CLAUDE_REVIEW_6.md | 83b0f6bfbe66e9a172d358bfc1b4de479f5168b4a797ba47640ca81ce76a5222 |
| src1/modules/payment/services/index.ts | 7571d95789a792ffb6a8582f129204b67b9159caceb3b320a3e48e809921024f |
| src1/modules/pharmacyOrders/services/index.ts | 75df8dffb4ead5043ab5f7c131302063068ea6b7c79e9b55fb582bd0481c71f5 |
| src1/modules/pharmacyOrders/controller/index.ts | e168f02e3ed0afce7587b2f4f0d40982c9c0fdfa5bd4062309c7c27a5601ef28 |
| src1/modules/pharmacyOrders/routes/index.ts | 057900f3675521cbfaa7c31e003d38a036ba46c6e2fa7fab4d7ee7b6a48ec815 |
| src1/modules/pharmacyOrders/types/index.ts | d9721c2b901acd559c224e88cf529aa1d4eb9617dd10f58d31073301575118a7 |
| src1/modules/pharmacyOrders/validation/index.ts | 6c4d01ebcb9db52c88bc8b0883dc679816f6b232a2c53ee5819d8f9e6f5afd64 |
| src1/modules/pharmacyOrders/model/index.ts | 86b2bb62e2e2191aff1f624f8dc344e97f519add9bd9ba02cfd2fffb37c7a2b8 |
| src1/modules/pharmacyOrders/repository/index.ts | 3b2c068fe8bcb9679811e6d44ccb265d162df4b3158d66ee051d1c83ceea9d44 |
| src1/modules/pharmacyCart/services/index.ts | 6c6f50cecfd60e7e404d6138329d5573b8075efe027ed1b4930a99db46c3f0e5 |
| src1/modules/pharmacyCart/controller/index.ts | 963a7dab2c4ecb6aca75dc9fe40c9f9a42958d491706b817db085f81c7c94798 |
| src1/modules/pharmacyCart/routes/index.ts | 45d128c4d4fd220d97e7a9dd20d202877adff92d361dfa478be688f92a4d78a9 |
| src1/modules/pharmacyCart/validation/index.ts | 15c4155c8989d15be12d31ac45207d1d2b4777734dce00745c3c0fc7993c2f18 |
| src1/modules/pharmacyMedicines/repository/index.ts | 2d3f1cc7e21804546bbdaa68d8316c9f3f4ae176f6cebc26626960908a02c2f3 |
| src1/modules/pharmacyMedicines/model/index.ts | 2dd98cd59a4e9a3aaa156d917f7cc131d7e30c7546ad7296b8a0ca4920c70725 |
| src1/modules/pharmacyMedicines/types/index.ts | 527e6987a95bae02c27bcd2d7547624c26251547efbc235a30fa2e52912fdf8d |
| src1/modules/pharmacyWallet/services/index.ts | 59513bb95f74e7b8e48911c2d48f400604d7d1d82cdfe3cdcb5bed0d2d168b61 |
| src1/modules/common/repository/BaseRepository.ts | 14a0fe5fdc9abd7a54b913bca4816a631b4bb263c11ad21ec37da0ee6c3f723a |

The payment baseline is the composed cf46b5e78d2d8a453f3230fa8ba30e40416d8024 captured-only/refund-error source; do not silently revert to the earlier6d565... guard. Pins are static provenance, not an execution closure. This author changed only this contract document; no code/import, Node/compiler/app/DB/provider/network/model/probe execution, package installation or Git mutation occurred.
