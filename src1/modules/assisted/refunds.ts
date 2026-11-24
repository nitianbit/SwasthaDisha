import { ClientSession, Types } from 'mongoose';
import BookingModel from '@/modules/bookings/model';
import type { IBooking } from '@/modules/bookings/types';
import { CouponModel } from '@/modules/coupon/model';
import { CouponRedemptionModel } from '@/modules/coupon/model/redemption';
import { bookerDebitAllocationsIn, postBookerMovementIn } from '@/modules/assisted/bookerWallet';
import type { AssistedBookingKind, AssistedFunding, AssistedRefundRow } from '@/modules/assisted/types';
import PaymentRecordModel from '@/modules/payment/model';
import type { IPaymentRecord } from '@/modules/payment/types';
import { queueCardRefundIn } from '@/modules/assisted/cardRefunds';

/**
 * Assisted booking phase 1a (design §8.4, §8.7): the money step of a cancellation of a partner-paid booking, inside the
 * one cancellation transaction (bookings/holds.ts cancelBookingSettlement).
 *
 * - Wallet funding: one `refund_credit` of the remaining budget (`funding.amountMinor − Σ refunds`) to the payer's
 *   wallet, exactly once (operation key), restoring the spend's lot allocations. It ALWAYS posts: an inactive, frozen or
 *   suspended wallet or booker included.
 * - The coupon redemption is reversed once (counted → reversed, usage −1).
 * - The join link of the booking dies (`linkVersion` + 1).
 * - An admin cancel of a moved no-show WITHOUT refund keeps the money (funding `forfeited`, coupon stays used).
 * - Phase 1b, card funding (`method: 'razorpay'`): a captured payment goes back by the card refund row of that payment
 *   record (assisted/cardRefunds.ts, exactly once per record): to the card by default, or to the wallet when the booker
 *   chose it at its own cancel (`refundTo: 'wallet'`). A card booking cancelled before its capture was applied refunds
 *   nothing here (`not_paid`); a capture landing later is a late capture, returned by the payment handler.
 */
export const assistedBookerFilter = (kind: 'pharmacy' | 'lab' | 'doctor', id: string) =>
  ({ 'assisted.bookedBy.kind': kind, 'assisted.bookedBy.id': { $eq: String(id).toLowerCase() } });

/** The refund row's cause when the caller named none: who cancelled. */
export const assistedCauseOf = (userType: string) =>
  userType === 'user' ? 'patient' : userType === 'pharmacy' ? 'booker' : userType === 'specialist' ? 'doctor' : userType;

export async function reverseRedemptionIn(bookingKind: AssistedBookingKind, bookingId: string, s: ClientSession): Promise<boolean> {
  const row = await CouponRedemptionModel.findOneAndUpdate({ bookingKind, bookingId: String(bookingId).toLowerCase(), state: 'counted' },
    { $set: { state: 'reversed', reversedAt: new Date() } }, { new: true, session: s }).lean();
  if (!row) return false;
  await CouponModel.updateOne({ code: row.couponCode, currentUsageCount: { $gte: 1 } }, { $inc: { currentUsageCount: -1 } }, { session: s });
  return true;
}

/**
 * Phase 1b, shared by consultations and (r14) lab bookings: the money step of cancelling a CARD-funded assisted booking,
 * in the cancellation transaction. The coupon redemption is reversed once. A capture already applied (funding
 * `captured`) goes back by the card refund row of its payment record (exactly once per record): to the card, or to the
 * wallet when the booker chose it. Nothing applied yet: `not_paid` (a capture landing later is a late capture).
 * Returns the funding state to set, the refund row to push (only when this call created it) and the amount queued.
 */
export async function settleCardFundingIn(kind: AssistedBookingKind, bookingId: string, f: AssistedFunding, p: { cause: string; refundTo?: 'card' | 'wallet' },
  s: ClientSession): Promise<{ state: 'refunded' | 'not_paid'; push: AssistedRefundRow | null; refundedMinor: number }> {
  const id = String(bookingId).toLowerCase();
  await reverseRedemptionIn(kind, id, s);
  const record = f.state === 'captured' && f.paymentRecordId && Types.ObjectId.isValid(f.paymentRecordId)
    ? await PaymentRecordModel.findById(f.paymentRecordId).session(s).lean() as unknown as IPaymentRecord | null : null;
  if (!record) return { state: 'not_paid', push: null, refundedMinor: 0 };
  const q = await queueCardRefundIn({ bookingId: id, bookingKind: kind, payerKind: f.payerKind, payerId: f.payerId, record, cause: p.cause, to: p.refundTo === 'wallet' ? 'wallet' : 'card' }, s);
  return { state: 'refunded', push: q.created ? q.row : null, refundedMinor: q.created ? q.row.amountMinor : 0 };
}

/**
 * The money step of cancelling a WALLET-funded assisted booking (consultation or lab booking, any payer kind: 2e routes
 * it through the booker wallet dispatcher): one `refund_credit` of the remaining budget (`amountMinor − Σ refunds`) to
 * the payer's wallet, exactly once (operation key), restoring the debit's lot allocations on a full refund. It ALWAYS
 * posts: an inactive, frozen or suspended wallet or booker included. Returns the refund row to push (none: nothing left).
 */
export async function refundWalletFundingIn(f: AssistedFunding, p: { cause: string; operationKey: string; referenceType: string; referenceId: string;
  description: string }, s: ClientSession): Promise<{ push: AssistedRefundRow | null; refundedMinor: number }> {
  const already = (f.refunds ?? []).reduce((x, r) => x + Number(r.amountMinor || 0), 0);
  const budget = Number(f.amountMinor || 0) - already;
  if (!(budget > 0) || f.method !== 'wallet') return { push: null, refundedMinor: 0 };
  const restore = already === 0 ? await bookerDebitAllocationsIn(f.payerKind, f.walletEntryId, s) : undefined;
  const posted = await postBookerMovementIn({ payerKind: f.payerKind, payerId: f.payerId, kind: 'refund_credit', amountMinor: budget,
    operationKey: p.operationKey, referenceType: p.referenceType, referenceId: p.referenceId, description: p.description, ...(restore ? { restore } : {}) }, s);
  const attemptId = new Types.ObjectId().toHexString();
  return { refundedMinor: budget, push: { refundId: attemptId, cause: p.cause, amountMinor: budget, method: 'wallet', sourceRef: String(f.walletEntryId ?? ''),
    state: 'processed', walletEntryId: posted.entryId, attemptId, at: new Date() } };
}

/** The refund of a cancellation (not a late or extra capture's return), newest first. */
export const cancellationRowOf = (f?: Pick<AssistedFunding, 'refunds'> | null) =>
  [...(f?.refunds ?? [])].reverse().find((r) => r.cause !== 'late_capture' && r.cause !== 'extra_capture');
/** The booker notice's money line for a cancellation refund: back to the card/UPI, or into the Jansetu wallet. */
export const bookerMoneyLine = (row?: Pick<AssistedRefundRow, 'method'> | null) =>
  (row?.method === 'razorpay' ? ' The amount is being refunded to the card or UPI it was paid with.' : ' The amount is back in your Jansetu wallet.');

export async function settleAssistedFundingIn(booking: IBooking, p: { cause: string; keepMoney: boolean; refundTo?: 'card' | 'wallet' },
  s: ClientSession): Promise<number> {
  const a = booking.assisted!;
  const id = String(booking._id).toLowerCase();
  const set: Record<string, unknown> = {};
  const inc: Record<string, number> = {};
  if (a.join) inc['assisted.join.linkVersion'] = 1;
  if (!booking.cancellationCause) set.cancellationCause = p.cause;
  let refundedMinor = 0;
  let push: AssistedRefundRow | null = null;
  if (p.keepMoney) {
    set['assisted.funding.state'] = 'forfeited';
    set['noShowCancel.forfeitedAmount'] = Number(a.funding.amountMinor) / 100;
  } else if (a.funding.method === 'razorpay') {
    const card = await settleCardFundingIn('booking', id, a.funding, { cause: p.cause, refundTo: p.refundTo }, s);
    set['assisted.funding.state'] = card.state;
    push = card.push;
    refundedMinor = card.refundedMinor;
  } else {
    await reverseRedemptionIn('booking', id, s);
    ({ push, refundedMinor } = await refundWalletFundingIn(a.funding, { cause: p.cause, operationKey: `assisted:${id}:refund`,
      referenceType: 'assisted_booking', referenceId: `${id}:refund`, description: 'Refund of an assisted booking' }, s));
    set['assisted.funding.state'] = 'refunded';
  }
  await BookingModel.updateOne({ _id: id, status: 'cancelled' }, {
    $set: set, ...(Object.keys(inc).length ? { $inc: inc } : {}), ...(push ? { $push: { 'assisted.funding.refunds': push } } : {}),
  }, { session: s });
  return refundedMinor / 100;
}
