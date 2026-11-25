# Assisted booking: partners book for walk-in patients (design, 2026-11-22)

Status: **phase 0 built** (branch `m0/r2-assisted-phase0`, build record §18) and **phase 1a built** (branch
`m0/r3-assisted-phase1a`, build record §19); local commits, not pushed. Both merged onto the stage line as
`m0/r4-assisted-stage` with the stage enable runbook (§20). **Phase 1b built** (card/UPI per booking, branch
`m0/r10-phase1b`, build record and web API §23; local commits, not pushed). Phase 2 and later: design only.

- **Revision 2** folded in the owner's 22 Nov answers (§2.2).
- **Revision 3** applies all 20 findings of the independent review of 4b44435 and the coordinator's overnight decisions
  A–I (§2.3).
- **Revision 4** applies the re-review of 4aa13b0 (N1–N13 and remainders) and the coordinator's phase 1a decisions, so
  phase 0 and phase 1a can be built without guessing. The consolidated build specification is §17; where an earlier
  section and §17 differ, §17 wins.

Owner decisions are requirements, not choices made here. Implementation follows the gates in
[AGENTS.md](../../../AGENTS.md) and the established rules of
[Q_PARTNERS_LABS_CLINICS_DESIGN.md §11](Q_PARTNERS_LABS_CLINICS_DESIGN.md). Capability rows: C02 (assisted booking,
Partial) and C11 (partner-paid consultations, Missing) in [CAPABILITY_MATRIX.md](../CAPABILITY_MATRIX.md).

**Hotfixes this design builds on:**

| Hotfix | Commit | State | What it does |
|---|---|---|---|
| **S2** | `ad0407e` | On production | Doctors and pharmacies read only their own bookings through `/bookings` |
| **S3** | Branch `hotfix/s3-pharmacy-booking-scope`, `c3cea5e` + `19c81a1` | Shipping | A pharmacy books and orders only for a customer already linked to it with recorded consent. It never spends the customer's wallet, never books the free follow-up, and never sends another account's family member |

Neither hotfix is on this design branch (base `36bc35a`); both are assumed merged before phase 1.

**Labels used in this document:**
- **ASSUMED** — a default chosen by this design (§12.1).
- **ASSUMED (overnight, reversible)** — a coordinator decision taken while the owner was away (§2.3).
- **OPEN-OWNER** — waiting for the owner (§12.2).
- **GATE** — a legal or finance go-live gate (§12.2).

## 1. In plain words (for the owner)

Many people in rural areas and the north-east have no app, no smartphone, or one phone for the whole family. A
pharmacy, a lab or a doctor becomes their door to Jansetu.

1. **Finding the patient.** The partner types the patient's mobile number. If an account exists, the partner sees the
   holder's name partly hidden ("Rina K.") and asks how the patient is related to them. If no account exists, Jansetu
   quietly opens one for that number.
2. **Choosing the service.** The partner picks either:
   - a doctor, scheduled or instant "consult now" (any doctor on the platform, nearby ones first); or
   - a lab test.

   It then asks the patient's language, applies a coupon if one fits, and ticks "patient agreed".
3. **Paying.** The partner pays Jansetu straight away, from its Jansetu wallet or by Razorpay. It collects from the
   patient at its own counter, at its own price. Jansetu bears the gateway fees.
4. **Who earns what.**
   - The provider (doctor or lab) earns the price after a provider-funded coupon, minus the booking partner's referral
     cut.
   - Lab-test and package cuts work from the start.
   - Cuts on consultations, and every doctor's own cut, stay switched off until legal advice.
5. **Records.**
   - The booking partner sees the prescription or report of the booking it made: prescriptions for 90 days.
   - A pharmacy can turn a prescription into a medicine order.
   - A doctor treating the patient sees records from other providers only after the account holder approves once, with
     a code sent by SMS to their phone.
6. **The family's app.** When anyone later signs in with that number, they see every booking, prescription and report
   of the family. From the app they can:
   - cancel a partner-paid booking (the money returns to the partner);
   - report "this isn't mine".
7. **SMS.** Five messages (booked, prescription ready, report ready, reminder, cancelled/moved), each with its own
   switch per language, signed "Jansetu". An SMS never stops or undoes a booking.
8. **Wallet withdrawals.** Partners can ask an admin to send top-up money they have not spent to their bank account,
   minus the card fee, once withdrawals are switched on.

A lab also gets a **front desk for its own tests** (lab visits and home collection). The patient pays the lab, and the
report goes to the patient's app.

## 2. Decisions

### 2.1 Owner, 21 Nov 2026 (compared with the earlier phone proposal)

| # | Decision (requirement) | Difference from [PHONE_CONSULTATIONS.md](../PHONE_CONSULTATIONS.md) v1.7 |
|---|---|---|
| 1 | **Who books what:** pharmacy → consultation and lab test; lab → consultation; doctor → lab test, or recommends tests for later booking; lab front desk for its own tests (paid at the lab) | No IVR, PIN or call bridging in this scope |
| 2 | **Identity:** phone number only; one phone serves a family; existing account → holder's name and the relation → booked as a family member; new number → internal account, visible after OTP sign-in; ask the language | v1.7 treats the phone as a lookup hint and requires independent contact verification. Here the account stays `otpVerified: false` until its owner signs in |
| 3 | **Consent:** no OTP; the partner ticks "patient agreed" | Partner attestation, recorded and audited |
| 4 | **Payment:** the partner pays at booking; never pay-later, never the patient's wallet | v1.7's "Partner-paid consultation" model, extended to labs and doctors |
| 5 | **Wallets** for pharmacy, lab and doctor | v1.7 called lab and hospital wallets unsupported |
| 6 | **Refunds** go back the way the partner paid | Same principle |
| 7 | **Referral cut** per partner and category, % or fixed | v1.7 said referral creates no commission. Funding replaced on 22 Nov |
| 8 | **Records:** the booking partner sees the prescription or report; the patient sees everything | Limited here to the partner's own bookings |
| 9 | **Prescription → medicine order** (optional) | New |
| 10 | **Calls:** on the partner's device, or on the patient's or family's number | Meet or a phone call, not telephony bridging |
| 11 | **SMS**, never affecting a booking | Same minimal-content rule |
| 12 | **All UI languages** | Phase 6 |

Reused from v1.7:
- server-derived price, never `req.amount`;
- payer kept separate from beneficiary;
- one charge per operation;
- minimal SMS content;
- no per-minute charging;
- the RBI stored-value question (§12.2 GATE-RBI).

### 2.2 Owner, 22 Nov 2026 (replace earlier rules they contradict)

| # | Decision | Where |
|---|---|---|
| 1 | **Referral cut:** funded from the provider's earning (₹500 at 10% → doctor ₹450, partner ₹50); per partner and category, % or fixed; fixed lab cuts per line; % on the earning base. **Coupons borne by the provider; coupon first, then the cut** (coupon funding refined by overnight decision B) | §5.4, §8 |
| 2 | **Doctor cut:** setting built, kept OFF until legal advice | §5.4 |
| 3 | **Funding:** the partner pays at booking; Jansetu bears gateway fees; wallets for all three; withdrawal to the bank through an admin, paid like a payout | §5.3, §8 |
| 4 | **Refunds** by the partner's chosen method | §8.4 |
| 5 | **Partner cancels** a consultation any time before it starts, a lab booking up to 1 h before the slot | §8.7 |
| 6 | **Patient cancels** from the app; the refund goes to the partner | §8.7 |
| 7 | **Who sees records:** doctors see past consultations and reports while treating (refined by overnight decision A); pharmacies and labs only what they booked; a recommending doctor does not see the report | §9 |
| 8 | **Video on the patient's phone:** app Join, plus an SMS link once that template exists | §6.6, §10 |
| 9 | **Any doctor**, nearby first by city or pincode | §7.1 |
| 10 | **Instant "Consult now"** by partners | §7.7 |
| 11 | **Coupons allowed** when applicable (limited by overnight decision E) | §6.3 |
| 12 | **Masked holder name**, "Rina K." | §6.2 |
| 13 | **Lab desk:** lab visits and home collection | §5.5 |
| 14 | **Language:** asked at booking; UI translation in phase 6 | §5.2, §11 |
| 15 | **SMS:** template id and on/off switch per message and per language; never affects a booking | §10 |

### 2.3 Coordinator, overnight 22 Nov 2026: ASSUMED (overnight, reversible)

The owner asked for ethical, conservative choices while asleep. Each one is reversible by configuration or a small
change.

| Id | Decision | Where |
|---|---|---|
| **A** | **Other providers' records:** a doctor sees records from other providers only after the account holder approves once, by an SMS code sent to the holder's phone and entered by the doctor or partner. The doctor's own consultations with that patient need no code. Until approval, the doctor sees only what this booking includes | §9.1 |
| **B** | **Coupon funding:** each coupon has `fundedBy: 'provider' \| 'platform'`. Provider is the default; corporate and employer coupons default to platform; admins can change it | §5.7, §8.3 |
| **C** | **Unspent card top-ups**, when withdrawn, have their gateway fee deducted | §5.3 |
| **D** | **Fifth SMS:** "booking cancelled / moved", switched off by default | §10 |
| **E** | **Per-user-limited coupons** (e.g. once per user) are **not** allowed on partner-booked bookings, because the patient never sees them. Other coupons are allowed | §6.3 |
| **F** | **Consultation cuts:** behind `REFERRAL_CONSULTATION_CUTS_ENABLED=false` until legal advice, because they come out of the doctor's fee. Lab-test and package cuts are on | §5.4 |
| **G** | **Labs as bookers:** a lab that booked a consultation sees its prescription, as a pharmacy does | §9.1 |
| **H** | **Prescription access window:** the booking partner keeps prescription access for **90 days** after the consultation | §9.2 |
| **I** | **Brand:** "Jansetu" in every SMS and printed slip | §10, §5.6 |

## 3. Current state

| Area | What exists | Gap |
|---|---|---|
| Pharmacy creates a consultation | Generic `POST /bookings` and `/bookings/specialist`; the pharmacy sends `userId`, and `pharmacyId` comes from the token (`bookings/controller/index.ts:157-189`, routes `bookings/routes/index.ts:31-42`). S3 adds: linked customer only, no customer wallet, no follow-up, dependent checked. **The released pharmacy app uses this route** | No screen for the bookings a pharmacy made; money is still owned by the customer |
| Money of a pharmacy-made booking | The Razorpay order is owned by the **patient** (`bookings/services/index.ts:871-966`). A cancellation refunds to the **patient's** wallet (`bookings/holds.ts:284` `settleMoney`, `:311`) | Contradicts decisions 4 and 6 |
| Unpaid expiry | 30 min after reconciling with Razorpay (`bookings/services/index.ts:1741-1777`) | Bug cause 2 |
| Pharmacy wallet | Balance, history, Razorpay self top-up (`pharmacyWallet/routes/index.ts:13-24`; credit on capture `payment/services/index.ts:1488-1582`). `payConsultation` is unrouted, trusts `req.amount` and has no key (`pharmacyWallet/services/index.ts:153-279`). **Credits require `isActive: true`** (`pharmacyWallet/repository/index.ts:60-61`), so a refund to an inactive wallet fails | Needs a keyed route; withdrawals; credits that always post |
| Pharmacy customer list | Returns the account's `name`, `phone` and `email` and searches on them (`pharmacyCustomers/repository/index.ts:28-54`) | Defeats the masked-name rule |
| Customers by phone | `resolveCustomerByPhone` runs **outside** any transaction (upsert + duplicate retry), sources `partner_invoice` / `clinic_desk` (`partners/services/customerResolver.ts:64-93`); the desk calls it before its booking transaction (`partners/services/clinic.ts:549`) | Add source `assisted_booking` |
| Clinic desk (pattern) | Keyed per desk member with a content hash, family member created in the transaction, audit in the transaction, notices after commit (`partners/services/clinic.ts:477-610`) | Pattern for desks and assisted bookings |
| Partner lab bookings | Customer-only; refunds through the customer-wallet ledger (`partners/services/labBookings.ts:165-227`, `:436-448`); earning = subtotal before coupon (`:640-648`). Required fields include `slot.*`, `settlement.*` and `paymentDeadline` (`partners/model/labBooking.ts:74-157`) | Booker, partner funding, desk rows |
| Doctor earning | `originalPrice` before coupon (`doctors/services/earnings.ts:15-28`) | The coupon and cut rule changes this |
| Instant consultations | Customer-only; discount fixed on the quote (`doctors/services/instant.ts:248-262`); funding on the request (`doctors/model/instant.ts:38-105`, required `createRequestKey` `:93`); booking inserted at accept (`instant.ts:499-502`); quote difference to the customer wallet | Partner payer, refunds by method |
| Consultation inserts | Two insert points: `createBookingWithHolds` (`bookings/holds.ts:214-273`) and instant accept (`doctors/services/instant.ts:499-502`) | Both must stamp the new fields |
| Coupons | Usage counted per **payment record** (`coupon/usage.ts:27-70`). The per-user limit counts paid records by `userId` (`coupon/repository/index.ts:126-134`, used at `coupon/services/index.ts:711`). Percentage coupons have a cap (`coupon/model/index.ts:32-51`); corporate coupons are marked by `corporateIds` (`:22`) | A wallet-paid assisted booking has no gateway record, and the payer is not the patient |
| Doctor's view of a patient | `getPatientHistory`: only this doctor's own consultations with the account (`specialistPortal/services/index.ts:399-429`) | Decision 7 and overnight decision A |
| Prescription | Server PDF `bookings/<id>/prescription-<ts>.pdf` (`specialistPortal/services/index.ts:328-397`, `:472-512`); free-text tests (`bookings/model/index.ts:107`) | No notice; no structured tests |
| File access | Pharmacy with a matching `pharmacyId` reads every booking file (`file/access.ts:34-45`); partner lab reports (`:80-89`); attach needs the uploader (`:294-299`), used for `PharmacyOrder.prescriptionUrls` (`:458`) | Too broad / missing; bug cause 3 |
| Meet | Needs the patient's email (`meet/service/index.ts:465-470`). The event title names the patient, and the description carries the primary concern and speciality (`:483-490`) | Walk-ins have no email; the invite must stay neutral |
| Payments | Contexts appear in: the type and enum (`payment/types/index.ts:1`, `payment/model/index.ts:21`), the receipt code (`payment/services/index.ts:483-495`), the direct-paid guard (`:675`), verification ownership (`:695-727`, user or matching pharmacy only), the handler registry (`:110-112`, `:988-1016`), the verify-and-process dispatch (`:2104-2124`), the recovery sweep (`:1873-1893`, **no `wallet_recharge`**) and the controller (`payment/controller/index.ts:25-27`). The router refuses partner tokens (`src1/routes/index.ts:94`) | New contexts must be added everywhere; lab members cannot verify today |
| Settlement ledger | Unique `{ownerKind, ownerId}` (`partners/model/settlement.ts:69`); payout destination per account (`:24-30`); entries exactly once (`:75-110`, `partners/services/settlement.ts:51-80`) | No pharmacy or referral owner kinds |
| SMS | `otp` and `partner_bill` only; no timeout; throws (`sms/services/index.ts:13`, `:63-111`); the bill notice is sent after commit (`partners/services/invoice.ts:466-474`) | Queue, languages, switches |
| Jobs | Mongo `Job` with `uniqueId` (`queue/model/index.ts:4-16`) | Reused for SMS |
| Cancellation window | Customers only: 24 h, 48 h on Mondays (`common/utils/cancellationWindow.ts:92-108`) | Partner rules decided (§8.7) |
| Index sync | `npm run sync-indexes` reads every `src1/modules/<module>/model/*.ts` (`src1/scripts/syncIndexes.ts:19-25`) | New models must live in `model/` folders |

**The pharmacy prescription bug in short:**
1. There is no pharmacy screen for the bookings it made.
2. An unpaid booking expires after 30 minutes.
3. The prescription PDF cannot be attached to a pharmacy order.

The file itself is already readable by that pharmacy (`file/access.ts:41`).

## 4. Terms

| Term | Meaning |
|---|---|
| **Booker** | The organisation that makes and pays the booking: a pharmacy, a lab partner (through a member), or a doctor |
| **Provider** | The doctor or lab who delivers the service |
| **Earning base** | Provider price minus any **provider-funded** coupon (§8.3) |
| **Account holder** | The customer account of the phone number |
| **Patient** | The holder ("self") or one of their family members |
| **Assisted booking** | A consultation (scheduled or instant) or partner-lab booking made and paid by a booker |
| **Lab desk booking** | A lab's own test booked at its counter and paid at the lab |
| **Treating doctor** | A doctor whose consultation with that exact person has started and not ended (§9.1) |
| **Legacy pharmacy booking** | A booking a pharmacy made through the generic create (before or beside phase 1); old money rules (§6.4) |

## 5. Data model changes

All money in new fields is **integer paise** (`…Minor`). Consultation prices stay in rupees on `Booking` (Q14
decision 5) and are converted once, with `Math.round(rupees × 100)`. New models live under
`src1/modules/<module>/model/` so `sync-indexes` builds them. New modules: `assisted`, `partnerWallets`,
`referralCuts` (the existing `referral` module is the customer referral programme), `recordAccess` and `smsNotices`.
Coupon redemptions go in `coupon/model`.

### 5.1 The `assisted` block and `source`

The block sits on `Booking`, `PartnerLabBooking` and `InstantRequest` (copied to the booking at accept).

| Field | Type | Notes |
|---|---|---|
| `source` | `'self' \| 'pharmacy_assisted' \| 'lab_assisted' \| 'doctor_assisted' \| 'clinic_desk' \| 'lab_desk'` | Written on every new row. For existing rows, readers derive it: `clinicDesk` present → `clinic_desk`, otherwise `self` (no migration) |
| `assisted.bookedBy` | `{ kind: 'pharmacy' \| 'lab' \| 'doctor', id, branchId?, actorKind, actorId, name }` | From the admitted actor only |
| `assisted.consent` | `{ method: 'partner_attested', statementVersion, statementLanguage, at, actorId }` | Required (400 `CONSENT_REQUIRED`) |
| `assisted.preferredLanguage` | language code | Required |
| `assisted.identity` | `{ attested: true, newAccount, disputed?: { at, state: 'open' \| 'moved' \| 'dismissed' } }` | Doctors see "identity attested by the partner, not verified" (§14) |
| `assisted.join` | `{ on: 'partner_device' \| 'patient_phone', phone?, linkVersion }` | `call` and `video` only. `linkVersion` bumps **only on cancel**, which invalidates the SMS link. A move keeps the link, and the window follows the current slot (§6.6) |
| `assisted.funding` | Scheduled and lab: `{ method, payerKind, payerId, amountMinor, state, walletEntryId?, paymentRecordId?, refunds[] }`. Instant: `{ instantRequestId }` only (money lives on the request) | Each refund row: `{ refundId, cause, amountMinor, method, sourceRef, state, walletEntryId?, razorpayRefundId?, attemptId, at }`. `cause` includes `late_capture` with its own source (§8.4) |
| `assisted.split` | `{ listMinor, couponCode?, couponFundedBy?, discountMinor, baseMinor, cutMinor, providerMinor, rule: 'provider_coupon_v2' }` | Frozen at create (instant: at accept) |
| `assisted.referral` | `{ rules: [{ id, version }], lines: [{ category, basis, value, lineBaseMinor, capMinor?, amountMinor }], amountMinor, settlementAccountId, state: 'expected' \| 'earned' \| 'none', disabledReason? }` | **`null` until phase 4** (in 1a–3 the cut is 0 and `split.cutMinor` = 0). `disabledReason`: `consultation_cuts_off` or `doctor_cuts_off` |
| `assisted.shortRef` | 8-character random reference, unique partial index | Shown on slips and in SMS as "Ref"; part of the join token (§6.6) |
| `assisted.recommendationId` | string | §7.6 |
| `assisted.requestKey`, `assisted.requestHash` | strings | Unique partial index on `assisted.requestKey`, stored as `assisted:<kind>:<bookerId>:<actorId>:<key>`. Instant rows also fill the required `createRequestKey` with the same namespaced value |

**Kept and stamped at both consultation insert points** (`bookings/holds.ts:262-269` and
`doctors/services/instant.ts:499-502`):
- `source`, `assisted`, `settlementSystem: 'ledger'` (whatever `SETTLEMENT_CUTOVER_AT` says);
- `earningRule: 'provider_coupon_v2'` for assisted rows. From phase 4 this applies to every ledger row; completion
  reads the stored rule, so in-flight bookings never change;
- `Booking.pharmacyId` for pharmacy bookings, so S2-scoped readers keep working.

**Indexes** (declared on the schemas):
- `{ 'assisted.bookedBy.kind': 1, 'assisted.bookedBy.id': 1, createdAt: -1 }` on all three collections;
- `assisted.shortRef` unique partial (`$type: 'string'`) on `Booking` and `PartnerLabBooking`;
- `assisted.requestKey` unique partial on all three.

**Enums extended:**
- `User.createdSource` and the resolver source union: `assisted_booking`;
- payment `context`: `assisted_booking`, `assisted_lab_booking`, `assisted_instant`;
- settlement `ownerKind`: `pharmacy_referral`, `lab_referral`, `doctor_referral` (§5.4);
- `PartnerLabBooking.settlement.settlementSystem`: `lab_desk`;
- pharmacy wallet transaction types: the new movement kinds of §5.3.

### 5.2 Languages

| Model | New field | Set by |
|---|---|---|
| `User` | `preferredLanguage` (care and SMS), `uiLanguage` | A booking fills `preferredLanguage` only when it is empty; the user changes both in the app |
| `Dependent` | `preferredLanguage` | Set when a booking creates the family member |
| `PartnerMember`, `Pharmacy`, `Specialist`, admin `User` | `uiLanguage` | The switcher (§11) |

### 5.3 Partner wallets, withdrawable money and withdrawals

**Storage.**
- Pharmacy: the existing `pharmacy_wallets` / `pharmacy_wallet_transactions` (live balances; no migration), extended
  with the fields below.
- Lab partner and doctor: new `partner_wallets { ownerKind: 'lab' | 'doctor', ownerId, balanceMinor ≥ 0,
  withdrawableMinor, receivableMinor ≥ 0, frozen, isActive, version }` (unique `{ownerKind, ownerId}`; also
  `{frozen: 1}` for the admin list).
- Pharmacy store fields, sign rules, unique index and opening-balance migration: §17.3.
- Entries for labs and doctors: `partner_wallet_entries { walletId, kind, amountMinor (signed), balanceAfterMinor,
  withdrawableDeltaMinor, operationKey (unique), ref, lotAllocations?, by, byKind, at }`.

**Withdrawable money.** Only money that really came in by card can go back out.

- **Top-up lots.** Each captured top-up becomes a lot: `wallet_topup_lots { walletRef, paymentRecordId, amountMinor,
  gatewayFeeMinor?, feeState: 'unknown' | 'known', disputeState: 'none' | 'open' | 'lost', closed, remainingMinor }`.
  - The fee is Razorpay's `fee` field **alone**; it already includes GST, so `tax` is not added.
  - Capture reads and stores it on the payment record (`gatewayFeeMinor`). Today `fetchRazorpayPayment` drops it
    (`payment/services/index.ts:800-823`), and so does the order-payments reconcile (`:1787`); both must keep `fee`.
  - A lot whose fee is not yet known is **not withdrawable**. A fee check job fills it later.
  - Indexes: `wallet_topup_lots.paymentRecordId` unique; `{ walletRef.kind, walletRef.id, createdAt }`.
- **Withdrawable** = Σ `remainingMinor` over lots that are not closed, have a known fee and no open dispute. Everything
  else in the balance (admin credits, chargeback set-offs) is **non-withdrawable**.
- **Lot rules (N10):**
  - a lot with a lost chargeback is `closed` for good, and a refund never restores it (the refunded money returns as
    non-withdrawable);
  - a lot under an open dispute is not withdrawable;
  - negative admin adjustments reduce lots first (oldest first), then non-withdrawable money;
  - the pro-rata fee of a withdrawal is floored per lot, and the remainder of the total fee goes to the last lot
    taken.
- **Spending** consumes withdrawable lots first, oldest first (ASSUMED D9, conservative), then non-withdrawable money.
  The debit entry records its `lotAllocations`.
- A **refund** of that spend restores exactly those allocations. A refund of non-withdrawable spend returns
  non-withdrawable money.

**Movements.** All are exactly once by `operationKey` and bump `version`.

| Kind | Effect | Posts when |
|---|---|---|
| `topup` | + balance, + lot | Verified capture |
| `booking_debit` | − balance, lots consumed | Inside the booking transaction; refused if `frozen`, inactive, or balance short (409 `INSUFFICIENT_BALANCE`) |
| `refund_credit` | + balance, allocations restored | **Always**: inactive, frozen or suspended wallets and bookers included. Pharmacy credits drop today's `isActive: true` filter (`pharmacyWallet/repository/index.ts:60-61`) |
| `withdrawal_hold` | − balance, lots consumed | Request (below) |
| `withdrawal_release` | + balance, allocations restored | Requester cancel or admin reject: **always posts** |
| `withdrawal_void` | + balance, allocations restored | A paid withdrawal whose bank transfer bounced: **always posts** |
| `chargeback` | − balance; any shortfall becomes `receivableMinor`; the wallet is frozen | Admin records a Razorpay dispute lost on a top-up |
| `receivable_setoff` | − `receivableMinor` | From later refunds or top-ups (credited first to the receivable), or from the booker's referral balance (a paired ledger `adjustment` on the referral account) |
| `adjustment` | ± balance with reason (admin); always non-withdrawable | Audited; never below 0 |

**Freeze.** An admin sets or clears `frozen` with a reason (audited). A frozen wallet refuses spending and
withdrawals; credits still post.

**Withdrawals** (decision 3, overnight decision C). Withdrawals are switched off by default:
`WALLET_WITHDRAWALS_ENABLED=false` (GATE-RBI).

| State | Entered by | Effect |
|---|---|---|
| `requested` | The owner (pharmacy; lab owner or member with `wallet.manage`; the doctor), with `requestKey` | Refused when: no **verified** payout destination exists on the booker's home account (409 `PAYOUT_DESTINATION_NOT_VERIFIED`, §5.4); the amount exceeds `withdrawableMinor`; the wallet is frozen or has a receivable. Otherwise `withdrawal_hold` posts in the same transaction, and the request records `grossMinor`, `feeMinor` (pro-rata from the lots taken) and `transferMinor = gross − fee` |
| `cancelled` | The requester, while `requested` | `withdrawal_release` |
| `rejected` | Admin, with a reason | `withdrawal_release` |
| `paid` | Admin records method, UTR, date and note to the destination version checked (Q5 rules; exactly once per admin + key; reference unique per account) | Nothing more moves |
| `voided` | Admin, when the transfer bounced | `withdrawal_void` restores `grossMinor` |

The fee stays with Jansetu, which already paid it to Razorpay at top-up.

### 5.4 Referral rules, switches and referral accounts

**Rules.** `referral_rules { bookerKind, bookerId, category: 'consultation' | 'lab_test' | 'lab_package', basis:
'percent' | 'fixed', percentBasisPoints?, fixedMinor?, capMinor? (per line), isActive, version, updatedBy, updatedAt }`
in `referralCuts/model`, unique `{bookerKind, bookerId, category}`, with an append-only `referral_rule_events` history.

- Set by admins only, at partner setup; partners see them read-only.
- Edits carry `expectedVersion` (409 `RECORD_CHANGED` when stale).
- Snapshotted at create (instant: at accept).

**Switches:**
- `REFERRAL_CONSULTATION_CUTS_ENABLED=false` (overnight decision F, **GATE-NMC**). While off, consultation lines
  snapshot 0 with `disabledReason: 'consultation_cuts_off'`.
- `REFERRAL_DOCTOR_CUTS_ENABLED=false` (decision 2, **GATE-NMC**). While off, every doctor-booked line snapshots 0
  with `doctor_cuts_off`.
- Lab-test and package cuts of pharmacies and labs are on.
- Rules can be saved while a switch is off; they apply only to bookings made after it is turned on.

**Referral accounts.**
- The settlement index stays `{ownerKind, ownerId}` (unique).
- Referral cuts post to accounts with their own owner kinds: `pharmacy_referral` (id = pharmacyId), `lab_referral`
  (partnerId) and `doctor_referral` (specialistId). Each is created idempotently before the first snapshot.

**Payout destination** (Q5 rules: versioned, verified by an admin) lives on one **home account** per booker:

| Booker | Home account | Destination set by |
|---|---|---|
| Lab | Its existing `partner` account | Lab owner or admin |
| Doctor | Its existing `doctor` account | The doctor or admin |
| Pharmacy | Its `pharmacy_referral` account (it has no service account) | The pharmacy itself or admin |

Payouts from a referral account and wallet withdrawals both pay to the home account's verified destination version;
referral accounts hold no destination of their own.

**Payout switch.** `REFERRAL_PAYOUTS_ENABLED=false` refuses payouts from `*_referral` accounts (409
`REFERRAL_PAYOUTS_DISABLED`) until the tax question is answered (OPEN-OWNER O1). Cuts accrue meanwhile.

### 5.5 Lab desk bookings

A `PartnerLabBooking` with `source: 'lab_desk'` and a `desk { memberId, branchId, requestKey, requestHash, arrivedAt?,
consent, preferredLanguage }` block (clinic-desk shape plus consent and language). The Q3 schema's required fields
change as follows:

| Field (`partners/model/labBooking.ts`) | Desk rule |
|---|---|
| `settlement.settlementAccountId`, `beneficiaryName` | Filled with the lab's own `partner` account (harmless); `settlementSystem: 'lab_desk'` stops every earning |
| `paymentDeadline` (`:157`) | Becomes required only when `settlementSystem: 'ledger'`; the expiry sweep also filters on `ledger` |
| `slot.slotId`, `date`, `startTime`, `endTime` | Required unless `slot.walkIn: true` (a lab-visit walk-in tested now; no seat); `startsAt` is always set |
| `visitMode` | `lab` or `home` (decision 13); home needs an address, a home slot (seat) and a collector |
| `pricing` | Snapshot of the lab's catalogue for its bill; `commissionMinor: 0` |
| `paymentStatus` | Stays `pending` |

**Guards:**
- pay-again, wallet and gateway refuse a desk row (409 `PAY_AT_LAB`);
- the expiry sweep skips it;
- no earnings or cuts;
- a customer cancellation refunds nothing;
- both payout systems exclude it;
- the lab bills it with its own Q2 invoice linked by `labBookingId` (at most one open bill).

### 5.6 Test recommendations

`test_recommendations { _id, code, consultationId, specialistId, userId, dependentId?, items: [{ name, code?, note? }],
status: 'open' | 'partly_booked' | 'booked', bookings: [{ labBookingId, itemNames[] }], createdAt }`.

- `code` is an 8-character random reference with a check digit, printed with the **Jansetu** brand on the
  prescription PDF.
- `testsAdvised` stays filled for older readers.

### 5.7 Coupon redemptions and coupon funding (decisions B and E)

**Redemptions.** `coupon/model` gains `coupon_redemptions { couponCode, patientUserId, dependentId?, bookingKind:
'booking' | 'lab_booking' | 'instant_request', bookingId, payerKind, payerId, discountMinor, state: 'counted' |
'reversed', at }`, unique `{couponCode, bookingKind, bookingId}`. The row is keyed to the **patient account**, whoever
pays.

- **Written** in the booking (or instant request) transaction, for wallet and Razorpay payments alike. It increments
  the coupon's `currentUsageCount` with a guard (`currentUsageCount < usageLimit` when a limit exists; otherwise
  409 `COUPON_EXHAUSTED`).
- **Reversed** once in the cancellation or expiry transaction. Partner-paid rows never use the payment-record
  counting of `coupon/usage.ts`.
- **Per-user counting** (`coupon/repository/index.ts:126-134`) adds the patient's `counted` redemptions, so a patient's
  own app limits see partner-paid uses.

**Funding.** `Coupon.fundedBy: 'provider' | 'platform'` and `Coupon.partnerUsable: boolean` (default `false`), both
admin-editable and audited.
- A `platform`-funded coupon is **refused on partner bookings** (400 `COUPON_NOT_FOR_ASSISTED`) unless an admin set
  `partnerUsable: true` (N1).
- The default is `provider`.
- Coupons with `corporateIds` default to `platform`; a migration sets existing corporate coupons to `platform`.
- The value is snapshotted on the split.

## 6. Building blocks shared by every flow

### 6.1 Booker actors and permissions

| Booker | Admission | Permission |
|---|---|---|
| Pharmacy | `requireOperationalPharmacy` (operational and verified), `pharmacyId` from the token | Every operational pharmacy |
| Lab | Member loaded from the DB on every request (Q1); admin-as-owner mirror (§11 row 1) | New `assisted.book`; `wallet.view`; `wallet.manage` (top up, withdraw). Delegation ceiling and branch scope as §3 |
| Doctor | `specialist`, **active and verified**, checked at admission and on every history read | Own login; own wallet |

**Audit:** every assisted mutation is audited in its transaction (`PartnerAuditEvent` for members; new
`assisted_audit_events` for pharmacies and doctors).

**Payment verification by organisation.** Assisted payment records carry `payerKind / payerOrgId / payerActorId`.
Verification and "check my payment" succeed for any admitted actor of that organisation (a pharmacy; any lab member
with `assisted.book` in branch scope; the doctor). These calls are mounted in each booker surface (pharmacy,
`/partner-workspace/assisted/payments/*`, `/specialists/me/assisted/payments/*`), because the generic payment router
refuses partner tokens (`src1/routes/index.ts:94`).

### 6.2 Find or create the patient

The order is fixed. The resolver stays as it is, outside transactions, as the clinic desk uses it.

1. **Validate** the body: phone, patient choice, service, consent ticked.
2. **Check limits for the organisation** (not the actor), with a shared Mongo-backed counter (O1 style):
   - lookups: default 120 an hour;
   - new accounts: default 30 a day;
   - assisted bookings per phone number across all bookers: default 5 a day.
3. **Lookup** (a separate call, before the booking): `POST …/assisted/patients/lookup { phone }` returns
   `{ exists, holderNameMasked }` only.
   - First word plus the initial of the last word ("Rina Kumari Das" → "Rina D.").
   - A one-word name shows its first two letters and "…" (ASSUMED D7).
   - An unnamed account returns `null`.
   - Every lookup is audited.
4. **Resolve:** `resolveCustomerByPhone(phone, 'assisted_booking')`, outside the transaction, idempotent. A new number
   must be typed twice in the UI. If a later step fails, the account stays as an empty internal account, exactly as at
   the clinic desk.
5. **Transact:** in one booking transaction:
   - request key claim;
   - family member (active same name + relation reused, else created with a pre-chosen id);
   - pharmacy-customer link with consent `patient_agreed` (S3 shape) and the **typed name**;
   - seat or interval, coupon redemption, payment (wallet) and split;
   - audit.

The answer never says whether a family member was created (Q14 rule). It says `newAccount` only when the lookup
already said the number had no account. A limit hit answers 429 `ASSISTED_LIMIT_REACHED` with
`limit: 'lookups' | 'new_accounts' | 'bookings_per_phone' | 'booker_cancellations'`. Names: §17.4.

**Pharmacy customer list.** `PharmacyCustomer` stores `typedName` (and the phone as typed, which is the account
phone). `GET /pharmacy-customers` returns and searches only `typedName` and phone, never the account's `name` or
`email` (`pharmacyCustomers/repository/index.ts:28-54`). Links created before this change show the account name
masked.

### 6.3 Request keys, hash, price fence and coupons

- **Keys.** `requestKey` (`[A-Za-z0-9_-]{8,100}`), stored per booker actor and claimed in the transaction
  (`requestKeys/index.ts:27-48`). New kinds: `assisted_consult_create`, `assisted_instant_create`,
  `assisted_lab_create`, `lab_desk_create`, `wallet_withdrawal`, `wallet_topup`.
- **Hash.** `canonicalJson` (`common/utils/canonicalJson.ts`) over:
  - phone, patient identity;
  - service: scheduled (doctor + slot + mode + join), instant (target + mode + join) or lab (lab + branch + sorted
    items + visit mode + slot + address);
  - `couponCode`, `preferredLanguage`, `recommendationCode`, `notes`.

  The payment method is excluded (Q3).
- **Replays.** Same key and hash → 200 `replayed`. Other content → 409 `IDEMPOTENCY_KEY_REUSED`. Abandoned → 409
  `REQUEST_ABANDONED`. By-key lookup and abandon routes as in Q13.
- **Coupons (decisions 11, B, E).**
  - Validated against the **patient**: account, family member and corporate, using the existing rules (bookings
    `:407`; diagnostics rules for labs; frozen-on-request for instant).
  - Coupons with `usageLimitPerUser` are refused (400 `COUPON_NOT_FOR_ASSISTED`).
  - The redemption row of §5.7 is written in the transaction.
- **Price fence.** `acceptedPriceMinor` (after coupon); a different server price is 409 `PRICE_CHANGED`.
- **Free follow-up.** The patient's free follow-up is never booked by a partner (S3 rule, 403
  `ASSISTED_FOLLOW_UP_NOT_ALLOWED`).
- **Later steps** carry `expectedUpdatedAt` or `expectedVersion`.

### 6.4 Paying, and bookings made before phase 1

**One method per booking:** wallet or Razorpay.

| Method | What happens |
|---|---|
| Wallet | **One transaction:** key claim, seat and interval (`createBookingWithHolds` with its in-transaction callback, `bookings/holds.ts:214`) or lab seat, coupon redemption, insert as `confirmed` + `paid`, wallet debit with lot allocations, split and referral snapshot, audit. **No payment record is written**: the wallet entry plus `assisted.funding` are the record (N7) |
| Razorpay | Insert `pending_payment` with the seat held. Then a Razorpay order: context `assisted_*`, payer = the booker organisation, record `userId` = the booker actor, **never the patient**. A `CONTEXT_HANDLERS` handler confirms on verified capture, idempotently. Pay-again within 30 min (also switching to the wallet). The existing sweep expires the booking after reconciling. A late or losing capture gets its own refund row (§8.4). Jansetu bears the fee |

**Places that must learn the new contexts:**
- `PaymentContext` type and model enum;
- receipt code (`:483-495`);
- direct-paid guard (`:675`), for wallet-paid booking records if any;
- verification ownership (`:695-727`, by organisation);
- handler registry and dispatch (`:988-1016`);
- the verify-and-process dispatch (`:2104-2124`), which duplicate verify, check and sweep calls all reach;
- `reconcilePaymentAndProcess` (`:1809`);
- the recovery sweep (`:1873-1893`);
- controller result shaping (`payment/controller/index.ts:25-27`);
- the booking and lab expiry sweeps;
- the reconciliation job.

**Assisted payment records carry no `couponCode`**, so `coupon/usage.ts` never counts them. Coupon use is counted
only by the `coupon_redemptions` row, written in the create transaction (a reservation even while a Razorpay booking
is `pending_payment`) and reversed on expiry or cancellation.

**Top-up recovery.** `wallet_recharge` joins the recovery sweep for records created after the deploy
(`WALLET_RECHARGE_SWEEP_FROM`). Older captured-but-uncredited top-ups go on an admin list (§8.8) instead. Each booker surface gets
`POST …/wallet/topups/:paymentTransactionId/check`, which reconciles that attempt with Razorpay (W3b pattern).

**Assisted bookings never touch the customer-wallet ledger.** The customer commands of §6.7 route or refuse them.

**Bookings made before phase 1:**
- Every booking a pharmacy made through the generic create stays a **legacy pharmacy booking**. Under S3 rules it is
  paid by the customer-owned order, any refund goes to the customer's wallet as today, it has no `assisted` block,
  no cut and no SMS.
- The pharmacy sees these bookings read-only in the phase 0 list (with the prescription).
- Phase 0 adds **no** pharmacy "Pay now".
- The generic create stays open to pharmacies (S3 rules) while the released pharmacy app needs it, and closes by app
  version (§13).

### 6.5 Notices after commit

- **In-app.** The patient (holder, naming the family member) and the provider (doctor `specialist_new_booking`; the lab
  notifier) get notices. They say "booked by <partner>" and that the identity was attested by the partner.
- **Idempotency.** Keys `assisted:<booking>:<event>[:<version>]:<audience>`; replays send nothing.
- **Booker badges.** "prescription ready", "report ready", "cancelled by patient", "reported as not mine".
- **SMS.** §10.

### 6.6 How the consultation happens (decisions 10 and 8)

| Mode | `join.on = partner_device` | `join.on = patient_phone` |
|---|---|---|
| `video` | The partner app shows **Join call** from 10 min before the slot to its end | (a) The patient signs in to the app and taps Join; (b) once the link templates exist, the booked and reminder SMS carry a link |
| `call` | The doctor phones the partner's counter number | The doctor phones the number given at booking |
| `in-person` | **Allowed:** an in-clinic slot of the chosen doctor; the patient goes to the clinic; no join choice | Same |

**SMS join link:**
- The template text holds the fixed URL `https://<jansetu-domain>/j/{#var#}`; the variable is the token only.
- The token is `<ref>-<mac>`, **29 characters**: `ref` is the booking's `shortRef` (8 base32 characters, unique, also
  the SMS "Ref") and `mac` is the first 100 bits of `HMAC-SHA256(JOIN_LINK_SECRET, bookingId + ':' + linkVersion)`
  as 20 base32 characters (RFC 4648 alphabet, upper case, no padding). Nothing is stored. `/j/` looks up the booking
  by `ref`, recomputes the MAC and compares it in constant time.
- The server redirects to the Meet URL only inside the join window; outside it, a neutral page.
- `/j/` is rate-limited per IP (default 30 a minute) and returns the same page for unknown, expired and wrong tokens.
- A cancel bumps `linkVersion`, killing old links. A move does not; the window follows the current slot.

**Meet:**
- Attendees: the doctor plus the booker's contact email (or none).
- A missing patient email no longer blocks the link (`meet/service/index.ts:465-470`).
- For assisted bookings the event **title and description are neutral** ("Jansetu consultation", booking reference
  only), with no patient name, primary concern or speciality (`:483-490`).
- Guest "ask to join" behaviour is verified in phase 1a (N6).

### 6.7 Customer commands and reads on a partner-paid booking

| Command or read | Scheduled consultation | Lab booking | Instant request / instant booking |
|---|---|---|---|
| Pay-again / retry-payment / reconcile | Refused 409 `PARTNER_PAID_BOOKING` (the booker uses its own routes) | Refused | Pay-again refused; the request belongs to the booker |
| Re-offer, request refund, activity heartbeat | — | — | Refused for the patient; the booker does them |
| Cancel | **Allowed** (decision 6), patient windows (§8.7); routed to the partner refund | **Allowed**, routed likewise | Refused after acceptance (Q4b); before acceptance the request is the booker's |
| Reschedule | Refused 409 `ASSISTED_RESCHEDULE_BY_PARTNER` (the booker moves it in phase 1a, same doctor and price, before start, same slot rules; ASSUMED D11) | Patient may accept or cancel a lab-proposed reschedule; no own reschedule (as today) | Never rescheduled |
| Edit (`PUT /bookings/:id`) | Customer notes only; other fields refused | — | Notes only |
| Delete | Refused | — | Refused |
| Free follow-up from this consultation | The patient may book it in the app (their benefit; price 0; no partner money, no cut; ASSUMED D12) | — | As scheduled |
| "This isn't mine" | **Allowed** (§14) | **Allowed** | **Allowed** |
| Booking and list reads | Allowed, **without** `price`, `payment*`, `assisted.funding`, `split`, `referral`; shows "Paid by <partner>" | Same; `pricing` hidden | Same |
| `GET /bookings/:id/payment-details` | 404 for partner-paid bookings | — | — |

## 7. Flows by booker

### 7.1 Pharmacy → doctor consultation (scheduled)

| Step | Detail |
|---|---|
| Patient | §6.2; language; consent |
| Service | **Any doctor**, sorted: the booker's pincode, then city (pharmacy `pincode` / `city`; lab branch address; doctors `specialists/model/index.ts:154-170`), then the patient's language, fee and next slot. Filters: speciality, mode, language. Only active and verified doctors. Then a slot and mode (`video` / `call` / `in-person`) |
| Coupon / pay | §6.3, §6.4 |
| Notices / SMS | Patient and doctor in-app; SMS booked + reminder; "prescription ready" |
| Pharmacy sees | Its list (allowlisted): status, slot, Join call, the prescription for 90 days (§9.2), **Create medicine order** |
| Patient later sees | The consultation, "Booked by <pharmacy>", the prescription; may cancel or report "not mine" |

API:
- `POST /api/v1/pharmacy-assisted/consultations`
- `GET /pharmacy-assisted/bookings` and `GET /pharmacy-assisted/bookings/:id`
- `/:id/pay`, `/:id/cancel`, `/:id/reschedule`
- by-key routes
- `/wallet`, `/wallet/topups`, `/wallet/topups/:id/check`, `/wallet/withdrawals`

### 7.2 Pharmacy → lab test

| Step | Detail |
|---|---|
| Patient | §6.2 |
| Service | Partner labs nearby first → branch → items → visit mode → slot (≥ 60 min, Q3) |
| Coupon / pay | As 7.1 |
| Notices / SMS | In-app; SMS booked + reminder + "lab report ready" |
| Pharmacy sees | Status, lab reschedule proposals (accept or cancel for a refund), the released report |
| Model (phase 2) | `PartnerLabBooking.cancellation.reason` gains `'partner'` and `byKind` gains `'booker'` (`partners/model/labBooking.ts:58`) |
| Patient later sees | The lab booking and report; may cancel |

### 7.3 Lab → doctor consultation

As 7.1 (scheduled) or 7.7 (instant), by a lab member with `assisted.book`; "nearby" uses the member's branch.
Overnight decision G: the lab sees the prescription as a pharmacy does. It may book its own tests at its desk (§7.5).
A lab never books another lab's tests.

### 7.4 Doctor → lab test

| Step | Detail |
|---|---|
| Patient | From one of the doctor's consultations (no lookup), or a walk-in by phone |
| Service / coupon / pay | As 7.2, doctor wallet or Razorpay |
| Doctor sees | Status and released report (`/specialists/me/assisted/lab-bookings`) |
| Cut | 0 while `REFERRAL_DOCTOR_CUTS_ENABLED=false` |

### 7.5 Lab front desk (the lab's own tests)

| Step | Detail |
|---|---|
| Patient | §6.2; language and consent on `desk` |
| Service | Own catalogue at a branch in scope: lab visit (slot or walk-in) or **home collection** (address, home slot, collector) |
| Pay | Paid at the lab; a Q2 bill linked to the booking |
| Steps | Existing lab steps; no-show rules, nothing refunded through us |
| SMS | Booked (scheduled), reminder, report ready |
| Patient later sees | Booking, bill, report |

### 7.6 Doctor recommends tests

1. **Writing it.** The doctor lists tests in the prescription. The recommendation and its code are created, and the
   PDF prints both (Jansetu brand).
2. **Patient (app).** "Recommended tests → Book" is an ordinary customer lab booking with `recommendationId`.
3. **Pharmacy or lab.** Loads it by **the printed code plus the patient's phone** (ASSUMED D2) and gets only the test
   names. It then books through 7.2 or the desk 7.5.
4. **Tracking.** Information only, never a lock. Matching to catalogue items is by hand.
5. **The recommending doctor** earns no cut and does **not** see the report. It gets treating access only through a
   later consultation (§9.1).

### 7.7 Partner → instant "Consult now" (decision 10)

Reuses Q4b: presence, quote, 5-minute offers, re-offer, first-accept-wins, atomic accept. Only active and verified
doctors receive offers.

| Step | Detail |
|---|---|
| Create | The partner funds the **quoted** amount by wallet or Razorpay into the request (`assisted_instant`), with the `assisted` block; `createRequestKey` = the namespaced key |
| Coupon | Validated at create (§6.3). At accept a **percentage** coupon is **recomputed on the accepted fee**: `min(cap, pct × fee)`. A fixed coupon is `min(fixed, fee)`. The redemption row is updated in the accept transaction |
| Accept | One transaction: allocation, booking insert with `source`, `assisted` (funding = `{ instantRequestId }`), `earningRule`, split and referral snapshot |
| Quote difference | Refunded to the partner by method in the accept transaction (wallet credit), or as a refund row for Razorpay. The request keeps every money row; the booking holds only the pointer |
| Nobody accepts | The booker re-offers or asks for a refund (by method). The inactivity refund follows the booker's screen activity |
| After accept | Cancelled only by the doctor or an admin (full refund by method; ASSUMED D13). A no-show is final |

## 8. Money

### 8.1 Worked examples (plain words)

**Lab test, working from the start.** Rules for Sharma Medicals: lab test 5%, package ₹40 fixed per line.

| Step | Money |
|---|---|
| Sharma books CBC (₹300) and a thyroid package (₹800) for Rina at City Lab, paying ₹1,100 from its wallet | Sharma's wallet −₹1,100 |
| Rina pays Sharma at the counter (Sharma's own price) | Not Jansetu's money |
| City Lab completes the tests | City Lab earns ₹1,100 − ₹15 (5% of ₹300) − ₹40 = **₹1,045**. Sharma's referral account +**₹55**. Jansetu paid out exactly the ₹1,100 it received; its only cost is the card fee on Sharma's top-up |

**Consultation, once `REFERRAL_CONSULTATION_CUTS_ENABLED` is on** (owner's example): ₹500 at 10% → doctor
**₹450**, Sharma **₹50**. Until the switch is on, the doctor earns **₹500** and Sharma **₹0**.

**Coupons, coupon first, then the cut** (consultation cuts on, ₹100 coupon):

| Coupon funded by | Sharma pays | Base | Cut (10%) | Doctor | Jansetu |
|---|---|---|---|---|---|
| Provider (default) | ₹400 | ₹400 | ₹40 | ₹360 | ₹0 (plus card fees) |
| Platform (e.g. corporate) | ₹400 | ₹500 | ₹50 | ₹450 | −₹100 |

**What happens next:**
- **Cancelled, rejected or expired:** everything goes back to the partner by its method; no earnings, no cut.
- **No-show:** nothing goes back; nobody earns; Jansetu keeps the money; one move is allowed.

### 8.2 Wallet ledger

See §5.3. Invariants, checked daily:
- balance = Σ entries;
- `withdrawableMinor` = Σ lot remainders ≤ balance;
- pharmacy paise = `balancePaise`;
- `receivableMinor` > 0 ⇒ frozen.

### 8.3 Earning base, coupon, cut and provider earning (decision 1, overnight B)

1. **List:** doctor fee (instant: accepted fee) or the sum of catalogue lines.
2. **Coupon** (recomputed on the accepted fee for instant). The partner pays list − discount.
3. **Base:**
   - **provider-funded:** list − discount, spread over lab lines in proportion to price (largest-remainder paise,
     ASSUMED D4);
   - **platform-funded:** the list price, with Jansetu bearing the discount.
4. **Cut per line:**
   - `percent`: `floor(lineBase × bp / 10000)`;
   - `fixed`: `min(fixedMinor, lineBase)` (lab: per test or package line; consultation: once);
   - then `capMinor` **per line**;
   - never above the line base;
   - 0 when the category's or doctor's switch is off.
5. **Provider earning** = base − Σ cuts.

**Phasing of the rule:**
- Phase 1a applies `provider_coupon_v2` to assisted bookings, the moment coupons and payments arrive.
- Phase 4 extends it to every new ledger booking (ASSUMED D3: owner decision 1 is general). Older bookings keep their
  stored rule.

### 8.4 Refunds by method (decisions 4 and 6)

| Paid by | Route |
|---|---|
| Wallet | `refund_credit` in the cancelling transaction; **always posts** |
| Razorpay | A refund row `state: 'pending'`, sent by a worker reusing `pharmacyOrders/prescriptionRefund.ts:45-110` (fenced attempts; lookup before resubmit). `processed` → done. A terminal failure goes to the **operator queue**; an admin may credit the wallet only with the partner's recorded agreement |

- **Budgets.** A booking's refund budget is `funding.amountMinor − Σ refunded` (instant: the request's allocation and
  returned amounts).
- **Late captures** (a capture on a booking that expired, was never paid, or was already paid by another method or
  attempt) get their **own refund row** with `cause: 'late_capture'`. Its budget is that capture's amount, refunded
  to that payment's source, independent of the booking's budget.
- **Completion is terminal**, so no refund follows an earning.

### 8.5 How the cut posts

- **When:** on completion only, in the provider-earning transaction (`postConsultationEarningIn`; lab `postEarning`).
- **Entries:**
  - provider service account: `earning` = `providerMinor`, `commissionMinor` = cut;
  - booker `*_referral` account: `earning` = cut, source `referral_consultation` / `referral_lab_booking`.

  Both are exactly once; a zero cut posts nothing.
- **Never** on a no-show, cancellation, rejection, expiry or desk booking.
- **Payouts** wait for `REFERRAL_PAYOUTS_ENABLED`.
- **Statements** show list, coupon (and who funded it), cut and net per row.

### 8.6 No-show (decided)

- No refund to the partner, no provider pay, no cut; Jansetu keeps the money.
- One reschedule by provider, desk or admin; a second no-show is final; a moved no-show is never refunded.
- An instant no-show is final.

### 8.7 Cancellations (decisions 5, 6)

| Who | When | Refund |
|---|---|---|
| Booking partner | Scheduled consultation: **any time before it starts**. Lab: **up to 1 h before the slot**, or any time while a lab reschedule is unanswered | Full, by method |
| Patient (app) | Customer windows (ASSUMED D6): consultation 24 h (48 h Monday); lab 2 h or while a reschedule is unanswered; instant not after acceptance | Full, **to the partner** by method; the partner is told |
| Doctor / lab reject / admin | Before completion | Full, by method |
| Payment window | 30 min unpaid | Nothing taken; late captures go to their own refund row |

- **One settlement transaction:** CAS on state, seat and interval released, coupon redemption reversed, refund rows,
  `linkVersion` bumped, audit.
- **Limits and monitoring per booker** (env; defaults ASSUMED D10):
  - at 20 cancellations in a day (IST) by one booker, its **new** bookings are refused for the rest of the day (429
    `ASSISTED_LIMIT_REACHED`, `limit: 'booker_cancellations'`); cancellations stay allowed; an alert is raised;
  - an alert when cancellations exceed 30% of the last 7 days' bookings (minimum 10);
  - an alert when withdrawals exceed 50% of 30-day top-ups;
  - an alert when the same booker–doctor pair reaches 10 bookings in a day.

  Alerts go to admin notifications and the daily reconciliation report. Admins review them and may freeze a wallet.

### 8.8 Reconciliation and the stuck-money report

**Daily job** (phase 1a onwards), with an admin report. Checks:
- wallet invariants;
- one funding per paid booking;
- each refund row refunded or queued;
- provider + cut = base on every completed row;
- withdrawals consistent with holds;
- Razorpay totals for top-ups, `assisted_*` payments and refunds equal the records.

Mismatches are reported, never auto-fixed.

**Stuck-money report.** It lists:
- bookings `pending_payment` past their deadline plus 1 h;
- refund rows pending over 24 h or in the operator queue;
- late-capture rows;
- withdrawals `requested` over 7 days;
- frozen wallets with a receivable;
- top-ups captured but not credited, including those created before the sweep's start date (N5);
- **paid bookings stuck after their slot:** paid assisted bookings not completed, cancelled or no-show 7 days after
  the slot end (money held with no outcome);
- top-up lots with an unknown fee older than 2 days.

## 9. Access to records (decision 7; overnight A, G, H)

### 9.1 Who sees what

| Reader | What |
|---|---|
| Booking pharmacy or lab (G) | Bookings it made only: status, Join call, the prescription for **90 days** after the consultation (H), released lab reports of lab bookings it made. Nothing else of the patient |
| Booking doctor (lab test) | Status and released report of that lab booking |
| Treating doctor, no approval | This booking's own content (concern, documents attached to it) plus the doctor's **own** past consultations with this person |
| Treating doctor, with holder approval (A) | Additionally, other providers' consultations of this person (diagnosis, advice, prescriptions) and released lab reports |
| Recommending doctor | Nothing from the recommendation |
| Patient (holder after OTP) | Everything |

**Treating window:**
- It **starts when the consultation starts**, never at "confirmed":
  - video / call: the join window opens (slot start − 10 min);
  - instant: acceptance;
  - in-person: desk check-in (`arrivedAt`), or the slot start for online in-clinic bookings.
- It ends 30 days after completion (ASSUMED D5), or **7 days after the slot end if the booking is not completed**
  (N8), or at once on cancellation or no-show.
- A booking cancelled before it starts never opens a window.
- The doctor must be **active and verified** at the assisted booking's admission and at every history read.
- **Read log:** each history or record read writes `record_reads { doctorId, patient, bookingId, scope, at }`
  **before** the answer is sent; if that write fails, the read is refused (503).
- **Read-then-cancel alert:** a booking cancelled or marked no-show after its doctor read history is flagged to admins.

**Holder approval (overnight A).**
1. `POST /specialists/me/bookings/:id/records-access/request` (or the booker's equivalent), allowed **only inside an
   open treating window** (N9), sends a 6-digit code by SMS
   to the **account holder's phone** (security message, §10.6), naming the patient's first name.
2. The doctor or partner enters it at `…/records-access/confirm { code }`. Codes last 10 min, are stored hashed, and
   follow the O1 attempt and send limits.
3. Success writes `record_access_grants { holderUserId, dependentId?, specialistId, via: 'sms_code', at, expiresAt,
   revokedAt?, revokedBy? }`.
4. **Once per doctor and person, for 12 months** (`expiresAt` = grant + 12 months). The holder can see and revoke grants
   in the app; an admin revokes one on request (audited). The grant applies only inside a treating window.
5. A doctor's **own** consultations with the patient stay readable to that doctor, without a window or grant, as
   `getPatientHistory` allows today.
6. Without the SMS template no approval is possible, and the doctor keeps the no-approval view.

### 9.2 Code changes

- **`file/access.ts` `canReadBooking`** becomes field-aware:
  - **Booker:** pharmacy by `assisted.bookedBy` (or legacy `pharmacyId`); lab member by `assisted.bookedBy` plus
    current membership, permission and branch. It reads **only the dispensing copy** of the prescription (§17.2:
    medicines, advice and tests, without the diagnosis), never the full PDF, and only within 90 days of the
    consultation's end (slot end, or completion if later). From phase 0 this also applies to legacy pharmacy
    bookings.
  - **Treating doctor:** prescription files of the person's other consultations, if they are its own or covered by a
    grant.
  - **Other fields** (`documents.url`, `report.fileUrls`) stay with the patient and that booking's doctor.
  - This **narrows** the pharmacy rule (`:41`).
- **`canReadPartnerLabReport`** (`:80-89`) and **`canReadLabReport`** (`:59-63`): released files for a matching
  booker, and for a treating doctor with a grant. Drafts never.
- **`getPatientHistory`** (`specialistPortal/services/index.ts:399-429`): treating-gated, per person, grant-aware,
  allowlisted, read log first.
- **Generic `/bookings` reads for pharmacies:** for every row the pharmacy booked (assisted or legacy), the S2-scoped
  `GET /bookings`, `/bookings/:id` and `/bookings/user/:userId` return **only the booker view** of §17.2. It keeps the
  raw field names minus the hidden fields, so the released app keeps working; it never returns the raw booking.
- **Booker endpoints:** filter on `assisted.bookedBy` = the admitted organisation, cursor-paged.
- **Access ends** with authority (pharmacy not operational, member deactivated, permission or branch removed) or with
  the 90-day window.

### 9.3 Prescription → medicine order

- `POST /pharmacy-orders` with `prescriptionFromBookingId`. The server checks: this pharmacy booked it, it is within
  the 90-day window, a prescription PDF exists, the customer is the booking's account and is linked (S3).
- The server sets `prescriptionUrls` to the **dispensing copy** and binds the `pharmacy_order` grant itself; the
  uploader rule is unchanged for client values.
- The binding carries `expiresAt` = consultation + 90 days. It expires then **unless the order was dispensed**
  (reached `packed` or later: `packed`, `ready_for_pickup`, `out_for_delivery`, `completed`), in which case it stays
  as the dispensing record (N12).
- Medicines pre-fill as suggestions; P9 review, stock and payment apply. It is optional.

## 10. SMS (decision 15; overnight D, I)

### 10.1 `.env` variables

```
SMS_NOTICES_ENABLED=false              # master switch for the booking notices
SMS_SEND_TIMEOUT_MS=5000
SMS_NOTICE_MAX_ATTEMPTS=3
SMS_FALLBACK_LANGUAGE=en               # ASSUMED D1
SMS_UNICODE_PARAM=                     # provider flag for non-Latin text (confirmed in phase 5)
SMS_VISIT_REMINDER_MINUTES_BEFORE=120
SMS_JOIN_LINK_BASE_URL=                # https://<jansetu-domain>/j  (fixed in the template text)
JOIN_LINK_SECRET=                      # HMAC key for join tokens

# <MSG> = BOOKED, BOOKED_LINK, RX_READY, REPORT_READY, REMINDER, REMINDER_LINK, CANCELLED_MOVED
# <LANG> = EN HI OR BN AS LUS MNI KHA GRT NE …
SMS_<MSG>_<LANG>_TEMPLATE=             # DLT template id
SMS_<MSG>_<LANG>_ENABLED=false         # on/off per message and language (CANCELLED_MOVED off by default: decision D)

SMS_RECORDS_CODE_<LANG>_TEMPLATE=      # security message (§10.6); independent of SMS_NOTICES_ENABLED
SMS_RECORDS_CODE_<LANG>_ENABLED=false
```

- The template text lives in the repo (`smsNotices/templates/<lang>.ts`), byte-for-byte the registered DLT text.
- A notice is sent only when the master switch, that message's switch for that language and its id are all set.

### 10.2 Messages and variables

- **Recipient:** the account phone, for assisted and lab desk bookings.
- **Variables:** each is at most 30 characters.
- **Names** (`name`, `place`) are cleaned to **letters (any script), combining marks and single spaces only**, then
  cut. A name with nothing left becomes "your family member" in the message language.
- **Never included:** doctor name or speciality, test names, diagnosis, amounts. The only link is the fixed join URL.
- **Brand:** "Jansetu" (overnight decision I).

| Message | Variables | English text (draft for DLT) |
|---|---|---|
| booked | `name`, `service`, `date`, `time`, `place`, `ref` | `Jansetu: {#var#}'s {#var#} is booked for {#var#} at {#var#} via {#var#}. Ref {#var#}. Sign in to the Jansetu app with this number for details.` |
| booked, with link | + `token` | `… Ref {#var#}. Join the video call at https://<jansetu-domain>/j/{#var#} at the booked time.` |
| prescription ready | `name`, `date`, `place` | `Jansetu: the prescription for {#var#} from the consultation on {#var#} is ready. Sign in to the Jansetu app with this number, or ask {#var#}.` |
| report ready | `name`, `date`, `place` | `Jansetu: the lab report for {#var#} from {#var#} ({#var#}) is ready. Sign in to the Jansetu app with this number to see it.` |
| reminder (with / without link) | `name`, `service`, `date`, `time`, `place` [, `token`] | `Jansetu reminder: {#var#}'s {#var#} on {#var#} at {#var#}, {#var#}.` [+ ` Join: https://<jansetu-domain>/j/{#var#}`] |
| cancelled / moved (D) | `name`, `service`, `what` ("cancelled" / "moved to <date time>") | `Jansetu: {#var#}'s {#var#} has been {#var#}. Sign in to the Jansetu app with this number for details.` |

Instant consultations get "booked" only.

### 10.3 Language

`assisted.preferredLanguage` (desk: `desk.preferredLanguage`) is used if that message is enabled in that language;
otherwise English (ASSUMED D1); otherwise nothing.

### 10.4 SMS never affects a booking

- **After commit only.** After commit, one `Job` is inserted (`consumer: 'sms_notice'`,
  `uniqueId: sms:<message>:<bookingKind>:<bookingId>:<version>`); a failed insert is logged and ignored.
- **Sent marker.** `sms_notices_sent { bookingKind, bookingId, message, version, state: 'sending' | 'sent' | 'failed' |
  'skipped', leaseUntil, attempts }`, unique on the first four fields. The consumer claims the marker before sending
  (lease) and records the outcome. Delivery is **at-least-once**: a crash between the provider call and the outcome
  write can send twice after the lease expires; everything else never repeats.
- **The consumer drains** due jobs in a loop (bounded batch per tick) rather than one per tick. It re-reads the
  booking, skips stale states, sends with the timeout, retries with back-off, and logs only kind and outcome.
- **Answers never depend on SMS;** replays enqueue nothing. Tests cover unconfigured, error, timeout and success.

### 10.5 DLT

- One template per message × language × link variant, under the existing PE id and header.
- Unicode for non-Latin languages; the join domain is approved for URLs.
- Registration starts in phase 0 with English and Hindi; the north-east order is OPEN-OWNER O4.

### 10.6 Records-access code (security message)

- Text: `Jansetu: {#var#} is the code to let your doctor see {#var#}'s past health records. Share it only with the
  doctor treating you. Valid 10 minutes.` Variables: code, patient first name.
- It is sent immediately, not queued, because the doctor is waiting. Its failure only means no approval.

## 11. Languages and UI translation (phase 6)

### 11.1 Languages

| Language | Code | Script |
|---|---|---|
| English | `en` | Latin (source) |
| Hindi | `hi` | Devanagari |
| Odia | `or` | Odia |
| Bengali | `bn` | Bengali |
| Assamese | `as` | Bengali–Assamese |
| Mizo | `lus` | Latin |
| Manipuri | `mni` | Bengali or Meetei Mayek (O4) |
| Khasi, Garo | `kha`, `grt` | Latin |
| Nepali, Bodo | `ne`, `brx` | Devanagari |
| Kokborok, Nagamese | `trp`, (none) | Later waves |

The list is configuration. A language shows in a switcher once its catalogue is at least 95% reviewed.

### 11.2 Web apps (`jansetu-web`, Vite + React 19)

- **Library:** `i18next` + `react-i18next`.
- **Catalogues:** `packages/ui/src/i18n/locales/<lang>/<namespace>.json`, English as the source, lazy loading,
  English fallback.
- **CI:** `i18next-parser` and a literal-text lint; a pseudo-locale; Playwright screenshots per language.
- **Switcher:** in the header and on sign-in. It sets `<html lang>` and loads the script's Noto font on demand.
- **Stored choice:** `localStorage` before sign-in; after sign-in `uiLanguage` through `PUT /me/ui-language`, which
  wins at sign-in. A first customer sign-in proposes the booking language.
- **Formats:** `Intl` with `<lang>-IN`, falling back to `en-IN`.
- **Server messages:** the UI translates error codes. PDFs and admin screens stay English in this phase.
- **Translation:** professional translation with native-speaker clinical review, using Tolgee or Weblate
  (self-hosted).

## 12. Assumed and open

### 12.1 Assumed

**ASSUMED (overnight, reversible):** decisions A–I of §2.3.

**ASSUMED (design defaults):**

| # | Assumption | Where |
|---|---|---|
| D1 | SMS fallback language English | §10.3 |
| D2 | Recommended tests load by printed code plus phone | §7.6 |
| D3 | The provider-coupon rule applies to every ledger booking from phase 4 (assisted ones from phase 1a); older bookings keep their rule | §8.3 |
| D4 | A lab coupon is spread over lines by price, largest-remainder paise | §8.3 |
| D5 | The treating window ends 30 days after completion (7 days after the slot end if not completed); a records grant lasts 12 months unless revoked | §9.1 |
| D6 | Patient cancellations follow the existing customer windows | §8.7 |
| D7 | One-word names mask as two letters + "…" | §6.2 |
| D8 | The patient app shows "Paid by <partner>", not the amount (O3 confirms) | §6.7 |
| D9 | Spending uses withdrawable top-up money first, oldest lot first | §5.3 |
| D10 | Abuse and alert thresholds: lookups 120/h, ~~new accounts 30/day, 5 bookings per number per day, 20 cancellations a day stop new bookings~~ (**removed by owner, 23 Nov**: only the lookup limit refuses; 20 cancellations a day now only raise an alert), 30% cancel alert, 50% withdraw alert, 10 same-pair bookings a day | §6.2, §8.7 |
| D11 | Patients cannot reschedule partner-paid consultations; the booker can, before start, same doctor and price | §6.7 |
| D12 | The patient may book the free follow-up from an assisted consultation in the app; partners may not (S3) | §6.7 |
| D13 | Instant requests have no partner cancellation after acceptance | §7.7 |
| D14 | Pharmacy wallet balances from before phase 1a are not withdrawable | §15 |
| D15 | The booker and the generic-read view show a **dispensing copy** of the prescription without the diagnosis | §17.2 |

**ASSUMED (overnight, phase 1a):** decisions P1–P10 of §17.1.

### 12.2 Still open for the owner, and go-live gates

| # | Item | Status and gate |
|---|---|---|
| O1 | **Tax on referral payments** (GST invoices from partners, TDS). Note for the accountant: the commission is **paid out of the provider's earning and deducted by Jansetu** before the provider is paid, then paid to the partner by Jansetu | **OPEN-OWNER**; `REFERRAL_PAYOUTS_ENABLED=false` until the accountant answers |
| O2 | **Wallet limits and checks:** top-up minimum and maximum, maximum balance, documents required, withdrawal minimum, frequency and any waiting period after a card top-up | **OPEN-OWNER** (proposed: ₹50,000 maximum balance; one withdrawal a week; card money withdrawable 7 days after capture) |
| O3 | Confirm D8 (hide the partner's amount from the patient) | **OPEN-OWNER** |
| O4 | North-east SMS language order and the Manipuri script | **OPEN-OWNER** |
| GATE-NMC | Consultation cuts and doctor cuts may breach medical ethics rules on referral commissions | Flag, not advice. `REFERRAL_CONSULTATION_CUTS_ENABLED` and `REFERRAL_DOCTOR_CUTS_ENABLED` stay false until written legal advice is filed |
| GATE-RBI | Partner wallets with cash-out may be a regulated prepaid instrument | Flag, not advice. `WALLET_WITHDRAWALS_ENABLED` stays false, and wallets stay closed-loop, until finance and legal sign off |
| GATE-DPDP | Partner-attested consent, minors booked under a parent's number, records approval by SMS code, notice text | Flag, not advice. Phase 1a does not go live until the consent statement, privacy notice and the "not mine" process are reviewed |

## 13. Phased delivery

Each phase = backend + web + integration and browser tests + independent review. Commits stay local; stage only on the
owner's word. Sizes: S ≈ days, M ≈ 1–2 weeks, L ≈ 3+ weeks.

| Phase | Content | Size |
|---|---|---|
| **Pre** | S2 (on production) and S3 (hotfix) merged; Q2/Q3/Q4 migrations done (§15) | — |
| **0** | Pharmacy prescription bug (§17.2): (a) `GET /api/v1/pharmacy-bookings` (cursor), the booker view with the typed patient name, doctor, date, status and the prescription's medicines, advice and tests, **without the diagnosis**; the dispensing copy; the 90-day limit; the generic-read view; (b) "Create medicine order from this prescription" with server binding to the dispensing copy (S3-linked customers). No "Pay now"; the dependent check is S3's. Start DLT registration (en, hi, records code) | S–M |
| **1a — wallet only** | `assisted` block, `source`, consent, language, identity flag; lookup (masked) and the resolver order; pharmacy customer list fix; nearby doctor list; scheduled consultations by **pharmacy wallet only**; coupons with redemptions, `fundedBy` and `provider_coupon_v2` split; withdrawable lots (top-ups via the existing pharmacy Razorpay top-up + recovery sweep + "check my top-up"); always-posting refund credits; partner and patient cancellation; customer command routing (§6.7); booker-only prescription access with 90 days; generic `/bookings` assisted view; neutral Meet; Join call; **admin "move booking to another account" tool, holder "this isn't mine", doctor attestation badge**; **daily reconciliation, stuck-money report, abuse limits and alerts**; Meet guest check; earnings with the provider-coupon rule and cut 0 (§17.1 P5). Build specification: §17 | L |
| **1b — Razorpay per booking** | `assisted_*` contexts in every place of §6.4; organisation verification; late-capture rows; Razorpay refund worker and **operator queue** | M |
| **2** | Lab wallets; pharmacy → lab; lab → consultation; lab desk (visits, walk-ins, home collection, bill link); booker report access | L |
| **3** | Doctor wallet; doctor → lab; recommended tests; partner instant consults; treating window, read log, records-access codes and grants | L |
| **4** | Referral rules, switches (consultation and doctor off), referral accounts; earnings and cuts; `provider_coupon_v2` for all new ledger bookings; pharmacy finance screen; wallet withdrawals (behind `WALLET_WITHDRAWALS_ENABLED`), freeze, chargebacks and receivables; referral payouts behind `REFERRAL_PAYOUTS_ENABLED` | M–L |
| **5** | SMS notices (consumer, markers, drain loop, templates, per-language switches, link variants, `/j/` with rate limit, reminders, cancelled/moved) | M |
| **6** | UI translation | L + translation time |

**App versions.** The released pharmacy app books through the generic create.
- It stays open to pharmacies under S3 rules (legacy money) until the new pharmacy screens ship and the app-version
  check (`appVersions` module) marks older builds as required updates.
- Then `POST /bookings*` refuses pharmacies (403 `USE_ASSISTED_BOOKING`), switched by
  `PHARMACY_GENERIC_CREATE_ENABLED=false`.
- Web workspace users get the new screens at once.

## 14. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| **Records of a stranger after a no-OTP booking** | A partner could book any number to reach a doctor and pull history | Treating window starts at consultation start; other providers' records need the holder's SMS approval (A); doctor active and verified on every read; read log first; read-then-cancel alert |
| **Wrong or recycled number** | Records land in a stranger's account | Typed twice; `newAccount` shown; booked SMS alerts the real holder; holder "this isn't mine" flags the booking, hides it from the holder's lists and queues it for admins; the **admin move tool** (phase 1a) moves it to the right account (audited; the old account loses access at once; SMS to both numbers); doctors see "identity attested by the partner, not verified" |
| **Name hints** | Partners probe numbers | Masked name, per-organisation limits, audit, alerts; pharmacy customer list shows only typed names |
| **Health details leaking through side doors** | Meet invites, the pharmacy customer list, generic booking reads | Neutral Meet text; typed names only; allowlisted assisted view on generic reads |
| **Booking any number without OTP** | Accounts and SMS without agreement | Attestation recorded; partner pays; per-organisation and per-number limits; flags |
| **Card-to-bank cash-out and chargebacks** | Wallets could launder card money; disputes after spending | Only captured top-up lots are withdrawable, minus the fee (C); admin credits never withdrawable; withdrawals off by default, admin-paid to a verified own account; chargeback → freeze, receivable, set-off against referral balance; top-up-to-withdrawal alerts |
| **Refund that cannot post** | An inactive or suspended booker would block a cancellation | Wallet refunds and releases always post; tested |
| **Patient cancels after paying the partner in cash** | The refund goes to the partner | The cancel screen says so and names the partner; the partner is told; partner terms; audit |
| **Coupon abuse or mis-funding** | Limits bypassed through partner payers | Redemptions keyed to the patient; per-user coupons refused; guarded total counter; `fundedBy` snapshotted |
| **Provider earnings drop** | Provider-funded coupons and cuts | Statements show each part; providers told before phase 4; corporate coupons platform-funded |
| **Legal** | NMC, RBI, DPDP | Gates in §12.2 with switches off |
| **Money reconciliation** | Owed balances, refund failures, paise conversion | One method per booking, exactly-once keys, refund worker with operator queue, daily reconciliation and stuck-money report from phase 1a |
| **DLT timelines** | Many templates; Unicode and URL rejections | Early registration; English fallback; switches; the app works without SMS |
| **Meet access** | Guests may be blocked | Booker email as attendee; call mode fallback; checked in 1b |
| **Translation quality** | Medical words | Clinical review; English always available |

## 15. Deploy

**Prerequisites**, in order (all exist today):
1. `npm run migrate:q2-user-phones` (dry run, then `--commit`), then `sync-indexes`, so the resolver works.
2. `npm run migrate:q3-settlement-cutover` and Q4a deployed, for ledger earnings.
3. `npm run migrate:q4-reservations`.
4. S2 and S3 merged.

**Per phase:**
1. New models in `src1/modules/<module>/model/` (`sync-indexes` reads only those folders).
2. Run the phase's migrations (dry run, then `--commit`):
   - `source` is **not** backfilled;
   - `Coupon.fundedBy` set to `platform` for coupons with `corporateIds`, `provider` otherwise;
   - pharmacy wallets get `withdrawableMinor: 0` **only where the field is missing** (pre-existing balances are not
     withdrawable; ASSUMED D14, conservative; a rerun never resets a later value);
   - pharmacy wallet transactions get `signedAmountPaise`, and each wallet gets its opening-balance entry (§17.3);
   - pharmacy customer links get `typedName` backfilled (§17.4);
   - admin credits stay non-withdrawable.
3. `npm run sync-indexes` **before** turning on any writer. The order is the unique keys first:
   - `assisted.requestKey` (three collections);
   - `partner_wallet_entries.operationKey`;
   - `coupon_redemptions {couponCode, bookingKind, bookingId}`;
   - `sms_notices_sent`, `record_access_grants`, `referral_rules`, `wallet_withdrawals {requestKey}`;
   - then the lookup indexes.

   Add `assisted.shortRef`, `wallet_topup_lots.paymentRecordId`, `partner_wallets {ownerKind, ownerId}` and the
   pharmacy `{pharmacyId, operationKey}` index (§17.3) to that list. Writers check their unique index with the
   fail-closed pattern of Q15 N1 (503 `INDEXES_OUTDATED` if missing or different), and **every writer stays behind
   its flag until `sync-indexes` has run** in that environment.
4. Set env flags. Defaults are safe and off:

   | Flag | Default |
   |---|---|
   | `ASSISTED_BOOKING_ENABLED` (per booker kind: `_PHARMACY`, `_LAB`, `_DOCTOR`) | `false` |
   | `PHARMACY_GENERIC_CREATE_ENABLED` | `true` until the app switch |
   | `REFERRAL_CONSULTATION_CUTS_ENABLED`, `REFERRAL_DOCTOR_CUTS_ENABLED`, `REFERRAL_PAYOUTS_ENABLED` | `false` |
   | `WALLET_WITHDRAWALS_ENABLED` | `false` |
   | `SMS_NOTICES_ENABLED` and every `SMS_*_ENABLED` | `false` |
   | `JOIN_LINK_SECRET` | required before link templates are enabled |
   | Abuse thresholds | Defaults of D10 |

5. Stage first, then production only on the owner's word. Production auto-deploys from `main`.

**Rollback.** Turning the `ASSISTED_BOOKING_ENABLED_*` flags off stops **new** assisted bookings, top-ups and
withdrawal requests only. Reads, the booker view, cancellations, refunds (wallet and Razorpay worker), withdrawal
cancel/reject/void, the sweeps and reconciliation keep working, so no money is stranded. Migrations are additive and
leave old fields untouched.

## 16. Verification (to build with each phase)

**Keys and money:**
- The same key and request answer once: one debit, one seat, one redemption, one SMS marker. Other content → 409;
  abandoned keys never book.
- Wallet races never go negative. A withdrawal and a booking cannot both spend the same money. A withdrawal above
  `withdrawableMinor` is refused, and so is one without a verified destination.
- **A refund to an inactive, frozen or suspended wallet posts.** Releases and voids post.
- Chargeback with an empty wallet → receivable, freeze, set-off from referral.
- Razorpay:
  - a capture on an expired or never-paid booking makes its own late-capture refund row to source;
  - duplicate verify, check and sweep calls credit once;
  - top-ups are recovered by the sweep and "check my top-up";
  - a lab member other than the payer can verify.
- Instant: the percentage coupon is recomputed on the accepted fee; the quote difference is refunded by method, once;
  the booking has no money rows.
- Coupons:
  - per-user coupons are refused;
  - the total limit holds under concurrency for wallet and Razorpay payments;
  - cancellation reverses the redemption once;
  - the patient's own per-user count sees partner-paid uses.
- Splits:
  - provider- and platform-funded coupon splits match §8.1;
  - fixed and percent cuts per line with a per-line cap;
  - consultation and doctor switches off → cut 0;
  - provider + cut = base.

**Commands and access:**
- Each customer command and read of §6.7 behaves as listed, including hidden price and funding fields and 404 payment
  details.
- Cancellations: a partner cancelling a consultation one minute before start is refunded; a lab booking 59 minutes
  before is refused; a patient cancellation refunds the partner.
- Access:
  - booker sees the prescription only, and only for 90 days;
  - the generic `/bookings` read gives a pharmacy the assisted view;
  - the pharmacy customer list never shows the account name or email;
  - Meet invite text is neutral;
  - the treating window opens only at start and closes on cancellation;
  - other providers' records need a grant;
  - the read log is written before the answer;
  - an inactive or unverified doctor is refused;
  - the recommending doctor is refused the report.
- "This isn't mine" hides the booking and queues it. The admin move transfers access exactly once.

**SMS:**
- Off, failing, timing out or succeeding gives identical booking answers.
- The sent marker prevents double sends across retries.
- Names are reduced to letters and spaces.
- `/j/` tokens die on a move, are rate-limited, and redirect only in the window.
- Per-language switches fall back to English.

## 17. Phase 0 and phase 1a build specification (revision 4)

Where an earlier section and this one differ, this one wins.

### 17.1 Phase 1a decisions: ASSUMED (overnight, reversible)

| Id | Decision |
|---|---|
| **P1** | Pharmacy wallet store fields, sign rules, unique index and opening entry: §17.3 |
| **P2** | The gateway fee is Razorpay `fee` alone (GST included). A lot is not withdrawable until its fee is stored (§5.3) |
| **P3** | A wallet-paid booking writes **no payment record**; the wallet entry plus `assisted.funding` are the record. Coupons are counted only through `coupon_redemptions` (§6.4) |
| **P4** | Names, as set out in §17.4. **Narrowed after review (§19.7 item 2), ASSUMED, awaiting owner confirmation:** the real account name is shown (and searchable) only on a `customer_order` link; a `patient_agreed` link — the pharmacy's own tick — shows the typed name, else the masked holder name |
| **P5** | **Earnings in 1a.** Completion posts the provider's earning = `split.providerMinor` (provider-borne coupon, cut 0). `assisted.referral` is `null` until phase 4. A no-show earns nothing (§8.6) |
| **P6** | **Views.** The booker view and the generic-read view keep the raw booking field names minus the hidden fields, so the released pharmacy app keeps working (§17.2) |
| **P7** | **Limits.** A limit hit answers 429 `ASSISTED_LIMIT_REACHED` with the limit's name. ~~At 20 cancellations in a day by one booker, its new bookings are refused for the rest of the IST day~~ (**removed by owner, 23 Nov**: the only limit left is the hourly lookup limit, `limit: 'lookups'`); at 20 cancellations a day an alert is raised (alert only) |
| **P8** | **Admin move and "not mine"**, as set out in §17.5 |
| **P9** | **Booker reschedule.** The booker may reschedule a consultation before it starts in 1a: same doctor, same price, same slot rules (`rescheduleWithHolds`, `SLOT_NOT_THIS_DOCTOR`, started-slot fence) |
| **P10** | **Alerts.** They go to admin notifications and the daily reconciliation report. The same booker–doctor pair alerts at 10 bookings a day |

### 17.2 Phase 0: the booker's list, the view and the dispensing copy

**Route.** `GET /api/v1/pharmacy-bookings` (`requireOperationalPharmacy`):
- cursor-paged (`<ms>_<id>`), newest first;
- filter `status`, date range;
- rows are every booking with `pharmacyId` = this pharmacy, legacy and assisted;
- `GET /api/v1/pharmacy-bookings/:id` reads one (404 for any other booking).

**Booker view.** It keeps the raw field names. The same view is returned by S2-scoped generic `/bookings` reads to a
pharmacy (§9.2).

| Shown | Hidden |
|---|---|
| `_id`, `bookingType`, `bookingKind`, `source`, `assisted.shortRef`, `userId`, `dependentId`, **`patientName`** (added: the dependent's name when `dependentId` is set, otherwise the pharmacy link's `typedName`, otherwise the masked account name), `pharmacyId`, `specialistId`, `doctorName`, `primaryConcern` (typed at booking by the pharmacy), `consultationMode`, `serviceMode`, `clinicVisit`, `slotId`, `bookingDate`, `bookingTime`, `contactNo`, `status`, `paymentStatus`, `price`, `originalPrice`, `cancellationReason`, `cancelledAt`, `cancellationCause`, `noShow.at`, `lifecycle` (created/confirmed/completed/cancelled timestamps only), `virtualMeeting.joinUrl` (only for `join.on = partner_device`, inside the join window), `prescription.message`, `prescription.advice`, `prescription.medicines`, `prescription.testsAdvised`, `prescription.prescribedAt`, `prescription.prescribedBySpecialistName`, `prescription.fileUrls` (**the dispensing copy only**, within 90 days), `assisted.bookedBy.name`, `assisted.join.on`, `assisted.preferredLanguage`, `createdAt`, `updatedAt` | `prescription.diagnosis`, the full prescription PDF, `prescription.prescribedBySpecialistId`, `documents`, `report`, `followUp`, `alternateContactNo`, `serviceAddress`, `corporateId`, `wellnessPackageId`, `packageName`, `paymentTransactionId`, `holds`, `postPaymentCompletedFor`, `createRequestKey`, `createTerms`, `walletFunding`, `noShows`, `noShowReschedules`, `settlementSystem`, `settlement`, `clinicDesk`, `instantRequestId`, `instantExtensions`, `notes`, `expiryNextAt`, `expiryChecks`, other `lifecycle` details, `assisted.consent`, `assisted.identity`, `assisted.funding` (except in the booker's own payment screen), `assisted.split`, `assisted.referral`, `assisted.requestKey`, `assisted.requestHash` |

After 90 days from the consultation's end, the prescription fields and `fileUrls` are omitted from the booker view
(the rest stays).

**Dispensing copy (ASSUMED D15).**
- **What it is.** A server-rendered PDF `bookings/<id>/rx-dispense-<ts>.pdf` with: doctor name and registration,
  patient name, age and sex, date, medicines (name, dose, frequency, duration, instructions), advice, tests advised,
  and the line "Dispensing copy: diagnosis withheld". Jansetu brand.
- **When it is made.** When the doctor saves the prescription (`specialistPortal/services/index.ts:328-397`, next to
  the full PDF). For prescriptions saved before phase 0, it is made on the first booker request, idempotently.
- **File access** (`file/access.ts`):
  - a new server-folder pattern `^bookings/<id>/rx-dispense-\d+\.pdf$` is readable by the patient, the booking's
    doctor and the booker (90-day window);
  - the full-PDF pattern `BOOKING_PRESCRIPTION` stops admitting pharmacies (`:41`), leaving the patient and the doctor.
- **Medicine orders.** The dispensing copy is the file bound to an order made from the prescription (§9.3).

### 17.3 Pharmacy wallet store (N2)

**Fields added to `pharmacy_wallet_transactions`** (`pharmacyWallet/model/index.ts:14-43`):

| Field | Meaning |
|---|---|
| `signedAmountPaise` | Integer, signed; **required on new rows**; filled for old rows by the migration |
| `operationKey` | Exactly-once key for every new movement (`assisted:<bookingId>:debit`, `wallet_recharge:<paymentRecordId>`, `withdrawal:<id>:hold` …) |
| `withdrawableDeltaPaise` | Change to the withdrawable amount |
| `lotAllocations` | `[{ lotId, amountPaise }]` on spends, withdrawals and their reversals |

`amount` and `amountPaise` stay absolute (unsigned), as today.

**Fields added to `pharmacy_wallets`:** `withdrawableMinor`, `receivableMinor`, `frozen`, `version`, `ledgerOpenedAt`.

**Index:** `{ pharmacyId: 1, operationKey: 1 }` unique, partial on `{ operationKey: { $type: 'string' } }`. The
existing unique `{ pharmacyId, referenceType, referenceId }` is kept.

**Sign rules:**

| `transactionType` | Sign | Use |
|---|---|---|
| `credit` (existing) | + | Admin top-up (non-withdrawable) and the Razorpay recharge credit (`referenceType: 'wallet_recharge'`, creates a lot) |
| `debit` (existing) | − | Old rows only |
| `consultation_payment` (existing) | − | Old rows only (unrouted `payConsultation`) |
| `refund` (existing) | + | Old rows only |
| `adjustment` (existing) | ± | Old rows: after − before. New rows: signed admin correction (negative reduces lots first) |
| `booking_debit` (new) | − | Assisted booking paid from the wallet |
| `refund_credit` (new) | + | Refund of an assisted booking; always posts |
| `withdrawal_hold` (new) | − | Withdrawal request |
| `withdrawal_release` (new) | + | Cancelled or rejected withdrawal; always posts |
| `withdrawal_void` (new) | + | Bounced transfer; always posts |
| `chargeback` (new) | − | Lost dispute on a top-up (shortfall to `receivableMinor`) |
| `receivable_setoff` (new) | − | Clears a receivable from a credit that just arrived |
| `opening_balance` (new) | ± | One per wallet, from the migration |

For **old rows**, `signedAmountPaise` = `balanceAfterPaise − balanceBeforePaise` (the rupee fields × 100 where the
paise fields are missing). A row whose sign contradicts the table is listed in the migration report, not changed.

**Migration `npm run migrate:assisted-pharmacy-wallets`** (dry run, then `--commit`; run with the pharmacy flags off):
1. Fill `signedAmountPaise` on rows missing it.
2. Fill `balancePaise` from `balance` where it is missing.
3. Per wallet, insert one `opening_balance` row with amount `balancePaise − Σ signedAmountPaise`
   (`operationKey: migration:opening:<walletId>`; skipped when 0; non-withdrawable).
4. Set `ledgerOpenedAt`, and `withdrawableMinor: 0` only where missing.
5. Rerunnable: the key and the "only where missing" rules make a second run a no-op.

From then on, balance = Σ `signedAmountPaise` holds and is checked daily. New writers update `balance` and
`balancePaise` together, with paise authoritative.

### 17.4 Names and the typed-name rule (P4, N4)

- **The booker always types the patient's name**, including for "self".
- **New accounts.** When the booking created the account (resolver `created: true`) and the account `name` is empty,
  the typed holder name becomes `name`. Existing accounts are never renamed.
- **`typedName`.** It is stored on the booker's link to the holder:
  - pharmacies: `PharmacyCustomer`;
  - labs and doctors: a new `assisted_links { bookerKind, bookerId, userId, typedName, consent, createdAt }`, unique on
    `{bookerKind, bookerId, userId}`.

  It is the **name first typed for the account holder**. The booker may edit it with
  `PUT /api/v1/pharmacy-customers/:id/typed-name` (audited).
- **Family-member bookings.** The name goes on the dependent (created or matched) and does not change `typedName`. If
  the link has no `typedName` yet, the booking may carry an optional `holderName` to set it.
- **Pharmacy-facing lists keep their response shape.** The name field is filled from the link, never from the
  account:
  - `GET /pharmacy-customers` (`pharmacyCustomers/repository/index.ts:28-54`): `userId.name` = `typedName`, or the
    masked account name when empty; `userId.email` = `null`; search covers `typedName` and phone only (and the account
    name only on a `customer_order` link, §19.7 item 2);
  - pharmacy order lists, both populates of `customerId` (`pharmacyOrders/repository/index.ts:281`, `:307`):
    `customerId.name` from the link the same way;
  - pharmacy subscriptions (`pharmacySubscriptions/repository/index.ts:121`): `userId.name` from the link.

  These rules apply only when the caller is a pharmacy; admin and customer views are unchanged.
- **Backfill** (in the same migration as §17.3): `typedName` = the account name where **that pharmacy created the
  account** (`User.createdSource: 'pharmacy_app'` and `linkedPharmacyId` = the pharmacy). Other links stay empty and
  show the masked name.

### 17.5 Admin move and "this isn't mine" (P8)

**`POST /api/v1/admin/assisted-bookings/:id/move`** with `{ toPhone, asFamily?: { name, relation, gender?,
dateOfBirth? }, reason, requestKey, expectedUpdatedAt }`. It finds the booking in either collection (consultations,
partner-lab bookings).

1. The target account is resolved (resolver, outside the transaction).
2. In one transaction:
   - set `userId`, and `dependentId` (a family member created or matched under the target account; without `asFamily`
     the holder is the patient); a lab booking's `patient` snapshot is updated too;
   - move the booker's link: ensure the target link with `typedName` from the move, and remove the old link when no
     other booking by this booker uses it;
   - move the coupon redemption row (`patientUserId`, `dependentId`);
   - set `assisted.identity.disputed.state: 'moved'`;
   - bump `linkVersion` (an account move kills the old holder's join link);
   - write the admin audit.
3. **Completed bookings can move.** Prescriptions, reports and files follow the booking. The old holder loses access
   at once, because every customer read checks `userId`. The records grants of the old holder never apply to the
   moved booking.
4. **Notices.** In-app to the old holder ("a booking was moved off your account"), the new holder and the booker, with
   no health details. The SMS waits for phase 5.
5. **Repeats.** Exactly once per (admin, request key), with a content hash.

**`POST /api/v1/bookings/:id/not-mine`** and **`POST /api/v1/lab-bookings/:id/not-mine`** (customer, the account
holder; optional `note`):
1. The booking's `assisted.identity.disputed` becomes `{ state: 'open', at }`.
2. It is **hidden from the holder's lists** (direct reads by id still work for the holder until resolved), and an
   `assisted_review_items { kind: 'not_mine', bookingKind, bookingId, reportedBy, note, state: 'open' | 'moved' |
   'dismissed', at }` row is created for admins.
3. The booker sees the "reported as not mine" badge; the doctor's view shows the dispute.
4. A second report is 409 `ALREADY_REPORTED`.
5. Admins **dismiss** (unhide) or **move** (above).

### 17.6 Phase 1a routes

| Who | Route | Notes |
|---|---|---|
| Pharmacy | `POST /api/v1/pharmacy-assisted/patients/lookup` | Masked name; per-organisation limits |
| Pharmacy | `GET /api/v1/pharmacy-assisted/doctors?speciality&mode&language&date` | Nearby first (§7.1); active and verified only |
| Pharmacy | `POST /api/v1/pharmacy-assisted/consultations` | Wallet only in 1a; key, hash, coupon, split |
| Pharmacy | `GET /api/v1/pharmacy-bookings`, `GET /api/v1/pharmacy-bookings/:id` | Phase 0 list, now with assisted rows |
| Pharmacy | `POST /api/v1/pharmacy-assisted/bookings/:id/cancel` | `{ reason, expectedUpdatedAt }`; any time before start; limit P7 |
| Pharmacy | `POST /api/v1/pharmacy-assisted/bookings/:id/reschedule` | `{ slotId, requestKey, expectedUpdatedAt }` (P9) |
| Pharmacy | `GET /api/v1/pharmacy-assisted/bookings/by-key/:key`, `POST …/by-key/:key/abandon` | Q13 pattern |
| Pharmacy | `GET /api/v1/pharmacy-wallet`, `GET /api/v1/pharmacy-wallet/transactions`, `POST /api/v1/pharmacy-wallet/topup` (existing) | Responses add `withdrawableMinor`, `frozen`, `signedAmountPaise` |
| Pharmacy | `POST /api/v1/pharmacy-wallet/topups/:paymentTransactionId/check` | Reconcile one top-up |
| Pharmacy | `PUT /api/v1/pharmacy-customers/:id/typed-name` | §17.4 |
| Pharmacy | `POST /api/v1/pharmacy-orders` with `prescriptionFromBookingId` | Phase 0 |
| Customer | `POST /api/v1/bookings/:id/cancel` (existing) | Routed to the partner refund for assisted bookings (§6.7) |
| Customer | `POST /api/v1/bookings/:id/not-mine` | §17.5 |
| Admin | `POST /api/v1/admin/assisted-bookings/:id/move` | §17.5 |
| Admin | `GET /api/v1/admin/assisted/review-items`, `POST …/:id/dismiss` | "Not mine" queue |
| Admin | `GET /api/v1/admin/assisted/reconciliation`, `GET /api/v1/admin/assisted/stuck-money` | §8.8 |
| Admin | `GET /api/v1/admin/wallet-recharges/uncredited` | Old captured-but-uncredited top-ups (N5) |
| Admin | `PUT /api/v1/admin/pharmacies/:id/wallet/freeze` | `{ frozen, reason }` |
| Admin | Coupon edit adds `fundedBy` and `partnerUsable` | N1 |
| Doctor | Appointment views add `assisted.identity` ("identity attested by the partner, not verified") and `source` | No new route |

## 18. Assisted booking phase 0 built (build record, 2026-11-22)

Built on `m0/r2-assisted-phase0` (base: stage line `286eb0a` + this design). Local commits only; nothing pushed or
deployed. Suite: `test/assisted/phase0.integration.ts` (29 checks over HTTP after the review fixes). §18.5 records the
review fixes and replaces the statements of §18.1–§18.4 where they differ.

### 18.1 What was built

| Part | Where | Notes |
|---|---|---|
| Booker list and detail | `GET /api/v1/pharmacy-bookings`, `GET /api/v1/pharmacy-bookings/:id` (`src1/modules/assisted/`) | `requireOperationalPharmacy`. Rows: `pharmacyId` = the caller (legacy pharmacy bookings; assisted ones from 1a). Newest first by `createdAt`, exact cursor `<ms>_<id>`; index `{pharmacyId, createdAt: -1, _id: -1}` |
| Booker view | `assisted/bookerView.ts` | Exactly the §17.2 "Shown" list; hidden fields never copied (allowlist, not a denylist) |
| Generic reads | `bookings/controller` | A pharmacy's `GET /bookings`, `/bookings/:id`, `/bookings/user/:userId` return the booker view (S2 scope unchanged). Its create, retry and reconcile answers carry the strict booker view of the booking; payment-details keeps its ten payment fields (§18.5) |
| Dispensing copy (D15) | `assisted/dispensingCopy.ts`, PDF step `specialistPortal/pdf.ts` | `bookings/<id>/rx-dispense-<ms>.pdf`; stored as `prescription.dispensingCopy {url, hash, at}` |
| File access | `file/access.ts` | `canReadBooking` no longer admits pharmacies; new `BOOKING_RX_DISPENSE` pattern; expiring server bindings |
| Medicine order from the prescription | `POST /api/v1/pharmacy-orders` + `prescriptionFromBookingId` + `requestKey` (`assisted/rxOrder.ts`, `pharmacyOrders/services`) | Server binding of the dispensing copy; exactly once per (pharmacy, key) |
| Audit | `assisted_audit_events` (`assisted/model`) | `rx_order.created`, in the order's transaction, ids only |

### 18.2 Choices made while building (reversible)

1. **Booker = `Booking.pharmacyId`.** Phase 0 has no `assisted` block; `assisted.bookedBy` joins in 1a. The view already
   copies the allowed `assisted.*` sub-fields when present.
2. **`patientName`**: the dependent's name (only a family member of that booking's account); otherwise the link's
   `typedName` once 1a adds it; until then the account name **only when this pharmacy opened the account**
   (`createdSource: 'pharmacy_app'` and `linkedPharmacyId` = it, the §17.4 backfill rule); otherwise masked (§6.2, D7).
3. **`source`** is derived for stored rows exactly as §5.1 says (`clinic_desk` or `self`), so legacy pharmacy bookings
   show `self` until 1a stores `pharmacy_assisted`.
4. **Consultation end** (90-day window, §9.2): the later of the slot end (the booking's slot when it is on the booked
   date, else the booked time + 30 min), the completion time and an instant consultation's last extension; when no time
   parses, the end of the booked India day. Window = end + 90 days.
5. **When the copy is made.** At the doctor's save, only for bookings with a booker (`pharmacyId`), best effort (the
   prescription is saved even if the copy fails). Otherwise on the first booker read (list, detail, generic reads) or
   order. The copy carries a hash of the prescription content it shows; a prescription saved again by any writer makes
   the next request produce a fresh copy. The pharmacy reads only the **current** copy; older copies stay readable to the
   patient and the doctor (and through an order that bound them). A list converts missing copies one at a time; a
   converter failure shows `fileUrls: []` and never fails the read.
6. **Copy content.** Doctor name and registration (`medicalRegistrationNumber`), patient name (rule 2), age and sex,
   date, reference, medicines (name, dose, frequency, duration, instructions), advice, tests, "Dispensing copy: diagnosis
   withheld", brand Jansetu. The doctor's free-text `message` is **not** printed (it may hold clinical detail); it stays
   in the booker view as §17.2 lists it.
7. **Who reads the copy.** Patient (account holder), the booking's doctor, and the booking pharmacy while operational
   (active, verified, not archived) inside the window. HR is not given the copy; HR keeps reading the full PDF of its
   corporate's bookings as before (unchanged, outside this phase).
8. **Narrowing.** `canReadBooking` (full PDF and `booking` bindings: `documents.url`, `prescription.fileUrls`,
   `report.fileUrls`) admits the patient, the booking's doctor and HR only. Files a pharmacy uploaded itself stay
   readable through the uploader rule. `test/file-access/d1-private-files.integration.ts` was changed accordingly.
9. **Order from the prescription.**
   - Needs `requestKey` (`[A-Za-z0-9_-]{8,64}`, the existing request-key routes' format; kind `pharmacy_rx_order` in
     `/request-keys/lookup` and `/abandon`). The hash is over the request body without the key.
   - The customer is the booking's account (`customerId` may be omitted; another one is 404); `linkedConsultationId`
     is set to the booking. Client `prescriptionUrls` are refused with it (`PRESCRIPTION_SOURCE_CONFLICT`); a client
     can never attach the copy or the full PDF itself (uploader rule, `FILE_NOT_ATTACHABLE`).
   - The S3 link must already exist with consent (`patient_agreed` or `customer_order`); no link is made silently.
   - The binding is a `file_grants` row with `source: 'server'`, `expiresAt` = consultation end + 90 days and
     `keepIfDispensed: true`; after the expiry it counts only while the order is `packed`, `ready_for_pickup`,
     `out_for_delivery` or `completed` (current status; a cancelled order loses it).
   - The order's customer and linked consultation are then locked (`ORDER_PRESCRIPTION_PARTY_LOCKED`), because the
     order's customer reads the bound copy.
   - Writers check their unique indexes fail-closed (503 `INDEXES_OUTDATED`): `pharmacy_orders {pharmacyId,
     prescriptionFromBooking.requestKey}` and `request_keys {scope, key}`.
10. **Not built (phase 1a or later):** `assisted` block, `typedName` and its edit route, the masked customer list, the
    "Join call" for partner devices (the rule is in the view but no phase 0 row has `assisted.join`), wallets, partner
    payment, lab and doctor bookers, record-access codes. DLT template registration (en, hi, records code) is an
    operations task outside the code.

### 18.3 API for the web (phase 0)

`GET /api/v1/pharmacy-bookings?status&from&to&cursor&limit` — pharmacy token. `status` ∈ pending, confirmed,
completed, cancelled, no_show; `from`/`to` = appointment date `YYYY-MM-DD` (inclusive); `limit` 1–50 (default 20).
Answer `{ success, data: [view…], pagination: { total, nextCursor } }`. Errors: 400 `VALIDATION_ERROR`,
`INVALID_CURSOR`, `INVALID_DATE_RANGE`; 401; 403 `FORBIDDEN` (not a pharmacy), `PHARMACY_INACTIVE`,
`PHARMACY_NOT_VERIFIED`, `PHARMACY_PROFILE_REQUIRED`.

`GET /api/v1/pharmacy-bookings/:id` — `{ success, data: view }`; 404 `BOOKING_NOT_FOUND` for another pharmacy's,
a missing or a malformed id (one answer).

View fields: §17.2 "Shown" plus `patientName`. `prescription` = `{ advice, medicines[], testsAdvised[], prescribedAt,
prescribedBySpecialistName, fileUrls: [dispensing copy], copyPending? }` (no `message`, §18.5), absent before the doctor
saves one and after the 90-day window. `fileUrls: []` with `copyPending: true` while the copy is being made (lists never
make it in the request; read again shortly). Open the file through the usual `/api/static/…` URL with the pharmacy
token.

`POST /api/v1/pharmacy-orders` with `{ prescriptionFromBookingId, requestKey, orderType, items[], paymentMode,
deliveryMode, deliveryAddress?, isWalkIn?, notes?, customerId? }` (pre-fill `items` from `prescription.medicines`; the
web matches them to stock). 201 `{ order, paymentRequired, payment? }`; a replay adds `replayed: true`. Errors:
400 `REQUEST_KEY_REQUIRED`, `REQUEST_KEY_UNSUPPORTED` (a key without `prescriptionFromBookingId`),
`PRESCRIPTION_SOURCE_CONFLICT`, `LINKED_ORDER_REQUIRES_USER`, `FILE_NOT_ATTACHABLE`; 403 `CUSTOMER_NOT_LINKED`,
`CUSTOMER_CONSENT_REQUIRED`, `PRESCRIPTION_ACCESS_EXPIRED`, pharmacy admission codes; 404 `BOOKING_NOT_FOUND`;
409 `PRESCRIPTION_NOT_READY`, `IDEMPOTENCY_KEY_REUSED`, `REQUEST_ABANDONED`; 503 `DISPENSING_COPY_UNAVAILABLE`,
`INDEXES_OUTDATED`; then the usual order errors (stock, prices). `PUT /pharmacy-orders/:id` changing the customer or
linked consultation of such an order: 409 `ORDER_PRESCRIPTION_PARTY_LOCKED`.

### 18.4 Deploy notes (phase 0)

1. `npm run sync-indexes` before using the order route: new `bookings {pharmacyId, createdAt, _id}`,
   `pharmacy_orders {pharmacyId, prescriptionFromBooking.requestKey}` (unique, partial) and the new collection
   `assisted_audit_events`. Until then the order route answers 503 `INDEXES_OUTDATED`; the list works.
2. No migration: copies of older prescriptions are made on first request.
3. `wkhtmltopdf` must be on the server (`WKHTMLTOPDF_BINARY` to override), as for the full prescription PDF.
4. Behaviour change for the released pharmacy app: generic `/bookings` reads no longer include the diagnosis,
   documents, report, notes or money internals, and `prescription.fileUrls` now holds the dispensing copy; the full
   PDF URL returns 404 to a pharmacy.

### 18.5 Review fixes (extra-high review of `9ce19b0` / `e248f57`)

Each fix has its own check in the suite. On `e248f57` every new check fails (24 of the 29 checks fail there; the 5
that pass are unchanged S3 and access guards). A mutation run on the fixed code undid each of 16 sub-fixes alone and
confirmed that its check then fails.

| # | Finding | Fix |
|---|---|---|
| 1 (HIGH) | `POST /payments/verify` and `/payments/reconcile` returned the raw booking (diagnosis, full PDF, documents, report, notes) to the booking pharmacy | `payment/controller`: for a pharmacy caller, an `entity` of context `booking` is the booker view (prescription only while the pharmacy is operational and inside the window; copies queued, never made in the request). Customers keep the customer view, admins the booking. No other payment answer carries a booking (`pharmacy_order` is the pharmacy's own order) |
| 2 (HIGH) | A prescription the client sent at booking create became a Jansetu copy in the doctor's name | Only a prescription the server marked as the doctor's save counts: `lifecycle.prescriptionUploaded.at`, set by `createAppointmentPrescription` (the create schema does not accept `lifecycle`). `rxAccess.hasPrescription(booking)` is used by the view, the copy, file access and `rxOrder`; client `prescribedAt` / `prescribedBySpecialistId` are ignored. The copy prints the doctor's name from the doctor record. The root cause (the generic create accepting `prescription` / `report`) is the separate hotfix S4 |
| 3 (HIGH) | Concurrent first requests deleted the stored copy's file (same name in the same millisecond, shared temp file, unconditional removal) | Each attempt writes `rx-dispense-<ms>-<16 hex>.pdf` from its own random temp file (`wx`). The store is a compare-and-set on the copy state read (url + hash, plus the prescription's `prescribedAt` and save mark), retried up to 3 times; the loser removes only its own file, never the stored one. A stored copy whose file is missing is not current and is made again on the next read |
| 4 (MEDIUM) | `reconcile-payments` (and create, retry) answered a near-raw booking | Every pharmacy answer of `/bookings*` that carries a booking uses the strict booker view (§17.2 shown list). `payment-details` keeps its ten payment fields (no clinical data). The released pharmacy app does not call `/api/v1/bookings*` (checked by the reviewer) |
| 5 (MEDIUM) | Access did not end with authority on generic reads and order bindings | Every `/bookings*` route answers a pharmacy that is not operational 403 (`PHARMACY_INACTIVE`, `PHARMACY_NOT_VERIFIED`), as `/pharmacy-bookings` does. A pharmacy reads through an order's server binding only while operational. (`test/booking-scope/s2-booking-read-scope.integration.ts` now gives its two pharmacy tokens real verified pharmacies.) |
| 6 (LOW-MEDIUM) | One list request converted every missing copy before answering | Lists (`/pharmacy-bookings`, generic lists, payment answers) never convert: `fileUrls: []` + `copyPending: true`, and the booking is queued (`Job`, consumer `assistedDispensingCopy`, one job per booking, at most 10 per run, one at a time; a failure is retried when a later list queues it again). Detail reads and orders still make a missing copy inline. The converter is killed after `PDF_CONVERTER_TIMEOUT_MS` (default 30 s; also for the full PDF) and a partial file is removed |
| 7 (LOW) | Stale copy and cancelled-order binding | The pharmacy reads the copy only when its stored hash matches the prescription now. An order's binding serves nothing while the order is cancelled, rejected or abandoned. Packing records `prescriptionFromBooking.dispensedAt` (first `packed`); after the expiry the binding counts only for a dispensed order whose `dispensedAt` is before the expiry, so packing late never revives it |
| 8 (LOW) | Names | One rule for every pharmacy-facing name (booker view, copy, `GET /pharmacy-orders`, `/pharmacy-orders/prescription-reviews`): the link's `typedName` (1a); until then the account name only for an account this pharmacy opened that its holder never took over (`otpVerified` not true, so it is still the name the pharmacy typed); otherwise masked. A one-word name of two letters or fewer is "…". Admin and customer views are unchanged. Consequence: until 1a adds typed names, the pharmacy order list shows masked names for customers who signed up themselves or took over their account |
| 9 (LOW) | Notes | `prescription.message` is left out of the booker view. `prescription.dispensingCopy.hash` / `.at` are `select: false`: customers, doctors, HR and admins see only `dispensingCopy.url`; the assisted module selects them explicitly. `PUT /pharmacy-orders/:id` that removes or replaces the bound copy: 409 `ORDER_PRESCRIPTION_LOCKED`. Cursor: a row stored without `createdAt` pages as `n_<id>` after every dated row (each row once) |

**Names, changed in phase 1a (decision, overnight, assumed; §19.6 item 8), then narrowed (§19.7 item 2, ASSUMED,
awaiting owner confirmation):** only where the customer linked the pharmacy themselves — consent `customer_order`, the
customer ordered from it — does the pharmacy see (and search) the real account name. `patient_agreed` is the
pharmacy's own "patient agreed" tick and unlocks nothing. Every other link (`patient_agreed`, `not_recorded`, missing)
gets finding 8's rule: the typed name, else the account name of an account this pharmacy opened that its holder never
took over, else masked ("Rina D.").

**New answers for the web:** `prescription.copyPending`; 409 `ORDER_PRESCRIPTION_LOCKED`; 403 pharmacy admission codes
on every `/bookings*` route; cursor values may be `n_<id>`.

**Deploy:** the job scheduler must run (it already does for reminders). `PDF_CONVERTER_TIMEOUT_MS` is optional.

## 19. Assisted booking phase 1a built (build record, 2026-11-22)

Built on `m0/r3-assisted-phase1a` (base: phase 0 `e248f57` on the stage line `286eb0a`). Local commits only; nothing
pushed or deployed. Suite: `test/assisted/phase1a.integration.ts` (30 checks over HTTP with the real `authenticate` and
routers; all 30 fail without the source changes). Phase 1a is **wallet payments only**: Razorpay per booking (1b), lab
and doctor bookers (2, 3), referral cuts (4), withdrawals (4) and SMS (5) are not built.

### 19.1 What was built

| Part | Where | Notes |
|---|---|---|
| `assisted` block, `source`, `earningRule` | `bookings/model`, `assisted/types.ts` | `assisted` is a Mixed sub-document written only by the assisted writers; indexes `{assisted.bookedBy.kind, .id, createdAt}`, unique partial `assisted.shortRef`, unique partial `assisted.requestKey` |
| Switches and thresholds | `assisted/flags.ts` | §19.4 |
| Masked lookup | `POST /pharmacy-assisted/patients/lookup` (`assisted/pharmacyCommands.ts`) | `{ exists, holderNameMasked }`; 120 an hour per pharmacy; audited `patient.lookup` (ids only) |
| Nearby doctors | `GET /pharmacy-assisted/doctors` | Active and verified only; pharmacy pincode, then city, then language, fee, next slot |
| Wallet-paid consultation | `POST /pharmacy-assisted/consultations` (`assisted/consultations.ts`) | One transaction: key claim, family member, link with consent and typed name, seat and doctor interval, per-phone count, coupon redemption, wallet debit (lots), booking, audit. No payment record (P3) |
| Pharmacy wallet ledger | `pharmacyWallet/ledger.ts`, `pharmacyWallet/model/lots.ts` | The one writer of movements from 1a: operation key, signed paise, version, lots, withdrawable; credits always post |
| Refunds by method | `assisted/refunds.ts`, hooked into `bookings/holds.ts` `cancelBookingSettlement` | Every cancel path of an assisted row (booker, patient, doctor, admin, admin moved-no-show) refunds the payer's wallet in the cancel transaction; never the customer wallet |
| Booker cancel and reschedule | `POST /pharmacy-assisted/bookings/:id/cancel`, `/reschedule` | Cancel any time before the start; reschedule P9; by-key and abandon (Q13) |
| Customer command routing (§6.7) | `bookings/services`, `bookings/controller`, `assisted/views.ts` | Patient cancel refunds the partner; pay-again / retry / reconcile 409 `PARTNER_PAID_BOOKING`; patient reschedule 409 `ASSISTED_RESCHEDULE_BY_PARTNER`; payment details 404; reads without the partner money, with `paidBy` |
| Coupons | `coupon/model/redemption.ts`, `coupon/model` (`fundedBy`, `partnerUsable`), `coupon/repository` | Redemption keyed to the patient, guarded total count, reversed once on cancel; per-user count adds partner-paid uses |
| Earnings (P5) | `doctors/services/earnings.ts` | A `provider_coupon_v2` row earns `split.providerMinor` (gross `baseMinor`, commission `cutMinor` = 0) on completion only; no-show earns nothing |
| Typed names (§17.4) | `pharmacyCustomers/*`, `assisted/names.ts` | The phase 0 rule (§18.5 finding 8, `pharmacyFacingHolderNames`: typed name, else an account the pharmacy opened and the holder never took over, else masked) now also names the customer list (`userId.email` null) and the subscription list (`withLinkNames`); order lists and the review queue keep phase 0's `withPharmacyFacingCustomerNames`. `PUT /pharmacy-customers/:id/typed-name` |
| "Not mine", review queue, admin move (§17.5) | `assisted/review.ts` | Consultations only in 1a |
| Reconciliation and stuck money (§8.8) | `assisted/reconciliation.ts`, `assisted/schedulers.ts` | Live admin route; daily job stores the report, raises alerts, fills gateway fees |
| Neutral Meet and guest check (N6) | `meet/service` `meetEventTextFor` | §19.2 item 11 |
| Doctor views | `specialists/controller` | `source` and `assisted.identity.note` = "Identity attested by the partner, not verified" |
| Migration | `npm run migrate:assisted-pharmacy-wallets` (`scripts/assistedPharmacyWallets.ts`) | §19.5 |

### 19.2 Choices made while building (reversible)

1. **Mixed `assisted` block.** The block is a Mixed path (typed in `assisted/types.ts`) so refund rows, reschedules and
   moves are appended without schema churn; only the assisted writers write it.
2. **Request keys.** Stored as `assisted:pharmacy:<pharmacyId>:<actorId>:<key>` (unique partial index) and claimed in
   the transaction in scope `assisted_consult_create:<pharmacyId>:<actorId>`. The hash (`canonicalJson`) covers phone,
   patient identity, `holderName`, slot, mode, join, coupon, language, concern, notes and `acceptedPriceMinor`; not the
   payment method. Reschedule keys: scope `assisted_reschedule:<pharmacyId>:<bookingId>`, hash of the slot. Move keys:
   scope `assisted_move:<adminId>`.
3. **Settlement.** Assisted rows are always `settlementSystem: 'ledger'`, whatever `SETTLEMENT_CUTOVER_AT` says (§5.1).
4. **Lots and withdrawable.** A card top-up opens a lot only while `ASSISTED_BOOKING_ENABLED_PHARMACY` is on and the
   lot index exists (otherwise non-withdrawable: the conservative side). Spending consumes **every open lot** (fee
   known or not) oldest first, then non-withdrawable money, so Σ open lots ≤ balance always holds; `withdrawableMinor`
   is recomputed from the eligible lots (not closed, fee known, no dispute) on every movement. A refund restores the
   debit's allocations only for a full refund (the only kind in 1a); a closed lot is never restored. The fee is
   Razorpay `fee` alone, kept on the payment record (`gatewayFeeMinor`) at verify and at reconcile; the daily job
   fills unknown fees.
5. **Admin top-ups** now go through the ledger too (operation key `admin_topup:<Idempotency-Key or random>`),
   non-withdrawable. `PharmacyWalletRepository.atomicCredit` no longer requires `isActive: true`.
6. **Coupons.** A coupon with `usageLimitPerUser`, or platform-funded without `partnerUsable`, is refused 400
   `COUPON_NOT_FOR_ASSISTED` before the ordinary rules, which run against the patient (account, family member, the
   account's `corporateId`). Exhausted inside the transaction: 409 `COUPON_EXHAUSTED`. The split freezes `fundedBy`.
7. **Customer views.** Partner-paid rows hide `price`, `originalPrice`, `paymentTransactionId`, `walletFunding`,
   `createTerms` and the `assisted` money, keys and consent actor; they add `paidBy`. **`paymentStatus` stays** (not an
   amount; the released app reads it to decide whether to offer payment). Admins see the block whole except the
   request key and hash. Doctors get the same view plus the identity note.
8. **Cancellation causes** on assisted rows: `booker`, `patient`, `doctor`, `admin` (the refund row's `cause` too).
   The generic `/bookings/:id/cancel` by a pharmacy token still finds nothing (404); only the booker route cancels for
   the booker, so the P7 count and the audit are never skipped.
9. **Limits (P7).** Counters in `assisted_counters` (TTL), per organisation; phones HMAC'd. Lookups: clock hour;
   new accounts: IST day, counted only when the number has no account yet; bookings per phone: counted inside the
   booking transaction (aborted bookings do not count); booker cancellations: counted in the cancel transaction, new
   bookings refused once the day's count reaches the threshold. Alerts (`assisted_alerts`, one per subject and day):
   `booker_cancellations`, `same_pair_bookings` (10 a day), `cancel_rate` (≥ 30 % of 7 days, minimum 10, daily job),
   `reconciliation_mismatch`. There is no admin inbox, so "admin notifications" are this list
   (`GET /admin/assisted/alerts`) plus the daily report.
10. **"Not mine" and move.** A booking can be reported once (`ALREADY_REPORTED`, whatever the outcome). Open reports
    leave the holder's lists (paged and unpaged); direct reads still work. The move ensures the booker's link to the
    target (typed name: `holderName`, else the old link's) and removes the old link only when no other booking of
    that pharmacy and no pharmacy order uses that customer. Without `asFamily` the target holder is the patient.
11. **Meet (N6).** Assisted events: title "Jansetu consultation", description "Jansetu booking reference: <shortRef>",
    attendees the doctor and the booking pharmacy's email, `guestsCanSeeOtherGuests` and `guestsCanInviteOthers` false;
    a missing patient email no longer blocks them. The guest check (`GET /admin/assisted/meet-guest-check/:id`) says
    whether the partner device joins as an attendee or as a guest the doctor admits ("ask to join"). **Manual check
    before go-live:** on stage, book `partner_device` video with and without a pharmacy email, join from the pharmacy
    device signed out of Google, and confirm the doctor sees and can admit the guest; record the result here.
12. **Reconciliation** reports wallets with unsigned rows as `notMigrated` instead of flagging them, and lists the
    later-phase items (Razorpay refund rows, late captures, withdrawals) as not built.
13. **Not built in 1a:** Razorpay per booking and the operator queue (1b); withdrawals and their admin flow (phase 4,
    `WALLET_WITHDRAWALS_ENABLED` stays false and nothing reads it yet); partner-lab assisted rows and their
    "not mine" / move (phase 2); `source` on non-assisted rows (still derived); the generic-create switch
    `PHARMACY_GENERIC_CREATE_ENABLED` (needs the app-version step, §13); SMS of the move (phase 5); audit of coupon
    `fundedBy` edits (edited through the existing coupon update, not audited separately).

### 19.3 API for the web (phase 1a)

All pharmacy routes: pharmacy token, operational and verified (`PHARMACY_INACTIVE`, `PHARMACY_NOT_VERIFIED`, …).
Answers `{ success, data }`. Money is paise.

- `POST /api/v1/pharmacy-assisted/patients/lookup { phone }` → `{ exists, holderNameMasked }`. 429
  `ASSISTED_LIMIT_REACHED` `limit: 'lookups'` (with `Retry-After`).
- `GET /api/v1/pharmacy-assisted/doctors?speciality&mode&language&date&limit` → `[{ doctorId, name, specialization,
  languages, city, experienceYears, feeMinor, nearby: 'pincode'|'city'|null, nextSlot: { slotId, date, startTime,
  endTime, startsAt, modes }, slots?: [...] }]` (`slots` = that `date`'s free slots).
- `POST /api/v1/pharmacy-assisted/consultations` with `{ requestKey ([A-Za-z0-9_-]{8,100}), phone, patient:
  { relation: 'self', name } | { dependentId } | { relation, name, gender?, dateOfBirth? }, holderName?, consent:
  { agreed: true, statementVersion, statementLanguage }, preferredLanguage, slotId, consultationMode: 'video'|'call'|
  'in-person', join?: { on: 'partner_device'|'patient_phone', phone? } (required for video/call, absent in person),
  couponCode?, acceptedPriceMinor, primaryConcern?, notes?, paymentMethod: 'wallet' }` → 201 `{ booking: { _id,
  status, paymentStatus, bookingDate, bookingTime, slotId, specialistId, doctorName, consultationMode, userId,
  dependentId, source, price, originalPrice, updatedAt, createdAt, assisted: { shortRef, preferredLanguage, join,
  bookedBy } }, funding: { method, amountMinor, state, walletEntryId }, split: { listMinor, discountMinor, couponCode },
  newAccount, replayed }`; a replay is 200 with `replayed: true`. Errors: 400 `CONSENT_REQUIRED`,
  `PAYMENT_METHOD_UNAVAILABLE` (Razorpay is 1b), `REQUEST_KEY_REQUIRED`, `INVALID_PHONE`, `VALIDATION_ERROR`,
  `INVALID_COUPON`, `COUPON_NOT_FOR_ASSISTED`; 404 `DEPENDENT_NOT_FOUND`; 409 `PRICE_CHANGED` (`details: { priceMinor,
  listMinor, discountMinor }`), `SLOT_NOT_AVAILABLE`, `SLOT_STARTED`, `DOCTOR_NOT_AVAILABLE`, `INSUFFICIENT_BALANCE`,
  `WALLET_FROZEN`, `WALLET_INACTIVE`, `COUPON_EXHAUSTED`, `IDEMPOTENCY_KEY_REUSED`, `REQUEST_ABANDONED`; 429
  `ASSISTED_LIMIT_REACHED` (`limit: 'new_accounts' | 'bookings_per_phone' | 'booker_cancellations'`); 503
  `ASSISTED_BOOKING_DISABLED`, `INDEXES_OUTDATED`, `CUSTOMER_LINKING_UNAVAILABLE`.
- `GET /api/v1/pharmacy-assisted/bookings/by-key/:key` → `{ state: 'used', booking: <booker view> } | { state:
  'abandoned' } | { state: 'unknown' }`; `POST …/by-key/:key/abandon` → `abandoned` or `used` with the booking.
- `POST /api/v1/pharmacy-assisted/bookings/:id/cancel { reason?, expectedUpdatedAt? }` → `{ booking: <booker view>,
  refundedMinor, alreadyCancelled }`. 400 `BOOKING_ALREADY_STARTED`; 404 `BOOKING_NOT_FOUND`; 409 `BOOKING_CHANGED`,
  `BOOKING_NOT_CANCELLABLE` (completed, no-show), `NO_SHOW_NOT_REFUNDABLE`.
- `POST /api/v1/pharmacy-assisted/bookings/:id/reschedule { slotId, requestKey, expectedUpdatedAt? }` → `{ booking:
  <booker view>, replayed }`. 400 `BOOKING_ALREADY_STARTED`; 409 `SLOT_NOT_THIS_DOCTOR`, `SLOT_NOT_AVAILABLE`,
  `SLOT_STARTED`, `BOOKING_CHANGED`, `IDEMPOTENCY_KEY_REUSED`.
- `GET /api/v1/pharmacy-bookings[/:id]` (phase 0) now lists assisted rows; the view adds `assisted.disputed.state`
  (the "reported as not mine" badge). "Cancelled by patient" = `cancellationCause: 'patient'`.
- `GET /api/v1/pharmacy-wallet` adds `withdrawableMinor`, `frozen`, `receivableMinor`; `GET …/transactions` rows carry
  `signedAmountPaise`, `operationKey`, `withdrawableDeltaPaise`, `lotAllocations`. `POST
  /api/v1/pharmacy-wallet/topups/:paymentTransactionId/check` → `{ state: 'credited' | 'unpaid', wallet }` (404 for
  another pharmacy's record).
- `PUT /api/v1/pharmacy-customers/:id/typed-name { typedName }` (`id` = link id or the customer's user id) → `{ _id,
  userId, typedName }`. `GET /api/v1/pharmacy-customers`: `userId.name` = typed name or masked, `userId.email` = null,
  search = typed name and phone.
- Customer: `POST /api/v1/bookings/:id/not-mine { note? }` → `{ reported, reviewItemId }` (403 non-customer, 404, 409
  `NOT_ASSISTED_BOOKING`, `ALREADY_REPORTED`, 503 when the admin tools are off). `POST /api/v1/bookings/:id/cancel`
  works for assisted rows (customer windows; the refund goes to the partner). Booking reads show `paidBy`,
  `assisted.{shortRef, bookedBy.name, preferredLanguage, join.on, identity}`.
- Admin: `POST /api/v1/admin/assisted-bookings/:id/move { toPhone, asFamily?: { name, relation, gender?, dateOfBirth? },
  holderName?, reason, requestKey, expectedUpdatedAt? }` → `{ booking: { _id, userId, dependentId, status, …, disputed },
  replayed }`; `GET /api/v1/admin/assisted/review-items?state&limit`; `POST …/review-items/:id/dismiss { reason? }`;
  `GET /api/v1/admin/assisted/reconciliation[?day=YYYY-MM-DD]` (live, or the stored report of that day);
  `GET /api/v1/admin/assisted/stuck-money`; `GET /api/v1/admin/assisted/alerts`; `GET
  /api/v1/admin/assisted/meet-guest-check/:id`; `GET /api/v1/admin/wallet-recharges/uncredited`; `PUT
  /api/v1/admin/pharmacies/:id/wallet/freeze { frozen, reason }`. Coupon create and update accept `fundedBy`
  (`provider` | `platform`) and `partnerUsable`.
- Admin chargebacks (admin tools switch; §19.6 item 7, §19.7 item 1, §19.8 item a): `GET
  /api/v1/admin/pharmacies/:id/wallet/lots` → the pharmacy's top-up lots (`openedAtChargeback` marks a lot recorded at a
  chargeback). `POST /api/v1/admin/wallet-lots/:lotId/chargeback { reason }` → `{ entry, wallet, replayed }`; 404
  `LOT_NOT_FOUND`. `POST /api/v1/admin/wallet-payments/:paymentId/chargeback { reason }` (`paymentId` = payment record
  id, Razorpay `order_…` id, or Razorpay `pay_…` id; a payment id the database never stored is resolved through the
  gateway, read only, §19.9) → for a credited top-up `{ blockedUncredited: false, entry, wallet, replayed, lotId,
  paymentRecordId, withoutLot }`; for one never credited `{ blockedUncredited: true, credited: false, replayed,
  paymentRecordId, message }` (nothing taken; the top-up can never be credited). Errors: 400 `VALIDATION_ERROR`; 404
  `TOPUP_NOT_FOUND`, `TOPUP_NOT_FOUND_BY_PAYMENT_ID` ("try the order id or the record id"); 502
  `RAZORPAY_PAYMENT_FETCH_FAILED`; 409 `PAYMENT_AMBIGUOUS`, `WALLET_CHANGED` (retry); 503 `INDEXES_OUTDATED`, `ASSISTED_BOOKING_DISABLED`
  (admin tools off). A blocked top-up answers 409 `TOPUP_BLOCKED` on `POST /api/v1/payments/verify`, `POST
  /api/v1/payments/reconcile` and `POST /api/v1/pharmacy-wallet/topups/:id/check`.
- `POST /api/v1/payments/verify` and `/reconcile` for a pharmacy: 403 (`PHARMACY_INACTIVE`, `PHARMACY_NOT_VERIFIED`) on a
  booking payment when the pharmacy is not operational; its own wallet top-up settles regardless (§19.8 item b), as does
  `POST /api/v1/pharmacy-wallet/topups/:id/check` (any pharmacy token).

### 19.4 Switches (all off unless the value is exactly `true`)

| Variable | Default | Effect |
|---|---|---|
| `ASSISTED_BOOKING_ENABLED_PHARMACY` | off | Lookup, doctor list, new consultations, typed-name edit, top-up lots. Off: 503 `ASSISTED_BOOKING_DISABLED`; top-ups credit without lots (old behaviour). Cancel, reschedule, refunds, reads, by-key keep working |
| `ASSISTED_ADMIN_TOOLS_ENABLED` | off | "Not mine", admin move and dismiss, wallet freeze (503 when off). Keep it on during a rollback of the booking switch |
| `ASSISTED_RECONCILIATION_ENABLED` | off | The 02:30 IST daily job. The admin reconciliation route works regardless (read only) |
| `WALLET_RECHARGE_SWEEP_FROM` | unset | ISO time; pharmacy top-ups created from then on join the payment recovery sweep. Older ones are on the uncredited list |
| `ASSISTED_LIMIT_LOOKUPS_PER_HOUR` 120, ~~`…_NEW_ACCOUNTS_PER_DAY` 30, `…_BOOKINGS_PER_PHONE_PER_DAY` 5~~ (removed by owner, 23 Nov; no longer read), `…_BOOKER_CANCELLATIONS_PER_DAY` 20 (alert threshold only since r10g), `ASSISTED_ALERT_CANCEL_RATE_PCT` 30, `ASSISTED_ALERT_CANCEL_RATE_MIN` 10, `ASSISTED_ALERT_SAME_PAIR_PER_DAY` 10 | D10 | Thresholds (only the lookup limit refuses) |
| `WALLET_WITHDRAWALS_ENABLED` | off | Not used in 1a (withdrawals are phase 4) |

### 19.5 Migrations and deploy order

1. Deploy with every switch off. Behaviour changes that need no switch: the pharmacy customer list, order lists and
   subscription list show typed or masked names and no email; partner-paid rows hide the partner money from customers;
   wallet credits post on inactive wallets; payment records keep the Razorpay fee.
2. `npm run migrate:assisted-pharmacy-wallets` (dry run; review `openings` and any `signAnomalies` — exit code 2 when
   there are some), then `-- --commit`. It signs old wallet rows, fills `balancePaise`, writes one `opening_balance`
   per wallet (`migration:opening:<walletId>`), sets `ledgerOpenedAt` and `withdrawableMinor: 0` / `version: 0` only
   where missing (D14), backfills `typedName` where the pharmacy opened the account, and sets `Coupon.fundedBy`
   (`platform` with `corporateIds`) and `partnerUsable: false`. A rerun is a no-op.
3. `npm run sync-indexes`. New or changed: `bookings` (`assisted.requestKey` and `assisted.shortRef` unique partial,
   `assisted.bookedBy`), `pharmacy_wallet_transactions {pharmacyId, operationKey}` unique partial, `pharmacy_wallets
   {frozen}`, `wallet_topup_lots` (`paymentRecordId` unique, wallet and fee indexes), `coupon_redemptions` (unique
   `{couponCode, bookingKind, bookingId}`), `assisted_counters` (TTL), `assisted_alerts {key}` unique,
   `assisted_review_items {bookingKind, bookingId}` unique, `assisted_reconciliation_reports {day}` unique. Until it
   has run, the create answers 503 `INDEXES_OUTDATED` and top-ups open no lots.
4. Set `WALLET_RECHARGE_SWEEP_FROM` to the deploy time; turn on `ASSISTED_ADMIN_TOOLS_ENABLED`, then
   `ASSISTED_RECONCILIATION_ENABLED`, then `ASSISTED_BOOKING_ENABLED_PHARMACY` (stage first; production only on the
   owner's word; GATE-DPDP review before go-live). Wallets created after the migration need nothing: every row the 1a
   ledger writes is signed, and reconciliation checks any wallet whose rows are all signed; a wallet that still has
   unsigned rows is listed as `notMigrated` (run the migration again).
5. The phase 0 review fixes (`83a0ef1`, §18.5) are merged into this branch: the generic `/bookings*` answers use
   phase 0's strict booker view for pharmacies and the 1a partner-money scrub for everyone else; phase 1a's own
   order-name pass was dropped in favour of phase 0's. Before the merge, phase 0 files were changed additively only — `assisted/model` (audit actions and
   actor kinds, new models appended), `assisted/names.ts` (`withLinkNames` appended), `assisted/bookerView.ts` (the
   disputed badge), `assisted/validation` (schemas appended), `routes/index.ts` (two mounts).

### 19.6 Review fixes (xhigh review of `b4ae54e`: phase 0 + fixes + 1a)

The review found no way to create or lose money. Each fix below has a check that fails on `b4ae54e`: the new suite
`test/assisted/phase1a-review.integration.ts` (11 checks, all 11 fail there); item 10 is a changed check in the phase 0
suite; the names decision (8) and the typed-name backfill (9) also changed checks of the phase 0 and 1a suites.

| # | Finding | Fix |
|---|---|---|
| 1 (MEDIUM) | A migration rerun opened a wallet again when its balance had drifted | A wallet with `ledgerOpenedAt` is never opened again; a mismatch on it is listed in `openedWalletMismatches` (exit code 2) and never written |
| 2 (MEDIUM) | A move to a family member of the same account removed the pharmacy's link | A move within one account keeps the link |
| 3 (MEDIUM) | A move left the medicine orders, their copy and the booking's family member with the old holder | The move (one transaction) also moves the orders made from the booking's prescription (`prescriptionFromBooking.bookingId`) to the new holder, so the order and its bound copy are readable only by the new holder (the old holder's file decision is now deny); a family member the booking created (audited `dependentCreated`) is deactivated on the old account when no other booking, lab booking or instant request names it; one that existed before is never touched |
| 4 (MEDIUM) | The create was an existence test (an account opened before validation; refusals told known from unknown numbers) | Every check that can refuse (consent, method, key, slot, doctor, family member, coupon, price fence) runs before any account is counted or opened, with the same answer for both. A new number's account is inserted inside the booking transaction (with the new-account count), so a refused or failed booking leaves no account. Every create attempt counts against the hourly lookup limit and is audited (`booking.attempted`, ids only). Remaining difference, by design: `new_accounts` (429) can only hit unknown numbers; it is counted under the lookup limit like the lookup itself |
| 5 (LOW-MEDIUM) | Customer and doctor views carried `lifecycle.paid.amount` and `.by` | Lifecycle events of assisted rows keep only `at` (and a cancellation `reason`) |
| 6 (LOW) | The doctor's prescription-save answer was the raw booking | It uses the scrubbed doctor view |
| 7 (production gate) | No chargeback path | `POST /api/v1/admin/wallet-lots/:lotId/chargeback { reason }` (admin tools switch), with `GET /api/v1/admin/pharmacies/:id/wallet/lots` to find the lot. Once per lot: the lot is closed for good (`disputeState: lost`, nothing left, never restored); the wallet is debited the lot's amount — the part the balance cannot cover becomes `receivableMinor` owed by the partner (the balance itself stays ≥ 0, so balance = Σ entries holds); the wallet is frozen; audited `wallet.chargeback`. A wallet with a receivable cannot fund bookings (409 `WALLET_RECEIVABLE`) or be unfrozen (409); the next credit (top-up or refund) clears the receivable first (`receivable_setoff` row). Reconciliation lists `walletsOwing` |
| 8 | Released pharmacy app | **Names (decision, overnight, assumed):** a consented link (`patient_agreed`, `customer_order`) shows the real account name on the booker view, order lists, review queue, subscriptions and customer list (also searchable by it); otherwise typed or masked; never the email. *Narrowed by §19.7 item 2: only `customer_order` now.* **Wallet history:** `WalletScreen.tsx` reads `transactionType` first and knows only credit/recharge/refund and debit/payment/booking (anything else falls to the title, where "Refund of an assisted booking" read as a debit). `GET /pharmacy-wallet/transactions` now answers every other kind as `credit` or `debit` by its signed amount and keeps the stored kind in `movementType`; the app's rule is copied into the check |
| 9 (LOW) | Small items | The `typedName` backfill skips accounts the holder took over. Meet invites the booker's email only when `join.on = partner_device`. `errorHandler` adds `limit` only to `ASSISTED_LIMIT_REACHED` and `details` only to `PRICE_CHANGED` (the three paise amounts), never other fields. The daily reconciliation checks bookings changed in the last 7 days plus those already flagged; `GET /admin/assisted/reconciliation?full=true` scans all. The uncredited top-up list covers the last 30 days when `WALLET_RECHARGE_SWEEP_FROM` is unset |
| 10 (phase 0) | `/payments/reconcile` answered a non-operational pharmacy | 403 (`PHARMACY_INACTIVE`, `PHARMACY_NOT_VERIFIED`), as the booking reads |
| 11 (phase 0) | The background copy job made 10 copies per run | It drains the queue in batches of 10 until empty, at most 200 per run |

New answers for the web: 409 `WALLET_RECEIVABLE`; wallet rows carry `movementType` (the stored kind) and
`receivableDeltaPaise`; `GET /pharmacy-wallet` shows `receivableMinor`; reconciliation adds `walletsOwing` and
`bookings.scope`; Meet guest check `guestAccess` may be `not_partner_device`.

### 19.7 Review fixes (xhigh review of `800dfc0`)

Each fix has a check in `test/assisted/phase1a-review.integration.ts` (checks 12–15; check 8a changed for item 2) that
fails on `800dfc0`.

| # | Finding | Fix |
|---|---|---|
| 1 (MEDIUM, production gate) | A top-up credited without a lot (switch off, before sync-indexes, before 1a) could not be charged back (404 `LOT_NOT_FOUND`) | `POST /api/v1/admin/wallet-payments/:paymentId/chargeback { reason }` (admin tools switch); `paymentId` = the top-up's payment record id or Razorpay payment id (`pay_…`). A top-up with a lot is charged back through its lot (same operation key `chargeback:<lotId>`). Without one, a lot is recorded for the payment in the same transaction, already closed (`openedAtChargeback: true`, nothing in it, never withdrawable), and charged back exactly as a lot: balance down to 0 at most, the rest owed as `receivableMinor`, the wallet frozen, audited `wallet.chargeback` (`withoutLot: true`). The lot's unique `paymentRecordId` index (checked first, 503 `INDEXES_OUTDATED`) makes it once per payment across both routes and under concurrency (a racing twin answers `replayed: true`). Answers: 404 `TOPUP_NOT_FOUND` (not a pharmacy top-up), 409 `PAYMENT_AMBIGUOUS` (several records carry that Razorpay id: use the record id); a top-up never credited: see §19.8 item a (was 409 `TOPUP_NOT_CREDITED`) |
| 2 (privacy) | `patient_agreed` (the pharmacy's own tick) unlocked the real account name, so book-then-cancel revealed it | Real name (and search by it) only on a `customer_order` link; otherwise typed, else masked (§17.4, P4) — **ASSUMED, awaiting owner confirmation**. A `customer_order` link keeps that consent when the pharmacy later ticks "patient agreed" (`POST /pharmacy-customers`, an assisted booking) |
| 3 (LOW) | `/payments/verify` answered a non-operational pharmacy | 403 (`PHARMACY_INACTIVE`, `PHARMACY_NOT_VERIFIED`), as `/payments/reconcile`; an operational pharmacy's own verify is unchanged. *Narrowed to booking payments by §19.8 item b* |
| 4 (LOW) | A retried create counted against the lookup limit before its replay was found (429 instead of the receipt) | The same-content replay of this booker's key answers first and is not counted; every other attempt (a key reused for other content included) is counted and audited as before, with one answer for known and unknown numbers |

### 19.8 Review fixes (review of `db252c1`)

Checks 16–18 of `test/assisted/phase1a-review.integration.ts` are new, and check 14 is changed. All four fail on
`db252c1`. With the credit's status guard removed, check 16's race finds a blocked top-up that is still credited.

| # | Finding | Fix |
|---|---|---|
| a (MEDIUM, production gate) | A lost dispute on a top-up never credited recorded nothing, so a later capture could still credit it as withdrawable money | The payment chargeback **blocks** it instead. In its transaction it sets `PaymentRecord.chargebackAt` and `status: failed` (a refunded record keeps its status), guarded on the status read and on no credit claim. Audited `wallet.chargeback` (`blockedUncredited: true`). The answer is 200 `{ blockedUncredited: true, credited: false, message }`. Verify, reconcile, the top-up check and the sweep refuse a blocked record (409 `TOPUP_BLOCKED`; the sweep only takes `created`/unprocessed `paid` records). Mark-paid never revives it. The credit claims the record in its own transaction (`walletCreditedAt` set, guarded on `status: paid` and no `chargebackAt`), so the block and the credit always touch the same document. One of them conflicts and retries, so the only outcomes are: credited and then charged back, or blocked and never credited |
| b (LOW) | The verify gate stranded a top-up paid by a pharmacy that became non-operational | `/payments/verify` and `/reconcile` answer 403 only on a **booking** payment (that answer carries the booker view). The pharmacy's own top-up settles and is credited (its own money), and so does `/pharmacy-wallet/topups/:id/check` (any pharmacy token). The wallet still funds nothing, because every spending route requires an operational pharmacy |
| c (LOW) | A lot recorded at the chargeback took from other open lots first, so the withdrawable amount came out too low | The non-lot money goes first; open lots give up only the remainder. Check 17: ₹500 without a lot, ₹800 lot, ₹500 booking (withdrawable ₹300), chargeback of the ₹500 (₹300), refund of the booking (₹800) |
| names | Pre-S3 customer-made links; later own orders | The migration sets `consent: 'customer_order'` on links with no `consent` and `createdByRole: 'user'` (only where missing; `customerOrderConsentsFilled` in the report; a rerun changes nothing). The customer's own order (`ensureLinked` as the customer) upgrades an existing link (`patient_agreed`, `not_recorded`, none) to `customer_order` |

New answers for the web: 409 `TOPUP_BLOCKED`; the payment chargeback's `blockedUncredited` answer (§19.3).

### 19.9 Review fixes (review of `b378f61`)

Checks 19–20 of `test/assisted/phase1a-review.integration.ts` (and one changed line of check 12) fail on `b378f61`.

| # | Finding | Fix |
|---|---|---|
| 1 (LOW–MEDIUM) | A never-verified top-up could not be blocked by its Razorpay payment id (stored only once verified) | The payment chargeback also accepts the Razorpay order id (always stored). A `pay_…` id the database does not hold is resolved before the transaction: with gateway keys configured, the payment's order id is fetched from Razorpay (read only) and its record used. Otherwise, or when the gateway does not know the id, 404 `TOPUP_NOT_FOUND_BY_PAYMENT_ID` "Not found by payment id; try the order id or the record id". `PAYMENT_AMBIGUOUS` is unchanged |
| 2 (LOW) | The names migration filter was too wide and too narrow | Only links the customer made (`createdByRole: 'user'` and `createdById` = the link's `userId`) with consent missing, `null` or `not_recorded` become `customer_order`. Idempotent; counted in `customerOrderConsentsFilled` |


## 20. Assisted booking on the stage line, and the stage enable runbook (2026-11-22)

Branch `m0/r4-assisted-stage`: the stage line `m0/q16-integration` `3c8c67bc` (origin/stage) with `m0/r3-assisted-phase1a`
`58e9c14` merged in. Local commits only; nothing pushed or deployed. Production (`main`) is untouched.

### 20.1 What the merge had to reconcile

Since `286eb0a` (the base of phases 0 and 1a) the stage line gained S4 (server-owned prescriptions and reports), S5 and
S5b–f (unverified or inactive doctors cannot act or be booked; admin clear and admin close) and S6 (payment `module` is
informational; fulfilment by the stored record's context only). Both sides' rules hold after the merge:

| Area | Stage rule | Assisted rule | Merged result |
|---|---|---|---|
| `file/access.ts` `canReadBooking` | S5: the booking's doctor reads its files only while verified and active | Phase 0: the booking pharmacy no longer reads the full PDF, documents or report | Patient, eligible doctor and HR only |
| `file/access.ts` full PDF | S5: readable only while the booking's prescription still names it (admin clear, newer prescription) | — | Unchanged S5 rule |
| `file/access.ts` dispensing copy | S5: ineligible doctors read no booking file; admin clear withdraws the prescription | Phase 0: copy for patient, doctor, operational booker in the window | Doctor needs eligibility; patient and doctor need the booking to still hold a doctor-saved prescription (an admin clear withdraws every copy from all but admins; a newer prescription keeps older copies for patient and doctor); pharmacy rules unchanged |
| `rxAccess.hasPrescription` | S4 `hasDoctorPrescription`: marker AND prescriber = the booking's doctor | Phase 0: marker and content | Both: marker, content, prescriber = the booking's doctor (booker view, copy, file access, order from prescription) |
| Assisted create / booker reschedule | S5b: `reserveSlot` re-reads the doctor inside the transaction (400 `SPECIALIST_NOT_*`) | 409 `DOCTOR_NOT_AVAILABLE` before the transaction | The in-transaction refusal answers 409 `DOCTOR_NOT_AVAILABLE` too (`asDoctorUnavailable`); nothing is committed |
| Doctor lists for the pharmacy | S5 `isEligibleDoctor` | Active and verified | `/pharmacy-assisted/doctors` and the new slot read (§20.2) list eligible doctors only |
| Admin close (S5c) / doctor cancel | Full refund through `cancelByDoctor` → `cancelBookingSettlement` | Assisted rows refund the payer's wallet in the cancel transaction | An admin close of an assisted booking refunds the pharmacy wallet (never the patient's); the patient gets the assisted notice; the close audit's `refunded` is in rupees as for every close |
| Payment routing | S6: `shouldFulfillExternalBooking` = `record.context === 'external_booking'`; `processVerifiedPayment(paymentRecord)` | Lots, fee, credit claim, chargeback block, verify/reconcile gate | Auto-merged: S6's context-only routing with the assisted changes on top; the operational-pharmacy gate on `/payments/verify` and `/reconcile` applies to `booking` records only (top-ups settle) |
| S6 back-credit script | Knew "this run credited" from `txRepo.save` | Top-up credits now go through the ledger | `PaymentService.onWalletRechargeCredited` reports the ledger row each attempt wrote; the script compares it with the committed row |
| Tests | S5 fixtures need verified doctors | Phase 0 fixtures needed verified pharmacies | `s2-booking-read-scope` keeps both; phase 0's stub doctor is verified; its finding-2 check now writes the pre-S4 client prescription directly (S4 drops it at create); `s6-pharmacy-wallet-verify` uses real active, verified pharmacies (the verify gate on booking payments) |

### 20.2 Added for the pharmacy screens

**`GET /api/v1/pharmacy-assisted/doctors/:doctorId/slots?from=YYYY-MM-DD&days=1..14&mode=video|call|in-person`**
(pharmacy token, operational; `ASSISTED_BOOKING_ENABLED_PHARMACY`). One doctor's bookable slots for the booking and
reschedule screens: `{ doctor: { doctorId, name, specialization, languages, city, experienceYears, feeMinor }, from,
to, slots: [{ slotId, date, startTime, endTime, startsAt, modes }] }`, earliest first. `from` defaults to today (never
earlier), `days` to 7. Only active, available, not full, not started slots in the mode, and none on the doctor's leave
day. 404 `DOCTOR_NOT_FOUND` for an unknown, unverified or inactive doctor (one answer); 400 for a malformed id or query;
503 `ASSISTED_BOOKING_DISABLED`. The doctor list (`GET /pharmacy-assisted/doctors`) now leaves leave-day slots out too.
Checks: `test/assisted/stage-merge.integration.ts`.

### 20.3 API for the web screens (pharmacy and admin)

Pharmacy token for every pharmacy row; answers `{ success, data }`; money in paise unless marked ₹.

| Screen step | Method and path | Body / query | Answer `data` |
|---|---|---|---|
| Find patient | `POST /api/v1/pharmacy-assisted/patients/lookup` | `{ phone }` | `{ exists, holderNameMasked }` |
| Doctors | `GET /api/v1/pharmacy-assisted/doctors` | `?speciality&mode&language&date&limit` | `[{ doctorId, name, specialization, languages, city, experienceYears, feeMinor, nearby, nextSlot, slots? }]` |
| Doctor's slots | `GET /api/v1/pharmacy-assisted/doctors/:doctorId/slots` | `?from&days&mode` | §20.2 |
| Book (wallet) | `POST /api/v1/pharmacy-assisted/consultations` | §19.3 (`requestKey, phone, patient, holderName?, consent, preferredLanguage, slotId, consultationMode, join?, couponCode?, acceptedPriceMinor, primaryConcern?, notes?, paymentMethod: 'wallet'`) | 201 `{ booking, funding, split, newAccount, replayed }` (200 on replay) |
| Lost answer | `GET /api/v1/pharmacy-assisted/bookings/by-key/:key`, `POST …/by-key/:key/abandon` | — | `{ state: 'used', booking } \| { state: 'abandoned' } \| { state: 'unknown' }` |
| Booked list | `GET /api/v1/pharmacy-bookings` | `?status&from&to&cursor&limit` | `[booker view]`, `pagination: { total, nextCursor }` |
| One booking | `GET /api/v1/pharmacy-bookings/:id` | — | booker view (`prescription.fileUrls` = dispensing copy; `copyPending`) |
| Cancel | `POST /api/v1/pharmacy-assisted/bookings/:id/cancel` | `{ reason?, expectedUpdatedAt? }` | `{ booking, refundedMinor, alreadyCancelled }` |
| Reschedule | `POST /api/v1/pharmacy-assisted/bookings/:id/reschedule` | `{ slotId, requestKey, expectedUpdatedAt? }` | `{ booking, replayed }` |
| Order from prescription | `POST /api/v1/pharmacy-orders` | `{ prescriptionFromBookingId, requestKey, orderType, items[], paymentMode, deliveryMode, … }` (§18.3) | 201 `{ order, paymentRequired, payment? }` |
| Wallet | `GET /api/v1/pharmacy-wallet` | — | wallet + `withdrawableMinor, frozen, receivableMinor` (`balance` ₹, `balancePaise`) |
| Wallet history | `GET /api/v1/pharmacy-wallet/transactions` | `?page&limit` | rows (`transactionType` credit/debit, `movementType`, `signedAmountPaise`, …), `pagination` |
| Top up (Razorpay) | `POST /api/v1/pharmacy-wallet/topup` | `{ amount (₹), notes? }` | `{ paymentRequired, paymentTransactionId, razorpayOrderId, razorpayKeyId, amount, currency }`; then Razorpay Checkout, then `POST /api/v1/payments/verify { paymentTransactionId, razorpayOrderId, razorpayPaymentId, razorpaySignature, module: 'pharmacy-wallet' }` |
| Top-up not shown | `POST /api/v1/pharmacy-wallet/topups/:paymentTransactionId/check` | — | `{ state: 'credited' \| 'unpaid', wallet }` |
| Typed name | `PUT /api/v1/pharmacy-customers/:id/typed-name` | `{ typedName }` | `{ _id, userId, typedName }` |
| Admin: top up a pharmacy | `POST /api/v1/pharmacy-wallet/topup` (admin token, header `Idempotency-Key` required, one per submit) | `{ pharmacyId, amount (₹), notes? }` | the wallet; 400 `IDEMPOTENCY_KEY_REQUIRED`, 404 `PHARMACY_NOT_FOUND`, 409 `IDEMPOTENCY_KEY_REUSED` |
| Admin: a pharmacy's wallet | `GET /api/v1/pharmacy-wallet?pharmacyId=` and `/transactions?pharmacyId=` | — | as above |
| Admin: move a booking | `POST /api/v1/admin/assisted-bookings/:id/move` | `{ toPhone, asFamily?, holderName?, reason, requestKey, expectedUpdatedAt? }` | `{ booking, replayed }` |
| Admin: "not mine" queue | `GET /api/v1/admin/assisted/review-items`, `POST …/:id/dismiss` | `?state&limit`; `{ reason? }` | items |
| Admin: checks | `GET /api/v1/admin/assisted/reconciliation`, `/stuck-money`, `/alerts`, `/meet-guest-check/:id`; `GET /api/v1/admin/wallet-recharges/uncredited` | — | reports |
| Admin: freeze, chargebacks | `PUT /api/v1/admin/pharmacies/:id/wallet/freeze`; `GET /api/v1/admin/pharmacies/:id/wallet/lots`; `POST /api/v1/admin/wallet-lots/:lotId/chargeback`; `POST /api/v1/admin/wallet-payments/:paymentId/chargeback` | §19.3 | §19.3 |

### 20.4 Stage enable runbook (server `/opt/swasthadisha/backend`, pm2 `swasthadisha-api`)

Run in this order. Steps 1–2 are the usual stage update; do the S4/S5/S6 and Q16 deploy notes first if this stage
database has not had them (overnight report: pharmacy email checks before sync-indexes, `cdn.sheetjs.com` reachable
before `npm ci`).

1. **Code.** `cd /opt/swasthadisha/backend && git fetch origin && git checkout stage && git pull --ff-only origin stage`,
   then `curl -sI https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz | head -1` (expect 200) and `npm ci`.
2. **Switches stay off for now.** In `.env`, make sure `ASSISTED_BOOKING_ENABLED_PHARMACY`, `ASSISTED_ADMIN_TOOLS_ENABLED`
   and `ASSISTED_RECONCILIATION_ENABLED` are absent or not `true`. Restart on the new code:
   `TS_NODE_PROJECT=tsconfig.runtime.json pm2 restart swasthadisha-api --update-env`, then `pm2 logs swasthadisha-api --lines 50`
   (no start-up error; the "Settlement cutover" line is there).
3. **Migration, dry run:** `npm run migrate:assisted-pharmacy-wallets; echo "exit=$?"`. Read the JSON: `signedFilled`,
   `openings` (one per wallet whose balance differs from the sum of its rows), `typedNamesFilled`,
   `customerOrderConsentsFilled`, coupons. Exit 2 means `signAnomalies` or `openedWalletMismatches` are listed: read
   them before going on. Sign anomalies (a row whose balance change contradicts its type) get their signed amount filled
   in as recorded (balance after − before) and are listed for review; their type is never changed. Opened-wallet
   mismatches are listed and never written. Stage demo data may have some.
4. **Migration, write:** `npm run migrate:assisted-pharmacy-wallets -- --commit; echo "exit=$?"`. Run the dry run again:
   it must report nothing left to do (a rerun is a no-op).
5. **Indexes:** `npm run sync-indexes 2>&1 | tee /tmp/sync-indexes.log; grep FAILED /tmp/sync-indexes.log` (expect no
   FAILED line). New: `wallet_topup_lots`, `coupon_redemptions`, `assisted_counters`, `assisted_alerts`,
   `assisted_review_items`, `assisted_reconciliation_reports`, `assisted_audit_events`, and indexes on `bookings`,
   `pharmacy_wallet_transactions`, `pharmacy_wallets`, `pharmacy_orders`, and `bookingadminclears {paths}` (§20.6).
6. **Switches on.** Add to `.env` (the time is now, India time):
   ```
   WALLET_RECHARGE_SWEEP_FROM=2026-11-22T12:00:00+05:30
   ASSISTED_ADMIN_TOOLS_ENABLED=true
   ASSISTED_RECONCILIATION_ENABLED=true
   ASSISTED_BOOKING_ENABLED_PHARMACY=true
   ```
   Limits keep their defaults (§19.4) unless set. Then
   `TS_NODE_PROJECT=tsconfig.runtime.json pm2 restart swasthadisha-api --update-env`. (`.env` is read at start; a variable
   that pm2 itself holds in its saved environment wins over `.env`, so check `pm2 env <id> | grep ASSISTED` if a switch
   seems ignored.)
7. **Fund a demo pharmacy (admin top-up, non-withdrawable).** Load the backend's `.env` into this shell first (mongosh
   needs `MONGODB_URL`): `cd /opt/swasthadisha/backend && set -a && source .env && set +a`. Find the pharmacy:
   `mongosh "$MONGODB_URL" --quiet --eval 'db.pharmacies.find({isActive:true,isVerified:true},{name:1,phone:1}).limit(20).forEach(p=>printjson(p))'`.
   Sign in to the staff site as an admin, copy the token after `Authorization: Bearer ` of any API request from the
   browser's network tab, and paste it without echoing it or keeping it in the shell history: `read -rs ADMIN_TOKEN`
   (paste, Enter). Then:
   ```
   curl -sS -X POST https://swasthadisha.etryx.in/api/v1/pharmacy-wallet/topup \
     -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -H 'Idempotency-Key: stage-demo-topup-001' \
     -d '{"pharmacyId":"<pharmacy _id>","amount":5000,"notes":"stage testing"}'
   ```
   `amount` is in rupees (₹5,000 here). The `Idempotency-Key` header is required (400 `IDEMPOTENCY_KEY_REQUIRED`
   without it). Use a new key for each further top-up: resending the same key and body credits nothing more, and the same
   key with another amount or note is 409 `IDEMPOTENCY_KEY_REUSED`. An unknown `pharmacyId` is 404 `PHARMACY_NOT_FOUND`.
   The ledger row records the admin (`actor`). Finish with `unset ADMIN_TOKEN`. Check: `curl -sS "https://swasthadisha.etryx.in/api/v1/pharmacy-wallet?pharmacyId=<id>" -H "Authorization: Bearer $ADMIN_TOKEN"`.
   The pharmacy must be active and verified to book; the doctors it books must be verified and active.
8. **What to check first.**
   - As the pharmacy: `GET /api/v1/pharmacy-assisted/doctors` answers 200 (503 = the switch is not read) and lists only
     verified, active doctors; `GET /api/v1/pharmacy-wallet` shows the top-up.
   - Book one video consultation on the pharmacy's own device; the wallet drops by the fee; the booking shows in
     `GET /api/v1/pharmacy-bookings` with `assisted.shortRef`; the doctor sees it with "Identity attested by the partner,
     not verified". Cancel it from the pharmacy: `refundedMinor` = the fee and the wallet is back.
   - Unverify a test doctor in admin and try to book them: 409 `DOCTOR_NOT_AVAILABLE`; they leave the doctor list.
   - A small Razorpay test top-up from the pharmacy (stage keys): after verify, the wallet rises; if the screen lost the
     answer, `POST /pharmacy-wallet/topups/:id/check` credits it once.
   - Admin: `GET /api/v1/admin/assisted/reconciliation` shows no mismatches and `notMigrated` empty; `GET
     /api/v1/admin/assisted/stuck-money` is empty.
   - The manual Meet check of §19.2 item 11 (pharmacy device joins as a guest the doctor admits); record it here.
9. **Roll back** (any time): set `ASSISTED_BOOKING_ENABLED_PHARMACY=false` and restart. Existing assisted bookings can still
   be cancelled, rescheduled and refunded; keep `ASSISTED_ADMIN_TOOLS_ENABLED=true` during a rollback (§19.4).
   **Never roll the CODE back while assisted bookings are open.** Code without phase 1a does not know partner money: its
   cancel would refund the pharmacy ₹0 and still mark the booking refunded. To go back to older code, first cancel every
   open assisted booking on this code (each refund goes to its pharmacy's wallet), check that
   `db.bookings.countDocuments({source:'pharmacy_assisted', status:{$in:['pending','confirmed']}})` is 0, and only then
   deploy the older code. A switch-only rollback (above) is always safe.

### 20.5 Open gaps (not built here)

- **No admin top-up screen** in the web apps: step 7 uses the API. The web agent may add one for `POST
  /pharmacy-wallet/topup` (admin form: pharmacy, ₹ amount, notes, a fresh `Idempotency-Key` per submit).
- **Family members of a number** are not listed to the pharmacy (by design, §6.2: the answer never reveals them). A repeat
  booking for the same family member reuses it by `{ relation, name }` (same active name and relation) or by the
  `dependentId` the pharmacy's own earlier booking shows.
- ~~**Branch closures** (`clinicBranchContext`) are not filtered from the pharmacy slot lists; `reserveSlot` still refuses
  a closed branch at booking (409).~~ Closed in §21 (r6): the pharmacy slot reads leave them out.
- ~~**Order bindings after an admin clear:** an order already made from a prescription that an admin later clears keeps
  its bound dispensing copy (it is the dispensed order's prescription record). Owner to decide whether an admin clear
  should also withdraw it.~~ Decided and built in §22 (r9): the clear withdraws it; the order stays.
- Phase 1b and later (Razorpay per booking, lab/doctor bookers, referral cuts, withdrawals, SMS) are not built (§19.2
  item 13).

### 20.6 Review fixes (Opus xhigh review of `fb4063c7`)

Branch `m0/r5-assisted-stage-fixes` (from `fb4063c7`). Each fix has a check that fails on `fb4063c7`.

| # | Finding | Fix | Check |
|---|---|---|---|
| 1 (LOW, patient data) | After an admin clear, the cleared prescription's dispensing copy became readable again to the patient and doctor once the doctor saved a new prescription | The clear's audit row records `removed.dispensingCopyUrl` and `paths` (the upload paths of every file it withdrew: full PDFs and the copy); file access refuses those paths for everyone but admins, for the full PDF and the copy. A clear recorded before this fix (no `paths`) withdraws its own PDFs and every copy made up to the clear (`rx-dispense-<ms>`, ms ≤ the clear). Index `bookingadminclears {paths}` (sync-indexes). Order bindings are unchanged (open, §20.5) | `stage-merge` checks "review 1" (2) |
| 2 (LOW, ₹) | A top-up blocked after a lost card dispute (`chargebackAt`, status failed) showed in the S6 audit's `failedWithCapture` as "manual review" | The audit selects `chargebackAt` and lists such records (any status) in `blockedAfterLostDispute` with `review: 'blocked after a lost dispute: never credit'` (with or without the gateway; never in `rows` or `failedWithCapture`; counted in the summary and the stderr line). The credit script refuses them first, with no override | `s6-pharmacy-wallet-verify` "blocked after a lost card dispute" |
| 3 | Rollback | §20.4 step 9: never roll the code back while assisted bookings are open | — |
| 4 | Admin top-up | 404 `PHARMACY_NOT_FOUND` for an unknown pharmacy (no stray wallet); content hash (`requestHash`: paise amount and note) on the ledger row — the same key with other content is 409 `IDEMPOTENCY_KEY_REUSED` (older rows without a hash are compared by amount and note); the admin is stored as `actor: { kind: 'admin', id }`; the `Idempotency-Key` header is required for an admin (400 `IDEMPOTENCY_KEY_REQUIRED`, at most 100 characters). No released client calls the admin route (checked: the released pharmacy app calls only its own Razorpay top-up; no admin panel or `jansetu-web` screen calls it) | `stage-merge` "review 4" |
| 5 | Nits | Runbook: `.env` exported for mongosh, `read -rs ADMIN_TOKEN`, step 3 wording. The admin close answers "Booking closed; the pharmacy was refunded" for an assisted booking | `stage-merge` S5c check |

## 21. Small fixes on the stage line (r6, 2026-11-22)

Branch `m0/r6-small-fixes` from the stage line `338733f8` (origin/stage). Local commits only. Checks:
`test/assisted/r6-small-fixes.integration.ts` (16 checks; the 11 for fixes fail on `338733f8`, the 5 marked "guard" pin
behaviour that was already right).

### 21.1 What changed

| # | Finding | Fix |
|---|---|---|
| 1 | The pharmacy doctor list could offer a chat-only slot as `nextSlot` (and in `slots`); `modes` could list `chat`. Assisted consultations take only `video`, `call`, `in-person` (the create's `consultationMode`) | `GET /pharmacy-assisted/doctors` and `GET /pharmacy-assisted/doctors/:doctorId/slots` offer only slots with at least one of those modes, and `modes` lists only those (a slot with no modes stored is all three). With `mode`, only slots offered in it. The filter is in the database query too, so chat-only slots never use up the 5000-slot read (a long run of them hid every later slot). In-clinic slots at a branch on holiday that day, or at a branch the doctor no longer consults at (inactive branch or clinic, membership or branch scope gone), are left out too (closes the §20.5 branch gap). `nextSlot` is therefore the next slot `reserveSlot` would admit (apart from a race for the seat) |
| 2 | A clean `npm ci` gave 20 tsc errors, not 17: the lock pinned `@types/formidable` 3.4.6, which lacks `maxFilesExceeded`, `biggerThanTotalMaxFileSize` and the `'error'` emit used in `src1/modules/file/storage.ts` | Lock entry only: 3.5.1 (`package.json` keeps `^3.4.5`). Checked in a scratch copy: `npm ci`, then `tsc` = the 17 known errors; with 3.4.6 put back, 20 |
| 3 | Pharmacy reschedule review (rules below). One gap: a move onto the slot the booking already holds was a no-op that still recorded a move and told the patient and doctor "Consultation moved" | 409 `SAME_SLOT` |
| 4 | Typed-name edit: the booker view had no link id for `PUT /pharmacy-customers/:id/typed-name` | Booker view adds `holder: { pharmacyCustomerId, name }`; the edit's answer adds `shownName` |
| 5 | Admin wallet support: a malformed `pharmacyId` on the admin wallet reads was a 500; the admin top-up answered the raw wallet | 400 `VALIDATION_ERROR`; the top-up answers the same wallet view as `GET /pharmacy-wallet` |

### 21.2 API notes for the web

**Doctor list and slot read** (as §19.3 / §20.2): `nextSlot`, `slots[]` and the slot read's `slots[]` are
`{ slotId, date, startTime, endTime, startsAt, modes }` where `modes` ⊆ `['video', 'call', 'in-person']` and is never
empty. Offer only the modes in `modes` for `consultationMode`.

**Reschedule** `POST /api/v1/pharmacy-assisted/bookings/:id/reschedule` (pharmacy token; the pharmacy must be operational
and verified; works with `ASSISTED_BOOKING_ENABLED_PHARMACY` off).
- Body `{ slotId, requestKey ([A-Za-z0-9_-]{8,100}, a new one per move), expectedUpdatedAt? (the booking's
  `updatedAt` as shown) }`. Pick the slot from `GET /pharmacy-assisted/doctors/:doctorId/slots?mode=<booking's
  consultationMode>` (same doctor). The mode and the price never change.
- Rules, all decided inside the move's transaction: only this pharmacy's own assisted bookings (else 404); status pending
  or confirmed; before the CURRENT appointment starts (the same "any time before it starts" rule as the partner cancel);
  same doctor; the doctor still verified and active (S5); the new slot active, free, not started, not on the doctor's
  leave day or a closed branch, and offered in the booking's mode (a chat-only slot is refused); not the slot already
  held. A booking moved after a no-show may still be moved by the pharmacy (no money moves); it still cannot be
  cancelled for a refund (`NO_SHOW_NOT_REFUNDABLE`).
- 200 `{ booking: <booker view>, replayed: false }`; the same `requestKey` and `slotId` again → 200 `replayed: true`
  (nothing moves twice).
- Errors: 400 `REQUEST_KEY_REQUIRED`, `VALIDATION_ERROR`, `BOOKING_ALREADY_STARTED`; 404 `BOOKING_NOT_FOUND`; 409
  `SAME_SLOT` (new; §21.3: decided inside the move, after the status and start checks), `SLOT_NOT_THIS_DOCTOR`, `SLOT_NOT_AVAILABLE` (full, inactive, leave day, closed branch, mode not
  offered), `SLOT_STARTED`, `DOCTOR_NOT_AVAILABLE`, `BOOKING_NOT_RESCHEDULABLE` (cancelled, completed, no-show),
  `BOOKING_CHANGED` (reload and retry), `IDEMPOTENCY_KEY_REUSED` (the key was used for another slot).
- The patient and the doctor are told; the join link stays the same (§6.6).

**Typed name** `PUT /api/v1/pharmacy-customers/:id/typed-name` (pharmacy token, operational; `ASSISTED_BOOKING_ENABLED_PHARMACY`
on, else 503 `ASSISTED_BOOKING_DISABLED`).
- `:id` = `booking.holder.pharmacyCustomerId` from `GET /api/v1/pharmacy-bookings[/:id]` (also in the reschedule, cancel
  and by-key answers, which carry the booker view). The customer's user id (`booking.userId`) is accepted too. When
  `holder.pharmacyCustomerId` is null the pharmacy has no link to that holder: hide the edit.
- Body `{ typedName }` (trimmed, 1–200 characters; inner spaces collapsed). → 200 `{ _id, userId, typedName, shownName }`.
  `shownName` is what this pharmacy's screens now show for the holder: the real account name when the customer linked
  the pharmacy by ordering (`customer_order`), otherwise the typed name. Show it after saving; on a `customer_order`
  link the typed name is stored but does not show.
- It renames only this pharmacy's link; the account's own name never changes; another pharmacy's link is 404
  `CUSTOMER_NOT_LINKED`. 400 `VALIDATION_ERROR`. Audited (`customer.typed_name`).
- Booker view `holder: { pharmacyCustomerId: string | null, name: string | null, typedName: string | null }`: the
  ACCOUNT HOLDER (the phone's owner) under the same names rule; `typedName` (r8) is the name THIS pharmacy typed on its
  own link, as stored (null when none). For a family-member booking `patientName` is the family member and `holder.name`
  the holder; the edit changes the holder's name, never the family member's. Never another pharmacy's link.

**Admin: find a pharmacy** `GET /api/v1/pharmacies?name=&phone=&city=&isVerified=&isActive=&search=&page=&limit=&sortBy=&sortOrder=`
(admin token). Admins see every pharmacy (unverified and inactive included) with the full record (`_id, name,
nickname, ownerName, phone, email, address, city, state, pincode, isVerified, isActive, walletEnabled, createdAt,
updatedAt, …`). `name` and `city` are case-insensitive "contains"; `phone` is the exact 10-digit number (admins only);
`search` is a word search over name, city and address. Give both `page` and `limit` (≤ 100) to get `pagination: { page,
limit, total, totalPages }`; without them every match is returned. Default order: newest first.

**Admin: a pharmacy's wallet** `GET /api/v1/pharmacy-wallet?pharmacyId=<id>` (admin token) → the wallet view `{ _id,
pharmacyId, balance (₹), balancePaise, isActive, withdrawableMinor, frozen, receivableMinor, createdAt, updatedAt, … }`,
or `data: null` when that pharmacy has no wallet yet (an admin read never creates one; also null for an unknown id).
400 `PHARMACY_ID_REQUIRED` without `pharmacyId`, 400 `VALIDATION_ERROR` for a malformed one.

**Admin: its transactions** `GET /api/v1/pharmacy-wallet/transactions?pharmacyId=<id>&page=1&limit=20` (admin token) →
rows, newest first: `{ _id, pharmacyId, transactionType: 'credit' | 'debit' | 'refund', movementType (the stored kind:
credit, booking_debit, refund_credit, chargeback, …), amount (₹), amountPaise, signedAmountPaise, balanceBefore,
balanceAfter, status, description, notes, referenceType, referenceId, operationKey, actor?, createdAt, … }`, and `pagination: {
page, limit, total, totalPages }`. An admin top-up row has `referenceType: 'topup'`, `referenceId` = its
Idempotency-Key and `actor: { kind: 'admin', id }`. Same 400s as the wallet read. A pharmacy token reads only its own
(its `pharmacyId` query is ignored).

**Admin: top-up** `POST /api/v1/pharmacy-wallet/topup` (admin token), header `Idempotency-Key` (required,
`^[A-Za-z0-9_-]{8,100}$` after trimming, r8; make a new one per submit, keep it for a resend of the same form), body `{ pharmacyId, amount (₹, ≥ 1),
notes? (≤ 500) }` → 200 `{ message: 'Wallet topped up', data: <wallet view as above> }`. A resend with the same key and
content credits nothing more and answers the wallet. Errors: 400 `IDEMPOTENCY_KEY_REQUIRED`, `VALIDATION_ERROR`; 404
`PHARMACY_NOT_FOUND`; 409 `IDEMPOTENCY_KEY_REUSED` (same key, other amount or note). The credit is never withdrawable (no
top-up lot). Admin chargebacks, freeze and lots: §19.3.

### 21.3 Follow-ups (r7, 2026-11-22)

Branch `m0/r7-followups` from `694bfaa9` (r6, pushed as origin/stage). Local commits only. Checks:
`test/assisted/r7-followups.integration.ts` (8 checks; the 7 for fixes fail on `694bfaa9`, 1 guard).

| # | Finding | Fix |
|---|---|---|
| 1 (money, web review M1) | An admin whose top-up answer was lost could not tell whether that Idempotency-Key credited the pharmacy | `GET /api/v1/pharmacy-wallet/topups/admin/by-key/:key?pharmacyId=` (below). Two exact reads, each pinned (`hint`) to its unique ledger index: `{ pharmacyId, referenceType: 'topup', referenceId: key }` (every admin top-up; rows from before the ledger have only this), then `{ pharmacyId, operationKey: 'admin_topup:<key>' }`. No paging, no wallet created |
| 2 | Two concurrent moves onto one slot with different keys: both passed the r6 pre-check (made before the transaction), the second found the booking already there and answered 200 with a second "moved" notice | `rescheduleWithHolds` refuses a same-slot move for an assisted booker inside the transaction (`(p.noShow \|\| p.assistedBooker) && target === current`), on the booking as that attempt reads it; the pre-check is gone |
| 3 | The doctor list checked clinic branches with three reads per doctor and branch, plus a holiday read | `clinicBranchAdmission` (doctors/services/schedule.ts): the doctors' active memberships, then their clinics and those clinics' branches together, once per request; the same rule as `clinicBranchContext` + `branchClosedOn`, ids compared in lower case |
| 4 | `nextSlot` came from one read of at most 5000 slots in date order: a doctor whose first slot lay past it showed none | The shared read keeps the cap but knows when it was cut: days before the cut-off day are complete; a doctor with nothing bookable there is read on its own from the cut-off day, day by day (the first day holding a candidate slot, then that whole day; leave days skipped in the query; at most 60 such days). `?date=` slots are read doctor by doctor when that day alone exceeds the shared read. A doctor's one day is read whole (bound 20 000 rows). Usual case: one shared read, as before |
| 5 | Nits | A branch id stored in upper case is matched for holidays and membership; a cancelled or started booking answers `BOOKING_NOT_RESCHEDULABLE` / `BOOKING_ALREADY_STARTED` even onto its own slot (`SAME_SLOT` comes after those checks); a malformed `pharmacyId` on the admin top-up was already 400 `VALIDATION_ERROR` (body schema; now pinned by a guard check) |

**Admin: was this top-up credited?** `GET /api/v1/pharmacy-wallet/topups/admin/by-key/:key?pharmacyId=<id>` (admin
token only; others 403). `:key` = the `Idempotency-Key` the admin form sent (URL-encoded; trimmed as the top-up trims
it; `^[A-Za-z0-9_-]{8,100}$`, r8). Answers (`Cache-Control: private, no-store`):
- 200 `{ state: 'credited', transaction, wallet }`: `transaction` is the ledger row as in `GET /pharmacy-wallet/transactions`
  (`transactionType: 'credit'`, `movementType`, `amount` ₹, `amountPaise`, `notes`, `referenceType: 'topup'`,
  `referenceId` = the key, `operationKey`, `actor: { kind: 'admin', id }`, `createdAt`, …); `wallet` is the wallet view of
  `GET /pharmacy-wallet` (or null if none).
- 200 `{ state: 'not_found' }`: no top-up with this key for this pharmacy (also for another pharmacy's key, or an unknown
  pharmacy). Resending the same form with the SAME key is then safe: it credits at most once.
- 400 `PHARMACY_ID_REQUIRED` (no `pharmacyId`), `VALIDATION_ERROR` (malformed `pharmacyId`, or a key not matching `^[A-Za-z0-9_-]{8,100}$`); 503 `INDEXES_OUTDATED`
  when a ledger unique index is missing or different (r8).

Web flow after a lost top-up answer: call by-key with the form's key; `credited` → show the transaction and wallet (do not
resend); `not_found` → resend the same body with the same key. Never reuse a key with another amount or note (409
`IDEMPOTENCY_KEY_REUSED`).

### 21.4 Before production (r8, 2026-11-23)

Branch `m0/r8-before-production` from `e90952cc` (r7, origin/stage). Local commits only. Checks:
`test/assisted/r8-before-production.integration.ts` (7 checks; each fails on `e90952cc`).

| # | Finding | Fix |
|---|---|---|
| B1 (money) | The admin by-key read hints partial unique indexes; a missing or narrower index answered `not_found` (or 500) | Before the two reads, `assertUniqueIndex` checks `{pharmacyId, referenceType, referenceId}` and `{pharmacyId, operationKey}` as the schema declares them; otherwise 503 `INDEXES_OUTDATED`, never `not_found` |
| B2 | The doctor list's `nextSlot` fallback walked every unresolved doctor at once, up to 60 candidate days each (measured 6 256 queries) | One aggregation (`$match` the candidate filter, `$group` by doctor, `$min` date) gives each doctor's first candidate day (none: no read); at most 8 walks at a time. No `$firstN`/`$topN`. r8b: one window end for the aggregation and every walk, the cut-off day + `DOCTOR_ROLLING_DAYS` + 6; a walk reads its first candidate day whole first and the rest of the window (day by day only past 20 000 rows) only on a miss; a large `?date=` day is read 8 doctors at a time |
| B3 | `clinicBranchContext` compared branch ids exactly, `clinicBranchAdmission` lower-cased: a slot could be listed and then refused | Both compare lower-cased; the clinic lookup in `clinicBranchAdmission` is keyed by the lower-cased partner id |
| B4 | `GET /pharmacy-assisted/doctors/:id/slots` silently dropped the cut-off day and later past 5000 candidate slots | Past the shared read's cut-off the rest of the window (at most 14 days) is read day by day; a single day above 20 000 rows answers `truncated: true` (absent otherwise) |
| B5 | The admin top-up `Idempotency-Key` allowed any characters | Admin `POST /pharmacy-wallet/topup` header and the by-key `:key` must match `^[A-Za-z0-9_-]{8,100}$` (after trimming), else 400 `VALIDATION_ERROR`. The web's keys (32 hex) match. The pharmacy's own Razorpay top-up is unchanged |
| B6 | The web read the typed name by paging `/pharmacy-customers` | The booker view's `holder` is `{ pharmacyCustomerId, name, typedName }`: `typedName` is the name THIS pharmacy typed on its own link (as stored), or null; never another pharmacy's |

## 22. Owner decisions built (r9, 2026-11-23)

Branch `m0/r9-owner-decisions` from the stage line `92d47079` (origin/stage). Local commits only. Checks:
`test/assisted/r9-owner-decisions.integration.ts` (10 checks; 9 fail on `92d47079`, check 5a pins a rule that already
held). Where this section and an earlier one differ, this one wins.

### 22.1 What was built

| # | Decision | Built |
|---|---|---|
| 1 | Admin "close as already compensated" for a pharmacy card top-up that never arrived and that support already paid by hand | `POST /api/v1/admin/wallet-payments/:paymentId/close-compensated { reason, requestKey }` (admin tools switch). `paymentId` is resolved exactly as the payment chargeback resolves it (record id, Razorpay order id, or Razorpay payment id with the gateway lookup). One transaction sets `PaymentRecord.compensatedAt`, `compensation { by, reason, requestKey: '<adminId>:<key>', requestHash, previousStatus, amountPaise (r9b) }` and `status: failed` (a refunded record is refused, r9b), guarded on the status read, no `compensatedAt`, no `chargebackAt` and no credit claim, and writes the audit `wallet.closed_compensated` (`assisted_audit_events`: ids, the amount in paise, and the admin's free-text `reason`). A distinct field, not the chargeback block, so the S6 audit can tell the two apart; every credit path refuses it: verify (`handleExistingRecordStatus`, and the mark-paid write is guarded on no `compensatedAt`), reconcile and the top-up check (409 `TOPUP_BLOCKED`, message "closed: support already paid"), the credit claim (`walletCreditedAt`, guarded on no `compensatedAt`), the sweep (only `created` / unprocessed `paid` records), and `creditS6WalletTopup.ts` (refused first, no override). The S6 audit lists such records in `closedAsCompensated` (`review: 'closed as compensated: never credit'`, any status, never in `rows` or `failedWithCapture`, counted in the summary and the stderr line). The close and the credit write the same document, so the race gives credited (the close answers 409 `TOPUP_ALREADY_CREDITED`) or closed (never credited). Once per (admin, request key) with a content hash (the resolved record id and the reason); a top-up already closed answers its closure (`replayed: true`) whatever the key; the unique partial index `payment_records {compensation.requestKey}` is checked first (503 `INDEXES_OUTDATED`) |
| 2 | Clinic-workspace sign-in refused for a member whose doctor account is ineligible | `assertMemberDoctorEligible` (`middleware/auth.ts`): a partner member with a `doctorId` (the owner of a doctor's own practice, and equally a clinic's doctor member) is refused while that doctor is not `isEligibleDoctor` (verified and active): 403 `CLINIC_DOCTOR_NOT_VERIFIED`. Checked at the OTP sign-in (`verifyOTP`), at the workspace choice (`selectPartner`) and on every request of an existing session (`admitPartnerToken`, run by `authenticate` / `authenticateOptional`). Members without a `doctorId` are unaffected; re-verifying (or re-activating) the doctor restores access at once, with the same session |
| 3 | An admin prescription clear also takes back the copy bound to an existing medicine order | `decideFileAccess`: a prescription PDF or dispensing copy withdrawn by an admin clear is refused (uniform 404) to every non-admin before any other rule, the binding of a medicine order made from it included. The order stays (and keeps its fields); a replay of the order key answers the same order and does not make the copy readable again |
| 4 | After a clear and a new prescription, all older copies stay hidden except for admins | `withdrawnByAdminClear`: for every clear (with or without recorded `paths`), every dispensing copy made up to the clear (`rx-dispense-<ms>`, ms ≤ the clear) is withdrawn, besides the recorded paths. The new prescription's copy and PDF (made after the clear) stay readable to the patient, the doctor and (the copy) the pharmacy |
| 5a | Already decided: the pharmacy sees the real name only on a `customer_order` link | Checked, holds (`assisted/names.ts`, `NAME_SHOWN_CONSENTS`); a `patient_agreed` link shows the typed name. Not changed |
| 5b | Already decided (A10): the patient's view of a partner-paid booking shows "Paid by <partner>" and never the amount | One leak fixed: a kept (forfeited) partner payment records `noShowCancel.forfeitedAmount` on the booking (the partner's amount), and the customer and doctor views showed it. `assistedPublicView` drops it (the cancel's time and `refund: false` stay). `paidBy` (the partner's name) was already there; payment-details is 404 for an assisted booking |

### 22.2 API for the web

**Close a top-up as already compensated** (admin token; admin tools switch on, else 503):
`POST /api/v1/admin/wallet-payments/:paymentId/close-compensated` with `{ reason: string (1–500), requestKey:
^[A-Za-z0-9_-]{8,100}$ }`. `:paymentId` = the payment record id, the Razorpay order id (`order_…`) or the Razorpay payment
id (`pay_…`). Answers (`Cache-Control: private, no-store`):
- 200 `{ closed: true, credited: false, replayed, paymentRecordId, pharmacyId, amountPaise, compensatedAt, status, message }`
  (`replayed: true` when this key already closed it, or when it was already closed under another key; nothing is
  written then).
- 409 `TOPUP_ALREADY_CREDITED`: it was credited to the wallet; there is nothing to close (use a wallet adjustment if
  support paid twice). 409 `TOPUP_REFUNDED` (r9b): the gateway already returned the money. 409 `TOPUP_BLOCKED`: already blocked after a lost card dispute. 409 `IDEMPOTENCY_KEY_REUSED`: this
  admin's key was used for another top-up or another reason. 409 `PAYMENT_AMBIGUOUS`: several records carry that Razorpay
  id (use the record id).
- 404 `TOPUP_NOT_FOUND` (not a pharmacy card top-up), `TOPUP_NOT_FOUND_BY_PAYMENT_ID` (a `pay_…` id nobody holds); 400
  `VALIDATION_ERROR`; 403 for a non-admin; 503 `INDEXES_OUTDATED` (sync-indexes not run).

**Was it closed?** `GET /api/v1/admin/wallet-payments/close-compensated/by-key/:key` → 200 `{ state: 'closed', …the same
fields }` or `{ state: 'not_found' }` (this admin's keys only); 503 `INDEXES_OUTDATED`. After a lost answer: by-key, then
resend the same body with the same key only on `not_found`.

**For the pharmacy app:** verify, reconcile and `POST /pharmacy-wallet/topups/:id/check` of a closed top-up answer 409
`TOPUP_BLOCKED` with the message "This top-up was closed: Jansetu support already paid this amount to you, so it is not
credited to the wallet".

**Clinic workspace sign-in:** `POST /api/v1/auth/partner/verify`, `POST /api/v1/auth/partner/select` and every partner API call
answer 403 `CLINIC_DOCTOR_NOT_VERIFIED` ("Your doctor account is not verified or not active, so this clinic
workspace is closed to you; contact Jansetu support") for a member linked to a doctor who is not verified and active.
Show the message and do not retry; a person with another workspace can still choose it.

### 22.3 Deploy notes

- `npm run sync-indexes` adds `payment_records {compensation.requestKey: 1}` (unique, partial on string). Until then the
  close route and its by-key read answer 503; nothing else depends on it.
- No migration: no record has `compensatedAt` before the first close.
- Item 2 takes effect at once for existing sessions: before deploying, list members with a `doctorId` whose doctor is
  not verified and active (`db.partner_members.find({ doctorId: { $type: 'string' }, isActive: true })` joined to `specialists`),
  so support can expect their calls.

### 22.4 Follow-ups (r9b, review of `0ca329aa`)

Branch `m0/r9b-followups` from `0ca329aa` (origin/stage). Local commits only. Checks:
`test/assisted/r9b-followups.integration.ts` (5 checks; each fails on `0ca329aa`).

| # | Finding | Fix |
|---|---|---|
| 1 (MEDIUM, ₹) | A card dispute lost after a close-compensated answered "nothing taken": the pharmacy kept the hand payment and the disputed card money | The close stores the hand-paid amount (`compensation.amountPaise`). The payment chargeback of a closed top-up records a closed lot for that amount (`openedAtChargeback`) and charges it back as a credited top-up: balance down to 0 at most, the rest owed as `receivableMinor`, the wallet frozen, once per payment (the lot's unique `paymentRecordId`), audited `wallet.chargeback` with `compensated: true`; the answer carries `compensated: true`. The record also gets `chargebackAt`; a record an r9 chargeback already marked without taking anything is charged back on the next call. The S6 audit lists such a record in BOTH `blockedAfterLostDispute` and `closedAsCompensated` |
| 2 (LOW) | Choosing the workspace closed by the doctor rule used up the selection ticket, so the person needed a new code for their other workspace | `selectPartner` checks the ticket exists, then the doctor rule, and only then uses the ticket |
| 3 | A refunded top-up could be closed as compensated | 409 `TOPUP_REFUNDED` (the gateway already returned the money) |
| 4 | The close's credit lookup could miss a credit row whose pharmacy id is stored as a raw string in another spelling (an ObjectId-typed row was already found whatever the spelling) | Read through the driver with the ObjectId and both string spellings of the payer id (same compound index) |
| 5 | Error code | `CLINIC_OWNER_DOCTOR_NOT_VERIFIED` renamed `CLINIC_DOCTOR_NOT_VERIFIED` (§22.1, §22.2). The scope (every member with a `doctorId`) is unchanged and open for the owner |
| 6 | Doc | §22.1: the close audit's detail also holds the admin's free-text reason |

## 23. Phase 1b built: a pharmacy pays a booking by card/UPI (r10, 2026-11-23)

Branch `m0/r10-phase1b` from the stage line `9be7d0a7` (origin/stage). Local commits only; nothing pushed or deployed.
Checks: `test/assisted/r10-phase1b.integration.ts` (19 checks over HTTP with the real routers; all 19 fail on
`9be7d0a7`). Where this section and an earlier one differ, this one wins.

### 23.1 What was built

| Part | Where | Notes |
|---|---|---|
| Card booking create | `assisted/consultations.ts` | `paymentMethod: 'razorpay'` on `POST /pharmacy-assisted/consultations`: the same checks, key, hash, coupon, limits and transaction as the wallet create, but the booking is inserted `pending` / `pending` with its seat and the doctor's interval held (exactly like a customer's online booking), funding `{ method: 'razorpay', state: 'pending', paymentRecordId }` and no wallet debit. After the commit ONE Razorpay order is made on ONE payment record whose id was chosen before the insert |
| Payment record | `payment/types`, `payment/model`, `payment/services` (`createOrder` takes an optional `recordId`; receipt code `ab`) | New context `assisted_booking`: `contextId` = the booking, `userId` = `payerUserId` = the booker actor, `payerPharmacyId` = the pharmacy, no `couponCode` (coupons count only through `coupon_redemptions`, §6.4) |
| Confirmation | `assisted/cardPayments.ts` `applyAssistedCapture`, registered with `registerPaymentContextHandler('assisted_booking')` (`routes/index.ts`) | Verify, reconcile, the recovery sweep and the expiry sweep all reach it through the existing context routing (S6: the stored record's context only). ONE transaction moves the booking pending → confirmed / paid / funding `captured` (CAS on all three), audited `booking.paid`. Meet, reminders and the "booked" notices follow the confirmation. *Corrected by §23.6 item 5:* as built in `9f2a1807` the record was marked processed in that transaction, so a crash before the follow-up left it undone for good (a later call even treated the capture as late); from r10b the record is processed only after the follow-up, so any later verify, reconcile or recovery sweep finishes it (`postPaymentCompletedFor`) |
| Late captures | same | A capture that cannot be applied (booking expired or cancelled, doctor no longer verified and active (S5), another record, another amount) queues its card refund row in the same transaction (`cause: 'late_capture'`), audited `booking.late_capture`; the booking is never revived |
| Card refunds | `assisted/cardRefunds.ts`, model `assisted_card_refunds` (`assisted/model`) | One row per payment record (unique `paymentRecordId`): the cancellation refund and a late capture share it, so a capture is returned at most once whatever path finds it. Card rows are sent by a worker on the `prescriptionRefund.ts` pattern (fenced attempt + lease, the gateway is asked for a refund carrying the row's key before anything is (re)submitted, every submission counted first, only Razorpay `processed` completes it); sent at once after the commit and every 5 minutes (`assisted/schedulers.ts`, whatever the switches say). Always the full captured amount (Jansetu bears the fee) |
| Cancel and refund | `assisted/refunds.ts` `settleAssistedFundingIn`, `bookings/holds.ts` | Every cancel path of a card-paid booking (booker, patient, doctor, admin, admin close) queues the refund in the cancel transaction: to the card, or to the pharmacy wallet when the booker chose it (`refundTo: 'wallet'`). A card booking cancelled before its capture was applied refunds nothing (funding `not_paid`) |
| Expiry | `bookings/holds.ts` `expireUnpaidBooking`, `BookingService.expireUnpaidBookings` | The existing 30-minute sweep: it reconciles the `assisted_booking` attempt with the gateway first, then expires (seat and interval released, coupon redemption reversed, funding `not_paid`, cause `payment_timeout`). A capture recorded but not yet applied leaves the booking to the handler |
| Verification by organisation | `payment/services` `getPaymentRecordForVerification`, `payment/routes`, `payment/controller` | The paying pharmacy (`payerPharmacyId`) verifies and reconciles; the operational-pharmacy gate of booking payments covers `assisted_booking` (403 when not operational); the answer's `entity` is the booker view |
| Operator queue, admin | `assisted/cardRefunds.ts`, `assisted/controller/phase1a.ts`, `assisted/routes/phase1a.ts` | `GET /admin/assisted/card-refunds`; `POST /admin/assisted/card-refunds/:id/to-wallet` (with the partner's recorded agreement); `POST /admin/assisted-payments/:paymentId/chargeback`. The stuck-money report lists the queue (`refundRowsPending`) and `lateCaptures` |
| Switch | `assisted/flags.ts` | `ASSISTED_CARD_PAYMENT_ENABLED` (§23.4) |

### 23.2 Decisions made while building (ASSUMED, for the owner)

| # | Decision |
|---|---|
| C1 | **A switch of its own**, `ASSISTED_CARD_PAYMENT_ENABLED`, off by default, so 1b deploys dark where `ASSISTED_BOOKING_ENABLED_PHARMACY` is already on (stage). It gates only NEW card bookings; verify, reconcile, sweeps, late captures and refunds always run |
| C2 | **Refund route** ("back the way the partner paid; partner's choice"): every refund of a card-paid booking goes back to the CARD by default — booker, patient, doctor and admin cancellations and every late capture. The wallet only when the booker chooses it on its own cancel (`refundTo: 'wallet'`); the patient, doctor or admin cannot choose for the partner |
| C3 | Card money returned to the wallet (the partner's choice, or the admin fallback C5) opens no top-up lot, so it is **not withdrawable** (conservative, as admin credits). **The web must say so** where the partner chooses "refund to wallet" ("goes to your Jansetu wallet for bookings; it cannot be withdrawn to the bank") |
| C4 | **Card chargeback on a booking payment** (no wallet lot exists): bare minimum — RECORDED and FLAGGED only: `chargebackAt` on the payment record (once), an alert `booking_card_chargeback`, an audit `booking.card_chargeback`. No wallet debit, no receivable, no freeze, the booking is not changed. A card refund of that payment not yet sent is held (`manual_review`) and no later refund of it is ever made (card or wallet). Recovering the money from the partner is an admin decision — **no new money flow was built** |
| C5 | **A card refund that fails** (Razorpay refuses it, or reports it failed) goes to the operator queue; it is never credited to the wallet automatically. An admin may move it to the partner's wallet only with the partner's recorded agreement (`agreement` text, audited), once (the same wallet key as C2) |
| C6 | A consultation with nothing to pay (free, or a 100 % coupon) cannot be card-paid: 400 `NOTHING_TO_PAY` (book it with `wallet`, which debits nothing) |
| C7 | **Notices**: the patient and the doctor hear of a card booking only once it is paid (the "booked" notice, Meet and reminders at confirmation). A card booking cancelled or expired before payment tells nobody but the booker (when someone else cancelled it). The booker gets no notice of an expiry or a late capture; it sees them in its list and in the payment answers |
| C8 | A new number's account is opened at the pending insert (as for the wallet); if the payment never comes the account stays empty and internal (the clinic-desk rule, §6.2). Pending card bookings count against the per-phone and same-pair limits |
| C9 | S5: a capture for a doctor no longer verified and active is returned to the card; the booking stays pending and expires (as for customers) |
| C10 | **No pay-again**: one Razorpay order per booking. A lost answer is resumed with the same order (create replay or by-key); after the 30 minutes the booker books again. Switching a pending card booking to the wallet (§6.4 "pay-again … switching to the wallet") is not built |
| C11 | A returned capture's payment record becomes `refunded` when its refund row is created (as the customer paths mark a returned capture), even while the card refund is still pending at Razorpay; the refund row holds the gateway state |
| C12 | Razorpay's fee is recorded on the record (`gatewayFeeMinor`); refunds are always the full captured amount |

### 23.3 API for the web

Pharmacy token (operational and verified) on every pharmacy row; answers `{ success, data }`; money in paise unless
marked ₹.

**Book with card/UPI.** `POST /api/v1/pharmacy-assisted/consultations` — the wallet body of §19.3 with
`paymentMethod: 'razorpay'`. 201:
```
{ booking: { _id, status: 'pending', paymentStatus: 'pending', …as §19.3 },
  funding: { method: 'razorpay', amountMinor, state: 'pending', walletEntryId: null, paymentTransactionId },
  split: { listMinor, discountMinor, couponCode },
  payment: { paymentRequired: true, paymentTransactionId, razorpayOrderId, razorpayKeyId, amount (₹), amountMinor, currency, payBy } | null,
  newAccount, replayed }
```
- Open Razorpay Checkout with `key = razorpayKeyId`, `order_id = razorpayOrderId`, `amount = amountMinor`, `currency`.
  `payBy` (ISO) is when the booking expires and its seat is released if no payment arrived.
- The seat is held while the booking is `pending`. The patient and the doctor are not told until it is paid.
- Same `requestKey` and body again → 200 `replayed: true` with the SAME order (`payment` null once paid, cancelled or
  expired). The method is not part of the request hash: the same key with `paymentMethod: 'wallet'` answers the card booking.
- `GET /api/v1/pharmacy-assisted/bookings/by-key/:key` adds `payment` (the open order, or null; read only) for a card booking.
- (r10c) Every booker view of an assisted booking (`GET /api/v1/pharmacy-bookings[/:id]`, the pharmacy's generic
  `/bookings` reads, by-key, cancel and reschedule answers) carries `payment: { method: 'wallet' | 'razorpay', state,
  payBy, paymentTransactionId? }` — only for the booking's own pharmacy. `state` is the funding state (`pending`,
  `captured`, `refunded`, `not_paid`, `forfeited`); `payBy` (ISO) only while a card booking waits for its payment, else
  null; `paymentTransactionId` (card only) is the record to resume: replay the create (or by-key) for the order, or
  `POST /payments/reconcile { paymentTransactionId }`. Use `method` to offer the card / wallet refund choice on cancel.
  Patients and doctors never get this field. (r10d) While the card booking waits for its payment, `payment` also carries
  `razorpayOrderId` and `razorpayKeyId` (null when no order is open yet: replay the create), so Checkout can be reopened
  from any device.
- Errors (besides §19.3): 400 `PAYMENT_METHOD_UNAVAILABLE` (card switch off), `NOTHING_TO_PAY`; 502
  `RAZORPAY_ORDER_CREATION_FAILED` (the booking is held: send the same request again to get the order); 503
  `RAZORPAY_NOT_CONFIGURED`. Every refusal comes before any account, seat or order, with one answer for every number.

**After Checkout.** `POST /api/v1/payments/verify { paymentTransactionId, razorpayOrderId, razorpayPaymentId,
razorpaySignature }` (no `module` needed) → 200 `{ context: 'assisted_booking', paymentRecord, entity }`, `entity` = the
booker view of the booking:
- `paymentRecord.status: 'paid'` and `entity.status: 'confirmed'`: booked; message "Payment verified successfully".
- `paymentRecord.status: 'refunded'`: the booking could not take the payment (it expired, was cancelled, or the doctor is
  no longer available); the amount goes back to the card or UPI (message says so). Book again if needed.
- Errors: 400 `PAYMENT_SIGNATURE_INVALID`, `PAYMENT_ORDER_MISMATCH`, `PAYMENT_AMOUNT_MISMATCH`, `PAYMENT_NOT_COMPLETED`,
  `PAYMENT_FAILED`, `PAYMENT_REFUNDED` (a repeat after a returned capture); 403 `PHARMACY_INACTIVE` /
  `PHARMACY_NOT_VERIFIED`; 404 `PAYMENT_RECORD_NOT_FOUND` (another pharmacy's or the patient's call); 409
  `PAYMENT_CHANGED` (retry); 502 `RAZORPAY_PAYMENT_FETCH_FAILED`.
- Lost answer or closed Checkout: `POST /api/v1/payments/reconcile { paymentTransactionId }` → `{ state: 'paid', context,
  paymentRecord, entity }` (as verify) or `{ state: 'unpaid', gatewayStatuses }`. The server also checks every 5 minutes
  and before expiring the booking, so a capture is never lost.

**Cancel.** `POST /api/v1/pharmacy-assisted/bookings/:id/cancel { reason?, expectedUpdatedAt?, refundTo?: 'card' | 'wallet' }`
→ `{ booking, refundedMinor, alreadyCancelled, refund }`; `refund` (card bookings only) = `{ refundId, bookingId,
paymentRecordId, amountMinor, cause, method: 'card' | 'wallet', state: 'pending' | 'processed' | 'failed' |
'manual_review', lastError, attempts, razorpayRefundId, processedAt, createdAt, updatedAt }` or null (cancelled before
payment: `refundedMinor: 0`). `refundTo` defaults to `card`; `wallet` credits the wallet at once (NOT withdrawable — show this to the partner before it chooses) and
is ignored for wallet-paid bookings. 400 `VALIDATION_ERROR` for another `refundTo`; other errors as §19.3. Show
"refund to card: in progress" while `pending`; Razorpay usually completes in 5–7 working days.

**Patient app.** A card booking shows "Paid by <partner>" (`paidBy`) and never the amount, like a wallet booking. A
patient cancel refunds the PARTNER's card; the partner is told ("being refunded to the card or UPI it was paid with").

**Admin.**
- `GET /api/v1/admin/assisted/card-refunds?state&limit` → refund rows (as above, plus (r10c) `pharmacyId` and
  `pharmacyName`: the paying pharmacy, whose agreement a move to the wallet needs; admin only) that need a person: `failed`,
  `manual_review`, and `pending` ones over 20 attempts or older than 24 h (`state` filters exactly).
- (r10e) `GET /api/v1/admin/assisted/card-refunds/:id` → one row in the same shape (with `pharmacyId`, `pharmacyName`);
  404 `REFUND_NOT_FOUND`. Use it for "Check" instead of scanning the list. Row `cause` may be `extra_capture` (r10e).
- `POST /api/v1/admin/assisted/card-refunds/:id/to-wallet { agreement }` (admin tools switch) → `{ refund, replayed }`;
  409 `REFUND_NOT_FAILED` (only `failed` / `manual_review`), `CHARGEBACK_RECORDED`; 404 `REFUND_NOT_FOUND`.
- `POST /api/v1/admin/assisted-payments/:paymentId/chargeback { reason }` (admin tools switch; `paymentId` = record id,
  `order_…` or `pay_…` as stored) → `{ recorded: true, replayed, paymentRecordId, bookingId, bookingStatus, amountMinor,
  refund, message }`; 404 `PAYMENT_NOT_FOUND`; 409 `PAYMENT_AMBIGUOUS`. A top-up still goes to
  `/admin/wallet-payments/:paymentId/chargeback` (which answers 404 `TOPUP_NOT_FOUND` for a booking payment).
- `GET /api/v1/admin/assisted/stuck-money`: `refundRowsPending` (the queue above) and `lateCaptures` are now filled.

### 23.4 Switches, deploy and rollback

- `ASSISTED_CARD_PAYMENT_ENABLED` (off unless exactly `true`): new card bookings. Needs `ASSISTED_BOOKING_ENABLED_PHARMACY`
  and the Razorpay keys.
- `npm run sync-indexes` adds the collection `assisted_card_refunds` (`paymentRecordId` unique, `bookingId`, `{state,
  updatedAt}`). Run it before turning the switch on: a card create answers 503 `INDEXES_OUTDATED` until the unique index exists.
- No migration. Order: deploy with the switch off → `sync-indexes` → set `ASSISTED_CARD_PAYMENT_ENABLED=true` → restart.
- Manual check on stage (test keys): book by card, pay in Checkout, see it confirmed; cancel it, see the refund at
  Razorpay; book by card and let it expire, then pay the same order from the Razorpay test dashboard: the capture is
  refunded once.
- **Rollback:** switch off (new card bookings stop; verify, sweeps and refunds go on). Never roll the CODE back while a
  card booking is pending or a card refund row is `pending`: older code does not know the `assisted_booking` context, so
  a capture would stay unapplied and a cancel would refund nothing.
- **Rollback below r10e (r10f note):** once any card refund row with `cause: 'extra_capture'` exists
  (`db.assisted_card_refunds.countDocuments({ cause: 'extra_capture' })` > 0), never roll the code back below r10e
  (`d1ed6d24`). Earlier code does not know those rows: it treats a record's extra-capture row as the record's own return
  (so the real cancellation refund of that booking would never be queued) and its unique index cannot hold both rows —
  money would be lost.

### 23.5 Not built in 1b (see §23.6 for what r10b added)

Pay-again and switching a pending card booking to the wallet (C10); recovering a lost card dispute from the partner
(C4); notices to the booker on expiry or late capture (C7); the daily reconciliation's per-booking checks for card
bookings (Razorpay totals) — they cover wallet bookings only; lab and doctor bookers, instant consults (later phases).
"One capture per paid booking" is built in r10e (§23.6): extra captures on an order are refunded.

### 23.6 Review fixes (r10b, review of `9f2a1807`)

Branch `m0/r10b-phase1b-fixes` from `9f2a1807` (origin/stage). Local commits only. Checks:
`test/assisted/r10b-phase1b-fixes.integration.ts` (12 checks; the 11 for fixes fail on `9f2a1807`, "7 guard" pins that
other contexts still close a record on a bad signature). Where this section and an earlier one differ, this one wins.

| # | Finding | Fix | Check |
|---|---|---|---|
| 1 (MEDIUM-HIGH, ₹) | A card refund Razorpay kept `pending` used up the 20 attempts with harmless lookups; then nobody looked again, the queue showed it and to-wallet refused it: the refund could be lost | `attempts` now counts REAL failures only (gateway unreachable, outcome unknown, refund mismatch). A refund still pending at Razorpay counts `checks` and is looked up again with back-off (10 min doubling, at most every 12 h) for as long as it stays pending — never given up (`nextCheckAt`). New admin `POST /admin/assisted/card-refunds/:id/recheck` (asks Razorpay now, whatever the back-off or failure count) and `POST …/:id/mark-failed { reason }` (admin tools switch; holds the row, reads Razorpay, refuses 409 `REFUND_AT_GATEWAY` while any refund of that payment is processed or pending there; audited `card_refund.marked_failed`), after which `to-wallet` works. Stuck money adds `cardRefundsPendingOverDays` (`ASSISTED_CARD_REFUND_STUCK_DAYS`, default 7). C11 stays | 1a, 1b, 1c |
| 2 (MEDIUM) | Unpaid card bookings held doctors' slots for free (30 minutes each, without limit) | **Removed by owner, 23 Nov (r10g):** the cap and the per-booker lock row are gone; an unpaid expiry still counts toward the cancellation alert. *As built in r10b:* At most `ASSISTED_LIMIT_PENDING_CARD_BOOKINGS` (default 10) card bookings of one booker wait for payment at once: decided in the booking transaction after a per-booker lock row (concurrent creates run one after the other), 429 `ASSISTED_LIMIT_REACHED` `limit: 'pending_card_bookings'`. An unpaid card booking that expires counts as a booker cancellation (P7 daily limit, alert at the threshold) | 2a, 2b |
| 3 (MEDIUM) | The patient and the doctor saw card bookings never paid, with "Paid by" | A card booking never confirmed (`lifecycle.confirmed` absent: waiting for payment, or expired / cancelled before it) is the booker's alone: left out of the patient's and the doctor's lists (generic `/bookings` lists by query, the specialist portal's appointment list and patient history), 404 on their reads (`/bookings/:id`, portal appointment, status, prescription), on the patient's cancel, notes edit and "not mine", and on a doctor's cancel. `paidBy` is null unless paid. Once its payment confirms it, it is theirs (and stays so if cancelled later) | 3 |
| 4 (LOW-MEDIUM, ₹) | to-wallet did not ask Razorpay first | Before crediting, Razorpay's refunds of the payment are read: any processed or pending one → 409 `REFUND_AT_GATEWAY` (502 `GATEWAY_LOOKUP_FAILED` when Razorpay cannot be asked) | 4 |
| 5 (LOW-MEDIUM) | A crash between the confirmation and its follow-up (Meet, reminders, notices) left it undone, and a later call even returned the capture as late | The record is marked processed only after the follow-up; a record that already confirmed its booking is recognised as such and only finishes the follow-up (verify, reconcile, recovery sweep). The booking CAS alone confirms exactly once | 5 |
| 6 (LOW) | A card dispute could be recorded on a payment never captured | 409 `PAYMENT_NOT_CAPTURED` unless the record is `paid` or `refunded` with a Razorpay payment id | 6 |
| 7 (LOW) | A bad signature marked an assisted card record failed, so the real capture could no longer be verified, reconciled or swept | For `assisted_booking` records a bad signature answers 400 `PAYMENT_SIGNATURE_INVALID` and leaves the record as it is; other contexts unchanged | 7, 7 guard |
| — | Wording; visibility of disputes | A disputed assisted record answers 409 `PAYMENT_DISPUTED` ("A card dispute was recorded on this booking payment…") instead of the top-up wording. C4 is unchanged (flag only, owner asked); stuck money adds `cardChargebacks` | 8 |

**New answers for the web:** 429 `ASSISTED_LIMIT_REACHED` with `limit: 'pending_card_bookings'` on the card create
("complete or cancel a waiting card booking first"); 409 `PAYMENT_DISPUTED` on verify / reconcile. Admin: `POST
/api/v1/admin/assisted/card-refunds/:id/recheck` → `{ refund, gateway: [{ id, status, amountMinor, ours }] }` (409
`REFUND_BUSY`, 404 `REFUND_NOT_FOUND`, 502 `GATEWAY_LOOKUP_FAILED`); `POST …/:id/mark-failed { reason }` → `{ refund }`
(409 `REFUND_NOT_PENDING`, `REFUND_BUSY`, `REFUND_AT_GATEWAY`; 502 `GATEWAY_LOOKUP_FAILED`); `to-wallet` adds 409
`REFUND_AT_GATEWAY` and 502 `GATEWAY_LOOKUP_FAILED`; the assisted chargeback adds 409 `PAYMENT_NOT_CAPTURED`; stuck money
adds `cardRefundsPendingOverDays` and `cardChargebacks`. A refund row's `attempts` now counts failures only.

**Switches added:** ~~`ASSISTED_LIMIT_PENDING_CARD_BOOKINGS` (10)~~ (removed by owner, 23 Nov), `ASSISTED_CARD_REFUND_STUCK_DAYS` (7). No migration, no
new index (the two new refund-row fields are unindexed).

**r10c (read-only additions for the web, same branch):** checks 9–10 of `test/assisted/r10b-phase1b-fixes.integration.ts`
(both fail on `b287b340`).

| # | Change |
|---|---|
| 9 | Booker view `payment: { method, state, payBy, paymentTransactionId? }` for the booking's own pharmacy only (§23.3), so "pay now" and the refund choice work on any device. Patient and doctor views never carry it; they also no longer carry `postPaymentCompletedFor` (the partner's card payment record id, found by this check) |
| 10 | Admin card-refund rows (`/admin/assisted/card-refunds`, stuck money's `refundRowsPending` and `cardRefundsPendingOverDays`) add `pharmacyId` and `pharmacyName`; the pharmacy's own `refund` answer is unchanged |

**r10d (branch `m0/r10d-phase1b` from `6b223644`):** checks 11–15 of `test/assisted/r10b-phase1b-fixes.integration.ts`
(all five fail on `6b223644`).

| # | Finding | Fix |
|---|---|---|
| 11 (LOW-MEDIUM, privacy) | The clinic workspace listed card bookings never paid (an online in-clinic visit at its branch), and could start a bill for one | `GET /partner-workspace/clinic/appointments` leaves them out (`$nor: [UNPAID_CARD_QUERY]`); a bill naming one answers 404 `APPOINTMENT_NOT_FOUND`. The other clinic and desk reads act on desk bookings only (`clinicDesk.partnerId`), which are never assisted |
| 12 (LOW) | Verify, reconcile and the sweep at once each ran the follow-up, so the doctor got several Meet invites | One caller claims the follow-up: `assisted.followUpLeaseUntil` set only while free (5-minute lease; a crashed claim is taken over when it ends), released when done. A caller that finds it claimed leaves the record unprocessed for the claimer (or the sweep) to finish |
| 13 | "Pay now" from any device | Booker view `payment.razorpayOrderId` / `razorpayKeyId` while waiting (§23.3); the booking's own pharmacy only |
| 14 | An admin move of an unpaid card booking told the holders about a booking they never saw | Only the booker is told |
| 15 | Stuck money's `cardChargebacks` rows had no pharmacy name | `pharmacyName` added (admin only) |

C4 (owner, 23 Nov): a card chargeback on a booking payment stays flag-only; recovery is the admin's decision.

**r10e (same branch, on `a7ae19bb`):** checks 16–19 of `test/assisted/r10b-phase1b-fixes.integration.ts` (all four fail
on `a7ae19bb`).

| # | Finding | Fix |
|---|---|---|
| A (money) | Razorpay accepts more than one payment on an order that is only "attempted" (a slow UPI payment, then a second "pay now"), so one card booking could be captured twice; verify accepted the second as "already paid" and reconcile and the sweep looked only at the first capture | Only the payment record's own capture (`razorpayPaymentId`) counts. Every OTHER captured payment on the order is refunded to its card, once per Razorpay payment id (`cause: 'extra_capture'`, audited `booking.extra_capture`), whatever the booking's state (paid, cancelled, expired). Found by: verify of the other payment (409 `DUPLICATE_PAYMENT_REFUNDED` "This booking was already paid with another payment; this payment is being refunded…", also when two verifies race), reconcile (it now reads every payment on the order, also for a record already paid or returned), the recovery sweep (through reconcile), and a new other-capture sweep (assisted scheduler, every 5 minutes: paid or returned card records for 7 days, back-off 10 min doubling to 6 h; `PaymentRecord.extraCheckNextAt` / `extraChecks`). Payment services gained an optional context hook `settleOtherCaptures`; other contexts are unchanged |
| A (index) | A refund row was unique per payment record, so a second capture on the same record had no row | Card refund rows get `captureKey` (`pay:<razorpayPaymentId>`, else `record:<id>`), **unique** (partial on string); `paymentRecordId` becomes an ordinary index (a record may have its own return and extra-capture returns). A record's own return is still found once by `paymentRecordId` + cause; the worker's and to-wallet's card-dispute hold applies to the record's own capture only; to-wallet of an extra capture uses its own wallet key |
| B | The web's "Check" scanned the whole list | `GET /api/v1/admin/assisted/card-refunds/:id` (§23.3) |

**Deploy:** `npm run sync-indexes` changes `assisted_card_refunds`: drops the unique `paymentRecordId_1`, recreates it
non-unique, and adds the unique partial `captureKey_1`. Until it has run, a card create answers 503 `INDEXES_OUTDATED`
(the check moved to `captureKey`). *Corrected (r10f):* refunds do NOT all keep working meanwhile — between the pull and
`npm run sync-indexes` the old unique `paymentRecordId_1` is still there, so a cancel of a card booking that already has
an extra-capture row (or an extra-capture refund of a booking already refunded) fails with `DUPLICATE_RESOURCE`. Run
`npm run sync-indexes` straight after the pull, before the restart. Rows from before r10e have no `captureKey`
(each is its record's own return, found by `paymentRecordId` as before). No migration.

### 23.7 Last card-payment fixes before production (r10f, 2026-11-23)

Branch `m0/r10f-card-last` from `d1ed6d24` (origin/stage). Local commits only. Checks:
`test/assisted/r10f-card-last.integration.ts` (2 checks; both fail on `d1ed6d24`).

| # | Finding | Fix | Check |
|---|---|---|---|
| 1 (LOW) | A slow Meet/Google call in the card follow-up could outlive the follow-up lease (5 min), letting a second worker create another Meet event | The Meet step is bounded at `ASSISTED_MEET_TIMEOUT_MS` (default 60 s, never more than half the lease): an `AbortSignal` passed through `syncBookingMeet` to its Google calls (token refresh, event create / update) aborts them, and the follow-up goes on without a Meet link (best effort, as before). `meet/service` and `meet/types` take the optional `signal`; other callers are unchanged | 1 |
| 2 (LOW) | A card dispute could only be recorded against the booking's own payment, not an extra capture | `POST /admin/assisted-payments/:paymentId/chargeback` also takes an extra capture's Razorpay payment id: flag only (C4, owner: no debit, no freeze): `chargebackAt` on that capture's refund row (once), its unsent refund held (`manual_review`, never sent or credited to the wallet), alert `booking_card_chargeback`, audit. The answer adds `extraCapture: true` and `razorpayPaymentId`; stuck money's `cardChargebacks` lists such rows with `extraCapture: true`. An unknown id is 404 `PAYMENT_NOT_FOUND` as before | 2 |
| 3 | Rollback | §23.4: never below r10e once an `extra_capture` row exists | — |
| 4 | Deploy wording | §23.6 r10e deploy note corrected (`DUPLICATE_RESOURCE` until sync-indexes) | — |

### 23.8 Meet retry; booking limits removed (r10g, 2026-11-23)

Branch `m0/r10g-meet-retry-limits` from `f81c8f3b` (origin/stage). Local commits only. Checks:
`test/assisted/r10g-meet-retry.integration.ts` (5 checks; all fail on `f81c8f3b`), the changed limit check of
`test/assisted/phase1a.integration.ts` and checks 2a / 2b of `test/assisted/r10b-phase1b-fixes.integration.ts`.

| # | Change |
|---|---|
| 1 (M1 of the r10f review) | **Meet retry** (`meet/retry.ts`, scheduler every 5 minutes, started in `index.ts`). It covers EVERY paid, confirmed consultation or second opinion in `video` or `call` mode starting within the next 48 hours and not ended (start + 60 minutes): customer bookings, clinic online visits, wallet- and card-paid assisted bookings alike — the production gap for customer bookings is covered too. Only bookings whose `virtualMeeting` is missing (15 minutes after the confirmation, so the payment follow-up keeps its own first attempt) or `failed`; an active link is never touched. One claimer per booking (`meetRetry.leaseUntil`, 5 minutes, on the wall clock); each attempt's Google calls are bounded by `ASSISTED_MEET_TIMEOUT_MS` (default 60 s, at most half the lease). A failed attempt backs off (5 minutes doubling, at most 2 hours; `meetRetry.attempts`, `nextAt`); after 3 failed attempts one alert `meet_link_missing` is raised (assisted alerts list). A failure whose cause is permanent (patient without email on a customer booking, Google not configured) keeps retrying with back-off and is alerted once. Stuck money adds `upcomingMeetsMissing` (all such bookings of the next 48 hours, with attempts). New booking field `meetRetry` (written only by the retry) |
| 2 (owner, 23 Nov) | **Booking limits removed** except the hourly lookup limit (`ASSISTED_LIMIT_LOOKUPS_PER_HOUR`, 120). Gone: bookings per phone (5/day), new accounts (30/day), the stop after 20 booker cancellations a day, and pending card bookings (10, with its per-booker lock row — nothing else relied on it). The cancellation count (booker cancels and unpaid expiries) and the same-pair count stay, as alerts only. 429 `ASSISTED_LIMIT_REACHED` now only carries `limit: 'lookups'` |

### 23.9 Meet retry review fixes (r10h, 2026-11-25)

Branch `m0/r10h-meet-retry-fixes` from `4d2b53a9` (r10g). Local commits only. Checks: 6–11 of
`test/assisted/r10g-meet-retry.integration.ts` (now 10 checks; checks 6–10 fail on `4d2b53a9`). Where this section and
§23.8 differ, this one wins.

| # | Finding | Fix | Check |
|---|---|---|---|
| 1 (must) | Google could create an event without a Meet link (conference pending or refused, or a create whose answer was lost); the failure record kept no event id, so every retry created a NEW event and invited everyone again (27 invites in 48 h in the probe) | `syncBookingMeet` keeps the event it made on the failure record (`calendarEventId`) and marks every event it creates with `extendedProperties.private.jansetuBookingId`. The retry calls it with `reuseExisting`: a failed record naming an event re-reads that event (GET: no update, nobody emailed; a deleted one is replaced once); a record without one looks the booking's own event up first and creates only when Google has none. Ordinary callers (payment follow-up, reschedule) are unchanged | 6 |
| 2 (must) | The retry invited a doctor who is no longer verified or active (S5), with the patient's name and concern | Skipped with the existing S5 check `doctorExistsIneligible` (no claim, no Google call); retried once the doctor is eligible again | 7 |
| 3 (must) | Ended-but-confirmed rows filled every 100-row batch (earliest first) and starved upcoming bookings; stuck money had the same blind spot | The query starts today (India time); the whole due set is scanned and only the attempts are capped (100 a run); a row found ended (start + 60 minutes, or no start) is marked with that appointment (`meetRetry.endedFor: '<date> <time>'`) and left out of the query until it moves to another slot. Stuck money scans the whole set too | 8 |
| 4 | Failures no retry can fix were retried for 48 h | `permanentMeetFailure` (meet service: patient or doctor without email, Meet not configured, slot missing) closes the booking after the attempt (`closed: 'permanent'`, `closedReason`). Alerts: at most one per booking — **none for a customer booking whose patient has no email** (DECIDED here: phone-only customers are common and the gap is expected; the booking is still listed in stuck money with `closedReason: 'patient_email_missing'`); "Meet not configured" raises one alert a day for all bookings. *Changed by §23.10 (r10i): "not configured" closes nothing* | 9 |
| 5 | A failure write bumped `updatedAt` (a booker's `expectedUpdatedAt` then failed with 409 `BOOKING_CHANGED`) | Every failure record `syncBookingMeet` writes uses `timestamps: false`; the retry's own writes never touched it | 10–11 |
| 6 | `meetRetry.attempts` kept counting after a success | Reset to 0 on success | 10–11 |

**Seen, not changed (from the review, later):** a reschedule or cancel in the same second as a retry (the final
unconditional write in `syncBookingMeet`); `meetRetry` in the patient and doctor views. Also: a create aborted by the
time limit after Google made the event is now found by the next retry (`jansetuBookingId`), but the first, ordinary
(non-retry) attempt never looks up before creating.

### 23.10 Meet retry polish (r10i, 2026-11-25)

Branch `m0/r10i-meet-retry-polish` from `a18adba7` (r10h). Local commits only. Checks: 12–15 of
`test/assisted/r10g-meet-retry.integration.ts` (now 14 checks; 12–15 fail on `a18adba7`). Where this section and §23.9
differ, this one wins.

| # | Finding | Fix | Check |
|---|---|---|---|
| H3 | A reused event (§23.9 item 1) could still be at an older time — a reschedule whose update to Google failed — and the booking was marked active while the calendar showed the old time | When the retry reuses an event whose start differs from the booking's current appointment, it updates that event to the current time and text (`sendUpdates=all`: telling the attendees is right then). One shared update step in `syncBookingMeet` (the ordinary update path uses it too); an event already at the right time is only read | 13 |
| H5 | "Meet not configured" closed bookings for good, so restoring the configuration linked nothing | It is no longer a permanent failure: without the configuration a retry run attempts nothing and closes nothing, and raises one `meet_link_missing` alert a day (`detail.permanent: 'meet_not_configured'`); the next run after the configuration is back links the bookings | 12 |
| 3 | A permanent close stayed after a success or a move | A permanent close holds only for the appointment it was decided on (`meetRetry.closedFor`, compared in the query, so a move to another slot brings the booking back without touching the reschedule code); a success clears `closed`, `closedReason` and `closedFor`. Rows closed by r10h (no `closedFor`) get one more attempt | 14 |
| 4 | A stored `bookingDate` / `bookingTime` that is not a string made `$concat` fail the whole run and stuck money | The appointment key converts both with `$convert` (`onError`/`onNull`: empty) | 15 |

## 24. Phase 2 build specification (labs) (r11, 2026-11-23)

Design only; nothing here is built. Base: the stage head `d1ed6d24` (phases 0, 1a and 1b with r6–r10e). Where this section
and an earlier one differ, this one wins. Every `file:line` is under `src1/modules/` at `d1ed6d24`.

Phase 2 reuses the patterns phases 0–1b built and adds no new ones:
- the `assisted` block (`assisted/types.ts:55-73`);
- request keys claimed in the transaction (`requestKeys`);
- `requestHashOf` content hashes;
- `assertUniqueIndex` fail-closed 503 (`common/utils/requiredIndex.ts:19`);
- the booker ledger with operation keys (`pharmacyWallet/ledger.ts:99`);
- lots (`pharmacyWallet/model/lots.ts`);
- card refund rows and their worker (`assisted/cardRefunds.ts`);
- per-organisation limits (`assisted/limits.ts`);
- the audit in the same transaction;
- notices sent after commit (`assisted/support.ts`).

### 24.1 Owner decisions this section builds (not reopened)

1. **Payment.** The partner pays Jansetu at booking time, from its wallet or by card/UPI per booking, and collects from
   the patient at its own price.
2. **Refunds** go back the way the partner paid. The partner chooses where both are possible.
3. **Lab desk.** A lab gets a front desk for its own tests:
   - paid at the lab;
   - no Jansetu money;
   - the report goes to the patient's app;
   - lab visits and home collection.
4. **Cancellation windows.**
   - The partner may cancel a lab booking up to 1 h before the slot.
   - The patient may cancel from the app; the refund goes to the partner.
5. **Who sees the report.** The patient and the partner that booked it. Pharmacies and labs see only their own bookings.
6. **Lab → doctor.** A lab may book a doctor consultation (as §7.3) and sees the prescription as a pharmacy does. A lab
   never books another lab's tests.
7. **Wallets** for pharmacy, lab and doctor: top-up by Razorpay, paying bookings, refunds into them. Withdrawals are
   phase 4 (`WALLET_WITHDRAWALS_ENABLED` stays unread).
8. **Names.** The real account name is shown only on `customer_order` links. Otherwise the typed or masked name.
9. **Referral cut** is 0 in phase 2, but its fields are kept.
10. **SMS** is phase 5: hooks only.
11. **Coupons** are allowed when applicable; Jansetu pays gateway fees.
12. **Unverified or ineligible providers** are blocked everywhere. The lab equivalent of S5 is:
    - partner `kind: 'lab'`, `isActive !== false` and `verification.state === 'verified'`, as the customer lab create
      checks it (`partners/services/labBookings.ts:181-184`) and as `assertOperationalPartner` admits members
      (`middleware/auth.ts:454-471`);
    - the branch must be active and offer the visit mode (`labBookings.ts:185-189`);
    - catalogue items must be active and not admin-disabled (`labBookings.ts:193`).

### 24.2 The split, and why it differs from the suggestion

The suggestion was 2a = lab wallet + pharmacy → lab + report access. The code says otherwise:

- **A pharmacy → lab booking does not need the lab wallet.** The pharmacy pays from its own wallet
  (`postPharmacyMovementIn`, `pharmacyWallet/ledger.ts:99`). A lab wallet is needed only when the LAB pays, which is
  for consultations (2e).
- **The card path for lab bookings is a new payment context.** The existing lab capture handler
  (`labBookings.ts:353-378`) runs on the customer-wallet ledger (`recordGatewayCapture`). The 1b handler
  (`assisted/cardPayments.ts:94`) is written against `BookingModel`. Wallet and card together would repeat the size of
  1a + 1b in one round.

| Round | Content | Depends on | Size |
|---|---|---|---|
| **2a** | Pharmacy → lab test paid from the **pharmacy wallet**; the booker's lab list and detail; **booker report access**; cancellations (booker 1 h, patient, lab reject, admin) with wallet refunds; customer command routing for lab rows; lab-side view; "not mine" and admin move for lab rows; earnings by `provider_coupon_v2`; reconciliation | — | M |
| **2b** | Pharmacy → lab test by **card/UPI**: context `assisted_lab_booking`, verify/reconcile/sweeps, late and extra captures, card refunds, expiry | 2a | M |
| **2c** | **Lab desk**: visit with slot, walk-in without slot, home collection (address, home slot, collector); Q2 bill link; §5.5 guards; `assisted_links` for labs | 2a (schema) | M |
| **2d** | **Lab wallet**: `partner_wallets` store, Razorpay top-up with lots, verify/reconcile mounted in the partner workspace, recovery sweep, admin top-up/freeze/lots/chargebacks/close-compensated, reconciliation | — | M |
| **2e** | **Lab → doctor consultation** (wallet and card): the 1a/1b pharmacy flow generalised to a lab booker; prescription (dispensing copy) access for the lab | 2c (`assisted_links`), 2d | M |

- 2c can be built before 2b. 2d can be built at any time.
- Every round touching `partners/model/labBooking.ts` goes in order (2a → 2b → 2c), so no two branches change that schema
  at once.
- Each round = backend + integration suite + independent review (Opus xhigh), local commits, stage only on the owner's
  word (§13).

### 24.3 Shared rules for every round

- **Money** is integer paise (`…Minor`). Lab prices are already paise (`ILabBookingItem.priceMinor`,
  `partners/model/labBooking.ts:16`).
- **Booker actor kinds.**
  - Pharmacy: `PharmacyActor` (`assisted/consultations.ts:58`).
  - Lab member: the `PartnerActor` admitted per request (`partners/services/index.ts:28-37`).
  - Booker audit: pharmacies write `assisted_audit_events`. Lab members write `PartnerAuditEvent` through
    `recordPartnerAudit` (§6.1), in the same transaction.
- **Request keys.** Format `ASSISTED_KEY` (`consultations.ts:43`). The hash uses `requestHashOf` and never includes the
  payment method. Same key and hash → 200 `replayed`. Other content → 409 `IDEMPOTENCY_KEY_REUSED`. Abandoned → 409
  `REQUEST_ABANDONED`. A lost answer uses by-key and abandon routes (Q13).
- **Fences.** Later steps carry `expectedVersion` (the lab booking's `statusVersion`, the `assertVersion` pattern at
  `labBookings.ts:502-506`) or `expectedUpdatedAt` (consultations).
- **Indexes.** Each writer calls `assertUniqueIndex` on every unique index it relies on, before any read that counts or
  holds, and answers 503 `INDEXES_OUTDATED` until `npm run sync-indexes` has run. New models live in `model/` folders.
- **Switches** are read on every call, off unless exactly `"true"` (`assisted/flags.ts:14`). Turning a switch off stops
  only NEW bookings, top-ups and lookups. Reads, cancellations, refunds, verify/reconcile and the sweeps always run.
- **Patient order** (§6.2, review 4 of 1a):
  1. validate;
  2. replay first;
  3. count the lookup and audit `booking.attempted`;
  4. abandoned key check;
  5. `assertBookerMayBook`;
  6. every refusable check (provider, items, slot, family member, coupon, price fence), with one answer for known and
     unknown numbers;
  7. ONE transaction that opens a new number's account.

  The helpers `openOrPrepareAccountIn` (`consultations.ts:398-409`), `assertDependentOfPhone` (`:197-204`), `couponFor`
  (`:175-194`) and `redeemCouponIn` (`:429-438`) move to a new `assisted/patient.ts` and are exported. `redeemCouponIn`
  gains `bookingKind` and `payerKind` parameters (today it hard-codes `'booking'` / `'pharmacy'`, `:435-436`). The
  1a/1b suites are the regression check for the move.
- **SMS hooks.** Each place below marked *SMS hook* gets a comment `// SMS phase 5: <message>` and nothing else: no
  `Job` insert, no template read.
- **Names.** Pharmacies keep the 1a rule (`assisted/names.ts:31`, `NAME_SHOWN_CONSENTS = ['customer_order']`). Labs
  have no `customer_order` link, so a lab always sees the typed name, else the masked name (§17.4).

### 24.4 Round 2a: pharmacy → lab test, wallet-paid, and booker report access

#### 24.4.1 Data model

**`partners/model/labBooking.ts`.**

| Change | Where | Detail |
|---|---|---|
| `source` | interface `:35-72`, schema `:100-219` | `String`, enum `['self', 'pharmacy_assisted', 'doctor_assisted', 'lab_desk']`. Written on every new row. Readers derive `self` when it is missing (no backfill). There is no `lab_assisted` on lab rows (a lab never books another lab's tests) |
| `assisted` | same | `Schema.Types.Mixed`, the `AssistedBlock` of `assisted/types.ts:55-73` without `join`. Written only by the assisted writers |
| `cancellation.reason` enum | `:59`, `:163` | adds `'partner'` (booker cancel, §7.2) |
| `cancellation.byKind` enum | `:59`, `:166` | adds `'booker'` |
| `createRequestKey` / `createRequestHash` | `:40-42` | **never set on assisted rows.** The customer key index `{userId, createRequestKey}` (`:221`) is the patient's namespace |
| `paymentDeadline` | `:159` | stays required in 2a. A wallet row stores its create time; it is never `pending_payment`, so the sweep (`:412-416`) never sees it |
| `pricing.commissionMinor` | `:130` | 0 |

**`assisted/types.ts`.**
- `AssistedSplit` (`:44-53`) gains `lines?: [{ catalogItemId, listMinor, discountMinor, baseMinor, cutMinor }]`.
  - The coupon is spread over lines by price, largest remainder in paise (D4).
  - `cutMinor` is 0 on every line, and `referral` stays `null` (cuts are phase 4).
- `AssistedRefundRow.cause` adds `partner_lab_reject` and `admin`.

**Indexes on `partner_lab_bookings`**, declared on the schema:
- `{ 'assisted.requestKey': 1 }`, unique, partial `$type: 'string'`;
- `{ 'assisted.shortRef': 1 }`, unique, partial;
- `{ 'assisted.bookedBy.kind': 1, 'assisted.bookedBy.id': 1, createdAt: -1, _id: -1 }`.

**Coupons.**
- `coupon_redemptions` already allows `bookingKind: 'lab_booking'` and `payerKind: 'lab'`
  (`coupon/model/redemption.ts:13-15`).
- `reverseRedemptionIn` (`assisted/refunds.ts:35`) widens its `bookingKind` type to `'booking' | 'lab_booking'`.

#### 24.4.2 Routes (pharmacy token, `requireOperationalPharmacy`; mounted on `pharmacyAssistedRouter`, `assisted/routes/phase1a.ts:14`)

| Route | Request | Answer `data` |
|---|---|---|
| `GET /api/v1/pharmacy-assisted/labs` | `?visitMode=lab\|home&limit` | `[{ partnerId, name, nearby: 'pincode'\|'city'\|null, branches: [{ branchId, name, address, phone, homeCollection, inLab }] }]`. Verified, active labs with active branches only (reuse `listLabs`, `labBookings.ts:1013-1032`), sorted by the pharmacy's pincode, then city |
| `GET /api/v1/pharmacy-assisted/labs/:partnerId/catalogue` | `?visitMode` | `labCatalogue` (`labBookings.ts:1034-1044`) as is: `[{ itemId, kind, name, code, description, preparation, sampleType, includes, priceMinor, mrpMinor, visitModes, reportTatHours }]` |
| `GET /api/v1/pharmacy-assisted/labs/branches/:branchId/slots` | `?visitMode&from&days≤14` | `branchSlots` (`labBookings.ts:1046-1053`): `[{ slotId, date, startTime, endTime, seatsLeft }]`. Starts ≥ 60 min ahead (`LAB_MIN_LEAD_MS`, `:43`) |
| `POST /api/v1/pharmacy-assisted/lab-bookings` | `{ requestKey, phone, patient, holderName?, consent: { agreed: true, statementVersion, statementLanguage }, preferredLanguage, partnerId, branchId, visitMode, slotId, itemIds[1..20], address? (home: { line1, line2?, city, state?, pincode, landmark? }), couponCode?, acceptedPriceMinor, notes?, paymentMethod: 'wallet' }` (`patient` as §19.3) | 201 `{ booking: <booker lab view>, funding: { method, amountMinor, state, walletEntryId }, split: { listMinor, discountMinor, couponCode }, newAccount, replayed }`. A replay is 200 |
| `GET /api/v1/pharmacy-assisted/lab-bookings` | `?status&from&to&cursor&limit≤50` | `[booker lab view]`, `pagination: { total, nextCursor }`. Newest first by `createdAt`; cursor `<ms>_<id>` |
| `GET /api/v1/pharmacy-assisted/lab-bookings/:id` | — | booker lab view. 404 `LAB_BOOKING_NOT_FOUND` for any booking this pharmacy did not book (one answer) |
| `GET …/lab-bookings/by-key/:key`, `POST …/by-key/:key/abandon` | — | `{ state: 'used', booking } \| { state: 'abandoned' } \| { state: 'unknown' }` |
| `POST …/lab-bookings/:id/cancel` | `{ reason?, expectedVersion? }` | `{ booking, refundedMinor, alreadyCancelled }` |
| `POST …/lab-bookings/:id/accept-reschedule` | `{ version }` | booker lab view (ASSUMED L7) |

**Errors of the create:**
- 400: `CONSENT_REQUIRED`, `PAYMENT_METHOD_UNAVAILABLE` (card arrives in 2b), `REQUEST_KEY_REQUIRED`, `INVALID_PHONE`,
  `VALIDATION_ERROR`, `ADDRESS_REQUIRED`, `CATALOGUE_ITEM_NOT_AVAILABLE`, `VISIT_MODE_NOT_SUPPORTED`, `INVALID_COUPON`,
  `COUPON_NOT_FOR_ASSISTED`.
- 404: `LAB_NOT_FOUND`, `BRANCH_NOT_AVAILABLE`, `DEPENDENT_NOT_FOUND`.
- 409: `PRICE_CHANGED` (`details: { priceMinor, listMinor, discountMinor }`), `SLOT_UNAVAILABLE`,
  `INSUFFICIENT_BALANCE`, `WALLET_FROZEN`, `WALLET_INACTIVE`, `WALLET_RECEIVABLE`, `COUPON_EXHAUSTED`,
  `IDEMPOTENCY_KEY_REUSED`, `REQUEST_ABANDONED`.
- 429: `ASSISTED_LIMIT_REACHED`.
- 503: `ASSISTED_BOOKING_DISABLED`, `INDEXES_OUTDATED`, `CUSTOMER_LINKING_UNAVAILABLE`.

**Errors of the cancel:**
- 404 `LAB_BOOKING_NOT_FOUND`.
- 409: `LAB_BOOKING_CHANGED`, `LAB_BOOKING_NOT_CANCELLABLE` (sample collected, visited or later; completed; no-show),
  `CANCELLATION_WINDOW_CLOSED` ("up to 1 hour before the slot"), `NO_SHOW_NOT_REFUNDABLE`.

**Booker lab view (allowlist, raw field names, like §17.2).**

| Shown | Hidden |
|---|---|
| `_id`, `source`, `partnerId`, `lab.name`, `branchId`, `branch.{name, address, phone}`, `visitMode`, `address` (the address the booker typed), `slot`, `items[].{name, kind, code}`, `status`, `statusVersion`, `reschedule.{pending, version, previousSlot, reason, at}`, `collector.name`, `cancellation.{reason, byKind, at}`, `lifecycle` (timestamps), `patientName` (dependent's name, else the link's typed name, else masked), `holder` (§21.2 shape), `userId`, `assisted.{shortRef, bookedBy.name, preferredLanguage}`, `assisted.disputed.state`, `payment: { method, state, payBy }` (as r10c, this booker only), `report.releases[].{file, releasedAt, signer.{name, kind, registrationNumber}}` only while L3 holds, `createdAt`, `updatedAt` | `report.draftFiles`, `report.uploadKeys`, `walletFunding`, `pricing` (except in the create receipt), `settlement`, `noShows[].{by, requestKey, requestHash}`, `collector.{memberId, phone}`, `assisted.{consent, identity, funding, split, referral, requestKey, requestHash, moves}`, `expiry*`, `postPaymentCompletedFor`, `patient.{age, gender}` |

#### 24.4.3 Create flow (new `assisted/labBookings.ts`; mirrors `createPharmacyConsultation`, `consultations.ts:213-391`)

**Before the transaction:**
1. `assertPharmacyLabOn()`.
2. `validate`: consent; method; key; language; phone; `address` required for `home` and refused for `lab`;
   1–20 unique item ids.
3. `assertAssistedLabIndexes(withCoupon)`.
4. Same-content replay by `assisted.requestKey` returns its receipt, uncounted.
5. `hitLookup` + audit `booking.attempted`.
6. Abandoned check on scope `assisted_lab_create:<pharmacyId>:<actorId>`.
7. `assertBookerMayBook`.
8. Lab admission (§24.1 item 12), branch admission (`labBookings.ts:185-190`), items (`:192-197`).
9. `customerPhoneIndexReady`, patient pre-checks (`consultations.ts:267-293`).
10. `couponFor` with `bookingType: 'external_diagnostics'`, `testIds` / `packageIds` (as `labBookings.ts:250-260`), plus
    the assisted rules (`consultations.ts:182-190`).
11. Price fence `acceptedPriceMinor` = Σ `priceMinor` − discount.
12. The split: `baseMinor` = list when the coupon is `platform`-funded, else the paid amount; `providerMinor = baseMinor`;
    `lines` by D4.

**One transaction (`runLedgerTransaction`), in this order:**
1. Replay re-read.
2. `claimRequestKey(scope, key)`.
3. `assertBookerMayBook(s)`.
4. `openOrPrepareAccountIn`, then the family member insert or check.
5. `linkCustomerIn` (PharmacyCustomer, `patient_agreed`, typed name).
6. `countBookingForPhoneIn`.
7. `countPairBookingIn('pharmacy', pharmacyId, 'lab:<partnerId>')`.
8. `redeemCouponIn(…, bookingKind: 'lab_booking', payerKind: 'pharmacy')`.
9. `takeSeat(slotId, { partnerId, branchId, visitMode, minStart: now + 60 min })` (`partners/services/slots.ts:345`).
10. `ensureSettlementAccount('partner', …)`, read before the transaction as today (`labBookings.ts:209`).
11. The insert:
    - `status: 'confirmed'`, `paymentStatus: 'paid'`, `lifecycle.{paidAt, confirmedAt}`, `statusVersion: 0`;
    - `source: 'pharmacy_assisted'`, `assisted` with `funding: { method: 'wallet', payerKind: 'pharmacy', payerId,
      amountMinor, state: 'captured', walletEntryId }`;
    - `patient` snapshot (`kind`, `dependentId`, name = dependent's name or the typed holder name, never the account
      name);
    - `pricing { subtotalMinor, couponCode, discountMinor, payableMinor, commissionMinor: 0 }`;
    - `settlement { …, settlementSystem: 'ledger' }`.
12. When the amount is above 0, `postPharmacyMovementIn({ kind: 'booking_debit', operationKey:
    'assisted_lab:<id>:debit', referenceType: 'assisted_lab_booking', referenceId: '<id>:debit', entryId })`.
13. `auditIn('booking.created', { kind: 'lab_booking', partnerId, branchId, itemCount, amountMinor, method,
    accountCreated, … })`.

**Errors and after commit:**
- A racing identical request answers with its receipt. `ACCOUNT_OPENED_MEANWHILE` retries once (as `:370-377`).
- After commit: the patient notice "<pharmacy> booked a lab test (lab visit / home collection) on <date time>. Ref
  <ref>". *SMS hook: booked.* The lab already sees the row in its list (no lab notice exists today; ASSUMED L18).

#### 24.4.4 Lab side, customer side, cancellations and refunds

| Change point | Rule |
|---|---|
| `partnerView` (`labBookings.ts:152-162`) | For a row with `assisted`: drop `assisted.{funding, split, referral, requestKey, requestHash, consent, moves}`. Keep `source`, `assisted.{shortRef, bookedBy.name, preferredLanguage}`, and add `identityNote: IDENTITY_NOTE` (`assisted/views.ts:13`) |
| `customerView` (`:132-150`), `listForCustomer` (`:938-948`), `getForCustomer` (`:933`) | Assisted rows hide `pricing`, `paymentTransactionId` and the `assisted` money and keys; they add `paidBy` (the booker's name), as `assistedPublicView` does (`assisted/views.ts:56`). Lists leave out rows with an open "not mine" (`notDisputed`, `views.ts:76`) |
| `retryPayment` (`:348`) | An assisted row: 409 `PARTNER_PAID_BOOKING` |
| `cancelIn` (`:453-478`) | When `b.assisted?.funding` exists, it calls the new `settleAssistedLabFundingIn(b, { cause, keepMoney }, s)` **instead of** `undoCouponUsageIn` + `refundAndCloseIn` (`:462-471`). It never touches the customer-wallet ledger. The function mirrors `settleAssistedFundingIn` (`assisted/refunds.ts:43-91`) on `PartnerLabBookingModel`: `reverseRedemptionIn('lab_booking')`; wallet funding → `refund_credit` of the budget, `operationKey: 'assisted_lab:<id>:refund'`, restoring the debit's `lotAllocations`; push the refund row; `funding.state: 'refunded'`; `paymentStatus: 'refunded'`. The refund **always posts** (inactive or frozen wallet, non-operational pharmacy) |
| `customerCancel` (`:480-499`) | Same 2 h window or pending reschedule (`LAB_CANCEL_CUTOFF_MS`, `:41`; D6). An assisted row goes through `cancelIn` with cause `patient`. The notice says the refund went to the partner; a booker notice "Cancelled by the patient" follows |
| `labReject` (`:508-522`) | Full refund to the partner (cause `partner_lab_reject`). The customer notice text drops "back in your wallet" for assisted rows. A booker notice follows |
| `adminCancelMovedNoShow` (`:530-565`) | `refund: true` → the partner is refunded. `refund: false` → `funding.state: 'forfeited'` (as 1a) |
| New `cancelByBooker` (in `assisted/labBookings.ts`) | Own row only (`assistedBookerFilter('pharmacy', id)`, `refunds.ts:28`), status `confirmed`, `assertVersion`, no `noShows` (else `NO_SHOW_NOT_REFUNDABLE`). Allowed while `now ≤ slot.startsAt − 60 min`, or at any time while `reschedule.pending`. `cancellation: { reason: 'partner', byKind: 'booker', by: pharmacyId }`. `countBookerCancellationIn` and the audit in the transaction. A repeat on a cancelled row answers `alreadyCancelled: true` |
| `acceptReschedule` (`:600-613`) | Also callable by the booker (ASSUMED L7), on its own rows, same CAS |
| `postEarning` (`:704-713`) | A row with `earningRule`-equivalent `assisted.split.rule === 'provider_coupon_v2'` earns `split.providerMinor` (`grossMinor: baseMinor`, `commissionMinor: cutMinor` = 0). Customer rows are unchanged. No-show, cancel and reject earn nothing (unchanged) |
| `releaseReport` (`:859-894`) | After the first release of an assisted row: a booker notice "Lab report ready, Ref <ref>" (key `assisted:lab:<id>:report_ready:booker`), no content. *SMS hook: report ready* |
| `labReschedule` (`:570-598`) | An assisted row also tells the booker ("new time proposed"). *SMS hook: cancelled/moved* |
| Admin move and "not mine" (`assisted/review.ts:38`, `:126`) | The lab branch is built as §17.5 already describes: `POST /api/v1/lab-bookings/:id/not-mine` (customer router `partners/routes/index.ts:309`). The move finds the booking in either collection and moves `userId`, `patient` snapshot, `dependentId`, the redemption and the booker link, in one transaction, keyed once per (admin, key) |

**Booker notices.** `audience: 'booker'`, `userId` = the pharmacy id (as `afterAssistedCancel`,
`assisted/pharmacyCommands.ts:310-346`).

#### 24.4.5 Booker report access

`file/access.ts`, `canReadPartnerLabReport` (`:173-182`):
- It selects `assisted.bookedBy`, `report.releases`, `status` too.
- New case `r.userType === 'pharmacy'`, for **released** files only. All of these must hold:
  - `assisted.bookedBy.kind === 'pharmacy'` and `assisted.bookedBy.id === pharmacyOf(r)`;
  - `isOperationalPharmacy` (`assisted/rxAccess.ts:94`);
  - now < first `releasedAt` + 90 days (ASSUMED L3).
- Drafts are never readable by the booker. Other pharmacies get the uniform 404.
- The booker view lists `report.releases` under the same rule, so the screen never offers a file the server would
  refuse.

#### 24.4.6 Switches

| Variable | Effect |
|---|---|
| `ASSISTED_LAB_BOOKING_ENABLED_PHARMACY` (new, off) | The lab list, catalogue and slot reads, and new pharmacy lab bookings. Needs `ASSISTED_BOOKING_ENABLED_PHARMACY` too. Off: 503 `ASSISTED_BOOKING_DISABLED`. Reads, cancel, accept-reschedule, refunds, report access, by-key always work |

#### 24.4.7 Indexes, migrations, deploy order

- `assertAssistedLabIndexes` checks:
  - `PartnerLabBooking {assisted.requestKey}` and `{assisted.shortRef}`;
  - `PharmacyWalletTransaction {pharmacyId, operationKey}`;
  - `RequestKey {scope, key}`;
  - with a coupon, `CouponRedemption {couponCode, bookingKind, bookingId}`;
  - and `assisted_review_items {bookingKind, bookingId}` on "not mine".
- **No migration**: fields are optional, and `source` is derived.
- Order:
  1. deploy (switch off);
  2. `npm run sync-indexes` (new: the three `partner_lab_bookings` indexes);
  3. `ASSISTED_LAB_BOOKING_ENABLED_PHARMACY=true`;
  4. restart.
- Rollback: the switch only. Never roll the code back while an assisted lab booking is open: older code would refund
  the patient's wallet. The check is `db.partner_lab_bookings.countDocuments({ source: 'pharmacy_assisted', status: { $nin: ['completed','cancelled','no_show'] } })` = 0.

#### 24.4.8 Tests (`test/assisted/r11-phase2a.integration.ts`, over HTTP with the real routers)

**Create:**
1. A wallet create gives one debit, one seat, one redemption, `confirmed` / `paid`, `source` and `assisted` stored,
   pharmacy-customer link with the typed name.
2. A replay with the same key is 200 `replayed` and nothing moves. The same key with other items is 409. An abandoned
   key never books.
3. **Race:** 5 concurrent identical creates give one booking, one debit and one seat.
4. **Race:** two different creates for the last seat: one wins; the other answers 409 `SLOT_UNAVAILABLE` and nothing is
   debited or counted.
5. **Race:** two creates that each fit the balance alone but not together: one is 409 `INSUFFICIENT_BALANCE`, and the
   balance never goes negative.
6. An unverified, suspended or `clinic`-kind partner, an inactive branch, a disabled item, or a visit mode not offered
   is refused before any account is opened, with the same answer for a known and an unknown number.
7. A per-user coupon is refused (`COUPON_NOT_FOR_ASSISTED`). A provider-funded coupon gives a split with lines summing
   to the base. `PRICE_CHANGED` when the price moves.

**Cancellations:**

8. Booker cancel at slot − 61 min refunds; at slot − 59 min it is 409 `CANCELLATION_WINDOW_CLOSED`; at slot − 10 min
   with a pending lab reschedule it refunds.
9. **Race:** a booker cancel against a patient cancel gives one refund, one redemption reversal and one seat release.
10. **Race:** a booker cancel against a lab `visit` / `collect`: exactly one wins, and money never moves after the
    visit.
11. Patient cancel inside 2 h is refused. Outside it, the refund goes to the pharmacy wallet, the customer wallet is
    unchanged, and the booker gets a notice.
12. A lab reject refunds the pharmacy, not the customer. An admin moved-no-show cancel with `refund: false` → `forfeited`.
13. A refund to an inactive or frozen pharmacy wallet, or for a non-operational pharmacy, still posts.

**Earnings, reads and access:**

14. Completion posts `split.providerMinor` once. A no-show posts nothing and refunds nothing.
15. Customer reads hide `pricing` and show `paidBy`. Pay-again answers 409 `PARTNER_PAID_BOOKING`.
16. Pharmacy B gets 404 on pharmacy A's lab booking, its by-key, its cancel and its report file.
17. The booker reads a released report:
    - not a draft;
    - not once the pharmacy is unverified;
    - not after 90 days (clock).

    The patient still reads it.
18. The lab view hides funding, split and keys, and shows `bookedBy.name` and the identity note.

**Review queue and reconciliation:**

19. "Not mine" on a lab row hides it from the holder's list and queues it. The admin move moves `userId`, the patient
    snapshot and the redemption; the old holder gets 404.
20. Reconciliation flags a cancelled-but-unrefunded assisted lab row and stays clean on a correct one.

#### 24.4.9 Web screens

**Pharmacy:**
- **Book a lab test.** A wizard: patient (reuses the lookup); lab list (nearby badge); branch; tests (search,
  multi-select, TAT, preparation); visit mode; home address; slot; price summary (list, coupon, pay); consent tick;
  wallet balance and "Pay from wallet".
- **Lab bookings.** A list: Ref, patient name, lab and branch, slot, status, badges (reschedule proposed, report ready,
  cancelled by patient, reported not mine).
- **Lab booking detail.** Timeline; the proposed new time with Accept / Cancel; Cancel (shows the 1 h cut-off and
  "refund to your wallet"); report download while allowed.

**Patient app** (lab booking): "Booked and paid by <pharmacy>"; cancel note "the refund goes to <pharmacy>"; "This isn't
mine".

**Lab workspace:** booking row and detail show "Booked by <pharmacy>", Ref, "Identity attested by the partner, not
verified".

**Admin:** the review queue and move tool accept lab rows; reconciliation shows lab rows.

### 24.5 Round 2b: pharmacy → lab test by card/UPI

#### 24.5.1 Data model

- **Payment context `assisted_lab_booking`**, added to:
  - `PaymentContext` (`payment/types/index.ts:2`) and the model enum (`payment/model/index.ts:21`);
  - the receipt code `'al'` (`payment/services/index.ts:552-566`);
  - verification ownership (`:786-792`: `payerPharmacyId` matches);
  - the recovery sweep context list (`:2019`).
- **The record:** `contextId` = the lab booking; `userId` = `payerUserId` = the booker actor; `payerPharmacyId`; no
  `couponCode`.
- **`assisted_card_refunds`** (`assisted/model/index.ts:133-201`): new `bookingKind: 'booking' | 'lab_booking'`.
  - Rows from before carry none and are read as `booking`.
  - `syncBookingRow` (`assisted/cardRefunds.ts:52-57`) picks the model by `bookingKind`.
  - `queueCardRefundIn` / `queueExtraCaptureRefundIn` (`:64`, `:100`) take `bookingKind`.
- **Lab booking:** a card row is inserted `status: 'pending_payment'`, `paymentStatus: 'pending'`, `paymentDeadline` =
  now + 30 min (`LAB_PAYMENT_WINDOW_MS`, `:29`), `funding: { method: 'razorpay', state: 'pending', paymentRecordId }`
  (chosen before the insert, as `consultations.ts:309`).

#### 24.5.2 Routes and answers

- `POST /api/v1/pharmacy-assisted/lab-bookings` with `paymentMethod: 'razorpay'` answers as §23.3: `funding.paymentTransactionId`,
  and `payment: { paymentRequired, paymentTransactionId, razorpayOrderId, razorpayKeyId, amount, amountMinor, currency,
  payBy }`.
  - 400 `NOTHING_TO_PAY`; 429 `limit: 'pending_card_bookings'`; 502 `RAZORPAY_ORDER_CREATION_FAILED`; 503
    `RAZORPAY_NOT_CONFIGURED`.
- `POST /api/v1/payments/verify` and `/reconcile` (pharmacy token) → `{ context: 'assisted_lab_booking', paymentRecord,
  entity: <booker lab view> }`. Codes as §23.3, including `PAYMENT_DISPUTED` and `DUPLICATE_PAYMENT_REFUNDED`.
- The cancel gains `refundTo?: 'card' | 'wallet'` (as §23.3). The answer adds `refund`.
- The booker lab view `payment` adds `razorpayOrderId` / `razorpayKeyId` while it waits (r10d).

#### 24.5.3 Money

**New `assisted/labCardPayments.ts`** (pattern `assisted/cardPayments.ts`):
- `openLabCardOrder`;
- `applyAssistedLabCapture`: one transaction, CAS `pending_payment` / `pending` / `funding.state: 'pending'` → `confirmed`
  / `paid` / `captured`, `statusVersion + 1`, audited `booking.paid`;
- `settleOtherAssistedLabCaptures`;
- registered with `registerPaymentContextHandler('assisted_lab_booking', …)` beside `registerAssistedPayments`
  (`src1/routes/index.ts:16`).

**Rules:**
- **Late capture:** the booking is cancelled or expired, the lab is no longer verified and active, the record is wrong,
  or the amount is wrong. The capture goes back to the card in the same transaction (`late_capture`), and the booking is
  never revived (C9 for labs).
- **Extra captures:** as r10e. The other-capture sweep (`cardPayments.ts:205`) includes the new context.
- **Follow-up claim:** the patient notice after confirmation, with the claim lease (r10d item 12) on
  `assisted.followUpLeaseUntil`.

**Expiry:**
- `expireDue` (`labBookings.ts:412-437`) reconciles context `assisted_lab_booking` for assisted rows.
  `reconcileContextPayments` (`payment/services/index.ts:2111`) is called with the row's context.
- `expireUnpaid` (`:389-409`) and `fenceRecords` (`:442-447`) take the context. An assisted row goes through
  `settleAssistedLabFundingIn`: `not_paid`, redemption reversed, seat released, `countBookerCancellationIn` (r10b
  item 2).
- No customer notice for an expiry (C7).

**Cancel:**
- Booker, patient, lab and admin cancels queue the card refund row in the cancel transaction.
- Card by default. The wallet only on the booker's own cancel with `refundTo: 'wallet'` (C2), non-withdrawable (C3).
- A row cancelled before its capture was applied refunds nothing (`not_paid`).

**Visibility of unpaid card rows** (never confirmed, `lifecycle.confirmedAt` absent): the booker's alone, as r10b item 3
and r10d item 11.
- Left out of `listForCustomer` and `listForPartnerPage` / `listForPartner` (`:964`, `:1001`).
- 404 on customer and lab reads and steps (`scopedBooking`, `:925-931`; `ownBooking`, `:918`).

**Pending cap:** `assertPendingCardRoomIn` (`assisted/limits.ts:141`) counts pending card rows of the booker in **both**
collections (ASSUMED L21).

**Admin:**
- The card-refund queue, recheck, mark-failed, to-wallet and `assisted-payments/:id/chargeback`
  (`assisted/routes/phase1a.ts:46-55`) work for lab rows unchanged. `recordCardChargeback` reads the lab booking when
  `context` is `assisted_lab_booking`.
- Stuck money adds pending lab card rows past deadline + 1 h.

#### 24.5.4 Switches, indexes, deploy

- **Switches.** Card lab bookings need `ASSISTED_CARD_PAYMENT_ENABLED` **and** `ASSISTED_LAB_BOOKING_ENABLED_PHARMACY`.
  Verify, reconcile, sweeps and refunds always run.
- **Indexes.** `assertUniqueIndex(AssistedCardRefundModel, { captureKey: 1 })` on the card create. New non-unique index
  `assisted_card_refunds {bookingKind, bookingId}`.
- **Migration:** none.
- **Order:** deploy → `sync-indexes` → nothing more to switch if card is already on (test on stage with the lab switch
  first).
- **Rollback:** switches only. Never roll the code back while a lab card row is `pending_payment` or a refund row is
  `pending`.

#### 24.5.5 Tests (`test/assisted/r11-phase2b.integration.ts`)

1. Card create: the row is pending, one record, the seat held, no debit, the patient sees nothing, the lab sees
   nothing.
2. Verify → `confirmed` / `paid`, the patient notice once.
3. **Race:** verify, reconcile and the sweep at once give one confirmation and one notice.
4. Expiry after 30 min: seat released, redemption reversed, `not_paid`, booker cancellation counted. A capture after
   that becomes one `late_capture` refund to the card.
5. **Race:** expiry against capture: either confirmed or expired-and-returned, never both.
6. A second capture on the same order is one `extra_capture` refund (r10e).
7. Booker cancel `refundTo: 'wallet'` gives a wallet credit with no lot, never a card refund. A patient cancel gives a
   card refund row. A refund row syncs onto the lab booking's `assisted.funding.refunds`.
8. A capture after the lab was unverified → late capture.
9. The pending cap counts consultations and lab bookings together.
10. Another pharmacy's verify answers 404 `PAYMENT_RECORD_NOT_FOUND`.

#### 24.5.6 Web screens

- **Pharmacy:**
  - "Pay by card/UPI" on the lab wizard, using Razorpay Checkout;
  - a "Waiting for payment" badge with Pay now and the time left;
  - the refund choice (card / wallet, with the non-withdrawable warning) on cancel;
  - the refund status row.
- **Admin:** card refund queue rows show "lab booking".

### 24.6 Round 2c: lab front desk (the lab's own tests, paid at the lab)

#### 24.6.1 Data model

**`partners/model/labBooking.ts`.**

| Field | Change |
|---|---|
| `source` | `'lab_desk'` |
| `desk` (new) | `{ memberId, branchId, requestKey, requestHash, arrivedAt?, consent: { method: 'partner_attested', statementVersion, statementLanguage, at, actorId }, preferredLanguage, payAtLab: true }`, typed sub-schema |
| `settlement.settlementSystem` (`:136`) | enum `['ledger', 'lab_desk']`. Desk rows use the lab's own `partner` account (harmless) and `'lab_desk'` |
| `paymentDeadline` (`:159`) | `required` only when `settlement.settlementSystem === 'ledger'` (function form). Desk rows store none |
| `slotSnapshot` (`:74-83`) | adds `walkIn: Boolean`. `slotId`, `date`, `startTime` and `endTime` are required unless `walkIn: true`. `startsAt` is always required (walk-in = arrival time) |
| `paymentStatus` | stays `pending` on desk rows (never `paid`) |

**Indexes:** `{ 'desk.requestKey': 1 }`, unique, partial string; `{ partnerId: 1, source: 1, createdAt: -1 }`.

**New `assisted/model` collection `assisted_links`** (§17.4): `{ bookerKind: 'lab' | 'doctor', bookerId, userId,
typedName, consent: 'patient_agreed', consentRecordedAt, consentRecordedById, createdAt, updatedAt }`.
- Index: unique `{bookerKind, bookerId, userId}`.
- Written in the desk transaction (and in 2e) with the first typed name, never overwritten by a later booking (as
  `linkCustomerIn`, `consultations.ts:412-426`).

**Q2 invoice** (`partners/model/invoice.ts:51-52`, `:88-89`):
- adds `labBookingId` and `openLabBookingId`;
- index: unique partial `{openLabBookingId}`, plus `{partnerId, labBookingId, issuedAt: -1}` partial;
- the cancel `$unset` in `partners/repository/invoice.ts:43` also clears `openLabBookingId`.

**User source.** `User.createdSource` (`user/model/index.ts:163`) and the resolver union
(`partners/services/customerResolver.ts:64`) add `'lab_desk'`.

#### 24.6.2 Routes (partner workspace, `registerWorkspaceRoutes`, `partners/routes/index.ts:141`; also mirrored for admins)

Every route checks that the actor's partner is `kind: 'lab'` (a `labOf(actor)` like `clinicOf`,
`partners/services/clinic.ts:56`); otherwise 403 `LAB_PARTNER_REQUIRED`. Permission: `bookings.manage` (ASSUMED L13).

| Route | Request | Answer |
|---|---|---|
| `POST /api/v1/partner-workspace/lab-desk/patients/lookup` | `{ phone }` | `{ exists, holderNameMasked }`. Org key `lab:<partnerId>`, the same hourly limit, audited (`recordPartnerAudit`) |
| `POST /api/v1/partner-workspace/lab-desk/bookings` | `{ requestKey, phone, patient, holderName?, consent, preferredLanguage, branchId, visitMode: 'lab'\|'home', slotId? , itemIds[1..20], address? , collector?: { memberId? , name, phone? }, acceptedTotalMinor, notes? }` | 201 `{ booking: partnerView, patient: { name }, newAccount, replayed }` |
| `GET …/lab-desk/bookings/by-key/:key`, `POST …/by-key/:key/abandon` | — | Q13 shape. Desk member's own keys, branch still in scope |
| `POST …/lab-desk/bookings/:id/cancel` | `{ reason, expectedVersion? }` | `{ booking }`. Desk rows only, while `confirmed`; seat released (not for walk-ins); nothing refunded |
| `POST /api/v1/partner-workspace/invoices` (existing) | adds `labBookingId?` | as today |

**Slots and admission:**
- **`slotId`:** required for `home`. Optional for `lab`; absent = walk-in (`slot: { walkIn: true, startsAt: now }`,
  `desk.arrivedAt: now`, no seat).
- **With `slotId`:** `takeSeat(slotId, { partnerId, branchId, visitMode, minStart: now })`. The desk may book a slot
  starting now; the 60-minute lead is for online bookings only.
- **Branch:** in the actor's scope (`assertBranchInScope`, `partners/services/index.ts:71`), active, offering the
  visit mode.
- **Items:** this partner's own active items only (`CatalogueItemModel` with `partnerId: actor.partnerId`). A lab never
  books another lab.
- **`acceptedTotalMinor`:** the fence on Σ `priceMinor` (409 `PRICE_CHANGED`). The lab bills its own price; no coupon
  on desk rows.

**Errors:**
- 400: `CONSENT_REQUIRED`, `REQUEST_KEY_REQUIRED`, `INVALID_PHONE`, `ADDRESS_REQUIRED`, `SLOT_REQUIRED` (home),
  `CATALOGUE_ITEM_NOT_AVAILABLE`, `VISIT_MODE_NOT_SUPPORTED`, `COLLECTOR_NOT_MEMBER`.
- 403: `LAB_PARTNER_REQUIRED`, `BRANCH_SCOPE_EXCEEDED`.
- 404: `BRANCH_NOT_AVAILABLE`, `DEPENDENT_NOT_FOUND`.
- 409: `SLOT_UNAVAILABLE`, `PRICE_CHANGED`, `IDEMPOTENCY_KEY_REUSED`, `REQUEST_ABANDONED`.
- 429: `ASSISTED_LIMIT_REACHED` (`lookups`, `new_accounts`).
- 503: `ASSISTED_BOOKING_DISABLED`, `INDEXES_OUTDATED`, `CUSTOMER_LINKING_UNAVAILABLE`.

#### 24.6.3 Flow

**Order** (as §24.3, with the desk scope `lab_desk_create:<partnerId>:<memberId>`):
- replay by `desk.requestKey` (stored `desk:<memberId>:<key>`);
- `hitLookup('lab:<partnerId>')`, abandoned check, admission;
- one transaction: claim, account (`countNewAccountIn`), family member, `assisted_links` row, `takeSeat` (not for
  walk-ins), insert (`status: 'confirmed'`, `statusVersion: 0`, `lifecycle.confirmedAt`, `pricing` snapshot with
  `commissionMinor: 0`, `collector` when given for home), audit `lab_desk.booked`.
- No `countBookingForPhoneIn` (ASSUMED L14).
- After commit: patient notice "Booked at <lab>, pay at the lab". *SMS hook: booked.*

**§5.5 guards:**

| Guard | Change point |
|---|---|
| Pay-again, wallet or gateway on a desk row → 409 `PAY_AT_LAB` | `retryPayment` (`labBookings.ts:348`) and `resume` (`:267`) |
| The expiry sweep skips desk rows | `expireDue` query (`:413-416`) adds `'settlement.settlementSystem': 'ledger'`. Desk rows are never `pending_payment` anyway |
| No earnings or cuts | `postEarning` (`:704`) returns when `settlementSystem !== 'ledger'` |
| A customer cancellation refunds nothing | `customerCancel` (`:480-499`): a desk row is cancellable while `confirmed` (no 2 h rule, nothing captured), with no refund; notice to the desk member who booked (ASSUMED L12) |
| Lab reject / admin cancel | a desk row cancels with no money (`cancelIn` skips the refund for `lab_desk`) |
| Both payout systems exclude it | no ledger entry is ever posted. Reconciliation skips `lab_desk` |
| No-show | unchanged for slot rows (nothing refunded). Walk-ins are already arrived: `markNoShow` refuses `slot.walkIn` (409 `WALK_IN_ARRIVED`) |
| Walk-in steps | `markVisited` (`:630`) allowed at once. `labReschedule` (`:570`) refuses walk-ins (409 `WALK_IN_NOT_RESCHEDULABLE`) |
| Home collection | `assignCollector` (`:617`) unchanged. `markCollected` unchanged |

**Q2 bill link** (`partners/services/invoice.ts`):
- a new `admitLabBooking(actor, data, customerUserId, s)` mirrors `admitAppointment` (`:108-133`):
  - desk row of this partner, branch in scope and equal to the bill's branch;
  - the bill's customer = the booking's account (409 `LAB_BOOKING_CUSTOMER_MISMATCH`);
  - not cancelled (409 `LAB_BOOKING_CANCELLED`);
  - no open bill (409 `LAB_BOOKING_ALREADY_BILLED`).
- It is called before and inside the bill transaction (`:358`, `:411`). The insert sets `labBookingId` and
  `openLabBookingId` (`:426`). The 11000 race maps to `LAB_BOOKING_ALREADY_BILLED` (`:442`).
- A bill may carry `appointmentId` or `labBookingId`, not both (400 `VALIDATION_ERROR`).
- Online (Jansetu-paid) lab bookings cannot be linked: 404 `LAB_BOOKING_NOT_FOUND` (ASSUMED L10).
- The lab view adds `bill: { invoiceId, serial, lifecycleState } | null` (like `billsForAppointments`, `:159`).
- The patient already sees the bill under `/bills`.

**Patient views.**
- A desk row shows `payAtLab: true`, the lab and branch, `pricing` (the lab's price, informational), and the bill
  link.
- The report goes to the patient app through the existing `releaseReport` grant (`:892`). *SMS hook: report ready.*

#### 24.6.4 Switches, indexes, deploy

- **Switch:** `LAB_DESK_ENABLED` (new, off): lookup and create. Off → 503. Desk cancel, steps, reports and bills always
  work.
- **Indexes:** `assertUniqueIndex` on:
  - `PartnerLabBooking {desk.requestKey}`;
  - `RequestKey {scope, key}`;
  - `assisted_links {bookerKind, bookerId, userId}`;
  - and, on a linked bill, `PartnerInvoice {openLabBookingId}`.
- **Migration:** none.
  - The `required` change to `paymentDeadline` and slot fields loosens validation only.
  - The enum widening needs no data change.
- **Order:** deploy → `sync-indexes` → `LAB_DESK_ENABLED=true` → restart.
- **Rollback:** the switch. Older code cannot read desk rows safely (it would require `paymentDeadline` on save), so
  never roll the code back while desk rows are open.

#### 24.6.5 Tests (`test/assisted/r11-phase2c.integration.ts`)

**Create and replay:**
1. Walk-in lab visit: no seat; `walkIn`; `arrivedAt`; `settlementSystem: 'lab_desk'`; `paymentStatus: 'pending'`;
   `assisted_links` typed name; the patient sees it with `payAtLab`.
2. Scheduled lab visit and home collection: seat taken, the home address is required, the slot is required for home.
3. **Race:** two identical creates give one row and one seat. Same key with other content → 409.
4. Another lab's item, or a branch outside scope → refused. A `clinic`-kind partner → 403. An unverified lab → 403
   (`PARTNER_NOT_VERIFIED`).

**Guards:**

5. Pay-again → 409 `PAY_AT_LAB`. The expiry sweep never touches a desk row (clock past 30 min). Completion posts no
   ledger entry. A payout run sees nothing.
6. Patient cancel of a desk row refunds nothing (both wallets unchanged) and releases the seat once. **Race:** patient
   cancel against lab `visit`.

**Bills and reports:**

7. A bill with `labBookingId` links once. **Race:** two bills for one desk booking: one wins, the other gets 409
   `LAB_BOOKING_ALREADY_BILLED`. A cancelled bill frees the link. A pharmacy-paid row cannot be billed. The wrong
   customer → 409.
8. A released report is readable by the patient; another lab's member gets 404.
9. Walk-in: no-show and reschedule refused.

#### 24.6.6 Web screens

**Lab workspace:**
- **Front desk → New booking.** Phone lookup (masked name); patient (self or family member); consent tick; language;
  branch; visit type (walk-in now, lab slot, home collection); tests with total; address and home slot; collector
  (optional); "Pay at the lab" note.
- **Desk booking detail.** Steps (visited / collected / processing / reports); "Create bill" (pre-filled with the tests);
  bill status; cancel.
- **Lab bookings list.** A source filter (online, pharmacy, desk) and the bill badge.

**Patient app:** a desk lab booking shows "Pay at the lab", the bill and the report.

### 24.7 Round 2d: lab wallet

#### 24.7.1 Decision: a parallel store for labs (and later doctors); the pharmacy store is untouched

§5.3 already chose this; the code confirms it.
- The pharmacy store keeps legacy rupee fields, a legacy `transactionType` enum, a mixed sign history and an
  ObjectId-typed `pharmacyId` (`pharmacyWallet/model/index.ts:25-85`).
- It holds live balances on stage, and its ledger carries the 1a–r9b review fixes (for example the r9b item 4 id-spelling fix). Changing
  its key or collection for labs would put live money at risk for no gain.

So:
- **New module `partnerWallets`**:
  - `partner_wallets { ownerKind: 'lab' | 'doctor', ownerId, balanceMinor ≥ 0, withdrawableMinor, receivableMinor ≥ 0,
    frozen, frozenReason?, isActive, version, createdAt, updatedAt }`;
  - `partner_wallet_entries { walletId, ownerKind, ownerId, kind: 'credit' | 'booking_debit' | 'refund_credit' |
    'chargeback' | 'receivable_setoff' | 'adjustment', amountMinor (signed), balanceAfterMinor,
    withdrawableDeltaMinor, receivableDeltaMinor, operationKey, referenceType, referenceId, description, notes?,
    lotAllocations?, requestHash?, actor?: { kind: 'admin' | 'member', id }, at }`.
- **Lots stay shared.** `wallet_topup_lots` already allows `walletRef.kind: 'lab'` (`pharmacyWallet/model/lots.ts:30`).
  The lot helpers `withdrawableOfIn`, `consumeLots` and `restoreLots` (`pharmacyWallet/ledger.ts:63-97`) move to
  `pharmacyWallet/walletLots.ts` with a `walletRef` parameter. The pharmacy ledger calls them with `{ kind: 'pharmacy' }`.
  This is a pure move; the 1a/1b suites are the regression check.
- **`postPartnerMovementIn(m, s)`** (`partnerWallets/ledger.ts`) has the exact contract of `postPharmacyMovementIn`
  (`pharmacyWallet/ledger.ts:99-150`):
  - exactly once per `(walletId, operationKey)`;
  - wallet read and CAS on `version` in the transaction;
  - debits refused when frozen, inactive, short (409 `INSUFFICIENT_BALANCE`) or owing (`WALLET_RECEIVABLE`);
  - credits always post, the receivable cleared first;
  - lots consumed oldest first (D9);
  - `withdrawableMinor` recomputed.
- **One dispatcher** `postBookerMovementIn({ payerKind, payerId, … })` in `assisted/bookerWallet.ts` routes `pharmacy`
  to the pharmacy ledger and `lab` / `doctor` to the partner ledger. Every assisted caller uses it from 2e on:
  - `consultations.ts:362`;
  - `refunds.ts:71-79`;
  - `cardRefunds.ts:78`, `:281`;
  - the 2a lab writers.

#### 24.7.2 Payments

- **`PaymentRecord`** gains `payerPartnerId` and `payerMemberId` (`payment/types/index.ts:9`, `:54`, `:82`; model
  `payment/model/index.ts:15`), and an index `{ payerPartnerId: 1, createdAt: -1 }` (partial string).
- **Top-up order.** `context: 'wallet_recharge'`, `contextId: lab_<partnerId>_<ms>`, `notes.flow: 'lab_wallet_recharge'`,
  `userId` = `payerUserId` = `payerMemberId` = the member, `payerPartnerId`. This mirrors
  `pharmacyWallet/services/index.ts:83-95`.
- **Credit.** `isPartnerWalletRecharge` next to `isPharmacyWalletRecharge` (`payment/services/index.ts:1615-1621`). A
  credit like `ensurePharmacyWalletRechargeTransaction` (`:1623-1700`):
  - the same `walletCreditedAt` claim;
  - refuses `chargebackAt` and `compensatedAt` records;
  - `operationKey: 'wallet_recharge:<recordId>'`;
  - a lot with the Razorpay fee while `ASSISTED_BOOKING_ENABLED_LAB` is on and the lot index exists (otherwise
    non-withdrawable, as `rechargeLotsWritable`, `:79-82`).
  - Reached from `processWalletRechargePayment` (`:1882`), the entity read (`:1161`) and `verifyPaymentAndProcess`
    (`:2128`).
- **Verification by organisation.** The generic `/api/v1/payments` router refuses partner tokens
  (`src1/routes/index.ts:99`), so the partner workspace mounts:
  - `POST /api/v1/partner-workspace/assisted/payments/verify`;
  - `POST /api/v1/partner-workspace/assisted/payments/reconcile`.

  These call the same service with `requesterUserType: 'partner'` and `requesterPartnerId`.
  `getPaymentRecordForVerification` (`:763-800`) admits a partner requester when `payerPartnerId` = the member's partner
  and the member holds `wallet.manage` (top-ups) or `assisted.book` (bookings, 2e).
- **Recovery sweep.** `:2020` adds `{ context: 'wallet_recharge', 'notes.flow': 'lab_wallet_recharge', createdAt:
  { $gte: WALLET_RECHARGE_SWEEP_FROM } }`. The uncredited-top-ups list (`assisted/reconciliation.ts:108`) covers lab
  top-ups.

#### 24.7.3 Routes

**Partner workspace** (member guards). Permissions `wallet.view` and `wallet.manage` are added to `PartnerPermission`
and `ALL_PERMISSIONS` (`partners/types/index.ts:43-69`); owners hold all.

| Route | Guard | Request → answer |
|---|---|---|
| `GET /api/v1/partner-workspace/assisted/wallet` | `wallet.view` | `{ balanceMinor, withdrawableMinor, receivableMinor, frozen, isActive, updatedAt }` (no wallet yet: zeros, nothing created) |
| `GET …/assisted/wallet/entries` | `wallet.view` | `?cursor&limit≤50` → `[{ _id, kind, amountMinor, balanceAfterMinor, description, referenceType, referenceId, at }]`, `nextCursor` |
| `POST …/assisted/wallet/topups` | `wallet.manage` | `{ amountMinor (≥ 100), requestKey }` → `{ paymentTransactionId, razorpayOrderId, razorpayKeyId, amountMinor, currency, replayed }`. Scope `wallet_topup:lab:<partnerId>:<memberId>`; a replay answers the same order |
| `POST …/assisted/wallet/topups/:paymentTransactionId/check` | `wallet.view` | `{ state: 'credited' \| 'unpaid', wallet }`. Any active member of that partner, operational or not (as §19.8 item b) |
| `POST …/assisted/payments/verify`, `/reconcile` | as above | as §23.3, `entity` = the wallet |

**Admin** (`adminAssistedRouter`, `assisted/routes/phase1a.ts:27`; admin tools switch for the writes):

| Route | Answer |
|---|---|
| `GET /api/v1/admin/labs/:partnerId/wallet`, `/wallet/entries`, `/wallet/lots` | wallet view; entries; lots |
| `POST /api/v1/admin/labs/:partnerId/wallet/topup` | `Idempotency-Key` header required; `{ amountMinor, notes? }` → wallet view. Non-withdrawable; `operationKey: 'admin_topup:<key>'` with `requestHash` (§20.6 item 4) |
| `GET /api/v1/admin/labs/:partnerId/wallet/topups/by-key/:key` | §21.3 shape |
| `PUT /api/v1/admin/labs/:partnerId/wallet/freeze` | `{ frozen, reason }` |
| `POST /api/v1/admin/wallet-lots/:lotId/chargeback` (existing) | Routed by `lot.walletRef.kind`. Today it refuses non-pharmacy lots (`pharmacyWallet/ledger.ts:177`); a lab lot gets the same chargeback on the partner ledger (closed lot, debit to 0 at most, receivable, freeze) |
| `POST /api/v1/admin/wallet-payments/:paymentId/chargeback` and `/close-compensated` (existing) | Accept lab top-ups (`notes.flow: 'lab_wallet_recharge'`), with the same rules as `recordPaymentChargebackIn` and `closeTopupCompensatedIn` (`pharmacyWallet/ledger.ts:288`, `:356`) |

#### 24.7.4 Switches, indexes, deploy

- **Switch:** `ASSISTED_BOOKING_ENABLED_LAB` (new, off): lab top-ups with lots, and (2e) lab assisted consultations.
  Off → 503 on top-up creation.
  - Verify, reconcile, check and the sweep always run, so a paid top-up is always credited.
  - Admin reads always work.
- **Indexes:**
  - `partner_wallets {ownerKind, ownerId}` unique, `{frozen}`;
  - `partner_wallet_entries {walletId, operationKey}` unique, `{ownerKind, ownerId, at: -1}`;
  - `payment_records {payerPartnerId, createdAt}`.

  `assertUniqueIndex` on the first two and on `wallet_topup_lots {paymentRecordId}` before every write; 503
  `INDEXES_OUTDATED`.
- **Reconciliation.** `walletInvariants` (`assisted/reconciliation.ts:35-57`) also checks partner wallets: balance = Σ
  entries; withdrawable = Σ eligible lots; receivable ⇒ frozen.
- **Migration:** none (new collections).
- **Order:** deploy → `sync-indexes` → `ASSISTED_BOOKING_ENABLED_LAB=true` → restart.
- **Rollback:** switch off. Never roll the code back while a lab top-up record is `created` or captured-but-uncredited.

#### 24.7.5 Tests (`test/assisted/r11-phase2d.integration.ts`)

**Top-ups:**
1. Top-up → verify → credit once, with a lot holding the fee.
2. **Race:** verify, reconcile, check and the sweep at once give one credit.
3. A replay of the top-up key gives the same order. Another amount with the same key → 409.
4. A staff member without `wallet.manage` → 403. Another lab's record → 404. A pharmacy token on the partner verify →
   403.

**Ledger:**

5. **Race:** two debits beyond the balance (direct ledger test): one succeeds, the balance never goes negative.
6. A credit to a frozen or inactive wallet posts. A debit is refused.

**Chargebacks:**

7. Lot chargeback on a lab lot: closed, debit to 0, receivable, frozen. The next credit sets the receivable off first.
8. Payment chargeback and close-compensated on a lab top-up: one of (credited and charged back) or (blocked, never
   credited).

**Regression and reconciliation:**

9. Pharmacy regression: all 1a/1b suites pass unchanged after the lot-helper move.
10. Reconciliation: clean, then a tampered entry is flagged.

#### 24.7.6 Web screens

- **Lab workspace → Wallet.** Balance, "card money" (withdrawable, labelled "withdrawals coming later"), frozen or owing
  banner, entries list, "Top up" (amount, then Razorpay Checkout, then verify; "Check" for a lost answer).
- **Admin → Lab wallet.** Balance, entries, lots, freeze, admin top-up with the by-key check, chargeback and
  close-compensated buttons.

### 24.8 Round 2e: lab → doctor consultation

#### 24.8.1 Generalising the pharmacy flow (no new pattern)

| Change point | Today | Phase 2e |
|---|---|---|
| `PharmacyActor` (`assisted/consultations.ts:58`) | pharmacy only | `BookerActor = { kind: 'pharmacy', pharmacyId, actorId } \| { kind: 'lab', partnerId, memberId, branchId }` |
| `storedAssistedKey`, `assistedKeyScope`, `orgKey` (`:84-86`) | `pharmacy:` | `assisted:<kind>:<orgId>:<actorId>:<key>`; scope `assisted_consult_create:<kind>:<orgId>:<actorId>` (the pharmacy strings stay byte-identical); org key `lab:<partnerId>` |
| `createPharmacyConsultation` (`:213-391`) | one booker | `createAssistedConsultation(booker, input)`; the pharmacy route calls it with `kind: 'pharmacy'` |
| `bookedBy` (`:312`) | pharmacy | `{ kind: 'lab', id: partnerId, branchId, actorKind: 'member', actorId: memberId, name: <lab name> }` |
| `Booking.pharmacyId` (`:333`) | always | pharmacy only. Lab rows rely on `assisted.bookedBy` (S2 readers are unaffected: a lab never reads `/bookings`) |
| `source` (`:340`) | `pharmacy_assisted` | `lab_assisted` (the enum already has it, `bookings/model/index.ts:469`) |
| `linkCustomerIn` (`:412-426`) | PharmacyCustomer | labs: the `assisted_links` row of 2c |
| Wallet debit (`:361-364`) | `postPharmacyMovementIn` | `postBookerMovementIn` (2d) |
| Audit (`:239`, `:365`) | `auditIn` (pharmacy) | labs: `recordPartnerAudit(actor, 'assisted.booking_*', …)` in the transaction |
| Card order (`cardPayments.ts:67-76`) | `payerPharmacyId` | lab: `payerPartnerId` + `payerMemberId`, `notes.flow: 'assisted_booking'`, `bookerKind: 'lab'` |
| Capture (`cardPayments.ts:110`) | payer = `payerPharmacyId` | payer = `payerPharmacyId` or `payerPartnerId` by `funding.payerKind` |
| Card refund rows (`assisted/model/index.ts:177`) | `payerKind: 'pharmacy'` | enum `['pharmacy', 'lab', 'doctor']`; admin rows add `payerName` (pharmacy or lab) |
| Refunds (`assisted/refunds.ts:71`) | `payerKind === 'pharmacy'` | any payer, through the dispatcher |
| `cancelBookingSettlement` / `rescheduleWithHolds` (`bookings/holds.ts:391`, `:611`) | `assistedBooker?: 'pharmacy'` | `'pharmacy' \| 'lab'`; `assistedBookerFilter('lab', partnerId)` plus the branch check in the lab command |
| `afterAssistedCancel` (`assisted/pharmacyCommands.ts:310-346`) | booker notice to the pharmacy id | lab: to the booking member (`bookedBy.actorId`, partner notifications are per member, `partners/services/index.ts:781-782`) |
| Doctor list and slots (`pharmacyCommands.ts:206`, `:267`) | pharmacy pincode / city | the member's branch address (`BranchModel.address`); the same eligibility (`isEligibleDoctor`) |
| Meet attendee (`meet/service/index.ts:453-458`) | pharmacy email | lab: the partner's `contact.email` (`partner_device` only) |
| Booker view (`assisted/bookerView.ts:70`, `:148`) | `pharmacyId` | `(bookerKind, bookerId)`; lab names from `assisted_links` (typed, else masked; never the account name) |
| Dispensing copy (`file/access.ts`, `canReadDispensingCopy`, case `pharmacy`) | pharmacy | case `partner`: `assisted.bookedBy.kind === 'lab'`, member of that partner, active, holding `assisted.book`, branch scope covering `bookedBy.branchId`, partner operational and verified, current copy, 90-day window (`rxWindowOpenFor`, `assisted/rxAccess.ts:72`). Full PDF, documents and report: never |
| Medicine order from the prescription | pharmacy | not for labs |

#### 24.8.2 Routes (partner workspace; `assisted.book` + branch scope; `requireOperationalPartner` with `kind: 'lab'`)

| Route | Request → answer |
|---|---|
| `POST /api/v1/partner-workspace/assisted/patients/lookup` | `{ phone }` → `{ exists, holderNameMasked }` |
| `GET …/assisted/doctors`, `GET …/assisted/doctors/:doctorId/slots` | as §20.2 / §21.2, plus `?branchId` (required for members with several branches; must be in scope) |
| `POST …/assisted/consultations` | the §19.3 body plus `branchId` → as §19.3 / §23.3 (`paymentMethod: 'wallet' \| 'razorpay'`) |
| `GET …/assisted/bookings`, `GET …/assisted/bookings/:id` | `?status&from&to&cursor&limit`; rows with `bookedBy.kind = 'lab'`, `id` = the partner, `branchId` in the member's scope → booker view |
| `GET …/assisted/bookings/by-key/:key`, `POST …/abandon` | the member's own keys |
| `POST …/assisted/bookings/:id/cancel` | `{ reason?, expectedUpdatedAt?, refundTo? }` (any time before start) |
| `POST …/assisted/bookings/:id/reschedule` | `{ slotId, requestKey, expectedUpdatedAt? }` (P9) |
| `POST …/assisted/payments/verify`, `/reconcile` | 2d routes; `entity` = the booker view |

`assisted.book` is a new `PartnerPermission`. Owners hold it; it is never granted by migration.

#### 24.8.3 Switches, indexes, deploy

- **Switches:**
  - `ASSISTED_BOOKING_ENABLED_LAB` (2d) gates the lookup, the doctor reads and new lab-made consultations;
  - card additionally needs `ASSISTED_CARD_PAYMENT_ENABLED`;
  - cancel, reschedule, refunds and reads always run.
- **Indexes:** the 1a set (`assertAssistedIndexes`, `consultations.ts:148-154`), with the partner-wallet entry index
  instead of the pharmacy one for lab payers, plus `assisted_links`.
- **Migration:** none.
- **Order:** deploy → `sync-indexes` → owners grant `assisted.book` to staff → restart with the switch on.
- **Rollback:** switch off. Never roll the code back while a lab-made consultation is open.

#### 24.8.4 Tests (`test/assisted/r11-phase2e.integration.ts`)

**Create:**
1. A lab member with `assisted.book` books by wallet: lab wallet debited, `source: 'lab_assisted'`, `bookedBy.branchId`,
   `assisted_links` typed name, no `pharmacyId`, partner audit.
2. A member without the permission, a branch outside scope, or an unverified or suspended lab → refused. An unverified
   doctor → 409 `DOCTOR_NOT_AVAILABLE`.

**Cancel, reschedule and card:**

3. Cancel before start refunds the LAB wallet. A patient cancel refunds the lab. A doctor or admin close refunds the
   lab.
4. **Race:** booker cancel against patient cancel gives one refund. **Race:** two creates on one key give one debit.
5. Card: a member of the same lab other than the booker verifies. A pharmacy cannot. A late capture goes back to the
   lab's card. `refundTo: 'wallet'` credits the lab wallet (non-withdrawable).

**Prescription access and names:**

6. The prescription dispensing copy is readable by a lab member with `assisted.book` in branch scope, within 90 days,
   and not by another branch, a member without the permission, another lab, after 90 days, or once the lab is
   suspended. The full PDF is never readable.
7. The lab-facing name is never the account name (even when a pharmacy has a `customer_order` link).

**Pharmacy regression:**

8. The 1a/1b suites pass unchanged (stored key strings, scopes and answers byte-identical).

#### 24.8.5 Web screens

**Lab workspace:**
- **Book a doctor.** The pharmacy flow: lookup, doctor list nearby to the branch, slots, mode and join, coupon, price,
  consent, pay by wallet or card.
- **Consultations we booked.** A list and a detail: status, Join call, the prescription's dispensing copy for 90 days,
  cancel and reschedule, the refund choice.

**Admin:** card refund and chargeback rows name the lab.

### 24.9 ASSUMED (reversible)

| # | Assumption (safer default) | Where |
|---|---|---|
| L1 | Five rounds 2a–2e instead of three (the code reasons are in §24.2) | §24.2 |
| L2 | Lab and doctor wallets are a new `partner_wallets` store; the pharmacy store is untouched; only the lot helpers are shared (moved, not changed) | §24.7.1 |
| L3 | The booker reads a released lab report for **90 days from its first release**, only while operational; never drafts | §24.4.5 |
| L4 | The booker gets an in-app "report ready" badge with no content | §24.4.4 |
| L5 | Unpaid card lab bookings are hidden from the patient **and the lab** until paid | §24.5.3 |
| L6 | Booker lab cancel: until `slot.startsAt − 60 min`, or any time while a lab reschedule is unanswered; never after sample collection or visit | §24.4.4 |
| L7 | The booker may accept a lab's reschedule proposal for the patient (the patient often has no app) | §24.4.2 |
| L8 | A lab reject or admin cancel of an assisted lab booking refunds the partner in full by method | §24.4.4 |
| L9 | An admin cancel of a moved no-show without refund keeps the money (`forfeited`), as 1a | §24.4.4 |
| L10 | Only desk bookings can be linked to a Q2 bill (online, Jansetu-paid bookings cannot); bill lines are not checked against the booking's tests | §24.6.3 |
| L11 | A desk walk-in is stored `confirmed`, `slot.walkIn: true`, `startsAt` = arrival time, no seat; it cannot be a no-show or be rescheduled | §24.6.3 |
| L12 | The patient may cancel a desk booking from the app while it is `confirmed` (before visit or collection); nothing is refunded through Jansetu; the desk member who booked it is told in-app | §24.6.3 |
| L13 | Permissions: the desk uses `bookings.manage`; lab-made consultations use the new `assisted.book`; the wallet uses `wallet.view` / `wallet.manage` | §24.6.2, §24.7.3, §24.8.2 |
| L14 | Desk bookings count against the lab's lookup and new-account limits, but **not** the 5-a-day per-number assisted limit | §24.6.3 |
| L15 | Labs see only typed or masked names (`assisted_links`), never the real account name | §24.3 |
| L16 | The split stores per-line bases now (`split.lines`, D4), cut 0 on each line, `referral: null` | §24.4.1 |
| L17 | Notices about a lab-made consultation go to the booking member only; the list is visible to members with `assisted.book` in branch scope | §24.8.1 |
| L18 | No new lab notice on a pharmacy booking (the lab sees it in its list, as for customer bookings today) | §24.4.3 |
| L19 | A card refund chosen "to wallet" by a lab is non-withdrawable (C3) | §24.8.4 |
| L20 | Admin top-ups of lab wallets are non-withdrawable and behind the admin tools switch | §24.7.3 |
| L21 | One pending-card cap per booker across consultations and lab bookings | §24.5.3 |
| L22 | SMS: comments at the call sites only; nothing queued | §24.3 |
| L23 | The pharmacy sees the collector's name, not the phone | §24.4.2 |
| L24 | Lab-booking coupons follow the diagnostics rules plus the assisted rules; provider-funded by default (the lab bears it) | §24.4.3 |
| L25 | A lab top-up needs a request key (one order per key); minimum ₹1 | §24.7.3 |

### 24.10 Questions for the owner (only the ones that change what is built)

1. **How long may a pharmacy keep seeing a lab report it booked?** Recommended: 90 days from the report, like
   prescriptions (L3). The patient keeps it for ever.
2. **May the pharmacy accept the lab's "new time" on the patient's behalf?** Recommended: yes. The patient often has no
   app; otherwise the only choice would be to cancel (L7).
3. **May the patient cancel a pay-at-lab desk booking from the app?** Recommended: yes, until the sample is taken or
   the visit is recorded. Jansetu moves no money, and the lab settles any cash itself (L12).
4. **Should lab desk walk-ins count towards the "5 bookings per mobile number per day" limit?** Recommended: no. That
   limit guards partner-paid bookings; the desk is the lab's own counter (L14).

### 24.11 Round 2a build record (r11, 2026-11-23)

Branch `m0/r11-phase2a` from `f81c8f3b` (stage head, r10f) with `m0/r11-phase2-spec` merged. Local commits only. Built:
§24.4 (pharmacy → lab test, pharmacy wallet) with the owner's answers of 23 Nov, which win over §24.4 where they differ:
booker report access **90 days** from release (released only); the booker **may accept** the lab's new time; the patient may
cancel from the app with the refund to the pharmacy; **no blocking limits except the hourly lookups**; cut 0; SMS as
comments; card payment is 2b.

**What was built**

| Area | Where | What |
|---|---|---|
| Model | `partners/model/labBooking.ts` | `source` (enum, derived `self` when missing), `assisted` (Mixed, the §5.1 block without `join`), `cancellation.reason: 'partner'`, `cancellation.byKind: 'booker'`; indexes `{assisted.requestKey}` unique partial, `{assisted.shortRef}` unique partial, `{assisted.bookedBy.kind, assisted.bookedBy.id, createdAt:-1, _id:-1}` |
| Types | `assisted/types.ts` | `AssistedSplit.lines` (D4); refund causes `partner_lab_reject`, `admin` |
| Create, reads, cancel, accept | `assisted/labBookings.ts` (new), `assisted/patient.ts` (new) | §24.4.3 in order; booker lab view (allowlist); list / detail / by-key / abandon; booker cancel (1 h, or any time while a lab reschedule is unanswered); booker accept-reschedule |
| Money on cancel | `assisted/labRefunds.ts` (new), `partners/services/labBookings.ts` `cancelIn` | assisted rows refund the paying pharmacy's wallet once (`assisted_lab:<id>:refund`, lots restored), reverse the redemption once, never touch the customer wallet; refunds always post. Admin no-show cancel without refund → `funding.state: 'forfeited'` |
| Lab side | `partners/services/labBookings.ts` | `partnerView` shows `source`, `assisted.{shortRef, bookedBy.name, preferredLanguage}`, `identityNote`; no funding / split / keys / consent / moves. Reject, reschedule, report release and admin no-show cancel tell the booker (in-app, no content). Completion earns `split.providerMinor` (gross = base, commission = cut = 0) once |
| Customer side | same, `assisted/labViews.ts` (new) | assisted rows hide `pricing`, `paymentTransactionId`, item prices and the `assisted` money/keys, add `paidBy` and the identity line; pay-again 409 `PARTNER_PAID_BOOKING`; patient cancel (2 h window, as before) refunds the pharmacy and tells it ("Cancelled by the patient"); an open "not mine" row leaves the list |
| Report access | `file/access.ts` `canReadPartnerLabReport` | a pharmacy reads a RELEASED report of a lab booking it booked, while operational, until first release + 90 days; drafts never; other pharmacies the uniform 404 |
| Not mine, move, queue | `assisted/review.ts` | `POST /lab-bookings/:id/not-mine`; the review queue lists lab rows (`booking.kind: 'lab_booking'`); dismiss names the right collection; the admin move finds the booking in either collection and moves `userId`, the patient snapshot, the redemption, the booker link and `disputed: moved` in one transaction, once per (admin, key) |
| Reconciliation | `assisted/reconciliation.ts` | `labBookingChecks`: one debit, refund posted once, cancelled-not-refunded, refunded-not-cancelled, split and lines sum, earning once on completion, none on no-show/cancel; the booker cancel-rate alert counts lab rows |
| Switch | `assisted/flags.ts` | `ASSISTED_LAB_BOOKING_ENABLED_PHARMACY` (+ `assertPharmacyLabOn`) |
| Routes | `assisted/routes/phase1a.ts`, `assisted/controller/phase2a.ts` (new), `partners/routes/index.ts` | below |
| Audit | `assisted/model` | new action `booking.reschedule_accepted`; lab rows audit `booking.attempted` / `created` / `cancelled` / `not_mine` / `moved` with `detail.kind: 'lab_booking'` (ids and codes only) |

Check: `test/assisted/r11-phase2a.integration.ts` (26 checks).

**ASSUMED (r11 build, reversible)**

| # | Choice | Why |
|---|---|---|
| B1 | The patient helpers (`openOrPrepareAccountIn`, `assertDependentOfPhone`, the link, `redeemCouponIn`) are **copied** to `assisted/patient.ts`, not moved; `consultations.ts` is untouched | r10g is removing the booking limits inside those functions; unify after it merges |
| B2 | Owner 23 Nov limits: lab creates count only against the hourly lookup limit (as every create). No per-number count, no new-account count, no cancellation block (`assertBookerMayBook`), no cancellation count (it would block consultations). Alert-only: the pharmacy–lab pair alert (subject `lab:<partnerId>`) and the 7-day booker cancel-rate alert (lab rows included) | owner |
| B3 | The 90 days run from the booking's FIRST release, for every file of it (L3) | spec; a file released later shares the window |
| B4 | The patient's view also hides the item prices (`priceMinor`, `mrpMinor`, `gstRate`, `sac`) | the partner's price, as the 1a view hides a consultation's price |
| B5 | Booker notices use the assisted notifier (`referenceType: 'booking'`) with `data.bookingKind: 'lab_booking'`; patient notices use the lab notifier (`partner_lab_booking`) | `support.ts` left alone for the r10g merge |
| B6 | Stored key `assisted_lab:pharmacy:<pharmacy>:<actor>:<key>`, claim scope `assisted_lab_create:<pharmacy>:<actor>` | its own namespace beside consultations |
| B7 | The stored patient name: self → the typed name; known family member → their name; new family member → the typed name. Admin move: the family member's name, else the admin's `holderName`, else the old self name | names rule |
| B8 | 2a rows are wallet-only: the lab refund step refuses any other funding (409 `REFUND_METHOD_UNSUPPORTED`) until 2b adds card refunds | fail closed |
| B9 | The booker's accept tells the patient ("New lab time accepted") | the patient should know the time changed |
| B10 | The patient's cancel answer reports `refunded: 0` for an assisted row | nothing went to the patient |
| B11 | `from` / `to` of the booker list filter the slot date; `nearby` is any active branch on the pharmacy's pincode, else city | as the consultation list and doctor list |
| B12 | The admin lab list (`/partner-workspace/admin/lab-bookings`) keeps the lab view (no funding); reconciliation is the admin's money view | unchanged route |
| B13 | Earnings of an assisted row post only while its funding is `captured` | a refunded or forfeited booking never completes anyway |

**API for the web** (pharmacy token, `requireOperationalPharmacy`; `{ success, data }`, `Cache-Control: private, no-store`)

| Route | Request | `data` |
|---|---|---|
| `GET /api/v1/pharmacy-assisted/labs` | `?visitMode=lab\|home&limit≤100` | `[{ partnerId, name, nearby: 'pincode'\|'city'\|null, branches: [{ branchId, name, address, phone, homeCollection, inLab }] }]` |
| `GET …/labs/:partnerId/catalogue` | `?visitMode` | `[{ itemId, kind, name, code, description, preparation, sampleType, includes, price, priceMinor, mrpMinor, visitModes, reportTatHours }]`; unknown/unverified lab 404 `LAB_NOT_FOUND` |
| `GET …/labs/branches/:branchId/slots` | `?visitMode (required)&from=YYYY-MM-DD&days≤14` | `[{ slotId, date, startTime, endTime, seatsLeft }]` (≥ 60 min ahead); 404 `BRANCH_NOT_AVAILABLE` |
| `POST …/lab-bookings` | `{ requestKey, phone, patient ({relation:'self',name} \| {dependentId} \| {relation,name,gender?,dateOfBirth?}), holderName?, consent:{agreed:true,statementVersion,statementLanguage}, preferredLanguage, partnerId, branchId, visitMode, slotId, itemIds[1..20], address? (home only: {line1,line2?,city,state?,pincode(6 digits),landmark?}), couponCode?, acceptedPriceMinor, paymentMethod:'wallet' }` (r11b: no `notes` — it was never stored or shown; a `notes` key is ignored and is not part of the request hash) | 201 (replay 200) `{ booking: <booker lab view>, funding: { method:'wallet', amountMinor, state, walletEntryId }, split: { listMinor, discountMinor, couponCode }, newAccount, replayed }` |
| `GET …/lab-bookings` | `?status&from&to (slot date)&cursor&limit≤50` | `[booker lab view]`, top-level `pagination: { total, nextCursor }` (newest first; cursor `<ms>_<id>`) |
| `GET …/lab-bookings/:id` | — | booker lab view; any other booking 404 `LAB_BOOKING_NOT_FOUND` |
| `GET …/lab-bookings/by-key/:key`, `POST …/by-key/:key/abandon` | — | `{ state:'used', booking } \| { state:'abandoned' } \| { state:'unknown' }` |
| `POST …/lab-bookings/:id/cancel` | `{ reason?, expectedVersion? }` | `{ booking, refundedMinor, alreadyCancelled }` |
| `POST …/lab-bookings/:id/accept-reschedule` | `{ version }` (the `reschedule.version` shown) | booker lab view |
| `POST /api/v1/lab-bookings/:bookingId/not-mine` (customer) | `{ note? }` | `{ reported: true, reviewItemId }` (needs `ASSISTED_ADMIN_TOOLS_ENABLED`) |

Booker lab view: `_id, source, partnerId, lab{name}, branchId, branch{name,address,phone}, visitMode, address?, slot{slotId,date,startTime,endTime,startsAt},
items[{name,kind,code}], status, statusVersion, reschedule{pending,version,previousSlot,reason,at}|null, collector{name}|null,
cancellation{reason,byKind,at}|null, lifecycle, patientName, holder{pharmacyCustomerId,name,typedName}, userId,
assisted{shortRef,bookedBy{name},preferredLanguage,disputed?{state}}, payment{method,state,payBy:null}, report{releases[{file,releasedAt,signer{name,kind,registrationNumber}}]}, createdAt, updatedAt`.
`report.releases` is empty until a release and again after the 90 days. Use `statusVersion` as `expectedVersion`.

Errors (create): 400 `CONSENT_REQUIRED`, `PAYMENT_METHOD_UNAVAILABLE` (`razorpay`: 2b), `REQUEST_KEY_REQUIRED`, `INVALID_PHONE`,
`VALIDATION_ERROR`, `ADDRESS_REQUIRED`, `CATALOGUE_ITEM_NOT_AVAILABLE`, `VISIT_MODE_NOT_SUPPORTED`, `INVALID_COUPON`,
`COUPON_NOT_FOR_ASSISTED`; 404 `LAB_NOT_FOUND`, `BRANCH_NOT_AVAILABLE`, `DEPENDENT_NOT_FOUND`; 409 `PRICE_CHANGED`
(`details: { priceMinor, listMinor, discountMinor }`), `SLOT_UNAVAILABLE`, `INSUFFICIENT_BALANCE`, `WALLET_FROZEN`,
`WALLET_INACTIVE`, `WALLET_RECEIVABLE`, `COUPON_EXHAUSTED`, `IDEMPOTENCY_KEY_REUSED`, `REQUEST_ABANDONED`; 429
`ASSISTED_LIMIT_REACHED` (lookups only); 503 `ASSISTED_BOOKING_DISABLED`, `INDEXES_OUTDATED`, `CUSTOMER_LINKING_UNAVAILABLE`.
Cancel: 404 `LAB_BOOKING_NOT_FOUND`; 409 `LAB_BOOKING_CHANGED`, `LAB_BOOKING_NOT_CANCELLABLE`, `CANCELLATION_WINDOW_CLOSED`,
`NO_SHOW_NOT_REFUNDABLE`. Accept: 404 `LAB_BOOKING_NOT_FOUND`; 409 `NO_PENDING_RESCHEDULE`, `RESCHEDULE_CHANGED`.
Patient app: lab booking reads carry `paidBy` and `assisted.{shortRef, bookedBy{kind,name}, identity{…, note}}`; `pricing` absent;
"pay again" answers 409 `PARTNER_PAID_BOOKING`. Lab workspace: `source`, `assisted{shortRef, bookedBy{name}, preferredLanguage}`, `identityNote`.

**Switches and deploy order**

- `ASSISTED_LAB_BOOKING_ENABLED_PHARMACY` (new, off unless exactly `"true"`; needs `ASSISTED_BOOKING_ENABLED_PHARMACY`). Off: the lab
  list, catalogue and slot reads and new lab bookings answer 503 `ASSISTED_BOOKING_DISABLED`. Reads, by-key, cancel,
  accept-reschedule, refunds, report access always work. "Not mine" follows `ASSISTED_ADMIN_TOOLS_ENABLED` as for consultations.
- Order: 1. deploy (switch off); 2. `npm run sync-indexes` (the three `partner_lab_bookings` indexes; until then a lab create
  answers 503 `INDEXES_OUTDATED`); 3. `ASSISTED_LAB_BOOKING_ENABLED_PHARMACY=true`; 4. restart. No migration.
- Rollback: the switch only. Never roll the code back below r11 while an assisted lab booking is open (older code would refund
  the patient's wallet): `db.partner_lab_bookings.countDocuments({ source: 'pharmacy_assisted', status: { $nin: ['completed','cancelled','no_show'] } })` must be 0.
- Merge with r10g: expected to touch `assisted/consultations.ts` and `assisted/limits.ts`, which r11 does not change; r11
  adds one line to `assisted/flags.ts` (the switch) and one action to `assisted/model`.

### 24.12 Round 2c build record: the lab front desk (r12, 2026-11-25)

Branch `m0/r12-phase2c` from `f5f171c9` (round 2a). Local commits only. Built: §24.6 with the owner's answers of 23 Nov, which
win over §24.6 where they differ: the patient **may cancel a desk booking from the app** until the sample is taken or the visit
is recorded (no money moves; the desk member is told); **no blocking limits except the hourly phone lookups** (no per-number,
new-account or cancellation cap); SMS as comments; labs see only typed or masked names. Owner, 25 Nov: no duplicated code —
the 2a helpers were generalised in one place and reused (see C15).

**What was built**

| Area | Where | What |
|---|---|---|
| Model | `partners/model/labBooking.ts` | `desk` (typed: `memberId, branchId, requestKey, requestHash, arrivedAt?, consent, preferredLanguage, payAtLab, notes?, newAccount`); `settlement.settlementSystem` `'ledger' \| 'lab_desk'`; `paymentDeadline` required unless `lab_desk`; `slot.walkIn` (seat fields required unless a walk-in); `cancellation.reason: 'desk'`; indexes `{desk.requestKey}` unique partial and (r12b) `{partnerId, source, slot.startsAt, _id}` |
| Links | `assisted/model/links.ts` (new) | `assisted_links` `{ bookerKind: 'lab'\|'doctor', bookerId, userId, typedName, consent: 'patient_agreed', consentRecordedAt, consentRecordedById }`, unique `{bookerKind, bookerId, userId}`; upserted in the desk transaction with the first typed name, never overwritten |
| Desk | `assisted/labDesk.ts` (new), `assisted/controller/phase2c.ts`, `assisted/routes/labDesk.ts`, `assisted/validation/labDesk.ts` | lookup; create (walk-in, lab visit on a slot, home collection) in the §24.3 order and ONE transaction; by-key / abandon; desk cancel. Registered inside `registerWorkspaceRoutes`, so members and the admin mirror both get it |
| Guards (§5.5) | `partners/services/labBookings.ts` | pay-again / wallet / gateway on a desk row → 409 `PAY_AT_LAB` (`retryPayment` and `resume`); the expiry sweep leaves out `settlementSystem: 'lab_desk'`; `postEarning` returns unless `ledger` (so no payout system ever sees a desk row); every cancel of a desk row (patient, desk, lab reject, admin) moves no money, keeps `paymentStatus: 'pending'` and releases the seat once (none for a walk-in); walk-ins: `no-show` 409 `WALK_IN_ARRIVED`, reschedule 409 `WALK_IN_NOT_RESCHEDULABLE`, `visit` at once |
| Views | `assisted/deskViews.ts` (new), `partners/services/labBookings.ts` | lab view: `source`, `payAtLab`, `desk` without key or hash, `bill`; patient view: `source`, `payAtLab`, `pricing` (the lab's price), `bill`, no `desk`; the workspace list filters by `source` |
| Bill link (Q2) | `partners/services/invoice.ts`, `partners/model/invoice.ts`, `partners/repository/invoice.ts` | `labBookingId` / `openLabBookingId` (unique partial: one open bill); one link table `BILL_LINKS` drives the appointment and lab booking admission tails, the race answer and the bill lookups; a cancelled bill frees the link; `labBookingId` joins the request hash and the checksum only when set (older bills keep theirs) |
| Account source | `user/model`, `user/types`, `customerResolver.ts` | `createdSource: 'lab_desk'` |
| Catalogue read | `partners/routes/index.ts` | `GET /catalogue` also for `bookings.manage` (the desk reads the tests it books) |

Check: `test/assisted/r12-phase2c.integration.ts` (24 checks); the 2a suite (26), Q3 (35) and Q14 (27) pass unchanged. Full regression
(`prun.sh`, 4 jobs): tsc 17; 3 suites failed in the parallel run — q16a (its raw sweep rows have no `settlement`; fixed by leaving out only
`lab_desk` rows, then 41/41), q16c (a shared upload folder counted by parallel suites; 31/31 alone) and phase0 (a timing check under load;
29/29 alone).

**ASSUMED (r12 build, reversible)**

| # | Choice | Why |
|---|---|---|
| C1 | Stored key `lab_desk:<partnerId>:<memberId>:<key>` (not `desk:<memberId>:<key>`); claim scope `lab_desk_create:<partnerId>:<memberId>` | an admin acting for two labs never collides |
| C2 | A family member chosen **by id** is stored and shown **masked**; typed names (self, a family member by name) as typed | L15: the lab did not type that name |
| C3 | No new-account count (§24.6.3 `countNewAccountIn`); lookups and every non-replay create count against the hourly lookup limit, audited with ids only | owner, 23 Nov |
| C4 | A walk-in stores `slot.date` / `startTime` (IST arrival) for display; `slotId` / `endTime` absent; `desk.arrivedAt` = `startsAt` | readers show a time |
| C5 | Desk cancel writes `cancellation.reason: 'desk'`; a lab reject on a desk row also works and moves no money | the existing steps stay valid |
| C6 | The patient cancels a desk row any time while `confirmed` (no 2 h window, also after a moved no-show). **r12b (overnight, as the owner's 2a decision):** the holder's "not mine", the admin dismiss and the admin move work on desk rows too, before or after the report — the review and the moves live on `desk.identity.disputed` / `desk.moves`; the lab's `assisted_links` row follows the move; the desk member who booked is told; no money moves; bills stay with the customer they name; the Ref of a desk row is the last 8 characters of its id | a desk booking under a mistyped phone can be corrected |
| C7 | The `bill` on views has the appointment bill shape `{ invoiceId, serial, number, state }` | one shape for the web |
| C8 | Cancelling a desk booking does not cancel its bill (the lab cancels it with its own refund record); a cancelled booking cannot be newly billed | Q10 bill rules stay the lab's |
| C9 | `PRICE_CHANGED` details reuse the 2a shape `{ priceMinor, listMinor, discountMinor: 0 }` | no new error shape |
| C10 | No desk catalogue or slot route: the desk reads `GET /catalogue` and `GET /slots`; the desk may take any open seat starting after now (no 60-minute lead) | minimal API |
| C11 | The desk member who booked is told of a patient cancel in their member inbox (`GET /me/notifications`); nobody when an admin booked | L12 |
| C12 | An inactive or unverified lab: 403 `PARTNER_NOT_VERIFIED` for an admin acting (members get the admission's `PARTNER_INACTIVE` / `PARTNER_NOT_VERIFIED`) | S5 pattern |
| C13 | A collector only on a home collection (400 `VALIDATION_ERROR` on a lab visit) | Q11 collector rule |
| C14 | Patient notice after a desk create: "Booked at <lab> … Pay at the lab." (key `labdesk:<id>:booked:customer`) | §24.6.3 |
| C15 | Shared, not copied (no behaviour change): `preparePatient` / `writePatientIn` / `countPhoneUse` (`assisted/patient.ts`), `validateLabRequest` / `labRequestContent` (`assisted/labBookings.ts`; 2a's hash is byte-identical), `admitLabItems` / `itemSnapshot` / `branchOffers` (`partners/services/labBookings.ts`), `istTimeHhmm`, `BILL_LINKS`. 2a now checks the payment method after the shared request rules | owner, 25 Nov |

**API for the web** (partner workspace: members at `/api/v1/partner-workspace/…`, admins at
`/api/v1/partner-workspace/admin/:partnerId/workspace/…`; permission `bookings.manage`; `{ success, data }`, `Cache-Control: private, no-store`)

| Route | Request | `data` |
|---|---|---|
| `POST /lab-desk/patients/lookup` | `{ phone }` | `{ exists, holderNameMasked }` |
| `POST /lab-desk/bookings` | `{ requestKey, phone, patient ({relation:'self',name} \| {dependentId} \| {relation,name,gender?,dateOfBirth?}), holderName?, consent:{agreed:true,statementVersion,statementLanguage}, preferredLanguage, branchId, visitMode:'lab'\|'home', slotId? (home: required; lab: absent = walk-in now), itemIds[1..20], address? (home only), collector? (home only: {memberId?, name, phone?}), acceptedTotalMinor, notes? }` | 201 (replay 200) `{ booking: <lab view>, patient: { name }, newAccount, replayed }` |
| `GET /lab-desk/bookings/by-key/:key`, `POST …/by-key/:key/abandon` | — | `{ state:'used', booking (null once outside the member's branches) } \| { state:'abandoned' } \| { state:'unknown' }` |
| `POST /lab-desk/bookings/:bookingId/cancel` | `{ reason?, expectedVersion? }` | `{ booking: <lab view>, alreadyCancelled }` |
| `GET /lab-bookings` (existing) | adds `?source=self\|pharmacy_assisted\|lab_desk` | desk rows carry `bill` |
| `GET /lab-bookings/:bookingId` (existing) | — | lab view; desk rows: `source:'lab_desk'`, `payAtLab:true`, `desk{memberId,branchId,arrivedAt,preferredLanguage,payAtLab,notes?,consent{method,statementVersion,statementLanguage,at}}`, `slot.walkIn`, `bill:{invoiceId,serial,number,state}\|null` |
| `POST /invoices` (existing) | adds `labBookingId?` (not with `appointmentId`) | the bill, with `labBookingId` |
| `GET /catalogue` (existing) | now also for `bookings.manage` | as before |
| Steps (existing) | `visit`, `collect`, `assign`, `process`, reports, `complete`, `reject` | as before (no money on desk rows) |

Patient app (existing routes): a desk row reads `source:'lab_desk'`, `payAtLab:true`, `pricing`, `bill`; `POST /api/v1/lab-bookings/:id/pay`
→ 409 `PAY_AT_LAB`; `POST …/cancel` → `{ booking, refunded: 0 }` while `confirmed`.

Errors (create): 400 `CONSENT_REQUIRED`, `REQUEST_KEY_REQUIRED`, `INVALID_PHONE`, `VALIDATION_ERROR`, `ADDRESS_REQUIRED`, `SLOT_REQUIRED`,
`CATALOGUE_ITEM_NOT_AVAILABLE`, `VISIT_MODE_NOT_SUPPORTED`, `COLLECTOR_NOT_MEMBER`; 403 `LAB_PARTNER_REQUIRED`, `BRANCH_SCOPE_EXCEEDED`,
`PARTNER_NOT_VERIFIED`; 404 `BRANCH_NOT_AVAILABLE`, `DEPENDENT_NOT_FOUND`; 409 `SLOT_UNAVAILABLE`, `PRICE_CHANGED`
(`details: { priceMinor, listMinor, discountMinor }`), `IDEMPOTENCY_KEY_REUSED`, `REQUEST_ABANDONED`; 429 `ASSISTED_LIMIT_REACHED` (lookups);
503 `ASSISTED_BOOKING_DISABLED`, `INDEXES_OUTDATED`, `CUSTOMER_LINKING_UNAVAILABLE`. Desk cancel: 404 `LAB_BOOKING_NOT_FOUND` (not a desk row
of this lab in the member's branches); 409 `LAB_BOOKING_CHANGED`, `LAB_BOOKING_NOT_CANCELLABLE`. Bill link: 404 `LAB_BOOKING_NOT_FOUND` (not a
desk row of this lab, outside scope, or an online row, L10); 400 `LAB_BOOKING_BRANCH_MISMATCH`, `VALIDATION_ERROR`; 409
`LAB_BOOKING_CUSTOMER_MISMATCH`, `LAB_BOOKING_CANCELLED`, `LAB_BOOKING_ALREADY_BILLED`; 503 `INDEXES_OUTDATED`. Steps: 409 `WALK_IN_ARRIVED`,
`WALK_IN_NOT_RESCHEDULABLE`.

**Switches and deploy order**

- `LAB_DESK_ENABLED` (new, off unless exactly `"true"`; `assisted/flags.ts`). Off: lookup and create answer 503 `ASSISTED_BOOKING_DISABLED`.
  Desk cancel, by-key, steps, reports, bills and patient reads and cancels always work.
- Order: 1. deploy (switch off); 2. `npm run sync-indexes` (new: `partner_lab_bookings {desk.requestKey}` unique partial and
  `{partnerId, source, slot.startsAt, _id}`; `assisted_links {bookerKind, bookerId, userId}` unique; `partner_invoices {openLabBookingId}` unique partial and
  `{partnerId, labBookingId, issuedAt}`; until then a desk create, and a bill naming a lab booking, answer 503 `INDEXES_OUTDATED`);
  3. `LAB_DESK_ENABLED=true`; 4. restart. No migration (fields are optional; the enum and `required` changes only loosen).
- Rollback: the switch only. Never roll the code back below r12 while a desk row is open (older code requires `paymentDeadline` and treats
  the row as ledger-settled): `db.partner_lab_bookings.countDocuments({ source: 'lab_desk', status: { $nin: ['completed','cancelled','no_show'] } })`
  must be 0.

**r12b (review of `e304dabe`)**

- "Not mine", dismiss and the admin move for desk rows (C6). One accessor in `assisted/review.ts` (`labOrigin`) names where a lab row's review
  lives (`assisted` or `desk`) and who hears about it; the lab link helper `linkLabIn` moved to `assisted/patient.ts` and serves the desk
  create and the move. Routes unchanged: `POST /api/v1/lab-bookings/:id/not-mine`, the admin review queue / dismiss and
  `POST /api/v1/admin/assisted-bookings/:id/move` now accept desk rows (behind `ASSISTED_ADMIN_TOOLS_ENABLED`, as before). Patient app: a desk
  row shows `disputed { state, at }` while reported; it leaves the list while `open`.
- The patient's lab list reads desk bills through the partners' bill index (`partnerId: { $in }`), not a scan of every bill.
- `postEarning` uses `isDeskRow`; the unused `ASSISTED_CAUSE.desk` is gone; the desk branch admission uses `assertBranchInScope`.
- The list index is `{partnerId, source, slot.startsAt, _id}` (the workspace list's own order). Deploy: `sync-indexes` drops the r12
  `{partnerId, source, createdAt}` index and builds this one.
- Check: the r12 suite has 26 checks.

**Seen, not changed**

- Phase 1a `assisted/consultations.ts` and `assisted/pharmacyCommands.ts` still inline the patient steps and the phone count that
  `preparePatient` / `countPhoneUse` now share (left for the r10g merge, which edits those functions).
- The Q3 customer create keeps its own test check (database order of lines); only `itemSnapshot` / `branchOffers` are shared with it.
- The unpaged `listForPartner` and the admin lab list carry no `bill`.

### 24.13 Round 2d build record: the lab wallet (r13, 2026-11-25)

Branch `m0/r13-phase2d` from `f5f171c9` (stage head, 2a). Local commits only. Built §24.7 with the owner's decisions of
25 Nov, which win over §24.7 where they differ: O2 (₹50,000 most in a wallet, one withdrawal a week, card money
withdrawable 7 days after payment: stored, withdrawals stay off); chargebacks **flag only**, as C4 for card payments; no
blocking limits except phone lookups; admin top-ups non-withdrawable (L20). And the owner's instruction of 25 Nov
00:20 IST: **one implementation shared by the pharmacy and lab wallets, parameterised by store, no copies.**

**What was built**

| Area | Where | What |
|---|---|---|
| Shared wallet rules | `pharmacyWallet/walletCore.ts` (new) | One implementation, moved from the pharmacy ledger and controllers: movements (`postMovementIn`: exactly once per operation key, wallet read and compare-and-set on `version` in the transaction, debits refused when owing, frozen, inactive or short, credits always post and clear a receivable first, lots consumed oldest first and restored on refund, withdrawable recomputed), `refreshWithdrawableIn`, the lot chargeback (`chargeBackLotIn`, the pharmacy's `take` rule), `resolveTopupRecord`, `recordTopupChargebackIn` (`taken` / `flagged` / `blocked`), `closeTopupCompensatedIn`, the top-up credit (`creditTopupIn`: the `walletCreditedAt` claim, then the ledger credit and the lot), `adminTopup` (Idempotency-Key, content hash, replay, 409), `setFrozenIn`, `checkTopup`. A **store** adapts one wallet's persistence (`WalletStore`); a **top-up kind** says how a card top-up record names its wallet (`TopupKind`) |
| Lots | `pharmacyWallet/walletLots.ts` (new) | `withdrawableOfIn`, `consumeLots`, `restoreLots` moved unchanged with a `walletRef` parameter, plus `openLotIn` and `lotsOf`. `wallet_topup_lots` gains `withdrawableAfter` (lab lots only) |
| Pharmacy store | `pharmacyWallet/ledger.ts`, `pharmacyWallet/services` | Now the pharmacy store adapter (rupee fields written beside paise, `transactionType`, ObjectId `pharmacyId`) and `pharmacyTopups`; `postPharmacyMovementIn`, `recordChargebackIn`, `withdrawableOfIn` keep their signatures. `PharmacyWalletService.topup`, `adminTopupByKey`, `checkTopup` call the shared functions. Wrappers nobody calls any more were removed (`pharmacyWalletIn`, `resolveTopupRecordId`, `recordPaymentChargebackIn`, `closeTopupCompensatedIn`, `refreshWithdrawableIn`) |
| Lab store | `partnerWallets/model` (new: `partner_wallets`, `partner_wallet_entries`), `partnerWallets/ledger.ts` (new) | The partner store adapter (`ownerKind: 'lab' \| 'doctor'`, integer paise, signed entries), `labTopups` (flag chargebacks; a lot with the fee while `ASSISTED_BOOKING_ENABLED_LAB` is on and the lot index exists; `withdrawableAfter` = payment + 7 days), `LAB_WALLET_POLICY` (O2 and the admin cap), `debitLabWalletIn` (S5: an active, verified lab; 2e spends through it) and `refundLabWalletIn` (always posts) |
| Payments | `payment/services`, `payment/model`, `payment/types` | Every card top-up (pharmacy and lab) is credited by `creditTopupIn` through its kind; a lab top-up never reaches the customer wallet; an already processed lab top-up answers the lab wallet; the recovery sweep takes every lab top-up; a member of the paying lab (`requesterUserType: 'partner'`) may verify; `createOrder` stores `payerPartnerId`, `payerMemberId`, `requestKey`, `requestHash`. New indexes `payment_records {payerPartnerId, createdAt}` (partial `$exists`) and `{requestKey}` unique (partial `$exists`) |
| Workspace and admin routes | `partnerWallets/routes.ts`, `service.ts`, `validation.ts` (new); `src1/routes/index.ts` | Below. The workspace router is mounted at `/api/v1/partner-workspace/assisted` (2e adds its routes there), the admin one at `/api/v1/admin/labs` |
| Admin tools on any top-up | `assisted/controller/phase1a.ts` | The existing chargeback (by payment and by lot) and close-compensated routes, and the close by-key read, take lab top-ups too (the kind comes from the record or the lot); pharmacy answers are unchanged. The pharmacy freeze and lots reads use the shared functions |
| Permissions, switch | `partners/types`, `assisted/flags.ts` | `wallet.view`, `wallet.manage` (owners hold all; L13). `ASSISTED_BOOKING_ENABLED_LAB` and `assertLabWalletOn` |
| Reconciliation | `partnerWallets/reconciliation.ts` (new), `assisted/reconciliation.ts` | The report checks partner wallets (`checks.partnerWallets.checked`; mismatches `partner_wallet_balance`, `partner_wallet_withdrawable`, `partner_wallet_receivable_unfrozen`, `ref: 'lab:<partnerId>'`); the uncredited list adds paid lab top-ups never claimed; the daily fee fill refreshes the withdrawable amount of the lot's own wallet, whatever its kind |
| Audit, alerts, errors | `assisted/model`, `middleware/errorHandler.ts` | Lab admin wallet actions are audited in `assisted_audit_events` with `orgKind: 'lab'` (ids, codes, paise; new action `wallet.admin_topup`); a flagged chargeback raises the alert `wallet_topup_chargeback`; `WALLET_LIMIT_REACHED` answers carry paise `details` |

Checks: `test/assisted/r13-phase2d.integration.ts` (18 checks). The lot-helper move and the sharing are proven by the
1a/1b/2a and S6 suites passing unchanged: full regression 69 suites, 68 passed, `tsc` 17 (unchanged); the one failure,
`q16c-pharmacy` N1 (an import file's removal under parallel load), passed alone (31/31) and does not touch wallets.

**ASSUMED (r13 build, reversible)**

| # | Choice | Why |
|---|---|---|
| D1 | A lab chargeback is **flag only**: `chargebackAt` on the record once, its lot `disputeState: 'lost'` (no longer withdrawable; not closed, balance unchanged), alert `wallet_topup_chargeback`, audit `wallet.chargeback` (`flaggedOnly: true`). No debit, receivable or freeze; recovering the money is an admin decision. A lab top-up never credited is **blocked** (never credited), as for pharmacies; one closed as compensated is flagged (nothing taken) | owner C4 |
| D2 | The ₹50,000 maximum is checked when a top-up is ordered: balance + the lab's unpaid orders of the last 30 minutes + this one (409 `WALLET_LIMIT_REACHED`). Two orders made at the same moment, or an old order paid late, can still take the balance past it: a paid top-up is always credited. Admin top-ups and refunds do not check it (admin top-ups: at most ₹2,00,000 each) | money paid must be credited; no other blocking limits |
| D3 | `withdrawableAfter` (payment + 7 days) is stored on lab lots only (the pharmacy store is not touched); `withdrawableMinor` counts card money before its 7 days. Phase 4 must apply the date and the one-a-week rule (`LAB_WALLET_POLICY`) | O2: store the data, withdrawals off |
| D4 | Lab top-ups always join the recovery sweep (not gated by `WALLET_RECHARGE_SWEEP_FROM`) | none predates the sweep |
| D5 | Reads, the top-up check, verify and reconcile admit any active member (with the permission) of an active lab, verified or not: a paid top-up is its own money (§19.8 item b). A new top-up needs an operational (verified) lab; spending needs an active, verified lab (403 `PARTNER_NOT_VERIFIED` / `PARTNER_INACTIVE`); refunds always post | S5 pattern |
| D6 | Lab admin wallet actions go to `assisted_audit_events` (`orgKind: 'lab'`), the trail the pharmacy's already use, not `partner_audit_events` | one shared path |
| D7 | No lab-only chargeback or close routes: the existing admin routes take any top-up kind (§24.7.3) | one code path |
| D8 | The top-up request key lives on the payment record (`requestKey` = `wallet_topup:lab:<partnerId>:<memberId>:<key>`, unique; hash of the amount). Two first sends at once: one record; the loser's Razorpay order is never shown, so never paid (as 1b) | no new collection |
| D9 | Two conservative pharmacy changes came with the sharing: the credit and the payment chargeback find an earlier credit row in any id spelling (the r9b read the close already used), and `PharmacyWalletService.topup` refuses a missing key (the admin route always required one) | one lookup per rule |
| D10 | A member of a clinic gets 404 `WALLET_NOT_FOUND` on the wallet routes | doctor wallets are phase 3 |
| D11 | The O2 numbers are code constants (`LAB_WALLET_POLICY`), not per-wallet data | phase 4 may move them |
| D12 | The `postBookerMovementIn` dispatcher (§24.7.1) is left to 2e, with its callers; 2d provides `debitLabWalletIn` / `refundLabWalletIn` | nothing spends the lab wallet yet |
| D13 | The history read lists entries newest first with a `<ms>_<id>` cursor (index `{ownerKind, ownerId, at: -1, _id: -1}`); a second list shows the lab's top-ups with their state, so a lost answer can be found and checked | §24.7.6 "Check" |

**API for the web**

Lab workspace (partner member token; `{ success, data }`, `Cache-Control: private, no-store`; money in paise):

| Route | Guard | Request | `data` |
|---|---|---|---|
| `GET /api/v1/partner-workspace/assisted/wallet` | `wallet.view` | — | `{ balanceMinor, withdrawableMinor, receivableMinor, frozen, isActive, updatedAt }` (no wallet yet: zeros, `updatedAt: null`) |
| `GET …/assisted/wallet/entries` | `wallet.view` | `?cursor&limit` (≤ 50, default 20) | `[{ _id, kind, amountMinor (signed), balanceAfterMinor, description, referenceType, referenceId, at }]`; top-level `pagination: { nextCursor }` |
| `GET …/assisted/wallet/topups` | `wallet.view` | `?cursor&limit` | `[{ paymentTransactionId, amountMinor, state, status, memberId, razorpayOrderId, createdAt, paidAt }]`, `pagination`; `state`: `awaiting_payment`, `credited`, `paid_not_credited`, `blocked`, `closed_compensated`, `failed`, `refunded` |
| `POST …/assisted/wallet/topups` | `wallet.manage`, operational lab, switch | `{ amountMinor (100…5000000), requestKey (^[A-Za-z0-9_-]{8,100}$) }` | `{ paymentTransactionId, razorpayOrderId, razorpayKeyId, amountMinor, currency, state, replayed }` |
| `POST …/assisted/wallet/topups/:paymentTransactionId/check` | `wallet.view` | — | `{ state: 'credited' \| 'unpaid', wallet }` |
| `POST …/assisted/payments/verify` | `wallet.manage` | `{ paymentTransactionId, razorpayOrderId, razorpayPaymentId, razorpaySignature }` | `{ context: 'wallet_recharge', paymentRecord: { _id, status, amountMinor, currency, razorpayOrderId, razorpayPaymentId, paidAt, credited }, entity: <wallet> }` |
| `POST …/assisted/payments/reconcile` | `wallet.manage` | `{ paymentTransactionId }` | as verify with `state: 'paid'`, or `{ state: 'unpaid', gatewayStatuses }` |

Flow: create the order, open Razorpay Checkout (`key = razorpayKeyId`, `order_id`, `amount = amountMinor`, `currency`),
then verify. A lost answer: send the same body with the same `requestKey` (the same order comes back), or `reconcile` /
"Check" the `paymentTransactionId`. The server also sweeps every lab top-up, so a capture is never lost. Show
`withdrawableMinor` as "card money (withdrawals coming later)"; show `frozen` and `receivableMinor` as a banner.

Errors: 400 `VALIDATION_ERROR`, and as §23.3 `PAYMENT_SIGNATURE_INVALID`, `PAYMENT_ORDER_MISMATCH`, `PAYMENT_AMOUNT_MISMATCH`,
`PAYMENT_NOT_COMPLETED`, `PAYMENT_FAILED`, `PAYMENT_REFUNDED`; 403 `FORBIDDEN` (not a partner token, e.g. a pharmacy),
`PARTNER_MEMBER_INACTIVE`, `PARTNER_INACTIVE`, `PARTNER_NOT_VERIFIED` (new top-up), `INSUFFICIENT_PERMISSIONS`; 404
`WALLET_NOT_FOUND` (not a lab), `PAYMENT_RECORD_NOT_FOUND` (another lab's, a pharmacy's or an unknown record: one answer);
409 `IDEMPOTENCY_KEY_REUSED`, `WALLET_LIMIT_REACHED` (`details: { maxBalanceMinor, balanceMinor, pendingMinor,
allowedMinor }`), `TOPUP_BLOCKED` (blocked after a dispute, or closed as compensated), `PAYMENT_CHANGED` (retry); 502
`RAZORPAY_ORDER_CREATION_FAILED` (send the same request again), `RAZORPAY_PAYMENT_FETCH_FAILED`; 503
`ASSISTED_BOOKING_DISABLED` (switch off: new top-ups only), `INDEXES_OUTDATED`, `RAZORPAY_NOT_CONFIGURED`.

Admin (admin token; writes need `ASSISTED_ADMIN_TOOLS_ENABLED`, else 503 `ASSISTED_BOOKING_DISABLED`):

| Route | Request | `data` |
|---|---|---|
| `GET /api/v1/admin/labs/:partnerId/wallet` | — | the wallet view plus `{ exists, frozenReason, frozenAt, version, createdAt }` |
| `GET …/labs/:partnerId/wallet/entries` | `?cursor&limit` | entries plus `{ withdrawableDeltaMinor, receivableDeltaMinor, operationKey, notes, lotAllocations, actor }`; `pagination` |
| `GET …/labs/:partnerId/wallet/lots` | — | lots, newest first (≤ 200): `{ _id, walletRef, paymentRecordId, amountMinor, gatewayFeeMinor, feeState, disputeState, closed, remainingMinor, withdrawableAfter, createdAt }` |
| `POST …/labs/:partnerId/wallet/topup` | header `Idempotency-Key` (`^[A-Za-z0-9_-]{8,100}$`); `{ amountMinor (1…20000000), notes? (≤ 500) }` | the admin wallet view. Non-withdrawable; once per key (same body → the wallet again; other amount or note → 409 `IDEMPOTENCY_KEY_REUSED`) |
| `GET …/labs/:partnerId/wallet/topups/by-key/:key` | — | `{ state: 'credited', entry, wallet }` or `{ state: 'not_found' }` (resend the same body with the same key) |
| `PUT …/labs/:partnerId/wallet/freeze` | `{ frozen, reason }` | the admin wallet view; 409 `WALLET_RECEIVABLE` to unfreeze a wallet that owes |
| `POST /api/v1/admin/wallet-payments/:paymentId/chargeback` (existing) | `{ reason }`; `paymentId` = record id, `order_…` or `pay_…` | lab top-up credited: `{ blockedUncredited: false, flagged: true, credited: true, replayed, paymentRecordId, lotId, walletKind: 'lab', partnerId, compensated?, message }`; never credited: the §19.3 blocked answer. Pharmacy answers unchanged |
| `POST /api/v1/admin/wallet-lots/:lotId/chargeback` (existing) | `{ reason }` | a lab lot: the flagged answer (its top-up is flagged) |
| `POST /api/v1/admin/wallet-payments/:paymentId/close-compensated` and `GET …/close-compensated/by-key/:key` (existing) | as §22.2 | a lab top-up answers `walletKind: 'lab', partnerId` instead of `pharmacyId`, message "… paid to the lab …" |
| `GET /api/v1/admin/wallet-recharges/uncredited` (existing) | — | adds `{ paymentTransactionId, walletKind: 'lab', partnerId, amountMinor, createdAt, state: 'paid_not_credited' }` |

Admin errors: 400 `IDEMPOTENCY_KEY_REQUIRED`, `VALIDATION_ERROR` (key, amount over ₹2,00,000, note); 403 for non-admins;
404 `LAB_NOT_FOUND` (a pharmacy id, a clinic, an unknown or malformed id: one answer); 409 as above and §19.3 / §22.2;
503 `INDEXES_OUTDATED`.

**Switches and deploy order**

- `ASSISTED_BOOKING_ENABLED_LAB` (new, off unless exactly `"true"`): new lab top-ups, and lots on their credits (2e: lab-made
  consultations). Off: `POST …/wallet/topups` answers 503; reads, the check, verify, reconcile and the sweep keep
  crediting paid top-ups (without a lot: non-withdrawable). `ASSISTED_ADMIN_TOOLS_ENABLED` (existing) gates the admin
  top-up, freeze, chargebacks and close.
- Order: 1. deploy (switch off); 2. `npm run sync-indexes` (`partner_wallets {ownerKind, ownerId}` unique and `{frozen}`;
  `partner_wallet_entries {walletId, operationKey}` unique and `{ownerKind, ownerId, at, _id}`; `payment_records
  {payerPartnerId, createdAt}` and `{requestKey}` unique; until then top-ups and admin writes answer 503
  `INDEXES_OUTDATED`); 3. owners grant `wallet.view` / `wallet.manage` to staff (owners already hold them); 4.
  `ASSISTED_BOOKING_ENABLED_LAB=true`; 5. restart. No migration (new collections).
- Rollback: the switch. Rolling the code back below r13 strands lab money: older code never credits a lab top-up (the
  generic payment routes refuse partner tokens and its sweep skips them), and reads no lab wallet. Before such a rollback
  `db.payment_records.countDocuments({ 'notes.flow': 'lab_wallet_recharge', status: { $in: ['created', 'paid'] },
  walletCreditedAt: { $exists: false } })` must be 0 and no lab wallet may hold money.
- Merge notes (small edits in shared files): `assisted/flags.ts` (one switch and its assert), `assisted/model` (one
  audit action), `assisted/reconciliation.ts` (imports, one list append, partner checks in the report, the fee refresh
  line), `src1/routes/index.ts` (two mounts), `partners/types` (two permissions), `payment/*`, `middleware/errorHandler.ts`.
  The pharmacy wallet files and `assisted/controller/phase1a.ts` (wallet tools only) changed more; r10h and 2c do not
  touch them.

**Seen, not changed**

- The pharmacy admin top-up has no server-side amount cap (only the web form's ₹2,00,000); the lab one is checked by the server.
- A partial index filtered on `$type: 'string'` is not used by an equality query (checked with `explain` on MongoDB 7):
  `payment_records {compensation.requestKey}` (the close by-key reads scan the collection) and `pharmacy_wallet_transactions
  {pharmacyId, operationKey}` (the ledger's replay read walks the pharmacy's rows on `{pharmacyId}`; the admin by-key reads
  are hinted and fine). The new r13 indexes use `$exists`.
- The pharmacy's own Razorpay top-up order (`POST /pharmacy-wallet/topup`) has no request key: a resend makes another order.
- `PaymentService` keeps its two pharmacy wallet repositories as constructor parameters (positional callers); the credit no longer uses them.

### 24.14 Round 2b build record: pharmacy → lab test by card/UPI (r14, 2026-11-25)

Branch `m0/r14-phase2b` from `f5f171c9` (2a on r10f). Local commits only; nothing pushed or deployed. Built: §24.5 with the
owner's decisions of 23 Nov (no blocking limits except the hourly phone lookups, so **no pending-card cap**) and the owner's
instruction of 25 Nov 00:20 IST (**no duplicated code**: the phase 1b card machinery is generalised by booking kind; the
consultation behaviour is unchanged and the r10 / r10b / r10f suites pass unchanged). Where this section and §24.5 differ,
this one wins.

Check: `test/assisted/r14-phase2b.integration.ts` (23 checks over HTTP with the real routes, a stand-in Razorpay and refund
gateway).

**What was built**

| Area | Where | What |
|---|---|---|
| Payment context | `payment/types`, `payment/model`, `payment/services`, `payment/routes`, `payment/controller` | New context `assisted_lab_booking` (receipt code `al`). `ASSISTED_CARD_CONTEXTS` / `isAssistedCardContext` replace the `assisted_booking` literal wherever 1b special-cased it: verification by the paying pharmacy (`payerPharmacyId`), 409 `PAYMENT_DISPUTED`, a bad signature never closing the record, the recovery sweep's context list, the operational-pharmacy gate on verify / reconcile. Routing stays by the stored record's `context` (S6; `module` is informational). A pharmacy's verify / reconcile answer carries the booker LAB view; anyone else gets id and states only |
| One card machinery for both kinds | `assisted/cardPayments.ts` | A `KINDS` table holds what differs between a consultation and a lab booking: the context, the collection, "waiting for payment" (`pending`/`pending` vs `pending_payment`/`pending`), pay-by (`createdAt` + 30 min vs `paymentDeadline`), the S5 provider check (doctor vs an active, verified `lab` partner), the confirming compare-and-set (lab rows bump `statusVersion` and set `lifecycle.paidAt/confirmedAt`) and the follow-up (consultation: Meet, reminders, notices; lab: the patient's "booked" notice). Everything else is one code path: `openCardOrderOf` (one order on the pre-chosen record id), `applyAssistedCaptureOf` (confirm once in one transaction, else a late capture returned to the card in the same transaction; the follow-up lease `assisted.followUpLeaseUntil`; record processed only after the follow-up), `settleOtherAssistedCaptures` (extra captures, by the record's context), `sweepAssistedOtherCaptures` (both contexts), `bookerPayments` (the booker view's `payment` field, now also used by the consultation booker view), `assertCardPaymentAvailable` (switch, keys, `captureKey` index; used by both creates). `registerAssistedPayments` registers both contexts (no change in `routes/index.ts`) |
| Card refund rows | `assisted/cardRefunds.ts`, `assisted/model` | `bookingKind: 'booking' \| 'lab_booking'` (rows from before carry none and are read as `booking`; every new row writes it; *r14b:* no index of its own). The row's kind picks the collection for `syncBookingRow`, the chargeback answers' `bookingStatus` and the wallet reference type (`assisted_lab_booking`) of a to-wallet credit. The assisted chargeback looks up records of both contexts. Admin refund rows and stuck money's `cardChargebacks` add `bookingKind`. `cancellationRefundOf` moved here from `pharmacyCommands.ts` (used by both cancels) |
| Cancel money | `assisted/refunds.ts` `settleCardFundingIn`, `assisted/labRefunds.ts` | The card step of the 1b cancel was extracted (coupon reversal, then the record's one card refund row: card by default, wallet on the booker's own choice; `not_paid` when no capture was applied) and is called by the consultation cancel (unchanged behaviour) and the lab cancel (`settleAssistedLabFundingIn`; the 2a `REFUND_METHOD_UNSUPPORTED` guard is gone). `bookerMoneyLine` / `cancellationRowOf` give both kinds the same booker notice line ("being refunded to the card or UPI" / "back in your Jansetu wallet") |
| Lab create | `assisted/labBookings.ts` | `paymentMethod: 'razorpay'`: the 2a checks, key, hash, coupon and transaction, but the row is inserted `pending_payment` / `pending`, `paymentDeadline` = now + 30 min, seat held, funding `{ method: 'razorpay', state: 'pending', paymentRecordId }` (chosen before the insert), no wallet debit; the order is made after the commit. 400 `NOTHING_TO_PAY` for 0. Receipt, by-key and booker view carry the payment (below). The patient's "booked" notice (`notifyLabBooked`, shared with the wallet path) follows the confirmation |
| Lab cancel | `assisted/labBookings.ts`, `partners/services/labBookings.ts` | Booker cancel takes `refundTo` and answers `refund`; a card booking still waiting for payment may be cancelled at any time (nothing refunded, nobody but the booker knew of it). Patient, lab-reject and admin cancels queue the card refund row in the cancel transaction (always to the card); card refunds are sent at once after the commit and by the 5-minute worker |
| Lab expiry | `partners/services/labBookings.ts` | The 5-minute lab sweep reconciles a row's own context (`assisted_lab_booking` for assisted rows), fences the records of that context, then expires: seat released, coupon reversed, funding `not_paid`; nobody is told (C7). A capture recorded but not yet applied leaves the row to the payment handler |
| Unpaid rows hidden | `assisted/labViews.ts` (`LAB_UNPAID_CARD_QUERY`, `isUnpaidCardLab`), `partners/services/labBookings.ts`, `assisted/review.ts` | A card lab booking never confirmed (`lifecycle.confirmedAt` absent) is the booker's alone: left out of the patient's list and the lab's lists, 404 `LAB_BOOKING_NOT_FOUND` on the patient's reads, cancel, pay-again and "not mine", and on every lab read and step. Once paid it is theirs (and stays so if cancelled later) |
| Stuck money | `assisted/reconciliation.ts` | `pendingPaymentPastDeadline` adds lab card rows still waiting an hour past `paymentDeadline` (`bookingKind: 'lab_booking'`) |
| Validation | `assisted/validation` | Lab cancel `refundTo`; the booker list accepts `status=pending_payment` |

**ASSUMED (r14 build, reversible)**

| # | Choice | Why |
|---|---|---|
| E1 | No pending-card cap for lab bookings (§24.5.3, L21 not built) | Owner, 23 Nov |
| E2 | An unpaid card lab booking that expires is NOT counted as a booker cancellation (§24.5.3 said `countBookerCancellationIn`) | That counter blocks new consultations (P7); owner: no blocking limits; as 2a B2 |
| E3 | The booker may cancel its card lab booking while it waits for payment at any time (no 1-hour window); nothing is refunded, nobody else is told; a capture landing later is a late capture | Nothing was paid; frees the seat; as consultations (§23.3) |
| E4 | S5 at capture = the lab partner (`kind: 'lab'`, active, verified). A branch or test switched off after booking does not refuse the capture | §24.1 item 12 provider rule; customer lab bookings behave the same |
| E5 | Lab card refunds use the 1b rows, worker, keys (`ab-<row id>`) and wallet operation key (`assisted_card:<record>:refund`); only the wallet reference type differs (`assisted_lab_booking`) | One machinery |
| E6 | Every new card refund row writes `bookingKind`, consultations included (`booking`) | Readable; old rows read as `booking` |
| E7 | The patient is told once paid, with the 2a notice and key (`assisted:lab:<id>:booked:customer`); the lab is not told (L18) | C7, L18 |
| E8 | The admin lab list (`/partner-workspace/admin/lab-bookings`) still shows unpaid card rows | Admins see everything (B12) |
| E9 | No per-booking reconciliation checks for card lab rows (the daily checks cover wallet rows; stuck money lists waiting card rows) | As consultations (§23.5) |
| E10 | A returned lab capture's verify message says "…or the lab is not available…" | Wording only |
| E11 | No pay-again: one order per booking; after 30 minutes the booker books again (C10) | As 1b |
| E12 | `cardRefundView` (the booker's own `refund`) is unchanged; only admin rows add `bookingKind` | r10c kept the booker's answer as it was |

**API for the web** (pharmacy token, `requireOperationalPharmacy`; `{ success, data }`; money in paise unless marked ₹)

- **Book with card/UPI.** `POST /api/v1/pharmacy-assisted/lab-bookings` — the §24.11 body with `paymentMethod: 'razorpay'`. 201:
  ```
  { booking: <booker lab view, status 'pending_payment'>,
    funding: { method: 'razorpay', amountMinor, state: 'pending', walletEntryId: null, paymentTransactionId },
    split: { listMinor, discountMinor, couponCode },
    payment: { paymentRequired: true, paymentTransactionId, razorpayOrderId, razorpayKeyId, amount (₹), amountMinor, currency, payBy } | null,
    newAccount, replayed }
  ```
  Open Razorpay Checkout with `key = razorpayKeyId`, `order_id = razorpayOrderId`, `amount = amountMinor`, `currency`. `payBy` (ISO) =
  `paymentDeadline`: the seat is released after it unless the payment arrived. Same key and body → 200 `replayed: true` with the SAME
  order (`payment: null` once paid, cancelled or expired); the method is not in the request hash. Errors besides §24.11: 400
  `PAYMENT_METHOD_UNAVAILABLE` (card switch off), `NOTHING_TO_PAY`; 502 `RAZORPAY_ORDER_CREATION_FAILED` (the booking is held: send the same
  request again); 503 `RAZORPAY_NOT_CONFIGURED`, `INDEXES_OUTDATED` (card refund index). All refusals come before any account, seat or order,
  with one answer for every number. No 429 for waiting card bookings.
- **Booker lab view `payment`** (list, detail, by-key, cancel and verify answers; this pharmacy only): `{ method: 'wallet' | 'razorpay', state,
  payBy, paymentTransactionId?, razorpayOrderId?, razorpayKeyId?, amountMinor?, currency? }`. `state`: `pending`, `captured`, `refunded`,
  `not_paid`, `forfeited`. Card rows carry `paymentTransactionId`; while waiting (`status: 'pending_payment'`) `payBy` and the open order
  with its amount (`razorpayOrderId`, `razorpayKeyId`, `amountMinor`, `currency`; r14b; null when none is open yet: replay the create) so
  "Pay now" opens Checkout from any device. Consultations' booker view carries the same fields (r14b). `GET …/lab-bookings?status=pending_payment` lists the waiting ones.
  `GET …/lab-bookings/by-key/:key` adds `payment` (the open order or null, read only) for a card booking.
- **After Checkout.** `POST /api/v1/payments/verify { paymentTransactionId, razorpayOrderId, razorpayPaymentId, razorpaySignature }` →
  `{ context: 'assisted_lab_booking', paymentRecord, entity: <booker lab view> }`. `paymentRecord.status: 'paid'` and `entity.status:
  'confirmed'`: booked. `paymentRecord.status: 'refunded'`: the booking could not take it (expired, cancelled, or the lab is no longer
  available); the money goes back to the card or UPI. Lost answer or closed Checkout: `POST /api/v1/payments/reconcile { paymentTransactionId }`
  → `{ state: 'paid', … }` as verify, or `{ state: 'unpaid', gatewayStatuses }`. Errors as §23.3: 400 `PAYMENT_SIGNATURE_INVALID`,
  `PAYMENT_ORDER_MISMATCH`, `PAYMENT_AMOUNT_MISMATCH`, `PAYMENT_NOT_COMPLETED`, `PAYMENT_FAILED`, `PAYMENT_REFUNDED`; 403 (pharmacy not
  operational); 404 `PAYMENT_RECORD_NOT_FOUND` (another pharmacy, the patient); 409 `PAYMENT_CHANGED`, `PAYMENT_DISPUTED`,
  `DUPLICATE_PAYMENT_REFUNDED` (a second payment on the order: refunded to its card); 502 `RAZORPAY_PAYMENT_FETCH_FAILED`.
- **Cancel.** `POST /api/v1/pharmacy-assisted/lab-bookings/:id/cancel { reason?, expectedVersion?, refundTo?: 'card' | 'wallet' }` →
  `{ booking, refundedMinor, alreadyCancelled, refund }`; `refund` (card bookings only) = `{ refundId, bookingId, paymentRecordId, amountMinor,
  cause, method: 'card' | 'wallet', state: 'pending' | 'processed' | 'failed' | 'manual_review', lastError, attempts, razorpayRefundId,
  processedAt, createdAt, updatedAt }`, or null (cancelled before payment). `refundTo` defaults to `card`; `wallet` credits the wallet at once
  and is NOT withdrawable (show this before the partner chooses); ignored for wallet-paid bookings. A waiting card booking may be cancelled at
  any time; a paid one up to 1 hour before the slot (or while a lab reschedule is unanswered). 400 `VALIDATION_ERROR` for another
  `refundTo`; other errors as §24.11. Show "refund to card: in progress" while `pending`.
- **Patient app.** A card lab booking appears only once paid; until then list and reads answer as if it did not exist (404
  `LAB_BOOKING_NOT_FOUND`). Once paid it looks like a wallet one ("Paid by <partner>", no price). A patient cancel refunds the PARTNER's card.
- **Lab workspace.** Unpaid card bookings are not listed and answer 404 on reads and steps until paid.
- **Admin.** Card refund rows (`GET /api/v1/admin/assisted/card-refunds`, `…/:id`) add `bookingKind` (`booking` | `lab_booking`); recheck,
  mark-failed and to-wallet work on lab rows unchanged. `POST /api/v1/admin/assisted-payments/:paymentId/chargeback` takes a lab payment's
  record id, `order_…` or `pay_…` (flag only, C4; `bookingStatus` is the lab booking's). Stuck money: `pendingPaymentPastDeadline` items of
  lab rows are `{ bookingId, bookingKind: 'lab_booking', createdAt, paymentDeadline }`; `cardChargebacks` items add `bookingKind`.

**Switches and deploy order**

- No new switch. A card lab booking needs `ASSISTED_CARD_PAYMENT_ENABLED`, `ASSISTED_LAB_BOOKING_ENABLED_PHARMACY` and
  `ASSISTED_BOOKING_ENABLED_PHARMACY` (each off unless exactly `"true"`) and the Razorpay keys. Card switch off: 400
  `PAYMENT_METHOD_UNAVAILABLE`; a lab or pharmacy switch off: 503 `ASSISTED_BOOKING_DISABLED`. Verify, reconcile, the sweeps, expiry and
  refunds always run.
- No new index (*r14b:* the `{bookingKind, bookingId}` index of r14 was dropped: nothing queried it; booking ids are unique across both
  collections). A card create relies on the r10e `captureKey` unique index (503 `INDEXES_OUTDATED` without it). No migration.
- Order: 1. deploy; 2. `npm run sync-indexes`; 3. restart. Where both `ASSISTED_CARD_PAYMENT_ENABLED` and
  `ASSISTED_LAB_BOOKING_ENABLED_PHARMACY` are already on, card lab bookings are live at the restart: on stage test them first (book by card,
  pay in Checkout, see it confirmed; cancel it, see the refund at Razorpay; book and let it expire, then pay the same order from the
  Razorpay test dashboard: refunded once).
- Rollback: the switches only. Never roll the code back below r14 while any lab card booking is `pending_payment`, any
  `assisted_lab_booking` record could still capture, or any card refund row of a lab booking is not settled: older code has no handler for
  the context (a capture would stay unapplied and unrefunded) and syncs refund rows onto `bookings`. Checks:
  `db.partner_lab_bookings.countDocuments({ 'assisted.funding.method': 'razorpay', status: 'pending_payment' })` = 0 and
  `db.assisted_card_refunds.countDocuments({ bookingKind: 'lab_booking', state: { $ne: 'processed' } })` = 0.
- Merge notes: r14 edits shared files in small, local hunks — `assisted/consultations.ts` (the card gate now calls
  `assertCardPaymentAvailable`; two imports), `assisted/bookerView.ts` (uses `bookerPayments`), `assisted/pharmacyCommands.ts`
  (`cancellationRefundOf`, `bookerMoneyLine`), `assisted/refunds.ts`, `assisted/cardPayments.ts`, `assisted/cardRefunds.ts`,
  `assisted/labBookings.ts`, `partners/services/labBookings.ts`, `payment/*`, `assisted/reconciliation.ts`, `assisted/review.ts`,
  `assisted/validation`. Expect conflicts with r10g (`consultations.ts` imports), 2c (`assisted/labBookings.ts`,
  `partners/services/labBookings.ts`) and 2d (`payment/types` and `payment/model` context lists); each side keeps both.

**r14b (review of 2b, on `m0/r19-stage-next`).** Checks: `test/assisted/r14-phase2b.integration.ts` (now 24).

| # | Finding | Fix |
|---|---|---|
| 1 | A replay holding a stale copy of a card booking (read just before it expired or was cancelled) could answer with a payable order | `openCardOrderOf` (both kinds, so 1b consultations too) reads the booking again before it shows or makes an order; a row no longer waiting answers `payment: null` and no order is made. A capture on an order shown a moment earlier is still a late capture, returned to the card |
| 2 | The `{bookingKind, bookingId}` index of card refund rows was never queried | Dropped (`npm run sync-indexes` removes it where it was built) |
| 3 | Three maps from booking kind to context strings (`cardKindOf`, `walletReferenceOf`, `payContextOf`) | One table in `assisted/cardRefunds.ts` (`BOOKING_KINDS`: collection, card payment context, wallet reference type); `cardContextOf` / `cardKindOf` / `bookingModelOf` read it, and so do the card machinery's kinds and the lab service's payment context |
| 4 | Stuck money's `lateCaptures` items did not say which kind of booking | They add `bookingKind` (`booking` for rows from before r14) |
| 5 | "Pay now" from the booking page lacked the amount for Checkout | The booker view's `payment` (lab bookings and consultations alike, the one `bookerPayments`) adds `amountMinor` and `currency` while the booking waits (null when no order is open yet) |

### 24.15 Round 2a leftovers (r11b, 2026-11-25)

Branch `m0/r11b-phase2a-fixes` at `7d99f2cf` (stage `f5f171c9` + r10h `a18adba7`). Local commits only. Checks:
`test/assisted/r11b-phase2a-fixes.integration.ts` (4 checks; all fail on `7d99f2cf`).

| # | Finding | Fix | Check |
|---|---|---|---|
| 1 | `notes` on the lab create was validated and hashed but never stored or shown (the web sends none) | Dropped from the lab create's validation (an unknown key is stripped) and from its request hash (§24.11 updated). A key used before this change with `notes` in its hash answers 409 `IDEMPOTENCY_KEY_REUSED` on a replay — only a replay within minutes of a deploy could meet it | 1 |
| 2 (patient data) | During an open "this isn't mine" report the account holder could still read the lab report files | `file/access.ts` `canReadPartnerLabReport`: the holder reads a released report only while no report is open (the existing `notDisputed` rule); the booking partner and the lab keep their access; a dismissal gives it back, a move gives it to the new holder | 2 |
| 3 | Some lab-booking notices had no `data.bookingKind` | The lab notifier (`defaultLabNotifier`, every customer notice of a lab booking) and the patients' moved-off / moved-to notices carry `data.bookingKind: 'lab_booking'` (`tellBooker` already did) | 3 |
| 4 | Small gaps | The patient's cancel and the patient's accept of a lab's new time are audited (`assisted_audit_events`, actor `customer`, in their transaction); the patient's accept tells the booker ("The patient accepted the new time", key `assisted:lab:<id>:reschedule:<version>:accepted:booker`) — the patient's accept now runs through the booker's accept (one compare-and-set, one transaction). The lab's view of a booker cancellation shows `byKind: 'booker'` without the pharmacy's id (`by`) | 4 |
| 5 | Dedupe of the patient helpers in `consultations.ts` | **Not done here** (coordinator, 25 Nov): phase 2c is generalising `assisted/patient.ts`; one dedupe round follows after 2c merges | — |

Merge note (`m0/r19-stage-next`): phase 2c made the request content shared with the lab desk (`labRequestContent`), and
the desk keeps its notes. So the pharmacy hash keeps a `notes` field that is always null (the validator strips the key):
keys used before r11b without notes still replay; a key used with notes answers 409 `IDEMPOTENCY_KEY_REUSED`, as above.
The desk's `notes` rule and type moved into its own schema and input (`assisted/validation/labDesk.ts`, `LabDeskInput`).

### 24.16 Patient data on lab desk rows (r19b, 2026-11-25)

On `m0/r19-stage-next` before the stage push. Check: the r19b check of `test/assisted/r12-phase2c.integration.ts`.

| # | Finding | Fix |
|---|---|---|
| 1 (patient data) | The holder of a DESK row with an open "this isn't mine" (r12b) could still read its released report files: the report access looked at the `assisted` block only | `file/access.ts` `canReadPartnerLabReport` also selects `desk.identity.disputed`; the holder reads only while neither block has an open report (`labNotDisputed`, the row form of `LAB_NOT_DISPUTED_QUERY`). The lab keeps its access; a dismissal gives it back |
| 2 (patient data) | A desk row moved to another account showed the new holder the bill made out to the old one | The admin move of a desk row is refused while it has an OPEN bill: 409 `LAB_BOOKING_BILLED_CANCEL_FIRST` ("cancel the bill first"). The patient's lab-booking views show `bill` only when the bill's `customer.userId` is the reader (otherwise `bill: null`); the lab's views are unchanged |

### 24.17 Round 2e build record: a lab books a doctor consultation (r21, 2026-11-25)

Branch `m0/r21-phase2e` from `b0b9589c` (the stage line `m0/r19-stage-next`: r10h with r10g, 2c, 2b, 2d and 3d), then
aligned with the stage line (§24.17.5): `m0/r19-stage-next` at `037bd9fb`, the stage merge of round 3e `f7f57ad2` and
r17b `bea93b02`. Local commits only. Built §24.8 under the owner's rules of
25 Nov:
- **no duplicated code:** the pharmacy consultation booking is generalised over a booker, not copied;
- **no blocking limits** except the hourly lookups;
- **a minimal API.**

Where this section and §24.8 differ, this one wins.

Check: `test/assisted/r21-phase2e.integration.ts` (16 checks over HTTP with the real routes, a stand-in Razorpay and refund
gateway, and a stand-in PDF converter). The pharmacy behaviour is proven unchanged by the 1a, 1b, r10*, 2a, 2b, 2c, 2d and 3d
suites (full regression below).

A mutation run, one break at a time:
- the wallet refund paying pharmacies only fails the six lab refund checks;
- booker notices sent to the lab id instead of the member fail "patient cancel";
- no lab case in the copy rule fails "dispensing copy";
- the payment service not admitting the paying lab fails "card".

#### 24.17.1 What was built

| Area | Where | What |
|---|---|---|
| The booker | `assisted/bookers.ts` (new) | `BookerActor` = a pharmacy (1a) or a lab member at one of its branches (`kind: 'lab'`, `partnerId`, `memberId`, `branchId`, the admitted `PartnerActor`). Everything that differs lives here: request keys and claim scopes (pharmacy strings byte-identical; lab `assisted:lab:<partner>:<member>:<key>`, scope `assisted_consult_create:lab:<partner>:<member>`); the switch (`assertBookerOn`); the admission and "nearby" origin (`bookerOrigin`: a lab must be active and verified, the branch active, of this lab, in the member's scope); the `bookedBy` block (`actorKind: 'member'`, `branchId`); the audit (`auditBookerIn`); the link to the holder (`linkBookerIn`: pharmacy-customer link, or the lab's `assisted_links` row); the booker-notice recipient (`bookerNoticeUserId`: the pharmacy, or the booking member, because partner notices are read per member); which bookings a booker acts on (`bookerBookingsFilter`: a lab's, at branches in the member's scope) |
| Wallet dispatcher | `assisted/bookerWallet.ts` (3e's file, extended) | 3e's `postBookerMovementIn({ payerKind, payerId, kind, amountPaise, … })` with its signature kept (2d D12): a booker's debit and refund go to the pharmacy store or, new, the lab store (`debitLabWalletIn` with its S5 check, `refundLabWalletIn`); it answers the posted entry. A doctor payer still answers 501 `PAYER_NOT_SUPPORTED` (3e). 3e's `bookerEntryLotsIn` (the lots a debit used) and r17b's `bookerEntriesOf(payerKind, payerId, operationKey)` (reconciliation: `{ amountPaise, payerId }`, index reads only) read the lab store too; `assertBookerWalletIndexes` is new. Every caller uses it: the consultation create, 3e's instant create and refunds, the wallet refund of consultations and lab bookings, the card refund to the wallet (booker's choice and admin fallback) |
| One consultation create | `assisted/consultations.ts` | `createAssistedConsultation(booker, input)` replaces `createPharmacyConsultation`. It uses the shared patient steps of `assisted/patient.ts` (`preparePatient`, `writePatientIn`, `countPhoneUse`, `redeemCouponIn`, `patientIdentity`, `cleanName`) and 3e's coupon check (`assistedCouponFor`). A lab row: `source: 'lab_assisted'`, no `pharmacyId`, funding `payerKind: 'lab'`, `lifecycle.paid.by: 'lab_wallet'`. The request hash adds `branchId` only for a lab (pharmacy hashes unchanged) |
| Commands | `assisted/pharmacyCommands.ts` | The masked lookup, doctor list (nearby = the member's branch), doctor slots, booker cancel and reschedule, by-key and abandon take any booker (a 1a pharmacy actor still works). `bookings/holds.ts`: `assistedBooker: 'pharmacy' \| 'lab'` |
| Views and names | `assisted/bookerView.ts`, `assisted/names.ts`, `assisted/services/pharmacyBookings.ts` | The booker view takes a booker (`BookerLike`: a pharmacy id as before, or `{ kind, id }`). A lab's names rule (`labFacingHolders`): the name typed on its `assisted_links` row, else masked; never the account name (L15). `holder` has no pharmacy-customer id for a lab. One list and detail service (`listBookerBookings`, `getBookerBooking`) for any booker |
| Refunds | `assisted/refunds.ts`, `assisted/labRefunds.ts`, `assisted/cardRefunds.ts`, `assisted/model` | One wallet refund step for consultations and lab bookings (`refundWalletFundingIn`, any payer kind; always posts). Card refund rows store `payerKind` (`'pharmacy' \| 'lab'`; older rows read as pharmacy). Admin rows and stuck money's card chargebacks add `payerKind`, `payerId`, `payerName` (pharmacy rows keep `pharmacyId` / `pharmacyName`). The card dispute alert and audit name the paying organisation |
| Card payments | `assisted/cardPayments.ts`, `payment/services` | The order names the payer by kind (`payerPartnerId` + `payerMemberId` for a lab). The capture checks the payer by kind (`recordPayerOf`). Late and extra captures queue rows for the right payer. `bookerPayments` serves any booker. The payment service lets the paying lab verify an assisted card record (`payerPartnerId`) |
| Verify and reconcile | `partnerWallets/routes.ts`, `partnerWallets/service.ts` | 2d's `POST /partner-workspace/assisted/payments/verify` and `/reconcile` also settle a consultation card payment of this lab. The guard admits `wallet.manage` or `assisted.book`, and the service checks the one the record needs. A top-up answers the wallet; a booking answers the lab's booker view |
| Prescription (decision G) | `file/access.ts`, `assisted/dispensingCopy.ts`, `specialistPortal/services` | The doctor's save makes the dispensing copy for a lab-made consultation too (`bookerOfBooking`), naming the patient by the lab's names rule. `canReadDispensingCopy` case `partner`: a member of the booking lab holding `assisted.book` with the booking's branch in scope, while the lab is active and verified, only the current copy, within 90 days of the consultation. The full PDF, documents and report: never (`canReadBooking` admits no partner) |
| Elsewhere | `meet/service`, `assisted/review.ts`, `assisted/reconciliation.ts`, `assisted/labViews.ts`, `partners/services/labBookings.ts`, `partners/types` | Meet invites the lab's `contact.email` when the lab's device joins. The admin move carries the lab's link (`moveLabLinkIn`). Every booker notice goes to `bookerNoticeUserId`. Reconciliation reads the payer's own store. `labAdmissible` moved to the pure `labViews.ts` (re-exported from `labBookings.ts` for its callers). The link helper is shared by the desk and 2e (r12b's `linkLabIn`, §24.17.5). New permission `assisted.book` |
| Routes | `assisted/routes/labBooker.ts` (new), `assisted/controller/phase2e.ts` (new), `partners/routes/index.ts`, `assisted/validation` | Registered inside the partner workspace like the desk (members, and admins acting as owner). Lab bodies add `branchId` (`labConsultationSchema`, `labDoctorQuerySchema`, `labDoctorSlotsQuerySchema`); the pharmacy schemas are unchanged |

#### 24.17.2 Choices made while building (ASSUMED r21, reversible)

| # | Choice | Why |
|---|---|---|
| F1 | A lab member's actions are audited in `assisted_audit_events` (`actorKind: 'member'`, `orgKind: 'lab'`), not in `PartnerAuditEvent` as §24.8.1 said | One trail for every booker; reconciliation and admin reads already use it; as 2d D6 |
| F2 | `branchId` is required on the create and the doctor reads, even for a member with one branch | Explicit is safer than a guessed branch; "nearby" and `bookedBy.branchId` depend on it |
| F3 | Admins acting as a lab's owner can use the same routes (the workspace mirror, as the desk) | One registration; an admin booking records `actorId: admin:<id>` |
| F4 | Booker notices (cancelled, not mine, moved) go to the booking member only (L17); other members see the list | Partner notices are per member |
| F5 | A member lists and acts on bookings made at branches in its scope; owners see all | §24.8.2 branch scope |
| F6 | A lab sees the typed or the masked name; there is no typed-name edit route for labs | Names rule (L15); a minimal API |
| F7 | Every 2e route needs an operational (verified) lab, cancel and reads included, as every pharmacy route needs an operational pharmacy. Patient, doctor and admin cancels still refund the lab, and the refund always posts | The S5 pattern of the pharmacy side |
| F8 | One verify/reconcile route pair for top-ups and booking payments; a top-up needs `wallet.manage`, a booking payment `assisted.book` | A minimal API |
| F9 | A lab never books another lab's tests: the lab-test booking routes stay pharmacy-only (a lab member gets 403) | Decision |
| F10 | The request hash adds `branchId` only when present | 1a hashes and keys stay byte-identical |
| F11 | Card money returned to a lab's wallet opens no lot (not withdrawable), as for pharmacies (C3) | C3 |

#### 24.17.3 API for the web

Lab workspace (partner member token holding `assisted.book`; the lab must be active and verified; `{ success, data }`,
`Cache-Control: private, no-store`; money in paise). The same bodies and answers as the pharmacy routes of §19.3,
§20.2, §21.2 and §23.3, with `branchId` where noted:

| Route | Request | `data` |
|---|---|---|
| `POST /api/v1/partner-workspace/assisted/patients/lookup` | `{ phone }` | `{ exists, holderNameMasked }` (counted against the lab's hourly lookups) |
| `GET …/assisted/doctors` | `?branchId (required)&speciality&mode&language&date&limit` | as §19.3; `nearby` against that branch's pincode and city |
| `GET …/assisted/doctors/:doctorId/slots` | `?branchId (required)&from&days&mode` | as §20.2 |
| `POST …/assisted/consultations` | §19.3 body + `branchId` (required); `paymentMethod: 'wallet' \| 'razorpay'` | 201 (replay 200) `{ booking, funding, split, payment?, newAccount, replayed }` as §19.3 / §23.3 |
| `GET …/assisted/bookings`, `GET …/assisted/bookings/:id` | `?status&from&to&cursor&limit` | the booker view (as §17.2 / §23.3: `patientName`, `holder: { name, typedName }`, `assisted`, `payment`, the Join call window, `prescription` with the dispensing copy for 90 days); list `pagination: { total, nextCursor }` |
| `GET …/assisted/bookings/by-key/:key`, `POST …/by-key/:key/abandon` | — | Q13 shape |
| `POST …/assisted/bookings/:id/cancel` | `{ reason?, expectedUpdatedAt?, refundTo?: 'card' \| 'wallet' }` | `{ booking, refundedMinor, alreadyCancelled, refund? }` (any time before the start) |
| `POST …/assisted/bookings/:id/reschedule` | `{ slotId, requestKey, expectedUpdatedAt? }` | `{ booking, replayed }` |
| `POST …/assisted/payments/verify`, `/reconcile` (2d's) | as §24.13 | a consultation payment: `{ context: 'assisted_booking', paymentRecord, entity: <booker view> }` |

**Errors** (besides the pharmacy ones):
- 400 `VALIDATION_ERROR` (no `branchId`);
- 403:
  - `INSUFFICIENT_PERMISSIONS` (no `assisted.book`);
  - `BRANCH_SCOPE_EXCEEDED`;
  - `LAB_PARTNER_REQUIRED` (a clinic);
  - `PARTNER_NOT_VERIFIED`, `PARTNER_INACTIVE`;
- 404 `BRANCH_NOT_AVAILABLE`;
- 409 `INSUFFICIENT_BALANCE`, `WALLET_FROZEN`, `WALLET_RECEIVABLE` (the lab wallet);
- 503 `ASSISTED_BOOKING_DISABLED` (lab switch off).

The dispensing copy opens through `/api/static/…` with the member's token.

**Patient app:** "Booked and paid by <lab>". A patient's cancel refunds the lab.

**Doctor app:** unchanged; the doctor sees "Booked by <lab>" and the identity note.

**Admin:** card refund rows and stuck-money card chargebacks add `payerKind`, `payerId` and `payerName` (pharmacy rows
keep `pharmacyId` / `pharmacyName`).

#### 24.17.4 Switches, indexes, deploy, rollback

- **Switches.**
  - `ASSISTED_BOOKING_ENABLED_LAB` (2d's lab switch, off unless exactly `"true"`) now also gates the lab's lookup, doctor
    reads and new consultations (503 when off).
  - A card booking also needs `ASSISTED_CARD_PAYMENT_ENABLED`.
  - Reads, cancel, reschedule, refunds, verify, reconcile and the sweeps always run.
- **Indexes.** No new index. A lab create checks the partner-wallet indexes (2d) instead of the pharmacy ledger's, plus
  the 1a booking indexes.
- **Migration:** none.
- **Permissions.** Owners hold `assisted.book`; they grant it to staff (never by migration).
- **Order:**
  1. deploy;
  2. `npm run sync-indexes` (2d's, if not yet run);
  3. owners grant `assisted.book`;
  4. `ASSISTED_BOOKING_ENABLED_LAB=true` (already on where 2d top-ups are live: then lab bookings are live at the restart);
  5. restart.
- **Rollback:** the switch. Never roll the code back below r21 while a lab-made consultation is open:
  - older code refunds a lab-paid booking to nobody (its refund step pays pharmacies only);
  - older code cannot verify a lab's card payment.

  Check: `db.bookings.countDocuments({ source: 'lab_assisted', status: { $in: ['pending', 'confirmed'] } })` = 0.

#### 24.17.5 Alignment with the stage line and round 3e

Merged, in order: `m0/r17-phase3e` (`b32f0007`, first, then superseded where it differs), `m0/r19-stage-next` at
`037bd9fb` (r14b, r16b, r11b, r12b, r10i), `f7f57ad2` (the stage merge of round 3e, which push 2 and 3b build on) and
`bea93b02` (r17b). Where two rounds made the same helper, ONE copy is kept, in `f7f57ad2`'s direction:

| What | Kept | Changed for it |
|---|---|---|
| Patient steps | r12's `preparePatient` / `writePatientIn` (they already carry `chosenById` and `createdSource`), as `f7f57ad2` | 3e's `planAssistedPatient` / `applyPatientPlanIn` are gone. Every create uses r12's: the 1a/2e consultation, the 2a lab booking, the 2c desk and the 3e instant request (`f7f57ad2`'s `instant.ts`) |
| Lab link to the holder | r12b's `linkLabIn` (`assisted/patient.ts`) | 2e's `linkAssistedIn` is gone; `linkBookerIn` (2e) calls `linkLabIn`. One `moveLabLinkIn` (`assisted/review.ts`) serves desk rows (r12b) and lab-made consultations (2e): the old link goes when no other desk row or lab-made consultation of that lab names the holder |
| Wallet dispatcher | 3e's names and signature (`postBookerMovementIn`, `bookerEntryLotsIn`, `bookerEntriesOf`) plus the lab store; `BookerMovement` names only `booking_debit` and `refund_credit` | 2e's callers pass `amountPaise` and read `posted.entry._id`. `bookerEntriesOf(payerKind, payerId, operationKey)` as r17b, answering `{ amountPaise, payerId }` with index reads only: the pharmacy's `{ pharmacyId, operationKey }`; the lab's wallet by `{ ownerKind, ownerId }`, then `{ walletId, operationKey }`. Every reconciliation check passes the payer. 2e's `bookerDebitAllocationsIn`, `bookerEntriesByKey`, `PayerKind` and 500 `UNSUPPORTED_PAYER` are gone |
| Coupon check | 3e's `assistedCouponFor(code, ctx)` | The consultation create calls it for every booker |
| Short reference | `consultations.ts`'s `newShortRef` | The 2a lab create's private copy is gone (`aa3016ed`) |
| Wallet refund of lab bookings | 2e's `refundWalletFundingIn` (any payer kind) | 3e's "`labRefunds.ts` credits pharmacies only" is settled |
| Everything else | Both sides: 3e's instant routes, switch, audit action, reconciliation and error details; r16b's POST recommendation lookup; r12b's notice recipients of lab rows (`labOrigin`) | — |

Doc numbering: r11b's record keeps §24.15 and r19b's §24.16, so this record is §24.17; r16b's §25.12.7 stays in the 3d record (§25.12) and
3e's record is §25.13.

#### 24.17.6 Checks after the alignment

- On `19c33187` (after all three merges), each suite alone on its own database: `r21-phase2e` 16/16, `r17-phase3e`
  25/25, `r11-phase2a` 26/26, `r12-phase2c` 26/26, `phase1a` 30/30. tsc 17 (unchanged).
- Before the alignment, the full regression on the first 3e merge `b32f0007` (`prun.sh … 2`) passed 74 of 75; the one
  failure, `r8-before-production`, was a load flake (503 `AUTH_STATE_UNAVAILABLE`, the 2-second sign-in state read) and
  passes alone (7/7).
- The full regression on `19c33187` (`prun.sh … 2`): 75 of 76 pass; tsc 17. The one failure, `s2-booking-read-scope`,
  was the same load flake (503 `AUTH_STATE_UNAVAILABLE`) and passes alone (12/12).

#### 24.17.7 Review fixes (r21b, review of `78020e07`)

Merged first: `8b0d5ab8` (r19b, §24.16). Checks: `test/assisted/r21-phase2e.integration.ts` (now 18: two new checks and
one new assertion in "card"). Each suite alone: `r21-phase2e` 18/18, `r17-phase3e` 25/25, `r11-phase2a` 26/26,
`r12-phase2c` 27/27, `phase1a` 30/30, `r14-phase2b` 24/24. tsc 17.

| # | Finding | Fix |
|---|---|---|
| 1 (must, patient data) | `POST …/assisted/payments/verify` and `/reconcile` answered the booker view with its prescription (medicines, advice, tests) to a member scoped to another branch, and to a lab whose verification was revoked, while the booking detail route refuses both | `partnerWallets/service.ts` `entityView`: a member outside the booking's branch scope gets `{ _id, status, paymentStatus }` only; otherwise the booker view with `clinical: labAdmissible(<lab>)` (no prescription unless the lab is active and verified). The member's scope is read once with its permission (`memberMay`) |
| 2 (must) | A clinic (and an unverified lab) could use the lab patient lookup, and a lab create counted and audited the phone before it was refused | `assisted/bookers.ts` `admitLabBooker` (an active, verified lab; 403 `LAB_PARTNER_REQUIRED` / `PARTNER_NOT_VERIFIED`) is split out of `bookerOrigin`. The lookup calls it before counting; the create now runs `bookerOrigin` (admission and branch) before `countPhoneUse` and the `booking.attempted` audit |
| 3 (must, index rule) | A lab create relied on the `assisted_links` unique key (`linkLabIn` upserts on it) without checking it | `assertAssistedIndexes` checks `{ bookerKind, bookerId, userId }` for a lab payer (503 `INDEXES_OUTDATED`) |
| 4 | A lab card booking's `lifecycle.paid.by` said `pharmacy_card` | `<payer kind>_card` from the payment record (`lab_card`) |
| 5 | Two audit-actor helpers | One: `bookerAuditFields` (`assisted/bookers.ts`), used by `auditBookerIn` and the card capture audits (`auditActorOf` is gone) |

**Seen, not changed:** the desk's `labOf` / `deskBranch` (`assisted/labDesk.ts`) and `admitLabBooker` / `bookerOrigin` check
the same lab and branch rules with different answers (the desk: 404 `PARTNER_NOT_FOUND`, a visit-mode check, its own
messages). Merging them changes the desk's answers, so it is left for a desk round.

## 25. Phase 3 build specification (doctors) (r15, 2026-11-25)

Design only; nothing here is built. Base: `f5f171c9` (the stage line with round 2a, r11). Rounds 2b, 2c, 2d and 2e are being
built on other branches. Where a round below needs one of them, it names the §24 contract it relies on, not code that does
not exist yet. Every `file:line` is under `src1/modules/` at `f5f171c9` unless it says otherwise. Where this section and an
earlier one differ, this one wins.

Phase 3 adds three new pieces: the recommendation code, the treating window and the records grant. Everything else reuses
what phases 0–2 built:
- the `assisted` block (`assisted/types.ts:63-81`);
- request keys claimed in the transaction, `requestHashOf` hashes and by-key / abandon routes;
- `assertUniqueIndex` fail-closed 503;
- the booker wallet ledger with operation keys and lots (2d's `postPartnerMovementIn` and `postBookerMovementIn`, §24.7.1);
- card refund rows and their worker;
- the hourly lookup limit (`assisted/limits.ts:61-67`);
- the audit in the same transaction;
- notices after the commit (`assisted/support.ts:42-46`).

### 25.1 Owner decisions this section builds (not reopened)

1. **Book or recommend.** A doctor can **book** a lab test for a patient, **recommend** tests, or both.
2. **Report access.** A doctor who only recommended does **not** see the report. A doctor who booked sees the released
   report like a pharmacy: released files only, for 90 days.
3. **Doctor wallet.**
   - Top-up by Razorpay.
   - The wallet pays bookings, and refunds go back into it.
   - Withdrawals are phase 4 (built later, switched off).
   - The doctor collects from the patient at its own counter.
4. **Cuts.** The doctor's referral cut is a setting that stays **off (0)** until legal advice. Phase 3 stores the split
   fields with cut 0 and `referral: null`; phase 4 builds cuts.
5. **History.** Doctors see the patient's past consultations and reports while treating. Pharmacies and labs see only
   their own bookings.
6. **Recommendation code.** Recommended tests get an 8-character code with a check character, printed with the Jansetu
   brand on the prescription PDF. `testsAdvised` stays filled for older readers.
7. **Partner "Consult now".** Partners book scheduled and instant consultations, as doctor availability allows.
8. **Verified doctors only (S5).** An unverified or inactive doctor is blocked from everything. Re-verification restores
   access.
9. **Limits.** No blocking limit except the phone lookups (120 an hour per organisation). Cancellation and same-pair
   counts stay alerts only (r10g). No other limit is added.
10. **Names.** The real account name is shown only on `customer_order` links.
11. **SMS** is phase 5: comments at the call sites only.

### 25.2 The split, and why it differs from the suggestion

The suggestion was five rounds: wallet, doctor → lab, recommendations, instant, treating window. The code changes three
things:

- **Card payment for doctor lab bookings is its own small round (3c).** It rides on 2b's new payment context
  `assisted_lab_booking`, which is not merged yet. The wallet path (3b) needs nothing from 2b, and keeping card money in its
  own review is how 1a/1b and 2a/2b were done.
- **Partner instant consults are wallet-only in phase 3 (3e; question Q2).** Instant money lives on the request, and the
  accepted fee can be lower than the quote (`allocateFunding`, `doctors/services/instant.ts:47-64`), so a card-paid request
  would need a **partial** card refund of the difference. Today every assisted card refund is the full capture (§23.2 C12),
  and refund rows are unique per capture (`captureKey`, §23.6 r10e). A partner card payment for instant would therefore be
  a new money pattern. Partners who pay by card top up their wallet by card instead.
- **The treating window comes last (3f).** It changes `file/access.ts` and the doctor's history. 3b (report access) and 3e
  (instant bookings) change the same places first.

| Round | Content | Depends on | Size |
|---|---|---|---|
| **3a** | Doctor wallet on 2d's `partner_wallets` (`ownerKind: 'doctor'`): Razorpay top-up with lots, verify/reconcile/check, recovery sweep, admin wallet tools | 2d | S–M |
| **3b** | Doctor → lab test paid from the **doctor wallet**: patient from the doctor's own consultation or by phone; booker lab list and detail; cancellations and refunds to the doctor wallet; doctor report access (released, 90 days) | 3a, 2a, 2c (`assisted_links`), 2b merged first (same files) | M |
| **3c** | Doctor → lab test by **card/UPI** on 2b's context | 3b, 2b | S |
| **3d** | **Test recommendations**: the code, the PDF box, loading by code and phone, linking lab bookings (customer, pharmacy, lab desk, doctor) | 2a, 2c; after 3b so the doctor create links too | M |
| **3e** | **Partner instant "Consult now"**, wallet-paid: pharmacy now, lab once 2e is merged | 1a/1b; 2d + 2e for labs | M |
| **3f** | **Treating window, read log, records-access approvals and grants**; doctor history; file access | 3b, 3e (shares `file/access.ts`, the instant bookings) | M |

**Build order:** 3a → 3b → 3c, with 3d after 3b. 3e can run beside 3a–3d: apart from the instant files it makes only small,
separate edits in `assisted/bookerView.ts`, `assisted/review.ts` and `assisted/reconciliation.ts`. 3f comes last. Rounds that touch `partners/model/labBooking.ts` (3b, 3d) go one after the other, never at
the same time as 2b or 2c.

Each round is backend, an integration suite and an independent review (Opus xhigh). Commits stay local; stage only on the
owner's word (§13).

### 25.3 Shared rules for every round

- **Doctor admission.**
  - Every new doctor route has `requireSpecialist` + `requireEligibleDoctor` (`specialists/eligibility.ts:29-37`; 403
    `SPECIALIST_NOT_VERIFIED`).
  - Every writer re-reads the doctor inside its transaction (`isEligibleDoctor`, `:12-13`), as `reserveSlot` does (§20.1),
    and answers the same 403 when the doctor became ineligible meanwhile.
  - **Exception: money already paid is never stranded.** Top-up verify, reconcile and check always credit. Every refund
    credit always posts.
- **Doctor actor.** `DoctorActor = { kind: 'doctor', specialistId }`. The doctor is both the organisation and the actor
  (no staff).
  - Lookup organisation key: `doctor:<specialistId>`.
  - Audit: `assisted_audit_events` with `actorKind` and `orgKind` `'doctor'`. Both enums already allow it
    (`assisted/model/index.ts:26-28`, `:39-41`).
- **Notices to a doctor** go through `sendAssistedNotices` with `userId` = the specialist id. Specialist notices are keyed
  by that id (`notification/services/index.ts:331-333`).
- **Money.**
  - Amounts are integer paise.
  - Every booker wallet movement goes through 2d's dispatcher `postBookerMovementIn({ payerKind, payerId, … })`.
  - A credit **always posts**, whether the wallet is frozen or inactive or the doctor is ineligible.
- **Keys.**
  - Request keys use `ASSISTED_KEY` (`assisted/consultations.ts:43`).
  - The hash comes from `requestHashOf` and never includes the payment method.
  - Same key and hash → 200 `replayed`. Other content → 409 `IDEMPOTENCY_KEY_REUSED`. Abandoned → 409 `REQUEST_ABANDONED`.
- **Fences.** Later steps carry `expectedVersion` (lab `statusVersion`), `expectedUpdatedAt` (consultations) or
  `expectedStatusVersion` (instant requests).
- **Indexes.** Each writer calls `assertUniqueIndex` on every unique index it relies on, before any read that counts or
  holds. Until `npm run sync-indexes` has run, it answers 503 `INDEXES_OUTDATED`.
- **Switches** are read on every call and are off unless exactly `"true"` (`assisted/flags.ts:14`). Off stops only NEW
  bookings, top-ups, lookups and requests. Reads, cancellations, refunds, verify, reconcile and the sweeps always run.
- **Patient order** (§24.3, review 4 of 1a):
  1. validate;
  2. replay first;
  3. count the lookup and audit `booking.attempted`;
  4. abandoned key;
  5. every refusable check, with one answer for known and unknown numbers;
  6. ONE transaction, which also opens a new number's account.
- **Names.**
  - Pharmacies keep their rule (`assisted/names.ts:31`).
  - Labs and doctors see the name typed on their own `assisted_links` row (2c, `bookerKind: 'lab' | 'doctor'`), else the
    masked name. They never get the account name through assisted routes.
  - The doctor's own appointment views are unchanged.
- **Cut 0.** `split.cutMinor` is 0 and every `split.lines[].cutMinor` is 0. `assisted.referral` is `null`.
- **SMS hooks.** A comment `// SMS phase 5: <message>` at the call site, and nothing else.

### 25.4 Round 3a: doctor wallet

#### 25.4.1 Data model

- **No new store.** 2d's `partner_wallets` and `partner_wallet_entries` (§24.7.1) take `ownerKind: 'doctor'` and
  `ownerId` = the specialist id (lower-case hex).
- **Lots.** Top-up lots use the shared `wallet_topup_lots`, which already allows `walletRef.kind: 'doctor'`
  (`pharmacyWallet/model/lots.ts:10`, `:30`).
- **`PaymentRecord`** gains `payerSpecialistId`:
  - types: `payment/types/index.ts:9`, `:54`, `:82`;
  - model: `payment/model/index.ts:15`;
  - index `{ payerSpecialistId: 1, createdAt: -1 }`, partial on string.
- **Earnings and the wallet never mix.** The doctor's earnings (`doctors/services/earnings.ts`, settlement ledger) never
  fund a booking, and a wallet credit is never an earning (ASSUMED DR2).

#### 25.4.2 Routes

**Doctor.** A sub-router `specialistAssistedRouter` is mounted at `/me/assisted` in `specialists/routes/index.ts`, beside
the other `/me/*` routes and before `/:id` (`:234`). Guards: `requireSpecialist`, `requireEligibleDoctor`.

| Route | Request → answer |
|---|---|
| `GET /api/v1/specialists/me/assisted/wallet` | `{ balanceMinor, withdrawableMinor, receivableMinor, frozen, isActive, updatedAt }`. Zeros when there is no wallet; nothing is created |
| `GET …/wallet/entries` | `?cursor&limit≤50` → `[{ _id, kind, amountMinor, balanceAfterMinor, description, referenceType, referenceId, at }]`, `nextCursor` |
| `POST …/wallet/topups` | `{ amountMinor (integer ≥ 100), requestKey }` → `{ paymentTransactionId, razorpayOrderId, razorpayKeyId, amountMinor, currency, replayed }` |
| `POST …/wallet/topups/:paymentTransactionId/check` | **Without** `requireEligibleDoctor`. → `{ state: 'credited' \| 'unpaid' }`, plus `wallet` for an eligible doctor. Another doctor's record: 404 |
| `POST /api/v1/payments/verify`, `/reconcile` (existing) | Specialist tokens already pass the router (`src1/routes/index.ts:99`). `entity` = the wallet view (state only for an ineligible doctor) |

**Admin.** On `adminAssistedRouter` (`assisted/routes/phase1a.ts:42`); the writes need `ASSISTED_ADMIN_TOOLS_ENABLED`.
- `GET /api/v1/admin/doctors/:specialistId/wallet`, `/wallet/entries` and `/wallet/lots`.
- `POST …/wallet/topup`:
  - needs the `Idempotency-Key` header;
  - body `{ amountMinor, notes? }`;
  - non-withdrawable;
  - `operationKey: 'admin_topup:<key>'` with `requestHash` (§20.6 item 4).
- `GET …/wallet/topups/by-key/:key` (§21.3 shape).
- `PUT …/wallet/freeze` `{ frozen, reason }`.
- The existing lot chargeback, payment chargeback and close-compensated routes (`assisted/routes/phase1a.ts:53-58`) route
  by `lot.walletRef.kind` and `notes.flow`. 2d makes them handle `lab`; 3a adds `doctor`.

#### 25.4.3 Money

- **Top-up order.** As `pharmacyWallet/services/index.ts:83-95`:
  - `context: 'wallet_recharge'`, `contextId: doctor_<specialistId>_<ms>`;
  - `userId` = `payerUserId` = `payerSpecialistId` = the doctor;
  - `notes.flow: 'doctor_wallet_recharge'`.

  One order per (doctor, request key): claim scope `wallet_topup:doctor:<specialistId>`, hash `{ amountMinor }`. A replay
  answers the same order.
- **Credit.** 2d's `isPartnerWalletRecharge` (beside `isPharmacyWalletRecharge`, `payment/services/index.ts:1615-1621`)
  also recognises the doctor flow:
  - `postPartnerMovementIn({ ownerKind: 'doctor', kind: 'credit', operationKey: 'wallet_recharge:<recordId>' })`;
  - the same `walletCreditedAt` claim;
  - records with `chargebackAt` or `compensatedAt` are refused;
  - a lot holding the Razorpay fee is written while `ASSISTED_BOOKING_ENABLED_DOCTOR` is on and the lot index exists.
- **Never the customer wallet.** Today `processWalletRechargePayment` (`:1888-1890`) and the entity read (`:1161`) send
  every `wallet_recharge` record that is not a pharmacy one to `ensureWalletRechargeTransaction`, which credits the
  CUSTOMER wallet of `userId`.
  - A doctor-flow record must be routed before that default.
  - If the doctor wallet cannot be credited, the call fails, and the sweep retries it. It never credits a customer wallet
    (DR5).
- **Recovery.**
  - The sweep (`:2019-2020`) adds `{ context: 'wallet_recharge', 'notes.flow': 'doctor_wallet_recharge', createdAt ≥
    WALLET_RECHARGE_SWEEP_FROM }`.
  - The uncredited list (`assisted/reconciliation.ts:151`) covers doctor top-ups.
- **Verification.** `getPaymentRecordForVerification` (`payment/services/index.ts:778-779`) already admits the doctor,
  because `payerUserId` is the doctor. 3a adds an explicit rule: a doctor-flow record is verified only by the specialist
  whose id is `payerSpecialistId`, or by an admin.
- **Withdrawals:** none (phase 4; `WALLET_WITHDRAWALS_ENABLED` stays unread).
- **Reconciliation:** 2d's `walletInvariants` covers doctor wallets: balance = Σ entries, withdrawable = Σ eligible lots,
  and a receivable implies frozen.

#### 25.4.4 Permissions, keys and indexes

- A doctor reads and tops up only its own wallet. An ineligible doctor gets 403 on wallet reads and new top-ups; the check
  route and verify still credit (DR3).
- **Indexes:**
  - 2d's `partner_wallets {ownerKind, ownerId}` and `partner_wallet_entries {walletId, operationKey}`, both unique;
  - `wallet_topup_lots {paymentRecordId}` unique;
  - `request_keys {scope, key}` unique;
  - new: `payment_records {payerSpecialistId, createdAt}`.

  `assertUniqueIndex` runs before a top-up is created and before any credit.

#### 25.4.5 Switches, deploy and rollback

- **Switch.** `ASSISTED_BOOKING_ENABLED_DOCTOR` (new): top-up creation, with lots. Off → 503 `ASSISTED_BOOKING_DISABLED`
  on creation. Verify, reconcile, check, the sweep and the admin reads always run.
- **Migration:** none (2d's collections).
- **Order:**
  1. deploy with the switch off;
  2. `npm run sync-indexes`;
  3. `ASSISTED_BOOKING_ENABLED_DOCTOR=true`;
  4. restart.
- **Rollback:** the switch. Never roll the code back while a doctor top-up record is `created`, or captured but not
  credited: older code would credit a CUSTOMER wallet keyed by the doctor's id. Check:
  `db.paymentrecords.countDocuments({ 'notes.flow': 'doctor_wallet_recharge', walletCreditedAt: { $exists: false }, status: { $in: ['created', 'paid'] } })`
  = 0.

#### 25.4.6 Tests (`test/assisted/phase3a-doctor-wallet.integration.ts`)

**Top-ups and credits:**
1. Top-up → verify → one credit and a lot holding the fee. The same key gives the same order; another amount with the
   same key → 409.
2. **Race:** verify, reconcile, check and the sweep at once give one credit.
3. A doctor top-up never creates or credits a customer `wallets` row, including when the doctor-wallet write fails (that
   call fails and the sweep credits it later).
4. Another doctor's or a pharmacy's verify → 404 `PAYMENT_RECORD_NOT_FOUND`.

**Eligibility:**

5. An unverified doctor gets 403 on the wallet read and on a new top-up. A top-up it already paid is still credited
   through check. Re-verification restores the reads.

**Ledger:**

6. **Race:** two debits beyond the balance (direct ledger test): one succeeds, and the balance never goes negative.
7. A credit to a frozen or inactive wallet posts; a debit is refused.

**Chargebacks, reconciliation and regression:**

8. Lot chargeback; payment chargeback against close-compensated on a doctor top-up: either credited and charged back, or
   blocked and never credited.
9. Reconciliation: clean, then a tampered entry is flagged.
10. The 1a, 1b and 2d suites pass unchanged.

#### 25.4.7 Web screens

- **Doctor app → Wallet.**
  - Balance; "card money" (withdrawable, labelled "withdrawals coming later"); a frozen or owing banner; the entries list.
  - **Top up:** amount, then Razorpay Checkout, then verify; "Check" for a lost answer.
  - The line "Collect from your patient at your counter".
- **Admin → Doctor wallet.** Balance, entries, lots, freeze, admin top-up with the by-key check, and the chargeback and
  close-compensated buttons.

### 25.5 Round 3b: doctor → lab test, paid from the doctor wallet

#### 25.5.1 Data model

- **The booking.** A `PartnerLabBooking` with:
  - `source: 'doctor_assisted'` (the enum already has it, `partners/model/labBooking.ts:27-28`);
  - `assisted.bookedBy = { kind: 'doctor', id: specialistId, actorKind: 'doctor', actorId: specialistId, name: 'Dr <name>' }`;
  - `assisted.funding.payerKind: 'doctor'`.
- **`AssistedBlock`** (`assisted/types.ts:63-81`) gains `fromBookingId?`: the doctor's consultation the patient was taken
  from.
- **The link.** An `assisted_links` row with `bookerKind: 'doctor'` (2c's model; the enum already has `doctor`).
- No new collection.

#### 25.5.2 Generalising round 2a (no new pattern)

| Change point | Today | Phase 3b |
|---|---|---|
| Actor (`assisted/labBookings.ts:35`, `PharmacyActor`) | pharmacy only | `LabBooker = { kind: 'pharmacy', pharmacyId, actorId } \| { kind: 'doctor', specialistId }` |
| `storedLabKey`, `labKeyScope` (`:84-85`), `orgKey` (`:59`) | pharmacy | Pharmacy strings stay byte-identical. Doctor: key `assisted_lab:doctor:<sid>:<sid>:<key>`, scope `assisted_lab_create:doctor:<sid>`, org key `doctor:<sid>` |
| `createPharmacyLabBooking` (`:240-413`) | one booker | `createAssistedLabBooking(booker, input)`; the pharmacy route calls it with `kind: 'pharmacy'` |
| Link (`:359`) | `linkPharmacyCustomerIn` | doctor: the `assisted_links` row (first typed name, never overwritten) |
| Pair alert (`:361`) | `('pharmacy', …)` | `countPairBookingIn('doctor', sid, 'lab:<partnerId>')` (alert only) |
| Redemption (`:363`) | `payerKind: 'pharmacy'` | `'doctor'` |
| In-transaction re-reads (`:366`) | the lab | the lab, then the doctor (`isEligibleDoctor`) → 403 `SPECIALIST_NOT_VERIFIED` |
| Debit (`:386-389`) | `postPharmacyMovementIn` | `postBookerMovementIn` (2d), same `labDebitKey` |
| Audit (`:256`, `:390`) | pharmacy | `actorKind` and `orgKind` `'doctor'` |
| Booker view `bookerLabViews` (`:174-213`) | `mine` = pharmacy (`:186`); pharmacy names (`:180`) | `(bookerKind, bookerId)`; doctor names from `assisted_links`; `holder: { linkId, name, typedName }` |
| Own filter (`:446`) | pharmacy | `assistedBookerFilter('doctor', sid)` (`assisted/refunds.ts:28-29`) |
| **Refund** (`assisted/labRefunds.ts:37`) | credits only when `payerKind === 'pharmacy'` | **A doctor-paid row would be marked refunded with no credit.** It must go through `postBookerMovementIn`. Same rule for `assisted/refunds.ts:71`, which 2e changes for labs |
| Booker notices (`partners/services/labBookings.ts:129-133`) | `userId` = `bookedBy.id` | unchanged (the specialist id) |
| Reconciliation `labBookingChecks` (`assisted/reconciliation.ts:113`) | pharmacy wallet rows | reads the payer's entries (partner wallet for doctors) |
| Admin move (`assisted/review.ts:342`; `moveBookerLinkIn` `:295`, pharmacy only) | pharmacy link | doctor rows move their `assisted_links` row |

#### 25.5.3 The patient: two sources

Exactly one source per request; both or neither → 400 `VALIDATION_ERROR`.

1. **From the doctor's own consultation:** `fromBookingId` + `typedName`. The booking must be:
   - a consultation of this doctor;
   - not an unpaid card booking (`assisted/views.ts:20-23`);
   - without an open "not mine" report;
   - inside its treating window (the rule of §25.9.1).

   The account and the person (holder or family member) come from that booking. No phone is named, so no lookup is
   counted. The web pre-fills `typedName` from the appointment, and the doctor confirms it. Another doctor's booking, or a
   missing one → 404 `BOOKING_NOT_FOUND`. A closed window → 409 `TREATING_WINDOW_CLOSED`.
2. **A walk-in by phone:** `phone` + `patient` + `holderName?`, exactly as 2a (masked lookup; the lookup is counted; one
   answer for known and unknown numbers; the account opens in the transaction). Owner question Q4.

#### 25.5.4 Routes (doctor token; `requireEligibleDoctor`; under `/api/v1/specialists/me/assisted`)

| Route | Request → answer |
|---|---|
| `POST …/patients/lookup` | `{ phone }` → `{ exists, holderNameMasked }`; `hitLookup('doctor:<sid>')`; audited |
| `GET …/labs` | `?visitMode&limit`. 2a's list; "nearby" uses the doctor's `pincode`, then `city` (`specialists/model/index.ts:160-170`) |
| `GET …/labs/:partnerId/catalogue`, `GET …/labs/branches/:branchId/slots` | as 2a (`?visitMode&from&days≤14`; slots ≥ 60 min ahead) |
| `POST …/lab-bookings` | 2a's body (§24.11) with one patient source of §25.5.3; `paymentMethod: 'wallet'` → 201 (replay 200) `{ booking: <doctor booker lab view>, funding, split, newAccount, replayed }` |
| `GET …/lab-bookings`, `GET …/lab-bookings/:id` | `?status&from&to&cursor&limit≤50`; only rows with `bookedBy` = this doctor; otherwise 404 `LAB_BOOKING_NOT_FOUND` |
| `GET …/lab-bookings/by-key/:key`, `POST …/by-key/:key/abandon` | Q13 shape |
| `POST …/lab-bookings/:id/cancel` | `{ reason?, expectedVersion? }` → `{ booking, refundedMinor, alreadyCancelled }`. Up to 1 h before the slot, or any time while a lab reschedule is unanswered (`cancelAsBooker`, `partners/services/labBookings.ts:725-751`) |
| `POST …/lab-bookings/:id/accept-reschedule` | `{ version }` → the view (L7) |

**Errors:** 2a's (§24.11), plus:
- 403 `SPECIALIST_NOT_VERIFIED`;
- 404 `BOOKING_NOT_FOUND` (`fromBookingId`);
- 409 `TREATING_WINDOW_CLOSED`.

**Doctor booker lab view:** 2a's allowlist. `report.releases` is filled only inside L3 (90 days from the first release)
and only while the doctor is eligible.

#### 25.5.5 Report access (owner decision 2)

`canReadPartnerLabReport` (`file/access.ts:174-190`) gains a case `r.userType === 'specialist'`. All of these must hold:
- the file is **released**;
- `assisted.bookedBy.kind === 'doctor'` and its id = `specialistOf(r)`;
- `bookerReportWindowOpen` (`assisted/labViews.ts:23-26`);
- `doctorIsEligible` (`specialists/eligibility.ts:119-122`).

Drafts are never readable. Everyone else, a recommending doctor included, gets the uniform 404.

#### 25.5.6 Money

- **Debit:** `assisted_lab:<id>:debit` on the doctor wallet, in the booking transaction.
- **Refund:** one `refund_credit` of the budget, `assisted_lab:<id>:refund`, restoring the debit's lots. It always posts.
  Every cancel path reaches it through `cancelIn` (`partners/services/labBookings.ts:482-517`):
  - the doctor (1 h before the slot);
  - the patient (2 h window; the refund goes to the doctor; the notice says so);
  - a lab reject;
  - an admin.

  An admin cancel of a moved no-show without refund forfeits the money (L9).
- **Earning:** unchanged (`:842-853`): the lab earns `split.providerMinor` once, on completion.

#### 25.5.7 Switches, indexes, deploy

- **Switch.** `ASSISTED_LAB_BOOKING_ENABLED_DOCTOR` (new), which needs `ASSISTED_BOOKING_ENABLED_DOCTOR` too. Off → 503 on
  the lookup, the lab reads and new bookings. Reads, by-key, cancel, accept, refunds and report access always work.
- **Indexes.** `assertAssistedLabIndexes` (`assisted/labBookings.ts:113-119`) takes the payer: partner entries
  `{walletId, operationKey}` for doctors instead of the pharmacy index, plus `assisted_links {bookerKind, bookerId, userId}`.
  No new index.
- **Migration:** none.
- **Order:**
  1. deploy;
  2. `sync-indexes` (2c/2d indexes);
  3. switch on;
  4. restart.
- **Rollback:** the switch. Never roll the code back while a `doctor_assisted` row is open (older code refunds nobody):
  `db.partner_lab_bookings.countDocuments({ source: 'doctor_assisted', status: { $nin: ['completed','cancelled','no_show'] } })`
  must be 0.

#### 25.5.8 Tests (`test/assisted/phase3b-doctor-lab.integration.ts`)

**Create:**
1. From a consultation: one doctor-wallet debit, one seat, `source: 'doctor_assisted'`, `fromBookingId` stored, the
   link's typed name, no lookup counted.
2. By phone: the lookup is counted; same answer for known and unknown numbers; the account opens only in the transaction.
3. `fromBookingId` of another doctor → 404; cancelled, or outside the window → 409 `TREATING_WINDOW_CLOSED`; an unpaid
   card booking → 404.
4. **Race:** 5 identical creates give one booking and one debit.
5. **Race:** two creates beyond the balance: one is 409 `INSUFFICIENT_BALANCE`, and the balance is never negative.
6. **Race:** the doctor is unverified between the checks and the transaction → 403, nothing committed.

**Cancel and refunds:**

7. Doctor cancel at slot − 61 min refunds; at − 59 min it is 409. A patient cancel refunds the DOCTOR wallet, and the
   customer wallet is unchanged. A lab reject refunds the doctor. An admin no-show cancel forfeits.
8. **Race:** doctor cancel against patient cancel gives one refund, one redemption reversal and one seat release.
9. A refund to a frozen or inactive wallet, or for an unverified doctor, posts.

**Reports and names:**

10. The doctor reads a released report: never a draft, not after 90 days, not while unverified. Another doctor and the
    pharmacy get 404; the patient reads it.
11. The lab-facing and doctor-facing names are never the account name.

**Regression and reconciliation:**

12. The 2a suite is unchanged (pharmacy keys and answers byte-identical).
13. Reconciliation is clean on doctor rows and flags a cancelled row that was not refunded.

#### 25.5.9 Web screens

**Doctor app:**
- **Appointment detail → "Book lab tests".** Patient prefilled (name editable); lab list (nearby badge); branch; tests;
  visit mode; home address; slot; coupon; price summary; "patient agreed" tick; wallet balance; "Pay from wallet".
- **Book for a walk-in.** The same wizard, starting with the phone lookup (masked name).
- **Lab tests I booked.** A list and a detail: Ref, patient, lab and branch, slot, status, the proposed new time with
  Accept / Cancel, Cancel (1 h cut-off, "refund to your wallet"), and the report while allowed.

**Patient app:** "Booked and paid by Dr <name>"; on cancel, "the refund goes to Dr <name>".

**Lab workspace:** "Booked by Dr <name>", Ref, "Identity attested by the partner, not verified".

**Admin:** review queue and move tool rows name the doctor.

### 25.6 Round 3c: doctor → lab test by card/UPI

The 2b flow (§24.5) with a doctor payer. Nothing new beyond these change points.

- **Payment record.** On 2b's context `assisted_lab_booking`, a doctor's record has `userId` = `payerUserId` =
  `payerSpecialistId` = the doctor, and no `payerPharmacyId`.
- **Verification** (`payment/services/index.ts:782-803`):
  - a `specialist` requester matches by `payerSpecialistId`;
  - a booking payment by an ineligible doctor → 403 `SPECIALIST_NOT_VERIFIED` (the pharmacy gate of §23.1, applied to
    doctors);
  - `entity` = the doctor booker lab view.
- **Capture** (2b's `applyAssistedLabCapture`):
  - the payer is checked by `funding.payerKind`;
  - a capture for a doctor who is no longer eligible is a **late capture**, returned to the card, and the booking expires
    (DR9, the C9 pattern).
- **Card refund rows.** `payerKind` gains `'doctor'` (`assisted/model/index.ts:150`, `:182`).
  - A refund `to: 'wallet'` (the doctor's own choice, C2, or the admin fallback, C5) credits the doctor wallet,
    non-withdrawable (C3).
  - Admin rows carry `payerName` = "Dr <name>".
- **Routes.** `POST /api/v1/specialists/me/assisted/lab-bookings` with `paymentMethod: 'razorpay'` answers as §24.5.2.
  The cancel adds `refundTo?: 'card' | 'wallet'`.
- **Keys and hash.** As 3b. The method is not in the hash, so the same key sent with `wallet` answers the card booking
  (§23.3).
- **Limits.** No pending-card cap (r10g).
- **Switches.** `ASSISTED_CARD_PAYMENT_ENABLED` and `ASSISTED_LAB_BOOKING_ENABLED_DOCTOR`.
- **Indexes.** `assisted_card_refunds {captureKey}` (r10e); nothing new.
- **Migration:** none.
- **Rollback:** never below 3c while a doctor card row is `pending_payment` or its refund row is `pending`.

**Tests** (`test/assisted/phase3c-doctor-card.integration.ts`):
1. The card create is pending: one record, the seat held, no debit, nothing shown to the patient or the lab.
2. **Race:** verify, reconcile and the sweep at once confirm once and send one notice.
3. Expiry, then a capture: one `late_capture` refund. A second capture on the order: one `extra_capture` refund.
4. Doctor unverified before the capture → late capture returned to the card.
5. `refundTo: 'wallet'` gives a doctor-wallet credit with no lot. A patient cancel gives a card refund row.
6. A pharmacy, another doctor or the patient verifying → 404.
7. The admin queue row names the doctor.

**Web:** "Pay by card/UPI" in the doctor wizard; a "Waiting for payment" badge with Pay now; the refund choice with the
non-withdrawable warning; the refund status row.

### 25.7 Round 3d: test recommendations and the code on the PDF

#### 25.7.1 Data model

**New module `testRecommendations`** (`src1/modules/testRecommendations/model/index.ts`, so `sync-indexes` builds it).
`test_recommendations` (§5.6, refined):

| Field | Meaning |
|---|---|
| `_id`, `code` | The 8-character code |
| `consultationId` | The consultation; one recommendation per consultation |
| `specialistId`, `userId`, `dependentId` | The doctor and the person (`dependentId` null for the holder) |
| `items` | `[{ index, name, catalogueCode?, note? }]` |
| `status` | `'open' \| 'partly_booked' \| 'booked' \| 'withdrawn'` |
| `bookings` | `[{ labBookingId, itemIndexes[], byKind: 'customer' \| 'pharmacy' \| 'lab_desk' \| 'doctor', at, cancelled? }]` |
| `version`, `createdAt`, `updatedAt` | |

- **Indexes:** `{code}` unique; `{consultationId}` unique; `{userId, createdAt: -1}`.
- **`Booking.prescription.recommendationCode`** (schema `bookings/model/index.ts:107`, type `bookings/types/index.ts:46`).
  It is server-owned: S4 already refuses a client `prescription` at create (`bookings/serverOwnedFields.ts:14`).
- **`PartnerLabBooking.recommendationId`** (top level, every source; partial index). It replaces §5.1's
  `assisted.recommendationId`, because customer and desk rows have no `assisted` block (DR17).

#### 25.7.2 The code

- **Shape.** 7 random characters plus 1 check character, from the Crockford base32 alphabet
  `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. The check character is Luhn mod 32 over the seven. Printed as `ABCD-EFGH`.
- **Why Crockford.** `shortRef` uses RFC 4648 base32 (`assisted/labBookings.ts:88-91`). Crockford avoids I, L, O and U,
  which are misread aloud or on paper (DR10).
- **Input.** Upper-cased; spaces and hyphens removed; I and L read as 1, O as 0. A wrong check character → 400
  `INVALID_CODE`, before any read.
- **Making it.** `crypto.randomInt`. A duplicate code (11000) retries with a new code, up to 3 times.

#### 25.7.3 Writing it (`createAppointmentPrescription`, `specialistPortal/services/index.ts:326-409`)

- **Input** (`specialistPortal/validation/index.ts:126-128`).
  - `testsAdvised: string[]` stays.
  - New optional `testsRecommended: [{ name (1–120), catalogueCode?, note? (≤ 200) }]`, at most 30.
  - With `testsRecommended`, the server fills `testsAdvised` from its names, for older readers. With only
    `testsAdvised`, the items are those names.
- **Before the PDF** (`:355`), the recommendation is upserted by `consultationId`. Its person is the booking's `userId`
  and `dependentId`.
  - A re-save keeps the code, replaces the items and keeps the linked bookings.
  - An empty list → `withdrawn`. The code stays reserved, and loading it answers 404 (DR11).
- **Best effort** (DR12). If the store fails (index missing, database error), the failure is logged, the PDF prints
  without a code, and the prescription is still saved. The next save tries again.
- **The PDF.** The Tests Advised section (`:629-632`, from `testsHtml` `:555-560`) gets a box: **"Jansetu — book these
  tests with code ABCD-EFGH at a Jansetu pharmacy or lab, or in the Jansetu app."** The header brand (`:596`, "MyEwaCare")
  is unchanged (question Q3).
- **Stored and shown.**
  - `prescription.recommendationCode` is saved with the prescription (`:367-378`).
  - The dispensing copy prints it under "Tests advised" (`assisted/dispensingCopy.ts:101-102`). Its hash (`:35-41`)
    includes `recommendationCode` **only when present**, so copies of older prescriptions stay current (DR14).
  - The booker view adds it to `PRESCRIPTION_FIELDS` (`assisted/bookerView.ts:19`). Customer and doctor reads carry it.
- **Instant consultations** get it too: they use the same prescription route (`specialists/routes/index.ts:208-215`).

#### 25.7.4 Loading by code and phone (D2)

| Who | Route | Guard and count |
|---|---|---|
| Pharmacy | `GET /api/v1/pharmacy-assisted/recommendations/:code?phone=` | `requireOperationalPharmacy`; `hitLookup('pharmacy:<id>')`; audited `recommendation.lookup` (ids only) |
| Lab desk (2c) | `GET /api/v1/partner-workspace/lab-desk/recommendations/:code?phone=` | lab member with `bookings.manage`, branch in scope; `hitLookup('lab:<partnerId>')` |
| Doctor (walk-in) | `GET /api/v1/specialists/me/assisted/recommendations/:code?phone=` | eligible; `hitLookup('doctor:<sid>')` |
| Patient | `GET /api/v1/lab-bookings/recommendations?status` (customer router, `partners/routes/index.ts:312-322`) | the holder's own account, all family members |

**Answers:**
- **Partner:** `{ code, status, items: [{ index, name, note }] }`. No doctor, patient or diagnosis.
- **Patient:** also `_id`, `consultationId`, `doctorName`, `date`, `patient: { kind, dependentId, name }` and `bookings`.

**Errors:**
- 400 `INVALID_CODE`;
- 404 `RECOMMENDATION_NOT_FOUND` (unknown, withdrawn, or the phone is not the account's: one answer);
- 429 `ASSISTED_LIMIT_REACHED` (lookups);
- 503 `RECOMMENDATIONS_DISABLED`.

#### 25.7.5 Linking a lab booking

Every lab create accepts `recommendation?: { code, itemIndexes: number[] }` (at least one, unique, in range):
- customer (`partners/services/labBookings.ts:74-89`, create `:202`);
- pharmacy 2a (`assisted/labBookings.ts:63-81`);
- lab desk 2c;
- doctor 3b.

**Rules:**
- **A refusable check, before any account or transaction.** The recommendation must belong to this exact person: the
  account of the phone and the chosen patient (holder or family member); for a customer, its own. Otherwise 404
  `RECOMMENDATION_NOT_FOUND`, the same answer for unknown numbers (DR16).
- **In the booking transaction:**
  - `recommendationId` is written on the row;
  - an entry is pushed to `bookings`;
  - `status` is recomputed: every index covered by a booking that is not cancelled → `booked`; some → `partly_booked`;
    none → `open`;
  - `version` + 1.
- **Never a lock.** Other tests may be booked too, and an index may be covered twice.
- **Hash.** The create hash includes `recommendation`: the normalised code and the sorted indexes (§6.3).
- **Cancellation and expiry.** `cancelIn` and `expireUnpaid` (`partners/services/labBookings.ts:482`, `:418`) mark the entry `cancelled: true` and
  recompute the status in their transaction.
- **The recommending doctor** never reads the report: no access rule names a recommender.

#### 25.7.6 Switches, indexes, deploy

- **Switch.** `TEST_RECOMMENDATIONS_ENABLED` (new) gates creation at save, the partner loads and links.
  - Off: no recommendation is made, and the PDF is as today.
  - Loads, and creates that carry `recommendation`, answer 503 `RECOMMENDATIONS_DISABLED` (nothing written).
  - The patient list and stored codes stay readable.
- **Indexes.** `assertUniqueIndex` on `{code}` and `{consultationId}`:
  - before the upsert (missing → the best-effort skip, logged);
  - before a link (missing → 503).
- **Migration:** none. Older prescriptions get no code; nothing is backfilled.
- **Order:**
  1. deploy;
  2. `sync-indexes`;
  3. switch on;
  4. restart.
- **Rollback:** the switch. The code rollback is safe: no money is involved, and linked rows keep a field older code
  ignores.

#### 25.7.7 Tests (`test/assisted/phase3d-recommendations.integration.ts`)

**Writing the code:**
1. A save with tests gives one recommendation and a code with a valid check character. The PDF HTML holds the code and
   "Jansetu", and `testsAdvised` is filled.
2. **Race:** two saves at once give one recommendation with one code.
3. A re-save keeps the code and replaces the items. An empty list withdraws it, and a load answers 404.
4. Every single-character change of a valid code, and every adjacent swap, fails the check (exhaustive over one code).

**Loading and linking:**

5. Pharmacy load: the right phone gets the names only; a wrong phone gets the same 404 as an unknown code; the load is
   counted.
6. A pharmacy booking with `recommendation` gives `partly_booked`, then `booked`; a cancel brings it back to `open`.
7. **Race:** two bookings linking one recommendation at once are both linked, and the status matches.
8. The patient books from the app and it links; another account's code → 404.

**Access and failure:**

9. The recommending doctor gets 404 on the report. The pharmacy that booked reads it.
10. The prescription save succeeds when the recommendation store fails (index dropped); the PDF has no code.
11. The dispensing copy shows the code. A copy made before 3d stays current (hash unchanged).

#### 25.7.8 Web screens

- **Doctor app → Prescription form:** a "Tests" list (name, optional note). After saving, the code is shown and the PDF
  has it.
- **Pharmacy → "Book from a recommendation":** code and phone → the test names → the lab wizard, with the recommended
  tests ticked.
- **Lab desk:** the same, into the desk booking.
- **Patient app:** "Recommended tests" on the consultation and in a list, with a Book button that pre-fills the lab
  booking.
- **Doctor appointment:** "Book these tests myself" (3b), pre-filled.

### 25.8 Round 3e: partner instant "Consult now" (wallet-paid)

#### 25.8.1 Data model (`doctors/model/instant.ts`)

- **`IInstantRequest`** (`:44-97`) and its schema (`:101-159`) gain:
  - `source?: 'self' | 'pharmacy_assisted' | 'lab_assisted'`;
  - `assisted?` (Mixed): `bookedBy`, `consent`, `preferredLanguage`, `identity`, `join`, `shortRef`, `requestKey`,
    `requestHash`, `referral: null`;
  - `assisted.funding = { method: 'wallet', payerKind, payerId, amountMinor, state: 'held' | 'allocated' | 'refunded', walletEntryId, refunds[] }`.
- **`MoneySplit`** (`:38`) gains an optional `partnerMinor` (default 0) in `funding`, `allocated`, `returned` and
  `refunded` (`:123-127`).
- **`refundReason`** (`:94`, `:156`) adds `'booker'`.
- **Required fields** on assisted rows:
  - `createRequestKey` (`:104`) = the stored namespaced key (unique with `userId`, `:160`);
  - `createRequestHash` = the assisted hash;
  - `paymentStatus: 'paid'`;
  - `paymentDeadline` = the create time (never `pending_payment`).
- **Indexes:** `{ 'assisted.requestKey': 1 }` unique partial; `{ 'assisted.shortRef': 1 }` unique partial;
  `{ 'assisted.bookedBy.kind': 1, 'assisted.bookedBy.id': 1, createdAt: -1, _id: -1 }`.
- **The booking made at accept** (`acceptIn`, `doctors/services/instant.ts:584-590`) gets:
  - `source`;
  - `assisted`, copied from the request with `funding: { instantRequestId }` only (§5.1) and the split: list = the fee,
    discount = `allocated.couponMinor`, base = fee − coupon (provider-funded) or the fee (platform-funded), cut 0,
    provider = base;
  - `earningRule: 'provider_coupon_v2'`;
  - `settlementSystem: 'ledger'`, whatever `settlementSystemFor` (`doctors/services/instant.ts:582`) says;
  - `pharmacyId` for pharmacy bookers, so the phase 0 list and the S2 readers show it.
- **Coupon redemption** `bookingKind: 'instant_request'` (the enum already has it, `coupon/model/redemption.ts:13`).

#### 25.8.2 Money

Line numbers in §25.8.2–§25.8.4 without a file are in `doctors/services/instant.ts`.

- **`allocateFunding`** (`:47-64`): the order is coupon → wallet → partner → gateway; `returned.partnerMinor`; the
  invariants include `partnerMinor`.
- **Create: ONE transaction.** Offers (`offerTargets`, `:414-428`) are computed first; none → 409 `NO_DOCTOR_ONLINE`
  before anything. Then, in the transaction:
  1. key claim;
  2. account, family member, and the booker's link (pharmacy link, or `assisted_links` for labs);
  3. redemption;
  4. the insert as `offered` / `held` (`holdPatch`, `:431-437`, with `partnerMinor` = quote − discount);
  5. the debit `assisted_instant:<id>:debit`;
  6. the audit.

  After the commit: `notifyOffer` (`:469`).
- **Accept** (`:530-593`), for assisted rows:
  - instead of the customer credit (`:573-574`): a `refund_credit` of `returned.partnerMinor`,
    `assisted_instant:<id>:quote_return`, to the booker wallet (non-withdrawable, no lot restore; DR20);
  - instead of undoing the coupon on payment records (`:576-579`): the redemption's `discountMinor` is set to
    `allocated.couponMinor`, or the redemption is reversed when that is 0.
- **Refund before acceptance** (`refundHeld`, `:665-688`; the booker or the inactivity sweep `:848-862`): a
  `refund_credit` of `funding.partnerMinor`, `assisted_instant:<id>:refund`, restoring the debit's lots; the redemption is
  reversed.
- **Cancel after acceptance.** Only the doctor or an admin (D13), through `cancelAccepted` (`:720-752`) and
  `cancelByDoctor` (`bookings/services/index.ts:1595-1602`):
  - `allocated.partnerMinor − refunded.partnerMinor` goes back as `assisted_instant:<id>:cancel_refund` (non-withdrawable);
  - the redemption is reversed;
  - `linkVersion` + 1.
- **No-show:** final; nothing goes back (§8.6).
- **Completion** earns `split.providerMinor` once (`doctors/services/earnings.ts:17-36` already reads `earningRule`).
- **Never the customer wallet.** No assisted row touches it.

#### 25.8.3 Routes (pharmacy token; `pharmacyAssistedRouter`, `assisted/routes/phase1a.ts:15-16`)

| Route | Request → answer |
|---|---|
| `GET /api/v1/pharmacy-assisted/instant/specialities` | `?mode=video\|call` → `[{ specialization, onlineNow }]` (`specialities`, `:888-909`) |
| `GET …/instant/doctors` | `?speciality&mode` → `[{ doctorId, name, specialization, modes, instantFeeMinor, nearby }]` (`onlineDoctors`, `:254-274`; eligible only; nearby by the pharmacy's pincode, then city, then fee) |
| `GET …/instant/quote` | `?speciality&mode&doctorId?` → `{ quotedAmountMinor, doctors }` (`:277-286`) |
| `POST …/instant/requests` | below → 201 (replay 200) `{ request: <booker instant view>, funding: { method, amountMinor, state, walletEntryId }, newAccount, replayed }` |
| `GET …/instant/requests`, `GET …/instant/requests/:id` | `?status&cursor&limit≤50`, own rows only (404 otherwise) |
| `GET …/instant/requests/by-key/:key`, `POST …/by-key/:key/abandon` | Q13 shape |
| `POST …/instant/requests/:id/reoffer` | `{ target, expectedStatusVersion }` (`reoffer` rules, `:612-641`) |
| `POST …/instant/requests/:id/activity` | the booker's heartbeat (§7.7: the inactivity refund follows the booker's screen) |
| `POST …/instant/requests/:id/refund` | `{ expectedStatusVersion }` → `{ refundedMinor }` |

**Create body:**
```
{ requestKey, phone, patient, holderName?, consent, preferredLanguage, specialization, mode: 'video' | 'call',
  target: { kind: 'any' } | { kind: 'specific', doctorId }, join: { on, phone? }, couponCode?,
  acceptedQuoteMinor, acceptedPayableMinor, primaryConcern?, paymentMethod: 'wallet' }
```
- Chat is refused (DR19).
- `razorpay` → 400 `PAYMENT_METHOD_UNAVAILABLE` (Q2).

**Booker instant view:**
```
{ _id, status, statusVersion, mode, specialization, target, offerGeneration, offerExpiresAt, inactivityRefundAt,
  offeredCount, acceptedDoctorName, bookingId, patientName, holder,
  assisted: { shortRef, join: { on }, preferredLanguage, disputed? },
  money: { quotedAmountMinor, discountMinor, paidMinor, returnedMinor, refundedMinor },
  createdAt, updatedAt }
```
The booking itself appears in `GET /pharmacy-bookings`. Its "Join call" window for `bookingKind: 'instant'` runs from
acceptance to the end of the doctor's held interval (`assisted/bookerView.ts:21` today uses the slot).

**Errors:**
- 400 `CONSENT_REQUIRED`, `PAYMENT_METHOD_UNAVAILABLE`, `VALIDATION_ERROR`, `DOCTOR_REQUIRED`, `INVALID_COUPON`,
  `COUPON_NOT_FOR_ASSISTED`;
- 409:
  - doctors: `NO_DOCTOR_ONLINE`, `DOCTOR_NOT_ONLINE`;
  - price: `QUOTE_CHANGED` (`details: { quotedAmountMinor, discountMinor }`);
  - wallet: `INSUFFICIENT_BALANCE`, `WALLET_FROZEN`, `WALLET_INACTIVE`, `WALLET_RECEIVABLE`;
  - coupon: `COUPON_EXHAUSTED`;
  - keys: `IDEMPOTENCY_KEY_REUSED`, `REQUEST_ABANDONED`;
  - request state: `REQUEST_NOT_OPEN`, `REQUEST_NOT_REFUNDABLE`, `INSTANT_REQUEST_CHANGED`;
- 429 `ASSISTED_LIMIT_REACHED` (lookups);
- 503 `ASSISTED_BOOKING_DISABLED`, `INDEXES_OUTDATED`, `CUSTOMER_LINKING_UNAVAILABLE`.

**Labs (after 2e).** The same routes under `/api/v1/partner-workspace/assisted/instant/*`, with `assisted.book` and the
branch in scope. "Nearby" is the member's branch.

#### 25.8.4 Other change points

| Change point | Rule |
|---|---|
| Customer commands (`doctors/routes/index.ts:13-19`: pay, reoffer, activity, refund) | assisted request → 409 `PARTNER_PAID_BOOKING` |
| Customer reads (`requestView` `:143-146`; `getForCustomer` / `listForCustomer` `:873-885`) | assisted rows hide `quotedAmountMinor`, `discountMinor`, `funding`, `allocated`, `returned`, `refunded`, `acceptedFeeMinor`, `offerFees`, `couponTerms` and the `assisted` money and keys; they add `paidBy` |
| Doctor offers (`myOffers`, `:479-497`) | add `source`, `bookedBy.name` and the identity note (`assisted/views.ts:13`). `patient.name` is the typed or family-member name, never the account name |
| After accept (`afterAccept`, `:596-609`) | Meet with neutral text (`meet/service/index.ts:444-470`: `assisted` is present). The patient is told "<partner> booked an instant consultation; a doctor is joining", and the booker "Doctor accepted, Ref <ref>: join now". *SMS hook: booked* |
| "Not mine" and admin move (`assisted/review.ts:38`, `:172`) | allowed on the instant booking; the move also moves the request's `userId` and `patient` in the same transaction |
| Reconciliation (`assisted/reconciliation.ts`) | new `instantChecks`: one debit = `funding.partnerMinor`; a refunded request has one refund = the debit; an accepted one has `quote_return` = `returned.partnerMinor`, and `cancel_refund` ≤ `allocated.partnerMinor`; split sums; one earning on completion |
| Stuck money (`assisted/reconciliation.ts:174`) | `offered` requests more than 1 h past `inactivityRefundAt` |

#### 25.8.5 Keys, switches, indexes, deploy

- **Keys.** Stored `assisted_instant:<kind>:<orgId>:<actorId>:<key>`; claim scope
  `assisted_instant_create:<kind>:<orgId>:<actorId>` (§6.3 names this kind).
- **Hash** over: phone, patient identity, `holderName`, service `{ specialization (lower-case), mode, target, join }`,
  `couponCode`, `preferredLanguage`, `primaryConcern`, `acceptedQuoteMinor` and `acceptedPayableMinor`.
- **Fences.** Reoffer and refund CAS on `statusVersion` / `offerGeneration`, as the customer paths already do.
- **Switch.** `ASSISTED_INSTANT_ENABLED` (new), plus the booker's own switch (`ASSISTED_BOOKING_ENABLED_PHARMACY` or
  `_LAB`).
  - Off: the speciality, doctor and quote reads and new requests answer 503.
  - Reoffer, activity, refund, accept, cancel and the sweeps always run.
- **Indexes.** `assertUniqueIndex` on:
  - `instant_requests {assisted.requestKey}`, `{assisted.shortRef}`, `{userId, createRequestKey}`;
  - `bookings {assisted.shortRef}` (at accept);
  - the booker's wallet entry index;
  - `request_keys`;
  - `coupon_redemptions`.
- **Migration:** none.
- **Order:**
  1. deploy;
  2. `sync-indexes`;
  3. `ASSISTED_INSTANT_ENABLED=true`;
  4. restart.
- **Rollback:** the switch. Never roll the code back while an assisted request is `offered`, or its booking is
  `confirmed` (older code would refund the patient's wallet):
  `db.instant_requests.countDocuments({ 'assisted.bookedBy.kind': { $exists: true }, status: 'offered' })` and
  `db.bookings.countDocuments({ bookingKind: 'instant', source: { $in: ['pharmacy_assisted','lab_assisted'] }, status: 'confirmed' })`
  must both be 0.

#### 25.8.6 Tests (`test/assisted/phase3e-partner-instant.integration.ts`)

**Create:**
1. A create gives one debit = quote − coupon, `offered` / `held`, offers sent, one redemption, the typed-name link, and
   no customer-wallet movement.
2. A replay, other content (409) and an abandoned key behave as §25.3.
3. **Race:** 5 identical creates give one request and one debit.
4. **Race:** two creates beyond the balance: one is 409 `INSUFFICIENT_BALANCE`.

**Accept:**

5. Accept gives a booking with `source`, `assisted.funding = { instantRequestId }`, `earningRule`, the split,
   `pharmacyId` and `settlementSystem: 'ledger'`. The quote difference is credited to the partner once. A percentage
   coupon is recomputed on the fee.
6. **Race:** two doctors accept at once: one booking and one quote return.
7. **Race:** accept against the booker's refund, and accept against the inactivity sweep: exactly one outcome, and the
   money moves once.

**Refunds and commands:**

8. Booker activity moves the inactivity refund. The inactivity refund credits the partner, with lots restored.
9. A doctor or admin cancel after acceptance refunds the allocation to the partner once; the customer wallet is untouched;
   the redemption is reversed.
10. The patient's pay, reoffer, refund and activity → 409 `PARTNER_PAID_BOOKING`. Patient reads show `paidBy` and no
    money.
11. A refund to a frozen or inactive wallet posts.

**Doctors and earnings:**

12. An unverified doctor gets no offer, and its accept → 403.
13. Completion earns `split.providerMinor` once; a no-show earns nothing.

**Reconciliation and regression:**

14. `instantChecks` is clean, and a tampered row is flagged.
15. The customer instant suites (Q4b, Q13, Q16a) pass unchanged.

#### 25.8.7 Web screens

**Pharmacy (and lab after 2e):**
- **Consult now.**
  - Speciality with "N doctors online", and the mode.
  - Any doctor, or a chosen online doctor.
  - Patient lookup; where the patient joins; coupon; the quoted price and "you may get some back"; the consent tick;
    "Pay from wallet".
- **Waiting for a doctor.** Offer countdown; "Offer again" (any or another doctor); "Cancel and refund"; the screen sends
  the activity heartbeat.
- **Doctor joined.** "Join call" and Ref; the amount returned to the wallet.

**Patient app:** an instant consultation "Booked and paid by <partner>".

**Doctor app:** the offer card shows "Booked by <partner>" and "Identity attested by the partner, not verified".

### 25.9 Round 3f: treating window, read log, records-access approvals and grants

#### 25.9.1 The treating window (§9.1, D5, N8)

A pure helper, `treatingWindowOf(booking, slot) → { open, opensAt, closesAt }`, in `assisted/treating.ts`. 3b introduces it
for `fromBookingId`.

**It opens:**
- video or call: at slot start − 10 min (`appointmentIntervalOf`, `assisted/rxAccess.ts:30-36`);
- instant: at acceptance (the booking's `createdAt`);
- in person: at desk check-in (`clinicDesk.arrivedAt`, `bookings/types/index.ts:152`), or at slot start for an online
  in-clinic booking.

**It closes:**
- 30 days after completion (`lifecycle.completed.at`);
- if not completed, 7 days after the consultation's end (`consultationEndOf`, `assisted/rxAccess.ts:42-58`);
- at once on cancellation or no-show. A booking cancelled before it starts never opens a window.

An unpaid card booking never opens a window. The doctor must be eligible at every read.

#### 25.9.2 Data model (new module `recordAccess`, `src1/modules/recordAccess/model/index.ts`)

**`record_reads`:**
- fields: `{ doctorId, holderUserId, personKey ('self' | dependentId), treatingBookingId | null, scope: 'own_history' | 'other_history' | 'file', path?, sourceBookingId?, at }`;
- indexes: `{doctorId, at: -1}`, `{holderUserId, personKey, at: -1}`, `{treatingBookingId}`;
- kept for good (an audit).

**`record_access_requests`:**
- fields: `{ holderUserId, personKey, dependentId?, specialistId, treatingBookingId, state: 'pending' | 'approved' | 'denied' | 'expired' | 'replaced', via?: 'app' | 'sms_code', codeHash?, codeExpiresAt?, wrongTries, expiresAt, decidedAt?, createdAt }`;
- index: unique partial `{treatingBookingId, specialistId}` where `state: 'pending'` (one open request per booking and
  doctor);
- index: `{holderUserId, state, createdAt: -1}`.

**`record_access_grants`:**
- fields: `{ holderUserId, personKey, dependentId?, specialistId, via, requestId, at, expiresAt (at + 12 months), revokedAt?, revokedBy?, revokedByKind? }`;
- index: unique `{holderUserId, personKey, specialistId}`. One row per doctor and person, renewed in place;
- index: `{specialistId, holderUserId}`.

#### 25.9.3 The doctor's history

**Route:** `GET /api/v1/specialists/me/patients/:userId/history?dependentId=&bookingId=` (`specialists/routes/index.ts:217-223`;
service `specialistPortal/services/index.ts:411-441`; repository `bookings/repository/index.ts:255-269`).

- **Without `bookingId`:** the doctor's own consultations, as today (§9.1 item 5; no window, no grant).
  - Without `dependentId`: the whole account, so the released doctor app keeps working (DR23).
  - With `dependentId`: that person only.
- **With `bookingId`** (the doctor's treating booking):
  - the person is that booking's; another account → 404; a closed window → 409 `TREATING_WINDOW_CLOSED`;
  - answer:
    ```
    { patient,
      consultations,                                    // own, this person
      others?: { consultations: [...], labReports: [...] },
      access: { window: { opensAt, closesAt },
                grant: { at, expiresAt, via } | null,
                request: { state, createdAt, expiresAt } | null,
                identityNote? } }
    ```
  - `others` only with a grant in force and `RECORDS_ACCESS_ENABLED`;
  - `identityNote` for a partner-booked treating booking.
- **Allowlists for `others`** (DR24):
  - **consultations:** `{ bookingId, date, doctorName, specialization, consultationMode, diagnosis, advice, medicines, testsAdvised, recommendationCode, prescribedAt, prescriptionFile }`.
    - Included: bookings of the same person with a doctor-saved prescription (`hasPrescription`,
      `assisted/rxAccess.ts:83-91`) that an admin clear has not withdrawn.
    - Never included: notes, documents, contact details, price, payment, meeting link or the `assisted` block.
  - **labReports:** released partner-lab reports of the person: `{ labBookingId, labName, date, tests: [names], releases: [{ file, releasedAt, signer }] }`.
- **Read log first.** One `record_reads` row (`own_history` or `other_history`) is written before the answer. If the write
  fails → 503 `READ_LOG_UNAVAILABLE`, and no data is sent.
- **Ineligible doctor.** `restrictIneligibleDoctorReads` (`specialists/eligibility.ts:167-174`) still reduces the own
  part. With `bookingId` → 403 `SPECIALIST_NOT_VERIFIED`.

#### 25.9.4 Approval and grants

**Doctor:**
- `POST /api/v1/specialists/me/bookings/:id/records-access/request` (eligible; inside the window; switch on).
  - It creates a `pending` request; any older pending one of that booking becomes `replaced`.
  - It expires at the earlier of the window's close and 24 h (DR21).
  - The holder gets an in-app notice naming the doctor and the patient's first name, with no health details.
  - The code sender is a hook, `RecordsCodeSender` (set like `setAssistedEffects`, `assisted/support.ts:79`). In phase 3
    it is "unavailable". In phase 5 it makes a 6-digit code, stores its HMAC with `codeExpiresAt` = +10 min, and sends
    the security SMS of §10.6. *SMS hook: records code.*
  - Answer: `{ requestId, state: 'pending', expiresAt, channels: { app: <the holder has signed in>, sms: false } }`.
  - A grant already in force → 200 `{ state: 'approved', grant }`, and nothing is created.
- `POST …/records-access/confirm { code }`.
  - Only when a code was sent; otherwise 409 `NO_CODE_SENT`.
  - The code is compared in constant time.
  - After 5 wrong tries, or after 10 minutes, the request is `expired` (409 `CODE_EXPIRED`). This is the code's own life,
    like the sign-in code (DR22).
  - Success → a grant with `via: 'sms_code'`.

**Holder (customer app; the account holder only):**
- `GET /api/v1/records-access/requests?state=pending`;
- `POST /api/v1/records-access/requests/:id/approve` and `/deny` (CAS `pending` and not expired; approve upserts the grant,
  `via: 'app'`);
- `GET /api/v1/records-access/grants`, `POST /api/v1/records-access/grants/:id/revoke`.

**Admin:**
- `GET /api/v1/admin/records-access/grants?holderUserId&specialistId`;
- `POST …/grants/:id/revoke { reason }` (audited);
- `GET /api/v1/admin/records-access/reads?holderUserId&doctorId&from&to`.

**Rules:**
- A grant counts only inside an open treating window.
- A moved booking follows its new account: grants of the old holder never apply (§17.5 item 3).

#### 25.9.5 File access (`file/access.ts`)

- **`Decision`** (`:24`) gains `{ allow: false; status: 503 }`. `decideFileAccess` (`:344-371`) and the file controller
  answer it.
- **The full prescription PDF of ANOTHER booking** (`BOOKING_PRESCRIPTION` `:33`; `canReadBooking` `:47-59`). New
  specialist rule; all of these must hold:
  - the reader has an open treating booking for the same person;
  - a grant is in force;
  - the booking still holds the file (`:65-68`);
  - no admin clear withdrew it (`:78-87`).

  A `file` read-log row is written first; failure → 503. Treating doctors read the full PDF, not the dispensing copy
  (DR26).
- **Released partner-lab reports** (`canReadPartnerLabReport`, `:174-190`): the same rule, released files only.

#### 25.9.6 Read-then-cancel alert

When a booking is cancelled or marked no-show after its doctor read other providers' records (`record_reads` with
`treatingBookingId` = the booking and scope `other_history` or `file`), raise
`raiseAlertIn({ kind: 'read_then_cancel', subject: bookingId })` (`assisted/limits.ts:121-127`) in that transaction.
It is an alert only. The places:
- `cancelBookingSettlement` (`bookings/holds.ts:376`);
- `cancelAccepted` (`doctors/services/instant.ts:720`);
- `markNoShow` (`bookings/services/index.ts:1697-1714`).

#### 25.9.7 Keys, switches, indexes, deploy

- **Concurrency.**
  - Two requests at once: the unique pending index lets one in; the other answers the existing pending request.
  - Approve, deny and confirm are CAS on `state: 'pending'` and `wrongTries`.
  - A grant is upserted by its unique key.
  - Revoke is CAS on `revokedAt: null`.
- **Switch.** `RECORDS_ACCESS_ENABLED` (new) gates request, confirm, approve and deny, the `others` sections and file reads
  by grant.
  - Off: history = own consultations, still logged.
  - Revoke (holder and admin) and the grant lists always work.
- **Indexes.** `assertUniqueIndex` on the grants and pending-request indexes before any write (503 `INDEXES_OUTDATED`).
  `record_reads` needs no unique index.
- **Migration:** none.
- **Order:**
  1. deploy (history reads are logged from now on; answers without `bookingId` are unchanged);
  2. `sync-indexes`;
  3. the GATE-DPDP review of the approval notice and the in-app text;
  4. `RECORDS_ACCESS_ENABLED=true`;
  5. restart.
- **Rollback:** the switch, or the code (no money; grants simply stop being read).

#### 25.9.8 Tests (`test/assisted/phase3f-treating.integration.ts`)

**The window:**
1. A video booking opens at start − 10 min, not at "confirmed". In person it opens at arrival; instant at acceptance. It
   closes 30 days after completion, 7 days after the slot end if not completed, and at once on cancel or no-show. A
   booking cancelled before it starts never opens (clock-driven).

**History and the read log:**

2. Own history works without a window, as today. With `dependentId` it covers one person. The read-log row exists before
   the answer. A failing log write → 503 and no data.
3. `others`:
   - absent without a grant;
   - with an app approval: the allowlist only (no notes, documents or price);
   - outside the window → 409;
   - absent after a revoke, and after 12 months.

**Requests and grants:**

4. A request outside the window → 409. Inside: pending, and the holder is told. A second request replaces the first.
   **Race:** two requests at once give one pending.
5. **Race:** approve against deny gives one outcome. Approve after a revoke renews the grant.
6. Another account's holder cannot approve (404).
7. Code path with a test sender:
   - the right code → grant `sms_code`;
   - 5 wrong codes → expired; 10 minutes → expired;
   - the code is stored only as a hash;
   - without a sender → 409 `NO_CODE_SENT`.

**Files:**

8. Another booking's PDF:
   - readable in the window with a grant, and logged;
   - 404 without a grant;
   - 503 when the log fails;
   - 404 once an admin clear withdrew it.

   A released partner-lab report follows the same rule; a draft never.

**Eligibility, alerts and switches:**

9. An ineligible doctor: no `others`, file 404, request 403.
10. The read-then-cancel alert is raised once.
11. After an admin move, the old holder's grant does not apply.
12. Switch off: no `others`, request 503, revoke works.

#### 25.9.9 Web screens

**Doctor app → Appointment → Patient history:**
- the doctor's own consultations;
- an "Other doctors' records" panel, locked until approved: "Ask the patient for approval", then pending / approved until
  <date> / denied;
- a code box, shown only once SMS codes exist;
- for partner-booked patients, the warning "Identity attested by the partner, not verified".

**Patient app:**
- "Doctors asking to see records" with Allow / Deny;
- "Who can see my records" with Revoke.

**Admin:**
- grants search and revoke;
- the read log per patient;
- the alert list shows `read_then_cancel`.

### 25.10 ASSUMED (reversible)

| # | Assumption (the safer default) | Where |
|---|---|---|
| DR1 | Six rounds instead of five: card for doctor lab bookings is its own round; partner instant consults are wallet-only; the treating window comes last | §25.2 |
| DR2 | Doctor wallets are 2d's `partner_wallets` (`ownerKind: 'doctor'`). Earnings never fund bookings, and a wallet credit is never an earning | §25.4.1 |
| DR3 | An unverified doctor's wallet reads, top-ups and bookings are refused. A top-up it already paid is still credited, and refunds always post to its wallet | §25.4.4 |
| DR4 | Doctor top-ups are verified through the existing `/payments` routes, owned by `payerSpecialistId`; no new verify route | §25.4.3 |
| DR5 | A doctor top-up record never falls back to the customer wallet; a failed credit is retried by the sweep | §25.4.3 |
| DR6 | A doctor books a lab test for a patient of its own consultation inside that consultation's treating window (no lookup counted), or for a walk-in by phone as a pharmacy does | §25.5.3 |
| DR7 | Doctors see typed or masked names in their lab-booking views, never the account name through assisted routes; the appointment views stay as they are | §25.3 |
| DR8 | The doctor's cancel window and accepting a lab's new time follow the pharmacy's (1 h; L6, L7) | §25.5.4 |
| DR9 | A card capture for a doctor no longer verified is a late capture, returned to the card | §25.6 |
| DR10 | The recommendation code: Crockford base32, 7 random characters + a Luhn mod 32 check, printed `ABCD-EFGH` | §25.7.2 |
| DR11 | One recommendation per consultation. The code stays the same across re-saves; an empty list withdraws it | §25.7.3 |
| DR12 | The recommendation is made best effort: a prescription save never fails because of it | §25.7.3 |
| DR13 | The full prescription PDF keeps its "MyEwaCare" header; the recommended-tests box is branded Jansetu (Q3). *Superseded by the owner, 25 Nov: new PDFs say "Jansetu" (§25.16.1)* | §25.7.3 |
| DR14 | The code is printed on the dispensing copy too; the copy's hash includes it only when present | §25.7.3 |
| DR15 | Partners load a recommendation by code and phone, get test names only, and the load counts as a lookup | §25.7.4 |
| DR16 | A recommendation links only to a booking for the same person; it never locks anything; a cancellation unlinks | §25.7.5 |
| DR17 | `PartnerLabBooking.recommendationId` is a top-level field for every source, instead of `assisted.recommendationId` | §25.7.1 |
| DR18 | Partner instant consults are paid from the wallet only in phase 3 (Q2) | §25.2 |
| DR19 | Partner instant consults are video or call only, never chat | §25.8.3 |
| DR20 | The quote difference and refunds after acceptance return non-withdrawable money (no lot restore). A full refund before acceptance restores the lots | §25.8.2 |
| DR21 | Records approval is in the app in phase 3; the SMS code is wired in phase 5 (Q1). A pending request expires at the earlier of 24 h and the window's close | §25.9.4 |
| DR22 | A records code dies after 5 wrong tries or 10 minutes: the code's own life, as the sign-in code. No per-doctor or per-day cap is added | §25.9.4 |
| DR23 | History without `bookingId` keeps today's answer (own consultations, whole account) for the released doctor app | §25.9.3 |
| DR24 | Other providers' records = consultations with a doctor-saved prescription, plus released partner-lab reports. External diagnostics reports are not included in phase 3 | §25.9.3 |
| DR25 | Every history read and every other-provider file read is logged, with no switch. The read is refused (503) when the log cannot be written | §25.9.3 |
| DR26 | A treating doctor with a grant reads other bookings' full prescription PDF (not the dispensing copy) | §25.9.5 |
| DR27 | Each round has its own switch: doctor wallet, doctor lab bookings, instant, recommendations, records access | §25.4–§25.9 |

### 25.11 Questions for the owner (only the ones that change what is built)

1. **Until SMS arrives (phase 5), how does the account holder approve a doctor seeing other doctors' records?**
   Recommended: in the Jansetu app. The holder gets "Dr X asks to see Rina's past records" with Allow / Deny. Patients
   without the app cannot approve until phase 5, so their doctor sees only its own past consultations with them. The SMS
   code switches on in phase 5 (DR21).
2. **Should partners pay for "Consult now" by card/UPI too, or only from the wallet?**
   Recommended: wallet only for now. The patient is waiting at the counter and the wallet pays at once; partners who use a
   card top up the wallet by card. Card payment would need partial card refunds of the quote difference, a new money flow
   (DR18).
3. **Should the prescription PDF say "Jansetu" at the top instead of "MyEwaCare"?**
   Recommended: yes, one brand on every paper the patient carries. The dispensing copy already says Jansetu. Until you
   answer, only the new recommended-tests box says Jansetu (DR13).
4. **May a doctor book lab tests for a walk-in patient by phone number, or only for patients of its own Jansetu
   consultations?**
   Recommended: both, as the design says (§7.4). Many rural doctors see patients outside the app. The same masked
   lookup, "patient agreed" tick and 120-an-hour lookup limit apply as for pharmacies (DR6).

**Decided 25 Nov (coordinator, owner asleep; reversible).** In line with the owner's earlier choices:

| Q | Decision | Effect on the spec |
|---|---|---|
| 1 | The account holder allows or denies in the Jansetu app now; the SMS code comes in phase 5 | §25.9.4 as written (DR21) |
| 2 | "Consult now" is paid from the wallet only | §25.8 as written (DR18) |
| 3 | The PDF header stays "MyEwaCare"; only the recommended-tests box says Jansetu. Rebranding is the owner's call: **ask the owner in the morning** | DR13 stays. **Owner, 25 Nov: the heading says "Jansetu"** (built in r29, §25.16.1) |
| 4 | A doctor books lab tests for patients of its own consultations AND for walk-ins by phone | §25.5.3 as written (DR6) |

### 25.12 Round 3d build record: test recommendations (r16, 2026-11-25)

Branch `m0/r16-phase3d` from `3edeceaf` (the r15 spec with the 25 Nov decisions). Local commits only. Check:
`test/assisted/r16-phase3d.integration.ts` (14 checks over HTTP with the real routers). Every check fails on `3edeceaf`,
where the `testRecommendations` module does not exist.

A mutation run on the built code, one break at a time:
- dropping the phone match fails "one 404" alone;
- always hashing the code fails "dispensing copy hash" alone;
- keeping the previous code on a re-save fails "re-save" (and the later checks that build on its state).

**Full regression** (`prun.sh`, 4 jobs), tsc 17 (unchanged): 68 of 69 suites pass.
- `test/pharmacy-inventory/q16c-pharmacy.integration.ts` failed one spreadsheet-import check (N2) on 503
  `AUTH_STATE_UNAVAILABLE`: the sign-in state read has a 2-second limit (`auth/tokenVersion.ts:43`), and other agents'
  regressions were running at the same time (load average about 28).
- Run alone, it passes 31 of 31. 3d touches none of its code.

Built: the 3d core that does not depend on 3b. **Linking lab bookings to a recommendation (§25.7.5, DR16, DR17) is not
built.** It needs 2b, 2c and 3b, which are not merged; the seam is described below.

#### 25.12.1 What was built

| Part | Where | What |
|---|---|---|
| The code | `testRecommendations/code.ts` | `newRecommendationCode` (7 Crockford base32 characters from `crypto.randomInt` + a Luhn mod 32 check), `normalizeRecommendationCode` (upper case; spaces and hyphens removed; I and L read as 1, O as 0; shape and check), `formatRecommendationCode` (`ABCD-EFGH`) |
| The model | `testRecommendations/model/index.ts` | `test_recommendations { code, consultationId, specialistId, items: [{ index, name }], status, bookings: [], version }`; unique `{code}` and `{consultationId}` |
| Made at the save | `testRecommendations/service.ts` `recommendTestsAtSave`, called by `createAppointmentPrescription` (`specialistPortal/services/index.ts:359`) before the PDF | One per consultation, upserted. The code stays the same across re-saves; the items come from `testsAdvised` (kept filled, unchanged). A save without tests makes no code (r16b: nothing else is written; R3 retires the old code). Best effort (DR12): switched off, a missing unique index or any error → null (logged), and the prescription is saved without a code |
| On the prescription | `bookings/model`, `bookings/types` | `prescription.recommendationCode` (server-written). A new save never keeps the previous one's code |
| The PDF box | `specialistPortal/pdf.ts:67` `recommendationBoxHtml` | One box shared by both documents: "Jansetu", "Recommended tests code: ABCD-EFGH", "Show this code and your mobile number at a Jansetu pharmacy or lab to book these tests." On the full PDF under Tests Advised (`specialistPortal/services/index.ts:641`; the header stays "MyEwaCare", DR13) and on the dispensing copy (`assisted/dispensingCopy.ts:106`) |
| Dispensing copy hash | `assisted/dispensingCopy.ts` `dispensingHashOf` | Includes `recommendationCode` only when present, so copies made before 3d stay current (DR14) |
| Booker view | `assisted/bookerView.ts` `PRESCRIPTION_FIELDS` | Adds `recommendationCode`. Customer and doctor reads already carry the whole prescription |
| Loading | `loadRecommendation` (service) + three thin handlers (`testRecommendations/controller.ts`) | By the code AND the mobile number of the consultation's account. Test names only. Counted with the existing `hitLookup` against the caller's organisation (`pharmacy:<id>`, `doctor:<id>`, `lab:<partnerId>`) and audited, ids only: `assisted_audit_events` action `recommendation.lookup` for pharmacies and doctors, `PartnerAuditEvent` action `lab_desk.recommendation_lookup` for labs |
| Switch | `assisted/flags.ts:41` | `TEST_RECOMMENDATIONS_ENABLED` |
| Lab check | `assisted/labBookings.ts` | `labAdmissible` is exported (the identical change is in r12's working tree), so the lab route reuses it |

**The recommending doctor and the report.** No code change: no file-access rule names a recommender. The suite pins it:
a pharmacy books a lab test for the patient and the lab releases the report; the pharmacy and the patient read it, while
the recommending doctor and another doctor get 404.

#### 25.12.2 Choices made while building (ASSUMED r16, reversible)

| # | Choice | Why |
|---|---|---|
| R1 | No new `testsRecommended` input. The items are the `testsAdvised` names (cleaned: trimmed, inner spaces collapsed, empties dropped) | The owner asked for a minimal API. Notes or catalogue codes per test can be added later |
| R2 | The person (account and family member) is **not stored** on the recommendation; it is read from the consultation | An admin move of the booking (§17.5) then moves the recommendation with it; nothing goes stale |
| R3 | A code loads only while the consultation's doctor-saved prescription (`hasPrescription`) still carries it | A re-save without tests, a re-save while switched off, or an admin clear (S5) makes the old code unloadable without any extra write |
| R4 | The patient list `GET /lab-bookings/recommendations` (§25.7.4) is not built | It serves only "Book" in the app, which is linking. The patient sees the code on the prescription (booking reads) and on the PDF |
| R5 | A malformed code or phone answers 400 without counting a lookup. Every well-formed load counts, found or not | Malformed input reads nothing and reveals nothing; a well-formed load is a phone lookup |
| R6 | Any operational pharmacy, any verified lab with the desk permission, or any eligible doctor may load; the code and phone together are the key | D2: the patient hands both to whoever books |
| R7 | The Luhn mod 32 check misses one error: the swap of neighbouring `0` and `Z` | The mod-N form of decimal Luhn's 09 ↔ 90 blind spot. Every single wrong character is caught |
| R8 | Lab route inside the partner workspace (members, and admins acting as owner), `bookings.manage`. A non-lab → 403 `LAB_PARTNER_REQUIRED`; an unverified or suspended lab → 403 `PARTNER_NOT_VERIFIED` | The same codes as r12's desk |
| R9 | Switched off, a save neither makes nor withdraws a recommendation | The new prescription has no code, so R3 already makes the old one unloadable |
| R10 | The recommendation is upserted before the PDF. If the PDF then fails (500), the recommendation stays without a prescription carrying it | Harmless (R3: not loadable). The next save reuses it, with the same code |

#### 25.12.3 The seam for linking (the next round, after 2b, 2c and 3b)

- **Model.** `test_recommendations.bookings[]` (`{ labBookingId, itemIndexes, byKind, at, cancelled? }`) and the
  statuses `partly_booked` / `booked` exist. Nothing writes them yet.
- **Status at a re-save.** `recommendTestsAtSave` sets `status: 'open'` at every save, marked in the code. The linking
  round recomputes it from `bookings` instead.
- **Still to add:**
  - `PartnerLabBooking.recommendationId` (DR17);
  - `recommendation?: { code, itemIndexes }` on the four lab creates, with the same-person check;
  - the push in the booking transaction;
  - unlinking on cancel and expiry (`partners/services/labBookings.ts:482`, `:418`).
- **The load answer** (`code`, `items[].index`) is what a booker sends back when it links.

#### 25.12.4 API for the web

Each of the three load routes answers `{ success, data }` with `Cache-Control: private, no-store`:

| Who | Route | Guard |
|---|---|---|
| Pharmacy | `POST /api/v1/pharmacy-assisted/recommendations/lookup` | operational, verified pharmacy |
| Lab desk | `POST /api/v1/partner-workspace/lab-desk/recommendations/lookup` (admins: `/api/v1/partner-workspace/admin/:partnerId/workspace/lab-desk/recommendations/lookup`) | member with `bookings.manage`, at a verified lab |
| Doctor | `POST /api/v1/specialists/me/assisted/recommendations/lookup` | verified, active doctor |

- **Body** `{ code, phone }` (r16b: in the body, like `/patients/lookup`, so neither reaches an access log). `code` as
  printed (`ABCD-EFGH`); lower case, spaces and hyphens are fine. `phone`: the patient's 10-digit mobile number.
- **200:** `data: { code: 'ABCDEFGH', status: 'open', items: [{ index: 0, name: 'CBC' }, { index: 1, name: 'Lipid profile' }] }`.
  The items are the tests of the prescription as stored (r16b). Nothing else: no doctor, patient or diagnosis. Show the names; keep `code` and the indexes for booking (linking comes
  later).
- **Errors:**
  - 400 `VALIDATION_ERROR` (no `code` or `phone`; a code longer than 20 characters);
  - 400 `INVALID_CODE` ("This code is not valid; check it on the prescription": a typo, caught by the check character);
  - 400 `INVALID_PHONE`;
  - 403: pharmacy admission codes, `INSUFFICIENT_PERMISSIONS`, `LAB_PARTNER_REQUIRED`, `PARTNER_NOT_VERIFIED`,
    `SPECIALIST_NOT_VERIFIED`;
  - 404 `RECOMMENDATION_NOT_FOUND` (the one answer for an unknown code, a wrong phone, or a code no longer on the
    prescription);
  - 429 `ASSISTED_LIMIT_REACHED` `limit: 'lookups'` (shared with the patient lookup, 120 an hour per organisation);
  - 503 `RECOMMENDATIONS_DISABLED`.

**Doctor's prescription save** (`POST /api/v1/specialists/me/appointments/:id/prescription`): unchanged body. When
`testsAdvised` is not empty and the switch is on, the answer's `prescription.recommendationCode` holds the code. Show it
formatted (`ABCD-EFGH`) after saving. It is absent when no code could be made: the prescription is saved anyway.

**Readers of a prescription:**
- `prescription.recommendationCode` is in the patient's booking reads, the doctor's appointment reads, and the pharmacy
  booker view (`GET /api/v1/pharmacy-bookings[/:id]`).
- The full PDF and the dispensing copy print it in a Jansetu box.

#### 25.12.5 Switch, indexes, deploy, rollback

- **Switch.** `TEST_RECOMMENDATIONS_ENABLED`, off unless exactly `"true"`. Off: saves make no code (the PDF is as before),
  and loads answer 503. Stored codes stay on their prescriptions and PDFs.
- **Indexes.** `npm run sync-indexes` builds the new collection `test_recommendations` (`code_1` unique,
  `consultationId_1` unique). Before it has run, a save makes no code (best effort, logged). Nothing else depends on it.
- **Migration:** none. Older prescriptions get no code.
- **Order:**
  1. deploy;
  2. `npm run sync-indexes`;
  3. `TEST_RECOMMENDATIONS_ENABLED=true`;
  4. restart.
- **Rollback:** the switch. Rolling the code back is safe: no money is involved, and older code ignores
  `prescription.recommendationCode`.

#### 25.12.6 Seen, not changed

- **The full prescription PDF header** still says "MyEwaCare" (`specialistPortal/services/index.ts:605`). Owner question
  Q3, to ask in the morning.
- **`testsAdvised` has no limit on count or length** (`specialistPortal/validation/index.ts:126-128`). A very long list
  makes a long PDF and a long recommendation. Unchanged (no new limit).
- **r12's working tree** has `labOf` and `countPhoneUse` helpers (`assisted/labDesk.ts`, `assisted/patient.ts`). Once
  r12 is merged, the lab route's three-line kind and eligibility check and its lookup-plus-audit can use them.
- **The admin booking edit** (`PUT /api/v1/bookings/:id`, `updateBookingSchema` with its `prescription` part,
  `bookings/validation/index.ts:109-137`) does not know `recommendationCode`, and it leaves the recommendation's items as
  they were. A code the edited prescription no longer carries is not loadable (R3). Unchanged (S4 admin path).

#### 25.12.7 Review fixes (r16b, review of `8e5337f4`)

| # | Finding | Fix |
|---|---|---|
| 1 (privacy) | The patient's phone and the code reached access logs: `GET …/recommendations/:code?phone=` put both in the request line (nginx `combined`), and the app logger logs `req.path` (the code) | The three loads are `POST …/recommendations/lookup` with `{ code, phone }` in the body, validated as the body (`recommendationLookupSchema`), as `/patients/lookup` is. The old GET form is gone (404) |
| 2 | A load could show tests that are not on the prescription: after a re-save whose PDF failed, or racing saves, the recommendation's `items` differed from the stored prescription | A load answers the items from the consultation it already reads: `testNames(prescription.testsAdvised)`, one cleaner shared with the save (trim, collapse spaces, drop empties). New check: a re-save whose PDF fails leaves the prescription as it was, and the load shows its tests |
| 3 | Less code; a stale 404 | The `withdrawn` write at a save without tests is gone (R3 already retires a code the prescription no longer carries; with a failing PDF that write made a still-printed code answer 404). `withdrawn` left the status enum (never written; nothing stored yet) |

Checks: `test/assisted/r16-phase3d.integration.ts` (15 checks).

### 25.13 Round 3e build record (r17, 2026-11-25)

Branch `m0/r17-phase3e` from `55c7eefc` (stage `f5f171c9` + r10g + the phase 3 spec). Local commits only. Built §25.8 for
**pharmacy** bookers on the existing pharmacy wallet. Labs join after 2d + 2e: every booker-wallet movement goes through
`postBookerMovementIn`, so a lab payer is one route in that dispatcher. Owner decisions followed (not reopened):
- wallet only (DR18);
- video or call only (DR19);
- DR20: the quote difference and refunds after acceptance come back as money that cannot be withdrawn, while a full refund
  before acceptance restores the lots;
- no blocking limit except the hourly lookups;
- cut 0;
- SMS as comments only;
- verified, active doctors only.

**What was built**

| Area | Where | What |
|---|---|---|
| Model | `doctors/model/instant.ts` | `source`, `assisted` (Mixed, `InstantAssistedBlock`), `MoneySplit.partnerMinor` (funding, allocated, returned, refunded), `refundReason: 'booker'`; indexes `{assisted.requestKey}` and `{assisted.shortRef}` unique partial, `{assisted.bookedBy.kind, assisted.bookedBy.id, createdAt:-1, _id:-1}` |
| Types | `assisted/types.ts` | `InstantAssistedBlock` (the request's block: funding `{method:'wallet', payerKind, payerId, amountMinor, state: held→allocated\|refunded, walletEntryId, refunds[]}`, `couponFundedBy`, `primaryConcern`); `InstantFundingPointer` + `isInstantFunding` |
| Payer seam | `assisted/bookerWallet.ts` (new) | `postBookerMovementIn({ payerKind, payerId, … })`: pharmacy → `postPharmacyMovementIn`; lab / doctor → 501 `PAYER_NOT_SUPPORTED` until 2d. 2e replaces this file with its dispatcher of the same name |
| Engine | `doctors/services/instant.ts` | generalised, not copied. Unchanged for customer requests; for partner requests: <ul><li>`allocateFunding`: coupon → wallet → partner → gateway (a customer split keeps its former shape);</li><li>accept: quote difference to the booker wallet (`assisted_instant:<id>:quote_return`), the redemption follows the coupon on the fee (or is reversed), booking with `source`, `assisted` (funding = `{ instantRequestId }`, split), `earningRule: 'provider_coupon_v2'`, `settlementSystem: 'ledger'`, `pharmacyId`, `contactNo`, `primaryConcern`;</li><li>refund before acceptance (booker or the inactivity sweep): `assisted_instant:<id>:refund`, lots restored, redemption reversed;</li><li>doctor / admin cancel after acceptance: `assisted_instant:<id>:cancel_refund` = allocated − refunded partner money, redemption reversed, join link version + 1;</li><li>the patient's pay / re-offer / refund / activity → 409 `PARTNER_PAID_BOOKING`; the patient's reads drop all money and keys and add `paidBy`;</li><li>doctor offers show `source`, `bookedBy.name` and the identity note.</li></ul> Shared pieces are public: `couponTermsOf`, `holdPatch(…, partnerMinor)`, `offerTargets`, `notifyOffer`, `reofferOwned`, `activityOwned`, `refundAsBooker` |
| Create, reads, commands | `assisted/instant.ts` (new) | §25.3 patient order, then ONE transaction: key claim, account / family member, pharmacy link, redemption, the request inserted `offered` / `held` (`paymentStatus: 'paid'`, `paymentDeadline` = create time), the debit `assisted_instant:<id>:debit`, the audit. After the commit, the offers go out. Also: booker view, list (cursor), detail, by-key, abandon, re-offer, activity, refund; discovery (specialities, doctors nearest first, quote) |
| Shared patient plan | `assisted/patient.ts`, `assisted/consultations.ts` | `planAssistedPatient` / `applyPatientPlanIn` (refusable steps before anything opens; the account and family member inside the transaction). The 1a consultation create now uses `patient.ts` (its private copies are deleted; r10g is merged). `assistedCouponFor` (was the private `couponFor`) is shared with the instant create |
| Booker view | `assisted/bookerView.ts` | an instant booking shows `instantRequestId` (its money is on the request) and no `payment`; its Join call runs from acceptance to the end of the doctor's held interval (extensions included) |
| Admin move | `assisted/review.ts` | moving an instant booking also moves its request's `userId`, `patient` and the `instant_request` redemption in the same transaction. "Not mine" already works on the booking |
| Reconciliation | `assisted/reconciliation.ts` | `instantChecks` (one debit = held partner money by the payer; refunded-before-accept = one refund of that; accepted = `quote_return` equal to `returned.partnerMinor`, `cancel_refund` ≤ allocated, no "before acceptance" refund; split sums; one earning on completion, none on a no-show); stuck list `instantOfferedPastRefund` (offered > 1 h past `inactivityRefundAt`) |
| Errors | `middleware/errorHandler.ts` | `QUOTE_CHANGED` may carry `details: { quotedAmountMinor, discountMinor }` (the same allow-list as `PRICE_CHANGED`) |
| Audit | `assisted/model/index.ts` | new action `instant.reoffered`; create, refund and cancel reuse `booking.attempted` / `booking.created` / `booking.cancelled` with `detail.kind: 'instant_request'` |

**ASSUMED while building (reversible)**

| # | Choice | Why |
|---|---|---|
| E1 | `postBookerMovementIn` lives in `assisted/bookerWallet.ts` with the pharmacy route only (lab / doctor 501) | §24.7.1 names this file for 2e; nothing in 3e can create a lab- or doctor-paid row yet |
| E2 | The booking stores `assisted.funding = { instantRequestId }` (§25.8.1), but the TypeScript type of `AssistedBlock.funding` stays `AssistedFunding`; `isInstantFunding` guards the reader that can meet it (booker view) | A union type touches about 90 sites in files other rounds are editing. Every booking money path filters on `funding.method` / `funding.state`, and the generic cancel, reschedule and admin close already refuse `bookingKind: 'instant'` |
| E3 | The booking copies the request's whole `assisted` block (key, hash, short ref, consent, join), minus funding / coupon funder / concern | One short ref for the booker; the bookings' unique `assisted.*` indexes are asserted at accept |
| E4 | `primaryConcern` is kept in the request's `assisted` block and put on the booking at accept (for the doctor) | The request schema has no concern field; the doctor reads the booking |
| E5 | The patient's notices carry no money: accept "<partner> booked an instant consultation; a doctor is joining"; refund before accept "No doctor joined this time. <partner> was refunded."; cancel "<reason>." The booker gets accept (Ref, join now), refund and cancel notices with the amount | The patient never paid |
| E6 | Re-offer and refund need `expectedStatusVersion` (the booker screen's version); a stale one is 409 `INSTANT_REQUEST_CHANGED` | §25.8.5 fences |
| E7 | The re-offer audit is written after its single-document compare-and-set (best effort); the refund audit is in the refund transaction | Re-offer moves no money and has no transaction of its own |
| E8 | Doctors list `nearby`: `'pincode'` (doctor profile pincode = the pharmacy's), else `'city'`, else `null`; sorted by that, then fee | §25.8.3 |
| E9 | The patient's `activity` keeps its former answer (409 `REQUEST_NOT_OPEN`) for ids that are not its own, and answers `PARTNER_PAID_BOOKING` only on its own partner-paid request | The customer suites stay unchanged |
| E10 | Every credit back to the booker is recorded on the request at `assisted.funding.refunds[]` (`kind`: `quote_return` \| `refund` \| `cancel_refund`, the wallet entry id) | The booker view sums them; reconciliation compares them with the wallet |

**API for the web** (pharmacy token, `/api/v1/pharmacy-assisted/instant`; answers `{ success, data }`)

| Route | Request → answer |
|---|---|
| `GET /specialities` | `?mode=video\|call` → `[{ specialization, onlineNow }]` |
| `GET /doctors` | `?speciality&mode` → `[{ doctorId, name, specialization, modes, instantFeeMinor, nearby: 'pincode'\|'city'\|null }]` (eligible, online, not busy) |
| `GET /quote` | `?speciality&mode&doctorId?` → `{ quotedAmountMinor, doctors }` |
| `POST /requests` | `{ requestKey, phone, patient, holderName?, consent, preferredLanguage, specialization, mode, target: {kind:'any'}\|{kind:'specific', doctorId}, join: { on, phone? }, couponCode?, acceptedQuoteMinor, acceptedPayableMinor, primaryConcern?, paymentMethod: 'wallet' }` → 201 (replay 200) `{ request: <view>, funding: { method, amountMinor, state, walletEntryId }, newAccount, replayed }` |
| `GET /requests` | `?status=offered\|accepted\|refunded&cursor&limit≤50` → `[<view>]`, `pagination: { total, nextCursor }` |
| `GET /requests/:id` | `<view>` (own only, else 404 `INSTANT_REQUEST_NOT_FOUND`) |
| `GET /requests/by-key/:key` | `{ state: 'used', request }` \| `{ state: 'abandoned' }` \| `{ state: 'unknown' }` |
| `POST /requests/by-key/:key/abandon` | `{ state: 'abandoned' }`, or the `used` answer |
| `POST /requests/:id/reoffer` | `{ target, expectedStatusVersion }` → `<view>` |
| `POST /requests/:id/activity` | → `<view>` (the inactivity refund moves 30 minutes out) |
| `POST /requests/:id/refund` | `{ expectedStatusVersion }` → `{ refundedMinor, request }` |

`<view>` = `{ _id, status, statusVersion, mode, specialization, target, offerGeneration, offerExpiresAt, inactivityRefundAt,
offeredCount, acceptedDoctorName, bookingId, patientName, holder, assisted: { shortRef, join: { on }, preferredLanguage,
disputed? }, money: { quotedAmountMinor, discountMinor, paidMinor, returnedMinor, refundedMinor }, createdAt, updatedAt }`.

The accepted booking appears in `GET /pharmacy-bookings`, with `instantRequestId` and the Join call link while the call
is on (`join.on: 'partner_device'`).

The doctor's `GET` offers add `source`, `bookedBy.name` and `identityNote`. The patient's `/api/v1/instant/requests*`
answers add `paidBy` and drop the money.

**Errors**
- 400: `CONSENT_REQUIRED`, `PAYMENT_METHOD_UNAVAILABLE` (card), `VALIDATION_ERROR` (including chat), `DOCTOR_REQUIRED`,
  `INVALID_PHONE`, `REQUEST_KEY_REQUIRED`, `INVALID_COUPON`, `COUPON_NOT_FOR_ASSISTED`.
- 404: `INSTANT_REQUEST_NOT_FOUND`, `DEPENDENT_NOT_FOUND`.
- 409:
  - doctors: `NO_DOCTOR_ONLINE`, `DOCTOR_NOT_ONLINE`;
  - price: `QUOTE_CHANGED` (`details: { quotedAmountMinor, discountMinor }`);
  - wallet: `INSUFFICIENT_BALANCE`, `WALLET_FROZEN`, `WALLET_INACTIVE`, `WALLET_RECEIVABLE`;
  - coupon: `COUPON_EXHAUSTED`;
  - keys: `IDEMPOTENCY_KEY_REUSED`, `REQUEST_ABANDONED`;
  - request state: `REQUEST_NOT_OPEN`, `REQUEST_NOT_REFUNDABLE`, `INSTANT_REQUEST_CHANGED`;
  - the patient's commands on a partner-paid request: `PARTNER_PAID_BOOKING`.
- 429 `ASSISTED_LIMIT_REACHED` (lookups).
- 503: `ASSISTED_BOOKING_DISABLED`, `INDEXES_OUTDATED`, `CUSTOMER_LINKING_UNAVAILABLE`.

**Switches, deploy, rollback**
- `ASSISTED_INSTANT_ENABLED` (new) and `ASSISTED_BOOKING_ENABLED_PHARMACY`.
  - Either off: the speciality, doctor and quote reads and new requests answer 503.
  - Re-offer, activity, refund, accept, cancel, reads and the sweeps always run.
- No migration. Order:
  1. deploy;
  2. `npm run sync-indexes` (the three new `instant_requests` indexes);
  3. `ASSISTED_INSTANT_ENABLED=true`;
  4. restart.
- Rollback with the switch. Never roll back the code while a partner request is `offered` or its booking is `confirmed`.
  Both of these must be 0:
  - `db.instant_requests.countDocuments({ 'assisted.bookedBy.kind': { $exists: true }, status: 'offered' })`;
  - `db.bookings.countDocuments({ bookingKind: 'instant', source: { $in: ['pharmacy_assisted','lab_assisted'] }, status: 'confirmed' })`.

**Tests:** `test/assisted/r17-phase3e.integration.ts` (24 checks). Covered:
- switch;
- index 503;
- validation;
- discovery;
- create: one debit, offers to eligible doctors only, link, no patient-wallet movement;
- keys: replay, other content, by-key, abandoned;
- 5-way create race;
- over-balance race;
- accept: booking shape, quote return once;
- percentage coupon recomputed on the fee;
- two-doctor accept race;
- accept against booker refund, and against the inactivity sweep;
- activity and inactivity refund with lots restored;
- stale and racing booker refunds;
- re-offer;
- doctor vs admin cancel race: refund once, redemption reversed, link dies;
- the patient's commands refused and reads without money;
- refunds to frozen and inactive wallets;
- unverified doctor: no offer, accept 403;
- earnings once, no-show nothing;
- scope 404 and paging;
- family member and the doctor's offer card;
- reconciliation clean, tampered row flagged, stuck list;
- `allocateFunding` shapes.

The customer suites (Q4b, Q13, Q16a) run unchanged in the full regression.

**Seen, not changed**
- `assisted/labBookings.ts` still has its own copy of the patient plan and of `newShortRef`. Unify it with
  `planAssistedPatient` once 3b and 3d, which edit that file, are merged.
- `assisted/labRefunds.ts:37` credits pharmacy payers only (§25.5). It must move to `postBookerMovementIn` in 2e/3b.
- "This isn't mine" works on the accepted instant booking. A request no doctor has accepted yet cannot be reported:
  there is no booking. It is refunded within 30 minutes of the booker leaving the screen.
- The booker's weekly cancellation rate counts bookings only. Refunding a request before any doctor accepts it is not
  counted as a cancellation.

**r17b: review fixes (Opus xhigh review of `02b4a0e0`).** The money paths were probed and are correct.

| # | Finding | Fix | Check |
|---|---|---|---|
| 1 (must) | The doctor's accept answer (fresh and replay, `doctors/services/instant.ts` `accept`) returned the raw partner booking: `price`, `originalPrice` and the whole `assisted` block (keys, consent actor, booker id, split). This breaks D8 | Both paths answer `assistedPublicView(booking)` for a partner's booking (`doctorBookingView`): no money, no keys, `paidBy` | accept check |
| 2 (must) | An admin move of an instant booking left the pharmacy-created family member active on the old account. Its `booking.created` audit is keyed by the request id, and the request still named the member when the check ran | `deactivateBookingDependentIn` also matches the audit on `instantRequestId`, and leaves the moved booking's own request out of the "still used" check | "r17b: an admin move…" |
| 3 | `bookerEntriesOf` read by operation key alone | It reads `{ pharmacyId, operationKey }`, which the unique index serves | reconciliation check |
| 4 | An instant booking kept its "Join call" after it was cancelled or completed | The join window also requires `status: 'confirmed'` | "r17b: an admin move…" |
| 5 | The patient got "No doctor joined this time" even when the booker cancelled the request at the counter | No patient notice for a booker refund; the booker's notice stays | booker refund check |

**Later (seen, not changed):**
- by-key / abandon, cursor paging and the create preamble (validate, replay, count the lookup, abandoned key) are written
  three times: in `assisted/instant.ts`, `assisted/labBookings.ts` and `assisted/pharmacyCommands.ts`. Extract one
  helper of each once the open rounds have merged.
- ASSUMED E2: `AssistedBlock.funding` keeps its type for the instant pointer. A union type needs the readers changed in
  one pass.

### 25.14 Round 3a build record: the doctor wallet (r20, 2026-11-25)

Branch `m0/r20-phase3a` from `215556e2` (2d, the lab wallet) with `m0/r15-phase3-spec` merged. Local commits only. Built
§25.4 with DR2–DR5 and the §25.11 decisions, on 2d's partner store and shared wallet rules (`pharmacyWallet/walletCore.ts`):
no new store, no copied money code. Pharmacy and lab behaviour is unchanged (their suites are the regression check).

**What was built**

| Area | Where | What |
|---|---|---|
| Owners of the partner store | `partnerWallets/ledger.ts` | One top-up kind factory (`partnerTopupKind`) makes `labTopups` and the new `doctorTopups` (`notes.flow: 'doctor_wallet_recharge'`, owner in `payerSpecialistId`; flag-only chargebacks; a lot with the Razorpay fee while `ASSISTED_BOOKING_ENABLED_DOCTOR` is on; `withdrawableAfter` = payment + 7 days). One owner descriptor each (`LAB`, `DOCTOR`): switch, existence (admin tools), may-spend (S5, read in the spending transaction), the top-up order (request-key scope and payer fields). `debitDoctorWalletIn` / `refundDoctorWalletIn` for 3b (and the lab pair, unchanged in signature) share one debit and one refund |
| Shared core | `pharmacyWallet/walletCore.ts` | `TopupKind` gains `kind: 'doctor'`, `payerField`, `ownerField` and an optional `assertCreditable` (the partner kinds fail closed, 503, before a credit while the store's unique indexes are missing; the sweep retries) |
| Payments | `payment/services`, `payment/controller`, model, types | `PaymentRecord.payerSpecialistId` (+ index `{payerSpecialistId, createdAt}`, partial `$exists`); doctor top-ups are credited through the shared credit like every top-up kind, routed BEFORE the customer-wallet default; a record carrying a lab or doctor flow but naming no owner is refused (409 `TOPUP_OWNER_MISSING`), never credited to a customer wallet (DR5); a doctor top-up is verified only by its doctor or an admin (DR4); the sweep takes every lab and doctor top-up; `/payments/verify` and `/reconcile` answer the doctor wallet view (state only for an ineligible doctor) |
| Doctor app | `partnerWallets/routes.ts` (`doctorWalletRouter`), `src1/routes/index.ts` | Mounted at `/api/v1/specialists/me/assisted` (before `/specialists/:id`), below |
| Admin | `partnerWallets/routes.ts` (`adminWalletRouter(owner)`) | One router per owner kind: `/api/v1/admin/labs` (2d, unchanged) and `/api/v1/admin/doctors` (new). The existing chargeback, lot chargeback and close-compensated routes take doctor top-ups (the kind's `ownerField` names the doctor) |
| Service | `partnerWallets/service.ts` | Reads, the keyed top-up order, the check, admin reads, admin top-up, by-key and freeze take the owner (`LAB` or `DOCTOR`): one implementation |
| Switch | `assisted/flags.ts` | `ASSISTED_BOOKING_ENABLED_DOCTOR` and `assertDoctorWalletOn` |
| Reconciliation | `partnerWallets/reconciliation.ts` | Partner wallet invariants already cover doctor wallets (`ref: 'doctor:<id>'`); the uncredited list covers lab and doctor top-ups (`walletKind`, then `partnerId` or `specialistId`; `state: 'paid_no_owner'` for a partner-flow record naming nobody) |

Checks: `test/assisted/r20-phase3a.integration.ts` (14 checks; 15 with the review fix below).

**ASSUMED (r20 build, reversible)**

| # | Choice | Why |
|---|---|---|
| E1 | Doctor wallets take the O2 limits as lab wallets (₹50,000 checked at order time, card money withdrawable 7 days after payment, stored) and the admin top-up cap (₹2,00,000) | O2 is about partner wallets |
| E2 | A lost card dispute on a doctor top-up is flagged only (C4), as for labs | coordinator's instruction |
| E3 | Doctor top-ups always join the recovery sweep (not gated by `WALLET_RECHARGE_SWEEP_FROM`) | none predates it (as 2d D4) |
| E4 | The DR4 rule binds only callers that name themselves (the routes): a doctor-flow record answers 404 to anyone but its doctor (`specialist` with the same id) or an admin; the internal sweep and the check keep reconciling as the payer | DR4 |
| E5 | The partner kinds (lab and doctor) fail closed before a credit while `partner_wallets {ownerKind, ownerId}`, `partner_wallet_entries {walletId, operationKey}` or `wallet_topup_lots {paymentRecordId}` is missing (503; the record stays paid and the sweep credits it after `sync-indexes`). For labs this is new; it changes nothing once the indexes exist | §25.4.4 "before any credit" |
| E6 | A record with a lab or doctor flow but no owner field is refused with 409 `TOPUP_OWNER_MISSING` and listed (`paid_no_owner`); pharmacy records keep their old routing | DR5, pharmacy unchanged |
| E7 | The doctor app has no top-up history list (the 2d lab list stays); a lost answer is resolved by resending the same request key (same order) or the check | "keep the API minimal" |
| E8 | The check answers `{ state }` for an ineligible doctor and adds `wallet` only for an eligible one; `/payments` answers `entity: { state }` for an ineligible doctor | §25.4.2 |
| E9 | Admin wallet tools 404 `SPECIALIST_NOT_FOUND` for any id that is not a doctor (pharmacy, lab, unknown, malformed); they work for an unverified doctor | admin tools |

**API for the web**

Doctor app (specialist token; `{ success, data }`, `Cache-Control: private, no-store`; paise):

| Route | Guard | Request | `data` |
|---|---|---|---|
| `GET /api/v1/specialists/me/assisted/wallet` | eligible doctor | — | `{ balanceMinor, withdrawableMinor, receivableMinor, frozen, isActive, updatedAt }` (no wallet: zeros, `updatedAt: null`; nothing created) |
| `GET …/me/assisted/wallet/entries` | eligible doctor | `?cursor&limit` (≤ 50, default 20) | `[{ _id, kind, amountMinor (signed), balanceAfterMinor, description, referenceType, referenceId, at }]`; top-level `pagination: { nextCursor }` |
| `POST …/me/assisted/wallet/topups` | eligible doctor, switch | `{ amountMinor (100…5000000), requestKey (^[A-Za-z0-9_-]{8,100}$) }` | `{ paymentTransactionId, razorpayOrderId, razorpayKeyId, amountMinor, currency, state, replayed }` |
| `POST …/me/assisted/wallet/topups/:paymentTransactionId/check` | any doctor (its own record) | — | `{ state: 'credited' \| 'unpaid', wallet? }` (`wallet` only for an eligible doctor) |
| `POST /api/v1/payments/verify` (existing) | the doctor | `{ paymentTransactionId, razorpayOrderId, razorpayPaymentId, razorpaySignature }` | `{ context: 'wallet_recharge', paymentRecord, entity }`, `entity` = the wallet view, or `{ state }` for an ineligible doctor |
| `POST /api/v1/payments/reconcile` (existing) | the doctor or an admin | `{ paymentTransactionId }` | as verify with `state: 'paid'`, or `{ state: 'unpaid', gatewayStatuses }` |

Flow: create the order, open Razorpay Checkout (`key = razorpayKeyId`, `order_id`, `amount = amountMinor`), then
`/payments/verify`. A lost answer: resend the same body and key (same order), or "Check" / `/payments/reconcile`. The server
sweeps every doctor top-up, so a capture is never lost. Show the line "Collect from your patient at your counter".

Errors: 400 `VALIDATION_ERROR` and the §23.3 payment errors; 403 `FORBIDDEN` (not a doctor token), `SPECIALIST_NOT_VERIFIED`
(reads and new top-ups of an ineligible doctor); 404 `PAYMENT_RECORD_NOT_FOUND` (another doctor's, a pharmacy's or an unknown
record: one answer, also on `/payments` for any other caller); 409 `IDEMPOTENCY_KEY_REUSED`, `WALLET_LIMIT_REACHED` (with
`details`), `TOPUP_BLOCKED`, `TOPUP_OWNER_MISSING`, `PAYMENT_CHANGED`; 502 `RAZORPAY_ORDER_CREATION_FAILED`; 503
`ASSISTED_BOOKING_DISABLED` (switch off: new top-ups only), `INDEXES_OUTDATED`, `RAZORPAY_NOT_CONFIGURED`.

Admin (admin token; writes need `ASSISTED_ADMIN_TOOLS_ENABLED`): `GET /api/v1/admin/doctors/:specialistId/wallet`,
`/wallet/entries`, `/wallet/lots`; `POST …/wallet/topup` (header `Idempotency-Key`; `{ amountMinor (1…20000000), notes? }`);
`GET …/wallet/topups/by-key/:key`; `PUT …/wallet/freeze { frozen, reason }` — the same shapes and errors as the lab admin
routes of §24.13, with 404 `SPECIALIST_NOT_FOUND`. The existing `POST /api/v1/admin/wallet-payments/:paymentId/chargeback`,
`/wallet-lots/:lotId/chargeback` and `/wallet-payments/:paymentId/close-compensated` (+ by-key) answer a doctor top-up with
`walletKind: 'doctor', specialistId` (chargeback: flagged only; close: message "… paid to the doctor …").
`GET /api/v1/admin/wallet-recharges/uncredited` lists doctor rows `{ paymentTransactionId, walletKind: 'doctor', specialistId,
amountMinor, createdAt, state }`.

**Switches and deploy order**

- `ASSISTED_BOOKING_ENABLED_DOCTOR` (new, off unless exactly `"true"`): new doctor top-ups and their lots. Off: 503 on a new
  top-up; verify, reconcile, the check, the sweep and the admin tools keep working (paid money is credited, without a lot).
- Order: 1. deploy (switch off); 2. `npm run sync-indexes` (new `paymentrecords {payerSpecialistId, createdAt}`; 2d's
  partner-store indexes if 2d is deployed with it); 3. `ASSISTED_BOOKING_ENABLED_DOCTOR=true`; 4. restart. No migration.
- Rollback: the switch. Never roll the code back below r20 while a doctor top-up is `created` or paid and not credited:
  older code would credit a CUSTOMER wallet keyed by the doctor's id. Check
  `db.paymentrecords.countDocuments({ 'notes.flow': 'doctor_wallet_recharge', walletCreditedAt: { $exists: false }, status: { $in: ['created', 'paid'] } })` = 0.

**Review of 2d, folded in (r20b, its own commit)**

| # | Finding | Fix |
|---|---|---|
| 1 | The lab wallet routes re-implemented member admission (`labMember`) | The shared partner permission guard (`middleware/auth.ts`) takes `{ verified }`: `requirePartnerPermission` (operational partner, as before) and the new `requirePartnerPermissionUnverified` (an active member of an active partner, verified or not: 2d D5). The lab routes use them, then a lab check (404 `WALLET_NOT_FOUND`). A clinic member without the wallet permission now gets 403 `INSUFFICIENT_PERMISSIONS` before that 404. Doctors keep `requireSpecialist` + `requireEligibleDoctor` |
| 2 | `lotsWritable` was copied in the pharmacy and partner kinds | One `walletLots.lotsWritableWhen(switch)` for every kind |
| 3 | The pharmacy admin top-up had no server-side cap (only the web form's ₹2,00,000) | Owner: keep ₹2,00,000. The shared `adminTopup` refuses an amount over ₹2,00,000 (400 `VALIDATION_ERROR`, nothing credited) for every kind, so `POST /api/v1/pharmacy-wallet/topup` (admin) too. The pharmacy's own Razorpay top-up is not an admin top-up and is unchanged. Check: "review of 2d (3)" (15 checks in all) |

**Seen, not changed**

- Before r20 a `wallet_recharge` record whose flow was not the pharmacy's was always credited to the customer wallet of its
  `userId`; r20 refuses partner flows without an owner, but a pharmacy-flow record without `payerPharmacyId` still takes
  the old customer path (pharmacy behaviour kept; the S6 audit lists such records).
- The 2d note on `$type` partial indexes stands (the pharmacy admin top-up cap is now enforced, above).

### 25.15 Round 3b build record: a doctor books a lab test, paid from the doctor wallet (r26, 2026-11-25)

Branch `m0/r26-phase3b` from `f7f57ad2` (r19-stage-next with 3e) with `m0/r20-phase3a` (3a + the 2d review fixes) merged.
Local commits only. Built §25.5 with DR6–DR9 and the §25.11 decisions. No copies: the 2a create, reads, by-key, cancel
and accept are now one implementation with a booker (`LabBooker`: a pharmacy or a doctor); the pharmacy's keys, scopes,
answers and money are byte-identical (the 2a/2b suites are the check).

**What was built**

| Area | Where | What |
|---|---|---|
| Booker | `assisted/labBookings.ts` | `LabBooker = { kind: 'pharmacy', pharmacyId, actorId } \| { kind: 'doctor', specialistId }`; `createAssistedLabBooking`, `listLabsFor`, `labCatalogueFor`, `branchSlotsFor`, `listLabBookingsFor`, `getLabBookingFor`, `findLabByKeyFor`, `abandonLabByKeyFor`, `cancelLabFor`, `acceptLabRescheduleFor`, `lookupPatientFor`; the pharmacy names (`createPharmacyLabBooking` …) are one-line wrappers. Doctor key `assisted_lab:doctor:<sid>:<sid>:<key>`, scope `assisted_lab_create:doctor:<sid>`, org key `doctor:<sid>` |
| Patient sources | same, `assisted/treating.ts` (new) | `fromBookingId` + `typedName`: the doctor's own consultation (not an unpaid card booking, no open "not mine", inside its treating window: `treatingWindowOf`, §25.9.1), no lookup counted; or a walk-in by phone as 2a (counted, masked, the account opens in the transaction). Exactly one source (400) |
| Create | same | `source: 'doctor_assisted'`, `assisted.bookedBy = { kind: 'doctor', id, actorKind: 'doctor', actorId, name: 'Dr <name>' }`, `assisted.fromBookingId`, funding `payerKind: 'doctor'`; the `assisted_links` row (first typed name); pair alert, coupon redemption and audit as the doctor; the lab then the doctor re-read in the transaction (403 `SPECIALIST_NOT_VERIFIED`); the debit through `postBookerMovementIn`; cut 0, `referral: null`. Card is refused (400 `PAYMENT_METHOD_UNAVAILABLE`, 3c) |
| Money dispatcher | `assisted/bookerWallet.ts` | `postBookerMovementIn` gains the doctor case (`debitDoctorWalletIn` / `refundDoctorWalletIn`, 3a), signature unchanged (2e adds the lab case beside it); `bookerEntryLotsIn` and `bookerEntriesOf` read the doctor's partner-store entries |
| **Refund bug** | `assisted/labRefunds.ts` | Every wallet-funded lab refund goes through `postBookerMovementIn` (the debit's lots restored). A doctor-paid row used to be marked refunded with no credit; pharmacy refunds are unchanged |
| Report access | `file/access.ts` | `canReadPartnerLabReport`: the doctor that BOOKED reads the released report for 90 days from the first release while verified and active; a recommending-only doctor, another doctor and pharmacies get the uniform 404 |
| Names | `assisted/names.ts`, `assisted/patient.ts` | `linkFacingHolders` (typed name on the booker's `assisted_links` row, else masked; never the account name); `bookerNames` takes the booker kind. The stage line's `linkLabIn` (r12b) stays the one `assisted_links` writer; r26 lets it take `{ bookerKind: 'doctor', bookerId }` (its lab calls are unchanged) |
| Reconciliation | `assisted/reconciliation.ts` | `labBookingChecks` reads the payer's own entries (`bookerEntriesOf`): doctor rows reconcile |
| Routes, switch | `assisted/routes/doctorLab.ts` (new), `assisted/validation`, `assisted/flags.ts`, `src1/routes/index.ts` | Below. `ASSISTED_LAB_BOOKING_ENABLED_DOCTOR` (+ `assertDoctorLabOn`) |

Checks: `test/assisted/r26-phase3b.integration.ts` (11 checks).

**ASSUMED (r26, reversible)**

| # | Choice | Why |
|---|---|---|
| F1 | `typedName` names the holder for a consultation of the holder (the link's typed name); for a family member's consultation the family member's own name is the patient name and the link gets no typed name | names rule (2a B7) |
| F2 | An open "not mine" report on the source consultation answers 404 `BOOKING_NOT_FOUND` (like a missing booking) | one answer |
| F3 | The treating window is the pure §25.9.1 helper; 3f will reuse it for history and files | spec |
| F4 | The doctor's view shows no `payment` block (wallet only in 3b); `holder` is `{ linkId, name, typedName }` | §25.5.2 |
| F5 | Doctor routes need an eligible doctor for every call (reads included); refunds and report reads re-check eligibility themselves | S5, DR3 |
| F6 | Not built in 3b: the admin move of a doctor row's `assisted_links` row (§25.5.2 last row; r12b's `moveLabLinkIn` moves desk rows only); card (3c) | time; flagged for the next round |

**API for the web** (specialist token, verified and active; `{ success, data }`, `Cache-Control: private, no-store`; paise)

| Route | Request | `data` |
|---|---|---|
| `POST /api/v1/specialists/me/assisted/patients/lookup` | `{ phone }` | `{ exists, holderNameMasked }` (counted, 120/h) |
| `GET …/me/assisted/labs` | `?visitMode&limit` | as §24.11, `nearby` from the doctor's pincode, then city |
| `GET …/labs/:partnerId/catalogue`, `GET …/labs/branches/:branchId/slots` | as §24.11 | as §24.11 |
| `POST …/me/assisted/lab-bookings` | 2a's body (§24.11) with ONE patient source: `{ fromBookingId, typedName }` or `{ phone, patient, holderName? }`; `paymentMethod: 'wallet'` | 201 (replay 200) `{ booking: <booker lab view>, funding: { method: 'wallet', amountMinor, state, walletEntryId }, split, newAccount, replayed }` |
| `GET …/me/assisted/lab-bookings`, `GET …/lab-bookings/:id` | `?status&from&to&cursor&limit≤50` | the booker lab view (§24.11) with `holder: { linkId, name, typedName }`; only this doctor's rows (else 404 `LAB_BOOKING_NOT_FOUND`) |
| `GET …/lab-bookings/by-key/:key`, `POST …/by-key/:key/abandon` | — | `{ state: 'used', booking } \| { state: 'abandoned' } \| { state: 'unknown' }` |
| `POST …/lab-bookings/:id/cancel` | `{ reason?, expectedVersion? }` | `{ booking, refundedMinor, alreadyCancelled }` (1 h before the slot, or while a lab reschedule is unanswered; refund to the doctor wallet) |
| `POST …/lab-bookings/:id/accept-reschedule` | `{ version }` | the view |

Errors: 2a's (§24.11), plus 403 `SPECIALIST_NOT_VERIFIED`; 404 `BOOKING_NOT_FOUND` (`fromBookingId`); 409 `TREATING_WINDOW_CLOSED`;
400 `PAYMENT_METHOD_UNAVAILABLE` (card). The patient app and the lab workspace show "Booked by Dr <name>" (`bookedBy.name`).
The released report file is readable by the booking doctor at `report.releases[].file` while it is listed.

**Switches and deploy order**

- `ASSISTED_LAB_BOOKING_ENABLED_DOCTOR` (new, off unless exactly `"true"`; needs `ASSISTED_BOOKING_ENABLED_DOCTOR`). Off: the
  lookup, the lab reads and new bookings answer 503. Reads, by-key, cancel, accept, refunds and report access always work.
- Order: 1. deploy (switches off); 2. `npm run sync-indexes` (the 2c/2d/3a indexes); 3. both switches on; 4. restart. No migration.
- Rollback: the switch. Never roll the code back below r26 while a `doctor_assisted` row is open (older code refunds nobody):
  `db.partner_lab_bookings.countDocuments({ source: 'doctor_assisted', status: { $nin: ['completed','cancelled','no_show'] } })` = 0.
- Merge with 2e (`m0/r21-phase2e`): `assisted/bookerWallet.ts` keeps its signature; 3b adds only the doctor branches.

**Seen, not changed**

- `assisted/refunds.ts` (consultations) still credits only pharmacy payers; 2e changes it for labs, and a doctor never pays
  a consultation in phase 3 (no path).
- The admin move of a doctor-made lab row does not move its `assisted_links` row yet (F6).

**r26b: review fixes (review of `fe2f1c58`; money correct, nothing must-fix)**

| # | Finding | Fix |
|---|---|---|
| 1 | `doctorLab.ts` guarded the shared `/specialists/me/assisted` mount with a path-less `use`, so routes mounted after it (3a's top-up check for an ineligible doctor, E8; 3d's recommendation lookup) and unknown paths got 403 | The guards sit on each 3b route; check "the 3b guards sit on its own routes" |
| 2 | An unpaid customer booking (`pending`, not paid) opened a treating window | `treatingWindowOf` keeps it closed; a pay-at-clinic booking (confirmed, unpaid) still opens one |
| 3 | Tests | The pharmacy refund check seeds a card lot (restored exactly); a race beyond the doctor's balance; the admin no-show cancel forfeits (and refunds the doctor when asked) |
| 4 | The lab list's `source` filter refused `doctor_assisted` | Allowed (`partners/validation/labBooking.ts`) |

Checks: `test/assisted/r26-phase3b.integration.ts` (14 checks).

### 25.16 Round r29: the prescription heading, and round 3c (a doctor pays a lab booking by card/UPI) (2026-11-25)

Branch `m0/r29-phase3c` from `6a8574e9` (the stage line `m0/r28-stage-next-3`: 3a, 3b, 2e, 4a/4b, 5a). Local commits
only. Check: `test/assisted/r29-phase3c.integration.ts` (21 checks over HTTP with the real routes, a stand-in Razorpay and
refund gateway). Where this section and §25.6 differ, this one wins.

#### 25.16.1 A. The prescription PDF heading (owner, 25 Nov)

- New prescription PDFs are headed **"Jansetu"** instead of "MyEwaCare" (`specialistPortal/services` `buildPrescriptionHtml`).
  Nothing else on the PDF changes. DR13 and §25.11 Q3 are superseded.
- PDFs already issued stay as they are: nothing is regenerated (a re-save of the prescription makes a new PDF, which says
  Jansetu).
- The dispensing copy already said "Jansetu" (§17.2); it is unchanged.
- Checks: r29 "A" (the rendered HTML has the Jansetu heading and no "MyEwaCare"); r16's PDF check now expects the Jansetu
  heading.
- **Seen, not changed** (other places that still say MyEwaCare / Myewacare; not prescription PDFs):
  - the sign-in OTP SMS text "…on MyEwaCare, a service of EWA Healthcare Solutions…" (`sms/services`; a DLT-registered
    template, pinned byte for byte by the r25 suite);
  - the OTP emails' subject and text (`auth/services`: sign-in, email and corporate-email verification);
  - the external-booking emails (`externalBookings/emailTemplates.ts`), named by `CONFIG.STORE_NAME` (default `Myewacare`)
    and `support@myewacare.com` (`config/config.ts`, SMTP sender default too);
  - the Meet invite email of customer bookings, signed "Myewacare" / "EWA Healthcare" (`meet/service`; assisted bookings'
    events are already neutral "Jansetu");
  - the app store links (`appVersions/services`, the store ids).
  The lab invoice and payout PDFs carry no brand.

#### 25.16.2 B. What was built (round 3c)

No copied card code: the 1b/2b/2e card machinery now names its payer by kind in ONE table, and a doctor is the third
payer kind. Pharmacy and lab card payments, and the doctor wallet path (3b), are unchanged (their suites are the check).

| Area | Where | What |
|---|---|---|
| Payer table | `assisted/cardRefunds.ts` (`RECORD_PAYERS`, `recordPayerOf`, `recordPayerFieldsOf`, `payerBlockedAtCapture`) | Per payer kind: the record field that names it (`payerPharmacyId`, `payerPartnerId`, new `payerSpecialistId`), the order's payer fields and note key (pharmacy and lab byte-identical to 1b / 2e), and whether a capture is still taken (only a doctor no longer verified and active is refused, DR9) |
| Order | `assisted/cardPayments.ts` `openCardOrderOf` | A doctor's order: `userId` = `payerUserId` = `payerSpecialistId` = the doctor, no `payerPharmacyId`, notes `{ flow: 'assisted_lab_booking', specialistId, bookingId }`, receipt `al` |
| Capture | `assisted/cardPayments.ts` `applyAssistedCaptureOf` | The payer check reads the doctor (`recordPayerOf`). A capture for a doctor no longer verified and active is a late capture returned to the card in the same transaction, audited `booking.late_capture` with `payerBlocked: true`; the booking stays waiting and then expires (DR9, as C9). The follow-up lease, extra captures and the sweeps are the one path. Capture audits name the doctor (`actorKind`/`orgKind: 'doctor'`, `bookerAuditFields`) |
| Refund rows | `assisted/model` | `payerKind` enum gains `doctor`. To the card by default; `refundTo: 'wallet'` (the doctor's own cancel) or the admin fallback credits the doctor wallet through `postBookerMovementIn` (`refundDoctorWalletIn`), no lot, not withdrawable (C3) |
| Admin rows | `assisted/cardRefunds.ts` | Card refund rows and stuck money's card chargebacks name a doctor payer `payerKind: 'doctor'`, `payerId`, `payerName: 'Dr <name>'` (`doctorBookerName`, shared with the booking's `bookedBy.name`). The chargeback list now reads every payer field |
| Create | `assisted/labBookings.ts` | The 3b refusal of `paymentMethod: 'razorpay'` is gone: a doctor's card create is the 2b card create (`pending_payment`, `paymentDeadline` = now + 30 min, seat held, funding `{ method: 'razorpay', state: 'pending', paymentRecordId, payerKind: 'doctor' }`, no wallet debit, the order after the commit). Both patient sources (§25.5.3) |
| Doctor view | `assisted/labBookings.ts` `bookerLabViews` | The doctor's booker lab view carries `payment` as the pharmacy's does (`bookerPayments` takes any payer, `payerRefOf`) |
| Cancel | `assisted/routes/doctorLab.ts` | The doctor's cancel passes `refundTo` |
| Verify / reconcile | `payment/services`, `payment/routes`, `payment/controller`, `specialists/eligibility.ts` | A doctor's card record is verified and reconciled only by that doctor (specialist token, `payerSpecialistId`); anyone else, an admin included, gets 404 `PAYMENT_RECORD_NOT_FOUND`; the sweeps act as its payer. A doctor no longer verified and active is answered 403 `SPECIALIST_NOT_VERIFIED` on verify and reconcile of an assisted card record (the pharmacy gate of §23.1 for doctors; `assertEligibleDoctor`); its top-ups are not gated (DR3). The answer's `entity` is the doctor's booker lab view |

Everything else needed no change: unpaid rows are hidden by funding method (`LAB_UNPAID_CARD_QUERY`), so a doctor's
unpaid card row is the doctor's alone; patient, lab-reject and admin cancels queue the card refund to the doctor's card;
the lab sweep reconciles and expires it; booker notices go to the doctor (`bookerNoticeUserId`); reconciliation checks
wallet rows only (E9).

#### 25.16.3 Choices made while building (ASSUMED r29, reversible)

| # | Choice | Why |
|---|---|---|
| G1 | The doctor's booker view carries `payment` on every row, wallet rows too (`{ method: 'wallet', state, payBy: null }`); 3b's F4 (no `payment` block) is superseded | The web offers the refund choice by `method`, as for pharmacies |
| G2 | DR9 reads the doctor at capture time (before the capture's transaction, as the provider S5 check); a missing doctor record counts as not eligible (the money goes back to the card) | Nobody can use a booking of a doctor that is gone |
| G3 | Only the paying doctor verifies or reconciles its card record; admins get 404 there (they use the admin card-refund and chargeback tools), as for pharmacy and lab card records | DR4's ownership rule; one answer for everyone else |
| G4 | The 403 for an ineligible doctor applies to any assisted card record (before ownership, as the pharmacy gate) but not to unknown ids or top-ups | The pharmacy pattern; DR3 |
| G5 | A doctor's waiting card booking can be cancelled at any time (nothing refunded, nobody else told), as 2b's E3 | One cancel rule |
| G6 | Late and extra captures, mark-failed and the extra-capture chargeback alert and audit name the row's payer kind. Before r29 the last two said `pharmacy` for every row, so lab rows now say `lab` | A doctor row must not be audited as a pharmacy; the same line fixes lab rows |
| G7 | Doctor referral cuts stay off (`REFERRAL_DOCTOR_CUTS_ENABLED` off): the card row snapshots cut 0 as the wallet row does | Owner |

#### 25.16.4 API for the web (doctor app)

Specialist token, verified and active; `{ success, data }`, `Cache-Control: private, no-store`; paise unless marked ₹.

- **Book with card/UPI.** `POST /api/v1/specialists/me/assisted/lab-bookings`: the §25.15 body (one patient source:
  `{ fromBookingId, typedName }` or `{ phone, patient, holderName? }`) with `paymentMethod: 'razorpay'`. 201 (replay 200):
  ```
  { booking: <doctor booker lab view, status 'pending_payment'>,
    funding: { method: 'razorpay', amountMinor, state: 'pending', walletEntryId: null, paymentTransactionId },
    split: { listMinor, discountMinor, couponCode },
    payment: { paymentRequired: true, paymentTransactionId, razorpayOrderId, razorpayKeyId, amount (₹), amountMinor, currency, payBy } | null,
    newAccount, replayed }
  ```
  Open Razorpay Checkout with `key = razorpayKeyId`, `order_id = razorpayOrderId`, `amount = amountMinor`, `currency`.
  `payBy` (ISO, 30 minutes) is when the seat is released unless paid. The same key and body → 200 `replayed` with the SAME
  order (`payment: null` once paid, cancelled or expired); the method is not in the request hash (the same key sent with
  `wallet` answers the card booking). Errors besides §25.15: 400 `PAYMENT_METHOD_UNAVAILABLE` (card switch off),
  `NOTHING_TO_PAY` (0 to pay: book with `wallet`); 502 `RAZORPAY_ORDER_CREATION_FAILED` (the booking is held: send the
  same request again); 503 `RAZORPAY_NOT_CONFIGURED`, `INDEXES_OUTDATED`. Every refusal comes before any account, seat or
  order.
- **The booker view `payment`** (list, detail, by-key, cancel and verify answers; this doctor only):
  `{ method: 'wallet' | 'razorpay', state, payBy, paymentTransactionId?, razorpayOrderId?, razorpayKeyId?, amountMinor?, currency? }`.
  `state`: `pending`, `captured`, `refunded`, `not_paid`, `forfeited`. Card rows carry `paymentTransactionId`; while
  waiting (`status: 'pending_payment'`) also `payBy` and the open order with its amount (null when none is open yet: replay
  the create), so "Pay now" opens Checkout from the booking page. `GET …/lab-bookings?status=pending_payment` lists the
  waiting ones; `GET …/lab-bookings/by-key/:key` adds `payment` (the open order or null) for a card booking.
- **After Checkout.** `POST /api/v1/payments/verify { paymentTransactionId, razorpayOrderId, razorpayPaymentId, razorpaySignature }`
  (doctor token) → `{ context: 'assisted_lab_booking', paymentRecord, entity: <doctor booker lab view> }`.
  `paymentRecord.status: 'paid'` and `entity.status: 'confirmed'`: booked; the patient is told then.
  `paymentRecord.status: 'refunded'`: the booking could not take it (expired, cancelled, or the lab or the doctor not
  available); the money goes back to the card or UPI. Lost answer or closed Checkout:
  `POST /api/v1/payments/reconcile { paymentTransactionId }` → as verify with `state: 'paid'`, or
  `{ state: 'unpaid', gatewayStatuses }`. Errors as §23.3, plus 403 `SPECIALIST_NOT_VERIFIED` (the doctor is not verified
  and active: its capture is returned to the card by the server) and 404 `PAYMENT_RECORD_NOT_FOUND` for anyone but the
  paying doctor.
- **Cancel.** `POST /api/v1/specialists/me/assisted/lab-bookings/:id/cancel { reason?, expectedVersion?, refundTo?: 'card' | 'wallet' }`
  → `{ booking, refundedMinor, alreadyCancelled, refund }`; `refund` (card bookings only) as §24.14 (`method: 'card' |
  'wallet'`, `state: 'pending' | 'processed' | 'failed' | 'manual_review'`, …) or null when cancelled before payment.
  `refundTo` defaults to `card`; `wallet` credits the doctor wallet at once and is **not withdrawable** (show this before
  the doctor chooses); ignored for wallet-paid bookings. A waiting card booking may be cancelled at any time; a paid one up
  to 1 hour before the slot (or while a lab reschedule is unanswered). 400 `VALIDATION_ERROR` for another `refundTo`.
  Show "refund to card: in progress" while `pending`.
- **Patient app / lab workspace.** A doctor's card booking appears only once paid ("Booked and paid by Dr <name>"); a
  patient cancel or a lab reject refunds the DOCTOR's card, and the doctor is told ("being refunded to the card or UPI").
- **Admin.** Card refund rows (`GET /api/v1/admin/assisted/card-refunds`, `…/:id`) and stuck money's `cardChargebacks`
  name a doctor payer: `payerKind: 'doctor'`, `payerId`, `payerName: 'Dr <name>'`, `bookingKind: 'lab_booking'` (no
  `pharmacyId` fields). Recheck, mark-failed, to-wallet (credits the doctor wallet, with the doctor's recorded agreement)
  and `POST /api/v1/admin/assisted-payments/:paymentId/chargeback` (flag only, C4) work on doctor rows unchanged.

#### 25.16.5 Switches, indexes, deploy, rollback

- **Switches.** A doctor's card booking needs `ASSISTED_CARD_PAYMENT_ENABLED`, `ASSISTED_LAB_BOOKING_ENABLED_DOCTOR` and
  `ASSISTED_BOOKING_ENABLED_DOCTOR` (each off unless exactly `"true"`) and the Razorpay keys. Card switch off: 400
  `PAYMENT_METHOD_UNAVAILABLE`; a doctor switch off: 503. Verify, reconcile, reads, cancel, the sweeps, expiry and refunds
  always run.
- **Indexes.** None new; the card create relies on r10e's `assisted_card_refunds {captureKey}` (503 until
  `sync-indexes`). **Migration:** none (the `payerKind` enum is a schema change only).
- **Order:** 1. deploy; 2. `npm run sync-indexes` (only if 2b/3a/3b indexes are not built yet); 3. restart. Where the
  three switches are already on, doctor card bookings are live at the restart: test on stage first (book by card, pay in
  Checkout, see it confirmed; cancel it to the card and to the wallet; book and let it expire, then pay the same order from
  the Razorpay dashboard: refunded once).
- **Rollback:** the card switch. Never roll the code back below r29 while a doctor card row is `pending_payment`, any of its
  `assisted_lab_booking` records could still capture, or a card refund row with `payerKind: 'doctor'` is not settled: older
  code refuses the doctor's capture as "not found" (the money would wait unapplied and unreturned) and cannot write a doctor
  refund row. Checks: `db.partner_lab_bookings.countDocuments({ source: 'doctor_assisted', 'assisted.funding.method': 'razorpay', status: 'pending_payment' })` = 0
  and `db.assisted_card_refunds.countDocuments({ payerKind: 'doctor', state: { $ne: 'processed' } })` = 0.

#### 25.16.6 Checks

`test/assisted/r29-phase3c.integration.ts`, 21 checks: A (the heading); gates (card switch, doctor lab switch, gateway
keys, an unverified doctor); index 503; create (record owned by the doctor, 30-minute pay-by, no wallet money, nobody
told); replay, by-key and the doctor's `payment`; unpaid rows hidden from the patient and the lab; verify ×2, reconcile and
both sweeps racing (confirmed once, one notice, 2 runs); scope (another doctor, a pharmacy, the patient, an admin: 404);
late capture after expiry (refunded once); extra capture (refunded once); cancel to the card (doctor), to the doctor wallet
(not withdrawable), by the patient and the lab (the doctor's card); cancel before payment; DR9 (returned to the card, 403 on
the doctor's verify and reconcile, then expired); admin queue names the doctor and to-wallet; chargeback flag only; switches
off; pharmacy card unchanged and the payer table byte-identical for pharmacy and lab; the doctor wallet path unchanged;
reconciliation clean.

A mutation run, one break at a time: a doctor never refused at capture, or no 403 gate, fails DR9; `recordPayerOf`
without the doctor fails 13 checks; the refund-row enum without `doctor` fails 10; the doctor view without `payment` fails
5; the "MyEwaCare" heading fails A.

Each suite alone on its own database: `r29-phase3c` 21/21, `r26-phase3b` 14/14, `r14-phase2b` 24/24, `r21-phase2e` 18/18,
`r20-phase3a` 15/15, `r16-phase3d` 15/15, `r10-phase1b` 19/19, `r10b-phase1b-fixes` 23/23, `r10f-card-last` 2/2. The full
regression (`prun.sh … 4`): 80 of 81 pass, tsc 17 (unchanged); the one failure, `phase0` ("a slow converter …", a timing
check under load), passes alone (29/29).

**Seen, not changed:** the admin move of a doctor-made lab row still does not move its `assisted_links` row (3b F6). The
lab member verify route (`/partner-workspace/assisted/payments/verify`) stays lab-only; doctors use `/payments`.

### 25.17 Round 3f build record: treating window, read log, records-access approvals and grants (r30, 2026-11-25)

Branch `m0/r30-phase3f` from `6a8574e9` (the stage line `m0/r28-stage-next-3`: 3a, 3b, 3e, 2e, 4a/4b, 5a). Local commits
only. Built §25.9 with DR21–DR26 and the §25.11 decisions. Owner decision Q1: the account holder allows or denies in the
Jansetu app; the SMS code is a seam only (§27.9). Numbered §25.17 because r29 (3c) writes §25.16. No copies: the treating
booking is one loader in `assisted/treating.ts`, shared with 3b's `fromBookingId`.

**What was built**

| Area | Where | What |
|---|---|---|
| Models | `recordAccess/model/index.ts` (new) | `record_reads` `{ doctorId, holderUserId, personKey, treatingBookingId, scope: own_history \| other_history \| file, path?, sourceBookingId?, at }`, kept for good, ids only; `record_access_requests` (unique partial `{treatingBookingId, specialistId}` where `pending`; `{holderUserId, state, createdAt:-1}`; `{treatingBookingId, createdAt:-1}`); `record_access_grants` (unique `{holderUserId, personKey, specialistId}`, renewed in place; `{specialistId, holderUserId}`). `personKey` = the family member's id or `self` |
| Treating booking | `assisted/treating.ts` | `ownTreatingBookings` (the doctor's own bookings with their §25.9.1 window; an unpaid card booking or an open "not mine" report is left out) and `openOwnTreatingBooking` (404 `BOOKING_NOT_FOUND` / 409 `TREATING_WINDOW_CLOSED`). 3b's `patientOfConsultation` now calls it |
| Service | `recordAccess/index.ts` (new) | `treatingAccess`, `othersOf` (DR24 allowlist), `requestRecordsAccess`, `decideRecordsRequest`, `revokeRecordsGrant`, holder and admin lists, `logRecordRead` (DR25: 503 `READ_LOG_UNAVAILABLE`), `grantedFileRead` (DR26), `expireRecordRequests` (DR21), the `RecordsCodeSender` seam (`setRecordsCodeSender`; none in phase 3) |
| History | `specialistPortal/services/index.ts`, `specialists/routes`, `specialistPortal/validation` | `?dependentId` (one person) and `?bookingId` (the treating view). Without `bookingId` the answer is unchanged (DR23). Every read writes its `record_reads` row before the answer |
| Files | `file/access.ts`, `file/controller` | `Decision` gains 503. A specialist refused by the rules so far gets the grant rule: another booking's full prescription PDF (still held, not withdrawn by an admin clear) or a released partner-lab report (by its active `partner_lab_report` binding) of a person the doctor treats now with a grant in force; logged first. The controller answers 503 `READ_LOG_UNAVAILABLE` |
| Alert | `recordAccess/alert.ts` (new); `bookings/holds.ts` (`cancelBookingSettlement`), `doctors/services/instant.ts` (`cancelAccepted`), `bookings/services` (`markNoShow`) | `read_then_cancel` (`detail.bookingId`) in the cancelling transaction when the booking has an `other_history` or `file` read |
| Routes | `recordAccess/routes.ts` (new), `src1/routes/index.ts` | below |
| Switch, sweep, audit | `assisted/flags.ts`, `assisted/schedulers.ts`, `assisted/model/index.ts` | `RECORDS_ACCESS_ENABLED` (`assistedFlags.records`); the expiry sweep every 10 minutes; audit action `records.grant_revoked` (admin revoke) |

Checks: `test/assisted/r30-phase3f.integration.ts` (22 checks over HTTP with the real routes): DR23 unchanged answer and
its log row; no grant = own history only and other files 404; 404 for another doctor, account or person, 409 outside the
window, the identity note; request (24 h, app channel, the holder's notice, replace, a 5-way race leaves one pending,
expiry at the window's close, no app channel for a holder who never signed in); another account 404; allow (allowlist
only, the full PDF and the released report, each logged first; never a draft); a grant in force answers `approved`; deny;
approve against deny; expiry at 24 h and at the window's close (approve 409, the sweep); an unverified doctor (403, files
404, the reduced plain history still logged, re-verification restores); a grant without an open treating booking reads
nothing; the read log refusing writes gives 503 with no data; the alert after a cancel, a no-show and an instant cancel,
none after own reads only; revoke, renew in place, 12 months; an admin move; admin reads, grants and the audited revoke;
switch off; index 503.

**ASSUMED (r30, reversible)**

| # | Choice | Why |
|---|---|---|
| G1 | A history read of the whole account (no `bookingId`, no `dependentId`) is logged with `personKey: 'account'` | `self` would misname it: it covers the family members too |
| G2 | No `…/records-access/confirm` route yet. The request calls the `RecordsCodeSender` seam (none in phase 3, so `channels.sms` is `false`); the request keeps `codeHash`, `codeExpiresAt` and `wrongTries` for the follow-up after 5a (§27.9), which adds the code and the route | A route that can only answer 409 `NO_CODE_SENT` is no API |
| G3 | A request is created whether or not the holder has the app; `channels.app` = the holder has signed in (`otpVerified`). A holder who signs in within the request's life can still approve | Q1: patients without the app cannot approve, so their doctor keeps the own view |
| G4 | A new request replaces the older pending one in one transaction; racing requests leave one pending (older answers name a request that is then `replaced`) | §25.9.7 |
| G5 | Approve and deny re-check the request's booking (window open, the same holder and person, no open "not mine") and otherwise mark it `expired` (409 `RECORDS_REQUEST_EXPIRED`); a list shows a pending request past its expiry as `expired` before the sweep marks it | DR21, §17.5 item 3 |
| G6 | A file read needs ANY open treating booking of the doctor for that person (a file URL names no booking); the log row names that booking | §25.9.5 |
| G7 | `others` leaves out the treating doctor's own consultations (they are in `consultations`) and rows under an open "not mine" report; medicines keep name, dosage, frequency, instructions and duration; `prescriptionFile` is the current full PDF; `labReports[].date` is the slot date; the signer is name, kind and registration number | DR24 allowlist |
| G8 | The holder's notice (in-app, type `general`, `data: { kind: 'records_access_request', requestId }`): "A doctor asks to see past health records" / "Your doctor, <name>, asks to see <first name>'s past health records. Open Jansetu to allow or deny." | No health details; the GATE-DPDP review checks this text (§25.9.7 step 3) |
| G9 | The admin's revoke reason is kept on the grant (`revokeReason`); the audit row holds ids only. A holder's revoke is recorded on the grant (`revokedByKind: 'holder'`), not audited | The audit is ids and codes only |
| G10 | A history read that finds nothing (404 `PATIENT_HISTORY_NOT_FOUND`) writes no log row | Nothing is shown |
| G11 | The approval of a doctor who became unverified still records the grant (it cannot be used while the doctor is unverified) | The holder's answer is kept |
| G12 | 3b's 409 `TREATING_WINDOW_CLOSED` now says "This consultation is not open for treatment now" (the shared loader); the code is unchanged | One loader |

**API for the web** (`{ success, data }`; `Cache-Control: private, no-store` on the records routes)

Doctor app (specialist token):

| Route | Request | `data` |
|---|---|---|
| `GET /api/v1/specialists/me/patients/:userId/history` | `?dependentId` (optional) | unchanged `{ patient, consultations }` (the doctor's own; one person with `dependentId`). An unverified doctor gets the reduced view, as before |
| `GET …/history?bookingId=<the doctor's booking>` | verified and active (403 `SPECIALIST_NOT_VERIFIED`) | `{ patient, consultations, others?, access }`. `consultations` = the doctor's own with that booking's person. `access = { window: { opensAt, closesAt }, grant: { at, expiresAt, via } \| null, request: { state, createdAt, expiresAt } \| null, identityNote? }`. `others` (grant in force and the switch on) = `{ consultations: [{ bookingId, date, doctorName, specialization, consultationMode, diagnosis, advice, medicines, testsAdvised, recommendationCode, prescribedAt, prescriptionFile }], labReports: [{ labBookingId, labName, date, tests, releases: [{ file, releasedAt, signer: { name, kind, registrationNumber } }] }] }` |
| `POST /api/v1/specialists/me/bookings/:id/records-access/request` | verified and active; inside the window | 201 `{ requestId, state: 'pending', expiresAt, channels: { app, sms } }`; 200 `{ state: 'approved', grant: { at, expiresAt, via } }` when a grant is in force (nothing created) |
| `GET /api/static/<path>` | `prescriptionFile` and `releases[].file` from `others` | the file (the full PDF, DR26); 503 `READ_LOG_UNAVAILABLE`; 404 without a grant, outside the window or with the switch off |

Screen: show the "Other doctors' records" panel from `access` — no `request`: "Ask the patient for approval"; `pending`
until `expiresAt`; `approved` until `grant.expiresAt`; `denied` / `expired`: ask again. `identityNote`: "Identity attested
by the partner, not verified". Show no code box (`channels.sms` stays `false` in phase 3).

Customer app (user token; the account holder only, else 403 `FORBIDDEN`):

| Route | Request | `data` |
|---|---|---|
| `GET /api/v1/records-access/requests` | `?state=pending\|approved\|denied\|expired\|replaced` | `[{ _id, state, treatingBookingId, createdAt, expiresAt, decidedAt, doctor: { id, name, specialization }, patient: { personKey, name } }]` (newest 50; `pending` lists only unexpired ones; `patient.name` is null for the holder) |
| `POST /api/v1/records-access/requests/:id/approve` | — | `{ request, grant }`; grant = `{ _id, state: 'active', via: 'app', at, expiresAt, revokedAt, doctor, patient }` |
| `POST /api/v1/records-access/requests/:id/deny` | — | `{ request, grant: null }` |
| `GET /api/v1/records-access/grants` | — | `[grant]` (newest 100; `state`: `active` \| `revoked` \| `expired`) |
| `POST /api/v1/records-access/grants/:id/revoke` | — | `{ grant, alreadyRevoked }` |

Screens: "Doctors asking to see records" (Allow / Deny) from `?state=pending`; "Who can see my records" (Revoke) from
`grants`. The in-app notice carries `data.requestId`.

Admin (admin token):

| Route | Request | `data` |
|---|---|---|
| `GET /api/v1/admin/records-access/grants` | `?holderUserId&specialistId&limit≤200` | the stored rows |
| `POST /api/v1/admin/records-access/grants/:id/revoke` | `{ reason }` (3–500 characters) | `{ grant, alreadyRevoked }` (audited `records.grant_revoked`) |
| `GET /api/v1/admin/records-access/reads` | `?holderUserId&doctorId&from&to&limit≤500` | `[{ _id, doctorId, holderUserId, personKey, treatingBookingId, scope, path?, sourceBookingId?, at }]`, newest first |

`GET /api/v1/admin/assisted/alerts` lists `read_then_cancel` (`detail.bookingId`).

Errors: 503 `RECORDS_ACCESS_DISABLED`, `INDEXES_OUTDATED`, `READ_LOG_UNAVAILABLE`; 403 `SPECIALIST_NOT_VERIFIED`,
`FORBIDDEN`; 404 `BOOKING_NOT_FOUND`, `PATIENT_HISTORY_NOT_FOUND`, `RECORDS_REQUEST_NOT_FOUND`, `RECORDS_GRANT_NOT_FOUND`;
409 `TREATING_WINDOW_CLOSED`, `RECORDS_REQUEST_NOT_PENDING`, `RECORDS_REQUEST_EXPIRED`, `RECORDS_REQUEST_CHANGED`
(retry); 400 `VALIDATION_ERROR`.

**Switch, deploy, rollback**

- `RECORDS_ACCESS_ENABLED` (new; off unless exactly `"true"`) gates the request, approve and deny (503), the `others`
  part and file reads by grant. Off: the treating view shows the own consultations and `access`, still logged. Revoke,
  the lists, the sweep and the read log always work.
- Order (§25.9.7): 1. deploy (history reads are logged from now on; answers without `bookingId` are unchanged); 2.
  `npm run sync-indexes` (the three new collections); 3. the GATE-DPDP review of the notice (G8) and the app text; 4.
  `RECORDS_ACCESS_ENABLED=true`; 5. restart. No migration.
- Rollback: the switch, or the code (no money; grants simply stop being read).

**Seen, not changed**

- r29 (3c) adds `doctorBookerName` in `assisted/labViews.ts`; the holder's notice here needs no "Dr" prefix, so nothing is
  copied. Merge note: r29 also edits `assisted/labBookings.ts` (lines next to `patientOfConsultation`) and
  `assisted/model/index.ts` (other lines).
- Today's history summary (DR23) still carries `price`, `notes`, `documents` and the meeting link of the doctor's own
  consultations (for a partner-booked row `price` is the partner's money), and `patient` carries the holder's contacts in
  every view. Unchanged here.
- The doctor gets no notice when the holder answers; the treating view's `access.request` shows it.
- External diagnostics reports are not in `others` (DR24).
- The web screens of §25.9.9 are not built (backend only).

## 26. Phase 4 build specification (referral cuts, earnings, withdrawals) (r22, 2026-11-25)

Design only; nothing here is built. Three code lines are cited:
- **BASE** = `02b4a0e0` (stage `f5f171c9` + r10g + 3e). An uncited `file:line` is under `src1/modules/` at BASE.
- **2D** = `m0/r13-phase2d` `215556e2` (lab wallet, one wallet core).
- **3A** = `m0/r20-phase3a` `d3f89855` (doctor wallet on the partner store).

Phase 4 starts when 2b, 2c, 2d, 2e, 3a and 3b are merged, so every booker's create exists. Where this section and an
earlier one differ, this one wins.

### 26.1 Owner decisions this section builds (not reopened)

1. **Referral cut.**
   - It is paid **to the booking partner**.
   - It is set per partner **and** per category: consultation, lab test, package.
   - It is a % or a fixed amount **per line**, set when the partner is set up.
2. **The cut comes from the provider's earning.**
   - ₹500 consultation at 10% → doctor ₹450, partner ₹50.
   - The coupon comes first, then the cut (§2.2 item 1, §8.3).
3. **The doctor's referral cut** is built but **off (0)** until legal advice. Pharmacy and lab cuts work.
4. **O1:** partner payouts stay **off** until the CA confirms GST/TDS. Earnings keep accruing.
5. **O2:**
   - ₹50,000 maximum wallet balance;
   - one withdrawal a week;
   - card top-ups withdrawable **7 days after payment**;
   - a withdrawal to the bank goes through an admin and is paid like a payout;
   - withdrawals are built but **off**.
6. **Card chargebacks are flagged only.** The admin decides what happens next.
7. **No blocking limits** except the phone lookups. The O2 wallet rules are the owner's money rules, not abuse limits.
8. **Jansetu pays the gateway fees.**

### 26.2 What exists now

| Area | Code | Gap for phase 4 |
|---|---|---|
| Provider earning (consultations) | `doctors/services/earnings.ts:17-35`: <ul><li>with `earningRule: 'provider_coupon_v2'` it posts `amountMinor = split.providerMinor`, `grossMinor = split.baseMinor`, `commissionMinor = split.cutMinor` (`:21-25`);</li><li>otherwise it posts `price × 100` (`:23`).</li></ul> It is called once, on completion (`bookings/services/index.ts:1492`, inside the completion transaction `:1481-1497`). Instant bookings earn through the same path (`doctors/services/instant.ts:651-662`) | The booker's side of the cut is never posted. Self bookings use the old rule |
| Provider earning (lab) | `partners/services/labBookings.ts:842-852`: an assisted row with `split.rule === 'provider_coupon_v2'` posts provider / base / cut. A self row posts `subtotal − discount` (`:855-860`) | Same gaps |
| No earning | Clinic desk (`bookings/holds.ts:327`, `settlementSystem: 'clinic'`), lab desk, in-house invoices, packages, pharmacy orders | Unchanged (no cut) |
| Settlement ledger | <ul><li>`partners/model/settlement.ts`: `ownerKind: 'partner' \| 'doctor'` (`:20`); unique `{ownerKind, ownerId}` (`:69`);</li><li>entry kinds `earning \| reversal \| payout \| adjustment` (`:75`); unique `{settlementAccountId, source, sourceId, kind}` (`:114`);</li><li>`postLedgerEntry` (`partners/services/settlement.ts:71`) is exactly once by that key (`:77`), and the same key with another amount → 409 `LEDGER_SOURCE_CONFLICT` (`:102-107`);</li><li>`ensureSettlementAccount` (`:22`) creates accounts.</li></ul> | No `*_referral` owner kinds |
| Payouts | `recordPayout` (`partners/services/finance.ts:426`) checks:<ul><li>account active (`:451`);</li><li>details verified, at the version the admin saw (`:452-453`);</li><li>amount ≤ balance (`:454`).</li></ul> It posts `payout` (`:464`); there are also `voidPayout` (`:485`) and `postAdjustment` (`:509`). Admin routes are at `/api/v1/settlements` (`partners/routes/index.ts:329-354`) | No referral switch; statement rows don't show gross or commission (`:167-186`) |
| Finance reads | <ul><li>partner workspace `/finance*` (`partners/routes/index.ts:252-258`, `finance.view`);</li><li>doctor `/me/finance*` (`specialists/routes/index.ts:135-144`);</li><li>pharmacy: only `/api/v1/pharmacy-wallet` `GET /` and `/transactions` (`pharmacyWallet/routes/index.ts:13`, `:16`).</li></ul> | No pharmacy finance screen and no referral view |
| Split writers | <ul><li>`assisted/consultations.ts:262`, `:280-282` (cut 0, `referral: null`), `:298`;</li><li>`assisted/labBookings.ts:321-325` (lines, cut 0), `:339-341` (no `earningRule` on lab rows);</li><li>`assisted/instant.ts:184`;</li><li>`doctors/services/instant.ts:191-197`;</li><li>types `assisted/types.ts:81-95`, `referral: null` `:109-110`.</li></ul> Reconciliation checks provider + cut = base (`assisted/reconciliation.ts:96`, `:141-142`, `:215`) | The cut is always 0 |
| Coupons | `coupon/model/index.ts:118-119` (`fundedBy`, `partnerUsable`) | — |
| Partner setup | <ul><li>pharmacies are created by admins (`POST /api/v1/pharmacies`, `pharmacies/routes/index.ts:29-34`, service `:94`); the model has no payout fields;</li><li>labs and clinics: `createPartner` (`partners/services/index.ts:218`, `:260`) creates the settlement account (`:284`); `verifyPartner` is at `:421`;</li><li>catalogue kinds `test \| package \| consultation \| procedure \| other` (`partners/model/catalogueItem.ts:7`).</li></ul> | No home for cut rules. `modules/referral` is the customer referral-code programme, unrelated, so the new module is `referralCuts` |
| Pharmacy wallet | `pharmacyWallet/ledger.ts`:<ul><li>kinds `credit \| booking_debit \| refund_credit` (`:23`); debits refused on receivable / frozen / inactive / short (`:111-114`);</li><li>withdrawable = Σ remaining of closed:false, fee-known, undisputed lots, **with no time condition** (`:64-68`); lots consumed and restored (`:70-97`);</li><li>receivable set-off (`:142-163`); chargebacks take money and freeze (`:174-218`, `:288-339`).</li></ul> The model already reserves `withdrawal_hold \| withdrawal_release \| withdrawal_void` (`pharmacyWallet/model/index.ts:31`) | Nothing writes the withdrawal kinds; pharmacy top-ups have no cap (`pharmacyWallet/services/index.ts:69-106`, validation `:5`) |
| Wallet core (2D, 3A) | `pharmacyWallet/walletCore.ts`:<ul><li>one store interface (`:46-71`) and `postMovementIn` (`:136`, refusals `:145-148`);</li><li>top-up kinds with `chargeback: 'take' \| 'flag'` and `cardHoldDays` (`:73-87`); `creditTopupIn` stores `withdrawableAfter = paidAt + cardHoldDays` (`:417-438`);</li><li>`'flag'` chargebacks mark the lot lost with no debit and no freeze (`:290-303`).</li></ul> `walletLots.ts:17-21` ignores `withdrawableAfter`. `PARTNER_WALLET_POLICY` (3A `partnerWallets/ledger.ts:27-33`): `maxBalanceMinor 5_000_000`, `withdrawalsPerWeek 1`, `cardHoldDays 7`. The cap is enforced on lab and doctor top-ups (2D `partnerWallets/service.ts:118-125`; 3A `:126-129`). Partner entry kinds have no withdrawal kinds (2D `partnerWallets/model/index.ts:28`). Pharmacy top-ups: `chargeback: 'take'`, no `cardHoldDays` (2D `pharmacyWallet/ledger.ts:137-151`) | The 7-day hold isn't enforced; pharmacy top-ups have no cap or hold; there are no withdrawals |
| Switches | `assisted/flags.ts:42-43` `withdrawals()` (`WALLET_WITHDRAWALS_ENABLED`) is never called. No `REFERRAL_*` switch exists in code. Placeholders: `assisted/reconciliation.ts:264`, `:270`, `:322` | — |
| Gateway fees | Top-ups are made with `baseAmount = finalAmount` and credited in full (`pharmacyWallet/services/index.ts:89-90`, `payment/services/index.ts:1659-1660`). The fee is only stored (`payment/model/index.ts:89-90`, lot `gatewayFeeMinor`): **Jansetu bears it** | — |

### 26.3 The split, and why

The suggestion was one phase. The code splits it into six rounds:

| Round | Content | Depends on | Size |
|---|---|---|---|
| **4a** | Referral rules (admin), cut snapshot at create, `*_referral` accounts, switches. **No money moves**; deployed dark | 2e, 3b merged | M |
| **4b** | Posting the cut at completion: the provider earning net of the cut plus the booker's referral earning, both once; statements with list / coupon / cut / net; reconciliation | 4a | M |
| **4c** | `provider_coupon_v2` for every new ledger booking (self consultations, self instant, self lab bookings; ASSUMED D3), cut 0 | 4b | S |
| **4d** | Wallet withdrawals for pharmacy, lab and doctor; the 7-day card hold; the ₹50,000 cap on pharmacy top-ups; chargebacks flag-only with an explicit admin recovery | 2d, 3a merged; 4a (the pharmacy home account) | M–L |
| **4e** | Referral payouts behind `REFERRAL_PAYOUTS_ENABLED`; a receivable set off against the referral balance | 4b, 4d | S |
| **4f** | Finance read endpoints and web screens: pharmacy finance, referral views for labs and doctors, admin queues | 4b, 4d, 4e | M |

**Why this order:**
- **4a and 4b ship together.** Today's posting already lowers the provider by `cutMinor` (`earnings.ts:23-25`,
  `labBookings.ts:848-852`). A nonzero snapshot without 4b would make the cut vanish (Jansetu would keep it), so 4a's
  master switch stays off until 4b is deployed.
- **4d** touches only wallet code, beside 4b and 4c.
- **4e** needs both the referral balance (4b) and the withdrawal destination rules (4d).

Each round is backend, an integration suite and an independent review (Opus xhigh). Commits stay local; stage only on
the owner's word.

### 26.4 Shared rules for every round

- **Money.**
  - Integer paise.
  - Wallet movements go through the wallet core (`postMovementIn`, 2D) or `postBookerMovementIn` (`assisted/bookerWallet.ts:20-24`).
  - Ledger rows go through `postLedgerEntry` (exactly once by `{account, source, sourceId, kind}`).
  - Credits, releases and voids **always post**, even on a frozen, inactive, over-cap or ineligible wallet.
- **Keys.**
  - Every money command carries `requestKey`; the hash is from `requestHashOf`.
  - Same key and content → 200 `replayed`. Other content → 409 `IDEMPOTENCY_KEY_REUSED`. Abandoned → 409 `REQUEST_ABANDONED`.
  - Every command has a by-key / abandon pair (Q13 shape).
- **Fences.**
  - Rule edits carry `expectedVersion` (409 `RECORD_CHANGED`).
  - Withdrawal commands carry `expectedVersion` (409 `WITHDRAWAL_CHANGED`).
  - Payouts carry the destination's `detailsVersion` (`finance.ts:452-453`).
- **Indexes.** Each writer calls `assertUniqueIndex` on every unique index it relies on before it reads or holds. Until
  `npm run sync-indexes` has run, it answers 503 `INDEXES_OUTDATED`.
- **Switches** are read on every call and are off unless exactly `"true"`. Off stops only **new** cut snapshots,
  withdrawal requests and referral payouts. Reads, cancels, rejects, voids, paid records and every credit always run.
- **Audit.**
  - Booker actions go to `assisted_audit_events`.
  - Finance actions go to `SettlementEvent` (`partners/model/settlement.ts:213-238`).
  - Both are written in the same transaction.
- **Names.** Statements and referral rows show the booking's short ref, date and category. They show no patient name
  (ASSUMED M9).
- **No limits** besides the phone lookups and the owner's O2 wallet rules.

### 26.5 Round 4a: referral rules, cut snapshot, referral accounts

#### 26.5.1 Data model

- **New module `referralCuts`:**
  - `referral_rules { _id, bookerKind: 'pharmacy' | 'lab' | 'doctor', bookerId, category: 'consultation' | 'lab_test' |
    'lab_package', basis: 'percent' | 'fixed', percentBasisPoints?, fixedMinor?, capMinor?, isActive, version, updatedBy,
    updatedAt }`, unique `{bookerKind, bookerId, category}`;
  - `referral_rule_events { ruleId, version, before, after, by, reason, at }`, unique `{ruleId, version}`, append-only.
- **Categories:**
  - `consultation`: scheduled and instant consultations;
  - `lab_test`: catalogue kind `test`;
  - `lab_package`: catalogue kind `package`;
  - any other catalogue kind gets cut 0, `disabledReason: 'category_not_cut'` (ASSUMED M3).
- **Snapshot on the split** (`assisted/types.ts:81-95`):
  - a consultation gets `split.referral = { ruleId, ruleVersion, category, basis, percentBasisPoints?, fixedMinor?, capMinor?, cutMinor, disabledReason? }`;
  - each lab line gets `lines[].category` and the same object as `lines[].referral`;
  - `cutMinor` and `providerMinor` are no longer always 0 and the base;
  - `assisted.referral` (`:109-110`, now `null`) becomes `{ accountId, ownerKind, bookerKind, bookerId, cutMinor }` when the
    total cut is > 0, else stays `null`.
- **Settlement owner kinds** (`partners/model/settlement.ts:20`, `:43`; `ensureSettlementAccount`, `partners/services/settlement.ts:22`) add:
  - `pharmacy_referral` (id = pharmacyId);
  - `lab_referral` (partnerId);
  - `doctor_referral` (specialistId).

  The beneficiary name is the booker's name. The unique index `{ownerKind, ownerId}` (`:69`) is unchanged.

#### 26.5.2 The cut (§8.3 step 4), one pure function

`referralCuts/compute.ts` `cutFor(lineBaseMinor, rule, switches) → { cutMinor, disabledReason? }`:
- `percent`: `floor(base × bp / 10000)`;
- `fixed`: `min(fixedMinor, base)`;
- then `capMinor` per line;
- never above the base;
- 0 with a reason when:
  - the master switch is off (`cuts_off`);
  - the booker is a doctor and doctor cuts are off (`doctor_cuts_off`);
  - there is no active rule (`no_rule`).

`providerMinor = baseMinor − Σ cutMinor`.

#### 26.5.3 Where the snapshot is taken

| Flow | Change point | When |
|---|---|---|
| Pharmacy → consultation | `assisted/consultations.ts:280-282` | In the create transaction |
| Pharmacy → lab test, doctor → lab test (3b) | `assisted/labBookings.ts:321-325`, `:339-341` (and the 3b writer) | In the create transaction, per line (lab desk rows never cut, §5.5) |
| Lab → consultation (2e) | its create | In the create transaction |
| Partner instant (3e) | `doctors/services/instant.ts:191-197` `instantBookingAssisted` | **At accept**, on the fee base (§5.4) |

**In the same transaction:**
- read the rule;
- `ensureSettlementAccount(<booker>_referral, …, s)` when the total cut is > 0;
- write the snapshot.

A rule edited later never changes a stored snapshot.

#### 26.5.4 Routes

**Admin** (`requireAdmin`; writes need `ASSISTED_ADMIN_TOOLS_ENABLED`):

| Route | Request → answer |
|---|---|
| `GET /api/v1/admin/referral-rules?bookerKind&bookerId` | `[{ _id, category, basis, percentBasisPoints, fixedMinor, capMinor, isActive, version, updatedAt, effective }]` (`effective` = would cut now, given the switches) |
| `PUT /api/v1/admin/referral-rules/:bookerKind/:bookerId/:category` | `{ basis, percentBasisPoints? (1–5000), fixedMinor? (≥ 1), capMinor?, isActive, expectedVersion (0 = create), reason }` → the rule. 409 `RECORD_CHANGED`; 404 for an unknown booker |
| `GET …/:category/events` | `[{ version, before, after, by, reason, at }]` |

**Partners (read-only):**
- pharmacy: `GET /api/v1/pharmacy-assisted/referral-rules`;
- lab: `GET /api/v1/partner-workspace/assisted/referral-rules` (`finance.view`);
- doctor: `GET /api/v1/specialists/me/assisted/referral-rules`.

All three answer the admin list without `updatedBy`.

**Setup.** The admin pharmacy and partner setup screens call the PUT after the create. The create schemas stay
unchanged (`pharmacies/validation/index.ts:29`, `partners/services/index.ts:218`).

#### 26.5.5 Switches, indexes, deploy

- **Switches:**
  - `REFERRAL_CUTS_ENABLED` (new master, off): nothing is snapshotted (cut 0; the row is stored exactly as before phase 4, M20);
  - `REFERRAL_DOCTOR_CUTS_ENABLED` (off, owner decision 3).
- **Indexes** (`assertUniqueIndex`):
  - `referral_rules {bookerKind, bookerId, category}`;
  - `referral_rule_events {ruleId, version}`;
  - `settlement_accounts {ownerKind, ownerId}`, before a snapshot that opens an account.
- **Migration:** none.
- **Order:**
  1. deploy;
  2. `sync-indexes`;
  3. enter the rules (as many as needed);
  4. **switch on only with 4b deployed**.
- **Rollback:** the master switch. Snapshots already stored keep their cut, and 4b still posts them.

#### 26.5.6 Tests (`test/assisted/phase4a.integration.ts`)

1. `cutFor`: percent floors, fixed per line, cap per line, never above the base. Property check over 10,000 random
   bases and rules: `provider + cut = base`.
2. The §8.1 examples:
   - CBC ₹300 at 5% plus a package ₹40 fixed → lab ₹1,045, Sharma ₹55;
   - provider-funded coupon: base ₹400, cut ₹40, doctor ₹360;
   - platform-funded coupon: base ₹500, cut ₹50.
3. The master switch off → 0 `cuts_off`. A doctor booker is always 0 while doctor cuts are off.
4. Rule PUT: stale `expectedVersion` → 409; one event row per version. **Race:** two edits at once → one wins.
5. A snapshot is frozen: an edit after the booking changes nothing stored. Instant snapshots at accept, on the fee.
6. The referral account opens once under 5 parallel creates (unique index), and only when the cut is > 0.
7. The index 503.
8. Partners see rules read-only; another booker's rules → 404.

#### 26.5.7 Web screens

- **Admin → pharmacy / lab / doctor setup → "Referral cuts".**
  - Three rows (consultation, lab test, package), each with % or ₹ per line and an optional cap.
  - The switch state is shown: "Doctor cuts are off until legal advice".
  - History.
- **Partner → Finance:** a read-only "Your referral rates" card.

### 26.6 Round 4b: posting the cut, statements

#### 26.6.1 Money

On completion, in the transaction that already posts the provider earning (`earnings.ts:17-35` via
`bookings/services/index.ts:1492`; `labBookings.ts:842-852`):
1. **The provider entry is unchanged in form:** `amountMinor = providerMinor`, `grossMinor = baseMinor`,
   `commissionMinor = Σ cut`.
2. **Booker entry:** when `assisted.referral.cutMinor > 0`, one `earning` on `assisted.referral.accountId`:
   - `amountMinor = cutMinor`, `grossMinor = baseMinor`, `commissionMinor = 0`;
   - `source: 'referral_consultation' | 'referral_lab_booking'`, `sourceId` = the booking id.
   - It is exactly once by the ledger key (`settlement.ts:77`).
3. Nothing posts on a no-show, cancellation, rejection, expiry or desk row, as today.

#### 26.6.2 Reads and statements

- `finance.ts:167-186` describes the two new sources.
- Statement rows (JSON and CSV) of provider and referral accounts add `listMinor`, `discountMinor`, `couponFundedBy`,
  `cutMinor`, `netMinor` and the booking's `shortRef` and category.
- Provider statements show "Referral to <partner>" with the cut.
- Referral statements show the booking's short ref, date, category, base and cut (no patient name, M9).
- New reads, each with `?from&to&cursor` and a CSV:
  - pharmacy: `GET /api/v1/pharmacy-assisted/referral` → `{ earnedMinor, paidMinor, dueMinor, payoutsEnabled }`;
  - pharmacy: `GET /api/v1/pharmacy-assisted/referral/statement`;
  - lab: `GET /api/v1/partner-workspace/finance/referral` and `…/referral/statement` (`finance.view`);
  - doctor: `GET /api/v1/specialists/me/finance/referral` and `…/statement`.

#### 26.6.3 Reconciliation

New check `referral_posted`, for every completed row with a cut:
- exactly one referral earning equal to the cut, on the account in the snapshot;
- the provider earning equals `providerMinor`.

`split_sum` stays. The stuck list adds referral accounts with a balance > 0 and no payout in 90 days (shown only,
since payouts are off).

#### 26.6.4 Tests (`test/assisted/phase4b.integration.ts`)

1. Completion posts both entries once. **Race:** two completions at once → one of each.
2. A no-show, cancellation, rejection or desk row posts nothing.
3. A coupon then the cut, for provider- and platform-funded coupons (§8.1). A lab with mixed per-line rules.
4. An instant cut on the accepted fee (not the quote).
5. Statements and CSV show the columns and add up; no patient name.
6. Reconciliation is clean, and a tampered referral entry is flagged.
7. The old suites (consultation, lab, instant earnings) pass with a cut of 0.

#### 26.6.5 Web screens

- **Partner and doctor Finance:** a "Referral earned" row (paused-payouts badge), and the statement with the cut column.
- **Pharmacy:** see 4f.

### 26.7 Round 4c: `provider_coupon_v2` for every new ledger booking (D3)

- **Who:** new **self** ledger bookings — customer scheduled consultations, customer instant
  (`doctors/services/instant.ts:651` non-assisted) and customer lab bookings (`labBookings.ts:855-860`).
- **What they get:**
  - `earningRule: 'provider_coupon_v2'`;
  - a top-level `earningSplit` of the `AssistedSplit` shape (cut 0, no referral; lines for labs).
- **Readers:** `earnings.ts:21` and `labBookings.ts:846` read `b.assisted?.split ?? b.earningSplit`.
- **Effect:**
  - only a **platform-funded** coupon changes anything: the provider earns the list price and Jansetu bears the discount;
  - a provider-funded coupon earns list − discount, as today (Q16a).
- **Switch** `EARNING_RULE_V2_FOR_ALL` (off). Bookings made while it is on keep the rule; older ones keep theirs.
- **No migration.** Turn it on after providers are told (§14).
- **Tests:**
  - a corporate (platform) coupon earns the list price;
  - a provider coupon earns list − discount;
  - old rows are unchanged;
  - legacy and clinic rows are untouched (`payouts/services/index.ts:128`, `:332` exclusions hold).

### 26.8 Round 4d: wallet withdrawals, card hold, cap, chargebacks

#### 26.8.1 Data model

- **`wallet_withdrawals`:**
  ```
  { _id, walletRef { kind: 'pharmacy'|'lab'|'doctor', id },
    requestedBy { kind: 'pharmacy'|'member'|'doctor', id },
    grossMinor, feeMinor, transferMinor,
    lotAllocations [{ lotId, amountMinor, feeMinor }],
    state: 'requested'|'cancelled'|'rejected'|'paid'|'voided',
    destination { homeAccountId, detailsVersion, masked },
    holdEntryId, releaseEntryId?, voidEntryId?,
    paid? { method, reference, paidOn, note, by, at },
    reason?, requestKey, requestHash, version, createdAt, updatedAt }
  ```
- **Movement kinds** `withdrawal_hold` (debit), `withdrawal_release` and `withdrawal_void` (credits) are added to:
  - the wallet core (2D `walletCore.ts:89-90`);
  - partner entries (2D `partnerWallets/model/index.ts:28`);
  - pharmacy (already reserved: `pharmacyWallet/model/index.ts:31`).
- **A hold takes only lots withdrawable now:**
  - fee known, not disputed, `withdrawableAfter ≤ now`;
  - oldest first;
  - recorded on the entry's `lotAllocations`.

  Release and void restore exactly those allocations.
- **7-day card hold (O2):**
  - `withdrawableOfIn` (2D `walletLots.ts:17-21`) adds `withdrawableAfter ≤ now`;
  - pharmacy top-ups get `cardHoldDays: 7` (2D `pharmacyWallet/ledger.ts:137-151`);
  - a lot without the field is backfilled `createdAt + 7 days` by `npm run migrate:lot-withdrawable-after` (dry run,
    then `--commit`; rerunnable).
- **Stored vs now.** The stored `withdrawableMinor` stays "card money", lots on hold included, and the daily invariant
  keeps using it. Reads add `withdrawableNowMinor` and `availableLater [{ amountMinor, availableAt }]`, computed at read
  (ASSUMED M5).
- **Cap ₹50,000 (O2).**
  - Pharmacy top-up creation (`pharmacyWallet/services/index.ts:69-106`) gets the lab/doctor check (2D
    `partnerWallets/service.ts:118-125`): balance + unpaid top-ups of the last 30 min + the new amount ≤ ₹50,000, else
    409 `WALLET_LIMIT_REACHED`.
  - Credits above the cap (refunds, late-verified top-ups, releases) still post and raise the alert `wallet_over_limit`
    (alert only, M6).
- **One withdrawal a week (O2).** A request is refused when the wallet has a `requested` or `paid` withdrawal created in
  the last 7 days (rolling; cancelled, rejected and voided ones don't count; Q5): 409 `WITHDRAWAL_WEEKLY_LIMIT` with
  `details: { nextAllowedAt }`.
- **Fee (decided 25 Nov, Q2):** none. Jansetu pays every gateway fee, so `feeMinor = 0` and `transferMinor =
  grossMinor`. The fields stay on the row so that a later owner decision can change the rule without a migration.
- **Destination: the home account (§5.4):**
  - lab → its `partner` account;
  - doctor → its `doctor` account;
  - pharmacy → its `pharmacy_referral` account (4a).

  The pharmacy sets its details with `PUT /api/v1/pharmacy-assisted/finance/payout-details` (the Q5 versioned rules of
  `finance.ts`). Admins verify them with the existing `/api/v1/settlements/accounts/:id/payout-details/verify`.

#### 26.8.2 Routes

**Owner** (pharmacy `/api/v1/pharmacy-assisted/wallet/…`; lab `/api/v1/partner-workspace/assisted/wallet/…` with
`wallet.manage`; doctor `/api/v1/specialists/me/assisted/wallet/…` with `requireEligibleDoctor`):

| Route | Request → answer |
|---|---|
| `GET …/withdrawable` | `{ enabled, withdrawableNowMinor, availableLater, nextAllowedAt, destination: { state, masked, detailsVersion } }` |
| `POST …/withdrawals` | `{ amountMinor (≥ `WALLET_WITHDRAWAL_MIN_MINOR`, default 50,000 = ₹500; Q4), requestKey, detailsVersion }` → 201 (replay 200) `{ withdrawal, wallet, replayed }`; below the minimum → 400 `WITHDRAWAL_BELOW_MINIMUM` |
| `GET …/withdrawals` | `?state&cursor&limit≤50`; `GET …/withdrawals/:id`; `GET …/withdrawals/by-key/:key`; `POST …/by-key/:key/abandon` |
| `POST …/withdrawals/:id/cancel` | `{ expectedVersion }` → `{ withdrawal, wallet }` (only while `requested`) |

**Admin** (`/api/v1/admin/wallet-withdrawals`, `requireAdmin`):

| Route | Request → answer |
|---|---|
| `GET /` | `?state=requested&cursor` (oldest first) |
| `GET /:id` | With its lots, fee and the destination version |
| `POST /:id/reject` | `{ reason, expectedVersion }` |
| `POST /:id/paid` | `{ method: 'bank_transfer' \| 'upi', reference, paidOn, note?, detailsVersion, expectedVersion, requestKey }`. Checks the destination like `recordPayout` (`finance.ts:451-453`) |
| `POST /:id/void` | `{ reason, expectedVersion }`, only for `paid` (the transfer bounced) |

**Errors:**
- 503 `WITHDRAWALS_DISABLED` (new requests only), `INDEXES_OUTDATED`;
- 409:
  - destination: `PAYOUT_DESTINATION_NOT_VERIFIED`, `PAYOUT_DETAILS_CHANGED`;
  - amount and wallet: `WITHDRAWAL_ABOVE_AVAILABLE`, `WALLET_FROZEN`, `WALLET_RECEIVABLE`, `WITHDRAWAL_WEEKLY_LIMIT`;
  - state: `WITHDRAWAL_CHANGED`, `WITHDRAWAL_NOT_REQUESTED`;
  - keys: `IDEMPOTENCY_KEY_REUSED`, `REQUEST_ABANDONED`;
  - `REFERENCE_REUSED`;
- 404 for another owner's row.

#### 26.8.3 Money

| Step | One transaction |
|---|---|
| Request | Key claim; refusals checked inside on a fresh wallet read (frozen, receivable, weekly, now-withdrawable); insert `requested`; `withdrawal_hold` (`withdrawal:<id>:hold`); audit |
| Cancel / reject | CAS `requested` → `cancelled` / `rejected` on `version`; `withdrawal_release` (`:release`) restores the allocations; **always posts** |
| Paid | CAS `requested` → `paid`; `paid` recorded; the reference is unique per home account; nothing moves; a `SettlementEvent` `withdrawal_paid` on the home account (M7) |
| Void | CAS `paid` → `voided`; `withdrawal_void` (`:void`) restores `grossMinor` and the lots; **always posts** |

**Races:**
- cancel and paid at once → exactly one wins;
- two requests within the week → one wins (the weekly check and the insert run under a CAS on the wallet `version`).

#### 26.8.4 Chargebacks: flagged only, the admin decides (owner decision 6)

- **Every top-up kind uses `chargeback: 'flag'`.** Pharmacy changes from `'take'` (2D `pharmacyWallet/ledger.ts:137-151`).
  - Recording a dispute (`POST /api/v1/admin/wallet-lots/:lotId/chargeback`, `…/wallet-payments/:paymentId/chargeback`)
    marks the lot `disputeState: 'open' | 'lost'`.
  - That money stops being withdrawable, and nothing is debited (2D `walletCore.ts:290-303`).
- **The admin decides** with a new `POST /api/v1/admin/wallet-lots/:lotId/recover { reason, requestKey }`. It runs
  today's take (`chargeBackLotIn`, 2D `walletCore.ts:202`):
  - debit up to the balance;
  - the shortfall becomes a receivable;
  - the wallet is frozen.
- **A lot already withdrawn and paid** becomes an admin case: recover is allowed, and the shortfall becomes a receivable.
- **Freeze** exists (`assisted/controller/phase1a.ts:81-101`; 2D `walletCore.ts:484`). Frozen or owing wallets refuse
  withdrawals.

#### 26.8.5 Indexes, switch, deploy

- **Indexes** (`assertUniqueIndex`):
  - `wallet_withdrawals {walletRef.kind, walletRef.id, requestKey}` unique;
  - `{destination.homeAccountId, paid.reference}` unique, partial on the reference;
  - `{state, createdAt}`;
  - `{walletRef.kind, walletRef.id, createdAt: -1}`;
  - lots `{walletRef.kind, walletRef.id, withdrawableAfter}`.
- **Switch:** `WALLET_WITHDRAWALS_ENABLED` (exists, `assisted/flags.ts:42-43`). It stays **off** (GATE-RBI). Off → new
  requests answer 503; everything else runs.
- **Order:**
  1. deploy;
  2. `sync-indexes`;
  3. `migrate:lot-withdrawable-after` (dry run, then `--commit`);
  4. restart.

  The switch waits for GATE-RBI.
- **Rollback:** never roll back while a withdrawal is `requested` or a hold is unreleased:
  `db.wallet_withdrawals.countDocuments({ state: 'requested' })` must be 0.

#### 26.8.6 Tests (`test/assisted/phase4d.integration.ts`)

1. **Hold:** a request holds once.
   - **Race:** 5 identical requests → one row and one hold.
   - Above `withdrawableNowMinor` → 409. Non-withdrawable money (admin credits) is never taken.
2. **Card hold:**
   - a lot younger than 7 days is not withdrawable;
   - at day 7 it is;
   - a backfilled old lot is.
3. **Weekly:** a second request within 7 days → 409 with `nextAllowedAt`. After a cancel, a new request is allowed.
4. **Fee:** none: `feeMinor = 0`, `transfer = gross` (decided 25 Nov).
5. **Cancel, reject, paid and void:**
   - **race:** cancel vs paid → one outcome, the money moves once;
   - reject releases once; void restores once;
   - the reference is unique per account.
6. **Refusals:** frozen, receivable, an unverified destination, a changed `detailsVersion` → 409.
7. **Spending after a withdrawal:** a booking refund restores its own lots correctly after a withdrawal took others.
8. **Cap:**
   - pharmacy top-up above ₹50,000 → 409;
   - a refund above the cap posts and raises the alert.
9. **Chargebacks:** a flag never debits. Recover debits, sets the receivable and freezes. A credit sets the receivable
   off first.
10. **Switch:** off → 503 for requests; cancel, reject and paid still work. The index 503.
11. **Reconciliation:**
    - Σ holds of `requested` = Σ their gross;
    - every `paid` has no release;
    - the wallet invariants hold.

#### 26.8.7 Web screens

- **Wallet (pharmacy, lab, doctor):**
  - "Card money you can withdraw now ₹x" and "₹y more on <date>";
  - **Withdraw**: amount, the bank or UPI (masked), "you get ₹t";
  - a list with states;
  - "Withdrawals are coming soon" while off.
- **Admin → Withdrawals:**
  - a queue, oldest first;
  - a detail with lots, fee and destination;
  - Mark paid (UTR, method, date), Reject, Void.
- **Admin → Lots:** Flag dispute, Recover.

### 26.9 Round 4e: referral payouts

- **`recordPayout`** (`finance.ts:426`) on a `*_referral` account:
  - refused with 409 `REFERRAL_PAYOUTS_DISABLED` unless `REFERRAL_PAYOUTS_ENABLED` (new, off, O1);
  - the destination check (`:452-453`) reads the **home account's** verified details and version (§5.4); for a pharmacy
    the referral account is itself the home account.
- **Receivable set-off from the referral balance:**
  - `POST /api/v1/admin/wallets/:kind/:id/receivable/setoff-from-referral { amountMinor, requestKey }`, ≤ min(receivable,
    referral balance);
  - one transaction: a ledger `adjustment` −amount on the referral account (`source: 'receivable_setoff'`,
    `sourceId: <key>`), and a wallet `receivable_setoff` posting the same amount;
  - exactly once;
  - the same switch as payouts (M8).
- **Admin:**
  - the settlement accounts list (`finance.ts:594`) filters by the new owner kinds;
  - the payout form shows "Paused until tax advice" while off.
- **Tests:**
  - payout refused while off;
  - allowed when on, to the home destination, version-fenced;
  - set-off paired once (race), never below 0;
  - statements show payouts.

### 26.10 Round 4f: finance reads and screens

- **Pharmacy** `GET /api/v1/pharmacy-assisted/finance` →
  ```
  { wallet: { balanceMinor, withdrawableNowMinor, availableLater, receivableMinor, frozen },
    referral: { earnedMinor, paidMinor, dueMinor, payoutsEnabled },
    withdrawals: { openCount, lastPaidAt, enabled },
    payoutDetails: { state, masked, detailsVersion } }
  ```
- **Pharmacy** `GET …/finance/statement?kind=wallet|referral&from&to&cursor` (+ `.csv`). The wallet kind maps entries
  as `transactionView` does (`pharmacyWallet/services/index.ts:30-40`).
- **Lab workspace** `/finance` (`partners/routes/index.ts:252-258`) and **doctor** `/me/finance`
  (`specialists/routes/index.ts:135-144`) add the `referral` and `withdrawals` blocks.
- **Admin Finance:**
  - referral accounts (due, payouts paused);
  - withdrawals queue;
  - disputes;
  - rules per partner.
- **Web screens:**
  - **Pharmacy → Finance:** three tiles (wallet, card money, referral earned), a statement with a filter, payout
    details, Withdraw;
  - lab and doctor Finance gain the same tiles;
  - plain words, one primary action per screen.

### 26.11 Deploy order for the phase

1. **4a** dark: deploy, `sync-indexes`, enter the rules. `REFERRAL_CUTS_ENABLED` stays off.
2. **4b**: deploy, `sync-indexes`, then `REFERRAL_CUTS_ENABLED=true`. The pharmacy and lab cuts the admin has set
   start, consultations included; doctor cuts stay off.
3. **4c**: `EARNING_RULE_V2_FOR_ALL=true` after providers are told.
4. **4d**: deploy, `sync-indexes`, the lot migration. Withdrawals stay off until GATE-RBI.
5. **4e**: deploy. Payouts stay off until O1.
6. **4f**: deploy; the web apps follow each round.

### 26.12 ASSUMED (reversible)

| # | Assumption (the safer default) | Where |
|---|---|---|
| M1 | Six rounds; 4a deploys dark behind a new master switch `REFERRAL_CUTS_ENABLED` and is switched on only with 4b, because a snapshot without 4b's posting would lose the cut | §26.3 |
| M2 | **Decided 25 Nov (Q1):** pharmacy and lab cuts work for every category, consultations included, once `REFERRAL_CUTS_ENABLED` is on and an admin has set the rules. `REFERRAL_CONSULTATION_CUTS_ENABLED` is not built. Doctor cuts stay off (`REFERRAL_DOCTOR_CUTS_ENABLED=false`) | §26.5.5 |
| M3 | Only `consultation`, `lab_test` (catalogue `test`) and `lab_package` (catalogue `package`) are cut; other catalogue kinds snapshot 0 | §26.5.1 |
| M4 | A percent rule is 0.01%–50% (1–5,000 bp); a fixed rule ≥ ₹0.01; the cap is per line | §26.5.4 |
| M5 | The stored `withdrawableMinor` stays "card money"; what is withdrawable now (after the 7-day hold) is computed at read and at request | §26.8.1 |
| M6 | The ₹50,000 cap refuses new top-up orders only; refunds, releases and late-verified top-ups always post (money is never stranded) and raise an alert | §26.8.1 |
| M7 | A withdrawal marked paid moves no ledger money (wallet money is not an earning); it is audited on the home account | §26.8.3 |
| M8 | Setting a receivable off against the referral balance uses the payout switch (it is a payment of the referral) | §26.9 |
| M9 | Statements and referral rows show the short ref, date and category, never the patient's name | §26.4 |
| M10 | **Decided 25 Nov (Q2):** Jansetu pays every gateway fee. A withdrawal has no fee deduction: `feeMinor = 0`, `transferMinor = grossMinor` (this replaces §2.3 C). *Superseded by the owner, 25 Nov: the card fee is deducted only when UNSPENT card money is withdrawn (§26.17)* | §26.8.1 |
| M11 | Every top-up kind flags a chargeback; debiting the wallet is the admin's explicit "Recover" | §26.8.4 |
| M12 | Lots without `withdrawableAfter` are backfilled `createdAt + 7 days` (older card money is already past the hold) | §26.8.1 |
| M13 | `provider_coupon_v2` for self bookings uses a top-level `earningSplit` (no `assisted` block), behind `EARNING_RULE_V2_FOR_ALL` | §26.7 |
| M14 | Rules are snapshotted at create (instant: at accept); a rule edit never changes a stored booking | §26.5.3 |
| M15 | **Decided 25 Nov (Q4):** a minimum withdrawal of ₹500 (`WALLET_WITHDRAWAL_MIN_MINOR`, configurable) | §26.8.2 |

### 26.13 Questions for the owner (only the ones that change what is built)

1. **Consultation cuts for pharmacies and labs. Switch them on now, or after legal advice?**
   Recommended: **after written legal advice.** A cut out of a doctor's fee for a referral may breach medical ethics
   rules on fee-splitting (GATE-NMC). Lab-test and package cuts work now. The consultation switch is built and can be
   turned on the day advice arrives.
2. **Withdrawals of unspent card top-ups: deduct that top-up's card fee, or does Jansetu pay it too?**
   Recommended: **deduct it, only on withdrawal of unspent card money.** Spent money never pays a fee, so Jansetu still
   pays the gateway on everything that becomes a booking. Without the deduction, a top-up followed by a withdrawal costs
   Jansetu about 2% for nothing (§2.3 C).
3. **While payouts are paused (O1), may a partner move referral earnings into its wallet to pay for bookings?**
   Recommended: **no.** Moving them is a payment of the referral, which is the same tax question. Earnings accrue and
   are paid once the CA answers.
4. **A minimum withdrawal amount?**
   Recommended: **₹500** (bank transfers of a few rupees cost more than they move). No other limits beyond O2.
5. **"One withdrawal a week": a rolling 7 days, or Monday–Sunday?**
   Recommended: **rolling 7 days** from the last withdrawal that was not cancelled or rejected (simplest to explain:
   "next withdrawal from <date>").

### 26.14 Decided 25 Nov (coordinator, owner asleep; reversible)

The owner asked for decisions in line with their earlier answers. These replace the recommendations in §26.13:

| # | Decision | Built as |
|---|---|---|
| Q1 | **Pharmacy and lab consultation cuts work.** Owner, 22 Nov: "Doctor's referral cut OFF until legal advice; pharmacy/lab cuts work". Legal work is not chased now | Behind `REFERRAL_CUTS_ENABLED` (default off); the admin sets rules per partner and category. No separate consultation switch. Doctor cuts stay off. **Open owner item:** the NMC fee-splitting risk of consultation cuts (GATE-NMC) |
| Q2 | **Jansetu pays gateway fees** (owner decision): no fee deduction on withdrawal | `feeMinor = 0`. **Open owner question:** the cost of a card top-up followed by a withdrawal (about 2% of the amount, paid by Jansetu). **Owner, 25 Nov: deduct the card fee only when unspent card money is withdrawn** (built in r32, §26.17) |
| Q3 | Referral earnings cannot fund the wallet while payouts are paused | No route |
| Q4 | Minimum withdrawal ₹500, configurable | `WALLET_WITHDRAWAL_MIN_MINOR` (default 50,000) |
| Q5 | Rolling 7 days | §26.8.1 |

### 26.15 Rounds 4a + 4b build record (r24, 2026-11-25)

Branch `m0/r24-phase4ab`. It is built from `m0/r19-stage-next` `2273b88a`, with two merges:
- `m0/r17-phase3e` → `f7f57ad2`, conflicts resolved, tsc 17;
- `m0/r22-phase4-spec` → `f605c0a6`.

Local commits only. Built: §26.5 (4a) and §26.6 (4b), with the 25 Nov decisions (§26.14): pharmacy and lab cuts
work in every category, consultations included, behind `REFERRAL_CUTS_ENABLED`; doctor cuts stay off.

**What was built**

| Area | Where | What |
|---|---|---|
| Rules | `referralCuts/model.ts` (new) | `referral_rules` unique `{bookerKind, bookerId, category}`, `version`; `referral_rule_events` unique `{ruleId, version}`, append-only |
| Cut and snapshot | `referralCuts/service.ts` (new) | <ul><li>`cutFor`: pure; % floor, fixed per line, cap per line, ≤ base, 0 with a reason (`cuts_off`, `doctor_cuts_off`, `no_rule`, `category_not_cut`);</li><li>`snapshotCuts(booker, lines, s?)`: reads the booker's active rules; when the total is > 0 it opens the `*_referral` account idempotently (`assertUniqueIndex` on `settlement_accounts {ownerKind, ownerId}`);</li><li>`labCategoryOf`: catalogue `test` → `lab_test`, `package` → `lab_package`, otherwise none;</li><li>`postReferralEarningIn`: the booker's `earning` on its referral account, once by the ledger key;</li><li>`putRule` / `listRules` / `ruleEvents`.</li></ul> |
| Snapshots | `assisted/consultations.ts`, `assisted/labBookings.ts`, `doctors/services/instant.ts` | <ul><li>pharmacy consultation: `split.referral`, `cutMinor`, `providerMinor = base − cut`, `assisted.referral`;</li><li>pharmacy lab booking: per line, `lines[].category`, `cutMinor`, `referral`;</li><li>partner instant: at accept, inside the accept transaction, on the fee (base after a provider-funded coupon).</li></ul> 2e (lab → consultation) and 3b (doctor → lab) are not on this line; they call `snapshotCuts` the same way when merged |
| Types | `assisted/types.ts` | `ReferralCategory`, `ReferralSnapshot`, `AssistedReferral`; `AssistedSplit.referral`, `lines[].category` / `referral`; `AssistedBlock.referral: AssistedReferral \| null` |
| Accounts | `partners/model/settlement.ts`, `partners/services/settlement.ts`, `finance.ts` | Owner kinds `pharmacy_referral`, `lab_referral`, `doctor_referral` (`isReferralOwnerKind`) |
| Posting | `doctors/services/earnings.ts`, `partners/services/labBookings.ts` `postEarning` | Completion posts the provider entry (base − cut, commission = cut) **and** the booker entry (`referral_consultation` / `referral_lab_booking`) in the same transaction. A provider amount of 0 no longer skips the cut. Nothing posts on a no-show, cancel or desk row |
| Payout guard | `finance.ts` `recordPayout` | A `*_referral` account → 409 `REFERRAL_PAYOUTS_DISABLED` while `REFERRAL_PAYOUTS_ENABLED` is off (pulled forward from 4e, because referral accounts now have balances in the admin list) |
| Statements | `finance.ts` | Referral rows say "Referral · consultation · <date> · Ref <shortRef>" (no patient name); earning lines add `grossMinor` and `commissionMinor`. The CSV columns are unchanged (M16) |
| Reconciliation | `assisted/reconciliation.ts` | `referral_posted`, on scheduled consultations, lab bookings and instant bookings: completed → exactly one referral earning of the cut on the snapshot's account; otherwise none |
| Switches | `assisted/flags.ts` | `REFERRAL_CUTS_ENABLED`, `REFERRAL_DOCTOR_CUTS_ENABLED`, `REFERRAL_PAYOUTS_ENABLED` (all off) |

**API**

- **Admin**, on `adminAssistedRouter`; PUT needs `ASSISTED_ADMIN_TOOLS_ENABLED`:
  - `GET /api/v1/admin/referral-rules?bookerKind&bookerId` → `[{ _id, category, basis, percentBasisPoints, fixedMinor,
    capMinor, isActive, version, updatedAt, effective, updatedBy }]`;
  - `PUT /api/v1/admin/referral-rules/:bookerKind/:bookerId/:category` with `{ basis, percentBasisPoints? (1–5000),
    fixedMinor? (≥ 1), capMinor?, isActive, expectedVersion (0 = create), reason }` → the rule. Errors: 400
    `VALIDATION_ERROR`, 404 `BOOKER_NOT_FOUND`, 409 `RECORD_CHANGED`, 503 `ASSISTED_BOOKING_DISABLED`,
    `INDEXES_OUTDATED`;
  - `GET …/:category/events` → `[{ ruleId, version, before, after, by, reason, at }]`.
- **Pharmacy**, on `pharmacyAssistedRouter`:
  - `GET /api/v1/pharmacy-assisted/referral-rules` → the list above, without `updatedBy`;
  - `GET /api/v1/pharmacy-assisted/referral` → `{ earnedMinor, paidMinor, dueMinor, payoutsEnabled }`;
  - `GET /api/v1/pharmacy-assisted/referral/statement?before&limit&from&to` → `[{ _id, at, kind, source, sourceId,
    description, amountMinor, balanceAfterMinor, grossMinor?, commissionMinor? }]`, plus `pagination.nextCursor`.

Lab and doctor reads of their rules and referral accounts arrive with 2e and 3b, the rounds where they become
bookers (M17).

**ASSUMED while building**

| # | Choice | Why |
|---|---|---|
| M16 | The statement CSV keeps its columns; base and cut are in the JSON lines only | The CSV header is a released contract |
| M17 | Lab and doctor read routes for rules and referral accounts are not built until 2e / 3b put them on this line | Minimal API; no booker of those kinds exists here yet |
| M18 | Rules are read and the referral account is opened before the create transaction (as the lab create does for its settlement account). The instant snapshot runs inside the accept transaction | A rule edit racing a create gives one consistent version, which the snapshot records (`ruleVersion`). An unused empty referral account is harmless |
| M19 | The referral payout refusal (§26.9) ships now | Referral accounts with balances appear in the admin payout list from 4b |
| M20 | While `REFERRAL_CUTS_ENABLED` is off nothing is snapshotted (no `split.referral`, no line category): a booking is stored exactly as before phase 4. With the switch on, a zero cut still records its reason (`no_rule`, `doctor_cuts_off`, `category_not_cut`) | The dark deploy changes no row, and the 1a, 2a and 3e suites stay byte-for-byte |

**Tests:** `test/assisted/r24-phase4ab.integration.ts`, 15 checks:
- rules: create, change, stale 409, bad terms 400, unknown booker 404, tools switch 503, history;
- rule-edit race: one wins;
- partner read and `effective`; partners can't write;
- `cutFor` over 10,000 random lines;
- snapshot with the switch off and on; the account opened once under 3 parallel creates; no-rule pharmacy;
- coupon first, then the cut (provider- and platform-funded);
- a rule edit racing a create;
- completion posts provider and referral once under racing completions;
- completion racing the pharmacy cancel: one outcome;
- a no-show posts nothing;
- instant: snapshot at accept on the fee, posted at completion;
- lab lines (5%, ₹40 fixed, other kinds 0), doctor cuts off, posting once;
- pharmacy reads and statements (short ref, no name) and the doctor statement's base and cut;
- payout refused while off;
- reconciliation: clean, then a missing referral earning is flagged.

**Seen, not changed**
- `assisted/labBookings.ts` keeps its own `newShortRef`.
- Lab desk rows never snapshot (§5.5).
- 4c to 4f are not built.

### 26.16 r33: referral API gaps closed (2026-11-25)

Branch `m0/r33-referral-gaps` from stage `6a8574e9`. Local commits only. The gaps the WQ26 web screens found:

| Gap | Built |
|---|---|
| No answer said whether cuts or payouts are on | The rule lists (admin `GET /admin/referral-rules`, booker `…/referral-rules`) add a top-level `switches: { cutsEnabled, payoutsEnabled }` next to `data` (the list stays an array); the totals (`…/referral`) add `cutsEnabled` beside `payoutsEnabled` in `data`. `cutsEnabled` = `REFERRAL_CUTS_ENABLED`, `payoutsEnabled` = `REFERRAL_PAYOUTS_ENABLED` |
| Statement rows had the short ref and category only inside `description` (§26.6.2) | Referral rows (`referral_consultation`, `referral_lab_booking`) add `shortRef` and `category`. A lab booking stays **one row** (one ledger entry, so balances and cursors are unchanged) with `lines: [{ category, baseMinor, cutMinor }]` (its cut lines) and `category` = their one category, or `mixed` when they differ (M21). Provider rows are unchanged. No patient name |
| No referral statement CSV | `GET …/referral/statement.csv?from&to`: the finance CSV (`statementCsv`, same columns as M16, opening and closing balance), file `pharmacy-referral-statement….csv` / `lab-referral-statement….csv`; the CSV answer helpers (`sendCsv`, `csvName`, `period`) are exported from `partners/controller/finance.ts` and shared |
| M17: labs had no referral reads | `GET /api/v1/partner-workspace/assisted/referral-rules`, `…/referral`, `…/referral/statement`, `…/referral/statement.csv` (and the admin-as-owner twins under `/partner-workspace/admin/:partnerId/workspace/assisted/…`): `finance.view` with partner-wide scope (`assertPartnerFinanceReader`, 403 FINANCE_SCOPE_REQUIRED), labs only (403 LAB_PARTNER_REQUIRED). The same handlers serve the pharmacy and the lab (`referralReads` in `referralCuts/controller.ts`). No doctor routes (doctor cuts stay off) |

**ASSUMED:** M21 — one statement row per lab booking with its cut lines listed, rather than one row per line (simpler: no
change to the ledger, the running balance or the cursor). M22 — the lab reads sit under `/partner-workspace/assisted/`,
mirroring the pharmacy's `/pharmacy-assisted/` paths, rather than §26.6.2's `/partner-workspace/finance/referral`; the
permission is the finance one, as §26.6.2 says.

**Tests:** `test/assisted/r33-referral-gaps.integration.ts` (5 checks: the switches on every answer, the row fields with
mixed and single-category lab bookings and unchanged provider rows, the pharmacy CSV, the lab reads incl. admin as owner,
the refusals); `r24-phase4ab` updated for `cutsEnabled` in the totals.

### 26.17 Rounds 4c + 4d build record (r32, 2026-11-25)

Branch `m0/r32-phase4cd` from `6a8574e9` (the stage line `m0/r28-stage-next-3`: 3a, 3b, 2e, 4a/4b, 5a). Local commits
only. Built §26.7 (4c) and §26.8 (4d) with the decisions of §26.12–§26.14, and one new owner decision (25 Nov) that
replaces M10 / Q2: **the card fee is deducted ONLY when UNSPENT card money is withdrawn; money spent on bookings never
pays a fee.** Both rounds ship dark: `EARNING_RULE_V2_FOR_ALL` and `WALLET_WITHDRAWALS_ENABLED` stay off. Check:
`test/assisted/r32-phase4cd.integration.ts` (15 checks).

#### 26.17.1 Round 4c: `provider_coupon_v2` for SELF bookings

| Area | Where | What |
|---|---|---|
| The split | `referralCuts/selfEarning.ts` (new) | `selfEarningOf(terms)`: while the switch is on, `{ earningRule: 'provider_coupon_v2', earningSplit }` of the assisted split's shape — `listMinor`, `couponCode`, `couponFundedBy`, `discountMinor`, `baseMinor` (the list price for a platform-funded coupon, list − discount otherwise), `cutMinor: 0`, `providerMinor = baseMinor`, `lines` per test for labs; nothing at all while it is off. `selfSplitPatchFor`: at payment (Q16a) the winning record's terms remake the split of a booking frozen with the rule (a coupon taken at pay-again included) |
| Coupon funding | `coupon/funding.ts` (new) | `couponFundedBy`: the one rule (`fundedBy`, else corporate = platform); the assisted consultation and lab creates use it instead of their private copies |
| Writers | `bookings/services` (customer consultation create; pay-again's direct settle), `payment/services` (`processBookingPayment`), `doctors/services/instant.ts` (customer instant, ledger only), `partners/services/labBookings.ts` (customer lab create) | The rule and split at create; the split follows the paying terms |
| Ledger only | `bookings/holds.ts` | A booking the ledger does not pay (legacy cutover, clinic) drops the rule at the insert: legacy and clinic rows are untouched (`payouts` exclusions hold) |
| Readers | `doctors/services/earnings.ts`, `partners/services/labBookings.ts` `postEarning` | `assisted.split ?? earningSplit` for a row with the rule |
| Models | `bookings/model`, `bookings/types`, `partners/model/labBooking.ts` | `earningSplit` (Mixed); lab rows gain `earningRule` |
| Switch | `assisted/flags.ts` | `EARNING_RULE_V2_FOR_ALL` (off). Bookings made while it is on keep the rule; older ones keep theirs |

**Effect:** only a platform-funded coupon changes anything — the provider earns the list price and Jansetu bears the
discount. A provider-funded coupon earns list − discount, as today. No migration. Turn it on after providers are told.

#### 26.17.2 Round 4d: withdrawals, card hold, cap, chargebacks

| Area | Where | What |
|---|---|---|
| Movements | `pharmacyWallet/walletCore.ts` | Kinds `withdrawal_hold` (a debit), `withdrawal_release`, `withdrawal_void` (credits). A hold carries `lotsWithdrawableAt`: it takes only card money withdrawable then (fee known, no dispute, past its card hold), oldest first, and is refused (409 `WITHDRAWAL_ABOVE_AVAILABLE`) when those lots do not cover it. Release and void restore exactly the held allocations; credits always post |
| Lots | `pharmacyWallet/walletLots.ts`, `model/lots.ts` | `withdrawableNowOf(ref, now)` (`nowMinor`, `later[{ amountMinor, availableAt }]`) and `withdrawableNowFilter(now)`: past `withdrawableAfter`, or — for a lot written before the field — `createdAt + 7 days`. `consumeLots` takes an optional filter; `planLots` is its read-only twin (the withdrawal's fee is computed on the same lots). The stored `withdrawableOfIn` is unchanged (M5). Lot `chargedBackAt`; index `{walletRef.kind, walletRef.id, withdrawableAfter}` |
| Card hold | `pharmacyWallet/ledger.ts`, `scripts/lotWithdrawableAfter.ts` | Pharmacy top-ups get `cardHoldDays: 7` (new lots carry `withdrawableAfter`). `npm run migrate:lot-withdrawable-after` (dry run, then `--commit`; rerunnable) writes `createdAt + 7 days` where missing |
| Cap ₹50,000 | `walletCore.ts` `WALLET_POLICY`, `assertTopupWithinCap`; `pharmacyWallet/services` | *r32b: the pharmacy's only while `WALLET_BALANCE_CAP_ENABLED` is on.* One cap check for every top-up kind (balance + unpaid top-ups of the last 30 minutes + the new amount ≤ ₹50,000, else 409 `WALLET_LIMIT_REACHED` with the room left); the pharmacy's own card top-up now uses it (the lab/doctor check moved here). A credit that leaves any wallet above the cap still posts and raises the alert `wallet_over_limit` (once a day per wallet; M6) |
| Withdrawals | `walletWithdrawals/` (new: model, service, routes, validation) | `wallet_withdrawals` as §26.8.1. Request, cancel, reject, paid and void as §26.8.3, each in one transaction with its audit (`withdrawal.*` in `assisted_audit_events`); paid writes a `withdrawal_paid` SettlementEvent on the home account (M7). Home account: lab `partner`, doctor `doctor`, pharmacy `pharmacy_referral` (opened on first use) |
| The fee (owner, 25 Nov) | `walletWithdrawals/service.ts` | Each lot's gateway fee in proportion to what is withdrawn from it (`floor(fee × withdrawn / lot amount)`); the money a booking already spent from that lot never pays its share. `feeMinor = Σ`, `transferMinor = grossMinor − feeMinor`. The answer's `feeLine` and the hold entry's description say it ("card fee ₹x on unspent card money; you receive ₹y") |
| Chargebacks | `walletCore.ts` `recordTopupChargebackIn`, `recoverTopupIn`; `assisted/controller/phase1a.ts` | **Every top-up kind is flagged only** — the pharmacy's too (it was `take`): the top-up gets `chargebackAt`, its lot `disputeState: 'lost'`; nothing is debited or frozen. The new **Recover** runs the take explicitly (debit up to the balance, the shortfall owed as a receivable, the wallet frozen), once per top-up, also for a top-up credited without a lot or closed as compensated. *r32b (§26.17.7): for the pharmacy only while `WALLET_CHARGEBACK_FLAG_ONLY` is on; off, the production take stays* |
| Pharmacy destination | `walletWithdrawals/service.ts`, `partners/services/finance.ts`, `partners/model/settlement.ts` | `PUT /api/v1/pharmacy-assisted/finance/payout-details` sets the `pharmacy_referral` account's details with the Q5 versioned rules; `FinanceActor` and SettlementEvent `byKind` gain `pharmacy` |
| Errors | `middleware/errorHandler.ts` | Safe details for `WITHDRAWAL_BELOW_MINIMUM` (`minimumMinor`), `WITHDRAWAL_ABOVE_AVAILABLE` (`withdrawableNowMinor`), `WITHDRAWAL_WEEKLY_LIMIT` (`nextAllowedAt`, ISO) |
| Switches | `assisted/flags.ts` | `WALLET_WITHDRAWALS_ENABLED` (off: new requests 503 `WITHDRAWALS_DISABLED`; everything else runs), `WALLET_WITHDRAWAL_MIN_MINOR` (default 50,000 = ₹500) |

#### 26.17.3 ASSUMED (r32, reversible)

| # | Choice | Why |
|---|---|---|
| N1 | The fee is each lot's share, rounded down (the remaining paise stay Jansetu's); a lot partly spent on bookings pays only on what is withdrawn | Owner, 25 Nov: spent money never pays a fee; never more than the lot's fee in total |
| N2 | `amountMinor` of a request is the gross (what leaves the wallet); the minimum applies to it | One number for the wallet and the limit |
| N3 | The request hash is the amount only; `detailsVersion` is a fence (409 `PAYOUT_DETAILS_CHANGED`), not part of the request's identity | As `expectedVersion` fences |
| N4 | Recover needs a recorded dispute first (409 `DISPUTE_NOT_RECORDED`); a blocked (never credited) top-up has nothing to recover (409 `NOTHING_TO_RECOVER`). Recover also takes a payment id (`/wallet-payments/:paymentId/recover`), for top-ups credited without a lot | §26.8.4 names only the lot route; older top-ups have no lot |
| N5 | Recover is exactly once per top-up by its own key (`chargeback:<lot>`); the `requestKey` is recorded in the audit | The take already had a key |
| N6 | A lab's new request needs an operational lab and `wallet.manage`; reads need `wallet.view`, cancel and abandon `wallet.manage`. A doctor needs to be eligible for every route (as the doctor wallet) | The top-up guards |
| N7 | A UTR is unique per home account across states (a voided withdrawal keeps its UTR) | A new transfer has a new UTR |
| N8 | `GET …/withdrawable?amountMinor=` adds a `quote` (gross, fee, transfer) so the screen can show "you get ₹t" before the request | Minimal API: no separate quote route |
| N9 | 4c: the split at payment follows the winning record's terms; a customer instant booking counts its coupon only when it was used on the fee | Q16a: the earning follows what the customer was charged |
| N10 | The withdrawal reconciliation checks of §26.8.6 item 11 (Σ holds of requested = Σ gross; no release of a paid one) are not built; the wallet invariants (balance = Σ entries) cover the new kinds | Time; the daily invariants already hold |

#### 26.17.4 API for the web

Owner routes (`{ success, data }`, `Cache-Control: private, no-store`, paise): the pharmacy at
`/api/v1/pharmacy-assisted/wallet/…` (operational pharmacy), the lab at `/api/v1/partner-workspace/assisted/wallet/…`
(`wallet.view` reads; `wallet.manage` acts, a new request also needs a verified lab), the doctor at
`/api/v1/specialists/me/assisted/wallet/…` (eligible doctor).

| Route | Request | `data` |
|---|---|---|
| `GET …/wallet/withdrawable` | `?amountMinor` (optional quote) | `{ enabled, minimumMinor, withdrawableNowMinor, availableLater: [{ amountMinor, availableAt }], nextAllowedAt, destination: { state: 'none'\|'unverified'\|'verified', masked, detailsVersion }, quote?: { grossMinor, feeMinor, transferMinor, available } }` |
| `POST …/wallet/withdrawals` | `{ amountMinor (≥ minimumMinor), requestKey, detailsVersion }` | 201 (replay 200) `{ withdrawal, wallet: { balanceMinor, withdrawableMinor, receivableMinor, frozen }, replayed }` |
| `GET …/wallet/withdrawals` | `?state&cursor&limit≤50` | `[withdrawal]`, newest first; `pagination: { nextCursor }` |
| `GET …/wallet/withdrawals/:id`, `GET …/by-key/:key`, `POST …/by-key/:key/abandon` | — | the withdrawal; `{ state: 'used', withdrawal } \| { state: 'abandoned' } \| { state: 'unknown' }` |
| `POST …/wallet/withdrawals/:id/cancel` | `{ expectedVersion }` | `{ withdrawal, wallet, replayed }` (only while `requested`) |
| `PUT /api/v1/pharmacy-assisted/finance/payout-details` | as the partner and doctor payout details (`method: 'bank' \| 'upi'`, …, `expectedDetailsVersion?`) | the home account, masked; an admin verifies it at `/api/v1/settlements/accounts/:id/payout-details/verify` |

`withdrawal` = `{ _id, walletKind, state: 'requested'|'cancelled'|'rejected'|'paid'|'voided', grossMinor, feeMinor,
transferMinor, feeLine, lots: [{ lotId, amountMinor, feeMinor }], destination: { masked, detailsVersion }, paid: { method,
reference, paidOn, at } | null, reason, version, createdAt, updatedAt }`. Show `feeLine` ("Card fee on unspent card money:
₹x. You receive ₹y of ₹z." or "No card fee. You receive ₹y.") before and after the request; the wallet statement's hold
row says the same.

Errors: 400 `WITHDRAWAL_BELOW_MINIMUM` (`details.minimumMinor`), `VALIDATION_ERROR`; 403 (guards,
`SPECIALIST_NOT_VERIFIED`); 404 `WITHDRAWAL_NOT_FOUND` (another owner's); 409 `PAYOUT_DESTINATION_NOT_VERIFIED`,
`PAYOUT_DETAILS_CHANGED`, `WITHDRAWAL_ABOVE_AVAILABLE` (`details.withdrawableNowMinor`), `WALLET_FROZEN`,
`WALLET_RECEIVABLE`, `WITHDRAWAL_WEEKLY_LIMIT` (`details.nextAllowedAt`), `WITHDRAWAL_CHANGED`, `WITHDRAWAL_NOT_REQUESTED`,
`IDEMPOTENCY_KEY_REUSED`, `REQUEST_ABANDONED`; 503 `WITHDRAWALS_DISABLED`, `INDEXES_OUTDATED`.

Admin (`requireAdmin`):
- `GET /api/v1/admin/wallet-withdrawals?state&cursor` (oldest first) and `GET …/:id` — the withdrawal plus `walletRef`,
  `requestedBy`, `destination.homeAccountId`, `holdEntryId`, `releaseEntryId`, `voidEntryId`, `paid.note`, `paid.by`.
- `POST …/:id/reject { reason, expectedVersion }`; `POST …/:id/paid { method: 'bank_transfer'|'upi', reference, paidOn
  (YYYY-MM-DD), note?, detailsVersion, expectedVersion, requestKey }` (409 `REFERENCE_REUSED`, `PAYOUT_*`,
  `WITHDRAWAL_*`); `POST …/:id/void { reason, expectedVersion }` (only `paid`; 409 `WITHDRAWAL_NOT_PAID`).
- Chargebacks: `POST /api/v1/admin/wallet-lots/:lotId/chargeback` and `…/wallet-payments/:paymentId/chargeback` now FLAG
  every top-up (`{ flagged: true, credited: true, replayed, paymentRecordId, lotId, walletKind, <owner>Id, message }`, or
  `blockedUncredited` for a top-up never credited). **New:** `POST /api/v1/admin/wallet-lots/:lotId/recover` and
  `…/wallet-payments/:paymentId/recover` `{ reason, requestKey }` (admin tools switch) → `{ recovered: true, replayed,
  entry, wallet, lotId, paymentRecordId, walletKind, <owner>Id, withoutLot, compensated? }`; 409 `DISPUTE_NOT_RECORDED`,
  `NOTHING_TO_RECOVER`.
- Pharmacy top-up: `POST /api/v1/pharmacy-wallet/topup` (the pharmacy's card top-up) answers 409 `WALLET_LIMIT_REACHED`
  with `details: { maxBalanceMinor, balanceMinor, pendingMinor, allowedMinor }` above ₹50,000.

#### 26.17.5 Indexes, switches, deploy, rollback

- **Indexes** (`npm run sync-indexes`): `wallet_withdrawals` `{walletRef.kind, walletRef.id, requestKey}` unique,
  `{destination.homeAccountId, paid.reference}` unique (partial), `{state, createdAt}`, `{walletRef.kind, walletRef.id,
  createdAt: -1}`; `wallet_topup_lots {walletRef.kind, walletRef.id, withdrawableAfter}`. Until then a request answers 503.
- **Order:** 1. deploy; 2. `npm run sync-indexes`; 3. `npm run migrate:lot-withdrawable-after` (dry run, then
  `-- --commit`); 4. restart. `WALLET_WITHDRAWALS_ENABLED` waits for GATE-RBI; `EARNING_RULE_V2_FOR_ALL` waits until
  providers are told.
- **Live at the deploy (no switch):** the `wallet_over_limit` alert (only once `assisted_alerts` exists, r32b); new
  pharmacy lots carry `withdrawableAfter` (it only matters to withdrawals, which are off). *Corrected by r32b
  (§26.17.7):* pharmacy chargebacks and the pharmacy top-up cap are behind their own switches, off.
- **Rollback:** never roll the code back while a withdrawal is `requested` or a hold is unreleased
  (`db.wallet_withdrawals.countDocuments({ state: 'requested' })` = 0), or while a booking made with
  `EARNING_RULE_V2_FOR_ALL` on is not yet completed (older code would read its earning from the price).

#### 26.17.6 Checks

`test/assisted/r32-phase4cd.integration.ts`, 15 checks: 4c off (rows as before, the earning is the price); 4c on (a
platform coupon earns the list price for the doctor and the lab, a provider coupon list − discount, pay-again follows the
paying terms); 4c legacy rows untouched; the switch off (503); the index 503; destination and minimum; the 7-day card
hold, admin credits never withdrawable, the backfill; the fee only on unspent card money (₹2,000 top-up with a ₹40 fee,
₹1,000 spent, ₹1,000 withdrawn → fee ₹20); a hold racing a booking debit (3 runs, never below zero); 5 identical
requests (one hold); the weekly limit and cancel; reject, paid vs cancel racing (3 runs), the UTR unique, void once; the
cap (top-up refused, a refund above it posts and alerts); chargeback then Recover (flag only, then debit, receivable,
freeze, once); the lab and doctor routes.

Existing suites changed for the chargeback decision (the take is now Recover): `phase1a-review` checks 7, 12, 16 and 17
and `r9b-followups` check 1 call Recover after the chargeback and read its answer and audit (`wallet.recovered`).
*Reverted by r32b (§26.17.7): with the switch off they test the production take unchanged.*

Each suite alone on its own database: `r32-phase4cd` 15/15, `phase1a-review` 20/20, `r9b-followups` 5/5,
`r9-owner-decisions` 10/10, `r13-phase2d` 18/18, `r20-phase3a` 15/15, `r10-phase1b` 19/19. The full regression
(`prun.sh … 2`): 83 of 84 pass, tsc 17 (unchanged); the one failure, `r10f-card-last` check 1 (a 1.5-second timing bound
under load), passes alone (2/2).

#### 26.17.7 r32b: the live pharmacy path unchanged with every switch off (review of r32)

The review found three 4d changes acting on the LIVE pharmacy path (S6) with every switch off. Production must not
change behaviour until the owner decides. Where this section and §26.17.1–6 differ, this one wins.

| # | Finding | Fix |
|---|---|---|
| 1 | The ₹50,000 cap refused pharmacy card top-ups | `WALLET_BALANCE_CAP_ENABLED` (off): the cap on the PHARMACY's own card top-up order only while it is on; off, the pharmacy top-up is exactly as before. Lab and doctor wallets keep their cap (2d/3a) whatever it says |
| 2 | Pharmacy chargebacks became flag-only | `WALLET_CHARGEBACK_FLAG_ONLY` (off) governs the **pharmacy** top-up kind only (`TopupKind.chargeback()`): off, a lost dispute on a pharmacy top-up is taken at once exactly as on production (the lot route's `recordChargebackIn`; the payment route's take, also without a lot or after a compensated close; same answers and audits); on, flagged only and taken back with Recover. **Lab and doctor top-ups stay flag-only whatever it says** (2d/3a). The take and Recover share one function (`takeTopupIn`). `phase1a-review` and `r9b-followups` are back to their production expectations (the switch is off in them); the r32 suite tests each mode explicitly |
| 3 | The `wallet_over_limit` alert was written inside every credit transaction | `npm run sync-indexes` creates `assisted_alerts` (every model's collection is created; it has a unique `key` index). In addition the alert is written only once that collection exists (checked outside the transaction, remembered); otherwise a warning with ids only — a credit never creates a collection in its transaction and never fails for an alert |
| 4 | Paid could pay out money disputed since the request | `paid` refuses with 409 `WITHDRAWAL_LOT_DISPUTED` when a held lot has a recorded dispute (or was charged back); reject releases it |
| 5 | A repeat chargeback of a lot taken the old way would flag, audit and alert again once the switch is on | A lot whose `chargeback:<lot>` entry exists answers flagged and replayed: nothing is marked, audited or alerted |
| 6 | The backfill could write a date from a missing `createdAt` | Only lots whose `createdAt` is a date are filled |
| 7 | 4c pay-again without an earlier payment record named no coupon, so a platform coupon's discount was treated as provider-funded | The booking's own frozen split decides: its coupon (and, when that coupon can no longer be read, its recorded funding) |

**Switches added:** `WALLET_BALANCE_CAP_ENABLED`, `WALLET_CHARGEBACK_FLAG_ONLY` (both off unless exactly `"true"`).
**Rollback:** none needed for these: with both off the pharmacy path is as before r32. Turning `WALLET_CHARGEBACK_FLAG_ONLY`
off again after flags were recorded leaves those top-ups flagged (an admin Recovers them).

**API changes for the web:** with the flag-only switch off, the pharmacy chargeback answers are the production ones
(`{ entry, wallet, replayed }` on the lot route; `{ blockedUncredited: false, entry, wallet, replayed, lotId,
paymentRecordId, withoutLot }` on the payment route). Admin paid: 409 `WITHDRAWAL_LOT_DISPUTED`.

Checks: `test/assisted/r32-phase4cd.integration.ts` (now 18): the cap off and on; chargebacks with the switch off (a
pharmacy lot taken at once on both routes, once; a doctor's flagged only) and the old-way lot replayed once the switch is
on; the switch on (flag, then Recover); paid refused on disputed money; 4c pay-again keeps the coupon's funding.

Merged `origin/stage` at `2df5651e` (r33 referral API, r30 records access, r31 SMS 5b; conflicts kept both sides; the r32
record is §26.17 because stage's r33 record is §26.16). Each suite alone on its own database: `r32-phase4cd` 18/18,
`r31-phase5b` 20/20, `phase1a-review` 20/20, `r9b-followups` 5/5, `r13-phase2d` 18/18, `r20-phase3a` 15/15,
`s6-pharmacy-wallet-verify` 31/31, `r10-phase1b` 19/19. The full regression (`prun.sh … 2`): 85 of 85 pass, tsc 17.

**Seen, not changed:**
- `assisted/consultations.ts` and `assisted/labBookings.ts` keep a one-line alias `const fundedByOf = couponFundedBy`.
- The admin pharmacy top-up (`POST /pharmacy-wallet/topup` by an admin) is not capped by O2 (it is an admin credit; the
  ₹2,00,000 admin cap stays); its credit above ₹50,000 raises the alert.
- 4e (referral payouts) and 4f (finance screens) are not built.

### 26.18 Rounds 4e + 4f build record (r35, 2026-11-25)

Branch `m0/r35-phase4ef` from `4d73adc3` (r32b on stage `2df5651e`). Local commits only. Built §26.9 (4e) and §26.10 (4f)
under §26.4's rules, plus three gaps the WQ29 withdrawal screens found. Every switch is off by default; existing answers
only gain fields. Check: `test/assisted/r35-phase4ef.integration.ts` (13 checks).

#### 26.18.1 What was built, and what already existed

| Item | Status | Where |
|---|---|---|
| Referral payouts refused while `REFERRAL_PAYOUTS_ENABLED` is off | **Existed** (r24, M19) | `finance.ts` `recordPayout` |
| The payout's destination = the HOME account's verified details and version | **New** | `recordPayout` reads the lab's `partner` account for a `lab_referral` account and the doctor's `doctor` account for a `doctor_referral` one; a `pharmacy_referral` account is its own home. The payout's `destination` label is the home's |
| Owed wallet amount paid from the referral earnings | **New** | `referralCuts/payouts.ts` `setOffFromReferral` (one transaction: the wallet's `receivable_setoff` via the new `walletCore.setOffReceivableIn`, then the referral account's `adjustment` via `finance.postReferralSetoffIn`; exactly once per key; audited `wallet.referral_setoff`) |
| The admin accounts list filters the referral kinds | **New** | `ownerKind` takes `pharmacy_referral`, `lab_referral`, `doctor_referral` and `referral` (all three); referral rows add `payoutsPaused` |
| Statements show payouts | **Existed** (the ledger statement); the set-off row's words are new | `finance.ts` `FALLBACK.receivable_setoff` |
| Pharmacy `GET …/finance` | **New** | `assisted/controller/phase4f.ts` from the shared blocks: `walletSummary`, `withdrawalsSummary`, `destinationFor` (`walletWithdrawals/service.ts`) and `referralSummary` (`referralCuts/payouts.ts`; r33's `…/referral` now uses it too) |
| Pharmacy statement `?kind=wallet\|referral` (+ `.csv`) | **New for `wallet`**; `referral` **existed** (r33) | The wallet kind: `pharmacyWallet/services` `walletStatementPage` (rows as `transactionView`) and `walletStatementCsv`. **One CSV writer:** `finance.ts` `statementCsvOf` (r33's `cell()`), now used by the ledger CSV and the wallet CSV |
| Lab `/finance`, doctor `/me/finance`: `referral` and `withdrawals` blocks | **New** | `partners/controller/finance.ts` (a partner that is not a lab gets `null` blocks) |
| Admin: referral accounts (due, payouts paused) | **New** (the filter and `payoutsPaused` above); the list itself existed | `GET /api/v1/settlements/accounts?ownerKind=referral&due=true` |
| Admin: withdrawals queue | **Existed** (r32) | `GET /api/v1/admin/wallet-withdrawals` |
| Admin: disputes | **New** | `GET /api/v1/admin/wallet-disputes` (`partnerWallets/topupKinds.ts` `topupDisputes`) |
| Admin: rules per partner | **Existed** (r24/r33) | `GET /api/v1/admin/referral-rules?bookerKind&bookerId` |
| WQ29 (1): the pharmacy's own payout account for its form | **New** | `payoutDetails.details` (masked) in `…/finance` and in `…/wallet/withdrawable`'s `destination` |
| WQ29 (2): why a quote is not available | **New** | `quote.reason` |
| WQ29 (3): top-ups credited without a lot | **New** | `GET /api/v1/admin/wallets/:kind/:id/topups-without-lot` |

#### 26.18.1a WQ29 web review: four withdrawal risks (coordinator, 25 Nov)

| # | Risk | Built |
|---|---|---|
| 1 | The fee could change between the screen and the request | The request takes an optional `expectedTransferMinor`; when the plan's transfer differs: 409 `WITHDRAWAL_QUOTE_CHANGED` with `details: { grossMinor, feeMinor, transferMinor }` (the new quote). It is part of the request hash only when sent (older keys replay unchanged) |
| 2 | A payout-details edit after a request made the withdrawal un-payable (an admin who had transferred could only Reject: paid twice) | Every payout-details change (owner and admin; pharmacy, lab and doctor home accounts) is refused with 409 `WITHDRAWAL_OPEN` while a withdrawal to that account is `requested`: cancel first. The request checks the destination and writes the home account (`financeVersion`) in its transaction, so the two never pass each other |
| 3 | A dispute recorded after the bank transfer left only Reject (money returned that had already left) | Admin `paid` takes `disputeAcknowledged: true`: it is marked paid (`paid.disputeAcknowledged`, `paid.disputedMinor`), nothing more is taken from the held lots, and the withdrawn money is owed back — the lot's Recover makes it the wallet's receivable (then set-off from referral earnings). Audited (`withdrawal.paid` detail and the `withdrawal_paid` SettlementEvent carry `disputeAcknowledged`, `disputedMinor`). Without it: 409 `WITHDRAWAL_LOT_DISPUTED` as before |
| 4 | Scope (**coordinator decision**) | A lab withdrawal request, cancel and abandon need `wallet.manage` **and** partner-wide scope (403 `FINANCE_SCOPE_REQUIRED`), as the finance reads: a branch-limited member cannot withdraw the whole lab wallet. Reads stay with `wallet.view` |

#### 26.18.2 ASSUMED (r35, reversible)

| # | Choice | Why |
|---|---|---|
| P1 | A set-off above what is owed or above the referral balance is refused (409 `SETOFF_ABOVE_AVAILABLE` with `details.receivableMinor` / `details.referralDueMinor`), never silently capped | The admin chooses the amount; a refusal says why |
| P2 | The wallet's `receivable_setoff` entry of a set-off moves no balance (the referral money never passed through the wallet): `signedAmountPaise` 0, `receivableDeltaPaise` −amount; the wallet stays frozen until an admin unfreezes it (as after any set-off) | Balance = Σ entries holds; unfreezing is an admin decision |
| P3 | The set-off needs only `REFERRAL_PAYOUTS_ENABLED` (M8), not the admin-tools switch | §26.9 "behind the same switch" |
| P4 | The pharmacy statement keeps the ledger statement's query (`before`, `limit`, `from`, `to`) and adds `kind` (default `wallet`); the wallet kind lists completed rows only | One statement contract for the web |
| P5 | The payout to a referral account is not fenced on the home account's `financeVersion` (it reads the home's version, compared with `detailsVersion`) | A recorded payout reports a transfer the admin made to the version it saw |
| P6 | The disputes read is capped at 200 rows, newest first, without a cursor | An admin queue, as stuck money's lists |
| P7 | A withdrawal request bumps the home account's `financeVersion` (the serialisation point with a payout-details change); an admin payout on that account fenced on an older `expectedFinanceVersion` then answers 409 `FINANCE_CHANGED` | One existing serialisation point |
| P8 | `paid` with `disputeAcknowledged` does not create the receivable itself; the lot's Recover does (its take counts the withdrawn money, which the balance no longer holds) | Nothing is taken twice |

#### 26.18.3 API for the web (exact shapes; `{ success, data }`, `Cache-Control: private, no-store`, paise)

**Pharmacy** (operational pharmacy token):
- `GET /api/v1/pharmacy-assisted/finance` →
  ```
  { wallet: { balanceMinor, withdrawableNowMinor, availableLater: [{ amountMinor, availableAt }], receivableMinor, frozen },
    referral: { earnedMinor, paidMinor, dueMinor, cutsEnabled, payoutsEnabled },
    withdrawals: { openCount, lastPaidAt | null, enabled },
    payoutDetails: { state: 'none'|'unverified'|'verified', masked | null, detailsVersion,
      details: { method: 'bank', accountName, ifsc, bankName?, accountNumberLast4, accountNumberMasked }
             | { method: 'upi', upiId, accountName? } | null } }
  ```
  `details` prefills the payout form (`PUT …/finance/payout-details`, send `expectedDetailsVersion: detailsVersion`); the
  full account number is never returned.
- `GET …/finance/statement?kind=wallet|referral&before&limit≤200&from&to` → `data`: for `wallet`, the wallet rows as the
  released app reads them (`transactionView`: every stored field plus `transactionType: 'credit'|'debit'|'refund'` by sign
  and `movementType` = the stored kind, e.g. `booking_debit`, `withdrawal_hold`, `receivable_setoff`; amounts in
  `amountPaise`, `signedAmountPaise`, `balanceAfterPaise`), newest first; for `referral`, r33's referral statement lines
  `{ _id, at, kind, source, sourceId, description, reference?, note?, amountMinor, balanceAfterMinor, grossMinor?,
  commissionMinor?, shortRef?, category?, lines? }`. Top level `pagination: { nextCursor }` (send it as `before`).
- `GET …/finance/statement.csv?kind&from&to` → `text/csv`, columns `Date (IST), Type, Description, Reference, Note,
  Amount (INR), Balance (INR)`, with opening and closing balance rows; `pharmacy-wallet-statement….csv` /
  `pharmacy-referral-statement….csv`. 400 `EXPORT_TOO_LARGE` above 5,000 rows.
- `POST …/wallet/withdrawals { amountMinor, requestKey, detailsVersion, expectedTransferMinor? }` (r32, now): 409
  `WITHDRAWAL_QUOTE_CHANGED` with `details: { grossMinor, feeMinor, transferMinor }` when `expectedTransferMinor` differs.
- `PUT …/finance/payout-details` (and the lab's, the doctor's and the admin's): 409 `WITHDRAWAL_OPEN` while a withdrawal
  to that account is `requested`.
- `GET …/wallet/withdrawable?amountMinor` (r32, now) → `{ enabled, minimumMinor, withdrawableNowMinor, availableLater,
  nextAllowedAt, destination: { state, masked, detailsVersion, details }, quote?: { grossMinor, feeMinor, transferMinor,
  available, reason } }`; `reason` is null when a request of this amount would go through now, else the first that
  applies of `WITHDRAWALS_DISABLED`, `BELOW_MINIMUM`, `DESTINATION_NOT_VERIFIED`, `WALLET_RECEIVABLE`, `WALLET_FROZEN`,
  `WEEKLY_LIMIT`, `ABOVE_WITHDRAWABLE` (`available` = `reason === null`).

**Lab** (`GET /api/v1/partner-workspace/finance`, `finance.view`) and **doctor** (`GET /api/v1/specialists/me/finance`):
the existing `{ account, balanceMinor, totals, lastPayout }` plus `referral: { earnedMinor, paidMinor, dueMinor,
cutsEnabled, payoutsEnabled }` and `withdrawals: { openCount, lastPaidAt, enabled }` (both `null` for a partner that is
not a lab). The doctor's and lab's destination stay on their existing finance reads (`account.payoutDetails`).

**Admin:**
- `POST /api/v1/admin/wallets/:kind(pharmacy|lab|doctor)/:id/receivable/setoff-from-referral { amountMinor, requestKey }` →
  201 (replay 200) `{ setoff: { amountMinor, referralAccountId, ledgerEntryId, walletEntryId, at }, wallet: {
  receivableMinor, frozen }, replayed }`. 409 `REFERRAL_PAYOUTS_DISABLED`, `SETOFF_ABOVE_AVAILABLE` (`details`),
  `IDEMPOTENCY_KEY_REUSED`, `REQUEST_ABANDONED`; 404 `WALLET_NOT_FOUND` (no wallet or no referral account). `GET
  …/by-key/:key` → `{ state: 'used', setoff } | { state: 'abandoned' | 'unknown' }`; `POST …/by-key/:key/abandon`.
- `GET /api/v1/settlements/accounts?ownerKind=partner|doctor|pharmacy_referral|lab_referral|doctor_referral|referral&due`
  → as before; referral rows add `payoutsPaused` (true while `REFERRAL_PAYOUTS_ENABLED` is off). Show "Paused until tax
  advice" on their payout form.
- `GET /api/v1/admin/wallet-disputes?state=flagged|recovered|blocked&walletKind&limit≤200` → `[{ paymentRecordId,
  walletKind, ownerId, lotId | null, amountMinor, remainingMinor | null, state, chargebackAt | null, recoveredAt | null, at
  }]`, newest first. `flagged`: recorded, nothing taken (Recover); `recovered`: taken; `blocked`: never credited.
- `GET /api/v1/admin/wallets/:kind/:id/topups-without-lot` → `[{ paymentRecordId, walletKind, ownerId, razorpayPaymentId,
  amountMinor, paidAt, creditedAt, chargebackAt }]` (recover one with `POST /api/v1/admin/wallet-payments/:paymentId/recover`).
- `POST /api/v1/admin/wallet-withdrawals/:id/paid` (r32, now) takes `disputeAcknowledged?: true`; the withdrawal's
  `paid` adds `disputeAcknowledged`, `disputedMinor` when used.
- Lab withdrawal request / cancel / abandon: 403 `FINANCE_SCOPE_REQUIRED` for a branch-limited member.
- Unchanged and reused: `GET /api/v1/admin/wallet-withdrawals` (the queue), `GET /api/v1/admin/referral-rules?bookerKind&bookerId`.

#### 26.18.4 Switches, indexes, deploy, rollback

- No new switch: 4e uses `REFERRAL_PAYOUTS_ENABLED` (off). No new index: the set-off relies on the ledger's unique
  `{settlementAccountId, source, sourceId, kind}`, the request keys and the wallet stores' operation keys
  (`assertUniqueIndex`, 503 until `sync-indexes`). No migration.
- Order: deploy; restart. With every switch off: referral payouts and set-offs stay refused; the reads are new.
- Rollback: plain (nothing new is written while the switch is off).

#### 26.18.5 Checks

`test/assisted/r35-phase4ef.integration.ts`, 9 checks: the payout refused while off (a partner payout unchanged); on, a
lab referral payout to the home destination, fenced on the home version, refused while the home is unverified, a
pharmacy's own home, statements show the payouts; the set-off (off 409; on, paired once under 3 identical requests,
balance unchanged, a race of two never below zero, capped by both balances, key reuse, by-key and abandon, the statement
row, the unknown wallet); the accounts list filters and `payoutsPaused`; the pharmacy `/finance` blocks and another
pharmacy's own; the pharmacy statement (wallet paging, from/to, referral kind, both CSVs, another pharmacy's rows never);
the lab and doctor blocks; the disputes and top-ups without a lot; the quote's reasons; WQ29: the fee fence, the details
lock, paid after a dispute (then Recover and set-off), the lab scope (13 checks in all).

Merged `8b1f6c35` and then `origin/stage` `21496500` (r32 + r32b on stage; the same tree). Each suite alone on its own
database: `r35-phase4ef` 13/13, `r33-referral-gaps` 5/5, `r24-phase4ab` 15/15, `r32-phase4cd` 18/18 (its quote assertion
gains `reason: null`), `q5-finance` 19/19. The full regression (`prun.sh … 2`): 83 of 87 pass, tsc 17; the four failures
were the runner's mongod stalling under load (`PoolClearedOnNetworkError … server monitor timeout` in
`a2b-external-cancel`, `q4b-instant`, `q4a-scheduled`; an OTP read in `c1r-session-revoke`) and each passes alone
(18/18, 25/25, 24/24 with its clock shim, 7/7).

## 27. Phase 5 build specification (SMS) (r23, 2026-11-25)

Design only; nothing here is built. Base: `m0/r15-phase3-spec` (`f5f171c9` + §25). Phase 5 is built after the phase 2 and 3
rounds merge, so every `file:line` is under `src1/modules/` (or `src1/` for `index.ts` and `routes/index.ts`) at
**`b1f8b726`** (`m0/r21-phase2e`: the stage line with 2a–2e, 3d and the r10g/r10h Meet retry), unless it says
**`@02b4a0e0`** (`m0/r17-phase3e`, partner instant consults). The SMS, queue, OTP-limit, config and notice files are the
same at `f5f171c9`. Where this section and §10, §13 or §16 differ, this one wins.

Phase 5 adds one new piece: an outbox, `sms_notices`, with its drain loop. Everything else is reused:
- the SMS gateway that already sends sign-in codes (`sms/services/index.ts:86-101`);
- the Meet retry's lease, back-off and alert pattern (`meet/retry.ts:99-146`; `raiseAlertIn`, `assisted/limits.ts:89`);
- `assertUniqueIndex` (`common/utils/requiredIndex.ts:19`), here failing closed to "no SMS", never to a 503;
- the Mongo window counters of the OTP limits (`hit`, `otp/throttle.ts:41-50`) for the `/j/` limit;
- `slotsOf`, `appointmentIntervalOf`, `hasPrescription` (`assisted/rxAccess.ts:22`, `:30-36`, `:83`);
- the `shortRef` and `join.linkVersion` every assisted consultation already stores (`assisted/consultations.ts:82-85`,
  `:271`).

### 27.1 Owner decisions this section builds (not reopened)

1. **Messages:** booking confirmed; prescription ready; lab report ready; reminder before the visit; cancelled or moved.
   "Booked" and "reminder" have link variants for patients who join video on their own phone.
2. **Templates** are registered on the DLT portal. A `.env` switch per message (and per language) turns each one on or
   off.
3. **SMS never affects a booking.** Not configured or failing → skipped. Sending happens after the commit, from a drain
   loop.
4. **Languages:** the language asked at booking (already stored). First wave: Hindi, English, Assamese, Bengali, Odia.
   Mizo and other north-east languages come later. Per-language switches.
5. **Video on the patient's own phone:** the app's Join, plus an SMS link once that template exists.
6. **No PII in logs. No blocking limits** except phone lookups. A rate limit on the public `/j/` route is allowed: it
   protects the link, not bookings.
7. **The records-access code (§10.6)** belongs with the phase 3f grants. This section notes the seam only (§27.9).

### 27.2 The code today, and what it means for phase 5

| Fact | Where | Consequence |
|---|---|---|
| One SMS gateway: HTTP GET with `username`, `password`, `from`, `to` (`91` + 10 digits), `text`, `tmplId`, `peId`, optional cookie | `sms/services/index.ts:86-101`; `config/config.ts:53-66` | The adapter's one implementation: same account, same PE id |
| No timeout; any 2xx counts as sent; a failure throws an `AppError` carrying the provider's text | `sms/services/index.ts:86`, `:104-117` | The adapter adds a timeout, never throws and returns codes only |
| A missing template id falls back to the sign-in template (`tmplId: payload.templateId \|\| CONFIG.SMS_TEMPLATE_ID`) | `sms/services/index.ts:95` | The adapter never falls back: no id, no send |
| Sign-in codes are sent inside the request; the walk-in bill and member-email notices after the commit, best effort | `auth/services/index.ts:275-283`; `partners/services/invoice.ts:538-545`; `partners/services/index.ts:201-207` | Unchanged by phase 5 |
| `Job` queue: one cron every 10 s; each consumer takes **one** job per tick (120 s lease) | `queue/service/TaskQueue.ts:28`; `queue/service/JobConsumer.ts:15-36` | Too slow to drain a batch |
| `publishUniqueNow` runs the consumer **inside the caller** | `queue/service/TaskQueue.ts:50-70` | It would make a booking answer wait for a send |
| `publishUniqueLater` upserts and overwrites `processAfter` and `payload` | `queue/service/TaskQueue.ts:89-100` | A replayed enqueue would re-arm a job |
| Customer reminders: two `Job`s per consultation (1 day, 30 min), in-app and push | `bookings/services/bookingReminderScheduler.ts:36-80`; `queue/service/BookingReminderConsumer.ts:17-100` | Unchanged; the SMS reminder is separate |
| After-commit notices: `sendAssistedNotices`, best effort, idempotent keys | `assisted/support.ts:42-46`, `:87-89` | Every SMS hook sits beside one of these calls |
| Meet retry: cron every 5 min, a per-row lease judged on the wall clock, back-off, one alert | `meet/retry.ts:99-146`, `:158-174` | The drain copies this pattern |
| OTP limits: Mongo fixed-window counters, ids HMAC'd, TTL | `otp/throttle.ts:12`, `:41-50`; `otp/model/throttle.ts:9-14` | The `/j/` limit reuses `hit()` |
| The request logger prints every path | `src1/index.ts:64-70` | It would log `/j/<token>`: 5d redacts it |
| Languages stored: `assisted.preferredLanguage` (`^[a-z]{2,3}$`), `desk.preferredLanguage`; `User` and `Dependent` `preferredLanguage` | `assisted/validation/index.ts:57`, `:119`; `partners/model/labBooking.ts:39`; `user/model/index.ts:185`; `dependents/model/index.ts:46` | The SMS language is the booking's |
| `shortRef`: 8 RFC 4648 base32 characters, unique partial index on consultations and partner-lab bookings. **Lab desk rows have none** | `assisted/consultations.ts:82-85`, `:139`; `assisted/labBookings.ts:127` | `/j/` looks up by `shortRef`; desk SMS need another Ref (SM12) |
| `join.linkVersion` is 1 at create, bumped by the admin account move; a booker move keeps it | `assisted/consultations.ts:271`; `assisted/review.ts:247`; `assisted/pharmacyCommands.ts:420` | §6.6 holds. §16's "tokens die on a move" means the account move only |

### 27.3 The split and the order

| Round | Content | Depends on | Size |
|---|---|---|---|
| **5a** | Outbox `sms_notices`, the enqueue helper, the drain loop, the provider adapter (the existing gateway), templates and language choice, switches, admin read and test-send routes. No event enqueues yet, so 5a sends nothing by itself | — | M |
| **5b** | Enqueue at every commented hook: booked, prescription ready, report ready, cancelled, moved, account move; the send-time checks per event | 5a | M |
| **5c** | Visit reminders: due time, quiet hours, a new reminder on each move | 5b | S |
| **5d** | Join links: the token, the link variants of "booked" and "reminder", the public `GET /j/:token` with its per-IP limit, the log redaction | 5a | S–M |

- **Order: 5a → 5b → 5c.** 5d comes after 5a and can be built beside 5b or 5c. It changes only `smsNotices/joinLink.ts`,
  the variant choice, one router mount and the logger line, so it does not collide with 5b's hook edits.
- **Phase 5 writes no booking field.** Rounds that change booking files (3b, 3c, 3f) can run beside it. Once 5b is
  merged, a later round calls the 5b helper at its hook instead of leaving a comment.
- Each round is backend, an integration suite and an independent review (Opus xhigh). Commits stay local; stage only on
  the owner's word (§13).

### 27.4 Shared rules for every round

- **Never affects a booking.**
  - Enqueue only after the commit, never with a session.
  - `enqueueSms` never throws. Any error (switch read, index check, insert) is logged by code and swallowed.
  - No booking answer depends on SMS, and no booking route waits for the gateway. Replays enqueue nothing new (the
    unique key).
  - Phase 5 writes nothing to `bookings`, `partner_lab_bookings` or `instant_requests`.
- **No PII.**
  - The outbox stores ids and codes only: no phone, name, text, token or template variable. The text is built at send
    time from the fresh booking.
  - Logs carry `event`, `bookingKind`, `state`, `reason` and `attempts` only. Never the phone, name, text, token,
    template id or the gateway's answer.
- **Switches** are read on every call and are off unless exactly `"true"` (the rule of `assisted/flags.ts:14`). With
  `SMS_NOTICES_ENABLED` off, nothing is enqueued, and rows already due are marked `skipped: switched_off`.
- **Indexes.** The new model lives in `smsNotices/model/` (read by `npm run sync-indexes`). The enqueue and the drain
  check the outbox's unique index with `assertUniqueIndex`; if it is missing, no row is written and no tick runs
  (logged `indexes_outdated`). Failing closed means "no SMS", never a 503.
- **No limits** on bookings or on SMS per number. The only new limit is per IP on `/j/` (5d).
- **Scope.** Rows with an `assisted` block (consultations, instant consultations, partner-lab bookings) and lab desk rows
  (`desk`). Never customer self-bookings, clinic desk bookings or legacy pharmacy bookings (§6.4, §10.2).

### 27.5 Round 5a: outbox, drain, provider adapter, templates, switches

#### 27.5.1 Data model (new module `smsNotices`, `src1/modules/smsNotices/model/index.ts`)

**`sms_notices`**: one row is one SMS, and it is the idempotent marker of §10.4.

| Field | Type | Notes |
|---|---|---|
| `bookingKind` | `'booking' \| 'lab_booking'` | `booking` includes instant consultations (the booking made at accept) |
| `bookingId` | string | Lower-case hex |
| `event` | `'booked' \| 'rx_ready' \| 'report_ready' \| 'reminder' \| 'cancelled' \| 'moved' \| 'moved_off'` | §27.6.1 |
| `version` | string | Per event (§27.6.1). With the three fields above, the unique marker |
| `recipientUserId?` | string | Only for `moved_off` (the previous holder). Otherwise the booking's `userId` at send time |
| `state` | `'queued' \| 'sending' \| 'sent' \| 'failed' \| 'skipped'` | `sending` goes back to `queued` after a retryable failure |
| `dueAt` | Date | Never sent before it (reminders: §27.7) |
| `leaseUntil?` | Date | While `sending` |
| `attempts` | number | Gateway calls made |
| `message?`, `lang?` | string | Chosen at send (`BOOKED_LINK`, `hi`) |
| `reason?` | string | Skip or failure code (§27.5.3) |
| `providerStatus?` | number | HTTP status only |
| `sentAt?`, `finishedAt?`, `expireAt?` | Date | `expireAt` = `finishedAt` + 180 days |
| `createdAt`, `updatedAt` | Date | |

**Indexes:**
- `{ bookingKind: 1, bookingId: 1, event: 1, version: 1 }`, unique, no partial filter: the marker;
- `{ state: 1, dueAt: 1 }`: the drain;
- `{ expireAt: 1 }`, TTL `expireAfterSeconds: 0`.

Schema options as `otp/model/throttle.ts:13` (`strict: 'throw'`, `autoIndex: false`, `autoCreate: false`).

**Why not a `Job` plus a marker (§10.4).** One collection does both. The `Job` queue takes one job per consumer per 10 s
tick, `publishUniqueNow` runs the consumer inside the caller, and `publishUniqueLater` re-arms an existing job (§27.2).
`Job` has no state or attempts, so §10.4 needed a second collection anyway (SM1).

#### 27.5.2 Enqueue

`enqueueSms({ bookingKind, bookingId, event, version, dueAt?, recipientUserId? }): Promise<void>` in
`smsNotices/enqueue.ts`:
1. `SMS_NOTICES_ENABLED` is not `"true"` → return.
2. `assertUniqueIndex(SmsNoticeModel, { bookingKind: 1, bookingId: 1, event: 1, version: 1 })`. Failure → log
   `indexes_outdated`, return.
3. `insertOne({ …, state: 'queued', dueAt: dueAt ?? now, attempts: 0 })`. Duplicate key (11000) → return: already
   queued or done.
4. Any other error → log `enqueue_failed`, return.

It never throws and never sends. Only the 5b helpers (§27.6.1) call it.

#### 27.5.3 The drain loop

`runSmsNoticeScheduler()` in `smsNotices/drain.ts`, started in `src1/index.ts` beside `runMeetRetryScheduler()` (`:98`).
A cron every 15 s with an in-process `running` guard, as `meet/retry.ts:158-174`. Several instances only contend for
the per-row lease.

One tick, `drainOnce(now)`:
1. **Index.** Check the unique index as the enqueue does. Missing → no tick.
2. **Read** up to 50 rows `{ state: { $in: ['queued', 'sending'] }, dueAt: { $lte: now } }`, oldest `dueAt` first.
3. **Claim** each row with one compare-and-set judged on the wall clock (as `meet/retry.ts:112-116`):
   - filter `{ _id, dueAt ≤ now, $or: [{ state: 'queued' }, { state: 'sending', leaseUntil ≤ wall-now }] }`;
   - update `{ state: 'sending', leaseUntil: wall-now + 60 s, $inc: { attempts: 1 } }`;
   - not claimed → next row.
4. **Decide** on the fresh booking (one read, plus the recipient's `User` and the slot). The first match wins:
   - master switch off → `skipped: switched_off`;
   - gateway not configured → `skipped: provider_not_configured`;
   - booking gone → `skipped: booking_missing`;
   - the event is no longer true → `skipped: stale` (§27.6.2);
   - an open "not mine" report → `skipped: disputed` (not for `moved_off`);
   - no valid mobile (`canonicalMobile(User.phone)`, `common/utils/phone.ts:5`) → `skipped: no_phone`;
   - `User.isActive === false` → `skipped: recipient_inactive`;
   - no sendable message and language (§27.5.5) → `skipped: no_template`;
   - non-Latin text while `SMS_UNICODE_PARAM` is empty → `skipped: unicode_not_configured`.
5. **Send** through the adapter with `SMS_SEND_TIMEOUT_MS`, capped at 20 s (a third of the lease).
6. **Record** with a compare-and-set on `{ _id, state: 'sending', leaseUntil: <this claim's lease> }`, so a worker whose
   lease expired cannot overwrite:
   - accepted → `sent`, `sentAt`, `message`, `lang`;
   - retryable failure while `attempts < SMS_NOTICE_MAX_ATTEMPTS` → `queued`, `dueAt` = now + 2 min after the first
     failure, + 10 min after the second;
   - otherwise → `failed`, and one `sms_failed` alert a day: `raiseAlertIn({ kind: 'sms_failed', subject: 'sms' })`,
     detail = the first failure's reason, no booking or person.
7. **Gateway down.** After 3 retryable failures in a row the tick stops. Unclaimed rows wait for the next tick and use
   no attempt.

**Delivery is at least once.** A crash between the gateway's answer and step 6 can resend after the 60 s lease (§10.4
accepted this). Everything else happens once per marker.

**Failure codes.** Retryable: `timeout`, `network`, `http_5xx`, `http_429`. Final: `http_4xx`, `rejected` (a 2xx whose
body the adapter recognises as a refusal, §27.5.4).

#### 27.5.4 Provider adapter

```ts
// smsNotices/provider.ts: provider-neutral
export interface SmsProvider {
  configured(): boolean;
  send(m: { to: string /* 10-digit Indian mobile */; text: string; templateId: string; unicode: boolean; signal: AbortSignal }):
    Promise<{ ok: true } | { ok: false; retryable: boolean; status?: number;
      code: 'timeout' | 'network' | 'http_5xx' | 'http_429' | 'http_4xx' | 'rejected' }>;
}
export function smsProvider(): SmsProvider;                   // the configured one
export function setSmsProvider(p?: SmsProvider): SmsProvider; // tests, as setAssistedEffects (assisted/support.ts:79-84)
```

**The one implementation, `HttpGetSmsProvider`**, is the gateway that already sends sign-in codes, with the request of
`sms/services/index.ts:86-101`:
- `GET SMS_API_BASE_URL` with `username`, `password`, `from` (`SMS_NOTICES_FROM`, else `SMS_FROM`), `to` (`91` + 10
  digits), `text`, `tmplId`, `peId` (`SMS_PE_ID`); `Cookie: SMS_COOKIE` when it is set;
- `configured()`: base URL, username, password, sender and PE id are all set;
- `unicode: true` (text outside the GSM 7-bit set) adds `SMS_UNICODE_PARAM` (`name=value`) to the query;
- axios `timeout` and `signal`, `validateStatus: () => true`; it never throws;
- **never** a template fallback (unlike `sms/services/index.ts:95`);
- classification: 429 and 5xx retryable; other 4xx final; timeout and network errors retryable; 2xx accepted unless the
  body matches the gateway's refusal shape, which the 5a builder records from a stage send (until then every 2xx is
  accepted);
- the body is read for that check only, never logged or stored.

Sign-in codes, the walk-in bill and the member-email SMS keep using `SMSService` unchanged.

#### 27.5.5 Templates, language and variables

**Messages** (`<MSG>`): `BOOKED`, `BOOKED_LINK`, `RX_READY`, `REPORT_READY`, `REMINDER`, `REMINDER_LINK`,
`CANCELLED_MOVED` (English drafts in §10.2). **First-wave languages** (`<LANG>`): `EN`, `HI`, `AS`, `BN`, `OR` (codes
`en`, `hi`, `as`, `bn`, `or`, §11.1). That makes **35 DLT templates**.

- **Text in the repo.** `smsNotices/templates/<lang>.ts` holds, byte for byte, the registered text with its `{#var#}`
  placeholders in a fixed order per message, plus the fixed words of that language: the service names, "cancelled",
  "moved to", "moved to another number", "your family member", "Jansetu app", "home", "the clinic".
  - English ships final.
  - `hi`, `as`, `bn` and `or` ship as drafts. A language becomes sendable only once its registered text replaces the
    draft (SM18).
- **Link templates** hold the fixed text `<SMS_JOIN_LINK_BASE_URL>/{#var#}`. The renderer writes the configured base
  into that fixed part and the token into the variable (5d).
- **Sendable** = `SMS_<MSG>_<LANG>_ENABLED` is `"true"`, `SMS_<MSG>_<LANG>_TEMPLATE` is set, and the repo has the final
  text (a `final: true` mark in the template file).
- **Language choice.** `L` = the booking's `assisted.preferredLanguage` (desk rows: `desk.preferredLanguage`). The first
  sendable candidate wins (SM6):
  1. the link variant in `L`;
  2. the plain message in `L`;
  3. the link variant in `SMS_FALLBACK_LANGUAGE` (default `en`);
  4. the plain message in it.

  The link variant is a candidate only where 5d says so. No candidate → `skipped: no_template`.
- **Variables.** Each is at most 30 characters, cut after cleaning.
  - `name`: the patient's first word: the family member's name, else the lab booking's `patient.name`, else the
    account's `name`. Cleaned to letters (any script), combining marks and single spaces (§10.2). Empty → "your family
    member" in `L`.
  - `service`, in `L`, from the booking's mode: video consultation, phone consultation, clinic consultation, lab test,
    home sample collection.
  - `date` as `DD-MM-YYYY` and `time` as 24-hour `HH:mm`, India time, Latin digits in every language. An instant
    consultation uses the acceptance time.
  - `place`: §27.6.3.
  - `ref`: `assisted.shortRef`. A desk row has none: the last 8 characters of its id, upper case (SM12).
  - `what` (cancelled / moved), in `L`: "cancelled", "moved to <date> <time>" or "moved to another number".
  - `token`: 5d.
- **Never** doctor name or speciality, test names, diagnosis or amounts (§10.2).
- **Length.** Unicode text is 70 characters a part, so a Hindi "booked" is about 3 parts (Q5).

#### 27.5.6 `.env` (names as §10.1)

```
SMS_NOTICES_ENABLED=false            # master switch for booking notices
SMS_SEND_TIMEOUT_MS=5000             # per gateway call (capped at 20000)
SMS_NOTICE_MAX_ATTEMPTS=3            # gateway calls per notice
SMS_FALLBACK_LANGUAGE=en             # ASSUMED D1
SMS_UNICODE_PARAM=                   # the gateway's Unicode flag as name=value; empty = non-Latin notices skipped
SMS_NOTICES_FROM=                    # NEW, optional: the DLT header for notices; empty = SMS_FROM

# <MSG>  = BOOKED BOOKED_LINK RX_READY REPORT_READY REMINDER REMINDER_LINK CANCELLED_MOVED
# <LANG> = EN HI AS BN OR (first wave; LUS MNI KHA GRT NE … later)
SMS_<MSG>_<LANG>_TEMPLATE=           # DLT template id
SMS_<MSG>_<LANG>_ENABLED=false       # the per-message, per-language switch
```

- Reused as they are: `SMS_API_BASE_URL`, `SMS_USERNAME`, `SMS_PASSWORD`, `SMS_FROM`, `SMS_PE_ID`, `SMS_COOKIE`
  (`config/config.ts:53-66`).
- Read from `process.env` on every call by `smsNotices/flags.ts` (the `assisted/flags.ts` pattern).
- 5c adds `SMS_VISIT_REMINDER_MINUTES_BEFORE`. 5d adds `SMS_JOIN_LINK_BASE_URL`, `JOIN_LINK_SECRET` and
  `SMS_JOIN_RATE_PER_MINUTE`.

#### 27.5.7 Routes (admins only)

`app.use('/api/v1/admin/sms-notices', authenticate, denyRoles('partner'), smsAdminRouter)` with `requireAdmin`,
mounted before the general admin mount (`routes/index.ts:127`).

| Route | Answer |
|---|---|
| `GET /api/v1/admin/sms-notices/summary` | `{ enabled, provider: { configured, unicode, noticesHeader }, pairs: [{ message, lang, enabled, templateSet, textFinal }], last24h: { sent, failed, queued, skipped: { <reason>: n } } }`. Booleans and counts only, never a secret |
| `GET /api/v1/admin/sms-notices?bookingKind&bookingId` | That booking's rows: `{ event, version, state, message, lang, attempts, reason, dueAt, sentAt, createdAt }` |
| `POST /api/v1/admin/sms-notices/test { message, lang, phone }` | Sends one text with fixed sample values to `phone` now, even while that pair's switch is off (to check a template before turning it on). 503 `SMS_NOTICES_DISABLED` when the master switch is off; 409 `SMS_TEMPLATE_NOT_SET`. Answer `{ ok, code? }`. Audited in `assisted_audit_events` (new action `sms.test_sent`, the phone stored as `throttleId`, `otp/throttle.ts:12`); 20 an hour per admin through `hit()` |

#### 27.5.8 Tests (`test/sms/phase5a.integration.ts` and units; gateway stub through `setSmsProvider`)

- **Double enqueue:** 10 parallel `enqueueSms` of one marker → one row. Again after `sent` → no new row.
- **Two drains at once** (`Promise.all`) over 20 rows → 20 gateway calls; each row `sent` once.
- **Lease:** a row left `sending` with an expired lease is claimed again; the old claim's outcome write is refused.
- **Retries:** two 5xx then success → `sent`, `attempts: 3`, due times + 2 and + 10 min. A 4xx → `failed` at once.
  Three failures → `failed`; two failed rows on one day → one `sms_failed` alert.
- **Gateway down:** every call times out → the tick stops after 3; the other rows keep `attempts: 0`. A stub that never
  answers is cut at `SMS_SEND_TIMEOUT_MS`.
- **Switches:** master off → no row. Master turned off with rows due → `skipped: switched_off`, no call. The `hi` pair
  off → English sent. Both off → `skipped: no_template`. Non-Latin text without the Unicode flag → skipped, no call.
  Template id missing → no call (no fallback).
- **Index missing** (dropped): the enqueue makes no row and does not throw; the drain does not tick.
- **Adapter**, against a local HTTP stub: the query (`to=91…`, `tmplId`, `peId`, `from`); the Unicode flag only for
  non-Latin text; the timeout; no throw.
- **No PII:** the logger is captured for the whole suite; no 10-digit number, rendered text, name or template id
  appears. The outbox rows hold none either.
- **Templates:** placeholder count per message; cleaning (digits, emoji and punctuation removed; cut at 30; empty → "your
  family member"); a rendered text equals its template with the values put in.

#### 27.5.9 Deploy and rollback

1. Deploy with `SMS_NOTICES_ENABLED` unset. 5a alone enqueues nothing.
2. `npm run sync-indexes` (the new `sms_notices`).
3. DLT (owner, §27.11): register the 35 templates from the repo text, English and Hindi first; the new header if one is
   chosen (Q1); the join address (5d).
4. If DLT changed any wording, commit the registered text before turning that pair on.
5. Stage: set `SMS_UNICODE_PARAM`, `SMS_NOTICES_FROM`, the template ids and `SMS_NOTICES_ENABLED=true`; one admin test
   send per pair to a staff phone; then the pair switches. Production only on the owner's word.

**Rollback.** `SMS_NOTICES_ENABLED=false` stops every notice at once (due rows become `skipped`). A pair switch stops one
message in one language. Older code ignores `sms_notices`.

### 27.6 Round 5b: the events at the hooks

#### 27.6.1 Events, versions and hooks

Helpers in `smsNotices/events.ts`: `smsBooked`, `smsRxReady`, `smsReportReady`, `smsCancelled`, `smsMoved`,
`smsMovedOff`. Each is one line at its hook, after the commit; each never throws and enqueues only for rows in scope
(§27.4). The `// SMS phase 5` comment at each hook is replaced by the call.

| Event → message | Version | Hook (after the commit) |
|---|---|---|
| `booked` → BOOKED (or BOOKED_LINK) | `1`; after an account move `move:<n>` (`n` = `assisted.moves.length`) | Wallet consultation, pharmacy or lab booker: `assisted/consultations.ts:335`. Card confirmation: `assisted/cardPayments.ts:136-145` (the follow-up runs again until done; the marker keeps one SMS). Instant accept: `doctors/services/instant.ts:682` @02b4a0e0. Pharmacy lab booking, wallet and card: `notifyLabBooked`, `assisted/labBookings.ts:264-273`. Lab desk, scheduled rows only: `assisted/labDesk.ts:250`. 3b's doctor lab create when it lands |
| `rx_ready` → RX_READY | `1`: the first save only | `specialistPortal/services/index.ts:404-413`, after the dispensing copy, for rows with `assisted` |
| `report_ready` → REPORT_READY | `1`: the first release only | `partners/services/labBookings.ts:1164-1171`, assisted and desk rows, when there was no release before |
| `cancelled` → CANCELLED_MOVED ("cancelled") | `1` | Consultations, every path through `afterAssistedCancel` (`assisted/pharmacyCommands.ts:313-347`): booker `:372`; patient or admin `bookings/services/index.ts:1572`; doctor or admin `:1628`; admin moved no-show `:1669`. Not when `by === 'patient'`; not when `unannounced` (`assisted/pharmacyCommands.ts:329`). Instant, doctor or admin cancel: `doctors/services/instant.ts:927` @02b4a0e0. Lab: reject `partners/services/labBookings.ts:639` (desk) and `:646` (assisted); admin moved no-show `:666`; booker cancel `:833` (not for an unpaid card row, `:832`); desk cancel `:861` |
| `moved` → CANCELLED_MOVED ("moved to <date> <time>") | The new start, epoch minutes | Booker move of a consultation: `assisted/pharmacyCommands.ts:420-431`. The booker accepts a lab's new time: `assisted/labBookings.ts:556-566`. The lab rebooks a no-show: `partners/services/labBookings.ts:944` |
| `moved_off` → CANCELLED_MOVED ("moved to another number") | `move:<n>`; `recipientUserId` = the previous holder | Admin account move: `assisted/review.ts:280-296` (consultations; replaces "SMS waits for phase 5", `:281`) and `:445-455` (lab bookings). The new holder gets `booked` `move:<n>` at the same place. Not for an unpaid card booking (`:287`) |

**No SMS** (the comment is replaced by a one-line reason):
- the holder cancelled in the app (`partners/services/labBookings.ts:605`; consultations `by === 'patient'`) or accepted
  a lab's new time in the app (`:759`): they did it themselves;
- a desk row the patient cancelled (`:599`, "none to the lab");
- a lab's **proposed** new time (`:751`): nothing has changed yet; the SMS goes once the booker accepts it;
- an unpaid card booking cancelled or expired: it was never announced (C7, §23.2);
- an instant request before acceptance (`assisted/instant.ts:233` @02b4a0e0).

#### 27.6.2 Send-time checks (the drain reads the booking again)

| Event | Sent only if | Otherwise |
|---|---|---|
| `booked` | Consultation `confirmed` and `paid`; lab `confirmed` or later and not cancelled; before the start (instant: within 60 min of acceptance) | `stale` |
| `rx_ready` | `hasPrescription` (`assisted/rxAccess.ts:83`) still true (an admin clear withdraws it); within 3 days of the enqueue | `stale` |
| `report_ready` | At least one release; within 3 days | `stale` |
| `cancelled` | `status: 'cancelled'`; within 1 day | `stale` |
| `moved` | Not cancelled; the current start equals the version; before it | `stale` (a later move has its own row) |
| `moved_off` | Within 1 day | `stale` |

The recipient is the booking's holder **at send time**, so a notice queued before an account move goes to the new
holder. Only `moved_off` goes to the previous one.

#### 27.6.3 `place` by booking and message

| Booking | booked | rx_ready | report_ready | reminder |
|---|---|---|---|---|
| Consultation, `join.on: 'partner_device'` | Booker name | Booker name | — | Booker name |
| Consultation, `join.on: 'patient_phone'` | Booker name | Booker name | — | "Jansetu app" |
| Consultation in person | Booker name | Booker name | — | "the clinic" (no clinic name: it can name a speciality) |
| Lab visit | Booker name (desk: lab name) | — | Lab name | Lab name |
| Home collection | Booker name (desk: lab name) | — | Lab name | "home" |

Names are cleaned as in §27.5.5; the fixed words are in `L`.

#### 27.6.4 Routes, switches, indexes, deploy

No new route, switch or index. A message starts in a language once its pair switch is on. Deploy, then turn the pairs
on. Rollback: as 5a.

#### 27.6.5 Tests (`test/sms/phase5b.integration.ts`)

- **Booking unaffected.** For each create path (pharmacy wallet consultation, card confirmation, lab-booker
  consultation, pharmacy lab booking, lab desk, instant accept), each cancel and each move, run with: SMS off; the
  gateway failing; the gateway hanging 10 s; the gateway succeeding; the outbox index dropped. The HTTP answers are equal
  (ids and times aside), the hanging gateway does not slow the answer (the drain sends later), and the booking documents
  are identical.
- **Double enqueue under races:**
  - two identical creates under one request key → one `booked`;
  - card verify, reconcile and the recovery sweep on one capture in parallel → one `booked`;
  - booker cancel and patient cancel racing → one `cancelled`, or none when the patient won;
  - two report releases → one `report_ready`; two prescription saves → one `rx_ready`.
- **Stale:** booked then cancelled before the tick → `booked` skipped, `cancelled` sent. Moved twice before the tick →
  the first `moved` skipped, the second sent. A prescription cleared by an admin → skipped.
- **Recipient:** an account move between enqueue and send → `booked` goes to the new holder; `moved_off` to the previous
  holder only.
- **Dispute:** a "not mine" report → later notices skipped `disputed`.
- **Out of scope:** a customer self-booking, a clinic desk booking and a legacy pharmacy booking enqueue nothing; an
  unpaid card booking cancelled or expired enqueues nothing.

### 27.7 Round 5c: visit reminders

- **Which bookings:** scheduled consultations (video, call, in person) and scheduled lab bookings (lab visit, home
  collection; assisted and desk). Not instant consultations, not desk walk-ins.
- **Enqueue.** `smsBooked` and `smsMoved` also enqueue `reminder`, version = the start in epoch minutes, with `dueAt`:
  1. the start − `SMS_VISIT_REMINDER_MINUTES_BEFORE` (default 120, allowed 30–1440);
  2. a due time between 21:00 and 07:00 India time moves back to the latest 20:00 before it;
  3. a due time less than 60 minutes from now → no reminder (the "booked" SMS has just gone).

  An account move needs no new row: the recipient is read at send time.
- **Start:** consultations `appointmentIntervalOf(b, slot).start` (`assisted/rxAccess.ts:30-36`, slot from `slotsOf`);
  lab bookings `slot.startsAt`.
- **Send-time:** consultation `confirmed` and `paid`, lab `confirmed`; the current start equals the version; now is
  before the start; no open dispute. Otherwise `stale`. REMINDER_LINK under the 5d rule.
- The customer in-app reminders (`bookings/services/bookingReminderScheduler.ts:36-80`) are unchanged.
- **`.env`:** `SMS_VISIT_REMINDER_MINUTES_BEFORE=120`; the pairs `SMS_REMINDER_<LANG>_*` and `SMS_REMINDER_LINK_<LANG>_*`.
- **Tests:**
  - due times: a 10:00 slot → 08:00; a 07:30 slot → 20:00 the evening before; a 23:30 slot → 20:00 the same day;
  - booked 50 minutes before the slot → no reminder; never sent before `dueAt`;
  - a move → the old reminder `stale`, the new one sent; a cancel → `stale`;
  - two enqueues of one reminder in parallel → one row;
  - instant consultations and desk walk-ins → none.
- **Deploy:** deploy, set the minutes, turn the REMINDER pairs on. Rollback: the pairs.

### 27.8 Round 5d: join links and `/j/`

#### 27.8.1 The token (`smsNotices/joinLink.ts`; §6.6)

- `token` = `<ref>-<mac>`, 29 characters, `^[A-Z2-7]{8}-[A-Z2-7]{20}$`.
- `ref` = `assisted.shortRef`.
- `mac` = the first 100 bits of `HMAC-SHA256(JOIN_LINK_SECRET, bookingId + ':' + assisted.join.linkVersion)`, RFC 4648
  base32, upper case, no padding. Nothing is stored.
- `linkVersion` already exists. The admin account move bumps it (`assisted/review.ts:247`). A booker move does not, and
  the window follows the current slot (§6.6). A cancelled booking fails the status check, so a cancel needs no bump.

#### 27.8.2 Link variants

BOOKED_LINK and REMINDER_LINK are candidates only when all hold:
- a consultation with `consultationMode: 'video'` and `assisted.join.on: 'patient_phone'`;
- `JOIN_LINK_SECRET` (at least 32 bytes) and `SMS_JOIN_LINK_BASE_URL` (`https://…/j`) are set.

The link goes to the account phone like every notice, never to `join.phone` (SM15). The app's Join stays the first way
in.

#### 27.8.3 The route

`GET /j/:token` and `HEAD /j/:token`, mounted at the root in `configureRoutes` (no `/api/v1`, no sign-in):
1. **Limit per IP:** `hit('join-ip', throttleId('ip|' + req.ip), [{ seconds: 60, max: SMS_JOIN_RATE_PER_MINUTE }])`
   (`otp/throttle.ts:12`, `:41-50`). Behind the proxy it needs `TRUST_PROXY` (`src1/index.ts:33-34`). Over the limit →
   429 with the page and `Retry-After`. Counter store error → 503 with the page.
2. Wrong token shape → the page.
3. `BookingModel.findOne({ 'assisted.shortRef': ref })` on the existing unique index, minimal fields.
4. The MAC is compared with `crypto.timingSafeEqual` on equal-length buffers.
5. It redirects only if all hold:
   - `status: 'confirmed'`, `paymentStatus: 'paid'`, video, `join.on: 'patient_phone'`, no open dispute;
   - the doctor is eligible (`doctorExistsIneligible`, `specialists/eligibility.ts:125`);
   - `virtualMeeting.status: 'active'` with an `https://meet.google.com/` `joinUrl`;
   - now is inside the window. Scheduled: from the start − 10 min to the end (`appointmentIntervalOf`, as
     `assisted/bookerView.ts:118-123`). Instant: from the acceptance to the later of + 60 min and the last extension.
6. Yes → 302 to the `joinUrl`. No → the page.

Every answer that is not a redirect, a 429 or a 503 is **the same page with status 200**: unknown, wrong, early, late,
cancelled, moved account. The page, in English and Hindi: "This Jansetu link is not open now. It opens 10 minutes
before the booked time. You can also sign in to the Jansetu app with this mobile number and tap Join." Every answer
carries `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`.

**Logs.** The request logger (`src1/index.ts:64-70`) prints `/j/:token` instead of the path. The route logs
`{ outcome: 'redirect' | 'closed' | 'limited' }` only.

#### 27.8.4 `.env`, deploy and rollback

```
SMS_JOIN_LINK_BASE_URL=          # e.g. https://<domain>/j, exactly the address in the registered link templates
JOIN_LINK_SECRET=                # 48 random bytes, base64; changing it kills every link already sent
SMS_JOIN_RATE_PER_MINUTE=30      # NEW: /j/ requests per IP per minute
```

**Deploy:**
1. deploy;
2. route `/j/` on the link domain to the API (nginx `location /j/`), and set `TRUST_PROXY` if it is not set;
3. set `JOIN_LINK_SECRET` and `SMS_JOIN_LINK_BASE_URL`;
4. whitelist the address on DLT (TRAI blocks SMS whose URL is not whitelisted) and register the `_LINK` templates;
5. turn the `_LINK` pairs on.

**Rollback:** the `_LINK` pairs (sends fall back to the plain message). With the secret unset the route answers the page.

#### 27.8.5 Tests (`test/sms/phase5d.integration.ts`)

- The token is 29 characters, stable for a booking, and changes with `linkVersion`.
- Inside the window → redirect. 11 minutes before, after the end, after a cancel → the page. An unknown ref, a wrong
  MAC and an early visit get the same body and status.
- Admin account move: the old token gets the page, the new one redirects. Booker move: the same token works and the
  window follows the new slot.
- `partner_device`, call and in-person bookings never redirect; an ineligible doctor → the page.
- The 31st request in a minute from one IP → 429; another IP is not affected; with `TRUST_PROXY` the client IP counts.
- The logger output never holds the token; the route logs only the outcome.
- Variant choice: `_LINK` only when eligible and its pair is on; otherwise the plain message in the same language.
- HEAD answers as GET, without a body.

### 27.9 The records-access code: the seam only (§10.6, §25.9.4)

- 3f's `RecordsCodeSender` is a replaceable hook, "unavailable" in phase 3 (§25.9.4).
- 5a supplies what it needs: `smsProvider()` and the renderer, with the §10.6 text in the template files as message
  `RECORDS_CODE`, switched by `SMS_RECORDS_CODE_<LANG>_TEMPLATE` and `SMS_RECORDS_CODE_<LANG>_ENABLED`, **independent
  of `SMS_NOTICES_ENABLED`**.
- The code is sent at once, not through the outbox, because the doctor is waiting. A failure only means no approval;
  `channels.sms` is `true` only when the gateway accepted it.
- Making the code, storing its HMAC and setting the sender are a small 3f follow-up after 5a merges, not a phase 5
  round. This replaces DR21's "wired in phase 5".

### 27.10 ASSUMED (reversible)

| # | Assumption (the safer default) | Where |
|---|---|---|
| SM1 | One outbox collection, `sms_notices`: a row is both the job and the marker. It replaces §10.4's `Job` + `sms_notices_sent` | §27.5.1 |
| SM2 | Enqueue after the commit, best effort: a crash between the commit and the enqueue loses that SMS. Card confirmations run their follow-up again, so theirs is not lost | §27.5.2 |
| SM3 | At least once: a crash between the gateway's answer and the outcome write can resend after the 60 s lease | §27.5.3 |
| SM4 | Text, recipient, language and variant are decided at send time from the fresh booking; the outbox holds no personal data | §27.5.3 |
| SM5 | The pair switch `SMS_<MSG>_<LANG>_ENABLED` is both the per-message and the per-language switch; the master switch stops everything | §27.5.6 |
| SM6 | Language before link: the link in the patient's language, then the plain message in it, then the same two in English | §27.5.5 |
| SM7 | Non-Latin text is skipped until `SMS_UNICODE_PARAM` is set, so no SMS arrives garbled | §27.5.3 |
| SM8 | 3 attempts with back-off 2 and 10 min; a 4xx is final; one `sms_failed` alert a day; a tick stops after 3 failures in a row | §27.5.3 |
| SM9 | Master off: nothing is enqueued and due rows are skipped, so turning it on later never sends old notices | §27.4 |
| SM10 | No SMS for what the holder did in the app, for a lab's proposed time (only once accepted), or for unpaid card bookings | §27.6.1 |
| SM11 | An open "not mine" report stops later notices to that number | §27.6.2 |
| SM12 | Variables: first name only; `DD-MM-YYYY` and 24-hour `HH:mm` with Latin digits; `place` by §27.6.3; a desk row's Ref is the last 8 characters of its id | §27.5.5 |
| SM13 | Stale limits: booked until the start; prescription and report 3 days; cancelled and moved 1 day. Prescription ready on the first save only; report ready on the first release only | §27.6.2 |
| SM14 | Reminder 120 min before; 21:00–07:00 moves to 20:00 the evening before; none within 60 min of now; none for instant consultations and desk walk-ins | §27.7 |
| SM15 | The join link goes to the account phone, never to `join.phone` | §27.8.2 |
| SM16 | `/j/`: one page (status 200) for every closed outcome, in English and Hindi; 429 or 503 otherwise; the limit uses the OTP counter store | §27.8.3 |
| SM17 | Admin account move: the old number gets "moved to another number", the new number "booked" | §27.6.1 |
| SM18 | Hindi, Assamese, Bengali and Odia texts ship as drafts; a language is sent only once its registered text is in the repo | §27.5.5 |
| SM19 | Outbox rows are kept 180 days after they finish | §27.5.1 |
| SM20 | The gateway that sends sign-in codes is the one provider; sign-in codes, bills and member-email SMS are unchanged | §27.5.4 |
| SM21 | No cap on SMS per number (owner: no limits except lookups) | §27.4 |
| SM22 | An admin test send (audited, 20 an hour per admin) checks each template before its switch goes on | §27.5.7 |

### 27.11 Questions for the owner (only the ones that change what is built)

1. **Which SMS account and sender name should the notices use?**
   Recommended: the gateway account that already sends sign-in codes, with a **new 6-letter sender name (header) for
   Jansetu** under the same DLT entity (PE id), so the sender matches the "Jansetu" in every message. Until it is
   approved, notices use the current header.
2. **Which web address should the video link use (`https://<domain>/j/<code>`)?**
   Recommended: the customer web domain patients already see, with `/j/` sent to the API. It must be whitelisted on DLT.
3. **When should the reminder go?**
   Recommended: 2 hours before the visit. When that falls between 9 pm and 7 am, at 8 pm the evening before (early home
   collections). One reminder per visit.
4. **Should patients who book for themselves in the app also get these SMS?**
   Recommended: not now. Phase 5 covers partner-made and lab desk bookings, for people who often have no app.
   Self-bookers keep their app notices. Revisit once the monthly SMS cost is known.
5. **Who writes the Hindi, Assamese, Bengali and Odia texts?**
   Recommended: the phase 6 translator with a native-speaker check, for these 7 short messages first (28 texts).
   Register English and Hindi first so SMS can start; the others follow. A Hindi message is about 3 SMS parts, so it
   costs about 3 times an English one.

**`.env` values the owner must supply** (from the gateway account and the DLT portal; the operator sets everything
else):

| Variable | What |
|---|---|
| `SMS_API_BASE_URL`, `SMS_USERNAME`, `SMS_PASSWORD`, `SMS_FROM`, `SMS_PE_ID` (`SMS_COOKIE` only if the gateway needs it) | Already set for sign-in codes: confirm this is the account to use |
| `SMS_NOTICES_FROM` | The new Jansetu header once approved (Q1); empty until then |
| `SMS_UNICODE_PARAM` | The gateway's Unicode flag as `name=value`, from its API documentation |
| `SMS_<MSG>_<LANG>_TEMPLATE`, 35 values | DLT template ids for `BOOKED`, `BOOKED_LINK`, `RX_READY`, `REPORT_READY`, `REMINDER`, `REMINDER_LINK`, `CANCELLED_MOVED` × `EN`, `HI`, `AS`, `BN`, `OR` |
| `SMS_JOIN_LINK_BASE_URL` | The whitelisted link address (Q2), e.g. `https://<domain>/j` |
| Later, for 3f: `SMS_RECORDS_CODE_<LANG>_TEMPLATE`, 5 values | The §10.6 security message per language |

The operator generates `JOIN_LINK_SECRET` and sets the switches on the owner's word.

### 27.12 Round 5a build record (r25, 2026-11-25)

Branch `m0/r25-phase5a` from `m0/r19-stage-next` (`2273b88a`: r10h, 2b, 2c, 2d, 3d and their review fixes) with
`m0/r23-phase5-spec` merged. Local commits only. Built: §27.5. Suite: `test/assisted/r25-phase5a.integration.ts`
(11 checks).

**Q1–Q5 (owner asleep, coordinator 25 Nov).** The recommended answers of §27.11 are used as ASSUMED (reversible) and stay
open for the owner: Q1 the existing gateway account, with a new Jansetu header (`SMS_NOTICES_FROM` empty until it is
approved); Q2 the customer web domain for `/j/`; Q3 2 hours before, 20:00 the evening before in quiet hours; Q4 no SMS
for self-bookings; Q5 the phase 6 translator, English and Hindi registered first. Only Q1 and Q5 touch 5a.

#### 27.12.1 What was built

| Part | Where | Notes |
|---|---|---|
| Outbox | `smsNotices/model/index.ts` | `sms_notices` as §27.5.1. Also records admin test sends (`bookingKind: 'admin_test'`, `event: 'test'`) |
| Enqueue | `smsNotices/outbox.ts` `enqueueSms` | As §27.5.2: never throws, never sends; nothing without the unique index |
| Composers | `smsNotices/outbox.ts` `setSmsComposer(event, fn)` | What an event's SMS says, decided at send time. 5b registers one per event; 5a registers none, so a row would be skipped `no_composer` (5a has no hooks: nothing is queued in production) |
| Drain | `smsNotices/drain.ts` `drainSmsOnce`, `runSmsNoticeScheduler` (started in `src1/index.ts`) | As §27.5.3 |
| Sender | `smsNotices/provider.ts` | `SmsProvider`, the one implementation `gatewayProvider`, `sendBounded` (the timeout), `setSmsProvider` (tests) |
| Shared gateway request | `sms/services/index.ts` `gatewayRequest`, `gatewayConfigured` | `SMSService.sendSMS` builds the same request as before: same keys, order, header and fallbacks (sign-in template, PE id). The suite compares it byte for byte with the code before 5a |
| Templates | `smsNotices/templates.ts` | The English texts of §10.2 and §10.6 (`RECORDS_CODE` for 3f) |
| Switches | `smsNotices/flags.ts` | §27.5.6, read on every call |
| Shared helpers | `common/utils/lease.ts` (`freeLease`, `withDeadline`) | Also used by `meet/retry.ts` and `assisted/cardPayments.ts` (their own copies removed) |
| Admin | `smsNotices/admin.ts`, mounted at `/api/v1/admin/sms-notices` | Summary and test send |

#### 27.12.2 Choices made while building (ASSUMED r25, reversible)

1. **Named variables.** The repo text writes each variable with its name (`{#name#}`), so every language keeps its own
   word order. The DLT text is derived (each becomes `{#var#}`) and shown in the summary for registration.
2. **English only in the code.** Hindi, Assamese, Bengali and Odia are added once their registered text exists, instead
   of drafts in the repo (no unreviewed translation in the code). Until then a notice in those languages falls back to
   English (SM6).
3. **`attempts` counts claims.** Each claim makes at most one gateway call.
4. **No "refused 2xx" class yet.** Every 2xx counts as sent until a stage send shows the gateway's refusal shape
   (§27.5.4).
5. **Test sends** are recorded as `admin_test` rows (the admin's id, no phone), because `assisted_audit_events` needs an
   organisation. Refused requests (400, 409, 503) do not count towards the 20 an hour.
6. **The per-booking admin read** (`GET /admin/sms-notices?bookingKind&bookingId`) moves to 5b, when rows exist.
7. **`last24h`** in the summary scans the rows created in the last 24 hours (no `createdAt` index; admins only).
8. **The drain checks the unique index only while the master switch is on.** With it off it only marks due rows
   `skipped: switched_off`.
9. **Settings** are read from `process.env` by `smsNotices/flags.ts`; nothing is added to `CONFIG`.

#### 27.12.3 API for the web (admin screens)

- `GET /api/v1/admin/sms-notices/summary` → `{ enabled, provider: { configured, unicode, noticesHeader, joinBase },
  pairs: [{ message, lang, enabled, templateSet, dltText }], last24h: { queued, sending, sent, failed, skipped:
  { <reason>: n } } }`. `pairs` covers the 8 messages (the 7 notices and `RECORDS_CODE`) × `en hi as bn or`; `dltText`
  is `null` where the repo has no text yet. Booleans and counts only: never a secret, a template id or a phone number.
- `POST /api/v1/admin/sms-notices/test { message, lang, phone }` → `{ ok: true }` or `{ ok: false, code }` (`timeout`,
  `network`, `http_5xx`, `http_429`, `http_4xx`). It sends even while that pair's switch is off. Errors: 400
  `VALIDATION_ERROR`; 403 `FORBIDDEN` (not an admin); 409 `SMS_TEMPLATE_NOT_SET` (no id or no text in that language);
  429 `SMS_TEST_LIMIT` (20 an hour per admin); 503 `SMS_NOTICES_DISABLED`, `SMS_PROVIDER_NOT_CONFIGURED`.

#### 27.12.4 Switches, indexes, deploy, rollback

- **Switches** as §27.5.6, all off. `SMS_SEND_TIMEOUT_MS` 1–20000 (default 5000); `SMS_NOTICE_MAX_ATTEMPTS` 1–10
  (default 3).
- **Indexes:** `sms_notices` (the unique key, `{ state, dueAt }`, TTL `expireAt`). Run `npm run sync-indexes`.
- **Deploy:** as §27.5.9. With 5a alone nothing is queued; the test send works once the master switch, a template id
  and the gateway are set.
- **Rollback:** `SMS_NOTICES_ENABLED=false`. Rolling the code back is safe: the collection is ignored and sign-in SMS is
  unchanged.

#### 27.12.5 Checks

`test/assisted/r25-phase5a.integration.ts`, 11 checks:
1. sign-in code SMS unchanged: the same text, and byte for byte the same gateway request as the code before 5a
   (fallbacks included); the notices header never reaches it; unconfigured still throws;
2. the notice sender: request shape, notices header, no template fallback, Unicode flag only for non-Latin text, each
   gateway answer classified, never a throw;
3. double enqueue: 10 at once → one row; again after it was sent → one row, one SMS;
4. two drains at once over 20 rows → 20 gateway calls, each row sent once;
5. a row under a live lease is left alone; once the lease is past it is taken over and sent once;
6. retry and give-up: 5xx back after 2 then 10 minutes; the third failure is final with one alert for the day; a 4xx is
   final at once; success after two failures;
7. a gateway that hangs (or a sender that ignores its signal) is cut at the timeout; a tick stops after 3 failures in a
   row; rows it did not claim keep 0 attempts;
8. switches and recipients: master off, pair off (English fallback, then `no_template`), no template id (no call),
   Unicode flag, no phone, inactive account, stale, no composer, gateway not configured;
9. a missing index, a refused write or a dropped collection never affects a committed booking; the drain does not run
   without the index;
10. admin summary and test send;
11. no phone number, text, template id or secret in any log line or outbox row.

**Mutation check.** Each of these, undone alone, makes its check fail: the enqueue's index check (9), the claim's lease
(4, 5), the stop after 3 failures in a row (7), the sign-in template fallback in `sendSMS` (1).

**Full regression** (`prun.sh … 2` on `7b80c1ca`, on a machine running seven other regressions): 74 entries, 72 passed.
Neither of the other two is a regression:
- `r25-phase5a` (checks 4 and 5): the run copied the worktree while the lease mutation above was in it (its copy of
  `smsNotices/drain.ts` was checked and lacked the lease). The same copy explains `tsc 18` there (the unused import).
  On the real code: 11 of 11, and `tsc` 17 as before.
- `o1-otp-limits`: its `Retry-After > 30` check ran within 30 seconds of the top of the hour. Run again: 14 of 14.

The suites that cover the shared changes were also run on the final head, all passing: `r10g-meet-retry`,
`r10f-card-last`, `r10-phase1b`, `r14-phase2b` (lease and deadline helpers), `q16b-identity`, `q2-invoices` and
`o1-otp-limits` (the SMS service).

### 27.13 Round 5b build record (r31, 2026-11-25)

Branch `m0/r31-phase5b` from the stage head `6a8574e9` (`m0/r28-stage-next-3`: 5a, 4a/4b, 3b and 2e merged). Local
commits only. Built: §27.6, with the owner's answers of 25 Nov (Q1 the same gateway account, a new "Jansetu" header in
`SMS_NOTICES_FROM`, empty until approved; Q4 partner-made and lab desk bookings only; English now, the other first-wave
languages once registered). Suite: `test/assisted/r31-phase5b.integration.ts` (19 checks). Nothing is sent until the
master switch and a message's English pair are on (§27.13.5).

#### 27.13.1 What was built

| Part | Where | Notes |
|---|---|---|
| Hooks | `smsNotices/events.ts`: `smsBooked`, `smsRxReady`, `smsReportReady`, `smsCancelled`, `smsMoved`, `smsMovedOff` | One line at each hook, after the commit, called with `void` (r31b: fire and forget, no added latency). Never throw; read nothing while `SMS_NOTICES_ENABLED` is off; queue only rows in scope (below) |
| Composer | `smsNotices/events.ts` `compose`, registered by `registerSmsComposers()` (`src1/index.ts`, before the drain starts) | One function for every event and both booking kinds: reads the booking again, checks the event (§27.6.2), builds the variables (§27.5.5, §27.6.3) |
| Scope | `inScope` in `events.ts` | A consultation with an `assisted` block (instant ones too), a partner-made lab booking, a lab desk row. Never a customer's own booking, a clinic desk booking, a legacy pharmacy booking or an unpaid card booking. A desk walk-in only hears of its report (and of an account move) |
| Fixed words | `smsNotices/templates.ts` `wordsFor(lang)` | Service names, "cancelled", "moved to", "moved to another number", "your family member"; English only (other languages fall back with their texts) |
| Values by language | `smsNotices/outbox.ts` | A composition's values may be made for the language of the text chosen, so its fixed words always match the template sent |
| Shared origin | `assisted/deskViews.ts` `partnerOriginOf` | Moved from `assisted/review.ts` (`labOrigin`), unchanged; the account move and the notices read the same Ref, dispute, moves and language |
| Admin read | `GET /api/v1/admin/sms-notices?bookingKind&bookingId` (`smsNotices/admin.ts`) | Moved here from 5a (§27.12.2 item 6). `[{ event, version, state, message, lang, attempts, reason, dueAt, sentAt, createdAt }]`, oldest first; 400 `VALIDATION_ERROR` for a bad query; admins only |

#### 27.13.2 The hooks (`file:line` at the r31 head)

| Event (version) | Path | Hook |
|---|---|---|
| `booked` (`1`) | Pharmacy (1a) and lab (2e) consultation, wallet | `assisted/consultations.ts:356` |
| | The same, card confirmation (1b, 2e); the follow-up runs again until done, the marker keeps one | `assisted/cardPayments.ts:149` |
| | Pharmacy lab booking, wallet (2a) and card confirmation (2b); doctor lab booking, wallet (3b) and card (3c, r29) | `notifyLabBooked`, `assisted/labBookings.ts:304` |
| | Lab desk, rows with a slot (2c) | `assisted/labDesk.ts:258` |
| | Partner Consult now: the doctor accepts (3e) | `doctors/services/instant.ts:706` |
| `rx_ready` (`1`) | The doctor's first prescription save (no doctor's prescription before it) | `specialistPortal/services/index.ts:417` |
| `report_ready` (`1`) | The lab's first report release (partner-made and desk rows) | `partners/services/labBookings.ts:1200` |
| `cancelled` (`1`) | Every consultation cancel through `afterAssistedCancel` (booker; doctor; admin; admin close; admin cancel of a moved no-show), not when the patient cancelled and not when unannounced | `assisted/pharmacyCommands.ts:352` |
| | Partner Consult now, doctor or admin cancel | `doctors/services/instant.ts:953` |
| | Lab reject (partner-made and desk rows) | `partners/services/labBookings.ts:657` |
| | Admin cancel of a moved lab no-show | `partners/services/labBookings.ts:720` |
| | The booker cancels its lab booking (never an unpaid card row) | `partners/services/labBookings.ts:858` |
| | The lab desk cancels a desk row | `partners/services/labBookings.ts:885` |
| `moved` (`<new start, epoch minutes>:<the move's write, epoch ms>`, r31b) | The booker moves a consultation | `assisted/pharmacyCommands.ts:438` |
| | The booker accepts a lab's new time | `assisted/labBookings.ts:665` |
| | The lab rebooks a no-show | `partners/services/labBookings.ts:968` |
| | The doctor or an admin moves a consultation's no-show (r31, ASSUMED 5) | `bookings/services/index.ts:1751` |
| | An admin moves a consultation (r31, ASSUMED 5) | `bookings/services/index.ts:1868` |
| `moved_off` + `booked` (`move:<n>`) | The admin account move: consultations, lab bookings | `assisted/review.ts:326`, `:483` |

**No SMS** (each with its one-line reason in the code): the patient cancels in the app (consultations `by === 'patient'`;
lab `partners/services/labBookings.ts:617`, `:623`); the patient accepts a lab's new time (`:788`); a lab's proposal
(`:771`); an unpaid card booking cancelled or expired; an instant request before acceptance (`assisted/instant.ts:233`).

#### 27.13.3 The English texts to register on DLT

Each is the text of `smsNotices/templates.ts` with every variable written `{#var#}` (the admin summary shows the same
`dltText`). Every variable is at most 30 characters; dates are `DD-MM-YYYY`, times 24-hour `HH:mm`, India time.

**BOOKED** (`SMS_BOOKED_EN_TEMPLATE`, `SMS_BOOKED_EN_ENABLED`)

```
Jansetu: {#var#}'s {#var#} is booked for {#var#} at {#var#} via {#var#}. Ref {#var#}. Sign in to the Jansetu app with this number for details.
```
Variables in order: patient's first name; service; date; time; place; Ref. Sample: `Jansetu: Rina's video consultation
is booked for 01-12-2026 at 10:30 via Sharma Medicals. Ref ABCD2345. Sign in to the Jansetu app with this number for details.`

**RX_READY** (`SMS_RX_READY_EN_TEMPLATE`, `SMS_RX_READY_EN_ENABLED`)

```
Jansetu: the prescription for {#var#} from the consultation on {#var#} is ready. Sign in to the Jansetu app with this number, or ask {#var#}.
```
Variables: first name; consultation date; the partner that booked. Sample: `Jansetu: the prescription for Rina from the
consultation on 01-12-2026 is ready. Sign in to the Jansetu app with this number, or ask Sharma Medicals.`

**REPORT_READY** (`SMS_REPORT_READY_EN_TEMPLATE`, `SMS_REPORT_READY_EN_ENABLED`)

```
Jansetu: the lab report for {#var#} from {#var#} ({#var#}) is ready. Sign in to the Jansetu app with this number to see it.
```
Variables: first name; test date; lab name. Sample: `Jansetu: the lab report for Rina from 01-12-2026 (Metro Labs) is
ready. Sign in to the Jansetu app with this number to see it.`

**CANCELLED_MOVED** (`SMS_CANCELLED_MOVED_EN_TEMPLATE`, `SMS_CANCELLED_MOVED_EN_ENABLED`)

```
Jansetu: {#var#}'s {#var#} has been {#var#}. Sign in to the Jansetu app with this number for details.
```
Variables: first name; service; what. Samples: `… Rina's lab test has been cancelled. …`, `… Rina's video consultation
has been moved to 05-12-2026 11:00. …`, `… Rina's phone consultation has been moved to another number. …`

**Values the variables take** (English): service `video consultation`, `phone consultation`, `clinic consultation`,
`lab test`, `home sample collection`; what `cancelled`, `moved to <DD-MM-YYYY> <HH:mm>`, `moved to another number`;
a name with nothing left after cleaning → `your family member`; an empty place → `Jansetu`. Place: the pharmacy's or
lab's name that booked (booked, prescription ready); the lab's name for a desk row, for a lab test a doctor booked and for
every report. The `_LINK` and `REMINDER` texts are 5c/5d.

#### 27.13.4 Choices made while building (ASSUMED r31, reversible)

1. **Desk walk-ins** (tested on arrival) get no "booked", "cancelled" or "moved"; their report-ready SMS is sent.
2. **A lab test a doctor booked (3b) names the lab**, never the doctor (§10.2: no doctor names in an SMS).
3. **"Moved to another number" uses the previous holder's own account name**, so nothing of the new holder reaches the
   old number. The new holder's "booked" names the patient as the booking now does (a lab booking keeps the name the
   partner typed).
4. **"Booked" is the current holder's only.** A "booked" still queued when an account move happens is `stale`; the move
   queues the new holder's own (`move:<n>`), so nobody gets it twice.
5. **Two more "moved" hooks than §27.6.1 lists**: the doctor's or an admin's move of a consultation's no-show (the
   counterpart of the lab's, which §27.6.1 lists) and an admin's move of a consultation. Both pass through the same scope,
   so customer bookings are untouched.
6. **An instant consultation cancelled by the doctor or an admin gets "cancelled"** (§27.6.1 over §10.2's "booked only").
7. **Lab cancels of desk rows** (reject, desk cancel, admin cancel of a moved no-show) send "cancelled" like
   partner-made rows.
8. **Name cleaning removes** digits, punctuation and emoji (`O'Brien` → `OBrien`), then takes the first word.
9. **"First"** is read on the booking before the change: no doctor's prescription before the save; no release before the
   release (read outside the release's transaction). Racing saves or releases both queue `1`; the marker keeps one.
10. **A lab "booked" is still true** from `confirmed` to `completed` before the slot starts; a consultation's while
    `confirmed` and `paid` before its start (an instant one: for an hour after acceptance).
11. **No new switch, route (besides the admin read) or index.** The four English pairs above are the switches.

#### 27.13.5 Switches, deploy, rollback

- **Switches** (all off): `SMS_NOTICES_ENABLED`; `SMS_<MSG>_EN_TEMPLATE` and `SMS_<MSG>_EN_ENABLED` for `BOOKED`,
  `RX_READY`, `REPORT_READY`, `CANCELLED_MOVED`. `SMS_NOTICES_FROM` stays empty until the Jansetu header is approved
  (notices then use `SMS_FROM`).
- **Deploy:** no new index (5a's `sync-indexes` covers it). Register the four texts of §27.13.3 on DLT; set their ids;
  one admin test send each (`POST /admin/sms-notices/test`); then the master switch and the four pairs.
- **Rollback:** `SMS_NOTICES_ENABLED=false` (due rows become `skipped: switched_off`); a pair switch stops one message.
  Older code ignores the rows.

#### 27.13.6 Checks

`test/assisted/r31-phase5b.integration.ts`, 19 checks (a fake gateway through `setSmsProvider`):
1–7. one "booked" row per create path, the exact text and template: 1a (a replay and three racing identical creates add
   none), 1b (nothing while unpaid; verify and reconcile racing → one), 2e, 2a/2b (a family member's name; `kha` falls
   back to English), 2c (a walk-in: none), 3b (the lab, never the doctor), 3e (nothing before acceptance; the doctor's
   cancel → "cancelled");
8. prescription ready: two racing first saves → one; a later save → none; withdrawn before the tick → `stale`;
9. report ready: two racing first releases → one; partner-made, desk and walk-in rows;
10. cancelled: booker, doctor, admin, lab reject (partner-made and desk), booker lab cancel, desk cancel; repeats none;
11. moved: booker move (version = the new start), the booker's accept of a lab's time (the proposal sends nothing), the
    lab's no-show rebook (its replay adds none);
12. stale at send: booked then cancelled → "booked" skipped; moved twice → the first skipped;
13. account move: "moved to another number" to the old number with its own name; "booked" `move:1` to the new number;
    the old queued "booked" stale;
14. no SMS: the patient cancels (consultation, lab) or accepts a new time in the app; a lab proposal; unpaid card
    bookings cancelled; a customer's own booking;
15. not mine: later notices `disputed`; the move's "moved to another number" still sent;
16. SMS on and off: the same answers and stored bookings (consultation create, move, cancel; lab create, cancel; desk
    create); off → nothing queued;
17. a hanging gateway is never called by a request (the drain cuts it and retries); a missing outbox index queues
    nothing and the booking still answers 201;
18. the admin per-booking read;
19. no phone number, name, text or template id in any outbox row or log line.

**Mutation check.** Each of these, undone alone, makes its check fail: the "not when the patient cancelled" guard
(14), the walk-in rule (2c, and the checks after it, which then meet the walk-in's extra row), the `disputed` skip (15),
the current-holder rule of "booked" (13), the "confirmed and paid" test of "booked" (12). Queuing the prescription
notice twice per save changes nothing (the marker), so "first" is a cost saving there, not a correctness guard.

**Full regression** (`prun.sh … 2` on `ddf6aacc`): 81 entries, 81 passed (`r25-phase5a` and `r31-phase5b` among them),
`tsc` 17 as before.

#### 27.13.7 Review follow-ups (r31b, 2026-11-25)

The r31 review (Opus xhigh) found it safe for stage with no must-fix. Merged `origin/stage` (`88e152ed`: r29, phase 3c
doctor card lab bookings and the "Jansetu" prescription heading) without conflict: a doctor's card lab booking is
confirmed through the same lab follow-up, so `notifyLabBooked` queues its "booked" too. Then the two later items:

1. **A move back to an earlier time is told.** The "moved" version was the new start alone, so B → C → B was silent
   (the key `(moved, B)` already existed). It is now `<new start, epoch minutes>:<the move's write, epoch ms>`
   (`moveVersionOf`, `smsNotices/events.ts`): every move writes the booking, so every move has its own key, and phase
   5 still stores nothing on a booking. At send time a "moved" is true while the booking still starts at that time,
   before it, not cancelled, **and no later "moved" row exists for the booking** (`stillTrue`), so several moves before
   one tick send only the latest (C → D → C: one SMS, the earlier two `stale`).
2. **Hooks are fire and forget.** Every hook call is `void smsX(...)`: a request never waits for the outbox (they never
   throw). `smsHooksSettled()` waits for the enqueues still running (the suite reads the outbox after it).
   Consequence for SM2: a card confirmation's follow-up may now finish a few milliseconds before its enqueue, so a crash
   in that window loses that SMS like any other (best effort); the marker still keeps one when the follow-up runs again.

**Checks.** The suite has 20 checks: the new one moves a consultation B → C (sent), back to B (its own row, sent), then
C → D → C before one tick (one SMS, the latest); and a 3 s outbox insert no longer delays an answer (answered before it
ends, the row queued after). Mutations: the old minutes-only version fails the new check; dropping the "latest move"
rule fails it; awaiting a hook again fails the slow-outbox check.

**Single suites** on `c962a415` (own mongod): `r31-phase5b` 20/20, `r25-phase5a` 11/11, `r29-phase3c` 21/21,
`r26-phase3b` 14/14, `r21-phase2e` 18/18, `r14-phase2b` 24/24, `r10-phase1b` 19/19, `r10b-phase1b-fixes` 23/23. `tsc` 17.

**Full regression** (`prun.sh … 2` on `3007027f`): 82 entries, 82 passed (`r29-phase3c` and `r31-phase5b` among them),
`tsc` 17.

**Stage merge 2** (`622912a7`: r33 referral gaps, r30 phase 3f). The only conflict was the imports of
`bookings/services/index.ts`; both are kept. 3f's read-then-cancel alert (`alertReadThenCancelIn`) stays inside the
transactions of `cancelBookingSettlement`, `cancelAccepted` and `markNoShow`; the `void sms…` hooks stay after the
commit. Single suites on the merge (`ce2d108b`, own mongod): `r31-phase5b` 20/20, `r30-phase3f` 22/22, `r25-phase5a`
11/11, `r29-phase3c` 21/21, `r26-phase3b` 14/14, `q16a-bookings-money` 41/41, `q4b-instant` 25/25. `tsc` 17.

### 27.14 Rounds 5c and 5d build record: visit reminders and the SMS video link (r34, 2026-11-25)

Branch `m0/r34-phase5cd` from `ea5d1cf0` (`m0/r31-phase5b` with stage `88e152ed` merged). Local commits only. Built §27.7
and §27.8 with SM14–SM16 and the owner's answers: a reminder 2 hours before the visit, at 20:00 the evening before when
that falls in the night, one per visit; the link only where the patient joins video on their own phone. Suite:
`test/assisted/r34-phase5cd.integration.ts` (13 checks). Nothing is sent and no link opens until the switches below are on.

#### 27.14.1 What was built

| Part | Where | Notes |
|---|---|---|
| Reminder due time | `smsNotices/events.ts` `reminderDueAt` | The start − `SMS_VISIT_REMINDER_MINUTES_BEFORE` (120); a due time from 21:00 to before 07:00 India time moves back to the 20:00 before it; none when the result is under 60 minutes from now |
| Reminder rows | `smsNotices/events.ts` | `smsBooked` and `smsMoved` (the 5b hooks) also queue `reminder`, version = the start in epoch minutes, `dueAt` as above, through the same `queue` → `enqueueSms` (one row per visit: the 5a marker). Never for an instant consultation; a desk walk-in is already out of scope (5b). An account move queues none: the recipient is read at send time |
| Reminder at send | the 5b composer (`compose`, `stillTrue`) | Sent only while the visit is still at that start and before it: a consultation `confirmed` and `paid`, a lab booking `confirmed`; otherwise `stale` (a move, a cancel). An open "not mine" report → `disputed` (5b) |
| `place` of the reminder | `placeOf`, `templates.ts` `wordsFor` | "Jansetu app" (video on the patient's phone), "the clinic" (in person), the booker's name (the partner's device), the lab's name (lab visit), "home" (home collection); the new fixed words are in the word table |
| Link variants | `compose` | BOOKED_LINK / REMINDER_LINK first, then BOOKED / REMINDER (5a's `chooseTemplate` keeps the patient's language before the link, SM6), only for a video consultation with `join.on: 'patient_phone'` while `JOIN_LINK_SECRET` and `SMS_JOIN_LINK_BASE_URL` are set. To the account phone like every notice, never `join.phone` (SM15) |
| Token | `smsNotices/joinLink.ts` `joinTokenOf` | `<shortRef>-<mac>`, 29 characters; `mac` = the first 100 bits of HMAC-SHA256(`JOIN_LINK_SECRET`, `<bookingId>:<join.linkVersion>`), RFC 4648 base32. Computed when the SMS is sent; never stored (not in the outbox either) |
| `GET /j/:token` | `smsNotices/joinLink.ts` `joinRouter`, mounted at `/j` in `configureRoutes` (no sign-in; only while `JOIN_LINK_SECRET` is set, else the app's 404) | As §27.8.3: the per-IP limit through the OTP counter store (`hitClient('join-ip', req, windows, { always: true })`, `otp/throttle.ts`); the token's shape and MAC (`timingSafeEqual`); a 302 to the Meet link only for a confirmed, paid video consultation on the patient's phone, no open dispute, an eligible doctor, an active `https://meet.google.com/` link, inside the Join window (`joinWindowOf`, as the partner's device, item 8 below). Everything else: the one page |
| Request log | `middleware/requestLogger.ts` (moved out of `src1/index.ts`, same output) | Prints `/j/:token` for any `/j/…` path (any case); the route logs `{ outcome: 'redirect' \| 'closed' \| 'limited' \| 'unavailable' \| 'error' }` only |
| Settings | `smsNotices/flags.ts` | `reminderMinutesBefore`, `joinSecret` (at least 32 bytes, else unset), `joinRatePerMinute` |

#### 27.14.2 The texts to register on DLT (English)

The repo text is in `smsNotices/templates.ts` (since 5a); each `{#var#}` is written there with its name. The link address is
fixed text: `SMS_JOIN_LINK_BASE_URL` (the admin summary's `dltText` shows each text with the configured address). Every
variable is at most 30 characters; the token is 29.

**REMINDER** (`SMS_REMINDER_EN_TEMPLATE`, `SMS_REMINDER_EN_ENABLED`)

```
Jansetu reminder: {#var#}'s {#var#} on {#var#} at {#var#}, {#var#}.
```
Variables in order: patient's first name; service; date (`DD-MM-YYYY`); time (`HH:mm`); place. Samples:
`Jansetu reminder: Rina's video consultation on 01-12-2026 at 10:30, Sharma Medicals.`,
`Jansetu reminder: Rina's home sample collection on 01-12-2026 at 07:30, home.`

**BOOKED_LINK** (`SMS_BOOKED_LINK_EN_TEMPLATE`, `SMS_BOOKED_LINK_EN_ENABLED`)

```
Jansetu: {#var#}'s {#var#} is booked for {#var#} at {#var#} via {#var#}. Ref {#var#}. Join the video call at https://<domain>/j/{#var#} at the booked time.
```
Variables: first name; service; date; time; place (the booker); Ref; token. Sample: `Jansetu: Rina's video consultation is
booked for 01-12-2026 at 10:30 via Sharma Medicals. Ref ABCD2345. Join the video call at https://<domain>/j/ABCD2345-ABCDEFGHIJKLMNOPQRST at the booked time.`

**REMINDER_LINK** (`SMS_REMINDER_LINK_EN_TEMPLATE`, `SMS_REMINDER_LINK_EN_ENABLED`)

```
Jansetu reminder: {#var#}'s {#var#} on {#var#} at {#var#}, {#var#}. Join: https://<domain>/j/{#var#}
```
Variables: first name; service; date; time; place ("Jansetu app"); token. Sample: `Jansetu reminder: Rina's video
consultation on 01-12-2026 at 10:30, Jansetu app. Join: https://<domain>/j/ABCD2345-ABCDEFGHIJKLMNOPQRST`

`https://<domain>/j` is exactly `SMS_JOIN_LINK_BASE_URL`, and that address must be whitelisted on DLT before the `_LINK`
texts are registered.

**The `/j/` page** (status 200 for every closed case; also with 429 and 503): "This Jansetu link is not open now. It
opens 10 minutes before the booked time. You can also sign in to the Jansetu app with this mobile number and tap Join."
and in Hindi "यह जनसेतु लिंक अभी खुला नहीं है। यह बुक किए गए समय से 10 मिनट पहले खुलता है। आप इसी मोबाइल नंबर से
जनसेतु ऐप में साइन इन करके Join दबा सकते हैं।" Headers: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
`X-Robots-Tag: noindex`.

#### 27.14.3 Choices made while building (ASSUMED r34, reversible)

1. **Quiet hours** are 21:00 up to (not including) 07:00 India time: a reminder due at 21:00 moves to 20:00; one due at
   07:00 or 20:59 stays.
2. **The 60-minute rule is applied after the night rule.** r34b (coordinator's decision, reversible): when the 20:00 of
   the night rule is under 60 minutes away, the reminder is due at 07:00 on the visit's day if that is at least 60
   minutes from now and at least 60 minutes before the visit; otherwise there is none (the "booked" SMS has just gone).
   And at send time (r34b): a reminder that comes due in the quiet hours anyway (a late drain, a retry) waits for the
   next 07:00 if that is still at least an hour before the visit, without using an attempt; otherwise it is `skipped:
   quiet`.
3. **Every move through `smsMoved`** (the booker's move, the doctor's or an admin's no-show move, an admin's move, the
   booker's accept of a lab's time, the lab's no-show rebook) queues the new time's reminder; the old one is `stale` when
   due. r34b: the patient's own accept of a lab's new time in the app queues the new time's reminder too
   (`smsReminder`), without a "moved" SMS. A lab's proposal already writes the proposed slot, so the old time's
   reminder is `stale` from then on. An account move queues none. A move back to an earlier time reuses that time's
   reminder (one per visit time).
4. **A lab reminder** goes only while the booking is `confirmed` (§27.7); a lab visit (partner-made or desk) names the
   lab, a home collection says "home".
5. **The Hindi page text is a draft** for the phase 6 translator's check (like the SMS texts, SM18).
6. **HEAD** is answered by the GET handler (Express: same status and headers, no body) and counts towards the same limit.
7. **Only the counter store answers 503.** A database error while looking up the booking answers the page (logged with
   the outcome `error`, r34b).
8. **The Join window is the partner's device's** (r34b, `joinWindowOf` in `assisted/rxAccess.ts`, also used by the
   booker view): a scheduled consultation from its start − 10 min to its end; an instant one from its acceptance −
   10 min to the end of the doctor's held interval (the reservation: acceptance + `CONSULT_MS`, moved by every
   extension). Both ends inclusive. (Before r34b the link had its own acceptance + 60 min rule.)
9. **A token never expires by itself**: it opens only inside its visit's window, and dies with the admin account move
   (`linkVersion`), a cancel (the status check) or a changed `JOIN_LINK_SECRET`.
10. **`SMS_JOIN_RATE_PER_MINUTE`** is read on every request (1–10000, default 30); `JOIN_LINK_SECRET` under 32 bytes
    counts as unset. r34b: `SMS_JOIN_LINK_BASE_URL` must be `https://…/j` (the route); any other address counts as unset
    (the plain texts are sent).
11. **`/j/` exists only while `JOIN_LINK_SECRET` is set** (r34b). Without it the path answers exactly as before 5d (the
    app's 404) and nothing is counted.

#### 27.14.4 Switches, deploy, rollback

```
SMS_VISIT_REMINDER_MINUTES_BEFORE=120   # 30–1440
SMS_REMINDER_EN_TEMPLATE=   SMS_REMINDER_EN_ENABLED=false
SMS_BOOKED_LINK_EN_TEMPLATE=   SMS_BOOKED_LINK_EN_ENABLED=false
SMS_REMINDER_LINK_EN_TEMPLATE=   SMS_REMINDER_LINK_EN_ENABLED=false
SMS_JOIN_LINK_BASE_URL=          # https://<domain>/j, exactly the address in the registered link texts
JOIN_LINK_SECRET=                # 48 random bytes, base64 (openssl rand -base64 48); changing it kills every link sent
SMS_JOIN_RATE_PER_MINUTE=30
```

- All off by default. Without `SMS_NOTICES_ENABLED` nothing is queued (reminders included); without the secret no link
  is sent and `/j/` is the app's 404 (r34b); without a pair the plain text is used (`_LINK` off) or nothing (`REMINDER`
  off).
- **Deploy:** 1. deploy (no new index or collection: the outbox and the OTP counters exist); 2. route `/j/` on the link
  domain to the API (nginx `location /j/ { proxy_pass …; access_log off; }`: the proxy's own access log must not keep
  the token either); **before switching the join link on, firewall the Node port (4041 on stage) or bind it to
  127.0.0.1, and set `TRUST_PROXY` to the real hop count** (r34c: otherwise a client reaching Node directly, or a forged
  `X-Forwarded-For`, picks its own address for the per-IP limit); 3. set `JOIN_LINK_SECRET` and `SMS_JOIN_LINK_BASE_URL`; 4. whitelist the
  address on DLT and register the three texts above; 5. one admin test send each (`POST /admin/sms-notices/test`); 6. the
  pairs. Reminders need only the REMINDER pair.
- **Rollback:** the pairs (a `_LINK` pair off falls back to the plain text); the secret unset removes `/j/` (every
  link sent then answers the app's 404); the master switch stops all notices. Older code ignores `reminder` rows (no composer: `skipped`).

#### 27.14.5 Checks

`test/assisted/r34-phase5cd.integration.ts`, 13 checks (the hooks called as the commands call them; 5b's suite covers
every command path; a fake gateway through `setSmsProvider`):
1. due times: 10:00 → 08:00, 07:30 → 20:00 the evening before, 23:30 → 20:00 the same day, the 21:00 / 07:00 edges, the
   minutes setting and its range;
2. booked 50 minutes or 2.5 hours before the visit → no reminder;
3. one reminder for three racing enqueues; ids only in the row; not sent a minute before it is due; at 08:00 the
   REMINDER_LINK text with the token, to the account phone (not `join.phone`); the BOOKED_LINK text;
4. a move → the old reminder `stale`, the new one sent at its time; a cancel → `stale`;
5. none for an instant consultation or a desk walk-in; `place` for the partner's device, a clinic visit, a lab visit and
   a home collection (plain texts, no link);
6. variants: REMINDER_LINK off → REMINDER; no secret or no address → the plain texts; a short secret is none;
7. master switch off → nothing queued;
8. the token: 29 characters, the MAC recomputed independently, stable, new with `linkVersion`, nothing stored;
9. `/j/`: 302 inside the window (GET and HEAD) with the three headers; early (12 minutes before), late, cancelled,
   tampered, unknown Ref, lower case, short and an old `linkVersion` → the same page and status; the moved booking's new
   token opens; a booker move keeps the token and the window follows the slot;
10. never for the partner's device, a call, unpaid, disputed, an ineligible doctor, a Meet link not active or not Google;
    instant: inside 60 minutes of acceptance, closed after, open again with an extension, closed after it;
11. the 31st request in a minute from one IP → 429 with the page and `Retry-After`; another IP 200; a counter store that
    refuses writes → 503 with the page;
12. without `JOIN_LINK_SECRET` a valid token gets the page;
13. logs: the request logger prints `GET /j/:token` (`/J/` too); the route logs the outcome only; no token, phone or
    text in any log line, and no token, phone or name in any outbox row.

**The 5b suite** (`r31-phase5b`, 19 checks) compared each booking's exact list of rows. Its row lists now leave out
`reminder` rows (this suite checks them), and its admin-read check expects the pharmacy create's queued reminder next to
the sent "booked" (the real create path queues it). Nothing else in it changed; 19 of 19 pass.

**Mutation check.** Each of these, undone alone, makes exactly its check fail: the request logger's redaction (13), the
window's start in `/j/` (9), the night rule (1), the reminder's version test at send (4).

**Full regression** (`prun.sh … 2` on `db05fad8`): 83 suites, 80 passed, `tsc` 17 as before. The other three:
- `r31-phase5b`: the exact row lists above (fixed in the suite, then 19 of 19);
- `r10f-card-last` (a Meet call bounded in time): run alone, 2 of 2;
- `phase0` (finding 6, a slow converter): the known load race in that test; it fails the same way on the base
  `6a8574e9` (r30 comparison) and touches nothing of phase 5.

#### 27.14.6 Review follow-ups (r34b, 2026-11-25)

The r34 review (`8c67a206`) gave GO for stage. Merged `m0/r31-phase5b` (`2df5651e`, also the stage head: r31b and stage
merge 2) first; conflicts in `smsNotices/events.ts` (r31b's fire-and-forget `queue` and move version kept; the reminder
rides the same `queue`), `routes/index.ts` (both imports), this file (§27.13.7 before §27.14) and the 5b suite. Then:

| # | Item | Built |
|---|---|---|
| 1 | One Join window | `joinWindowOf`, `joinOpenAt`, `instantHeldEnds` and `JOIN_OPENS_BEFORE_MS` in `assisted/rxAccess.ts`, used by the booker view (the partner's device, unchanged, inclusive end) and the SMS link. An instant consultation follows the doctor's held interval (acceptance + `CONSULT_MS`, moved by extensions) instead of acceptance + 60 min. `treating.ts` uses the constant (its instant and in-person openings are its own rules); `consultationEndOf` is a different end (completion, the day's end) and is left alone |
| 1 | One alphabet, one limiter | `BASE32_ALPHABET` exported from `assisted/consultations.ts` (the Ref and the MAC). `hitClient` (`otp/throttle.ts`) takes a kind, windows and `{ always }` (not gated by `OTP_IP_LIMITS`), keeping its `req.ip` fallback; the OTP callers are unchanged |
| 2 | `/j/` off | Without `JOIN_LINK_SECRET` the route passes on (`next()`): the app's own 404, no counter written, no headers added |
| 3 | Quiet hours at send | A reminder that comes due from 21:00 to before 07:00 (a late drain, a retry) waits for the next 07:00 if that is at least an hour before the visit (the drain's new `later` outcome: the row is queued again with that due time, the attempt given back); otherwise `skipped: quiet` |
| 4 | Night rule fallback | When the 20:00 before is under 60 minutes away: 07:00 on the visit's day if it is at least 60 minutes from now and before the visit; else none (coordinator's decision, reversible; §27.14.3 item 2) |
| 5 | The patient accepts a lab's new time | `smsReminder` (exported) queues the new time's reminder at `partners/services/labBookings.ts` (the patient's accept); no "moved" SMS |
| 6 | 5b suite | Every create and move path asserts its reminders (versions, each with its due time) next to its notices: one per create (none for an unpaid card booking, a walk-in or an instant consultation), the old time's and the new one's after a move, B → C → B → C → D gives B, C, D, and the patient's accept of a lab's new time gives the new time's |
| 7 | Small items | A database error at `/j/` is logged as `error` (the page is shown); `SMS_JOIN_LINK_BASE_URL` must be `https://…/j`, else the plain texts |

**Checks.** `r34-phase5cd` has 14 checks (new: the night-rule fallback cases in check 1; quiet hours at send; the
instant window by the held interval, its inclusive end and an extension; `/j/` off = the app's 404 for GET and HEAD with
no counter written; a database error → the page, logged `error`; a link address not ending in `/j` → plain texts).
`r31-phase5b` has 20 checks (r31b's 20, now with the reminder assertions above).

**Single suites** on `052ab90e` (own mongod): `r34-phase5cd` 14/14, `r31-phase5b` 20/20, `r25-phase5a` 11/11,
`r10g-meet-retry` 14/14, `r10f-card-last` 2/2, `r10-phase1b` 19/19, `q4b-instant` 25/25, `r17-phase3e` 25/25,
`phase1a` 30/30 (the booker view's Join call). `tsc` 17.

**Full regression** (`prun.sh … 2` on `052ab90e`): 85 suites, 85 passed (`phase0` included), `tsc` 17.

#### 27.14.7 Follow-ups (r34c, 2026-11-25)

Branch `m0/r34c-sms-followups` from `ceb49e88` (r34b, on stage). Local commits only.

1. **No import cycle.** `BASE32_ALPHABET` and the base32 encoder (`base32Prefix`) live in `common/utils/base32.ts`; the
   Ref (`assisted/consultations.ts`) and the join link's MAC (`smsNotices/joinLink.ts`) import them from there, so
   `joinLink.ts` no longer imports `assisted/consultations.ts` (which imports `smsNotices/events.ts`, which imports
   `joinLink.ts`).
2. **A reminder is not lost after a move back.** A reminder's key is its visit time, so a row already `skipped: stale`
   (the visit had moved away) blocked the one for the same time when the visit moved back. Now the reminder's enqueue
   (`enqueueSms` with `rearmSkipped`) re-arms that `skipped` row when its new due time is in the future: `queued`, the new
   `dueAt`, the version, attempts 0, the finish fields cleared, by a compare-and-set on `state: 'skipped'` (one racing
   enqueue wins). A `sent` reminder is never repeated. The reminder's "now" is `businessClock` (the business clock the
   limits use; real time unless a test moves it).
3. **Deploy** (§27.14.4 step 2): firewall the Node port (4041 on stage) or bind it to 127.0.0.1, and set `TRUST_PROXY` to
   the real hop count, before switching the join link on.

**Check** (r34-phase5cd, now 15): a visit at 08:30 (reminder due 20:00 the evening before), moved to 10:00 at 19:00, its
08:30 reminder `stale` at 20:00, moved back at 21:00 (two racing reminder enqueues and the move): the 08:30 row is
`queued` again for 07:00 (20:00 was under an hour away), one row per visit time, sent at 07:00; once sent, another move
away and back leaves it `sent`.

Undoing the re-arm alone fails exactly this check.

**Single suites** on `fa2837ae` (own mongod): `r34-phase5cd` 15/15, `r31-phase5b` 20/20, `r25-phase5a` 11/11. `tsc` 17.
**Full regression** (`prun.sh … 2` on `fa2837ae`): 85 suites, 84 passed, `tsc` 17; `phase0` failed its known load race
(finding 6, a slow converter) and passed alone, 29/29.
