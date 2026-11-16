import { AppError } from '@/modules/common/types';
import SlotModel from '@/modules/slots/model';
import PartnerOrgModel from '@/modules/partners/model';
import BranchModel from '@/modules/partners/model/branch';
import MemberModel from '@/modules/partners/model/member';
import { DoctorScheduleTemplateModel, IDoctorScheduleTemplate, IScheduleWindow, Weekday } from '@/modules/doctors/model/schedule';
import { addDays, istDate, isRealDate, assertRealDate } from '@/modules/partners/services/slots';
import { ClientSession } from 'mongoose';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { ensureScheduleGuard, bumpScheduleGuard } from '@/modules/partners/services/slots';

export const DOCTOR_ROLLING_DAYS = 30;
const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const ymd = (isoDate: string) => isoDate.replace(/-/g, '');
const iso = (yyyymmdd: string) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
const weekdayOf = (isoDate: string): Weekday =>
  WEEKDAYS[new Date(Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)))).getUTCDay()]!;

/**
 * In-clinic authority, checked against the CURRENT state every time it matters (template save, every expansion, every
 * new booking admission): the doctor is an active member of an active, verified clinic whose active branch offers
 * in-clinic consultations and is within the member's branch scope. Existing appointments are never touched by a loss of
 * authority; only new clinic commerce is refused.
 */
/** Q6: the branches a doctor member consults at ([] = all): the accepted invitation's scope, else the member's own. */
export function doctorScopeOf(member: { role?: string; branchIds?: string[]; doctorBranchIds?: string[] }): string[] {
  if (Array.isArray(member.doctorBranchIds)) return member.doctorBranchIds.map(String);
  return member.role === 'owner' ? [] : (member.branchIds ?? []).map(String);
}

export async function clinicBranchContext(doctorId: string, branchId: string, s?: ClientSession): Promise<{ partnerId: string; branchId: string } | null> {
  if (!/^[0-9a-fA-F]{24}$/.test(String(branchId))) return null;
  const branch = await BranchModel.findById(branchId).session(s ?? null).lean();
  if (!branch || branch.isActive === false || !branch.services?.inClinic) return null;
  const partner = await PartnerOrgModel.findById(branch.partnerId).session(s ?? null).lean();
  if (!partner || partner.kind !== 'clinic' || partner.isActive === false || partner.verification?.state !== 'verified') return null;
  const member = await MemberModel.findOne({ partnerId: String(branch.partnerId), doctorId: String(doctorId), isActive: true }).session(s ?? null).lean();
  if (!member) return null;
  // Q6: a doctor's consultation scope comes from the invitation they accepted; otherwise the member's own scope.
  const scope = doctorScopeOf(member);
  const inScope = scope.length === 0 || scope.includes(String(branchId));
  return inScope ? { partnerId: String(branch.partnerId), branchId: String(branch._id) } : null;
}

export async function clinicBranchAllowed(doctorId: string, branchId: string, s?: ClientSession): Promise<boolean> {
  return !!(await clinicBranchContext(doctorId, branchId, s));
}

export async function assertClinicBranchForDoctor(doctorId: string, branchId: string, s?: ClientSession): Promise<void> {
  if (!(await clinicBranchAllowed(doctorId, branchId, s))) {
    throw new AppError({ status: 403, code: 'CLINIC_BRANCH_NOT_ALLOWED', message: 'You do not consult at that clinic branch' });
  }
}

async function validateTemplate(doctorId: string, days: Partial<Record<Weekday, IScheduleWindow[]>>, slotMinutes: number): Promise<void> {
  const branches = new Set<string>();
  for (const [day, windows] of Object.entries(days)) {
    const sorted = [...(windows ?? [])].sort((a, b) => toMin(a.start) - toMin(b.start));
    for (let i = 0; i < sorted.length; i++) {
      const w = sorted[i]!;
      if (toMin(w.end) - toMin(w.start) < slotMinutes) throw new AppError({ status: 400, code: 'INVALID_WINDOW', message: `${day}: a window must hold at least one slot` });
      if (i > 0 && toMin(w.start) < toMin(sorted[i - 1]!.end)) throw new AppError({ status: 400, code: 'OVERLAPPING_WINDOWS', message: `${day}: windows overlap` });
      if (!w.modes?.length) throw new AppError({ status: 400, code: 'INVALID_WINDOW', message: `${day}: choose at least one consultation type` });
      if (w.branchId) {
        if (w.modes.some((m) => m !== 'in-person')) throw new AppError({ status: 400, code: 'INVALID_WINDOW', message: 'Clinic windows are for in-person consultations' });
        branches.add(String(w.branchId));
      }
    }
  }
  for (const b of branches) await assertClinicBranchForDoctor(doctorId, b);
}

export const doctorScheduleKey = (doctorId: string) => `doctor-slots:${String(doctorId)}`;

export async function getTemplate(doctorId: string, s?: ClientSession): Promise<IDoctorScheduleTemplate | null> {
  return ((await DoctorScheduleTemplateModel.findOne({ doctorId: String(doctorId) }).session(s ?? null).lean()) as IDoctorScheduleTemplate | null) ?? null;
}

/**
 * Writes the doctor's template in a transaction that bumps the schedule guard (serialized with every expansion and every
 * other template/leave write). Q13: with `expectedUpdatedAt` (null = the editor started from no template) a different
 * current template refuses the write (409 SCHEDULE_CHANGED); the guard bump makes a concurrent write conflict and re-read.
 */
async function writeTemplate(doctorId: string, update: Record<string, unknown>, upsert: boolean, expectedUpdatedAt?: Date | string | null) {
  await ensureScheduleGuard(doctorScheduleKey(doctorId));
  return runLedgerTransaction(async (s) => {
    await bumpScheduleGuard(doctorScheduleKey(doctorId), s);
    if (expectedUpdatedAt !== undefined) {
      const cur = await DoctorScheduleTemplateModel.findOne({ doctorId: String(doctorId) }).select({ updatedAt: 1 }).session(s).lean();
      const curAt = cur?.updatedAt ? new Date(cur.updatedAt).getTime() : null;
      const expAt = expectedUpdatedAt === null ? null : new Date(expectedUpdatedAt).getTime();
      if (curAt !== expAt) throw new AppError({ status: 409, code: 'SCHEDULE_CHANGED', message: 'Your weekly schedule changed since you opened it; review it again' });
    }
    return DoctorScheduleTemplateModel.findOneAndUpdate({ doctorId: String(doctorId) }, update, { upsert, new: true, session: s }).lean();
  });
}

export async function saveTemplate(doctorId: string,
  input: { slotMinutes: number; days: Partial<Record<Weekday, IScheduleWindow[]>>; expectedUpdatedAt?: Date | string | null }, now = new Date()) {
  await validateTemplate(doctorId, input.days, input.slotMinutes);
  const template = await writeTemplate(doctorId,
    { $set: { slotMinutes: input.slotMinutes, days: input.days, isActive: true }, $setOnInsert: { doctorId: String(doctorId), leaveDates: [] } }, true,
    input.expectedUpdatedAt);
  const expansion = await expandDoctorSlots(doctorId, istDate(now), DOCTOR_ROLLING_DAYS);
  return { template, expansion };
}

/**
 * Leave day on/off (YYYYMMDD); slots that already hold bookings keep them. One transaction: the guard bump, the
 * template write, the rolling window and — when the changed day lies outside it — that day itself, so a leave day is
 * never left bookable whatever its distance (booking admission refuses leave days independently as well).
 */
export async function setLeave(doctorId: string, date: string, onLeave: boolean, now = new Date()) {
  if (!/^\d{8}$/.test(date) || !isRealDate(iso(date))) throw new AppError({ status: 400, code: 'INVALID_DATE', message: 'Date must be a real date, YYYYMMDD' });
  const today = istDate(now);
  await ensureScheduleGuard(doctorScheduleKey(doctorId));
  return runLedgerTransaction(async (s) => {
    await bumpScheduleGuard(doctorScheduleKey(doctorId), s);
    const template = await DoctorScheduleTemplateModel.findOneAndUpdate({ doctorId: String(doctorId) },
      onLeave ? { $addToSet: { leaveDates: date }, $setOnInsert: { doctorId: String(doctorId), slotMinutes: 30, days: {}, isActive: true } }
        : { $pull: { leaveDates: date } }, { upsert: onLeave, new: true, session: s }).lean();
    const expansion = await expandDoctorSlotsIn(doctorId, today, DOCTOR_ROLLING_DAYS, s);
    const inWindow = iso(date) >= today && iso(date) < addDays(today, DOCTOR_ROLLING_DAYS);
    if (!inWindow && iso(date) >= today) {
      const day = await reconcileLeaveDayIn(doctorId, date, onLeave, s);
      expansion.closed += day.closed; expansion.reopened += day.reopened;
    }
    return { template, expansion };
  });
}

/** Outside the rolling window only the leave state of that one day is reconciled (no template slots are generated there). */
async function reconcileLeaveDayIn(doctorId: string, date: string, onLeave: boolean, s: ClientSession) {
  const specialistId = String(doctorId);
  if (onLeave) {
    const r = await SlotModel.updateMany({ specialistId, date, isActive: { $ne: false } },
      { $set: { isActive: false, isAvailable: false, closedReason: 'leave' } }, { session: s });
    return { closed: r.modifiedCount, reopened: 0 };
  }
  const r = await SlotModel.updateMany({ specialistId, date, closedReason: 'leave' },
    [{ $set: { isActive: true, isAvailable: { $lt: [{ $ifNull: ['$currentBookings', 0] }, { $ifNull: ['$maxBookings', 1] }] } } }, { $unset: 'closedReason' }],
    { session: s });
  return { closed: 0, reopened: r.modifiedCount };
}

export interface DoctorExpansion { inserted: number; updated: number; closed: number; reopened: number }

/**
 * Brings the doctor's slots for [fromDate, +days) in line with the template and leave days. Inserts missing template
 * slots; refreshes modes/branch/end only on template slots nobody booked; closes (isActive/isAvailable false, with a
 * reason) slots on leave days and template slots no longer wanted; reopens only slots it closed. Never deletes a slot,
 * never changes currentBookings, never reopens a slot someone closed by hand. Idempotent.
 */
export async function expandDoctorSlots(doctorId: string, fromIsoDate: string, days: number): Promise<DoctorExpansion> {
  assertRealDate(fromIsoDate, 'from');
  // One transaction that first bumps the doctor's schedule guard (template/leave writes bump it too): a stale run can
  // never commit after a newer one — the loser is retried and re-reads the template that won. No lease.
  await ensureScheduleGuard(doctorScheduleKey(doctorId));
  return runLedgerTransaction(async (s) => {
    await bumpScheduleGuard(doctorScheduleKey(doctorId), s);
    return expandDoctorSlotsIn(doctorId, fromIsoDate, days, s);
  });
}

async function expandDoctorSlotsIn(doctorId: string, fromIsoDate: string, days: number, s: ClientSession): Promise<DoctorExpansion> {
  const out: DoctorExpansion = { inserted: 0, updated: 0, closed: 0, reopened: 0 };
  const t = await getTemplate(doctorId, s);
  if (!t) return out;
  const leave = new Set((t.leaveDates ?? []).filter((d) => /^\d{8}$/.test(d) && isRealDate(iso(d))));
  // Clinic authority is re-checked on every run: windows at a clinic branch the doctor may no longer use generate
  // nothing, so their template slots close for new bookings (bookings already made are kept).
  const clinicOk = new Map<string, boolean>();
  for (const w of Object.values(t.days ?? {}).flat()) {
    if (w?.branchId && !clinicOk.has(String(w.branchId))) clinicOk.set(String(w.branchId), await clinicBranchAllowed(doctorId, String(w.branchId), s));
  }
  for (let i = 0; i < days; i++) {
    const isoDate = addDays(fromIsoDate, i);
    const date = ymd(isoDate);
    const specialistId = String(doctorId);
    if (leave.has(date)) {
      const r = await SlotModel.updateMany({ specialistId, date, isActive: { $ne: false } },
        { $set: { isActive: false, isAvailable: false, closedReason: 'leave' } }, { session: s });
      out.closed += r.modifiedCount;
      continue;
    }
    const wanted: { start: string; end: string; w: IScheduleWindow }[] = [];
    if (t.isActive) {
      for (const w of t.days[weekdayOf(isoDate)] ?? []) {
        if (w.branchId && !clinicOk.get(String(w.branchId))) continue;
        for (let m = toMin(w.start); m + t.slotMinutes <= toMin(w.end); m += t.slotMinutes) wanted.push({ start: toHHMM(m), end: toHHMM(m + t.slotMinutes), w });
      }
    }
    if (wanted.length) {
      const r = await SlotModel.bulkWrite(wanted.flatMap(({ start, end, w }) => [
        { updateOne: { filter: { specialistId, date, startTime: start }, upsert: true, update: { $setOnInsert: {
          specialistId, date, startTime: start, endTime: end, duration: t.slotMinutes, slotType: 'consultation', maxBookings: 1, currentBookings: 0,
          isAvailable: true, isActive: true, isRecurring: false, serviceModes: w.modes, ...(w.branchId ? { branchId: w.branchId } : {}), source: 'template',
        } } } },
        { updateOne: { filter: { specialistId, date, startTime: start, source: 'template', currentBookings: 0 },
          update: w.branchId ? { $set: { endTime: end, duration: t.slotMinutes, serviceModes: w.modes, branchId: w.branchId } }
            : { $set: { endTime: end, duration: t.slotMinutes, serviceModes: w.modes }, $unset: { branchId: 1 } } } },
      ]) as any, { ordered: true, session: s });
      out.inserted += r.upsertedCount;
      out.updated += Math.max(0, r.modifiedCount);
    }
    const starts = wanted.map((x) => x.start);
    const reopened = await SlotModel.updateMany(
      { specialistId, date, $or: [{ closedReason: 'leave' }, { closedReason: 'template', source: 'template', startTime: { $in: starts } }] },
      [{ $set: { isActive: true, isAvailable: { $lt: [{ $ifNull: ['$currentBookings', 0] }, { $ifNull: ['$maxBookings', 1] }] } } }, { $unset: 'closedReason' }],
      { session: s }
    );
    out.reopened += reopened.modifiedCount;
    const closed = await SlotModel.updateMany(
      { specialistId, date, source: 'template', startTime: { $nin: starts }, isActive: { $ne: false } },
      { $set: { isActive: false, isAvailable: false, closedReason: 'template' } }, { session: s }
    );
    out.closed += closed.modifiedCount;
  }
  return out;
}

/** Nightly: extend every active template to the rolling window. */
export async function expandAllDoctorTemplates(now = new Date()): Promise<number> {
  let inserted = 0;
  for await (const t of DoctorScheduleTemplateModel.find({ isActive: true }).select({ doctorId: 1 }).lean().cursor() as AsyncIterable<{ doctorId: string }>) {
    inserted += (await expandDoctorSlots(t.doctorId, istDate(now), DOCTOR_ROLLING_DAYS)).inserted;
  }
  return inserted;
}

export { iso as isoFromYmd };
