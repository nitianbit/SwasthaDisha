/**
 * r8b follow-ups (design §21.4):
 * M1. The next-slot walk reads a doctor's first candidate day alone first; the rest of its window only on a miss.
 * L2. The first-candidate-day aggregation stops at the walk's window end.
 * L3. A `?date=` day too large for the shared read is read at most 8 doctors at a time.
 * Real authenticate + routers over HTTP against MongoDB (M1 and L2 call listDoctors with an evening clock).
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/assisted_r8b_followups_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/assisted/r8b-followups.integration.ts
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

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/assisted_r8b_followups_check?directConnection=true';
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


    // Counts the documents each per-doctor slot read returns, and how many run at once.
    const watchDoctorReads = () => {
      const docs = new Map<string, number[]>(); let active = 0; let peak = 0;
      const original = SlotModel.find.bind(SlotModel);
      (SlotModel as any).find = (...args: unknown[]) => {
        const q = original(...(args as [never]));
        const doctor = (args[0] as any)?.specialistId;
        if (typeof doctor === 'string') {
          const exec = q.exec.bind(q);
          (q as any).exec = async (...a: unknown[]) => {
            active++; peak = Math.max(peak, active);
            try { const out = await exec(...(a as [])); docs.set(doctor, [...(docs.get(doctor) ?? []), (out as unknown[]).length]); return out; } finally { active--; }
          };
        }
        return q;
      };
      return { docs, peak: () => peak, stop: () => { (SlotModel as any).find = original; } };
    };
    const slotRows = (doctor: string, date: string, n: number, step: number, from = 9 * 60) => Array.from({ length: n }, (_, i) => {
      const m = from + i * step; const e = m + step;
      const hhmm = (x: number) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
      return { specialistId: doctor, date, startTime: hhmm(m), endTime: hhmm(e), duration: step, maxBookings: 1, currentBookings: 0, isActive: true,
        isAvailable: true, slotType: 'consultation', serviceModes: ['video'] };
    });
    const doctorsOf = async (spec: string, n: number) => {
      const ids = Array.from({ length: n }, oid);
      await SpecialistModel.collection.insertMany(ids.map((d, i) => ({ _id: new Types.ObjectId(d), name: `Dr ${spec} ${i}`, specialization: spec,
        consultationFee: 400, isActive: true, isVerified: true })) as never);
      return ids;
    };
    const { listDoctors } = await import('@/modules/assisted/pharmacyCommands');

    // ───────────────────────── M1 and L2: the evening doctor list ─────────────────────────
    await check('M1 + L2: at 23:00 IST, 300 doctors x 30 days x 16 slots: each waiting doctor reads one day; a doctor past the window end reads nothing', async () => {
      const spec = 'Evening List';
      const ids = await doctorsOf(spec, 299);
      const [far] = await doctorsOf(spec, 1);
      for (let n = 0; n < 30; n++) await SlotModel.collection.insertMany(ids.flatMap((d) => slotRows(d, day(n), 16, 15)) as never);
      // Its only slots lie past the walk's window end (cut-off day + WALK_CALENDAR_DAYS - 1).
      await SlotModel.collection.insertMany(slotRows(far!, day(45), 4, 15) as never);
      const evening = new Date(Date.parse(`${dashed(day(0))}T23:00:00+05:30`));
      const watch = watchDoctorReads();
      let rows: any[];
      try { rows = await listDoctors({ pharmacyId: P, actorId: P }, { speciality: spec, limit: 100 }, evening); } finally { watch.stop(); }
      // Same answers: today's slots have all started, so every doctor's next slot is tomorrow 09:00.
      assert.equal(rows.length, 100);
      for (const r of rows.filter((x) => x.doctorId !== far)) assert.deepEqual([r.nextSlot?.date, r.nextSlot?.startTime], [day(1), '09:00'], r.doctorId);
      for (const d of ids) assert.deepEqual(watch.docs.get(d), [16], `doctor ${d}: one read of one day (16 slots): ${watch.docs.get(d)}`);
      assert.equal(watch.docs.has(far!), false, 'past the window end: no read');
      assert.ok(watch.peak() <= 8, `at most 8 at once: ${watch.peak()}`);
    });

    // ───────────────────────── L3: a large ?date= day ─────────────────────────
    await check('L3: a ?date= day over the shared read is read at most 8 doctors at a time, every slot kept', async () => {
      const spec = 'Day Many';
      const ids = await doctorsOf(spec, 20);
      await SlotModel.collection.insertMany(ids.flatMap((d) => slotRows(d, day(3), 260, 1, 8 * 60)) as never);
      const watch = watchDoctorReads();
      let rows: any[];
      try { rows = (await expect('P', 'GET', `/pharmacy-assisted/doctors?speciality=${encodeURIComponent(spec)}&date=${dashed(day(3))}`, 200)).json.data; }
      finally { watch.stop(); }
      assert.equal(rows.length, 20);
      for (const r of rows) assert.equal(r.slots.length, 260, r.doctorId);
      assert.ok(watch.peak() <= 8, `at most 8 at once: ${watch.peak()}`);
    });

  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`${passed} checks passed, ${failed.length} failed`);
  if (failed.length) throw new Error('r8b follow-up checks failed: ' + failed.join('; '));
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
