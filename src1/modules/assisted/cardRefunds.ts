import { randomUUID } from 'node:crypto';
import { ClientSession, Model, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import BookingModel from '@/modules/bookings/model';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import PharmacyModel from '@/modules/pharmacies/model';
import PaymentRecordModel from '@/modules/payment/model';
import { ASSISTED_CARD_CONTEXTS, type AssistedCardContext, type IPaymentRecord } from '@/modules/payment/types';
import PartnerOrgModel from '@/modules/partners/model';
import SpecialistModel from '@/modules/specialists/model';
import { doctorIsEligible } from '@/modules/specialists/eligibility';
import { doctorBookerName } from '@/modules/assisted/labViews';
import { postBookerMovementIn } from '@/modules/assisted/bookerWallet';
import { RazorpayRefundGateway, type GatewayRefund, type RefundGateway } from '@/modules/pharmacyOrders/prescriptionRefund';
import { AssistedCardRefundModel, type IAssistedCardRefund } from '@/modules/assisted/model';
import type { AssistedBookingKind, AssistedRefundRow, BookerKind } from '@/modules/assisted/types';
import { raiseAlertIn } from '@/modules/assisted/limits';
import { auditIn } from '@/modules/assisted/support';
import { runLedgerTransaction as inTransaction } from '@/modules/common/utils/bookingWalletFunding';
import logger from '@/services/logger';

/**
 * Assisted booking phase 1b (design §6.4, §8.4): returning a card/UPI capture of an assisted booking to its payer.
 *
 * - One row per payment record's own capture (r10e: plus one per EXTRA capture on its order; unique per captured payment,
 *   `captureKey`): the cancellation refund of a card-paid
 *   booking and a late capture both go through `queueCardRefundIn`, so a capture is returned at most once, whichever path
 *   (cancel, expiry, verify, reconcile, sweep) finds it first.
 * - `card` (the default, "back the way the partner paid"): a `pending` row sent by the worker below — fenced attempts
 *   (attemptId + lease), the gateway is asked for a refund carrying this row's key before anything is (re)submitted, every
 *   submission is counted first; only `processed` at Razorpay completes it. A clear refusal or Razorpay `failed` ends in
 *   `failed` (operator queue); unknown outcomes stay `pending` and are looked up again later.
 * - `wallet` (the partner's choice at its own cancel): a `refund_credit` to the pharmacy wallet in the same transaction;
 *   card money returned to the wallet opens no top-up lot, so it is not withdrawable (ASSUMED, conservative).
 * - A record with a card dispute recorded (`chargebackAt`) is never refunded again, to the card or the wallet: its row is
 *   `manual_review` (the bank already took the money back).
 * - Jansetu bears the gateway fee: the refund is always the full captured amount.
 * - r14 (§24.5): the same rows return the card captures of assisted LAB bookings; a row's `bookingKind` names the
 *   collection of its `bookingId` (rows from before r14 carry none and are consultations).
 * - r29 (§25.6): the payer may be a doctor (a lab booking it made): `payerKind: 'doctor'`; a wallet refund credits the
 *   doctor wallet (no lot, not withdrawable, C3).
 */
const LEASE_MS = 300_000;
/** r10b: real failures (gateway unreachable, outcome unknown, mismatch) before the worker stops and the row waits for an admin. */
export const CARD_REFUND_MAX_ATTEMPTS = 20;
/** r10b: back-off between lookups of a refund Razorpay still reports pending: 10 min doubling, at most 12 h, without end. */
const pendingDelay = (checks: number) => Math.min(12 * 3_600_000, 10 * 60_000 * 2 ** Math.min(Math.max(checks - 1, 0), 10));
/** r10b: back-off after a real failure: 5 min doubling, at most 6 h (until the failure cap). */
const failureDelay = (attempts: number) => Math.min(6 * 3_600_000, 5 * 60_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 10));
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const lower = (v: unknown) => String(v ?? '').toLowerCase();
export const recordPaiseOf = (r: Pick<IPaymentRecord, 'finalAmountPaise' | 'finalAmount'>) =>
  Number.isSafeInteger(r.finalAmountPaise) ? Number(r.finalAmountPaise) : Math.round(Number(r.finalAmount || 0) * 100);

/**
 * r14b: what is keyed by an assisted booking's kind, in one table — its collection, the context of its card payments and
 * the reference type of its pharmacy-wallet movements (as its wallet debit and refund write it). A missing kind is a
 * consultation (card refund rows from before r14).
 */
const BOOKING_KINDS: Record<AssistedBookingKind, { model: () => Model<any>; cardContext: AssistedCardContext; walletReference: string }> = {
  booking: { model: () => BookingModel as unknown as Model<any>, cardContext: 'assisted_booking', walletReference: 'assisted_booking' },
  lab_booking: { model: () => PartnerLabBookingModel as unknown as Model<any>, cardContext: 'assisted_lab_booking', walletReference: 'assisted_lab_booking' },
};
const kindRow = (kind?: string | null) => BOOKING_KINDS[kind === 'lab_booking' ? 'lab_booking' : 'booking'];
/** The context of a booking kind's card payments. */
export const cardContextOf = (kind: AssistedBookingKind): AssistedCardContext => BOOKING_KINDS[kind].cardContext;
/** The booking kind of an assisted card payment context (null for any other context). */
export const cardKindOf = (context: unknown): AssistedBookingKind | null =>
  (Object.keys(BOOKING_KINDS) as AssistedBookingKind[]).find((k) => BOOKING_KINDS[k].cardContext === context) ?? null;
/** The collection of an assisted booking of this kind. */
export const bookingModelOf = (kind?: string | null): Model<any> => kindRow(kind).model();
const walletReferenceOf = (kind?: string | null) => kindRow(kind).walletReference;

let gateway: RefundGateway | null = null;
/** Tests replace the gateway; production uses Razorpay (keys from CONFIG). */
export function setAssistedRefundGateway(g?: RefundGateway | null): void { gateway = g ?? null; }
const gw = (): RefundGateway => (gateway ??= new RazorpayRefundGateway());

/** Mirrors a card refund row's state onto the booking's `assisted.funding.refunds` entry (display only; the row is the truth). */
async function syncBookingRow(row: Pick<IAssistedCardRefund, '_id' | 'bookingId' | 'bookingKind'>, set: Record<string, unknown>, s?: ClientSession): Promise<void> {
  if (!Types.ObjectId.isValid(row.bookingId)) return;
  const $set = Object.fromEntries(Object.entries(set).map(([k, v]) => [`assisted.funding.refunds.$[r].${k}`, v]));
  await bookingModelOf(row.bookingKind).collection.updateOne({ _id: new Types.ObjectId(row.bookingId) }, { $set },
    { arrayFilters: [{ 'r.refundId': String(row._id) }], ...(s ? { session: s } : {}) });
}

/**
 * In the caller's transaction: the one return of this capture. Returns the booking's refund row (the caller pushes it
 * onto `assisted.funding.refunds`) and whether this call created it (a repeat answers the existing row, nothing moves).
 * The payment record becomes `refunded` (returned to its payer), as the customer paths mark a returned capture.
 */
export async function queueCardRefundIn(p: { bookingId: string; bookingKind?: AssistedBookingKind; payerKind?: BookerKind; payerId: string; record: IPaymentRecord;
  cause: string; to: 'card' | 'wallet' }, s: ClientSession): Promise<{ row: AssistedRefundRow; created: boolean; refund: IAssistedCardRefund }> {
  const bookingKind = p.bookingKind ?? 'booking';
  const rid = lower(p.record._id);
  // The record's own capture is returned once (an extra capture on the same order has its own row, r10e).
  const prior = await AssistedCardRefundModel.findOne({ paymentRecordId: rid, cause: { $ne: 'extra_capture' } }).session(s).lean() as IAssistedCardRefund | null;
  if (prior) return { row: bookingRowOf(prior), created: false, refund: prior };
  const amount = recordPaiseOf(p.record);
  if (!(amount > 0)) throw err(500, 'INVALID_AMOUNT', 'A card refund needs a positive amount');
  const _id = new Types.ObjectId();
  let state: IAssistedCardRefund['state'] = 'pending';
  let lastError: string | undefined;
  let walletEntryId: string | undefined;
  if (p.record.chargebackAt) { state = 'manual_review'; lastError = 'CHARGEBACK_RECORDED'; }
  else if (p.to === 'wallet') {
    const posted = await postBookerMovementIn({ payerKind: p.payerKind ?? 'pharmacy', payerId: lower(p.payerId), kind: 'refund_credit', amountPaise: amount,
      operationKey: `assisted_card:${rid}:refund`, referenceType: walletReferenceOf(bookingKind), referenceId: `${lower(p.bookingId)}:card_refund:${rid}`,
      description: 'Card payment of an assisted booking returned to the wallet' }, s);
    state = 'processed';
    walletEntryId = String(posted.entry._id);
  } else if (!p.record.razorpayPaymentId) { state = 'manual_review'; lastError = 'PAYMENT_ID_MISSING'; }
  const doc = { _id, bookingKind, bookingId: lower(p.bookingId), paymentRecordId: rid, ...(p.record.razorpayPaymentId ? { razorpayPaymentId: p.record.razorpayPaymentId } : {}),
    captureKey: p.record.razorpayPaymentId ? `pay:${p.record.razorpayPaymentId}` : `record:${rid}`,
    amountMinor: amount, cause: p.cause, payerKind: p.payerKind ?? 'pharmacy', payerId: lower(p.payerId), method: p.to === 'wallet' ? 'wallet' as const : 'razorpay' as const,
    state, attempts: 0, submissions: 0, ...(lastError ? { lastError } : {}), ...(walletEntryId ? { walletEntryId } : {}),
    ...(state === 'processed' ? { processedAt: new Date() } : {}) };
  await AssistedCardRefundModel.create([doc], { session: s });
  await PaymentRecordModel.updateOne({ _id: rid }, { $set: { status: 'refunded', isProcessed: true } }, { session: s });
  const refund = await AssistedCardRefundModel.findById(_id).session(s).lean() as IAssistedCardRefund;
  return { row: bookingRowOf(refund), created: true, refund };
}

/**
 * r10e: in the caller's transaction, the return of ANOTHER capture on the same Razorpay order (a slow UPI payment and a
 * second "pay now" can both capture): always to the card, exactly once per Razorpay payment id (unique `captureKey`).
 * The payment record is not touched (it keeps the capture that counts).
 */
export async function queueExtraCaptureRefundIn(p: { bookingId: string; bookingKind?: AssistedBookingKind; payerKind?: BookerKind; payerId: string; recordId: string;
  razorpayPaymentId: string; amountMinor: number }, s: ClientSession): Promise<{ row: AssistedRefundRow; created: boolean; refund: IAssistedCardRefund }> {
  const captureKey = `pay:${p.razorpayPaymentId}`;
  const prior = await AssistedCardRefundModel.findOne({ captureKey }).session(s).lean() as IAssistedCardRefund | null;
  if (prior) return { row: bookingRowOf(prior), created: false, refund: prior };
  if (!(Number.isSafeInteger(p.amountMinor) && p.amountMinor > 0)) throw err(500, 'INVALID_AMOUNT', 'A card refund needs a positive amount');
  const _id = new Types.ObjectId();
  await AssistedCardRefundModel.create([{ _id, bookingKind: p.bookingKind ?? 'booking', bookingId: lower(p.bookingId), paymentRecordId: lower(p.recordId),
    razorpayPaymentId: p.razorpayPaymentId, captureKey,
    amountMinor: p.amountMinor, cause: 'extra_capture', payerKind: p.payerKind ?? 'pharmacy', payerId: lower(p.payerId), method: 'razorpay' as const,
    state: 'pending' as const, attempts: 0, submissions: 0 }], { session: s });
  const refund = await AssistedCardRefundModel.findById(_id).session(s).lean() as IAssistedCardRefund;
  return { row: bookingRowOf(refund), created: true, refund };
}

function bookingRowOf(r: IAssistedCardRefund): AssistedRefundRow {
  return { refundId: String(r._id), cause: r.cause, amountMinor: r.amountMinor, method: r.method, sourceRef: r.paymentRecordId,
    state: r.state === 'processed' ? 'processed' : r.state === 'pending' ? 'pending' : r.state === 'failed' ? 'failed' : 'manual_review',
    ...(r.walletEntryId ? { walletEntryId: r.walletEntryId } : {}), attemptId: String(r._id), at: r.createdAt ?? new Date() };
}

/**
 * 2e / r29: how each payer kind is named on its assisted card payment record, in one table — the record field that names
 * it (what `recordPayerOf` reads and verification by organisation matches), the fields its order writes (a lab also names
 * its booking member; the pharmacy's are byte-identical to 1b), the key of the order's notes, and (r29, DR9) whether a
 * capture of that payer is still taken: a doctor no longer verified and active gets its capture back on the card (C9).
 * Pharmacy and lab payers are never refused at capture (as before).
 */
type RecordPayerField = 'payerPharmacyId' | 'payerPartnerId' | 'payerSpecialistId';
const RECORD_PAYERS: Record<BookerKind, { field: RecordPayerField; note: string; fields(payerId: string, actorId: string): Record<string, string>;
  blockedAtCapture(payerId: string): Promise<boolean> }> = {
  pharmacy: { field: 'payerPharmacyId', note: 'pharmacyId', fields: (id) => ({ payerPharmacyId: id }), blockedAtCapture: async () => false },
  lab: { field: 'payerPartnerId', note: 'partnerId', fields: (id, actor) => ({ payerPartnerId: lower(id), payerMemberId: lower(actor) }), blockedAtCapture: async () => false },
  doctor: { field: 'payerSpecialistId', note: 'specialistId', fields: (id) => ({ payerSpecialistId: lower(id) }),
    blockedAtCapture: async (id) => !(await doctorIsEligible(id)) },
};
/** 2e: who paid an assisted card record — a lab (`payerPartnerId`), r29 a doctor (`payerSpecialistId`), else a pharmacy (`payerPharmacyId`). */
export const recordPayerOf = (r: Pick<IPaymentRecord, RecordPayerField>): { kind: BookerKind; id: string } => {
  const kind = (['lab', 'doctor'] as const).find((k) => !!r[RECORD_PAYERS[k].field]) ?? 'pharmacy';
  return { kind, id: lower(r[RECORD_PAYERS[kind].field]) };
};
/** The payer fields and notes of a card booking's Razorpay order (the paying organisation by its kind, §6.1). */
export const recordPayerFieldsOf = (kind: BookerKind, payerId: string, actorId: string) =>
  ({ fields: RECORD_PAYERS[kind].fields(payerId, actorId), notes: { [RECORD_PAYERS[kind].note]: payerId } });
/** r29 (DR9): a capture paid by this payer is returned to the card instead of applied (only a doctor no longer eligible). */
export const payerBlockedAtCapture = (kind: BookerKind | undefined, payerId: string): Promise<boolean> =>
  (kind && RECORD_PAYERS[kind] ? RECORD_PAYERS[kind].blockedAtCapture(payerId) : Promise.resolve(false));

/** The answer's view of a refund row (booker's own screens and the admin queue). */
export const cardRefundView = (r: IAssistedCardRefund) => ({
  refundId: String(r._id), bookingId: r.bookingId, paymentRecordId: r.paymentRecordId, amountMinor: r.amountMinor, cause: r.cause,
  method: r.method === 'wallet' ? 'wallet' : 'card', state: r.state, lastError: r.lastError ?? null, attempts: r.attempts,
  razorpayRefundId: r.razorpayRefundId ?? null, processedAt: r.processedAt ?? null, createdAt: r.createdAt, updatedAt: r.updatedAt,
  ...(r.resolution ? { resolution: { by: r.resolution.by, at: r.resolution.at } } : {}),
});

/**
 * Phase 1b: the cancellation refund of a card booking (card or wallet, its state) for the booker's own answers; null if
 * none. r14: consultations and lab bookings alike (booking ids are unique across both collections).
 */
export async function cancellationRefundOf(bookingId: string) {
  const row = await AssistedCardRefundModel.findOne({ bookingId: lower(bookingId), cause: { $nin: ['late_capture', 'extra_capture'] } }).sort({ createdAt: -1 }).lean();
  return row ? cardRefundView(row as never) : null;
}

// ───────────────────────────── The worker ─────────────────────────────

const fenceOf = (row: IAssistedCardRefund, attemptId: string) => ({ _id: row._id, state: 'pending', attemptId });
const current = async (id: unknown) => (await AssistedCardRefundModel.findById(id).lean()) as unknown as IAssistedCardRefund | null;

/**
 * Keeps the row pending, records why and frees the lease so a later attempt looks the refund up first. r10b: only a
 * REAL failure counts toward CARD_REFUND_MAX_ATTEMPTS; a refund Razorpay still reports pending is looked up again with
 * back-off for as long as it stays pending (it is never given up on).
 */
async function release(row: IAssistedCardRefund, attemptId: string, reason: string, kind: 'failure' | 'pending', attemptsFloor?: number) {
  const now = Date.now();
  const failures = Number(row.attempts || 0) + 1;
  const checks = Number(row.checks || 0) + 1;
  await AssistedCardRefundModel.updateOne(fenceOf(row, attemptId), {
    $set: { lastError: reason, leaseUntil: new Date(now), nextCheckAt: new Date(now + (kind === 'failure' ? failureDelay(failures) : pendingDelay(checks))) },
    $unset: { attemptId: '' },
    ...(attemptsFloor ? { $max: { attempts: attemptsFloor } } : { $inc: kind === 'failure' ? { attempts: 1 } : { checks: 1 } }) });
  return current(row._id);
}

async function finish(row: IAssistedCardRefund, attemptId: string, state: 'processed' | 'failed' | 'manual_review', extra: Record<string, unknown> = {}) {
  const moved = await AssistedCardRefundModel.updateOne(fenceOf(row, attemptId), { $set: { state, ...extra, ...(state === 'processed' ? { processedAt: new Date() } : {}) },
    $unset: { attemptId: '', leaseUntil: '' } });
  if (moved.modifiedCount === 1) await syncBookingRow(row, { state });
  return current(row._id);
}

async function runAttempt(row: IAssistedCardRefund, attemptId: string): Promise<IAssistedCardRefund | null> {
  const paymentId = String(row.razorpayPaymentId);
  const key = `ab-${String(row._id)}`;
  const ours = (r: GatewayRefund) => r.notes?.swasthadisha_refund_key === key;
  let found: GatewayRefund | undefined;
  try {
    found = row.razorpayRefundId ? await gw().fetchRefund(paymentId, row.razorpayRefundId) : (await gw().listRefunds(paymentId)).find(ours);
  } catch { return release(row, attemptId, 'GATEWAY_LOOKUP_FAILED', 'failure'); }
  if (!found) {
    // A card dispute recorded meanwhile: the bank already took this money back, so nothing is sent.
    const rec = await PaymentRecordModel.findById(row.paymentRecordId).select({ chargebackAt: 1 }).lean() as { chargebackAt?: Date } | null;
    // (A dispute on the record's capture never holds the return of ANOTHER capture on the order, r10e.)
    if (rec?.chargebackAt && row.cause !== 'extra_capture') return finish(row, attemptId, 'manual_review', { lastError: 'CHARGEBACK_RECORDED' });
    // r10f: a dispute recorded on this extra capture itself holds its return the same way.
    if (row.cause === 'extra_capture' && (await current(row._id))?.chargebackAt) return finish(row, attemptId, 'manual_review', { lastError: 'CHARGEBACK_RECORDED' });
    // Every submission is counted BEFORE it is sent (fenced): only a single, clearly refused submission ends as failed.
    const marked = await AssistedCardRefundModel.findOneAndUpdate(fenceOf(row, attemptId), { $inc: { submissions: 1 } }, { new: true }).lean() as IAssistedCardRefund | null;
    if (!marked) return current(row._id);
    try {
      found = await gw().refund(paymentId, { amount: row.amountMinor, receipt: key, notes: { swasthadisha_refund_key: key, booking_id: row.bookingId } });
    } catch (error) {
      let after: GatewayRefund | undefined;
      try { after = (await gw().listRefunds(paymentId)).find(ours); } catch { return release(row, attemptId, 'GATEWAY_OUTCOME_UNKNOWN', 'failure'); }
      if (after) found = after;
      else if (marked.submissions === 1 && (error as { statusCode?: unknown })?.statusCode === 400) return finish(row, attemptId, 'failed', { lastError: 'GATEWAY_REJECTED' });
      else return release(row, attemptId, marked.submissions > 1 ? 'GATEWAY_SUBMISSION_UNRESOLVED' : 'GATEWAY_OUTCOME_UNKNOWN', 'failure');
    }
  }
  if (found.amount !== row.amountMinor || (found.paymentId && found.paymentId !== paymentId)) {
    return release(row, attemptId, 'GATEWAY_REFUND_MISMATCH', 'failure', CARD_REFUND_MAX_ATTEMPTS);
  }
  await AssistedCardRefundModel.updateOne(fenceOf(row, attemptId), { $set: { razorpayRefundId: found.id, razorpayStatus: found.status } });
  if (found.status === 'processed') return finish(row, attemptId, 'processed', { razorpayRefundId: found.id, razorpayStatus: found.status, lastError: null });
  if (found.status === 'failed') return finish(row, attemptId, 'failed', { razorpayRefundId: found.id, razorpayStatus: found.status, lastError: 'GATEWAY_REFUND_FAILED' });
  return release(row, attemptId, 'GATEWAY_REFUND_PENDING', 'pending');
}

const leaseFree = (now: Date) => ({ $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: null }, { leaseUntil: { $lte: now } }] });
const due = (now: Date) => ({ $or: [{ nextCheckAt: { $exists: false } }, { nextCheckAt: null }, { nextCheckAt: { $lte: now } }] });

/** Claims a pending card refund's lease (`force`: an admin action — ignores the back-off and the failure cap). */
async function claim(refundId: string, now: Date, force: boolean): Promise<{ row: IAssistedCardRefund; attemptId: string } | null> {
  const attemptId = randomUUID();
  const row = await AssistedCardRefundModel.findOneAndUpdate({ _id: refundId, method: 'razorpay', state: 'pending',
    ...(force ? {} : { attempts: { $lt: CARD_REFUND_MAX_ATTEMPTS } }), $and: [leaseFree(now), ...(force ? [] : [due(now)])] },
  { $set: { attemptId, leaseUntil: new Date(now.getTime() + LEASE_MS) } }, { new: true }).lean() as IAssistedCardRefund | null;
  return row ? { row, attemptId } : null;
}

/** Claims one pending card refund (lease) and pushes it forward. null when someone else holds it, it is not due or not pending. */
export async function advanceCardRefund(refundId: string, now: Date = new Date(), force = false): Promise<IAssistedCardRefund | null> {
  if (!Types.ObjectId.isValid(refundId)) return null;
  const c = await claim(refundId, now, force);
  if (!c) return null;
  return runAttempt(c.row, c.attemptId);
}

/** After a commit that queued card refunds: try them now (best effort; the scheduled worker retries). */
export async function kickCardRefunds(bookingId: string): Promise<void> {
  try {
    const rows = await AssistedCardRefundModel.find({ bookingId: lower(bookingId), method: 'razorpay', state: 'pending' }).select({ _id: 1 }).lean();
    for (const r of rows) await advanceCardRefund(String(r._id)).catch((e) => logger.warn('assisted card refund deferred', { refundId: String(r._id), error: (e as Error)?.message }));
  } catch (e) { logger.warn('assisted card refund kick failed', { error: (e as Error)?.message }); }
}

/** Scheduled: every pending card refund whose lease is free, oldest first (bounded per run). */
export async function runCardRefundsDue(now: Date = new Date(), limit = 25): Promise<{ advanced: number }> {
  const rows = await AssistedCardRefundModel.find({ method: 'razorpay', state: 'pending', attempts: { $lt: CARD_REFUND_MAX_ATTEMPTS },
    $and: [leaseFree(now), due(now)] }).sort({ nextCheckAt: 1, updatedAt: 1 }).limit(limit).select({ _id: 1 }).lean();
  let advanced = 0;
  for (const r of rows) {
    try { if (await advanceCardRefund(String(r._id), now)) advanced += 1; } catch (e) { logger.warn('assisted card refund failed', { refundId: String(r._id), error: (e as Error)?.message }); }
  }
  return { advanced };
}

// ───────────────────────────── Operator queue and admin actions ─────────────────────────────

/** GET /admin/assisted/card-refunds: failed and manual-review rows, pending rows at the failure cap or older than 24 h. */
export async function cardRefundQueue(q: { state?: string; limit?: number } = {}, now: Date = new Date()) {
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const filter = q.state ? { state: { $eq: q.state } } : { $or: [{ state: { $in: ['failed', 'manual_review'] } },
    { state: 'pending', $or: [{ attempts: { $gte: CARD_REFUND_MAX_ATTEMPTS } }, { createdAt: { $lt: new Date(now.getTime() - 86_400_000) } }] }] };
  const rows = await AssistedCardRefundModel.find(filter).sort({ updatedAt: 1 }).limit(limit).lean() as IAssistedCardRefund[];
  return adminRefundViews(rows);
}

/** r10e: GET /admin/assisted/card-refunds/:id — one row, the same shape as the queue (with the paying pharmacy). */
export async function cardRefundById(refundId: string) {
  const row = Types.ObjectId.isValid(refundId) ? await current(refundId) : null;
  if (!row) throw err(404, 'REFUND_NOT_FOUND', 'Refund not found');
  return (await adminRefundViews([row]))[0];
}

/**
 * r10c (admin only): refund rows with the paying partner (id and name), whose agreement a move to the wallet needs. 2e:
 * `payerKind` / `payerName` for every row (a pharmacy or a lab); pharmacy rows keep `pharmacyId` / `pharmacyName` as before.
 */
async function adminRefundViews(rows: IAssistedCardRefund[]) {
  const nameOf = await payerNames(rows.map((r) => ({ kind: r.payerKind ?? 'pharmacy', id: r.payerId })));
  // r14: `bookingKind` tells a lab booking's row from a consultation's (the admin screen shows "lab booking").
  return rows.map((r) => ({ ...cardRefundView(r), bookingKind: r.bookingKind ?? 'booking', ...payerFields(r.payerKind ?? 'pharmacy', r.payerId, nameOf) }));
}

/** Admin lists: payer names by kind and (lower-case) id. */
async function payerNames(payers: { kind: string; id: string }[]): Promise<Map<string, string | null>> {
  const idsOf = (kind: string) => [...new Set(payers.filter((p) => p.kind === kind && Types.ObjectId.isValid(p.id)).map((p) => lower(p.id)))];
  type Named = { _id: unknown; name?: string };
  const [pharmacies, labs, doctors] = await Promise.all([
    idsOf('pharmacy').length ? PharmacyModel.find({ _id: { $in: idsOf('pharmacy') } }).select({ name: 1 }).lean() as unknown as Promise<Named[]> : [],
    idsOf('lab').length ? PartnerOrgModel.find({ _id: { $in: idsOf('lab') } }).select({ name: 1 }).lean() as unknown as Promise<Named[]> : [],
    // r29: a doctor payer is named as on its bookings ("Dr <name>").
    idsOf('doctor').length ? SpecialistModel.find({ _id: { $in: idsOf('doctor') } }).select({ name: 1 }).lean() as unknown as Promise<Named[]> : [],
  ]);
  return new Map([...pharmacies.map((p) => [`pharmacy:${lower(p._id)}`, p.name ?? null] as const), ...labs.map((p) => [`lab:${lower(p._id)}`, p.name ?? null] as const),
    ...doctors.map((p) => [`doctor:${lower(p._id)}`, doctorBookerName(p.name)] as const)]);
}
const payerFields = (kind: string, id: string | null | undefined, names: Map<string, string | null>) => {
  const payerName = id ? names.get(`${kind}:${lower(id)}`) ?? null : null;
  return { payerKind: kind, payerId: id ?? null, payerName, ...(kind === 'pharmacy' ? { pharmacyId: id ?? null, pharmacyName: payerName } : {}) };
};

/**
 * POST /admin/assisted/card-refunds/:id/to-wallet { agreement } — a card refund that failed (or waits for review for a
 * reason other than a card dispute) is credited to the partner's wallet instead, only with the partner's recorded
 * agreement (design §8.4). Exactly once: the same wallet operation key as the partner's own wallet choice.
 */
export async function cardRefundToWallet(adminId: string, refundId: string, agreement: string) {
  if (!Types.ObjectId.isValid(refundId)) throw err(404, 'REFUND_NOT_FOUND', 'Refund not found');
  // r10b: Razorpay is asked first — a refund of this payment processed or pending there means the money is going back to
  // the card already, so the wallet is never credited as well. (Failed and held rows are never claimed by the worker.)
  const pre = await AssistedCardRefundModel.findById(refundId).lean() as IAssistedCardRefund | null;
  if (pre && !pre.resolution && ['failed', 'manual_review'].includes(pre.state) && pre.razorpayPaymentId) await assertNoLiveGatewayRefund(pre.razorpayPaymentId);
  return inTransaction(async (s) => {
    const row = await AssistedCardRefundModel.findById(refundId).session(s).lean() as IAssistedCardRefund | null;
    if (!row) throw err(404, 'REFUND_NOT_FOUND', 'Refund not found');
    if (row.resolution || (row.state === 'processed' && row.method === 'wallet')) return { refund: cardRefundView(row), replayed: true };
    if (!['failed', 'manual_review'].includes(row.state)) throw err(409, 'REFUND_NOT_FAILED', 'Only a failed card refund (or one held for review) can be moved to the wallet');
    const rec = await PaymentRecordModel.findById(row.paymentRecordId).select({ chargebackAt: 1 }).session(s).lean() as { chargebackAt?: Date } | null;
    if (row.lastError === 'CHARGEBACK_RECORDED' || row.chargebackAt || (rec?.chargebackAt && row.cause !== 'extra_capture')) {
      throw err(409, 'CHARGEBACK_RECORDED', 'A card dispute was recorded on this payment; the bank already took the money back');
    }
    const posted = await postBookerMovementIn({ payerKind: row.payerKind ?? 'pharmacy', payerId: row.payerId, kind: 'refund_credit', amountPaise: row.amountMinor,
      operationKey: row.cause === 'extra_capture' ? `assisted_card:${row.paymentRecordId}:extra:${row.razorpayPaymentId}:refund` : `assisted_card:${row.paymentRecordId}:refund`,
      referenceType: walletReferenceOf(row.bookingKind), referenceId: `${row.bookingId}:card_refund:${row.paymentRecordId}${row.cause === 'extra_capture' ? `:${row.razorpayPaymentId}` : ''}`,
      description: 'Card refund of an assisted booking credited to the wallet' }, s);
    const at = new Date();
    const walletEntryId = String(posted.entry._id);
    const moved = await AssistedCardRefundModel.updateOne({ _id: row._id, state: row.state }, { $set: { state: 'processed', method: 'wallet', processedAt: at,
      walletEntryId, resolution: { by: lower(adminId), agreement, at, walletEntryId } } }, { session: s });
    if (moved.modifiedCount !== 1) throw Object.assign(err(409, 'REFUND_CHANGED', 'The refund changed; reload'), { retryable: true });
    await syncBookingRow(row, { state: 'processed', method: 'wallet', walletEntryId }, s);
    await auditIn({ actorKind: 'admin', actorId: lower(adminId), orgKind: row.payerKind ?? 'pharmacy', orgId: row.payerId, action: 'card_refund.to_wallet', bookingId: row.bookingId,
      detail: { refundId: String(row._id), paymentRecordId: row.paymentRecordId, amountMinor: row.amountMinor, agreement } }, s);
    return { refund: cardRefundView((await AssistedCardRefundModel.findById(row._id).session(s).lean()) as IAssistedCardRefund), replayed: false };
  });
}

/** r10b: every refund Razorpay holds for the payment (any key). 502 when it cannot be asked. */
async function gatewayRefundsOf(paymentId: string): Promise<GatewayRefund[]> {
  try { return await gw().listRefunds(paymentId); }
  catch { throw err(502, 'GATEWAY_LOOKUP_FAILED', 'Razorpay could not be asked about this payment\'s refunds; try again'); }
}
const LIVE = ['processed', 'pending'];
async function assertNoLiveGatewayRefund(paymentId: string): Promise<void> {
  const live = (await gatewayRefundsOf(paymentId)).filter((r) => LIVE.includes(String(r.status)));
  if (live.length) {
    throw Object.assign(err(409, 'REFUND_AT_GATEWAY', 'Razorpay already holds a processed or pending refund of this payment; nothing more may be paid back'),
      { details: { refunds: live.map((r) => ({ id: r.id, status: r.status, amountMinor: r.amount })) } });
  }
}

/**
 * r10b: POST /admin/assisted/card-refunds/:id/recheck — asks Razorpay now about a pending card refund (whatever its
 * back-off or failure count), exactly as the worker does (lookup first; sends it only if Razorpay has none for this
 * row). A row in another state is answered as it is, with what Razorpay holds for the payment.
 */
export async function recheckCardRefund(refundId: string, now: Date = new Date()) {
  if (!Types.ObjectId.isValid(refundId)) throw err(404, 'REFUND_NOT_FOUND', 'Refund not found');
  const row = await current(refundId);
  if (!row) throw err(404, 'REFUND_NOT_FOUND', 'Refund not found');
  if (row.state === 'pending' && row.method === 'razorpay') {
    const c = await claim(refundId, now, true);
    if (!c) throw err(409, 'REFUND_BUSY', 'This refund is being worked on right now; try again in a few minutes');
    await runAttempt(c.row, c.attemptId);
  }
  const after = (await current(refundId))!;
  const gateway = after.razorpayPaymentId ? (await gatewayRefundsOf(after.razorpayPaymentId))
    .map((r) => ({ id: r.id, status: r.status, amountMinor: r.amount, ours: r.notes?.swasthadisha_refund_key === `ab-${String(after._id)}` })) : [];
  return { refund: cardRefundView(after), gateway };
}

/**
 * r10b: POST /admin/assisted/card-refunds/:id/mark-failed { reason } — a pending card refund the worker cannot settle
 * (outcome unknown, failure cap reached) is marked failed only after Razorpay is read: refused (409 REFUND_AT_GATEWAY)
 * while any refund of the payment is processed or pending there. The row is held (lease) meanwhile, so the worker cannot
 * submit in between. Then `to-wallet` may credit the partner (with its agreement).
 */
export async function markCardRefundFailed(adminId: string, refundId: string, reason: string, now: Date = new Date()) {
  if (!Types.ObjectId.isValid(refundId)) throw err(404, 'REFUND_NOT_FOUND', 'Refund not found');
  const row = await current(refundId);
  if (!row) throw err(404, 'REFUND_NOT_FOUND', 'Refund not found');
  if (row.state !== 'pending' || row.method !== 'razorpay') throw err(409, 'REFUND_NOT_PENDING', 'Only a pending card refund can be marked failed');
  const c = await claim(refundId, now, true);
  if (!c) throw err(409, 'REFUND_BUSY', 'This refund is being worked on right now; try again in a few minutes');
  const free = () => AssistedCardRefundModel.updateOne(fenceOf(c.row, c.attemptId), { $set: { leaseUntil: new Date() }, $unset: { attemptId: '' } });
  try {
    await assertNoLiveGatewayRefund(String(c.row.razorpayPaymentId));
  } catch (e) { await free(); throw e; }
  const done = await finish(c.row, c.attemptId, 'failed', { lastError: 'MARKED_FAILED_BY_ADMIN' });
  await auditIn({ actorKind: 'admin', actorId: lower(adminId), orgKind: c.row.payerKind ?? 'pharmacy', orgId: c.row.payerId, action: 'card_refund.marked_failed',
    bookingId: c.row.bookingId, detail: { refundId: String(c.row._id), paymentRecordId: c.row.paymentRecordId, amountMinor: c.row.amountMinor, reason } }, null);
  return { refund: cardRefundView(done!) };
}

/** r10b (stuck money): card refunds still pending after N days (ASSISTED_CARD_REFUND_STUCK_DAYS, default 7). */
export async function cardRefundsStuckPending(now: Date = new Date(), limit = 200) {
  const days = Number(process.env.ASSISTED_CARD_REFUND_STUCK_DAYS);
  const n = Number.isSafeInteger(days) && days > 0 ? days : 7;
  const rows = await AssistedCardRefundModel.find({ method: 'razorpay', state: 'pending', createdAt: { $lt: new Date(now.getTime() - n * 86_400_000) } })
    .sort({ createdAt: 1 }).limit(limit).lean() as IAssistedCardRefund[];
  return adminRefundViews(rows);
}

/** r10b (stuck money): assisted card payments with a card dispute recorded (C4: flagged only, waiting for an admin). */
export async function cardChargebacks(limit = 200) {
  const rows = await PaymentRecordModel.find({ context: { $in: ASSISTED_CARD_CONTEXTS }, chargebackAt: { $exists: true } })
    .select({ context: 1, contextId: 1, payerPharmacyId: 1, payerPartnerId: 1, payerSpecialistId: 1, finalAmount: 1, finalAmountPaise: 1, chargebackAt: 1, status: 1 }).sort({ chargebackAt: -1 }).limit(limit).lean() as unknown as IPaymentRecord[];
  // r10f: disputes recorded on extra captures (their own refund rows) are listed too.
  const extras = await AssistedCardRefundModel.find({ cause: 'extra_capture', chargebackAt: { $exists: true } }).sort({ chargebackAt: -1 }).limit(limit).lean() as IAssistedCardRefund[];
  const names = await payerNames([...rows.map(recordPayerOf), ...extras.map((r) => ({ kind: r.payerKind ?? 'pharmacy', id: r.payerId }))]);
  return [
    ...rows.map((r) => ({ paymentRecordId: String(r._id), bookingId: r.contextId, bookingKind: cardKindOf(r.context),
      ...payerFields(recordPayerOf(r).kind, recordPayerOf(r).id || null, names), amountMinor: recordPaiseOf(r), status: r.status, chargebackAt: r.chargebackAt })),
    ...extras.map((r) => ({ paymentRecordId: r.paymentRecordId, razorpayPaymentId: r.razorpayPaymentId ?? null, extraCapture: true, bookingId: r.bookingId,
      bookingKind: r.bookingKind ?? 'booking',
      ...payerFields(r.payerKind ?? 'pharmacy', r.payerId, names), amountMinor: r.amountMinor, refundState: r.state, chargebackAt: r.chargebackAt })),
  ];
}

/**
 * r10f: a card dispute on an extra capture (C4, owner: flag only — no debit, no freeze, the admin decides recovery):
 * `chargebackAt` on its refund row (once), its return held when not yet sent (`manual_review`), an alert and an audit.
 */
async function recordExtraCaptureChargeback(adminId: string, extra: IAssistedCardRefund, reason: string) {
  return inTransaction(async (s) => {
    const at = new Date();
    const set = await AssistedCardRefundModel.updateOne({ _id: extra._id, chargebackAt: { $exists: false } }, { $set: { chargebackAt: at } }, { session: s });
    const replayed = set.modifiedCount !== 1;
    let refund = await AssistedCardRefundModel.findById(extra._id).session(s).lean() as IAssistedCardRefund;
    if (!replayed && refund.state === 'pending' && refund.submissions === 0 && !refund.attemptId) {
      const held = await AssistedCardRefundModel.updateOne({ _id: extra._id, state: 'pending', submissions: 0 }, { $set: { state: 'manual_review', lastError: 'CHARGEBACK_RECORDED' } }, { session: s });
      if (held.modifiedCount === 1) await syncBookingRow(extra, { state: 'manual_review' }, s);
      refund = await AssistedCardRefundModel.findById(extra._id).session(s).lean() as IAssistedCardRefund;
    }
    const booking = Types.ObjectId.isValid(extra.bookingId)
      ? await bookingModelOf(extra.bookingKind).findById(extra.bookingId).select({ status: 1 }).session(s).lean() as { status?: string } | null : null;
    if (!replayed) {
      await raiseAlertIn({ kind: 'booking_card_chargeback', subject: `pay:${extra.razorpayPaymentId}`, bookerKind: extra.payerKind ?? 'pharmacy', bookerId: extra.payerId,
        detail: { paymentRecordId: extra.paymentRecordId, razorpayPaymentId: extra.razorpayPaymentId, extraCapture: true, bookingId: extra.bookingId,
          amountMinor: extra.amountMinor, refundState: refund.state } }, s);
      await auditIn({ actorKind: 'admin', actorId: lower(adminId), orgKind: extra.payerKind ?? 'pharmacy', orgId: extra.payerId, action: 'booking.card_chargeback', bookingId: extra.bookingId,
        detail: { paymentRecordId: extra.paymentRecordId, razorpayPaymentId: extra.razorpayPaymentId, extraCapture: true, amountMinor: extra.amountMinor, reason,
          refundState: refund.state } }, s);
    }
    return { recorded: true, replayed, paymentRecordId: extra.paymentRecordId, razorpayPaymentId: extra.razorpayPaymentId ?? null, extraCapture: true,
      bookingId: extra.bookingId, bookingStatus: booking?.status ?? null, amountMinor: extra.amountMinor, refund: cardRefundView(refund),
      message: 'Recorded and flagged for admin review; no wallet money was moved' };
  });
}

/** An assisted card payment named by its record id, Razorpay order id or Razorpay payment id (database only). */
async function assistedPaymentRecord(paymentId: string): Promise<IPaymentRecord> {
  const notFound = () => err(404, 'PAYMENT_NOT_FOUND', 'No assisted card payment with that id');
  const id = String(paymentId ?? '').trim();
  const q = /^[0-9a-fA-F]{24}$/.test(id) ? { _id: id } : /^order_/.test(id) ? { razorpayOrderId: { $eq: id } } : /^pay_/.test(id) ? { razorpayPaymentId: { $eq: id } } : null;
  if (!q) throw notFound();
  const rows = await PaymentRecordModel.find({ ...q, context: { $in: ASSISTED_CARD_CONTEXTS } }).limit(2).lean() as unknown as IPaymentRecord[];
  if (rows.length > 1) throw err(409, 'PAYMENT_AMBIGUOUS', 'Several records carry that id; use the record id');
  if (!rows[0]) throw notFound();
  return rows[0];
}

/**
 * POST /admin/assisted-payments/:paymentId/chargeback { reason } — a card dispute lost on an assisted booking payment.
 * A card booking has no wallet lot, so (bare minimum, ASSUMED) the dispute is RECORDED and FLAGGED only: `chargebackAt`
 * on the payment record (once), an alert `booking_card_chargeback` and an audit row. No wallet money moves and the
 * booking is not changed; a card refund of that payment not yet sent is held (`manual_review`), and no later refund of
 * it (card or wallet) is ever made. Recovering the money from the partner is an admin decision (not built).
 */
export async function recordCardChargeback(adminId: string, paymentId: string, reason: string) {
  // r10f: a Razorpay payment id that is an EXTRA capture on a card order (its own refund row) is disputed on that row.
  const extra = /^pay_/.test(String(paymentId ?? '').trim()) && !(await PaymentRecordModel.exists({ context: { $in: ASSISTED_CARD_CONTEXTS },
    razorpayPaymentId: { $eq: String(paymentId).trim() } }))
    ? await AssistedCardRefundModel.findOne({ captureKey: `pay:${String(paymentId).trim()}`, cause: 'extra_capture' }).lean() as IAssistedCardRefund | null : null;
  if (extra) return recordExtraCaptureChargeback(adminId, extra, reason);
  const record = await assistedPaymentRecord(paymentId);
  const rid = lower(record._id);
  // r10b: only a captured payment can be disputed (paid, or returned after its capture); an order never paid has nothing.
  if (!['paid', 'refunded'].includes(String(record.status)) || !record.razorpayPaymentId) {
    throw err(409, 'PAYMENT_NOT_CAPTURED', 'This payment was never captured; there is nothing to dispute');
  }
  return inTransaction(async (s) => {
    const at = new Date();
    const set = await PaymentRecordModel.updateOne({ _id: rid, chargebackAt: { $exists: false } }, { $set: { chargebackAt: at } }, { session: s });
    const replayed = set.modifiedCount !== 1;
    const row = await AssistedCardRefundModel.findOne({ paymentRecordId: rid, cause: { $ne: 'extra_capture' } }).session(s).lean() as IAssistedCardRefund | null;
    let refund = row;
    if (!replayed && row && row.state === 'pending' && row.submissions === 0 && !row.attemptId) {
      const held = await AssistedCardRefundModel.updateOne({ _id: row._id, state: 'pending', submissions: 0 }, { $set: { state: 'manual_review', lastError: 'CHARGEBACK_RECORDED' } }, { session: s });
      if (held.modifiedCount === 1) await syncBookingRow(row, { state: 'manual_review' }, s);
      refund = await AssistedCardRefundModel.findById(row._id).session(s).lean() as IAssistedCardRefund;
    }
    const booking = Types.ObjectId.isValid(record.contextId)
      ? await bookingModelOf(cardKindOf(record.context)).findById(record.contextId).select({ status: 1, paymentStatus: 1 }).session(s).lean() as { status?: string } | null : null;
    if (!replayed) {
      const payer = recordPayerOf(record);
      await raiseAlertIn({ kind: 'booking_card_chargeback', subject: rid, bookerKind: payer.kind, bookerId: payer.id,
        detail: { paymentRecordId: rid, bookingId: lower(record.contextId), amountMinor: recordPaiseOf(record), refundState: refund?.state ?? null } }, s);
      await auditIn({ actorKind: 'admin', actorId: lower(adminId), orgKind: payer.kind, orgId: payer.id, action: 'booking.card_chargeback', bookingId: lower(record.contextId),
        detail: { paymentRecordId: rid, amountMinor: recordPaiseOf(record), reason, refundState: refund?.state ?? null } }, s);
    }
    return { recorded: true, replayed, paymentRecordId: rid, bookingId: lower(record.contextId), bookingStatus: booking?.status ?? null,
      amountMinor: recordPaiseOf(record), refund: refund ? cardRefundView(refund) : null,
      message: 'Recorded and flagged for admin review; no wallet money was moved' };
  });
}
