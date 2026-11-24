import { Response } from 'express';
import { AuthRequest } from '@/modules/middleware/auth';
import type { PharmacyActor } from '@/modules/assisted/consultations';
import {
  abandonInstantByKey, createPharmacyInstant, findInstantByKey, getInstantForPharmacy, instantActivityByBooker, instantDoctorsForPharmacy,
  instantQuoteForPharmacy, instantSpecialitiesForPharmacy, listInstantForPharmacy, refundInstantByBooker, reofferInstantByBooker,
} from '@/modules/assisted/instant';

/** r17 (§25.8.3): pharmacy → instant "Consult now" controllers. Answers are `{ success, data }`; nothing here is cached. */
const actorOf = (req: AuthRequest): PharmacyActor => ({ pharmacyId: String(req.user?.pharmacyId || req.user?._id || ''), actorId: String(req.user?._id || '') });
const send = (res: Response, data: unknown, status = 200, extra: Record<string, unknown> = {}) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(status).json({ success: true, data, ...extra });
};

export const specialities = async (req: AuthRequest, res: Response) => send(res, await instantSpecialitiesForPharmacy(actorOf(req), req.query.mode as never));
export const doctors = async (req: AuthRequest, res: Response) => send(res, await instantDoctorsForPharmacy(actorOf(req), req.query as never));
export const quote = async (req: AuthRequest, res: Response) => send(res, await instantQuoteForPharmacy(actorOf(req), req.query as never));
export const createRequest = async (req: AuthRequest, res: Response) => {
  const out = await createPharmacyInstant(actorOf(req), req.body);
  send(res, out, out.replayed ? 200 : 201);
};
export const listRequests = async (req: AuthRequest, res: Response) => {
  const r = await listInstantForPharmacy(actorOf(req), req.query as never);
  send(res, r.items, 200, { pagination: { total: r.total, nextCursor: r.nextCursor } });
};
export const getRequest = async (req: AuthRequest, res: Response) => send(res, await getInstantForPharmacy(actorOf(req), req.params.id));
export const byKey = async (req: AuthRequest, res: Response) => send(res, await findInstantByKey(actorOf(req), req.params.key));
export const abandonKey = async (req: AuthRequest, res: Response) => send(res, await abandonInstantByKey(actorOf(req), req.params.key));
export const reoffer = async (req: AuthRequest, res: Response) => send(res, await reofferInstantByBooker(actorOf(req), req.params.id, req.body));
export const activity = async (req: AuthRequest, res: Response) => send(res, await instantActivityByBooker(actorOf(req), req.params.id));
export const refund = async (req: AuthRequest, res: Response) => send(res, await refundInstantByBooker(actorOf(req), req.params.id, req.body));
