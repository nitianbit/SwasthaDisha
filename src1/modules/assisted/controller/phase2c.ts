import { Request, Response } from 'express';
import { actorOf } from '@/modules/partners/controller';
import { abandonDeskByKey, cancelDeskBooking, createDeskBooking, findDeskByKey, lookupDeskPatient } from '@/modules/assisted/labDesk';

/** r12 (§24.6.2): lab front desk controllers (members and admins acting as owner). `{ success, data }`; nothing is cached. */
const send = (res: Response, data: unknown, status = 200) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(status).json({ success: true, data });
};

export const deskLookup = async (req: Request, res: Response) => send(res, await lookupDeskPatient(actorOf(req), req.body.phone));
export const deskCreate = async (req: Request, res: Response) => {
  const out = await createDeskBooking(actorOf(req), req.body);
  send(res, out, out.replayed ? 200 : 201);
};
export const deskByKey = async (req: Request, res: Response) => send(res, await findDeskByKey(actorOf(req), req.params.key));
export const deskAbandonKey = async (req: Request, res: Response) => send(res, await abandonDeskByKey(actorOf(req), req.params.key));
export const deskCancel = async (req: Request, res: Response) => send(res, await cancelDeskBooking(actorOf(req), req.params.bookingId, req.body ?? {}));
