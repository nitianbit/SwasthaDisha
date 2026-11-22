import { NextFunction, Response } from 'express';
import { Types } from 'mongoose';
import SpecialistModel from '@/modules/specialists/model';
import { AppError } from '@/modules/common/types';
import { AuthRequest } from '@/modules/middleware/auth';

/**
 * S5: a doctor acts as a doctor (opens slots, takes bookings, changes consult status, prescribes) and is shown to or
 * booked by patients only when an admin verified the account and it is active. A self sign-up starts unverified.
 * Same predicate as the instant-consultation eligibility (Q13 `isEligibleDoctor`).
 */
export const isEligibleDoctor = (sp: { isActive?: unknown; isVerified?: unknown } | null | undefined): boolean =>
  !!sp && sp.isActive === true && sp.isVerified === true;

/**
 * Fields an admin checks at verification, and the sign-in contacts (OTP sign-in finds a doctor by phone or email).
 * Once verified, the doctor cannot change them through self-edit (the admin edit PUT /specialists/:id does). Before
 * verification the doctor fills them in during onboarding.
 */
export const IDENTITY_FIELDS = ['name', 'medicalRegistrationNumber', 'specialization', 'degree', 'phone', 'email'] as const;

const doctorIdOf = (req: AuthRequest) => String(req.user?.specialistId || req.user?._id || '');
const objectIdOrNull = (id: unknown) => (typeof id === 'string' && Types.ObjectId.isValid(id) && /^[0-9a-fA-F]{24}$/.test(id) ? id : null);
const norm = (v: unknown) => (v == null ? '' : String(v).trim());
/** Stored emails are lower-case (model), so an email differing only in case is the same sign-in. */
const normField = (f: string, v: unknown) => (f === 'email' ? norm(v).toLowerCase() : norm(v));

/** Patient-facing doctor writes (slots, consult status, prescription): 403 SPECIALIST_NOT_VERIFIED unless eligible. */
export const requireEligibleDoctor = async (req: AuthRequest, _res: Response, next: NextFunction): Promise<void> => {
  const id = objectIdOrNull(doctorIdOf(req));
  const sp = id ? await SpecialistModel.findById(id).select({ isActive: 1, isVerified: 1 }).lean() : null;
  if (!isEligibleDoctor(sp)) {
    throw new AppError({ status: 403, code: 'SPECIALIST_NOT_VERIFIED',
      message: 'Your doctor account must be verified and active before you can do this' });
  }
  next();
};

/**
 * Consult status change: a cancellation by the doctor is not stopped by this guard for a doctor who is not eligible (it
 * only reduces what the doctor can do); confirm, complete and no-show need an eligible doctor. On the main line the
 * portal's cancel then answers 409 DEDICATED_BOOKING_COMMAND_REQUIRED (bookings are cancelled by the patient or an admin
 * with POST /bookings/:id/cancel, before the appointment time); on the stage line it is the doctor cancellation command
 * (full refund).
 */
export const requireEligibleDoctorUnlessCancel = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  if ((req.body as { status?: unknown } | undefined)?.status === 'cancelled') { next(); return; }
  return requireEligibleDoctor(req, res, next);
};

/**
 * Self profile edit: once verified, a changed identity field is refused (403 IDENTITY_FIELDS_ADMIN_ONLY). A field sent
 * with its stored value (trimmed; empty = absent) is not a change, so apps that resend the whole form keep working.
 */
export const lockVerifiedIdentity = async (req: AuthRequest, _res: Response, next: NextFunction): Promise<void> => {
  const body = req.body as Record<string, unknown> | undefined;
  const sent = IDENTITY_FIELDS.filter((f) => body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, f));
  const id = objectIdOrNull(doctorIdOf(req));
  if (sent.length && id) {
    const sp = await SpecialistModel.findById(id).select({ isVerified: 1, ...Object.fromEntries(IDENTITY_FIELDS.map((f) => [f, 1])) })
      .lean() as Record<string, unknown> | null;
    const changed = sp?.isVerified === true ? sent.filter((f) => normField(f, body![f]) !== normField(f, sp[f])) : [];
    if (changed.length) {
      throw new AppError({ status: 403, code: 'IDENTITY_FIELDS_ADMIN_ONLY',
        message: `After verification only the Jansetu team can change: ${changed.join(', ')}` });
    }
  }
  next();
};

/** Admins see every doctor; a doctor sees itself; everyone else only eligible doctors. */
export const seesDoctor = (user: AuthRequest['user'] | undefined, sp: { _id?: unknown; isActive?: unknown; isVerified?: unknown }): boolean =>
  user?.userType === 'admin' ||
  (user?.userType === 'specialist' && String(user.specialistId || user._id).toLowerCase() === String(sp._id).toLowerCase()) ||
  isEligibleDoctor(sp);

/** Assert a doctor can be booked (create, reschedule target, surgery): 400 SPECIALIST_NOT_ACTIVE / SPECIALIST_NOT_VERIFIED. */
export const assertBookableDoctor = (sp: { isActive?: unknown; isVerified?: unknown }): void => {
  if (sp.isActive !== true) throw new AppError({ status: 400, code: 'SPECIALIST_NOT_ACTIVE', message: 'Specialist is not active' });
  if (sp.isVerified !== true) throw new AppError({ status: 400, code: 'SPECIALIST_NOT_VERIFIED', message: 'Specialist is not available for booking' });
};

/** Load a doctor by id and assert it can be booked (404 SPECIALIST_NOT_FOUND when missing). */
export async function loadBookableDoctor(specialistId: unknown): Promise<{ _id: unknown; name?: string }> {
  const id = objectIdOrNull(typeof specialistId === 'string' ? specialistId : String(specialistId ?? ''));
  const sp = id ? await SpecialistModel.findById(id).select({ name: 1, isActive: 1, isVerified: 1 }).lean() : null;
  if (!sp) throw new AppError({ status: 404, code: 'SPECIALIST_NOT_FOUND', message: 'Specialist not found' });
  assertBookableDoctor(sp);
  return sp as { _id: unknown; name?: string };
}

/**
 * Reschedule: refuse when the doctor's record exists and is not verified and active. A missing record (a deleted doctor
 * on an old booking) is not judged here; creating a booking already requires an existing doctor.
 */
export async function assertNotIneligibleDoctor(specialistId: unknown): Promise<void> {
  const id = objectIdOrNull(String(specialistId ?? ''));
  const sp = id ? await SpecialistModel.findById(id).select({ isActive: 1, isVerified: 1 }).lean() : null;
  if (sp) assertBookableDoctor(sp);
}

/**
 * Slot reads for patients: consultation slots of a doctor who is not eligible are left out (admins see all; a doctor
 * always sees its own). Package slots (no specialistId) are unaffected.
 */
export async function visibleSlots<T extends { specialistId?: unknown }>(slots: T[], user: AuthRequest['user'] | undefined): Promise<T[]> {
  if (user?.userType === 'admin' || !Array.isArray(slots) || !slots.length) return slots;
  const self = user?.userType === 'specialist' ? String(user.specialistId || user._id).toLowerCase() : '';
  const key = (s: T) => (s.specialistId == null || s.specialistId === '' ? '' : String(s.specialistId).toLowerCase());
  const ids = [...new Set(slots.map(key).filter((k) => k && k !== self))];
  if (!ids.length) return slots;
  const valid = ids.filter((k) => /^[0-9a-f]{24}$/.test(k));
  const eligible = new Set((await SpecialistModel.find({ _id: { $in: valid }, isActive: true, isVerified: true }).select({ _id: 1 }).lean())
    .map((sp) => String(sp._id).toLowerCase()));
  return slots.filter((s) => { const k = key(s); return !k || k === self || eligible.has(k); });
}

/** Whether a doctor is eligible now (a missing record is not). */
export async function doctorIsEligible(specialistId: unknown): Promise<boolean> {
  const id = objectIdOrNull(String(specialistId ?? ''));
  return isEligibleDoctor(id ? await SpecialistModel.findById(id).select({ isActive: 1, isVerified: 1 }).lean() : null);
}

/** Whether the doctor's record exists and is not eligible (a missing record is not judged; see assertNotIneligibleDoctor). */
export async function doctorExistsIneligible(specialistId: unknown): Promise<boolean> {
  const id = objectIdOrNull(String(specialistId ?? '').toLowerCase());
  const sp = id ? await SpecialistModel.findById(id).select({ isActive: 1, isVerified: 1 }).lean() : null;
  return !!sp && !isEligibleDoctor(sp);
}

/**
 * S5 review: what a doctor who is not verified and active still sees of its existing bookings - the booking's id, type,
 * time, mode and status (so the app's lists still render) and the patient's id and name. Never the patient's contact
 * numbers, email or address, the meeting link, the concern, notes, documents, prescription, report or history.
 */
const SAFE_BOOKING_KEYS = ['_id', 'bookingId', 'bookingType', 'userId', 'dependentId', 'specialistId', 'slotId', 'bookingDate',
  'bookingTime', 'status', 'paymentStatus', 'consultationMode', 'serviceMode', 'createdAt', 'updatedAt'];
const SAFE_PATIENT_KEYS = ['_id', 'userId', 'name'];
const pick = (o: unknown, keys: string[]) => (o && typeof o === 'object'
  ? Object.fromEntries(keys.filter((k) => (o as Record<string, unknown>)[k] !== undefined).map((k) => [k, (o as Record<string, unknown>)[k]]))
  : o);
const restrictBooking = (b: unknown) => ({ ...(pick(b, SAFE_BOOKING_KEYS) as object), restricted: true });

/** Shapes answered to doctors: a booking list, one booking, {booking, patient} (detail) and {patient, consultations} (history). */
export function restrictDoctorView(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(restrictBooking);
  if (!data || typeof data !== 'object') return data;
  const d = data as Record<string, unknown>;
  if ('booking' in d || 'patient' in d || 'consultations' in d) {
    return {
      ...(pick(d, SAFE_BOOKING_KEYS) as object), // e.g. an instant consultation's bookingId / status / time
      ...('booking' in d ? { booking: restrictBooking(d.booking) } : {}),
      ...('patient' in d ? { patient: pick(d.patient, SAFE_PATIENT_KEYS) } : {}),
      ...(Array.isArray(d.consultations) ? { consultations: d.consultations.map(restrictBooking) } : {}),
      restricted: true,
    };
  }
  return restrictBooking(d);
}

/**
 * Routes that answer a doctor with its bookings and patients - reads and commands alike (S5f: a cancel of an already
 * cancelled booking answered the full booking, a free repeatable read): for a doctor that is not verified and active the
 * answer's `data` is reduced by restrictDoctorView, whatever the method. Every other caller, and eligible doctors, get
 * the answer unchanged.
 */
export const restrictIneligibleDoctorReads = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  if (req.user?.userType !== 'specialist' || await doctorIsEligible(doctorIdOf(req))) { next(); return; }
  const json = res.json.bind(res);
  res.json = ((body: unknown) => json(body && typeof body === 'object' && 'data' in (body as object)
    ? { ...(body as object), data: restrictDoctorView((body as { data: unknown }).data) }
    : body)) as Response['json'];
  next();
};
