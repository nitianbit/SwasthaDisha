import mongoose, { ClientSession, startSession } from 'mongoose';
import { addDaysToYyyymmdd } from '@/modules/common/utils/dateUtils';
import PharmacySubscriptionModel from '@/modules/pharmacySubscriptions/model';

/**
 * Dependency-light on purpose (models + date utils only): imported by PaymentService and PharmacyOrderService,
 * so it must not import either service (TypeDI constructor metadata breaks on import cycles).
 *
 * When an order becomes paid: if it is the bound refill order of its subscription's current cycle, the subscription
 * moves to the next cycle exactly once (fenced on pendingRefill.orderId), and the cycle is recorded so that
 * source-order reconciliation no longer rewrites the refill date.
 */
export async function advanceRefillOnPayment(
  order: { _id?: unknown; refill?: { subscriptionId?: string; cycleDate?: string } },
  session?: ClientSession
): Promise<void> {
  const refill = order.refill;
  if (!refill?.subscriptionId || !refill.cycleDate) return;
  const run = async (s: ClientSession) => {
    // D3: the cycle moves on only while the order is not frozen by a cancellation request (a rejection advances it
    // then; an approval never does). The conditional touch of the order also conflicts with a concurrent request's
    // write, so the two are serialised.
    const orders = mongoose.models.PharmacyOrder?.collection ?? mongoose.connection.collection('pharmacyorders');
    const live = await orders.updateOne(
      { _id: new mongoose.Types.ObjectId(String(order._id)), status: { $ne: 'pending_cancel' } }, { $set: { updatedAt: new Date() } }, { session: s });
    if (live.matchedCount === 0) return;
    const sub = await PharmacySubscriptionModel.findOne({ _id: refill.subscriptionId, 'pendingRefill.orderId': String(order._id) }).session(s).lean();
    if (!sub) return;
    await PharmacySubscriptionModel.updateOne({ _id: sub._id, 'pendingRefill.orderId': String(order._id) },
      { $set: { nextRefillDate: addDaysToYyyymmdd(refill.cycleDate!, Number(sub.intervalDays)), lastRefilledCycle: refill.cycleDate },
        $unset: { pendingRefill: '' } }, { session: s });
  };
  if (session) return run(session);
  const own = await startSession();
  try { await own.withTransaction(async () => { await run(own); }); } finally { await own.endSession(); }
}
