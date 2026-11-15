import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';
import { InstantConsultService } from '@/modules/doctors/services/instant';

const svc = () => Container.get(InstantConsultService);
const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });
const doctorOf = (req: Request) => String((req as AuthRequest).user!.specialistId || (req as AuthRequest).user!._id);
function customerId(req: Request): string {
  const u = (req as AuthRequest).user;
  if (!u || u.userType !== 'user') throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Individual customer access required' });
  return String(u._id);
}

// ── Doctor ──
export const putPresence = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().setPresence(doctorOf(req), req.body));
export const postHeartbeat = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().heartbeat(doctorOf(req)));
export const getOffers = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().myOffers(doctorOf(req)));
export const acceptOffer = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().accept(doctorOf(req), req.params.requestId), 201);
export const extendConsult = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().extend(doctorOf(req), req.params.bookingId, req.body.minutes));

// ── Customer ──
export const onlineDoctors = async (req: Request, res: Response, _n: NextFunction) => {
  customerId(req);
  ok(res, await svc().onlineDoctors({ specialization: String(req.query.specialization), mode: req.query.mode as any }));
};
export const getQuote = async (req: Request, res: Response, _n: NextFunction) => {
  customerId(req);
  ok(res, await svc().quote({ specialization: String(req.query.specialization), mode: req.query.mode as any, doctorId: req.query.doctorId as string | undefined }));
};
export const createRequest = async (req: Request, res: Response, _n: NextFunction) => {
  const userId = customerId(req);
  const corporateId = (req as AuthRequest).user?.corporateId;
  ok(res, await svc().create(userId, req.body, new Date(), { corporateId: typeof corporateId === 'string' ? corporateId : undefined }), 201);
};
export const myRequests = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().listForCustomer(customerId(req)));
export const myRequest = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().getForCustomer(customerId(req), req.params.requestId));
export const payRequest = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().payAgain(customerId(req), req.params.requestId, !!req.body?.useWalletBalance));
export const reofferRequest = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().reoffer(customerId(req), req.params.requestId, req.body.target));
export const requestActivity = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().activity(customerId(req), req.params.requestId));
export const refundRequest = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().requestRefund(customerId(req), req.params.requestId));

// ── Admin ──
export const adminCancelInstant = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().cancelAccepted(req.params.bookingId, { _id: String((req as AuthRequest).user!._id), userType: 'admin' }, req.body.reason));
