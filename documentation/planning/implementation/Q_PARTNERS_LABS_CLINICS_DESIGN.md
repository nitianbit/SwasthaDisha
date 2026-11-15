# Q — Partner labs, clinics and doctors: online bookings, instant consultations, in-house sales (design, 2026-11-15)

Status: design revised after Codex re-review #4 (msg_1794740298614_vlo09yy1). Built in packets Q1–Q6 (§10), each reviewed by Codex.

## 1. Owner decisions (15 Nov 2026, asked directly)

| Topic | Decision |
|---|---|
| Partner labs (no API) | We support them besides Healthians/LabStack, with a panel to manage in-lab visits and online bookings made through us |
| Online payment for partner labs | Customers pay **through us**, like Healthians/LabStack bookings |
| Commission | **None for now**; every money record keeps a commission field (0) so it can be added later |
| Who signs in for a partner | **Owner + staff**; the owner manages staff accounts and their **permissions** (incl. who may release reports) |
| Lab menu & prices | **The lab sets them; live at once**; our admins can disable items |
| Lab visit types | **Home collection and/or visit the lab, per test**; slots and capacity per type |
| Payouts | **Ledger + manual payout**: exact balance per partner; admins record each bank transfer; partners see statements |
| Clinics | **Both**: clinics (owner + staff, several doctors) and solo doctor practices; a doctor can belong to a clinic |
| Doctor availability | A doctor **sets slots, and/or turns on "available now"** for instant teleconsultation |
| Customer consultations | Two types: **scheduled** or **instant**. Instant: **pick an online doctor or "any available"**; if nobody accepts in time, **offer another doctor first, refund only if the customer wants** |
| In-house sales (labs, clinics, doctors) | The partner **generates an invoice**; **we do not collect the payment**; the partner picks the payment mode, adds a reference number/keyword and **marks it paid** |
| Invoice | **Line items + GST, the partner's own sequential series, PDF** |
| Walk-in customer | **If a phone number is given, always linked** to a SwasthaDisha account (invoice and lab report visible in the app) |

## 2. What exists and what we reuse

- Doctors already have a portal (`/specialists/me/*`): profile, date-based slots, appointments, status, prescriptions
  (PDF), patient history; Google Meet links are created for paid call/video bookings. Gaps: weekly schedule and
  recurring slots are stored but unused; no leave days; no per-mode slots; **doctor cancellation fails (409)**; no
  no-show; no earnings view; no walk-in billing.
- Labs exist only as API providers (Healthians/LabStack in `externalBookings`). No lab account, catalogue, slots,
  bookings, walk-in sales or payouts. `partners` is a display directory; `organizations` (pharmacy/lab staff authority)
  exists but is not wired.
- Patterns reused from ewa_backend (`integration/perks-v2-combined`) and our pharmacy vertical: admin-provisioned OTP
  partner login; hospital → branch → benefit split; booking legs (home/centre) with `$min` lifecycle timestamps;
  working-hours escalation; immutable, idempotent, checksummed billing documents; disbursal allocation in a
  transaction; pharmacy `in_store` orders with counter payment. Avoided from ewa: tenancy by integration enum (we scope
  by partner id), unconditional slot `$inc` (overbooking), vendors cancelling as "user", unauthenticated webhooks,
  30-day unrevocable tokens, non-sequential invoice numbers.

## 3. Partners, places and people

- **Partner** `{ _id, kind: 'lab' | 'clinic', name, legalName, gstin?, pan?, contact, logo, verification
  {state: pending|verified|suspended, documents[], verifiedAt, verifiedBy}, taxRegime: 'regular'|'composition'|'unregistered'
  (default unregistered, set by admin at verification), invoiceSeries {prefix}, activeOwnerCount, isActive }`.
  A solo doctor's practice is a `clinic` partner owned by that doctor (`solo: true`), created when the doctor first
  enables in-clinic billing.
- **Branch** `{ partnerId, name, address, geo, phone, hours (weekly), holidays[], services: {homeCollection,
  inLab, inClinic} , isActive }` — every booking, slot and invoice belongs to one branch.
- **Member** `{ partnerId, phone (login), name, role: 'owner' | 'staff', permissions[], branchIds[] (empty = all),
  doctorId? (a doctor working at a clinic), professional? {kind: 'pathologist'|'pharmacist'|'doctor',
  registrationNumber}, isActive, invitedBy, createdAt }`. One owner minimum (cannot remove the last owner).
- **Permissions** (owner holds all; the owner grants the rest per member):
  `staff.manage`, `branches.manage`, `catalogue.manage`, `slots.manage`, `bookings.view`, `bookings.manage`
  (confirm/reschedule/collect/no-show/reject), `reports.upload`, `reports.release`, `invoices.create`,
  `invoices.cancel`, `payments.record`, `finance.view`.
- **Delegation ceiling:** only owners may grant/revoke permissions and change roles. A staff member with `staff.manage`
  can invite new staff and toggle their `isActive`, but cannot grant any permission they do not hold, cannot promote
  to owner, cannot expand branch scope beyond their own, and cannot modify another owner. Owner role changes
  (`role: 'owner' ↔ 'staff'`) are owner-only. **Last-active-owner protection:** the Partner document carries an
  `activeOwnerCount` (maintained by `$inc` in the same transaction as any Member role change, activation/deactivation,
  or removal where the target is an owner). Every operation that would reduce `activeOwnerCount` (demote owner to
  staff, deactivate an owner, remove an owner) requires `activeOwnerCount > 1` as a CAS pre-condition on the Partner
  document. This covers concurrent demotion, concurrent deactivation, and mixed demotion + deactivation races.
  Actor/target must share the same `partnerId` (enforced from admitted membership, never from the request).
- **Sign-in:** OTP `userType: 'partner'` (new) for members; doctors keep `specialist` and reach their clinic/practice
  through their Member record. A person in several partners chooses one; the access token carries
  `{memberId, partnerId}` and every request re-admits the membership (active, partner active) like D4 sessions —
  revocation is immediate. Staff use the existing workspace web app (new "Partner" section) with D4 cookie sessions
  and N1 native sessions.
- **Admin:** creates a partner and its first owner (phone), verifies documents, suspends, disables catalogue items,
  sees bookings and ledger, records payouts.

## 4. Lab catalogue, slots and online bookings

- **Catalogue item** `{ partnerId, kind: 'test'|'package', name, code?, description, preparation, sampleType?,
  includes[] (for packages), price, mrp?, gstRate, sac?, visitModes: ['home','lab'], reportTatHours, isActive,
  adminDisabled }`. Lab changes are live at once; `adminDisabled` hides an item (owner decision). Prices are
  snapshotted into every booking/invoice line.
- **Slots:** per branch and visit mode, generated from the branch's weekly template and date overrides (holidays,
  extra slots) with a capacity per slot. Each generated slot has a **unique logical identity**
  `{branchId, visitMode, date, startTime}` (compound unique index). Booking takes a seat with a **conditional** `$inc`
  (`booked < capacity`) in the booking's transaction; cancel/reschedule return it exactly once (same seat-hold pattern
  as A2a). **Slot counters are server-owned:** holiday/capacity edits to existing slots adjust capacity but preserve
  existing holds (`capacity >= booked`); template expansion never deletes or resets a slot that has bookings.
- **Customer booking (through us):** customer app lists partner labs next to Healthians/LabStack (by area); picks
  tests/package, visit mode, address (home), slot, patient (self/family). Payment via the existing payment module
  (`context: 'lab_booking'`, Razorpay + wallet + coupon rules as bookings), once-only create with a request key, P8-style
  pay-again within the payment window, 30-minute expiry of unpaid bookings (as D2). Payment/verification/recovery/expiry
  adapters for `lab_booking` are explicit new code — A2a/D2/W3b/P8 patterns are reused but not automatically wired.
- **Booking state transition table (executable):**

  | Command | Source states | Guards | Hold effect | Target state |
  |---|---|---|---|---|
  | create | (new) | slot seat available, keyed idempotent create, frozen terms snapshotted | +1 seat | `pending_payment` (booking exists, payment not yet verified) |
  | payment confirmed | `pending_payment` | payment callback/wallet/zero-pay verified idempotently against booking | — | `confirmed` |
  | payment timeout | `pending_payment` | 30 min expired, no verified payment | −1 seat | `cancelled` (reason: timeout) |
  | customer cancel | `pending_payment`, `confirmed` | before cutoff (booking time − 2 h), OR booking has `rescheduleRefundEntitlement` | −1 seat | `cancelled` (reason: customer; full refund) |
  | lab reject | `confirmed` | — | −1 seat | `cancelled` (reason: lab_reject; full refund, reason shown) |
  | lab reschedule | `confirmed` | new slot seat available | −1 old, +1 new | stays `confirmed` (new slot, `rescheduleVersion` incremented, `rescheduleRefundEntitlement: true`; customer notified) |
  | customer accept reschedule | `confirmed` | booking has pending reschedule, CAS on `rescheduleVersion` | — | stays `confirmed` (`rescheduleRefundEntitlement` cleared) |
  | confirm/assign | `confirmed` | member has `bookings.manage` | — | stays `confirmed` (collector assigned) |
  | mark collected | `confirmed` (home) | `bookings.manage`, no pending unaccepted reschedule | — | `sample_collected` |
  | mark visited | `confirmed` (lab) | `bookings.manage`, no pending unaccepted reschedule | — | `visited` |
  | mark no-show | `confirmed` | `bookings.manage`, slot time passed, no pending unaccepted reschedule | — | `no_show` (no refund) |
  | processing | `sample_collected` or `visited` | `bookings.manage` | — | `processing` |
  | upload report | `processing` | `reports.upload`; D1 file binding | — | stays `processing` (draft, partner-only) |
  | release report | `processing` | `reports.release`; releasing member's name + professional registration stamped on the report record | — | `report_ready` (customer can access released version) |
  | complete | `report_ready` | `bookings.manage` | — | `completed` (ledger earning created) |

  **Creation order:** keyed creation reserves the seat and persists frozen terms (items, prices, patient, slot) in
  `pending_payment` first. Payment is then initiated/linked to the existing booking. Verified capture/reconciliation,
  direct wallet debit, or zero-pay settlement confirms it idempotently. P8-style pay-again links new payment attempts
  to the same booking. An interrupted payment leaves the booking in `pending_payment` for the timeout sweep.

  Every transition is a compare-and-set on the current state, records who (member) and when (`$min` lifecycle
  timestamps), and notifies the customer.

  **Reschedule entitlement lifecycle:** lab reschedule increments `rescheduleVersion` and sets
  `rescheduleRefundEntitlement: true`. The customer can: (a) accept the reschedule (CAS on `rescheduleVersion`,
  clears the entitlement), (b) cancel for a full refund (the entitlement overrides the normal cutoff). Staff
  transitions that advance the booking (mark collected/visited/no-show) are **blocked while an unaccepted reschedule
  is pending** — the lab must wait for the customer to accept or cancel. This prevents silently extinguishing the
  entitlement.
- **Report upload vs release (separate):** uploaded reports are bound to the booking as draft files (D1 binding with
  `released: false`). The customer cannot access them until a member with `reports.release` atomically sets
  `released: true` on the exact file version and stamps the releasing member's name and professional registration.
  Every content route enforces `released: true` for customer access; hiding the URL is not sufficient. Draft versions
  are accessible only to partner members with `reports.upload` or `reports.release`.
- **Refunds:** wallet first, card/UPI on request (P2 path), exactly once.

## 5. Doctors: scheduled and instant

- **Scheduled (existing, fixed):** weekly template expanded into slots (rolling 30 days), leave days, per-mode slots
  (video/call/chat/in-clinic) and per-clinic slots (`branchId`); conditional seat counters; fix the portal cancel
  (dedicated cancel command with refund); add `no_show`.
- **Doctor interval reservations with concurrency guard:** all booking paths (scheduled, instant, in-clinic) share a
  `DoctorReservation { doctorId, bookingId, kind, startTime, endTime, branchId?, isActive }` collection with a
  compound index on `{doctorId, isActive, startTime, endTime}`, plus a **`DoctorScheduleGuard`** document per doctor
  (unique index on `doctorId`, `{ doctorId, version: Number }`). Every reservation admission/change transaction must:
  (1) `findOneAndUpdate` the guard document (`$inc: {version: 1}` with the doctor's `_id`; upsert on first use),
  (2) query for overlapping active reservations (`startTime < newEnd AND endTime > newStart`),
  (3) if no overlap, insert the `DoctorReservation`. Because both concurrent transactions mutate the same guard
  document, MongoDB's WiredTiger write conflict detection forces one to retry, eliminating the read-then-insert
  write-skew. The overlap query runs within the transaction and sees a consistent snapshot. This combines concurrency
  exclusion (guard document) with nonoverlapping appointment coexistence (interval rows).
  Instant consultations create a reservation with a short duration (e.g., 30 min default, extended on completion).
  Presence heartbeat (`PUT /presence`) must not overwrite `busy` state — it only refreshes `lastSeen` when the
  doctor has no active instant reservation.
- **Instant:** doctor toggles **"available now"** with modes and an `instantFee` (falls back to `consultationFee`);
  presence expires without a heartbeat (2 min) and on sign-out/busy.
- **Instant request lifecycle:**
  - **Price contract and funding allocation:** at request creation, the customer sees the specific doctor's
    `instantFee` (or a **quoted maximum fee** for "any available", computed from the highest fee among currently
    online doctors of the speciality). The customer pays the quoted amount upfront. The `InstantRequest` stores
    `{quotedAmount, quotedCurrency, fundingAllocation: {gatewayAmountMinor, walletAmountMinor, couponAmountMinor,
    totalMinor}, fundingState: 'held'|'allocated'|'refunded', allocatedAmountMinor: 0, refundedAmountMinor: 0}`.
  - **Acceptance eligibility and funding allocation:** a doctor can accept only if their `instantFee <= quotedAmount`,
    the current offer has not expired (specific: 5 min, any-available: 5 min per generation), the doctor is currently
    available (mode eligible, not in an overlapping reservation), and the request's `fundingState` is `'held'`
    (not already refunded). On accept, funding is **split** into two pools in one atomic update:
    - **Allocated** (used for the consultation): `instantFee`, allocated from the held funding in priority order —
      coupon first, then wallet, then gateway. Stored per-source:
      `allocated: {couponMinor, walletMinor, gatewayMinor, totalMinor}`.
    - **Returned** (quote difference, immediate): `quotedAmount − instantFee`, returned from the held funding in
      reverse priority — gateway first, then wallet; coupon portion is voided (not converted to wallet credit).
      Stored per-source: `returned: {couponVoidedMinor, walletMinor, gatewayMinor, totalMinor}`.
    - `fundingState` transitions `held → allocated`.
    - **Invariant:** `allocated.totalMinor + returned.totalMinor == quotedAmount` (verified on write).
    - **Subsequent refunds** (cancellation, etc.) draw only from `allocated`, not from `returned` or `quotedAmount`.
      A separate `refunded: {walletMinor, gatewayMinor, totalMinor}` tracks what has been refunded against the
      allocation. Refund limit: `allocated.walletMinor − refunded.walletMinor` for wallet,
      `allocated.gatewayMinor − refunded.gatewayMinor` for gateway. Coupon allocation is non-refundable (voided on
      cancellation). This prevents double-refunding the quote difference and ensures coupon discounts never become
      withdrawable wallet credit.
  - **Specific doctor:** offered to that doctor for **5 minutes**; the offer carries an `offerGeneration` counter
    incremented on each re-offer, and an `offerExpiresAt` deadline. Accept must CAS on the current
    `offerGeneration`, `status: 'offered'`, and verify `now < offerExpiresAt`.
  - **Any available:** offered to all online doctors of the speciality for **5 minutes** per generation; the
    **first accept wins** (CAS on `status: 'offered'`, `acceptedBy: null`, `offerGeneration`, and
    `now < offerExpiresAt` atomically).
  - **Refund vs acceptance serialization:** the `InstantRequest` has a `fundingState` field that serializes refund
    against acceptance. Explicit refund (customer-initiated) or inactivity refund atomically transitions
    `fundingState: 'held' → 'refunded'` and `status: 'offered' → 'refund_requested'`. Acceptance requires
    `fundingState: 'held'` in its CAS — if the customer has already initiated a refund, acceptance fails. Conversely,
    if acceptance succeeds first (fundingState → allocated), refund of the held amount fails. The two are mutually
    exclusive on the same document.
  - **No accept in time** → the customer is shown other online doctors (re-offer increments `offerGeneration` and
    resets `offerExpiresAt`) **or** requests a refund. **Refund policy (owner decision):** never refunded
    automatically while the customer is actively choosing (UI heartbeat / screen visible); if the customer leaves it
    unanswered (no UI activity for 30 minutes from the last offer), refunded automatically via the
    `fundingState: held → refunded` transition. The `inactivityRefundAt` deadline is stored on the request; the
    customer extends it by re-offering or choosing another doctor.
  - **Accept → booking (atomic):** in one transaction: (1) CAS the request `status: offered → accepted` with
    `fundingState: held`, verify `now < offerExpiresAt`, verify doctor eligible/available/mode, (2) insert a
    `DoctorReservation` (overlap check), (3) allocate funding (update `fundingState → allocated`,
    `allocatedAmountMinor`, refund difference), (4) create the consultation booking (`bookingKind: 'instant'`),
    (5) link `request._id → booking._id` (unique). If the transaction fails (doctor overlap, request already
    accepted/refunded, offer expired), the accept is rejected. Crash recovery: check the unique `request→booking`
    link — if the booking exists, the accept succeeded; if not, no reservation was persisted (transaction rolled
    back). Meet link created for video/call; doctor marked busy via the reservation.
  - Completion feeds the doctor's **settlement account** (§7a). The settlement account is provisioned idempotently
    (find-or-create by `{ownerKind: 'doctor', ownerId: specialistId}`) before the booking/payment snapshot, so it
    exists at snapshot time even for a doctor's first consultation.
- **Customer app:** "Consult now" (online doctors, speciality filter, any-available) and "Book an appointment"
  (existing flow).

## 6. In-house sales (labs, clinics, doctors)

- **Invoice** `{ partnerId, branchId, number, financialYear, issuedAt,
  supplier {name, legalName, gstin?, pan?, address, placeOfSupply (state code)},
  customer {name, phone?, userId?, gstin?, age?, gender?, placeOfSupply? (state code)},
  doctorId? (clinic invoices name the doctor),
  items[{catalogItemId?, description, hsn?, sac?, qty, unitPriceMinor (paise, integer), discountMinor, gstRate (0|5|12|18|28),
  amountMinor}],
  totals {subtotalMinor, discountMinor, taxableMinor, cgstMinor, sgstMinor, igstMinor, totalMinor, currency: 'INR'},
  status: 'issued',
  createdBy, checksum, idempotencyKey }`.
  All monetary fields are **integer minor units** (paise). Tax rounding: per-line `taxableMinor × rate / 100` rounded
  to nearest paise; totals are sums of rounded line amounts. GST split: CGST+SGST when supplier and customer place of
  supply match; IGST otherwise. `gstRate` per item must be from the allowed set (validated, not arbitrary);
  `gstRate: 0` is an explicit no-tax line (exempt/nil-rated).

  **Invoice classification by supplier tax regime and supply type:** the Partner stores
  `taxRegime: 'regular'|'composition'|'unregistered'` (set by admin at verification; default `'unregistered'` until
  GSTIN is verified). The invoice classification depends on both the regime and the line items:
  - `regular` + verified GSTIN + **at least one taxable line** (gstRate > 0) → **tax invoice**: GSTIN printed,
    per-line GST calculated and shown, tax totals shown. Mixed taxable + exempt lines are allowed (exempt lines
    show gstRate: 0 with zero tax).
  - `regular` + verified GSTIN + **all lines exempt/nil-rated** (every gstRate == 0) → **bill of supply**: GSTIN
    printed, no tax breakdown (all supplies are exempt). This correctly classifies a registered supplier's
    exempt-only document.
  - `composition` + verified GSTIN → **bill of supply**: GSTIN printed, no per-line GST breakdown (composition
    suppliers cannot charge GST to customers), all line amounts are inclusive. A note "Composition dealer — tax not
    chargeable" is printed. All `gstRate` fields must be 0.
  - `unregistered` (no verified GSTIN) → **commercial invoice**: no GSTIN, no GST breakdown. All `gstRate` fields
    must be 0; the system rejects invoice creation with nonzero tax rates for unregistered suppliers.

  The classification (`documentKind: 'tax_invoice'|'bill_of_supply'|'commercial_invoice'`) is computed at creation
  time from the Partner's current `taxRegime`, GSTIN state, and line item tax rates, then **frozen** into the
  invoice. Tax fields are enforced by the classification: a `bill_of_supply` or `commercial_invoice` cannot have
  nonzero computed tax totals.
- **Immutability:** the issued invoice document is **never mutated**. Payment and cancellation are recorded as separate
  **InvoiceEvent** documents `{ invoiceId, kind: 'payment'|'cancellation', ...payload, at, by }`. The invoice's
  `checksum` covers all financial fields and is verified on every read. Payment event:
  `{ mode: cash|upi|card|bank|other, reference?, note? }`. Cancellation event: `{ reason }`. Cancelling a paid
  invoice records the cancellation but does **not** claim the external cash/UPI payment was returned — the partner
  must acknowledge refund separately (or issue a new corrective invoice). Credit notes are deferred (§9).
- **Numbering:** `<PREFIX>/<FY>/<NNNN>` sequential per partner and financial year — an atomic counter
  (`findOneAndUpdate $inc`) in the same transaction as the invoice insert; no gaps from failed writes.
  `<PREFIX>` max 6 chars; total serial max 16 characters per CBIC Rule 46. Financial year is server-determined
  (April–March). Unique compound index `{partnerId, financialYear, number}`.
  Partner-scoped idempotency key unique index prevents duplicate invoices from retried requests.
- **Invoice lifecycle fence:** although the invoice financial document is immutable, the Invoice document carries a
  mutable `lifecycleVersion` (integer, starts at 0) and `lifecycleState: 'issued'|'paid'|'cancelled'`. Every event
  (payment or cancellation) is a transaction that: (1) CAS the Invoice's `lifecycleVersion` to `version + 1` and
  transitions `lifecycleState`, (2) inserts the InvoiceEvent. Legal transitions: `issued → paid` (payment event),
  `issued → cancelled` (cancellation event), `paid → cancelled` (cancellation event — records cancellation of a paid
  invoice). `cancelled` is terminal. The `lifecycleVersion` CAS serializes concurrent payment vs cancellation —
  both cannot succeed. InvoiceEvent has a unique index `{invoiceId, kind}` to prevent duplicate payment events,
  but the primary serialization is the Invoice's `lifecycleVersion` CAS.
- **Payment is not collected by us:** a member with `payments.record` picks the mode, adds a reference/keyword and
  creates a payment event via the lifecycle fence (CAS `issued → paid`); reversal only by cancelling the invoice.
- **Walk-in linking:** if a phone number is given, it is resolved through a **shared race-safe customer identity
  resolver** (§6a). The invoice and any lab report released for that visit appear in the customer app under
  "Bills" / "Reports". In-house sales are **not** in the payout ledger (the money never passes through us) but are
  in the partner's sales reports.
- **PDF:** generated from the immutable invoice + its events (partner name/address/GSTIN, items, GST split, payment
  status from events), stored as a private file (D1) readable by the partner and the linked customer. The PDF is
  regenerated when a new event is recorded (payment or cancellation) — each version is a new file; prior versions
  remain accessible for audit.

### 6a. Shared race-safe customer identity resolver and canonical phone representation

**Canonical phone format:** all customer phone numbers are stored and queried in **ten-digit format** (matching
the existing `auth/validation` and customer-contact login selector). The current User model stores ten-digit phones;
the existing OTP flow, pharmacy walk-in, and all customer lookups use this format. The resolver does **not** store
E.164 — it normalizes input to ten digits (strip `+91` / `0` prefix, validate length) before query/upsert. This
ensures walk-in linking finds existing accounts created by OTP signup, and OTP login finds accounts created by
walk-in linking. A future migration to E.164 across all writers would be a separate coordinated change.

Walk-in linking, partner walk-in, and any future path that needs to find-or-create a customer by phone share one
coordinated path: `resolveCustomerByPhone(phone, source)`.

1. Normalize the phone to ten-digit canonical form.
2. **Prerequisite: unique partial index must be live before the resolver is activated.** A migration script (run
   as part of Q2 deployment) normalizes all existing phone values to ten-digit canonical form and scans for
   duplicate `{phone, userType: 'user'}` pairs among rows where `phone` is present. Duplicates are resolved by the
   admin (merge or designate canonical). Then a **unique partial index** is created:
   `{ phone: 1, userType: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } }`.
   This excludes rows where `phone` is null/missing (email-only customers created via `auth/validation` email-only
   enrollment), preserving their ability to exist without a phone. The resolver is **not activated** until the
   index is confirmed live — there is no pre-index fallback mode. This eliminates the concurrent-creation race
   entirely while preserving email-only user accounts.
3. With the unique partial index live: `findOneAndUpdate` with `{ phone, userType: 'user' }` and
   `$setOnInsert: { createdSource: source }`, `upsert: true`, `returnDocument: 'after'`. The partial unique index
   prevents concurrent duplicates atomically for all phone-bearing rows. Email-only users are unaffected.
4. If the upsert created a new user, send the SMS link.
5. Never merge accounts or overwrite an existing customer's name/verified-contact fields from invoice input.
5. The visit patient/dependent (age, gender on the invoice) is distinct from the billing contact (the linked
   customer account). Invoice `customer.userId` points to the resolved account; patient details stay on the
   invoice line.
6. SMS links are authenticated — they lead to the app's sign-in flow, not to a public document grant.

### 7a. Settlement accounts and doctor payout cutover

Every entity that can earn money through the platform has a **SettlementAccount**
`{ _id, ownerKind: 'partner'|'doctor', ownerId (partnerId or specialistId), bankDetails?, isActive }`.

- A **partner** gets a settlement account when created by an admin.
- A **doctor** gets a settlement account provisioned idempotently (find-or-create by
  `{ownerKind: 'doctor', ownerId: specialistId}`) **before** the first booking/payment snapshot that references it.
  This is called at booking creation time, so the settlement account exists when the snapshot is taken, even for a
  doctor's first consultation. A tele-only doctor who never enables in-clinic billing has a settlement account
  without a Partner — the solo practice Partner is created only when in-clinic billing is enabled (§3).
- A **clinic partner** earns from lab bookings and in-house invoices. When a consultation at a clinic completes, the
  earning goes to the **doctor's** settlement account (the doctor is the service provider). The clinic may charge a
  facility fee in the future (deferred); for now, clinic partners earn only from their own lab/invoice services.
- Each online booking/payment snapshots `{ settlementAccountId, beneficiaryName }` at creation time. Historical
  earnings are never re-derived from current membership.

**Doctor payout cutover (required before Q4 earnings):**
- The existing `payouts` module (`payouts/services/index.ts`) selects paid, non-cancelled specialist consultations
  and runs a separate billing/disbursal path. Its billings are monthly aggregations, not per-booking records.
- **Exclusive source ownership:** every booking is assigned to exactly one settlement system. A `settlementSystem`
  field is added to the Booking model: `'legacy'` (default for all existing bookings) or `'ledger'` (for new
  bookings created after cutover). The legacy payout query adds `settlementSystem: 'legacy'` to its filter; the
  new ledger earning creation requires `settlementSystem: 'ledger'`. Neither system can process a booking owned by
  the other.
- **Cutover steps (Q3, before Q4):**
  1. Add `settlementSystem: 'legacy'` to all existing bookings (migration script, idempotent).
  2. Set a `cutoverDate` in config. All bookings created after `cutoverDate` get `settlementSystem: 'ledger'`
     automatically. The legacy payout query adds `settlementSystem: 'legacy'`; the new ledger earning creation
     requires `settlementSystem: 'ledger'`.
  3. **All legacy liabilities stay with the legacy system; the new ledger opens at zero.** The new ledger has
     **no opening balance entry** for legacy dues. Legacy bookings (`settlementSystem: 'legacy'`) are settled
     exclusively by the old payout system — their earnings, outstanding dues, and disbursals never appear in the
     new ledger's spendable balance. The new ledger balance starts at zero and grows only from `settlementSystem:
     'ledger'` earnings.
  4. **Historical display:** historical earnings and disbursals from the legacy system are imported as **non-posting
     reference records** (a `LedgerHistoryRef` collection with `source: 'legacy_import'`, billing period, amounts,
     per doctor). These are visible on the partner finance statement for context ("History before [cutoverDate]")
     but are **not** included in the ledger balance sum and are **not** payable from the new ledger.
  5. **Separation invariant:** no liability is payable by both systems. Legacy bookings → old payout billings only.
     Ledger bookings → new ledger earnings/payouts only. The `settlementSystem` field is the exclusive ownership
     fence. Verified by the migration script: no booking without a `settlementSystem` value after migration.
  6. The two systems are permanently partitioned by `settlementSystem`. Each liability has exactly one payable owner.
- From that point forward, every new booking earning goes exclusively to the ledger. The two systems are
  permanently partitioned by `settlementSystem`.
- This cutover is in Q3 (before Q4 doctors), not deferred to Q5. Q5 delivers the partner finance screens and admin
  payout recording UI, but the data model and exclusion fence must exist first.

## 7. Ledger and payouts (money collected online by us)

- **Ledger entries** per settlement account (append-only): `earning` (booking/consultation completed: amount,
  commission 0, net, snapshotted settlement account), `reversal` (refund after earning), `payout` (admin-recorded bank
  transfer: amount, reference, date, proof), `adjustment` (admin, with reason). Balance = Σ entries; idempotent per
  source (unique `{settlementAccountId, source, sourceId, kind}`).
- Partner "Finance" screen: balance, statement, payouts; admin "Payouts" queue to record transfers.

## 8. Security and integrity

Tenancy is always `partnerId` from the admitted membership (never from the request); branch scoping by `branchIds`;
every action checks a permission (with delegation ceiling — §3); all state changes are compare-and-set; money moves
in transactions with exactly-once keys; file access through D1 bindings with released-version enforcement (§4);
audit trail on every partner action (who, when, what); rate limits on partner OTP as O1.

Settlement account ownership is snapshotted at booking/payment time (§7a); earnings are never re-derived from
current membership; doctor settlement accounts are provisioned idempotently before first snapshot. Walk-in customer
identity is resolved through a single race-safe path with canonical ten-digit phone matching (§6a).
Instant-request acceptance is atomic with doctor interval reservation and booking creation (§5); price contract is
frozen at request time; funding allocation tracks gateway/wallet/coupon separately; refund vs acceptance serialized
on `fundingState`. Invoice lifecycle versioned to serialize payment vs cancellation (§6). Supplier tax regime
determines invoice classification and enforces tax field constraints (§6).

## 9. Not in scope now (recorded)

Commission/platform fees (fields kept at 0); subscriptions for partners; automated bank payouts; credit notes; lab API
integrations for new partners; inventory of lab consumables; insurance/corporate billing for partners.

## 10. Packets

| Packet | Content |
|---|---|
| **Q1** Partner foundation | Partner (with `activeOwnerCount`, `taxRegime`), Branch, Member, permissions (delegation ceiling with active-owner protection), OTP `partner` login + membership admission, admin onboarding, workspace "Partner" shell with staff & branch management |
| **Q2** In-house invoices | Catalogue (minimal), immutable invoices (integer paise, supplier tax regime classification, CBIC-compliant serial ≤16 chars) + InvoiceEvents with lifecycle version fence (payment/cancel serialization), PDF, shared customer identity resolver (§6a, canonical 10-digit phone), walk-in linking + SMS, customer "Bills" |
| **Q3** Partner-lab online bookings | Settlement accounts (idempotent doctor provisioning) + doctor payout cutover (exclusive `settlementSystem` ownership, reconciled opening balance, §7a), lab catalogue + server-owned slots (unique identity, hold-preserving edits), executable state machine (§4, creation-before-payment, reschedule acceptance lifecycle), customer search & booking & payment (explicit `lab_booking` adapters, pay-again, expiry), lab booking management, report upload/release (draft→released, §4), customer "Reports", ledger earnings/refunds |
| **Q4** Doctors | Doctor interval reservations (nonoverlapping, §5), weekly template, leave, per-mode/per-clinic slots, cancel fix, no-show; instant consultations (presence, price contract + funding allocation with gateway/wallet/coupon tracking, offer generation/deadline/expiry, atomic accept with funding/refund serialization on `fundingState`, re-offer, inactivity refund); customer "Consult now" |
| **Q5** Payouts | Ledger statements, admin payout recording, partner finance screens |
| **Q6** Clinics | Clinic partners with several doctors, clinic front desk booking/invoicing per doctor, solo practice auto-creation |

Each packet: backend + workspace/customer screens + tests (integration + browser) + Codex review; design questions
that are the owner's go to the owner.

## 11. Build decisions (recorded during Q1–Q6)

| Date | Decision | Why |
|---|---|---|
| 2026-11-15 | Owner (asked directly): **platform admins can do everything a partner's owner can do, for any partner** | Owner requirement. The partner workspace routes are registered twice: for members (`/api/v1/partner-workspace/...`) and for admins (`/api/v1/partner-workspace/admin/:partnerId/workspace/...`) with owner authority, whatever the partner's verification state. Every later packet adds its workspace routes to the same registration, so admin access follows automatically. |
| 2026-11-15 | Every workspace mutation writes a `PartnerAuditEvent` (`partner_audit_events`): actor kind (member/admin), actor id, action, target | §8 audit trail; admin-as-owner makes "who did it" essential. Written in the operation's transaction where it has one. |
| 2026-11-15 | The existing `partners` display directory stays untouched (model `Partner`, collection `partners`, routes at `/api/v1/partners`); operational partners use `PartnerOrg`/`partner_orgs`, `PartnerMember`/`partner_members`, `PartnerBranch`/`partner_branches` and `/api/v1/partner-workspace` | Codex Q1 re-review: keep the legacy contract and its data; keep operational authority separate from display data. |
| 2026-11-15 | Partner tokens are refused (`denyRoles('partner')`) on every authenticated legacy router except auth, the workspace, the directory, file access (D1 decides per file) and request keys | Default-deny for a new role rather than a list of known-bad routers. |
| 2026-11-15 | Branch ceiling: a restricted member (non-empty `branchIds`) may only hand out a non-empty scope inside its own, and sees/manages only staff whose whole scope lies inside its own (never owners or all-branch staff); restricted members cannot create branches | §3 "cannot expand branch scope beyond their own"; empty = all branches must never be delegated by a restricted member. |
| 2026-11-15 | Q2: invoice PDFs are rendered on demand (wkhtmltopdf, as prescriptions) from the immutable invoice plus its events, behind the same partner/branch or customer checks as the JSON; `?version=n` reproduces the bill as of lifecycle version n | Equivalent to "a new file per event, prior versions accessible" with nothing stored or exposed through static URLs; deterministic because the invoice never changes and events are append-only. |
| 2026-11-15 | Q2: financial year computed in India time; serial `<PREFIX>/<YYZZ>/<NNNN>` (e.g. `MD/2627/0001`); prefix uppercase A–Z/0–9, max 6 | Keeps every serial ≤ 16 characters (CBIC Rule 46). With a 6-character prefix a partner can issue 9,999 bills a year; beyond that creation fails with `SERIAL_EXHAUSTED` (no gap, counter unchanged) and an admin sets a shorter prefix. |
| 2026-11-15 | Q2: every invoice belongs to a branch; the supplier address and GST state code come from that branch. A B2C bill with no customer state is intra-state | §3 "every invoice belongs to one branch"; place of supply is the supplier's location when the recipient's is unknown. |
| 2026-11-15 | Q2: walk-in linking runs only when `q2_user_phone_unique` (declared on the User schema so sync-indexes keeps it) is built and ready; otherwise a bill with a phone is refused with 503 and a bill without a phone still works. Deploy order: `npm run migrate:q2-user-phones` (dry run, then `--commit`), admin resolves any listed duplicates, then `npm run sync-indexes` | §6a "no pre-index fallback". |
| 2026-11-15 | Q2: the walk-in bill SMS needs a DLT-registered template (`SMS_TEMPLATE_ID_PARTNER_BILL`); until it is set, no SMS is sent. Sent after the bill commits, to customers who have never signed in, never on a replay; no link and no health details | Indian DLT rules; owner/ops to register the template text in `sms/services` (`partner_bill`). |
| 2026-11-15 | Q2: a reused idempotency key with a different request is refused (409) | Silent return of a different bill would hide a client bug. |
| 2026-11-15 | Q2 review: a bill that prints a GSTIN (tax invoice / bill of supply) can be issued only from a branch in that GSTIN's state; other states are refused (`GST_REGISTRATION_STATE_MISMATCH`). Multi-state partners need a registration per state — per-branch registrations are a follow-up (admin-set, like the partner's GSTIN) | GST registrations are state-specific (Codex Q2 #6). |
| 2026-11-15 | Q2 review: `User.phone` is canonicalised (ten digits) by a schema setter, so every model writer and query filter uses the one form; the phone migration reads/writes raw | Prevents admin/other writers re-introducing "+91…" next to the unique ten-digit key (Codex Q2 #2). |
| 2026-11-15 | Q3: payment verification for `lab_booking` is dispatched through a context-handler registry in PaymentService (the lab module registers itself at route setup); registered contexts are never routed to external-booking fulfilment | Keeps the payment service free of partner imports; same capture/reconcile/sweep paths as bookings (W3b/D2/P8 patterns). |
| 2026-11-15 | Q3: lab-booking money uses the bookings' `walletFunding` ledger (`FundedBookingKind 'lab_booking'`): wallet first, one gateway capture applied, late/losing captures returned to the wallet, cancellation refunds everything to the wallet exactly once | Reuses the reviewed money ledger. **Refund to card/UPI on request is not in Q3**: the only refund-to-source path today is pharmacy-specific (P2); a generic one for lab bookings follows as its own reviewed packet (Q3b). |
| 2026-11-15 | Q3: coupons follow the diagnostics rules (`external_diagnostics`; a coupon can target a partner by its id or its catalogue items); the discount is platform-funded, so the partner's earning is its own price (subtotal), commission 0 | Owner: no commission now; coupons are platform promotions. Flag to owner if partners should share coupon cost. |
| 2026-11-15 | Q3: timings — payment window 30 min (expiry sweep every 5 min, after reconciling with Razorpay, backing off while unknown); a slot must start ≥ 60 min after booking; customer cancellation with full refund until 2 h before the slot (or any time while a lab reschedule is unanswered); rolling 30-day slot expansion nightly at 01:10 IST | Design §4 and D2. |
| 2026-11-15 | Q3: report release needs a signer — an active member holding `reports.release` (or owner) with a professional registration number; members sign as themselves, admins name the member. Release moves the exact path from `report.draftFiles` to `report.releasedFiles` (the draft grant stops counting) and binds it `partner_lab_report`; re-release only repairs the grant | §4: clinical accountability is the named professional; the admin-as-owner decision does not let an admin sign a report as a pathologist. |
| 2026-11-15 | Q3: cutover — `Booking.settlementSystem` stamped at the single insert (`holds.ts`) from `SETTLEMENT_CUTOVER_AT` (unset = legacy); legacy payout queries select `settlementSystem != 'ledger'` (correct before and after the stamping migration). Deploy: `npm run migrate:q3-settlement-cutover` (dry run, then `--commit`). **Codex Q3 #1:** in Q3 every ordinary booking is still stamped `legacy`; `SETTLEMENT_CUTOVER_AT` takes effect only from Q4a, which adds the doctor ledger earnings — never set it before Q4a is deployed | §7a exclusive ownership; legacy history imported as non-posting `LedgerHistoryRef` rows in paise. |
| 2026-11-15 | Q3: customer lab discovery is its own API (`/api/v1/partner-labs`, `/api/v1/lab-bookings`); the app lists partner labs next to Healthians/LabStack | externalBookings has no provider abstraction (closed union with many provider branches). |
| 2026-11-15 | Q3: a no-show is not refunded (§4) and the partner earns it like a completed booking (its slot was kept); earnings post only for bookings paid through us, once per booking | Otherwise the captured money would be neither refunded nor payable. **Owner to confirm** (alternative: partial refund / no-show fee). |
| 2026-11-15 | Q3: a resent lab-booking create with a different request under the same key is refused (409); wallet use is not part of the request identity | Same rule as invoices (Codex Q2). |
| 2026-11-15 | Q3 review: report files are written only by `POST /partner-workspace/lab-bookings/:id/reports` (multipart; server-chosen `partner-lab-reports/<bookingId>/` folder, now reserved for generic uploads) and are readable only through their report bindings — the uploader shortcut does not apply to report paths | Codex Q3 #3/#4: scope comes from the URL, and draft access follows current permission + branch. |
| 2026-11-15 | Q3 review: generated slots are reconciled on every expansion (unbooked rows follow the template; booked rows keep their time and are never below their bookings); expansion runs as ONE transaction that first bumps the schedule's guard (`ScheduleGuard`, in a model directory so sync-indexes builds its unique key); template saves and branch holiday/service changes bump the same guard, so a stale run can never commit after a newer one (the loser retries and re-reads); a long-paused run is aborted by the transaction lifetime limit. Holidays are reconciled for manual-only schedules too and enforced again at seat admission | Codex Q3 #6–#8 and re-review (no lease). |
| 2026-11-15 | Q3 review: generated slots are reconciled on every expansion (unbooked rows follow the template; booked rows keep their time and are never below their bookings); expansion runs under a per-schedule lease and reads its configuration after acquiring it; branch holiday/service changes re-expand | Codex Q3 #6–#8. |
| 2026-11-15 | Q4 is built and reviewed as Q4a (scheduled: interval reservations, weekly template, leave, per-mode/per-clinic slots, doctor cancel, no-show, ledger earnings) and Q4b (instant consultations) | Two separate money/concurrency surfaces; smaller reviews. |
| 2026-11-15 | Q4a: a doctor's interval is exclusive for one-patient consultation slots (`maxBookings` 1); slots deliberately sold to several patients keep only their seat counter | Existing doctors may run multi-patient slots on purpose; exclusivity there would break them. Instant and in-clinic paths always reserve. |
| 2026-11-15 | Q4a: the doctor's earning for a ledger consultation is its price before coupons (`originalPrice`), commission 0, on completion and on no-show (no refund), once per booking | Same rule as partner labs (platform-funded coupons). Legacy bookings stay with the legacy payouts. **Owner to confirm.** |
| 2026-11-15 | Q4a: a doctor (or admin) cancelling an appointment always refunds the patient in full to the wallet (cause `doctor`); the portal's "cancelled" status uses this command | Fixes the portal's 409; the patient is never charged for a doctor cancellation. |
| 2026-11-15 | Q4a: the weekly schedule is a new `DoctorScheduleTemplate` (windows with modes and an optional clinic branch, leave dates) expanded into ordinary Slots for 30 days; the old unused `availability` fields are left untouched | Reuses the existing booking/slot path; nothing reads the old fields. Deploy: `npm run migrate:q4-reservations` (dry run, then `--commit`) gives existing future bookings their intervals. |
| 2026-11-15 | Q4a turns the cutover on for ordinary consultations: from `SETTLEMENT_CUTOVER_AT` they are stamped `ledger`, snapshot the doctor's settlement account and earn through the ledger (completion / no-show); the doctor schedule uses the same schedule guard (no lease), reconciliation and real-date rules as lab slots | Codex Q3 #1 and #6–#9 applied to doctors. Deploy order: Q3 migration → Q4a (`migrate:q4-reservations`) → only then set `SETTLEMENT_CUTOVER_AT`. |
| 2026-11-15 | Q4b: the quote difference (and any later refund) goes back to the customer's **wallet**, gateway part included; refund to card/UPI on request is the same deferred Q3b work | One exactly-once money path (wallet ledger) for every instant refund; the design's "wallet first, card/UPI on request". |
| 2026-11-15 | Q4b: once a doctor accepts, the customer cannot cancel (the consultation starts at once); the doctor or an admin can cancel before completion, refunding the allocation (wallet + gateway parts to the wallet, once; the coupon is voided, never money); a patient who does not join is a no-show (no refund, the doctor earns) | §5 "subsequent refunds draw only from allocated". **Owner to confirm** customer-side cancellation after acceptance. |
| 2026-11-15 | Q4b: an accepted consultation reserves the doctor for 30 minutes (extendable by the doctor, refused on overlap); completion frees the doctor at once; Meet links reuse the booking Meet path with the consultation window | §5. |
| 2026-11-15 | Q4b: sweeps every minute — unpaid requests expire after 30 minutes (reconciled first), held funding is refunded after 30 minutes without customer activity since the last offer | §5 inactivity refund (owner decision). |
| 2026-11-15 | Q4a (Codex round 1): `completed` and `no_show` are terminal for every writer (generic edit, portal, cancellation); a ledger consultation can be completed only once paid (the write fence repeats it) | An earning may exist for a terminal booking; reopening it would allow a refund without reversing the earning. A correction flow (reverse earning + restore interval) is not built; admins resolve such cases by hand until one is needed. |
| 2026-11-15 | Q4a (Codex round 1): clinic authority (active member of an active verified clinic, active in-clinic branch in the member's scope) is checked on the current state at template save, every expansion and every new booking admission; losing it closes future clinic slots for new bookings, appointments already made are kept | Revoked clinics must not keep selling the doctor's time; existing patients are not cancelled automatically. |
| 2026-11-15 | Q4a (Codex round 1): leave is refused at booking admission whatever the slots say, and a leave change beyond the 30-day window reconciles that day at once (no template slots are generated there); slot times are parsed in both stored formats (`h:mm AM/PM` from the slot API, `HH:mm` from templates) by one parser for admission, listing and the backfill; a consultation-type change is admitted against the slot on every path | Findings #1, #5, #7. |
| 2026-11-15 | Q4b (Codex round 1): Meet windows come from the one slot-time parser (both formats, midnight rollover); an instant consultation's window is its doctor reservation (extensions included), so any later re-sync rebuilds it | Finding #1; also fixes Meet for HH:mm template slots. |
| 2026-11-15 | Q4b (Codex round 1): an instant consultation is never rescheduled; extensions are computed inside the doctor-guarded transaction; coupon checks use the real patient and the account's corporate; a coupon for named doctors is frozen on the request and binds offers, re-offers and acceptance; offers/heartbeats require a currently active, verified doctor; discovery and acceptance use the doctor's current speciality | Findings #2–#7. |
| 2026-11-15 | Q5: payout destination (bank account + IFSC, or UPI) is stored on the settlement account and set by the partner's **owner** (or the doctor for their own account, or an admin); every change bumps a version and clears verification; an admin verifies the exact version they checked, and a payout must name that verified version | A compromised staff or owner login cannot silently redirect money; verification happens outside the system (penny drop / documents). |
| 2026-11-15 | Q5: the full account number is stored (an admin must transfer to it) and returned only to admins; owners, doctors, audit entries and the admin queue list see the last four digits | Least exposure without encryption infrastructure; field-level encryption can follow if required. |
| 2026-11-15 | Q5: an admin records a transfer made outside the system (method, bank reference/UTR, date paid, note); it never exceeds the current ledger balance, is exactly once per (admin, request key), and a reference is unique per account among recorded payouts. Payouts, voids, adjustments and destination changes serialize on the account (`financeVersion`) | Automated bank payouts stay out of scope (§9). Earnings are not serialized (they only raise the balance). |
| 2026-11-15 | Q5: mistakes are corrected by appending — a voided payout gets a compensating `adjustment` (source `payout_void`); admin adjustments are signed, need a reason, and may take a balance below zero (a recovery owed) | Append-only ledger (§7). |
| 2026-11-15 | Q5: partner finance (balance, statement with running balance, CSV, payouts) needs `finance.view` **and** partner-wide scope; doctors see their own under `/specialists/me/finance` (legacy history included); admins use `/api/v1/settlements` and, as owner, the workspace finance routes of any partner | Finance spans every branch. Reading never creates an account. |
| 2026-11-15 | Q5: deferred — payout proof file upload (the bank reference is the proof for now), payout notifications to doctors/partners, and an earning-reversal command (no flow refunds after an earning today; admins use adjustments) | Kept the packet to the money path; recorded for a follow-up. |
| 2026-11-15 | Q5 (Codex round 1): finance details (amounts, references, destinations, balances) live only in the finance event stream (`finance.view`, partner-wide); the general partner audit records who/what/which account only. Statements and CSV read rows and balances from one snapshot; a CSV's opening balance is everything before the period (a quiet period still shows it); a period over 5,000 entries is refused (export a shorter one); the admin queue computes balances, filters, totals and pages over every account in the database; ids are canonical at every finance boundary | Findings #1–#6. |
| 2026-11-15 | Q6: a doctor joins a clinic only by accepting the clinic's invitation in their own portal (by doctor id or registered mobile; optional branch subset); acceptance creates the doctor's membership (no permissions; the owner may grant some) or links the doctor's existing staff record with the same mobile. One active doctor membership per clinic (unique index). The doctor may leave any clinic they do not own; authority ends at once (admission) and their generated clinic slots close right away | Clinics must never claim a doctor's time without consent; Q4's clinic authority reads the membership. |
| 2026-11-15 | Q6: front-desk appointments are ordinary consultation bookings on a clinic doctor's in-clinic slot (same seat, doctor interval, leave and clinic-authority admission as online bookings), confirmed at once, for a customer found or created by mobile (never merged or overwritten, source `clinic_desk`); the account holder is the patient | One shared admission prevents double booking across desk and online. Family members book under their own number or in the app. |
| 2026-11-15 | Q6: desk appointments are **paid at the clinic** (`settlementSystem: 'clinic'`): no online payment (booking pay-again and pharmacy wallet refuse them), never in the ledger, never in the legacy payouts (their filters now exclude `clinic`); the clinic bills with its own invoice naming the doctor (Q2) | We never collect, so nothing is settled through us. |
| 2026-11-15 | Q6: the clinic (bookings.manage, branch scope) checks in, completes, marks no-show (after the time), cancels and reschedules (same doctor, own branches) its desk appointments, each audited in the same transaction; online bookings at the clinic are view-only for the clinic; customers can cancel a desk appointment (nothing to refund) but only the clinic moves it. The appointment list shows desk and online bookings at the clinic's branches with the patient's name and mobile | Online bookings stay with the doctor/customer flows (money through us). |
| 2026-11-15 | Q6: a solo practice is a clinic partner the doctor creates from their portal (one per doctor, unique `soloDoctorId`; the doctor is the owner member with their mobile, one in-clinic branch, a settlement account); it starts pending and an admin verifies it (and sets the tax regime) before its in-clinic slots can be booked | Design §3; verification is the platform's control point. |
| 2026-11-15 | Q6: deferred — linking an invoice to the appointment it bills, SMS/notifications for desk appointments and invitations, family-member patients on desk appointments | Recorded for a follow-up. |
| 2026-11-15 | Q6 (Codex round 1): every in-clinic booking records its clinic and branch (`clinicVisit`) at admission, moved only by an admitted reschedule; the clinic appointment list reads that (desk rows: their `clinicDesk` only), never a slot's current branch. The desk's clinic and branch scope are admitted inside the booking transaction (create and reschedule) and the stored branch comes from that admission. Invitations stay within a restricted manager's branches. A doctor's consultation scope (`doctorBranchIds`, from the accepted invitation) is separate from workspace access. Desk request keys are unique per desk member with a content hash. Moving a desk appointment clears its check-in. The list shows the family member being seen | Findings #1–#7. |
| 2026-11-15 | Q7: a person with several partner memberships (e.g. a doctor's solo practice and a clinic) signs in by phone code, then chooses the workspace: the code (sent to the first membership in partnerId order) proves the phone, the answer lists only active partners with a 5-minute signed, one-use ticket (no token), and `POST /auth/partner/select` opens the chosen workspace with the same bearer/cookie/native session rules as verify. Naming the partner up front still works | Listing a phone's partners before the code would leak memberships; a doctor in two places must be able to choose. |
| 2026-11-15 | Q8 (gaps found by the WQ1 web packet): the partner profile is owner-only; a staff member's branch access can be changed (delegation ceiling as when adding staff; never self, never owners); closed branches can be reopened by all-branch branch managers; suspended partners can be reinstated by an admin (audited); every member can read their branches (closed ones only for branch managers); admin partner creation is exactly once per (admin, request key); the partner list is paged and searchable | Without these the workspace cannot manage staff scope or undo a closure/suspension, and a resent create made duplicates. |
| 2026-11-15 | Q9 (gaps found by the WC1 customer app): customer lists (bills, partner-lab bookings, instant requests) are paged (data stays an array, plus `pagination`); bills show the named doctor's current name (view and PDF; not part of the immutable document/checksum); lab bookings carry the lab and branch names and each report release names its file; `GET /partner-labs/:partnerId` reads one lab; `GET /instant/specialities` lists specialities with doctors online now; a held-funding refund is recorded on the request; `GET /request-keys/lookup` answers used/abandoned/unknown without changing anything | The app no longer has to guess pairings or scan whole lists; a reloaded client can check a lost create before deciding to abandon it. |
| 2026-11-15 | Q10 (gaps found by the WQ1/WQ2 web packets): catalogue kinds by partner type (labs: test/package with visit modes; clinics: consultation/procedure/package/other without), GST above 0% only with a regular registration + GSTIN, deactivated items listed for managers and reactivatable, item create exactly once per key; a catalogue-linked bill line must bill the catalogue's current price and GST; the doctor on a clinic bill must consult at that branch and be active/verified; a lost bill answer can be looked up or its key abandoned (the key is claimed with the bill); a repeated identical payment returns its receipt; cancelling a paid bill requires recording how the money went back; the bills list pages by an exact `<ms>_<id>` cursor with dates, search and a total; profile, branch, member and catalogue edits accept `expectedUpdatedAt` and refuse a stale one | Part payments stay out of scope (a bill is paid in full); refunds of in-house bills are made by the partner and only recorded. |
