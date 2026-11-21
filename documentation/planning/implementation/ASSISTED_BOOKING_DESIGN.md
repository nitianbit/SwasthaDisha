# Assisted booking: partners book for walk-in patients (design, 2026-11-22)

Status: **design only, nothing built.** Owner decisions of 21 Nov 2026 (asked directly) are requirements, not choices made
here. Built after the gates in [AGENTS.md](../../../AGENTS.md) and the established rules of
[Q_PARTNERS_LABS_CLINICS_DESIGN.md §11](Q_PARTNERS_LABS_CLINICS_DESIGN.md). Capability rows: C02 (assisted booking,
Partial) and C11 (partner-paid consultations, Missing) in [CAPABILITY_MATRIX.md](../CAPABILITY_MATRIX.md).
Assumes hotfix **S2** (over-exposure of the generic `/bookings` reads) has shipped.

## 1. In plain words (for the owner)

Many people in rural areas and the north-east have no app, no smartphone, or one phone for the whole family. A
pharmacy, a lab or a doctor becomes their door to Jansetu:

1. The partner types the patient's mobile number. If an account exists, it sees the account holder's name and asks how
   the patient is related to them (self, mother, son …). If not, Jansetu quietly opens an account for that number.
2. The partner picks the service (doctor consultation or lab test), the time and place, asks the patient's preferred
   language, and ticks "patient agreed".
3. **The partner pays Jansetu straight away**, from its Jansetu wallet or by Razorpay. It collects from the patient at
   its own counter, at whatever price it chooses.
4. Doctor and lab do their work as for any booking and earn their normal amount. The partner earns a **referral cut**
   that shows in its payouts.
5. The booking partner sees the prescription or the lab report of the booking it made. A pharmacy can turn the
   prescription into a medicine order.
6. When anyone later signs in to the app with that mobile number (OTP), they see every booking, prescription and
   report of the family.
7. SMS messages (booking confirmed, prescription ready, report ready, reminder) go out in the patient's language when
   a template exists. An SMS can never stop or undo a booking.

A lab also gets a **front desk for its own tests** (like the clinic desk): the patient pays the lab, Jansetu takes no
money, and the report goes to the patient's app.

## 2. Owner decisions (21 Nov 2026) and the earlier phone proposal

| # | Decision (requirement) | Where it differs from [PHONE_CONSULTATIONS.md](../PHONE_CONSULTATIONS.md) v1.7 |
|---|---|---|
| 1 | Bookers: pharmacy → consultation and lab test; lab → consultation; doctor → lab test, or recommends tests in the prescription for the patient/pharmacy/lab to book later; lab front desk for its own tests (paid at the lab) | The phone doc covers an IVR helpline with PIN; none of that (IVR, PIN, call bridging) is in this scope |
| 2 | Identity by phone number only; one phone serves a family; existing account → show holder's name, ask relation, book as family member; new number → internal account, visible after OTP sign-in; ask preferred language, consultations too | v1.7 treats the phone as a lookup hint, never identity, and requires independent contact verification (AR-25). The owner chose phone identity; the account stays `otpVerified: false` until its owner signs in |
| 3 | Consent: no OTP; the partner ticks "patient agreed" | v1.7 required patient-held proof; here the partner's attestation is recorded and audited |
| 4 | Every assisted booking is paid at booking time by the partner (wallet or Razorpay); never pay-later, never the patient's wallet; doctor booking a lab test pays the same way | Matches v1.7's "Partner-paid consultation" funding model (P1 option 1), extended to labs and doctors; no patient balance is created |
| 5 | Pharmacy, lab and doctor each have a Jansetu wallet: Razorpay top-up, pay bookings, receive refunds | v1.7 called lab/hospital wallets unsupported; now required |
| 6 | Refund goes back the way the partner paid (Razorpay or wallet) | Same principle as v1.7 (refunds keep their funding reference) |
| 7 | Referral cut per partner and category (consultation, lab test, package), % or fixed, set at partner setup, shown in payouts; providers still earn their normal amount | v1.7: "referral attribution … does not automatically create commission". The owner now wants a cut |
| 8 | Booking pharmacy sees the prescription; booking partner (doctor or pharmacy) sees the lab report; patient sees everything | v1.7: documents only "under the relevant patient authority". The booking plus the tick is that authority, limited to the bookings the partner made |
| 9 | A prescription reaching the booking pharmacy can optionally become a medicine order (existing pharmacy orders) | New |
| 10 | Call/video on the partner's device ("Join call") or on the patient's/family's number given at booking | v1.7 used telephony bridging; here Google Meet (existing) or the doctor calls the number |
| 11 | SMS: confirmed, prescription ready, report ready, reminder; DLT templates; `.env` id + on/off per message; never affects a booking; patient's language when a template exists | Same "minimal content on a shared phone" rule as v1.7 |
| 12 | Languages: Hindi, English, Odia, Bengali, Mizo, Assamese and other NE languages; users and partners switch the whole UI | Separate workstream (phase 6) |

Reused from v1.7: server-derived price (never `req.amount`), payer kept separate from beneficiary, one charge per
operation with an idempotent result, minimal SMS content, no per-minute charging, and the RBI closed-system question
(§13).

## 3. Current state

| Area | What exists | Gap for assisted booking |
|---|---|---|
| Pharmacy creates a consultation | Generic `POST /bookings` and `/bookings/specialist`: a pharmacy must send `userId`; `pharmacyId` comes from its token (`bookings/controller/index.ts:157-189`, routes `bookings/routes/index.ts:31-42`) | No booking screen for the pharmacy; the family-member check runs only for customer callers (`controller:52-64`), so a pharmacy-sent `dependentId` is not checked against the account |
| Money of a pharmacy-made booking | `finishCreate` funds from the **patient's** wallet and opens a Razorpay order owned by the **patient** (`bookings/services/index.ts:871-966`); cancellation refunds to the **patient's** wallet (`bookings/holds.ts:284` `settleMoney`, `:311`) | Contradicts decisions 4 and 6 |
| Unpaid expiry | Unpaid priced bookings are cancelled after 30 min, after reconciling with Razorpay (`bookings/services/index.ts:1741-1777`) | A pharmacy that cannot pay on the spot loses the booking: bug cause 2 |
| Pharmacy wallet | Balance, history, Razorpay self top-up (`pharmacyWallet/routes/index.ts:13-24`; credit on capture `payment/services/index.ts:1488-1582`). `payConsultation` debits in one transaction with a paid-state guard but is **unrouted**, trusts `req.amount` and has no request key (`pharmacyWallet/services/index.ts:153-279`). Amounts in rupees with a paise mirror (`pharmacyWallet/model/index.ts:4-56`) | Needs a server-priced, keyed route; labs and doctors have no wallet |
| Customers by phone | Race-safe `resolveCustomerByPhone` with sources `partner_invoice` and `clinic_desk` (`partners/services/customerResolver.ts:64-93`). Pharmacy customers use an older path that is not race-safe and overwrites `linkedPharmacyId` (`pharmacyCustomers/services/index.ts:21-81`) | Add source `assisted_booking`; pharmacies move to the resolver |
| Clinic desk (pattern to copy) | `createDeskAppointment`: request key per desk member with content hash, family member existing or created in the booking transaction, audit in the transaction, notices after commit, `settlementSystem: 'clinic'` (`partners/services/clinic.ts:477-610`) | Lab desk and assisted bookings follow it |
| Partner lab bookings | Customer-only create; `userId` is the caller; price fence `acceptedPayableMinor`; refunds through the customer-wallet ledger (`partners/services/labBookings.ts:165-227`, `:436-448`); earning on completion, commission 0 (`:640-648`) | Needs a booker and partner funding |
| Prescription | Doctor writes it; the server renders `bookings/<id>/prescription-<ts>.pdf` (`specialistPortal/services/index.ts:328-397`, `:472-512`); tests advised are free text (`bookings/model/index.ts:107`) | No notice to anyone; no structured test recommendation |
| File access | `canReadBooking` lets a pharmacy whose `pharmacyId` matches read **every** file of the booking (`file/access.ts:34-45`); partner lab reports: patient or partner member only (`:80-89`); attaching a file needs uploader authority (`:294-299`), and `PharmacyOrder.prescriptionUrls` is such a field (`:458`) | Booker access is too broad for consultations and missing for lab reports. The server-written prescription PDF has no uploader, so a pharmacy cannot attach it to an order: bug cause 3 |
| Meet links | Created for paid call/video bookings; **fail when the patient has no email** (`meet/service/index.ts:465-470`) | Walk-in patients have no email |
| Settlement ledger | Accounts `ownerKind: 'partner' \| 'doctor'` (`partners/model/settlement.ts:18-44`); entries `earning/reversal/payout/adjustment`, exactly once per (account, source, sourceId, kind) (`:75-110`, `partners/services/settlement.ts:51-80`); doctor earning on completion (`doctors/services/earnings.ts:15-28`) | No pharmacy account; no referral source |
| SMS | Types `otp` and `partner_bill` only; GET with **no timeout**; throws on failure (`sms/services/index.ts:13`, `:63-111`); the bill notice is sent after commit and swallowed (`partners/services/invoice.ts:466-474`) | No queue, no language, no per-message switches |
| Background jobs | Mongo `Job` queue with `uniqueId` de-duplication (`queue/model/index.ts:4-16`), used by booking reminders | Reused for SMS |
| Languages | No language field on users, family members, members or pharmacies; doctors have spoken `languages` (`specialists/model/index.ts:113`) | New fields |
| Payments | Contexts enum (`payment/model/index.ts:21`); per-context handler registry (`payment/services/index.ts:110-112`); Razorpay refund-to-source worker for Rx orders (`pharmacyOrders/prescriptionRefund.ts:45-110`) | New contexts and a partner refund worker (reuse) |
| Cancellation window | Applies to customers only (`common/utils/cancellationWindow.ts:92`) | Partner window to decide (§12) |

**The pharmacy prescription bug, in short:** (1) there is no pharmacy screen listing the bookings it made, (2) an
unpaid booking is cancelled after 30 minutes, and (3) the prescription PDF cannot be attached to a pharmacy order.
The file itself is already readable by that pharmacy (`file/access.ts:41`). Phase 0 fixes all three.

## 4. Terms

| Term | Meaning |
|---|---|
| **Booker** | The partner that makes and pays the booking: a pharmacy (`userType: 'pharmacy'`), a lab (`PartnerOrg.kind: 'lab'`, through a member), or a doctor (`specialist`) |
| **Provider** | The doctor or lab who delivers the service and earns its price |
| **Account holder** | The customer account of the phone number (`User`, `userType: 'user'`) |
| **Patient** | The account holder ("self") or one of their family members (`Dependent`) |
| **Assisted booking** | A consultation (`Booking`) or partner-lab booking (`PartnerLabBooking`) made and paid by a booker |
| **Lab desk booking** | A lab's own test booked at its counter and paid at the lab; no Jansetu money |

## 5. Data model changes

All money in new fields is **integer paise** (`…Minor`). Consultation prices stay in rupees on `Booking` (Q14
decision 5) and are converted once with `Math.round(rupees × 100)` when snapshotted.

### 5.1 Who booked: the `assisted` block

One optional subdocument, identical on `Booking` (consultations) and `PartnerLabBooking`, plus a top-level `source`.

| Field | Type | Notes |
|---|---|---|
| `source` | `'self' \| 'pharmacy_assisted' \| 'lab_assisted' \| 'doctor_assisted' \| 'clinic_desk' \| 'lab_desk'` | Absent means `self` (no migration). Indexed with the booker |
| `assisted.bookedBy` | `{ kind: 'pharmacy' \| 'lab' \| 'doctor', id, branchId?, actorKind: 'pharmacy' \| 'member' \| 'admin' \| 'specialist', actorId, name }` | `id` = pharmacyId / partnerId / specialistId, from the admitted actor, never the body. `branchId` for labs (the member's branch where the patient came). `name` is a display snapshot |
| `assisted.consent` | `{ method: 'partner_attested', statementVersion, statementLanguage, at, actorId }` | Required; create without it is 400 `CONSENT_REQUIRED` |
| `assisted.preferredLanguage` | language code (§11.1) | Required; drives SMS; a hint for doctor choice |
| `assisted.join` | `{ on: 'partner_device' \| 'patient_phone', phone? }` | Consultations in `call`/`video` mode only. `phone` (10 digits) is the number the doctor calls, copied to `contactNo` |
| `assisted.funding` | `{ method: 'partner_wallet' \| 'partner_razorpay', payerKind, payerId, amountMinor, state, walletEntryId?, paymentRecordId?, refund? }` | `state`: `pending → paid → refund_pending → refunded`, or `paid` kept on no-show. `refund`: `{ method, amountMinor, state, walletEntryId?, razorpayRefundId?, attemptId?, at }` |
| `assisted.referral` | `{ ruleId, ruleVersion, lines: [{ category, basis, value, baseMinor, amountMinor }], amountMinor, settlementAccountId, beneficiaryName, state: 'expected' \| 'earned' \| 'none' }` | Snapshotted at create (§8.5). Absent when no rule applies |
| `assisted.recommendationId` | string | When booked from a doctor's test recommendation (§7.6) |
| `assisted.requestKey`, `assisted.requestHash` | strings | Unique partial index on `assisted.requestKey` (stored as `assisted:<kind>:<bookerId>:<actorId>:<key>`, as desk keys) |

Kept: `Booking.pharmacyId` is still set for pharmacy bookings, so existing readers keep working. Assisted
consultations are always stamped `settlementSystem: 'ledger'` at the single insert (`bookings/holds.ts:262-269`),
whatever `SETTLEMENT_CUTOVER_AT` says, so the doctor's earning and the referral post in one ledger. Q4a is on stage.

Indexes: `{ 'assisted.bookedBy.kind': 1, 'assisted.bookedBy.id': 1, createdAt: -1 }` on both collections. Enums
extended: `User.createdSource` gets `assisted_booking` (`user/model/index.ts:161-166`); the resolver's `source` union
the same; payment `context` gets `assisted_booking` and `assisted_lab_booking`; settlement `ownerKind` gets `pharmacy`;
`PartnerLabBooking.settlement.settlementSystem` gets `lab_desk`.

### 5.2 Patient language and profile language

| Model | New field | Set by |
|---|---|---|
| `User` | `preferredLanguage` (care and SMS), `uiLanguage` (app screens) | Assisted booking sets `preferredLanguage` only when it is empty; the user changes both in the app |
| `Dependent` | `preferredLanguage` | Set when a booking creates the family member; later bookings may change it on the booking only |
| `PartnerMember`, `Pharmacy`, `Specialist`, admin `User` | `uiLanguage` | The person, in the language switcher (§11) |

`Specialist.languages` (spoken) is unchanged. The booking screen shows doctors who speak the patient's language first.

### 5.3 Partner wallets

| Owner | Storage | Why |
|---|---|---|
| Pharmacy | Existing `pharmacy_wallets` / `pharmacy_wallet_transactions` (live balances; no migration) | A money migration of live balances is a risk with no benefit now |
| Lab partner, doctor | New `partner_wallets { ownerKind: 'lab' \| 'doctor', ownerId, balanceMinor ≥ 0, version, isActive }` (unique `{ownerKind, ownerId}`) and `partner_wallet_entries { walletId, kind: 'topup' \| 'booking_debit' \| 'refund_credit' \| 'adjustment', amountMinor (signed), balanceAfterMinor, operationKey (unique), ref { kind, id }, by, byKind, at }` | Paise only from day one |

Both sit behind one `BookerWallet` interface (`debitForBooking`, `creditRefund`, `creditTopup`, `balance`,
`statement`) with the same rules:

- A debit is a conditional `$inc` (`balance ≥ amount`) inside the booking's transaction, with its entry and a unique
  `operationKey` (`assisted:<bookingId>:debit`). Insufficient balance is 409 `INSUFFICIENT_BALANCE`. Nothing is
  debited outside a booking transaction.
- A top-up opens a Razorpay order (`context: 'wallet_recharge'`, payer = the booker). The wallet is credited once on
  verified capture (`operationKey: wallet_recharge:<paymentRecordId>`). This is the pharmacy path
  (`payment/services/index.ts:1488-1582`) generalized with `payerPartnerId` / `payerSpecialistId`.
- A refund credit has `operationKey: assisted:<bookingId>:refund`.
- No cash-out, transfer or patient spending (closed loop; see §12 and §13). Admin corrections are signed `adjustment`
  entries with a reason, as Q5 adjustments are.
- Each wallet document carries a `version` that every movement bumps, so a statement reads a consistent balance.

### 5.4 Referral rules and earnings

`referral_rules { bookerKind: 'pharmacy' | 'lab' | 'doctor', bookerId, category: 'consultation' | 'lab_test' |
'lab_package', basis: 'percent' | 'fixed', percentBasisPoints?, fixedMinor?, capMinor?, isActive, version, updatedBy,
updatedAt }`, unique `{bookerKind, bookerId, category}`, plus an append-only `referral_rule_events` history.

- **Admin only.** Rules are set in the admin screens that create or edit a pharmacy, a lab partner or a doctor (the
  owner's "while setting up the partner"). Partners see their rules read-only. Edits carry `expectedVersion`; a stale
  one is 409 `RECORD_CHANGED`.
- A rule change affects **new bookings only**: the booking snapshots the rule at create (§5.1).
- Earnings are ordinary `ledger_entries` (§8.5) on the booker's `SettlementAccount`. The pharmacy gets
  `ownerKind: 'pharmacy'`, created idempotently before the first snapshot, as doctor accounts are (§7a).

### 5.5 Lab desk bookings

A `PartnerLabBooking` with `source: 'lab_desk'` and a `desk { memberId, branchId, requestKey, requestHash, arrivedAt? }`
block (the clinic-desk shape, `bookings/model/index.ts:452-463`):

- `settlement.settlementSystem: 'lab_desk'`; no settlement account, `paymentStatus` stays `pending`, no
  `paymentDeadline`.
- `pricing` is snapshotted from the lab's catalogue so the bill can be issued from it.
- `slot` is either a real slot (a seat is taken) or `{ walkIn: true, startsAt: now }` (no seat), for a patient tested
  at once.
- Guards: pay-again, wallet and gateway refuse it (409 `PAY_AT_LAB`), the expiry sweep skips it, earnings never post,
  a customer cancellation refunds nothing, and the legacy and ledger payouts exclude it.
- The lab bills with its own Q2 invoice, linked by `labBookingId`, mirroring the bill-appointment link of Q14
  decision 8 (at most one open bill per lab booking).

### 5.6 Test recommendations

`test_recommendations { _id, code, consultationId, specialistId, userId, dependentId?, items: [{ name, code?, note? }],
status: 'open' | 'partly_booked' | 'booked', bookings: [{ labBookingId, itemNames[] }], createdAt }`.

- Created when the doctor saves a prescription that lists recommended tests.
- `code` is a short random reference (8 characters, check digit, e.g. `RT-7K4Q-2M`) printed on the prescription PDF.
- `prescription.testsAdvised` (strings) stays filled for older readers.

## 6. Building blocks shared by every flow

### 6.1 Booker actors and permissions

| Booker | Sign-in and admission | Permission |
|---|---|---|
| Pharmacy | `requireOperationalPharmacy`; `pharmacyId` from the token | Every operational pharmacy (single login) |
| Lab | Partner workspace member, loaded from the DB on every request (Q1); admin-as-owner mirror registered automatically (§11 row 1) | New `assisted.book` (book for walk-ins, see those bookings, their prescriptions and reports); new `wallet.view` and `wallet.manage` (top up). Delegation ceiling and branch scope as §3 |
| Doctor | `specialist`, active and verified | Own login; the wallet is the doctor's, not the clinic's |

Every assisted mutation writes an audit event in the same transaction: `PartnerAuditEvent` for lab members, and a new
`assisted_audit_events` (actor kind/id, action, booking) for pharmacies and doctors. Prescription and report **reads**
by bookers are logged after the read, best effort.

### 6.2 Find or create the patient (one shared step)

1. `POST …/assisted/patients/lookup { phone }` → `{ exists, holderName }`. Nothing else is shown: no family list, no
   bookings, no "has signed in", following the Q14 review rule that the desk is not told who is on a family list.
   Rate-limited per actor (default 60 an hour) and audited.
2. The partner chooses the patient:
   - **self**, or
   - a relation `{ name, relation, gender?, dateOfBirth? }` (relations from the dependents list without "Me").
3. Inside the booking transaction, exactly as the clinic desk does (`partners/services/clinic.ts:548-575`):
   - `resolveCustomerByPhone(phone, 'assisted_booking')` finds or creates the account (never merged or overwritten;
     the name is set only when empty);
   - an active family member with the same name and relation is reused, otherwise one is created with a pre-chosen id;
   - a pharmacy booker also gets its `pharmacy_customers` link (`ensureLinked`), so its CRM keeps working.
4. A **new** number must be typed twice on the screen. The answer then says `newAccount: true`, so a wrong number is
   noticed at once (§14).
5. When the account exists, the patient is booked as that account's family member (or as the holder). The bookings
   appear under that account.

### 6.3 Request keys, hash and fences

- Every create carries `requestKey` (`[A-Za-z0-9_-]{8,100}`), stored per booker actor and claimed in the booking
  transaction (`claimRequestKey`, `requestKeys/index.ts:27-48`; new `OnceOnlyKind`s `assisted_consult_create`,
  `assisted_lab_create`, `lab_desk_create`).
- `requestHash` = sha256 of `canonicalJson` (`common/utils/canonicalJson.ts`) over:
  - the canonical phone and the patient identity;
  - the service: doctor + slot + mode + join, or lab + branch + sorted item ids + visit mode + slot + address;
  - `preferredLanguage`, `recommendationCode` and `notes`.

  The payment method is **not** part of the request identity (Q3 rule): a resend continues the same booking's
  payment.
- Same key and same hash: 200 with the stored booking, `replayed: true`, and nothing sent again. Different hash: 409
  `IDEMPOTENCY_KEY_REUSED`. Abandoned key: 409 `REQUEST_ABANDONED`. `GET …/by-key/:key` and
  `POST …/by-key/:key/abandon` recover a lost answer (Q13 pattern).
- Price fence: the screen sends `acceptedPriceMinor`. A different server price is 409 `PRICE_CHANGED` (Q9 pattern).
  The price is always derived on the server from the doctor's fee or the lab catalogue, with no coupons (§12).
- Later steps (pay again, cancel, accept a lab reschedule) carry `expectedUpdatedAt` (consultations) or
  `expectedVersion` (lab bookings), refusing stale views with 409.

### 6.4 Paying (the partner pays at booking time)

The booker pays with **one method per booking**, either its wallet or Razorpay, never split between them. That keeps
"refund the way it was paid" exact.

| Method | What happens |
|---|---|
| Wallet | **One transaction:** request key claim, slot seat and doctor interval (`createBookingWithHolds`, which already takes an in-transaction callback, `bookings/holds.ts:214`) or lab seat (`takeSeat`), insert as `confirmed` + `paid`, wallet debit + entry, referral snapshot, audit. Either all of it commits or none. Nothing can expire |
| Razorpay | The booking is inserted `pending_payment` with the seat held (as today). A Razorpay order opens with context `assisted_booking` / `assisted_lab_booking`, payer = the booker, and payment record `userId` = the booker principal, **never the patient**. The payment completes on the partner's device. A handler registered in `CONTEXT_HANDLERS` confirms it on verified capture, idempotently. Pay-again on the same booking within 30 min, also switching to the wallet. Unpaid after 30 min → expired by the existing sweep (reconcile first). A late or losing capture is refunded **to its source** (§8.4) |

Assisted bookings never touch the customer-wallet ledger (`walletFunding`). The generic `/bookings/:id/retry-payment`,
`fundBookingFromWallet` and the customer cancellation path refuse them with 409 `PARTNER_PAID_BOOKING`. After phase 1,
pharmacies can no longer create through the generic `POST /bookings*` (403 `USE_ASSISTED_BOOKING`), once the web
screen has switched.

### 6.5 Notices after commit

- In-app notices reuse the existing ones: the patient (account holder, naming the family member) and the provider (doctor
  `specialist_new_booking` / lab notifier). The provider's notice says "booked by <partner> for a walk-in patient" and
  how to join.
- Idempotency keys: `assisted:<booking>:<event>[:<version>]:<audience>`. A replay sends nothing.
- The booker's own list shows badges ("prescription ready", "report ready") worked out from booking state, so it needs
  no new notification channel.
- SMS: §10.

### 6.6 How the consultation happens (decision 10)

| Mode | `join.on = partner_device` | `join.on = patient_phone` |
|---|---|---|
| `video` | The partner app shows **Join call** (the booking's Meet `joinUrl`) from 10 min before the slot to its end | The patient signs in to the app with the account number and taps Join (default; §12 Q12) |
| `call` | The doctor phones the partner's counter number (`contactNo` = partner phone) | The doctor phones the number given at booking (`contactNo` = `join.phone`, any 10-digit family number) |
| `in-person` | Not used (a doctor's in-clinic slot; the patient goes to the clinic) | Not used |

Meet change: for assisted bookings the Meet attendees are the doctor plus the booker's contact email (pharmacy email,
member email, or none). A missing patient email no longer blocks the link (`meet/service/index.ts:465-470`). Whether
an uninvited guest can "ask to join" depends on the Workspace settings and must be checked in phase 1 (§14).

## 7. Flows by booker

Every flow uses §6.2–6.6. The table rows are the owner's required steps.

### 7.1 Pharmacy → doctor consultation

| Step | Detail |
|---|---|
| Patient | Lookup by phone → self or relation; language; consent tick |
| Service | Doctor list (speciality, patient's language first, fee); date slot; mode `video` / `call` / `in-person`; join choice |
| Pay | Pharmacy wallet (existing; `payConsultation` replaced by the keyed, server-priced transaction of §6.4) or Razorpay |
| Notices / SMS | Patient and doctor in-app; SMS "booking confirmed" and the reminder; "prescription ready" when the doctor saves it |
| Pharmacy sees | Its booking list: status, slot, Join call, then the prescription (structured + PDF). Option **Create medicine order** (§9.3) |
| Patient later sees | After OTP sign-in: the consultation under Bookings (for the family member), "Booked by <pharmacy>", the prescription |

API: `POST /api/v1/pharmacy-assisted/consultations`, `GET /pharmacy-assisted/bookings`,
`GET /pharmacy-assisted/bookings/:id`, `POST /pharmacy-assisted/bookings/:id/pay`,
`POST /pharmacy-assisted/bookings/:id/cancel`, and the by-key routes.

### 7.2 Pharmacy → lab test

| Step | Detail |
|---|---|
| Patient | As 7.1 |
| Service | Partner lab near the patient → branch → tests/packages → visit mode (home: address required; lab visit) → slot (≥ 60 min ahead, Q3) |
| Pay | Pharmacy wallet or Razorpay; `PartnerLabBooking` gets the `assisted` block |
| Notices / SMS | Patient and lab in-app; SMS confirmed + reminder; "lab report ready" on release |
| Pharmacy sees | Status (collected, processing …), lab reschedule proposals (it may accept or cancel for a refund on the patient's behalf), the **released** report |
| Patient later sees | The lab booking and its report under Reports |

### 7.3 Lab → doctor consultation

As 7.1, done by a lab member holding `assisted.book`. `bookedBy.branchId` is the member's branch. The lab wallet or
Razorpay pays. The lab sees the prescription and, if it recommends tests, may book its **own** tests at its desk
(§7.5). A lab cannot book another lab's tests (not in decision 1).

### 7.4 Doctor → lab test

| Step | Detail |
|---|---|
| Patient | From one of the doctor's consultations (patient = that booking's account and family member; no lookup), or a walk-in by phone lookup (clinic patients). Language and consent as usual |
| Service | As 7.2 |
| Pay | Doctor wallet or Razorpay, same rules |
| Doctor sees | The booking's status and its released report, in the portal (`/specialists/me/assisted/lab-bookings`) |
| Earns | The doctor's referral cut on completion (legal caution: §14) |

### 7.5 Lab front desk (the lab's own tests)

| Step | Detail |
|---|---|
| Patient | Lookup → self or relation; language; consent |
| Service | The lab's own catalogue at a branch in the member's scope; a slot or "walk-in now" |
| Pay | **Paid at the lab** (`lab_desk`); the desk issues its Q2 bill linked to the booking. No Jansetu money and no referral cut |
| Steps | Existing lab steps (visit, processing, upload, release with signer, complete); no-show rules apply but nothing is refunded through us |
| Notices / SMS | Patient in-app; SMS confirmed (scheduled bookings), "lab report ready" |
| Patient later sees | The booking, the bill under Bills, the report under Reports |

API: `POST /partner-workspace/lab-desk/bookings` (`bookings.manage`, branch scope) plus by-key routes; the other steps
reuse the existing `/lab-bookings/:id/*` routes.

### 7.6 Doctor recommends tests

1. In the prescription form the doctor adds recommended tests (name, optional code, note). Saving the prescription
   creates the `test_recommendation` with its `code`. The PDF prints the code and the test names.
2. Booking it later:
   - **Patient (app):** "Recommended tests → Book" opens the partner-lab search with the names pre-filled. It is an
     ordinary customer lab booking, paid by the customer, with `recommendationId`.
   - **Pharmacy or lab:** enters the code and the patient's phone. On a match it gets **only the test names** (no
     diagnosis or medicines), then books through 7.2 (pharmacy) or the lab desk 7.5 (lab, its own tests).
3. Each booking records which items it covered. The recommendation shows `partly_booked` / `booked`. This is
   information only, never a lock.
4. Lab catalogues are each lab's own. The booker matches names to catalogue items by hand; a shared test-code list is
   later work.
5. Referral: only the partner that **books** earns. A doctor who only recommends earns nothing.

## 8. Money

### 8.1 Worked example (plain words)

Rules set for **Sharma Medicals**: consultation 10%, lab test 5%, package ₹40 fixed. Doctor's fee ₹500.

| Step | Sharma wallet | Doctor ledger | Sharma payouts ledger | Jansetu |
|---|---|---|---|---|
| Sharma tops up ₹2,000 by Razorpay | ₹2,000 | — | — | Holds ₹2,000 for Sharma (owes it as wallet balance) |
| Books Rina's video consultation; pays from wallet | ₹1,500 | — | — | ₹500 now earmarked for the doctor |
| Rina pays Sharma ₹600 at the counter (Sharma's own price) | — | — | — | Not Jansetu's money |
| Doctor completes the consultation | — | +₹500 earning | +₹50 referral (10% of ₹500) | Pays out ₹500 + ₹50 = ₹550 against ₹500 received: **costs Jansetu ₹50** |

Sharma's result: collected ₹600, paid ₹500, earns ₹50 → **+₹150**. Doctor: ₹500 as for any booking.

Lab example: a doctor books CBC (₹300) and a thyroid package (₹800) for a patient, from the doctor wallet. The
doctor's rules are lab test 5% and package ₹40, so the cut is ₹15 + ₹40 = ₹55. The lab earns ₹1,100 on completion,
the doctor ₹55.

| What happens next | Money |
|---|---|
| Cancelled in time / doctor or lab rejects | ₹500 back to the wallet (or to the card/UPI if paid by Razorpay). No earnings, no cut |
| Patient does not come (no-show) | Nothing back to the partner; the doctor is not paid; no cut; Jansetu keeps ₹500. The booking can be moved once; if it is then done, the doctor earns ₹500 and the partner ₹50 |

### 8.2 Wallet ledger

| Movement | Wallet | Ledger rule |
|---|---|---|
| Top-up (Razorpay captured) | + amount | Once per payment record; unknown/failed captures never credit |
| Booking paid from wallet | − price | Same transaction as the booking; once per booking |
| Refund to wallet | + refunded amount | Once per booking; only if paid by wallet, or by the partner's choice after a failed card refund |
| Admin adjustment | ± with reason | Audited; may not take the balance below 0 |

Invariant (checked daily, §8.8): balance = Σ entries; the pharmacy balance in paise equals `balancePaise`.

### 8.3 Partner payment for a provider's service

- Price = the provider's normal price at booking time: the doctor's `consultationFee` (a free follow-up the patient is
  entitled to stays free) or the sum of catalogue line prices. No coupons.
- Provider earning, unchanged (Q4a, Q3): doctor `originalPrice` on completion (`doctors/services/earnings.ts:15`), lab
  subtotal on completion (`labBookings.ts:640`), commission 0.
- A free (₹0) booking needs no payment and earns no cut.

### 8.4 Refunds by method

| Paid by | Refund route |
|---|---|
| Wallet | Credited to the same wallet **in the cancelling transaction** (`refund_credit`, once) |
| Razorpay | The cancelling transaction records `funding.refund { method: 'razorpay', state: 'pending', attemptId }`. A worker reusing the fenced Razorpay refund-to-source code (`pharmacyOrders/prescriptionRefund.ts:45-110`) submits it, checks it and settles it. `processed` → `refunded`. A terminal failure goes to an operator queue, where an admin may credit the wallet **only with the partner's agreement** (recorded). Unknown answers are never retried blindly |

Refund amount = the full amount paid, never more (budget = `funding.amountMinor − refunded`). A refund after an earning
cannot happen in these flows: every refund happens before completion, and completion is terminal.

### 8.5 Referral cut: who pays and how it posts

**Assumption A1 (owner to confirm, §12 Q1): Jansetu pays the cut from its own funds, as a partner-acquisition cost.**
Commission is 0 today (Q design §1, §9). The platform keeps nothing from the booking itself: it receives the
provider's price from the partner and pays exactly that price to the provider. So the cut cannot come out of the booking
money. It is an expense of the platform, and every completed assisted booking costs Jansetu the cut (plus gateway fees,
§12 Q4). The two alternatives conflict with a decision: a provider commission breaks decision 7 ("provider still earns
their normal amount"), and a discount at booking time would mean the cut never shows in payouts.

Posting:

- When: on **completion only**, in the same transaction as the provider's earning:
  - consultation: alongside `postConsultationEarningIn`;
  - lab: alongside `postEarning` in `complete`.
- Entry: `postLedgerEntry({ settlementAccountId: <booker account snapshot>, kind: 'earning', amountMinor: cut,
  grossMinor: service price, commissionMinor: 0, source: 'referral_consultation' | 'referral_lab_booking',
  sourceId: bookingId, by, byKind })`. It is exactly once by the ledger's unique key. `assisted.referral.state`
  becomes `earned`.
- Never on no-show, cancel, reject, expiry or lab desk bookings.
- Calculation per line:
  - `percent`: `floor(baseMinor × bp / 10000)`;
  - `fixed`: `min(fixedMinor, baseMinor)`;
  - then the optional `capMinor`; never more than the line's price.

  Consultation = one line. Lab = one line per item (test → `lab_test`, package → `lab_package`); per item for fixed
  amounts is assumption A2 (§12 Q2).
- Payouts: the cut is part of the booker's ledger balance, paid by the existing manual payout (Q5).
  - Labs: workspace finance.
  - Doctors: `/specialists/me/finance`.
  - Pharmacies: a new pharmacy finance screen, a payout destination on its settlement account, and its rows in the
    admin payout queue.
- Expense visibility: an admin report sums `source: referral_*` entries by period and booker (the platform's cost);
  no separate platform account is needed.
- Correction: an admin `adjustment` with a reason (the reversal command is deferred, Q5).

### 8.6 No-show (decided)

No refund to the partner; the provider is not paid; no referral cut; Jansetu keeps the money; one reschedule by the
provider, desk or admin (Q14 routes), then earnings and the cut post on completion as usual. A second no-show is
final. A booking moved after a no-show is never refunded (Q14 `NO_SHOW_NOT_REFUNDABLE`).

### 8.7 Cancellations

| Who | When (default; §12 Q6) | Refund |
|---|---|---|
| Booker | Consultation until 1 h before the slot; lab until 2 h before (Q3), or any time while a lab reschedule is unanswered | Full, by method |
| Patient in the app | Not allowed for partner-paid bookings (default; §12 Q7) | — |
| Doctor / lab reject / admin | Any time before completion | Full, by method |
| Payment window passed | 30 min unpaid | Nothing was taken; late capture back to source |

### 8.8 Reconciliation

A daily job, with an admin report:

- wallet balances = Σ entries;
- every paid assisted booking has exactly one funding (a wallet entry or a captured payment record);
- every cancelled, paid booking has a matching refund (wallet entry or Razorpay `processed`), or sits in the operator
  queue;
- every completed booking has its provider earning and, when a rule applied, its referral entry;
- Razorpay settlement totals for `wallet_recharge`, `assisted_*` and refunds match the payment records.

Mismatches are reported, never auto-corrected.

## 9. Access to records (least privilege)

### 9.1 Who sees what

| Reader | Consultation it booked | Lab booking it booked | Anything else of the patient |
|---|---|---|---|
| Booking pharmacy | Booking, status, Join call, prescription (structured + PDF) | Booking, status, **released** report files | Nothing (default; §12 Q5) |
| Booking lab member (`assisted.book`, branch in scope) | As pharmacy | — (labs book consultations) | Nothing |
| Booking doctor | — | Booking, status, released report | Nothing beyond what the doctor already sees as the patient's doctor |
| Provider (doctor/lab) | As for any booking | As for any booking | Unchanged |
| Patient (account holder after OTP) | Everything | Everything | Everything (existing customer reads) |

Not shown to bookers: drafts, documents the patient uploads later, payment record internals, other bookings, the family
list.

### 9.2 Code changes

- **`file/access.ts` `canReadBooking`** gets a field-aware booker rule:
  - A booker (pharmacy by `assisted.bookedBy`, legacy pharmacy by `pharmacyId`, lab member by `assisted.bookedBy` plus
    current membership/permission/branch through `partnerMemberMayRead`) reads **only** `prescription.fileUrls` and the
    server prescription folder (`BOOKING_PRESCRIPTION`).
  - Other booking fields (`documents.url`, `report.fileUrls`) stay with the patient and the doctor. The binding's
    `field` is already known where grants are checked (`decideFileAccess`, `:242-262`).
  - This **narrows** today's pharmacy rule, which allows every booking file (`:41`).
- **`canReadPartnerLabReport`** (`:80-89`): released files also for `pharmacy` and `specialist` readers when
  `assisted.bookedBy` matches them; drafts never.
- **Reads** are new booker endpoints (§7) that filter on `assisted.bookedBy` = the admitted actor, return an
  allowlisted view, and are paged by cursor. The generic `/bookings` stays as fixed by S2.
- Access ends when the actor's authority ends: a pharmacy no longer operational, a member deactivated, a permission or
  branch removed (checked on every request).

### 9.3 Prescription → medicine order (decision 9)

1. The prescription screen offers **Create medicine order** to the booking pharmacy only.
2. `POST /pharmacy-orders` takes `prescriptionFromBookingId`. The server checks that:
   - this pharmacy booked it;
   - the consultation has a prescription PDF;
   - the customer is the booking's account.
3. The server then sets `prescriptionUrls` to that PDF itself and binds it to the order (`pharmacy_order` grant) with
   server authority. The uploader rule (`:294-299`) is not loosened for client values.
4. Prescribed medicines pre-fill as **suggestions** matched to the pharmacy's inventory by name. The pharmacist
   confirms. P9 Rx review, stock and payment modes apply unchanged.
5. It is optional: nothing is created automatically.

## 10. SMS

### 10.1 `.env` variables

```
SMS_NOTICES_ENABLED=false              # master switch for the four messages below (OTP and bills are separate)
SMS_SEND_TIMEOUT_MS=5000               # provider call timeout (today there is none)
SMS_NOTICE_MAX_ATTEMPTS=3
SMS_FALLBACK_LANGUAGE=en               # used when the preferred language has no template
SMS_UNICODE_PARAM=                     # provider flag for non-Latin text, confirmed in phase 5

SMS_BOOKING_CONFIRMED_ENABLED=true
SMS_BOOKING_CONFIRMED_TEMPLATE_EN=     # DLT template id, one variable per language: _EN _HI _OR _BN _AS _LUS _MNI _KHA …
SMS_PRESCRIPTION_READY_ENABLED=true
SMS_PRESCRIPTION_READY_TEMPLATE_EN=
SMS_LAB_REPORT_READY_ENABLED=true
SMS_LAB_REPORT_READY_TEMPLATE_EN=
SMS_VISIT_REMINDER_ENABLED=true
SMS_VISIT_REMINDER_TEMPLATE_EN=
SMS_VISIT_REMINDER_MINUTES_BEFORE=120  # skipped when the booking is made inside this window
```

The template **text** lives in the repo (`sms/templates/<lang>.ts`), byte-for-byte the registered DLT text, with
`{#var#}` placeholders. Only the ids and switches are in `.env`. Changing the text means registering it again. A
message is sent only when the master switch, its own switch and a template id for the chosen language are all set.

### 10.2 Messages and variables

Sent to the **account phone** for assisted and lab desk bookings. Every variable is cut to ≤ 30 characters. No doctor
name or speciality, test names, diagnosis, amounts or links. The app is reached by signing in with the number, as the
bill SMS does (`sms/services/index.ts:48-53`).

| Message | Variables | English text (draft for DLT) |
|---|---|---|
| booking confirmed | `name` (patient first name), `service` ("doctor video call" / "doctor phone call" / "doctor visit" / "lab test"), `date`, `time`, `place` (booker or lab branch), `ref` | `SwasthaDisha: {#var#}'s {#var#} is booked for {#var#} at {#var#} via {#var#}. Ref {#var#}. Sign in to the SwasthaDisha app with this number for details.` |
| prescription ready | `name`, `date` (consultation), `place` (booker) | `SwasthaDisha: the prescription for {#var#} from the consultation on {#var#} is ready. Sign in to the app with this number, or ask {#var#}.` |
| lab report ready | `name`, `date` (test), `place` (lab) | `SwasthaDisha: the lab report for {#var#} from {#var#} ({#var#}) is ready. Sign in to the app with this number to see it.` |
| visit reminder | `name`, `service`, `date`, `time`, `place` | `SwasthaDisha reminder: {#var#}'s {#var#} on {#var#} at {#var#}, {#var#}.` |

The brand word follows the registered sender and header; it must match the bill template already in use.

### 10.3 Language

Language = the booking's `assisted.preferredLanguage`. If that message has no enabled template in that language, use
`SMS_FALLBACK_LANGUAGE`; if that has none either, send nothing. Variable values are written in the same language where
the app has a translation (the service words); names and places are sent as typed.

### 10.4 SMS never affects a booking

- **After commit only.** The booking transaction never calls SMS code. After it commits, the service tries to insert
  one `Job` (`consumer: 'sms_notice'`, `uniqueId: sms:<message>:<bookingId>[:<version>]`); a failure of that insert is
  logged and ignored.
- **The sender is a queue consumer.**
  - It re-reads the booking and skips if the state no longer fits (cancelled, already reported, unconfigured).
  - It calls the provider with the timeout.
  - It retries with back-off up to the maximum, then drops the job.
  - Logs name the message kind and outcome only, never phone numbers or patient details.
- **No answer depends on SMS.** Creates, payments, releases and replays return the same result whether SMS is off,
  failing or slow. The `uniqueId` stops repeats; a replayed create inserts nothing new.
- **Reminders** are scheduled jobs (like `bookingReminderScheduler`). They are cleared on cancel and re-planned on a
  move.
- **Tests** cover all four states: unconfigured, provider error, provider hang (timeout) and success, with identical
  booking outcomes.

### 10.5 DLT

Each message × language is a separate template, registered under the existing entity (PE) id and header with the
operator's DLT portal. Non-Latin languages are Unicode templates. Approval takes days per batch and rejections are
common, so registration should **start in phase 0** for English and Hindi, then the first north-east set (§12 Q17).

## 11. Languages and UI translation (separate workstream, phase 6)

### 11.1 Languages

| Language | Code | Script | Note |
|---|---|---|---|
| English | `en` | Latin | Source language |
| Hindi | `hi` | Devanagari | |
| Odia | `or` | Odia | |
| Bengali | `bn` | Bengali | |
| Assamese | `as` | Bengali–Assamese | |
| Mizo | `lus` | Latin | |
| Manipuri (Meitei) | `mni` | Bengali or Meetei Mayek | Script to choose |
| Khasi, Garo | `kha`, `grt` | Latin | |
| Nepali (Sikkim), Bodo | `ne`, `brx` | Devanagari | |
| Kokborok, Nagamese | `trp`, (none) | Latin / Bengali | Later waves |

The list is configuration: a language appears in a switcher only when its catalogue is complete enough (≥ 95% of keys
reviewed). The booking `preferredLanguage` may use any listed code, even before its UI is ready.

### 11.2 Web apps (`jansetu-web`: Vite + React 19, workspace and customer apps)

- **Library:** `i18next` + `react-i18next`. It is mature, has hooks for React 19, lazy-loads namespaces, and handles
  plurals through `Intl.PluralRules` (CLDR gaps fall back to English rules).
- **Catalogues:** `packages/ui/src/i18n/locales/<lang>/<namespace>.json`, with namespaces `common`, `auth`, `booking`,
  `assisted`, `pharmacy`, `lab`, `clinic`, `doctor`, `finance`, `customer`, `admin`. English is the source of truth.
  Other languages load on demand through dynamic import (Vite splits them). A missing key falls back to English.
- **Hard-coded strings:** CI runs `i18next-parser` and fails on keys missing in `en`; a lint rule flags literal JSX
  text; a pseudo-locale is used for QA; Playwright takes a screenshot per language to catch text overflow.
- **Switcher:** in the header menu of both apps and on the sign-in screen. It sets `<html lang>` and loads that
  script's Noto font (Devanagari, Bengali, Oriya, Meetei Mayek) only when chosen.
- **Stored choice:**
  - before sign-in: `localStorage` (`jansetu.lang`);
  - after sign-in: the person's `uiLanguage` (§5.2) through `PUT /me/ui-language { language }` for each actor type
    (customer, pharmacy, partner member, doctor, admin);
  - on sign-in the server value wins when it is set;
  - a customer's first sign-in proposes the language recorded at their first assisted booking.
- **Formats:** `Intl.DateTimeFormat` / `NumberFormat` with `<lang>-IN`, falling back to `en-IN`; ₹ with Indian
  grouping.
- **Server messages:** the UI translates the error `code`; the server's English `message` is the fallback. Server PDFs
  (prescription, bill, report) and admin-only screens stay English in this phase.
- **Translation work:** professional translators plus native-speaker review of medical words; translators work on the
  JSON or through a self-hosted open-source translation tool (Tolgee or Weblate, chosen in phase 6).

### 11.3 SMS language

Covered in §10.3. SMS templates are a separate, smaller catalogue (4 messages), so SMS can be multilingual long
before the UI is.

## 12. Open questions for the owner

1. **Who funds the referral cut?** Assumed: Jansetu pays it from its own funds. Commission is 0, so each completed
   assisted booking costs Jansetu the cut. Alternatives: start charging providers a commission (changes "provider
   earns the normal amount"), or a discount at booking time (the cut would not show in payouts).
2. **Fixed-amount cut for lab bookings:** once per test/package line (assumed) or once per booking? Percent is
   calculated on the provider's list price (assumed).
3. **Wallet limits and KYC:** minimum and maximum top-up, maximum balance, and which partner documents must be
   verified before a wallet can be used. Can unused wallet money ever be withdrawn to the bank (assumed no: closed
   loop)?
4. **Gateway fees:** who bears Razorpay fees on wallet top-ups and on direct Razorpay booking payments (assumed:
   Jansetu)?
5. **Can a partner see a patient's OTHER bookings or records** (assumed no: only the bookings it made)?
6. **Cancellation window for partner-booked bookings:** assumed until 1 h before a consultation and 2 h before a lab
   slot, with a full refund by method.
7. **Can the patient cancel a partner-paid booking from the app** (assumed no; the refund would go to the partner)?
8. **Should the patient's app show the amount the partner paid Jansetu** (assumed no: it shows "Paid by <partner>",
   because the partner may charge a different price)?
9. **Account holder's name at lookup:** full name as stored, or partly masked (e.g. "Rina K.")?
10. **A doctor who only recommended tests:** should they see the report when someone else books them (assumed no)?
11. **How partners load a doctor's recommended tests:** by the code printed on the prescription plus the phone
    (assumed), or by phone alone?
12. **Video on the patient's own phone:** sign in to the app and tap Join (assumed), or an SMS with the Meet link (needs
    a DLT template with an approved link)?
13. **Instant "consult now" consultations booked by partners:** in scope, and when (assumed: after phase 3)?
14. **Coupons on assisted bookings** (assumed: not allowed)?
15. **Lab desk:** may it book home collections, or lab visits and walk-ins only (assumed: lab visits and walk-ins)?
16. **How long the booking pharmacy keeps prescription access** (assumed: as long as the booking exists and the
    pharmacy is active)?
17. **SMS:** which north-east languages to register first, and the fallback when no template exists (assumed
    English)?
18. **Tax on referral payments:** whether partners must invoice Jansetu (GST) and whether TDS applies; needs the
    accountant before phase 4 payouts.
19. **Which doctors a lab may book:** any verified doctor with online slots (assumed), or only doctors linked or near
    it?

## 13. Phased delivery

Each phase = backend + web screens + integration/browser tests + independent review. Commits stay local; stage only on
the owner's word. Sizes: S ≈ days, M ≈ 1–2 weeks, L ≈ 3+ weeks.

| Phase | Content | Size |
|---|---|---|
| **0** | S2 hotfix (separate, assumed shipped). Pharmacy prescription bug: (a) pharmacy "Bookings I made" list and detail with the prescription (`pharmacyId` = me, allowlisted view); (b) the pending booking shows its expiry time and **Pay now** (existing pay-again) on that screen; (c) "Create medicine order from this prescription" with server-side binding (§9.3); (d) check a pharmacy-sent `dependentId` against the account. Start DLT registration (en, hi) | S–M |
| **1** | `assisted` block, `source`, consent, language; patient lookup/create via the resolver; keyed, server-priced pharmacy wallet payment (replacing unrouted `payConsultation`); Razorpay partner payment context; refunds by method (wallet in-transaction, Razorpay worker); pharmacy-booked consultations end to end with Join call / call number and Meet without patient email; booker-only prescription access (§9.2); generic create closed to pharmacies | L |
| **2** | Lab wallets (`partner_wallets`) and top-up; pharmacy → lab; lab → consultation (`assisted.book`, `wallet.*` permissions); lab front desk (`lab_desk`, walk-in, bill link); booker access to released reports | L |
| **3** | Doctor wallet; doctor → lab (from a consultation or by phone); structured recommended tests, code on the PDF, patient "Book recommended tests", partner lookup by code | M |
| **4** | Referral rules (admin setup screens, history, version fence); snapshot at create; earnings on completion; pharmacy settlement accounts, finance screen and payouts; admin referral-expense and reconciliation reports | M |
| **5** | SMS: `sms_notice` consumer with timeout and retries, templates per language, `.env` switches, four messages, reminder jobs; Unicode verified with the provider | M |
| **6** | UI translation: i18next setup, catalogues, switcher, `uiLanguage` on every actor, fonts, CI checks; first languages hi, or, bn, as, lus, then more | L (engineering) plus translation time |

Phase 5 can run beside phases 2–4 once phase 1 has the `assisted` block; DLT approval sets its real start.

## 14. Risks

| Risk | Why it matters | Mitigation in this design |
|---|---|---|
| **Wrong or recycled number** | Phone-only identity: a typo puts a patient's records in a stranger's account, seen after that stranger's OTP sign-in | New numbers typed twice; `newAccount` shown; "booking confirmed" SMS alerts the real holder; admin tool to move a wrongly booked booking to the right account (audited); recycled numbers remain a risk for every OTP account |
| **Privacy on a shared phone** | Family members read SMS and the app | SMS without health details (§10.2); records only after OTP; booker access limited to its own bookings and to prescription/released report only (§9) |
| **Name exposure at lookup** | Any partner can type numbers and learn names | Lookup returns the name only, rate-limited per actor and audited; alerts on unusual volume; masking left to the owner (§12 Q9) |
| **Booking any number without OTP** | Accounts and SMS for people who never agreed | Partner attestation recorded with statement version; the partner pays for every booking (cost deters spam); limits on new accounts per booker per day (default 30) and on assisted bookings per number per day (default 5), shared across instances like the O1 OTP limits; numbers booked by many partners flagged for review |
| **Minors** | Children are booked as family members under a parent's number; the DPDP Act expects parental consent for children | The account holder (parent) is the consent relation; the statement shown with the tick says so; legal review of the wording |
| **Referral fraud / collusion** | A partner and a doctor could fake completed consultations to farm the cut | Cut only on completion; price is fully paid by the partner first; velocity and repeat-pair reports; admin adjustments; optional holding period before payout (Q5 manual payouts already give one) |
| **Doctor referral cut is legally sensitive** | Indian medical ethics rules forbid doctors taking commissions for referring patients to labs | Recommendation: legal advice before phase 4 switches on doctor cuts; the rule is per partner, so doctor cuts can stay at 0 without code changes |
| **Partner wallets as stored value** | RBI prepaid-instrument rules (PHONE_CONSULTATIONS §6) | Closed loop, no withdrawal or transfer, used only to buy Jansetu services; finance/legal review before go-live |
| **Money reconciliation** | Partner wallet balances are money Jansetu owes; Razorpay refunds can fail or hang; rupee/paise conversions | One method per booking; paise everywhere new; exactly-once keys on every movement; refund worker with operator queue; daily reconciliation (§8.8) |
| **Partner–patient disputes** | The partner sets its own counter price and may cancel after taking cash | Jansetu is not party to the counter price (stated in partner terms); the patient's app shows the booking and its status; cancellations audited |
| **DLT timelines** | Each template × language needs approval; Unicode templates are often rejected | Register early (phase 0); English fallback; SMS off by default |
| **Meet access for walk-ins** | Meet needs invited emails; Workspace settings may block guests | Booker email as attendee; "call" mode as fallback; verified in phase 1 |
| **Translation quality** | Medical words mistranslated | Native-speaker clinical review; English always available in the switcher |

## 15. Verification (to build with each phase)

- Same key + same request answers the stored booking once: one debit, one seat, one SMS job. A different request under
  the same key is 409. A key abandoned before commit never books.
- Wallet race: two bookings competing for the last ₹500 → one succeeds, the other is 409 `INSUFFICIENT_BALANCE`, and the
  balance never goes negative.
- Razorpay: capture after expiry → refunded to the card, never the wallet or the patient. Duplicate webhooks credit
  once.
- A partner-paid booking never moves the patient's wallet (retry-payment, cancellation, expiry).
- Cancel / reject / no-show / no-show moved then completed produce exactly the earnings, cut and refunds of §8.
- A pharmacy reads the prescription of its booking only, not the patient's other documents, other bookings or another
  pharmacy's booking. A member who loses `assisted.book` or a branch loses access at once. Lab report drafts are never
  readable by bookers.
- "Create medicine order" works only for the booking pharmacy; a client-sent prescription URL is still refused.
- SMS off, failing, timing out or succeeding gives identical booking answers. Replays send nothing.
- Referral rule edited after a booking: that booking keeps its snapshot.
