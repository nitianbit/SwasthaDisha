/**
 * P7a refill orders against a real MongoDB replica set: RefillOrderService with the real PharmacyOrderService.create,
 * the real PaymentService.processPharmacyOrderPayment (payment core transaction) and the real stale-order sweep.
 * Inventory, pricing lookup and payment-order creation are recording stubs.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/p7_refill_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/pharmacy-refill/p7-refill-orders.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { addDaysToYyyymmdd, getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import '@/modules/user/model';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacySubscriptionService } from '@/modules/pharmacySubscriptions/services';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import PharmacySubscriptionModel from '@/modules/pharmacySubscriptions/model';
import { RefillOrderService, REFILL_PAYMENT_WINDOW_MS, advanceRefillOnPayment } from '@/modules/pharmacySubscriptions/refillOrders';
import MedicineModel from '@/modules/pharmacyMedicines/model';
import { MedicineRepository } from '@/modules/pharmacyMedicines/repository';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/p7_refill_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const stock = { reserved: 0, released: 0 };
const price = { retail: 50 };
const direct: { gate?: Promise<void>; waiting?: boolean; failNext?: boolean } = {};
const gw: { gate?: Promise<void>; waiting?: boolean; failAfterGate?: boolean } = {};
const inventory = {
  getInventoryByMedicine: async () => ({ retailPrice: price.retail, wholesalePrice: 40 }),
  reserveOrderStockBulk: async (_p: string, items: { quantity: number }[]) => { stock.reserved += items.reduce((a, i) => a + i.quantity, 0); return new Map(); },
  releaseOrderStockBulk: async () => undefined,
  returnStockBulk: async (_p: string, items: { quantity: number }[]) => { stock.released += items.reduce((a, i) => a + i.quantity, 0); return []; },
  consumeOrderReservedStockBulk: async () => undefined,
};
const paymentStub = {
  createOrder: async (d: { userId: string; payerUserId?: string; context: string; contextId: string; baseAmount: number; discountAmount: number; finalAmount: number; notes: object }) => {
    const gate = gw.gate; gw.gate = undefined;
    if (gate) { gw.waiting = true; await gate; gw.waiting = false; if (gw.failAfterGate) { gw.failAfterGate = false; throw new Error('gateway order failed'); } }
    const rec = await PaymentRecordModel.create({ userId: d.userId, payerUserId: d.payerUserId, context: d.context, contextId: d.contextId, baseAmount: d.baseAmount,
      discountAmount: d.discountAmount, finalAmount: d.finalAmount, currency: 'INR', paymentGateway: 'razorpay',
      razorpayOrderId: 'ord_' + new Types.ObjectId().toHexString(), status: 'created', notes: d.notes });
    return { paymentRecord: rec.toObject(), razorpayOrder: { id: rec.razorpayOrderId, amount: d.finalAmount * 100, currency: 'INR', status: 'created' }, razorpayKeyId: 'k' };
  },
  createDirectPaidTransaction: async (d: { userId: string; context: string; contextId: string; baseAmount: number; discountAmount: number; notes: object }) => {
    const gate = direct.gate; direct.gate = undefined;
    if (gate) { direct.waiting = true; await gate; direct.waiting = false; throw new Error('direct payment setup failed'); }
    if (direct.failNext) { direct.failNext = false; throw new Error('direct payment setup failed'); }
    return (await PaymentRecordModel.create({ userId: d.userId, context: d.context, contextId: d.contextId, baseAmount: d.baseAmount, discountAmount: d.discountAmount,
      finalAmount: 0, currency: 'INR', paymentGateway: 'internal', status: 'paid', notes: d.notes })).toObject();
  },
};
const sideEffects = { queueNotification: async () => undefined, queueSubscriptionSync: async () => undefined };
const orders = new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
  new PharmacyOrderRepository(), { ensureLinked: async () => undefined }, inventory, paymentStub, {}, {}, sideEffects, new MedicineRepository(),
  { buildIntent: async () => undefined, settleAfterRejection: async () => undefined });
const refills = new RefillOrderService(orders);
const payments = Object.assign(Object.create(PaymentService.prototype), {
  pharmacyOrderRepository: new PharmacyOrderRepository(), paymentRepository: new PaymentRepository(), inventoryService: inventory,
  pharmacyOrderSideEffectService: sideEffects, couponService: {}, incrementCouponUsageAfterProcessing: async () => undefined,
}) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;

const pharmacyA = new Types.ObjectId().toHexString();
const pharmacyB = new Types.ObjectId().toHexString();
const today = getTodayYyyymmdd();

async function medicine(rx = false) {
  const { insertedId } = await MedicineModel.collection.insertOne({ name: rx ? 'RxMed' : 'Vitamin D', isActive: true, prescriptionRequired: rx, gstPercent: 0 } as never);
  return insertedId.toHexString();
}
/** Subscription due today for a customer, created from a source order of quantity 3, home delivery. */
async function subscription(opts: { rx?: boolean; next?: string; pausedUntil?: string; active?: boolean } = {}) {
  const customer = new Types.ObjectId().toHexString();
  const med = await medicine(opts.rx);
  const source = await PharmacyOrderModel.create({ pharmacyId: pharmacyA, orderType: 'online', status: 'completed', customerId: customer,
    createdById: customer, createdByRole: 'user', paymentMode: 'online_payment', paymentStatus: 'paid', deliveryMode: 'delivery', deliveryAddress: '12 MG Road',
    items: [{ medicineId: med, medicineName: 'Vitamin D', orderedQty: 3, unitPrice: 50, lineTotal: 150, prescriptionRequired: false, itemStatus: 'active' }] });
  const sub = await PharmacySubscriptionModel.create({ pharmacyId: pharmacyA, userId: customer, medicineId: med, intervalDays: 30,
    nextRefillDate: opts.next ?? today, isActive: opts.active ?? true, pausedUntil: opts.pausedUntil, sourceOrderId: source._id });
  return { id: String(sub._id), customer, med };
}
const pharmacy = { _id: pharmacyA, userType: 'pharmacy', pharmacyId: pharmacyA };
const subRow = (id: string) => PharmacySubscriptionModel.findById(id).lean();
async function pay(orderId: string) {
  const order = (await PharmacyOrderModel.findById(orderId).lean())!;
  await PaymentRecordModel.updateOne({ _id: order.paymentTransactionId }, { $set: { status: 'paid' } });
  return payments.processPharmacyOrderPayment(await PaymentRecordModel.findById(order.paymentTransactionId).lean());
}
async function rejects(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: { code?: string; status?: number }) => e.code === code && (status === undefined || e.status === status));
}

/** Customer tokens are admitted only for an existing customer account (credential generation check): create it. */
async function bearer(claims: { _id?: unknown; userType?: unknown }): Promise<string> {
  if (claims.userType === 'user' && typeof claims._id === 'string') {
    await mongoose.model('User').collection.updateOne({ _id: new mongoose.Types.ObjectId(claims._id) },
      { $setOnInsert: { userType: 'user', isActive: true } }, { upsert: true });
  }
  return jwt.sign(claims, CONFIG.JWT_SECRET_KEY);
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(url);
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await Promise.all([PharmacyOrderModel.init(), PharmacySubscriptionModel.init(), PaymentRecordModel.init()]);
  for (const [n, pid] of [pharmacyA, pharmacyB].entries()) {
    await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(pid), isActive: true, isVerified: true, phone: '91000000' + n, email: `r${n}@example.com` } as never);
  }

  await check('pharmacy creates a refill: unconfirmed until paid, source quantity/delivery copied, 48h payment window; repeat is idempotent', async () => {
    const s = await subscription();
    const r = await refills.createRefillOrder(s.id, pharmacy);
    assert.equal(r.created, true);
    const o = r.order;
    assert.equal(o.status, 'placed'); assert.equal(o.paymentStatus, 'pending');
    assert.equal(o.items[0].orderedQty, 3); assert.equal(o.deliveryMode, 'delivery'); assert.equal(o.deliveryAddress, '12 MG Road');
    assert.equal(String(o.customerId), s.customer);
    assert.equal(o.refill?.cycleDate, today);
    const window = new Date(o.refill!.paymentDueBy).getTime() - Date.now();
    assert.ok(window > REFILL_PAYMENT_WINDOW_MS - 60_000 && window <= REFILL_PAYMENT_WINDOW_MS);
    assert.equal((await subRow(s.id))!.pendingRefill?.orderId, String(o._id));
    const again = await refills.createRefillOrder(s.id, { _id: s.customer, userType: 'user' });
    assert.equal(again.created, false); assert.equal(String(again.order._id), String(o._id));
  });

  await check('customer pays: order accepted and the subscription moves to the next cycle in the same transaction, once', async () => {
    const s = await subscription();
    const r = await refills.createRefillOrder(s.id, { _id: s.customer, userType: 'user' });
    await pay(String(r.order._id));
    const o = (await PharmacyOrderModel.findById(r.order._id).lean())!;
    assert.equal(o.status, 'accepted'); assert.equal(o.paymentStatus, 'paid');
    const sub = (await subRow(s.id))!;
    assert.equal(sub.nextRefillDate, addDaysToYyyymmdd(today, 30)); assert.equal(sub.pendingRefill, undefined);
    assert.equal((await PaymentRecordModel.findById(o.paymentTransactionId).lean())!.isProcessed, true, 'replays stop at the processed record');
    const session = await mongoose.startSession();
    try { await session.withTransaction(async () => { await advanceRefillOnPayment(o as never, session); }); } finally { await session.endSession(); }
    assert.equal((await subRow(s.id))!.nextRefillDate, addDaysToYyyymmdd(today, 30), 'the cycle advance itself is also one-shot');
  });

  await check('payment 2 hours after creation is NOT treated as late (refill window), unlike a normal 30-minute order', async () => {
    const s = await subscription();
    const r = await refills.createRefillOrder(s.id, pharmacy);
    await PharmacyOrderModel.collection.updateOne({ _id: new Types.ObjectId(String(r.order._id)) }, { $set: { createdAt: new Date(Date.now() - 2 * 3600_000) } });
    await pay(String(r.order._id));
    assert.equal((await PharmacyOrderModel.findById(r.order._id).lean())!.status, 'accepted');
  });

  await check('stale sweep keeps a 2-hour-old unpaid refill; abandons it after its deadline, releases stock, and the cycle can be re-ordered', async () => {
    const s = await subscription();
    const r = await refills.createRefillOrder(s.id, pharmacy);
    const oid = new Types.ObjectId(String(r.order._id));
    await PharmacyOrderModel.collection.updateOne({ _id: oid }, { $set: { createdAt: new Date(Date.now() - 2 * 3600_000) } });
    await orders.abandonStaleUnpaidOrders();
    assert.equal((await PharmacyOrderModel.findById(oid).lean())!.status, 'placed');
    await PharmacyOrderModel.collection.updateOne({ _id: oid }, { $set: { 'refill.paymentDueBy': new Date(Date.now() - 1000) } });
    const before = stock.released;
    await orders.abandonStaleUnpaidOrders();
    assert.equal((await PharmacyOrderModel.findById(oid).lean())!.status, 'abandoned');
    assert.equal(stock.released - before, 3);
    const next = await refills.createRefillOrder(s.id, pharmacy);
    assert.equal(next.created, true); assert.notEqual(String(next.order._id), String(oid));
  });

  await check('authority, timing and state rules', async () => {
    const s = await subscription();
    await rejects(refills.createRefillOrder(s.id, { _id: new Types.ObjectId().toHexString(), userType: 'user' }), 'SUBSCRIPTION_NOT_FOUND', 404);
    await rejects(refills.createRefillOrder(s.id, { _id: pharmacyB, userType: 'pharmacy', pharmacyId: pharmacyB }), 'SUBSCRIPTION_NOT_FOUND', 404);
    await rejects(refills.createRefillOrder(s.id, { _id: s.customer, userType: 'user' }, { quantity: 9 }), 'FORBIDDEN', 403);
    await rejects(refills.createRefillOrder((await subscription({ next: addDaysToYyyymmdd(today, 20) })).id, pharmacy), 'REFILL_NOT_DUE', 409);
    assert.equal((await refills.createRefillOrder((await subscription({ next: addDaysToYyyymmdd(today, 5) })).id, pharmacy)).created, true, '5 days early is allowed');
    await rejects(refills.createRefillOrder((await subscription({ pausedUntil: addDaysToYyyymmdd(today, 3) })).id, pharmacy), 'SUBSCRIPTION_PAUSED', 409);
    await rejects(refills.createRefillOrder((await subscription({ active: false })).id, pharmacy), 'SUBSCRIPTION_INACTIVE', 409);
    await rejects(refills.createRefillOrder('nope', pharmacy), 'SUBSCRIPTION_NOT_FOUND', 404);
  });

  await check('prescription medicine refill is blocked (existing Rx gate); the allocated id is kept, no order created', async () => {
    const s = await subscription({ rx: true });
    await rejects(refills.createRefillOrder(s.id, pharmacy), 'PRESCRIPTION_CHECKOUT_UNAVAILABLE', 503);
    const allocated = (await subRow(s.id))!.pendingRefill?.orderId;
    assert.ok(allocated); assert.equal(await PharmacyOrderModel.countDocuments({ _id: allocated }), 0, 'no order exists');
    await rejects(refills.createRefillOrder(s.id, pharmacy), 'PRESCRIPTION_CHECKOUT_UNAVAILABLE', 503);
    assert.equal((await subRow(s.id))!.pendingRefill?.orderId, allocated, 'retries keep the same allocated id');
  });

  await check('five concurrent creations (pharmacy + customer) produce exactly one refill order', async () => {
    const s = await subscription();
    const actors = [pharmacy, { _id: s.customer, userType: 'user' }, pharmacy, { _id: s.customer, userType: 'user' }, pharmacy];
    const results = await Promise.allSettled(actors.map(a => refills.createRefillOrder(s.id, a)));
    const ids = new Set(results.filter(r => r.status === 'fulfilled').map(r => String((r as PromiseFulfilledResult<{ order: { _id: unknown } }>).value.order._id)));
    assert.equal(ids.size, 1);
    const fulfilled = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ created: boolean }>[];
    assert.equal(fulfilled.filter(r => r.value.created).length, 1, 'exactly one creator reports created');
    for (const r of results) if (r.status === 'rejected') assert.ok(['SUBSCRIPTION_CHANGED'].includes(r.reason.code), r.reason.code);
    assert.equal(await PharmacyOrderModel.countDocuments({ 'refill.subscriptionId': s.id }), 1);
  });

  await check('customer "my refills" lists only their own active subscriptions', async () => {
    const s = await subscription(); await subscription();
    const mine = await refills.listMine(s.customer);
    assert.equal(mine.length, 1); assert.equal(String(mine[0]._id), s.id);
  });

  await check('[R2] crash after allocating the cycle id, before the order exists: the retry creates THAT id, never a second order', async () => {
    const s = await subscription();
    const allocated = new Types.ObjectId().toHexString();
    await PharmacySubscriptionModel.updateOne({ _id: s.id }, { $set: { pendingRefill: { cycleDate: today, orderId: allocated, claimedAt: new Date(Date.now() - 3600_000) } } });
    const r = await refills.createRefillOrder(s.id, { _id: s.customer, userType: 'user' });
    assert.equal(r.created, true); assert.equal(String(r.order._id), allocated);
    assert.equal(r.order.refill?.cycleDate, today, 'bound inside the same insert');
    assert.equal(await PharmacyOrderModel.countDocuments({ 'refill.subscriptionId': s.id }), 1);
  });

  await check('[R3] suspended / unverified / archived pharmacy: no refill order for the pharmacy or the customer', async () => {
    for (const patch of [{ isActive: false }, { isVerified: false }, { archivedAt: new Date() }]) {
      const s = await subscription();
      await PharmacyModel.collection.updateOne({ _id: new Types.ObjectId(pharmacyA) }, { $set: patch });
      try {
        await rejects(refills.createRefillOrder(s.id, pharmacy), 'PHARMACY_NOT_OPERATIONAL', 403);
        await rejects(refills.createRefillOrder(s.id, { _id: s.customer, userType: 'user' }), 'PHARMACY_NOT_OPERATIONAL', 403);
      } finally {
        await PharmacyModel.collection.updateOne({ _id: new Types.ObjectId(pharmacyA) }, { $set: { isActive: true, isVerified: true }, $unset: { archivedAt: '' } });
      }
      assert.equal(await PharmacyOrderModel.countDocuments({ 'refill.subscriptionId': s.id }), 0);
    }
  });

  await check('[R4] a source-order sync after the refill was paid does not rewind the refill date', async () => {
    const s = await subscription();
    const r = await refills.createRefillOrder(s.id, pharmacy);
    await pay(String(r.order._id));
    const advanced = addDaysToYyyymmdd(today, 30);
    assert.equal((await subRow(s.id))!.nextRefillDate, advanced);
    const subs = new (PharmacySubscriptionService as unknown as new (...a: unknown[]) => PharmacySubscriptionService)(
      new (await import('@/modules/pharmacySubscriptions/repository')).PharmacySubscriptionRepository(), { assertLinked: async () => undefined });
    const sub = (await subRow(s.id))!;
    await subs.reconcileForOrder(pharmacyA, s.customer, String(sub.sourceOrderId), 'completed',
      [{ medicineId: s.med, intervalDays: 30, nextRefillDate: today }], pharmacyA);
    assert.equal((await subRow(s.id))!.nextRefillDate, advanced, 'still the next cycle, not the paid one');
  });

  await check('[R4b] a sync that READ before the refill was paid and writes after it still does not rewind the date', async () => {
    const s = await subscription();
    const { PharmacySubscriptionRepository } = await import('@/modules/pharmacySubscriptions/repository');
    const repo = new PharmacySubscriptionRepository();
    const staleRows = await repo.findBySourceOrderId(String((await subRow(s.id))!.sourceOrderId)); // sync reads now...
    const r = await refills.createRefillOrder(s.id, pharmacy);
    await pay(String(r.order._id));                                                          // ...refill paid meanwhile...
    const advanced = addDaysToYyyymmdd(today, 30);
    const staleRepo = Object.assign(Object.create(repo), { findBySourceOrderId: async () => staleRows });
    const subs = new (PharmacySubscriptionService as unknown as new (...a: unknown[]) => PharmacySubscriptionService)(staleRepo, { assertLinked: async () => undefined });
    await subs.reconcileForOrder(pharmacyA, s.customer, String(staleRows[0].sourceOrderId), 'completed',
      [{ medicineId: s.med, intervalDays: 30, nextRefillDate: today }], pharmacyA);            // ...then the sync writes
    assert.equal((await subRow(s.id))!.nextRefillDate, advanced);
  });

  await check('[R7] crash after the order insert but before payment setup: asking again sets up payment, no new order/stock', async () => {
    const s = await subscription();
    const orderId = new Types.ObjectId();
    await PharmacyOrderModel.create({ _id: orderId, pharmacyId: pharmacyA, orderType: 'online', status: 'placed', customerId: s.customer, createdById: pharmacyA,
      createdByRole: 'pharmacy', paymentMode: 'online_payment', paymentStatus: 'pending', subtotal: 150, discountTotal: 0, grandTotal: 150,
      items: [{ medicineId: s.med, medicineName: 'Vitamin D', orderedQty: 3, unitPrice: 50, lineTotal: 150, prescriptionRequired: false, itemStatus: 'active' }],
      refill: { subscriptionId: s.id, cycleDate: today, paymentDueBy: new Date(Date.now() + 3600_000) } });
    await PharmacySubscriptionModel.updateOne({ _id: s.id }, { $set: { pendingRefill: { cycleDate: today, orderId: String(orderId), claimedAt: new Date() } } });
    const reserved = stock.reserved;
    const r = await refills.createRefillOrder(s.id, { _id: s.customer, userType: 'user' });
    assert.equal(r.created, false); assert.equal(String(r.order._id), String(orderId));
    assert.ok(r.order.paymentTransactionId, 'payment set up for the existing order');
    assert.equal(stock.reserved, reserved, 'no second stock reservation');
    assert.equal(await PharmacyOrderModel.countDocuments({ 'refill.subscriptionId': s.id }), 1);
    await pay(String(orderId));
    assert.equal((await subRow(s.id))!.nextRefillDate, addDaysToYyyymmdd(today, 30));
  });

  await check('[R8] paid refill whose cycle advance was lost: asking again advances it (once)', async () => {
    const s = await subscription();
    const orderId = new Types.ObjectId();
    await PharmacyOrderModel.create({ _id: orderId, pharmacyId: pharmacyA, orderType: 'online', status: 'accepted', customerId: s.customer, createdById: pharmacyA,
      createdByRole: 'pharmacy', paymentMode: 'online_payment', paymentStatus: 'paid', grandTotal: 0,
      items: [{ medicineId: s.med, medicineName: 'Vitamin D', orderedQty: 3, unitPrice: 0, lineTotal: 0, prescriptionRequired: false, itemStatus: 'active' }],
      refill: { subscriptionId: s.id, cycleDate: today, paymentDueBy: new Date(Date.now() + 3600_000) } });
    await PharmacySubscriptionModel.updateOne({ _id: s.id }, { $set: { pendingRefill: { cycleDate: today, orderId: String(orderId), claimedAt: new Date() } } });
    await refills.createRefillOrder(s.id, pharmacy);
    const sub = (await subRow(s.id))!;
    assert.equal(sub.nextRefillDate, addDaysToYyyymmdd(today, 30)); assert.equal(sub.pendingRefill, undefined);
    await rejects(refills.createRefillOrder(s.id, pharmacy), 'REFILL_NOT_DUE', 409);
  });

  await check('[R5] free (zero-priced) refill is paid at creation and advances the cycle through the same path', async () => {
    const s = await subscription();
    price.retail = 0;
    try {
      const r = await refills.createRefillOrder(s.id, pharmacy);
      assert.equal(r.order.paymentStatus, 'paid');
    } finally { price.retail = 50; }
    assert.equal((await subRow(s.id))!.nextRefillDate, addDaysToYyyymmdd(today, 30));
    assert.equal((await subRow(s.id))!.pendingRefill, undefined);
  });

  await check('[Z1] free refill: a concurrent request completes it while the original setup is pending, then the original fails', async () => {
    const s = await subscription();
    price.retail = 0;
    let release!: () => void; direct.gate = new Promise(r => { release = r; });
    try {
      const original = refills.createRefillOrder(s.id, pharmacy);                 // inserted (pending), setup blocked
      while (!direct.waiting) await new Promise(r => setTimeout(r, 10));
      const order = (await PharmacyOrderModel.findOne({ 'refill.subscriptionId': s.id }).lean())!;
      assert.equal(order.paymentStatus, 'pending', 'never visible as paid before completion');
      const second = await refills.createRefillOrder(s.id, { _id: s.customer, userType: 'user' }); // resume completes it
      assert.equal(second.order.paymentStatus, 'paid');
      const releasedBefore = stock.released;
      release();
      await assert.rejects(original);                                              // original setup fails afterwards
      const after = (await PharmacyOrderModel.findById(order._id).lean())!;
      assert.equal(after.status, 'accepted'); assert.equal(after.paymentStatus, 'paid');
      assert.equal(stock.released, releasedBefore, 'compensation did not abandon a completed order');
      assert.equal((await subRow(s.id))!.nextRefillDate, addDaysToYyyymmdd(today, 30));
    } finally { price.retail = 50; }
  });

  await check('[Z2] free refill whose setup fails with no one completing it: abandoned, cycle still due and re-orderable', async () => {
    const s = await subscription();
    price.retail = 0; direct.failNext = true;
    try { await assert.rejects(refills.createRefillOrder(s.id, pharmacy)); } finally { price.retail = 50; }
    const first = (await PharmacyOrderModel.findOne({ 'refill.subscriptionId': s.id }).lean())!;
    assert.equal(first.status, 'abandoned'); assert.equal((await subRow(s.id))!.nextRefillDate, today);
    const again = await refills.createRefillOrder(s.id, pharmacy);
    assert.equal(again.created, true); assert.notEqual(String(again.order._id), String(first._id));
  });

  await check('[R6] the pharmacy cannot "accept" an unpaid refill through the normal status update', async () => {
    const s = await subscription();
    const r = await refills.createRefillOrder(s.id, pharmacy);
    await rejects(orders.updateStatus(String(r.order._id), pharmacyA, { status: 'accepted' }), 'ORDER_PAYMENT_REQUIRED', 409);
    assert.equal((await PharmacyOrderModel.findById(r.order._id).lean())!.status, 'placed');
  });

  await check('HTTP: customer creates their refill and lists it; another customer cannot', async () => {
    Container.set(RefillOrderService, refills);
    const { default: router } = await import('@/modules/pharmacySubscriptions/routes');
    const { authenticate } = await import('@/modules/middleware/auth');
    const app = express(); app.use(express.json());
    app.use('/api/v1/pharmacy-subscriptions', authenticate, router);
    app.use((err: { status?: number; code?: string }, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
      res.status(err.status ?? 500).json({ success: false, code: err.code });
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const call = async (method: string, path: string, claims: { _id?: unknown; userType?: unknown }, body?: object) => fetch(`http://127.0.0.1:${port}/api/v1/pharmacy-subscriptions${path}`,
        { method, headers: { authorization: 'Bearer ' + await bearer(claims), 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined });
      const s = await subscription();
      const other = { _id: new Types.ObjectId().toHexString(), userType: 'user' };
      assert.equal((await call('POST', `/${s.id}/refill-order`, other, {})).status, 404);
      const res = await call('POST', `/${s.id}/refill-order`, { _id: s.customer, userType: 'user' }, { deliveryMode: 'pickup' });
      assert.equal(res.status, 201); assert.equal(res.headers.get('cache-control'), 'private, no-store');
      const body = await res.json() as { data: { order: { status: string; deliveryMode: string } } };
      assert.equal(body.data.order.status, 'placed'); assert.equal(body.data.order.deliveryMode, 'pickup');
      const existingRes = await call('POST', `/${s.id}/refill-order`, { _id: s.customer, userType: 'user' }, {}); // existing
      assert.equal(existingRes.status, 200);
      const ex = await existingRes.json() as { data: { payment?: { razorpayOrderId?: string; amount?: number }; paymentRequired: boolean } };
      assert.equal(ex.data.paymentRequired, true);
      assert.ok(ex.data.payment?.razorpayOrderId, 'checkout details returned for the existing unpaid refill');
      // a refill the PHARMACY created: the customer obtains its checkout through the same endpoint (no DB lookup)
      const s2 = await subscription();
      await refills.createRefillOrder(s2.id, pharmacy);
      const viaCustomer = await (await call('POST', `/${s2.id}/refill-order`, { _id: s2.customer, userType: 'user' }, {})).json() as
        { data: { order: { paymentTransactionId: string }; payment?: { paymentTransactionId: string; razorpayOrderId: string; amount: number } } };
      assert.equal(viaCustomer.data.payment?.paymentTransactionId, String(viaCustomer.data.order.paymentTransactionId));
      assert.equal(viaCustomer.data.payment?.amount, 150);
      const mine = await (await call('GET', '/mine', { _id: s.customer, userType: 'user' })).json() as { data: { pendingRefill?: { orderId?: string } }[] };
      assert.equal(mine.data.length, 1); assert.ok(mine.data[0].pendingRefill?.orderId);
      assert.equal((await call('GET', '/mine', { _id: pharmacyA, pharmacyId: pharmacyA, userType: 'pharmacy' })).status, 403);

      // [G1] original creation stalls in its gateway order; the customer recovers it over HTTP; the original then finishes.
      const g = await subscription();
      let release!: () => void; gw.gate = new Promise(r => { release = r; });
      const original = refills.createRefillOrder(g.id, pharmacy);
      while (!gw.waiting) await new Promise(r => setTimeout(r, 10));
      const resumed = await (await call('POST', `/${g.id}/refill-order`, { _id: g.customer, userType: 'user' }, {})).json() as
        { data: { payment?: { paymentTransactionId: string } } };
      const b = resumed.data.payment!.paymentTransactionId;
      release();
      const orig = await original as { payment?: { paymentTransactionId: string } };
      assert.equal(orig.payment?.paymentTransactionId, b, 'the original returns the canonical linked checkout, not its own');
      const gOrder = (await PharmacyOrderModel.findOne({ 'refill.subscriptionId': g.id }).lean())!;
      assert.equal(String(gOrder.paymentTransactionId), b, 'link was not overwritten');
      const records = await PaymentRecordModel.find({ context: 'pharmacy_order', contextId: String(gOrder._id) }).lean();
      assert.equal(records.length, 2, 'two gateway orders were created...');
      const exposed = new Set([b, orig.payment!.paymentTransactionId]);
      assert.equal(exposed.size, 1, '...but only ONE was ever returned to a caller');

      // [G2] original gateway setup FAILS after a resume linked a valid checkout: the order is not abandoned.
      const h = await subscription();
      let release2!: () => void; gw.gate = new Promise(r => { release2 = r; }); gw.failAfterGate = true;
      const original2 = refills.createRefillOrder(h.id, pharmacy);
      while (!gw.waiting) await new Promise(r => setTimeout(r, 10));
      await call('POST', `/${h.id}/refill-order`, { _id: h.customer, userType: 'user' }, {});
      const releasedBefore = stock.released;
      release2();
      await assert.rejects(original2);
      const hOrder = (await PharmacyOrderModel.findOne({ 'refill.subscriptionId': h.id }).lean())!;
      assert.equal(hOrder.status, 'placed'); assert.ok(hOrder.paymentTransactionId);
      assert.equal(stock.released, releasedBefore, 'no stock returned: the resumed checkout is still valid');
    } finally { server.close(); }
  });

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
