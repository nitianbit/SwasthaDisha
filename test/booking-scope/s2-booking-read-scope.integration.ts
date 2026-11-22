/**
 * S2: /api/v1/bookings serves each role only its own bookings. A specialist sees only bookings with its own
 * specialistId, a pharmacy only bookings with its own pharmacyId (paginated or not, whatever the filters), a customer
 * only their own, HR its corporate (unchanged), an admin everything; partner (and any other role) is refused.
 * Real authenticate + booking router + BookingService/repository over HTTP against MongoDB; the gateway is a stub.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/s2_booking_scope_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/booking-scope/s2-booking-read-scope.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import UserModel from '@/modules/user/model';
import BookingModel from '@/modules/bookings/model';
import PharmacyModel from '@/modules/pharmacies/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import { DependentService } from '@/modules/dependents/services';
import { PaymentRepository } from '@/modules/payment/repository';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { errorHandler } from '@/modules/middleware';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/s2_booking_scope_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });

let passed = 0;
const failed: string[] = [];
/** Runs every check (a failure is reported and the next check still runs), so a run without the fix lists each gap. */
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.error('FAIL -', name, '\n  ', (e as Error).message.split('\n')[0]); }
}

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();

  // tsx emits no decorator metadata: the services the controller resolves are wired by hand before the router loads.
  const reconciled: string[] = [];
  const bookingService = Object.assign(Object.create(BookingService.prototype), {
    bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
    walletTransactionRepository: new WalletTransactionRepository(), notificationService: {},
    bookingReminderScheduler: { scheduleBookingReminders: async () => undefined, clearBookingReminders: async () => undefined },
    paymentService: { reconcileBookingPayments: async (id: string) => { reconciled.push(id); return { unknown: 0 }; } },
  }) as BookingService;
  Container.set(BookingService, bookingService);
  Container.set(DependentService, {} as DependentService);
  const { default: bookingRouter } = await import('@/modules/bookings/routes');
  const { authenticate } = await import('@/modules/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/bookings', authenticate, bookingRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/bookings`;

  try {
    // Actors.
    const custA = oid(); const custB = oid();
    await UserModel.collection.insertMany([custA, custB].map((id, i) => ({ _id: new Types.ObjectId(id), userType: 'user', phone: '96000000' + (10 + i) })) as never);
    const specA = oid(); const specB = oid(); const pharmA = oid(); const pharmB = oid(); const corpX = oid();
    // S5 review: the doctors are verified, active accounts (an ineligible doctor reads its bookings without patient details).
    await mongoose.connection.collection('specialists').insertMany([specA, specB].map((id) => ({ _id: new Types.ObjectId(id), name: 'Dr ' + id.slice(-4),
      isActive: true, isVerified: true })));
    // Assisted booking phase 0 (review finding 5): a pharmacy reaches /bookings only while operational, so both are real
    // verified pharmacies.
    await PharmacyModel.collection.insertMany([pharmA, pharmB].map((p, i) => ({ _id: new Types.ObjectId(p), name: 'S2 pharmacy ' + i,
      phone: '970000020' + i, email: `s2-pharmacy-${i}@example.test`, isActive: true, isVerified: true })) as never);
    const tokens = {
      custA: sign({ _id: custA, userType: 'user' }),
      custB: sign({ _id: custB, userType: 'user' }),
      specA: sign({ _id: specA, specialistId: specA, userType: 'specialist' }),
      specB: sign({ _id: specB, specialistId: specB, userType: 'specialist' }),
      pharmA: sign({ _id: pharmA, pharmacyId: pharmA, userType: 'pharmacy' }),
      pharmB: sign({ _id: pharmB, pharmacyId: pharmB, userType: 'pharmacy' }),
      admin: sign({ _id: oid(), userType: 'admin' }),
      hr: sign({ _id: oid(), corporateId: corpX, userType: 'hr' }),
      partner: sign({ _id: oid(), userType: 'partner', partnerId: oid() }),
    };
    type Who = keyof typeof tokens;

    // Bookings (tagged by `notes` so the lists can be compared by name).
    const wpX = oid(); const depX = oid();
    const future = '20991231';
    const rows: Record<string, Record<string, unknown>> = {
      b1: { userId: custA, specialistId: specA, bookingType: 'consultation', status: 'confirmed',
        prescription: { notes: 'private Rx of A' }, report: { url: 'bookings/x/report.pdf' } },
      b2: { userId: custB, specialistId: specB, bookingType: 'consultation', status: 'confirmed', prescription: { notes: 'private Rx of B' } },
      b3: { userId: custA, pharmacyId: pharmA, specialistId: specB, bookingType: 'consultation', status: 'pending' },
      b4: { userId: custB, pharmacyId: pharmB, dependentId: depX, wellnessPackageId: wpX, bookingType: 'package', status: 'confirmed' },
      b5: { userId: custB, corporateId: corpX, wellnessPackageId: wpX, bookingType: 'package', status: 'pending' },
      b6: { userId: custA, pharmacyId: pharmA, bookingType: 'consultation', status: 'cancelled' },
    };
    const ids: Record<string, string> = {};
    for (const [tag, row] of Object.entries(rows)) {
      const { insertedId } = await BookingModel.collection.insertOne({ ...row, notes: tag, bookingDate: future, bookingTime: '10:00',
        paymentStatus: 'pending', price: 100, createdAt: new Date(), updatedAt: new Date() } as never);
      ids[tag] = insertedId.toHexString();
    }
    const tagOf = new Map(Object.entries(ids).map(([t, i]) => [i, t]));

    const call = async (who: Who, method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, { method, headers: { authorization: 'Bearer ' + tokens[who], 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await r.json() as { data?: unknown; code?: string; pagination?: { total: number } };
      return { status: r.status, json };
    };
    const get = (who: Who, path: string) => call(who, 'GET', path);
    const tags = (data: unknown) => (data as { _id: string }[]).map((b) => tagOf.get(String(b._id)) ?? 'unknown:' + b._id).sort();
    const list = async (who: Who, path: string) => {
      const r = await get(who, path);
      assert.equal(r.status, 200, `${who} GET ${path}: ${JSON.stringify(r.json)}`);
      return tags(r.json.data);
    };
    const status = async (who: Who, method: string, path: string, expected: number, body?: unknown) => {
      const r = await call(who, method, path, body);
      assert.equal(r.status, expected, `${who} ${method} ${path}: ${r.status} ${JSON.stringify(r.json)}`);
      return r;
    };
    /**
     * A partner token is refused: 403 FORBIDDEN by the router's role gate. (Where authenticate itself admits partner
     * tokens only for a live membership, as on the stage branch, this fixture token stops there with 401
     * PARTNER_MEMBER_REVOKED; either way nothing is served.)
     */
    const refusedPartner = async (method: string, path: string, body?: unknown) => {
      const r = await call('partner', method, path, body);
      const ok = (r.status === 403 && r.json.code === 'FORBIDDEN') || (r.status === 401 && r.json.code === 'PARTNER_MEMBER_REVOKED');
      assert.ok(ok, `partner ${method} ${path}: ${r.status} ${JSON.stringify(r.json)}`);
    };

    await check('GET /:id - a doctor reads only bookings with its own specialistId (uniform 404 otherwise)', async () => {
      const own = await status('specA', 'GET', '/' + ids.b1, 200);
      assert.equal((own.json.data as { prescription: { notes: string } }).prescription.notes, 'private Rx of A');
      for (const b of ['b2', 'b3', 'b4', 'b5', 'b6']) {
        const r = await status('specA', 'GET', '/' + ids[b], 404);
        assert.equal(r.json.code, 'BOOKING_NOT_FOUND');
        assert.equal(JSON.stringify(r.json).includes('private Rx'), false);
      }
      await status('specA', 'GET', `/${ids.b2}?userId=${custB}`, 404);
      await status('specA', 'GET', '/' + oid(), 404); // missing and not-yours look the same
      await status('specB', 'GET', '/' + ids.b2, 200);
      await status('specB', 'GET', '/' + ids.b3, 200);
      await status('specB', 'GET', '/' + ids.b1, 404);
    });

    await check('GET /:id - a pharmacy reads only bookings with its own pharmacyId', async () => {
      await status('pharmA', 'GET', '/' + ids.b3, 200);
      await status('pharmA', 'GET', '/' + ids.b6, 200);
      for (const b of ['b1', 'b2', 'b4', 'b5']) assert.equal((await status('pharmA', 'GET', '/' + ids[b], 404)).json.code, 'BOOKING_NOT_FOUND');
      await status('pharmB', 'GET', '/' + ids.b4, 200);
      await status('pharmB', 'GET', '/' + ids.b3, 404);
    });

    await check('GET /:id - customer own only, admin everything, HR its corporate (403 otherwise), partner refused', async () => {
      await status('custA', 'GET', '/' + ids.b1, 200);
      await status('custA', 'GET', '/' + ids.b2, 404);
      await status('custA', 'GET', `/${ids.b2}?userId=${custB}`, 403);
      for (const b of Object.keys(ids)) await status('admin', 'GET', '/' + ids[b], 200);
      await status('hr', 'GET', '/' + ids.b5, 200);
      await status('hr', 'GET', '/' + ids.b1, 403);
      await refusedPartner('GET', '/' + ids.b1);
    });

    await check('GET /user/:userId - a doctor or pharmacy gets only its own bookings of that customer', async () => {
      assert.deepEqual(await list('specA', '/user/' + custB), []);
      assert.deepEqual(await list('specA', '/user/' + custA), ['b1']);
      assert.deepEqual(await list('specB', '/user/' + custA), ['b3']);
      assert.deepEqual(await list('pharmA', '/user/' + custA), ['b3', 'b6']);
      assert.deepEqual(await list('pharmA', '/user/' + custB), []);
      assert.deepEqual(await list('pharmB', '/user/' + custB), ['b4']);
    });

    await check('GET /user/:userId - customer own only, admin everything, HR its corporate, partner refused', async () => {
      assert.deepEqual(await list('custA', '/user/' + custA), ['b1', 'b3', 'b6']);
      await status('custA', 'GET', '/user/' + custB, 403);
      assert.deepEqual(await list('admin', '/user/' + custB), ['b2', 'b4', 'b5']);
      assert.deepEqual(await list('hr', '/user/' + custB), ['b5']);
      await refusedPartner('GET', '/user/' + custB);
    });

    await check('GET / - a pharmacy lists only its own bookings, paginated and unpaginated, whatever the filters', async () => {
      assert.deepEqual(await list('pharmA', ''), ['b3', 'b6']);
      const paged = await get('pharmA', '?page=1&limit=50');
      assert.equal(paged.status, 200);
      assert.deepEqual(tags(paged.json.data), ['b3', 'b6']);
      assert.equal(paged.json.pagination?.total, 2);
      const firstPage = await get('pharmA', '?page=1&limit=1');
      assert.equal((firstPage.json.data as unknown[]).length, 1);
      assert.equal(firstPage.json.pagination?.total, 2);
      for (const q of [`?specialistId=${specB}`, `?specialistId=${specB}&page=1&limit=10`]) assert.deepEqual(await list('pharmA', q), ['b3']);
      for (const q of [`?specialistId=${specA}`, `?dependentId=${depX}`, `?wellnessPackageId=${wpX}`,
        `?userId=${custB}`, `?corporateId=${corpX}`, `?specialistId=${specA}&page=1&limit=10`, `?wellnessPackageId=${wpX}&page=1&limit=10`,
        `?dependentId=${depX}&page=1&limit=10`, `?userId=${custB}&page=1&limit=10`]) {
        assert.deepEqual(await list('pharmA', q), [], 'pharmacy filter ' + q);
      }
      // A pharmacy's ?pharmacyId= is replaced by its own (as before).
      for (const q of [`?pharmacyId=${pharmB}`, `?pharmacyId=${pharmB}&page=1&limit=10`]) assert.deepEqual(await list('pharmA', q), ['b3', 'b6']);
      assert.deepEqual(await list('pharmA', '?status=cancelled'), ['b6']);
      assert.deepEqual(await list('pharmA', `?userId=${custA}&page=1&limit=10`), ['b3', 'b6']);
      assert.deepEqual(await list('pharmB', '?page=1&limit=10'), ['b4']);
      assert.deepEqual(await list('pharmB', `?wellnessPackageId=${wpX}`), ['b4']);
    });

    await check('GET / - a doctor lists only bookings with its own specialistId, whatever the filters', async () => {
      assert.deepEqual(await list('specA', ''), ['b1']);
      assert.deepEqual(await list('specA', '?page=1&limit=10'), ['b1']);
      for (const q of [`?specialistId=${specB}`, `?specialistId=${specB}&page=1&limit=10`, `?userId=${custB}`, `?pharmacyId=${pharmA}`,
        `?wellnessPackageId=${wpX}`, `?dependentId=${depX}`, `?dependentId=${depX}&page=1&limit=10`]) {
        assert.deepEqual(await list('specA', q), [], 'specialist filter ' + q);
      }
      assert.deepEqual(await list('specB', ''), ['b2', 'b3']);
      assert.deepEqual(await list('specB', `?pharmacyId=${pharmA}`), ['b3']);
    });

    await check('GET / - customer own only, admin everything, HR its corporate (unchanged), partner refused', async () => {
      assert.deepEqual(await list('custA', `?userId=${custB}`), ['b1', 'b3', 'b6']);
      assert.deepEqual(await list('custA', '?page=1&limit=10'), ['b1', 'b3', 'b6']);
      assert.deepEqual(await list('admin', ''), ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
      assert.equal((await get('admin', '?page=1&limit=50')).json.pagination?.total, 6);
      assert.deepEqual(await list('admin', `?specialistId=${specB}`), ['b2', 'b3']);
      assert.deepEqual(await list('hr', ''), ['b5']);
      assert.deepEqual(await list('hr', '?page=1&limit=10'), ['b5']);
      await status('hr', 'GET', `?corporateId=${oid()}`, 403);
      await refusedPartner('GET', '');
      await refusedPartner('GET', '?page=1&limit=10');
    });

    await check('GET /upcoming - unchanged for every allowed role; partner refused', async () => {
      assert.deepEqual(await list('custA', '/upcoming'), ['b1', 'b3']);
      assert.deepEqual(await list('specA', '/upcoming'), []);
      assert.deepEqual(await list('pharmA', '/upcoming'), []);
      assert.deepEqual(await list('hr', '/upcoming'), ['b5']);
      await refusedPartner('GET', '/upcoming');
    });

    await check('GET /:id/payment-details - not-yours is 404 for a doctor or pharmacy; owners keep access', async () => {
      await status('specA', 'GET', `/${ids.b2}/payment-details`, 404);
      await status('pharmA', 'GET', `/${ids.b4}/payment-details`, 404);
      await status('pharmA', 'GET', `/${ids.b1}/payment-details`, 404);
      await status('pharmA', 'GET', `/${ids.b3}/payment-details`, 200);
      await status('custA', 'GET', `/${ids.b1}/payment-details`, 200);
      await status('admin', 'GET', `/${ids.b2}/payment-details`, 200);
      await status('hr', 'GET', `/${ids.b5}/payment-details`, 200);
      await status('hr', 'GET', `/${ids.b1}/payment-details`, 403);
      await refusedPartner('GET', `/${ids.b1}/payment-details`);
    });

    await check('writes - a doctor or pharmacy cannot act on bookings that are not its own; partner refused', async () => {
      const before = JSON.stringify(await BookingModel.find().sort({ _id: 1 }).lean());
      // Generic edit and delete: customers and admins only (unchanged).
      await status('specA', 'PUT', '/' + ids.b2, 403, { notes: 'x' });
      await status('pharmA', 'PUT', '/' + ids.b4, 403, { notes: 'x' });
      await status('specA', 'DELETE', '/' + ids.b2, 403);
      // Cancel / reschedule of someone else's booking (unchanged on main: a non-admin acts only on bookings it owns as
      // the customer, so a pharmacy cannot cancel even its own pharmacy-assisted booking b3 here).
      for (const [who, b] of [['specA', 'b2'], ['specA', 'b3'], ['pharmA', 'b4'], ['pharmB', 'b3']] as [Who, string][]) {
        await status(who, 'POST', `/${ids[b]}/cancel`, 404, { cancellationReason: 'x' });
        await status(who, 'POST', `/${ids[b]}/reschedule`, 404, { slotId: oid() });
      }
      // Retry / reconcile: someone else's booking is 404 for a doctor or pharmacy.
      for (const [who, b] of [['specA', 'b2'], ['pharmA', 'b4'], ['pharmA', 'b1'], ['pharmB', 'b3']] as [Who, string][]) {
        await status(who, 'POST', `/${ids[b]}/retry-payment`, 404, {});
        await status(who, 'POST', `/${ids[b]}/reconcile-payments`, 404);
      }
      assert.deepEqual(reconciled, []);
      for (const [method, path, body] of [['POST', `/${ids.b1}/cancel`, {}], ['POST', `/${ids.b1}/reschedule`, { slotId: oid() }],
        ['POST', `/${ids.b1}/retry-payment`, {}], ['POST', `/${ids.b1}/reconcile-payments`, undefined], ['PUT', '/' + ids.b1, { notes: 'x' }],
        ['DELETE', '/' + ids.b1, undefined], ['POST', '/specialist', {}], ['POST', '/', {}]] as [string, string, unknown][]) {
        await refusedPartner(method, path, body);
      }
      assert.equal(JSON.stringify(await BookingModel.find().sort({ _id: 1 }).lean()), before, 'no booking changed');
    });

    await check('writes - the owning pharmacy still reaches retry and reconcile of its own booking', async () => {
      // Past the access check: a cancelled booking is refused for its state, not for its owner.
      assert.equal((await status('pharmA', 'POST', `/${ids.b6}/retry-payment`, 400, {})).json.code, 'BOOKING_CANCELLED');
      await status('pharmA', 'POST', `/${ids.b3}/reconcile-payments`, 200);
      assert.deepEqual(reconciled, [ids.b3]);
      await status('custA', 'POST', `/${ids.b1}/reconcile-payments`, 200);
      await status('admin', 'POST', `/${ids.b2}/reconcile-payments`, 200);
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`${passed} checks passed, ${failed.length} failed`);
  if (failed.length) throw new Error('S2 checks failed: ' + failed.join('; '));
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
