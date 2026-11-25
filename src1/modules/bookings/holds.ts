import { createHash } from 'crypto';
import { claimRequestKey, scopeOf } from '@/modules/requestKeys';
import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { refundAndCloseIn, runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { parseAppointment, refundDeadlineOf } from '@/modules/common/utils/cancellationWindow';
import BookingModel from '@/modules/bookings/model';
import { flagLegacyOriginalMonth } from '@/modules/bookings/repository';
import { IBooking } from '@/modules/bookings/types';
import SlotModel from '@/modules/slots/model';
import { undoCouponUsageIn } from '@/modules/coupon/usage';
import PaymentRecordModel from '@/modules/payment/model';
import { WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository } from '@/modules/wallet/repository';
import { settlementSystemFor } from '@/modules/partners/services/cutover';
import { ensureSettlementAccount } from '@/modules/partners/services/settlement';
import { bookableUntilOf, isWindowSlot, slotIntervalOf } from '@/modules/common/utils/slotInterval';
import { reserveInterval, moveInterval, releaseInterval } from '@/modules/doctors/services/reservations';
import SpecialistModel from '@/modules/specialists/model';
import { assertBookableDoctor } from '@/modules/specialists/eligibility';
import { DoctorScheduleTemplateModel } from '@/modules/doctors/model/schedule';
import { assistedBookerFilter, assistedCauseOf, settleAssistedFundingIn } from '@/modules/assisted/refunds';
import { countBookerCancellationIn } from '@/modules/assisted/limits';
import { unpaidCardBooking } from '@/modules/assisted/views';
import { clinicBranchContext, branchClosedOn } from '@/modules/doctors/services/schedule';

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
/**
 * Q16a (owner, 22 Nov 2026 — assumption recorded in §11): a no-show can be marked only 15 minutes after the appointment
 * starts (an instant consultation: 15 minutes after the doctor accepted).
 */
export const NO_SHOW_GRACE_MS = 15 * 60_000;
/** The appointment start of a booking as stored (India time, either slot time format); null when it does not parse. */
export const appointmentStartOf = (b: Pick<IBooking, 'bookingDate' | 'bookingTime'>): Date | null =>
  parseAppointment({ bookingDate: String(b.bookingDate ?? ''), bookingTime: String(b.bookingTime ?? '') })?.at ?? null;
/** The moment from which a no-show may be marked (instant: accept time = booking creation), or null when unknown. */
export function noShowAllowedFrom(b: Pick<IBooking, 'bookingDate' | 'bookingTime' | 'bookingKind' | 'createdAt'>): Date | null {
  const start = b.bookingKind === 'instant' && b.createdAt ? new Date(b.createdAt) : appointmentStartOf(b);
  return start ? new Date(start.getTime() + NO_SHOW_GRACE_MS) : null;
}
/**
 * Q16d (F1): the no-show moment, judged on the booking's slot. A window (`isWindowSlot`: a package window or a
 * multi-seat session) takes patients until it ENDS, so its no-show may be marked only 15 minutes after the window's END
 * (a late joiner is never marked absent at once); a doctor's one-patient slot (or a booking whose slot is unknown)
 * keeps start + 15 minutes.
 */
export async function noShowAllowedFromSlot(b: Pick<IBooking, 'bookingDate' | 'bookingTime' | 'bookingKind' | 'createdAt' | 'slotId'>,
  s?: ClientSession): Promise<Date | null> {
  if (b.bookingKind !== 'instant' && typeof b.slotId === 'string' && Types.ObjectId.isValid(b.slotId)) {
    const slot = await SlotModel.findById(b.slotId).select({ date: 1, startTime: 1, endTime: 1, duration: 1, maxBookings: 1, slotType: 1, wellnessPackageId: 1 })
      .session(s ?? null).lean() as SlotRow | null;
    if (slot && isWindowSlot(slot)) {
      const w = slotIntervalOf(slot);
      if (w) return new Date(w.end.getTime() + NO_SHOW_GRACE_MS);
    }
  }
  return noShowAllowedFrom(b);
}
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
  serviceModes?: string[]; branchId?: string; slotType?: string; wellnessPackageId?: string };

/**
 * Q6: a clinic desk acting: the slot must be at one of its branches within the desk member's scope (empty = all).
 * Q13: with `refuseStartedClock`, a slot whose start is at or before the clock's time at admission is refused (409 SLOT_STARTED).
 */
export interface DeskScope {
  partnerId: string; branchIds: string[];
  /** Q13 review: the clock read at admission, inside each booking transaction attempt (injectable for tests). */
  refuseStartedClock?: () => Date;
}

/** Q13: the booking's updatedAt the caller decided on; any other current value refuses the change (409 BOOKING_CHANGED). */
export function assertBookingVersion(b: Pick<IBooking, 'updatedAt'>, expectedUpdatedAt?: Date | string | null): void {
  if (expectedUpdatedAt === undefined || expectedUpdatedAt === null) return;
  const cur = b.updatedAt ? new Date(b.updatedAt).getTime() : null;
  if (cur !== new Date(expectedUpdatedAt).getTime()) throw conflict('BOOKING_CHANGED', 'The appointment changed since it was loaded; reload and try again');
}

/** The desk bookings a desk scope may act on, as currently stored (every attempt re-reads it in the transaction). */
function deskOwnerFilter(desk?: DeskScope): Record<string, unknown> {
  if (!desk) return { _id: { $exists: false } }; // no scope, nothing
  return { 'clinicDesk.partnerId': { $eq: desk.partnerId }, ...(desk.branchIds.length ? { 'clinicDesk.branchId': { $in: desk.branchIds } } : {}) };
}
export const deskBookingInScope = (b: Pick<IBooking, 'clinicDesk'>, desk: DeskScope) =>
  !!b.clinicDesk && b.clinicDesk.partnerId === desk.partnerId && (desk.branchIds.length === 0 || desk.branchIds.includes(String(b.clinicDesk.branchId)));

async function reserveSlot(slotId: string, booking: Pick<IBooking, 'bookingDate' | 'specialistId' | 'wellnessPackageId' | 'consultationMode'>, s: ClientSession,
  desk?: DeskScope, startedClock?: () => Date) {
  if (!Types.ObjectId.isValid(slotId)) throw conflict('SLOT_NOT_AVAILABLE', 'Slot is not available');
  const slot = await SlotModel.findById(slotId).session(s).lean();
  const max = slot?.maxBookings ?? 1;
  const current = slot?.currentBookings ?? 0;
  if (!slot || slot.isActive === false || slot.isAvailable === false ||
      !Number.isSafeInteger(current) || !Number.isSafeInteger(max) || current < 0 || current >= max) {
    throw conflict('SLOT_NOT_AVAILABLE', 'Slot is not available for booking');
  }
  // S5b: every admission and every move (online, desk, no-show, admin) takes a doctor's slot only while the doctor's
  // record, as this transaction reads it, is verified and active (400 SPECIALIST_NOT_ACTIVE / SPECIALIST_NOT_VERIFIED). A
  // missing record is not judged here (creating a booking already requires an existing doctor).
  if (slot.specialistId && /^[0-9a-fA-F]{24}$/.test(String(slot.specialistId))) {
    const sp = await SpecialistModel.findById(String(slot.specialistId)).select({ isActive: 1, isVerified: 1 }).session(s).lean();
    if (sp) assertBookableDoctor(sp);
  }
  const time = slotTime(slot, booking);
  // Q4: a doctor's leave day is refused here too, whatever any expansion has (or has not yet) closed.
  if (slot.specialistId && await DoctorScheduleTemplateModel.exists({ doctorId: String(slot.specialistId), leaveDates: String(slot.date) }).session(s)) {
    throw conflict('SLOT_NOT_AVAILABLE', 'The doctor is on leave that day');
  }
  // Q16a (M4): a clinic branch's holiday closes its in-clinic slots for every doctor, whatever any expansion has closed.
  if ((slot as SlotRow).branchId && await branchClosedOn(String((slot as SlotRow).branchId), String(slot.date), s)) {
    throw conflict('SLOT_NOT_AVAILABLE', 'The clinic is closed that day');
  }
  assertSlotMode(slot as SlotRow, booking);
  // Q4: an in-clinic slot is sold only while the doctor still consults at that clinic branch (current state). Q6: the
  // clinic association is decided here, on the slot as this transaction reads it, and a desk may only use its own branches.
  let clinic: { partnerId: string; branchId: string } | null = null;
  if ((slot as SlotRow).branchId) {
    clinic = await clinicBranchContext(String(slot.specialistId), String((slot as SlotRow).branchId), s);
    if (!clinic) throw conflict('SLOT_NOT_AVAILABLE', 'The doctor no longer consults at this clinic');
  }
  if (desk && (!clinic || clinic.partnerId !== desk.partnerId || (desk.branchIds.length > 0 && !desk.branchIds.includes(clinic.branchId)))) {
    throw conflict('SLOT_NOT_AVAILABLE', 'This slot is not at one of your clinic branches');
  }
  // Q16a (M1): a one-patient slot that has started (India time) is never admitted, on every path (Q13 did this for the
  // desk only). Re-review N1 (owner): a multi-seat window (maxBookings > 1: package windows, doctor sessions) stays
  // bookable until it ENDS, as before.
  const refuseStarted = desk?.refuseStartedClock ?? startedClock ?? (() => new Date());
  {
    const until = bookableUntilOf(slot as SlotRow);
    // Sampled now, at admission (each transaction attempt), not when the request arrived.
    if (!until || until.getTime() <= refuseStarted().getTime()) {
      throw conflict('SLOT_STARTED', isWindowSlot(slot as SlotRow) ? 'This session has ended; choose a later one' : 'This slot has already started; choose a later one');
    }
  }
  const r = await SlotModel.updateOne({ _id: slotId, ...(slot.currentBookings === undefined ? { currentBookings: { $exists: false } } : { currentBookings: current }) },
    { $inc: { currentBookings: 1 }, $set: { isAvailable: current + 1 < max } }, { session: s });
  if (r.modifiedCount !== 1) throw changed();
  return { time, slot: slot as SlotRow, clinic };
}

/** Q4: a slot offered for some modes only takes bookings (and mode changes) in those modes. */
function assertSlotMode(slot: SlotRow, booking: Pick<IBooking, 'consultationMode'>) {
  const modes = slot.serviceModes ?? [];
  if (modes.length > 0 && booking.consultationMode && !modes.includes(String(booking.consultationMode))) {
    throw conflict('SLOT_NOT_AVAILABLE', 'This slot is not offered for that consultation type');
  }
}

/**
 * Generic writers that change a booking's consultation mode admit it against the slot the booking holds. A booked slot's
 * modes are never refreshed by expansion (it only rewrites unbooked template slots), so this read is stable.
 */
export async function assertModeForHeldSlot(booking: Pick<IBooking, 'slotId' | 'holds'>, consultationMode: unknown): Promise<void> {
  const slotId = canon(booking.holds?.heldSlotId ?? booking.slotId);
  if (!slotId || typeof consultationMode !== 'string') return;
  const slot = await SlotModel.findById(slotId).lean();
  if (slot) assertSlotMode(slot as SlotRow, { consultationMode } as Pick<IBooking, 'consultationMode'>);
}

/** India-time interval of a slot in either stored time format; a slot whose time does not parse is refused. */
function slotInterval(slot: SlotRow): { start: Date; end: Date } {
  const w = slotIntervalOf(slot);
  if (!w) throw conflict('SLOT_NOT_AVAILABLE', 'Slot is not available for booking');
  return w;
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
  // Q16a re-review (N2): a slot switched off by hand stays closed; only its seat is given back.
  const r = await SlotModel.updateOne({ _id: slotId, currentBookings: current },
    { $inc: { currentBookings: -1 }, $set: { isAvailable: slot.isActive !== false && (slot as { manuallyClosed?: boolean }).manuallyClosed !== true
      && current - 1 < (slot.maxBookings ?? 1) } }, { session: s });
  if (r.modifiedCount !== 1) throw changed();
}

/** Inserts a new booking together with its slot hold and (for a follow-up) the parent's benefit, atomically. */
/** Set on a booking returned because its create key was already used (W3b); not stored. */
export const isReplayedBooking = (b: IBooking) => (b as IBooking & { [REPLAYED]?: boolean })[REPLAYED] === true;
const REPLAYED = Symbol('replayedBooking');

/** `inTx` runs inside the booking's transaction after the insert (e.g. a partner audit that must commit with it). */
export async function createBookingWithHolds(input: IBooking, inTx?: (b: IBooking, s: ClientSession) => Promise<void>, desk?: DeskScope): Promise<IBooking> {
  return runLedgerTransaction(async s => {
    // Every attempt (also a retry after a duplicate-key clash) first looks for a booking made with this create key.
    if (input.createRequestKey) {
      const prior = await BookingModel.findOne({ userId: { $eq: input.userId }, createRequestKey: { $eq: input.createRequestKey } })
        .session(s).lean() as IBooking | null;
      if (prior) return Object.assign(prior, { [REPLAYED]: true });
    }
    // Q6: a desk key already used is answered with its booking on every attempt, before any capacity is taken
    // (the caller compares the content hash and the current branch scope).
    if (input.clinicDesk?.requestKey) {
      const prior = await BookingModel.findOne({ 'clinicDesk.requestKey': { $eq: input.clinicDesk.requestKey } }).session(s).lean() as IBooking | null;
      if (prior) return Object.assign(prior, { [REPLAYED]: true });
    }
    // Assisted booking phase 1a: an assisted request key already used answers with its booking on every attempt (the
    // caller compares the content hash), before any capacity or money is taken.
    if (input.assisted?.requestKey) {
      const prior = await BookingModel.findOne({ 'assisted.requestKey': { $eq: input.assisted.requestKey } }).session(s).lean() as IBooking | null;
      if (prior) return Object.assign(prior, { [REPLAYED]: true });
    }
    const slotId = input.slotId ? canon(input.slotId) : null;
    if (input.slotId && !slotId && input.bookingType !== 'surgery') throw conflict('SLOT_NOT_AVAILABLE', 'Slot is not available');
    const parentId = input.followUp?.isFollowUp && input.followUp.parentConsultationId ? canon(input.followUp.parentConsultationId) : null;
    if (input.followUp?.isFollowUp && input.followUp.parentConsultationId && !parentId) {
      throw conflict('FOLLOW_UP_UNAVAILABLE', 'The follow-up benefit of this consultation is no longer available');
    }
    // Q16a: a doctor id is stored in its canonical (lower-case) spelling, so one doctor has one settlement account,
    // one schedule guard and one set of reservations whatever letter case a client sent.
    const specialistId = canon(input.specialistId) ?? input.specialistId;
    const doc = { ...input, ...(specialistId ? { specialistId } : {}), ...(slotId ? { slotId } : {}),
      ...(parentId ? { followUp: { ...input.followUp!, parentConsultationId: parentId } } : {}) };
    const holds: Holds = { version: 1, heldSlotId: input.bookingType !== 'surgery' ? slotId : null, followUpParentId: null };
    const bookingId = new Types.ObjectId();
    if (input.clinicDesk && !desk) throw conflict('SLOT_NOT_AVAILABLE', 'A clinic desk booking needs its clinic scope');
    if (holds.heldSlotId) {
      const { time, slot, clinic } = await reserveSlot(holds.heldSlotId, doc, s, desk);
      doc.bookingTime = time;
      if (clinic) {
        doc.clinicVisit = clinic;
        if (doc.clinicDesk) doc.clinicDesk = { ...doc.clinicDesk, branchId: clinic.branchId };
      }
      if (exclusiveFor(doc, slot)) {
        const { start, end } = slotInterval(slot);
        await reserveInterval({ doctorId: String(doc.specialistId), kind: 'scheduled', refId: String(bookingId), start, end, branchId: slot.branchId }, s);
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
    // Q6: a front-desk appointment is paid at the clinic — never the legacy payouts', never the ledger's.
    // Assisted booking (§5.1): a partner-paid consultation is always settled by the ledger, whatever the cutover says.
    const settlementSystem = input.clinicDesk ? 'clinic' as const : input.assisted ? 'ledger' as const : settlementSystemFor(new Date());
    // Q4 §7a: a ledger consultation snapshots the doctor's settlement account (created here on first use).
    let settlement: { settlementAccountId: string; beneficiaryName: string } | undefined;
    if (settlementSystem === 'ledger' && doc.specialistId) {
      const sp = await SpecialistModel.findById(String(doc.specialistId)).select({ name: 1 }).session(s).lean() as { name?: string } | null;
      const account = await ensureSettlementAccount('doctor', String(doc.specialistId), sp?.name || input.doctorName || 'Doctor', s);
      settlement = { settlementAccountId: String(account._id), beneficiaryName: account.beneficiaryName };
    }
    // r32 (4c, §26.7): a self booking's v2 earning rule applies only where the ledger pays (legacy and clinic rows untouched).
    const row = settlementSystem === 'ledger' || !doc.earningSplit ? doc : (({ earningRule: _r, earningSplit: _s, ...rest }) => rest)(doc);
    const [created] = await BookingModel.create([{ ...row, _id: bookingId, holds, settlementSystem, ...(settlement ? { settlement } : {}) }], { session: s });
    const out = created.toObject() as IBooking;
    if (inTx) await inTx(out, s);
    return out;
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
  /** Runs inside the transaction after a (first) cancellation, e.g. a partner audit; `refunded` is what was refunded. */
  inTx?: (b: IBooking, s: ClientSession, refunded: number) => Promise<void>;
  /** Q6: requester 'clinic' — the desk's clinic and branch scope, applied to the booking as read in the transaction. */
  desk?: DeskScope;
  /** Q13: the booking version (updatedAt) the caller decided on, checked on the booking as read in the transaction. */
  expectedUpdatedAt?: Date | string | null;
  /**
   * Q16a (owner, 22 Nov 2026): an ADMIN cancels a booking that was moved after a no-show (the provider cannot attend)
   * and chooses whether the patient is refunded. Only with requester 'admin'; the booking must have been moved.
   */
  movedNoShow?: { refund: boolean };
  /** Assisted booking phase 1a: the booker's own command (its assisted bookings only; never the generic routes). 2e: a lab too. */
  assistedBooker?: 'pharmacy' | 'lab';
  /** Phase 1b: the booker's choice for a card-paid booking's refund (default: back to the card). */
  assistedRefundTo?: 'card' | 'wallet';
}): Promise<CancelResult> {
  if (!Types.ObjectId.isValid(p.bookingId)) throw conflict('BOOKING_NOT_FOUND', 'Booking not found', 404);
  const id = String(p.bookingId).toLowerCase();
  return runLedgerTransaction(async s => {
    // Q4: the booking's own doctor may cancel it too (always a full refund; the caller passes no window).
    const owner = p.requester.userType === 'admin' ? {}
      : p.requester.userType === 'specialist' ? { specialistId: { $eq: p.requester._id } }
      : p.requester.userType === 'clinic' ? deskOwnerFilter(p.desk)
      // Assisted booking phase 1a: a booker acts only on the assisted bookings it made (legacy pharmacy rows excluded).
      : p.assistedBooker ? assistedBookerFilter(p.assistedBooker, p.requester._id)
      : { userId: { $eq: p.requester._id } };
    const booking = await BookingModel.findOne({ _id: id, ...owner }).session(s).lean() as IBooking | null;
    if (!booking) throw conflict('BOOKING_NOT_FOUND', 'Booking not found', 404);
    // r10b: a card-paid assisted booking never confirmed is the booker's alone; the patient and the doctor cannot see it.
    if (['user', 'specialist'].includes(p.requester.userType) && unpaidCardBooking(booking as never)) throw conflict('BOOKING_NOT_FOUND', 'Booking not found', 404);
    // Q4b: an instant consultation's money is held by its InstantRequest; only the instant cancel command refunds it.
    if (booking.bookingKind === 'instant') throw conflict('INSTANT_CONSULT_COMMAND_REQUIRED', 'Use the instant consultation cancel command');
    // Q16d (F5): a clinic desk appointment (paid at the clinic, nothing taken by us) is cancelled with the clinic's own
    // cancellation, never with the admin's moved-no-show command.
    if (p.movedNoShow && (booking.settlementSystem === 'clinic' || booking.clinicDesk)) {
      throw conflict('USE_CLINIC_CANCEL', 'This is a clinic desk appointment; cancel it with the clinic\'s cancellation');
    }
    const already = booking.status === 'cancelled';
    // Q16a re-review (F): the admin's moved-no-show cancel is one decision; a second one is refused, not answered 200.
    if (already && p.movedNoShow) throw conflict('ALREADY_CANCELLED', 'This booking is already cancelled');
    if (already && !booking.walletFunding?.closed) return { booking, refunded: 0, alreadyCancelled: true };
    if (!already && !CANCELLABLE_BOOKING_STATUSES.includes(String(booking.status))) {
      throw conflict('BOOKING_NOT_CANCELLABLE', `A ${booking.status} booking cannot be cancelled`);
    }
    const moved = (booking.noShows?.length ?? 0) > 0;
    if (p.movedNoShow) {
      if (p.requester.userType !== 'admin') throw conflict('ADMIN_ONLY', 'Only the Jansetu team can cancel a moved no-show', 403);
      if (!already && !moved) throw conflict('BOOKING_NOT_MOVED_NO_SHOW', 'This booking was not moved after a no-show; use the ordinary cancellation');
    }
    // Q14: a booking rescheduled after a no-show is never refunded; only a clinic-paid one (nothing taken by us) may be
    // cancelled. Q16a: an admin may cancel it with the dedicated command, refund or not (their choice).
    if (!already && moved && booking.settlementSystem !== 'clinic' && !p.movedNoShow) {
      throw conflict('NO_SHOW_NOT_REFUNDABLE', 'This appointment was rescheduled after a no-show and cannot be cancelled for a refund');
    }
    const keepMoney = !!p.movedNoShow && !p.movedNoShow.refund;
    // A moved no-show cancelled without a refund keeps its money (the platform keeps it, as for a no-show): a repeat is
    // answered as it is, never refunded later by the recovery path below.
    if (already && booking.noShowCancel?.refund === false) return { booking, refunded: 0, alreadyCancelled: true };
    if (!already) assertBookingVersion(booking, p.expectedUpdatedAt);

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
    if (captured && !p.movedNoShow) p.enforceWindow(booking);

    // What this booking holds is decided before its own status changes (a legacy booking counts as a claimant).
    const slot = await heldSlot(booking, s);
    const parent = await heldFollowUpParent(booking, s);

    const cancelled = await BookingModel.updateOne({ _id: id, status: booking.status },
      { $set: { status: 'cancelled', ...(keepMoney ? {} : { paymentStatus: 'refunded' }), cancellationReason: p.reason, cancelledAt: p.cancelledAt,
        ...(p.cause ? { cancellationCause: p.cause } : {}), lifecycle: p.lifecycle(booking),
        ...(p.movedNoShow ? { noShowCancel: { at: new Date(), by: String(p.requester._id), refund: p.movedNoShow.refund } } : {}) } }, { session: s });
    if (cancelled.modifiedCount !== 1) throw changed();
    await releaseInterval('scheduled', id, s);
    // Q16d (F2): a legacy booking moved after a no-show is billed in its ORIGINAL month; cancelling it changes that
    // month's bill, so an already computed row of it is flagged for recalculation in this transaction (as the other paths do).
    if (moved) await flagLegacyOriginalMonth(booking, s);

    // Coupon state first (it reads each record as captured, before the money step marks it refunded). Without a refund
    // the coupon stays used and the money stays where it is (nobody earns it: the booking is not completed).
    let refunded = 0;
    if (booking.assisted?.funding) {
      // Assisted booking phase 1a (§8.4, §8.7): partner money goes back to the partner by its method (wallet), in this
      // transaction, whatever the wallet's state; the coupon redemption is reversed; the join link dies. Never the
      // customer's wallet ledger.
      refunded = await settleAssistedFundingIn(booking, { cause: p.cause ?? assistedCauseOf(p.requester.userType), keepMoney,
        ...(p.assistedRefundTo ? { refundTo: p.assistedRefundTo } : {}) }, s);
    } else if (!keepMoney) {
      await undoCouponUsageIn(records.map(r => String(r._id)), s);
      refunded = await settleMoney(booking, id, records, p.wallets, s);
    } else {
      // Q16a re-review (F): the money is kept as FORFEITED — the funding record is closed (it no longer shows money held;
      // a late capture is returned to the wallet) and the amount kept is recorded on the cancel.
      const wf = booking.walletFunding as { total?: number; revision?: number; captures?: { amount: number; state: string }[] } | undefined;
      const forfeited = wf ? Math.round((Number(wf.total || 0) + (wf.captures ?? []).filter(c => c.state === 'applied')
        .reduce((a, c) => a + Number(c.amount || 0), 0)) * 100) / 100 : Number(booking.price || 0);
      await BookingModel.updateOne({ _id: id, status: 'cancelled' }, { $set: {
        'noShowCancel.forfeitedAmount': forfeited,
        ...(wf ? { 'walletFunding.closed': true, 'walletFunding.total': 0, 'walletFunding.revision': Number(wf.revision || 0) + 1, 'walletFunding.updatedAt': new Date() } : {}),
      } }, { session: s });
    }

    if (slot) await releaseSlot(slot, s);
    if (parent) {
      await BookingModel.updateOne({ _id: parent, 'followUp.benefitUsed': true }, { $set: { 'followUp.benefitUsed': false } }, { session: s });
    }
    await BookingModel.updateOne({ _id: id, status: 'cancelled' },
      { $set: { holds: { version: 1, heldSlotId: null, followUpParentId: null } } }, { session: s });
    const after = await BookingModel.findById(id).session(s).lean() as IBooking;
    if (p.inTx) await p.inTx(after, s, refunded);
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

    // Serialize with capture exactly like a cancellation, then decide on what is now committed. Phase 1b: an assisted card
    // booking's payment record has the context `assisted_booking`; a capture recorded but not yet applied leaves the
    // booking to the payment handler (it confirms it, or returns the capture), exactly as for customers.
    const context = booking.assisted ? 'assisted_booking' : 'booking';
    await PaymentRecordModel.collection.updateMany({ context, contextId: id, status: { $nin: ['paid', 'refunded'] } },
      { $set: { updatedAt: new Date() } }, { session: s });
    const records = await PaymentRecordModel.find({ context, contextId: id }).session(s).lean() as unknown as PaymentRow[];
    if (records.some(r => r.status === 'paid') || (booking.walletFunding?.captures ?? []).some(c => c.state === 'applied')) {
      return { expired: false, reason: 'paid' };
    }
    if (booking.assisted && booking.assisted.funding?.state !== 'pending') return { expired: false, reason: 'not_pending' };

    const slot = await heldSlot(booking, s);
    const parent = await heldFollowUpParent(booking, s);
    const cancelled = await BookingModel.updateOne({ _id: id, status: 'pending', paymentStatus: 'pending' },
      { $set: { status: 'cancelled', paymentStatus: 'refunded', cancellationReason: 'Payment was not completed in time',
        cancellationCause: 'payment_timeout', cancelledAt: p.cancelledAt, lifecycle: p.lifecycle(booking) },
        $unset: { expiryNextAt: 1, expiryChecks: 1 } }, { session: s });
    if (cancelled.modifiedCount !== 1) throw changed();
    await releaseInterval('scheduled', id, s);
    let refunded = 0;
    if (booking.assisted?.funding) {
      // Phase 1b: an unpaid assisted card booking — the coupon redemption is reversed, the funding ends `not_paid`, the
      // join link dies; nothing was taken, so nothing is refunded (a capture landing later is a late capture).
      await settleAssistedFundingIn(booking, { cause: 'payment_timeout', keepMoney: false }, s);
      // r10b: an unpaid card booking left to expire counts as a cancellation by its booker (P7 daily limit).
      await countBookerCancellationIn(booking.assisted.bookedBy.kind, String(booking.assisted.bookedBy.id).toLowerCase(), s);
    } else {
      await undoCouponUsageIn(records.map(r => String(r._id)), s);
      refunded = await settleMoney(booking, id, records, p.wallets, s);
    }
    if (slot) await releaseSlot(slot, s);
    if (parent) {
      await BookingModel.updateOne({ _id: parent, 'followUp.benefitUsed': true }, { $set: { 'followUp.benefitUsed': false } }, { session: s });
    }
    await BookingModel.updateOne({ _id: id, status: 'cancelled' },
      { $set: { holds: { version: 1, heldSlotId: null, followUpParentId: null } } }, { session: s });
    return { expired: true, booking: await BookingModel.findById(id).session(s).lean() as IBooking, refunded };
  });
}

/** Q14: the content of a no-show reschedule request (its target slot). */
export const noShowRescheduleHash = (slotId: string) => createHash('sha256').update(JSON.stringify({ slotId: String(slotId).toLowerCase() })).digest('hex');

/** Q14: the no-show reschedule command's identity and admission (see rescheduleWithHolds). */
export interface NoShowReschedule {
  owner: Record<string, unknown>; by: string; byKind: 'specialist' | 'clinic' | 'admin';
  keyScope: string; requestKey: string; requestHash: string; startedClock: () => Date;
}

/**
 * Moves the booking's slot hold to `nextSlotId` and writes the new appointment, atomically (milestone C3). The
 * appointment time is always the target slot's start time.
 */
export async function rescheduleWithHolds(p: {
  bookingId: string; requester: { _id: string; userType: string }; nextSlotId: string; patch: Record<string, unknown>;
  /** Q6: set only by the clinic desk command; the target slot is admitted against it inside the transaction. */
  desk?: DeskScope;
  inTx?: (b: IBooking, s: ClientSession) => Promise<void>;
  /** Q13: the booking version (updatedAt) the caller decided on, checked on the booking as read in the transaction. */
  expectedUpdatedAt?: Date | string | null;
  /**
   * Q16a: refuse the move once the CURRENT appointment has started (the clock is read in the transaction), as a
   * cancellation is refused — set for customers, so a missed appointment cannot be moved away from its no-show (and
   * then cancelled for a refund). Admins, the clinic desk (nothing paid through us; re-review N4) and no-show moves do
   * not set it.
   */
  refuseStartedSource?: () => Date;
  /**
   * Q16a: a customer move. It keeps the appointment as it was before the FIRST such move (`originalAppointment`,
   * history only) and — when the move happens AFTER the pre-move appointment's refund deadline (clock read in the
   * transaction) — locks that closed window (`refundLock`, the first one kept), so the move can never reopen it. Not for
   * desk appointments (not paid through us) nor no-show moves.
   */
  recordOriginalAppointment?: boolean;
  /**
   * Q14: move a no-show back to confirmed on a later slot, once (same price, no payment, no refund). The caller has
   * already admitted the requester (doctor, clinic desk or admin); `owner` narrows the booking read in the transaction.
   */
  noShow?: NoShowReschedule;
  /** Assisted booking phase 1a (P9): the booker's own command (its assisted bookings only). 2e: a lab too. */
  assistedBooker?: 'pharmacy' | 'lab';
}): Promise<IBooking> {
  if (!Types.ObjectId.isValid(p.bookingId)) throw conflict('BOOKING_NOT_FOUND', 'Booking not found', 404);
  const id = String(p.bookingId).toLowerCase();
  return runLedgerTransaction(async s => {
    const owner = p.noShow ? p.noShow.owner : p.requester.userType === 'admin' ? {}
      // Assisted booking phase 1a (P9): a booker moves only the assisted bookings it made.
      : p.assistedBooker ? assistedBookerFilter(p.assistedBooker, p.requester._id)
      : { userId: { $eq: p.requester._id } };
    const booking = await BookingModel.findOne({ _id: id, ...owner }).session(s).lean() as IBooking | null;
    if (!booking) throw conflict('BOOKING_NOT_FOUND', 'Booking not found', 404);
    // Q4b: an instant consultation holds no slot and its own interval; it is never moved onto a scheduled slot.
    if (booking.bookingKind === 'instant') throw conflict('INSTANT_CONSULT_COMMAND_REQUIRED', 'An instant consultation cannot be rescheduled');
    // Q6: a clinic desk appointment moves only to another slot of the same clinic, by that clinic (p.desk, admitted inside).
    if (booking.clinicDesk && booking.clinicDesk.partnerId !== p.desk?.partnerId) {
      throw conflict('CLINIC_APPOINTMENT', 'Ask the clinic to change this appointment');
    }
    // Q6: the source appointment must still be at one of the desk's branches as read now (another desk may have moved it).
    if (booking.clinicDesk && p.desk && !deskBookingInScope(booking, p.desk)) throw conflict('BOOKING_NOT_FOUND', 'Booking not found', 404);
    // Q14: a replay of the no-show reschedule made with this key answers with the booking (same request only).
    const priorMove = p.noShow ? (booking.noShows ?? []).find(n => n.requestKey === p.noShow!.requestKey) : undefined;
    if (priorMove) {
      if (priorMove.requestHash !== p.noShow!.requestHash) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different reschedule');
      return Object.assign(booking, { [REPLAYED]: true });
    }
    if (p.noShow) {
      if ((booking.noShowReschedules ?? 0) >= 1 || (booking.noShows?.length ?? 0) >= 1) {
        throw conflict('NO_SHOW_RESCHEDULE_USED', 'This booking was already rescheduled once after a no-show; a second no-show is final');
      }
      if (booking.status !== 'no_show') throw conflict('BOOKING_NOT_NO_SHOW', `A ${booking.status} booking is not a no-show`);
    } else if (!CANCELLABLE_BOOKING_STATUSES.includes(String(booking.status))) {
      throw conflict('BOOKING_NOT_RESCHEDULABLE', `A ${booking.status} booking cannot be rescheduled`);
    }
    if (!p.noShow && p.refuseStartedSource) {
      const start = appointmentStartOf(booking);
      if (!start || start.getTime() <= p.refuseStartedSource().getTime()) {
        throw conflict('BOOKING_ALREADY_STARTED', 'This appointment has already started; it can no longer be moved', 400);
      }
    }
    assertBookingVersion(booking, p.expectedUpdatedAt);
    if (p.noShow) await claimRequestKey(p.noShow.keyScope, p.noShow.requestKey, s);
    const current = await heldSlot(booking, s);
    const target = canon(p.nextSlotId);
    if (!target) throw conflict('SLOT_NOT_AVAILABLE', 'Slot is not available');
    // r7: an assisted booker's move onto the slot the booking holds (as this transaction reads it: also when a
    // concurrent move just put it there) changes nothing and is refused, after the status and start checks above.
    if ((p.noShow || p.assistedBooker) && target === current) {
      throw conflict('SAME_SLOT', p.noShow ? 'Pick a later slot' : 'The booking is already on this slot; pick another one');
    }
    // Q15: every move (ordinary, desk, no-show) stays with the booking's doctor, decided on the stored booking and the
    // target slot as this transaction reads them. (The slot-time match in reserveSlot also refused another doctor's
    // slot, but only as SLOT_NOT_AVAILABLE.) Mode and in-clinic admission follow in reserveSlot, as for every booking.
    if (booking.specialistId) {
      const t = await SlotModel.findById(target).select({ specialistId: 1 }).session(s).lean() as { specialistId?: unknown } | null;
      if (t && String(t.specialistId ?? '').toLowerCase() !== String(booking.specialistId).toLowerCase()) {
        throw conflict('SLOT_NOT_THIS_DOCTOR', 'This slot belongs to another doctor; pick one of this doctor\'s slots');
      }
    }
    const next = { ...booking, ...p.patch } as IBooking;
    let bookingTime: string;
    // Q6: the clinic association follows the admitted target; a desk appointment that moves is no longer checked in.
    let clinicSet: Record<string, unknown> = {};
    let clinicUnset: Record<string, 1> = {};
    if (current !== target) {
      const reserved = await reserveSlot(target, next, s, booking.clinicDesk ? p.desk : undefined, p.noShow?.startedClock);
      bookingTime = reserved.time;
      if (reserved.clinic) {
        clinicSet = { clinicVisit: reserved.clinic,
          ...(booking.clinicDesk ? { 'clinicDesk.branchId': reserved.clinic.branchId, 'clinicDesk.arrivedAt': null } : {}) };
      } else {
        clinicUnset = { clinicVisit: 1 };
      }
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
      // A mode change on the same slot is admitted like a new booking's mode.
      if (next.consultationMode !== booking.consultationMode) assertSlotMode(slot as SlotRow, next);
    }
    const holds: Holds = { version: 1, heldSlotId: target, followUpParentId: await heldFollowUpParent(booking, s) };
    // Q14: back to confirmed; the no-show is kept in the booking's history.
    const noShowSet = p.noShow ? { status: 'confirmed', noShowReschedules: (booking.noShowReschedules ?? 0) + 1 } : {};
    const noShowPush = p.noShow ? { $push: { noShows: {
      at: booking.noShow?.at, by: booking.noShow?.by, byKind: booking.noShow?.byKind,
      rescheduledAt: p.noShow.startedClock(), rescheduledBy: p.noShow.by, rescheduledByKind: p.noShow.byKind,
      fromSlotId: current ?? undefined, fromDate: booking.bookingDate, fromTime: booking.bookingTime, toSlotId: target,
      requestKey: p.noShow.requestKey, requestHash: p.noShow.requestHash } } } : {};
    const unset = { ...clinicUnset, ...(p.noShow ? { noShow: 1 as const } : {}) };
    const customerMove = !!p.recordOriginalAppointment && !p.noShow && !booking.clinicDesk;
    const before = { bookingDate: booking.bookingDate, bookingTime: booking.bookingTime };
    const deadline = customerMove && !booking.refundLock ? refundDeadlineOf(before) : null;
    const movedAt = (p.refuseStartedSource ?? (() => new Date()))();
    const originalSet = {
      ...(customerMove && !booking.originalAppointment ? { originalAppointment: before } : {}),
      ...(deadline && movedAt.getTime() >= deadline.getTime() ? { refundLock: { ...before, movedAt } } : {}),
    };
    const updated = await BookingModel.findOneAndUpdate({ _id: id, status: booking.status },
      { $set: { ...p.patch, bookingTime, slotId: target, holds, ...clinicSet, ...noShowSet, ...originalSet }, ...noShowPush, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { new: true, session: s }).lean() as IBooking | null;
    if (!updated) throw changed();
    // Q16a (E): a no-show moved back to confirmed counts again in its original legacy month.
    if (p.noShow) await flagLegacyOriginalMonth(updated, s);
    if (p.inTx) await p.inTx(updated, s);
    return updated;
  });
}
