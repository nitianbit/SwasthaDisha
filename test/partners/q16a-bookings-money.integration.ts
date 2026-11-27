/**
 * Q16a: pre-production review fixes in bookings, money and scheduling — provider-borne coupons in ledger earnings,
 * instant "any available" frozen fees and coupons on the fee charged, started-appointment fences (reschedule, completion,
 * booking a started slot), no-show grace, moved no-shows billed once and cancelled by admins only, canonical doctor ids,
 * per-row sweeps, invoice tax halves and refund printing, cutover parsing, reminders in both time formats, clinic
 * holidays, manual slot closures, instant discovery busy window, desk fixes, backfill reports and the admin read of
 * unmarked consultations. Real MongoDB replica set.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed), so the suite can be run against the
 * code before Q16a to see each check fail.
 *
 * Run (throwaway DB only; the script drops its collections):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q16a_bookings_money_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx test/partners/q16a-bookings-money.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
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
import { BookingReminderScheduler } from '@/modules/bookings/services/bookingReminderScheduler';
import { createBookingWithHolds, rescheduleWithHolds } from '@/modules/bookings/holds';
import { publicNoShowView } from '@/modules/bookings/utils/noShowView';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { CouponModel } from '@/modules/coupon/model';
import { CouponService } from '@/modules/coupon/services';
import { CouponRepository } from '@/modules/coupon/repository';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import NotificationModel from '@/modules/notification/model';
import DependentModel from '@/modules/dependents/model';
import TaskQueue from '@/modules/queue/service/TaskQueue';
import { SlotRepository } from '@/modules/slots/repository';
import { SlotService, bookableQuery } from '@/modules/slots/services';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { DoctorReservationModel, DoctorScheduleGuardModel } from '@/modules/doctors/model/reservation';
import { DoctorScheduleTemplateModel } from '@/modules/doctors/model/schedule';
import { DoctorPresenceModel, InstantRequestModel } from '@/modules/doctors/model/instant';
import { reserveInterval } from '@/modules/doctors/services/reservations';
import { InstantConsultService, registerInstantPayments } from '@/modules/doctors/services/instant';
import { runInstantSweeps } from '@/modules/doctors/services/schedulers';
import { saveTemplate, setLeave, expandDoctorSlots } from '@/modules/doctors/services/schedule';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import { ClinicDoctorInviteModel } from '@/modules/partners/model/clinicDoctor';
import { SettlementAccountModel, LedgerEntryModel, LedgerHistoryRefModel } from '@/modules/partners/model/settlement';
import { PartnerSlotModel, PartnerSlotTemplateModel, ScheduleGuardModel } from '@/modules/partners/model/slot';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { PartnerService, PartnerActor, adminActor } from '@/modules/partners/services';
import { ensureSettlementAccount } from '@/modules/partners/services/settlement';
import { computeTotals } from '@/modules/partners/services/invoice';
import { renderInvoiceHtml } from '@/modules/partners/services/invoicePdf';
import { parseSettlementCutover, checkSettlementCutoverConfig, settlementSystemFor } from '@/modules/partners/services/cutover';
import { LabBookingService } from '@/modules/partners/services/labBookings';
import { saveSlotTemplate, istDate, addDays } from '@/modules/partners/services/slots';
import * as clinic from '@/modules/partners/services/clinic';
import { adminUnmarkedConsultations, adminLegacyRecalculations } from '@/modules/partners/services/finance';
import { runDoctorIdCaseAudit } from '@/scripts/q16aDoctorIdCaseAudit';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { PayoutService } from '@/modules/payouts/services';
import { PayoutBillingModel, PayoutDisbursalModel } from '@/modules/payouts/model';
import { runSettlementCutover } from '@/scripts/q3SettlementCutover';
import { runReservationBackfill } from '@/scripts/q4ReservationBackfill';
import { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q16a_bookings_money_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

// ── Services (no gateway: instant requests are wallet-funded) ──
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(),
  getRazorpayClient: () => ({ orders: { fetchPayments: async () => ({ items: [] }) } }), getRazorpayCredentials: () => ({ keyId: 'k', keySecret: 's' }),
}) as unknown as PaymentService;
const instant = new InstantConsultService(payments, new CouponService(new CouponRepository()), new WalletRepository());
instant.notify = async () => undefined;
Container.set(InstantConsultService, instant);
registerInstantPayments(() => instant);
const partnerRepo = new PartnerRepository();
const partnerSvc = new PartnerService(partnerRepo, new MemberRepository(), new BranchRepository());
Container.set(PartnerService, partnerSvc);
const notices: { userId: string; key?: string; message?: string }[] = [];
const bookings = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), walletRepository: new WalletRepository(),
  bookingReminderScheduler: { clearBookingReminders: async () => undefined, scheduleBookingReminders: async () => undefined },
  notificationService: {
    create: async (n: { userId: string; idempotencyKey?: string; message?: string }) => { notices.push({ userId: n.userId, key: n.idempotencyKey, message: n.message }); },
    createSpecialistAppointmentCancelledNotification: async () => undefined,
  },
  slotService: Object.assign(Object.create(SlotService.prototype), { slotRepository: new SlotRepository() }),
}) as BookingService;
Container.set(BookingService, bookings);
const slotSvc = Object.assign(Object.create(SlotService.prototype), { slotRepository: new SlotRepository() }) as SlotService;
const labSvc = Object.create(LabBookingService.prototype) as LabBookingService;
(labSvc as any).notify = async () => undefined;
(labSvc as any).walletRepository = new WalletRepository();

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('ok -', name); }
  catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
const code = (c: string) => (e: any) => { if (e?.code !== c) throw e; return true; };
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let ph = 7160000000;
const nextPhone = () => String(ph++);
let keySeq = 0;
const rk = (p = 'q16a-key') => `${p}-${String(++keySeq).padStart(4, '0')}`;
const today = istDate(new Date());
const ymd = (iso: string) => iso.replace(/-/g, '');
const MIN = 60_000;
const DAY = 86_400_000;
const addr = { line1: '1 Road', city: 'Pune', state: 'Maharashtra', stateCode: '27', pincode: '411001' };
const clinicBranch = (name: string) => ({ name, phone: '9876500000', holidays: [], hours: {}, services: { homeCollection: false, inLab: false, inClinic: true }, address: addr }) as any;
const ist = (d: Date) => new Date(d.getTime() + 330 * MIN).toISOString();
const balance = async (u: string) => Number((await WalletModel.findOne({ userId: u }).lean())!.balance);

async function doctor(name: string, over: Record<string, unknown> = {}) {
  const id = new Types.ObjectId();
  await SpecialistModel.collection.insertOne({ _id: id, name, phone: nextPhone(), email: `${name.replace(/\W/g, '')}${ph}@x.test`, specialization: 'General Physician',
    consultationFee: 500, isActive: true, isVerified: true, rating: 4, ...over } as never);
  return String(id);
}
async function customer(wallet = 0) {
  const u = await UserModel.create({ phone: nextPhone(), name: 'Asha', userType: 'user', otpVerified: true } as any);
  await WalletModel.create({ userId: String(u._id), balance: wallet, isActive: true });
  return { id: String(u._id), phone: (u as any).phone as string };
}
/** A 30-minute slot of the doctor starting at `start` (India time, HH:mm); at a clinic branch when given. */
async function slotAt(doctorId: string, start: Date, over: Record<string, unknown> = {}) {
  const s = ist(start);
  const e = ist(new Date(start.getTime() + 30 * MIN));
  const row = await SlotModel.create({ specialistId: doctorId, date: s.slice(0, 10).replace(/-/g, ''), startTime: s.slice(11, 16), endTime: e.slice(11, 16),
    duration: 30, slotType: 'consultation', maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true, ...over } as any);
  return String(row._id);
}
let slotN = 0;
const futureStart = () => new Date(new Date(`${addDays(today, 3)}T07:00:00+05:30`).getTime() + (slotN++) * 30 * MIN);
async function paidBooking(userId: string, doctorId: string, over: Record<string, unknown> = {}, start = futureStart()) {
  const slotId = await slotAt(doctorId, start);
  const s = await SlotModel.findById(slotId).lean() as any;
  const b = await createBookingWithHolds({ bookingType: 'consultation', userId, specialistId: doctorId, doctorName: 'Dr', slotId, bookingDate: s.date,
    bookingTime: s.startTime, consultationMode: 'video', serviceMode: 'video', price: 400, originalPrice: 500, status: 'pending', paymentStatus: 'pending',
    ...over } as any);
  await BookingModel.updateOne({ _id: b._id }, { $set: { status: 'confirmed', paymentStatus: 'paid' } });
  return String(b._id);
}
/** Moves a stored booking's appointment to `start` (as if time had passed), keeping its slot. */
async function setAppointment(id: string, start: Date) {
  const s = ist(start);
  await BookingModel.updateOne({ _id: id }, { $set: { bookingDate: s.slice(0, 10).replace(/-/g, ''), bookingTime: s.slice(11, 16) } });
}
const earnings = (sourceId: string) => LedgerEntryModel.find({ sourceId, kind: 'earning' }).lean();

async function main() {
  await mongoose.connect(FIXTURE_URL, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [UserModel, SpecialistModel, SlotModel, BookingModel, PaymentRecordModel, WalletModel, WalletTransactionModel, CouponModel, RequestKeyModel,
    NotificationModel, DependentModel, DoctorReservationModel, DoctorScheduleGuardModel, DoctorScheduleTemplateModel, DoctorPresenceModel, InstantRequestModel,
    PartnerModel, MemberModel, BranchModel, PartnerAuditEventModel, ClinicDoctorInviteModel, SettlementAccountModel, LedgerEntryModel, LedgerHistoryRefModel,
    PartnerSlotModel, PartnerSlotTemplateModel, ScheduleGuardModel, PartnerLabBookingModel, PayoutBillingModel, PayoutDisbursalModel] as mongoose.Model<any>[]) {
    await M.createCollection(); await M.createIndexes();
  }
  const ADMIN = new Types.ObjectId().toHexString();
  const clinicNotices: clinic.ClinicNotice[] = [];
  clinic.setClinicNotifier(async (n) => { clinicNotices.push(n); });

  // ───────────────────────────── Money: provider-borne coupons ─────────────────────────────
  (CONFIG as any).SETTLEMENT_CUTOVER_AT = new Date(Date.now() - MIN).toISOString();
  const drM = await doctor('Dr Money');

  await check('coupon borne by the doctor: a ledger consultation earns its price AFTER the coupon (never originalPrice)', async () => {
    const u = await customer();
    const id = await paidBooking(u.id, drM, { price: 400, originalPrice: 500 });
    await bookings.update(id, { status: 'completed' } as any, undefined, new Date(Date.now() + 10 * DAY));
    assert.deepEqual((await earnings(id)).map((e) => e.amountMinor), [40000]);
  });

  // ───────────────────────────── Item 4: no completion before the start ─────────────────────────────
  await check('completion before the appointment starts is refused (409 NOT_STARTED_YET) for doctor and admin writers; no earning', async () => {
    const u = await customer();
    const id = await paidBooking(u.id, drM);
    await assert.rejects(() => bookings.update(id, { status: 'completed' } as any), code('NOT_STARTED_YET'));
    assert.equal((await earnings(id)).length, 0);
    assert.equal((await BookingModel.findById(id).lean())!.status, 'confirmed');
    await setAppointment(id, new Date(Date.now() - MIN));
    await bookings.update(id, { status: 'completed' } as any);
    assert.equal((await earnings(id)).length, 1);
  });

  // ───────────────────────────── Item 2: no customer move after the start ─────────────────────────────
  await check('a customer cannot reschedule once the appointment has started (so no move-then-cancel around a no-show)', async () => {
    const u = await customer();
    const id = await paidBooking(u.id, drM);
    await setAppointment(id, new Date(Date.now() - 5 * MIN));
    const target = await slotAt(drM, futureStart());
    await assert.rejects(() => bookings.rescheduleBooking(id, { slotId: target }, { _id: u.id, userType: 'user' }), code('BOOKING_ALREADY_STARTED'));
    assert.equal((await SlotModel.findById(target).lean() as any).currentBookings, 0, 'nothing taken');
    // An admin may still move it; a future appointment the customer may move as before.
    const id2 = await paidBooking(u.id, drM);
    const moved = await bookings.rescheduleBooking(id2, { slotId: await slotAt(drM, futureStart()) }, { _id: u.id, userType: 'user' });
    assert.equal(moved.status, 'confirmed');
  });

  await check('refund rule: a move made AFTER the refund deadline keeps that closed window; a move made while it was open is judged on the current time', async () => {
    // Inside the no-refund window (10 h away): the move is allowed, the booking stays non-refundable afterwards.
    const u = await customer();
    const soon = new Date(Date.now() + 10 * 3_600_000);
    const id = await paidBooking(u.id, drM, {}, soon);
    const before = await BookingModel.findById(id).lean();
    await BookingModel.updateOne({ _id: id }, { $set: { walletFunding: { total: 400, revision: 1, closed: false, captures: [] } } });
    const moved = await bookings.rescheduleBooking(id, { slotId: await slotAt(drM, new Date(Date.now() + 6 * DAY)) }, { _id: u.id, userType: 'user' });
    assert.deepEqual(moved.originalAppointment, { bookingDate: before!.bookingDate, bookingTime: before!.bookingTime });
    assert.deepEqual([moved.refundLock?.bookingDate, moved.refundLock?.bookingTime], [before!.bookingDate, before!.bookingTime], 'moved after the deadline: locked');
    await assert.rejects(() => bookings.cancelBooking(id, { cancellationReason: 'x' }, { _id: u.id, userType: 'user' }),
      (e: any) => { code('CANCELLATION_WINDOW_CLOSED')(e); assert.match(e.message, /rescheduled after its cancellation window/); return true; });
    // A second move keeps the first original time.
    const again = await bookings.rescheduleBooking(id, { slotId: await slotAt(drM, new Date(Date.now() + 7 * DAY)) }, { _id: u.id, userType: 'user' });
    assert.deepEqual(again.originalAppointment, moved.originalAppointment);
    await assert.rejects(() => bookings.cancelBooking(id, { cancellationReason: 'x' }, { _id: u.id, userType: 'user' }), code('CANCELLATION_WINDOW_CLOSED'));
    // Doctor (and admin) cancellations are unchanged: a full refund.
    await bookings.cancelByDoctor(id, { _id: drM, userType: 'specialist' }, 'Unavailable');
    assert.equal(await balance(u.id), 400);
    // Moved while the window was still open: still refundable while both windows are open.
    const u2 = await customer();
    const id2 = await paidBooking(u2.id, drM, {}, new Date(Date.now() + 5 * DAY));
    await BookingModel.updateOne({ _id: id2 }, { $set: { walletFunding: { total: 400, revision: 1, closed: false, captures: [] } } });
    const open = await bookings.rescheduleBooking(id2, { slotId: await slotAt(drM, new Date(Date.now() + 6 * DAY + 3_600_000)) }, { _id: u2.id, userType: 'user' });
    assert.equal(open.refundLock, undefined, 'moved while the window was open: nothing locked');
    // Later the ORIGINAL time's deadline passes (simulated on the stored history): the booking is still judged on its
    // current time alone, so the refund stays available.
    await BookingModel.updateOne({ _id: id2 }, { $set: { originalAppointment: { bookingDate: ymd(today), bookingTime: '00:01' } } });
    await bookings.cancelBooking(id2, { cancellationReason: 'x' }, { _id: u2.id, userType: 'user' });
    assert.equal(await balance(u2.id), 400);
    // An admin move does not record an original time.
    const id3 = await paidBooking(u2.id, drM);
    const admMoved = await bookings.rescheduleBooking(id3, { slotId: await slotAt(drM, futureStart()) }, { _id: ADMIN, userType: 'admin' });
    assert.equal(admMoved.originalAppointment, undefined);
  });

  await check('re-review A: a coupon taken at pay-again becomes the booking price (wallet-covered and gateway capture), so the earning follows it', async () => {
    await CouponModel.create({ code: 'RETRY100', discountType: 'fixed', discountValue: 100, applicableTo: 'all', eligibleFor: 'all',
      startDate: '20200101', endDate: '20991231', currentUsageCount: 0, isActive: true } as any);
    const payStub = {
      reconcileBookingPayments: async () => ({ checked: 0, unknown: 0 }), resumableOrder: async () => null,
      createOrder: async (d: any) => {
        const rec = await PaymentRecordModel.create({ userId: d.userId, context: 'booking', contextId: d.contextId, baseAmount: d.baseAmount, discountAmount: d.discountAmount,
          finalAmount: d.finalAmount, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_' + new Types.ObjectId().toHexString(), status: 'created',
          couponCode: d.couponCode, notes: d.notes });
        return { paymentRecord: rec.toObject(), razorpayOrder: { id: rec.razorpayOrderId, currency: 'INR' }, razorpayKeyId: 'k' };
      },
      createDirectPaidBookingRecordIn: (d: any, s: any, id: any) => (payments as any).createDirectPaidBookingRecordIn(d, s, id),
    };
    const retrySvc = Object.assign(Object.create(BookingService.prototype), {
      bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
      paymentService: payStub, couponService: new CouponService(new CouponRepository()), slotRepository: new SlotRepository(),
      bookingReminderScheduler: { scheduleBookingReminders: async () => undefined, clearBookingReminders: async () => undefined },
      sendPaidBookingEmailNotification: async () => undefined, notificationService: { create: async () => undefined },
    }) as BookingService;
    const unpaid = async (userId: string) => {
      const slotId = await slotAt(drM, futureStart(), { serviceModes: ['in-person'] });
      const sl = await SlotModel.findById(slotId).lean() as any;
      return String((await createBookingWithHolds({ bookingType: 'consultation', userId, specialistId: drM, doctorName: 'Dr', slotId, bookingDate: sl.date, bookingTime: sl.startTime,
        consultationMode: 'in-person', serviceMode: 'in-person', price: 500, originalPrice: 500, status: 'pending', paymentStatus: 'pending' } as any))._id);
    };
    // Wallet-covered: settled directly.
    const u = await customer(1000);
    const id = await unpaid(u.id);
    await retrySvc.retryBookingPayment(id, { _id: u.id, userType: 'user' }, { couponCode: 'RETRY100', useWalletBalance: true } as any);
    const row = await BookingModel.findById(id).lean();
    assert.deepEqual([row!.paymentStatus, row!.price, row!.originalPrice, await balance(u.id)], ['paid', 400, 500, 600]);
    await setAppointment(id, new Date(Date.now() - MIN));
    await bookings.update(id, { status: 'completed' } as any);
    assert.deepEqual((await earnings(id)).map((e) => e.amountMinor), [40000], 'the earning follows what was charged');
    // Gateway: the winning capture writes the record's terms.
    const u2 = await customer(0);
    const id2 = await unpaid(u2.id);
    const r = await retrySvc.retryBookingPayment(id2, { _id: u2.id, userType: 'user' }, { couponCode: 'RETRY100' } as any) as any;
    assert.equal(r.paymentRequired, true);
    const rec = await PaymentRecordModel.findById(r.payment.paymentTransactionId).lean();
    const capSvc = Object.assign(Object.create(PaymentService.prototype), { bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(),
      walletRepository: new WalletRepository(), bookingReminderScheduler: { scheduleBookingReminders: async () => undefined },
      sendPaidBookingEmailNotification: async () => undefined, finalizePaymentProcessing: async (x: unknown) => x,
      userRepository: {}, specialistRepository: {}, slotRepository: new SlotRepository() });
    await (capSvc as any).processBookingPayment({ ...rec, status: 'paid' }).catch(() => undefined); // follow-up work may fail here
    const row2 = await BookingModel.findById(id2).lean();
    assert.deepEqual([row2!.paymentStatus, row2!.price, row2!.originalPrice], ['paid', 400, 500]);
  });

  // ───────────────────────────── M1: started slots and the no-show grace ─────────────────────────────
  await check('a slot that has started cannot be booked (India time), nor listed; the no-show grace is 15 minutes', async () => {
    const u = await customer();
    const started = await slotAt(drM, new Date(Date.now() - 5 * MIN));
    const startedDate = (await SlotModel.findById(started).lean() as any).date;
    await assert.rejects(() => createBookingWithHolds({ bookingType: 'consultation', userId: u.id, specialistId: drM, slotId: started,
      bookingDate: startedDate, bookingTime: 'x', consultationMode: 'video', price: 500, status: 'pending',
      paymentStatus: 'pending' } as any), code('SLOT_STARTED'));
    await assert.rejects(() => (bookings as any).validateBookingDateAndSlot(startedDate, started), code('SLOT_STARTED'));
    const future = await slotAt(drM, new Date(Date.now() + 2 * 3_600_000));
    const listed = (await slotSvc.getAvailableSlots(drM)).map((s) => String(s._id));
    assert.ok(!listed.includes(started) && listed.includes(future), 'started hidden, future listed');
    assert.ok(!(await slotSvc.getBySpecialistId(drM)).some((s) => String(s._id) === started));
    // No-show: 10 minutes after the start is too early, 16 minutes is fine.
    const id = await paidBooking(u.id, drM);
    const start = new Date(Date.now() - 10 * MIN);
    await setAppointment(id, start);
    await assert.rejects(() => bookings.markNoShow(id, { _id: drM, userType: 'specialist' }, new Date(start.getTime() + 10 * MIN)), code('APPOINTMENT_NOT_STARTED'));
    assert.equal((await bookings.markNoShow(id, { _id: drM, userType: 'specialist' }, new Date(start.getTime() + 16 * MIN))).status, 'no_show');
  });

  await check('weekly expansion never creates a slot of today that already started', async () => {
    const d = await doctor('Dr Expand');
    const win = [{ start: '00:00', end: '23:30', modes: ['video'] }];
    await saveTemplate(d, { slotMinutes: 30, days: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((x) => [x, win])) as any });
    const rows = await SlotModel.find({ specialistId: d, date: ymd(today) }).lean() as any[];
    const nowHHMM = ist(new Date()).slice(11, 16);
    assert.ok(rows.length > 0 || nowHHMM >= '23:00', 'later slots of today exist');
    assert.ok(rows.every((r) => r.startTime > nowHHMM), `no started slot of today: ${rows.filter((r) => r.startTime <= nowHHMM).map((r) => r.startTime)}`);
  });

  await check('re-review N1: a started multi-seat window stays bookable and listed until it ENDS; a one-patient slot is refused from its start', async () => {
    const d = await doctor('Dr Session');
    const u = await customer();
    const session = await slotAt(d, new Date(Date.now() - 10 * MIN), { maxBookings: 5 });
    const row = await SlotModel.findById(session).lean() as any;
    const b = await createBookingWithHolds({ bookingType: 'consultation', userId: u.id, specialistId: d, slotId: session, bookingDate: row.date, bookingTime: 'x',
      consultationMode: 'video', serviceMode: 'video', price: 500, status: 'pending', paymentStatus: 'pending' } as any);
    assert.ok(b._id);
    assert.ok((await slotSvc.getAvailableSlots(d)).some((x) => String(x._id) === session), 'listed until its end');
    const ended = await slotAt(d, new Date(Date.now() - 40 * MIN), { maxBookings: 5 });
    const er = await SlotModel.findById(ended).lean() as any;
    await assert.rejects(() => createBookingWithHolds({ bookingType: 'consultation', userId: u.id, specialistId: d, slotId: ended, bookingDate: er.date, bookingTime: 'x',
      consultationMode: 'video', serviceMode: 'video', price: 500, status: 'pending', paymentStatus: 'pending' } as any), code('SLOT_STARTED'));
  });

  await check('midnight (28 Nov): a session that started before 00:00 India time stays bookable and listed until it ends; a one-patient slot does not (clock pinned at 00:05)', async () => {
    const d = await doctor('Dr Midnight');
    const X = addDays(today, 5);
    const before = addDays(X, -1);
    const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:30`);
    const session = await slotAt(d, at(before, '23:50'), { maxBookings: 5 }); // 23:50–00:20, across midnight
    const single = await slotAt(d, at(before, '23:50')); // a one-patient slot at the same time
    const ended = await slotAt(d, at(before, '23:00'), { maxBookings: 5 }); // 23:00–23:30
    const older = await slotAt(d, at(addDays(X, -2), '23:50'), { maxBookings: 5 });
    const later = await slotAt(d, at(X, '10:00'));
    const now = at(X, '00:05');
    const listed = (await slotSvc.getAvailableSlots(d, undefined, undefined, undefined, now)).map((s) => String(s._id));
    assert.deepEqual([session, single, ended, older, later].map((id) => listed.includes(id)), [true, false, false, false, true], 'listed');
    const paged = (await SlotModel.find({ specialistId: d, isActive: true, isAvailable: true, ...(await bookableQuery({ specialistId: d }, now)) }).lean())
      .map((s: any) => String(s._id));
    assert.deepEqual([session, single, ended, older, later].map((id) => paged.includes(id)), [true, false, false, false, true], 'paged query');
    const date = (id: string) => SlotModel.findById(id).lean().then((x: any) => x.date);
    await (bookings as any).validateBookingDateAndSlot(await date(session), session, undefined, now);
    const singleDate = await date(single);
    await assert.rejects(() => (bookings as any).validateBookingDateAndSlot(singleDate, single, undefined, now), code('SLOT_STARTED'));
    await assert.rejects(() => (bookings as any).validateBookingDateAndSlot(ymd(before), ended, undefined, now), code('SLOT_STARTED'));
    await assert.rejects(() => (bookings as any).validateBookingDateAndSlot(ymd(addDays(X, -2)), older, undefined, now), code('INVALID_BOOKING_DATE'));
    // Before midnight the session is listed too; after it ends (00:21) it is not.
    assert.ok((await slotSvc.getAvailableSlots(d, undefined, undefined, undefined, at(before, '23:55'))).some((s) => String(s._id) === session));
    assert.ok(!(await slotSvc.getAvailableSlots(d, undefined, undefined, undefined, at(X, '00:21'))).some((s) => String(s._id) === session));
  });

  await check('re-review N2: cancelling the booking of a slot switched off by hand gives the seat back but keeps the slot closed', async () => {
    const d = await doctor('Dr Release');
    const u = await customer();
    const id = await paidBooking(u.id, d);
    const slotId = (await BookingModel.findById(id).lean())!.slotId!;
    await slotSvc.update(slotId, { isAvailable: false });
    await bookings.cancelByDoctor(id, { _id: d, userType: 'specialist' }, 'x');
    const s = await SlotModel.findById(slotId).lean() as any;
    assert.deepEqual([s.currentBookings, s.isAvailable, s.manuallyClosed], [0, false, true]);
  });

  await check('re-review N3: paged slot lists filter availability in the query (exact totals, no empty pages); staff can still read a past range', async () => {
    const d = await doctor('Dr Paged');
    const yesterday = addDays(today, -1);
    for (const h of ['09:00', '10:00', '11:00']) await slotAt(d, new Date(`${yesterday}T${h}:00+05:30`));
    const f1 = await slotAt(d, futureStart());
    const f2 = await slotAt(d, futureStart());
    const p1 = await slotSvc.getAll({ specialistId: d, page: 1, limit: 2 });
    assert.deepEqual([p1.total, p1.data.map((x) => String(x._id)).sort()], [2, [f1, f2].sort()]);
    const staff = await slotSvc.getAll({ specialistId: d, page: 1, limit: 10, dateFrom: ymd(yesterday), staffView: true });
    assert.equal(staff.total, 5, 'an admin/doctor reading an explicit range sees the past slots');
    const cust = await slotSvc.getAll({ specialistId: d, page: 1, limit: 10, dateFrom: ymd(yesterday) });
    assert.equal(cust.total, 2, 'customers never see them');
  });

  await check('re-review N8: expansion uses the injected clock (template save and the nightly run); /slots/available without a date filters past days in the query', async () => {
    const d = await doctor('Dr Clock');
    const tomorrowNoon = new Date(`${addDays(today, 1)}T12:00:00+05:30`);
    const win = [{ start: '08:00', end: '16:00', modes: ['video'] }];
    await saveTemplate(d, { slotMinutes: 60, days: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((x) => [x, win])) as any }, tomorrowNoon);
    const starts = (await SlotModel.find({ specialistId: d, date: ymd(addDays(today, 1)) }).lean() as any[]).map((x) => x.startTime).sort();
    assert.deepEqual(starts, ['13:00', '14:00', '15:00'], 'nothing that has started by the injected time');
    let fromDate: unknown = 'not called';
    const spy = Object.assign(Object.create(SlotService.prototype), { slotRepository: { findAvailableSlots: async (_a: unknown, _b: unknown, _c: unknown, f: unknown) => { fromDate = f; return []; } } }) as SlotService;
    const pinned = new Date(`${addDays(today, 4)}T09:00:00+05:30`);
    await spy.getAvailableSlots(d, undefined, undefined, undefined, pinned);
    // Midnight fix (28 Nov): from yesterday, so a session open past midnight stays listed (ended ones are dropped in memory).
    assert.equal(fromDate, ymd(addDays(today, 3)));
  });

  await check('re-review N7: payment answers carry the customer booking view (no settlement account, desk internals or keys)', async () => {
    const u = await customer();
    const id = await paidBooking(u.id, drM);
    await BookingModel.updateOne({ _id: id }, { $set: { settlement: { settlementAccountId: 'acc-secret', beneficiaryName: 'Dr' } } });
    const rec = await PaymentRecordModel.create({ userId: u.id, context: 'booking', contextId: id, baseAmount: 500, discountAmount: 100, finalAmount: 400, currency: 'INR',
      paymentGateway: 'razorpay', razorpayOrderId: 'ord_' + new Types.ObjectId().toHexString(), status: 'paid' } as any);
    const out = await (payments as any).buildAlreadyProcessedResponse(rec.toObject());
    assert.equal(JSON.stringify(out.entity).includes('acc-secret'), false);
  });

  // ───────────────────────────── Item 3: legacy payouts bill a moved no-show once ─────────────────────────────
  await check('legacy payouts bill a moved no-show in its ORIGINAL month only (never in the month it moved to)', async () => {
    const d = await doctor('Dr Legacy');
    const u = await customer();
    const _id = new Types.ObjectId();
    await BookingModel.collection.insertOne({ _id, bookingType: 'consultation', userId: u.id, specialistId: d, bookingDate: '20261028', bookingTime: '10:00',
      price: 700, originalPrice: 700, status: 'completed', paymentStatus: 'paid', settlementSystem: 'legacy', noShowReschedules: 1,
      noShows: [{ at: new Date('2026-10-28T05:00:00Z'), rescheduledAt: new Date('2026-11-02T05:00:00Z'), rescheduledBy: d, rescheduledByKind: 'specialist',
        fromDate: '20261028', fromTime: '10:00', toSlotId: 'x', requestKey: 'k', requestHash: 'h' }], createdAt: new Date(), updatedAt: new Date() } as never);
    // Moved into November after October was billed.
    await BookingModel.updateOne({ _id }, { $set: { bookingDate: '20261105' } });
    const payout = new PayoutService(new BookingRepository(), {} as any) as any;
    const oct = await payout.calculateBillingSnapshot(d, 202610);
    const nov = await payout.calculateBillingSnapshot(d, 202611);
    assert.deepEqual([oct.total, oct.totalAppointments, nov.total, nov.totalAppointments], [700, 1, 0, 0]);
  });

  await check('re-review E: a moved no-show changing state flags its ORIGINAL legacy month for recalculation (listed for admins); recalculating takes it in, once', async () => {
    (CONFIG as any).SETTLEMENT_CUTOVER_AT = undefined;
    try {
      const d = await doctor('Dr Legacy Flag');
      const u = await customer();
      const start = futureStart();
      const id = await paidBooking(u.id, d, { price: 600, originalPrice: 600 }, start);
      const origMonth = Number(ymd(istDate(start)).slice(0, 6));
      await bookings.markNoShow(id, { _id: d, userType: 'specialist' }, new Date(Date.now() + 10 * DAY));
      const payout = new PayoutService(new BookingRepository(), new SpecialistRepository()) as any;
      await payout.calculateBillings({ specialist_id: d, months: [origMonth] });
      assert.equal((await PayoutBillingModel.findOne({ specialistId: d, month: origMonth }).lean())!.total, 0, 'billed while a no-show: excluded');
      const next = new Date(start.getTime() + 40 * DAY);
      await bookings.rescheduleNoShow(id, { _id: d, userType: 'specialist' }, { slotId: await slotAt(d, next), requestKey: rk('ns') });
      await setAppointment(id, new Date(Date.now() - MIN));
      await BookingModel.updateOne({ _id: id }, { $set: { bookingDate: ymd(istDate(next)) } });
      await bookings.update(id, { status: 'completed' } as any, undefined, new Date(next.getTime() + DAY));
      const flagged = await PayoutBillingModel.findOne({ specialistId: d, month: origMonth }).lean() as any;
      assert.deepEqual([flagged.needsRecalculation, flagged.recalculationReasons], [true, [id]]);
      const listed = await adminLegacyRecalculations({});
      assert.ok(listed.items.some((x) => x.doctorId === d && x.month === origMonth && x.bookingIds.includes(id)));
      const [bill] = await payout.calculateBillings({ specialist_id: d, months: [origMonth] });
      assert.deepEqual([bill.total, bill.needsRecalculation], [600, undefined]);
      const nextMonth = Number(ymd(istDate(next)).slice(0, 6));
      assert.equal((await payout.calculateBillingSnapshot(d, nextMonth)).total, 0, 'never in the month it moved to');
    } finally { (CONFIG as any).SETTLEMENT_CUTOVER_AT = new Date(Date.now() - MIN).toISOString(); }
  });

  // ───────────────────────────── Admin cancel of a moved no-show ─────────────────────────────
  const movedNoShow = async (u: string, d: string) => {
    const id = await paidBooking(u, d);
    await bookings.markNoShow(id, { _id: d, userType: 'specialist' }, new Date(Date.now() + 10 * DAY));
    await bookings.rescheduleNoShow(id, { _id: d, userType: 'specialist' }, { slotId: await slotAt(d, futureStart()), requestKey: rk('ns') });
    return id;
  };
  await check('a moved no-show: only an admin cancels it — with a refund (full, to the wallet) or without (money kept, nobody earns)', async () => {
    const u = await customer();
    const id = await movedNoShow(u.id, drM);
    await assert.rejects(() => bookings.cancelBooking(id, { cancellationReason: 'x' }, { _id: u.id, userType: 'user' }), code('NO_SHOW_NOT_REFUNDABLE'));
    await assert.rejects(() => bookings.cancelByDoctor(id, { _id: drM, userType: 'specialist' }, 'x'), code('NO_SHOW_NOT_REFUNDABLE'));
    // Seed the wallet ledger the way a wallet-funded booking holds it, so the refund has something to return.
    await BookingModel.updateOne({ _id: id }, { $set: { walletFunding: { total: 400, revision: 1, closed: false, captures: [] } } });
    const done = await bookings.adminCancelMovedNoShow(id, { _id: ADMIN }, { reason: 'Doctor unavailable', refund: true });
    assert.deepEqual([done.status, done.paymentStatus, done.refunded, (done as any).noShowCancel.refund], ['cancelled', 'refunded', 400, true]);
    assert.equal(await balance(u.id), 400);
    assert.equal(await DoctorReservationModel.countDocuments({ refId: id, isActive: true }), 0, 'doctor time released');

    const u2 = await customer();
    const id2 = await movedNoShow(u2.id, drM);
    const slot2 = (await BookingModel.findById(id2).lean())!.slotId;
    await BookingModel.updateOne({ _id: id2 }, { $set: { walletFunding: { total: 400, revision: 1, closed: false, captures: [] } } });
    const kept = await bookings.adminCancelMovedNoShow(id2, { _id: ADMIN }, { reason: 'Doctor unavailable', refund: false });
    assert.deepEqual([kept.status, kept.paymentStatus, kept.refunded], ['cancelled', 'paid', 0]);
    const keptRow = await BookingModel.findById(id2).lean() as any;
    assert.deepEqual([keptRow.walletFunding.closed, keptRow.walletFunding.total, keptRow.noShowCancel.forfeitedAmount], [true, 0, 400],
      'funding closed (no money shown as held); kept as forfeited');
    assert.equal(await balance(u2.id), 0);
    assert.equal((await SlotModel.findById(slot2).lean() as any).currentBookings, 0, 'seat released');
    // A repeat (customer or admin) never refunds it later; the admin's second cancel is refused (409 ALREADY_CANCELLED).
    await bookings.cancelBooking(id2, { cancellationReason: 'x' }, { _id: u2.id, userType: 'user' });
    assert.equal(await balance(u2.id), 0);
    await assert.rejects(() => bookings.adminCancelMovedNoShow(id2, { _id: ADMIN }, { reason: 'again', refund: false }), code('ALREADY_CANCELLED'));
    await assert.rejects(() => bookings.adminCancelMovedNoShow(id, { _id: ADMIN }, { reason: 'again', refund: true }), code('ALREADY_CANCELLED'));
    assert.equal((await earnings(id2)).length, 0);
    // Not a moved no-show: the dedicated command refuses it.
    const plain = await paidBooking(u2.id, drM);
    await assert.rejects(() => bookings.adminCancelMovedNoShow(plain, { _id: ADMIN }, { reason: 'x', refund: true }), code('BOOKING_NOT_MOVED_NO_SHOW'));
  });

  // ───────────────────────────── Instant: frozen fees, coupon on the fee charged, admin cancel ─────────────────────────────
  const setFee = (d: string, fee: number) => DoctorPresenceModel.updateOne({ doctorId: d }, { $set: { instantFeeMinor: fee } });
  const instantDoctor = async (name: string, feeRupees: number, spec: string) => {
    const d = await doctor(name, { specialization: spec, consultationFee: feeRupees });
    await instant.setPresence(d, { available: true, modes: ['video'] });
    return d;
  };
  const ask = (spec: string, over: Record<string, unknown> = {}) => ({ target: { kind: 'any' }, specialization: spec, mode: 'video', patient: { kind: 'self' },
    requestKey: rk('instant'), useWalletBalance: true, ...over }) as any;

  await check('instant any-available: each offered fee is frozen; a doctor who raises their fee after the offer charges the frozen fee', async () => {
    const cheap = await instantDoctor('Dr Cheap', 300, 'Freeze');
    await instantDoctor('Dr Dear', 800, 'Freeze');
    const u = await customer(800);
    const r = await instant.create(u.id, ask('Freeze'));
    const id = String((r.request as any)._id);
    const row = await InstantRequestModel.findById(id).lean();
    assert.deepEqual((row!.offerFees ?? []).map((o) => o.feeMinor).sort((a, b) => a - b), [30000, 80000]);
    await setFee(cheap, 70000); // raised after the offer
    const offers = await instant.myOffers(cheap);
    assert.deepEqual([offers[0]!.offeredFeeMinor, offers[0]!.chargeFeeMinor], [30000, 30000]);
    const out = await instant.accept(cheap, id);
    assert.equal(out.booking.originalPrice, 300, 'the frozen fee, not the raised one');
    assert.equal((await InstantRequestModel.findById(id).lean())!.acceptedFeeMinor, 30000);
    assert.equal(await balance(u.id), 500, '800 paid, 500 returned');
  });

  await check('instant: a percentage coupon applies to the fee charged (not the quote); below its minimum no coupon applies and the rest is refunded', async () => {
    await CouponModel.create({ code: 'HALF', discountType: 'percentage', discountValue: 50, applicableTo: 'all', eligibleFor: 'all',
      startDate: '20200101', endDate: '20991231', currentUsageCount: 0, isActive: true } as any);
    const cheap = await instantDoctor('Dr Pct Cheap', 300, 'Percent');
    await instantDoctor('Dr Pct Dear', 800, 'Percent');
    const u = await customer(400);
    const r = await instant.create(u.id, ask('Percent', { couponCode: 'HALF' }));
    const id = String((r.request as any)._id);
    assert.equal((await InstantRequestModel.findById(id).lean())!.discountMinor, 40000, '50% of the 800 quote held');
    const out = await instant.accept(cheap, id);
    const row = await InstantRequestModel.findById(id).lean();
    assert.deepEqual(row!.allocated, { couponMinor: 15000, walletMinor: 15000, gatewayMinor: 0, totalMinor: 30000 }, '50% of 300, not 100%');
    assert.equal(out.booking.price, 150);
    assert.equal(await balance(u.id), 250, '400 paid, 250 returned');

    await CouponModel.create({ code: 'MIN500', discountType: 'fixed', discountValue: 100, minimumPurchaseAmount: 500, applicableTo: 'all', eligibleFor: 'all',
      startDate: '20200101', endDate: '20991231', currentUsageCount: 0, isActive: true } as any);
    const cheap2 = await instantDoctor('Dr Min Cheap', 300, 'Minimum');
    await instantDoctor('Dr Min Dear', 800, 'Minimum');
    const u2 = await customer(700);
    const r2 = await instant.create(u2.id, ask('Minimum', { couponCode: 'MIN500' }));
    const id2 = String((r2.request as any)._id);
    assert.equal(Number((await CouponModel.findOne({ code: 'MIN500' }).lean() as any).currentUsageCount), 1);
    const out2 = await instant.accept(cheap2, id2);
    const row2 = await InstantRequestModel.findById(id2).lean();
    assert.deepEqual(row2!.allocated, { couponMinor: 0, walletMinor: 30000, gatewayMinor: 0, totalMinor: 30000 }, 'no coupon below its minimum');
    assert.equal(out2.booking.price, 300);
    assert.equal(await balance(u2.id), 400, '700 paid, 400 returned');
    assert.equal(Number((await CouponModel.findOne({ code: 'MIN500' }).lean() as any).currentUsageCount), 0, 'the unused coupon is not counted');
    // Provider-borne: completing it earns the fee after the coupon.
    await bookings.update(String(out.booking._id), { status: 'completed' } as any);
    assert.deepEqual((await earnings(String(out.booking._id))).map((e) => e.amountMinor), [15000]);
  });

  await check('re-review C: a doctor whose fee falls below the coupon minimum and costs more than was paid is left out of the offer; accepting is a 409, never a 500', async () => {
    await CouponModel.create({ code: 'HALFMIN900', discountType: 'percentage', discountValue: 50, minimumPurchaseAmount: 900, applicableTo: 'all', eligibleFor: 'all',
      startDate: '20200101', endDate: '20991231', currentUsageCount: 0, isActive: true } as any);
    const c = await instantDoctor('Dr Min C', 800, 'Afford');
    const d = await instantDoctor('Dr Min D', 1000, 'Afford');
    const u = await customer(500);
    const r = await instant.create(u.id, ask('Afford', { couponCode: 'HALFMIN900' }));
    const id = String((r.request as any)._id);
    const row = await InstantRequestModel.findById(id).lean();
    assert.deepEqual(row!.offeredTo, [d], 'only the doctor the paid amount covers');
    // Even when offered (e.g. a request offered before this rule), accepting is refused cleanly.
    await InstantRequestModel.updateOne({ _id: id }, { $addToSet: { offeredTo: c }, $push: { offerFees: { doctorId: c, feeMinor: 80000 } } });
    assert.equal((await instant.myOffers(c)).find((o) => o.requestId === id)!.feeWithinQuote, false);
    await assert.rejects(() => instant.accept(c, id), code('OFFER_NO_LONGER_AFFORDABLE'));
    assert.equal((await InstantRequestModel.findById(id).lean())!.fundingState, 'held', 'nothing changed');
    assert.equal(await balance(u.id), 0);
  });

  await check('re-review D: a doctor offered before keeps min(earlier frozen fee, current fee) on every re-offer', async () => {
    const a = await instantDoctor('Dr Reoffer A', 300, 'Reoffer');
    await instantDoctor('Dr Reoffer B', 2000, 'Reoffer');
    const u = await customer(2000);
    const r = await instant.create(u.id, ask('Reoffer'));
    const id = String((r.request as any)._id);
    await instant.setPresence(a, { available: true, modes: ['video'], instantFeeMinor: 150000 });
    const later = new Date(Date.now() + 6 * MIN);
    await instant.heartbeat(a, later);
    await instant.reoffer(u.id, id, { kind: 'any' }, later);
    assert.equal((await InstantRequestModel.findById(id).lean())!.offerFees!.find((o) => o.doctorId === a)!.feeMinor, 30000);
    const out = await instant.accept(a, id, later);
    assert.equal(out.booking.originalPrice, 300, 'never the raised fee');
    assert.equal(await balance(u.id), 1700);
  });

  await check('instant: an admin cancels an accepted consultation with a full refund (cause admin); a no-show needs 15 minutes after acceptance', async () => {
    const d = await instantDoctor('Dr Accepted', 500, 'Accepted');
    const u = await customer(500);
    const r = await instant.create(u.id, ask('Accepted', { target: { kind: 'specific', doctorId: d } }));
    const out = await instant.accept(d, String((r.request as any)._id));
    const bid = String(out.booking._id);
    await assert.rejects(() => bookings.markNoShow(bid, { _id: d, userType: 'specialist' }, new Date(Date.now() + 5 * MIN)), code('APPOINTMENT_NOT_STARTED'));
    await instant.cancelAccepted(bid, { _id: ADMIN, userType: 'admin' }, 'Doctor never joined');
    const b = await BookingModel.findById(bid).lean();
    assert.deepEqual([b!.status, b!.cancellationCause], ['cancelled', 'admin']);
    assert.equal(await balance(u.id), 500, 'everything back');
    assert.equal((await InstantRequestModel.findById(String((r.request as any)._id)).lean())!.refundReason, 'admin_cancelled');
  });

  await check('instant discovery: a doctor with an interval starting within the next 30 minutes is busy (cannot accept), so not listed', async () => {
    const d = await instantDoctor('Dr Soon', 400, 'Soonology');
    assert.equal((await instant.onlineDoctors({ specialization: 'Soonology', mode: 'video' })).length, 1);
    const at = new Date(Date.now() + 10 * MIN);
    await runLedgerTransaction((s) => reserveInterval({ doctorId: d, kind: 'scheduled', refId: 'soon-appt', start: at, end: new Date(at.getTime() + 30 * MIN) }, s));
    assert.equal((await instant.onlineDoctors({ specialization: 'Soonology', mode: 'video' })).length, 0);
    assert.equal((await instant.presence(d)).online, false);
    await assert.rejects(() => instant.quote({ specialization: 'Soonology', mode: 'video' }), code('NO_DOCTOR_ONLINE'));
  });

  // ───────────────────────────── Item 9: sweeps go on past a failing row ─────────────────────────────
  await check('sweeps: one failing row never stops the others; the inactivity refund runs even when the unpaid expiry throws', async () => {
    const d = await instantDoctor('Dr Sweep', 200, 'Sweepology');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const u = await customer(200);
      const r = await instant.create(u.id, ask('Sweepology', { target: { kind: 'specific', doctorId: d } }));
      ids.push(String((r.request as any)._id));
    }
    await InstantRequestModel.updateMany({ _id: { $in: ids } }, { $set: { inactivityRefundAt: new Date(Date.now() - MIN) } });
    const real = (instant as any).refundHeld.bind(instant);
    (instant as any).refundHeld = async (id: string, ...rest: unknown[]) => { if (id === ids[0]) throw new Error('boom'); return real(id, ...rest); };
    try {
      const out = await instant.refundInactive();
      assert.deepEqual([out.refunded, (out as any).failed], [2, 1]);
    } finally { (instant as any).refundHeld = real; }
    let inactiveRan = false;
    const r = await runInstantSweeps({ expireUnpaid: async () => { throw new Error('boom'); },
      refundInactive: async () => { inactiveRan = true; return { examined: 0, refunded: 0, failed: 0 }; } } as any);
    assert.equal(inactiveRan, true);
    assert.equal(r.unpaid, null);
    // Unpaid expiry: a row whose transaction throws is skipped; the next is expired.
    const due: string[] = [];
    for (let i = 0; i < 2; i++) {
      const u = await customer(0);
      const x = await InstantRequestModel.create({ userId: u.id, createRequestKey: rk('unpaid'), createRequestHash: 'h', patient: { kind: 'self', name: 'A' },
        specialization: 'Sweepology', mode: 'video', target: { kind: 'any' }, quotedAmountMinor: 100, discountMinor: 0, fundingState: 'awaiting',
        status: 'pending_payment', statusVersion: 0, paymentStatus: 'pending', paymentDeadline: new Date(Date.now() - MIN), offerGeneration: 0, offeredTo: [] } as any);
      due.push(String(x._id));
    }
    const realFence = (instant as any).fenceRecords.bind(instant);
    (instant as any).fenceRecords = async (id: string, s: unknown) => { if (id === due[0]) throw new Error('boom'); return realFence(id, s); };
    try {
      const out = await instant.expireUnpaid();
      assert.equal((out as any).failed, 1);
      assert.equal((await InstantRequestModel.findById(due[1]).lean())!.status, 'expired_unpaid');
    } finally { (instant as any).fenceRecords = realFence; }
    // Lab expiry sweep.
    const lab = Object.create(LabBookingService.prototype) as any;
    lab.paymentService = { reconcileContextPayments: async () => ({ unknown: 0 }) };
    const seen: string[] = [];
    const a = new Types.ObjectId(); const b = new Types.ObjectId();
    await PartnerLabBookingModel.collection.insertMany([a, b].map((_id) => ({ _id, status: 'pending_payment', paymentStatus: 'pending',
      paymentDeadline: new Date(Date.now() - 2 * MIN) })) as never);
    lab.expireUnpaid = async (id: string) => { seen.push(id); if (id === String(a)) throw new Error('boom'); return { expired: true }; };
    const lo = await lab.expireDue();
    assert.deepEqual([seen.length, lo.expired, lo.failed], [2, 1, 1]);
    await PartnerLabBookingModel.deleteMany({ _id: { $in: [a, b] } });
  });

  // ───────────────────────────── Item 7: Q3 migration keeps updatedAt ─────────────────────────────
  await check('the Q3 cutover stamp does not rewrite updatedAt (the version clients fence on)', async () => {
    const _id = new Types.ObjectId();
    const at = new Date('2026-01-02T03:04:05Z');
    await BookingModel.collection.insertOne({ _id, bookingType: 'consultation', userId: 'u', bookingDate: '20260102', bookingTime: '10:00', status: 'completed',
      createdAt: at, updatedAt: at } as never);
    await runSettlementCutover(true);
    const b = await BookingModel.findById(_id).lean();
    assert.equal(b!.settlementSystem, 'legacy');
    assert.equal(new Date(b!.updatedAt!).toISOString(), at.toISOString());
  });

  // ───────────────────────────── Item 8: one doctor, one spelling ─────────────────────────────
  await check('a doctor id in another letter case: stored lower-case, one settlement account, one set of reservations', async () => {
    const d = await doctor('Dr Case');
    const upper = d.toUpperCase();
    const u = await customer();
    const s1 = await slotAt(d, futureStart());
    const slotRow = await SlotModel.findById(s1).lean() as any;
    const b = await createBookingWithHolds({ bookingType: 'consultation', userId: u.id, specialistId: upper, slotId: s1, bookingDate: slotRow.date,
      bookingTime: slotRow.startTime, consultationMode: 'video', serviceMode: 'video', price: 500, status: 'pending', paymentStatus: 'pending' } as any);
    assert.equal(b.specialistId, d);
    const acc = await ensureSettlementAccount('doctor', upper, 'Dr Case');
    const acc2 = await ensureSettlementAccount('doctor', d, 'Dr Case');
    assert.equal(String(acc._id), String(acc2._id));
    // Re-review G: when both spellings exist the lower-case account wins; the read-only audit lists them (ids only).
    const d2 = await doctor('Dr Case Two');
    const upperAcc = await SettlementAccountModel.create({ ownerKind: 'doctor', ownerId: d2.toUpperCase(), beneficiaryName: 'X', isActive: true } as any);
    const lowerAcc = await SettlementAccountModel.create({ ownerKind: 'doctor', ownerId: d2, beneficiaryName: 'X', isActive: true } as any);
    assert.equal(String((await ensureSettlementAccount('doctor', d2.toUpperCase(), 'X'))._id), String(lowerAcc._id));
    const audit = await runDoctorIdCaseAudit();
    const doubled = audit.doubledAccounts.find((x) => x.doctorId === d2);
    assert.deepEqual([doubled?.canonicalAccountId, doubled?.accountIds.length], [String(lowerAcc._id), 2]);
    assert.ok(doubled!.accountIds.includes(String(upperAcc._id)));
    assert.equal(JSON.stringify(audit).includes('beneficiaryName'), false, 'ids only');
    assert.equal(await SettlementAccountModel.countDocuments({ ownerKind: 'doctor', ownerId: new RegExp(`^${d}$`, 'i') }), 1);
    assert.equal(String(b.settlement?.settlementAccountId), String(acc._id));
    // The same time under the other spelling is refused (one guard, one set of intervals).
    const held = await DoctorReservationModel.findOne({ refId: String(b._id) }).lean();
    assert.equal(held!.doctorId, d);
    await assert.rejects(() => runLedgerTransaction((s) => reserveInterval({ doctorId: upper, kind: 'instant', refId: 'case-x', start: held!.startTime, end: held!.endTime }, s)),
      code('DOCTOR_BUSY'));
  });

  // ───────────────────────────── Items 10–12: invoices and cutover ─────────────────────────────
  await check('invoice tax: CGST and SGST are each rounded at half the rate (always equal) and the total is taxable + CGST + SGST', () => {
    const line = { description: 'x', qty: 1, unitPriceMinor: 10100, discountMinor: 0, gstRate: 5, amountMinor: 10100 } as any;
    const t = computeTotals([line], true);
    assert.equal(t.cgstMinor, t.sgstMinor);
    assert.deepEqual([t.cgstMinor, t.totalMinor], [253, 10100 + 506]);
    assert.equal(computeTotals([line], false).igstMinor, 505);
  });

  await check('the PDF of a cancelled paid bill prints the refund (amount, method, reference)', () => {
    const inv = { serial: 'CC/2627/0001', documentKind: 'commercial_invoice', issuedAt: new Date(), supplier: { name: 'Care', address: 'Pune', placeOfSupply: '27' },
      customer: { name: 'Asha' }, items: [{ description: 'Consult', qty: 1, unitPriceMinor: 50000, discountMinor: 0, gstRate: 0, amountMinor: 50000 }],
      totals: { subtotalMinor: 50000, discountMinor: 0, taxableMinor: 50000, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: 50000, currency: 'INR' } } as any;
    const events = [{ kind: 'payment', mode: 'cash', amountMinor: 50000, at: new Date() },
      { kind: 'cancellation', reason: 'Duplicate', at: new Date(), refund: { mode: 'upi', reference: 'UTR123', amountMinor: 50000 } }] as any;
    const html = renderInvoiceHtml(inv, events);
    assert.ok(html.includes('Refunded') && html.includes('UTR123') && html.includes('UPI'), 'refund printed');
  });

  await check('SETTLEMENT_CUTOVER_AT: a date is India midnight, a zoneless time is India time, an unparseable value is logged at startup', () => {
    assert.equal(parseSettlementCutover('2026-12-01').at!.toISOString(), '2026-11-30T18:30:00.000Z');
    assert.equal(parseSettlementCutover('2026-12-01T09:30').at!.toISOString(), '2026-12-01T04:00:00.000Z');
    assert.equal(parseSettlementCutover('2026-12-01T00:00:00Z').at!.toISOString(), '2026-12-01T00:00:00.000Z');
    for (const bad of ['01/12/2026', 'tomorrow', '2026-02-30', '2026-02-30T10:00', '2026-02-30T10:00:00+05:30', '2026-13-01T00:00:00Z']) assert.ok(parseSettlementCutover(bad).error, bad);
    const saved = CONFIG.SETTLEMENT_CUTOVER_AT;
    const logged: string[] = [];
    try {
      (CONFIG as any).SETTLEMENT_CUTOVER_AT = 'next monday';
      assert.equal(checkSettlementCutoverConfig({ error: (m) => { logged.push(m); }, info: () => undefined }), null);
      assert.equal(settlementSystemFor(new Date()), 'legacy');
      assert.equal(logged.length, 1);
      assert.ok(logged[0]!.includes('SETTLEMENT_CUTOVER_AT'));
    } finally { (CONFIG as any).SETTLEMENT_CUTOVER_AT = saved; }
  });

  // ───────────────────────────── M3: reminders ─────────────────────────────
  await check('reminders are scheduled for HH:mm slots in India time; an unreadable new time removes the old jobs', async () => {
    const jobs = new Map<string, number>();
    const saved = { pub: TaskQueue.publishUniqueLater, del: TaskQueue.deleteUniqueJob };
    (TaskQueue as any).publishUniqueLater = async (_c: string, uid: string, at: number) => { jobs.set(uid, at); };
    (TaskQueue as any).deleteUniqueJob = async (_c: string, uid: string) => { jobs.delete(uid); };
    try {
      const sched = new BookingReminderScheduler();
      const day = ymd(addDays(today, 5));
      await sched.scheduleBookingReminders({ _id: 'b1', userId: 'u', status: 'confirmed', bookingDate: day, bookingTime: '09:00' } as any);
      const at = new Date(`${addDays(today, 5)}T09:00:00+05:30`).getTime() / 1000;
      assert.equal(jobs.get('b1:thirty_minutes'), at - 1800);
      assert.equal(jobs.get('b1:one_day'), at - 86400);
      await sched.scheduleBookingReminders({ _id: 'b1', userId: 'u', status: 'confirmed', bookingDate: day, bookingTime: '9:30 AM' } as any);
      assert.equal(jobs.get('b1:thirty_minutes'), at + 1800 - 1800);
      await sched.scheduleBookingReminders({ _id: 'b1', userId: 'u', status: 'confirmed', bookingDate: day, bookingTime: 'soon' } as any);
      assert.equal(jobs.size, 0, 'old jobs removed');
    } finally { (TaskQueue as any).publishUniqueLater = saved.pub; (TaskQueue as any).deleteUniqueJob = saved.del; }
  });

  // ───────────────────────────── L6: manual closures survive leave ─────────────────────────────
  await check('leave on and off never reopens a slot the doctor switched off by hand', async () => {
    const d = await doctor('Dr Manual');
    const day = addDays(today, 4);
    const sid = await slotAt(d, new Date(`${day}T10:00:00+05:30`));
    const other = await slotAt(d, new Date(`${day}T11:00:00+05:30`));
    await slotSvc.update(sid, { isAvailable: false });
    await setLeave(d, ymd(day), true);
    await setLeave(d, ymd(day), false);
    const s = await SlotModel.findById(sid).lean() as any;
    assert.deepEqual([s.isAvailable, s.manuallyClosed], [false, true], 'still closed by hand');
    const o = await SlotModel.findById(other).lean() as any;
    assert.deepEqual([o.isActive, o.isAvailable], [true, true], 'the other slot reopened');
    await slotSvc.update(sid, { isAvailable: true });
    assert.equal((await SlotModel.findById(sid).lean() as any).manuallyClosed, false);
  });

  // ───────────────────────────── L3: customer view ─────────────────────────────
  await check('generic booking reads hide desk internals, the settlement account and extension request keys', () => {
    const row = { _id: 'b', clinicDesk: { partnerId: 'p', branchId: 'br', createdBy: 'm1', requestKey: 'desk:m1:k', requestHash: 'hh', arrivedAt: null },
      settlement: { settlementAccountId: 'acc', beneficiaryName: 'Dr' }, instantExtensions: [{ requestKey: 'ext-1', minutes: 10 }] };
    const seen = publicNoShowView(row) as any;
    assert.deepEqual(seen.clinicDesk, { partnerId: 'p', branchId: 'br', arrivedAt: null });
    assert.deepEqual(seen.settlement, { beneficiaryName: 'Dr' });
    assert.deepEqual(seen.instantExtensions, [{ minutes: 10 }]);
    const wrapped = publicNoShowView({ booking: row, paymentRequired: false }) as any;
    assert.equal(JSON.stringify(wrapped).includes('acc'), false);
  });

  // ───────────────────────────── L1: backfill ─────────────────────────────
  await check('the reservation backfill reports overlaps in the dry run and goes on past a bad row', async () => {
    const d = await doctor('Dr Backfill');
    const u = await customer();
    const start = futureStart();
    const s1 = await slotAt(d, start);
    const s2 = await slotAt(d, new Date(start.getTime() + 10 * MIN));
    const ids = [];
    for (const s of [s1, s2]) {
      const row = await SlotModel.findById(s).lean() as any;
      const _id = new Types.ObjectId();
      await BookingModel.collection.insertOne({ _id, bookingType: 'consultation', userId: u.id, specialistId: d, slotId: s, bookingDate: row.date,
        bookingTime: row.startTime, status: 'confirmed', paymentStatus: 'paid' } as never);
      ids.push(String(_id));
    }
    const bad = new Types.ObjectId();
    await BookingModel.collection.insertOne({ _id: bad, bookingType: 'consultation', userId: u.id, specialistId: d, slotId: 'not-a-slot-id',
      bookingDate: '20991231', bookingTime: '10:00', status: 'confirmed' } as never);
    const dry = await runReservationBackfill(false);
    assert.ok(dry.conflicts.includes(ids[1]!), 'the overlap is reported by the dry run');
    assert.ok(dry.failed.some((f) => f.bookingId === String(bad)));
    const run = await runReservationBackfill(true);
    assert.ok(run.conflicts.includes(ids[1]!));
    assert.ok(run.failed.some((f) => f.bookingId === String(bad)));
    assert.equal(await DoctorReservationModel.countDocuments({ refId: ids[0], isActive: true }), 1, 'the good row was reserved');
    await BookingModel.deleteOne({ _id: bad });
  });

  // ───────────────────────────── Admin read: unmarked consultations ─────────────────────────────
  await check('admin read: past paid ledger consultations never marked completed or no-show, paged by an exact cursor', async () => {
    const d = await doctor('Dr Unmarked');
    const u = await customer();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await paidBooking(u.id, d);
      await setAppointment(id, new Date(Date.now() - (i + 2) * DAY));
      ids.push(id);
    }
    const done = await paidBooking(u.id, d);
    await setAppointment(done, new Date(Date.now() - 2 * DAY));
    await bookings.update(done, { status: 'completed' } as any);
    const future = await paidBooking(u.id, d);
    const free = await paidBooking(u.id, d, { price: 0, originalPrice: 0 });
    await setAppointment(free, new Date(Date.now() - 3 * DAY));
    const p1 = await adminUnmarkedConsultations({ doctorId: d, limit: 2 });
    assert.equal(p1.total, 3);
    assert.equal(p1.items.length, 2);
    const p2 = await adminUnmarkedConsultations({ doctorId: d, limit: 2, cursor: p1.nextCursor! });
    const all = [...p1.items, ...p2.items].map((x) => x.bookingId).sort();
    assert.deepEqual(all, [...ids].sort());
    assert.ok(!all.includes(done) && !all.includes(future) && !all.includes(free), 'completed, future and zero-price rows are not listed');
    assert.deepEqual(Object.keys(p1.items[0]!).filter((k) => ['bookingId', 'doctorId', 'bookingDate'].includes(k)).sort(), ['bookingDate', 'bookingId', 'doctorId']);
  });

  // ───────────────────────────── Clinic: desk, holidays, links ─────────────────────────────
  const { partner: cp, owner: cOwner } = await partnerSvc.createPartner({ kind: 'clinic', name: 'Care Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'CQ',
    firstOwner: { phone: nextPhone(), name: 'Owner' } } as any);
  const clinicId = String(cp._id);
  await partnerSvc.verifyPartner(clinicId, 'admin');
  const own = actorFor(cOwner);
  const A = String((await partnerSvc.createBranch(own, clinicBranch('Kothrud')))._id);
  const deskM = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk', role: 'staff', branchIds: [A],
    permissions: ['bookings.view', 'bookings.manage', 'staff.manage'] } as any);
  const desk = actorFor(deskM);
  const drC = await doctor('Dr Clinic');
  await clinic.linkDoctor(adminActor(ADMIN, clinicId), { doctorId: drC, branchIds: [], requestKey: rk('link') });
  const deskSlot = async (start = futureStart()) => slotAt(drC, start, { serviceModes: ['in-person'], branchId: A });

  await check('desk: completion before the start is refused; a started appointment cannot be moved; the doctor cannot set it to pending', async () => {
    const made = await clinic.createDeskAppointment(desk, { slotId: await deskSlot(), customer: { phone: nextPhone() }, requestKey: rk('desk') });
    const id = made.booking.bookingId;
    await assert.rejects(() => clinic.closeDeskAppointment(desk, id, 'completed', new Date()), code('NOT_STARTED_YET'));
    await assert.rejects(() => bookings.update(id, { status: 'pending' } as any), code('DESK_STATUS_NOT_ALLOWED'));
    await setAppointment(id, new Date(Date.now() - 5 * MIN));
    await assert.rejects(() => clinic.closeDeskAppointment(desk, id, 'no_show', new Date()), code('APPOINTMENT_NOT_STARTED'));
    assert.equal((await clinic.closeDeskAppointment(desk, id, 'completed', new Date())).status, 'completed');
  });

  await check('re-review N4: the desk may move a late patient after the appointment started (not paid through us)', async () => {
    const made = await clinic.createDeskAppointment(desk, { slotId: await deskSlot(), customer: { phone: nextPhone() }, requestKey: rk('desk') });
    const id = made.booking.bookingId;
    await setAppointment(id, new Date(Date.now() - 20 * MIN));
    const target = await deskSlot();
    const moved = await clinic.rescheduleDeskAppointment(desk, id, target);
    assert.deepEqual([moved.status, moved.slotId], ['confirmed', target]);
  });

  await check('a doctor cancelling a desk appointment: no wallet refund is promised, and the clinic audit trail records it', async () => {
    const made = await clinic.createDeskAppointment(desk, { slotId: await deskSlot(), customer: { phone: nextPhone() }, requestKey: rk('desk') });
    const id = made.booking.bookingId;
    const before = notices.length;
    await bookings.cancelByDoctor(id, { _id: drC, userType: 'specialist' }, 'Emergency');
    const sent = notices.slice(before).find((n) => n.key === `booking:${id}:doctor_cancelled`);
    assert.ok(sent && !/wallet/i.test(sent.message ?? ''), 'no wallet promise');
    assert.ok(await PartnerAuditEventModel.exists({ partnerId: clinicId, action: 'clinic.appointment_cancelled_by_doctor', 'target.id': id }));
  });

  await check('two concurrent admin links of the same doctor: one links, the other is 409 DOCTOR_ALREADY_MEMBER (never a raw 500)', async () => {
    const d = await doctor('Dr Race');
    const r = await Promise.allSettled([0, 1, 2].map(() => clinic.linkDoctor(adminActor(ADMIN, clinicId), { doctorId: d, branchIds: [], requestKey: rk('race') })));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    for (const x of r) if (x.status === 'rejected') assert.equal((x.reason as any)?.code, 'DOCTOR_ALREADY_MEMBER');
    // The losing interleaving, made deterministic: the second link read "no membership yet" before the first committed,
    // so its insert meets the unique membership index (a raw duplicate-key error before Q16a).
    const realExists = MemberModel.exists;
    const realFindOne = MemberModel.findOne;
    (MemberModel as any).exists = () => ({ session: async () => null });
    (MemberModel as any).findOne = (f: Record<string, unknown>, ...rest: unknown[]) => (f && 'phone' in f
      ? { session: () => ({ lean: async () => null }) } : (realFindOne as any).call(MemberModel, f, ...rest));
    try {
      await assert.rejects(() => clinic.linkDoctor(adminActor(ADMIN, clinicId), { doctorId: d, branchIds: [], requestKey: rk('race') }), code('DOCTOR_ALREADY_MEMBER'));
    } finally { (MemberModel as any).exists = realExists; (MemberModel as any).findOne = realFindOne; }
  });

  await check('a clinic branch holiday closes the doctors\' in-clinic slots (expansion and admission), hides them, and reopens them after', async () => {
    const d = await doctor('Dr Holiday');
    await clinic.linkDoctor(adminActor(ADMIN, clinicId), { doctorId: d, branchIds: [], requestKey: rk('link') });
    const day = addDays(today, 6);
    const win = [{ start: '10:00', end: '11:00', modes: ['in-person'], branchId: A }];
    await saveTemplate(d, { slotMinutes: 30, days: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((x) => [x, win])) as any });
    const manual = await slotAt(d, new Date(`${day}T15:00:00+05:30`), { serviceModes: ['in-person'], branchId: A });
    assert.equal(await SlotModel.countDocuments({ specialistId: d, date: ymd(day), isActive: true }), 3);
    await partnerSvc.updateBranch(own, A, { holidays: [day] } as any);
    const rows = await SlotModel.find({ specialistId: d, date: ymd(day) }).lean() as any[];
    assert.ok(rows.length === 3 && rows.every((r) => r.isActive === false && r.closedReason === 'holiday'), 'template and manual slots closed');
    assert.ok(!(await slotSvc.getAvailableSlots(d)).some((s) => String(s.date) === ymd(day)));
    // Admission refuses it whatever the slot says.
    await SlotModel.updateOne({ _id: manual }, { $set: { isActive: true, isAvailable: true } });
    const u = await customer();
    await assert.rejects(() => createBookingWithHolds({ bookingType: 'consultation', userId: u.id, specialistId: d, slotId: manual, bookingDate: ymd(day),
      bookingTime: '15:00', consultationMode: 'in-person', price: 500, status: 'pending', paymentStatus: 'pending' } as any), code('SLOT_NOT_AVAILABLE'));
    assert.ok(!(await slotSvc.getAvailableSlots(d)).some((s) => String(s._id) === manual), 'hidden from lists');
    await partnerSvc.updateBranch(own, A, { holidays: [] } as any);
    assert.equal(await SlotModel.countDocuments({ specialistId: d, date: ymd(day), isActive: true }), 3, 'reopened');
    // A fresh expansion on a holiday creates nothing at that branch.
    await partnerSvc.updateBranch(own, A, { holidays: [addDays(today, 7)] } as any);
    await expandDoctorSlots(d, today, 10);
    assert.equal(await SlotModel.countDocuments({ specialistId: d, date: ymd(addDays(today, 7)), isActive: true }), 0);
  });

  // ───────────────────────────── Labs ─────────────────────────────
  const { partner: lp, owner: lOwner } = await partnerSvc.createPartner({ kind: 'lab', name: 'Metro Lab', contactPhone: nextPhone(), invoiceSeriesPrefix: 'MQ',
    firstOwner: { phone: nextPhone(), name: 'Lab owner' } } as any);
  const labId = String(lp._id);
  await partnerSvc.verifyPartner(labId, 'admin');
  const labOwn = actorFor(lOwner);
  const LA = String((await partnerSvc.createBranch(labOwn, { name: 'Lab A', phone: '9876500000', holidays: [], hours: {}, services: { homeCollection: true, inLab: true, inClinic: false },
    address: addr } as any))._id);
  const every = (start: string, end: string) => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((x) => [x, [{ start, end }]]));
  await saveSlotTemplate(labOwn, LA, 'lab', { slotMinutes: 30, capacity: 5, days: every('08:00', '10:00'), expectedUpdatedAt: null });
  const labAcct = await SettlementAccountModel.findOne({ ownerKind: 'partner', ownerId: labId }).lean();
  const labSlot = async (dayOffset: number) => PartnerSlotModel.findOne({ branchId: LA, visitMode: 'lab', date: addDays(today, dayOffset), startTime: '08:00' }).lean();
  const labBooking = async (userId: string, pricing = { subtotalMinor: 50000, discountMinor: 0, payableMinor: 50000 }) => {
    const _id = new Types.ObjectId();
    const s = await labSlot(3);
    await PartnerLabBookingModel.collection.insertOne({ _id, partnerId: labId, branchId: LA, userId, createRequestKey: `k${_id}`, createRequestHash: 'h',
      patient: { kind: 'self', name: 'Asha' }, visitMode: 'lab', slot: { slotId: String(s!._id), date: s!.date, startTime: '08:00', endTime: '08:30',
        startsAt: new Date(Date.now() - 2 * 3_600_000) },
      items: [{ itemId: 'i', name: 'CBC', priceMinor: 50000, kind: 'test' }], pricing: { ...pricing, commissionMinor: 0, currency: 'INR' },
      settlement: { settlementAccountId: String(labAcct!._id), beneficiaryName: 'Metro Lab', settlementSystem: 'ledger' }, status: 'confirmed', statusVersion: 3, paymentStatus: 'paid',
      paymentDeadline: new Date(), report: { draftFiles: [], releasedFiles: [], releases: [] }, reschedule: { version: 0, pending: false }, lifecycle: {},
      createdAt: new Date(), updatedAt: new Date() } as never);
    await PartnerSlotModel.updateOne({ _id: s!._id }, { $inc: { booked: 1 } });
    return String(_id);
  };

  await check('lab: the earning is the price after the coupon; completion needs collection/visit first (never straight from confirmed)', async () => {
    const u = await customer();
    const id = await labBooking(u.id, { subtotalMinor: 50000, discountMinor: 10000, payableMinor: 40000 });
    await assert.rejects(() => labSvc.complete(labOwn, id), code('LAB_BOOKING_STATE_CONFLICT'));
    await PartnerLabBookingModel.updateOne({ _id: id }, { $set: { status: 'report_ready' } });
    await labSvc.complete(labOwn, id);
    assert.deepEqual((await earnings(id)).map((e) => e.amountMinor), [40000]);
  });

  await check('re-review N6: a lab no-show only after the arrival window ENDS (not as soon as it opens)', async () => {
    const u = await customer();
    const id = await labBooking(u.id);
    await PartnerLabBookingModel.updateOne({ _id: id }, { $set: { 'slot.startsAt': new Date(Date.now() - 10 * MIN) } }); // 08:00–08:30 window, opened 10 min ago
    await assert.rejects(() => labSvc.markNoShow(labOwn, id, new Date()), code('SLOT_NOT_STARTED'));
    assert.equal(((await labSvc.markNoShow(labOwn, id, new Date(Date.now() + 21 * MIN))) as any).status, 'no_show');
  });

  await check('lab: a moved no-show is cancelled by an admin only, with or without a refund', async () => {
    const moved = async (u: string) => {
      const id = await labBooking(u);
      await labSvc.markNoShow(labOwn, id, new Date());
      await labSvc.rescheduleNoShow(labOwn, id, { slotId: String((await labSlot(4))!._id), requestKey: rk('labns') });
      return id;
    };
    const u = await customer();
    const id = await moved(u.id);
    await assert.rejects(() => labSvc.customerCancel(u.id, id, 'x'), code('NO_SHOW_NOT_REFUNDABLE'));
    await assert.rejects(() => labSvc.labReject(labOwn, id, 'x'), code('NO_SHOW_NOT_REFUNDABLE'));
    await PartnerLabBookingModel.updateOne({ _id: id }, { $set: { walletFunding: { total: 500, revision: 1, closed: false, captures: [] } } });
    const r = await labSvc.adminCancelMovedNoShow(ADMIN, id, { reason: 'Lab closed', refund: true });
    assert.deepEqual([r.refunded, (r.booking as any).status, (r.booking as any).paymentStatus], [500, 'cancelled', 'refunded']);
    assert.equal(await balance(u.id), 500);
    const u2 = await customer();
    const id2 = await moved(u2.id);
    const k = await labSvc.adminCancelMovedNoShow(ADMIN, id2, { reason: 'Lab closed', refund: false });
    assert.deepEqual([k.refunded, (k.booking as any).status, (k.booking as any).paymentStatus], [0, 'cancelled', 'paid']);
    assert.equal(await balance(u2.id), 0);
    await assert.rejects(() => labSvc.adminCancelMovedNoShow(ADMIN, id2, { reason: 'again', refund: true }), code('ALREADY_CANCELLED'));
    await assert.rejects(() => labSvc.adminCancelMovedNoShow(ADMIN, id, { reason: 'again', refund: false }), code('ALREADY_CANCELLED'));
    assert.ok(await PartnerAuditEventModel.exists({ partnerId: labId, action: 'lab_booking.no_show_cancelled' }));
    const plain = await labBooking(u2.id);
    await assert.rejects(() => labSvc.adminCancelMovedNoShow(ADMIN, plain, { reason: 'x', refund: true }), code('BOOKING_NOT_MOVED_NO_SHOW'));
  });

  // ───────────────────────────── HTTP: the new admin routes ─────────────────────────────
  const [{ default: specialistRouter }, { settlementAdminRouter, default: partnerRouter }, { instantRouter }] = await Promise.all([
    import('@/modules/specialists/routes'), import('@/modules/partners/routes'), import('@/modules/doctors/routes')]);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/specialists', authenticate, specialistRouter);
  app.use('/api/v1/settlements', authenticate, settlementAdminRouter);
  app.use('/api/v1/partner-workspace', authenticate, partnerRouter);
  app.use('/api/v1/instant', authenticate, instantRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, token: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const adminToken = jwt.sign({ _id: ADMIN, userType: 'admin' }, CONFIG.JWT_SECRET_KEY);
  try {
    await check('HTTP: admin unmarked list, admin cancel of a moved no-show (refund flag required; doctors refused), admin cancel of an accepted instant consult', async () => {
      const list = await call('GET', '/api/v1/settlements/unmarked-consultations?limit=1', adminToken);
      assert.equal(list.status, 200);
      assert.ok(Array.isArray(list.json.data) && typeof list.json.pagination.total === 'number' && 'nextCursor' in list.json.pagination);
      const u = await customer();
      const id = await movedNoShow(u.id, drM);
      const doctorToken = jwt.sign({ _id: drM, specialistId: drM, userType: 'specialist' }, CONFIG.JWT_SECRET_KEY);
      assert.equal((await call('POST', `/api/v1/specialists/admin/bookings/${id}/cancel-no-show`, doctorToken, { reason: 'x x x', refund: true })).status, 403);
      assert.equal((await call('POST', `/api/v1/specialists/admin/bookings/${id}/cancel-no-show`, adminToken, { reason: 'Doctor away' })).status, 400);
      const ok = await call('POST', `/api/v1/specialists/admin/bookings/${id}/cancel-no-show`, adminToken, { reason: 'Doctor away', refund: false });
      assert.deepEqual([ok.status, ok.json.data.status, ok.json.data.refunded], [200, 'cancelled', 0]);
      const lab = await call('POST', `/api/v1/partner-workspace/admin/lab-bookings/${await labBooking(u.id)}/cancel-no-show`, adminToken, { reason: 'Lab closed', refund: true });
      assert.deepEqual([lab.status, lab.json.code], [409, 'BOOKING_NOT_MOVED_NO_SHOW']);
      const d = await instantDoctor('Dr Http', 300, 'Httpology');
      const cu = await customer(300);
      const r = await instant.create(cu.id, ask('Httpology', { target: { kind: 'specific', doctorId: d } }));
      const acc = await instant.accept(d, String((r.request as any)._id));
      const c = await call('POST', `/api/v1/instant/admin/bookings/${acc.booking._id}/cancel`, adminToken, { reason: 'Doctor never joined' });
      assert.equal(c.status, 200);
      assert.equal(await balance(cu.id), 300, 'full refund');
    });
  } finally {
    server.close();
  }
  (CONFIG as any).SETTLEMENT_CUTOVER_AT = undefined;

  console.log(`\n${passed} checks passed${failed.length ? `, ${failed.length} FAILED: ${failed.join(' | ')}` : ''}`);
  if (failed.length) throw new Error(`${failed.length} checks failed`);
}

main().then(() => mongoose.disconnect()).catch(async (e) => { console.error(e?.message ?? e); await mongoose.disconnect(); process.exit(1); });
