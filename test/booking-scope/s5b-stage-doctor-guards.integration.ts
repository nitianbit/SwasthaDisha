/**
 * S5b (stage line): the S5 doctor-eligibility rule (isActive === true && isVerified === true) on the stage-only doctor
 * routes and booking paths. Refused for a doctor who is unverified (isVerified false), legacy (isVerified missing) or
 * inactive:
 *   - PUT /specialists/me/schedule, POST /me/bookings/:id/reschedule-no-show, POST /me/clinic-invites/:id/accept,
 *     POST /me/practice and POST /me/clinic: 403 SPECIALIST_NOT_VERIFIED (the route guard);
 *   - the clinic front-desk appointment: 400 SPECIALIST_NOT_VERIFIED / SPECIALIST_NOT_ACTIVE before any customer is
 *     created, as booking create;
 *   - every slot admission and move (createBookingWithHolds, desk reschedule, admin no-show move): 400, inside the
 *     transaction;
 *   - slot generation from a stored schedule (nightly, leave change): creates no slot.
 * Left open, checked as controls: POST /me/leave, decline of an invitation, PUT /me/finance/payout-details. Verified
 * doctors are unaffected (controls). Each non-control check fails on the code before S5b.
 *
 * Run (throwaway DB only; the script drops its collections):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/s5b_stage_doctor_guards?directConnection=true' \
 *     npx tsx test/booking-scope/s5b-stage-doctor-guards.integration.ts
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
import { createBookingWithHolds } from '@/modules/bookings/holds';
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
import { ClinicDoctorInviteModel } from '@/modules/partners/model/clinicDoctor';
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
import { expandAllDoctorTemplates } from '@/modules/doctors/services/schedule';
import { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/s5b_stage_doctor_guards?directConnection=true';
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
  notificationService: { create: async () => undefined, createSpecialistAppointmentCancelledNotification: async () => undefined },
}) as BookingService;
Container.set(BookingService, bookings);

let passed = 0;
const failed: string[] = [];
/** Runs every check (a failure is reported and the next check still runs), so a run without S5b lists each gap. */
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); }
  catch (e) { failed.push(name); console.log('FAIL -', name); console.error('  ', (e as Error)?.message?.split('\n')[0] ?? e); }
}
const code = (c: string) => (e: any) => { if (e?.code !== c) throw e; return true; };
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let ph = 7150000000;
const nextPhone = () => String(ph++);
let keySeq = 0;
const rk = (p = 's5b') => `${p}-s5b-key-${String(++keySeq).padStart(4, '0')}`;
const today = istDate(new Date());
const ymd = (iso: string) => iso.replace(/-/g, '');
const addr = { line1: '1 Road', city: 'Pune', state: 'Maharashtra', stateCode: '27', pincode: '411001' };
const clinicBranch = (name: string) => ({ name, phone: '9876500000', holidays: [], hours: {}, services: { homeCollection: false, inLab: false, inClinic: true }, address: addr }) as any;
const DAY = 86_400_000;
const later = () => new Date(Date.now() + 10 * DAY);
const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const everyDay = (modes: string[]) => Object.fromEntries(WEEK.map((d) => [d, [{ start: '09:00', end: '10:00', modes }]]));

/** A doctor; verified and active unless `over` says otherwise (`isVerified: undefined` = a legacy record without the flag). */
async function doctor(name: string, over: Record<string, unknown> = {}) {
  const id = new Types.ObjectId();
  const doc: Record<string, unknown> = { _id: id, name, phone: nextPhone(), email: `${name.replace(/\W/g, '')}@x.test`, specialization: 'General Physician',
    consultationFee: 600, isActive: true, isVerified: true, ...over };
  for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
  await SpecialistModel.collection.insertOne(doc as never);
  return String(id);
}
const setDoctor = (id: string, set: Record<string, unknown>) => SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: set });
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
const bookingInput = (userId: string, doctorId: string, s: { _id: unknown; date?: string; startTime?: string }) => ({
  bookingType: 'consultation', userId, specialistId: doctorId, doctorName: 'Dr', slotId: String(s._id), bookingDate: s.date, bookingTime: s.startTime,
  consultationMode: 'video', serviceMode: 'video', price: 400, originalPrice: 500, status: 'pending', paymentStatus: 'pending' }) as any;
async function onlineBooking(userId: string, doctorId: string) {
  const slot = await SlotModel.findById(await slotAt(doctorId, futureStart())).lean() as any;
  const b = await createBookingWithHolds(bookingInput(userId, doctorId, slot));
  await BookingModel.updateOne({ _id: b._id }, { $set: { status: 'confirmed', paymentStatus: 'paid' } });
  return String(b._id);
}
/** A confirmed online booking of the doctor (made while eligible) marked as a no-show by the doctor. */
async function noShowOf(doctorId: string) {
  const u = await customer();
  const id = await onlineBooking(u.id, doctorId);
  await bookings.markNoShow(id, { _id: doctorId, userType: 'specialist' }, later());
  return id;
}
const slotCount = (doctorId: string) => SlotModel.countDocuments({ specialistId: doctorId });

async function main() {
  await mongoose.connect(FIXTURE_URL, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [UserModel, SpecialistModel, SlotModel, BookingModel, PaymentRecordModel, WalletModel, WalletTransactionModel, RequestKeyModel,
    NotificationModel, DependentModel, DoctorReservationModel, DoctorScheduleGuardModel, DoctorScheduleTemplateModel, PartnerModel, MemberModel, BranchModel,
    PartnerAuditEventModel, ClinicDoctorInviteModel, SettlementAccountModel, LedgerEntryModel, ScheduleGuardModel] as mongoose.Model<any>[]) {
    await M.createCollection(); await M.createIndexes();
  }
  const ADMIN = new Types.ObjectId().toHexString();
  clinic.setClinicNotifier(async () => undefined);

  // ── Fixtures: a verified clinic with a desk at branch A; doctors linked while verified ──
  const { partner: cp, owner: cOwner } = await partnerSvc.createPartner({ kind: 'clinic', name: 'Care Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'CC',
    firstOwner: { phone: nextPhone(), name: 'Owner' } } as any);
  const clinicId = String(cp._id);
  await partnerSvc.verifyPartner(clinicId, 'admin');
  const own = actorFor(cOwner);
  const A = String((await partnerSvc.createBranch(own, clinicBranch('Kothrud')))._id);
  const deskM = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk', role: 'staff', branchIds: [A],
    permissions: ['bookings.view', 'bookings.manage'] } as any);
  const desk = actorFor(deskM);
  const linked = async (name: string) => {
    const id = await doctor(name);
    await clinic.linkDoctor(adminActor(ADMIN, clinicId), { doctorId: id, branchIds: [], requestKey: rk('link') });
    return id;
  };
  const deskSlot = (doctorId: string) => slotAt(doctorId, futureStart(), A);

  // ───────────────────────────── Service level ─────────────────────────────

  await check('desk appointment: an unverified doctor is refused with 400 SPECIALIST_NOT_VERIFIED before any customer is created', async () => {
    const dr = await linked('Dr Desk Unverified');
    const slotId = await deskSlot(dr);
    await setDoctor(dr, { isVerified: false });
    const users = await UserModel.countDocuments({});
    await assert.rejects(() => clinic.createDeskAppointment(desk, { slotId, customer: { phone: nextPhone() }, requestKey: rk('desk') }),
      (e: any) => e?.status === 400 && e?.code === 'SPECIALIST_NOT_VERIFIED');
    assert.equal(await UserModel.countDocuments({}), users, 'no customer account is created');
    assert.equal((await SlotModel.findById(slotId).lean() as any).currentBookings, 0);
  });

  await check('desk appointment: a legacy doctor (no isVerified) and an inactive doctor are refused, no customer created', async () => {
    const legacy = await linked('Dr Desk Legacy');
    const gone = await linked('Dr Desk Inactive');
    const s1 = await deskSlot(legacy); const s2 = await deskSlot(gone);
    await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(legacy) }, { $unset: { isVerified: 1 } });
    await setDoctor(gone, { isActive: false });
    const users = await UserModel.countDocuments({});
    await assert.rejects(() => clinic.createDeskAppointment(desk, { slotId: s1, customer: { phone: nextPhone() }, requestKey: rk('desk') }),
      (e: any) => e?.status === 400 && e?.code === 'SPECIALIST_NOT_VERIFIED');
    await assert.rejects(() => clinic.createDeskAppointment(desk, { slotId: s2, customer: { phone: nextPhone() }, requestKey: rk('desk') }),
      (e: any) => e?.status === 400 && e?.code === 'SPECIALIST_NOT_ACTIVE');
    assert.equal(await UserModel.countDocuments({}), users, 'no customer account is created');
  });

  await check('control: a verified doctor is booked at the desk, and the receipt of a desk appointment made before unverification still answers', async () => {
    const dr = await linked('Dr Desk Ok');
    const key = rk('desk');
    const input = { slotId: await deskSlot(dr), customer: { phone: nextPhone() }, requestKey: key };
    const made = await clinic.createDeskAppointment(desk, input);
    assert.equal(made.replayed, false);
    assert.equal(made.booking.status, 'confirmed');
    await setDoctor(dr, { isVerified: false });
    assert.equal((await clinic.createDeskAppointment(desk, input)).replayed, true, 'a lost answer is still recovered');
  });

  await check('desk reschedule: an appointment is not moved onto a slot of a doctor who became unverified (400, slot untouched)', async () => {
    const dr = await linked('Dr Desk Move');
    const made = await clinic.createDeskAppointment(desk, { slotId: await deskSlot(dr), customer: { phone: nextPhone() }, requestKey: rk('desk') });
    const from = String((await BookingModel.findById(made.booking.bookingId).lean())!.slotId);
    const target = await deskSlot(dr);
    await setDoctor(dr, { isVerified: false });
    await assert.rejects(() => clinic.rescheduleDeskAppointment(desk, made.booking.bookingId, target), code('SPECIALIST_NOT_VERIFIED'));
    assert.equal((await SlotModel.findById(target).lean() as any).currentBookings, 0);
    assert.equal(String((await BookingModel.findById(made.booking.bookingId).lean())!.slotId), from, 'the appointment keeps its slot');
  });

  await check('slot admission: no path books a slot of an unverified doctor (createBookingWithHolds refuses inside the transaction)', async () => {
    const dr = await doctor('Dr Admission', { isVerified: false });
    const u = await customer();
    const slot = await SlotModel.findById(await slotAt(dr, futureStart())).lean() as any;
    await assert.rejects(() => createBookingWithHolds(bookingInput(u.id, dr, slot)), (e: any) => e?.status === 400 && e?.code === 'SPECIALIST_NOT_VERIFIED');
    assert.equal(await BookingModel.countDocuments({ specialistId: dr }), 0);
    assert.equal((await SlotModel.findById(slot._id).lean() as any).currentBookings, 0);
  });

  await check('admin no-show move: a no-show of a doctor who became unverified is not moved (400 SPECIALIST_NOT_VERIFIED)', async () => {
    const dr = await doctor('Dr Admin Move');
    const id = await noShowOf(dr);
    const target = await slotAt(dr, futureStart());
    await setDoctor(dr, { isVerified: false });
    await assert.rejects(() => bookings.rescheduleNoShow(id, { _id: ADMIN, userType: 'admin' }, { slotId: target, requestKey: rk('ns') }), code('SPECIALIST_NOT_VERIFIED'));
    assert.equal((await BookingModel.findById(id).lean())!.status, 'no_show');
  });

  await check('slot generation: the nightly expansion creates no slot from the stored schedule of an unverified or legacy doctor', async () => {
    const unv = await doctor('Dr Nightly Unverified', { isVerified: false });
    const legacy = await doctor('Dr Nightly Legacy', { isVerified: undefined });
    for (const d of [unv, legacy]) {
      await DoctorScheduleTemplateModel.create({ doctorId: d, slotMinutes: 30, days: everyDay(['video']), leaveDates: [], isActive: true } as any);
    }
    await expandAllDoctorTemplates();
    assert.deepEqual([await slotCount(unv), await slotCount(legacy)], [0, 0]);
  });

  await check('control: the nightly expansion still creates slots for a verified doctor', async () => {
    const ver = await doctor('Dr Nightly Ok');
    await DoctorScheduleTemplateModel.create({ doctorId: ver, slotMinutes: 30, days: everyDay(['video']), leaveDates: [], isActive: true } as any);
    await expandAllDoctorTemplates();
    assert.ok(await slotCount(ver) >= 40, 'about two slots a day for 30 days');
  });

  // ───────────────────────────── HTTP: the real specialist router ─────────────────────────────
  const { default: specialistRouter } = await import('@/modules/specialists/routes');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/specialists', authenticate, specialistRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/specialists`;
  const call = async (method: string, p: string, token: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const tok = (id: string) => jwt.sign({ _id: id, specialistId: id, userType: 'specialist' }, CONFIG.JWT_SECRET_KEY);
  const notVerified = (r: { status: number; json: any }, what: string) => assert.deepEqual([r.status, r.json.code], [403, 'SPECIALIST_NOT_VERIFIED'], what);
  const schedule = { slotMinutes: 30, days: everyDay(['video']) };
  const practice = (prefix: string) => ({ name: `${prefix} Clinic`, invoiceSeriesPrefix: prefix, branch: { name: 'Main', phone: '9876500002', address: addr } });
  const leaveDay = ymd(addDays(today, 5));

  try {
    const unv = await doctor('Dr Self Signup', { isVerified: false });
    const legacy = await doctor('Dr Legacy', { isVerified: undefined });
    const gone = await doctor('Dr Inactive', { isActive: false });
    const ver = await doctor('Dr Verified');

    await check('PUT /me/schedule: unverified, legacy and inactive doctors get 403 SPECIALIST_NOT_VERIFIED; no template, no slots', async () => {
      for (const [d, what] of [[unv, 'unverified'], [legacy, 'legacy'], [gone, 'inactive']] as const) {
        notVerified(await call('PUT', '/me/schedule', tok(d), schedule), what);
        assert.equal(await DoctorScheduleTemplateModel.exists({ doctorId: d }), null, `${what}: no template`);
        assert.equal(await slotCount(d), 0, `${what}: no slots`);
      }
    });

    await check('control: PUT /me/schedule by a verified doctor saves the schedule and creates its slots', async () => {
      const r = await call('PUT', '/me/schedule', tok(ver), schedule);
      assert.equal(r.status, 200);
      assert.ok(r.json.data.expansion.inserted >= 40);
    });

    await check('POST /me/leave stays open for an unverified doctor, and the expansion it runs creates no slot from a stored schedule', async () => {
      const d = await doctor('Dr Leave Unverified', { isVerified: false });
      await DoctorScheduleTemplateModel.create({ doctorId: d, slotMinutes: 30, days: everyDay(['video']), leaveDates: [], isActive: true } as any);
      const r = await call('POST', '/me/leave', tok(d), { date: leaveDay });
      assert.equal(r.status, 200, 'leave stays open');
      assert.equal(await slotCount(d), 0, 'no slots');
      assert.equal((await call('DELETE', `/me/leave/${leaveDay}`, tok(d))).status, 200);
      assert.equal(await slotCount(d), 0, 'no slots after removing the leave either');
    });

    await check('POST /me/bookings/:id/reschedule-no-show: a doctor who became unverified gets 403 SPECIALIST_NOT_VERIFIED; the booking stays a no-show', async () => {
      const d = await doctor('Dr NoShow Unverified');
      const id = await noShowOf(d);
      const target = await slotAt(d, futureStart());
      await setDoctor(d, { isVerified: false });
      notVerified(await call('POST', `/me/bookings/${id}/reschedule-no-show`, tok(d), { slotId: target, requestKey: rk('ns') }), 'no-show move');
      assert.equal((await BookingModel.findById(id).lean())!.status, 'no_show');
    });

    await check('control: a verified doctor moves their own no-show', async () => {
      const d = await doctor('Dr NoShow Ok');
      const id = await noShowOf(d);
      const r = await call('POST', `/me/bookings/${id}/reschedule-no-show`, tok(d), { slotId: await slotAt(d, futureStart()), requestKey: rk('ns') });
      assert.deepEqual([r.status, r.json.data?.status], [200, 'confirmed']);
    });

    const invite = async (d: string) => String((await ClinicDoctorInviteModel.create({ partnerId: clinicId, doctorId: d, branchIds: [], invitedBy: String(cOwner._id), state: 'pending' }))._id);

    await check('POST /me/clinic-invites/:id/accept: unverified and legacy doctors get 403 SPECIALIST_NOT_VERIFIED', async () => {
      for (const [d, what] of [[unv, 'unverified'], [legacy, 'legacy']] as const) {
        const inv = await invite(d);
        notVerified(await call('POST', `/me/clinic-invites/${inv}/accept`, tok(d)), what);
        assert.equal((await ClinicDoctorInviteModel.findById(inv).lean())!.state, 'pending');
      }
      assert.equal(await MemberModel.exists({ doctorId: { $in: [unv, legacy] } }), null);
    });

    await check('control: a verified doctor\'s accept answers as before (invitations retired: 409), and a legacy doctor can still decline', async () => {
      const r = await call('POST', `/me/clinic-invites/${await invite(ver)}/accept`, tok(ver));
      assert.deepEqual([r.status, r.json.code], [409, 'INVITE_NO_LONGER_VALID']);
      const old = await doctor('Dr Legacy Declines', { isVerified: undefined });
      const dec = await call('POST', `/me/clinic-invites/${await invite(old)}/decline`, tok(old));
      assert.deepEqual([dec.status, dec.json.data?.accepted], [200, false]);
    });

    await check('POST /me/practice and POST /me/clinic: unverified, legacy and inactive doctors get 403 SPECIALIST_NOT_VERIFIED; no clinic created', async () => {
      for (const [d, what] of [[unv, 'unverified'], [legacy, 'legacy'], [gone, 'inactive']] as const) {
        notVerified(await call('POST', '/me/practice', tok(d), practice('PRA')), `${what} practice`);
        notVerified(await call('POST', '/me/clinic', tok(d), { ...practice('CLI'), requestKey: rk('clinic') }), `${what} clinic`);
      }
      assert.equal(await PartnerModel.exists({ soloDoctorId: { $in: [unv, legacy, gone] } }), null);
    });

    await check('control: a verified doctor creates their clinic (201)', async () => {
      const d = await doctor('Dr Clinic Ok');
      const r = await call('POST', '/me/clinic', tok(d), { ...practice('MINE'), requestKey: rk('clinic') });
      assert.deepEqual([r.status, r.json.data?.partner?.soloDoctorId], [201, d]);
    });

    await check('control: PUT /me/finance/payout-details stays open while pending; the details wait for admin verification', async () => {
      const r = await call('PUT', '/me/finance/payout-details', tok(unv), { method: 'upi', upiId: 'drself@okbank' });
      assert.equal(r.status, 200);
      const acc = await SettlementAccountModel.findOne({ ownerKind: 'doctor', ownerId: unv }).lean() as any;
      assert.equal(acc?.payoutDetailsState, 'unverified');
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} checks passed${failed.length ? `, ${failed.length} FAILED: ${failed.join(' | ')}` : ''}`);
  if (failed.length) throw new Error(`${failed.length} checks failed`);
}

main().then(() => mongoose.disconnect()).catch(async (e) => { console.error(e?.message ?? e); await mongoose.disconnect(); process.exit(1); });
