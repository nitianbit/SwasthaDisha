import { Service } from 'typedi';
import { Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { addDaysToYyyymmdd, getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import PharmacyModel from '@/modules/pharmacies/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import { IPharmacyOrder } from '@/modules/pharmacyOrders/types';
import PharmacySubscriptionModel from '@/modules/pharmacySubscriptions/model';
import PaymentRecordModel from '@/modules/payment/model';
import { CONFIG } from '@/config/config';

export { advanceRefillOnPayment } from '@/modules/pharmacySubscriptions/refillCycle';

/** How far ahead of the due date a refill order may be created. */
export const REFILL_LEAD_DAYS = 7;
/** A refill order waits this long for the customer's payment (normal online orders: 30 minutes). */
export const REFILL_PAYMENT_WINDOW_MS = Math.max(1, Number(process.env.REFILL_PAYMENT_WINDOW_HOURS || 48)) * 3600_000;
const UNPAID_TERMINAL = ['abandoned', 'cancelled', 'rejected'];

export interface RefillActor { _id: string; userType: string; pharmacyId?: string }
export interface RefillOrderRequest { quantity?: number; deliveryMode?: 'pickup' | 'delivery'; deliveryAddress?: string }

const notFound = () => new AppError({ status: 404, code: 'SUBSCRIPTION_NOT_FOUND', message: 'Refill subscription not found' });
const conflict = (code: string, message: string) => new AppError({ status: 409, code, message });
const isDuplicateId = (e: unknown) => (e as { code?: number })?.code === 11000 && /_id_|_id:/.test(String((e as Error)?.message));

/**
 * Refill orders (P7). The pharmacy or the customer creates the order for a due refill; it stays unconfirmed
 * ('placed', payment pending) until the customer pays; the payment path then advances the subscription's next refill
 * date in the same transaction (refillCycle.advanceRefillOnPayment).
 *
 * Exactly one order per cycle, crash-safe: the cycle's order id is allocated and stored on the subscription FIRST
 * (pendingRefill.orderId); the order is then inserted under that id with its refill binding in the same insert as its
 * stock reservation. A retry or a concurrent/slow creator can only ever (re)create that same id: the duplicate insert
 * fails and the existing order is returned. Only a terminal unpaid order frees the cycle for a new id.
 */
@Service()
export class RefillOrderService {
  constructor(private orders: PharmacyOrderService) {}

  async createRefillOrder(subscriptionId: unknown, actor: RefillActor, body: RefillOrderRequest = {}) {
    if (typeof subscriptionId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(subscriptionId)) throw notFound();
    const id = subscriptionId.toLowerCase();
    const sub = await PharmacySubscriptionModel.findById(id).lean();
    if (!sub) throw notFound();
    const isPharmacy = actor.userType === 'pharmacy' && !!actor.pharmacyId && String(sub.pharmacyId) === actor.pharmacyId;
    const isCustomer = actor.userType === 'user' && String(sub.userId) === actor._id;
    if (!isPharmacy && !isCustomer) throw notFound();
    if (body.quantity !== undefined && !isPharmacy) throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Only the pharmacy can change the refill quantity' });
    // The subscription's pharmacy must be operational right now, whoever is asking (suspension after token issue).
    const pharmacy = await PharmacyModel.findById(sub.pharmacyId).select('isActive isVerified archivedAt').lean() as
      { isActive?: boolean; isVerified?: boolean; archivedAt?: Date } | null;
    if (!pharmacy || pharmacy.archivedAt || pharmacy.isActive === false || !pharmacy.isVerified) {
      throw new AppError({ status: 403, code: 'PHARMACY_NOT_OPERATIONAL', message: 'This pharmacy is not accepting orders right now' });
    }
    if (sub.isActive !== true) throw conflict('SUBSCRIPTION_INACTIVE', 'This refill subscription is not active');
    const today = getTodayYyyymmdd();
    if (sub.pausedUntil && sub.pausedUntil >= today) throw conflict('SUBSCRIPTION_PAUSED', `Refills are paused until ${sub.pausedUntil}`);
    const cycle = sub.nextRefillDate;
    if (!cycle) throw conflict('REFILL_DATE_MISSING', 'This subscription has no next refill date');
    if (cycle > addDaysToYyyymmdd(today, REFILL_LEAD_DAYS)) throw conflict('REFILL_NOT_DUE', `This refill is due on ${cycle}`);

    // 1. The cycle's order id: reuse the bound one unless its order ended unpaid; otherwise allocate a new one.
    let orderId: string | undefined;
    const bound = sub.pendingRefill?.cycleDate === cycle ? sub.pendingRefill.orderId : undefined;
    if (bound) {
      const existing = await PharmacyOrderModel.findById(bound).lean();
      if (existing && !(UNPAID_TERMINAL.includes(String(existing.status)) && existing.paymentStatus !== 'paid')) {
        return this.existingResponse(String(existing._id), existing as IPharmacyOrder);
      }
      if (!existing) orderId = bound; // allocated but never created (crash/failure): recreate under the SAME id
    }
    if (!orderId) {
      const fresh = new Types.ObjectId().toHexString();
      const allocated = await PharmacySubscriptionModel.updateOne(
        { _id: id, isActive: true, nextRefillDate: cycle,
          ...(bound ? { 'pendingRefill.orderId': bound } : { $or: [{ pendingRefill: { $exists: false } }, { 'pendingRefill.cycleDate': { $ne: cycle } }] }) },
        { $set: { pendingRefill: { cycleDate: cycle, orderId: fresh, claimedAt: new Date() } } });
      if (allocated.modifiedCount === 1) orderId = fresh;
      else {
        const again = await PharmacySubscriptionModel.findById(id).lean();
        if (again?.pendingRefill?.cycleDate !== cycle || !again.pendingRefill.orderId) {
          throw conflict('SUBSCRIPTION_CHANGED', 'The refill subscription changed; reload and try again');
        }
        orderId = again.pendingRefill.orderId; // another request allocated it: converge on that id
        const existing = await PharmacyOrderModel.findById(orderId).lean();
        if (existing) return this.existingResponse(String(existing._id), existing as IPharmacyOrder);
      }
    }

    // 2. Create the order under that id (refill binding inside the same insert). A duplicate id means another request
    //    already created it: return that order.
    const source = sub.sourceOrderId ? await PharmacyOrderModel.findById(sub.sourceOrderId).lean() : null;
    const sourceItem = source?.items?.find(i => String(i.medicineId) === String(sub.medicineId));
    const quantity = body.quantity ?? sourceItem?.orderedQty ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid refill quantity' });
    const deliveryMode = body.deliveryMode ?? source?.deliveryMode ?? 'pickup';
    const deliveryAddress = body.deliveryAddress ?? (deliveryMode === 'delivery' ? source?.deliveryAddress : undefined);
    if (deliveryMode === 'delivery' && !deliveryAddress) {
      throw new AppError({ status: 400, code: 'DELIVERY_ADDRESS_REQUIRED', message: 'A delivery address is required' });
    }
    try {
      const result = await this.orders.create(String(sub.pharmacyId), {
        orderType: 'online',
        customerId: String(sub.userId),
        items: [{ medicineId: String(sub.medicineId), orderedQty: quantity }],
        paymentMode: 'online_payment',
        deliveryMode,
        deliveryAddress,
        notes: `Refill for ${cycle}`,
      } as never, actor._id, isPharmacy ? 'pharmacy' : 'user', {
        orderId,
        refill: { subscriptionId: id, cycleDate: cycle, paymentDueBy: new Date(Date.now() + REFILL_PAYMENT_WINDOW_MS) },
      });
      return { order: result.order as IPharmacyOrder, created: true, paymentRequired: result.paymentRequired, payment: result.payment };
    } catch (error) {
      if (isDuplicateId(error)) {
        const existing = await PharmacyOrderModel.findById(orderId).lean();
        if (existing) return this.existingResponse(String(existing._id), existing as IPharmacyOrder);
      }
      throw error; // the allocation stays: a later retry recreates under the same id
    }
  }

  /**
   * Existing refill order: finish any interrupted creation step, then return what the payer needs to pay it (the
   * linked payment record's checkout details) while it is unpaid. Callers are already scoped to the subscribed
   * customer or the owning pharmacy.
   */
  private async existingResponse(orderId: string, fallback: IPharmacyOrder) {
    const order = ((await this.orders.resumeRefillOrder(orderId)) ?? fallback) as IPharmacyOrder;
    let payment: Record<string, unknown> | undefined;
    if (order.paymentStatus !== 'paid' && order.status === 'placed' && order.paymentTransactionId) {
      const record = await PaymentRecordModel.findById(String(order.paymentTransactionId)).lean();
      if (record && record.context === 'pharmacy_order' && record.contextId === String(order._id) && record.status === 'created') {
        payment = { paymentTransactionId: String(record._id), razorpayOrderId: record.razorpayOrderId, razorpayKeyId: CONFIG.RAZORPAY_KEY_ID,
          amount: record.finalAmount, currency: record.currency, baseAmount: record.baseAmount, discountAmount: record.discountAmount };
      }
    }
    return { order, created: false, paymentRequired: order.paymentStatus !== 'paid', ...(payment ? { payment } : {}) };
  }

  /** Customer view: their active refill subscriptions (minimal fields). */
  async listMine(userId: string) {
    return PharmacySubscriptionModel.find({ userId, isActive: true })
      .select('_id pharmacyId medicineId medicineName intervalDays nextRefillDate pausedUntil pendingRefill.orderId pendingRefill.cycleDate')
      .sort({ nextRefillDate: 1 }).limit(100).lean();
  }
}
