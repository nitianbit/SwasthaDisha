/**
 * P3b recall + customer returns against a real MongoDB replica set: batch recall and its trace, swapping an order's
 * units off a held batch, cancelling with refund (real P2 refund service, fake gateway), and customer returns with a
 * staff-chosen wallet refund. Every scenario checks item availableQty == sum of batches and wallet balance == ledger.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/p3b_recall_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/pharmacy-inventory/p3b-recall-returns.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { ClientSession, Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import '@/modules/user/model';
import { addDaysToYyyymmdd, getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import PharmacyModel from '@/modules/pharmacies/model';
import { InventoryAdjustmentModel, InventoryItemModel } from '@/modules/pharmacyInventory/model';
import { InventoryItemRepository } from '@/modules/pharmacyInventory/repository';
import { BatchQualityService } from '@/modules/pharmacyInventory/batchQuality';
import { CustomerReturnService } from '@/modules/pharmacyInventory/customerReturns';
import { CustomerReturnModel } from '@/modules/pharmacyInventory/model/customerReturn';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import { PrescriptionRefundService } from '@/modules/pharmacyOrders/prescriptionRefund';
import PaymentRecordModel from '@/modules/payment/model';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository } from '@/modules/wallet/repository';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/p3b_recall_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const svc = new BatchQualityService();
const returns = new CustomerReturnService(new WalletRepository());
const repo = new InventoryItemRepository();
const inventory = {
  releaseOrderStockBulk: async (pid: string, items: { medicineId: string; batchAllocations: never[] }[], session: ClientSession) => {
    for (const it of items) assert.ok(await repo.releaseBatchAllocations(pid, it.medicineId, it.batchAllocations, session), 'release');
  },
  returnStockBulk: async () => [],
  consumeOrderReservedStockBulk: async () => undefined,
};
const gateway = { listRefunds: async () => [], fetchRefund: async () => { throw new Error('x'); }, refund: async () => { throw new Error('x'); } };
const refunds = new PrescriptionRefundService(gateway as never, new WalletRepository());
const sideEffects = { queueNotification: async () => undefined, queueSubscriptionSync: async () => undefined };
const orders = new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
  new PharmacyOrderRepository(), {}, inventory, {}, {}, {}, sideEffects, {}, refunds);

const pharmacyA = new Types.ObjectId().toHexString();
const pharmacyB = new Types.ObjectId().toHexString();
const staffA = { pharmacyId: pharmacyA, actorId: pharmacyA };
const today = getTodayYyyymmdd();
const exp = addDaysToYyyymmdd(today, 200);

/** B0 active (20 available + 5 reserved), B2 active later expiry (10 available), B3 depleted (all 4 sold). */
async function item() {
  const b0 = new Types.ObjectId(), b2 = new Types.ObjectId(), b3 = new Types.ObjectId(), medicineId = new Types.ObjectId();
  const { insertedId } = await InventoryItemModel.collection.insertOne({ pharmacyId: new Types.ObjectId(pharmacyA), medicineId,
    availableQty: 30, reservedQty: 5, freeQty: 0, reorderThreshold: 0, isActive: true, createdAt: new Date(), updatedAt: new Date(),
    batches: [
      { _id: b0, batchNumber: 'R-100', expiryDate: exp, receivedAt: new Date(), availableQty: 20, reservedQty: 5, freeQty: 0, status: 'active', purchasePrice: 4 },
      { _id: b2, batchNumber: 'R-200', expiryDate: addDaysToYyyymmdd(today, 300), receivedAt: new Date(), availableQty: 10, reservedQty: 0, freeQty: 0, status: 'active', purchasePrice: 4 },
      { _id: b3, batchNumber: 'R-300', expiryDate: exp, receivedAt: new Date(), availableQty: 0, reservedQty: 0, freeQty: 0, status: 'depleted', depletedAt: new Date() },
    ] } as never);
  return { id: insertedId.toHexString(), medicineId: medicineId.toHexString(), b0: b0.toHexString(), b2: b2.toHexString(), b3: b3.toHexString() };
}
type Item = Awaited<ReturnType<typeof item>>;
/** An order of this pharmacy for `alloc` units (10 rupees each), paid online with a payment record. */
async function order(i: Item, alloc: { batchId: string; batchNumber: string; quantity: number }[], status = 'packed', paid = true) {
  const customer = new Types.ObjectId().toHexString();
  const qty = alloc.reduce((n, a) => n + a.quantity, 0);
  const o = await PharmacyOrderModel.create({ pharmacyId: pharmacyA, orderType: 'online', status, customerId: customer, createdById: customer,
    createdByRole: 'user', paymentMode: 'online_payment', paymentStatus: paid ? 'paid' : 'pending', orderNumber: 'PO-' + customer.slice(-6),
    subtotal: qty * 10, grandTotal: qty * 10, grandTotalPaise: qty * 1000,
    items: [{ medicineId: i.medicineId, medicineName: 'Amoxicillin', orderedQty: qty, unitPrice: 10, lineTotal: qty * 10, lineTotalPaise: qty * 1000,
      itemStatus: 'active', batchAllocations: alloc.map(a => ({ ...a, expiryDate: exp })) }] });
  const id = String(o._id);
  if (paid) {
    const rec = await PaymentRecordModel.create({ userId: customer, payerUserId: customer, context: 'pharmacy_order', contextId: id, baseAmount: qty * 10,
      discountAmount: 0, finalAmount: qty * 10, finalAmountPaise: qty * 1000, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_' + id,
      razorpayPaymentId: 'pay_' + id.slice(-10), status: 'paid', isProcessed: true });
    await PharmacyOrderModel.updateOne({ _id: id }, { $set: { paymentTransactionId: String(rec._id) } });
  }
  await WalletModel.create({ userId: customer, balance: 0, isActive: true });
  return { id, customer };
}
const row = async (id: string) => (await InventoryItemModel.findById(id).lean())!;
const batch = async (id: string, b: string) => (await row(id)).batches!.find(x => String((x as { _id?: unknown })._id) === b)!;
async function consistent(id: string) {
  const r = await row(id);
  assert.equal(r.availableQty, r.batches!.reduce((a, b) => a + b.availableQty, 0), 'item availableQty == sum of batches');
  assert.equal(r.reservedQty, r.batches!.reduce((a, b) => a + b.reservedQty, 0), 'item reservedQty == sum of batches');
  assert.ok(r.batches!.every(b => b.availableQty >= 0 && b.reservedQty >= 0));
}
const balance = async (u: string) => Number((await WalletModel.findOne({ userId: u }).lean())?.balance);
async function ledgerMatches(u: string) {
  const sum = (await WalletTransactionModel.find({ userId: u }).lean()).reduce((a, t) => a + (t.transactionType === 'debit' ? -t.amount : t.amount), 0);
  assert.equal(Math.round(sum * 100), Math.round((await balance(u)) * 100), 'wallet balance == ledger');
}
async function rejects(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: { code?: string; status?: number }) => e.code === code && (status === undefined || e.status === status));
}
const key = () => 'rk_' + new Types.ObjectId().toHexString();

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(url);
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await Promise.all([InventoryItemModel.init(), InventoryAdjustmentModel.init(), CustomerReturnModel.init(), PharmacyOrderModel.init(),
    PaymentRecordModel.init(), WalletModel.init(), WalletTransactionModel.init()]);

  await check('recall: batch blocked for sale and never releasable; open order flagged (unchanged); customers it was dispensed to listed', async () => {
    const i = await item();
    const open = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 5 }], 'packed');
    const sold = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 3 }], 'completed');
    const out = await svc.recall(staffA, i.id, i.b0, { reason: 'CDSCO alert: dissolution failure', reference: 'CDSCO/2026/114' });
    assert.equal(out.batch!.status, 'recalled'); assert.equal(out.batch!.recallReference, 'CDSCO/2026/114');
    assert.deepEqual(out.impactedOrders.map(o => o.orderId), [open.id]);
    assert.equal((await PharmacyOrderModel.findById(open.id).lean())!.status, 'packed', 'nothing cancelled automatically');
    assert.deepEqual(out.dispensedTo.map(d => [d.orderId, d.customerId, d.quantity, d.returnedQty]), [[sold.id, sold.customer, 3, 0]]);
    await rejects(svc.release(staffA, i.id, i.b0, 0, 'try'), 'BATCH_NOT_QUARANTINED', 409);
    await rejects(svc.recall(staffA, i.id, i.b0, { reason: 'again' }), 'BATCH_ALREADY_RECALLED', 409);
    await rejects(svc.recall({ pharmacyId: pharmacyB, actorId: pharmacyB }, i.id, i.b2, { reason: 'not mine' }), 'BATCH_NOT_FOUND', 404);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const r = await repo.reserveBatches(pharmacyA, i.medicineId, 11, session);
        assert.equal(r, null, 'only B2 (10 units) is reservable');
      });
    } finally { await session.endSession(); }
    await consistent(i.id);
  });

  await check('recall a quarantined batch (new hold) and a fully sold (depleted) batch; trace still finds the customers', async () => {
    const i = await item();
    await svc.quarantine(staffA, i.id, i.b2, 'Pending lab test');
    const before = (await batch(i.id, i.b2)).holdId;
    await svc.recall(staffA, i.id, i.b2, { reason: 'Lab test failed' });
    const b2 = await batch(i.id, i.b2);
    assert.equal(b2.status, 'recalled'); assert.notEqual(b2.holdId, before); assert.equal(b2.holdReason, 'Lab test failed');
    const sold = await order(i, [{ batchId: i.b3, batchNumber: 'R-300', quantity: 4 }], 'completed');
    const out = await svc.recall(staffA, i.id, i.b3, { reason: 'Manufacturer recall' });
    assert.equal(out.batch!.status, 'recalled');
    assert.deepEqual(out.dispensedTo.map(d => [d.orderId, d.quantity]), [[sold.id, 4]]);
    await consistent(i.id);
  });

  await check('swap: open order moved off the recalled batch onto a sellable batch in one transaction; recalled units stay held', async () => {
    const i = await item();
    const o = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 5 }], 'accepted');
    await svc.recall(staffA, i.id, i.b0, { reason: 'Recall' });
    const out = await svc.reallocateHeldUnits(staffA, o.id);
    assert.deepEqual(out.moves, [{ medicineId: i.medicineId, quantity: 5, from: [{ batchId: i.b0, quantity: 5 }], to: [{ batchId: i.b2, quantity: 5 }] }]);
    const b0 = await batch(i.id, i.b0), b2 = await batch(i.id, i.b2);
    assert.equal(b0.status, 'recalled'); assert.equal(b0.reservedQty, 0); assert.equal(b0.availableQty, 25);
    assert.equal(b2.reservedQty, 5); assert.equal(b2.availableQty, 5);
    const saved = (await PharmacyOrderModel.findById(o.id).lean())!;
    assert.deepEqual(saved.items[0].batchAllocations!.map(a => [String(a.batchId), a.quantity]), [[i.b2, 5]]);
    assert.equal(saved.batchReallocations!.length, 1); assert.equal(saved.status, 'accepted');
    assert.equal((await svc.impactedOrders(staffA, [i.b0])).length, 0, 'off the worklist');
    await rejects(svc.reallocateHeldUnits(staffA, o.id), 'NOTHING_TO_REALLOCATE', 409);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        assert.ok(await repo.consumeBatchAllocations(pharmacyA, i.medicineId, saved.items[0].batchAllocations as never, session), 'order can now complete');
      });
    } finally { await session.endSession(); }
    await consistent(i.id);
  });

  await check('swap without enough sellable stock fails as a whole (nothing moves); other pharmacy and wrong status refused', async () => {
    const i = await item();
    const o = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 5 }], 'packed');
    await svc.recall(staffA, i.id, i.b0, { reason: 'Recall' });
    await svc.quarantine(staffA, i.id, i.b2, 'Also suspect');
    const snapshot = JSON.stringify((await row(i.id)).batches);
    await rejects(svc.reallocateHeldUnits(staffA, o.id), 'INSUFFICIENT_SELLABLE_STOCK', 409);
    assert.equal(JSON.stringify((await row(i.id)).batches), snapshot, 'rolled back');
    await rejects(svc.reallocateHeldUnits({ pharmacyId: pharmacyB, actorId: pharmacyB }, o.id), 'ORDER_NOT_FOUND', 404);
    await PharmacyOrderModel.updateOne({ _id: o.id }, { $set: { status: 'out_for_delivery' } });
    await rejects(svc.reallocateHeldUnits(staffA, o.id), 'ORDER_NOT_REALLOCATABLE', 409);
    await consistent(i.id);
  });

  await check('cancel for stock hold: paid order cancelled, full refund to wallet, units back to the recalled batch as held stock', async () => {
    const i = await item();
    const o = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 5 }], 'ready_for_pickup');
    const clean = await order(i, [{ batchId: i.b2, batchNumber: 'R-200', quantity: 1 }], 'packed');
    await InventoryItemModel.updateOne({ _id: i.id, 'batches._id': new Types.ObjectId(i.b2) }, { $inc: { availableQty: -1, reservedQty: 1, 'batches.$.availableQty': -1, 'batches.$.reservedQty': 1 } });
    await svc.recall(staffA, i.id, i.b0, { reason: 'Recall' });
    await rejects(orders.cancelForStockHold(clean.id, pharmacyA, { reason: 'Not held' }), 'NO_HELD_STOCK', 409);
    await rejects(orders.cancelForStockHold(o.id, pharmacyB, { reason: 'Not mine' }), 'FORBIDDEN', 403);
    const done = await orders.cancelForStockHold(o.id, pharmacyA, { reason: 'Recalled batch; no replacement stock' });
    assert.equal(done.status, 'cancelled'); assert.equal(done.stockHoldCancellation!.refundRequired, true);
    assert.equal(done.prescriptionRefund!.cause, 'stock_hold_cancelled'); assert.equal(done.prescriptionRefund!.status, 'wallet_credited');
    assert.equal(await balance(o.customer), 50); await ledgerMatches(o.customer);
    const b0 = await batch(i.id, i.b0);
    assert.equal(b0.status, 'recalled'); assert.equal(b0.reservedQty, 0); assert.equal(b0.availableQty, 25);
    await rejects(orders.cancelForStockHold(o.id, pharmacyA, { reason: 'again' }), 'INVALID_ORDER_STATUS_TRANSITION', 409);
    await consistent(i.id);
  });

  await check('[H1] an operation that read the order BEFORE a batch swap releases the CURRENT allocations, never another order\'s reservation', async () => {
    const i = await item();
    // Q = B0 holds 5 for A and 5 for B (bump B0 reservations to 10).
    await InventoryItemModel.updateOne({ _id: i.id, 'batches._id': new Types.ObjectId(i.b0) },
      { $inc: { availableQty: -5, reservedQty: 5, 'batches.$.availableQty': -5, 'batches.$.reservedQty': 5 } });
    const realRepo = new PharmacyOrderRepository();
    /** Order service whose pre-transaction read returns a snapshot taken earlier (a request that read, then paused). */
    const staleService = (snapshot: unknown) => new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
      Object.assign(Object.create(realRepo), { findById: async (id: string, session?: ClientSession) => session ? realRepo.findById(id, session) : snapshot }),
      {}, inventory, {}, {}, {}, sideEffects, {}, refunds);
    const a = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 5 }], 'accepted');
    const b = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 5 }], 'accepted');
    await svc.recall(staffA, i.id, i.b0, { reason: 'Recall' });
    const snapA = await PharmacyOrderModel.findById(a.id).lean();         // cancel request reads A (on Q) and pauses
    await svc.reallocateHeldUnits(staffA, a.id);                           // swap commits: A now on R = B2
    await staleService(snapA).updateStatus(a.id, pharmacyA, { status: 'cancelled' });
    const q = await batch(i.id, i.b0), r = await batch(i.id, i.b2);
    assert.equal(q.reservedQty, 5, "B's reservation on Q untouched"); assert.equal(r.reservedQty, 0, "A's real (swapped) reservation released");
    assert.equal(r.availableQty, 10); assert.equal(q.availableQty, 20);
    // Same for the stock-hold cancel: the paused request finds A no longer holds withdrawn stock and refuses atomically.
    const c = await order(i, [{ batchId: i.b2, batchNumber: 'R-200', quantity: 1 }], 'accepted');
    await InventoryItemModel.updateOne({ _id: i.id, 'batches._id': new Types.ObjectId(i.b2) },
      { $inc: { availableQty: -1, reservedQty: 1, 'batches.$.availableQty': -1, 'batches.$.reservedQty': 1 } });
    const snapB = await PharmacyOrderModel.findById(b.id).lean();
    await svc.reallocateHeldUnits(staffA, b.id);
    await rejects(staleService(snapB).cancelForStockHold(b.id, pharmacyA, { reason: 'stale' }), 'NO_HELD_STOCK', 409);
    assert.equal((await batch(i.id, i.b2)).reservedQty, 6, 'B (5) + C (1) still reserved on R');
    assert.equal((await batch(i.id, i.b0)).reservedQty, 0);
    assert.equal(String(c.id).length, 24);
    await consistent(i.id);
  });

  await check('customer return: restock into the active batch + partial wallet refund chosen by staff; audit + record', async () => {
    const i = await item();
    const o = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 4 }, { batchId: i.b2, batchNumber: 'R-200', quantity: 2 }], 'completed');
    const rec = await returns.record(staffA, o.id, { requestKey: key(), reason: 'Doctor changed the prescription', refundAmount: 25.5,
      lines: [{ medicineId: i.medicineId, batchId: i.b0, quantity: 3, disposition: 'restock' }, { medicineId: i.medicineId, batchId: i.b2, quantity: 1, disposition: 'discard' }] });
    assert.equal(rec.returnValuePaise, 4000); assert.equal(rec.refundPaise, 2550);
    assert.deepEqual(rec.lines.map(l => [l.batchId, l.quantity, l.disposition, l.batchStatusAtReturn]), [[i.b0, 3, 'restock', 'active'], [i.b2, 1, 'discard', 'active']]);
    assert.equal((await batch(i.id, i.b0)).availableQty, 23); assert.equal((await batch(i.id, i.b2)).availableQty, 10, 'discarded units not restocked');
    const adj = await InventoryAdjustmentModel.find({ inventoryItemId: i.id }).lean();
    assert.equal(adj.length, 1); assert.equal(adj[0].adjustmentType, 'add'); assert.equal(adj[0].reason, 'return'); assert.equal(adj[0].quantity, 3);
    assert.equal(await balance(o.customer), 25.5); await ledgerMatches(o.customer);
    const saved = (await PharmacyOrderModel.findById(o.id).lean())!;
    assert.equal(saved.customerReturns!.count, 1); assert.equal(saved.customerReturns!.refundedPaise, 2550); assert.equal(saved.paymentStatus, 'paid');
    await consistent(i.id);
  });

  await check('return rules: refund above returned value, more units than dispensed, unpaid, not completed, other pharmacy; nothing changes', async () => {
    const i = await item();
    const o = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 2 }], 'completed');
    const line = { medicineId: i.medicineId, batchId: i.b0, quantity: 2, disposition: 'restock' as const };
    await rejects(returns.record(staffA, o.id, { requestKey: key(), reason: 'x', refundAmount: 20.01, lines: [line] }), 'REFUND_EXCEEDS_RETURN_VALUE', 409);
    await rejects(returns.record(staffA, o.id, { requestKey: key(), reason: 'x', lines: [{ ...line, quantity: 3 }] }), 'RETURN_EXCEEDS_DISPENSED', 409);
    await rejects(returns.record(staffA, o.id, { requestKey: key(), reason: 'x', lines: [{ ...line, batchId: i.b2 }] }), 'VALIDATION_ERROR', 400);
    await rejects(returns.record({ pharmacyId: pharmacyB, actorId: pharmacyB }, o.id, { requestKey: key(), reason: 'x', lines: [line] }), 'ORDER_NOT_FOUND', 404);
    assert.equal((await batch(i.id, i.b0)).availableQty, 20, 'rolled back'); assert.equal(await balance(o.customer), 0);
    assert.equal((await PharmacyOrderModel.findById(o.id).lean())!.customerReturns, undefined, 'order fence rolled back too');
    const open = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 2 }], 'packed');
    await rejects(returns.record(staffA, open.id, { requestKey: key(), reason: 'x', lines: [line] }), 'ORDER_NOT_COMPLETED', 409);
    const unpaid = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 2 }], 'completed', false);
    await rejects(returns.record(staffA, unpaid.id, { requestKey: key(), reason: 'x', refundAmount: 5, lines: [line] }), 'REFUND_NOT_AVAILABLE', 409);
    assert.equal(await CustomerReturnModel.countDocuments({ orderId: { $in: [o.id, open.id, unpaid.id] } }), 0);
    await consistent(i.id);
  });

  await check('return into a sold-out batch makes it sellable again; into a recalled batch stays held and shows on the recall trace', async () => {
    const i = await item();
    const o = await order(i, [{ batchId: i.b3, batchNumber: 'R-300', quantity: 4 }, { batchId: i.b0, batchNumber: 'R-100', quantity: 2 }], 'completed');
    await returns.record(staffA, o.id, { requestKey: key(), reason: 'Unopened', lines: [{ medicineId: i.medicineId, batchId: i.b3, quantity: 2, disposition: 'restock' }] });
    const b3 = await batch(i.id, i.b3);
    assert.equal(b3.status, 'active'); assert.equal(b3.availableQty, 2); assert.equal(b3.depletedAt, undefined);
    await svc.recall(staffA, i.id, i.b0, { reason: 'Recall' });
    const rec = await returns.record(staffA, o.id, { requestKey: key(), reason: 'Recall: customer brought it back', refundAmount: 20,
      lines: [{ medicineId: i.medicineId, batchId: i.b0, quantity: 2, disposition: 'restock' }] });
    assert.equal(rec.lines[0].batchStatusAtReturn, 'recalled');
    const b0 = await batch(i.id, i.b0);
    assert.equal(b0.status, 'recalled'); assert.equal(b0.availableQty, 22);
    const trace = await svc.recallTrace(staffA, i.id, i.b0);
    assert.deepEqual(trace.dispensedTo.map(d => [d.orderId, d.quantity, d.returnedQty]), [[o.id, 2, 2]]);
    assert.equal(await balance(o.customer), 20); await ledgerMatches(o.customer);
    await consistent(i.id);
  });

  await check('retry with the same request key returns the first record (no second restock/refund); a key reused on another order is refused', async () => {
    const i = await item();
    const o = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 3 }], 'completed');
    const other = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 3 }], 'completed');
    const k = key();
    const body = { requestKey: k, reason: 'Damaged strip', refundAmount: 10, lines: [{ medicineId: i.medicineId, batchId: i.b0, quantity: 1, disposition: 'discard' as const }] };
    const [a, b] = await Promise.all([returns.record(staffA, o.id, body), returns.record(staffA, o.id, body)]);
    assert.equal(String(a._id), String(b._id)); assert.ok(a.duplicate || b.duplicate);
    assert.equal((await returns.record(staffA, o.id, body)).duplicate, true);
    assert.equal(await CustomerReturnModel.countDocuments({ orderId: o.id }), 1);
    assert.equal(await balance(o.customer), 10); await ledgerMatches(o.customer);
    await rejects(returns.record(staffA, other.id, body), 'REQUEST_KEY_REUSED', 409);
    await consistent(i.id);
  });

  await check('[M2] two concurrent identical requests returning ALL units with a full refund: both get the same receipt, no false 409', async () => {
    for (let round = 0; round < 3; round++) {
      const i = await item();
      const o = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 3 }], 'completed');
      const body = { requestKey: key(), reason: 'Full return', refundAmount: 30, lines: [{ medicineId: i.medicineId, batchId: i.b0, quantity: 3, disposition: 'restock' as const }] };
      const [x, y] = await Promise.all([returns.record(staffA, o.id, body), returns.record(staffA, o.id, body)]);
      assert.equal(String(x._id), String(y._id)); assert.ok(x.duplicate !== y.duplicate, 'exactly one is the replay');
      assert.equal(await CustomerReturnModel.countDocuments({ orderId: o.id }), 1);
      assert.equal((await batch(i.id, i.b0)).availableQty, 23);
      assert.equal(await balance(o.customer), 30); await ledgerMatches(o.customer);
      await consistent(i.id);
    }
  });

  await check('five concurrent returns of 2 units from 6 dispensed (each refunding 20): exactly 3 succeed; stock and wallet exact', async () => {
    const i = await item();
    const o = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 6 }], 'completed');
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => returns.record(staffA, o.id, { requestKey: key(), reason: 'Return', refundAmount: 20,
      lines: [{ medicineId: i.medicineId, batchId: i.b0, quantity: 2, disposition: 'restock' }] })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => (r as PromiseRejectedResult).reason.code === 'RETURN_EXCEEDS_DISPENSED'));
    assert.equal((await batch(i.id, i.b0)).availableQty, 26);
    assert.equal(await balance(o.customer), 60); await ledgerMatches(o.customer);
    assert.equal((await PharmacyOrderModel.findById(o.id).lean())!.customerReturns!.refundedPaise, 6000);
    await consistent(i.id);
  });

  await check('HTTP: recall, trace, swap, stock-hold cancel and customer returns through the real routers and auth', async () => {
    for (const [n, pid] of [pharmacyA, pharmacyB].entries()) {
      await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(pid), isActive: true, isVerified: true, phone: '93100000' + n, email: `r${n}@example.com` } as never);
    }
    Container.set(BatchQualityService, svc);
    Container.set(CustomerReturnService, returns);
    Container.set(PharmacyOrderService, orders);
    const { default: invRouter } = await import('@/modules/pharmacyInventory/routes');
    const { default: orderRouter } = await import('@/modules/pharmacyOrders/routes');
    const { authenticate } = await import('@/modules/middleware/auth');
    const app = express(); app.use(express.json());
    app.use('/api/v1/pharmacy-inventory', authenticate, invRouter);
    app.use('/api/v1/pharmacy-orders', authenticate, orderRouter);
    app.use((err: { status?: number; code?: string }, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
      res.status(err.status ?? 500).json({ success: false, code: err.code });
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const call = (method: string, path: string, pid: string, body?: object) => fetch(`http://127.0.0.1:${port}/api/v1${path}`,
        { method, headers: { authorization: 'Bearer ' + jwt.sign({ _id: pid, pharmacyId: pid, userType: 'pharmacy' }, CONFIG.JWT_SECRET_KEY),
          'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const i = await item();
      const swap = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 2 }], 'accepted');
      const cancel = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 3 }], 'packed');
      const sold = await order(i, [{ batchId: i.b0, batchNumber: 'R-100', quantity: 2 }], 'completed');
      assert.equal((await call('POST', `/pharmacy-inventory/${i.id}/batches/${i.b0}/recall`, pharmacyA, {})).status, 400);
      assert.equal((await call('POST', `/pharmacy-inventory/${i.id}/batches/${i.b0}/recall`, pharmacyB, { reason: 'not mine' })).status, 404);
      const recall = await call('POST', `/pharmacy-inventory/${i.id}/batches/${i.b0}/recall`, pharmacyA, { reason: 'Recall notice', reference: 'MFR-77' });
      assert.equal(recall.status, 200);
      const trace = await (await call('GET', `/pharmacy-inventory/${i.id}/batches/${i.b0}/recall-trace`, pharmacyA)).json() as
        { data: { openOrders: { orderId: string }[]; dispensedTo: { orderId: string }[] } };
      assert.deepEqual(trace.data.openOrders.map(o => o.orderId).sort(), [swap.id, cancel.id].sort());
      assert.deepEqual(trace.data.dispensedTo.map(o => o.orderId), [sold.id]);
      assert.equal((await call('POST', `/pharmacy-orders/${swap.id}/reallocate-held-stock`, pharmacyB)).status, 404);
      assert.equal((await call('POST', `/pharmacy-orders/${swap.id}/reallocate-held-stock`, pharmacyA)).status, 200);
      assert.equal((await call('POST', `/pharmacy-orders/${cancel.id}/stock-hold-cancel`, pharmacyA, {})).status, 400);
      assert.equal((await call('POST', `/pharmacy-orders/${cancel.id}/stock-hold-cancel`, pharmacyA, { reason: 'Recalled' })).status, 200);
      assert.equal(await balance(cancel.customer), 30);
      const body = { requestKey: key(), reason: 'Recall return', refundAmount: 20, lines: [{ medicineId: i.medicineId, batchId: i.b0, quantity: 2, disposition: 'restock' }] };
      assert.equal((await call('POST', `/pharmacy-orders/${sold.id}/customer-returns`, pharmacyA, { ...body, refundAmount: 1.234 })).status, 400);
      assert.equal((await call('POST', `/pharmacy-orders/${sold.id}/customer-returns`, pharmacyB, body)).status, 404);
      assert.equal((await call('POST', `/pharmacy-orders/${sold.id}/customer-returns`, pharmacyA, body)).status, 201);
      assert.equal((await call('POST', `/pharmacy-orders/${sold.id}/customer-returns`, pharmacyA, body)).status, 200, 'retry = same record');
      const list = await (await call('GET', `/pharmacy-inventory/customer-returns?orderId=${sold.id}`, pharmacyA)).json() as { data: unknown[] };
      assert.equal(list.data.length, 1);
      assert.equal(((await (await call('GET', '/pharmacy-inventory/customer-returns', pharmacyB)).json()) as { data: unknown[] }).data.length, 0);
      assert.equal(await balance(sold.customer), 20); await ledgerMatches(sold.customer); await ledgerMatches(cancel.customer);
      await consistent(i.id);
    } finally { server.close(); }
  });

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
