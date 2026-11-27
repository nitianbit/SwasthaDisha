import { Response } from 'express';
import { Types } from 'mongoose';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';
import { createAssistedConsultation, type PharmacyActor } from '@/modules/assisted/consultations';
import { abandonByKey, cancelByBooker, findByKey, listDoctors, listDoctorSlots, lookupPatient, rescheduleByBooker } from '@/modules/assisted/pharmacyCommands';
import { dismissReviewItem, listReviewItems, moveAssistedBooking, reportNotMine } from '@/modules/assisted/review';
import { runReconciliation, stuckMoney, uncreditedTopups } from '@/modules/assisted/reconciliation';
import { AssistedAlertModel, AssistedReconciliationReportModel } from '@/modules/assisted/model';
import { assertAdminToolsOn } from '@/modules/assisted/flags';
import { auditIn } from '@/modules/assisted/support';
import { inTransaction } from '@/modules/partners/services';
import { pharmacyStore, recordChargebackIn } from '@/modules/pharmacyWallet/ledger';
import { closeTopupCompensatedIn, recordTopupChargebackIn, recoverTopupIn, resolveTopupRecord, setFrozenIn, type TopupKind } from '@/modules/pharmacyWallet/walletCore';
import { lotsOf } from '@/modules/pharmacyWallet/walletLots';
import { TOPUP_KINDS, topupKindOf, topupKindOfWallet } from '@/modules/partnerWallets/topupKinds';
import { raiseAlertIn } from '@/modules/assisted/limits';
import { PaymentRecordModel } from '@/modules/payment/model';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { requestHashOf } from '@/modules/common/utils/canonicalJson';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import { WalletTopupLotModel } from '@/modules/pharmacyWallet/model/lots';
import BookingModel from '@/modules/bookings/model';
import type { IBooking } from '@/modules/bookings/types';
import PharmacyModel from '@/modules/pharmacies/model';
import { cardRefundById, cardRefundQueue, cardRefundToWallet, markCardRefundFailed, recheckCardRefund, recordCardChargeback } from '@/modules/assisted/cardRefunds';

/** Assisted booking phase 1a controllers (§17.6). Answers are `{ success, data }`; nothing here is cached. */
export const actorOf = (req: AuthRequest): PharmacyActor => ({ pharmacyId: String(req.user?.pharmacyId || req.user?._id || ''), actorId: String(req.user?._id || '') });
const send = (res: Response, data: unknown, status = 200) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(status).json({ success: true, data });
};

// ── Pharmacy ──
export const lookup = async (req: AuthRequest, res: Response) => send(res, await lookupPatient(actorOf(req), req.body?.phone));
export const doctors = async (req: AuthRequest, res: Response) => send(res, await listDoctors(actorOf(req), req.query as never));
export const doctorSlots = async (req: AuthRequest, res: Response) =>
  send(res, await listDoctorSlots(actorOf(req), req.params.doctorId, req.query as never));
export const createConsultation = async (req: AuthRequest, res: Response) => {
  const out = await createAssistedConsultation(actorOf(req), req.body);
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
    // r13: the shared freeze (a wallet that owes a receivable stays frozen until a credit has cleared it).
    const updated = await setFrozenIn(pharmacyStore(pharmacyId), frozen, reason, s);
    await auditIn({ actorKind: 'admin', actorId: String(req.user?._id).toLowerCase(), orgKind: 'pharmacy', orgId: pharmacyId.toLowerCase(),
      action: frozen ? 'wallet.frozen' : 'wallet.unfrozen', detail: { reason } }, s);
    return updated;
  });
  send(res, wallet);
};

/** GET /admin/pharmacies/:id/wallet/lots — the pharmacy's top-up lots (to pick the one a chargeback is for). */
export const lots = async (req: AuthRequest, res: Response) => send(res, await lotsOf({ kind: 'pharmacy', id: req.params.id }));

/** The top-up a lot belongs to (the lot routes): its kind and payment record; anything else is the one 404. */
async function lotTopup(lotId: string): Promise<{ kind: TopupKind; paymentRecordId: string }> {
  const lot = Types.ObjectId.isValid(lotId) ? await WalletTopupLotModel.findById(lotId).select({ walletRef: 1, paymentRecordId: 1 }).lean() : null;
  const kind = lot ? topupKindOfWallet(lot.walletRef.kind) : null;
  if (!lot || !kind) throw new AppError({ status: 404, code: 'LOT_NOT_FOUND', message: 'Top-up not found' });
  return { kind, paymentRecordId: lot.paymentRecordId };
}
/** A top-up named by its payment (record id, Razorpay order id or payment id; it may ask the gateway, read only). */
async function paymentTopup(paymentId: string): Promise<{ kind: TopupKind; paymentRecordId: string }> {
  const { Container } = await import('typedi');
  const { PaymentService } = await import('@/modules/payment/services');
  return resolveTopupRecord(paymentId, TOPUP_KINDS, (id) => Container.get(PaymentService).gatewayOrderIdOfPayment(id));
}

/**
 * POST /admin/wallet-lots/:lotId/chargeback { reason } — a card dispute lost on a top-up lot. Its kind's rule decides
 * (`kind.chargeback()`): a pharmacy lot is charged back (the lot closed for good, the wallet debited, a shortfall owed as
 * `receivableMinor`, frozen, audited; once per lot) — r32b: unless WALLET_CHARGEBACK_FLAG_ONLY is on; lab and doctor lots
 * (and the pharmacy's with the switch on) are flagged only, and the admin takes the money back with Recover (below).
 */
export const chargeback = async (req: AuthRequest, res: Response) => {
  assertAdminToolsOn();
  const reason = String(req.body.reason).trim();
  const lot = Types.ObjectId.isValid(req.params.lotId)
    ? await WalletTopupLotModel.findById(req.params.lotId).select({ walletRef: 1, paymentRecordId: 1 }).lean() : null;
  const kind = lot ? topupKindOfWallet(lot.walletRef.kind) : null;
  if (lot && kind?.chargeback() === 'flag') return send(res, await topupChargeback(kind, lot.paymentRecordId, String(req.user?._id).toLowerCase(), reason));
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
 * and the same once-per-payment key as the lot route (a top-up with a lot is charged back through its lot). Review of
 * db252c1 (item a): a top-up never credited is blocked instead (200, `blockedUncredited: true`, `credited: false`).
 */
export const paymentChargeback = async (req: AuthRequest, res: Response) => {
  assertAdminToolsOn();
  const { kind, paymentRecordId } = await paymentTopup(req.params.paymentId);
  send(res, await topupChargeback(kind, paymentRecordId, String(req.user?._id).toLowerCase(), String(req.body.reason).trim()));
};

/**
 * r32 (§26.8.4): POST /admin/wallet-lots/:lotId/recover and /admin/wallet-payments/:paymentId/recover { reason, requestKey }
 * — after a lost dispute was recorded, the admin takes the money back explicitly (`recoverTopupIn`): the wallet is debited up
 * to its balance, the shortfall is owed as a receivable and the wallet is frozen. Exactly once per top-up (a repeat
 * answers replayed); the request key is recorded in the audit. 409 DISPUTE_NOT_RECORDED before a chargeback was recorded.
 */
export const recoverLot = async (req: AuthRequest, res: Response) => {
  assertAdminToolsOn();
  const { kind, paymentRecordId } = await lotTopup(req.params.lotId);
  send(res, await topupRecover(kind, paymentRecordId, String(req.user?._id).toLowerCase(), req.body));
};
export const recoverPayment = async (req: AuthRequest, res: Response) => {
  assertAdminToolsOn();
  const { kind, paymentRecordId } = await paymentTopup(req.params.paymentId);
  send(res, await topupRecover(kind, paymentRecordId, String(req.user?._id).toLowerCase(), req.body));
};

/** Recover in one transaction with its audit `wallet.recovered`; a racing twin that inserted the payment's lot first runs once more. */
async function topupRecover(kind: TopupKind, paymentRecordId: string, actorId: string, body: { reason: string; requestKey: string }) {
  const run = () => inTransaction(async (s) => {
    const r = await recoverTopupIn(kind, paymentRecordId, s);
    if (!r.replayed) {
      const e = r.entry as Record<string, any>;
      await auditIn({ actorKind: 'admin', actorId, orgKind: kind.kind, orgId: r.ownerId, action: 'wallet.recovered', requestKey: body.requestKey,
        detail: { lotId: r.lotId, paymentRecordId, withoutLot: r.withoutLot, ...(r.compensated ? { compensated: true } : {}), reason: String(body.reason).trim(),
          debitedMinor: Number(e.amountPaise ?? Math.abs(Number(e.amountMinor ?? 0))), receivableDeltaMinor: Number(e.receivableDeltaPaise ?? e.receivableDeltaMinor ?? 0) } }, s);
    }
    return r;
  });
  let out: Awaited<ReturnType<typeof run>>;
  try { out = await run(); } catch (e) {
    if (!isDuplicateKeyError(e)) throw e;
    out = await run();
  }
  return { recovered: true, replayed: out.replayed, entry: out.entry, wallet: out.wallet, lotId: out.lotId, paymentRecordId: out.paymentRecordId,
    walletKind: kind.kind, [kind.ownerField]: out.ownerId, withoutLot: out.withoutLot, ...(out.compensated ? { compensated: true } : {}) };
}

/**
 * A lost card dispute on a top-up (`recordTopupChargebackIn`), audited `wallet.chargeback` in the same transaction (a
 * flagged one also raises the alert `wallet_topup_chargeback`). A racing twin that inserted the payment's lot first: this
 * attempt runs once more and answers replayed.
 */
async function topupChargeback(kind: TopupKind, paymentRecordId: string, actorId: string, reason: string) {
  const run = () => inTransaction(async (s) => {
    const r = await recordTopupChargebackIn(kind, paymentRecordId, s);
    if (r.replayed) return r;
    const audit = (detail: Record<string, unknown>) => auditIn({ actorKind: 'admin', actorId, orgKind: kind.kind, orgId: r.ownerId, action: 'wallet.chargeback', detail }, s);
    if (r.outcome === 'blocked') {
      await audit({ paymentRecordId, blockedUncredited: true, reason, debitedPaise: 0 });
    } else if (r.outcome === 'flagged') {
      await audit({ paymentRecordId, lotId: r.lotId, flaggedOnly: true, ...(r.compensated ? { compensated: true } : {}), reason, debitedPaise: 0 });
      await raiseAlertIn({ kind: 'wallet_topup_chargeback', subject: `${kind.kind}:${paymentRecordId}`,
        detail: { walletKind: kind.kind, ownerId: r.ownerId, paymentRecordId, lotId: r.lotId } }, s);
    } else {
      const e = r.entry as Record<string, any>;
      await audit({ lotId: r.lotId, paymentRecordId, withoutLot: r.withoutLot, ...(r.compensated ? { compensated: true } : {}), reason,
        debitedPaise: e.amountPaise, receivableDeltaPaise: e.receivableDeltaPaise });
    }
    return r;
  });
  let out: Awaited<ReturnType<typeof run>>;
  try { out = await run(); } catch (e) {
    if (!isDuplicateKeyError(e)) throw e;
    out = await run();
  }
  if (out.outcome === 'blocked') {
    return { blockedUncredited: true, credited: false, replayed: out.replayed, paymentRecordId: out.paymentRecordId,
      message: 'Nothing was credited for this top-up, so nothing was taken from the wallet. The top-up is now blocked and will never be credited.' };
  }
  if (out.outcome === 'flagged') {
    return { blockedUncredited: false, flagged: true, credited: true, replayed: out.replayed, paymentRecordId: out.paymentRecordId, lotId: out.lotId,
      walletKind: kind.kind, [kind.ownerField]: out.ownerId, ...(out.compensated ? { compensated: true } : {}),
      message: 'Recorded and flagged only: nothing was taken from the wallet and it was not frozen; this card money is no longer withdrawable. Recovering the amount is an admin decision.' };
  }
  return { blockedUncredited: false, entry: out.entry, wallet: out.wallet, replayed: out.replayed, lotId: out.lotId, paymentRecordId: out.paymentRecordId,
    withoutLot: out.withoutLot, ...(out.compensated ? { compensated: true } : {}) };
}

/** r9: what the close-compensated route and its by-key read answer (ids, amount in paise, times; no names). r13/r20: a lab or doctor top-up names its owner. */
const closedView = (r: { replayed: boolean; paymentRecordId: string; ownerId: string; amountPaise: number; compensatedAt: Date; status: string },
  kind: Pick<TopupKind, 'kind' | 'ownerField'>) => ({
  closed: true, credited: false, replayed: r.replayed, paymentRecordId: r.paymentRecordId,
  ...(kind.kind === 'pharmacy' ? { pharmacyId: r.ownerId } : { walletKind: kind.kind, [kind.ownerField]: r.ownerId }), amountPaise: r.amountPaise,
  compensatedAt: r.compensatedAt, status: r.status,
  message: `This top-up is closed as already paid to the ${kind.kind} by Jansetu support. It will never be credited to the wallet.`,
});
const COMPENSATION_KEY_INDEX = { 'compensation.requestKey': 1 } as const;
/** A stored closure, as answered to a replay. */
const closureOf = (r: Record<string, any>) => {
  const kind = topupKindOf(r) ?? { kind: 'pharmacy' as const, ownerField: 'pharmacyId', ownerOf: (x: Record<string, any>) => String(x.payerPharmacyId).toLowerCase() };
  return closedView({ replayed: true, paymentRecordId: String(r._id), ownerId: kind.ownerOf(r),
    amountPaise: Number.isSafeInteger(r.baseAmountPaise) ? Number(r.baseAmountPaise) : Math.round(Number(r.baseAmount ?? 0) * 100),
    compensatedAt: r.compensatedAt as Date, status: String(r.status) }, kind);
};

/**
 * POST /admin/wallet-payments/:paymentId/close-compensated { reason, requestKey } — r9 (owner decision): support already
 * paid the pharmacy by hand for a card top-up that never arrived. `paymentId` is the payment record id, the Razorpay order
 * id or the Razorpay payment id (resolved as for the payment chargeback). In one transaction the record is closed
 * (`compensatedAt`, never credited by any path) and audited `wallet.closed_compensated`. Once per (admin, request key)
 * with a content hash (the resolved record and the reason); an already closed top-up answers its closure (replayed).
 * A credited top-up: 409 TOPUP_ALREADY_CREDITED. The unique `compensation.requestKey` index is checked first (503).
 */
export const closeCompensated = async (req: AuthRequest, res: Response) => {
  assertAdminToolsOn();
  const reason = String(req.body.reason).trim();
  const actorId = String(req.user?._id).toLowerCase();
  const requestKey = `${actorId}:${String(req.body.requestKey)}`;
  await assertUniqueIndex(PaymentRecordModel, COMPENSATION_KEY_INDEX);
  const { Container } = await import('typedi');
  const { PaymentService } = await import('@/modules/payment/services');
  const { paymentRecordId, kind } = await resolveTopupRecord(req.params.paymentId, TOPUP_KINDS, (id) => Container.get(PaymentService).gatewayOrderIdOfPayment(id));
  const requestHash = requestHashOf({ paymentRecordId, reason });
  /** The record this (admin, key) already closed: its closure when the content matches, else 409. */
  const byKey = async () => {
    const prior = await PaymentRecordModel.findOne({ 'compensation.requestKey': { $eq: requestKey, $type: 'string' } }).lean() as Record<string, any> | null;
    if (!prior) return null;
    if (prior.compensation?.requestHash !== requestHash) throw new AppError({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED', message: 'This request key was already used for a different close' });
    return closureOf(prior);
  };
  const prior = await byKey();
  if (prior) return send(res, prior);
  const run = () => inTransaction(async (s) => {
    const r = await closeTopupCompensatedIn(kind, paymentRecordId, { by: actorId, reason, requestKey, requestHash }, s);
    if (!r.replayed) {
      await auditIn({ actorKind: 'admin', actorId, orgKind: kind.kind, orgId: r.ownerId, action: 'wallet.closed_compensated',
        requestKey: String(req.body.requestKey), detail: { paymentRecordId: r.paymentRecordId, amountPaise: r.amountPaise, reason } }, s);
    }
    return r;
  });
  try {
    send(res, closedView(await run(), kind));
  } catch (e) {
    // The same key raced on another record (unique `compensation.requestKey`): answered by what that key did.
    if (!isDuplicateKeyError(e)) throw e;
    const raced = await byKey();
    if (!raced) throw e;
    send(res, raced);
  }
};

/** GET /admin/wallet-payments/close-compensated/by-key/:key — did this admin's close with this key happen? (r9) */
export const closeCompensatedByKey = async (req: AuthRequest, res: Response) => {
  assertAdminToolsOn();
  await assertUniqueIndex(PaymentRecordModel, COMPENSATION_KEY_INDEX);
  const requestKey = `${String(req.user?._id).toLowerCase()}:${String(req.params.key)}`;
  const r = await PaymentRecordModel.findOne({ 'compensation.requestKey': { $eq: requestKey, $type: 'string' } }).lean() as Record<string, any> | null;
  if (!r) return send(res, { state: 'not_found' });
  send(res, { state: 'closed', ...closureOf(r) });
};

// ── Phase 1b: card payments of assisted bookings (admin) ──
/** GET /admin/assisted/card-refunds?state&limit — the operator queue (failed, held for review, stuck pending). */
export const cardRefunds = async (req: AuthRequest, res: Response) => send(res, await cardRefundQueue(req.query as never));
/** POST /admin/assisted/card-refunds/:id/to-wallet { agreement } — a failed card refund credited to the partner's wallet. */
export const cardRefundWallet = async (req: AuthRequest, res: Response) => {
  assertAdminToolsOn();
  send(res, await cardRefundToWallet(String(req.user?._id), req.params.id, String(req.body.agreement).trim()));
};
/** POST /admin/assisted-payments/:paymentId/chargeback { reason } — a lost card dispute on a booking payment: recorded and flagged. */
export const cardChargeback = async (req: AuthRequest, res: Response) => {
  assertAdminToolsOn();
  send(res, await recordCardChargeback(String(req.user?._id), req.params.paymentId, String(req.body.reason).trim()));
};
/** r10b: POST /admin/assisted/card-refunds/:id/recheck — ask Razorpay about a card refund now. */
export const cardRefundRecheck = async (req: AuthRequest, res: Response) => send(res, await recheckCardRefund(req.params.id));
/** r10b: POST /admin/assisted/card-refunds/:id/mark-failed { reason } — after reading Razorpay; refused while a refund is live there. */
export const cardRefundMarkFailed = async (req: AuthRequest, res: Response) => {
  assertAdminToolsOn();
  send(res, await markCardRefundFailed(String(req.user?._id), req.params.id, String(req.body.reason).trim()));
};
/** r10e: GET /admin/assisted/card-refunds/:id — one card refund row (the queue's shape, with the paying pharmacy). */
export const cardRefundOne = async (req: AuthRequest, res: Response) => send(res, await cardRefundById(req.params.id));
