import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import { assistedFlags } from '@/modules/assisted/flags';
import PartnerModel from '@/modules/partners/model';
import { WalletTopupLotModel } from '@/modules/pharmacyWallet/model/lots';
import { postMovementIn, type Posted, type TopupKind, type WalletStore } from '@/modules/pharmacyWallet/walletCore';
import type { LotAllocation } from '@/modules/pharmacyWallet/walletLots';
import {
  PartnerWalletEntryModel, PartnerWalletModel, type IPartnerWallet, type IPartnerWalletEntry, type PartnerWalletEntryKind, type PartnerWalletOwnerKind,
} from '@/modules/partnerWallets/model';

/**
 * r13 (round 2d, §24.7): the PARTNER STORE (`partner_wallets` / `partner_wallet_entries`) for the shared wallet rules of
 * `pharmacyWallet/walletCore.ts`, the lab top-up kind, and the lab wallet's debit and refund (what spends it is 2e).
 */

/**
 * O2 (owner, 25 Nov): ₹50,000 most a lab wallet may hold (checked when a top-up is ordered; a paid top-up is always
 * credited); withdrawals (phase 4, off): one a week, card money withdrawable 7 days after payment (stored on each lot).
 * Admin top-ups: at most ₹2,00,000 each (as the pharmacy admin form), never withdrawable (L20).
 */
export const LAB_WALLET_POLICY = {
  maxBalanceMinor: 5_000_000,
  minTopupMinor: 100,
  withdrawalsPerWeek: 1,
  cardHoldDays: 7,
  adminTopupMaxMinor: 20_000_000,
} as const;

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const EMPTY = { balanceMinor: 0, withdrawableMinor: 0, receivableMinor: 0, frozen: false, isActive: true, version: 0 };

/** Every unique index the partner store's exactly-once writes rely on (503 INDEXES_OUTDATED until sync-indexes). */
export async function assertPartnerWalletIndexes(): Promise<void> {
  await assertUniqueIndex(PartnerWalletModel, { ownerKind: 1, ownerId: 1 });
  await assertUniqueIndex(PartnerWalletEntryModel, { walletId: 1, operationKey: 1 });
  await assertUniqueIndex(WalletTopupLotModel, { paymentRecordId: 1 });
}

export function partnerStore(ownerKind: PartnerWalletOwnerKind, ownerIdIn: string): WalletStore<IPartnerWallet, IPartnerWalletEntry> {
  const ownerId = String(ownerIdIn).toLowerCase();
  const owner = { ownerKind, ownerId };
  const findIn = async (s: ClientSession | null) => await PartnerWalletModel.findOne(owner).session(s).lean() as IPartnerWallet | null;
  const entryIn = async (operationKey: string, s: ClientSession | null) => {
    const w = await findIn(s);
    return w ? await PartnerWalletEntryModel.findOne({ walletId: String(w._id), operationKey }).session(s).lean() as IPartnerWalletEntry | null : null;
  };
  return {
    ref: { kind: ownerKind, id: ownerId },
    async ensure() {
      try { await PartnerWalletModel.updateOne(owner, { $setOnInsert: EMPTY }, { upsert: true }); } catch (e) { if (!isDuplicateKeyError(e)) throw e; }
    },
    async walletIn(s) {
      const w = await PartnerWalletModel.findOneAndUpdate(owner, { $setOnInsert: EMPTY }, { upsert: true, new: true, session: s }).lean() as IPartnerWallet | null;
      if (!w) throw err(500, 'WALLET_UNAVAILABLE', 'The wallet could not be read');
      return w;
    },
    findIn,
    state: (w) => ({ balanceMinor: w.balanceMinor, withdrawableMinor: w.withdrawableMinor, receivableMinor: w.receivableMinor, frozen: w.frozen === true,
      isActive: w.isActive !== false }),
    async writeIn(w, next, s) {
      const $set: Record<string, unknown> = { version: w.version + 1 };
      if (next.balanceMinor !== undefined) $set.balanceMinor = next.balanceMinor;
      if (next.withdrawableMinor !== undefined) $set.withdrawableMinor = next.withdrawableMinor;
      if (next.receivableMinor !== undefined) $set.receivableMinor = next.receivableMinor;
      if (next.freeze) Object.assign($set, { frozen: true, frozenReason: next.freeze.reason, frozenAt: next.freeze.at });
      if (next.freeze === null) $set.frozen = false;
      return await PartnerWalletModel.findOneAndUpdate({ _id: w._id, version: w.version },
        { $set, ...(next.freeze === null ? { $unset: { frozenReason: 1, frozenAt: 1 } } : {}) }, { new: true, session: s }).lean() as IPartnerWallet | null;
    },
    entryIn,
    async insertEntryIn(w, d, s) {
      const [row] = await PartnerWalletEntryModel.create([{
        ...(d._id ? { _id: d._id } : {}), walletId: String(w._id), ownerKind, ownerId, kind: d.kind as PartnerWalletEntryKind,
        amountMinor: d.signedMinor, balanceAfterMinor: d.afterMinor, withdrawableDeltaMinor: d.withdrawableDeltaMinor, receivableDeltaMinor: d.receivableDeltaMinor ?? 0,
        operationKey: d.operationKey, referenceType: d.referenceType, referenceId: d.referenceId, description: d.description,
        ...(d.notes ? { notes: d.notes } : {}), ...(d.lotAllocations?.length ? { lotAllocations: d.lotAllocations } : {}),
        ...(d.requestHash ? { requestHash: d.requestHash } : {}), ...(d.actor ? { actor: d.actor } : {}), at: new Date(),
      }], { session: s });
      return row!.toObject() as IPartnerWalletEntry;
    },
    async rechargeCreditIn(paymentRecordId, s) {
      const e = await entryIn(`wallet_recharge:${paymentRecordId}`, s);
      return e ? { amountMinor: Math.abs(e.amountMinor) } : null;
    },
    adminTopupIn: (key) => entryIn(`admin_topup:${key}`, null),
    async adminTopupByKey(key) {
      await assertUniqueIndex(PartnerWalletModel, { ownerKind: 1, ownerId: 1 });
      await assertUniqueIndex(PartnerWalletEntryModel, { walletId: 1, operationKey: 1 });
      return entryIn(`admin_topup:${key}`, null);
    },
    topupFacts: (e) => ({ ...(e.requestHash ? { requestHash: e.requestHash } : {}), amountMinor: Math.abs(e.amountMinor), notes: e.notes ?? null }),
  };
}

export const labStore = (partnerId: string) => partnerStore('lab', partnerId);

/** Lab card top-ups (`notes.flow: 'lab_wallet_recharge'`, the paying lab on the record as `payerPartnerId`). */
export const labTopups: TopupKind<IPartnerWallet, IPartnerWalletEntry> = {
  kind: 'lab',
  flow: 'lab_wallet_recharge',
  isTopup: (r) => !!r && r.context === 'wallet_recharge' && typeof r.payerPartnerId === 'string' && !!r.payerPartnerId
    && (r.notes as { flow?: unknown } | undefined)?.flow === 'lab_wallet_recharge',
  ownerOf: (r) => String(r.payerPartnerId).toLowerCase(),
  storeFor: (r) => labStore(String(r.payerPartnerId)),
  store: labStore,
  // Owner C4 (card disputes): recorded and flagged only.
  chargeback: 'flag',
  async lotsWritable() {
    if (!assistedFlags.lab()) return false;
    try { await assertUniqueIndex(WalletTopupLotModel, { paymentRecordId: 1 }); return true; } catch { return false; }
  },
  rechargeDescription: 'Lab wallet recharge via Razorpay',
  cardHoldDays: LAB_WALLET_POLICY.cardHoldDays,
};

/** The lab, read for an admin tool or a guard: any lab (any state); anything else is the one 404. */
export async function labOrNotFound(partnerId: string): Promise<{ _id: unknown; isActive?: boolean; verification?: { state?: string } }> {
  const p = Types.ObjectId.isValid(partnerId) && /^[0-9a-fA-F]{24}$/.test(partnerId)
    ? await PartnerModel.findById(partnerId).select({ kind: 1, isActive: 1, 'verification.state': 1 }).lean() : null;
  if (!p || p.kind !== 'lab') throw err(404, 'LAB_NOT_FOUND', 'Lab not found');
  return p as never;
}

/** S5 (§24.1 item 12): only an active, verified lab spends from its wallet (read in the spending transaction). */
async function assertLabMaySpendIn(partnerId: string, s: ClientSession): Promise<void> {
  const p = Types.ObjectId.isValid(partnerId) ? await PartnerModel.findById(partnerId).select({ kind: 1, isActive: 1, 'verification.state': 1 }).session(s).lean() : null;
  if (!p || p.kind !== 'lab') throw err(404, 'LAB_NOT_FOUND', 'Lab not found');
  if (p.isActive === false) throw err(403, 'PARTNER_INACTIVE', 'Partner is inactive');
  if (p.verification?.state !== 'verified') throw err(403, 'PARTNER_NOT_VERIFIED', 'Partner verification is required for this operation');
}

export interface LabWalletMovement {
  partnerId: string;
  /** Positive paise. */
  amountMinor: number;
  operationKey: string;
  referenceType: string;
  referenceId: string;
  description: string;
  notes?: string;
  entryId?: Types.ObjectId;
  actor?: { kind: 'admin' | 'member'; id: string };
}

/**
 * A lab pays from its wallet, in the caller's transaction (2e: a lab-made consultation), exactly once per operation key.
 * Refused for a lab that is not active and verified (403), and as every wallet debit: owing a receivable, frozen,
 * inactive or short (409). The entry records the lots it used (`lotAllocations`) for the refund to restore.
 */
export async function debitLabWalletIn(m: LabWalletMovement, s: ClientSession): Promise<Posted<IPartnerWallet, IPartnerWalletEntry>> {
  await assertLabMaySpendIn(m.partnerId, s);
  const { partnerId, ...rest } = m;
  return postMovementIn(labStore(partnerId), { ...rest, kind: 'booking_debit' }, s);
}

/**
 * The refund of a lab's spend, in the caller's transaction, exactly once per operation key. It ALWAYS posts (frozen,
 * inactive, suspended or unverified labs included). `restore`: the debit's `lotAllocations` (a full refund gives back
 * exactly the card money it took; a closed lot's part returns non-withdrawable).
 */
export async function refundLabWalletIn(m: LabWalletMovement & { restore?: LotAllocation[] }, s: ClientSession): Promise<Posted<IPartnerWallet, IPartnerWalletEntry>> {
  const { partnerId, ...rest } = m;
  return postMovementIn(labStore(partnerId), { ...rest, kind: 'refund_credit' }, s);
}
