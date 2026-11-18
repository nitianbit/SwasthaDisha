/**
 * Q13: gaps found by the WQ4 (doctor tools), WQ5 (finance) and WQ6 (clinic desk) web packets — the doctor's own presence
 * (one meaning of "online"), offers carrying the paid quote, idempotent accept, keyed extensions with a booking read, a
 * version-checked weekly schedule, payout-destination and finance versions, payout/adjustment key lookup and give-up,
 * cursor-paged finance lists (with account names on the admin queue), desk key lookup/give-up, doctor names on clinic
 * invitations, started slots refused at the desk, and version-checked desk steps. Real MongoDB replica set; the real
 * specialist, partner-workspace and settlement routers for the HTTP checks.
 *
 * Run (throwaway DB only; the script drops its collections):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q13_doctor_finance_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx test/partners/q13-doctor-finance.integration.ts
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
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { CouponModel } from '@/modules/coupon/model';
import { CouponService } from '@/modules/coupon/services';
import { CouponRepository } from '@/modules/coupon/repository';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { DoctorReservationModel, DoctorScheduleGuardModel } from '@/modules/doctors/model/reservation';
import { DoctorPresenceModel, InstantRequestModel } from '@/modules/doctors/model/instant';
import { DoctorScheduleTemplateModel } from '@/modules/doctors/model/schedule';
import { reserveInterval } from '@/modules/doctors/services/reservations';
import { InstantConsultService } from '@/modules/doctors/services/instant';
import { saveTemplate, getTemplate, setLeave } from '@/modules/doctors/services/schedule';
import { extendSchema, scheduleTemplateSchema } from '@/modules/doctors/validation';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import { ClinicDoctorInviteModel } from '@/modules/partners/model/clinicDoctor';
import {
  SettlementAccountModel, LedgerEntryModel, LedgerHistoryRefModel, SettlementPayoutModel, SettlementEventModel,
} from '@/modules/partners/model/settlement';
import { ScheduleGuardModel } from '@/modules/partners/model/slot';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { PartnerService, PartnerActor, adminActor } from '@/modules/partners/services';
import { postLedgerEntry, ledgerBalance } from '@/modules/partners/services/settlement';
import * as fin from '@/modules/partners/services/finance';
import * as clinic from '@/modules/partners/services/clinic';
import { istDate, addDays } from '@/modules/partners/services/slots';
import { payoutDetailsSchema, recordPayoutSchema, accountKeyParamSchema } from '@/modules/partners/validation/finance';
import { deskStepSchema, deskKeyParamSchema } from '@/modules/partners/validation/clinic';
import DependentModel from '@/modules/dependents/model';
import { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q13_doctor_finance_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const partnerSvc = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
Container.set(PartnerService, partnerSvc);
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(),
  getRazorpayClient: () => { throw new Error('no gateway in this suite'); }, getRazorpayCredentials: () => ({ keyId: 'rzp_test_key', keySecret: 'secret' }),
}) as unknown as PaymentService;
const svc = new InstantConsultService(payments, new CouponService(new CouponRepository()), new WalletRepository());
svc.notify = async () => undefined;
Container.set(InstantConsultService, svc);

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) { await fn(); passed++; console.log('ok -', name); }
const code = (c: string) => (e: any) => e?.code === c;
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let ph = 7130000000;
const nextPhone = () => String(ph++);
let keySeq = 0;
const rk = (p = 'q13-key') => `${p}-${String(++keySeq).padStart(4, '0')}`;
const today = istDate(new Date());
const ADMIN = new Types.ObjectId().toHexString();
const OTHER_ADMIN = new Types.ObjectId().toHexString();
const bank = { method: 'bank' as const, accountName: 'Metro Labs Pvt Ltd', accountNumber: '123456789012', ifsc: 'HDFC0001234', bankName: 'HDFC Bank' };
const addr = { line1: '1 Road', city: 'Pune', state: 'Maharashtra', stateCode: '27', pincode: '411001' };

async function doctor(name: string, feeRupees: number, specialization = 'General Physician', online = true) {
  const id = new Types.ObjectId();
  await SpecialistModel.collection.insertOne({ _id: id, name, phone: nextPhone(), email: `${name.replace(/\W/g, '')}@x.test`, specialization,
    consultationFee: feeRupees, isActive: true, isVerified: true, rating: 4.5 } as never);
  if (online) await svc.setPresence(String(id), { available: true, modes: ['video', 'call'] });
  return String(id);
}
async function customer(walletRupees: number) {
  const u = await UserModel.create({ phone: nextPhone(), name: 'Asha', userType: 'user', otpVerified: true } as any);
  await WalletModel.create({ userId: String(u._id), balance: walletRupees, isActive: true });
  return String(u._id);
}
const ask = (over: Record<string, unknown> = {}) => ({ target: { kind: 'any' }, specialization: 'General Physician', mode: 'video',
  patient: { kind: 'self' }, requestKey: rk('instant'), useWalletBalance: true, ...over }) as any;
let earnSeq = 0;
const earn = (accountId: string, minor: number) => postLedgerEntry({ settlementAccountId: accountId, kind: 'earning', amountMinor: minor,
  source: 'test_earning', sourceId: `q13-e${++earnSeq}`, by: 'system', byKind: 'system' });
const utr = () => `UTR${new Types.ObjectId().toHexString().slice(-12).toUpperCase()}`;
const payoutInput = async (accountId: string, amountMinor: number, over: Partial<fin.RecordPayoutInput> = {}): Promise<fin.RecordPayoutInput> => {
  const a = await SettlementAccountModel.findById(accountId).lean();
  return { amountMinor, method: 'bank_transfer', reference: utr(), paidOn: today, detailsVersion: a!.payoutDetailsVersion, requestKey: rk('payout'), ...over };
};
/** A slot of the doctor at a clinic branch starting at `start` (India time), 30 minutes long. */
async function slotAt(doctorId: string, branchId: string, start: Date) {
  const ist = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString();
  const s = ist(start);
  const e = ist(new Date(start.getTime() + 30 * 60_000));
  const row = await SlotModel.create({ specialistId: doctorId, date: s.slice(0, 10).replace(/-/g, ''), startTime: s.slice(11, 16), endTime: e.slice(11, 16),
    duration: 30, slotType: 'consultation', maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true, serviceModes: ['in-person'], branchId } as any);
  return { slotId: String(row._id), isoDate: `${s.slice(0, 10)}` };
}

async function main() {
  await mongoose.connect(FIXTURE_URL, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [UserModel, SpecialistModel, SlotModel, BookingModel, PaymentRecordModel, WalletModel, WalletTransactionModel, CouponModel, RequestKeyModel,
    DoctorReservationModel, DoctorScheduleGuardModel, DoctorPresenceModel, InstantRequestModel, DoctorScheduleTemplateModel, PartnerModel, MemberModel,
    BranchModel, PartnerAuditEventModel, ClinicDoctorInviteModel, SettlementAccountModel, LedgerEntryModel, LedgerHistoryRefModel, SettlementPayoutModel,
    SettlementEventModel, ScheduleGuardModel, DependentModel] as mongoose.Model<any>[]) {
    await M.createCollection(); await M.createIndexes();
  }

  // ───────────────────────────── 1. Doctor presence and instant ─────────────────────────────
  const drA = await doctor('Dr Asha', 300);
  const drB = await doctor('Dr Bose', 500);

  await check('presence: one meaning of online (available + modes + fresh heartbeat + not busy + active), agreeing with discovery', async () => {
    const agree = async (id: string, spec = 'Dermatology') => {
      const p = await svc.presence(id);
      const listed = (await svc.onlineDoctors({ specialization: spec, mode: 'video' })).some((d) => d.doctorId === id);
      assert.equal(p.online, listed, 'presence and discovery agree');
      return p;
    };
    const drP = await doctor('Dr Pal', 400, 'Dermatology');
    let p = await agree(drP);
    assert.deepEqual([p.online, p.eligible, p.available, p.heartbeatExpired, p.busy, p.instantFeeMinor, p.instantFee, p.feeConfigured, p.heartbeatTtlSeconds],
      [true, true, true, false, false, 40000, 400, true, 120]);
    assert.deepEqual([...p.modes].sort(), ['call', 'video']);
    assert.ok(p.heartbeatExpiresAt && p.lastSeenAt && p.heartbeatExpiresAt.getTime() - p.lastSeenAt.getTime() === 120_000);
    // A stale heartbeat: expired, not online; the next heartbeat brings the doctor back.
    await DoctorPresenceModel.updateOne({ doctorId: drP }, { $set: { lastSeenAt: new Date(Date.now() - 3 * 60_000) } });
    p = await agree(drP);
    assert.deepEqual([p.online, p.heartbeatExpired, p.available], [false, true, true]);
    const hb = await svc.heartbeat(drP);
    assert.equal(hb.online, true);
    assert.equal((await agree(drP)).online, true);
    // Busy (an interval held now): not online, and the heartbeat says so too.
    await runLedgerTransaction((s) => reserveInterval({ doctorId: drP, kind: 'scheduled', refId: 'q13-appt-now', start: new Date(Date.now() - 60_000),
      end: new Date(Date.now() + 600_000) }, s));
    p = await agree(drP);
    assert.deepEqual([p.online, p.busy, p.busyWith], [false, true, { kind: 'scheduled', bookingId: 'q13-appt-now' }]);
    assert.ok(p.busyUntil && new Date(p.busyUntil).getTime() > Date.now());
    assert.equal((await svc.heartbeat(drP)).online, false);
    // Switched off, and a deactivated doctor.
    const drQ = await doctor('Dr Qadir', 400, 'Dermatology');
    await svc.setPresence(drQ, { available: false });
    assert.deepEqual([(await agree(drQ)).online, (await svc.presence(drQ)).available], [false, false]);
    const drR = await doctor('Dr Roy', 400, 'Dermatology');
    await SpecialistModel.updateOne({ _id: drR }, { $set: { isActive: false } });
    p = await agree(drR);
    assert.deepEqual([p.online, p.eligible], [false, false]);
    // Never switched on: the default fee is the consultation fee, nothing configured.
    const drN = await doctor('Dr New', 250, 'Dermatology', false);
    p = await agree(drN);
    assert.deepEqual([p.online, p.available, p.feeConfigured, p.instantFeeMinor, p.lastSeenAt, p.heartbeatExpired], [false, false, false, 25000, null, true]);
  });

  let reqA = '';
  let bookingA = '';
  await check('one eligibility rule: a legacy doctor missing a stored active/verified flag is neither online nor admitted', async () => {
    const id = new Types.ObjectId();
    await SpecialistModel.collection.insertOne({ _id: id, name: 'Dr Legacy', phone: nextPhone(), specialization: 'Dermatology', consultationFee: 300, isActive: true } as never);
    await DoctorPresenceModel.create({ doctorId: String(id), available: true, modes: ['video'], instantFeeMinor: 30000, specialization: 'Dermatology', lastSeenAt: new Date() });
    const p = await svc.presence(String(id));
    assert.deepEqual([p.eligible, p.online], [false, false]);
    assert.equal((await svc.onlineDoctors({ specialization: 'Dermatology', mode: 'video' })).some((d) => d.doctorId === String(id)), false, 'agrees with discovery');
    await assert.rejects(() => svc.setPresence(String(id), { available: true, modes: ['video'] }), code('SPECIALIST_NOT_ACTIVE'));
    await assert.rejects(() => svc.heartbeat(String(id)), code('SPECIALIST_NOT_ACTIVE'));
  });

  await check('presence writes are ordered: a late older change can never overwrite newer acknowledged terms', async () => {
    const drV = await doctor('Dr Vohra', 500, 'Dermatology');
    const v0 = (await svc.presence(drV)).presenceVersion;
    assert.ok(v0 >= 1, 'set once by the fixture');
    // A: ₹100 decided on v0 (its answer is lost). B: the doctor re-reads (A not run yet), sends ₹300 on v0: acknowledged.
    const b = await svc.setPresence(drV, { available: true, modes: ['video'], instantFeeMinor: 30000, expectedPresenceVersion: v0 });
    assert.equal(b.presenceVersion, v0 + 1);
    // A runs late: refused, B's terms stay.
    await assert.rejects(() => svc.setPresence(drV, { available: true, modes: ['video'], instantFeeMinor: 10000, expectedPresenceVersion: v0 }), code('PRESENCE_CHANGED'));
    const now = await svc.presence(drV);
    assert.deepEqual([now.instantFeeMinor, now.presenceVersion], [30000, v0 + 1]);
    // Racing writes on one version: exactly one wins.
    const race = await Promise.allSettled([20000, 25000].map((fee) => svc.setPresence(drV, { available: true, modes: ['video'], instantFeeMinor: fee, expectedPresenceVersion: v0 + 1 })));
    assert.equal(race.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal((await svc.presence(drV)).presenceVersion, v0 + 2);
    // A first-ever write names version 0; a second write naming 0 is refused (also when the row already exists).
    const drW = await doctor('Dr Wani', 500, 'Dermatology');
    await DoctorPresenceModel.deleteOne({ doctorId: drW });
    assert.equal((await svc.presence(drW)).presenceVersion, 0);
    assert.equal((await svc.setPresence(drW, { available: false, expectedPresenceVersion: 0 })).presenceVersion, 1);
    await assert.rejects(() => svc.setPresence(drW, { available: true, modes: ['call'], expectedPresenceVersion: 0 }), code('PRESENCE_CHANGED'));
    // Heartbeats do not move the version; a forced offline (deactivated doctor) does.
    await svc.setPresence(drW, { available: true, modes: ['call'], expectedPresenceVersion: 1 });
    await svc.heartbeat(drW);
    assert.equal((await svc.presence(drW)).presenceVersion, 2);
    await SpecialistModel.updateOne({ _id: drW }, { $set: { isActive: false } });
    await assert.rejects(() => svc.heartbeat(drW), code('SPECIALIST_NOT_ACTIVE'));
    assert.equal((await svc.presence(drW)).presenceVersion, 3);
  });

  await check('offers carry the quote the patient paid and whether the doctor\'s fee fits; only the doctors offered see them', async () => {
    const u = await customer(2000);
    const r = await svc.create(u, ask());
    reqA = String((r.request as any)._id);
    const mine = (await svc.myOffers(drA)).find((o) => o.requestId === reqA)!;
    assert.deepEqual([mine.quotedAmountMinor, mine.quotedAmount, mine.yourFeeMinor, mine.feeWithinQuote], [50000, 500, 30000, true]);
    await svc.setPresence(drB, { available: true, modes: ['video', 'call'], instantFeeMinor: 60000 });
    const theirs = (await svc.myOffers(drB)).find((o) => o.requestId === reqA)!;
    assert.deepEqual([theirs.quotedAmountMinor, theirs.yourFeeMinor, theirs.feeWithinQuote], [50000, 60000, false]);
    await svc.setPresence(drB, { available: true, modes: ['video', 'call'], instantFeeMinor: 50000 });
    const outsider = await doctor('Dr Outsider', 300, 'Dermatology');
    assert.equal((await svc.myOffers(outsider)).length, 0, 'a doctor not offered sees nothing');
  });

  await check('accept is idempotent for the same doctor (existing booking, replayed); another doctor is still refused', async () => {
    const first = await svc.accept(drA, reqA);
    assert.equal(first.replayed, false);
    bookingA = String(first.booking._id);
    const again = await svc.accept(drA, reqA);
    assert.equal(again.replayed, true);
    assert.equal(String(again.booking._id), bookingA);
    assert.equal(await BookingModel.countDocuments({ instantRequestId: reqA }), 1);
    assert.equal(await WalletTransactionModel.countDocuments({ operationKey: `instant_request_return:${reqA}` }), 1, 'the quote difference is returned once');
    await assert.rejects(() => svc.accept(drB, reqA), code('OFFER_NO_LONGER_AVAILABLE'));
    // Racing accepts by one doctor: one booking, every answer is that booking, exactly one made it.
    const u = await customer(2000);
    const r = await svc.create(u, ask());
    const id = String((r.request as any)._id);
    const res = await Promise.allSettled([1, 2, 3, 4].map(() => svc.accept(drB, id)));
    assert.ok(res.every((x) => x.status === 'fulfilled'), JSON.stringify(res.filter((x) => x.status === 'rejected').map((x: any) => x.reason?.code)));
    const outs = res.map((x) => (x as PromiseFulfilledResult<Awaited<ReturnType<typeof svc.accept>>>).value);
    assert.equal(new Set(outs.map((o) => String(o.booking._id))).size, 1);
    assert.equal(outs.filter((o) => !o.replayed).length, 1);
    assert.equal(await BookingModel.countDocuments({ instantRequestId: id }), 1);
  });

  await check('extend: a keyed extension happens once (racing repeats too); the booking read shows the held interval and the extensions', async () => {
    const before = (await DoctorReservationModel.findOne({ refId: bookingA, kind: 'instant' }).lean())!;
    const e1 = await svc.extend(drA, bookingA, 10, new Date(), 'ext-key-0001');
    assert.equal(e1.replayed, false);
    const end1 = new Date(before.endTime).getTime() + 10 * 60_000;
    assert.equal(new Date((e1 as any).endTime).getTime(), end1);
    const r1 = await svc.extend(drA, bookingA, 10, new Date(), 'ext-key-0001');
    assert.equal(r1.replayed, true);
    assert.equal(new Date((r1 as any).endTime).getTime(), end1, 'a replay adds nothing');
    await assert.rejects(() => svc.extend(drA, bookingA, 15, new Date(), 'ext-key-0001'), code('REQUEST_KEY_REUSED'));
    const race = await Promise.allSettled([1, 2, 3].map(() => svc.extend(drA, bookingA, 5, new Date(), 'ext-key-0002')));
    assert.ok(race.every((x) => x.status === 'fulfilled'));
    assert.equal(race.filter((x) => !(x as PromiseFulfilledResult<any>).value.replayed).length, 1);
    const held = (await DoctorReservationModel.findOne({ refId: bookingA, kind: 'instant' }).lean())!;
    assert.equal(new Date(held.endTime).getTime(), end1 + 5 * 60_000, 'extended by 5 minutes exactly once');
    const view = await svc.doctorInstantBooking(drA, bookingA);
    assert.equal(new Date(view.held!.endTime).getTime(), end1 + 5 * 60_000);
    assert.equal(view.held!.current, true);
    assert.deepEqual(view.extensions.map((x) => [x.requestKey, x.minutes]), [['ext-key-0001', 10], ['ext-key-0002', 5]]);
    assert.deepEqual([view.status, view.feeMinor, view.patient?.name], ['confirmed', 30000, 'Asha']);
    // Another doctor can neither read nor extend it.
    await assert.rejects(() => svc.doctorInstantBooking(drB, bookingA), code('BOOKING_NOT_FOUND'));
    await assert.rejects(() => svc.extend(drB, bookingA, 5, new Date(), 'ext-key-0003'), code('BOOKING_NOT_FOUND'));
    // Unkeyed extensions keep working; after completion a known key still answers, a new one is refused.
    await svc.extend(drA, bookingA, 1);
    await BookingModel.updateOne({ _id: bookingA }, { $set: { status: 'completed' } });
    assert.equal((await svc.extend(drA, bookingA, 10, new Date(), 'ext-key-0001')).replayed, true);
    await assert.rejects(() => svc.extend(drA, bookingA, 10, new Date(), 'ext-key-0004'), code('BOOKING_NOT_FOUND'));
    assert.ok(extendSchema.validate({ minutes: 5, requestKey: 'short' }).error);
    assert.equal(extendSchema.validate({ minutes: 5, requestKey: 'ext-key-0005' }).error, undefined);
  });

  // ───────────────────────────── 2. Schedule version ─────────────────────────────
  await check('schedule: the save names the version it started from (null = none); a stale or racing save is refused with SCHEDULE_CHANGED', async () => {
    const drS = await doctor('Dr Sched', 500, 'General Physician', false);
    const days = (start: string) => ({ mon: [{ start, end: '12:00', modes: ['video'] }] }) as any;
    await assert.rejects(() => saveTemplate(drS, { slotMinutes: 30, days: days('09:00'), expectedUpdatedAt: new Date() }), code('SCHEDULE_CHANGED'));
    const t1 = await saveTemplate(drS, { slotMinutes: 30, days: days('09:00'), expectedUpdatedAt: null });
    await assert.rejects(() => saveTemplate(drS, { slotMinutes: 30, days: days('09:30'), expectedUpdatedAt: null }), code('SCHEDULE_CHANGED'));
    await assert.rejects(() => saveTemplate(drS, { slotMinutes: 30, days: days('09:30'), expectedUpdatedAt: new Date(new Date(t1.template!.updatedAt!).getTime() - 1) }),
      code('SCHEDULE_CHANGED'));
    const t2 = await saveTemplate(drS, { slotMinutes: 30, days: days('09:30'), expectedUpdatedAt: t1.template!.updatedAt });
    assert.equal(t2.template!.days.mon![0]!.start, '09:30');
    // A leave change is a change of the template too.
    await setLeave(drS, addDays(today, 3).replace(/-/g, ''), true);
    await assert.rejects(() => saveTemplate(drS, { slotMinutes: 30, days: days('10:00'), expectedUpdatedAt: t2.template!.updatedAt }), code('SCHEDULE_CHANGED'));
    // Two editors from the same version: exactly one wins.
    const cur = (await getTemplate(drS))!;
    const race = await Promise.allSettled([saveTemplate(drS, { slotMinutes: 30, days: days('08:00'), expectedUpdatedAt: cur.updatedAt }),
      saveTemplate(drS, { slotMinutes: 20, days: days('08:30'), expectedUpdatedAt: cur.updatedAt })]);
    assert.equal(race.filter((x) => x.status === 'fulfilled').length, 1);
    assert.ok(race.some((x) => x.status === 'rejected' && (x.reason as any)?.code === 'SCHEDULE_CHANGED'));
    // Without a version the save works as before.
    await saveTemplate(drS, { slotMinutes: 30, days: days('11:00') });
    assert.equal((await getTemplate(drS))!.days.mon![0]!.start, '11:00');
    assert.equal(scheduleTemplateSchema.validate({ slotMinutes: 30, days: {}, expectedUpdatedAt: null }).error, undefined);
  });

  // ───────────────────────────── 3. Finance ─────────────────────────────
  const lab = async (name: string) => {
    const { partner, owner } = await partnerSvc.createPartner({ kind: 'lab', name, legalName: `${name} Pvt Ltd`, contactPhone: nextPhone(), invoiceSeriesPrefix: 'LB',
      firstOwner: { phone: nextPhone(), name: 'Owner' } } as any);
    await partnerSvc.verifyPartner(String(partner._id), 'admin');
    return { partnerId: String(partner._id), own: actorFor(owner), owner };
  };
  const P1 = await lab('Metro Labs');
  const P2 = await lab('Other Labs');
  const L1 = String((await fin.findOwnerAccount('partner', P1.partnerId))!._id);
  const L2 = String((await fin.findOwnerAccount('partner', P2.partnerId))!._id);
  let DA = '';

  await check('payout destination: an expected detailsVersion refuses a change made meanwhile (partner owner, doctor, admin)', async () => {
    const asOwner = { kind: 'member' as const, partner: P1.own };
    await assert.rejects(() => fin.setPayoutDetails({ ownerKind: 'partner', ownerId: P1.partnerId }, { ...bank, expectedDetailsVersion: 1 }, asOwner), code('PAYOUT_DETAILS_CHANGED'));
    assert.equal((await fin.setPayoutDetails({ ownerKind: 'partner', ownerId: P1.partnerId }, { ...bank, expectedDetailsVersion: 0 }, asOwner)).payoutDetailsVersion, 1);
    await assert.rejects(() => fin.setPayoutDetails({ ownerKind: 'partner', ownerId: P1.partnerId }, { ...bank, accountNumber: '999988887777', expectedDetailsVersion: 0 }, asOwner),
      code('PAYOUT_DETAILS_CHANGED'));
    assert.equal((await SettlementAccountModel.findById(L1).lean())!.payoutDetails!.accountNumber, '123456789012', 'the refused change wrote nothing');
    await assert.rejects(() => fin.setPayoutDetails({ accountId: L1 }, { ...bank, expectedDetailsVersion: 0 }, { kind: 'admin', id: ADMIN }), code('PAYOUT_DETAILS_CHANGED'));
    assert.equal((await fin.setPayoutDetails({ ownerKind: 'partner', ownerId: P1.partnerId }, { ...bank, expectedDetailsVersion: 1 }, asOwner)).payoutDetailsVersion, 2);
    // A doctor's own account (created on first write).
    const asDoctor = { kind: 'doctor' as const, id: drA };
    assert.equal((await fin.setPayoutDetails({ ownerKind: 'doctor', ownerId: drA }, { method: 'upi', upiId: 'asha@okhdfc', expectedDetailsVersion: 0 }, asDoctor)).payoutDetailsVersion, 1);
    await assert.rejects(() => fin.setPayoutDetails({ ownerKind: 'doctor', ownerId: drA }, { method: 'upi', upiId: 'asha2@okhdfc', expectedDetailsVersion: 0 }, asDoctor),
      code('PAYOUT_DETAILS_CHANGED'));
    DA = String((await fin.findOwnerAccount('doctor', drA))!._id);
    // Without a version the change works as before.
    await fin.setPayoutDetails({ ownerKind: 'partner', ownerId: P2.partnerId }, bank, { kind: 'member', partner: P2.own });
    assert.equal(payoutDetailsSchema.validate({ method: 'upi', upiId: 'a@b', expectedDetailsVersion: 3 }).error, undefined);
    assert.ok(payoutDetailsSchema.validate({ method: 'upi', upiId: 'a@b', expectedDetailsVersion: -1 }).error);
  });

  await fin.verifyPayoutDetails(L1, 2, ADMIN);
  await fin.verifyPayoutDetails(L2, 1, ADMIN);
  await fin.verifyPayoutDetails(DA, 1, ADMIN);
  await earn(L1, 500000);
  await earn(L2, 300000);
  await earn(DA, 200000);
  const versionOf = async (id: string) => (await fin.financeSummary(await fin.accountById(id), true)).account!.financeVersion;

  await check('financeVersion: shown on account reads, unchanged by earnings; a payout or adjustment decided on an older version is refused', async () => {
    const v0 = await versionOf(L1);
    assert.ok(v0 > 0);
    await earn(L1, 1000);
    assert.equal(await versionOf(L1), v0, 'earnings do not move it');
    const listed = (await fin.adminListAccounts({ ownerKind: 'partner' })).rows.find((r: any) => r._id === L1) as any;
    assert.equal(listed.financeVersion, v0);
    const balance = await ledgerBalance(L1);
    const input = await payoutInput(L1, 10000, { expectedFinanceVersion: v0 - 1 });
    await assert.rejects(() => fin.recordPayout(ADMIN, L1, input), code('FINANCE_CHANGED'));
    assert.equal(await ledgerBalance(L1), balance);
    assert.equal(await RequestKeyModel.exists({ key: input.requestKey }), null, 'a refused payout claims nothing');
    const ok = await fin.recordPayout(ADMIN, L1, { ...input, expectedFinanceVersion: v0 });
    assert.equal(ok.replayed, false);
    assert.equal(await versionOf(L1), v0 + 1);
    // The replay of that payout is answered whatever version it names (the fence is not part of its identity).
    assert.equal((await fin.recordPayout(ADMIN, L1, { ...input, expectedFinanceVersion: v0 })).replayed, true);
    await assert.rejects(() => fin.postAdjustment(ADMIN, L1, { amountMinor: 500, reason: 'Late fee', requestKey: rk('adj'), expectedFinanceVersion: v0 }),
      code('FINANCE_CHANGED'));
    const adj = await fin.postAdjustment(ADMIN, L1, { amountMinor: 500, reason: 'Late fee', requestKey: rk('adj'), expectedFinanceVersion: v0 + 1 });
    assert.equal(adj.replayed, false);
    // Two decisions on the same version: exactly one is recorded.
    const v = await versionOf(L1);
    const race = await Promise.allSettled([fin.recordPayout(ADMIN, L1, await payoutInput(L1, 1000, { expectedFinanceVersion: v })),
      fin.postAdjustment(ADMIN, L1, { amountMinor: -300, reason: 'Recovery', requestKey: rk('adj'), expectedFinanceVersion: v })]);
    assert.equal(race.filter((x) => x.status === 'fulfilled').length, 1);
    assert.ok(race.some((x) => x.status === 'rejected' && (x.reason as any)?.code === 'FINANCE_CHANGED'));
    assert.equal(await versionOf(L1), v + 1);
    // Without a version payouts work as before.
    await fin.recordPayout(ADMIN, L1, await payoutInput(L1, 1000));
    assert.equal(recordPayoutSchema.validate({ amountMinor: 1, method: 'upi', reference: 'UTR1', paidOn: today, detailsVersion: 1, requestKey: 'abcdefgh',
      expectedFinanceVersion: 0 }).error, undefined);
  });

  await check('payout / adjustment keys: found by key only for this admin and account; given up once (then never recorded); legacy rows are used', async () => {
    const input = await payoutInput(L1, 2000);
    const made = await fin.recordPayout(ADMIN, L1, input);
    assert.ok(await RequestKeyModel.exists({ scope: fin.payoutKeyScope(L1, ADMIN), key: input.requestKey, state: 'used' }), 'claimed with the payout');
    assert.equal(String((await fin.payoutByKey(ADMIN, L1, input.requestKey))!._id), String(made.payout._id));
    assert.equal((await fin.payoutByKey(ADMIN, L1.toUpperCase(), input.requestKey) as any).requestKey, undefined, 'no key/hash in the answer');
    assert.equal(await fin.payoutByKey(OTHER_ADMIN, L1, input.requestKey), null, 'another admin\'s keys are their own');
    assert.equal(await fin.payoutByKey(ADMIN, L2, input.requestKey), null, 'another account never shows it');
    await assert.rejects(() => fin.payoutByKey(ADMIN, new Types.ObjectId().toHexString(), input.requestKey), code('SETTLEMENT_ACCOUNT_NOT_FOUND'));
    const used = await fin.abandonPayoutKey(ADMIN, L1, input.requestKey);
    assert.equal(used.state, 'used');
    assert.equal(String((used as any).payout._id), String(made.payout._id));
    const lost = rk('payout');
    assert.deepEqual(await fin.abandonPayoutKey(ADMIN, L1, lost), { state: 'abandoned' });
    await assert.rejects(async () => fin.recordPayout(ADMIN, L1, await payoutInput(L1, 2000, { requestKey: lost })), code('REQUEST_ABANDONED'));
    assert.equal(await SettlementPayoutModel.countDocuments({ requestKey: lost }), 0);
    // A payout recorded before claims existed: used, never abandoned.
    await RequestKeyModel.deleteOne({ scope: fin.payoutKeyScope(L1, ADMIN), key: input.requestKey });
    assert.equal((await fin.abandonPayoutKey(ADMIN, L1, input.requestKey)).state, 'used');
    assert.equal(await RequestKeyModel.exists({ key: input.requestKey, state: 'abandoned' }), null);
    // A give-up racing the payout: exactly one wins.
    for (let i = 0; i < 4; i++) {
      const k = rk('payrace');
      const [rec, gave] = await Promise.allSettled([payoutInput(L1, 100, { requestKey: k }).then((x) => fin.recordPayout(ADMIN, L1, x)), fin.abandonPayoutKey(ADMIN, L1, k)]);
      const n = await SettlementPayoutModel.countDocuments({ requestKey: k });
      const state = gave.status === 'fulfilled' ? gave.value.state : 'error';
      if (state === 'abandoned') { assert.equal(n, 0); assert.equal(rec.status, 'rejected'); }
      else { assert.equal(state, 'used'); assert.equal(n, 1); }
    }
    // Adjustments.
    const ak = rk('adj');
    const adj = await fin.postAdjustment(ADMIN, L1, { amountMinor: 700, reason: 'Collection kit refund', requestKey: ak });
    assert.ok(await RequestKeyModel.exists({ scope: fin.adjustmentKeyScope(L1, ADMIN), key: ak, state: 'used' }));
    assert.equal(String((await fin.adjustmentByKey(ADMIN, L1, ak))!._id), String(adj.entry._id));
    assert.equal(await fin.adjustmentByKey(OTHER_ADMIN, L1, ak), null);
    assert.equal(await fin.adjustmentByKey(ADMIN, L2, ak), null);
    assert.equal((await fin.abandonAdjustmentKey(ADMIN, L1, ak)).state, 'used');
    const lostAdj = rk('adj');
    assert.deepEqual(await fin.abandonAdjustmentKey(ADMIN, L1, lostAdj), { state: 'abandoned' });
    // The losing side of a concurrent identical submission, made deterministic: its reads ran before the winner committed
    // (receipt and claim not seen), so its claim insert collides with the winner's. It is answered with the winner's entry.
    {
      const k = rk('adj');
      const winner = await fin.postAdjustment(ADMIN, L1, { amountMinor: 333, reason: 'Late commit', requestKey: k });
      const missOnce = (M: any) => {
        const real = M.findOne;
        let missed = false;
        M.findOne = function (...args: unknown[]) {
          if (missed) return real.apply(this, args);
          missed = true;
          const empty: any = { session: () => empty, select: () => empty, lean: async () => null, then: (r: any) => Promise.resolve(null).then(r) };
          return empty;
        };
        return () => { M.findOne = real; };
      };
      const restoreLedger = missOnce(LedgerEntryModel);
      const restoreKeys = missOnce(RequestKeyModel);
      try {
        const loser = await fin.postAdjustment(ADMIN, L1, { amountMinor: 333, reason: 'Late commit', requestKey: k });
        assert.deepEqual([String(loser.entry._id), loser.replayed], [String(winner.entry._id), true]);
      } finally { restoreLedger(); restoreKeys(); }
    }
    // Concurrent identical submissions: one entry, every answer is it (no DUPLICATE_RESOURCE).
    for (let i = 0; i < 4; i++) {
      const k = rk('adj');
      const both = await Promise.allSettled([1, 2].map(() => fin.postAdjustment(ADMIN, L1, { amountMinor: 111, reason: 'Twin submit', requestKey: k })));
      const ok = both.filter((x) => x.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      assert.equal(ok.length, 2, `both answered: ${both.map((x) => x.status === 'rejected' ? (x.reason as any)?.code : 'ok').join(',')}`);
      assert.equal(new Set(ok.map((x) => String(x.value.entry._id))).size, 1);
      // A give-up racing a post: the post either wins (give-up says used) or is refused as abandoned.
      const k2 = rk('adj');
      const [posted, gave] = await Promise.allSettled([fin.postAdjustment(ADMIN, L1, { amountMinor: 222, reason: 'Race', requestKey: k2 }), fin.abandonAdjustmentKey(ADMIN, L1, k2)]);
      if (gave.status === 'fulfilled' && gave.value.state === 'abandoned') {
        assert.equal(posted.status === 'rejected' && (posted.reason as any).code, 'REQUEST_ABANDONED');
      } else assert.equal(posted.status, 'fulfilled');
    }
    await assert.rejects(() => fin.postAdjustment(ADMIN, L1, { amountMinor: 700, reason: 'Collection kit refund', requestKey: lostAdj }), code('REQUEST_ABANDONED'));
    assert.equal(await LedgerEntryModel.countDocuments({ sourceId: `${ADMIN}:${lostAdj}` }), 0);
    assert.equal(accountKeyParamSchema.validate({ accountId: L1, key: 'short' }).error !== undefined, true);
  });

  await check('admin payout queue: exact cursor pages (ties included) with totals, each row naming its account', async () => {
    await fin.recordPayout(ADMIN, L2, await payoutInput(L2, 5000));
    await fin.recordPayout(ADMIN, DA, await payoutInput(DA, 4000));
    // Two payouts with the same creation instant: the id breaks the tie.
    const two = await SettlementPayoutModel.find({}).sort({ createdAt: -1 }).limit(2).lean();
    await SettlementPayoutModel.collection.updateMany({ _id: { $in: two.map((p) => p._id) } }, { $set: { createdAt: new Date(two[1]!.createdAt!) } });
    const all = await SettlementPayoutModel.find({}).sort({ createdAt: -1, _id: -1 }).lean();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await fin.adminPayoutsPage({ limit: 2, cursor });
      assert.equal(page.total, all.length);
      seen.push(...page.items.map((p) => String(p._id)));
      for (const p of page.items as any[]) {
        assert.ok(p.account, 'each row names its account');
        assert.equal(p.requestKey, undefined);
        if (p.settlementAccountId === L1) assert.deepEqual([p.account.ownerName, p.account.beneficiaryName, p.account.ownerKind], ['Metro Labs', 'Metro Labs Pvt Ltd', 'partner']);
        if (p.settlementAccountId === DA) assert.deepEqual([p.account.ownerName, p.account.ownerKind, p.account.ownerId], ['Dr Asha', 'doctor', drA]);
      }
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 100);
    assert.deepEqual(seen, all.map((p) => String(p._id)), 'every payout once, newest first');
    const onlyL2 = await fin.adminPayoutsPage({ accountId: L2 });
    assert.ok(onlyL2.items.length > 0 && onlyL2.items.every((p) => p.settlementAccountId === L2));
    await assert.rejects(() => fin.adminPayoutsPage({ cursor: 'nope' }), code('INVALID_CURSOR'));
    await assert.rejects(() => fin.adminPayoutsPage({ cursor: '123_abc' }), code('INVALID_CURSOR'));
  });

  await check('account payouts and finance events page by cursor, only within their own account', async () => {
    const acc1 = await fin.accountById(L1);
    const walk = async (fn: (c?: string) => Promise<{ items: any[]; nextCursor: string | null; total: number }>) => {
      const ids: string[] = []; let c: string | undefined; let total = -1;
      do { const p = await fn(c); total = p.total; ids.push(...p.items.map((x) => String(x._id))); c = p.nextCursor ?? undefined; } while (c);
      return { ids, total };
    };
    const pays = await walk((c) => fin.payoutsPage(acc1, { limit: 1, cursor: c }));
    const expected = (await SettlementPayoutModel.find({ settlementAccountId: L1 }).sort({ createdAt: -1, _id: -1 }).lean()).map((p) => String(p._id));
    assert.deepEqual(pays.ids, expected);
    assert.equal(pays.total, expected.length);
    const evs = await walk((c) => fin.eventsPage(acc1, { limit: 3, cursor: c }));
    assert.equal(evs.ids.length, await SettlementEventModel.countDocuments({ settlementAccountId: L1 }));
    assert.equal(new Set(evs.ids).size, evs.ids.length);
    const other = await fin.payoutsPage(await fin.accountById(L2), {});
    assert.ok(other.items.every((p) => p.settlementAccountId === L2) && !other.items.some((p) => expected.includes(String(p._id))));
    assert.deepEqual(await fin.payoutsPage(null, {}), { items: [], total: 0, nextCursor: null });
  });

  // ───────────────────────────── 4. Clinic desk ─────────────────────────────
  const { partner: cp, owner: cOwner } = await partnerSvc.createPartner({ kind: 'clinic', name: 'Care Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'CC',
    firstOwner: { phone: nextPhone(), name: 'Owner' } } as any);
  const clinicId = String(cp._id);
  await partnerSvc.verifyPartner(clinicId, 'admin');
  const own = actorFor(cOwner);
  const A = String((await partnerSvc.createBranch(own, { name: 'Kothrud', phone: '9876500000', holidays: [], hours: {},
    services: { homeCollection: false, inLab: false, inClinic: true }, address: addr } as any))._id);
  const deskM = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk', role: 'staff', branchIds: [A], permissions: ['bookings.view', 'bookings.manage', 'staff.manage'] } as any);
  const desk = actorFor(deskM);
  const { partner: cp2, owner: c2Owner } = await partnerSvc.createPartner({ kind: 'clinic', name: 'Other Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'OC',
    firstOwner: { phone: nextPhone(), name: 'Owner 2' } } as any);
  await partnerSvc.verifyPartner(String(cp2._id), 'admin');
  const other = actorFor(c2Owner);
  const drC = await doctor('Dr Clinic', 600, 'Orthopaedics', false);
  const drT = await doctor('Dr Invited', 700, 'Cardiology', false);
  // Q14: an admin links the doctor (clinics no longer invite); a pre-Q14 pending invitation stays readable.
  await clinic.linkDoctor(adminActor('q13-admin', clinicId), { doctorId: drC, branchIds: [A], requestKey: 'q13-link-0001' });
  await ClinicDoctorInviteModel.create([{ partnerId: clinicId, doctorId: drT, branchIds: [A], invitedBy: String(cOwner._id), state: 'pending' }]);
  const tomorrow = addDays(today, 1);
  const future = async (n: number) => slotAt(drC, A, new Date(new Date(`${tomorrow}T09:00:00+05:30`).getTime() + n * 30 * 60_000));
  let futureN = 0;

  await check('clinic invitations name the doctor (display name and speciality only); other clinics see none of them', async () => {
    const rows = await clinic.listInvites(own);
    const byDoctor = new Map(rows.map((r: any) => [r.doctorId, r]));
    assert.deepEqual((byDoctor.get(drT) as any).doctor, { doctorId: drT, name: 'Dr Invited', specialization: 'Cardiology' });
    assert.deepEqual([(byDoctor.get(drC) as any).doctor.name, (byDoctor.get(drC) as any).state], ['Dr Clinic', 'accepted']);
    assert.ok(!JSON.stringify(rows).includes('@x.test'), 'no contact details');
    assert.equal((await clinic.listInvites(other)).length, 0);
  });

  let startedBooking = '';
  await check('started slots: left out of the desk list and refused at create (no customer made); an earlier booking replays; a move onto one is refused', async () => {
    const started = await slotAt(drC, A, new Date(Date.now() - 10 * 60_000));
    const later = await future(futureN++);
    assert.ok(!(await clinic.deskSlots(own, { doctorId: drC, branchId: A, date: started.isoDate })).some((s) => s.slotId === started.slotId));
    assert.ok((await clinic.deskSlots(own, { doctorId: drC, branchId: A, date: later.isoDate })).some((s) => s.slotId === later.slotId));
    const phone = nextPhone();
    await assert.rejects(() => clinic.createDeskAppointment(desk, { slotId: started.slotId, customer: { phone }, requestKey: rk('desk') }), code('SLOT_STARTED'));
    assert.equal(await UserModel.exists({ phone }), null, 'no customer was created');
    // Booked before it started (an hour ago), then answered from its receipt now.
    const key = rk('desk');
    const made = await clinic.createDeskAppointment(desk, { slotId: started.slotId, customer: { phone }, requestKey: key }, new Date(Date.now() - 60 * 60_000));
    assert.equal(made.replayed, false);
    startedBooking = made.booking.bookingId;
    assert.equal((await clinic.createDeskAppointment(desk, { slotId: started.slotId, customer: { phone }, requestKey: key })).replayed, true);
    // Moving an appointment onto a started slot is refused inside the booking transaction.
    const moving = await clinic.createDeskAppointment(desk, { slotId: later.slotId, customer: { phone: nextPhone() }, requestKey: rk('desk') });
    const past = await slotAt(drC, A, new Date(Date.now() - 70 * 60_000));
    await assert.rejects(() => clinic.rescheduleDeskAppointment(desk, moving.booking.bookingId, past.slotId), code('SLOT_STARTED'));
    assert.equal((await BookingModel.findById(moving.booking.bookingId).lean())!.slotId, later.slotId.toLowerCase());
  });

  await check('started-slot admission samples the clock at admission, not when the request arrived', async () => {
    // A slot starting 5 minutes from "arrival"; the clock moves past its start before the booking transaction admits it.
    const arrival = new Date(Date.now() - 20 * 60_000);
    const slot = await slotAt(drC, A, new Date(arrival.getTime() + 5 * 60_000));
    let reads = 0;
    const lateClock = () => (++reads === 1 ? arrival : new Date(arrival.getTime() + 10 * 60_000));
    const phone = nextPhone();
    await assert.rejects(() => clinic.createDeskAppointment(desk, { slotId: slot.slotId, customer: { phone }, requestKey: rk('desk') }, lateClock), code('SLOT_STARTED'));
    assert.ok(reads >= 2, 'read again inside the transaction');
    assert.equal(await BookingModel.countDocuments({ slotId: slot.slotId.toLowerCase() }), 0, 'no seat taken');
    // A move: the same — the target is checked against the clock when the move takes the seat.
    const moving = await clinic.createDeskAppointment(desk, { slotId: (await future(futureN++)).slotId, customer: { phone: nextPhone() }, requestKey: rk('desk') });
    reads = 0;
    await assert.rejects(() => clinic.rescheduleDeskAppointment(desk, moving.booking.bookingId, slot.slotId, undefined, () => new Date(arrival.getTime() + 10 * 60_000)), code('SLOT_STARTED'));
  });

  await check('desk keys: a lost booking is found by its key (own desk and clinic only); give-up wins or finds it; legacy rows are used', async () => {
    const slot = await future(futureN++);
    const key = rk('desk');
    const made = await clinic.createDeskAppointment(desk, { slotId: slot.slotId, customer: { phone: nextPhone() }, requestKey: key });
    assert.ok(await RequestKeyModel.exists({ scope: clinic.deskKeyScope(desk), key, state: 'used' }), 'claimed in the booking transaction');
    assert.equal((await clinic.findDeskByKey(desk, key))!.bookingId, made.booking.bookingId);
    assert.equal(await clinic.findDeskByKey(own, key), null, 'keys belong to the desk member who used them');
    assert.equal(await clinic.findDeskByKey({ ...other, memberId: desk.memberId }, key), null, 'never across clinics');
    const used = await clinic.abandonDeskKey(desk, key);
    assert.deepEqual([used.state, (used as any).booking.bookingId], ['used', made.booking.bookingId]);
    const lost = rk('desk');
    assert.deepEqual(await clinic.abandonDeskKey(desk, lost), { state: 'abandoned' });
    const phone = nextPhone();
    await assert.rejects(async () => clinic.createDeskAppointment(desk, { slotId: (await future(futureN++)).slotId, customer: { phone }, requestKey: lost }),
      code('REQUEST_ABANDONED'));
    assert.equal(await UserModel.exists({ phone }), null, 'no customer was created for a given-up key');
    // A booking made before claims existed is used, never abandoned.
    await RequestKeyModel.deleteOne({ scope: clinic.deskKeyScope(desk), key });
    assert.equal((await clinic.abandonDeskKey(desk, key)).state, 'used');
    assert.equal(await RequestKeyModel.exists({ key, state: 'abandoned' }), null);
    // A give-up racing the booking: exactly one wins.
    for (let i = 0; i < 4; i++) {
      const k = rk('deskrace');
      const s = await future(futureN++);
      const [mk, gave] = await Promise.allSettled([clinic.createDeskAppointment(desk, { slotId: s.slotId, customer: { phone: nextPhone() }, requestKey: k }),
        clinic.abandonDeskKey(desk, k)]);
      const n = await BookingModel.countDocuments({ 'clinicDesk.requestKey': `desk:${desk.memberId}:${k}` });
      const state = gave.status === 'fulfilled' ? gave.value.state : 'error';
      if (state === 'abandoned') { assert.equal(n, 0); assert.equal(mk.status, 'rejected'); }
      else { assert.equal(state, 'used'); assert.equal(n, 1); }
    }
    assert.ok(deskKeyParamSchema.validate({ key: 'x' }).error);
  });

  await check('desk steps name the booking version: stale arrived/complete/no-show/cancel/reschedule are refused with BOOKING_CHANGED', async () => {
    const stale = new Date(Date.now() - 86_400_000);
    const made = await clinic.createDeskAppointment(desk, { slotId: (await future(futureN++)).slotId, customer: { phone: nextPhone() }, requestKey: rk('desk') });
    const v0 = made.booking.updatedAt!;
    await assert.rejects(() => clinic.markArrived(desk, made.booking.bookingId, stale), code('BOOKING_CHANGED'));
    const arrived = await clinic.markArrived(desk, made.booking.bookingId, v0);
    assert.ok(arrived.arrivedAt && new Date(arrived.updatedAt!).getTime() >= new Date(v0).getTime());
    await assert.rejects(() => clinic.closeDeskAppointment(desk, made.booking.bookingId, 'completed', new Date(), v0), code('BOOKING_CHANGED'));
    const target = await future(futureN++);
    await assert.rejects(() => clinic.rescheduleDeskAppointment(desk, made.booking.bookingId, target.slotId, v0), code('BOOKING_CHANGED'));
    const moved = await clinic.rescheduleDeskAppointment(desk, made.booking.bookingId, target.slotId, arrived.updatedAt);
    assert.equal(moved.slotId, target.slotId.toLowerCase());
    await assert.rejects(() => clinic.cancelDeskAppointment(desk, made.booking.bookingId, 'x', arrived.updatedAt), code('BOOKING_CHANGED'));
    assert.equal((await BookingModel.findById(made.booking.bookingId).lean())!.status, 'confirmed', 'the refused cancel changed nothing');
    const done = await clinic.closeDeskAppointment(desk, made.booking.bookingId, 'completed', new Date(), moved.updatedAt);
    assert.equal(done.status, 'completed');
    // No-show (after the appointment time) and cancel with the current version; without a version as before.
    const cur = (await BookingModel.findById(startedBooking).lean())!;
    await assert.rejects(() => clinic.closeDeskAppointment(desk, startedBooking, 'no_show', new Date(), stale), code('BOOKING_CHANGED'));
    assert.equal((await clinic.closeDeskAppointment(desk, startedBooking, 'no_show', new Date(), cur.updatedAt)).status, 'no_show');
    const c = await clinic.createDeskAppointment(desk, { slotId: (await future(futureN++)).slotId, customer: { phone: nextPhone() }, requestKey: rk('desk') });
    assert.equal((await clinic.cancelDeskAppointment(desk, c.booking.bookingId, 'Patient called', c.booking.updatedAt)).status, 'cancelled');
    const d = await clinic.createDeskAppointment(desk, { slotId: (await future(futureN++)).slotId, customer: { phone: nextPhone() }, requestKey: rk('desk') });
    assert.ok((await clinic.markArrived(desk, d.booking.bookingId)).arrivedAt);
    assert.equal(deskStepSchema.validate({ expectedUpdatedAt: 'yesterday' }).error !== undefined, true);
    // Another clinic cannot act on it at all.
    await assert.rejects(() => clinic.markArrived(other, d.booking.bookingId, d.booking.updatedAt), code('BOOKING_NOT_FOUND'));
  });

  // ───────────────────────────── HTTP: the real routers ─────────────────────────────
  const [{ default: specialistRouter }, { default: partnerRouter, settlementAdminRouter }] = await Promise.all([
    import('@/modules/specialists/routes'), import('@/modules/partners/routes')]);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/specialists', authenticate, specialistRouter);
  app.use('/api/v1/partner-workspace', authenticate, partnerRouter);
  app.use('/api/v1/settlements', authenticate, settlementAdminRouter);
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

  try {
    await check('HTTP doctor: presence read, accept replay (201 then 200), booking read, keyed extend, schedule version, paged payouts', async () => {
      const drH = await doctor('Dr Http', 300, 'Neurology');
      const t = doctorToken(drH);
      const pres = await call('GET', '/api/v1/specialists/me/presence', t);
      assert.deepEqual([pres.status, pres.json.data.online, pres.json.data.instantFeeMinor], [200, true, 30000]);
      const u = await customer(1000);
      const r = await svc.create(u, ask({ specialization: 'Neurology', target: { kind: 'specific', doctorId: drH } }));
      const id = String((r.request as any)._id);
      const offers = await call('GET', '/api/v1/specialists/me/instant/offers', t);
      assert.equal(offers.json.data.find((o: any) => o.requestId === id).quotedAmountMinor, 30000);
      const a1 = await call('POST', `/api/v1/specialists/me/instant/${id}/accept`, t);
      const a2 = await call('POST', `/api/v1/specialists/me/instant/${id}/accept`, t);
      assert.deepEqual([a1.status, a2.status, a2.json.data.replayed, a2.json.data.booking._id], [201, 200, true, a1.json.data.booking._id]);
      const bId = a1.json.data.booking._id;
      const e1 = await call('POST', `/api/v1/specialists/me/instant/bookings/${bId}/extend`, t, { minutes: 5, requestKey: 'http-ext-0001' });
      const e2 = await call('POST', `/api/v1/specialists/me/instant/bookings/${bId}/extend`, t, { minutes: 5, requestKey: 'http-ext-0001' });
      assert.deepEqual([e1.status, e2.status, e2.json.data.replayed, e2.json.data.endTime], [200, 200, true, e1.json.data.endTime]);
      const view = await call('GET', `/api/v1/specialists/me/instant/bookings/${bId}`, t);
      assert.deepEqual([view.status, view.json.data.held.endTime, view.json.data.extensions.length], [200, e1.json.data.endTime, 1]);
      assert.equal((await call('GET', `/api/v1/specialists/me/instant/bookings/${bId}`, doctorToken(drA))).status, 404);
      assert.equal((await call('POST', `/api/v1/specialists/me/instant/bookings/${bId}/extend`, t, { minutes: 5, requestKey: 'bad' })).status, 400);
      // Schedule
      const sched = { slotMinutes: 30, days: { tue: [{ start: '09:00', end: '10:00', modes: ['video'] }] } };
      assert.equal((await call('PUT', '/api/v1/specialists/me/schedule', t, { ...sched, expectedUpdatedAt: null })).status, 200);
      const stale = await call('PUT', '/api/v1/specialists/me/schedule', t, { ...sched, expectedUpdatedAt: null });
      assert.deepEqual([stale.status, stale.json.code], [409, 'SCHEDULE_CHANGED']);
      // Finance (the doctor's own account; paged; data stays an array)
      const pays = await call('GET', '/api/v1/specialists/me/finance/payouts?limit=1', doctorToken(drA));
      assert.deepEqual([pays.status, Array.isArray(pays.json.data), pays.json.data.length], [200, true, 1]);
      assert.equal(pays.json.pagination.total, await SettlementPayoutModel.countDocuments({ settlementAccountId: DA }));
      const fin1 = await call('GET', '/api/v1/specialists/me/finance', doctorToken(drA));
      assert.equal(fin1.json.data.account.financeVersion, await versionOf(DA));
    });

    await check('HTTP finance: partner payouts/events paged; admin queue paged with names, key lookup/abandon, versions refused', async () => {
      const t = partnerToken(P1.owner);
      const p1 = await call('GET', '/api/v1/partner-workspace/finance/payouts?limit=2', t);
      assert.deepEqual([p1.status, p1.json.data.length], [200, 2]);
      const p2 = await call('GET', `/api/v1/partner-workspace/finance/payouts?limit=2&cursor=${p1.json.pagination.nextCursor}`, t);
      assert.ok(p2.json.data.every((x: any) => !p1.json.data.some((y: any) => y._id === x._id)));
      assert.ok([...p1.json.data, ...p2.json.data].every((x: any) => x.settlementAccountId === L1));
      assert.equal((await call('GET', '/api/v1/partner-workspace/finance/payouts?cursor=zzz', t)).status, 400);
      const ev = await call('GET', '/api/v1/partner-workspace/finance/events?limit=2', t);
      assert.deepEqual([ev.status, ev.json.data.length, typeof ev.json.pagination.nextCursor], [200, 2, 'string']);
      // The admin mirror of the workspace pages the same way.
      const mirror = await call('GET', `/api/v1/partner-workspace/admin/${P1.partnerId}/workspace/finance/payouts?limit=2`, adminToken);
      assert.deepEqual(mirror.json.data.map((x: any) => x._id), p1.json.data.map((x: any) => x._id));
      const fv = (await call('GET', '/api/v1/partner-workspace/finance', t)).json.data.account.financeVersion;
      assert.equal(fv, await versionOf(L1));
      const dv = (await SettlementAccountModel.findById(L1).lean())!.payoutDetailsVersion;
      const stale = await call('PUT', '/api/v1/partner-workspace/finance/payout-details', t, { ...bank, expectedDetailsVersion: dv - 1 });
      assert.deepEqual([stale.status, stale.json.code], [409, 'PAYOUT_DETAILS_CHANGED']);
      // Admin
      const q = await call('GET', '/api/v1/settlements/payouts?limit=3', adminToken);
      assert.deepEqual([q.status, q.json.data.length, q.json.pagination.total], [200, 3, await SettlementPayoutModel.countDocuments({})]);
      assert.ok(q.json.data.every((x: any) => x.account?.beneficiaryName));
      const q2 = await call('GET', `/api/v1/settlements/payouts?limit=3&cursor=${q.json.pagination.nextCursor}`, adminToken);
      assert.ok(q2.json.data.every((x: any) => !q.json.data.some((y: any) => y._id === x._id)));
      const acct = await call('GET', `/api/v1/settlements/accounts/${L2}`, adminToken);
      assert.equal(acct.json.data.account.financeVersion, await versionOf(L2));
      const key = 'http-payout-0001';
      const body = { ...(await payoutInput(L2, 1000, { requestKey: key })), expectedFinanceVersion: acct.json.data.account.financeVersion - 1 };
      const refused = await call('POST', `/api/v1/settlements/accounts/${L2}/payouts`, adminToken, body);
      assert.deepEqual([refused.status, refused.json.code], [409, 'FINANCE_CHANGED']);
      const notYet = await call('GET', `/api/v1/settlements/accounts/${L2}/payouts/by-key/${key}`, adminToken);
      assert.deepEqual([notYet.status, notYet.json.code], [404, 'PAYOUT_NOT_FOUND']);
      const made = await call('POST', `/api/v1/settlements/accounts/${L2}/payouts`, adminToken, { ...body, expectedFinanceVersion: body.expectedFinanceVersion + 1 });
      assert.equal(made.status, 201);
      const found = await call('GET', `/api/v1/settlements/accounts/${L2}/payouts/by-key/${key}`, adminToken);
      assert.deepEqual([found.status, found.json.data._id], [200, made.json.data.payout._id]);
      assert.equal((await call('GET', `/api/v1/settlements/accounts/${L1}/payouts/by-key/${key}`, adminToken)).status, 404, 'another account');
      const gave = await call('POST', `/api/v1/settlements/accounts/${L2}/adjustments/by-key/http-adj-0001/abandon`, adminToken);
      assert.deepEqual([gave.status, gave.json.data.state], [200, 'abandoned']);
      const adj = await call('POST', `/api/v1/settlements/accounts/${L2}/adjustments`, adminToken, { amountMinor: 100, reason: 'Kit fee', requestKey: 'http-adj-0001' });
      assert.deepEqual([adj.status, adj.json.code], [409, 'REQUEST_ABANDONED']);
      assert.equal((await call('GET', `/api/v1/settlements/accounts/${L2}/adjustments/by-key/http-adj-0001`, adminToken)).status, 404);
      const evs = await call('GET', `/api/v1/settlements/accounts/${L2}/events?limit=1`, adminToken);
      assert.deepEqual([evs.status, evs.json.data.length], [200, 1]);
      // Partners cannot reach the admin routes.
      assert.equal((await call('GET', `/api/v1/settlements/accounts/${L2}/payouts/by-key/${key}`, t)).status, 403);
    });

    await check('HTTP clinic: desk key lookup (member and admin-as-owner), invitations with names, stale desk step refused', async () => {
      const t = partnerToken(deskM);
      const key = 'http-desk-0001';
      const made = await call('POST', '/api/v1/partner-workspace/clinic/appointments', t, { slotId: (await future(futureN++)).slotId, customer: { phone: nextPhone() }, requestKey: key });
      assert.equal(made.status, 201);
      const found = await call('GET', `/api/v1/partner-workspace/clinic/appointments/by-key/${key}`, t);
      assert.deepEqual([found.status, found.json.data.bookingId], [200, made.json.data.booking.bookingId]);
      const adminBase = `/api/v1/partner-workspace/admin/${clinicId}/workspace`;
      assert.equal((await call('GET', `${adminBase}/clinic/appointments/by-key/${key}`, adminToken)).status, 404, 'the desk member\'s key is theirs');
      const adminMade = await call('POST', `${adminBase}/clinic/appointments`, adminToken, { slotId: (await future(futureN++)).slotId, customer: { phone: nextPhone() }, requestKey: key });
      assert.equal(adminMade.status, 201);
      assert.equal((await call('GET', `${adminBase}/clinic/appointments/by-key/${key}`, adminToken)).json.data.bookingId, adminMade.json.data.booking.bookingId);
      const gave = await call('POST', `/api/v1/partner-workspace/clinic/appointments/by-key/http-desk-0002/abandon`, t);
      assert.deepEqual([gave.status, gave.json.data.state], [200, 'abandoned']);
      const stale = await call('POST', `/api/v1/partner-workspace/clinic/appointments/${made.json.data.booking.bookingId}/arrived`, t,
        { expectedUpdatedAt: new Date(0).toISOString() });
      assert.deepEqual([stale.status, stale.json.code], [409, 'BOOKING_CHANGED']);
      const fresh = await call('POST', `/api/v1/partner-workspace/clinic/appointments/${made.json.data.booking.bookingId}/arrived`, t,
        { expectedUpdatedAt: made.json.data.booking.updatedAt });
      assert.equal(fresh.status, 200);
      const invites = await call('GET', '/api/v1/partner-workspace/clinic/doctor-invites', t);
      assert.ok(invites.json.data.some((i: any) => i.doctor?.name === 'Dr Invited' && i.doctor?.specialization === 'Cardiology'));
      const otherClinic = await call('GET', `/api/v1/partner-workspace/clinic/appointments/by-key/${key}`, partnerToken(c2Owner));
      assert.equal(otherClinic.status, 404);
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} checks passed`);
}

main().then(() => mongoose.disconnect()).catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
