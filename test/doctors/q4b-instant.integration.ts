/**
 * Q4b: instant consultations — presence, price contract, upfront payment (wallet / gateway / coupon), offers and
 * generations, atomic accept with funding split, refund-vs-accept serialization, any-available race, inactivity refund,
 * unpaid expiry, late captures, doctor cancellation after acceptance, completion earnings, extension, HTTP.
 * Real MongoDB replica set; fake Razorpay (as W3b); payments settle through the real reconcile path.
 *
 * Run (throwaway DB only; the script drops its collections):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q4b_instant_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/doctors/q4b-instant.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express, { Router } from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { authenticate, denyRoles, requireSpecialist } from '@/modules/middleware/auth';
import { errorHandler } from '@/modules/middleware';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import UserModel from '@/modules/user/model';
import SpecialistModel from '@/modules/specialists/model';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import { cancelBookingSettlement } from '@/modules/bookings/holds';
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
import { reserveInterval } from '@/modules/doctors/services/reservations';
import { InstantConsultService, allocateFunding, registerInstantPayments, OFFER_MS, INACTIVITY_MS } from '@/modules/doctors/services/instant';
import * as instantDoctor from '@/modules/doctors/controller/instant';
import { presenceSchema, requestIdParamSchema } from '@/modules/doctors/validation';
import { instantRouter } from '@/modules/doctors/routes';
import { SettlementAccountModel, LedgerEntryModel } from '@/modules/partners/model/settlement';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q4b_instant_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const gateway = new Map<string, { id: string; order_id: string; amount: number; currency: string; status: string }[]>();
const unreachable = new Set<string>();
let orders = 0;
const fakeRazorpay = {
  orders: {
    create: async (o: { amount: number; currency: string }) => ({ id: `order_${++orders}_${new Types.ObjectId().toHexString()}`, amount: o.amount, currency: o.currency, status: 'created' }),
    fetchPayments: async (orderId: string) => { if (unreachable.has(orderId)) throw new Error('gateway timeout'); return { items: gateway.get(orderId) ?? [] }; },
  },
  payments: { fetch: async () => { throw new Error('not used'); } },
};
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(),
  getRazorpayClient: () => fakeRazorpay, getRazorpayCredentials: () => ({ keyId: 'rzp_test_key', keySecret: 'secret' }),
}) as unknown as PaymentService;
const capture = async (paymentTransactionId: string) => {
  const r = await PaymentRecordModel.findById(paymentTransactionId).lean();
  gateway.set(r!.razorpayOrderId, [{ id: `pay_${new Types.ObjectId().toHexString()}`, order_id: r!.razorpayOrderId, amount: Math.round(r!.finalAmount * 100), currency: 'INR', status: 'captured' }]);
  await payments.reconcileContextPayments('instant_request', String(r!.contextId));
};

const svc = new InstantConsultService(payments, new CouponService(new CouponRepository()), new WalletRepository());
const notices: { userId: string; key: string }[] = [];
svc.notify = async (n) => { notices.push({ userId: n.userId, key: n.key }); };
Container.set(InstantConsultService, svc);
registerInstantPayments(() => svc);
const bookings = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), walletRepository: new WalletRepository(),
  bookingReminderScheduler: { clearBookingReminders: async () => undefined, scheduleBookingReminders: async () => undefined },
  notificationService: { create: async () => undefined, createSpecialistAppointmentCancelledNotification: async () => undefined },
}) as BookingService;

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) { await fn(); passed++; console.log('ok -', name); }
const code = (c: string) => (e: any) => e?.code === c;
let ph = 8300000000;
let keySeq = 0;
const rk = () => `instant-key-${String(++keySeq).padStart(4, '0')}`;
const balance = async (u: string) => Number((await WalletModel.findOne({ userId: u }).lean())!.balance);

async function doctor(name: string, feeRupees: number, specialization = 'General Physician') {
  const id = new Types.ObjectId();
  await SpecialistModel.collection.insertOne({ _id: id, name, phone: String(ph++), email: `${name.replace(/\W/g, '')}@x.test`, specialization,
    consultationFee: feeRupees, isActive: true, isVerified: true, rating: 4.5 } as never);
  await svc.setPresence(String(id), { available: true, modes: ['video', 'call'] });
  return String(id);
}
async function customer(walletRupees = 0) {
  const u = await UserModel.create({ phone: String(ph++), name: 'Asha', userType: 'user', otpVerified: true } as any);
  await WalletModel.create({ userId: String(u._id), balance: walletRupees, isActive: true });
  return String(u._id);
}
const ask = (over: Record<string, unknown> = {}) => ({ target: { kind: 'any' as const }, specialization: 'General Physician', mode: 'video' as const,
  patient: { kind: 'self' as const }, requestKey: rk(), ...over }) as any;

async function main() {
  await mongoose.connect(url, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [UserModel, SpecialistModel, BookingModel, PaymentRecordModel, WalletModel, WalletTransactionModel, CouponModel, RequestKeyModel,
    DoctorReservationModel, DoctorScheduleGuardModel, DoctorPresenceModel, InstantRequestModel, SettlementAccountModel, LedgerEntryModel] as mongoose.Model<any>[]) {
    await M.createCollection(); await M.createIndexes();
  }

  await check('funding split: fee from coupon → wallet → gateway; difference back gateway → wallet; always adds up', () => {
    const f = { couponMinor: 10000, walletMinor: 20000, gatewayMinor: 30000, totalMinor: 60000 };
    const a = allocateFunding(f, 45000);
    assert.deepEqual(a.allocated, { couponMinor: 10000, walletMinor: 20000, gatewayMinor: 15000, totalMinor: 45000 });
    assert.deepEqual(a.returned, { couponVoidedMinor: 0, walletMinor: 0, gatewayMinor: 15000, totalMinor: 15000 });
    const b = allocateFunding(f, 5000);
    assert.deepEqual(b.allocated, { couponMinor: 5000, walletMinor: 0, gatewayMinor: 0, totalMinor: 5000 });
    assert.deepEqual(b.returned, { couponVoidedMinor: 5000, walletMinor: 20000, gatewayMinor: 30000, totalMinor: 55000 });
    for (let fee = 0; fee <= 60000; fee += 1250) {
      const x = allocateFunding(f, fee);
      assert.equal(x.allocated.totalMinor + x.returned.totalMinor, f.totalMinor);
    }
    assert.throws(() => allocateFunding(f, 60001), code('FEE_ABOVE_QUOTE'));
  });

  const cheap = await doctor('Dr Cheap', 300);
  const dear = await doctor('Dr Dear', 800);

  await check('presence: heartbeat never makes a busy doctor online; stale heartbeats drop out; quotes follow online doctors', async () => {
    const q = await svc.quote({ specialization: 'general physician', mode: 'video' });
    assert.deepEqual(q, { quotedAmountMinor: 80000, doctors: 2 });
    assert.equal((await svc.quote({ specialization: 'General Physician', mode: 'video', doctorId: cheap })).quotedAmountMinor, 30000);
    const busy = await doctor('Dr Busy', 500);
    await runLedgerTransaction((s) => reserveInterval({ doctorId: busy, kind: 'scheduled', refId: 'appt-now', start: new Date(Date.now() - 60_000), end: new Date(Date.now() + 600_000) }, s));
    assert.equal((await svc.heartbeat(busy)).online, false);
    assert.ok(!(await svc.onlineDoctors({ specialization: 'General Physician', mode: 'video' })).some((d) => d.doctorId === busy));
    const stale = await doctor('Dr Stale', 900);
    await DoctorPresenceModel.updateOne({ doctorId: stale }, { $set: { lastSeenAt: new Date(Date.now() - 3 * 60_000) } });
    assert.equal((await svc.quote({ specialization: 'General Physician', mode: 'video' })).quotedAmountMinor, 80000, 'stale doctor excluded');
    await assert.rejects(() => svc.quote({ specialization: 'Dermatology', mode: 'video' }), code('NO_DOCTOR_ONLINE'));
    await assert.rejects(() => svc.setPresence(cheap, { available: true, modes: [] }), code('MODES_REQUIRED'));
  });

  await check('wallet-covered request: held at once, offered to every eligible online doctor; a resend returns the receipt', async () => {
    const u = await customer(1000);
    const req = ask({ useWalletBalance: true });
    const r = await svc.create(u, req);
    assert.equal(r.paymentRequired, false);
    const row = await InstantRequestModel.findOne({ userId: u }).lean();
    assert.equal(row!.status, 'offered');
    assert.deepEqual(row!.funding, { couponMinor: 0, walletMinor: 80000, gatewayMinor: 0, totalMinor: 80000 });
    assert.deepEqual([...row!.offeredTo].sort(), [cheap, dear].sort());
    assert.equal(await balance(u), 200);
    const again = await svc.create(u, req);
    assert.equal((again.request as any)._id.toString(), String(row!._id));
    await assert.rejects(() => svc.create(u, { ...req, mode: 'call' }), code('IDEMPOTENCY_KEY_REUSED'));
  });

  await check('gateway request: pending until captured, then held and offered once; the capture applies exactly once', async () => {
    const u = await customer(100);
    const r = await svc.create(u, ask({ target: { kind: 'specific', doctorId: dear }, useWalletBalance: true }));
    assert.equal(r.paymentRequired, true);
    assert.equal((r as any).payment.amount, 700);
    await capture((r as any).payment.paymentTransactionId);
    await payments.reconcileContextPayments('instant_request', String((r.request as any)._id));
    const row = await InstantRequestModel.findById((r.request as any)._id).lean();
    assert.equal(row!.status, 'offered');
    assert.deepEqual(row!.funding, { couponMinor: 0, walletMinor: 10000, gatewayMinor: 70000, totalMinor: 80000 });
    assert.deepEqual(row!.offeredTo, [dear]);
    assert.equal(notices.filter((n) => n.key === `instant:${row!._id}:offer:1:${dear}`).length, 1);
  });

  let acceptedBookingId = '';
  await check('accept (any-available, cheaper doctor): fee allocated, quote difference to the wallet once, paid booking + interval', async () => {
    (CONFIG as any).SETTLEMENT_CUTOVER_AT = new Date(Date.now() - 60_000).toISOString();
    const u = await customer(800);
    const r = await svc.create(u, ask({ useWalletBalance: true }));
    const id = String((r.request as any)._id);
    await assert.rejects(() => svc.accept(new Types.ObjectId().toHexString(), id), code('INSTANT_REQUEST_NOT_FOUND'));
    const out = await svc.accept(cheap, id);
    acceptedBookingId = String(out.booking._id);
    const row = await InstantRequestModel.findById(id).lean();
    assert.equal(row!.status, 'accepted');
    assert.deepEqual(row!.allocated, { couponMinor: 0, walletMinor: 30000, gatewayMinor: 0, totalMinor: 30000 });
    assert.deepEqual(row!.returned, { couponVoidedMinor: 0, walletMinor: 50000, gatewayMinor: 0, totalMinor: 50000 });
    assert.equal(await balance(u), 500, '800 paid, 500 returned');
    assert.equal(out.booking.bookingKind, 'instant');
    assert.equal(out.booking.status, 'confirmed');
    assert.equal(out.booking.paymentStatus, 'paid');
    assert.equal(out.booking.originalPrice, 300);
    assert.equal(out.booking.settlementSystem, 'ledger');
    assert.ok(out.booking.settlement?.settlementAccountId);
    assert.equal(await DoctorReservationModel.countDocuments({ doctorId: cheap, kind: 'instant', isActive: true }), 1);
    await assert.rejects(() => svc.accept(dear, id), code('OFFER_NO_LONGER_AVAILABLE'));
    assert.equal(await balance(u), 500, 'no second return');
    assert.ok(!(await svc.onlineDoctors({ specialization: 'General Physician', mode: 'video' })).some((d) => d.doctorId === cheap), 'busy now');
  });

  await check('completing the instant consult earns the fee once and frees the doctor at once', async () => {
    await bookings.update(acceptedBookingId, { status: 'completed' } as any);
    const e = await LedgerEntryModel.find({ source: 'consultation', sourceId: acceptedBookingId }).lean();
    assert.deepEqual(e.map((x) => x.amountMinor), [30000]);
    assert.equal(await DoctorReservationModel.countDocuments({ doctorId: cheap, isActive: true }), 0);
    (CONFIG as any).SETTLEMENT_CUTOVER_AT = undefined;
  });

  await check('any-available race: exactly one doctor wins; money split once', async () => {
    const d1 = await doctor('Dr R1', 400); const d2 = await doctor('Dr R2', 400); const d3 = await doctor('Dr R3', 400);
    const u = await customer(2000);
    const r = await svc.create(u, ask({ useWalletBalance: true, specialization: 'General Physician' }));
    const id = String((r.request as any)._id);
    const res = await Promise.allSettled([d1, d2, d3, cheap].map((d) => svc.accept(d, id)));
    assert.equal(res.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(await BookingModel.countDocuments({ instantRequestId: id }), 1);
    assert.equal(await WalletTransactionModel.countDocuments({ operationKey: `instant_request_return:${id}` }), 1);
  });

  await check('refund vs accept: mutually exclusive on the held funding; the wallet ends exactly right either way', async () => {
    for (let i = 0; i < 4; i++) {
      const d = await doctor(`Dr V${i}`, 500, 'Cardiology');
      const u = await customer(500);
      const r = await svc.create(u, ask({ useWalletBalance: true, specialization: 'Cardiology', target: { kind: 'specific', doctorId: d } }));
      const id = String((r.request as any)._id);
      const [acc, ref] = await Promise.allSettled([svc.accept(d, id), svc.requestRefund(u, id)]);
      const row = await InstantRequestModel.findById(id).lean();
      if (acc.status === 'fulfilled') {
        assert.equal(ref.status, 'rejected');
        assert.equal(row!.fundingState, 'allocated');
        assert.equal(await balance(u), 0);
      } else {
        assert.equal(ref.status, 'fulfilled');
        assert.equal(row!.fundingState, 'refunded');
        assert.equal(await balance(u), 500);
        assert.equal(await BookingModel.countDocuments({ instantRequestId: id }), 0);
      }
      await DoctorPresenceModel.updateOne({ doctorId: d }, { $set: { available: false } });
    }
  });

  await check('offers expire; the customer re-offers (new generation) within the paid quote; the old offer cannot be taken', async () => {
    const a = await doctor('Dr Slow', 600, 'ENT'); const b = await doctor('Dr Fast', 500, 'ENT'); const pricey = await doctor('Dr Pricey', 900, 'ENT');
    await DoctorPresenceModel.updateOne({ doctorId: pricey }, { $set: { available: false } });
    const u = await customer(600);
    const r = await svc.create(u, ask({ useWalletBalance: true, specialization: 'ENT', target: { kind: 'specific', doctorId: a } }));
    const id = String((r.request as any)._id);
    const later = new Date(Date.now() + OFFER_MS + 1000);
    await assert.rejects(() => svc.accept(a, id, later), code('OFFER_EXPIRED'));
    await DoctorPresenceModel.updateOne({ doctorId: pricey }, { $set: { available: true, lastSeenAt: new Date() } });
    await assert.rejects(() => svc.reoffer(u, id, { kind: 'specific', doctorId: pricey }), code('DOCTOR_NOT_ONLINE'), 'above the paid quote');
    const re = await svc.reoffer(u, id, { kind: 'specific', doctorId: b }) as any;
    assert.equal(re.offerGeneration, 2);
    await assert.rejects(() => svc.accept(a, id), code('INSTANT_REQUEST_NOT_FOUND'));
    await DoctorPresenceModel.updateOne({ doctorId: b }, { $set: { instantFeeMinor: 70000 } });
    await assert.rejects(() => svc.accept(b, id), code('FEE_ABOVE_QUOTE'));
    await DoctorPresenceModel.updateOne({ doctorId: b }, { $set: { instantFeeMinor: 50000 } });
    const busyAt = new Date();
    await runLedgerTransaction((s) => reserveInterval({ doctorId: b, kind: 'scheduled', refId: 'b-appt', start: new Date(busyAt.getTime() - 1000), end: new Date(busyAt.getTime() + 600_000) }, s));
    await assert.rejects(() => svc.accept(b, id), code('DOCTOR_BUSY'));
    assert.equal((await InstantRequestModel.findById(id).lean())!.fundingState, 'held', 'nothing changed');
  });

  await check('inactivity: activity pushes the refund out; after 30 idle minutes everything comes back once', async () => {
    const d = await doctor('Dr Idle', 400, 'Psychiatry');
    const u = await customer(400);
    const r = await svc.create(u, ask({ useWalletBalance: true, specialization: 'Psychiatry', target: { kind: 'specific', doctorId: d } }));
    const id = String((r.request as any)._id);
    const state = async () => (await InstantRequestModel.findById(id).lean())!.status;
    await svc.refundInactive(new Date(Date.now() + INACTIVITY_MS - 60_000));
    assert.equal(await state(), 'offered', 'not idle long enough');
    await svc.activity(u, id, new Date(Date.now() + 20 * 60_000));
    await svc.refundInactive(new Date(Date.now() + INACTIVITY_MS + 60_000));
    assert.equal(await state(), 'offered', 'activity moved the deadline');
    await svc.refundInactive(new Date(Date.now() + 20 * 60_000 + INACTIVITY_MS + 60_000));
    assert.equal(await state(), 'refunded');
    assert.equal(await balance(u), 400);
    assert.equal((await InstantRequestModel.findById(id).lean())!.refundReason, 'inactivity');
    await svc.refundInactive(new Date(Date.now() + 3 * INACTIVITY_MS));
    assert.equal(await balance(u), 400, 'once');
  });

  await check('unpaid requests expire after their window and return any wallet part; a later capture goes back to the wallet', async () => {
    const d = await doctor('Dr Expiry', 500, 'Ortho');
    const u = await customer(100);
    const r = await svc.create(u, ask({ useWalletBalance: true, specialization: 'Ortho', target: { kind: 'specific', doctorId: d } }));
    const id = String((r.request as any)._id);
    assert.equal(await balance(u), 0);
    const ex = await svc.expireUnpaid(new Date(Date.now() + 31 * 60_000));
    assert.ok(ex.expired >= 1);
    assert.equal((await InstantRequestModel.findById(id).lean())!.status, 'expired_unpaid');
    assert.equal(await balance(u), 100);
    await capture((r as any).payment.paymentTransactionId);
    assert.equal(await balance(u), 100 + 400, 'late capture returned');
  });

  await check('a second capture after acceptance is returned to the wallet, never applied twice', async () => {
    const d = await doctor('Dr Late', 500, 'Neuro');
    const u = await customer(0);
    const r = await svc.create(u, ask({ specialization: 'Neuro', target: { kind: 'specific', doctorId: d } }));
    const id = String((r.request as any)._id);
    const first = (r as any).payment.paymentTransactionId;
    await PaymentRecordModel.create({ _id: new Types.ObjectId(), userId: u, context: 'instant_request', contextId: id, baseAmount: 500, discountAmount: 0,
      finalAmount: 500, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'order_second_' + id, status: 'created', notes: { walletDeductedAmount: 0 } });
    await capture(first);
    await svc.accept(d, id);
    gateway.set('order_second_' + id, [{ id: 'pay_second', order_id: 'order_second_' + id, amount: 50000, currency: 'INR', status: 'captured' }]);
    await payments.reconcileContextPayments('instant_request', id);
    assert.equal(await balance(u), 500, 'the duplicate payment is back in the wallet');
    assert.equal(await BookingModel.countDocuments({ instantRequestId: id }), 1);
  });

  await check('doctor cancels an accepted consult: only the allocation is refunded, once; the coupon is voided; generic cancel is refused', async () => {
    await CouponModel.create({ code: 'SAVE100', discountType: 'fixed', discountValue: 100, applicableTo: 'all', eligibleFor: 'all',
      startDate: '20200101', endDate: '20991231', currentUsageCount: 0, isActive: true } as any);
    const d = await doctor('Dr Cancel', 500, 'Pediatrics');
    const u = await customer(400);
    const r = await svc.create(u, ask({ useWalletBalance: true, couponCode: 'SAVE100', specialization: 'Pediatrics', target: { kind: 'specific', doctorId: d } }));
    const id = String((r.request as any)._id);
    const held = await InstantRequestModel.findById(id).lean();
    assert.deepEqual(held!.funding, { couponMinor: 10000, walletMinor: 40000, gatewayMinor: 0, totalMinor: 50000 });
    assert.equal((await CouponModel.findOne({ code: 'SAVE100' }).lean())!.currentUsageCount, 1);
    const out = await svc.accept(d, id);
    await assert.rejects(() => cancelBookingSettlement({ bookingId: String(out.booking._id), requester: { _id: u, userType: 'user' }, reason: 'x',
      cancelledAt: '20261201', wallets: new WalletRepository(), enforceWindow: () => undefined, lifecycle: () => undefined as any }), code('INSTANT_CONSULT_COMMAND_REQUIRED'));
    const c = await bookings.cancelByDoctor(String(out.booking._id), { _id: d, userType: 'specialist' }, 'Emergency');
    assert.equal(c.status, 'cancelled');
    assert.equal(await balance(u), 400, 'wallet part of the allocation back; the coupon part is never money');
    assert.equal((await CouponModel.findOne({ code: 'SAVE100' }).lean())!.currentUsageCount, 0, 'coupon voided');
    assert.equal(await DoctorReservationModel.countDocuments({ refId: String(out.booking._id).toLowerCase(), isActive: true }), 0);
    await assert.rejects(() => svc.cancelAccepted(String(out.booking._id), { _id: d, userType: 'specialist' }, 'again'), code('BOOKING_STATE_CONFLICT'));
    assert.equal(await balance(u), 400);
  });

  await check('a doctor extends a running consult; an overlap with the next appointment is refused', async () => {
    const d = await doctor('Dr Extend', 300, 'Derm');
    const u = await customer(300);
    const r = await svc.create(u, ask({ useWalletBalance: true, specialization: 'Derm', target: { kind: 'specific', doctorId: d } }));
    const out = await svc.accept(d, String((r.request as any)._id));
    const res = await DoctorReservationModel.findOne({ refId: String(out.booking._id).toLowerCase() }).lean();
    await runLedgerTransaction((s) => reserveInterval({ doctorId: d, kind: 'scheduled', refId: 'next-appt', start: new Date(res!.endTime.getTime() + 10 * 60_000),
      end: new Date(res!.endTime.getTime() + 40 * 60_000) }, s));
    await svc.extend(d, String(out.booking._id), 10);
    await assert.rejects(() => svc.extend(d, String(out.booking._id), 5), code('DOCTOR_BUSY'));
  });

  // ── HTTP ──
  const doctorRoutes = Router();
  doctorRoutes.put('/me/presence', requireSpecialist, validate(presenceSchema, 'body'), catchAsync(instantDoctor.putPresence));
  doctorRoutes.get('/me/instant/offers', requireSpecialist, catchAsync(instantDoctor.getOffers));
  doctorRoutes.post('/me/instant/:requestId/accept', requireSpecialist, validate(requestIdParamSchema, 'params'), catchAsync(instantDoctor.acceptOffer));
  const app = express();
  app.use(express.json());
  app.use('/api/v1/specialists', authenticate, doctorRoutes);
  app.use('/api/v1/instant', authenticate, denyRoles('partner'), instantRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, token: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  try {
    await check('HTTP: a doctor goes online, a customer asks and pays, the doctor sees and accepts the offer; roles enforced', async () => {
      const d = await doctor('Dr Http', 450, 'Gastro');
      const dt = jwt.sign({ _id: d, specialistId: d, userType: 'specialist' }, CONFIG.JWT_SECRET_KEY);
      assert.equal((await call('PUT', '/api/v1/specialists/me/presence', dt, { available: true, modes: ['chat'] })).status, 200);
      const u = await customer(450);
      const ut = jwt.sign({ _id: u, userType: 'user', authVersion: 0 }, CONFIG.JWT_SECRET_KEY);
      const doctors = await call('GET', '/api/v1/instant/doctors?specialization=Gastro&mode=chat', ut);
      assert.equal(doctors.status, 200);
      assert.deepEqual(doctors.json.data.map((x: any) => x.doctorId), [d]);
      const made = await call('POST', '/api/v1/instant/requests', ut, ask({ useWalletBalance: true, specialization: 'Gastro', mode: 'chat', target: { kind: 'specific', doctorId: d } }));
      assert.equal(made.status, 201);
      assert.ok(!('walletFunding' in made.json.data.request));
      const offers = await call('GET', '/api/v1/specialists/me/instant/offers', dt);
      assert.equal(offers.json.data.length, 1);
      const acc = await call('POST', `/api/v1/specialists/me/instant/${offers.json.data[0].requestId}/accept`, dt);
      assert.equal(acc.status, 201);
      assert.equal(acc.json.data.booking.bookingKind, 'instant');
      assert.equal((await call('GET', '/api/v1/specialists/me/instant/offers', ut)).status, 403);
      assert.equal((await call('GET', '/api/v1/instant/doctors?specialization=Gastro&mode=chat', dt)).status, 403);
    });
  } finally {
    server.close();
  }

  await mongoose.disconnect();
  console.log(`\n${passed} checks passed`);
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
