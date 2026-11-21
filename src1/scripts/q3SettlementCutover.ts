/**
 * Q3 §7a cutover preparation (SETTLEMENT_CUTOVER_AT takes effect only with Q4a's doctor ledger earnings):
 *   npm run migrate:q3-settlement-cutover              # dry run: counts only
 *   npm run migrate:q3-settlement-cutover -- --commit  # stamp + import
 *
 * 1. Stamps `settlementSystem: 'legacy'` on every booking that has none (idempotent; never touches a stamped booking).
 * 2. Verifies no booking is left without a settlement system.
 * 3. Imports legacy payout billings and disbursals as non-posting LedgerHistoryRef rows on each doctor's settlement
 *    account (created idempotently), amounts converted from rupees to paise. They are context for statements only: not
 *    in any balance and never payable from the ledger. Unique per (legacyKind, legacyId), so re-runs add nothing.
 */
import mongoose from 'mongoose';
import { CONFIG } from '@/config/config';
import BookingModel from '@/modules/bookings/model';
import { PayoutBillingModel, PayoutDisbursalModel } from '@/modules/payouts/model';
import SpecialistModel from '@/modules/specialists/model';
import { LedgerHistoryRefModel } from '@/modules/partners/model/settlement';
import { ensureSettlementAccount } from '@/modules/partners/services/settlement';

export interface CutoverReport {
  unstampedBefore: number;
  stamped: number;
  unstampedAfter: number;
  billings: number;
  disbursals: number;
  imported: number;
}

const paise = (rupees: unknown) => Math.round(Number(rupees || 0) * 100);
const monthLabel = (m: unknown) => {
  const s = String(m ?? '');
  return /^\d{6}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
};

export async function runSettlementCutover(commit: boolean): Promise<CutoverReport> {
  const missing = { settlementSystem: { $exists: false } };
  const unstampedBefore = await BookingModel.countDocuments(missing);
  let stamped = 0;
  if (commit && unstampedBefore > 0) {
    // Q16a: a migration stamp is not an edit of the booking — `updatedAt` (the version clients fence on) is kept.
    const r = await BookingModel.updateMany(missing, { $set: { settlementSystem: 'legacy' } }, { timestamps: false });
    stamped = r.modifiedCount;
  }
  const unstampedAfter = commit ? await BookingModel.countDocuments(missing) : unstampedBefore;

  const billings = await PayoutBillingModel.find({}).lean() as any[];
  const disbursals = await PayoutDisbursalModel.find({}).lean() as any[];
  let imported = 0;
  if (commit) {
    const names = new Map<string, string>();
    const accountFor = async (specialistId: string) => {
      if (!names.has(specialistId)) {
        const sp = await SpecialistModel.findById(specialistId).select({ name: 1 }).lean() as any;
        names.set(specialistId, sp?.name || 'Doctor');
      }
      return ensureSettlementAccount('doctor', specialistId, names.get(specialistId)!);
    };
    for (const b of billings) {
      const account = await accountFor(String(b.specialistId));
      const r = await LedgerHistoryRefModel.updateOne({ legacyKind: 'billing', legacyId: String(b._id) }, {
        $setOnInsert: { settlementAccountId: String(account._id), source: 'legacy_import', legacyKind: 'billing', legacyId: String(b._id),
          periodLabel: monthLabel(b.month), amountMinor: paise(b.total), at: b.updatedAt ?? b.createdAt ?? new Date() },
      }, { upsert: true });
      imported += r.upsertedCount;
    }
    for (const d of disbursals) {
      const account = await accountFor(String(d.specialistId));
      const at = d.disbursalDate ? new Date(Number(d.disbursalDate) * 1000) : (d.createdAt ?? new Date());
      const r = await LedgerHistoryRefModel.updateOne({ legacyKind: 'disbursal', legacyId: String(d._id) }, {
        $setOnInsert: { settlementAccountId: String(account._id), source: 'legacy_import', legacyKind: 'disbursal', legacyId: String(d._id),
          amountMinor: paise(d.disbursalAmount), at },
      }, { upsert: true });
      imported += r.upsertedCount;
    }
  }
  return { unstampedBefore, stamped, unstampedAfter, billings: billings.length, disbursals: disbursals.length, imported };
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
    const report = await runSettlementCutover(commit);
    console.log(JSON.stringify({ mode: commit ? 'commit' : 'dry-run', ...report }, null, 2));
    if (commit && report.unstampedAfter > 0) {
      console.log('NOT READY: some bookings still have no settlement system; re-run.');
      process.exitCode = 2;
    } else if (commit) {
      console.log('READY: every booking is owned by exactly one settlement system. Do not set SETTLEMENT_CUTOVER_AT before the doctor ledger earnings (Q4a) are deployed.');
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
