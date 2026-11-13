import { randomUUID } from 'crypto';
import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { refundAndCloseIn, runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import ExternalBookingModel from '@/modules/externalBookings/model';
import { ExternalProviderOps, IExternalBooking } from '@/modules/externalBookings/types';
import { undoCouponUsageIn } from '@/modules/coupon/usage';
import PaymentRecordModel from '@/modules/payment/model';
import { WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository } from '@/modules/wallet/repository';
import logger from '@/services/logger';

/**
 * External bookings: provider admission and two-phase cancellation (option A, phase A2b; milestone external contract
 * at e8eb9bd, on the walletFunding ledger). All state lives in the private `providerOps` sub-document.
 *
 * Provider OBLIGATIONS. Every provider booking this booking may have is an obligation: the current reference, every
 * other reference a provider call ever returned (a superseded attempt, a reschedule that issued a new id, a result
 * that lost its local write: `lateRefs`), and every provider call whose outcome is not known (an attempt or a
 * reschedule that is in flight, or 'unknown': timeout, error, crash). Money is returned only when NO obligation is
 * open: each reference acknowledged as cancelled by the provider (explicit raw "cancelled") or attested by an admin,
 * and no call unresolved. Elapsed time never proves anything; an expired in-flight call only becomes 'unknown'.
 *
 * Admission. A provider booking is attempted only after `beginProvider` records a durable attempt (token) for a
 * booking that is paid through that payment (or free), has no cancellation intent and no unresolved earlier attempt;
 * only that token may record the result. An attempt is proven unbooked ('rejected') only when the booking call was
 * never made (`providerNotCalled`); any provider error is 'unknown'. Reschedules are admitted the same way.
 *
 * Cancellation. (1) `requestCancellation` records a signed intent (customer/admin, or the server itself) that stops
 * further payment setup, capture application and provider admission. (2) `progressCancellation` cancels each open
 * reference at the provider OUTSIDE any transaction, one claimed call at a time. (3) `settleCancelled` returns the
 * money (ledger), undoes coupon usage and closes the booking in ONE transaction, only with no open obligation. What
 * cannot be proven automatically waits for an admin (`reconcileProviderState`) and leaves the automatic queue.
 */
export const CANCELLATION_REQUESTED = 'cancellation_requested';
const IN_FLIGHT_MS = 10 * 60 * 1000;
const CALL_LEASE_MS = 5 * 60 * 1000;
const WAIT_MS = 2 * 60 * 1000;
/** Automatic provider-cancel calls per cancellation before it waits for an admin. */
const MAX_AUTO_CALLS = 5;

type Booking = IExternalBooking & { _id?: unknown; providerOps?: ExternalProviderOps };
type Actor = { _id: string; userType: string };
type CancelResult = { externalBookingId?: string; externalStatus?: string; payload: unknown };
export type ProviderCanceller = (booking: IExternalBooking, ref: string, reason: string) => Promise<CancelResult>;
export type Progress = { booking: Booking; settled: boolean; refunded: number };

const conflict = (code: string, message: string, status = 409) => new AppError({ status, code, message });
const changed = () => Object.assign(conflict('EXTERNAL_BOOKING_CHANGED', 'External booking changed; please retry'), { retryable: true });
const notFound = () => conflict('EXTERNAL_BOOKING_NOT_FOUND', 'External booking not found', 404);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const firstString = (source: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const v = source[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return undefined;
};

/** The provider's booking reference, from the stored id or (older rows) the stored provider payload. */
export function externalRefOf(b: Pick<IExternalBooking, 'externalBookingId' | 'meta'>): string | undefined {
  if (typeof b.externalBookingId === 'string' && b.externalBookingId.trim()) return b.externalBookingId.trim();
  const root = record(b.meta);
  const payload = record(root.externalPayload);
  const response = record(payload.bookingResponse);
  const source = [record(response.order), record(response.appointment), response, payload, root].find(x => Object.keys(x).length) ?? {};
  return firstString(source, ['orderId', 'appointmentId', 'lsAppointmentId', 'referenceId', 'id']);
}

async function read(id: string, s?: ClientSession, owner?: string): Promise<Booking> {
  if (!Types.ObjectId.isValid(id)) throw notFound();
  const b = await ExternalBookingModel.findOne({ _id: id, ...(owner ? { userId: { $eq: owner } } : {}) })
    .select('+providerOps').session(s ?? null).lean() as Booking | null;
  if (!b) throw notFound();
  return b;
}
const opsOf = (b: Booking): ExternalProviderOps => b.providerOps ?? {};
const isCancelling = (b: Booking) => b.status === 'cancelled' || b.status === CANCELLATION_REQUESTED || !!opsOf(b).cancel;
const fresh = (at: Date | undefined, now: Date) => !!at && now.getTime() - new Date(at).getTime() < IN_FLIGHT_MS;

/** Every provider reference this booking may hold. */
export function providerRefs(b: Booking): string[] {
  return [...new Set([externalRefOf(b), ...(opsOf(b).lateRefs ?? [])].filter((r): r is string => !!r))];
}
/** What still blocks settlement. */
function openObligations(b: Booking, now: Date) {
  const ops = opsOf(b);
  const acked = new Set(ops.cancel?.ackedRefs ?? []);
  const unresolved = (x?: { state: string; at: Date }) => !!x && (x.state === 'unknown' || x.state === 'started');
  return {
    refs: providerRefs(b).filter(r => !acked.has(r)),
    inFlight: [ops.attempt, ops.reschedule].some(x => x?.state === 'started' && fresh(x.at, now)),
    unknown: [ops.attempt, ops.reschedule].some(x => unresolved(x) && !(x!.state === 'started' && fresh(x!.at, now)))
      || (ops.attempt?.state === 'succeeded' && !ops.attempt.ref && !externalRefOf(b))
      || ops.unresolvedPrior === true,
  };
}
const fenceOf = (b: Booking) => ({
  _id: b._id,
  ...(opsOf(b).cancel ? { 'providerOps.cancel.token': opsOf(b).cancel!.token, 'providerOps.cancel.state': opsOf(b).cancel!.state }
    : { 'providerOps.cancel': { $exists: false } }),
  ...(opsOf(b).attempt ? { 'providerOps.attempt.token': opsOf(b).attempt!.token, 'providerOps.attempt.state': opsOf(b).attempt!.state }
    : { 'providerOps.attempt': { $exists: false } }),
  ...(opsOf(b).reschedule ? { 'providerOps.reschedule.token': opsOf(b).reschedule!.token, 'providerOps.reschedule.state': opsOf(b).reschedule!.state }
    : { 'providerOps.reschedule': { $exists: false } }),
});
const UNKNOWN_CALL = 'a provider call has an unknown outcome';
/**
 * A provider result arrived: a cancellation of this booking must act on it now. A settled one is reopened; one parked
 * only because a call's outcome was unknown (or waiting for it) is made due again. Independent admin requirements
 * (e.g. the exhausted provider-cancel budget) are kept.
 */
function wake(b: Booking): Record<string, unknown> {
  const c = opsOf(b).cancel;
  if (!c) return {};
  const resumable = c.state === 'settled' || (c.state === 'requested' && !c.needsAdmin) || (c.needsAdmin && c.blockedBy === UNKNOWN_CALL);
  return resumable ? { 'providerOps.cancel.state': 'requested', 'providerOps.cancel.token': randomUUID(), 'providerOps.cancel.nextAt': new Date(),
    'providerOps.cancel.needsAdmin': false, 'providerOps.cancel.blockedBy': null } : {};
}
/**
 * A late provider change (a reschedule result) may have altered these references after any acknowledgement we hold:
 * their acknowledgements no longer count, and a cancellation call still running loses its token (its outcome can no
 * longer be written). The cancellation must cancel them again.
 */
function invalidate(b: Booking, refs: (string | undefined)[]): Record<string, unknown> {
  const c = opsOf(b).cancel;
  if (!c) return {};
  const stale = refs.filter((r): r is string => !!r);
  return {
    $pull: { 'providerOps.cancel.ackedRefs': { $in: stale } },
    $set: { 'providerOps.cancel.state': c.needsAdmin && c.blockedBy !== UNKNOWN_CALL ? 'unknown' : 'requested', 'providerOps.cancel.token': randomUUID(),
      'providerOps.cancel.nextAt': new Date(), ...(c.needsAdmin && c.blockedBy !== UNKNOWN_CALL ? {} : { 'providerOps.cancel.needsAdmin': false,
        'providerOps.cancel.blockedBy': null }) },
  };
}
/** Keeps a provider reference as an obligation (and wakes the cancellation, if any). */
function keepRef(b: Booking, ref: string) {
  return {
    $addToSet: { 'providerOps.lateRefs': ref },
    $set: { 'meta.providerEventReconciliationRequired': true, ...wake(b) },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Provider admission (booking) and its result
// ---------------------------------------------------------------------------------------------------------------

export type Admission = { token: string; booking: Booking }
  | { token: null; booking: Booking; reason: 'cancelling' | 'not_paid_by_this' | 'fulfilled' | 'in_flight' | 'unresolved' };

/**
 * Admits one provider booking attempt. `recordId` is the payment it is fulfilled for (the booking must be paid
 * through exactly that record); null admits a free booking (price 0, no payment link). A new attempt is admitted
 * only when no earlier attempt could have booked (none, or proven unbooked): an unknown or expired one needs an admin.
 */
export async function beginProvider(bookingId: string, recordId: string | null, now = new Date()): Promise<Admission> {
  return runLedgerTransaction(async s => {
    const b = await read(bookingId, s);
    if (isCancelling(b)) return { token: null, booking: b, reason: 'cancelling' };
    if (externalRefOf(b) || opsOf(b).attempt?.state === 'succeeded') return { token: null, booking: b, reason: 'fulfilled' };
    // A provider booking is already known (a late result of an earlier attempt): never make another one.
    if (providerRefs(b).length || opsOf(b).unresolvedPrior) return { token: null, booking: b, reason: 'unresolved' };
    const paidByThis = recordId !== null && b.paymentStatus === 'paid' && String(b.paymentTransactionId) === String(recordId);
    const free = recordId === null && !(Number(b.price || 0) > 0) && !b.paymentTransactionId;
    if (!paidByThis && !free) return { token: null, booking: b, reason: 'not_paid_by_this' };
    const a = opsOf(b).attempt;
    if (a?.state === 'started') return { token: null, booking: b, reason: fresh(a.at, now) ? 'in_flight' : 'unresolved' };
    if (a?.state === 'unknown') return { token: null, booking: b, reason: 'unresolved' };
    const token = randomUUID();
    const r = await ExternalBookingModel.updateOne({ ...fenceOf(b), status: b.status, paymentStatus: b.paymentStatus,
      ...(b.paymentTransactionId ? { paymentTransactionId: b.paymentTransactionId } : {}) },
    { $set: { 'providerOps.attempt': { token, state: 'started', recordId, at: now } },
      // Every admitted token stays known: a late answer of a superseded attempt must still count.
      ...(a ? { $addToSet: { 'providerOps.priorTokens': a.token } } : {}) }, { session: s });
    if (r.modifiedCount !== 1) throw changed();
    return { token, booking: b };
  });
}

const RESULT_FIELDS = ['externalProviderId', 'externalBookingId', 'externalSlotRef', 'meetingLink', 'status', 'meta'] as const;

/**
 * Records the provider's result for exactly the admitted attempt. Without a cancellation intent the allowed fields
 * are written and the attempt succeeds. With one (recorded while the call ran) only the reference is kept, as an
 * obligation: the booking is never re-activated. A result for any other attempt changes nothing but its reference
 * is kept as an obligation too.
 */
export async function recordProviderResult(bookingId: string, token: string, patch: Record<string, unknown>):
Promise<{ booking: Booking; applied: boolean; cancelPending: boolean; missingRef: boolean }> {
  const ref = typeof patch.externalBookingId === 'string' && patch.externalBookingId.trim() ? patch.externalBookingId.trim() : undefined;
  return runLedgerTransaction(async s => {
    const b = await read(bookingId, s);
    const a = opsOf(b).attempt;
    // Our attempt: still running, expired to unknown, or attested absent by an admin who was wrong (its result wins).
    const ours = !!a && a.token === token && ['started', 'unknown', 'absent_attested'].includes(a.state);
    const done = async (applied: boolean) => ({ booking: await read(bookingId, s), applied, cancelPending: isCancelling(b), missingRef: ours && !ref });
    const prior = !ours && (opsOf(b).priorTokens ?? []).includes(token);
    if (!ours && !prior) {
      logger.error('[ExternalBooking][provider] result for a token never admitted ignored', { bookingId });
      return done(false);
    }
    if (prior && !ref) {
      // A superseded attempt answered without a usable reference: its booking may exist. Blocks until reconciled.
      await ExternalBookingModel.updateOne({ _id: b._id }, { $set: { 'providerOps.unresolvedPrior': true,
        'meta.providerReconciliationRequired': true, ...wake(b) } }, { session: s });
      return { booking: await read(bookingId, s), applied: false, cancelPending: isCancelling(b), missingRef: true };
    }
    if (ours && !ref) {
      // A success without a usable provider reference proves nothing: the booking may exist. Unknown until reconciled.
      await ExternalBookingModel.updateOne({ _id: b._id, 'providerOps.attempt.token': token },
        { $set: { 'providerOps.attempt.state': 'unknown', 'providerOps.attempt.error': 'provider answered without a booking reference',
          'meta.providerReconciliationRequired': true, ...wake(b) } }, { session: s });
      return done(false);
    }
    if (!ref) return done(false);
    if (prior) {
      const keep = keepRef(b, ref);
      await ExternalBookingModel.updateOne({ _id: b._id }, keep, { session: s });
      logger.error('[ExternalBooking][provider] result for another attempt kept as an obligation', { bookingId, ref });
      return done(false);
    }
    const succeeded = { 'providerOps.attempt.state': 'succeeded', 'providerOps.attempt.ref': ref };
    if (isCancelling(b) || externalRefOf(b)) {
      // Cancelling (or, defensively, a reference already present): the booking is never re-activated; the provider
      // booking is an obligation the cancellation now acts on.
      const update = externalRefOf(b)
        ? { $addToSet: { 'providerOps.lateRefs': ref }, $set: { ...succeeded, ...wake(b), 'meta.providerEventReconciliationRequired': true } }
        : { $set: { ...succeeded, ...wake(b), externalBookingId: ref } };
      await ExternalBookingModel.updateOne({ _id: b._id, 'providerOps.attempt.token': token }, update, { session: s });
      return done(false);
    }
    const set: Record<string, unknown> = {};
    for (const k of RESULT_FIELDS) if (patch[k] !== undefined) set[k] = patch[k];
    const r = await ExternalBookingModel.updateOne({ ...fenceOf(b), status: b.status }, { $set: { ...set, ...succeeded } }, { session: s });
    if (r.modifiedCount !== 1) throw changed();
    return done(true);
  });
}

/**
 * Proof that a failed call made no provider change: the call itself was never made (a local step before it failed,
 * tagged `providerNotCalled`). Any provider error, including an HTTP 4xx, is ambiguous and stays unknown.
 */
export function providerNotCalled(error: unknown): boolean {
  return (error as { providerNotCalled?: unknown } | undefined)?.providerNotCalled === true;
}

/** Records the admitted attempt's failure: 'rejected' only when the booking call was never made, else 'unknown'. */
export async function failProvider(bookingId: string, token: string, error: unknown): Promise<'rejected' | 'unknown' | 'stale'> {
  const state = providerNotCalled(error) ? 'rejected' : 'unknown';
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const r = await ExternalBookingModel.updateOne({ _id: bookingId, 'providerOps.attempt.token': token, 'providerOps.attempt.state': 'started' },
    { $set: { 'providerOps.attempt.state': state, 'providerOps.attempt.error': message } });
  return r.modifiedCount === 1 ? state : 'stale';
}

// ---------------------------------------------------------------------------------------------------------------
// Reschedule admission and its result
// ---------------------------------------------------------------------------------------------------------------

/**
 * Admits a provider reschedule of the reference the caller read. Refused while cancelling, if the reference changed,
 * or while an earlier reschedule is in flight or unresolved. Its outcome blocks settlement until it is recorded.
 */
export async function beginReschedule(bookingId: string, expectedRef: string, now = new Date()): Promise<string> {
  return runLedgerTransaction(async s => {
    const b = await read(bookingId, s);
    const rs = opsOf(b).reschedule;
    if (isCancelling(b) || externalRefOf(b) !== expectedRef || (rs && (rs.state === 'started' || rs.state === 'unknown'))) {
      throw conflict('EXTERNAL_BOOKING_CHANGED', 'This booking was cancelled or changed; reload and try again');
    }
    const token = randomUUID();
    const r = await ExternalBookingModel.updateOne({ ...fenceOf(b), status: b.status, externalBookingId: b.externalBookingId ?? null },
      { $set: { 'providerOps.reschedule': { token, state: 'started', at: now, fromRef: expectedRef } } }, { session: s });
    if (r.modifiedCount !== 1) throw changed();
    return token;
  });
}

/**
 * Records the reschedule's result. The new provider reference (if the provider issued one) is always kept: applied as
 * the booking's reference when nothing changed meanwhile, otherwise kept as an obligation. Returns the booking when
 * the patch was applied, null when it was not (cancelling or changed).
 */
export async function recordRescheduleResult(bookingId: string, token: string, newRef: string | undefined, patch: Record<string, unknown>):
Promise<Booking | null> {
  return runLedgerTransaction(async s => {
    const b = await read(bookingId, s);
    const rs = opsOf(b).reschedule;
    const ours = !!rs && rs.token === token && ['started', 'unknown', 'attested'].includes(rs.state);
    const current = externalRefOf(b);
    if (!ours || isCancelling(b) || current !== rs?.fromRef) {
      const set: Record<string, unknown> = ours ? { 'providerOps.reschedule.state': 'done', 'providerOps.reschedule.newRef': newRef ?? null } : {};
      // The provider changed the booking (possibly after our cancellation proof): proofs for the references it touched
      // no longer count, and any new reference is an obligation. The cancellation then acts again.
      const inv = invalidate(b, [rs?.fromRef, current, newRef]);
      const update: Record<string, unknown> = {
        $set: { ...set, ...wake(b), ...((inv.$set as object) ?? {}),
          ...(newRef && newRef !== current ? { 'meta.providerEventReconciliationRequired': true } : {}) },
        ...(inv.$pull ? { $pull: inv.$pull } : {}),
        ...(newRef && newRef !== current ? { $addToSet: { 'providerOps.lateRefs': newRef } } : {}),
      };
      await ExternalBookingModel.updateOne({ _id: b._id }, update, { session: s });
      return null;
    }
    const r = await ExternalBookingModel.updateOne({ ...fenceOf(b), status: b.status },
      { $set: { ...patch, ...(newRef ? { externalBookingId: newRef } : {}), 'providerOps.reschedule.state': 'done',
        'providerOps.reschedule.newRef': newRef ?? null } }, { session: s });
    if (r.modifiedCount !== 1) throw changed();
    return read(bookingId, s);
  });
}

/** Records a failed reschedule: nothing changed only if the call was never made; otherwise its outcome is unknown. */
export async function failReschedule(bookingId: string, token: string, error: unknown): Promise<void> {
  await ExternalBookingModel.updateOne({ _id: bookingId, 'providerOps.reschedule.token': token, 'providerOps.reschedule.state': 'started' },
    { $set: { 'providerOps.reschedule.state': providerNotCalled(error) ? 'done' : 'unknown',
      'providerOps.reschedule.error': (error instanceof Error ? error.message : String(error)).slice(0, 500) } });
}

// ---------------------------------------------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------------------------------------------

type PaymentRow = { _id: unknown; userId?: unknown; status?: string; finalAmount?: unknown; notes?: { walletDeductedAmount?: unknown } };

/** Serializes with payment capture: every not-yet-settled payment record of the booking is written first. */
async function fencedRecords(id: string, s: ClientSession): Promise<PaymentRow[]> {
  await PaymentRecordModel.collection.updateMany({ context: 'external_booking', contextId: id, status: { $nin: ['paid', 'refunded'] } },
    { $set: { updatedAt: new Date() } }, { session: s });
  return await PaymentRecordModel.find({ context: 'external_booking', contextId: id }).session(s).lean() as unknown as PaymentRow[];
}

/**
 * Records a cancellation intent. Customers and admins cancel their own/any booking; `system` is the server's own
 * timeout and failure handling. `enforceWindow` applies only when the booking holds captured money (an unpaid one is
 * exempt, milestone B2); the decision is serialized with capture by the record fence. Idempotent.
 */
export async function requestCancellation(p: { bookingId: string; actor: Actor | 'system'; reason: string;
  enforceWindow?: (b: IExternalBooking) => void; now?: Date }): Promise<Booking> {
  const id = String(p.bookingId).toLowerCase();
  return runLedgerTransaction(async s => {
    const actor = p.actor === 'system' ? null : p.actor;
    if (actor && (!actor._id || !['user', 'admin'].includes(actor.userType))) throw conflict('FORBIDDEN', 'Customer or admin access is required', 403);
    const b = await read(id, s, actor && actor.userType !== 'admin' ? actor._id : undefined);
    if (opsOf(b).cancel || b.status === 'cancelled') return b;
    const records = await fencedRecords(id, s);
    const captured = b.paymentStatus === 'paid' || records.some(r => r.status === 'paid') ||
      (b.walletFunding?.captures ?? []).some(c => c.state === 'applied');
    if (captured && p.enforceWindow) p.enforceWindow(b);
    const now = p.now ?? new Date();
    const r = await ExternalBookingModel.updateOne({ ...fenceOf(b), status: b.status },
      { $set: { status: CANCELLATION_REQUESTED, 'meta.cancellationReason': p.reason, 'meta.cancelRequestedAt': now.toISOString(),
        'providerOps.cancel': { by: actor ? actor.userType : 'system', actorId: actor?._id, reason: p.reason, priorStatus: b.status,
          at: now, state: 'requested', token: randomUUID(), ackedRefs: [], calls: 0 } } }, { session: s });
    if (r.modifiedCount !== 1) throw changed();
    return read(id, s);
  });
}

/**
 * The milestone's acknowledgement rule (e8eb9bd): only an explicit cancelled status in the genuine raw provider
 * response, with no declared failure, and every id it carries equal to the reference we asked to cancel.
 */
export function providerCancellationAcknowledged(integration: string | undefined, expectedId: string, result: CancelResult): boolean {
  const raw = record(result.payload); const data = record(raw.data);
  const healthians = integration === 'healthians';
  const records = healthians ? [raw, data] : [raw, data, record(raw.appointment), record(raw.order), record(data.appointment), record(data.order)];
  const statuses = healthians ? ['status', 'booking_status'] : ['status', 'appointmentStatus', 'orderStatus'];
  const ids = healthians ? ['booking_id', 'bookingId', 'id'] : ['appointmentId', 'lsAppointmentId', 'orderId', 'referenceId', 'id'];
  const cancelled = (v: unknown) => typeof v === 'string' && ['cancelled', 'canceled'].includes(v.trim().toLowerCase());
  if (!cancelled(result.externalStatus) || (result.externalBookingId !== undefined && result.externalBookingId !== expectedId)) return false;
  if ([raw, data].some(item => item.success === false || item.status === false || item.status === 0 ||
      (typeof item.status === 'string' && ['false', '0', 'failed', 'failure', 'error', 'rejected'].includes(item.status.toLowerCase())) ||
      (healthians && item.resCode !== undefined && item.resCode !== 'RES0001'))) return false;
  for (const item of records) for (const key of ids) {
    if (item[key] !== undefined && ((typeof item[key] !== 'string' && typeof item[key] !== 'number') || String(item[key]) !== expectedId)) return false;
  }
  return records.some(item => statuses.some(key => cancelled(item[key])));
}

/** Parks the cancellation: `admin` = needs an admin (leaves the automatic queue); otherwise retried at `nextAt`. */
async function park(b: Booking, why: { admin: boolean; nextAt?: Date; reason: string }) {
  await ExternalBookingModel.updateOne({ _id: b._id, 'providerOps.cancel.token': opsOf(b).cancel!.token },
    { $set: { 'providerOps.cancel.state': why.admin ? 'unknown' : opsOf(b).cancel!.state === 'calling' ? 'requested' : opsOf(b).cancel!.state,
      'providerOps.cancel.needsAdmin': why.admin, 'providerOps.cancel.blockedBy': why.reason,
      ...(why.nextAt ? { 'providerOps.cancel.nextAt': why.nextAt } : {}),
      ...(why.admin ? { 'meta.providerCancelReconciliationRequired': true } : {}) } });
}

/**
 * Drives a recorded cancellation as far as the provider state allows and settles it once no obligation is open.
 * Provider calls are made outside every transaction under a claimed call token; `cancelAtProvider` may be omitted by
 * callers that cannot call the provider (the sweep continues those).
 */
export async function progressCancellation(p: { bookingId: string; wallets: WalletRepository; cancelAtProvider?: ProviderCanceller; now?: Date }):
Promise<Progress> {
  const id = String(p.bookingId).toLowerCase();
  const now = p.now ?? new Date();
  for (let round = 0; round < 8; round++) {
    const b = await read(id);
    const c = opsOf(b).cancel;
    if (!c) return { booking: b, settled: b.status === 'cancelled', refunded: 0 };
    // An expired in-flight call (crashed process) becomes 'unknown': it never proves anything by itself.
    for (const key of ['attempt', 'reschedule'] as const) {
      const x = opsOf(b)[key];
      if (x?.state === 'started' && !fresh(x.at, now)) {
        await ExternalBookingModel.updateOne({ _id: b._id, [`providerOps.${key}.token`]: x.token, [`providerOps.${key}.state`]: 'started' },
          { $set: { [`providerOps.${key}.state`]: 'unknown', [`providerOps.${key}.error`]: 'no result within the in-flight window' } });
      }
    }
    const o = openObligations(await read(id), now);
    if (c.state === 'settled') {
      if (!o.refs.length && !o.inFlight && !o.unknown) return recoverSettled(id, p.wallets);
      await ExternalBookingModel.updateOne({ _id: b._id, 'providerOps.cancel.token': c.token, 'providerOps.cancel.state': 'settled' },
        { $set: { 'providerOps.cancel.state': 'requested', 'providerOps.cancel.token': randomUUID() } });
      continue;
    }
    if (o.inFlight) {
      await park(b, { admin: false, nextAt: new Date(now.getTime() + WAIT_MS), reason: 'provider call in flight' });
      return { booking: await read(id), settled: false, refunded: 0 };
    }
    if (o.unknown) {
      // No provider cancellation while a provider change has an unknown outcome: its late effect could postdate the
      // acknowledgement. An admin resolves it, or its real result wakes this cancellation.
      await park(b, { admin: true, reason: UNKNOWN_CALL });
      return { booking: await read(id), settled: false, refunded: 0 };
    }
    if (o.refs.length) {
      if (c.state === 'calling' && c.callAt && now.getTime() - new Date(c.callAt).getTime() < CALL_LEASE_MS) {
        return { booking: b, settled: false, refunded: 0 };
      }
      if ((c.calls ?? 0) >= MAX_AUTO_CALLS) {
        await park(b, { admin: true, reason: 'provider did not acknowledge the cancellation' });
        return { booking: await read(id), settled: false, refunded: 0 };
      }
      if (!p.cancelAtProvider) return { booking: b, settled: false, refunded: 0 };
      const ref = o.refs[0];
      const callToken = randomUUID();
      const claimed = await ExternalBookingModel.updateOne({ _id: b._id, 'providerOps.cancel.token': c.token, 'providerOps.cancel.state': c.state },
        { $set: { 'providerOps.cancel.state': 'calling', 'providerOps.cancel.token': callToken, 'providerOps.cancel.callAt': now,
          'providerOps.cancel.callRef': ref }, $inc: { 'providerOps.cancel.calls': 1 } });
      if (claimed.modifiedCount !== 1) continue;
      let ack = false; let response: unknown; let error: string | undefined;
      try {
        const result = await p.cancelAtProvider(b, ref, c.reason || 'Cancelled');
        response = result.payload;
        ack = providerCancellationAcknowledged(b.integration, ref, result);
      } catch (e) {
        error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      }
      // Only this call's token writes its outcome, and an acknowledgement covers only the reference it cancelled.
      const backoff = new Date(now.getTime() + CALL_LEASE_MS * Math.max(1, (c.calls ?? 0) + 1));
      await ExternalBookingModel.updateOne({ _id: b._id, 'providerOps.cancel.token': callToken, 'providerOps.cancel.state': 'calling' },
        { $set: { 'providerOps.cancel.state': 'requested', 'providerOps.cancel.token': randomUUID(), 'providerOps.cancel.response': response ?? null,
          ...(error ? { 'providerOps.cancel.error': error } : {}), ...(ack ? {} : { 'providerOps.cancel.nextAt': backoff }) },
        ...(ack ? { $addToSet: { 'providerOps.cancel.ackedRefs': ref } } : {}) });
      if (!ack) return { booking: await read(id), settled: false, refunded: 0 };
      continue;
    }
    return settleCancelled(id, p.wallets, now);
  }
  return { booking: await read(id), settled: false, refunded: 0 };
}

/**
 * Settles a cancellation with no open obligation in ONE transaction: coupon usage undone, everything the booking holds
 * returned to the wallet through the ledger (every captured attempt of its owner), exactly those records marked
 * refunded, the booking cancelled. Anything open: nothing happens.
 */
export async function settleCancelled(bookingId: string, wallets: WalletRepository, now = new Date()): Promise<Progress> {
  const id = String(bookingId).toLowerCase();
  return runLedgerTransaction(async s => {
    const b = await read(id, s);
    const c = opsOf(b).cancel;
    if (!c) return { booking: b, settled: b.status === 'cancelled', refunded: 0 };
    if (c.state === 'settled') return { booking: b, settled: true, refunded: 0 };
    const o = openObligations(b, now);
    if (o.refs.length || o.inFlight || o.unknown || c.state === 'calling') return { booking: b, settled: false, refunded: 0 };
    const records = await fencedRecords(id, s);
    await undoCouponUsageIn(records.map(r => String(r._id)), s);
    const refunded = await returnMoney(b, id, records, wallets, s);
    const done = await ExternalBookingModel.updateOne({ ...fenceOf(b) },
      { $set: { status: 'cancelled', paymentStatus: refunded > 0 || ['paid', 'refunded'].includes(String(b.paymentStatus)) ? 'refunded' : 'cancelled',
        'providerOps.cancel.state': 'settled', 'providerOps.cancel.needsAdmin': false, 'meta.cancelledAt': new Date().toISOString() } }, { session: s });
    if (done.modifiedCount !== 1) throw changed();
    return { booking: await read(id, s), settled: true, refunded };
  });
}

/**
 * Repeating a settled cancellation (no open obligation): a payment captured afterwards whose processing was
 * interrupted (the closed ledger does not know it) is returned once, and a late coupon count is undone once.
 */
async function recoverSettled(id: string, wallets: WalletRepository): Promise<Progress> {
  return runLedgerTransaction(async s => {
    const b = await read(id, s);
    if (opsOf(b).cancel?.state !== 'settled' || !b.walletFunding?.closed) return { booking: b, settled: true, refunded: 0 };
    const records = await fencedRecords(id, s);
    await undoCouponUsageIn(records.map(r => String(r._id)), s);
    const refunded = await returnMoney(b, id, records, wallets, s, false);
    return { booking: await read(id, s), settled: true, refunded };
  });
}

/** Everything the booking holds back to the wallet (ledger), marking refunded exactly the records now returned. */
async function returnMoney(b: Booking, id: string, records: PaymentRow[], wallets: WalletRepository, s: ClientSession, countPrior = true): Promise<number> {
  const owned = records.filter(r => String(r.userId) === String(b.userId));
  const paid = owned.filter(r => r.status === 'paid');
  const linked = b.paymentTransactionId ? owned.find(r => String(r._id) === String(b.paymentTransactionId)) : undefined;
  // Refunds from before the ledger: an operation-key-less refund, or the old timeout refund reference.
  const prior = await WalletTransactionModel.findOne({ $or: [
    { userId: b.userId, transactionType: 'refund', referenceType: 'external_booking', referenceId: id, status: 'completed', operationKey: { $exists: false } },
    { referenceType: 'external_booking_timeout_refund', referenceId: id },
  ] }).session(s).lean();
  let legacyFunded = Number(linked?.notes?.walletDeductedAmount || 0);
  if (!linked) {
    const debits = await WalletTransactionModel.find({ referenceType: 'external_booking', referenceId: id, transactionType: 'debit',
      status: 'completed', operationKey: { $exists: false } }).session(s).lean();
    legacyFunded = debits.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
  }
  let refunded = await refundAndCloseIn({ model: ExternalBookingModel, kind: 'external_booking', bookingId: id, userId: String(b.userId),
    legacyFunded, legacyGateway: linked?.status === 'paid' ? Number(linked.finalAmount || 0) : 0,
    legacyGatewayRecordId: linked ? String(linked._id) : undefined,
    paidRecords: paid.map(r => ({ recordId: String(r._id), amount: Number(r.finalAmount || 0) })), priorRefund: !!prior, wallets }, s);
  if (prior && countPrior) refunded += Number(prior.amount || 0);
  const ledger = await ExternalBookingModel.findById(id).select({ walletFunding: 1 }).session(s).lean() as IExternalBooking | null;
  const returned = new Set((ledger?.walletFunding?.captures ?? []).filter(c => c.state === 'returned').map(c => String(c.recordId).toLowerCase()));
  const settled = paid.filter(r => !(Number(r.finalAmount || 0) > 0) || returned.has(String(r._id).toLowerCase())).map(r => r._id);
  if (settled.length) await PaymentRecordModel.updateMany({ _id: { $in: settled }, status: 'paid' }, { $set: { status: 'refunded' } }, { session: s });
  return refunded;
}

/**
 * Admin reconciliation of what could not be proven automatically, after checking with the provider:
 * - 'absent': no provider booking exists for this booking at all (it references none). Unresolved attempts become
 *   proven unbooked; a paid booking without a cancellation may then be fulfilled again.
 * - 'cancelled': every provider booking of this booking is cancelled (requires a cancellation). All its references
 *   count as acknowledged and unresolved calls as resolved.
 * Recorded with the admin's id; a call still in flight (within its window) is refused. Then the cancellation (if
 * any) continues.
 */
export async function reconcileProviderState(p: { bookingId: string; admin: Actor; providerOutcome: 'absent' | 'cancelled'; wallets: WalletRepository; now?: Date }):
Promise<Progress> {
  if (p.admin?.userType !== 'admin' || !p.admin._id) throw conflict('FORBIDDEN', 'Admin access is required', 403);
  const id = String(p.bookingId).toLowerCase();
  const now = p.now ?? new Date();
  await runLedgerTransaction(async s => {
    const b = await read(id, s);
    const ops = opsOf(b);
    if ([ops.attempt, ops.reschedule].some(x => x?.state === 'started' && fresh(x.at, now))) {
      throw conflict('EXTERNAL_PROVIDER_IN_FLIGHT', 'A provider call is still running; try again later');
    }
    if (ops.cancel?.state === 'calling' && ops.cancel.callAt && now.getTime() - new Date(ops.cancel.callAt).getTime() < CALL_LEASE_MS) {
      throw conflict('EXTERNAL_PROVIDER_IN_FLIGHT', 'A provider cancellation call is still running; try again later');
    }
    const refs = providerRefs(b);
    const set: Record<string, unknown> = {};
    const resolve = (key: 'attempt' | 'reschedule', state: string) => {
      const x = ops[key];
      if (x && (x.state === 'unknown' || x.state === 'started')) { set[`providerOps.${key}.state`] = state; set[`providerOps.${key}.attestedBy`] = p.admin._id; }
    };
    if (p.providerOutcome === 'absent') {
      if (refs.length) throw conflict('EXTERNAL_PROVIDER_REFERENCE_EXISTS', 'Provider bookings are referenced; attest their cancellation instead');
      resolve('attempt', 'absent_attested');
      if (!Object.keys(set).length && !ops.cancel && !ops.unresolvedPrior) throw conflict('EXTERNAL_NOTHING_TO_RECONCILE', 'Nothing to reconcile');
    } else {
      if (!ops.cancel) throw conflict('EXTERNAL_CANCELLATION_NOT_REQUESTED', 'Request the cancellation first');
      resolve('attempt', 'absent_attested');
      resolve('reschedule', 'attested');
      if (refs.length) set['providerOps.cancel.ackedRefs'] = [...new Set([...(ops.cancel.ackedRefs ?? []), ...refs])];
    }
    if (ops.cancel && ops.cancel.state !== 'settled') {
      Object.assign(set, { 'providerOps.cancel.state': 'requested', 'providerOps.cancel.token': randomUUID(), 'providerOps.cancel.needsAdmin': false,
        'providerOps.cancel.attestedBy': p.admin._id, 'providerOps.cancel.nextAt': now });
    }
    if (ops.unresolvedPrior) set['providerOps.unresolvedPrior'] = false;
    set['meta.providerCancelReconciliationRequired'] = false;
    const r = await ExternalBookingModel.updateOne(fenceOf(b), { $set: set }, { session: s });
    if (r.modifiedCount !== 1) throw changed();
  });
  return progressCancellation({ bookingId: id, wallets: p.wallets, now });
}

/** Cancellations the sweep can advance now: not settled, not waiting for an admin, due. Oldest due first. */
export async function findPendingCancellations(now: Date, limit = 100): Promise<string[]> {
  const rows = await ExternalBookingModel.find({ 'providerOps.cancel.state': { $in: ['requested', 'calling'] },
    'providerOps.cancel.needsAdmin': { $ne: true },
    $or: [{ 'providerOps.cancel.nextAt': { $exists: false } }, { 'providerOps.cancel.nextAt': { $lte: now } }],
    'providerOps.cancel.at': { $lt: new Date(now.getTime() - WAIT_MS) } })
    .select({ _id: 1 }).sort({ 'providerOps.cancel.nextAt': 1, 'providerOps.cancel.at': 1 }).limit(limit).lean();
  return rows.map(r => String(r._id));
}

/** Booking without the private providerOps sub-document (public results). */
export function publicExternalBooking<T extends { providerOps?: unknown }>(b: T): Omit<T, 'providerOps'> {
  const { providerOps: _private, ...visible } = b;
  return visible;
}
