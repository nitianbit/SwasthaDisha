import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';
import { actorOf } from '@/modules/partners/controller';
import { LabBookingService } from '@/modules/partners/services/labBookings';
import {
  saveSlotTemplate, addManualSlot, setSlotCapacity, setSlotClosed, listSlotsForPartner,
} from '@/modules/partners/services/slots';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';

const svc = () => Container.get(LabBookingService);
const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });

// ── Workspace: slots ──
export const putSlotTemplate = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await saveSlotTemplate(actorOf(req), req.params.branchId, req.params.visitMode as any, req.body));
export const postManualSlot = async (req: Request, res: Response, _n: NextFunction) => ok(res, await addManualSlot(actorOf(req), req.body), 201);
export const putSlotCapacity = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await setSlotCapacity(actorOf(req), req.params.slotId, req.body.capacity));
export const closeSlot = async (req: Request, res: Response, _n: NextFunction) => ok(res, await setSlotClosed(actorOf(req), req.params.slotId, true));
export const reopenSlot = async (req: Request, res: Response, _n: NextFunction) => ok(res, await setSlotClosed(actorOf(req), req.params.slotId, false));
export const getPartnerSlots = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await listSlotsForPartner(actorOf(req), String(req.query.branchId), req.query.visitMode as any, String(req.query.from), String(req.query.to)));

// ── Workspace: lab bookings ──
export const listLabBookings = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().listForPartner(actorOf(req), req.query as any));
export const getLabBooking = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().getForPartner(actorOf(req), req.params.bookingId));
export const assignCollector = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().assignCollector(actorOf(req), req.params.bookingId, req.body));
export const markCollected = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().markCollected(actorOf(req), req.params.bookingId));
export const markVisited = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().markVisited(actorOf(req), req.params.bookingId));
export const markNoShow = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().markNoShow(actorOf(req), req.params.bookingId));
export const startProcessing = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().startProcessing(actorOf(req), req.params.bookingId));
export const completeLabBooking = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().complete(actorOf(req), req.params.bookingId));
export const rejectLabBooking = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().labReject(actorOf(req), req.params.bookingId, req.body.reason));
export const rescheduleLabBooking = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().labReschedule(actorOf(req), req.params.bookingId, req.body.slotId, req.body.reason));
export const uploadLabReports = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().uploadReports(actorOf(req), req.params.bookingId, req.body.files));
export const releaseLabReport = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().releaseReport(actorOf(req), req.params.bookingId, req.body.file, req.body.signerMemberId));

/** Admin: lab bookings across every partner (filters: partnerId, status). */
export const adminListLabBookings = async (req: Request, res: Response, _n: NextFunction) => {
  const q: Record<string, unknown> = {};
  if (typeof req.query.partnerId === 'string' && /^[0-9a-fA-F]{24}$/.test(req.query.partnerId)) q.partnerId = req.query.partnerId;
  if (typeof req.query.status === 'string') q.status = req.query.status;
  const rows = await PartnerLabBookingModel.find(q).sort({ createdAt: -1 }).limit(200)
    .select({ walletFunding: 0, createRequestKey: 0 }).lean();
  ok(res, rows);
};

// ── Customer ──
function customerId(req: Request): string {
  const u = (req as AuthRequest).user;
  if (!u || u.userType !== 'user') throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Individual customer access required' });
  return String(u._id);
}

export const listLabs = async (req: Request, res: Response, _n: NextFunction) => { customerId(req); ok(res, await svc().listLabs(req.query as any)); };
export const labCatalogue = async (req: Request, res: Response, _n: NextFunction) => {
  customerId(req);
  ok(res, await svc().labCatalogue(req.params.partnerId, req.query.visitMode as any));
};
export const branchSlots = async (req: Request, res: Response, _n: NextFunction) => {
  customerId(req);
  ok(res, await svc().branchSlots(req.params.branchId, req.query.visitMode as any, req.query.from as string | undefined, Number(req.query.days ?? 7)));
};
export const createLabBooking = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().create(customerId(req), req.body), 201);
export const myLabBookings = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().listForCustomer(customerId(req)));
export const myLabBooking = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().getForCustomer(customerId(req), req.params.bookingId));
export const payLabBookingAgain = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().retryPayment(customerId(req), req.params.bookingId, !!req.body?.useWalletBalance));
export const cancelMyLabBooking = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().customerCancel(customerId(req), req.params.bookingId, req.body?.note));
export const acceptLabReschedule = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().acceptReschedule(customerId(req), req.params.bookingId, req.body.version));
