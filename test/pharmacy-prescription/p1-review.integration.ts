/**
 * P1 focused integration check: pharmacist prescription review against a real MongoDB replica set.
 * Real PharmacyOrderService/repository/transactions; inventory and notification side effects are recorders.
 *
 * Run (throwaway DB only; the script drops its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/p1_rx_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/pharmacy-prescription/p1-review.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import '@/modules/user/model';
import '@/modules/pharmacies/model'; // registered for the list query's populate()
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacyOrderService, prescriptionDocumentSetSha256 } from '@/modules/pharmacyOrders/services';
import PharmacyModel from '@/modules/pharmacies/model';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { orderQuerySchema, prescriptionReviewSchema } from '@/modules/pharmacyOrders/validation';

// The script drops its database: accept only this exact disposable fixture URL, never a pattern match.
const FIXTURE_URL = 'mongodb://127.0.0.1:27917/p1_rx_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const released: { pharmacyId: string; items: unknown[] }[] = [];
const notices: string[] = [];
let failRelease = false;
const inventoryService = {
  returnStockBulk: async (pharmacyId: string, items: unknown[], session: unknown) => {
    assert.ok(session, 'stock release must run inside the order transaction');
    if (failRelease) throw new Error('inventory unavailable');
    released.push({ pharmacyId, items });
    return [];
  },
  releaseOrderStockBulk: async () => undefined,
  consumeOrderReservedStockBulk: async () => undefined,
};
const sideEffectService = {
  queueNotification: async (_id: string, trigger: string) => { notices.push('notify:' + trigger); },
  queueSubscriptionSync: async (_id: string, trigger: string) => { notices.push('sync:' + trigger); },
};
const service = new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
  new PharmacyOrderRepository(), {}, inventoryService, {}, {}, {}, sideEffectService, {},
  { buildIntent: async () => ({ status: 'manual_review', walletAmount: 0, gatewayAmountPaise: 0, generation: 0, updatedAt: new Date() }), settleAfterRejection: async () => undefined }); // refunds are covered by the P2 test

const pharmacyA = new Types.ObjectId().toHexString();
const pharmacyB = new Types.ObjectId().toHexString();
const RX = ['https://files.example/rx-1.jpg', 'https://files.example/rx-2.jpg'];
const pharmacist = { pharmacistName: 'A. Pharmacist', pharmacistRegistrationNumber: 'KA/PH/12345' };

async function seed(over: Record<string, unknown> = {}): Promise<string> {
  const medicineId = new Types.ObjectId();
  const doc = await PharmacyOrderModel.create({
    pharmacyId: pharmacyA, orderType: 'online', status: 'placed', customerId: new Types.ObjectId(),
    createdById: new Types.ObjectId(), createdByRole: 'user', paymentMode: 'online_payment', paymentStatus: 'pending',
    items: [{ medicineId, medicineName: 'Rx Med', orderedQty: 2, unitPrice: 50, lineTotal: 100, prescriptionRequired: true, itemStatus: 'active' }],
    prescriptionUrls: RX, prescriptionStatus: 'pending', ...over,
  });
  return String(doc._id);
}
const get = async (id: string) => PharmacyOrderModel.findById(id).lean();
async function rejects(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: { code?: string; status?: number }) => e.code === code && (status === undefined || e.status === status));
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(url);
  // Clear instead of drop: a pending dropDatabase races with Mongoose's own collection creation.
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  for (let i = 0; ; i++) { // dropDatabase completes asynchronously; retry while it is still pending
    try { await PharmacyOrderModel.init(); break; }
    catch (e) { if ((e as { code?: number }).code !== 215 || i > 20) throw e; await new Promise(r => setTimeout(r, 500)); }
  }

  await check('approve: status approved, review recorded, stock untouched, customer notified', async () => {
    const id = await seed({ status: 'accepted', paymentStatus: 'paid' });
    released.length = 0; notices.length = 0;
    const out = await service.reviewPrescription(id, pharmacyA, { decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: RX });
    assert.equal(out.prescriptionStatus, 'approved');
    assert.equal(out.status, 'accepted');
    const r = (await get(id))!.prescriptionReview!;
    assert.equal(r.decision, 'approved');
    assert.equal(r.pharmacistRegistrationNumber, 'KA/PH/12345');
    assert.equal(r.reviewedDocumentSetSha256, prescriptionDocumentSetSha256(RX));
    assert.equal(r.reviewedDocumentCount, 2);
    assert.equal(String(r.reviewedByPharmacyId), pharmacyA);
    assert.equal(r.refundRequired, false);
    assert.equal(released.length, 0);
    assert.deepEqual(notices, ['notify:order_updated']);
  });

  await check('previously stuck paid Rx order now completes through the normal status flow', async () => {
    const id = await seed({ status: 'accepted', paymentStatus: 'paid' });
    await rejects(service.updateStatus(id, pharmacyA, { status: 'packed' }), 'ORDER_PRESCRIPTION_APPROVAL_REQUIRED', 409);
    await service.reviewPrescription(id, pharmacyA, { decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: RX });
    for (const status of ['packed', 'out_for_delivery', 'completed'] as const) await service.updateStatus(id, pharmacyA, { status });
    assert.equal((await get(id))!.status, 'completed');
  });

  await check('approved COD Rx order can be marked paid and completed (was blocked by the commerce gate)', async () => {
    const id = await seed({ status: 'accepted', paymentMode: 'cash_on_delivery', paymentStatus: 'pending' });
    await rejects(service.markPaid(id, { userType: 'pharmacy', pharmacyId: pharmacyA, userId: pharmacyA, data: {} as never }),
      'PRESCRIPTION_CHECKOUT_UNAVAILABLE', 503);
    await service.reviewPrescription(id, pharmacyA, { decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: RX });
    await service.updateStatus(id, pharmacyA, { status: 'packed' });
    await service.updateStatus(id, pharmacyA, { status: 'out_for_delivery' });
    await service.markPaid(id, { userType: 'pharmacy', pharmacyId: pharmacyA, userId: pharmacyA, data: {} as never });
    await service.updateStatus(id, pharmacyA, { status: 'completed' });
    const o = (await get(id))!;
    assert.equal(o.status, 'completed'); assert.equal(o.paymentStatus, 'paid');
  });

  await check('reject unpaid placed order: rejected, stock released, no refund flag', async () => {
    const id = await seed();
    released.length = 0; notices.length = 0;
    const out = await service.reviewPrescription(id, pharmacyA, { decision: 'reject', ...pharmacist, reason: 'Prescription expired', reviewedPrescriptionUrls: RX });
    assert.equal(out.status, 'rejected'); assert.equal(out.prescriptionStatus, 'rejected');
    const o = (await get(id))!;
    assert.equal(o.prescriptionReview!.refundRequired, false);
    assert.equal(o.prescriptionReview!.reason, 'Prescription expired');
    assert.match(o.notes ?? '', /Prescription rejected by pharmacist: Prescription expired/);
    assert.equal(released.length, 1);
    assert.deepEqual(released[0].items.map(i => (i as { quantity: number }).quantity), [2]);
    assert.deepEqual(notices.sort(), ['notify:status_changed', 'sync:status_changed']);
  });

  await check('reject paid accepted order: cancelled, refundRequired=true, payment status untouched', async () => {
    const id = await seed({ status: 'accepted', paymentStatus: 'paid' });
    await service.reviewPrescription(id, pharmacyA, { decision: 'reject', ...pharmacist, reason: 'Not a valid prescription', reviewedPrescriptionUrls: RX });
    const o = (await get(id))!;
    assert.equal(o.status, 'cancelled'); assert.equal(o.paymentStatus, 'paid');
    assert.equal(o.prescriptionReview!.refundRequired, true);
    assert.equal(o.prescriptionReview!.paymentStatusAtReview, 'paid');
  });

  await check('stock release failure rolls back the rejection', async () => {
    const id = await seed();
    failRelease = true;
    try { await assert.rejects(service.reviewPrescription(id, pharmacyA, { decision: 'reject', ...pharmacist, reason: 'Unreadable', reviewedPrescriptionUrls: RX })); }
    finally { failRelease = false; }
    const o = (await get(id))!;
    assert.equal(o.status, 'placed'); assert.equal(o.prescriptionStatus, 'pending'); assert.equal(o.prescriptionReview, undefined);
  });

  await check('documents differ from what pharmacist reviewed -> refused, nothing written', async () => {
    const id = await seed();
    await rejects(service.reviewPrescription(id, pharmacyA, { decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: [RX[0]] }), 'PRESCRIPTION_CHANGED', 409);
    await rejects(service.reviewPrescription(id, pharmacyA, { decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: [RX[1], RX[0]] }), 'PRESCRIPTION_CHANGED', 409);
    assert.equal((await get(id))!.prescriptionStatus, 'pending');
  });

  await check('other pharmacy, terminal, not-pending, no-document approve and missing reason are refused', async () => {
    const id = await seed();
    await rejects(service.reviewPrescription(id, pharmacyB, { decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: RX }), 'FORBIDDEN', 403);
    const done = await seed({ status: 'cancelled' });
    await rejects(service.reviewPrescription(done, pharmacyA, { decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: RX }), 'ORDER_TERMINAL', 409);
    const plain = await seed({ prescriptionStatus: 'not_required', prescriptionUrls: [] });
    await rejects(service.reviewPrescription(plain, pharmacyA, { decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: [] }), 'PRESCRIPTION_NOT_PENDING', 409);
    const empty = await seed({ prescriptionUrls: [] });
    await rejects(service.reviewPrescription(empty, pharmacyA, { decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: [] }), 'PRESCRIPTION_REQUIRED', 409);
    await rejects(service.reviewPrescription(id, pharmacyA, { decision: 'reject', ...pharmacist, reason: '  ', reviewedPrescriptionUrls: RX }), 'VALIDATION_ERROR', 400);
    await rejects(service.reviewPrescription('nope', pharmacyA, { decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: RX }), 'VALIDATION_ERROR', 400);
    // empty pending order can still be rejected (no prescription supplied)
    const out = await service.reviewPrescription(empty, pharmacyA, { decision: 'reject', ...pharmacist, reason: 'No prescription uploaded', reviewedPrescriptionUrls: [] });
    assert.equal(out.status, 'rejected');
  });

  await check('second review is refused; decision is final', async () => {
    const id = await seed();
    await service.reviewPrescription(id, pharmacyA, { decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: RX });
    await rejects(service.reviewPrescription(id, pharmacyA, { decision: 'reject', ...pharmacist, reason: 'changed mind', reviewedPrescriptionUrls: RX }), 'PRESCRIPTION_NOT_PENDING', 409);
    assert.equal((await get(id))!.prescriptionStatus, 'approved');
  });

  await check('concurrent approve + reject: exactly one wins, state is consistent', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await seed({ status: 'accepted', paymentStatus: 'paid' });
      released.length = 0;
      const results = await Promise.allSettled([
        service.reviewPrescription(id, pharmacyA, { decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: RX }),
        service.reviewPrescription(id, pharmacyA, { decision: 'reject', ...pharmacist, reason: 'Duplicate check', reviewedPrescriptionUrls: RX }),
      ]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      const o = (await get(id))!;
      if (o.prescriptionStatus === 'approved') { assert.equal(o.status, 'accepted'); assert.equal(released.length, 0); }
      else { assert.equal(o.status, 'cancelled'); assert.equal(released.length, 1); assert.equal(o.prescriptionReview!.decision, 'rejected'); }
    }
  });

  await check('payment changing during review is detected (paid between read and write)', async () => {
    const id = await seed({ status: 'placed', paymentStatus: 'pending' });
    const repo = (service as unknown as { orderRepo: PharmacyOrderRepository }).orderRepo;
    const original = repo.findById;
    (repo as unknown as { findById: unknown }).findById = async (x: string) => {
      const row = await original(x);
      await PharmacyOrderModel.updateOne({ _id: x }, { $set: { paymentStatus: 'paid' } });
      return row;
    };
    try {
      await rejects(service.reviewPrescription(id, pharmacyA, { decision: 'reject', ...pharmacist, reason: 'Invalid', reviewedPrescriptionUrls: RX }), 'ORDER_STATE_CHANGED', 409);
    } finally { (repo as unknown as { findById: unknown }).findById = original; }
    assert.equal((await get(id))!.prescriptionStatus, 'pending');
  });

  await check('pharmacy review queue filter and request validation', async () => {
    const rows = await service.getAll({ prescriptionStatus: 'pending' } as never, 1, 100, 'pharmacy', pharmacyA);
    assert.ok(rows.total > 0);
    assert.ok(rows.data.every(o => o.prescriptionStatus === 'pending'));
    assert.equal(orderQuerySchema.validate({ prescriptionStatus: 'pending' }).error, undefined);
    assert.ok(prescriptionReviewSchema.validate({ decision: 'reject', ...pharmacist, reviewedPrescriptionUrls: RX }).error, 'reject needs reason');
    assert.ok(prescriptionReviewSchema.validate({ decision: 'approve', pharmacistName: 'A', pharmacistRegistrationNumber: 'X', reviewedPrescriptionUrls: RX }).error);
    assert.ok(prescriptionReviewSchema.validate({ decision: 'approve', ...pharmacist }).error, 'reviewed documents required');
    assert.equal(prescriptionReviewSchema.validate({ decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: RX }).error, undefined);
  });

  await check('markPaid cannot overwrite a concurrent status advance with its stale read', async () => {
    const id = await seed({ status: 'accepted', paymentMode: 'cash_on_delivery', paymentStatus: 'pending' });
    await service.reviewPrescription(id, pharmacyA, { decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: RX });
    const repo = (service as unknown as { orderRepo: PharmacyOrderRepository }).orderRepo;
    const original = repo.findById;
    (repo as unknown as { findById: unknown }).findById = async (x: string) => {
      const row = await original(x); // markPaid reads 'accepted' ...
      await PharmacyOrderModel.updateOne({ _id: x }, { $set: { status: 'packed' } }); // ... then staff packs it
      return row;
    };
    try {
      await rejects(service.markPaid(id, { userType: 'pharmacy', pharmacyId: pharmacyA, userId: pharmacyA, data: {} as never }), 'ORDER_PAYMENT_STATE_CHANGED', 409);
    } finally { (repo as unknown as { findById: unknown }).findById = original; }
    const o = (await get(id))!;
    assert.equal(o.status, 'packed'); assert.equal(o.paymentStatus, 'pending');
    await service.markPaid(id, { userType: 'pharmacy', pharmacyId: pharmacyA, userId: pharmacyA, data: {} as never }); // retry works
    const after = (await get(id))!;
    assert.equal(after.status, 'packed'); assert.equal(after.paymentStatus, 'paid');
  });

  await check('legacy order with 25 long prescription URLs can be reviewed; evidence is a bounded fingerprint', async () => {
    const many = Array.from({ length: 25 }, (_, i) => 'https://files.example/' + 'x'.repeat(3000) + '/' + i);
    const id = await seed({ status: 'accepted', paymentStatus: 'paid', prescriptionUrls: many });
    await service.reviewPrescription(id, pharmacyA, { decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: many });
    const r = (await get(id))!.prescriptionReview!;
    assert.equal(r.reviewedDocumentCount, 25);
    assert.equal(r.reviewedDocumentSetSha256, prescriptionDocumentSetSha256(many));
    assert.equal(prescriptionReviewSchema.validate({ decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: many }).error, undefined);
  });

  await check('HTTP: review queue filter and review endpoint through real router, auth and Joi', async () => {
    await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(pharmacyA), isActive: true, isVerified: true } as never);
    Container.set(PharmacyOrderService, service);
    const { default: router } = await import('@/modules/pharmacyOrders/routes');
    const { authenticate } = await import('@/modules/middleware/auth');
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/v1/pharmacy-orders', authenticate, router);
    app.use((err: { status?: number; code?: string }, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
      res.status(err.status ?? 500).json({ success: false, code: err.code });
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const token = (pid: string) => jwt.sign({ _id: pid, pharmacyId: pid, userType: 'pharmacy' }, CONFIG.JWT_SECRET_KEY);
      const call = (method: string, path: string, pid: string, body?: unknown) => fetch(`http://127.0.0.1:${port}/api/v1/pharmacy-orders${path}`,
        { method, headers: { authorization: 'Bearer ' + token(pid), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

      await seed({ prescriptionStatus: 'not_required', prescriptionUrls: [] });
      type Page = { data: { prescriptionStatus: string }[]; pagination: { total: number } };
      const list = await (await call('GET', '/?prescriptionStatus=pending&limit=100', pharmacyA)).json() as Page;
      const states = new Set(list.data.map(o => o.prescriptionStatus));
      assert.deepEqual([...states], ['pending'], 'HTTP queue must return only pending prescriptions');
      const all = await (await call('GET', '/?limit=100', pharmacyA)).json() as Page;
      assert.ok(all.pagination.total > list.pagination.total);

      const id = await seed();
      let res = await call('POST', `/${id}/prescription-review`, pharmacyA, { decision: 'reject', ...pharmacist, reviewedPrescriptionUrls: RX });
      assert.equal(res.status, 400); // reason required
      res = await call('POST', `/${id}/prescription-review`, pharmacyB, { decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: RX });
      assert.equal(res.status, 403); // unverified / other pharmacy
      res = await call('POST', `/${id}/prescription-review`, pharmacyA, { decision: 'approve', ...pharmacist, reviewedPrescriptionUrls: RX, prescriptionStatus: 'approved' });
      assert.equal(res.status, 200);
      const body = await res.json() as { message: string; data: { prescriptionStatus: string } };
      assert.equal(body.message, 'Prescription approved'); assert.equal(body.data.prescriptionStatus, 'approved');
    } finally { server.close(); }
  });

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
