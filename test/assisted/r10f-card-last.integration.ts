/**
 * r10f: the last card-payment fixes before production (ASSISTED_BOOKING_DESIGN.md §23.7). Each check fails on d1ed6d24.
 *  1. the Meet step of a card booking's follow-up is bounded well inside its lease: a Meet call that hangs is aborted, the
 *     follow-up finishes without it, and no later caller creates a second Meet event;
 *  2. a card dispute can be recorded against an EXTRA capture's payment id (flag only: no wallet money moves); it holds
 *     that capture's unsent refund and shows in stuck money; an unknown id is still 404.
 * Same wiring as test/assisted/r10b-phase1b-fixes.integration.ts (its own database).
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/assisted_r10f_card_last_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/assisted/r10f-card-last.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import UserModel from '@/modules/user/model';
import { UserRepository } from '@/modules/user/repository';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import SlotModel from '@/modules/slots/model';
import { DependentRepository } from '@/modules/dependents/repository';
import { DependentService } from '@/modules/dependents/services';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { WalletTransactionModel } from '@/modules/wallet/model';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { PharmacyCustomerRepository } from '@/modules/pharmacyCustomers/repository';
import { PharmacyCustomerService } from '@/modules/pharmacyCustomers/services';
import { PharmacyWalletModel, PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { PharmacyWalletRepository, PharmacyWalletTransactionRepository } from '@/modules/pharmacyWallet/repository';
import { PharmacyWalletService } from '@/modules/pharmacyWallet/services';
import SpecialistModel from '@/modules/specialists/model';
import { SpecialistService } from '@/modules/specialists/services';
import { CouponModel } from '@/modules/coupon/model';
import { CouponRedemptionModel } from '@/modules/coupon/model/redemption';
import { errorHandler } from '@/modules/middleware';
import { SpecialistPortalService } from '@/modules/specialistPortal/services';
import { listClinicAppointments } from '@/modules/partners/services/clinic';
import { InvoiceService } from '@/modules/partners/services/invoice';
import { InvoiceRepository, InvoiceEventRepository, InvoiceCounterRepository } from '@/modules/partners/repository/invoice';
import { PartnerRepository } from '@/modules/partners/repository';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import PartnerOrgModel from '@/modules/partners/model';
import BranchModel from '@/modules/partners/model/branch';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/assisted_r10f_card_last_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;
const istParts = (at: Date) => { const s = new Date(at.getTime() + IST).toISOString(); return { date: s.slice(0, 10).replace(/-/g, ''), time: s.slice(11, 16) }; };

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.error('FAIL -', name, '\n  ', (e as Error).message.split('\n').slice(0, 3).join(' | ')); }
}
const noop = new Proxy({}, { get: () => async () => undefined });

/** Razorpay stand-in: orders made, the payments each order holds (set per test), refunds (with switchable outcomes). */
type GatewayPayment = { id: string; order_id: string; amount: number; currency: string; status: string; fee?: number };
const gateway = {
  orders: [] as { id: string; amount: number }[],
  payments: {} as Record<string, GatewayPayment[]>,
  refunds: [] as { id: string; paymentId: string; amount: number; status: string; notes: Record<string, unknown> }[],
  refundCalls: 0,
  /** 'processed' | 'pending' | 'reject' (a clear 400 refusal) */
  refundMode: 'processed' as 'processed' | 'pending' | 'reject',
  failOrders: false,
};
const fakeRazorpay = {
  orders: {
    create: async (o: { amount: number; currency: string }) => {
      if (gateway.failOrders) throw Object.assign(new Error('gateway down'), { error: { description: 'gateway down' } });
      const id = 'order_r10_' + oid();
      gateway.orders.push({ id, amount: o.amount });
      return { id, amount: o.amount, currency: o.currency, status: 'created' };
    },
    fetchPayments: async (orderId: string) => ({ items: gateway.payments[orderId] ?? [] }),
  },
  payments: { fetch: async (id: string) => {
    const p = Object.values(gateway.payments).flat().find((x) => x.id === id);
    if (!p) throw Object.assign(new Error('The id provided does not exist'), { statusCode: 400, error: { code: 'BAD_REQUEST_ERROR' } });
    return p;
  } },
};
const refundGateway = {
  listRefunds: async (paymentId: string) => gateway.refunds.filter((r) => r.paymentId === paymentId),
  fetchRefund: async (_p: string, refundId: string) => {
    const r = gateway.refunds.find((x) => x.id === refundId);
    if (!r) throw new Error('no such refund');
    return r;
  },
  refund: async (paymentId: string, body: { amount: number; receipt: string; notes: Record<string, string> }) => {
    gateway.refundCalls += 1;
    if (gateway.refundMode === 'reject') throw Object.assign(new Error('refund refused'), { statusCode: 400 });
    const r = { id: 'rfnd_' + oid(), paymentId, amount: body.amount, status: gateway.refundMode === 'pending' ? 'pending' : 'processed', notes: body.notes };
    gateway.refunds.push(r);
    return r;
  },
};

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();

  // tsx emits no decorator metadata: the services the controllers resolve are wired by hand before the routers load.
  const payments = Object.assign(Object.create(PaymentService.prototype), {
    bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
    walletTransactionRepository: new WalletTransactionRepository(), pharmacyWalletRepository: new PharmacyWalletRepository(),
    pharmacyWalletTransactionRepository: new PharmacyWalletTransactionRepository(), bookingReminderScheduler: noop,
    getRazorpayClient: () => fakeRazorpay,
    getRazorpayCredentials: () => ({ keyId: 'rzp_test_key', keySecret: 'secret' }),
  }) as unknown as PaymentService;
  const bookingService = Object.assign(Object.create(BookingService.prototype), {
    bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
    walletTransactionRepository: new WalletTransactionRepository(), userRepository: new UserRepository(),
    notificationService: noop, paymentService: payments, couponService: {}, emailService: {}, bookingReminderScheduler: noop,
    specialistService: { getById: async (id: string) => SpecialistModel.findById(id).lean() },
    slotService: { getById: async (id: string) => SlotModel.findById(id).lean() },
  }) as BookingService;
  Container.set(BookingService, bookingService);
  Container.set(PaymentService, payments);
  Container.set(DependentService, Object.assign(Object.create(DependentService.prototype), { dependentRepository: new DependentRepository() }));
  const pharmacyCustomerService = Object.assign(Object.create(PharmacyCustomerService.prototype), {
    pharmacyCustomerRepo: new PharmacyCustomerRepository(), pharmacyRepo: new PharmacyRepository(), userRepo: new UserRepository() }) as PharmacyCustomerService;
  Container.set(PharmacyCustomerService, pharmacyCustomerService);
  Container.set(PharmacyWalletService, Object.assign(Object.create(PharmacyWalletService.prototype), {
    walletRepo: new PharmacyWalletRepository(), txRepo: new PharmacyWalletTransactionRepository(), paymentService: payments }));
  Container.set(SpecialistService, { getById: async (id: string) => SpecialistModel.findById(id).lean() } as never);

  const notices: { key: string; audience: string; message: string }[] = [];
  const support = await import('@/modules/assisted/support');
  support.setAssistedNotifier(async (n) => { notices.push({ key: n.key, audience: n.audience, message: n.message }); });
  support.setAssistedEffects({ meet: async (b: any) => b, cancelMeet: async (b: any) => b, reminders: async () => undefined, clearReminders: async () => undefined } as never);
  // Loaded tolerantly, so that on the code before phase 1b every check fails on its own (instead of the import).
  const cardRefundsModule = await import('@/modules/assisted/cardRefunds').catch(() => null);
  cardRefundsModule?.setAssistedRefundGateway(refundGateway as never);
  const cardRefunds = { runCardRefundsDue: async (now?: Date) => { await cardRefundsModule?.runCardRefundsDue(now); } };
  const refundsCol = () => mongoose.connection.collection('assisted_card_refunds');
  await import('@/modules/assisted/cardPayments').then((m) => m.registerAssistedPayments()).catch(() => undefined);
  const phase1a = await import('@/modules/assisted/routes/phase1a');
  const { AssistedAuditEventModel, AssistedAlertModel } = await import('@/modules/assisted/model');
  const AssistedCardRefundModel = { find: (q: object) => ({ lean: () => mongoose.connection.collection('assisted_card_refunds').find(q).toArray() }) };
  const { default: bookingRouter } = await import('@/modules/bookings/routes');
  const { default: pharmacyBookingRouter } = await import('@/modules/assisted/routes');
  const { default: pharmacyWalletRouter } = await import('@/modules/pharmacyWallet/routes');
  const { default: paymentRouter } = await import('@/modules/payment/routes');
  const { authenticate } = await import('@/modules/middleware/auth');
  for (const name of mongoose.modelNames()) {
    const m = mongoose.model(name);
    await m.createCollection().catch(() => undefined);
    await m.syncIndexes();
  }

  const app = express();
  app.use(express.json());
  app.use('/api/v1/bookings', authenticate, bookingRouter);
  app.use('/api/v1/pharmacy-bookings', authenticate, pharmacyBookingRouter);
  app.use('/api/v1/pharmacy-assisted', authenticate, phase1a.pharmacyAssistedRouter);
  app.use('/api/v1/admin', authenticate, phase1a.adminAssistedRouter);
  app.use('/api/v1/pharmacy-wallet', authenticate, pharmacyWalletRouter);
  app.use('/api/v1/payments', authenticate, paymentRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  process.env.ASSISTED_LIMIT_BOOKINGS_PER_PHONE_PER_DAY = '1000';
  process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '100000';
  process.env.ASSISTED_BOOKING_ENABLED_PHARMACY = 'true';
  process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true';
  process.env.ASSISTED_CARD_PAYMENT_ENABLED = 'true';

  try {
    const P = oid(); const P2 = oid(); const ADMIN = oid(); const X = oid(); const D = oid(); const D2 = oid();
    await PharmacyModel.collection.insertMany([
      { _id: new Types.ObjectId(P), name: 'Rten Medicals', phone: '9700001001', email: 'rten@pharm.test', city: 'Shillong', pincode: '793001', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(P2), name: 'Other Medicals', phone: '9700001002', isActive: true, isVerified: true },
    ] as never);
    await UserModel.collection.insertOne({ _id: new Types.ObjectId(X), userType: 'user', phone: '9600001001', name: 'Rina Kumari Das',
      createdSource: 'self_signup', otpVerified: true } as never);
    await SpecialistModel.collection.insertMany([
      { _id: new Types.ObjectId(D), name: 'Dr Asha Menon', specialization: 'General Physician', languages: ['English'], city: 'Shillong', pincode: '793001',
        consultationFee: 500, isActive: true, isVerified: true },
      { _id: new Types.ObjectId(D2), name: 'Dr Ravi Kumar', specialization: 'General Physician', languages: ['English'], city: 'Shillong', pincode: '793001',
        consultationFee: 500, isActive: true, isVerified: true },
    ] as never);
    const tokens: Record<string, string> = {
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), P2: sign({ _id: P2, pharmacyId: P2, userType: 'pharmacy' }),
      X: sign({ _id: X, userType: 'user' }), ADMIN: sign({ _id: ADMIN, userType: 'admin' }),
    };
    const call = async (who: string | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(base + url, { method, headers: { ...(who ? { authorization: 'Bearer ' + (tokens[who] ?? who) } : {}),
        'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any; try { json = JSON.parse(text); } catch { json = { text }; }
      return { status: r.status, json, text };
    };
    const expect = async (who: string | null, method: string, url: string, status: number, body?: unknown, code?: string) => {
      const r = await call(who, method, url, body);
      assert.equal(r.status, status, `${method} ${url}: ${r.status} ${r.text.slice(0, 400)}`);
      if (code) assert.equal(r.json.code, code, `${method} ${url}: ${r.text.slice(0, 300)}`);
      return r;
    };
    const slotAt = async (doctor: string, at: Date) => {
      const s = istParts(at); const e = istParts(new Date(at.getTime() + 15 * MIN));
      const slot = await SlotModel.create({ specialistId: doctor, date: s.date, startTime: s.time, endTime: e.time, duration: 15, maxBookings: 1,
        currentBookings: 0, isActive: true, isAvailable: true, slotType: 'consultation' } as never);
      return String(slot._id);
    };
    let n = 0;
    /** A fresh slot 5+ days ahead (outside the customer cancellation window). */
    const futureSlot = async (doctor = D) => slotAt(doctor, new Date(Date.now() + 5 * DAY + (++n) * 20 * MIN));
    const newKey = () => `r10-key-${String(++n).padStart(4, '0')}-${oid().slice(-6)}`;
    const consult = (slotId: string, extra: Record<string, unknown> = {}) => ({
      requestKey: newKey(), phone: '9600001001', patient: { relation: 'self', name: 'Rina Das' },
      consent: { agreed: true, statementVersion: 'v1', statementLanguage: 'en' }, preferredLanguage: 'en', slotId, consultationMode: 'video',
      join: { on: 'partner_device' }, acceptedPriceMinor: 50000, primaryConcern: 'fever', paymentMethod: 'razorpay', ...extra,
    });
    const balanceOf = async (pharmacyId: string) => {
      const w = await PharmacyWalletModel.findOne({ pharmacyId }).lean() as any;
      return { paise: Number(w?.balancePaise ?? 0), withdrawable: Number(w?.withdrawableMinor ?? 0) };
    };
    const book = async (extra: Record<string, unknown> = {}, slotId?: string) => {
      const body = consult(slotId ?? await futureSlot(), extra);
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, body);
      return { body, data: r.json.data, id: String(r.json.data.booking._id) };
    };
    /** The gateway reports a capture for this booking's order; returns what verify needs. */
    const capture = (data: any) => {
      const orderId = data.payment.razorpayOrderId as string;
      const payId = 'pay_r10_' + oid().slice(-12);
      gateway.payments[orderId] = [{ id: payId, order_id: orderId, amount: data.payment.amountMinor, currency: 'INR', status: 'captured', fee: 1180 }];
      const signature = crypto.createHmac('sha256', 'secret').update(`${orderId}|${payId}`).digest('hex');
      return { paymentTransactionId: data.payment.paymentTransactionId, razorpayOrderId: orderId, razorpayPaymentId: payId, razorpaySignature: signature };
    };
    const later = (ms: number) => new Date(Date.now() + ms);
    const sweep = () => payments.sweepUnsettledBookingPayments(later(11 * MIN), 1000);
    const expire = () => bookingService.expireUnpaidBookings(later(31 * MIN), 1000);
    const bookingOf = async (id: string) => BookingModel.findById(id).lean() as Promise<any>;
    const refundsOf = async (id: string) => AssistedCardRefundModel.find({ bookingId: id }).lean() as Promise<any[]>;
    const gatewayRefundsFor = (data: any) => {
      const order = data.payment.razorpayOrderId as string;
      const payIds = new Set((gateway.payments[order] ?? []).map((p) => p.id));
      return gateway.refunds.filter((r) => payIds.has(r.paymentId));
    };
    const slotSeats = async (slotId: string) => Number(((await SlotModel.findById(slotId).lean()) as any)?.currentBookings ?? 0);

    const paidBooking = async (extra: Record<string, unknown> = {}, who = 'P') => {
      const body = consult(await futureSlot(), extra);
      const r = await expect(who, 'POST', '/pharmacy-assisted/consultations', 201, body);
      const b = { body, data: r.json.data, id: String(r.json.data.booking._id) };
      await expect(who, 'POST', '/payments/verify', 200, capture(b.data));
      assert.equal((await bookingOf(b.id)).status, 'confirmed');
      return b;
    };
    const rowOf = async (bookingId: string) => (await refundsOf(bookingId))[0] as any;
    const portal = Object.assign(Object.create(SpecialistPortalService.prototype), { bookingRepository: new BookingRepository(), userRepository: new UserRepository() }) as SpecialistPortalService;
    tokens.D = sign({ _id: D, userType: 'specialist' });
    const newPharmacy = async (name: string, phone: string) => {
      const id = oid();
      await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(id), name, phone, isActive: true, isVerified: true } as never);
      tokens[id] = sign({ _id: id, pharmacyId: id, userType: 'pharmacy' });
      return id;
    };

    const secondCapture = (data: any) => {
      const orderId = data.payment.razorpayOrderId as string;
      const payId = 'pay_R10f' + oid().slice(-12); // a real Razorpay id shape (letters and digits)
      (gateway.payments[orderId] ??= []).push({ id: payId, order_id: orderId, amount: data.payment.amountMinor, currency: 'INR', status: 'captured', fee: 1180 });
      const signature = crypto.createHmac('sha256', 'secret').update(`${orderId}|${payId}`).digest('hex');
      return { paymentTransactionId: data.payment.paymentTransactionId, razorpayOrderId: orderId, razorpayPaymentId: payId, razorpaySignature: signature };
    };
    const within = <T>(ms: number, p: Promise<T>) => Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error(`not done within ${ms} ms`)), ms))]);

    await check('1: a Meet call that hangs is aborted at its bound (well inside the lease); the follow-up finishes; no second Meet is ever created', async () => {
      process.env.ASSISTED_MEET_TIMEOUT_MS = '200';
      let meets = 0; let aborted = 0;
      support.setAssistedEffects({ cancelMeet: async (b: any) => b, reminders: async () => undefined, clearReminders: async () => undefined,
        // Hangs until aborted (gives up by itself after 3 s so that code without a bound does not hang this suite).
        meet: (b: any, opts?: { signal?: AbortSignal }) => { meets += 1; return new Promise((resolve) => {
          const t = setTimeout(() => resolve(b), 3000);
          opts?.signal?.addEventListener('abort', () => { aborted += 1; clearTimeout(t); resolve(b); }, { once: true });
        }); } } as never);
      try {
        const b = await book();
        const v = capture(b.data);
        await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(v.paymentTransactionId) }, { $set: { createdAt: new Date(Date.now() - 20 * MIN) } });
        const t0 = Date.now();
        await within(1500, Promise.allSettled([call('P', 'POST', '/payments/verify', v), sweep(),
          call('P', 'POST', '/payments/reconcile', { paymentTransactionId: v.paymentTransactionId })]));
        assert.ok(Date.now() - t0 < 1500, 'gave up at the bound');
        assert.equal(aborted, 1, 'the hanging Meet call was aborted');
        const after = await bookingOf(b.id);
        assert.equal(after.postPaymentCompletedFor, v.paymentTransactionId, 'the follow-up finished without the Meet');
        assert.equal(after.assisted.followUpLeaseUntil, undefined, 'lease released');
        // Later callers (and a later lease expiry) never start the Meet again.
        await expect('P', 'POST', '/payments/verify', 200, v);
        await sweep();
        await expect('P', 'POST', '/payments/reconcile', 200, { paymentTransactionId: v.paymentTransactionId });
        assert.equal(meets, 1, `${meets} Meet calls`);
        assert.equal((await PaymentRecordModel.findById(v.paymentTransactionId).lean() as any).isProcessed, true);
      } finally {
        delete process.env.ASSISTED_MEET_TIMEOUT_MS;
        support.setAssistedEffects({ meet: async (b: any) => b, cancelMeet: async (b: any) => b, reminders: async () => undefined, clearReminders: async () => undefined } as never);
      }
    });

    await check('2: a card dispute on an EXTRA capture\'s payment id is recorded (flag only), holds its unsent refund and shows in stuck money; unknown ids are 404', async () => {
      const b = await paidBooking();
      const recId = b.data.payment.paymentTransactionId;
      const y = secondCapture(b.data);
      // Razorpay unreachable for lookups: the extra capture's refund stays pending and unsent.
      const list = refundGateway.listRefunds;
      refundGateway.listRefunds = async () => { throw new Error('down'); };
      try { await expect('P', 'POST', '/payments/verify', 409, y, 'DUPLICATE_PAYMENT_REFUNDED'); }
      finally { refundGateway.listRefunds = list; }
      const before = await balanceOf(P);
      const calls0 = gateway.refundCalls;
      const r = await expect('ADMIN', 'POST', `/admin/assisted-payments/${y.razorpayPaymentId}/chargeback`, 200, { reason: 'Dispute lost on the second payment' });
      assert.deepEqual([r.json.data.recorded, r.json.data.replayed, r.json.data.extraCapture, r.json.data.razorpayPaymentId, r.json.data.paymentRecordId, r.json.data.refund.state],
        [true, false, true, y.razorpayPaymentId, recId, 'manual_review']);
      assert.equal((await expect('ADMIN', 'POST', `/admin/assisted-payments/${y.razorpayPaymentId}/chargeback`, 200, { reason: 'again' })).json.data.replayed, true);
      assert.equal((await PaymentRecordModel.findById(recId).lean() as any).chargebackAt, undefined, 'the booking\'s own payment is not disputed');
      const row = (await expect('ADMIN', 'GET', '/admin/assisted/stuck-money', 200)).json.data.cardChargebacks.find((x: any) => x.razorpayPaymentId === y.razorpayPaymentId);
      assert.ok(row, 'listed');
      assert.deepEqual([row.extraCapture, row.paymentRecordId, row.pharmacyId, row.pharmacyName], [true, recId, P, 'Rten Medicals']);
      await cardRefunds.runCardRefundsDue(later(DAY));
      assert.equal(gateway.refundCalls, calls0, 'the disputed extra capture is never refunded');
      assert.deepEqual(await balanceOf(P), before, 'no wallet money moved');
      assert.equal(await AssistedAuditEventModel.countDocuments({ bookingId: b.id, action: 'booking.card_chargeback' }), 1);
      await expect('ADMIN', 'POST', `/admin/assisted-payments/pay_R10fUnknown12/chargeback`, 404, { reason: 'x' }, 'PAYMENT_NOT_FOUND');
      // The booking's own payment can still be disputed on its own.
      assert.equal((await expect('ADMIN', 'POST', `/admin/assisted-payments/${recId}/chargeback`, 200, { reason: 'x' })).json.data.extraCapture, undefined);
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) { console.log('Failed:', failed.join('; ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
