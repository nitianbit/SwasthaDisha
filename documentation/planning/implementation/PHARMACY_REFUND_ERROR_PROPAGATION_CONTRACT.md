# Pharmacy refund transaction error propagation — contract

12 November 2026. Baseline df8fd4ef00cb9d45d081ce760d15cef84a880c4e, focus branch m0/customer-pharmacy-lab-focus. Bounded prerequisite to the delegated recovery policy, not implementation of that whole policy. Independent Spec and Standards decisions on these exact bytes precede source edits.

## Defect and selected behavior

PaymentService.refundAbandonedPharmacyOrderToWallet currently suppresses any duplicate-key error from its wallet-credit transaction, then can continue coupon work, return a positive amount and mark payment/order refunded without proving a completed credit. The declared partial uniqueness key also covers pending/failed rows. A duplicate error is not proof of a successful matching financial effect.

Remove only this helper's catch clause that suppresses duplicate errors. Preserve its existing try/finally and awaited session.endSession. Any transaction error, including duplicate-key errors, must reject the helper instead of continuing the normal-success tail. Existing awaited callers must receive the rejection before their subsequent order/payment/stock transition. This is fail-closed containment: a concurrent transaction that really completed can still make the losing request fail; a later ordinary request may use the existing completed-row path. Do not turn the catch into a reconciliation/retry loop in this slice.

A finally/endSession failure can still mask an earlier error under current JavaScript semantics. That diagnostic limitation is unchanged; it must never be represented as successful financial completion.

## Exact scope and bindings

Only production file: src1/modules/payment/services/index.ts, baseline SHA-256 39c29b050dbca15db431f5415ebaa5dec8bbf77c31637ee13112796cf13ab5a0. Inside refundAbandonedPharmacyOrderToWallet, delete exactly the two catch-body lines and catch header by replacing the unique block:

```typescript
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      } finally {
```

with:

```typescript
      } finally {
```

Do not remove isDuplicateKeyError elsewhere: other callers use it. No model, index, route, money calculation, destination, status predicate, coupon logic, existing completed-row return, transaction/session behavior or other helper changes. Verification evidence may record the exact diff, source hashes and two nonauthor decisions; do not duplicate entire controllers or create a text-matching test framework.

## Verification and acceptance

As data only, compare the candidate with the baseline and require exactly that unique replacement. Independently inspect the helper's resulting try/finally and each awaited caller's next effects. Preserve the original as a rejected source candidate. Git whitespace verification applies to source and prose; frozen unified patch context remains byte-exact. No TypeScript evaluation, application/DB/provider imports, root install/build/typecheck/start or operational data access is admitted here.

Focused runtime evidence remains NOT_RUN until exact C3 admission. Required later cases: transaction duplicate with only pending/failed row; unrelated duplicate key; completed concurrent winner; credit/save failure and rollback; endSession failure; existing matching completed row; no caller follow-on order/payment/stock/coupon effect after rejection. Actual installed index and transaction guarantees remain unproved by source inspection.

Acceptance is APPROVE_SOURCE_ONLY after two independent nonauthor source reviews and composition verification. Do not claim a confirmed refund, gateway refund, idempotent recovery, module acceptance or F1 resolution.

## Explicit residual gaps

Existing completed rows may be forged or mismatched and are not newly validated here. Amount/currency/payer/capture proof, original-instrument routing, zero-amount behavior, partial-refund budget, installed uniqueness, durable recovery obligation, wallet/order split commits, coupon retries and legacy reconciliation remain unresolved under the delegated policy. This deletion prevents the error-suppression path from reporting ordinary success; it does not establish complete refund correctness or authorize live effects.
