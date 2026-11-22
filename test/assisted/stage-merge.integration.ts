/**
 * Assisted booking on the stage line (m0/r4-assisted-stage): the guarantees of the stage hotfixes hold for assisted
 * bookings, and the doctor-slot read added for the pharmacy booking and reschedule screens.
 * - S5: an assisted booking of an unverified or inactive doctor is refused (before the transaction, and when the doctor
 *   is unverified while the booking is being made); the doctor lists and the slot read show eligible doctors only; a
 *   booker reschedule onto an ineligible doctor is refused; cancellation stays possible and refunds the pharmacy; the
 *   admin close (S5c) refunds the pharmacy's wallet, never the patient's.
 * - S4: only the booking doctor's own server-marked prescription counts for the booker view; an admin clear (S5) of the
 *   prescription withdraws the dispensing copy from everyone but admins.
 * Real authenticate + pharmacy-assisted / pharmacy-bookings / pharmacy-wallet routers over HTTP against MongoDB.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/assisted_stage_merge_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/assisted/stage-merge.integration.ts
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
import { DependentRepository } from '@/modules/dependents/repository';
import { DependentService } from '@/modules/dependents/services';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { WalletTransactionModel } from '@/modules/wallet/model';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { PharmacyCustomerRepository } from '@/modules/pharmacyCustomers/repository';
import { PharmacyCustomerService } from '@/modules/pharmacyCustomers/services';
import { PharmacyWalletModel } from '@/modules/pharmacyWallet/model';
import { PharmacyWalletRepository, PharmacyWalletTransactionRepository } from '@/modules/pharmacyWallet/repository';
import { PharmacyWalletService } from '@/modules/pharmacyWallet/services';
import SpecialistModel from '@/modules/specialists/model';
import { SpecialistService } from '@/modules/specialists/services';
import { DoctorScheduleTemplateModel } from '@/modules/doctors/model/schedule';
import { errorHandler } from '@/modules/middleware';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/assisted_stage_merge_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;
const istParts = (at: Date) => { const s = new Date(at.getTime() + IST).toISOString(); return { date: s.slice(0, 10).replace(/-/g, ''), time: s.slice(11, 16) }; };
const dashed = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;

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
  Container.set(SpecialistService, { getById: async (id: string) => SpecialistModel.findById(id).lean() } as never);

  const support = await import('@/modules/assisted/support');
  support.setAssistedNotifier(async () => undefined);
  support.setAssistedEffects({ meet: async (b: any) => b, cancelMeet: async (b: any) => b, reminders: async () => undefined, clearReminders: async () => undefined } as never);
  const phase1a = await import('@/modules/assisted/routes/phase1a');
  const { default: pharmacyBookingRouter } = await import('@/modules/assisted/routes');
  const { default: pharmacyWalletRouter } = await import('@/modules/pharmacyWallet/routes');
  const { authenticate } = await import('@/modules/middleware/auth');
  const { adminCloseBooking } = await import('@/modules/bookings/adminClose');
  const { clearBookingField } = await import('@/modules/bookings/adminClear');
  const { decideFileAccess } = await import('@/modules/file/access');
  const { dispensingHashOf } = await import('@/modules/assisted/dispensingCopy');
  const { hasPrescription } = await import('@/modules/assisted/rxAccess');
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
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  process.env.ASSISTED_LIMIT_BOOKINGS_PER_PHONE_PER_DAY = '1000';
  process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '100000';
  process.env.ASSISTED_BOOKING_ENABLED_PHARMACY = 'true';
  process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true';

  try {
    const P = oid(); const ADMIN = oid(); const X = oid();
    await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(P), name: 'Stage Medicals', phone: '9700000301', email: 'stage@pharm.test',
      city: 'Shillong', pincode: '793001', isActive: true, isVerified: true } as never);
    await UserModel.collection.insertOne({ _id: new Types.ObjectId(X), userType: 'user', phone: '9600000401', name: 'Rina Kumari Das',
      createdSource: 'self_signup', otpVerified: true } as never);
    const D = oid(); const D2 = oid(); const E = oid(); const F = oid(); const R = oid();
    await SpecialistModel.collection.insertMany([
      { _id: new Types.ObjectId(D), name: 'Dr Asha Menon', specialization: 'General Physician', languages: ['English'], city: 'Shillong',
        pincode: '793001', consultationFee: 500, isActive: true, isVerified: true },
      { _id: new Types.ObjectId(D2), name: 'Dr Second', specialization: 'General Physician', consultationFee: 500, isActive: true, isVerified: true },
      { _id: new Types.ObjectId(E), name: 'Dr Inactive', specialization: 'General Physician', consultationFee: 500, isActive: false, isVerified: true },
      { _id: new Types.ObjectId(F), name: 'Dr Unverified', specialization: 'General Physician', consultationFee: 500, isActive: true, isVerified: false },
      { _id: new Types.ObjectId(R), name: 'Dr Race', specialization: 'General Physician', consultationFee: 500, isActive: true, isVerified: true },
    ] as never);
    const tokens = { P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), ADMIN: sign({ _id: ADMIN, userType: 'admin' }) };
    type Who = keyof typeof tokens;
    const call = async (who: Who, method: string, url: string, body?: unknown) => {
      const r = await fetch(base + url, { method, headers: { authorization: 'Bearer ' + tokens[who], 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any; try { json = JSON.parse(text); } catch { json = { text }; }
      return { status: r.status, json, text };
    };
    const expect = async (who: Who, method: string, url: string, status: number, body?: unknown, code?: string) => {
      const r = await call(who, method, url, body);
      assert.equal(r.status, status, `${who} ${method} ${url}: ${r.status} ${r.text.slice(0, 300)}`);
      if (code) assert.equal(r.json.code, code, `${who} ${method} ${url}: ${r.text.slice(0, 300)}`);
      return r;
    };
    const slotAt = async (doctor: string, at: Date, extra: Record<string, unknown> = {}) => {
      const s = istParts(at); const e = istParts(new Date(at.getTime() + 15 * MIN));
      const slot = await SlotModel.create({ specialistId: doctor, date: s.date, startTime: s.time, endTime: e.time, duration: 15, maxBookings: 1,
        currentBookings: 0, isActive: true, isAvailable: true, slotType: 'consultation', ...extra } as never);
      return String(slot._id);
    };
    let hour = 0;
    const futureSlot = async (doctor = D, daysAhead = 6) => slotAt(doctor, new Date(Date.now() + daysAhead * DAY + (++hour) * 3600_000 / 4));
    let keySeq = 0;
    const newKey = () => `stg-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;
    const consult = (slotId: string, extra: Record<string, unknown> = {}) => ({
      requestKey: newKey(), phone: '9600000401', patient: { relation: 'self', name: 'Rina Das' },
      consent: { agreed: true, statementVersion: 'v1', statementLanguage: 'en' }, preferredLanguage: 'en', slotId, consultationMode: 'video',
      join: { on: 'partner_device' }, acceptedPriceMinor: 50000, primaryConcern: 'fever', paymentMethod: 'wallet', ...extra,
    });
    const balance = async () => Number(((await PharmacyWalletModel.findOne({ pharmacyId: P }).lean()) as any)?.balancePaise ?? 0);
    await expect('ADMIN', 'POST', '/pharmacy-wallet/topup', 200, { pharmacyId: P, amount: 5000 });
    assert.equal(await balance(), 500000);

    // ───────────────────────── S5: doctors the pharmacy can book ─────────────────────────
    await check('S5: the doctor list shows verified, active doctors only', async () => {
      await futureSlot(D); await futureSlot(E); await futureSlot(F);
      const r = await expect('P', 'GET', '/pharmacy-assisted/doctors', 200);
      const ids = r.json.data.map((d: any) => d.doctorId);
      assert.ok(ids.includes(D) && ids.includes(D2) && ids.includes(R));
      assert.equal(ids.includes(E), false, 'inactive doctor never listed');
      assert.equal(ids.includes(F), false, 'unverified doctor never listed');
    });

    await check('slot read: one eligible doctor\'s bookable slots over the asked days; full, past, other-mode and leave-day slots left out', async () => {
      const today = istParts(new Date()).date;
      const day = (n: number) => istParts(new Date(Date.now() + n * DAY)).date;
      const at = (n: number, h: number) => new Date(Date.parse(`${dashed(day(n))}T${String(h).padStart(2, '0')}:00:00+05:30`));
      const a = await slotAt(D2, at(1, 10));
      const b = await slotAt(D2, at(2, 11), { serviceModes: ['video'] });
      const inPersonOnly = await slotAt(D2, at(2, 12), { serviceModes: ['in-person'] });
      const full = await slotAt(D2, at(2, 13), { currentBookings: 1 });
      const leave = await slotAt(D2, at(3, 10));
      const far = await slotAt(D2, at(9, 10));
      const past = await slotAt(D2, new Date(Date.now() - 2 * 3600_000));
      await DoctorScheduleTemplateModel.collection.insertOne({ doctorId: D2, slotMinutes: 15, days: {}, leaveDates: [day(3)], isActive: true } as never);
      const r = await expect('P', 'GET', `/pharmacy-assisted/doctors/${D2}/slots?days=7&mode=video`, 200);
      assert.equal(r.json.data.doctor.doctorId, D2);
      assert.equal(r.json.data.doctor.feeMinor, 50000);
      assert.equal(r.json.data.from, today);
      const ids = r.json.data.slots.map((s: any) => s.slotId);
      assert.deepEqual(ids, [a, b], JSON.stringify(r.json.data.slots));
      for (const gone of [inPersonOnly, full, leave, far, past]) assert.equal(ids.includes(gone), false);
      assert.deepEqual(Object.keys(r.json.data.slots[0]).sort(), ['date', 'endTime', 'modes', 'slotId', 'startTime', 'startsAt']);
      const later = await expect('P', 'GET', `/pharmacy-assisted/doctors/${D2}/slots?from=${dashed(day(9))}&days=1`, 200);
      assert.deepEqual(later.json.data.slots.map((s: any) => s.slotId), [far]);
      // The doctor list leaves the leave day out too (reserveSlot refuses it).
      const list = await expect('P', 'GET', `/pharmacy-assisted/doctors?date=${dashed(day(3))}`, 200);
      assert.deepEqual(list.json.data.find((d: any) => d.doctorId === D2).slots, []);
    });

    await check('slot read: an unverified, inactive, unknown or malformed doctor is one 404 / 400; switch off is 503', async () => {
      await futureSlot(F); await futureSlot(E);
      await expect('P', 'GET', `/pharmacy-assisted/doctors/${F}/slots`, 404, undefined, 'DOCTOR_NOT_FOUND');
      await expect('P', 'GET', `/pharmacy-assisted/doctors/${E}/slots`, 404, undefined, 'DOCTOR_NOT_FOUND');
      await expect('P', 'GET', `/pharmacy-assisted/doctors/${oid()}/slots`, 404, undefined, 'DOCTOR_NOT_FOUND');
      await expect('P', 'GET', '/pharmacy-assisted/doctors/not-an-id/slots', 400);
      await expect('P', 'GET', `/pharmacy-assisted/doctors/${D}/slots?days=15`, 400);
      delete process.env.ASSISTED_BOOKING_ENABLED_PHARMACY;
      try { await expect('P', 'GET', `/pharmacy-assisted/doctors/${D}/slots`, 503, undefined, 'ASSISTED_BOOKING_DISABLED'); }
      finally { process.env.ASSISTED_BOOKING_ENABLED_PHARMACY = 'true'; }
    });

    // ───────────────────────── S5: assisted create ─────────────────────────
    await check('S5: an assisted booking of an unverified or inactive doctor is refused; nothing debited, booked or opened', async () => {
      const before = await balance();
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 409, consult(await futureSlot(F)), 'DOCTOR_NOT_AVAILABLE');
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 409,
        consult(await futureSlot(F), { phone: '9600000499', patient: { relation: 'self', name: 'New Person' } }), 'DOCTOR_NOT_AVAILABLE');
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 409, consult(await futureSlot(E)), 'DOCTOR_NOT_AVAILABLE');
      assert.equal(await BookingModel.countDocuments({ specialistId: { $in: [E, F] } }), 0);
      assert.equal(await UserModel.countDocuments({ phone: '9600000499' }), 0, 'no account opened for the new number');
      assert.equal(await balance(), before);
    });

    await check('S5b: a doctor unverified while the booking is made is refused inside the transaction (409, nothing committed)', async () => {
      const slot = await futureSlot(R);
      const before = await balance();
      // The assisted check reads the doctor first (still verified); the doctor is unverified before the transaction's own read.
      const original = SpecialistModel.findById.bind(SpecialistModel);
      let flipped = false;
      (SpecialistModel as any).findById = (...args: unknown[]) => {
        const q = original(...(args as [string]));
        if (!flipped && String(args[0]) === R) {
          flipped = true;
          const exec = q.exec.bind(q);
          (q as any).exec = async (...a: unknown[]) => {
            const doc = await exec(...(a as []));
            await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(R) }, { $set: { isVerified: false } });
            return doc;
          };
        }
        return q;
      };
      try {
        await expect('P', 'POST', '/pharmacy-assisted/consultations', 409, consult(slot), 'DOCTOR_NOT_AVAILABLE');
      } finally { (SpecialistModel as any).findById = original; }
      assert.equal(flipped, true, 'the doctor was unverified between the check and the transaction');
      assert.equal(await BookingModel.countDocuments({ specialistId: R }), 0);
      assert.equal(Number(((await SlotModel.findById(slot).lean()) as any).currentBookings), 0, 'the seat was not taken');
      assert.equal(await balance(), before);
    });

    // ───────────────────────── S5: after booking ─────────────────────────
    let booked = '';
    await check('S5: once the doctor is unverified, the booker cannot move the booking; cancel still refunds the pharmacy', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(D2)));
      booked = r.json.data.booking._id;
      const afterBook = await balance();
      const next = await futureSlot(D2);
      await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(D2) }, { $set: { isVerified: false } });
      try {
        const b = await BookingModel.findById(booked).lean() as any;
        await expect('P', 'POST', `/pharmacy-assisted/bookings/${booked}/reschedule`, 409,
          { slotId: next, requestKey: newKey(), expectedUpdatedAt: b.updatedAt }, 'DOCTOR_NOT_AVAILABLE');
        assert.equal(String(((await BookingModel.findById(booked).lean()) as any).slotId), String(b.slotId), 'booking not moved');
        const c = await expect('P', 'POST', `/pharmacy-assisted/bookings/${booked}/cancel`, 200, { reason: 'doctor unavailable' });
        assert.equal(c.json.data.refundedMinor, 50000);
        assert.equal(await balance(), afterBook + 50000);
      } finally { await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(D2) }, { $set: { isVerified: true } }); }
    });

    await check('S5c: the admin close of an assisted booking refunds the pharmacy wallet, never the patient wallet', async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(D)));
      const id = r.json.data.booking._id;
      const before = await balance();
      await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(D) }, { $set: { isVerified: false } });
      try {
        const out = await adminCloseBooking(id, ADMIN, { reason: 'doctor not verified', requestKey: newKey() });
        assert.equal(out.refunded, 500, 'the close audit records rupees, as for every close');
        assert.equal(out.status, 'cancelled');
        assert.equal((out as any).cancellationCause, 'admin');
      } finally { await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(D) }, { $set: { isVerified: true } }); }
      assert.equal(await balance(), before + 50000, 'the pharmacy is refunded');
      assert.equal(await WalletTransactionModel.countDocuments({ userId: X }), 0, 'nothing went to the patient wallet');
      assert.equal(await PaymentRecordModel.countDocuments({ contextId: id }), 0);
    });

    // ───────────────────────── S4 and the S5 admin clear ─────────────────────────
    const prescribed = async (prescriber: string) => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(D)));
      const id = r.json.data.booking._id;
      const url = `/api/static/bookings/${id}/rx-dispense-1700000000000.pdf`;
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: {
        prescription: { advice: 'rest', medicines: [{ name: 'Paracetamol 500' }], testsAdvised: [], prescribedAt: new Date().toISOString(),
          prescribedBySpecialistId: prescriber, prescribedBySpecialistName: 'Dr Asha Menon' },
        'lifecycle.prescriptionUploaded': { at: new Date().toISOString() } } });
      const b = await BookingModel.findById(id).lean() as any;
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { 'prescription.dispensingCopy': { url, hash: dispensingHashOf(b), at: new Date() } } });
      return { id, rel: url.replace('/api/static/', '') };
    };

    await check('S4: a marked prescription counts only when its prescriber is the booking\'s doctor', async () => {
      const other = await prescribed(D2);
      assert.equal(hasPrescription(await BookingModel.findById(other.id).lean()), false);
      const view = await expect('P', 'GET', `/pharmacy-bookings/${other.id}`, 200);
      assert.equal(view.json.data.prescription, undefined, 'no prescription in the booker view');
      assert.deepEqual(await decideFileAccess({ _id: P, pharmacyId: P, userType: 'pharmacy' } as never, other.rel), { allow: false, status: 404 });
      const own = await prescribed(D);
      assert.equal(hasPrescription(await BookingModel.findById(own.id).lean()), true);
      assert.equal((await decideFileAccess({ _id: P, pharmacyId: P, userType: 'pharmacy' } as never, own.rel)).allow, true);
    });

    await check('S5 admin clear: removing the prescription withdraws the dispensing copy from patient, doctor and pharmacy (admins still read)', async () => {
      const { id, rel } = await prescribed(D);
      const readers = {
        patient: { _id: X, userType: 'user' }, doctor: { _id: D, specialistId: D, userType: 'specialist' },
        pharmacy: { _id: P, pharmacyId: P, userType: 'pharmacy' }, admin: { _id: ADMIN, userType: 'admin' },
      };
      for (const [who, r] of Object.entries(readers)) assert.equal((await decideFileAccess(r as never, rel)).allow, true, `${who} reads before`);
      await clearBookingField(id, 'prescription', ADMIN, 'planted prescription');
      for (const who of ['patient', 'doctor', 'pharmacy'] as const) {
        assert.deepEqual(await decideFileAccess(readers[who] as never, rel), { allow: false, status: 404 }, `${who} after the clear`);
      }
      assert.equal((await decideFileAccess(readers.admin as never, rel)).allow, true);
    });

    await check('S5: a doctor no longer verified reads no dispensing copy of its own booking', async () => {
      const { rel } = await prescribed(D);
      await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(D) }, { $set: { isVerified: false } });
      try {
        assert.deepEqual(await decideFileAccess({ _id: D, specialistId: D, userType: 'specialist' } as never, rel), { allow: false, status: 404 });
      } finally { await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(D) }, { $set: { isVerified: true } }); }
      assert.equal((await decideFileAccess({ _id: D, specialistId: D, userType: 'specialist' } as never, rel)).allow, true);
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`${passed} checks passed, ${failed.length} failed`);
  if (failed.length) throw new Error('Assisted stage-merge checks failed: ' + failed.join('; '));
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
