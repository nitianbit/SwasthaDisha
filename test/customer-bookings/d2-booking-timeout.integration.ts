/**
 * D2: unpaid doctor/package bookings expire 30 minutes after creation, after their payments were checked with
 * Razorpay. Real holds/settlement/payment code on a MongoDB replica set; the Razorpay client is a fake.
 *
 * Run (throwaway DB only):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/d2_timeout_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/customer-bookings/d2-booking-timeout.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import '@/modules/user/model';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import { createBookingWithHolds, expireUnpaidBooking } from '@/modules/bookings/holds';
import { fundBookingFromWallet } from '@/modules/common/utils/bookingWalletFunding';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import SlotModel from '@/modules/slots/model';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/d2_timeout_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const MIN = 60_000;
const gateway = new Map<string, { id: string; order_id: string; amount: number; currency: string; status: string }[]>();
const unreachable = new Set<string>();
const fakeRazorpay = {
  orders: {
    fetchPayments: async (orderId: string) => {
      if (unreachable.has(orderId)) throw new Error('gateway timeout');
      return { items: gateway.get(orderId) ?? [] };
    },
  },
};
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), bookingReminderScheduler: { scheduleBookingReminders: async () => undefined },
  sendPaidBookingEmailNotification: async () => undefined,
  finalizePaymentProcessing: async (r: { _id: unknown }) => {
    await PaymentRecordModel.updateOne({ _id: r._id }, { $set: { isProcessed: true } });
    return PaymentRecordModel.findById(r._id).lean();
  },
  getRazorpayClient: () => fakeRazorpay,
  getRazorpayCredentials: () => ({ keyId: 'rzp_test_key', keySecret: 'secret' }),
}) as unknown as PaymentService & Record<string, unknown>;
const cleared: string[] = [];
const bookings = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  paymentService: payments, bookingReminderScheduler: { scheduleBookingReminders: async () => undefined,
    clearBookingReminders: async (id: string) => { cleared.push(String(id)); } },
}) as BookingService;

async function customer(balance = 0) {
  const user = new Types.ObjectId().toHexString();
  const w = await WalletModel.create({ userId: user, balance, isActive: true });
  if (balance) await WalletTransactionModel.create({ userId: user, walletId: w._id, transactionType: 'credit', amount: balance,
    balanceBefore: 0, balanceAfter: balance, status: 'completed', referenceType: 'seed', transactionDate: '20261114' });
  return user;
}
/** A ₹100 consultation holding a slot seat, with an unpaid Razorpay order, created `ageMin` minutes ago. */
async function booking(user: string, ageMin: number, walletUse = 0) {
  const specialistId = new Types.ObjectId().toHexString();
  const slot = await SlotModel.create({ specialistId, date: '20991231', startTime: '10:00 AM', endTime: '10:15 AM', duration: 15,
    maxBookings: 1, currentBookings: 0, isActive: true, isAvailable: true, slotType: 'consultation' } as never);
  const b = await createBookingWithHolds({ bookingType: 'consultation', userId: user, specialistId, slotId: String(slot._id),
    bookingDate: '20991231', bookingTime: '10:00 AM', serviceMode: 'video', consultationMode: 'video', primaryConcern: 'x',
    status: 'pending', paymentStatus: 'pending', price: 100 } as never);
  const id = String(b._id);
  if (walletUse) {
    await fundBookingFromWallet({ model: BookingModel, kind: 'booking', bookingId: id, userId: user, gross: 100, requested: walletUse,
      legacyFunded: 0, wallets: new WalletRepository() });
  }
  const orderId = 'order_' + new Types.ObjectId().toHexString();
  const rec = await PaymentRecordModel.create({ userId: user, context: 'booking', contextId: id, baseAmount: 100, discountAmount: 0,
    finalAmount: 100 - walletUse, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: orderId, status: 'created',
    notes: { walletDeductedAmount: walletUse } });
  await BookingModel.collection.updateOne({ _id: new Types.ObjectId(id) },
    { $set: { paymentTransactionId: String(rec._id), createdAt: new Date(Date.now() - ageMin * MIN) } });
  return { id, slotId: String(slot._id), record: String(rec._id), orderId };
}
const captured = (orderId: string, paise: number) => ({ id: 'pay_' + new Types.ObjectId().toHexString(), order_id: orderId, amount: paise, currency: 'INR', status: 'captured' });
const row = (id: string) => BookingModel.findById(id).lean() as Promise<Record<string, unknown> & { status: string; paymentStatus: string }>;
const seats = async (slotId: string) => Number((await SlotModel.findById(slotId).lean())!.currentBookings);
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

  await check('an unpaid booking expires after 30 minutes: slot released, wallet money returned, cause recorded', async () => {
    const u = await customer(40);
    const b = await booking(u, 31, 40);           // ₹40 from the wallet, ₹60 never paid
    assert.equal(await balance(u), 0); assert.equal(await seats(b.slotId), 1);
    const r = await bookings.expireUnpaidBookings(new Date());
    assert.ok(r.expired >= 1);
    const bk = await row(b.id);
    assert.equal(bk.status, 'cancelled'); assert.equal(bk.cancellationCause, 'payment_timeout');
    assert.equal(await seats(b.slotId), 0, 'seat released');
    assert.equal(await balance(u), 40, 'wallet money returned');
    assert.ok(cleared.includes(b.id), 'reminders cleared');
  });

  await check('inside its window, or already confirmed, a booking is left alone', async () => {
    const u = await customer();
    const young = await booking(u, 29);
    const confirmed = await booking(u, 60);
    await BookingModel.updateOne({ _id: confirmed.id }, { $set: { status: 'confirmed', paymentStatus: 'paid' } });
    await bookings.expireUnpaidBookings(new Date());
    assert.equal((await row(young.id)).status, 'pending');
    assert.equal((await row(confirmed.id)).status, 'confirmed');
    assert.deepEqual(await expireUnpaidBooking({ bookingId: confirmed.id, now: new Date(), wallets: new WalletRepository(), cancelledAt: '20261114', lifecycle: () => undefined as never }),
      { expired: false, reason: 'not_pending' });
  });

  await check('a payment captured at Razorpay (confirmation lost) is applied instead of expiring the booking', async () => {
    const u = await customer();
    const b = await booking(u, 45);
    gateway.set(b.orderId, [captured(b.orderId, 10000)]);
    await bookings.expireUnpaidBookings(new Date());
    const bk = await row(b.id);
    assert.equal(bk.paymentStatus, 'paid'); assert.equal(bk.status, 'confirmed');
    assert.equal(await seats(b.slotId), 1, 'seat kept');
  });

  await check('when the gateway cannot be asked, the booking is deferred with back-off, not expired', async () => {
    const u = await customer();
    const b = await booking(u, 45);
    unreachable.add(b.orderId);
    const t0 = new Date();
    await bookings.expireUnpaidBookings(t0);
    let bk = await row(b.id);
    assert.equal(bk.status, 'pending');
    const next = new Date(bk.expiryNextAt as Date).getTime();
    assert.equal(next - t0.getTime(), 5 * MIN);
    await bookings.expireUnpaidBookings(new Date(t0.getTime() + MIN)); // not due yet
    assert.equal((await row(b.id)).status, 'pending');
    unreachable.delete(b.orderId);
    await bookings.expireUnpaidBookings(new Date(t0.getTime() + 6 * MIN));
    bk = await row(b.id);
    assert.equal(bk.status, 'cancelled'); assert.equal(bk.cancellationCause, 'payment_timeout');
  });

  await check('a payment that lands after the gateway check but before the expiry write wins: nothing is cancelled', async () => {
    const u = await customer();
    const b = await booking(u, 45);
    // The scan saw nothing; then verify marked the record paid. The expiry transaction must see it.
    await PaymentRecordModel.updateOne({ _id: b.record }, { $set: { status: 'paid' } });
    const r = await expireUnpaidBooking({ bookingId: b.id, now: new Date(), wallets: new WalletRepository(), cancelledAt: '20261114', lifecycle: () => undefined as never });
    assert.deepEqual(r, { expired: false, reason: 'paid' });
    assert.equal((await row(b.id)).status, 'pending');
    assert.equal(await seats(b.slotId), 1);
  });

  await check('after the deadline "Pay now" is refused (no new order); before it, the open order is reused', async () => {
    const u = await customer();
    const late = await booking(u, 31);
    await rejects(bookings.retryBookingPayment(late.id, { _id: u, userType: 'user' }, {}), 'BOOKING_PAYMENT_EXPIRED', 409);
    assert.equal(await PaymentRecordModel.countDocuments({ contextId: late.id }), 1, 'no new order');
    const ok = await booking(u, 10);
    const r = await bookings.retryBookingPayment(ok.id, { _id: u, userType: 'user' }, {}) as { payment: { paymentTransactionId: string } };
    assert.equal(String(r.payment.paymentTransactionId), ok.record);
    // A payment captured just before the deadline is still applied even if "Pay now" comes after it.
    const won = await booking(u, 31);
    gateway.set(won.orderId, [captured(won.orderId, 10000)]);
    await rejects(bookings.retryBookingPayment(won.id, { _id: u, userType: 'user' }, {}), 'BOOKING_ALREADY_PAID', 400);
    assert.equal((await row(won.id)).paymentStatus, 'paid');
  });

  await check('a capture arriving after the booking expired goes back to the wallet', async () => {
    const u = await customer();
    const b = await booking(u, 40);
    await bookings.expireUnpaidBookings(new Date());
    assert.equal((await row(b.id)).status, 'cancelled');
    gateway.set(b.orderId, [captured(b.orderId, 10000)]);       // paid late at Razorpay
    await payments.sweepUnsettledBookingPayments(new Date(Date.now() + 11 * MIN));
    assert.equal(await balance(u), 100, 'returned to the wallet');
    assert.equal((await row(b.id)).status, 'cancelled', 'not revived');
  });

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
