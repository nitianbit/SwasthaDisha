/**
 * D3: cancellation of pharmacy orders on a real MongoDB replica set. Real PharmacyOrderService (request / approve /
 * reject, generic status update, markPaid, update), real P2 refund service (wallet credit; fake Razorpay gateway), real
 * PaymentService.processPharmacyOrderPayment (payment core transaction, late-payment refund). Inventory is a recorder.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/d3_cancel_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/pharmacy-cancel/d3-pending-cancel.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import '@/modules/user/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacyOrderService, type CancelActor } from '@/modules/pharmacyOrders/services';
import { PrescriptionRefundService } from '@/modules/pharmacyOrders/prescriptionRefund';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import PharmacySubscriptionModel from '@/modules/pharmacySubscriptions/model';
import MedicineModel from '@/modules/pharmacyMedicines/model';
import { MedicineRepository } from '@/modules/pharmacyMedicines/repository';
import { orderQuerySchema, updateOrderStatusSchema } from '@/modules/pharmacyOrders/validation';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/d3_cancel_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const released = new Map<string, number>();
const inventory = {
  returnStockBulk: async (_p: string, items: { medicineId: string; quantity: number }[], session: unknown) => {
    assert.ok(session, 'stock release runs inside the order transaction');
    for (const i of items) released.set(i.medicineId, (released.get(i.medicineId) ?? 0) + i.quantity);
    return [];
  },
  releaseOrderStockBulk: async () => undefined,
  consumeOrderReservedStockBulk: async () => undefined,
};
const gateway = { listRefunds: async () => [], fetchRefund: async () => { throw new Error('x'); }, refund: async () => { throw new Error('x'); } };
const refunds = new PrescriptionRefundService(gateway as never, new WalletRepository());
const sideEffects = { queueNotification: async () => undefined, queueSubscriptionSync: async () => undefined };
const makeOrders = (repo: PharmacyOrderRepository) => new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
  repo, { ensureLinked: async () => undefined }, inventory, {}, {}, {}, sideEffects, {}, refunds);
const orders = makeOrders(new PharmacyOrderRepository());

let beforeCommit: (() => Promise<void>) | undefined;
const payments = Object.assign(Object.create(PaymentService.prototype), {
  pharmacyOrderRepository: new PharmacyOrderRepository(), paymentRepository: new PaymentRepository(), inventoryService: inventory,
  pharmacyOrderSideEffectService: sideEffects, couponService: {}, incrementCouponUsageAfterProcessing: async () => undefined,
  walletRepository: new WalletRepository(), walletTransactionRepository: new WalletTransactionRepository(),
}) as Record<string, (...a: unknown[]) => Promise<unknown>>;
// Lets a test change the order after the payment handler's last read and before its commit transaction.
const coreTx = (PaymentService.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).runPharmacyPaymentCoreTransaction!;
payments.runPharmacyPaymentCoreTransaction = async (work: unknown) => {
  if (beforeCommit) { const h = beforeCommit; beforeCommit = undefined; await h(); }
  return coreTx.call(payments, work);
};

const pharmacyA = new Types.ObjectId().toHexString();
const pharmacyB = new Types.ObjectId().toHexString();
const admin: CancelActor = { userType: 'admin', _id: new Types.ObjectId().toHexString() };
const pharmacy: CancelActor = { userType: 'pharmacy', _id: pharmacyA, pharmacyId: pharmacyA };
const otherPharmacy: CancelActor = { userType: 'pharmacy', _id: pharmacyB, pharmacyId: pharmacyB };

/** An order of 2 units. `record`: a paid (processed) payment record, a captured-but-unprocessed one, or none. */
async function order(opts: { status?: string; paymentMode?: string; paymentStatus?: string; record?: 'paid' | 'unprocessed' | 'none' } = {}) {
  const customer = new Types.ObjectId().toHexString();
  const med = new Types.ObjectId();
  const o = await PharmacyOrderModel.create({ pharmacyId: pharmacyA, orderType: 'online', status: opts.status ?? 'accepted', customerId: customer,
    createdById: customer, createdByRole: 'user', paymentMode: opts.paymentMode ?? 'online_payment', paymentStatus: opts.paymentStatus ?? 'paid',
    deliveryMode: 'delivery', deliveryAddress: '12 MG Road',
    items: [{ medicineId: med, medicineName: 'Vitamin D', orderedQty: 2, unitPrice: 50, lineTotal: 100, prescriptionRequired: false, itemStatus: 'active' }] });
  const id = String(o._id);
  let recordId: string | undefined;
  const record = opts.record ?? ((opts.paymentStatus ?? 'paid') === 'paid' && (opts.paymentMode ?? 'online_payment') === 'online_payment' ? 'paid' : 'none');
  if (record !== 'none') {
    const rec = await PaymentRecordModel.create({ userId: customer, payerUserId: customer, context: 'pharmacy_order', contextId: id, baseAmount: 100,
      discountAmount: 0, finalAmount: 100, finalAmountPaise: 10_000, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_' + id,
      razorpayPaymentId: 'pay_' + id.slice(-10), status: 'paid', isProcessed: record === 'paid' });
    recordId = String(rec._id);
    if (record === 'paid') await PharmacyOrderModel.updateOne({ _id: id }, { $set: { paymentTransactionId: recordId } });
  }
  await WalletModel.create({ userId: customer, balance: 0, isActive: true });
  return { id, customer, med: String(med), recordId, user: { userType: 'user', _id: customer } as CancelActor };
}
const get = async (id: string) => (await PharmacyOrderModel.findById(id).lean())!;
const balance = async (u: string) => Number((await WalletModel.findOne({ userId: u }).lean())?.balance);
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: { code?: string }) => { assert.equal(e.code, code); return true; });
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(url);
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await Promise.all([PharmacyOrderModel.init(), PaymentRecordModel.init(), WalletModel.init(), WalletTransactionModel.init()]);

  await check('an unpaid order is cancelled at once by its customer, stock released exactly once', async () => {
    const o = await order({ status: 'placed', paymentStatus: 'pending', record: 'none' });
    const r = await orders.requestCancel(o.id, o.user, { reason: 'Ordered by mistake' });
    assert.equal(r.status, 'cancelled');
    assert.equal(r.cancelRequest?.state, 'approved'); assert.equal(r.cancelRequest?.fromStatus, 'placed');
    assert.equal(released.get(o.med), 2);
    await rejects(orders.requestCancel(o.id, o.user), 'INVALID_ORDER_STATUS_TRANSITION');
    assert.equal(released.get(o.med), 2);
  });

  await check('a paid order waits in pending_cancel; every progress path is refused while it is frozen', async () => {
    const o = await order();
    const r = await orders.requestCancel(o.id, o.user, { reason: 'Not needed' });
    assert.equal(r.status, 'pending_cancel');
    assert.equal(r.cancelRequest?.state, 'pending'); assert.equal(r.cancelRequest?.fromStatus, 'accepted');
    assert.equal(r.cancelRequest?.paymentStatusAtRequest, 'paid'); assert.match(r.cancelRequest!.requestId, /^[0-9a-f]{24}$/);
    assert.equal(released.get(o.med), undefined, 'nothing released yet');
    await rejects(orders.updateStatus(o.id, pharmacyA, { status: 'packed' }), 'INVALID_ORDER_STATUS_TRANSITION');
    await rejects(orders.updateStatus(o.id, pharmacyA, { status: 'cancelled' }), 'INVALID_ORDER_STATUS_TRANSITION');
    await rejects(orders.update(o.id, pharmacyA, { notes: 'x' } as never), 'ORDER_CANCEL_PENDING');
    await rejects(orders.requestCancel(o.id, pharmacy), 'CANCEL_ALREADY_REQUESTED');
    const cod = await order({ paymentMode: 'cash_on_delivery', paymentStatus: 'authorized', record: 'none' });
    await orders.requestCancel(cod.id, pharmacy);
    await rejects(orders.markPaid(cod.id, { userType: 'pharmacy', pharmacyId: pharmacyA, userId: pharmacyA, data: { paymentMethod: 'cash' } as never }),
      'ORDER_CANCEL_PENDING');
  });

  await check('the generic cancel never closes a paid order (it would not refund it)', async () => {
    const o = await order();
    await rejects(orders.updateStatus(o.id, pharmacyA, { status: 'cancelled' }), 'ORDER_PAID_USE_CANCEL_REQUEST');
    assert.equal((await get(o.id)).status, 'accepted');
  });

  await check('approval: cancelled, stock released once, wallet refunded once; a concurrent second approval loses', async () => {
    const o = await order();
    const r = await orders.requestCancel(o.id, o.user);
    const requestId = r.cancelRequest!.requestId;
    const results = await Promise.allSettled([
      orders.approveCancel(o.id, pharmacy, { requestId, note: 'ok' }),
      orders.approveCancel(o.id, admin, { requestId }),
    ]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    const lost = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    assert.equal((lost.reason as { code?: string }).code, 'CANCEL_REQUEST_CHANGED');
    const done = await get(o.id);
    assert.equal(done.status, 'cancelled'); assert.equal(done.cancelRequest?.state, 'approved');
    assert.equal(released.get(o.med), 2);
    assert.equal(done.prescriptionRefund?.cause, 'order_cancelled'); assert.equal(done.prescriptionRefund?.status, 'wallet_credited');
    assert.equal(await balance(o.customer), 100);
  });

  await check('who may request and decide: the customer requests but never decides; another pharmacy or customer is refused', async () => {
    const o = await order();
    const stranger = await order();
    await rejects(orders.requestCancel(o.id, stranger.user), 'FORBIDDEN');
    await rejects(orders.requestCancel(o.id, otherPharmacy), 'FORBIDDEN');
    const r = await orders.requestCancel(o.id, pharmacy); // the same pharmacy account may request and approve (owner policy)
    await rejects(orders.approveCancel(o.id, o.user, { requestId: r.cancelRequest!.requestId }), 'FORBIDDEN');
    await rejects(orders.approveCancel(o.id, otherPharmacy, { requestId: r.cancelRequest!.requestId }), 'FORBIDDEN');
    await orders.approveCancel(o.id, pharmacy, { requestId: r.cancelRequest!.requestId });
    assert.equal((await get(o.id)).status, 'cancelled');
  });

  await check('a delayed decision for an earlier request cannot decide a later one', async () => {
    const o = await order();
    const r1 = await orders.requestCancel(o.id, o.user);
    const back = await orders.rejectCancel(o.id, pharmacy, { requestId: r1.cancelRequest!.requestId, note: 'Already packed' });
    assert.equal(back.status, 'accepted'); assert.equal(back.cancelRequest?.state, 'rejected');
    await orders.updateStatus(o.id, pharmacyA, { status: 'packed' });
    const r2 = await orders.requestCancel(o.id, o.user);
    assert.equal(r2.cancelRequest?.fromStatus, 'packed');
    await rejects(orders.approveCancel(o.id, admin, { requestId: r1.cancelRequest!.requestId }), 'CANCEL_REQUEST_CHANGED');
    await rejects(orders.rejectCancel(o.id, admin, { requestId: r1.cancelRequest!.requestId }), 'CANCEL_REQUEST_CHANGED');
    const now = await get(o.id);
    assert.equal(now.status, 'pending_cancel'); assert.equal(now.cancelRequest?.requestId, r2.cancelRequest!.requestId);
    const rejected = await orders.rejectCancel(o.id, admin, { requestId: r2.cancelRequest!.requestId });
    assert.equal(rejected.status, 'packed', 'restored to the status the request matched');
  });

  await check('the request stores exactly what it matched: a concurrent progress or a COD payment is re-read', async () => {
    const repo = new PharmacyOrderRepository();
    const read = repo.findById.bind(repo);
    let after: (() => Promise<void>) | undefined;
    (repo as unknown as { findById: typeof read }).findById = async (...a: Parameters<typeof read>) => {
      const r = await read(...a);
      if (after) { const h = after; after = undefined; await h(); }
      return r;
    };
    const svc = makeOrders(repo);
    const o = await order();
    after = async () => { await PharmacyOrderModel.updateOne({ _id: o.id }, { $set: { status: 'packed' } }); };
    const r = await svc.requestCancel(o.id, o.user);
    assert.equal(r.status, 'pending_cancel'); assert.equal(r.cancelRequest?.fromStatus, 'packed');
    const cod = await order({ paymentMode: 'cash_on_delivery', paymentStatus: 'pending', record: 'none' });
    after = async () => { await PharmacyOrderModel.updateOne({ _id: cod.id }, { $set: { paymentStatus: 'paid' } }); };
    const rc = await svc.requestCancel(cod.id, cod.user);
    assert.equal(rc.status, 'pending_cancel', 'became paid in between: it waits for a decision instead of a refund-less cancel');
    assert.equal(rc.cancelRequest?.paymentStatusAtRequest, 'paid');
    assert.equal(released.get(cod.med), undefined);
  });

  await check('a COD order paid in cash (no payment record): approval cancels and puts the refund into manual review', async () => {
    const o = await order({ paymentMode: 'cash_on_delivery', paymentStatus: 'paid', record: 'none' });
    const r = await orders.requestCancel(o.id, o.user);
    const done = await orders.approveCancel(o.id, pharmacy, { requestId: r.cancelRequest!.requestId });
    assert.equal(done.status, 'cancelled');
    assert.equal(done.prescriptionRefund?.status, 'manual_review');
    assert.equal(await balance(o.customer), 0, 'never promised as credited');
  });

  await check('a capture landing while frozen is recorded without moving the order; approve waits while it is authorized', async () => {
    const o = await order({ status: 'placed', paymentStatus: 'authorized', record: 'unprocessed' });
    const r = await orders.requestCancel(o.id, o.user);
    assert.equal(r.status, 'pending_cancel');
    await rejects(orders.approveCancel(o.id, admin, { requestId: r.cancelRequest!.requestId }), 'PAYMENT_IN_PROGRESS');
    await payments.processPharmacyOrderPayment!(await PaymentRecordModel.findById(o.recordId).lean());
    const frozen = await get(o.id);
    assert.equal(frozen.status, 'pending_cancel'); assert.equal(frozen.paymentStatus, 'paid');
    assert.equal((await PaymentRecordModel.findById(o.recordId).lean())!.isProcessed, true);
    // Rejected: a placed order that is now paid resumes as accepted (decided from the fresh read).
    const back = await orders.rejectCancel(o.id, pharmacy, { requestId: r.cancelRequest!.requestId });
    assert.equal(back.status, 'accepted'); assert.equal(back.cancelRequest?.restoredStatus, 'accepted');
  });

  await check('a payment commit that loses to an unpaid cancel is routed to a wallet refund, not a 500', async () => {
    const o = await order({ status: 'accepted', paymentStatus: 'pending', record: 'unprocessed' });
    beforeCommit = async () => { await orders.requestCancel(o.id, o.user); }; // unpaid → cancelled after the handler's last read
    await payments.processPharmacyOrderPayment!(await PaymentRecordModel.findById(o.recordId).lean());
    const done = await get(o.id);
    assert.equal(done.status, 'cancelled', 'the cancellation stands (not revived, not overwritten to abandoned)');
    assert.equal(done.paymentStatus, 'refunded');
    const rec = (await PaymentRecordModel.findById(o.recordId).lean())!;
    assert.equal(rec.isProcessed, true); assert.equal(rec.status, 'refunded');
    assert.equal(await balance(o.customer), 100);
    assert.equal(released.get(o.med), 2, 'stock released once, by the cancellation');
    // Processing the same capture again changes nothing.
    await payments.processPharmacyOrderPayment!(await PaymentRecordModel.findById(o.recordId).lean());
    assert.equal(await balance(o.customer), 100);
  });

  await check('a late capture on a paid (or frozen) order is refunded without touching that order', async () => {
    const o = await order(); // paid through its own record
    const r = await orders.requestCancel(o.id, o.user);
    const extra = await PaymentRecordModel.create({ userId: o.customer, payerUserId: o.customer, context: 'pharmacy_order', contextId: o.id,
      baseAmount: 100, discountAmount: 0, finalAmount: 100, finalAmountPaise: 10_000, currency: 'INR', paymentGateway: 'razorpay',
      razorpayOrderId: 'ord_x_' + o.id, razorpayPaymentId: 'pay_x_' + o.id.slice(-8), status: 'paid', isProcessed: false });
    await payments.processPharmacyOrderPayment!(extra.toObject());
    const now = await get(o.id);
    assert.equal(now.status, 'pending_cancel'); assert.equal(now.paymentStatus, 'paid', 'not marked refunded');
    assert.equal(now.cancelRequest?.requestId, r.cancelRequest!.requestId);
    assert.equal(await balance(o.customer), 100, 'the duplicate capture went back to the wallet');
  });

  await check('the payment recovery sweep includes pharmacy order captures', async () => {
    const o = await order({ status: 'accepted', paymentStatus: 'pending', record: 'unprocessed' });
    await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(o.recordId) }, { $set: { createdAt: new Date(Date.now() - 60 * 60_000) } });
    const seen: string[] = [];
    const sweeper = Object.assign(Object.create(payments), {
      reconcilePaymentAndProcess: async ({ paymentTransactionId }: { paymentTransactionId: string }) => {
        seen.push(paymentTransactionId);
        await payments.processPharmacyOrderPayment!(await PaymentRecordModel.findById(paymentTransactionId).lean());
        return { state: 'paid' };
      },
    });
    await sweeper.sweepUnsettledBookingPayments(new Date());
    assert.ok(seen.includes(o.recordId!));
    assert.equal((await get(o.id)).paymentStatus, 'paid');
  });

  await check('two workers processing the SAME payment: one applies it, the other succeeds idempotently (no refund)', async () => {
    const o = await order({ status: 'accepted', paymentStatus: 'pending', record: 'unprocessed' });
    const rec = await PaymentRecordModel.findById(o.recordId).lean();
    await Promise.all([payments.processPharmacyOrderPayment!(rec), payments.processPharmacyOrderPayment!(rec)]);
    const now = await get(o.id);
    assert.equal(now.status, 'accepted'); assert.equal(now.paymentStatus, 'paid'); assert.equal(String(now.paymentTransactionId), o.recordId);
    const r = (await PaymentRecordModel.findById(o.recordId).lean())!;
    assert.equal(r.status, 'paid'); assert.equal(r.isProcessed, true);
    assert.equal(await balance(o.customer), 0, 'the applied payment was not returned');
    await payments.processPharmacyOrderPayment!(await PaymentRecordModel.findById(o.recordId).lean()); // a later reconcile/sweep
    assert.equal(await balance(o.customer), 0); assert.equal((await get(o.id)).paymentStatus, 'paid');
  });

  await check('a request checked against one customer cannot cancel the order after it was reassigned', async () => {
    const repo = new PharmacyOrderRepository();
    const read = repo.findById.bind(repo);
    let after: (() => Promise<void>) | undefined;
    (repo as unknown as { findById: typeof read }).findById = async (...a: Parameters<typeof read>) => {
      const r = await read(...a);
      if (after) { const h = after; after = undefined; await h(); }
      return r;
    };
    const svc = makeOrders(repo);
    const o = await order({ status: 'placed', paymentStatus: 'pending', record: 'none' });
    const other = new Types.ObjectId();
    after = async () => { await PharmacyOrderModel.updateOne({ _id: o.id }, { $set: { customerId: other } }); };
    await rejects(svc.requestCancel(o.id, o.user), 'FORBIDDEN');
    const now = await get(o.id);
    assert.equal(now.status, 'placed'); assert.equal(String(now.customerId), String(other));
    assert.equal(released.get(o.med), undefined);
  });

  await check('a paid refill frozen by a request: recovery does not advance the cycle; rejection does, approval never', async () => {
    const mk = async () => {
      const o = await order({ status: 'accepted' });
      const subId = new Types.ObjectId();
      await PharmacySubscriptionModel.collection.insertOne({ _id: subId, pharmacyId: pharmacyA, userId: o.customer, medicineId: new Types.ObjectId(o.med),
        intervalDays: 30, nextRefillDate: '20261114', isActive: true, pendingRefill: { orderId: o.id, cycleDate: '20261114' } } as never);
      await PharmacyOrderModel.updateOne({ _id: o.id }, { $set: { refill: { subscriptionId: String(subId), cycleDate: '20261114' } } });
      const r = await orders.requestCancel(o.id, o.user);
      return { ...o, subId, requestId: r.cancelRequest!.requestId };
    };
    const sub = async (id: Types.ObjectId) => (await PharmacySubscriptionModel.collection.findOne({ _id: id }))!;
    const a = await mk();
    await orders.resumeRefillOrder(a.id);
    assert.equal((await sub(a.subId)).nextRefillDate, '20261114', 'frozen: cursor unchanged');
    assert.ok((await sub(a.subId)).pendingRefill);
    await orders.rejectCancel(a.id, pharmacy, { requestId: a.requestId });
    assert.equal((await sub(a.subId)).nextRefillDate, '20261214', 'resumed: the cycle moves on');
    const b = await mk();
    await orders.approveCancel(b.id, pharmacy, { requestId: b.requestId });
    await orders.resumeRefillOrder(b.id);
    assert.equal((await sub(b.subId)).nextRefillDate, '20261114', 'cancelled and refunded: never advanced');
  });

  await check('a free (zero-total) order is accepted and linked once at creation', async () => {
    const med = (await MedicineModel.collection.insertOne({ name: 'Free sample', isActive: true, prescriptionRequired: false, gstPercent: 0 } as never)).insertedId;
    const freeInventory = { ...inventory, getInventoryByMedicine: async () => ({ retailPrice: 0, wholesalePrice: 0 }), reserveOrderStockBulk: async () => new Map() };
    const direct = { createDirectPaidTransaction: async (d: { userId: string; context: string; contextId: string; baseAmount: number; discountAmount: number; notes: object }) =>
      (await PaymentRecordModel.create({ userId: d.userId, context: d.context, contextId: d.contextId, baseAmount: d.baseAmount,
        discountAmount: d.discountAmount, finalAmount: 0, currency: 'INR', paymentGateway: 'internal', status: 'paid', notes: d.notes })).toObject() };
    const svc = new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
      new PharmacyOrderRepository(), { ensureLinked: async () => undefined }, freeInventory, direct, {}, {}, sideEffects, new MedicineRepository(), refunds);
    const customer = new Types.ObjectId().toHexString();
    const created = await svc.create(pharmacyA, { orderType: 'online', customerId: customer, paymentMode: 'online_payment', deliveryMode: 'pickup',
      items: [{ medicineId: String(med), orderedQty: 1 }] } as never, pharmacyA, 'pharmacy');
    const createdId = String((created as unknown as { order: { _id: unknown } }).order._id);
    const row = await get(createdId);
    assert.equal(row.status, 'accepted'); assert.equal(row.paymentStatus, 'paid');
    const rec = await PaymentRecordModel.findOne({ context: 'pharmacy_order', contextId: createdId }).lean();
    assert.equal(String(row.paymentTransactionId), String(rec!._id), 'linked to its direct-paid record');
  });

  await check('the order list can select the pending_cancel worklist; the status command cannot enter it', async () => {
    assert.equal(orderQuerySchema.validate({ status: 'pending_cancel' }).error, undefined);
    assert.ok(updateOrderStatusSchema.validate({ status: 'pending_cancel' }).error, 'not settable through /status');
  });

  await mongoose.disconnect();
  console.log(`${passed} checks passed`);
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
