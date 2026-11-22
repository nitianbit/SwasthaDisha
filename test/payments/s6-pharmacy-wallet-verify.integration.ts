/**
 * S6: the released pharmacy app verifies a wallet top-up with `{ ...payload, module: 'pharmacy-wallet' }`
 * (pharmacy-app/src/api/pharmacyWalletService.ts). The validator only allowed 'external-bookings', so Razorpay captured
 * the money and nothing was credited. Fix: the value is accepted, and what a verify credits is decided from the stored
 * payment record only (its context / payer / flow), never from the client's `module`.
 *
 * Through the real POST /api/v1/payments/verify router (validation, authenticate, controller) and the real
 * PaymentService paths on a MongoDB replica set. Razorpay is a fake (payments.fetch / orders.fetchPayments / orders.create)
 * as in the W3b and A2b suites; the external provider call and e-mails are fakes.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/s6_pharmacy_wallet_verify?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/payments/s6-pharmacy-wallet-verify.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import '@/modules/user/model';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import ExternalBookingModel from '@/modules/externalBookings/model';
import { ExternalBookingRepository } from '@/modules/externalBookings/repository';
import { recordProviderResult } from '@/modules/externalBookings/services/providerOps';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacyWalletModel, PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { PharmacyWalletRepository, PharmacyWalletTransactionRepository } from '@/modules/pharmacyWallet/repository';
import { PharmacyWalletService } from '@/modules/pharmacyWallet/services';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { auditS6UncreditedWalletTopups, disputesReaderFor, orderPaymentsReaderFor } from '@/scripts/auditS6UncreditedWalletTopups';
import { creditS6WalletTopup, exitCodeOf } from '@/scripts/creditS6WalletTopup';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/s6_pharmacy_wallet_verify?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const SECRET = 'secret';
type GatewayPayment = { id: string; order_id: string; amount: number; currency: string; status: string; amount_refunded?: number };
/** What Razorpay holds: payments by id and by order. */
const gatewayPayments = new Map<string, GatewayPayment>();
let createdOrders = 0;
/** Razorpay's disputes (GET /disputes). */
const gatewayDisputes: { id: string; payment_id: string; status: string; amount: number }[] = [];
const fakeRazorpay = {
  orders: {
    create: async (o: { amount: number; currency: string }) => {
      createdOrders += 1;
      return { id: 'order_s6_' + createdOrders + '_' + new Types.ObjectId().toHexString(), amount: o.amount, currency: o.currency, status: 'created' };
    },
    fetchPayments: async (orderId: string) => ({ items: [...gatewayPayments.values()].filter((p) => p.order_id === orderId) }),
  },
  disputes: {
    all: async ({ count, skip }: { count: number; skip: number }) => ({ items: gatewayDisputes.slice(skip, skip + count) }),
  },
  payments: {
    fetch: async (id: string) => {
      const p = gatewayPayments.get(id);
      if (!p) throw new Error('no such payment');
      return p;
    },
  },
};
const providerCalls: string[] = [];
const emails = { booking: 0, external: 0 };
const payments = Object.assign(Object.create(PaymentService.prototype), {
  paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(), walletTransactionRepository: new WalletTransactionRepository(),
  pharmacyWalletRepository: new PharmacyWalletRepository(), pharmacyWalletTransactionRepository: new PharmacyWalletTransactionRepository(),
  bookingRepository: new BookingRepository(), externalBookingRepository: new ExternalBookingRepository(), pharmacyOrderRepository: new PharmacyOrderRepository(),
  bookingReminderScheduler: { scheduleBookingReminders: async () => undefined },
  sendPaidBookingEmailNotification: async () => { emails.booking++; },
  sendExternalBookingEmailNotification: async () => { emails.external++; },
  // The provider booking for an admitted external attempt (as in the A2b suite): confirmed with a reference.
  finalizeExternalBookingPayment: async (r: { _id: unknown; contextId: string }, token: string) => {
    providerCalls.push(String(r.contextId));
    return (await recordProviderResult(r.contextId, token, { status: 'confirmed', externalBookingId: 'prov_' + String(r._id) })).booking;
  },
  getRazorpayClient: () => fakeRazorpay,
  getRazorpayCredentials: () => ({ keyId: 'rzp_test_key', keySecret: SECRET }),
}) as unknown as PaymentService & Record<string, unknown>;
const pharmacyWallets = new (PharmacyWalletService as unknown as new (...a: unknown[]) => PharmacyWalletService)(
  new PharmacyWalletRepository(), new PharmacyWalletTransactionRepository(), new BookingRepository(), {}, payments);

/** Razorpay Checkout's success: the gateway captured the order; the app gets the signed ids. */
function checkout(orderId: string, amountPaise: number) {
  const id = 'pay_' + new Types.ObjectId().toHexString();
  gatewayPayments.set(id, { id, order_id: orderId, amount: amountPaise, currency: 'INR', status: 'captured' });
  const signature = crypto.createHmac('sha256', SECRET).update(`${orderId}|${id}`).digest('hex');
  return { razorpayOrderId: orderId, razorpayPaymentId: id, razorpaySignature: signature };
}

async function pharmacy() {
  const pharmacyId = new Types.ObjectId().toHexString();
  // Stage merge (assisted phase 0/1a review): /payments/verify and /reconcile of a BOOKING payment need an operational
  // pharmacy (its answer carries the booker view), so each test pharmacy is a real active, verified one.
  await mongoose.connection.collection('pharmacies').insertOne({ _id: new Types.ObjectId(pharmacyId), name: 'S6 pharmacy ' + pharmacyId.slice(-4),
    phone: '97' + String(Date.now()).slice(-8), isActive: true, isVerified: true } as never);
  return { pharmacyId, userId: new Types.ObjectId().toHexString() };
}
async function customer() {
  const user = new Types.ObjectId().toHexString();
  await WalletModel.create({ userId: user, balance: 0, isActive: true });
  await mongoose.connection.collection('users').insertOne({ _id: new Types.ObjectId(user), userType: 'user', phone: String(Date.now()).slice(-10) } as never);
  return user;
}
const pharmacyToken = (p: { pharmacyId: string; userId: string }) =>
  jwt.sign({ _id: p.userId, userType: 'pharmacy', pharmacyId: p.pharmacyId }, CONFIG.JWT_SECRET_KEY);
const customerToken = (u: string) => jwt.sign({ _id: u, userType: 'user' }, CONFIG.JWT_SECRET_KEY);

/** POST /pharmacy-wallet/topup as the pharmacy (real PharmacyWalletService.initiateTopupPayment). */
async function topup(p: { pharmacyId: string; userId: string }, amount: number) {
  const r = await pharmacyWallets.initiateTopupPayment(p.pharmacyId, p.userId, { amount } as never);
  return { record: String(r.paymentTransactionId), ...checkout(r.razorpayOrderId, Math.round(amount * 100)) };
}
const pharmacyBalancePaise = async (pharmacyId: string) => Number((await PharmacyWalletModel.findOne({ pharmacyId }).lean())?.balancePaise ?? 0);
const pharmacyCredits = (pharmacyId: string) => PharmacyWalletTransactionModel.countDocuments({ pharmacyId, transactionType: 'credit' });
const customerBalance = async (u: string) => Number((await WalletModel.findOne({ userId: u }).lean())?.balance ?? 0);
const record = async (id: string) => (await PaymentRecordModel.findById(id).lean())!;

const gatewayReader = orderPaymentsReaderFor(fakeRazorpay);
const disputesReader = disputesReaderFor(fakeRazorpay);
/** Fixtures handed from the audit check to the credit-script check. */
const shared: Record<string, unknown> = {};

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(url);
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await Promise.all([PaymentRecordModel.init(), WalletModel.init(), WalletTransactionModel.init(), PharmacyWalletModel.init(),
    PharmacyWalletTransactionModel.init(), BookingModel.init(), ExternalBookingModel.init()]);

  Container.set(PaymentService, payments as unknown as PaymentService);
  const { default: router } = await import('@/modules/payment/routes');
  const { authenticate } = await import('@/modules/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/payments', authenticate, router);
  app.use((err: { status?: number; code?: string; message?: string }, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(err.status ?? 500).json({ code: err.code, message: err.message });
  });
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const post = async (path: 'verify' | 'reconcile', token: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/payments/${path}`, { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token } });
    return { status: res.status, body: await res.json() as { message?: string; code?: string; data?: { context?: string; state?: string } } };
  };
  /** Exactly what the released pharmacy app sends (pharmacyWalletService.verifyTopup). */
  const appVerifyTopup = (token: string, payload: { paymentTransactionId: string; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }) =>
    post('verify', token, { ...payload, module: 'pharmacy-wallet' });
  const payloadOf = (t: { record: string; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }) =>
    ({ paymentTransactionId: t.record, razorpayOrderId: t.razorpayOrderId, razorpayPaymentId: t.razorpayPaymentId, razorpaySignature: t.razorpaySignature });

  try {
    await check("the app's exact top-up verify (module 'pharmacy-wallet') credits the pharmacy wallet once", async () => {
      const ph = await pharmacy();
      const t = await topup(ph, 500);
      const res = await appVerifyTopup(pharmacyToken(ph), payloadOf(t));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data?.context, 'wallet_recharge');
      assert.equal(res.body.message, 'Payment verified successfully');
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 50000);
      assert.equal(await pharmacyCredits(ph.pharmacyId), 1);
      const rec = await record(t.record);
      assert.equal(rec.status, 'paid'); assert.equal(rec.isProcessed, true); assert.equal(rec.razorpayPaymentId, t.razorpayPaymentId);
      assert.equal(await WalletModel.countDocuments({ userId: ph.userId }), 0, 'no customer wallet is credited for the pharmacy user');
    });

    await check('replays (same verify again, concurrent verifies, reconcile afterwards) never credit twice', async () => {
      const ph = await pharmacy();
      const t = await topup(ph, 250);
      const [a, b] = await Promise.all([appVerifyTopup(pharmacyToken(ph), payloadOf(t)), appVerifyTopup(pharmacyToken(ph), payloadOf(t))]);
      assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(b.status, 200, JSON.stringify(b.body));
      const again = await appVerifyTopup(pharmacyToken(ph), payloadOf(t));
      assert.equal(again.status, 200, JSON.stringify(again.body)); assert.equal(again.body.data?.context, 'wallet_recharge');
      const withoutModule = await post('verify', pharmacyToken(ph), payloadOf(t));
      assert.equal(withoutModule.status, 200);
      const rec = await post('reconcile', pharmacyToken(ph), { paymentTransactionId: t.record });
      assert.equal(rec.status, 200); assert.equal(rec.body.data?.state, 'paid');
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 25000, 'credited exactly once');
      assert.equal(await pharmacyCredits(ph.pharmacyId), 1);
    });

    await check("another pharmacy cannot verify the top-up, with or without 'pharmacy-wallet'; nothing is credited", async () => {
      const ph = await pharmacy();
      const other = await pharmacy();
      const t = await topup(ph, 100);
      assert.equal((await appVerifyTopup(pharmacyToken(other), payloadOf(t))).status, 404);
      assert.equal((await post('verify', pharmacyToken(other), payloadOf(t))).status, 404);
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 0);
      assert.equal(await pharmacyBalancePaise(other.pharmacyId), 0);
      assert.equal((await record(t.record)).status, 'created', 'left for its owner');
    });

    await check("cross-purpose module: 'external-bookings' on a pharmacy top-up still credits the pharmacy wallet once", async () => {
      const ph = await pharmacy();
      const t = await topup(ph, 300);
      const res = await post('verify', pharmacyToken(ph), { ...payloadOf(t), module: 'external-bookings' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data?.context, 'wallet_recharge');
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 30000);
      assert.equal(providerCalls.length, 0, 'no external booking work');
    });

    await check("cross-purpose module: 'pharmacy-wallet' on a booking the pharmacy pays for confirms the booking and credits no wallet", async () => {
      const ph = await pharmacy();
      const orderId = 'order_bk_' + new Types.ObjectId().toHexString();
      const p0 = await PaymentRecordModel.create({ userId: ph.userId, payerUserId: ph.userId, payerPharmacyId: ph.pharmacyId, context: 'booking',
        contextId: 'x', baseAmount: 400, discountAmount: 0, finalAmount: 400, baseAmountPaise: 40000, discountAmountPaise: 0, finalAmountPaise: 40000,
        currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: orderId, status: 'created', notes: { walletDeductedAmount: 0 } });
      const { insertedId } = await BookingModel.collection.insertOne({ userId: ph.userId, pharmacyId: ph.pharmacyId, bookingType: 'consultation',
        status: 'pending', paymentStatus: 'pending', price: 400, paymentTransactionId: String(p0._id) } as never);
      await PaymentRecordModel.updateOne({ _id: p0._id }, { $set: { contextId: insertedId.toHexString() } });
      const pay = checkout(orderId, 40000);
      const res = await post('verify', pharmacyToken(ph), { paymentTransactionId: String(p0._id), ...pay, module: 'pharmacy-wallet' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data?.context, 'booking');
      const bk = (await BookingModel.findById(insertedId).lean())!;
      assert.equal(bk.paymentStatus, 'paid'); assert.equal(bk.status, 'confirmed');
      assert.equal(await PharmacyWalletModel.countDocuments({ pharmacyId: ph.pharmacyId }), 0, 'no pharmacy wallet credit');
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: ph.pharmacyId }), 0);
      assert.equal(await customerBalance(ph.userId), 0, 'nothing returned to any wallet');
      assert.equal(emails.booking, 1);
      // Replayed with the other module value: still the same booking outcome, nothing more.
      const replay = await post('verify', pharmacyToken(ph), { paymentTransactionId: String(p0._id), ...pay, module: 'external-bookings' });
      assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(replay.body.data?.context, 'booking');
      assert.equal(emails.booking, 1);
    });

    await check("cross-purpose module: 'external-bookings' on a booking payment is applied to that booking, not to an external booking", async () => {
      const u = await customer();
      const orderId = 'order_bk_' + new Types.ObjectId().toHexString();
      const p0 = await PaymentRecordModel.create({ userId: u, context: 'booking', contextId: 'x', baseAmount: 100, discountAmount: 0, finalAmount: 100,
        currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: orderId, status: 'created', notes: { walletDeductedAmount: 0 } });
      const { insertedId } = await BookingModel.collection.insertOne({ userId: u, bookingType: 'consultation', status: 'pending', paymentStatus: 'pending',
        price: 100, paymentTransactionId: String(p0._id) } as never);
      await PaymentRecordModel.updateOne({ _id: p0._id }, { $set: { contextId: insertedId.toHexString() } });
      const res = await post('verify', customerToken(u), { paymentTransactionId: String(p0._id), ...checkout(orderId, 10000), module: 'external-bookings' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data?.context, 'booking');
      assert.equal((await BookingModel.findById(insertedId).lean())!.paymentStatus, 'paid');
      assert.equal((await record(String(p0._id))).isProcessed, true);
      assert.equal(providerCalls.length, 0);
    });

    await check("cross-purpose module: 'pharmacy-wallet' on a customer's own wallet recharge credits that customer, never a pharmacy", async () => {
      const u = await customer();
      const order = await payments.createOrder({ userId: u, context: 'wallet_recharge', contextId: 'wr_' + u, baseAmount: 200, finalAmount: 200 });
      const pay = checkout(order.razorpayOrder.id, 20000);
      const res = await post('verify', customerToken(u), { paymentTransactionId: String(order.paymentRecord._id), ...pay, module: 'pharmacy-wallet' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data?.context, 'wallet_recharge');
      assert.equal(await customerBalance(u), 200);
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ referenceId: String(order.paymentRecord._id) }), 0, 'no pharmacy credit');
      await post('verify', customerToken(u), { paymentTransactionId: String(order.paymentRecord._id), ...pay, module: 'pharmacy-wallet' });
      assert.equal(await customerBalance(u), 200, 'once');
    });

    await check("external bookings still work with module 'external-bookings' (and are not changed by 'pharmacy-wallet')", async () => {
      for (const module of ['external-bookings', 'pharmacy-wallet']) {
        const u = await customer();
        const { insertedId } = await ExternalBookingModel.collection.insertOne({ userId: u, integration: 'labstack', providerType: 'DIAGNOSTICS',
          appointmentType: 'home', status: 'pending_payment', paymentStatus: 'pending', price: 100, bookingDate: '20991231', bookingTime: '10:00', meta: {} } as never);
        const id = insertedId.toHexString();
        const orderId = 'ord_' + id;
        const p0 = await PaymentRecordModel.create({ userId: u, context: 'external_booking', contextId: id, baseAmount: 100, discountAmount: 0,
          finalAmount: 100, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: orderId, status: 'created' });
        await ExternalBookingModel.updateOne({ _id: id }, { $set: { paymentTransactionId: String(p0._id) } });
        const calls = providerCalls.length;
        const pay = checkout(orderId, 10000);
        const res = await post('verify', customerToken(u), { paymentTransactionId: String(p0._id), ...pay, module });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data?.context, 'external_booking');
        const eb = (await ExternalBookingModel.findById(id).lean())! as unknown as { paymentStatus: string; status: string; externalBookingId?: string };
        assert.equal(eb.paymentStatus, 'paid'); assert.equal(eb.status, 'confirmed'); assert.equal(eb.externalBookingId, 'prov_' + String(p0._id));
        assert.equal(providerCalls.length, calls + 1, 'provider booked once');
        assert.equal((await record(String(p0._id))).isProcessed, true);
        const replay = await post('verify', customerToken(u), { paymentTransactionId: String(p0._id), ...pay, module });
        assert.equal(replay.status, 200); assert.equal(providerCalls.length, calls + 1, 'replay books nothing');
        assert.equal(await customerBalance(u), 0, 'nothing returned to the wallet');
      }
    });

    await check('an unknown module value is still refused before anything is read or written', async () => {
      const ph = await pharmacy();
      const t = await topup(ph, 100);
      const res = await post('verify', pharmacyToken(ph), { ...payloadOf(t), module: 'wallet' });
      assert.equal(res.status, 400);
      assert.equal((await record(t.record)).status, 'created');
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 0);
    });
    await check("the S6 audit lists a captured but uncredited top-up (read only) and drops it once the pharmacy's reconcile credits it", async () => {
      const ph = await pharmacy();
      const stuck = await topup(ph, 700); // Razorpay captured it; the verify never got through (the pre-S6 state)
      const abandoned = await pharmacy().then((p) => pharmacyWallets.initiateTopupPayment(p.pharmacyId, p.userId, { amount: 50 } as never));
      const done = await topup(ph, 20);
      assert.equal((await appVerifyTopup(pharmacyToken(ph), payloadOf(done))).status, 200);
      const before = await Promise.all([PaymentRecordModel.countDocuments(), PharmacyWalletTransactionModel.countDocuments(), PharmacyWalletModel.countDocuments()]);
      const report = await auditS6UncreditedWalletTopups(gatewayReader, disputesReader);
      assert.deepEqual(await Promise.all([PaymentRecordModel.countDocuments(), PharmacyWalletTransactionModel.countDocuments(), PharmacyWalletModel.countDocuments()]),
        before, 'the audit writes nothing');
      const row = (id: string) => report.rows.find((r) => r.paymentTransactionId === id);
      const s = row(stuck.record)!;
      assert.equal(s.finding, 'unsettled'); assert.equal(s.status, 'created'); assert.equal(s.amount, 700); assert.equal(s.pharmacyId, ph.pharmacyId);
      assert.deepEqual(s.gateway, { checked: true, statuses: ['captured'], capturedPaymentId: stuck.razorpayPaymentId, capturedAmount: 700, amountMatches: true, amountRefunded: 0,
        capturedRefunded: 0, otherRefunded: 0 });
      assert.deepEqual(s.disputes, []);
      assert.deepEqual(s.adminTopupsSince, { count: 0, amount: 0 }); assert.equal(s.needsCompensationCheck, false);
      const a = row(String(abandoned.paymentTransactionId))!;
      assert.equal(a.finding, 'unsettled');
      assert.deepEqual(a.gateway, { checked: true, statuses: [], capturedPaymentId: null, capturedAmount: null, amountMatches: null, amountRefunded: 0,
        capturedRefunded: 0, otherRefunded: 0 });
      assert.equal(row(done.record), undefined, 'a credited top-up is not listed');
      assert.deepEqual(Object.keys(s).sort(), ['adminTopupsSince', 'amount', 'createdAt', 'creditTransactionId', 'disputes', 'finding', 'gateway', 'isProcessed',
        'needsCompensationCheck', 'paidAt', 'payerUserId', 'paymentTransactionId', 'pharmacyId', 'razorpayOrderId', 'razorpayPaymentId', 'status'],
        'ids, amounts, dates and status only');
      // A paid record whose credit is missing is reported as owed.
      const lost = await topup(ph, 40);
      await PaymentRecordModel.updateOne({ _id: lost.record }, { $set: { status: 'paid', razorpayPaymentId: lost.razorpayPaymentId, paidAt: new Date() } });
      const noGateway = await auditS6UncreditedWalletTopups();
      assert.equal(noGateway.rows.find((r) => r.paymentTransactionId === lost.record)?.finding, 'paid_not_credited');
      assert.equal(noGateway.failedWithCapture, 'not checked (no gateway)');
      // After deploy the pharmacy's own reconcile (or the app's verify) credits each one once; the audit then drops them.
      assert.equal((await post('reconcile', pharmacyToken(ph), { paymentTransactionId: stuck.record })).body.data?.state, 'paid');
      assert.equal((await post('reconcile', pharmacyToken(ph), { paymentTransactionId: lost.record })).status, 200);
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 76000);
      const after = await auditS6UncreditedWalletTopups(gatewayReader, disputesReader);
      assert.equal(after.rows.some((r) => [stuck.record, lost.record].includes(r.paymentTransactionId)), false);
      assert.equal((await post('reconcile', pharmacyToken(ph), { paymentTransactionId: stuck.record })).status, 200);
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 76000, 'repeating the reconcile credits nothing more');
    });

    await check('the audit flags admin top-ups since the record and gateway refunds; lists failed-with-capture and anomalies separately', async () => {
      const ph = await pharmacy();
      const early = await pharmacyWallets.topup(ph.pharmacyId, { amount: 999 } as never, 'support-before-' + ph.pharmacyId); // before the top-up: ignored
      assert.ok(early);
      await PharmacyWalletTransactionModel.updateOne({ pharmacyId: ph.pharmacyId, referenceType: 'topup' }, { $set: { createdAt: new Date(Date.now() - 86_400_000) } },
        { timestamps: false });
      const comp = await topup(ph, 150);
      await pharmacyWallets.topup(ph.pharmacyId, { amount: 150 } as never, 'support-' + comp.record); // support paid it by hand
      const refunded = await topup(ph, 80);
      gatewayPayments.get(refunded.razorpayPaymentId)!.amount_refunded = 3000; // Rs 30 partially refunded at Razorpay
      const failed = await topup(ph, 60);
      await PaymentRecordModel.updateOne({ _id: failed.record }, { $set: { status: 'failed' } });
      const oddA = await PaymentRecordModel.create({ userId: ph.userId, payerUserId: ph.userId, payerPharmacyId: ph.pharmacyId, context: 'wallet_recharge',
        contextId: 'odd_a', baseAmount: 10, discountAmount: 0, finalAmount: 10, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'order_odd_a_' + ph.pharmacyId,
        status: 'created' }); // a pharmacy id but no pharmacy flow
      const oddB = await PaymentRecordModel.create({ userId: ph.userId, context: 'wallet_recharge', contextId: 'odd_b', baseAmount: 10, discountAmount: 0,
        finalAmount: 10, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'order_odd_b_' + ph.pharmacyId, status: 'created',
        notes: { flow: 'pharmacy_wallet_recharge' } }); // the flow but no payer pharmacy
      const report = await auditS6UncreditedWalletTopups(gatewayReader, disputesReader);
      const row = (id: string) => report.rows.find((r) => r.paymentTransactionId === id);
      assert.deepEqual(row(comp.record)!.adminTopupsSince, { count: 1, amount: 150 }, 'only admin credits on or after createdAt');
      assert.equal(row(comp.record)!.needsCompensationCheck, true);
      assert.equal((row(refunded.record)!.gateway as { amountRefunded: number }).amountRefunded, 30);
      assert.equal(row(refunded.record)!.needsCompensationCheck, true);
      assert.equal(row(failed.record), undefined, 'a failed record is not a credit row');
      const f = (report.failedWithCapture as { paymentTransactionId: string; review: string }[]).find((x) => x.paymentTransactionId === failed.record)!;
      assert.match(f.review, /manual/);
      assert.equal(row(String(oddA._id)), undefined); assert.equal(row(String(oddB._id)), undefined);
      const anomaly = (id: unknown) => report.anomalies.find((x) => x.paymentTransactionId === String(id));
      assert.deepEqual([anomaly(oddA._id)?.hasPayerPharmacyId, anomaly(oddA._id)?.hasPharmacyFlow], [true, false]);
      assert.deepEqual([anomaly(oddB._id)?.hasPayerPharmacyId, anomaly(oddB._id)?.hasPharmacyFlow], [false, true]);
      assert.equal(anomaly(comp.record), undefined);
      for (const id of [failed.record, String(oddA._id), String(oddB._id)]) {
        const o = await creditS6WalletTopup({ recordId: id, commit: true, client: fakeRazorpay });
        assert.equal(o.decision, 'refused', id); assert.equal(o.committed, false);
      }
      shared.ph = ph; shared.comp = comp.record; shared.refunded = refunded.record;
    });

    await check('a top-up blocked after a lost card dispute is listed apart ("never credit") and the credit script refuses it, no override', async () => {
      const ph = await pharmacy();
      const blocked = await topup(ph, 90); // Razorpay captured it; the card dispute was lost before any credit
      await PaymentRecordModel.updateOne({ _id: blocked.record }, { $set: { status: 'failed', chargebackAt: new Date() } });
      const blockedRefunded = await topup(ph, 70); // a refunded record keeps its status when it is blocked
      await PaymentRecordModel.updateOne({ _id: blockedRefunded.record }, { $set: { status: 'refunded', chargebackAt: new Date() } });
      const report = await auditS6UncreditedWalletTopups(gatewayReader, disputesReader) as any;
      const ids = (xs: { paymentTransactionId: string }[]) => xs.map((x) => x.paymentTransactionId);
      assert.equal(ids(report.failedWithCapture).includes(blocked.record), false, 'not a "manual review" row');
      assert.equal(ids(report.rows).includes(blocked.record), false);
      const listed = report.blockedAfterLostDispute as { paymentTransactionId: string; review: string; amount: number }[];
      assert.deepEqual(ids(listed).filter((x) => [blocked.record, blockedRefunded.record].includes(x)).sort(), [blocked.record, blockedRefunded.record].sort());
      assert.match(listed.find((x) => x.paymentTransactionId === blocked.record)!.review, /never credit/);
      assert.equal(report.summary.blockedAfterLostDispute, listed.length);
      assert.ok(Array.isArray((await auditS6UncreditedWalletTopups() as any).blockedAfterLostDispute), 'listed without the gateway too');
      for (const id of [blocked.record, blockedRefunded.record]) {
        const o = await creditS6WalletTopup({ recordId: id, commit: true, client: fakeRazorpay, alreadyCompensatedChecked: id, disputesCheckedInDashboard: id });
        assert.equal(o.decision, 'refused', id); assert.equal(o.committed, false);
        assert.match(o.reasons.join(' '), /lost card dispute: never credit/);
      }
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 0);
    });

    await check('credit script: dry run writes nothing; --commit credits once through reconcile as the payer; repeats credit nothing', async () => {
      const ph = await pharmacy();
      const t = await topup(ph, 330);
      const snapshot = () => Promise.all([PaymentRecordModel.findById(t.record).lean(), PharmacyWalletTransactionModel.countDocuments({ pharmacyId: ph.pharmacyId }),
        pharmacyBalancePaise(ph.pharmacyId)]);
      const before = await snapshot();
      const dry = await creditS6WalletTopup({ recordId: t.record, commit: false, client: fakeRazorpay });
      assert.equal(dry.decision, 'credit'); assert.equal(dry.committed, false); assert.equal(dry.payerUserId, ph.userId); assert.equal(dry.amount, 330);
      assert.deepEqual(await snapshot(), before, 'the dry run wrote nothing');
      const done = await creditS6WalletTopup({ recordId: t.record.toUpperCase(), commit: true, client: fakeRazorpay });
      assert.equal(done.decision, 'credit'); assert.equal(done.committed, true);
      assert.equal(done.result?.state, 'paid'); assert.equal(done.result?.status, 'paid'); assert.equal(done.result?.isProcessed, true);
      assert.equal(done.result?.walletBalanceChange, 330); assert.ok(done.result?.creditTransactionId);
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 33000);
      const again = await creditS6WalletTopup({ recordId: t.record, commit: true, client: fakeRazorpay });
      assert.equal(again.decision, 'nothing_to_do'); assert.equal(again.committed, false);
      assert.equal((await appVerifyTopup(pharmacyToken(ph), payloadOf(t))).status, 200, 'a late app verify is answered');
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 33000, 'once');
      assert.equal(await pharmacyCredits(ph.pharmacyId), 1);
      // Nothing captured: nothing to credit, nothing written. No keys: refused.
      const open = await pharmacyWallets.initiateTopupPayment(ph.pharmacyId, ph.userId, { amount: 10 } as never);
      assert.equal((await creditS6WalletTopup({ recordId: String(open.paymentTransactionId), commit: true, client: fakeRazorpay })).decision, 'nothing_to_do');
      assert.equal((await record(String(open.paymentTransactionId))).status, 'created');
      assert.equal((await creditS6WalletTopup({ recordId: String(open.paymentTransactionId), commit: true })).decision, 'refused');
      // A wrong amount at the gateway is refused.
      const odd = await topup(ph, 90);
      gatewayPayments.get(odd.razorpayPaymentId)!.amount = 100;
      const wrong = await creditS6WalletTopup({ recordId: odd.record, commit: true, client: fakeRazorpay });
      assert.equal(wrong.decision, 'refused'); assert.equal((await record(odd.record)).status, 'created');
      // A paid-but-uncredited record (verify marked it paid, the credit never ran) is credited without a gateway re-capture.
      const half = await topup(ph, 45);
      await PaymentRecordModel.updateOne({ _id: half.record }, { $set: { status: 'paid', razorpayPaymentId: half.razorpayPaymentId, paidAt: new Date() } });
      const h = await creditS6WalletTopup({ recordId: half.record, commit: true, client: fakeRazorpay });
      assert.equal(h.decision, 'credit'); assert.equal(h.result?.walletBalanceChange, 45);
    });

    await check('credit script: an admin top-up since the record is refused unless that exact record is confirmed; a refund on the capture always', async () => {
      const { ph, comp, refunded } = shared as { ph: { pharmacyId: string; userId: string }; comp: string; refunded: string };
      const start = await pharmacyBalancePaise(ph.pharmacyId);
      const r1 = await creditS6WalletTopup({ recordId: comp, commit: true, client: fakeRazorpay });
      assert.equal(r1.decision, 'refused'); assert.match(r1.reasons.join(' '), /admin top-up/); assert.equal(r1.committed, false);
      const r2 = await creditS6WalletTopup({ recordId: comp, commit: true, client: fakeRazorpay, alreadyCompensatedChecked: refunded });
      assert.equal(r2.decision, 'refused', 'a confirmation for another record does not count');
      const r3 = await creditS6WalletTopup({ recordId: refunded, commit: true, client: fakeRazorpay });
      assert.equal(r3.decision, 'refused'); assert.match(r3.reasons.join(' '), /refunded/);
      // D1: a refund on the captured payment itself is never overridable (it would credit the refunded part again).
      const r3b = await creditS6WalletTopup({ recordId: refunded, commit: true, client: fakeRazorpay, alreadyCompensatedChecked: refunded });
      assert.equal(r3b.decision, 'refused', 'own refund: no override'); assert.equal(r3b.committed, false);
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), start, 'nothing credited');
      assert.equal((await record(comp)).status, 'created'); assert.equal((await record(refunded)).status, 'created');
      const dry = await creditS6WalletTopup({ recordId: comp, commit: false, client: fakeRazorpay, alreadyCompensatedChecked: comp });
      assert.equal(dry.decision, 'credit'); assert.equal(dry.compensationCheckOverride, true);
      const ok = await creditS6WalletTopup({ recordId: comp, commit: true, client: fakeRazorpay, alreadyCompensatedChecked: comp });
      assert.equal(ok.result?.walletBalanceChange, 150);
      assert.equal((await creditS6WalletTopup({ recordId: comp, commit: true, client: fakeRazorpay, alreadyCompensatedChecked: comp })).decision, 'nothing_to_do');
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), start + 15000, 'credited once');
    });

    await check('credit script racing the app verify and a reconcile credits exactly once', async () => {
      for (let i = 0; i < 3; i++) {
        const ph = await pharmacy();
        const t = await topup(ph, 210);
        const results = await Promise.allSettled([
          creditS6WalletTopup({ recordId: t.record, commit: true, client: fakeRazorpay }),
          appVerifyTopup(pharmacyToken(ph), payloadOf(t)),
          post('reconcile', pharmacyToken(ph), { paymentTransactionId: t.record }),
          creditS6WalletTopup({ recordId: t.record, commit: true, client: fakeRazorpay }),
        ]);
        assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 21000, 'credited exactly once: ' + JSON.stringify(results.map((r) => r.status)));
        assert.equal(await pharmacyCredits(ph.pharmacyId), 1);
        const rec = await record(t.record);
        assert.equal(rec.status, 'paid'); assert.equal(rec.isProcessed, true);
      }
    });
    await check('D1: a refund on another payment of the same order is overridable; on the captured payment it is not', async () => {
      const ph = await pharmacy();
      const t = await topup(ph, 500);
      const sibling = 'pay_' + new Types.ObjectId().toHexString();
      gatewayPayments.set(sibling, { id: sibling, order_id: t.razorpayOrderId, amount: 50000, currency: 'INR', status: 'refunded', amount_refunded: 50000 });
      const a = await creditS6WalletTopup({ recordId: t.record, commit: true, client: fakeRazorpay });
      assert.equal(a.decision, 'refused'); assert.match(a.reasons.join(' '), /another payment/); assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 0);
      const b = await creditS6WalletTopup({ recordId: t.record, commit: true, client: fakeRazorpay, alreadyCompensatedChecked: t.record });
      assert.equal(b.decision, 'credit'); assert.equal(b.result?.outcome, 'credited'); assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 50000);
      // Rs 5,000 captured with Rs 2,000 refunded on that payment: refused with or without the confirmation, nothing credited.
      const u = await topup(ph, 5000);
      gatewayPayments.get(u.razorpayPaymentId)!.amount_refunded = 200000;
      for (const flag of [undefined, u.record]) {
        const o = await creditS6WalletTopup({ recordId: u.record, commit: true, client: fakeRazorpay, alreadyCompensatedChecked: flag });
        assert.equal(o.decision, 'refused'); assert.equal(o.committed, false); assert.equal(exitCodeOf(o), 2);
      }
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 50000, 'nothing more'); assert.equal((await record(u.record)).status, 'created');
    });

    await check('D2: a dispute on the captured payment is shown by the audit and refused by the credit script; no disputes lookup needs the dashboard check flag', async () => {
      const ph = await pharmacy();
      const t = await topup(ph, 260);
      gatewayDisputes.push({ id: 'disp_' + t.record, payment_id: t.razorpayPaymentId, status: 'lost', amount: 26000 });
      const report = await auditS6UncreditedWalletTopups(gatewayReader, disputesReader);
      const row = report.rows.find((r) => r.paymentTransactionId === t.record)!;
      assert.deepEqual(row.disputes, [{ id: 'disp_' + t.record, status: 'lost', amount: 260 }]); assert.equal(row.needsCompensationCheck, true);
      for (const flag of [undefined, t.record]) {
        const o = await creditS6WalletTopup({ recordId: t.record, commit: true, client: fakeRazorpay, alreadyCompensatedChecked: flag });
        assert.equal(o.decision, 'refused'); assert.match(o.reasons.join(' '), /dispute/);
      }
      const v = await topup(ph, 70);
      const noDisputes = { orders: fakeRazorpay.orders };
      assert.equal((await creditS6WalletTopup({ recordId: v.record, commit: true, client: noDisputes })).decision, 'refused');
      const ok = await creditS6WalletTopup({ recordId: v.record, commit: true, client: noDisputes, disputesCheckedInDashboard: v.record });
      assert.equal(ok.decision, 'credit'); assert.equal(ok.disputesCheckedInDashboard, true); assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 7000);
    });

    await check('D4: a paid and processed record with no credit is reported for manual review, not as a commit or a credit', async () => {
      const ph = await pharmacy();
      const t = await topup(ph, 120);
      await PaymentRecordModel.updateOne({ _id: t.record }, { $set: { status: 'paid', isProcessed: true, razorpayPaymentId: t.razorpayPaymentId, paidAt: new Date() } });
      for (const commit of [false, true]) {
        const o = await creditS6WalletTopup({ recordId: t.record, commit, client: fakeRazorpay, alreadyCompensatedChecked: t.record });
        assert.equal(o.decision, 'processed_without_credit'); assert.equal(o.committed, false); assert.equal(o.result, undefined); assert.equal(exitCodeOf(o), 2);
      }
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 0);
    });

    await check('D5: a record whose base (credited) and final (charged) amounts differ is refused', async () => {
      const ph = await pharmacy();
      const orderId = 'order_disc_' + new Types.ObjectId().toHexString();
      const rec = await PaymentRecordModel.create({ userId: ph.userId, payerUserId: ph.userId, payerPharmacyId: ph.pharmacyId, context: 'wallet_recharge',
        contextId: 'pharmacy_' + ph.pharmacyId + '_d5', baseAmount: 500, discountAmount: 50, finalAmount: 450, baseAmountPaise: 50000, discountAmountPaise: 5000,
        finalAmountPaise: 45000, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: orderId, status: 'created',
        notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: ph.pharmacyId } });
      checkout(orderId, 45000);
      const o = await creditS6WalletTopup({ recordId: String(rec._id), commit: true, client: fakeRazorpay, alreadyCompensatedChecked: String(rec._id) });
      assert.equal(o.decision, 'refused'); assert.match(o.reasons.join(' '), /base amount/); assert.equal(o.committed, false);
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 0); assert.equal((await record(String(rec._id))).status, 'created');
    });

    await check('D6: a pharmacy top-up with a malformed payerPharmacyId does not abort the audit; it is an anomaly and refused', async () => {
      const ph = await pharmacy();
      const bad = await PaymentRecordModel.create({ userId: ph.userId, payerUserId: ph.userId, payerPharmacyId: 'not-a-pharmacy-id', context: 'wallet_recharge',
        contextId: 'pharmacy_bad', baseAmount: 10, discountAmount: 0, finalAmount: 10, currency: 'INR', paymentGateway: 'razorpay',
        razorpayOrderId: 'order_bad_' + ph.pharmacyId, status: 'created', notes: { flow: 'pharmacy_wallet_recharge' } });
      try {
        const report = await auditS6UncreditedWalletTopups(gatewayReader, disputesReader);
        assert.equal(report.rows.some((r) => r.paymentTransactionId === String(bad._id)), false);
        const a = report.anomalies.find((x) => x.paymentTransactionId === String(bad._id))!;
        assert.deepEqual([a.hasPayerPharmacyId, a.payerPharmacyIdValid, a.hasPharmacyFlow], [true, false, true]);
        const o = await creditS6WalletTopup({ recordId: String(bad._id), commit: true, client: fakeRazorpay, alreadyCompensatedChecked: String(bad._id) });
        assert.equal(o.decision, 'refused'); assert.equal(exitCodeOf(o), 2);
      } finally {
        await PaymentRecordModel.deleteOne({ _id: bad._id });
      }
    });

    await check('D7: the CLI prints pure JSON on stdout (service logs on stderr), says "already credited (replay)", and exits 2 for manual review', async () => {
      const run = promisify(execFile);
      const cli = (args: string[]) => run('npx', ['tsx', 'src1/scripts/creditS6WalletTopup.ts', ...args], { env: { ...process.env, MONGODB_URL: FIXTURE_URL } })
        .then((r) => ({ code: 0, stdout: r.stdout }), (e: { code?: number; stdout?: string }) => ({ code: e.code ?? 1, stdout: e.stdout ?? '' }));
      const ph = await pharmacy();
      const t = await topup(ph, 35);
      assert.equal((await appVerifyTopup(pharmacyToken(ph), payloadOf(t))).status, 200);
      await PaymentRecordModel.updateOne({ _id: t.record }, { $set: { isProcessed: false } }); // credited, not marked processed
      const fin = await cli([`--record=${t.record}`, '--commit']);
      assert.equal(fin.code, 0, fin.stdout);
      const outcome = JSON.parse(fin.stdout) as { decision: string; result?: { outcome: string; walletBalanceChange: number; isProcessed: boolean } };
      assert.equal(outcome.decision, 'finalize_only'); assert.equal(outcome.result?.outcome, 'already credited (replay)');
      assert.equal(outcome.result?.walletBalanceChange, 0); assert.equal(outcome.result?.isProcessed, true);
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 3500);
      const p = await topup(ph, 15);
      await PaymentRecordModel.updateOne({ _id: p.record }, { $set: { status: 'paid', isProcessed: true, razorpayPaymentId: p.razorpayPaymentId } });
      const manual = await cli([`--record=${p.record}`, '--commit']);
      assert.equal(manual.code, 2); assert.equal((JSON.parse(manual.stdout) as { decision: string }).decision, 'processed_without_credit');
      const missing = await cli(['--record=' + new Types.ObjectId().toHexString()]);
      assert.equal(missing.code, 2); assert.equal((JSON.parse(missing.stdout) as { decision: string }).decision, 'refused');
    });
    await check('R1: a disputes lookup failing only on the commit run is not covered by --already-compensated-checked; SDK errors are readable', async () => {
      const ph = await pharmacy();
      const t = await topup(ph, 140);
      await pharmacyWallets.topup(ph.pharmacyId, { amount: 5 } as never, 'unrelated-' + t.record); // an unrelated admin top-up since the record
      let failing = false;
      const flaky = { orders: fakeRazorpay.orders, disputes: { all: async (q: { count: number; skip: number }) => {
        if (failing) throw { statusCode: 502, error: { code: 'SERVER_ERROR', description: 'Disputes service unavailable' } };
        return fakeRazorpay.disputes.all(q);
      } } };
      const dry = await creditS6WalletTopup({ recordId: t.record, commit: false, client: flaky, alreadyCompensatedChecked: t.record, gatewayOptions: { pageDelayMs: 0 } });
      assert.equal(dry.decision, 'credit', 'the dry run saw the disputes');
      failing = true; // the lookup fails only on the commit run
      const commit = await creditS6WalletTopup({ recordId: t.record, commit: true, client: flaky, alreadyCompensatedChecked: t.record, gatewayOptions: { pageDelayMs: 0 } });
      assert.equal(commit.decision, 'refused'); assert.equal(commit.committed, false);
      assert.match(commit.reasons.join(' '), /HTTP 502 SERVER_ERROR Disputes service unavailable/);
      assert.equal((await record(t.record)).status, 'created');
      const wrong = await creditS6WalletTopup({ recordId: t.record, commit: true, client: flaky, alreadyCompensatedChecked: t.record,
        disputesCheckedInDashboard: new Types.ObjectId().toHexString() });
      assert.equal(wrong.decision, 'refused', 'the dashboard flag must name this record');
      const ok = await creditS6WalletTopup({ recordId: t.record, commit: true, client: flaky, alreadyCompensatedChecked: t.record,
        disputesCheckedInDashboard: t.record, gatewayOptions: { pageDelayMs: 0 } });
      assert.equal(ok.decision, 'credit'); assert.equal(ok.result?.outcome, 'credited');
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 14500);
    });

    const r2 = async () => {
      const ph = await pharmacy();
      const t = await topup(ph, 55);
      const deadline = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, j) => setTimeout(() => j(new Error('hung (no timeout)')), 3000))]);
      const rowWith = (client: Parameters<typeof disputesReaderFor>[0] & { orders?: unknown }, o: object = {}) =>
        deadline(auditS6UncreditedWalletTopups(gatewayReader, disputesReaderFor(client, { pageDelayMs: 0, ...o }))).then((r) => r.rows.find((x) => x.paymentTransactionId === t.record)!);
      const unavailable = async (client: Parameters<typeof disputesReaderFor>[0] & { orders?: unknown }, o: object = {}) => {
        const row = await rowWith(client, o);
        assert.equal(row.needsCompensationCheck, true);
        return String((row.disputes as { unavailable?: string }).unavailable);
      };
      return { t, rowWith, unavailable };
    };
    await check('R2a: dispute paging reads past short pages (skip advances by the items received, stops on an empty page)', async () => {
      const { t, rowWith } = await r2();
      const many = Array.from({ length: 20 }, (_, i) => ({ id: `disp_short_${i}_${t.record}`, payment_id: i === 15 ? t.razorpayPaymentId : 'pay_other_' + i, status: 'open', amount: 100 }));
      const short = { orders: fakeRazorpay.orders, disputes: { all: async ({ skip }: { count: number; skip: number }) => ({ items: many.slice(skip, skip + 7) }) } };
      assert.deepEqual((await rowWith(short)).disputes, [{ id: `disp_short_15_${t.record}`, status: 'open', amount: 1 }]);
      const refused = await creditS6WalletTopup({ recordId: t.record, commit: true, client: short, alreadyCompensatedChecked: t.record, gatewayOptions: { pageDelayMs: 0 } });
      assert.equal(refused.decision, 'refused'); assert.match(refused.reasons.join(' '), /dispute/);
    });
    await check('R2b: a disputes answer without an items array is "unavailable"', async () => {
      const { unavailable } = await r2();
      assert.match(await unavailable({ orders: fakeRazorpay.orders, disputes: { all: async () => ({ count: 0 }) } }), /no items array/);
    });
    await check('R2c: hitting the page cap is "unavailable"', async () => {
      const { unavailable } = await r2();
      const endless = { orders: fakeRazorpay.orders, disputes: { all: async ({ skip }: { count: number; skip: number }) => ({ items: [{ id: 'd' + skip, payment_id: 'x', status: 'open', amount: 1 }] }) } };
      assert.match(await unavailable(endless), /cap/);
    });
    await check('R2d: a disputes request that never answers times out as "unavailable"', async () => {
      const { unavailable } = await r2();
      assert.match(await unavailable({ orders: fakeRazorpay.orders, disputes: { all: () => new Promise<never>(() => undefined) } }, { timeoutMs: 50 }), /timed out/);
    });

    await check('R3a: parallel runs report one "credited" at most, the rest "already credited (replay)"', async () => {
      for (let i = 0; i < 3; i++) {
        const ph = await pharmacy();
        const t = await topup(ph, 75);
        const runs = await Promise.all([0, 1, 2].map(() => creditS6WalletTopup({ recordId: t.record, commit: true, client: fakeRazorpay })));
        const outcomes = runs.map((r) => r.result?.outcome ?? r.decision);
        assert.equal(outcomes.filter((o) => o === 'credited').length, 1, JSON.stringify(outcomes));
        assert.equal(outcomes.filter((o) => o !== 'credited' && o !== 'already credited (replay)' && o !== 'nothing_to_do').length, 0, JSON.stringify(outcomes));
        assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 7500);
        const late = await topup(ph, 25);
        const [verified, run] = await Promise.all([appVerifyTopup(pharmacyToken(ph), payloadOf(late)), creditS6WalletTopup({ recordId: late.record, commit: true, client: fakeRazorpay })]);
        assert.equal(verified.status, 200);
        assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 10000, 'once');
        if (run.result) assert.notEqual(run.result.outcome === 'credited' && run.result.walletBalanceChange !== 25, true);
      }
    });

    await check('R3b: a --commit whose reconcile no longer finds the capture reports "not credited" and exits 3', async () => {
      const ph = await pharmacy();
      const t = await topup(ph, 65);
      let asked = 0;
      const vanishing = { disputes: fakeRazorpay.disputes, orders: { fetchPayments: async (orderId: string) => (++asked === 1 ? fakeRazorpay.orders.fetchPayments(orderId) : { items: [] }) } };
      const o = await creditS6WalletTopup({ recordId: t.record, commit: true, client: vanishing });
      assert.equal(o.committed, true); assert.equal(o.result?.outcome, 'not credited'); assert.equal(exitCodeOf(o), 3);
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 0);
    });

    await check('R5: a created record already marked processed is refused up front as processed_without_credit, nothing written', async () => {
      const ph = await pharmacy();
      const t = await topup(ph, 95);
      await PaymentRecordModel.updateOne({ _id: t.record }, { $set: { isProcessed: true } });
      const o = await creditS6WalletTopup({ recordId: t.record, commit: true, client: fakeRazorpay, alreadyCompensatedChecked: t.record });
      assert.equal(o.decision, 'processed_without_credit'); assert.equal(o.committed, false); assert.equal(exitCodeOf(o), 2);
      const rec = await record(t.record);
      assert.equal(rec.status, 'created'); assert.equal(rec.razorpayPaymentId, undefined);
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 0);
    });

    await check('R6: a gateway lookup error keeps the row (needsCompensationCheck) and lists it, and a failed record, under gatewayLookupFailed', async () => {
      const ph = await pharmacy();
      const t = await topup(ph, 85);
      const f = await topup(ph, 45);
      await PaymentRecordModel.updateOne({ _id: f.record }, { $set: { status: 'failed' } });
      const broken = new Set([t.razorpayOrderId, f.razorpayOrderId]);
      const read = async (orderId: string) => {
        if (broken.has(orderId)) throw { statusCode: 500, error: { code: 'SERVER_ERROR', description: 'boom' } };
        return gatewayReader(orderId);
      };
      const report = await auditS6UncreditedWalletTopups(read, disputesReader);
      const row = report.rows.find((r) => r.paymentTransactionId === t.record)!;
      assert.ok(row, 'the row is kept'); assert.equal(row.needsCompensationCheck, true);
      assert.match((row.gateway as { reason: string }).reason, /SERVER_ERROR boom/);
      const failedIds = (report.gatewayLookupFailed ?? []).map((x) => `${x.section}:${x.paymentTransactionId}`).sort();
      assert.deepEqual(failedIds, [`failed:${f.record}`, `rows:${t.record}`].sort());
      assert.equal(report.summary.gatewayLookupFailed, 2);
    });

    await check('R4: both CLIs print a JSON error object on stdout and exit 1 when anything throws', async () => {
      const run = promisify(execFile);
      const bad = 'mongodb://127.0.0.1:1/s6_unreachable?directConnection=true&serverSelectionTimeoutMS=300';
      for (const script of ['src1/scripts/creditS6WalletTopup.ts', 'src1/scripts/auditS6UncreditedWalletTopups.ts']) {
        const r = await run('npx', ['tsx', script, '--record=' + new Types.ObjectId().toHexString(), '--no-gateway'], { env: { ...process.env, MONGODB_URL: bad } })
          .then((x) => ({ code: 0, stdout: x.stdout }), (e: { code?: number; stdout?: string }) => ({ code: e.code ?? -1, stdout: e.stdout ?? '' }));
        assert.equal(r.code, 1, script);
        const body = JSON.parse(r.stdout) as { ok: boolean; error: { code: string; message: string } };
        assert.equal(body.ok, false); assert.ok(body.error.code && body.error.message, script);
      }
    });
  } finally {
    server.close();
  }
  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
