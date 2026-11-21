/**
 * S3: a pharmacy books only for a customer linked to it, only while operational and verified, never from that
 * customer's wallet and never with the customer's free follow-up; its dependentId must be that customer's; a create key
 * replays only its own creator's booking. Patient tracking shows only the caller pharmacy's orders. Linking a customer
 * by phone records the patient's consent and never replaces an existing user's linkedPharmacyId. Also: the follow-up
 * lookup answers missing and not-yours alike, /upcoming needs a token with an id, and a doctor who booked as a customer
 * reaches that booking again.
 * Real authenticate + booking / pharmacy-customers / patient-tracking routers + services over HTTP against MongoDB; the
 * payment gateway is a stub.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/s3_pharmacy_scope_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/booking-scope/s3-pharmacy-scope.integration.ts
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
import { WalletModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import { PharmacyCustomerRepository } from '@/modules/pharmacyCustomers/repository';
import { PharmacyCustomerService } from '@/modules/pharmacyCustomers/services';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacySubscriptionRepository } from '@/modules/pharmacySubscriptions/repository';
import { OrderHealthCheckRepository } from '@/modules/orderHealthChecks/repository';
import { PatientTrackingService } from '@/modules/patientTracking/services';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import { PrescriptionRefundService } from '@/modules/pharmacyOrders/prescriptionRefund';
import PharmacyCartModel from '@/modules/pharmacyCart/model';
import { PharmacyCartRepository } from '@/modules/pharmacyCart/repository';
import { PharmacyCartService } from '@/modules/pharmacyCart/services';
import { errorHandler } from '@/modules/middleware';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/s3_pharmacy_scope_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
const DATE = '20991231';

let passed = 0;
const failed: string[] = [];
/** Runs every check (a failure is reported and the next check still runs), so a run without the fix lists each gap. */
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.error('FAIL -', name, '\n  ', (e as Error).message.split('\n')[0]); }
}

// Payment gateway stub: orders are created; no attempt has a capture.
let orders = 0;
const fakeRazorpay = {
  orders: {
    create: async (o: { amount: number; currency: string }) => ({ id: 'order_s3_' + (++orders), amount: o.amount, currency: o.currency, status: 'created' }),
    fetchPayments: async () => ({ items: [] }),
  },
  payments: { fetch: async () => { throw new Error('not used'); } },
};

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  await Promise.all([BookingModel.syncIndexes(), PharmacyCustomerModel.syncIndexes()]);

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
    specialistService: { getById: async (id: string) => ({ _id: id, name: 'Dr S3', isActive: true, consultationFee: 100 }) },
    slotService: { getById: async (id: string) => SlotModel.findById(id).lean() },
  }) as BookingService;
  Container.set(BookingService, bookingService);
  Container.set(DependentService, Object.assign(Object.create(DependentService.prototype), { dependentRepository: new DependentRepository() }));
  const pharmacyCustomerService = Object.assign(Object.create(PharmacyCustomerService.prototype), {
    pharmacyCustomerRepo: new PharmacyCustomerRepository(), pharmacyRepo: new PharmacyRepository(), userRepo: new UserRepository(),
  }) as PharmacyCustomerService;
  Container.set(PharmacyCustomerService, pharmacyCustomerService);
  Container.set(PatientTrackingService, Object.assign(Object.create(PatientTrackingService.prototype), {
    customerService: pharmacyCustomerService, orderRepo: new PharmacyOrderRepository(),
    subscriptionRepo: new PharmacySubscriptionRepository(), orderHealthCheckRepo: new OrderHealthCheckRepository(),
  }));
  // Pharmacy orders: real order and cart services with the real PharmacyCustomerService; stock, catalogue and payment
  // are fakes (in-store orders take no online payment; a customer's checkout is cash on delivery).
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
  const orderService = new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
    new PharmacyOrderRepository(), pharmacyCustomerService, inventory, payments, new BookingRepository(), {}, sideEffects, medicines, refunds);
  Container.set(PharmacyOrderService, orderService);
  const cartService = new (PharmacyCartService as unknown as new (...a: unknown[]) => PharmacyCartService)(
    new PharmacyCartRepository(), inventory, {}, medicines, orderService);
  Object.assign(cartService as unknown as Record<string, unknown>, { ensureTargetPharmacyAccessible: async () => undefined,
    buildCartItem: async (_role: string, _p: string, medicineId: string, quantity: number) =>
      ({ medicineId, medicineName: 'Vitamin D', quantity, unitPrice: 50, lineTotal: 50 * quantity, prescriptionRequired: false }) });
  const { default: pharmacyOrderRouter } = await import('@/modules/pharmacyOrders/routes');
  const { default: bookingRouter } = await import('@/modules/bookings/routes');
  const { default: pharmacyCustomerRouter } = await import('@/modules/pharmacyCustomers/routes');
  const { default: patientTrackingRouter } = await import('@/modules/patientTracking/routes');
  const { authenticate } = await import('@/modules/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/bookings', authenticate, bookingRouter);
  app.use('/api/v1/pharmacy-customers', authenticate, pharmacyCustomerRouter);
  app.use('/api/v1/patient-tracking', authenticate, patientTrackingRouter);
  app.use('/api/v1/pharmacy-orders', authenticate, pharmacyOrderRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;

  try {
    // Customers: V (victim, not linked to pharmV), L (linked to pharmV), X (self sign-up, linked to pharmW).
    const V = oid(); const L = oid(); const X = oid(); const Y = oid();
    await UserModel.collection.insertMany([
      { _id: new Types.ObjectId(V), userType: 'user', phone: '9600000001', name: 'Victim', createdSource: 'self_signup' },
      { _id: new Types.ObjectId(L), userType: 'user', phone: '9600000002', name: 'Linked', createdSource: 'self_signup' },
      { _id: new Types.ObjectId(X), userType: 'user', phone: '9600000003', name: 'Other', createdSource: 'self_signup' },
      { _id: new Types.ObjectId(Y), userType: 'user', phone: '9600000004', name: 'Unlinked', createdSource: 'self_signup' },
    ] as never);
    for (const u of [V, L]) await WalletModel.create({ userId: u, balance: 500, isActive: true });
    const balance = async (u: string) => Number((await WalletModel.findOne({ userId: u }).lean())?.balance);

    // Pharmacies: pharmV and pharmW verified, pharmU self-created and unverified.
    const pharmV = oid(); const pharmW = oid(); const pharmU = oid();
    await PharmacyModel.collection.insertMany([
      { _id: new Types.ObjectId(pharmV), name: 'Verified', phone: '9700000001', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(pharmW), name: 'Other verified', phone: '9700000002', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(pharmU), name: 'Unverified', phone: '9700000003', isActive: true, isVerified: false },
    ] as never);
    await PharmacyCustomerModel.collection.insertMany([
      { pharmacyId: new Types.ObjectId(pharmV), userId: new Types.ObjectId(L), consent: 'patient_agreed' },
      { pharmacyId: new Types.ObjectId(pharmW), userId: new Types.ObjectId(V), consent: 'patient_agreed' },
    ] as never);
    await UserModel.collection.updateOne({ _id: new Types.ObjectId(X) }, { $set: { linkedPharmacyId: pharmW } });

    const specS = oid(); const docD = oid(); const docE = oid();
    const tokens = {
      V: sign({ _id: V, userType: 'user' }), L: sign({ _id: L, userType: 'user' }),
      pharmV: sign({ _id: pharmV, pharmacyId: pharmV, userType: 'pharmacy' }),
      pharmW: sign({ _id: pharmW, pharmacyId: pharmW, userType: 'pharmacy' }),
      pharmU: sign({ _id: pharmU, pharmacyId: pharmU, userType: 'pharmacy' }),
      docD: sign({ _id: docD, specialistId: docD, userType: 'specialist' }),
      docE: sign({ _id: docE, specialistId: docE, userType: 'specialist' }),
      noId: sign({ specialistId: docE, userType: 'specialist' }),
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
    // Each consultation gets its own day, so no two bookings of the doctor overlap (the stage line refuses a busy doctor).
    let day = 0;
    const slot = async () => {
      const date = `2099${String(1 + Math.floor(day / 28)).padStart(2, '0')}${String(1 + (day % 28)).padStart(2, '0')}`; day++;
      const doc = await SlotModel.create({ specialistId: specS, date, startTime: '10:00 AM', endTime: '10:15 AM',
        duration: 15, maxBookings: 1, currentBookings: 0, isActive: true, isAvailable: true, slotType: 'consultation' } as never);
      return { slotId: String(doc._id), date };
    };
    const consult = async (extra: Record<string, unknown> = {}) => {
      const { slotId, date } = await slot();
      return { specialistId: specS, slotId, bookingDate: date, bookingTime: '10:00 AM', consultationMode: 'in-person', primaryConcern: 'fever', ...extra };
    };
    const count = () => BookingModel.countDocuments();

    // Dependents and completed consultations with an unused free follow-up.
    const depL = String((await DependentModel.create({ userId: L, name: 'Child of L', relationship: 'Son', isActive: true } as never))._id);
    const depV = String((await DependentModel.create({ userId: V, name: 'Child of V', relationship: 'Son', isActive: true } as never))._id);
    const parent = async (userId: string) => (await BookingModel.collection.insertOne({ userId, specialistId: specS, bookingType: 'consultation',
      status: 'completed', paymentStatus: 'paid', price: 100, bookingDate: '20261101', bookingTime: '10:00 AM',
      followUp: { isFollowUp: false, benefitUsed: false, completedAt: '20261101', eligibilityExpiresAt: DATE },
      createdAt: new Date(), updatedAt: new Date() } as never)).insertedId.toHexString();
    const parentV = await parent(V); const parentL = await parent(L);
    const benefitUsed = async (id: string) => (await BookingModel.findById(id).lean() as { followUp?: { benefitUsed?: boolean } }).followUp?.benefitUsed;

    await check('1 an unverified self-created pharmacy cannot book (no booking, no wallet debit)', async () => {
      const before = await count();
      for (const path of ['/bookings/specialist', '/bookings']) {
        await expect('pharmU', 'POST', path, 403, { ...(await consult()), bookingType: 'consultation', userId: V, useWalletBalance: true }, 'PHARMACY_NOT_VERIFIED');
      }
      await expect('pharmU', 'POST', '/bookings/wellness-package', 403,
        { userId: V, wellnessPackageId: oid(), slotId: oid(), bookingDate: DATE, bookingTime: '10:00 AM', serviceMode: 'in-person', useWalletBalance: true }, 'PHARMACY_NOT_VERIFIED');
      assert.equal(await count(), before);
      assert.equal(await balance(V), 500);
    });

    await check('1 a verified pharmacy cannot book for a customer not linked to it', async () => {
      const before = await count();
      for (const body of [{ userId: V, useWalletBalance: true }, { userId: V }, { userId: Y }, { userId: oid() }, { userId: 'not-an-id' }]) {
        await expect('pharmV', 'POST', '/bookings/specialist', 403, { ...(await consult()), ...body }, 'CUSTOMER_NOT_LINKED');
      }
      await expect('pharmV', 'POST', '/bookings', 403, { ...(await consult()), bookingType: 'consultation', userId: V }, 'CUSTOMER_NOT_LINKED');
      await expect('pharmV', 'POST', '/bookings/wellness-package', 403,
        { userId: V, wellnessPackageId: oid(), slotId: oid(), bookingDate: DATE, bookingTime: '10:00 AM', serviceMode: 'in-person' }, 'CUSTOMER_NOT_LINKED');
      await expect('pharmV', 'POST', '/bookings/specialist', 400, await consult(), 'USER_ID_REQUIRED');
      assert.equal(await count(), before);
      assert.equal(await balance(V), 500);
    });

    await check("1 a pharmacy never pays from the customer's wallet, even for its own linked customer", async () => {
      const before = await count();
      await expect('pharmV', 'POST', '/bookings/specialist', 403, { ...(await consult()), userId: L, useWalletBalance: true }, 'PHARMACY_WALLET_NOT_ALLOWED');
      await expect('pharmV', 'POST', '/bookings', 403, { ...(await consult()), bookingType: 'consultation', userId: L, useWalletBalance: true },
        'PHARMACY_WALLET_NOT_ALLOWED');
      await expect('pharmV', 'POST', '/bookings/wellness-package', 403,
        { userId: L, wellnessPackageId: oid(), slotId: oid(), bookingDate: DATE, bookingTime: '10:00 AM', serviceMode: 'in-person', useWalletBalance: true }, 'PHARMACY_WALLET_NOT_ALLOWED');
      assert.equal(await count(), before);
      assert.equal(await balance(L), 500);
    });

    await check("1 a pharmacy cannot use a customer's free follow-up (linked or not)", async () => {
      await expect('pharmV', 'POST', '/bookings/specialist', 403,
        { ...(await consult()), userId: L, followUp: { isFollowUp: true, parentConsultationId: parentL } }, 'PHARMACY_FOLLOW_UP_NOT_ALLOWED');
      await expect('pharmV', 'POST', '/bookings', 403, { ...(await consult()), bookingType: 'consultation', userId: L,
        followUp: { isFollowUp: true, parentConsultationId: parentL } }, 'PHARMACY_FOLLOW_UP_NOT_ALLOWED');
      await expect('pharmV', 'POST', '/bookings/specialist', 403,
        { ...(await consult()), userId: V, followUp: { isFollowUp: true, parentConsultationId: parentV } }, 'CUSTOMER_NOT_LINKED');
      // pharmW is linked to V: still no follow-up.
      await expect('pharmW', 'POST', '/bookings/specialist', 403,
        { ...(await consult()), userId: V, followUp: { isFollowUp: true, parentConsultationId: parentV } }, 'PHARMACY_FOLLOW_UP_NOT_ALLOWED');
      assert.equal(await benefitUsed(parentL), false);
      assert.equal(await benefitUsed(parentV), false);
    });

    let pharmBooking = '';
    await check("1 a pharmacy's dependentId must belong to the customer; legitimate booking still works (no wallet)", async () => {
      await expect('pharmV', 'POST', '/bookings/specialist', 404, { ...(await consult()), userId: L, dependentId: depV }, 'DEPENDENT_NOT_FOUND');
      await expect('pharmV', 'POST', '/bookings/specialist', 404, { ...(await consult()), userId: L, dependentId: 'bad' }, 'DEPENDENT_NOT_FOUND');
      const ok = await expect('pharmV', 'POST', '/bookings/specialist', 201, { ...(await consult()), userId: L, dependentId: depL, useWalletBalance: false });
      const b = ok.json.data.booking;
      assert.equal(ok.json.data.paymentRequired, true);
      assert.equal(b.userId, L); assert.equal(b.pharmacyId, pharmV); assert.equal(b.dependentId, depL);
      assert.equal(ok.json.data.walletDeductedAmount, 0);
      assert.equal(await balance(L), 500);
      pharmBooking = String(b._id);
    });

    await check('1 a pharmacy retry never adds wallet funding; a plain retry of its own booking works', async () => {
      await expect('pharmV', 'POST', `/bookings/${pharmBooking}/retry-payment`, 403, { useWalletBalance: true }, 'PHARMACY_WALLET_NOT_ALLOWED');
      assert.equal(await balance(L), 500);
      const r = await expect('pharmV', 'POST', `/bookings/${pharmBooking}/retry-payment`, 200, {});
      assert.equal(r.json.data.paymentRequired, true);
      assert.equal(await balance(L), 500);
    });

    await check('1 customers keep their own wallet, follow-up and dependent bookings', async () => {
      const own = await expect('L', 'POST', '/bookings/specialist', 201, { ...(await consult()), useWalletBalance: true, dependentId: depL });
      assert.equal(own.json.data.paymentRequired, false);
      assert.equal(await balance(L), 400);
      await expect('L', 'POST', '/bookings/specialist', 404, { ...(await consult()), dependentId: depV }, 'DEPENDENT_NOT_FOUND');
      const fu = await expect('L', 'POST', '/bookings/specialist', 201, { ...(await consult()), followUp: { isFollowUp: true, parentConsultationId: parentL } });
      assert.equal(fu.json.data.booking.followUp.isFollowUp, true);
      assert.equal(await benefitUsed(parentL), true);
    });

    await check("4 a keyed create replay is scoped to its creator (the victim's booking is not returned)", async () => {
      const mine = await expect('V', 'POST', '/bookings', 201, { ...(await consult()), bookingType: 'consultation', requestKey: 'victim-key-0001' });
      const victimBooking = String(mine.json.data.booking._id);
      // pharmW is linked to V, so it passes the link gate; the key is V's own.
      const r = await expect('pharmW', 'POST', '/bookings', 409, { ...(await consult()), bookingType: 'consultation', userId: V, requestKey: 'victim-key-0001' },
        'CREATE_REQUEST_KEY_CONFLICT');
      assert.equal(JSON.stringify(r.json).includes(victimBooking), false);
      // The owner's own resend still replays.
      const again = await expect('V', 'POST', '/bookings', 201, { ...(await consult()), bookingType: 'consultation', requestKey: 'victim-key-0001' });
      assert.equal(String(again.json.data.booking._id), victimBooking); assert.equal(again.json.data.replayed, true);
      // A pharmacy's own resend replays its own booking; another creator (the customer) using that key is refused.
      const p1 = await expect('pharmW', 'POST', '/bookings', 201, { ...(await consult()), bookingType: 'consultation', userId: V, requestKey: 'pharm-key-0001' });
      const p2 = await expect('pharmW', 'POST', '/bookings', 201, { ...(await consult()), bookingType: 'consultation', userId: V, requestKey: 'pharm-key-0001' });
      assert.equal(String(p2.json.data.booking._id), String(p1.json.data.booking._id)); assert.equal(p2.json.data.replayed, true);
      await expect('V', 'POST', '/bookings', 409, { ...(await consult()), bookingType: 'consultation', requestKey: 'pharm-key-0001' }, 'CREATE_REQUEST_KEY_CONFLICT');
      assert.equal(await balance(V), 500);
    });

    await check("5 the follow-up lookup answers someone else's consultation exactly like a missing one", async () => {
      const others = await expect('L', 'POST', '/bookings/specialist', 404,
        { ...(await consult()), followUp: { isFollowUp: true, parentConsultationId: parentV } }, 'PARENT_CONSULTATION_NOT_FOUND');
      const missing = await expect('L', 'POST', '/bookings/specialist', 404,
        { ...(await consult()), followUp: { isFollowUp: true, parentConsultationId: oid() } }, 'PARENT_CONSULTATION_NOT_FOUND');
      assert.deepEqual(others.json, missing.json);
      assert.equal(await benefitUsed(parentV), false);
    });

    await check('6 /upcoming refuses a token without an id (no other customer is listed)', async () => {
      // 401 UNAUTHORIZED from the controller (or INVALID_TOKEN where authenticate already refuses an id-less token, as on stage).
      const r = await expect('noId', 'GET', '/bookings/upcoming', 401);
      assert.ok(r.json.code === 'UNAUTHORIZED' || r.json.code === 'INVALID_TOKEN', JSON.stringify(r.json));
      const own = await expect('V', 'GET', '/bookings/upcoming', 200);
      assert.ok((own.json.data as { userId: string }[]).length > 0);
      assert.ok((own.json.data as { userId: string }[]).every((b) => b.userId === V));
    });

    await check('7 a doctor who booked as a customer reads and retries that booking; other doctors still get 404', async () => {
      const made = await expect('docD', 'POST', '/bookings/specialist', 201, await consult());
      const id = String(made.json.data.booking._id);
      assert.equal(made.json.data.booking.userId, docD);
      await expect('docD', 'GET', '/bookings/' + id, 200);
      await expect('docD', 'GET', `/bookings/${id}/payment-details`, 200);
      await expect('docD', 'POST', `/bookings/${id}/retry-payment`, 200, {});
      await expect('docD', 'POST', `/bookings/${id}/reconcile-payments`, 200);
      await expect('docE', 'GET', '/bookings/' + id, 404, undefined, 'BOOKING_NOT_FOUND');
      await expect('docE', 'POST', `/bookings/${id}/retry-payment`, 404, {}, 'BOOKING_NOT_FOUND');
      // Still no access to other customers' bookings.
      await expect('docD', 'GET', '/bookings/' + pharmBooking, 404, undefined, 'BOOKING_NOT_FOUND');
    });

    await check("2 patient tracking shows only the caller pharmacy's orders of the patient", async () => {
      const order = (pharmacyId: string, customerId: string, tag: string) => ({ pharmacyId: new Types.ObjectId(pharmacyId),
        customerId: new Types.ObjectId(customerId), orderType: 'in_store', status: 'placed', items: [], notes: tag, createdAt: new Date(), updatedAt: new Date() });
      await PharmacyOrderModel.collection.insertMany([order(pharmV, L, 'own-1'), order(pharmW, L, 'other-1'), order(pharmW, L, 'other-2')] as never);
      const r = await expect('pharmV', 'GET', '/patient-tracking/' + L, 200);
      assert.deepEqual((r.json.data.recentOrders as { notes: string }[]).map((o) => o.notes), ['own-1']);
      assert.equal(r.json.data.lastOrderDate !== null, true);
      // Not linked: refused (unchanged).
      await expect('pharmV', 'GET', '/patient-tracking/' + V, 404, undefined, 'CUSTOMER_NOT_LINKED');
      // Repository: pharmacyId with a customer filter always applies; a customer-only filter is unchanged.
      const repo = new PharmacyOrderRepository();
      assert.equal((await repo.findWithPagination({ pharmacyId: pharmW, customerId: L })).total, 2);
      assert.equal((await repo.findWithPagination({ pharmacyId: pharmV, userId: L })).total, 1);
      assert.equal((await repo.findWithPagination({ customerId: L })).total, 3);
    });

    await check('3 linking by phone records consent and never replaces an existing linkedPharmacyId', async () => {
      const ok = await expect('pharmV', 'POST', '/pharmacy-customers', 201, { name: 'Other', phone: '9600000003', consent: true });
      assert.equal(ok.json.data.userId, X); assert.equal(ok.json.data.isNewUser, false);
      assert.equal((await UserModel.findById(X).lean())?.linkedPharmacyId, pharmW);
      const link = await PharmacyCustomerModel.findOne({ pharmacyId: pharmV, userId: X }).lean();
      assert.equal(link?.consent, 'patient_agreed'); assert.equal(link?.consentRecordedById, pharmV);
      assert.ok(link?.consentRecordedAt instanceof Date); assert.equal(String(link?.createdById), pharmV);
      // A self-signed-up user with no linked pharmacy is not given one.
      await expect('pharmV', 'POST', '/pharmacy-customers', 201, { name: 'Unlinked', phone: '9600000004', consent: true });
      assert.equal((await UserModel.findById(Y).lean())?.linkedPharmacyId, undefined);
    });

    await check('3 an explicit "patient did not agree" is refused; the released app payload (no consent) still works', async () => {
      const before = await PharmacyCustomerModel.countDocuments();
      await expect('pharmV', 'POST', '/pharmacy-customers', 400, { name: 'Victim', phone: '9600000001', consent: false }, 'CONSENT_REQUIRED');
      await expect('pharmV', 'POST', '/pharmacy-customers', 400, { name: 'New', phone: '9600000099', consent: false }, 'CONSENT_REQUIRED');
      assert.equal(await PharmacyCustomerModel.countDocuments(), before);
      assert.equal(await UserModel.countDocuments({ phone: '9600000099' }), 0);
      // The released pharmacy app sends exactly these fields (no consent): same response, consent recorded as not recorded.
      const r = await expect('pharmV', 'POST', '/pharmacy-customers', 201,
        { name: 'Walk In', phone: '9600000055', age: 40, diseaseNotes: 'bp', chronicCondition: true, recurringMedicine: true, recurringIntervalDays: 30 });
      assert.deepEqual(Object.keys(r.json.data).sort(), ['customer', 'isNewUser', 'userId']);
      assert.equal(r.json.data.isNewUser, true);
      const created = await UserModel.findById(r.json.data.userId).lean();
      assert.equal(created?.linkedPharmacyId, pharmV); assert.equal(created?.createdSource, 'pharmacy_app');
      assert.equal(r.json.data.customer.consent, 'not_recorded');
      // Re-linking an existing link with consent upgrades its record.
      const again = await expect('pharmV', 'POST', '/pharmacy-customers', 201, { name: 'Walk In', phone: '9600000055', consent: true });
      assert.equal(again.json.data.userId, r.json.data.userId); assert.equal(again.json.data.customer.consent, 'patient_agreed');
      // Another pharmacy linking that user does not take over its linkedPharmacyId.
      await expect('pharmW', 'POST', '/pharmacy-customers', 201, { name: 'Walk In', phone: '9600000055', consent: true });
      assert.equal((await UserModel.findById(r.json.data.userId).lean())?.linkedPharmacyId, pharmV);
      // An unverified pharmacy cannot link (unchanged).
      await expect('pharmU', 'POST', '/pharmacy-customers', 403, { name: 'Victim', phone: '9600000001', consent: true }, 'PHARMACY_NOT_VERIFIED');
    });

    await check('1 a customer linked by phone (with consent) can then be booked for by that pharmacy', async () => {
      await expect('pharmV', 'POST', '/pharmacy-customers', 201, { name: 'Victim', phone: '9600000001', consent: true });
      const ok = await expect('pharmV', 'POST', '/bookings/specialist', 201, { ...(await consult()), userId: V });
      assert.equal(ok.json.data.booking.pharmacyId, pharmV);
      assert.equal(await balance(V), 500);
    });
    await check('order: a pharmacy orders only for a customer already linked to it (no silent link)', async () => {
      const inStore = (customerId: string) => ({ orderType: 'in_store', customerId, items: [{ medicineId: MED, orderedQty: 1 }],
        paymentMode: 'in_store_payment', deliveryMode: 'pickup', isWalkIn: false });
      const before = await PharmacyCustomerModel.countDocuments();
      const ordersBefore = await PharmacyOrderModel.countDocuments();
      // pharmW is not linked to L; Y is linked to pharmV only (above), not to pharmW.
      for (const u of [L, Y, oid()]) await expect('pharmW', 'POST', '/pharmacy-orders', 403, inStore(u), 'CUSTOMER_NOT_LINKED');
      assert.equal(await PharmacyCustomerModel.countDocuments(), before, 'no link created');
      assert.equal(await PharmacyOrderModel.countDocuments(), ordersBefore, 'no order created');
      assert.equal(await PharmacyCustomerModel.exists({ pharmacyId: pharmW, userId: L }), null);
      // Its own linked customer (the released app's flow: link through POST /pharmacy-customers, then order): works.
      const ok = await expect('pharmV', 'POST', '/pharmacy-orders', 201, inStore(L));
      const orderId = String(ok.json.data.order._id);
      assert.equal(String(ok.json.data.order.customerId), L);
      // Moving an order to a customer not linked to it: refused, order unchanged; to a linked customer: works.
      await expect('pharmV', 'PUT', '/pharmacy-orders/' + orderId, 403, { customerId: oid() }, 'CUSTOMER_NOT_LINKED');
      const notLinkedToV = (await UserModel.create({ phone: '9600000077', userType: 'user', isActive: true }))._id.toHexString();
      await expect('pharmV', 'PUT', '/pharmacy-orders/' + orderId, 403, { customerId: notLinkedToV }, 'CUSTOMER_NOT_LINKED');
      assert.equal(String((await PharmacyOrderModel.findById(orderId).lean())?.customerId), L);
      assert.equal(await PharmacyCustomerModel.exists({ pharmacyId: pharmV, userId: notLinkedToV }), null);
      const moved = await expect('pharmV', 'PUT', '/pharmacy-orders/' + orderId, 200, { customerId: Y });
      assert.equal(String(moved.json.data.customerId), Y);
    });

    await check("order: a customer's own order links the pharmacy they chose (consent 'customer_order')", async () => {
      // Y is not linked to pharmW; Y checks out a cart from pharmW.
      assert.equal(await PharmacyCustomerModel.exists({ pharmacyId: pharmW, userId: Y }), null);
      await PharmacyCartModel.create({ actorId: Y, actorRole: 'user', pharmacyId: pharmW,
        items: [{ medicineId: MED, medicineName: 'Vitamin D', quantity: 1, unitPrice: 50, lineTotal: 50, prescriptionRequired: false }], subtotal: 50 });
      const r = await cartService.checkout({ _id: Y, userType: 'user' }, { paymentMode: 'cash_on_delivery', deliveryMode: 'pickup' } as never) as
        { order: { customerId: unknown; pharmacyId: unknown } };
      assert.equal(String(r.order.customerId), Y); assert.equal(String(r.order.pharmacyId), pharmW);
      const link = await PharmacyCustomerModel.findOne({ pharmacyId: pharmW, userId: Y }).lean();
      assert.equal(link?.consent, 'customer_order'); assert.equal(link?.consentRecordedById, Y);
      assert.equal((await UserModel.findById(Y).lean())?.linkedPharmacyId, undefined, 'linkedPharmacyId untouched');
      // From then on pharmW may order for Y, and book for Y (a customer's own order counts as consent).
      await expect('pharmW', 'POST', '/pharmacy-orders', 201, { orderType: 'in_store', customerId: Y,
        items: [{ medicineId: MED, orderedQty: 1 }], paymentMode: 'in_store_payment', deliveryMode: 'pickup' });
      await expect('pharmW', 'POST', '/bookings/specialist', 201, { ...(await consult()), userId: Y });
    });

    await check('1 a pharmacy books only for a link with the patient\'s consent recorded', async () => {
      // A pre-S3 link (no consent) and a link made by the released app without the tick ('not_recorded').
      const legacy = (await UserModel.create({ phone: '9600000081', userType: 'user', isActive: true }))._id.toHexString();
      await PharmacyCustomerModel.collection.insertOne({ pharmacyId: new Types.ObjectId(pharmV), userId: new Types.ObjectId(legacy) } as never);
      const untick = await expect('pharmV', 'POST', '/pharmacy-customers', 201, { name: 'No Tick', phone: '9600000082' });
      const noTick = String(untick.json.data.userId);
      assert.equal(untick.json.data.customer.consent, 'not_recorded');
      const before = await count();
      for (const u of [legacy, noTick]) {
        await expect('pharmV', 'POST', '/bookings/specialist', 403, { ...(await consult()), userId: u }, 'CUSTOMER_CONSENT_REQUIRED');
        await expect('pharmV', 'POST', '/bookings', 403, { ...(await consult()), bookingType: 'consultation', userId: u }, 'CUSTOMER_CONSENT_REQUIRED');
      }
      assert.equal(await count(), before);
      // The partner links again with the patient's tick: booking works.
      await expect('pharmV', 'POST', '/pharmacy-customers', 201, { name: 'No Tick', phone: '9600000082', consent: true });
      await expect('pharmV', 'POST', '/bookings/specialist', 201, { ...(await consult()), userId: noTick });
    });

    await check('2 an order\'s linked consultation is looked up only after the link check, with one answer', async () => {
      // pharmV probing the consultation of a customer not linked to it: the same answer for a real and a made-up id.
      const Z = (await UserModel.create({ phone: '9600000091', userType: 'user', isActive: true }))._id.toHexString();
      const order = (customerId: string, linkedConsultationId: string) => ({ orderType: 'in_store', customerId, linkedConsultationId,
        items: [{ medicineId: MED, orderedQty: 1 }], paymentMode: 'in_store_payment', deliveryMode: 'pickup' });
      const real = await expect('pharmV', 'POST', '/pharmacy-orders', 403, order(Z, parentV), 'CUSTOMER_NOT_LINKED');
      const fake = await expect('pharmV', 'POST', '/pharmacy-orders', 403, order(Z, oid()), 'CUSTOMER_NOT_LINKED');
      assert.deepEqual(real.json, fake.json);
      // A business-to-business order cannot probe consultation ids either.
      const b2b = (linkedConsultationId: string) => ({ orderType: 'in_store', buyerPharmacyId: pharmW, linkedConsultationId,
        items: [{ medicineId: MED, orderedQty: 1 }], paymentMode: 'in_store_payment', deliveryMode: 'pickup' });
      const b1 = await expect('pharmV', 'POST', '/pharmacy-orders', 400, b2b(parentV), 'LINKED_ORDER_REQUIRES_USER');
      const b2 = await expect('pharmV', 'POST', '/pharmacy-orders', 400, b2b(oid()), 'LINKED_ORDER_REQUIRES_USER');
      assert.deepEqual(b1.json, b2.json);
      // Linked customer: someone else's consultation and a missing one give the same 404; its own works.
      const other = await expect('pharmV', 'POST', '/pharmacy-orders', 404, order(L, parentV), 'CONSULTATION_NOT_FOUND');
      const missing = await expect('pharmV', 'POST', '/pharmacy-orders', 404, order(L, oid()), 'CONSULTATION_NOT_FOUND');
      assert.deepEqual(other.json, missing.json);
      // S4 (merged): its own consultation links only once it carries the doctor's saved prescription.
      await expect('pharmV', 'POST', '/pharmacy-orders', 400, order(L, parentL), 'CONSULTATION_PRESCRIPTION_REQUIRED');
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(parentL) }, { $set: { prescription: { message: 'rx', prescribedBySpecialistId: specS },
        'lifecycle.prescriptionUploaded': { at: new Date() } } });
      await expect('pharmV', 'POST', '/pharmacy-orders', 201, order(L, parentL));
      // Update: moving to an unlinked customer is refused before the consultation lookup.
      const own = await expect('pharmV', 'POST', '/pharmacy-orders', 201, { orderType: 'in_store', customerId: L,
        items: [{ medicineId: MED, orderedQty: 1 }], paymentMode: 'in_store_payment', deliveryMode: 'pickup' });
      const id = String(own.json.data.order._id);
      const u1 = await expect('pharmV', 'PUT', '/pharmacy-orders/' + id, 403, { customerId: Z, linkedConsultationId: parentV }, 'CUSTOMER_NOT_LINKED');
      const u2 = await expect('pharmV', 'PUT', '/pharmacy-orders/' + id, 403, { customerId: Z, linkedConsultationId: oid() }, 'CUSTOMER_NOT_LINKED');
      assert.deepEqual(u1.json, u2.json);
    });
    await check('3 the audit script lists pre-S3 access by id only and writes nothing', async () => {
      // Pre-S3 style rows: a pharmacy booking with no link, one paid from the customer's wallet, one on a free follow-up.
      const row = (extra: Record<string, unknown>) => ({ bookingType: 'consultation', specialistId: specS, status: 'confirmed',
        paymentStatus: 'paid', price: 100, bookingDate: DATE, bookingTime: '10:00 AM', createdAt: new Date(), updatedAt: new Date(), ...extra });
      const noLink = (await BookingModel.collection.insertOne(row({ userId: V, pharmacyId: pharmU }) as never)).insertedId.toHexString();
      const wallet = (await BookingModel.collection.insertOne(row({ userId: L, pharmacyId: pharmV, walletFunding: { total: 100 } }) as never)).insertedId.toHexString();
      const followUp = (await BookingModel.collection.insertOne(row({ userId: L, pharmacyId: pharmV,
        followUp: { isFollowUp: true, parentConsultationId: parentL } }) as never)).insertedId.toHexString();
      const legacyLink = String((await PharmacyCustomerModel.collection.findOne({ consent: { $exists: false } }))?._id);

      const snapshot = async () => {
        const out: Record<string, unknown> = {};
        for (const c of (await mongoose.connection.db!.listCollections().toArray()).map((x) => x.name).sort()) {
          out[c] = await mongoose.connection.db!.collection(c).find().sort({ _id: 1 }).toArray();
        }
        return JSON.stringify(out);
      };
      const before = await snapshot();
      const { auditS3PharmacyLinks } = await import('@/scripts/auditS3PharmacyLinks'); // loaded here: a missing script fails this check only
      const report = await auditS3PharmacyLinks();
      assert.equal(await snapshot(), before, 'the audit wrote nothing');

      assert.ok(report.linksWithoutConsent.some((l) => l.linkId === legacyLink && l.consent === null));
      assert.ok(report.linksWithoutConsent.every((l) => l.consent !== 'patient_agreed' && l.consent !== 'customer_order'));
      assert.deepEqual(report.bookingsWithoutLink.map((b) => b.bookingId), [noLink]);
      const benefits = new Map(report.pharmacyBookingsUsingCustomerBenefits.map((b) => [b.bookingId, b]));
      assert.equal(benefits.get(wallet)?.walletAmount, 100);
      assert.equal(benefits.get(followUp)?.followUpParentId, parentL);
      assert.equal(benefits.has(pharmBooking), false, 'a pharmacy booking paid by the gateway is not listed');
      const text = JSON.stringify(report);
      for (const secret of ['Victim', 'Linked', 'Walk In', '9600000001', '9600000002', 'fever']) assert.equal(text.includes(secret), false, secret);
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`${passed} checks passed, ${failed.length} failed`);
  if (failed.length) throw new Error('S3 checks failed: ' + failed.join('; '));
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
