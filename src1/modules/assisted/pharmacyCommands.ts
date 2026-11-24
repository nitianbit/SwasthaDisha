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
import { clinicBranchAdmission, DOCTOR_ROLLING_DAYS } from '@/modules/doctors/services/schedule';
import { WalletRepository } from '@/modules/wallet/repository';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { abandonRequestKey, claimRequestKey } from '@/modules/requestKeys';
import { bookerView } from '@/modules/assisted/bookerView';
import { maskName } from '@/modules/assisted/names';
import { countBookerCancellationIn } from '@/modules/assisted/limits';
import { countPhoneUse } from '@/modules/assisted/patient';
import {
  admitLabBooker, asBooker, assertBookerOn, auditBookerIn, bookerActorIdOf, bookerBookingsFilter, bookerNoticeUserId, bookerOrigin, bookerRefOf, orgKeyOf,
  rescheduleKeyScope,
  type BookerActor,
} from '@/modules/assisted/bookers';
import { bookerMoneyLine, cancellationRowOf } from '@/modules/assisted/refunds';
import { ASSISTED_KEY, asDoctorUnavailable, assistedKeyScope, storedAssistedKey, type PharmacyActor } from '@/modules/assisted/consultations';
import { assistedEffects, bestEffort, sendAssistedNotices, type AssistedNotice } from '@/modules/assisted/support';
import { cancellationRefundOf, kickCardRefunds } from '@/modules/assisted/cardRefunds';
import { openCardOrder } from '@/modules/assisted/cardPayments';

/**
 * Assisted booking phase 1a, booker commands besides the create (§6.2, §7.1, §8.7, P7, P9, §17.6): the masked lookup,
 * the nearby doctor list, the booker's cancel (any time before the start, full refund to its wallet) and reschedule
 * (same doctor and price, before the start), and the by-key lookup / abandon of a create (Q13 pattern). 2e (§24.8): the
 * same commands for a lab booker (`BookerActor`); a pharmacy actor without `kind` (1a callers) is a pharmacy.
 */
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const notFound = () => err(404, 'BOOKING_NOT_FOUND', 'Booking not found');
const lower = (v: unknown) => String(v ?? '').toLowerCase();

/** POST …/patients/lookup — `{ exists, holderNameMasked }` only; the hourly lookup limit of the organisation; audited. */
export async function lookupPatient(actorIn: PharmacyActor | BookerActor, rawPhone: unknown) {
  const booker = asBooker(actorIn);
  assertBookerOn(booker.kind);
  const phone = canonicalMobile(rawPhone);
  if (!phone) throw err(400, 'INVALID_PHONE', 'Enter a valid 10-digit mobile number');
  // r21b: a lab is admitted (an active, verified lab; never a clinic) before the phone is counted or audited.
  if (booker.kind === 'lab') await admitLabBooker(booker);
  const user = await countPhoneUse(orgKeyOf(booker), phone, (seen) => auditBookerIn(booker, 'patient.lookup', { detail: seen }, null));
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

/** r7: the rows one shared slot read takes; a doctor it leaves unresolved is read on its own (walkFirstOpen). */
const SLOT_READ_CAP = 5000;
/** r7: one doctor's one day is read whole (a bound far above any real day, so the earliest time is never cut off). */
const DAY_READ_CAP = 20000;
/**
 * r8 B2: the next-slot walk covers at most this many calendar days (the doctor rolling window plus a margin; r8b L2: from
 * the shared read's cut-off day), and at most WALK_PARALLEL doctors are read at a time.
 */
const WALK_CALENDAR_DAYS = DOCTOR_ROLLING_DAYS + 7;
const WALK_PARALLEL = 8;

/** The stored slots an assisted booking might take (the rest of the rules are checked on each row: admitOpen). */
const candidateFilter = (mode: DoctorQuery['mode']) => ({
  isActive: true, isAvailable: true, $expr: { $lt: [{ $ifNull: ['$currentBookings', 0] }, { $ifNull: ['$maxBookings', 1] }] },
  // r6: slots the pharmacy could not book (chat only, or not in the asked mode) never take a read's row budget.
  $or: [{ 'serviceModes.0': { $exists: false } }, { serviceModes: { $in: mode ? [mode] : [...ASSISTED_MODES] } }],
});

/** What decides a slot beyond its own fields: the doctors' leave days and (r7, batched) their clinic branches. */
interface Admission { leave: Map<string, string[]>; clinic: (doctorId: string, branchId: string, date: string) => boolean }
async function admissionOf(doctorIds: string[]): Promise<Admission> {
  const [templates, clinic] = await Promise.all([
    DoctorScheduleTemplateModel.find({ doctorId: { $in: doctorIds }, 'leaveDates.0': { $exists: true } }).select({ doctorId: 1, leaveDates: 1 }).lean(),
    clinicBranchAdmission(doctorIds),
  ]);
  const leave = new Map<string, string[]>();
  for (const t of templates) leave.set(lower(t.doctorId), [...(leave.get(lower(t.doctorId)) ?? []), ...(t.leaveDates ?? []).map(String)]);
  return { leave, clinic };
}

/**
 * The rows a pharmacy can book now, earliest first: offered in at least one assisted mode (r6: never a chat-only slot)
 * and in the asked mode, bookable at `now`, not on the doctor's leave day, and (in clinic) at an open branch where the
 * doctor still consults (reserveSlot refuses all of those; r6 closed the §20.5 branch gap).
 */
function admitOpen(rows: SlotRow[], adm: Admission, mode: DoctorQuery['mode'], now: Date): OpenSlot[] {
  const modeOk = (x: SlotRow) => { const modes = assistedModesOf(x); return modes.length > 0 && (!mode || modes.includes(mode)); };
  return rows.filter((x) => modeOk(x) && !(adm.leave.get(lower(x.specialistId)) ?? []).includes(String(x.date))
    && (bookableUntilOf(x)?.getTime() ?? 0) > now.getTime() && !!slotIntervalOf(x)
    && (!x.branchId || adm.clinic(String(x.specialistId), String(x.branchId), String(x.date))))
    .map((x) => ({ s: x, start: slotIntervalOf(x)!.start })).sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * The bookable slots of these doctors from `fromYmd` (never before today) up to `toYmd` (inclusive, when given), earliest
 * first, grouped by doctor id (lower case), in one read of at most SLOT_READ_CAP rows (date order). `cutoff` is null
 * when the read took every row; otherwise only the days before `cutoff` are complete (r7).
 */
async function openSlotsByDoctor(doctorIds: string[], fromYmd: string, toYmd: string | null, mode: DoctorQuery['mode'], now: Date, adm: Admission)
  : Promise<{ byDoctor: Map<string, OpenSlot[]>; cutoff: string | null }> {
  const today = istTodayYyyymmdd(now);
  const from = fromYmd < today ? today : fromYmd;
  const byDoctor = new Map<string, OpenSlot[]>();
  if (!doctorIds.length || (toYmd && toYmd < from)) return { byDoctor, cutoff: null };
  const read = await SlotModel.find({ specialistId: { $in: doctorIds }, date: { $gte: from, ...(toYmd ? { $lte: toYmd } : {}) }, ...candidateFilter(mode) })
    .sort({ date: 1 }).limit(SLOT_READ_CAP + 1).lean().exec() as unknown as SlotRow[];
  const cutoff = read.length > SLOT_READ_CAP ? String(read[SLOT_READ_CAP - 1]!.date) : null;
  const rows = cutoff ? read.filter((x) => String(x.date) < cutoff) : read;
  for (const x of admitOpen(rows, adm, mode, now)) {
    const k = lower(x.s.specialistId);
    if (!byDoctor.has(k)) byDoctor.set(k, []);
    byDoctor.get(k)!.push(x);
  }
  return { byDoctor, cutoff };
}

/**
 * r7: one doctor's earliest bookable slot from `firstDay` (r8 B2: its first candidate day, from firstCandidateDays) up to
 * `last` (the walk's window end), skipping leave days. r8b M1: `firstDay` is read whole first (the usual answer); only
 * on a miss is the rest of the window read (slots index specialistId, date), and past DAY_READ_CAP rows day by day.
 */
async function walkFirstOpen(doctorId: string, firstDay: string, last: string, mode: DoctorQuery['mode'], now: Date, adm: Admission): Promise<OpenSlot | null> {
  const leave = adm.leave.get(lower(doctorId)) ?? [];
  const firstDayRows = await SlotModel.find({ specialistId: doctorId, date: firstDay, ...candidateFilter(mode) }).limit(DAY_READ_CAP).lean() as unknown as SlotRow[];
  const onFirstDay = admitOpen(firstDayRows, adm, mode, now)[0];
  if (onFirstDay) return onFirstDay;
  const from = addDaysYmd(firstDay, 1);
  if (from > last) return null;
  const read = await SlotModel.find({ specialistId: doctorId, date: { $gte: from, $lte: last, ...(leave.length ? { $nin: leave } : {}) },
    ...candidateFilter(mode) }).sort({ date: 1 }).limit(DAY_READ_CAP + 1).lean() as unknown as SlotRow[];
  const cut = read.length > DAY_READ_CAP ? String(read[DAY_READ_CAP - 1]!.date) : null;
  const first = admitOpen(cut ? read.filter((x) => String(x.date) < cut) : read, adm, mode, now)[0];
  if (first || !cut) return first ?? null;
  for (let date = cut; date <= last; date = addDaysYmd(date, 1)) {
    if (leave.includes(date)) continue;
    const day = await SlotModel.find({ specialistId: doctorId, date, ...candidateFilter(mode) }).limit(DAY_READ_CAP).lean() as unknown as SlotRow[];
    const open = admitOpen(day, adm, mode, now);
    if (open.length) return open[0]!;
  }
  return null;
}

/**
 * r8 B2: each doctor's first day holding a candidate slot from `fromYmd` to `toYmd` (r8b L2: the walk's window end), in
 * one aggregation (lower-case ids).
 */
async function firstCandidateDays(doctorIds: string[], fromYmd: string, toYmd: string, mode: DoctorQuery['mode']): Promise<Map<string, string>> {
  if (!doctorIds.length) return new Map();
  const rows = await SlotModel.aggregate([
    { $match: { specialistId: { $in: doctorIds }, date: { $gte: fromYmd, $lte: toYmd }, ...candidateFilter(mode) } },
    { $group: { _id: '$specialistId', first: { $min: '$date' } } },
  ]) as { _id: string; first: string }[];
  return new Map(rows.map((r) => [lower(r._id), String(r.first)]));
}

/** One day's bookable slots of these doctors; a day too large for one read is read doctor by doctor (r7). */
async function daySlotsByDoctor(doctorIds: string[], day: string, mode: DoctorQuery['mode'], now: Date, adm: Admission): Promise<Map<string, OpenSlot[]>> {
  const shared = await openSlotsByDoctor(doctorIds, day, day, mode, now, adm);
  if (!shared.cutoff) return shared.byDoctor;
  const out = new Map<string, OpenSlot[]>();
  // r8b L3: at most WALK_PARALLEL doctors at a time.
  await eachLimited(doctorIds, async (id) => {
    const rows = await SlotModel.find({ specialistId: id, date: day, ...candidateFilter(mode) }).limit(DAY_READ_CAP).lean() as unknown as SlotRow[];
    out.set(lower(id), admitOpen(rows, adm, mode, now));
  });
  return out;
}

/** r8 B2: runs `fn` over `items`, at most WALK_PARALLEL at a time. */
async function eachLimited<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(WALK_PARALLEL, queue.length) }, async () => {
    for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x);
  }));
}

/**
 * GET /pharmacy-assisted/doctors — any active, verified doctor (decision 9; S5 `isEligibleDoctor`), nearby first: the
 * pharmacy's pincode, then its city; then the requested language, the fee and the next free slot. With `date`, that
 * day's bookable slots.
 */
export async function listDoctors(actorIn: PharmacyActor | BookerActor, q: DoctorQuery, now: Date = new Date()) {
  const booker = asBooker(actorIn);
  assertBookerOn(booker.kind);
  // 2e: "nearby" is the pharmacy's address, or the lab member's branch.
  const pharmacy = await bookerOrigin(booker);
  const filter: Record<string, unknown> = { isActive: true, isVerified: true };
  if (q.speciality) filter.specialization = { $regex: `^${escapeRx(q.speciality.trim())}$`, $options: 'i' };
  if (q.language) filter.languages = { $regex: `^${escapeRx(q.language.trim())}$`, $options: 'i' };
  const doctors = await SpecialistModel.find(filter).select(DOCTOR_FIELDS).limit(300).lean() as Record<string, any>[];
  if (!doctors.length) return [];
  const ids = doctors.map((d) => String(d._id));
  const today = istTodayYyyymmdd(now);
  const day = q.date ? ymd(q.date) : null;
  const adm = await admissionOf(ids);
  const { byDoctor, cutoff } = await openSlotsByDoctor(ids, day && day > today ? day : today, null, q.mode, now, adm);
  // r7: nextSlot is each doctor's true earliest bookable slot. The shared read is complete before `cutoff`; a doctor
  // with nothing bookable there is read on its own from `cutoff` (only when the shared read was capped).
  // r8 B2: their first candidate days in one aggregation (none: nothing to read), then at most WALK_PARALLEL walks at a time.
  if (cutoff) {
    // r8b L2: one window end for the aggregation and every walk.
    const last = addDaysYmd(cutoff, WALK_CALENDAR_DAYS - 1);
    const pending = ids.filter((id) => !byDoctor.get(lower(id))?.length);
    const firstDays = await firstCandidateDays(pending, cutoff, last, q.mode);
    await eachLimited(pending.filter((id) => firstDays.has(lower(id))), async (id) => {
      const first = await walkFirstOpen(id, firstDays.get(lower(id))!, last, q.mode, now, adm);
      if (first) byDoctor.set(lower(id), [first]);
    });
  }
  const daySlots = !day || day < today ? new Map<string, OpenSlot[]>()
    : !cutoff || day < cutoff ? byDoctor : await daySlotsByDoctor(ids, day, q.mode, now, adm);
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
      ...(q.date ? { slots: (daySlots.get(lower(d._id)) ?? []).filter((x) => x.s.date === day).map(slotView) } : {}),
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
export async function listDoctorSlots(actorIn: PharmacyActor | BookerActor, doctorId: string, q: DoctorSlotsQuery, now: Date = new Date()) {
  const booker = asBooker(actorIn);
  assertBookerOn(booker.kind);
  if (booker.kind === 'lab') await bookerOrigin(booker);
  const notFound = () => err(404, 'DOCTOR_NOT_FOUND', 'Doctor not found');
  if (typeof doctorId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(doctorId)) throw notFound();
  const d = await SpecialistModel.findById(doctorId).select({ ...DOCTOR_FIELDS, isActive: 1, isVerified: 1 }).lean() as Record<string, any> | null;
  if (!isEligibleDoctor(d)) throw notFound();
  const today = istTodayYyyymmdd(now);
  const from = q.from && ymd(q.from) > today ? ymd(q.from) : today;
  const days = Math.min(Math.max(Number(q.days) || 7, 1), 14);
  const id = String(d!._id);
  const to = addDaysYmd(from, days - 1);
  const adm = await admissionOf([id]);
  const { byDoctor, cutoff } = await openSlotsByDoctor([id], from, to, q.mode, now, adm);
  let slots = byDoctor.get(lower(id)) ?? [];
  // r8 B4: past the shared read's cut-off, the rest of the window (at most 14 days) is read day by day; a day too large
  // even for that says `truncated: true` (never a silently partial list).
  let truncated = false;
  if (cutoff) {
    for (let day = cutoff; day <= to; day = addDaysYmd(day, 1)) {
      const rows = await SlotModel.find({ specialistId: id, date: day, ...candidateFilter(q.mode) }).limit(DAY_READ_CAP + 1).lean() as unknown as SlotRow[];
      if (rows.length > DAY_READ_CAP) truncated = true;
      slots = slots.concat(admitOpen(rows.slice(0, DAY_READ_CAP), adm, q.mode, now));
    }
  }
  return {
    doctor: { doctorId: String(d!._id), name: d!.name, specialization: d!.specialization, languages: d!.languages ?? [], city: d!.city ?? null,
      experienceYears: d!.experienceYears ?? null, feeMinor: feeMinorOf(d!) },
    from, to,
    slots: slots.map(slotView),
    ...(truncated ? { truncated: true } : {}),
  };
}

async function ownAssisted(booker: BookerActor, bookingId: unknown): Promise<IBooking> {
  if (typeof bookingId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(bookingId)) throw notFound();
  const b = await BookingModel.findOne({ _id: bookingId, ...bookerBookingsFilter(booker) }).lean() as IBooking | null;
  if (!b) throw notFound();
  return b;
}

const shownDate = (d?: string) => (d && /^\d{8}$/.test(d) ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : String(d ?? ''));

/** After a cancellation of an assisted booking (any path): reminders, Meet, and who is told (§6.5, §8.7). */
export async function afterAssistedCancel(b: IBooking, by: 'booker' | 'patient' | 'doctor' | 'admin', refunded = true): Promise<IBooking> {
  if (!b.assisted) return b;
  // Phase 1b: a card refund queued by this cancellation is sent now (best effort; the worker retries it).
  if (b.assisted.funding?.method === 'razorpay') await kickCardRefunds(String(b._id));
  const fx = assistedEffects();
  await bestEffort('reminders', () => fx.clearReminders(String(b._id)), undefined);
  const out = await bestEffort('meet', () => fx.cancelMeet(b, b.cancellationReason || 'Cancelled'), b);
  const id = String(b._id);
  const when = `${shownDate(b.bookingDate)} at ${b.bookingTime}`;
  const a = b.assisted;
  // Phase 1b: what happened to the partner's money — wallet, card/UPI, or nothing (a card booking cancelled unpaid).
  const row = cancellationRowOf(a.funding);
  if (!row && a.funding?.method === 'razorpay') refunded = false;
  const bookerMoney = bookerMoneyLine(row);
  // Phase 1b: the patient and the doctor hear of a card booking only once it is paid; one cancelled before that is told
  // to nobody but the booker (when someone else cancelled it).
  const unannounced = a.funding?.method === 'razorpay' && !b.lifecycle?.confirmed;
  const notices: AssistedNotice[] = [];
  if (by !== 'patient' && !unannounced) {
    notices.push({ audience: 'customer', userId: String(b.userId), type: 'booking_cancelled', title: 'Consultation cancelled',
      message: `The consultation on ${when} (Ref ${a.shortRef}) was cancelled.${refunded ? ` ${a.bookedBy.name} has been refunded.` : ''}`, bookingId: id,
      key: `assisted:${id}:cancelled:customer` });
  }
  if (by !== 'booker') {
    // "Cancelled by patient" badge (§6.5): the partner is told; no health details.
    notices.push({ audience: 'booker', userId: bookerNoticeUserId(a.bookedBy), type: 'booking_cancelled', title: by === 'patient' ? 'Cancelled by the patient' : 'Booking cancelled',
      message: `Booking Ref ${a.shortRef} on ${when} was cancelled${by === 'patient' ? ' by the patient' : ''}.${refunded ? bookerMoney : ''}`,
      bookingId: id, key: `assisted:${id}:cancelled:booker`, data: { cause: by } });
  }
  if (by !== 'doctor' && b.specialistId && !unannounced) {
    notices.push({ audience: 'doctor', userId: String(b.specialistId), type: 'specialist_appointment_cancelled', title: 'Consultation cancelled',
      message: `A consultation on ${when} was cancelled.`, bookingId: id, key: `assisted:${id}:cancelled:doctor` });
  }
  await sendAssistedNotices(notices);
  return out;
}

/** POST /pharmacy-assisted/bookings/:id/cancel — any time before the start (§8.7); full refund to the wallet; P7 count. */
export async function cancelByBooker(actorIn: PharmacyActor | BookerActor, bookingId: string,
  input: { reason?: string; expectedUpdatedAt?: string | Date; refundTo?: 'card' | 'wallet' }, clock: () => Date = () => new Date()) {
  const booker = asBooker(actorIn);
  const ref = bookerRefOf(booker);
  await ownAssisted(booker, bookingId);
  const reason = String(input.reason ?? '').trim() || 'Cancelled by the booking partner';
  const r = await cancelBookingSettlement({
    bookingId, requester: { _id: ref.id, userType: booker.kind === 'pharmacy' ? 'pharmacy' : 'partner' }, assistedBooker: ref.kind, reason, cause: 'booker',
    cancelledAt: istTodayYyyymmdd(clock()),
    ...(input.refundTo ? { assistedRefundTo: input.refundTo } : {}),
    wallets: new WalletRepository(), expectedUpdatedAt: input.expectedUpdatedAt ?? null,
    enforceWindow: (b) => {
      const start = parseAppointment({ bookingDate: String(b.bookingDate ?? ''), bookingTime: String(b.bookingTime ?? '') })?.at;
      if (!start || start.getTime() <= clock().getTime()) throw err(400, 'BOOKING_ALREADY_STARTED', 'The consultation has already started; it can no longer be cancelled');
    },
    lifecycle: (b) => buildBookingLifecyclePatch(b.lifecycle, { cancelled: { reason }, refunded: { reason } }),
    inTx: async (b, s) => {
      await countBookerCancellationIn(ref.kind, ref.id, s);
      await auditBookerIn(booker, 'booking.cancelled', { bookingId: String(b._id), detail: { reason, cause: 'booker' } }, s);
    },
  });
  const booking = r.alreadyCancelled ? r.booking : await afterAssistedCancel(r.booking, 'booker');
  return { booking: await bookerView(booking as never, ref), refundedMinor: Math.round(r.refunded * 100), alreadyCancelled: r.alreadyCancelled,
    ...(booking.assisted?.funding?.method === 'razorpay' ? { refund: await cancellationRefundOf(String(booking._id)) } : {}) };
}

/** POST /pharmacy-assisted/bookings/:id/reschedule — P9: same doctor and price, before the start, once per request key. */
export async function rescheduleByBooker(actorIn: PharmacyActor | BookerActor, bookingId: string,
  input: { slotId: string; requestKey: string; expectedUpdatedAt?: string | Date }, clock: () => Date = () => new Date()) {
  if (!ASSISTED_KEY.test(String(input.requestKey ?? ''))) throw err(400, 'REQUEST_KEY_REQUIRED', 'requestKey is required');
  const booker = asBooker(actorIn);
  const ref = bookerRefOf(booker);
  const b = await ownAssisted(booker, bookingId);
  const hash = requestHashOf({ slotId: lower(input.slotId) });
  const replay = (x: IBooking) => {
    const prior = (x.assisted?.reschedules ?? []).find((r) => r.requestKey === input.requestKey);
    if (!prior) return null;
    if (prior.requestHash !== hash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different move');
    return x;
  };
  const prior = replay(b);
  if (prior) return { booking: await bookerView(prior as never, ref), replayed: true };
  if (!Types.ObjectId.isValid(input.slotId)) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  // r6/r7: a move onto the slot the booking already holds is refused (409 SAME_SLOT) inside the move's transaction
  // (rescheduleWithHolds), after its status and start checks.
  const slot = await SlotModel.findById(input.slotId).select({ date: 1 }).lean() as { date?: string } | null;
  if (!slot?.date) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  let updated: IBooking;
  try {
    updated = await rescheduleWithHolds({
      bookingId, requester: { _id: ref.id, userType: booker.kind === 'pharmacy' ? 'pharmacy' : 'partner' }, assistedBooker: ref.kind, nextSlotId: String(input.slotId),
      patch: { bookingDate: slot.date, lifecycle: buildBookingLifecyclePatch(b.lifecycle, { rescheduled: true }) ?? b.lifecycle },
      expectedUpdatedAt: input.expectedUpdatedAt ?? null, refuseStartedSource: clock,
      inTx: async (x, s) => {
        await claimRequestKey(rescheduleKeyScope(booker, bookingId), input.requestKey, s);
        await BookingModel.updateOne({ _id: x._id }, { $push: { 'assisted.reschedules': { requestKey: input.requestKey, requestHash: hash, at: clock(),
          fromSlotId: b.slotId, toSlotId: lower(input.slotId), by: bookerActorIdOf(booker) } } }, { session: s });
        await auditBookerIn(booker, 'booking.rescheduled', { bookingId: String(x._id), requestKey: input.requestKey,
          detail: { fromSlotId: b.slotId, toSlotId: lower(input.slotId) } }, s);
      },
    });
  } catch (e) {
    const raced = await BookingModel.findById(bookingId).lean() as IBooking | null;
    const again = raced ? replay(raced) : null;
    if (!again) throw asDoctorUnavailable(e);
    return { booking: await bookerView(again as never, ref), replayed: true };
  }
  if (isReplayedBooking(updated)) return { booking: await bookerView(updated as never, ref), replayed: true };
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
  return { booking: await bookerView(fresh as never, ref), replayed: false };
}

/** GET /pharmacy-assisted/bookings/by-key/:key — 'used' (with the booking), 'abandoned' or 'unknown' (Q9/Q13). */
export async function findByKey(actor: PharmacyActor | BookerActor, key: string) {
  if (!ASSISTED_KEY.test(String(key ?? ''))) throw err(400, 'VALIDATION_ERROR', 'A valid key is required');
  const b = await BookingModel.findOne({ 'assisted.requestKey': { $eq: storedAssistedKey(actor, key) } }).lean() as IBooking | null;
  // Phase 1b: a card booking adds its open Razorpay order (read only: null while none is open) to resume the payment.
  if (b) {
    return { state: 'used' as const, booking: await bookerView(b as never, bookerRefOf(asBooker(actor))),
      ...(b.assisted?.funding?.method === 'razorpay' ? { payment: await openCardOrder(b, { create: false }) } : {}) };
  }
  const row = await RequestKeyModel.findOne({ scope: assistedKeyScope(actor), key }).lean();
  return { state: row?.state === 'abandoned' ? 'abandoned' as const : 'unknown' as const };
}

/** POST /pharmacy-assisted/bookings/by-key/:key/abandon — abandoned (it can never be booked) or used (here it is). */
export async function abandonByKey(actor: PharmacyActor | BookerActor, key: string) {
  if (!ASSISTED_KEY.test(String(key ?? ''))) throw err(400, 'VALIDATION_ERROR', 'A valid key is required');
  const made = await BookingModel.exists({ 'assisted.requestKey': { $eq: storedAssistedKey(actor, key) } });
  if (made) return findByKey(actor, key);
  const state = await abandonRequestKey(assistedKeyScope(actor), key);
  return state === 'abandoned' ? { state } : findByKey(actor, key);
}
