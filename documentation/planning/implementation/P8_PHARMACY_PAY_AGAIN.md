# P8 — Pay again and once-only checkout for customer pharmacy orders (2026-11-15)

Owner decision (15 Nov): build "pay again" and duplicate-order protection for medicine orders first.

## Pay again — `POST /api/v1/pharmacy-orders/:id/retry-payment` (customer, own online order)

1. Every unsettled Razorpay attempt of the order is checked with the gateway (`reconcilePharmacyOrderPayments`, as for
   bookings): a capture whose confirmation was lost is applied now (the answer is then `paymentRequired: false`), or
   returned to the wallet if the order is closed. If any attempt cannot be checked: 503 `PAYMENT_STATE_UNKNOWN`, no
   payment offered.
2. Refusals: 403 not a customer; 404 not theirs; 409 `PAYMENT_NOT_ONLINE` (counter/COD), `ORDER_NOT_PAYABLE` (not
   `placed`+`pending`), `ORDER_PAYMENT_EXPIRED` (the 30-minute window after which captures are returned).
3. The answer reuses **the order's own open Razorpay order** (`resumablePharmacyPayment`: linked record `created`,
   context/order match, amount = grand total in paise). **Never a second Razorpay order**: late-capture refunds are keyed
   per order (`pharmacy_order_refund:<orderId>`), so a second captured order could have its refund dropped; one order
   captures at most once. If it is not reusable: 409 `PAYMENT_NOT_RESUMABLE` ("cancel and place a new order").
4. An order whose original request died after the order committed but before its payment was linked has its payment
   set up once (linked only while none is linked; a loser's record is never exposed).

## Once-only checkout — `requestKey` on `POST /api/v1/pharmacy-cart/checkout` (customers)

- Optional `requestKey` (`[A-Za-z0-9_-]{8,64}`). A key that already produced an order answers with that order
  (`replayed: true`, payable again if still unpaid) before the cart is read (the cart is gone after checkout).
- The key is claimed in the order's own transaction (D4 `request_keys`, kind `pharmacy_checkout`, scope = customer), and
  `pharmacyorders` has a unique partial index `{customerId, checkoutRequestKey}`: two concurrent requests make one order;
  the loser answers with the winner's order. An abandoned key (`POST /request-keys/abandon {kind:'pharmacy_checkout'}`)
  can never place an order (409 `REQUEST_ABANDONED`); abandoning a used key answers `used` with the order.
- Pharmacies (B2B cart) cannot send a key (400 `REQUEST_KEY_UNSUPPORTED`).

## Known, not changed (recorded follow-up)

- Late-capture refunds are deduplicated per order, not per payment record. Today a second record per order only arises
  from a lost link race (never exposed) or a refill resume (`resumeRefillOrder`); P8 adds none. If two different records
  of one order were ever captured and both had to be returned, the second would not be credited. Fix with per-record
  refund keys in a separate money packet.

## Tests

`test/pharmacy-payments/p8-pay-again.integration.ts` (11): key validation; repeated key → same order and same Razorpay
order, no second record; concurrent same key → one order; abandoned key refused; pharmacy refused; used key cannot be
abandoned; pay again reuses the open order (no new Razorpay order); lost capture applied by pay again; gateway down →
503; window/closed/offline/foreign/pharmacy refusals; interrupted setup set up once under concurrency (and named by the
replay); replay of a paid order offers no payment.
