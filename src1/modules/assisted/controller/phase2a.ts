import { Response } from 'express';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';
import type { PharmacyActor } from '@/modules/assisted/consultations';
import {
  abandonLabByKey, acceptLabRescheduleByBooker, branchSlotsForPharmacy, cancelLabByBooker, createPharmacyLabBooking, findLabByKey,
  getLabBookingForPharmacy, labCatalogueForPharmacy, listLabBookingsForPharmacy, listLabsForPharmacy,
} from '@/modules/assisted/labBookings';
import { reportLabNotMine } from '@/modules/assisted/review';

/** r11 (§24.4.2): pharmacy → lab test controllers. Answers are `{ success, data }`; nothing here is cached. */
const actorOf = (req: AuthRequest): PharmacyActor => ({ pharmacyId: String(req.user?.pharmacyId || req.user?._id || ''), actorId: String(req.user?._id || '') });
const send = (res: Response, data: unknown, status = 200, extra: Record<string, unknown> = {}) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(status).json({ success: true, data, ...extra });
};

export const labs = async (req: AuthRequest, res: Response) => send(res, await listLabsForPharmacy(actorOf(req), req.query as never));
export const labCatalogue = async (req: AuthRequest, res: Response) =>
  send(res, await labCatalogueForPharmacy(actorOf(req), req.params.partnerId, req.query.visitMode as never));
export const labSlots = async (req: AuthRequest, res: Response) => send(res, await branchSlotsForPharmacy(actorOf(req), req.params.branchId, req.query as never));
export const createLabBooking = async (req: AuthRequest, res: Response) => {
  const out = await createPharmacyLabBooking(actorOf(req), req.body);
  send(res, out, out.replayed ? 200 : 201);
};
export const listLabBookings = async (req: AuthRequest, res: Response) => {
  const r = await listLabBookingsForPharmacy(actorOf(req), req.query as never);
  send(res, r.items, 200, { pagination: { total: r.total, nextCursor: r.nextCursor } });
};
export const getLabBooking = async (req: AuthRequest, res: Response) => send(res, await getLabBookingForPharmacy(actorOf(req), req.params.id));
export const labByKey = async (req: AuthRequest, res: Response) => send(res, await findLabByKey(actorOf(req), req.params.key));
export const abandonLabKey = async (req: AuthRequest, res: Response) => send(res, await abandonLabByKey(actorOf(req), req.params.key));
export const cancelLab = async (req: AuthRequest, res: Response) => send(res, await cancelLabByBooker(actorOf(req), req.params.id, req.body ?? {}));
export const acceptLabReschedule = async (req: AuthRequest, res: Response) =>
  send(res, await acceptLabRescheduleByBooker(actorOf(req), req.params.id, Number(req.body.version)));

/** POST /lab-bookings/:bookingId/not-mine — the account holder flags a lab test a partner booked for them (§17.5). */
export const labNotMine = async (req: AuthRequest, res: Response) => {
  if (req.user?.userType !== 'user') throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Only the account holder can report this' });
  send(res, await reportLabNotMine(String(req.user._id), req.params.bookingId, req.body?.note));
};
