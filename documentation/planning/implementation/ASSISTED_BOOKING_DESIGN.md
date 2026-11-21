# Assisted booking: partners book for walk-in patients (design, 2026-11-22)

Status: **design only, nothing built.** Revision 2 folds in the owner's answers of 22 Nov 2026 (§2.2), which replace
several 21 Nov rules. Every owner decision is a requirement, not a choice made here. Built after the gates in
[AGENTS.md](../../../AGENTS.md) and the established rules of
[Q_PARTNERS_LABS_CLINICS_DESIGN.md §11](Q_PARTNERS_LABS_CLINICS_DESIGN.md). Capability rows: C02 (assisted booking,
Partial) and C11 (partner-paid consultations, Missing) in [CAPABILITY_MATRIX.md](../CAPABILITY_MATRIX.md).
Assumes hotfix **S2** (over-exposure of the generic `/bookings` reads) has shipped. Labels: **ASSUMED** = a default
chosen here (listed in §12.1); **OPEN-OWNER** = waits for the owner (§12.2).

## 1. In plain words (for the owner)

Many people in rural areas and the north-east have no app, no smartphone, or one phone for the whole family. A
pharmacy, a lab or a doctor becomes their door to Jansetu:

1. The partner types the patient's mobile number. If an account exists, it sees the holder's name partly hidden
   ("Rina K.") and asks how the patient is related to them (self, mother, son …). If not, Jansetu quietly opens an
   account for that number.
2. The partner picks the service: a doctor (any doctor on the platform, nearby ones shown first) for a scheduled or an
   instant "consult now" consultation, or a lab test. It picks the time and place, asks the patient's language, applies
   a coupon if one fits, and ticks "patient agreed".
3. **The partner pays Jansetu straight away**, from its Jansetu wallet or by Razorpay. It collects from the patient at
   its own counter, at whatever price it chooses. Jansetu bears the gateway fees.
4. When the service is done, the provider (doctor or lab) earns the price after any coupon, **minus the booking
   partner's referral cut**. The cut goes to the partner and shows in its payouts. Doctors' own cuts stay at 0 until
   legal advice.
5. The booking partner sees the prescription or the lab report of the booking it made. A pharmacy can turn the
   prescription into a medicine order. A doctor treating the patient sees the patient's past consultations and
   reports.
6. When anyone later signs in to the app with that mobile number (OTP), they see every booking, prescription and
   report of the family. They may also cancel a partner-paid booking; the money goes back to the partner.
7. SMS messages (booked, prescription ready, report ready, reminder) go out in the patient's language when a template
   exists, otherwise in English. An SMS can never stop or undo a booking.
8. Partners can ask an admin to send unused wallet money to their bank account. It is paid like a payout.

A lab also gets a **front desk for its own tests** (lab visits and home collection, like the clinic desk). The patient
pays the lab, Jansetu takes no money, and the report goes to the patient's app.

## 2. Owner decisions

### 2.1 21 Nov 2026, compared with the earlier phone proposal

| # | Decision (requirement) | Difference from [PHONE_CONSULTATIONS.md](../PHONE_CONSULTATIONS.md) v1.7 |
|---|---|---|
| 1 | Bookers: pharmacy → consultation and lab test; lab → consultation; doctor → lab test, or recommends tests in the prescription for the patient, a pharmacy or a lab to book later; lab front desk for its own tests (paid at the lab) | v1.7 covers an IVR helpline with a PIN; IVR, PIN and call bridging are not in this scope |
| 2 | Identity by phone number only; one phone serves a family. An existing account shows the holder's name and asks the relation, and the patient is booked as a family member. A new number gets an internal account, visible after OTP sign-in. Ask the preferred language | v1.7 treats the phone as a lookup hint, never identity, with independent contact verification (AR-25). The account stays `otpVerified: false` until its owner signs in |
| 3 | Consent: no OTP; the partner ticks "patient agreed" | v1.7 required proof held by the patient; here the partner's attestation is recorded and audited |
| 4 | The partner pays at booking time (wallet or Razorpay); never pay-later, never the patient's wallet | Matches v1.7's "Partner-paid consultation" model (P1 option 1), extended to labs and doctors |
| 5 | Pharmacy, lab and doctor wallets: Razorpay top-up, pay bookings, receive refunds | v1.7 called lab and hospital wallets unsupported |
| 6 | A refund goes back the way the partner paid | Same principle as v1.7 |
| 7 | Referral cut per partner and category, % or fixed, set at partner setup, shown in payouts | v1.7 said referral does not create commission. The **funding source is replaced on 22 Nov** (§2.2 row 1) |
| 8 | The booking pharmacy sees the prescription; the booking partner sees the lab report; the patient sees everything | v1.7 required "the relevant patient authority"; here the booking and the tick are that authority, for the partner's own bookings only |
| 9 | A prescription can optionally become a pharmacy medicine order | New |
| 10 | Call or video on the partner's device, or on the patient's or family's number | v1.7 used telephony bridging; here Google Meet (existing) or the doctor calls the number |
| 11 | SMS: four messages, DLT templates, `.env` ids and switches, never affects a booking | Same "minimal content on a shared phone" rule |
| 12 | All UI languages, switchable by users and partners | Separate workstream (phase 6) |

Reused from v1.7:
- server-derived price, never `req.amount`;
- payer kept separate from beneficiary;
- one charge per operation, with an idempotent result;
- minimal SMS content;
- no per-minute charging;
- the RBI stored-value question (§14).

### 2.2 22 Nov 2026 answers (replace any earlier rule they contradict)

| # | Decision | Where in this design |
|---|---|---|
| 1 | **The referral cut is funded from the provider's earning.** Example: a ₹500 consultation at 10% pays the doctor ₹450 and the partner ₹50. The cut is configurable per partner and category (consultation, lab test, package), % or fixed. A fixed lab cut applies **per test or package line**. A % cut applies to the provider's earning base. **Coupons are borne by the provider**, who earns the price after the coupon. Order: coupon first, then the cut | §5.4, §8 |
| 2 | Doctor cut: build the setting, keep it **OFF (0)** until legal advice (NMC ethics). Pharmacy and lab cuts work | §5.4, §8.5 |
| 3 | The partner pays Jansetu at booking (wallet or Razorpay); **Jansetu bears gateway fees**. Wallets for pharmacy, lab and doctor. **Withdrawal of a wallet balance to the bank through an admin**, paid like a payout | §5.3, §8.2, §8.4 |
| 4 | A refund goes back by the method the partner chose | §8.4 |
| 5 | **The partner may cancel** a consultation any time before it starts, and a lab booking up to 1 hour before the slot | §8.7 |
| 6 | **The patient may cancel** a partner-paid booking from the app; the refund goes to the partner | §8.7 |
| 7 | **Doctors see the patient's past consultations and reports while treating them.** Pharmacies and labs see only what they booked. A doctor who only **recommended** tests does not see the report; the partner that booked them does | §9 |
| 8 | Video on the patient's own phone: **both** app sign-in + Join, and an SMS with the link once that template exists | §6.6, §10 |
| 9 | **Any doctor on the platform**, chosen by the partner; nearby doctors first, by city or pincode | §7.1 |
| 10 | **Instant "Consult now" by partners** is allowed, by doctor availability, alongside scheduled bookings | §7.7 |
| 11 | **Coupons are allowed** on assisted bookings when one applies | §6.3 |
| 12 | The existing holder's name is shown **partly hidden**, e.g. "Rina K." | §6.2 |
| 13 | The lab desk handles **lab visits and home collection** | §5.5, §7.5 |
| 14 | Ask the patient's language at booking; full UI translation stays in phase 6 | §5.2, §11 |
| 15 | SMS: four messages; `.env` template id **and an on/off switch per language**; never affects a booking | §10 |

## 3. Current state

| Area | What exists | Gap for assisted booking |
|---|---|---|
| Pharmacy creates a consultation | Generic `POST /bookings` and `/bookings/specialist`. A pharmacy must send `userId`; `pharmacyId` comes from its token (`bookings/controller/index.ts:157-189`, routes `bookings/routes/index.ts:31-42`) | No booking screen for the pharmacy. The family-member check runs only for customer callers (`controller:52-64`), so a pharmacy-sent `dependentId` is not checked against the account |
| Money of a pharmacy-made booking | `finishCreate` funds from the **patient's** wallet and opens a Razorpay order owned by the **patient** (`bookings/services/index.ts:871-966`). Cancellation refunds to the **patient's** wallet (`bookings/holds.ts:284` `settleMoney`, `:311`) | Contradicts decisions 4 and 6 |
| Unpaid expiry | Unpaid priced bookings are cancelled after 30 min, after reconciling with Razorpay (`bookings/services/index.ts:1741-1777`) | A pharmacy that cannot pay on the spot loses the booking (bug cause 2) |
| Pharmacy wallet | Balance, history, Razorpay self top-up (`pharmacyWallet/routes/index.ts:13-24`; credit on capture `payment/services/index.ts:1488-1582`). `payConsultation` debits in one transaction with a paid-state guard, but is **unrouted**, trusts `req.amount` and has no request key (`pharmacyWallet/services/index.ts:153-279`). Amounts in rupees with a paise mirror; transaction types `credit/debit/consultation_payment/refund/adjustment` (`pharmacyWallet/model/index.ts:4-56`) | Needs a server-priced, keyed route and withdrawals. Labs and doctors have no wallet |
| Customers by phone | Race-safe `resolveCustomerByPhone`, sources `partner_invoice` and `clinic_desk` (`partners/services/customerResolver.ts:64-93`). Pharmacy customers use an older path that is not race-safe and overwrites `linkedPharmacyId` (`pharmacyCustomers/services/index.ts:21-81`) | Add source `assisted_booking`; pharmacies move to the resolver |
| Clinic desk (pattern to copy) | `createDeskAppointment`: request key per desk member with a content hash; family member existing or created in the booking transaction; audit in the transaction; notices after commit; `settlementSystem: 'clinic'` (`partners/services/clinic.ts:477-610`) | The lab desk and assisted bookings follow it |
| Partner lab bookings | Customer-only create; `userId` is the caller; price fence `acceptedPayableMinor`; refunds through the customer-wallet ledger (`partners/services/labBookings.ts:165-227`, `:436-448`); earning = subtotal **before coupon**, commission 0, on completion (`:640-648`) | Needs a booker, partner funding, provider-borne coupon and the cut |
| Doctor earning | `originalPrice` (**before coupon**), commission 0, on completion (`doctors/services/earnings.ts:15-28`) | The 22 Nov coupon and cut rule changes this |
| Instant consultations | Customer-only request, quote, held funding, accept, and refunds of the quote difference to the customer wallet (`doctors/services/instant.ts:239-370`, `:431-528`, `:569`) | Needs a partner payer and refunds by method |
| Doctor's view of a patient | `getPatientHistory` lists only **this doctor's own** consultations with the account (`specialistPortal/services/index.ts:399-429`) | Decision 7 widens it while treating |
| Prescription | The doctor writes it; the server renders `bookings/<id>/prescription-<ts>.pdf` (`specialistPortal/services/index.ts:328-397`, `:472-512`). Tests advised are free text (`bookings/model/index.ts:107`) | No notice; no structured test recommendation |
| File access | `canReadBooking` lets a pharmacy whose `pharmacyId` matches read **every** file of the booking (`file/access.ts:34-45`). Partner lab reports: the patient or a partner member only (`:80-89`). Attaching needs uploader authority (`:294-299`), and `PharmacyOrder.prescriptionUrls` is such a field (`:458`) | Booker access is too broad for consultations and missing for lab reports. The server-written prescription PDF has no uploader, so it cannot be attached to an order (bug cause 3) |
| Meet links | Created for paid call and video bookings; **fail when the patient has no email** (`meet/service/index.ts:465-470`) | Walk-in patients have no email |
| Settlement ledger | Accounts `ownerKind: 'partner' \| 'doctor'`, unique by owner (`partners/model/settlement.ts:18-69`). Entries `earning/reversal/payout/adjustment`, exactly once per (account, source, sourceId, kind) (`:75-110`, `partners/services/settlement.ts:51-80`). Manual payouts recorded by admins (Q5) | No pharmacy account; no referral account; no wallet withdrawal |
| SMS | Types `otp` and `partner_bill` only. GET with **no timeout**; throws on failure (`sms/services/index.ts:13`, `:63-111`). The bill notice is sent after commit and swallowed (`partners/services/invoice.ts:466-474`) | No queue, no language, no per-message switches |
| Background jobs | Mongo `Job` queue with `uniqueId` de-duplication (`queue/model/index.ts:4-16`), used by booking reminders | Reused for SMS |
| Languages | No language field on users, family members, members or pharmacies. Doctors have spoken `languages` (`specialists/model/index.ts:113`) and a city, state and pincode (`:154-170`) | New fields; nearby sorting |
| Payments | Contexts enum (`payment/model/index.ts:21`); per-context handler registry (`payment/services/index.ts:110-112`); Razorpay refund-to-source worker for Rx orders (`pharmacyOrders/prescriptionRefund.ts:45-110`) | New contexts and a partner refund worker (reuse) |
| Cancellation window | Customers only: 24 h before, 48 h on Mondays (`common/utils/cancellationWindow.ts:92-108`) | Partner rules are now decided (§8.7) |

**The pharmacy prescription bug in short:**
1. There is no pharmacy screen listing the bookings it made.
2. An unpaid booking is cancelled after 30 minutes.
3. The prescription PDF cannot be attached to a pharmacy order.

The file itself is already readable by that pharmacy (`file/access.ts:41`). Phase 0 fixes all three.

## 4. Terms

| Term | Meaning |
|---|---|
| **Booker** | The partner that makes and pays the booking: a pharmacy (`userType: 'pharmacy'`), a lab (`PartnerOrg.kind: 'lab'`, through a member), or a doctor (`specialist`) |
| **Provider** | The doctor or lab who delivers the service and earns from it |
| **Earning base** | Provider price after coupon (§8.3) |
| **Account holder** | The customer account of the phone number (`User`, `userType: 'user'`) |
| **Patient** | The account holder ("self") or one of their family members (`Dependent`) |
| **Assisted booking** | A consultation (`Booking`, scheduled or instant) or a partner-lab booking (`PartnerLabBooking`) made and paid by a booker |
| **Lab desk booking** | A lab's own test booked at its counter and paid at the lab; no Jansetu money |
| **Treating doctor** | A doctor with a current consultation for that patient (§9.1) |

## 5. Data model changes

All money in new fields is **integer paise** (`…Minor`). Consultation prices stay in rupees on `Booking` (Q14
decision 5) and are converted once, with `Math.round(rupees × 100)`, when snapshotted.

### 5.1 Who booked: the `assisted` block

One optional subdocument, identical on `Booking` (consultations) and `PartnerLabBooking`, plus a top-level `source`.
`InstantRequest` carries the same `assisted` block until acceptance copies it to the booking.

| Field | Type | Notes |
|---|---|---|
| `source` | `'self' \| 'pharmacy_assisted' \| 'lab_assisted' \| 'doctor_assisted' \| 'clinic_desk' \| 'lab_desk'` | Absent means `self` (no migration). Indexed with the booker |
| `assisted.bookedBy` | `{ kind: 'pharmacy' \| 'lab' \| 'doctor', id, branchId?, actorKind: 'pharmacy' \| 'member' \| 'admin' \| 'specialist', actorId, name }` | `id` is the pharmacyId, partnerId or specialistId from the admitted actor, never from the body. `branchId` is set for labs. `name` is a display snapshot |
| `assisted.consent` | `{ method: 'partner_attested', statementVersion, statementLanguage, at, actorId }` | Required; 400 `CONSENT_REQUIRED` without it |
| `assisted.preferredLanguage` | language code (§11.1) | Required; drives SMS; a hint when choosing the doctor |
| `assisted.join` | `{ on: 'partner_device' \| 'patient_phone', phone?, linkTokenHash? }` | `call` and `video` modes only. `phone` (10 digits) is the number the doctor calls and is copied to `contactNo`. `linkTokenHash` belongs to the SMS join link (§6.6) |
| `assisted.funding` | `{ method: 'partner_wallet' \| 'partner_razorpay', payerKind, payerId, amountMinor, state, walletEntryId?, paymentRecordId?, refunds[] }` | `state` runs `pending → paid → partly_refunded → refunded`, or stays `paid` on a no-show. Each `refunds[]` row is `{ amountMinor, cause, method, state, walletEntryId?, razorpayRefundId?, attemptId, at }`. Instant quote differences are partial refunds |
| `assisted.split` | `{ listMinor, couponCode?, discountMinor, baseMinor, cutMinor, providerMinor, rule: 'provider_coupon_v2' }` | Frozen at create (instant: at accept). `baseMinor = listMinor − discountMinor`, `providerMinor = baseMinor − cutMinor` |
| `assisted.referral` | `{ ruleIds[], ruleVersions[], lines: [{ category, basis, value, baseMinor, amountMinor }], amountMinor, settlementAccountId, beneficiaryName, state: 'expected' \| 'earned' \| 'none', disabledReason? }` | Snapshotted with the split (§8.5). `disabledReason: 'doctor_cuts_off'` while the doctor switch is off |
| `assisted.recommendationId` | string | Booked from a doctor's test recommendation (§7.6) |
| `assisted.requestKey`, `assisted.requestHash` | strings | Unique partial index on `assisted.requestKey`, stored as `assisted:<kind>:<bookerId>:<actorId>:<key>` like desk keys |

Kept and stamped:
- `Booking.pharmacyId` is still set for pharmacy bookings, so existing readers keep working.
- Assisted consultations are always stamped `settlementSystem: 'ledger'` at the single insert (`bookings/holds.ts:262`),
  whatever `SETTLEMENT_CUTOVER_AT` says. Q4a is on stage.
- Every new ledger booking (assisted or not) records `earningRule: 'provider_coupon_v2'` at create, so completion
  applies the rule the booking was made under (§8.3).

Indexes: `{ 'assisted.bookedBy.kind': 1, 'assisted.bookedBy.id': 1, createdAt: -1 }` on all three collections.

Enums extended:
- `User.createdSource` and the resolver's `source` union: `assisted_booking` (`user/model/index.ts:161-166`);
- payment `context`: `assisted_booking`, `assisted_lab_booking` and `assisted_instant`;
- settlement `ownerKind`: `pharmacy`;
- `PartnerLabBooking.settlement.settlementSystem`: `lab_desk`;
- pharmacy wallet transaction types: `withdrawal_hold` and `withdrawal_release`.

### 5.2 Patient language and UI language

| Model | New field | Set by |
|---|---|---|
| `User` | `preferredLanguage` (care and SMS), `uiLanguage` (screens) | An assisted booking fills `preferredLanguage` only when it is empty; the user changes both in the app |
| `Dependent` | `preferredLanguage` | Set when a booking creates the family member |
| `PartnerMember`, `Pharmacy`, `Specialist`, admin `User` | `uiLanguage` | The person, through the switcher (§11) |

`Specialist.languages` (spoken) is unchanged. Doctor lists show doctors who speak the patient's language first,
after the nearby order (§7.1).

### 5.3 Partner wallets and withdrawals

| Owner | Storage | Why |
|---|---|---|
| Pharmacy | Existing `pharmacy_wallets` / `pharmacy_wallet_transactions` (live balances; no migration) | A money migration of live balances is a risk with no benefit now |
| Lab partner, doctor | New `partner_wallets { ownerKind: 'lab' \| 'doctor', ownerId, balanceMinor ≥ 0, version, isActive }` (unique `{ownerKind, ownerId}`) and `partner_wallet_entries { walletId, kind: 'topup' \| 'booking_debit' \| 'refund_credit' \| 'withdrawal_hold' \| 'withdrawal_release' \| 'adjustment', amountMinor (signed), balanceAfterMinor, operationKey (unique), ref { kind, id }, by, byKind, at }` | Paise only from day one |

Both sit behind one `BookerWallet` interface (`debitForBooking`, `creditRefund`, `creditTopup`, `holdForWithdrawal`,
`releaseWithdrawal`, `balance`, `statement`) with the same rules:

- **Debit for a booking.** A conditional `$inc` (balance ≥ amount) inside the booking's transaction, with its entry
  and a unique `operationKey` (`assisted:<bookingId>:debit`). Insufficient balance is 409 `INSUFFICIENT_BALANCE`.
- **Top-up.** A Razorpay order (`context: 'wallet_recharge'`, payer = the booker) is credited once on verified capture
  (`operationKey: wallet_recharge:<paymentRecordId>`). This is the pharmacy path (`payment/services/index.ts:1488-1582`)
  generalised with `payerPartnerId` / `payerSpecialistId`. Jansetu bears the gateway fee, so the wallet is credited
  the full amount paid.
- **Refund credit.** `operationKey: assisted:<bookingId>:refund:<n>`.
- **Withdrawal (decision 3).** It runs as a `wallet_withdrawals` request
  `{ walletRef, amountMinor, state: 'requested' | 'paid' | 'rejected', payoutDestinationVersion, requestKey, reference?,
  paidAt?, decidedBy }`:
  1. The owner (pharmacy; lab owner or member with `wallet.manage`; the doctor) requests an amount. In the same
     transaction the wallet is debited into `withdrawal_hold`, so the money cannot also be spent.
  2. An admin pays it outside the system and records method, UTR, date and note, exactly like a Q5 payout. It goes to
     the **verified** payout destination of the owner's settlement account (Q5 version rule) and is exactly once per
     (admin, request key).
  3. Rejecting the request credits back `withdrawal_release`.

  Withdrawal limits and checks are OPEN-OWNER (§12.2).
- **Adjustments.** Admin corrections are signed `adjustment` entries with a reason (Q5), never below 0.
- **Ordering.** Each wallet document has a `version` that every movement bumps.

### 5.4 Referral rules, the doctor switch and referral accounts

`referral_rules { bookerKind: 'pharmacy' | 'lab' | 'doctor', bookerId, category: 'consultation' | 'lab_test' |
'lab_package', basis: 'percent' | 'fixed', percentBasisPoints?, fixedMinor?, capMinor?, isActive, version, updatedBy,
updatedAt }`, unique `{bookerKind, bookerId, category}`, plus an append-only `referral_rule_events` history.

- **Admin only.** Rules are set in the admin screens that create or edit a pharmacy, a lab partner or a doctor.
  Partners see them read-only. Edits carry `expectedVersion`; a stale one is 409 `RECORD_CHANGED`.
- **New bookings only.** A rule change never alters a booking already made: the snapshot is taken at create (instant:
  at accept).
- **Doctor switch (decision 2).** `REFERRAL_DOCTOR_CUTS_ENABLED=false` (default). Admins may save doctor rules. While the
  switch is off, every doctor-booked snapshot records `amountMinor: 0` with `disabledReason: 'doctor_cuts_off'`, and the
  provider keeps the whole base. Turning it on affects bookings made afterwards only.
- **Referral settlement accounts.** `SettlementAccount` gains `purpose: 'service' | 'referral'`:
  - existing rows default to `service`;
  - the unique index becomes `{ownerKind, ownerId, purpose}`, migrated by a dry-run/commit script followed by
    `sync-indexes`;
  - a booker's cuts post to its `referral` account, created idempotently before the first snapshot;
  - pharmacies get `ownerKind: 'pharmacy'`.
- **Payouts behind a setting (OPEN-OWNER, tax).** `REFERRAL_PAYOUTS_ENABLED=false` (default) refuses payouts from
  `purpose: 'referral'` accounts with 409 `REFERRAL_PAYOUTS_DISABLED`. Cuts still accrue and show on statements. GST
  and TDS on referral payments need the accountant before this is switched on (§12.2).

### 5.5 Lab desk bookings

A `PartnerLabBooking` with `source: 'lab_desk'` and a `desk { memberId, branchId, requestKey, requestHash, arrivedAt? }`
block (the clinic-desk shape, `bookings/model/index.ts:452-463`).

- **Settlement.** `settlement.settlementSystem: 'lab_desk'`, with no settlement account. `paymentStatus` stays
  `pending` and there is no `paymentDeadline`. `pricing` is snapshotted from the lab's catalogue for the bill.
- **Visit mode (decision 13).** `lab` or `home`:
  - home needs an address and a home-collection slot (a seat is taken), and a collector is assigned as for online
    bookings;
  - a lab visit takes a slot, or `{ walkIn: true, startsAt: now }` (no seat) for a patient tested at once.
- **Guards.** Pay-again, the wallet and the gateway refuse it (409 `PAY_AT_LAB`). The expiry sweep skips it. Earnings
  and cuts never post. A customer cancellation refunds nothing. Both payout systems exclude it.
- **Billing.** The lab bills with its own Q2 invoice, linked by `labBookingId` (at most one open bill), mirroring the
  Q14 bill-appointment link.

### 5.6 Test recommendations

`test_recommendations { _id, code, consultationId, specialistId, userId, dependentId?, items: [{ name, code?, note? }],
status: 'open' | 'partly_booked' | 'booked', bookings: [{ labBookingId, itemNames[] }], createdAt }`.

- Created when the doctor saves a prescription that lists recommended tests.
- `code` is a short random reference (8 characters with a check digit, e.g. `RT-7K4Q-2M`) printed on the prescription
  PDF.
- `prescription.testsAdvised` (strings) stays filled for older readers.

## 6. Building blocks shared by every flow

### 6.1 Booker actors and permissions

| Booker | Sign-in and admission | Permission |
|---|---|---|
| Pharmacy | `requireOperationalPharmacy`; `pharmacyId` from the token | Every operational pharmacy (single login) |
| Lab | Partner workspace member, loaded from the DB on every request (Q1); admin-as-owner mirror registered automatically (§11 row 1) | New `assisted.book` (book for walk-ins; see those bookings, their prescriptions and reports); new `wallet.view` and `wallet.manage` (top up, request withdrawals). Delegation ceiling and branch scope as §3 |
| Doctor | `specialist`, active and verified | Own login; the wallet is the doctor's, not the clinic's |

Every assisted mutation writes an audit event in the same transaction:
- `PartnerAuditEvent` for lab members;
- a new `assisted_audit_events` (actor kind/id, action, booking) for pharmacies and doctors.

Booker and treating-doctor reads of prescriptions and reports are logged after the read, best effort.

### 6.2 Find or create the patient

1. **Lookup.** `POST …/assisted/patients/lookup { phone }` returns `{ exists, holderNameMasked }`. Nothing else is
   returned: no family list, no bookings, no "has signed in" (the Q14 review rule). Masking (decision 12):
   - first word in full plus the initial of the last word ("Rina Kumari Das" → "Rina D.");
   - a one-word name shows its first two letters and "…" ("Ri…", ASSUMED);
   - an account with no name returns `null`.

   Lookups are rate-limited per actor (default 60 an hour) and audited.
2. **Patient.** The partner picks **self** or a relation `{ name, relation, gender?, dateOfBirth? }` (the dependents
   list without "Me").
3. **Inside the booking transaction**, as the clinic desk does (`partners/services/clinic.ts:548-585`):
   - `resolveCustomerByPhone(phone, 'assisted_booking')` (never merged or overwritten; the name is set only when
     empty);
   - an active family member with the same name and relation is reused, otherwise one is created with a pre-chosen
     id;
   - a pharmacy also gets its `pharmacy_customers` link (`ensureLinked`).
4. **New numbers** are typed twice, and the answer says `newAccount: true` (§14).
5. **The account owns the booking.** The booking belongs to the account, for the holder or the family member.

### 6.3 Request keys, hash, price fence and coupons

- **Request key.** Every create carries `requestKey` (`[A-Za-z0-9_-]{8,100}`), stored per booker actor and claimed in
  the booking transaction (`claimRequestKey`, `requestKeys/index.ts:27-48`). New `OnceOnlyKind`s:
  `assisted_consult_create`, `assisted_instant_create`, `assisted_lab_create`, `lab_desk_create`,
  `wallet_withdrawal`.
- **Request hash.** sha256 of `canonicalJson` (`common/utils/canonicalJson.ts`) over:
  - the canonical phone and the patient identity;
  - the service:
    - scheduled: doctor + slot + mode + join;
    - instant: speciality or doctor + mode + join;
    - lab: lab + branch + sorted item ids + visit mode + slot + address;
  - `couponCode`, `preferredLanguage`, `recommendationCode` and `notes`.

  The payment method is not part of the identity (Q3 rule): a resend continues the same booking's payment.
- **Replays.** Same key and hash → 200 with the stored booking, `replayed: true`, nothing sent again. Different hash →
  409 `IDEMPOTENCY_KEY_REUSED`. Abandoned → 409 `REQUEST_ABANDONED`. `GET …/by-key/:key` and
  `POST …/by-key/:key/abandon` recover a lost answer (Q13).
- **Coupons (decision 11).** An applicable coupon is checked against the **patient** (account, family member, corporate)
  by the existing rules: internal booking coupons (`bookings/services/index.ts:407`), diagnostics rules for labs
  (Q3) and frozen-on-request for instant (Q4b). Its use counts against the patient's account. The discount lowers what
  the partner pays, and the provider bears it (§8.3).
- **Price fence.** The screen sends `acceptedPriceMinor` (after coupon); any other server price is 409
  `PRICE_CHANGED` (Q9). The price comes from the doctor's fee, the doctor's instant fee or quote, or the lab catalogue.
- **Later steps.** Pay-again, cancel and accepting a lab reschedule carry `expectedUpdatedAt` (consultations) or
  `expectedVersion` (lab bookings).

### 6.4 Paying (the partner pays at booking time)

**One method per booking**: wallet or Razorpay, never split. That keeps "refund the way it was paid" exact.

| Method | What happens |
|---|---|
| Wallet | **One transaction:** request key claim, seat and doctor interval (`createBookingWithHolds` already takes an in-transaction callback, `bookings/holds.ts:214`) or lab seat (`takeSeat`), coupon use, insert as `confirmed` + `paid`, wallet debit + entry, split and referral snapshot, audit. Nothing can expire |
| Razorpay | The booking is inserted `pending_payment` with the seat held. A Razorpay order opens with context `assisted_*`, payer = the booker, and payment record `userId` = the booker principal, **never the patient**. The payment completes on the partner's device. A `CONTEXT_HANDLERS` handler confirms it on verified capture, idempotently. Pay-again (also switching to the wallet) works within 30 min. After that the existing sweep expires the booking (reconciling first). A late or losing capture is refunded **to its source** (§8.4). Jansetu bears the gateway fee |

Assisted bookings never touch the customer-wallet ledger (`walletFunding`):
- `/bookings/:id/retry-payment` and `fundBookingFromWallet` refuse them with 409 `PARTNER_PAID_BOOKING`.
- The customer cancellation path routes them to the partner refund of §8.4.
- After phase 1, pharmacies can no longer create through the generic `POST /bookings*` (403 `USE_ASSISTED_BOOKING`).

### 6.5 Notices after commit

- **In-app notices.** The existing ones: the patient (account holder, naming the family member) and the provider. The
  doctor notice is `specialist_new_booking`; labs get theirs from the lab notifier. The provider's notice says "booked
  by <partner> for a walk-in patient" and how to join.
- **Idempotency keys.** `assisted:<booking>:<event>[:<version>]:<audience>`; a replay sends nothing.
- **Booker badges.** The booker's list shows "prescription ready", "report ready" and "cancelled by patient", derived
  from booking state.
- **SMS.** §10.

### 6.6 How the consultation happens (decisions 10 and 8)

| Mode | `join.on = partner_device` | `join.on = patient_phone` |
|---|---|---|
| `video` | The partner app shows **Join call** (the Meet `joinUrl`) from 10 min before the slot to its end | **Both:** (a) the patient signs in to the app with the account number and taps Join; (b) once the "with link" SMS template exists (§10), the booked and reminder SMS carry a join link |
| `call` | The doctor phones the partner's counter number (`contactNo` = partner phone) | The doctor phones the number given at booking (`contactNo` = `join.phone`, any 10-digit family number) |
| `in-person` | Not used (a doctor's in-clinic slot) | Not used |

The SMS join link is `https://<app-domain>/j/<token>`:
- a random 128-bit token, stored only as a hash on the booking;
- the server redirects to the Meet URL only inside the join window, and shows a plain "not open yet / ended" page
  otherwise;
- the token opens the call only, never records;
- it is a single DLT-approved domain, which avoids registering Google's.

Meet change:
- attendees are the doctor plus the booker's contact email (pharmacy email, member email, or none);
- a missing patient email no longer blocks the link (`meet/service/index.ts:465-470`);
- whether an uninvited guest can "ask to join" depends on the Workspace settings and is checked in phase 1 (§14).

## 7. Flows by booker

Each flow uses §6.2–6.6.

### 7.1 Pharmacy → doctor consultation (scheduled)

| Step | Detail |
|---|---|
| Patient | Lookup by phone → self or relation; language; consent tick |
| Service | **Any doctor** (decision 9). The list sorts doctors at the booker's pincode first, then its city, then the rest. Within each group, doctors speaking the patient's language come first, then fee and next free slot. The booker's place is the pharmacy's `pincode` and `city` (`pharmacies/model/index.ts:59-69`), a lab branch's address or the doctor's practice; doctors use `specialists/model/index.ts:154-170`. Filters: speciality, mode, language. Then a date slot, mode (`video` / `call` / `in-person`) and the join choice |
| Coupon | Optional, if applicable (§6.3) |
| Pay | Pharmacy wallet (keyed and server-priced, replacing the unrouted `payConsultation`) or Razorpay |
| Notices / SMS | Patient and doctor in-app; SMS booked and reminder; "prescription ready" when the doctor saves it |
| Pharmacy sees | Its booking list: status, slot, Join call, then the prescription (structured + PDF), with the option **Create medicine order** (§9.3) |
| Patient later sees | After OTP sign-in: the consultation under Bookings (for the family member), "Booked by <pharmacy>", the prescription; may cancel (§8.7) |

API:
- `POST /api/v1/pharmacy-assisted/consultations`
- `GET /pharmacy-assisted/bookings` and `GET /pharmacy-assisted/bookings/:id`
- `POST /pharmacy-assisted/bookings/:id/pay` and `POST /pharmacy-assisted/bookings/:id/cancel`
- the by-key routes

### 7.2 Pharmacy → lab test

| Step | Detail |
|---|---|
| Patient | As 7.1 |
| Service | Partner labs sorted nearby first (pincode, then city) → branch → tests and packages → visit mode (home: address required; or lab visit) → slot (≥ 60 min ahead, Q3) |
| Coupon / pay | As 7.1; `PartnerLabBooking` gets the `assisted` block |
| Notices / SMS | Patient and lab in-app; SMS booked and reminder; "lab report ready" on release |
| Pharmacy sees | Status, lab reschedule proposals (it may accept, or cancel for a refund, for the patient), the **released** report |
| Patient later sees | The lab booking and its report under Reports; may cancel (§8.7) |

### 7.3 Lab → doctor consultation

As 7.1 (scheduled) or 7.7 (instant), done by a lab member holding `assisted.book`. `bookedBy.branchId` is the member's
branch, and "nearby" uses that branch. The lab wallet or Razorpay pays. The lab sees the prescription. It may book its
**own** recommended tests at its desk (§7.5). A lab cannot book another lab's tests (decision 1).

### 7.4 Doctor → lab test

| Step | Detail |
|---|---|
| Patient | From one of the doctor's consultations (patient = that booking's account and family member; no lookup), or a walk-in found by phone. Language and consent as usual |
| Service / coupon / pay | As 7.2, with the doctor wallet or Razorpay |
| Doctor sees | The booking's status and its released report, in the portal (`/specialists/me/assisted/lab-bookings`) |
| Cut | Built but **0** while `REFERRAL_DOCTOR_CUTS_ENABLED=false` (decision 2): the lab earns the whole base |

### 7.5 Lab front desk (the lab's own tests)

| Step | Detail |
|---|---|
| Patient | Lookup → self or relation; language; consent |
| Service | The lab's own catalogue at a branch in the member's scope. **Lab visit** (slot or walk-in now) or **home collection** (address, home slot, collector) |
| Pay | **Paid at the lab** (`lab_desk`); the desk issues its Q2 bill linked to the booking. No Jansetu money and no cut |
| Steps | Existing lab steps (assign collector, collect or visit, processing, upload, release with signer, complete). No-show rules apply, but nothing is refunded through us |
| Notices / SMS | Patient in-app; SMS booked (scheduled bookings), reminder (home collection and scheduled visits), "lab report ready" |
| Patient later sees | The booking, the bill under Bills, the report under Reports |

API: `POST /partner-workspace/lab-desk/bookings` (`bookings.manage`, branch scope) and the by-key routes. Other steps
reuse `/lab-bookings/:id/*`.

### 7.6 Doctor recommends tests

1. **Writing it.** In the prescription form the doctor adds recommended tests (name, optional code, note). Saving
   creates the `test_recommendation` with its `code`, and the PDF prints the code and test names.
2. **Booking it later:**
   - **Patient (app):** "Recommended tests → Book" opens the partner-lab search with the names pre-filled. It is an
     ordinary customer lab booking with `recommendationId`.
   - **Pharmacy or lab:** loads the recommendation by **the code printed on the prescription plus the patient's
     phone** (ASSUMED). On a match it gets **only the test names**, then books through 7.2 (pharmacy) or the desk 7.5
     (lab, its own tests).
3. **Tracking.** Each booking records the items it covered; the recommendation becomes `partly_booked` or `booked`.
   This is information only, never a lock.
4. **Matching names.** Lab catalogues are each lab's own, so the booker matches names to items by hand. A shared
   test-code list is later work.
5. **The recommending doctor** earns no cut and does **not** see the report (decision 7). The report goes to the patient
   and to the partner that booked the test. If the patient later consults that doctor again, the doctor sees it then,
   as any treating doctor does (§9.1).

### 7.7 Partner → instant "Consult now" (decision 10)

Reuses the Q4b instant flow (`doctors/services/instant.ts`): presence, quote, 5-minute offers, re-offer,
first-accept-wins, atomic accept.

| Step | Detail |
|---|---|
| Patient | As 7.1 |
| Service | Online doctors by speciality and mode (nearby and language first, as 7.1), a specific doctor or "any available"; join on the partner device or the patient's phone |
| Pay | The partner pays the **quoted amount** (after any coupon) by wallet or Razorpay into the request's held funding, with the partner as payer (`assisted_instant` context). One method only |
| Accept | Unchanged: in one transaction, the doctor's fee is allocated, the booking is created with the `assisted` block, and the split and cut are snapshotted on the allocated base |
| Quote difference | Refunded to the partner **by method** at acceptance: wallet → wallet; Razorpay → partial Razorpay refund. This replaces Q4b's "to the customer wallet" for partner-paid requests |
| Nobody accepts | The partner re-offers or requests a refund (by method). The 30-minute inactivity refund applies to the partner's screen activity |
| After accept | No cancellation by anyone except the doctor or an admin (Q4b), with a full refund to the partner by method. A no-show follows §8.6 (an instant no-show is final; it is never rescheduled) |

## 8. Money

### 8.1 Worked example (plain words)

Rules for **Sharma Medicals**: consultation 10%, lab test 5%, package ₹40 fixed (per line). Doctor's fee ₹500.

| Step | Sharma wallet | Doctor | Sharma referral (payouts) | Jansetu |
|---|---|---|---|---|
| Sharma tops up ₹2,000 by Razorpay | ₹2,000 | — | — | Holds ₹2,000 for Sharma; pays the gateway fee itself |
| Books Rina's consultation and pays from the wallet | ₹1,500 | — | — | ₹500 held for the doctor and Sharma |
| Rina pays Sharma ₹600 at the counter (Sharma's own price) | — | — | — | Not Jansetu's money |
| The doctor completes it | — | **₹450** | **₹50** | Pays out exactly the ₹500 it received; its only cost is the gateway fee |

Sharma: collected ₹600, paid ₹500, earns ₹50 → **+₹150**. Doctor: ₹500 − ₹50 cut = **₹450**.

**With a coupon** of ₹100 on the same consultation (coupon first, then the cut): Sharma pays ₹400. The base is ₹400,
the 10% cut is ₹40, and the doctor earns ₹360.

**Lab example:** Sharma books CBC (₹300) and a thyroid package (₹800) at City Lab. The cut is 5% of ₹300 = ₹15, plus
the fixed ₹40 for the package line, so ₹55. City Lab earns ₹1,100 − ₹55 = ₹1,045, and Sharma earns ₹55. If a doctor
had booked it, the doctor's cut would be ₹0 while the switch is off, and City Lab would earn ₹1,100.

| What happens next | Money |
|---|---|
| Cancelled (by the partner, the patient or the provider), rejected or expired | Everything back to the partner by its method; no earnings, no cut |
| Patient does not come (no-show) | Nothing back to the partner; the provider is not paid; no cut; Jansetu keeps the money. One move is allowed; if that visit happens, the provider earns ₹450 and the partner ₹50 |

### 8.2 Wallet ledger

| Movement | Wallet | Rule |
|---|---|---|
| Top-up (Razorpay captured) | + full amount paid | Once per payment record; unknown or failed captures never credit; Jansetu bears the fee |
| Booking or instant request paid from the wallet | − price after coupon | Same transaction as the booking or request; once |
| Refund to the wallet | + refunded amount | Once per refund row; only for wallet-paid bookings, or by the partner's choice after a failed card refund |
| Withdrawal requested | − amount (`withdrawal_hold`) | Same transaction as the request; not above the balance |
| Withdrawal rejected | + amount (`withdrawal_release`) | Once per request |
| Withdrawal paid | — (already held) | The admin records method, UTR and date to the verified destination (Q5) |
| Admin adjustment | ± with a reason | Audited; never below 0 |

Invariant (checked daily, §8.8): balance = Σ entries, and the pharmacy balance in paise equals `balancePaise`.

### 8.3 Earning base, coupon, cut and provider earning (decision 1)

Order, for every ledger booking created after deployment (`earningRule: 'provider_coupon_v2'`):

1. **List price:**
   - consultation: the doctor's fee (instant: the allocated instant fee);
   - lab: the catalogue line prices.
2. **Coupon first:** base = list − coupon discount. For labs, the discount is spread over the lines in proportion to
   their price. Paise are rounded by largest remainder, so the line bases add up exactly to the booking base.
3. **Then the cut** (assisted bookings with a rule):
   - `percent`: `floor(lineBase × bp / 10000)`;
   - `fixed`: `min(fixedMinor, lineBase)`, per test or package line for labs, once for a consultation;
   - then the optional `capMinor`;
   - never more than the line base.
4. **Provider earning** = base − cut. The partner pays the base. Jansetu receives the base and pays it all out (provider
   + partner), and bears the gateway fees.

Scope of the coupon change (ASSUMED): the owner's "coupons are now borne by the provider" applies to **every** ledger
booking made after the deploy, not only assisted ones. It replaces the Q3 lab earning (subtotal before coupon) and the
Q4a doctor earning (`originalPrice`). Earlier bookings keep their old rule, because completion reads `earningRule` from
the booking. A free (₹0) booking needs no payment and earns nothing.

### 8.4 Refunds by method

| Paid by | Refund route |
|---|---|
| Wallet | Credited to the same wallet **in the cancelling transaction** (`refund_credit`, once) |
| Razorpay | The cancelling transaction records a refund row `{ method: 'razorpay', state: 'pending', attemptId }`. A worker reusing the fenced refund-to-source code (`pharmacyOrders/prescriptionRefund.ts:45-110`) submits it, checks it and settles it. `processed` → `refunded`. A terminal failure goes to an operator queue, where an admin may credit the wallet only with the partner's recorded agreement. An unknown answer is never retried blindly |

The refund budget is the amount paid minus everything refunded (instant quote differences included). Every refund
happens before completion, and completion is terminal, so no refund ever follows an earning.

### 8.5 How the cut posts

- **When.** On **completion only**, in the same transaction as the provider earning: alongside
  `postConsultationEarningIn` for consultations, and `postEarning` in `complete` for labs.
- **Two entries, both exactly once by the ledger's unique key:**
  - provider service account: `earning` = `split.providerMinor`, `grossMinor` = base, `commissionMinor` = cut, source
    `consultation` / `partner_lab_booking`;
  - booker referral account: `earning` = cut, `grossMinor` = base, source `referral_consultation` /
    `referral_lab_booking`.

  The referral state then becomes `earned`. A zero cut (no rule, or doctor switch off) posts no referral entry.
- **Never** on a no-show, cancel, reject, expiry or lab desk booking.
- **Payouts.** Labs see referral earnings in workspace finance, doctors in `/specialists/me/finance` (0 while the
  switch is off), pharmacies in a new pharmacy finance screen with a payout destination. Payouts from referral
  accounts wait for `REFERRAL_PAYOUTS_ENABLED` (§5.4; OPEN-OWNER, tax).
- **Correction.** An admin `adjustment` with a reason (Q5).

### 8.6 No-show (decided)

- No refund to the partner, the provider is not paid, no cut, and Jansetu keeps the money.
- One reschedule, by the provider, the desk or an admin (Q14 routes); earnings and the cut then post on completion as
  usual.
- A second no-show is final. A booking moved after a no-show is never refunded (Q14 `NO_SHOW_NOT_REFUNDABLE`).
- An instant no-show is final.

### 8.7 Cancellations (decisions 5 and 6)

| Who | When | Refund |
|---|---|---|
| Booking partner | Scheduled consultation: **any time before it starts**. Lab booking: **up to 1 h before the slot** (and any time while a lab reschedule is unanswered, Q3) | Full, to the partner by method |
| Patient in the app | The existing customer windows (ASSUMED): consultation until 24 h before (48 h on Mondays, `cancellationWindow.ts:96`); lab until 2 h before (Q3) or while a reschedule is unanswered. Instant: not after acceptance (Q4b) | Full, **to the partner** by method. The partner sees "cancelled by patient"; the patient never receives the money (§14) |
| Doctor / lab reject / admin | Any time before completion | Full, to the partner by method |
| Payment window passed | 30 min unpaid | Nothing was taken; a late capture goes back to source |

All cancellations share one settlement transaction per booking kind: CAS on state, seat and interval released, coupon
use reversed (as today), refund rows written, audit. A partner cancellation carries `expectedUpdatedAt` or
`expectedVersion`.

### 8.8 Reconciliation

A daily job, with an admin report, checks that:
- wallet balances = Σ entries;
- each paid assisted booking or request has exactly one funding;
- each refund row is `refunded` or in the operator queue;
- each completed booking has its provider entry and, when the cut > 0, its referral entry, with provider + cut = base;
- each withdrawal is either held and open, paid with a UTR, or released;
- Razorpay totals for top-ups, `assisted_*` payments and refunds match the payment records.

Mismatches are reported, never auto-corrected.

## 9. Access to records (least privilege, decision 7)

### 9.1 Who sees what

| Reader | Bookings it made | Anything else of the patient |
|---|---|---|
| Booking pharmacy | Booking, status, Join call, prescription (structured + PDF); lab bookings: status and **released** report | Nothing |
| Booking lab member (`assisted.book`, branch in scope) | Its consultations, with their prescriptions | Nothing |
| Booking doctor (lab test) | Status and released report | Only as a treating doctor (next row) |
| **Treating doctor** | — | While treating: that patient's past consultations (any doctor; diagnosis, advice, prescriptions) and released lab reports (partner-lab and Healthians/LabStack) |
| Doctor who only recommended tests | — | Nothing from the recommendation; access only as a treating doctor |
| Patient (account holder after OTP) | Everything | Everything (existing customer reads) |

**Treating (ASSUMED):**
- The doctor has a consultation with this exact patient (account + family member, or the holder) that is `confirmed`
  or in progress, or `completed` within the last 30 days.
- The access covers that person only, not the whole family.
- It ends when the window closes, or at once if that booking is cancelled.

Not shown to bookers: drafts, documents the patient uploads later, payment record internals, other bookings, the family
list.

### 9.2 Code changes

- **`file/access.ts` `canReadBooking`** gets field-aware rules:
  - Booker (pharmacy by `assisted.bookedBy` or the legacy `pharmacyId`; lab member by `assisted.bookedBy` plus current
    membership, permission and branch through `partnerMemberMayRead`): **only** `prescription.fileUrls` and the server
    prescription folder (`BOOKING_PRESCRIPTION`).
  - Treating doctor: the prescription files of the patient's other consultations.
  - `documents.url` and `report.fileUrls` stay with the patient and that booking's doctor.
  - The binding `field` is known where grants are checked (`decideFileAccess`, `:242-262`). This **narrows** today's
    pharmacy rule (`:41`).
- **`canReadPartnerLabReport`** (`:80-89`) and **`canReadLabReport`** (`:59-63`): released files also for a
  `pharmacy` or `specialist` matching `assisted.bookedBy`, and for a treating doctor. Drafts never.
- **Doctor history.** `getPatientHistory` (`specialistPortal/services/index.ts:399-429`) becomes treating-gated and
  per person (`dependentId`-aware). It lists all past consultations and released reports in an allowlisted view.
  Today it lists only the doctor's own consultations, which it keeps when not treating.
- **Booker reads.** New booker endpoints (§7) filter on `assisted.bookedBy` = the admitted actor, return an allowlisted
  view, and page by cursor. The generic `/bookings` stays as fixed by S2.
- **Ending access.** Access ends with authority: a pharmacy no longer operational, a member deactivated, a permission
  or branch removed (checked on every request).
- **Prescription access lifetime (ASSUMED).** The booking pharmacy or lab keeps access while the booking exists and the
  booker is active.

### 9.3 Prescription → medicine order (decision 9)

1. The prescription screen offers **Create medicine order** to the booking pharmacy only.
2. `POST /pharmacy-orders` takes `prescriptionFromBookingId`. The server checks that:
   - this pharmacy booked it;
   - the consultation has a prescription PDF;
   - the customer is the booking's account.
3. The server then sets `prescriptionUrls` to that PDF and binds it to the order (`pharmacy_order` grant) itself. The
   uploader rule (`:294-299`) is not loosened for values sent by clients.
4. Prescribed medicines pre-fill as **suggestions** matched by name to the pharmacy's inventory. The pharmacist
   confirms. P9 Rx review, stock and payment modes apply unchanged.
5. It is optional: nothing is created automatically.

## 10. SMS

### 10.1 `.env` variables (decision 15)

```
SMS_NOTICES_ENABLED=false              # master switch for the four messages (OTP and bills are separate)
SMS_SEND_TIMEOUT_MS=5000               # provider call timeout (today there is none)
SMS_NOTICE_MAX_ATTEMPTS=3
SMS_FALLBACK_LANGUAGE=en               # ASSUMED: English when the preferred language has no enabled template
SMS_UNICODE_PARAM=                     # provider flag for non-Latin text, confirmed in phase 5
SMS_VISIT_REMINDER_MINUTES_BEFORE=120  # skipped when the booking is made inside this window
SMS_JOIN_LINK_BASE_URL=                # https://<app-domain>/j (the DLT-approved domain)

# Per message and per language <LANG> = EN HI OR BN AS LUS MNI KHA GRT NE …: an id and an on/off switch.
SMS_BOOKED_<LANG>_TEMPLATE=            SMS_BOOKED_<LANG>_ENABLED=false
SMS_BOOKED_LINK_<LANG>_TEMPLATE=       SMS_BOOKED_LINK_<LANG>_ENABLED=false       # video on the patient's phone
SMS_RX_READY_<LANG>_TEMPLATE=          SMS_RX_READY_<LANG>_ENABLED=false
SMS_REPORT_READY_<LANG>_TEMPLATE=      SMS_REPORT_READY_<LANG>_ENABLED=false
SMS_REMINDER_<LANG>_TEMPLATE=          SMS_REMINDER_<LANG>_ENABLED=false
SMS_REMINDER_LINK_<LANG>_TEMPLATE=     SMS_REMINDER_LINK_<LANG>_ENABLED=false     # video on the patient's phone
```

- The template **text** lives in the repo (`sms/templates/<lang>.ts`), byte-for-byte the registered DLT text with
  `{#var#}` placeholders. Changing it means registering it again.
- A message is sent only when the master switch, that message's switch for that language and its template id are all
  set.
- The `_LINK_` variants are the "with link" form of the same two messages (decision 8). While they are unset, the plain
  form is sent and the patient joins through the app.

### 10.2 Messages and variables

Sent to the **account phone** for assisted and lab desk bookings. Every variable is cut to 30 characters or fewer. No
doctor name or speciality, test names, diagnosis or amounts. The only link is the join link of §6.6. Records are
reached by signing in with the number, as the bill SMS does (`sms/services/index.ts:48-53`).

| Message | Variables | English text (draft for DLT) |
|---|---|---|
| booked | `name` (patient first name), `service` ("doctor video call" / "doctor phone call" / "doctor visit" / "lab test" / "home sample collection"), `date`, `time`, `place` (booker or lab branch), `ref` | `SwasthaDisha: {#var#}'s {#var#} is booked for {#var#} at {#var#} via {#var#}. Ref {#var#}. Sign in to the SwasthaDisha app with this number for details.` |
| booked, with link | As above + `link` | `… Ref {#var#}. Join the video call at {#var#} at the booked time.` |
| prescription ready | `name`, `date` (consultation), `place` (booker) | `SwasthaDisha: the prescription for {#var#} from the consultation on {#var#} is ready. Sign in to the app with this number, or ask {#var#}.` |
| report ready | `name`, `date` (test), `place` (lab) | `SwasthaDisha: the lab report for {#var#} from {#var#} ({#var#}) is ready. Sign in to the app with this number to see it.` |
| reminder (with or without link) | `name`, `service`, `date`, `time`, `place` [, `link`] | `SwasthaDisha reminder: {#var#}'s {#var#} on {#var#} at {#var#}, {#var#}.` [+ ` Join: {#var#}`] |

The brand word follows the registered sender and header; it must match the bill template already in use. Instant
consultations start at once, so they get "booked" (with link when applicable) and no reminder.

### 10.3 Language

The booking's `assisted.preferredLanguage` is used when that message is enabled with a template in that language.
Otherwise `SMS_FALLBACK_LANGUAGE` (English, ASSUMED) is used; if that is not enabled either, nothing is sent. The
service words are sent in the same language; names and places are sent as typed.

### 10.4 SMS never affects a booking

- **After commit only.** The booking transaction never calls SMS code. After commit the service tries to insert one
  `Job` (`consumer: 'sms_notice'`, `uniqueId: sms:<message>:<bookingId>[:<version>]`); a failed insert is logged and
  ignored.
- **The consumer:**
  - re-reads the booking and skips if the state no longer fits (cancelled, already sent, unconfigured);
  - calls the provider with the timeout;
  - retries with back-off up to the maximum, then drops the job;
  - logs only the message kind and outcome, never phone numbers or patient details.
- **Answers never depend on SMS.** Creates, payments, releases and replays answer the same whether SMS is off, failing
  or slow. `uniqueId` blocks repeats, and a replayed create enqueues nothing.
- **Reminders** are scheduled jobs (like `bookingReminderScheduler`), cleared on cancel and re-planned on a move.
- **Tests** cover unconfigured, provider error, provider hang (timeout) and success, with identical booking outcomes.

### 10.5 DLT

- Each message × language (× link variant) is a separate template, registered under the existing entity (PE) id and
  header.
- Non-Latin languages are Unicode templates.
- Link templates need the join domain approved for URLs.
- Approval takes days per batch and rejections are common, so registration **starts in phase 0** with English and
  Hindi; the order of the north-east languages is OPEN-OWNER (§12.2).

## 11. Languages and UI translation (separate workstream, phase 6)

### 11.1 Languages (decision 14)

| Language | Code | Script | Note |
|---|---|---|---|
| English | `en` | Latin | Source language |
| Hindi | `hi` | Devanagari | |
| Odia | `or` | Odia | |
| Bengali | `bn` | Bengali | |
| Assamese | `as` | Bengali–Assamese | |
| Mizo | `lus` | Latin | |
| Manipuri (Meitei) | `mni` | Bengali or Meetei Mayek | Script to choose with the translators |
| Khasi, Garo | `kha`, `grt` | Latin | |
| Nepali (Sikkim), Bodo | `ne`, `brx` | Devanagari | |
| Kokborok, Nagamese | `trp`, (none) | Latin / Bengali | Later waves |

The list is configuration. A language appears in a switcher once its catalogue is ≥ 95% reviewed. The booking
`preferredLanguage` may be any listed code, even before that UI exists.

### 11.2 Web apps (`jansetu-web`: Vite + React 19, workspace and customer apps)

- **Library:** `i18next` + `react-i18next`, for lazy namespaces, React 19 hooks and plurals through `Intl.PluralRules`
  (CLDR gaps fall back to English rules).
- **Catalogues:** `packages/ui/src/i18n/locales/<lang>/<namespace>.json`, with namespaces `common`, `auth`, `booking`,
  `assisted`, `pharmacy`, `lab`, `clinic`, `doctor`, `finance`, `customer`, `admin`. English is the source of truth.
  Other languages load on demand through dynamic import. A missing key falls back to English.
- **Hard-coded strings:** CI runs `i18next-parser` (fails on keys missing in `en`) and a literal-JSX-text lint;
  a pseudo-locale is used in QA; Playwright takes a screenshot per language for overflow.
- **Switcher:** in the header menu of both apps and on sign-in. It sets `<html lang>` and loads the script's Noto font
  only when chosen.
- **Stored choice:**
  - before sign-in: `localStorage` (`jansetu.lang`);
  - after sign-in: the person's `uiLanguage` (§5.2) through `PUT /me/ui-language { language }` for each actor type;
  - the server value wins at sign-in;
  - a customer's first sign-in proposes the language recorded at their assisted booking.
- **Formats:** `Intl` with `<lang>-IN`, falling back to `en-IN`; ₹ with Indian grouping.
- **Server messages:** the UI translates the error `code`, with the server's English `message` as the fallback. Server
  PDFs and admin-only screens stay English in this phase.
- **Translation:** professional translators plus native-speaker clinical review; translators work on the JSON or
  through a self-hosted open-source tool (Tolgee or Weblate, chosen in phase 6).

### 11.3 SMS language

§10.3. Four SMS messages form a small separate catalogue, so SMS can be multilingual long before the UI.

## 12. Assumed and still open

### 12.1 Assumed (defaults chosen in this design; the owner may override)

| # | Assumption | Where |
|---|---|---|
| A1 | A booking pharmacy or lab keeps access to the prescription while the booking exists and the booker is active | §9.2 |
| A2 | SMS falls back to English when the preferred language has no enabled template | §10.3 |
| A3 | Partners load a doctor's recommended tests by the code printed on the prescription plus the patient's phone | §7.6 |
| A4 | "Coupons are borne by the provider" applies to every ledger booking made after the deploy, not only assisted ones; earlier bookings keep their rule | §8.3 |
| A5 | A lab coupon is spread over the lines in proportion to price (largest-remainder paise) before the per-line cut | §8.3 |
| A6 | "While treating" = a confirmed or in-progress consultation with that exact person, or one completed in the last 30 days; past consultations of any doctor and released reports are shown | §9.1 |
| A7 | A recommending doctor gets no access from the recommendation; a later consultation with that doctor gives normal treating access | §7.6, §9.1 |
| A8 | A patient cancelling a partner-paid booking in the app follows the existing customer windows (consultation 24 h, 48 h on Mondays; lab 2 h; instant not after acceptance) | §8.7 |
| A9 | A one-word holder name is masked as its first two letters + "…"; an unnamed account shows no name | §6.2 |
| A10 | The patient's app shows "Paid by <partner>" and not the amount the partner paid Jansetu (the partner may charge a different price) | §7, §14 |
| A11 | Doctor cut rules can be saved while the switch is off; they snapshot as 0 and apply only to bookings made after the switch is turned on | §5.4 |
| A12 | The SMS join link uses a Jansetu domain that redirects to Meet inside the join window | §6.6 |
| A13 | Instant requests carry no partner cancellation after acceptance, as for customers (Q4b) | §7.7 |

### 12.2 Still open for the owner

| # | Question | Status |
|---|---|---|
| O1 | **Tax on referral payments:** whether partners must invoice Jansetu (GST) and whether TDS applies. Referral payouts stay behind `REFERRAL_PAYOUTS_ENABLED=false` until the accountant answers; cuts accrue meanwhile | **OPEN-OWNER** |
| O2 | **Wallet limits and checks:** minimum and maximum top-up, maximum balance, which documents must be verified before a wallet is used, and the rules for withdrawals now that they are allowed (minimum amount, how often, a waiting period after a card top-up to deter card-to-bank cash-out) | **OPEN-OWNER** (proposed: max balance ₹50,000; withdrawal only to the verified payout account in the partner's name; top-ups withdrawable after 7 days) |
| O3 | **Patient app and the partner's payment:** confirm A10 (show "Paid by <partner>", hide the amount) | **OPEN-OWNER** (A10 applies until then) |
| O4 | **Which north-east languages to register first** for SMS (after English and Hindi), and the Manipuri script | **OPEN-OWNER** |

## 13. Phased delivery

Each phase = backend + web screens + integration and browser tests + independent review. Commits stay local; stage
only on the owner's word. Sizes: S ≈ days, M ≈ 1–2 weeks, L ≈ 3+ weeks.

| Phase | Content | Size |
|---|---|---|
| **0** | S2 hotfix (separate, assumed shipped). Pharmacy prescription bug: (a) "Bookings I made" list and detail with the prescription (`pharmacyId` = me, allowlisted view); (b) the pending booking shows its expiry and **Pay now** (existing pay-again); (c) "Create medicine order from this prescription" with server-side binding (§9.3); (d) check a pharmacy-sent `dependentId` against the account. Start DLT registration (en, hi) | S–M |
| **1** | `assisted` block, `source`, consent, language; lookup with masked name and create via the resolver; nearby-first doctor list; coupons on assisted bookings; keyed, server-priced pharmacy wallet payment; Razorpay partner payment context; refunds by method; partner and patient cancellation rules; pharmacy-booked scheduled consultations end to end with Join call / call number and Meet without patient email; booker-only prescription access (§9.2); generic create closed to pharmacies | L |
| **2** | Lab wallets and top-up; pharmacy → lab; lab → consultation (`assisted.book`, `wallet.*`); lab front desk with lab visits, walk-ins and home collection, bill link; booker access to released reports | L |
| **3** | Doctor wallet; doctor → lab; structured recommended tests, code on the PDF, patient "Book recommended tests", partner lookup by code + phone; **partner instant consults** (partner-funded request, quote difference by method); treating-doctor history and report access (§9) | L |
| **4** | Provider-borne coupons and the cut (`provider_coupon_v2` earnings for all new ledger bookings); referral rules (admin screens, history, version fence, doctor switch off); referral settlement accounts and index migration; pharmacy finance screen; wallet withdrawals (request, admin pay/reject); referral payouts behind `REFERRAL_PAYOUTS_ENABLED`; referral and reconciliation reports | M–L |
| **5** | SMS: `sms_notice` consumer with timeout and retries, templates per message and language with per-language switches, link variants and the `/j/<token>` redirect, reminder jobs; Unicode verified with the provider | M |
| **6** | UI translation: i18next setup, catalogues, switcher, `uiLanguage` on every actor, fonts, CI checks; first languages hi, or, bn, as, lus, then more | L (engineering) plus translation time |

Phase 5 can run beside phases 2–4 once phase 1 has the `assisted` block; DLT approval sets its real start. The
coupon and cut change of phase 4 must reach production before referral rules are entered, so no booking is made with
a rule but without the split.

## 14. Risks

| Risk | Why it matters | Mitigation in this design |
|---|---|---|
| **Wrong or recycled number** | Phone-only identity: a typo puts a patient's records in a stranger's account, seen after that stranger's OTP sign-in | New numbers typed twice; `newAccount` shown; the "booked" SMS alerts the real holder; an admin tool moves a wrongly booked booking to the right account (audited); recycled numbers remain a risk for every OTP account |
| **Privacy on a shared phone** | Family members read SMS and the app | SMS without health details (§10.2); records only after OTP; the join link opens only the call; booker access limited to its own bookings and to the prescription or released report |
| **Wider doctor access** | Treating doctors now see consultations of other doctors | Treating window per person (A6), allowlisted view, read log; access ends with the window or cancellation |
| **Name hints at lookup** | Partners can test numbers | Masked name only (decision 12), rate-limited per actor, audited; alerts on unusual volume |
| **Booking any number without OTP** | Accounts and SMS for people who never agreed | Recorded attestation with statement version; the partner pays for every booking; limits on new accounts per booker per day (default 30) and on assisted bookings per number per day (default 5), shared across instances like O1 OTP limits; numbers booked by many partners flagged |
| **Patient cancels after paying the partner in cash** | The refund goes to the partner (decision 6), so the patient may be out of pocket | The patient's cancel screen says the money returns to "<partner>" and to ask the partner for theirs; the partner is told at once; partner terms state its duty to repay; disputes are audited |
| **Minors** | Children are booked under a parent's number; the DPDP Act expects parental consent | The holder (parent) is the consent relation, and the attestation statement says so; legal review of the wording |
| **Provider-borne coupons and cuts** | Providers earn less than before, and earning reports change for all new ledger bookings (A4) | Rule recorded per booking (`earningRule`); provider statements show list, coupon, cut and net per row; tell providers before phase 4 |
| **Doctor cut legally sensitive** | NMC ethics rules restrict doctors taking commissions for referrals | Switch off by default (decision 2); turning it on is a configuration change after legal advice |
| **Wallets as stored value with withdrawals** | Allowing cash-out moves the wallet closer to a regulated prepaid instrument (RBI; PHONE_CONSULTATIONS §6); card-to-bank cash-out abuse | Withdrawals only through an admin, only to a verified account in the partner's own name, with limits (O2); finance and legal review before go-live |
| **Money reconciliation** | Wallet balances are owed money; card refunds can fail or hang; rupee/paise conversion; provider + cut must equal base | One method per booking; paise everywhere new; exactly-once keys; refund worker with an operator queue; daily reconciliation (§8.8) |
| **DLT timelines** | Each template × language × link variant needs approval; Unicode and URL templates are often rejected | Register early (phase 0); English fallback; switches off by default; app join always works |
| **Meet access for walk-ins** | Meet needs invited emails; Workspace settings may block guests | Booker email as attendee; "call" mode as a fallback; verified in phase 1 |
| **Translation quality** | Medical words mistranslated | Native-speaker clinical review; English always available |

## 15. Verification (to build with each phase)

- **Request keys:** the same key and request answer once, with one debit, one seat and one SMS job; a different
  request under the key is 409; a key abandoned before commit never books.
- **Wallet races:** two bookings competing for the last ₹500 → one wins, one 409 `INSUFFICIENT_BALANCE`, never
  negative. A withdrawal and a booking competing for the same balance cannot both succeed.
- **Razorpay:** a capture after expiry is refunded to the card, never to a wallet or the patient; duplicate webhooks
  credit once. An instant quote difference is refunded by method, once.
- **Patient's wallet:** a partner-paid booking never moves it (retry-payment, cancellation by anyone, expiry).
- **Money outcomes:**
  - ₹500 at 10% → doctor ₹450, partner ₹50;
  - with a ₹100 coupon → partner pays ₹400, doctor ₹360, partner ₹40;
  - lab lines with fixed and % cuts per line;
  - doctor booker with the switch off → cut 0, lab earns the whole base;
  - provider + cut = base on every completed row.
- **Cancellations:** a partner cancelling a consultation one minute before it starts is refunded; a lab booking 59
  minutes before is refused. A patient cancellation refunds the partner and notifies it.
- **No-shows:** cancel, reject and no-show, or no-show moved then completed, give exactly the earnings, cuts and
  refunds of §8.
- **Booker access:** a pharmacy reads only the prescription of its own booking. A member losing `assisted.book` or a
  branch loses access at once. Drafts are never readable by bookers.
- **Doctor access:** the recommending doctor cannot read the report. A treating doctor can read past consultations and
  reports of that person only, inside the window.
- **Lookup masking:** "Rina Kumari Das" → "Rina D."; nothing else returned.
- **Medicine orders:** "Create medicine order" works only for the booking pharmacy; a prescription URL sent by a client
  is still refused.
- **SMS:** off, failing, timing out or succeeding gives identical booking answers; a per-language switch off falls back
  to English; replays send nothing; the join link opens Meet only inside the window.
- **Rule edits:** a referral rule edited after a booking leaves that booking's snapshot unchanged.
