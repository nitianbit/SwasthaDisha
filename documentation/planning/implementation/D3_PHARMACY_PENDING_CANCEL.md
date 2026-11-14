# D3 — Paid pharmacy order cancel → `pending_cancel` (owner decision 3, 2026-11-14)

Status: design for Codex review (incorporates Codex design notes msg_1794658919870, D3 section). Branch
`m0/d3-pharmacy-pending-cancel` on `m0/d2-booking-payment-timeout` (independent of D1).

## Owner decisions

- Cancelling a **paid** order does not cancel it at once: the order becomes `pending_cancel` and waits for approval.
- Approver: a platform admin **or** the order's pharmacy ("both can approve"). Until staff/owner roles exist, the same
  pharmacy account may request and approve; both steps are recorded.
- Refund "as per user request", like P2: wallet first; card/UPI only when the customer asks.

## State

`status: 'pending_cancel'` (new enum value) plus an embedded record:

```
cancelRequest: { state: 'pending' | 'approved' | 'rejected', fromStatus, paymentStatusAtRequest,
                 requestedByType: 'user' | 'pharmacy' | 'admin', requestedById, reason, requestedAt,
                 decidedByType?, decidedById?, decidedAt?, decisionNote? }
```

Making the request a **status** is the fence: every writer that compare-and-sets on the exact status it read (status
transitions, P1 review, P7b delivery exceptions, P3b stock-hold cancel and batch swap, customer returns, refill commit,
timeout sweep) already fails on a frozen order. The writers that do not are fixed below.

## Commands

| Command | Who | Atomic filter (one write, in a transaction with stock release where noted) | Effect |
|---|---|---|---|
| `POST /pharmacy-orders/:id/cancel-request` `{reason}` | the order's customer, the order's pharmacy, admin | **Unpaid**: `{_id, status ∈ placed/accepted/packed, paymentStatus ∈ pending/failed}` | `cancelled` at once, stock released in the same transaction (no money) |
| | | **Paid**: `{_id, status ∈ placed/accepted/packed, paymentStatus ∈ paid/authorized/partially_paid, cancelRequest.state ≠ pending}` | `pending_cancel`, `cancelRequest` pending with `fromStatus` |
| `POST /:id/cancel-request/approve` `{note?}` | admin, the order's pharmacy | `{_id, status: pending_cancel, cancelRequest.state: pending, paymentStatus: <read>}`; `paymentStatus: authorized` → 409 `PAYMENT_IN_PROGRESS` (capture not settled yet; try again) | in one transaction: `cancelled`, request approved, items re-read inside the transaction and released exactly once (the status CAS is the once-only fence), P2 refund intent built (cause `order_cancelled`) when paid and none exists. After commit: wallet credit (`settleAfterRejection`, never throws; the reconciler recovers it) |
| `POST /:id/cancel-request/reject` `{note}` | admin, the order's pharmacy | `{_id, status: pending_cancel, cancelRequest.state: pending}` | back to `fromStatus` (placed → accepted if it became paid meanwhile), request rejected |

Unpaid vs paid is decided by the filter, not by an earlier read: a COD order that becomes paid between read and write
fails the unpaid filter and the request is retried as paid (one retry, then 409).

Approval authority = rejection authority = `requireAdminOrOperationalPharmacy` + own-pharmacy check, as for P2 retry.

## Money

- Refund via P2 (`PrescriptionRefundService`): new cause `order_cancelled`; wallet first (`pharmacy_order_refund:<id>`,
  deduplicated with any earlier refund); card/UPI on the customer's request (existing `prescription-refund/to-source`).
- No matching paid PaymentRecord (COD / in-store `markPaid`) → the refund record is `manual_review` and shown on the
  existing admin attention queue; the UI says "refund to be arranged", never "credited".
- A capture that lands while the order is `pending_cancel` is **recorded** (paymentStatus paid) but does not move the
  order: approval then refunds it; rejection resumes the order (placed → accepted).
- A capture on a cancelled order keeps the existing late-payment wallet refund, without overwriting the status.

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

Unpaid immediate cancel + exactly-once stock release; COD becomes paid during the cancel → pending path; paid request
→ every progress writer refused (status, P1 review, P7b, stock-hold, batch swap, markPaid, update) while pending;
approve → cancelled, stock released once, wallet credited once (concurrent double approve: one wins); approve while
authorized → 409; capture landing during pending → recorded, order not progressed, then refunded on approve; reject →
fromStatus restored (placed + paid → accepted); COD paid → approve → manual_review; generic cancel on a paid order →
409; late payment on a cancelled order → wallet refund, status unchanged; customer of another order / other pharmacy →
403/404.

## Frontend (after backend approval)

Workspace: "Cancellation requests" queue + approve/reject on the order screen (re-enables Cancel for paid orders through
the request). Customer app: request cancellation on an order, with the refund state.
