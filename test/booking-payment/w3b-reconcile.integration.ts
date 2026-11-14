/**
 * W3b: POST /payments/reconcile settles a payment from Razorpay's own record of the order when the browser's verify
 * never arrived. Real PaymentService paths and MongoDB replica set; the Razorpay client is a fake that answers
 * orders.fetchPayments.
 *
 * Run (throwaway DB only):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/w3b_reconcile_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/booking-payment/w3b-reconcile.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import '@/modules/user/model';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import { createBookingWithHolds, isReplayedBooking } from '@/modules/bookings/holds';
import SlotModel from '@/modules/slots/model';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/w3b_reconcile_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

/** What Razorpay holds per order. */
const gateway = new Map<string, { id: string; order_id: string; amount: number; currency: string; status: string }[]>();
const gatewayCalls: string[] = [];
/** Runs while the gateway lookup is in flight (to interleave a concurrent writer). */
const duringFetch: { hook?: () => Promise<void> } = {};
const unreachable = new Set<string>();
const fakeRazorpay = {
  orders: { fetchPayments: async (orderId: string) => {
    gatewayCalls.push(orderId);
    if (unreachable.has(orderId)) throw new Error('gateway timeout');
    const h = duringFetch.hook; duringFetch.hook = undefined; if (h) await h();
    return { items: gateway.get(orderId) ?? [] };
  } },
  payments: { fetch: async () => { throw new Error('not used'); } },
};
const emails = { sent: 0 };
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), bookingReminderScheduler: { scheduleBookingReminders: async () => undefined },
  sendPaidBookingEmailNotification: async () => { emails.sent++; },
  finalizePaymentProcessing: async (r: object) => r,
  getRazorpayClient: () => fakeRazorpay,
}) as unknown as PaymentService & Record<string, unknown>;
payments.getOrCreateActiveWallet = (PaymentService.prototype as unknown as Record<string, (...a: unknown[]) => unknown>).getOrCreateActiveWallet.bind(payments);

async function customer() {
  const user = new Types.ObjectId().toHexString();
  await WalletModel.create({ userId: user, balance: 0, isActive: true });
  await mongoose.connection.collection('users').insertOne({ _id: new Types.ObjectId(user), userType: 'user', phone: String(Date.now()).slice(-10) } as never);
  return user;
}
/** ₹100 booking with an unpaid Razorpay record (as POST /bookings leaves it before Checkout). */
async function booking(user: string) {
  const orderId = 'order_' + new Types.ObjectId().toHexString();
  const p0 = await PaymentRecordModel.create({ userId: user, context: 'booking', contextId: 'x', baseAmount: 100, discountAmount: 0, finalAmount: 100,
    currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: orderId, status: 'created', notes: { walletDeductedAmount: 0 } });
  const { insertedId } = await BookingModel.collection.insertOne({ userId: user, bookingType: 'consultation', status: 'pending', paymentStatus: 'pending',
    price: 100, paymentTransactionId: String(p0._id) } as never);
  await PaymentRecordModel.updateOne({ _id: p0._id }, { $set: { contextId: insertedId.toHexString() } });
  return { id: insertedId.toHexString(), record: String(p0._id), orderId };
}
const captured = (orderId: string, amountPaise = 10000) => ({ id: 'pay_' + new Types.ObjectId().toHexString(), order_id: orderId, amount: amountPaise, currency: 'INR', status: 'captured' });
const reconcile = (record: string, userId: string) => payments.reconcilePaymentAndProcess({ paymentTransactionId: record, userId, requesterUserType: 'user' });
const balance = async (u: string) => Number((await WalletModel.findOne({ userId: u }).lean())?.balance);
async function rejects(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: { code?: string; status?: number }) => e.code === code && (status === undefined || e.status === status));
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(url);
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await Promise.all([BookingModel.init(), SlotModel.init(), PaymentRecordModel.init()]);

  await check('a captured payment whose verify never arrived is applied from the gateway; a replay changes nothing', async () => {
    const u = await customer();
    const b = await booking(u);
    const pay = captured(b.orderId);
    gateway.set(b.orderId, [{ ...pay, id: 'pay_failed_first', status: 'failed' }, pay]); // a failed try, then success
    const r = await reconcile(b.record, u) as { state: string; context: string };
    assert.equal(r.state, 'paid'); assert.equal(r.context, 'booking');
    const rec = (await PaymentRecordModel.findById(b.record).lean())!;
    assert.equal(rec.status, 'paid'); assert.equal(rec.razorpayPaymentId, pay.id);
    const bk = (await BookingModel.findById(b.id).lean())!;
    assert.equal(bk.paymentStatus, 'paid'); assert.equal(bk.status, 'confirmed');
    assert.equal(emails.sent, 1);
    const again = await reconcile(b.record, u) as { state: string };
    assert.equal(again.state, 'paid');
    assert.equal(emails.sent, 1, 'processed once');
    assert.equal(await balance(u), 0, 'nothing returned to the wallet');
  });

  await check('nothing captured: "unpaid", nothing changes', async () => {
    const u = await customer();
    const b = await booking(u);
    gateway.set(b.orderId, [{ ...captured(b.orderId), status: 'failed' }]);
    const r = await reconcile(b.record, u) as { state: string; gatewayStatuses: string[] };
    assert.deepEqual(r, { state: 'unpaid', gatewayStatuses: ['failed'] });
    assert.equal((await PaymentRecordModel.findById(b.record).lean())!.status, 'created');
    assert.equal((await BookingModel.findById(b.id).lean())!.paymentStatus, 'pending');
    gateway.set(b.orderId, []);
    assert.deepEqual(await reconcile(b.record, u), { state: 'unpaid', gatewayStatuses: [] });
  });

  await check('a wrong amount, another customer’s record and a failed record are refused, nothing written', async () => {
    const u = await customer();
    const b = await booking(u);
    gateway.set(b.orderId, [captured(b.orderId, 5000)]);
    await rejects(reconcile(b.record, u), 'PAYMENT_AMOUNT_MISMATCH', 400);
    assert.equal((await PaymentRecordModel.findById(b.record).lean())!.status, 'created');
    const other = await customer();
    await rejects(reconcile(b.record, other), 'PAYMENT_RECORD_NOT_FOUND', 404);
    const f = await booking(u);
    await PaymentRecordModel.updateOne({ _id: f.record }, { $set: { status: 'failed' } });
    gateway.set(f.orderId, [captured(f.orderId)]);
    await rejects(reconcile(f.record, u), 'PAYMENT_FAILED', 400);
    assert.equal((await PaymentRecordModel.findById(f.record).lean())!.status, 'failed', 'not revived');
    const w = await PaymentRecordModel.create({ userId: u, context: 'booking', contextId: b.id, baseAmount: 0, discountAmount: 0, finalAmount: 0,
      currency: 'INR', paymentGateway: 'internal', status: 'created', notes: {} });
    await rejects(reconcile(String(w._id), u), 'PAYMENT_NOT_RECONCILABLE', 400);
  });

  await check('a payment captured after the booking was cancelled goes back to the wallet, as with verify', async () => {
    const u = await customer();
    const b = await booking(u);
    await BookingModel.updateOne({ _id: b.id }, { $set: { status: 'cancelled' } });
    gateway.set(b.orderId, [captured(b.orderId)]);
    const r = await reconcile(b.record, u) as { state: string };
    assert.equal(r.state, 'paid');
    assert.equal((await BookingModel.findById(b.id).lean())!.status, 'cancelled', 'not revived');
    assert.equal(await balance(u), 100, 'returned to the wallet');
    assert.equal((await PaymentRecordModel.findById(b.record).lean())!.status, 'refunded');
    await reconcile(b.record, u).catch(() => undefined);
    assert.equal(await balance(u), 100, 'returned once');
    const ledger = await WalletTransactionModel.find({ userId: u }).lean();
    assert.equal(ledger.length, 1);
  });

  await check('two reconciliations at once apply the payment once', async () => {
    const u = await customer();
    const b = await booking(u);
    gateway.set(b.orderId, [captured(b.orderId)]);
    const before = emails.sent;
    const both = await Promise.allSettled([reconcile(b.record, u), reconcile(b.record, u)]);
    assert.ok(both.some(x => x.status === 'fulfilled'));
    for (const x of both) if (x.status === 'rejected') assert.equal((x.reason as { code?: string }).code, 'PAYMENT_CHANGED');
    const bk = (await BookingModel.findById(b.id).lean())! as { paymentStatus: string; walletFunding?: { captures?: unknown[] } };
    assert.equal(bk.paymentStatus, 'paid');
    assert.equal((bk.walletFunding?.captures ?? []).length, 1, 'the capture is applied once');
    assert.equal(await balance(u), 0, 'nothing returned twice');
    assert.equal(await WalletTransactionModel.countDocuments({ userId: u }), 0);
    // Follow-up work (reminders, meeting, email) is at-least-once by design (resumed after a crash), as for two
    // concurrent verifies; only money is exactly-once.
    assert.ok(emails.sent - before >= 1);
  });

  await check('a record that turns failed while the gateway is asked is not revived, and nothing claims success', async () => {
    const u = await customer();
    const b = await booking(u);
    gateway.set(b.orderId, [captured(b.orderId)]);
    // A concurrent verify with a bad signature (or a failed gateway status) marks it failed during the lookup.
    duringFetch.hook = async () => { await PaymentRecordModel.updateOne({ _id: b.record }, { $set: { status: 'failed', isProcessed: true } }); };
    await rejects(reconcile(b.record, u), 'PAYMENT_FAILED', 400);
    const rec = (await PaymentRecordModel.findById(b.record).lean())!;
    assert.equal(rec.status, 'failed', 'not revived');
    assert.equal((await BookingModel.findById(b.id).lean())!.paymentStatus, 'pending', 'no false success');
    // Refunded meanwhile: also refused.
    const r2 = await booking(u);
    gateway.set(r2.orderId, [captured(r2.orderId)]);
    duringFetch.hook = async () => { await PaymentRecordModel.updateOne({ _id: r2.record }, { $set: { status: 'refunded' } }); };
    await rejects(reconcile(r2.record, u), 'PAYMENT_REFUNDED', 400);
    // Paid by a concurrent verify meanwhile: that is the answer.
    const p3 = await booking(u);
    const pay = captured(p3.orderId);
    gateway.set(p3.orderId, [pay]);
    duringFetch.hook = async () => { await PaymentRecordModel.updateOne({ _id: p3.record }, { $set: { status: 'paid', razorpayPaymentId: pay.id } }); };
    const r = await reconcile(p3.record, u) as { state: string };
    assert.equal(r.state, 'paid');
    assert.equal((await BookingModel.findById(p3.id).lean())!.paymentStatus, 'paid');
    // Some other change (e.g. a new attempt state): 409, nothing written.
    const p4 = await booking(u);
    gateway.set(p4.orderId, [captured(p4.orderId)]);
    duringFetch.hook = async () => { await PaymentRecordModel.updateOne({ _id: p4.record }, { $set: { status: 'pending' } }); };
    await rejects(reconcile(p4.record, u), 'PAYMENT_CHANGED', 409);
    assert.equal((await PaymentRecordModel.findById(p4.record).lean())!.status, 'pending');
  });

  /** A newer attempt (as retry-payment makes) for the same booking. */
  async function laterAttempt(user: string, bookingId: string) {
    const orderId = 'order_' + new Types.ObjectId().toHexString();
    const p = await PaymentRecordModel.create({ userId: user, context: 'booking', contextId: bookingId, baseAmount: 100, discountAmount: 0,
      finalAmount: 100, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: orderId, status: 'created', notes: { walletDeductedAmount: 0 } });
    await BookingModel.updateOne({ _id: bookingId }, { $set: { paymentTransactionId: String(p._id) } });
    return { record: String(p._id), orderId };
  }

  await check('[booking] every attempt is checked: an older captured order is applied; a later capture of another goes to the wallet', async () => {
    const u = await customer();
    const b = await booking(u);                      // P1
    gateway.set(b.orderId, [captured(b.orderId)]);   // P1 captured, its confirmation lost
    const p2 = await laterAttempt(u, b.id);          // the booking now points at P2
    let r = await payments.reconcileBookingPayments(b.id);
    assert.deepEqual(r, { checked: 2, unknown: 0 });
    assert.equal((await BookingModel.findById(b.id).lean())!.paymentStatus, 'paid', 'paid by the older attempt');
    assert.equal((await PaymentRecordModel.findById(p2.record).lean())!.status, 'created');
    gateway.set(p2.orderId, [captured(p2.orderId)]); // later, the customer also paid P2 in another tab
    r = await payments.reconcileBookingPayments(b.id);
    assert.deepEqual(r, { checked: 1, unknown: 0 });
    assert.equal(await balance(u), 100, 'the second payment goes back to the wallet');
    assert.equal((await PaymentRecordModel.findById(p2.record).lean())!.status, 'refunded');
  });

  await check('[retry] no new order while an earlier attempt cannot be checked, or when it was captured', async () => {
    const svc = Object.assign(Object.create(BookingService.prototype), {
      bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), paymentService: payments,
    }) as BookingService;
    const u = await customer();
    const b = await booking(u);
    unreachable.add(b.orderId);
    await rejects(svc.retryBookingPayment(b.id, { _id: u, userType: 'user' }, {}), 'PAYMENT_STATE_UNKNOWN', 503);
    assert.equal(await PaymentRecordModel.countDocuments({ contextId: b.id }), 1, 'no new order');
    unreachable.delete(b.orderId);
    gateway.set(b.orderId, [captured(b.orderId)]);
    await rejects(svc.retryBookingPayment(b.id, { _id: u, userType: 'user' }, {}), 'BOOKING_ALREADY_PAID', 400);
    assert.equal(await PaymentRecordModel.countDocuments({ contextId: b.id }), 1, 'no new order');
    assert.equal((await BookingModel.findById(b.id).lean())!.paymentStatus, 'paid', 'the lost payment was applied instead');
    const other = await customer();
    await rejects(svc.reconcileBookingPayments(b.id, { _id: other, userType: 'user' }), 'BOOKING_NOT_FOUND', 404);
    const own = await svc.reconcileBookingPayments(b.id, { _id: u, userType: 'user' });
    assert.equal((own.booking as { paymentStatus: string }).paymentStatus, 'paid');
  });

  await check('[create] the same create key gives one booking and one slot hold, also when sent twice at once', async () => {
    const u = await customer();
    const specialistId = new Types.ObjectId().toHexString();
    const slot = await SlotModel.create({ specialistId, date: '20991231', startTime: '10:00 AM', endTime: '10:15 AM', duration: 15,
      maxBookings: 3, currentBookings: 0, isActive: true, isAvailable: true, slotType: 'consultation' } as never);
    const input = { bookingType: 'consultation', userId: u, specialistId, slotId: String(slot._id), bookingDate: '20991231',
      bookingTime: '10:00 AM', serviceMode: 'video', consultationMode: 'video', primaryConcern: 'test', status: 'pending', paymentStatus: 'pending', price: 100, createRequestKey: 'create-key-0001' } as never;
    const both = await Promise.all([createBookingWithHolds(input), createBookingWithHolds(input)]);
    assert.equal(String(both[0]._id), String(both[1]._id));
    assert.equal(both.filter(isReplayedBooking).length, 1);
    assert.equal(await BookingModel.countDocuments({ userId: u }), 1);
    assert.equal((await SlotModel.findById(slot._id).lean())!.currentBookings, 1, 'one seat held');
    const again = await createBookingWithHolds(input);
    assert.ok(isReplayedBooking(again));
    assert.equal((await SlotModel.findById(slot._id).lean())!.currentBookings, 1);
    // The service answers a resent create before any check or charge.
    const svc = Object.create(BookingService.prototype) as BookingService;
    const replay = await svc.createSpecialistBooking({ userId: u, requestKey: 'create-key-0001' } as never) as { replayed?: boolean; paymentRequired: boolean; booking: { _id: unknown } };
    assert.equal(replay.replayed, true); assert.equal(replay.paymentRequired, true); assert.equal(String(replay.booking._id), String(both[0]._id));
    // Without a key nothing changes: a second create is a second booking.
    const plain = { ...(input as object), createRequestKey: undefined } as never;
    await createBookingWithHolds(plain);
    assert.equal(await BookingModel.countDocuments({ userId: u }), 2);
    const idx = (await BookingModel.collection.indexes()).find(x => x.key?.createRequestKey === 1);
    assert.ok(idx?.unique && idx.partialFilterExpression, 'unique partial index');
  });

  await check('HTTP: POST /payments/reconcile validates and answers through the real router', async () => {
    Container.set(PaymentService, payments as unknown as PaymentService);
    const { default: router } = await import('@/modules/payment/routes');
    const { authenticate } = await import('@/modules/middleware/auth');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/payments', authenticate, router);
    app.use((err: { status?: number; code?: string }, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
      res.status(err.status ?? 500).json({ code: err.code });
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const u = await customer();
      const b = await booking(u);
      gateway.set(b.orderId, [captured(b.orderId)]);
      const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/v1/payments/reconcile`, { method: 'POST', body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + jwt.sign({ _id: u, userType: 'user' }, CONFIG.JWT_SECRET_KEY) } });
      assert.equal((await post({})).status, 400);
      assert.equal((await post({ paymentTransactionId: 'nope' })).status, 400);
      const res = await post({ paymentTransactionId: b.record });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      const body = await res.json() as { message: string; data: { state: string } };
      assert.equal(body.data.state, 'paid'); assert.equal(body.message, 'Payment found and applied');
    } finally { server.close(); }
  });

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
