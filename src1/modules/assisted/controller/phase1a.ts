import { Response } from 'express';
import { Types } from 'mongoose';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';
import { createPharmacyConsultation, type PharmacyActor } from '@/modules/assisted/consultations';
import { abandonByKey, cancelByBooker, findByKey, listDoctors, lookupPatient, rescheduleByBooker } from '@/modules/assisted/pharmacyCommands';
import { dismissReviewItem, listReviewItems, moveAssistedBooking, reportNotMine } from '@/modules/assisted/review';
import { runReconciliation, stuckMoney, uncreditedTopups } from '@/modules/assisted/reconciliation';
import { AssistedAlertModel, AssistedReconciliationReportModel } from '@/modules/assisted/model';
import { assertAdminToolsOn } from '@/modules/assisted/flags';
import { auditIn } from '@/modules/assisted/support';
import { inTransaction } from '@/modules/partners/services';
import { pharmacyWalletIn } from '@/modules/pharmacyWallet/ledger';
import { PharmacyWalletModel } from '@/modules/pharmacyWallet/model';
import BookingModel from '@/modules/bookings/model';
import type { IBooking } from '@/modules/bookings/types';
import PharmacyModel from '@/modules/pharmacies/model';

/** Assisted booking phase 1a controllers (§17.6). Answers are `{ success, data }`; nothing here is cached. */
const actorOf = (req: AuthRequest): PharmacyActor => ({ pharmacyId: String(req.user?.pharmacyId || req.user?._id || ''), actorId: String(req.user?._id || '') });
const send = (res: Response, data: unknown, status = 200) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(status).json({ success: true, data });
};

// ── Pharmacy ──
export const lookup = async (req: AuthRequest, res: Response) => send(res, await lookupPatient(actorOf(req), req.body?.phone));
export const doctors = async (req: AuthRequest, res: Response) => send(res, await listDoctors(actorOf(req), req.query as never));
export const createConsultation = async (req: AuthRequest, res: Response) => {
  const out = await createPharmacyConsultation(actorOf(req), req.body);
  send(res, out, out.replayed ? 200 : 201);
};
export const cancel = async (req: AuthRequest, res: Response) => send(res, await cancelByBooker(actorOf(req), req.params.id, req.body ?? {}));
export const reschedule = async (req: AuthRequest, res: Response) => send(res, await rescheduleByBooker(actorOf(req), req.params.id, req.body));
export const byKey = async (req: AuthRequest, res: Response) => send(res, await findByKey(actorOf(req), req.params.key));
export const abandonKey = async (req: AuthRequest, res: Response) => send(res, await abandonByKey(actorOf(req), req.params.key));

// ── Customer ──
export const notMine = async (req: AuthRequest, res: Response) => {
  if (req.user?.userType !== 'user') throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Only the account holder can report this' });
  send(res, await reportNotMine(String(req.user._id), req.params.id, req.body?.note));
};

// ── Admin ──
export const move = async (req: AuthRequest, res: Response) => send(res, await moveAssistedBooking({ _id: String(req.user?._id) }, req.params.id, req.body));
export const reviewItems = async (req: AuthRequest, res: Response) => send(res, await listReviewItems(req.query as never));
export const dismiss = async (req: AuthRequest, res: Response) => send(res, await dismissReviewItem(String(req.user?._id), req.params.id, req.body?.reason));
export const reconciliation = async (req: AuthRequest, res: Response) => {
  const day = typeof req.query.day === 'string' ? req.query.day : undefined;
  if (day) {
    const stored = await AssistedReconciliationReportModel.findOne({ day: { $eq: day } }).lean();
    if (!stored) throw new AppError({ status: 404, code: 'REPORT_NOT_FOUND', message: 'No stored report for that day' });
    return send(res, stored);
  }
  send(res, await runReconciliation());
};
export const stuck = async (_req: AuthRequest, res: Response) => send(res, await stuckMoney());
export const alerts = async (_req: AuthRequest, res: Response) => send(res, await AssistedAlertModel.find({}).sort({ at: -1 }).limit(200).lean());
export const uncredited = async (_req: AuthRequest, res: Response) => send(res, await uncreditedTopups());

/** GET /admin/assisted/meet-guest-check/:id — the neutral invite text and whether the partner device joins as a guest (N6). */
export const meetGuestCheck = async (req: AuthRequest, res: Response) => {
  if (!Types.ObjectId.isValid(req.params.id)) throw new AppError({ status: 404, code: 'BOOKING_NOT_FOUND', message: 'Booking not found' });
  const b = await BookingModel.findById(req.params.id).lean() as IBooking | null;
  if (!b?.assisted) throw new AppError({ status: 404, code: 'BOOKING_NOT_FOUND', message: 'Booking not found' });
  const { meetEventTextFor, assistedBookerEmail } = await import('@/modules/meet/service');
  const text = meetEventTextFor(b, { specialistEmail: 'doctor@invite', bookerEmail: await assistedBookerEmail(b) });
  send(res, { summary: text.summary, description: text.description, attendeeCount: text.attendees.length, guestAccess: text.guestAccess,
    join: b.assisted.join?.on ?? null, meeting: b.virtualMeeting ? { status: b.virtualMeeting.status, hasJoinUrl: !!b.virtualMeeting.joinUrl } : null });
};

/** PUT /admin/pharmacies/:id/wallet/freeze { frozen, reason } — audited; a frozen wallet refuses spending, credits still post. */
export const freeze = async (req: AuthRequest, res: Response) => {
  assertAdminToolsOn();
  const pharmacyId = req.params.id;
  if (!Types.ObjectId.isValid(pharmacyId) || !(await PharmacyModel.exists({ _id: pharmacyId }))) {
    throw new AppError({ status: 404, code: 'PHARMACY_NOT_FOUND', message: 'Pharmacy not found' });
  }
  const frozen = req.body.frozen === true;
  const reason = String(req.body.reason).trim();
  const wallet = await inTransaction(async (s) => {
    const w = await pharmacyWalletIn(pharmacyId, s);
    const updated = await PharmacyWalletModel.findOneAndUpdate({ _id: w._id },
      frozen ? { $set: { frozen: true, frozenReason: reason, frozenAt: new Date() }, $inc: { version: 1 } }
        : { $set: { frozen: false }, $unset: { frozenReason: 1, frozenAt: 1 }, $inc: { version: 1 } }, { new: true, session: s }).lean();
    await auditIn({ actorKind: 'admin', actorId: String(req.user?._id).toLowerCase(), orgKind: 'pharmacy', orgId: pharmacyId.toLowerCase(),
      action: frozen ? 'wallet.frozen' : 'wallet.unfrozen', detail: { reason } }, s);
    return updated;
  });
  send(res, wallet);
};
