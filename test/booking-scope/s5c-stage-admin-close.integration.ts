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
 * S5e: an ineligible doctor's instant accept replay (meeting link) and extend are refused; the close answers from its
 * committed audit row; admins read a booking's closes (reason included); the clinic-paid notice.
 * S5f: an ineligible doctor's cancel commands (portal status, generic cancel) answer the reduced view; a duplicate key
 * from another index is passed on, never answered "already cancelled".
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

    /** An accepted instant consultation of `dr` (request accepted by it, booking with a meeting link). */
    const acceptedInstant = async (dr: string) => {
      const reqId = new Types.ObjectId(); const bid = new Types.ObjectId();
      await mongoose.connection.db!.collection('instant_requests').insertOne({ _id: reqId, userId: new Types.ObjectId().toHexString(),
        patient: { kind: 'self', name: 'Meera', age: 33, gender: 'Female' }, status: 'accepted', acceptedBy: dr, bookingId: String(bid),
        offeredTo: [dr], acceptedFeeMinor: 50000, specialization: 'General Physician', mode: 'video' });
      await BookingModel.collection.insertOne({ _id: bid, bookingType: 'consultation', bookingKind: 'instant', specialistId: dr, instantRequestId: String(reqId),
        userId: new Types.ObjectId().toHexString(), status: 'confirmed', paymentStatus: 'paid', bookingDate: '20991231', bookingTime: '10:00',
        consultationMode: 'video', contactNo: '9123456789', primaryConcern: 'Fever and cough',
        virtualMeeting: { provider: 'google_meet', status: 'active', joinUrl: 'https://meet.google.com/s5e-secret' }, price: 500, updatedAt: new Date() } as never);
      return { requestId: String(reqId), bookingId: String(bid) };
    };

    await check('S5e (M1): an ineligible doctor\'s accept replay is refused (403) and carries no meeting link or patient details', async () => {
      const unvA = await doctor('Dr Accept Unv'); const verA = await doctor('Dr Accept Ok');
      const u = await acceptedInstant(unvA); const v = await acceptedInstant(verA);
      await setDoctor(unvA, { isVerified: false });
      const r = await call('POST', `/specialists/me/instant/${u.requestId}/accept`, docTok(unvA));
      assert.deepEqual([r.status, r.json.code], [403, 'SPECIALIST_NOT_VERIFIED'], JSON.stringify(r.json).slice(0, 200));
      for (const secret of ['s5e-secret', '9123456789', 'Fever and cough', 'Meera']) assert.equal(JSON.stringify(r.json).includes(secret), false, secret);
      // Control: a verified doctor's lost answer is still recovered with its booking.
      const ok = await call('POST', `/specialists/me/instant/${v.requestId}/accept`, docTok(verA));
      assert.equal(ok.status, 200, JSON.stringify(ok.json).slice(0, 200)); assert.equal(ok.json.data.replayed, true);
      assert.equal(ok.json.data.booking.virtualMeeting.joinUrl, 'https://meet.google.com/s5e-secret');
    });

    await check('S5e (L1): an ineligible doctor cannot extend an instant consultation (403); the hold is unchanged', async () => {
      const unvE = await doctor('Dr Extend Unv');
      const u = await acceptedInstant(unvE);
      await setDoctor(unvE, { isActive: false });
      const r = await call('POST', `/specialists/me/instant/bookings/${u.bookingId}/extend`, docTok(unvE), { minutes: 10, requestKey: rk('ext') });
      assert.deepEqual([r.status, r.json.code], [403, 'SPECIALIST_NOT_VERIFIED'], JSON.stringify(r.json).slice(0, 200));
      assert.equal(((await BookingModel.findById(u.bookingId).lean()) as any).instantExtensions, undefined);
    });

    await check('S5e (L2): the close answers from the committed audit row, never from flags of an aborted attempt', async () => {
      const dr = await doctor('Dr Retry');
      const b = await paidConsultation(dr);
      // An attempt that wrote its audit row and then aborted (a retried transaction), while the patient cancelled.
      const real = bookings.cancelByDoctor;
      (bookings as any).cancelByDoctor = async (id: string, _r: unknown, _reason: string, opts: any) => {
        const session = await mongoose.startSession();
        session.startTransaction();
        await opts.inTx(await BookingModel.findById(id).lean(), session, 400);
        await session.abortTransaction(); await session.endSession();
        await BookingModel.updateOne({ _id: id }, { $set: { status: 'cancelled' } });
        return BookingModel.findById(id).lean();
      };
      try {
        const r = await close(b.id, { reason: 'Retry', requestKey: rk('retry') });
        assert.deepEqual([r.status, r.json.code], [409, 'ALREADY_CANCELLED'], JSON.stringify(r.json).slice(0, 200));
      } finally { (bookings as any).cancelByDoctor = real; }
      assert.equal(await BookingAdminCloseModel.countDocuments({ bookingId: b.id }), 0);
    });

    await check('S5e (L3): admins (only) read a booking\'s closes with the internal reason; the close answer carries it too', async () => {
      const dr = await doctor('Dr Audit Read');
      const b = await paidConsultation(dr);
      const r = await close(b.id, { reason: 'Internal: duplicate account', requestKey: rk('aud') });
      assert.equal(r.status, 200); assert.equal(r.json.data.close.reason, 'Internal: duplicate account'); assert.equal(r.json.data.close.refunded, 400);
      const list = await call('GET', `/specialists/admin/bookings/${b.id}/close`, adminTok);
      assert.equal(list.status, 200); assert.equal(list.json.data.length, 1);
      assert.equal(list.json.data[0].reason, 'Internal: duplicate account'); assert.equal(list.json.data[0].adminId, ADMIN);
      for (const t of [docTok(dr), userTok(b.userId)]) assert.equal((await call('GET', `/specialists/admin/bookings/${b.id}/close`, t)).status, 403);
      // The patient's and the doctor's booking reads never show it.
      const mine = await call('GET', `/bookings/${b.id}`, userTok(b.userId));
      assert.equal(mine.status, 200); assert.equal(JSON.stringify(mine.json).includes('duplicate account'), false);
      const docRead = await call('GET', `/specialists/me/appointments/${b.id}`, docTok(dr));
      assert.equal(JSON.stringify(docRead.json).includes('duplicate account'), false);
    });

    await check('S5e (L4): closing a clinic-paid desk appointment tells the patient to contact the clinic, with no refund claim', async () => {
      const { partner: cp, owner } = await partnerSvc.createPartner({ kind: 'clinic', name: 'Desk Notice Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'DN',
        firstOwner: { phone: nextPhone(), name: 'Owner' } } as any);
      await partnerSvc.verifyPartner(String(cp._id), 'admin');
      const own = actorFor(owner);
      const A = String((await partnerSvc.createBranch(own, clinicBranch('Baner')))._id);
      const deskM = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk', role: 'staff', branchIds: [A], permissions: ['bookings.view', 'bookings.manage'] } as any);
      const dr = await doctor('Dr Desk Notice');
      await clinic.linkDoctor(adminActor(ADMIN, String(cp._id)), { doctorId: dr, branchIds: [], requestKey: rk('link') });
      const made = await clinic.createDeskAppointment(actorFor(deskM), { slotId: await slotAt(dr, futureStart(), A), customer: { phone: nextPhone() }, requestKey: rk('desk') });
      const id = String(made.booking.bookingId);
      const userId = String((await BookingModel.findById(id).lean())!.userId);
      customerNotices.length = 0;
      const r = await close(id, { reason: 'Internal: clinic doctor removed', requestKey: rk() });
      assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 200)); assert.equal(r.json.data.refunded, 0);
      const n = customerNotices.find((x) => x.userId === userId)!;
      assert.equal(n.message, 'Your consultation was cancelled by Jansetu. Contact the clinic about anything you paid there.');
    });

    await check('S5f (N1): an ineligible doctor\'s cancel commands answer no patient details (already-cancelled booking, both routes)', async () => {
      const dr = await doctor('Dr Cancel Read'); const ok = await doctor('Dr Cancel Ok');
      const priv = { contactNo: '9123456789', alternateContactNo: '9123456780', primaryConcern: 'Chest pain at night', notes: 'private note',
        documents: [{ type: 'report', url: '/api/static/general/s5f.pdf', fileName: 'scan.pdf' }],
        virtualMeeting: { provider: 'google_meet', status: 'active', joinUrl: 'https://meet.google.com/s5f-secret' } };
      const b = await paidConsultation(dr); const v = await paidConsultation(ok);
      await BookingModel.updateMany({ _id: { $in: [b.id, v.id] } }, { $set: priv });
      await call('POST', `/bookings/${b.id}/cancel`, userTok(b.userId), { cancellationReason: 'Patient cancelled' });
      await call('POST', `/bookings/${v.id}/cancel`, userTok(v.userId), { cancellationReason: 'Patient cancelled' });
      await setDoctor(dr, { isVerified: false });
      const secrets = ['9123456789', '9123456780', 'Chest pain', 'private note', 's5f.pdf', 's5f-secret'];
      const leak = (j: unknown) => secrets.filter((x) => JSON.stringify(j).includes(x));
      const viaPortal = await call('PATCH', `/specialists/me/appointments/${b.id}/status`, docTok(dr), { status: 'cancelled' });
      assert.equal(viaPortal.status, 200, JSON.stringify(viaPortal.json).slice(0, 200));
      assert.deepEqual(leak(viaPortal.json), []); assert.equal(viaPortal.json.data.status, 'cancelled');
      const viaBookings = await call('POST', `/bookings/${b.id}/cancel`, docTok(dr), { cancellationReason: 'again' });
      assert.equal(viaBookings.status, 200, JSON.stringify(viaBookings.json).slice(0, 200));
      assert.deepEqual(leak(viaBookings.json), []); assert.equal(viaBookings.json.data.status, 'cancelled');
      // Control: a verified doctor's answer is unchanged.
      const full = await call('PATCH', `/specialists/me/appointments/${v.id}/status`, docTok(ok), { status: 'cancelled' });
      assert.equal(full.status, 200); assert.equal(full.json.data.contactNo, '9123456789');
    });

    await check('S5f (L2a): a duplicate key from another index is not answered "already cancelled"; the booking is unchanged', async () => {
      const dr = await doctor('Dr Dup Key');
      const b = await paidConsultation(dr);
      const real = bookings.cancelByDoctor;
      (bookings as any).cancelByDoctor = async () => {
        throw Object.assign(new Error('E11000 duplicate key error collection: wallettransactions index: operationKey_1'), { code: 11000,
          keyPattern: { operationKey: 1 } });
      };
      try {
        const r = await close(b.id, { reason: 'Dup', requestKey: rk('dup') });
        assert.notEqual(r.json.code, 'ALREADY_CANCELLED', JSON.stringify(r.json).slice(0, 200));
        assert.notEqual(r.status, 200);
      } finally { (bookings as any).cancelByDoctor = real; }
      const after = await BookingModel.findById(b.id).lean() as any;
      assert.equal(after.status, 'confirmed'); assert.equal(await balance(b.userId), 0);
      // Retried once the cause is gone: the close goes through.
      assert.equal((await close(b.id, { reason: 'Dup', requestKey: rk('dup2') })).status, 200);
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
