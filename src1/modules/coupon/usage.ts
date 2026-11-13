import { ClientSession } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { CouponModel } from '@/modules/coupon/model';
import PaymentRecordModel from '@/modules/payment/model';

/**
 * Coupon usage, counted once per payment record and undone at most once (A2a, milestone C5). The record's
 * `couponUsage` state and the coupon's `currentUsageCount` always change in the SAME transaction:
 *   (absent)  gateway records and every record from before this change: counted iff `isProcessed` (the old
 *             finalizer set isProcessed and then counted; a crash between the two is the one legacy unknown)
 *   pending   carries a coupon that has not been counted yet
 *   counted   counted once
 *   void      cancelled before it was counted: it never will be
 *   reversed  counted, then undone by the booking's cancellation
 */
export type CouponUsageState = 'pending' | 'counted' | 'void' | 'reversed';

const codeOf = (c: unknown) => (typeof c === 'string' && c.trim() ? c.trim().toUpperCase() : null);
const changed = () => Object.assign(new AppError({ status: 409, code: 'COUPON_USAGE_CHANGED', message: 'Payment changed; please retry' }),
  { retryable: true });

/**
 * Counts the record's coupon once. The caller guarantees the record was not processed before (the finalizer's
 * isProcessed transition in this same transaction, or a record created in it), so an absent state means "not counted".
 * A record cancellation voided is never counted.
 */
export async function countCouponUsageIn(recordId: string, s: ClientSession): Promise<boolean> {
  const rec = await PaymentRecordModel.findById(recordId).session(s).lean();
  const code = codeOf(rec?.couponCode);
  if (!rec || !code) return false;
  const r = await PaymentRecordModel.updateOne({ _id: rec._id, $or: [{ couponUsage: 'pending' }, { couponUsage: { $exists: false } }] },
    { $set: { couponUsage: 'counted' } }, { session: s });
  if (r.modifiedCount !== 1) return false;
  await CouponModel.updateOne({ code }, { $inc: { currentUsageCount: 1 } }, { session: s });
  return true;
}

/**
 * Cancellation: every coupon counted for these records is undone once (counted → reversed, usage −1); one not counted
 * yet is voided so a later finalizer cannot count it for a cancelled booking. Writing the record serializes this with
 * a concurrent finalizer (it writes the same record in its own transaction).
 */
export async function undoCouponUsageIn(recordIds: string[], s: ClientSession): Promise<number> {
  let undone = 0;
  for (const id of recordIds) {
    const rec = await PaymentRecordModel.findById(id).session(s).lean();
    const code = codeOf(rec?.couponCode);
    if (!rec || !code) continue;
    const state = rec.couponUsage as CouponUsageState | undefined;
    if (state === 'void' || state === 'reversed') continue;
    // Legacy: only a processed record that is still paid was counted and not yet undone by the old code.
    const counted = state === 'counted' || (state === undefined && rec.isProcessed === true && rec.status === 'paid');
    if (state === undefined && rec.isProcessed === true && !counted) continue; // legacy refunded: leave as the old code left it
    const r = await PaymentRecordModel.updateOne({ _id: rec._id, isProcessed: rec.isProcessed === true ? true : { $ne: true }, status: rec.status,
      ...(state === undefined ? { couponUsage: { $exists: false } } : { couponUsage: state }) },
    { $set: { couponUsage: counted ? 'reversed' : 'void' } }, { session: s });
    if (r.modifiedCount !== 1) throw changed();
    if (counted) {
      await CouponModel.updateOne({ code, currentUsageCount: { $gte: 1 } }, { $inc: { currentUsageCount: -1 } }, { session: s });
      undone += 1;
    }
  }
  return undone;
}
