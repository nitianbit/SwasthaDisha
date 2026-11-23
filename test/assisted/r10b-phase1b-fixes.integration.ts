/**
 * r10b: fixes of the review of phase 1b (9f2a1807), ASSISTED_BOOKING_DESIGN.md §23.6. Each check fails on 9f2a1807 except
 * the one marked "guard". Same wiring as test/assisted/r10-phase1b.integration.ts (its own database).
 *  1. a card refund Razorpay keeps "pending" is polled for 30+ days without using up failures, and completes;
 *     admin recheck asks Razorpay now; admin mark-failed reads Razorpay first (refuses a live refund), then to-wallet;
 *     stuck money lists refunds pending over N days;
 *  2. a cap on pending card bookings per booker (also under concurrency); an unpaid expiry counts as a booker cancellation;
 *  3. patients and doctors never list, read, cancel, edit or report a card booking that was never paid;
 *  4. to-wallet refuses while Razorpay holds a processed or pending refund of the payment;
 *  5. a confirmation whose follow-up work was cut short is finished by the recovery sweep (not refunded);
 *  6. a card dispute cannot be recorded on a payment never captured;
 *  7. a bad signature leaves an assisted card order payable (other contexts still close: guard);
 *  8. a disputed assisted payment answers PAYMENT_DISPUTED (not top-up wording) and shows in stuck money.
 * r10c (fail on b287b340): 9. the booker view's `payment`; 10. the admin refund rows name the paying pharmacy.
 * r10d (fail on 6b223644): 11. the clinic workspace neither lists nor bills a card booking never paid; 12. racing
 *     confirmers make ONE Meet event; 13. the booker view carries the open order (pay now anywhere); 14. an admin move of
 *     an unpaid card booking tells only the booker; 15. stuck-money chargebacks name the pharmacy.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/assisted_r10b_fixes_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/assisted/r10b-phase1b-fixes.integration.ts
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

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/assisted_r10b_fixes_check?directConnection=true';
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

    // ───────────────────────── 1. Refunds Razorpay keeps pending ─────────────────────────
    await check('1a: a refund Razorpay keeps pending is polled with back-off for 30+ days, never using up failures, and completes', async () => {
      const b = await paidBooking();
      gateway.refundMode = 'pending';
      const calls0 = gateway.refundCalls;
      try { assert.equal((await expect('P', 'POST', `/pharmacy-assisted/bookings/${b.id}/cancel`, 200, {})).json.data.refund.state, 'pending'); }
      finally { gateway.refundMode = 'processed'; }
      let at = Date.now();
      for (let i = 0; i < 30; i++) {
        const row = await rowOf(b.id);
        at = Math.max(at, new Date(row.nextCheckAt ?? at).getTime()) + 1000;
        await cardRefunds.runCardRefundsDue(new Date(at));
      }
      await cardRefunds.runCardRefundsDue(new Date(Date.now() + 31 * DAY));
      const mid = await rowOf(b.id);
      assert.equal(mid.state, 'pending');
      assert.equal(mid.attempts ?? 0, 0, 'pending lookups are not failures');
      assert.ok(Number(mid.checks) >= 30, `looked up ${mid.checks} times`);
      for (const g of gatewayRefundsFor(b.data)) g.status = 'processed';
      await cardRefunds.runCardRefundsDue(new Date(Date.now() + 32 * DAY));
      assert.equal((await rowOf(b.id)).state, 'processed');
      assert.equal(gateway.refundCalls - calls0, 1, 'sent once');
    });

    await check('1b: admin recheck asks Razorpay now, whatever the back-off', async () => {
      const b = await paidBooking();
      gateway.refundMode = 'pending';
      try { await expect('P', 'POST', `/pharmacy-assisted/bookings/${b.id}/cancel`, 200, {}); } finally { gateway.refundMode = 'processed'; }
      const row = await rowOf(b.id);
      assert.ok(new Date(row.nextCheckAt).getTime() > Date.now(), 'not due yet');
      for (const g of gatewayRefundsFor(b.data)) g.status = 'processed';
      await expect('P', 'POST', `/admin/assisted/card-refunds/${row._id}/recheck`, 403);
      const r = await expect('ADMIN', 'POST', `/admin/assisted/card-refunds/${row._id}/recheck`, 200);
      assert.equal(r.json.data.refund.state, 'processed');
      assert.deepEqual(r.json.data.gateway.map((g: any) => [g.status, g.ours]), [['processed', true]]);
    });

    await check('1c: mark-failed reads Razorpay first (409 while a refund is live there); then to-wallet credits once; stuck money lists old pending refunds', async () => {
      const b = await paidBooking();
      gateway.refundMode = 'pending';
      try { await expect('P', 'POST', `/pharmacy-assisted/bookings/${b.id}/cancel`, 200, {}); } finally { gateway.refundMode = 'processed'; }
      const row = await rowOf(b.id);
      await refundsCol().updateOne({ _id: row._id }, { $set: { createdAt: new Date(Date.now() - 8 * DAY) } });
      const stuck = await expect('ADMIN', 'GET', '/admin/assisted/stuck-money', 200);
      assert.ok(stuck.json.data.cardRefundsPendingOverDays.some((x: any) => x.refundId === String(row._id)), 'listed as stuck');
      await expect('ADMIN', 'POST', `/admin/assisted/card-refunds/${row._id}/mark-failed`, 409, { reason: 'checked' }, 'REFUND_AT_GATEWAY');
      assert.equal((await rowOf(b.id)).state, 'pending');
      // Razorpay has nothing live (the refund vanished: e.g. never created), and the worker gave up (failure cap).
      for (const g of gatewayRefundsFor(b.data)) g.status = 'failed';
      await refundsCol().updateOne({ _id: row._id }, { $set: { attempts: 20 } });
      const before = await balanceOf(P);
      const m = await expect('ADMIN', 'POST', `/admin/assisted/card-refunds/${row._id}/mark-failed`, 200, { reason: 'Razorpay dashboard shows no refund' });
      assert.equal(m.json.data.refund.state, 'failed');
      assert.equal(await AssistedAuditEventModel.countDocuments({ bookingId: b.id, action: 'card_refund.marked_failed' }), 1);
      await expect('ADMIN', 'POST', `/admin/assisted/card-refunds/${row._id}/to-wallet`, 200, { agreement: 'Partner agreed, ticket 9' });
      await expect('ADMIN', 'POST', `/admin/assisted/card-refunds/${row._id}/to-wallet`, 200, { agreement: 'again' });
      assert.equal((await balanceOf(P)).paise - before.paise, 50000, 'credited once');
    });

    // ───────────────────────── 4. to-wallet asks Razorpay ─────────────────────────
    await check('4: to-wallet refuses while Razorpay holds a processed or pending refund of the payment', async () => {
      const b = await paidBooking();
      gateway.refundMode = 'reject';
      try { assert.equal((await expect('P', 'POST', `/pharmacy-assisted/bookings/${b.id}/cancel`, 200, {})).json.data.refund.state, 'failed'); }
      finally { gateway.refundMode = 'processed'; }
      const row = await rowOf(b.id);
      const payId = (gateway.payments[b.data.payment.razorpayOrderId] ?? [])[0]!.id;
      gateway.refunds.push({ id: 'rfnd_manual_' + oid(), paymentId: payId, amount: 50000, status: 'processed', notes: {} });
      const before = await balanceOf(P);
      await expect('ADMIN', 'POST', `/admin/assisted/card-refunds/${row._id}/to-wallet`, 409, { agreement: 'x' }, 'REFUND_AT_GATEWAY');
      assert.deepEqual(await balanceOf(P), before, 'nothing credited');
    });

    // ───────────────────────── 2. Free slot-holding ─────────────────────────
    await check('2a: at most N card bookings of one booker wait for payment at once (also under concurrency)', async () => {
      process.env.ASSISTED_LIMIT_PENDING_CARD_BOOKINGS = '2';
      const Q = await newPharmacy('Cap Medicals', '9700001011');
      try {
        const r = await Promise.all([1, 2, 3, 4].map(async () => call(Q, 'POST', '/pharmacy-assisted/consultations', consult(await futureSlot()))));
        assert.deepEqual(r.map((x) => x.status).sort(), [201, 201, 429, 429], r.map((x) => x.text.slice(0, 120)).join(' | '));
        const refused = r.find((x) => x.status === 429)!;
        assert.equal(refused.json.code, 'ASSISTED_LIMIT_REACHED');
        assert.equal(refused.json.limit, 'pending_card_bookings');
        assert.equal(await BookingModel.countDocuments({ 'assisted.bookedBy.id': Q }), 2, 'no seat held by the refused ones');
        // Paying one frees a place.
        const ok = r.find((x) => x.status === 201)!;
        await expect(Q, 'POST', '/payments/verify', 200, capture(ok.json.data));
        await expect(Q, 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
      } finally { delete process.env.ASSISTED_LIMIT_PENDING_CARD_BOOKINGS; }
    });

    await check('2b: an unpaid card booking left to expire counts toward the booker\'s daily cancellation limit', async () => {
      process.env.ASSISTED_LIMIT_BOOKER_CANCELLATIONS_PER_DAY = '1';
      const Q = await newPharmacy('Expire Medicals', '9700001012');
      try {
        const r = await expect(Q, 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot()));
        await BookingModel.collection.updateOne({ _id: new Types.ObjectId(r.json.data.booking._id) }, { $set: { createdAt: new Date(Date.now() - 40 * MIN) } });
        await expire();
        assert.equal((await bookingOf(r.json.data.booking._id)).status, 'cancelled');
        const again = await call(Q, 'POST', '/pharmacy-assisted/consultations', consult(await futureSlot()));
        assert.equal(again.status, 429, again.text.slice(0, 200));
        assert.equal(again.json.limit, 'booker_cancellations');
      } finally { delete process.env.ASSISTED_LIMIT_BOOKER_CANCELLATIONS_PER_DAY; }
    });

    // ───────────────────────── 3. Never-paid card bookings stay the booker's ─────────────────────────
    await check('3: patients and doctors never see a card booking that was never paid (pending or expired); once paid they do, with "Paid by"', async () => {
      const pending = await book();
      const expired = await book();
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(expired.id) }, { $set: { createdAt: new Date(Date.now() - 40 * MIN) } });
      await bookingService.expireUnpaidBookings(new Date(), 1000); // now: only the one made old expires
      assert.equal((await bookingOf(expired.id)).status, 'cancelled');
      for (const id of [pending.id, expired.id]) {
        const list = await expect('X', 'GET', '/bookings?page=1&limit=100', 200);
        assert.ok(!list.json.data.some((r: any) => String(r._id) === id), 'not in the patient list');
        assert.ok(!(await expect('X', 'GET', `/bookings/user/${X}`, 200)).json.data.some((r: any) => String(r._id) === id));
        await expect('X', 'GET', `/bookings/${id}`, 404);
        await expect('D', 'GET', `/bookings/${id}`, 404);
        assert.ok(!(await expect('D', 'GET', '/bookings?page=1&limit=100', 200)).json.data.some((r: any) => String(r._id) === id), 'not in the doctor list');
        assert.ok(!(await portal.listAppointments(D, { view: 'all', page: 1, limit: 100 } as never)).data.some((r: any) => String(r._id) === id));
        await assert.rejects(portal.getAppointmentById(D, id), /not found/i);
        assert.ok(!(await portal.getPatientHistory(D, X).catch(() => [] as any)).toString().includes(id));
      }
      await expect('X', 'PUT', `/bookings/${pending.id}`, 404, { notes: 'hello' });
      await expect('X', 'POST', `/bookings/${pending.id}/not-mine`, 404, {});
      await expect('X', 'POST', `/bookings/${pending.id}/cancel`, 404, { reason: 'x' });
      assert.equal((await bookingOf(pending.id)).status, 'pending', 'the patient could not cancel it');
      // Paid: now the patient's and the doctor's.
      await expect('P', 'POST', '/payments/verify', 200, capture(pending.data));
      const seen = await expect('X', 'GET', `/bookings/${pending.id}`, 200);
      assert.equal(seen.json.data.paidBy, 'Rten Medicals');
      await expect('D', 'GET', `/bookings/${pending.id}`, 200);
      assert.ok((await portal.listAppointments(D, { view: 'all', page: 1, limit: 100 } as never)).data.some((r: any) => String(r._id) === pending.id));
    });

    // ───────────────────────── 5. Follow-up after a crash ─────────────────────────
    await check('5: a confirmation whose follow-up was cut short (record still unprocessed) is finished by the sweep, never refunded', async () => {
      const b = await book();
      const v = capture(b.data);
      const rid = v.paymentTransactionId;
      const at = new Date().toISOString();
      // The state a crash right after the confirming transaction leaves.
      await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(rid) }, { $set: { status: 'paid', razorpayPaymentId: v.razorpayPaymentId, isProcessed: false,
        paidAt: new Date(), createdAt: new Date(Date.now() - 20 * MIN) } });
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(b.id) }, { $set: { status: 'confirmed', paymentStatus: 'paid', paymentTransactionId: rid,
        'assisted.funding.state': 'captured', 'lifecycle.paid': { at, by: 'pharmacy_card', amount: 500 }, 'lifecycle.confirmed': { at } } });
      notices.length = 0;
      await sweep();
      const after = await bookingOf(b.id);
      assert.equal(after.status, 'confirmed');
      assert.equal((await refundsOf(b.id)).length, 0, 'not refunded');
      assert.equal(after.postPaymentCompletedFor, rid, 'follow-up finished');
      assert.deepEqual([...new Set(notices.map((x) => x.key))].sort(), [`assisted:${b.id}:booked:customer`, `assisted:${b.id}:booked:doctor`]);
      const rec = await PaymentRecordModel.findById(rid).lean() as any;
      assert.deepEqual([rec.status, rec.isProcessed], ['paid', true]);
      // A normal verify: the record is processed only after the follow-up (one confirmation).
      const n = await paidBooking();
      const rec2 = await PaymentRecordModel.findById(n.data.payment.paymentTransactionId).lean() as any;
      assert.equal(rec2.isProcessed, true);
      assert.equal((await bookingOf(n.id)).postPaymentCompletedFor, n.data.payment.paymentTransactionId);
      assert.equal(await AssistedAuditEventModel.countDocuments({ bookingId: n.id, action: 'booking.paid' }), 1);
    });

    // ───────────────────────── 6. Chargeback on an unpaid record ─────────────────────────
    await check('6: a card dispute cannot be recorded on a payment never captured (409 PAYMENT_NOT_CAPTURED)', async () => {
      const b = await book();
      await expect('ADMIN', 'POST', `/admin/assisted-payments/${b.data.payment.paymentTransactionId}/chargeback`, 409, { reason: 'x' }, 'PAYMENT_NOT_CAPTURED');
      assert.equal((await PaymentRecordModel.findById(b.data.payment.paymentTransactionId).lean() as any).chargebackAt, undefined);
    });

    // ───────────────────────── 7. Bad signature ─────────────────────────
    await check('7: a bad signature does not close an assisted card order: the real payment still confirms it', async () => {
      const b = await book();
      const v = capture(b.data);
      await expect('P', 'POST', '/payments/verify', 400, { ...v, razorpaySignature: 'f'.repeat(64) }, 'PAYMENT_SIGNATURE_INVALID');
      assert.equal((await PaymentRecordModel.findById(v.paymentTransactionId).lean() as any).status, 'created');
      await expect('P', 'POST', '/payments/verify', 200, v);
      assert.equal((await bookingOf(b.id)).status, 'confirmed');
    });

    await check('7 guard: other contexts still close the record on a bad signature (pharmacy top-up)', async () => {
      const id = oid();
      await PaymentRecordModel.collection.insertOne({ _id: new Types.ObjectId(id), userId: P, payerUserId: P, payerPharmacyId: P, context: 'wallet_recharge',
        contextId: `pharmacy_${P}_1`, baseAmount: 100, discountAmount: 0, finalAmount: 100, finalAmountPaise: 10000, currency: 'INR', paymentGateway: 'razorpay',
        razorpayOrderId: 'order_r10b_top_' + oid(), status: 'created', isProcessed: false, notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: P } } as never);
      const rec = await PaymentRecordModel.findById(id).lean() as any;
      await expect('P', 'POST', '/payments/verify', 400, { paymentTransactionId: id, razorpayOrderId: rec.razorpayOrderId, razorpayPaymentId: 'pay_x1',
        razorpaySignature: 'f'.repeat(64) }, 'PAYMENT_SIGNATURE_INVALID');
      assert.equal((await PaymentRecordModel.findById(id).lean() as any).status, 'failed');
    });

    // ───────────────────────── 8. Disputed payment wording; stuck money ─────────────────────────
    await check('8: a disputed assisted payment answers PAYMENT_DISPUTED (not top-up wording) and is listed in stuck money', async () => {
      const b = await book();
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(b.id) }, { $set: { createdAt: new Date(Date.now() - 40 * MIN) } });
      await expire();
      const v = capture(b.data);
      assert.equal((await expect('P', 'POST', '/payments/verify', 200, v)).json.data.paymentRecord.status, 'refunded');
      await expect('ADMIN', 'POST', `/admin/assisted-payments/${v.paymentTransactionId}/chargeback`, 200, { reason: 'dispute' });
      const r = await expect('P', 'POST', '/payments/reconcile', 409, { paymentTransactionId: v.paymentTransactionId }, 'PAYMENT_DISPUTED');
      assert.ok(!/top-up/i.test(r.json.message), r.json.message);
      const stuck = await expect('ADMIN', 'GET', '/admin/assisted/stuck-money', 200);
      assert.ok(stuck.json.data.cardChargebacks.some((x: any) => x.paymentRecordId === v.paymentTransactionId));
    });
    // ───────────────────────── r10c: read-only additions for the web ─────────────────────────
    await check('9 (r10c): the booker view carries `payment` (method, state, payBy, paymentTransactionId) for its own booker only; patients and doctors never', async () => {
      const b = await book();
      const rid = b.data.payment.paymentTransactionId;
      const own = await expect('P', 'GET', `/pharmacy-bookings/${b.id}`, 200);
      assert.equal(own.json.data.payment.method, 'razorpay');
      assert.equal(own.json.data.payment.state, 'pending');
      assert.equal(own.json.data.payment.paymentTransactionId, rid);
      assert.ok(Math.abs(Date.parse(own.json.data.payment.payBy) - (Date.parse(own.json.data.createdAt) + 30 * MIN)) < 1000);
      const listed = (await expect('P', 'GET', '/pharmacy-bookings?limit=50', 200)).json.data.find((r: any) => String(r._id) === b.id);
      assert.equal(listed.payment.paymentTransactionId, rid);
      assert.equal((await expect('P', 'GET', `/bookings/${b.id}`, 200)).json.data.payment.paymentTransactionId, rid, 'the generic read gives the same');
      // Another pharmacy's view of it (if it ever got one) carries nothing about the payment.
      const { bookerView } = await import('@/modules/assisted/bookerView');
      assert.equal((await bookerView(await bookingOf(b.id), P2)).payment, undefined);
      await expect('P', 'POST', '/payments/verify', 200, capture(b.data));
      const paid = (await expect('P', 'GET', `/pharmacy-bookings/${b.id}`, 200)).json.data.payment;
      assert.deepEqual(paid, { method: 'razorpay', state: 'captured', payBy: null, paymentTransactionId: rid });
      for (const who of ['X', 'D']) {
        const r = await expect(who, 'GET', `/bookings/${b.id}`, 200);
        assert.equal(r.json.data.payment, undefined, `${who} sees no payment`);
        assert.ok(!JSON.stringify(r.json.data).includes(rid), `${who} sees no payment id`);
      }
      // A wallet booking: method wallet, no card fields.
      await call('ADMIN', 'POST', '/pharmacy-wallet/topup', { pharmacyId: P, amount: 1000 }, { 'idempotency-key': 'r10c-topup-' + oid().slice(-8) });
      const w = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, consult(await futureSlot(), { paymentMethod: 'wallet' }));
      assert.deepEqual((await expect('P', 'GET', `/pharmacy-bookings/${w.json.data.booking._id}`, 200)).json.data.payment,
        { method: 'wallet', state: 'captured', payBy: null });
    });

    await check('10 (r10c): admin card-refund rows name the paying pharmacy (id and name); the pharmacy\'s own answer does not', async () => {
      const b = await paidBooking();
      gateway.refundMode = 'reject';
      let own: any;
      try { own = (await expect('P', 'POST', `/pharmacy-assisted/bookings/${b.id}/cancel`, 200, {})).json.data.refund; }
      finally { gateway.refundMode = 'processed'; }
      assert.equal(own.pharmacyName, undefined);
      const item = (await expect('ADMIN', 'GET', '/admin/assisted/card-refunds', 200)).json.data.find((x: any) => x.bookingId === b.id);
      assert.deepEqual([item.pharmacyId, item.pharmacyName], [P, 'Rten Medicals']);
      const stuck = (await expect('ADMIN', 'GET', '/admin/assisted/stuck-money', 200)).json.data.refundRowsPending.find((x: any) => x.bookingId === b.id);
      assert.equal(stuck.pharmacyName, 'Rten Medicals');
    });
    // ───────────────────────── r10d ─────────────────────────
    await check('11 (r10d): the clinic workspace neither lists nor bills a card booking never paid; once paid it does', async () => {
      const CL = oid(); const BR = oid();
      await PartnerOrgModel.collection.insertOne({ _id: new Types.ObjectId(CL), kind: 'clinic', name: 'City Clinic', isActive: true } as never);
      await BranchModel.collection.insertOne({ _id: new Types.ObjectId(BR), partnerId: CL, name: 'Main', isActive: true,
        address: { line1: 'x', city: 'Shillong', state: 'Meghalaya', stateCode: '17', pincode: '793001' } } as never);
      const actor = { memberId: 'admin:' + ADMIN, partnerId: CL, role: 'owner', permissions: [], branchIds: [], actorKind: 'admin' } as never;
      const b = await book();
      // An online in-clinic visit at this clinic (as reserveSlot records it for a branch slot).
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(b.id) }, { $set: { clinicVisit: { partnerId: CL, branchId: BR } } });
      const day = (await bookingOf(b.id)).bookingDate as string;
      const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
      const listed = async () => (await listClinicAppointments(actor, { from: iso, to: iso })).some((r: any) => String(r._id ?? r.bookingId) === b.id);
      assert.equal(await listed(), false, 'not listed while unpaid');
      const invoices = new InvoiceService(new InvoiceRepository(), new InvoiceEventRepository(), new InvoiceCounterRepository(), new PartnerRepository(),
        new BranchRepository(), new CatalogueItemRepository(), {} as never);
      const bill = () => invoices.createInvoice(actor, { branchId: BR, customer: { name: 'Rina Das', phone: '9600001001' }, items: [], appointmentId: b.id,
        idempotencyKey: 'r10d-bill-' + oid().slice(-8) } as never);
      await assert.rejects(bill(), (e: any) => e?.code === 'APPOINTMENT_NOT_FOUND');
      await expect('P', 'POST', '/payments/verify', 200, capture(b.data));
      assert.equal(await listed(), true, 'listed once paid');
      await assert.rejects(bill(), (e: any) => e?.code !== 'APPOINTMENT_NOT_FOUND' || assert.fail('still hidden from billing'));
    });

    await check('12 (r10d): verify ×2, reconcile and the sweep racing (slow Meet) create ONE Meet event', async () => {
      let meets = 0;
      support.setAssistedEffects({ meet: async (b: any) => { meets += 1; await new Promise((r) => setTimeout(r, 300)); return b; }, cancelMeet: async (b: any) => b,
        reminders: async () => undefined, clearReminders: async () => undefined } as never);
      try {
        for (let i = 0; i < 3; i++) {
          meets = 0;
          const b = await book();
          const v = capture(b.data);
          await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(v.paymentTransactionId) }, { $set: { createdAt: new Date(Date.now() - 20 * MIN) } });
          await Promise.allSettled([call('P', 'POST', '/payments/verify', v), call('P', 'POST', '/payments/verify', v),
            call('P', 'POST', '/payments/reconcile', { paymentTransactionId: v.paymentTransactionId }), sweep()]);
          assert.equal(meets, 1, `run ${i}: ${meets} Meet events`);
          const after = await bookingOf(b.id);
          assert.equal(after.postPaymentCompletedFor, v.paymentTransactionId);
          assert.equal(after.assisted.followUpLeaseUntil, undefined, 'lease released');
          assert.equal((await PaymentRecordModel.findById(v.paymentTransactionId).lean() as any).isProcessed, true);
        }
      } finally {
        support.setAssistedEffects({ meet: async (b: any) => b, cancelMeet: async (b: any) => b, reminders: async () => undefined, clearReminders: async () => undefined } as never);
      }
    });

    await check('13 (r10d): while a card booking waits, its booker view carries the open order (razorpayOrderId, razorpayKeyId)', async () => {
      const b = await book();
      const p = (await expect('P', 'GET', `/pharmacy-bookings/${b.id}`, 200)).json.data.payment;
      assert.deepEqual([p.razorpayOrderId, p.razorpayKeyId, p.paymentTransactionId], [b.data.payment.razorpayOrderId, 'rzp_test_key', b.data.payment.paymentTransactionId]);
      const listed = (await expect('P', 'GET', '/pharmacy-bookings?limit=50', 200)).json.data.find((r: any) => String(r._id) === b.id);
      assert.equal(listed.payment.razorpayOrderId, b.data.payment.razorpayOrderId);
      await expect('P', 'POST', '/payments/verify', 200, capture(b.data));
      const paid = (await expect('P', 'GET', `/pharmacy-bookings/${b.id}`, 200)).json.data.payment;
      assert.equal('razorpayOrderId' in paid, false, 'no order once paid');
      for (const who of ['X', 'D']) assert.ok(!JSON.stringify((await expect(who, 'GET', `/bookings/${b.id}`, 200)).json.data).includes(b.data.payment.razorpayOrderId));
    });

    await check('14 (r10d): an admin move of an unpaid card booking tells only the booker (the holders never saw it)', async () => {
      const b = await book();
      notices.length = 0;
      await expect('ADMIN', 'POST', `/admin/assisted-bookings/${b.id}/move`, 200, { toPhone: '9600001077', reason: 'wrong number', requestKey: 'r10d-move-' + oid().slice(-8) });
      assert.deepEqual(notices.map((n) => n.audience), ['booker']);
    });

    await check('15 (r10d): stuck-money chargebacks name the paying pharmacy', async () => {
      const b = await paidBooking();
      await expect('ADMIN', 'POST', `/admin/assisted-payments/${b.data.payment.paymentTransactionId}/chargeback`, 200, { reason: 'dispute' });
      const row = (await expect('ADMIN', 'GET', '/admin/assisted/stuck-money', 200)).json.data.cardChargebacks
        .find((x: any) => x.paymentRecordId === b.data.payment.paymentTransactionId);
      assert.deepEqual([row.pharmacyId, row.pharmacyName], [P, 'Rten Medicals']);
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) { console.log('Failed:', failed.join('; ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
