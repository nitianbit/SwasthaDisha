import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '@/modules/middleware/auth';
import { getTemplate, saveTemplate, setLeave } from '@/modules/doctors/services/schedule';

const doctorOf = (req: Request) => String((req as AuthRequest).user!.specialistId || (req as AuthRequest).user!._id);
const ok = (res: Response, data: unknown) => res.status(200).json({ success: true, data });

export const getMySchedule = async (req: Request, res: Response, _n: NextFunction) => ok(res, await getTemplate(doctorOf(req)));
export const putMySchedule = async (req: Request, res: Response, _n: NextFunction) => ok(res, await saveTemplate(doctorOf(req), req.body));
export const addMyLeave = async (req: Request, res: Response, _n: NextFunction) => ok(res, await setLeave(doctorOf(req), req.body.date, true));
export const removeMyLeave = async (req: Request, res: Response, _n: NextFunction) => ok(res, await setLeave(doctorOf(req), req.params.date, false));
