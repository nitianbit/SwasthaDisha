# Packet: booking payment-retry integrity (split from P2, 13 Nov 2026)

Owner decision: these issues already existed before P2 and are fixed in their own packet. P2 keeps the atomic wallet ledger (`WalletRepository.postEntry` / `debitUpTo`) and one-time credit keys. It also keeps the funding-slot key on booking wallet debits (`booking_wallet:<id>:<link at retry start>`), so atomic debits never take more than the old absolute writes did when two retries of the same step run at once (Codex round 6). Apart from that, booking payment retries behave as they do on the main branch.

Found by Codex reviews of P2 (rounds 3–5); the reproductions are in those messages in the Ruflo `claude-reviewer` mailbox (msg_1794554896906, msg_1794555234314, msg_1794555806176).

## Problems to solve

1. **The same booking can be funded twice.** Two concurrent `retryBookingPayment` / `retryExternalBookingPayment` calls read the same unpaid state, and each debits the wallet for the remaining amount.
2. **A stale retry can overwrite a newer payment link.** The final booking update sets `paymentTransactionId` (and, for bookings, `paymentStatus: 'pending'`) unconditionally. Wallet money recorded only in the replaced payment record then drops out of the cancellation refund, which is computed from the linked record.
3. **Money charged before a payment failure can be lost.** If a retry debits the wallet and `createOrder` then fails, nothing records that debit. A later retry with `useWalletBalance=false`, or with a changed coupon or amount due, never accounts for it.
4. **Retries race completion and cancellation.** A retry can race a payment completing on the old record, or a booking cancellation. It can create a new payment, replace the link, or restore `pending`/`confirmed` over `paid`/`cancelled`, and the competing writers don't coordinate with it.

## Direction explored in P2 (removed there; reuse here)

- A per-booking attempt claim taken *before* any debit or payment record. It requires the expected payment link and the expected payable state (`pending`, not paid/cancelled), and the final link write is fenced by the claim token.
- A funding-slot operation key on wallet debits, so duplicate retries replay one receipt (kept in P2).
- Still to design: durable recording of committed funding before the claim is released; reconciling excess funding when terms change; making cancellation and payment-completion writers honour or clear the claim.

## Done when

Full retry-flow tests for bookings **and** external bookings cover:
- concurrent duplicate retries
- a stale retry after a newer link
- a failure after the debit, followed by a retry with the wallet off
- a changed amount due
- paid/cancelled transitions before the claim and between the claim and the link
- each scenario ending in a cancellation refund that accounts for every rupee taken

Then an independent review.
