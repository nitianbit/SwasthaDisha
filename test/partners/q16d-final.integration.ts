/**
 * Q16d: fixes from the final combined review of the Q16 integration line (Q16a + Q16b + Q16c on the stage line).
 * F1 started multi-seat windows (pre-check, desk list and create, no-show grace), F2 the legacy month flag on the admin's
 * moved-no-show cancel, F4 the list price kept at capture, F5 desk bookings refused by the admin's no-show cancel, F6 the
 * reconcile answer scrubbed, F7 the admin id stripped from noShowCancel, F8 the desk's same-day "seen", F9 the id-case
 * reports, F10 the one IST date helper, and the import preview's exact-batch MRP. Real MongoDB replica set.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed), so the suite can be run against the
 * code before Q16d to see each check fail.
 *
 * Run (throwaway DB only; the script drops its collections):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q16d_final_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx test/partners/q16d-final.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import UserModel from '@/modules/user/model';
import SpecialistModel from '@/modules/specialists/model';
import SlotModel from '@/modules/slots/model';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import { BookingController } from '@/modules/bookings/controller';
import { createBookingWithHolds } from '@/modules/bookings/holds';
import { publicNoShowView } from '@/modules/bookings/utils/noShowView';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService, bookingPriceTermsOf } from '@/modules/payment/services';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { CouponModel } from '@/modules/coupon/model';
import { CouponRepository } from '@/modules/coupon/repository';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import NotificationModel from '@/modules/notification/model';
import DependentModel from '@/modules/dependents/model';
import { DependentService } from '@/modules/dependents/services';
import { SlotRepository } from '@/modules/slots/repository';
import { SlotService } from '@/modules/slots/services';
import { DoctorReservationModel, DoctorScheduleGuardModel } from '@/modules/doctors/model/reservation';
import { DoctorScheduleTemplateModel } from '@/modules/doctors/model/schedule';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import { ClinicDoctorInviteModel } from '@/modules/partners/model/clinicDoctor';
import { SettlementAccountModel } from '@/modules/partners/model/settlement';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { PartnerService, PartnerActor, adminActor } from '@/modules/partners/services';
import { istDate, addDays } from '@/modules/partners/services/slots';
import * as clinic from '@/modules/partners/services/clinic';
import { PayoutBillingModel } from '@/modules/payouts/model';
import { runDoctorIdCaseAudit } from '@/scripts/q16aDoctorIdCaseAudit';
import { findNonCanonicalPartnerIds } from '@/scripts/q16bPartnerIdCase';
import * as common from '@/modules/common/utils/istDate';
import * as pharmacyDate from '@/modules/pharmacyInventory/businessDate';
import { LowStockAlertService } from '@/modules/pharmacyInventory/lowStockAlerts';
import PharmacySubscriptionModel from '@/modules/pharmacySubscriptions/model';
import PharmacyModel from '@/modules/pharmacies/model';
import { InventoryItemModel } from '@/modules/pharmacyInventory/model';
import { InventoryAdjustmentRepository, InventoryItemRepository } from '@/modules/pharmacyInventory/repository';
import MedicineModel from '@/modules/pharmacyMedicines/model';
import { MedicineRepository } from '@/modules/pharmacyMedicines/repository';
import { InventoryImportService } from '@/modules/pharmacyInventoryImports/services';
import { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q16d_final_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

// ── Services (no gateway) ──
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(),
  bookingReminderScheduler: { scheduleBookingReminders: async () => undefined, clearBookingReminders: async () => undefined },
}) as any;
const partnerSvc = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
Container.set(PartnerService, partnerSvc);
const slotSvc = Object.assign(Object.create(SlotService.prototype), { slotRepository: new SlotRepository() }) as SlotService;
const bookings = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), walletRepository: new WalletRepository(), slotService: slotSvc,
  bookingReminderScheduler: { clearBookingReminders: async () => undefined, scheduleBookingReminders: async () => undefined },
  notificationService: { create: async () => undefined, createSpecialistAppointmentCancelledNotification: async () => undefined },
}) as BookingService;
Container.set(BookingService, bookings);

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('ok -', name); }
  catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
const code = (c: string) => (e: any) => { if (e?.code !== c) throw e; return true; };
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let ph = 7170000000;
const nextPhone = () => String(ph++);
let keySeq = 0;
const rk = (p = 'q16d-key') => `${p}-${String(++keySeq).padStart(4, '0')}`;
const MIN = 60_000;
const DAY = 86_400_000;
const today = istDate(new Date());
const ymd = (iso: string) => iso.replace(/-/g, '');
const ist = (d: Date) => new Date(d.getTime() + 330 * MIN).toISOString();
/** An instant on IST day `today + dayOffset` at hh:mm India time. */
const at = (dayOffset: number, hhmm: string) => new Date(`${addDays(today, dayOffset)}T${hhmm}:00+05:30`);
const addr = { line1: '1 Road', city: 'Pune', state: 'Maharashtra', stateCode: '27', pincode: '411001' };
const clinicBranchInput = (name: string) => ({ name, phone: '9876500000', holidays: [], hours: {}, services: { homeCollection: false, inLab: false, inClinic: true }, address: addr }) as any;

async function doctor(name: string) {
  const id = new Types.ObjectId();
  await SpecialistModel.collection.insertOne({ _id: id, name, phone: nextPhone(), email: `${name.replace(/\W/g, '')}${ph}@x.test`, specialization: 'General Physician',
    consultationFee: 500, isActive: true, isVerified: true, rating: 4 } as never);
  return String(id);
}
async function customer() {
  const u = await UserModel.create({ phone: nextPhone(), name: 'Asha', userType: 'user', otpVerified: true } as any);
  await WalletModel.create({ userId: String(u._id), balance: 0, isActive: true });
  return String(u._id);
}
/** A slot of `minutes` from `start` (India time) with `max` seats. */
async function windowSlot(doctorId: string, start: Date, minutes: number, max: number, over: Record<string, unknown> = {}) {
  const s = ist(start);
  const e = ist(new Date(start.getTime() + minutes * MIN));
  const row = await SlotModel.create({ specialistId: doctorId, date: ymd(s.slice(0, 10)), startTime: s.slice(11, 16), endTime: e.slice(11, 16),
    duration: minutes, slotType: 'consultation', maxBookings: max, currentBookings: 0, isAvailable: true, isActive: true, ...over } as any);
  return String(row._id);
}
async function paidBookingOn(userId: string, doctorId: string, slotId: string) {
  const s = await SlotModel.findById(slotId).lean() as any;
  const b = await createBookingWithHolds({ bookingType: 'consultation', userId, specialistId: doctorId, doctorName: 'Dr', slotId, bookingDate: s.date,
    bookingTime: s.startTime, consultationMode: 'video', serviceMode: 'video', price: 400, originalPrice: 500, status: 'pending', paymentStatus: 'pending' } as any);
  await BookingModel.updateOne({ _id: b._id }, { $set: { status: 'confirmed', paymentStatus: 'paid', settlementSystem: 'legacy' } });
  return String(b._id);
}
/** Runs `fn` with the business clock at `ms` (restored afterwards). */
async function withClock<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const real = common.businessClock.now;
  common.businessClock.now = () => ms;
  try { return await fn(); } finally { common.businessClock.now = real; }
}

async function main() {
  await mongoose.connect(FIXTURE_URL, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [UserModel, SpecialistModel, SlotModel, BookingModel, PaymentRecordModel, WalletModel, WalletTransactionModel, CouponModel, RequestKeyModel,
    NotificationModel, DependentModel, DoctorReservationModel, DoctorScheduleGuardModel, DoctorScheduleTemplateModel, PartnerModel, MemberModel, BranchModel,
    PartnerAuditEventModel, ClinicDoctorInviteModel, SettlementAccountModel, PayoutBillingModel, PharmacySubscriptionModel, PharmacyModel, InventoryItemModel,
    MedicineModel] as mongoose.Model<any>[]) {
    await M.createCollection(); await M.createIndexes();
  }
  const ADMIN = new Types.ObjectId().toHexString();
  clinic.setClinicNotifier(async () => undefined);
  (CONFIG as any).SETTLEMENT_CUTOVER_AT = undefined; // legacy bookings throughout (F2 needs a legacy payout month)
  const dr = await doctor('Dr Window');

  // ───────────────────────────── F1: started multi-seat windows ─────────────────────────────
  await check('F1: the booking pre-check (package, specialist, reschedule) admits a started multi-seat window until it ENDS; a one-patient slot only until it starts', async () => {
    const multi = await windowSlot(dr, at(3, '10:00'), 120, 5);
    const single = await windowSlot(dr, at(3, '13:00'), 30, 1);
    const pre = (date: string, slotId: string, now: Date) => (bookings as any).validateBookingDateAndSlot(date, slotId, undefined, now)
      .then(() => 'ADMITTED', (e: any) => `${e.status} ${e.code}`);
    const d = ymd(addDays(today, 3));
    assert.equal(await pre(d, multi, at(3, '10:30')), 'ADMITTED', 'started 30 min ago, ends in 90 min: still bookable');
    assert.equal(await pre(d, multi, at(3, '12:00')), '409 SLOT_STARTED', 'ended');
    assert.equal(await pre(d, single, at(3, '13:05')), '409 SLOT_STARTED', 'a one-patient slot that has started');
    assert.equal(await pre(d, single, at(3, '12:55')), 'ADMITTED');
  });

  await check('package windows (owner rule, assumed): a one-seat package window stays bookable until it ENDS (pre-check, lists, admission); a doctor\'s one-patient slot still closes at its start', async () => {
    const pkg = String(new Types.ObjectId());
    const s = ist(at(3, '15:00')), e = ist(at(3, '17:00'));
    const win = String((await SlotModel.create({ wellnessPackageId: pkg, slotType: 'wellnessPackage', date: ymd(s.slice(0, 10)), startTime: s.slice(11, 16),
      endTime: e.slice(11, 16), duration: 120, maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true } as any))._id);
    const d = ymd(addDays(today, 3));
    const pre = (slotId: string, now: Date) => (bookings as any).validateBookingDateAndSlot(d, slotId, undefined, now).then(() => 'ADMITTED', (x: any) => `${x.status} ${x.code}`);
    assert.equal(await pre(win, at(3, '15:30')), 'ADMITTED', 'started 30 min ago, ends in 90 min');
    assert.equal(await pre(win, at(3, '17:00')), '409 SLOT_STARTED', 'ended');
    const { bookableNow } = await import('@/modules/slots/services');
    const listed = await bookableNow([await SlotModel.findById(win).lean() as any], at(3, '15:30'));
    assert.equal(listed.length, 1, 'still listed');
    const doctorSlot = await windowSlot(dr, at(3, '15:00'), 30, 1);
    assert.equal(await pre(doctorSlot, at(3, '15:05')), '409 SLOT_STARTED', 'a doctor one-patient slot closes at its start');
    // Admission inside the transaction, sampled now: a package window that started 10 minutes ago and ends in 110.
    const now = new Date();
    const s2 = ist(new Date(now.getTime() - 10 * MIN)), e2 = ist(new Date(now.getTime() + 110 * MIN));
    if (s2.slice(0, 10) === e2.slice(0, 10)) { // the same India day (not across midnight)
      const live = String((await SlotModel.create({ wellnessPackageId: pkg, slotType: 'wellnessPackage', date: ymd(s2.slice(0, 10)), startTime: s2.slice(11, 16),
        endTime: e2.slice(11, 16), duration: 120, maxBookings: 1, currentBookings: 0, isAvailable: true, isActive: true } as any))._id);
      const made = await createBookingWithHolds({ bookingType: 'package', userId: await customer(), wellnessPackageId: pkg, slotId: live, bookingDate: ymd(s2.slice(0, 10)),
        bookingTime: s2.slice(11, 16), serviceMode: 'in-person', price: 100, status: 'pending', paymentStatus: 'pending' } as any);
      assert.ok(made._id, 'admitted');
    }
  });

  // Clinic with a desk for the desk checks.
  const { partner: cp, owner: cOwner } = await partnerSvc.createPartner({ kind: 'clinic', name: 'Final Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'QD',
    firstOwner: { phone: nextPhone(), name: 'Owner' } } as any);
  const clinicId = String(cp._id);
  await partnerSvc.verifyPartner(clinicId, 'admin');
  const own = actorFor(cOwner);
  const A = String((await partnerSvc.createBranch(own, clinicBranchInput('Baner')))._id);
  const deskM = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk', role: 'staff', branchIds: [A],
    permissions: ['bookings.view', 'bookings.manage', 'staff.manage'] } as any);
  const desk = actorFor(deskM);
  const drC = await doctor('Dr Desk');
  await clinic.linkDoctor(adminActor(ADMIN, clinicId), { doctorId: drC, branchIds: [], requestKey: rk('link') });
  const deskWindow = (start: Date, minutes: number, max: number) => windowSlot(drC, start, minutes, max, { serviceModes: ['in-person'], branchId: A });

  await check('F1: the desk lists a started multi-seat window until it ends (a started one-patient slot is not listed)', async () => {
    const multi = await deskWindow(at(4, '10:00'), 120, 5);
    const single = await deskWindow(at(4, '09:30'), 30, 1);
    const ids = async (now: Date) => (await clinic.deskSlots(desk, { doctorId: drC, branchId: A, date: addDays(today, 4) }, now)).map((s: any) => String(s.slotId ?? s._id));
    const mid = await ids(at(4, '10:30'));
    assert.ok(mid.includes(multi), 'the started window is still offered');
    assert.ok(!mid.includes(single), 'the started one-patient slot is not');
    assert.ok(!(await ids(at(4, '12:00'))).includes(multi), 'an ended window is not offered');
  });

  await check('F1: the desk can book a started multi-seat window (until its end); an ended one is refused SLOT_STARTED', async () => {
    const multi = await deskWindow(at(5, '10:00'), 120, 5);
    const made = await clinic.createDeskAppointment(desk, { slotId: multi, customer: { phone: nextPhone() }, requestKey: rk('desk') }, at(5, '10:30'));
    assert.equal(made.booking.status, 'confirmed');
    await assert.rejects(() => clinic.createDeskAppointment(desk, { slotId: multi, customer: { phone: nextPhone() }, requestKey: rk('desk') }, at(5, '12:00')),
      code('SLOT_STARTED'));
  });

  await check('F1: in a multi-seat window a no-show may be marked only 15 minutes after the window END (doctor/admin and desk); one-patient slots keep start + 15', async () => {
    const u = await customer();
    const id = await paidBookingOn(u, dr, await windowSlot(dr, at(6, '10:00'), 120, 5));
    await assert.rejects(() => bookings.markNoShow(id, { _id: dr, userType: 'specialist' }, at(6, '10:20')), code('APPOINTMENT_NOT_STARTED'));
    await assert.rejects(() => bookings.markNoShow(id, { _id: dr, userType: 'specialist' }, at(6, '12:10')), code('APPOINTMENT_NOT_STARTED'));
    assert.equal((await bookings.markNoShow(id, { _id: dr, userType: 'specialist' }, at(6, '12:16'))).status, 'no_show');
    const one = await paidBookingOn(u, dr, await windowSlot(dr, at(6, '14:00'), 30, 1));
    assert.equal((await bookings.markNoShow(one, { _id: dr, userType: 'specialist' }, at(6, '14:16'))).status, 'no_show');
    // The desk: the same rule.
    const made = await clinic.createDeskAppointment(desk, { slotId: await deskWindow(at(6, '10:00'), 120, 5), customer: { phone: nextPhone() }, requestKey: rk('desk') });
    const did = made.booking.bookingId;
    await assert.rejects(() => clinic.closeDeskAppointment(desk, did, 'no_show', at(6, '10:20')), code('APPOINTMENT_NOT_STARTED'));
    assert.equal((await clinic.closeDeskAppointment(desk, did, 'no_show', at(6, '12:16'))).status, 'no_show');
  });

  // ───────────────────────────── F8: desk "seen" on the appointment's day ─────────────────────────────
  await check('F8: the desk may mark its appointment seen at any time on the appointment\'s own day (India date), not on an earlier day', async () => {
    const made = await clinic.createDeskAppointment(desk, { slotId: await deskWindow(at(7, '18:00'), 30, 1), customer: { phone: nextPhone() }, requestKey: rk('desk') });
    const id = made.booking.bookingId;
    await assert.rejects(() => clinic.closeDeskAppointment(desk, id, 'completed', at(6, '23:50')), code('NOT_STARTED_YET'));
    assert.equal((await clinic.closeDeskAppointment(desk, id, 'completed', at(7, '09:00'))).status, 'completed', 'same day, before the slot time');
  });

  // ───────────────────────────── F2 / F5: the admin's moved-no-show cancel ─────────────────────────────
  const insertBooking = async (over: Record<string, unknown>) => {
    const _id = new Types.ObjectId();
    await BookingModel.collection.insertOne({ _id, bookingType: 'consultation', userId: await customer(), specialistId: dr, bookingDate: ymd(addDays(today, 9)),
      bookingTime: '10:00', price: 500, originalPrice: 500, status: 'confirmed', paymentStatus: 'paid', holds: { version: 1, heldSlotId: null, followUpParentId: null },
      createdAt: new Date(), updatedAt: new Date(), ...over } as never);
    return String(_id);
  };
  await check('F2: an admin cancel of a moved legacy no-show flags its ORIGINAL month for recalculation, in the same transaction', async () => {
    const id = await insertBooking({ settlementSystem: 'legacy',
      noShows: [{ at: new Date(), rescheduledAt: new Date(), by: dr, byKind: 'specialist', fromDate: '20261105', fromTime: '10:00', requestKey: 'ns-q16d-0001', requestHash: 'h' }],
      noShowReschedules: 1 });
    await PayoutBillingModel.collection.insertOne({ specialistId: dr, month: 202611, totalAppointments: 1, amount: 500, due: 500, status: 'pending',
      createdAt: new Date(), updatedAt: new Date() } as never);
    const r = await bookings.adminCancelMovedNoShow(id, { _id: ADMIN }, { reason: 'Doctor away', refund: true });
    assert.equal(r.status, 'cancelled');
    const bill = await PayoutBillingModel.collection.findOne({ specialistId: dr, month: 202611 }) as any;
    assert.equal(bill.needsRecalculation, true);
    assert.ok((bill.recalculationReasons ?? []).includes(id));
  });

  await check('F5: the admin\'s moved-no-show cancel refuses a clinic desk booking (409 USE_CLINIC_CANCEL) and changes nothing', async () => {
    const id = await insertBooking({ settlementSystem: 'clinic', paymentStatus: 'pending',
      clinicDesk: { partnerId: clinicId, branchId: A, createdBy: 'member-1', requestKey: rk('desk-raw'), requestHash: 'h' },
      noShows: [{ at: new Date(), rescheduledAt: new Date(), by: 'member-1', byKind: 'clinic', fromDate: '20261101', fromTime: '10:00', requestKey: 'ns-q16d-0002', requestHash: 'h' }],
      noShowReschedules: 1 });
    for (const refund of [false, true]) {
      await assert.rejects(() => bookings.adminCancelMovedNoShow(id, { _id: ADMIN }, { reason: 'Clinic closed', refund }), code('USE_CLINIC_CANCEL'));
    }
    const b = await BookingModel.findById(id).lean() as any;
    assert.deepEqual([b.status, b.paymentStatus, b.noShowCancel], ['confirmed', 'pending', undefined]);
  });

  // ───────────────────────────── F4: list price kept at capture ─────────────────────────────
  await check('F4: capture keeps the booking\'s list price in originalPrice (a package record\'s base is its discounted price); price is the charged amount', async () => {
    const user = await customer();
    const bookingId = new Types.ObjectId();
    const recordId = new Types.ObjectId();
    await BookingModel.collection.insertOne({ _id: bookingId, bookingType: 'package', userId: user, wellnessPackageId: String(new Types.ObjectId()), packageName: 'Full body',
      bookingDate: ymd(addDays(today, 9)), bookingTime: '09:00 AM', price: 3500, originalPrice: 5000, status: 'pending', paymentStatus: 'pending',
      paymentTransactionId: String(recordId), holds: { version: 1, heldSlotId: null, followUpParentId: null }, createdAt: new Date(), updatedAt: new Date() } as never);
    await PaymentRecordModel.collection.insertOne({ _id: recordId, userId: user, context: 'booking', contextId: String(bookingId), baseAmount: 3500, discountAmount: 300,
      finalAmount: 3200, status: 'paid', isProcessed: false, currency: 'INR', notes: { bookingType: 'package' }, createdAt: new Date(), updatedAt: new Date() } as never);
    await payments.processBookingPayment(await PaymentRecordModel.findById(recordId).lean()).catch(() => undefined); // follow-ups need more services
    const after = await BookingModel.findById(bookingId).lean() as any;
    assert.deepEqual([after.paymentStatus, after.price, after.originalPrice], ['paid', 3200, 5000]);
    // The terms themselves (capture and pay-again use the same function).
    assert.deepEqual(bookingPriceTermsOf({ baseAmount: 3500, discountAmount: 300 }, { originalPrice: 5000 }), { price: 3200 });
    assert.deepEqual(bookingPriceTermsOf({ baseAmount: 3500, discountAmount: 300 }, {}), { originalPrice: 3500, price: 3200 });
  });

  // ───────────────────────────── F6 / F7: what a customer sees ─────────────────────────────
  await check('F6: POST /bookings/:id/reconcile-payments answers a customer with the scrubbed booking view (no desk, settlement or no-show internals)', async () => {
    const user = await customer();
    const _id = new Types.ObjectId();
    await BookingModel.collection.insertOne({ _id, bookingType: 'consultation', userId: user, specialistId: dr, bookingDate: ymd(addDays(today, 9)), bookingTime: '10:00',
      price: 500, status: 'confirmed', paymentStatus: 'paid', settlementSystem: 'ledger', settlement: { settlementAccountId: 'ACCOUNT-ID', beneficiaryName: 'Dr' },
      clinicDesk: { partnerId: 'p', branchId: 'b', createdBy: 'MEMBER-ID', requestKey: 'DESK-KEY', requestHash: 'DESK-HASH' },
      noShows: [{ at: new Date(), rescheduledAt: new Date(), by: 'DOCTOR-ID', byKind: 'specialist', requestKey: 'NS-KEY', requestHash: 'NS-HASH' }],
      noShowCancel: { at: new Date(), by: 'ADMIN-ID', refund: false }, createdAt: new Date(), updatedAt: new Date() } as never);
    const svc = Object.assign(Object.create(BookingService.prototype), { bookingRepository: new BookingRepository(),
      paymentService: { reconcileBookingPayments: async () => ({ unknown: 0 }) } }) as BookingService;
    Container.set(BookingService, svc);
    Container.set(DependentService, {} as never);
    let controller: BookingController;
    try { controller = new BookingController(); } finally { Container.set(BookingService, bookings); }
    let body: any;
    const res: any = { status: () => res, json: (b: any) => { body = b; return res; }, setHeader: () => res };
    await (controller as any).reconcilePayments({ user: { _id: user, userType: 'user' }, params: { id: String(_id) }, query: {}, body: {} }, res, () => undefined);
    const text = JSON.stringify(body);
    assert.ok(body?.data?.booking, 'the booking is answered');
    assert.deepEqual(['ACCOUNT-ID', 'MEMBER-ID', 'DESK-KEY', 'DESK-HASH', 'DOCTOR-ID', 'NS-KEY', 'NS-HASH', 'ADMIN-ID'].filter((x) => text.includes(x)), []);
  });

  await check('F7: the customer view drops which admin cancelled a moved no-show (noShowCancel.by), keeping the rest', () => {
    const when = new Date();
    const v = publicNoShowView({ _id: 'b1', status: 'cancelled', noShowCancel: { at: when, by: 'ADMIN-ID', refund: false, forfeitedAmount: 400 } } as any) as any;
    assert.deepEqual(v.noShowCancel, { at: when, refund: false, forfeitedAmount: 400 });
    const wrapped = publicNoShowView({ booking: { _id: 'b2', noShowCancel: { at: when, by: 'ADMIN-ID', refund: true } } } as any) as any;
    assert.equal(wrapped.booking.noShowCancel.by, undefined);
  });

  // ───────────────────────────── F9: id-case reports ─────────────────────────────
  await check('F9: the Q16b partner-id report ignores doctor settlement accounts (ownerKind doctor); the Q16a doctor audit lists upper-case-only accounts', async () => {
    const docUpper = new Types.ObjectId().toHexString().replace(/[a-f]/, 'A');
    const partnerUpper = new Types.ObjectId().toHexString().replace(/[a-f]/, 'B');
    const docBoth = new Types.ObjectId().toHexString().replace(/[a-f]/, 'C');
    const docAcc = new Types.ObjectId();
    await SettlementAccountModel.collection.insertMany([
      { _id: docAcc, ownerKind: 'doctor', ownerId: docUpper, createdAt: new Date() },
      { ownerKind: 'partner', ownerId: partnerUpper, createdAt: new Date() },
      { ownerKind: 'doctor', ownerId: docBoth, createdAt: new Date() },
      { ownerKind: 'doctor', ownerId: docBoth.toLowerCase(), createdAt: new Date() },
    ] as never);
    const partnerReport = await findNonCanonicalPartnerIds();
    const owners = partnerReport.collections.filter((c) => c.collection === 'settlement_accounts' && c.field === 'ownerId');
    assert.deepEqual(owners.map((c) => c.rows), [1], 'only the partner account');
    const audit = await runDoctorIdCaseAudit();
    assert.deepEqual(audit.upperCaseOnlyAccounts, [{ doctorId: docUpper.toLowerCase(), accountIds: [String(docAcc)] }]);
    assert.deepEqual(audit.doubledAccounts.map((d) => d.doctorId), [docBoth.toLowerCase()], 'a doubled doctor stays in doubledAccounts only');
  });

  // ───────────────────────────── F10: one IST date helper ─────────────────────────────
  await check('F10: one IST date helper — scheduling\'s istDate and pharmacy\'s istTodayYyyymmdd are the same helper on the same clock', () => {
    assert.equal(pharmacyDate.businessClock, common.businessClock, 'one clock');
    assert.equal(pharmacyDate.istTodayYyyymmdd, common.istTodayYyyymmdd);
    for (const t of ['2026-11-22T18:29:59Z', '2026-11-22T18:30:00Z', '2026-12-31T18:30:00Z']) {
      const d = new Date(t);
      assert.equal(istDate(d), common.istDateIso(d));
      assert.equal(common.istTodayYyyymmdd(d), istDate(d).replace(/-/g, ''));
    }
    assert.equal(common.istTodayYyyymmdd(new Date('2026-11-22T18:30:00Z')), '20261123');
  });

  const later = Date.now() + 10 * DAY; // the business clock moved ten days ahead
  const laterDate = common.istTodayYyyymmdd(later);
  await check('F10: coupon validity is judged on the IST business date', async () => {
    await CouponModel.collection.insertOne({ code: 'Q16DFUTURE', isActive: true, startDate: laterDate, endDate: laterDate, discountType: 'flat', discountValue: 10,
      eligibleFor: ['all'], createdAt: new Date(), updatedAt: new Date() } as never);
    const repo = new CouponRepository();
    assert.ok(!(await repo.findActiveCoupons()).some((c: any) => c.code === 'Q16DFUTURE'), 'not yet valid today');
    assert.ok((await withClock(later, () => repo.findActiveCoupons())).some((c: any) => c.code === 'Q16DFUTURE'), 'valid on the business date');
  });

  await check('F10: the slot create "not in the past" check uses the IST business date', async () => {
    const date = ymd(addDays(today, 5));
    await withClock(later, async () => {
      await assert.rejects(() => slotSvc.create({ specialistId: dr, date, startTime: '10:00 AM', endTime: '11:00 AM' } as any), code('INVALID_DATE'));
    });
  });

  await check('F10: the cancellation label (cancelledAt) is the IST business date', async () => {
    const u = await customer();
    const id = await paidBookingOn(u, dr, await windowSlot(dr, at(8, '10:00'), 30, 1));
    const done = await withClock(later, () => bookings.cancelByDoctor(id, { _id: dr, userType: 'specialist' }, 'Unavailable'));
    assert.equal((done as any).cancelledAt, laterDate);
  });

  await check('F10: the low-stock refill window counts refills due within 14 days of the IST business date', async () => {
    const pharmacyId = new Types.ObjectId();
    const medicineId = new Types.ObjectId();
    await PharmacySubscriptionModel.collection.insertOne({ pharmacyId, userId: new Types.ObjectId(), medicineId, intervalDays: 30, isActive: true,
      nextRefillDate: common.istTodayYyyymmdd(later + 5 * DAY), createdAt: new Date(), updatedAt: new Date() } as never);
    const svc = new LowStockAlertService();
    assert.equal((await svc.refillDemand(String(pharmacyId), [String(medicineId)])).get(String(medicineId)) ?? 0, 0, 'due in 15 days: outside the window today');
    assert.equal((await withClock(later, () => svc.refillDemand(String(pharmacyId), [String(medicineId)]))).get(String(medicineId)), 1);
  });

  // ───────────────────────────── Web: import preview MRP ─────────────────────────────
  await check('web: preview rows carry batchInStock; currentPrices.mrp is the exact batch\'s MRP, null for a batch not in stock (no latest-batch fallback)', async () => {
    const pA = new Types.ObjectId();
    const m = String((await MedicineModel.collection.insertOne({ name: 'Q16d Mrp Med', nameKey: 'q16d mrp med', isActive: true, prescriptionRequired: false } as never)).insertedId);
    const expiry = ymd(addDays(today, 400));
    await InventoryItemModel.collection.insertOne({ pharmacyId: pA, medicineId: new Types.ObjectId(m), availableQty: 2, reservedQty: 0, freeQty: 0, reorderThreshold: 0,
      retailPrice: 40, purchasePrice: 25, isActive: true, createdAt: new Date(), updatedAt: new Date(),
      batches: [{ _id: new Types.ObjectId(), batchNumber: 'OLD1', expiryDate: expiry, receivedAt: new Date(), availableQty: 2, reservedQty: 0, freeQty: 0, mrp: 55, status: 'active' }] } as never);
    const svc = new InventoryImportService(new InventoryItemRepository(), new MedicineRepository(), new InventoryAdjustmentRepository());
    const row = (batchNumber: string, expiryDate: string) => ({ rowIndex: 2, medicineName: 'Q16d Mrp Med', status: 'valid',
      data: { name: 'Q16d Mrp Med', quantityToAdd: 1, batchNumber, expiryDate } });
    const same = await (svc as any).enrichPreviewRow(String(pA), row('OLD1', expiry));
    assert.deepEqual([same.inMyStock, same.batchInStock, same.currentPrices?.mrp], [true, true, 55]);
    const fresh = await (svc as any).enrichPreviewRow(String(pA), row('NEW9', expiry));
    assert.deepEqual([fresh.inMyStock, fresh.batchInStock, fresh.currentPrices], [true, false, { mrp: null, retailPrice: 40, wholesalePrice: null, purchasePrice: 25 }]);
    const otherExpiry = await (svc as any).enrichPreviewRow(String(pA), row('OLD1', ymd(addDays(today, 500))));
    assert.deepEqual([otherExpiry.batchInStock, otherExpiry.currentPrices?.mrp], [false, null], 'same number, other expiry: another batch');
  });

  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
  console.log(`\n${passed} checks passed${failed.length ? `, ${failed.length} FAILED: ${failed.join(' | ')}` : ''}`);
  if (failed.length) { console.log(`${failed.length} checks failed`); process.exit(1); }
}

main().catch(async (e) => { console.error('SUITE CRASH', e); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
