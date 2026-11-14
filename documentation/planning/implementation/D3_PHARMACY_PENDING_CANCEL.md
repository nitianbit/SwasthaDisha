# D3 — Paid pharmacy order cancel → `pending_cancel` (owner decision 3, 2026-11-14)

Status: design, revised after Codex review msg_1794669027648 (lost capture recovery; exact snapshot predicates;
decisions fenced to one request). Incorporates Codex design notes msg_1794658919870 (D3 section). Branch
`m0/d3-pharmacy-pending-cancel` on `m0/d2-booking-payment-timeout` (independent of D1).

## Owner decisions

- Cancelling a **paid** order does not cancel it at once: the order becomes `pending_cancel` and waits for approval.
- Approver: a platform admin **or** the order's pharmacy ("both can approve"). Until staff/owner roles exist, the same
  pharmacy account may request and approve; both steps are recorded.
- Refund "as per user request", like P2: wallet first; card/UPI only when the customer asks.

## State

`status: 'pending_cancel'` (new enum value) plus an embedded record:

```
cancelRequest: { requestId (new ObjectId per request, immutable), state: 'pending' | 'approved' | 'rejected',
                 fromStatus, paymentStatusAtRequest,
                 requestedByType: 'user' | 'pharmacy' | 'admin', requestedById, reason, requestedAt,
                 decidedByType?, decidedById?, decidedAt?, decisionNote? }
```

Making the request a **status** is the fence: every writer that compare-and-sets on the exact status it read (status
transitions, P1 review, P7b delivery exceptions, P3b stock-hold cancel and batch swap, customer returns, refill commit,
timeout sweep) already fails on a frozen order. The writers that do not are fixed below.

## Commands

| Command | Who | Atomic filter (one write, in a transaction with stock release where noted) | Effect |
|---|---|---|---|
| `POST /pharmacy-orders/:id/cancel-request` `{reason}` | the order's customer, the order's pharmacy, admin | read `s` = status, `p` = paymentStatus; **exact** CAS `{_id, status: s, paymentStatus: p}` with `s ∈ placed/accepted/packed`. Unpaid (`p ∈ pending/failed`) | `cancelled` at once, stock released in the same transaction (no money) |
| | | same exact CAS, paid (`p ∈ paid/authorized/partially_paid`) | `pending_cancel`, new `cancelRequest` {requestId, state pending, fromStatus: s, paymentStatusAtRequest: p} — stored values are exactly the matched ones |
| `POST /:id/cancel-request/approve` `{requestId, note?}` | admin, the order's pharmacy | in a transaction: fresh read, then CAS `{_id, status: pending_cancel, cancelRequest.requestId: <body>, cancelRequest.state: pending, paymentStatus: <fresh>}`; `paymentStatus: authorized` → 409 `PAYMENT_IN_PROGRESS` | `cancelled`, request approved, items released exactly once (the status CAS is the once-only fence), P2 refund intent (cause `order_cancelled`) when paid and none exists. After commit: wallet credit (`settleAfterRejection`, never throws; reconciler recovers it) |
| `POST /:id/cancel-request/reject` `{requestId, note}` | admin, the order's pharmacy | same transaction pattern: fresh read; CAS `{…, requestId, state pending, paymentStatus: <fresh>}` | restored status computed from the fresh read: `fromStatus`, except `placed` + now paid → `accepted`; request rejected |

The exact CAS is retried after a re-read (3 tries, then 409 `ORDER_CHANGED`), so a concurrent progress (accepted →
packed) is never stored as a stale `fromStatus`, and a COD order that becomes paid in between is re-classified as paid.
Every decision names the `requestId` the decider reviewed: a delayed decision prepared for an earlier request R1 cannot
decide a later R2 (409 `CANCEL_REQUEST_CHANGED`). The order screen and the queue always show the current requestId.
Decisions use a transaction (fresh read + write-conflict retry), so the restored status and payment predicate come from
the same snapshot as the write.

Approval authority = rejection authority = `requireAdminOrOperationalPharmacy` + own-pharmacy check, as for P2 retry.

## Money

- Refund via P2 (`PrescriptionRefundService`): new cause `order_cancelled`; wallet first (`pharmacy_order_refund:<id>`,
  deduplicated with any earlier refund); card/UPI on the customer's request (existing `prescription-refund/to-source`).
- No matching paid PaymentRecord (COD / in-store `markPaid`) → the refund record is `manual_review` and shown on the
  existing admin attention queue; the UI says "refund to be arranged", never "credited".
- A capture that lands while the order is `pending_cancel` is **recorded** (paymentStatus paid) but does not move the
  order: approval then refunds it; rejection resumes the order (placed → accepted).
- A capture on a cancelled order keeps the existing late-payment wallet refund, without overwriting the status.
- **A losing payment commit is routed, never dropped** (Codex HIGH): when the gateway commit's CAS fails, the handler
  re-reads the order and routes its actual state: open → retry the commit; `pending_cancel` → record paid, stay frozen;
  cancelled/rejected/abandoned → late-payment wallet refund (idempotent key `pharmacy_order_refund:<id>`), PaymentRecord
  marked processed. It no longer ends in a 500 with a paid, unprocessed record.
- **Durable recovery of pharmacy payments**: the 5-minute payment recovery sweep (W3b, bookings only today) also covers
  `context: 'pharmacy_order'` records that are captured but unprocessed (or still `created` with a possible capture):
  reconcile with Razorpay, then the same routed processing. A lost browser/webhook continuation cannot strand money.
- **Refill orders (P7)**: the subscription cursor (`advanceRefillOnPayment`) is a payment effect, not an order-status CAS.
  A capture on a refill order in `pending_cancel` is recorded but does not advance the cursor; a rejection advances it
  in the rejection transaction; an approval does not (the cycle is refunded). Otherwise P7's policy is unchanged.

## Writers that must be fixed (from the writer inventory)

| Writer | Today | Change |
|---|---|---|
| Generic `POST /:id/cancel`, `POST /:id/status` cancelled/rejected/abandoned (`updateStatus`) | no payment fence, no refund | add `paymentStatus ∈ pending/failed` to the CAS; a paid order → 409 `ORDER_PAID_USE_CANCEL_REQUEST` |
| Gateway payment commit (`payment/services:1135`) | status blocklist; writes `status` from a stale read | filter `status ∈ placed/accepted/…/pending_cancel` explicitly; `$set paymentStatus: paid` only; placed → accepted by a separate CAS on `status: placed`; never writes another status |
| Late-payment handler (`payment/services:236, 273`) | `{_id}` only: overwrites status to abandoned, may release stock twice | status write only `{_id, status: placed}` → abandoned (with stock release in that CAS's transaction); refund write `{_id, paymentStatus ∉ refunded}`; never touches `pending_cancel`/terminal statuses |
| Zero-total create (`pharmacyOrders/services:730`) | `{_id}` only | `{_id, status: placed, paymentStatus: pending}` |
| `markPaid` | allowed on any non-terminal status | `pending_cancel` refused (409); the request is decided first |
| Item/field edit `update()` (`:1114`) | no status in the filter | `status: <read in transaction>` and not `pending_cancel` |

## Tests (planned, integration on the replica set)

Accepted/pending online order: unpaid cancel commits between the payment handler's final read and its commit → routed to
wallet refund, record processed, no 500; the same with the browser continuation lost → the recovery sweep refunds it
without a customer retry. Request reads accepted, order packed meanwhile → CAS retries, fromStatus packed. Reject R1 →
progress → request R2 → delayed R1 approve/reject → 409, R2 untouched. Capture during pending on a placed order, then a
stale reject → accepted (fresh read). Unpaid immediate cancel + exactly-once stock release; COD becomes paid during the cancel → pending path; paid request
→ every progress writer refused (status, P1 review, P7b, stock-hold, batch swap, markPaid, update) while pending;
approve → cancelled, stock released once, wallet credited once (concurrent double approve: one wins); approve while
authorized → 409; capture landing during pending → recorded, order not progressed, then refunded on approve; reject →
fromStatus restored (placed + paid → accepted); COD paid → approve → manual_review; generic cancel on a paid order →
409; late payment on a cancelled order → wallet refund, status unchanged; customer of another order / other pharmacy →
403/404.

## Frontend (after backend approval)

Workspace: "Cancellation requests" queue + approve/reject on the order screen (re-enables Cancel for paid orders through
the request). Customer app: request cancellation on an order, with the refund state.
