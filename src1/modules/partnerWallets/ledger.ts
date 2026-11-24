import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import { assertDoctorWalletOn, assertLabWalletOn, assistedFlags } from '@/modules/assisted/flags';
import SpecialistModel from '@/modules/specialists/model';
import { isEligibleDoctor } from '@/modules/specialists/eligibility';
import PartnerModel from '@/modules/partners/model';
import { WalletTopupLotModel } from '@/modules/pharmacyWallet/model/lots';
import { postMovementIn, type Posted, type TopupKind, type WalletStore } from '@/modules/pharmacyWallet/walletCore';
import type { LotAllocation } from '@/modules/pharmacyWallet/walletLots';
import {
  PartnerWalletEntryModel, PartnerWalletModel, type IPartnerWallet, type IPartnerWalletEntry, type PartnerWalletEntryKind, type PartnerWalletOwnerKind,
} from '@/modules/partnerWallets/model';

/**
 * r13 (round 2d, §24.7) and r20 (round 3a, §25.4): the PARTNER STORE (`partner_wallets` / `partner_wallet_entries`) for
 * the shared wallet rules of `pharmacyWallet/walletCore.ts`; the lab and doctor owners, their top-up kinds, and their
 * debit and refund (what spends them is 2e and 3b).
 */

/**
 * O2 (owner, 25 Nov), for lab and doctor wallets: ₹50,000 most a wallet may hold (checked when a top-up is ordered; a paid top-up is always
 * credited); withdrawals (phase 4, off): one a week, card money withdrawable 7 days after payment (stored on each lot).
 * Admin top-ups: at most ₹2,00,000 each (as the pharmacy admin form), never withdrawable (L20).
 */
export const PARTNER_WALLET_POLICY = {
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
export const doctorStore = (specialistId: string) => partnerStore('doctor', specialistId);

const lower = (v: unknown) => String(v ?? '').toLowerCase();
const HEX24 = /^[0-9a-fA-F]{24}$/;

/**
 * A card top-up kind of the partner store: the record names its owner in `payerField` and carries `notes.flow`. Lost card
 * disputes are recorded and flagged only (owner C4). A credit fails closed (503) while the store's unique indexes are
 * missing (the sweep retries it), and opens a lot only while the owner's switch is on.
 */
function partnerTopupKind(o: { kind: PartnerWalletOwnerKind; flow: string; payerField: string; ownerField: string; on: () => boolean; description: string }):
TopupKind<IPartnerWallet, IPartnerWalletEntry> {
  const store = (id: string) => partnerStore(o.kind, id);
  return {
    kind: o.kind,
    flow: o.flow,
    payerField: o.payerField,
    ownerField: o.ownerField,
    isTopup: (r) => !!r && r.context === 'wallet_recharge' && typeof r[o.payerField] === 'string' && !!r[o.payerField]
      && (r.notes as { flow?: unknown } | undefined)?.flow === o.flow,
    ownerOf: (r) => lower(r[o.payerField]),
    storeFor: (r) => store(String(r[o.payerField])),
    store,
    chargeback: 'flag',
    async lotsWritable() {
      if (!o.on()) return false;
      try { await assertUniqueIndex(WalletTopupLotModel, { paymentRecordId: 1 }); return true; } catch { return false; }
    },
    assertCreditable: assertPartnerWalletIndexes,
    rechargeDescription: o.description,
    cardHoldDays: PARTNER_WALLET_POLICY.cardHoldDays,
  };
}

/** Lab card top-ups (`notes.flow: 'lab_wallet_recharge'`, the paying lab on the record as `payerPartnerId`). */
export const labTopups = partnerTopupKind({ kind: 'lab', flow: 'lab_wallet_recharge', payerField: 'payerPartnerId', ownerField: 'partnerId',
  on: assistedFlags.lab, description: 'Lab wallet recharge via Razorpay' });
/** r20 (§25.4.3): doctor card top-ups (`notes.flow: 'doctor_wallet_recharge'`, the paying doctor as `payerSpecialistId`). */
export const doctorTopups = partnerTopupKind({ kind: 'doctor', flow: 'doctor_wallet_recharge', payerField: 'payerSpecialistId', ownerField: 'specialistId',
  on: assistedFlags.doctor, description: 'Doctor wallet recharge via Razorpay' });

/**
 * An owner of a partner wallet, for the routes and the spending rules: its top-up kind, its switch, who it is (admin
 * tools: any state; the one 404 otherwise), whether it may spend now (S5, read in the spending transaction), and its
 * card top-up order (the request-key scope and the record's payer fields).
 */
export interface PartnerOwner {
  kind: PartnerWalletOwnerKind;
  topups: TopupKind<IPartnerWallet, IPartnerWalletEntry>;
  assertOn(): void;
  assertExists(id: string): Promise<void>;
  assertMaySpendIn(id: string, s: ClientSession): Promise<void>;
  topupOrder(ownerId: string, actorId: string): { scope: string; fields: Record<string, unknown> };
}

export const LAB: PartnerOwner = {
  kind: 'lab',
  topups: labTopups,
  assertOn: assertLabWalletOn,
  async assertExists(partnerId) {
    const p = HEX24.test(String(partnerId)) ? await PartnerModel.findById(partnerId).select({ kind: 1 }).lean() : null;
    if (!p || p.kind !== 'lab') throw err(404, 'LAB_NOT_FOUND', 'Lab not found');
  },
  /** S5 (§24.1 item 12): only an active, verified lab spends from its wallet. */
  async assertMaySpendIn(partnerId, s) {
    const p = Types.ObjectId.isValid(partnerId) ? await PartnerModel.findById(partnerId).select({ kind: 1, isActive: 1, 'verification.state': 1 }).session(s).lean() : null;
    if (!p || p.kind !== 'lab') throw err(404, 'LAB_NOT_FOUND', 'Lab not found');
    if (p.isActive === false) throw err(403, 'PARTNER_INACTIVE', 'Partner is inactive');
    if (p.verification?.state !== 'verified') throw err(403, 'PARTNER_NOT_VERIFIED', 'Partner verification is required for this operation');
  },
  topupOrder: (partnerId, memberId) => ({
    scope: `wallet_topup:lab:${lower(partnerId)}:${lower(memberId)}`,
    fields: { userId: memberId, payerUserId: memberId, payerPartnerId: lower(partnerId), payerMemberId: memberId, contextId: `lab_${lower(partnerId)}_${Date.now()}`,
      notes: { flow: labTopups.flow, partnerId: lower(partnerId) } },
  }),
};

const doctorNotFound = () => err(404, 'SPECIALIST_NOT_FOUND', 'Specialist not found');
/** r20 (§25.3, DR3): the doctor is the organisation and the actor (no staff); an unverified or inactive doctor never spends. */
export const DOCTOR: PartnerOwner = {
  kind: 'doctor',
  topups: doctorTopups,
  assertOn: assertDoctorWalletOn,
  async assertExists(specialistId) {
    if (!HEX24.test(String(specialistId)) || !(await SpecialistModel.exists({ _id: specialistId }))) throw doctorNotFound();
  },
  async assertMaySpendIn(specialistId, s) {
    const sp = HEX24.test(String(specialistId)) ? await SpecialistModel.findById(specialistId).select({ isActive: 1, isVerified: 1 }).session(s).lean() : null;
    if (!sp) throw doctorNotFound();
    if (!isEligibleDoctor(sp)) throw err(403, 'SPECIALIST_NOT_VERIFIED', 'Your doctor account must be verified and active before you can do this');
  },
  topupOrder: (specialistId) => ({
    scope: `wallet_topup:doctor:${lower(specialistId)}`,
    fields: { userId: lower(specialistId), payerUserId: lower(specialistId), payerSpecialistId: lower(specialistId), contextId: `doctor_${lower(specialistId)}_${Date.now()}`,
      notes: { flow: doctorTopups.flow, specialistId: lower(specialistId) } },
  }),
};

/** The lab, for an admin tool or a guard: any lab (any state); anything else is the one 404. */
export const labOrNotFound = (partnerId: string): Promise<void> => LAB.assertExists(partnerId);

/** A movement of a partner wallet (positive paise), exactly once per operation key. */
export interface PartnerWalletMovement {
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
 * The owner pays from its wallet, in the caller's transaction, exactly once per operation key. Refused for an owner that
 * may not spend now (S5, 403), and as every wallet debit: owing a receivable, frozen, inactive or short (409). The entry
 * records the lots it used (`lotAllocations`) for the refund to restore.
 */
async function debitIn(owner: PartnerOwner, ownerId: string, m: PartnerWalletMovement, s: ClientSession): Promise<Posted<IPartnerWallet, IPartnerWalletEntry>> {
  await owner.assertMaySpendIn(ownerId, s);
  return postMovementIn(partnerStore(owner.kind, ownerId), { ...m, kind: 'booking_debit' }, s);
}

/**
 * The refund of a spend, in the caller's transaction, exactly once per operation key. It ALWAYS posts (frozen, inactive,
 * suspended or unverified owners included). `restore`: the debit's `lotAllocations` (a full refund gives back exactly the
 * card money it took; a closed lot's part returns non-withdrawable).
 */
function refundIn(owner: PartnerOwner, ownerId: string, m: PartnerWalletMovement & { restore?: LotAllocation[] }, s: ClientSession) {
  return postMovementIn(partnerStore(owner.kind, ownerId), { ...m, kind: 'refund_credit' }, s);
}

export type LabWalletMovement = PartnerWalletMovement & { partnerId: string };
export type DoctorWalletMovement = PartnerWalletMovement & { specialistId: string };

/** 2e spends the lab wallet through these. */
export const debitLabWalletIn = ({ partnerId, ...m }: LabWalletMovement, s: ClientSession) => debitIn(LAB, partnerId, m, s);
export const refundLabWalletIn = ({ partnerId, ...m }: LabWalletMovement & { restore?: LotAllocation[] }, s: ClientSession) => refundIn(LAB, partnerId, m, s);
/** r20 (§25.4): 3b spends the doctor wallet through these (DR3: refunds always post). */
export const debitDoctorWalletIn = ({ specialistId, ...m }: DoctorWalletMovement, s: ClientSession) => debitIn(DOCTOR, specialistId, m, s);
export const refundDoctorWalletIn = ({ specialistId, ...m }: DoctorWalletMovement & { restore?: LotAllocation[] }, s: ClientSession) =>
  refundIn(DOCTOR, specialistId, m, s);
