/**
 * r6 small fixes on the stage line (design §21):
 * 1. The pharmacy's doctor list and slot read offer only slots an assisted booking can take: never a chat-only slot,
 *    `modes` lists only video / call / in-person, `nextSlot` is the next bookable slot (also past a long run of chat-only
 *    slots, and never at a closed clinic branch or one the doctor no longer consults at).
 * 3. The pharmacy reschedule keeps the booking's mode rules, the started fence, the partner's own bookings only; a move
 *    onto the slot already held is refused (SAME_SLOT).
 * 4. The booker view names the account holder with THIS pharmacy's link id (`holder.pharmacyCustomerId`) for the
 *    typed-name edit, which never changes the account name and answers the name now shown (`shownName`).
 * 5. Admin wallet support: the admin pharmacy list, a pharmacy's wallet and transactions, a malformed id is a 400, the
 *    admin top-up answers the wallet view.
 * Real authenticate + routers over HTTP against MongoDB.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/assisted_r6_small_fixes_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/assisted/r6-small-fixes.integration.ts
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
import { PharmacyWalletModel } from '@/modules/pharmacyWallet/model';
import { PharmacyWalletRepository, PharmacyWalletTransactionRepository } from '@/modules/pharmacyWallet/repository';
import { PharmacyWalletService } from '@/modules/pharmacyWallet/services';
import SpecialistModel from '@/modules/specialists/model';
import { SpecialistService } from '@/modules/specialists/services';
import PartnerOrgModel from '@/modules/partners/model';
import BranchModel from '@/modules/partners/model/branch';
import MemberModel from '@/modules/partners/model/member';
import { errorHandler } from '@/modules/middleware';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/assisted_r6_small_fixes_check?directConnection=true';
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

    // ───────────────────────── Fix 1: only assisted modes ─────────────────────────
    const chatFirst = await slotAt(D, at(2, 9), { serviceModes: ['chat'] });
    const mixed = await slotAt(D, at(2, 10), { serviceModes: ['chat', 'video'] });
    const any = await slotAt(D, at(2, 11));
    const chatInPerson = await slotAt(D, at(2, 12), { serviceModes: ['chat', 'in-person'] });
    const onlyChat = await slotAt(C, at(2, 9), { serviceModes: ['chat'] });

    await check('fix 1: the doctor list\'s nextSlot is the first slot an assisted booking can take, never a chat-only one', async () => {
      const d = await doctorRow(D);
      assert.equal(d.nextSlot.slotId, mixed, JSON.stringify(d.nextSlot));
      assert.deepEqual(d.nextSlot.modes, ['video'], 'chat is never listed');
      const c = await doctorRow(C);
      assert.equal(c.nextSlot, null, 'a doctor with chat-only slots has no bookable slot');
      void onlyChat;
    });

    await check('fix 1: the day\'s slots and the slot read leave chat-only slots out and list only video, call and in-person', async () => {
      const d = await doctorRow(D, `?date=${dashed(day(2))}`);
      assert.deepEqual(d.slots.map((s: any) => s.slotId), [mixed, any, chatInPerson]);
      assert.deepEqual(d.slots.map((s: any) => s.modes), [['video'], ['video', 'call', 'in-person'], ['in-person']]);
      const r = await expect('P', 'GET', `/pharmacy-assisted/doctors/${D}/slots?days=7`, 200);
      const ids = r.json.data.slots.map((s: any) => s.slotId);
      assert.equal(ids.includes(chatFirst), false);
      assert.deepEqual(ids, [mixed, any, chatInPerson]);
      for (const s of r.json.data.slots) assert.equal(s.modes.includes('chat'), false);
      const c = await expect('P', 'GET', `/pharmacy-assisted/doctors/${C}/slots?days=7`, 200);
      assert.deepEqual(c.json.data.slots, []);
    });

    await check('fix 1: with a mode asked, only slots offered in it; a slot listing chat and in-person shows in-person only', async () => {
      const r = await expect('P', 'GET', `/pharmacy-assisted/doctors/${D}/slots?days=7&mode=in-person`, 200);
      assert.deepEqual(r.json.data.slots.map((s: any) => [s.slotId, s.modes]), [[any, ['video', 'call', 'in-person']], [chatInPerson, ['in-person']]]);
      const d = await doctorRow(D, '?mode=call');
      assert.equal(d.nextSlot.slotId, any);
    });

    await check('fix 1: a chat-only slot cannot be booked by the pharmacy (guard: the create refuses it too)', async () => {
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 409, consult(chatFirst), 'SLOT_NOT_AVAILABLE');
    });

    // In-clinic slots: an open branch the doctor consults at, a branch on holiday that day, a branch the doctor left.
    const CLINIC = new Types.ObjectId();
    const OPEN = new Types.ObjectId(); const HOLIDAY = new Types.ObjectId(); const LEFT = new Types.ObjectId();
    await PartnerOrgModel.collection.insertOne({ _id: CLINIC, kind: 'clinic', name: 'Rsix Clinic', isActive: true, verification: { state: 'verified' } } as never);
    await BranchModel.collection.insertMany([OPEN, HOLIDAY, LEFT].map((b) => ({ _id: b, partnerId: String(CLINIC), name: `Branch ${b}`, isActive: true,
      services: { inClinic: true }, holidays: b === HOLIDAY ? [dashed(day(3))] : [] })) as never);
    await MemberModel.collection.insertOne({ partnerId: String(CLINIC), doctorId: K, role: 'doctor', isActive: true,
      doctorBranchIds: [String(OPEN), String(HOLIDAY)] } as never);
    const atHoliday = await slotAt(K, at(3, 9), { serviceModes: ['in-person'], branchId: String(HOLIDAY) });
    const atLeft = await slotAt(K, at(3, 10), { serviceModes: ['in-person'], branchId: String(LEFT) });
    const atOpen = await slotAt(K, at(3, 11), { serviceModes: ['in-person'], branchId: String(OPEN) });

    await check('fix 1: nextSlot and the slot read skip a branch on holiday and a branch the doctor no longer consults at', async () => {
      const k = await doctorRow(K);
      assert.equal(k.nextSlot.slotId, atOpen, JSON.stringify(k.nextSlot));
      const r = await expect('P', 'GET', `/pharmacy-assisted/doctors/${K}/slots?days=7`, 200);
      assert.deepEqual(r.json.data.slots.map((s: any) => s.slotId), [atOpen]);
      // Guard: the create refuses both (reserveSlot).
      for (const slotId of [atHoliday, atLeft]) {
        await expect('P', 'POST', '/pharmacy-assisted/consultations', 409, consult(slotId, { consultationMode: 'in-person', join: undefined }), 'SLOT_NOT_AVAILABLE');
      }
    });

    // ───────────────────────── Fix 3: reschedule ─────────────────────────
    const made = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await slotAt(D, at(4, 9), { serviceModes: ['video'] })));
    const bookingId = made.json.data.booking._id;
    const bookingNow = async () => BookingModel.findById(bookingId).lean() as Promise<any>;

    await check('fix 3: a move onto the slot already held is refused (SAME_SLOT); nothing is told to the patient or doctor', async () => {
      const b = await bookingNow();
      const before = notices.length;
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${bookingId}/reschedule`, 409, { slotId: String(b.slotId), requestKey: newKey() }, 'SAME_SLOT');
      const after = await bookingNow();
      assert.equal(after.assisted.reschedules?.length ?? 0, 0, 'no move recorded');
      assert.equal(notices.length, before, 'no "moved" notice');
    });

    await check('fix 3 (guard): a move onto a chat-only slot, or a slot not offered in the booking\'s mode, is 409 SLOT_NOT_AVAILABLE', async () => {
      const b = await bookingNow();
      for (const slotId of [await slotAt(D, at(5, 9), { serviceModes: ['chat'] }), await slotAt(D, at(5, 10), { serviceModes: ['in-person'] })]) {
        await expect('P', 'POST', `/pharmacy-assisted/bookings/${bookingId}/reschedule`, 409, { slotId, requestKey: newKey() }, 'SLOT_NOT_AVAILABLE');
      }
      assert.equal(String((await bookingNow()).slotId), String(b.slotId), 'not moved');
    });

    await check('fix 3 (guard): another doctor\'s slot 409 SLOT_NOT_THIS_DOCTOR; another pharmacy 404; a stale version 409 BOOKING_CHANGED', async () => {
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${bookingId}/reschedule`, 409, { slotId: await slotAt(K, at(5, 11)), requestKey: newKey() },
        'SLOT_NOT_THIS_DOCTOR');
      await expect('P2', 'POST', `/pharmacy-assisted/bookings/${bookingId}/reschedule`, 404, { slotId: await slotAt(D, at(5, 12)), requestKey: newKey() },
        'BOOKING_NOT_FOUND');
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${bookingId}/reschedule`, 409,
        { slotId: await slotAt(D, at(5, 13)), requestKey: newKey(), expectedUpdatedAt: new Date(Date.now() - DAY).toISOString() }, 'BOOKING_CHANGED');
    });

    await check('fix 3 (guard): a move answers the booker view; the same key replays; once started it is 400 BOOKING_ALREADY_STARTED', async () => {
      const target = await slotAt(D, at(5, 14), { serviceModes: ['chat', 'video'] });
      const key = newKey();
      const b = await bookingNow();
      const r = await expect('P', 'POST', `/pharmacy-assisted/bookings/${bookingId}/reschedule`, 200, { slotId: target, requestKey: key, expectedUpdatedAt: b.updatedAt });
      assert.equal(r.json.data.replayed, false);
      assert.equal(r.json.data.booking.slotId, target);
      assert.equal(r.json.data.booking.price, 500, 'same price');
      const again = await expect('P', 'POST', `/pharmacy-assisted/bookings/${bookingId}/reschedule`, 200, { slotId: target, requestKey: key });
      assert.equal(again.json.data.replayed, true);
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${bookingId}/reschedule`, 409, { slotId: await slotAt(D, at(5, 15)), requestKey: key },
        'IDEMPOTENCY_KEY_REUSED');
      const past = istParts(new Date(Date.now() - 5 * MIN));
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(bookingId) }, { $set: { bookingDate: past.date, bookingTime: past.time } });
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${bookingId}/reschedule`, 400, { slotId: await slotAt(D, at(5, 16)), requestKey: newKey() },
        'BOOKING_ALREADY_STARTED');
    });

    // ───────────────────────── Fix 4: typed name ─────────────────────────
    await check('fix 4: the booker view gives the holder and THIS pharmacy\'s link id; the edit renames only the link; the account name is unchanged', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201,
        consult(await slotAt(D, at(6, 9)), { phone: '9600000611', patient: { relation: 'self', name: 'Bikash Rai' } }));
      const id = r.json.data.booking._id;
      const view = await expect('P', 'GET', `/pharmacy-bookings/${id}`, 200);
      const link = await PharmacyCustomerModel.findOne({ pharmacyId: P, userId: r.json.data.booking.userId }).lean() as any;
      assert.deepEqual(view.json.data.holder, { pharmacyCustomerId: String(link._id), name: 'Bikash Rai' });
      const accountBefore = (await UserModel.findById(r.json.data.booking.userId).lean() as any).name;
      const put = await expect('P', 'PUT', `/pharmacy-customers/${view.json.data.holder.pharmacyCustomerId}/typed-name`, 200, { typedName: 'Bikash  Kumar Rai' });
      assert.deepEqual({ ...put.json.data, _id: String(put.json.data._id), userId: String(put.json.data.userId) },
        { _id: String(link._id), userId: String(r.json.data.booking.userId), typedName: 'Bikash Kumar Rai', shownName: 'Bikash Kumar Rai' });
      assert.equal((await UserModel.findById(r.json.data.booking.userId).lean() as any).name, accountBefore, 'the account name is never changed');
      const after = await expect('P', 'GET', `/pharmacy-bookings/${id}`, 200);
      assert.equal(after.json.data.patientName, 'Bikash Kumar Rai');
      assert.equal(after.json.data.holder.name, 'Bikash Kumar Rai');
      const list = await expect('P', 'GET', '/pharmacy-bookings', 200);
      assert.equal(list.json.data.find((b: any) => b._id === id).holder.pharmacyCustomerId, String(link._id), 'the list carries it too');
    });

    await check('fix 4: a customer_order link shows the real account name; the edit is stored but shownName stays the account name', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await slotAt(D, at(6, 10))));
      const id = r.json.data.booking._id;
      await PharmacyCustomerModel.updateOne({ pharmacyId: P, userId: X }, { $set: { consent: 'customer_order' } });
      const view = await expect('P', 'GET', `/pharmacy-bookings/${id}`, 200);
      assert.equal(view.json.data.holder.name, 'Rina Kumari Das');
      const put = await expect('P', 'PUT', `/pharmacy-customers/${view.json.data.holder.pharmacyCustomerId}/typed-name`, 200, { typedName: 'Rina D' });
      assert.equal(put.json.data.typedName, 'Rina D');
      assert.equal(put.json.data.shownName, 'Rina Kumari Das');
      assert.equal((await expect('P', 'GET', `/pharmacy-bookings/${id}`, 200)).json.data.patientName, 'Rina Kumari Das');
      assert.equal((await UserModel.findById(X).lean() as any).name, 'Rina Kumari Das');
      await PharmacyCustomerModel.updateOne({ pharmacyId: P, userId: X }, { $set: { consent: 'patient_agreed' } });
      const masked = await expect('P', 'GET', `/pharmacy-bookings/${id}`, 200);
      assert.equal(masked.json.data.holder.name, 'Rina D', 'without customer_order: the typed name');
    });

    await check('fix 4: a family-member booking names the patient and, separately, the holder; another pharmacy never sees or edits the link', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201,
        consult(await slotAt(D, at(6, 11)), { patient: { relation: 'Son', name: 'Arun Das' } }));
      const id = r.json.data.booking._id;
      const view = await expect('P', 'GET', `/pharmacy-bookings/${id}`, 200);
      assert.equal(view.json.data.patientName, 'Arun Das');
      assert.equal(view.json.data.holder.name, 'Rina D');
      assert.equal(await DependentModel.countDocuments({ userId: X, name: 'Arun Das' }), 1);
      const linkId = view.json.data.holder.pharmacyCustomerId;
      // P2 books the same holder: its view has its OWN link, never P's.
      const other = await expect('P2', 'POST', '/pharmacy-assisted/consultations', 201, consult(await slotAt(D, at(6, 12)), { patient: { relation: 'self', name: 'R Das' } }));
      const otherView = await expect('P2', 'GET', `/pharmacy-bookings/${other.json.data.booking._id}`, 200);
      const p2Link = await PharmacyCustomerModel.findOne({ pharmacyId: P2, userId: X }).lean() as any;
      assert.equal(otherView.json.data.holder.pharmacyCustomerId, String(p2Link._id));
      assert.notEqual(otherView.json.data.holder.pharmacyCustomerId, linkId);
      assert.equal(otherView.json.data.holder.name, 'R Das');
      await expect('P2', 'PUT', `/pharmacy-customers/${linkId}/typed-name`, 404, { typedName: 'Steal' }, 'CUSTOMER_NOT_LINKED');
      assert.equal((await PharmacyCustomerModel.findById(linkId).lean() as any).typedName, 'Rina D');
      // No link at all (a pharmacy booking row with its link removed): the id is null.
      await PharmacyCustomerModel.deleteOne({ _id: p2Link._id });
      assert.deepEqual((await expect('P2', 'GET', `/pharmacy-bookings/${other.json.data.booking._id}`, 200)).json.data.holder.pharmacyCustomerId, null);
    });

    // ───────────────────────── Fix 5: admin wallet support ─────────────────────────
    await check('fix 5 (guard): the admin pharmacy list finds any pharmacy (unverified too) by name, with phone and status', async () => {
      const r = await expect('ADMIN', 'GET', '/pharmacies?name=Rsix&page=1&limit=20', 200);
      const ids = r.json.data.map((p: any) => String(p._id));
      assert.deepEqual(ids.sort(), [P, PU].sort());
      const u = r.json.data.find((p: any) => String(p._id) === PU);
      assert.equal(u.isVerified, false); assert.equal(u.phone, '9700000603');
      assert.equal(r.json.pagination.total, 2);
      const byPhone = await expect('ADMIN', 'GET', '/pharmacies?phone=9700000601', 200);
      assert.deepEqual(byPhone.json.data.map((p: any) => String(p._id)), [P]);
      const pub = await expect('P', 'GET', '/pharmacies?name=Rsix&page=1&limit=20', 200);
      assert.deepEqual(pub.json.data.map((p: any) => String(p._id)), [P], 'others see verified, active pharmacies only');
    });

    await check('fix 5: an admin reads any pharmacy\'s wallet and transactions; a malformed id is a 400, a missing one 400 PHARMACY_ID_REQUIRED', async () => {
      const w = await expect('ADMIN', 'GET', `/pharmacy-wallet?pharmacyId=${P2}`, 200);
      assert.equal(String(w.json.data.pharmacyId), P2);
      assert.equal(w.json.data.balancePaise, (await PharmacyWalletModel.findOne({ pharmacyId: P2 }).lean() as any).balancePaise);
      assert.equal(w.json.data.frozen, false);
      assert.equal(typeof w.json.data.withdrawableMinor, 'number');
      const t = await expect('ADMIN', 'GET', `/pharmacy-wallet/transactions?pharmacyId=${P2}&page=1&limit=50`, 200);
      const topup = t.json.data.find((row: any) => row.referenceId === 'rsix-fund-p2');
      assert.equal(topup.transactionType, 'credit'); assert.equal(topup.amountPaise, 2000000);
      assert.equal(t.json.data.some((row: any) => row.movementType === 'booking_debit'), true, 'the booking debit of P2 is listed');
      assert.equal(t.json.pagination.total, t.json.data.length);
      assert.equal((await expect('ADMIN', 'GET', `/pharmacy-wallet?pharmacyId=${PU}`, 200)).json.data, null, 'no wallet yet: null (none is made)');
      assert.equal(await PharmacyWalletModel.countDocuments({ pharmacyId: PU }), 0);
      await expect('ADMIN', 'GET', '/pharmacy-wallet', 400, undefined, 'PHARMACY_ID_REQUIRED');
      await expect('ADMIN', 'GET', '/pharmacy-wallet?pharmacyId=not-an-id', 400, undefined, 'VALIDATION_ERROR');
      await expect('ADMIN', 'GET', '/pharmacy-wallet/transactions?pharmacyId=not-an-id', 400, undefined, 'VALIDATION_ERROR');
      // A pharmacy reads only its own wallet: its pharmacyId query is ignored.
      const own = await expect('P', 'GET', `/pharmacy-wallet?pharmacyId=${P2}`, 200);
      assert.equal(String(own.json.data.pharmacyId), P);
    });

    await check('fix 5: the admin top-up answers the same wallet shape as the wallet read', async () => {
      const r = await expect('ADMIN', 'POST', '/pharmacy-wallet/topup', 200, { pharmacyId: P2, amount: 10, notes: 'support' }, undefined,
        { 'idempotency-key': 'rsix-shape-1' });
      assert.equal(String(r.json.data.pharmacyId), P2);
      assert.equal(r.json.data.frozen, false);
      assert.equal(typeof r.json.data.withdrawableMinor, 'number');
      assert.equal(typeof r.json.data.receivableMinor, 'number');
      const replay = await expect('ADMIN', 'POST', '/pharmacy-wallet/topup', 200, { pharmacyId: P2, amount: 10, notes: 'support' }, undefined,
        { 'idempotency-key': 'rsix-shape-1' });
      assert.equal(replay.json.data.balancePaise, r.json.data.balancePaise, 'credited once');
      assert.equal(replay.json.data.frozen, false);
    });

    // Last: a long run of chat-only slots ahead of the first bookable one (more than the 5000-row read).
    await check('fix 1: nextSlot is found past more than 5000 earlier chat-only slots', async () => {
      const d1 = day(7);
      const rows = Array.from({ length: 5001 }, (_, i) => ({ specialistId: G, date: d1, startTime: `${String(Math.floor(i / 60) % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
        endTime: '23:59', duration: 1, maxBookings: 1, currentBookings: 0, isActive: true, isAvailable: true, slotType: 'consultation', serviceModes: ['chat'] }));
      await SlotModel.collection.insertMany(rows as never);
      const bookable = await slotAt(G, at(8, 10), { serviceModes: ['video'] });
      const g = await doctorRow(G, '?speciality=Dermatology');
      assert.equal(g.nextSlot?.slotId, bookable, JSON.stringify(g.nextSlot));
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`${passed} checks passed, ${failed.length} failed`);
  if (failed.length) throw new Error('r6 small-fix checks failed: ' + failed.join('; '));
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
