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
| 4 | Failures no retry can fix were retried for 48 h | `permanentMeetFailure` (meet service: patient or doctor without email, Meet not configured, slot missing) closes the booking after the attempt (`closed: 'permanent'`, `closedReason`). Alerts: at most one per booking — **none for a customer booking whose patient has no email** (DECIDED here: phone-only customers are common and the gap is expected; the booking is still listed in stuck money with `closedReason: 'patient_email_missing'`); "Meet not configured" raises one alert a day for all bookings | 9 |
| 5 | A failure write bumped `updatedAt` (a booker's `expectedUpdatedAt` then failed with 409 `BOOKING_CHANGED`) | Every failure record `syncBookingMeet` writes uses `timestamps: false`; the retry's own writes never touched it | 10–11 |
| 6 | `meetRetry.attempts` kept counting after a success | Reset to 0 on success | 10–11 |

**Seen, not changed (from the review, later):** a reschedule or cancel in the same second as a retry (the final
unconditional write in `syncBookingMeet`); `meetRetry` in the patient and doctor views. Also: a create aborted by the
time limit after Google made the event is now found by the next retry (`jansetuBookingId`), but the first, ordinary
(non-retry) attempt never looks up before creating.

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
| `POST …/lab-bookings` | `{ requestKey, phone, patient ({relation:'self',name} \| {dependentId} \| {relation,name,gender?,dateOfBirth?}), holderName?, consent:{agreed:true,statementVersion,statementLanguage}, preferredLanguage, partnerId, branchId, visitMode, slotId, itemIds[1..20], address? (home only: {line1,line2?,city,state?,pincode(6 digits),landmark?}), couponCode?, acceptedPriceMinor, notes?, paymentMethod:'wallet' }` | 201 (replay 200) `{ booking: <booker lab view>, funding: { method:'wallet', amountMinor, state, walletEntryId }, split: { listMinor, discountMinor, couponCode }, newAccount, replayed }` |
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
