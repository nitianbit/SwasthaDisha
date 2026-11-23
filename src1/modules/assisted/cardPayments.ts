import { Container } from 'typedi';
import { Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import BookingModel from '@/modules/bookings/model';
import type { IBooking } from '@/modules/bookings/types';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentService, registerPaymentContextHandler } from '@/modules/payment/services';
import type { IPaymentRecord } from '@/modules/payment/types';
import { doctorExistsIneligible } from '@/modules/specialists/eligibility';
import { BOOKING_PAYMENT_WINDOW_MS } from '@/modules/bookings/holds';
import { kickCardRefunds, queueCardRefundIn, queueExtraCaptureRefundIn, recordPaiseOf } from '@/modules/assisted/cardRefunds';
import { assistedEffects, auditIn, bestEffort, sendAssistedNotices, type AssistedNotice } from '@/modules/assisted/support';

/**
 * Assisted booking phase 1b (design §6.4): a booker (pharmacy) pays an assisted consultation by card/UPI.
 *
 * - The booking is created `pending` with its seat and the doctor's interval held, exactly like a customer's online
 *   booking, and ONE payment record (context `assisted_booking`, contextId = the booking, payer = the pharmacy, its id
 *   chosen before the insert and stored as `assisted.funding.paymentRecordId`) carries one Razorpay order.
 * - Verify, reconcile, the recovery sweep and the expiry sweep all reach `applyAssistedCapture` through the payment
 *   context registry (S6: routing by the stored record's context only). It applies the capture in ONE transaction that
 *   claims the record (`isProcessed`) and moves the booking pending → confirmed, so the booking is confirmed exactly once.
 * - A capture that cannot be applied (the booking expired or was cancelled, the doctor is no longer verified and active,
 *   another record, an amount that differs) is a LATE capture: in the same transaction its card refund row is queued
 *   (assisted/cardRefunds.ts, once per record) and sent back to the card. Never lost, never applied twice.
 * - The patient's and doctor's notices, Meet and reminders follow the confirmation (not the pending insert), resumed on
 *   replay until done (`postPaymentCompletedFor`), as the customer path does.
 */
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const payments = (): PaymentService => Container.get(PaymentService);

export interface CardPaymentView {
  paymentRequired: true;
  paymentTransactionId: string;
  razorpayOrderId: string;
  razorpayKeyId: string;
  /** Rupees, as the pharmacy wallet top-up answers it (Razorpay Checkout takes `amountMinor`). */
  amount: number;
  amountMinor: number;
  currency: string;
  /** After this the booking expires (its seat is released) unless the payment arrived. */
  payBy: string;
}

/** 503 before anything is held when the gateway has no keys (a card booking could never be paid). */
export function assertCardGatewayReady(): void {
  try { (payments() as unknown as { getRazorpayCredentials(): unknown }).getRazorpayCredentials(); }
  catch { throw err(503, 'RAZORPAY_NOT_CONFIGURED', 'Card and UPI payments are not available right now; pay from the wallet'); }
}

const payByOf = (b: Pick<IBooking, 'createdAt'>) => new Date(new Date(b.createdAt ?? Date.now()).getTime() + BOOKING_PAYMENT_WINDOW_MS).toISOString();

function viewOf(r: IPaymentRecord, b: IBooking): CardPaymentView {
  return { paymentRequired: true, paymentTransactionId: String(r._id), razorpayOrderId: r.razorpayOrderId,
    razorpayKeyId: (payments() as unknown as { getRazorpayCredentials(): { keyId: string } }).getRazorpayCredentials().keyId,
    amount: Number(r.finalAmount), amountMinor: recordPaiseOf(r), currency: r.currency, payBy: payByOf(b) };
}

/**
 * The open Razorpay order of a pending card booking: the stored record, or (first time, or after a failed order call)
 * a new order saved under the pre-chosen record id — two racing callers save one record (the loser's order is never
 * shown, so it can never be paid). null when the booking is not waiting for its card payment.
 */
export async function openCardOrder(b: IBooking, opts: { create: boolean } = { create: true }): Promise<CardPaymentView | null> {
  const f = b.assisted?.funding;
  if (!f || f.method !== 'razorpay' || f.state !== 'pending' || b.status !== 'pending' || b.paymentStatus !== 'pending' || !f.paymentRecordId) return null;
  const stored = await PaymentRecordModel.findById(f.paymentRecordId).lean() as unknown as IPaymentRecord | null;
  if (stored) return stored.status === 'created' ? viewOf(stored, b) : null;
  if (!opts.create) return null;
  try {
    const out = await payments().createOrder({ recordId: f.paymentRecordId, userId: b.assisted!.bookedBy.actorId, payerUserId: b.assisted!.bookedBy.actorId,
      payerPharmacyId: f.payerId, context: 'assisted_booking', contextId: lower(b._id), baseAmount: f.amountMinor / 100, finalAmount: f.amountMinor / 100,
      notes: { flow: 'assisted_booking', pharmacyId: f.payerId, bookingId: lower(b._id) } });
    return viewOf(out.paymentRecord, b);
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const raced = await PaymentRecordModel.findById(f.paymentRecordId).lean() as unknown as IPaymentRecord | null;
      return raced?.status === 'created' ? viewOf(raced, b) : null;
    }
    throw err(502, 'RAZORPAY_ORDER_CREATION_FAILED',
      'The card payment could not be started. The booking is held for 30 minutes: send the same request again (same requestKey) to retry');
  }
}

/** applied: this call confirmed it; appliedBefore: confirmed by this record earlier, its follow-up not yet finished. */
type Outcome = 'applied' | 'appliedBefore' | 'already' | 'returned';
/** r10d: how long one caller holds the follow-up (Meet, reminders, notices) before another may take it over. */
const FOLLOW_UP_LEASE_MS = 5 * 60_000;
/**
 * r10f: the Meet step of the follow-up is bounded well inside the lease (default 60 s, ASSISTED_MEET_TIMEOUT_MS, never
 * more than half the lease): its Google calls are aborted then and the follow-up goes on without a Meet link, so a slow
 * call can never outlive the lease and let a second worker create another Meet event.
 */
const meetTimeoutMs = () => {
  const v = Number(process.env.ASSISTED_MEET_TIMEOUT_MS);
  return Math.min(Number.isSafeInteger(v) && v > 0 ? v : 60_000, FOLLOW_UP_LEASE_MS / 2);
};
async function boundedMeet(fx: ReturnType<typeof assistedEffects>, booking: IBooking): Promise<IBooking> {
  const signal = AbortSignal.timeout(meetTimeoutMs());
  const gaveUp = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('Meet call timed out'), { code: 'MEET_TIMEOUT' })), { once: true });
  });
  return Promise.race([fx.meet(booking, { signal }), gaveUp]);
}

/** The `assisted_booking` payment context handler (registered at start-up and by tests). */
export async function applyAssistedCapture(record: IPaymentRecord): Promise<{ paymentRecord: IPaymentRecord; entity: unknown }> {
  const notFound = () => err(404, 'BOOKING_NOT_FOUND', 'Booking not found for this payment');
  const id = lower(record.contextId);
  const rid = lower(record._id);
  if (!Types.ObjectId.isValid(id)) throw notFound();
  const pre = await BookingModel.findById(id).select({ specialistId: 1, assisted: 1 }).lean() as IBooking | null;
  if (!pre?.assisted) throw notFound();
  // S5: a capture for a booking whose doctor is not verified and active is never applied (returned to the card).
  const doctorBlocked = !!pre.specialistId && await doctorExistsIneligible(pre.specialistId);
  const outcome = await runLedgerTransaction<Outcome>(async (s) => {
    const rec = await PaymentRecordModel.findById(rid).session(s).lean() as unknown as IPaymentRecord | null;
    if (!rec || rec.context !== 'assisted_booking' || lower(rec.contextId) !== id) throw notFound();
    if (rec.isProcessed) return 'already';
    if (rec.status !== 'paid') throw err(409, 'PAYMENT_CHANGED', 'Payment changed; refresh before retrying');
    const b = await BookingModel.findById(id).session(s).lean() as IBooking | null;
    const f = b?.assisted?.funding;
    if (!b || !f || f.method !== 'razorpay' || lower(f.payerId) !== lower(rec.payerPharmacyId)) throw notFound();
    const amount = recordPaiseOf(rec);
    // r10b: this record already confirmed the booking (a crash or a racing call came between that and the follow-up):
    // nothing moves again; the follow-up below is resumed and only then is the record processed.
    if (lower(b.paymentTransactionId) === rid && lower(f.paymentRecordId) === rid && f.state !== 'pending' && f.state !== 'not_paid') return 'appliedBefore';
    const applicable = !doctorBlocked && b.status === 'pending' && b.paymentStatus === 'pending' && f.state === 'pending'
      && lower(f.paymentRecordId) === rid && amount === f.amountMinor;
    const audit = { actorKind: 'pharmacy' as const, actorId: lower(b.assisted!.bookedBy.actorId), orgKind: 'pharmacy' as const, orgId: lower(f.payerId), bookingId: id };
    if (applicable) {
      const at = new Date().toISOString();
      const moved = await BookingModel.updateOne({ _id: id, status: 'pending', paymentStatus: 'pending', 'assisted.funding.state': 'pending' },
        { $set: { status: 'confirmed', paymentStatus: 'paid', paymentTransactionId: rid, 'assisted.funding.state': 'captured',
          ...(rec.razorpayPaymentId ? { 'assisted.funding.razorpayPaymentId': rec.razorpayPaymentId } : {}),
          'lifecycle.paid': { at, by: 'pharmacy_card', amount: amount / 100 }, 'lifecycle.confirmed': { at } } }, { session: s });
      if (moved.modifiedCount !== 1) throw Object.assign(err(409, 'BOOKING_CHANGED', 'Booking changed; please retry'), { retryable: true });
      // r10b: the record stays unprocessed until the follow-up work is done (below), so verify, reconcile or the recovery
      // sweep (paid, unprocessed records) resume it after a crash. The booking CAS above is what confirms exactly once.
      await auditIn({ ...audit, action: 'booking.paid', detail: { paymentRecordId: rid, amountMinor: amount } }, s);
      return 'applied';
    }
    const q = await queueCardRefundIn({ bookingId: id, payerId: f.payerId, record: rec, cause: 'late_capture', to: 'card' }, s);
    if (q.created) await BookingModel.updateOne({ _id: id }, { $push: { 'assisted.funding.refunds': q.row } }, { session: s });
    await auditIn({ ...audit, action: 'booking.late_capture', detail: { paymentRecordId: rid, amountMinor: amount, bookingStatus: b.status,
      doctorBlocked, refundState: q.refund.state } }, s);
    return 'returned';
  });
  if (outcome === 'returned') await kickCardRefunds(id);
  const booking = await BookingModel.findById(id).lean() as IBooking;
  const confirmed = booking?.status === 'confirmed' && lower(booking.paymentTransactionId) === rid;
  let entity: IBooking = booking;
  // r10d: ONE caller runs the follow-up: it claims it (a lease on the booking, set only while free) so racing verify,
  // reconcile and sweep calls never create two Meet events; a crashed claim is taken over once its lease ends. A caller
  // that finds it claimed leaves the record unprocessed for the claimer (or, after a crash, the sweep) to finish.
  let claimedFollowUp = false;
  if (confirmed && (booking as IBooking & { postPaymentCompletedFor?: string }).postPaymentCompletedFor !== rid) {
    const t = Date.now();
    claimedFollowUp = (await BookingModel.collection.updateOne(
      { _id: new Types.ObjectId(id), postPaymentCompletedFor: { $ne: rid },
        $or: [{ 'assisted.followUpLeaseUntil': { $exists: false } }, { 'assisted.followUpLeaseUntil': { $lte: new Date(t) } }] },
      { $set: { 'assisted.followUpLeaseUntil': new Date(t + FOLLOW_UP_LEASE_MS) } })).modifiedCount === 1;
  }
  if (claimedFollowUp) {
    // After the confirmation only: Meet (neutral), reminders, the notices. r10b: resumed by any later verify, reconcile or
    // recovery sweep until done, because the record is marked processed only after this.
    const fx = assistedEffects();
    const withMeet = booking.consultationMode === 'in-person' ? booking : await bestEffort('meet', () => boundedMeet(fx, booking), booking);
    await bestEffort('reminders', () => fx.reminders(withMeet), undefined);
    const { bookedNotices } = await import('@/modules/assisted/consultations');
    await sendAssistedNotices(await bookedNotices(withMeet) as AssistedNotice[]);
    await BookingModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { postPaymentCompletedFor: rid }, $unset: { 'assisted.followUpLeaseUntil': '' } });
    entity = (await BookingModel.findById(id).lean() as IBooking) ?? withMeet;
  }
  const followUpDone = !confirmed || (entity as IBooking & { postPaymentCompletedFor?: string })?.postPaymentCompletedFor === rid;
  if ((outcome === 'applied' || outcome === 'appliedBefore') && followUpDone) {
    await PaymentRecordModel.updateOne({ _id: rid, status: 'paid', isProcessed: { $ne: true } }, { $set: { isProcessed: true } });
  }
  const paymentRecord = await PaymentRecordModel.findById(rid).lean() as unknown as IPaymentRecord;
  return { paymentRecord, entity };
}

/**
 * r10e: OTHER captures on a card booking's order (Razorpay takes more than one payment on an order that is only
 * "attempted": a slow UPI payment and a second "pay now"). Only the record's own capture (`razorpayPaymentId`) counts;
 * every other captured payment is returned to its card, once per Razorpay payment id, whatever the booking's state
 * (paid, cancelled, expired). Audited `booking.extra_capture`.
 */
export async function settleOtherAssistedCaptures(record: IPaymentRecord, captured: { id: string; amount: number; currency: string }[]): Promise<number> {
  const own = record.razorpayPaymentId;
  const others = captured.filter((p) => p && p.id && p.id !== own && String(p.currency).toUpperCase() === String(record.currency).toUpperCase());
  if (!own || !others.length || record.context !== 'assisted_booking') return 0;
  const id = lower(record.contextId);
  const b = Types.ObjectId.isValid(id) ? await BookingModel.findById(id).select({ assisted: 1 }).lean() as IBooking | null : null;
  const payerId = lower(b?.assisted?.funding?.payerId ?? record.payerPharmacyId);
  if (!payerId) return 0;
  let queued = 0;
  for (const p of others) {
    const created = await runLedgerTransaction(async (s) => {
      const q = await queueExtraCaptureRefundIn({ bookingId: id, payerId, recordId: lower(record._id), razorpayPaymentId: p.id, amountMinor: p.amount }, s);
      if (!q.created) return false;
      await BookingModel.updateOne({ _id: id }, { $push: { 'assisted.funding.refunds': q.row } }, { session: s });
      await auditIn({ actorKind: 'pharmacy', actorId: lower(b?.assisted?.bookedBy?.actorId ?? payerId), orgKind: 'pharmacy', orgId: payerId, bookingId: id,
        action: 'booking.extra_capture', detail: { paymentRecordId: lower(record._id), razorpayPaymentId: p.id, amountMinor: p.amount } }, s);
      return true;
    });
    if (created) queued += 1;
  }
  if (queued) await kickCardRefunds(id);
  return queued;
}

/**
 * r10e: a capture can land on an order after its record was settled (verify and the recovery sweep then never look again),
 * so paid or returned card records are checked for other captures for 7 days, with back-off (10 min doubling, at most
 * every 6 h). Run by the assisted scheduler every 5 minutes.
 */
export async function sweepAssistedOtherCaptures(now: Date = new Date(), limit = 50): Promise<{ checked: number }> {
  const rows = await PaymentRecordModel.find({ context: 'assisted_booking', paymentGateway: 'razorpay', status: { $in: ['paid', 'refunded'] },
    razorpayPaymentId: { $type: 'string' }, createdAt: { $gte: new Date(now.getTime() - 7 * 86_400_000) },
    $or: [{ extraCheckNextAt: { $exists: false } }, { extraCheckNextAt: null }, { extraCheckNextAt: { $lte: now } }] })
    .sort({ extraCheckNextAt: 1, createdAt: 1 }).limit(limit).select({ _id: 1, payerUserId: 1, userId: 1, extraChecks: 1 }).lean() as unknown as IPaymentRecord[];
  for (const r of rows) {
    // Reconcile looks at every payment on the order (r10e); a returned record answers its state afterwards (ignored).
    await payments().reconcilePaymentAndProcess({ paymentTransactionId: String(r._id), userId: String(r.payerUserId || r.userId) }).catch(() => undefined);
    const checks = Number(r.extraChecks || 0) + 1;
    await PaymentRecordModel.updateOne({ _id: r._id }, { $set: { extraChecks: checks,
      extraCheckNextAt: new Date(now.getTime() + Math.min(6 * 3_600_000, 10 * 60_000 * 2 ** Math.min(checks - 1, 10))) } });
  }
  return { checked: rows.length };
}

/** Registers the 'assisted_booking' payment context (called once at start-up, and by tests). */
export function registerAssistedPayments(): void {
  registerPaymentContextHandler('assisted_booking', {
    settleOtherCaptures: (record, captured) => settleOtherAssistedCaptures(record, captured),
    process: (record) => applyAssistedCapture(record),
    entity: async (record) => (Types.ObjectId.isValid(String(record.contextId)) ? BookingModel.findById(record.contextId).lean() : null) ?? {},
  });
}
