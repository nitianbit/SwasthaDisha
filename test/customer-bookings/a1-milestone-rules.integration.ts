/**
 * Option A, phase A1: the milestone's (e8eb9bd) non-ledger protections ported onto the release line, against a real
 * MongoDB replica set. Booking/payment services are built from their prototypes with real repositories (as in the
 * booking-retry suite); only payment-order creation, reminders and notifications are stubbed. The milestone's own
 * test/customer-profile/focused.mjs and test/customer-bookings/controllers.mjs cover the profile and controller files,
 * which were taken over unchanged.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/a1_rules_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/customer-bookings/a1-milestone-rules.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { AuthService } from '@/modules/auth/services';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import { enforceUserCancellationWindow } from '@/modules/common/utils/cancellationWindow';
import { normalizeCouponDiscount } from '@/modules/common/utils/couponMoney';
import { CorporateRepository } from '@/modules/corporates/repository';
import ExternalBookingModel from '@/modules/externalBookings/model';
import { ExternalBookingRepository } from '@/modules/externalBookings/repository';
import { ExternalBookingService } from '@/modules/externalBookings/services';
import { completeExternalBookingAfterPayment } from '@/modules/externalBookings/services/externalBookingPaymentFinalize';
import { NotificationRepository } from '@/modules/notification/repository';
import { NotificationService } from '@/modules/notification/services';
import { OTPRepository } from '@/modules/otp/repository';
import { OTPService } from '@/modules/otp/services';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import UserModel from '@/modules/user/model';
import { UserRepository } from '@/modules/user/repository';
import { UserService } from '@/modules/user/services';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/a1_rules_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const HOUR = 3600_000;
/** IST appointment fields for an instant (what a customer sees on the booking). */
function ist(at: Date): { bookingDate: string; bookingTime: string } {
  const d = new Date(at.getTime() + 5.5 * HOUR);
  const p = (n: number) => String(n).padStart(2, '0');
  return { bookingDate: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`, bookingTime: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` };
}
const inHours = (h: number) => ist(new Date(Date.now() + h * HOUR));
async function rejects(p: Promise<unknown> | (() => unknown), code: string, status?: number) {
  const run = typeof p === 'function' ? Promise.resolve().then(p) : p;
  await assert.rejects(run, (e: { code?: string; status?: number }) => e.code === code && (status === undefined || e.status === status));
}

// Ordinary bookings: real service methods (cancel window not stubbed), real repositories.
const bookings = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), paymentService: {},
  couponService: { incrementUsage: async () => undefined, decrementUsage: async () => undefined, getByCode: async () => ({ _id: 'c' }) },
  bookingReminderScheduler: { scheduleBookingReminders: async () => undefined, clearBookingReminders: async () => undefined },
  sendPaidBookingEmailNotification: async () => undefined, notificationService: {},
}) as BookingService & Record<string, unknown>;
const payments = Object.assign(Object.create(PaymentService.prototype), { paymentRepository: new PaymentRepository() }) as unknown as
  { markPaymentAsPaid: (r: object, d: object) => Promise<{ status: string }> };
const externals = Object.assign(Object.create(ExternalBookingService.prototype), {
  externalBookingRepository: new ExternalBookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(),
}) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;

async function customer(balance = 0) {
  const user = new Types.ObjectId().toHexString();
  await WalletModel.create({ userId: user, balance, isActive: true });
  return user;
}
async function booking(user: string, at: { bookingDate: string; bookingTime: string }, paid: boolean) {
  const { insertedId } = await BookingModel.collection.insertOne({ userId: user, bookingType: 'package', status: 'confirmed',
    paymentStatus: paid ? 'paid' : 'pending', price: 100, ...at } as never);
  return insertedId.toHexString();
}
const cancel = (id: string, user: string, userType = 'user') => bookings.cancelBooking(id, { cancellationReason: 'x' }, { _id: user, userType });

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(url);
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await Promise.all([BookingModel.init(), ExternalBookingModel.init(), PaymentRecordModel.init(), WalletModel.init(), WalletTransactionModel.init(), UserModel.init()]);

  await check('[B1] window: IST, 24 h (48 h for a Monday) for customers; nobody cancels a started appointment; bad times refused', async () => {
    const monday = { bookingDate: '20261116', bookingTime: '10:00' };                 // Mon 16 Nov 2026, 10:00 IST
    const tuesday = { bookingDate: '20261117', bookingTime: '10:00 AM' };
    const at = (s: string) => new Date(s);
    await rejects(() => enforceUserCancellationWindow([monday], 'user', at('2026-11-15T00:00:00Z')), 'CANCELLATION_WINDOW_CLOSED', 400); // ~28.5 h
    enforceUserCancellationWindow([monday], 'user', at('2026-11-14T04:00:00Z'));                                                      // ~48.5 h
    enforceUserCancellationWindow([tuesday], 'user', at('2026-11-16T04:00:00Z'));                                                     // ~24.5 h
    await rejects(() => enforceUserCancellationWindow([tuesday], 'user', at('2026-11-16T05:00:00Z')), 'CANCELLATION_WINDOW_CLOSED', 400); // 23.5 h
    enforceUserCancellationWindow([monday], 'admin', at('2026-11-16T04:00:00Z'));                                                     // admin, 30 min before
    await rejects(() => enforceUserCancellationWindow([monday], 'admin', at('2026-11-16T04:31:00Z')), 'BOOKING_ALREADY_STARTED', 400);
    await rejects(() => enforceUserCancellationWindow([{ bookingDate: '20261116', bookingTime: '25:00' }], 'user'), 'INVALID_BOOKING_DATETIME', 400);
    await rejects(() => enforceUserCancellationWindow([{ bookingDate: '20261131', bookingTime: '10:00' }], 'user'), 'INVALID_BOOKING_DATETIME', 400);
  });

  await check('[B2] inside the window a customer cancel is refused when money was captured (paid, or pending with a paid record); unpaid, outside it, or as admin, it cancels', async () => {
    const u = await customer();
    const paidSoon = await booking(u, inHours(3), true);
    await rejects(cancel(paidSoon, u), 'CANCELLATION_WINDOW_CLOSED', 400);
    assert.equal((await BookingModel.findById(paidSoon).lean())!.status, 'confirmed');
    // The payment record is already paid while the booking still says pending (the gap Codex found): still refused.
    const recordPaid = await booking(u, inHours(3), false);
    await PaymentRecordModel.create({ userId: u, context: 'booking', contextId: recordPaid, baseAmount: 100, discountAmount: 0, finalAmount: 100,
      currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_' + recordPaid, status: 'paid' });
    await rejects(cancel(recordPaid, u), 'CANCELLATION_WINDOW_CLOSED', 400);
    // A2a: the decision is serialized with capture, so an unpaid booking is exempt again (milestone B2).
    const unpaidSoon = await booking(u, inHours(3), false);
    assert.equal((await cancel(unpaidSoon, u)).status, 'cancelled', 'unpaid: no window');
    const paidLater = await booking(u, inHours(96), true);
    assert.equal((await cancel(paidLater, u)).status, 'cancelled', 'outside the window');
    const admin = new Types.ObjectId().toHexString();
    assert.equal((await cancel(paidSoon, admin, 'admin')).status, 'cancelled', 'admin within the cut-off');
  });

  await check('[B2] completed history is never cancelled: a past unpaid completed booking, and a completion landing mid-cancel', async () => {
    const u = await customer();
    const { insertedId } = await BookingModel.collection.insertOne({ userId: u, bookingType: 'package', status: 'completed', paymentStatus: 'pending',
      price: 100, ...inHours(-48) } as never);
    const admin = new Types.ObjectId().toHexString();
    await rejects(cancel(insertedId.toHexString(), admin, 'admin'), 'BOOKING_NOT_CANCELLABLE', 409);
    // A cancel that read the booking as confirmed; completion commits before its write: the fenced write refuses it.
    const id = await booking(u, inHours(96), false);
    const stale = { ...(await BookingModel.findById(id).lean())!, status: 'confirmed' };
    await BookingModel.updateOne({ _id: id }, { $set: { status: 'completed' } });
    const staleService = Object.assign(Object.create(bookings), { getById: async () => stale }) as BookingService;
    await rejects(staleService.cancelBooking(id, {}, { _id: u, userType: 'user' }), 'BOOKING_NOT_CANCELLABLE', 409);
    assert.equal((await BookingModel.findById(id).lean())!.status, 'completed', 'completed history kept');
  });

  await check('[E8] generic edit cannot cancel/pay/move a booking; cancelled history is frozen; delete is refused', async () => {
    const u = await customer();
    const id = await booking(u, inHours(96), true);
    for (const patch of [{ status: 'cancelled' }, { paymentStatus: 'refunded' }, { paymentTransactionId: 'x' }, { slotId: 'y' }, { bookingDate: '20991231' }]) {
      await rejects(bookings.update(id, patch as never, u), 'DEDICATED_BOOKING_COMMAND_REQUIRED', 409);
    }
    assert.equal((await bookings.update(id, { notes: 'call before' } as never, u)).status, 'confirmed', 'ordinary edits still work');
    await rejects(bookings.delete(id, u), 'BOOKING_RETENTION_REQUIRED', 409);
    assert.ok(await BookingModel.exists({ _id: id }), 'history retained');
    await cancel(id, u);
    await rejects(bookings.update(id, { notes: 'rewrite' } as never, u), 'BOOKING_CANCELLED', 409);
  });

  await check('[E10] a refunded payment record is never revived to paid by a replayed verify; a paid replay answers with the record', async () => {
    const mk = (status: string) => PaymentRecordModel.create({ userId: 'u', context: 'booking', contextId: 'b', baseAmount: 10, discountAmount: 0,
      finalAmount: 10, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_' + new Types.ObjectId().toHexString(), status });
    const refunded = await mk('refunded');
    await rejects(payments.markPaymentAsPaid(refunded.toObject(), { razorpayPaymentId: 'pay_x', razorpaySignature: 's' }), 'PAYMENT_CHANGED', 409);
    assert.equal((await PaymentRecordModel.findById(refunded._id).lean())!.status, 'refunded');
    const paid = await mk('paid');
    assert.equal((await payments.markPaymentAsPaid(paid.toObject(), { razorpayPaymentId: 'pay_y', razorpaySignature: 's' })).status, 'paid');
    const created = await mk('created');
    assert.equal((await payments.markPaymentAsPaid(created.toObject(), { razorpayPaymentId: 'pay_z', razorpaySignature: 's' })).status, 'paid');
  });

  await check('[C6] coupon discounts are rounded once to paise and final = base - discount exactly; bad calculations refused', async () => {
    assert.deepEqual(normalizeCouponDiscount(100, 33.3333, 'X'), { discountAmount: 33.33, finalAmount: 66.67 });
    assert.deepEqual(normalizeCouponDiscount(99.99, 10.005, 'X'), { discountAmount: 10.01, finalAmount: 89.98 });
    assert.deepEqual(normalizeCouponDiscount(50, undefined, 'X'), { discountAmount: 0, finalAmount: 50 });
    await rejects(() => normalizeCouponDiscount(50, 50.01, 'X'), 'X', 409);
    await rejects(() => normalizeCouponDiscount(50, -1, 'X'), 'X', 409);
    await rejects(() => normalizeCouponDiscount(50, Number.NaN, 'X'), 'X', 409);
    await rejects(() => normalizeCouponDiscount(10.005, 1, 'X'), 'X', 409);
  });

  await check('[A4/A5] external detail is owner/admin only and hides the ledger; list matches only scalar userIds; no default integration filter', async () => {
    const u = await customer(), other = await customer();
    const { insertedId } = await ExternalBookingModel.collection.insertOne({ userId: u, corporateId: 'c', integration: 'healthians', status: 'confirmed',
      paymentStatus: 'paid', price: 100, walletFunding: { total: 20, revision: 1, closed: false, captures: [] }, ...inHours(96) } as never);
    const id = insertedId.toHexString();
    await ExternalBookingModel.collection.insertOne({ userId: [u] as never, corporateId: 'c', integration: 'labstack', status: 'confirmed' } as never);
    await ExternalBookingModel.collection.insertOne({ userId: u, corporateId: 'c', integration: 'labstack', status: 'confirmed' } as never);
    const mine = await externals.getBookingById(id, { _id: u, userType: 'user' }) as Record<string, unknown>;
    assert.equal(String(mine._id), id); assert.equal(mine.walletFunding, undefined, 'ledger not exposed');
    await rejects(externals.getBookingById(id, { _id: other, userType: 'user' }), 'EXTERNAL_BOOKING_NOT_FOUND', 404);
    await rejects(externals.getBookingById(id, { _id: other, userType: 'pharmacy' }), 'FORBIDDEN', 403);
    assert.equal(String((await externals.getBookingById(id, { _id: other, userType: 'admin' }) as { _id: unknown })._id), id);
    const list = await externals.listBookings({ userId: u }) as { data: { integration: string; userId: unknown }[] };
    assert.equal(list.data.length, 2, 'both integrations, and never the array-userId row');
    assert.ok(list.data.every(b => b.userId === u));
  });

  await check('[D7] provider webhook only records the observation: no status, money or provider effect', async () => {
    const u = await customer(0);
    const { insertedId } = await ExternalBookingModel.collection.insertOne({ userId: u, integration: 'healthians', status: 'confirmed', paymentStatus: 'paid',
      price: 100, externalBookingId: 'HL-778', ...inHours(96) } as never);
    const out = await externals.syncBookingFromWebhook({ booking_id: 'HL-778', bookingId: 'HL-778', status: 'cancelled', booking_status: 'cancelled' }) as { matched: boolean; reason?: string };
    const b = (await ExternalBookingModel.findById(insertedId).lean())! as unknown as { status: string; paymentStatus: string; meta?: Record<string, unknown> };
    if (out.matched) {
      assert.equal(out.reason, 'provider_authentication_unproven');
      assert.equal(b.meta?.providerEventReconciliationRequired, true);
    }
    assert.equal(b.status, 'confirmed'); assert.equal(b.paymentStatus, 'paid');
    assert.equal(await WalletTransactionModel.countDocuments({ userId: u }), 0, 'no refund');
  });

  await check('[B3] paid external booking inside the window: customer cancel refused before any provider/refund effect', async () => {
    const u = await customer(0);
    const { insertedId } = await ExternalBookingModel.collection.insertOne({ userId: u, integration: 'healthians', providerType: 'DIAGNOSTICS',
      status: 'confirmed', paymentStatus: 'paid', price: 100, externalBookingId: 'HL-1', ...inHours(3) } as never);
    await rejects(externals.cancelBooking(insertedId.toHexString(), { _id: u, userType: 'user' }, {}, 'diagnostics'), 'CANCELLATION_WINDOW_CLOSED', 400);
    assert.equal((await ExternalBookingModel.findById(insertedId).lean())!.status, 'confirmed');
    assert.equal(await WalletTransactionModel.countDocuments({ userId: u }), 0);
    const unpaid = await ExternalBookingModel.collection.insertOne({ userId: u, integration: 'healthians', providerType: 'DIAGNOSTICS',
      status: 'pending_payment', paymentStatus: 'pending', price: 100, ...inHours(3) } as never);
    await rejects(externals.cancelBooking(unpaid.insertedId.toHexString(), { _id: u, userType: 'user' }, {}, 'diagnostics'), 'CANCELLATION_WINDOW_CLOSED', 400);
    assert.equal((await ExternalBookingModel.findById(unpaid.insertedId).lean())!.status, 'pending_payment', 'external unpaid too, until A2b');
  });

  await check('[D8/D9] Healthians: the slot is frozen right before the order is placed, and the post-coupon total incl. wallet is sent', async () => {
    const u = await customer(0);
    const { insertedId } = await ExternalBookingModel.collection.insertOne({ userId: u, integration: 'healthians', providerType: 'DIAGNOSTICS',
      appointmentType: 'home_collection', status: 'pending_payment', paymentStatus: 'pending', price: 100, patientName: 'Asha', patientPhone: '9811100009',
      meta: { stmId: 'STM-5', packageIds: ['P1'] }, ...inHours(96) } as never);
    const rec = await PaymentRecordModel.create({ userId: u, context: 'external_booking', contextId: insertedId.toHexString(), baseAmount: 100,
      discountAmount: 20, finalAmount: 60, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_hl', status: 'paid',
      notes: { walletDeductedAmount: 20 } });
    const calls: string[] = []; let sent: Record<string, unknown> = {};
    const healthians = {
      freezeDiagnosticsSlot: async (a: { stmId: string }) => { calls.push('freeze:' + a.stmId); return {}; },
      placeDiagnosticsOrder: async (a: Record<string, unknown>) => { calls.push('place'); sent = a; return { externalBookingId: 'HL-9', externalStatus: 'confirmed', payload: {} }; },
    };
    await completeExternalBookingAfterPayment(rec.toObject() as never, new ExternalBookingRepository(), {} as never, healthians as never);
    assert.deepEqual(calls, ['freeze:STM-5', 'place']);
    assert.equal(sent.discountedPrice, 80, 'gross 100 - coupon 20 (gateway 60 + wallet 20), not 100 and not 60');
  });

  await check('[F4] a customer may add or re-verify an email; replacing an existing one is admin-only; a concurrent change is a conflict', async () => {
    const mail: { textBody: string }[] = [];
    const userRepository = new UserRepository();
    const auth = new (AuthService as unknown as new (...a: unknown[]) => AuthService)(userRepository, {}, {}, {}, {}, {},
      new OTPService(new OTPRepository()), { getByUserId: async () => ({}) }, new NotificationService(new NotificationRepository(), userRepository, {} as never),
      { sendEmail: async (m: { textBody: string }) => { mail.push(m); return { success: true }; } }, {});
    const otp = () => /(\d{6})/.exec(mail[mail.length - 1].textBody)![1];
    const u = await UserModel.create({ phone: '9811100001', userType: 'user', isActive: true });
    const id = String(u._id);
    await auth.sendEmailVerificationOTP(id, { email: 'first@example.com' } as never);
    await auth.verifyEmailVerificationOTP(id, { otp: otp(), email: 'first@example.com' } as never, 0);
    assert.equal((await UserModel.findById(id).lean())!.email, 'first@example.com');
    await rejects(auth.sendEmailVerificationOTP(id, { email: 'second@example.com' } as never), 'EMAIL_CHANGE_ADMIN_ONLY', 422);
    await auth.sendEmailVerificationOTP(id, { email: 'first@example.com' } as never);
    await auth.verifyEmailVerificationOTP(id, { otp: otp() } as never, 0);             // omitted target = stored email
    const v = await UserModel.create({ phone: '9811100002', userType: 'user', isActive: true });
    await auth.sendEmailVerificationOTP(String(v._id), { email: 'mine@example.com' } as never);
    const code = otp();
    await UserModel.updateOne({ _id: v._id }, { $set: { email: 'admin-set@example.com' } }); // admin changed it meanwhile
    await rejects(auth.verifyEmailVerificationOTP(String(v._id), { otp: code, email: 'mine@example.com' } as never, 0), 'EMAIL_CHANGE_ADMIN_ONLY', 422);
    assert.equal((await UserModel.findById(v._id).lean())!.email, 'admin-set@example.com');
  });

  await check('[F1] profile: a customer fills a missing contact but cannot replace one; HR is limited to its own corporate', async () => {
    const users = new UserService(new UserRepository(), new CorporateRepository());
    const corpA = new Types.ObjectId().toHexString(), corpB = new Types.ObjectId().toHexString();
    const u = await UserModel.create({ phone: '9811100003', userType: 'user', isActive: true, corporateId: corpA });
    const id = String(u._id);
    await users.update(id, { email: 'Fill@Example.com', name: 'Asha' } as never, { _id: id, userType: 'user' });
    const after = (await UserModel.findById(id).lean())!;
    assert.equal(after.email, 'fill@example.com'); assert.equal(after.name, 'Asha');
    await users.update(id, { phone: '9811199999' } as never, { _id: id, userType: 'user' });
    assert.equal((await UserModel.findById(id).lean())!.phone, '9811100003', 'existing phone not replaced by the customer');
    await rejects(users.update(id, { name: 'X' } as never, { _id: new Types.ObjectId().toHexString(), userType: 'user' }), 'FORBIDDEN', 403);
    await rejects(users.update(id, { name: 'X' } as never, { _id: new Types.ObjectId().toHexString(), userType: 'hr', corporateId: corpB }), 'FORBIDDEN', 403);
    await users.update(id, { name: 'Asha K' } as never, { _id: new Types.ObjectId().toHexString(), userType: 'hr', corporateId: corpA });
    assert.equal((await UserModel.findById(id).lean())!.name, 'Asha K');
  });

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
