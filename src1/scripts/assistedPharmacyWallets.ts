/**
 * Assisted booking phase 1a (design §15, §17.3, §17.4, decision B): the one migration of the phase. Additive; old fields
 * are left as they are. Run with the pharmacy switch off, dry run first:
 *
 *   npm run migrate:assisted-pharmacy-wallets             # dry run: counts, the opening entries it would write, sign anomalies
 *   npm run migrate:assisted-pharmacy-wallets -- --commit # writes
 *
 * 1. `signedAmountPaise` on pharmacy wallet rows missing it = balanceAfterPaise − balanceBeforePaise (rupees × 100 where
 *    the paise fields are missing). A row whose sign contradicts its type is listed, never changed.
 * 2. `balancePaise` from `balance` where missing.
 * 3. Per wallet, one `opening_balance` row of `balancePaise − Σ signedAmountPaise` (completed rows), operation key
 *    `migration:opening:<walletId>`, skipped when 0; non-withdrawable. Each wallet is done in one transaction that also
 *    writes the wallet, so a concurrent movement makes it retry instead of opening on a stale sum.
 * 4. `ledgerOpenedAt`, and `withdrawableMinor: 0` / `version: 0` only where missing (ASSUMED D14: older balances are not
 *    withdrawable; a rerun never resets a later value).
 * 5. §17.4: `typedName` on pharmacy-customer links = the account name where THAT pharmacy created the account
 *    (`createdSource: 'pharmacy_app'`, `linkedPharmacyId` = it). Other links stay empty (masked in lists).
 * 5b. Review of db252c1 (names): a link with no `consent` made by the customer (`createdByRole: 'user'`: their own order
 *    before S3) gets `consent: 'customer_order'` (only where missing; counted in `customerOrderConsentsFilled`).
 * 6. Decision B: `Coupon.fundedBy` = platform for coupons with corporateIds, provider otherwise; `partnerUsable: false`;
 *    only where missing.
 * A second run is a no-op (keys and "only where missing"): a wallet with `ledgerOpenedAt` is never opened again; a
 * mismatch found on it is listed in `openedWalletMismatches` and never written.
 */
import mongoose, { Types } from 'mongoose';
import { CONFIG } from '@/config/config';
import { PharmacyWalletModel, PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import UserModel from '@/modules/user/model';
import { CouponModel } from '@/modules/coupon/model';

type Row = Record<string, any>;
const PLUS = ['credit', 'refund', 'refund_credit', 'withdrawal_release', 'withdrawal_void'];
const MINUS = ['debit', 'consultation_payment', 'booking_debit', 'withdrawal_hold', 'chargeback', 'receivable_setoff'];
const paiseOr = (paise: unknown, rupees: unknown) => (Number.isSafeInteger(paise) ? Number(paise) : Math.round(Number(rupees ?? 0) * 100));

export interface MigrationReport {
  mode: 'dry-run' | 'commit';
  signedFilled: number;
  signAnomalies: { id: string; transactionType: string; signedAmountPaise: number }[];
  balancePaiseFilled: number;
  openings: { walletId: string; pharmacyId: string; amountPaise: number }[];
  /** Wallets already opened whose entries no longer explain the balance: reported for review, never written. */
  openedWalletMismatches: { walletId: string; pharmacyId: string; balancePaise: number; entriesPaise: number }[];
  walletsOpened: number;
  typedNamesFilled: number;
  customerOrderConsentsFilled: number;
  couponsFunded: { platform: number; provider: number };
}

export async function migrateAssistedPharmacyWallets(opts: { commit: boolean }): Promise<MigrationReport> {
  const report: MigrationReport = { mode: opts.commit ? 'commit' : 'dry-run', signedFilled: 0, signAnomalies: [], balancePaiseFilled: 0, openings: [], openedWalletMismatches: [],
    walletsOpened: 0, typedNamesFilled: 0, customerOrderConsentsFilled: 0, couponsFunded: { platform: 0, provider: 0 } };

  // 1. signedAmountPaise on old rows.
  const rows = PharmacyWalletTransactionModel.find({ signedAmountPaise: { $exists: false } }).lean().cursor();
  for await (const t of rows as AsyncIterable<Row>) {
    const signed = paiseOr(t.balanceAfterPaise, t.balanceAfter) - paiseOr(t.balanceBeforePaise, t.balanceBefore);
    if ((PLUS.includes(t.transactionType) && signed < 0) || (MINUS.includes(t.transactionType) && signed > 0)) {
      report.signAnomalies.push({ id: String(t._id), transactionType: t.transactionType, signedAmountPaise: signed });
    }
    report.signedFilled += 1;
    if (opts.commit) await PharmacyWalletTransactionModel.collection.updateOne({ _id: t._id, signedAmountPaise: { $exists: false } }, { $set: { signedAmountPaise: signed } });
  }

  // 2. balancePaise where missing.
  const noPaise = await PharmacyWalletModel.find({ balancePaise: { $exists: false } }).select({ balance: 1 }).lean() as Row[];
  report.balancePaiseFilled = noPaise.length;
  if (opts.commit) {
    for (const w of noPaise) {
      await PharmacyWalletModel.collection.updateOne({ _id: w._id, balancePaise: { $exists: false } }, { $set: { balancePaise: Math.round(Number(w.balance ?? 0) * 100) } });
    }
  }

  // 3–4. Opening entries and the ledger fields, one transaction per wallet.
  const wallets = await PharmacyWalletModel.find({}).select({ _id: 1 }).lean();
  for (const { _id } of wallets) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const w = await PharmacyWalletModel.findById(_id).session(session).lean() as Row;
        const balancePaise = paiseOr(w.balancePaise, w.balance);
        const key = `migration:opening:${String(w._id)}`;
        const has = await PharmacyWalletTransactionModel.exists({ pharmacyId: w.pharmacyId, operationKey: key }).session(session);
        // Review (rerun): a wallet already opened is never opened again; a later mismatch is reported, never written.
        if (w.ledgerOpenedAt) {
          const [sum] = await PharmacyWalletTransactionModel.aggregate([{ $match: { pharmacyId: w.pharmacyId, status: 'completed' } },
            { $group: { _id: null, total: { $sum: { $ifNull: ['$signedAmountPaise', 0] } } } }]).session(session);
          if (Number(sum?.total ?? 0) !== balancePaise) {
            report.openedWalletMismatches.push({ walletId: String(w._id), pharmacyId: String(w.pharmacyId), balancePaise, entriesPaise: Number(sum?.total ?? 0) });
          }
        } else if (!has) {
          const [sum] = await PharmacyWalletTransactionModel.aggregate([{ $match: { pharmacyId: w.pharmacyId, status: 'completed' } },
            { $group: { _id: null, total: { $sum: { $ifNull: ['$signedAmountPaise', { $subtract: [
              { $ifNull: ['$balanceAfterPaise', { $round: [{ $multiply: ['$balanceAfter', 100] }, 0] }] },
              { $ifNull: ['$balanceBeforePaise', { $round: [{ $multiply: ['$balanceBefore', 100] }, 0] }] }] }] } } } }]).session(session);
          const opening = balancePaise - Number(sum?.total ?? 0);
          if (opening !== 0) {
            report.openings.push({ walletId: String(w._id), pharmacyId: String(w.pharmacyId), amountPaise: opening });
            if (opts.commit) {
              // The opening row carries the wallet's balance in its before/after fields (informational; it is not a
              // movement at a point in time) and sorts first.
              const at = w.createdAt ? new Date(new Date(w.createdAt).getTime() - 1) : new Date(0);
              await PharmacyWalletTransactionModel.collection.insertOne({
                _id: new Types.ObjectId(), pharmacyId: w.pharmacyId, walletId: w._id, transactionType: 'opening_balance', amount: Math.abs(opening) / 100,
                amountPaise: Math.abs(opening), balanceBefore: balancePaise / 100, balanceAfter: balancePaise / 100, balanceBeforePaise: balancePaise,
                balanceAfterPaise: balancePaise, status: 'completed', referenceType: 'migration', referenceId: `opening:${String(w._id)}`,
                description: 'Opening balance (assisted booking phase 1a migration)', signedAmountPaise: opening, operationKey: key,
                withdrawableDeltaPaise: 0, createdAt: at, updatedAt: at,
              } as never, { session });
            }
          }
        }
        if (opts.commit) {
          const set: Row = {};
          if (!w.ledgerOpenedAt) set.ledgerOpenedAt = new Date();
          if (w.withdrawableMinor === undefined) set.withdrawableMinor = 0;
          if (w.version === undefined) set.version = 0;
          if (w.balancePaise === undefined) set.balancePaise = balancePaise;
          if (Object.keys(set).length) {
            await PharmacyWalletModel.collection.updateOne({ _id: w._id }, { $set: set }, { session });
            report.walletsOpened += 1;
          }
        } else if (!w.ledgerOpenedAt) {
          report.walletsOpened += 1;
        }
      });
    } finally {
      await session.endSession();
    }
  }

  // 5. typedName where this pharmacy created the account.
  const links = await PharmacyCustomerModel.find({ $or: [{ typedName: { $exists: false } }, { typedName: null }, { typedName: '' }] })
    .select({ pharmacyId: 1, userId: 1 }).lean() as Row[];
  for (const link of links) {
    const u = await UserModel.findById(link.userId).select({ name: 1, createdSource: 1, linkedPharmacyId: 1, otpVerified: 1 }).lean() as Row | null;
    const name = typeof u?.name === 'string' ? u.name.trim() : '';
    // The names rule (§18.5 finding 8): only an account this pharmacy opened that its holder never took over.
    if (!u || !name || u.createdSource !== 'pharmacy_app' || u.otpVerified === true
      || String(u.linkedPharmacyId ?? '').toLowerCase() !== String(link.pharmacyId).toLowerCase()) continue;
    report.typedNamesFilled += 1;
    if (opts.commit) {
      await PharmacyCustomerModel.collection.updateOne({ _id: link._id, $or: [{ typedName: { $exists: false } }, { typedName: null }, { typedName: '' }] },
        { $set: { typedName: name } });
    }
  }

  // 5b. A customer's own order before S3 recorded no consent: it is the customer's consent (`customer_order`).
  const ownOrderLinks = { createdByRole: 'user', consent: { $exists: false } };
  report.customerOrderConsentsFilled = await PharmacyCustomerModel.collection.countDocuments(ownOrderLinks);
  if (opts.commit && report.customerOrderConsentsFilled > 0) {
    const r = await PharmacyCustomerModel.collection.updateMany(ownOrderLinks, { $set: { consent: 'customer_order' } });
    report.customerOrderConsentsFilled = r.modifiedCount;
  }

  // 6. Coupon funding.
  const platform = { fundedBy: { $exists: false }, 'corporateIds.0': { $exists: true } };
  const provider = { fundedBy: { $exists: false }, 'corporateIds.0': { $exists: false } };
  report.couponsFunded.platform = await CouponModel.countDocuments(platform);
  report.couponsFunded.provider = await CouponModel.countDocuments(provider);
  if (opts.commit) {
    await CouponModel.collection.updateMany(platform, { $set: { fundedBy: 'platform' } });
    await CouponModel.collection.updateMany(provider, { $set: { fundedBy: 'provider' } });
    await CouponModel.collection.updateMany({ partnerUsable: { $exists: false } }, { $set: { partnerUsable: false } });
  }
  return report;
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
    const report = await migrateAssistedPharmacyWallets({ commit });
    console.log(JSON.stringify({ ...report, signAnomalies: report.signAnomalies.slice(0, 50), openings: report.openings.slice(0, 50),
      openingsTotal: report.openings.length, signAnomaliesTotal: report.signAnomalies.length }, null, 2));
    if (report.openedWalletMismatches.length) {
      console.log('REVIEW: wallets already opened whose entries do not explain the balance (listed, not changed).');
      process.exitCode = 2;
    }
    if (report.signAnomalies.length) {
      console.log('REVIEW: the rows above have a sign that contradicts their type; they were filled as recorded, not changed.');
      process.exitCode = 2;
    }
    if (!commit) console.log('Dry run: nothing was written. Run again with --commit to apply.');
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
}
