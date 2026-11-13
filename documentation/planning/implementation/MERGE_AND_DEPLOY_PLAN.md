# Merge and deploy plan: M0 customer + pharmacy packets (2026-11-13)

Backend only (`src1/`). None of these packets include app or web screens; staff and customer UIs still have to call
the new endpoints. Nothing below has been pushed or deployed.

**Status of the evidence.** "Approved" here means the source was reviewed by Codex. The test counts are the author's
own functional checks against a local replica set. Neither is M0 acceptance or release approval: per
[M0_START_APPROVAL_STATUS](../M0_START_APPROVAL_STATUS.md), M0 acceptance, pilot and release are still **NOT
APPROVED**, and the entry gates in §0 still apply.

## 0. Gates that still apply (not closed by these packets)

1. **C2 deployed baseline and compatibility review**
   ([M0_START_APPROVAL_STATUS](../M0_START_APPROVAL_STATUS.md), [C2_COMPATIBILITY_REVIEW](C2_COMPATIBILITY_REVIEW.md)).
   The confirmed runtime, MongoDB version, topology, PM2/build/start target and dependency baseline must be recorded
   and reviewed before any release. **Every packet needs multi-document transactions**, so the production MongoDB
   must be a replica set (or sharded cluster) that supports them. A standalone `mongod` would fail every refund,
   return and order/stock change. The build and start commands that will actually be used (`pm2 start server`,
   Node 22 as reported by the owner) must be verified against this branch.
2. **C3 fixture contract** ([C3_MONGO_FIXTURE_CONTRACT](C3_MONGO_FIXTURE_CONTRACT.md)).
   The suites in §6 are run directly with `npx tsx`. They import application and config code (including ambient
   `.env` loading) without the contract's complete pre-import fixture/provider admission, and a local replica set plus
   an exact-URI check is expressly not sufficient under that contract. Release qualification must re-run them
   through the admitted harness. Until then they remain author-reported functional results.
3. **Deployment authority.** Deploying, pushing to `main`, rotating secrets or any production database action each
   need the owner's explicit authorization for the named environment and change.

## 1. What is ready

All packets were reviewed by Codex through Ruflo (approved) and tested against a real MongoDB 7 replica set.

| Packet | Branch | Commit | What it adds | Test (checks) |
|---|---|---|---|---|
| C1 | `m0/c1-contact-recovery` | `602a270` | Sign out on all devices; contact change + change alert. **NOT in this release: it would switch off customer OTP login** (§4) | `test/customer-contact/c1-sessions.integration.ts` (15) |
| P1 | `m0/p1-prescription-review` | `74aa291` | Pharmacist approves/rejects prescriptions | `test/pharmacy-prescription/p1-review.integration.ts` (15) |
| P2 | `m0/p2-rx-refunds` | `515dfc6` | Refunds for rejected paid orders (wallet, optional card/UPI); atomic wallet ledger | `test/pharmacy-prescription/p2-refund.integration.ts` (26) |
| Booking retry | `m0/booking-payment-retry` | `ce7d595` | Booking money ledger (wallet funding, captures, refunds) | `test/booking-payment/retry-integrity.integration.ts` (26) |
| P7 | `m0/p7-delivery-refill` | `126bbde` | Refill orders, delivery/pickup exceptions, low-stock alerts | `test/pharmacy-refill/…` (19), `test/pharmacy-delivery/…` (8), `test/pharmacy-inventory/p7c-low-stock…` (10) |
| P3 | `m0/p3-stock-quality` | `f416bcc` | Quarantine/release, returns to supplier | `test/pharmacy-inventory/p3-batch-quality.integration.ts` (10) |
| P3b | `m0/p3b-recall-returns` | `a9c0872` + `8b16aab` | Recall worklist, swap/cancel, customer returns | `test/pharmacy-inventory/p3b-recall-returns.integration.ts` (13) |
| C1r | `m0/c1r-session-revoke` | `0f89887` | Sign out on all devices (revoke-only): customer tokens carry a credential generation; today's OTP login unchanged | `test/customer-contact/c1r-session-revoke.integration.ts` (7) |
| A1 | `m0/a1-milestone-rules` | on top of `0f89887` | Option A phase 1: the milestone's (`e8eb9bd`) non-ledger protections (§3) | `test/customer-bookings/a1-milestone-rules.integration.ts` (12); milestone `test/customer-profile/focused.mjs`, `test/customer-bookings/controllers.mjs` |

Branch shape. Everything starts from `9c8d1d8` (end of the `m0/customer-pharmacy-lab-focus` line, 390 commits ahead
of `main` = `origin/main` = `b06be01`):

```
9c8d1d8 ─┬─ P1 ─ P2 ─ booking-retry ─ P7 ─ P3 ─ P3b ─ C1r ─ A1   (one straight line; A1 contains all of them)
         ├─ C1                                           (side branch)
         └─ e8eb9bd  customer/milestone-2026-11-13       (side branch, NOT part of this work; see §3)
m0/f01-app-isolation = bfb608e + 2 docs/tooling commits  (bfb608e is already inside 9c8d1d8)
```

Trial merges (`git merge-tree`, nothing written):
- P3b + C1: **clean**.
- P3b + `m0/f01-app-isolation`: **clean**.
- P3b + `customer/milestone-2026-11-13`: **conflicts** (§3).

## 2. Merge order

1. Create the integration branch from the top of the line: `git switch -c release/m0-pharmacy m0/a1-milestone-rules`.
2. **Do not merge `m0/c1-contact-recovery`** into this release (§4, "C1 is rollout-blocked"). The trial merge is
   clean, but merging it would disable customer OTP login.
3. `git merge m0/f01-app-isolation` (clean; docs and the local extension tooling).
4. Settle `customer/milestone-2026-11-13` (§3) **before** any deploy.
5. On the merged result, run every suite in §6 (through the admitted harness for release, §0), then `npx tsc --noEmit -p tsconfig.json`. The one known error,
   `pharmacySubscriptions/repository/index.ts(42)`, existed before these packets.
6. Merge `release/m0-pharmacy` into `main` and push. This step needs the owner's go-ahead.

## 3. Open decision: `customer/milestone-2026-11-13` (`e8eb9bd`)

This commit ("enforce profile rules and safe booking settlement", 97 files, +17k/−2.8k) was made today on the same
base. It overlaps the money code in P2 and the booking-retry packet:

| File | Conflict hunks | Conflicted lines |
|---|---|---|
| `src1/modules/bookings/services/index.ts` | 6 | ~634 |
| `src1/modules/externalBookings/services/index.ts` | 3 | ~384 |
| `src1/modules/payment/services/index.ts` | 3 | ~263 |
| `src1/modules/wallet/services/index.ts` | 1 | ~39 |
| C1 vs milestone: `auth/services`, `user/controller`, `user/routes`, `user/services` | 6 | ~180 |

That gives two independent designs for booking settlement: the booking-retry packet's `walletFunding` ledger, and the
milestone's `localOperations` / `externalBookingPaymentFinalize`. Merging them by hand without a design decision
risks double refunds or double wallet debits. Options:

- **A. Keep the booking-retry ledger and port the milestone's protections onto it.** Recommended (Codex agrees), once
  the deployed baseline is confirmed. Keep one money ledger (`walletFunding`) and port the milestone's
  authority/dependent rules, cancellation window, slot/coupon checks and provider-outcome handling onto it.
- **B. Keep the milestone's settlement and drop the booking-retry packet.** This needs its own cutover and design
  review. The two designs treat old data differently: the milestone refuses legacy rows without `localEffects` and
  sends non-canonical captures to reconciliation, while the booking-retry ledger hydrates legacy funding and
  automatically returns losing captures. P2/P7/P3/P3b still need P2's wallet `postEntry`.
- **C. Deploy without the milestone branch.** This defers its policies (profile rules, cancellation window and so on);
  it does not reconcile them. They must come back later as their own reviewed packet.

Whichever option is chosen, the merged result must pass both test sets: §6 and the milestone's
`test/customer-bookings/*.mjs`, `test/customer-profile/*.mjs`, `test/customer-wallet/*.mjs`.

**Decision: option A (owner, 13 Nov).** The milestone branch itself is NOT merged; its rules are ported:

- **A1 (done, `m0/a1-milestone-rules`).** Rules that do not move money through the ledger:
  - Who may book or cancel for whom: own active dependents only; no customer-supplied `corporateId`; external
    bookings need a signed actor; new owner-scoped `GET /external-bookings/bookings/:id`; scalar `userId` list filters.
  - Profile: a customer may only fill a missing phone or email; replacing an email is admin-only, enforced in email
    verification too; HR edits only its own corporate's users.
  - Cancellation window: IST, 24 h (48 h for a Monday appointment) for customers; nobody may cancel a started
    appointment. **For now it applies to every customer cancellation, paid or not**; the milestone's "unpaid is
    exempt" relaxation comes back in A2, where it can be serialized with the payment state. Only `pending`/`confirmed`
    bookings can be cancelled.
  - The generic booking edit/delete can no longer cancel, pay, refund or move a booking, and delete is refused (history
    is retained).
  - A `paid`/`refunded` payment record is never rewritten by a replayed verify (all payment contexts).
  - Coupon discounts are rounded once to paise; a ₹0 discounted package price means free.
  - Healthians: the slot is frozen at fulfilment, not at draft creation, and the accepted post-coupon total (gateway +
    wallet) is sent.
  - **The provider webhook is now record-only** (`meta.lastUntrustedProviderObservation`,
    `meta.providerEventReconciliationRequired`). It no longer changes status, reschedules, stores reports, cancels at
    the provider or refunds. Reports are still read through the authenticated report endpoints.
- **A2a (next): ordinary bookings, money path.** Slot hold, follow-up benefit and coupon count in the same transaction
  as the cancel refund; payment-setup lease; restore the unpaid exemption safely.
- **A2b (after A2a): external bookings.** Provider admission token, two-phase cancel that waits for provider
  acknowledgement before refunding, timeout schedulers through the same intent, payment-detail validation.

## 4. Deploy steps (production)

Production runs with Mongoose `autoCreate`/`autoIndex` **off** (`src1/db/index.ts`). New collections and indexes
exist only after `npm run sync-indexes`.

### Before deploying the code
1. Take a database snapshot/backup.
2. Run this pre-flight; it must return no rows, or the unique index build in step 4 fails:
   ```js
   db.wallettransactions.aggregate([{ $match: { operationKey: { $type: 'string' } } },
     { $group: { _id: '$operationKey', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])
   ```
3. **`sync-indexes` also DROPS any index that is not declared in a schema.** List the production indexes first
   (`db.getCollectionNames().forEach(c => printjson([c, db[c].getIndexes().map(i => i.name)]))`) and compare them
   on a staging copy before running it in production.
4. Run `npm run sync-indexes` **before** starting the new code. The code depends on these indexes:

   | Collection | Index | Why |
   |---|---|---|
   | `wallettransactions` | `{operationKey:1}` unique, partial (string) | Every wallet posting happens exactly once (P2+) |
   | `pharmacyorders` | `{pharmacyId, prescriptionStatus, createdAt}` | Pharmacist review queue (P1) |
   | `pharmacyorders` | `{prescriptionRefund.status, prescriptionRefund.updatedAt}` sparse | Refund reconciler and attention queue (P2) |
   | `pharmacyorders` | `{refill.paymentDueBy, status}` sparse | Expiry of unpaid refill orders (P7) |
   | `pharmacy_supplier_returns` | new collection + `{pharmacyId, createdAt}` | Supplier returns (P3) |
   | `pharmacy_customer_returns` | new collection + `{pharmacyId, requestKey}` **unique**, `{pharmacyId, createdAt}`, `{pharmacyId, lines.batchId}`, `{orderId}` | Customer returns; the unique index guarantees a retried submission is applied once (P3b) |

   The P3b follow-up commit moved both return models into `pharmacyInventory/model/`, because `sync-indexes` only
   loads `modules/*/model/*`. This was checked by running the real script against a test database: both
   collections and the unique index were created.

### C1 is rollout-blocked: do not merge it into this release
C1 is source-approved, but deploying it as it stands **turns off ordinary customer OTP login and signup**, not just
contact change:
- C1 brings in the contact-identity flow. `AuthService.sendCustomerOTP` and `verifyCustomerOTP` (and contact change)
  first call `userRepository.assertContactIdentityReady()`.
- The default `UserContactIdentityAdmission.assertCoverage` always fails closed, by design, so every customer OTP send
  or verify would return `503 CONTACT_IDENTITY_NOT_READY`.
- The admission check requires the named unique partial index `user_contact_keys_v1` on `contactKeys`. That index is
  **not declared in the user schema**, so `sync-indexes` cannot create it and would **drop** a manually created copy.
- The C1 integration test replaces the admission check with a stub, so it does not show this.

C1 can ship only after one of these:
- **(a)** a separately reviewed contact-identity rollout: `contactKeys` back-fill and coverage, an index declared so
  `sync-indexes` keeps it, and a real coverage admission. Keep the fail-closed check; do not bypass it.
- **(b)** a separately reviewed revoke-only change that keeps today's customer login working: sign out on all devices
  plus `authVersion` enforcement, without the contact-identity gate.

Nothing in P1–P3b depends on C1. **Option (b) is done: C1r** (`m0/c1r-session-revoke`, in this release). Customer
tokens carry `authVersion` (absent = 0, so the deploy signs nobody out). `authenticate`/`authenticateOptional` admit a
customer token only at the account's current generation, and `POST /v1/auth/sessions/revoke` advances it. There is no
`keepCurrent`, no `isActive` enforcement, and no contact change. Behaviour changes: a customer token whose account no
longer exists is now refused (401), and each customer request does one `_id` read. No migration or index is needed.

### Configuration
- `REFILL_PAYMENT_WINDOW_HOURS` (optional, default `48`): how long a refill order waits for the customer's payment.
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (already in use): needed for "refund to original card/UPI". Without them
  that one action returns `503 RAZORPAY_NOT_CONFIGURED`; wallet refunds still work.

### Schedulers (start automatically with the app, `src1/index.ts`)
- Prescription refund reconciler: every 5 minutes. It settles pending wallet refunds and follows up card/UPI refunds.
- Low-stock alert sweep: every 15 minutes.
- The existing pharmacy-order timeout scheduler now also expires unpaid refill orders.

Each app instance runs its own copy. Every job is fenced and idempotent, so several instances are safe; they only
repeat work.

## 5. After deploy: smoke tests (staging first)

| Area | Check |
|---|---|
| Customer login | Customer OTP send and verify succeed exactly as before; a token issued before the deploy still works |
| C1r | `POST /v1/auth/sessions/revoke` with a customer token: 200; that token and every other device's token then get 401; a new OTP login works |
| A1 | A customer cancel inside 24 h (48 h for Monday) is refused, and allowed outside it; `PUT /bookings/:id` with `status: cancelled` gives 409; a provider webhook changes no status or money; a customer can add but not replace an email; a Healthians order's amount equals the post-coupon total |
| C1 contact change (later, once it ships per §4) | The change alert is a best-effort **email**: for an email change it goes to the previous email (none if there wasn't one); for a phone change it goes to the account email (none if the account has no email). No SMS alert is sent |
| P1 | A prescription order is pending; the pharmacist approves it (the order can be packed) or rejects it (stock is released) |
| P2 | Reject a paid order: the wallet is credited in full and `prescriptionRefund.status = wallet_credited`; with test keys, "to source" reaches `source_refunded` |
| Booking | Pay a booking with wallet + card; cancel it: the refund equals what was paid; a retried payment callback does not double-credit |
| P7 | Create a refill order (pharmacy or customer); it stays unconfirmed until paid; a failed delivery can be retried; a not-collected order is refunded; the low-stock worklist fills |
| P3 | Quarantine a batch (it can't be sold); release it with a write-off; return stock to a supplier |
| P3b | Recall a batch: the recall trace lists open orders and customers. Swap one order to another batch; cancel another (the paid one is refunded). Record a customer return with a partial refund; submitting the same `requestKey` again returns the same record |
| Money | For a few touched customers, wallet `balance` equals the sum of the ledger |

## 6. Test suites (run on the merged branch)

Each suite needs a throwaway replica set. The URL must match the one in the file header exactly:

```
docker run -d --rm --name m0-mongo -p 127.0.0.1:27917:27017 mongo:7 --replSet rs0 --bind_ip_all
docker exec m0-mongo mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
MONGODB_URL='<url from the file header>' JWT_SECRET_KEY=local-check-only npx tsx --tsconfig tsconfig.json <file>
```

Files (C1's `test/customer-contact/c1-sessions.integration.ts` runs on the C1 branch, which is not in this release):
- `test/pharmacy-prescription/p1-review.integration.ts`
- `test/pharmacy-prescription/p2-refund.integration.ts`
- `test/booking-payment/retry-integrity.integration.ts`
- `test/pharmacy-refill/p7-refill-orders.integration.ts`
- `test/pharmacy-delivery/p7b-delivery-exceptions.integration.ts`
- `test/pharmacy-inventory/p7c-low-stock.integration.ts`
- `test/pharmacy-inventory/p3-batch-quality.integration.ts`
- `test/pharmacy-inventory/p3b-recall-returns.integration.ts`
- `test/customer-contact/c1r-session-revoke.integration.ts`
- `test/customer-bookings/a1-milestone-rules.integration.ts`
- Milestone tests carried over unchanged: `node test/customer-profile/focused.mjs`,
  `node test/customer-bookings/controllers.mjs` (Node ≥ 22.13, `stripTypeScriptTypes`)

## 7. Rollback

Older code ignoring the new fields does **not** make a rollback safe. **The rollback floor is this whole release**
(P1, P2, booking-retry, P7, P3, P3b, C1r). Once it is live, roll back only to a build that contains all of them, and turn
individual features off rather than reverting below it. Going below the floor needs an explicit, reviewed drain or
reconciliation of the state listed here. The same rule applies to any later release that stores state only new code
can read.

- **Booking money already recorded in `walletFunding`.** Older booking code does not read the booking ledger
  (`walletFunding` total/captures/closed). Cancelling a booking funded under the new code with old code can refund
  the wrong amount, or refund twice.
- **Refill orders waiting for payment (P7).** A refill order waits up to `REFILL_PAYMENT_WINDOW_HOURS` (default 48 h).
  The pre-P7 timeout query selects unpaid online orders by `createdAt` alone after 35 minutes, so it would abandon
  them and release their stock with up to 47 hours still to run. Turning off new refill creation does not protect
  orders that already exist. Check first: `db.pharmacyorders.countDocuments({refill: {$exists: true}, status: 'placed', paymentStatus: {$ne: 'paid'}})`.
- **`delivery_failed` orders (P7).** Older code does not know this status, so those orders would be stuck.
- **In-flight refunds (P2, P7, P3b cancel).** Their reconciler exists only in the new code. Check first:
  `db.pharmacyorders.countDocuments({'prescriptionRefund.status': {$in: ['wallet_pending', 'source_processing']}})`.
- **Wallet races.** Pre-P2 code writes absolute wallet balances (the race P2 removed) and does not use
  `operationKey`. Under concurrency it can overwrite ledger-backed balances.
- **C1r sign-outs.** Once customers have used "sign out on all devices", rolling back below C1r makes those revoked
  tokens valid again, because older `authenticate` checks only the signature and expiry. That would need a separately
  approved all-token cutover, for example rotating `JWT_SECRET_KEY`.
- Indexes and new collections can stay in place for any rollback within the floor.

## 8. Known limits (not done)

- No real Razorpay test-mode run yet; it needs the owner's test keys.
- Until A2b: with the webhook record-only, a provider booking created after a local cancel is no longer auto-cancelled
  when it is discovered. The customer's money is already refunded by the cancel path. Watch
  `meta.providerEventReconciliationRequired` and cancel such bookings at the provider by hand.
- Until A2a: customers cannot cancel an unpaid booking inside the cancellation window (admins can until it starts).
- External bookings: a cancellation landing between the pre-check and the provider booking can still book with the
  provider. The money is returned, but the provider booking has to be cancelled by hand.
- No UI for any of the new endpoints.
- Pre-existing type error in `pharmacySubscriptions/repository/index.ts(42)`.
