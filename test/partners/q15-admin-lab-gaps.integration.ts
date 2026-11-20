/**
 * Q15: backend gaps found by the admin and lab web packets — moves stay with the booking's doctor (no-show, ordinary and
 * desk), the booking list filters no-shows and names the patient for admins, an admin's no-show move tells the doctor,
 * the admin pharmacy edit (version fence, clearable fields, sign-in contact changes end sessions, uniqueness), the keyed
 * admin pharmacy create with its by-key lookup/abandon and the phone filter, and the owner-only professional route.
 * Real MongoDB replica set; the real bookings, pharmacies and partner-workspace routers for the HTTP checks.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed), so the suite can be run against the
 * code before Q15 to see each check fail.
 *
 * Run (throwaway DB only; the script drops its collections):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q15_admin_lab_gaps_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx test/partners/q15-admin-lab-gaps.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { authenticate, authenticateOptional } from '@/modules/middleware/auth';
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
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { PharmacyService } from '@/modules/pharmacies/services';
import { UserRepository } from '@/modules/user/repository';
import { AuthSessionModel } from '@/modules/auth/model/session';
import { DoctorReservationModel, DoctorScheduleGuardModel } from '@/modules/doctors/model/reservation';
import { DoctorScheduleTemplateModel } from '@/modules/doctors/model/schedule';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import { ClinicDoctorInviteModel } from '@/modules/partners/model/clinicDoctor';
import { SettlementAccountModel, LedgerEntryModel } from '@/modules/partners/model/settlement';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { PartnerService, PartnerActor, adminActor } from '@/modules/partners/services';
import * as clinic from '@/modules/partners/services/clinic';
import { istDate, addDays } from '@/modules/partners/services/slots';
import { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q15_admin_lab_gaps_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const partnerRepo = new PartnerRepository();
const partnerSvc = new PartnerService(partnerRepo, new MemberRepository(), new BranchRepository());
Container.set(PartnerService, partnerSvc);
const notices: { userId: string; key?: string; type?: string }[] = [];
const bookings = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), walletRepository: new WalletRepository(),
  bookingReminderScheduler: { clearBookingReminders: async () => undefined, scheduleBookingReminders: async () => undefined },
  notificationService: {
    create: async (n: { userId: string; idempotencyKey?: string; type?: string }) => { notices.push({ userId: n.userId, key: n.idempotencyKey, type: n.type }); },
    createSpecialistAppointmentCancelledNotification: async () => undefined,
  },
}) as BookingService;
Container.set(BookingService, bookings);
Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('ok -', name); }
  catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
const code = (c: string) => (e: any) => { if (e?.code !== c) throw e; return true; };
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let ph = 7150000000;
const nextPhone = () => String(ph++);
let keySeq = 0;
const rk = (p = 'q15-key') => `${p}-${String(++keySeq).padStart(4, '0')}`;
const today = istDate(new Date());
const ymd = (iso: string) => iso.replace(/-/g, '');
const addr = { line1: '1 Road', city: 'Pune', state: 'Maharashtra', stateCode: '27', pincode: '411001' };
const clinicBranch = (name: string) => ({ name, phone: '9876500000', holidays: [], hours: {}, services: { homeCollection: false, inLab: false, inClinic: true }, address: addr }) as any;
const DAY = 86_400_000;

async function doctor(name: string) {
  const id = new Types.ObjectId();
  await SpecialistModel.collection.insertOne({ _id: id, name, phone: nextPhone(), email: `${name.replace(/\W/g, '')}@example.com`, specialization: 'General Physician',
    consultationFee: 600, isActive: true, isVerified: true } as never);
  return String(id);
}
async function customer(name = 'Asha') {
  const u = await UserModel.create({ phone: nextPhone(), name, userType: 'user', otpVerified: true, isVerified: true } as any);
  await WalletModel.create({ userId: String(u._id), balance: 0, isActive: true });
  return { id: String(u._id), phone: (u as any).phone as string };
}
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
  const slotId = await slotAt(doctorId, futureStart());
  const s = await SlotModel.findById(slotId).lean() as any;
  const b = await createBookingWithHolds({ bookingType: 'consultation', userId, specialistId: doctorId, doctorName: 'Dr', slotId, bookingDate: s.date,
    bookingTime: s.startTime, consultationMode: 'video', serviceMode: 'video', price: 400, originalPrice: 500, status: 'pending', paymentStatus: 'pending',
    ...over } as any);
  await BookingModel.updateOne({ _id: b._id }, { $set: { status: 'confirmed', paymentStatus: 'paid' } });
  return String(b._id);
}
const later = () => new Date(Date.now() + 10 * DAY);

async function main() {
  await mongoose.connect(FIXTURE_URL, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [UserModel, SpecialistModel, SlotModel, BookingModel, PaymentRecordModel, WalletModel, WalletTransactionModel, RequestKeyModel,
    NotificationModel, DependentModel, PharmacyModel, AuthSessionModel, DoctorReservationModel, DoctorScheduleGuardModel, DoctorScheduleTemplateModel,
    PartnerModel, MemberModel, BranchModel, PartnerAuditEventModel, ClinicDoctorInviteModel, SettlementAccountModel, LedgerEntryModel] as mongoose.Model<any>[]) {
    await M.createCollection(); await M.createIndexes();
  }
  const ADMIN = new Types.ObjectId().toHexString();
  const admin = (partnerId: string) => adminActor(ADMIN, partnerId);
  clinic.setClinicNotifier(async () => undefined);

  // Fixtures: a verified clinic with one branch, a desk, two linked doctors; two online doctors.
  const { partner: cp, owner: cOwner } = await partnerSvc.createPartner({ kind: 'clinic', name: 'Care Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'CC',
    firstOwner: { phone: nextPhone(), name: 'Owner' } } as any);
  const clinicId = String(cp._id);
  await partnerSvc.verifyPartner(clinicId, 'admin');
  const own = actorFor(cOwner);
  const A = String((await partnerSvc.createBranch(own, clinicBranch('Kothrud')))._id);
  const deskM = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk', role: 'staff', branchIds: [A],
    permissions: ['bookings.view', 'bookings.manage', 'staff.manage'] } as any);
  const desk = actorFor(deskM);
  const drC = await doctor('Dr Clinic');
  const drD = await doctor('Dr Second');
  await clinic.linkDoctor(admin(clinicId), { doctorId: drC, branchIds: [], requestKey: rk('link') });
  await clinic.linkDoctor(admin(clinicId), { doctorId: drD, branchIds: [A], requestKey: rk('link') });
  const deskSlot = async (doctorId = drC) => slotAt(doctorId, futureStart(), A);
  const drN = await doctor('Dr NoShow');
  const drO = await doctor('Dr Other');

  // ───────────────────────────── 1. Moves stay with the booking's doctor ─────────────────────────────
  await check('1: an admin cannot move a doctor\'s no-show to another doctor\'s slot (409 SLOT_NOT_THIS_DOCTOR; nothing changes)', async () => {
    const u = await customer();
    const id = await onlineBooking(u.id, drN);
    await bookings.markNoShow(id, { _id: drN, userType: 'specialist' }, later());
    const before = await BookingModel.findById(id).lean() as any;
    const theirs = await slotAt(drO, futureStart());
    const key = rk('ns');
    await assert.rejects(() => bookings.rescheduleNoShow(id, { _id: ADMIN, userType: 'admin' }, { slotId: theirs, requestKey: key }), code('SLOT_NOT_THIS_DOCTOR'));
    const after = await BookingModel.findById(id).lean() as any;
    assert.deepEqual([after.status, after.slotId, after.specialistId], ['no_show', before.slotId, drN]);
    assert.equal((await SlotModel.findById(theirs).lean() as any).currentBookings, 0);
    assert.equal(await RequestKeyModel.countDocuments({ key }), 0, 'the refused move claims no key');
    // The doctor themself is refused the same way; their own later slot still works.
    await assert.rejects(() => bookings.rescheduleNoShow(id, { _id: drN, userType: 'specialist' }, { slotId: theirs, requestKey: rk('ns') }), code('SLOT_NOT_THIS_DOCTOR'));
    const moved = await bookings.rescheduleNoShow(id, { _id: ADMIN, userType: 'admin' }, { slotId: await slotAt(drN, futureStart()), requestKey: rk('ns') });
    assert.equal(moved.status, 'confirmed');
  });

  await check('1: ordinary reschedules (customer, admin) and desk moves (ordinary and no-show) refuse another doctor\'s slot', async () => {
    const u = await customer();
    const id = await onlineBooking(u.id, drN);
    const theirs = await slotAt(drO, futureStart());
    await assert.rejects(() => rescheduleWithHolds({ bookingId: id, requester: { _id: u.id, userType: 'user' }, nextSlotId: theirs, patch: {} }), code('SLOT_NOT_THIS_DOCTOR'));
    await assert.rejects(() => rescheduleWithHolds({ bookingId: id, requester: { _id: ADMIN, userType: 'admin' }, nextSlotId: theirs, patch: {} }), code('SLOT_NOT_THIS_DOCTOR'));
    // Desk: drD also consults at branch A, so the slot passes every clinic check except the doctor.
    const made = await clinic.createDeskAppointment(desk, { slotId: await deskSlot(drC), customer: { phone: nextPhone() }, requestKey: rk('desk') });
    const apptId = made.booking.bookingId;
    const other = await deskSlot(drD);
    await assert.rejects(() => clinic.rescheduleDeskAppointment(desk, apptId, other), code('SLOT_NOT_THIS_DOCTOR'));
    await BookingModel.updateOne({ _id: apptId }, { $set: { bookingDate: ymd(addDays(today, -1)) } });
    await clinic.closeDeskAppointment(desk, apptId, 'no_show', new Date());
    await assert.rejects(() => clinic.rescheduleDeskNoShow(desk, apptId, { slotId: other, requestKey: rk('ns') }), code('SLOT_NOT_THIS_DOCTOR'));
    assert.equal((await SlotModel.findById(other).lean() as any).currentBookings, 0);
    const moved = await clinic.rescheduleDeskNoShow(desk, apptId, { slotId: await deskSlot(drC), requestKey: rk('ns') });
    assert.equal(moved.status, 'confirmed');
  });

  await check('1 (regression): a no-show move admits the slot\'s modes and clinic like any booking (video → in-clinic slot refused)', async () => {
    const u = await customer();
    const id = await onlineBooking(u.id, drC);
    await bookings.markNoShow(id, { _id: drC, userType: 'specialist' }, later());
    await assert.rejects(async () => bookings.rescheduleNoShow(id, { _id: ADMIN, userType: 'admin' }, { slotId: await deskSlot(drC), requestKey: rk('ns') }),
      code('SLOT_NOT_AVAILABLE'));
    assert.equal((await BookingModel.findById(id).lean() as any).status, 'no_show');
  });

  // ───────────────────────────── 3. An admin's no-show move tells the doctor ─────────────────────────────
  await check('3: an admin\'s no-show move notifies the customer and the doctor (once); a doctor\'s own move notifies only the customer', async () => {
    const u = await customer();
    const id = await onlineBooking(u.id, drN);
    await bookings.markNoShow(id, { _id: drN, userType: 'specialist' }, later());
    const before = notices.length;
    const key = rk('ns');
    const target = await slotAt(drN, futureStart());
    await bookings.rescheduleNoShow(id, { _id: ADMIN, userType: 'admin' }, { slotId: target, requestKey: key });
    await bookings.rescheduleNoShow(id, { _id: ADMIN, userType: 'admin' }, { slotId: target, requestKey: key }); // replay: nothing again
    const sent = notices.slice(before);
    assert.deepEqual(sent.map((n) => n.userId).sort(), [u.id, drN].sort());
    assert.deepEqual(sent.find((n) => n.userId === drN), { userId: drN, key: `booking:${id}:no_show_rescheduled:doctor`, type: 'specialist_general' });
    const id2 = await onlineBooking(u.id, drN);
    await bookings.markNoShow(id2, { _id: drN, userType: 'specialist' }, later());
    const mark = notices.length;
    await bookings.rescheduleNoShow(id2, { _id: drN, userType: 'specialist' }, { slotId: await slotAt(drN, futureStart()), requestKey: rk('ns') });
    assert.deepEqual(notices.slice(mark).map((n) => n.userId), [u.id]);
  });

  // ───────────────────────────── HTTP: the real routers ─────────────────────────────
  const [{ default: bookingRouter }, pharmacyRoutes, { default: partnerRouter }] = await Promise.all([
    import('@/modules/bookings/routes'), import('@/modules/pharmacies/routes'), import('@/modules/partners/routes')]);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/bookings', authenticate, bookingRouter);
  app.use('/api/v1/pharmacies', authenticateOptional, pharmacyRoutes.publicPharmacyRouter);
  app.use('/api/v1/pharmacies', authenticate, pharmacyRoutes.default);
  app.use('/api/v1/partner-workspace', authenticate, partnerRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, token: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const adminToken = jwt.sign({ _id: ADMIN, userType: 'admin' }, CONFIG.JWT_SECRET_KEY);
  const ADMIN2 = new Types.ObjectId().toHexString();
  const admin2Token = jwt.sign({ _id: ADMIN2, userType: 'admin' }, CONFIG.JWT_SECRET_KEY);
  const partnerToken = (m: IMember) => jwt.sign({ _id: String(m._id), memberId: String(m._id), partnerId: String(m.partnerId), userType: 'partner' }, CONFIG.JWT_SECRET_KEY);
  try {
    // ───────────────────────────── 2. Booking list ─────────────────────────────
    await check('2: GET /bookings?status=no_show lists no-shows; admin rows name the patient (family member or holder); customers see no patientName', async () => {
      const holder = await customer('Meera Holder');
      const dep = await DependentModel.create({ userId: holder.id, name: 'Kiran Child', relationship: 'Son', isActive: true } as any);
      const self = await onlineBooking(holder.id, drN);
      const forDep = await onlineBooking(holder.id, drN, { dependentId: String(dep._id) });
      const stillConfirmed = await onlineBooking(holder.id, drN);
      await bookings.markNoShow(self, { _id: drN, userType: 'specialist' }, later());
      await bookings.markNoShow(forDep, { _id: drN, userType: 'specialist' }, later());
      const paged = await call('GET', `/api/v1/bookings?status=no_show&userId=${holder.id}&page=1&limit=50`, adminToken);
      assert.equal(paged.status, 200, JSON.stringify(paged.json));
      const byId = new Map(paged.json.data.map((r: any) => [String(r._id), r]));
      assert.deepEqual([byId.has(self), byId.has(forDep), byId.has(stillConfirmed)], [true, true, false]);
      assert.ok(paged.json.data.every((r: any) => r.status === 'no_show'));
      assert.equal((byId.get(self) as any).patientName, 'Meera Holder');
      assert.equal((byId.get(forDep) as any).patientName, 'Kiran Child');
      const all = await call('GET', '/api/v1/bookings?status=no_show', adminToken);
      assert.equal(all.status, 200);
      assert.equal(all.json.data.find((r: any) => String(r._id) === forDep).patientName, 'Kiran Child');
      const userToken = jwt.sign({ _id: holder.id, userType: 'user' }, CONFIG.JWT_SECRET_KEY);
      const mine = await call('GET', '/api/v1/bookings?status=no_show&page=1&limit=50', userToken);
      assert.equal(mine.status, 200, JSON.stringify(mine.json));
      assert.equal(mine.json.data.length, 2);
      assert.ok(mine.json.data.every((r: any) => !('patientName' in r)), 'customers see their rows unchanged');
    });

    // ───────────────────────────── 4. Admin pharmacy edit ─────────────────────────────
    const newPharmacy = async (over: Record<string, unknown> = {}) => {
      const r = await call('POST', '/api/v1/pharmacies', adminToken, { name: 'Shree Medicals', phone: nextPhone(), email: `p${ph}@example.com`, gstNumber: '27ABCDE1234F1Z5',
        drugLicenseNumber: 'DL-1', address: '2 Road', ownerName: 'Ravi', ...over });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      return r.json.data;
    };
    let sessionN = 0;
    const openSession = async (pharmacyId: string, audience: 'workspace' | 'native_workspace') => {
      const now = new Date();
      const _id = `q15-sess-${++sessionN}`;
      await AuthSessionModel.create({ _id, audience, userType: 'pharmacy', userId: pharmacyId, authTime: now, absoluteExpiresAt: new Date(now.getTime() + DAY),
        idleExpiresAt: new Date(now.getTime() + DAY), gen: 1, createdAt: now });
      return _id;
    };
    const live = async (ids: string[]) => AuthSessionModel.countDocuments({ _id: { $in: ids }, revokedAt: { $exists: false } });

    await check('4: PUT /pharmacies/:id with a stale expectedUpdatedAt is refused (409 RECORD_CHANGED); the current one is accepted', async () => {
      const p = await newPharmacy();
      const stale = await call('PUT', `/api/v1/pharmacies/${p._id}`, adminToken, { name: 'Renamed', expectedUpdatedAt: new Date(0).toISOString() });
      assert.deepEqual([stale.status, stale.json.code], [409, 'RECORD_CHANGED']);
      assert.equal((await PharmacyModel.findById(p._id).lean())!.name, 'Shree Medicals');
      const ok = await call('PUT', `/api/v1/pharmacies/${p._id}`, adminToken, { name: 'Renamed', expectedUpdatedAt: p.updatedAt });
      assert.deepEqual([ok.status, ok.json.data.name], [200, 'Renamed']);
      const again = await call('PUT', `/api/v1/pharmacies/${p._id}`, adminToken, { name: 'Twice', expectedUpdatedAt: p.updatedAt });
      assert.deepEqual([again.status, again.json.code], [409, 'RECORD_CHANGED']);
    });

    await check('4: optional pharmacy fields are cleared with null or ""; the phone cannot be cleared', async () => {
      const p = await newPharmacy({ city: 'Pune', pincode: '411001', nickname: 'Shree' });
      const r = await call('PUT', `/api/v1/pharmacies/${p._id}`, adminToken, { email: null, gstNumber: '', drugLicenseNumber: null, address: '', pincode: null, nickname: '', city: 'Mumbai' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const stored = await PharmacyModel.findById(p._id).lean() as any;
      for (const f of ['email', 'gstNumber', 'drugLicenseNumber', 'address', 'pincode', 'nickname']) assert.equal(stored[f], undefined, `${f} cleared`);
      assert.deepEqual([stored.city, stored.ownerName, stored.phone], ['Mumbai', 'Ravi', p.phone]);
      for (const phone of [null, '']) {
        const bad = await call('PUT', `/api/v1/pharmacies/${p._id}`, adminToken, { phone });
        assert.deepEqual([bad.status, bad.json.code], [400, 'VALIDATION_ERROR']);
      }
    });

    await check('4: a changed phone or a changed/removed email ends the pharmacy\'s web and app sessions (in the edit); other edits and a first email do not', async () => {
      const p = await newPharmacy();
      const other = await newPharmacy();
      const otherSess = await openSession(other._id, 'workspace');
      let s = [await openSession(p._id, 'workspace'), await openSession(p._id, 'native_workspace')];
      assert.equal((await call('PUT', `/api/v1/pharmacies/${p._id}`, adminToken, { name: 'Only name', ownerName: null })).status, 200);
      assert.equal(await live(s), 2, 'a non-contact edit ends nothing');
      assert.equal((await call('PUT', `/api/v1/pharmacies/${p._id}`, adminToken, { phone: nextPhone() })).status, 200);
      assert.equal(await live(s), 0, 'a phone change ends both sessions');
      assert.equal((await AuthSessionModel.findById(s[0]).lean())!.revokeReason, 'sign_in_phone_changed');
      s = [await openSession(p._id, 'workspace')];
      assert.equal((await call('PUT', `/api/v1/pharmacies/${p._id}`, adminToken, { email: `new${ph}@example.com` })).status, 200);
      assert.equal(await live(s), 0, 'an email change ends the session');
      s = [await openSession(p._id, 'native_workspace')];
      assert.equal((await call('PUT', `/api/v1/pharmacies/${p._id}`, adminToken, { email: '' })).status, 200);
      assert.equal(await live(s), 0, 'removing the email ends the session');
      assert.equal((await AuthSessionModel.findById(s[0]).lean())!.revokeReason, 'sign_in_email_changed');
      s = [await openSession(p._id, 'workspace')];
      assert.equal((await call('PUT', `/api/v1/pharmacies/${p._id}`, adminToken, { email: `first${ph}@example.com` })).status, 200);
      assert.equal(await live(s), 1, 'a first email ends nothing');
      assert.equal(await live([otherSess]), 1, 'another pharmacy is untouched');
    });

    await check('4: phone and email stay unique among pharmacies', async () => {
      const p = await newPharmacy();
      const q = await newPharmacy();
      const s = [await openSession(p._id, 'workspace')];
      const dupPhone = await call('PUT', `/api/v1/pharmacies/${p._id}`, adminToken, { phone: q.phone });
      assert.deepEqual([dupPhone.status, dupPhone.json.code], [400, 'PHONE_ALREADY_EXISTS']);
      const dupEmail = await call('PUT', `/api/v1/pharmacies/${p._id}`, adminToken, { email: q.email.toUpperCase() });
      assert.deepEqual([dupEmail.status, dupEmail.json.code], [400, 'EMAIL_ALREADY_EXISTS']);
      assert.equal(await live(s), 1, 'a refused edit ends nothing');
    });

    // ───────────────────────────── 5. Keyed admin pharmacy create ─────────────────────────────
    await check('5: POST /pharmacies with requestKey: once per (admin, key), replay 200, other content 409, by-key, abandon', async () => {
      const body = { name: 'Keyed Pharmacy', phone: nextPhone(), email: `k${ph}@example.com`, requestKey: rk('pharm') };
      const first = await call('POST', '/api/v1/pharmacies', adminToken, body);
      assert.equal(first.status, 201, JSON.stringify(first.json));
      const again = await call('POST', '/api/v1/pharmacies', adminToken, { ...body, email: body.email.toUpperCase() });
      assert.deepEqual([again.status, again.json.data._id, again.json.replayed], [200, first.json.data._id, true]);
      const other = await call('POST', '/api/v1/pharmacies', adminToken, { ...body, name: 'Something else' });
      assert.deepEqual([other.status, other.json.code], [409, 'REQUEST_KEY_REUSED']);
      assert.equal(await PharmacyModel.countDocuments({ phone: body.phone }), 1);
      const found = await call('GET', `/api/v1/pharmacies/by-key/${body.requestKey}`, adminToken);
      assert.deepEqual([found.status, found.json.data._id], [200, first.json.data._id]);
      assert.equal((await call('GET', `/api/v1/pharmacies/by-key/${body.requestKey}`, admin2Token)).status, 404, 'another admin\'s keys are not found');
      const usedAbandon = await call('POST', `/api/v1/pharmacies/by-key/${body.requestKey}/abandon`, adminToken);
      assert.deepEqual([usedAbandon.status, usedAbandon.json.data.state, usedAbandon.json.data.pharmacy._id], [200, 'used', first.json.data._id]);
      const lostKey = rk('pharm');
      const ab = await call('POST', `/api/v1/pharmacies/by-key/${lostKey}/abandon`, adminToken);
      assert.deepEqual([ab.status, ab.json.data.state], [200, 'abandoned']);
      const late = await call('POST', '/api/v1/pharmacies', adminToken, { name: 'Late', phone: nextPhone(), requestKey: lostKey });
      assert.deepEqual([late.status, late.json.code], [409, 'REQUEST_ABANDONED']);
      // The pharmacy's own profile does not carry the admin's create key.
      const pToken = jwt.sign({ _id: first.json.data._id, pharmacyId: first.json.data._id, userType: 'pharmacy' }, CONFIG.JWT_SECRET_KEY);
      const me = await call('GET', '/api/v1/pharmacies/me/profile', pToken);
      assert.equal(me.status, 200, JSON.stringify(me.json));
      assert.deepEqual(['createdBy', 'createRequestKey', 'createRequestHash'].filter((k) => k in me.json.data), []);
    });

    await check('5: GET /pharmacies?phone= (admin) finds exactly that pharmacy', async () => {
      const p = await newPharmacy();
      await newPharmacy();
      const r = await call('GET', `/api/v1/pharmacies?phone=${p.phone}&page=1&limit=50`, adminToken);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(r.json.data.map((x: any) => x._id), [p._id]);
      const unpaged = await call('GET', `/api/v1/pharmacies?phone=${p.phone}`, adminToken);
      assert.deepEqual(unpaged.json.data.map((x: any) => x._id), [p._id]);
      assert.equal((await call('GET', '/api/v1/pharmacies?phone=12345', adminToken)).status, 400);
    });

    // ───────────────────────────── 6. Professional registrations: owners only, at the route ─────────────────────────────
    await check('6: PUT /members/:id/professional refuses a non-owner with staff.manage at the route (403 OWNER_REQUIRED, before the body); owners and admins pass', async () => {
      const lab = await partnerSvc.createPartner({ kind: 'lab', name: 'Metro Lab', contactPhone: nextPhone(), invoiceSeriesPrefix: 'ML',
        firstOwner: { phone: nextPhone(), name: 'Lab owner' } } as any);
      const labId = String(lab.partner._id);
      await partnerSvc.verifyPartner(labId, 'admin');
      const mgr = await partnerSvc.addMember(actorFor(lab.owner), { phone: nextPhone(), name: 'Manager', role: 'staff', branchIds: [], permissions: ['staff.manage'] } as any);
      const tech = await partnerSvc.addMember(actorFor(lab.owner), { phone: nextPhone(), name: 'Tech', role: 'staff', branchIds: [], permissions: ['bookings.view'] } as any);
      const path = `/api/v1/partner-workspace/members/${tech._id}/professional`;
      const invalid = await call('PUT', path, partnerToken(mgr), { professional: { kind: 'astronaut' } });
      assert.deepEqual([invalid.status, invalid.json.code], [403, 'OWNER_REQUIRED']);
      const valid = await call('PUT', path, partnerToken(mgr), { professional: { kind: 'pathologist', registrationNumber: 'MCI-1234' } });
      assert.deepEqual([valid.status, valid.json.code], [403, 'OWNER_REQUIRED']);
      assert.equal((await call('PUT', path, partnerToken(tech), { professional: null })).status, 403, 'no staff.manage: refused as before');
      const byOwner = await call('PUT', path, partnerToken(lab.owner), { professional: { kind: 'pathologist', registrationNumber: 'MCI-1234' } });
      assert.equal(byOwner.status, 200, JSON.stringify(byOwner.json));
      const byAdmin = await call('PUT', `/api/v1/partner-workspace/admin/${labId}/workspace/members/${tech._id}/professional`, adminToken, { professional: null });
      assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.json));
    });

    // ───────────────────────────── Q15 review ─────────────────────────────
    await check('5 review: without the (admin, key) unique index a keyed pharmacy create answers 503 INDEXES_OUTDATED and creates nothing', async () => {
      const reset = (await import('@/modules/common/utils/requiredIndex').catch(() => ({}))) as { resetIndexChecks?: () => void };
      const name = (await PharmacyModel.collection.indexes()).find((ix: any) => ix.key?.createdBy === 1 && ix.key?.createRequestKey === 1)?.name;
      if (name) await PharmacyModel.collection.dropIndex(name);
      reset.resetIndexChecks?.();
      try {
        const phone = nextPhone();
        const r = await call('POST', '/api/v1/pharmacies', adminToken, { name: 'No Index', phone, requestKey: rk('pharm') });
        assert.deepEqual([r.status, r.json.code], [503, 'INDEXES_OUTDATED']);
        assert.equal(await PharmacyModel.countDocuments({ phone }), 0);
        assert.equal((await call('POST', '/api/v1/pharmacies', adminToken, { name: 'Unkeyed', phone: nextPhone() })).status, 201, 'unkeyed create unchanged');
      } finally {
        await PharmacyModel.createIndexes();
      }
      assert.equal((await call('POST', '/api/v1/pharmacies', adminToken, { name: 'Keyed again', phone: nextPhone(), requestKey: rk('pharm') })).status, 201);
    });

    await check('3 review: concurrent identical keyed pharmacy creates all answer with the one pharmacy (never 400 PHONE/EMAIL_ALREADY_EXISTS)', async () => {
      const body = { name: 'Race Pharmacy', phone: nextPhone(), email: `race${ph}@example.com`, requestKey: rk('pharm') };
      const answers = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/api/v1/pharmacies', adminToken, body)));
      assert.ok(answers.every((a) => [200, 201].includes(a.status)), JSON.stringify(answers.map((a) => [a.status, a.json.code])));
      assert.equal(new Set(answers.map((a) => a.json.data._id)).size, 1);
      assert.equal(answers.filter((a) => a.status === 201).length, 1);
    });

    await check('4 review: GET /auth/profile for a pharmacy leaves out the admin create key', async () => {
      const made = await call('POST', '/api/v1/pharmacies', adminToken, { name: 'Profile Pharmacy', phone: nextPhone(), requestKey: rk('pharm') });
      assert.equal(made.status, 201);
      assert.ok((await PharmacyModel.findById(made.json.data._id).lean() as any).createRequestKey, 'stored');
      const { AuthController } = await import('@/modules/auth/controller');
      const ctl = new AuthController();
      let body: any;
      const res: any = { status: () => res, json: (b: unknown) => { body = b; return res; } };
      await ctl.getProfile({ user: { _id: made.json.data._id, pharmacyId: made.json.data._id, userType: 'pharmacy' } } as any, res, () => undefined);
      assert.equal(body?.data?.user?.name, 'Profile Pharmacy');
      assert.deepEqual(['createdBy', 'createRequestKey', 'createRequestHash'].filter((k) => k in body.data.user), []);
    });

    await check('5 review: pharmacy emails are unique under concurrency (index email_unique_1): two creates or two edits racing for one email never both win', async () => {
      const email = `same${ph}@example.com`;
      const creates = await Promise.all([0, 1, 2, 3].map(() => call('POST', '/api/v1/pharmacies', adminToken, { name: 'Twin', phone: nextPhone(), email })));
      assert.equal(creates.filter((a) => a.status === 201).length, 1, JSON.stringify(creates.map((a) => [a.status, a.json.code])));
      assert.ok(creates.filter((a) => a.status !== 201).every((a) => a.json.code === 'EMAIL_ALREADY_EXISTS' && [400, 409].includes(a.status)));
      const p1 = await newPharmacy({ email: undefined });
      const p2 = await newPharmacy({ email: undefined });
      const email2 = `edit${ph}@example.com`;
      const edits = await Promise.all([p1, p2, p1, p2].map((p) => call('PUT', `/api/v1/pharmacies/${p._id}`, adminToken, { email: email2 })));
      assert.ok(edits.some((a) => a.status === 200));
      assert.ok(edits.filter((a) => a.status !== 200).every((a) => a.json.code === 'EMAIL_ALREADY_EXISTS'), JSON.stringify(edits.map((a) => [a.status, a.json.code])));
      assert.equal(await PharmacyModel.countDocuments({ email: email2 }), 1);
      const ix = (await PharmacyModel.collection.indexes()).find((i: any) => i.name === 'email_unique_1') as any;
      assert.deepEqual([ix?.unique, ix?.partialFilterExpression], [true, { email: { $type: 'string' } }]);
    });

    await check('5 review: migrate:pharmacy-email-duplicates (dry run) lists case-variant duplicates masked, with the pharmacy ids, and writes nothing', async () => {
      const mod = await import('@/scripts/pharmacyEmailDuplicates').catch(() => null) as any;
      assert.ok(mod?.findPharmacyEmailDuplicates, 'the dry-run script exists');
      const pkg = JSON.parse(require('node:fs').readFileSync(require('node:path').resolve(process.cwd(), 'package.json'), 'utf8'));
      assert.equal(pkg.scripts['migrate:pharmacy-email-duplicates'], 'tsx src1/scripts/pharmacyEmailDuplicates.ts');
      const a = new Types.ObjectId();
      const b = new Types.ObjectId();
      // Legacy rows written around the schema: the same address in two letter cases (the index alone accepts both).
      await PharmacyModel.collection.insertMany([{ _id: a, name: 'Old A', phone: nextPhone(), email: 'Ravi.Shop@Example.com' }, { _id: b, name: 'Old B', phone: nextPhone(), email: ' ravi.shop@example.com' }] as any);
      const before = JSON.stringify(await PharmacyModel.find({ _id: { $in: [a, b] } }).lean());
      const report = await mod.findPharmacyEmailDuplicates();
      const dup = report.duplicates.find((d: any) => d.pharmacyIds.includes(String(a)));
      assert.deepEqual(dup, { email: 'r***@e***.com', pharmacyIds: [String(a), String(b)] });
      assert.equal(JSON.stringify(report).includes('ravi.shop'), false, 'emails are masked');
      assert.equal(JSON.stringify(await PharmacyModel.find({ _id: { $in: [a, b] } }).lean()), before, 'nothing written');
      await PharmacyModel.deleteMany({ _id: { $in: [a, b] } });
    });

    await check('6 review: the same email in other letter case keeps the sessions; clearing latitude or longitude clears both, and clearing one while setting the other is refused', async () => {
      const id = new Types.ObjectId();
      await PharmacyModel.collection.insertOne({ _id: id, name: 'Legacy Case', phone: nextPhone(), email: 'Legacy.Case@Example.com', latitude: 18.5, longitude: 73.8,
        isActive: true, isVerified: true, createdAt: new Date(), updatedAt: new Date() } as any);
      const s1 = [await openSession(String(id), 'workspace')];
      const r = await call('PUT', `/api/v1/pharmacies/${id}`, adminToken, { email: 'legacy.case@example.com' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(await live(s1), 1, 'a letter-case change is not a new sign-in email');
      const half = await call('PUT', `/api/v1/pharmacies/${id}`, adminToken, { latitude: null, longitude: 72.9 });
      assert.deepEqual([half.status, half.json.code], [400, 'VALIDATION_ERROR']);
      assert.equal((await call('PUT', `/api/v1/pharmacies/${id}`, adminToken, { latitude: null })).status, 200);
      const after = await PharmacyModel.findById(id).lean() as any;
      assert.deepEqual([after.latitude, after.longitude], [undefined, undefined]);
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} checks passed${failed.length ? `, ${failed.length} FAILED: ${failed.join(' | ')}` : ''}`);
  if (failed.length) throw new Error(`${failed.length} checks failed`);
}

main().then(() => mongoose.disconnect()).catch(async (e) => { console.error(e?.message ?? e); await mongoose.disconnect(); process.exit(1); });
