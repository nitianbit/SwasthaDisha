/**
 * S4: a booking's `prescription` and `report` are server-owned. A create (customer, pharmacy or admin; every create route)
 * never stores them, nor any lifecycle / status / payment marker; patient-uploaded `documents[]` (type prescription /
 * report) stay. Only the doctor's own prescription endpoint writes the prescription (with lifecycle.prescriptionUploaded),
 * an admin edit may still write them, and no other role can edit them. A pharmacy order links only a consultation whose
 * prescription its doctor saved. The read-only audit lists pre-S4 rows by id.
 * Real authenticate + booking / specialist / pharmacy-order routers and services over HTTP against MongoDB; the payment
 * gateway, the PDF renderer, stock and catalogue are stubs.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/s4_server_fields_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/booking-scope/s4-server-fields.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import logger from '@/services/logger';
import UserModel from '@/modules/user/model';
import { UserRepository } from '@/modules/user/repository';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import SlotModel from '@/modules/slots/model';
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
import { SpecialistService } from '@/modules/specialists/services';
import { SpecialistPortalService } from '@/modules/specialistPortal/services';
import { FileUploadModel } from '@/modules/file/model/access';
import { errorHandler } from '@/modules/middleware';

const DB = 's4_server_fields_check';
const FIXTURE_URL = `mongodb://127.0.0.1:27917/${DB}?directConnection=true`;
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });

let passed = 0;
const failed: string[] = [];
/** Runs every check (a failure is reported and the next check still runs), so a run without the fix lists each gap. */
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.error('FAIL -', name, '\n  ', (e as Error).message.split('\n')[0]); }
}

let gatewayOrders = 0;
const fakeRazorpay = {
  orders: {
    create: async (o: { amount: number; currency: string }) => ({ id: 'order_s4_' + (++gatewayOrders), amount: o.amount, currency: o.currency, status: 'created' }),
    fetchPayments: async () => ({ items: [] }),
  },
  payments: { fetch: async () => { throw new Error('not used'); } },
};

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  await Promise.all([BookingModel.syncIndexes(), PharmacyCustomerModel.syncIndexes(), FileUploadModel.syncIndexes()]);

  // Doctors: docD is a real doctor whose name a forger would use; docE another doctor.
  const docD = oid(); const docE = oid();
  const doctors: Record<string, string> = { [docD]: 'Dr Real Doctor', [docE]: 'Dr Other' };
  await mongoose.connection.collection('specialists').insertMany(Object.entries(doctors).map(([id, name]) => ({ _id: new Types.ObjectId(id), name, isActive: true, isVerified: true })));
  const specialistService = { getById: async (id: string) => ({ _id: id, name: doctors[id] ?? 'Dr Unknown', isActive: true, isVerified: true, consultationFee: 100 }) };

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
  payments.getOrCreateActiveWallet = (PaymentService.prototype as unknown as Record<string, (...a: unknown[]) => unknown>).getOrCreateActiveWallet.bind(payments);
  const bookingService = Object.assign(Object.create(BookingService.prototype), {
    bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
    walletTransactionRepository: new WalletTransactionRepository(), userRepository: new UserRepository(),
    notificationService: { createBookingCreatedNotification: async () => undefined, createSpecialistNewBookingNotification: async () => undefined },
    paymentService: payments, couponService: {}, emailService: {},
    bookingReminderScheduler: { scheduleBookingReminders: async () => undefined, clearBookingReminders: async () => undefined },
    sendPaidBookingEmailNotification: async () => undefined,
    specialistService,
    wellnessPackageService: { getById: async (id: string) => ({ _id: id, name: 'Full body', isActive: true, originalPrice: 100, discountedPrice: 100 }) },
    slotService: { getById: async (id: string) => SlotModel.findById(id).lean() },
  }) as BookingService;
  Container.set(BookingService, bookingService);
  Container.set(DependentService, Object.assign(Object.create(DependentService.prototype), { dependentRepository: new DependentRepository() }));
  Container.set(SpecialistService, specialistService as unknown as SpecialistService);
  // The doctor's real prescription save; only the PDF renderer (wkhtmltopdf) is replaced by the path it would write.
  const portal = Object.assign(Object.create(SpecialistPortalService.prototype), {
    bookingRepository: new BookingRepository(), userRepository: new UserRepository(), specialistService, bookingService,
    notificationService: {}, slotService: {}, slotRepository: {},
    generatePrescriptionPdf: async (input: { booking: { _id: unknown } }) => `/api/static/bookings/${String(input.booking._id)}/prescription-${Date.now()}.pdf`,
  }) as SpecialistPortalService;
  Container.set(SpecialistPortalService, portal);
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
  const medicines = {
    findById: async () => ({ _id: MED, name: 'Vitamin D', isActive: true, prescriptionRequired: false, gstPercent: 0 }),
    findAll: async () => [{ _id: MED, name: 'Vitamin D', isActive: true, prescriptionRequired: false }],
  };
  const sideEffects = { queueNotification: async () => undefined, queueSubscriptionSync: async () => undefined };
  const refunds = new PrescriptionRefundService({ listRefunds: async () => [], fetchRefund: async () => { throw new Error('x'); },
    refund: async () => { throw new Error('x'); } } as never, new WalletRepository());
  Container.set(PharmacyOrderService, new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
    new PharmacyOrderRepository(), pharmacyCustomerService, inventory, payments, new BookingRepository(), {}, sideEffects, medicines, refunds));
  const { default: bookingRouter } = await import('@/modules/bookings/routes');
  const { default: specialistRouter } = await import('@/modules/specialists/routes');
  const { default: pharmacyOrderRouter } = await import('@/modules/pharmacyOrders/routes');
  const { authenticate } = await import('@/modules/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/bookings', authenticate, bookingRouter);
  app.use('/api/v1/specialists', authenticate, specialistRouter);
  app.use('/api/v1/pharmacy-orders', authenticate, pharmacyOrderRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;

  // Warnings written by the code under test.
  const warnings: { message: string; meta: unknown }[] = [];
  const realWarn = logger.warn.bind(logger);
  (logger as unknown as { warn: (m: string, meta?: unknown) => unknown }).warn = (message: string, meta?: unknown) => {
    warnings.push({ message, meta }); return realWarn(message, meta as never);
  };

  try {
    const cust = oid(); const cust2 = oid();
    await UserModel.collection.insertMany([
      { _id: new Types.ObjectId(cust), userType: 'user', phone: '9600000401', name: 'Patient', isActive: true },
      { _id: new Types.ObjectId(cust2), userType: 'user', phone: '9600000402', name: 'Patient Two', isActive: true },
    ] as never);
    const pharm = oid();
    await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(pharm), name: 'Pharmacy', phone: '9700000401', isActive: true, isVerified: true } as never);
    // The pharmacy's customer, linked with the patient's consent (as every later hotfix line requires to book or order).
    await PharmacyCustomerModel.collection.insertOne({ pharmacyId: new Types.ObjectId(pharm), userId: new Types.ObjectId(cust), consent: 'patient_agreed' } as never);
    const tokens = {
      cust: sign({ _id: cust, userType: 'user' }),
      pharm: sign({ _id: pharm, pharmacyId: pharm, userType: 'pharmacy' }),
      docD: sign({ _id: docD, specialistId: docD, userType: 'specialist' }),
      docE: sign({ _id: docE, specialistId: docE, userType: 'specialist' }),
      admin: sign({ _id: oid(), userType: 'admin' }),
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
    let day = 0;
    const slot = async (specialistId?: string, wellnessPackageId?: string) => {
      const date = `2099${String(1 + Math.floor(day / 28)).padStart(2, '0')}${String(1 + (day % 28)).padStart(2, '0')}`; day++;
      const doc = await SlotModel.create({ ...(specialistId ? { specialistId } : { wellnessPackageId }), date, startTime: '10:00 AM', endTime: '10:15 AM',
        duration: 15, maxBookings: 5, currentBookings: 0, isActive: true, isAvailable: true, slotType: specialistId ? 'consultation' : 'wellnessPackage' } as never);
      return { slotId: String(doc._id), date };
    };
    const consult = async (extra: Record<string, unknown> = {}) => {
      const { slotId, date } = await slot(docD);
      return { specialistId: docD, slotId, bookingDate: date, bookingTime: '10:00 AM', consultationMode: 'in-person', primaryConcern: 'fever', ...extra };
    };
    const pkg = async (extra: Record<string, unknown> = {}) => {
      const wellnessPackageId = oid();
      const { slotId, date } = await slot(undefined, wellnessPackageId);
      return { wellnessPackageId, slotId, bookingDate: date, bookingTime: '10:00 AM', serviceMode: 'in-person', ...extra };
    };
    const surgery = (extra: Record<string, unknown> = {}) => ({ bookingType: 'surgery', bookingDate: '20991230', bookingTime: '10:00 AM', ...extra });

    // A file the attacker uploaded itself (so the file-binding check would have let it through before S4).
    const forgedFile = `general/forged-rx-${oid()}.pdf`;
    for (const [who, id] of [['user', cust], ['pharmacy', pharm], ['admin', 'admin']]) {
      await FileUploadModel.create({ path: forgedFile.replace('forged', 'forged-' + who), uploaderType: who, uploaderId: id, createdAt: new Date() });
    }
    const fileOf = (who: string) => '/api/static/' + forgedFile.replace('forged', 'forged-' + who);
    // What a forger sends: the doctor's prescription naming a real doctor, a lab report, and every server marker.
    const forged = (who: string) => ({
      prescription: { prescribedBySpecialistId: docD, prescribedBySpecialistName: 'Dr Real Doctor', prescribedAt: '2026-11-01T10:00:00.000Z',
        diagnosis: 'forged', medicines: [{ name: 'Alprazolam', dosage: '2mg', frequency: 'thrice daily' }], fileUrls: [fileOf(who)] },
      report: { message: 'forged lab report', fileUrls: [fileOf(who)] },
      status: 'completed', paymentStatus: 'paid', settlementSystem: 'clinic', price: 0, originalPrice: 0,
      lifecycle: { prescriptionUploaded: { at: '2026-11-01T10:00:00.000Z' }, paid: { at: '2026-11-01T10:00:00.000Z' } },
      prescriptionUploaded: true, holds: { version: 1 }, createTerms: { basePrice: 0 }, walletFunding: { total: 100 },
    });
    // The patient's own past records, uploaded by the patient: kept.
    const ownDocs = (who: string) => [{ type: 'prescription', url: fileOf(who), fileName: 'old-rx.pdf' }, { type: 'report', url: fileOf(who), fileName: 'old-lab.pdf' }];

    const assertServerOwned = async (id: string, expected: { status: string; paymentStatus: string }) => {
      const b = await BookingModel.findById(id).lean() as any;
      assert.ok(b, 'booking stored');
      assert.equal(b.prescription, undefined, 'no prescription stored');
      assert.equal(b.report, undefined, 'no report stored');
      assert.equal(b.lifecycle?.prescriptionUploaded, undefined, 'no prescriptionUploaded marker');
      assert.equal(b.lifecycle?.paid?.at === '2026-11-01T10:00:00.000Z', false, 'lifecycle is the server\'s');
      assert.equal(b.status, expected.status); assert.equal(b.paymentStatus, expected.paymentStatus);
      // (Where the server records a settlement system, as on the stage line, it is its own choice, never the client's.)
      assert.notEqual(b.settlementSystem, 'clinic'); assert.equal(b.prescriptionUploaded, undefined); assert.equal(b.walletFunding?.total ?? 0, 0);
      return b;
    };
    const dropWarned = (route: string, userType: string) => {
      const w = warnings.find((x) => x.message.includes('S4') && JSON.stringify(x.meta).includes(`"route":"${route}"`) &&
        JSON.stringify(x.meta).includes(`"userType":"${userType}"`));
      assert.ok(w, `a warning for ${userType} ${route}`);
      assert.deepEqual((w!.meta as { fields: string[] }).fields.sort(), ['prescription', 'report']);
      const text = JSON.stringify(w);
      for (const secret of [cust, pharm, docD, 'Alprazolam', 'forged', 'Dr Real Doctor']) assert.equal(text.includes(secret), false, 'no ids or content logged');
    };

    await check('customer creates (every route) store no prescription, report or server marker; own documents kept', async () => {
      const made: [string, string, { status: string; paymentStatus: string }][] = [];
      const r1 = await expect('cust', 'POST', '/bookings/specialist', 201, { ...(await consult()), ...forged('user'), documents: ownDocs('user') });
      made.push(['/specialist', String(r1.json.data.booking._id), { status: 'pending', paymentStatus: 'pending' }]);
      const r2 = await expect('cust', 'POST', '/bookings', 201, { ...(await consult()), bookingType: 'consultation', ...forged('user'), documents: ownDocs('user') });
      made.push(['/', String(r2.json.data.booking._id), { status: 'pending', paymentStatus: 'pending' }]);
      const r3 = await expect('cust', 'POST', '/bookings/wellness-package', 201, { ...(await pkg()), ...forged('user'), documents: ownDocs('user') });
      made.push(['/wellness-package', String(r3.json.data.booking._id), { status: 'pending', paymentStatus: 'pending' }]);
      const r4 = await expect('cust', 'POST', '/bookings', 201, { ...surgery(), ...forged('user'), documents: ownDocs('user') });
      made.push(['/', String(r4.json.data.booking._id), { status: 'confirmed', paymentStatus: 'paid' }]);
      for (const [route, id, expected] of made) {
        const b = await assertServerOwned(id, expected);
        assert.equal(b.userId, cust);
        assert.deepEqual(b.documents.map((d: { type: string }) => d.type), ['prescription', 'report'], 'patient documents kept');
        dropWarned(route, 'user');
      }
      // An empty object (or null) is dropped the same way, never refused.
      const r5 = await expect('cust', 'POST', '/bookings', 201, { ...surgery(), prescription: {}, report: null });
      await assertServerOwned(String(r5.json.data.booking._id), { status: 'confirmed', paymentStatus: 'paid' });
    });

    await check('pharmacy creates (every route) store no prescription, report or server marker', async () => {
      const r1 = await expect('pharm', 'POST', '/bookings/specialist', 201, { ...(await consult()), userId: cust, ...forged('pharmacy') });
      const r2 = await expect('pharm', 'POST', '/bookings', 201, { ...(await consult()), bookingType: 'consultation', userId: cust, ...forged('pharmacy') });
      const r3 = await expect('pharm', 'POST', '/bookings/wellness-package', 201, { ...(await pkg()), userId: cust, ...forged('pharmacy') });
      for (const r of [r1, r2, r3]) {
        const b = await assertServerOwned(String(r.json.data.booking._id), { status: 'pending', paymentStatus: 'pending' });
        assert.equal(b.pharmacyId, pharm);
      }
      dropWarned('/specialist', 'pharmacy'); dropWarned('/', 'pharmacy'); dropWarned('/wellness-package', 'pharmacy');
    });

    await check('admin creates store no prescription or report either (an admin edit is the place for them)', async () => {
      const r = await expect('admin', 'POST', '/bookings/specialist', 201, { ...(await consult()), userId: cust, ...forged('admin') });
      await assertServerOwned(String(r.json.data.booking._id), { status: 'pending', paymentStatus: 'pending' });
      dropWarned('/specialist', 'admin');
    });

    // A consultation of cust with docD, for the doctor's save, edits and order links.
    const bookingOf = async () => String((await expect('cust', 'POST', '/bookings/specialist', 201, await consult())).json.data.booking._id);
    const rxBooking = await bookingOf();

    await check("the doctor's own prescription save still works and sets the server marker", async () => {
      // Another doctor cannot write it.
      await expect('docE', 'POST', `/specialists/me/appointments/${rxBooking}/prescription`, 404,
        { diagnosis: 'x', medicines: [{ name: 'Paracetamol' }], advice: 'rest' }, 'BOOKING_NOT_FOUND');
      const r = await expect('docD', 'POST', `/specialists/me/appointments/${rxBooking}/prescription`, 200,
        { diagnosis: 'Viral fever', medicines: [{ name: 'Paracetamol', dosage: '500mg' }], testsAdvised: ['CBC'], advice: 'rest', message: 'get well' });
      assert.equal(r.json.data.prescription.diagnosis, 'Viral fever');
      const b = await BookingModel.findById(rxBooking).lean() as any;
      assert.equal(b.prescription.prescribedBySpecialistId, docD);
      assert.equal(b.prescription.prescribedBySpecialistName, 'Dr Real Doctor');
      assert.match(b.prescription.fileUrls[0], new RegExp(`^/api/static/bookings/${rxBooking}/prescription-\\d+\\.pdf$`));
      assert.ok(b.lifecycle.prescriptionUploaded.at, 'marker set');
    });

    await check('edits: customer (notes only), doctor and pharmacy cannot write prescription/report; admin still can', async () => {
      const editable = await bookingOf();
      const before = JSON.stringify(await BookingModel.findById(editable).lean());
      await expect('cust', 'PUT', '/bookings/' + editable, 422, { prescription: forged('user').prescription }, 'FORBIDDEN_FIELD');
      await expect('cust', 'PUT', '/bookings/' + editable, 422, { notes: 'n', report: { message: 'forged' } }, 'FORBIDDEN_FIELD');
      await expect('docD', 'PUT', '/bookings/' + editable, 403, { prescription: { diagnosis: 'x' } });
      await expect('pharm', 'PUT', '/bookings/' + editable, 403, { report: { message: 'x' } });
      assert.equal(JSON.stringify(await BookingModel.findById(editable).lean()), before, 'booking unchanged');
      await expect('cust', 'PUT', '/bookings/' + editable, 200, { notes: 'please call first' });
      // Admin edit: report and status (the admin panel's status change) as before; payment status stays a dedicated command.
      await expect('admin', 'PUT', '/bookings/' + editable, 200, { report: { message: 'reviewed by admin' }, status: 'confirmed' });
      const b = await BookingModel.findById(editable).lean() as any;
      assert.equal(b.report.message, 'reviewed by admin'); assert.equal(b.status, 'confirmed');
      await expect('admin', 'PUT', '/bookings/' + editable, 409, { paymentStatus: 'paid' }, 'DEDICATED_BOOKING_COMMAND_REQUIRED');
      // An admin-written prescription carries no doctor marker.
      await expect('admin', 'PUT', '/bookings/' + editable, 200, { prescription: { diagnosis: 'typed by admin' } });
      assert.equal((await BookingModel.findById(editable).lean() as any).lifecycle?.prescriptionUploaded, undefined);
    });

    // Pre-S4 rows (written straight to the collection, as a client could before S4).
    const legacy = async (fields: Record<string, unknown>) => (await BookingModel.collection.insertOne({ userId: cust, specialistId: docD,
      bookingType: 'consultation', status: 'completed', paymentStatus: 'paid', price: 100, bookingDate: '20261101', bookingTime: '10:00 AM',
      createdAt: new Date(), updatedAt: new Date(), ...fields } as never)).insertedId.toHexString();
    const clientRx = await legacy({ prescription: { prescribedBySpecialistId: docD, prescribedBySpecialistName: 'Dr Real Doctor', diagnosis: 'forged',
      medicines: [{ name: 'Alprazolam' }] } });
    const otherPrescriber = await legacy({ prescription: { prescribedBySpecialistId: docE, diagnosis: 'x' },
      lifecycle: { prescriptionUploaded: { at: '2026-11-01T10:00:00.000Z' } } });
    const clientReport = await legacy({ report: { message: 'forged lab report' } });
    const noRx = await legacy({});

    const order = (linkedConsultationId?: string) => ({ orderType: 'in_store', customerId: cust, ...(linkedConsultationId ? { linkedConsultationId } : {}),
      items: [{ medicineId: MED, orderedQty: 1 }], paymentMode: 'in_store_payment', deliveryMode: 'pickup' });

    await check("a pharmacy order links only a consultation with its doctor's saved prescription", async () => {
      const before = await PharmacyOrderModel.countDocuments();
      for (const id of [clientRx, otherPrescriber, noRx]) {
        await expect('pharm', 'POST', '/pharmacy-orders', 400, order(id), 'CONSULTATION_PRESCRIPTION_REQUIRED');
      }
      assert.equal(await PharmacyOrderModel.countDocuments(), before, 'no order created');
      const ok = await expect('pharm', 'POST', '/pharmacy-orders', 201, order(rxBooking));
      assert.equal(String(ok.json.data.order.linkedConsultationId), rxBooking);
      // Update: a new link to a client-written prescription is refused; the doctor's one is accepted.
      const plain = await expect('pharm', 'POST', '/pharmacy-orders', 201, order());
      const id = String(plain.json.data.order._id);
      await expect('pharm', 'PUT', '/pharmacy-orders/' + id, 400, { linkedConsultationId: clientRx }, 'CONSULTATION_PRESCRIPTION_REQUIRED');
      assert.equal((await PharmacyOrderModel.findById(id).lean())?.linkedConsultationId, undefined);
      await expect('pharm', 'PUT', '/pharmacy-orders/' + id, 200, { linkedConsultationId: rxBooking });
      // An order already linked before S4 is not stranded: its other edits still work.
      const old = await PharmacyOrderModel.findById(String(ok.json.data.order._id)).lean() as any;
      await PharmacyOrderModel.collection.updateOne({ _id: old._id }, { $set: { linkedConsultationId: new Types.ObjectId(clientRx) } });
      await expect('pharm', 'PUT', '/pharmacy-orders/' + String(old._id), 200, { notes: 'call before delivery' });
      await expect('pharm', 'PUT', '/pharmacy-orders/' + String(old._id), 200, { linkedConsultationId: clientRx, notes: 'same link' });
    });

    await check('the audit lists pre-S4 client prescriptions and reports by id only and writes nothing', async () => {
      const snapshot = async () => JSON.stringify(await Promise.all(['bookings', 'pharmacyorders', 'pharmacy_orders', 'file_grants']
        .map((c) => mongoose.connection.db.collection(c).find().sort({ _id: 1 }).toArray())));
      const before = await snapshot();
      const { auditS4ClientPrescriptions } = await import('@/scripts/auditS4ClientPrescriptions');
      const report = await auditS4ClientPrescriptions();
      const byId = new Map(report.bookings.map((b) => [b.bookingId, b.reasons]));
      assert.deepEqual(byId.get(clientRx), ['prescriptionWithoutMarker']);
      assert.deepEqual(byId.get(otherPrescriber), ['prescriberNotSpecialist']);
      assert.deepEqual(byId.get(clientReport), ['report']);
      assert.equal(byId.has(rxBooking), false, "the doctor's own prescription is not listed");
      assert.equal(byId.has(noRx), false);
      // The order linked (above, directly in the collection) to the client-written prescription is listed.
      assert.ok(report.linkedPharmacyOrders.some((o) => o.bookingId === clientRx));
      const text = JSON.stringify(report);
      for (const secret of ['Alprazolam', 'forged', 'Dr Real Doctor', 'Patient', '9600000401', '/api/static']) assert.equal(text.includes(secret), false, 'ids only: ' + secret);
      assert.equal(await snapshot(), before, 'nothing written');
      // The npm entry runs the same read against the same database and prints the same rows.
      const out = execFileSync('npm', ['run', '-s', 'audit:s4-client-prescriptions'], { env: { ...process.env, MONGODB_URL: FIXTURE_URL }, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'] });
      const cli = JSON.parse(out) as typeof report;
      assert.deepEqual(cli.bookings, report.bookings);
      assert.equal(await snapshot(), before, 'nothing written by the npm run');
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`${passed} checks passed, ${failed.length} failed`);
  if (failed.length) throw new Error('S4 checks failed: ' + failed.join('; '));
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
