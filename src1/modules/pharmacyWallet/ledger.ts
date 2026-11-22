import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { istTodayYyyymmdd } from '@/modules/common/utils/istDate';
import { PharmacyWalletModel, PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { WalletTopupLotModel } from '@/modules/pharmacyWallet/model/lots';
import { PaymentRecordModel } from '@/modules/payment/model';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import type { IPharmacyWallet, IPharmacyWalletTransaction } from '@/modules/pharmacyWallet/types';

/**
 * Assisted booking phase 1a (design §5.3, §17.3): the ONE writer of pharmacy wallet movements from phase 1a on.
 *
 * - Exactly once per (pharmacy, `operationKey`): a repeat answers with the movement already posted.
 * - Inside the caller's transaction: the wallet is read in the transaction and written back (a concurrent movement makes
 *   one of the two transactions conflict and retry, so the balance can never be decided on a stale read).
 * - `balancePaise` is authoritative; `balance` (rupees) is written with it. Every row carries `signedAmountPaise`.
 * - Spending (`booking_debit`) is refused on a frozen or inactive wallet or a short balance (409). Credits
 *   (`refund_credit`, `credit`) ALWAYS post: inactive, frozen or suspended wallets and bookers included.
 * - Lots: a card top-up credit opens a lot; a spend consumes lots oldest first (ASSUMED D9), then non-withdrawable
 *   money, and records its `lotAllocations`; a refund restores exactly those allocations (a closed lot is never restored:
 *   that part returns as non-withdrawable). `withdrawableMinor` is recomputed from the lots on every movement.
 */
export type PharmacyMovementKind = 'credit' | 'booking_debit' | 'refund_credit';
const DEBITS: PharmacyMovementKind[] = ['booking_debit'];

export interface PharmacyMovement {
  pharmacyId: string;
  kind: PharmacyMovementKind;
  /** Positive paise. */
  amountPaise: number;
  operationKey: string;
  referenceType: string;
  referenceId: string;
  description: string;
  notes?: string;
  /** Pre-chosen entry id (so the caller can store it on its own record in the same transaction). */
  entryId?: Types.ObjectId;
  /** A card top-up: opens a lot for this payment record. */
  lot?: { paymentRecordId: string; gatewayFeeMinor?: number | null };
  /** A refund: the allocations of the spend it reverses. */
  restore?: { lotId: string; amountPaise: number }[];
}

export interface PostedMovement { entry: IPharmacyWalletTransaction; wallet: IPharmacyWallet; replayed: boolean }

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const walletRefId = (pharmacyId: string) => String(pharmacyId).toLowerCase();
const paiseOf = (w: { balancePaise?: number; balance?: number }) =>
  Number.isSafeInteger(w.balancePaise) ? Number(w.balancePaise) : Math.round(Number(w.balance ?? 0) * 100);

/** The wallet as read in this transaction, created (empty) when missing. */
export async function pharmacyWalletIn(pharmacyId: string, s: ClientSession): Promise<IPharmacyWallet> {
  const w = await PharmacyWalletModel.findOneAndUpdate({ pharmacyId },
    { $setOnInsert: { balance: 0, balancePaise: 0, isActive: true, withdrawableMinor: 0, version: 0 } },
    { upsert: true, new: true, session: s }).lean() as IPharmacyWallet | null;
  if (!w) throw err(500, 'WALLET_UNAVAILABLE', 'The wallet could not be read');
  return w;
}

/** Σ remaining of the lots that count as withdrawable (not closed, fee known, no dispute). */
export async function withdrawableOfIn(pharmacyId: string, s: ClientSession | null): Promise<number> {
  const lots = await WalletTopupLotModel.find({ 'walletRef.kind': 'pharmacy', 'walletRef.id': walletRefId(pharmacyId), closed: false,
    feeState: 'known', disputeState: 'none', remainingMinor: { $gt: 0 } }).select({ remainingMinor: 1 }).session(s).lean();
  return lots.reduce((a, l) => a + Number(l.remainingMinor || 0), 0);
}

async function consumeLots(pharmacyId: string, amount: number, s: ClientSession): Promise<{ lotId: string; amountPaise: number }[]> {
  const lots = await WalletTopupLotModel.find({ 'walletRef.kind': 'pharmacy', 'walletRef.id': walletRefId(pharmacyId), closed: false,
    remainingMinor: { $gt: 0 } }).sort({ createdAt: 1, _id: 1 }).session(s).lean();
  const out: { lotId: string; amountPaise: number }[] = [];
  let left = amount;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(left, Number(lot.remainingMinor));
    if (!(take > 0)) continue;
    const r = await WalletTopupLotModel.updateOne({ _id: lot._id, remainingMinor: lot.remainingMinor }, { $inc: { remainingMinor: -take } }, { session: s });
    if (r.modifiedCount !== 1) throw Object.assign(err(409, 'WALLET_CHANGED', 'The wallet changed; please retry'), { retryable: true });
    out.push({ lotId: String(lot._id), amountPaise: take });
    left -= take;
  }
  return out;
}

async function restoreLots(allocations: { lotId: string; amountPaise: number }[], s: ClientSession) {
  const out: { lotId: string; amountPaise: number }[] = [];
  for (const a of allocations) {
    if (!Types.ObjectId.isValid(a.lotId) || !(a.amountPaise > 0)) continue;
    // A lot closed for good (lost chargeback, N10) is never restored: that money comes back non-withdrawable.
    const r = await WalletTopupLotModel.updateOne({ _id: a.lotId, closed: false, $expr: { $lte: [{ $add: ['$remainingMinor', a.amountPaise] }, '$amountMinor'] } },
      { $inc: { remainingMinor: a.amountPaise } }, { session: s });
    if (r.modifiedCount === 1) out.push({ lotId: a.lotId, amountPaise: a.amountPaise });
  }
  return out;
}

export async function postPharmacyMovementIn(m: PharmacyMovement, s: ClientSession): Promise<PostedMovement> {
  if (!Number.isSafeInteger(m.amountPaise) || m.amountPaise <= 0) throw err(500, 'INVALID_AMOUNT', 'A wallet movement needs a positive paise amount');
  if (!Types.ObjectId.isValid(m.pharmacyId)) throw err(404, 'PHARMACY_NOT_FOUND', 'Pharmacy not found');
  const prior = await PharmacyWalletTransactionModel.findOne({ pharmacyId: m.pharmacyId, operationKey: m.operationKey }).session(s).lean() as IPharmacyWalletTransaction | null;
  if (prior) {
    const wallet = await PharmacyWalletModel.findOne({ pharmacyId: m.pharmacyId }).session(s).lean() as IPharmacyWallet;
    return { entry: prior, wallet, replayed: true };
  }
  const wallet = await pharmacyWalletIn(m.pharmacyId, s);
  const debit = DEBITS.includes(m.kind);
  const before = paiseOf(wallet);
  if (debit) {
    if (Number(wallet.receivableMinor ?? 0) > 0) throw err(409, 'WALLET_RECEIVABLE', 'This wallet owes Jansetu money (a lost card dispute); top it up first');
    if (wallet.frozen === true) throw err(409, 'WALLET_FROZEN', 'This wallet is frozen; contact Jansetu support');
    if (wallet.isActive === false) throw err(409, 'WALLET_INACTIVE', 'This wallet is not active');
    if (before < m.amountPaise) throw err(409, 'INSUFFICIENT_BALANCE', `Insufficient wallet balance. Available: ₹${(before / 100).toFixed(2)}`);
  }
  const signed = debit ? -m.amountPaise : m.amountPaise;
  const after = before + signed;
  let lotAllocations: { lotId: string; amountPaise: number }[] | undefined;
  if (debit) lotAllocations = await consumeLots(m.pharmacyId, m.amountPaise, s);
  else if (m.restore?.length) lotAllocations = await restoreLots(m.restore, s);
  if (m.lot) {
    const fee = typeof m.lot.gatewayFeeMinor === 'number' && Number.isSafeInteger(m.lot.gatewayFeeMinor) && m.lot.gatewayFeeMinor >= 0 ? m.lot.gatewayFeeMinor : null;
    await WalletTopupLotModel.create([{ walletRef: { kind: 'pharmacy', id: walletRefId(m.pharmacyId) }, paymentRecordId: m.lot.paymentRecordId,
      amountMinor: m.amountPaise, ...(fee !== null ? { gatewayFeeMinor: fee } : {}), feeState: fee !== null ? 'known' : 'unknown', disputeState: 'none',
      closed: false, remainingMinor: m.amountPaise }], { session: s });
  }
  const withdrawableBefore = Number(wallet.withdrawableMinor ?? 0);
  const withdrawableAfter = await withdrawableOfIn(m.pharmacyId, s);
  const updated = await PharmacyWalletModel.findOneAndUpdate({ _id: wallet._id, ...(wallet.version === undefined ? { version: { $exists: false } } : { version: wallet.version }) },
    { $set: { balancePaise: after, balance: after / 100, withdrawableMinor: withdrawableAfter, version: Number(wallet.version ?? 0) + 1 } },
    { new: true, session: s }).lean() as IPharmacyWallet | null;
  if (!updated) throw Object.assign(err(409, 'WALLET_CHANGED', 'The wallet changed; please retry'), { retryable: true });
  const [entry] = await PharmacyWalletTransactionModel.create([{
    ...(m.entryId ? { _id: m.entryId } : {}),
    pharmacyId: m.pharmacyId, walletId: String(wallet._id), transactionType: m.kind, amount: m.amountPaise / 100, amountPaise: m.amountPaise,
    balanceBefore: before / 100, balanceAfter: after / 100, balanceBeforePaise: before, balanceAfterPaise: after, status: 'completed',
    referenceType: m.referenceType, referenceId: m.referenceId, description: m.description, ...(m.notes ? { notes: m.notes } : {}),
    transactionDate: istTodayYyyymmdd(), signedAmountPaise: signed, operationKey: m.operationKey,
    withdrawableDeltaPaise: withdrawableAfter - withdrawableBefore, ...(lotAllocations?.length ? { lotAllocations } : {}),
  }], { session: s });
  // Chargebacks (§5.3): a credit arriving on a wallet that owes a receivable clears it first (`receivable_setoff`).
  const owed = Number(updated.receivableMinor ?? 0);
  if (!debit && owed > 0) {
    const setoff = Math.min(owed, m.amountPaise, after);
    if (setoff > 0) {
      const setoffLots = await consumeLots(m.pharmacyId, setoff, s);
      const wBefore = Number(updated.withdrawableMinor ?? 0);
      const wAfter = await withdrawableOfIn(m.pharmacyId, s);
      const cleared = await PharmacyWalletModel.findOneAndUpdate({ _id: wallet._id, version: updated.version },
        { $set: { balancePaise: after - setoff, balance: (after - setoff) / 100, withdrawableMinor: wAfter, receivableMinor: owed - setoff,
          version: Number(updated.version ?? 0) + 1 } }, { new: true, session: s }).lean() as IPharmacyWallet | null;
      if (!cleared) throw Object.assign(err(409, 'WALLET_CHANGED', 'The wallet changed; please retry'), { retryable: true });
      await PharmacyWalletTransactionModel.create([{
        pharmacyId: m.pharmacyId, walletId: String(wallet._id), transactionType: 'receivable_setoff', amount: setoff / 100, amountPaise: setoff,
        balanceBefore: after / 100, balanceAfter: (after - setoff) / 100, balanceBeforePaise: after, balanceAfterPaise: after - setoff, status: 'completed',
        referenceType: 'receivable_setoff', referenceId: `${m.operationKey}:setoff`, description: 'Owed amount cleared from this credit',
        transactionDate: istTodayYyyymmdd(), signedAmountPaise: -setoff, operationKey: `${m.operationKey}:setoff`, receivableDeltaPaise: -setoff,
        withdrawableDeltaPaise: wAfter - wBefore, ...(setoffLots.length ? { lotAllocations: setoffLots } : {}),
      }], { session: s });
      return { entry: entry!.toObject() as IPharmacyWalletTransaction, wallet: cleared, replayed: false };
    }
  }
  return { entry: entry!.toObject() as IPharmacyWalletTransaction, wallet: updated, replayed: false };
}

/**
 * Chargebacks (§5.3, production gate): an admin records a card dispute LOST on a top-up lot. In the caller's
 * transaction, exactly once per lot: the lot is closed for good (never restored or withdrawable again); the wallet is
 * debited the lot's amount — what the balance cannot cover becomes `receivableMinor`, owed by the partner (the balance
 * itself never goes below zero, so balance = Σ entries holds); the wallet is frozen. A frozen wallet or one with a
 * receivable funds nothing; a later credit clears the receivable first.
 */
export async function recordChargebackIn(lotId: string, s: ClientSession): Promise<{ entry: IPharmacyWalletTransaction; wallet: IPharmacyWallet; replayed: boolean }> {
  if (!Types.ObjectId.isValid(lotId)) throw err(404, 'LOT_NOT_FOUND', 'Top-up not found');
  const lot = await WalletTopupLotModel.findById(lotId).session(s).lean();
  if (!lot || lot.walletRef.kind !== 'pharmacy') throw err(404, 'LOT_NOT_FOUND', 'Top-up not found');
  const pharmacyId = lot.walletRef.id;
  const key = `chargeback:${String(lot._id)}`;
  const prior = await PharmacyWalletTransactionModel.findOne({ pharmacyId, operationKey: key }).session(s).lean() as IPharmacyWalletTransaction | null;
  if (prior) return { entry: prior, wallet: await PharmacyWalletModel.findOne({ pharmacyId }).session(s).lean() as IPharmacyWallet, replayed: true };
  const closed = await WalletTopupLotModel.updateOne({ _id: lot._id, disputeState: { $ne: 'lost' } },
    { $set: { closed: true, disputeState: 'lost', remainingMinor: 0 } }, { session: s });
  if (closed.modifiedCount !== 1) throw Object.assign(err(409, 'WALLET_CHANGED', 'The top-up changed; please retry'), { retryable: true });
  const wallet = await pharmacyWalletIn(pharmacyId, s);
  const before = paiseOf(wallet);
  const amount = Number(lot.amountMinor);
  const fromBalance = Math.min(before, amount);
  const shortfall = amount - fromBalance;
  const after = before - fromBalance;
  // The lot's own unspent money left with it (closed above); what else the balance gives up comes out of the other lots
  // (oldest first), so open lots never exceed the balance.
  // Review of db252c1 (item c): a lot recorded at the chargeback (`openedAtChargeback`: the top-up was credited
  // non-withdrawable) gives up the non-lot money first, and the other open lots only for the remainder, so card money
  // that is still honest stays withdrawable.
  let beyondLot = Math.max(0, fromBalance - Number(lot.remainingMinor || 0));
  if (lot.openedAtChargeback === true && beyondLot > 0) {
    const openLotsMinor = (await WalletTopupLotModel.find({ 'walletRef.kind': 'pharmacy', 'walletRef.id': walletRefId(pharmacyId), closed: false,
      remainingMinor: { $gt: 0 } }).select({ remainingMinor: 1 }).session(s).lean()).reduce((a, l) => a + Number(l.remainingMinor || 0), 0);
    beyondLot = Math.max(0, beyondLot - Math.max(0, before - openLotsMinor));
  }
  const lotAllocations = beyondLot > 0 ? await consumeLots(pharmacyId, beyondLot, s) : [];
  const withdrawableBefore = Number(wallet.withdrawableMinor ?? 0);
  const withdrawableAfter = await withdrawableOfIn(pharmacyId, s);
  const updated = await PharmacyWalletModel.findOneAndUpdate({ _id: wallet._id, ...(wallet.version === undefined ? { version: { $exists: false } } : { version: wallet.version }) },
    { $set: { balancePaise: after, balance: after / 100, withdrawableMinor: withdrawableAfter, receivableMinor: Number(wallet.receivableMinor ?? 0) + shortfall,
      frozen: true, frozenReason: 'Card dispute lost on a top-up', frozenAt: new Date(), version: Number(wallet.version ?? 0) + 1 } },
    { new: true, session: s }).lean() as IPharmacyWallet | null;
  if (!updated) throw Object.assign(err(409, 'WALLET_CHANGED', 'The wallet changed; please retry'), { retryable: true });
  const [entry] = await PharmacyWalletTransactionModel.create([{
    pharmacyId, walletId: String(wallet._id), transactionType: 'chargeback', amount: fromBalance / 100, amountPaise: fromBalance,
    balanceBefore: before / 100, balanceAfter: after / 100, balanceBeforePaise: before, balanceAfterPaise: after, status: 'completed',
    referenceType: 'chargeback', referenceId: String(lot._id), description: 'Card dispute lost on a top-up', transactionDate: istTodayYyyymmdd(),
    signedAmountPaise: -fromBalance, operationKey: key, receivableDeltaPaise: shortfall, withdrawableDeltaPaise: withdrawableAfter - withdrawableBefore,
    ...(lotAllocations.length ? { lotAllocations } : {}),
  }], { session: s });
  return { entry: entry!.toObject() as IPharmacyWalletTransaction, wallet: updated, replayed: false };
}

/** A card top-up of a pharmacy wallet, named by its payment record id or its Razorpay payment id. */
const RAZORPAY_PAYMENT_ID = /^pay_[A-Za-z0-9]{6,40}$/;
const isPharmacyTopup = (r: Record<string, any> | null) => !!r && r.context === 'wallet_recharge' && !!r.payerPharmacyId
  && (r.notes as { flow?: unknown } | undefined)?.flow === 'pharmacy_wallet_recharge';

/**
 * Review of 800dfc0 (item 1, production gate): a card dispute lost on a top-up that has NO lot (credited while the
 * pharmacy switch was off, before sync-indexes, or before phase 1a). `paymentId` is the payment record id or the Razorpay
 * payment id of the credited top-up. Same rules as a lot chargeback, in the caller's transaction:
 * - a top-up WITH a lot goes through `recordChargebackIn` (same operation key, so the lot and payment paths never charge
 *   one payment back twice);
 * - otherwise a lot is recorded for the payment now, already closed (`openedAtChargeback`, nothing left in it, never
 *   withdrawable), and charged back exactly as a lot is (balance to 0 at most, the rest owed as `receivableMinor`, the
 *   wallet frozen). The lot's unique `paymentRecordId` index makes this once per payment under concurrency (a racing
 *   twin conflicts; its retry answers replayed); it is checked first, fail closed (503 INDEXES_OUTDATED).
 * - a top-up never credited (review of db252c1, item a): nothing is taken; the payment record is BLOCKED in this
 *   transaction (`chargebackAt`, status `failed`; a refunded one keeps its status), guarded on the status read, so verify,
 *   reconcile, the top-up check and the sweep refuse it (409 TOPUP_BLOCKED) and it is never credited. The credit claims
 *   the record with a write in its own transaction, so the block and a credit cannot pass each other: either it was
 *   credited first (this transaction conflicts, retries and charges it back) or it is blocked and never credited.
 * Not a pharmacy top-up → 404 TOPUP_NOT_FOUND.
 */
export type PaymentChargeback =
  | (PostedMovement & { blockedUncredited: false; lotId: string; paymentRecordId: string; withoutLot: boolean })
  | { blockedUncredited: true; replayed: boolean; paymentRecordId: string; pharmacyId: string };

export async function recordPaymentChargebackIn(paymentId: string, s: ClientSession): Promise<PaymentChargeback> {
  const notFound = () => err(404, 'TOPUP_NOT_FOUND', 'Top-up not found');
  const id = String(paymentId ?? '');
  let records: Record<string, any>[] = [];
  if (Types.ObjectId.isValid(id) && /^[0-9a-fA-F]{24}$/.test(id)) {
    const r = await PaymentRecordModel.findById(id).session(s).lean() as Record<string, any> | null;
    records = r ? [r] : [];
  } else if (RAZORPAY_PAYMENT_ID.test(id)) {
    records = await PaymentRecordModel.find({ razorpayPaymentId: { $eq: id } }).limit(5).session(s).lean() as Record<string, any>[];
  }
  records = records.filter(isPharmacyTopup);
  if (records.length > 1) throw err(409, 'PAYMENT_AMBIGUOUS', 'More than one top-up carries this payment id; use the payment record id');
  const record = records[0];
  if (!record) throw notFound();
  const paymentRecordId = String(record._id);
  const pharmacyId = String(record.payerPharmacyId).toLowerCase();
  if (!Types.ObjectId.isValid(pharmacyId)) throw notFound();
  await assertUniqueIndex(WalletTopupLotModel, { paymentRecordId: 1 });
  const existing = await WalletTopupLotModel.findOne({ paymentRecordId: { $eq: paymentRecordId } }).session(s).lean();
  if (existing) {
    if (existing.walletRef.kind !== 'pharmacy' || existing.walletRef.id !== pharmacyId) throw notFound();
    const r = await recordChargebackIn(String(existing._id), s);
    return { ...r, blockedUncredited: false, lotId: String(existing._id), paymentRecordId, withoutLot: existing.openedAtChargeback === true };
  }
  const credit = await PharmacyWalletTransactionModel.findOne({ pharmacyId, referenceType: 'wallet_recharge', referenceId: paymentRecordId, status: 'completed' })
    .session(s).lean() as IPharmacyWalletTransaction | null;
  if (!credit) {
    if (record.chargebackAt) return { blockedUncredited: true, replayed: true, paymentRecordId, pharmacyId };
    const blocked = await PaymentRecordModel.updateOne({ _id: record._id, status: record.status, chargebackAt: { $exists: false }, walletCreditedAt: { $exists: false } },
      { $set: { chargebackAt: new Date(), ...(record.status !== 'refunded' ? { status: 'failed' } : {}) } }, { session: s });
    if (blocked.modifiedCount !== 1) throw Object.assign(err(409, 'WALLET_CHANGED', 'The top-up changed; please retry'), { retryable: true });
    return { blockedUncredited: true, replayed: false, paymentRecordId, pharmacyId };
  }
  const amountMinor = Number.isSafeInteger(credit.amountPaise) && Number(credit.amountPaise) > 0 ? Number(credit.amountPaise) : Math.round(Number(credit.amount ?? 0) * 100);
  if (!(amountMinor > 0)) throw notFound();
  const fee = typeof record.gatewayFeeMinor === 'number' && Number.isSafeInteger(record.gatewayFeeMinor) && record.gatewayFeeMinor >= 0 ? record.gatewayFeeMinor : null;
  const [lot] = await WalletTopupLotModel.create([{ walletRef: { kind: 'pharmacy', id: pharmacyId }, paymentRecordId, amountMinor,
    ...(fee !== null ? { gatewayFeeMinor: fee } : {}), feeState: fee !== null ? 'known' : 'unknown', disputeState: 'none', closed: true, remainingMinor: 0,
    openedAtChargeback: true }], { session: s });
  const r = await recordChargebackIn(String(lot!._id), s);
  return { ...r, blockedUncredited: false, lotId: String(lot!._id), paymentRecordId, withoutLot: true };
}

/** Recomputes `withdrawableMinor` from the lots (a lot's fee became known), in the caller's transaction. */
export async function refreshWithdrawableIn(pharmacyId: string, s: ClientSession): Promise<void> {
  const wallet = await PharmacyWalletModel.findOne({ pharmacyId }).session(s).lean() as IPharmacyWallet | null;
  if (!wallet) return;
  const value = await withdrawableOfIn(pharmacyId, s);
  if (value === Number(wallet.withdrawableMinor ?? 0)) return;
  await PharmacyWalletModel.updateOne({ _id: wallet._id }, { $set: { withdrawableMinor: value }, $inc: { version: 1 } }, { session: s });
}
