import { AppError } from '@/modules/common/types';
import SlotModel from '@/modules/slots/model';
import SpecialistModel from '@/modules/specialists/model';
import { isEligibleDoctor } from '@/modules/specialists/eligibility';
import PartnerOrgModel from '@/modules/partners/model';
import BranchModel from '@/modules/partners/model/branch';
import MemberModel from '@/modules/partners/model/member';
import { DoctorScheduleTemplateModel, IDoctorScheduleTemplate, IScheduleWindow, Weekday } from '@/modules/doctors/model/schedule';
import { addDays, istDate, isRealDate, assertRealDate } from '@/modules/partners/services/slots';
import { ClientSession } from 'mongoose';
import { parseAppointment } from '@/modules/common/utils/cancellationWindow';
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

/**
 * r7: clinicBranchContext for many doctors at once, for slot lists (three reads in all, not three per doctor and
 * branch): the active members of these doctors, then their clinics and those clinics' branches together. The answer
 * says whether `doctorId` may take an in-clinic booking at `branchId` on `date` (YYYYMMDD): the same rule as
 * clinicBranchContext (active branch offering in-clinic visits, active verified clinic, active member whose scope holds
 * the branch) and the branch not on holiday that day (branchClosedOn). Ids are compared in lower case.
 */
export async function clinicBranchAdmission(doctorIds: string[]): Promise<(doctorId: string, branchId: string, date: string) => boolean> {
  const low = (v: unknown) => String(v ?? '').toLowerCase();
  const wanted = [...new Set(doctorIds.flatMap((d) => [String(d), low(d)]))];
  if (!wanted.length) return () => false;
  const members = await MemberModel.find({ doctorId: { $in: wanted }, isActive: true })
    .select({ partnerId: 1, doctorId: 1, role: 1, branchIds: 1, doctorBranchIds: 1 }).lean() as unknown as
    { partnerId: string; doctorId: string; role?: string; branchIds?: string[]; doctorBranchIds?: string[] }[];
  const partnerIds = [...new Set(members.map((m) => String(m.partnerId)))];
  if (!partnerIds.length) return () => false;
  const oids = partnerIds.filter((id) => /^[0-9a-fA-F]{24}$/.test(id));
  const [partners, branches] = await Promise.all([
    PartnerOrgModel.find({ _id: { $in: oids } }).select({ kind: 1, isActive: 1, verification: 1 }).lean() as unknown as
      Promise<{ _id: unknown; kind?: string; isActive?: boolean; verification?: { state?: string } }[]>,
    BranchModel.find({ partnerId: { $in: partnerIds } }).select({ partnerId: 1, isActive: 1, services: 1, holidays: 1 }).lean() as unknown as
      Promise<{ _id: unknown; partnerId: string; isActive?: boolean; services?: { inClinic?: boolean }; holidays?: string[] }[]>,
  ]);
  const clinicOk = new Set(partners.filter((p) => p.kind === 'clinic' && p.isActive !== false && p.verification?.state === 'verified')
    .map((p) => String(p._id)));
  const branchBy = new Map(branches.map((b) => [low(b._id), b]));
  const memberBy = new Map(members.map((m) => [`${String(m.partnerId)}|${low(m.doctorId)}`, m]));
  return (doctorId, branchId, date) => {
    const b = branchBy.get(low(branchId));
    if (!b || b.isActive === false || !b.services?.inClinic || !clinicOk.has(String(b.partnerId))) return false;
    const m = memberBy.get(`${String(b.partnerId)}|${low(doctorId)}`);
    if (!m) return false;
    const scope = doctorScopeOf(m);
    if (scope.length > 0 && !scope.map(low).includes(low(b._id))) return false;
    return !(b.holidays ?? []).some((h) => String(h).replace(/-/g, '') === String(date));
  };
}

/**
 * Q16a (M4): whether a clinic branch is on holiday on `date` (YYYYMMDD). Branch holidays are stored as YYYY-MM-DD;
 * both spellings are matched. Admission refuses such a slot, expansion closes it, and slot lists hide it.
 */
export async function branchClosedOn(branchId: string, date: string, s?: ClientSession): Promise<boolean> {
  if (!/^[0-9a-fA-F]{24}$/.test(String(branchId)) || !/^\d{8}$/.test(String(date))) return false;
  return !!(await BranchModel.exists({ _id: branchId, holidays: { $in: [iso(String(date)), String(date)] } }).session(s ?? null));
}

/** Q16a (M4): the holiday dates (YYYYMMDD) of each given branch, for filtering many slots at once. */
export async function branchHolidays(branchIds: string[], s?: ClientSession): Promise<Map<string, Set<string>>> {
  const ids = [...new Set(branchIds.map(String).filter((b) => /^[0-9a-fA-F]{24}$/.test(b)))];
  const out = new Map<string, Set<string>>();
  if (!ids.length) return out;
  const rows = await BranchModel.find({ _id: { $in: ids } }).select({ holidays: 1 }).session(s ?? null).lean() as { _id: unknown; holidays?: string[] }[];
  for (const r of rows) out.set(String(r._id), new Set((r.holidays ?? []).map((h) => String(h).replace(/-/g, '')).filter((h) => /^\d{8}$/.test(h))));
  return out;
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
  const expansion = await expandDoctorSlots(doctorId, istDate(now), DOCTOR_ROLLING_DAYS, now); // Q16a (N8): the injected clock
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
    const expansion = await expandDoctorSlotsIn(doctorId, today, DOCTOR_ROLLING_DAYS, s, now); // Q16a (N8)
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
    const r = await SlotModel.updateMany({ specialistId, date, isActive: { $ne: false }, manuallyClosed: { $ne: true } },
      { $set: { isActive: false, isAvailable: false, closedReason: 'leave' } }, { session: s });
    return { closed: r.modifiedCount, reopened: 0 };
  }
  const r = await SlotModel.updateMany({ specialistId, date, closedReason: 'leave', manuallyClosed: { $ne: true } },
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
export async function expandDoctorSlots(doctorId: string, fromIsoDate: string, days: number, now = new Date()): Promise<DoctorExpansion> {
  assertRealDate(fromIsoDate, 'from');
  // One transaction that first bumps the doctor's schedule guard (template/leave writes bump it too): a stale run can
  // never commit after a newer one — the loser is retried and re-reads the template that won. No lease.
  await ensureScheduleGuard(doctorScheduleKey(doctorId));
  return runLedgerTransaction(async (s) => {
    await bumpScheduleGuard(doctorScheduleKey(doctorId), s);
    return expandDoctorSlotsIn(doctorId, fromIsoDate, days, s, now);
  });
}

async function expandDoctorSlotsIn(doctorId: string, fromIsoDate: string, days: number, s: ClientSession, now = new Date()): Promise<DoctorExpansion> {
  const out: DoctorExpansion = { inserted: 0, updated: 0, closed: 0, reopened: 0 };
  const found = await getTemplate(doctorId, s);
  // Without a template (manual slots only) nothing is generated or closed for the template, but branch holidays still
  // close and reopen in-clinic slots (Q16a).
  const t = found ?? ({ doctorId, slotMinutes: 30, days: {}, leaveDates: [], isActive: false } as unknown as IDoctorScheduleTemplate);
  const leave = new Set((t.leaveDates ?? []).filter((d) => /^\d{8}$/.test(d) && isRealDate(iso(d))));
  // Q16a (M4): the holidays of every clinic branch this doctor has (template windows) or holds slots at in the range.
  const rangeEnd = ymd(addDays(fromIsoDate, days - 1));
  const slotBranches = await SlotModel.distinct('branchId', { specialistId: String(doctorId), date: { $gte: ymd(fromIsoDate), $lte: rangeEnd },
    branchId: { $type: 'string' } }).session(s) as string[];
  const templateBranches = Object.values(t.days ?? {}).flat().map((w) => w?.branchId).filter((b): b is string => !!b).map(String);
  const holidays = await branchHolidays([...slotBranches, ...templateBranches], s);
  const closedBranchesOn = (date: string) => [...holidays.entries()].filter(([, days]) => days.has(date)).map(([b]) => b);
  // Q16a (M1): a template slot that already started today (India time) is never created.
  const todayYmd = ymd(istDate(now));
  // S5b: no slot is created for a doctor who is not verified and active, whichever run expands (schedule save, leave
  // change, clinic link, nightly). Existing slots are left as they are (patient lists hide them; admission refuses them).
  const sp = /^[0-9a-fA-F]{24}$/.test(String(doctorId))
    ? await SpecialistModel.findById(String(doctorId)).select({ isActive: 1, isVerified: 1 }).session(s).lean() : null;
  const mayCreate = isEligibleDoctor(sp);
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
      // Q16a (L6): a slot the doctor switched off by hand stays theirs (never marked or reopened as a leave closure).
      const r = await SlotModel.updateMany({ specialistId, date, isActive: { $ne: false }, manuallyClosed: { $ne: true } },
        { $set: { isActive: false, isAvailable: false, closedReason: 'leave' } }, { session: s });
      out.closed += r.modifiedCount;
      continue;
    }
    const closedBranches = closedBranchesOn(date);
    const wanted: { start: string; end: string; w: IScheduleWindow }[] = [];
    if (t.isActive) {
      for (const w of t.days[weekdayOf(isoDate)] ?? []) {
        if (w.branchId && !clinicOk.get(String(w.branchId))) continue;
        if (w.branchId && closedBranches.includes(String(w.branchId))) continue; // the clinic branch is on holiday
        for (let m = toMin(w.start); m + t.slotMinutes <= toMin(w.end); m += t.slotMinutes) wanted.push({ start: toHHMM(m), end: toHHMM(m + t.slotMinutes), w });
      }
    }
    // Slots of today that already started are not inserted (an existing one is left as it is).
    const insertable = !mayCreate ? [] : date === todayYmd
      ? wanted.filter((x) => { const at = parseAppointment({ bookingDate: date, bookingTime: x.start })?.at; return !!at && at.getTime() > now.getTime(); })
      : date < todayYmd ? [] : wanted;
    if (insertable.length) {
      const r = await SlotModel.bulkWrite(insertable.flatMap(({ start, end, w }) => [
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
    // Holiday closures of in-clinic slots (template or manual) at branches closed that day; reopened once it is not.
    if (closedBranches.length) {
      const h = await SlotModel.updateMany({ specialistId, date, branchId: { $in: closedBranches }, isActive: { $ne: false }, manuallyClosed: { $ne: true } },
        { $set: { isActive: false, isAvailable: false, closedReason: 'holiday' } }, { session: s });
      out.closed += h.modifiedCount;
    }
    const reopened = await SlotModel.updateMany(
      { specialistId, date, manuallyClosed: { $ne: true }, $or: [{ closedReason: 'leave' },
        { closedReason: 'holiday', branchId: { $nin: closedBranches } },
        { closedReason: 'template', source: 'template', startTime: { $in: starts } }] },
      [{ $set: { isActive: true, isAvailable: { $lt: [{ $ifNull: ['$currentBookings', 0] }, { $ifNull: ['$maxBookings', 1] }] } } }, { $unset: 'closedReason' }],
      { session: s }
    );
    out.reopened += reopened.modifiedCount;
    if (!found) continue;
    const closed = await SlotModel.updateMany(
      { specialistId, date, source: 'template', startTime: { $nin: starts }, isActive: { $ne: false }, manuallyClosed: { $ne: true } },
      { $set: { isActive: false, isAvailable: false, closedReason: 'template' } }, { session: s }
    );
    out.closed += closed.modifiedCount;
  }
  return out;
}

/**
 * Q16a (M4): after a clinic branch's holidays (or services/active state) change, every doctor with a template window or
 * a slot at that branch is expanded again, so holiday closures and reopenings follow at once. Best effort per doctor
 * (admission refuses holiday slots whatever this does).
 */
export async function expandDoctorsAtBranch(branchId: string, now = new Date()): Promise<void> {
  const or = WEEKDAYS.map((d) => ({ [`days.${d}.branchId`]: String(branchId) }));
  const [templates, withSlots] = await Promise.all([
    DoctorScheduleTemplateModel.find({ $or: or }).select({ doctorId: 1 }).lean().exec() as unknown as Promise<{ doctorId: string }[]>,
    SlotModel.distinct('specialistId', { branchId: String(branchId), date: { $gte: ymd(istDate(now)) } }).exec() as unknown as Promise<string[]>,
  ]);
  const doctors = new Set([...templates.map((t) => String(t.doctorId)), ...withSlots.filter(Boolean).map(String)]);
  for (const doctorId of doctors) {
    try {
      await expandDoctorSlots(doctorId, istDate(now), DOCTOR_ROLLING_DAYS, now);
    } catch (e) { console.error('doctor slot refresh after a branch change failed', (e as Error)?.message); }
  }
}

/** Nightly: extend every active template to the rolling window. */
export async function expandAllDoctorTemplates(now = new Date()): Promise<number> {
  let inserted = 0;
  for await (const t of DoctorScheduleTemplateModel.find({ isActive: true }).select({ doctorId: 1 }).lean().cursor() as AsyncIterable<{ doctorId: string }>) {
    inserted += (await expandDoctorSlots(t.doctorId, istDate(now), DOCTOR_ROLLING_DAYS, now)).inserted; // Q16a (N8)
  }
  return inserted;
}

export { iso as isoFromYmd };
