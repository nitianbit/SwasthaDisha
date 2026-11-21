/**
 * Assisted booking phase 1a (ASSISTED_BOOKING_DESIGN.md §17, §6, §8, §13 row 1a): a pharmacy books a doctor consultation
 * for a walk-in patient and pays from its Jansetu wallet. Money (one debit under concurrency and replay; refunds on every
 * cancel path, always posting), accounting (withdrawable lots, the opening-balance migration, provider_coupon_v2 earning
 * with cut 0, no earning on no-show), limits, the admin move and "not mine", privacy of the lookup and the customer list,
 * views, and every switch off.
 * Real authenticate + bookings / pharmacy-assisted / pharmacy-bookings / pharmacy-customers / pharmacy-wallet /
 * specialists / admin routers over HTTP against MongoDB; Razorpay, Meet, reminders and notifications are stubs.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/assisted_phase1a_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/assisted/phase1a.integration.ts
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
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { WalletTransactionModel } from '@/modules/wallet/model';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import { PharmacyCustomerRepository } from '@/modules/pharmacyCustomers/repository';
import { PharmacyCustomerService } from '@/modules/pharmacyCustomers/services';
import { PharmacyWalletModel, PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { PharmacyWalletRepository, PharmacyWalletTransactionRepository } from '@/modules/pharmacyWallet/repository';
import { PharmacyWalletService } from '@/modules/pharmacyWallet/services';
import SpecialistModel from '@/modules/specialists/model';
import { SpecialistService } from '@/modules/specialists/services';
import { SpecialistPortalService } from '@/modules/specialistPortal/services';
import { CouponModel } from '@/modules/coupon/model';
import { CouponRepository } from '@/modules/coupon/repository';
import { LedgerEntryModel } from '@/modules/partners/model/settlement';
import { errorHandler } from '@/modules/middleware';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/assisted_phase1a_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;
/** IST date YYYYMMDD and time HH:mm of an instant. */
const istParts = (at: Date) => { const s = new Date(at.getTime() + IST).toISOString(); return { date: s.slice(0, 10).replace(/-/g, ''), time: s.slice(11, 16) }; };

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.error('FAIL -', name, '\n  ', (e as Error).message.split('\n').slice(0, 3).join(' | ')); }
}

/** Razorpay stand-in: the order payments it reports are set per test. */
const gateway: { payments: Record<string, { id: string; order_id: string; amount: number; currency: string; status: string; fee?: number }[]> } = { payments: {} };
const fakeRazorpay = {
  orders: { create: async (o: { amount: number; currency: string }) => ({ id: 'order_p1a_' + oid(), amount: o.amount, currency: o.currency, status: 'created' }),
    fetchPayments: async (orderId: string) => ({ items: gateway.payments[orderId] ?? [] }) },
  payments: { fetch: async () => { throw new Error('not used'); } },
};
const noop = new Proxy({}, { get: () => async () => undefined });

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();

  // tsx emits no decorator metadata: the services the controllers resolve are wired by hand before the routers load.
  const payments = Object.assign(Object.create(PaymentService.prototype), {
    bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
    walletTransactionRepository: new WalletTransactionRepository(), pharmacyWalletRepository: new PharmacyWalletRepository(),
    pharmacyWalletTransactionRepository: new PharmacyWalletTransactionRepository(), bookingReminderScheduler: noop,
    finalizePaymentProcessing: async (r: { _id: unknown }) => {
      await PaymentRecordModel.updateOne({ _id: r._id }, { $set: { isProcessed: true } });
      return PaymentRecordModel.findById(r._id).lean();
    },
    getRazorpayClient: () => fakeRazorpay,
    getRazorpayCredentials: () => ({ keyId: 'rzp_test_key', keySecret: 'secret' }),
  }) as unknown as PaymentService;
  const bookingService = Object.assign(Object.create(BookingService.prototype), {
    bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
    walletTransactionRepository: new WalletTransactionRepository(), userRepository: new UserRepository(),
    notificationService: noop, paymentService: payments, couponService: {}, emailService: {}, bookingReminderScheduler: noop,
    specialistService: { getById: async (id: string) => SpecialistModel.findById(id).lean() },
    slotService: { getById: async (id: string) => SlotModel.findById(id).lean() },
    specialistRepository: { findById: async (id: string) => SpecialistModel.findById(id).lean() },
    slotRepository: { findById: async (id: string) => SlotModel.findById(id).lean() },
  }) as BookingService;
  Container.set(BookingService, bookingService);
  Container.set(DependentService, Object.assign(Object.create(DependentService.prototype), { dependentRepository: new DependentRepository() }));
  Container.set(PharmacyCustomerService, Object.assign(Object.create(PharmacyCustomerService.prototype), {
    pharmacyCustomerRepo: new PharmacyCustomerRepository(), pharmacyRepo: new PharmacyRepository(), userRepo: new UserRepository() }));
  Container.set(PharmacyWalletService, Object.assign(Object.create(PharmacyWalletService.prototype), {
    walletRepo: new PharmacyWalletRepository(), txRepo: new PharmacyWalletTransactionRepository(), paymentService: payments }));
  Container.set(SpecialistService, { getById: async (id: string) => SpecialistModel.findById(id).lean() } as never);
  Container.set(SpecialistPortalService, Object.assign(Object.create(SpecialistPortalService.prototype), {
    bookingRepository: new BookingRepository(), userRepository: new UserRepository(), bookingService, notificationService: noop,
    specialistService: { getById: async (id: string) => SpecialistModel.findById(id).lean() },
  }));

  const notices: { audience: string; userId: string; message: string; title: string; key: string }[] = [];
  // Loaded on their own: without the phase 1a source the routes are simply absent (each check then fails on its own).
  const tryImport = async <T>(spec: string, pick: (m: any) => T, fallback: T): Promise<T> => import(spec).then(pick).catch((e) => {
    console.error('import failed', spec, (e as Error).message); return fallback; });
  const support = await tryImport('@/modules/assisted/support', (m) => m, null as any);
  support?.setAssistedNotifier(async (n: any) => { notices.push(n); });
  support?.setAssistedEffects({ meet: async (b: any) => b, cancelMeet: async (b: any) => b, reminders: async () => undefined, clearReminders: async () => undefined });
  const phase1a = await tryImport('@/modules/assisted/routes/phase1a', (m) => m, { pharmacyAssistedRouter: express.Router(), adminAssistedRouter: express.Router() } as any);
  const reconciliation = await tryImport('@/modules/assisted/reconciliation', (m) => m, null as any);
  const migration = await tryImport('@/scripts/assistedPharmacyWallets', (m) => m, null as any);
  const meet = await import('@/modules/meet/service');
  const { WalletTopupLotModel } = await tryImport('@/modules/pharmacyWallet/model/lots', (m) => m, { WalletTopupLotModel: null as any });
  const { CouponRedemptionModel } = await tryImport('@/modules/coupon/model/redemption', (m) => m, { CouponRedemptionModel: null as any });
  const assistedModels = await tryImport('@/modules/assisted/model', (m) => m, {} as any);

  const { default: bookingRouter } = await import('@/modules/bookings/routes');
  const { default: pharmacyBookingRouter } = await import('@/modules/assisted/routes');
  const { default: pharmacyCustomerRouter } = await import('@/modules/pharmacyCustomers/routes');
  const { default: pharmacyWalletRouter } = await import('@/modules/pharmacyWallet/routes');
  const { default: specialistRouter } = await import('@/modules/specialists/routes');
  const { authenticate } = await import('@/modules/middleware/auth');
  for (const name of mongoose.modelNames()) {
    const m = mongoose.model(name);
    await m.createCollection().catch(() => undefined);
    await m.syncIndexes();
  }

  const app = express();
  app.use(express.json());
  app.use('/api/v1/bookings', authenticate, bookingRouter);
  app.use('/api/v1/pharmacy-bookings', authenticate, pharmacyBookingRouter);
  app.use('/api/v1/pharmacy-assisted', authenticate, phase1a.pharmacyAssistedRouter);
  app.use('/api/v1/admin', authenticate, phase1a.adminAssistedRouter);
  app.use('/api/v1/pharmacy-customers', authenticate, pharmacyCustomerRouter);
  app.use('/api/v1/pharmacy-wallet', authenticate, pharmacyWalletRouter);
  app.use('/api/v1/specialists', authenticate, specialistRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;

  // Most checks book for the same few numbers: the per-number limit is set high here and tested on its own below.
  process.env.ASSISTED_LIMIT_BOOKINGS_PER_PHONE_PER_DAY = '1000';
  const flagsOn = () => {
    process.env.ASSISTED_BOOKING_ENABLED_PHARMACY = 'true';
    process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true';
  };
  const flagsOff = () => {
    delete process.env.ASSISTED_BOOKING_ENABLED_PHARMACY;
    delete process.env.ASSISTED_ADMIN_TOOLS_ENABLED;
  };

  try {
    // ── People ──
    const P = oid(); const Q = oid(); const U = oid(); const R = oid();
    await PharmacyModel.collection.insertMany([
      { _id: new Types.ObjectId(P), name: 'Sharma Medicals', phone: '9700000201', email: 'sharma@pharm.test', city: 'Shillong', pincode: '793001', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(Q), name: 'Other Pharmacy', phone: '9700000202', email: 'other@pharm.test', city: 'Aizawl', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(U), name: 'Unverified Pharmacy', phone: '9700000203', isActive: true, isVerified: false },
      { _id: new Types.ObjectId(R), name: 'Reconcile Pharmacy', phone: '9700000204', isActive: true, isVerified: true },
    ] as never);
    const X = oid(); const Y = oid(); const H = oid(); const ADMIN = oid();
    await UserModel.collection.insertMany([
      { _id: new Types.ObjectId(X), userType: 'user', phone: '9600000201', name: 'Rina Kumari Das', email: 'rina@example.test', createdSource: 'self_signup', otpVerified: true },
      { _id: new Types.ObjectId(Y), userType: 'user', phone: '9600000202', name: 'Bikash', email: 'bikash@example.test', createdSource: 'self_signup', otpVerified: true },
      { _id: new Types.ObjectId(H), userType: 'user', phone: '9600000203', name: 'Holder Three', createdSource: 'self_signup', otpVerified: true },
    ] as never);
    const depX = String((await DependentModel.create({ userId: X, name: 'Mina Das', relationship: 'Daughter', gender: 'Female', isActive: true } as never))._id);
    const D = oid(); const E = oid(); const F = oid(); const G = oid();
    await SpecialistModel.collection.insertMany([
      { _id: new Types.ObjectId(D), name: 'Dr Asha Menon', email: 'asha@doc.test', specialization: 'General Physician', languages: ['English', 'Khasi'],
        city: 'Shillong', pincode: '793001', consultationFee: 500, isActive: true, isVerified: true },
      { _id: new Types.ObjectId(G), name: 'Dr Far Away', email: 'far@doc.test', specialization: 'General Physician', languages: ['Hindi'],
        city: 'Delhi', pincode: '110001', consultationFee: 300, isActive: true, isVerified: true },
      { _id: new Types.ObjectId(E), name: 'Dr Inactive', consultationFee: 400, isActive: false, isVerified: true },
      { _id: new Types.ObjectId(F), name: 'Dr Unverified', consultationFee: 400, isActive: true, isVerified: false },
    ] as never);
    const tokens = {
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), Q: sign({ _id: Q, pharmacyId: Q, userType: 'pharmacy' }),
      U: sign({ _id: U, pharmacyId: U, userType: 'pharmacy' }), R: sign({ _id: R, pharmacyId: R, userType: 'pharmacy' }),
      X: sign({ _id: X, userType: 'user' }), Y: sign({ _id: Y, userType: 'user' }), H: sign({ _id: H, userType: 'user' }),
      D: sign({ _id: D, specialistId: D, userType: 'specialist' }), ADMIN: sign({ _id: ADMIN, userType: 'admin' }),
    };
    type Who = keyof typeof tokens;
    const call = async (who: Who | null, method: string, url: string, body?: unknown) => {
      const r = await fetch(base + url, { method, headers: { ...(who ? { authorization: 'Bearer ' + tokens[who] } : {}), 'content-type': 'application/json' },
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

    // ── Slots ── (one-patient slots of doctor D; `at` is the start)
    const slotAt = async (doctor: string, at: Date, modes?: string[]) => {
      const s = istParts(at); const e = istParts(new Date(at.getTime() + 15 * MIN));
      const slot = await SlotModel.create({ specialistId: doctor, date: s.date, startTime: s.time, endTime: e.time, duration: 15, maxBookings: 1,
        currentBookings: 0, isActive: true, isAvailable: true, slotType: 'consultation', ...(modes ? { serviceModes: modes } : {}) } as never);
      return String(slot._id);
    };
    let dayOffset = 0;
    /** A fresh slot 5+ days ahead (outside every customer cancellation window), a distinct hour each time. */
    const futureSlot = async (doctor = D) => { dayOffset += 1; return slotAt(doctor, new Date(Date.now() + (4 + dayOffset) * DAY + 7 * 3600_000)); };
    let keySeq = 0;
    const newKey = () => `p1a-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;
    const consult = (slotId: string, extra: Record<string, unknown> = {}) => ({
      requestKey: newKey(), phone: '9600000201', patient: { relation: 'self', name: 'Rina Das' },
      consent: { agreed: true, statementVersion: 'v1', statementLanguage: 'en' }, preferredLanguage: 'kha', slotId, consultationMode: 'video',
      join: { on: 'partner_device' }, acceptedPriceMinor: 50000, primaryConcern: 'fever', paymentMethod: 'wallet', ...extra,
    });
    const balanceOf = async (pharmacyId: string) => {
      const w = await PharmacyWalletModel.findOne({ pharmacyId }).lean() as any;
      return { paise: Number(w?.balancePaise ?? 0), withdrawable: Number(w?.withdrawableMinor ?? 0) };
    };
    const adminTopup = (pharmacyId: string, amount: number) => expect('ADMIN', 'POST', '/pharmacy-wallet/topup', 200, { pharmacyId, amount });

    // ───────────────────────── Switches off ─────────────────────────
    await check('switches off: every new assisted writer answers 503 ASSISTED_BOOKING_DISABLED', async () => {
      flagsOff();
      const slot = await futureSlot();
      await expect('P', 'POST', '/pharmacy-assisted/patients/lookup', 503, { phone: '9600000201' }, 'ASSISTED_BOOKING_DISABLED');
      await expect('P', 'GET', '/pharmacy-assisted/doctors', 503, undefined, 'ASSISTED_BOOKING_DISABLED');
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 503, consult(slot), 'ASSISTED_BOOKING_DISABLED');
      const link = await PharmacyCustomerModel.create({ pharmacyId: P, userId: Y, consent: 'patient_agreed' } as never);
      await expect('P', 'PUT', `/pharmacy-customers/${String(link._id)}/typed-name`, 503, { typedName: 'Bikash B' }, 'ASSISTED_BOOKING_DISABLED');
      await expect('ADMIN', 'PUT', `/admin/pharmacies/${P}/wallet/freeze`, 503, { frozen: true, reason: 'x' }, 'ASSISTED_BOOKING_DISABLED');
      await expect('ADMIN', 'POST', `/admin/assisted-bookings/${oid()}/move`, 503, { toPhone: '9600000203', reason: 'x', requestKey: 'flags-off-key-1' },
        'ASSISTED_BOOKING_DISABLED');
      assert.equal(await BookingModel.countDocuments({ source: 'pharmacy_assisted' }), 0);
      // A top-up credited while the switch is off opens no withdrawable lot (the old behaviour).
      await adminTopup(P, 100);
      assert.equal((await balanceOf(P)).paise, 10000);
      assert.equal((await balanceOf(P)).withdrawable, 0);
      await PharmacyCustomerModel.deleteOne({ _id: link._id });
    });
    flagsOn();

    // ───────────────────────── Privacy ─────────────────────────
    await check('lookup: masked holder name only, audited, per-organisation limit 429 lookups', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/patients/lookup', 200, { phone: '+91 96000 00201' });
      assert.deepEqual(r.json.data, { exists: true, holderNameMasked: 'Rina D.' });
      assert.equal(r.text.includes('rina@example'), false);
      const one = await expect('P', 'POST', '/pharmacy-assisted/patients/lookup', 200, { phone: '9600000202' });
      assert.equal(one.json.data.holderNameMasked, 'Bi…');
      const none = await expect('P', 'POST', '/pharmacy-assisted/patients/lookup', 200, { phone: '9600009999' });
      assert.deepEqual(none.json.data, { exists: false, holderNameMasked: null });
      assert.equal(await assistedModels.AssistedAuditEventModel.countDocuments({ action: 'patient.lookup', orgId: P }), 3);
      process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '2';
      try {
        await expect('Q', 'POST', '/pharmacy-assisted/patients/lookup', 200, { phone: '9600000201' });
        await expect('Q', 'POST', '/pharmacy-assisted/patients/lookup', 200, { phone: '9600000201' });
        const hit = await expect('Q', 'POST', '/pharmacy-assisted/patients/lookup', 429, { phone: '9600000201' }, 'ASSISTED_LIMIT_REACHED');
        assert.equal(hit.json.limit, 'lookups');
      } finally { delete process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR; }
      await expect('U', 'POST', '/pharmacy-assisted/patients/lookup', 403, { phone: '9600000201' }, 'PHARMACY_NOT_VERIFIED');
    });

    await check('nearby doctors: active and verified only, the pharmacy\'s pincode first, next free slot', async () => {
      await futureSlot(G);
      const r = await expect('P', 'GET', '/pharmacy-assisted/doctors?mode=video', 200);
      const ids = r.json.data.map((d: any) => d.doctorId);
      assert.deepEqual(ids, [D, G], 'inactive and unverified doctors are never listed; nearby first');
      assert.equal(r.json.data[0].nearby, 'pincode');
      assert.equal(r.json.data[0].feeMinor, 50000);
      assert.ok(r.json.data[0].nextSlot?.slotId);
      const q = await expect('Q', 'GET', '/pharmacy-assisted/doctors', 200);
      assert.equal(q.json.data[0].doctorId, G, 'no doctor near Q: the cheaper one first');
    });

    // ───────────────────────── Create ─────────────────────────
    await adminTopup(P, 50000); // ₹50,100 in total, non-withdrawable
    let firstBooking = '';
    await check('create refusals: consent, method, price fence, doctor, started slot', async () => {
      const slot = await futureSlot();
      const noConsent = consult(slot); delete (noConsent as any).consent;
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 400, noConsent, 'CONSENT_REQUIRED');
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 400, consult(slot, { consent: { agreed: false, statementVersion: 'v1', statementLanguage: 'en' } }), 'CONSENT_REQUIRED');
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 400, consult(slot, { paymentMethod: 'razorpay' }), 'PAYMENT_METHOD_UNAVAILABLE');
      const fence = await expect('P', 'POST', '/pharmacy-assisted/consultations', 409, consult(slot, { acceptedPriceMinor: 40000 }), 'PRICE_CHANGED');
      assert.equal(fence.json.details.priceMinor, 50000);
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 409, consult(await futureSlot(E)), 'DOCTOR_NOT_AVAILABLE');
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 409, consult(await futureSlot(F)), 'DOCTOR_NOT_AVAILABLE');
      const started = await slotAt(D, new Date(Date.now() - 5 * MIN));
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 409, consult(started), 'SLOT_STARTED');
      assert.equal(await BookingModel.countDocuments({ source: 'pharmacy_assisted' }), 0);
      assert.equal((await balanceOf(P)).paise, 5010000, 'nothing was debited');
    });

    await check('create: new number opens an internal account with the typed name; wallet debit in the booking transaction; no payment record', async () => {
      const slot = await futureSlot();
      const body = consult(slot, { phone: '9600000301', patient: { relation: 'self', name: 'Lalthan Zuali' } });
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, body);
      firstBooking = r.json.data.booking._id;
      assert.equal(r.json.data.newAccount, true);
      assert.equal(r.json.data.replayed, false);
      assert.equal(r.json.data.funding.amountMinor, 50000);
      const u = await UserModel.findOne({ phone: '9600000301' }).lean() as any;
      assert.equal(u.name, 'Lalthan Zuali'); assert.equal(u.createdSource, 'assisted_booking'); assert.equal(u.otpVerified, false);
      assert.equal(u.preferredLanguage, 'kha');
      const b = await BookingModel.findById(firstBooking).lean() as any;
      assert.equal(b.source, 'pharmacy_assisted'); assert.equal(b.earningRule, 'provider_coupon_v2'); assert.equal(b.settlementSystem, 'ledger');
      assert.equal(b.pharmacyId, P); assert.equal(b.status, 'confirmed'); assert.equal(b.paymentStatus, 'paid');
      assert.equal(b.assisted.bookedBy.kind, 'pharmacy'); assert.equal(b.assisted.bookedBy.id, P); assert.equal(b.assisted.consent.method, 'partner_attested');
      assert.equal(b.assisted.identity.newAccount, true); assert.equal(b.assisted.referral, null);
      assert.match(b.assisted.shortRef, /^[A-Z2-7]{8}$/);
      assert.deepEqual({ ...b.assisted.split }, { listMinor: 50000, discountMinor: 0, baseMinor: 50000, cutMinor: 0, providerMinor: 50000, rule: 'provider_coupon_v2' });
      assert.equal(await PaymentRecordModel.countDocuments({ contextId: firstBooking }), 0, 'P3: no payment record');
      const debit = await PharmacyWalletTransactionModel.find({ operationKey: `assisted:${firstBooking}:debit` }).lean() as any[];
      assert.equal(debit.length, 1); assert.equal(debit[0].signedAmountPaise, -50000); assert.equal(debit[0].transactionType, 'booking_debit');
      assert.equal(String(debit[0]._id), b.assisted.funding.walletEntryId);
      assert.equal((await balanceOf(P)).paise, 4960000);
      const link = await PharmacyCustomerModel.findOne({ pharmacyId: P, userId: u._id }).lean() as any;
      assert.equal(link.typedName, 'Lalthan Zuali'); assert.equal(link.consent, 'patient_agreed');
      assert.equal(await assistedModels.AssistedAuditEventModel.countDocuments({ action: 'booking.created', bookingId: firstBooking }), 1);
      const doctorNotice = notices.find((n) => n.key === `assisted:${firstBooking}:booked:doctor`);
      assert.ok(doctorNotice?.message.includes('Identity attested by the partner, not verified'));
      assert.ok(notices.some((n) => n.key === `assisted:${firstBooking}:booked:customer` && n.userId === String(u._id)));
    });

    await check('replay: same key + same request = one booking, one debit; other content = 409; existing accounts never renamed', async () => {
      const slot = await futureSlot();
      const body = consult(slot);
      const first = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, body);
      const again = await expect('P', 'POST', '/pharmacy-assisted/consultations', 200, body);
      assert.equal(again.json.data.replayed, true); assert.equal(again.json.data.booking._id, first.json.data.booking._id);
      assert.equal(again.json.data.newAccount, false);
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 409, { ...body, notes: 'different' }, 'IDEMPOTENCY_KEY_REUSED');
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ operationKey: `assisted:${first.json.data.booking._id}:debit` }), 1);
      assert.equal((await UserModel.findById(X).lean() as any).name, 'Rina Kumari Das', 'the existing account keeps its name');
      const link = await PharmacyCustomerModel.findOne({ pharmacyId: P, userId: X }).lean() as any;
      assert.equal(link.typedName, 'Rina Das');
    });

    await check('concurrency: one key sent 6 times at once books and debits once', async () => {
      const before = (await balanceOf(P)).paise;
      const body = consult(await futureSlot());
      const rs = await Promise.all(Array.from({ length: 6 }, () => call('P', 'POST', '/pharmacy-assisted/consultations', body)));
      assert.ok(rs.every((r) => r.status === 201 || r.status === 200), rs.map((r) => r.status + r.text.slice(0, 80)).join(';'));
      assert.equal(new Set(rs.map((r) => r.json.data.booking._id)).size, 1);
      assert.equal(rs.filter((r) => r.json.data.replayed === false).length, 1);
      assert.equal(await BookingModel.countDocuments({ 'assisted.requestKey': { $regex: body.requestKey + '$' } }), 1);
      assert.equal((await balanceOf(P)).paise, before - 50000);
    });

    await check('concurrency: bookings racing for the last rupees never take the wallet below zero', async () => {
      await adminTopup(Q, 1000); // ₹1,000 → two ₹500 bookings
      const slots = await Promise.all(Array.from({ length: 5 }, () => futureSlot()));
      const rs = await Promise.all(slots.map((s, i) => call('Q', 'POST', '/pharmacy-assisted/consultations',
        consult(s, { phone: `96000004${String(i).padStart(2, '0')}`, patient: { relation: 'self', name: `Racer ${i}` } }))));
      const ok = rs.filter((r) => r.status === 201).length;
      assert.equal(ok, 2, rs.map((r) => r.status + ':' + (r.json.code ?? '')).join(','));
      assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.json.code === 'INSUFFICIENT_BALANCE'));
      assert.equal((await balanceOf(Q)).paise, 0);
      assert.equal(await BookingModel.countDocuments({ 'assisted.bookedBy.id': Q }), 2);
    });

    await check('family member: created (or matched) under the account; the answer never says which; holderName fills an empty typedName', async () => {
      const slot = await futureSlot();
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201,
        consult(slot, { phone: '9600000202', patient: { relation: 'Son', name: 'Kiran' }, holderName: 'Bikash Thapa' }));
      const b = await BookingModel.findById(r.json.data.booking._id).lean() as any;
      const dep = await DependentModel.findById(b.dependentId).lean() as any;
      assert.equal(String(dep.userId), Y); assert.equal(dep.name, 'Kiran'); assert.equal(dep.preferredLanguage, 'kha');
      assert.equal(r.text.includes('dependentCreated'), false);
      assert.equal((await PharmacyCustomerModel.findOne({ pharmacyId: P, userId: Y }).lean() as any).typedName, 'Bikash Thapa');
      // An existing family member by id must belong to the phone's account.
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 404, consult(await futureSlot(), { phone: '9600000202', patient: { dependentId: depX } }), 'DEPENDENT_NOT_FOUND');
      const mine = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { patient: { dependentId: depX } }));
      assert.equal((await BookingModel.findById(mine.json.data.booking._id).lean() as any).dependentId, depX);
    });

    await check('by-key: abandon an unsent key (never bookable after), find a used one', async () => {
      const k = newKey();
      const ab = await expect('P', 'POST', `/pharmacy-assisted/bookings/by-key/${k}/abandon`, 200);
      assert.equal(ab.json.data.state, 'abandoned');
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 409, { ...consult(await futureSlot()), requestKey: k }, 'REQUEST_ABANDONED');
      const used = consult(await futureSlot());
      const made = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, used);
      const found = await expect('P', 'GET', `/pharmacy-assisted/bookings/by-key/${used.requestKey}`, 200);
      assert.equal(found.json.data.state, 'used'); assert.equal(found.json.data.booking._id, made.json.data.booking._id);
      assert.equal(found.json.data.booking.assisted.funding, undefined, 'booker view, no funding internals');
      const other = await expect('Q', 'GET', `/pharmacy-assisted/bookings/by-key/${used.requestKey}`, 200);
      assert.equal(other.json.data.state, 'unknown', 'keys are per booker');
      const ab2 = await expect('P', 'POST', `/pharmacy-assisted/bookings/by-key/${used.requestKey}/abandon`, 200);
      assert.equal(ab2.json.data.state, 'used');
    });

    // ───────────────────────── Coupons ─────────────────────────
    const coupon = (code: string, extra: Record<string, unknown> = {}) => CouponModel.create({ code, discountType: 'fixed', discountValue: 100,
      applicableTo: 'all', eligibleFor: 'all', startDate: '20200101', endDate: '20991231', currentUsageCount: 0, isActive: true, ...extra } as never);
    let couponBooking = '';
    await check('coupons: per-user and platform-funded refused; provider coupon redeemed for the patient, counted once', async () => {
      await coupon('ONCE100', { usageLimitPerUser: 1 });
      const corp = oid();
      await UserModel.updateOne({ _id: X }, { $set: { corporateId: corp } });
      await coupon('CORP100', { corporateIds: [corp], fundedBy: 'platform' });
      await coupon('PROV100', { totalUsageLimit: 2 });
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 400, consult(await futureSlot(), { couponCode: 'ONCE100', acceptedPriceMinor: 40000 }), 'COUPON_NOT_FOR_ASSISTED');
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 400, consult(await futureSlot(), { couponCode: 'CORP100', acceptedPriceMinor: 40000 }), 'COUPON_NOT_FOR_ASSISTED');
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { couponCode: 'PROV100', acceptedPriceMinor: 40000 }));
      couponBooking = r.json.data.booking._id;
      const b = await BookingModel.findById(couponBooking).lean() as any;
      assert.deepEqual({ ...b.assisted.split }, { listMinor: 50000, couponCode: 'PROV100', couponFundedBy: 'provider', discountMinor: 10000, baseMinor: 40000,
        cutMinor: 0, providerMinor: 40000, rule: 'provider_coupon_v2' });
      assert.equal(b.price, 400); assert.equal(b.originalPrice, 500);
      const red = await CouponRedemptionModel.findOne({ bookingId: couponBooking }).lean() as any;
      assert.equal(red.patientUserId, X); assert.equal(red.payerId, P); assert.equal(red.state, 'counted');
      assert.equal((await CouponModel.findOne({ code: 'PROV100' }).lean() as any).currentUsageCount, 1);
      assert.equal(await new CouponRepository().countUserCouponUsage(X, 'PROV100'), 1, "the patient's own per-user count sees it");
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { couponCode: 'PROV100', acceptedPriceMinor: 40000 }));
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 400, consult(await futureSlot(), { couponCode: 'PROV100', acceptedPriceMinor: 40000 }), 'INVALID_COUPON');
      await CouponModel.updateOne({ code: 'PROV100' }, { $set: { totalUsageLimit: 3, currentUsageCount: 3 } });
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 400, consult(await futureSlot(), { couponCode: 'PROV100', acceptedPriceMinor: 40000 }), 'INVALID_COUPON');
      await CouponModel.updateOne({ code: 'PROV100' }, { $set: { totalUsageLimit: 10, currentUsageCount: 2 } });
    });

    // ───────────────────────── Refunds by every cancel path ─────────────────────────
    const walletRefund = async (bookingId: string, payer = P) => PharmacyWalletTransactionModel.find({ pharmacyId: payer, operationKey: `assisted:${bookingId}:refund` }).lean() as Promise<any[]>;
    await check('booker cancel: any time before the start (patient window closed), full refund, coupon reversed, link dies, once', async () => {
      const soon = await slotAt(D, new Date(Date.now() + 40 * MIN));
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(soon, { couponCode: 'PROV100', acceptedPriceMinor: 40000 }));
      const id = r.json.data.booking._id;
      const before = (await balanceOf(P)).paise;
      await expect('X', 'POST', `/bookings/${id}/cancel`, 400, { cancellationReason: 'x' }, 'CANCELLATION_WINDOW_CLOSED').catch(async () => {
        const again = await call('X', 'POST', `/bookings/${id}/cancel`, { cancellationReason: 'x' });
        assert.ok(again.status >= 400 && again.status < 500, 'the patient window (24 h) is closed');
      });
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${id}/cancel`, 409, { reason: 'x', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }, 'BOOKING_CHANGED');
      const c = await expect('P', 'POST', `/pharmacy-assisted/bookings/${id}/cancel`, 200, { reason: 'patient left' });
      assert.equal(c.json.data.refundedMinor, 40000);
      assert.equal(c.json.data.booking.status, 'cancelled'); assert.equal(c.json.data.booking.cancellationCause, 'booker');
      const b = await BookingModel.findById(id).lean() as any;
      assert.equal(b.assisted.funding.state, 'refunded'); assert.equal(b.assisted.funding.refunds.length, 1);
      assert.equal(b.assisted.join.linkVersion, 2);
      assert.equal((await CouponRedemptionModel.findOne({ bookingId: id }).lean() as any).state, 'reversed');
      assert.equal((await SlotModel.findById(soon).lean() as any).currentBookings, 0, 'the seat is free again');
      assert.equal((await balanceOf(P)).paise, before + 40000);
      const again = await expect('P', 'POST', `/pharmacy-assisted/bookings/${id}/cancel`, 200, { reason: 'again' });
      assert.equal(again.json.data.alreadyCancelled, true);
      assert.equal((await walletRefund(id)).length, 1, 'refunded once');
      // Another pharmacy, a missing or a malformed id: the same 404.
      await expect('Q', 'POST', `/pharmacy-assisted/bookings/${id}/cancel`, 404, {}, 'BOOKING_NOT_FOUND');
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${oid()}/cancel`, 404, {}, 'BOOKING_NOT_FOUND');
      // After the start the booker can no longer cancel.
      const late = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      const lateId = late.json.data.booking._id;
      const past = istParts(new Date(Date.now() - 20 * MIN));
      await BookingModel.updateOne({ _id: lateId }, { $set: { bookingDate: past.date, bookingTime: past.time } });
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${lateId}/cancel`, 400, {}, 'BOOKING_ALREADY_STARTED');
    });

    await check('patient cancel from the app: refund to the PARTNER wallet (never the patient), partner told', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      const id = r.json.data.booking._id;
      const before = (await balanceOf(P)).paise;
      const c = await expect('X', 'POST', `/bookings/${id}/cancel`, 200, { cancellationReason: 'feeling better' });
      assert.equal(c.json.data.status, 'cancelled');
      assert.equal(c.json.data.price, undefined, 'the patient view hides the partner money');
      assert.equal((await balanceOf(P)).paise, before + 50000);
      assert.equal(await WalletTransactionModel.countDocuments({ userId: X }), 0, 'nothing to the customer wallet');
      assert.equal((await BookingModel.findById(id).lean() as any).cancellationCause, 'patient');
      assert.ok(notices.some((n) => n.key === `assisted:${id}:cancelled:booker` && n.title === 'Cancelled by the patient' && n.userId === P));
    });

    await check('doctor cancel and admin cancel: full refund to the partner', async () => {
      const d = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      const before = (await balanceOf(P)).paise;
      await expect('D', 'PATCH', `/specialists/me/appointments/${d.json.data.booking._id}/status`, 200, { status: 'cancelled', reason: 'emergency' });
      assert.equal((await balanceOf(P)).paise, before + 50000);
      assert.equal((await walletRefund(d.json.data.booking._id)).length, 1);
      const cust = notices.find((n) => n.key === `assisted:${d.json.data.booking._id}:cancelled:customer`);
      assert.ok(cust && !cust.message.includes('your wallet'), 'the patient is not told of a wallet refund');
      const a = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      await expect('ADMIN', 'POST', `/bookings/${a.json.data.booking._id}/cancel`, 200, { cancellationReason: 'duplicate' });
      assert.equal((await walletRefund(a.json.data.booking._id)).length, 1);
      assert.equal((await balanceOf(P)).paise, before + 100000 - 50000);
    });

    await check('concurrent cancels (booker, patient, admin at once): one cancellation, one refund', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      const id = r.json.data.booking._id;
      const before = (await balanceOf(P)).paise;
      const rs = await Promise.all([
        call('P', 'POST', `/pharmacy-assisted/bookings/${id}/cancel`, {}), call('X', 'POST', `/bookings/${id}/cancel`, {}),
        call('ADMIN', 'POST', `/bookings/${id}/cancel`, {}), call('P', 'POST', `/pharmacy-assisted/bookings/${id}/cancel`, {}),
      ]);
      assert.ok(rs.every((x) => x.status === 200), rs.map((x) => x.status + x.text.slice(0, 80)).join(';'));
      assert.equal((await walletRefund(id)).length, 1);
      assert.equal((await balanceOf(P)).paise, before + 50000);
      assert.equal((await BookingModel.findById(id).lean() as any).assisted.funding.refunds.length, 1);
    });

    await check('refunds always post: frozen, inactive wallet and an inactive pharmacy are still credited', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      const id = r.json.data.booking._id;
      await PharmacyWalletModel.updateOne({ pharmacyId: P }, { $set: { frozen: true, isActive: false } });
      await PharmacyModel.updateOne({ _id: P }, { $set: { isActive: false } });
      try {
        const before = (await balanceOf(P)).paise;
        await expect('X', 'POST', `/bookings/${id}/cancel`, 200, { cancellationReason: 'no longer needed' });
        assert.equal((await balanceOf(P)).paise, before + 50000);
      } finally {
        await PharmacyWalletModel.updateOne({ pharmacyId: P }, { $set: { frozen: false, isActive: true } });
        await PharmacyModel.updateOne({ _id: P }, { $set: { isActive: true } });
      }
    });

    // ───────────────────────── Booker reschedule (P9) ─────────────────────────
    await check('booker reschedule: same doctor and price, once per key; the patient cannot move it', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      const id = r.json.data.booking._id;
      const target = await futureSlot();
      await expect('X', 'POST', `/bookings/${id}/reschedule`, 409, { slotId: target }, 'ASSISTED_RESCHEDULE_BY_PARTNER');
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${id}/reschedule`, 409, { slotId: await futureSlot(G), requestKey: newKey() }, 'SLOT_NOT_THIS_DOCTOR');
      const k = newKey();
      const before = (await balanceOf(P)).paise;
      const m = await expect('P', 'POST', `/pharmacy-assisted/bookings/${id}/reschedule`, 200, { slotId: target, requestKey: k });
      assert.equal(m.json.data.replayed, false); assert.equal(m.json.data.booking.slotId, target);
      const again = await expect('P', 'POST', `/pharmacy-assisted/bookings/${id}/reschedule`, 200, { slotId: target, requestKey: k });
      assert.equal(again.json.data.replayed, true);
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${id}/reschedule`, 409, { slotId: await futureSlot(), requestKey: k }, 'IDEMPOTENCY_KEY_REUSED');
      const b = await BookingModel.findById(id).lean() as any;
      assert.equal(b.price, 500); assert.equal(b.assisted.join.linkVersion, 1, 'a move keeps the join link');
      assert.equal((await balanceOf(P)).paise, before, 'no money moves');
      await expect('Q', 'POST', `/pharmacy-assisted/bookings/${id}/reschedule`, 404, { slotId: await futureSlot(), requestKey: newKey() }, 'BOOKING_NOT_FOUND');
    });

    // ───────────────────────── Views and customer commands (§6.7) ─────────────────────────
    await check('views: the patient sees "paid by" without the partner money; payment details 404; pay again 409; doctor sees the attestation', async () => {
      const r = await expect('X', 'GET', `/bookings/${couponBooking}`, 200);
      const v = r.json.data;
      for (const k of ['price', 'originalPrice', 'paymentTransactionId', 'walletFunding']) assert.equal(v[k], undefined, k);
      assert.equal(v.paidBy, 'Sharma Medicals'); assert.equal(v.assisted.funding, undefined); assert.equal(v.assisted.split, undefined);
      assert.equal(v.assisted.requestKey, undefined);
      await expect('X', 'GET', `/bookings/${couponBooking}/payment-details`, 404, undefined, 'BOOKING_NOT_FOUND');
      await expect('X', 'POST', `/bookings/${couponBooking}/retry-payment`, 409, {}, 'PARTNER_PAID_BOOKING');
      await expect('X', 'POST', `/bookings/${couponBooking}/reconcile-payments`, 409, undefined, 'PARTNER_PAID_BOOKING');
      const doc = await expect('D', 'GET', `/specialists/me/appointments/${couponBooking}`, 200);
      assert.equal(doc.json.data.booking.source, 'pharmacy_assisted');
      assert.equal(doc.json.data.booking.assisted.identity.note, 'Identity attested by the partner, not verified');
      const ph = await expect('P', 'GET', `/bookings/${couponBooking}`, 200);
      assert.equal(ph.json.data.assisted.funding, undefined, 'the generic read gives the pharmacy the booker view');
      assert.equal(ph.json.data.source, 'pharmacy_assisted');
      const list = await expect('P', 'GET', '/pharmacy-bookings?limit=50', 200);
      assert.ok(list.json.data.some((x: any) => x._id === couponBooking), 'the phase 0 list now has the assisted rows');
    });

    // ───────────────────────── Accounting ─────────────────────────
    await check('withdrawable: a card top-up is a lot (fee known), spending uses it first, a refund restores it, an unknown fee waits', async () => {
      const recharge = async (amount: number, fee?: number) => {
        const orderId = 'order_topup_' + oid();
        const rec = await PaymentRecordModel.create({ userId: R, payerUserId: R, payerPharmacyId: R, context: 'wallet_recharge', contextId: `pharmacy_${R}_${Date.now()}`,
          baseAmount: amount, discountAmount: 0, finalAmount: amount, baseAmountPaise: amount * 100, finalAmountPaise: amount * 100, currency: 'INR',
          paymentGateway: 'razorpay', razorpayOrderId: orderId, status: 'created', notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: R } } as never);
        gateway.payments[orderId] = [{ id: 'pay_' + oid(), order_id: orderId, amount: amount * 100, currency: 'INR', status: 'captured', ...(fee !== undefined ? { fee } : {}) }];
        return String(rec._id);
      };
      const t1 = await recharge(800, 1888);
      await expect('Q', 'POST', `/pharmacy-wallet/topups/${t1}/check`, 404, undefined, 'PAYMENT_RECORD_NOT_FOUND');
      const c1 = await expect('R', 'POST', `/pharmacy-wallet/topups/${t1}/check`, 200);
      assert.equal(c1.json.data.state, 'credited');
      assert.deepEqual(await balanceOf(R), { paise: 80000, withdrawable: 80000 });
      await expect('R', 'POST', `/pharmacy-wallet/topups/${t1}/check`, 200);
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: R, referenceId: t1 }), 1, 'credited once');
      const lot = await WalletTopupLotModel.findOne({ paymentRecordId: t1 }).lean() as any;
      assert.equal(lot.gatewayFeeMinor, 1888); assert.equal(lot.feeState, 'known');
      await adminTopup(R, 300); // non-withdrawable
      const w = await expect('R', 'GET', '/pharmacy-wallet', 200);
      assert.equal(w.json.data.withdrawableMinor, 80000); assert.equal(w.json.data.frozen, false); assert.equal(w.json.data.balancePaise, 110000);
      const b = await expect('R', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { phone: '9600000501', patient: { relation: 'self', name: 'Lot User' } }));
      assert.deepEqual(await balanceOf(R), { paise: 60000, withdrawable: 30000 }, 'D9: card money is spent first');
      const debit = await PharmacyWalletTransactionModel.findOne({ operationKey: `assisted:${b.json.data.booking._id}:debit` }).lean() as any;
      assert.deepEqual(debit.lotAllocations.map((a: any) => a.amountPaise), [50000]); assert.equal(debit.withdrawableDeltaPaise, -50000);
      await expect('R', 'POST', `/pharmacy-assisted/bookings/${b.json.data.booking._id}/cancel`, 200, {});
      assert.deepEqual(await balanceOf(R), { paise: 110000, withdrawable: 80000 }, 'the refund restores the lot');
      const tx = await expect('R', 'GET', '/pharmacy-wallet/transactions', 200);
      assert.ok(tx.json.data.every((t: any) => Number.isInteger(t.signedAmountPaise)), 'every new row is signed');
      const t2 = await recharge(200);
      await expect('R', 'POST', `/pharmacy-wallet/topups/${t2}/check`, 200);
      assert.deepEqual(await balanceOf(R), { paise: 130000, withdrawable: 80000 }, 'a lot with an unknown fee is not withdrawable');
      const filled = await reconciliation.fillUnknownLotFees(async () => 472);
      assert.equal(filled.filled, 1);
      assert.deepEqual(await balanceOf(R), { paise: 130000, withdrawable: 100000 });
    });

    await check('opening-balance migration: dry run writes nothing; commit signs old rows, opens each wallet once; a rerun is a no-op', async () => {
      // A wallet from before phase 1a: legacy rows without signed amounts and a balance they do not explain.
      const L = oid();
      await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(L), name: 'Legacy Pharmacy', phone: '9700000211', isActive: true, isVerified: true } as never);
      const w = await PharmacyWalletModel.collection.insertOne({ pharmacyId: new Types.ObjectId(L), balance: 750, isActive: true, createdAt: new Date(Date.now() - 90 * DAY) } as never);
      await PharmacyWalletTransactionModel.collection.insertMany([
        { pharmacyId: new Types.ObjectId(L), walletId: w.insertedId, transactionType: 'credit', amount: 1000, balanceBefore: 0, balanceAfter: 1000, status: 'completed' },
        { pharmacyId: new Types.ObjectId(L), walletId: w.insertedId, transactionType: 'consultation_payment', amount: 400, balanceBefore: 1000, balanceAfter: 600, status: 'completed' },
      ] as never);
      const link = await PharmacyCustomerModel.create({ pharmacyId: L, userId: H, consent: 'patient_agreed' } as never);
      await UserModel.updateOne({ _id: H }, { $set: { createdSource: 'pharmacy_app', linkedPharmacyId: L } });
      await CouponModel.collection.insertOne({ code: 'OLDCORP', corporateIds: ['c1'], discountType: 'fixed', discountValue: 10, applicableTo: 'all',
        startDate: '20200101', endDate: '20991231', currentUsageCount: 0, isActive: true } as never);
      const dry = await migration.migrateAssistedPharmacyWallets({ commit: false });
      assert.ok(dry.openings.some((o: any) => o.pharmacyId === L && o.amountPaise === 15000));
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: L, signedAmountPaise: { $exists: true } }), 0, 'dry run writes nothing');
      await migration.migrateAssistedPharmacyWallets({ commit: true });
      const rows = await PharmacyWalletTransactionModel.find({ pharmacyId: L }).lean() as any[];
      assert.deepEqual(rows.map((r) => r.signedAmountPaise).sort((a, b) => a - b), [-40000, 15000, 100000]);
      const wallet = await PharmacyWalletModel.findOne({ pharmacyId: L }).lean() as any;
      assert.equal(wallet.balancePaise, 75000); assert.equal(wallet.withdrawableMinor, 0); assert.ok(wallet.ledgerOpenedAt);
      assert.equal(rows.reduce((a, r) => a + r.signedAmountPaise, 0), wallet.balancePaise, 'balance = Σ signed entries');
      assert.equal((await PharmacyCustomerModel.findById(link._id).lean() as any).typedName, 'Holder Three', 'typedName backfilled where the pharmacy opened the account');
      assert.equal((await CouponModel.findOne({ code: 'OLDCORP' }).lean() as any).fundedBy, 'platform');
      // The phase 1a wallets keep their withdrawable amount (only missing values are set).
      assert.equal((await balanceOf(R)).withdrawable, 100000);
      const rerun = await migration.migrateAssistedPharmacyWallets({ commit: true });
      assert.equal(rerun.openings.length, 0); assert.equal(rerun.signedFilled, 0);
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: L }), 3);
    });

    await check('earnings: completion posts provider_coupon_v2 (after a provider coupon, cut 0); platform-funded uses the list; no-show earns nothing', async () => {
      const toPast = async (id: string) => {
        const past = istParts(new Date(Date.now() - 40 * MIN));
        await BookingModel.updateOne({ _id: id }, { $set: { bookingDate: past.date, bookingTime: past.time } });
      };
      await toPast(couponBooking);
      await expect('D', 'PATCH', `/specialists/me/appointments/${couponBooking}/status`, 200, { status: 'completed' });
      const e1 = await LedgerEntryModel.find({ source: 'consultation', sourceId: couponBooking }).lean() as any[];
      assert.equal(e1.length, 1); assert.equal(e1[0].amountMinor, 40000); assert.equal(e1[0].grossMinor, 40000); assert.equal(e1[0].commissionMinor, 0);
      await CouponModel.updateOne({ code: 'CORP100' }, { $set: { partnerUsable: true } });
      const p = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { couponCode: 'CORP100', acceptedPriceMinor: 40000 }));
      const pid = p.json.data.booking._id;
      assert.equal((await BookingModel.findById(pid).lean() as any).assisted.split.providerMinor, 50000);
      await toPast(pid);
      await expect('D', 'PATCH', `/specialists/me/appointments/${pid}/status`, 200, { status: 'completed' });
      assert.equal((await LedgerEntryModel.findOne({ source: 'consultation', sourceId: pid }).lean() as any).amountMinor, 50000, 'Jansetu bears a platform coupon');
      const n = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      const nid = n.json.data.booking._id;
      await toPast(nid);
      await expect('D', 'PATCH', `/specialists/me/appointments/${nid}/status`, 200, { status: 'no_show' });
      assert.equal(await LedgerEntryModel.countDocuments({ sourceId: nid }), 0);
      const nb = await BookingModel.findById(nid).lean() as any;
      assert.equal(nb.assisted.funding.state, 'captured', 'a no-show keeps the money');
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${nid}/cancel`, 409, {}, 'BOOKING_NOT_CANCELLABLE');
    });

    // ───────────────────────── Limits (P7) ─────────────────────────
    await check('limits: bookings per phone a day, new accounts a day, and 20 booker cancellations stop new bookings (cancels still allowed)', async () => {
      process.env.ASSISTED_LIMIT_BOOKINGS_PER_PHONE_PER_DAY = '1';
      try {
        await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { phone: '9600000601', patient: { relation: 'self', name: 'Once Only' } }));
        const hit = await expect('Q', 'POST', '/pharmacy-assisted/consultations', 429, consult(await futureSlot(), { phone: '9600000601', patient: { relation: 'self', name: 'Once Only' } }), 'ASSISTED_LIMIT_REACHED');
        assert.equal(hit.json.limit, 'bookings_per_phone', 'across bookers');
      } finally { process.env.ASSISTED_LIMIT_BOOKINGS_PER_PHONE_PER_DAY = '1000'; }
      process.env.ASSISTED_LIMIT_NEW_ACCOUNTS_PER_DAY = '1';
      try {
        await adminTopup(U, 1);
        const T = oid();
        await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(T), name: 'Limit Pharmacy', phone: '9700000212', isActive: true, isVerified: true } as never);
        (tokens as any).T = sign({ _id: T, pharmacyId: T, userType: 'pharmacy' });
        await adminTopup(T, 2000);
        await expect('T' as Who, 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { phone: '9600000701', patient: { relation: 'self', name: 'New One' } }));
        const hit = await expect('T' as Who, 'POST', '/pharmacy-assisted/consultations', 429, consult(await futureSlot(), { phone: '9600000702', patient: { relation: 'self', name: 'New Two' } }), 'ASSISTED_LIMIT_REACHED');
        assert.equal(hit.json.limit, 'new_accounts');
        assert.equal(await UserModel.countDocuments({ phone: '9600000702' }), 0, 'no account opened over the limit');
        await expect('T' as Who, 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { phone: '9600000202', patient: { relation: 'self', name: 'Bikash' } }));
      } finally { delete process.env.ASSISTED_LIMIT_NEW_ACCOUNTS_PER_DAY; }
      process.env.ASSISTED_LIMIT_BOOKER_CANCELLATIONS_PER_DAY = '2';
      try {
        // P already cancelled bookings today as the booker; take a fresh booker for an exact count.
        const V = oid();
        await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(V), name: 'Cancel Pharmacy', phone: '9700000213', isActive: true, isVerified: true } as never);
        (tokens as any).V = sign({ _id: V, pharmacyId: V, userType: 'pharmacy' });
        await adminTopup(V, 5000);
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) ids.push((await expect('V' as Who, 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { phone: `96000008${i}0`, patient: { relation: 'self', name: `C ${i}` } }))).json.data.booking._id);
        await expect('V' as Who, 'POST', `/pharmacy-assisted/bookings/${ids[0]}/cancel`, 200, {});
        await expect('V' as Who, 'POST', `/pharmacy-assisted/bookings/${ids[1]}/cancel`, 200, {});
        const hit = await expect('V' as Who, 'POST', '/pharmacy-assisted/consultations', 429, consult(await futureSlot(), { phone: '9600000890', patient: { relation: 'self', name: 'C x' } }), 'ASSISTED_LIMIT_REACHED');
        assert.equal(hit.json.limit, 'booker_cancellations');
        await expect('V' as Who, 'POST', `/pharmacy-assisted/bookings/${ids[2]}/cancel`, 200, {}); // cancellations stay allowed
        assert.equal(await assistedModels.AssistedAlertModel.countDocuments({ kind: 'booker_cancellations', bookerId: V }), 1, 'an alert is raised once');
      } finally { delete process.env.ASSISTED_LIMIT_BOOKER_CANCELLATIONS_PER_DAY; }
    });

    // ───────────────────────── "This isn't mine" and the admin move (P8) ─────────────────────────
    let disputed = '';
    await check('not mine: the holder reports; hidden from their lists (direct read works); queued; booker badge; once', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      disputed = r.json.data.booking._id;
      await expect('Y', 'POST', `/bookings/${disputed}/not-mine`, 404, {}, 'BOOKING_NOT_FOUND');
      const own = (await BookingModel.create({ bookingType: 'consultation', userId: X, bookingDate: '20991231', bookingTime: '10:00', serviceMode: 'video',
        price: 100, status: 'confirmed', paymentStatus: 'paid' } as never))._id;
      await expect('X', 'POST', `/bookings/${String(own)}/not-mine`, 409, {}, 'NOT_ASSISTED_BOOKING');
      await expect('X', 'POST', `/bookings/${disputed}/not-mine`, 200, { note: 'not me' });
      await expect('X', 'POST', `/bookings/${disputed}/not-mine`, 409, {}, 'ALREADY_REPORTED');
      const list = await expect('X', 'GET', '/bookings', 200);
      assert.equal(list.json.data.some((b: any) => b._id === disputed), false, 'hidden from the list');
      const paged = await expect('X', 'GET', '/bookings?page=1&limit=100', 200);
      assert.equal(paged.json.data.some((b: any) => b._id === disputed), false, 'hidden from the paged list');
      await expect('X', 'GET', `/bookings/${disputed}`, 200);
      const items = await expect('ADMIN', 'GET', '/admin/assisted/review-items?state=open', 200);
      assert.ok(items.json.data.some((i: any) => i.bookingId === disputed && i.booking.shortRef));
      const view = await expect('P', 'GET', `/pharmacy-bookings/${disputed}`, 200);
      assert.equal(view.json.data.assisted.disputed.state, 'open');
      assert.ok(notices.some((n) => n.key === `assisted:${disputed}:not_mine:booker`));
    });

    await check('admin move: to the right account as a family member, exactly once; the old holder loses access at once', async () => {
      const b0 = await BookingModel.findById(disputed).lean() as any;
      const body = { toPhone: '9600000203', asFamily: { name: 'Little Three', relation: 'Son' }, holderName: 'Holder Three', reason: 'wrong number',
        requestKey: newKey(), expectedUpdatedAt: b0.updatedAt };
      await expect('ADMIN', 'POST', `/admin/assisted-bookings/${disputed}/move`, 409, { ...body, expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }, 'BOOKING_CHANGED');
      const m = await expect('ADMIN', 'POST', `/admin/assisted-bookings/${disputed}/move`, 200, body);
      assert.equal(m.json.data.replayed, false); assert.equal(m.json.data.booking.userId, H);
      const again = await expect('ADMIN', 'POST', `/admin/assisted-bookings/${disputed}/move`, 200, body);
      assert.equal(again.json.data.replayed, true);
      await expect('ADMIN', 'POST', `/admin/assisted-bookings/${disputed}/move`, 409, { ...body, reason: 'other' }, 'IDEMPOTENCY_KEY_REUSED');
      const b = await BookingModel.findById(disputed).lean() as any;
      assert.equal(b.userId, H); assert.equal(b.assisted.identity.disputed.state, 'moved'); assert.equal(b.assisted.join.linkVersion, 2);
      assert.equal((await DependentModel.findById(b.dependentId).lean() as any).userId.toString(), H);
      await expect('X', 'GET', `/bookings/${disputed}`, 404);
      await expect('H', 'GET', `/bookings/${disputed}`, 200);
      assert.equal((await PharmacyCustomerModel.findOne({ pharmacyId: P, userId: H }).lean() as any).typedName, 'Holder Three');
      assert.ok(await PharmacyCustomerModel.exists({ pharmacyId: P, userId: X }), 'the old link stays while other bookings of this pharmacy use it');
      const item = await assistedModels.AssistedReviewItemModel.findOne({ bookingId: disputed }).lean() as any;
      assert.equal(item.state, 'moved');
      assert.ok(notices.some((n) => n.userId === X && n.title === 'A booking was moved off your account'));
      assert.equal(await assistedModels.AssistedAuditEventModel.countDocuments({ action: 'booking.moved', bookingId: disputed }), 1);
      // The coupon redemption follows the patient.
      const cb = await BookingModel.findById(couponBooking).lean() as any;
      await expect('ADMIN', 'POST', `/admin/assisted-bookings/${couponBooking}/move`, 200, { toPhone: '9600000202', reason: 'moved', requestKey: newKey(),
        expectedUpdatedAt: cb.updatedAt });
      assert.equal((await CouponRedemptionModel.findOne({ bookingId: couponBooking }).lean() as any).patientUserId, Y, 'completed bookings move too');
      await expect('P', 'POST', `/admin/assisted-bookings/${disputed}/move`, 403);
    });

    await check('dismiss: a report that was not moved shows in the holder\'s lists again', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      const id = r.json.data.booking._id;
      await expect('X', 'POST', `/bookings/${id}/not-mine`, 200, {});
      const item = await assistedModels.AssistedReviewItemModel.findOne({ bookingId: id }).lean() as any;
      await expect('ADMIN', 'POST', `/admin/assisted/review-items/${String(item._id)}/dismiss`, 200, { reason: 'holder confirmed by phone' });
      await expect('ADMIN', 'POST', `/admin/assisted/review-items/${String(item._id)}/dismiss`, 409, {}, 'REVIEW_ITEM_CLOSED');
      const list = await expect('X', 'GET', '/bookings', 200);
      assert.ok(list.json.data.some((b: any) => b._id === id));
    });

    // ───────────────────────── Customer list and freeze ─────────────────────────
    await check('customer list: only the typed name (or masked) and phone, never the account name or email; typed-name edit', async () => {
      const l = await expect('P', 'GET', '/pharmacy-customers?limit=100', 200);
      for (const row of l.json.data) assert.equal(row.userId.email, null);
      assert.equal(l.text.includes('rina@example'), false); assert.equal(l.text.includes('Rina Kumari Das'), false);
      const x = l.json.data.find((row: any) => String(row.userId._id) === X);
      assert.equal(x.userId.name, 'Rina Das');
      const byAccountName = await expect('P', 'GET', '/pharmacy-customers?search=Kumari', 200);
      assert.equal(byAccountName.json.data.length, 0, 'the account name is not searchable');
      const byTyped = await expect('P', 'GET', '/pharmacy-customers?search=Rina%20Das', 200);
      assert.equal(byTyped.json.data.length, 1);
      const masked = await PharmacyCustomerModel.create({ pharmacyId: Q, userId: X, consent: 'patient_agreed' } as never);
      const q = await expect('Q', 'GET', '/pharmacy-customers', 200);
      assert.equal(q.json.data.find((row: any) => String(row.userId._id) === X).userId.name, 'Rina D.', 'another pharmacy\'s link without a typed name is masked');
      await expect('Q', 'PUT', `/pharmacy-customers/${String(masked._id)}/typed-name`, 200, { typedName: 'Rina (Q)' });
      await expect('P', 'PUT', `/pharmacy-customers/${String(masked._id)}/typed-name`, 404, { typedName: 'Steal' }, 'CUSTOMER_NOT_LINKED');
      const q2 = await expect('Q', 'GET', '/pharmacy-customers', 200);
      assert.equal(q2.json.data.find((row: any) => String(row.userId._id) === X).userId.name, 'Rina (Q)');
      assert.equal(await assistedModels.AssistedAuditEventModel.countDocuments({ action: 'customer.typed_name', orgId: Q }), 1);
    });

    await check('freeze: a frozen wallet refuses spending (credits still post); audited', async () => {
      await expect('ADMIN', 'PUT', `/admin/pharmacies/${P}/wallet/freeze`, 200, { frozen: true, reason: 'chargeback review' });
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 409, consult(await futureSlot()), 'WALLET_FROZEN');
      const before = (await balanceOf(P)).paise;
      await adminTopup(P, 10);
      assert.equal((await balanceOf(P)).paise, before + 1000);
      await expect('ADMIN', 'PUT', `/admin/pharmacies/${P}/wallet/freeze`, 200, { frozen: false, reason: 'cleared' });
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      assert.equal(await assistedModels.AssistedAuditEventModel.countDocuments({ action: { $in: ['wallet.frozen', 'wallet.unfrozen'] }, orgId: P }), 2);
    });

    // ───────────────────────── Meet ─────────────────────────
    await check('Meet: the invite is neutral (no patient, concern or speciality); guest check', async () => {
      const b = await BookingModel.findById(firstBooking).lean() as any;
      const text = meet.meetEventTextFor(b, { specialistEmail: 'asha@doc.test', bookerEmail: 'sharma@pharm.test' });
      assert.equal(text.summary, 'Jansetu consultation');
      assert.equal(text.description, `Jansetu booking reference: ${b.assisted.shortRef}`);
      const all = JSON.stringify(text);
      for (const t of ['Lalthan', 'fever', 'General Physician', '9600000301']) assert.equal(all.includes(t), false, t);
      assert.equal(text.guestAccess, 'attendee');
      assert.equal(meet.meetEventTextFor(b, { specialistEmail: 'asha@doc.test', bookerEmail: null }).guestAccess, 'ask_to_join');
      const g = await expect('ADMIN', 'GET', `/admin/assisted/meet-guest-check/${firstBooking}`, 200);
      assert.equal(g.json.data.summary, 'Jansetu consultation'); assert.equal(g.json.data.guestAccess, 'attendee');
    });

    // ───────────────────────── Reconciliation and stuck money ─────────────────────────
    await check('reconciliation: clean after all the above; a tampered balance is reported (never fixed); stuck money lists', async () => {
      await migration.migrateAssistedPharmacyWallets({ commit: true }); // open the wallets created during this run
      const ok = await expect('ADMIN', 'GET', '/admin/assisted/reconciliation', 200);
      assert.deepEqual(ok.json.data.checks.mismatches, [], JSON.stringify(ok.json.data.checks.mismatches).slice(0, 400));
      assert.equal(ok.json.data.ok, true);
      assert.ok(ok.json.data.checks.bookings.checked > 10);
      await PharmacyWalletModel.updateOne({ pharmacyId: R }, { $inc: { balancePaise: 1 } });
      const bad = await expect('ADMIN', 'GET', '/admin/assisted/reconciliation', 200);
      assert.ok(bad.json.data.checks.mismatches.some((m: any) => m.check === 'wallet_balance' && m.ref === R));
      assert.equal((await PharmacyWalletModel.findOne({ pharmacyId: R }).lean() as any).balancePaise % 10, 1, 'reported, not fixed');
      await PharmacyWalletModel.updateOne({ pharmacyId: R }, { $inc: { balancePaise: -1 } });
      // A paid booking 8 days after its slot, and a paid top-up never credited.
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      const old = istParts(new Date(Date.now() - 8 * DAY));
      await BookingModel.updateOne({ _id: r.json.data.booking._id }, { $set: { bookingDate: old.date, bookingTime: old.time } });
      const rec = await PaymentRecordModel.create({ userId: R, payerUserId: R, payerPharmacyId: R, context: 'wallet_recharge', contextId: 'x', baseAmount: 5,
        discountAmount: 0, finalAmount: 5, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'order_lost_' + oid(), status: 'paid',
        notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: R } } as never);
      const stuck = await expect('ADMIN', 'GET', '/admin/assisted/stuck-money', 200);
      assert.ok(stuck.json.data.paidBookingsStuckAfterSlot.some((x: any) => x.bookingId === r.json.data.booking._id));
      assert.ok(stuck.json.data.topupsCapturedNotCredited.some((x: any) => x.paymentTransactionId === String(rec._id)));
      const unc = await expect('ADMIN', 'GET', '/admin/wallet-recharges/uncredited', 200);
      assert.ok(unc.json.data.some((x: any) => x.paymentTransactionId === String(rec._id)));
      const daily = await reconciliation.runDailyReconciliation(async () => undefined);
      assert.equal(daily.ok, true);
      const stored = await expect('ADMIN', 'GET', `/admin/assisted/reconciliation?day=${daily.day}`, 200);
      assert.equal(stored.json.data.day, daily.day);
      await expect('P', 'GET', '/admin/assisted/reconciliation', 403);
    });

    await check('switches off again: no new bookings, but cancellations and refunds keep working (§15 rollback)', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      flagsOff();
      try {
        await expect('P', 'POST', '/pharmacy-assisted/consultations', 503, consult(await futureSlot()), 'ASSISTED_BOOKING_DISABLED');
        const before = (await balanceOf(P)).paise;
        await expect('P', 'POST', `/pharmacy-assisted/bookings/${r.json.data.booking._id}/cancel`, 200, {});
        assert.equal((await balanceOf(P)).paise, before + 50000);
        await expect('X', 'POST', `/bookings/${r.json.data.booking._id}/not-mine`, 503, {}, 'ASSISTED_BOOKING_DISABLED');
      } finally { flagsOn(); }
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`${passed} checks passed, ${failed.length} failed`);
  if (failed.length) throw new Error('Assisted phase 1a checks failed: ' + failed.join('; '));
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
