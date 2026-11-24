import { ClientSession } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { postPharmacyMovementIn, type PharmacyMovement, type PostedMovement } from '@/modules/pharmacyWallet/ledger';
import { PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import type { BookerKind } from '@/modules/assisted/types';

/**
 * §24.7.1: the ONE dispatcher every assisted booker-wallet movement goes through, by payer kind. r17 (round 3e) adds it
 * with the pharmacy route only, the exact contract of `postPharmacyMovementIn` (exactly once per operation key, debits
 * refused when frozen / inactive / short / owing, credits always post, lots consumed and restored).
 *
 * ASSUMED (r17): lab and doctor payers answer 501 until round 2d (`partner_wallets`, `postPartnerMovementIn`) is merged;
 * 2e replaces this file with its dispatcher of the same name and signature. Nothing in phase 3e can create a lab- or
 * doctor-paid row yet (the routes are pharmacy-only), so the refusal is a seam, not a path.
 */
export type BookerMovement = Omit<PharmacyMovement, 'pharmacyId'> & { payerKind: BookerKind; payerId: string };

const notYet = (kind: string) => new AppError({ status: 501, code: 'PAYER_NOT_SUPPORTED', message: `A ${kind} wallet cannot pay assisted bookings yet` });

export async function postBookerMovementIn(m: BookerMovement, s: ClientSession): Promise<PostedMovement> {
  const { payerKind, payerId, ...movement } = m;
  if (payerKind === 'pharmacy') return postPharmacyMovementIn({ ...movement, pharmacyId: payerId }, s);
  throw notYet(payerKind);
}

/** The lot allocations of a booker-wallet entry (a full refund restores exactly the lots its debit used). */
export async function bookerEntryLotsIn(payerKind: BookerKind, entryId: string | undefined, s: ClientSession) {
  if (!entryId) return [];
  if (payerKind !== 'pharmacy') throw notYet(payerKind);
  const entry = await PharmacyWalletTransactionModel.findById(entryId).select({ lotAllocations: 1 }).session(s).lean() as
    { lotAllocations?: { lotId: string; amountPaise: number }[] } | null;
  return entry?.lotAllocations ?? [];
}

/** The booker-wallet entries posted under one operation key (reconciliation). */
export async function bookerEntriesOf(payerKind: BookerKind, payerId: string, operationKey: string) {
  if (payerKind !== 'pharmacy') return [];
  // The `{ pharmacyId, operationKey }` unique index serves this read.
  return PharmacyWalletTransactionModel.find({ pharmacyId: payerId, operationKey }).select({ amountPaise: 1, pharmacyId: 1 }).lean() as unknown as
    Promise<{ _id: unknown; amountPaise: number; pharmacyId: string }[]>;
}
