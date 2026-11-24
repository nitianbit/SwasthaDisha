import { Types } from 'mongoose';
import logger from '@/services/logger';
import { istDateIso } from '@/modules/common/utils/istDate';
import { slotIntervalOf } from '@/modules/common/utils/slotInterval';
import { parseAppointment } from '@/modules/common/utils/cancellationWindow';
import BookingModel from '@/modules/bookings/model';
import type { IBooking } from '@/modules/bookings/types';
import SlotModel from '@/modules/slots/model';
import PaymentRecordModel from '@/modules/payment/model';
import { PharmacyWalletModel, PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { WalletTopupLotModel } from '@/modules/pharmacyWallet/model/lots';
import { refreshWithdrawableIn, withdrawableOfIn } from '@/modules/pharmacyWallet/ledger';
import { LedgerEntryModel } from '@/modules/partners/model/settlement';
import { PartnerLabBookingModel, type IPartnerLabBooking } from '@/modules/partners/model/labBooking';
import { inTransaction } from '@/modules/partners/services';
import { AssistedAlertModel, AssistedReconciliationReportModel } from '@/modules/assisted/model';
import { assistedFlags, assistedLimits } from '@/modules/assisted/flags';
import { raiseAlertIn } from '@/modules/assisted/limits';
import { cardChargebacks, cardRefundQueue, cardRefundsStuckPending } from '@/modules/assisted/cardRefunds';
import { AssistedCardRefundModel } from '@/modules/assisted/model';
import { upcomingMeetsMissing } from '@/modules/meet/retry';
import { InstantRequestModel, type IInstantRequest } from '@/modules/doctors/model/instant';
import { bookerEntriesOf } from '@/modules/assisted/bookerWallet';

/**
 * Assisted booking phase 1a (design §8.2, §8.8, P10): the daily reconciliation and the stuck-money report. Mismatches are
 * REPORTED (and alerted), never fixed. The admin route runs the same checks live (read only); the daily job stores the
 * report for the India day, raises alerts and fills gateway fees of top-up lots.
 */
type Row = Record<string, any>;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const LIST_MAX = 200;

export interface Mismatch { check: string; ref: string; detail: Record<string, unknown> }

/** §8.2: balance = Σ entries; paise = rupees; withdrawable = Σ eligible lots ≤ balance; receivable ⇒ frozen. */
async function walletInvariants(): Promise<{ checked: number; notMigrated: string[]; mismatches: Mismatch[] }> {
  const wallets = await PharmacyWalletModel.find({}).lean() as Row[];
  const mismatches: Mismatch[] = [];
  const notMigrated: string[] = [];
  for (const w of wallets) {
    const pid = String(w.pharmacyId);
    const paise = Number.isSafeInteger(w.balancePaise) ? Number(w.balancePaise) : Math.round(Number(w.balance ?? 0) * 100);
    if (Math.round(Number(w.balance ?? 0) * 100) !== paise) mismatches.push({ check: 'wallet_paise', ref: pid, detail: { balance: w.balance, balancePaise: w.balancePaise } });
    const missing = await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: w.pharmacyId, status: 'completed', signedAmountPaise: { $exists: false } });
    // A wallet with unsigned (pre-1a) rows waits for the migration; one whose rows are all signed (opened by the
    // migration, or created by the 1a ledger) is checked whatever its ledgerOpenedAt says.
    if (missing > 0) { notMigrated.push(pid); continue; }
    const [sum] = await PharmacyWalletTransactionModel.aggregate([{ $match: { pharmacyId: w.pharmacyId, status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$signedAmountPaise' } } }]);
    if (Number(sum?.total ?? 0) !== paise) mismatches.push({ check: 'wallet_balance', ref: pid, detail: { balancePaise: paise, entriesPaise: Number(sum?.total ?? 0) } });
    const withdrawable = await withdrawableOfIn(pid, null);
    if (withdrawable !== Number(w.withdrawableMinor ?? 0) || withdrawable > paise) {
      mismatches.push({ check: 'wallet_withdrawable', ref: pid, detail: { withdrawableMinor: Number(w.withdrawableMinor ?? 0), lotsMinor: withdrawable, balancePaise: paise } });
    }
    if (Number(w.receivableMinor ?? 0) > 0 && w.frozen !== true) mismatches.push({ check: 'wallet_receivable_unfrozen', ref: pid, detail: { receivableMinor: w.receivableMinor } });
  }
  return { checked: wallets.length, notMigrated, mismatches };
}

async function walletsOwing() {
  const rows = await PharmacyWalletModel.find({ $or: [{ receivableMinor: { $gt: 0 } }, { balancePaise: { $lt: 0 } }, { balance: { $lt: 0 } }] })
    .select({ pharmacyId: 1, balancePaise: 1, receivableMinor: 1, frozen: 1 }).limit(LIST_MAX).lean() as Row[];
  return rows.map((w) => ({ pharmacyId: String(w.pharmacyId), balancePaise: Number(w.balancePaise ?? 0), receivableMinor: Number(w.receivableMinor ?? 0),
    frozen: w.frozen === true }));
}

/** §8.8: one funding per paid booking; every refund row posted; provider + cut = base and earned once on completion. */
async function bookingChecks(scope: { since: Date | null; flagged: string[] }): Promise<{ checked: number; mismatches: Mismatch[] }> {
  // Review: the daily run covers bookings changed in the last 7 days plus any already flagged; `full` scans everything.
  const window = scope.since
    ? { $or: [{ updatedAt: { $gte: scope.since } }, { _id: { $in: scope.flagged.filter((id) => Types.ObjectId.isValid(id)) } }] } : {};
  const rows = await BookingModel.find({ 'assisted.funding.method': 'wallet', ...window }).select({ status: 1, paymentStatus: 1, assisted: 1, settlement: 1 })
    .lean() as unknown as IBooking[];
  const mismatches: Mismatch[] = [];
  for (const b of rows) {
    const id = lower(b._id);
    const a = b.assisted!;
    const f = a.funding;
    if (f.amountMinor > 0) {
      const debits = await PharmacyWalletTransactionModel.find({ operationKey: `assisted:${id}:debit` }).select({ amountPaise: 1, pharmacyId: 1 }).lean();
      if (debits.length !== 1 || Number(debits[0]!.amountPaise) !== f.amountMinor || lower(debits[0]!.pharmacyId) !== lower(f.payerId)) {
        mismatches.push({ check: 'one_funding', ref: id, detail: { debits: debits.length, amountMinor: f.amountMinor } });
      }
    }
    const refunded = (f.refunds ?? []).reduce((x, r) => x + Number(r.amountMinor || 0), 0);
    if (refunded > 0) {
      const credit = await PharmacyWalletTransactionModel.findOne({ operationKey: `assisted:${id}:refund` }).select({ amountPaise: 1 }).lean();
      if (!credit || Number(credit.amountPaise) !== refunded) mismatches.push({ check: 'refund_posted', ref: id, detail: { refundedMinor: refunded } });
    }
    if (b.status === 'cancelled' && f.state === 'captured' && f.amountMinor > 0) mismatches.push({ check: 'cancelled_not_refunded', ref: id, detail: {} });
    if (b.status !== 'cancelled' && f.state === 'refunded') mismatches.push({ check: 'refunded_not_cancelled', ref: id, detail: { status: b.status } });
    const sp = a.split;
    if (sp.providerMinor + sp.cutMinor !== sp.baseMinor) mismatches.push({ check: 'split_sum', ref: id, detail: { ...sp } });
    if (b.status === 'completed' && sp.providerMinor > 0) {
      const earned = await LedgerEntryModel.find({ source: 'consultation', sourceId: { $in: [id, String(b._id)] }, kind: 'earning' }).select({ amountMinor: 1 }).lean();
      if (earned.length !== 1 || Number(earned[0]!.amountMinor) !== sp.providerMinor) {
        mismatches.push({ check: 'provider_earning', ref: id, detail: { entries: earned.length, providerMinor: sp.providerMinor } });
      }
    }
    if (b.status === 'no_show') {
      const earned = await LedgerEntryModel.countDocuments({ source: 'consultation', sourceId: { $in: [id, String(b._id)] }, kind: 'earning' });
      if (earned > 0) mismatches.push({ check: 'no_show_earned', ref: id, detail: { entries: earned } });
    }
  }
  return { checked: rows.length, mismatches };
}

/**
 * r11 (§24.4, test 20): the same checks on assisted LAB bookings (wallet-paid in 2a): exactly one debit of the amount by
 * the payer; every refund row posted once; a cancelled row not left captured (unless kept, `forfeited`); provider + cut
 * = base, Σ lines = base; earned once on completion, never on a no-show.
 */
async function labBookingChecks(scope: { since: Date | null; flagged: string[] }): Promise<{ checked: number; mismatches: Mismatch[] }> {
  const window = scope.since
    ? { $or: [{ updatedAt: { $gte: scope.since } }, { _id: { $in: scope.flagged.filter((id) => Types.ObjectId.isValid(id)) } }] } : {};
  const rows = await PartnerLabBookingModel.find({ 'assisted.funding.method': 'wallet', ...window }).select({ status: 1, paymentStatus: 1, assisted: 1 })
    .lean() as unknown as IPartnerLabBooking[];
  const mismatches: Mismatch[] = [];
  for (const b of rows) {
    const id = lower(b._id);
    const a = b.assisted!;
    const f = a.funding;
    if (f.amountMinor > 0) {
      const debits = await PharmacyWalletTransactionModel.find({ operationKey: `assisted_lab:${id}:debit` }).select({ amountPaise: 1, pharmacyId: 1 }).lean();
      if (debits.length !== 1 || Number(debits[0]!.amountPaise) !== f.amountMinor || lower(debits[0]!.pharmacyId) !== lower(f.payerId)) {
        mismatches.push({ check: 'lab_one_funding', ref: id, detail: { debits: debits.length, amountMinor: f.amountMinor } });
      }
    }
    const refunded = (f.refunds ?? []).reduce((x, r) => x + Number(r.amountMinor || 0), 0);
    const credits = await PharmacyWalletTransactionModel.find({ operationKey: `assisted_lab:${id}:refund` }).select({ amountPaise: 1 }).lean();
    if (credits.length > 1 || (refunded > 0 && (credits.length !== 1 || Number(credits[0]!.amountPaise) !== refunded)) || (refunded === 0 && credits.length > 0)) {
      mismatches.push({ check: 'lab_refund_posted', ref: id, detail: { refundedMinor: refunded, credits: credits.length } });
    }
    if (b.status === 'cancelled' && f.state === 'captured' && f.amountMinor > 0) mismatches.push({ check: 'lab_cancelled_not_refunded', ref: id, detail: {} });
    if (b.status !== 'cancelled' && f.state === 'refunded') mismatches.push({ check: 'lab_refunded_not_cancelled', ref: id, detail: { status: b.status } });
    const sp = a.split;
    const linesBase = (sp.lines ?? []).reduce((x, l) => x + Number(l.baseMinor || 0), 0);
    if (sp.providerMinor + sp.cutMinor !== sp.baseMinor || (sp.lines?.length && linesBase !== sp.baseMinor)) {
      mismatches.push({ check: 'lab_split_sum', ref: id, detail: { baseMinor: sp.baseMinor, providerMinor: sp.providerMinor, cutMinor: sp.cutMinor, linesBase } });
    }
    const earned = await LedgerEntryModel.find({ source: 'partner_lab_booking', sourceId: { $in: [id, String(b._id)] }, kind: 'earning' }).select({ amountMinor: 1 }).lean();
    if (b.status === 'completed' && sp.providerMinor > 0 && (earned.length !== 1 || Number(earned[0]!.amountMinor) !== sp.providerMinor)) {
      mismatches.push({ check: 'lab_provider_earning', ref: id, detail: { entries: earned.length, providerMinor: sp.providerMinor } });
    }
    if (['no_show', 'cancelled'].includes(b.status) && earned.length > 0) mismatches.push({ check: 'lab_earned_without_service', ref: id, detail: { status: b.status, entries: earned.length } });
  }
  return { checked: rows.length, mismatches };
}

/** Paid pharmacy top-ups with no wallet credit (and, before the sweep's start date, attempts nobody checks). */
export async function uncreditedTopups(now: Date = new Date()) {
  // Review: without a sweep date the list covers the last 30 days (older attempts are not scanned on every read).
  const sweepFrom0 = assistedFlags.rechargeSweepFrom();
  const recent = sweepFrom0 ? {} : { createdAt: { $gte: new Date(now.getTime() - 30 * DAY) } };
  const paid = await PaymentRecordModel.find({ context: 'wallet_recharge', 'notes.flow': 'pharmacy_wallet_recharge', status: 'paid', ...recent })
    .select({ payerPharmacyId: 1, baseAmount: 1, baseAmountPaise: 1, createdAt: 1, razorpayPaymentId: 1 }).sort({ createdAt: 1 }).limit(5000).lean() as Row[];
  const uncredited: Row[] = [];
  for (const r of paid) {
    const tx = await PharmacyWalletTransactionModel.exists({ referenceType: 'wallet_recharge', referenceId: String(r._id), status: 'completed' });
    if (!tx) uncredited.push({ paymentTransactionId: String(r._id), pharmacyId: r.payerPharmacyId, amountMinor: r.baseAmountPaise ?? Math.round(Number(r.baseAmount) * 100),
      createdAt: r.createdAt, state: 'paid_not_credited' });
    if (uncredited.length >= LIST_MAX) break;
  }
  const sweepFrom = assistedFlags.rechargeSweepFrom();
  const unchecked = await PaymentRecordModel.find({ context: 'wallet_recharge', 'notes.flow': 'pharmacy_wallet_recharge', status: 'created',
    paymentGateway: 'razorpay', createdAt: { $lt: new Date(Math.min(now.getTime() - HOUR, sweepFrom ? sweepFrom.getTime() : now.getTime())),
      ...(sweepFrom ? {} : { $gte: new Date(now.getTime() - 30 * DAY) }) } })
    .select({ payerPharmacyId: 1, baseAmount: 1, baseAmountPaise: 1, createdAt: 1 }).sort({ createdAt: 1 }).limit(LIST_MAX).lean() as Row[];
  return [...uncredited, ...unchecked.map((r) => ({ paymentTransactionId: String(r._id), pharmacyId: r.payerPharmacyId,
    amountMinor: r.baseAmountPaise ?? Math.round(Number(r.baseAmount) * 100), createdAt: r.createdAt, state: 'not_checked_with_gateway' }))];
}

/**
 * r17 (§25.8.4): partner instant requests. Exactly one debit of what the partner held, by the payer; a request refunded
 * before acceptance got exactly that back, once; an accepted one returned exactly `returned.partnerMinor`, refunds after
 * it never exceed the allocation, and nothing was refunded as "before acceptance"; the booking's split adds up; one
 * earning on completion, none on a no-show.
 */
async function instantChecks(scope: { since: Date | null; flagged: string[] }): Promise<{ checked: number; mismatches: Mismatch[] }> {
  const window = scope.since
    ? { $or: [{ updatedAt: { $gte: scope.since } }, { _id: { $in: scope.flagged.filter((id) => Types.ObjectId.isValid(id)) } }] } : {};
  const rows = await InstantRequestModel.find({ 'assisted.funding.method': 'wallet', ...window }).lean() as unknown as IInstantRequest[];
  const mismatches: Mismatch[] = [];
  const total = (xs: { amountPaise: number }[]) => xs.reduce((a, x) => a + Number(x.amountPaise || 0), 0);
  for (const r of rows) {
    const id = lower(r._id);
    const f = r.assisted!.funding;
    const held = r.funding?.partnerMinor ?? 0;
    const entries = (kind: string) => bookerEntriesOf(f.payerKind, `assisted_instant:${id}:${kind}`);
    const [debits, refunds, returns, cancels] = await Promise.all([entries('debit'), entries('refund'), entries('quote_return'), entries('cancel_refund')]);
    if (held !== f.amountMinor || (f.amountMinor > 0 && (debits.length !== 1 || Number(debits[0]!.amountPaise) !== f.amountMinor
      || lower(debits[0]!.pharmacyId) !== lower(f.payerId)))) {
      mismatches.push({ check: 'instant_one_funding', ref: id, detail: { debits: debits.length, amountMinor: f.amountMinor, heldMinor: held } });
    }
    if (r.acceptedBy) {
      if (refunds.length) mismatches.push({ check: 'instant_refund_after_accept', ref: id, detail: { entries: refunds.length } });
      if (returns.length > 1 || total(returns) !== (r.returned?.partnerMinor ?? 0)) {
        mismatches.push({ check: 'instant_quote_return', ref: id, detail: { entries: returns.length, returnedMinor: r.returned?.partnerMinor ?? 0 } });
      }
      if (cancels.length > 1 || total(cancels) > (r.allocated?.partnerMinor ?? 0)) {
        mismatches.push({ check: 'instant_cancel_refund', ref: id, detail: { entries: cancels.length, allocatedMinor: r.allocated?.partnerMinor ?? 0 } });
      }
    } else if (r.status === 'refunded' && (refunds.length !== (held > 0 ? 1 : 0) || total(refunds) !== held)) {
      mismatches.push({ check: 'instant_refund_posted', ref: id, detail: { entries: refunds.length, heldMinor: held } });
    } else if (r.status === 'offered' && (refunds.length || returns.length || cancels.length)) {
      mismatches.push({ check: 'instant_open_refunded', ref: id, detail: {} });
    }
    if (!r.bookingId) continue;
    const b = await BookingModel.findById(r.bookingId).select({ status: 1, 'assisted.split': 1 }).lean() as unknown as IBooking | null;
    const sp = b?.assisted?.split;
    if (!sp) { mismatches.push({ check: 'instant_booking_split', ref: id, detail: { bookingId: r.bookingId } }); continue; }
    if (sp.providerMinor + sp.cutMinor !== sp.baseMinor) mismatches.push({ check: 'split_sum', ref: lower(r.bookingId), detail: { ...sp } });
    const earned = await LedgerEntryModel.find({ source: 'consultation', sourceId: { $in: [lower(r.bookingId), String(r.bookingId)] }, kind: 'earning' })
      .select({ amountMinor: 1 }).lean();
    if (b!.status === 'completed' && sp.providerMinor > 0 && (earned.length !== 1 || Number(earned[0]!.amountMinor) !== sp.providerMinor)) {
      mismatches.push({ check: 'provider_earning', ref: lower(r.bookingId), detail: { entries: earned.length, providerMinor: sp.providerMinor } });
    }
    if (b!.status === 'no_show' && earned.length > 0) mismatches.push({ check: 'no_show_earned', ref: lower(r.bookingId), detail: { entries: earned.length } });
  }
  return { checked: rows.length, mismatches };
}

/** §8.8 stuck-money report. Items of later phases (Razorpay refund rows, late captures, withdrawals) are listed empty. */
export async function stuckMoney(now: Date = new Date()) {
  const pendingPastDeadline = await BookingModel.find({ 'assisted.funding': { $exists: true }, status: 'pending', paymentStatus: 'pending',
    createdAt: { $lt: new Date(now.getTime() - 30 * 60_000 - HOUR) } }).select({ _id: 1, createdAt: 1 }).limit(LIST_MAX).lean();
  const open = await BookingModel.find({ 'assisted.funding.state': 'captured', status: { $in: ['pending', 'confirmed'] }, paymentStatus: 'paid' })
    .select({ bookingDate: 1, bookingTime: 1, slotId: 1, 'assisted.bookedBy': 1, 'assisted.funding.amountMinor': 1 }).limit(5000).lean() as unknown as IBooking[];
  const slots = await SlotModel.find({ _id: { $in: open.map((b) => b.slotId).filter((id) => Types.ObjectId.isValid(String(id))) } })
    .select({ date: 1, startTime: 1, endTime: 1, duration: 1 }).lean();
  const slotBy = new Map(slots.map((s) => [lower(s._id), s]));
  const stuckAfterSlot = open.filter((b) => {
    const s = slotBy.get(lower(b.slotId));
    const end = (s && s.date === b.bookingDate ? slotIntervalOf(s as never)?.end : null)
      ?? parseAppointment({ bookingDate: String(b.bookingDate), bookingTime: String(b.bookingTime) })?.at;
    return !!end && end.getTime() + 7 * DAY < now.getTime();
  }).slice(0, LIST_MAX).map((b) => ({ bookingId: String(b._id), bookingDate: b.bookingDate, bookerId: b.assisted?.bookedBy.id,
    amountMinor: b.assisted?.funding.amountMinor }));
  const frozenWithReceivable = await PharmacyWalletModel.find({ frozen: true, receivableMinor: { $gt: 0 } }).select({ pharmacyId: 1, receivableMinor: 1 }).limit(LIST_MAX).lean();
  const unknownFeeLots = await WalletTopupLotModel.find({ feeState: 'unknown', closed: false, createdAt: { $lt: new Date(now.getTime() - 2 * DAY) } })
    .select({ walletRef: 1, paymentRecordId: 1, amountMinor: 1, createdAt: 1 }).limit(LIST_MAX).lean();
  // r17 (§25.8.4): a partner's instant request still offered more than an hour after its inactivity refund was due.
  const instantOffered = await InstantRequestModel.find({ 'assisted.bookedBy.kind': { $exists: true }, status: 'offered',
    inactivityRefundAt: { $lt: new Date(now.getTime() - HOUR) } }).select({ 'assisted.bookedBy': 1, 'assisted.funding.amountMinor': 1, inactivityRefundAt: 1 })
    .limit(LIST_MAX).lean() as unknown as IInstantRequest[];
  return {
    pendingPaymentPastDeadline: pendingPastDeadline.map((b) => ({ bookingId: String(b._id), createdAt: b.createdAt })),
    instantOfferedPastRefund: instantOffered.map((r) => ({ requestId: String(r._id), bookerId: r.assisted?.bookedBy.id, amountMinor: r.assisted?.funding.amountMinor,
      inactivityRefundAt: r.inactivityRefundAt })),
    // Phase 1b: card refunds pending over 24 h, failed or held for review (the operator queue), and late captures.
    refundRowsPending: await cardRefundQueue({}, now) as Row[],
    lateCaptures: (await AssistedCardRefundModel.find({ cause: { $in: ['late_capture', 'extra_capture'] } }).sort({ createdAt: -1 }).limit(LIST_MAX).lean())
      .map((r) => ({ refundId: String(r._id), bookingId: r.bookingId, paymentRecordId: r.paymentRecordId, cause: r.cause, amountMinor: r.amountMinor, state: r.state,
        createdAt: r.createdAt })) as Row[],
    // r10b: card refunds still pending at Razorpay after ASSISTED_CARD_REFUND_STUCK_DAYS (default 7), and card disputes
    // recorded on assisted booking payments (C4: flagged only, an admin decides).
    cardRefundsPendingOverDays: await cardRefundsStuckPending(now) as Row[],
    cardChargebacks: await cardChargebacks() as Row[],
    // r10g: paid call / video bookings of the next 48 hours with no working Meet link (all bookings, not only assisted).
    upcomingMeetsMissing: await upcomingMeetsMissing(now) as Row[],
    withdrawalsRequestedOver7Days: [] as Row[],
    frozenWalletsWithReceivable: frozenWithReceivable.map((w) => ({ pharmacyId: String(w.pharmacyId), receivableMinor: w.receivableMinor })),
    topupsCapturedNotCredited: await uncreditedTopups(now),
    paidBookingsStuckAfterSlot: stuckAfterSlot,
    lotsWithUnknownFeeOver2Days: unknownFeeLots.map((l) => ({ lotId: String(l._id), walletRef: l.walletRef, paymentRecordId: l.paymentRecordId,
      amountMinor: l.amountMinor, createdAt: l.createdAt })),
    notBuiltYet: ['withdrawals (phase 4)'],
  };
}

/** Booker cancellation rate over the last 7 days (alert at ≥ 30 % with at least 10 bookings, P10); r11: lab bookings count too. */
async function cancelRates(now: Date) {
  const since = new Date(now.getTime() - 7 * DAY);
  const [rows, labRows] = await Promise.all([BookingModel.aggregate([
    { $match: { 'assisted.bookedBy.id': { $exists: true }, createdAt: { $gte: since } } },
    { $group: { _id: { kind: '$assisted.bookedBy.kind', id: '$assisted.bookedBy.id' }, bookings: { $sum: 1 },
      cancelled: { $sum: { $cond: [{ $eq: ['$cancellationCause', 'booker'] }, 1, 0] } } } },
  ]), PartnerLabBookingModel.aggregate([
    { $match: { 'assisted.bookedBy.id': { $exists: true }, createdAt: { $gte: since } } },
    { $group: { _id: { kind: '$assisted.bookedBy.kind', id: '$assisted.bookedBy.id' }, bookings: { $sum: 1 },
      cancelled: { $sum: { $cond: [{ $eq: ['$cancellation.byKind', 'booker'] }, 1, 0] } } } },
  ])]);
  const by = new Map<string, { bookerKind: string; bookerId: string; bookings: number; cancelledByBooker: number }>();
  for (const r of [...rows, ...labRows]) {
    const k = `${r._id.kind}:${r._id.id}`;
    const cur = by.get(k) ?? { bookerKind: r._id.kind as string, bookerId: r._id.id as string, bookings: 0, cancelledByBooker: 0 };
    cur.bookings += Number(r.bookings); cur.cancelledByBooker += Number(r.cancelled);
    by.set(k, cur);
  }
  return [...by.values()];
}

/** Booking ids an earlier run flagged (reconciliation_mismatch alerts), re-checked until they reconcile. */
async function flaggedBookingIds(): Promise<string[]> {
  const rows = await AssistedAlertModel.find({ kind: 'reconciliation_mismatch' }).select({ detail: 1 }).sort({ at: -1 }).limit(1000).lean();
  return [...new Set(rows.map((r) => String((r.detail as Row | undefined)?.ref ?? '')).filter((id) => /^[0-9a-fA-F]{24}$/.test(id)))];
}

export async function runReconciliation(now: Date = new Date(), opts: { full?: boolean } = {}) {
  const scope = opts.full ? { since: null, flagged: [] } : { since: new Date(now.getTime() - 7 * DAY), flagged: await flaggedBookingIds() };
  const [wallets, bookings, labBookings, instantRequests, stuck, rates] = await Promise.all([walletInvariants(), bookingChecks(scope), labBookingChecks(scope),
    instantChecks(scope), stuckMoney(now), cancelRates(now)]);
  const pct = assistedLimits.cancelRateAlertPct();
  const min = assistedLimits.cancelRateAlertMin();
  const highCancelRates = rates.filter((r) => r.bookings >= min && r.cancelledByBooker * 100 >= pct * r.bookings);
  const mismatches = [...wallets.mismatches, ...bookings.mismatches, ...labBookings.mismatches, ...instantRequests.mismatches];
  return {
    day: istDateIso(now),
    at: now,
    ok: mismatches.length === 0,
    checks: {
      wallets: { checked: wallets.checked, notMigrated: wallets.notMigrated },
      bookings: { checked: bookings.checked, scope: opts.full ? 'all' : 'changed_in_7_days_and_flagged' },
      labBookings: { checked: labBookings.checked, scope: opts.full ? 'all' : 'changed_in_7_days_and_flagged' },
      instantRequests: { checked: instantRequests.checked, scope: opts.full ? 'all' : 'changed_in_7_days_and_flagged' },
      // Chargebacks: wallets that owe Jansetu (a receivable) or show a negative balance.
      walletsOwing: await walletsOwing(),
      mismatches,
      withdrawals: 'not built (phase 4)',
      razorpayAssisted: 'phase 1b: card refunds and late captures are listed in stuck.refundRowsPending and stuck.lateCaptures',
      highCancelRates,
    },
    stuck,
    alerts: await AssistedAlertModel.find({ day: { $gte: istDateIso(new Date(now.getTime() - 7 * DAY)) } }).sort({ at: -1 }).limit(LIST_MAX).lean(),
  };
}

/** P2: fills the Razorpay fee of lots whose fee was not known at capture (then their money counts as withdrawable). */
export async function fillUnknownLotFees(fetchFee: (razorpayPaymentId: string) => Promise<number | undefined>, limit = 100): Promise<{ filled: number }> {
  const lots = await WalletTopupLotModel.find({ feeState: 'unknown', closed: false }).sort({ createdAt: 1 }).limit(limit).lean();
  let filled = 0;
  for (const lot of lots) {
    try {
      const record = await PaymentRecordModel.findById(lot.paymentRecordId).select({ razorpayPaymentId: 1, gatewayFeeMinor: 1 }).lean() as Row | null;
      let fee: number | undefined = Number.isSafeInteger(record?.gatewayFeeMinor) ? Number(record!.gatewayFeeMinor) : undefined;
      if (fee === undefined && record?.razorpayPaymentId) fee = await fetchFee(String(record.razorpayPaymentId));
      if (fee === undefined || !Number.isSafeInteger(fee) || fee < 0) continue;
      await inTransaction(async (s) => {
        const r = await WalletTopupLotModel.updateOne({ _id: lot._id, feeState: 'unknown' }, { $set: { feeState: 'known', gatewayFeeMinor: fee } }, { session: s });
        if (r.modifiedCount === 1 && lot.walletRef.kind === 'pharmacy') await refreshWithdrawableIn(lot.walletRef.id, s);
      });
      if (record && record.gatewayFeeMinor === undefined) await PaymentRecordModel.updateOne({ _id: record._id, gatewayFeeMinor: { $exists: false } }, { $set: { gatewayFeeMinor: fee } });
      filled += 1;
    } catch (e) {
      logger.warn('lot fee fill failed', { lotId: String(lot._id), error: (e as Error)?.message });
    }
  }
  return { filled };
}

/** The daily job (ASSISTED_RECONCILIATION_ENABLED): store the report, raise alerts, fill fees. Never fixes money. */
export async function runDailyReconciliation(fetchFee: (razorpayPaymentId: string) => Promise<number | undefined>, now: Date = new Date()) {
  const fees = await fillUnknownLotFees(fetchFee);
  const report = await runReconciliation(now);
  for (const m of report.checks.mismatches) await raiseAlertIn({ kind: 'reconciliation_mismatch', subject: `${m.check}:${m.ref}`, detail: { ...m } });
  for (const r of report.checks.highCancelRates) {
    await raiseAlertIn({ kind: 'cancel_rate', bookerKind: r.bookerKind, bookerId: r.bookerId, detail: { ...r } });
  }
  await AssistedReconciliationReportModel.updateOne({ day: report.day }, { $set: { day: report.day, at: report.at, ok: report.ok, checks: report.checks,
    stuck: report.stuck } }, { upsert: true });
  return { ...report, feesFilled: fees.filled };
}
