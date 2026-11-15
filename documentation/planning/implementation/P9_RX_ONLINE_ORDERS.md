# P9 — Prescription medicines online, one-button pharmacist approval (design, 2026-11-15)

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
