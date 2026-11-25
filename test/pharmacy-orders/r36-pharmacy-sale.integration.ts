/**
 * r36 (WQ50, ASSISTED_BOOKING_DESIGN.md §26.19): backend support for the web pharmacy counter sale.
 * - `POST /pharmacy-orders` with `orderType: 'in_store'` takes an optional `requestKey`: once per (pharmacy, key), the same
 *   key and body answer the first order (`replayed: true`), another body 409 IDEMPOTENCY_KEY_REUSED, an abandoned key 409
 *   REQUEST_ABANDONED; `GET …/by-key/:key` and `POST …/by-key/:key/abandon` (this pharmacy's keys only). Without a key,
 *   nothing changes; a key on any other order is still 400 REQUEST_KEY_UNSUPPORTED.
 * - `GET /pharmacy-orders/:id` for a pharmacy: the customer populated and named as the list names it.
 * - `GET /pharmacy-inventory` rows: `medicineId.prescriptionRequired` from the medicine.
 * - `POST /pharmacy-customers/search { search }`: the GET list's answer and guards, the search never in the URL.
 * - The pharmacy's order detail `bill`: the seller's name, address, GST and licence numbers, how and when it was paid; the
 *   lines' batches (batch number, expiry) on the order.
 * Real authenticate + pharmacy order router + order service over HTTP on MongoDB; stock, catalogue and payment are fakes.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/r36_pharmacy_sale_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/pharmacy-orders/r36-pharmacy-sale.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import UserModel from '@/modules/user/model';
import { UserRepository } from '@/modules/user/repository';
import { BookingRepository } from '@/modules/bookings/repository';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import { PharmacyCustomerRepository } from '@/modules/pharmacyCustomers/repository';
import { PharmacyCustomerService } from '@/modules/pharmacyCustomers/services';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import { PrescriptionRefundService } from '@/modules/pharmacyOrders/prescriptionRefund';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { InventoryItemModel } from '@/modules/pharmacyInventory/model';
import { InventoryItemRepository } from '@/modules/pharmacyInventory/repository';
import MedicineModel from '@/modules/pharmacyMedicines/model';
import { errorHandler } from '@/modules/middleware';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r36_pharmacy_sale_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.error('FAIL -', name, '\n  ', (e as Error).message.split('\n')[0]); }
}

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  for (const m of [PharmacyCustomerModel, PharmacyOrderModel, RequestKeyModel]) { await m.createCollection().catch(() => undefined); await m.syncIndexes(); }

  const payments = Object.assign(Object.create(PaymentService.prototype), {
    bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
    walletTransactionRepository: new WalletTransactionRepository(),
    getRazorpayClient: () => ({ orders: { create: async (o: { amount: number; currency: string }) => ({ id: 'order_r36_' + oid(), amount: o.amount, currency: o.currency }),
      fetchPayments: async () => ({ items: [] }) } }),
    getRazorpayCredentials: () => ({ keyId: 'rzp_test_key', keySecret: 'secret' }),
  }) as unknown as PaymentService;
  const pharmacyCustomerService = Object.assign(Object.create(PharmacyCustomerService.prototype), {
    pharmacyCustomerRepo: new PharmacyCustomerRepository(), pharmacyRepo: new PharmacyRepository(), userRepo: new UserRepository(),
  }) as PharmacyCustomerService;
  Container.set(PharmacyCustomerService, pharmacyCustomerService);
  const MED = oid();
  const inventory = {
    getInventoryByMedicine: async () => ({ retailPrice: 50, wholesalePrice: 40 }),
    reserveOrderStockBulk: async (_p: string, items: { medicineId: string; quantity?: number }[]) => new Map(items.map((i) => [String(i.medicineId),
      [{ batchId: new Types.ObjectId(), batchNumber: 'B-R36', expiryDate: '20271231', quantity: 1 }]])),
    returnStockBulk: async () => [], releaseOrderStockBulk: async () => undefined, consumeOrderReservedStockBulk: async () => undefined,
  };
  const medicines = {
    findById: async () => ({ _id: MED, name: 'Vitamin D', isActive: true, prescriptionRequired: false, gstPercent: 0 }),
    findAll: async () => [{ _id: MED, name: 'Vitamin D', isActive: true, prescriptionRequired: false }],
  };
  const sideEffects = { queueNotification: async () => undefined, queueSubscriptionSync: async () => undefined };
  const refunds = new PrescriptionRefundService({ listRefunds: async () => [], fetchRefund: async () => { throw new Error('x'); },
    refund: async () => { throw new Error('x'); } } as never, new WalletRepository());
  Container.set(PharmacyOrderService, new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
    new PharmacyOrderRepository(), pharmacyCustomerService, inventory, payments, new BookingRepository(), {}, sideEffects, medicines, refunds));
  const { default: pharmacyOrderRouter } = await import('@/modules/pharmacyOrders/routes');
  const { default: pharmacyCustomerRouter } = await import('@/modules/pharmacyCustomers/routes');
  const { authenticate } = await import('@/modules/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/pharmacy-orders', authenticate, pharmacyOrderRouter);
  app.use('/api/v1/pharmacy-customers', authenticate, pharmacyCustomerRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;

  try {
    const L = oid();
    await UserModel.collection.insertOne({ _id: new Types.ObjectId(L), userType: 'user', phone: '9600036001', name: 'Asha Kumari', createdSource: 'self_signup' } as never);
    const P = oid(); const Q = oid();
    await PharmacyModel.collection.insertMany([
      { _id: new Types.ObjectId(P), name: 'Counter Pharmacy', phone: '9700036001', isActive: true, isVerified: true, address: '12 Police Bazar',
        city: 'Shillong', state: 'Meghalaya', pincode: '793001', gstNumber: '17ABCDE1234F1Z5', drugLicenseNumber: 'ML-20B-0042' },
      { _id: new Types.ObjectId(Q), name: 'Other Pharmacy', phone: '9700036002', isActive: true, isVerified: true },
    ] as never);
    await PharmacyCustomerModel.collection.insertMany([P, Q].map((ph) => ({ pharmacyId: new Types.ObjectId(ph), userId: new Types.ObjectId(L), consent: 'patient_agreed' })) as never);
    const tokens = {
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), Q: sign({ _id: Q, pharmacyId: Q, userType: 'pharmacy' }),
      L: sign({ _id: L, userType: 'user' }),
    };
    type Who = keyof typeof tokens;
    const call = async (who: Who, method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, { method, headers: { authorization: 'Bearer ' + tokens[who], 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json() as { data?: any; code?: string; message?: string } };
    };
    const expect = async (who: Who, method: string, path: string, status: number, body?: unknown, code?: string) => {
      const r = await call(who, method, path, body);
      assert.equal(r.status, status, `${who} ${method} ${path}: ${r.status} ${JSON.stringify(r.json)}`);
      if (code) assert.equal(r.json.code, code, `${who} ${method} ${path}: ${JSON.stringify(r.json)}`);
      return r;
    };
    const sale = (extra: Record<string, unknown> = {}) => ({ orderType: 'in_store', customerId: L, items: [{ medicineId: MED, orderedQty: 1 }],
      paymentMode: 'in_store_payment', deliveryMode: 'pickup', isWalkIn: false, ...extra });
    const keyed = (key: string) => PharmacyOrderModel.countDocuments({ 'saleRequest.requestKey': key });

    await check('without a key an in-store sale is created as before (no saleRequest); a key on any other order is still 400 REQUEST_KEY_UNSUPPORTED', async () => {
      const r = await expect('P', 'POST', '/pharmacy-orders', 201, sale());
      assert.equal(r.json.data.order.saleRequest, undefined);
      assert.equal(r.json.data.replayed, undefined);
      assert.equal(r.json.data.paymentRequired, false);
      const before = await PharmacyOrderModel.countDocuments();
      await expect('P', 'POST', '/pharmacy-orders', 400, sale({ orderType: 'online', requestKey: 'sale-key-online-01' }), 'REQUEST_KEY_UNSUPPORTED');
      assert.equal(await PharmacyOrderModel.countDocuments(), before, 'nothing written');
    });

    await check('a keyed sale: once per (pharmacy, key); the same body replays the first order, another body 409 IDEMPOTENCY_KEY_REUSED; racing repeats make one order', async () => {
      const first = await expect('P', 'POST', '/pharmacy-orders', 201, sale({ requestKey: 'sale-key-0001' }));
      const order = first.json.data.order;
      assert.equal(order.saleRequest.requestKey, 'sale-key-0001');
      assert.equal(first.json.data.replayed, undefined);
      const again = await expect('P', 'POST', '/pharmacy-orders', 201, sale({ requestKey: 'sale-key-0001' }));
      assert.deepEqual([again.json.data.replayed, again.json.data.order._id, again.json.data.paymentRequired], [true, order._id, false]);
      await expect('P', 'POST', '/pharmacy-orders', 409, sale({ requestKey: 'sale-key-0001', items: [{ medicineId: MED, orderedQty: 2 }] }), 'IDEMPOTENCY_KEY_REUSED');
      assert.equal(await keyed('sale-key-0001'), 1);
      const race = await Promise.all([1, 2, 3].map(() => call('P', 'POST', '/pharmacy-orders', sale({ requestKey: 'sale-key-race' }))));
      assert.ok(race.every((r) => r.status === 201), JSON.stringify(race.map((r) => r.json.code)));
      assert.equal(new Set(race.map((r) => r.json.data.order._id)).size, 1);
      assert.equal(await keyed('sale-key-race'), 1);
      // Another pharmacy's same key is its own.
      await expect('Q', 'POST', '/pharmacy-orders', 201, sale({ requestKey: 'sale-key-0001' }));
      assert.equal(await keyed('sale-key-0001'), 2);
    });

    await check('by-key: used (the order as the pharmacy reads it), unknown, abandoned; an abandoned key never makes a sale; another pharmacy sees only its own keys', async () => {
      const used = (await expect('P', 'GET', '/pharmacy-orders/by-key/sale-key-race', 200)).json.data;
      assert.equal(used.state, 'used');
      assert.equal(String(used.order.saleRequest.requestKey), 'sale-key-race');
      assert.equal(used.order.customerId._id, L, 'the customer populated');
      assert.deepEqual((await expect('Q', 'GET', '/pharmacy-orders/by-key/sale-key-race', 200)).json.data, { state: 'unknown' });
      assert.deepEqual((await expect('P', 'GET', '/pharmacy-orders/by-key/sale-key-lost', 200)).json.data, { state: 'unknown' });
      assert.deepEqual((await expect('P', 'POST', '/pharmacy-orders/by-key/sale-key-lost/abandon', 200)).json.data, { state: 'abandoned' });
      assert.deepEqual((await expect('P', 'GET', '/pharmacy-orders/by-key/sale-key-lost', 200)).json.data, { state: 'abandoned' });
      await expect('P', 'POST', '/pharmacy-orders', 409, sale({ requestKey: 'sale-key-lost' }), 'REQUEST_ABANDONED');
      assert.equal(await keyed('sale-key-lost'), 0);
      // Abandoning a used key answers it (nothing changes); Q abandoning P's key touches only Q's scope.
      assert.equal((await expect('P', 'POST', '/pharmacy-orders/by-key/sale-key-race/abandon', 200)).json.data.state, 'used');
      assert.deepEqual((await expect('Q', 'POST', '/pharmacy-orders/by-key/sale-key-race/abandon', 200)).json.data, { state: 'abandoned' });
      assert.equal((await expect('P', 'GET', '/pharmacy-orders/by-key/sale-key-race', 200)).json.data.state, 'used');
      await expect('P', 'GET', '/pharmacy-orders/by-key/bad', 400);
      await expect('L', 'GET', '/pharmacy-orders/by-key/sale-key-race', 403);
    });

    await check('GET /pharmacy-orders/:id for the pharmacy names the customer as its list does (populated); the customer\'s own read is unchanged', async () => {
      const id = (await expect('P', 'POST', '/pharmacy-orders', 201, sale())).json.data.order._id;
      const one = (await expect('P', 'GET', `/pharmacy-orders/${id}`, 200)).json.data;
      const listed = (await expect('P', 'GET', '/pharmacy-orders?limit=50', 200)).json.data.find((o: any) => o._id === id);
      assert.equal(one.customerId._id, L);
      assert.deepEqual([one.customerId.name, one.customerId.phone], [listed.customerId.name, listed.customerId.phone]);
      assert.notEqual(one.customerId.name, 'Asha Kumari', 'never the account name unless the pharmacy-facing rule shows it');
      assert.equal(typeof (await expect('L', 'GET', `/pharmacy-orders/${id}`, 200)).json.data.customerId, 'string');
      await expect('Q', 'GET', `/pharmacy-orders/${id}`, 403);
      // The bill: the seller and, once paid, how and when; each line's batches are on the order.
      assert.deepEqual(one.bill, { pharmacy: { name: 'Counter Pharmacy', address: '12 Police Bazar', city: 'Shillong', state: 'Meghalaya', pincode: '793001',
        gstNumber: '17ABCDE1234F1Z5', drugLicenseNumber: 'ML-20B-0042' }, paymentMethod: null, paidAt: null });
      assert.deepEqual(one.items.map((l: any) => l.batchAllocations.map((b: any) => [b.batchNumber, b.expiryDate, b.quantity])), [[['B-R36', '20271231', 1]]]);
      const paidAt = new Date();
      await PharmacyOrderModel.updateOne({ _id: id }, { $set: { paymentStatus: 'paid', paymentSource: 'upi', paidAt } });
      const paid = (await expect('P', 'GET', `/pharmacy-orders/${id}`, 200)).json.data.bill;
      assert.deepEqual([paid.paymentMethod, paid.paidAt], ['upi', paidAt.toISOString()]);
      assert.equal((await expect('L', 'GET', `/pharmacy-orders/${id}`, 200)).json.data.bill, undefined, 'the customer\'s read is unchanged');
    });

    await check('POST /pharmacy-customers/search answers as the GET list (same guards); the search stays out of the URL', async () => {
      const viaGet = (await expect('P', 'GET', '/pharmacy-customers?search=9600036001', 200)).json;
      const viaPost = await call('P', 'POST', '/pharmacy-customers/search', { search: '9600036001' });
      assert.equal(viaPost.status, 200);
      assert.deepEqual(viaPost.json, viaGet);
      assert.ok((viaPost.json.data as any[]).length >= 1);
      assert.deepEqual((await expect('P', 'POST', '/pharmacy-customers/search', 200, {})).json, (await expect('P', 'GET', '/pharmacy-customers', 200)).json);
      await expect('L', 'POST', '/pharmacy-customers/search', 403, { search: 'Asha' });
      await expect('P', 'POST', '/pharmacy-customers/search', 400, { search: 'x', limit: 0 });
    });

    await check('GET /pharmacy-inventory rows carry medicineId.prescriptionRequired from the medicine (with and without search)', async () => {
      const rx = new Types.ObjectId(); const plain = new Types.ObjectId();
      await MedicineModel.collection.insertMany([{ _id: rx, name: 'Amoxicillin 500', prescriptionRequired: true },
        { _id: plain, name: 'Vitamin C', prescriptionRequired: false }] as never);
      await InventoryItemModel.collection.insertMany([rx, plain].map((m) => ({ pharmacyId: new Types.ObjectId(P), medicineId: m, availableQty: 5, isActive: true,
        updatedAt: new Date() })) as never);
      const repo = new InventoryItemRepository();
      const flags = (rows: any[]) => Object.fromEntries(rows.map((r) => [String(r.medicineId._id), r.medicineId.prescriptionRequired]));
      assert.deepEqual(flags((await repo.findWithPagination({ pharmacyId: P } as never, 1, 20)).data), { [String(rx)]: true, [String(plain)]: false });
      assert.deepEqual(flags((await repo.findWithPagination({ pharmacyId: P, search: 'amox' } as never, 1, 20)).data), { [String(rx)]: true });
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) { console.log('failed:', failed); process.exit(1); }
  process.exit(0);
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
