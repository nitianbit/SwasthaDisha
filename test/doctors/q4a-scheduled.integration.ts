/**
 * Q4a: doctor interval reservations shared by every consultation path (overlap refusal under concurrency, rollback,
 * release on cancel/expiry, move on reschedule), per-mode slots, weekly template + leave expansion, clinic branches,
 * doctor cancellation (the former 409), no-show, ledger earnings, slot listing, backfill, HTTP schedule routes.
 *
 * Run (throwaway DB only; the script drops its collections):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q4a_doctor_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/doctors/q4a-scheduled.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express, { Router } from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { CONFIG } from '@/config/config';
import { authenticate, requireSpecialist } from '@/modules/middleware/auth';
import { errorHandler } from '@/modules/middleware';
import { validate } from '@/modules/common/middleware/validation';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import UserModel from '@/modules/user/model';
import SpecialistModel from '@/modules/specialists/model';
import SlotModel from '@/modules/slots/model';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import { createBookingWithHolds, cancelBookingSettlement, expireUnpaidBooking, rescheduleWithHolds } from '@/modules/bookings/holds';
import { SlotRepository } from '@/modules/slots/repository';
import { SlotService } from '@/modules/slots/services';
import PaymentRecordModel from '@/modules/payment/model';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository } from '@/modules/wallet/repository';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { DoctorReservationModel, DoctorScheduleGuardModel } from '@/modules/doctors/model/reservation';
import { DoctorScheduleTemplateModel } from '@/modules/doctors/model/schedule';
import { reserveInterval } from '@/modules/doctors/services/reservations';
import { saveTemplate, setLeave, expandDoctorSlots } from '@/modules/doctors/services/schedule';
import { Container } from 'typedi';
import { getMySchedule, putMySchedule, addMyLeave, removeMyLeave } from '@/modules/doctors/controller';
import { scheduleTemplateSchema, leaveSchema, leaveParamSchema } from '@/modules/doctors/validation';
import { runReservationBackfill } from '@/scripts/q4ReservationBackfill';
import { SettlementAccountModel, LedgerEntryModel } from '@/modules/partners/model/settlement';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { PartnerService } from '@/modules/partners/services';
import { addDays, istDate } from '@/modules/partners/services/slots';
import { ScheduleGuardModel } from '@/modules/partners/model/slot';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q4a_doctor_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const notified: { userId: string; type: string; key?: string }[] = [];
const bookings = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), walletRepository: new WalletRepository(),
  bookingReminderScheduler: { clearBookingReminders: async () => undefined, scheduleBookingReminders: async () => undefined },
  notificationService: {
    create: async (n: { userId: string; type: string; idempotencyKey?: string }) => { notified.push({ userId: n.userId, type: n.type, key: n.idempotencyKey }); },
    createSpecialistAppointmentCancelledNotification: async () => undefined,
  },
}) as BookingService;
const slotSvc = Object.assign(Object.create(SlotService.prototype), { slotRepository: new SlotRepository() }) as SlotService;

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) { await fn(); passed++; console.log('ok -', name); }
const code = (c: string) => (e: any) => e?.code === c;
const today = istDate(new Date());
const ymd = (iso: string) => iso.replace(/-/g, '');
let ph = 8100000000;

async function doctor(name = 'Dr Mehta') {
  const id = new Types.ObjectId();
  await SpecialistModel.collection.insertOne({ _id: id, name, phone: String(ph++), specialization: 'General Physician', consultationFee: 500,
    isActive: true, isVerified: true } as never);
  return String(id);
}
async function customer(wallet = 0) {
  const u = await UserModel.create({ phone: String(ph++), userType: 'user', name: 'Asha' } as any);
  await WalletModel.create({ userId: String(u._id), balance: wallet, isActive: true });
  return String(u._id);
}
async function slot(doctorId: string, dayOffset: number, start: string, end: string, over: Record<string, unknown> = {}) {
  const s = await SlotModel.create({ specialistId: doctorId, date: ymd(addDays(today, dayOffset)), startTime: start, endTime: end, duration: 30,
    slotType: 'consultation', maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true, ...over } as any);
  return String(s._id);
}
async function book(userId: string, doctorId: string, slotId: string, over: Record<string, unknown> = {}) {
  const s = await SlotModel.findById(slotId).lean() as any;
  return createBookingWithHolds({ bookingType: 'consultation', userId, specialistId: doctorId, doctorName: 'Dr', slotId, bookingDate: s.date,
    bookingTime: s.startTime, consultationMode: 'video', serviceMode: 'video', price: 500, originalPrice: 500, status: 'pending', paymentStatus: 'pending',
    ...over } as any);
}
const confirmPaid = (id: unknown) => BookingModel.updateOne({ _id: id }, { $set: { status: 'confirmed', paymentStatus: 'paid' } });
const activeFor = (doctorId: string) => DoctorReservationModel.find({ doctorId, isActive: true }).lean();

async function main() {
  await mongoose.connect(url, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [UserModel, SpecialistModel, SlotModel, BookingModel, PaymentRecordModel, WalletModel, WalletTransactionModel, DoctorReservationModel,
    DoctorScheduleGuardModel, DoctorScheduleTemplateModel, SettlementAccountModel, LedgerEntryModel, PartnerModel, MemberModel, BranchModel,
    PartnerAuditEventModel, ScheduleGuardModel] as mongoose.Model<any>[]) {
    await M.createCollection(); await M.createIndexes();
  }

  await check('interval admission is exclusive under concurrency; touching intervals coexist', async () => {
    const doc = await doctor();
    const base = new Date(Date.now() + 86_400_000);
    const at = (min: number) => new Date(base.getTime() + min * 60_000);
    const r = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      runLedgerTransaction((s) => reserveInterval({ doctorId: doc, kind: 'instant', refId: `r${i}`, start: at(i), end: at(30 + i) }, s))));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.ok(r.filter((x) => x.status === 'rejected').every((x: any) => x.reason?.code === 'DOCTOR_BUSY'));
    await runLedgerTransaction((s) => reserveInterval({ doctorId: doc, kind: 'instant', refId: 'after', start: at(60), end: at(90) }, s));
    await runLedgerTransaction((s) => reserveInterval({ doctorId: doc, kind: 'instant', refId: 'before', start: at(-30), end: at(0) }, s));
    assert.equal((await activeFor(doc)).length, 3);
  });

  const docA = await doctor('Dr Rao');
  await check('two one-patient slots at the same time: the second booking is refused and rolled back (seat not taken)', async () => {
    const s1 = await slot(docA, 2, '10:00', '10:30');
    const s2 = await slot(docA, 2, '10:15', '10:45');
    await book(await customer(), docA, s1);
    await assert.rejects(async () => book(await customer(), docA, s2), code('DOCTOR_BUSY'));
    assert.equal((await SlotModel.findById(s2).lean() as any).currentBookings, 0);
    assert.equal(await BookingModel.countDocuments({ slotId: s2 }), 0);
  });

  await check('slots sold to several patients keep only their counter; a mode-restricted slot refuses other modes', async () => {
    const group = await slot(docA, 3, '09:00', '09:30', { maxBookings: 2 });
    await book(await customer(), docA, group);
    await book(await customer(), docA, group);
    assert.equal(await DoctorReservationModel.countDocuments({ doctorId: docA, startTime: { $gte: new Date(Date.now() + 2.5 * 86_400_000) } }), 0);
    const videoOnly = await slot(docA, 3, '11:00', '11:30', { serviceModes: ['video'] });
    await assert.rejects(async () => book(await customer(), docA, videoOnly, { consultationMode: 'chat', serviceMode: 'chat' }), code('SLOT_NOT_AVAILABLE'));
    await book(await customer(), docA, videoOnly);
  });

  await check('cancellation and payment expiry free the interval', async () => {
    const s1 = await slot(docA, 4, '10:00', '10:30');
    const s1b = await slot(docA, 4, '10:00', '10:30');
    const u = await customer();
    const b = await book(u, docA, s1);
    await assert.rejects(async () => book(await customer(), docA, s1b), code('DOCTOR_BUSY'));
    await cancelBookingSettlement({ bookingId: String(b._id), requester: { _id: u, userType: 'user' }, reason: 'x', cancelledAt: '20261201',
      wallets: new WalletRepository(), enforceWindow: () => undefined, lifecycle: () => undefined as any });
    const b2 = await book(await customer(), docA, s1b);
    await BookingModel.collection.updateOne({ _id: b2._id as any }, { $set: { createdAt: new Date(Date.now() - 31 * 60_000) } });
    await expireUnpaidBooking({ bookingId: String(b2._id), now: new Date(), wallets: new WalletRepository(), cancelledAt: '20261201', lifecycle: () => undefined as any });
    assert.equal((await BookingModel.findById(b2._id).lean())!.status, 'cancelled');
    await book(await customer(), docA, s1);
  });

  await check('reschedule moves the interval; moving onto time another booking holds is refused and nothing changes', async () => {
    const a = await slot(docA, 5, '10:00', '10:30');
    const b = await slot(docA, 5, '11:00', '11:30');
    const c = await slot(docA, 5, '12:00', '12:30');
    const u = await customer();
    const first = await book(u, docA, a);
    await book(await customer(), docA, c);
    await rescheduleWithHolds({ bookingId: String(first._id), requester: { _id: u, userType: 'user' }, nextSlotId: b, patch: {} });
    const r = await DoctorReservationModel.findOne({ refId: String(first._id).toLowerCase() }).lean();
    assert.equal(r!.startTime.toISOString(), new Date(`${addDays(today, 5)}T11:00:00+05:30`).toISOString());
    const a2 = await slot(docA, 5, '10:00', '10:30');
    await book(await customer(), docA, a2);
    const c2 = await slot(docA, 5, '12:00', '12:30');
    await assert.rejects(() => rescheduleWithHolds({ bookingId: String(first._id), requester: { _id: u, userType: 'user' }, nextSlotId: c2, patch: {} }), code('DOCTOR_BUSY'));
    assert.equal((await BookingModel.findById(first._id).lean())!.slotId, b);
    assert.equal((await SlotModel.findById(c2).lean() as any).currentBookings, 0);
  });

  await check('doctor cancellation (formerly 409): full refund at any time, customer notified; another doctor cannot', async () => {
    const s1 = await slot(docA, 0, '23:30', '23:59');
    const u = await customer(500);
    const b = await book(u, docA, s1);
    await WalletModel.updateOne({ userId: u }, { $set: { balance: 0 } });
    await BookingModel.updateOne({ _id: b._id }, { $set: { status: 'confirmed', paymentStatus: 'paid', walletFunding: { total: 500, revision: 1, closed: false, captures: [] } } });
    const other = await doctor('Dr Other');
    await assert.rejects(() => bookings.cancelByDoctor(String(b._id), { _id: other, userType: 'specialist' }, 'x'), code('BOOKING_NOT_FOUND'));
    const c = await bookings.cancelByDoctor(String(b._id), { _id: docA, userType: 'specialist' }, 'Emergency surgery');
    assert.equal(c.status, 'cancelled');
    assert.equal((c as any).cancellationCause, 'doctor');
    assert.equal(Number((await WalletModel.findOne({ userId: u }).lean())!.balance), 500);
    assert.ok(notified.some((n) => n.userId === u && n.type === 'booking_cancelled'));
    assert.equal(await DoctorReservationModel.countDocuments({ refId: String(b._id).toLowerCase(), isActive: true }), 0);
    await assert.rejects(() => bookings.update(String(b._id), { status: 'no_show' } as any), code('DEDICATED_BOOKING_COMMAND_REQUIRED'));
  });

  await check('no-show only after the appointment, frees the interval, no refund; ledger bookings earn once', async () => {
    (CONFIG as any).SETTLEMENT_CUTOVER_AT = new Date(Date.now() - 60_000).toISOString();
    try {
      const s1 = await slot(docA, 6, '10:00', '10:30');
      const b = await book(await customer(), docA, s1, { price: 400, originalPrice: 500 });
      assert.equal(b.settlementSystem, 'ledger');
      assert.ok(b.settlement?.settlementAccountId, 'doctor settlement account snapshotted at creation');
      await confirmPaid(b._id);
      await assert.rejects(() => bookings.markNoShow(String(b._id), { _id: docA, userType: 'specialist' }), code('APPOINTMENT_NOT_STARTED'));
      const later = new Date(Date.now() + 7 * 86_400_000);
      const ns = await bookings.markNoShow(String(b._id), { _id: docA, userType: 'specialist' }, later);
      assert.equal(ns.status, 'no_show');
      assert.equal(await DoctorReservationModel.countDocuments({ refId: String(b._id).toLowerCase(), isActive: true }), 0);
      const e = await LedgerEntryModel.find({ source: 'consultation', sourceId: String(b._id) }).lean();
      assert.deepEqual(e.map((x) => [x.kind, x.amountMinor]), [['earning', 50000]], 'earns the pre-coupon price');
      await assert.rejects(() => bookings.markNoShow(String(b._id), { _id: docA, userType: 'specialist' }, later), code('BOOKING_STATE_CONFLICT'));

      const s2 = await slot(docA, 6, '11:00', '11:30');
      const b2 = await book(await customer(), docA, s2);
      await confirmPaid(b2._id);
      await bookings.update(String(b2._id), { status: 'completed' } as any);
      await bookings.update(String(b2._id), { status: 'completed' } as any); // a repeat is a no-op: no second earning
      assert.equal(await LedgerEntryModel.countDocuments({ source: 'consultation', sourceId: String(b2._id) }), 1);
    } finally { (CONFIG as any).SETTLEMENT_CUTOVER_AT = undefined; }
    const s3 = await slot(docA, 6, '12:00', '12:30');
    const legacy = await book(await customer(), docA, s3);
    assert.equal(legacy.settlementSystem, 'legacy');
    await confirmPaid(legacy._id);
    await bookings.update(String(legacy._id), { status: 'completed' } as any);
    assert.equal(await LedgerEntryModel.countDocuments({ sourceId: String(legacy._id) }), 0, 'legacy bookings belong to the legacy payouts');
  });

  const docT = await doctor('Dr Template');
  await check('weekly template expands idempotently with per-mode windows; a hand-made slot at the same start is kept', async () => {
    const d1 = addDays(today, 1);
    await SlotModel.create({ specialistId: docT, date: ymd(d1), startTime: '09:00', endTime: '09:30', duration: 30, slotType: 'consultation',
      maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true } as any);
    const all = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [
      { start: '09:00', end: '10:00', modes: ['video', 'call'] }, { start: '18:00', end: '19:00', modes: ['chat'] },
    ]]));
    const r = await saveTemplate(docT, { slotMinutes: 30, days: all as any });
    assert.equal(r.expansion.inserted, 30 * 4 - 1);
    assert.equal((await expandDoctorSlots(docT, today, 30)).inserted, 0);
    assert.equal(await SlotModel.countDocuments({ specialistId: docT, date: ymd(d1), startTime: '09:00' }), 1);
    const evening = await SlotModel.findOne({ specialistId: docT, date: ymd(d1), startTime: '18:00' }).lean() as any;
    assert.deepEqual(evening.serviceModes, ['chat']);
  });

  await check('leave closes every slot that day (holds kept); removing it reopens only what leave closed', async () => {
    const d2 = addDays(today, 2);
    const booked = await SlotModel.findOne({ specialistId: docT, date: ymd(d2), startTime: '09:00' }).lean() as any;
    await book(await customer(), docT, String(booked._id));
    const manualOff = await SlotModel.findOne({ specialistId: docT, date: ymd(d2), startTime: '18:30' }).lean() as any;
    await SlotModel.updateOne({ _id: manualOff._id }, { $set: { isActive: false } });
    await setLeave(docT, ymd(d2), true);
    const onLeave = await SlotModel.find({ specialistId: docT, date: ymd(d2) }).lean() as any[];
    assert.ok(onLeave.every((s) => s.isActive === false));
    assert.equal(onLeave.find((s) => s.startTime === '09:00').currentBookings, 1);
    await setLeave(docT, ymd(d2), false);
    const back = await SlotModel.find({ specialistId: docT, date: ymd(d2) }).lean() as any[];
    assert.equal(back.find((s) => s.startTime === '09:00').isActive, true);
    assert.equal(back.find((s) => s.startTime === '09:00').isAvailable, false, 'still full');
    assert.equal(back.find((s) => s.startTime === '09:30').isAvailable, true);
    assert.equal(back.find((s) => s.startTime === '18:30').isActive, false, 'a manual closure stays');
  });

  await check('template change closes unwanted template slots (bookings kept) and refreshes modes only where unbooked', async () => {
    const d2 = addDays(today, 2);
    const only = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start: '09:00', end: '10:00', modes: ['video'] }]]));
    await saveTemplate(docT, { slotMinutes: 30, days: only as any });
    const rows = await SlotModel.find({ specialistId: docT, date: ymd(d2) }).lean() as any[];
    assert.ok(rows.filter((s) => s.startTime >= '18:00').every((s) => s.isActive === false));
    assert.deepEqual(rows.find((s) => s.startTime === '09:30').serviceModes, ['video']);
    assert.deepEqual(rows.find((s) => s.startTime === '09:00').serviceModes, ['video', 'call'], 'a booked slot keeps its terms');
    assert.equal(rows.find((s) => s.startTime === '09:00').currentBookings, 1);
  });

  await check('concurrent doctor expansions never publish a stale template; impossible leave dates and leave days are refused', async () => {
    const docC = await doctor('Dr Concurrent');
    const every = (start: string, end: string) => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start, end, modes: ['video'] }]]));
    const d = ymd(addDays(today, 4));
    for (let round = 0; round < 3; round++) {
      await saveTemplate(docC, { slotMinutes: 30, days: every('08:00', '09:00') as any });
      await Promise.all([expandDoctorSlots(docC, today, 30), saveTemplate(docC, { slotMinutes: 30, days: every('15:00', '16:00') as any }), expandDoctorSlots(docC, today, 30)]);
      const open = (await SlotModel.find({ specialistId: docC, date: d, isActive: true }).lean() as any[]).map((x) => x.startTime).sort();
      assert.deepEqual(open, ['15:00', '15:30'], `round ${round}`);
    }
    await assert.rejects(() => setLeave(docC, '20270231', true), code('INVALID_DATE'));
    // A leave day is refused at booking even on a slot that was left open.
    const leaveDay = ymd(addDays(today, 6));
    await setLeave(docC, leaveDay, true);
    const open = await SlotModel.findOne({ specialistId: docC, date: leaveDay, startTime: '15:00' }).lean() as any;
    await SlotModel.updateOne({ _id: open._id }, { $set: { isActive: true, isAvailable: true }, $unset: { closedReason: 1 } });
    await assert.rejects(async () => book(await customer(), docC, String(open._id)), code('SLOT_NOT_AVAILABLE'));
  });

  await check('clinic windows: only for a clinic the doctor works at (verified, in-clinic branch), in-person only', async () => {
    const partners = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
    const { partner, owner } = await partners.createPartner({ kind: 'clinic', name: 'City Clinic', contactPhone: String(ph++), invoiceSeriesPrefix: 'CC',
      firstOwner: { phone: String(ph++), name: 'Owner' } });
    await partners.verifyPartner(String(partner._id), 'admin');
    const actor = { memberId: String(owner._id), partnerId: String(partner._id), role: 'owner' as const, permissions: [], branchIds: [] };
    const br = await partners.createBranch(actor as any, { name: 'Main', phone: '9876500000', holidays: [], hours: {},
      services: { homeCollection: false, inLab: false, inClinic: true }, address: { line1: 'x', city: 'y', state: 'z', stateCode: '29', pincode: '560001' } } as any);
    const win = (modes: string[]) => ({ slotMinutes: 30, days: { mon: [{ start: '14:00', end: '15:00', modes, branchId: String(br._id) }] } as any });
    await assert.rejects(() => saveTemplate(docT, win(['in-person'])), code('CLINIC_BRANCH_NOT_ALLOWED'));
    await MemberModel.create({ partnerId: String(partner._id), phone: String(ph++), name: 'Dr Template', role: 'staff', permissions: [], branchIds: [],
      doctorId: docT, isActive: true });
    await assert.rejects(() => saveTemplate(docT, win(['video'])), code('INVALID_WINDOW'));
    await saveTemplate(docT, win(['in-person']));
    const mon = await SlotModel.findOne({ specialistId: docT, startTime: '14:00', branchId: String(br._id) }).lean();
    assert.ok(mon, 'clinic slot generated');
  });

  await check('slot listing filters by mode and hides time the doctor already holds elsewhere', async () => {
    const docL = await doctor('Dr List');
    const d = addDays(today, 8);
    await slot(docL, 8, '10:00', '10:30', { serviceModes: ['video'] });
    await slot(docL, 8, '10:30', '11:00', { serviceModes: ['chat'] });
    await slot(docL, 8, '11:00', '11:30');
    await runLedgerTransaction((s) => reserveInterval({ doctorId: docL, kind: 'instant', refId: 'instant-1',
      start: new Date(`${d}T11:10:00+05:30`), end: new Date(`${d}T11:40:00+05:30`) }, s));
    const video = await slotSvc.getAvailableSlots(docL, undefined, ymd(d), 'video');
    assert.deepEqual(video.map((s) => s.startTime).sort(), ['10:00']);
    const all = await slotSvc.getAvailableSlots(docL, undefined, ymd(d));
    assert.deepEqual(all.map((s) => s.startTime).sort(), ['10:00', '10:30']);
  });

  await check('backfill gives existing future one-patient bookings their interval once and lists existing overlaps', async () => {
    const docB = await doctor('Dr Backfill');
    const s1 = await slot(docB, 9, '10:00', '10:30');
    const s2 = await slot(docB, 9, '10:00', '10:30');
    const raw = async (slotId: string) => {
      const s = await SlotModel.findById(slotId).lean() as any;
      const _id = new Types.ObjectId();
      await BookingModel.collection.insertOne({ _id, bookingType: 'consultation', userId: 'u', specialistId: docB, slotId, bookingDate: s.date,
        bookingTime: s.startTime, serviceMode: 'video', price: 500, status: 'confirmed', paymentStatus: 'paid' } as never);
      return String(_id);
    };
    const first = await raw(s1);
    const second = await raw(s2);
    const dry = await runReservationBackfill(false);
    assert.ok(dry.candidates >= 2);
    const r1 = await runReservationBackfill(true);
    assert.ok(r1.conflicts.includes(second));
    assert.equal(await DoctorReservationModel.countDocuments({ refId: first, isActive: true }), 1);
    const r2 = await runReservationBackfill(true);
    assert.equal(await DoctorReservationModel.countDocuments({ refId: first }), 1, 'idempotent');
    assert.ok(r2.conflicts.includes(second));
  });

  // ── Review findings (Q4a round 1) ──
  await check('manual slots in h:mm AM/PM (the slot API output) get the right interval; listing reads them too', async () => {
    const docM = await doctor('Dr Manual');
    const isoD = addDays(today, 10);
    const date = ymd(isoD);
    const morning = await slotSvc.create({ specialistId: docM, date, startTime: '9:00 AM', endTime: '10:00 AM', duration: 30, slotType: 'consultation' } as any);
    const night = await slotSvc.create({ specialistId: docM, date, startTime: '10:00 PM', endTime: '10:30 PM', duration: 30, slotType: 'consultation' } as any);
    const noon = await slotSvc.create({ specialistId: docM, date, startTime: '12:30 PM', endTime: '1:00 PM', duration: 30, slotType: 'consultation' } as any);
    assert.deepEqual(morning.map((s) => s.startTime), ['9:00 AM', '9:30 AM']);
    const at = (hm: string) => new Date(`${isoD}T${hm}:00+05:30`).toISOString();
    const held = async (b: any) => DoctorReservationModel.findOne({ refId: String(b._id).toLowerCase(), isActive: true }).lean();
    const b1 = await book(await customer(), docM, String(morning[0]!._id));
    const b2 = await book(await customer(), docM, String(night[0]!._id));
    const b3 = await book(await customer(), docM, String(noon[0]!._id));
    assert.deepEqual([(await held(b1))!.startTime.toISOString(), (await held(b1))!.endTime.toISOString()], [at('09:00'), at('09:30')]);
    assert.equal((await held(b2))!.startTime.toISOString(), at('22:00'), '10:00 PM is not reserved twelve hours early');
    assert.deepEqual([(await held(b3))!.startTime.toISOString(), (await held(b3))!.endTime.toISOString()], [at('12:30'), at('13:00')]);
    assert.deepEqual((await slotSvc.getAvailableSlots(docM, undefined, date)).map((s) => s.startTime), ['9:30 AM']);
    await runLedgerTransaction((s) => reserveInterval({ doctorId: docM, kind: 'instant', refId: 'manual-instant', start: new Date(at('09:40')), end: new Date(at('09:50')) }, s));
    assert.deepEqual(await slotSvc.getAvailableSlots(docM, undefined, date), []);
  });

  await check('completed and no-show are terminal: no writer reopens them, so no refund can follow an earning', async () => {
    (CONFIG as any).SETTLEMENT_CUTOVER_AT = new Date(Date.now() - 60_000).toISOString();
    try {
      const docZ = await doctor('Dr Terminal');
      const u = await customer();
      const b = await book(u, docZ, await slot(docZ, 11, '10:00', '10:30'));
      await BookingModel.updateOne({ _id: b._id }, { $set: { status: 'confirmed', paymentStatus: 'paid', walletFunding: { total: 500, revision: 1, closed: false, captures: [] } } });
      await bookings.update(String(b._id), { status: 'completed' } as any);
      for (const st of ['confirmed', 'pending']) await assert.rejects(() => bookings.update(String(b._id), { status: st } as any), code('BOOKING_TERMINAL'));
      await assert.rejects(() => bookings.cancelByDoctor(String(b._id), { _id: docZ, userType: 'specialist' }, 'x'), code('BOOKING_NOT_CANCELLABLE'));
      await bookings.update(String(b._id), { notes: 'follow up in a week' } as any); // non-status edits stay possible
      assert.equal((await BookingModel.findById(b._id).lean())!.status, 'completed');
      assert.equal(Number((await WalletModel.findOne({ userId: u }).lean())!.balance), 0, 'no refund');
      assert.equal(await LedgerEntryModel.countDocuments({ source: 'consultation', sourceId: String(b._id) }), 1);

      const n = await book(await customer(), docZ, await slot(docZ, 11, '11:00', '11:30'));
      await confirmPaid(n._id);
      await bookings.markNoShow(String(n._id), { _id: docZ, userType: 'specialist' }, new Date(Date.now() + 12 * 86_400_000));
      await assert.rejects(() => bookings.update(String(n._id), { status: 'confirmed' } as any), code('BOOKING_TERMINAL'));
      await assert.rejects(() => bookings.cancelByDoctor(String(n._id), { _id: docZ, userType: 'specialist' }, 'x'), code('BOOKING_NOT_CANCELLABLE'));
      assert.equal((await BookingModel.findById(n._id).lean())!.status, 'no_show');

      // Unpaid ledger consultation: completion refused (it would never earn); once paid it completes and earns once.
      const unpaid = await book(await customer(), docZ, await slot(docZ, 11, '12:00', '12:30'));
      await BookingModel.updateOne({ _id: unpaid._id }, { $set: { status: 'confirmed' } });
      await assert.rejects(() => bookings.update(String(unpaid._id), { status: 'completed' } as any), code('BOOKING_NOT_PAID'));
      assert.equal((await BookingModel.findById(unpaid._id).lean())!.status, 'confirmed');
      await confirmPaid(unpaid._id);
      await bookings.update(String(unpaid._id), { status: 'completed' } as any);
      assert.equal(await LedgerEntryModel.countDocuments({ source: 'consultation', sourceId: String(unpaid._id), kind: 'earning' }), 1);
    } finally { (CONFIG as any).SETTLEMENT_CUTOVER_AT = undefined; }
  });

  await check('a consultation-type change is admitted against the slot on every path (same-slot reschedule, generic edit)', async () => {
    const docV = await doctor('Dr Modes');
    const s1 = await slot(docV, 12, '10:00', '10:30', { serviceModes: ['video'] });
    const u = await customer();
    const b = await book(u, docV, s1);
    await assert.rejects(() => rescheduleWithHolds({ bookingId: String(b._id), requester: { _id: u, userType: 'user' }, nextSlotId: s1,
      patch: { consultationMode: 'chat' } }), code('SLOT_NOT_AVAILABLE'));
    await assert.rejects(() => bookings.update(String(b._id), { consultationMode: 'chat' } as any), code('SLOT_NOT_AVAILABLE'));
    assert.equal((await BookingModel.findById(b._id).lean())!.consultationMode, 'video');
    await rescheduleWithHolds({ bookingId: String(b._id), requester: { _id: u, userType: 'user' }, nextSlotId: s1, patch: { notes: 'same slot, same mode' } });
  });

  await check('a mode edit validated against the old slot cannot land after a reschedule moved the booking (conflict, nothing written)', async () => {
    const docW = await doctor('Dr Window');
    const a = await slot(docW, 14, '10:00', '10:30', { serviceModes: ['video', 'chat'] });
    const b = await slot(docW, 14, '11:00', '11:30', { serviceModes: ['video'] });
    const u = await customer();
    const bk = await book(u, docW, a);
    const stale = await BookingModel.findById(bk._id).lean();
    await rescheduleWithHolds({ bookingId: String(bk._id), requester: { _id: u, userType: 'user' }, nextSlotId: b, patch: {} });
    // The edit read the booking before the reschedule committed (its admission saw slot A, which offers chat).
    const racing = Object.assign(Object.create(Object.getPrototypeOf(bookings)), bookings, { getById: async () => stale });
    await assert.rejects(() => racing.update(String(bk._id), { consultationMode: 'chat' } as any), code('BOOKING_CHANGED'));
    const now = await BookingModel.findById(bk._id).lean();
    assert.deepEqual([now!.slotId, now!.consultationMode], [b, 'video']);

    // The same interleaving with an explicit UNCHANGED mode: the edit read slot C (video) and the booking was moved to a
    // chat-only slot D and switched to chat meanwhile; re-sending 'video' must not land on D.
    const c = await slot(docW, 16, '10:00', '10:30', { serviceModes: ['video'] });
    const d = await slot(docW, 16, '11:00', '11:30', { serviceModes: ['chat'] });
    const bk2 = await book(u, docW, c);
    const stale2 = await BookingModel.findById(bk2._id).lean();
    await rescheduleWithHolds({ bookingId: String(bk2._id), requester: { _id: u, userType: 'user' }, nextSlotId: d, patch: { consultationMode: 'chat' } });
    const racing2 = Object.assign(Object.create(Object.getPrototypeOf(bookings)), bookings, { getById: async () => stale2 });
    await assert.rejects(() => racing2.update(String(bk2._id), { consultationMode: 'video', notes: 'Reviewed' } as any), code('BOOKING_CHANGED'));
    const now2 = await BookingModel.findById(bk2._id).lean();
    assert.deepEqual([now2!.slotId, now2!.consultationMode, now2!.notes ?? null], [d, 'chat', null]);
  });

  await check('backfill fences each candidate with a definite version write', async () => {
    const docV = await doctor('Dr Version');
    const sid = await slot(docV, 15, '10:00', '10:30', { currentBookings: 1, isAvailable: false });
    const s = await SlotModel.findById(sid).lean() as any;
    const _id = new Types.ObjectId();
    await BookingModel.collection.insertOne({ _id, bookingType: 'consultation', userId: 'u', specialistId: docV, slotId: sid, bookingDate: s.date,
      bookingTime: s.startTime, serviceMode: 'video', price: 500, status: 'confirmed', paymentStatus: 'paid', __v: 3 } as never);
    await runReservationBackfill(true);
    assert.equal(((await BookingModel.collection.findOne({ _id })) as any).__v, 4);
    assert.equal(await DoctorReservationModel.countDocuments({ refId: String(_id), isActive: true }), 1);
  });

  await check('clinic authority is current: removal, branch closure or suspension stop new clinic slots and bookings; made bookings stay', async () => {
    const partners = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
    const { partner, owner } = await partners.createPartner({ kind: 'clinic', name: 'Lake Clinic', contactPhone: String(ph++), invoiceSeriesPrefix: 'LC',
      firstOwner: { phone: String(ph++), name: 'Owner' } });
    await partners.verifyPartner(String(partner._id), 'admin');
    const actor = { memberId: String(owner._id), partnerId: String(partner._id), role: 'owner' as const, permissions: [], branchIds: [] };
    const br = await partners.createBranch(actor as any, { name: 'Lake', phone: '9876500001', holidays: [], hours: {},
      services: { homeCollection: false, inLab: false, inClinic: true }, address: { line1: 'x', city: 'y', state: 'z', stateCode: '29', pincode: '560001' } } as any);
    const docK = await doctor('Dr Clinic');
    const member = await MemberModel.create({ partnerId: String(partner._id), phone: String(ph++), name: 'Dr Clinic', role: 'staff', permissions: [], branchIds: [],
      doctorId: docK, isActive: true });
    const branchId = String(br._id);
    const days = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start: '14:00', end: '15:00', modes: ['in-person'], branchId }]]));
    await saveTemplate(docK, { slotMinutes: 30, days: days as any });
    const day = (n: number) => ymd(addDays(today, n));
    const at = async (n: number, t: string) => String((await SlotModel.findOne({ specialistId: docK, date: day(n), startTime: t }).lean() as any)._id);
    const inPerson = { consultationMode: 'in-person', serviceMode: 'in-person' };
    const kept = await book(await customer(), docK, await at(2, '14:00'), inPerson);
    const openCount = () => SlotModel.countDocuments({ specialistId: docK, branchId, isActive: true });

    await MemberModel.updateOne({ _id: member._id }, { $set: { isActive: false } });
    await assert.rejects(async () => book(await customer(), docK, await at(3, '14:00'), inPerson), code('SLOT_NOT_AVAILABLE'), 'refused before any expansion');
    await expandDoctorSlots(docK, today, 30);
    assert.equal(await openCount(), 0, 'expansion closes the clinic slots');
    assert.equal((await BookingModel.findById(kept._id).lean())!.status, 'pending', 'the booking already made stays');
    assert.equal((await SlotModel.findById(await at(2, '14:00')).lean() as any).currentBookings, 1);

    await MemberModel.updateOne({ _id: member._id }, { $set: { isActive: true } });
    await expandDoctorSlots(docK, today, 30);
    assert.ok(await openCount() > 0, 'authority back: slots reopen');
    const probe = await at(4, '14:30');
    await BranchModel.updateOne({ _id: br._id }, { $set: { isActive: false } });
    await assert.rejects(async () => book(await customer(), docK, probe, inPerson), code('SLOT_NOT_AVAILABLE'));
    await BranchModel.updateOne({ _id: br._id }, { $set: { isActive: true } });
    await PartnerModel.updateOne({ _id: partner._id }, { $set: { isActive: false } });
    await assert.rejects(async () => book(await customer(), docK, probe, inPerson), code('SLOT_NOT_AVAILABLE'));
    assert.equal((await SlotModel.findById(probe).lean() as any).currentBookings, 0, 'refusals take no seat');
    await PartnerModel.updateOne({ _id: partner._id }, { $set: { isActive: true } });
    await book(await customer(), docK, probe, inPerson);
  });

  await check('leave beyond the rolling window closes that day at once and is refused at booking; removing it reopens', async () => {
    const docF = await doctor('Dr Far');
    const far = await slot(docF, 40, '10:00', '10:30');
    const farDay = ymd(addDays(today, 40));
    await setLeave(docF, farDay, true);
    assert.equal((await SlotModel.findById(far).lean() as any).isActive, false);
    await SlotModel.updateOne({ _id: far }, { $set: { isActive: true, isAvailable: true }, $unset: { closedReason: 1 } }); // even if reopened by hand
    await assert.rejects(async () => book(await customer(), docF, far), code('SLOT_NOT_AVAILABLE'));
    await SlotModel.updateOne({ _id: far }, { $set: { isActive: false, isAvailable: false, closedReason: 'leave' } });
    await setLeave(docF, farDay, false);
    assert.equal((await SlotModel.findById(far).lean() as any).isActive, true);
    assert.equal(await SlotModel.countDocuments({ specialistId: docF, date: farDay }), 1, 'no template slots generated outside the window');
    await book(await customer(), docF, far);
  });

  await check('backfill never leaves an interval on a booking cancelled while it runs; it reads AM/PM slots', async () => {
    const docR = await doctor('Dr Race');
    for (let round = 0; round < 4; round++) {
      const u = await customer();
      const sid = await slot(docR, 13 + round, '9:00 AM', '9:30 AM', { currentBookings: 1, isAvailable: false });
      const s = await SlotModel.findById(sid).lean() as any;
      const _id = new Types.ObjectId();
      await BookingModel.collection.insertOne({ _id, bookingType: 'consultation', userId: u, specialistId: docR, slotId: sid, bookingDate: s.date,
        bookingTime: s.startTime, serviceMode: 'video', price: 500, status: 'confirmed', paymentStatus: 'pending' } as never);
      await Promise.all([runReservationBackfill(true), cancelBookingSettlement({ bookingId: String(_id), requester: { _id: u, userType: 'user' }, reason: 'x',
        cancelledAt: '20261201', wallets: new WalletRepository(), enforceWindow: () => undefined, lifecycle: () => undefined as any })]);
      assert.equal((await BookingModel.findById(_id).lean())!.status, 'cancelled');
      assert.equal(await DoctorReservationModel.countDocuments({ refId: String(_id), isActive: true }), 0, `round ${round}`);
    }
    const u = await customer();
    const sid = await slot(docR, 20, '9:00 AM', '9:30 AM', { currentBookings: 1, isAvailable: false });
    const s = await SlotModel.findById(sid).lean() as any;
    const _id = new Types.ObjectId();
    await BookingModel.collection.insertOne({ _id, bookingType: 'consultation', userId: u, specialistId: docR, slotId: sid, bookingDate: s.date,
      bookingTime: s.startTime, serviceMode: 'video', price: 500, status: 'confirmed', paymentStatus: 'paid' } as never);
    await runReservationBackfill(true);
    const r = await DoctorReservationModel.findOne({ refId: String(_id), isActive: true }).lean();
    assert.equal(r!.startTime.toISOString(), new Date(`${addDays(today, 20)}T09:00:00+05:30`).toISOString());
  });

  // ── HTTP: the doctor's own schedule routes (real authenticate → requireSpecialist → controller) ──
  const r = Router();
  r.get('/me/schedule', requireSpecialist, catchAsync(getMySchedule));
  r.put('/me/schedule', requireSpecialist, validate(scheduleTemplateSchema, 'body'), catchAsync(putMySchedule));
  r.post('/me/leave', requireSpecialist, validate(leaveSchema, 'body'), catchAsync(addMyLeave));
  r.delete('/me/leave/:date', requireSpecialist, validate(leaveParamSchema, 'params'), catchAsync(removeMyLeave));
  const app = express();
  app.use(express.json());
  app.use('/api/v1/specialists', authenticate, r);
  Container.set(SlotService, slotSvc);
  const { default: slotRouter } = await import('@/modules/slots/routes');
  app.use('/api/v1/slots', slotRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const docH = await doctor('Dr Http');
  const token = jwt.sign({ _id: docH, specialistId: docH, userType: 'specialist' }, CONFIG.JWT_SECRET_KEY);
  const call = async (method: string, p: string, t: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  try {
    await check('HTTP: a doctor sets the weekly schedule and a leave day; bad windows are refused', async () => {
      const put = await call('PUT', '/api/v1/specialists/me/schedule', token, { slotMinutes: 30, days: { [(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])[new Date(Date.parse(addDays(today, 3))).getUTCDay()]!]: [{ start: '10:00', end: '11:00', modes: ['video'] }] } });
      assert.equal(put.status, 200);
      assert.ok(put.json.data.expansion.inserted >= 8);
      const bad = await call('PUT', '/api/v1/specialists/me/schedule', token, { slotMinutes: 30, days: { mon: [{ start: '10:00', end: '11:00', modes: [] }] } });
      assert.equal(bad.status, 400);
      const leave = await call('POST', '/api/v1/specialists/me/leave', token, { date: ymd(addDays(today, 3)) });
      assert.equal(leave.status, 200);
      assert.equal(await SlotModel.countDocuments({ specialistId: docH, date: ymd(addDays(today, 3)), isActive: true }), 0);
      assert.equal((await call('DELETE', `/api/v1/specialists/me/leave/${ymd(addDays(today, 3))}`, token)).status, 200);
      assert.equal(await SlotModel.countDocuments({ specialistId: docH, date: ymd(addDays(today, 3)), isActive: true }), 2);
      const userToken = jwt.sign({ _id: await customer(), userType: 'user', authVersion: 0 }, CONFIG.JWT_SECRET_KEY);
      assert.equal((await call('GET', '/api/v1/specialists/me/schedule', userToken)).status, 403);
    });
    await check('HTTP: GET /slots/available keeps the mode filter through validation', async () => {
      const docQ = await doctor('Dr Query');
      const d = ymd(addDays(today, 21));
      await slot(docQ, 21, '10:00', '10:30', { serviceModes: ['video'] });
      await slot(docQ, 21, '10:30', '11:00', { serviceModes: ['chat'] });
      const res = await call('GET', `/api/v1/slots/available?specialistId=${docQ}&date=${d}&mode=video`, token);
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.data.map((s: any) => s.startTime), ['10:00']);
      assert.equal((await call('GET', `/api/v1/slots/available?specialistId=${docQ}&date=${d}&mode=fax`, token)).status, 400);
    });
  } finally {
    server.close();
  }

  await mongoose.disconnect();
  console.log(`\n${passed} checks passed`);
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
