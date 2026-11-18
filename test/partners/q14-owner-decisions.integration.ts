/**
 * Q14: the owner's decisions of 18 Nov 2026 — no earning for any no-show (doctor or lab) and one reschedule of a
 * no-show, desk appointment notifications after the commit, a bill linked to its appointment, family members at the
 * desk, mixed and part payments of in-house bills, and admin-only doctor linking with doctor-created clinics. Real
 * MongoDB replica set; the real partner-workspace and specialist routers for the HTTP checks.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed), so the suite can be run against the
 * code before Q14 to see each check fail.
 *
 * Run (throwaway DB only; the script drops its collections):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q14_owner_decisions_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx test/partners/q14-owner-decisions.integration.ts
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
import { createBookingWithHolds, rescheduleWithHolds } from '@/modules/bookings/holds';
import PaymentRecordModel from '@/modules/payment/model';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository } from '@/modules/wallet/repository';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import NotificationModel from '@/modules/notification/model';
import DependentModel from '@/modules/dependents/model';
import { DoctorReservationModel, DoctorScheduleGuardModel } from '@/modules/doctors/model/reservation';
import { DoctorScheduleTemplateModel } from '@/modules/doctors/model/schedule';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import CatalogueItemModel from '@/modules/partners/model/catalogueItem';
import { ClinicDoctorInviteModel } from '@/modules/partners/model/clinicDoctor';
import { InvoiceModel, InvoiceEventModel, InvoiceCounterModel } from '@/modules/partners/model/invoice';
import { SettlementAccountModel, LedgerEntryModel } from '@/modules/partners/model/settlement';
import { PartnerSlotModel, PartnerSlotTemplateModel, ScheduleGuardModel } from '@/modules/partners/model/slot';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { InvoiceRepository, InvoiceEventRepository, InvoiceCounterRepository } from '@/modules/partners/repository/invoice';
import { PartnerService, PartnerActor, adminActor } from '@/modules/partners/services';
import { InvoiceService } from '@/modules/partners/services/invoice';
import { renderInvoiceHtml } from '@/modules/partners/services/invoicePdf';
import { LabBookingService } from '@/modules/partners/services/labBookings';
import { saveSlotTemplate } from '@/modules/partners/services/slots';
import * as clinic from '@/modules/partners/services/clinic';
import { istDate, addDays } from '@/modules/partners/services/slots';
import { deskBookingSchema } from '@/modules/partners/validation/clinic';
import { recordPaymentSchema } from '@/modules/partners/validation/invoice';
import { SMSService } from '@/modules/sms/services';
import { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q14_owner_decisions_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const partnerRepo = new PartnerRepository();
const branchRepo = new BranchRepository();
const partnerSvc = new PartnerService(partnerRepo, new MemberRepository(), branchRepo);
Container.set(PartnerService, partnerSvc);
const sms = new SMSService();
sms.sendSMS = async () => ({ success: true, data: null });
const invoiceSvc = new InvoiceService(new InvoiceRepository(), new InvoiceEventRepository(), new InvoiceCounterRepository(), partnerRepo, branchRepo,
  new CatalogueItemRepository(), sms);
Container.set(InvoiceService, invoiceSvc);
const customerNotices: { userId: string; key?: string }[] = [];
const bookings = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), walletRepository: new WalletRepository(),
  bookingReminderScheduler: { clearBookingReminders: async () => undefined, scheduleBookingReminders: async () => undefined },
  notificationService: {
    create: async (n: { userId: string; idempotencyKey?: string }) => { customerNotices.push({ userId: n.userId, key: n.idempotencyKey }); },
    createSpecialistAppointmentCancelledNotification: async () => undefined,
  },
}) as BookingService;
Container.set(BookingService, bookings);
const labSvc = Object.create(LabBookingService.prototype) as LabBookingService;
const labNotices: string[] = [];
(labSvc as any).notify = async (n: { key: string }) => { labNotices.push(n.key); };
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
let ph = 7140000000;
const nextPhone = () => String(ph++);
let keySeq = 0;
const rk = (p = 'q14-key') => `${p}-${String(++keySeq).padStart(4, '0')}`;
const today = istDate(new Date());
const ymd = (iso: string) => iso.replace(/-/g, '');
const addr = { line1: '1 Road', city: 'Pune', state: 'Maharashtra', stateCode: '27', pincode: '411001' };
const clinicBranch = (name: string) => ({ name, phone: '9876500000', holidays: [], hours: {}, services: { homeCollection: false, inLab: false, inClinic: true }, address: addr }) as any;
const DAY = 86_400_000;

async function doctor(name: string, over: Record<string, unknown> = {}) {
  const id = new Types.ObjectId();
  await SpecialistModel.collection.insertOne({ _id: id, name, phone: nextPhone(), email: `${name.replace(/\W/g, '')}@x.test`, specialization: 'General Physician',
    consultationFee: 600, isActive: true, isVerified: true, ...over } as never);
  return String(id);
}
async function customer() {
  const u = await UserModel.create({ phone: nextPhone(), name: 'Asha', userType: 'user', otpVerified: true } as any);
  await WalletModel.create({ userId: String(u._id), balance: 0, isActive: true });
  return { id: String(u._id), phone: (u as any).phone as string };
}
/** A 30-minute slot of the doctor starting at `start` (India time); at a clinic branch when given. */
async function slotAt(doctorId: string, start: Date, branchId?: string) {
  const ist = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString();
  const s = ist(start);
  const e = ist(new Date(start.getTime() + 30 * 60_000));
  const row = await SlotModel.create({ specialistId: doctorId, date: s.slice(0, 10).replace(/-/g, ''), startTime: s.slice(11, 16), endTime: e.slice(11, 16),
    duration: 30, slotType: 'consultation', maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true,
    ...(branchId ? { serviceModes: ['in-person'], branchId } : {}) } as any);
  return String(row._id);
}
let slotN = 0;
const futureStart = () => new Date(new Date(`${addDays(today, 2)}T08:00:00+05:30`).getTime() + (slotN++) * 30 * 60_000);
async function onlineBooking(userId: string, doctorId: string, over: Record<string, unknown> = {}) {
  const slotId = await slotAt(doctorId, futureStart(), over.branchId as string | undefined);
  const s = await SlotModel.findById(slotId).lean() as any;
  const { branchId: _b, ...rest } = over;
  const b = await createBookingWithHolds({ bookingType: 'consultation', userId, specialistId: doctorId, doctorName: 'Dr', slotId, bookingDate: s.date,
    bookingTime: s.startTime, consultationMode: 'video', serviceMode: 'video', price: 400, originalPrice: 500, status: 'pending', paymentStatus: 'pending',
    ...rest } as any);
  await BookingModel.updateOne({ _id: b._id }, { $set: { status: 'confirmed', paymentStatus: 'paid' } });
  return String(b._id);
}
const earningsOf = (sourceId: string) => LedgerEntryModel.countDocuments({ sourceId, kind: 'earning' });
const later = () => new Date(Date.now() + 10 * DAY);

async function main() {
  await mongoose.connect(FIXTURE_URL, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [UserModel, SpecialistModel, SlotModel, BookingModel, PaymentRecordModel, WalletModel, WalletTransactionModel, RequestKeyModel,
    NotificationModel, DependentModel, DoctorReservationModel, DoctorScheduleGuardModel, DoctorScheduleTemplateModel, PartnerModel, MemberModel, BranchModel,
    PartnerAuditEventModel, CatalogueItemModel, ClinicDoctorInviteModel, InvoiceModel, InvoiceEventModel, InvoiceCounterModel, SettlementAccountModel,
    LedgerEntryModel, PartnerSlotModel, PartnerSlotTemplateModel, ScheduleGuardModel, PartnerLabBookingModel] as mongoose.Model<any>[]) {
    await M.createCollection(); await M.createIndexes();
  }
  const ADMIN = new Types.ObjectId().toHexString();
  const admin = (partnerId: string) => adminActor(ADMIN, partnerId);

  const notices: clinic.ClinicNotice[] = [];
  const committedAtSend: boolean[] = [];
  clinic.setClinicNotifier?.(async (n) => {
    notices.push(n);
    if (n.referenceType === 'booking') committedAtSend.push(!!(await BookingModel.exists({ _id: n.referenceId })));
  });
  // ── Fixtures: a verified clinic (two branches, a desk at A), another clinic, linked doctors ──
  const { partner: cp, owner: cOwner } = await partnerSvc.createPartner({ kind: 'clinic', name: 'Care Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'CC',
    firstOwner: { phone: nextPhone(), name: 'Owner' } } as any);
  const clinicId = String(cp._id);
  await partnerSvc.verifyPartner(clinicId, 'admin');
  const own = actorFor(cOwner);
  const A = String((await partnerSvc.createBranch(own, clinicBranch('Kothrud')))._id);
  const B = String((await partnerSvc.createBranch(own, clinicBranch('Baner')))._id);
  const deskM = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk', role: 'staff', branchIds: [A],
    permissions: ['bookings.view', 'bookings.manage', 'invoices.create', 'payments.record', 'invoices.cancel', 'staff.manage'] } as any);
  const desk = actorFor(deskM);
  const { partner: cp2, owner: c2Owner } = await partnerSvc.createPartner({ kind: 'clinic', name: 'Other Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'OC',
    firstOwner: { phone: nextPhone(), name: 'Owner 2' } } as any);
  const otherId = String(cp2._id);
  await partnerSvc.verifyPartner(otherId, 'admin');
  const other = actorFor(c2Owner);
  const OB = String((await partnerSvc.createBranch(other, clinicBranch('Aundh')))._id);
  const drC = await doctor('Dr Clinic');
  const drD = await doctor('Dr Second');
  const drO = await doctor('Dr Other');
  // Fixture links (before Q14, through the old invitation, so this suite can also be run against the earlier code).
  const linkFixture = async (ownerActor: PartnerActor, doctorId: string, branchIds: string[]) => {
    if (typeof (clinic as any).linkDoctor === 'function') return clinic.linkDoctor(admin(ownerActor.partnerId), { doctorId, branchIds, requestKey: rk('link') });
    const inv = await (clinic as any).inviteDoctor(ownerActor, { doctorId, branchIds });
    return clinic.respondToInvite(doctorId, String(inv.invite._id), true);
  };
  await linkFixture(own, drC, []);
  await linkFixture(own, drD, [A]);
  await linkFixture(other, drO, []);
  const deskSlot = async (doctorId = drC, branchId = A) => slotAt(doctorId, futureStart(), branchId);

  // ───────────────────────────── 1. No-shows: no earning, one reschedule ─────────────────────────────
  (CONFIG as any).SETTLEMENT_CUTOVER_AT = new Date(Date.now() - 60_000).toISOString();
  const drN = await doctor('Dr NoShow');
  await check('doctor: a no-show earns nothing and is not refunded; completion earns once', async () => {
    const u = await customer();
    const id = await onlineBooking(u.id, drN);
    assert.equal((await BookingModel.findById(id).lean())!.settlementSystem, 'ledger');
    const ns = await bookings.markNoShow(id, { _id: drN, userType: 'specialist' }, later());
    assert.equal(ns.status, 'no_show');
    assert.equal(await earningsOf(id), 0, 'no earning for a no-show');
    assert.equal(Number((await WalletModel.findOne({ userId: u.id }).lean())!.balance), 0, 'no refund');
    assert.equal((await BookingModel.findById(id).lean() as any).noShow.by, drN);
    const done = await onlineBooking(u.id, drN);
    await bookings.update(done, { status: 'completed' } as any);
    assert.equal(await earningsOf(done), 1);
  });

  await check('instant consultation: a no-show earns nothing and is never rescheduled', async () => {
    const u = await customer();
    const id = await onlineBooking(u.id, drN, { bookingKind: 'instant' });
    await bookings.markNoShow(id, { _id: drN, userType: 'specialist' }, later());
    assert.equal(await earningsOf(id), 0);
    await assert.rejects(() => bookings.rescheduleNoShow(id, { _id: drN, userType: 'specialist' }, { slotId: String(new Types.ObjectId()), requestKey: rk('ns') }),
      (e: any) => ['INSTANT_CONSULT_COMMAND_REQUIRED', 'SLOT_NOT_AVAILABLE'].includes(e?.code));
  });

  await check('doctor no-show rescheduled once: confirmed again, same price, replay by key; the customer cannot; no refund; completion earns once', async () => {
    const u = await customer();
    const id = await onlineBooking(u.id, drN);
    await bookings.markNoShow(id, { _id: drN, userType: 'specialist' }, later());
    const target = await slotAt(drN, futureStart());
    // The customer cannot move a no-show (no customer command; the ordinary reschedule refuses it).
    await assert.rejects(() => rescheduleWithHolds({ bookingId: id, requester: { _id: u.id, userType: 'user' }, nextSlotId: target, patch: {} }), code('BOOKING_NOT_RESCHEDULABLE'));
    await assert.rejects(() => bookings.rescheduleNoShow(id, { _id: drO, userType: 'specialist' }, { slotId: target, requestKey: rk('ns') }), code('BOOKING_NOT_FOUND'));
    const startedSlot = await slotAt(drN, new Date(Date.now() - 5 * 60_000));
    await assert.rejects(() => bookings.rescheduleNoShow(id, { _id: drN, userType: 'specialist' }, { slotId: startedSlot, requestKey: rk('ns') }), code('SLOT_STARTED'));
    const stale = new Date(0);
    await assert.rejects(() => bookings.rescheduleNoShow(id, { _id: drN, userType: 'specialist' }, { slotId: target, requestKey: rk('ns'), expectedUpdatedAt: stale }), code('BOOKING_CHANGED'));
    const key = rk('ns');
    const moved = await bookings.rescheduleNoShow(id, { _id: drN, userType: 'specialist' }, { slotId: target, requestKey: key });
    assert.deepEqual([moved.status, moved.slotId, moved.price, moved.paymentStatus, moved.replayed], ['confirmed', target, 400, 'paid', false]);
    assert.equal(moved.noShows!.length, 1);
    assert.equal(moved.noShows![0]!.by, drN);
    assert.equal((await SlotModel.findById(target).lean() as any).currentBookings, 1);
    assert.equal(await DoctorReservationModel.countDocuments({ refId: id, isActive: true }), 1, 'the doctor interval is held again');
    const again = await bookings.rescheduleNoShow(id, { _id: drN, userType: 'specialist' }, { slotId: target, requestKey: key });
    assert.equal(again.replayed, true);
    await assert.rejects(async () => bookings.rescheduleNoShow(id, { _id: drN, userType: 'specialist' }, { slotId: await slotAt(drN, futureStart()), requestKey: key }), code('IDEMPOTENCY_KEY_REUSED'));
    // No refund after a no-show: the customer cannot cancel it for money back.
    await assert.rejects(() => bookings.cancelBooking(id, { cancellationReason: 'x' }, { _id: u.id, userType: 'user' }), code('NO_SHOW_NOT_REFUNDABLE'));
    await bookings.update(id, { status: 'completed' } as any);
    await bookings.update(id, { status: 'completed' } as any);
    assert.equal(await earningsOf(id), 1, 'earns exactly once after the reschedule');
  });

  await check('a second no-show is final: a second reschedule is refused (admins too)', async () => {
    const u = await customer();
    const id = await onlineBooking(u.id, drN);
    await bookings.markNoShow(id, { _id: drN, userType: 'specialist' }, later());
    await bookings.rescheduleNoShow(id, { _id: ADMIN, userType: 'admin' }, { slotId: await slotAt(drN, futureStart()), requestKey: rk('ns') });
    await bookings.markNoShow(id, { _id: drN, userType: 'specialist' }, later());
    const next = await slotAt(drN, futureStart());
    await assert.rejects(() => bookings.rescheduleNoShow(id, { _id: ADMIN, userType: 'admin' }, { slotId: next, requestKey: rk('ns') }), code('NO_SHOW_RESCHEDULE_USED'));
    await assert.rejects(() => bookings.rescheduleNoShow(id, { _id: drN, userType: 'specialist' }, { slotId: next, requestKey: rk('ns') }), code('NO_SHOW_RESCHEDULE_USED'));
    assert.equal(await earningsOf(id), 0);
  });

  await check('desk no-show: the clinic moves it once (audited), the customer and doctor are told; a second time is refused', async () => {
    const made = await clinic.createDeskAppointment(desk, { slotId: await deskSlot(), customer: { phone: nextPhone() }, requestKey: rk('desk') });
    const id = made.booking.bookingId;
    await BookingModel.updateOne({ _id: id }, { $set: { bookingDate: ymd(addDays(today, -1)) } }); // the appointment time has passed
    await clinic.closeDeskAppointment(desk, id, 'no_show', new Date());
    const before = notices.length;
    const key = rk('ns');
    const target = await deskSlot();
    const moved = await clinic.rescheduleDeskNoShow(desk, id, { slotId: target, requestKey: key });
    assert.deepEqual([moved.status, moved.slotId, moved.replayed], ['confirmed', target, false]);
    assert.equal((await clinic.rescheduleDeskNoShow(desk, id, { slotId: target, requestKey: key })).replayed, true);
    assert.ok(await PartnerAuditEventModel.exists({ partnerId: clinicId, action: 'clinic.appointment_no_show_rescheduled' }));
    assert.deepEqual(notices.slice(before).map((n) => n.audience).sort(), ['customer', 'doctor']);
    await assert.rejects(() => clinic.rescheduleDeskNoShow(other, id, { slotId: target, requestKey: rk('ns') }), code('BOOKING_NOT_FOUND'));
    await BookingModel.updateOne({ _id: id }, { $set: { bookingDate: ymd(addDays(today, -1)) } });
    await clinic.closeDeskAppointment(desk, id, 'no_show', new Date());
    await assert.rejects(async () => clinic.rescheduleDeskNoShow(desk, id, { slotId: await deskSlot(), requestKey: rk('ns') }), code('NO_SHOW_RESCHEDULE_USED'));
  });

  // Lab fixtures
  const { partner: lp, owner: lOwner } = await partnerSvc.createPartner({ kind: 'lab', name: 'Metro Lab', contactPhone: nextPhone(), invoiceSeriesPrefix: 'ML',
    firstOwner: { phone: nextPhone(), name: 'Lab owner' } } as any);
  const labId = String(lp._id);
  await partnerSvc.verifyPartner(labId, 'admin');
  const labOwn = actorFor(lOwner);
  const LA = String((await partnerSvc.createBranch(labOwn, { name: 'Lab A', phone: '9876500000', holidays: [], hours: {}, services: { homeCollection: true, inLab: true, inClinic: false },
    address: addr } as any))._id);
  const labDeskM = await partnerSvc.addMember(labOwn, { phone: nextPhone(), name: 'Lab desk', role: 'staff', branchIds: [LA], permissions: ['bookings.view', 'bookings.manage'] } as any);
  const labDesk = actorFor(labDeskM);
  const every = (start: string, end: string) => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start, end }]]));
  await saveSlotTemplate(labOwn, LA, 'lab', { slotMinutes: 30, capacity: 5, days: every('08:00', '10:00'), expectedUpdatedAt: null });
  const labAcct = await SettlementAccountModel.findOne({ ownerKind: 'partner', ownerId: labId }).lean();
  const labSlot = async (dayOffset: number, start = '08:00') => PartnerSlotModel.findOne({ branchId: LA, visitMode: 'lab', date: addDays(today, dayOffset), startTime: start }).lean();
  const labBooking = async (userId: string) => {
    const _id = new Types.ObjectId();
    const past = new Date(Date.now() - 2 * 3_600_000);
    const s = await labSlot(3);
    await PartnerLabBookingModel.collection.insertOne({ _id, partnerId: labId, branchId: LA, userId, createRequestKey: `k${_id}`, createRequestHash: 'h',
      patient: { kind: 'self', name: 'Asha' }, visitMode: 'lab', slot: { slotId: String(s!._id), date: s!.date, startTime: '08:00', endTime: '08:30', startsAt: past },
      items: [{ itemId: 'i', name: 'CBC', priceMinor: 50000, kind: 'test' }], pricing: { subtotalMinor: 50000, discountMinor: 0, payableMinor: 50000, commissionMinor: 0, currency: 'INR' },
      settlement: { settlementAccountId: String(labAcct!._id), beneficiaryName: 'Metro Lab', settlementSystem: 'ledger' }, status: 'confirmed', statusVersion: 3, paymentStatus: 'paid',
      paymentDeadline: new Date(), report: { draftFiles: [], releasedFiles: [], releases: [] }, reschedule: { version: 0, pending: false }, lifecycle: {},
      createdAt: new Date(), updatedAt: new Date() } as never);
    await PartnerSlotModel.updateOne({ _id: s!._id }, { $inc: { booked: 1 } }).catch(() => undefined);
    return String(_id);
  };

  await check('lab: a no-show earns nothing; moved once to a later slot (replay), not refundable, earns once on completion; a second move refused', async () => {
    const u = await customer();
    const id = await labBooking(u.id);
    const ns = await labSvc.markNoShow(labDesk, id, new Date()) as any;
    assert.equal(ns.status, 'no_show');
    assert.equal(await earningsOf(id), 0, 'no earning for a lab no-show');
    const target = await labSlot(4);
    const key = rk('labns');
    await assert.rejects(() => labSvc.rescheduleNoShow(labDesk, id, { slotId: String(target!._id), requestKey: key, expectedVersion: 1 }), code('LAB_BOOKING_CHANGED'));
    const moved = await labSvc.rescheduleNoShow(labDesk, id, { slotId: String(target!._id), requestKey: key }) as any;
    assert.deepEqual([moved.status, moved.slot.slotId, moved.replayed, moved.noShows.length], ['confirmed', String(target!._id), false, 1]);
    assert.equal(((await labSvc.rescheduleNoShow(labDesk, id, { slotId: String(target!._id), requestKey: key })) as any).replayed, true);
    assert.ok(await PartnerAuditEventModel.exists({ partnerId: labId, action: 'lab_booking.no_show_rescheduled' }));
    await assert.rejects(() => labSvc.customerCancel(u.id, id, 'x'), code('NO_SHOW_NOT_REFUNDABLE'));
    await assert.rejects(() => labSvc.labReject(labDesk, id, 'x'), code('NO_SHOW_NOT_REFUNDABLE'));
    const cv = await labSvc.getForCustomer(u.id, id) as any;
    assert.ok(!JSON.stringify(cv.noShows).includes(String(labDeskM._id)), 'customers see no staff ids or keys');
    await PartnerLabBookingModel.updateOne({ _id: id }, { $set: { status: 'report_ready' } });
    await labSvc.complete(labDesk, id);
    assert.equal(await earningsOf(id), 1, 'earns once on completion');
    const id2 = await labBooking(u.id);
    await labSvc.markNoShow(labDesk, id2, new Date());
    await labSvc.rescheduleNoShow(labDesk, id2, { slotId: String((await labSlot(5))!._id), requestKey: rk('labns') });
    await PartnerLabBookingModel.updateOne({ _id: id2 }, { $set: { 'slot.startsAt': new Date(Date.now() - 3_600_000) } });
    await labSvc.markNoShow(labDesk, id2, new Date());
    await assert.rejects(async () => labSvc.rescheduleNoShow(labDesk, id2, { slotId: String((await labSlot(6))!._id), requestKey: rk('labns') }), code('NO_SHOW_RESCHEDULE_USED'));
  });
  (CONFIG as any).SETTLEMENT_CUTOVER_AT = undefined;

  // ───────────────────────────── 2. Desk notifications ─────────────────────────────
  await check('desk create/reschedule/cancel notify the account holder and the doctor after the commit; a replay sends nothing', async () => {
    const start = notices.length;
    const phone = nextPhone();
    const key = rk('desk');
    const made = await clinic.createDeskAppointment(desk, { slotId: await deskSlot(), customer: { phone }, requestKey: key });
    const id = made.booking.bookingId;
    const user = await UserModel.findOne({ phone }).lean();
    const created = notices.slice(start);
    assert.deepEqual(created.map((n) => [n.audience, n.userId, n.type]).sort(),
      [['customer', String(user!._id), 'booking_confirmed'], ['doctor', drC, 'specialist_new_booking']]);
    assert.ok(!JSON.stringify(created).includes(phone), 'no phone numbers in notices');
    await clinic.createDeskAppointment(desk, { slotId: made.booking.slotId!, customer: { phone }, requestKey: key });
    assert.equal(notices.length, start + 2, 'a replay sends nothing');
    const moved = await clinic.rescheduleDeskAppointment(desk, id, await deskSlot());
    assert.deepEqual(notices.slice(start + 2).map((n) => n.type).sort(), ['general', 'specialist_general']);
    await clinic.cancelDeskAppointment(desk, id, 'Doctor away', moved.updatedAt);
    assert.deepEqual(notices.slice(start + 4).map((n) => n.type).sort(), ['booking_cancelled', 'specialist_appointment_cancelled']);
    assert.ok(committedAtSend.length > 0 && committedAtSend.every(Boolean), 'sent only after the booking committed');
  });

  await check('a failing sender never fails or rolls back a desk create, move or cancel (and logs no phone)', async () => {
    const prev = clinic.setClinicNotifier(async () => { throw new Error('sender down'); });
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
    try {
      const phone = nextPhone();
      const made = await clinic.createDeskAppointment(desk, { slotId: await deskSlot(), customer: { phone }, requestKey: rk('desk') });
      assert.equal((await BookingModel.findById(made.booking.bookingId).lean())!.status, 'confirmed');
      const moved = await clinic.rescheduleDeskAppointment(desk, made.booking.bookingId, await deskSlot());
      const c = await clinic.cancelDeskAppointment(desk, made.booking.bookingId, 'x', moved.updatedAt);
      assert.equal(c.status, 'cancelled');
      assert.ok(errors.length >= 6 && errors.every((l) => !l.includes(phone)));
    } finally {
      console.error = origError;
      clinic.setClinicNotifier(prev);
    }
  });

  // ───────────────────────────── 3. Bill linked to its appointment ─────────────────────────────
  const line = { description: 'Consultation', qty: 1, unitPriceMinor: 60000, gstRate: 0 as const };
  const bill = (actor: PartnerActor, over: Record<string, unknown> = {}) =>
    invoiceSvc.createInvoice(actor, { branchId: A, customer: { name: 'Asha' }, items: [line], idempotencyKey: rk('bill'), ...over } as any);
  await check('a bill names its appointment: same clinic, branch and doctor, not cancelled; one open bill; cancelling allows a new one; replay', async () => {
    const made = await clinic.createDeskAppointment(desk, { slotId: await deskSlot(), customer: { phone: nextPhone() }, requestKey: rk('desk') });
    const appt = made.booking.bookingId;
    const elsewhere = await clinic.createDeskAppointment(other, { slotId: await deskSlot(drO, OB), customer: { phone: nextPhone() }, requestKey: rk('desk') });
    await assert.rejects(() => bill(desk, { appointmentId: elsewhere.booking.bookingId }), code('APPOINTMENT_NOT_FOUND'));
    await assert.rejects(() => bill(desk, { appointmentId: appt, doctorId: drD }), code('APPOINTMENT_DOCTOR_MISMATCH'));
    await assert.rejects(() => bill(own, { appointmentId: appt, branchId: B }), code('APPOINTMENT_BRANCH_MISMATCH'));
    const key = rk('bill');
    const first = await bill(desk, { appointmentId: appt.toUpperCase(), doctorId: drC, idempotencyKey: key });
    assert.equal(first.appointmentId, appt);
    const replay = await bill(desk, { appointmentId: appt, doctorId: drC, idempotencyKey: key });
    assert.equal(String(replay._id), String(first._id));
    await assert.rejects(() => bill(desk, { appointmentId: elsewhere.booking.bookingId, doctorId: drC, idempotencyKey: key }), code('IDEMPOTENCY_KEY_REUSED'));
    await assert.rejects(() => bill(desk, { doctorId: drC, idempotencyKey: key }), code('IDEMPOTENCY_KEY_REUSED'));
    await assert.rejects(() => bill(desk, { appointmentId: appt }), code('APPOINTMENT_ALREADY_BILLED'));
    // Racing second bills: one open bill at most.
    await invoiceSvc.cancelInvoice(desk, String(first._id), 'Wrong amount');
    const race = await Promise.allSettled([bill(desk, { appointmentId: appt }), bill(desk, { appointmentId: appt }), bill(desk, { appointmentId: appt })]);
    assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(race.filter((r) => r.status === 'rejected').every((r: any) => ['APPOINTMENT_ALREADY_BILLED', 'LIFECYCLE_VERSION_CONFLICT'].includes(r.reason?.code) || r.reason?.code === 112 || /WriteConflict/.test(String(r.reason))));
    const open = (race.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
    const page = await invoiceSvc.listInvoicesPage(desk, { appointmentId: appt });
    assert.deepEqual(page.items.map((i) => i.lifecycleState).sort(), ['cancelled', 'issued']);
    const rows = await clinic.listClinicAppointments(desk, { from: addDays(today, 2), to: addDays(today, 3) });
    const row = rows.find((r) => r.bookingId === appt)!;
    assert.deepEqual(row.bill, { invoiceId: String(open._id), serial: open.serial, number: open.number, state: 'issued' });
    // A cancelled appointment cannot be billed.
    const gone = await clinic.createDeskAppointment(desk, { slotId: await deskSlot(), customer: { phone: nextPhone() }, requestKey: rk('desk') });
    await clinic.cancelDeskAppointment(desk, gone.booking.bookingId, 'x');
    await assert.rejects(() => bill(desk, { appointmentId: gone.booking.bookingId }), code('APPOINTMENT_CANCELLED'));
    assert.ok(InvoiceModel.schema.indexes().some(([k, o]: any) => k.openAppointmentId === 1 && o.unique === true), 'the unique index is declared on the schema');
  });

  // ───────────────────────────── 4. Family members at the desk ─────────────────────────────
  await check('the desk books for a family member: an existing one, a new one (created with the booking), never someone else\'s', async () => {
    const holder = await customer();
    const [dep] = await DependentModel.create([{ userId: holder.id, name: 'Ravi', relationship: 'Son', isActive: true }]);
    const k1 = rk('desk');
    const a = await clinic.createDeskAppointment(desk, { slotId: await deskSlot(), customer: { phone: holder.phone }, patient: { dependentId: String(dep!._id) }, requestKey: k1 });
    assert.deepEqual([a.booking.dependentId, a.patient?.name, a.patient?.created], [String(dep!._id), 'Ravi', false]);
    assert.equal((await clinic.createDeskAppointment(desk, { slotId: a.booking.slotId!, customer: { phone: holder.phone }, patient: { dependentId: String(dep!._id) }, requestKey: k1 })).replayed, true);
    await assert.rejects(() => clinic.createDeskAppointment(desk, { slotId: a.booking.slotId!, customer: { phone: holder.phone }, requestKey: k1 }), code('IDEMPOTENCY_KEY_REUSED'));
    // Someone else's family member is refused, before any customer is created for a new number.
    const stranger = nextPhone();
    await assert.rejects(async () => clinic.createDeskAppointment(desk, { slotId: await deskSlot(), customer: { phone: stranger }, patient: { dependentId: String(dep!._id) }, requestKey: rk('desk') }),
      code('DEPENDENT_NOT_FOUND'));
    assert.equal(await UserModel.countDocuments({ phone: stranger }), 0);
    // A new family member is created under the account with the booking (never merging: an exact match is used as it is).
    const b = await clinic.createDeskAppointment(desk, { slotId: await deskSlot(), customer: { phone: holder.phone },
      patient: { name: 'Meera', relation: 'Mother', gender: 'Female', dateOfBirth: '1960-04-02' }, requestKey: rk('desk') });
    const meera = await DependentModel.findById(b.booking.dependentId).lean();
    assert.deepEqual([meera!.userId, meera!.name, meera!.relationship, meera!.dateOfBirth, b.patient?.created], [holder.id, 'Meera', 'Mother', '19600402', true]);
    const c = await clinic.createDeskAppointment(desk, { slotId: await deskSlot(), customer: { phone: holder.phone }, patient: { name: ' meera ', relation: 'Mother' }, requestKey: rk('desk') });
    assert.deepEqual([c.booking.dependentId, c.patient?.created], [b.booking.dependentId, false]);
    assert.equal(await DependentModel.countDocuments({ userId: holder.id }), 2);
    // A failed booking creates no family member (same transaction).
    const taken = c.booking.slotId!;
    await assert.rejects(() => clinic.createDeskAppointment(desk, { slotId: taken, customer: { phone: holder.phone }, patient: { name: 'Nobody', relation: 'Brother' }, requestKey: rk('desk') }));
    assert.equal(await DependentModel.countDocuments({ userId: holder.id, name: 'Nobody' }), 0);
    // The appointment list shows the person being seen.
    const rows = await clinic.listClinicAppointments(desk, { from: addDays(today, 2), to: addDays(today, 3) });
    const row = rows.find((r) => r.bookingId === b.booking.bookingId)!;
    assert.deepEqual([row.patient.name, row.patient.relationship, row.patient.dependentId], ['Meera', 'Mother', b.booking.dependentId]);
    assert.ok(deskBookingSchema.validate({ slotId: taken, customer: { phone: holder.phone }, patient: { name: 'X', relation: 'Me' }, requestKey: 'abcdefgh1' }).error, "'Me' is the account holder");
  });

  // ───────────────────────────── 5. Mixed and part payments ─────────────────────────────
  const plain = (actor: PartnerActor, totalMinor = 300000) => invoiceSvc.createInvoice(actor, { branchId: A, customer: { name: 'P' },
    items: [{ description: 'Procedure', qty: 1, unitPriceMinor: totalMinor, gstRate: 0 }], idempotencyKey: rk('bill') } as any);
  await check('mixed methods: one payment split across cash and UPI settles the bill (always allowed)', async () => {
    const inv = await plain(desk);
    const r = await invoiceSvc.recordPayment(desk, String(inv._id), { splits: [{ mode: 'cash', amountMinor: 100000 }, { mode: 'upi', amountMinor: 200000, reference: 'UPI1' }] });
    assert.deepEqual([r.invoice.lifecycleState, r.invoice.paidMinor, r.invoice.dueMinor, r.event.amountMinor, r.event.splits!.length], ['paid', 300000, 0, 300000, 2]);
    const html = renderInvoiceHtml((await invoiceSvc.getInvoice(desk, String(inv._id))).invoice, (await invoiceSvc.getInvoice(desk, String(inv._id))).events);
    assert.ok(html.includes('CASH') && html.includes('UPI') && html.includes('>Paid<'));
    assert.ok(recordPaymentSchema.validate({ mode: 'cash', splits: [{ mode: 'cash', amountMinor: 1 }] }).error, 'mode or splits, not both');
  });

  await check('part payments: refused while the partner setting is off; on (owner, versioned) they leave the bill partly paid until the total', async () => {
    const inv = await plain(desk);
    await assert.rejects(() => invoiceSvc.recordPayment(desk, String(inv._id), { splits: [{ mode: 'cash', amountMinor: 100000 }], requestKey: rk('pay') }), code('PART_PAYMENTS_NOT_ALLOWED'));
    await assert.rejects(() => partnerSvc.updateOwnProfile(desk, { allowPartPayments: true }), code('OWNER_REQUIRED'));
    await assert.rejects(() => partnerSvc.updateOwnProfile(own, { allowPartPayments: true, expectedUpdatedAt: new Date(0) }), code('RECORD_CHANGED'));
    const cur = await PartnerModel.findById(clinicId).lean();
    assert.equal((await partnerSvc.updateOwnProfile(own, { allowPartPayments: true, expectedUpdatedAt: cur!.updatedAt })).allowPartPayments, true);
    await assert.rejects(() => invoiceSvc.recordPayment(desk, String(inv._id), { splits: [{ mode: 'cash', amountMinor: 100000 }] }), code('REQUEST_KEY_REQUIRED'));
    const k1 = rk('pay');
    const p1 = await invoiceSvc.recordPayment(desk, String(inv._id), { splits: [{ mode: 'cash', amountMinor: 100000 }], requestKey: k1 });
    assert.deepEqual([p1.invoice.lifecycleState, p1.invoice.paidMinor, p1.invoice.dueMinor], ['partly_paid', 100000, 200000]);
    const again = await invoiceSvc.recordPayment(desk, String(inv._id), { splits: [{ mode: 'cash', amountMinor: 100000 }], requestKey: k1 });
    assert.deepEqual([again.replayed, String(again.event._id)], [true, String(p1.event._id)]);
    await assert.rejects(() => invoiceSvc.recordPayment(desk, String(inv._id), { splits: [{ mode: 'upi', amountMinor: 100000 }], requestKey: k1 }), code('IDEMPOTENCY_KEY_REUSED'));
    await assert.rejects(() => invoiceSvc.recordPayment(desk, String(inv._id), { splits: [{ mode: 'upi', amountMinor: 200001 }], requestKey: rk('pay') }), code('AMOUNT_EXCEEDS_DUE'));
    const html = renderInvoiceHtml((await invoiceSvc.getInvoice(desk, String(inv._id))).invoice, (await invoiceSvc.getInvoice(desk, String(inv._id))).events);
    assert.ok(html.includes('Partly paid') && html.includes('Due'));
    assert.equal((await invoiceSvc.listInvoicesPage(desk, { state: 'partly_paid' })).items.some((i) => String(i._id) === String(inv._id)), true);
    const p2 = await invoiceSvc.recordPayment(desk, String(inv._id), { mode: 'card', reference: 'C1' });
    assert.deepEqual([p2.invoice.lifecycleState, p2.invoice.paidMinor, p2.invoice.dueMinor, p2.event.amountMinor], ['paid', 300000, 0, 200000]);
    await assert.rejects(() => invoiceSvc.recordPayment(desk, String(inv._id), { splits: [{ mode: 'cash', amountMinor: 1 }], requestKey: rk('pay') }), code('INVOICE_STATE_CONFLICT'));
  });

  await check('concurrent payments never overpay; cancelling after a part payment records a refund equal to what was paid', async () => {
    const inv = await plain(desk);
    const r = await Promise.allSettled([1, 2, 3].map(() => invoiceSvc.recordPayment(desk, String(inv._id), { splits: [{ mode: 'cash', amountMinor: 200000 }], requestKey: rk('pay') })));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    const after = (await invoiceSvc.getInvoice(desk, String(inv._id))).invoice;
    assert.deepEqual([after.paidMinor, after.lifecycleState], [200000, 'partly_paid']);
    assert.equal(await InvoiceEventModel.countDocuments({ invoiceId: String(inv._id), kind: 'payment' }), 1);
    await assert.rejects(() => invoiceSvc.cancelInvoice(desk, String(inv._id), 'Wrong'), code('REFUND_REQUIRED'));
    await assert.rejects(() => invoiceSvc.cancelInvoice(desk, String(inv._id), 'Wrong', { mode: 'cash', amountMinor: 300000 }), code('REFUND_AMOUNT_MISMATCH'));
    const c = await invoiceSvc.cancelInvoice(desk, String(inv._id), 'Wrong', { mode: 'cash' });
    assert.deepEqual([c.invoice.lifecycleState, c.event.refund!.amountMinor, c.invoice.dueMinor], ['cancelled', 200000, 0]);
    await partnerSvc.updatePartner(clinicId, { allowPartPayments: false });
  });

  await check('a bill paid before Q14 (no amounts stored) reads as one full payment', async () => {
    const inv = await plain(desk, 50000);
    await invoiceSvc.recordPayment(desk, String(inv._id), { mode: 'cash' });
    await InvoiceModel.updateOne({ _id: inv._id }, { $unset: { paidMinor: 1 } });
    await InvoiceEventModel.updateOne({ invoiceId: String(inv._id), kind: 'payment' }, { $unset: { amountMinor: 1, splits: 1 } });
    const read = await invoiceSvc.getInvoice(desk, String(inv._id));
    assert.deepEqual([read.invoice.lifecycleState, read.invoice.paidMinor, read.invoice.dueMinor], ['paid', 50000, 0]);
    const page = await invoiceSvc.listInvoicesPage(desk, {});
    assert.equal(page.items.find((i) => String(i._id) === String(inv._id))!.paidMinor, 50000);
    const c = await invoiceSvc.cancelInvoice(desk, String(inv._id), 'old', { mode: 'cash' });
    assert.equal(c.event.refund!.amountMinor, 50000);
  });

  // ───────────────────────────── 6. Doctors linked by admins; doctor-created clinics ─────────────────────────────
  await check('clinics cannot invite; pending invitations stay readable but cannot be accepted (declining still works)', async () => {
    const drI = await doctor('Dr Invited');
    await assert.rejects(() => clinic.inviteDoctor(own, { doctorId: drI }), code('DOCTOR_LINK_ADMIN_ONLY'));
    await assert.rejects(() => clinic.inviteDoctor(admin(clinicId), { doctorId: drI }), code('USE_DOCTOR_LINK'));
    const [inv] = await ClinicDoctorInviteModel.create([{ partnerId: clinicId, doctorId: drI, branchIds: [], invitedBy: String(cOwner._id), state: 'pending' }]);
    assert.ok((await clinic.listInvites(own)).some((i) => String(i._id) === String(inv!._id)));
    await assert.rejects(() => clinic.respondToInvite(drI, String(inv!._id), true), code('INVITE_NO_LONGER_VALID'));
    assert.equal(await MemberModel.countDocuments({ partnerId: clinicId, doctorId: drI }), 0);
    await clinic.respondToInvite(drI, String(inv!._id), false);
    assert.equal((await ClinicDoctorInviteModel.findById(inv!._id).lean())!.state, 'declined');
  });

  await check('admins link a doctor directly (idempotent by key, audited, doctor told); unverified doctors refused; owner and admin unlink', async () => {
    const drL = await doctor('Dr Linked');
    const drU = await doctor('Dr Unverified', { isVerified: false });
    await assert.rejects(() => clinic.linkDoctor(own, { doctorId: drL, requestKey: rk('link') }), code('DOCTOR_LINK_ADMIN_ONLY'));
    await assert.rejects(() => clinic.linkDoctor(admin(clinicId), { doctorId: drU, requestKey: rk('link') }), code('DOCTOR_NOT_ELIGIBLE'));
    const before = notices.length;
    const key = rk('link');
    const l1 = await clinic.linkDoctor(admin(clinicId), { doctorId: drL, branchIds: [B], requestKey: key });
    const l2 = await clinic.linkDoctor(admin(clinicId), { doctorId: drL, branchIds: [B], requestKey: key });
    assert.deepEqual([l1.replayed, l2.replayed, String(l2.link._id)], [false, true, String(l1.link._id)]);
    await assert.rejects(() => clinic.linkDoctor(admin(clinicId), { doctorId: drL, branchIds: [A], requestKey: key }), code('IDEMPOTENCY_KEY_REUSED'));
    await assert.rejects(() => clinic.linkDoctor(admin(clinicId), { doctorId: drL, requestKey: rk('link') }), code('DOCTOR_ALREADY_MEMBER'));
    const m = await MemberModel.findOne({ partnerId: clinicId, doctorId: drL, isActive: true }).lean();
    assert.deepEqual([(m as any).doctorBranchIds, m!.permissions.length, (l1.link as any).via], [[B], 0, 'admin_link']);
    assert.ok(await PartnerAuditEventModel.exists({ partnerId: clinicId, action: 'clinic.doctor_linked' }));
    assert.deepEqual(notices.slice(before).map((n) => [n.audience, n.userId]), [['doctor', drL]]);
    // Removal: a desk member cannot; the owner can; an admin can.
    await assert.rejects(() => clinic.unlinkDoctor(desk, drL), code('OWNER_REQUIRED'));
    assert.equal((await clinic.unlinkDoctor(own, drL)).membershipEnded, true);
    assert.equal(await MemberModel.countDocuments({ partnerId: clinicId, doctorId: drL, isActive: true }), 0);
    await clinic.linkDoctor(admin(clinicId), { doctorId: drL, requestKey: rk('link') });
    await clinic.unlinkDoctor(admin(clinicId), drL);
    await assert.rejects(() => clinic.unlinkDoctor(admin(clinicId), drL), code('DOCTOR_NOT_AT_CLINIC'));
  });

  await check('a doctor creates their own clinic: owner + linked doctor at its first branch, pending, one transaction, replay, a second one refused', async () => {
    const drS = await doctor('Dr Solo');
    const drX = await doctor('Dr Unverified Two', { isVerified: false });
    const input = { name: 'Solo Care', invoiceSeriesPrefix: 'SOLO', branch: { name: 'Main', phone: '9876500001', address: addr } } as any;
    await assert.rejects(() => clinic.createSoloPractice(drX, { ...input, requestKey: rk('clinic') }), code('SPECIALIST_NOT_ACTIVE'));
    // Atomic: a branch the schema refuses leaves no clinic, owner or settlement account behind.
    await assert.rejects(() => clinic.createSoloPractice(drS, { ...input, branch: { name: 'Bad', phone: '9876500001', address: {} }, requestKey: rk('clinic') }));
    assert.equal(await PartnerModel.countDocuments({ soloDoctorId: drS }), 0);
    assert.equal(await MemberModel.countDocuments({ doctorId: drS }), 0);
    const key = rk('clinic');
    const made = await clinic.createSoloPractice(drS, { ...input, requestKey: key }) as any;
    assert.equal(made.created, true);
    const pid = String(made.partner._id);
    assert.equal(made.partner.verification.state, 'pending', 'starts pending like every new partner; an admin verifies it');
    const ownerM = await MemberModel.findOne({ partnerId: pid, doctorId: drS, isActive: true }).lean();
    assert.deepEqual([ownerM!.role, (ownerM as any).doctorBranchIds, ownerM!.permissions.length > 5], ['owner', [String(made.branch._id)], true]);
    const replay = await clinic.createSoloPractice(drS, { ...input, requestKey: key }) as any;
    assert.deepEqual([replay.created, replay.replayed, String(replay.partner._id)], [false, true, pid]);
    await assert.rejects(() => clinic.createSoloPractice(drS, { ...input, name: 'Changed', requestKey: key }), code('IDEMPOTENCY_KEY_REUSED'));
    await assert.rejects(() => clinic.createSoloPractice(drS, { ...input, requestKey: rk('clinic') }), code('DOCTOR_CLINIC_EXISTS'));
    assert.equal(String((await clinic.findDoctorClinicByKey(drS, key))!.partner._id), pid);
    // Adding any other doctor to it is for admins only.
    const ownerActor = actorFor(ownerM as IMember);
    await assert.rejects(() => clinic.linkDoctor(ownerActor, { doctorId: drD, requestKey: rk('link') }), code('DOCTOR_LINK_ADMIN_ONLY'));
    await assert.rejects(() => clinic.inviteDoctor(ownerActor, { doctorId: drD }), code('DOCTOR_LINK_ADMIN_ONLY'));
  });

  // ───────────────────────────── HTTP: the real routers ─────────────────────────────
  const [{ default: specialistRouter }, { default: partnerRouter }] = await Promise.all([import('@/modules/specialists/routes'), import('@/modules/partners/routes')]);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/specialists', authenticate, specialistRouter);
  app.use('/api/v1/partner-workspace', authenticate, partnerRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, token: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const doctorToken = (id: string) => jwt.sign({ _id: id, specialistId: id, userType: 'specialist' }, CONFIG.JWT_SECRET_KEY);
  const partnerToken = (m: IMember) => jwt.sign({ _id: String(m._id), memberId: String(m._id), partnerId: String(m.partnerId), userType: 'partner' }, CONFIG.JWT_SECRET_KEY);
  const adminToken = jwt.sign({ _id: ADMIN, userType: 'admin' }, CONFIG.JWT_SECRET_KEY);
  const adminBase = `/api/v1/partner-workspace/admin/${clinicId}/workspace`;
  try {
    await check('HTTP: desk family booking, bill with appointment (member and admin-as-owner), split payment, doctor link and clinic, no-show move', async () => {
      const t = partnerToken(deskM);
      const holder = await customer();
      const made = await call('POST', '/api/v1/partner-workspace/clinic/appointments', t, { slotId: await deskSlot(), customer: { phone: holder.phone },
        patient: { name: 'Kiran', relation: 'Daughter' }, requestKey: 'http-desk-q14-01' });
      assert.deepEqual([made.status, made.json.data.patient.name, made.json.data.patient.created], [201, 'Kiran', true]);
      const apptId = made.json.data.booking.bookingId;
      const b1 = await call('POST', `${adminBase}/invoices`, adminToken, { branchId: A, customer: { name: 'Kiran' }, doctorId: drC, appointmentId: apptId,
        items: [line], idempotencyKey: 'http-bill-q14-01' });
      assert.deepEqual([b1.status, b1.json.data.appointmentId, b1.json.data.dueMinor], [201, apptId, 60000]);
      const b2 = await call('POST', '/api/v1/partner-workspace/invoices', t, { branchId: A, customer: { name: 'Kiran' }, appointmentId: apptId, items: [line], idempotencyKey: 'http-bill-q14-02' });
      assert.deepEqual([b2.status, b2.json.code], [409, 'APPOINTMENT_ALREADY_BILLED']);
      const list = await call('GET', `/api/v1/partner-workspace/invoices?appointmentId=${apptId}`, t);
      assert.deepEqual([list.status, list.json.data.length], [200, 1]);
      const rows = await call('GET', `/api/v1/partner-workspace/clinic/appointments?from=${addDays(today, 2)}&to=${addDays(today, 3)}`, t);
      assert.equal(rows.json.data.find((r: any) => r.bookingId === apptId).bill.invoiceId, b1.json.data._id);
      const pay = await call('POST', `/api/v1/partner-workspace/invoices/${b1.json.data._id}/pay`, t, { splits: [{ mode: 'cash', amountMinor: 20000 }, { mode: 'upi', amountMinor: 40000 }] });
      assert.deepEqual([pay.status, pay.json.data.invoice.lifecycleState], [200, 'paid']);
      // Doctor links and clinics
      const drH = await doctor('Dr Http');
      const refused = await call('POST', '/api/v1/partner-workspace/clinic/doctors', partnerToken(cOwner), { doctorId: drH, requestKey: 'http-link-q14-01' });
      assert.deepEqual([refused.status, refused.json.code], [403, 'DOCTOR_LINK_ADMIN_ONLY']);
      const linked = await call('POST', `${adminBase}/clinic/doctors`, adminToken, { doctorId: drH, branchIds: [A], requestKey: 'http-link-q14-01' });
      assert.equal(linked.status, 201);
      assert.equal((await call('POST', `${adminBase}/clinic/doctors`, adminToken, { doctorId: drH, branchIds: [A], requestKey: 'http-link-q14-01' })).status, 200);
      assert.equal((await call('DELETE', `/api/v1/partner-workspace/clinic/doctors/${drH}`, partnerToken(cOwner))).status, 200);
      const drM = await doctor('Dr Mine');
      const body = { name: 'Mine Clinic', invoiceSeriesPrefix: 'MINE', branch: { name: 'Main', phone: '9876500002', address: addr }, requestKey: 'http-clinic-q14-01' };
      const c1 = await call('POST', '/api/v1/specialists/me/clinic', doctorToken(drM), body);
      const c2 = await call('POST', '/api/v1/specialists/me/clinic', doctorToken(drM), body);
      const c3 = await call('POST', '/api/v1/specialists/me/clinic', doctorToken(drM), { ...body, requestKey: 'http-clinic-q14-02' });
      assert.deepEqual([c1.status, c2.status, c3.status, c3.json.code], [201, 200, 409, 'DOCTOR_CLINIC_EXISTS']);
      assert.equal((await call('GET', '/api/v1/specialists/me/clinic/by-key/http-clinic-q14-01', doctorToken(drM))).json.data.partner._id, c1.json.data.partner._id);
      // No-show move by the doctor; customers have no such route.
      (CONFIG as any).SETTLEMENT_CUTOVER_AT = new Date(Date.now() - 60_000).toISOString();
      const u = await customer();
      const id = await onlineBooking(u.id, drN);
      (CONFIG as any).SETTLEMENT_CUTOVER_AT = undefined;
      await bookings.markNoShow(id, { _id: drN, userType: 'specialist' }, later());
      const target = await slotAt(drN, futureStart());
      const userToken = jwt.sign({ _id: u.id, userType: 'user' }, CONFIG.JWT_SECRET_KEY);
      assert.equal((await call('POST', `/api/v1/specialists/me/bookings/${id}/reschedule-no-show`, userToken, { slotId: target, requestKey: 'http-ns-q14-01' })).status, 403);
      const mv = await call('POST', `/api/v1/specialists/me/bookings/${id}/reschedule-no-show`, doctorToken(drN), { slotId: target, requestKey: 'http-ns-q14-01' });
      assert.deepEqual([mv.status, mv.json.data.status], [200, 'confirmed']);
      const again = await call('POST', `/api/v1/specialists/admin/bookings/${id}/reschedule-no-show`, adminToken, { slotId: target, requestKey: 'http-ns-q14-02' });
      assert.deepEqual([again.status, again.json.code], [409, 'NO_SHOW_RESCHEDULE_USED']);
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} checks passed${failed.length ? `, ${failed.length} FAILED: ${failed.join(' | ')}` : ''}`);
  if (failed.length) throw new Error(`${failed.length} checks failed`);
}

main().then(() => mongoose.disconnect()).catch(async (e) => { console.error(e?.message ?? e); await mongoose.disconnect(); process.exit(1); });
