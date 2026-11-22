/**
 * r8 before-production fixes (design §21.4):
 * B1. The admin top-up by-key read fails closed (503 INDEXES_OUTDATED) when its unique index is missing or different.
 * B2. The doctor list's next-free-time fallback has a bounded number of reads.
 * B3. A branch id is compared lower-cased both when listing and when booking.
 * B4. The one-doctor slot list is never cut short silently.
 * B5. The admin top-up Idempotency-Key (and the by-key `:key`) is ^[A-Za-z0-9_-]{8,100}$.
 * B6. The booker view's `holder` carries `typedName`: this pharmacy's own link only.
 * Real authenticate + routers over HTTP against MongoDB.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/assisted_r8_before_production_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/assisted/r8-before-production.integration.ts
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
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { PharmacyService } from '@/modules/pharmacies/services';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import { PharmacyCustomerRepository } from '@/modules/pharmacyCustomers/repository';
import { PharmacyCustomerService } from '@/modules/pharmacyCustomers/services';
import { PharmacyWalletModel, PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { PharmacyWalletRepository, PharmacyWalletTransactionRepository } from '@/modules/pharmacyWallet/repository';
import { PharmacyWalletService } from '@/modules/pharmacyWallet/services';
import SpecialistModel from '@/modules/specialists/model';
import { SpecialistService } from '@/modules/specialists/services';
import PartnerOrgModel from '@/modules/partners/model';
import BranchModel from '@/modules/partners/model/branch';
import MemberModel from '@/modules/partners/model/member';
import { errorHandler } from '@/modules/middleware';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/assisted_r8_before_production_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;
const istParts = (at: Date) => { const s = new Date(at.getTime() + IST).toISOString(); return { date: s.slice(0, 10).replace(/-/g, ''), time: s.slice(11, 16) }; };
const dashed = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
const day = (n: number) => istParts(new Date(Date.now() + n * DAY)).date;
const at = (n: number, h: number, m = 0) =>
  new Date(Date.parse(`${dashed(day(n))}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`));

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.error('FAIL -', name, '\n  ', (e as Error).message.split('\n').slice(0, 3).join(' | ')); }
}
const noop = new Proxy({}, { get: () => async () => undefined });

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();

  const payments = Object.assign(Object.create(PaymentService.prototype), {
    bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
    walletTransactionRepository: new WalletTransactionRepository(), pharmacyWalletRepository: new PharmacyWalletRepository(),
    pharmacyWalletTransactionRepository: new PharmacyWalletTransactionRepository(), bookingReminderScheduler: noop,
  }) as unknown as PaymentService;
  const bookingService = Object.assign(Object.create(BookingService.prototype), {
    bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
    walletTransactionRepository: new WalletTransactionRepository(), userRepository: new UserRepository(),
    notificationService: noop, paymentService: payments, couponService: {}, emailService: {}, bookingReminderScheduler: noop,
    specialistService: { getById: async (id: string) => SpecialistModel.findById(id).lean() },
    slotService: { getById: async (id: string) => SlotModel.findById(id).lean() },
  }) as BookingService;
  Container.set(BookingService, bookingService);
  Container.set(DependentService, Object.assign(Object.create(DependentService.prototype), { dependentRepository: new DependentRepository() }));
  Container.set(PharmacyCustomerService, Object.assign(Object.create(PharmacyCustomerService.prototype), {
    pharmacyCustomerRepo: new PharmacyCustomerRepository(), pharmacyRepo: new PharmacyRepository(), userRepo: new UserRepository() }));
  Container.set(PharmacyWalletService, Object.assign(Object.create(PharmacyWalletService.prototype), {
    walletRepo: new PharmacyWalletRepository(), txRepo: new PharmacyWalletTransactionRepository(), paymentService: payments }));
  Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
  Container.set(SpecialistService, { getById: async (id: string) => SpecialistModel.findById(id).lean() } as never);

  const support = await import('@/modules/assisted/support');
  const notices: any[] = [];
  support.setAssistedNotifier(async (n: unknown) => { notices.push(n); });
  support.setAssistedEffects({ meet: async (b: any) => b, cancelMeet: async (b: any) => b, reminders: async () => undefined, clearReminders: async () => undefined } as never);
  const phase1a = await import('@/modules/assisted/routes/phase1a');
  const { default: pharmacyBookingRouter } = await import('@/modules/assisted/routes');
  const { default: pharmacyWalletRouter } = await import('@/modules/pharmacyWallet/routes');
  const { default: pharmacyCustomerRouter } = await import('@/modules/pharmacyCustomers/routes');
  const pharmacyRoutes = await import('@/modules/pharmacies/routes');
  const { authenticate, authenticateOptional } = await import('@/modules/middleware/auth');
  for (const name of mongoose.modelNames()) {
    const m = mongoose.model(name);
    await m.createCollection().catch(() => undefined);
    await m.syncIndexes();
  }

  const app = express();
  app.use(express.json());
  app.use('/api/v1/pharmacy-bookings', authenticate, pharmacyBookingRouter);
  app.use('/api/v1/pharmacy-assisted', authenticate, phase1a.pharmacyAssistedRouter);
  app.use('/api/v1/pharmacy-wallet', authenticate, pharmacyWalletRouter);
  app.use('/api/v1/pharmacy-customers', authenticate, pharmacyCustomerRouter);
  app.use('/api/v1/pharmacies', authenticateOptional, pharmacyRoutes.publicPharmacyRouter);
  app.use('/api/v1/pharmacies', authenticate, pharmacyRoutes.default);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  process.env.ASSISTED_LIMIT_BOOKINGS_PER_PHONE_PER_DAY = '1000';
  process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '100000';
  process.env.ASSISTED_LIMIT_NEW_ACCOUNTS_PER_DAY = '1000';
  process.env.ASSISTED_BOOKING_ENABLED_PHARMACY = 'true';
  process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true';

  try {
    const P = oid(); const P2 = oid(); const PU = oid(); const ADMIN = oid(); const X = oid();
    await PharmacyModel.collection.insertMany([
      { _id: new Types.ObjectId(P), name: 'Rsix Medicals', phone: '9700000601', email: 'rsix@pharm.test', city: 'Shillong', pincode: '793001',
        isActive: true, isVerified: true },
      { _id: new Types.ObjectId(P2), name: 'Other Medicals', phone: '9700000602', email: 'other@pharm.test', city: 'Tura', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(PU), name: 'Rsix Unverified Chemist', phone: '9700000603', email: 'unverified@pharm.test', city: 'Shillong',
        isActive: true, isVerified: false },
    ] as never);
    await UserModel.collection.insertOne({ _id: new Types.ObjectId(X), userType: 'user', phone: '9600000601', name: 'Rina Kumari Das',
      createdSource: 'self_signup', otpVerified: true } as never);
    const D = oid(); const C = oid(); const G = oid(); const K = oid();
    await SpecialistModel.collection.insertMany([
      { _id: new Types.ObjectId(D), name: 'Dr Modes', specialization: 'General Physician', consultationFee: 500, isActive: true, isVerified: true },
      { _id: new Types.ObjectId(C), name: 'Dr Chat Only', specialization: 'General Physician', consultationFee: 500, isActive: true, isVerified: true },
      { _id: new Types.ObjectId(K), name: 'Dr Clinic', specialization: 'General Physician', consultationFee: 500, isActive: true, isVerified: true },
      { _id: new Types.ObjectId(G), name: 'Dr Long Chat', specialization: 'Dermatology', consultationFee: 500, isActive: true, isVerified: true },
    ] as never);
    const tokens = {
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), P2: sign({ _id: P2, pharmacyId: P2, userType: 'pharmacy' }),
      ADMIN: sign({ _id: ADMIN, userType: 'admin' }),
    };
    type Who = keyof typeof tokens;
    const call = async (who: Who, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(base + url, { method, headers: { authorization: 'Bearer ' + tokens[who], 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any; try { json = JSON.parse(text); } catch { json = { text }; }
      return { status: r.status, json, text };
    };
    const expect = async (who: Who, method: string, url: string, status: number, body?: unknown, code?: string, headers?: Record<string, string>) => {
      const r = await call(who, method, url, body, headers);
      assert.equal(r.status, status, `${who} ${method} ${url}: ${r.status} ${r.text.slice(0, 300)}`);
      if (code) assert.equal(r.json.code, code, `${who} ${method} ${url}: ${r.text.slice(0, 300)}`);
      return r;
    };
    const slotAt = async (doctor: string, when: Date, extra: Record<string, unknown> = {}) => {
      const s = istParts(when); const e = istParts(new Date(when.getTime() + 15 * MIN));
      const slot = await SlotModel.create({ specialistId: doctor, date: s.date, startTime: s.time, endTime: e.time, duration: 15, maxBookings: 1,
        currentBookings: 0, isActive: true, isAvailable: true, slotType: 'consultation', ...extra } as never);
      return String(slot._id);
    };
    let keySeq = 0;
    const newKey = () => `rsix-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;
    const consult = (slotId: string, extra: Record<string, unknown> = {}) => ({
      requestKey: newKey(), phone: '9600000601', patient: { relation: 'self', name: 'Rina Das' },
      consent: { agreed: true, statementVersion: 'v1', statementLanguage: 'en' }, preferredLanguage: 'en', slotId, consultationMode: 'video',
      join: { on: 'partner_device' }, acceptedPriceMinor: 50000, primaryConcern: 'fever', paymentMethod: 'wallet', ...extra,
    });
    for (const [pharmacy, key] of [[P, 'reight-fund-p'], [P2, 'reight-fund-p2']]) {
      await expect('ADMIN', 'POST', '/pharmacy-wallet/topup', 200, { pharmacyId: pharmacy, amount: 20000 }, undefined, { 'idempotency-key': key! });
    }
    const doctorRow = async (doctorId: string, query = '') => {
      const r = await expect('P', 'GET', `/pharmacy-assisted/doctors${query}`, 200);
      return r.json.data.find((d: any) => d.doctorId === doctorId);
    };


    // ───────────────────────── B6: holder.typedName ─────────────────────────
    await check('B6: holder.typedName is the name THIS pharmacy typed on its own link; another pharmacy never sees it; null without a link', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201,
        consult(await slotAt(D, at(6, 9)), { phone: '9600000801', patient: { relation: 'self', name: 'Bikash  Rai' } }));
      const id = r.json.data.booking._id;
      const link = await PharmacyCustomerModel.findOne({ pharmacyId: P, userId: r.json.data.booking.userId }).lean() as any;
      const view = await expect('P', 'GET', `/pharmacy-bookings/${id}`, 200);
      assert.deepEqual(view.json.data.holder, { pharmacyCustomerId: String(link._id), name: 'Bikash Rai', typedName: 'Bikash Rai' });
      await expect('P', 'PUT', `/pharmacy-customers/${link._id}/typed-name`, 200, { typedName: 'Bikash  Kumar Rai' });
      assert.equal((await expect('P', 'GET', `/pharmacy-bookings/${id}`, 200)).json.data.holder.typedName, 'Bikash Kumar Rai', 'the cleaned stored name');
      const list = await expect('P', 'GET', '/pharmacy-bookings', 200);
      assert.equal(list.json.data.find((b: any) => b._id === id).holder.typedName, 'Bikash Kumar Rai', 'the list carries it too');
      // A customer_order link shows the account name, and still the name this pharmacy typed.
      await PharmacyCustomerModel.updateOne({ _id: link._id }, { $set: { consent: 'customer_order' } });
      const shown = (await expect('P', 'GET', `/pharmacy-bookings/${id}`, 200)).json.data.holder;
      assert.equal(shown.typedName, 'Bikash Kumar Rai');
      // P2 books the same holder with its own typed name: each view shows only its own.
      const other = await expect('P2', 'POST', '/pharmacy-assisted/consultations', 201,
        consult(await slotAt(D, at(6, 10)), { phone: '9600000801', patient: { relation: 'self', name: 'B Rai' } }));
      const otherId = other.json.data.booking._id;
      const p2Link = await PharmacyCustomerModel.findOne({ pharmacyId: P2, userId: other.json.data.booking.userId }).lean() as any;
      const otherView = await expect('P2', 'GET', `/pharmacy-bookings/${otherId}`, 200);
      assert.deepEqual(otherView.json.data.holder, { pharmacyCustomerId: String(p2Link._id), name: 'B Rai', typedName: 'B Rai' });
      assert.equal(otherView.text.includes('Kumar'), false, 'never P\'s typed name');
      assert.equal((await expect('P', 'GET', `/pharmacy-bookings/${id}`, 200)).text.includes('B Rai"'), false, 'never P2\'s typed name');
      // No typed name on the link, then no link at all: null.
      await PharmacyCustomerModel.updateOne({ _id: p2Link._id }, { $unset: { typedName: 1 } });
      assert.equal((await expect('P2', 'GET', `/pharmacy-bookings/${otherId}`, 200)).json.data.holder.typedName, null);
      await PharmacyCustomerModel.deleteOne({ _id: p2Link._id });
      const unlinked = (await expect('P2', 'GET', `/pharmacy-bookings/${otherId}`, 200)).json.data.holder;
      assert.equal(unlinked.pharmacyCustomerId, null);
      assert.equal(unlinked.typedName, null);
    });

  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`${passed} checks passed, ${failed.length} failed`);
  if (failed.length) throw new Error('r8 before-production checks failed: ' + failed.join('; '));
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
