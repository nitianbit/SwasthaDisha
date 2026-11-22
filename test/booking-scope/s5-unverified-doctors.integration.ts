/**
 * S5: a self-signed-up doctor (isVerified false) or an inactive one cannot act as a doctor or be shown to / booked by
 * patients. Refused with 403 SPECIALIST_NOT_VERIFIED: slot create / update, consult status change and the prescription
 * save; booking create (consultation, second opinion, surgery with a named doctor) and reschedule refuse such a doctor;
 * patient-facing doctor and slot lists hide it. Once verified, name / registration number / specialization / degree are
 * admin-only (403 IDENTITY_FIELDS_ADMIN_ONLY). A booking's doctorName always comes from the doctor's record. An admin
 * removes a planted prescription or report (audited). The read-only audit lists such doctors and bookings by id.
 * Review follow-up: such a doctor reads its bookings without patient contacts, meeting link, concern or history and may
 * still cancel; a pending booking with it takes no payment (a capture is recorded and returned to the wallet); sign-in
 * phone / email are admin-only after verification; verification is fenced and recorded; the HR overview hides such
 * doctors; a cleared prescription PDF is no longer readable.
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
import WalletModel from '@/modules/wallet/model';
import { HRRepository } from '@/modules/hr/repository';
import { HRService } from '@/modules/hr/services';
import { decideFileAccess } from '@/modules/file/access';
import { FileGrantModel } from '@/modules/file/model/access';
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
  // Payments the gateway reports as captured (verify reads them back from the gateway).
  captured: new Map<string, { id: string; order_id: string; amount: number; currency: string; status: string }>(),
  payments: { fetch: async (id: string) => { const p = fakeRazorpay.captured.get(id); if (!p) throw new Error('unknown payment'); return p; } },
};

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  // The deploy step itself (npm run sync-indexes) against this throwaway database: it must build the S5 audit collections.
  execFileSync('npx', ['tsx', '--tsconfig', 'tsconfig.json', 'src1/scripts/syncIndexes.ts'],
    { env: { ...process.env, MONGODB_URL: FIXTURE_URL }, stdio: ['ignore', 'ignore', 'ignore'] });
  const indexKeys = async (collection: string) => (await mongoose.connection.db.collection(collection).listIndexes().toArray().catch(() => []))
    .map((ix) => JSON.stringify(ix.key));
  const syncedAuditIndexes = { clears: await indexKeys('bookingadminclears'), verifications: await indexKeys('specialistverifications') };
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
  Container.set(PaymentService, payments);
  const { default: paymentRouter } = await import('@/modules/payment/routes');
  const { authenticate } = await import('@/modules/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/bookings', authenticate, bookingRouter);
  app.use('/api/v1/specialists', authenticate, specialistRouter);
  app.use('/api/v1/slots', authenticate, slotRouter);
  app.use('/api/v1/corporates', authenticate, corporateRouter);
  app.use('/api/v1/payments', authenticate, paymentRouter);
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
    const cust = oid(); const custB = oid(); const adminId = oid();
    await UserModel.collection.insertMany([cust, custB].map((id, i) => ({ _id: new Types.ObjectId(id), userType: 'user', name: 'Patient ' + i,
      phone: '96000000' + (10 + i) })) as never);
    const tokens = {
      cust: sign({ _id: cust, userType: 'user' }),
      custB: sign({ _id: custB, userType: 'user' }),
      ver: sign({ _id: ver, specialistId: ver, userType: 'specialist' }),
      unv: sign({ _id: unv, specialistId: unv, userType: 'specialist' }),
      ina: sign({ _id: ina, specialistId: ina, userType: 'specialist' }),
      ver2: sign({ _id: ver2, specialistId: ver2, userType: 'specialist' }),
      admin: sign({ _id: adminId, userType: 'admin' }),
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
    // Patient details a booking carries (contacts, address, meeting link, concern, notes, documents).
    const privateFields = { contactNo: '9123456789', alternateContactNo: '9123456780', notes: 'private note',
      serviceAddress: { line1: '12 Private Lane', city: 'Pune', pincode: '411001' },
      virtualMeeting: { provider: 'google_meet', status: 'active', joinUrl: 'https://meet.google.com/s5-secret' },
      documents: [{ type: 'report', url: '/api/static/general/x.pdf', fileName: 'old.pdf' }] };
    const bUnv = await booking(unv, sUnv2, { doctorName: 'Dr Real Famous', ...privateFields });
    const bVer = await booking(ver, sVer3, privateFields);
    const bIna = await booking(ina, sIna1);

    await check('review 2-1: npm run sync-indexes creates the S5 audit collections with their indexes', async () => {
      assert.ok(syncedAuditIndexes.clears.includes('{"bookingId":1}'), 'bookingadminclears: ' + syncedAuditIndexes.clears.join(' '));
      assert.ok(syncedAuditIndexes.verifications.includes('{"specialistId":1}'), 'specialistverifications: ' + syncedAuditIndexes.verifications.join(' '));
    });

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
        for (const status of ['confirmed', 'completed']) {
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
      // S5 round 3 (L5): each booking's appointment, price and payment, and whether it can still be cancelled.
      const u = report.bookings.find((b) => b.bookingId === bUnv)!;
      assert.deepEqual([u.bookingDate, u.bookingTime, u.price, u.paymentStatus, u.timing], [date, '10:00 AM', 300, 'paid', 'upcoming_cancel_before_start']);
      const later = await auditS5UnverifiedDoctors(new Date('2100-01-01T00:00:00.000Z'));
      assert.equal(later.bookings.find((b) => b.bookingId === bUnv)!.timing, 'past_start_stuck');
      await BookingModel.updateOne({ _id: bIna }, { $set: { status: 'cancelled' } });
      assert.equal((await auditS5UnverifiedDoctors()).bookings.find((b) => b.bookingId === bIna)!.timing, 'closed');
      await BookingModel.updateOne({ _id: bIna }, { $set: { status: 'confirmed' } });
      // L5a: past its start an UNPAID open booking is not stuck (the payment sweep expires it); a PAID one with an
      // unreadable time is stuck (cancel answers INVALID_BOOKING_DATETIME).
      const year2100 = new Date('2100-01-01T00:00:00.000Z');
      await BookingModel.updateOne({ _id: bIna }, { $set: { status: 'pending', paymentStatus: 'pending' } });
      assert.equal((await auditS5UnverifiedDoctors(year2100)).bookings.find((b) => b.bookingId === bIna)!.timing, 'unpaid_will_expire');
      await BookingModel.updateOne({ _id: bIna }, { $set: { status: 'confirmed', paymentStatus: 'paid', bookingTime: 'later today' } });
      assert.equal((await auditS5UnverifiedDoctors()).bookings.find((b) => b.bookingId === bIna)!.timing, 'paid_unknown_time_stuck');
      await BookingModel.updateOne({ _id: bIna }, { $set: { bookingTime: '10:00 AM' } });
      const { timingOf } = await import('../../src1/scripts/auditS5UnverifiedDoctors');
      const open = { status: 'pending', bookingDate: '20200101', bookingTime: '10:00 AM' };
      assert.equal(timingOf({ ...open, paymentStatus: 'pending' }, new Date()), 'unpaid_will_expire');
      assert.equal(timingOf({ ...open, paymentStatus: 'pending', walletFunding: { total: 100 } }, new Date()), 'past_start_stuck', 'wallet-funded = money held');
      assert.equal(timingOf({ ...open, paymentStatus: 'pending', walletFunding: { captures: [{ state: 'applied' }] } }, new Date()), 'past_start_stuck');
      assert.equal(timingOf({ ...open, bookingTime: '??', paymentStatus: 'pending' }, new Date()), 'unknown_time');
      const before2 = await hash();
      const text = JSON.stringify(report);
      for (const pii of ['Dr ', 'demoName', 'Patient', '980000', '960000', 'Morphine', 'Planted', 'Chest pain', '.pdf']) {
        assert.equal(text.includes(pii), false, 'audit output contains ' + pii);
      }
      // The npm script itself: JSON on stdout, the same rows.
      const out = execFileSync('npx', ['tsx', '--tsconfig', 'tsconfig.json', 'src1/scripts/auditS5UnverifiedDoctors.ts'],
        { env: { ...process.env, MONGODB_URL: FIXTURE_URL }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      assert.deepEqual(JSON.parse(out).bookings.map((b: { bookingId: string }) => b.bookingId).sort(), [bUnv, bIna, planted].sort());
      assert.equal(await hash(), before2, 'the audit script wrote nothing');
      assert.equal(typeof JSON.parse(out).bookings[0].timing, 'string');
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

    // ---- S5 review follow-up ----
    const SECRETS = ['9123456789', '9123456780', 'private note', 'Private Lane', 's5-secret', 'Chest pain', 'old.pdf', '96000000'];
    const leaks = (v: unknown) => SECRETS.filter((x) => JSON.stringify(v).includes(x));

    await check('review 1: an ineligible doctor reads its bookings without patient contacts, meeting link, concern or history', async () => {
      const list = (await expect('unv', 'GET', '/specialists/me/appointments?view=all', 200)).json.data as Record<string, unknown>[];
      const row = list.find((b) => String(b._id) === bUnv)!;
      assert.ok(row, 'the booking is still listed');
      assert.equal(row.bookingTime, '10:00 AM'); assert.equal(row.status, 'confirmed'); assert.equal(row.bookingDate, date);
      assert.deepEqual(leaks(list), []);
      const day = (await expect('unv', 'GET', `/specialists/me/appointments?view=day&date=${date}`, 200)).json.data;
      assert.deepEqual(leaks(day), []);
      const detail = (await expect('unv', 'GET', `/specialists/me/appointments/${bUnv}`, 200)).json.data;
      assert.equal(String(detail.booking._id), bUnv); assert.equal(detail.booking.status, 'confirmed');
      assert.equal(detail.patient.name, 'Patient 0');
      assert.deepEqual(leaks(detail), []);
      const history = (await expect('unv', 'GET', `/specialists/me/patients/${cust}/history`, 200)).json.data;
      assert.ok(history.consultations.some((c: { bookingId: string }) => String(c.bookingId) === bUnv));
      assert.deepEqual(leaks(history), []);
      // The generic booking reads a doctor may use (S2 scope) are reduced the same way.
      assert.deepEqual(leaks((await expect('unv', 'GET', '/bookings/' + bUnv, 200)).json.data), []);
      assert.deepEqual(leaks((await expect('unv', 'GET', '/bookings/user/' + cust, 200)).json.data), []);
      assert.deepEqual(leaks((await expect('ina', 'GET', '/bookings/' + bIna, 200)).json.data), []);
      // A verified doctor (control) and the customer still see everything.
      const full = (await expect('ver', 'GET', `/specialists/me/appointments/${bVer}`, 200)).json.data;
      assert.equal(full.booking.contactNo, '9123456789'); assert.equal(full.booking.virtualMeeting.joinUrl, 'https://meet.google.com/s5-secret');
      assert.equal(full.patient.phone, '9600000010');
      assert.equal((await expect('ver', 'GET', '/bookings/' + bVer, 200)).json.data.notes, 'private note');
      assert.equal((await expect('cust', 'GET', '/bookings/' + bUnv, 200)).json.data.contactNo, '9123456789');
    });

    await check('review 6a: the S5 guard does not stop an ineligible doctor\'s cancel (main: it answers 409; the patient cancels); confirm and complete stay refused', async () => {
      const bUnvCancel = await booking(unv, await slot(unv, '1:00 PM'));
      const r = await call('unv', 'PATCH', `/specialists/me/appointments/${bUnvCancel}/status`, { status: 'cancelled' });
      assert.notEqual(r.json.code, 'SPECIALIST_NOT_VERIFIED', 'cancel is not stopped by the S5 guard: ' + JSON.stringify(r.json));
      assert.notEqual(r.status, 403);
      for (const status of ['confirmed', 'completed']) {
        await expect('unv', 'PATCH', `/specialists/me/appointments/${bUnvCancel}/status`, 403, { status }, 'SPECIALIST_NOT_VERIFIED');
      }
      // On the main line the portal's cancel is a 409 (dedicated command); the patient's own cancel closes it.
      await expect('cust', 'POST', `/bookings/${bUnvCancel}/cancel`, 200, { cancellationReason: 'Doctor unavailable' });
      assert.equal((await BookingModel.findById(bUnvCancel).lean())?.status, 'cancelled');
    });

    await check('review 2-4: an interrupted keyed create is not completed for an ineligible doctor; a finished one still answers its receipt', async () => {
      const keyed = async (requestKey: string, extra: Record<string, unknown> = {}) => booking(unv, await slot(unv, '5:00 PM'), {
        createRequestKey: requestKey, status: 'pending', paymentStatus: 'pending', price: 300, originalPrice: 300,
        createTerms: { basePrice: 300, discountAmount: 0, useWalletBalance: false }, createdAt: new Date(), ...extra });
      const body = (requestKey: string, slotId: string) => ({ bookingType: 'consultation', requestKey, specialistId: unv, slotId, bookingDate: date, bookingTime: '5:00 PM',
        primaryConcern: 'Chest pain', consultationMode: 'in-person' });
      const half = await keyed('s5-interrupted-0001');
      const halfSlot = String((await BookingModel.findById(half).lean())!.slotId);
      await expect('cust', 'POST', '/bookings', 400, body('s5-interrupted-0001', halfSlot), 'SPECIALIST_NOT_VERIFIED');
      const after = await BookingModel.findById(half).lean();
      assert.equal(after?.paymentTransactionId, undefined, 'no payment order was made'); assert.equal(after?.status, 'pending');
      const done = await keyed('s5-finished-00001', { paymentTransactionId: oid() });
      const doneSlot = String((await BookingModel.findById(done).lean())!.slotId);
      const replay = await expect('cust', 'POST', '/bookings', 201, body('s5-finished-00001', doneSlot));
      assert.equal(String(replay.json.data.booking._id), done); assert.equal(replay.json.data.replayed, true);
    });

    await check('review 2-5: an ineligible doctor no longer reads its bookings\' files by URL; the patient and a verified doctor still do', async () => {
      const bRx = await booking(unv, await slot(unv, '6:00 PM'));
      const rx = `bookings/${bRx}/prescription-1700000000001.pdf`;
      await BookingModel.updateOne({ _id: bRx }, { $set: { prescription: { fileUrls: ['/api/static/' + rx] },
        documents: [{ type: 'report', url: '/api/static/general/s5-patient-report.pdf', fileName: 'r.pdf' }] } });
      await FileGrantModel.collection.insertOne({ path: 'general/s5-patient-report.pdf', kind: 'booking', model: 'Booking',
        resourceId: bRx, field: 'documents.url', source: 'attach', state: 'active', gen: 1, createdByType: 'user', createdById: cust, createdAt: new Date() });
      const as = (r: Record<string, string>, path: string) => decideFileAccess(r as never, path).then((d) => d.allow);
      const unvR = { _id: unv, specialistId: unv, userType: 'specialist' }; const custR = { _id: cust, userType: 'user' };
      assert.equal(await as(unvR, rx), false, 'doctor: prescription'); assert.equal(await as(unvR, 'general/s5-patient-report.pdf'), false, 'doctor: document');
      assert.equal(await as(custR, rx), true, 'patient: prescription'); assert.equal(await as(custR, 'general/s5-patient-report.pdf'), true, 'patient: document');
      // The doctor's own onboarding documents are not booking files: still readable by it (specialist binding).
      await FileGrantModel.collection.insertOne({ path: 'general/s5-own-degree.pdf', kind: 'specialist', model: 'Specialist',
        resourceId: unv, field: 'documents.url', source: 'attach', state: 'active', gen: 1, createdByType: 'specialist', createdById: unv, createdAt: new Date() });
      await SpecialistModel.updateOne({ _id: unv }, { $set: { documents: [{ type: 'medical-degree', url: '/api/static/general/s5-own-degree.pdf' }] } });
      assert.equal(await as(unvR, 'general/s5-own-degree.pdf'), true, 'doctor: own degree');
      // A verified doctor (control): its booking's files.
      await BookingModel.updateOne({ _id: bVer }, { $set: { prescription: { fileUrls: [`/api/static/bookings/${bVer}/prescription-1700000000002.pdf`] } } });
      assert.equal(await as({ _id: ver, specialistId: ver, userType: 'specialist' }, `bookings/${bVer}/prescription-1700000000002.pdf`), true);
    });

    await check('review 2-1b: without their collections the admin clear and the verification answer 503 INDEXES_OUTDATED and change nothing', async () => {
      const bX = await booking(unv, await slot(unv, '7:00 PM'), { report: { message: 'x' } });
      const docX = oid();
      await SpecialistModel.collection.insertOne({ _id: new Types.ObjectId(docX), name: 'Dr Pending', isActive: true, isVerified: false,
        createdAt: new Date(), updatedAt: new Date() } as never);
      for (const c of ['bookingadminclears', 'specialistverifications']) await mongoose.connection.db.dropCollection(c).catch(() => undefined);
      await expect('admin', 'DELETE', `/bookings/${bX}/report`, 503, { reason: 'Index check' }, 'INDEXES_OUTDATED');
      assert.ok((await BookingModel.findById(bX).lean())?.report, 'report kept');
      await expect('admin', 'PUT', '/specialists/' + docX, 503, { isVerified: true }, 'INDEXES_OUTDATED');
      assert.equal((await SpecialistModel.findById(docX).lean())?.isVerified, false);
      const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
      assert.equal(names.includes('bookingadminclears') || names.includes('specialistverifications'), false, 'no collection created on the fly');
      // After sync-indexes (here: the same create + index build) both work.
      const { BookingAdminClearModel } = await import('@/modules/bookings/model/adminClear');
      const { SpecialistVerificationModel } = await import('@/modules/specialists/model/verification');
      for (const M of [BookingAdminClearModel, SpecialistVerificationModel] as mongoose.Model<any>[]) { await M.createCollection(); await M.createIndexes(); }
      await expect('admin', 'DELETE', `/bookings/${bX}/report`, 200, { reason: 'Index check' });
      await expect('admin', 'PUT', '/specialists/' + docX, 200, { isVerified: true });
    });

    await check('review 2: a pending booking with an ineligible doctor takes no payment; a captured payment is recorded and returned to the wallet', async () => {
      const verP = oid(); const custP = oid();
      await SpecialistModel.collection.insertOne({ _id: new Types.ObjectId(verP), name: 'Dr Pay', phone: '9800000009', consultationFee: 300,
        isActive: true, isVerified: true, createdAt: new Date(), updatedAt: new Date() } as never);
      await UserModel.collection.insertOne({ _id: new Types.ObjectId(custP), userType: 'user', name: 'Payer', phone: '9600000099' } as never);
      Object.assign(tokens, { custP: sign({ _id: custP, userType: 'user' }) });
      const created = await expect('custP' as Who, 'POST', '/bookings/specialist', 201, { specialistId: verP, slotId: await slot(verP, '3:00 PM'),
        bookingDate: date, bookingTime: '3:00 PM', primaryConcern: 'Fever', consultationMode: 'in-person' });
      const id = String(created.json.data.booking._id);
      const pay = created.json.data.payment as { paymentTransactionId: string; razorpayOrderId: string; amount: number };
      assert.equal(pay.amount, 300);
      // The doctor loses verification while the patient is paying (as a pre-S5 booking with a self sign-up doctor).
      await SpecialistModel.updateOne({ _id: verP }, { $set: { isVerified: false } });
      await expect('custP' as Who, 'POST', `/bookings/${id}/retry-payment`, 400, {}, 'SPECIALIST_NOT_VERIFIED');
      // The checkout already open captures anyway: verify records it, returns it to the wallet and says why.
      fakeRazorpay.captured.set('pay_s5_1', { id: 'pay_s5_1', order_id: pay.razorpayOrderId, amount: 30000, currency: 'INR', status: 'captured' });
      const signature = (await import('node:crypto')).createHmac('sha256', 'secret').update(`${pay.razorpayOrderId}|pay_s5_1`).digest('hex');
      await expect('custP' as Who, 'POST', '/payments/verify', 400, { paymentTransactionId: pay.paymentTransactionId,
        razorpayOrderId: pay.razorpayOrderId, razorpayPaymentId: 'pay_s5_1', razorpaySignature: signature }, 'SPECIALIST_NOT_VERIFIED');
      const record = await PaymentRecordModel.findById(pay.paymentTransactionId).lean() as Record<string, unknown>;
      assert.equal(record.status, 'refunded'); assert.equal(record.isProcessed, true); assert.equal(record.razorpayPaymentId, 'pay_s5_1');
      const b = await BookingModel.findById(id).lean();
      assert.equal(b?.paymentStatus, 'pending'); assert.equal(b?.status, 'pending');
      assert.equal(Number((await WalletModel.findOne({ userId: custP }).lean())?.balance), 300, 'the captured ₹300 is in the wallet');
      // Cancelling (and so the refund path) is never refused.
      const cancelled = await expect('custP' as Who, 'POST', `/bookings/${id}/cancel`, 200, { cancellationReason: 'Doctor unavailable' });
      assert.equal(cancelled.json.data.status, 'cancelled');
      assert.equal(Number((await WalletModel.findOne({ userId: custP }).lean())?.balance), 300, 'no double credit');
    });

    await check('review 3: once verified, the sign-in phone and email are admin-only too (unchanged values still save)', async () => {
      await expect('ver2', 'PUT', '/specialists/me/profile', 403, { phone: '9811111111' }, 'IDENTITY_FIELDS_ADMIN_ONLY');
      await expect('ver2', 'PUT', '/specialists/me/profile', 403, { email: 'takeover@example.com' }, 'IDENTITY_FIELDS_ADMIN_ONLY');
      await SpecialistModel.updateOne({ _id: ver2 }, { $set: { email: 'second@example.com' } });
      await expect('ver2', 'PUT', '/specialists/me/profile', 403, { email: 'other@example.com', bio: 'x' }, 'IDENTITY_FIELDS_ADMIN_ONLY');
      const sp = await SpecialistModel.findById(ver2).lean();
      assert.equal(sp?.phone, '9800000004'); assert.equal(sp?.email, 'second@example.com');
      await expect('ver2', 'PUT', '/specialists/me/profile', 200, { phone: '9800000004', email: 'Second@Example.com', bio: 'Same contacts' });
      await expect('unv', 'PUT', '/specialists/me/profile', 200, { phone: '9800000012' }); // before verification: onboarding
    });

    await check('review 4: admin verification is fenced on what was reviewed (409) and recorded with who verified what', async () => {
      const docF = oid(); const docG = oid();
      await SpecialistModel.collection.insertMany([
        { _id: new Types.ObjectId(docF), name: 'Dr Fence', medicalRegistrationNumber: 'R-1', degree: 'MBBS', specialization: 'ENT',
          isActive: true, isVerified: false, createdAt: new Date(), updatedAt: new Date('2026-11-20T10:00:00.000Z') },
        { _id: new Types.ObjectId(docG), name: 'Dr Nofence', medicalRegistrationNumber: 'R-2', isActive: true, isVerified: false,
          createdAt: new Date(), updatedAt: new Date() },
      ] as never);
      const rows = () => mongoose.connection.db.collection('specialistverifications').find({ specialistId: { $in: [docF, docG] } }).toArray();
      await expect('admin', 'PUT', '/specialists/' + docF, 409, { isVerified: true, expectedName: 'Dr Other' }, 'SPECIALIST_CHANGED_SINCE_REVIEW');
      await expect('admin', 'PUT', '/specialists/' + docF, 409, { isVerified: true, expectedRegistrationNumber: 'R-9' }, 'SPECIALIST_CHANGED_SINCE_REVIEW');
      await expect('admin', 'PUT', '/specialists/' + docF, 409, { isVerified: true, expectedUpdatedAt: '2026-11-21T10:00:00.000Z' }, 'SPECIALIST_CHANGED_SINCE_REVIEW');
      assert.equal((await SpecialistModel.findById(docF).lean())?.isVerified, false);
      assert.equal((await rows()).length, 0, 'a refused verification writes no row');
      await expect('admin', 'PUT', '/specialists/' + docF, 200, { isVerified: true, expectedName: ' Dr Fence ', expectedRegistrationNumber: 'R-1',
        expectedUpdatedAt: '2026-11-20T10:00:00.000Z' });
      const f = await SpecialistModel.findById(docF).lean() as Record<string, unknown>;
      assert.equal(f.isVerified, true);
      for (const k of ['expectedName', 'expectedRegistrationNumber', 'expectedUpdatedAt']) assert.equal(f[k], undefined);
      await expect('admin', 'PUT', '/specialists/' + docG, 200, { isVerified: true }); // panels without the fence still verify
      await expect('admin', 'PUT', '/specialists/' + docF, 200, { bio: 'later edit', isVerified: true }); // already verified: no row
      let r: Record<string, any>[] = [];
      for (let i = 0; i < 40 && !(r = await rows()).every((x) => x.outcome !== 'pending'); i++) await new Promise((ok) => setTimeout(ok, 25));
      assert.equal(r.length, 2);
      const rf = r.find((x) => x.specialistId === docF)!;
      assert.equal(rf.outcome, 'applied'); assert.equal(rf.verifiedBy, adminId); assert.equal(rf.fenced, true);
      assert.equal(rf.name, 'Dr Fence'); assert.equal(rf.medicalRegistrationNumber, 'R-1'); assert.equal(rf.degree, 'MBBS');
      assert.equal(r.find((x) => x.specialistId === docG)!.fenced, false);
    });

    await check('review 5a: the HR corporate overview lists verified, active doctors only', async () => {
      const corp = String((await CorporateModel.collection.insertOne({ name: 'HR Co', specialistIds: [ver, unv, ina], createdAt: new Date() } as never)).insertedId);
      const hr = Object.assign(Object.create(HRService.prototype), { hrRepository: new HRRepository() }) as HRService;
      const overview = await hr.getCorporateOverview(corp, {}) as unknown as { data: { specialists: { _id: unknown }[] } };
      assert.deepEqual(overview.data.specialists.map((x) => String(x._id)), [ver]);
    });

    await check('review 5b: a booking prescription PDF is readable only while the booking still names it (an admin clear withdraws it)', async () => {
      const current = ((await BookingModel.findById(bVer).lean())?.prescription?.fileUrls ?? [])[0]!;
      const rel = current.replace('/api/static/', '');
      const reader = (who: 'cust' | 'ver' | 'admin' | 'custB') => ({ cust: { _id: cust, userType: 'user' }, ver: { _id: ver, specialistId: ver, userType: 'specialist' },
        admin: { _id: adminId, userType: 'admin' }, custB: { _id: custB, userType: 'user' } })[who];
      const allowed = async (who: 'cust' | 'ver' | 'admin' | 'custB', path: string) => (await decideFileAccess(reader(who) as never, path)).allow;
      assert.equal(await allowed('cust', rel), true); assert.equal(await allowed('ver', rel), true); assert.equal(await allowed('custB', rel), false);
      const superseded = `bookings/${bVer}/prescription-1.pdf`; // an older PDF of the same booking, no longer named by it
      assert.equal(await allowed('cust', superseded), false);
      await expect('admin', 'DELETE', `/bookings/${bVer}/prescription`, 200, { reason: 'Review check' });
      assert.equal(await allowed('cust', rel), false); assert.equal(await allowed('ver', rel), false);
      assert.equal(await allowed('admin', rel), true);
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }

  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) { console.log('failed:\n- ' + failed.join('\n- ')); process.exit(1); }
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
