import { Request, Response } from 'express';
import { actorOf as partnerActorOf } from '@/modules/partners/controller';
import { createAssistedConsultation } from '@/modules/assisted/consultations';
import { abandonByKey, cancelByBooker, findByKey, listDoctors, listDoctorSlots, lookupPatient, rescheduleByBooker } from '@/modules/assisted/pharmacyCommands';
import { getBookerBooking, listBookerBookings } from '@/modules/assisted/services/pharmacyBookings';
import type { LabBooker } from '@/modules/assisted/bookers';

/**
 * Round 2e (§24.8.2): a LAB member books a doctor consultation for a walk-in patient — the pharmacy's commands, with the
 * member as the booker (`assisted.book`, its branch scope). Answers are `{ success, data }`; nothing here is cached.
 * `branchId` (body of the create, query of the doctor reads) is the member's branch: "nearby" and `bookedBy.branchId`.
 */
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const labBookerOf = (req: Request, branchId?: unknown): LabBooker => {
  const actor = partnerActorOf(req);
  return { kind: 'lab', partnerId: lower(actor.partnerId), memberId: lower(actor.memberId), branchId: lower(branchId), actor };
};
const send = (res: Response, data: unknown, status = 200, extra: Record<string, unknown> = {}) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(status).json({ success: true, data, ...extra });
};

export const lookup = async (req: Request, res: Response) => send(res, await lookupPatient(labBookerOf(req), req.body?.phone));
export const doctors = async (req: Request, res: Response) => send(res, await listDoctors(labBookerOf(req, req.query.branchId), req.query as never));
export const doctorSlots = async (req: Request, res: Response) =>
  send(res, await listDoctorSlots(labBookerOf(req, req.query.branchId), req.params.doctorId, req.query as never));
export const createConsultation = async (req: Request, res: Response) => {
  const out = await createAssistedConsultation(labBookerOf(req, req.body?.branchId), req.body);
  send(res, out, out.replayed ? 200 : 201);
};
export const bookings = async (req: Request, res: Response) => {
  const r = await listBookerBookings(labBookerOf(req), req.query as never);
  send(res, r.items, 200, { pagination: { total: r.total, nextCursor: r.nextCursor } });
};
export const booking = async (req: Request, res: Response) => send(res, await getBookerBooking(labBookerOf(req), req.params.id));
export const byKey = async (req: Request, res: Response) => send(res, await findByKey(labBookerOf(req), req.params.key));
export const abandonKey = async (req: Request, res: Response) => send(res, await abandonByKey(labBookerOf(req), req.params.key));
export const cancel = async (req: Request, res: Response) => send(res, await cancelByBooker(labBookerOf(req), req.params.id, req.body ?? {}));
export const reschedule = async (req: Request, res: Response) => send(res, await rescheduleByBooker(labBookerOf(req), req.params.id, req.body));
