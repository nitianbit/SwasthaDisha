# Customer milestone API notes

These describe the local implementation candidate, not a deployed API or client acceptance. Authentication mounts are unchanged. Signup/login and the address implementation are reused; further login work was explicitly deferred by the owner. BetaCura/hybrid and broader identity work remain deferred.

## Profile

`PUT /api/v1/users/:id` requires the signed customer to own that ID, or an admitted admin. HR retains its existing corporate scope but cannot add/replace personal phone or email.

- Normal validated profile fields can change. Raw self-supplied privilege fields still fail.
- An already stored personal phone/email is ignored in a customer update before validating that discarded contact. Other valid fields in the request still save.
- A missing contact (absent, null or empty string) can be filled after validation and observed availability checks. A simultaneous fill returns `409 CONTACT_ALREADY_SET` instead of overwriting the winner. Only an admin replaces an existing personal contact.
- A contact-only request containing ignored replacements returns the unchanged profile. An admitted new/replaced personal email is not considered verified merely because it was supplied.
- Personal email-verification send/verify cannot replace an existing email. A differing destination returns `422 EMAIL_CHANGE_ADMIN_ONLY`; a concurrent stored-contact change during verification returns `409 CONTACT_CHANGED`, requiring a fresh challenge. Same-email verification and first verification of a missing email remain supported.

Example: submitting `{ "name": "Ravi Kumar", "phone": "8888888888" }` when the stored phone is `9999999999` saves the name and retains `9999999999`.

Phone/email uniqueness prechecks do not provide cross-account concurrency guarantees under the current nonunique indexes. No index/backfill/session migration is included.

## Existing ordinary bookings

Existing paths remain under `/api/v1/bookings`. Three create handlers derive customer identity and corporate association from the signed principal. A supplied individual dependent must belong to that customer and be active before booking effects. Customer list filters remain combined with owner scoping; generic customer updates remain notes-only.

New ordinary bookings record their local reservation/payment effects privately. Those fields are not a client contract and are excluded from returned booking DTOs.

- `POST /:id/cancel` performs the local settlement and retains booking history. No-money cancellations are not labeled refunded. Positive refunds go to the **internal wallet**, not the original payment instrument.
- `GET /:id/payment-details` reports `refund.destination` as `internal_wallet` for a positive completed wallet refund, otherwise null. A created/unpaid gateway order remains a pending payable amount and is not counted as actually paid. The historical charged summary includes all bounded matching captured/refunded payment attempts, including late/duplicate captures; the singular current-payment DTO remains available. Inconsistent owner/reference/currency/units/history returns a reconciliation conflict. These sequential repository reads are not a native snapshot guarantee.
- Paid cancellation uses the legacy IST cutoff: 24 hours before the appointment, or 48 hours for Monday appointments. An unpaid cancellation does not depend on a future appointment time. Admins retain the legacy rule rejecting appointments that have already started.
- Active setup can return `409 BOOKING_SETUP_IN_PROGRESS`; retry later. Failed/expired setup can be recovered without reusing a stale setup token. Repeated cancellation can retry postcommit reminder/meeting cleanup and recover subsequently recorded captures without repeating completed local effects.
- `POST /:id/reschedule` moves the recorded slot hold atomically. Changing time/date while retaining the same slot must still match that slot.
- `DELETE /:id` now returns `409 BOOKING_RETENTION_REQUIRED`; use cancellation. Generic administrative writes cannot bypass dedicated cancellation/payment/reschedule commands.
- Ambiguous historical records without trustworthy local-effect/funding provenance return `409 BOOKING_RECONCILIATION_REQUIRED`. No automatic historical migration or guessed refund is supplied.

## Existing external bookings

Existing LabStack and Healthians flows are retained. Omitted integration filters now include both providers. `GET /api/v1/external-bookings/bookings/:id` returns an owned, sanitized local detail; foreign customers receive 404. Existing diagnostics history/progress stays owner-scoped.

Payment setup and local wallet settlement use recorded private effects. A provider attempt is recorded before the provider call. A timeout or missing response is an **unknown outcome**, not evidence that no booking exists: payment remains paid/pending confirmation, automatic duplicate creation is refused, and cancellation can return `409 EXTERNAL_CANCELLATION_PENDING`. Known provider bookings require explicit cancellation acknowledgement before local refund settlement. Empty responses and an adapter's default `cancelled` label do not prove acknowledgement. Positive refunds go to the internal wallet.

The existing public callback has no proven provider-authentication contract. It now records an untrusted observation only: it cannot change authoritative booking/payment state, refund money or release reports. Consequently, authenticated automatic provider status/report propagation and operational recovery of unknown outcomes remain **unfinished**. A recorded reconciliation flag is not a working reconciliation operation. Historical bookings without trustworthy private effects also require reconciliation.

## Shared wallet writers

The existing manual/referral transaction writer and customer recharge writer now commit the observed balance change and matching ledger together, so their stale read/modify/write cannot overwrite a newer booking refund. Customer recharge repeats verify a payment-bound credit marker and matching ledger, including when `isProcessed` is already true; ambiguous legacy credits return a reconciliation conflict. Manual commands remain one effect per explicit invocation; no general request replay guarantee is added. Global coupon counters, refund funding budgets and all historical ledger balances are not certified by this change.

## Verification boundary

Focused evidence uses whole selected modules in closed recording-port fixtures. This exercises source behavior and simulated failures, not a real HTTP client, Mongoose transaction, database race, provider, session cutover or production environment. Current source-specific records and remaining checks are listed in the milestone review prompt and outcome report.
