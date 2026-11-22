/**
 * Assisted booking phase 0 (ASSISTED_BOOKING_DESIGN.md §17.2, §9, §13 row 0): the booking pharmacy's list and the booker
 * view (typed patient name, doctor, date, status, prescription medicines / advice / tests, never the diagnosis), the
 * dispensing copy (D15) as the only prescription file a pharmacy reads, within 90 days of the consultation (H), the full
 * PDF refused to the pharmacy, "create medicine order" from the prescription (key + hash, S3 consented link, server
 * binding that expires after 90 days unless dispensed, N12), and S2/S3 still holding.
 * Real authenticate + booking / pharmacy-bookings / pharmacy-orders / specialists / request-keys routers and the static
 * file route over HTTP against MongoDB; the payment gateway, stock and catalogue are stubs. wkhtmltopdf is replaced by a
 * script that copies the HTML it is given (WKHTMLTOPDF_BINARY), so the "PDF" content can be read back.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/assisted_phase0_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/assisted/phase0.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import UserModel from '@/modules/user/model';
import { UserRepository } from '@/modules/user/repository';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import SlotModel from '@/modules/slots/model';
import DependentModel from '@/modules/dependents/model';
import { DependentRepository } from '@/modules/dependents/repository';
import { DependentService } from '@/modules/dependents/services';
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
import SpecialistModel from '@/modules/specialists/model';
import { SpecialistService } from '@/modules/specialists/services';
import { SpecialistPortalService } from '@/modules/specialistPortal/services';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { FileGrantModel, FileUploadModel } from '@/modules/file/model/access';
import { errorHandler } from '@/modules/middleware';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/assisted_phase0_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
const DAY = 86_400_000;
/** India calendar day `days` ago, YYYYMMDD. */
const istDay = (days: number) => new Date(Date.now() + 330 * 60_000 - days * DAY).toISOString().slice(0, 10).replace(/-/g, '');
/** 10:15 India time on that day (the slot end used below). */
const slotEndOf = (yyyymmdd: string) => new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T10:15:00+05:30`);

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.error('FAIL -', name, '\n  ', (e as Error).message.split('\n')[0]); }
}

// The test's own upload directory and a converter stand-in (copies its HTML input to the PDF path; fails on demand).
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assisted-phase0-')));
const UPLOAD = path.join(WORK, 'files');
const FAIL_MARK = path.join(WORK, 'converter-fails');
/** While this file exists the converter takes its content (seconds) before it writes. */
const SLOW_MARK = path.join(WORK, 'converter-slow');
fs.mkdirSync(UPLOAD);
const CONVERTER = path.join(WORK, 'fake-wkhtmltopdf.sh');
fs.writeFileSync(CONVERTER, `#!/bin/sh\n[ -f '${FAIL_MARK}' ] && exit 3\n[ -f '${SLOW_MARK}' ] && sleep "$(cat '${SLOW_MARK}')"\ncp "$1" "$2"\n`, { mode: 0o755 });
process.env.WKHTMLTOPDF_BINARY = CONVERTER;
(CONFIG as { UPLOAD_DIR: string }).UPLOAD_DIR = UPLOAD;

const fakeRazorpay = {
  orders: { create: async (o: { amount: number; currency: string }) => ({ id: 'order_p0_' + oid(), amount: o.amount, currency: o.currency, status: 'created' }),
    fetchPayments: async () => ({ items: [] }) },
  payments: { fetch: async () => { throw new Error('not used'); } },
};

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  for (const m of [BookingModel, PharmacyCustomerModel, PharmacyOrderModel, RequestKeyModel, FileGrantModel, FileUploadModel]) {
    await (m as mongoose.Model<any>).createCollection(); await (m as mongoose.Model<any>).syncIndexes();
  }
  await mongoose.connection.db!.createCollection('assisted_audit_events').catch(() => undefined);

  // tsx emits no decorator metadata: the services the controllers resolve are wired by hand before the routers load.
  const payments = Object.assign(Object.create(PaymentService.prototype), {
    bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
    walletTransactionRepository: new WalletTransactionRepository(), bookingReminderScheduler: { scheduleBookingReminders: async () => undefined },
    sendPaidBookingEmailNotification: async () => undefined,
    finalizePaymentProcessing: async (r: { _id: unknown }) => {
      await PaymentRecordModel.updateOne({ _id: r._id }, { $set: { isProcessed: true } });
      return PaymentRecordModel.findById(r._id).lean();
    },
    getRazorpayClient: () => fakeRazorpay,
    getRazorpayCredentials: () => ({ keyId: 'rzp_test_key', keySecret: 'secret' }),
  }) as unknown as PaymentService & Record<string, unknown>;
  const bookingService = Object.assign(Object.create(BookingService.prototype), {
    bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
    walletTransactionRepository: new WalletTransactionRepository(), userRepository: new UserRepository(),
    notificationService: { createBookingCreatedNotification: async () => undefined, createSpecialistNewBookingNotification: async () => undefined },
    paymentService: payments, couponService: {}, emailService: {},
    bookingReminderScheduler: { scheduleBookingReminders: async () => undefined, clearBookingReminders: async () => undefined },
    sendPaidBookingEmailNotification: async () => undefined,
    // Stage merge (S5): a bookable doctor is verified and active.
    specialistService: { getById: async (id: string) => ({ _id: id, name: 'Dr Asha Menon', isActive: true, isVerified: true, consultationFee: 100 }) },
    slotService: { getById: async (id: string) => SlotModel.findById(id).lean() },
  }) as BookingService;
  Container.set(BookingService, bookingService);
  Container.set(DependentService, Object.assign(Object.create(DependentService.prototype), { dependentRepository: new DependentRepository() }));
  const pharmacyCustomerService = Object.assign(Object.create(PharmacyCustomerService.prototype), {
    pharmacyCustomerRepo: new PharmacyCustomerRepository(), pharmacyRepo: new PharmacyRepository(), userRepo: new UserRepository(),
  }) as PharmacyCustomerService;
  Container.set(PharmacyCustomerService, pharmacyCustomerService);
  const MED = oid();
  const inventory = {
    getInventoryByMedicine: async () => ({ retailPrice: 50, wholesalePrice: 40 }),
    reserveOrderStockBulk: async (_p: string, items: { medicineId: string }[]) => new Map(items.map((i) => [String(i.medicineId), []])),
    returnStockBulk: async () => [], releaseOrderStockBulk: async () => undefined, consumeOrderReservedStockBulk: async () => undefined,
  };
  // An Rx medicine: an order from a prescription still goes through the pharmacist review (P9).
  const medicines = {
    findById: async () => ({ _id: MED, name: 'Paracetamol 500', isActive: true, prescriptionRequired: true, gstPercent: 0 }),
    findAll: async () => [{ _id: MED, name: 'Paracetamol 500', isActive: true, prescriptionRequired: true }],
  };
  const refunds = new PrescriptionRefundService({ listRefunds: async () => [], fetchRefund: async () => { throw new Error('x'); },
    refund: async () => { throw new Error('x'); } } as never, new WalletRepository());
  const orderService = new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
    new PharmacyOrderRepository(), pharmacyCustomerService, inventory, payments, new BookingRepository(), {},
    { queueNotification: async () => undefined, queueSubscriptionSync: async () => undefined }, medicines, refunds);
  Container.set(PharmacyOrderService, orderService);
  Container.set(SpecialistService, { getById: async (id: string) => SpecialistModel.findById(id).lean() } as never);
  Container.set(SpecialistPortalService, Object.assign(Object.create(SpecialistPortalService.prototype), {
    bookingRepository: new BookingRepository(), userRepository: new UserRepository(),
    specialistService: { getById: async (id: string) => SpecialistModel.findById(id).lean() },
  }));

  Container.set(PaymentService, payments);
  const { default: paymentRouter } = await import('@/modules/payment/routes');
  const { default: bookingRouter } = await import('@/modules/bookings/routes');
  const { default: pharmacyOrderRouter } = await import('@/modules/pharmacyOrders/routes');
  const { default: specialistRouter } = await import('@/modules/specialists/routes');
  const { requestKeyRouter } = await import('@/modules/requestKeys');
  const { FileController } = await import('@/modules/file/controller');
  const { authenticate, authenticateOptional } = await import('@/modules/middleware/auth');
  const { catchAsync } = await import('@/modules/common/utils/asyncHandler');
  // Loaded on its own: without the phase 0 module the route is simply absent (each check then fails on its own).
  const pharmacyBookingRouter = await import('@/modules/assisted/routes' as string).then((m) => m.default as express.Router)
    .catch(() => express.Router());
  const app = express();
  app.use(express.json());
  const files = new FileController();
  app.get('/api/static/*', authenticateOptional, catchAsync(files.serveFile));
  app.use('/api/v1/bookings', authenticate, bookingRouter);
  app.use('/api/v1/pharmacy-bookings', authenticate, pharmacyBookingRouter);
  app.use('/api/v1/pharmacy-orders', authenticate, pharmacyOrderRouter);
  app.use('/api/v1/specialists', authenticate, specialistRouter);
  app.use('/api/v1/request-keys', authenticate, requestKeyRouter);
  app.use('/api/v1/payments', authenticate, paymentRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const base = root + '/api/v1';

  try {
    // ── People ──
    const L = oid(); const S = oid(); const N = oid(); const O = oid();
    const P = oid(); const Q = oid(); const U = oid();
    await PharmacyModel.collection.insertMany([
      { _id: new Types.ObjectId(P), name: 'Booker pharmacy', phone: '9700000101', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(Q), name: 'Other pharmacy', phone: '9700000102', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(U), name: 'Unverified pharmacy', phone: '9700000103', isActive: true, isVerified: false },
    ] as never);
    await UserModel.collection.insertMany([
      // L: an account P opened at its counter (P typed this name); S: a self sign-up; N: linked without consent; O: other.
      { _id: new Types.ObjectId(L), userType: 'user', phone: '9600000101', name: 'Lakshmi Devi Rao', email: 'lakshmi@example.test',
        createdSource: 'pharmacy_app', linkedPharmacyId: P, gender: 'female', dateOfBirth: '19800101' },
      { _id: new Types.ObjectId(S), userType: 'user', phone: '9600000102', name: 'Sunita Kumari Das', email: 'sunita@example.test', createdSource: 'self_signup' },
      { _id: new Types.ObjectId(N), userType: 'user', phone: '9600000103', name: 'Naveen', createdSource: 'self_signup' },
      { _id: new Types.ObjectId(O), userType: 'user', phone: '9600000104', name: 'Other Person', createdSource: 'self_signup' },
    ] as never);
    await PharmacyCustomerModel.collection.insertMany([
      { pharmacyId: new Types.ObjectId(P), userId: new Types.ObjectId(L), consent: 'patient_agreed' },
      { pharmacyId: new Types.ObjectId(P), userId: new Types.ObjectId(S), consent: 'patient_agreed' },
      { pharmacyId: new Types.ObjectId(P), userId: new Types.ObjectId(N), consent: 'not_recorded' },
      { pharmacyId: new Types.ObjectId(Q), userId: new Types.ObjectId(L), consent: 'patient_agreed' },
    ] as never);
    const depL = String((await DependentModel.create({ userId: L, name: 'Child Rao', relationship: 'Son', gender: 'Male', isActive: true } as never))._id);
    const D = oid(); const E = oid();
    await SpecialistModel.collection.insertMany([
      { _id: new Types.ObjectId(D), name: 'Dr Asha Menon', phone: '9800000101', medicalRegistrationNumber: 'KMC-12345', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(E), name: 'Dr Other', phone: '9800000102', isActive: true, isVerified: true },
    ] as never);
    const tokens = {
      L: sign({ _id: L, userType: 'user' }), S: sign({ _id: S, userType: 'user' }), O: sign({ _id: O, userType: 'user' }),
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), Q: sign({ _id: Q, pharmacyId: Q, userType: 'pharmacy' }),
      U: sign({ _id: U, pharmacyId: U, userType: 'pharmacy' }),
      D: sign({ _id: D, specialistId: D, userType: 'specialist' }), E: sign({ _id: E, specialistId: E, userType: 'specialist' }),
    };
    type Who = keyof typeof tokens;
    const call = async (who: Who | null, method: string, url: string, body?: unknown) => {
      const r = await fetch(url.startsWith('/api/') ? root + url : base + url, { method,
        headers: { ...(who ? { authorization: 'Bearer ' + tokens[who] } : {}), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any; try { json = JSON.parse(text); } catch { json = { text }; }
      return { status: r.status, json, text };
    };
    const expect = async (who: Who | null, method: string, url: string, status: number, body?: unknown, code?: string) => {
      const r = await call(who, method, url, body);
      assert.equal(r.status, status, `${who} ${method} ${url}: ${r.status} ${r.text.slice(0, 300)}`);
      if (code) assert.equal(r.json.code, code, `${who} ${method} ${url}: ${r.text.slice(0, 300)}`);
      return r;
    };
    const fileStatus = async (who: Who | null, url: string) => (await call(who, 'GET', url)).status;
    const read = (url: string) => fs.readFileSync(path.join(UPLOAD, url.replace(/^\/api\/static\//, '')), 'utf8');

    // ── Bookings (inserted as stored; createdAt spaced so the list order is known) ──
    const SECRET_DIAGNOSIS = 'SECRET-DIAGNOSIS-Tuberculosis';
    const rx = (extra: Record<string, unknown> = {}) => ({ diagnosis: SECRET_DIAGNOSIS, advice: 'Rest well and drink fluids',
      medicines: [{ name: 'Paracetamol 500', dosage: '1 tablet', frequency: 'twice a day', duration: '5 days', instructions: 'after food' }],
      testsAdvised: ['CBC'], message: 'Private doctor message', prescribedAt: new Date(Date.now() - 9 * DAY).toISOString(),
      prescribedBySpecialistId: D, prescribedBySpecialistName: 'Dr Asha Menon', ...extra });
    let seq = 0;
    const booking = async (f: Record<string, unknown>, daysAgo: number) => {
      const date = istDay(daysAgo);
      const slot = await SlotModel.create({ specialistId: D, date, startTime: '10:00 AM', endTime: '10:15 AM', duration: 15, maxBookings: 1,
        currentBookings: 1, isActive: true, isAvailable: true, slotType: 'consultation' } as never);
      const _id = new Types.ObjectId();
      const at = new Date(Date.now() - 60 * DAY + (++seq) * 60_000);
      await BookingModel.collection.insertOne({ _id, bookingType: 'consultation', specialistId: D, doctorName: 'Dr Asha Menon', slotId: String(slot._id),
        bookingDate: date, bookingTime: '10:00 AM', serviceMode: 'video', consultationMode: 'video', price: 300, originalPrice: 300,
        status: 'completed', paymentStatus: 'paid', primaryConcern: 'fever', contactNo: '9600000101', alternateContactNo: '9600000999',
        notes: 'private note', paymentTransactionId: 'pay_secret', createRequestKey: `key-secret-${String(seq + 1).padStart(3, '0')}`,
        lifecycle: { created: { at: at.toISOString(), by: 'pharmacy-actor' }, completed: { at: slotEndOf(date).toISOString(), by: D },
          // The server's mark of the doctor's save (only such a prescription counts, review finding 2).
          ...(f.prescription ? { prescriptionUploaded: { at: slotEndOf(date).toISOString() } } : {}) },
        createdAt: at, updatedAt: at, ...f } as never);
      return String(_id);
    };
    const b1 = await booking({ userId: L, pharmacyId: P, prescription: { ...rx(), fileUrls: [] },
      documents: [{ type: 'report', url: '/api/static/general/old-report.pdf' }], report: { fileUrls: ['/api/static/general/r.pdf'], message: 'lab says x' } }, 10);
    const b2 = await booking({ userId: L, pharmacyId: P, dependentId: depL, status: 'confirmed', lifecycle: undefined }, 1);
    const b3 = await booking({ userId: S, pharmacyId: P, status: 'pending', paymentStatus: 'pending', lifecycle: undefined }, -3);
    const b4 = await booking({ userId: L, pharmacyId: P, prescription: { ...rx(), fileUrls: [] } }, 120);
    const b5 = await booking({ userId: L, pharmacyId: P, prescription: { ...rx(), fileUrls: [] } }, 89);
    const bN = await booking({ userId: N, pharmacyId: P, prescription: { ...rx(), fileUrls: [] } }, 5);
    const bS = await booking({ userId: S, pharmacyId: P, prescription: { ...rx(), fileUrls: [] } }, 4);
    const bQ = await booking({ userId: L, pharmacyId: Q, prescription: { ...rx(), fileUrls: [] } }, 3);
    const bOwn = await booking({ userId: L, prescription: { ...rx(), fileUrls: [] } }, 2);
    const ownP = [b1, b2, b3, b4, b5, bN, bS];
    // The full prescription PDF of b1 (server-written, as the doctor's save writes it).
    const fullRel = `bookings/${b1}/prescription-1700000000000.pdf`;
    fs.mkdirSync(path.join(UPLOAD, 'bookings', b1), { recursive: true });
    fs.writeFileSync(path.join(UPLOAD, fullRel), `full prescription ${SECRET_DIAGNOSIS}`);
    await BookingModel.updateOne({ _id: b1 }, { $set: { 'prescription.fileUrls': ['/api/static/' + fullRel] } });

    const ALLOWED = new Set(['_id', 'bookingType', 'bookingKind', 'source', 'assisted', 'userId', 'dependentId', 'patientName', 'pharmacyId',
      'specialistId', 'doctorName', 'primaryConcern', 'consultationMode', 'serviceMode', 'clinicVisit', 'slotId', 'bookingDate', 'bookingTime',
      'contactNo', 'status', 'paymentStatus', 'price', 'originalPrice', 'cancellationReason', 'cancelledAt', 'cancellationCause', 'noShow',
      'lifecycle', 'virtualMeeting', 'prescription', 'createdAt', 'updatedAt']);
    const RX_ALLOWED = new Set(['advice', 'medicines', 'testsAdvised', 'prescribedAt', 'prescribedBySpecialistName', 'fileUrls', 'copyPending']);
    const FORBIDDEN_TEXT = [SECRET_DIAGNOSIS, 'diagnosis', 'private note', 'pay_secret', 'key-secret-', '9600000999', 'prescription-1700000000000',
      'lab says x', 'old-report', 'pharmacy-actor', 'sunita@example', 'lakshmi@example', 'Sunita Kumari', 'prescribedBySpecialistId',
      'Private doctor message', 'dispensingCopy', 'hash'];
    const assertBookerRow = (row: Record<string, any>) => {
      for (const k of Object.keys(row)) assert.ok(ALLOWED.has(k), `field ${k} is not in the booker view`);
      if (row.prescription) for (const k of Object.keys(row.prescription)) assert.ok(RX_ALLOWED.has(k), `prescription.${k} is not in the booker view`);
      if (row.lifecycle) for (const [k, v] of Object.entries(row.lifecycle)) {
        assert.ok(['created', 'confirmed', 'completed', 'cancelled'].includes(k), k); assert.deepEqual(Object.keys(v as object), ['at']);
      }
      const text = JSON.stringify(row);
      for (const t of FORBIDDEN_TEXT) assert.equal(text.includes(t), false, `booker view leaks ${t}`);
    };
    const DISPENSE = (id: string) => new RegExp(`^/api/static/bookings/${id}/rx-dispense-\\d+-[0-9a-f]{16}\\.pdf$`);
    /** Waits for the background copies of these bookings (lists only queue them). */
    const copiesMade = async (ids: string[], ms = 15_000) => {
      const until = Date.now() + ms;
      for (;;) {
        const rows = await BookingModel.find({ _id: { $in: ids } }).select({ 'prescription.dispensingCopy': 1 }).lean() as any[];
        if (rows.length === ids.length && rows.every((r) => r.prescription?.dispensingCopy?.url)) return rows;
        if (Date.now() > until) throw new Error('background copies not made in time');
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const listAll = async (who: Who, query = '') => {
      const rows: any[] = []; let cursor: string | null = null; let pages = 0;
      do {
        const r = await expect(who, 'GET', `/pharmacy-bookings?limit=2${query}${cursor ? '&cursor=' + cursor : ''}`, 200);
        rows.push(...r.json.data); cursor = r.json.pagination.nextCursor; pages++;
        assert.ok(pages < 20, 'paging ends');
      } while (cursor);
      return rows;
    };

    let b1Copy = '';
    await check('list: only the bookings this pharmacy made, newest first, cursor-paged; copies are never made inline', async () => {
      // The first page (bS, bN: prescriptions without copies) answers at once with the copies pending (finding 6).
      const firstPage = await expect('P', 'GET', '/pharmacy-bookings?limit=2', 200);
      assert.deepEqual(firstPage.json.data.map((r: any) => r._id), [bS, bN]);
      for (const r of firstPage.json.data) { assert.deepEqual(r.prescription.fileUrls, []); assert.equal(r.prescription.copyPending, true); }
      const rows = await listAll('P');
      assert.deepEqual(rows.map((r) => r._id), [...ownP].reverse(), 'own bookings, newest first, no repeats across pages');
      const first = await expect('P', 'GET', '/pharmacy-bookings?limit=2', 200);
      assert.equal(first.json.pagination.total, ownP.length);
      assert.equal(first.json.data.length, 2);
      assert.match(first.json.pagination.nextCursor, /^\d+_[0-9a-f]{24}$/);
      const other = await listAll('Q');
      assert.deepEqual(other.map((r) => r._id), [bQ]);
      await expect('P', 'GET', '/pharmacy-bookings?cursor=bad', 400, undefined, 'INVALID_CURSOR');
      // Filters: status and the appointment date range.
      const pending = await expect('P', 'GET', '/pharmacy-bookings?status=pending', 200);
      assert.deepEqual(pending.json.data.map((r: any) => r._id), [b3]);
      const d = (n: number) => { const x = istDay(n); return `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6, 8)}`; };
      const ranged = await expect('P', 'GET', `/pharmacy-bookings?from=${d(11)}&to=${d(4)}`, 200);
      assert.deepEqual(new Set(ranged.json.data.map((r: any) => r._id)), new Set([b1, bN, bS]));
      await expect('P', 'GET', '/pharmacy-bookings?from=2026-02-30', 400, undefined, 'VALIDATION_ERROR');
    });

    await check('list: the allowlisted booker view, typed patient name, prescription without the diagnosis', async () => {
      await copiesMade([b1, b5, bN, bS]);
      const rows = await listAll('P');
      rows.forEach(assertBookerRow);
      const by = new Map(rows.map((r) => [r._id, r]));
      const r1 = by.get(b1)!;
      assert.equal(r1.patientName, 'Lakshmi Devi Rao', 'the name the pharmacy typed when it opened the account');
      assert.equal(by.get(b2)!.patientName, 'Child Rao', 'a family member booking names the family member');
      // Review of 800dfc0 (item 2, assumed): the pharmacy's own "patient agreed" tick never shows the real account name;
      // no typed name, so masked (only a customer's own order would show it).
      assert.equal(by.get(b3)!.patientName, 'Sunita D.', 'a patient_agreed link without a typed name shows the name masked');
      assert.equal(by.get(bN)!.patientName, 'Na…', 'a link without recorded consent shows the name masked');
      assert.equal(r1.doctorName, 'Dr Asha Menon'); assert.equal(r1.status, 'completed'); assert.equal(r1.bookingDate, istDay(10));
      assert.equal(r1.source, 'self');
      assert.deepEqual(r1.prescription.medicines.map((m: any) => m.name), ['Paracetamol 500']);
      assert.equal(r1.prescription.advice, 'Rest well and drink fluids');
      assert.deepEqual(r1.prescription.testsAdvised, ['CBC']);
      assert.equal(r1.prescription.diagnosis, undefined);
      assert.equal(r1.prescription.fileUrls.length, 1);
      assert.equal(r1.prescription.copyPending, undefined);
      assert.equal(r1.prescription.message, undefined, 'the doctor\'s free text is not shown (finding 9)');
      assert.match(r1.prescription.fileUrls[0], DISPENSE(b1), 'the only file is the dispensing copy');
      b1Copy = r1.prescription.fileUrls[0];
      assert.equal(by.get(b3)!.prescription, undefined, 'no prescription yet');
      // Older than 90 days after the consultation: the prescription is left out (the rest stays).
      assert.equal(by.get(b4)!.prescription, undefined);
      assert.equal(by.get(b4)!.status, 'completed');
      assert.ok(by.get(b5)!.prescription, '89 days: still shown');
    });

    await check('detail: own booking in the booker view; another pharmacy\'s, a missing and a malformed id answer the same 404', async () => {
      const r = await expect('P', 'GET', `/pharmacy-bookings/${b1}`, 200);
      assertBookerRow(r.json.data);
      assert.equal(r.json.data.prescription.fileUrls[0], b1Copy, 'the same copy (made once)');
      const other = await expect('P', 'GET', `/pharmacy-bookings/${bQ}`, 404, undefined, 'BOOKING_NOT_FOUND');
      const missing = await expect('P', 'GET', `/pharmacy-bookings/${oid()}`, 404, undefined, 'BOOKING_NOT_FOUND');
      const bad = await expect('P', 'GET', '/pharmacy-bookings/not-an-id', 404, undefined, 'BOOKING_NOT_FOUND');
      assert.deepEqual(other.json, missing.json); assert.deepEqual(bad.json, missing.json);
      await expect('P', 'GET', `/pharmacy-bookings/${bOwn}`, 404, undefined, 'BOOKING_NOT_FOUND');
    });

    await check('only an operational pharmacy reaches the list; customers and doctors are refused', async () => {
      await expect('U', 'GET', '/pharmacy-bookings', 403, undefined, 'PHARMACY_NOT_VERIFIED');
      await expect('L', 'GET', '/pharmacy-bookings', 403, undefined, 'FORBIDDEN');
      await expect('D', 'GET', `/pharmacy-bookings/${b1}`, 403, undefined, 'FORBIDDEN');
      await expect(null, 'GET', '/pharmacy-bookings', 401);
    });

    await check('dispensing copy: medicines, advice, tests, doctor and registration, the withheld line; never the diagnosis; made once', async () => {
      assert.match(b1Copy, DISPENSE(b1));
      const html = read(b1Copy);
      for (const t of ['Paracetamol 500', 'twice a day', '5 days', 'after food', 'Rest well and drink fluids', 'CBC', 'Dr Asha Menon', 'KMC-12345',
        'Lakshmi Devi Rao', 'Dispensing copy: diagnosis withheld', 'Jansetu', 'female']) assert.ok(html.includes(t), `copy shows ${t}`);
      for (const t of [SECRET_DIAGNOSIS, 'Private doctor message', 'lakshmi@example', '9600000101']) assert.equal(html.includes(t), false, `copy hides ${t}`);
      await expect('P', 'GET', `/pharmacy-bookings/${b1}`, 200);
      const files = fs.readdirSync(path.join(UPLOAD, 'bookings', b1)).filter((f) => f.startsWith('rx-dispense-'));
      assert.equal(files.length, 1, 'repeated reads make no second copy');
      const stored = await BookingModel.findById(b1).lean() as any;
      assert.equal(stored.prescription.dispensingCopy.url, b1Copy);
      assert.equal(stored.prescription.diagnosis, SECRET_DIAGNOSIS, 'the booking itself keeps the diagnosis');
    });

    await check('the doctor\'s save makes the dispensing copy next to the full PDF', async () => {
      const r = await expect('D', 'POST', `/specialists/me/appointments/${b2}/prescription`, 200,
        { diagnosis: SECRET_DIAGNOSIS, advice: 'Steam twice daily', medicines: [{ name: 'Cetirizine 10', dosage: '1 tab' }], testsAdvised: ['X-ray chest'] });
      assert.equal(r.json.data.prescription.diagnosis, SECRET_DIAGNOSIS, 'the doctor sees what they wrote');
      const stored = await BookingModel.findById(b2).lean() as any;
      assert.match(stored.prescription.fileUrls[0], new RegExp(`^/api/static/bookings/${b2}/prescription-\\d+\\.pdf$`));
      assert.match(stored.prescription.dispensingCopy?.url ?? '', DISPENSE(b2));
      const html = read(stored.prescription.dispensingCopy.url);
      assert.ok(html.includes('Cetirizine 10') && html.includes('Steam twice daily') && html.includes('X-ray chest') && html.includes('Child Rao'));
      assert.equal(html.includes(SECRET_DIAGNOSIS), false);
      assert.ok(read(stored.prescription.fileUrls[0]).includes(SECRET_DIAGNOSIS), 'the full PDF keeps the diagnosis');
      const view = await expect('P', 'GET', `/pharmacy-bookings/${b2}`, 200);
      assert.deepEqual(view.json.data.prescription.fileUrls, [stored.prescription.dispensingCopy.url]);
      // Saved again with other medicines: a fresh copy is made and shown.
      await expect('D', 'POST', `/specialists/me/appointments/${b2}/prescription`, 200,
        { diagnosis: SECRET_DIAGNOSIS, advice: 'Steam twice daily', medicines: [{ name: 'Montelukast 10' }] });
      const again = await BookingModel.findById(b2).lean() as any;
      assert.notEqual(again.prescription.dispensingCopy.url, stored.prescription.dispensingCopy.url);
      assert.ok(read(again.prescription.dispensingCopy.url).includes('Montelukast 10'));
    });

    await check('dispensing copy access: the booking pharmacy, the patient and the doctor only', async () => {
      for (const who of ['P', 'L', 'D'] as Who[]) assert.equal(await fileStatus(who, b1Copy), 200, who);
      for (const who of ['Q', 'U', 'E', 'S', 'O'] as Who[]) assert.equal(await fileStatus(who, b1Copy), 404, who);
      assert.equal(await fileStatus(null, b1Copy), 401);
      // An old copy (the doctor saved again) is no longer the pharmacy's to read; the patient keeps it.
      const files = fs.readdirSync(path.join(UPLOAD, 'bookings', b2)).filter((f) => f.startsWith('rx-dispense-')).sort();
      assert.equal(files.length, 2);
      const old = `/api/static/bookings/${b2}/${files[0]}`;
      assert.equal(await fileStatus('P', old), 404); assert.equal(await fileStatus('L', old), 200);
    });

    await check('dispensing copy access ends after 90 days and with the pharmacy\'s authority', async () => {
      // b4's consultation was 120 days ago: its copy (made now for the patient) is closed to the pharmacy.
      const { ensureDispensingCopy } = await import('@/modules/assisted/dispensingCopy' as string);
      const url = await ensureDispensingCopy(await BookingModel.findById(b4).lean());
      assert.match(url, DISPENSE(b4));
      assert.equal(await fileStatus('P', url), 404);
      assert.equal(await fileStatus('L', url), 200); assert.equal(await fileStatus('D', url), 200);
      // b5 (89 days): open to the pharmacy …
      const r5 = await expect('P', 'GET', `/pharmacy-bookings/${b5}`, 200);
      const u5 = r5.json.data.prescription.fileUrls[0];
      assert.equal(await fileStatus('P', u5), 200);
      // … until the pharmacy stops being operational.
      await PharmacyModel.updateOne({ _id: P }, { $set: { isVerified: false } });
      try { assert.equal(await fileStatus('P', u5), 404); } finally { await PharmacyModel.updateOne({ _id: P }, { $set: { isVerified: true } }); }
      assert.equal(await fileStatus('P', u5), 200);
    });

    await check('the full prescription PDF and the booking\'s other files are refused to the pharmacy', async () => {
      const full = '/api/static/' + fullRel;
      assert.equal(await fileStatus('P', full), 404);
      assert.equal(await fileStatus('Q', full), 404);
      assert.equal(await fileStatus('L', full), 200, 'the patient');
      assert.equal(await fileStatus('D', full), 200, 'the doctor');
      // A document the patient uploaded and bound to the booking: patient and doctor, not the pharmacy.
      const rel = `general/${oid()}.pdf`;
      fs.mkdirSync(path.join(UPLOAD, 'general'), { recursive: true }); fs.writeFileSync(path.join(UPLOAD, rel), 'doc');
      await FileUploadModel.create({ path: rel, uploaderType: 'user', uploaderId: L, createdAt: new Date() });
      await BookingModel.updateOne({ _id: b1 }, { $push: { documents: { type: 'other', url: '/api/static/' + rel } } });
      const { grantFiles } = await import('@/modules/file/access');
      await grantFiles({ _id: L, userType: 'user' }, [rel], 'booking', { model: 'Booking', resourceId: b1, field: 'documents.url' });
      assert.equal(await fileStatus('D', '/api/static/' + rel), 200);
      assert.equal(await fileStatus('P', '/api/static/' + rel), 404);
    });

    await check('generic /bookings reads give the pharmacy the booker view (S2 scope kept); others see what they saw', async () => {
      const list = await expect('P', 'GET', '/bookings', 200);
      assert.deepEqual(new Set(list.json.data.map((r: any) => r._id)), new Set(ownP));
      list.json.data.forEach(assertBookerRow);
      const paged = await expect('P', 'GET', '/bookings?page=1&limit=3', 200);
      assert.equal(paged.json.pagination.total, ownP.length); paged.json.data.forEach(assertBookerRow);
      const one = await expect('P', 'GET', `/bookings/${b1}`, 200);
      assertBookerRow(one.json.data);
      assert.deepEqual(one.json.data.prescription.fileUrls, [b1Copy]);
      const byUser = await expect('P', 'GET', `/bookings/user/${L}`, 200);
      assert.deepEqual(new Set(byUser.json.data.map((r: any) => r._id)), new Set([b1, b2, b4, b5]));
      byUser.json.data.forEach(assertBookerRow);
      // S2: not its booking → 404 like a missing one.
      const other = await expect('P', 'GET', `/bookings/${bQ}`, 404, undefined, 'BOOKING_NOT_FOUND');
      const missing = await expect('P', 'GET', `/bookings/${oid()}`, 404, undefined, 'BOOKING_NOT_FOUND');
      assert.deepEqual(other.json, missing.json);
      await expect('E', 'GET', `/bookings/${b1}`, 404, undefined, 'BOOKING_NOT_FOUND');
      // The patient and the doctor still read the whole booking.
      const mine = await expect('L', 'GET', `/bookings/${b1}`, 200);
      assert.equal(mine.json.data.prescription.diagnosis, SECRET_DIAGNOSIS);
      assert.equal(mine.json.data.prescription.fileUrls[0], '/api/static/' + fullRel);
      const doc = await expect('D', 'GET', `/bookings/${b1}`, 200);
      assert.equal(doc.json.data.prescription.diagnosis, SECRET_DIAGNOSIS);
    });

    await check('S3 still holds: no booking or order for a customer not linked to the pharmacy', async () => {
      await expect('P', 'POST', '/bookings/specialist', 403, { specialistId: D, slotId: oid(), bookingDate: istDay(-5), bookingTime: '10:00 AM',
        consultationMode: 'video', primaryConcern: 'fever', userId: O }, 'CUSTOMER_NOT_LINKED');
      await expect('P', 'POST', '/pharmacy-orders', 403, { orderType: 'in_store', customerId: O, items: [{ medicineId: MED, orderedQty: 1 }],
        paymentMode: 'in_store_payment', deliveryMode: 'pickup' }, 'CUSTOMER_NOT_LINKED');
    });

    // ── Create medicine order from the prescription ──
    const rxOrder = (bookingId: string, key: string | undefined, extra: Record<string, unknown> = {}) => ({ orderType: 'in_store',
      prescriptionFromBookingId: bookingId, ...(key ? { requestKey: key } : {}), items: [{ medicineId: MED, orderedQty: 2 }],
      paymentMode: 'in_store_payment', deliveryMode: 'pickup', ...extra });
    const orders = () => PharmacyOrderModel.countDocuments();
    const audits = () => mongoose.connection.db!.collection('assisted_audit_events');

    await check('order from prescription: request shape and "not yours" answers, nothing written', async () => {
      const before = await orders();
      await expect('P', 'POST', '/pharmacy-orders', 400, rxOrder(b1, undefined), 'REQUEST_KEY_REQUIRED');
      // Even a file the pharmacy uploaded itself: the order carries the booking's prescription only.
      const own = `general/${oid()}.jpg`;
      await FileUploadModel.create({ path: own, uploaderType: 'pharmacy', uploaderId: P, createdAt: new Date() });
      await expect('P', 'POST', '/pharmacy-orders', 400, rxOrder(b1, 'rx-key-shape-01', { prescriptionUrls: ['/api/static/' + own] }), 'PRESCRIPTION_SOURCE_CONFLICT');
      await expect('P', 'POST', '/pharmacy-orders', 400, rxOrder(b1, 'rx-key-shape-09', { prescriptionUrls: [b1Copy] }), 'FILE_NOT_ATTACHABLE');
      await expect('P', 'POST', '/pharmacy-orders', 400, { ...rxOrder(b1, 'rx-key-shape-02'), prescriptionFromBookingId: undefined, customerId: L },
        'REQUEST_KEY_UNSUPPORTED');
      const other = await expect('P', 'POST', '/pharmacy-orders', 404, rxOrder(bQ, 'rx-key-shape-03'), 'BOOKING_NOT_FOUND');
      const missing = await expect('P', 'POST', '/pharmacy-orders', 404, rxOrder(oid(), 'rx-key-shape-04'), 'BOOKING_NOT_FOUND');
      const notPatient = await expect('P', 'POST', '/pharmacy-orders', 404, rxOrder(b1, 'rx-key-shape-05', { customerId: S }), 'BOOKING_NOT_FOUND');
      assert.deepEqual(other.json, missing.json); assert.deepEqual(notPatient.json, missing.json);
      await expect('P', 'POST', '/pharmacy-orders', 409, rxOrder(b3, 'rx-key-shape-06'), 'PRESCRIPTION_NOT_READY');
      await expect('P', 'POST', '/pharmacy-orders', 403, rxOrder(b4, 'rx-key-shape-07'), 'PRESCRIPTION_ACCESS_EXPIRED');
      await expect('U', 'POST', '/pharmacy-orders', 403, rxOrder(b1, 'rx-key-shape-08'), 'PHARMACY_NOT_VERIFIED');
      assert.equal(await orders(), before);
      assert.equal(await audits().countDocuments(), 0);
    });

    await check('order from prescription: only through a link with the patient\'s consent (S3)', async () => {
      const before = await orders();
      await expect('P', 'POST', '/pharmacy-orders', 403, rxOrder(bN, 'rx-key-consent-1'), 'CUSTOMER_CONSENT_REQUIRED');
      await PharmacyCustomerModel.deleteOne({ pharmacyId: P, userId: S });
      try {
        await expect('P', 'POST', '/pharmacy-orders', 403, rxOrder(bS, 'rx-key-consent-2'), 'CUSTOMER_NOT_LINKED');
        assert.equal(await PharmacyCustomerModel.exists({ pharmacyId: P, userId: S }), null, 'no link is made silently');
      } finally {
        await PharmacyCustomerModel.collection.insertOne({ pharmacyId: new Types.ObjectId(P), userId: new Types.ObjectId(S), consent: 'patient_agreed' } as never);
      }
      assert.equal(await orders(), before);
    });

    let orderId = '';
    await check('order from prescription: the dispensing copy bound by the server, once per key, audited', async () => {
      const r = await expect('P', 'POST', '/pharmacy-orders', 201, rxOrder(b1, 'rx-key-b1-0001'));
      const o = r.json.data.order;
      orderId = String(o._id);
      assert.equal(String(o.customerId), L); assert.equal(String(o.linkedConsultationId), b1);
      assert.deepEqual(o.prescriptionUrls, [b1Copy]);
      assert.equal(o.prescriptionStatus, 'pending', 'the pharmacist review still applies (P9)');
      assert.equal(o.prescriptionFromBooking.bookingId, b1);
      const end = slotEndOf(istDay(10)).getTime();
      assert.equal(new Date(o.prescriptionFromBooking.bindingExpiresAt).getTime() - end, 90 * DAY, 'binding until consultation + 90 days');
      const grant = await FileGrantModel.findOne({ path: b1Copy.replace('/api/static/', ''), model: 'PharmacyOrder', resourceId: orderId }).lean() as any;
      assert.equal(grant?.state, 'active'); assert.equal(grant?.kind, 'pharmacy_order'); assert.equal(grant?.keepIfDispensed, true);
      assert.equal(new Date(grant.expiresAt).getTime(), new Date(o.prescriptionFromBooking.bindingExpiresAt).getTime());
      // Replay: same key and content → the same order, nothing new.
      const again = await expect('P', 'POST', '/pharmacy-orders', 201, rxOrder(b1, 'rx-key-b1-0001'));
      assert.equal(String(again.json.data.order._id), orderId); assert.equal(again.json.data.replayed, true);
      assert.equal(await PharmacyOrderModel.countDocuments({ 'prescriptionFromBooking.bookingId': b1 }), 1);
      // Other content under the key: refused; another pharmacy's same key is its own.
      await expect('P', 'POST', '/pharmacy-orders', 409, rxOrder(b1, 'rx-key-b1-0001', { items: [{ medicineId: MED, orderedQty: 3 }] }), 'IDEMPOTENCY_KEY_REUSED');
      await expect('P', 'POST', '/pharmacy-orders', 409, rxOrder(b5, 'rx-key-b1-0001'), 'IDEMPOTENCY_KEY_REUSED');
      const audit = await audits().find({ orderId }).toArray();
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.action, 'rx_order.created'); assert.equal(audit[0]!.orgId, P); assert.equal(audit[0]!.bookingId, b1);
      const text = JSON.stringify(audit);
      for (const t of ['Lakshmi', '9600000101', 'Paracetamol', SECRET_DIAGNOSIS]) assert.equal(text.includes(t), false, `audit holds no ${t}`);
      // The key is visible to the key lookup in the pharmacy's scope.
      const look = await expect('P', 'GET', '/request-keys/lookup?kind=pharmacy_rx_order&key=rx-key-b1-0001', 200);
      assert.equal(look.json.data.state, 'used'); assert.equal(String(look.json.data.record._id), orderId);
    });

    await check('order from prescription: concurrent first requests make one order; an abandoned key never orders', async () => {
      const results = await Promise.all([0, 1, 2].map(() => call('P', 'POST', '/pharmacy-orders', rxOrder(bS, 'rx-key-race-001'))));
      assert.deepEqual(results.map((r) => r.status), [201, 201, 201], JSON.stringify(results.map((r) => r.json.code)));
      assert.equal(new Set(results.map((r) => String(r.json.data.order._id))).size, 1);
      assert.equal(await PharmacyOrderModel.countDocuments({ 'prescriptionFromBooking.bookingId': bS }), 1);
      const ab = await expect('P', 'POST', '/request-keys/abandon', 200, { kind: 'pharmacy_rx_order', key: 'rx-key-abandon1' });
      assert.equal(ab.json.data.state, 'abandoned');
      await expect('P', 'POST', '/pharmacy-orders', 409, rxOrder(b5, 'rx-key-abandon1'), 'REQUEST_ABANDONED');
      assert.equal(await PharmacyOrderModel.countDocuments({ 'prescriptionFromBooking.bookingId': b5 }), 0);
    });

    await check('the uploader rule is unchanged: a pharmacy cannot attach the copy or the full PDF itself', async () => {
      const plain = (prescriptionUrls: string[]) => ({ orderType: 'in_store', customerId: L, items: [{ medicineId: MED, orderedQty: 1 }],
        paymentMode: 'in_store_payment', deliveryMode: 'pickup', prescriptionUrls });
      await expect('P', 'POST', '/pharmacy-orders', 400, plain([b1Copy]), 'FILE_NOT_ATTACHABLE');
      await expect('P', 'POST', '/pharmacy-orders', 400, plain(['/api/static/' + fullRel]), 'FILE_NOT_ATTACHABLE');
      // The order's patient cannot be changed afterwards (the bound copy follows the order's customer).
      await expect('P', 'PUT', `/pharmacy-orders/${orderId}`, 409, { customerId: S }, 'ORDER_PRESCRIPTION_PARTY_LOCKED');
      assert.equal(String((await PharmacyOrderModel.findById(orderId).lean())?.customerId), L);
    });

    await check('the order binding expires 90 days after the consultation unless the order was dispensed (N12)', async () => {
      const r = await expect('P', 'POST', '/pharmacy-orders', 201, rxOrder(b5, 'rx-key-b5-0001'));
      const id5 = String(r.json.data.order._id);
      const url = r.json.data.order.prescriptionUrls[0];
      assert.match(url, DISPENSE(b5));
      assert.equal(await fileStatus('P', url), 200);
      // Packing (the pharmacist approved the prescription) records when the order was dispensed (finding 7).
      await PharmacyOrderModel.updateOne({ _id: id5 }, { $set: { status: 'accepted', prescriptionStatus: 'approved', paymentStatus: 'paid' } });
      await expect('P', 'POST', `/pharmacy-orders/${id5}/status`, 200, { status: 'packed' });
      const packedAt = (await PharmacyOrderModel.findById(id5).lean() as any).prescriptionFromBooking.dispensedAt;
      assert.ok(packedAt instanceof Date && Math.abs(packedAt.getTime() - Date.now()) < 60_000, 'dispensedAt set by the packing');
      // Five days later: the consultation is 94 days old (the booking's own window is closed) and the binding expired.
      const shifted = istDay(94);
      const slot = await SlotModel.create({ specialistId: D, date: shifted, startTime: '10:00 AM', endTime: '10:15 AM', duration: 15, maxBookings: 1,
        currentBookings: 1, isActive: true, isAvailable: true, slotType: 'consultation' } as never);
      await BookingModel.updateOne({ _id: b5 }, { $set: { bookingDate: shifted, slotId: String(slot._id), 'lifecycle.completed.at': slotEndOf(shifted).toISOString() } });
      const expiry = new Date(slotEndOf(shifted).getTime() + 90 * DAY);
      assert.ok(expiry.getTime() < Date.now());
      await FileGrantModel.updateOne({ model: 'PharmacyOrder', resourceId: id5 }, { $set: { expiresAt: expiry } });
      const before = new Date(expiry.getTime() - DAY); const after = new Date(expiry.getTime() + 60_000);
      for (const [status, dispensedAt, code] of [['placed', null, 404], ['accepted', null, 404], ['packed', before, 200], ['ready_for_pickup', before, 200],
        ['out_for_delivery', before, 200], ['completed', before, 200], ['cancelled', before, 404], ['rejected', before, 404],
        // Packed only after the expiry: never revives the binding.
        ['packed', after, 404], ['completed', after, 404], ['completed', null, 404]] as [string, Date | null, number][]) {
        await PharmacyOrderModel.updateOne({ _id: id5 }, dispensedAt
          ? { $set: { status, 'prescriptionFromBooking.dispensedAt': dispensedAt } }
          : { $set: { status }, $unset: { 'prescriptionFromBooking.dispensedAt': '' } });
        assert.equal(await fileStatus('P', url), code, `order ${status} dispensed ${dispensedAt ? (dispensedAt === before ? 'before' : 'after') : 'never'}`);
      }
      // Kept as the dispensing record, but only while the pharmacy is operational (finding 5).
      await PharmacyOrderModel.updateOne({ _id: id5 }, { $set: { status: 'completed', 'prescriptionFromBooking.dispensedAt': before } });
      assert.equal(await fileStatus('P', url), 200);
      await PharmacyModel.updateOne({ _id: P }, { $set: { isActive: false } });
      try { assert.equal(await fileStatus('P', url), 404); } finally { await PharmacyModel.updateOne({ _id: P }, { $set: { isActive: true } }); }
      assert.equal(await fileStatus('L', url), 200, 'the patient always reads it');
      assert.equal(await fileStatus('Q', url), 404);
      // A new order from the expired prescription is refused.
      await expect('P', 'POST', '/pharmacy-orders', 403, rxOrder(b5, 'rx-key-b5-0002'), 'PRESCRIPTION_ACCESS_EXPIRED');
    });

    await check('a converter failure never breaks the list (no file shown) and refuses an order with 503', async () => {
      const fresh = await booking({ userId: L, pharmacyId: P, prescription: { ...rx(), fileUrls: [] } }, 2);
      fs.writeFileSync(FAIL_MARK, '1');
      try {
        const r = await expect('P', 'GET', `/pharmacy-bookings/${fresh}`, 200);
        assert.deepEqual(r.json.data.prescription.fileUrls, []);
        assert.equal(r.json.data.prescription.advice, 'Rest well and drink fluids');
        await expect('P', 'POST', '/pharmacy-orders', 503, rxOrder(fresh, 'rx-key-fail-001'), 'DISPENSING_COPY_UNAVAILABLE');
      } finally { fs.rmSync(FAIL_MARK, { force: true }); }
      const ok = await expect('P', 'GET', `/pharmacy-bookings/${fresh}`, 200);
      assert.match(ok.json.data.prescription.fileUrls[0], DISPENSE(fresh));
    });

    // ── Review fixes (extra-high review of 9ce19b0 / e248f57) ──
    const futureSlot = async (daysAhead: number) => {
      const date = istDay(-daysAhead);
      const slot = await SlotModel.create({ specialistId: D, date, startTime: '11:00 AM', endTime: '11:15 AM', duration: 15, maxBookings: 1,
        currentBookings: 0, isActive: true, isAvailable: true, slotType: 'consultation' } as never);
      return { slotId: String(slot._id), bookingDate: date, bookingTime: '11:00 AM' };
    };

    await check('finding 2: a prescription the client sent is never a prescription (no view, no copy, no order)', async () => {
      const made = await expect('P', 'POST', '/bookings/specialist', 201, { specialistId: D, ...(await futureSlot(30)), consultationMode: 'in-person',
        primaryConcern: 'fever', userId: L, prescription: { diagnosis: 'forged', advice: 'forged advice', medicines: [{ name: 'Alprazolam 0.5 mg' }],
          testsAdvised: ['forged test'], prescribedAt: new Date().toISOString(), prescribedBySpecialistId: D, prescribedBySpecialistName: 'Dr Asha Menon' } });
      const id = String(made.json.data.booking._id);
      // Stage merge: hotfix S4 drops a create's prescription; a row stored before S4 still carries one (written here).
      assert.equal((await BookingModel.findById(id).lean() as any).prescription, undefined, 'S4: the create stores no prescription');
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { prescription: { diagnosis: 'forged', advice: 'forged advice',
        medicines: [{ name: 'Alprazolam 0.5 mg' }], testsAdvised: ['forged test'], prescribedAt: new Date().toISOString(), prescribedBySpecialistId: D,
        prescribedBySpecialistName: 'Dr Asha Menon' } } });
      const view = await expect('P', 'GET', `/pharmacy-bookings/${id}`, 200);
      assert.equal(view.json.data.prescription, undefined);
      await expect('P', 'POST', '/pharmacy-orders', 409, rxOrder(id, 'rx-key-forged-01'), 'PRESCRIPTION_NOT_READY');
      const list = await expect('P', 'GET', '/pharmacy-bookings?limit=50', 200);
      assert.equal(list.json.data.find((r: any) => r._id === id)?.prescription, undefined);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(fs.existsSync(path.join(UPLOAD, 'bookings', id)), false, 'no copy file made');
      assert.equal((await BookingModel.findById(id).lean() as any).prescription?.dispensingCopy, undefined);
    });

    await check('finding 3: concurrent first reads and orders keep one stored copy whose file exists; a lost file is made again', async () => {
      // A slow converter makes every concurrent first read render at the same time (all but one lose the store).
      fs.writeFileSync(SLOW_MARK, '0.5');
      try {
        for (let i = 0; i < 3; i++) {
          const id = await booking({ userId: L, pharmacyId: P, prescription: { ...rx(), fileUrls: [] } }, 3);
          const reads = await Promise.all([0, 1, 2, 3, 4, 5].map(() => call('P', 'GET', `/pharmacy-bookings/${id}`)));
          const urls = reads.map((r) => r.json.data.prescription.fileUrls[0]);
          const stored = (await BookingModel.findById(id).lean() as any).prescription.dispensingCopy.url;
          assert.ok(urls.every((u) => u === stored), `every concurrent read answers the stored copy (${i})`);
          assert.ok(fs.existsSync(path.join(UPLOAD, stored.replace('/api/static/', ''))), `stored copy file exists (${i})`);
          assert.deepEqual(fs.readdirSync(path.join(UPLOAD, 'bookings', id)), [stored.split('/').pop()], 'the losers removed only their own files');
        }
      } finally { fs.rmSync(SLOW_MARK, { force: true }); }
      // Each write has its own temporary HTML file, even for the same output name in the same millisecond.
      const { writeBookingPdf } = await import('@/modules/specialistPortal/pdf' as string);
      const tmpId = oid();
      const both = await Promise.allSettled([writeBookingPdf(tmpId, 'prescription-1.pdf', 'A'), writeBookingPdf(tmpId, 'prescription-2.pdf', 'B'),
        writeBookingPdf(tmpId, 'prescription-1.pdf', 'A')]);
      assert.deepEqual(both.map((x) => x.status), ['fulfilled', 'fulfilled', 'fulfilled'], JSON.stringify(both));
      assert.equal(fs.readFileSync(path.join(UPLOAD, 'bookings', tmpId, 'prescription-2.pdf'), 'utf8'), 'B');
      for (let i = 0; i < 6; i++) {
        const id = await booking({ userId: L, pharmacyId: P, prescription: { ...rx(), fileUrls: [] } }, 3);
        const reads = await Promise.all([0, 1, 2, 3, 4, 5].map(() => call('P', 'GET', `/pharmacy-bookings/${id}`)));
        const urls = new Set(reads.map((r) => r.json.data.prescription.fileUrls[0]));
        const stored = (await BookingModel.findById(id).lean() as any).prescription.dispensingCopy.url;
        assert.ok(fs.existsSync(path.join(UPLOAD, stored.replace('/api/static/', ''))), `stored copy file exists (${i})`);
        for (const u of urls) assert.ok(u === stored || (u && fs.existsSync(path.join(UPLOAD, u.replace('/api/static/', '')))), `answered file exists (${i})`);
        assert.equal(await fileStatus('P', stored), 200);
        const ord = await booking({ userId: L, pharmacyId: P, prescription: { ...rx(), fileUrls: [] } }, 3);
        const rs = await Promise.all([0, 1, 2, 3].map(() => call('P', 'POST', '/pharmacy-orders', rxOrder(ord, `rx-key-k-race-${i}`))));
        assert.deepEqual(rs.map((r) => r.status), [201, 201, 201, 201], JSON.stringify(rs.map((r) => r.json.code)));
        const ou = rs[0]!.json.data.order.prescriptionUrls[0];
        assert.ok(rs.every((r) => r.json.data.order.prescriptionUrls[0] === ou));
        assert.ok(fs.existsSync(path.join(UPLOAD, ou.replace('/api/static/', ''))), `order copy file exists (${i})`);
        assert.equal(await fileStatus('P', ou), 200);
      }
      // Repair: the stored copy's file is lost; the next read makes it again and stores the new one.
      const id = await booking({ userId: L, pharmacyId: P, prescription: { ...rx(), fileUrls: [] } }, 3);
      const first = (await expect('P', 'GET', `/pharmacy-bookings/${id}`, 200)).json.data.prescription.fileUrls[0];
      fs.rmSync(path.join(UPLOAD, first.replace('/api/static/', '')));
      const again = (await expect('P', 'GET', `/pharmacy-bookings/${id}`, 200)).json.data.prescription.fileUrls[0];
      assert.notEqual(again, first);
      assert.equal((await BookingModel.findById(id).lean() as any).prescription.dispensingCopy.url, again);
      assert.equal(await fileStatus('P', again), 200); assert.equal(await fileStatus('L', again), 200);
    });

    await check('finding 6: a slow converter never holds a list, and is stopped by its timeout on a detail read', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push(await booking({ userId: S, pharmacyId: P, prescription: { ...rx(), fileUrls: [] } }, 2));
      fs.writeFileSync(SLOW_MARK, '3');
      process.env.PDF_CONVERTER_TIMEOUT_MS = '600';
      try {
        const t0 = Date.now();
        const list = await expect('P', 'GET', '/pharmacy-bookings?limit=50', 200);
        assert.ok(Date.now() - t0 < 1500, `list answered in ${Date.now() - t0} ms`);
        for (const id of ids) {
          const row = list.json.data.find((r: any) => r._id === id);
          assert.deepEqual(row.prescription.fileUrls, []); assert.equal(row.prescription.copyPending, true);
        }
        const t1 = Date.now();
        const one = await expect('P', 'GET', `/pharmacy-bookings/${ids[0]}`, 200);
        assert.ok(Date.now() - t1 < 2500, `detail answered in ${Date.now() - t1} ms (converter killed)`);
        assert.deepEqual(one.json.data.prescription.fileUrls, []);
        assert.equal(fs.readdirSync(path.join(UPLOAD, 'bookings')).includes(ids[0]!) &&
          fs.readdirSync(path.join(UPLOAD, 'bookings', ids[0]!)).length > 0, false, 'no partial file left');
      } finally { fs.rmSync(SLOW_MARK, { force: true }); delete process.env.PDF_CONVERTER_TIMEOUT_MS; }
      // The queued copies are made in the background afterwards.
      await expect('P', 'GET', '/pharmacy-bookings?limit=50', 200);
      await copiesMade(ids);
    });

    await check('finding 7: a stale copy, a cancelled or rejected order and a non-operational pharmacy get nothing', async () => {
      const id = await booking({ userId: L, pharmacyId: P, prescription: { ...rx(), fileUrls: [] } }, 3);
      const o = await expect('P', 'POST', '/pharmacy-orders', 201, rxOrder(id, 'rx-key-stale-01'));
      const oid7 = String(o.json.data.order._id);
      const copy = o.json.data.order.prescriptionUrls[0];
      // The prescription changes under the stored copy (its URL stays stored, its hash no longer matches).
      await BookingModel.updateOne({ _id: id }, { $set: { 'prescription.medicines': [{ name: 'Changed Med' }] } });
      assert.equal((await BookingModel.findById(id).lean() as any).prescription.dispensingCopy.url, copy);
      const direct = await call('P', 'GET', copy);
      assert.equal(direct.status, 200, 'still readable through the placed order');
      await PharmacyOrderModel.updateOne({ _id: oid7 }, { $set: { status: 'cancelled' } });
      assert.equal(await fileStatus('P', copy), 404, 'stale copy, cancelled order');
      await PharmacyOrderModel.updateOne({ _id: oid7 }, { $set: { status: 'rejected' } });
      assert.equal(await fileStatus('P', copy), 404, 'stale copy, rejected order');
      await PharmacyOrderModel.updateOne({ _id: oid7 }, { $set: { status: 'placed' } });
      await PharmacyModel.updateOne({ _id: P }, { $set: { isVerified: false } });
      try { assert.equal(await fileStatus('P', copy), 404, 'not operational'); } finally { await PharmacyModel.updateOne({ _id: P }, { $set: { isVerified: true } }); }
      assert.equal(await fileStatus('L', copy), 200, 'the patient keeps it');
      // The next read makes the copy of the prescription as it is now.
      const fresh = (await expect('P', 'GET', `/pharmacy-bookings/${id}`, 200)).json.data.prescription.fileUrls[0];
      assert.notEqual(fresh, copy); assert.ok(read(fresh).includes('Changed Med'));
    });

    await check('finding 1: payment verify / reconcile give the booking pharmacy the booker view; the customer keeps hers', async () => {
      const rec = await PaymentRecordModel.create({ userId: L, context: 'booking', contextId: b1, baseAmount: 300, discountAmount: 0, finalAmount: 300,
        currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'order_p0_b1', razorpayPaymentId: 'pay_p0_b1', status: 'paid', isProcessed: true,
        paidAt: new Date(), notes: { walletDeductedAmount: 0 } } as never);
      const recId = String((rec as any)._id);
      const r = await expect('P', 'POST', '/payments/reconcile', 200, { paymentTransactionId: recId });
      assert.equal(r.json.data.context, 'booking');
      assertBookerRow(r.json.data.entity);
      assert.deepEqual(r.json.data.entity.prescription.medicines.map((m: any) => m.name), ['Paracetamol 500']);
      const v = await expect('P', 'POST', '/payments/verify', 200, { paymentTransactionId: recId, razorpayOrderId: 'order_p0_b1',
        razorpayPaymentId: 'pay_p0_b1', razorpaySignature: 'bogus' });
      assertBookerRow(v.json.data.entity);
      const mine = await expect('L', 'POST', '/payments/reconcile', 200, { paymentTransactionId: recId });
      assert.equal(mine.json.data.entity.prescription.diagnosis, SECRET_DIAGNOSIS, 'the customer view is unchanged');
      await PharmacyModel.updateOne({ _id: P }, { $set: { isActive: false } });
      try {
        // Review of b4ae54e (item 10): a pharmacy that is not operational is answered 403, as on the booking reads.
        await expect('P', 'POST', '/payments/reconcile', 403, { paymentTransactionId: recId }, 'PHARMACY_INACTIVE');
      } finally { await PharmacyModel.updateOne({ _id: P }, { $set: { isActive: true } }); }
    });

    await check('finding 4: create, retry and reconcile-payments answers give the pharmacy the strict booker view', async () => {
      await BookingModel.updateOne({ _id: b5 }, { $set: { serviceAddress: { addressLine: 'SECRET-HOME-ADDRESS', city: 'x', pincode: '1' },
        followUp: { isFollowUp: false, benefitUsed: false, eligibilityExpiresAt: '20991231' }, corporateId: 'c'.repeat(24),
        virtualMeeting: { provider: 'google_meet', status: 'active', joinUrl: 'https://meet.example/SECRET-JOIN' } } });
      const rc = await expect('P', 'POST', `/bookings/${b5}/reconcile-payments`, 200);
      assertBookerRow(rc.json.data.booking);
      for (const t of ['SECRET-HOME-ADDRESS', 'SECRET-JOIN', 'eligibilityExpiresAt']) assert.equal(JSON.stringify(rc.json).includes(t), false, t);
      const made = await expect('P', 'POST', '/bookings/specialist', 201, { specialistId: D, ...(await futureSlot(31)), consultationMode: 'in-person',
        primaryConcern: 'fever', userId: L, notes: 'PATIENT-NOTE' });
      assertBookerRow(made.json.data.booking);
      assert.equal(JSON.stringify(made.json).includes('PATIENT-NOTE'), false);
      assert.equal(made.json.data.paymentRequired, true);
      const retry = await expect('P', 'POST', `/bookings/${made.json.data.booking._id}/retry-payment`, 200, {});
      assertBookerRow(retry.json.data.booking);
    });

    await check('finding 5: a pharmacy that is not operational gets 403 on every generic booking route', async () => {
      for (const [patch, code] of [[{ isVerified: false }, 'PHARMACY_NOT_VERIFIED'], [{ isActive: false }, 'PHARMACY_INACTIVE'],
        [{ archivedAt: new Date() }, 'PHARMACY_INACTIVE']] as [Record<string, unknown>, string][]) {
        await PharmacyModel.collection.updateOne({ _id: new Types.ObjectId(P) }, { $set: patch });
        try {
          await expect('P', 'GET', `/bookings/${b1}`, 403, undefined, code);
          await expect('P', 'GET', '/bookings', 403, undefined, code);
          await expect('P', 'GET', `/bookings/user/${L}`, 403, undefined, code);
          await expect('P', 'POST', `/bookings/${b1}/reconcile-payments`, 403, undefined, code);
          await expect('P', 'GET', `/bookings/${b1}/payment-details`, 403, undefined, code);
        } finally {
          await PharmacyModel.collection.updateOne({ _id: new Types.ObjectId(P) }, { $set: { isActive: true, isVerified: true }, $unset: { archivedAt: '' } });
        }
      }
      await expect('P', 'GET', `/bookings/${b1}`, 200);
    });

    await check('finding 8: pharmacy order lists and the review queue name customers as the booker view does', async () => {
      // T: an account P opened but whose holder signed in since (may have renamed it); W: a two-letter one-word name.
      const T = oid(); const W = oid();
      await UserModel.collection.insertMany([
        { _id: new Types.ObjectId(T), userType: 'user', phone: '9600000105', name: 'Tara RENAMED-BY-HOLDER', createdSource: 'pharmacy_app',
          linkedPharmacyId: P, otpVerified: true },
        { _id: new Types.ObjectId(W), userType: 'user', phone: '9600000106', name: 'Om', createdSource: 'self_signup' },
      ] as never);
      // The pharmacy's own tick (review of 800dfc0, item 2): it does not show the account name.
      await PharmacyCustomerModel.collection.insertMany([{ pharmacyId: new Types.ObjectId(P), userId: new Types.ObjectId(T), consent: 'patient_agreed' },
        { pharmacyId: new Types.ObjectId(P), userId: new Types.ObjectId(W), consent: 'patient_agreed' }] as never);
      for (const u of [T, W, S, L]) {
        await expect('P', 'POST', '/pharmacy-orders', 201, { orderType: 'in_store', customerId: u, items: [{ medicineId: MED, orderedQty: 1 }],
          paymentMode: 'in_store_payment', deliveryMode: 'pickup' });
      }
      const expected: Record<string, string> = { [T]: 'Tara R.', [W]: '…', [S]: 'Sunita D.', [L]: 'Lakshmi Devi Rao' };
      const list = await expect('P', 'GET', '/pharmacy-orders?limit=100', 200);
      const queue = await expect('P', 'GET', '/pharmacy-orders/prescription-reviews?limit=100', 200);
      for (const rows of [list.json.data, queue.json.data]) {
        for (const [u, name] of Object.entries(expected)) {
          const named = rows.filter((o: any) => String(o.customerId?._id) === u).map((o: any) => o.customerId.name);
          assert.ok(named.length > 0, `rows for ${name}`);
          assert.ok(named.every((n: string) => n === name), `${name}: ${JSON.stringify([...new Set(named)])}`);
        }
        const text = JSON.stringify(rows);
        for (const t of ['RENAMED-BY-HOLDER', 'sunita@example', 'Sunita Kumari']) assert.equal(text.includes(t), false, t);
      }
      // The booker view uses the same rule.
      const tb = await booking({ userId: T, pharmacyId: P }, 1);
      assert.equal((await expect('P', 'GET', `/pharmacy-bookings/${tb}`, 200)).json.data.patientName, 'Tara R.');
      // Admins still see the account.
      const adminToken = sign({ _id: oid(), userType: 'admin' });
      const adm = await fetch(`${base}/pharmacy-orders?limit=100&pharmacyId=${P}`, { headers: { authorization: 'Bearer ' + adminToken } }).then((x) => x.json()) as any;
      assert.ok(JSON.stringify(adm.data).includes('Sunita Kumari Das'));
    });

    await check('finding 9a: the copy internals (hash, time) are hidden from the patient and the doctor; the URL stays', async () => {
      for (const who of ['L', 'D'] as Who[]) {
        const r = await expect(who, 'GET', `/bookings/${b1}`, 200);
        assert.deepEqual(Object.keys(r.json.data.prescription.dispensingCopy), ['url'], `${who} sees the copy URL only`);
      }
    });

    await check('finding 9b: PUT cannot remove or replace the bound copy of an order made from a prescription', async () => {
      await expect('P', 'PUT', `/pharmacy-orders/${orderId}`, 409, { prescriptionUrls: [] }, 'ORDER_PRESCRIPTION_LOCKED');
      assert.deepEqual((await PharmacyOrderModel.findById(orderId).lean())?.prescriptionUrls, [b1Copy]);
      assert.equal(await fileStatus('P', b1Copy), 200);
    });

    await check('finding 9c: bookings stored without createdAt page after the dated ones, each exactly once', async () => {
      // Bookings stored without createdAt page after the dated ones, each exactly once (a page ends on the last dated row).
      const dated2 = await booking({ userId: L, pharmacyId: Q }, 2);
      const undated: string[] = [];
      for (let i = 0; i < 3; i++) {
        const _id = new Types.ObjectId(); undated.push(String(_id));
        await BookingModel.collection.insertOne({ _id, bookingType: 'consultation', userId: L, pharmacyId: Q, specialistId: D, bookingDate: istDay(1),
          bookingTime: '10:00 AM', serviceMode: 'video', price: 1, status: 'confirmed', paymentStatus: 'paid' } as never);
      }
      const rows = await listAll('Q');
      assert.deepEqual(rows.map((r) => r._id), [dated2, bQ, ...undated.sort().reverse()]);
    });
  } finally {
    server.close();
    await mongoose.disconnect();
    fs.rmSync(WORK, { recursive: true, force: true });
  }
  console.log(`${passed} checks passed, ${failed.length} failed`);
  if (failed.length) throw new Error('Assisted phase 0 checks failed: ' + failed.join('; '));
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
