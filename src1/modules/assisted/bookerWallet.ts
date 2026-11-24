import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { postPharmacyMovementIn, type PharmacyMovement, type PostedMovement } from '@/modules/pharmacyWallet/ledger';
import { PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import type { Posted } from '@/modules/pharmacyWallet/walletCore';
import type { LotAllocation } from '@/modules/pharmacyWallet/walletLots';
import { PartnerWalletEntryModel, PartnerWalletModel, type IPartnerWallet, type IPartnerWalletEntry } from '@/modules/partnerWallets/model';
import { assertPartnerWalletIndexes, debitLabWalletIn, refundLabWalletIn } from '@/modules/partnerWallets/ledger';
import type { BookerKind } from '@/modules/assisted/types';

/**
 * §24.7.1: the ONE dispatcher every assisted booker-wallet movement goes through, by payer kind (r17 / round 3e made it
 * with the pharmacy route; r21 / round 2e adds the lab, as 2d D12 left to 2e). An assisted booking is paid from, and
 * refunded to, the wallet of whoever made it: the pharmacy store (`pharmacy_wallet_transactions`) or the lab store
 * (`partner_wallets`, 2d). Both share the money rules (`pharmacyWallet/walletCore.ts`): exactly once per operation key,
 * debits refused when frozen, inactive, short or owing (409), credits always post, lots consumed and restored. A lab
 * debit also needs an active, verified lab (`debitLabWalletIn`, S5).
 *
 * ASSUMED (r17, kept by r21): a doctor payer answers 501 until the doctor wallet (phase 3) has a writer; nothing can
 * create a doctor-paid row yet, so the refusal is a seam, not a path.
 */
export type BookerMovement = Omit<PharmacyMovement, 'pharmacyId' | 'kind' | 'lot' | 'requestHash' | 'actor'>
  & { payerKind: BookerKind; payerId: string; kind: 'booking_debit' | 'refund_credit' };
export type PostedBookerMovement = PostedMovement | Posted<IPartnerWallet, IPartnerWalletEntry>;

const notYet = (kind: string) => new AppError({ status: 501, code: 'PAYER_NOT_SUPPORTED', message: `A ${kind} wallet cannot pay assisted bookings yet` });

/** Posts the movement on the payer's wallet, in the caller's transaction. */
export async function postBookerMovementIn(m: BookerMovement, s: ClientSession): Promise<PostedBookerMovement> {
  const { payerKind, payerId, ...movement } = m;
  if (payerKind === 'pharmacy') return postPharmacyMovementIn({ ...movement, pharmacyId: payerId }, s);
  if (payerKind === 'lab') {
    const { kind, amountPaise, restore, ...rest } = movement;
    return kind === 'booking_debit'
      ? debitLabWalletIn({ ...rest, partnerId: payerId, amountMinor: amountPaise }, s)
      : refundLabWalletIn({ ...rest, partnerId: payerId, amountMinor: amountPaise, ...(restore?.length ? { restore } : {}) }, s);
  }
  throw notYet(payerKind);
}

/** The lot allocations of a booker-wallet entry (a full refund restores exactly the lots its debit used). */
export async function bookerEntryLotsIn(payerKind: BookerKind, entryId: string | undefined, s: ClientSession): Promise<LotAllocation[]> {
  if (!entryId || !Types.ObjectId.isValid(entryId)) return [];
  if (payerKind !== 'pharmacy' && payerKind !== 'lab') throw notYet(payerKind);
  const Model = payerKind === 'lab' ? PartnerWalletEntryModel : PharmacyWalletTransactionModel;
  const entry = await (Model as typeof PharmacyWalletTransactionModel).findById(entryId).select({ lotAllocations: 1 }).session(s).lean() as
    { lotAllocations?: LotAllocation[] } | null;
  return entry?.lotAllocations ?? [];
}

/**
 * The booker-wallet entries this payer posted under one operation key (reconciliation, §8.8): positive paise and the
 * payer. r17b: index reads only — the pharmacy store's `{ pharmacyId, operationKey }`; the lab store's wallet by
 * `{ ownerKind, ownerId }`, then `{ walletId, operationKey }` (both unique).
 */
export async function bookerEntriesOf(payerKind: BookerKind, payerId: string, operationKey: string): Promise<{ amountPaise: number; payerId: string }[]> {
  const owner = String(payerId ?? '').toLowerCase();
  if (payerKind === 'lab') {
    const wallet = await PartnerWalletModel.findOne({ ownerKind: 'lab', ownerId: owner }).select({ _id: 1 }).lean();
    if (!wallet) return [];
    const rows = await PartnerWalletEntryModel.find({ walletId: String(wallet._id), operationKey }).select({ amountMinor: 1, ownerId: 1 }).lean();
    return rows.map((r) => ({ amountPaise: Math.abs(Number(r.amountMinor)), payerId: String(r.ownerId) }));
  }
  if (payerKind !== 'pharmacy') return [];
  const rows = await PharmacyWalletTransactionModel.find({ pharmacyId: owner, operationKey }).select({ amountPaise: 1, pharmacyId: 1 }).lean();
  return rows.map((r) => ({ amountPaise: Number(r.amountPaise), payerId: String(r.pharmacyId) }));
}

/** Writers fail closed until sync-indexes has run: the payer store's exactly-once key (503 INDEXES_OUTDATED). */
export async function assertBookerWalletIndexes(payerKind: BookerKind): Promise<void> {
  if (payerKind === 'lab') return assertPartnerWalletIndexes();
  await assertUniqueIndex(PharmacyWalletTransactionModel, { pharmacyId: 1, operationKey: 1 });
}
