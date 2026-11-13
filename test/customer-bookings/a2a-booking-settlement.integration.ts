/**
 * Option A, phase A2a: ordinary-booking holds and one-transaction cancellation (bookings/holds.ts) on the walletFunding
 * ledger, against a real MongoDB replica set. BookingService.cancelBooking/rescheduleBooking run for real (window not
 * stubbed); only reminders, meetings and notifications are stubbed. After every money scenario the customer's wallet
 * balance must equal their ledger.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/a2a_settlement_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/customer-bookings/a2a-booking-settlement.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import '@/modules/user/model';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import { cancelBookingSettlement, createBookingWithHolds } from '@/modules/bookings/holds';
import { recordGatewayCapture, runLedgerTransaction as runInTxn } from '@/modules/common/utils/bookingWalletFunding';
import { CouponModel } from '@/modules/coupon/model';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import SlotModel from '@/modules/slots/model';
import { SlotRepository } from '@/modules/slots/repository';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { IBooking } from '@/modules/bookings/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/a2a_settlement_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const HOUR = 3600_000;
function ist(at: Date) {
  const d = new Date(at.getTime() + 5.5 * HOUR); const p = (n: number) => String(n).padStart(2, '0');
  return { bookingDate: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`, bookingTime: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` };
}
const inHours = (h: number) => ist(new Date(Date.now() + h * HOUR));
async function rejects(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: { code?: string; status?: number }) => e.code === code && (status === undefined || e.status === status));
}

const payments = Object.assign(Object.create(PaymentService.prototype), { paymentRepository: new PaymentRepository() }) as PaymentService;
const service = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), slotRepository: new SlotRepository(), paymentService: payments,
  slotService: { getById: async (id: string) => (await SlotModel.findById(id).lean())! },
  bookingReminderScheduler: { scheduleBookingReminders: async () => undefined, clearBookingReminders: async () => undefined },
  notificationService: { createSpecialistAppointmentCancelledNotification: async () => undefined },
}) as BookingService;

const specialist = new Types.ObjectId().toHexString();
async function slot(at: { bookingDate: string; bookingTime: string }, max = 1, current = 0) {
  const s = await SlotModel.create({ specialistId: specialist, date: at.bookingDate, startTime: at.bookingTime, endTime: '23:59',
    maxBookings: max, currentBookings: current, isAvailable: current < max, isActive: true, slotType: 'consultation' });
  return String(s._id);
}
async function customer(balance = 0) {
  const user = new Types.ObjectId().toHexString();
  const w = await WalletModel.create({ userId: user, balance, isActive: true });
  if (balance) await WalletTransactionModel.create({ userId: user, walletId: w._id, transactionType: 'credit', amount: balance,
    balanceBefore: 0, balanceAfter: balance, status: 'completed', referenceType: 'seed', transactionDate: '20261113' });
  return user;
}
const draft = (user: string, slotId: string, at: { bookingDate: string; bookingTime: string }, extra: Partial<IBooking> = {}): IBooking => ({
  bookingType: 'consultation', serviceMode: 'video', userId: user, specialistId: specialist, slotId, ...at, price: 100, status: 'pending', paymentStatus: 'pending',
  ...extra } as IBooking);
const slotRow = async (id: string) => (await SlotModel.findById(id).lean())!;
const balance = async (u: string) => Number((await WalletModel.findOne({ userId: u }).lean())?.balance);
async function ledgerMatches(u: string) {
  const sum = (await WalletTransactionModel.find({ userId: u }).lean()).reduce((a, t) => a + (t.transactionType === 'debit' ? -t.amount : t.amount), 0);
  assert.equal(Math.round(sum * 100), Math.round((await balance(u)) * 100), 'wallet balance == ledger');
}
/** A booking paid ₹100: ₹30 wallet funding + ₹70 captured gateway payment (with a coupon on the record). */
async function paidBooking(user: string, slotId: string, at: { bookingDate: string; bookingTime: string }, coupon?: string) {
  const b = await createBookingWithHolds(draft(user, slotId, at));
  const id = String(b._id);
  const rec = await PaymentRecordModel.create({ userId: user, context: 'booking', contextId: id, baseAmount: 100, discountAmount: 0, finalAmount: 70,
    currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_' + id, status: 'paid', isProcessed: true, couponCode: coupon,
    notes: { walletDeductedAmount: 30 } });
  await BookingModel.updateOne({ _id: id }, { $set: { status: 'confirmed', paymentStatus: 'paid', paymentTransactionId: String(rec._id),
    walletFunding: { total: 30, revision: 1, closed: false, captures: [{ recordId: String(rec._id), amount: 70, state: 'applied' }] } } });
  await WalletModel.updateOne({ userId: user }, { $inc: { balance: -30 } });
  await WalletTransactionModel.create({ userId: user, transactionType: 'debit', amount: 30, balanceBefore: 0, balanceAfter: 0, status: 'completed',
    referenceType: 'booking', referenceId: id, transactionDate: '20261113', walletId: (await WalletModel.findOne({ userId: user }).lean())!._id });
  return { id, rec: String(rec._id) };
}
const finalize = (rec: unknown) => (payments as unknown as { finalizePaymentProcessing: (r: unknown) => Promise<unknown> }).finalizePaymentProcessing(rec);
const usage = async (code: string) => (await CouponModel.findOne({ code }).lean())!.currentUsageCount;
async function coupon(code: string, count: number) {
  await CouponModel.create({ code, currentUsageCount: count, discountType: 'percentage', discountValue: 10, applicableTo: 'all',
    startDate: '20260101', endDate: '20991231', isActive: true } as never);
}
const cancel = (id: string, user: string, userType = 'user') => service.cancelBooking(id, { cancellationReason: 'x' }, { _id: user, userType });

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(url);
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await Promise.all([BookingModel.init(), SlotModel.init(), PaymentRecordModel.init(), WalletModel.init(), WalletTransactionModel.init(), CouponModel.init()]);

  await check('[C1] five concurrent bookings for a 2-seat slot: exactly two succeed; capacity and availability exact', async () => {
    const at = inHours(96); const s = await slot(at, 2);
    const u = await customer();
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => createBookingWithHolds(draft(u, s, at))));
    assert.equal(r.filter(x => x.status === 'fulfilled').length, 2);
    assert.ok(r.filter(x => x.status === 'rejected').every(x => ['SLOT_NOT_AVAILABLE', 'BOOKING_CHANGED'].includes((x as PromiseRejectedResult).reason.code)));
    const row = await slotRow(s);
    assert.equal(row.currentBookings, 2); assert.equal(row.isAvailable, false);
    assert.equal(await BookingModel.countDocuments({ slotId: s }), 2, 'no booking without its seat');
    await rejects(createBookingWithHolds(draft(u, s, inHours(120))), 'SLOT_NOT_AVAILABLE', 409);   // date mismatch
  });

  await check('[E5] paid cancel is one transaction: refund 100 (wallet 30 + captured 70), record refunded, coupon reversed, seat released — once', async () => {
    const at = inHours(96); const s = await slot(at, 1);
    const u = await customer(30);
    await CouponModel.create({ code: 'SAVE10', currentUsageCount: 3, discountType: 'percentage', discountValue: 10, applicableTo: 'all',
      startDate: '20260101', endDate: '20991231', isActive: true } as never);
    const b = await paidBooking(u, s, at, 'SAVE10');
    const before = (await CouponModel.findOne({ code: 'SAVE10' }).lean())?.currentUsageCount;
    const out = await cancel(b.id, u);
    assert.equal(out.status, 'cancelled');
    assert.equal(await balance(u), 100); await ledgerMatches(u);
    assert.equal((await PaymentRecordModel.findById(b.rec).lean())!.status, 'refunded');
    assert.equal(before, 3);
    assert.equal((await CouponModel.findOne({ code: 'SAVE10' }).lean())!.currentUsageCount, 2, 'coupon usage reversed');
    assert.equal((await slotRow(s)).currentBookings, 0); assert.equal((await slotRow(s)).isAvailable, true);
    const again = await cancel(b.id, u);                                               // repeat: nothing more
    assert.equal(again.status, 'cancelled'); assert.equal(await balance(u), 100);
    assert.equal((await CouponModel.findOne({ code: 'SAVE10' }).lean())!.currentUsageCount, 2, 'not reversed twice');
    assert.equal((await slotRow(s)).currentBookings, 0);
    const holds = (await BookingModel.findById(b.id).lean())!.holds!;
    assert.equal(holds.heldSlotId, null);
    assert.equal((await PaymentRecordModel.findById(b.rec).lean())!.couponUsage, 'reversed');
  });

  await check('[E5] if any part fails (here the refund), nothing commits: still confirmed, seat held, no money moved', async () => {
    const at = inHours(96); const s = await slot(at, 1);
    const u = await customer(30);
    const b = await paidBooking(u, s, at);
    const failing = { postEntry: async () => { throw new Error('ledger down'); } } as unknown as WalletRepository;
    await assert.rejects(cancelBookingSettlement({ bookingId: b.id, requester: { _id: u, userType: 'user' }, reason: 'x', cancelledAt: '20261113',
      lifecycle: () => undefined, enforceWindow: () => undefined, wallets: failing }), /ledger down/);
    const row = (await BookingModel.findById(b.id).lean())!;
    assert.equal(row.status, 'confirmed'); assert.equal(row.walletFunding!.closed, false);
    assert.equal((await slotRow(s)).currentBookings, 1);
    assert.equal((await PaymentRecordModel.findById(b.rec).lean())!.status, 'paid');
    assert.equal(await balance(u), 0); await ledgerMatches(u);
  });

  await check('[B2] window inside the transaction: captured money (even a paid record on a pending booking) refused; unpaid exempt', async () => {
    const u = await customer();
    const soon = inHours(3);
    const paid = await paidBooking(u, await slot(soon), soon);
    await rejects(cancel(paid.id, u), 'CANCELLATION_WINDOW_CLOSED', 400);
    assert.equal((await BookingModel.findById(paid.id).lean())!.status, 'confirmed');
    const s2 = await slot(soon);
    const pend = await createBookingWithHolds(draft(u, s2, soon));
    await PaymentRecordModel.create({ userId: u, context: 'booking', contextId: String(pend._id), baseAmount: 100, discountAmount: 0, finalAmount: 100,
      currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_p_' + String(pend._id), status: 'paid' });
    await rejects(cancel(String(pend._id), u), 'CANCELLATION_WINDOW_CLOSED', 400);
    const unpaid = await createBookingWithHolds(draft(u, await slot(soon), soon));
    assert.equal((await cancel(String(unpaid._id), u)).status, 'cancelled', 'unpaid, inside the window: allowed');
    const done = await createBookingWithHolds(draft(u, await slot(inHours(96)), inHours(96)));
    await BookingModel.updateOne({ _id: done._id }, { $set: { status: 'completed' } });
    await rejects(cancel(String(done._id), u, 'user'), 'BOOKING_NOT_CANCELLABLE', 409);
  });

  await check('[B2] a capture racing an unpaid cancel waits for it, then finds the booking closed: the late capture goes back to the wallet', async () => {
    const soon = inHours(3); const s = await slot(soon);
    const u = await customer(20);
    const b = await createBookingWithHolds(draft(u, s, soon));
    const id = String(b._id);
    const rec = await PaymentRecordModel.create({ userId: u, context: 'booking', contextId: id, baseAmount: 100, discountAmount: 0, finalAmount: 80,
      currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_r_' + id, status: 'created', notes: { walletDeductedAmount: 20 } });
    await BookingModel.updateOne({ _id: id }, { $set: { paymentTransactionId: String(rec._id), walletFunding: { total: 20, revision: 1, closed: false, captures: [] } } });
    await WalletModel.updateOne({ userId: u }, { $inc: { balance: -20 } });
    await WalletTransactionModel.create({ userId: u, transactionType: 'debit', amount: 20, balanceBefore: 20, balanceAfter: 0, status: 'completed',
      referenceType: 'booking', referenceId: id, transactionDate: '20261113', walletId: (await WalletModel.findOne({ userId: u }).lean())!._id });
    // Inside the cancel transaction (after its capture fence), the gateway verify tries to mark the record paid.
    let capture: Promise<unknown> | undefined;
    const real = new WalletRepository();
    const hooked = Object.assign(Object.create(real), { postEntry: async (...a: Parameters<WalletRepository['postEntry']>) => {
      capture ??= PaymentRecordModel.updateOne({ _id: rec._id, status: { $nin: ['paid', 'refunded'] } }, { $set: { status: 'paid' } }).exec();
      await new Promise(r => setTimeout(r, 150));
      return real.postEntry(...a);
    } }) as WalletRepository;
    const out = await cancelBookingSettlement({ bookingId: id, requester: { _id: u, userType: 'user' }, reason: 'x', cancelledAt: '20261113',
      lifecycle: () => undefined, enforceWindow: () => { throw new Error('window must not apply: the booking was unpaid at decision time'); }, wallets: hooked });
    assert.equal(out.booking.status, 'cancelled');
    await capture;                                                                      // the paid write lands only after the commit
    assert.equal((await PaymentRecordModel.findById(rec._id).lean())!.status, 'paid');
    // Payment processing then meets a closed ledger: the late ₹80 goes back to the wallet, exactly once.
    for (let i = 0; i < 2; i++) {
      const r = await recordGatewayCapture({ model: BookingModel, kind: 'booking', bookingId: id, userId: u, recordId: String(rec._id), amount: 80,
        gross: 100, legacyFunded: 0, applicable: () => true });
      assert.equal(r.state, 'returned');
    }
    assert.equal(await balance(u), 100); await ledgerMatches(u);
  });

  await check('[C3] reschedule moves the seat atomically; a full target slot changes nothing', async () => {
    const at = inHours(96), at2 = inHours(120);
    const a = await slot(at), full = await slot(at2, 1, 1), free = await slot(at2, 1);
    const u = await customer();
    const b = await createBookingWithHolds(draft(u, a, at));
    await rejects(service.rescheduleBooking(String(b._id), { slotId: full }, { _id: u, userType: 'user' }), 'SLOT_NOT_AVAILABLE');
    assert.equal((await slotRow(a)).currentBookings, 1); assert.equal((await slotRow(full)).currentBookings, 1);
    const moved = await service.rescheduleBooking(String(b._id), { slotId: free }, { _id: u, userType: 'user' });
    assert.equal(moved.slotId, free); assert.equal(moved.bookingDate, at2.bookingDate);
    assert.equal((await slotRow(a)).currentBookings, 0); assert.equal((await slotRow(free)).currentBookings, 1);
    assert.equal((await BookingModel.findById(b._id).lean())!.holds!.heldSlotId, free);
    await cancel(String(b._id), u);
    assert.equal((await slotRow(free)).currentBookings, 0, 'cancel releases the moved hold');
  });

  await check('[C4] a follow-up benefit is taken once (concurrent follow-ups: one wins) and restored by the cancel', async () => {
    const u = await customer();
    const { insertedId: parent } = await BookingModel.collection.insertOne({ userId: u, bookingType: 'consultation', status: 'completed',
      paymentStatus: 'paid', price: 100, followUp: { isFollowUp: false, benefitUsed: false } } as never);
    const at = inHours(96); const s = await slot(at, 5);
    const fu = () => createBookingWithHolds(draft(u, s, at, { followUp: { isFollowUp: true, parentConsultationId: parent.toHexString() } } as never));
    const r = await Promise.allSettled([fu(), fu(), fu()]);
    const won = r.filter(x => x.status === 'fulfilled') as PromiseFulfilledResult<IBooking>[];
    assert.equal(won.length, 1);
    assert.equal((await BookingModel.findById(parent).lean())!.followUp!.benefitUsed, true);
    assert.equal((await slotRow(s)).currentBookings, 1, 'losers took no seat');
    await cancel(String(won[0].value._id), u);
    assert.equal((await BookingModel.findById(parent).lean())!.followUp!.benefitUsed, false);
  });

  await check('legacy booking (no holds): its seat and follow-up are released once; a surgery booking releases no seat', async () => {
    const u = await customer();
    const at = inHours(96); const s = await slot(at, 2, 1);
    const { insertedId: parent } = await BookingModel.collection.insertOne({ userId: u, bookingType: 'consultation', status: 'completed',
      followUp: { benefitUsed: true } } as never);
    const { insertedId } = await BookingModel.collection.insertOne({ userId: u, bookingType: 'consultation', status: 'pending', paymentStatus: 'pending',
      price: 100, slotId: s, specialistId: specialist, ...at, followUp: { isFollowUp: true, parentConsultationId: parent.toHexString() } } as never);
    await cancel(insertedId.toHexString(), u); await cancel(insertedId.toHexString(), u);
    assert.equal((await slotRow(s)).currentBookings, 0);
    assert.equal((await BookingModel.findById(parent).lean())!.followUp!.benefitUsed, false);
    const s2 = await slot(at, 2, 1);
    const { insertedId: surg } = await BookingModel.collection.insertOne({ userId: u, bookingType: 'surgery', status: 'pending', paymentStatus: 'pending',
      price: 0, slotId: s2, ...at } as never);
    await cancel(surg.toHexString(), u);
    assert.equal((await slotRow(s2)).currentBookings, 1, 'surgery never held a seat');
  });

  await check('[A2a-1] an earlier paid attempt the ledger never registered (booking now links a newer attempt) is returned on cancel, once', async () => {
    const at = inHours(96); const u = await customer(30);
    const b = await paidBooking(u, await slot(at), at);                                 // P0: ₹30 wallet + ₹70 applied
    const p1 = await PaymentRecordModel.create({ userId: u, context: 'booking', contextId: b.id, baseAmount: 100, discountAmount: 0, finalAmount: 70,
      currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_p1_' + b.id, status: 'paid', isProcessed: true });   // captured, crash before registration
    const p2 = await PaymentRecordModel.create({ userId: u, context: 'booking', contextId: b.id, baseAmount: 100, discountAmount: 0, finalAmount: 70,
      currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_p2_' + b.id, status: 'created' });
    await BookingModel.updateOne({ _id: b.id }, { $set: { paymentTransactionId: String(p2._id) } });
    const out = await cancel(b.id, u);
    assert.equal(out.status, 'cancelled');
    assert.equal(await balance(u), 170, '30 funding + 70 applied + 70 unregistered P1'); await ledgerMatches(u);
    assert.equal((await PaymentRecordModel.findById(p1._id).lean())!.status, 'refunded', 'P1 refunded only because its money went back');
    assert.equal((await PaymentRecordModel.findById(b.rec).lean())!.status, 'refunded');
    assert.equal((await PaymentRecordModel.findById(p2._id).lean())!.status, 'created');
    const replay = await recordGatewayCapture({ model: BookingModel, kind: 'booking', bookingId: b.id, userId: u, recordId: String(p1._id), amount: 70,
      gross: 100, legacyFunded: 0, applicable: () => true });
    assert.equal(replay.state, 'returned'); assert.equal(replay.fresh, false);
    // A capture landing after the cancel whose registration was interrupted: repeating the cancel returns it, once.
    await PaymentRecordModel.updateOne({ _id: p2._id }, { $set: { status: 'paid' } });
    await cancel(b.id, u); await cancel(b.id, u);
    assert.equal(await balance(u), 240); await ledgerMatches(u);
    assert.equal((await PaymentRecordModel.findById(p2._id).lean())!.status, 'refunded');
  });

  await check('[A2a-2] a legacy booking never assumed to hold: no seat freed that another booking holds; no benefit cleared that another follow-up holds', async () => {
    const at = inHours(96); const s = await slot(at, 1);
    const u = await customer();
    const holder = await createBookingWithHolds(draft(u, s, at));                       // owns the only seat
    const { insertedId: legacy } = await BookingModel.collection.insertOne({ userId: u, bookingType: 'consultation', status: 'pending',
      paymentStatus: 'pending', price: 100, slotId: s, specialistId: specialist, ...at } as never);   // old best-effort increment had failed
    await cancel(legacy.toHexString(), u);
    assert.equal((await slotRow(s)).currentBookings, 1, 'the holder keeps its seat'); assert.equal((await slotRow(s)).isAvailable, false);
    await rejects(createBookingWithHolds(draft(u, s, at)), 'SLOT_NOT_AVAILABLE', 409);
    await cancel(String(holder._id), u);
    assert.equal((await slotRow(s)).currentBookings, 0);
    // Legacy reschedule onto the same slot without a seat must take one (none free here: refused, nothing changes).
    const s2 = await slot(at, 1);
    await createBookingWithHolds(draft(u, s2, at));
    const { insertedId: legacy2 } = await BookingModel.collection.insertOne({ userId: u, bookingType: 'consultation', status: 'pending',
      paymentStatus: 'pending', price: 100, slotId: s2, specialistId: specialist, ...at } as never);
    await rejects(service.rescheduleBooking(legacy2.toHexString(), { slotId: s2 }, { _id: u, userType: 'user' }), 'SLOT_NOT_AVAILABLE');
    assert.equal((await slotRow(s2)).currentBookings, 1);
    // Two legacy follow-ups of one consultation: cancelling one leaves the benefit used.
    const { insertedId: parent } = await BookingModel.collection.insertOne({ userId: u, bookingType: 'consultation', status: 'completed',
      followUp: { benefitUsed: true } } as never);
    const child = () => BookingModel.collection.insertOne({ userId: u, bookingType: 'consultation', status: 'pending', paymentStatus: 'pending', price: 0,
      ...at, followUp: { isFollowUp: true, parentConsultationId: parent.toHexString() } } as never);
    const c1 = (await child()).insertedId; const c2 = (await child()).insertedId;
    await cancel(c1.toHexString(), u);
    assert.equal((await BookingModel.findById(parent).lean())!.followUp!.benefitUsed, true, 'another follow-up still claims it');
    await cancel(c2.toHexString(), u);
    assert.equal((await BookingModel.findById(parent).lean())!.followUp!.benefitUsed, false);
  });

  await check('[A2a-3] coupon usage and its undo share one per-record state: cancel-then-finalize never counts; finalize-then-cancel nets zero; direct-paid counts with its record', async () => {
    const at = inHours(96); const u = await customer();
    await coupon('RACE', 5);
    const b1 = await createBookingWithHolds(draft(u, await slot(at), at));
    const r1 = await PaymentRecordModel.create({ userId: u, context: 'booking', contextId: String(b1._id), baseAmount: 100, discountAmount: 10, finalAmount: 90,
      currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_c1_' + String(b1._id), status: 'created', couponCode: 'RACE' });
    await cancel(String(b1._id), u);                                                   // unpaid: nothing counted, so nothing undone
    assert.equal((await PaymentRecordModel.findById(r1._id).lean())!.couponUsage, 'void');
    await finalize((await PaymentRecordModel.findById(r1._id).lean()));                // a finalizer paused before counting now resumes
    assert.equal(await usage('RACE'), 5, 'a voided record is never counted');
    const b2 = await createBookingWithHolds(draft(u, await slot(inHours(120)), inHours(120)));
    const r2 = await PaymentRecordModel.create({ userId: u, context: 'booking', contextId: String(b2._id), baseAmount: 100, discountAmount: 10, finalAmount: 0,
      currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_c2_' + String(b2._id), status: 'paid', couponCode: 'RACE' });
    await Promise.all([finalize(await PaymentRecordModel.findById(r2._id).lean()), finalize(await PaymentRecordModel.findById(r2._id).lean())]);
    assert.equal(await usage('RACE'), 6, 'counted once'); assert.equal((await PaymentRecordModel.findById(r2._id).lean())!.couponUsage, 'counted');
    await cancel(String(b2._id), u, 'admin'); await cancel(String(b2._id), u, 'admin');
    assert.equal(await usage('RACE'), 5, 'undone once'); assert.equal((await PaymentRecordModel.findById(r2._id).lean())!.couponUsage, 'reversed');
    const b3 = await createBookingWithHolds(draft(u, await slot(inHours(144)), inHours(144)));
    const direct = await payments.createDirectPaidTransaction({ userId: u, context: 'booking', contextId: String(b3._id), baseAmount: 100,
      discountAmount: 100, finalAmount: 0, couponCode: 'race' });
    assert.equal((direct as { couponUsage?: string }).couponUsage, 'counted'); assert.equal(await usage('RACE'), 6);
    await Promise.all([cancel(String(b3._id), u, 'admin'), finalize(direct)]);
    assert.equal(await usage('RACE'), 5);
  });

  await check('[A2a-4] the appointment time is the slot\'s: a supplied time is replaced on create and on every reschedule (same slot too)', async () => {
    const at = inHours(96); const s = await slot(at, 2);
    const u = await customer();
    const b = await createBookingWithHolds(draft(u, s, { bookingDate: at.bookingDate, bookingTime: '23:00' }));
    assert.equal(b.bookingTime, at.bookingTime);
    assert.equal((await BookingModel.findById(b._id).lean())!.bookingTime, at.bookingTime);
    const same = await service.rescheduleBooking(String(b._id), { slotId: s, bookingTime: '23:59' }, { _id: u, userType: 'user' });
    assert.equal(same.bookingTime, at.bookingTime); assert.equal((await slotRow(s)).currentBookings, 1, 'same held slot: no second seat');
    const at2 = inHours(120); const s2 = await slot(at2);
    const moved = await service.rescheduleBooking(String(b._id), { slotId: s2, bookingTime: '00:01' }, { _id: u, userType: 'user' });
    assert.equal(moved.bookingTime, at2.bookingTime);
    const bad = await SlotModel.create({ specialistId: specialist, date: at.bookingDate, startTime: 'soon', endTime: '23:59', maxBookings: 1,
      currentBookings: 0, isAvailable: true, isActive: true, slotType: 'consultation' });
    await rejects(createBookingWithHolds(draft(u, String(bad._id), at)), 'SLOT_NOT_AVAILABLE', 409);
    assert.equal((await slotRow(String(bad._id))).currentBookings, 0);
  });

  await check('[A2a-5] ids in any letter case are one resource: a legacy row never frees a seat or benefit held under another case', async () => {
    const at = inHours(96); const s = await slot(at, 1);
    const u = await customer();
    const holder = await createBookingWithHolds(draft(u, s.toUpperCase(), at));       // tracked, written canonical
    assert.equal(holder.slotId, s); assert.equal(holder.holds!.heldSlotId, s);
    for (const variant of [s, s.toUpperCase()]) {
      const { insertedId } = await BookingModel.collection.insertOne({ userId: u, bookingType: 'consultation', status: 'pending', paymentStatus: 'pending',
        price: 100, slotId: variant, specialistId: specialist, ...at } as never);
      await cancel(insertedId.toHexString(), u);
      assert.equal((await slotRow(s)).currentBookings, 1, `legacy ${variant === s ? 'lower' : 'upper'}-case row keeps the holder's seat`);
    }
    // The holder reschedules onto its own (full) slot with the id in the case it was originally supplied: allowed.
    const again = await service.rescheduleBooking(String(holder._id), { slotId: s.toUpperCase() }, { _id: u, userType: 'user' });
    assert.equal(again.slotId, s); assert.equal((await slotRow(s)).currentBookings, 1, 'no second seat');
    // A historic legacy holder in upper case, and a legacy row in lower case without a seat.
    const s2 = await slot(at, 1, 1);
    const ins = (slotId: string) => BookingModel.collection.insertOne({ userId: u, bookingType: 'consultation', status: 'pending', paymentStatus: 'pending',
      price: 100, slotId, specialistId: specialist, ...at } as never);
    await ins(s2.toUpperCase()); const { insertedId: lower } = await ins(s2);
    await cancel(lower.toHexString(), u);
    assert.equal((await slotRow(s2)).currentBookings, 1, 'two claimants, one unit: nothing released');
    // Follow-ups: another live follow-up of the same consultation under a different case keeps the benefit used.
    const { insertedId: parent } = await BookingModel.collection.insertOne({ userId: u, bookingType: 'consultation', status: 'completed',
      followUp: { benefitUsed: true } } as never);
    const child = (pid: string) => BookingModel.collection.insertOne({ userId: u, bookingType: 'consultation', status: 'pending', paymentStatus: 'pending',
      price: 0, ...at, followUp: { isFollowUp: true, parentConsultationId: pid } } as never);
    await child(parent.toHexString().toUpperCase()); const { insertedId: c2 } = await child(parent.toHexString());
    await cancel(c2.toHexString(), u);
    assert.equal((await BookingModel.findById(parent).lean())!.followUp!.benefitUsed, true);
  });

  await check('[A2a-6] a wallet-covered/zero-payable settlement is serialized with cancel: after a cancel it inserts and counts nothing; racing, the net is zero', async () => {
    const u = await customer(); await coupon('LATE', 10);
    const settle = (id: string) => (service as unknown as { settleDirectPaid: (...a: unknown[]) => Promise<IBooking> }).settleDirectPaid(id, undefined,
      { userId: u, context: 'booking', contextId: id, baseAmount: 100, discountAmount: 100, finalAmount: 0, couponCode: 'LATE', notes: {} },
      { status: 'confirmed', paymentStatus: 'paid' });
    const b = await createBookingWithHolds(draft(u, await slot(inHours(96)), inHours(96)));
    await cancel(String(b._id), u);                                                    // the cancel commits before the paused settlement resumes
    await rejects(settle(String(b._id)), 'BOOKING_PAYMENT_STATE_CHANGED', 409);
    assert.equal(await PaymentRecordModel.countDocuments({ contextId: String(b._id) }), 0); assert.equal(await usage('LATE'), 10);
    for (let i = 0; i < 6; i++) {
      const at = inHours(100 + i); const r = await createBookingWithHolds(draft(u, await slot(at), at));
      await Promise.allSettled([settle(String(r._id)), cancel(String(r._id), u, 'admin')]);
      assert.equal((await BookingModel.findById(r._id).lean())!.status, 'cancelled');
      assert.equal(await PaymentRecordModel.countDocuments({ contextId: String(r._id), status: 'paid' }), 0);
      assert.equal(await usage('LATE'), 10, `race ${i}: coupon nets to zero`);
    }
    // Recovery: a coupon counted on a record that landed after the cancel (older code) is undone by repeating the cancel, once.
    const r = await createBookingWithHolds(draft(u, await slot(inHours(130)), inHours(130)));
    await cancel(String(r._id), u);
    await runInTxn(sess => payments.createDirectPaidBookingRecordIn({ userId: u, context: 'booking', contextId: String(r._id), baseAmount: 100,
      discountAmount: 100, finalAmount: 0, couponCode: 'LATE' }, sess));
    assert.equal(await usage('LATE'), 11);
    await cancel(String(r._id), u); await cancel(String(r._id), u);
    assert.equal(await usage('LATE'), 10);
    assert.equal((await PaymentRecordModel.findOne({ contextId: String(r._id) }).lean())!.status, 'refunded');
    await ledgerMatches(u);
  });

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
