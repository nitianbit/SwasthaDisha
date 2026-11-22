import { Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { requestHashOf } from '@/modules/common/utils/canonicalJson';
import { canonicalMobile } from '@/modules/common/utils/phone';
import { istTodayYyyymmdd } from '@/modules/common/utils/istDate';
import { bookableUntilOf, slotIntervalOf } from '@/modules/common/utils/slotInterval';
import { buildBookingLifecyclePatch } from '@/modules/bookings/utils/lifecycle';
import { parseAppointment } from '@/modules/common/utils/cancellationWindow';
import BookingModel from '@/modules/bookings/model';
import type { IBooking } from '@/modules/bookings/types';
import { cancelBookingSettlement, isReplayedBooking, rescheduleWithHolds } from '@/modules/bookings/holds';
import SlotModel from '@/modules/slots/model';
import SpecialistModel from '@/modules/specialists/model';
import { isEligibleDoctor } from '@/modules/specialists/eligibility';
import { DoctorScheduleTemplateModel } from '@/modules/doctors/model/schedule';
import { branchHolidays, clinicBranchContext } from '@/modules/doctors/services/schedule';
import UserModel from '@/modules/user/model';
import PharmacyModel from '@/modules/pharmacies/model';
import { WalletRepository } from '@/modules/wallet/repository';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { abandonRequestKey, claimRequestKey } from '@/modules/requestKeys';
import { bookerView } from '@/modules/assisted/bookerView';
import { maskName } from '@/modules/assisted/names';
import { assertPharmacyAssistedOn } from '@/modules/assisted/flags';
import { countBookerCancellationIn, hitLookup } from '@/modules/assisted/limits';
import { assistedBookerFilter } from '@/modules/assisted/refunds';
import { ASSISTED_KEY, asDoctorUnavailable, assistedKeyScope, storedAssistedKey, type PharmacyActor } from '@/modules/assisted/consultations';
import { assistedEffects, auditIn, bestEffort, sendAssistedNotices, type AssistedNotice } from '@/modules/assisted/support';

/**
 * Assisted booking phase 1a, pharmacy commands besides the create (§6.2, §7.1, §8.7, P7, P9, §17.6): the masked lookup,
 * the nearby doctor list, the booker's cancel (any time before the start, full refund to its wallet) and reschedule
 * (same doctor and price, before the start), and the by-key lookup / abandon of a create (Q13 pattern).
 */
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const notFound = () => err(404, 'BOOKING_NOT_FOUND', 'Booking not found');
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const orgKey = (pharmacyId: string) => `pharmacy:${lower(pharmacyId)}`;

/** POST /pharmacy-assisted/patients/lookup — `{ exists, holderNameMasked }` only; limited and audited. */
export async function lookupPatient(actor: PharmacyActor, rawPhone: unknown) {
  assertPharmacyAssistedOn();
  const phone = canonicalMobile(rawPhone);
  if (!phone) throw err(400, 'INVALID_PHONE', 'Enter a valid 10-digit mobile number');
  await hitLookup(orgKey(actor.pharmacyId));
  const user = await UserModel.findOne({ phone, userType: 'user' }).select({ name: 1 }).lean() as { _id: unknown; name?: string } | null;
  await auditIn({ actorKind: 'pharmacy', actorId: lower(actor.actorId), orgKind: 'pharmacy', orgId: lower(actor.pharmacyId), action: 'patient.lookup',
    detail: { exists: !!user, ...(user ? { userId: String(user._id) } : {}) } }, null);
  return { exists: !!user, holderNameMasked: user ? maskName(user.name) : null };
}

export interface DoctorQuery { speciality?: string; mode?: 'video' | 'call' | 'in-person'; language?: string; date?: string; limit?: number }
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ymd = (iso: string) => iso.replace(/-/g, '');

type SlotRow = Record<string, any>;
type OpenSlot = { s: SlotRow; start: Date };
/**
 * The consultation modes an assisted booking can take (the create accepts only these; `chat` is not one of them). A slot
 * with no modes listed is offered in every mode.
 */
export const ASSISTED_MODES = ['video', 'call', 'in-person'] as const;
/** r6: the slot's modes an assisted booking can use (empty: the pharmacy cannot book this slot). */
export const assistedModesOf = (x: SlotRow): string[] =>
  (x.serviceModes?.length ? ASSISTED_MODES.filter((m) => x.serviceModes.includes(m)) : [...ASSISTED_MODES]);
/** The slot shape both doctor reads answer. */
const slotView = (x: OpenSlot) => ({ slotId: String(x.s._id), date: x.s.date, startTime: x.s.startTime, endTime: x.s.endTime,
  startsAt: x.start, modes: assistedModesOf(x.s) });
const feeMinorOf = (d: Record<string, any>) => (d.isConsultationFree === true ? 0 : Math.round(Number(d.consultationFee || 0) * 100));
const DOCTOR_FIELDS = { name: 1, specialization: 1, languages: 1, city: 1, pincode: 1, consultationFee: 1, isConsultationFree: 1, experienceYears: 1 };

/**
 * The bookable slots of these doctors from `fromYmd` (never before today) up to `toYmd` (inclusive, when given): active,
 * available, not full, bookable at `now`, offered in at least one assisted mode (r6: never a chat-only slot) and in the
 * asked mode, not on the doctor's leave day, and (in clinic) at an open branch where the doctor still consults
 * (reserveSlot refuses all of those). Earliest first, grouped by doctor id (lower case).
 */
async function openSlotsByDoctor(doctorIds: string[], fromYmd: string, toYmd: string | null, mode: DoctorQuery['mode'], now: Date)
  : Promise<Map<string, OpenSlot[]>> {
  const today = istTodayYyyymmdd(now);
  const from = fromYmd < today ? today : fromYmd;
  const byDoctor = new Map<string, OpenSlot[]>();
  if (!doctorIds.length || (toYmd && toYmd < from)) return byDoctor;
  const [slots, templates] = await Promise.all([
    SlotModel.find({ specialistId: { $in: doctorIds }, date: { $gte: from, ...(toYmd ? { $lte: toYmd } : {}) },
      isActive: true, isAvailable: true, $expr: { $lt: [{ $ifNull: ['$currentBookings', 0] }, { $ifNull: ['$maxBookings', 1] }] },
      // r6: slots the pharmacy could not book (chat only, or not in the asked mode) never take the 5000-row budget.
      $or: [{ 'serviceModes.0': { $exists: false } }, { serviceModes: { $in: mode ? [mode] : [...ASSISTED_MODES] } }] })
      .sort({ date: 1 }).limit(5000).lean().exec() as unknown as Promise<SlotRow[]>,
    DoctorScheduleTemplateModel.find({ doctorId: { $in: doctorIds }, 'leaveDates.0': { $exists: true } }).select({ doctorId: 1, leaveDates: 1 }).lean(),
  ]);
  const leave = new Set(templates.flatMap((t) => (t.leaveDates ?? []).map((d) => `${lower(t.doctorId)}|${d}`)));
  const modeOk = (x: SlotRow) => { const modes = assistedModesOf(x); return modes.length > 0 && (!mode || modes.includes(mode)); };
  const candidates = slots.filter((x) => modeOk(x) && !leave.has(`${lower(x.specialistId)}|${x.date}`)
    && (bookableUntilOf(x)?.getTime() ?? 0) > now.getTime() && !!slotIntervalOf(x));
  // r6: an in-clinic slot is bookable only while its branch is open that day and the doctor still consults there
  // (reserveSlot refuses both), so neither is offered (closes the §20.5 branch gap). One check per doctor and branch.
  const branchIds = [...new Set(candidates.map((x) => x.branchId).filter(Boolean).map(String))];
  const holidays = await branchHolidays(branchIds);
  const pairs = [...new Set(candidates.filter((x) => x.branchId).map((x) => `${lower(x.specialistId)}|${String(x.branchId)}`))];
  const consults = new Map(await Promise.all(pairs.map(async (k) => {
    const [doctorId, branchId] = k.split('|') as [string, string];
    return [k, !!(await clinicBranchContext(doctorId, branchId))] as const;
  })));
  const branchOk = (x: SlotRow) => !x.branchId || (!holidays.get(String(x.branchId))?.has(String(x.date))
    && consults.get(`${lower(x.specialistId)}|${String(x.branchId)}`) === true);
  const open = candidates.filter(branchOk)
    .map((x) => ({ s: x, start: slotIntervalOf(x)!.start })).sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const x of open) {
    const k = lower(x.s.specialistId);
    if (!byDoctor.has(k)) byDoctor.set(k, []);
    byDoctor.get(k)!.push(x);
  }
  return byDoctor;
}

/**
 * GET /pharmacy-assisted/doctors — any active, verified doctor (decision 9; S5 `isEligibleDoctor`), nearby first: the
 * pharmacy's pincode, then its city; then the requested language, the fee and the next free slot. With `date`, that
 * day's bookable slots.
 */
export async function listDoctors(actor: PharmacyActor, q: DoctorQuery, now: Date = new Date()) {
  assertPharmacyAssistedOn();
  const pharmacy = await PharmacyModel.findById(actor.pharmacyId).select({ city: 1, pincode: 1 }).lean() as { city?: string; pincode?: string } | null;
  const filter: Record<string, unknown> = { isActive: true, isVerified: true };
  if (q.speciality) filter.specialization = { $regex: `^${escapeRx(q.speciality.trim())}$`, $options: 'i' };
  if (q.language) filter.languages = { $regex: `^${escapeRx(q.language.trim())}$`, $options: 'i' };
  const doctors = await SpecialistModel.find(filter).select(DOCTOR_FIELDS).limit(300).lean() as Record<string, any>[];
  if (!doctors.length) return [];
  const byDoctor = await openSlotsByDoctor(doctors.map((d) => String(d._id)), q.date ? ymd(q.date) : istTodayYyyymmdd(now), null, q.mode, now);
  const same = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  const rows = doctors.map((d) => {
    const mine = byDoctor.get(lower(d._id)) ?? [];
    const nearby = same(d.pincode, pharmacy?.pincode) ? 'pincode' : same(d.city, pharmacy?.city) ? 'city' : null;
    const speaks = !!q.language && (d.languages ?? []).some((l: string) => same(l, q.language));
    const feeMinor = feeMinorOf(d);
    return {
      doctorId: String(d._id), name: d.name, specialization: d.specialization, languages: d.languages ?? [], city: d.city ?? null,
      experienceYears: d.experienceYears ?? null, feeMinor, nearby,
      nextSlot: mine[0] ? slotView(mine[0]) : null,
      ...(q.date ? { slots: mine.filter((x) => x.s.date === ymd(q.date!)).map(slotView) } : {}),
      _rank: [nearby === 'pincode' ? 0 : nearby === 'city' ? 1 : 2, speaks ? 0 : 1, feeMinor, mine[0]?.start.getTime() ?? Number.MAX_SAFE_INTEGER],
    };
  });
  rows.sort((a, b) => {
    for (let i = 0; i < a._rank.length; i++) if (a._rank[i] !== b._rank[i]) return a._rank[i]! - b._rank[i]!;
    return a.name < b.name ? -1 : 1;
  });
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);
  return rows.slice(0, limit).map(({ _rank: _r, ...row }) => row);
}

export interface DoctorSlotsQuery { from?: string; days?: number; mode?: DoctorQuery['mode'] }
const addDaysYmd = (d: string, n: number) => {
  const t = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)) + n));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
};

/**
 * Stage build: GET /pharmacy-assisted/doctors/:doctorId/slots?from&days&mode — one doctor's bookable slots over
 * `days` days (default 7, at most 14) from `from` (default today), for the booking and reschedule screens. Only an
 * active, verified doctor (S5); any other id, missing or not eligible, is the same 404 DOCTOR_NOT_FOUND.
 */
export async function listDoctorSlots(_actor: PharmacyActor, doctorId: string, q: DoctorSlotsQuery, now: Date = new Date()) {
  assertPharmacyAssistedOn();
  const notFound = () => err(404, 'DOCTOR_NOT_FOUND', 'Doctor not found');
  if (typeof doctorId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(doctorId)) throw notFound();
  const d = await SpecialistModel.findById(doctorId).select({ ...DOCTOR_FIELDS, isActive: 1, isVerified: 1 }).lean() as Record<string, any> | null;
  if (!isEligibleDoctor(d)) throw notFound();
  const today = istTodayYyyymmdd(now);
  const from = q.from && ymd(q.from) > today ? ymd(q.from) : today;
  const days = Math.min(Math.max(Number(q.days) || 7, 1), 14);
  const byDoctor = await openSlotsByDoctor([String(d!._id)], from, addDaysYmd(from, days - 1), q.mode, now);
  return {
    doctor: { doctorId: String(d!._id), name: d!.name, specialization: d!.specialization, languages: d!.languages ?? [], city: d!.city ?? null,
      experienceYears: d!.experienceYears ?? null, feeMinor: feeMinorOf(d!) },
    from, to: addDaysYmd(from, days - 1),
    slots: (byDoctor.get(lower(d!._id)) ?? []).map(slotView),
  };
}

async function ownAssisted(actor: PharmacyActor, bookingId: unknown): Promise<IBooking> {
  if (typeof bookingId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(bookingId)) throw notFound();
  const b = await BookingModel.findOne({ _id: bookingId, ...assistedBookerFilter('pharmacy', actor.pharmacyId) }).lean() as IBooking | null;
  if (!b) throw notFound();
  return b;
}

const shownDate = (d?: string) => (d && /^\d{8}$/.test(d) ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : String(d ?? ''));

/** After a cancellation of an assisted booking (any path): reminders, Meet, and who is told (§6.5, §8.7). */
export async function afterAssistedCancel(b: IBooking, by: 'booker' | 'patient' | 'doctor' | 'admin', refunded = true): Promise<IBooking> {
  if (!b.assisted) return b;
  const fx = assistedEffects();
  await bestEffort('reminders', () => fx.clearReminders(String(b._id)), undefined);
  const out = await bestEffort('meet', () => fx.cancelMeet(b, b.cancellationReason || 'Cancelled'), b);
  const id = String(b._id);
  const when = `${shownDate(b.bookingDate)} at ${b.bookingTime}`;
  const a = b.assisted;
  const notices: AssistedNotice[] = [];
  if (by !== 'patient') {
    notices.push({ audience: 'customer', userId: String(b.userId), type: 'booking_cancelled', title: 'Consultation cancelled',
      message: `The consultation on ${when} (Ref ${a.shortRef}) was cancelled.${refunded ? ` ${a.bookedBy.name} has been refunded.` : ''}`, bookingId: id,
      key: `assisted:${id}:cancelled:customer` });
  }
  if (by !== 'booker') {
    // "Cancelled by patient" badge (§6.5): the partner is told; no health details.
    notices.push({ audience: 'booker', userId: a.bookedBy.id, type: 'booking_cancelled', title: by === 'patient' ? 'Cancelled by the patient' : 'Booking cancelled',
      message: `Booking Ref ${a.shortRef} on ${when} was cancelled${by === 'patient' ? ' by the patient' : ''}.${refunded ? ' The amount is back in your Jansetu wallet.' : ''}`,
      bookingId: id, key: `assisted:${id}:cancelled:booker`, data: { cause: by } });
  }
  if (by !== 'doctor' && b.specialistId) {
    notices.push({ audience: 'doctor', userId: String(b.specialistId), type: 'specialist_appointment_cancelled', title: 'Consultation cancelled',
      message: `A consultation on ${when} was cancelled.`, bookingId: id, key: `assisted:${id}:cancelled:doctor` });
  }
  await sendAssistedNotices(notices);
  return out;
}

/** POST /pharmacy-assisted/bookings/:id/cancel — any time before the start (§8.7); full refund to the wallet; P7 count. */
export async function cancelByBooker(actor: PharmacyActor, bookingId: string, input: { reason?: string; expectedUpdatedAt?: string | Date },
  clock: () => Date = () => new Date()) {
  await ownAssisted(actor, bookingId);
  const reason = String(input.reason ?? '').trim() || 'Cancelled by the booking partner';
  const r = await cancelBookingSettlement({
    bookingId, requester: { _id: lower(actor.pharmacyId), userType: 'pharmacy' }, assistedBooker: 'pharmacy', reason, cause: 'booker', cancelledAt: istTodayYyyymmdd(clock()),
    wallets: new WalletRepository(), expectedUpdatedAt: input.expectedUpdatedAt ?? null,
    enforceWindow: (b) => {
      const start = parseAppointment({ bookingDate: String(b.bookingDate ?? ''), bookingTime: String(b.bookingTime ?? '') })?.at;
      if (!start || start.getTime() <= clock().getTime()) throw err(400, 'BOOKING_ALREADY_STARTED', 'The consultation has already started; it can no longer be cancelled');
    },
    lifecycle: (b) => buildBookingLifecyclePatch(b.lifecycle, { cancelled: { reason }, refunded: { reason } }),
    inTx: async (b, s) => {
      await countBookerCancellationIn('pharmacy', lower(actor.pharmacyId), s);
      await auditIn({ actorKind: 'pharmacy', actorId: lower(actor.actorId), orgKind: 'pharmacy', orgId: lower(actor.pharmacyId), action: 'booking.cancelled',
        bookingId: String(b._id), detail: { reason, cause: 'booker' } }, s);
    },
  });
  const booking = r.alreadyCancelled ? r.booking : await afterAssistedCancel(r.booking, 'booker');
  return { booking: await bookerView(booking as never, lower(actor.pharmacyId)), refundedMinor: Math.round(r.refunded * 100), alreadyCancelled: r.alreadyCancelled };
}

/** POST /pharmacy-assisted/bookings/:id/reschedule — P9: same doctor and price, before the start, once per request key. */
export async function rescheduleByBooker(actor: PharmacyActor, bookingId: string, input: { slotId: string; requestKey: string; expectedUpdatedAt?: string | Date },
  clock: () => Date = () => new Date()) {
  if (!ASSISTED_KEY.test(String(input.requestKey ?? ''))) throw err(400, 'REQUEST_KEY_REQUIRED', 'requestKey is required');
  const b = await ownAssisted(actor, bookingId);
  const hash = requestHashOf({ slotId: lower(input.slotId) });
  const replay = (x: IBooking) => {
    const prior = (x.assisted?.reschedules ?? []).find((r) => r.requestKey === input.requestKey);
    if (!prior) return null;
    if (prior.requestHash !== hash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different move');
    return x;
  };
  const prior = replay(b);
  if (prior) return { booking: await bookerView(prior as never, lower(actor.pharmacyId)), replayed: true };
  if (!Types.ObjectId.isValid(input.slotId)) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  // r6: a "move" onto the slot the booking already holds changes nothing; it is refused rather than told to the patient
  // and the doctor as a move.
  if (lower(input.slotId) === lower(b.holds?.heldSlotId ?? b.slotId)) throw err(409, 'SAME_SLOT', 'The booking is already on this slot; pick another one');
  const slot = await SlotModel.findById(input.slotId).select({ date: 1 }).lean() as { date?: string } | null;
  if (!slot?.date) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  let updated: IBooking;
  try {
    updated = await rescheduleWithHolds({
      bookingId, requester: { _id: lower(actor.pharmacyId), userType: 'pharmacy' }, assistedBooker: 'pharmacy', nextSlotId: String(input.slotId),
      patch: { bookingDate: slot.date, lifecycle: buildBookingLifecyclePatch(b.lifecycle, { rescheduled: true }) ?? b.lifecycle },
      expectedUpdatedAt: input.expectedUpdatedAt ?? null, refuseStartedSource: clock,
      inTx: async (x, s) => {
        await claimRequestKey(`assisted_reschedule:${lower(actor.pharmacyId)}:${lower(bookingId)}`, input.requestKey, s);
        await BookingModel.updateOne({ _id: x._id }, { $push: { 'assisted.reschedules': { requestKey: input.requestKey, requestHash: hash, at: clock(),
          fromSlotId: b.slotId, toSlotId: lower(input.slotId), by: lower(actor.actorId) } } }, { session: s });
        await auditIn({ actorKind: 'pharmacy', actorId: lower(actor.actorId), orgKind: 'pharmacy', orgId: lower(actor.pharmacyId), action: 'booking.rescheduled',
          bookingId: String(x._id), requestKey: input.requestKey, detail: { fromSlotId: b.slotId, toSlotId: lower(input.slotId) } }, s);
      },
    });
  } catch (e) {
    const raced = await BookingModel.findById(bookingId).lean() as IBooking | null;
    const again = raced ? replay(raced) : null;
    if (!again) throw asDoctorUnavailable(e);
    return { booking: await bookerView(again as never, lower(actor.pharmacyId)), replayed: true };
  }
  if (isReplayedBooking(updated)) return { booking: await bookerView(updated as never, lower(actor.pharmacyId)), replayed: true };
  const fx = assistedEffects();
  // A move keeps the join link (§6.6): only the Meet event and reminders follow the new slot.
  const withMeet = updated.consultationMode === 'in-person' ? updated : await bestEffort('meet', () => fx.meet(updated), updated);
  await bestEffort('reminders', () => fx.reminders(withMeet), undefined);
  const id = String(updated._id);
  const when = `${shownDate(updated.bookingDate)} at ${updated.bookingTime}`;
  const v = new Date(updated.updatedAt ?? Date.now()).getTime();
  await sendAssistedNotices([
    { audience: 'customer', userId: String(updated.userId), type: 'general', title: 'Consultation moved',
      message: `Your consultation (Ref ${updated.assisted!.shortRef}) is now on ${when}.`, bookingId: id, key: `assisted:${id}:moved:${v}:customer` },
    ...(updated.specialistId ? [{ audience: 'doctor' as const, userId: String(updated.specialistId), type: 'specialist_general' as const,
      title: 'Consultation moved', message: `A consultation with you was moved to ${when}.`, bookingId: id, key: `assisted:${id}:moved:${v}:doctor` }] : []),
  ]);
  const fresh = await BookingModel.findById(id).lean() as IBooking;
  return { booking: await bookerView(fresh as never, lower(actor.pharmacyId)), replayed: false };
}

/** GET /pharmacy-assisted/bookings/by-key/:key — 'used' (with the booking), 'abandoned' or 'unknown' (Q9/Q13). */
export async function findByKey(actor: PharmacyActor, key: string) {
  if (!ASSISTED_KEY.test(String(key ?? ''))) throw err(400, 'VALIDATION_ERROR', 'A valid key is required');
  const b = await BookingModel.findOne({ 'assisted.requestKey': { $eq: storedAssistedKey(actor, key) } }).lean() as IBooking | null;
  if (b) return { state: 'used' as const, booking: await bookerView(b as never, lower(actor.pharmacyId)) };
  const row = await RequestKeyModel.findOne({ scope: assistedKeyScope(actor), key }).lean();
  return { state: row?.state === 'abandoned' ? 'abandoned' as const : 'unknown' as const };
}

/** POST /pharmacy-assisted/bookings/by-key/:key/abandon — abandoned (it can never be booked) or used (here it is). */
export async function abandonByKey(actor: PharmacyActor, key: string) {
  if (!ASSISTED_KEY.test(String(key ?? ''))) throw err(400, 'VALIDATION_ERROR', 'A valid key is required');
  const made = await BookingModel.exists({ 'assisted.requestKey': { $eq: storedAssistedKey(actor, key) } });
  if (made) return findByKey(actor, key);
  const state = await abandonRequestKey(assistedKeyScope(actor), key);
  return state === 'abandoned' ? { state } : findByKey(actor, key);
}
