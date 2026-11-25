import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { istTodayYyyymmdd } from '@/modules/common/utils/istDate';
import { PharmacyWalletModel, PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { assistedFlags } from '@/modules/assisted/flags';
import { lotsWritableWhen, withdrawableOfIn as lotsWithdrawableOfIn } from '@/modules/pharmacyWallet/walletLots';
import { chargeBackLotIn, postMovementIn, WALLET_POLICY, type TopupKind, type WalletStore } from '@/modules/pharmacyWallet/walletCore';
import { WalletTopupLotModel } from '@/modules/pharmacyWallet/model/lots';
import type { IPharmacyWallet, IPharmacyWalletTransaction } from '@/modules/pharmacyWallet/types';

/**
 * Assisted booking phase 1a (design §5.3, §17.3): the ONE writer of pharmacy wallet movements from phase 1a on. r13: the
 * money rules live in `walletCore.ts` (shared with the lab wallet); this file is the PHARMACY STORE (legacy rupee fields
 * written beside paise, `transactionType`, an ObjectId `pharmacyId`) and the pharmacy's entry points, unchanged in
 * signature and behaviour.
 *
 * - `balancePaise` is authoritative; `balance` (rupees) is written with it. Every row carries `signedAmountPaise`.
 * - Spending (`booking_debit`) is refused on a frozen or inactive wallet or a short balance (409). Credits
 *   (`refund_credit`, `credit`) ALWAYS post: inactive, frozen or suspended wallets and bookers included.
 */
export type PharmacyMovementKind = 'credit' | 'booking_debit' | 'refund_credit';

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
  /** Admin top-ups: the request's content hash and the admin (stored on the row). */
  requestHash?: string;
  actor?: { kind: 'admin'; id: string };
}

export interface PostedMovement { entry: IPharmacyWalletTransaction; wallet: IPharmacyWallet; replayed: boolean }

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const paiseOf = (w: { balancePaise?: number; balance?: number }) =>
  Number.isSafeInteger(w.balancePaise) ? Number(w.balancePaise) : Math.round(Number(w.balance ?? 0) * 100);

/**
 * The pharmacy wallet store. `rawId` is the id as the caller holds it (a payment record may spell it in upper case):
 * Mongoose casts it to the ObjectId `pharmacyId`; the lots use it lower-cased.
 */
export function pharmacyStore(rawId: string): WalletStore<IPharmacyWallet, IPharmacyWalletTransaction> {
  const pharmacyId = String(rawId);
  const lower = pharmacyId.toLowerCase();
  const byKey = async (operationKey: string, s: ClientSession | null) =>
    await PharmacyWalletTransactionModel.findOne({ pharmacyId, operationKey }).session(s).lean() as IPharmacyWalletTransaction | null;
  return {
    ref: { kind: 'pharmacy', id: lower },
    async ensure() {
      await PharmacyWalletModel.findOneAndUpdate({ pharmacyId }, { $setOnInsert: { balance: 0, balancePaise: 0, isActive: true } }, { new: true, upsert: true });
    },
    async walletIn(s) {
      const w = await PharmacyWalletModel.findOneAndUpdate({ pharmacyId },
        { $setOnInsert: { balance: 0, balancePaise: 0, isActive: true, withdrawableMinor: 0, version: 0 } },
        { upsert: true, new: true, session: s }).lean() as IPharmacyWallet | null;
      if (!w) throw err(500, 'WALLET_UNAVAILABLE', 'The wallet could not be read');
      return w;
    },
    findIn: async (s) => await PharmacyWalletModel.findOne({ pharmacyId }).session(s).lean() as IPharmacyWallet | null,
    state: (w) => ({ balanceMinor: paiseOf(w), withdrawableMinor: Number(w.withdrawableMinor ?? 0), receivableMinor: Number(w.receivableMinor ?? 0),
      frozen: w.frozen === true, isActive: w.isActive !== false }),
    async writeIn(w, next, s) {
      const $set: Record<string, unknown> = { version: Number(w.version ?? 0) + 1 };
      if (next.balanceMinor !== undefined) Object.assign($set, { balancePaise: next.balanceMinor, balance: next.balanceMinor / 100 });
      if (next.withdrawableMinor !== undefined) $set.withdrawableMinor = next.withdrawableMinor;
      if (next.receivableMinor !== undefined) $set.receivableMinor = next.receivableMinor;
      if (next.freeze) Object.assign($set, { frozen: true, frozenReason: next.freeze.reason, frozenAt: next.freeze.at });
      if (next.freeze === null) $set.frozen = false;
      return await PharmacyWalletModel.findOneAndUpdate({ _id: w._id, ...(w.version === undefined ? { version: { $exists: false } } : { version: w.version }) },
        { $set, ...(next.freeze === null ? { $unset: { frozenReason: 1, frozenAt: 1 } } : {}) }, { new: true, session: s }).lean() as IPharmacyWallet | null;
    },
    entryIn: byKey,
    async insertEntryIn(w, d, s) {
      const [row] = await PharmacyWalletTransactionModel.create([{
        ...(d._id ? { _id: d._id } : {}),
        pharmacyId, walletId: String(w._id), transactionType: d.kind, amount: d.amountMinor / 100, amountPaise: d.amountMinor,
        balanceBefore: d.beforeMinor / 100, balanceAfter: d.afterMinor / 100, balanceBeforePaise: d.beforeMinor, balanceAfterPaise: d.afterMinor, status: 'completed',
        referenceType: d.referenceType, referenceId: d.referenceId, description: d.description, ...(d.notes ? { notes: d.notes } : {}),
        transactionDate: istTodayYyyymmdd(), signedAmountPaise: d.signedMinor, operationKey: d.operationKey,
        ...(d.receivableDeltaMinor !== undefined ? { receivableDeltaPaise: d.receivableDeltaMinor } : {}),
        withdrawableDeltaPaise: d.withdrawableDeltaMinor, ...(d.lotAllocations?.length ? { lotAllocations: d.lotAllocations } : {}),
        ...(d.requestHash ? { requestHash: d.requestHash } : {}), ...(d.actor ? { actor: d.actor } : {}),
      }], { session: s });
      return row!.toObject() as IPharmacyWalletTransaction;
    },
    // r9b: the credit row however its pharmacy id was stored: an ObjectId (any spelling casts to it), or a raw string in
    // the record's own spelling or lower-cased. Read through the driver so the strings are not cast (the compound index applies).
    async rechargeCreditIn(paymentRecordId, s) {
      const row = await PharmacyWalletTransactionModel.collection.findOne({
        pharmacyId: { $in: [...(Types.ObjectId.isValid(lower) ? [new Types.ObjectId(lower)] : []), ...new Set([pharmacyId, lower])] },
        referenceType: 'wallet_recharge', referenceId: paymentRecordId, status: 'completed' },
      { session: s ?? undefined, projection: { _id: 1, amountPaise: 1, amount: 1 } });
      if (!row) return null;
      return { amountMinor: Number.isSafeInteger(row.amountPaise) && Number(row.amountPaise) > 0 ? Number(row.amountPaise) : Math.round(Number(row.amount ?? 0) * 100) };
    },
    adminTopupIn: async (key) => await PharmacyWalletTransactionModel.findOne({ pharmacyId, referenceType: 'topup', referenceId: key }).lean() as IPharmacyWalletTransaction | null,
    /**
     * r7: the two exact reads of an admin top-up by its key, each pinned to its unique ledger index (the reference: every
     * admin top-up, older rows have only this; then the operation key). r8 B1: a hinted read on a missing or different
     * (narrower) partial index would answer not_found; fail closed (503).
     */
    async adminTopupByKey(key) {
      await assertUniqueIndex(PharmacyWalletTransactionModel, { pharmacyId: 1, referenceType: 1, referenceId: 1 });
      await assertUniqueIndex(PharmacyWalletTransactionModel, { pharmacyId: 1, operationKey: 1 });
      for (const q of adminTopupByKeyLookups(pharmacyId, key)) {
        const row = await PharmacyWalletTransactionModel.findOne(q.filter).hint(q.hint).lean() as IPharmacyWalletTransaction | null;
        if (row) return row;
      }
      return null;
    },
    topupFacts: (e) => ({ ...(e.requestHash ? { requestHash: e.requestHash } : {}),
      amountMinor: Number(e.amountPaise ?? Math.round(Number(e.amount ?? 0) * 100)), notes: e.notes ?? null }),
  };
}

/** r7: the exact reads of an admin top-up by its key (see `pharmacyStore().adminTopupByKey`). */
export const adminTopupByKeyLookups = (pharmacyId: string, key: string) => [
  { filter: { pharmacyId: new Types.ObjectId(pharmacyId), referenceType: 'topup', referenceId: key },
    hint: { pharmacyId: 1, referenceType: 1, referenceId: 1 } },
  { filter: { pharmacyId: new Types.ObjectId(pharmacyId), operationKey: `admin_topup:${key}` }, hint: { pharmacyId: 1, operationKey: 1 } },
];

/** Pharmacy card top-ups (`notes.flow: 'pharmacy_wallet_recharge'`, the payer pharmacy on the record). */
export const pharmacyTopups: TopupKind<IPharmacyWallet, IPharmacyWalletTransaction> = {
  kind: 'pharmacy',
  flow: 'pharmacy_wallet_recharge',
  payerField: 'payerPharmacyId',
  ownerField: 'pharmacyId',
  isTopup: (r) => !!r && r.context === 'wallet_recharge' && !!r.payerPharmacyId && (r.notes as { flow?: unknown } | undefined)?.flow === 'pharmacy_wallet_recharge',
  ownerOf: (r) => String(r.payerPharmacyId).toLowerCase(),
  storeFor: (r) => pharmacyStore(String(r.payerPharmacyId)),
  store: (id) => pharmacyStore(id),
  // r32b: the production rule (`take`) until WALLET_CHARGEBACK_FLAG_ONLY is on; then flagged only, and the admin Recovers.
  chargeback: () => (assistedFlags.chargebackFlagOnly() ? 'flag' : 'take'),
  /** Lots are written only while the pharmacy switch is on AND their unique index is built (fail closed = no lot). */
  lotsWritable: lotsWritableWhen(assistedFlags.pharmacy),
  rechargeDescription: 'Pharmacy wallet recharge via Razorpay',
  // r32 (O2, §26.8.1): pharmacy card money is withdrawable 7 days after payment too (stored on each new lot).
  cardHoldDays: WALLET_POLICY.cardHoldDays,
};

/** Σ remaining of the pharmacy's lots that count as withdrawable (not closed, fee known, no dispute). */
export const withdrawableOfIn = (pharmacyId: string, s: ClientSession | null): Promise<number> =>
  lotsWithdrawableOfIn({ kind: 'pharmacy', id: String(pharmacyId).toLowerCase() }, s);

export async function postPharmacyMovementIn(m: PharmacyMovement, s: ClientSession): Promise<PostedMovement> {
  if (!Number.isSafeInteger(m.amountPaise) || m.amountPaise <= 0) throw err(500, 'INVALID_AMOUNT', 'A wallet movement needs a positive paise amount');
  if (!Types.ObjectId.isValid(m.pharmacyId)) throw err(404, 'PHARMACY_NOT_FOUND', 'Pharmacy not found');
  const { pharmacyId, amountPaise, ...rest } = m;
  return postMovementIn(pharmacyStore(pharmacyId), { ...rest, amountMinor: amountPaise }, s);
}

/**
 * Chargebacks (§5.3, production gate): a card dispute LOST on a pharmacy top-up lot (`chargeBackLotIn`, the `take` rule;
 * the lot route while WALLET_CHARGEBACK_FLAG_ONLY is off).
 */
export async function recordChargebackIn(lotId: string, s: ClientSession): Promise<PostedMovement> {
  if (!Types.ObjectId.isValid(lotId)) throw err(404, 'LOT_NOT_FOUND', 'Top-up not found');
  const lot = await WalletTopupLotModel.findById(lotId).session(s).lean();
  if (!lot || lot.walletRef.kind !== 'pharmacy') throw err(404, 'LOT_NOT_FOUND', 'Top-up not found');
  return chargeBackLotIn(pharmacyStore(lot.walletRef.id), lot, s);
}
