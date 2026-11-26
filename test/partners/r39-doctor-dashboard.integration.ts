/**
 * r39 (ASSISTED_BOOKING_DESIGN.md §26.23): the doctor's single dashboard (P2).
 * - GET /specialists/me/appointments/list: every source, filters, resolved source / clinic / channel, 31-day range.
 * - POST /specialists/me/clinic-appointments: the clinic desk's create at a clinic he consults at (his own slots only).
 * - POST /specialists/me/consultations: an online consultation (the patient pays in the app) or a free follow-up.
 * - /specialists/me/clinic/catalogue|invoices: the bill routes for the clinic he owns (no other clinic).
 * - GET /specialists/me/today (+ search), /specialists/me/todos (private), GET /specialists/me/finance `breakdown`.
 * Real routes over HTTP (configureRoutes) on MongoDB.
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r39_doctor_dashboard_check?directConnection=true' npx tsx test/partners/r39-doctor-dashboard.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { errorHandler } from '@/modules/middleware';
import UserModel from '@/modules/user/model';
import { UserRepository } from '@/modules/user/repository';
import SpecialistModel from '@/modules/specialists/model';
import { SpecialistRepository } from '@/modules/specialists/repository';
import SlotModel from '@/modules/slots/model';
import { SlotRepository } from '@/modules/slots/repository';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { PharmacyWalletRepository, PharmacyWalletTransactionRepository } from '@/modules/pharmacyWallet/repository';
import DependentModel from '@/modules/dependents/model';
import MemberModel from '@/modules/partners/model/member';
import PartnerOrgModel from '@/modules/partners/model';
import { InvoiceEventModel, InvoiceModel } from '@/modules/partners/model/invoice';
import { LedgerEntryModel } from '@/modules/partners/model/settlement';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { InvoiceCounterRepository, InvoiceEventRepository, InvoiceRepository } from '@/modules/partners/repository/invoice';
import { PartnerService, type PartnerActor } from '@/modules/partners/services';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { InvoiceService } from '@/modules/partners/services/invoice';
import { ensureSettlementAccount } from '@/modules/partners/services/settlement';
import { addDays, istDate } from '@/modules/partners/services/slots';
import * as clinic from '@/modules/partners/services/clinic';
import { AssistedAuditEventModel } from '@/modules/assisted/model';
import { setAssistedNotifier } from '@/modules/assisted/support';
import { TodoModel } from '@/modules/todos/model';
import { SMSService } from '@/modules/sms/services';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r39_doctor_dashboard_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const MIN = 60_000;
const noop = new Proxy({}, { get: () => async () => undefined });
const fakeRazorpay = {
  orders: {
    create: async (o: { amount: number; currency: string }) => ({ id: 'order_r39_' + oid(), amount: o.amount, currency: o.currency, status: 'created' }),
    fetchPayments: async () => ({ items: [] }),
  },
};
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), pharmacyWalletRepository: new PharmacyWalletRepository(),
  pharmacyWalletTransactionRepository: new PharmacyWalletTransactionRepository(), bookingReminderScheduler: noop,
  getRazorpayClient: () => fakeRazorpay, getRazorpayCredentials: () => ({ keyId: 'rzp_test_key', keySecret: 'secret' }),
}) as unknown as PaymentService;
/** r39b: makes the next free settlement fail (a create interrupted after its insert). */
const failSettlement = { next: false };
(payments as unknown as Record<string, unknown>).createDirectPaidBookingRecordIn = async function (this: unknown, ...a: unknown[]) {
  if (failSettlement.next) { failSettlement.next = false; throw new Error('payment record write failed'); }
  return (PaymentService.prototype as unknown as { createDirectPaidBookingRecordIn: (...x: unknown[]) => Promise<unknown> }).createDirectPaidBookingRecordIn.apply(this, a);
};
const bookingService = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), userRepository: new UserRepository(), slotRepository: new SlotRepository(),
  specialistRepository: new SpecialistRepository(), notificationService: noop, paymentService: payments, couponService: noop, emailService: {},
  bookingReminderScheduler: noop, sendPaidBookingEmailNotification: async () => undefined,
  specialistService: { getById: async (id: string) => SpecialistModel.findById(id).lean() },
  slotService: { getById: async (id: string) => SlotModel.findById(id).lean() },
}) as BookingService;
const partnerRepo = new PartnerRepository();
const branchRepo = new BranchRepository();
const partnerSvc = new PartnerService(partnerRepo, new MemberRepository(), branchRepo);
const sms = new SMSService();
sms.sendSMS = async () => ({ success: true, data: null });
Container.set(BookingService, bookingService);
Container.set(PaymentService, payments);
Container.set(PartnerService, partnerSvc);
Container.set(CatalogueService, new CatalogueService(new CatalogueItemRepository()));
Container.set(InvoiceService, new InvoiceService(new InvoiceRepository(), new InvoiceEventRepository(), new InvoiceCounterRepository(), partnerRepo, branchRepo,
  new CatalogueItemRepository(), sms));
setAssistedNotifier(async () => undefined);
clinic.setClinicNotifier(async () => undefined);

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
let ph = 7390000000;
const nextPhone = () => String(ph++);
let keySeq = 0;
const rk = (p = 'r39-key') => `${p}-${String(++keySeq).padStart(4, '0')}`;
const addr = { line1: '1 Road', city: 'Pune', state: 'Maharashtra', stateCode: '27', pincode: '411001' };
const clinicBranch = (name: string) => ({ name, phone: '9876500000', holidays: [], hours: {}, services: { homeCollection: false, inLab: false, inClinic: true }, address: addr }) as never;

async function doctor(name: string) {
  const id = new Types.ObjectId();
  await SpecialistModel.collection.insertOne({ _id: id, name, phone: nextPhone(), email: `${name.replace(/\W/g, '')}@x.test`, specialization: 'General Physician',
    consultationFee: 600, isActive: true, isVerified: true } as never);
  return String(id);
}
const today = istDate(new Date());
const T = addDays(today, 2);
const Tc = T.replace(/-/g, '');
let slotN = 0;
/** A 30-minute slot of the doctor on day T (India time); at a clinic branch (in person) or online (video). */
async function slot(doctorId: string, branchId?: string) {
  const start = new Date(new Date(`${T}T08:00:00+05:30`).getTime() + (slotN++) * 30 * MIN);
  const ist = (d: Date) => new Date(d.getTime() + 330 * MIN).toISOString();
  const s = ist(start); const e = ist(new Date(start.getTime() + 30 * MIN));
  const row = await SlotModel.create({ specialistId: doctorId, date: s.slice(0, 10).replace(/-/g, ''), startTime: s.slice(11, 16), endTime: e.slice(11, 16),
    duration: 30, slotType: 'consultation', maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true,
    serviceModes: branchId ? ['in-person'] : ['video', 'call'], ...(branchId ? { branchId } : {}) } as never);
  return String(row._id);
}

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  const { configureRoutes } = await import('@/routes');
  for (const name of mongoose.modelNames()) {
    const m = mongoose.model(name);
    await m.createCollection().catch(() => undefined);
    await m.syncIndexes();
  }
  const app = express();
  app.use(express.json());
  configureRoutes(app);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/specialists`;

  try {
    // ── Fixtures: doctor D (his own clinic S, linked to clinic C1), doctor E (linked to C1 only), clinic C2 (D is not linked) ──
    const D = await doctor('Dr Dash');
    const E = await doctor('Dr Other');
    const made = await clinic.createSoloPractice(D, { name: 'Dash Clinic', invoiceSeriesPrefix: 'DASH', branch: { name: 'Main', phone: '9876500001', address: addr },
      requestKey: rk('clinic') } as never) as any;
    const S = String(made.partner._id);
    const SB = String(made.branch._id);
    await partnerSvc.verifyPartner(S, 'admin');
    const mk = async (name: string, prefix: string) => {
      const { partner, owner } = await partnerSvc.createPartner({ kind: 'clinic', name, contactPhone: nextPhone(), invoiceSeriesPrefix: prefix,
        firstOwner: { phone: nextPhone(), name: `${name} Owner` } } as never);
      const id = String(partner._id);
      await partnerSvc.verifyPartner(id, 'admin');
      const own = { memberId: String(owner._id), partnerId: id, role: 'owner', permissions: [], branchIds: [] } as PartnerActor;
      const branch = String((await partnerSvc.createBranch(own, clinicBranch('Main')))._id);
      return { id, own, branch };
    };
    const C1 = await mk('City Care', 'CITY');
    const C2 = await mk('Far Clinic', 'FAR');
    for (const doc of [D, E]) {
      await MemberModel.create({ partnerId: C1.id, phone: nextPhone(), name: 'Doc', role: 'staff', permissions: [], branchIds: [C1.branch], doctorId: doc,
        doctorBranchIds: [C1.branch], isActive: true } as never);
    }
    const dMemberC1 = await MemberModel.findOne({ partnerId: C1.id, doctorId: D }).lean() as any;

    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const tokens: Record<string, string> = { D: sign({ _id: D, specialistId: D, userType: 'specialist' }), E: sign({ _id: E, specialistId: E, userType: 'specialist' }) };
    const call = async (who: string, method: string, url: string, body?: unknown) => {
      const r = await fetch(base + url, { method, headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any; try { json = JSON.parse(text); } catch { json = { text }; }
      return { status: r.status, json, text, headers: r.headers };
    };
    const expect = async (who: string, method: string, url: string, status: number, body?: unknown, code?: string) => {
      const r = await call(who, method, url, body);
      assert.equal(r.status, status, `${who} ${method} ${url}: ${r.status} ${r.text.slice(0, 500)}`);
      if (code) assert.equal(r.json.code, code, r.text.slice(0, 300));
      return r;
    };

    const X = new Types.ObjectId();
    await UserModel.collection.insertOne({ _id: X, userType: 'user', phone: '9855550001', name: 'Ravi Das' } as never);
    const at = (hm: string, d = T) => new Date(`${d}T${hm}:00+05:30`);
    const row = (x: Record<string, unknown>) => ({ bookingType: 'consultation', userId: String(X), specialistId: D, doctorName: 'Dr Dash', bookingDate: Tc,
      bookingTime: '09:00', consultationMode: 'video', status: 'confirmed', paymentStatus: 'paid', price: 600, createdAt: at('07:00', today),
      updatedAt: at('07:00', today), ...x });
    const ins = await BookingModel.collection.insertMany([
      row({ bookingTime: '09:00' }), // 0 the patient's own (no source)
      row({ bookingTime: '09:30', source: 'pharmacy_assisted', assisted: { shortRef: 'JS-PH01', bookedBy: { kind: 'pharmacy', id: oid(), name: 'Demo' },
        funding: { method: 'wallet', state: 'captured' } } }), // 1 a pharmacy's
      row({ bookingTime: '10:00', consultationMode: 'in-person', paymentStatus: 'pending', settlementSystem: 'clinic',
        clinicDesk: { partnerId: C1.id, branchId: C1.branch, createdBy: 'x', requestKey: 'desk:x:k1', requestHash: 'h' },
        clinicVisit: { partnerId: C1.id, branchId: C1.branch } }), // 2 C1's desk
      row({ bookingTime: '10:30', bookingKind: 'instant' }), // 3 the patient's instant
      row({ specialistId: E }), // 4 another doctor
      row({ source: 'lab_assisted', status: 'pending', assisted: { funding: { method: 'razorpay', state: 'pending' } } }), // 5 a card booking never confirmed
      row({ bookingTime: '11:00', source: 'self', consultationMode: 'in-person', clinicVisit: { partnerId: C2.id, branchId: C2.branch } }), // 6 at C2, paid online
      row({ bookingDate: addDays(T, 40).replace(/-/g, '') }), // 7 outside the range
    ] as never);
    const bIds = Object.values(ins.insertedIds).map(String);
    const listIds = (r: any) => r.json.data.map((x: any) => String(x._id));

    await check('one list: every source of his, resolved source / clinic / channel; filters; not another doctor\'s or an unconfirmed card booking', async () => {
      const all = await expect('D', 'GET', `/me/appointments/list?from=${T}&to=${T}`, 200);
      assert.deepEqual(listIds(all), [bIds[0], bIds[1], bIds[2], bIds[3], bIds[6]]);
      assert.equal(all.headers.get('cache-control'), 'private, no-store');
      const by = new Map(all.json.data.map((x: any) => [String(x._id), x]));
      const pick = (i: number) => { const x: any = by.get(bIds[i]!); return [x.source, x.channel, x.clinic]; };
      assert.deepEqual(pick(0), ['self', 'online', null]);
      assert.deepEqual(pick(1), ['pharmacy_assisted', 'online', null]);
      assert.deepEqual(pick(2), ['clinic_desk', 'clinic', { id: C1.id, name: 'City Care' }]);
      assert.deepEqual(pick(3), ['instant', 'online', null]);
      assert.deepEqual(pick(6), ['self', 'clinic', { id: C2.id, name: 'Far Clinic' }]);
      assert.equal((by.get(bIds[1]!) as any).price, undefined, 'a partner booking shows no partner money (the existing view)');
      assert.deepEqual(all.json.meta, { total: 5, truncated: false });
      const ids = async (q: string) => listIds(await expect('D', 'GET', `/me/appointments/list?from=${T}&to=${T}&${q}`, 200));
      assert.deepEqual(await ids('source=self'), [bIds[0], bIds[6]]);
      assert.deepEqual(await ids('source=instant'), [bIds[3]]);
      assert.deepEqual(await ids('source=clinic_desk'), [bIds[2]]);
      assert.deepEqual(await ids('source=pharmacy_assisted'), [bIds[1]]);
      assert.deepEqual(await ids('channel=clinic'), [bIds[2], bIds[6]]);
      assert.deepEqual(await ids('channel=online'), [bIds[0], bIds[1], bIds[3]]);
      assert.deepEqual(await ids(`clinicId=${C1.id}`), [bIds[2]]);
      assert.deepEqual(await ids('mode=in-person&status=confirmed'), [bIds[2], bIds[6]]);
      assert.deepEqual(listIds(await expect('E', 'GET', `/me/appointments/list?from=${T}`, 200)), [bIds[4]]);
      await expect('D', 'GET', `/me/appointments/list?from=${T}&to=${addDays(T, 31)}`, 400, undefined, 'RANGE_TOO_LONG');
      await expect('D', 'GET', `/me/appointments/list?from=${T}&to=${addDays(T, -1)}`, 400, undefined, 'INVALID_DATE');
      await expect('D', 'GET', '/me/appointments/list?source=desk', 400, undefined, 'VALIDATION_ERROR');
    });

    await check('a clinic appointment: the clinic desk\'s booking at a clinic he consults at, in its reception list; his own slots only; counted once', async () => {
      const sl = await slot(D, C1.branch);
      const lookups = () => AssistedAuditEventModel.countDocuments({ action: 'patient.lookup', orgKind: 'doctor', orgId: D });
      const before = await lookups();
      const body = { clinicId: C1.id, branchId: C1.branch, slotId: sl, customer: { phone: '9877770001', name: 'Meera' }, patient: { name: 'Little Meera', relation: 'Daughter' },
        requestKey: rk() };
      const r = await expect('D', 'POST', '/me/clinic-appointments', 201, body);
      assert.equal(r.json.data.replayed, false);
      assert.equal(r.json.data.patient.name, 'Little Meera');
      const b = await BookingModel.findById(r.json.data.booking.bookingId).lean() as any;
      assert.deepEqual([b.clinicDesk.partnerId, b.clinicDesk.createdBy, b.settlementSystem, b.consultationMode, String(b.specialistId)],
        [C1.id, String(dMemberC1._id), 'clinic', 'in-person', D]);
      const reception = await clinic.listClinicAppointments(C1.own, { from: T, to: T });
      assert.equal(reception.find((x: any) => x.bookingId === String(b._id))?.source, 'desk', 'the clinic\'s reception sees it as its desk appointment');
      assert.equal(await lookups(), before + 1);
      const again = await expect('D', 'POST', '/me/clinic-appointments', 200, body);
      assert.deepEqual([again.json.data.replayed, again.json.data.booking.bookingId], [true, String(b._id)]);
      assert.equal(await lookups(), before + 1, 'a resend of a recorded key is not counted');
      const list = await expect('D', 'GET', `/me/appointments/list?from=${T}&source=clinic_desk&clinicId=${C1.id}`, 200);
      assert.ok(listIds(list).includes(String(b._id)), 'and in his own list');
      // Another doctor's slot at the same clinic, a slot not at the named branch, a clinic he is not linked to.
      await expect('D', 'POST', '/me/clinic-appointments', 409, { ...body, slotId: await slot(E, C1.branch), requestKey: rk() }, 'SLOT_NOT_AVAILABLE');
      await expect('D', 'POST', '/me/clinic-appointments', 409, { ...body, slotId: await slot(D, C1.branch), branchId: C2.branch, requestKey: rk() }, 'SLOT_NOT_AVAILABLE');
      await expect('D', 'POST', '/me/clinic-appointments', 404, { ...body, clinicId: C2.id, slotId: await slot(D, C1.branch), requestKey: rk() }, 'CLINIC_NOT_FOUND');
      // His own clinic (owner) works the same way.
      const own = await expect('D', 'POST', '/me/clinic-appointments', 201, { clinicId: S, slotId: await slot(D, SB), customer: { phone: '9877770002' }, requestKey: rk() });
      assert.equal((await BookingModel.findById(own.json.data.booking.bookingId).lean() as any).clinicDesk.partnerId, S);
      // The counted lookup (not behind the lab-booking switch).
      const look = await expect('D', 'POST', '/me/patients/lookup', 200, { phone: '9877770001' });
      assert.deepEqual([look.json.data.exists, typeof look.json.data.holderNameMasked], [true, 'string']);
    });

    await check('an online consultation for his patient: the patient\'s own booking (doctor_assisted), paid by the patient in the app; exactly once', async () => {
      const sl = await slot(D);
      const body = { slotId: sl, mode: 'video', customer: { phone: '9877770003', name: 'Kiran' }, requestKey: rk() };
      const r = await expect('D', 'POST', '/me/consultations', 201, body);
      const d = r.json.data;
      assert.deepEqual([d.booking.source, d.booking.status, d.booking.paymentStatus, d.booking.fee, d.booking.consultationMode, d.replayed],
        ['doctor_assisted', 'pending', 'pending', 600, 'video', false]);
      assert.deepEqual([d.payment.by, d.payment.required, typeof d.payment.payBy], ['patient_app', true, 'string']);
      const b = await BookingModel.findById(d.booking.bookingId).lean() as any;
      const u = await UserModel.findById(b.userId).lean() as any;
      assert.deepEqual([u.phone, u.name, b.source, String(b.specialistId), b.settlementSystem === 'clinic'], ['9877770003', 'Kiran', 'doctor_assisted', D, false]);
      assert.equal(await PaymentRecordModel.countDocuments({ contextId: String(b._id), userId: String(b.userId) }), 1, 'the patient\'s order to pay in the app');
      const again = await expect('D', 'POST', '/me/consultations', 200, body);
      assert.deepEqual([again.json.data.replayed, again.json.data.booking.bookingId], [true, String(b._id)]);
      await expect('D', 'POST', '/me/consultations', 409, { ...body, slotId: await slot(D) }, 'IDEMPOTENCY_KEY_REUSED');
      // r39b: the key is looked up per patient account (the unique { userId, createRequestKey } index): another phone is
      // another patient's request — here refused by the taken slot, and its new family member is not created (the
      // family member is created inside the booking's transaction).
      await expect('D', 'POST', '/me/consultations', 400, { ...body, customer: { phone: '9877770009' }, patient: { name: 'New Kid', relation: 'Son' } },
        'SLOT_NOT_AVAILABLE');
      assert.equal(await DependentModel.countDocuments({ name: 'New Kid' }), 0, 'no family member without its booking');
      const fam = await expect('D', 'POST', '/me/consultations', 201, { ...body, slotId: await slot(D), patient: { name: 'Baby Kiran', relation: 'Daughter' },
        requestKey: rk() });
      const dep = await DependentModel.findOne({ name: 'Baby Kiran' }).lean() as any;
      assert.deepEqual([fam.json.data.booking.dependentId, String(dep?.userId)], [String(dep?._id), String(b.userId)], 'made with its booking');
      await expect('D', 'POST', '/me/consultations', 400, { ...body, mode: 'in-person', requestKey: rk() }, 'USE_CLINIC_APPOINTMENT');
      await expect('D', 'POST', '/me/consultations', 409, { ...body, slotId: await slot(E), requestKey: rk() }, 'SLOT_NOT_AVAILABLE');
      await expect('D', 'POST', '/me/consultations', 400, { slotId: sl, mode: 'video', requestKey: rk() }, 'VALIDATION_ERROR');
      const list = await expect('D', 'GET', `/me/appointments/list?from=${T}&source=doctor_assisted`, 200);
      assert.deepEqual(listIds(list).sort(), [String(b._id), fam.json.data.booking.bookingId].sort());
    });

    await check('a follow-up: the existing free follow-up of a consultation of his (benefit used once); another doctor\'s consultation is 404', async () => {
      const parent = await BookingModel.collection.insertOne(row({ bookingDate: today.replace(/-/g, ''), status: 'completed', dependentId: undefined,
        followUp: { isFollowUp: false, benefitUsed: false, completedAt: today.replace(/-/g, ''), eligibilityExpiresAt: addDays(today, 14).replace(/-/g, '') } }) as never);
      const P = String(parent.insertedId);
      // r39b: the create is interrupted after its insert (its free settlement fails); the resend finishes it.
      const fb = { slotId: await slot(D), mode: 'call', followUpOf: P, requestKey: rk() };
      failSettlement.next = true;
      await expect('D', 'POST', '/me/consultations', 500, fb);
      const half = await BookingModel.findOne({ createRequestKey: `doctor:${D}:${fb.requestKey}` }).lean() as any;
      assert.deepEqual([half.status, half.paymentStatus], ['pending', 'pending'], 'inserted, not settled');
      const r = await expect('D', 'POST', '/me/consultations', 200, fb);
      const d = r.json.data;
      assert.deepEqual([d.replayed, d.booking.bookingId], [true, String(half._id)]);
      assert.deepEqual([d.booking.fee, d.booking.status, d.booking.paymentStatus, d.booking.followUpOf, d.payment.required], [0, 'confirmed', 'paid', P, false]);
      const b = await BookingModel.findById(d.booking.bookingId).lean() as any;
      assert.deepEqual([String(b.userId), b.source, b.followUp.isFollowUp], [String(X), 'doctor_assisted', true]);
      assert.equal((await BookingModel.findById(P).lean() as any).followUp.benefitUsed, true);
      await expect('D', 'POST', '/me/consultations', 400, { slotId: await slot(D), mode: 'call', followUpOf: P, requestKey: rk() }, 'FOLLOW_UP_ALREADY_USED');
      await expect('E', 'POST', '/me/consultations', 404, { slotId: await slot(E), mode: 'call', followUpOf: P, requestKey: rk() }, 'BOOKING_NOT_FOUND');
      await expect('D', 'POST', '/me/consultations', 400, { slotId: await slot(D), mode: 'call', followUpOf: P, customer: { phone: '9877770001' }, requestKey: rk() },
        'VALIDATION_ERROR');
    });

    let billIds: string[] = [];
    await check('the doctor bills only the clinic he owns: its catalogue and bills under /me/clinic; a doctor who owns none gets 404', async () => {
      const item = await expect('D', 'POST', '/me/clinic/catalogue', 201, { kind: 'consultation', name: 'Consultation', priceMinor: 50_000, gstRate: 0, requestKey: rk() });
      const itemRow = item.json.data;
      assert.equal(String(itemRow.partnerId ?? itemRow.item?.partnerId), S);
      const billBody = (name: string, price: number, branchId = SB) => ({ branchId, customer: { name, phone: '9822223333' },
        items: [{ description: 'Consultation', qty: 1, unitPriceMinor: price, gstRate: 0 }], idempotencyKey: rk('bill') });
      const b0 = (await expect('D', 'POST', '/me/clinic/invoices', 201, billBody('Ravi Das', 50_000))).json.data;
      await expect('D', 'POST', `/me/clinic/invoices/${b0._id}/pay`, 200, { splits: [{ mode: 'cash', amountMinor: 30_000 }, { mode: 'upi', amountMinor: 20_000 }] });
      const b1 = (await expect('D', 'POST', '/me/clinic/invoices', 201, billBody('Unpaid Usha', 20_000))).json.data;
      const b2 = await Container.get(InvoiceService).createInvoice(C1.own, billBody('City Patient', 10_000, C1.branch) as never);
      billIds = [String(b0._id), String(b1._id), String(b2._id)];
      assert.deepEqual([b0.partnerId, b2.partnerId], [S, C1.id]);
      const list = await expect('D', 'GET', '/me/clinic/invoices', 200);
      const ids = (list.json.data.items ?? list.json.data).map((x: any) => String(x._id));
      assert.deepEqual(ids.sort(), [billIds[0], billIds[1]].sort(), 'his own clinic\'s bills only');
      await expect('D', 'GET', `/me/clinic/invoices/${billIds[0]}`, 200);
      await expect('D', 'GET', `/me/clinic/invoices/${billIds[2]}`, 404);
      await expect('E', 'GET', '/me/clinic/invoices', 404, undefined, 'CLINIC_NOT_FOUND');
      await expect('E', 'GET', '/me/clinic/catalogue', 404, undefined, 'CLINIC_NOT_FOUND');
      // r39b: his clinic not yet verified (403), suspended (404, as a clinic he does not have), or several owned (409).
      const own = async (name: string, prefix: string, doc: string) => (await clinic.createSoloPractice(doc, { name, invoiceSeriesPrefix: prefix,
        branch: { name: 'Main', phone: '9876500002', address: addr }, requestKey: rk('clinic') } as never) as any).partner;
      const F = await doctor('Dr Pending'); const G = await doctor('Dr Suspended'); const H = await doctor('Dr Two Clinics');
      Object.assign(tokens, Object.fromEntries([['F', F], ['G', G], ['H', H]].map(([k, id]) => [k, sign({ _id: id, specialistId: id, userType: 'specialist' })])));
      await own('Pending Care', 'PEND', F);
      const gp = await own('Shut Care', 'SHUT', G);
      await partnerSvc.verifyPartner(String(gp._id), 'admin');
      await PartnerOrgModel.updateOne({ _id: gp._id }, { $set: { isActive: false } });
      for (const c of [C1, C2]) {
        await MemberModel.create({ partnerId: c.id, phone: nextPhone(), name: 'Dr Two', role: 'owner', permissions: [], branchIds: [], doctorId: H, isActive: true } as never);
      }
      await expect('F', 'GET', '/me/clinic/invoices', 403, undefined, 'PARTNER_NOT_VERIFIED');
      await expect('G', 'GET', '/me/clinic/invoices', 404, undefined, 'CLINIC_NOT_FOUND');
      await expect('H', 'POST', '/me/clinic/invoices', 409, billBody('Someone', 1_000), 'CLINIC_CHOICE_REQUIRED');
      // The existing /me/clinic reads are untouched.
      await expect('D', 'GET', '/me/clinic', 200);
    });

    await check('Today: his appointments of the day (every source), his own clinic\'s bills and money, what he earned; waiting work; search', async () => {
      const acct = await ensureSettlementAccount('doctor', D, 'Dr Dash');
      await LedgerEntryModel.collection.insertMany([
        { settlementAccountId: String(acct._id), kind: 'earning', amountMinor: 60_000, grossMinor: 60_000, commissionMinor: 0, source: 'consultation', sourceId: bIds[0],
          at: new Date(), by: 'system', byKind: 'system' },
        { settlementAccountId: String(acct._id), kind: 'earning', amountMinor: 1_000, grossMinor: 1_000, commissionMinor: 0, source: 'consultation', sourceId: bIds[6],
          at: at('12:00', addDays(T, -1)), by: 'system', byKind: 'system' },
      ] as never);
      await PartnerLabBookingModel.collection.insertOne({ partnerId: C2.id, branchId: C2.branch, userId: String(X), visitMode: 'lab', status: 'report_ready', statusVersion: 0,
        paymentStatus: 'paid', pricing: { payableMinor: 40_000 }, items: [{ name: 'CBC', kind: 'test' }], slot: { date: T }, patient: { kind: 'self', name: 'Ravi Das' },
        source: 'doctor_assisted', assisted: { shortRef: 'JS-DR01', bookedBy: { kind: 'doctor', id: D, name: 'Dr Dash' }, funding: { method: 'wallet', state: 'captured' } },
        report: { draftFiles: [], releasedFiles: ['x'], releases: [{ path: 'x', releasedAt: new Date(), releasedBy: 'm', signer: { memberId: 'm', name: 'S', registrationNumber: 'R' } }] },
        lifecycle: { paidAt: new Date() }, createdAt: new Date(), updatedAt: new Date() } as never);
      const r = await expect('D', 'GET', `/me/today?date=${T}`, 200);
      const appts = r.json.data.items.filter((x: any) => x.kind === 'appointment');
      assert.deepEqual(r.json.data.items.map((x: any) => x.kind).filter((k: string) => k !== 'appointment'), [], 'on day T: his appointments only');
      assert.ok(!appts.some((x: any) => x.id === bIds[4] || x.id === bIds[5]), 'not another doctor\'s, not an unconfirmed card booking');
      const desk = appts.find((x: any) => x.id === bIds[2]);
      assert.deepEqual([desk.source, desk.channel, desk.clinic, desk.patientName, desk.link], ['clinic_desk', 'clinic', { id: C1.id, name: 'City Care' }, 'Ravi Das',
        { kind: 'booking', id: bIds[2] }]);
      const data = (await expect('D', 'GET', `/me/today?date=${today}`, 200)).json.data;
      const kinds = data.items.map((x: any) => x.kind);
      assert.ok(kinds.includes('bill') && kinds.includes('lab_booking'), kinds.join(','));
      assert.equal(data.items.some((x: any) => x.kind === 'bill' && x.id === billIds[2]), false, 'never another clinic\'s bill');
      assert.deepEqual([data.totals.collectedMinor, data.totals.byMethod.cash, data.totals.byMethod.upi, data.totals.unpaidMinor, data.totals.earnedMinor],
        [50_000, 30_000, 20_000, 20_000, 60_000], 'his clinic\'s money in that day; appointments and lab tests are not counted; earned = that day\'s ledger');
      assert.equal(data.pending.reportsReady.count, 1);
      assert.equal(data.pending.unpaidBills.count, 1);
      assert.ok(data.pending.appointmentsToConfirm.count >= 1 && typeof data.pending.prescriptionsToWrite.count === 'number');
      const s = await expect('D', 'POST', '/me/today/search', 200, { date: today, q: 'usha' });
      assert.deepEqual(s.json.data.items.map((x: any) => x.id), [billIds[1]]);
      const s2 = await expect('D', 'POST', '/me/today/search', 200, { date: T, q: '98555' });
      assert.ok(s2.json.data.items.length >= 1 && s2.json.data.items.every((x: any) => x.kind !== 'bill'), 'the account holder\'s phone');
      // Another doctor: none of his.
      const e = await expect('E', 'GET', `/me/today?date=${T}`, 200);
      assert.ok(e.json.data.items.map((x: any) => x.id).includes(bIds[4]) && !e.json.data.items.some((x: any) => bIds.slice(0, 4).includes(x.id)));
      assert.equal(e.json.data.pending.unpaidBills, undefined, 'no clinic of his own: no bills queue');
    });

    await check('to-dos: private to the doctor (owner kind doctor)', async () => {
      const t = await expect('D', 'POST', '/me/todos', 201, { text: 'Call lab about CBC', requestKey: rk() });
      assert.deepEqual([t.json.data.todo?.createdBy?.kind ?? t.json.data.createdBy?.kind], ['doctor']);
      const id = t.json.data.todo?._id ?? t.json.data._id;
      assert.equal((await expect('D', 'GET', '/me/todos', 200)).json.data.length, 1);
      assert.equal((await expect('E', 'GET', '/me/todos', 200)).json.data.length, 0);
      await expect('E', 'PATCH', `/me/todos/${id}`, 404, { done: true, expectedVersion: 0 });
      assert.equal(await TodoModel.countDocuments({ 'owner.kind': 'doctor', 'owner.id': D }), 1);
    });

    await check('finance: one combined breakdown from his ledger (clinic by clinic, online, partner, referral) with filters', async () => {
      const acct = await ensureSettlementAccount('doctor', D, 'Dr Dash');
      await LedgerEntryModel.collection.insertMany([
        { settlementAccountId: String(acct._id), kind: 'earning', amountMinor: 50_000, grossMinor: 50_000, commissionMinor: 0, source: 'consultation', sourceId: bIds[1],
          at: at('12:00'), by: 'system', byKind: 'system' },
        { settlementAccountId: String(acct._id), kind: 'reversal', amountMinor: -60_000, grossMinor: -60_000, commissionMinor: 0, source: 'consultation', sourceId: bIds[0],
          at: at('13:00'), by: 'system', byKind: 'system' },
        { settlementAccountId: String(acct._id), kind: 'earning', amountMinor: 2_000, grossMinor: 2_000, commissionMinor: 0, source: 'referral_lab_booking', sourceId: oid(),
          at: at('12:00'), by: 'system', byKind: 'system' },
        { settlementAccountId: String(acct._id), kind: 'payout', amountMinor: -10_000, grossMinor: -10_000, commissionMinor: 0, source: 'payout', sourceId: oid(),
          at: at('14:00'), by: 'admin', byKind: 'admin' },
      ] as never);
      assert.equal('breakdown' in (await expect('D', 'GET', '/me/finance', 200)).json.data, false, 'r39b: only when asked');
      const f = await expect('D', 'GET', '/me/finance?breakdown=1', 200);
      const b = f.json.data.breakdown;
      assert.deepEqual([b.online.earnedMinor, b.online.reversedMinor, b.online.netMinor, b.online.count], [60_000, 60_000, 0, 1]);
      assert.deepEqual([b.partner.netMinor, b.referral.netMinor], [50_000, 2_000]);
      assert.deepEqual(b.clinics, [{ clinicId: C2.id, name: 'Far Clinic', earnedMinor: 1_000, reversedMinor: 0, netMinor: 1_000, count: 1 }]);
      assert.equal(b.totals.netMinor, 53_000, 'payouts are not earnings');
      assert.equal(f.json.data.balanceMinor, 43_000, 'the summary is unchanged');
      const c = (await expect('D', 'GET', `/me/finance?breakdown=1&channel=clinic&clinicId=${C2.id}`, 200)).json.data.breakdown;
      assert.deepEqual([c.totals.netMinor, c.online.netMinor, c.clinics.length], [1_000, 0, 1]);
      const day = (await expect('D', 'GET', `/me/finance?breakdown=1&from=${T}&to=${T}`, 200)).json.data.breakdown;
      assert.deepEqual([day.totals.netMinor, day.clinics.length], [-8_000, 0]);
      assert.equal((await expect('E', 'GET', '/me/finance?breakdown=1', 200)).json.data.breakdown.totals.netMinor, 0);
    });

    void DependentModel;
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) { console.log('Failed:\n - ' + failed.join('\n - ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
