# Fetched gateway capture admission — bounded contract

12 November 2026. DRAFT_ONLY; author /root/policy_standards. Two actual independent nonauthor Spec/Standards decisions on these exact bytes precede source edits. Root owns source assignment/integration; the author cannot approve this contract. Focus observed HEAD51eab88d8ec72d40b2f970d0c3338237c49c489e; selected source pins below govern despite unrelated concurrent work. Do not change R6-selected inputs during its review capture. This document changes no production source and admits no execution.

## Defect, design and selected behavior

The shared client verification path accepts a fetched Razorpay payment in authorized or captured state, then records local paid and enters normal context processing. Authorization does not establish collection. SYSTEM_DESIGN section9.2 requires captured evidence matching order/amount/currency before collection; section9.1 keeps authorized attempts out of paid state. The owner delegated product/technical choices, and PHARMACY_DELEGATED_POLICY_DECISIONS selects distinct authorization/capture facts. No additional owner naming or product-policy confirmation is needed for this protective change.

Select the smallest current-path repair: only a fetched status exactly equal to the lowercase string captured may pass the existing terminal guard. A valid request whose fetched payment is merely authorized gets the existing400 PAYMENT_NOT_COMPLETED error and never reaches markPaymentAsPaid or normal fulfillment from that attempt. It remains unpaid by this attempt; absent another writer, the original local created record is unchanged. Do not claim the persisted record cannot change concurrently through another path.

This is a prerequisite containment, not complete capture admission across every writer. It neither captures/voids a payment nor creates a new pending/reconciliation response, order, retry, refund, journal, worker or provider framework. It does not equate captured with settled or assert that every existing paid row has capture proof.

## Exact source replacement

Only production file: src1/modules/payment/services/index.ts, current SHA-2566d56575a3dee2d08d1af5c6cc409e170b8ed5c193ccbc090f336f313b5e93b16. This baseline includes the independently reviewed refund-error propagation deletion; preserve it and every other byte.

Inside handleGatewayTerminalStatus, replace exactly this unique line:

```typescript
    if (!['authorized', 'captured'].includes(razorpayPayment.status)) {
```

with:

```typescript
    if (razorpayPayment.status !== 'captured') {
```

No status normalization, alternate success value, test flag, environment bypass or fallback. Preserve the preceding failed/refunded branches, their writes/errors, the existing PAYMENT_NOT_COMPLETED status/code/message interpolation, and every caller/argument/await/return. No model/index/type, signature, amount/unit/currency/order/payer checks, fetch mapping, cached-paid behavior, markPaid predicate, processing dispatch, route/controller/envelope, logger or root dependency/runtime/start change. No new helper or duplicated status list is required.

## Verified affected call path and ordering

Graph project swasthadisha discovers handleGatewayTerminalStatus and verifyAndMarkPaid, but indexes the original bfb608e checkout. Current exact source and a bounded whole-src1 call literal check confirm one direct guard caller and one direct verifyAndMarkPaid caller. Graph absence is not proof of a deployed call graph.

1. The existing authenticated POST /api/v1/payments/verify validates the body and PaymentController.verify derives userId/requesterUserType/requesterPharmacyId from the signed request, then awaits verifyPaymentAndProcess. Nothing about actor authorization is broadened here.
2. verifyPaymentAndProcess performs its initial request log, then awaits verifyAndMarkPaid before its verified log, already-processed response and every normal context dispatcher. The terminal guard's rejection occurs outside the later external-booking fulfillment try/catch, so that rejection does not invoke its failure/refund handler.
3. verifyAndMarkPaid reads the payment with existing requester/order checks. A local status paid returns early without the new guard. Otherwise existing failed/refunded local status checks run, signature validation runs, the provider payment is fetched, and existing fetched order/amount/currency validation runs before the awaited terminal guard. Preserve this exact ordering.
4. Only successful guard return reaches markPaymentAsPaid. That operation still updates by _id, stores paid/provider references/time and returns the row; it gains no capture ledger, CAS, transaction or history through this one-line fix.
5. After verifyAndMarkPaid resolves, existing processing may handle wallet_recharge (including its existing pharmacy-wallet subtype), booking, external_booking/lab or pharmacy_order. Client module can still influence external dispatch as previously recorded. The shared rejection protects every existing context reaching this fetched guard; it is not new corporate/HR/hospital functionality and does not certify their other paths.

Error and effect limits are deliberate. Initial logs, scoped reads and the one existing provider fetch can already have happened. Existing signature failure writes local failed; fetched failed/refunded branches update their respective local labels and throw. Do not advertise zero total I/O, zero reads, zero logs, zero fetches or zero state mutation for every denied request. For an otherwise valid, noncached request with fetched authorized/created/unknown status, the new guard itself performs no write and its rejection prevents that attempt's subsequent normal paid/processing/fulfillment effects. Actual counters still require focused runtime evidence.

## Status and compatibility table

| Input after preceding checks, local record not cached paid | Selected behavior |
| --- | --- |
| Fetched status captured | Guard returns normally; unchanged markPaid/context processing may proceed. Existing order/amount/currency/signature/requester checks must have passed. No new guarantee about downstream races, idempotency, allocation or clinical readiness. |
| Fetched status authorized | Existing400 PAYMENT_NOT_COMPLETED with message Razorpay payment is not completed. Current status: authorized. No local paid write or normal context processing from this attempt. Do not mark failed, auto-capture, refund, cancel or create a second order. |
| Fetched status created or another unexpected/nonmatching value | Same existing PAYMENT_NOT_COMPLETED branch; exact comparison fails closed. Uppercase/padded Captured variants do not become success. Malformed provider shapes may fail earlier under existing validators; no new shape-normalization/error mapping is promised. |
| Fetched status failed | Entire existing failed update and400 PAYMENT_FAILED remain unchanged, including current processed/reference fields. This is not the zero-write authorized branch. |
| Fetched status refunded | Entire existing refunded update and400 PAYMENT_REFUNDED remain unchanged. A local label is not newly accepted as original-instrument refund proof. |
| Fetched captured but wrong order, amount or currency; invalid signature/requester | Existing earlier failure wins; this amendment does not replace or reorder it. Invalid signature still has its known state-poisoning write, requiring a separate repair. |
| Local row already paid, processed or otherwise obtained through internal/manual writers | Preserve existing control flow. Cached paid bypasses fresh fetch/guard and can still process fulfillment. isProcessed only affects processing after verification, not proof of capture. Internal/direct/manual states are not hardened here. |

Success and error serialization are unchanged: normal success remains the existing controller200 envelope; authorized now uses the existing error handler's {error:400,message,code:'PAYMENT_NOT_COMPLETED'} instead of a false paid/fulfilled success. The message interpolation stays byte-identical. There is no new202, pending-response schema, polling endpoint or automatic retry. Supported-client behavior remains unverified. The design records an old mobile hook that may route verification errors into checkout error/cancel UI; this safety change does not certify that UX or permit a new payment attempt. Backend-independent reconciliation and the deliberate confirming-payment client flow remain open F11 work. Preserve any known external authorization rather than inventing a successful collection or promising recovery that is not implemented.

## Explicit residual gaps

- Previously stored paid/processed/refunded labels, older authorized-as-paid rows and direct/internal/manual payment writers are not reconciled, relabelled or repaired. No migration/backfill or protected provider dashboard/log review is performed.
- Cached paid returns before signature/fetch/status validation; this slice does not claim all verification successes are freshly captured. Manual COD/in-store paid labels and wallet debits remain distinct unproved collection sources under their own contracts.
- markPaymentAsPaid still writes with only _id. Concurrent failed/refunded/paid writers, resource cancellation/deletion, multiple captures and conflicting effects require separate current-state/CAS/idempotency/conservation contracts. A captured observation may become stale; this change establishes no transaction spanning provider evidence and fulfillment.
- Merchant/capture-mode configuration, provider account scoping, retained durable capture facts, provider payment identity/attempt history, missing/caught callback recovery, authenticated webhook/reconciliation, source budgets, refund destinations and exact legacy amount conversions remain open. The fetched projection currently keeps status, order, amount, currency and ID, not the provider's separate captured flag/history; do not claim a newly complete capture-evidence model.
- Existing invalid-signature state poisoning, client-selected module routing, pharmacy requester revalidation and broader money/clinical/stock effects remain independently open. Captured-only gate passage does not approve any downstream dispense, report release, over-credit or refund.

These gaps limit acceptance; they are not reasons to continue accepting authorization as collection. No live deployment, real money/provider action or application/release gate is authorized.

## Focused verification and acceptance

Source verification is data-only: compare exact baseline and candidate, require precisely the unique one-line replacement, preserve the old predicate as the rejected source candidate, and inspect the awaited caller ordering/unchanged terminal branches. Retain compact diff/hash/actual review decisions; do not copy the whole payment service or create text-matching test infrastructure. Two independent nonauthor source/composition decisions are required after implementation. Source-only acceptance is not runtime proof.

All runtime/type/Joi/HTTP/DB/provider checks are NOT_RUN for this draft. The required later matrix uses exact admitted source/import closure and owned recording/provider/DB ports under C3; no live Razorpay request is permitted by this contract:

| Focused case | Required later observation |
| --- | --- |
| Matching captured, otherwise valid new created record | Existing signature/fetch/order/amount/currency checks run in order; exactly the permitted paid write and expected context dispatch. Exercise booking, external lab, wallet-recharge and pharmacy-order contexts separately without claiming their whole workflows accepted. |
| Matching authorized in each context | Existing400 PAYMENT_NOT_COMPLETED; original local created fields unchanged absent concurrent fixture action; zero markPaid, processed/coupon/wallet/order/booking/stock/notification/meeting/fulfillment calls after the guard. Initial read/log/fetch counters remain honestly recorded. In particular no external fulfillment-failure/refund handler is entered. |
| Matching created, unknown, missing/nonstring/nonexact status | Guard denies any noncaptured value that reaches it; prior shape/error behavior distinguished from guard rejection. No ordinary paid/processing continuation from that failed attempt. |
| Failed/refunded provider status | Exact old status/reference/processed write and existing error remain; prove those branches were not removed, reordered or falsely counted zero-effect. |
| Captured but wrong order/amount/currency or invalid signature/requester | Earlier existing denial wins; actual signature-failure write is measured, not represented as zero mutation. No normal fulfillment from the denied verification. |
| Existing local paid/processed; internal/manual writer controls | Record unchanged shortcuts and existing behavior explicitly as outside the new invariant. They must not be used as captured-positive proof. |
| Focused changed-defect controls | Reintroduce authorized into accepted states, drop/reorder the awaited guard or allow ordinary processing after its rejection; relevant behavioral checks must fail for the intended reason. Mutated-source/hash rejection alone is not behavioral evidence. |
| Concurrent existing state writer | Own fixture changes state after read/before markPaid; document the retained race rather than assert this predicate repairs it. Full race/replay/crash and money-conservation acceptance belongs to subsequent contracts. |

Any execution requires a separately frozen bounded launcher, complete pre-import environment/file/network/provider admission and current owned resources. Existing pure438/nine, historical smoke/source reviews and R6 model review do not admit PaymentService construction or its transitive imports. No root build/compiler/start/SDK package installation is authorized. C2, full C3, supported-client, financial/security/clinical, module/M0 and deployment/release gates remain open. Final cross-module integration stays DEFERRED_BY_OWNER.

## Primary provider references and exact source pins

The delegated policy already records Root's primary-source check. Razorpay's payment fetch schema distinguishes authorized/captured and exposes payment order, amount and currency; its integration guidance requires capture before delivery. This draft relies on those retained facts without a new provider/network call. [Fetch payment by ID](https://razorpay.com/docs/api/payments/fetch-with-id/), [capture/delivery integration guidance](https://razorpay.com/docs/server-integration/python/test-app/). SYSTEM_DESIGN section9.2 links the separate [capture settings](https://razorpay.com/docs/payments/payments/capture-settings/); actual merchant settings remain uninspected.

| Selected source/design input | SHA-256 |
| --- | --- |
| documentation/planning/SYSTEM_DESIGN.md | cbd899f6fb442b13db28c389143b529b90da364165dc17291cc829814810bc84 |
| documentation/planning/implementation/PHARMACY_DELEGATED_POLICY_DECISIONS.md | 3882d1dc976342376ed6729fc877fa80e15b79f225a37b10933c1d3681333f6f |
| documentation/planning/implementation/PHARMACY_AUTHORITY_RECOVERY_BASELINE.md | fffc6ccc2e463febc34d1802addf212f96e856993cff961ffb8ad6606e9ed2d7 |
| src1/modules/payment/services/index.ts | 6d56575a3dee2d08d1af5c6cc409e170b8ed5c193ccbc090f336f313b5e93b16 |
| src1/modules/payment/controller/index.ts | 07f4f2e750e1a11c5357cf8f01b813ff535ebadd5204bb7abbe97c7f4731ddeb |
| src1/modules/payment/routes/index.ts | 909ccc033d95467e9029a7fad6b523849ae4f29aa4c799cdf12ac2eedebeedd3 |
| src1/modules/payment/types/index.ts | 6f150e89fe0e7f6fa80188c88621cdfc9254f33b6edcded9c5a70f7c577beff8 |
| src1/modules/payment/validation/index.ts | fb0a7d46057efbcba85cf4c6aa59e8dc819a7888ebc717de03a1a84af8c1cdb0 |
| src1/modules/payment/model/index.ts | 0824a3efc2f3056ca4817e16359881769bf4728563b2eb2bed0fb04dbc3ec1fb |
| src1/modules/middleware/errorHandler.ts | 1e06885f2c5b8df8ed186dba28cd975aaf4f4d5233a2daa277e6b7f7b15fad51 |
| src1/routes/index.ts | 50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056 |

Pins describe selected static provenance, not a complete execution closure. No TypeScript/Node/compiler/application/DB/provider/model/probe execution, source edit, package/network call or Git mutation occurred while authoring this one document. Corporate/HR/hospital expansion remains deferred; existing shared payment protection is retained.
