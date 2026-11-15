/**
 * Q6: clinics with several doctors (invitation the doctor accepts, leaving), the clinic front desk (slots, in-clinic
 * appointments for walk-in customers paid at the clinic, check-in/complete/no-show/cancel/reschedule, appointment list),
 * pay-at-clinic fences (no online payment, no ledger or legacy settlement), and solo practices. Real MongoDB replica
 * set, the real application routes.
 *
 * Run (throwaway DB only; the script drops its collections):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q6_clinic_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx test/partners/q6-clinics.integration.ts
 */
import { removeFixtureDir } from './q6-fixture-dir';
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
import SpecialistModel from '@/modules/specialists/model';
import SlotModel from '@/modules/slots/model';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import { createBookingWithHolds, cancelBookingSettlement, rescheduleWithHolds } from '@/modules/bookings/holds';
import PaymentRecordModel from '@/modules/payment/model';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository } from '@/modules/wallet/repository';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import { ClinicDoctorInviteModel } from '@/modules/partners/model/clinicDoctor';
import { SettlementAccountModel, LedgerEntryModel } from '@/modules/partners/model/settlement';
import { ScheduleGuardModel } from '@/modules/partners/model/slot';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { PartnerService, PartnerActor } from '@/modules/partners/services';
import * as clinic from '@/modules/partners/services/clinic';
import { istDate, addDays } from '@/modules/partners/services/slots';
import { DoctorReservationModel, DoctorScheduleGuardModel } from '@/modules/doctors/model/reservation';
import { DoctorScheduleTemplateModel } from '@/modules/doctors/model/schedule';
import { saveTemplate, clinicBranchAllowed } from '@/modules/doctors/services/schedule';
import DependentModel from '@/modules/dependents/model';
import { PharmacyService } from '@/modules/pharmacies/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { UserRepository } from '@/modules/user/repository';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q6_clinic_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const partnerSvc = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
Container.set(PartnerService, partnerSvc);
const bookings = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), walletRepository: new WalletRepository(),
  bookingReminderScheduler: { clearBookingReminders: async () => undefined, scheduleBookingReminders: async () => undefined },
  notificationService: { create: async () => undefined, createSpecialistAppointmentCancelledNotification: async () => undefined },
}) as BookingService;

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) { await fn(); passed++; console.log('ok -', name); }
const code = (c: string) => (e: any) => e?.code === c;
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let ph = 7600000000;
const nextPhone = () => String(ph++);
let keySeq = 0;
const rk = () => `desk-key-${String(++keySeq).padStart(4, '0')}`;
const today = istDate(new Date());
const ymd = (iso: string) => iso.replace(/-/g, '');
const addr = { line1: '1 Road', city: 'Pune', state: 'Maharashtra', stateCode: '27', pincode: '411001' };
const branchIn = (name: string, inClinic = true) => ({ name, phone: '9876500000', holidays: [], hours: {},
  services: { homeCollection: false, inLab: !inClinic, inClinic }, address: addr }) as any;
const every = (w: Record<string, unknown>) => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [w]]));

async function doctor(name: string, fee = 600) {
  const id = new Types.ObjectId();
  const phone = nextPhone();
  await SpecialistModel.collection.insertOne({ _id: id, name, phone, email: `${name.replace(/\W/g, '')}@x.test`, specialization: 'General Physician',
    consultationFee: fee, isActive: true, isVerified: true } as never);
  return { id: String(id), phone };
}

async function main() {
  await mongoose.connect(url, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [UserModel, SpecialistModel, SlotModel, BookingModel, PaymentRecordModel, WalletModel, WalletTransactionModel, RequestKeyModel, PartnerModel,
    MemberModel, BranchModel, PartnerAuditEventModel, ClinicDoctorInviteModel, SettlementAccountModel, LedgerEntryModel, ScheduleGuardModel,
    DoctorReservationModel, DoctorScheduleGuardModel, DoctorScheduleTemplateModel, DependentModel] as mongoose.Model<any>[]) {
    await M.createCollection(); await M.createIndexes();
  }

  // ── Fixtures: a verified clinic with two in-clinic branches, a front desk per branch, and a lab ──
  const { partner, owner } = await partnerSvc.createPartner({ kind: 'clinic', name: 'Care Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'CC',
    firstOwner: { phone: nextPhone(), name: 'Owner' } } as any);
  const partnerId = String(partner._id);
  await partnerSvc.verifyPartner(partnerId, 'admin');
  const own = actorFor(owner);
  const A = String((await partnerSvc.createBranch(own, branchIn('Kothrud')))._id);
  const B = String((await partnerSvc.createBranch(own, branchIn('Baner')))._id);
  const deskA = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk A', role: 'staff', branchIds: [A], permissions: ['bookings.view', 'bookings.manage', 'staff.manage'] } as any);
  const viewer = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Viewer', role: 'staff', permissions: ['bookings.view'] } as any);
  const { partner: lab, owner: labOwner } = await partnerSvc.createPartner({ kind: 'lab', name: 'Lab', contactPhone: nextPhone(), invoiceSeriesPrefix: 'LB',
    firstOwner: { phone: nextPhone(), name: 'Lab owner' } } as any);
  const drRao = await doctor('Dr Rao');
  const drSen = await doctor('Dr Sen', 800);

  let inviteId = '';
  await check('invitation: clinic only, branch scope enforced, idempotent while pending; the doctor declines or accepts once', async () => {
    await assert.rejects(() => clinic.inviteDoctor(actorFor(labOwner), { doctorId: drRao.id }), code('NOT_A_CLINIC'));
    await assert.rejects(() => clinic.inviteDoctor(actorFor(deskA), { doctorId: drRao.id, branchIds: [] }), code('BRANCH_SCOPE_EXCEEDED'));
    await assert.rejects(() => clinic.inviteDoctor(own, { phone: '12345' }), code('INVALID_PHONE'));
    await assert.rejects(() => clinic.inviteDoctor(own, { phone: '9999999999' }), code('DOCTOR_NOT_FOUND'));
    const first = await clinic.inviteDoctor(own, { phone: `+91 ${drRao.phone}`, branchIds: [A] });
    assert.equal(first.created, true);
    const again = await clinic.inviteDoctor(own, { doctorId: drRao.id, branchIds: [A] });
    assert.equal(String(again.invite._id), String(first.invite._id));
    // Before acceptance the clinic has no authority over the doctor's time.
    await assert.rejects(() => saveTemplate(drRao.id, { slotMinutes: 30, days: every({ start: '10:00', end: '12:00', modes: ['in-person'], branchId: A }) as any }),
      code('CLINIC_BRANCH_NOT_ALLOWED'));
    const mine = await clinic.myClinics(drRao.id);
    assert.equal(mine.invites.length, 1);
    assert.equal(mine.invites[0]!.clinic, 'Care Clinic');
    await clinic.respondToInvite(drRao.id, String(first.invite._id), false);
    await assert.rejects(() => clinic.respondToInvite(drRao.id, String(first.invite._id), true), code('INVITE_NOT_PENDING'));
    const second = await clinic.inviteDoctor(own, { doctorId: drRao.id, branchIds: [A] });
    await assert.rejects(() => clinic.respondToInvite(drSen.id, String(second.invite._id), true), code('INVITE_NOT_FOUND'));
    const r = await clinic.respondToInvite(drRao.id, String(second.invite._id), true);
    assert.equal(r.accepted, true);
    inviteId = String(second.invite._id);
    const m = await MemberModel.findById(r.memberId).lean();
    assert.deepEqual([m!.doctorId, m!.role, m!.permissions.length, m!.branchIds.map(String), m!.phone], [drRao.id, 'staff', 0, [A], drRao.phone]);
    assert.ok(await PartnerAuditEventModel.exists({ partnerId, action: 'clinic.doctor_joined' }));
    await assert.rejects(() => clinic.inviteDoctor(own, { doctorId: drRao.id }), code('DOCTOR_ALREADY_MEMBER'));
    assert.deepEqual((await clinic.listClinicDoctors(own)).map((d) => d.doctorId), [drRao.id]);
    assert.equal((await clinic.myClinics(drRao.id)).clinics[0]!.branches.map((b) => b.branchId).join(), A);
  });

  await check('a doctor already on the staff (same phone) is linked to that record, not duplicated', async () => {
    const staffDoc = await partnerSvc.addMember(own, { phone: drSen.phone, name: 'Sen (reception login)', role: 'staff', permissions: ['bookings.view'] } as any);
    const inv = await clinic.inviteDoctor(own, { doctorId: drSen.id });
    const r = await clinic.respondToInvite(drSen.id, String(inv.invite._id), true);
    assert.equal(r.memberId, String(staffDoc._id));
    assert.equal(await MemberModel.countDocuments({ partnerId, phone: drSen.phone, isActive: true }), 1);
    assert.equal((await MemberModel.findById(staffDoc._id).lean())!.doctorId, drSen.id);
  });

  // The doctor now publishes in-clinic hours at branch A.
  await saveTemplate(drRao.id, { slotMinutes: 30, days: every({ start: '10:00', end: '12:00', modes: ['in-person'], branchId: A }) as any });
  const day = addDays(today, 2);
  let deskBookingId = '';

  await check('front desk: bookable clinic slots; a walk-in appointment (customer created by phone) takes the seat and the doctor\'s time, paid at the clinic', async () => {
    const slots = await clinic.deskSlots(actorFor(deskA), { doctorId: drRao.id, branchId: A, date: day });
    assert.deepEqual(slots.map((s) => s.startTime), ['10:00', '10:30', '11:00', '11:30']);
    await assert.rejects(() => clinic.deskSlots(actorFor(deskA), { doctorId: drRao.id, branchId: B, date: day }), code('BRANCH_SCOPE_EXCEEDED'));
    const outsider = await doctor('Dr Outsider');
    await assert.rejects(() => clinic.deskSlots(own, { doctorId: outsider.id, branchId: B, date: day }), code('DOCTOR_NOT_AT_CLINIC'));
    const phone = nextPhone();
    const key = rk();
    const r = await clinic.createDeskAppointment(actorFor(deskA), { slotId: slots[0]!.slotId, customer: { phone, name: 'Meera' }, requestKey: key });
    assert.equal(r.customer.created, true);
    deskBookingId = r.booking.bookingId;
    const b = await BookingModel.findById(deskBookingId).lean() as any;
    assert.deepEqual([b.status, b.paymentStatus, b.settlementSystem, b.consultationMode, b.clinicDesk.partnerId, b.clinicDesk.branchId],
      ['confirmed', 'pending', 'clinic', 'in-person', partnerId, A]);
    assert.equal(b.settlement, undefined, 'no ledger snapshot');
    assert.equal((await UserModel.findOne({ phone }).lean() as any).createdSource, 'clinic_desk');
    assert.equal((await SlotModel.findById(slots[0]!.slotId).lean() as any).currentBookings, 1);
    assert.equal(await DoctorReservationModel.countDocuments({ refId: deskBookingId, isActive: true }), 1);
    assert.ok(await PartnerAuditEventModel.exists({ partnerId, action: 'clinic.appointment_booked', targetId: deskBookingId }));
    // Exactly once per desk request key.
    const replay = await clinic.createDeskAppointment(actorFor(deskA), { slotId: slots[0]!.slotId, customer: { phone }, requestKey: key });
    assert.equal(replay.replayed, true);
    assert.equal(replay.booking.bookingId, deskBookingId);
    await assert.rejects(() => clinic.createDeskAppointment(actorFor(deskA), { slotId: slots[1]!.slotId, customer: { phone }, requestKey: key }), code('IDEMPOTENCY_KEY_REUSED'));
    assert.equal(await BookingModel.countDocuments({ 'clinicDesk.partnerId': partnerId }), 1);
    // The slot is gone from the desk list; an online customer cannot take it either.
    assert.ok(!(await clinic.deskSlots(own, { doctorId: drRao.id, branchId: A, date: day })).some((s) => s.slotId === slots[0]!.slotId));
    const online = (await UserModel.create({ phone: nextPhone(), userType: 'user', name: 'Online' } as any))._id;
    await assert.rejects(() => createBookingWithHolds({ bookingType: 'consultation', userId: String(online), specialistId: drRao.id, slotId: slots[0]!.slotId,
      bookingDate: ymd(day), bookingTime: '10:00', consultationMode: 'in-person', serviceMode: 'in-person', price: 600, status: 'pending', paymentStatus: 'pending' } as any),
      code('SLOT_NOT_AVAILABLE'));
  });

  await check('an existing customer is never overwritten; another clinic\'s slot is refused', async () => {
    const phone = nextPhone();
    await UserModel.create({ phone, userType: 'user', name: 'Original Name', otpVerified: true } as any);
    const slots = await clinic.deskSlots(own, { doctorId: drRao.id, branchId: A, date: day });
    const r = await clinic.createDeskAppointment(own, { slotId: slots[0]!.slotId, customer: { phone, name: 'Typed At Desk' }, requestKey: rk() });
    assert.equal(r.customer.created, false);
    assert.equal((await UserModel.findOne({ phone }).lean() as any).name, 'Original Name');
    const { partner: other, owner: otherOwner } = await partnerSvc.createPartner({ kind: 'clinic', name: 'Other', contactPhone: nextPhone(), invoiceSeriesPrefix: 'OT',
      firstOwner: { phone: nextPhone(), name: 'O' } } as any);
    await assert.rejects(() => clinic.createDeskAppointment(actorFor(otherOwner), { slotId: slots[1]!.slotId, customer: { phone }, requestKey: rk() }), code('BRANCH_NOT_FOUND'));
    assert.ok(other);
  });

  await check('pay-at-clinic fences: no online payment, no ledger earning (even after the cutover), not in legacy payouts, customer cannot move it', async () => {
    const b = await BookingModel.findById(deskBookingId).lean() as any;
    await assert.rejects(() => bookings.retryBookingPayment(deskBookingId, { _id: String(b.userId), userType: 'user' }), code('PAY_AT_CLINIC'));
    await assert.rejects(() => rescheduleWithHolds({ bookingId: deskBookingId, requester: { _id: String(b.userId), userType: 'user' }, nextSlotId: b.slotId, patch: {} }),
      code('CLINIC_APPOINTMENT'));
    const stats = await new BookingRepository().getConsultationStatsBySpecialistId(drRao.id, { legacyOnly: true });
    assert.equal(stats.totalAppointments, 0, 'legacy payouts never count a clinic appointment');
    (CONFIG as any).SETTLEMENT_CUTOVER_AT = new Date(Date.now() - 60_000).toISOString();
    try {
      const slots = await clinic.deskSlots(own, { doctorId: drRao.id, branchId: A, date: day });
      const r = await clinic.createDeskAppointment(own, { slotId: slots[0]!.slotId, customer: { phone: nextPhone() }, requestKey: rk() });
      assert.equal((await BookingModel.findById(r.booking.bookingId).lean() as any).settlementSystem, 'clinic');
      await bookings.update(r.booking.bookingId, { status: 'completed' } as any); // the doctor completes it in the portal
      assert.equal(await LedgerEntryModel.countDocuments({ sourceId: r.booking.bookingId }), 0);
      assert.equal(await DoctorReservationModel.countDocuments({ refId: r.booking.bookingId, isActive: true }), 1, 'scheduled interval kept until closed by its own path');
    } finally { (CONFIG as any).SETTLEMENT_CUTOVER_AT = undefined; }
  });

  await check('desk actions: check-in once, no-show only after the time, complete frees the doctor, cancel frees seat and time (audited), reschedule within the clinic', async () => {
    const d = actorFor(deskA);
    const a1 = await clinic.markArrived(d, deskBookingId);
    assert.ok(a1.arrivedAt);
    await assert.rejects(() => clinic.markArrived(d, deskBookingId), code('BOOKING_STATE_CONFLICT'));
    await assert.rejects(() => clinic.closeDeskAppointment(d, deskBookingId, 'no_show'), code('APPOINTMENT_NOT_STARTED'));
    const done = await clinic.closeDeskAppointment(d, deskBookingId, 'completed');
    assert.equal(done.status, 'completed');
    assert.equal(await DoctorReservationModel.countDocuments({ refId: deskBookingId, isActive: true }), 0);
    await assert.rejects(() => clinic.closeDeskAppointment(d, deskBookingId, 'completed'), code('BOOKING_STATE_CONFLICT'));

    const slots = await clinic.deskSlots(d, { doctorId: drRao.id, branchId: A, date: addDays(today, 3) });
    const c = await clinic.createDeskAppointment(d, { slotId: slots[0]!.slotId, customer: { phone: nextPhone() }, requestKey: rk() });
    const moved = await clinic.rescheduleDeskAppointment(d, c.booking.bookingId, slots[1]!.slotId);
    assert.equal(moved.slotId, slots[1]!.slotId);
    assert.equal((await SlotModel.findById(slots[0]!.slotId).lean() as any).currentBookings, 0);
    assert.ok(await PartnerAuditEventModel.exists({ partnerId, action: 'clinic.appointment_rescheduled', targetId: c.booking.bookingId }));
    const cancelled = await clinic.cancelDeskAppointment(d, c.booking.bookingId, 'Doctor unavailable');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await SlotModel.findById(slots[1]!.slotId).lean() as any).currentBookings, 0);
    assert.equal(await DoctorReservationModel.countDocuments({ refId: c.booking.bookingId, isActive: true }), 0);
    assert.equal((await BookingModel.findById(c.booking.bookingId).lean() as any).cancellationCause, 'clinic');
    assert.ok(await PartnerAuditEventModel.exists({ partnerId, action: 'clinic.appointment_cancelled', targetId: c.booking.bookingId }));
    // The customer may cancel their own clinic appointment (nothing was paid online).
    const slots2 = await clinic.deskSlots(d, { doctorId: drRao.id, branchId: A, date: addDays(today, 3) });
    const e = await clinic.createDeskAppointment(d, { slotId: slots2[0]!.slotId, customer: { phone: nextPhone() }, requestKey: rk() });
    const eb = await BookingModel.findById(e.booking.bookingId).lean() as any;
    const cc = await cancelBookingSettlement({ bookingId: e.booking.bookingId, requester: { _id: String(eb.userId), userType: 'user' }, reason: 'busy',
      cancelledAt: ymd(today), wallets: new WalletRepository(), enforceWindow: () => { throw new Error('no window without money'); }, lifecycle: (x) => x.lifecycle });
    assert.equal(cc.refunded, 0);
    // Another clinic cannot touch it.
    const { owner: o2 } = await partnerSvc.createPartner({ kind: 'clinic', name: 'Third', contactPhone: nextPhone(), invoiceSeriesPrefix: 'TH',
      firstOwner: { phone: nextPhone(), name: 'T' } } as any);
    await assert.rejects(() => clinic.markArrived(actorFor(o2), e.booking.bookingId), code('BOOKING_NOT_FOUND'));
  });

  await check('appointment list: desk and online bookings at the clinic\'s branches, patient contact, scope and range limits', async () => {
    const slots = await clinic.deskSlots(own, { doctorId: drRao.id, branchId: A, date: addDays(today, 4) });
    const onlineUser = await UserModel.create({ phone: nextPhone(), userType: 'user', name: 'Online Patient' } as any);
    const ob = await createBookingWithHolds({ bookingType: 'consultation', userId: String(onlineUser._id), specialistId: drRao.id, slotId: slots[0]!.slotId,
      bookingDate: ymd(addDays(today, 4)), bookingTime: slots[0]!.startTime, consultationMode: 'in-person', serviceMode: 'in-person', price: 600, status: 'confirmed', paymentStatus: 'paid' } as any);
    await clinic.createDeskAppointment(own, { slotId: slots[1]!.slotId, customer: { phone: nextPhone() }, requestKey: rk() });
    const list = await clinic.listClinicAppointments(own, { from: addDays(today, 4), to: addDays(today, 4) });
    const online = list.find((r) => r.bookingId === String(ob._id));
    assert.deepEqual([online?.source, online?.paidOnline, online?.branchId, online?.patient.name], ['online', true, A, 'Online Patient']);
    assert.ok(list.some((r) => r.source === 'desk' && r.payAtClinic));
    assert.ok(list.every((r) => r.branchId === A));
    assert.equal((await clinic.listClinicAppointments(own, { from: addDays(today, 4), to: addDays(today, 4), status: 'cancelled' })).every((r) => r.status === 'cancelled'), true);
    await assert.rejects(() => clinic.listClinicAppointments(own, { from: today, to: addDays(today, 40) }), code('RANGE_TOO_LONG'));
    await assert.rejects(() => clinic.listClinicAppointments(actorFor(deskA), { from: addDays(today, 4), to: addDays(today, 4), branchId: B }), code('BRANCH_SCOPE_EXCEEDED'));
  });

  await check('leaving a clinic ends its authority at once: no new desk or online clinic bookings, generated clinic slots close; bookings made stay', async () => {
    const slots = await clinic.deskSlots(own, { doctorId: drRao.id, branchId: A, date: addDays(today, 5) });
    const kept = await clinic.createDeskAppointment(own, { slotId: slots[0]!.slotId, customer: { phone: nextPhone() }, requestKey: rk() });
    await clinic.leaveClinic(drRao.id, partnerId);
    assert.equal(await SlotModel.countDocuments({ specialistId: drRao.id, branchId: A, isActive: true }), 0);
    assert.equal((await BookingModel.findById(kept.booking.bookingId).lean() as any).status, 'confirmed');
    await SlotModel.updateOne({ _id: slots[1]!.slotId }, { $set: { isActive: true, isAvailable: true } }); // even if left open
    await assert.rejects(() => clinic.createDeskAppointment(own, { slotId: slots[1]!.slotId, customer: { phone: nextPhone() }, requestKey: rk() }), code('SLOT_NOT_AVAILABLE'));
    await assert.rejects(() => clinic.leaveClinic(drRao.id, partnerId), code('MEMBERSHIP_NOT_FOUND'));
    assert.equal((await clinic.myClinics(drRao.id)).clinics.length, 0);
    assert.ok(inviteId);
  });

  await check('solo practice: one per doctor (also under concurrency), the doctor owns it, pending until an admin verifies; then in-clinic hours work', async () => {
    const drSolo = await doctor('Dr Solo', 500);
    const input = { name: 'Solo Care', invoiceSeriesPrefix: 'SC', branch: { name: 'Main', phone: '9876543210', address: addr } };
    const all = await Promise.all([clinic.createSoloPractice(drSolo.id, input), clinic.createSoloPractice(drSolo.id, input), clinic.createSoloPractice(drSolo.id, input)]);
    assert.equal(new Set(all.map((x) => String((x.partner as any)._id))).size, 1);
    assert.equal(all.filter((x) => x.created).length, 1);
    const p = await PartnerModel.findOne({ soloDoctorId: drSolo.id }).lean() as any;
    assert.deepEqual([p.kind, p.solo, p.verification.state], ['clinic', true, 'pending']);
    const ownerMember = await MemberModel.findOne({ partnerId: String(p._id), role: 'owner' }).lean();
    assert.deepEqual([ownerMember!.doctorId, ownerMember!.phone], [drSolo.id, drSolo.phone]);
    assert.ok(await SettlementAccountModel.exists({ ownerKind: 'partner', ownerId: String(p._id) }));
    const branch = await BranchModel.findOne({ partnerId: String(p._id) }).lean();
    await assert.rejects(() => saveTemplate(drSolo.id, { slotMinutes: 30, days: every({ start: '17:00', end: '18:00', modes: ['in-person'], branchId: String(branch!._id) }) as any }),
      code('CLINIC_BRANCH_NOT_ALLOWED'));
    await partnerSvc.verifyPartner(String(p._id), 'admin');
    await saveTemplate(drSolo.id, { slotMinutes: 30, days: every({ start: '17:00', end: '18:00', modes: ['in-person'], branchId: String(branch!._id) }) as any });
    assert.ok(await SlotModel.exists({ specialistId: drSolo.id, branchId: String(branch!._id) }));
    await assert.rejects(() => clinic.leaveClinic(drSolo.id, String(p._id)), code('OWNER_CANNOT_LEAVE'));
    assert.equal((await clinic.mySoloPractice(drSolo.id))!.branches.length, 1);
  });

  // ── Review findings (Q6 round 1) ──
  const second = await partnerSvc.createPartner({ kind: 'clinic', name: 'Second Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'SC2',
    firstOwner: { phone: nextPhone(), name: 'Owner Two' } } as any);
  const C = String(second.partner._id);
  await partnerSvc.verifyPartner(C, 'admin');
  const own2 = actorFor(second.owner);
  const CB = String((await partnerSvc.createBranch(own2, branchIn('Aundh')))._id);
  const drTwo = await doctor('Dr Two');
  for (const [act, br] of [[own, [A]], [own2, [CB]]] as const) {
    const inv = await clinic.inviteDoctor(act, { doctorId: drTwo.id, branchIds: [...br] });
    await clinic.respondToInvite(drTwo.id, String(inv.invite._id), true);
  }
  const at = (n: number) => addDays(today, n);

  await check('history belongs to the booking: a freed slot moving to another clinic never shows (or exposes) the old appointment there', async () => {
    await saveTemplate(drTwo.id, { slotMinutes: 30, days: every({ start: '08:00', end: '08:30', modes: ['in-person'], branchId: A }) as any });
    const s = (await clinic.deskSlots(own, { doctorId: drTwo.id, branchId: A, date: at(6) }))[0]!;
    const r = await clinic.createDeskAppointment(own, { slotId: s.slotId, customer: { phone: nextPhone(), name: 'Private Patient' }, requestKey: rk() });
    await clinic.cancelDeskAppointment(own, r.booking.bookingId, 'moved');
    const online = await UserModel.create({ phone: nextPhone(), userType: 'user', name: 'Online At A' } as any);
    const s2 = (await clinic.deskSlots(own, { doctorId: drTwo.id, branchId: A, date: at(7) }))[0]!;
    const ob = await createBookingWithHolds({ bookingType: 'consultation', userId: String(online._id), specialistId: drTwo.id, slotId: s2.slotId,
      bookingDate: ymd(at(7)), bookingTime: '08:00', consultationMode: 'in-person', serviceMode: 'in-person', price: 600, status: 'pending', paymentStatus: 'pending' } as any);
    assert.deepEqual((await BookingModel.findById(ob._id).lean() as any).clinicVisit, { partnerId, branchId: A });
    await cancelBookingSettlement({ bookingId: String(ob._id), requester: { _id: String(online._id), userType: 'user' }, reason: 'x', cancelledAt: ymd(today),
      wallets: new WalletRepository(), enforceWindow: () => undefined, lifecycle: (x) => x.lifecycle });
    // The doctor moves those hours to the second clinic: the now-unbooked template slots change branch.
    await saveTemplate(drTwo.id, { slotMinutes: 30, days: every({ start: '08:00', end: '08:30', modes: ['in-person'], branchId: CB }) as any });
    assert.equal((await SlotModel.findById(s.slotId).lean() as any).branchId, CB);
    const theirs = await clinic.listClinicAppointments(own2, { from: at(6), to: at(7) });
    assert.ok(!theirs.some((x) => x.bookingId === r.booking.bookingId || x.bookingId === String(ob._id)), 'nothing of clinic A leaks to clinic B');
    const ours = await clinic.listClinicAppointments(own, { from: at(6), to: at(7) });
    assert.ok(ours.some((x) => x.bookingId === r.booking.bookingId) && ours.some((x) => x.bookingId === String(ob._id)));
  });

  await check('the desk\'s clinic and branch scope are admitted inside the booking transaction (create and reschedule)', async () => {
    const s = (await clinic.deskSlots(own2, { doctorId: drTwo.id, branchId: CB, date: at(8) }))[0]!;
    // A desk of clinic A acting on a slot that is (now) at clinic C: refused by the shared admission itself.
    const cust = await UserModel.create({ phone: nextPhone(), userType: 'user', name: 'X' } as any);
    await assert.rejects(() => createBookingWithHolds({ bookingType: 'consultation', userId: String(cust._id), specialistId: drTwo.id, slotId: s.slotId,
      bookingDate: ymd(at(8)), bookingTime: '08:00', consultationMode: 'in-person', serviceMode: 'in-person', price: 600, status: 'confirmed', paymentStatus: 'pending',
      clinicDesk: { partnerId, branchId: A, createdBy: 'm' } } as any, undefined, { partnerId, branchIds: [] }), code('SLOT_NOT_AVAILABLE'));
    await assert.rejects(() => createBookingWithHolds({ bookingType: 'consultation', userId: String(cust._id), specialistId: drTwo.id, slotId: s.slotId,
      bookingDate: ymd(at(8)), bookingTime: '08:00', consultationMode: 'in-person', serviceMode: 'in-person', price: 600, status: 'confirmed', paymentStatus: 'pending',
      clinicDesk: { partnerId: C, branchId: CB, createdBy: 'm' } } as any), code('SLOT_NOT_AVAILABLE'), 'a desk booking needs its scope');
    assert.equal((await SlotModel.findById(s.slotId).lean() as any).currentBookings, 0);
    // A branch-B-only desk of the second clinic cannot take its branch CB slot either (scope inside, not only outside).
    const deskB = await partnerSvc.addMember(own2, { phone: nextPhone(), name: 'Other branch desk', role: 'staff', branchIds: [String((await partnerSvc.createBranch(own2, branchIn('Wakad')))._id)],
      permissions: ['bookings.manage'] } as any);
    await assert.rejects(() => createBookingWithHolds({ bookingType: 'consultation', userId: String(cust._id), specialistId: drTwo.id, slotId: s.slotId,
      bookingDate: ymd(at(8)), bookingTime: '08:00', consultationMode: 'in-person', serviceMode: 'in-person', price: 600, status: 'confirmed', paymentStatus: 'pending',
      clinicDesk: { partnerId: C, branchId: CB, createdBy: String(deskB._id) } } as any, undefined, { partnerId: C, branchIds: (deskB.branchIds ?? []).map(String) }), code('SLOT_NOT_AVAILABLE'));
    // Reschedule: the target is admitted against the desk's clinic inside the transaction too.
    const sA = (await clinic.deskSlots(own, { doctorId: drRao.id, branchId: A, date: at(9) }).catch(() => [])) as any[];
    const mine = await clinic.createDeskAppointment(own2, { slotId: s.slotId, customer: { phone: nextPhone() }, requestKey: rk() });
    await assert.rejects(() => rescheduleWithHolds({ bookingId: mine.booking.bookingId, requester: { _id: 'x', userType: 'admin' }, nextSlotId: s.slotId,
      patch: {}, desk: { partnerId, branchIds: [] } }), code('CLINIC_APPOINTMENT'));
    assert.ok(Array.isArray(sA));
  });

  await check('invitations stay within a branch-restricted manager\'s scope (list, revoke, existing pending)', async () => {
    const drThree = await doctor('Dr Three');
    const global = await clinic.inviteDoctor(own, { doctorId: drThree.id });
    const deskAActor = actorFor(deskA);
    assert.ok(!(await clinic.listInvites(deskAActor)).some((i) => String(i._id) === String(global.invite._id)));
    await assert.rejects(() => clinic.revokeInvite(deskAActor, String(global.invite._id)), code('INVITE_NOT_FOUND'));
    await assert.rejects(() => clinic.inviteDoctor(deskAActor, { doctorId: drThree.id, branchIds: [A] }), code('INVITE_PENDING'));
    assert.equal((await ClinicDoctorInviteModel.findById(global.invite._id).lean())!.state, 'pending');
    const drFour = await doctor('Dr Four');
    const mineA = await clinic.inviteDoctor(deskAActor, { doctorId: drFour.id, branchIds: [A] });
    assert.ok((await clinic.listInvites(deskAActor)).some((i) => String(i._id) === String(mineA.invite._id)));
    await clinic.revokeInvite(deskAActor, String(mineA.invite._id));
  });

  await check('a doctor linked to an existing staff record consults exactly where they accepted; the staff access is unchanged', async () => {
    const drFive = await doctor('Dr Five');
    const staffB = await partnerSvc.addMember(own, { phone: drFive.phone, name: 'Five at B desk', role: 'staff', branchIds: [B], permissions: ['bookings.view'] } as any);
    const inv = await clinic.inviteDoctor(own, { doctorId: drFive.id, branchIds: [A] });
    await clinic.respondToInvite(drFive.id, String(inv.invite._id), true);
    assert.equal(await clinicBranchAllowed(drFive.id, A), true);
    assert.equal(await clinicBranchAllowed(drFive.id, B), false);
    const m = await MemberModel.findById(staffB._id).lean();
    assert.deepEqual([m!.branchIds.map(String), (m as any).doctorBranchIds], [[B], [A]]);
  });

  await check('a desk request key is used once per desk member, whatever customer or slot a repeat names; racing repeats make one', async () => {
    const slots = await clinic.deskSlots(own, { doctorId: drRao.id, branchId: A, date: at(10) }).catch(() => []);
    const fresh = slots.length ? slots : await (async () => {
      await clinic.respondToInvite(drRao.id, String((await clinic.inviteDoctor(own, { doctorId: drRao.id, branchIds: [A] })).invite._id), true);
      await saveTemplate(drRao.id, { slotMinutes: 30, days: every({ start: '10:00', end: '12:00', modes: ['in-person'], branchId: A }) as any });
      return clinic.deskSlots(own, { doctorId: drRao.id, branchId: A, date: at(10) });
    })();
    const key = rk();
    const phone = nextPhone();
    const first = await clinic.createDeskAppointment(own, { slotId: fresh[0]!.slotId, customer: { phone }, requestKey: key });
    await assert.rejects(() => clinic.createDeskAppointment(own, { slotId: fresh[1]!.slotId, customer: { phone: nextPhone() }, requestKey: key }), code('IDEMPOTENCY_KEY_REUSED'));
    assert.equal((await clinic.createDeskAppointment(own, { slotId: fresh[0]!.slotId, customer: { phone }, requestKey: key })).booking.bookingId, first.booking.bookingId);
    const k2 = rk();
    const p2 = nextPhone();
    const all = await Promise.allSettled([1, 2, 3].map(() => clinic.createDeskAppointment(own, { slotId: fresh[2]!.slotId, customer: { phone: p2 }, requestKey: k2 })));
    const ok = all.filter((x) => x.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    assert.ok(ok.length >= 1);
    assert.equal(new Set(ok.map((x) => x.value.booking.bookingId)).size, 1);
    assert.equal(await BookingModel.countDocuments({ 'clinicDesk.requestKey': `desk:${String(owner._id)}:${k2}` }), 1);
  });

  await check('moving a checked-in appointment clears the check-in for the new time', async () => {
    const slots = await clinic.deskSlots(own, { doctorId: drRao.id, branchId: A, date: at(11) });
    const r = await clinic.createDeskAppointment(own, { slotId: slots[0]!.slotId, customer: { phone: nextPhone() }, requestKey: rk() });
    await clinic.markArrived(own, r.booking.bookingId);
    const moved = await clinic.rescheduleDeskAppointment(own, r.booking.bookingId, slots[1]!.slotId);
    assert.equal(moved.arrivedAt ?? null, null);
    assert.ok((await clinic.markArrived(own, r.booking.bookingId)).arrivedAt);
  });

  await check('the appointment list names the family member being seen, with the account holder as contact', async () => {
    const parent = await UserModel.create({ phone: nextPhone(), userType: 'user', name: 'Parent Account' } as any);
    const child = await DependentModel.create({ userId: String(parent._id), name: 'Little Kavya', relationship: 'Daughter', age: 6 } as any);
    const slots = await clinic.deskSlots(own, { doctorId: drRao.id, branchId: A, date: at(12) });
    const b = await createBookingWithHolds({ bookingType: 'consultation', userId: String(parent._id), dependentId: String(child._id), specialistId: drRao.id,
      slotId: slots[0]!.slotId, bookingDate: ymd(at(12)), bookingTime: slots[0]!.startTime, consultationMode: 'in-person', serviceMode: 'in-person', price: 600,
      status: 'confirmed', paymentStatus: 'paid' } as any);
    const row = (await clinic.listClinicAppointments(own, { from: at(12), to: at(12) })).find((x) => x.bookingId === String(b._id))!;
    assert.deepEqual([row.patient.name, row.patient.accountName, row.patient.relationship], ['Little Kavya', 'Parent Account', 'Daughter']);
    assert.equal(row.patient.phone, (parent as any).phone);
  });

  // ── HTTP: the real application routes ──
  Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
  Container.set(BannerService, new BannerService(new BannerRepository()));
  const { configureRoutes } = await import('@/routes');
  const app = express();
  app.use(express.json());
  configureRoutes(app);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const partnerToken = (m: IMember) => jwt.sign({ _id: String(m._id), memberId: String(m._id), partnerId: String(m.partnerId), userType: 'partner' }, CONFIG.JWT_SECRET_KEY);
  const adminToken = jwt.sign({ _id: new Types.ObjectId().toString(), userType: 'admin' }, CONFIG.JWT_SECRET_KEY);
  const docToken = (id: string) => jwt.sign({ _id: id, specialistId: id, userType: 'specialist' }, CONFIG.JWT_SECRET_KEY);
  const u = await UserModel.create({ phone: nextPhone(), name: 'Asha', userType: 'user', otpVerified: true } as any);
  const userToken = jwt.sign({ _id: String(u._id), userType: 'user', authVersion: 0 }, CONFIG.JWT_SECRET_KEY);
  const call = async (method: string, p: string, token: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };

  try {
    await check('HTTP: invite → doctor accepts in the portal → desk books, lists, checks in, cancels; admins as owner; roles enforced', async () => {
      const drHttp = await doctor('Dr Http');
      const inv = await call('POST', '/api/v1/partner-workspace/clinic/doctor-invites', partnerToken(owner), { doctorId: drHttp.id, branchIds: [B] });
      assert.equal(inv.status, 201);
      assert.equal((await call('POST', '/api/v1/partner-workspace/clinic/doctor-invites', partnerToken(viewer), { doctorId: drHttp.id })).status, 403);
      assert.equal((await call('POST', '/api/v1/partner-workspace/clinic/doctor-invites', partnerToken(owner), { doctorId: drHttp.id, phone: '9876543210' })).status, 400);
      const mine = await call('GET', '/api/v1/specialists/me/clinics', docToken(drHttp.id));
      assert.equal(mine.json.data.invites.length, 1);
      assert.equal((await call('POST', `/api/v1/specialists/me/clinic-invites/${mine.json.data.invites[0].inviteId}/accept`, docToken(drHttp.id))).status, 200);
      assert.equal((await call('GET', '/api/v1/specialists/me/clinics', userToken)).status, 403);
      await saveTemplate(drHttp.id, { slotMinutes: 30, days: every({ start: '15:00', end: '16:00', modes: ['in-person'], branchId: B }) as any });
      const slots = await call('GET', `/api/v1/partner-workspace/clinic/slots?doctorId=${drHttp.id}&branchId=${B}&date=${day}`, partnerToken(viewer));
      assert.equal(slots.status, 200);
      assert.equal(slots.json.data.length, 2);
      const body = { slotId: slots.json.data[0].slotId, customer: { phone: nextPhone(), name: 'Walk In' }, requestKey: 'http-desk-0001' };
      assert.equal((await call('POST', '/api/v1/partner-workspace/clinic/appointments', partnerToken(viewer), body)).status, 403, 'bookings.view cannot book');
      const booked = await call('POST', '/api/v1/partner-workspace/clinic/appointments', partnerToken(owner), body);
      assert.equal(booked.status, 201);
      assert.equal((await call('POST', '/api/v1/partner-workspace/clinic/appointments', partnerToken(owner), body)).status, 200, 'replay');
      const id = booked.json.data.booking.bookingId;
      const list = await call('GET', `/api/v1/partner-workspace/clinic/appointments?from=${day}&to=${day}&branchId=${B}`, partnerToken(viewer));
      assert.ok(list.json.data.some((r: any) => r.bookingId === id && r.patient.name === 'Walk In'));
      assert.equal((await call('POST', `/api/v1/partner-workspace/clinic/appointments/${id}/arrived`, partnerToken(owner))).status, 200);
      const adminDocs = await call('GET', `/api/v1/partner-workspace/admin/${partnerId}/workspace/clinic/doctors`, adminToken);
      assert.ok(adminDocs.json.data.some((d: any) => d.doctorId === drHttp.id));
      assert.equal((await call('POST', `/api/v1/partner-workspace/admin/${partnerId}/workspace/clinic/appointments/${id}/cancel`, adminToken, { reason: 'Clinic closed' })).status, 200);
      assert.ok(await PartnerAuditEventModel.exists({ partnerId, action: 'clinic.appointment_cancelled', targetId: id, actorKind: 'admin' }));
      assert.equal((await call('GET', '/api/v1/partner-workspace/clinic/appointments?from=2026-01-01&to=2026-03-01', partnerToken(owner))).status, 400);
      const pay = await call('POST', `/api/v1/bookings/${id}/retry-payment`, userToken, {});
      assert.notEqual(pay.status, 200);
    });

    await check('HTTP: a doctor opens a solo practice (201, then 200 with the same practice)', async () => {
      const drP = await doctor('Dr Practice');
      const input = { name: 'My Practice', invoiceSeriesPrefix: 'MP', branch: { name: 'Home clinic', phone: '9876543210', address: addr } };
      const a = await call('POST', '/api/v1/specialists/me/practice', docToken(drP.id), input);
      assert.equal(a.status, 201);
      const b = await call('POST', '/api/v1/specialists/me/practice', docToken(drP.id), input);
      assert.equal(b.status, 200);
      assert.equal(String(b.json.data.partner._id), String(a.json.data.partner._id));
      assert.equal((await call('GET', '/api/v1/specialists/me/practice', docToken(drP.id))).json.data.branches.length, 1);
      assert.equal((await call('POST', '/api/v1/specialists/me/practice', docToken(drP.id), { name: 'x' })).status, 400);
    });
  } finally {
    server.close();
  }

  await mongoose.disconnect();
  removeFixtureDir();
  console.log(`\n${passed} checks passed`);
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect(); try { removeFixtureDir(); } catch { /* already gone */ } process.exit(1); });
