/**
 * P7c low stock against a real MongoDB replica set: the notification sweep (once per drop, cleared on restock) and
 * the low-stock worklist with upcoming refill demand, including the real HTTP route and InventoryService.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/p7c_lowstock_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/pharmacy-inventory/p7c-low-stock.integration.ts
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
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { InventoryItemModel } from '@/modules/pharmacyInventory/model';
import { InventoryAdjustmentRepository, InventoryItemRepository, InventoryReservationRepository } from '@/modules/pharmacyInventory/repository';
import { InventoryService } from '@/modules/pharmacyInventory/services';
import { LowStockAlertService } from '@/modules/pharmacyInventory/lowStockAlerts';
import MedicineModel from '@/modules/pharmacyMedicines/model';
import { MedicineRepository } from '@/modules/pharmacyMedicines/repository';
import NotificationModel from '@/modules/notification/model';
import PharmacySubscriptionModel from '@/modules/pharmacySubscriptions/model';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/p7c_lowstock_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const alerts = new LowStockAlertService();
const pharmacyA = new Types.ObjectId().toHexString();
const pharmacyB = new Types.ObjectId().toHexString();
const today = getTodayYyyymmdd();

async function item(opts: { qty: number; threshold: number; active?: boolean; pharmacyId?: string; name?: string;
  batches?: { status: string; expiryDate: string; availableQty: number }[] }) {
  const { insertedId: med } = await MedicineModel.collection.insertOne({ name: opts.name ?? 'Paracetamol 500', isActive: true, prescriptionRequired: false } as never);
  const { insertedId } = await InventoryItemModel.collection.insertOne({ pharmacyId: new Types.ObjectId(opts.pharmacyId ?? pharmacyA), medicineId: med,
    availableQty: opts.qty, reservedQty: 0, freeQty: 0, reorderThreshold: opts.threshold, isActive: opts.active ?? true,
    batches: (opts.batches ?? []).map((b, i) => ({ _id: new Types.ObjectId(), batchNumber: 'B' + i, receivedAt: new Date(), reservedQty: 0, freeQty: 0, ...b })),
    createdAt: new Date(), updatedAt: new Date() } as never);
  return { id: insertedId.toHexString(), medicineId: med.toHexString() };
}
const notes = (itemId: string) => NotificationModel.find({ referenceType: 'inventory_low_stock', referenceId: itemId }).lean();
const setQty = (id: string, qty: number) => InventoryItemModel.updateOne({ _id: id }, { $set: { availableQty: qty } });

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(url);
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await Promise.all([InventoryItemModel.init(), NotificationModel.init(), PharmacySubscriptionModel.init()]);

  await check('item below its reorder level notifies the pharmacy once; repeated sweeps do not repeat it', async () => {
    const i = await item({ qty: 3, threshold: 10, name: 'Vitamin D3' });
    await alerts.sweep(); await alerts.sweep();
    const n = await notes(i.id);
    assert.equal(n.length, 1);
    assert.equal(n[0].userId, pharmacyA); assert.match(n[0].message, /Vitamin D3 is low: 3 sellable left \(reorder level 10\)/);
  });

  await check('restocked above the level clears the marker; the next drop notifies again', async () => {
    const i = await item({ qty: 2, threshold: 5 });
    await alerts.sweep();
    await setQty(i.id, 20); await alerts.sweep();
    assert.equal((await InventoryItemModel.findById(i.id).lean())!.lowStockNotifiedAt, undefined);
    await setQty(i.id, 4); await alerts.sweep();
    assert.equal((await notes(i.id)).length, 2);
  });

  await check('no notification without a reorder level (0) or for inactive items; exactly-at-level counts as low', async () => {
    const none = await item({ qty: 0, threshold: 0 });
    const inactive = await item({ qty: 1, threshold: 10, active: false });
    const atLevel = await item({ qty: 10, threshold: 10 });
    await alerts.sweep();
    assert.equal((await notes(none.id)).length, 0); assert.equal((await notes(inactive.id)).length, 0);
    assert.equal((await notes(atLevel.id)).length, 1);
  });

  await check('[C1] refill and drain again with NO sweep in between: the second drop still notifies', async () => {
    const i = await item({ qty: 2, threshold: 5 });
    await alerts.sweep();                                                      // 1st alert
    const repo = new InventoryItemRepository();
    await repo.atomicReturn(pharmacyA, i.medicineId, 18);                     // restock to 20 (re-arms in the same write path)
    assert.equal((await InventoryItemModel.findById(i.id).lean())!.lowStockNotifiedAt, undefined);
    await repo.atomicReserve(pharmacyA, i.medicineId, 16);                    // orders take it back down to 4
    await alerts.sweep();
    assert.equal((await notes(i.id)).length, 2, 'new low period, new alert');
  });

  await check('[C3] release without a caller transaction re-arms in the SAME write (atomicRelease / atomicReturn)', async () => {
    const i = await item({ qty: 2, threshold: 5 });
    await InventoryItemModel.updateOne({ _id: i.id }, { $set: { reservedQty: 18 } });
    await alerts.sweep();
    const repo = new InventoryItemRepository();
    const after = await repo.atomicRelease(pharmacyA, i.medicineId, 18);
    assert.equal(after!.availableQty, 20); assert.equal(after!.lowStockNotifiedAt, undefined, 'returned document already re-armed');
    await repo.atomicReserve(pharmacyA, i.medicineId, 16); await alerts.sweep();
    assert.equal((await notes(i.id)).length, 2);
    const j = await item({ qty: 1, threshold: 5 });
    await alerts.sweep();
    const ret = await repo.atomicReturn(pharmacyA, j.medicineId, 2);   // 3 sellable: still low, marker kept
    assert.ok(ret!.lowStockNotifiedAt, 'still low: no re-arm, no duplicate alert');
    await alerts.sweep(); assert.equal((await notes(j.id)).length, 1);
  });

  await check('[C2] mostly expired stock (2 sellable of 100) is low; the message states sellable units', async () => {
    const yesterday = addDaysToYyyymmdd(today, -1);
    const i = await item({ qty: 100, threshold: 10, name: 'Amoxicillin', batches: [
      { status: 'active', expiryDate: addDaysToYyyymmdd(today, 90), availableQty: 2 },
      { status: 'active', expiryDate: yesterday, availableQty: 60 },        // expired by date, never re-marked
      { status: 'quarantined', expiryDate: addDaysToYyyymmdd(today, 90), availableQty: 38 } ] });
    await alerts.sweep();
    const n = await notes(i.id);
    assert.equal(n.length, 1); assert.match(n[0].message, /Amoxicillin is low: 2 sellable left \(reorder level 10\)/);
    const healthy = await item({ qty: 30, threshold: 10, batches: [{ status: 'active', expiryDate: addDaysToYyyymmdd(today, 90), availableQty: 30 }] });
    await alerts.sweep();
    assert.equal((await notes(healthy.id)).length, 0);
  });

  await check('[C2] expiry alone (no stock change) makes an item low and it is alerted', async () => {
    const i = await item({ qty: 20, threshold: 10, batches: [
      { status: 'active', expiryDate: addDaysToYyyymmdd(today, 30), availableQty: 5 },
      { status: 'active', expiryDate: today, availableQty: 15 } ] });
    await alerts.sweep();
    assert.equal((await notes(i.id)).length, 0, 'today is still sellable');
    await InventoryItemModel.collection.updateOne({ _id: new Types.ObjectId(i.id) }, { $set: { 'batches.1.expiryDate': addDaysToYyyymmdd(today, -1) } });
    await alerts.sweep();
    assert.equal((await notes(i.id)).length, 1);
  });

  await check('three concurrent sweeps notify once', async () => {
    const i = await item({ qty: 1, threshold: 8 });
    await Promise.all([alerts.sweep(), alerts.sweep(), alerts.sweep()]);
    assert.equal((await notes(i.id)).length, 1);
  });

  await check('refill demand counts only active subscriptions of this pharmacy due within 14 days', async () => {
    const i = await item({ qty: 2, threshold: 10 });
    const sub = (extra: object) => PharmacySubscriptionModel.collection.insertOne({ pharmacyId: new Types.ObjectId(pharmacyA), userId: new Types.ObjectId(),
      medicineId: new Types.ObjectId(i.medicineId), intervalDays: 30, isActive: true, nextRefillDate: today, ...extra } as never);
    await sub({}); await sub({ nextRefillDate: addDaysToYyyymmdd(today, 10) });
    await sub({ nextRefillDate: addDaysToYyyymmdd(today, 30) });                // too far out
    await sub({ isActive: false });                                              // inactive
    await sub({ pharmacyId: new Types.ObjectId(pharmacyB) });                    // other pharmacy
    const demand = await alerts.refillDemand(pharmacyA, [i.medicineId]);
    assert.equal(demand.get(i.medicineId), 2);
  });

  await check('HTTP: existing low-stock worklist now carries upcomingRefills; another pharmacy sees none of these', async () => {
    const healthyId = (await item({ qty: 0, threshold: 10, batches: [{ status: 'active', expiryDate: addDaysToYyyymmdd(today, 90), availableQty: 50 }] })).id;
    for (const [n, id] of [pharmacyA, pharmacyB].entries()) await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(id), isActive: true, isVerified: true, phone: '900000000' + n, email: `p${n}@example.com` } as never);
    const inventory = new (InventoryService as unknown as new (...a: unknown[]) => InventoryService)(new InventoryItemRepository(),
      new InventoryAdjustmentRepository(), new InventoryReservationRepository(), new PharmacyRepository(), new MedicineRepository());
    Container.set(InventoryService, inventory); Container.set(LowStockAlertService, alerts);
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
      const get = (pid: string) => fetch(`http://127.0.0.1:${port}/api/v1/pharmacy-inventory/low-stock?limit=100`,
        { headers: { authorization: 'Bearer ' + jwt.sign({ _id: pid, pharmacyId: pid, userType: 'pharmacy' }, CONFIG.JWT_SECRET_KEY) } });
      const a = await (await get(pharmacyA)).json() as { data: { medicineId: string; upcomingRefills: number }[] };
      assert.ok(a.data.length > 0);
      assert.ok(a.data.every(r => typeof r.upcomingRefills === 'number'));
      assert.ok(a.data.some(r => r.upcomingRefills === 2), 'the item with two due refills shows 2');
      assert.ok(!a.data.some(r => String((r as { _id?: string })._id) === healthyId), 'sellable-healthy item is not on the low-stock list');
      const b = await (await get(pharmacyB)).json() as { data: unknown[] };
      assert.equal(b.data.length, 0);
    } finally { server.close(); }
  });

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
