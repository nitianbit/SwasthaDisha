/**
 * Assisted booking phase 1b (ASSISTED_BOOKING_DESIGN.md §23): a pharmacy pays an assisted consultation by card/UPI
 * (Razorpay) instead of its wallet. Every check fails on 9be7d0a7 (card bookings did not exist: 400
 * PAYMENT_METHOD_UNAVAILABLE, no `assisted_booking` payment context, no card refunds):
 *  1. switch, gateway and amount gates (refused before anything is held or opened, same answer for every number);
 *  2. create: pending booking holding its seat, one Razorpay order on a record owned by the pharmacy; replay by key;
 *  3. verify / reconcile / recovery sweep / expiry sweep racing on one capture: confirmed exactly once;
 *  4. the patient sees "Paid by <partner>", never the amount;
 *  5. late capture after expiry (and expiry racing the capture): refunded to the card once;
 *  6. cancel of a card-paid booking: back to the card once (booker, patient); the wallet choice;
 *  7. cancel racing the capture: exactly one refund;
 *  8. S5: a capture for a doctor no longer verified is returned to the card, the booking is not confirmed;
 *  9. who may verify: the paying pharmacy only, and only while operational;
 * 10. coupons: redeemed at create, reversed once at expiry;
 * 11. refund failures: operator queue, admin "to wallet" with agreement (once); a card dispute holds the refund.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/assisted_r10_phase1b_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/assisted/r10-phase1b.integration.ts
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

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/assisted_r10_phase1b_check?directConnection=true';
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

    // ───────────────────────── 1. Gates ─────────────────────────
    await check('gates: card switch off, gateway without keys, nothing to pay, card refund index missing — refused before any account, seat or order', async () => {
      const users0 = await UserModel.countDocuments({});
      const orders0 = gateway.orders.length;
      process.env.ASSISTED_CARD_PAYMENT_ENABLED = 'false';
      for (const phone of ['9600001001', '9600001099']) {
        await expect('P', 'POST', '/pharmacy-assisted/consultations', 400, consult(await futureSlot(), { phone }), 'PAYMENT_METHOD_UNAVAILABLE');
      }
      process.env.ASSISTED_CARD_PAYMENT_ENABLED = 'true';
      const creds = (payments as any).getRazorpayCredentials;
      (payments as any).getRazorpayCredentials = () => { throw new Error('not configured'); };
      try {
        for (const phone of ['9600001001', '9600001099']) {
          await expect('P', 'POST', '/pharmacy-assisted/consultations', 503, consult(await futureSlot(), { phone }), 'RAZORPAY_NOT_CONFIGURED');
        }
      } finally { (payments as any).getRazorpayCredentials = creds; }
      await SpecialistModel.updateOne({ _id: D2 }, { $set: { isConsultationFree: true } });
      try {
        await expect('P', 'POST', '/pharmacy-assisted/consultations', 400, consult(await futureSlot(D2), { phone: '9600001099', acceptedPriceMinor: 0 }), 'NOTHING_TO_PAY');
      } finally { await SpecialistModel.updateOne({ _id: D2 }, { $unset: { isConsultationFree: 1 } }); }
      // The card refunds' unique index is checked first (fail closed until sync-indexes has run).
      const refundsCol = mongoose.connection.collection('assisted_card_refunds');
      await refundsCol.dropIndex('paymentRecordId_1').catch(() => undefined);
      (await import('@/modules/common/utils/requiredIndex')).resetIndexChecks();
      try {
        await expect('P', 'POST', '/pharmacy-assisted/consultations', 503, consult(await futureSlot(), { phone: '9600001099' }), 'INDEXES_OUTDATED');
      } finally { await refundsCol.createIndex({ paymentRecordId: 1 }, { unique: true }); }
      assert.equal(await UserModel.countDocuments({}), users0, 'no account opened');
      assert.equal(await BookingModel.countDocuments({}), 0, 'nothing held');
      assert.equal(gateway.orders.length, orders0, 'no order');
    });

    // ───────────────────────── 2. Create and replay ─────────────────────────
    let first: Awaited<ReturnType<typeof book>>;
    await check('create: pending booking holds the seat; ONE Razorpay order on a record the pharmacy owns; no wallet money; nobody told yet', async () => {
      const before = await balanceOf(P);
      const slot = await futureSlot();
      notices.length = 0;
      first = await book({}, slot);
      const d = first.data;
      assert.equal(d.booking.status, 'pending');
      assert.equal(d.booking.paymentStatus, 'pending');
      assert.deepEqual({ method: d.funding.method, state: d.funding.state, amountMinor: d.funding.amountMinor }, { method: 'razorpay', state: 'pending', amountMinor: 50000 });
      assert.equal(d.payment.paymentRequired, true);
      assert.equal(d.payment.amountMinor, 50000);
      assert.equal(d.payment.amount, 500);
      assert.equal(d.payment.razorpayKeyId, 'rzp_test_key');
      assert.match(d.payment.razorpayOrderId, /^order_r10_/);
      assert.equal(d.funding.paymentTransactionId, d.payment.paymentTransactionId);
      assert.ok(Date.parse(d.payment.payBy) > Date.now() + 29 * MIN);
      assert.equal(await slotSeats(slot), 1, 'the seat is held');
      const rec = await PaymentRecordModel.findById(d.payment.paymentTransactionId).lean() as any;
      assert.equal(rec.context, 'assisted_booking');
      assert.equal(rec.contextId, first.id);
      assert.equal(String(rec.payerPharmacyId), P);
      assert.equal(String(rec.userId), P, 'the record belongs to the booker, never the patient');
      assert.equal(rec.couponCode, undefined);
      assert.equal(rec.status, 'created');
      assert.deepEqual(await balanceOf(P), before, 'no wallet movement');
      assert.equal(notices.length, 0, 'the patient and doctor hear of it once it is paid');
    });

    await check('replay by key: same request → 200 with the SAME order; by-key shows it; other content → 409', async () => {
      const orders0 = gateway.orders.length;
      const again = await expect('P', 'POST', '/pharmacy-assisted/consultations', 200, first.body);
      assert.equal(again.json.data.replayed, true);
      assert.equal(again.json.data.payment.razorpayOrderId, first.data.payment.razorpayOrderId);
      // The wallet method under the same key replays the card booking (the method is not part of the request hash, Q3).
      const asWallet = await expect('P', 'POST', '/pharmacy-assisted/consultations', 200, { ...first.body, paymentMethod: 'wallet' });
      assert.equal(asWallet.json.data.funding.method, 'razorpay');
      const byKey = await expect('P', 'GET', `/pharmacy-assisted/bookings/by-key/${first.body.requestKey}`, 200);
      assert.equal(byKey.json.data.state, 'used');
      assert.equal(byKey.json.data.payment.razorpayOrderId, first.data.payment.razorpayOrderId);
      assert.equal(byKey.json.data.booking.assisted.funding, undefined, 'the booker view never carries the funding block');
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 409, { ...first.body, primaryConcern: 'cough' }, 'IDEMPOTENCY_KEY_REUSED');
      assert.equal(gateway.orders.length, orders0, 'no second order');
      assert.equal(await PaymentRecordModel.countDocuments({ context: 'assisted_booking', contextId: first.id }), 1);
    });

    await check('a failed order call keeps the seat; the same request makes the order once', async () => {
      gateway.failOrders = true;
      const body = consult(await futureSlot());
      try {
        await expect('P', 'POST', '/pharmacy-assisted/consultations', 502, body, 'RAZORPAY_ORDER_CREATION_FAILED');
      } finally { gateway.failOrders = false; }
      const b = await BookingModel.findOne({ 'assisted.requestKey': { $regex: body.requestKey + '$' } }).lean() as any;
      assert.equal(b.status, 'pending');
      const byKey = await expect('P', 'GET', `/pharmacy-assisted/bookings/by-key/${body.requestKey}`, 200);
      assert.equal(byKey.json.data.payment, null, 'no order yet');
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 200, body);
      assert.match(r.json.data.payment.razorpayOrderId, /^order_r10_/);
      assert.equal(await PaymentRecordModel.countDocuments({ context: 'assisted_booking', contextId: String(b._id) }), 1);
    });

    // ───────────────────────── 3. Verify / reconcile / sweeps race ─────────────────────────
    await check('verify, reconcile, recovery sweep and expiry sweep racing on one capture: confirmed exactly once (5 runs)', async () => {
      for (let i = 0; i < 5; i++) {
        const b = i === 0 ? first : await book();
        const v = capture(b.data);
        // Old enough for both sweeps to pick it up.
        await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(v.paymentTransactionId) }, { $set: { createdAt: new Date(Date.now() - 20 * MIN) } });
        notices.length = 0;
        const results = await Promise.allSettled([
          call('P', 'POST', '/payments/verify', v), call('P', 'POST', '/payments/reconcile', { paymentTransactionId: v.paymentTransactionId }),
          sweep(), expire(), call('P', 'POST', '/payments/verify', v),
        ]);
        const answers = results.slice(0, 2).concat(results.slice(4)).map((r) => (r as PromiseFulfilledResult<any>).value);
        for (const a of answers) assert.ok([200, 409].includes(a.status), `answer ${a.status} ${a.text.slice(0, 200)}`);
        const after = await bookingOf(b.id);
        assert.equal(after.status, 'confirmed', 'confirmed');
        assert.equal(after.paymentStatus, 'paid');
        assert.equal(after.assisted.funding.state, 'captured');
        assert.equal(after.paymentTransactionId, v.paymentTransactionId);
        assert.equal(await AssistedAuditEventModel.countDocuments({ bookingId: b.id, action: 'booking.paid' }), 1, 'one confirmation');
        assert.equal((await refundsOf(b.id)).length, 0, 'nothing returned');
        const rec = await PaymentRecordModel.findById(v.paymentTransactionId).lean() as any;
        assert.deepEqual([rec.status, rec.isProcessed, rec.razorpayPaymentId], ['paid', true, v.razorpayPaymentId]);
        assert.equal(rec.gatewayFeeMinor, 1180, 'Jansetu bears the fee: recorded, never charged to the partner');
        assert.ok(after.postPaymentCompletedFor === v.paymentTransactionId, 'follow-up work done');
        assert.deepEqual([...new Set(notices.map((x) => x.key))].sort(), [`assisted:${b.id}:booked:customer`, `assisted:${b.id}:booked:doctor`]);
        const ok = answers.find((a) => a.status === 200 && a.json.data?.context === 'assisted_booking');
        assert.ok(ok, 'some answer carried the booking');
        assert.equal(ok.json.data.entity.assisted?.funding, undefined, 'the pharmacy sees the booker view');
        assert.equal(ok.json.data.entity.status, 'confirmed');
      }
      // Replays after the fact change nothing.
      const v = capture(first.data);
      const again = await expect('P', 'POST', '/payments/verify', 200, { ...v, razorpayPaymentId: (await PaymentRecordModel.findById(v.paymentTransactionId).lean() as any).razorpayPaymentId,
        razorpaySignature: crypto.createHmac('sha256', 'secret').update(`${v.razorpayOrderId}|${(await PaymentRecordModel.findById(v.paymentTransactionId).lean() as any).razorpayPaymentId}`).digest('hex') });
      assert.equal(again.json.data.entity.status, 'confirmed');
      assert.equal(await AssistedAuditEventModel.countDocuments({ bookingId: first.id, action: 'booking.paid' }), 1);
    });

    // ───────────────────────── 4. Patient view ─────────────────────────
    await check('the patient sees "Paid by <partner>", never the amount or the payment', async () => {
      const r = await expect('X', 'GET', `/bookings/${first.id}`, 200);
      const b = r.json.data;
      assert.equal(b.paidBy, 'Rten Medicals');
      for (const k of ['price', 'originalPrice', 'paymentTransactionId']) assert.equal(b[k], undefined, k);
      assert.equal(b.assisted.funding, undefined);
      assert.equal(b.lifecycle?.paid?.amount, undefined);
      assert.ok(!JSON.stringify(b).includes('50000') && !JSON.stringify(b).includes('"500"'), 'no amount anywhere');
      await expect('X', 'GET', `/bookings/${first.id}/payment-details`, 404);
      // The patient cannot verify or reconcile the pharmacy's payment.
      await expect('X', 'POST', '/payments/reconcile', 404, { paymentTransactionId: first.data.payment.paymentTransactionId });
    });

    // ───────────────────────── 5. Late capture after expiry ─────────────────────────
    await check('late capture after expiry: the seat was released; the capture goes back to the card ONCE whatever path finds it', async () => {
      const slot = await futureSlot();
      const b = await book({}, slot);
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(b.id) }, { $set: { createdAt: new Date(Date.now() - 40 * MIN) } });
      await expire();
      const gone = await bookingOf(b.id);
      assert.equal(gone.status, 'cancelled');
      assert.equal(gone.cancellationCause, 'payment_timeout');
      assert.equal(gone.assisted.funding.state, 'not_paid');
      assert.equal(await slotSeats(slot), 0, 'seat released');
      // The partner paid after all.
      const v = capture(b.data);
      const calls0 = gateway.refundCalls;
      const r = await expect('P', 'POST', '/payments/verify', 200, v);
      assert.equal(r.json.data.paymentRecord.status, 'refunded');
      assert.match(r.json.message, /refunded to the card or UPI/);
      await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(v.paymentTransactionId) }, { $set: { createdAt: new Date(Date.now() - 20 * MIN) } });
      await Promise.all([sweep(), call('P', 'POST', '/payments/verify', v), call('P', 'POST', '/payments/reconcile', { paymentTransactionId: v.paymentTransactionId }),
        cardRefunds.runCardRefundsDue(later(10 * MIN))]);
      await cardRefunds.runCardRefundsDue(later(10 * MIN));
      const rows = await refundsOf(b.id);
      assert.equal(rows.length, 1, 'one refund row');
      assert.deepEqual([rows[0].cause, rows[0].method, rows[0].state, rows[0].amountMinor], ['late_capture', 'razorpay', 'processed', 50000]);
      assert.equal(gateway.refundCalls - calls0, 1, 'one refund sent');
      assert.equal(gatewayRefundsFor(b.data).length, 1);
      const after = await bookingOf(b.id);
      assert.equal(after.status, 'cancelled', 'never revived');
      assert.equal(after.assisted.funding.refunds.length, 1);
      assert.equal(after.assisted.funding.refunds[0].state, 'processed');
      assert.equal(await AssistedAuditEventModel.countDocuments({ bookingId: b.id, action: 'booking.paid' }), 0);
    });

    await check('expiry racing the capture (5 runs): either confirmed with no refund, or expired with exactly one card refund', async () => {
      for (let i = 0; i < 5; i++) {
        const b = await book();
        await BookingModel.collection.updateOne({ _id: new Types.ObjectId(b.id) }, { $set: { createdAt: new Date(Date.now() - 40 * MIN) } });
        const v = capture(b.data);
        const calls0 = gateway.refundCalls;
        // The expiry sweep checks the gateway first; the order now shows the capture, so it is applied (never expired).
        await Promise.allSettled([expire(), call('P', 'POST', '/payments/verify', v), sweep()]);
        await cardRefunds.runCardRefundsDue(later(10 * MIN));
        const after = await bookingOf(b.id);
        const rows = await refundsOf(b.id);
        if (after.status === 'confirmed') {
          assert.equal(rows.length, 0);
          assert.equal(gateway.refundCalls - calls0, 0);
        } else {
          assert.equal(after.status, 'cancelled');
          assert.equal(rows.length, 1);
          assert.equal(gateway.refundCalls - calls0, 1);
        }
        assert.equal(await AssistedAuditEventModel.countDocuments({ bookingId: b.id, action: 'booking.paid' }), after.status === 'confirmed' ? 1 : 0);
      }
    });

    // ───────────────────────── 6. Cancel and refund ─────────────────────────
    const paidBooking = async () => {
      const b = await book();
      await expect('P', 'POST', '/payments/verify', 200, capture(b.data));
      assert.equal((await bookingOf(b.id)).status, 'confirmed');
      return b;
    };
    await check('booker cancel of a card-paid booking: back to the card once; the wallet is not touched; a repeat refunds nothing', async () => {
      const b = await paidBooking();
      const before = await balanceOf(P);
      const calls0 = gateway.refundCalls;
      notices.length = 0;
      const r = await expect('P', 'POST', `/pharmacy-assisted/bookings/${b.id}/cancel`, 200, { reason: 'patient left' });
      assert.equal(r.json.data.refundedMinor, 50000);
      assert.equal(r.json.data.refund.method, 'card');
      assert.equal(r.json.data.refund.state, 'processed', 'sent at once (the worker retries otherwise)');
      assert.equal(gateway.refundCalls - calls0, 1);
      const g = gatewayRefundsFor(b.data);
      assert.equal(g.length, 1);
      assert.equal(g[0]!.amount, 50000, 'refunded in full (Jansetu bears the fee)');
      assert.deepEqual(await balanceOf(P), before, 'wallet untouched');
      const rec = await PaymentRecordModel.findById(b.data.payment.paymentTransactionId).lean() as any;
      assert.equal(rec.status, 'refunded');
      const after = await bookingOf(b.id);
      assert.equal(after.assisted.funding.state, 'refunded');
      assert.deepEqual(after.assisted.funding.refunds.map((x: any) => [x.method, x.state, x.cause]), [['razorpay', 'processed', 'booker']]);
      assert.ok(notices.some((x) => x.key === `assisted:${b.id}:cancelled:customer`));
      const again = await expect('P', 'POST', `/pharmacy-assisted/bookings/${b.id}/cancel`, 200, {});
      assert.equal(again.json.data.alreadyCancelled, true);
      assert.equal(again.json.data.refundedMinor, 0);
      await cardRefunds.runCardRefundsDue(later(10 * MIN));
      assert.equal(gateway.refundCalls - calls0, 1, 'still one');
      assert.equal((await refundsOf(b.id)).length, 1);
      // Nothing went to the patient's wallet.
      assert.equal(await WalletTransactionModel.countDocuments({ userId: X }), 0);
    });

    await check('the wallet choice: the booker sends a card-paid booking\'s money to its wallet instead (once, not withdrawable)', async () => {
      const b = await paidBooking();
      const before = await balanceOf(P);
      const calls0 = gateway.refundCalls;
      const r = await expect('P', 'POST', `/pharmacy-assisted/bookings/${b.id}/cancel`, 200, { refundTo: 'wallet' });
      assert.equal(r.json.data.refundedMinor, 50000);
      assert.deepEqual([r.json.data.refund.method, r.json.data.refund.state], ['wallet', 'processed']);
      const after = await balanceOf(P);
      assert.equal(after.paise - before.paise, 50000);
      assert.equal(after.withdrawable, before.withdrawable, 'card money back in the wallet is not withdrawable');
      const rid = b.data.payment.paymentTransactionId;
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ operationKey: `assisted_card:${rid}:refund` }), 1);
      assert.equal(gateway.refundCalls, calls0, 'nothing sent to the card');
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${b.id}/cancel`, 200, { refundTo: 'wallet' });
      assert.equal((await balanceOf(P)).paise - before.paise, 50000, 'once');
      // refundTo is validated.
      await expect('P', 'POST', `/pharmacy-assisted/bookings/${b.id}/cancel`, 400, { refundTo: 'cash' });
    });

    await check('patient cancel of a card-paid booking: the refund goes to the PARTNER\'s card, never the patient', async () => {
      const b = await paidBooking();
      const calls0 = gateway.refundCalls;
      await expect('X', 'POST', `/bookings/${b.id}/cancel`, 200, { reason: 'not needed' });
      const rows = await refundsOf(b.id);
      assert.deepEqual(rows.map((x) => [x.cause, x.method, x.state]), [['patient', 'razorpay', 'processed']]);
      assert.equal(gateway.refundCalls - calls0, 1);
      assert.equal(await WalletTransactionModel.countDocuments({ userId: X }), 0);
      assert.ok(notices.some((x) => x.key === `assisted:${b.id}:cancelled:booker` && /card or UPI/.test(x.message)));
    });

    await check('cancel before the payment: nothing refunded; a capture landing later goes back to the card once', async () => {
      const slot = await futureSlot();
      const b = await book({}, slot);
      notices.length = 0;
      const r = await expect('P', 'POST', `/pharmacy-assisted/bookings/${b.id}/cancel`, 200, {});
      assert.deepEqual(notices, [], 'the patient and doctor never heard of it: no cancellation notice either');
      assert.equal(r.json.data.refundedMinor, 0);
      assert.equal(r.json.data.refund, null);
      assert.equal((await bookingOf(b.id)).assisted.funding.state, 'not_paid');
      assert.equal(await slotSeats(slot), 0);
      const v = capture(b.data);
      await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(v.paymentTransactionId) }, { $set: { createdAt: new Date(Date.now() - 20 * MIN) } });
      const calls0 = gateway.refundCalls;
      await sweep();
      await sweep();
      await cardRefunds.runCardRefundsDue(later(10 * MIN));
      const rows = await refundsOf(b.id);
      assert.deepEqual(rows.map((x) => [x.cause, x.state]), [['late_capture', 'processed']]);
      assert.equal(gateway.refundCalls - calls0, 1);
    });

    // ───────────────────────── 7. Cancel racing the capture ─────────────────────────
    await check('cancel racing the capture (5 runs): the booking ends cancelled with exactly one card refund', async () => {
      for (let i = 0; i < 5; i++) {
        const b = await book();
        const v = capture(b.data);
        const calls0 = gateway.refundCalls;
        await Promise.allSettled([call('P', 'POST', `/pharmacy-assisted/bookings/${b.id}/cancel`, {}), call('P', 'POST', '/payments/verify', v)]);
        // Whatever lost the race is settled by the recovery paths.
        await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(v.paymentTransactionId) }, { $set: { createdAt: new Date(Date.now() - 20 * MIN) } });
        await sweep();
        if ((await bookingOf(b.id)).status !== 'cancelled') await expect('P', 'POST', `/pharmacy-assisted/bookings/${b.id}/cancel`, 200, {});
        await cardRefunds.runCardRefundsDue(later(10 * MIN));
        const after = await bookingOf(b.id);
        assert.equal(after.status, 'cancelled');
        const rows = await refundsOf(b.id);
        assert.equal(rows.length, 1, 'one refund row');
        assert.equal(rows[0].state, 'processed');
        assert.equal(gateway.refundCalls - calls0, 1, 'one refund sent');
      }
    });

    // ───────────────────────── 8. S5 ─────────────────────────
    await check('S5: a capture for a doctor no longer verified is returned to the card; the booking is not confirmed', async () => {
      const b = await book({}, await futureSlot(D2));
      await SpecialistModel.updateOne({ _id: D2 }, { $set: { isVerified: false } });
      try {
        const calls0 = gateway.refundCalls;
        const r = await expect('P', 'POST', '/payments/verify', 200, capture(b.data));
        assert.equal(r.json.data.paymentRecord.status, 'refunded');
        const after = await bookingOf(b.id);
        assert.equal(after.status, 'pending', 'never confirmed');
        assert.equal(after.assisted.funding.state, 'pending');
        assert.deepEqual((await refundsOf(b.id)).map((x) => [x.cause, x.state]), [['late_capture', 'processed']]);
        assert.equal(gateway.refundCalls - calls0, 1);
      } finally { await SpecialistModel.updateOne({ _id: D2 }, { $set: { isVerified: true } }); }
    });

    // ───────────────────────── 9. Who may verify ─────────────────────────
    await check('verify: another pharmacy is answered 404; the paying pharmacy is refused 403 while not operational', async () => {
      const b = await book();
      const v = capture(b.data);
      await expect('P2', 'POST', '/payments/verify', 404, v, 'PAYMENT_RECORD_NOT_FOUND');
      await expect('X', 'POST', '/payments/verify', 404, v, 'PAYMENT_RECORD_NOT_FOUND');
      await PharmacyModel.updateOne({ _id: P }, { $set: { isVerified: false } });
      try {
        await expect('P', 'POST', '/payments/verify', 403, v, 'PHARMACY_NOT_VERIFIED');
        await expect('P', 'POST', '/payments/reconcile', 403, { paymentTransactionId: v.paymentTransactionId }, 'PHARMACY_NOT_VERIFIED');
      } finally { await PharmacyModel.updateOne({ _id: P }, { $set: { isVerified: true } }); }
      assert.equal((await bookingOf(b.id)).status, 'pending');
      // The capture is not lost: the recovery sweep applies it.
      await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(v.paymentTransactionId) }, { $set: { createdAt: new Date(Date.now() - 20 * MIN) } });
      await sweep();
      assert.equal((await bookingOf(b.id)).status, 'confirmed');
    });

    // ───────────────────────── 10. Coupons ─────────────────────────
    await check('coupons: redeemed for the patient at create (same rules as the wallet), reversed once at expiry', async () => {
      await CouponModel.create({ code: 'CARD100', discountType: 'fixed', discountValue: 100, applicableTo: 'all', eligibleFor: 'all', startDate: '20200101',
        endDate: '20991231', currentUsageCount: 0, totalUsageLimit: 10, isActive: true } as never);
      await CouponModel.create({ code: 'CARDONCE', discountType: 'fixed', discountValue: 100, applicableTo: 'all', eligibleFor: 'all', startDate: '20200101',
        endDate: '20991231', currentUsageCount: 0, usageLimitPerUser: 1, isActive: true } as never);
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 400, consult(await futureSlot(), { couponCode: 'CARDONCE', acceptedPriceMinor: 40000 }), 'COUPON_NOT_FOR_ASSISTED');
      await expect('P', 'POST', '/pharmacy-assisted/consultations', 409, consult(await futureSlot(), { couponCode: 'CARD100' }), 'PRICE_CHANGED');
      const b = await book({ couponCode: 'CARD100', acceptedPriceMinor: 40000 });
      assert.equal(b.data.payment.amountMinor, 40000);
      assert.equal(((await CouponModel.findOne({ code: 'CARD100' }).lean()) as any).currentUsageCount, 1);
      assert.equal(await CouponRedemptionModel.countDocuments({ bookingId: b.id, state: 'counted', patientUserId: X }), 1);
      const rec = await PaymentRecordModel.findById(b.data.payment.paymentTransactionId).lean() as any;
      assert.equal(rec.couponCode, undefined, 'the payment record never counts the coupon');
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(b.id) }, { $set: { createdAt: new Date(Date.now() - 40 * MIN) } });
      await expire();
      await expire();
      assert.equal((await bookingOf(b.id)).status, 'cancelled');
      assert.equal(((await CouponModel.findOne({ code: 'CARD100' }).lean()) as any).currentUsageCount, 0, 'reversed once');
      assert.equal(await CouponRedemptionModel.countDocuments({ bookingId: b.id, state: 'reversed' }), 1);
    });

    // ───────────────────────── 11. Refund failures, operator queue, card disputes ─────────────────────────
    await check('a refused card refund goes to the operator queue; an admin moves it to the wallet with the partner\'s agreement, once', async () => {
      const b = await paidBooking();
      gateway.refundMode = 'reject';
      try {
        const r = await expect('P', 'POST', `/pharmacy-assisted/bookings/${b.id}/cancel`, 200, {});
        assert.equal(r.json.data.refund.state, 'failed');
      } finally { gateway.refundMode = 'processed'; }
      const queue = await expect('ADMIN', 'GET', '/admin/assisted/card-refunds', 200);
      const item = queue.json.data.find((x: any) => x.bookingId === b.id);
      assert.ok(item, 'listed');
      assert.equal(item.lastError, 'GATEWAY_REJECTED');
      const stuck = await expect('ADMIN', 'GET', '/admin/assisted/stuck-money', 200);
      assert.ok(stuck.json.data.refundRowsPending.some((x: any) => x.bookingId === b.id));
      await expect('P', 'GET', '/admin/assisted/card-refunds', 403);
      await expect('ADMIN', 'POST', `/admin/assisted/card-refunds/${item.refundId}/to-wallet`, 400, {});
      const before = await balanceOf(P);
      const moved = await expect('ADMIN', 'POST', `/admin/assisted/card-refunds/${item.refundId}/to-wallet`, 200, { agreement: 'Partner agreed by phone, ticket 42' });
      assert.deepEqual([moved.json.data.refund.method, moved.json.data.refund.state, moved.json.data.replayed], ['wallet', 'processed', false]);
      const again = await expect('ADMIN', 'POST', `/admin/assisted/card-refunds/${item.refundId}/to-wallet`, 200, { agreement: 'again' });
      assert.equal(again.json.data.replayed, true);
      assert.equal((await balanceOf(P)).paise - before.paise, 50000, 'credited once');
      assert.equal((await bookingOf(b.id)).assisted.funding.refunds[0].state, 'processed');
      assert.equal(await AssistedAuditEventModel.countDocuments({ bookingId: b.id, action: 'card_refund.to_wallet' }), 1);
    });

    await check('a card dispute on a booking payment is recorded and flagged (no wallet money moves); its unsent refund is held, never sent or credited', async () => {
      const b = await paidBooking();
      const rid = b.data.payment.paymentTransactionId;
      const before = await balanceOf(P);
      gateway.refundMode = 'pending';
      let refundId = '';
      try {
        // Cancel with the gateway down for lookups: the row stays pending and unsent.
        const list = refundGateway.listRefunds;
        refundGateway.listRefunds = async () => { throw new Error('down'); };
        try {
          const r = await expect('P', 'POST', `/pharmacy-assisted/bookings/${b.id}/cancel`, 200, {});
          assert.equal(r.json.data.refund.state, 'pending');
          refundId = r.json.data.refund.refundId;
        } finally { refundGateway.listRefunds = list; }
      } finally { gateway.refundMode = 'processed'; }
      const calls0 = gateway.refundCalls;
      const cb = await expect('ADMIN', 'POST', `/admin/assisted-payments/${b.data.payment.razorpayOrderId}/chargeback`, 200, { reason: 'Dispute lost, case 77' });
      assert.deepEqual([cb.json.data.recorded, cb.json.data.replayed, cb.json.data.paymentRecordId, cb.json.data.refund.state], [true, false, rid, 'manual_review']);
      const again = await expect('ADMIN', 'POST', `/admin/assisted-payments/${rid}/chargeback`, 200, { reason: 'again' });
      assert.equal(again.json.data.replayed, true);
      assert.ok((await PaymentRecordModel.findById(rid).lean() as any).chargebackAt);
      assert.equal(await AssistedAlertModel.countDocuments({ kind: 'booking_card_chargeback', 'detail.paymentRecordId': rid }), 1);
      assert.equal(await AssistedAuditEventModel.countDocuments({ bookingId: b.id, action: 'booking.card_chargeback' }), 1);
      await cardRefunds.runCardRefundsDue(later(10 * MIN));
      assert.equal(gateway.refundCalls, calls0, 'never sent');
      await expect('ADMIN', 'POST', `/admin/assisted/card-refunds/${refundId}/to-wallet`, 409, { agreement: 'x' }, 'CHARGEBACK_RECORDED');
      assert.deepEqual(await balanceOf(P), before, 'no wallet money moved');
      // A top-up route never takes a booking payment, and a booking payment route never takes a top-up.
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${rid}/chargeback`, 404, { reason: 'x' }, 'TOPUP_NOT_FOUND');
      await expect('ADMIN', 'POST', `/admin/assisted-payments/${oid()}/chargeback`, 404, { reason: 'x' }, 'PAYMENT_NOT_FOUND');
    });

    await check('a refund the gateway holds as pending is completed later by the worker (one submission)', async () => {
      const b = await paidBooking();
      gateway.refundMode = 'pending';
      const calls0 = gateway.refundCalls;
      try {
        const r = await expect('P', 'POST', `/pharmacy-assisted/bookings/${b.id}/cancel`, 200, {});
        assert.equal(r.json.data.refund.state, 'pending');
      } finally { gateway.refundMode = 'processed'; }
      for (const g of gatewayRefundsFor(b.data)) g.status = 'processed';
      await cardRefunds.runCardRefundsDue(later(10 * MIN));
      const rows = await refundsOf(b.id);
      assert.equal(rows[0].state, 'processed');
      assert.equal(gateway.refundCalls - calls0, 1, 'looked up, never sent twice');
      assert.equal((await bookingOf(b.id)).assisted.funding.refunds[0].state, 'processed');
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) { console.log('Failed:', failed.join('; ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
