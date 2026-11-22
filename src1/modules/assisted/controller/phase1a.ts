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
import { pharmacyWalletIn, recordChargebackIn, recordPaymentChargebackIn, resolveTopupRecordId } from '@/modules/pharmacyWallet/ledger';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import { WalletTopupLotModel } from '@/modules/pharmacyWallet/model/lots';
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
  send(res, await runReconciliation(new Date(), { full: req.query.full === 'true' }));
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
    // A wallet that owes a receivable (lost card dispute) stays frozen until a credit has cleared it.
    if (!frozen && Number(w.receivableMinor ?? 0) > 0) throw new AppError({ status: 409, code: 'WALLET_RECEIVABLE', message: 'This wallet still owes a receivable' });
    const updated = await PharmacyWalletModel.findOneAndUpdate({ _id: w._id },
      frozen ? { $set: { frozen: true, frozenReason: reason, frozenAt: new Date() }, $inc: { version: 1 } }
        : { $set: { frozen: false }, $unset: { frozenReason: 1, frozenAt: 1 }, $inc: { version: 1 } }, { new: true, session: s }).lean();
    await auditIn({ actorKind: 'admin', actorId: String(req.user?._id).toLowerCase(), orgKind: 'pharmacy', orgId: pharmacyId.toLowerCase(),
      action: frozen ? 'wallet.frozen' : 'wallet.unfrozen', detail: { reason } }, s);
    return updated;
  });
  send(res, wallet);
};

/** GET /admin/pharmacies/:id/wallet/lots — the pharmacy's top-up lots (to pick the one a chargeback is for). */
export const lots = async (req: AuthRequest, res: Response) => send(res, await WalletTopupLotModel.find({ 'walletRef.kind': 'pharmacy',
  'walletRef.id': String(req.params.id).toLowerCase() }).sort({ createdAt: -1 }).limit(200).lean());

/**
 * POST /admin/wallet-lots/:lotId/chargeback { reason } — a card dispute lost on a top-up: the lot is closed for good,
 * the wallet debited (a shortfall is owed as `receivableMinor`), frozen, audited. Once per lot (a repeat answers replayed).
 */
export const chargeback = async (req: AuthRequest, res: Response) => {
  assertAdminToolsOn();
  const reason = String(req.body.reason).trim();
  const out = await inTransaction(async (s) => {
    const r = await recordChargebackIn(req.params.lotId, s);
    if (!r.replayed) {
      await auditIn({ actorKind: 'admin', actorId: String(req.user?._id).toLowerCase(), orgKind: 'pharmacy', orgId: String(r.entry.pharmacyId).toLowerCase(),
        action: 'wallet.chargeback', detail: { lotId: req.params.lotId, reason, debitedPaise: r.entry.amountPaise, receivableDeltaPaise: r.entry.receivableDeltaPaise } }, s);
    }
    return r;
  });
  send(res, { entry: out.entry, wallet: out.wallet, replayed: out.replayed });
};

/**
 * POST /admin/wallet-payments/:paymentId/chargeback { reason } — review of 800dfc0 (item 1): a card dispute lost on a
 * top-up named by its payment (payment record id, Razorpay order id or Razorpay payment id), for top-ups credited without a lot. Same rules
 * and the same once-per-payment key as the lot route (a top-up with a lot is charged back through its lot). Audited in
 * the same transaction. A racing twin that inserted the payment's lot first: this attempt runs once more and answers
 * replayed. Review of db252c1 (item a): a top-up never credited is blocked instead (200, `blockedUncredited: true`,
 * `credited: false`): nothing was in the wallet to take, and it can never be credited now.
 */
export const paymentChargeback = async (req: AuthRequest, res: Response) => {
  assertAdminToolsOn();
  const reason = String(req.body.reason).trim();
  const actorId = String(req.user?._id).toLowerCase();
  // Outside the transaction (it may ask the gateway, read only): the payment record the admin named.
  const { Container } = await import('typedi');
  const { PaymentService } = await import('@/modules/payment/services');
  const paymentRecordId = await resolveTopupRecordId(req.params.paymentId, (id) => Container.get(PaymentService).gatewayOrderIdOfPayment(id));
  const run = () => inTransaction(async (s) => {
    const r = await recordPaymentChargebackIn(paymentRecordId, s);
    if (r.replayed) return r;
    if (r.blockedUncredited) {
      await auditIn({ actorKind: 'admin', actorId, orgKind: 'pharmacy', orgId: r.pharmacyId,
        action: 'wallet.chargeback', detail: { paymentRecordId: r.paymentRecordId, blockedUncredited: true, reason, debitedPaise: 0 } }, s);
    } else {
      await auditIn({ actorKind: 'admin', actorId, orgKind: 'pharmacy', orgId: String(r.entry.pharmacyId).toLowerCase(),
        action: 'wallet.chargeback', detail: { lotId: r.lotId, paymentRecordId: r.paymentRecordId, withoutLot: r.withoutLot, reason,
          debitedPaise: r.entry.amountPaise, receivableDeltaPaise: r.entry.receivableDeltaPaise } }, s);
    }
    return r;
  });
  let out: Awaited<ReturnType<typeof run>>;
  try { out = await run(); } catch (e) {
    if (!isDuplicateKeyError(e)) throw e;
    out = await run();
  }
  if (out.blockedUncredited) {
    return send(res, { blockedUncredited: true, credited: false, replayed: out.replayed, paymentRecordId: out.paymentRecordId,
      message: 'Nothing was credited for this top-up, so nothing was taken from the wallet. The top-up is now blocked and will never be credited.' });
  }
  send(res, { blockedUncredited: false, entry: out.entry, wallet: out.wallet, replayed: out.replayed, lotId: out.lotId, paymentRecordId: out.paymentRecordId,
    withoutLot: out.withoutLot });
};
