import { NextFunction, Response } from 'express';
import type { AuthRequest } from '@/modules/middleware/auth';
import type { IBooking } from '@/modules/bookings/types';
import logger from '@/services/logger';

/**
 * S4: a booking's `prescription` and `report` are server-owned. Only the doctor's prescription endpoint
 * (POST /specialists/me/appointments/:id/prescription, which also sets lifecycle.prescriptionUploaded) and an admin edit
 * (PUT /bookings/:id) write them. A create body never carries them: the create schemas no longer accept them and the
 * service does not copy them; this middleware drops them first so the dropped request is logged (field names, role and
 * route only; no ids or content), and an older client sending them still gets its booking.
 * Patient-uploaded files stay in `documents[]` (type report / prescription / other); they are the patient's own records.
 */
export const SERVER_OWNED_CREATE_FIELDS = ['prescription', 'report'] as const;
const CREATE_PATHS = new Set(['/', '/specialist', '/wellness-package']);

export function dropServerOwnedCreateFields(req: AuthRequest, _res: Response, next: NextFunction): void {
  const route = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
  const body = req.body as Record<string, unknown> | undefined;
  if (req.method === 'POST' && CREATE_PATHS.has(route) && body && typeof body === 'object') {
    const dropped = SERVER_OWNED_CREATE_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(body, key));
    if (dropped.length) {
      for (const key of dropped) delete body[key];
      logger.warn('[Booking][S4] server-owned fields dropped from a booking create', { fields: dropped, userType: req.user?.userType, route });
    }
  }
  next();
}

/**
 * S4: whether the booking's prescription is the one its own doctor saved: the server marker is set and the prescriber is
 * the booking's specialist. A prescription without the marker (written by a client before S4) is not the doctor's.
 */
export function hasDoctorPrescription(booking: Pick<IBooking, 'prescription' | 'lifecycle' | 'specialistId'> | null | undefined): boolean {
  if (!booking?.prescription || !booking.lifecycle?.prescriptionUploaded?.at || !booking.specialistId) return false;
  return String(booking.prescription.prescribedBySpecialistId ?? '') === String(booking.specialistId);
}
