/**
 * Option A, phase A2b: external bookings' provider admission and two-phase cancellation (externalBookings/services/
 * providerOps.ts) on the walletFunding ledger, against a real MongoDB replica set. ExternalBookingService.cancelBooking,
 * rescheduleBooking, getPaymentDetails and PaymentService.processExternalBookingPayment run for real; only the provider
 * clients (LabStack) and e-mails are fakes. After every money scenario the wallet balance must equal its ledger.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/a2b_external_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/customer-bookings/a2b-external-cancel.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import '@/modules/user/model';
import ExternalBookingModel from '@/modules/externalBookings/model';
import { ExternalBookingRepository } from '@/modules/externalBookings/repository';
import { ExternalBookingService } from '@/modules/externalBookings/services';
import { beginProvider, findPendingCancellations, recordProviderResult, requestCancellation } from '@/modules/externalBookings/services/providerOps';
import { recordGatewayCapture } from '@/modules/common/utils/bookingWalletFunding';
import { CouponModel } from '@/modules/coupon/model';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { IExternalBooking } from '@/modules/externalBookings/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/a2b_external_check?directConnection=true';
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

/** Fake LabStack: records calls; the cancel answer is chosen per test. */
const provider = { cancels: [] as string[], reschedules: 0, answer: 'ack' as 'ack' | 'vague' | 'fail',
  async cancelOrder({ orderId }: { orderId: string }) {
    provider.cancels.push(orderId);
    if (provider.answer === 'fail') throw new Error('LabStack request failed: socket hang up');
    if (provider.answer === 'vague') return { externalBookingId: orderId, externalStatus: 'cancelled', payload: { message: 'ok' } }; // fallback status only
    return { externalBookingId: orderId, externalStatus: 'cancelled', payload: { status: 'cancelled', orderId } };
  },
  rescheduleHold: undefined as Promise<void> | undefined, rescheduleNewId: undefined as string | undefined,
  async rescheduleOrder({ orderId }: { orderId: string }) {
    provider.reschedules++;
    if (provider.rescheduleHold) await provider.rescheduleHold;
    return { externalBookingId: provider.rescheduleNewId ?? orderId, externalStatus: 'rescheduled', payload: {} };
  },
};
const emails: string[] = [];
const externals = Object.assign(Object.create(ExternalBookingService.prototype), {
  externalBookingRepository: new ExternalBookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), labstackService: provider, healthiansService: {},
  sendExternalBookingEmailNotification: async (_b: unknown, kind: string) => { emails.push(kind); },
}) as ExternalBookingService;
/** Provider booking for an admitted attempt; `providerGate.next` decides how the call ends. */
const providerGate: { next?: 'ok' | 'timeout' | 'refused' | 'notcalled' | 'noid'; hold?: Promise<void>; calls: number } = { calls: 0 };
const payments = Object.assign(Object.create(PaymentService.prototype), {
  paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(), externalBookingRepository: new ExternalBookingRepository(),
  sendExternalBookingEmailNotification: async () => undefined,
  finalizeExternalBookingPayment: async (r: { _id: unknown; contextId: string }, token: string) => {
    providerGate.calls++;
    if (providerGate.hold) await providerGate.hold;
    const next = providerGate.next ?? 'ok'; providerGate.next = undefined;
    if (next === 'timeout') throw new Error('timeout of 30000ms exceeded');
    if (next === 'refused') throw Object.assign(new Error('LabStack error: slot not available'), { status: 400 });
    if (next === 'notcalled') throw Object.assign(new Error('Healthians slot freeze failed'), { providerNotCalled: true });
    const res = await recordProviderResult(r.contextId, token, { status: 'confirmed', externalBookingId: next === 'noid' ? undefined : 'prov_' + String(r._id) });
    if (res.missingRef) throw Object.assign(new Error('The provider did not return a booking reference'), { code: 'EXTERNAL_PROVIDER_REFERENCE_MISSING' });
    return res.booking;
  },
}) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
const admin = { _id: new Types.ObjectId().toHexString(), userType: 'admin' };

async function customer(balance = 0) {
  const user = new Types.ObjectId().toHexString();
  const w = await WalletModel.create({ userId: user, balance, isActive: true });
  if (balance) await WalletTransactionModel.create({ userId: user, walletId: w._id, transactionType: 'credit', amount: balance,
    balanceBefore: 0, balanceAfter: balance, status: 'completed', referenceType: 'seed', transactionDate: '20261113' });
  return user;
}
const balance = async (u: string) => Number((await WalletModel.findOne({ userId: u }).lean())?.balance);
async function ledgerMatches(u: string) {
  const sum = (await WalletTransactionModel.find({ userId: u }).lean()).reduce((a, t) => a + (t.transactionType === 'debit' ? -t.amount : t.amount), 0);
  assert.equal(Math.round(sum * 100), Math.round((await balance(u)) * 100), 'wallet balance == ledger');
}
/** A ₹100 diagnostics booking awaiting payment, linked to an unpaid gateway record P0 (optionally with a coupon). */
async function booking(user: string, at = inHours(96), coupon?: string) {
  const { insertedId } = await ExternalBookingModel.collection.insertOne({ userId: user, integration: 'labstack', providerType: 'DIAGNOSTICS',
    appointmentType: 'home', status: 'pending_payment', paymentStatus: 'pending', price: 100, ...at, meta: {} } as never);
  const id = insertedId.toHexString();
  const p0 = await PaymentRecordModel.create({ userId: user, context: 'external_booking', contextId: id, baseAmount: 100, discountAmount: 0,
    finalAmount: 100, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_' + id, status: 'created', couponCode: coupon });
  await ExternalBookingModel.updateOne({ _id: id }, { $set: { paymentTransactionId: String(p0._id) } });
  return { id, p0: String(p0._id) };
}
/** The gateway captures P0 and payment processing runs (capture, provider admission, provider booking). */
async function pay(b: { p0: string }) {
  await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } });
  return payments.processExternalBookingPayment(await PaymentRecordModel.findById(b.p0).lean());
}
const row = async (id: string) => (await ExternalBookingModel.findById(id).select('+providerOps').lean())! as IExternalBooking;
const cancel = (id: string, user: string, userType = 'user') => externals.cancelBooking(id, { _id: user, userType } as never, {}, 'diagnostics');

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(url);
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await Promise.all([ExternalBookingModel.init(), PaymentRecordModel.init(), WalletModel.init(), WalletTransactionModel.init(), CouponModel.init()]);
  await CouponModel.create({ code: 'EXT10', currentUsageCount: 4, discountType: 'percentage', discountValue: 10, applicableTo: 'all',
    startDate: '20260101', endDate: '20991231', isActive: true } as never);
  const usage = async () => (await CouponModel.findOne({ code: 'EXT10' }).lean())!.currentUsageCount;

  await check('[B2] unpaid external booking: cancellable inside the window (exemption restored); a paid one is refused there', async () => {
    const u = await customer();
    const unpaid = await booking(u, inHours(3));
    const out = await cancel(unpaid.id, u);
    assert.equal(out.status, 'cancelled'); assert.equal(provider.cancels.length, 0, 'nothing booked at the provider: no call');
    const paid = await booking(u, inHours(3));
    await pay(paid);
    await rejects(cancel(paid.id, u), 'CANCELLATION_WINDOW_CLOSED', 400);
    assert.equal((await row(paid.id)).status, 'confirmed'); assert.equal((await row(paid.id)).providerOps?.cancel, undefined);
  });

  await check('[C] paid + booked at the provider: cancel calls the provider once, refunds only after its explicit acknowledgement; coupon undone; repeat is a no-op', async () => {
    const u = await customer(); provider.cancels = []; provider.answer = 'ack';
    const b = await booking(u, inHours(96), 'EXT10');
    await pay(b);
    assert.equal(await usage(), 5, 'counted once when processed');
    const out = await cancel(b.id, u);
    assert.equal(out.status, 'cancelled'); assert.deepEqual(provider.cancels, ['prov_' + b.p0]);
    assert.equal(await balance(u), 100); await ledgerMatches(u);
    assert.equal((await PaymentRecordModel.findById(b.p0).lean())!.status, 'refunded');
    assert.equal(await usage(), 4, 'coupon undone');
    assert.equal((out as { providerOps?: unknown }).providerOps, undefined, 'private state never returned');
    await cancel(b.id, u);
    assert.equal(provider.cancels.length, 1); assert.equal(await balance(u), 100); assert.equal(await usage(), 4);
    assert.equal(emails.filter(e => e === 'CANCELED').length >= 1, true);
  });

  await check('[C] no acknowledgement (fallback status only, or the call fails): no refund, pending; the sweep retries and settles on a real acknowledgement', async () => {
    const u = await customer(); provider.cancels = []; provider.answer = 'vague';
    const b = await booking(u);
    await pay(b);
    const out = await cancel(b.id, u);
    assert.equal(out.status, 'cancellation_requested'); assert.equal(await balance(u), 0);
    const parked = (await row(b.id)).providerOps!.cancel!;
    assert.equal(parked.state, 'requested'); assert.ok(new Date(parked.nextAt!).getTime() > Date.now(), 'retried later, not now');
    assert.ok(!(await findPendingCancellations(new Date())).includes(b.id), 'not due yet');
    const due = () => ExternalBookingModel.updateOne({ _id: b.id }, { $set: { 'providerOps.cancel.at': new Date(Date.now() - 10 * 60_000),
      'providerOps.cancel.nextAt': new Date(Date.now() - 1000) } });
    provider.answer = 'fail'; await due();
    assert.ok((await findPendingCancellations(new Date())).includes(b.id));
    await externals.cancelStaleUnpaidExternalBookings();
    assert.equal((await row(b.id)).status, 'cancellation_requested'); assert.equal(await balance(u), 0);
    provider.answer = 'ack'; await due();
    await externals.cancelStaleUnpaidExternalBookings();
    assert.equal((await row(b.id)).status, 'cancelled'); assert.equal(provider.cancels.length, 3);
    assert.equal(await balance(u), 100); await ledgerMatches(u);
  });

  await check('[A] cancel while the provider call is running: the result does not re-activate the booking; it becomes a provider cancellation, then settles', async () => {
    const u = await customer(); provider.cancels = []; provider.answer = 'ack';
    const b = await booking(u);
    let release!: () => void; providerGate.hold = new Promise(r => { release = r; });
    const paying = pay(b);
    while ((await row(b.id)).providerOps?.attempt?.state !== 'started') await new Promise(r => setTimeout(r, 10));
    const mid = await cancel(b.id, u);
    assert.equal(mid.status, 'cancellation_requested', 'attempt in flight: waits for its result'); assert.equal(await balance(u), 0);
    providerGate.hold = undefined; release(); await paying;
    const after = await row(b.id);
    assert.equal(after.status, 'cancellation_requested'); assert.equal(after.externalBookingId, 'prov_' + b.p0, 'reference kept as an obligation');
    await externals.cancelBooking(b.id, admin as never, {}, 'diagnostics');            // continue (as the sweep would)
    assert.deepEqual(provider.cancels, ['prov_' + b.p0]);
    assert.equal((await row(b.id)).status, 'cancelled'); assert.equal(await balance(u), 100); await ledgerMatches(u);
  });

  await check('[A] admission: no provider attempt once a cancellation is recorded; a capture after the intent goes back to the wallet, never fulfilled', async () => {
    const u = await customer(); providerGate.calls = 0;
    const b = await booking(u);
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } });  // captured at the gateway, processing not yet run
    const out = await cancel(b.id, u);                                                  // captured record: window applies (96 h: fine)
    assert.equal(out.status, 'cancelled');
    await pay(b); await pay(b);
    assert.equal(providerGate.calls, 0, 'provider never called');
    assert.equal(await balance(u), 100, 'the ₹100 capture returned once'); await ledgerMatches(u);
    const late = await beginProvider(b.id, b.p0);
    assert.equal(late.token, null);
  });

  await check('[A] timeout or any provider error (4xx too) = unknown: no refund until an admin attests; "never called" = proven: refunded at once', async () => {
    const u = await customer();
    const t = await booking(u);
    providerGate.next = 'timeout';
    await assert.rejects(pay(t), /timeout/);
    assert.equal((await row(t.id)).providerOps!.attempt!.state, 'unknown');
    await cancel(t.id, u);
    assert.equal((await row(t.id)).status, 'cancellation_requested'); assert.equal(await balance(u), 0);
    await rejects(externals.reconcileCancellation(t.id, { _id: u, userType: 'user' } as never, 'absent'), 'FORBIDDEN', 403);
    const done = await externals.reconcileCancellation(t.id, admin as never, 'absent');
    assert.equal(done.status, 'cancelled'); assert.equal(await balance(u), 100);
    const four = await booking(u);
    providerGate.next = 'refused';
    await assert.rejects(pay(four));
    assert.equal((await row(four.id)).providerOps!.attempt!.state, 'unknown', 'a 4xx does not prove no booking');
    const r = await booking(u);
    providerGate.next = 'notcalled';
    await assert.rejects(pay(r));
    assert.equal((await row(r.id)).providerOps!.attempt!.state, 'rejected');
    const handled = await (payments as unknown as { handleTerminalExternalFulfillmentFailure: (p: unknown, e: unknown) => Promise<{ refunded: boolean }> })
      .handleTerminalExternalFulfillmentFailure(await PaymentRecordModel.findById(r.p0).lean(), new Error('400'));
    assert.equal(handled.refunded, true); assert.equal((await row(r.id)).status, 'cancelled');
    assert.equal(await balance(u), 200); await ledgerMatches(u);
    const h4 = await (payments as unknown as { handleTerminalExternalFulfillmentFailure: (p: unknown, e: unknown) => Promise<{ refunded: boolean }> })
      .handleTerminalExternalFulfillmentFailure(await PaymentRecordModel.findById(four.p0).lean(), new Error('400'));
    assert.equal(h4.refunded, false); assert.equal((await row(four.id)).status, 'cancellation_requested');
    assert.equal((await row(four.id)).providerOps!.cancel!.needsAdmin, true); assert.equal(await balance(u), 200);
  });

  await check('[O] no fresh attempt over an unresolved one; after an admin "absent", a late result of the old attempt is an obligation the cancellation must clear too', async () => {
    const u = await customer(); provider.cancels = []; provider.answer = 'ack';
    const b = await booking(u);
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } });
    await ExternalBookingModel.updateOne({ _id: b.id }, { $set: { paymentStatus: 'paid', status: 'pending' } });
    const first = await beginProvider(b.id, b.p0);
    await ExternalBookingModel.updateOne({ _id: b.id }, { $set: { 'providerOps.attempt.at': new Date(Date.now() - 20 * 60_000) } }); // expired
    const again = await beginProvider(b.id, b.p0);
    assert.equal(again.token, null); assert.equal((again as { reason: string }).reason, 'unresolved', 'an expired lease admits nothing');
    await externals.reconcileCancellation(b.id, admin as never, 'absent');              // admin checked: nothing at the provider
    const second = await beginProvider(b.id, b.p0);
    assert.ok(second.token);
    await recordProviderResult(b.id, second.token!, { status: 'confirmed', externalBookingId: 'prov-B' });
    const late = await recordProviderResult(b.id, first.token!, { status: 'confirmed', externalBookingId: 'prov-A' }); // the old call did book
    assert.equal(late.applied, false);
    assert.equal((await row(b.id)).externalBookingId, 'prov-B'); assert.deepEqual((await row(b.id)).providerOps!.lateRefs, ['prov-A']);
    const out = await cancel(b.id, u);
    assert.equal(out.status, 'cancelled'); assert.deepEqual(provider.cancels.sort(), ['prov-A', 'prov-B'], 'both provider bookings cancelled first');
    assert.equal(await balance(u), 100); await ledgerMatches(u);
  });

  await check('[O] a crash after admission (attempt never finishes) does not deadlock: it turns unknown, waits for an admin, then settles', async () => {
    const u = await customer();
    const b = await booking(u);
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } });
    await ExternalBookingModel.updateOne({ _id: b.id }, { $set: { paymentStatus: 'paid', status: 'pending' } });
    await beginProvider(b.id, b.p0);                                                    // ...process crashes here
    const mid = await cancel(b.id, u);
    assert.equal(mid.status, 'cancellation_requested', 'fresh attempt: waits');
    await ExternalBookingModel.updateOne({ _id: b.id }, { $set: { 'providerOps.attempt.at': new Date(Date.now() - 20 * 60_000) } });
    await cancel(b.id, u);
    const r = await row(b.id);
    assert.equal(r.providerOps!.attempt!.state, 'unknown'); assert.equal(r.providerOps!.cancel!.needsAdmin, true);
    assert.equal(await balance(u), 0, 'elapsed time proves nothing');
    const done = await externals.reconcileCancellation(b.id, admin as never, 'cancelled');
    assert.equal(done.status, 'cancelled'); assert.equal(await balance(u), 100); await ledgerMatches(u);
  });

  await check('[O] a late result of an attested-absent attempt arriving BEFORE a retry is adopted: no second provider booking', async () => {
    const u = await customer(); providerGate.calls = 0;
    const b = await booking(u);
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } });
    await ExternalBookingModel.updateOne({ _id: b.id }, { $set: { paymentStatus: 'paid', status: 'pending' } });
    const first = await beginProvider(b.id, b.p0);
    await ExternalBookingModel.updateOne({ _id: b.id }, { $set: { 'providerOps.attempt.at': new Date(Date.now() - 20 * 60_000) } });
    await externals.reconcileCancellation(b.id, admin as never, 'absent');              // admin was wrong
    const late = await recordProviderResult(b.id, first.token!, { status: 'confirmed', externalBookingId: 'prov-A' });
    assert.equal(late.applied, true, 'adopted as the booking');
    assert.equal((await row(b.id)).externalBookingId, 'prov-A');
    const retry = await beginProvider(b.id, b.p0);
    assert.equal(retry.token, null); assert.equal((retry as { reason: string }).reason, 'fulfilled');
    // A known late reference without a current one (e.g. after a superseded result) also blocks admission.
    const c = await booking(u);
    await ExternalBookingModel.updateOne({ _id: c.id }, { $set: { paymentStatus: 'paid', status: 'pending', 'providerOps.lateRefs': ['prov-X'] } });
    await PaymentRecordModel.updateOne({ _id: c.p0 }, { $set: { status: 'paid' } });
    assert.equal((await beginProvider(c.id, c.p0) as { reason?: string }).reason, 'unresolved');
  });

  await check('[O] a provider success without a booking id proves nothing: paid and free stay unknown (no refund, no deletion)', async () => {
    const u = await customer();
    const b = await booking(u);
    providerGate.next = 'noid';
    await assert.rejects(pay(b), /booking reference/);
    assert.equal((await row(b.id)).providerOps!.attempt!.state, 'unknown');
    await cancel(b.id, u);
    assert.equal((await row(b.id)).status, 'cancellation_requested'); assert.equal((await row(b.id)).providerOps!.cancel!.needsAdmin, true);
    assert.equal(await balance(u), 0);
    // A superseded attempt answering without an id (after B succeeded) also blocks: no refund on B's cancellation alone.
    provider.cancels = []; provider.answer = 'ack';
    const sup = await booking(u);
    await PaymentRecordModel.updateOne({ _id: sup.p0 }, { $set: { status: 'paid' } });
    await ExternalBookingModel.updateOne({ _id: sup.id }, { $set: { paymentStatus: 'paid', status: 'pending' } });
    const A = await beginProvider(sup.id, sup.p0);
    await ExternalBookingModel.updateOne({ _id: sup.id }, { $set: { 'providerOps.attempt.at': new Date(Date.now() - 20 * 60_000) } });
    await externals.reconcileCancellation(sup.id, admin as never, 'absent');
    const B = await beginProvider(sup.id, sup.p0);
    await recordProviderResult(sup.id, B.token!, { status: 'confirmed', externalBookingId: 'prov-B2' });
    const lateA = await recordProviderResult(sup.id, A.token!, { status: 'confirmed' });
    assert.equal(lateA.missingRef, true, 'reported');
    const parkedSup = await cancel(sup.id, u);
    assert.equal(parkedSup.status, 'cancellation_requested'); assert.equal(await balance(u), 0);
    assert.deepEqual(provider.cancels, [], 'no provider cancellation while an outcome is unknown');
    assert.equal((await row(sup.id)).providerOps!.cancel!.needsAdmin, true);
    const settledSup = await externals.reconcileCancellation(sup.id, admin as never, 'cancelled');
    assert.equal(settledSup.status, 'cancelled'); assert.equal(await balance(u), 100); await ledgerMatches(u);
    // Free booking: same rule; the draft is kept (flagged), not deleted.
    const { insertedId } = await ExternalBookingModel.collection.insertOne({ userId: u, integration: 'labstack', providerType: 'DIAGNOSTICS',
      status: 'pending', paymentStatus: 'paid', price: 0, ...inHours(96), meta: {} } as never);
    const free = insertedId.toHexString();
    const adm = await beginProvider(free, null);
    const res = await recordProviderResult(free, adm.token!, { status: 'confirmed' });
    assert.equal(res.missingRef, true);
    await (externals as unknown as { discardFreeDraftIfProvenUnbooked: (id: string, t: string, e: unknown) => Promise<void> })
      .discardFreeDraftIfProvenUnbooked(free, adm.token!, new Error('no id'));
    assert.ok(await ExternalBookingModel.exists({ _id: free }), 'kept'); assert.equal((await row(free)).providerOps!.attempt!.state, 'unknown');
  });

  await check('[O] a parked cancellation wakes when the unknown call\'s real result arrives (booking and reschedule)', async () => {
    const u = await customer(); provider.cancels = []; provider.answer = 'ack';
    const b = await booking(u);
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } });
    await ExternalBookingModel.updateOne({ _id: b.id }, { $set: { paymentStatus: 'paid', status: 'pending' } });
    const a = await beginProvider(b.id, b.p0);
    await ExternalBookingModel.updateOne({ _id: b.id }, { $set: { 'providerOps.attempt.at': new Date(Date.now() - 20 * 60_000) } });
    await cancel(b.id, u);
    assert.equal((await row(b.id)).providerOps!.cancel!.needsAdmin, true);
    await recordProviderResult(b.id, a.token!, { status: 'confirmed', externalBookingId: 'prov-late' });
    const woke = (await row(b.id)).providerOps!.cancel!;
    assert.equal(woke.needsAdmin, false); assert.equal(woke.state, 'requested');
    await ExternalBookingModel.updateOne({ _id: b.id }, { $set: { 'providerOps.cancel.at': new Date(Date.now() - 10 * 60_000) } });
    assert.ok((await findPendingCancellations(new Date())).includes(b.id), 'back in the automatic queue');
    await externals.cancelStaleUnpaidExternalBookings();
    assert.equal((await row(b.id)).status, 'cancelled'); assert.deepEqual(provider.cancels, ['prov-late']);
    // Reschedule: a reschedule left unknown parks the cancellation; its late result (no new id) wakes it.
    provider.cancels = [];
    const r = await booking(u, inHours(96)); await pay(r);
    const { beginReschedule, recordRescheduleResult } = await import('@/modules/externalBookings/services/providerOps');
    const t = await beginReschedule(r.id, 'prov_' + r.p0);
    await ExternalBookingModel.updateOne({ _id: r.id }, { $set: { 'providerOps.reschedule.at': new Date(Date.now() - 20 * 60_000) } });
    await cancel(r.id, u);
    assert.equal((await row(r.id)).providerOps!.cancel!.needsAdmin, true);
    assert.deepEqual(provider.cancels, [], 'no provider cancellation before the unknown reschedule is resolved');
    await recordRescheduleResult(r.id, t, undefined, {});
    assert.equal((await row(r.id)).providerOps!.cancel!.needsAdmin, false);
    await cancel(r.id, u);
    assert.equal((await row(r.id)).status, 'cancelled'); assert.deepEqual(provider.cancels, ['prov_' + r.p0]);
    // A reschedule result landing AFTER the cancellation proof (here an admin's) invalidates that proof: the provider
    // booking is cancelled again (no money moves twice).
    provider.cancels = [];
    const q = await booking(u, inHours(96)); await pay(q);
    const tq = await beginReschedule(q.id, 'prov_' + q.p0);
    await ExternalBookingModel.updateOne({ _id: q.id }, { $set: { 'providerOps.reschedule.at': new Date(Date.now() - 20 * 60_000) } });
    await cancel(q.id, u);
    const attested = await externals.reconcileCancellation(q.id, admin as never, 'cancelled');
    assert.equal(attested.status, 'cancelled'); const after = await balance(u);
    await recordRescheduleResult(q.id, tq, undefined, {});                                // the provider moved prov_q afterwards
    assert.deepEqual((await row(q.id)).providerOps!.cancel!.ackedRefs, [], 'proof invalidated');
    await cancel(q.id, u);
    assert.deepEqual(provider.cancels, ['prov_' + q.p0], 'cancelled again at the provider');
    assert.equal((await row(q.id)).providerOps!.cancel!.state, 'settled'); assert.equal(await balance(u), after); await ledgerMatches(u);
    // The late reschedule returns a reference whose cancellation was already acknowledged (B): that proof is stale too.
    provider.cancels = [];
    const w = await booking(u, inHours(96)); await pay(w);
    const tw = await beginReschedule(w.id, 'prov_' + w.p0);
    await ExternalBookingModel.updateOne({ _id: w.id }, { $set: { 'providerOps.lateRefs': ['prov-W-B'],
      'providerOps.reschedule.at': new Date(Date.now() - 20 * 60_000) } });
    await cancel(w.id, u);
    await externals.reconcileCancellation(w.id, admin as never, 'cancelled');           // proof for A and B
    assert.deepEqual([...(await row(w.id)).providerOps!.cancel!.ackedRefs!].sort(), ['prov-W-B', 'prov_' + w.p0].sort());
    await recordRescheduleResult(w.id, tw, 'prov-W-B', {});                              // the provider moved/returned B
    assert.deepEqual((await row(w.id)).providerOps!.cancel!.ackedRefs, [], 'both proofs invalidated');
    await cancel(w.id, u);
    assert.deepEqual(provider.cancels.sort(), ['prov-W-B', 'prov_' + w.p0].sort(), 'both cancelled again at the provider');
    assert.equal((await row(w.id)).providerOps!.cancel!.state, 'settled'); await ledgerMatches(u);
  });

  await check('[R] reschedule: refused while cancelling; refused if the provider reference changed after it was read', async () => {
    const u = await customer(); provider.reschedules = 0;
    const b = await booking(u, inHours(96)); await pay(b);
    await ExternalBookingModel.updateOne({ _id: b.id }, { $set: { externalBookingId: 'prov-other' } });
    const stale = { ...(await row(b.id)), externalBookingId: 'prov_' + b.p0 } as IExternalBooking;
    const svc = Object.assign(Object.create(externals), { getAccessibleBooking: async () => stale }) as ExternalBookingService;
    const next = inHours(120);
    await rejects(svc.rescheduleBooking(b.id, { _id: u, userType: 'user' } as never, { bookingDate: next.bookingDate, bookingTime: next.bookingTime } as never,
      'diagnostics'), 'EXTERNAL_BOOKING_CHANGED', 409);
    assert.equal(provider.reschedules, 0, 'provider not called');
    await ExternalBookingModel.updateOne({ _id: b.id }, { $set: { status: 'cancellation_requested' } });
    const svc2 = Object.assign(Object.create(externals), { getAccessibleBooking: async () => row(b.id) }) as ExternalBookingService;
    await rejects(svc2.rescheduleBooking(b.id, { _id: u, userType: 'user' } as never, { bookingDate: next.bookingDate, bookingTime: next.bookingTime } as never,
      'diagnostics'), 'EXTERNAL_BOOKING_CHANGED', 409);
  });

  await check('[R] a cancel during the provider reschedule waits for it; a new provider id it returns is kept and cancelled too before any refund', async () => {
    const u = await customer(); provider.cancels = []; provider.answer = 'ack';
    const b = await booking(u, inHours(96)); await pay(b);
    let release!: () => void; provider.rescheduleHold = new Promise(r => { release = r; }); provider.rescheduleNewId = 'prov-NEW';
    const next = inHours(120);
    const svc = Object.assign(Object.create(externals), { getAccessibleBooking: async () => row(b.id) }) as ExternalBookingService;
    const moving = svc.rescheduleBooking(b.id, { _id: u, userType: 'user' } as never, { bookingDate: next.bookingDate, bookingTime: next.bookingTime } as never,
      'diagnostics').catch((e: { code?: string }) => e);
    while ((await row(b.id)).providerOps?.reschedule?.state !== 'started') await new Promise(r => setTimeout(r, 10));
    const mid = await cancel(b.id, u);
    assert.equal(mid.status, 'cancellation_requested'); assert.equal(await balance(u), 0, 'no settlement while the reschedule is in flight');
    provider.rescheduleHold = undefined; release();
    assert.equal(((await moving) as { code?: string }).code, 'EXTERNAL_BOOKING_CHANGED');
    assert.deepEqual((await row(b.id)).providerOps!.lateRefs, ['prov-NEW'], 'the new provider id is kept as an obligation');
    provider.rescheduleNewId = undefined;
    const out = await cancel(b.id, u);
    assert.equal(out.status, 'cancelled'); assert.deepEqual(provider.cancels.sort(), ['prov-NEW', 'prov_' + b.p0].sort());
    assert.equal(await balance(u), 100); await ledgerMatches(u);
  });

  await check('[S] the sweep is fair: >100 cancellations waiting for an admin never starve a due one', async () => {
    const now = new Date();
    const ids = [];
    for (let i = 0; i < 105; i++) ids.push({ userId: new Types.ObjectId().toHexString(), status: 'cancellation_requested', integration: 'labstack',
      providerOps: { cancel: { by: 'system', at: new Date(now.getTime() - HOUR), state: 'unknown', token: 't' + i, needsAdmin: true, ackedRefs: [] } } });
    await ExternalBookingModel.collection.insertMany(ids as never);
    const u = await customer();
    const b = await booking(u);
    await requestCancellation({ bookingId: b.id, actor: 'system', reason: 'x', now: new Date(now.getTime() - 10 * 60_000) });
    assert.ok((await findPendingCancellations(now)).includes(b.id));
    await externals.cancelStaleUnpaidExternalBookings();
    assert.equal((await row(b.id)).status, 'cancelled');
  });

  await check('[M] payment edge cases: a fulfilled legacy booking keeps its status on replay; a cancel between capture and admission returns the refunded payment; one e-mail', async () => {
    const u = await customer();
    const { insertedId } = await ExternalBookingModel.collection.insertOne({ userId: u, integration: 'labstack', providerType: 'DIAGNOSTICS',
      status: 'confirmed', paymentStatus: 'paid', price: 100, externalBookingId: 'prov-legacy', ...inHours(96), meta: {},
      walletFunding: { total: 0, revision: 0, closed: false, captures: [] } } as never);
    const legacyId = insertedId.toHexString();
    const p0 = await PaymentRecordModel.create({ userId: u, context: 'external_booking', contextId: legacyId, baseAmount: 100, discountAmount: 0,
      finalAmount: 100, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_leg', status: 'paid' });
    await ExternalBookingModel.updateOne({ _id: legacyId }, { $set: { paymentTransactionId: String(p0._id) } });
    providerGate.calls = 0;
    await payments.processExternalBookingPayment(await PaymentRecordModel.findById(p0._id).lean());
    assert.equal((await row(legacyId)).status, 'confirmed', 'not downgraded to pending'); assert.equal(providerGate.calls, 0);
    const b = await booking(u);
    await PaymentRecordModel.updateOne({ _id: b.p0 }, { $set: { status: 'paid' } });
    await recordGatewayCapture({ model: ExternalBookingModel, kind: 'external_booking', bookingId: b.id, userId: u, recordId: b.p0, amount: 100,
      gross: 100, legacyFunded: 0, applicable: () => true, applyPatch: { paymentStatus: 'paid', paymentTransactionId: b.p0, status: 'pending' } });
    await requestCancellation({ bookingId: b.id, actor: 'system', reason: 'x' });     // lands between capture and admission
    emails.length = 0;
    const res = await payments.processExternalBookingPayment(await PaymentRecordModel.findById(b.p0).lean()) as { paymentRecord: { status: string }; entity: { status: string } };
    assert.equal(res.entity.status, 'cancelled'); assert.equal(res.paymentRecord.status, 'refunded', 'the committed payment state is returned');
    const c = await booking(u);
    await requestCancellation({ bookingId: c.id, actor: 'system', reason: 'x' });
    emails.length = 0;
    const cont = (externals as unknown as { continueCancellation: (id: string) => Promise<unknown> });
    await Promise.all([cont.continueCancellation(c.id), cont.continueCancellation(c.id)]);
    assert.equal(emails.filter(e => e === 'CANCELED').length, 1, 'one e-mail');
  });

  await check('[P] payment details: every attempt checked (foreign or inconsistent record → reconciliation); charges = captured gateway attempts; refund destination', async () => {
    const u = await customer(); provider.answer = 'ack';
    const b = await booking(u); await pay(b);
    const extra = await PaymentRecordModel.create({ userId: u, context: 'external_booking', contextId: b.id, baseAmount: 100, discountAmount: 0, finalAmount: 100,
      currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'ord_x_' + b.id, status: 'refunded' });
    let d = await externals.getPaymentDetails(b.id, { _id: u, userType: 'user' } as never);
    assert.equal(d.summary.amountChargedToRazorpay, 200); assert.equal(d.refund.destination, null);
    await cancel(b.id, u);
    d = await externals.getPaymentDetails(b.id, { _id: u, userType: 'user' } as never);
    assert.equal(d.refund.destination, 'internal_wallet'); assert.equal(d.refund.amountRefunded, 100);
    await PaymentRecordModel.updateOne({ _id: extra._id }, { $set: { finalAmountPaise: 999 } });
    await rejects(externals.getPaymentDetails(b.id, { _id: u, userType: 'user' } as never), 'EXTERNAL_BOOKING_RECONCILIATION_REQUIRED', 409);
    await PaymentRecordModel.updateOne({ _id: extra._id }, { $unset: { finalAmountPaise: 1 }, $set: { userId: new Types.ObjectId().toHexString() } });
    await rejects(externals.getPaymentDetails(b.id, { _id: u, userType: 'user' } as never), 'EXTERNAL_BOOKING_RECONCILIATION_REQUIRED', 409);
  });

  await check('[T] timeouts go through intent: stale unpaid settles at once; stale paid with an unknown provider outcome stays pending (no refund)', async () => {
    const u = await customer();
    const unpaid = await booking(u);
    await ExternalBookingModel.collection.updateOne({ _id: new Types.ObjectId(unpaid.id) }, { $set: { createdAt: new Date(Date.now() - 2 * HOUR) } });
    const paid = await booking(u);
    providerGate.next = 'timeout'; await assert.rejects(pay(paid));
    await ExternalBookingModel.collection.updateOne({ _id: new Types.ObjectId(paid.id) }, { $set: { createdAt: new Date(Date.now() - 2 * HOUR) } });
    await externals.cancelStaleUnpaidExternalBookings();
    assert.equal((await row(unpaid.id)).status, 'cancelled'); assert.equal((await row(unpaid.id)).providerOps!.cancel!.by, 'system');
    assert.equal((await row(paid.id)).status, 'cancellation_requested'); assert.equal((await row(paid.id)).providerOps!.cancel!.state, 'unknown');
    assert.equal(await balance(u), 0, 'paid ₹100 not refunded on an unknown provider outcome'); await ledgerMatches(u);
  });

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
