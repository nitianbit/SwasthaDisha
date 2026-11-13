/**
 * Booking payment-retry integrity (packet split from P2): full BookingService retry / cancel and
 * PaymentService.processBookingPayment flows against a real MongoDB replica set. Payment-order creation is a
 * recording fake (no Razorpay). After every scenario the customer's wallet balance must equal their ledger, and
 * a cancellation must return every rupee taken.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/booking_retry_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/booking-payment/retry-integrity.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import '@/modules/user/model';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import ExternalBookingModel from '@/modules/externalBookings/model';
import { ExternalBookingRepository } from '@/modules/externalBookings/repository';
import { ExternalBookingService } from '@/modules/externalBookings/services';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/booking_retry_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

/** Hooks let a scenario run something (e.g. a cancellation) in the middle of payment-order creation. */
const hooks: { beforeOrder?: () => Promise<void>; failOrder?: boolean } = {};
const paymentStub = {
  createOrder: async (d: { userId: string; context?: string; contextId: string; baseAmount: number; discountAmount: number; finalAmount: number; couponCode?: string; notes: object }) => {
    const h = hooks.beforeOrder; hooks.beforeOrder = undefined; if (h) await h();
    if (hooks.failOrder) { hooks.failOrder = false; throw new Error('Razorpay order creation failed'); }
    const rec = await PaymentRecordModel.create({ userId: d.userId, context: d.context ?? 'booking', contextId: d.contextId, baseAmount: d.baseAmount,
      discountAmount: d.discountAmount, finalAmount: d.finalAmount, currency: 'INR', paymentGateway: 'razorpay',
      razorpayOrderId: 'ord_' + new Types.ObjectId().toHexString(), status: 'created', notes: d.notes });
    return { paymentRecord: rec.toObject(), razorpayOrder: { id: rec.razorpayOrderId, currency: 'INR' }, razorpayKeyId: 'k' };
  },
  createDirectPaidTransaction: async (d: { userId: string; context?: string; contextId: string; baseAmount: number; discountAmount: number; notes: object }) => {
    const h = hooks.beforeOrder; hooks.beforeOrder = undefined; if (h) await h();
    if (hooks.failOrder) { hooks.failOrder = false; throw new Error('Payment record creation failed'); }
    return (await PaymentRecordModel.create({ userId: d.userId, context: d.context ?? 'booking', contextId: d.contextId, baseAmount: d.baseAmount,
      discountAmount: d.discountAmount, finalAmount: 0, currency: 'INR', paymentGateway: 'internal', status: 'paid', notes: d.notes })).toObject();
  },
  // Booking wallet-covered/zero-payable settlement (A2a): the record is inserted inside the booking's transaction.
  createDirectPaidBookingRecordIn: async (d: unknown, session: unknown, id: unknown) => {
    if (hooks.failOrder) { hooks.failOrder = false; throw new Error('Payment record creation failed'); }
    const real = Object.create(PaymentService.prototype) as { createDirectPaidBookingRecordIn: (...a: unknown[]) => Promise<unknown> };
    return real.createDirectPaidBookingRecordIn(d, session, id);
  },
};
const coupon = { discount: 0 };
const emails = { sent: 0, failNext: false };
const bookings = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), paymentService: paymentStub,
  couponService: { incrementUsage: async () => undefined, decrementUsage: async () => undefined, getByCode: async () => ({ _id: 'c' }) },
  bookingReminderScheduler: { scheduleBookingReminders: async () => undefined, clearBookingReminders: async () => undefined },
  sendPaidBookingEmailNotification: async () => undefined, notificationService: {}, enforceUserCancellationWindow: () => undefined,
  resolveRetryBookingCoupon: async () => ({ discountAmount: coupon.discount, couponCode: 'SAVE' }),
}) as BookingService;
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), bookingReminderScheduler: { scheduleBookingReminders: async () => undefined },
  sendPaidBookingEmailNotification: async () => { emails.sent++; if (emails.failNext) { emails.failNext = false; throw new Error('SMTP down'); } },
  finalizePaymentProcessing: async (r: object) => r,
}) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
(payments as Record<string, unknown>).getOrCreateActiveWallet = (PaymentService.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)
  .getOrCreateActiveWallet.bind(payments);
(payments as Record<string, unknown>).externalBookingRepository = new ExternalBookingRepository();
// Like completeExternalBookingAfterPayment: an already-fulfilled booking is returned as is; otherwise this payment
// is applied (paid + link) and the provider booking made.
const finalizeGate: { wait?: Promise<void>; arrived: number } = { arrived: 0 };
(payments as Record<string, unknown>).finalizeExternalBookingPayment = async (r: { _id: unknown; contextId: string }) => {
  const b = await ExternalBookingModel.findById(r.contextId).lean() as { paymentStatus?: string; externalBookingId?: string } | null;
  if (b?.paymentStatus === 'paid' && b.externalBookingId) return b;
  finalizeGate.arrived++;
  if (finalizeGate.wait) await finalizeGate.wait; // both provider calls read "unpaid" before either writes
  return ExternalBookingModel.findByIdAndUpdate(r.contextId, { $set: { paymentStatus: 'paid', paymentTransactionId: String(r._id),
    status: 'confirmed', externalBookingId: 'prov_' + String(r._id) } }, { new: true }).lean();
};
(payments as Record<string, unknown>).sendExternalBookingEmailNotification = async () => undefined;
const externals = Object.assign(Object.create(ExternalBookingService.prototype), {
  externalBookingRepository: new ExternalBookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), couponService: { decrementUsage: async () => undefined, getByCode: async () => ({ _id: 'c' }) },
  paymentService: { ...paymentStub, recoverExternalBookingPayment: async (r: { contextId: string }) => ({ entity: await ExternalBookingModel.findById(r.contextId).lean() }) },
}) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
/** The shared create/retry settlement step of external bookings (₹100 due). */
const settle = (id: string, user: string, expectedLink: string | undefined, useWallet: boolean) => externals.finalizeExternalPaymentSettlement({
  userId: user, bookingId: id, grossAmount: 100, discountAmount: 0, walletAlreadyApplied: 0, attemptUseWalletBalance: useWallet, orderNotes: {}, expectedLink,
}) as Promise<{ paymentRequired: boolean; payment?: { amount: number } }>;
async function externalBooking(user: string) {
  const p0 = await PaymentRecordModel.create({ userId: user, context: 'external_booking', contextId: 'x', baseAmount: 100, discountAmount: 0, finalAmount: 100,
    currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_e0_' + new Types.ObjectId().toHexString(), status: 'created', notes: { walletDeductedAmount: 0 } });
  const { insertedId } = await ExternalBookingModel.collection.insertOne({ userId: user, status: 'pending_payment', paymentStatus: 'pending', price: 100,
    paymentTransactionId: String(p0._id) } as never);
  await PaymentRecordModel.updateOne({ _id: p0._id }, { $set: { contextId: insertedId.toHexString() } });
  return { id: insertedId.toHexString(), p0: String(p0._id) };
}
/** Simulates any of the external cancellation paths: cancel, then refund from the (stale) pre-cancel snapshot. */
async function cancelExternal(id: string) {
  const snapshot = await ExternalBookingModel.findById(id).lean();
  await ExternalBookingModel.updateOne({ _id: id }, { $set: { status: 'cancelled', paymentStatus: 'cancelled' } });
  return externals.refundExternalBookingAmountToWallet(snapshot);
}
const complete = (recordId: string) => PaymentRecordModel.findById(recordId).lean().then(r => payments.processBookingPayment(r));

const admin = { _id: new Types.ObjectId().toHexString(), userType: 'admin' };
async function customer(balanceRupees: number) {
  const user = new Types.ObjectId().toHexString();
  const w = await WalletModel.create({ userId: user, balance: balanceRupees, isActive: true });
  if (balanceRupees) await WalletTransactionModel.create({ userId: user, walletId: w._id, transactionType: 'credit', amount: balanceRupees,
    balanceBefore: 0, balanceAfter: balanceRupees, status: 'completed', referenceType: 'seed', transactionDate: '20261113' });
  return { user, wallet: w };
}
/** ₹100 package booking linked to an unpaid P0 with no wallet funding yet. */
async function booking(user: string) {
  const p0 = await PaymentRecordModel.create({ userId: user, context: 'booking', contextId: 'x', baseAmount: 100, discountAmount: 0, finalAmount: 100,
    currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_p0_' + new Types.ObjectId().toHexString(), status: 'created', notes: { walletDeductedAmount: 0 } });
  const { insertedId } = await BookingModel.collection.insertOne({ userId: user, bookingType: 'package', status: 'pending', paymentStatus: 'pending',
    price: 100, paymentTransactionId: String(p0._id) } as never);
  await PaymentRecordModel.updateOne({ _id: p0._id }, { $set: { contextId: insertedId.toHexString() } });
  return { id: insertedId.toHexString(), p0: String(p0._id) };
}
const balance = async (u: string) => Number((await WalletModel.findOne({ userId: u }).lean())?.balance);
const row = (id: string) => BookingModel.findById(id).lean();
async function ledgerMatches(u: string) {
  const sum = (await WalletTransactionModel.find({ userId: u }).lean()).reduce((a, t) => a + (t.transactionType === 'debit' ? -t.amount : t.amount), 0);
  assert.equal(Math.round(sum * 100), Math.round((await balance(u)) * 100), 'wallet balance must equal its ledger');
}
const retry = (id: string, user: string, useWallet: boolean) => bookings.retryBookingPayment(id, { _id: user, userType: 'user' },
  { useWalletBalance: useWallet, ...(coupon.discount ? { couponCode: 'SAVE' } : {}) });
async function rejects(p: Promise<unknown>, ...codes: string[]) {
  await assert.rejects(p, (e: { code?: string }) => codes.includes(String(e.code)));
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(url);
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await Promise.all([BookingModel.init(), PaymentRecordModel.init(), WalletModel.init(), WalletTransactionModel.init()]);

  await check('concurrent duplicate retries: wallet funds the booking once; cancellation returns everything', async () => {
    const { user } = await customer(200); const b = await booking(user);
    const results = await Promise.allSettled([retry(b.id, user, true), retry(b.id, user, true)]);
    assert.ok(results.some(r => r.status === 'fulfilled'));
    for (const r of results) if (r.status === 'rejected') assert.ok(['BOOKING_PAYMENT_STATE_CHANGED', 'BOOKING_NOT_PAYABLE'].includes(r.reason.code), r.reason.code);
    assert.equal(await balance(user), 100); assert.equal((await row(b.id))!.walletFunding?.total, 100);
    await bookings.cancelBooking(b.id, {}, admin);
    assert.equal(await balance(user), 200); await ledgerMatches(user);
  });

  await check('stale retry after a newer link is refused; funding, link, paid status and refund stay right', async () => {
    const { user, wallet } = await customer(40); const b = await booking(user);
    const stale = await bookings.getById(b.id); // B reads P0 and pauses
    await retry(b.id, user, true);              // A: ₹40 wallet, gateway link P1
    const p1 = (await row(b.id))!.paymentTransactionId;
    await new WalletRepository().postEntry({ userId: user, walletId: wallet._id, transactionType: 'credit', amount: 60, referenceType: 'topup', description: 't', transactionDate: '20261113' });
    const c = await retry(b.id, user, true);    // C: remaining ₹60, wallet-covered, paid
    assert.equal(c.paymentRequired, false);
    const paid = (await row(b.id))!;
    assert.equal(paid.paymentStatus, 'paid'); assert.notEqual(paid.paymentTransactionId, p1); assert.equal(paid.walletFunding?.total, 100);
    const staleSvc = Object.assign(Object.create(bookings), { getById: async () => stale }) as BookingService;
    await rejects(staleSvc.retryBookingPayment(b.id, { _id: user, userType: 'user' }, { useWalletBalance: true }), 'BOOKING_NOT_PAYABLE', 'BOOKING_ALREADY_PAID');
    const after = (await row(b.id))!;
    assert.equal(after.paymentTransactionId, paid.paymentTransactionId); assert.equal(after.paymentStatus, 'paid');
    await bookings.cancelBooking(b.id, {}, admin);
    assert.equal(await balance(user), 100); await ledgerMatches(user);
  });

  await check('payment setup fails after the wallet debit; a retry with the wallet OFF still counts that money', async () => {
    const { user } = await customer(30); const b = await booking(user);
    hooks.failOrder = true;
    await assert.rejects(retry(b.id, user, true));
    assert.equal(await balance(user), 0); assert.equal((await row(b.id))!.walletFunding?.total, 30);
    const r = await retry(b.id, user, false);
    assert.equal(r.paymentRequired, true);
    assert.equal(r.payment?.amount, 70, 'gateway asks only for the rest');
    assert.equal(Number((await PaymentRecordModel.findById((await row(b.id))!.paymentTransactionId).lean())!.notes.walletDeductedAmount), 30);
    await bookings.cancelBooking(b.id, {}, admin);
    assert.equal(await balance(user), 30); await ledgerMatches(user);
  });

  await check('changed amount due (new coupon) below the wallet funding: the excess goes back to the wallet', async () => {
    const { user } = await customer(80); const b = await booking(user);
    hooks.failOrder = true;
    await assert.rejects(retry(b.id, user, true));      // ₹80 funded, then payment setup failed
    coupon.discount = 50;                               // new coupon: amount due drops to ₹50
    try {
      const r = await retry(b.id, user, false);
      assert.equal(r.paymentRequired, false, 'existing ₹50 of funding covers the new amount due');
    } finally { coupon.discount = 0; }
    const after = (await row(b.id))!;
    assert.equal(after.walletFunding?.total, 50); assert.equal(after.paymentStatus, 'paid');
    assert.equal(await balance(user), 30, 'excess ₹30 returned'); await ledgerMatches(user);
    await bookings.cancelBooking(b.id, {}, admin);
    assert.equal(await balance(user), 80); await ledgerMatches(user);
  });

  await check('paid BEFORE the retry: refused before any wallet debit', async () => {
    const { user } = await customer(100); const b = await booking(user);
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } });
    await complete(b.p0);
    assert.equal((await row(b.id))!.paymentStatus, 'paid');
    await rejects(retry(b.id, user, true), 'BOOKING_NOT_PAYABLE', 'BOOKING_ALREADY_PAID');
    assert.equal(await balance(user), 100); await ledgerMatches(user);
  });

  await check('old payment completes BETWEEN funding and link: retry loses the link, excess wallet funding returned', async () => {
    const { user } = await customer(30); const b = await booking(user);
    hooks.beforeOrder = async () => { // P0 (₹100 at gateway) completes while the retry (₹30 wallet) is creating its order
      await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } });
      await complete(b.p0);
    };
    await rejects(retry(b.id, user, true), 'BOOKING_PAYMENT_STATE_CHANGED');
    const after = (await row(b.id))!;
    assert.equal(after.paymentStatus, 'paid'); assert.equal(after.paymentTransactionId, b.p0);
    assert.equal(after.walletFunding?.total, 0, 'P0 paid the full ₹100, so the ₹30 wallet funding was returned');
    assert.equal(await balance(user), 30); await ledgerMatches(user);
    await bookings.cancelBooking(b.id, {}, admin); // refunds the ₹100 gateway payment
    assert.equal(await balance(user), 130); await ledgerMatches(user);
  });

  await check('cancelled BETWEEN funding and link: the refund includes the new funding; the retry cannot link', async () => {
    const { user } = await customer(40); const b = await booking(user);
    hooks.beforeOrder = async () => { await bookings.cancelBooking(b.id, {}, admin); };
    await rejects(retry(b.id, user, true), 'BOOKING_PAYMENT_STATE_CHANGED');
    const after = (await row(b.id))!;
    assert.equal(after.status, 'cancelled'); assert.equal(after.paymentTransactionId, b.p0);
    assert.equal(await balance(user), 40, 'the ₹40 taken during the race was refunded'); await ledgerMatches(user);
    await rejects(retry(b.id, user, true), 'BOOKING_CANCELLED');
  });

  await check('gateway payment for a cancelled booking goes to the wallet (once); booking stays cancelled', async () => {
    const { user } = await customer(0); const b = await booking(user);
    await bookings.cancelBooking(b.id, {}, admin);
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } });
    await complete(b.p0); await complete(b.p0);
    assert.equal((await row(b.id))!.status, 'cancelled');
    assert.equal(await balance(user), 100); await ledgerMatches(user);
    assert.equal((await PaymentRecordModel.findById(b.p0).lean())!.status, 'refunded');
  });

  await check('a second gateway payment for an already-paid booking is returned to the wallet, not applied twice', async () => {
    const { user } = await customer(0); const b = await booking(user);
    await retry(b.id, user, false); // links P1
    const p1 = String((await row(b.id))!.paymentTransactionId);
    await PaymentRecordModel.updateOne({ _id: p1 }, { $set: { status: 'paid' } }); await complete(p1);
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } }); await complete(b.p0); // old tab also paid
    const after = (await row(b.id))!;
    assert.equal(after.paymentTransactionId, p1); assert.equal(after.paymentStatus, 'paid');
    assert.equal(await balance(user), 100, 'the duplicate ₹100 is back in the wallet'); await ledgerMatches(user);
  });

  await check('EXTERNAL concurrent duplicate settlements: funded once; cancellation returns everything', async () => {
    const { user } = await customer(200); const b = await externalBooking(user);
    const results = await Promise.allSettled([settle(b.id, user, b.p0, true), settle(b.id, user, b.p0, true)]);
    assert.ok(results.some(r => r.status === 'fulfilled'));
    for (const r of results) if (r.status === 'rejected') assert.ok(['BOOKING_PAYMENT_STATE_CHANGED', 'BOOKING_NOT_PAYABLE'].includes(r.reason.code), r.reason.code);
    assert.equal(await balance(user), 100); assert.equal((await ExternalBookingModel.findById(b.id).lean())!.walletFunding?.total, 100);
    await cancelExternal(b.id);
    assert.equal(await balance(user), 200); await ledgerMatches(user);
  });

  await check('EXTERNAL setup failure after the debit, then wallet OFF: the earlier funding still counts', async () => {
    const { user } = await customer(30); const b = await externalBooking(user);
    hooks.failOrder = true;
    await assert.rejects(settle(b.id, user, b.p0, true));
    const r = await settle(b.id, user, b.p0, false);
    assert.equal(r.paymentRequired, true); assert.equal(r.payment?.amount, 70);
    await cancelExternal(b.id);
    assert.equal(await balance(user), 30); await ledgerMatches(user);
  });

  await check('EXTERNAL cancelled between funding and link: link refused; refund (from a stale snapshot) includes the funding', async () => {
    const { user } = await customer(40); const b = await externalBooking(user);
    let refunded: unknown;
    hooks.beforeOrder = async () => { refunded = await cancelExternal(b.id); };
    await rejects(settle(b.id, user, b.p0, true), 'BOOKING_PAYMENT_STATE_CHANGED');
    assert.equal(refunded, 40); assert.equal(await balance(user), 40); await ledgerMatches(user);
    assert.equal(String((await ExternalBookingModel.findById(b.id).lean())!.paymentTransactionId), b.p0);
  });

  await check('EXTERNAL gateway payment for a cancelled booking goes to the wallet once and is not fulfilled', async () => {
    const { user } = await customer(0); const b = await externalBooking(user);
    await cancelExternal(b.id);
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } });
    const r = await PaymentRecordModel.findById(b.p0).lean();
    await payments.processExternalBookingPayment(r); await payments.processExternalBookingPayment(r);
    assert.equal((await ExternalBookingModel.findById(b.id).lean())!.status, 'cancelled');
    assert.equal(await balance(user), 100); await ledgerMatches(user);
  });

  await check('[R1] capture verified, then cancelled before processing, then processing resumes: refunded ONCE', async () => {
    const { user } = await customer(0); const b = await booking(user);
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } }); // markPaymentAsPaid done, processing pending
    const snapshot = await PaymentRecordModel.findById(b.p0).lean();
    await bookings.cancelBooking(b.id, {}, admin);           // refunds the linked ₹100 capture
    await payments.processBookingPayment(snapshot);          // the original verification resumes
    assert.equal(await balance(user), 100, '₹100 captured -> ₹100 back, not ₹200'); await ledgerMatches(user);
  });

  await check('[R2] wallet funding + old capture vs cancellation, both orders: exactly what was paid comes back', async () => {
    for (const order of ['complete-then-cancel', 'cancel-then-complete']) {
      const { user } = await customer(30); const b = await booking(user);
      hooks.failOrder = true; await assert.rejects(retry(b.id, user, true)); // ₹30 funded, P0 still linked
      await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } }); // P0 (₹100) captured too
      if (order === 'complete-then-cancel') { await complete(b.p0); await bookings.cancelBooking(b.id, {}, admin); }
      else { await bookings.cancelBooking(b.id, {}, admin); await complete(b.p0); }
      assert.equal(await balance(user), 130, order + ': ₹30 wallet + ₹100 card = ₹130 back, no more'); await ledgerMatches(user);
    }
  });

  await check('[R3] EXTERNAL two captures race: the loser is returned to the wallet, never stranded', async () => {
    const { user } = await customer(0); const b = await externalBooking(user);
    const p1 = await PaymentRecordModel.create({ userId: user, context: 'external_booking', contextId: b.id, baseAmount: 100, discountAmount: 0,
      finalAmount: 100, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_e1_' + b.id, status: 'paid', notes: { walletDeductedAmount: 0 } });
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } });
    const p0 = await PaymentRecordModel.findById(b.p0).lean();
    await payments.processExternalBookingPayment(p1.toObject());   // P1 fulfils first
    await payments.processExternalBookingPayment(p0);              // P0 passed the early guard, resumes late
    const after = (await ExternalBookingModel.findById(b.id).lean())!;
    assert.equal(String(after.paymentTransactionId), String(p1._id));
    assert.equal(await balance(user), 100, 'losing ₹100 capture returned'); await ledgerMatches(user);
    assert.equal((await PaymentRecordModel.findById(b.p0).lean())!.status, 'refunded');
    await cancelExternal(b.id);
    assert.equal(await balance(user), 200, 'cancellation then returns the winning ₹100'); await ledgerMatches(user);
  });

  await check('[R4] payment processed twice (replay): applied once, excess returned once', async () => {
    const { user } = await customer(30); const b = await booking(user);
    hooks.failOrder = true; await assert.rejects(retry(b.id, user, true)); // ₹30 funded
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } });
    await complete(b.p0); await complete(b.p0);
    const after = (await row(b.id))!;
    assert.equal(after.paymentStatus, 'paid'); assert.equal(after.walletFunding?.total, 0);
    assert.equal(await balance(user), 30, 'the ₹30 excess returned exactly once'); await ledgerMatches(user);
  });

  await check('[R5] EXTERNAL refund BEFORE the cancelled status is written (timeout sweep order): later funding is refused', async () => {
    const { user } = await customer(30); const b = await externalBooking(user);
    hooks.failOrder = true; await assert.rejects(settle(b.id, user, b.p0, true)); // ₹30 funded
    const snapshot = await ExternalBookingModel.findById(b.id).lean();
    const refunded = await externals.refundExternalBookingAmountToWallet(snapshot); // sweep refunds first...
    assert.equal(refunded, 30);
    await rejects(settle(b.id, user, b.p0, true), 'BOOKING_NOT_PAYABLE');          // ...a retry in between cannot fund
    await ExternalBookingModel.updateOne({ _id: b.id }, { $set: { status: 'cancelled', paymentStatus: 'cancelled' } }); // ...then cancels
    assert.equal(await balance(user), 30); await ledgerMatches(user);
  });

  await check('[R6] funding cycle 80 -> 50 -> 80 -> 50 with coupon changes: every step works (revision-based keys)', async () => {
    const { user } = await customer(80); const b = await booking(user);
    hooks.failOrder = true; await assert.rejects(retry(b.id, user, true));            // 80
    for (let i = 0; i < 2; i++) {
      coupon.discount = 50; hooks.failOrder = true;
      try { await assert.rejects(retry(b.id, user, false)); } finally { coupon.discount = 0; } // -> 50 (30 back)
      assert.equal((await row(b.id))!.walletFunding?.total, 50);
      hooks.failOrder = true; await assert.rejects(retry(b.id, user, true));          // -> 80 again
      assert.equal((await row(b.id))!.walletFunding?.total, 80);
    }
    assert.equal(await balance(user), 0); await ledgerMatches(user);
    await bookings.cancelBooking(b.id, {}, admin);
    assert.equal(await balance(user), 80); await ledgerMatches(user);
  });

  await check('[S1] legacy paid booking (₹50 wallet + ₹50 card, no ledger) + stray ₹100 capture, then cancel: nothing lost', async () => {
    const { user, wallet } = await customer(100);
    await new WalletRepository().postEntry({ userId: user, walletId: wallet._id, transactionType: 'debit', amount: 50, referenceType: 'booking',
      description: 'legacy wallet use', transactionDate: '20261113' }); // pre-ledger code took ₹50 from the wallet
    const p0 = await PaymentRecordModel.create({ userId: user, context: 'booking', contextId: 'x', baseAmount: 100, discountAmount: 0, finalAmount: 50,
      currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_l0_' + user, status: 'paid', notes: { walletDeductedAmount: 50 } });
    const { insertedId } = await BookingModel.collection.insertOne({ userId: user, bookingType: 'package', status: 'confirmed', paymentStatus: 'paid',
      price: 100, paymentTransactionId: String(p0._id), postPaymentCompletedFor: String(p0._id) } as never);
    const id = insertedId.toHexString();
    const p1 = await PaymentRecordModel.create({ userId: user, context: 'booking', contextId: id, baseAmount: 100, discountAmount: 0, finalAmount: 100,
      currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_l1_' + user, status: 'paid', notes: { walletDeductedAmount: 0 } });
    await complete(String(p1._id));                                   // stray duplicate payment -> back to wallet
    assert.equal(await balance(user), 150);
    await bookings.cancelBooking(id, {}, admin);                      // original ₹50 wallet + ₹50 card back
    assert.equal(await balance(user), 250, '₹100 start + ₹100 stray + ₹50 card = ₹250, all accounted'); await ledgerMatches(user);
  });

  await check('[S2] EXTERNAL both provider finalizers read "unpaid" before either writes: exactly one capture applied', async () => {
    const { user } = await customer(0); const b = await externalBooking(user);
    const p1 = await PaymentRecordModel.create({ userId: user, context: 'external_booking', contextId: b.id, baseAmount: 100, discountAmount: 0,
      finalAmount: 100, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_s2_' + b.id, status: 'paid', notes: { walletDeductedAmount: 0 } });
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } });
    let release!: () => void; finalizeGate.wait = new Promise(r => { release = r; }); finalizeGate.arrived = 0;
    const both = Promise.all([payments.processExternalBookingPayment(await PaymentRecordModel.findById(b.p0).lean()),
      payments.processExternalBookingPayment(p1.toObject())]);
    while (finalizeGate.arrived < 2) await new Promise(r => setTimeout(r, 10));
    finalizeGate.wait = undefined; release();
    await both;
    const after = (await ExternalBookingModel.findById(b.id).lean())! as { paymentTransactionId?: string; walletFunding?: { captures?: { recordId: string; state: string }[] } };
    const applied = after.walletFunding!.captures!.filter(c => c.state === 'applied');
    assert.equal(applied.length, 1, 'one financial winner');
    assert.equal(String(after.paymentTransactionId).toLowerCase(), applied[0].recordId, 'link points at the winner');
    assert.equal(await balance(user), 100, 'the other ₹100 returned'); await ledgerMatches(user);
    await cancelExternal(b.id);
    assert.equal(await balance(user), 200); await ledgerMatches(user);
  });

  await check('[S3] full card payment with a frozen (inactive) wallet and wallet=false is applied normally', async () => {
    const { user } = await customer(0); const b = await booking(user);
    await WalletModel.updateOne({ userId: user }, { $set: { isActive: false } });
    await retry(b.id, user, false);
    const p1 = String((await row(b.id))!.paymentTransactionId);
    await PaymentRecordModel.updateOne({ _id: p1 }, { $set: { status: 'paid' } });
    await complete(p1);
    assert.equal((await row(b.id))!.paymentStatus, 'paid'); assert.equal(await balance(user), 0);
  });

  await check('[S4] crash in post-payment follow-up: replay re-runs it (money once), then marks it done', async () => {
    const { user } = await customer(0); const b = await booking(user);
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } });
    emails.sent = 0; emails.failNext = true;
    await assert.rejects(complete(b.p0));                   // capture committed, email step crashed
    assert.equal((await row(b.id))!.paymentStatus, 'paid');
    await complete(b.p0);                                   // replay resumes the follow-up
    assert.equal(emails.sent, 2); assert.equal((await row(b.id))!.postPaymentCompletedFor, b.p0);
    await complete(b.p0);                                   // done: no further follow-up
    assert.equal(emails.sent, 2); assert.equal(await balance(user), 0); await ledgerMatches(user);
  });

  await check('[T1] EXTERNAL crash after provider paid/link but before capture registration, then cancel: ₹100 returned once', async () => {
    const { user } = await customer(0); const b = await externalBooking(user);
    const r = await settle(b.id, user, b.p0, false);               // wallet off: ledger exists with total 0, captures []
    assert.equal(r.paymentRequired, true);
    const p1 = String((await ExternalBookingModel.findById(b.id).lean())!.paymentTransactionId);
    await PaymentRecordModel.updateOne({ _id: p1 }, { $set: { status: 'paid' } });
    await (payments.finalizeExternalBookingPayment as (r: object) => Promise<unknown>)(await PaymentRecordModel.findById(p1).lean()); // provider wrote paid/link
    // ...process crashed here, before recordGatewayCapture
    await cancelExternal(b.id);
    assert.equal(await balance(user), 100, 'the captured ₹100 is refunded'); await ledgerMatches(user);
    await payments.processExternalBookingPayment(await PaymentRecordModel.findById(p1).lean()); // late processing
    assert.equal(await balance(user), 100, 'not refunded twice'); await ledgerMatches(user);
  });

  await check('[T2] EXTERNAL repeated losing callback re-links the loser: the booking is pointed back at the winner', async () => {
    const { user } = await customer(0); const b = await externalBooking(user);
    const l = await PaymentRecordModel.create({ userId: user, context: 'external_booking', contextId: b.id, baseAmount: 100, discountAmount: 0,
      finalAmount: 100, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_t2_' + b.id, status: 'paid', notes: { walletDeductedAmount: 0 } });
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } });
    await payments.processExternalBookingPayment(await PaymentRecordModel.findById(b.p0).lean()); // W = P0 wins
    for (let i = 0; i < 2; i++) {
      await ExternalBookingModel.updateOne({ _id: b.id }, { $set: { paymentTransactionId: String(l._id) } }); // loser's provider write
      await payments.processExternalBookingPayment(l.toObject());
      assert.equal(String((await ExternalBookingModel.findById(b.id).lean())!.paymentTransactionId), b.p0, 'link == winner after callback ' + (i + 1));
    }
    assert.equal(await balance(user), 100, 'loser returned once'); await ledgerMatches(user);
  });

  await check('[T3] closed (refunded) booking later meets a paid record it never registered: returned once, not marked refunded empty', async () => {
    const { user } = await customer(0); const b = await externalBooking(user);
    await cancelExternal(b.id);                                         // closed, nothing held
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } }); // P0 captured afterwards; processing crashed
    await externals.refundExternalBookingAmountToWallet(await ExternalBookingModel.findById(b.id).lean()); // another cancel path runs
    assert.equal(await balance(user), 100); await ledgerMatches(user);
    await payments.processExternalBookingPayment(await PaymentRecordModel.findById(b.p0).lean());
    assert.equal(await balance(user), 100, 'not twice'); await ledgerMatches(user);
  });

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
