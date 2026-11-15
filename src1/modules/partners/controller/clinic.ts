import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '@/modules/middleware/auth';
import { actorOf } from '@/modules/partners/controller';
import * as c from '@/modules/partners/services/clinic';

const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });

// ── Clinic workspace (members; admins as owner) ──
export const clinicDoctors = async (req: Request, res: Response, _n: NextFunction) => ok(res, await c.listClinicDoctors(actorOf(req)));
export const clinicInvites = async (req: Request, res: Response, _n: NextFunction) => ok(res, await c.listInvites(actorOf(req), req.query.state as any));
export const inviteDoctor = async (req: Request, res: Response, _n: NextFunction) => {
  const r = await c.inviteDoctor(actorOf(req), req.body);
  ok(res, r, r.created ? 201 : 200);
};
export const revokeInvite = async (req: Request, res: Response, _n: NextFunction) => ok(res, await c.revokeInvite(actorOf(req), req.params.inviteId));
export const deskSlots = async (req: Request, res: Response, _n: NextFunction) => ok(res, await c.deskSlots(actorOf(req), req.query as any));
export const clinicAppointments = async (req: Request, res: Response, _n: NextFunction) => ok(res, await c.listClinicAppointments(actorOf(req), req.query as any));
export const bookDesk = async (req: Request, res: Response, _n: NextFunction) => {
  const r = await c.createDeskAppointment(actorOf(req), req.body);
  ok(res, r, r.replayed ? 200 : 201);
};
export const deskArrived = async (req: Request, res: Response, _n: NextFunction) => ok(res, await c.markArrived(actorOf(req), req.params.bookingId));
export const deskComplete = async (req: Request, res: Response, _n: NextFunction) => ok(res, await c.closeDeskAppointment(actorOf(req), req.params.bookingId, 'completed'));
export const deskNoShow = async (req: Request, res: Response, _n: NextFunction) => ok(res, await c.closeDeskAppointment(actorOf(req), req.params.bookingId, 'no_show'));
export const deskCancel = async (req: Request, res: Response, _n: NextFunction) => ok(res, await c.cancelDeskAppointment(actorOf(req), req.params.bookingId, req.body?.reason));
export const deskReschedule = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await c.rescheduleDeskAppointment(actorOf(req), req.params.bookingId, req.body.slotId));

// ── Doctor (specialist portal) ──
const doctorOf = (req: Request) => String((req as AuthRequest).user!.specialistId || (req as AuthRequest).user!._id);
export const myClinics = async (req: Request, res: Response, _n: NextFunction) => ok(res, await c.myClinics(doctorOf(req)));
export const acceptInvite = async (req: Request, res: Response, _n: NextFunction) => ok(res, await c.respondToInvite(doctorOf(req), req.params.inviteId, true));
export const declineInvite = async (req: Request, res: Response, _n: NextFunction) => ok(res, await c.respondToInvite(doctorOf(req), req.params.inviteId, false));
export const leaveClinic = async (req: Request, res: Response, _n: NextFunction) => ok(res, await c.leaveClinic(doctorOf(req), req.params.partnerId));
export const getMyPractice = async (req: Request, res: Response, _n: NextFunction) => ok(res, await c.mySoloPractice(doctorOf(req)));
export const createMyPractice = async (req: Request, res: Response, _n: NextFunction) => {
  const r = await c.createSoloPractice(doctorOf(req), req.body);
  ok(res, r, r.created ? 201 : 200);
};
