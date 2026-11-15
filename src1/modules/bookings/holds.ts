import { claimRequestKey, scopeOf } from '@/modules/requestKeys';
import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { refundAndCloseIn, runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { parseAppointment } from '@/modules/common/utils/cancellationWindow';
import BookingModel from '@/modules/bookings/model';
import { IBooking } from '@/modules/bookings/types';
import SlotModel from '@/modules/slots/model';
import { undoCouponUsageIn } from '@/modules/coupon/usage';
import PaymentRecordModel from '@/modules/payment/model';
import { WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository } from '@/modules/wallet/repository';
import { settlementSystemFor } from '@/modules/partners/services/cutover';
import { ensureSettlementAccount } from '@/modules/partners/services/settlement';
import { istInstant } from '@/modules/partners/services/slots';
import { reserveInterval, moveInterval, releaseInterval } from '@/modules/doctors/services/reservations';
import SpecialistModel from '@/modules/specialists/model';
import { DoctorScheduleTemplateModel } from '@/modules/doctors/model/schedule';

/**
 * Ordinary-booking holds and settlement (option A, phase A2a; milestone C1–C5/E5 on the walletFunding ledger).
 *
 * - Creating a booking takes its slot capacity (and a follow-up parent's benefit) in the SAME transaction as the
 *   insert, so a slot can never be oversold and a benefit never used twice. The appointment time is the slot's.
 * - Cancelling is ONE transaction: the status write, the wallet refund (ledger refundAndCloseIn, covering every
 *   captured payment attempt), marking those records refunded, the coupon undo (coupon/usage.ts), the slot release
 *   and the follow-up restore all commit together or not at all, each exactly once.
 * - The cancellation window applies to bookings with captured money; unpaid ones are exempt (milestone B2). The
 *   decision is serialized with payment capture: the transaction writes every not-yet-settled payment record of the
 *   booking first, so a capture committing earlier is seen (window applies) and one committing later waits for this
 *   cancellation and then finds the booking closed (the ledger returns that late capture to the wallet).
 *
 * Bookings created before A2a have no `holds`, and the old code took their slot and follow-up benefit best-effort,
 * so neither is assumed: a legacy slot unit is released only while the slot still counts at least one unit for every
 * booking claiming it (so releasing can never free a unit another booking holds), and a legacy follow-up benefit is
 * restored only when no other live follow-up claims that consultation. Otherwise nothing is released (capacity may
 * stay under-used; it is never oversold).
 */
export const CANCELLABLE_BOOKING_STATUSES = ['pending', 'confirmed'];
type Holds = NonNullable<IBooking['holds']>;
const conflict = (code: string, message: string, status = 409) => new AppError({ status, code, message });
const changed = () => Object.assign(conflict('BOOKING_CHANGED', 'Booking changed; please retry'), { retryable: true });
const tracked = (b: IBooking) => b.holds?.version === 1;
/** Canonical id: ids are stored as strings, so one ObjectId may appear in several letter cases. Written lowercase. */
const canon = (id: unknown): string | null => (typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id) ? id.toLowerCase() : null);
/** Matches every stored letter-case variant of a canonical id (historic rows were written as supplied). */
const anyCase = (id: string) => new RegExp(`^${id}$`, 'i');

/**
 * The slot unit this booking holds. Tracked bookings record it; for a legacy booking it is released only while the
 * slot counts at least as many units as live bookings claim it (this one included), so the release can never take a
 * unit some other booking holds. Read before this booking's own status changes.
 */
async function heldSlot(b: IBooking, s: ClientSession): Promise<string | null> {
  if (tracked(b)) return canon(b.holds!.heldSlotId);
  const slotId = canon(b.slotId);
  if (b.bookingType === 'surgery' || !slotId) return null; // surgery never took one
  const slot = await SlotModel.findById(slotId).session(s).lean();
  const units = Number(slot?.currentBookings ?? 0);
  if (!slot || !(units > 0)) return null;
  // Tracked bookings always store slotId == holds.heldSlotId (both canonical), so the indexed slotId selects every
  // claimant in any letter case; the $or then keeps the ones that hold (tracked) or may hold (legacy) a unit.
  const claimants = await BookingModel.countDocuments({ slotId: anyCase(slotId), status: { $ne: 'cancelled' }, $or: [
    { 'holds.version': 1, 'holds.heldSlotId': slotId },
    { holds: { $exists: false }, bookingType: { $ne: 'surgery' } },
  ] }).session(s);
  return units >= claimants ? slotId : null;
}

/** The follow-up benefit this booking holds (legacy: only if no other live follow-up claims the same consultation). */
async function heldFollowUpParent(b: IBooking, s: ClientSession): Promise<string | null> {
  if (tracked(b)) return canon(b.holds!.followUpParentId);
  const parent = b.followUp?.isFollowUp ? canon(b.followUp.parentConsultationId) : null;
  if (!parent) return null;
  const others = await BookingModel.countDocuments({ _id: { $ne: b._id }, status: { $ne: 'cancelled' },
    'followUp.isFollowUp': true, 'followUp.parentConsultationId': anyCase(parent) }).session(s);
  return others === 0 ? parent : null;
}

/**
 * Takes one unit of the slot's capacity for `booking` (its date and specialist/package must match) and returns the
 * slot's start time, which becomes the booking's appointment time.
 */
type SlotRow = { _id?: unknown; date?: string; startTime?: string; endTime?: string; duration?: number; maxBookings?: number; specialistId?: string;
  serviceModes?: string[]; branchId?: string };

async function reserveSlot(slotId: string, booking: Pick<IBooking, 'bookingDate' | 'specialistId' | 'wellnessPackageId' | 'consultationMode'>, s: ClientSession) {
  if (!Types.ObjectId.isValid(slotId)) throw conflict('SLOT_NOT_AVAILABLE', 'Slot is not available');
  const slot = await SlotModel.findById(slotId).session(s).lean();
  const max = slot?.maxBookings ?? 1;
  const current = slot?.currentBookings ?? 0;
  if (!slot || slot.isActive === false || slot.isAvailable === false ||
      !Number.isSafeInteger(current) || !Number.isSafeInteger(max) || current < 0 || current >= max) {
    throw conflict('SLOT_NOT_AVAILABLE', 'Slot is not available for booking');
  }
  const time = slotTime(slot, booking);
  // Q4: a doctor's leave day is refused here too, whatever any expansion has (or has not yet) closed.
  if (slot.specialistId && await DoctorScheduleTemplateModel.exists({ doctorId: String(slot.specialistId), leaveDates: String(slot.date) }).session(s)) {
    throw conflict('SLOT_NOT_AVAILABLE', 'The doctor is on leave that day');
  }
  // Q4: a slot offered for some modes only takes bookings in those modes.
  const modes = (slot as SlotRow).serviceModes ?? [];
  if (modes.length > 0 && booking.consultationMode && !modes.includes(String(booking.consultationMode))) {
    throw conflict('SLOT_NOT_AVAILABLE', 'This slot is not offered for that consultation type');
  }
  const r = await SlotModel.updateOne({ _id: slotId, ...(slot.currentBookings === undefined ? { currentBookings: { $exists: false } } : { currentBookings: current }) },
    { $inc: { currentBookings: 1 }, $set: { isAvailable: current + 1 < max } }, { session: s });
  if (r.modifiedCount !== 1) throw changed();
  return { time, slot: slot as SlotRow };
}

/** India-time interval of a slot (YYYYMMDD + HH:mm; end from endTime, else duration, else 30 minutes). */
function slotInterval(slot: SlotRow): { start: Date; end: Date } {
  const d = String(slot.date);
  const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const start = istInstant(date, String(slot.startTime));
  const end = slot.endTime && slot.endTime > String(slot.startTime) ? istInstant(date, slot.endTime)
    : new Date(start.getTime() + (Number(slot.duration) > 0 ? Number(slot.duration) : 30) * 60_000);
  return { start, end };
}

/**
 * Q4 §5: a doctor's one-patient slot is an exclusive interval of the doctor's time, shared with every other booking path
 * (instant, in-clinic) through DoctorReservation. Slots deliberately sold to several patients keep only their counter.
 */
const exclusiveFor = (b: Pick<IBooking, 'specialistId' | 'bookingType'>, slot: SlotRow) =>
  !!b.specialistId && ['consultation', 'second-opinion'].includes(String(b.bookingType)) && Number(slot.maxBookings ?? 1) === 1;

/** The slot's appointment time for `booking`: the slot must be for its date and specialist/package, at a valid time. */
function slotTime(slot: { date?: string; startTime?: string; specialistId?: string; wellnessPackageId?: string },
  booking: Pick<IBooking, 'bookingDate' | 'specialistId' | 'wellnessPackageId'>): string {
  if (slot.date !== booking.bookingDate ||
      (booking.specialistId && String(slot.specialistId).toLowerCase() !== String(booking.specialistId).toLowerCase()) ||
      (booking.wellnessPackageId && String(slot.wellnessPackageId).toLowerCase() !== String(booking.wellnessPackageId).toLowerCase()) ||
      typeof slot.startTime !== 'string' || !parseAppointment({ bookingDate: slot.date, bookingTime: slot.startTime })) {
    throw conflict('SLOT_NOT_AVAILABLE', 'Slot is not available for booking');
  }
  return slot.startTime;
}

/** Gives one unit back (never below zero; a slot that no longer exists is skipped). */
async function releaseSlot(slotId: string, s: ClientSession) {
  if (!Types.ObjectId.isValid(slotId)) return;
  const slot = await SlotModel.findById(slotId).session(s).lean();
  const current = slot?.currentBookings ?? 0;
  if (!slot || !(current > 0)) return;
  const r = await SlotModel.updateOne({ _id: slotId, currentBookings: current },
    { $inc: { currentBookings: -1 }, $set: { isAvailable: slot.isActive !== false && current - 1 < (slot.maxBookings ?? 1) } }, { session: s });
  if (r.modifiedCount !== 1) throw changed();
}

/** Inserts a new booking together with its slot hold and (for a follow-up) the parent's benefit, atomically. */
/** Set on a booking returned because its create key was already used (W3b); not stored. */
export const isReplayedBooking = (b: IBooking) => (b as IBooking & { [REPLAYED]?: boolean })[REPLAYED] === true;
const REPLAYED = Symbol('replayedBooking');

export async function createBookingWithHolds(input: IBooking): Promise<IBooking> {
  return runLedgerTransaction(async s => {
    // Every attempt (also a retry after a duplicate-key clash) first looks for a booking made with this create key.
    if (input.createRequestKey) {
      const prior = await BookingModel.findOne({ userId: { $eq: input.userId }, createRequestKey: { $eq: input.createRequestKey } })
        .session(s).lean() as IBooking | null;
      if (prior) return Object.assign(prior, { [REPLAYED]: true });
    }
    const slotId = input.slotId ? canon(input.slotId) : null;
    if (input.slotId && !slotId && input.bookingType !== 'surgery') throw conflict('SLOT_NOT_AVAILABLE', 'Slot is not available');
    const parentId = input.followUp?.isFollowUp && input.followUp.parentConsultationId ? canon(input.followUp.parentConsultationId) : null;
    if (input.followUp?.isFollowUp && input.followUp.parentConsultationId && !parentId) {
      throw conflict('FOLLOW_UP_UNAVAILABLE', 'The follow-up benefit of this consultation is no longer available');
    }
    const doc = { ...input, ...(slotId ? { slotId } : {}), ...(parentId ? { followUp: { ...input.followUp!, parentConsultationId: parentId } } : {}) };
    const holds: Holds = { version: 1, heldSlotId: input.bookingType !== 'surgery' ? slotId : null, followUpParentId: null };
    const bookingId = new Types.ObjectId();
    if (holds.heldSlotId) {
      const { time, slot } = await reserveSlot(holds.heldSlotId, input, s);
      doc.bookingTime = time;
      if (exclusiveFor(input, slot)) {
        const { start, end } = slotInterval(slot);
        await reserveInterval({ doctorId: String(input.specialistId), kind: 'scheduled', refId: String(bookingId), start, end, branchId: slot.branchId }, s);
      }
    }
    if (parentId) {
      const r = await BookingModel.updateOne({ _id: parentId, userId: { $eq: input.userId }, status: 'completed',
        'followUp.benefitUsed': { $ne: true } }, { $set: { 'followUp.benefitUsed': true } }, { session: s });
      if (r.modifiedCount !== 1) throw conflict('FOLLOW_UP_UNAVAILABLE', 'The follow-up benefit of this consultation is no longer available');
      holds.followUpParentId = parentId;
    }
    // D4: a keyed create whose key was abandoned is never performed; the key is claimed as used in this transaction.
    const requestKey = (doc as { createRequestKey?: unknown }).createRequestKey;
    if (typeof requestKey === 'string' && requestKey) {
      await claimRequestKey(scopeOf('booking_create', String((doc as { userId?: unknown }).userId)), requestKey, s);
    }
    const settlementSystem = settlementSystemFor(new Date());
    // Q4 §7a: a ledger consultation snapshots the doctor's settlement account (created here on first use).
    let settlement: { settlementAccountId: string; beneficiaryName: string } | undefined;
    if (settlementSystem === 'ledger' && input.specialistId) {
      const sp = await SpecialistModel.findById(String(input.specialistId)).select({ name: 1 }).session(s).lean() as { name?: string } | null;
      const account = await ensureSettlementAccount('doctor', String(input.specialistId), sp?.name || input.doctorName || 'Doctor', s);
      settlement = { settlementAccountId: String(account._id), beneficiaryName: account.beneficiaryName };
    }
    const [created] = await BookingModel.create([{ ...doc, _id: bookingId, holds, settlementSystem, ...(settlement ? { settlement } : {}) }], { session: s });
    return created.toObject() as IBooking;
  });
}

export interface CancelResult { booking: IBooking; refunded: number; alreadyCancelled: boolean }
type PaymentRow = { _id: unknown; userId?: unknown; status?: string; finalAmount?: unknown; notes?: { walletDeductedAmount?: unknown } };

/**
 * Returns the money the booking holds through the ledger (every captured attempt of its owner, see
 * refundAndCloseIn) and marks refunded exactly the records whose money is now back in the wallet.
 */
async function settleMoney(booking: IBooking, id: string, records: PaymentRow[], wallets: WalletRepository, s: ClientSession) {
  const owned = records.filter(r => String(r.userId) === String(booking.userId));
  const paid = owned.filter(r => r.status === 'paid');
  const linked = booking.paymentTransactionId ? owned.find(r => String(r._id) === String(booking.paymentTransactionId)) : undefined;
  const legacyRefund = await WalletTransactionModel.findOne({ userId: booking.userId, transactionType: 'refund', referenceType: 'booking',
    referenceId: id, status: 'completed', operationKey: { $exists: false } }).session(s).lean();
  let refunded = await refundAndCloseIn({ model: BookingModel, kind: 'booking', bookingId: id, userId: booking.userId,
    legacyFunded: Number(linked?.notes?.walletDeductedAmount || 0),
    legacyGateway: linked?.status === 'paid' ? Number(linked.finalAmount || 0) : 0,
    legacyGatewayRecordId: linked ? String(linked._id) : undefined,
    paidRecords: paid.map(r => ({ recordId: String(r._id), amount: Number(r.finalAmount || 0) })),
    priorRefund: !!legacyRefund, wallets }, s);
  if (legacyRefund) refunded += Number(legacyRefund.amount);
  const ledger = await BookingModel.findById(id).select({ walletFunding: 1 }).session(s).lean() as IBooking | null;
  const returned = new Set((ledger?.walletFunding?.captures ?? []).filter(c => c.state === 'returned').map(c => String(c.recordId).toLowerCase()));
  const settled = paid.filter(r => !(Number(r.finalAmount || 0) > 0) || returned.has(String(r._id).toLowerCase())).map(r => r._id);
  if (settled.length) {
    await PaymentRecordModel.updateMany({ _id: { $in: settled }, status: 'paid' }, { $set: { status: 'refunded' } }, { session: s });
  }
  return refunded;
}

/**
 * The single cancellation transaction (see the module note). `enforceWindow` is called only when the booking holds
 * captured money; it throws to refuse. Repeating it on a cancelled booking (closed ledger) returns any captured payment
 * the ledger does not know yet and undoes any coupon count that landed after the cancel, and changes nothing else.
 */
export async function cancelBookingSettlement(p: {
  bookingId: string; requester: { _id: string; userType: string }; reason: string; cancelledAt: string; cause?: string;
  lifecycle: (b: IBooking) => IBooking['lifecycle']; enforceWindow: (b: IBooking) => void; wallets: WalletRepository;
}): Promise<CancelResult> {
  if (!Types.ObjectId.isValid(p.bookingId)) throw conflict('BOOKING_NOT_FOUND', 'Booking not found', 404);
  const id = String(p.bookingId).toLowerCase();
  return runLedgerTransaction(async s => {
    // Q4: the booking's own doctor may cancel it too (always a full refund; the caller passes no window).
    const owner = p.requester.userType === 'admin' ? {}
      : p.requester.userType === 'specialist' ? { specialistId: { $eq: p.requester._id } }
      : { userId: { $eq: p.requester._id } };
    const booking = await BookingModel.findOne({ _id: id, ...owner }).session(s).lean() as IBooking | null;
    if (!booking) throw conflict('BOOKING_NOT_FOUND', 'Booking not found', 404);
    // Q4b: an instant consultation's money is held by its InstantRequest; only the instant cancel command refunds it.
    if (booking.bookingKind === 'instant') throw conflict('INSTANT_CONSULT_COMMAND_REQUIRED', 'Use the instant consultation cancel command');
    const already = booking.status === 'cancelled';
    if (already && !booking.walletFunding?.closed) return { booking, refunded: 0, alreadyCancelled: true };
    if (!already && !CANCELLABLE_BOOKING_STATUSES.includes(String(booking.status))) {
      throw conflict('BOOKING_NOT_CANCELLABLE', `A ${booking.status} booking cannot be cancelled`);
    }

    // Serialize with capture: write every not-yet-settled payment record of this booking before reading them.
    await PaymentRecordModel.collection.updateMany({ context: 'booking', contextId: id, status: { $nin: ['paid', 'refunded'] } },
      { $set: { updatedAt: new Date() } }, { session: s });
    const records = await PaymentRecordModel.find({ context: 'booking', contextId: id }).session(s).lean() as unknown as PaymentRow[];

    if (already) {
      // Recovery: a payment or coupon count that landed after the cancel (or whose follow-up was interrupted) is
      // undone once; everything already settled is left as it is.
      await undoCouponUsageIn(records.map(r => String(r._id)), s);
      const refunded = await settleMoney(booking, id, records, p.wallets, s);
      return { booking: await BookingModel.findById(id).session(s).lean() as IBooking, refunded, alreadyCancelled: true };
    }

    const captured = booking.paymentStatus === 'paid' || records.some(r => r.status === 'paid') ||
      (booking.walletFunding?.captures ?? []).some(c => c.state === 'applied');
    if (captured) p.enforceWindow(booking);

    // What this booking holds is decided before its own status changes (a legacy booking counts as a claimant).
    const slot = await heldSlot(booking, s);
    const parent = await heldFollowUpParent(booking, s);

    const cancelled = await BookingModel.updateOne({ _id: id, status: booking.status },
      { $set: { status: 'cancelled', paymentStatus: 'refunded', cancellationReason: p.reason, cancelledAt: p.cancelledAt,
        ...(p.cause ? { cancellationCause: p.cause } : {}), lifecycle: p.lifecycle(booking) } }, { session: s });
    if (cancelled.modifiedCount !== 1) throw changed();
    await releaseInterval('scheduled', id, s);

    // Coupon state first (it reads each record as captured, before the money step marks it refunded).
    await undoCouponUsageIn(records.map(r => String(r._id)), s);
    const refunded = await settleMoney(booking, id, records, p.wallets, s);

    if (slot) await releaseSlot(slot, s);
    if (parent) {
      await BookingModel.updateOne({ _id: parent, 'followUp.benefitUsed': true }, { $set: { 'followUp.benefitUsed': false } }, { session: s });
    }
    await BookingModel.updateOne({ _id: id, status: 'cancelled' },
      { $set: { holds: { version: 1, heldSlotId: null, followUpParentId: null } } }, { session: s });
    const after = await BookingModel.findById(id).session(s).lean() as IBooking;
    return { booking: after, refunded, alreadyCancelled: false };
  });
}

/** How long a booking may wait for its payment before it expires (D2). */
export const BOOKING_PAYMENT_WINDOW_MS = 30 * 60_000;
export const paymentDeadlinePassed = (b: Pick<IBooking, 'createdAt'>, now: Date) =>
  !!b.createdAt && new Date(b.createdAt).getTime() <= now.getTime() - BOOKING_PAYMENT_WINDOW_MS;

export type ExpiryResult = { expired: true; booking: IBooking; refunded: number } | { expired: false; reason: 'not_pending' | 'not_due' | 'paid' };

/**
 * Expires an unpaid booking whose payment window passed (D2). An internal operation (no requester, not reachable from
 * a client), and the ONLY admission is inside this transaction, after the capture fence: still pending, still
 * unpaid, past its deadline, and no captured or applied money. A payment that won the race leaves the booking alone
 * (the caller resumes its processing). Otherwise one cancellation as cancelBookingSettlement: coupon undone, wallet
 * funding returned, slot and follow-up released, cause 'payment_timeout'. A capture arriving later is returned to
 * the wallet by the existing payment paths.
 */
export async function expireUnpaidBooking(p: { bookingId: string; now: Date; wallets: WalletRepository; cancelledAt: string;
  lifecycle: (b: IBooking) => IBooking['lifecycle'] }): Promise<ExpiryResult> {
  if (!Types.ObjectId.isValid(p.bookingId)) return { expired: false, reason: 'not_pending' };
  const id = String(p.bookingId).toLowerCase();
  return runLedgerTransaction(async s => {
    const booking = await BookingModel.findById(id).session(s).lean() as IBooking | null;
    if (!booking || booking.status !== 'pending' || booking.paymentStatus !== 'pending') return { expired: false, reason: 'not_pending' };
    if (!paymentDeadlinePassed(booking, p.now)) return { expired: false, reason: 'not_due' };

    // Serialize with capture exactly like a cancellation, then decide on what is now committed.
    await PaymentRecordModel.collection.updateMany({ context: 'booking', contextId: id, status: { $nin: ['paid', 'refunded'] } },
      { $set: { updatedAt: new Date() } }, { session: s });
    const records = await PaymentRecordModel.find({ context: 'booking', contextId: id }).session(s).lean() as unknown as PaymentRow[];
    if (records.some(r => r.status === 'paid') || (booking.walletFunding?.captures ?? []).some(c => c.state === 'applied')) {
      return { expired: false, reason: 'paid' };
    }

    const slot = await heldSlot(booking, s);
    const parent = await heldFollowUpParent(booking, s);
    const cancelled = await BookingModel.updateOne({ _id: id, status: 'pending', paymentStatus: 'pending' },
      { $set: { status: 'cancelled', paymentStatus: 'refunded', cancellationReason: 'Payment was not completed in time',
        cancellationCause: 'payment_timeout', cancelledAt: p.cancelledAt, lifecycle: p.lifecycle(booking) },
        $unset: { expiryNextAt: 1, expiryChecks: 1 } }, { session: s });
    if (cancelled.modifiedCount !== 1) throw changed();
    await releaseInterval('scheduled', id, s);
    await undoCouponUsageIn(records.map(r => String(r._id)), s);
    const refunded = await settleMoney(booking, id, records, p.wallets, s);
    if (slot) await releaseSlot(slot, s);
    if (parent) {
      await BookingModel.updateOne({ _id: parent, 'followUp.benefitUsed': true }, { $set: { 'followUp.benefitUsed': false } }, { session: s });
    }
    await BookingModel.updateOne({ _id: id, status: 'cancelled' },
      { $set: { holds: { version: 1, heldSlotId: null, followUpParentId: null } } }, { session: s });
    return { expired: true, booking: await BookingModel.findById(id).session(s).lean() as IBooking, refunded };
  });
}

/**
 * Moves the booking's slot hold to `nextSlotId` and writes the new appointment, atomically (milestone C3). The
 * appointment time is always the target slot's start time.
 */
export async function rescheduleWithHolds(p: {
  bookingId: string; requester: { _id: string; userType: string }; nextSlotId: string; patch: Record<string, unknown>;
}): Promise<IBooking> {
  if (!Types.ObjectId.isValid(p.bookingId)) throw conflict('BOOKING_NOT_FOUND', 'Booking not found', 404);
  const id = String(p.bookingId).toLowerCase();
  return runLedgerTransaction(async s => {
    const owner = p.requester.userType === 'admin' ? {} : { userId: { $eq: p.requester._id } };
    const booking = await BookingModel.findOne({ _id: id, ...owner }).session(s).lean() as IBooking | null;
    if (!booking) throw conflict('BOOKING_NOT_FOUND', 'Booking not found', 404);
    if (!CANCELLABLE_BOOKING_STATUSES.includes(String(booking.status))) {
      throw conflict('BOOKING_NOT_RESCHEDULABLE', `A ${booking.status} booking cannot be rescheduled`);
    }
    const current = await heldSlot(booking, s);
    const target = canon(p.nextSlotId);
    if (!target) throw conflict('SLOT_NOT_AVAILABLE', 'Slot is not available');
    const next = { ...booking, ...p.patch } as IBooking;
    let bookingTime: string;
    if (current !== target) {
      const reserved = await reserveSlot(target, next, s);
      bookingTime = reserved.time;
      if (current) await releaseSlot(current, s);
      // Q4: the doctor's interval moves with the appointment (refused if the doctor is not free then).
      if (exclusiveFor(next, reserved.slot)) {
        const { start, end } = slotInterval(reserved.slot);
        const doctorId = String(next.specialistId);
        try {
          await moveInterval({ doctorId, kind: 'scheduled', refId: id, start, end }, s);
        } catch (e) {
          if ((e as { code?: string })?.code !== 'RESERVATION_NOT_ACTIVE') throw e;
          await reserveInterval({ doctorId, kind: 'scheduled', refId: id, start, end, branchId: reserved.slot.branchId }, s);
        }
      } else {
        await releaseInterval('scheduled', id, s);
      }
    } else {
      // Same slot, already held: only the appointment fields may change, and they must still match the slot.
      const slot = await SlotModel.findById(target).session(s).lean();
      if (!slot) throw conflict('SLOT_NOT_AVAILABLE', 'Slot is not available for booking');
      bookingTime = slotTime(slot, next);
    }
    const holds: Holds = { version: 1, heldSlotId: target, followUpParentId: await heldFollowUpParent(booking, s) };
    const updated = await BookingModel.findOneAndUpdate({ _id: id, status: booking.status },
      { $set: { ...p.patch, bookingTime, slotId: target, holds } }, { new: true, session: s }).lean() as IBooking | null;
    if (!updated) throw changed();
    return updated;
  });
}
