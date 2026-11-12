# Pharmacy cancellation recovery — bounded request-intake draft

12 November 2026. Author internal Codex /root/pharmacy_refund_primitives. PREPARATION ONLY; implementation and execution are NOT ADMITTED. Observed focus49f2c93bcaa56843621bfea7281dcc09096be198. Root selects technical/product policy under the owner's delegation; Root and a separate nonauthor must review these exact bytes before any future implementation. This document is not an R7 live input. Do not change any selected R7 production source during its capture.

## Selected next increment and prerequisite limit

The desired completed command is prospective non-prescription pre-handover cancellation: claim the current order once, prove no custody transfer, release precisely its live reservation and retain any money-return obligation atomically. Return each verified funded component to its original instrument against a shared reserved refund budget. Today the facts needed to perform that command are missing. A local paid/not_required label or batch quantity cannot supply them.

Select a smaller useful prerequisite: an individual customer's durable recovery-request intake and retrieval for an existing own pharmacy order, including paid, stuck, cancelled and legacy prescription/unknown orders. One embedded reconciliation-required request per order retains the request without automatically cancelling, releasing stock, creating a refund intent, calculating money owed or issuing a clinical decision. Legacy ambiguity is retained as unverified. Intake is allowed for an uncertain/Rx order because it creates no new commerce/funding/clinical opportunity; it must not call the prospective prescriptionCommerce gate or relabel prescription history.

Do not introduce an unused generic obligation collection or workflow engine. The initial operation is an actual customer POST plus own GET, backed by the same stored record. It does not close F1 or make existing cancellation/payment-timeout paths safe. Existing business cancellation is explicitly unfixed by this slice; no new use of it is enabled or advertised as safe.

## Verified current paths

Graph project swasthadisha indexes originalbfb608e; exact focus source controls these findings.

| Actual source | Current guarantee / obstacle |
| --- | --- |
| PharmacyOrderService.updateStatus1023+; controller.cancel; existing status route | Owning operational-pharmacy status command. Cancel/reject/abandon can update status then release stock in runOrderInventoryTransaction. No durable money-return obligation exists. CAS includes status, and prescriptionStatus only on progress; no shared owner/item/payment/custody version fence. Both status and cancel entry points reach it. |
| OrderService.releaseOrderInventory208+; InventoryService.releaseOrderStockBulk411+; InventoryItemRepository.releaseBatchAllocations195+ | Same session, but batch quantities are aggregated across orders. There is no order-reservation identity/claim. Legacy lines return aggregate stock; this is not custody/physical-return proof. Recalled/quarantined/expired statuses remain restricted, but release can reclassify other statuses using UTC today. |
| OrderService.abandonOrderAfterPaymentSetupFailure273+ and abandonStaleUnpaidOrders1239+ | Separate abandonment/release writers; not covered by a repair to cancel alone. |
| PaymentService.processPharmacyOrderPayment985+ and handleTimedOutPharmacyOrderPayment190+ | Terminal/timed-out orders can trigger user-wallet credit followed by a separate order/payment/inventory transaction. Terminal labels are treated as inventory-already-released. Some writes still use only _id. No new recovery record may treat these labels as a verified financial winner or custody history. |
| PaymentService.verifyAndMarkPaid811+ and createDirectPaidTransaction536+; OrderService.markPaid1126+ | Newly fetched gateway status is now captured-only; cached-paid and manual/internal labels still lack durable capture/collection facts. The refund helper's swallowing catch is now removed. These accepted repairs do not create instrument/source budgets or reconciliation. |
| organizations types/repository | Internal pharmacy prescription-review authority exists, with no activated grant/provisioning workflow. No finance/recovery or stock/custody capability is defined. Do not repurpose pharmacy.prescription.review or a business/admin token as authority to refund/release/settle. |

No live provider/dashboard/log/record was inspected. Earlier AUTHORITY_RECOVERY_BASELINE statements about authorized-as-paid and swallowed refund errors are historical and superseded only by the two bounded accepted repairs above.

## Exact initial source boundary

Future source assignment, only after two nonauthor decisions: six existing pharmacyOrders files: routes/index.ts, controller/index.ts, services/index.ts, repository/index.ts, types/index.ts and model/index.ts. Add two routes, thin controllers, mandatory signed-customer service methods, narrow repository operations and one embedded record/DTO. No new framework/helper module/collection, dependency/index creation, provider, wallet, payment, inventory, auth, organization-capability or existing cancellation/verification writer edit. All existing methods/routes/DTO behavior stay byte-preserved apart from necessary imports and the newly persisted optional field appearing in existing authorized full-order reads.

POST /api/v1/pharmacy-orders/:id/recovery-request records the one request. GET the same path returns it, or data:null for an owned order with no request. Both remain under existing authenticate. Add specific routes before generic detail; no shadowing. Only exact user actors may invoke these additions. Missing/nonobject principal401 UNAUTHORIZED / Authentication is required; non-user403 FORBIDDEN / Individual customer access is required; missing/nonprimitive/noncanonical lowercase24hex signed _id403 FORBIDDEN / Access denied, before database access. Existing authenticate errors take precedence. Malformed/nonprimitive/noncanonical lowercase24hex route id400 VALIDATION_ERROR / Invalid pharmacy order ID. No coercion, trimming, createdBy/payer/dependent/buyerPharmacy/corporate fallback or new active-account claim.

Only signed principal and route id reach the service/repository. Body/query fields are unsupported and ignored, never forwarded or treated as amount, owner, status, notes, reason, operation ID, request time or evidence. There is no promised rejection of raw unknown fields. The caller need not submit a new idempotency key or document. No free text, document upload or external link is accepted.

First resource read must combine actual ObjectId _id and signed-customer ObjectId customerId plus expression type guards requiring both stored fields to be scalar objectIds. Query a single existing PharmacyOrderModel row; never use ownerless getById then compare, auto-create customer/order, populate a patient or read PaymentRecord/Wallet/Inventory. Project only _id,customerId,pharmacyId,status,paymentStatus,paymentTransactionId,recoveryRequest. No match/foreign/wholesale-without-customer all404 ORDER_NOT_FOUND / Order not found. The existing order's customer association grants only commercial request intake; it is not patient consent, clinical-record access, funded-payer identity or refund authority.

## Closed durable record, idempotency and money truth

Use optional embedded recoveryRequest with default undefined, strict closed sub-schema, _id:false, no legacy backfill/default request. One physical order document holds at most one request; no array, separate upsert collection or custom uniqueness index is needed. Shape:

- schemaVersion:1; operationKind:customer_recovery_request.
- operationId: exact server-derived pharmacy-recovery-request:v1:<canonicalOrderId>. It is an operation identity, not an authorization token or globally readable lookup key.
- requestingCustomerId: the validated owned account; orderId: canonical actual order ID; status:reconciliation_required only.
- requestedAt: actual server Date. No body/paidDate input; it means request record time only.
- observation: closed own fields orderStatusLabel and paymentStatusLabel (recognized existing labels or unknown), paymentRecordId (canonical24hex string or null), paymentRecordReferenceState:recorded|missing|malformed. A reference's presence proves no capture, amount, ownership or refund. Retain malformed/missing distinction without retaining arbitrary raw data.
- amountMinor:null; currency:null; instrument:unknown; destinationPolicy:original_instrument. Null is unknown, never zero or a validated debt/refund promise. No numeric arithmetic or local paid-label inference occurs.
- payloadSha256 and observationSha256: lowercase64hex digests over separate fixed schema-versioned ordered arrays. Request payload binds operation kind/version/order/customer; observation digest binds exact stored first observation and requestedAt epoch. Freeze exact serialization vectors in implementation review. Digests detect inconsistent data, not protected provenance against a privileged database rewrite.

The successful POST stores only this record and the ordinary order updatedAt maintained by the existing timestamps mechanism. It never changes order.status/paymentStatus/items, payment records, currency, reservation/stock/quality, coupon counts, wallet/ledger balances or provider state. No notification/subscription/audit-sink/queue/worker is invoked. A request is an obligation to reconcile facts and determine whether money is owed; it is not an executable refund intent or proof that custody was retained.

First creation uses a scoped same-session findOneAndUpdate with actual _id/customerId, scalar-type checks and recoveryRequest:{$exists:false}; upsert:false, runValidators:true, return new, fixed projection, maxTimeMS2000. Repository exposes only mandatory canonical order/customer arguments and a caller-owned session; never optional scope or FilterQuery/options from the request. It validates returned ownership/identity and the closed stored record/digests before returning a DTO. Malformed required stored identity/record produces503 PHARMACY_RECOVERY_UNAVAILABLE / Pharmacy recovery is unavailable; no repair or raw error echo.

Exact replay returns the same stored request/observation/time, not a new operation or refreshed observation. Validate stored operation/order/customer/digests before returning; never overwrite/reopen a malformed, conflicting or unknown-version record. If the insert CAS misses, one further scoped read may identify the committed same request; missing/changed ownership404, malformed/conflicting record503. No alternate ID/key, ownerless lookup, blind update, catch-as-success or free-running application retry. An uncertain commit must remain an error until the same deterministic operation is read/reconciled; no newly generated key.

The command transaction must use the same actual Mongoose client/session for scoped read and marker write, snapshot readConcern and one existing driver withTransaction boundary, no nested session/provider action. Its normal driver transaction/commit retries are not advertised as zero retries; every re-executed callback uses the same deterministic operation identity and no external effect. A transaction abort leaves no marker. Concurrent requests have one committed first observation; losers may return that exact committed request after a bounded scoped read or surface the driver's failure. No duplicate success is inferred from duplicate-key/write-conflict errors alone. This is marker idempotency, not money/stock exactly-once proof.

## API and actionable lookup boundary

Both successful routes return HTTP200 and Cache-Control:private,no-store with exactly {success:true,data:null|{operationId,status,requestedAt,amountMinor,currency,instrument,destinationPolicy}}. POST data is non-null; GET data:null means only that this owned order has no record. ISO requestedAt, fixed labels/nulls and bounded operation ID keep compact UTF-8 body under2048bytes. Do not return customer IDs, observed payment reference, raw order, prescription/patient fields, amount claim or gateway identifiers. Repository reads are lean, bounded single-row, maxTimeMS2000. Actual driver/HTTP byte behavior remains unproved.

Customer GET provides the request's durable receipt after lost responses. Existing owning-pharmacy order detail/list can expose this small embedded marker under their existing authority; no new bulk scan/filter, worklist, finance permission or collection access is introduced. This is an actionable per-known-order reference for a later authorized operator, not an implemented assigned finance queue, alert, acknowledgment or case-resolution process. No auto-poll/retry promise. Before operational activation an accountable protected reconciliation/read-worklist contract must establish actual operator visibility/assignment and existing raw-order DTO/privacy implications; source intake alone cannot be sold as completed recovery. Direct/no-app, buyer-pharmacy and representative request intake remain separate contracts, not silently lost scope.

Existing cancel/status/abandonment/markPaid, already-issued gateway orders and verification/timeout/refund writers remain unchanged. A later timeout/wallet credit must not mark this reconciliation request resolved: only status reconciliation_required exists here. Its observation remains historical when source order/payment facts change. No shared fence against those old writers is claimed; they remain open risks requiring their own containment and eventual composition.

## Preconditions for the intended atomic cancellation/refund command

Do not add a permissive completion toggle or enable this from a source-only intake pass.

| Required fact/mechanism | Exact boundary still required |
| --- | --- |
| Capture/instrument | Durable immutable merchant/account/payment/order/payer/currency/captured-minor-unit evidence and attempt identity; authorization/settlement/manual paid/internal zero each distinct. Current fetched captured-only observation is insufficient durable admission. |
| Cash/wallet | Independently verified collection or actual wallet debit/source identity, not cash notes or legacy walletDeductedAmount. Payer customer vs buyer-pharmacy must be explicit. |
| Units | Gateway/new source budgets use explicit currency + safe integer minor units. Existing decimal rupees and Math.round projections are unverified legacy observations; do not silently convert, round, default currency or derive debt. Legacy user-wallet rows have no currency. Verified conversions need a separate conservation contract. |
| Shared budget | Per verified funded source, atomically reserve outstanding return amount against confirmed returns + pending/reserved obligations; all cancellation, timeout, webhook, admin/manual and alternate-destination paths participate. No omitted amount, over-budget payout or coupon value mistaken for captured cash. |
| Custody/reservation | Explicit no-handover/custody evidence and current order-specific reservation identity/version, quantities and quality rules; release only that reservation once in the same transaction as order transition and durable obligation. Post-dispatch/returned goods require separate inspection/disposition. |
| Current authority | Protected individual operations/recovery/finance capabilities, provisioning/readiness and shared write fences against revocation/owner/payment/item changes. Existing business/admin role or clinical capability is not sufficient. |
| Provider/reconciliation | Frozen actual original-instrument refund adapter; matching confirmed effect before refunded, retained uncertain outcomes and stable receipt/operation/payload. Reconcile duplicates before retry; no invented universal idempotency header or automatic wallet replacement. |
| Durability/indexes | Exact bounded operation/source budget records and installed verified uniqueness/topology evidence before effects. Existing wallet refund partial index includes pending/failed rows and is not a substitute. The initial embedded request needs only existing _id uniqueness, whose runtime state is not newly certified. |

No real schema/index synchronization, data migration, provider call, credential/log access, refund, transaction or clinical action is authorized by this draft.

## Focused evidence and review gates

After two independent nonauthor contract decisions, implementation needs two independent nonauthor source/composition reviews. Freeze exact serialization/record/DTO and source hashes. Future focused C3 admission must execute actual methods/HTTP/driver queries, not source regex alone:

1. Owned individual request/read, including paid/stuck/terminal/Rx/unknown labels, returns the one honest reconciliation receipt without changing source order state/financial/stock rows; GET absent marker returns data:null.
2. Two customers, foreign/missing IDs, wholesale/no-customer, missing/non-user/malformed principal, malformed IDs and forged body/query authority; assert actual combined owner/scalar predicates and fixed precedence before writes. No foreign existence probe.
3. Exact lost-response replay, concurrent request winners, transaction abort/retry/unknown commit and source owner change; only one committed first observation, no overwrite or alternate key. Pending/malformed/unknown-version record is never treated resolved or repaired.
4. Date/ID/digest/label/missing/malformed/oversized reference boundaries; independently declared digest vectors and exact response keys/header/bytes. No raw reference, medicine/patient/document/payment amount escapes.
5. Recording ports prove no payment/provider/wallet/inventory/quality/coupon/email/queue/subscription effect from these new methods. Existing constructor/middleware/import effects are measured separately, not claimed zero globally.
6. Existing raw-detail/list/cancel/status/abandonment/payment/progress source remains inverse-byte preserved; their unsafe financial/custody behavior is recorded as still open, not accidentally certified.
7. Meaningful actual-source controls dropping scoped owner/scalar predicate, overwriting/re-keying marker, assigning amount/refunded, or calling old cancel/refund/release helpers must fail the intended behavioral assertion. Hash rejection alone is not evidence.

Current no execution: TypeScript/Node/compiler/Joi/HTTP/Mongoose/DB/provider/driver/transaction/race/index/DTO effects NOT_RUN. Existing service construction imports payment/inventory/providers; this contract does not admit it. Complete pre-import C3, C2 root adoption, financial/clinical/privacy/security/owner/module/release gates remain. Corporate/HR/hospital expansion and final cross-module campaign remain deferred.

## Selected static provenance

These pins are preparation inputs, not a complete executable closure. Rebind before implementation; do not overwrite historical baseline evidence or R7 capture inputs.

| Path | SHA-256 |
| --- | --- |
| documentation/planning/implementation/PHARMACY_DELEGATED_POLICY_DECISIONS.md | 3882d1dc976342376ed6729fc877fa80e15b79f225a37b10933c1d3681333f6f |
| documentation/planning/implementation/PHARMACY_AUTHORITY_RECOVERY_BASELINE.md | fffc6ccc2e463febc34d1802addf212f96e856993cff961ffb8ad6606e9ed2d7 |
| documentation/planning/implementation/PRESCRIPTION_CHECKOUT_ENABLEMENT_CONTRACT.md | e3deb08a9002e4b11bf0d168dbce369312727841e5c96fa5c3a25503ea1781a7 |
| src1/modules/pharmacyOrders/routes/index.ts | 057900f3675521cbfaa7c31e003d38a036ba46c6e2fa7fab4d7ee7b6a48ec815 |
| src1/modules/pharmacyOrders/controller/index.ts | e168f02e3ed0afce7587b2f4f0d40982c9c0fdfa5bd4062309c7c27a5601ef28 |
| src1/modules/pharmacyOrders/services/index.ts | aa68cce2580c440f86a65c3c2a26ce78303a69602b6c730b76bbf6e53d1400ae |
| src1/modules/pharmacyOrders/repository/index.ts | 3b2c068fe8bcb9679811e6d44ccb265d162df4b3158d66ee051d1c83ceea9d44 |
| src1/modules/pharmacyOrders/types/index.ts | d9721c2b901acd559c224e88cf529aa1d4eb9617dd10f58d31073301575118a7 |
| src1/modules/pharmacyOrders/model/index.ts | 86b2bb62e2e2191aff1f624f8dc344e97f519add9bd9ba02cfd2fffb37c7a2b8 |
| src1/modules/payment/services/index.ts | 9c1086e3aa9239855ed3d73a02f941015d869bdb36a689a5294dea367ee7457d |
| src1/modules/payment/types/index.ts | 6f150e89fe0e7f6fa80188c88621cdfc9254f33b6edcded9c5a70f7c577beff8 |
| src1/modules/payment/model/index.ts | 0824a3efc2f3056ca4817e16359881769bf4728563b2eb2bed0fb04dbc3ec1fb |
| src1/modules/pharmacyInventory/services/index.ts | 98fa27296ef0fdd1066dff2d548de7d3db025504e724432770fe2e49d2907894 |
| src1/modules/pharmacyInventory/repository/index.ts | cee64fd2464b5d5ac6081531a63f9a176e5fc481f33c3a4d6def99a26d97b261 |
| src1/modules/wallet/model/index.ts | 18757f38145a2ebab378cd1d00c423170a00fd3b136b1229105244fb1a540538 |
| src1/modules/wallet/repository/index.ts | 4db66107afa4ecb7db99a91c3d9216488a514145187e56bc0d589677e344b726 |
| src1/modules/organizations/types/index.ts | e873884e69db46d7de70d3120a5ac30809fe8dc526d118a4640463233c9633ff |
| src1/modules/organizations/repository/index.ts | 14532bf2d667e37d4ded33bb3767f744cd524bf385d88341d31f7954ece61d3b |
| src1/modules/common/repository/BaseRepository.ts | 14a0fe5fdc9abd7a54b913bca4816a631b4bb263c11ad21ec37da0ee6c3f723a |
| src1/modules/middleware/auth.ts | db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2 |
| src1/routes/index.ts | 50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056 |
