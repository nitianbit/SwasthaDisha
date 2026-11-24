import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { postPharmacyMovementIn } from '@/modules/pharmacyWallet/ledger';
import type { LotAllocation } from '@/modules/pharmacyWallet/walletLots';
import { PartnerWalletEntryModel } from '@/modules/partnerWallets/model';
import { assertPartnerWalletIndexes, debitLabWalletIn, refundLabWalletIn } from '@/modules/partnerWallets/ledger';
import type { BookerKind } from '@/modules/assisted/types';

/**
 * Round 2e (§24.7.1, left to 2e by 2d D12): the one dispatcher of a BOOKER's wallet movements. An assisted booking is
 * paid from, and refunded to, the wallet of whoever made it: the pharmacy store (`pharmacy_wallet_transactions`) or the
 * lab store (`partner_wallets`, 2d). Both share the money rules (`pharmacyWallet/walletCore.ts`): exactly once per
 * operation key, debits refused when frozen, inactive, short or owing (409), credits always post, lots consumed and
 * restored. A lab debit also needs an active, verified lab (`debitLabWalletIn`, S5).
 */
/** A booker that pays (§5.3); a doctor's wallet (phase 3) has no writer yet, so its movements are refused (500). */
export type PayerKind = BookerKind;

export interface BookerMovement {
  payerKind: string;
  payerId: string;
  kind: 'booking_debit' | 'refund_credit';
  /** Positive paise. */
  amountMinor: number;
  operationKey: string;
  referenceType: string;
  referenceId: string;
  description: string;
  /** Pre-chosen entry id (stored on the booking's funding in the same transaction). */
  entryId?: Types.ObjectId;
  /** A refund: the debit's lot allocations to give back (a full refund only). */
  restore?: LotAllocation[];
}

const unsupported = (kind: string) => new AppError({ status: 500, code: 'UNSUPPORTED_PAYER', message: `No wallet for payer kind ${kind}` });

/** Posts the movement on the payer's wallet, in the caller's transaction; the entry's id. */
export async function postBookerMovementIn(m: BookerMovement, s: ClientSession): Promise<{ entryId: string }> {
  const { payerKind, payerId, amountMinor, ...rest } = m;
  if (payerKind === 'pharmacy') {
    const posted = await postPharmacyMovementIn({ pharmacyId: payerId, amountPaise: amountMinor, ...rest }, s);
    return { entryId: String(posted.entry._id) };
  }
  if (payerKind === 'lab') {
    const { kind, restore, ...lab } = rest;
    const posted = kind === 'booking_debit'
      ? await debitLabWalletIn({ partnerId: payerId, amountMinor, ...lab }, s)
      : await refundLabWalletIn({ partnerId: payerId, amountMinor, ...lab, ...(restore ? { restore } : {}) }, s);
    return { entryId: String(posted.entry._id) };
  }
  throw unsupported(payerKind);
}

/** The lots a booking's wallet debit used (by its entry id), so a full refund can restore exactly those. */
export async function bookerDebitAllocationsIn(payerKind: string, entryId: string | undefined, s: ClientSession): Promise<LotAllocation[] | undefined> {
  if (!entryId || !Types.ObjectId.isValid(entryId)) return undefined;
  const Model = payerKind === 'lab' ? PartnerWalletEntryModel : PharmacyWalletTransactionModel;
  const e = await (Model as typeof PharmacyWalletTransactionModel).findById(entryId).select({ lotAllocations: 1 }).session(s).lean() as { lotAllocations?: LotAllocation[] } | null;
  return e?.lotAllocations?.length ? e.lotAllocations : undefined;
}

/** Writers fail closed until sync-indexes has run: the payer store's exactly-once key (503 INDEXES_OUTDATED). */
export async function assertBookerWalletIndexes(payerKind: string): Promise<void> {
  if (payerKind === 'lab') return assertPartnerWalletIndexes();
  await assertUniqueIndex(PharmacyWalletTransactionModel, { pharmacyId: 1, operationKey: 1 });
}

/** Reconciliation (§8.8): the payer's ledger rows of one operation key, as positive paise and the wallet owner. */
export async function bookerEntriesByKey(payerKind: string, operationKey: string): Promise<{ amountMinor: number; ownerId: string }[]> {
  if (payerKind === 'lab') {
    const rows = await PartnerWalletEntryModel.find({ ownerKind: 'lab', operationKey }).select({ amountMinor: 1, ownerId: 1 }).lean();
    return rows.map((r) => ({ amountMinor: Math.abs(Number(r.amountMinor)), ownerId: String(r.ownerId) }));
  }
  const rows = await PharmacyWalletTransactionModel.find({ operationKey }).select({ amountPaise: 1, pharmacyId: 1 }).lean();
  return rows.map((r) => ({ amountMinor: Number(r.amountPaise), ownerId: String(r.pharmacyId) }));
}
