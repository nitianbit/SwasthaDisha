import { Container } from 'typedi';
import { Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import type { IBooking } from '@/modules/bookings/types';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentService, registerPaymentContextHandler } from '@/modules/payment/services';
import { ASSISTED_CARD_CONTEXTS, type AssistedCardContext, type IPaymentRecord } from '@/modules/payment/types';
import { doctorExistsIneligible } from '@/modules/specialists/eligibility';
import { BOOKING_PAYMENT_WINDOW_MS } from '@/modules/bookings/holds';
import PartnerOrgModel from '@/modules/partners/model';
import {
  bookingModelOf, cardKindOf, kickCardRefunds, queueCardRefundIn, queueExtraCaptureRefundIn, recordPaiseOf, recordPayerOf,
} from '@/modules/assisted/cardRefunds';
import { AssistedCardRefundModel } from '@/modules/assisted/model';
import { assistedFlags } from '@/modules/assisted/flags';
import type { AssistedBookingKind } from '@/modules/assisted/types';
import { refOf, type BookerLike } from '@/modules/assisted/bookers';
import { assistedEffects, auditIn, bestEffort, sendAssistedNotices, type AssistedNotice } from '@/modules/assisted/support';

/**
 * Assisted booking phase 1b (design §6.4): a booker (pharmacy) pays an assisted consultation by card/UPI.
 *
 * - The booking is created `pending` with its seat and the doctor's interval held, exactly like a customer's online
 *   booking, and ONE payment record (context `assisted_booking`, contextId = the booking, payer = the pharmacy, its id
 *   chosen before the insert and stored as `assisted.funding.paymentRecordId`) carries one Razorpay order.
 * - Verify, reconcile, the recovery sweep and the expiry sweep all reach `applyAssistedCaptureOf` through the payment
 *   context registry (S6: routing by the stored record's context only). It applies the capture in ONE transaction that
 *   claims the record (`isProcessed`) and moves the booking pending → confirmed, so the booking is confirmed exactly once.
 * - A capture that cannot be applied (the booking expired or was cancelled, the doctor is no longer verified and active,
 *   another record, an amount that differs) is a LATE capture: in the same transaction its card refund row is queued
 *   (assisted/cardRefunds.ts, once per record) and sent back to the card. Never lost, never applied twice.
 * - The patient's and doctor's notices, Meet and reminders follow the confirmation (not the pending insert), resumed on
 *   replay until done (`postPaymentCompletedFor`), as the customer path does.
 *
 * r14 (§24.5): the same machinery pays an assisted LAB booking (a pharmacy books a lab test by card/UPI). Everything
 * here is generalised over the booking kind (`KINDS`): the payment context (`assisted_lab_booking`), the collection
 * (`partner_lab_bookings`), what "waiting for payment" means (`pending_payment`, its `paymentDeadline`), the provider
 * admission for S5 (an active, verified lab) and the follow-up after confirmation (the patient's notice). Order,
 * capture, late and extra captures, the follow-up lease, the sweeps and the refund rows are the one code path.
 */
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const payments = (): PaymentService => Container.get(PaymentService);
type Row = Record<string, any>;

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

/**
 * The card admission of a NEW assisted booking, decided before anything is counted or held (the same answer for every
 * number): the switch ASSISTED_CARD_PAYMENT_ENABLED (400 PAYMENT_METHOD_UNAVAILABLE), the gateway keys (503
 * RAZORPAY_NOT_CONFIGURED) and the card refund rows' unique index (503 INDEXES_OUTDATED until sync-indexes has run).
 * r14: shared by consultations and lab bookings.
 */
export async function assertCardPaymentAvailable(): Promise<void> {
  if (!assistedFlags.card()) throw err(400, 'PAYMENT_METHOD_UNAVAILABLE', 'Card and UPI payment of assisted bookings is not switched on; pay from the wallet');
  assertCardGatewayReady();
  // A card booking's refunds rely on the one-row-per-capture unique index (fail closed until sync-indexes has run).
  await assertUniqueIndex(AssistedCardRefundModel, { captureKey: 1 });
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

/** r14: what differs between a consultation and a lab booking paid by card; everything else is one code path. */
interface CardKind {
  context: AssistedCardContext;
  /** The booking still waits for its card payment (its seat held, its order open). */
  waiting(b: Row): boolean;
  /** When it expires (its seat is released) unless the payment arrived (ISO). */
  payBy(b: Row): string;
  /** S5: the provider (doctor, lab) is no longer verified and active, so a capture is returned instead of applied. */
  providerBlocked(b: Row): Promise<boolean>;
  /** The late-capture audit's name for that refusal. */
  blockedKey: 'doctorBlocked' | 'labBlocked';
  /** Added to every audit detail of this kind (lab rows carry `kind: 'lab_booking'`, as every lab audit does). */
  auditDetail: Record<string, unknown>;
  /** The compare-and-set that confirms the waiting booking with this capture (applied exactly once). */
  confirm(id: string, rid: string, rec: IPaymentRecord, amount: number): { filter: Row; update: Row };
  /** After the confirmation, by the one caller holding the lease: the work that tells people; the booking as it stands after. */
  followUp(b: Row): Promise<Row>;
}

const KINDS: Record<AssistedBookingKind, CardKind> = {
  booking: {
    context: 'assisted_booking',
    waiting: (b) => b.status === 'pending' && b.paymentStatus === 'pending',
    payBy: (b) => new Date(new Date(b.createdAt ?? Date.now()).getTime() + BOOKING_PAYMENT_WINDOW_MS).toISOString(),
    providerBlocked: async (b) => !!b.specialistId && await doctorExistsIneligible(b.specialistId),
    blockedKey: 'doctorBlocked',
    auditDetail: {},
    confirm: (id, rid, rec, amount) => {
      const at = new Date().toISOString();
      return { filter: { _id: id, status: 'pending', paymentStatus: 'pending', 'assisted.funding.state': 'pending' },
        update: { $set: { status: 'confirmed', paymentStatus: 'paid', paymentTransactionId: rid, 'assisted.funding.state': 'captured',
          ...(rec.razorpayPaymentId ? { 'assisted.funding.razorpayPaymentId': rec.razorpayPaymentId } : {}),
          'lifecycle.paid': { at, by: 'pharmacy_card', amount: amount / 100 }, 'lifecycle.confirmed': { at } } } };
    },
    followUp: async (booking) => {
      // Meet (neutral), reminders, the notices to the patient and the doctor.
      const fx = assistedEffects();
      const b = booking as IBooking;
      const withMeet = b.consultationMode === 'in-person' ? b : await bestEffort('meet', () => boundedMeet(fx, b), b);
      await bestEffort('reminders', () => fx.reminders(withMeet), undefined);
      const { bookedNotices } = await import('@/modules/assisted/consultations');
      await sendAssistedNotices(await bookedNotices(withMeet) as AssistedNotice[]);
      return withMeet;
    },
  },
  // r14 (§24.5): a pharmacy's lab booking — `pending_payment` until paid, 30 minutes to its `paymentDeadline`, S5 = an
  // active, verified lab (§24.1 item 12); confirming bumps `statusVersion` (every lab step is fenced on it).
  lab_booking: {
    context: 'assisted_lab_booking',
    waiting: (b) => b.status === 'pending_payment' && b.paymentStatus === 'pending',
    payBy: (b) => new Date(b.paymentDeadline).toISOString(),
    providerBlocked: async (b) => {
      const { labAdmissible } = await import('@/modules/assisted/labBookings');
      return !labAdmissible(Types.ObjectId.isValid(String(b.partnerId)) ? await PartnerOrgModel.findById(b.partnerId).lean() as Row | null : null);
    },
    blockedKey: 'labBlocked',
    auditDetail: { kind: 'lab_booking' },
    confirm: (id, rid, rec) => {
      const at = new Date();
      return { filter: { _id: id, status: 'pending_payment', paymentStatus: 'pending', 'assisted.funding.state': 'pending' },
        update: { $set: { status: 'confirmed', paymentStatus: 'paid', paymentTransactionId: rid, 'assisted.funding.state': 'captured',
          ...(rec.razorpayPaymentId ? { 'assisted.funding.razorpayPaymentId': rec.razorpayPaymentId } : {}),
          'lifecycle.paidAt': at, 'lifecycle.confirmedAt': at }, $inc: { statusVersion: 1 } } };
    },
    followUp: async (b) => {
      // The patient's "booked" notice (the lab sees the row in its list once it is paid, L18).
      const { notifyLabBooked } = await import('@/modules/assisted/labBookings');
      await notifyLabBooked(b as never);
      return b;
    },
  },
};

/** The audit's actor and organisation of a payer's booking (a pharmacy, or a lab member for its lab). */
const auditActorOf = (payerKind: string, actorId: unknown, payerId: string) => ({
  actorKind: (payerKind === 'pharmacy' ? 'pharmacy' : 'member') as 'pharmacy' | 'member', actorId: lower(actorId),
  orgKind: payerKind as 'pharmacy' | 'lab', orgId: lower(payerId) });

function viewOf(kind: AssistedBookingKind, r: IPaymentRecord, b: Row): CardPaymentView {
  return { paymentRequired: true, paymentTransactionId: String(r._id), razorpayOrderId: r.razorpayOrderId,
    razorpayKeyId: (payments() as unknown as { getRazorpayCredentials(): { keyId: string } }).getRazorpayCredentials().keyId,
    amount: Number(r.finalAmount), amountMinor: recordPaiseOf(r), currency: r.currency, payBy: KINDS[kind].payBy(b) };
}

/**
 * The open Razorpay order of a pending card booking: the stored record, or (first time, or after a failed order call)
 * a new order saved under the pre-chosen record id — two racing callers save one record (the loser's order is never
 * shown, so it can never be paid). null when the booking is not waiting for its card payment.
 */
export async function openCardOrderOf(kind: AssistedBookingKind, b: Row, opts: { create: boolean } = { create: true }): Promise<CardPaymentView | null> {
  const k = KINDS[kind];
  const f = b.assisted?.funding;
  if (!f || f.method !== 'razorpay' || f.state !== 'pending' || !k.waiting(b) || !f.paymentRecordId) return null;
  const stored = await PaymentRecordModel.findById(f.paymentRecordId).lean() as unknown as IPaymentRecord | null;
  if (stored) return stored.status === 'created' ? viewOf(kind, stored, b) : null;
  if (!opts.create) return null;
  try {
    // 2e: the paying organisation by its kind — a pharmacy (`payerPharmacyId`) or a lab and its booking member
    // (`payerPartnerId`, `payerMemberId`); verification by organisation reads these (§6.1).
    const actorId = b.assisted.bookedBy.actorId;
    const payer = f.payerKind === 'lab' ? { payerPartnerId: lower(f.payerId), payerMemberId: lower(actorId) } : { payerPharmacyId: f.payerId };
    const out = await payments().createOrder({ recordId: f.paymentRecordId, userId: actorId, payerUserId: actorId, ...payer,
      context: k.context, contextId: lower(b._id), baseAmount: f.amountMinor / 100, finalAmount: f.amountMinor / 100,
      notes: { flow: k.context, [f.payerKind === 'lab' ? 'partnerId' : 'pharmacyId']: f.payerId, bookingId: lower(b._id) } });
    return viewOf(kind, out.paymentRecord, b);
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const raced = await PaymentRecordModel.findById(f.paymentRecordId).lean() as unknown as IPaymentRecord | null;
      return raced?.status === 'created' ? viewOf(kind, raced, b) : null;
    }
    throw err(502, 'RAZORPAY_ORDER_CREATION_FAILED',
      'The card payment could not be started. The booking is held for 30 minutes: send the same request again (same requestKey) to retry');
  }
}
/** Phase 1b: a consultation's open order (the 1b name, kept for its callers). */
export const openCardOrder = (b: IBooking, opts?: { create: boolean }) => openCardOrderOf('booking', b as Row, opts);

/**
 * r10c / r10d (r14: both kinds): the `payment` field of the booker's view of each of ITS OWN assisted bookings — the
 * method and the funding state; for a card booking the record to resume (`paymentTransactionId`) and, while it waits
 * for its payment, `payBy` and the open order (`razorpayOrderId` / `razorpayKeyId`, null when none is open yet: replay
 * the create), so "pay now" works from any device. Read only. Never in a patient's, doctor's or lab's view.
 */
export async function bookerPayments(kind: AssistedBookingKind, rows: Row[], bookerLike: BookerLike): Promise<Map<string, Row>> {
  const k = KINDS[kind];
  const booker = refOf(bookerLike);
  const out = new Map<string, Row>();
  for (const b of rows) {
    const f = b?.assisted?.funding;
    if (!f || b.assisted.bookedBy?.kind !== booker.kind || lower(b.assisted.bookedBy.id) !== booker.id) continue;
    const card = f.method === 'razorpay';
    const waiting = card && f.state === 'pending' && k.waiting(b);
    const order = waiting ? await openCardOrderOf(kind, b, { create: false }).catch(() => null) : null;
    out.set(String(b._id), { method: card ? 'razorpay' : 'wallet', state: f.state, payBy: waiting ? k.payBy(b) : null,
      ...(card ? { paymentTransactionId: f.paymentRecordId ?? null } : {}),
      ...(waiting ? { razorpayOrderId: order?.razorpayOrderId ?? null, razorpayKeyId: order?.razorpayKeyId ?? null } : {}) });
  }
  return out;
}

/** The assisted card payment context handler of a booking kind (registered at start-up and by tests). */
export async function applyAssistedCaptureOf(kind: AssistedBookingKind, record: IPaymentRecord): Promise<{ paymentRecord: IPaymentRecord; entity: unknown }> {
  const k = KINDS[kind];
  const Model = bookingModelOf(kind);
  const notFound = () => err(404, 'BOOKING_NOT_FOUND', 'Booking not found for this payment');
  const id = lower(record.contextId);
  const rid = lower(record._id);
  if (!Types.ObjectId.isValid(id)) throw notFound();
  const pre = await Model.findById(id).select({ specialistId: 1, partnerId: 1, assisted: 1 }).lean() as Row | null;
  if (!pre?.assisted) throw notFound();
  // S5: a capture for a booking whose provider (doctor; r14: lab) is not verified and active is never applied (returned to the card).
  const blocked = await k.providerBlocked(pre);
  const outcome = await runLedgerTransaction<Outcome>(async (s) => {
    const rec = await PaymentRecordModel.findById(rid).session(s).lean() as unknown as IPaymentRecord | null;
    if (!rec || rec.context !== k.context || lower(rec.contextId) !== id) throw notFound();
    if (rec.isProcessed) return 'already';
    if (rec.status !== 'paid') throw err(409, 'PAYMENT_CHANGED', 'Payment changed; refresh before retrying');
    const b = await Model.findById(id).session(s).lean() as Row | null;
    const f = b?.assisted?.funding;
    const payer = recordPayerOf(rec);
    if (!b || !f || f.method !== 'razorpay' || f.payerKind !== payer.kind || lower(f.payerId) !== payer.id) throw notFound();
    const amount = recordPaiseOf(rec);
    // r10b: this record already confirmed the booking (a crash or a racing call came between that and the follow-up):
    // nothing moves again; the follow-up below is resumed and only then is the record processed.
    if (lower(b.paymentTransactionId) === rid && lower(f.paymentRecordId) === rid && f.state !== 'pending' && f.state !== 'not_paid') return 'appliedBefore';
    const applicable = !blocked && k.waiting(b) && f.state === 'pending' && lower(f.paymentRecordId) === rid && amount === f.amountMinor;
    const audit = { ...auditActorOf(f.payerKind, b.assisted.bookedBy.actorId, f.payerId), bookingId: id };
    if (applicable) {
      const { filter, update } = k.confirm(id, rid, rec, amount);
      const moved = await Model.updateOne(filter, update, { session: s });
      if (moved.modifiedCount !== 1) throw Object.assign(err(409, 'BOOKING_CHANGED', 'Booking changed; please retry'), { retryable: true });
      // r10b: the record stays unprocessed until the follow-up work is done (below), so verify, reconcile or the recovery
      // sweep (paid, unprocessed records) resume it after a crash. The booking CAS above is what confirms exactly once.
      await auditIn({ ...audit, action: 'booking.paid', detail: { ...k.auditDetail, paymentRecordId: rid, amountMinor: amount } }, s);
      return 'applied';
    }
    const q = await queueCardRefundIn({ bookingId: id, bookingKind: kind, payerKind: f.payerKind, payerId: f.payerId, record: rec, cause: 'late_capture', to: 'card' }, s);
    if (q.created) await Model.updateOne({ _id: id }, { $push: { 'assisted.funding.refunds': q.row } }, { session: s });
    await auditIn({ ...audit, action: 'booking.late_capture', detail: { ...k.auditDetail, paymentRecordId: rid, amountMinor: amount, bookingStatus: b.status,
      [k.blockedKey]: blocked, refundState: q.refund.state } }, s);
    return 'returned';
  });
  if (outcome === 'returned') await kickCardRefunds(id);
  const booking = await Model.findById(id).lean() as Row;
  const confirmed = booking?.status === 'confirmed' && lower(booking.paymentTransactionId) === rid;
  let entity: Row = booking;
  // r10d: ONE caller runs the follow-up: it claims it (a lease on the booking, set only while free) so racing verify,
  // reconcile and sweep calls never create two Meet events (r14: two lab notices); a crashed claim is taken over once its
  // lease ends. A caller that finds it claimed leaves the record unprocessed for the claimer (or, after a crash, the sweep) to finish.
  let claimedFollowUp = false;
  if (confirmed && booking.postPaymentCompletedFor !== rid) {
    const t = Date.now();
    claimedFollowUp = (await Model.collection.updateOne(
      { _id: new Types.ObjectId(id), postPaymentCompletedFor: { $ne: rid },
        $or: [{ 'assisted.followUpLeaseUntil': { $exists: false } }, { 'assisted.followUpLeaseUntil': { $lte: new Date(t) } }] },
      { $set: { 'assisted.followUpLeaseUntil': new Date(t + FOLLOW_UP_LEASE_MS) } })).modifiedCount === 1;
  }
  if (claimedFollowUp) {
    // After the confirmation only (consultation: Meet, reminders, the notices; lab: the patient's notice). r10b: resumed
    // by any later verify, reconcile or recovery sweep until done, because the record is marked processed only after this.
    const after = await k.followUp(booking);
    await Model.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { postPaymentCompletedFor: rid }, $unset: { 'assisted.followUpLeaseUntil': '' } });
    entity = (await Model.findById(id).lean() as Row) ?? after;
  }
  const followUpDone = !confirmed || entity?.postPaymentCompletedFor === rid;
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
 * (paid, cancelled, expired). Audited `booking.extra_capture`. r14: consultations and lab bookings alike.
 */
export async function settleOtherAssistedCaptures(record: IPaymentRecord, captured: { id: string; amount: number; currency: string }[]): Promise<number> {
  const own = record.razorpayPaymentId;
  const others = captured.filter((p) => p && p.id && p.id !== own && String(p.currency).toUpperCase() === String(record.currency).toUpperCase());
  const kind = cardKindOf(record.context);
  if (!own || !others.length || !kind) return 0;
  const Model = bookingModelOf(kind);
  const id = lower(record.contextId);
  const b = Types.ObjectId.isValid(id) ? await Model.findById(id).select({ assisted: 1 }).lean() as Row | null : null;
  const payer = b?.assisted?.funding ? { kind: b.assisted.funding.payerKind, id: lower(b.assisted.funding.payerId) } : recordPayerOf(record);
  const payerId = payer.id;
  if (!payerId) return 0;
  let queued = 0;
  for (const p of others) {
    const created = await runLedgerTransaction(async (s) => {
      const q = await queueExtraCaptureRefundIn({ bookingId: id, bookingKind: kind, payerKind: payer.kind, payerId, recordId: lower(record._id), razorpayPaymentId: p.id,
        amountMinor: p.amount }, s);
      if (!q.created) return false;
      await Model.updateOne({ _id: id }, { $push: { 'assisted.funding.refunds': q.row } }, { session: s });
      await auditIn({ ...auditActorOf(payer.kind, b?.assisted?.bookedBy?.actorId ?? payerId, payerId), bookingId: id,
        action: 'booking.extra_capture', detail: { ...KINDS[kind].auditDetail, paymentRecordId: lower(record._id), razorpayPaymentId: p.id, amountMinor: p.amount } }, s);
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
 * every 6 h). Run by the assisted scheduler every 5 minutes. r14: lab bookings' card records too.
 */
export async function sweepAssistedOtherCaptures(now: Date = new Date(), limit = 50): Promise<{ checked: number }> {
  const rows = await PaymentRecordModel.find({ context: { $in: ASSISTED_CARD_CONTEXTS }, paymentGateway: 'razorpay', status: { $in: ['paid', 'refunded'] },
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

/**
 * Registers the assisted card payment contexts (called once at start-up, and by tests): `assisted_booking` and (r14)
 * `assisted_lab_booking`, both handled by the one code path above.
 */
export function registerAssistedPayments(): void {
  for (const kind of Object.keys(KINDS) as AssistedBookingKind[]) {
    registerPaymentContextHandler(KINDS[kind].context, {
      settleOtherCaptures: (record, captured) => settleOtherAssistedCaptures(record, captured),
      process: (record) => applyAssistedCaptureOf(kind, record),
      entity: async (record) => (Types.ObjectId.isValid(String(record.contextId)) ? bookingModelOf(kind).findById(record.contextId).lean() : null) ?? {},
    });
  }
}
