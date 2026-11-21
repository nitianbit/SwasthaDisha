/**
 * S5: a self-signed-up doctor (isVerified false) or an inactive one cannot act as a doctor or be shown to / booked by
 * patients. Refused with 403 SPECIALIST_NOT_VERIFIED: slot create / update, consult status change and the prescription
 * save; booking create (consultation, second opinion, surgery with a named doctor) and reschedule refuse such a doctor;
 * patient-facing doctor and slot lists hide it. Once verified, name / registration number / specialization / degree are
 * admin-only (403 IDENTITY_FIELDS_ADMIN_ONLY). A booking's doctorName always comes from the doctor's record. An admin
 * removes a planted prescription or report (audited). The read-only audit lists such doctors and bookings by id.
 * Real authenticate + specialist / booking / slot / corporate routers and services over HTTP against MongoDB; the
 * payment gateway and the PDF renderer are stubs.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/s5_unverified_doctors_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/booking-scope/s5-unverified-doctors.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { SlotRepository } from '@/modules/slots/repository';
import { SlotService } from '@/modules/slots/services';
import SpecialistModel from '@/modules/specialists/model';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { SpecialistService } from '@/modules/specialists/services';
import { SpecialistPortalService } from '@/modules/specialistPortal/services';
import CorporateModel from '@/modules/corporates/model';
import { CorporateRepository } from '@/modules/corporates/repository';
import { CorporateService } from '@/modules/corporates/services';
import { DependentRepository } from '@/modules/dependents/repository';
import { DependentService } from '@/modules/dependents/services';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { errorHandler } from '@/modules/middleware';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/s5_unverified_doctors_check?directConnection=true';
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
    create: async (o: { amount: number; currency: string }) => ({ id: 'order_s5_' + (++gatewayOrders), amount: o.amount, currency: o.currency, status: 'created' }),
    fetchPayments: async () => ({ items: [] }),
  },
  payments: { fetch: async () => { throw new Error('not used'); } },
};

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  await Promise.all([BookingModel.syncIndexes(), SpecialistModel.syncIndexes()]);

  // tsx emits no decorator metadata: the services the controllers resolve are wired by hand before the routers load.
  const specialistService = Object.assign(Object.create(SpecialistService.prototype), {
    specialistRepository: new SpecialistRepository(), corporateRepository: new CorporateRepository(), bookingRepository: new BookingRepository(),
  }) as SpecialistService;
  const slotService = new SlotService(new SlotRepository());
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
  const notifications = new Proxy({}, { get: () => async () => undefined });
  const bookingService = Object.assign(Object.create(BookingService.prototype), {
    bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
    walletTransactionRepository: new WalletTransactionRepository(), userRepository: new UserRepository(),
    specialistRepository: new SpecialistRepository(), slotRepository: new SlotRepository(),
    notificationService: notifications, paymentService: payments, couponService: {}, emailService: {},
    bookingReminderScheduler: { scheduleBookingReminders: async () => undefined, clearBookingReminders: async () => undefined },
    sendPaidBookingEmailNotification: async () => undefined,
    specialistService, slotService, wellnessPackageService: {},
  }) as BookingService;
  Container.set(BookingService, bookingService);
  Container.set(DependentService, Object.assign(Object.create(DependentService.prototype), { dependentRepository: new DependentRepository() }));
  Container.set(SpecialistService, specialistService);
  Container.set(SlotService, slotService);
  // The doctor's real portal; only the PDF renderer (wkhtmltopdf) is replaced by the path it would write.
  const portal = Object.assign(Object.create(SpecialistPortalService.prototype), {
    bookingRepository: new BookingRepository(), userRepository: new UserRepository(), specialistService, bookingService,
    notificationService: notifications, slotService, slotRepository: new SlotRepository(),
    generatePrescriptionPdf: async (input: { booking: { _id: unknown } }) => `/api/static/bookings/${String(input.booking._id)}/prescription-${Date.now()}.pdf`,
  }) as SpecialistPortalService;
  Container.set(SpecialistPortalService, portal);
  Container.set(CorporateService, Object.assign(Object.create(CorporateService.prototype), { corporateRepository: new CorporateRepository() }));
  const { default: bookingRouter } = await import('@/modules/bookings/routes');
  const { default: specialistRouter } = await import('@/modules/specialists/routes');
  const { default: slotRouter } = await import('@/modules/slots/routes');
  const { default: corporateRouter } = await import('@/modules/corporates/routes');
  const { authenticate } = await import('@/modules/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/bookings', authenticate, bookingRouter);
  app.use('/api/v1/specialists', authenticate, specialistRouter);
  app.use('/api/v1/slots', authenticate, slotRouter);
  app.use('/api/v1/corporates', authenticate, corporateRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;

  try {
    // Doctors. ver: verified and active (the real doctor). unv: a self sign-up (unverified, active) that renamed itself to
    // a real doctor's name. ina: verified but deactivated. ver2: a second verified doctor (identity-lock checks).
    const ver = oid(); const unv = oid(); const ina = oid(); const ver2 = oid();
    await SpecialistModel.collection.insertMany([
      { _id: new Types.ObjectId(ver), name: 'Dr Real Famous', specialization: 'Cardiology', medicalRegistrationNumber: 'MCI-1001', degree: 'MD',
        phone: '9800000001', consultationFee: 300, isActive: true, isVerified: true },
      { _id: new Types.ObjectId(unv), name: 'demoName', phone: '9800000002', isActive: true, isVerified: false, consultationFee: 300 },
      { _id: new Types.ObjectId(ina), name: 'Dr Gone', specialization: 'Cardiology', phone: '9800000003', isActive: false, isVerified: true, consultationFee: 300 },
      { _id: new Types.ObjectId(ver2), name: 'Dr Second', specialization: 'Dermatology', medicalRegistrationNumber: 'MCI-2002', phone: '9800000004',
        consultationFee: 0, isActive: true, isVerified: true },
    ].map((d) => ({ ...d, createdAt: new Date(), updatedAt: new Date() })) as never);
    const cust = oid(); const custB = oid();
    await UserModel.collection.insertMany([cust, custB].map((id, i) => ({ _id: new Types.ObjectId(id), userType: 'user', name: 'Patient ' + i,
      phone: '96000000' + (10 + i) })) as never);
    const tokens = {
      cust: sign({ _id: cust, userType: 'user' }),
      custB: sign({ _id: custB, userType: 'user' }),
      ver: sign({ _id: ver, specialistId: ver, userType: 'specialist' }),
      unv: sign({ _id: unv, specialistId: unv, userType: 'specialist' }),
      ina: sign({ _id: ina, specialistId: ina, userType: 'specialist' }),
      ver2: sign({ _id: ver2, specialistId: ver2, userType: 'specialist' }),
      admin: sign({ _id: oid(), userType: 'admin' }),
    };
    type Who = keyof typeof tokens;
    const call = async (who: Who, method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, { method, headers: { authorization: 'Bearer ' + tokens[who], 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await r.json() as { data?: any; code?: string; message?: string; pagination?: { total: number } };
      return { status: r.status, json };
    };
    const expect = async (who: Who, method: string, path: string, status: number, body?: unknown, code?: string) => {
      const r = await call(who, method, path, body);
      assert.equal(r.status, status, `${who} ${method} ${path}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
      if (code) assert.equal(r.json.code, code, `${who} ${method} ${path}: code ${r.json.code}`);
      return r;
    };

    // Slots (as if opened before S5) and bookings with each doctor.
    const date = '20991230';
    const slot = async (specialistId: string, startTime: string) => String((await SlotModel.create({ specialistId, slotType: 'consultation', date,
      startTime, endTime: startTime.replace(':00', ':30'), duration: 30, maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true }))._id);
    const sVer1 = await slot(ver, '10:00 AM'); const sVer2 = await slot(ver, '11:00 AM'); const sVer3 = await slot(ver, '12:00 PM');
    const sUnv1 = await slot(unv, '10:00 AM'); const sUnv2 = await slot(unv, '11:00 AM');
    const sIna1 = await slot(ina, '10:00 AM');
    const booking = async (specialistId: string, slotId: string, extra: Record<string, unknown> = {}) => String((await BookingModel.collection.insertOne({
      bookingType: 'consultation', userId: cust, specialistId, slotId, bookingDate: date, bookingTime: '10:00 AM', consultationMode: 'in-person',
      serviceMode: 'in-person', primaryConcern: 'Chest pain', status: 'confirmed', paymentStatus: 'paid', price: 300, documents: [],
      createdAt: new Date(), updatedAt: new Date(), ...extra } as never)).insertedId);
    const bUnv = await booking(unv, sUnv2, { doctorName: 'Dr Real Famous' });
    const bVer = await booking(ver, sVer3);
    const bIna = await booking(ina, sIna1);

    // The defect as the review proved it: the sign-up renames itself before anyone verifies it (onboarding still allowed).
    await check('an unverified doctor still reads and edits its own profile (onboarding)', async () => {
      await expect('unv', 'GET', '/specialists/me/profile', 200);
      const r = await expect('unv', 'PUT', '/specialists/me/profile', 200, { name: 'Dr Real Famous', specialization: 'Cardiology', medicalRegistrationNumber: 'X-1' });
      assert.equal(r.json.data.name, 'Dr Real Famous');
      await expect('unv', 'PUT', '/specialists/me/profile', 422, { isVerified: true }, 'FORBIDDEN_FIELD'); // self-verify stays refused
      await expect('unv', 'GET', '/specialists/me/slots', 200);
      await expect('unv', 'GET', '/specialists/me/appointments?view=all', 200);
    });

    await check('an unverified or inactive doctor cannot open, update or reopen slots (403 SPECIALIST_NOT_VERIFIED)', async () => {
      const body = { date, startTime: '2:00 PM', endTime: '3:00 PM', duration: 30 };
      for (const who of ['unv', 'ina'] as const) {
        await expect(who, 'POST', '/specialists/me/slots', 403, body, 'SPECIALIST_NOT_VERIFIED');
        await expect(who, 'PUT', `/specialists/me/slots/${who === 'unv' ? sUnv1 : sIna1}`, 403, { isAvailable: true, isActive: true }, 'SPECIALIST_NOT_VERIFIED');
      }
      assert.equal(await SlotModel.countDocuments({ specialistId: { $in: [unv, ina] } }), 3);
      // Removing its own unbooked slot stays allowed (it only takes availability away).
      const extra = await slot(unv, '4:00 PM');
      await expect('unv', 'DELETE', '/specialists/me/slots/' + extra, 200);
    });

    await check('an unverified or inactive doctor cannot change consult status or save a prescription', async () => {
      for (const [who, id] of [['unv', bUnv], ['ina', bIna]] as const) {
        for (const status of ['confirmed', 'completed', 'cancelled']) {
          await expect(who, 'PATCH', `/specialists/me/appointments/${id}/status`, 403, { status }, 'SPECIALIST_NOT_VERIFIED');
        }
        await expect(who, 'POST', `/specialists/me/appointments/${id}/prescription`, 403,
          { diagnosis: 'Angina', advice: 'Rest', medicines: [{ name: 'Nitroglycerin', dosage: '0.4mg' }] }, 'SPECIALIST_NOT_VERIFIED');
      }
      const b = await BookingModel.findById(bUnv).lean();
      assert.equal(b?.prescription, undefined);
      assert.equal(b?.lifecycle?.prescriptionUploaded, undefined);
      assert.equal(b?.status, 'confirmed');
    });

    await check('a verified doctor is unaffected: opens and updates slots, changes status, saves a prescription', async () => {
      const r = await expect('ver', 'POST', '/specialists/me/slots', 201, { date, startTime: '2:00 PM', endTime: '3:00 PM', duration: 30 });
      assert.equal(r.json.data.length, 2);
      await expect('ver', 'PUT', '/specialists/me/slots/' + r.json.data[0]._id, 200, { isAvailable: false });
      await expect('ver', 'PATCH', `/specialists/me/appointments/${bVer}/status`, 200, { status: 'confirmed' });
      const p = await expect('ver', 'POST', `/specialists/me/appointments/${bVer}/prescription`, 200, { diagnosis: 'Angina', advice: 'Rest' });
      assert.equal(p.json.data.prescription.prescribedBySpecialistName, 'Dr Real Famous');
      assert.ok(p.json.data.lifecycle.prescriptionUploaded.at);
    });

    await check('booking an unverified or inactive doctor is refused (every create route; admin included)', async () => {
      const body = (specialistId: string, slotId: string) => ({ specialistId, slotId, bookingDate: date, bookingTime: '10:00 AM',
        primaryConcern: 'Chest pain', consultationMode: 'in-person' });
      await expect('cust', 'POST', '/bookings/specialist', 400, body(unv, sUnv1), 'SPECIALIST_NOT_VERIFIED');
      await expect('cust', 'POST', '/bookings', 400, { bookingType: 'consultation', ...body(unv, sUnv1) }, 'SPECIALIST_NOT_VERIFIED');
      await expect('cust', 'POST', '/bookings', 400, { bookingType: 'second-opinion', ...body(unv, sUnv1) }, 'SPECIALIST_NOT_VERIFIED');
      await expect('admin', 'POST', '/bookings/specialist', 400, { ...body(unv, sUnv1), userId: cust }, 'SPECIALIST_NOT_VERIFIED');
      await expect('cust', 'POST', '/bookings/specialist', 400, body(ina, sIna1), 'SPECIALIST_NOT_ACTIVE');
      assert.equal(await BookingModel.countDocuments({ specialistId: { $in: [unv, ina] } }), 2);
      assert.equal((await SlotModel.findById(sUnv1).lean())?.currentBookings, 0);
    });

    let bNew = '';
    await check('a verified doctor is still bookable; doctorName comes from the doctor record, never the request', async () => {
      const r = await expect('cust', 'POST', '/bookings/specialist', 201, { specialistId: ver, slotId: sVer1, bookingDate: date, bookingTime: '10:00 AM',
        primaryConcern: 'Chest pain', consultationMode: 'in-person', doctorName: 'Dr Somebody Else' });
      bNew = String(r.json.data.booking._id);
      assert.equal((await BookingModel.findById(bNew).lean())?.doctorName, 'Dr Real Famous');
      const r2 = await expect('custB', 'POST', '/bookings', 201, { bookingType: 'consultation', specialistId: ver2, slotId: await slot(ver2, '9:00 AM'),
        bookingDate: date, bookingTime: '9:00 AM', primaryConcern: 'Rash', consultationMode: 'in-person', doctor_name: 'Dr Real Famous' });
      assert.equal((await BookingModel.findById(r2.json.data.booking._id).lean())?.doctorName, 'Dr Second');
    });

    await check('reschedule never targets (or keeps) an unverified or inactive doctor; a verified one still works', async () => {
      await expect('cust', 'POST', `/bookings/${bNew}/reschedule`, 400, { slotId: sUnv1 }, 'SPECIALIST_NOT_VERIFIED');
      await expect('cust', 'POST', `/bookings/${bNew}/reschedule`, 400, { slotId: sIna1 }, 'SPECIALIST_NOT_ACTIVE');
      await expect('cust', 'POST', `/bookings/${bUnv}/reschedule`, 400, { slotId: sUnv1 }, 'SPECIALIST_NOT_VERIFIED');
      assert.equal((await BookingModel.findById(bUnv).lean())?.slotId, sUnv2); // existing booking left as it is
      await expect('cust', 'POST', `/bookings/${bNew}/reschedule`, 200, { slotId: sVer2 });
    });

    await check('surgery: a named doctor must exist and be verified and active; doctorName from its record only', async () => {
      const surgery = (extra: Record<string, unknown>) => ({ bookingType: 'surgery', bookingDate: date, bookingTime: '10:00 AM',
        primaryConcern: 'Knee replacement', ...extra });
      await expect('cust', 'POST', '/bookings', 400, surgery({ specialistId: unv, doctorName: 'Dr Real Famous' }), 'SPECIALIST_NOT_VERIFIED');
      await expect('cust', 'POST', '/bookings', 400, surgery({ specialistId: ina }), 'SPECIALIST_NOT_ACTIVE');
      await expect('cust', 'POST', '/bookings', 404, surgery({ specialistId: oid() }), 'SPECIALIST_NOT_FOUND');
      const ok = await expect('cust', 'POST', '/bookings', 201, surgery({ specialistId: ver, doctorName: 'Dr Fake' }));
      assert.equal((await BookingModel.findById(ok.json.data.booking._id).lean())?.doctorName, 'Dr Real Famous');
      const none = await expect('cust', 'POST', '/bookings', 201, surgery({ doctor_name: 'Dr Real Famous' }));
      const stored = await BookingModel.findById(none.json.data.booking._id).lean();
      assert.equal(stored?.doctorName, undefined);
      assert.equal(stored?.specialistId, undefined);
    });

    await check('patient-facing doctor lists and details hide an unverified or inactive doctor', async () => {
      const ids = (r: { json: { data?: any } }) => (r.json.data as { _id: string }[]).map((d) => String(d._id)).sort();
      assert.deepEqual(ids(await expect('cust', 'GET', '/specialists', 200)), [ver, ver2].sort());
      assert.deepEqual(ids(await expect('cust', 'GET', '/specialists?search=Famous', 200)), [ver]);
      assert.deepEqual(ids(await expect('cust', 'GET', '/specialists?isVerified=false', 200)), [ver, ver2].sort());
      assert.deepEqual(ids(await expect('cust', 'GET', '/specialists/specialization/Cardiology', 200)), [ver]);
      assert.deepEqual(ids(await expect('cust', 'GET', '/specialists/verified', 200)), [ver, ver2].sort());
      await expect('cust', 'GET', '/specialists/' + unv, 404, undefined, 'SPECIALIST_NOT_FOUND');
      await expect('cust', 'GET', '/specialists/' + ina, 404, undefined, 'SPECIALIST_NOT_FOUND');
      await expect('cust', 'GET', '/specialists/' + ver, 200);
      await expect('ver', 'GET', '/specialists/' + unv, 404, undefined, 'SPECIALIST_NOT_FOUND'); // another doctor is not admin
      await expect('unv', 'GET', '/specialists/' + unv, 200); // itself
      await expect('admin', 'GET', '/specialists/' + unv, 200);
      assert.ok(ids(await expect('admin', 'GET', '/specialists?isVerified=false', 200)).includes(unv));
      const corp = String((await CorporateModel.collection.insertOne({ name: 'Acme', specialistIds: [ver, unv, ina], createdAt: new Date() } as never)).insertedId);
      assert.deepEqual(ids(await expect('cust', 'GET', `/corporates/${corp}/specialists`, 200)), [ver]);
      assert.deepEqual(ids(await expect('admin', 'GET', `/corporates/${corp}/specialists`, 200)), [ver, unv, ina].sort());
    });

    await check('patient-facing slot lists hide an unverified or inactive doctor (admin and the doctor itself still see them)', async () => {
      const n = (r: { json: { data?: any } }) => (r.json.data as unknown[]).length;
      for (const doc of [unv, ina]) {
        assert.equal(n(await expect('cust', 'GET', '/slots/specialist/' + doc, 200)), 0);
        assert.equal(n(await expect('cust', 'GET', '/slots/available?specialistId=' + doc, 200)), 0);
        assert.equal(n(await expect('cust', 'GET', '/slots?specialistId=' + doc + '&isAvailable=true', 200)), 0);
        const paged = await expect('cust', 'GET', `/slots?specialistId=${doc}&page=1&limit=10`, 200);
        assert.equal(n(paged), 0);
        assert.equal(paged.json.pagination?.total, 0);
      }
      await expect('cust', 'GET', '/slots/' + sUnv1, 404, undefined, 'SLOT_NOT_FOUND');
      await expect('cust', 'GET', '/slots/' + sVer2, 200);
      const all = (await expect('cust', 'GET', '/slots/available', 200)).json.data as { specialistId: string }[];
      assert.ok(all.length > 0 && all.every((s) => s.specialistId === ver || s.specialistId === ver2), 'mixed listing shows only verified doctors');
      assert.ok(n(await expect('cust', 'GET', '/slots/specialist/' + ver, 200)) > 0);
      assert.equal(n(await expect('admin', 'GET', '/slots/specialist/' + unv, 200)), 2);
      assert.equal(n(await expect('unv', 'GET', '/slots/specialist/' + unv, 200)), 2);
      await expect('admin', 'GET', '/slots/' + sUnv1, 200);
    });

    await check('once verified, identity fields are admin-only (403 IDENTITY_FIELDS_ADMIN_ONLY); other edits still save', async () => {
      await expect('ver2', 'PUT', '/specialists/me/profile', 403, { name: 'Dr Real Famous' }, 'IDENTITY_FIELDS_ADMIN_ONLY');
      await expect('ver2', 'PUT', '/specialists/me/profile', 403, { medicalRegistrationNumber: 'MCI-9999' }, 'IDENTITY_FIELDS_ADMIN_ONLY');
      await expect('ver2', 'PUT', '/specialists/me/profile', 403, { specialization: 'Cardiology', bio: 'x' }, 'IDENTITY_FIELDS_ADMIN_ONLY');
      await expect('ver2', 'PUT', '/specialists/me/profile', 403, { degree: 'MBBS' }, 'IDENTITY_FIELDS_ADMIN_ONLY');
      const sp = await SpecialistModel.findById(ver2).lean();
      assert.equal(sp?.name, 'Dr Second'); assert.equal(sp?.bio, undefined); assert.equal(sp?.degree, undefined);
      // The whole form resent unchanged (apps do this), surrounding spaces included, saves the other fields.
      const r = await expect('ver2', 'PUT', '/specialists/me/profile', 200, { name: ' Dr Second ', specialization: 'Dermatology',
        medicalRegistrationNumber: 'MCI-2002', bio: 'Skin doctor', consultationFee: 0 });
      assert.equal(r.json.data.bio, 'Skin doctor');
      // The admin edit still changes them.
      await expect('admin', 'PUT', '/specialists/' + ver2, 200, { name: 'Dr Second Name', medicalRegistrationNumber: 'MCI-2003' });
      assert.equal((await SpecialistModel.findById(ver2).lean())?.name, 'Dr Second Name');
      // Before verification they stay editable (onboarding; the admin verifies what it sees).
      await expect('unv', 'PUT', '/specialists/me/profile', 200, { name: 'Dr Unverified', medicalRegistrationNumber: 'X-2', degree: 'MBBS' });
    });

    // Planted rows the admin clears: a "prescription" the unverified doctor managed before S5, and a report.
    const planted = await booking(unv, sUnv1, {
      prescription: { diagnosis: 'Planted', medicines: [{ name: 'Morphine' }], fileUrls: ['/api/static/bookings/x/prescription-1.pdf'],
        prescribedBySpecialistId: unv, prescribedBySpecialistName: 'Dr Real Famous', prescribedAt: '2026-11-20T10:00:00.000Z' },
      report: { message: 'Planted report', fileUrls: ['/api/static/bookings/x/report-1.pdf'] },
      lifecycle: { prescriptionUploaded: { at: '2026-11-20T10:00:00.000Z' } },
    });
    await PharmacyOrderModel.collection.insertOne({ linkedConsultationId: new Types.ObjectId(planted), pharmacyId: oid(), customerId: cust,
      createdAt: new Date() } as never);

    await check('audit (read-only, ids only) lists unverified/inactive doctors with slots/bookings/prescriptions and their bookings', async () => {
      const { auditS5UnverifiedDoctors } = await import('../../src1/scripts/auditS5UnverifiedDoctors');
      const hash = async () => (await mongoose.connection.db.command({ dbHash: 1 })).md5 as string;
      const before = await hash();
      const report = await auditS5UnverifiedDoctors();
      assert.equal(await hash(), before, 'the audit wrote nothing');
      const byId = new Map(report.specialists.map((s) => [s.specialistId, s]));
      assert.deepEqual([...byId.keys()].sort(), [unv, ina].sort());
      assert.deepEqual({ ...byId.get(unv), specialistId: undefined }, { specialistId: undefined, isActive: true, isVerified: false,
        slots: 2, openSlots: 2, bookings: 2, prescriptions: 1 });
      assert.equal(byId.get(ina)?.bookings, 1);
      assert.deepEqual(report.bookings.map((b) => b.bookingId).sort(), [bUnv, bIna, planted].sort());
      const p = report.bookings.find((b) => b.bookingId === planted)!;
      assert.equal(p.hasPrescription, true); assert.equal(p.prescriptionMarker, true); assert.equal(p.hasReport, true);
      assert.deepEqual(report.linkedPharmacyOrders.map((o) => o.bookingId), [planted]);
      const text = JSON.stringify(report);
      for (const pii of ['Dr ', 'demoName', 'Patient', '980000', '960000', 'Morphine', 'Planted', 'Chest pain', '.pdf']) {
        assert.equal(text.includes(pii), false, 'audit output contains ' + pii);
      }
      // The npm script itself: JSON on stdout, the same rows.
      const out = execFileSync('npx', ['tsx', '--tsconfig', 'tsconfig.json', 'src1/scripts/auditS5UnverifiedDoctors.ts'],
        { env: { ...process.env, MONGODB_URL: FIXTURE_URL }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      assert.deepEqual(JSON.parse(out).bookings.map((b: { bookingId: string }) => b.bookingId).sort(), [bUnv, bIna, planted].sort());
      assert.equal(await hash(), before, 'the audit script wrote nothing');
    });

    await check('admin clears a planted prescription (and its marker) or report; reason required, audited, admin only', async () => {
      const reason = { reason: 'Planted by an unverified doctor account' };
      for (const who of ['cust', 'unv', 'ver'] as const) {
        const r = await call(who, 'DELETE', `/bookings/${planted}/prescription`, reason);
        assert.ok(r.status === 403 || r.status === 404, `${who}: ${r.status}`);
        await expect(who, 'DELETE', `/bookings/${planted}/report`, r.status, reason);
      }
      await expect('admin', 'DELETE', `/bookings/${planted}/prescription`, 400, {}, 'VALIDATION_ERROR');
      await expect('admin', 'DELETE', `/bookings/${planted}/prescription`, 400, { reason: ' ' }, 'VALIDATION_ERROR');
      assert.ok((await BookingModel.findById(planted).lean())?.prescription);
      const r = await expect('admin', 'DELETE', `/bookings/${planted}/prescription`, 200, reason);
      let b = await BookingModel.findById(planted).lean();
      assert.equal(b?.prescription, undefined);
      assert.equal(b?.lifecycle?.prescriptionUploaded, undefined);
      assert.ok(b?.report, 'the report is a separate clear');
      await expect('admin', 'DELETE', `/bookings/${planted}/prescription`, 404, reason, 'PRESCRIPTION_NOT_FOUND');
      await expect('admin', 'DELETE', `/bookings/${planted}/report`, 200, { reason: 'Planted report' });
      b = await BookingModel.findById(planted).lean();
      assert.equal(b?.report, undefined);
      await expect('admin', 'DELETE', `/bookings/${planted}/report`, 404, reason, 'REPORT_NOT_FOUND');
      await expect('admin', 'DELETE', `/bookings/${oid()}/report`, 404, reason, 'BOOKING_NOT_FOUND');
      const rows = await mongoose.connection.db.collection('bookingadminclears').find({ bookingId: planted }).sort({ clearedAt: 1 }).toArray();
      assert.equal(rows.length, 2);
      assert.equal(String(rows[0]._id), r.json.data.auditId);
      assert.equal(rows[0].field, 'prescription'); assert.equal(rows[0].reason, reason.reason);
      assert.equal(rows[0].removed.prescribedBySpecialistId, unv); assert.equal(rows[0].removed.markerAt, '2026-11-20T10:00:00.000Z');
      assert.deepEqual(rows[0].removed.fileUrls, ['/api/static/bookings/x/prescription-1.pdf']);
      assert.equal(JSON.stringify(rows).includes('Morphine'), false);
      assert.equal(rows[1].field, 'report');
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }

  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) { console.log('failed:\n- ' + failed.join('\n- ')); process.exit(1); }
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
