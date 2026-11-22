/**
 * r7 follow-ups on the stage line (design §21.3):
 * 1. Admin by-key read of a top-up: GET /pharmacy-wallet/topups/admin/by-key/:key?pharmacyId= (exact, indexed).
 * 2. SAME_SLOT inside the move's transaction: two concurrent moves to one slot give one move, one 409, one notice.
 * 3. The doctor list reads clinic branches in a batch (not three reads per doctor and branch).
 * 4. nextSlot is each doctor's true earliest bookable slot past the 5000-row shared read.
 * 5. Nits: a branch id in upper case is still a holiday; SAME_SLOT after the status and start checks; a malformed
 *    pharmacyId on the admin top-up is a 400 (already so: a guard).
 * Real authenticate + routers over HTTP against MongoDB.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/assisted_r7_followups_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/assisted/r7-followups.integration.ts
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

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/assisted_r7_followups_check?directConnection=true';
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
    for (const [pharmacy, key] of [[P, 'rsix-fund-p'], [P2, 'rsix-fund-p2']]) {
      await expect('ADMIN', 'POST', '/pharmacy-wallet/topup', 200, { pharmacyId: pharmacy, amount: 20000 }, undefined, { 'idempotency-key': key! });
    }
    const doctorRow = async (doctorId: string, query = '') => {
      const r = await expect('P', 'GET', `/pharmacy-assisted/doctors${query}`, 200);
      return r.json.data.find((d: any) => d.doctorId === doctorId);
    };


    // ───────────────────────── 1: admin top-up by key ─────────────────────────
    await check('r7 1: by-key answers credited with the ledger row and wallet, or not_found; scoped to the pharmacy; admin only', async () => {
      await expect('ADMIN', 'POST', '/pharmacy-wallet/topup', 200, { pharmacyId: P, amount: 250, notes: 'support' }, undefined, { 'idempotency-key': 'rsev-key-1' });
      const r = await expect('ADMIN', 'GET', `/pharmacy-wallet/topups/admin/by-key/rsev-key-1?pharmacyId=${P}`, 200);
      assert.equal(r.json.data.state, 'credited');
      assert.equal(r.json.data.transaction.referenceType, 'topup');
      assert.equal(r.json.data.transaction.referenceId, 'rsev-key-1');
      assert.equal(r.json.data.transaction.amountPaise, 25000);
      assert.equal(r.json.data.transaction.notes, 'support');
      assert.equal(r.json.data.transaction.transactionType, 'credit');
      assert.deepEqual(r.json.data.transaction.actor, { kind: 'admin', id: ADMIN });
      assert.equal(String(r.json.data.wallet.pharmacyId), P);
      assert.equal(r.json.data.wallet.balancePaise, (await PharmacyWalletModel.findOne({ pharmacyId: P }).lean() as any).balancePaise);
      assert.equal(typeof r.json.data.wallet.withdrawableMinor, 'number');
      assert.deepEqual((await expect('ADMIN', 'GET', `/pharmacy-wallet/topups/admin/by-key/${encodeURIComponent(' rsev-key-1 ')}?pharmacyId=${P}`, 200))
        .json.data.state, 'credited', 'trimmed like the header');
      assert.deepEqual((await expect('ADMIN', 'GET', `/pharmacy-wallet/topups/admin/by-key/rsev-key-2?pharmacyId=${P}`, 200)).json.data, { state: 'not_found' });
      assert.deepEqual((await expect('ADMIN', 'GET', `/pharmacy-wallet/topups/admin/by-key/rsev-key-1?pharmacyId=${P2}`, 200)).json.data, { state: 'not_found' },
        'another pharmacy\'s key is not this pharmacy\'s top-up');
      await expect('ADMIN', 'GET', `/pharmacy-wallet/topups/admin/by-key/x?pharmacyId=not-an-id`, 400, undefined, 'VALIDATION_ERROR');
      await expect('ADMIN', 'GET', '/pharmacy-wallet/topups/admin/by-key/x', 400, undefined, 'PHARMACY_ID_REQUIRED');
      await expect('ADMIN', 'GET', `/pharmacy-wallet/topups/admin/by-key/${'k'.repeat(101)}?pharmacyId=${P}`, 400, undefined, 'VALIDATION_ERROR');
      await expect('P', 'GET', `/pharmacy-wallet/topups/admin/by-key/rsev-key-1?pharmacyId=${P}`, 403);
      assert.equal(await PharmacyWalletModel.countDocuments({ pharmacyId: PU }), 0);
      assert.deepEqual((await expect('ADMIN', 'GET', `/pharmacy-wallet/topups/admin/by-key/rsev-key-1?pharmacyId=${PU}`, 200)).json.data, { state: 'not_found' });
      assert.equal(await PharmacyWalletModel.countDocuments({ pharmacyId: PU }), 0, 'no wallet is made');
    });

    await check('r7 1: an older admin top-up row (reference only, no operation key) is found; the lookup uses the unique indexes only', async () => {
      await PharmacyWalletTransactionModel.collection.insertOne({ pharmacyId: new Types.ObjectId(P2), transactionType: 'credit', amount: 5, amountPaise: 500,
        balanceBefore: 0, balanceAfter: 5, status: 'completed', referenceType: 'topup', referenceId: 'rsev-legacy-1', description: 'Admin top-up',
        createdAt: new Date(), updatedAt: new Date() } as never);
      const r = await expect('ADMIN', 'GET', `/pharmacy-wallet/topups/admin/by-key/rsev-legacy-1?pharmacyId=${P2}`, 200);
      assert.equal(r.json.data.state, 'credited');
      assert.equal(r.json.data.transaction.amountPaise, 500);
      const { adminTopupByKeyLookups } = await import('@/modules/pharmacyWallet/services');
      const [byRef, byOp] = await Promise.all(adminTopupByKeyLookups(P, 'rsev-key-1').map(async (q) =>
        JSON.stringify(((await PharmacyWalletTransactionModel.find(q.filter).hint(q.hint).limit(1).explain('queryPlanner')) as any).queryPlanner.winningPlan)));
      for (const plan of [byRef, byOp]) {
        assert.equal(plan.includes('COLLSCAN'), false, 'never a collection scan');
        assert.ok(plan.includes('"isUnique":true'), `a unique index: ${plan.slice(0, 300)}`);
      }
      assert.ok(byRef!.includes('pharmacyId_1_referenceType_1_referenceId_1'));
      assert.ok(byOp!.includes('pharmacyId_1_operationKey_1'));
    });

    // ───────────────────────── 2 and 5: SAME_SLOT inside the transaction ─────────────────────────
    await check('r7 2: two concurrent moves onto one slot with different keys give one move and one 409 SAME_SLOT, one "moved" notice', async () => {
      const made = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await slotAt(D, at(4, 9))));
      const id = made.json.data.booking._id;
      const B = await slotAt(D, at(4, 10));
      // Both requests pass every read before the transaction (they both see the booking on its first slot) before
      // either move starts: the first two reads of slot B wait for each other.
      const original = SlotModel.findById.bind(SlotModel);
      let waiting = 0; let release!: () => void; const both = new Promise<void>((r) => { release = r; });
      (SlotModel as any).findById = (...args: unknown[]) => {
        const q = original(...(args as [string]));
        if (String(args[0]) === B && waiting < 2) {
          waiting++;
          if (waiting === 2) release();
          const exec = q.exec.bind(q);
          (q as any).exec = async (...a: unknown[]) => { await both; return exec(...(a as [])); };
        }
        return q;
      };
      const before = notices.length;
      let answers: { status: number; json: any }[];
      try {
        answers = await Promise.all([1, 2].map(() => call('P', 'POST', `/pharmacy-assisted/bookings/${id}/reschedule`, { slotId: B, requestKey: newKey() })));
      } finally { (SlotModel as any).findById = original; }
      assert.equal(waiting, 2, 'both requests were held before their transactions');
      assert.deepEqual(answers.map((a) => a.status).sort(), [200, 409], JSON.stringify(answers.map((a) => [a.status, a.json.code])));
      assert.equal(answers.find((a) => a.status === 409)!.json.code, 'SAME_SLOT');
      const b = await BookingModel.findById(id).lean() as any;
      assert.equal(String(b.slotId), B);
      assert.equal(b.assisted.reschedules.length, 1, 'one move recorded');
      const moved = notices.slice(before).filter((n) => n.bookingId === id && n.title === 'Consultation moved');
      assert.equal(moved.filter((n) => n.audience === 'customer').length, 1, 'one "moved" notice to the patient');
      assert.equal(moved.length, 2, 'patient and doctor, once');
      assert.equal(Number((await SlotModel.findById(B).lean() as any).currentBookings), 1);
    });

    await check('r7 5: a cancelled booking gets BOOKING_NOT_RESCHEDULABLE and a started one BOOKING_ALREADY_STARTED, also onto its own slot', async () => {
      const c = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await slotAt(D, at(4, 11))));
      const started = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await slotAt(D, at(4, 12))));
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${c.json.data.booking._id}/cancel`, 200, { reason: 'x' });
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${c.json.data.booking._id}/reschedule`, 409,
        { slotId: c.json.data.booking.slotId, requestKey: newKey() }, 'BOOKING_NOT_RESCHEDULABLE');
      const past = istParts(new Date(Date.now() - 5 * MIN));
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(started.json.data.booking._id) }, { $set: { bookingDate: past.date, bookingTime: past.time } });
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${started.json.data.booking._id}/reschedule`, 400,
        { slotId: started.json.data.booking.slotId, requestKey: newKey() }, 'BOOKING_ALREADY_STARTED');
      // Guard: a live booking onto its own slot is still SAME_SLOT.
      const live = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await slotAt(D, at(4, 13))));
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${live.json.data.booking._id}/reschedule`, 409,
        { slotId: live.json.data.booking.slotId, requestKey: newKey() }, 'SAME_SLOT');
    });

    await check('r7 5 (guard: already so, the body schema checks it): a malformed pharmacyId on the admin top-up is 400 VALIDATION_ERROR', async () => {
      for (const pharmacyId of ['not-an-id', 12345, `${P}0`]) {
        await expect('ADMIN', 'POST', '/pharmacy-wallet/topup', 400, { pharmacyId, amount: 10 }, 'VALIDATION_ERROR', { 'idempotency-key': `rsev-bad-${String(pharmacyId).length}` });
      }
    });

    // ───────────────────────── 3 and 5: clinic branches ─────────────────────────
    const CLINIC = new Types.ObjectId();
    const branchIds = Array.from({ length: 4 }, () => new Types.ObjectId());
    const HOLIDAY = branchIds[0]!;
    await PartnerOrgModel.collection.insertOne({ _id: CLINIC, kind: 'clinic', name: 'Rsev Clinic', isActive: true, verification: { state: 'verified' } } as never);
    await BranchModel.collection.insertMany(branchIds.map((b) => ({ _id: b, partnerId: String(CLINIC), name: `Branch ${b}`, isActive: true,
      services: { inClinic: true }, holidays: b === HOLIDAY ? [dashed(day(3))] : [] })) as never);
    const clinicDoctors = [K, oid(), oid()];
    await SpecialistModel.collection.insertMany(clinicDoctors.slice(1).map((d, i) => ({ _id: new Types.ObjectId(d), name: `Dr Clinic ${i}`,
      specialization: 'Clinic Medicine', consultationFee: 300, isActive: true, isVerified: true })) as never);
    await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(K) }, { $set: { specialization: 'Clinic Medicine' } });
    await MemberModel.collection.insertMany(clinicDoctors.map((d, i) => ({ partnerId: String(CLINIC), doctorId: d, phone: `970000071${i}`, role: 'doctor', isActive: true })) as never);
    const slotOf: Record<string, string[]> = {};
    for (const d of clinicDoctors) {
      slotOf[d] = [];
      for (const [i, b] of branchIds.slice(1).entries()) slotOf[d]!.push(await slotAt(d, at(3, 10 + i), { serviceModes: ['in-person'], branchId: String(b) }));
    }

    await check('r7 3: the doctor list reads members, clinics and branches once each, whatever the doctor and branch pairs', async () => {
      const counts: Record<string, number> = {};
      const watched = [MemberModel.collection.name, BranchModel.collection.name, PartnerOrgModel.collection.name];
      mongoose.set('debug', (coll: string) => { if (watched.includes(coll)) counts[coll] = (counts[coll] ?? 0) + 1; });
      let r: any;
      try { r = await expect('P', 'GET', '/pharmacy-assisted/doctors?speciality=Clinic%20Medicine', 200); } finally { mongoose.set('debug', false); }
      for (const d of clinicDoctors) assert.equal(r.json.data.find((x: any) => x.doctorId === d).nextSlot.slotId, slotOf[d]![0]);
      for (const c of watched) assert.ok((counts[c] ?? 0) <= 1, `${c}: ${counts[c]} reads for 9 doctor and branch pairs`);
    });

    await check('r7 5: a slot naming its branch in upper case is still left out on the branch\'s holiday', async () => {
      const upper = await slotAt(K, at(3, 8), { serviceModes: ['in-person'], branchId: String(HOLIDAY).toUpperCase() });
      const k = await doctorRow(K, '?speciality=Clinic%20Medicine');
      assert.notEqual(k.nextSlot.slotId, upper);
      assert.equal(k.nextSlot.slotId, slotOf[K]![0]);
      const r = await expect('P', 'GET', `/pharmacy-assisted/doctors/${K}/slots?days=7`, 200);
      assert.equal(r.json.data.slots.some((s: any) => s.slotId === upper), false);
    });

    // ───────────────────────── 4: past the shared read ─────────────────────────
    await check('r7 4: nextSlot is each doctor\'s earliest bookable slot when more than 5000 earlier bookable slots fill the shared read', async () => {
      const H = oid(); const J = oid(); const L = oid();
      await SpecialistModel.collection.insertMany([H, J, L].map((d, i) => ({ _id: new Types.ObjectId(d), name: `Dr Scale ${i}`, specialization: 'Scale',
        consultationFee: 400, isActive: true, isVerified: true })) as never);
      const d9 = day(9);
      await SlotModel.collection.insertMany(Array.from({ length: 5001 }, (_, i) => ({ specialistId: H, date: d9,
        startTime: `${String(9 + Math.floor((i % 600) / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`, endTime: '23:59', duration: 1,
        maxBookings: 1, currentBookings: 0, isActive: true, isAvailable: true, slotType: 'consultation', serviceModes: ['video'] })) as never);
      const jSlot = await slotAt(J, at(10, 10));
      const lEarly = await slotAt(L, at(9, 8));
      await slotAt(L, at(11, 8));
      const rows = (await expect('P', 'GET', '/pharmacy-assisted/doctors?speciality=Scale', 200)).json.data;
      const of = (id: string) => rows.find((x: any) => x.doctorId === id);
      assert.equal(of(J).nextSlot?.slotId, jSlot, 'past the cap');
      assert.equal(of(L).nextSlot?.slotId, lEarly, 'the earliest on the cut-off day');
      assert.equal(of(H).nextSlot?.date, d9);
      assert.equal(of(H).nextSlot?.startTime, '09:00', 'the earliest time of the large day');
      const dayRows = (await expect('P', 'GET', `/pharmacy-assisted/doctors?speciality=Scale&date=${dashed(d9)}`, 200)).json.data;
      const dayOf = (id: string) => dayRows.find((x: any) => x.doctorId === id);
      assert.deepEqual(dayOf(L).slots.map((s: any) => s.slotId), [lEarly]);
      assert.equal(dayOf(H).slots.length, 5001);
      assert.deepEqual(dayOf(J).slots, []);
      assert.equal(dayOf(J).nextSlot?.slotId, jSlot);
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`${passed} checks passed, ${failed.length} failed`);
  if (failed.length) throw new Error('r7 follow-up checks failed: ' + failed.join('; '));
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
