import PaymentRecordModel from '@/modules/payment/model';
import { withdrawableOfIn } from '@/modules/pharmacyWallet/walletLots';
import { PartnerWalletEntryModel, PartnerWalletModel } from '@/modules/partnerWallets/model';
import { PARTNER_TOPUP_FLOWS, topupKindOf } from '@/modules/partnerWallets/topupKinds';

/**
 * r13 (§24.7.4), r20 (§25.4.3): the daily reconciliation's checks of the partner store, lab and doctor wallets alike
 * (reported, never fixed): balance = Σ entries, withdrawable = Σ eligible lots ≤ balance, a receivable only while frozen;
 * and paid lab and doctor top-ups never credited.
 */
type Mismatch = { check: string; ref: string; detail: Record<string, unknown> };
const LIST_MAX = 200;

export async function partnerWalletInvariants(): Promise<{ checked: number; mismatches: Mismatch[] }> {
  const wallets = await PartnerWalletModel.find({}).lean();
  const mismatches: Mismatch[] = [];
  for (const w of wallets) {
    const ref = `${w.ownerKind}:${w.ownerId}`;
    const [sum] = await PartnerWalletEntryModel.aggregate([{ $match: { walletId: String(w._id) } }, { $group: { _id: null, total: { $sum: '$amountMinor' } } }]);
    if (Number(sum?.total ?? 0) !== w.balanceMinor) mismatches.push({ check: 'partner_wallet_balance', ref, detail: { balanceMinor: w.balanceMinor, entriesMinor: Number(sum?.total ?? 0) } });
    const withdrawable = await withdrawableOfIn({ kind: w.ownerKind, id: w.ownerId }, null);
    if (withdrawable !== w.withdrawableMinor || withdrawable > w.balanceMinor) {
      mismatches.push({ check: 'partner_wallet_withdrawable', ref, detail: { withdrawableMinor: w.withdrawableMinor, lotsMinor: withdrawable, balanceMinor: w.balanceMinor } });
    }
    if (w.receivableMinor > 0 && w.frozen !== true) mismatches.push({ check: 'partner_wallet_receivable_unfrozen', ref, detail: { receivableMinor: w.receivableMinor } });
  }
  return { checked: wallets.length, mismatches };
}

/**
 * Paid lab and doctor top-ups with no wallet credit. Every partner-store credit claims its record (`walletCreditedAt`) in
 * the credit's own transaction, so a paid record without the claim was never credited (every such top-up is swept, so none
 * is unchecked). Each row names its owner as the admin answers do (`partnerId` for a lab, `specialistId` for a doctor).
 */
export async function uncreditedPartnerTopups(): Promise<Record<string, unknown>[]> {
  const rows = await PaymentRecordModel.find({ context: 'wallet_recharge', 'notes.flow': { $in: PARTNER_TOPUP_FLOWS }, status: 'paid', walletCreditedAt: { $exists: false } })
    .select({ context: 1, notes: 1, payerPartnerId: 1, payerSpecialistId: 1, baseAmount: 1, baseAmountPaise: 1, createdAt: 1 }).sort({ createdAt: 1 })
    .limit(LIST_MAX).lean() as Record<string, any>[];
  return rows.map((r) => {
    const kind = topupKindOf(r);
    return { paymentTransactionId: String(r._id), walletKind: kind?.kind ?? String(r.notes?.flow), ...(kind ? { [kind.ownerField]: kind.ownerOf(r) } : {}),
      amountMinor: r.baseAmountPaise ?? Math.round(Number(r.baseAmount) * 100), createdAt: r.createdAt, state: kind ? 'paid_not_credited' : 'paid_no_owner' };
  });
}
