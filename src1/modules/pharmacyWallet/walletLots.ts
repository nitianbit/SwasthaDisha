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

/** The lots that hold card money (not closed, fee known, no dispute). */
const CARD_MONEY = { closed: false, feeState: 'known', disputeState: 'none', remainingMinor: { $gt: 0 } };

/**
 * Σ remaining of the lots that count as withdrawable card money (not closed, fee known, no dispute). r32 (M5): this is the
 * STORED `withdrawableMinor` — card money, lots still inside their 7-day card hold included — which the daily invariant
 * checks; what may be withdrawn now is `withdrawableNowOf` (computed at read and at request).
 */
export async function withdrawableOfIn(ref: WalletRef, s: ClientSession | null): Promise<number> {
  const lots = await WalletTopupLotModel.find({ ...refFilter(ref), ...CARD_MONEY }).select({ remainingMinor: 1 }).session(s).lean();
  return lots.reduce((a, l) => a + Number(l.remainingMinor || 0), 0);
}

/** O2: card money waits this long after payment; a lot written before the field existed counts from its creation (M12). */
export const CARD_HOLD_DAYS = 7;
const CARD_HOLD_MS = CARD_HOLD_DAYS * 86_400_000;
const releasedAt = (l: Pick<IWalletTopupLot, 'withdrawableAfter' | 'createdAt'>) =>
  new Date(l.withdrawableAfter ? new Date(l.withdrawableAfter).getTime() : new Date(l.createdAt ?? 0).getTime() + CARD_HOLD_MS);
/** r32 (§26.8.1, O2): the card-money lots past their card hold at `now` (a lot without `withdrawableAfter`: created + 7 days). */
export const withdrawableNowFilter = (now: Date) => ({ ...CARD_MONEY,
  $or: [{ withdrawableAfter: { $lte: now } }, { withdrawableAfter: { $exists: false }, createdAt: { $lte: new Date(now.getTime() - CARD_HOLD_MS) } }] });

/**
 * r32 (§26.8.1, M5): what may be withdrawn now — card money past its 7-day hold — and when the rest becomes withdrawable
 * (one line per day, earliest first). Read only.
 */
export async function withdrawableNowOf(ref: WalletRef, now: Date, s: ClientSession | null = null):
Promise<{ nowMinor: number; later: { amountMinor: number; availableAt: Date }[] }> {
  const lots = await WalletTopupLotModel.find({ ...refFilter(ref), ...CARD_MONEY }).select({ remainingMinor: 1, withdrawableAfter: 1, createdAt: 1 })
    .session(s).lean() as IWalletTopupLot[];
  let nowMinor = 0;
  const later = new Map<number, number>();
  for (const l of lots) {
    const at = releasedAt(l);
    if (at.getTime() <= now.getTime()) nowMinor += Number(l.remainingMinor);
    else later.set(at.getTime(), (later.get(at.getTime()) ?? 0) + Number(l.remainingMinor));
  }
  return { nowMinor, later: [...later.entries()].sort((a, b) => a[0] - b[0]).map(([t, amountMinor]) => ({ amountMinor, availableAt: new Date(t) })) };
}

/** Σ remaining of every open lot (withdrawable or not). */
export async function openLotsMinorIn(ref: WalletRef, s: ClientSession | null): Promise<number> {
  const lots = await WalletTopupLotModel.find({ ...refFilter(ref), closed: false, remainingMinor: { $gt: 0 } })
    .select({ remainingMinor: 1 }).session(s).lean();
  return lots.reduce((a, l) => a + Number(l.remainingMinor || 0), 0);
}

/** The open lots a spend of `amount` takes, oldest first (ASSUMED D9), each with what it takes (read only). */
async function lotsToTake(ref: WalletRef, amount: number, s: ClientSession | null, only: Record<string, unknown>) {
  const lots = await WalletTopupLotModel.find({ ...refFilter(ref), closed: false,
    remainingMinor: { $gt: 0 }, ...only }).sort({ createdAt: 1, _id: 1 }).session(s).lean() as (IWalletTopupLot & { _id: unknown })[];
  const out: { lot: IWalletTopupLot & { _id: unknown }; take: number }[] = [];
  let left = amount;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(left, Number(lot.remainingMinor));
    if (!(take > 0)) continue;
    out.push({ lot, take });
    left -= take;
  }
  return out;
}

/**
 * A spend takes the open lots oldest first (ASSUMED D9) and returns what it took from each. r32: `only` narrows the lots it
 * may take (a withdrawal hold takes only card money withdrawable now, `withdrawableNowFilter`).
 */
export async function consumeLots(ref: WalletRef, amount: number, s: ClientSession, only: Record<string, unknown> = {}): Promise<LotAllocation[]> {
  const out: LotAllocation[] = [];
  for (const { lot, take } of await lotsToTake(ref, amount, s, only)) {
    const r = await WalletTopupLotModel.updateOne({ _id: lot._id, remainingMinor: lot.remainingMinor }, { $inc: { remainingMinor: -take } }, { session: s });
    if (r.modifiedCount !== 1) throw changed();
    out.push({ lotId: String(lot._id), amountPaise: take });
  }
  return out;
}

/** r32: what `consumeLots` would take with the same lots (read only), with each lot's amount and gateway fee (a withdrawal's fee). */
export async function planLots(ref: WalletRef, amount: number, s: ClientSession | null, only: Record<string, unknown> = {}):
Promise<{ lotId: string; amountPaise: number; lotAmountMinor: number; gatewayFeeMinor: number }[]> {
  return (await lotsToTake(ref, amount, s, only)).map(({ lot, take }) => ({ lotId: String(lot._id), amountPaise: take,
    lotAmountMinor: Number(lot.amountMinor), gatewayFeeMinor: Number(lot.gatewayFeeMinor ?? 0) }));
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
