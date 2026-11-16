import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';
import { actorOf } from '@/modules/partners/controller';
import { LabBookingService } from '@/modules/partners/services/labBookings';
import {
  saveSlotTemplate, getSlotTemplate, addManualSlot, setSlotCapacity, setSlotClosed, listSlotsForPartner,
} from '@/modules/partners/services/slots';

const svc = () => Container.get(LabBookingService);
const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });

// ── Workspace: slots ──
const ev = (req: Request) => (req.body && req.body.expectedVersion !== undefined ? Number(req.body.expectedVersion) : undefined);
export const putSlotTemplate = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await saveSlotTemplate(actorOf(req), req.params.branchId, req.params.visitMode as any, req.body));
/** Q11: the saved weekly template (null when none). */
export const getSlotTemplateHandler = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await getSlotTemplate(actorOf(req), req.params.branchId, req.params.visitMode as any));
export const postManualSlot = async (req: Request, res: Response, _n: NextFunction) => {
  const { replayed, ...slot } = await addManualSlot(actorOf(req), req.body) as any;
  ok(res, slot, replayed ? 200 : 201);
};
export const putSlotCapacity = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await setSlotCapacity(actorOf(req), req.params.slotId, req.body.capacity));
export const closeSlot = async (req: Request, res: Response, _n: NextFunction) => ok(res, await setSlotClosed(actorOf(req), req.params.slotId, true));
export const reopenSlot = async (req: Request, res: Response, _n: NextFunction) => ok(res, await setSlotClosed(actorOf(req), req.params.slotId, false));
export const getPartnerSlots = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await listSlotsForPartner(actorOf(req), String(req.query.branchId), req.query.visitMode as any, String(req.query.from), String(req.query.to)));

// ── Workspace: lab bookings ──
/** Q11: paged (exact cursor), soonest first; data stays an array, plus pagination {total, nextCursor}. */
export const listLabBookings = async (req: Request, res: Response, _n: NextFunction) => {
  const r = await svc().listForPartnerPage(actorOf(req), req.query as any);
  res.status(200).json({ success: true, data: r.items, pagination: { total: r.total, nextCursor: r.nextCursor } });
};
export const getLabBooking = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().getForPartner(actorOf(req), req.params.bookingId));
export const assignCollector = async (req: Request, res: Response, _n: NextFunction) => {
  const { expectedVersion: _e, ...collector } = req.body;
  ok(res, await svc().assignCollector(actorOf(req), req.params.bookingId, collector, ev(req)));
};
export const markCollected = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().markCollected(actorOf(req), req.params.bookingId, ev(req)));
export const markVisited = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().markVisited(actorOf(req), req.params.bookingId, ev(req)));
export const markNoShow = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().markNoShow(actorOf(req), req.params.bookingId, new Date(), ev(req)));
export const startProcessing = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().startProcessing(actorOf(req), req.params.bookingId, ev(req)));
export const completeLabBooking = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().complete(actorOf(req), req.params.bookingId, ev(req)));
export const rejectLabBooking = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().labReject(actorOf(req), req.params.bookingId, req.body.reason, new Date(), ev(req)));
export const rescheduleLabBooking = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().labReschedule(actorOf(req), req.params.bookingId, req.body.slotId, req.body.reason, new Date(), ev(req)));
/** multipart/form-data `files`: written under the booking's report folder and attached as drafts in one step (Q11: ?requestKey=). */
export const uploadLabReports = async (req: Request, res: Response, _n: NextFunction) => {
  const key = typeof req.query.requestKey === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(req.query.requestKey) ? req.query.requestKey : undefined;
  if (req.query.requestKey !== undefined && !key) throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'requestKey must be 8 to 100 letters, digits, - or _' });
  const { replayed, ...view } = await svc().uploadReportFiles(actorOf(req), req.params.bookingId, req, key) as any;
  ok(res, view, replayed ? 200 : 201);
};
export const releaseLabReport = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().releaseReport(actorOf(req), req.params.bookingId, req.body.file, req.body.signerMemberId, new Date(), ev(req)));
/** Q11: remove a draft report uploaded by mistake. */
export const removeDraftLabReport = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().removeDraftReport(actorOf(req), req.params.bookingId, req.body.file));

/** Admin: lab bookings across every partner — Q11: paged, dated, the partner view. */
export const adminListLabBookings = async (req: Request, res: Response, _n: NextFunction) => {
  const r = await svc().adminList(req.query as any);
  res.status(200).json({ success: true, data: r.items, pagination: { page: r.page, limit: r.limit, total: r.total, totalPages: r.totalPages } });
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
export const myLabBookings = async (req: Request, res: Response, _n: NextFunction) => {
  const r = await svc().listForCustomer(customerId(req), Number(req.query.page) || 1, Number(req.query.limit) || 20);
  res.status(200).json({ success: true, data: r.items, pagination: { page: r.page, limit: r.limit, total: r.total, totalPages: r.totalPages } });
};
export const labProfile = async (req: Request, res: Response, _n: NextFunction) => { customerId(req); ok(res, await svc().labProfile(req.params.partnerId)); };
export const myLabBooking = async (req: Request, res: Response, _n: NextFunction) => ok(res, await svc().getForCustomer(customerId(req), req.params.bookingId));
export const payLabBookingAgain = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().retryPayment(customerId(req), req.params.bookingId, !!req.body?.useWalletBalance));
export const cancelMyLabBooking = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().customerCancel(customerId(req), req.params.bookingId, req.body?.note));
export const acceptLabReschedule = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await svc().acceptReschedule(customerId(req), req.params.bookingId, req.body.version));
