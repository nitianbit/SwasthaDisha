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
 * Fields an admin checks at verification. Once verified, the doctor cannot change them through self-edit (the admin
 * edit PUT /specialists/:id does). Before verification the doctor fills them in during onboarding.
 */
export const IDENTITY_FIELDS = ['name', 'medicalRegistrationNumber', 'specialization', 'degree'] as const;

const doctorIdOf = (req: AuthRequest) => String(req.user?.specialistId || req.user?._id || '');
const objectIdOrNull = (id: unknown) => (typeof id === 'string' && Types.ObjectId.isValid(id) && /^[0-9a-fA-F]{24}$/.test(id) ? id : null);
const norm = (v: unknown) => (v == null ? '' : String(v).trim());

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
    const changed = sp?.isVerified === true ? sent.filter((f) => norm(body![f]) !== norm(sp[f])) : [];
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
