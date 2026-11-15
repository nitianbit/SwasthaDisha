import { AppError } from '@/modules/common/types';
import SlotModel from '@/modules/slots/model';
import PartnerOrgModel from '@/modules/partners/model';
import BranchModel from '@/modules/partners/model/branch';
import MemberModel from '@/modules/partners/model/member';
import { DoctorScheduleTemplateModel, IDoctorScheduleTemplate, IScheduleWindow, Weekday } from '@/modules/doctors/model/schedule';
import { addDays, istDate } from '@/modules/partners/services/slots';

export const DOCTOR_ROLLING_DAYS = 30;
const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const ymd = (isoDate: string) => isoDate.replace(/-/g, '');
const iso = (yyyymmdd: string) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
const weekdayOf = (isoDate: string): Weekday =>
  WEEKDAYS[new Date(Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)))).getUTCDay()]!;

/** In-clinic windows: the doctor must be an active member of a verified clinic holding that in-clinic branch. */
export async function assertClinicBranchForDoctor(doctorId: string, branchId: string): Promise<void> {
  const branch = await BranchModel.findById(branchId).lean();
  const partner = branch ? await PartnerOrgModel.findById(branch.partnerId).lean() : null;
  const member = branch ? await MemberModel.findOne({ partnerId: String(branch.partnerId), doctorId: String(doctorId), isActive: true }).lean() : null;
  const inScope = !!member && (member.role === 'owner' || (member.branchIds ?? []).length === 0 || (member.branchIds ?? []).map(String).includes(String(branchId)));
  if (!branch || branch.isActive === false || !branch.services?.inClinic || !partner || partner.kind !== 'clinic'
      || partner.isActive === false || partner.verification?.state !== 'verified' || !inScope) {
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

export async function getTemplate(doctorId: string): Promise<IDoctorScheduleTemplate | null> {
  return ((await DoctorScheduleTemplateModel.findOne({ doctorId: String(doctorId) }).lean()) as IDoctorScheduleTemplate | null) ?? null;
}

export async function saveTemplate(doctorId: string, input: { slotMinutes: number; days: Partial<Record<Weekday, IScheduleWindow[]>> }, now = new Date()) {
  await validateTemplate(doctorId, input.days, input.slotMinutes);
  const template = await DoctorScheduleTemplateModel.findOneAndUpdate(
    { doctorId: String(doctorId) },
    { $set: { slotMinutes: input.slotMinutes, days: input.days, isActive: true }, $setOnInsert: { doctorId: String(doctorId), leaveDates: [] } },
    { upsert: true, new: true }
  ).lean();
  const expansion = await expandDoctorSlots(doctorId, istDate(now), DOCTOR_ROLLING_DAYS);
  return { template, expansion };
}

/** Leave day on/off (YYYYMMDD); slots that already hold bookings keep them. */
export async function setLeave(doctorId: string, date: string, onLeave: boolean, now = new Date()) {
  if (!/^\d{8}$/.test(date)) throw new AppError({ status: 400, code: 'INVALID_DATE', message: 'Date must be YYYYMMDD' });
  const template = await DoctorScheduleTemplateModel.findOneAndUpdate(
    { doctorId: String(doctorId) },
    onLeave ? { $addToSet: { leaveDates: date }, $setOnInsert: { doctorId: String(doctorId), slotMinutes: 30, days: {}, isActive: true } }
      : { $pull: { leaveDates: date } },
    { upsert: onLeave, new: true }
  ).lean();
  const expansion = await expandDoctorSlots(doctorId, istDate(now), DOCTOR_ROLLING_DAYS);
  return { template, expansion };
}

export interface DoctorExpansion { inserted: number; updated: number; closed: number; reopened: number }

/**
 * Brings the doctor's slots for [fromDate, +days) in line with the template and leave days. Inserts missing template
 * slots; refreshes modes/branch/end only on template slots nobody booked; closes (isActive/isAvailable false, with a
 * reason) slots on leave days and template slots no longer wanted; reopens only slots it closed. Never deletes a slot,
 * never changes currentBookings, never reopens a slot someone closed by hand. Idempotent.
 */
export async function expandDoctorSlots(doctorId: string, fromIsoDate: string, days: number): Promise<DoctorExpansion> {
  const out: DoctorExpansion = { inserted: 0, updated: 0, closed: 0, reopened: 0 };
  const t = await getTemplate(doctorId);
  if (!t) return out;
  const leave = new Set(t.leaveDates ?? []);
  for (let i = 0; i < days; i++) {
    const isoDate = addDays(fromIsoDate, i);
    const date = ymd(isoDate);
    const specialistId = String(doctorId);
    if (leave.has(date)) {
      const r = await SlotModel.updateMany({ specialistId, date, isActive: { $ne: false } },
        { $set: { isActive: false, isAvailable: false, closedReason: 'leave' } });
      out.closed += r.modifiedCount;
      continue;
    }
    const wanted: { start: string; end: string; w: IScheduleWindow }[] = [];
    if (t.isActive) {
      for (const w of t.days[weekdayOf(isoDate)] ?? []) {
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
      ]) as any, { ordered: true });
      out.inserted += r.upsertedCount;
      out.updated += Math.max(0, r.modifiedCount);
    }
    const starts = wanted.map((x) => x.start);
    const reopened = await SlotModel.updateMany(
      { specialistId, date, $or: [{ closedReason: 'leave' }, { closedReason: 'template', source: 'template', startTime: { $in: starts } }] },
      [{ $set: { isActive: true, isAvailable: { $lt: [{ $ifNull: ['$currentBookings', 0] }, { $ifNull: ['$maxBookings', 1] }] } } }, { $unset: 'closedReason' }]
    );
    out.reopened += reopened.modifiedCount;
    const closed = await SlotModel.updateMany(
      { specialistId, date, source: 'template', startTime: { $nin: starts }, isActive: { $ne: false } },
      { $set: { isActive: false, isAvailable: false, closedReason: 'template' } }
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
