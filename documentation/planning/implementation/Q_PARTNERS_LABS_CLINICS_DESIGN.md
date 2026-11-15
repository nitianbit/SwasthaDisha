# Q — Partner labs, clinics and doctors: online bookings, instant consultations, in-house sales (design, 2026-11-15)

Status: design for review before implementation. Built in packets Q1–Q6 (§10), each reviewed by Codex.

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
  extra slots) with a capacity per slot. Booking takes a seat with a **conditional** `$inc` (`booked < capacity`) in
  the booking's transaction; cancel/reschedule return it exactly once (same seat-hold pattern as A2a).
- **Customer booking (through us):** customer app lists partner labs next to Healthians/LabStack (by area); picks
  tests/package, visit mode, address (home), slot, patient (self/family). Payment via the existing payment module
  (`context: 'lab_booking'`, Razorpay + wallet + coupon rules as bookings), once-only create with a request key, P8-style
  pay-again within the payment window, 30-minute expiry of unpaid bookings (as D2).
- **Booking states (explicit transition table):** `pending_payment → confirmed → (sample_collected | visited) →
  processing → report_ready → completed`; side exits `cancelled` (customer before cutoff / lab reject / payment
  timeout), `no_show`; `rescheduled` is an action (new slot, same booking). Every transition is a compare-and-set on the
  current state, records who (member) and when (`$min` lifecycle timestamps), and notifies the customer.
- **Lab actions** (permissions): confirm/assign collector; reject (full refund, reason shown); reschedule (customer
  notified; customer may cancel for a full refund); mark collected/visited; mark no-show; upload report (PDF/images, D1
  file binding to the booking); **release** report (`reports.release`; the releasing member's name and professional
  registration are stamped).
- **Refunds:** wallet first, card/UPI on request (P2 path), exactly once.

## 5. Doctors: scheduled and instant

- **Scheduled (existing, fixed):** weekly template expanded into slots (rolling 30 days), leave days, per-mode slots
  (video/call/chat/in-clinic) and per-clinic slots (`branchId`); conditional seat counters; fix the portal cancel
  (dedicated cancel command with refund); add `no_show`.
- **Instant:** doctor toggles **"available now"** with modes and an `instantFee` (falls back to `consultationFee`);
  presence expires without a heartbeat (2 min) and on sign-out/busy.
- **Instant request:** customer chooses a specific online doctor **or** "any available" in a speciality; pays upfront.
  - Specific doctor: offered to that doctor for **5 minutes**.
  - Any available: offered to all online doctors of the speciality; the **first accept wins** (compare-and-set on the
    request).
  - No accept in time → the customer is shown other online doctors (re-offer to one, or "any available") **or** asks for
    a refund (wallet; card/UPI on request). Never refunded automatically while the customer is choosing; refunded
    automatically only if the customer leaves it unanswered for 30 minutes.
  - On accept: a consultation booking is created (same booking model, `bookingKind: 'instant'`), Meet link for
    video/call, doctor marked busy; completion feeds the doctor's ledger.
- **Customer app:** "Consult now" (online doctors, speciality filter, any-available) and "Book an appointment"
  (existing flow).

## 6. In-house sales (labs, clinics, doctors)

- **Invoice** `{ partnerId, branchId, number, financialYear, issuedAt, customer {name, phone?, userId?, age?, gender?},
  doctorId? (clinic invoices name the doctor), items[{catalogItemId?, description, qty, unitPrice, discount, gstRate,
  sac?, amount}], totals {subtotal, discount, taxable, cgst, sgst, igst, total}, status: issued|paid|cancelled,
  payment? {mode: cash|upi|card|bank|other, reference?, note?, recordedBy, recordedAt}, cancel? {reason, by, at},
  createdBy, checksum, idempotencyKey }`.
- **Numbering:** `<PREFIX>/<FY>/<0001>` sequential per partner and financial year — an atomic counter
  (`findOneAndUpdate $inc`) in the same transaction as the invoice insert; no gaps from failed writes.
- **Issued invoices are immutable** (corrections = cancel with reason + new invoice; credit notes later).
- **Payment is not collected by us:** a member with `payments.record` picks the mode, adds a reference/keyword and
  marks it paid; it can be recorded once (compare-and-set issued→paid); reversal only by cancelling the invoice.
- **Walk-in linking:** if a phone number is given, it is linked to an existing customer or a new customer account is
  created (`createdSource: 'partner_walkin'`); an SMS link is sent; the invoice (and a lab report released for that
  visit) appears in the customer app under "Bills" / "Reports". In-house sales are **not** in the payout ledger (the
  money never passes through us) but are in the partner's sales reports.
- **PDF:** generated from the stored invoice (partner name/address/GSTIN, items, GST split CGST+SGST or IGST by place of
  supply, payment status), stored as a private file (D1) readable by the partner and the linked customer.

## 7. Ledger and payouts (money collected online by us)

- **Ledger entries** per partner (append-only): `earning` (booking/consultation completed: amount, commission 0,
  net), `reversal` (refund after earning), `payout` (admin-recorded bank transfer: amount, reference, date, proof),
  `adjustment` (admin, with reason). Balance = Σ entries; idempotent per source (unique `{source, sourceId, kind}`).
- Doctors' existing `payouts` billing is migrated onto the same ledger (or kept and bridged; decided in Q5 review).
- Partner "Finance" screen: balance, statement, payouts; admin "Payouts" queue to record transfers.

## 8. Security and integrity

Tenancy is always `partnerId` from the admitted membership (never from the request); branch scoping by `branchIds`;
every action checks a permission; all state changes are compare-and-set; money moves in transactions with exactly-once
keys; file access through D1 bindings; audit trail on every partner action (who, when, what); rate limits on partner
OTP as O1.

## 9. Not in scope now (recorded)

Commission/platform fees (fields kept at 0); subscriptions for partners; automated bank payouts; credit notes; lab API
integrations for new partners; inventory of lab consumables; insurance/corporate billing for partners.

## 10. Packets

| Packet | Content |
|---|---|
| **Q1** Partner foundation | Partner, Branch, Member, permissions, OTP `partner` login + membership admission, admin onboarding, workspace "Partner" shell with staff & branch management |
| **Q2** In-house invoices | Catalogue (minimal), invoices with GST + series + PDF, record payment (mode/reference), cancel, walk-in linking + SMS, customer "Bills" |
| **Q3** Partner-lab online bookings | Lab catalogue + slots (home/lab), customer search & booking & payment (pay-again, expiry), lab booking management, report upload/release, customer "Reports", ledger earnings/refunds |
| **Q4** Doctors | Weekly template, leave, per-mode/per-clinic slots, cancel fix, no-show; instant consultations (presence, request/offer/accept, re-offer, refund); customer "Consult now" |
| **Q5** Payouts | Ledger statements, admin payout recording, partner finance screens; doctor payouts on the ledger |
| **Q6** Clinics | Clinic partners with several doctors, clinic front desk booking/invoicing per doctor, solo practice auto-creation |

Each packet: backend + workspace/customer screens + tests (integration + browser) + Codex review; design questions
that are the owner's go to the owner.
