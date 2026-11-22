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
import { auditS6UncreditedWalletTopups } from '@/scripts/auditS6UncreditedWalletTopups';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/s6_pharmacy_wallet_verify?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const SECRET = 'secret';
type GatewayPayment = { id: string; order_id: string; amount: number; currency: string; status: string };
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
      const fetchOrderPayments = async (orderId: string) => (await fakeRazorpay.orders.fetchPayments(orderId)).items;
      const before = await Promise.all([PaymentRecordModel.countDocuments(), PharmacyWalletTransactionModel.countDocuments(), PharmacyWalletModel.countDocuments()]);
      const report = await auditS6UncreditedWalletTopups(fetchOrderPayments);
      assert.deepEqual(await Promise.all([PaymentRecordModel.countDocuments(), PharmacyWalletTransactionModel.countDocuments(), PharmacyWalletModel.countDocuments()]),
        before, 'the audit writes nothing');
      const row = (id: string) => report.rows.find((r) => r.paymentTransactionId === id);
      const s = row(stuck.record)!;
      assert.equal(s.finding, 'unsettled'); assert.equal(s.status, 'created'); assert.equal(s.amount, 700); assert.equal(s.pharmacyId, ph.pharmacyId);
      assert.deepEqual(s.gateway, { checked: true, statuses: ['captured'], capturedPaymentId: stuck.razorpayPaymentId, capturedAmount: 700, amountMatches: true });
      const a = row(String(abandoned.paymentTransactionId))!;
      assert.equal(a.finding, 'unsettled'); assert.deepEqual(a.gateway, { checked: true, statuses: [], capturedPaymentId: null, capturedAmount: null, amountMatches: null });
      assert.equal(row(done.record), undefined, 'a credited top-up is not listed');
      assert.deepEqual(Object.keys(s).sort(), ['amount', 'createdAt', 'creditTransactionId', 'finding', 'gateway', 'isProcessed', 'paidAt', 'payerUserId',
        'paymentTransactionId', 'pharmacyId', 'razorpayOrderId', 'razorpayPaymentId', 'status'], 'ids, amounts, dates and status only');
      // A paid record whose credit is missing is reported as owed.
      const lost = await topup(ph, 40);
      await PaymentRecordModel.updateOne({ _id: lost.record }, { $set: { status: 'paid', razorpayPaymentId: lost.razorpayPaymentId, paidAt: new Date() } });
      assert.equal((await auditS6UncreditedWalletTopups()).rows.find((r) => r.paymentTransactionId === lost.record)?.finding, 'paid_not_credited');
      // After deploy the pharmacy's own reconcile (or the app's verify) credits each one once; the audit then drops them.
      assert.equal((await post('reconcile', pharmacyToken(ph), { paymentTransactionId: stuck.record })).body.data?.state, 'paid');
      assert.equal((await post('reconcile', pharmacyToken(ph), { paymentTransactionId: lost.record })).status, 200);
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 76000);
      const after = await auditS6UncreditedWalletTopups(fetchOrderPayments);
      assert.equal(after.rows.some((r) => [stuck.record, lost.record].includes(r.paymentTransactionId)), false);
      assert.equal((await post('reconcile', pharmacyToken(ph), { paymentTransactionId: stuck.record })).status, 200);
      assert.equal(await pharmacyBalancePaise(ph.pharmacyId), 76000, 'repeating the reconcile credits nothing more');
    });
  } finally {
    server.close();
  }
  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
