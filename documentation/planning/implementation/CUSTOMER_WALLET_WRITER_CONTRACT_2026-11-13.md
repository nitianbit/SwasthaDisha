# Customer wallet writers — cancellation composition

13 November 2026. This is the narrow correction authorized by Root after two existing read/modify/write paths were found able to overwrite a newly committed booking refund. The customer's milestone is resumed; this does not admit an application, provider, database or root build/start operation.

## Scope and interface

Worker `/root/reviewer` owns `wallet/services/localOperations.ts`, the financial body of `WalletService.addTransaction`, the new-payment normalization boundary of `WalletService.initiateRecharge`, and `PaymentService.ensureWalletRechargeTransaction`. Other agents own profile and external-booking source. Their edits must be retained.

- `WalletLocalOperations.addTransaction(data)` returns the existing wallet-transaction shape. One explicit command commits its balance adjustment and ledger record in one same-connection transaction. Notifications remain after commit. This adds no general replay key or referral-reward idempotency claim.
- `WalletLocalOperations.creditRecharge(paymentId)` rereads the exact captured customer recharge. Require paid Razorpay, INR, bound scalar owner/payer/context/ID, nonempty gateway references and consistent safe integer base/discount/final paise. Preserve the existing policy of crediting base amount after the valid discounted payment.
- Recharge credit, exact observed-balance CAS, ledger and `notes.walletRechargeCreditV1` proof commit together. The proof binds version, ledger ID, wallet ID and amount. Repeated calls validate that proof and its completed owned credit ledger without crediting again. A historical ledger or processed payment without this proof is reconciliation-required; do not infer that the old balance write succeeded.
- All balance calculations reuse the existing `bookingMoneyPaise` export. Convert valid existing major units to safe integer paise, compute the resulting balance in paise, and atomically CAS the observed balance to `afterPaise / 100`. Nonfinite, negative, unsafe or unsupported stored amounts fail.
- For a newly calculated server coupon only, validate the requested base amount, round the server discount once to paise using the existing gateway convention, and derive final amount by subtraction. Never independently round inconsistent stored funding.
- A missing wallet can be created inside the transaction under the existing unique-user schema contract. Native proof that this unique index exists remains required; schema declarations do not supply it.

## Review and evidence boundaries

Actual independent preimplementation decisions were received directly from Root (Standards) and `/root/booking_owner` (Spec), including the recharge coupon normalization addendum. These are implementation-contract votes only. Source and exact focused invocation/outcome reviews are separate.

Focused checks must cover complete changed source under closed recording model/session ports: credit/debit and insufficient funds, exact paise, ledger failure rollback, recharge repetition and proof corruption, legacy ambiguity, owner/context/currency/unit failures, and serial interleavings with a booking refund. A recording adapter cannot prove native transaction conflict handling, indexes, HTTP/provider behaviour or real concurrent consistency.

Pharmacy atomic increments, root dependencies/runtime/start, authorization roles, index/backfill migration, broad wallet/referral replay policy and the existing general coupon finalization design are unchanged by this correction. Full financial-budget/coupon conservation and production release are not claimed.
