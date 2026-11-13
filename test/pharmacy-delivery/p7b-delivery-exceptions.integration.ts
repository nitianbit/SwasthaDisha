/**
 * P7b delivery/pickup exceptions against a real MongoDB replica set: the real PharmacyOrderService
 * (recordDeliveryException + updateStatus) and the real P2 refund service (wallet credit; fake Razorpay gateway).
 * Inventory is a recorder so stock release can be counted.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/p7b_delivery_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/pharmacy-delivery/p7b-delivery-exceptions.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import '@/modules/user/model';
import PharmacyModel from '@/modules/pharmacies/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import { PrescriptionRefundService } from '@/modules/pharmacyOrders/prescriptionRefund';
import PaymentRecordModel from '@/modules/payment/model';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository } from '@/modules/wallet/repository';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/p7b_delivery_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const stock = { released: 0, consumed: 0 };
const inventory = {
  returnStockBulk: async (_p: string, items: { quantity: number }[], session: unknown) => {
    assert.ok(session, 'stock release runs inside the order transaction'); stock.released += items.reduce((a, i) => a + i.quantity, 0); return [];
  },
  releaseOrderStockBulk: async () => undefined,
  consumeOrderReservedStockBulk: async () => { stock.consumed++; },
};
const gateway = { listRefunds: async () => [], fetchRefund: async () => { throw new Error('x'); }, refund: async () => { throw new Error('x'); } };
const refunds = new PrescriptionRefundService(gateway as never, new WalletRepository());
const sideEffects = { queueNotification: async () => undefined, queueSubscriptionSync: async () => undefined };
const orders = new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
  new PharmacyOrderRepository(), {}, inventory, {}, {}, {}, sideEffects, {}, refunds);

const pharmacyA = new Types.ObjectId().toHexString();
const pharmacyB = new Types.ObjectId().toHexString();

/** An order out for delivery (2 units). Paid online with a payment record, or cash on delivery (unpaid). */
async function order(opts: { status?: string; paid?: boolean } = {}) {
  const customer = new Types.ObjectId().toHexString();
  const paid = opts.paid ?? true;
  const o = await PharmacyOrderModel.create({ pharmacyId: pharmacyA, orderType: 'online', status: opts.status ?? 'out_for_delivery', customerId: customer,
    createdById: customer, createdByRole: 'user', paymentMode: paid ? 'online_payment' : 'cash_on_delivery', paymentStatus: paid ? 'paid' : 'pending',
    deliveryMode: 'delivery', deliveryAddress: '12 MG Road',
    items: [{ medicineId: new Types.ObjectId(), medicineName: 'Vitamin D', orderedQty: 2, unitPrice: 50, lineTotal: 100, prescriptionRequired: false, itemStatus: 'active' }] });
  const id = String(o._id);
  if (paid) {
    const rec = await PaymentRecordModel.create({ userId: customer, payerUserId: customer, context: 'pharmacy_order', contextId: id, baseAmount: 100,
      discountAmount: 0, finalAmount: 100, finalAmountPaise: 10_000, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_' + id,
      razorpayPaymentId: 'pay_' + id.slice(-10), status: 'paid', isProcessed: true });
    await PharmacyOrderModel.updateOne({ _id: id }, { $set: { paymentTransactionId: String(rec._id) } });
  }
  await WalletModel.create({ userId: customer, balance: 0, isActive: true });
  return { id, customer };
}
const ex = (id: string, type: string, reason?: string, pharmacyId = pharmacyA) =>
  orders.recordDeliveryException(id, pharmacyId, { type: type as never, ...(reason ? { reason } : {}) });
const get = (id: string) => PharmacyOrderModel.findById(id).lean();
const balance = async (u: string) => Number((await WalletModel.findOne({ userId: u }).lean())?.balance);
async function ledgerMatches(u: string) {
  const sum = (await WalletTransactionModel.find({ userId: u }).lean()).reduce((a, t) => a + (t.transactionType === 'debit' ? -t.amount : t.amount), 0);
  assert.equal(Math.round(sum * 100), Math.round((await balance(u)) * 100));
}
async function rejects(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: { code?: string; status?: number }) => e.code === code && (status === undefined || e.status === status));
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(url);
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await Promise.all([PharmacyOrderModel.init(), PaymentRecordModel.init(), WalletModel.init(), WalletTransactionModel.init()]);

  await check('failed delivery -> retry -> delivered; each step recorded with its reason', async () => {
    const o = await order();
    await ex(o.id, 'delivery_failed', 'Customer not at home');
    assert.equal((await get(o.id))!.status, 'delivery_failed');
    await ex(o.id, 'retry_delivery');
    assert.equal((await get(o.id))!.status, 'out_for_delivery');
    await orders.updateStatus(o.id, pharmacyA, { status: 'completed' });
    const done = (await get(o.id))!;
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.deliveryExceptions!.map(e => [e.type, e.fromStatus, e.toStatus]),
      [['delivery_failed', 'out_for_delivery', 'delivery_failed'], ['retry_delivery', 'delivery_failed', 'out_for_delivery']]);
    assert.equal(done.deliveryExceptions![0].reason, 'Customer not at home');
  });

  await check('switch to pickup after a failed delivery; collected at the store', async () => {
    const o = await order();
    await ex(o.id, 'delivery_failed', 'Address not found');
    await ex(o.id, 'switch_to_pickup', 'Customer will collect');
    const r = (await get(o.id))!;
    assert.equal(r.status, 'ready_for_pickup'); assert.equal(r.deliveryMode, 'pickup');
    await orders.updateStatus(o.id, pharmacyA, { status: 'completed' });
    assert.equal((await get(o.id))!.status, 'completed');
  });

  await check('paid order not collected: cancelled, stock released once, full amount refunded to the wallet', async () => {
    const o = await order({ status: 'ready_for_pickup' });
    const before = stock.released;
    const out = await ex(o.id, 'not_collected', 'Not collected within 7 days');
    assert.equal(out.status, 'cancelled'); assert.equal(stock.released - before, 2);
    assert.equal(out.prescriptionRefund?.status, 'wallet_credited'); assert.equal(out.paymentStatus, 'refunded');
    assert.equal(await balance(o.customer), 100); await ledgerMatches(o.customer);
    assert.equal(out.deliveryExceptions![0].refundRequired, true);
    const entry = await WalletTransactionModel.findOne({ userId: o.customer, transactionType: 'refund' }).lean();
    assert.equal(entry!.description, 'Refund for pharmacy order not collected', 'wallet history states the real reason');
  });

  await check('cash-on-delivery order refused at the door: cancelled, stock released, nothing refunded', async () => {
    const o = await order({ paid: false });
    const before = stock.released;
    const out = await ex(o.id, 'refused_at_door', 'Customer refused the parcel');
    assert.equal(out.status, 'cancelled'); assert.equal(stock.released - before, 2);
    assert.equal(out.prescriptionRefund, undefined); assert.equal(await balance(o.customer), 0);
  });

  await check('paid order refused at the door after a failed attempt: refunded once', async () => {
    const o = await order();
    await ex(o.id, 'delivery_failed', 'Gate closed');
    await ex(o.id, 'refused_at_door', 'Refused on second attempt');
    assert.equal(await balance(o.customer), 100); await ledgerMatches(o.customer);
    assert.equal((await WalletTransactionModel.findOne({ userId: o.customer, transactionType: 'refund' }).lean())!.description,
      'Refund for pharmacy order refused at delivery');
  });

  await check('rules: wrong state, missing reason, other pharmacy, generic status update cannot reach delivery_failed', async () => {
    const o = await order();
    await rejects(ex(o.id, 'not_collected', 'x reason'), 'INVALID_ORDER_STATUS_TRANSITION', 409);
    await rejects(ex(o.id, 'retry_delivery'), 'INVALID_ORDER_STATUS_TRANSITION', 409);
    await rejects(ex(o.id, 'delivery_failed'), 'VALIDATION_ERROR', 400);
    await rejects(ex(o.id, 'delivery_failed', 'Not home', pharmacyB), 'FORBIDDEN', 403);
    await rejects(orders.updateStatus(o.id, pharmacyA, { status: 'delivery_failed' } as never), 'INVALID_ORDER_STATUS_TRANSITION', 409);
    const done = await order({ status: 'completed' });
    await rejects(ex(done.id, 'refused_at_door', 'late'), 'INVALID_ORDER_STATUS_TRANSITION', 409);
    assert.equal((await get(o.id))!.status, 'out_for_delivery');
  });

  await check('concurrent refused-at-door vs switch-to-pickup: exactly one wins; stock and money moved at most once', async () => {
    for (let round = 0; round < 4; round++) {
      const o = await order();
      const before = stock.released;
      const results = await Promise.allSettled([ex(o.id, 'refused_at_door', 'Refused'), ex(o.id, 'switch_to_pickup', 'Will collect')]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      const r = (await get(o.id))!;
      if (r.status === 'cancelled') { assert.equal(stock.released - before, 2); assert.equal(await balance(o.customer), 100); }
      else { assert.equal(r.status, 'ready_for_pickup'); assert.equal(stock.released - before, 0); assert.equal(await balance(o.customer), 0); }
      assert.equal(r.deliveryExceptions!.length, 1); await ledgerMatches(o.customer);
    }
  });

  await check('HTTP: exception endpoint through the real router, auth and validation', async () => {
    await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(pharmacyA), isActive: true, isVerified: true } as never);
    Container.set(PharmacyOrderService, orders);
    const { default: router } = await import('@/modules/pharmacyOrders/routes');
    const { authenticate } = await import('@/modules/middleware/auth');
    const app = express(); app.use(express.json());
    app.use('/api/v1/pharmacy-orders', authenticate, router);
    app.use((err: { status?: number; code?: string }, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
      res.status(err.status ?? 500).json({ success: false, code: err.code });
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const post = (path: string, claims: object, body: object) => fetch(`http://127.0.0.1:${port}/api/v1/pharmacy-orders${path}`,
        { method: 'POST', headers: { authorization: 'Bearer ' + jwt.sign(claims, CONFIG.JWT_SECRET_KEY), 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const pharmacy = { _id: pharmacyA, pharmacyId: pharmacyA, userType: 'pharmacy' };
      const o = await order();
      assert.equal((await post(`/${o.id}/delivery-exception`, pharmacy, { type: 'delivery_failed' })).status, 400); // reason required
      assert.equal((await post(`/${o.id}/delivery-exception`, pharmacy, { type: 'teleport', reason: 'x' })).status, 400);
      assert.equal((await post(`/${o.id}/delivery-exception`, { _id: o.customer, userType: 'user' }, { type: 'delivery_failed', reason: 'xyz' })).status, 403);
      const ok = await post(`/${o.id}/delivery-exception`, pharmacy, { type: 'delivery_failed', reason: 'Not home' });
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as { data: { status: string } }).data.status, 'delivery_failed');
    } finally { server.close(); }
  });

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
