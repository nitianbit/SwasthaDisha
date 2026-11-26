/**
 * r37 (ASSISTED_BOOKING_DESIGN.md §26.20): the pharmacy's Today register and its to-dos.
 * - GET /pharmacy-assisted/today?date: one India day's pharmacy orders, consultations, lab tests and wallet top-ups, oldest
 *   first (cursor pages), with the pharmacy-facing names; the day's money by method and what is unpaid (top-ups and ended
 *   rows not counted); the waiting work; another pharmacy's and another day's rows never.
 * - /pharmacy-assisted/todos: create once per key, list, edit on the version, delete; another pharmacy's to-dos are the
 *   one 404.
 * Real authenticate + the pharmacy-assisted router over HTTP on MongoDB.
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only MONGODB_URL='mongodb://127.0.0.1:27917/r37_pharmacy_today_check?directConnection=true' \
 *     npx tsx test/assisted/r37-pharmacy-today.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import UserModel from '@/modules/user/model';
import PharmacyModel from '@/modules/pharmacies/model';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import BookingModel from '@/modules/bookings/model';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { InventoryItemModel } from '@/modules/pharmacyInventory/model';
import { TodoModel } from '@/modules/todos/model';
import { paymentMethodOf } from '@/modules/pharmacyOrders/paymentMethod';
import { errorHandler } from '@/modules/middleware';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r37_pharmacy_today_check?directConnection=true';
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
  await TodoModel.createCollection().catch(() => undefined);
  await TodoModel.syncIndexes();
  process.env.ASSISTED_BOOKING_ENABLED_PHARMACY = 'true';
  Container.set(PharmacyOrderService, new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
    new PharmacyOrderRepository(), {}, {}, {}, {}, {}, {}, {}, {}));
  const { pharmacyAssistedRouter } = await import('@/modules/assisted/routes/phase1a');
  const { authenticate } = await import('@/modules/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/pharmacy-assisted', authenticate, pharmacyAssistedRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/pharmacy-assisted`;

  try {
    const P = oid(); const Q = oid(); const L = oid();
    await PharmacyModel.collection.insertMany([
      { _id: new Types.ObjectId(P), name: 'Demo Pharmacy', phone: '9700037001', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(Q), name: 'Other Pharmacy', phone: '9700037002', isActive: true, isVerified: true },
    ] as never);
    await UserModel.collection.insertOne({ _id: new Types.ObjectId(L), userType: 'user', phone: '9600037001', name: 'Asha Kumari Devi', createdSource: 'self_signup' } as never);
    await PharmacyCustomerModel.collection.insertOne({ pharmacyId: new Types.ObjectId(P), userId: new Types.ObjectId(L), consent: 'patient_agreed', typedName: 'Asha' } as never);
    const tokens = { P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), Q: sign({ _id: Q, pharmacyId: Q, userType: 'pharmacy' }) };
    type Who = keyof typeof tokens;
    const call = async (who: Who, method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, { method, headers: { authorization: 'Bearer ' + tokens[who], 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, headers: r.headers, json: await r.json() as { data?: any; code?: string; pagination?: any } };
    };
    const expect = async (who: Who, method: string, path: string, status: number, body?: unknown, code?: string) => {
      const r = await call(who, method, path, body);
      assert.equal(r.status, status, `${who} ${method} ${path}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
      if (code) assert.equal(r.json.code, code);
      return r;
    };

    const DAY = '2026-11-20';
    const at = (hm: string) => new Date(`${DAY}T${hm}:00+05:30`);
    const order = (x: Record<string, unknown>) => ({ orderNumber: `ORD-${oid().slice(-6)}`, pharmacyId: new Types.ObjectId(P), orderType: 'in_store', status: 'placed',
      items: [{ medicineName: 'Dolo 650', orderedQty: 1 }, { medicineName: 'ORS', orderedQty: 2 }], grandTotal: 320, grandTotalPaise: 32_000, paymentMode: 'in_store_payment',
      paymentStatus: 'pending', prescriptionStatus: 'not_required', ...x });
    const ids = await PharmacyOrderModel.collection.insertMany([
      order({ customerId: new Types.ObjectId(L), paymentStatus: 'paid', paymentSource: 'cash', status: 'accepted', createdAt: at('10:40'), updatedAt: at('10:40') }),
      order({ paymentStatus: 'paid', paymentSource: 'UPI', grandTotalPaise: 15_000, status: 'completed', createdAt: at('11:00'), updatedAt: at('11:00') }),
      order({ grandTotalPaise: 9000, createdAt: at('12:00'), updatedAt: at('12:00') }), // unpaid counter sale
      order({ orderType: 'online', paymentMode: 'online_payment', paymentStatus: 'paid', grandTotalPaise: 50_000, createdAt: at('13:00'), updatedAt: at('13:00') }),
      order({ status: 'cancelled', grandTotalPaise: 7000, createdAt: at('14:00'), updatedAt: at('14:00') }), // ended: not unpaid
      order({ paymentStatus: 'paid', paymentSource: 'Paytm', grandTotalPaise: 1000, createdAt: at('15:00'), updatedAt: at('15:00') }), // other
      order({ prescriptionStatus: 'pending', grandTotalPaise: 2000, createdAt: new Date(`2026-11-19T22:00:00+05:30`), updatedAt: new Date() }), // the day before
      order({ pharmacyId: new Types.ObjectId(Q), paymentStatus: 'paid', paymentSource: 'cash', createdAt: at('10:00'), updatedAt: at('10:00') }), // another pharmacy
    ] as never);
    const orderIds = Object.values(ids.insertedIds).map(String);
    const booking = await BookingModel.collection.insertOne({ pharmacyId: P, userId: L, specialistId: oid(), doctorName: 'Dr Kavya', bookingKind: 'scheduled',
      consultationMode: 'video', bookingDate: '20261120', bookingTime: '11:30', status: 'confirmed', paymentStatus: 'paid', price: 500, createdAt: at('10:05'), updatedAt: at('10:05'),
      assisted: { shortRef: 'JS-4K7Q', bookedBy: { kind: 'pharmacy', id: P, name: 'Demo Pharmacy' }, funding: { method: 'wallet', state: 'debited' } } } as never);
    await BookingModel.collection.insertOne({ pharmacyId: P, userId: L, specialistId: oid(), doctorName: 'Dr Ravi', bookingKind: 'scheduled', consultationMode: 'in_person',
      bookingDate: '20261121', bookingTime: '09:00', status: 'pending', paymentStatus: 'pending', price: 300, createdAt: at('16:00'), updatedAt: at('16:00'),
      assisted: { shortRef: 'JS-8M2P', bookedBy: { kind: 'pharmacy', id: P, name: 'Demo Pharmacy' }, funding: { method: 'razorpay', state: 'pending' } } } as never);
    const lab = await PartnerLabBookingModel.collection.insertOne({ partnerId: oid(), branchId: oid(), userId: L, visitMode: 'in_lab', status: 'report_ready', statusVersion: 0,
      paymentStatus: 'paid', pricing: { subtotalMinor: 120_000, discountMinor: 0, payableMinor: 120_000, commissionMinor: 0, currency: 'INR' }, items: [{ name: 'CBC', kind: 'test' },
        { name: 'Lipid profile', kind: 'test' }], slot: { date: DAY }, createdAt: at('10:20'), updatedAt: at('10:20'),
      assisted: { shortRef: 'JS-LAB1', bookedBy: { kind: 'pharmacy', id: P, name: 'Demo Pharmacy' }, funding: { method: 'razorpay', state: 'captured' } } } as never);
    await PharmacyWalletTransactionModel.collection.insertOne({ pharmacyId: new Types.ObjectId(P), walletId: oid(), transactionType: 'credit', amount: 1000, amountPaise: 100_000,
      balanceBefore: 0, balanceAfter: 1000, status: 'completed', referenceType: 'wallet_recharge', referenceId: oid(), description: 'Wallet recharge', transactionDate: '20261120',
      createdAt: at('09:00'), updatedAt: at('09:00') } as never);
    await InventoryItemModel.collection.insertOne({ pharmacyId: new Types.ObjectId(P), medicineId: new Types.ObjectId(), availableQty: 0, reservedQty: 0, freeQty: 0,
      reorderThreshold: 5, isActive: true, batches: [], updatedAt: new Date() } as never);

    await check('the one payment method helper: cash and UPI known, an online order online, anything else other', async () => {
      assert.deepEqual(['cash', ' UPI ', 'Paytm', 'in_store_payment', undefined].map((s) => paymentMethodOf(s, 'in_store_payment')), ['cash', 'upi', 'other', 'other', 'other']);
      assert.equal(paymentMethodOf(undefined, 'online_payment'), 'online');
    });

    await check('GET /today?date: the day oldest first across orders, consultations, lab tests and top-ups; names by the pharmacy-facing rule; another pharmacy\'s and another day\'s rows never', async () => {
      const r = await expect('P', 'GET', `/today?date=${DAY}`, 200);
      assert.equal(r.headers.get('cache-control'), 'private, no-store');
      const d = r.json.data;
      assert.equal(d.date, DAY);
      assert.deepEqual(d.items.map((i: any) => [i.kind, new Date(i.at).toISOString().slice(11, 16)]), [
        ['wallet_topup', '03:30'], ['consultation', '04:35'], ['lab_booking', '04:50'], ['order', '05:10'], ['order', '05:30'], ['order', '06:30'],
        ['order', '07:30'], ['order', '08:30'], ['order', '09:30'], ['consultation', '10:30']]);
      const byKind = (k: string) => d.items.filter((i: any) => i.kind === k);
      assert.deepEqual(Object.keys(d.items[0]).sort(), ['amountMinor', 'at', 'id', 'kind', 'link', 'method', 'paid', 'patientName', 'shortRef', 'status', 'what']);
      const cash = byKind('order')[0];
      assert.deepEqual([cash.id, cash.patientName, cash.what, cash.amountMinor, cash.paid, cash.method, cash.link], [orderIds[0], 'Asha', 'Dolo 650 +1 more', 32_000, true, 'cash',
        { kind: 'pharmacy_order', id: orderIds[0] }]);
      const consult = byKind('consultation')[0];
      assert.deepEqual([consult.id, consult.shortRef, consult.what, consult.amountMinor, consult.paid, consult.method, consult.link.kind],
        [String(booking.insertedId), 'JS-4K7Q', 'Dr Kavya · 11:30 · video', 50_000, true, 'wallet', 'booking']);
      const l = byKind('lab_booking')[0];
      assert.deepEqual([l.id, l.shortRef, l.what, l.amountMinor, l.method, l.status], [String(lab.insertedId), 'JS-LAB1', 'CBC +1 more', 120_000, 'card', 'report_ready']);
      assert.deepEqual([byKind('wallet_topup')[0].amountMinor, byKind('wallet_topup')[0].method, byKind('wallet_topup')[0].what], [100_000, 'online', 'Wallet top-up']);
      assert.ok(!d.items.some((i: any) => i.id === orderIds[6] || i.id === orderIds[7]), 'the day before and another pharmacy are not listed');
      // The day's money: paid rows by method; unpaid live rows (the 12:00 sale ₹90, the pending booking ₹300); the top-up
      // and the cancelled sale do not count.
      assert.deepEqual(d.totals, { collectedMinor: 32_000 + 15_000 + 50_000 + 1000 + 50_000 + 120_000,
        byMethod: { cash: 32_000, upi: 15_000, card: 120_000, wallet: 50_000, online: 50_000, other: 1000 }, unpaidMinor: 9000 + 30_000, count: 10 });
      assert.equal(d.nextCursor, null);
      // Waiting work (any day).
      assert.deepEqual([d.pending.prescriptionsToReview.count, d.pending.prescriptionsToReview.ids], [1, [orderIds[6]]]);
      assert.deepEqual(d.pending.unpaidCounterSales.ids.sort(), [orderIds[2], orderIds[6]].sort());
      assert.equal(d.pending.bookingsAwaiting.count, 1);
      assert.deepEqual([d.pending.labReportsReady.count, d.pending.labReportsReady.ids], [1, [String(lab.insertedId)]]);
      assert.equal(d.pending.lowStock.count, 1);
      // Another pharmacy sees only its own.
      const q = (await expect('Q', 'GET', `/today?date=${DAY}`, 200)).json.data;
      assert.deepEqual([q.items.length, q.items[0].id, q.totals.collectedMinor], [1, orderIds[7], 32_000]);
    });

    await check('GET /today pages by cursor (totals and pending on the first page; the waiting work only there); bad date or cursor 400; an empty day', async () => {
      const p1 = (await expect('P', 'GET', `/today?date=${DAY}&limit=4`, 200)).json.data;
      assert.equal(p1.items.length, 4);
      assert.ok(p1.nextCursor && p1.pending);
      const p2 = (await expect('P', 'GET', `/today?date=${DAY}&limit=4&cursor=${p1.nextCursor}`, 200)).json.data;
      const p3 = (await expect('P', 'GET', `/today?date=${DAY}&limit=4&cursor=${p2.nextCursor}`, 200)).json.data;
      assert.deepEqual([p2.items.length, p3.items.length, p3.nextCursor, p2.pending], [4, 2, null, undefined]);
      assert.deepEqual(new Set([...p1.items, ...p2.items, ...p3.items].map((i: any) => i.id)).size, 10);
      assert.deepEqual(p2.totals, p1.totals);
      await expect('P', 'GET', '/today?date=2026-02-30', 400, undefined, 'INVALID_DATE');
      await expect('P', 'GET', '/today?cursor=nope', 400);
      const empty = (await expect('P', 'GET', '/today?date=2026-01-01', 200)).json.data;
      assert.deepEqual([empty.items, empty.totals.count, empty.totals.collectedMinor], [[], 0, 0]);
      assert.ok((await expect('P', 'GET', '/today', 200)).json.data.date, 'today by default');
    });

    await check('to-dos: once per key (replay 200, another text 409), shared within the pharmacy with createdBy; edits fenced on the version; delete; another pharmacy 404', async () => {
      const c1 = await expect('P', 'POST', '/todos', 201, { text: 'Call supplier for Dolo 650', requestKey: 'todo-key-0001' });
      const t = c1.json.data.todo;
      assert.deepEqual([t.text, t.done, t.version, t.createdBy.name, t.dueAt], ['Call supplier for Dolo 650', false, 0, 'Demo Pharmacy', null]);
      assert.equal(c1.headers.get('cache-control'), 'private, no-store');
      const again = await expect('P', 'POST', '/todos', 200, { text: 'Call supplier for Dolo 650', requestKey: 'todo-key-0001' });
      assert.deepEqual([again.json.data.replayed, again.json.data.todo._id], [true, t._id]);
      await expect('P', 'POST', '/todos', 409, { text: 'Something else', requestKey: 'todo-key-0001' }, 'IDEMPOTENCY_KEY_REUSED');
      await expect('P', 'POST', '/todos', 201, { text: 'Order ORS', dueAt: '2026-11-21T10:00:00.000Z', requestKey: 'todo-key-0002' });
      await expect('P', 'POST', '/todos', 400, { text: 'x'.repeat(201), requestKey: 'todo-key-0003' });
      const list = (await expect('P', 'GET', '/todos', 200)).json;
      assert.deepEqual(list.data.map((x: any) => x.text), ['Order ORS', 'Call supplier for Dolo 650']);
      assert.equal(list.data[0].dueAt, '2026-11-21T10:00:00.000Z');
      const done = (await expect('P', 'PATCH', `/todos/${t._id}`, 200, { done: true, expectedVersion: 0 })).json.data;
      assert.deepEqual([done.done, done.version, typeof done.doneAt], [true, 1, 'string']);
      await expect('P', 'PATCH', `/todos/${t._id}`, 409, { text: 'stale', expectedVersion: 0 }, 'TODO_CHANGED');
      await expect('P', 'PATCH', `/todos/${t._id}`, 400, { expectedVersion: 1 });
      assert.deepEqual((await expect('P', 'GET', '/todos?done=false', 200)).json.data.map((x: any) => x.text), ['Order ORS']);
      // Another pharmacy: its own empty list; this pharmacy's to-do is the one 404.
      assert.deepEqual((await expect('Q', 'GET', '/todos', 200)).json.data, []);
      await expect('Q', 'PATCH', `/todos/${t._id}`, 404, { done: false, expectedVersion: 1 }, 'TODO_NOT_FOUND');
      await expect('Q', 'DELETE', `/todos/${t._id}`, 404, undefined, 'TODO_NOT_FOUND');
      assert.deepEqual((await expect('P', 'DELETE', `/todos/${t._id}`, 200)).json.data, { deleted: true });
      await expect('P', 'DELETE', `/todos/${t._id}`, 404, undefined, 'TODO_NOT_FOUND');
      assert.equal(await TodoModel.countDocuments({ 'owner.id': P.toLowerCase() }), 1);
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
