/**
 * S5c (stage line): a paid consultation whose doctor is no longer verified or active can always be closed with a full
 * refund. The doctor's own cancel passes the S5 guard (confirm / complete / no-show do not); after the start time the
 * customer's cancel is refused, so an admin closes it: POST /specialists/admin/bookings/:bookingId/close
 * {reason, requestKey, expectedUpdatedAt?} - a doctor cancellation by the admin (full refund, no window), once per
 * request key, audited in the same transaction. Controls: the clinic desk still marks arrival, completes and cancels an
 * appointment of such a doctor; verified doctors are unaffected.
 * S5d: the once-only index is built by sync-indexes (503 INDEXES_OUTDATED without it; one key for two bookings closes
 * one); the admin's reason stays internal (the patient sees a neutral notice; cause 'admin'); an ineligible doctor's
 * instant consultation read carries no patient age or gender.
 *
 * Run (throwaway DB only; the script drops its collections):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/s5c_stage_admin_close?directConnection=true' \
 *     npx tsx test/booking-scope/s5c-stage-admin-close.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { authenticate } from '@/modules/middleware/auth';
import { errorHandler } from '@/modules/middleware';
import UserModel from '@/modules/user/model';
import SpecialistModel from '@/modules/specialists/model';
import SlotModel from '@/modules/slots/model';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import { createBookingWithHolds } from '@/modules/bookings/holds';
import { BookingAdminCloseModel } from '@/modules/bookings/adminClose';
import { resetIndexChecks } from '@/modules/common/utils/requiredIndex';
import { InstantConsultService } from '@/modules/doctors/services/instant';
import { UserRepository } from '@/modules/user/repository';
import { SlotRepository } from '@/modules/slots/repository';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { SpecialistService } from '@/modules/specialists/services';
import { SpecialistPortalService } from '@/modules/specialistPortal/services';
import PaymentRecordModel from '@/modules/payment/model';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository } from '@/modules/wallet/repository';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import NotificationModel from '@/modules/notification/model';
import DependentModel from '@/modules/dependents/model';
import { DoctorReservationModel, DoctorScheduleGuardModel } from '@/modules/doctors/model/reservation';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import { SettlementAccountModel, LedgerEntryModel } from '@/modules/partners/model/settlement';
import { ScheduleGuardModel } from '@/modules/partners/model/slot';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { InvoiceRepository, InvoiceEventRepository, InvoiceCounterRepository } from '@/modules/partners/repository/invoice';
import { PartnerService, PartnerActor, adminActor } from '@/modules/partners/services';
import { InvoiceService } from '@/modules/partners/services/invoice';
import * as clinic from '@/modules/partners/services/clinic';
import { istDate, addDays } from '@/modules/partners/services/slots';
import { SMSService } from '@/modules/sms/services';
import { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/s5c_stage_admin_close?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const partnerRepo = new PartnerRepository();
const branchRepo = new BranchRepository();
const partnerSvc = new PartnerService(partnerRepo, new MemberRepository(), branchRepo);
Container.set(PartnerService, partnerSvc);
const sms = new SMSService();
sms.sendSMS = async () => ({ success: true, data: null });
Container.set(InvoiceService, new InvoiceService(new InvoiceRepository(), new InvoiceEventRepository(), new InvoiceCounterRepository(), partnerRepo, branchRepo,
  new CatalogueItemRepository(), sms));
const bookings = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), walletRepository: new WalletRepository(),
  bookingReminderScheduler: { clearBookingReminders: async () => undefined, scheduleBookingReminders: async () => undefined },
  notificationService: new Proxy({ create: async (n: { userId: string; title: string; message: string }) => { customerNotices.push(n); } },
    { get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : async () => undefined) }),
  userRepository: new UserRepository(), specialistRepository: new SpecialistRepository(), slotRepository: new SlotRepository(),
}) as BookingService;
Container.set(BookingService, bookings);
// tsx emits no decorator metadata: the doctor portal the specialist controller resolves is wired by hand.
const specialistService = { getById: async (id: string) => SpecialistModel.findById(id).lean() } as unknown as SpecialistService;
Container.set(SpecialistService, specialistService);
Container.set(SpecialistPortalService, Object.assign(Object.create(SpecialistPortalService.prototype), {
  bookingRepository: new BookingRepository(), userRepository: new UserRepository(), bookingService: bookings, specialistService,
  notificationService: new Proxy({}, { get: () => async () => undefined }), slotService: {}, slotRepository: new SlotRepository(),
}) as SpecialistPortalService);

/** Notices sent through notificationService.create (the patient's cancellation notice among them). */
const customerNotices: { userId: string; title: string; message: string }[] = [];
// The doctor's instant booking read only needs the models.
Container.set(InstantConsultService, Object.create(InstantConsultService.prototype) as InstantConsultService);

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); }
  catch (e) { failed.push(name); console.log('FAIL -', name); console.error('  ', (e as Error)?.message?.split('\n')[0] ?? e); }
}
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let ph = 7160000000;
const nextPhone = () => String(ph++);
let keySeq = 0;
const rk = (p = 's5c') => `${p}-s5c-key-${String(++keySeq).padStart(4, '0')}`;
const today = istDate(new Date());
const addr = { line1: '1 Road', city: 'Pune', state: 'Maharashtra', stateCode: '27', pincode: '411001' };
const clinicBranch = (name: string) => ({ name, phone: '9876500000', holidays: [], hours: {}, services: { homeCollection: false, inLab: false, inClinic: true }, address: addr }) as any;

async function doctor(name: string, over: Record<string, unknown> = {}) {
  const id = new Types.ObjectId();
  await SpecialistModel.collection.insertOne({ _id: id, name, phone: nextPhone(), specialization: 'General Physician', consultationFee: 600,
    isActive: true, isVerified: true, ...over } as never);
  return String(id);
}
const setDoctor = (id: string, set: Record<string, unknown>) => SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: set });
async function customer() {
  const u = await UserModel.create({ phone: nextPhone(), name: 'Asha', userType: 'user', otpVerified: true } as any);
  await WalletModel.create({ userId: String(u._id), balance: 0, isActive: true });
  return String(u._id);
}
const balance = async (u: string) => Number((await WalletModel.findOne({ userId: u }).lean())?.balance ?? 0);
async function slotAt(doctorId: string, start: Date, branchId?: string) {
  const ist = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString();
  const s = ist(start); const e = ist(new Date(start.getTime() + 30 * 60_000));
  const row = await SlotModel.create({ specialistId: doctorId, date: s.slice(0, 10).replace(/-/g, ''), startTime: s.slice(11, 16), endTime: e.slice(11, 16),
    duration: 30, slotType: 'consultation', maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true,
    ...(branchId ? { serviceModes: ['in-person'], branchId } : {}) } as any);
  return String(row._id);
}
let slotN = 0;
const futureStart = () => new Date(new Date(`${addDays(today, 2)}T08:00:00+05:30`).getTime() + (slotN++) * 30 * 60_000);

/**
 * A confirmed consultation paid ₹400 at the gateway (made while the doctor was eligible). `started`: its appointment
 * time is moved to an hour ago (slot and booking), so the customer's cancellation window has closed.
 */
async function paidConsultation(doctorId: string, started = false) {
  const userId = await customer();
  const slot = await SlotModel.findById(await slotAt(doctorId, futureStart())).lean() as any;
  const b = await createBookingWithHolds({ bookingType: 'consultation', userId, specialistId: doctorId, doctorName: 'Dr', slotId: String(slot._id),
    bookingDate: slot.date, bookingTime: slot.startTime, consultationMode: 'video', serviceMode: 'video', price: 400, originalPrice: 400,
    status: 'pending', paymentStatus: 'pending' } as any);
  const rec = await PaymentRecordModel.create({ userId, context: 'booking', contextId: String(b._id), baseAmount: 400, discountAmount: 0, finalAmount: 400,
    status: 'paid', isProcessed: true, razorpayOrderId: 'order_' + String(b._id) } as any);
  await BookingModel.updateOne({ _id: b._id }, { $set: { status: 'confirmed', paymentStatus: 'paid', paymentTransactionId: String(rec._id) } });
  if (started) {
    const ist = new Date(Date.now() - 60 * 60_000 + 330 * 60_000).toISOString();
    const set = { date: ist.slice(0, 10).replace(/-/g, ''), startTime: ist.slice(11, 16) };
    await SlotModel.updateOne({ _id: slot._id }, { $set: { ...set, endTime: new Date(Date.now() - 30 * 60_000 + 330 * 60_000).toISOString().slice(11, 16) } });
    await BookingModel.updateOne({ _id: b._id }, { $set: { bookingDate: set.date, bookingTime: set.startTime } });
  }
  return { id: String(b._id), userId, slotId: String(slot._id) };
}

async function main() {
  await mongoose.connect(FIXTURE_URL, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [UserModel, SpecialistModel, SlotModel, BookingModel, PaymentRecordModel, WalletModel, WalletTransactionModel, RequestKeyModel,
    NotificationModel, DependentModel, DoctorReservationModel, DoctorScheduleGuardModel, PartnerModel, MemberModel, BranchModel, PartnerAuditEventModel,
    SettlementAccountModel, LedgerEntryModel, ScheduleGuardModel] as mongoose.Model<any>[]) {
    await M.createCollection(); await M.createIndexes();
  }
  // bookingadmincloses is built only by the deploy step (npm run sync-indexes), as in production.
  execFileSync('npx', ['tsx', '--tsconfig', 'tsconfig.json', 'src1/scripts/syncIndexes.ts'],
    { env: { ...process.env, MONGODB_URL: FIXTURE_URL }, stdio: ['ignore', 'ignore', 'ignore'] });
  resetIndexChecks();
  const ADMIN = new Types.ObjectId().toHexString();
  clinic.setClinicNotifier(async () => undefined);

  const { default: specialistRouter } = await import('@/modules/specialists/routes');
  const { default: bookingRouter } = await import('@/modules/bookings/routes');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/specialists', authenticate, specialistRouter);
  app.use('/api/v1/bookings', authenticate, bookingRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, p: string, token: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const docTok = (id: string) => jwt.sign({ _id: id, specialistId: id, userType: 'specialist' }, CONFIG.JWT_SECRET_KEY);
  const userTok = (id: string) => jwt.sign({ _id: id, userType: 'user' }, CONFIG.JWT_SECRET_KEY);
  const adminTok = jwt.sign({ _id: ADMIN, userType: 'admin' }, CONFIG.JWT_SECRET_KEY);
  const close = (id: string, body: Record<string, unknown>, token = adminTok) => call('POST', `/specialists/admin/bookings/${id}/close`, token, body);

  try {
    await check('S5d: npm run sync-indexes builds the unique (adminId, requestKey) index of bookingadmincloses', async () => {
      const ix = await BookingAdminCloseModel.collection.listIndexes().toArray().catch(() => []);
      assert.ok(ix.some((i) => i.unique === true && JSON.stringify(i.key) === '{"adminId":1,"requestKey":1}'), JSON.stringify(ix.map((i) => i.key)));
    });

    await check('S5d: one request key sent for two bookings at once closes (and refunds) only one', async () => {
      const dr = await doctor('Dr Race');
      const b1 = await paidConsultation(dr); const b2 = await paidConsultation(dr);
      const key = rk('race');
      const [r1, r2] = await Promise.all([close(b1.id, { reason: 'Race', requestKey: key }), close(b2.id, { reason: 'Race', requestKey: key })]);
      assert.deepEqual([r1.status, r2.status].sort(), [200, 409], JSON.stringify([r1.json, r2.json]));
      assert.ok([r1.json.code, r2.json.code].includes('REQUEST_KEY_REUSED'));
      const states = await Promise.all([b1.id, b2.id].map(async (i) => (await BookingModel.findById(i).lean())!.status));
      assert.deepEqual(states.sort(), ['cancelled', 'confirmed']);
      assert.deepEqual((await Promise.all([b1.userId, b2.userId].map(balance))).sort(), [0, 400], 'one refund only');
      assert.equal(await BookingAdminCloseModel.countDocuments({ requestKey: key }), 1);
    });

    await check('S5d: without the unique index the admin close answers 503 INDEXES_OUTDATED and changes nothing', async () => {
      const dr = await doctor('Dr Index');
      const b = await paidConsultation(dr);
      await BookingAdminCloseModel.collection.dropIndex('adminId_1_requestKey_1');
      resetIndexChecks();
      const r = await close(b.id, { reason: 'Index', requestKey: rk() });
      assert.deepEqual([r.status, r.json.code], [503, 'INDEXES_OUTDATED']);
      assert.equal((await BookingModel.findById(b.id).lean())!.status, 'confirmed'); assert.equal(await balance(b.userId), 0);
      await BookingAdminCloseModel.createIndexes(); resetIndexChecks();
      assert.equal((await close(b.id, { reason: 'Index', requestKey: rk() })).status, 200);
    });

    await check('S5d: the admin\'s reason stays internal; the patient sees a neutral notice (refund line only when refunded); cause admin', async () => {
      const dr = await doctor('Dr Notice');
      const paid = await paidConsultation(dr);
      const free = await paidConsultation(dr);
      await BookingModel.updateOne({ _id: free.id }, { $set: { price: 0, originalPrice: 0 }, $unset: { paymentTransactionId: 1 } });
      await PaymentRecordModel.deleteMany({ contextId: free.id });
      customerNotices.length = 0;
      assert.equal((await close(paid.id, { reason: 'Internal: fake doctor account 123', requestKey: rk() })).status, 200);
      assert.equal((await close(free.id, { reason: 'Internal: fake doctor account 123', requestKey: rk() })).status, 200);
      for (const id of [paid.id, free.id]) {
        const b = await BookingModel.findById(id).lean() as any;
        assert.equal(b.cancellationReason, 'Cancelled by Jansetu'); assert.equal(b.cancellationCause, 'admin');
        assert.equal(JSON.stringify(b).includes('fake doctor'), false, 'the admin reason is not on the booking');
      }
      const notice = (u: string) => customerNotices.find((n) => n.userId === u)!;
      assert.equal(notice(paid.userId).message, 'Your consultation was cancelled by Jansetu. Your payment has been refunded to your Jansetu wallet.');
      assert.equal(notice(free.userId).message, 'Your consultation was cancelled by Jansetu.');
      assert.equal(JSON.stringify(customerNotices).includes('fake doctor'), false);
      assert.equal((await BookingAdminCloseModel.findOne({ bookingId: paid.id }).lean())!.reason, 'Internal: fake doctor account 123');
    });

    await check('S5d: an ineligible doctor reads its instant consultation without the patient\'s age or gender; a verified one sees them', async () => {
      const unvI = await doctor('Dr Instant Unv'); const verI = await doctor('Dr Instant Ok');
      const instant = async (dr: string) => {
        const reqId = new Types.ObjectId();
        await mongoose.connection.db!.collection('instant_requests').insertOne({ _id: reqId, userId: new Types.ObjectId().toHexString(),
          patient: { kind: 'self', name: 'Ravi', age: 41, gender: 'Male' }, acceptedFeeMinor: 50000 });
        const bid = new Types.ObjectId();
        await BookingModel.collection.insertOne({ _id: bid, bookingType: 'consultation', bookingKind: 'instant', specialistId: dr, instantRequestId: String(reqId),
          userId: new Types.ObjectId().toHexString(), status: 'confirmed', paymentStatus: 'paid', bookingDate: '20991231', bookingTime: '10:00',
          consultationMode: 'video', price: 500, updatedAt: new Date() } as never);
        return String(bid);
      };
      const bu = await instant(unvI); const bv = await instant(verI);
      await setDoctor(unvI, { isVerified: false });
      const ru = await call('GET', `/specialists/me/instant/bookings/${bu}`, docTok(unvI));
      assert.equal(ru.status, 200, JSON.stringify(ru.json));
      assert.equal(ru.json.data.status, 'confirmed'); assert.equal(ru.json.data.bookingId, bu);
      assert.equal(ru.json.data.patient?.age, undefined); assert.equal(ru.json.data.patient?.gender, undefined);
      const rv = await call('GET', `/specialists/me/instant/bookings/${bv}`, docTok(verI));
      assert.equal(rv.json.data.patient.age, 41); assert.equal(rv.json.data.patient.gender, 'Male');
    });

    await check('the stuck case: after its start time the customer cannot cancel and the unverified doctor cannot close it', async () => {
      const dr = await doctor('Dr Stuck');
      const b = await paidConsultation(dr, true);
      await setDoctor(dr, { isVerified: false });
      const c = await call('POST', `/bookings/${b.id}/cancel`, userTok(b.userId), { cancellationReason: 'Doctor gone' });
      assert.equal(c.status, 400, JSON.stringify(c.json)); assert.equal(c.json.code, 'BOOKING_ALREADY_STARTED');
      for (const status of ['confirmed', 'completed', 'no_show']) {
        const r = await call('PATCH', `/specialists/me/appointments/${b.id}/status`, docTok(dr), { status });
        assert.deepEqual([r.status, r.json.code], [403, 'SPECIALIST_NOT_VERIFIED'], status);
      }
      assert.equal((await BookingModel.findById(b.id).lean())!.status, 'confirmed');
    });

    await check('admin close: a started, paid consultation of an unverified doctor is cancelled with a full refund and audited', async () => {
      const dr = await doctor('Dr Close');
      const b = await paidConsultation(dr, true);
      const other = await paidConsultation(dr);
      await setDoctor(dr, { isVerified: false });
      const key = rk('close');
      const r = await close(b.id, { reason: 'Doctor account not verified', requestKey: key });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.data.replayed, false); assert.equal(r.json.data.refunded, 400);
      const after = await BookingModel.findById(b.id).lean() as any;
      assert.equal(after.status, 'cancelled'); assert.equal(after.paymentStatus, 'refunded');
      assert.equal(after.cancellationReason, 'Cancelled by Jansetu'); // S5d: the admin's reason is internal
      assert.equal(await balance(b.userId), 400, 'the patient has the full ₹400 back');
      assert.equal((await SlotModel.findById(b.slotId).lean() as any).currentBookings, 0, 'seat released');
      const rows = await BookingAdminCloseModel.find({ bookingId: b.id }).lean();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].adminId, ADMIN); assert.equal(rows[0].reason, 'Doctor account not verified'); assert.equal(rows[0].refunded, 400);
      assert.equal(rows[0].statusBefore, 'confirmed'); assert.equal(rows[0].paymentStatusBefore, 'paid'); assert.equal(rows[0].specialistId, dr);
      // The same request again: the same answer, nothing refunded twice.
      const again = await close(b.id, { reason: 'Doctor account not verified', requestKey: key });
      assert.equal(again.status, 200); assert.equal(again.json.data.replayed, true);
      assert.equal(await balance(b.userId), 400);
      assert.equal(await BookingAdminCloseModel.countDocuments({ bookingId: b.id }), 1);
      // The key for another booking, or another reason: refused.
      const reused = await close(other.id, { reason: 'Doctor account not verified', requestKey: key });
      assert.deepEqual([reused.status, reused.json.code], [409, 'REQUEST_KEY_REUSED']);
      assert.equal((await BookingModel.findById(other.id).lean())!.status, 'confirmed');
    });

    await check('admin close: admin only, reason and request key required, stale version and final bookings refused', async () => {
      const dr = await doctor('Dr Rules');
      const b = await paidConsultation(dr);
      for (const t of [docTok(dr), userTok(b.userId)]) assert.equal((await close(b.id, { reason: 'x reason', requestKey: rk() }, t)).status, 403);
      assert.equal((await close(b.id, { requestKey: rk() })).status, 400);
      assert.equal((await close(b.id, { reason: 'Doctor gone' })).status, 400);
      const stale = await close(b.id, { reason: 'Doctor gone', requestKey: rk(), expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
      assert.deepEqual([stale.status, stale.json.code], [409, 'BOOKING_CHANGED']);
      assert.equal((await BookingModel.findById(b.id).lean())!.status, 'confirmed');
      await call('POST', `/bookings/${b.id}/cancel`, userTok(b.userId), { cancellationReason: 'Changed my mind' });
      const done = await close(b.id, { reason: 'Doctor gone', requestKey: rk() });
      assert.deepEqual([done.status, done.json.code], [409, 'ALREADY_CANCELLED']);
      const completed = await paidConsultation(dr);
      await BookingModel.updateOne({ _id: completed.id }, { $set: { status: 'completed' } });
      assert.deepEqual([(await close(completed.id, { reason: 'Doctor gone', requestKey: rk() })).json.code], ['BOOKING_NOT_CANCELLABLE']);
      assert.equal(await BookingAdminCloseModel.countDocuments({ bookingId: { $in: [b.id, completed.id] } }), 0);
    });

    await check('control: the unverified doctor itself can still cancel (full refund), even after the start time', async () => {
      const dr = await doctor('Dr Self Cancel');
      const b = await paidConsultation(dr, true);
      await setDoctor(dr, { isVerified: false });
      const r = await call('PATCH', `/specialists/me/appointments/${b.id}/status`, docTok(dr), { status: 'cancelled', reason: 'Cannot attend' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal((await BookingModel.findById(b.id).lean())!.status, 'cancelled');
      assert.equal(await balance(b.userId), 400);
    });

    await check('control: the clinic desk still marks arrival, completes and cancels appointments of a doctor who became unverified', async () => {
      const { partner: cp, owner } = await partnerSvc.createPartner({ kind: 'clinic', name: 'Care Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'CC',
        firstOwner: { phone: nextPhone(), name: 'Owner' } } as any);
      const clinicId = String(cp._id);
      await partnerSvc.verifyPartner(clinicId, 'admin');
      const own = actorFor(owner);
      const A = String((await partnerSvc.createBranch(own, clinicBranch('Kothrud')))._id);
      const deskM = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk', role: 'staff', branchIds: [A], permissions: ['bookings.view', 'bookings.manage'] } as any);
      const desk = actorFor(deskM);
      const dr = await doctor('Dr Desk');
      await clinic.linkDoctor(adminActor(ADMIN, clinicId), { doctorId: dr, branchIds: [], requestKey: rk('link') });
      const book = async () => (await clinic.createDeskAppointment(desk, { slotId: await slotAt(dr, futureStart(), A), customer: { phone: nextPhone() }, requestKey: rk('desk') })).booking.bookingId;
      const one = await book(); const two = await book();
      await setDoctor(dr, { isVerified: false });
      await clinic.markArrived(desk, one);
      assert.ok((await BookingModel.findById(one).lean() as any).clinicDesk.arrivedAt, 'arrival recorded');
      await clinic.closeDeskAppointment(desk, one, 'completed', new Date(Date.now() + 3 * 86_400_000));
      assert.equal((await BookingModel.findById(one).lean())!.status, 'completed');
      await clinic.cancelDeskAppointment(desk, two, 'Doctor unavailable');
      assert.equal((await BookingModel.findById(two).lean())!.status, 'cancelled');
    });

    await check('control: a verified doctor is unaffected (confirm works; admin close also works for it)', async () => {
      const dr = await doctor('Dr Fine');
      const b = await paidConsultation(dr);
      const r = await call('PATCH', `/specialists/me/appointments/${b.id}/status`, docTok(dr), { status: 'confirmed' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const c = await close(b.id, { reason: 'Admin close', requestKey: rk() });
      assert.equal(c.status, 200); assert.equal(await balance(b.userId), 400);
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) { console.log('failed:\n- ' + failed.join('\n- ')); process.exit(1); }
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
