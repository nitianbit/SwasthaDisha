/**
 * Assisted booking phase 1a — fixes of the review of b4ae54e (ASSISTED_BOOKING_DESIGN.md §19.6). One check per fix; each
 * fails on b4ae54e. Checks 12–15 (and the changed 8a) are the fixes of the review of 800dfc0 (§19.7); each fails on
 * 800dfc0. Checks 16–18 (and the changed 14) are the fixes of the review of db252c1 (§19.8); each fails on db252c1.
 * Checks 19–20 are the fixes of the review of b378f61 (§19.9); each fails on b378f61. Same wiring as test/assisted/phase1a.integration.ts (its own database).
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
import crypto from 'node:crypto';

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
type GatewayPayment = { id: string; order_id: string; amount: number; currency: string; status: string; fee?: number };
const gateway: { payments: Record<string, GatewayPayment[]> } = { payments: {} };
const fakeRazorpay = {
  orders: { create: async (o: { amount: number; currency: string }) => ({ id: 'order_p1a_' + oid(), amount: o.amount, currency: o.currency, status: 'created' }),
    fetchPayments: async (orderId: string) => ({ items: gateway.payments[orderId] ?? [] }) },
  // The browser verify (check 14) fetches the payment by id.
  payments: { fetch: async (id: string) => {
    const p = Object.values(gateway.payments).flat().find((x) => x.id === id);
    // As Razorpay answers an unknown payment id.
    if (!p) throw Object.assign(new Error('The id provided does not exist'), { statusCode: 400, error: { code: 'BAD_REQUEST_ERROR' } });
    return p;
  } },
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
  Container.set(PaymentService, payments);
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
  const { default: paymentRouter } = await import('@/modules/payment/routes');
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
  app.use('/api/v1/payments', authenticate, paymentRouter);
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

    await check('8a names: typed or masked on every pharmacy-facing list (a patient_agreed link included)', async () => {
      const T = oid();
      await UserModel.collection.insertOne({ _id: new Types.ObjectId(T), userType: 'user', phone: '9600000921', name: 'Tenzin Wangmo Bhutia', createdSource: 'self_signup' } as never);
      await PharmacyCustomerModel.create({ pharmacyId: P, userId: T, consent: 'not_recorded', typedName: 'Tenzin (typed)' } as never);
      const rows = [{ userId: { _id: X, name: 'Rina Kumari Das', phone: '9600000201', email: 'rina@example.test' } },
        { userId: { _id: T, name: 'Tenzin Wangmo Bhutia', phone: '9600000921' } }, { userId: { _id: Y, name: 'Bikash', phone: '9600000202' } }];
      const named = await withLinkNames(rows, P, 'userId') as any[];
      // Review of 800dfc0 (item 2, assumed): the pharmacy's own "patient agreed" tick shows the typed name, not the account's.
      assert.deepEqual(named.map((r) => r.userId.name), ['Rina Das', 'Tenzin (typed)', 'Bi…'], 'patient_agreed (typed), typed, no link (masked)');
      assert.equal(named[0].userId.email, undefined, 'never the email');
      const view = await expect('P', 'GET', `/pharmacy-bookings/${rxBooking}`, 200);
      assert.equal(view.json.data.patientName, 'Rina Das');
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

    // ── Review of 800dfc0 (§19.7) ──
    const pharmacyWithToken = async (name: string, phone: string) => {
      const id = oid();
      await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(id), name, phone, isActive: true, isVerified: true } as never);
      (tokens as any)[id] = sign({ _id: id, pharmacyId: id, userType: 'pharmacy' });
      return id;
    };
    /** A card top-up of `amount` rupees, captured and credited through the pharmacy's own top-up check. */
    const rechargeOf = async (pharmacyId: string, amount: number) => {
      const orderId = 'order_cb2_' + oid();
      const rec = await PaymentRecordModel.create({ userId: pharmacyId, payerUserId: pharmacyId, payerPharmacyId: pharmacyId, context: 'wallet_recharge',
        contextId: `pharmacy_${pharmacyId}_${oid()}`, baseAmount: amount, discountAmount: 0, finalAmount: amount, baseAmountPaise: amount * 100,
        finalAmountPaise: amount * 100, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: orderId, status: 'created',
        notes: { flow: 'pharmacy_wallet_recharge', pharmacyId } } as never);
      const payId = 'pay_' + oid().slice(-14);
      gateway.payments[orderId] = [{ id: payId, order_id: orderId, amount: amount * 100, currency: 'INR', status: 'captured', fee: 100 }];
      await expect(pharmacyId as Who, 'POST', `/pharmacy-wallet/topups/${String((rec as any)._id)}/check`, 200);
      return { recordId: String((rec as any)._id), payId };
    };
    /** As above with the pharmacy switch off: credited without a lot (as before phase 1a or before sync-indexes). */
    const lotlessRecharge = async (pharmacyId: string, amount: number) => {
      flagsOff();
      try { return await rechargeOf(pharmacyId, amount); } finally { flagsOn(); }
    };
    const sumOf = async (pharmacyId: string) => (await PharmacyWalletTransactionModel.find({ pharmacyId }).lean() as any[])
      .reduce((a, r) => a + Number(r.signedAmountPaise ?? 0), 0);

    await check('12 chargeback by payment: a top-up without a lot is charged back once (either route, concurrently too), audited', async () => {
      const W = await pharmacyWithToken('Lotless Pharmacy', '9700000401');
      const t = await lotlessRecharge(W, 500);
      assert.equal(await WalletTopupLotModel.countDocuments({ paymentRecordId: t.recordId }), 0, 'credited without a lot');
      assert.deepEqual(await balanceOf(W), { paise: 50000, withdrawable: 0 });
      await expect(W as Who, 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { phone: '9600000941', patient: { relation: 'self', name: 'Spent One' } }));
      assert.equal((await balanceOf(W)).paise, 0, 'the top-up was spent on a booking');
      // Before: the lot route was the only way and there is no lot.
      const cb = await expect('ADMIN', 'POST', `/admin/wallet-payments/${t.payId}/chargeback`, 200, { reason: 'Razorpay dispute lost' });
      assert.equal(cb.json.data.replayed, false); assert.equal(cb.json.data.withoutLot, true); assert.equal(cb.json.data.paymentRecordId, t.recordId);
      const w = await PharmacyWalletModel.findOne({ pharmacyId: W }).lean() as any;
      assert.equal(w.balancePaise, 0); assert.equal(w.receivableMinor, 50000, 'the spent top-up is owed'); assert.equal(w.frozen, true);
      const lot = await WalletTopupLotModel.findOne({ paymentRecordId: t.recordId }).lean() as any;
      assert.equal(String(lot._id), cb.json.data.lotId);
      assert.deepEqual([lot.closed, lot.disputeState, lot.remainingMinor, lot.amountMinor, lot.openedAtChargeback], [true, 'lost', 0, 50000, true]);
      // Once per payment: by record id, by Razorpay id again, and through the lot route.
      assert.equal((await expect('ADMIN', 'POST', `/admin/wallet-payments/${t.recordId}/chargeback`, 200, { reason: 'again' })).json.data.replayed, true);
      assert.equal((await expect('ADMIN', 'POST', `/admin/wallet-payments/${t.payId}/chargeback`, 200, { reason: 'again' })).json.data.replayed, true);
      assert.equal((await expect('ADMIN', 'POST', `/admin/wallet-lots/${String(lot._id)}/chargeback`, 200, { reason: 'again' })).json.data.replayed, true);
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: W, transactionType: 'chargeback' }), 1);
      const audits = await assistedModels.AssistedAuditEventModel.find({ action: 'wallet.chargeback', orgId: W }).lean() as any[];
      assert.equal(audits.length, 1); assert.equal(audits[0].detail.withoutLot, true); assert.equal(audits[0].detail.paymentRecordId, t.recordId);
      assert.equal(await sumOf(W), (await balanceOf(W)).paise, 'balance = Σ entries');
      await expect(W as Who, 'POST', '/pharmacy-assisted/consultations', 409, consult(await futureSlot(), { phone: '9600000942', patient: { relation: 'self', name: 'Spent Two' } }), 'WALLET_RECEIVABLE');

      // A top-up WITH a lot charged back on the lot route: the payment route answers that same chargeback.
      const W2 = await pharmacyWithToken('Lotted Pharmacy', '9700000402');
      const t2 = await rechargeOf(W2, 300);
      const lot2 = await WalletTopupLotModel.findOne({ paymentRecordId: t2.recordId }).lean() as any;
      assert.ok(lot2, 'credited with a lot');
      await expect('ADMIN', 'POST', `/admin/wallet-lots/${String(lot2._id)}/chargeback`, 200, { reason: 'lost' });
      const viaPayment = await expect('ADMIN', 'POST', `/admin/wallet-payments/${t2.payId}/chargeback`, 200, { reason: 'lost again' });
      assert.equal(viaPayment.json.data.replayed, true); assert.equal(viaPayment.json.data.lotId, String(lot2._id)); assert.equal(viaPayment.json.data.withoutLot, false);
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: W2, transactionType: 'chargeback' }), 1);

      // Concurrently, by both ids at once: one chargeback.
      const W3 = await pharmacyWithToken('Race Pharmacy', '9700000403');
      const t3 = await lotlessRecharge(W3, 200);
      const both = await Promise.all([t3.recordId, t3.payId, t3.recordId].map((id) => call('ADMIN', 'POST', `/admin/wallet-payments/${id}/chargeback`, { reason: 'race' })));
      assert.deepEqual(both.map((r) => r.status), [200, 200, 200], both.map((r) => r.text.slice(0, 200)).join(' | '));
      assert.equal(both.filter((r) => r.json.data.replayed === false).length, 1, 'exactly one is the chargeback');
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: W3, transactionType: 'chargeback' }), 1);
      assert.equal(await WalletTopupLotModel.countDocuments({ paymentRecordId: t3.recordId }), 1);
      assert.equal(await assistedModels.AssistedAuditEventModel.countDocuments({ action: 'wallet.chargeback', orgId: W3 }), 1);
      const w3 = await PharmacyWalletModel.findOne({ pharmacyId: W3 }).lean() as any;
      assert.deepEqual([w3.balancePaise, w3.receivableMinor, w3.frozen], [0, 0, true]);

      // A pre-phase-1a credit row (rupees only, no paise, no operation key): charged back by its amount.
      const W4 = await pharmacyWithToken('Old Pharmacy', '9700000404');
      const old = await PaymentRecordModel.create({ userId: W4, payerUserId: W4, payerPharmacyId: W4, context: 'wallet_recharge', contextId: `pharmacy_${W4}_old`,
        baseAmount: 300, discountAmount: 0, finalAmount: 300, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'order_old_' + oid(),
        razorpayPaymentId: 'pay_old' + oid().slice(-10), status: 'paid', isProcessed: true, notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: W4 } } as never);
      const ow = await PharmacyWalletModel.collection.insertOne({ pharmacyId: new Types.ObjectId(W4), balance: 300, balancePaise: 30000, isActive: true } as never);
      await PharmacyWalletTransactionModel.collection.insertOne({ pharmacyId: new Types.ObjectId(W4), walletId: ow.insertedId, transactionType: 'credit', amount: 300,
        balanceBefore: 0, balanceAfter: 300, status: 'completed', referenceType: 'wallet_recharge', referenceId: String((old as any)._id), signedAmountPaise: 30000 } as never);
      const oc = await expect('ADMIN', 'POST', `/admin/wallet-payments/${String((old as any)._id)}/chargeback`, 200, { reason: 'old dispute' });
      assert.equal(oc.json.data.entry.amountPaise, 30000);
      const w4 = await PharmacyWalletModel.findOne({ pharmacyId: W4 }).lean() as any;
      assert.deepEqual([w4.balancePaise, w4.receivableMinor ?? 0, w4.frozen], [0, 0, true]);

      // Refusals: never credited, not a pharmacy top-up, unknown ids; the lot index is required (fail closed).
      const unc = await PaymentRecordModel.create({ userId: W4, payerUserId: W4, payerPharmacyId: W4, context: 'wallet_recharge', contextId: `pharmacy_${W4}_unc`,
        baseAmount: 5, discountAmount: 0, finalAmount: 5, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'order_unc2_' + oid(), status: 'paid',
        notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: W4 } } as never);
      // Never credited: blocked instead (check 16), nothing taken.
      const blockedAnswer = await expect('ADMIN', 'POST', `/admin/wallet-payments/${String((unc as any)._id)}/chargeback`, 200, { reason: 'x' });
      assert.equal(blockedAnswer.json.data.blockedUncredited, true);
      const booking = await PaymentRecordModel.create({ userId: X, context: 'booking', contextId: oid(), baseAmount: 5, discountAmount: 0, finalAmount: 5,
        currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'order_bk_' + oid(), razorpayPaymentId: 'pay_bk' + oid().slice(-10), status: 'paid' } as never);
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${String((booking as any)._id)}/chargeback`, 404, { reason: 'x' }, 'TOPUP_NOT_FOUND');
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${(booking as any).razorpayPaymentId}/chargeback`, 404, { reason: 'x' }, 'TOPUP_NOT_FOUND_BY_PAYMENT_ID');
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${oid()}/chargeback`, 404, { reason: 'x' }, 'TOPUP_NOT_FOUND');
      await expect('ADMIN', 'POST', '/admin/wallet-payments/not-a-payment/chargeback', 400, { reason: 'x' });
      await expect(W as Who, 'POST', `/admin/wallet-payments/${t.payId}/chargeback`, 403, { reason: 'x' });
      const W5 = await pharmacyWithToken('Index Pharmacy', '9700000405');
      const t5 = await lotlessRecharge(W5, 100);
      const { resetIndexChecks } = await import('@/modules/common/utils/requiredIndex');
      await WalletTopupLotModel.collection.dropIndex('paymentRecordId_1');
      resetIndexChecks();
      try {
        await expect('ADMIN', 'POST', `/admin/wallet-payments/${t5.recordId}/chargeback`, 503, { reason: 'x' }, 'INDEXES_OUTDATED');
        assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: W5, transactionType: 'chargeback' }), 0);
      } finally { await WalletTopupLotModel.syncIndexes(); resetIndexChecks(); }
      assert.equal((await expect('ADMIN', 'POST', `/admin/wallet-payments/${t5.recordId}/chargeback`, 200, { reason: 'x' })).json.data.replayed, false);
    });

    await check('13 names: only a customer\'s own order shows (and finds) the account name; book-then-cancel shows the typed or masked name', async () => {
      const Z1 = oid(); const Z2 = oid(); const Z3 = oid();
      await UserModel.collection.insertMany([
        { _id: new Types.ObjectId(Z1), userType: 'user', phone: '9600000931', name: 'Zara Lyngdoh Real', createdSource: 'self_signup', otpVerified: true },
        { _id: new Types.ObjectId(Z2), userType: 'user', phone: '9600000932', name: 'Kiran Real Sangma', createdSource: 'self_signup', otpVerified: true },
        { _id: new Types.ObjectId(Z3), userType: 'user', phone: '9600000933', name: 'Customer Ordered Name', createdSource: 'self_signup', otpVerified: true },
      ] as never);
      // Book then cancel for an existing account: the pharmacy sees the name it typed, never the account's.
      const a = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { phone: '9600000931', patient: { relation: 'self', name: 'Zara Typed' } }));
      const ca = await expect('P', 'POST', `/pharmacy-assisted/bookings/${a.json.data.booking._id}/cancel`, 200, {});
      assert.equal(ca.text.includes('Lyngdoh'), false, 'the cancel answer');
      const va = await expect('P', 'GET', `/pharmacy-bookings/${a.json.data.booking._id}`, 200);
      assert.equal(va.json.data.patientName, 'Zara Typed');
      const la = await expect('P', 'GET', '/pharmacy-bookings?limit=50', 200);
      assert.equal(la.text.includes('Lyngdoh'), false, 'the booker list');
      // A family-member booking without a holder name: the family member's name; the holder masked.
      const b = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { phone: '9600000932',
        patient: { relation: 'Mother', name: 'Mother Sangma', gender: 'Female' } }));
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${b.json.data.booking._id}/cancel`, 200, {});
      assert.equal((await expect('P', 'GET', `/pharmacy-bookings/${b.json.data.booking._id}`, 200)).json.data.patientName, 'Mother Sangma');
      const list = await expect('P', 'GET', '/pharmacy-customers?limit=100', 200);
      const rowOf = (u: string) => list.json.data.find((r: any) => String(r.userId._id) === u);
      assert.equal(rowOf(Z1).userId.name, 'Zara Typed'); assert.equal(rowOf(Z1).consent, 'patient_agreed');
      assert.equal(rowOf(Z2).userId.name, 'Kiran S.', 'no typed holder name: masked');
      assert.equal(list.text.includes('Lyngdoh'), false); assert.equal(list.text.includes('Kiran Real'), false);
      assert.equal((await expect('P', 'GET', '/pharmacy-customers?search=Lyngdoh', 200)).json.data.length, 0, 'not searchable by the account name');
      assert.equal((await expect('P', 'GET', '/pharmacy-customers?search=Sangma', 200)).json.data.length, 0);
      assert.equal((await expect('P', 'GET', '/pharmacy-customers?search=Zara%20Typed', 200)).json.data.length, 1, 'searchable by the typed name');
      // The customer ordered from this pharmacy themselves: the account name, searchable; the pharmacy's later tick
      // (a booking, the customer form) keeps that consent.
      await PharmacyCustomerModel.create({ pharmacyId: P, userId: Z3, consent: 'customer_order', createdByRole: 'user', createdById: Z3 } as never);
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { phone: '9600000933', patient: { relation: 'self', name: 'Typed Z3' } }));
      await expect('P', 'POST', '/pharmacy-customers', 201, { phone: '9600000933', name: 'Typed Z3 Again', consent: true });
      const z3 = await PharmacyCustomerModel.findOne({ pharmacyId: P, userId: Z3 }).lean() as any;
      assert.equal(z3.consent, 'customer_order', 'the customer\'s own consent is kept');
      const l3 = await expect('P', 'GET', '/pharmacy-customers?search=Ordered', 200);
      assert.equal(l3.json.data.length, 1); assert.equal(l3.json.data[0].userId.name, 'Customer Ordered Name');
    });

    await check('14 /payments/verify and /reconcile: 403 for a non-operational pharmacy on a booking payment; its own top-up is still credited', async () => {
      const V = await pharmacyWithToken('Verify Pharmacy', '9700000406');
      const signedTopup = async (amount: number) => {
        const orderId = 'order_v_' + oid();
        const payId = 'pay_v' + oid().slice(-12);
        const rec = await PaymentRecordModel.create({ userId: V, payerUserId: V, payerPharmacyId: V, context: 'wallet_recharge', contextId: `pharmacy_${V}_${oid()}`,
          baseAmount: amount, discountAmount: 0, finalAmount: amount, baseAmountPaise: amount * 100, finalAmountPaise: amount * 100, currency: 'INR',
          paymentGateway: 'razorpay', razorpayOrderId: orderId, status: 'created', notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: V } } as never);
        gateway.payments[orderId] = [{ id: payId, order_id: orderId, amount: amount * 100, currency: 'INR', status: 'captured', fee: 100 }];
        return { recordId: String((rec as any)._id), body: { paymentTransactionId: String((rec as any)._id), razorpayOrderId: orderId, razorpayPaymentId: payId,
          razorpaySignature: crypto.createHmac('sha256', 'secret').update(`${orderId}|${payId}`).digest('hex') } };
      };
      const setV = (set: Record<string, unknown>) => PharmacyModel.collection.updateOne({ _id: new Types.ObjectId(V) }, { $set: set });
      const restoreV = () => PharmacyModel.collection.updateOne({ _id: new Types.ObjectId(V) }, { $set: { isActive: true, isVerified: true }, $unset: { archivedAt: '' } });
      // A booking this pharmacy made, paid by card: its verify/reconcile answer is the booker view.
      const bookingId = new Types.ObjectId();
      const bp = istParts(new Date(Date.now() + 9 * DAY));
      await BookingModel.collection.insertOne({ _id: bookingId, bookingType: 'consultation', userId: X, pharmacyId: V, specialistId: D, doctorName: 'Dr Asha Menon',
        bookingDate: bp.date, bookingTime: bp.time, status: 'confirmed', paymentStatus: 'paid', price: 500, createdAt: new Date(), updatedAt: new Date() } as never);
      const bookingRec = await PaymentRecordModel.create({ userId: X, context: 'booking', contextId: String(bookingId), baseAmount: 500, discountAmount: 0,
        finalAmount: 500, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'order_vb_' + oid(), razorpayPaymentId: 'pay_vb' + oid().slice(-10),
        status: 'paid', isProcessed: true, paidAt: new Date() } as never);
      const bookingBody = { paymentTransactionId: String((bookingRec as any)._id), razorpayOrderId: (bookingRec as any).razorpayOrderId,
        razorpayPaymentId: (bookingRec as any).razorpayPaymentId, razorpaySignature: 'unused-for-a-paid-record' };
      const ok = await expect(V as Who, 'POST', '/payments/verify', 200, bookingBody);
      assert.ok('patientName' in ok.json.data.entity, 'an operational pharmacy gets the booker view');
      const t1 = await signedTopup(250); const t2 = await signedTopup(100); const t3 = await signedTopup(50);
      for (const [set, code, topup, how] of [[{ isActive: false }, 'PHARMACY_INACTIVE', t1, 'verify'], [{ isVerified: false }, 'PHARMACY_NOT_VERIFIED', t2, 'reconcile'],
        [{ archivedAt: new Date() }, 'PHARMACY_INACTIVE', t3, 'check']] as const) {
        await setV(set);
        try {
          // No booker view for a pharmacy that is not operational.
          await expect(V as Who, 'POST', '/payments/verify', 403, bookingBody, code);
          await expect(V as Who, 'POST', '/payments/reconcile', 403, { paymentTransactionId: bookingBody.paymentTransactionId }, code);
          // Its own top-up still settles and is credited (its own money)...
          if (how === 'verify') await expect(V as Who, 'POST', '/payments/verify', 200, topup.body);
          else if (how === 'reconcile') await expect(V as Who, 'POST', '/payments/reconcile', 200, { paymentTransactionId: topup.recordId });
          else await expect(V as Who, 'POST', `/pharmacy-wallet/topups/${topup.recordId}/check`, 200);
          assert.equal((await PaymentRecordModel.findById(topup.recordId).lean() as any).status, 'paid', `${how} settled it`);
          // ...but the wallet funds nothing while the pharmacy is not operational.
          await expect(V as Who, 'POST', '/pharmacy-assisted/consultations', 403, consult(await futureSlot(), { phone: '9600000961', patient: { relation: 'self', name: 'Not Now' } }), code);
        } finally { await restoreV(); }
      }
      assert.equal((await balanceOf(V)).paise, 40000, 'all three top-ups credited once');
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: V, referenceType: 'wallet_recharge' }), 3);
      // A customer is not affected by the gate.
      await expect('X', 'POST', '/payments/verify', 404, { ...t1.body, paymentTransactionId: oid() }, 'PAYMENT_RECORD_NOT_FOUND');
    });

    await check('15 a replayed create answers its receipt at the lookup limit; every other attempt is still counted, audited and uniform', async () => {
      const RL = await pharmacyWithToken('Limit Pharmacy', '9700000407');
      await adminTopup(RL, 2000);
      process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '1';
      try {
        const body = consult(await futureSlot(), { phone: '9600000951', patient: { relation: 'self', name: 'Replay Person' } });
        const first = await expect(RL as Who, 'POST', '/pharmacy-assisted/consultations', 201, body);
        const again = await expect(RL as Who, 'POST', '/pharmacy-assisted/consultations', 200, body);
        assert.equal(again.json.data.replayed, true); assert.equal(again.json.data.booking._id, first.json.data.booking._id);
        assert.equal(await assistedModels.AssistedAuditEventModel.countDocuments({ action: 'booking.attempted', orgId: RL }), 1, 'the replay is not an attempt');
        // The one counted attempt used the hour: any other attempt is refused alike for a known and an unknown number.
        const known = await expect(RL as Who, 'POST', '/pharmacy-assisted/consultations', 429, consult(await futureSlot(), { phone: '9600000201' }), 'ASSISTED_LIMIT_REACHED');
        const unknown = await expect(RL as Who, 'POST', '/pharmacy-assisted/consultations', 429, consult(await futureSlot(), { phone: '9600000952', patient: { relation: 'self', name: 'Nobody Two' } }), 'ASSISTED_LIMIT_REACHED');
        assert.deepEqual([known.json.code, known.json.limit, known.json.message], [unknown.json.code, unknown.json.limit, unknown.json.message]);
        // The same key with other content is not a replay: counted (so refused here).
        await expect(RL as Who, 'POST', '/pharmacy-assisted/consultations', 429, { ...body, primaryConcern: 'other' }, 'ASSISTED_LIMIT_REACHED');
      } finally { process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '100000'; }
      // Under the limit, a key reused for other content is refused as before (and audited as an attempt).
      const body2 = consult(await futureSlot(), { phone: '9600000953', patient: { relation: 'self', name: 'Reuse Person' } });
      await expect(RL as Who, 'POST', '/pharmacy-assisted/consultations', 201, body2);
      const before = await assistedModels.AssistedAuditEventModel.countDocuments({ action: 'booking.attempted', orgId: RL });
      await expect(RL as Who, 'POST', '/pharmacy-assisted/consultations', 409, { ...body2, primaryConcern: 'changed' }, 'IDEMPOTENCY_KEY_REUSED');
      assert.equal(await assistedModels.AssistedAuditEventModel.countDocuments({ action: 'booking.attempted', orgId: RL }), before + 1);
    });

    // ── Review of db252c1 ──
    await check('16 a lost dispute on a top-up never credited blocks it: verify, reconcile, check and sweep refuse it; the race gives one of two outcomes', async () => {
      const B = await pharmacyWithToken('Blocked Pharmacy', '9700000501');
      const topupRecord = async (amount: number, status: 'created' | 'paid') => {
        const orderId = 'order_blk_' + oid();
        const payId = 'pay_blk' + oid().slice(-12);
        const rec = await PaymentRecordModel.create({ userId: B, payerUserId: B, payerPharmacyId: B, context: 'wallet_recharge', contextId: `pharmacy_${B}_${oid()}`,
          baseAmount: amount, discountAmount: 0, finalAmount: amount, baseAmountPaise: amount * 100, finalAmountPaise: amount * 100, currency: 'INR',
          paymentGateway: 'razorpay', razorpayOrderId: orderId, status, ...(status === 'paid' ? { razorpayPaymentId: payId, paidAt: new Date() } : {}),
          notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: B } } as never);
        gateway.payments[orderId] = [{ id: payId, order_id: orderId, amount: amount * 100, currency: 'INR', status: 'captured', fee: 100 }];
        return { recordId: String((rec as any)._id), payId, body: { paymentTransactionId: String((rec as any)._id), razorpayOrderId: orderId, razorpayPaymentId: payId,
          razorpaySignature: crypto.createHmac('sha256', 'secret').update(`${orderId}|${payId}`).digest('hex') } };
      };
      const credits = (recordId: string) => PharmacyWalletTransactionModel.countDocuments({ referenceType: 'wallet_recharge', referenceId: recordId });
      // Paid but not credited yet (the browser never came back), then captured-not-verified.
      for (const status of ['paid', 'created'] as const) {
        const t = await topupRecord(400, status);
        const r = await expect('ADMIN', 'POST', `/admin/wallet-payments/${status === 'paid' ? t.payId : t.recordId}/chargeback`, 200, { reason: 'dispute lost early' });
        assert.deepEqual([r.json.data.blockedUncredited, r.json.data.credited, r.json.data.replayed], [true, false, false]);
        assert.match(r.json.data.message, /Nothing was credited/);
        const rec = await PaymentRecordModel.findById(t.recordId).lean() as any;
        assert.equal(rec.status, 'failed'); assert.ok(rec.chargebackAt);
        assert.equal((await expect('ADMIN', 'POST', `/admin/wallet-payments/${t.recordId}/chargeback`, 200, { reason: 'again' })).json.data.replayed, true);
        await expect(B as Who, 'POST', '/payments/verify', 409, t.body, 'TOPUP_BLOCKED');
        await expect(B as Who, 'POST', '/payments/reconcile', 409, { paymentTransactionId: t.recordId }, 'TOPUP_BLOCKED');
        await expect(B as Who, 'POST', `/pharmacy-wallet/topups/${t.recordId}/check`, 409, undefined, 'TOPUP_BLOCKED');
        process.env.WALLET_RECHARGE_SWEEP_FROM = new Date(Date.now() - DAY).toISOString();
        try {
          await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(t.recordId) }, { $set: { createdAt: new Date(Date.now() - 3600_000) } });
          await payments.sweepUnsettledBookingPayments(new Date(), 500);
        } finally { delete process.env.WALLET_RECHARGE_SWEEP_FROM; }
        assert.equal(await credits(t.recordId), 0, `${status}: never credited`);
        assert.equal((await PaymentRecordModel.findById(t.recordId).lean() as any).status, 'failed');
        const unc = (await expect('ADMIN', 'GET', '/admin/wallet-recharges/uncredited', 200)).json.data.map((x: any) => x.paymentTransactionId);
        assert.equal(unc.includes(t.recordId), false, 'not listed as owed to the pharmacy');
      }
      assert.equal((await balanceOf(B)).paise, 0);
      const audits = await assistedModels.AssistedAuditEventModel.find({ action: 'wallet.chargeback', orgId: B }).lean() as any[];
      assert.equal(audits.length, 2); assert.ok(audits.every((a) => a.detail.blockedUncredited === true));
      // The race: the block and a credit (top-up check or verify) at once, many times. Either credited then charged
      // back, or blocked and never credited.
      const seen = { creditedThenChargedBack: 0, blocked: 0 };
      for (let i = 0; i < 8; i++) {
        const P2 = await pharmacyWithToken(`Race Pharmacy ${i}`, `97000006${String(i).padStart(2, '0')}`);
        const orderId = 'order_rc_' + oid(); const payId = 'pay_rc' + oid().slice(-12);
        const rec = await PaymentRecordModel.create({ userId: P2, payerUserId: P2, payerPharmacyId: P2, context: 'wallet_recharge', contextId: `pharmacy_${P2}_${oid()}`,
          baseAmount: 300, discountAmount: 0, finalAmount: 300, baseAmountPaise: 30000, finalAmountPaise: 30000, currency: 'INR', paymentGateway: 'razorpay',
          razorpayOrderId: orderId, status: 'created', notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: P2 } } as never);
        gateway.payments[orderId] = [{ id: payId, order_id: orderId, amount: 30000, currency: 'INR', status: 'captured', fee: 100 }];
        const id = String((rec as any)._id);
        const creditCall = i % 2 === 0 ? call(P2 as Who, 'POST', `/pharmacy-wallet/topups/${id}/check`)
          : call(P2 as Who, 'POST', '/payments/verify', { paymentTransactionId: id, razorpayOrderId: orderId, razorpayPaymentId: payId,
            razorpaySignature: crypto.createHmac('sha256', 'secret').update(`${orderId}|${payId}`).digest('hex') });
        const [cb, cr] = await Promise.all([call('ADMIN', 'POST', `/admin/wallet-payments/${id}/chargeback`, { reason: 'race' }), creditCall]);
        assert.equal(cb.status, 200, cb.text.slice(0, 300));
        const after = await PaymentRecordModel.findById(id).lean() as any;
        const c = await credits(id);
        const k = await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: P2, transactionType: 'chargeback' });
        const w = await PharmacyWalletModel.findOne({ pharmacyId: P2 }).lean() as any;
        if (cb.json.data.blockedUncredited) {
          seen.blocked += 1;
          assert.deepEqual([c, k, after.status, !!after.chargebackAt], [0, 0, 'failed', true], `blocked: ${cr.status} ${cr.text.slice(0, 200)}`);
          assert.notEqual(cr.status, 200, 'the credit was refused');
          assert.equal(Number(w?.balancePaise ?? 0), 0);
        } else {
          seen.creditedThenChargedBack += 1;
          assert.deepEqual([c, k, !!after.chargebackAt], [1, 1, false], 'credited once, charged back once');
          assert.deepEqual([w.balancePaise, w.frozen], [0, true]);
        }
        const rows = await PharmacyWalletTransactionModel.find({ pharmacyId: P2 }).lean() as any[];
        assert.equal(rows.reduce((a, r) => a + Number(r.signedAmountPaise ?? 0), 0), Number(w?.balancePaise ?? 0), 'balance = Σ entries');
      }
      console.log('   race outcomes', JSON.stringify(seen));
    });

    await check('17 a lot recorded at the chargeback gives up non-lot money first: withdrawable stays the honest card money (300, 300, 800)', async () => {
      const H2 = await pharmacyWithToken('Honest Pharmacy', '9700000502');
      const noLot = await lotlessRecharge(H2, 500);
      await rechargeOf(H2, 800);
      assert.deepEqual(await balanceOf(H2), { paise: 130000, withdrawable: 80000 });
      const bk = await expect(H2 as Who, 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { phone: '9600000971', patient: { relation: 'self', name: 'Honest One' } }));
      assert.deepEqual(await balanceOf(H2), { paise: 80000, withdrawable: 30000 }, 'the booking spent lot money first (300 left)');
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${noLot.payId}/chargeback`, 200, { reason: 'dispute lost' });
      assert.deepEqual(await balanceOf(H2), { paise: 30000, withdrawable: 30000 }, 'the ₹500 came out of the non-lot money: still 300');
      await expect(H2 as Who, 'POST', `/pharmacy-assisted/bookings/${bk.json.data.booking._id}/cancel`, 200, {});
      assert.deepEqual(await balanceOf(H2), { paise: 80000, withdrawable: 80000 }, 'the refund restores the lot: 800');
      assert.equal(await sumOf(H2), 80000);
    });

    await check('18 names: the migration marks pre-S3 customer-made links customer_order (once, counted); a customer\'s own order upgrades a pharmacy\'s link', async () => {
      const C1 = oid(); const C2 = oid(); const C3 = oid();
      await UserModel.collection.insertMany([
        { _id: new Types.ObjectId(C1), userType: 'user', phone: '9600000981', name: 'Old Order Customer', createdSource: 'self_signup' },
        { _id: new Types.ObjectId(C2), userType: 'user', phone: '9600000982', name: 'Old Pharmacy Link', createdSource: 'self_signup' },
        { _id: new Types.ObjectId(C3), userType: 'user', phone: '9600000983', name: 'Later Orderer Name', createdSource: 'self_signup' },
      ] as never);
      const own = await PharmacyCustomerModel.collection.insertOne({ pharmacyId: new Types.ObjectId(P), userId: new Types.ObjectId(C1), createdByRole: 'user', createdById: C1 } as never);
      const theirs = await PharmacyCustomerModel.collection.insertOne({ pharmacyId: new Types.ObjectId(P), userId: new Types.ObjectId(C2), createdByRole: 'pharmacy', createdById: P } as never);
      const dry = await migration.migrateAssistedPharmacyWallets({ commit: false });
      assert.equal(dry.customerOrderConsentsFilled, 1);
      assert.equal((await PharmacyCustomerModel.collection.findOne({ _id: own.insertedId }) as any).consent, undefined, 'a dry run writes nothing');
      const run = await migration.migrateAssistedPharmacyWallets({ commit: true });
      assert.equal(run.customerOrderConsentsFilled, 1);
      assert.equal((await PharmacyCustomerModel.collection.findOne({ _id: own.insertedId }) as any).consent, 'customer_order');
      assert.equal((await PharmacyCustomerModel.collection.findOne({ _id: theirs.insertedId }) as any).consent, undefined, 'a pharmacy-made link is not the customer\'s consent');
      assert.equal((await migration.migrateAssistedPharmacyWallets({ commit: true })).customerOrderConsentsFilled, 0, 'a rerun changes nothing');
      // A pharmacy's "patient agreed" link, then the customer's own order there: customer_order (the account name shows).
      await expect('P', 'POST', '/pharmacy-customers', 201, { phone: '9600000983', name: 'Typed C3', consent: true });
      const customers = Container.get(PharmacyCustomerService);
      await customers.ensureLinked(P, C3, P, 'pharmacy');
      assert.equal((await PharmacyCustomerModel.findOne({ pharmacyId: P, userId: C3 }).lean() as any).consent, 'patient_agreed', 'the pharmacy\'s own order upgrades nothing');
      await customers.ensureLinked(P, C3, C3, 'user');
      assert.equal((await PharmacyCustomerModel.findOne({ pharmacyId: P, userId: C3 }).lean() as any).consent, 'customer_order');
      const l = await expect('P', 'GET', '/pharmacy-customers?search=Later%20Orderer', 200);
      assert.equal(l.json.data.length, 1); assert.equal(l.json.data[0].userId.name, 'Later Orderer Name');
    });

    // ── Review of b378f61 ──
    await check('19 a never-verified top-up is blocked by its order id, or by a payment id the gateway resolves; clear answers otherwise', async () => {
      const N = await pharmacyWithToken('Never Verified Pharmacy', '9700000701');
      const unverified = async (amount: number) => {
        const orderId = 'order_' + oid().slice(-14); const payId = 'pay_' + oid().slice(-14);
        const rec = await PaymentRecordModel.create({ userId: N, payerUserId: N, payerPharmacyId: N, context: 'wallet_recharge', contextId: `pharmacy_${N}_${oid()}`,
          baseAmount: amount, discountAmount: 0, finalAmount: amount, baseAmountPaise: amount * 100, finalAmountPaise: amount * 100, currency: 'INR',
          paymentGateway: 'razorpay', razorpayOrderId: orderId, status: 'created', notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: N } } as never);
        gateway.payments[orderId] = [{ id: payId, order_id: orderId, amount: amount * 100, currency: 'INR', status: 'captured', fee: 100 }];
        return { recordId: String((rec as any)._id), orderId, payId };
      };
      const byOrder = await unverified(200);
      const r1 = await expect('ADMIN', 'POST', `/admin/wallet-payments/${byOrder.orderId}/chargeback`, 200, { reason: 'dispute on an unverified top-up' });
      assert.deepEqual([r1.json.data.blockedUncredited, r1.json.data.paymentRecordId], [true, byOrder.recordId]);
      assert.ok((await PaymentRecordModel.findById(byOrder.recordId).lean() as any).chargebackAt);
      const byPay = await unverified(300);
      assert.equal((await PaymentRecordModel.findById(byPay.recordId).lean() as any).razorpayPaymentId, undefined, 'the payment id was never stored');
      const r2 = await expect('ADMIN', 'POST', `/admin/wallet-payments/${byPay.payId}/chargeback`, 200, { reason: 'dispute by payment id' });
      assert.deepEqual([r2.json.data.blockedUncredited, r2.json.data.paymentRecordId], [true, byPay.recordId], 'resolved through the gateway');
      await expect(N as Who, 'POST', `/pharmacy-wallet/topups/${byPay.recordId}/check`, 409, undefined, 'TOPUP_BLOCKED');
      assert.equal((await balanceOf(N)).paise, 0);
      // A payment id nobody knows; and one the gateway cannot be asked about (keys not configured).
      const unknown = await expect('ADMIN', 'POST', `/admin/wallet-payments/pay_${oid().slice(-14)}/chargeback`, 404, { reason: 'x' }, 'TOPUP_NOT_FOUND_BY_PAYMENT_ID');
      assert.equal(unknown.json.message, 'Not found by payment id; try the order id or the record id');
      const later = await unverified(100);
      const original = (payments as any).getRazorpayClient;
      (payments as any).getRazorpayClient = () => { throw new Error('Razorpay credentials are not configured'); };
      try {
        const off = await expect('ADMIN', 'POST', `/admin/wallet-payments/${later.payId}/chargeback`, 404, { reason: 'x' }, 'TOPUP_NOT_FOUND_BY_PAYMENT_ID');
        assert.match(off.json.message, /try the order id or the record id/);
      } finally { (payments as any).getRazorpayClient = original; }
      assert.equal((await PaymentRecordModel.findById(later.recordId).lean() as any).chargebackAt, undefined, 'nothing was blocked');
      await expect('ADMIN', 'POST', `/admin/wallet-payments/order_${oid().slice(-14)}/chargeback`, 404, { reason: 'x' }, 'TOPUP_NOT_FOUND');
      // Two top-ups carrying one stored payment id: still ambiguous.
      const shared = 'pay_' + oid().slice(-14);
      for (let i = 0; i < 2; i++) {
        await PaymentRecordModel.create({ userId: N, payerUserId: N, payerPharmacyId: N, context: 'wallet_recharge', contextId: `pharmacy_${N}_${oid()}`, baseAmount: 5,
          discountAmount: 0, finalAmount: 5, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'order_' + oid().slice(-14), razorpayPaymentId: shared,
          status: 'paid', notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: N } } as never);
      }
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${shared}/chargeback`, 409, { reason: 'x' }, 'PAYMENT_AMBIGUOUS');
    });

    await check('20 names migration: only links the customer made themselves (createdById = the customer), missing or not_recorded consent', async () => {
      const users = [oid(), oid(), oid(), oid()];
      await UserModel.collection.insertMany(users.map((u, i) => ({ _id: new Types.ObjectId(u), userType: 'user', phone: `960000099${i}`, name: `Mig User ${i}`,
        createdSource: 'self_signup' })) as never);
      const ins = async (doc: Record<string, unknown>) => (await PharmacyCustomerModel.collection.insertOne({ pharmacyId: new Types.ObjectId(Q), ...doc } as never)).insertedId;
      const notRecorded = await ins({ userId: new Types.ObjectId(users[0]), createdByRole: 'user', createdById: new Types.ObjectId(users[0]), consent: 'not_recorded' });
      const otherCreator = await ins({ userId: new Types.ObjectId(users[1]), createdByRole: 'user', createdById: new Types.ObjectId(users[2]) });
      const noCreator = await ins({ userId: new Types.ObjectId(users[2]), createdByRole: 'user' });
      const agreed = await ins({ userId: new Types.ObjectId(users[3]), createdByRole: 'user', createdById: users[3], consent: 'patient_agreed' });
      // Odd legacy values (object, array) never match and never abort the run.
      const [oddU1, oddU2] = [oid(), oid()];
      const oddObject = await ins({ userId: new Types.ObjectId(oddU1), createdByRole: 'user', createdById: { legacy: oddU1 } });
      const oddArray = await ins({ userId: new Types.ObjectId(oddU2), createdByRole: 'user', createdById: [oddU2] });
      const consentOf = async (id: unknown) => (await PharmacyCustomerModel.collection.findOne({ _id: id } as never) as any).consent;
      const dry = await migration.migrateAssistedPharmacyWallets({ commit: false });
      assert.equal(dry.customerOrderConsentsFilled, 1);
      const run = await migration.migrateAssistedPharmacyWallets({ commit: true });
      assert.equal(run.customerOrderConsentsFilled, 1);
      assert.equal(await consentOf(notRecorded), 'customer_order', 'the first S3 commit\'s not_recorded on a customer-made link');
      assert.equal(await consentOf(otherCreator), undefined, 'made by someone else');
      assert.equal(await consentOf(noCreator), undefined, 'no creator recorded');
      assert.equal(await consentOf(agreed), 'patient_agreed', 'a recorded consent is never changed');
      assert.equal(await consentOf(oddObject), undefined, 'an object createdById is left alone');
      assert.equal(await consentOf(oddArray), undefined, 'an array createdById is left alone');
      assert.equal((await migration.migrateAssistedPharmacyWallets({ commit: true })).customerOrderConsentsFilled, 0, 'a rerun changes nothing');
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
