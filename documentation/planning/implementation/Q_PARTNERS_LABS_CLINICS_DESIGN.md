# Q — Partner labs, clinics and doctors: online bookings, instant consultations, in-house sales (design, 2026-11-15)

Status: design revised after Codex review (msg_1794738703339_zjpor6dd). Built in packets Q1–Q6 (§10), each reviewed by Codex.

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
  {state: pending|verified|suspended, documents[], verifiedAt, verifiedBy}, invoiceSeries {prefix}, isActive }`.
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
  (`role: 'owner' ↔ 'staff'`) are owner-only. **Last-owner protection:** the Partner document carries an `ownerCount`
  (maintained by `$inc` in the same transaction as any Member role change). Demotion/removal of an owner requires
  `ownerCount > 1` as a CAS pre-condition; the counter prevents two concurrent last-owner removals. Actor/target must
  share the same `partnerId` (enforced from admitted membership, never from the request).
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
  | create (pay) | (new) | slot seat available, payment verified | +1 seat | `pending_payment` |
  | payment confirmed | `pending_payment` | payment callback verified | — | `confirmed` |
  | payment timeout | `pending_payment` | 30 min expired, no payment | −1 seat | `cancelled` (reason: timeout) |
  | customer cancel | `pending_payment`, `confirmed` | before cutoff (booking time − 2 h) | −1 seat | `cancelled` (reason: customer; full refund) |
  | lab reject | `confirmed` | — | −1 seat | `cancelled` (reason: lab_reject; full refund, reason shown) |
  | lab reschedule | `confirmed` | new slot seat available | −1 old, +1 new | stays `confirmed` (new slot; customer notified; customer may cancel for full refund regardless of cutoff) |
  | confirm/assign | `confirmed` | member has `bookings.manage` | — | stays `confirmed` (collector assigned) |
  | mark collected | `confirmed` (home) | `bookings.manage` | — | `sample_collected` |
  | mark visited | `confirmed` (lab) | `bookings.manage` | — | `visited` |
  | mark no-show | `confirmed` | `bookings.manage`, slot time passed | — | `no_show` (no refund) |
  | processing | `sample_collected` or `visited` | `bookings.manage` | — | `processing` |
  | upload report | `processing` | `reports.upload`; D1 file binding | — | stays `processing` (draft, partner-only) |
  | release report | `processing` | `reports.release`; releasing member's name + professional registration stamped on the report record | — | `report_ready` (customer can access released version) |
  | complete | `report_ready` | `bookings.manage` | — | `completed` (ledger earning created) |

  Every transition is a compare-and-set on the current state, records who (member) and when (`$min` lifecycle
  timestamps), and notifies the customer. Lab-initiated reschedule grants the customer a **durable full-refund
  entitlement** (stored on the booking, survives cutoff) until the customer explicitly accepts or cancels.
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
- **Doctor-wide reservation lock:** all booking paths (scheduled, instant, in-clinic) share a single
  `DoctorReservation { doctorId, bookingId, kind, expiresAt }` document with a unique index on `doctorId`. Acceptance
  of any booking type must claim this reservation atomically; scheduled slot holds also check it. The reservation
  prevents a doctor from accepting two instant requests, or an instant request overlapping a scheduled slot. Presence
  heartbeat (`PUT /presence`) must not overwrite `busy` state — it only refreshes `lastSeen` when the doctor is not
  in an active reservation.
- **Instant:** doctor toggles **"available now"** with modes and an `instantFee` (falls back to `consultationFee`);
  presence expires without a heartbeat (2 min) and on sign-out/busy.
- **Instant request lifecycle:**
  - **Price contract:** at request creation, the customer sees the specific doctor's `instantFee` (or a
    **quoted maximum fee** for "any available", computed from the highest fee among currently online doctors of the
    speciality). The customer pays the quoted amount upfront. The `InstantRequest` stores
    `{quotedAmount, quotedCurrency, fundingSource (payment/wallet/coupon breakdown)}`.
  - **Acceptance eligibility:** a doctor can accept only if their `instantFee <= quotedAmount`. On accept, the exact
    fee is charged; any difference (`quotedAmount − instantFee`) is **refunded to wallet immediately**. If the
    doctor's fee exceeds the quoted amount (fee changed between quote and accept), acceptance is rejected and the
    request re-enters the offer pool.
  - **Specific doctor:** offered to that doctor for **5 minutes**; the offer carries an `offerGeneration` counter
    incremented on each re-offer. Accept must CAS on the current `offerGeneration` and `status: 'offered'`.
  - **Any available:** offered to all online doctors of the speciality; the **first accept wins** (CAS on
    `status: 'offered'` and `acceptedBy: null` atomically). The request stores `offerGeneration` so re-offers
    invalidate stale accepts.
  - **No accept in time** → the customer is shown other online doctors (re-offer increments `offerGeneration`) **or**
    asks for a refund (wallet; card/UPI on request). **Refund policy (owner decision):** never refunded automatically
    while the customer is actively choosing (UI heartbeat / screen visible); if the customer leaves it unanswered
    (no UI activity for 30 minutes from the last offer), refunded automatically. The 30-minute inactivity deadline
    is stored on the request (`inactivityRefundAt`); the customer can extend it by re-offering or choosing another
    doctor. This is not an explicit refund request — it is a safety net. The customer can always request an explicit
    refund at any time.
  - **Accept → booking (atomic):** in one transaction: (1) CAS the request `status: offered → accepted`,
    (2) claim the `DoctorReservation`, (3) create the consultation booking (`bookingKind: 'instant'`), (4) link
    `request._id → booking._id` (unique). If the transaction fails (doctor already reserved, request already
    accepted), the accept is rejected. A crash between steps is recovered by checking the unique
    `request→booking` link: if the booking exists, the accept succeeded; if not, the reservation is released.
    Meet link created for video/call; doctor marked busy via the reservation.
  - Completion feeds the doctor's **settlement account** (§7a).
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
  supply match; IGST otherwise. A GST tax invoice (with GSTIN on the document) is issued only when the partner has a
  verified GSTIN; without it, a bill of supply is generated. `gstRate` per item must be from the allowed set
  (validated, not arbitrary).
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
- **Payment is not collected by us:** a member with `payments.record` picks the mode, adds a reference/keyword and
  creates a payment event; it can be recorded once (CAS: no prior payment event exists for the invoice); reversal only
  by cancelling the invoice.
- **Walk-in linking:** if a phone number is given, it is resolved through a **shared race-safe customer identity
  resolver** (§6a). The invoice and any lab report released for that visit appear in the customer app under
  "Bills" / "Reports". In-house sales are **not** in the payout ledger (the money never passes through us) but are
  in the partner's sales reports.
- **PDF:** generated from the immutable invoice + its events (partner name/address/GSTIN, items, GST split, payment
  status from events), stored as a private file (D1) readable by the partner and the linked customer. The PDF is
  regenerated when a new event is recorded (payment or cancellation) — each version is a new file; prior versions
  remain accessible for audit.

### 6a. Shared race-safe customer identity resolver

Walk-in linking, partner OTP login, and any future path that needs to find-or-create a customer by phone share one
coordinated path: `resolveCustomerByPhone(phone, source)`.

1. Normalize the phone to E.164.
2. `findOneAndUpdate` with `{ phone, userType: 'user' }` and `$setOnInsert: { createdSource: source }`, `upsert: true`,
   `returnDocument: 'after'`. The unique index `{phone, userType}` prevents duplicates from concurrent calls.
3. If the upsert created a new user, send the SMS link.
4. Never merge accounts or overwrite an existing customer's name/verified-contact fields from invoice input.
5. The visit patient/dependent (age, gender on the invoice) is distinct from the billing contact (the linked
   customer account). Invoice `customer.userId` points to the resolved account; patient details stay on the
   invoice line.
6. SMS links are authenticated — they lead to the app's sign-in flow, not to a public document grant.

### 7a. Settlement accounts and doctor payout cutover

Every entity that can earn money through the platform has a **SettlementAccount**
`{ _id, ownerKind: 'partner'|'doctor', ownerId (partnerId or specialistId), bankDetails?, isActive }`.

- A **partner** gets a settlement account when created by an admin.
- A **doctor** gets a settlement account when they first receive a paid consultation (scheduled or instant). A
  tele-only doctor who never enables in-clinic billing has a settlement account without a Partner — the solo
  practice Partner is created only when in-clinic billing is enabled (§3).
- A **clinic partner** earns from lab bookings and in-house invoices. When a consultation at a clinic completes, the
  earning goes to the **doctor's** settlement account (the doctor is the service provider). The clinic may charge a
  facility fee in the future (deferred); for now, clinic partners earn only from their own lab/invoice services.
- Each online booking/payment snapshots `{ settlementAccountId, beneficiaryName }` at creation time. Historical
  earnings are never re-derived from current membership.

**Doctor payout cutover (required before Q4 earnings):**
- The existing `payouts` module (`payouts/services/index.ts`) selects paid, non-cancelled specialist consultations
  and runs a separate billing/disbursal path.
- Before Q4 activates any new doctor earning on the ledger, Q3 must: (1) import all historical disbursals from the
  old `payouts` system as `payout` ledger entries with `source: 'legacy_import'`; (2) mark each imported booking as
  `legacySettled: true`; (3) exclude `legacySettled` bookings from the old payout recalculation query.
- From that point forward, every new doctor earning goes exclusively to the ledger. The old payout calculation still
  runs for bookings created before the cutover date but not yet settled.
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
current membership. Walk-in customer identity is resolved through a single race-safe path with uniqueness fence (§6a).
Instant-request acceptance is atomic with doctor reservation and booking creation (§5); price contract is frozen at
request time.

## 9. Not in scope now (recorded)

Commission/platform fees (fields kept at 0); subscriptions for partners; automated bank payouts; credit notes; lab API
integrations for new partners; inventory of lab consumables; insurance/corporate billing for partners.

## 10. Packets

| Packet | Content |
|---|---|
| **Q1** Partner foundation | Partner (with `ownerCount`), Branch, Member, permissions (delegation ceiling), OTP `partner` login + membership admission, admin onboarding, workspace "Partner" shell with staff & branch management |
| **Q2** In-house invoices | Catalogue (minimal), immutable invoices (integer paise, GST split by place of supply, CBIC-compliant serial ≤16 chars) + InvoiceEvents (payment/cancel), PDF, shared customer identity resolver (§6a), walk-in linking + SMS, customer "Bills" |
| **Q3** Partner-lab online bookings | Settlement accounts + doctor payout cutover (§7a), lab catalogue + server-owned slots (unique identity, hold-preserving edits), executable state machine (§4), customer search & booking & payment (explicit `lab_booking` adapters, pay-again, expiry), lab booking management, report upload/release (draft→released, §4), customer "Reports", ledger earnings/refunds |
| **Q4** Doctors | Doctor-wide reservation lock (§5), weekly template, leave, per-mode/per-clinic slots, cancel fix, no-show; instant consultations (presence, price contract + quoted max, offer generation/deadline, atomic accept→reservation→booking, re-offer, inactivity refund); customer "Consult now" |
| **Q5** Payouts | Ledger statements, admin payout recording, partner finance screens |
| **Q6** Clinics | Clinic partners with several doctors, clinic front desk booking/invoicing per doctor, solo practice auto-creation |

Each packet: backend + workspace/customer screens + tests (integration + browser) + Codex review; design questions
that are the owner's go to the owner.
