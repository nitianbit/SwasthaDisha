import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '@/modules/middleware/auth';
import { getTemplate, saveTemplate, setLeave } from '@/modules/doctors/services/schedule';

const doctorOf = (req: Request) => String((req as AuthRequest).user!.specialistId || (req as AuthRequest).user!._id);
const ok = (res: Response, data: unknown) => res.status(200).json({ success: true, data });

export const getMySchedule = async (req: Request, res: Response, _n: NextFunction) => ok(res, await getTemplate(doctorOf(req)));
export const putMySchedule = async (req: Request, res: Response, _n: NextFunction) => ok(res, await saveTemplate(doctorOf(req), req.body));
export const addMyLeave = async (req: Request, res: Response, _n: NextFunction) => ok(res, await setLeave(doctorOf(req), req.body.date, true));
export const removeMyLeave = async (req: Request, res: Response, _n: NextFunction) => ok(res, await setLeave(doctorOf(req), req.params.date, false));

/** Q14: a no-show moved once to a later slot by the booking's doctor (or an admin): same price, no payment, no refund. */
const noShowInput = (req: Request) => ({ slotId: req.body.slotId, requestKey: req.body.requestKey, expectedUpdatedAt: req.body?.expectedUpdatedAt });
const bookingSvc = async () => {
  const [{ Container }, { BookingService }] = await Promise.all([import('typedi'), import('@/modules/bookings/services')]);
  return Container.get(BookingService);
};
export const rescheduleMyNoShow = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await (await bookingSvc()).rescheduleNoShow(req.params.bookingId, { _id: doctorOf(req), userType: 'specialist' }, noShowInput(req)));
export const adminRescheduleNoShow = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await (await bookingSvc()).rescheduleNoShow(req.params.bookingId, { _id: String((req as AuthRequest).user!._id), userType: 'admin' }, noShowInput(req)));
/** Q16a: an admin cancels a consultation moved after a no-show (the doctor cannot attend), choosing refund or not. */
export const adminCancelNoShow = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await (await bookingSvc()).adminCancelMovedNoShow(req.params.bookingId, { _id: String((req as AuthRequest).user!._id) },
    { reason: req.body.reason, refund: req.body.refund }));
