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
import { auditS6UncreditedWalletTopups, orderPaymentsReaderFor } from '@/scripts/auditS6UncreditedWalletTopups';
import { creditS6WalletTopup } from '@/scripts/creditS6WalletTopup';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/s6_pharmacy_wallet_verify?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const SECRET = 'secret';
type GatewayPayment = { id: string; order_id: string; amount: number; currency: string; status: string; amount_refunded?: number };
/** What Razorpay holds: payments by id and by order. */
const gatewayPayments = new Map<string, GatewayPayment>();
let createdOrders = 0;
const fakeRazorpay = {
  orders: {
    create: async (o: { amount: number; currency: string }) => {
      createdOrders += 1;
      return { id: 'order_s6_' + createdOrders + '_' + new Types.ObjectId().toHexString(), amount: o.amount, currency: o.currency, status: 'created' };
    },
    fetchPayments: async (orderId: string) => ({ items: [...gatewayPayments.values()].filter((p) => p.order_id === orderId) }),
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
  return { pharmacyId: new Types.ObjectId().toHexString(), userId: new Types.ObjectId().toHexString() };
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
      const report = await auditS6UncreditedWalletTopups(gatewayReader);
      assert.deepEqual(await Promise.all([PaymentRecordModel.countDocuments(), PharmacyWalletTransactionModel.countDocuments(), PharmacyWalletModel.countDocuments()]),
        before, 'the audit writes nothing');
      const row = (id: string) => report.rows.find((r) => r.paymentTransactionId === id);
      const s = row(stuck.record)!;
      assert.equal(s.finding, 'unsettled'); assert.equal(s.status, 'created'); assert.equal(s.amount, 700); assert.equal(s.pharmacyId, ph.pharmacyId);
      assert.deepEqual(s.gateway, { checked: true, statuses: ['captured'], capturedPaymentId: stuck.razorpayPaymentId, capturedAmount: 700, amountMatches: true, amountRefunded: 0 });
      assert.deepEqual(s.adminTopupsSince, { count: 0, amount: 0 }); assert.equal(s.needsCompensationCheck, false);
      const a = row(String(abandoned.paymentTransactionId))!;
      assert.equal(a.finding, 'unsettled');
      assert.deepEqual(a.gateway, { checked: true, statuses: [], capturedPaymentId: null, capturedAmount: null, amountMatches: null, amountRefunded: 0 });
      assert.equal(row(done.record), undefined, 'a credited top-up is not listed');
      assert.deepEqual(Object.keys(s).sort(), ['adminTopupsSince', 'amount', 'createdAt', 'creditTransactionId', 'finding', 'gateway', 'isProcessed',
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
      const after = await auditS6UncreditedWalletTopups(gatewayReader);
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
      const report = await auditS6UncreditedWalletTopups(gatewayReader);
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

    await check('credit script: an admin top-up since the record or a gateway refund is refused unless that exact record is confirmed', async () => {
      const { ph, comp, refunded } = shared as { ph: { pharmacyId: string; userId: string }; comp: string; refunded: string };
      const start = await pharmacyBalancePaise(ph.pharmacyId);
      const r1 = await creditS6WalletTopup({ recordId: comp, commit: true, client: fakeRazorpay });
      assert.equal(r1.decision, 'refused'); assert.match(r1.reasons.join(' '), /admin top-up/); assert.equal(r1.committed, false);
      const r2 = await creditS6WalletTopup({ recordId: comp, commit: true, client: fakeRazorpay, alreadyCompensatedChecked: refunded });
      assert.equal(r2.decision, 'refused', 'a confirmation for another record does not count');
      const r3 = await creditS6WalletTopup({ recordId: refunded, commit: true, client: fakeRazorpay });
      assert.equal(r3.decision, 'refused'); assert.match(r3.reasons.join(' '), /refunded/);
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
  } finally {
    server.close();
  }
  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
