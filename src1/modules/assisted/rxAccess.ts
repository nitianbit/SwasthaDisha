import { Types } from 'mongoose';
import SlotModel from '@/modules/slots/model';
import PharmacyModel from '@/modules/pharmacies/model';
import { slotIntervalOf } from '@/modules/common/utils/slotInterval';
import { parseAppointment } from '@/modules/common/utils/cancellationWindow';

/**
 * Assisted booking phase 0 (design §9.2, §17.2, overnight decision H): a booker (the pharmacy that made a booking) reads
 * that booking's prescription — its dispensing copy only — for RX_ACCESS_DAYS after the consultation's end. Legacy
 * pharmacy bookings (made through the generic create) follow the same window.
 */
export const RX_ACCESS_DAYS = 90;
const DAY_MS = 86_400_000;
const DEFAULT_CONSULTATION_MS = 30 * 60_000;

type Row = Record<string, any>;
export type SlotTimes = { date?: string; startTime?: string; endTime?: string; duration?: number };

const validId = (v: unknown) => typeof v === 'string' ? Types.ObjectId.isValid(v) && v.length === 24 : v instanceof Types.ObjectId;

/** The slots of these bookings, by slot id (one read). */
export async function slotsOf(rows: Row[]): Promise<Map<string, SlotTimes>> {
  const ids = [...new Set(rows.map((r) => String(r?.slotId ?? '')).filter(validId))];
  if (!ids.length) return new Map();
  const slots = await SlotModel.find({ _id: { $in: ids } }).select({ date: 1, startTime: 1, endTime: 1, duration: 1 }).lean();
  return new Map(slots.map((s) => [String(s._id), s as SlotTimes]));
}

/** India-time start and end of the appointment: the slot's interval, else the booked time + 30 minutes. */
export function appointmentIntervalOf(b: Row, slot?: SlotTimes | null): { start: Date; end: Date } | null {
  const fromSlot = slot && slot.date === b.bookingDate ? slotIntervalOf(slot) : null;
  if (fromSlot) return fromSlot;
  const start = parseAppointment({ bookingDate: b.bookingDate, bookingTime: b.bookingTime })?.at;
  if (!start) return null;
  return { start, end: new Date(start.getTime() + DEFAULT_CONSULTATION_MS) };
}

/**
 * The consultation's end (§9.2): the slot end, or the completion when later; an instant consultation's last extension
 * counts as its end too. When no time parses, the end of the booked India day (never earlier than the booking).
 */
export function consultationEndOf(b: Row, slot?: SlotTimes | null): Date | null {
  const candidates: number[] = [];
  const interval = appointmentIntervalOf(b, slot);
  if (interval) candidates.push(interval.end.getTime());
  else if (typeof b.bookingDate === 'string' && /^\d{8}$/.test(b.bookingDate)) {
    const d = b.bookingDate;
    const endOfDay = Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T23:59:59.999+05:30`);
    if (Number.isFinite(endOfDay)) candidates.push(endOfDay);
  }
  const completed = Date.parse(String(b.lifecycle?.completed?.at ?? ''));
  if (Number.isFinite(completed)) candidates.push(completed);
  for (const x of Array.isArray(b.instantExtensions) ? b.instantExtensions : []) {
    const t = new Date(x?.endTime).getTime();
    if (Number.isFinite(t)) candidates.push(t);
  }
  return candidates.length ? new Date(Math.max(...candidates)) : null;
}

/** Until when the booker may read the prescription (consultation end + 90 days); null = never (no time known). */
export function rxAccessUntil(b: Row, slot?: SlotTimes | null): Date | null {
  const end = consultationEndOf(b, slot);
  return end ? new Date(end.getTime() + RX_ACCESS_DAYS * DAY_MS) : null;
}

export function rxWindowOpen(b: Row, slot?: SlotTimes | null, now: Date = new Date()): boolean {
  const until = rxAccessUntil(b, slot);
  return !!until && now.getTime() < until.getTime();
}

/** Reads the booking's slot and decides the window (single booking: file access, order creation). */
export async function rxWindowOpenFor(b: Row, now: Date = new Date()): Promise<{ open: boolean; until: Date | null }> {
  const slot = (await slotsOf([b])).get(String(b.slotId ?? ''));
  const until = rxAccessUntil(b, slot);
  return { open: !!until && now.getTime() < until.getTime(), until };
}

/**
 * Whether the booking has a prescription the DOCTOR saved (review finding 2): only the server's mark of the doctor's
 * save (`lifecycle.prescriptionUploaded`, written by `createAppointmentPrescription`) counts, with some content. A
 * `prescription` a client sent (with any `prescribedAt` / `prescribedBySpecialistId`) is never a prescription here.
 */
export function hasPrescription(b: Row | null | undefined): boolean {
  if (!b || typeof b !== 'object' || !b.lifecycle?.prescriptionUploaded?.at) return false;
  const p = b.prescription;
  if (!p || typeof p !== 'object') return false;
  return (Array.isArray(p.medicines) && p.medicines.length > 0) || (Array.isArray(p.testsAdvised) && p.testsAdvised.length > 0)
    || !!p.advice || !!p.prescribedAt;
}

/** The pharmacy's current authority (as requireOperationalPharmacy): active, verified, not archived. */
export async function isOperationalPharmacy(pharmacyId: unknown): Promise<boolean> {
  const id = String(pharmacyId ?? '');
  if (!/^[0-9a-fA-F]{24}$/.test(id)) return false;
  const p = await PharmacyModel.findById(id).select({ isActive: 1, isVerified: 1, archivedAt: 1 }).lean();
  return !!p && !p.archivedAt && p.isActive !== false && !!p.isVerified;
}
