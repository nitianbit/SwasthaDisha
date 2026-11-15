# P9 — Prescription medicines online, one-button pharmacist approval (2026-11-15)

## Owner decisions (15 Nov 2026, asked directly)

- Customers may order prescription (Rx) medicines online. **Uploading a prescription is optional** (the owner chose this
  after being told that Schedule H/H1 medicines legally need a valid prescription).
- One order; the pharmacist opens it and **approves with one button**; each approval records which pharmacist approved
  and whether a prescription was attached.
- The customer **pays at checkout**. If the pharmacist rejects (or the order is cancelled) the customer is refunded and
  chooses wallet or original card/UPI.

These supersede, for online customer orders, the stricter conditions recorded in
`PHARMACY_DELEGATED_POLICY_DECISIONS.md` (individual verified pharmacist; attachment-bound approval; card/UPI by default)
and the closure in `PRESCRIPTION_CHECKOUT_ENABLEMENT_DECISION.md` (701e59c). The money conditions that closure set are
met by P1 (qualified review command), P2 (refund on rejection), D3 (paid cancellation) and P8 (payment admission
fences).

## Design

1. **Commerce gate.** `assertPrescriptionCommerceAvailable` is replaced by a validation (items array, boolean
   `prescriptionRequired` per line, URL list shape). Rx lines are allowed at create (cart checkout, staff create),
   update, payment set-up and mark-paid. The order's `prescriptionStatus` is decided at creation from the catalogue's
   flags read at pricing: any Rx line → `pending` (with or without documents); none → `not_required`.
2. **Before approval** (existing P1 gates kept): packed / ready / out-for-delivery / completed are refused while
   `pending`; counter/COD `mark-paid` is refused until approved; paid orders are rejected only through the review (or
   the D3 cancellation request), never the generic status change (already refused for paid orders).
3. **Pharmacist on file.** The pharmacy profile gains `pharmacist {name, registrationNumber, updatedAt}`, set by the
   pharmacy (`PUT /pharmacies/me/pharmacist`, registration pattern as P1). Review: `pharmacistName` /
   `pharmacistRegistrationNumber` become optional; when absent they come from the profile (409
   `PHARMACIST_PROFILE_REQUIRED` if none). The review record adds `prescriptionAttached` (and keeps the document hash and
   count). `reviewedPrescriptionUrls` must still equal the order's current URLs (approve exactly what is on screen).
   **Approve with no documents is allowed** (owner decision); the record says so.
4. **Prescription files.** Cart checkout binds the customer's uploaded files to the order (D1 `withFiles` with the
   order id; keyed replay `rebindStored`), so the order's pharmacy can open them. Only the customer's own uploads
   (`checkAttachable`).
5. **Refunds.** Unchanged P2 path: rejection of a paid order credits the wallet in the same transaction; the customer
   may move it to card/UPI (`to-source`). The apps show both outcomes as a choice.

## Known limits (recorded)

- The pharmacist is the pharmacy's stated pharmacist on a shared business login, not an individually verified person.
- Catalogue flags are read at pricing; a medicine that becomes Rx after an order was placed does not make that order
  need review.
- A capture that lands after a rejection is returned to the wallet only (no card/UPI choice) - pre-existing.

## Changes after Codex design review (msg_1794732249003)

1. **Review bound to the reviewed version.** Orders carry `revision` (every edit `$inc`s it). A review's
   compare-and-set includes the revision it read (and records `reviewedRevision`), so an edit between opening and
   deciding fails the decision (`ORDER_STATE_CHANGED`). After a review, item and prescription-document edits are refused
   (`PRESCRIPTION_REVIEWED_LOCKED`), also at write time (`prescriptionStatus ∈ {not_required, pending}` in the edit's
   filter), so an edit validated before the review cannot land after it.
2. **Counter / COD payment.** `markPaid` refuses an order with any Rx line or a non-`not_required` prescription status
   unless approved (`PRESCRIPTION_REVIEW_REQUIRED`), and its write filter requires `prescriptionStatus: 'approved'` and an
   approved review.
3. **File binding on every recovery path.** Cart checkout binds through `withFiles` (saved id from `{order}`); a keyed
   replay, the used-key receipt (`/request-keys/abandon` → `used`) and `retry-payment` all `rebindStored` for the
   customer (uploader fence: only their own uploads). Staff create uses the same `{order}` id selector. Refill orders do
   not copy prescriptions.
4. **Refills stay non-Rx.** The guard runs with `rx: 'forbid'` for refill creation and for stored refill orders, so a paid
   refill never consumes its cycle on an Rx order that a pharmacist could reject.
5. **Guard.** All non-Rx admission checks are kept (identity, unique ids, active non-archived catalogue, active lines,
   boolean flags); an order with an Rx line can never be `not_required`.

## Tests

`test/pharmacy-prescription/p9-rx-online.integration.ts` (10): Rx order without a prescription → pending, payment set up
(non-Rx stays not_required); packing gated; one-button approval needs the pharmacist on file and records name /
number / no document / revision; stale approval after an edit refused; post-review document/item edits refused, also a
pre-review read committing after the review; counter payment only after approval, write-time fence; prescription file
bound (pharmacy can open, stranger cannot), re-bound after loss, someone else's upload refused; paid Rx rejection →
refund intent (P2). P1 test updated for the two intended changes (mark-paid code; approval without documents).

## Changes after the implementation review (msg_1794733163372)

- The decision carries `expectedRevision` (required, whole number ≥ 0): the revision the pharmacist was shown. It must
  equal the current revision and is the revision the compare-and-set requires and the review records.
- Counter / COD mark-paid fences the checked revision in both branches, plus the prescription classification
  (approved when review is needed, unchanged otherwise): an order changed to Rx meanwhile cannot be marked paid.
- Edits of refill orders validate with `rx: 'forbid'` (items and documents), so a refill never becomes Rx.
