import { ClientSession } from 'mongoose';
import { AppError } from '@/modules/common/types';
import {
  DoctorReservationModel,
  DoctorScheduleGuardModel,
  IDoctorReservation,
  ReservationKind,
} from '@/modules/doctors/model/reservation';

const busy = () => new AppError({ status: 409, code: 'DOCTOR_BUSY', message: 'The doctor is not free at that time' });
/**
 * Q16a: reservations and the doctor's guard are keyed by the doctor id in its canonical (lower-case) spelling, so two
 * spellings of one doctor can never hold overlapping intervals under separate guards.
 */
const doctorKey = (id: unknown) => { const v = String(id ?? ''); return /^[0-9a-fA-F]{24}$/.test(v) ? v.toLowerCase() : v; };

/** Serializes this transaction with every other admission for the doctor (write-write conflict on the guard). */
export async function bumpGuard(doctorId: string, s: ClientSession): Promise<void> {
  await DoctorScheduleGuardModel.findOneAndUpdate(
    { doctorId: doctorKey(doctorId) },
    { $inc: { version: 1 }, $setOnInsert: { doctorId: doctorKey(doctorId) } },
    { upsert: true, new: true, session: s }
  );
}

async function overlapping(doctorId: string, start: Date, end: Date, s: ClientSession, exceptRefId?: string) {
  return DoctorReservationModel.findOne({
    doctorId: doctorKey(doctorId), isActive: true, startTime: { $lt: end }, endTime: { $gt: start },
    ...(exceptRefId ? { refId: { $ne: String(exceptRefId) } } : {}),
  }).session(s).lean();
}

function assertInterval(start: Date, end: Date): void {
  if (!(start instanceof Date) || !(end instanceof Date) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new AppError({ status: 400, code: 'INVALID_INTERVAL', message: 'An appointment must end after it starts' });
  }
}

/**
 * Inside the caller's transaction (run it with a retrying runner — guard conflicts surface as transient errors):
 * bump the guard, refuse any overlap, insert. Idempotent per (kind, refId): a replay returns the existing interval.
 */
export async function reserveInterval(
  p: { doctorId: string; kind: ReservationKind; refId: string; start: Date; end: Date; branchId?: string },
  s: ClientSession
): Promise<IDoctorReservation> {
  assertInterval(p.start, p.end);
  await bumpGuard(p.doctorId, s);
  const existing = await DoctorReservationModel.findOne({ refId: String(p.refId), kind: p.kind }).session(s).lean();
  if (existing?.isActive) return existing as IDoctorReservation;
  if (await overlapping(p.doctorId, p.start, p.end, s)) throw busy();
  if (existing) {
    const revived = await DoctorReservationModel.findOneAndUpdate({ _id: existing._id },
      { $set: { isActive: true, startTime: p.start, endTime: p.end, branchId: p.branchId } }, { new: true, session: s }).lean();
    return revived as IDoctorReservation;
  }
  const [created] = await DoctorReservationModel.create([{
    doctorId: doctorKey(p.doctorId), kind: p.kind, refId: String(p.refId), startTime: p.start, endTime: p.end, branchId: p.branchId, isActive: true,
  }], { session: s });
  return created!.toObject() as IDoctorReservation;
}

/** Moves an active interval (reschedule / extension) under the same guard; refuses an overlap with any other interval. */
export async function moveInterval(
  p: { doctorId: string; kind: ReservationKind; refId: string; start: Date; end: Date },
  s: ClientSession
): Promise<IDoctorReservation> {
  assertInterval(p.start, p.end);
  await bumpGuard(p.doctorId, s);
  if (await overlapping(p.doctorId, p.start, p.end, s, p.refId)) throw busy();
  const moved = await DoctorReservationModel.findOneAndUpdate(
    { refId: String(p.refId), kind: p.kind, doctorId: doctorKey(p.doctorId), isActive: true },
    { $set: { startTime: p.start, endTime: p.end } },
    { new: true, session: s }
  ).lean();
  if (!moved) throw new AppError({ status: 409, code: 'RESERVATION_NOT_ACTIVE', message: 'The appointment is no longer held' });
  return moved as IDoctorReservation;
}

/** Frees the interval (cancellation, no-show, completion); idempotent. */
export async function releaseInterval(kind: ReservationKind, refId: string, s: ClientSession): Promise<void> {
  await DoctorReservationModel.updateOne({ refId: String(refId), kind, isActive: true }, { $set: { isActive: false } }, { session: s });
}

/** Whether the doctor holds an active interval covering `at` (e.g. busy with an instant consultation). */
export async function activeIntervalAt(doctorId: string, at: Date, kind?: ReservationKind): Promise<IDoctorReservation | null> {
  const r = await DoctorReservationModel.findOne({
    doctorId: doctorKey(doctorId), isActive: true, startTime: { $lte: at }, endTime: { $gt: at }, ...(kind ? { kind } : {}),
  }).lean();
  return (r as IDoctorReservation | null) ?? null;
}

/**
 * r40c: the active held intervals of these doctors overlapping [start, end) — the clinic desk's free slots and the
 * reception's busy blocks. The lower bound (`startTime ≥ start − 1 day`; no held interval is longer than a day) keeps the
 * read on the doctor's interval index instead of every earlier interval.
 */
export function heldIntervalsOverlapping(doctorIds: string[], start: Date, end: Date) {
  return DoctorReservationModel.find({ doctorId: { $in: doctorIds.map(doctorKey) }, isActive: true,
    startTime: { $gte: new Date(start.getTime() - 86_400_000), $lt: end }, endTime: { $gt: start } })
    .select({ doctorId: 1, refId: 1, startTime: 1, endTime: 1 }).sort({ doctorId: 1, startTime: 1 }).lean();
}
