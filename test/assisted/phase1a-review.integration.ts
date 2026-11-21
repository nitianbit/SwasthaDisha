/**
 * Assisted booking phase 1a — fixes of the review of b4ae54e (ASSISTED_BOOKING_DESIGN.md §19.6). One check per fix; each
 * fails on b4ae54e. Same wiring as test/assisted/phase1a.integration.ts (its own database).
 *
 * Original suite header: Assisted booking phase 1a (ASSISTED_BOOKING_DESIGN.md §17, §6, §8, §13 row 1a): a pharmacy books a doctor consultation
 * for a walk-in patient and pays from its Jansetu wallet. Money (one debit under concurrency and replay; refunds on every
 * cancel path, always posting), accounting (withdrawable lots, the opening-balance migration, provider_coupon_v2 earning
 * with cut 0, no earning on no-show), limits, the admin move and "not mine", privacy of the lookup and the customer list,
 * views, and every switch off.
 * Real authenticate + bookings / pharmacy-assisted / pharmacy-bookings / pharmacy-customers / pharmacy-wallet /
 * specialists / admin routers over HTTP against MongoDB; Razorpay, Meet, reminders and notifications are stubs.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/assisted_phase1a_review_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/assisted/phase1a-review.integration.ts
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

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/assisted_phase1a_review_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;
/** IST date YYYYMMDD and time HH:mm of an instant. */
const istParts = (at: Date) => { const s = new Date(at.getTime() + IST).toISOString(); return { date: s.slice(0, 10).replace(/-/g, ''), time: s.slice(11, 16) }; };

// The prescription save writes PDFs: a converter stand-in copies the HTML (as the phase 0 suite does).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assisted-p1a-review-')));
fs.mkdirSync(path.join(WORK, 'files'));
const CONVERTER = path.join(WORK, 'fake-wkhtmltopdf.sh');
fs.writeFileSync(CONVERTER, `#!/bin/sh\ncp "$1" "$2"\n`, { mode: 0o755 });
process.env.WKHTMLTOPDF_BINARY = CONVERTER;
(CONFIG as { UPLOAD_DIR: string }).UPLOAD_DIR = path.join(WORK, 'files');

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
  // Review 9: an error carrying arbitrary fields, to see what the error handler lets out.
  const { AppError } = await import('@/modules/common/types');
  app.post('/api/v1/__err/:code', (req, _res, next) => next(Object.assign(new AppError({ status: 409, code: req.params.code, message: 'x' }),
    { limit: 'lookups', details: { priceMinor: 100, listMinor: 200, discountMinor: 100, userEmail: 'secret@example.test', nested: { a: 1 } } })));
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;

  // Most checks book for the same few numbers: the per-number limit is set high here and tested on its own below.
  process.env.ASSISTED_LIMIT_BOOKINGS_PER_PHONE_PER_DAY = '1000';
  // Every create also counts as a lookup (review 4): the hourly lookup limit is set high too, and tested on its own.
  process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '100000';
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

    flagsOn();
    await adminTopup(P, 50000);
    const { default: PharmacyOrderModel } = await import('@/modules/pharmacyOrders/model');
    const { bindServerFile, decideFileAccess } = await import('@/modules/file/access');
    const { Job } = await import('@/modules/queue/model');
    const { dispensingCopyConsumer, DISPENSING_COPY_CONSUMER } = await import('@/modules/assisted/dispensingCopy');
    const { withLinkNames } = await import('@/modules/assisted/names');

    await check('1 migration rerun: an opened wallet is never opened again; a later mismatch is reported, not written', async () => {
      const Z = oid();
      await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(Z), name: 'Rerun Pharmacy', phone: '9700000301', isActive: true, isVerified: true } as never);
      await adminTopup(Z, 1000);
      await migration.migrateAssistedPharmacyWallets({ commit: true });
      assert.ok((await PharmacyWalletModel.findOne({ pharmacyId: Z }).lean() as any).ledgerOpenedAt);
      await PharmacyWalletModel.updateOne({ pharmacyId: Z }, { $inc: { balancePaise: 25000, balance: 250 } }); // drift after opening
      const dry = await migration.migrateAssistedPharmacyWallets({ commit: false });
      assert.equal(dry.openings.filter((o: any) => o.pharmacyId === Z).length, 0, 'no opening proposed for an opened wallet');
      const rerun = await migration.migrateAssistedPharmacyWallets({ commit: true });
      assert.equal(rerun.openings.filter((o: any) => o.pharmacyId === Z).length, 0);
      assert.deepEqual(rerun.openedWalletMismatches.filter((m: any) => m.pharmacyId === Z).map((m: any) => [m.balancePaise, m.entriesPaise]), [[125000, 100000]]);
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: Z, transactionType: 'opening_balance' }), 0, 'nothing written');
      await PharmacyWalletModel.updateOne({ pharmacyId: Z }, { $inc: { balancePaise: -25000, balance: -250 } });
    });

    await check('2 move within one account (to a family member of the same holder) keeps the pharmacy link', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      const id = r.json.data.booking._id;
      const m = await expect('ADMIN', 'POST', `/admin/assisted-bookings/${id}/move`, 200, { toPhone: '9600000201', asFamily: { name: 'Mina Das', relation: 'Daughter' },
        reason: 'it was for the daughter', requestKey: newKey() });
      assert.equal(m.json.data.booking.userId, X); assert.equal(m.json.data.booking.dependentId, depX);
      const link = await PharmacyCustomerModel.findOne({ pharmacyId: P, userId: X }).lean() as any;
      assert.ok(link, 'the link stays'); assert.equal(link.typedName, 'Rina Das'); assert.equal(link.consent, 'patient_agreed');
    });

    await check('3 move: medicine orders and their copy go to the new holder; the booking\'s new family member leaves the old account', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { phone: '9600000202',
        patient: { relation: 'Father', name: 'Ram Prasad Verma', gender: 'Male', dateOfBirth: '1950-02-03' }, holderName: 'Wrong Holder' }));
      const id = r.json.data.booking._id;
      const b0 = await BookingModel.findById(id).lean() as any;
      const rel = `bookings/${id}/rx-dispense-1700000000000-0123456789abcdef.pdf`;
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { status: 'completed', 'lifecycle.prescriptionUploaded': { at: new Date().toISOString() },
        prescription: { medicines: [{ name: 'Donepezil 5' }], advice: 'x', prescribedAt: new Date().toISOString(), dispensingCopy: { url: '/api/static/' + rel, hash: 'h', at: new Date() } } } });
      const orderId = new Types.ObjectId();
      await PharmacyOrderModel.collection.insertOne({ _id: orderId, orderNumber: 'P1A-R-1', pharmacyId: new Types.ObjectId(P), customerId: new Types.ObjectId(Y), orderType: 'in_store',
        status: 'placed', paymentStatus: 'pending', items: [{ medicineName: 'Donepezil 5', orderedQty: 1 }], prescriptionUrls: ['/api/static/' + rel], linkedConsultationId: new Types.ObjectId(id),
        prescriptionFromBooking: { bookingId: id, fileUrl: '/api/static/' + rel, bindingExpiresAt: new Date(Date.now() + 80 * DAY), requestKey: 'p1a-review-order1', requestHash: 'x' },
        createdAt: new Date(), updatedAt: new Date() } as never);
      await bindServerFile(rel, 'pharmacy_order', { model: 'PharmacyOrder', resourceId: orderId, field: 'prescriptionUrls' }, { expiresAt: new Date(Date.now() + 80 * DAY), keepIfDispensed: true });
      assert.equal((await decideFileAccess({ _id: Y, userType: 'user' } as never, rel)).allow, true, 'before the move the holder reads it');
      await expect('ADMIN', 'POST', `/admin/assisted-bookings/${id}/move`, 200, { toPhone: '9600000203', asFamily: { name: 'Ram Prasad Verma', relation: 'Father' },
        holderName: 'Right Holder', reason: 'wrong number', requestKey: newKey() });
      assert.equal(String((await PharmacyOrderModel.findById(orderId).lean() as any).customerId), H, 'the order follows the booking');
      assert.equal((await decideFileAccess({ _id: Y, userType: 'user' } as never, rel)).allow, false, 'the old holder is refused the copy');
      assert.equal((await decideFileAccess({ _id: H, userType: 'user' } as never, rel)).allow, true, 'the new holder reads it');
      assert.equal((await DependentModel.findById(b0.dependentId).lean() as any).isActive, false, 'the family member this booking created is deactivated');
      // A family member that existed before the booking is never touched by a move.
      const own = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { patient: { dependentId: depX } }));
      await expect('ADMIN', 'POST', `/admin/assisted-bookings/${own.json.data.booking._id}/move`, 200, { toPhone: '9600000203', reason: 'x', requestKey: newKey() });
      assert.equal((await DependentModel.findById(depX).lean() as any).isActive, true);
    });

    await check('4 create is no existence test: validation first, no account unless the booking commits, every attempt counted and audited', async () => {
      const unknown = '9600000901';
      const known = '9600000201';
      const a = await expect('P', 'POST', '/pharmacy-assisted/consultations', 409, consult(await futureSlot(), { phone: unknown, acceptedPriceMinor: 1 }), 'PRICE_CHANGED');
      const b = await expect('P', 'POST', '/pharmacy-assisted/consultations', 409, consult(await futureSlot(), { phone: known, acceptedPriceMinor: 1 }), 'PRICE_CHANGED');
      assert.deepEqual(a.json, { ...b.json }, 'the same answer for a known and an unknown number');
      assert.equal(await UserModel.countDocuments({ phone: unknown }), 0, 'a refused booking opens no account');
      // A booking that fails inside the transaction (wallet short) leaves no account either.
      const Poor = oid();
      await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(Poor), name: 'Poor Pharmacy', phone: '9700000302', isActive: true, isVerified: true } as never);
      (tokens as any).Poor = sign({ _id: Poor, pharmacyId: Poor, userType: 'pharmacy' });
      await expect('Poor' as Who, 'POST', '/pharmacy-assisted/consultations', 409, consult(await futureSlot(), { phone: unknown, patient: { relation: 'self', name: 'Nobody' } }), 'INSUFFICIENT_BALANCE');
      assert.equal(await UserModel.countDocuments({ phone: unknown }), 0, 'a failed booking opens no account');
      assert.equal(await assistedModels.AssistedAuditEventModel.countDocuments({ action: 'booking.attempted', orgId: Poor }), 1, 'every attempt is audited');
      process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '1'; // Poor's one attempt above already counted this hour
      try {
        await adminTopup(Poor, 10);
        const hit = await expect('Poor' as Who, 'POST', '/pharmacy-assisted/consultations', 429, consult(await futureSlot(), { phone: known }), 'ASSISTED_LIMIT_REACHED');
        assert.equal(hit.json.limit, 'lookups', 'creates count against the lookup limit');
        await expect('Poor' as Who, 'POST', '/pharmacy-assisted/patients/lookup', 429, { phone: known }, 'ASSISTED_LIMIT_REACHED');
      } finally { process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '100000'; }
      const ok = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { phone: unknown, patient: { relation: 'self', name: 'Now Booked' } }));
      assert.equal(ok.json.data.newAccount, true);
      const u = await UserModel.findOne({ phone: unknown }).lean() as any;
      assert.equal(u.name, 'Now Booked'); assert.equal(u.createdSource, 'assisted_booking'); assert.equal(u.otpVerified, false);
    });

    let rxBooking = '';
    await check('5 the patient and doctor views carry no lifecycle amount or payer', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      rxBooking = r.json.data.booking._id;
      for (const [who, url] of [['X', `/bookings/${rxBooking}`], ['D', `/specialists/me/appointments/${rxBooking}`]] as [Who, string][]) {
        const v = await expect(who, 'GET', url, 200);
        const b = v.json.data.booking ?? v.json.data;
        assert.ok(b.lifecycle?.paid?.at, `${who} keeps the time`);
        assert.equal(b.lifecycle.paid.amount, undefined, `${who}: no amount`); assert.equal(b.lifecycle.paid.by, undefined, `${who}: no payer`);
        assert.equal(JSON.stringify(b).includes('pharmacy_wallet'), false);
      }
      const list = await expect('D', 'GET', '/specialists/me/appointments?view=all', 200);
      const row = list.json.data.find((x: any) => x._id === rxBooking);
      assert.ok(row && row.lifecycle.paid.amount === undefined);
    });

    await check('6 the doctor\'s prescription-save answer is the scrubbed doctor view', async () => {
      const past = istParts(new Date(Date.now() - 40 * MIN));
      await BookingModel.updateOne({ _id: rxBooking }, { $set: { bookingDate: past.date, bookingTime: past.time } });
      const r = await expect('D', 'POST', `/specialists/me/appointments/${rxBooking}/prescription`, 200, { diagnosis: 'd', advice: 'a', medicines: [{ name: 'M' }] });
      const a = r.json.data.assisted;
      assert.deepEqual(Object.keys(a).sort(), ['bookedBy', 'identity', 'join', 'preferredLanguage', 'shortRef']);
      assert.equal(r.json.data.price, undefined); assert.equal(r.json.data.lifecycle.paid.amount, undefined);
      assert.equal(r.json.data.prescription.diagnosis, 'd', 'the doctor sees what they wrote');
    });

    await check('7 chargeback: the lot closes for good, the wallet owes the shortfall and freezes; no bookings until a top-up clears it', async () => {
      const C = oid();
      await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(C), name: 'Dispute Pharmacy', phone: '9700000303', isActive: true, isVerified: true } as never);
      (tokens as any).C = sign({ _id: C, pharmacyId: C, userType: 'pharmacy' });
      const recharge = async (amount: number) => {
        const orderId = 'order_cb_' + oid();
        const rec = await PaymentRecordModel.create({ userId: C, payerUserId: C, payerPharmacyId: C, context: 'wallet_recharge', contextId: `pharmacy_${C}_${oid()}`,
          baseAmount: amount, discountAmount: 0, finalAmount: amount, baseAmountPaise: amount * 100, finalAmountPaise: amount * 100, currency: 'INR',
          paymentGateway: 'razorpay', razorpayOrderId: orderId, status: 'created', notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: C } } as never);
        gateway.payments[orderId] = [{ id: 'pay_' + oid(), order_id: orderId, amount: amount * 100, currency: 'INR', status: 'captured', fee: 100 }];
        await expect('C' as Who, 'POST', `/pharmacy-wallet/topups/${String((rec as any)._id)}/check`, 200);
        return String((rec as any)._id);
      };
      const t1 = await recharge(800);
      await expect('C' as Who, 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { phone: '9600000911', patient: { relation: 'self', name: 'Dispute One' } }));
      assert.deepEqual(await balanceOf(C), { paise: 30000, withdrawable: 30000 });
      const lot = await WalletTopupLotModel.findOne({ paymentRecordId: t1 }).lean() as any;
      const lots = await expect('ADMIN', 'GET', `/admin/pharmacies/${C}/wallet/lots`, 200);
      assert.equal(lots.json.data[0]._id, String(lot._id));
      const cb = await expect('ADMIN', 'POST', `/admin/wallet-lots/${String(lot._id)}/chargeback`, 200, { reason: 'Razorpay dispute lost' });
      assert.equal(cb.json.data.replayed, false);
      const w = await PharmacyWalletModel.findOne({ pharmacyId: C }).lean() as any;
      assert.equal(w.balancePaise, 0); assert.equal(w.receivableMinor, 50000, 'what the balance could not cover is owed'); assert.equal(w.frozen, true);
      assert.equal(w.withdrawableMinor, 0);
      const closed = await WalletTopupLotModel.findById(lot._id).lean() as any;
      assert.equal(closed.closed, true); assert.equal(closed.disputeState, 'lost'); assert.equal(closed.remainingMinor, 0);
      assert.equal((await expect('ADMIN', 'POST', `/admin/wallet-lots/${String(lot._id)}/chargeback`, 200, { reason: 'again' })).json.data.replayed, true);
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: C, transactionType: 'chargeback' }), 1, 'once per lot');
      await expect('C' as Who, 'POST', '/pharmacy-assisted/consultations', 409, consult(await futureSlot(), { phone: '9600000912', patient: { relation: 'self', name: 'Dispute Two' } }), 'WALLET_RECEIVABLE');
      await expect('ADMIN', 'PUT', `/admin/pharmacies/${C}/wallet/freeze`, 409, { frozen: false, reason: 'try' }, 'WALLET_RECEIVABLE');
      const rec = await expect('ADMIN', 'GET', '/admin/assisted/reconciliation', 200);
      assert.ok(rec.json.data.checks.walletsOwing.some((x: any) => x.pharmacyId === C && x.receivableMinor === 50000));
      // A later top-up clears what is owed first.
      await recharge(700);
      const w2 = await PharmacyWalletModel.findOne({ pharmacyId: C }).lean() as any;
      assert.equal(w2.receivableMinor, 0); assert.equal(w2.balancePaise, 20000);
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: C, transactionType: 'receivable_setoff', amountPaise: 50000 }), 1);
      const rows = await PharmacyWalletTransactionModel.find({ pharmacyId: C }).lean() as any[];
      assert.equal(rows.reduce((x, r) => x + r.signedAmountPaise, 0), w2.balancePaise, 'balance = Σ entries holds through the dispute');
      assert.equal(await assistedModels.AssistedAuditEventModel.countDocuments({ action: 'wallet.chargeback', orgId: C }), 1);
      await expect('ADMIN', 'PUT', `/admin/pharmacies/${C}/wallet/freeze`, 200, { frozen: false, reason: 'cleared' });
      await expect('C' as Who, 'POST', '/pharmacy-assisted/consultations', 409, consult(await futureSlot(), { phone: '9600000912', patient: { relation: 'self', name: 'Dispute Two' } }), 'INSUFFICIENT_BALANCE');
    });

    await check('8a names: a consented link shows the account name on every pharmacy-facing list; otherwise typed or masked', async () => {
      const T = oid();
      await UserModel.collection.insertOne({ _id: new Types.ObjectId(T), userType: 'user', phone: '9600000921', name: 'Tenzin Wangmo Bhutia', createdSource: 'self_signup' } as never);
      await PharmacyCustomerModel.create({ pharmacyId: P, userId: T, consent: 'not_recorded', typedName: 'Tenzin (typed)' } as never);
      const rows = [{ userId: { _id: X, name: 'Rina Kumari Das', phone: '9600000201', email: 'rina@example.test' } },
        { userId: { _id: T, name: 'Tenzin Wangmo Bhutia', phone: '9600000921' } }, { userId: { _id: Y, name: 'Bikash', phone: '9600000202' } }];
      const named = await withLinkNames(rows, P, 'userId') as any[];
      assert.deepEqual(named.map((r) => r.userId.name), ['Rina Kumari Das', 'Tenzin (typed)', 'Bi…'], 'consented, typed, no link (masked)');
      assert.equal(named[0].userId.email, undefined, 'never the email');
      const view = await expect('P', 'GET', `/pharmacy-bookings/${rxBooking}`, 200);
      assert.equal(view.json.data.patientName, 'Rina Kumari Das');
    });

    await check('8b wallet history: every row reads as a credit or a debit in the released app exactly as its signed amount says', async () => {
      // The released pharmacy app (src/screens/profile/WalletScreen.tsx, lines 404-440), copied as it is.
      const appIsCredit = (t: any) => {
        const amountVal = Number(t.amount || 0);
        const rawTitle = t.description || t.notes || t.title || t.status || 'Transaction';
        const titleText = rawTitle.toLowerCase();
        const typeValue = (t.transactionType || t.type || '').toLowerCase();
        let isDebit = typeValue === 'debit' || typeValue === 'payment' || typeValue === 'booking';
        let isCredit = typeValue === 'credit' || typeValue === 'recharge' || typeValue === 'refund';
        if (!isDebit && !isCredit) {
          if (titleText.includes('payment') || titleText.includes('booking') || titleText.includes('used for')) isDebit = true;
          else if (titleText.includes('recharge') || titleText.includes('added') || titleText.includes('refilled')) isCredit = true;
          else { isCredit = amountVal > 0; isDebit = amountVal < 0; }
        }
        return isCredit;
      };
      // P has credits, booking debits and (after this cancel) a refund; C a chargeback and a set-off; a migrated wallet an opening balance.
      const c = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${c.json.data.booking._id}/cancel`, 200, {});
      const kinds = new Set<string>();
      for (const who of ['P', 'C', 'R'] as Who[]) {
        if (!(tokens as any)[who]) continue;
        const r = await expect(who, 'GET', '/pharmacy-wallet/transactions?limit=100', 200);
        for (const t of r.json.data) {
          kinds.add(t.movementType);
          if (t.signedAmountPaise === 0) continue;
          assert.equal(appIsCredit(t), t.signedAmountPaise > 0, `${t.movementType} (${t.description}) reads as ${appIsCredit(t) ? 'credit' : 'debit'}`);
        }
      }
      await adminTopup(R, 1); // R is a fresh wallet here; give it an opening entry through the migration path
      await PharmacyWalletModel.updateOne({ pharmacyId: R }, { $unset: { ledgerOpenedAt: '' }, $inc: { balancePaise: -5000, balance: -50 } });
      await migration.migrateAssistedPharmacyWallets({ commit: true });
      const r = await expect('R', 'GET', '/pharmacy-wallet/transactions?limit=100', 200);
      const opening = r.json.data.find((t: any) => t.movementType === 'opening_balance');
      assert.ok(opening && opening.signedAmountPaise === -5000 && appIsCredit(opening) === false, 'a negative opening balance reads as a debit');
      for (const k of ['credit', 'booking_debit', 'refund_credit', 'chargeback', 'receivable_setoff']) assert.ok(kinds.has(k), `covered: ${k}`);
    });

    await check('9 Meet invites the booker only for the partner device; errors carry only known safe fields; reconciliation scope; uncredited window', async () => {
      const phoneJoin = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { join: { on: 'patient_phone' } }));
      const b = await BookingModel.findById(phoneJoin.json.data.booking._id).lean() as any;
      const text = meet.meetEventTextFor(b, { specialistEmail: 'asha@doc.test', bookerEmail: 'sharma@pharm.test' });
      assert.deepEqual(text.attendees, [{ email: 'asha@doc.test' }]);
      const other = await call(null, 'POST', '/__err/SOMETHING_ELSE');
      assert.equal(other.json.details, undefined); assert.equal(other.json.limit, undefined);
      const price = await call(null, 'POST', '/__err/PRICE_CHANGED');
      assert.deepEqual(price.json.details, { priceMinor: 100, listMinor: 200, discountMinor: 100 });
      assert.equal(price.json.limit, undefined);
      const lim = await call(null, 'POST', '/__err/ASSISTED_LIMIT_REACHED');
      assert.equal(lim.json.limit, 'lookups'); assert.equal(lim.json.details, undefined);
      // Reconciliation: a broken booking untouched for 8 days is outside the daily scope, inside the full scan; once
      // flagged it is re-checked every day.
      const old = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      const oid8 = old.json.data.booking._id;
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(oid8) }, { $set: { 'assisted.split.providerMinor': 1, updatedAt: new Date(Date.now() - 8 * DAY) } });
      const daily = await expect('ADMIN', 'GET', '/admin/assisted/reconciliation', 200);
      assert.equal(daily.json.data.checks.mismatches.some((m: any) => m.ref === oid8), false);
      const full = await expect('ADMIN', 'GET', '/admin/assisted/reconciliation?full=true', 200);
      assert.ok(full.json.data.checks.mismatches.some((m: any) => m.ref === oid8 && m.check === 'split_sum'));
      await assistedModels.AssistedAlertModel.create({ key: `reconciliation_mismatch:split_sum:${oid8}:x`, kind: 'reconciliation_mismatch', day: '2026-11-01',
        detail: { check: 'split_sum', ref: oid8 }, at: new Date() });
      const flagged = await expect('ADMIN', 'GET', '/admin/assisted/reconciliation', 200);
      assert.ok(flagged.json.data.checks.mismatches.some((m: any) => m.ref === oid8), 'a flagged booking is re-checked');
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(oid8) }, { $set: { 'assisted.split.providerMinor': 50000 } });
      // Uncredited top-ups: without a sweep date, the last 30 days.
      delete process.env.WALLET_RECHARGE_SWEEP_FROM;
      const mk = async (daysAgo: number) => {
        const rec = await PaymentRecordModel.create({ userId: R, payerUserId: R, payerPharmacyId: R, context: 'wallet_recharge', contextId: 'w' + oid(), baseAmount: 5,
          discountAmount: 0, finalAmount: 5, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'order_unc_' + oid(), status: 'paid',
          notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: R } } as never);
        await PaymentRecordModel.collection.updateOne({ _id: (rec as any)._id }, { $set: { createdAt: new Date(Date.now() - daysAgo * DAY) } });
        return String((rec as any)._id);
      };
      const recent = await mk(3); const ancient = await mk(40);
      const unc = (await expect('ADMIN', 'GET', '/admin/wallet-recharges/uncredited', 200)).json.data.map((x: any) => x.paymentTransactionId);
      assert.ok(unc.includes(recent)); assert.equal(unc.includes(ancient), false);
      process.env.WALLET_RECHARGE_SWEEP_FROM = new Date(Date.now() - DAY).toISOString();
      try {
        const all = (await expect('ADMIN', 'GET', '/admin/wallet-recharges/uncredited', 200)).json.data.map((x: any) => x.paymentTransactionId);
        assert.ok(all.includes(ancient), 'with a sweep date every paid-but-uncredited top-up is listed');
      } finally { delete process.env.WALLET_RECHARGE_SWEEP_FROM; }
    });

    await check('11 the background copy job drains the whole queue in batches in one run (bounded)', async () => {
      await Job.deleteMany({ consumer: DISPENSING_COPY_CONSUMER });
      const now = Math.floor(Date.now() / 1000);
      await Job.insertMany(Array.from({ length: 25 }, () => ({ consumer: DISPENSING_COPY_CONSUMER, uniqueId: oid(), processAfter: now - 1, payload: { bookingId: oid() } })) as never);
      await dispensingCopyConsumer.init();
      assert.equal(await Job.countDocuments({ consumer: DISPENSING_COPY_CONSUMER }), 0, 'more than one batch of 10 in one run');
    });
  } finally {
    server.close();
    await mongoose.disconnect();
    fs.rmSync(WORK, { recursive: true, force: true });
  }
  console.log(`${passed} checks passed, ${failed.length} failed`);
  if (failed.length) throw new Error('Assisted phase 1a review checks failed: ' + failed.join('; '));
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
