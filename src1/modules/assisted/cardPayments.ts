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
import { kickCardRefunds, queueCardRefundIn, recordPaiseOf } from '@/modules/assisted/cardRefunds';
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

type Outcome = 'applied' | 'already' | 'returned';

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
      const claimed = await PaymentRecordModel.updateOne({ _id: rid, isProcessed: { $ne: true } }, { $set: { isProcessed: true } }, { session: s });
      if (claimed.modifiedCount !== 1) throw Object.assign(err(409, 'PAYMENT_CHANGED', 'Payment changed; please retry'), { retryable: true });
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
  if (confirmed && (booking as IBooking & { postPaymentCompletedFor?: string }).postPaymentCompletedFor !== rid) {
    // After the confirmation only, resumed on a replay until it has completed: Meet (neutral), reminders, the notices.
    const fx = assistedEffects();
    const withMeet = booking.consultationMode === 'in-person' ? booking : await bestEffort('meet', () => fx.meet(booking), booking);
    await bestEffort('reminders', () => fx.reminders(withMeet), undefined);
    const { bookedNotices } = await import('@/modules/assisted/consultations');
    await sendAssistedNotices(await bookedNotices(withMeet) as AssistedNotice[]);
    await BookingModel.updateOne({ _id: id }, { $set: { postPaymentCompletedFor: rid } });
    entity = (await BookingModel.findById(id).lean() as IBooking) ?? withMeet;
  }
  const paymentRecord = await PaymentRecordModel.findById(rid).lean() as unknown as IPaymentRecord;
  return { paymentRecord, entity };
}

/** Registers the 'assisted_booking' payment context (called once at start-up, and by tests). */
export function registerAssistedPayments(): void {
  registerPaymentContextHandler('assisted_booking', {
    process: (record) => applyAssistedCapture(record),
    entity: async (record) => (Types.ObjectId.isValid(String(record.contextId)) ? BookingModel.findById(record.contextId).lean() : null) ?? {},
  });
}
