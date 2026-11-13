/**
 * P3 batch quality against a real MongoDB replica set: quarantine / release (with write-off) and returns to
 * suppliers, through BatchQualityService and the real HTTP routes. Every scenario checks that the item's
 * availableQty equals the sum of its batches' availableQty and that adjustments match the stock that left.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/p3_quality_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/pharmacy-inventory/p3-batch-quality.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { addDaysToYyyymmdd, getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import PharmacyModel from '@/modules/pharmacies/model';
import { InventoryAdjustmentModel, InventoryItemModel } from '@/modules/pharmacyInventory/model';
import { InventoryItemRepository } from '@/modules/pharmacyInventory/repository';
import { BatchQualityService } from '@/modules/pharmacyInventory/batchQuality';
import { SupplierReturnModel } from '@/modules/pharmacyInventory/supplierReturnModel';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/p3_quality_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const svc = new BatchQualityService();
const pharmacyA = new Types.ObjectId().toHexString();
const pharmacyB = new Types.ObjectId().toHexString();
const staffA = { pharmacyId: pharmacyA, actorId: pharmacyA };
const today = getTodayYyyymmdd();

async function supplier(pharmacyId: string, state: 'active' | 'archived' = 'active') {
  const { insertedId } = await mongoose.connection.db!.collection('pharmacy_suppliers').insertOne({ schemaVersion: 1,
    pharmacyId: new Types.ObjectId(pharmacyId), displayName: 'MedDist Ltd', state, revision: 1, createdByActorId: pharmacyId,
    updatedByActorId: pharmacyId, archivedAt: state === 'archived' ? new Date() : null, createdAt: new Date(), updatedAt: new Date() });
  return insertedId.toHexString();
}
/** Item with B0 active (30 available + 5 reserved) and B1 expired (10 available). */
async function item(pharmacyId = pharmacyA) {
  const b0 = new Types.ObjectId(), b1 = new Types.ObjectId();
  const { insertedId } = await InventoryItemModel.collection.insertOne({ pharmacyId: new Types.ObjectId(pharmacyId), medicineId: new Types.ObjectId(),
    availableQty: 40, reservedQty: 5, freeQty: 0, reorderThreshold: 0, isActive: true, createdAt: new Date(), updatedAt: new Date(),
    batches: [
      { _id: b0, batchNumber: 'B-221', expiryDate: addDaysToYyyymmdd(today, 200), receivedAt: new Date(), availableQty: 30, reservedQty: 5, freeQty: 0, status: 'active', purchasePrice: 4 },
      { _id: b1, batchNumber: 'B-090', expiryDate: addDaysToYyyymmdd(today, -5), receivedAt: new Date(), availableQty: 10, reservedQty: 0, freeQty: 0, status: 'expired', purchasePrice: 4 },
    ] } as never);
  return { id: insertedId.toHexString(), b0: b0.toHexString(), b1: b1.toHexString() };
}
const row = async (id: string) => (await InventoryItemModel.findById(id).lean())!;
const batch = async (id: string, b: string) => (await row(id)).batches!.find(x => String((x as { _id?: unknown })._id) === b)!;
async function consistent(id: string) {
  const r = await row(id);
  assert.equal(r.availableQty, r.batches!.reduce((a, b) => a + b.availableQty, 0), 'item availableQty == sum of batches');
  assert.ok(r.batches!.every(b => b.availableQty >= 0 && b.reservedQty >= 0));
}
async function rejects(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: { code?: string; status?: number }) => e.code === code && (status === undefined || e.status === status));
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(url);
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await Promise.all([InventoryItemModel.init(), InventoryAdjustmentModel.init(), SupplierReturnModel.init(), PharmacyOrderModel.init()]);

  await check('quarantine: batch can no longer be reserved or completed; the order holding its units is listed', async () => {
    const i = await item();
    const r = (await row(i.id));
    const order = await PharmacyOrderModel.create({ pharmacyId: pharmacyA, orderType: 'online', status: 'packed', createdById: pharmacyA, createdByRole: 'pharmacy',
      paymentMode: 'online_payment', paymentStatus: 'paid', items: [{ medicineId: r.medicineId, medicineName: 'Paracetamol', orderedQty: 5, unitPrice: 10,
        lineTotal: 50, itemStatus: 'active', batchAllocations: [{ batchId: i.b0, batchNumber: 'B-221', expiryDate: addDaysToYyyymmdd(today, 200), quantity: 5 }] }] });
    const out = await svc.quarantine(staffA, i.id, i.b0, 'Damaged packaging');
    assert.equal(out.batch!.status, 'quarantined'); assert.equal(out.batch!.holdReason, 'Damaged packaging');
    assert.deepEqual(out.impactedOrders.map(o => o.orderId), [String(order._id)]);
    assert.equal(out.impactedOrders[0].heldUnits[0].quantity, 5);
    const repo = new InventoryItemRepository();
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        assert.equal(await repo.reserveBatches(pharmacyA, String(r.medicineId), 1, session), null, 'nothing reservable');
        assert.equal(await repo.consumeBatchAllocations(pharmacyA, String(r.medicineId),
          [{ batchId: i.b0, batchNumber: 'B-221', expiryDate: addDaysToYyyymmdd(today, 200), quantity: 5 }], session), null, 'order cannot complete from it');
      });
    } finally { await session.endSession(); }
    assert.equal((await svc.impactedOrders(staffA)).length, 1);
    await consistent(i.id);
  });

  await check('release with write-off: 4 damaged units written off (adjustment), batch back on sale, reserved units untouched', async () => {
    const i = await item();
    await svc.quarantine(staffA, i.id, i.b0, 'Damaged packaging');
    await svc.release(staffA, i.id, i.b0, 4, 'Checked; 4 strips crushed');
    const b = await batch(i.id, i.b0);
    assert.equal(b.status, 'active'); assert.equal(b.availableQty, 26); assert.equal(b.reservedQty, 5); assert.equal(b.holdReason, undefined);
    assert.equal((await row(i.id)).availableQty, 36);
    const adj = await InventoryAdjustmentModel.find({ inventoryItemId: i.id }).lean();
    assert.equal(adj.length, 1); assert.equal(adj[0].quantity, 4); assert.equal(adj[0].reason, 'damage'); assert.equal(adj[0].adjustmentType, 'remove');
    await consistent(i.id);
  });

  await check('release an expired quarantined batch -> stays "expired" (not sellable); write-off everything unreserved', async () => {
    const i = await item();
    await svc.quarantine(staffA, i.id, i.b1, 'Smell check');
    await svc.release(staffA, i.id, i.b1, 10, 'Discarded');
    const b = await batch(i.id, i.b1);
    assert.equal(b.status, 'expired'); assert.equal(b.availableQty, 0);
    await consistent(i.id);
  });

  await check('return to supplier: expired batch fully returned (keeps expired status); record + adjustment; listed', async () => {
    const i = await item(); const sup = await supplier(pharmacyA);
    const rec = await svc.returnToSupplier(staffA, i.id, i.b1, { supplierId: sup, quantity: 10, reason: 'expired', notes: 'Credit note expected' });
    assert.equal(rec.quantity, 10); assert.equal(rec.batchStatusAtReturn, 'expired'); assert.equal(rec.unitCost, 4);
    const b = await batch(i.id, i.b1);
    assert.equal(b.availableQty, 0); assert.equal(b.status, 'expired', 'only an ACTIVE batch becomes depleted; held/expired keep their status');
    const adj = await InventoryAdjustmentModel.findOne({ sourceId: String(rec._id) }).lean();
    assert.equal(adj!.reason, 'return'); assert.equal(adj!.quantity, 10);
    const list = await svc.listSupplierReturns(staffA);
    assert.ok(list.data.some(x => String(x._id) === String(rec._id)));
    await consistent(i.id);
  });

  await check('rules: reserved units, archived/foreign supplier, wrong state, other pharmacy', async () => {
    const i = await item(); const sup = await supplier(pharmacyA);
    await rejects(svc.returnToSupplier(staffA, i.id, i.b0, { supplierId: sup, quantity: 31, reason: 'damaged' }), 'VALIDATION_ERROR', 400); // 5 are reserved
    await rejects(svc.returnToSupplier(staffA, i.id, i.b0, { supplierId: await supplier(pharmacyA, 'archived'), quantity: 1, reason: 'damaged' }), 'SUPPLIER_ARCHIVED', 409);
    await rejects(svc.returnToSupplier(staffA, i.id, i.b0, { supplierId: await supplier(pharmacyB), quantity: 1, reason: 'damaged' }), 'SUPPLIER_NOT_FOUND', 404);
    await rejects(svc.release(staffA, i.id, i.b0, 0, 'not held'), 'BATCH_NOT_QUARANTINED', 409);
    await svc.quarantine(staffA, i.id, i.b0, 'hold');
    await rejects(svc.quarantine(staffA, i.id, i.b0, 'again'), 'BATCH_NOT_HOLDABLE', 409);
    await rejects(svc.release(staffA, i.id, i.b0, 31, 'too many'), 'VALIDATION_ERROR', 400);
    await rejects(svc.quarantine({ pharmacyId: pharmacyB, actorId: pharmacyB }, i.id, i.b1, 'not mine'), 'BATCH_NOT_FOUND', 404);
    await consistent(i.id);
  });

  /** A service whose next loadBatch returns a snapshot taken earlier (simulates a request that read, then paused). */
  const staleFrom = async (itemId: string, batchId: string) => {
    const snap = await (svc as unknown as { loadBatch: (a: object, i: string, b: string) => Promise<unknown> }).loadBatch(staffA, itemId, batchId);
    return Object.assign(Object.create(svc), { loadBatch: async () => snap }) as BatchQualityService;
  };

  await check('[H1] a stale release cannot clear a NEWER quarantine of the same batch', async () => {
    const i = await item();
    await svc.quarantine(staffA, i.id, i.b0, 'Concern T1');
    const staleA = await staleFrom(i.id, i.b0);                           // A reads hold T1 and pauses
    await svc.release(staffA, i.id, i.b0, 0, 'T1 resolved');              // B releases T1
    await svc.quarantine(staffA, i.id, i.b0, 'New concern T2');           // C quarantines again (same quantities)
    const t2 = (await batch(i.id, i.b0)).holdId;
    await rejects(staleA.release(staffA, i.id, i.b0, 0, 'stale'), 'BATCH_STATE_CHANGED', 409);
    const b = await batch(i.id, i.b0);
    assert.equal(b.status, 'quarantined'); assert.equal(b.holdId, t2); assert.equal(b.holdReason, 'New concern T2');
  });

  await check('[H2] quarantined batch fully returned keeps its hold; receiving more of it later stays blocked', async () => {
    const i = await item(); const sup = await supplier(pharmacyA);
    await svc.quarantine(staffA, i.id, i.b1, 'Suspect');                   // b1: 10 units, none reserved
    await svc.returnToSupplier(staffA, i.id, i.b1, { supplierId: sup, quantity: 10, reason: 'damaged' });
    assert.equal((await batch(i.id, i.b1)).status, 'quarantined', 'not overwritten with depleted');
    // future-dated batch, quarantined, emptied, then a normal receipt of the same batch number/expiry
    const repo = new InventoryItemRepository();
    const r = await row(i.id);
    const b0 = await batch(i.id, i.b0);
    await svc.quarantine(staffA, i.id, i.b0, 'Suspect too');
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await repo.adjustBatchStock(pharmacyA, String(r.medicineId), { batchNumber: b0.batchNumber, expiryDate: b0.expiryDate, quantityDelta: 10 } as never, session);
      });
      assert.equal((await batch(i.id, i.b0)).status, 'quarantined', 'receipt does not reactivate a held batch');
      await session.withTransaction(async () => {
        assert.equal(await repo.reserveBatches(pharmacyA, String(r.medicineId), 1, session), null, 'still not reservable');
      });
    } finally { await session.endSession(); }
    await consistent(i.id);
  });

  await check('[M3] audit records describe the committed write (batch-scoped), not a stale read', async () => {
    const i = await item(); const sup = await supplier(pharmacyA);
    await svc.quarantine(staffA, i.id, i.b0, 'Check');
    const stale = await staleFrom(i.id, i.b0);                            // read: item total 40
    await InventoryItemModel.updateOne({ _id: i.id, 'batches._id': new Types.ObjectId(i.b1) },
      { $inc: { availableQty: 10, 'batches.$.availableQty': 10 } });     // another batch restocked meanwhile (total 50)
    await stale.release(staffA, i.id, i.b0, 4, 'Four crushed');
    const adj = (await InventoryAdjustmentModel.findOne({ inventoryItemId: i.id, reason: 'damage' }).lean())!;
    assert.equal(adj.availableQtyBefore, 30); assert.equal(adj.availableQtyAfter, 26, 'batch-scoped before/after of the committed write');
    // status/cost changed between the read and the return
    const stale2 = await staleFrom(i.id, i.b0);                           // read: active, cost 4
    await InventoryItemModel.updateOne({ _id: i.id, 'batches._id': new Types.ObjectId(i.b0) },
      { $set: { 'batches.$.status': 'quarantined', 'batches.$.purchasePrice': 9 } });
    const rec = await stale2.returnToSupplier(staffA, i.id, i.b0, { supplierId: sup, quantity: 2, reason: 'damaged' });
    assert.equal(rec.batchStatusAtReturn, 'quarantined'); assert.equal(rec.unitCost, 9);
    const adj2 = (await InventoryAdjustmentModel.findOne({ sourceId: String(rec._id) }).lean())!;
    assert.equal(adj2.availableQtyBefore, 26); assert.equal(adj2.availableQtyAfter, 24);
    await consistent(i.id);
  });

  await check('five concurrent supplier returns of 10 from 30 unreserved units: exactly 3 succeed, never negative', async () => {
    const i = await item(); const sup = await supplier(pharmacyA);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => svc.returnToSupplier(staffA, i.id, i.b0, { supplierId: sup, quantity: 10, reason: 'near_expiry' })));
    const ok = results.filter(r => r.status === 'fulfilled').length;
    assert.equal(ok, 3);
    const b = await batch(i.id, i.b0);
    assert.equal(b.availableQty, 0); assert.equal(b.reservedQty, 5); assert.equal(b.status, 'active', 'reserved units keep the batch active');
    assert.equal(await SupplierReturnModel.countDocuments({ inventoryItemId: i.id }), 3);
    assert.equal(await InventoryAdjustmentModel.countDocuments({ inventoryItemId: i.id, reason: 'return' }), 3);
    await consistent(i.id);
  });

  await check('HTTP: quarantine, release, supplier return and lists through the real router and auth', async () => {
    for (const [n, pid] of [pharmacyA, pharmacyB].entries()) {
      await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(pid), isActive: true, isVerified: true, phone: '93000000' + n, email: `q${n}@example.com` } as never);
    }
    Container.set(BatchQualityService, svc);
    const { default: router } = await import('@/modules/pharmacyInventory/routes');
    const { authenticate } = await import('@/modules/middleware/auth');
    const app = express(); app.use(express.json());
    app.use('/api/v1/pharmacy-inventory', authenticate, router);
    app.use((err: { status?: number; code?: string }, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
      res.status(err.status ?? 500).json({ success: false, code: err.code });
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const call = (method: string, path: string, pid: string, body?: object) => fetch(`http://127.0.0.1:${port}/api/v1/pharmacy-inventory${path}`,
        { method, headers: { authorization: 'Bearer ' + jwt.sign({ _id: pid, pharmacyId: pid, userType: 'pharmacy' }, CONFIG.JWT_SECRET_KEY),
          'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const i = await item(); const sup = await supplier(pharmacyA);
      assert.equal((await call('POST', `/${i.id}/batches/${i.b0}/quarantine`, pharmacyA, {})).status, 400); // reason required
      assert.equal((await call('POST', `/${i.id}/batches/${i.b0}/quarantine`, pharmacyB, { reason: 'not mine' })).status, 404);
      assert.equal((await call('POST', `/${i.id}/batches/${i.b0}/quarantine`, pharmacyA, { reason: 'Damaged' })).status, 200);
      assert.equal((await call('GET', '/held-batch-orders', pharmacyA)).status, 200);
      assert.equal((await call('POST', `/${i.id}/batches/${i.b0}/release`, pharmacyA, { writeOffQty: 2, reason: 'Two crushed' })).status, 200);
      const ret = await call('POST', `/${i.id}/batches/${i.b1}/supplier-return`, pharmacyA, { supplierId: sup, quantity: 5, reason: 'expired' });
      assert.equal(ret.status, 201);
      const list = await (await call('GET', '/supplier-returns', pharmacyA)).json() as { data: unknown[] };
      assert.ok(list.data.length >= 1);
      const other = await (await call('GET', '/supplier-returns', pharmacyB)).json() as { data: unknown[] };
      assert.equal(other.data.length, 0);
      await consistent(i.id);
    } finally { server.close(); }
  });

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
