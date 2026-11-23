import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { PartnerLabBookingModel, type IPartnerLabBooking } from '@/modules/partners/model/labBooking';
import { PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { postPharmacyMovementIn } from '@/modules/pharmacyWallet/ledger';
import { reverseRedemptionIn } from '@/modules/assisted/refunds';
import type { AssistedRefundRow } from '@/modules/assisted/types';

/**
 * r11 (§24.4.4): the money step of a cancellation of a partner-paid LAB booking, inside the one cancellation
 * transaction (LabBookingService.cancelIn, after its status compare-and-set). It never touches the customer wallet.
 * Mirrors `settleAssistedFundingIn` (assisted/refunds.ts) on `PartnerLabBookingModel`:
 * - wallet funding: one `refund_credit` of the remaining budget to the payer's wallet, exactly once (operation key
 *   `assisted_lab:<id>:refund`), restoring the debit's lot allocations. It ALWAYS posts (inactive or frozen wallet,
 *   non-operational pharmacy included);
 * - the coupon redemption is reversed once;
 * - `keepMoney` (admin cancel of a moved no-show without refund, L9): funding `forfeited`, the coupon stays used.
 * Returns the amount refunded in rupees (as the lab cancel paths report it).
 */
export const labRefundKey = (id: string) => `assisted_lab:${String(id).toLowerCase()}:refund`;
export const labDebitKey = (id: string) => `assisted_lab:${String(id).toLowerCase()}:debit`;

export async function settleAssistedLabFundingIn(b: IPartnerLabBooking, p: { cause: string; keepMoney: boolean }, s: ClientSession): Promise<number> {
  const a = b.assisted!;
  const id = String(b._id).toLowerCase();
  const set: Record<string, unknown> = {};
  let push: AssistedRefundRow | null = null;
  let refundedMinor = 0;
  if (p.keepMoney) {
    set['assisted.funding.state'] = 'forfeited';
  } else {
    // 2a writes only wallet funding; a card-funded row (2b) must never be "refunded" here without its card refund.
    if (a.funding.method !== 'wallet') throw new AppError({ status: 409, code: 'REFUND_METHOD_UNSUPPORTED', message: 'This booking cannot be refunded here yet' });
    await reverseRedemptionIn('lab_booking', id, s);
    const already = (a.funding.refunds ?? []).reduce((x, r) => x + Number(r.amountMinor || 0), 0);
    const budget = Number(a.funding.amountMinor || 0) - already;
    if (budget > 0 && a.funding.payerKind === 'pharmacy') {
      const debit = a.funding.walletEntryId && Types.ObjectId.isValid(a.funding.walletEntryId)
        ? await PharmacyWalletTransactionModel.findById(a.funding.walletEntryId).select({ lotAllocations: 1 }).session(s).lean() : null;
      const posted = await postPharmacyMovementIn({
        pharmacyId: a.funding.payerId, kind: 'refund_credit', amountPaise: budget, operationKey: labRefundKey(id),
        referenceType: 'assisted_lab_booking', referenceId: `${id}:refund`, description: 'Refund of an assisted lab booking',
        ...(already === 0 && debit?.lotAllocations?.length ? { restore: debit.lotAllocations } : {}),
      }, s);
      refundedMinor = budget;
      const attemptId = new Types.ObjectId().toHexString();
      push = { refundId: attemptId, cause: p.cause, amountMinor: budget, method: 'wallet', sourceRef: String(a.funding.walletEntryId ?? ''),
        state: 'processed', walletEntryId: String(posted.entry._id), attemptId, at: new Date() };
    }
    set['assisted.funding.state'] = 'refunded';
    set.paymentStatus = 'refunded';
  }
  await PartnerLabBookingModel.updateOne({ _id: id, status: 'cancelled' }, {
    $set: set, ...(push ? { $push: { 'assisted.funding.refunds': push } } : {}),
  }, { session: s });
  return refundedMinor / 100;
}
