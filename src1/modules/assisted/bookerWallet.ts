import { ClientSession } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { postPharmacyMovementIn, type PharmacyMovement, type PostedMovement } from '@/modules/pharmacyWallet/ledger';
import { PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import type { BookerKind } from '@/modules/assisted/types';
import { debitDoctorWalletIn, refundDoctorWalletIn } from '@/modules/partnerWallets/ledger';
import { PartnerWalletEntryModel } from '@/modules/partnerWallets/model';

/**
 * §24.7.1: the ONE dispatcher every assisted booker-wallet movement goes through, by payer kind. r17 (round 3e) adds it
 * with the pharmacy route only, the exact contract of `postPharmacyMovementIn` (exactly once per operation key, debits
 * refused when frozen / inactive / short / owing, credits always post, lots consumed and restored).
 *
 * ASSUMED (r17): lab payers answer 501 until 2e adds its branch (same name and signature). r26 (3b) adds the doctor
 * branch on the partner store (2d/3a).
 */
export type BookerMovement = Omit<PharmacyMovement, 'pharmacyId'> & { payerKind: BookerKind; payerId: string };

const notYet = (kind: string) => new AppError({ status: 501, code: 'PAYER_NOT_SUPPORTED', message: `A ${kind} wallet cannot pay assisted bookings yet` });

export async function postBookerMovementIn(m: BookerMovement, s: ClientSession): Promise<PostedMovement> {
  const { payerKind, payerId, ...movement } = m;
  if (payerKind === 'pharmacy') return postPharmacyMovementIn({ ...movement, pharmacyId: payerId }, s);
  // r26 (round 3b): a doctor pays from its partner-store wallet (the debit re-reads the doctor: an ineligible doctor never
  // spends, 403 SPECIALIST_NOT_VERIFIED); a refund always posts. The entry is the partner store's row.
  if (payerKind === 'doctor' && (movement.kind === 'booking_debit' || movement.kind === 'refund_credit')) {
    const { amountPaise, kind, actor: _actor, lot: _lot, ...rest } = movement;
    const d = { ...rest, specialistId: payerId, amountMinor: amountPaise };
    return (kind === 'booking_debit' ? await debitDoctorWalletIn(d, s) : await refundDoctorWalletIn(d, s)) as unknown as PostedMovement;
  }
  throw notYet(payerKind);
}

/** The lot allocations of a booker-wallet entry (a full refund restores exactly the lots its debit used). */
export async function bookerEntryLotsIn(payerKind: BookerKind, entryId: string | undefined, s: ClientSession) {
  if (!entryId) return [];
  if (payerKind === 'doctor') {
    const entry = await PartnerWalletEntryModel.findById(entryId).select({ lotAllocations: 1 }).session(s).lean();
    return entry?.lotAllocations ?? [];
  }
  if (payerKind !== 'pharmacy') throw notYet(payerKind);
  const entry = await PharmacyWalletTransactionModel.findById(entryId).select({ lotAllocations: 1 }).session(s).lean() as
    { lotAllocations?: { lotId: string; amountPaise: number }[] } | null;
  return entry?.lotAllocations ?? [];
}

/** The booker-wallet entries posted under one operation key (reconciliation). */
export async function bookerEntriesOf(payerKind: BookerKind, operationKey: string) {
  if (payerKind === 'doctor') {
    const rows = await PartnerWalletEntryModel.find({ ownerKind: 'doctor', operationKey }).select({ amountMinor: 1, ownerId: 1 }).lean();
    return rows.map((r) => ({ _id: r._id, amountPaise: Math.abs(r.amountMinor), pharmacyId: r.ownerId }));
  }
  if (payerKind !== 'pharmacy') return [];
  return PharmacyWalletTransactionModel.find({ operationKey }).select({ amountPaise: 1, pharmacyId: 1 }).lean() as unknown as
    Promise<{ _id: unknown; amountPaise: number; pharmacyId: string }[]>;
}
