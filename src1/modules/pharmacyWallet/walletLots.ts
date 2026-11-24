import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { WalletTopupLotModel, type IWalletTopupLot } from '@/modules/pharmacyWallet/model/lots';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';

/**
 * Top-up lots of every wallet store (§5.3; r13 / round 2d moved them here from `pharmacyWallet/ledger.ts` unchanged, with
 * a `walletRef` parameter): the pharmacy ledger calls them with `{ kind: 'pharmacy', id }`, the partner ledger with
 * `{ kind: 'lab' | 'doctor', id }`. Ids are matched lower-cased, as every writer stores them.
 */
export type WalletRef = IWalletTopupLot['walletRef'];
export interface LotAllocation { lotId: string; amountPaise: number }

const refFilter = (ref: WalletRef) => ({ 'walletRef.kind': ref.kind, 'walletRef.id': String(ref.id).toLowerCase() });
const changed = () => Object.assign(new AppError({ status: 409, code: 'WALLET_CHANGED', message: 'The wallet changed; please retry' }), { retryable: true });

/** Σ remaining of the lots that count as withdrawable (not closed, fee known, no dispute). */
export async function withdrawableOfIn(ref: WalletRef, s: ClientSession | null): Promise<number> {
  const lots = await WalletTopupLotModel.find({ ...refFilter(ref), closed: false,
    feeState: 'known', disputeState: 'none', remainingMinor: { $gt: 0 } }).select({ remainingMinor: 1 }).session(s).lean();
  return lots.reduce((a, l) => a + Number(l.remainingMinor || 0), 0);
}

/** Σ remaining of every open lot (withdrawable or not). */
export async function openLotsMinorIn(ref: WalletRef, s: ClientSession | null): Promise<number> {
  const lots = await WalletTopupLotModel.find({ ...refFilter(ref), closed: false, remainingMinor: { $gt: 0 } })
    .select({ remainingMinor: 1 }).session(s).lean();
  return lots.reduce((a, l) => a + Number(l.remainingMinor || 0), 0);
}

/** A spend takes the open lots oldest first (ASSUMED D9) and returns what it took from each. */
export async function consumeLots(ref: WalletRef, amount: number, s: ClientSession): Promise<LotAllocation[]> {
  const lots = await WalletTopupLotModel.find({ ...refFilter(ref), closed: false,
    remainingMinor: { $gt: 0 } }).sort({ createdAt: 1, _id: 1 }).session(s).lean();
  const out: LotAllocation[] = [];
  let left = amount;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(left, Number(lot.remainingMinor));
    if (!(take > 0)) continue;
    const r = await WalletTopupLotModel.updateOne({ _id: lot._id, remainingMinor: lot.remainingMinor }, { $inc: { remainingMinor: -take } }, { session: s });
    if (r.modifiedCount !== 1) throw changed();
    out.push({ lotId: String(lot._id), amountPaise: take });
    left -= take;
  }
  return out;
}

/** A refund restores exactly the allocations of the spend it reverses. */
export async function restoreLots(allocations: LotAllocation[], s: ClientSession): Promise<LotAllocation[]> {
  const out: LotAllocation[] = [];
  for (const a of allocations) {
    if (!Types.ObjectId.isValid(a.lotId) || !(a.amountPaise > 0)) continue;
    // A lot closed for good (lost chargeback, N10) is never restored: that money comes back non-withdrawable.
    const r = await WalletTopupLotModel.updateOne({ _id: a.lotId, closed: false, $expr: { $lte: [{ $add: ['$remainingMinor', a.amountPaise] }, '$amountMinor'] } },
      { $inc: { remainingMinor: a.amountPaise } }, { session: s });
    if (r.modifiedCount === 1) out.push({ lotId: a.lotId, amountPaise: a.amountPaise });
  }
  return out;
}

/** The lot of a captured card top-up. `withdrawableAfter` (O2, partner wallets): card money waits that long (phase 4). */
export async function openLotIn(ref: WalletRef, lot: { paymentRecordId: string; amountMinor: number; gatewayFeeMinor?: number | null; withdrawableAfter?: Date },
  s: ClientSession): Promise<void> {
  const fee = typeof lot.gatewayFeeMinor === 'number' && Number.isSafeInteger(lot.gatewayFeeMinor) && lot.gatewayFeeMinor >= 0 ? lot.gatewayFeeMinor : null;
  await WalletTopupLotModel.create([{ walletRef: { kind: ref.kind, id: String(ref.id).toLowerCase() }, paymentRecordId: lot.paymentRecordId,
    amountMinor: lot.amountMinor, ...(fee !== null ? { gatewayFeeMinor: fee } : {}), feeState: fee !== null ? 'known' : 'unknown', disputeState: 'none',
    closed: false, remainingMinor: lot.amountMinor, ...(lot.withdrawableAfter ? { withdrawableAfter: lot.withdrawableAfter } : {}) }], { session: s });
}

/** The wallet's lots, newest first (admin reads: pick the one a chargeback is for). */
export async function lotsOf(ref: WalletRef, limit = 200): Promise<IWalletTopupLot[]> {
  return await WalletTopupLotModel.find(refFilter(ref)).sort({ createdAt: -1 }).limit(limit).lean() as IWalletTopupLot[];
}

/** A card top-up opens a lot only while `on()` (its kind's switch) and the lot index is built (fail closed = no lot). */
export const lotsWritableWhen = (on: () => boolean) => async (): Promise<boolean> => {
  if (!on()) return false;
  try { await assertUniqueIndex(WalletTopupLotModel, { paymentRecordId: 1 }); return true; } catch { return false; }
};
