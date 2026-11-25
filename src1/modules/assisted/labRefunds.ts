import { ClientSession } from 'mongoose';
import { PartnerLabBookingModel, type IPartnerLabBooking } from '@/modules/partners/model/labBooking';
import { refundWalletFundingIn, reverseRedemptionIn, settleCardFundingIn } from '@/modules/assisted/refunds';
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
 * - r14 (§24.5.3): card funding goes through the consultations' card step (`settleCardFundingIn`): a capture applied
 *   goes back by its card refund row — to the card by default, to the wallet only on the booker's own choice
 *   (`refundTo: 'wallet'`, C2/C3); a booking cancelled or expired before its capture was applied ends `not_paid`.
 * Returns the amount refunded in rupees (as the lab cancel paths report it).
 */
export const labRefundKey = (id: string) => `assisted_lab:${String(id).toLowerCase()}:refund`;
export const labDebitKey = (id: string) => `assisted_lab:${String(id).toLowerCase()}:debit`;

export async function settleAssistedLabFundingIn(b: IPartnerLabBooking, p: { cause: string; keepMoney: boolean; refundTo?: 'card' | 'wallet' },
  s: ClientSession): Promise<number> {
  const a = b.assisted!;
  const id = String(b._id).toLowerCase();
  const set: Record<string, unknown> = {};
  let push: AssistedRefundRow | null = null;
  let refundedMinor = 0;
  if (p.keepMoney) {
    set['assisted.funding.state'] = 'forfeited';
  } else if (a.funding.method === 'razorpay') {
    const card = await settleCardFundingIn('lab_booking', id, a.funding, { cause: p.cause, refundTo: p.refundTo }, s);
    set['assisted.funding.state'] = card.state;
    push = card.push;
    refundedMinor = card.refundedMinor;
  } else {
    await reverseRedemptionIn('lab_booking', id, s);
    // r26 / r21: every payer (pharmacy, lab, doctor) through the one wallet refund (the booker-wallet dispatcher).
    ({ push, refundedMinor } = await refundWalletFundingIn(a.funding, { cause: p.cause, operationKey: labRefundKey(id),
      referenceType: 'assisted_lab_booking', referenceId: `${id}:refund`, description: 'Refund of an assisted lab booking' }, s));
    set['assisted.funding.state'] = 'refunded';
    set.paymentStatus = 'refunded';
  }
  await PartnerLabBookingModel.updateOne({ _id: id, status: 'cancelled' }, {
    $set: set, ...(push ? { $push: { 'assisted.funding.refunds': push } } : {}),
  }, { session: s });
  return refundedMinor / 100;
}
