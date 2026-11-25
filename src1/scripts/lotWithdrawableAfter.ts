/**
 * Round 4d (§26.8.1, M12): every top-up lot without `withdrawableAfter` gets `createdAt + 7 days` (older card money is
 * already past the O2 card hold; the read already counts a lot without it that way, so this only makes the field and its
 * index complete). Additive and rerunnable ("only where missing"). Dry run first:
 *
 *   npm run migrate:lot-withdrawable-after             # dry run: how many lots would be filled, per wallet kind
 *   npm run migrate:lot-withdrawable-after -- --commit # writes
 */
import mongoose from 'mongoose';
import { CONFIG } from '@/config/config';
import { WalletTopupLotModel } from '@/modules/pharmacyWallet/model/lots';
import { CARD_HOLD_DAYS } from '@/modules/pharmacyWallet/walletLots';

export interface LotBackfillReport { mode: 'dry-run' | 'commit'; missing: Record<string, number>; filled: number }

export async function backfillLotWithdrawableAfter(opts: { commit: boolean }): Promise<LotBackfillReport> {
  const missing: Record<string, number> = {};
  for (const row of await WalletTopupLotModel.aggregate([{ $match: { withdrawableAfter: { $exists: false } } },
    { $group: { _id: '$walletRef.kind', n: { $sum: 1 } } }]) as { _id: string; n: number }[]) missing[row._id] = row.n;
  let filled = 0;
  if (opts.commit) {
    // One update with a pipeline: each lot's own createdAt + 7 days; a lot written meanwhile (with the field) is untouched.
    const r = await WalletTopupLotModel.collection.updateMany({ withdrawableAfter: { $exists: false } },
      [{ $set: { withdrawableAfter: { $add: ['$createdAt', CARD_HOLD_DAYS * 86_400_000] } } }]);
    filled = r.modifiedCount;
  }
  return { mode: opts.commit ? 'commit' : 'dry-run', missing, filled };
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
    console.log(JSON.stringify(await backfillLotWithdrawableAfter({ commit }), null, 2));
    if (!commit) console.log('Dry run: nothing was written. Run again with --commit to apply.');
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
}
