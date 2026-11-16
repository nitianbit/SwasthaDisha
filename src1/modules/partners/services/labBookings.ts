import { Service, Container } from 'typedi';
import { createHash } from 'crypto';
import { canonicalJson } from '@/modules/partners/services/invoice';
import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { fundBookingFromWallet, recordGatewayCapture, refundAndCloseIn, runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { claimRequestKey, scopeOf } from '@/modules/requestKeys';
import { undoCouponUsageIn } from '@/modules/coupon/usage';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentService, registerPaymentContextHandler } from '@/modules/payment/services';
import type { IPaymentRecord } from '@/modules/payment/types';
import { CouponService } from '@/modules/coupon/services';
import { WalletRepository } from '@/modules/wallet/repository';
import UserModel from '@/modules/user/model';
import DependentModel from '@/modules/dependents/model';
import PartnerOrgModel from '@/modules/partners/model';
import BranchModel from '@/modules/partners/model/branch';
import MemberModel from '@/modules/partners/model/member';
import CatalogueItemModel from '@/modules/partners/model/catalogueItem';
import { PartnerLabBookingModel, IPartnerLabBooking, LabBookingStatus, ILabBookingSlot } from '@/modules/partners/model/labBooking';
import type { VisitMode } from '@/modules/partners/model/slot';
import { PartnerActor, assertBranchInScope, hasGlobalScope, recordPartnerAudit } from '@/modules/partners/services';
import { ensureSettlementAccount, postLedgerEntry } from '@/modules/partners/services/settlement';
import { takeSeat, releaseSeat, listBookableSlots, istDate, addDays } from '@/modules/partners/services/slots';
import { attachFiles, grantFiles, uploadPathOf } from '@/modules/file/access';
import type { AuthRequest } from '@/modules/middleware/auth';

export const LAB_PAYMENT_WINDOW_MS = 30 * 60_000;
/** Customers may cancel (full refund) until 2 hours before the slot, or any time while a lab reschedule is unanswered. */
export const LAB_CANCEL_CUTOFF_MS = 2 * 3_600_000;
/** A slot must start at least this long after booking. */
export const LAB_MIN_LEAD_MS = 60 * 60_000;
export const REPORT_UPLOAD_MODULE = 'partner-lab-reports';

const rupees = (paise: number) => Math.round(paise) / 100;
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const notFound = () => err(404, 'LAB_BOOKING_NOT_FOUND', 'Booking not found');
const changed = () => Object.assign(err(409, 'LAB_BOOKING_CHANGED', 'The booking changed meanwhile; reload and try again'), { retryable: true });

export type LabNotifier = (n: { userId: string; type: 'booking_confirmed' | 'booking_cancelled' | 'general'; title: string; message: string;
  bookingId: string; key: string }) => Promise<void>;

/** Default: the existing in-app notification + push (best effort; never fails the operation). */
export const defaultLabNotifier: LabNotifier = async (n) => {
  try {
    const { NotificationService } = await import('@/modules/notification/services');
    await Container.get(NotificationService).create({
      userId: n.userId, type: n.type, title: n.title, message: n.message,
      referenceType: 'partner_lab_booking', referenceId: n.bookingId, idempotencyKey: n.key, data: { bookingId: n.bookingId },
    });
  } catch (e) {
    console.error('lab booking notification failed', (e as Error)?.message);
  }
};

export interface CreateLabBookingInput {
  /** Q9: the payable amount (paise) the customer confirmed; required by the HTTP schema (customers always send it). */
  acceptedPayableMinor?: number;
  /** Q9: the tests' subtotal (paise) the customer saw; optional extra fence. */
  acceptedSubtotalMinor?: number;
  partnerId: string;
  branchId: string;
  visitMode: VisitMode;
  slotId: string;
  itemIds: string[];
  patient: { kind: 'self' | 'dependent'; dependentId?: string };
  address?: { line1: string; line2?: string; city: string; state?: string; pincode: string; landmark?: string };
  couponCode?: string;
  useWalletBalance?: boolean;
  requestKey: string;
}

export interface LabBookingPaymentInit {
  booking: Record<string, unknown>;
  paymentRequired: boolean;
  walletDeductedAmount: number;
  payment?: { paymentTransactionId: string; razorpayOrderId: string; razorpayKeyId: string; amount: number; currency: string };
}

/** What a create request asks for (wallet use excluded: it only changes how the same booking is paid). */
export function createRequestHash(input: CreateLabBookingInput): string {
  return createHash('sha256').update(canonicalJson({
    partnerId: input.partnerId, branchId: input.branchId, visitMode: input.visitMode, slotId: input.slotId,
    itemIds: [...new Set(input.itemIds.map(String))].sort(), patient: input.patient, address: input.address, couponCode: input.couponCode,
  })).digest('hex');
}

function assertSameRequest(b: IPartnerLabBooking, requestHash: string): IPartnerLabBooking {
  if (b.createRequestHash && b.createRequestHash !== requestHash) {
    throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different booking');
  }
  return b;
}

type Actor = { kind: 'customer'; userId: string } | { kind: 'partner'; actor: PartnerActor } | { kind: 'system' };
const byOf = (a: Actor) => a.kind === 'customer' ? { by: a.userId, byKind: 'customer' as const }
  : a.kind === 'partner' ? { by: a.actor.memberId, byKind: a.actor.actorKind === 'admin' ? 'admin' as const : 'member' as const }
  : { by: 'system', byKind: 'system' as const };

/** The D1 reader for a workspace actor (members are `partner` uploaders; admins have authority over every file). */
export function readerOf(actor: PartnerActor): NonNullable<AuthRequest['user']> {
  return actor.actorKind === 'admin'
    ? { _id: actor.memberId.replace(/^admin:/, ''), userType: 'admin' }
    : { _id: actor.memberId, memberId: actor.memberId, partnerId: actor.partnerId, userType: 'partner' };
}

/** Q9: the lab's and branch's names for customer views (looked up in one batch). */
async function withPlaceNames(rows: IPartnerLabBooking[]): Promise<Record<string, unknown>[]> {
  const partners = await PartnerOrgModel.find({ _id: { $in: [...new Set(rows.map((r) => String(r.partnerId)))] } }).select({ name: 1 }).lean() as any[];
  const branches = await BranchModel.find({ _id: { $in: [...new Set(rows.map((r) => String(r.branchId)))] } }).select({ name: 1, address: 1, phone: 1 }).lean() as any[];
  const p = new Map(partners.map((x) => [String(x._id), x]));
  const b = new Map(branches.map((x) => [String(x._id), x]));
  return rows.map((r) => ({ ...customerView(r), lab: { name: p.get(String(r.partnerId))?.name },
    branch: b.get(String(r.branchId)) ? { name: b.get(String(r.branchId)).name, address: b.get(String(r.branchId)).address, phone: b.get(String(r.branchId)).phone } : undefined }));
}
export async function customerViewNamed(b: IPartnerLabBooking): Promise<Record<string, unknown>> { return (await withPlaceNames([b]))[0]!; }

/** What a customer sees: never draft report files; released files as URLs. */
export function customerView(b: IPartnerLabBooking): Record<string, unknown> {
  const { walletFunding: _w, createRequestKey: _k, createRequestHash: _h, expiryNextAt: _e, expiryChecks: _c, postPaymentCompletedFor: _p,
    report, settlement: _s, cancellation, reschedule, collector, ...rest } = b as any;
  return {
    ...rest,
    // Member ids are internal: the customer sees what happened and who to expect, not staff identifiers.
    cancellation: cancellation ? { reason: cancellation.reason, note: cancellation.note, at: cancellation.at, byKind: cancellation.byKind } : undefined,
    reschedule: reschedule ? { version: reschedule.version, pending: reschedule.pending, previousSlot: reschedule.previousSlot, reason: reschedule.reason, at: reschedule.at } : undefined,
    collector: collector ? { name: collector.name, phone: collector.phone } : undefined,
    report: {
      files: (report?.releasedFiles ?? []).map((p: string) => `/api/static/${p}`),
      // Q9: each release names its own file, so a report is paired with its signer exactly.
      releases: (report?.releases ?? []).map((r: any) => ({ file: `/api/static/${r.path}`, releasedAt: r.releasedAt,
        signer: { name: r.signer.name, kind: r.signer.kind, registrationNumber: r.signer.registrationNumber } })),
    },
  };
}

export function partnerView(b: IPartnerLabBooking): Record<string, unknown> {
  const { walletFunding: _w, createRequestKey: _k, createRequestHash: _h, postPaymentCompletedFor: _p, ...rest } = b as any;
  return {
    ...rest,
    report: {
      draftFiles: (b.report?.draftFiles ?? []).map((p) => `/api/static/${p}`),
      releasedFiles: (b.report?.releasedFiles ?? []).map((p) => `/api/static/${p}`),
      releases: b.report?.releases ?? [],
    },
  };
}

@Service()
export class LabBookingService {
  notify: LabNotifier = defaultLabNotifier;

  constructor(
    private paymentService: PaymentService,
    private couponService: CouponService,
    private walletRepository: WalletRepository
  ) {}

  // ───────────────────────────── Customer: create and pay ─────────────────────────────

  async create(userId: string, input: CreateLabBookingInput, now = new Date()): Promise<LabBookingPaymentInit> {
    const requestHash = createRequestHash(input);
    const prior = await PartnerLabBookingModel.findOne({ userId: { $eq: userId }, createRequestKey: { $eq: input.requestKey } }).lean();
    if (prior) return this.resume(assertSameRequest(prior as IPartnerLabBooking, requestHash), !!input.useWalletBalance, now);

    const partner = await PartnerOrgModel.findById(input.partnerId).lean();
    if (!partner || partner.kind !== 'lab' || partner.isActive === false || partner.verification?.state !== 'verified') {
      throw err(404, 'LAB_NOT_FOUND', 'This lab is not available');
    }
    const branch = await BranchModel.findById(input.branchId).lean();
    const offered = input.visitMode === 'home' ? branch?.services?.homeCollection : branch?.services?.inLab;
    if (!branch || String(branch.partnerId) !== String(partner._id) || branch.isActive === false || !offered) {
      throw err(404, 'BRANCH_NOT_AVAILABLE', 'This branch does not offer that visit type');
    }
    if (input.visitMode === 'home' && !input.address) throw err(400, 'ADDRESS_REQUIRED', 'A home collection needs an address');

    const ids = [...new Set(input.itemIds.map(String))];
    const items = await CatalogueItemModel.find({ _id: { $in: ids }, partnerId: String(partner._id), isActive: true, adminDisabled: { $ne: true } }).lean();
    if (items.length !== ids.length) throw err(400, 'CATALOGUE_ITEM_NOT_AVAILABLE', 'A selected test is no longer available');
    if (items.some((i) => !(i.visitModes ?? []).includes(input.visitMode))) {
      throw err(400, 'VISIT_MODE_NOT_SUPPORTED', 'A selected test is not offered for this visit type');
    }

    const patient = await this.patientOf(userId, input.patient);
    const subtotalMinor = items.reduce((a, i) => a + i.priceMinor, 0);
    const { discountMinor, couponCode } = await this.couponFor(userId, String(partner._id), items, subtotalMinor, input.couponCode);
    const payableMinor = Math.max(0, subtotalMinor - discountMinor);
    // Q9: the price the customer accepted is a fence — nothing is funded at any other price (prices or a coupon may
    // have changed since the screen was shown).
    if ((input.acceptedPayableMinor !== undefined && input.acceptedPayableMinor !== payableMinor)
        || (input.acceptedSubtotalMinor !== undefined && input.acceptedSubtotalMinor !== subtotalMinor)) {
      throw err(409, 'PRICE_CHANGED', `The price is now ₹${(payableMinor / 100).toFixed(2)} (tests ₹${(subtotalMinor / 100).toFixed(2)}, coupon −₹${(discountMinor / 100).toFixed(2)}); review and confirm again`);
    }
    const account = await ensureSettlementAccount('partner', String(partner._id), partner.legalName || partner.name);

    const booking = await runLedgerTransaction(async (s) => {
      const again = await PartnerLabBookingModel.findOne({ userId: { $eq: userId }, createRequestKey: { $eq: input.requestKey } }).session(s).lean();
      if (again) return assertSameRequest(again as IPartnerLabBooking, requestHash);
      await claimRequestKey(scopeOf('lab_booking_create', userId), input.requestKey, s);
      const slot = await takeSeat(input.slotId, {
        partnerId: String(partner._id), branchId: String(branch._id), visitMode: input.visitMode, minStart: new Date(now.getTime() + LAB_MIN_LEAD_MS),
      }, s);
      const [created] = await PartnerLabBookingModel.create([{
        partnerId: String(partner._id), branchId: String(branch._id), userId, createRequestKey: input.requestKey, createRequestHash: requestHash,
        patient, visitMode: input.visitMode, address: input.visitMode === 'home' ? input.address : undefined,
        slot: { slotId: String(slot._id), date: slot.date, startTime: slot.startTime, endTime: slot.endTime, startsAt: slot.startsAt },
        items: items.map((i) => ({ catalogItemId: String(i._id), kind: i.kind, name: i.name, code: i.code, priceMinor: i.priceMinor,
          mrpMinor: i.mrpMinor, gstRate: i.gstRate, sac: i.sac, reportTatHours: i.reportTatHours })),
        pricing: { subtotalMinor, couponCode, discountMinor, payableMinor, commissionMinor: 0, currency: 'INR' },
        settlement: { settlementAccountId: String(account._id), beneficiaryName: account.beneficiaryName, settlementSystem: 'ledger' },
        status: 'pending_payment', statusVersion: 0, paymentStatus: 'pending',
        paymentDeadline: new Date(now.getTime() + LAB_PAYMENT_WINDOW_MS),
        reschedule: { version: 0, pending: false },
        report: { draftFiles: [], releasedFiles: [], releases: [] },
        lifecycle: {},
      }], { session: s });
      return created!.toObject() as IPartnerLabBooking;
    });
    return this.resume(booking, !!input.useWalletBalance, now);
  }

  private async patientOf(userId: string, p: CreateLabBookingInput['patient']) {
    if (p.kind === 'dependent') {
      const d = p.dependentId && Types.ObjectId.isValid(p.dependentId)
        ? await DependentModel.findOne({ _id: p.dependentId, userId: { $eq: userId }, isActive: { $ne: false } }).lean() as any : null;
      if (!d) throw err(404, 'DEPENDENT_NOT_FOUND', 'Family member not found');
      return { kind: 'dependent' as const, dependentId: String(d._id), name: d.name, age: d.age, gender: d.gender };
    }
    const u = await UserModel.findById(userId).lean() as any;
    if (!u) throw err(404, 'USER_NOT_FOUND', 'Account not found');
    return { kind: 'self' as const, name: u.name || 'Self', age: u.age, gender: u.gender };
  }

  /** Coupons follow the diagnostics rules; a coupon may target a partner by its id, or its catalogue items. */
  private async couponFor(userId: string, partnerId: string, items: { _id: unknown; kind: string }[], subtotalMinor: number, code?: string) {
    if (!code || subtotalMinor <= 0) return { discountMinor: 0, couponCode: undefined };
    const v = await this.couponService.validateCoupon({
      code, userId, bookingType: 'external_diagnostics', bookingId: partnerId, purchaseAmount: rupees(subtotalMinor),
      testIds: items.filter((i) => i.kind === 'test').map((i) => String(i._id)),
      packageIds: items.filter((i) => i.kind === 'package').map((i) => String(i._id)),
    });
    if (!v.isValid || !v.coupon) throw err(400, 'INVALID_COUPON', v.message || 'Invalid coupon code');
    const discountMinor = Math.min(subtotalMinor, Math.round(Number(v.discountAmount || 0) * 100));
    return { discountMinor, couponCode: v.coupon.code };
  }

  /**
   * The ONE admission for starting or resuming payment (keyed create, its replay, and pay-again): a settled booking only
   * returns its receipt; otherwise the payment window must still be open and every earlier attempt must be settled with
   * the gateway first (unknown → 503), so no new checkout can start after expiry or beside an unresolved capture.
   */
  private async resume(booking: IPartnerLabBooking, useWallet: boolean, now = new Date()): Promise<LabBookingPaymentInit> {
    const receipt = (b: IPartnerLabBooking) => ({ booking: customerView(b), paymentRequired: false, walletDeductedAmount: 0 });
    if (booking.status !== 'pending_payment' || booking.paymentStatus !== 'pending') return receipt(booking);
    if (now >= new Date(booking.paymentDeadline)) throw err(409, 'LAB_BOOKING_PAYMENT_EXPIRED', 'The payment window has closed; book again');
    const id = String(booking._id);
    if (await PaymentRecordModel.exists({ context: 'lab_booking', contextId: id })) {
      const earlier = await this.paymentService.reconcileContextPayments('lab_booking', id);
      if (earlier.unknown > 0) throw err(503, 'PAYMENT_STATE_UNKNOWN', 'An earlier payment is still being checked; try again in a minute');
      booking = (await PartnerLabBookingModel.findById(id).lean()) as IPartnerLabBooking;
      if (booking.status !== 'pending_payment' || booking.paymentStatus !== 'pending') return receipt(booking);
    }
    if (booking.paymentTransactionId) {
      const open = await this.paymentService.resumableOrder(String(booking.paymentTransactionId));
      if (open) {
        return { booking: customerView(booking), paymentRequired: true, walletDeductedAmount: open.walletDeductedAmount,
          payment: { paymentTransactionId: open.paymentTransactionId, razorpayOrderId: open.razorpayOrderId, razorpayKeyId: open.razorpayKeyId,
            amount: open.amount, currency: open.currency } };
      }
    }
    return this.startPayment(booking, useWallet, booking.paymentTransactionId ? String(booking.paymentTransactionId) : undefined);
  }

  private payableFence(id: string, expectedLink: string | undefined): Record<string, unknown> {
    return {
      _id: id, status: 'pending_payment', paymentStatus: 'pending',
      ...(expectedLink ? { paymentTransactionId: expectedLink }
        : { $or: [{ paymentTransactionId: { $exists: false } }, { paymentTransactionId: null }, { paymentTransactionId: '' }] }),
    };
  }

  private async startPayment(booking: IPartnerLabBooking, useWallet: boolean, expectedLink: string | undefined): Promise<LabBookingPaymentInit> {
    const id = String(booking._id);
    const due = rupees(booking.pricing.payableMinor);
    let walletDeducted = 0;
    if (due > 0 && useWallet) {
      walletDeducted = (await fundBookingFromWallet({ model: PartnerLabBookingModel, kind: 'lab_booking', bookingId: id, userId: booking.userId,
        gross: due, requested: due, legacyFunded: 0, wallets: this.walletRepository })).total;
    } else if (due > 0) {
      // Records the existing funding (if any) so the remaining amount is right on a resumed attempt.
      walletDeducted = (await fundBookingFromWallet({ model: PartnerLabBookingModel, kind: 'lab_booking', bookingId: id, userId: booking.userId,
        gross: due, requested: 0, legacyFunded: 0, wallets: this.walletRepository })).total;
    }
    const remaining = Math.round((due - walletDeducted) * 100) / 100;
    if (remaining <= 0) {
      const paid = await runLedgerTransaction(async (s) => {
        const recordId = new Types.ObjectId();
        const now = new Date();
        const b = await PartnerLabBookingModel.findOneAndUpdate(
          { ...this.payableFence(id, expectedLink), 'walletFunding.closed': { $ne: true } },
          { $set: { status: 'confirmed', paymentStatus: 'paid', paymentTransactionId: String(recordId), 'lifecycle.paidAt': now, 'lifecycle.confirmedAt': now },
            $inc: { statusVersion: 1 } },
          { new: true, session: s }
        ).lean();
        if (!b) throw err(409, 'LAB_BOOKING_PAYMENT_STATE_CHANGED', 'This booking was paid, cancelled or changed; reload and try again');
        await this.paymentService.createDirectPaidBookingRecordIn({
          userId: booking.userId, context: 'lab_booking', contextId: id,
          baseAmount: rupees(booking.pricing.subtotalMinor), discountAmount: rupees(booking.pricing.discountMinor), finalAmount: 0,
          couponCode: booking.pricing.couponCode,
          notes: { reason: due <= 0 ? 'zero_payable_amount' : 'wallet_covered_amount', walletDeductedAmount: walletDeducted },
        }, s, recordId);
        return b as IPartnerLabBooking;
      });
      await this.notifyConfirmed(paid);
      return { booking: customerView(paid), paymentRequired: false, walletDeductedAmount: walletDeducted };
    }
    const order = await this.paymentService.createOrder({
      userId: booking.userId, context: 'lab_booking', contextId: id,
      baseAmount: rupees(booking.pricing.subtotalMinor), discountAmount: rupees(booking.pricing.discountMinor), finalAmount: remaining,
      couponCode: booking.pricing.couponCode, notes: { walletDeductedAmount: walletDeducted },
    });
    const linked = await PartnerLabBookingModel.findOneAndUpdate(this.payableFence(id, expectedLink),
      { $set: { paymentTransactionId: String(order.paymentRecord._id) } }, { new: true }).lean();
    if (!linked) throw err(409, 'LAB_BOOKING_PAYMENT_STATE_CHANGED', 'This booking was paid, cancelled or changed; reload and try again');
    return {
      booking: customerView(linked as IPartnerLabBooking), paymentRequired: true, walletDeductedAmount: walletDeducted,
      payment: { paymentTransactionId: String(order.paymentRecord._id), razorpayOrderId: order.razorpayOrder.id, razorpayKeyId: order.razorpayKeyId,
        amount: remaining, currency: order.razorpayOrder.currency },
    };
  }

  /** Pay again within the window (P8): settle every earlier attempt first; reuse the open order or start a new one. */
  async retryPayment(userId: string, bookingId: string, useWallet: boolean, now = new Date()): Promise<LabBookingPaymentInit> {
    return this.resume(await this.ownBooking(userId, bookingId), useWallet, now);
  }

  /** Payment context handler: a verified capture is applied exactly once (or returned to the wallet). */
  async applyCapture(record: IPaymentRecord, helpers: { finalize(r: IPaymentRecord): Promise<IPaymentRecord>; markReturned(r: IPaymentRecord): Promise<IPaymentRecord> }) {
    const booking = await PartnerLabBookingModel.findById(record.contextId).lean();
    if (!booking || booking.userId !== record.userId) throw notFound();
    const thisRecord = String(record._id);
    const now = new Date();
    const capture = await recordGatewayCapture({
      model: PartnerLabBookingModel, kind: 'lab_booking', bookingId: String(booking._id), userId: booking.userId, recordId: thisRecord,
      amount: Number(record.finalAmount || 0),
      gross: Math.max(0, Number(record.baseAmount || 0) - Number(record.discountAmount || 0)),
      legacyFunded: Number(record.notes?.walletDeductedAmount || 0),
      applicable: (b: any) => (b.status === 'pending_payment' && !['paid', 'refunded'].includes(String(b.paymentStatus)))
        || (b.paymentStatus === 'paid' && String(b.paymentTransactionId) === thisRecord),
      applyPatch: (b: any) => b.status === 'pending_payment'
        ? { paymentStatus: 'paid', paymentTransactionId: thisRecord, status: 'confirmed', statusVersion: Number(b.statusVersion ?? 0) + 1,
          'lifecycle.paidAt': now, 'lifecycle.confirmedAt': now }
        : { paymentStatus: 'paid', paymentTransactionId: thisRecord },
      wallets: this.walletRepository,
    });
    const after = await PartnerLabBookingModel.findById(record.contextId).lean() as IPartnerLabBooking;
    if (capture.state === 'returned') return { paymentRecord: await helpers.markReturned(record), entity: customerView(after) };
    if (after.postPaymentCompletedFor !== thisRecord) {
      await this.notifyConfirmed(after);
      await PartnerLabBookingModel.updateOne({ _id: after._id }, { $set: { postPaymentCompletedFor: thisRecord } });
    }
    return { paymentRecord: await helpers.finalize(record), entity: customerView(after) };
  }

  private async notifyConfirmed(b: IPartnerLabBooking) {
    await this.notify({ userId: b.userId, type: 'booking_confirmed', title: 'Lab booking confirmed',
      message: `Your ${b.visitMode === 'home' ? 'home collection' : 'lab visit'} on ${b.slot.date} at ${b.slot.startTime} is confirmed.`,
      bookingId: String(b._id), key: `plb:${b._id}:confirmed` });
  }

  // ───────────────────────────── Expiry (D2 for lab bookings) ─────────────────────────────

  /** Expires one unpaid booking past its deadline, serialized with capture; a payment that won leaves it alone. */
  async expireUnpaid(bookingId: string, now = new Date()): Promise<{ expired: boolean; reason?: string }> {
    const id = String(bookingId).toLowerCase();
    const out = await runLedgerTransaction(async (s) => {
      const b = await PartnerLabBookingModel.findById(id).session(s).lean() as IPartnerLabBooking | null;
      if (!b || b.status !== 'pending_payment' || b.paymentStatus !== 'pending') return { expired: false, reason: 'not_pending' };
      if (now < b.paymentDeadline) return { expired: false, reason: 'not_due' };
      const records = await this.fenceRecords(id, s);
      if (records.some((r) => r.status === 'paid') || ((b.walletFunding as any)?.captures ?? []).some((c: any) => c.state === 'applied')) {
        return { expired: false, reason: 'paid' };
      }
      await this.cancelIn(b, records, { reason: 'timeout', actor: { kind: 'system' } }, s, now);
      return { expired: true, booking: b };
    });
    if (out.expired) {
      const b = (out as any).booking as IPartnerLabBooking;
      await this.notify({ userId: b.userId, type: 'booking_cancelled', title: 'Lab booking not completed',
        message: 'Payment was not completed in time, so the booking was released. Any amount taken is back in your wallet.',
        bookingId: id, key: `plb:${id}:cancelled` });
    }
    return { expired: out.expired, reason: (out as any).reason };
  }

  /** Scheduler sweep: reconcile each due booking's payments first; back off while the gateway state is unknown. */
  async expireDue(now = new Date(), limit = 100): Promise<{ examined: number; expired: number; deferred: number }> {
    const due = await PartnerLabBookingModel.find({
      status: 'pending_payment', paymentStatus: 'pending', paymentDeadline: { $lte: now },
      $or: [{ expiryNextAt: { $exists: false } }, { expiryNextAt: null }, { expiryNextAt: { $lte: now } }],
    }).sort({ paymentDeadline: 1 }).limit(limit).select({ _id: 1, expiryChecks: 1 }).lean();
    let expired = 0; let deferred = 0;
    for (const d of due) {
      const id = String(d._id);
      const check = await this.paymentService.reconcileContextPayments('lab_booking', id).catch(() => ({ unknown: 1 }));
      if (check.unknown > 0) {
        const checks = Number(d.expiryChecks || 0) + 1;
        await PartnerLabBookingModel.updateOne({ _id: id, status: 'pending_payment' },
          { $set: { expiryNextAt: new Date(now.getTime() + Math.min(3_600_000, 60_000 * 2 ** Math.min(checks, 6))), expiryChecks: checks } });
        deferred += 1;
        continue;
      }
      if ((await this.expireUnpaid(id, now)).expired) expired += 1;
    }
    return { examined: due.length, expired, deferred };
  }

  // ───────────────────────────── Cancellation (customer, lab, timeout) ─────────────────────────────

  /** Writes every unsettled payment record of the booking first: a capture committing earlier is seen, a later one waits. */
  private async fenceRecords(id: string, s: ClientSession) {
    await PaymentRecordModel.collection.updateMany({ context: 'lab_booking', contextId: id, status: { $nin: ['paid', 'refunded'] } },
      { $set: { updatedAt: new Date() } }, { session: s });
    return PaymentRecordModel.find({ context: 'lab_booking', contextId: id }).session(s).lean() as unknown as Promise<
      { _id: unknown; userId?: string; status?: string; finalAmount?: number }[]>;
  }

  /**
   * One cancellation transaction: status CAS, coupon undo, full refund to the wallet (exactly once, ledger-closed), seat
   * release. Refunds draw only on what the booking holds.
   */
  private async cancelIn(b: IPartnerLabBooking, records: { _id: unknown; userId?: string; status?: string; finalAmount?: number }[],
    c: { reason: 'timeout' | 'customer' | 'lab_reject'; note?: string; actor: Actor }, s: ClientSession, now: Date): Promise<number> {
    const id = String(b._id);
    const r = await PartnerLabBookingModel.updateOne({ _id: id, status: b.status, statusVersion: b.statusVersion }, {
      $set: { status: 'cancelled', paymentStatus: 'refunded', 'lifecycle.cancelledAt': now,
        cancellation: { reason: c.reason, note: c.note, ...byOf(c.actor), at: now }, 'reschedule.pending': false },
      $inc: { statusVersion: 1 }, $unset: { expiryNextAt: 1, expiryChecks: 1 },
    }, { session: s });
    if (r.modifiedCount !== 1) throw changed();
    await undoCouponUsageIn(records.map((x) => String(x._id)), s);
    const owned = records.filter((x) => String(x.userId) === String(b.userId));
    const paid = owned.filter((x) => x.status === 'paid');
    const refunded = await refundAndCloseIn({ model: PartnerLabBookingModel, kind: 'lab_booking', bookingId: id, userId: b.userId,
      legacyFunded: 0, legacyGateway: 0, paidRecords: paid.map((x) => ({ recordId: String(x._id), amount: Number(x.finalAmount || 0) })),
      wallets: this.walletRepository }, s);
    const ledger = await PartnerLabBookingModel.findById(id).select({ walletFunding: 1 }).session(s).lean() as any;
    const returned = new Set(((ledger?.walletFunding?.captures ?? []) as any[]).filter((x) => x.state === 'returned').map((x) => String(x.recordId).toLowerCase()));
    const settled = paid.filter((x) => !(Number(x.finalAmount || 0) > 0) || returned.has(String(x._id).toLowerCase())).map((x) => x._id);
    if (settled.length) await PaymentRecordModel.updateMany({ _id: { $in: settled }, status: 'paid' }, { $set: { status: 'refunded' } }, { session: s });
    await releaseSeat(b.slot.slotId, s);
    if (c.actor.kind === 'partner') {
      await recordPartnerAudit(c.actor.actor, 'lab_booking.reject', { kind: 'lab_booking', id }, { note: c.note, refunded }, s);
    }
    return refunded;
  }

  async customerCancel(userId: string, bookingId: string, note: string | undefined, now = new Date()): Promise<{ booking: Record<string, unknown>; refunded: number }> {
    const id = String(bookingId).toLowerCase();
    const refunded = await runLedgerTransaction(async (s) => {
      const b = await PartnerLabBookingModel.findOne({ _id: id, userId: { $eq: userId } }).session(s).lean() as IPartnerLabBooking | null;
      if (!b) throw notFound();
      if (!['pending_payment', 'confirmed'].includes(b.status)) throw err(409, 'LAB_BOOKING_NOT_CANCELLABLE', `A ${b.status} booking cannot be cancelled`);
      const records = await this.fenceRecords(id, s);
      const captured = b.paymentStatus === 'paid' || records.some((r) => r.status === 'paid');
      if (captured && !b.reschedule?.pending && now.getTime() > new Date(b.slot.startsAt).getTime() - LAB_CANCEL_CUTOFF_MS) {
        throw err(409, 'CANCELLATION_WINDOW_CLOSED', 'Bookings can be cancelled up to 2 hours before the slot');
      }
      return this.cancelIn(b, records, { reason: 'customer', note, actor: { kind: 'customer', userId } }, s, now);
    });
    const after = await PartnerLabBookingModel.findById(id).lean() as IPartnerLabBooking;
    await this.notify({ userId, type: 'booking_cancelled', title: 'Lab booking cancelled',
      message: refunded > 0 ? `Cancelled. ₹${refunded.toFixed(2)} is back in your wallet.` : 'Your lab booking was cancelled.',
      bookingId: id, key: `plb:${id}:cancelled` });
    return { booking: customerView(after), refunded };
  }

  /** Q11: a staff step may name the statusVersion it was decided on; a different current version refuses it. */
  private assertVersion(b: IPartnerLabBooking, expectedVersion?: number) {
    if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== Number(b.statusVersion)) {
      throw err(409, 'LAB_BOOKING_CHANGED', 'The booking changed since you opened it; review it again');
    }
  }

  async labReject(actor: PartnerActor, bookingId: string, note: string, now = new Date(), expectedVersion?: number): Promise<{ booking: Record<string, unknown>; refunded: number }> {
    const id = String(bookingId).toLowerCase();
    const refunded = await runLedgerTransaction(async (s) => {
      const b = await this.scopedBooking(actor, id, s);
      if (b.status !== 'confirmed') throw err(409, 'LAB_BOOKING_STATE_CONFLICT', `A ${b.status} booking cannot be rejected`);
      this.assertVersion(b, expectedVersion);
      const records = await this.fenceRecords(id, s);
      return this.cancelIn(b, records, { reason: 'lab_reject', note, actor: { kind: 'partner', actor } }, s, now);
    });
    const after = await PartnerLabBookingModel.findById(id).lean() as IPartnerLabBooking;
    await this.notify({ userId: after.userId, type: 'booking_cancelled', title: 'The lab could not take your booking',
      message: `${note}. Your full payment is back in your wallet.`, bookingId: id, key: `plb:${id}:cancelled` });
    return { booking: partnerView(after), refunded };
  }

  // ───────────────────────────── Reschedule ─────────────────────────────

  /** Lab moves the booking to another slot of the same branch; the customer may accept, or cancel with a full refund. */
  async labReschedule(actor: PartnerActor, bookingId: string, newSlotId: string, reason: string, now = new Date(), expectedVersion?: number): Promise<Record<string, unknown>> {
    const id = String(bookingId).toLowerCase();
    const after = await runLedgerTransaction(async (s) => {
      const b = await this.scopedBooking(actor, id, s);
      if (b.status !== 'confirmed') throw err(409, 'LAB_BOOKING_STATE_CONFLICT', `A ${b.status} booking cannot be rescheduled`);
      this.assertVersion(b, expectedVersion);
      if (String(newSlotId) === String(b.slot.slotId)) throw err(409, 'SAME_SLOT', 'Pick a different slot');
      const slot = await takeSeat(newSlotId, { partnerId: b.partnerId, branchId: b.branchId, visitMode: b.visitMode, minStart: now }, s);
      await releaseSeat(b.slot.slotId, s);
      const next: ILabBookingSlot = { slotId: String(slot._id), date: slot.date, startTime: slot.startTime, endTime: slot.endTime, startsAt: slot.startsAt };
      const updated = await PartnerLabBookingModel.findOneAndUpdate({ _id: id, status: 'confirmed', statusVersion: b.statusVersion }, {
        $set: { slot: next, 'reschedule.pending': true, 'reschedule.previousSlot': b.slot, 'reschedule.reason': reason, 'reschedule.at': now,
          'reschedule.by': byOf({ kind: 'partner', actor }).by },
        $inc: { statusVersion: 1, 'reschedule.version': 1 },
      }, { new: true, session: s }).lean();
      if (!updated) throw changed();
      await recordPartnerAudit(actor, 'lab_booking.reschedule', { kind: 'lab_booking', id }, { from: b.slot, to: next, reason }, s);
      return updated as IPartnerLabBooking;
    });
    await this.notify({ userId: after.userId, type: 'general', title: 'The lab proposed a new time',
      message: `New time: ${after.slot.date} ${after.slot.startTime}. Accept it, or cancel for a full refund.`,
      bookingId: id, key: `plb:${id}:reschedule:${after.reschedule.version}` });
    return partnerView(after);
  }

  async acceptReschedule(userId: string, bookingId: string, version: number): Promise<Record<string, unknown>> {
    const id = String(bookingId).toLowerCase();
    const updated = await PartnerLabBookingModel.findOneAndUpdate(
      { _id: id, userId: { $eq: userId }, status: 'confirmed', 'reschedule.pending': true, 'reschedule.version': version },
      { $set: { 'reschedule.pending': false }, $inc: { statusVersion: 1 } },
      { new: true }
    ).lean();
    if (!updated) {
      const b = await this.ownBooking(userId, id);
      if (!b.reschedule?.pending) throw err(409, 'NO_PENDING_RESCHEDULE', 'There is no new time to accept');
      throw err(409, 'RESCHEDULE_CHANGED', 'The lab changed the time again; review the latest proposal');
    }
    return customerView(updated as IPartnerLabBooking);
  }

  // ───────────────────────────── Staff transitions (§4 table) ─────────────────────────────

  async assignCollector(actor: PartnerActor, bookingId: string, collector: { memberId?: string; name: string; phone?: string }, expectedVersion?: number): Promise<Record<string, unknown>> {
    if (collector.memberId) {
      const m = await MemberModel.findOne({ _id: collector.memberId, partnerId: actor.partnerId, isActive: true }).lean();
      if (!m) throw err(400, 'COLLECTOR_NOT_MEMBER', 'The collector must be an active member of this partner');
    }
    // Q11: a collector is for home collections only.
    return this.transition(actor, bookingId, 'assign', ['confirmed'], 'confirmed', { collector }, { visitMode: 'home', expectedVersion });
  }

  async markCollected(actor: PartnerActor, bookingId: string, expectedVersion?: number) {
    return this.transition(actor, bookingId, 'collect', ['confirmed'], 'sample_collected', { 'lifecycle.collectedAt': new Date() }, { visitMode: 'home', noPendingReschedule: true, expectedVersion });
  }

  async markVisited(actor: PartnerActor, bookingId: string, expectedVersion?: number) {
    return this.transition(actor, bookingId, 'visit', ['confirmed'], 'visited', { 'lifecycle.visitedAt': new Date() }, { visitMode: 'lab', noPendingReschedule: true, expectedVersion });
  }

  /** A no-show is not refunded (§4), so the partner earns it like a completed booking (its slot was kept). */
  async markNoShow(actor: PartnerActor, bookingId: string, now = new Date(), expectedVersion?: number) {
    return this.transition(actor, bookingId, 'no_show', ['confirmed'], 'no_show', { 'lifecycle.noShowAt': now }, { noPendingReschedule: true, slotStarted: now, expectedVersion },
      (b, s) => this.postEarning(actor, b, s));
  }

  async startProcessing(actor: PartnerActor, bookingId: string, expectedVersion?: number) {
    return this.transition(actor, bookingId, 'process', ['sample_collected', 'visited'], 'processing', { 'lifecycle.processingAt': new Date() }, { expectedVersion });
  }

  /** Completion posts the partner's earning (its own price; commission 0) in the same transaction (§7). */
  async complete(actor: PartnerActor, bookingId: string, expectedVersion?: number) {
    return this.transition(actor, bookingId, 'complete', ['report_ready'], 'completed', { 'lifecycle.completedAt': new Date() }, { expectedVersion },
      (b, s) => this.postEarning(actor, b, s));
  }

  /** Earnings only for money actually collected through us (paid bookings), once per booking. */
  private async postEarning(actor: PartnerActor, b: IPartnerLabBooking, s: ClientSession): Promise<void> {
    if (b.paymentStatus !== 'paid') return;
    await postLedgerEntry({
      settlementAccountId: b.settlement.settlementAccountId, kind: 'earning', amountMinor: b.pricing.subtotalMinor,
      grossMinor: b.pricing.subtotalMinor, commissionMinor: 0, source: 'partner_lab_booking', sourceId: String(b._id),
      by: actor.memberId, byKind: actor.actorKind === 'admin' ? 'admin' : 'system',
    }, s);
  }

  private async transition(
    actor: PartnerActor, bookingId: string, command: string, from: LabBookingStatus[], to: LabBookingStatus,
    set: Record<string, unknown>, guards: { visitMode?: VisitMode; noPendingReschedule?: boolean; slotStarted?: Date; expectedVersion?: number } = {},
    sideEffect?: (b: IPartnerLabBooking, s: ClientSession) => Promise<void>
  ): Promise<Record<string, unknown>> {
    const id = String(bookingId).toLowerCase();
    const after = await runLedgerTransaction(async (s) => {
      const b = await this.scopedBooking(actor, id, s);
      if (!from.includes(b.status)) throw err(409, 'LAB_BOOKING_STATE_CONFLICT', `Not allowed while the booking is ${b.status}`);
      this.assertVersion(b, guards.expectedVersion);
      if (guards.visitMode && b.visitMode !== guards.visitMode) {
        throw err(409, 'WRONG_VISIT_MODE', command === 'assign' ? 'A collector is assigned to home collections only'
          : guards.visitMode === 'home' ? 'Only home collections are collected' : 'Only lab visits are marked visited');
      }
      if (guards.noPendingReschedule && b.reschedule?.pending) {
        throw err(409, 'RESCHEDULE_PENDING', 'The customer has not answered the new time yet');
      }
      if (guards.slotStarted && guards.slotStarted < new Date(b.slot.startsAt)) {
        throw err(409, 'SLOT_NOT_STARTED', 'A no-show can be marked only after the slot time');
      }
      const updated = await PartnerLabBookingModel.findOneAndUpdate(
        { _id: id, status: b.status, statusVersion: b.statusVersion },
        { $set: { status: to, ...set }, $inc: { statusVersion: 1 } },
        { new: true, session: s }
      ).lean();
      if (!updated) throw changed();
      if (sideEffect) await sideEffect(b, s);
      await recordPartnerAudit(actor, `lab_booking.${command}`, { kind: 'lab_booking', id }, { from: b.status, to }, s);
      return updated as IPartnerLabBooking;
    });
    if (to !== after.status || command === 'assign') return partnerView(after);
    const messages: Record<string, string> = {
      collect: 'Your sample has been collected.', visit: 'Your lab visit is recorded.', no_show: 'You were marked as not present for your slot.',
      process: 'Your sample is being processed.', complete: 'Your lab booking is complete.',
    };
    if (messages[command]) {
      await this.notify({ userId: after.userId, type: 'general', title: 'Lab booking update', message: messages[command]!,
        bookingId: id, key: `plb:${id}:${command}` });
    }
    return partnerView(after);
  }

  // ───────────────────────────── Reports (§4: upload draft, release separately) ─────────────────────────────

  async uploadReports(actor: PartnerActor, bookingId: string, files: string[], requestKey?: string): Promise<Record<string, unknown>> {
    const id = String(bookingId).toLowerCase();
    const current = await this.scopedBooking(actor, id);
    if (!['processing', 'report_ready'].includes(current.status)) {
      throw err(409, 'LAB_BOOKING_STATE_CONFLICT', 'Reports can be uploaded while the sample is being processed');
    }
    const paths = [...new Set(files.map(uploadPathOf).filter((p): p is string => !!p))];
    if (!paths.length || paths.length !== files.length) throw err(400, 'INVALID_REPORT_FILE', 'Upload the report files first');
    const prefix = `${REPORT_UPLOAD_MODULE}/${id}/`;
    if (paths.some((p) => !p.startsWith(prefix))) throw err(400, 'INVALID_REPORT_FILE', 'Report files must be uploaded for this booking');
    const previous = current.report?.draftFiles ?? [];
    const saved = await attachFiles(readerOf(actor), 'PartnerLabBooking',
      [{ field: 'report.draftFiles', values: [...previous, ...paths], previous, kind: 'partner_lab_report_draft' }],
      () => runLedgerTransaction(async (s) => {
        const u = await PartnerLabBookingModel.findOneAndUpdate(
          { _id: id, status: { $in: ['processing', 'report_ready'] }, ...(requestKey ? { 'report.uploadKeys': { $ne: requestKey } } : {}) },
          { $addToSet: { 'report.draftFiles': { $each: paths }, ...(requestKey ? { 'report.uploadKeys': requestKey } : {}) } },
          { new: true, session: s }
        ).lean();
        if (!u) throw changed();
        await recordPartnerAudit(actor, 'lab_booking.report_upload', { kind: 'lab_booking', id }, { files: paths }, s);
        return u as IPartnerLabBooking;
      }),
      (b) => b._id, id);
    return partnerView(saved);
  }

  /** Report bytes are written only here, under the booking's own folder, by an admitted member allowed to upload them. */
  uploadFilesFor: (req: unknown, module: string, recordId: string) => Promise<{ url: string }[]> = async (req, module, recordId) => {
    const { FileService } = await import('@/modules/file/services');
    return Container.get(FileService).uploadFiles(req, module, recordId, { allowReserved: true });
  };

  async uploadReportFiles(actor: PartnerActor, bookingId: string, req: unknown, requestKey?: string): Promise<Record<string, unknown> & { replayed?: boolean }> {
    const id = String(bookingId).toLowerCase();
    const b = await this.scopedBooking(actor, id);
    // Q11: an upload whose answer was lost, sent again with its key, is answered with the booking (no second copy).
    if (requestKey && (b.report?.uploadKeys ?? []).includes(requestKey)) return { ...partnerView(b), replayed: true };
    if (!['processing', 'report_ready'].includes(b.status)) {
      throw err(409, 'LAB_BOOKING_STATE_CONFLICT', 'Reports can be uploaded while the sample is being processed');
    }
    const files = await this.uploadFilesFor(req, REPORT_UPLOAD_MODULE, id);
    return this.uploadReports(actor, id, files.map((f) => f.url), requestKey);
  }

  /** Q11: a draft report uploaded by mistake is taken off the booking (released reports cannot be removed). */
  async removeDraftReport(actor: PartnerActor, bookingId: string, file: string): Promise<Record<string, unknown>> {
    const id = String(bookingId).toLowerCase();
    const path = uploadPathOf(file);
    if (!path) throw err(400, 'INVALID_REPORT_FILE', 'Unknown report file');
    const after = await runLedgerTransaction(async (s) => {
      const b = await this.scopedBooking(actor, id, s);
      if (!['processing', 'report_ready'].includes(b.status)) throw err(409, 'LAB_BOOKING_STATE_CONFLICT', `Not allowed while the booking is ${b.status}`);
      const u = await PartnerLabBookingModel.findOneAndUpdate({ _id: id, 'report.draftFiles': path },
        { $pull: { 'report.draftFiles': path } }, { new: true, session: s }).lean();
      if (!u) throw err(404, 'REPORT_NOT_FOUND', 'That draft report is not on this booking');
      await recordPartnerAudit(actor, 'lab_booking.report_remove_draft', { kind: 'lab_booking', id }, { file: path }, s);
      return u as IPartnerLabBooking;
    });
    return partnerView(after);
  }

  /**
   * Releases one exact draft file under a named professional (member with `reports.release` and a registration number):
   * moves it to releasedFiles (customer-readable), stamps the signer, and sets report_ready. Idempotent: releasing an
   * already released file only repairs its grant.
   */
  async releaseReport(actor: PartnerActor, bookingId: string, file: string, signerMemberId?: string, now = new Date(), expectedVersion?: number): Promise<Record<string, unknown>> {
    const id = String(bookingId).toLowerCase();
    const path = uploadPathOf(file);
    if (!path) throw err(400, 'INVALID_REPORT_FILE', 'Unknown report file');
    const before = await this.scopedBooking(actor, id);
    const signer = await this.signerFor(actor, signerMemberId, before.branchId);
    let after: IPartnerLabBooking;
    if ((before.report?.releasedFiles ?? []).includes(path)) {
      after = before;
    } else {
      after = await runLedgerTransaction(async (s) => {
        const b = await this.scopedBooking(actor, id, s);
        if (!['processing', 'report_ready'].includes(b.status)) throw err(409, 'LAB_BOOKING_STATE_CONFLICT', `Not allowed while the booking is ${b.status}`);
        this.assertVersion(b, expectedVersion);
        if (!(b.report?.draftFiles ?? []).includes(path)) throw err(404, 'REPORT_NOT_FOUND', 'That draft report is not on this booking');
        const u = await PartnerLabBookingModel.findOneAndUpdate(
          { _id: id, statusVersion: b.statusVersion, 'report.draftFiles': path },
          {
            $pull: { 'report.draftFiles': path },
            $addToSet: { 'report.releasedFiles': path },
            $push: { 'report.releases': { path, releasedAt: now, releasedBy: actor.memberId, signer } },
            $set: { status: 'report_ready', ...(b.status === 'processing' ? { 'lifecycle.reportReadyAt': now } : {}) },
            $inc: { statusVersion: 1 },
          },
          { new: true, session: s }
        ).lean();
        if (!u) throw changed();
        await recordPartnerAudit(actor, 'lab_booking.report_release', { kind: 'lab_booking', id }, { file: path, signer }, s);
        return u as IPartnerLabBooking;
      });
      await this.notify({ userId: after.userId, type: 'general', title: 'Your lab report is ready',
        message: 'Open the app to view your report.', bookingId: id, key: `plb:${id}:report:${path}` });
    }
    await grantFiles(readerOf(actor), [path], 'partner_lab_report', { model: 'PartnerLabBooking', resourceId: id, field: 'report.releasedFiles' });
    return partnerView(after);
  }

  private async signerFor(actor: PartnerActor, signerMemberId: string | undefined, branchId: string) {
    const memberId = actor.actorKind === 'admin' ? signerMemberId : actor.memberId;
    if (!memberId) throw err(400, 'SIGNER_REQUIRED', 'Name the professional releasing this report');
    if (actor.actorKind !== 'admin' && signerMemberId && signerMemberId !== actor.memberId) {
      throw err(403, 'SIGNER_MUST_BE_SELF', 'Members release reports under their own registration');
    }
    const m = await MemberModel.findOne({ _id: memberId, partnerId: actor.partnerId, isActive: true }).lean();
    const allowed = !!m && (m.role === 'owner' || (m.permissions ?? []).includes('reports.release'));
    if (!m || !allowed) throw err(403, 'SIGNER_NOT_AUTHORISED', 'The signer must be an active member allowed to release reports');
    // The named professional needs the same whole authority as releasing it themselves: this booking's branch too.
    const scope = (m.branchIds ?? []).map(String);
    if (m.role !== 'owner' && scope.length > 0 && !scope.includes(String(branchId))) {
      throw err(403, 'SIGNER_NOT_AUTHORISED', 'The signer does not work at this booking\'s branch');
    }
    if (!m.professional?.registrationNumber) {
      throw err(409, 'SIGNER_REGISTRATION_MISSING', 'Add the professional registration number to this member before releasing');
    }
    return { memberId: String(m._id), name: m.name, kind: m.professional.kind, registrationNumber: m.professional.registrationNumber };
  }

  // ───────────────────────────── Reads ─────────────────────────────

  private async ownBooking(userId: string, bookingId: string): Promise<IPartnerLabBooking> {
    if (!Types.ObjectId.isValid(bookingId)) throw notFound();
    const b = await PartnerLabBookingModel.findOne({ _id: bookingId, userId: { $eq: userId } }).lean();
    if (!b) throw notFound();
    return b as IPartnerLabBooking;
  }

  private async scopedBooking(actor: PartnerActor, bookingId: string, s?: ClientSession): Promise<IPartnerLabBooking> {
    if (!Types.ObjectId.isValid(bookingId)) throw notFound();
    const b = await PartnerLabBookingModel.findById(bookingId).session(s ?? null).lean() as IPartnerLabBooking | null;
    if (!b || b.partnerId !== actor.partnerId) throw notFound();
    if (!hasGlobalScope(actor) && !actor.branchIds.includes(b.branchId)) throw notFound();
    return b;
  }

  async getForCustomer(userId: string, bookingId: string) {
    return customerViewNamed(await this.ownBooking(userId, bookingId));
  }

  /** Q9: paged, newest first, each with the lab's and branch's names (and the branch's address/phone). */
  async listForCustomer(userId: string, page = 1, limit = 20) {
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const pg = Math.max(Number(page) || 1, 1);
    const q = { userId: { $eq: userId } };
    const [rows, total] = await Promise.all([
      PartnerLabBookingModel.find(q).sort({ createdAt: -1, _id: -1 }).skip((pg - 1) * lim).limit(lim).lean(),
      PartnerLabBookingModel.countDocuments(q),
    ]);
    const named = await withPlaceNames(rows as IPartnerLabBooking[]);
    return { items: named, page: pg, limit: lim, total, totalPages: Math.max(1, Math.ceil(total / lim)) };
  }

  /** Q9: one partner lab as customers see it (verified, active; active branches only). */
  async labProfile(partnerId: string) {
    if (!/^[0-9a-fA-F]{24}$/.test(String(partnerId))) throw new AppError({ status: 404, code: 'LAB_NOT_FOUND', message: 'Lab not found' });
    const p = await PartnerOrgModel.findOne({ _id: partnerId, kind: 'lab', isActive: true, 'verification.state': 'verified' }).select({ name: 1, logo: 1 }).lean() as any;
    if (!p) throw new AppError({ status: 404, code: 'LAB_NOT_FOUND', message: 'Lab not found' });
    const branches = await BranchModel.find({ partnerId: String(p._id), isActive: true }).select({ name: 1, address: 1, phone: 1, services: 1, hours: 1 }).lean();
    return { partnerId: String(p._id), name: p.name, logo: p.logo, provider: 'partner' as const, branches };
  }

  async getForPartner(actor: PartnerActor, bookingId: string) {
    return partnerView(await this.scopedBooking(actor, bookingId));
  }

  /** Q11: paged by an exact cursor on (slot.startsAt, _id), soonest first, with the total. */
  async listForPartnerPage(actor: PartnerActor, f: { status?: LabBookingStatus; branchId?: string; from?: string; to?: string; limit?: number; cursor?: string }) {
    const q: Record<string, unknown> = { partnerId: actor.partnerId };
    if (f.branchId) { assertBranchInScope(actor, f.branchId); q.branchId = f.branchId; }
    else if (!hasGlobalScope(actor)) q.branchId = { $in: actor.branchIds };
    if (f.status) q.status = f.status;
    if (f.from || f.to) q['slot.date'] = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) };
    const total = await PartnerLabBookingModel.countDocuments(q);
    const page: Record<string, unknown> = { ...q };
    if (f.cursor) {
      const [ms, cid] = f.cursor.split('_');
      if (!/^\d{1,15}$/.test(ms ?? '') || !Types.ObjectId.isValid(cid ?? '')) throw err(400, 'INVALID_CURSOR', 'Invalid cursor');
      const at = new Date(Number(ms));
      page.$or = [{ 'slot.startsAt': { $gt: at } }, { 'slot.startsAt': at, _id: { $gt: new Types.ObjectId(cid) } }];
    }
    const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 200);
    const rows = await PartnerLabBookingModel.find(page).sort({ 'slot.startsAt': 1, _id: 1 }).limit(limit + 1).lean() as IPartnerLabBooking[];
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items: items.map((b) => partnerView(b)), total,
      nextCursor: rows.length > limit && last ? `${new Date(last.slot.startsAt).getTime()}_${String(last._id)}` : null };
  }

  /** Q11: admin list across partners — paged (newest first), filters, the partner view (never stored internals). */
  async adminList(f: { partnerId?: string; status?: LabBookingStatus; from?: string; to?: string; page?: number; limit?: number }) {
    const q: Record<string, unknown> = {};
    if (f.partnerId) q.partnerId = String(f.partnerId).toLowerCase();
    if (f.status) q.status = f.status;
    if (f.from || f.to) q['slot.date'] = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) };
    const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 200);
    const pg = Math.max(Number(f.page) || 1, 1);
    const [rows, total] = await Promise.all([
      PartnerLabBookingModel.find(q).sort({ createdAt: -1, _id: -1 }).skip((pg - 1) * limit).limit(limit).lean(),
      PartnerLabBookingModel.countDocuments(q),
    ]);
    return { items: (rows as IPartnerLabBooking[]).map((b) => partnerView(b)), page: pg, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async listForPartner(actor: PartnerActor, f: { status?: LabBookingStatus; branchId?: string; from?: string; to?: string; limit?: number }) {
    const q: Record<string, unknown> = { partnerId: actor.partnerId };
    if (f.branchId) { assertBranchInScope(actor, f.branchId); q.branchId = f.branchId; }
    else if (!hasGlobalScope(actor)) q.branchId = { $in: actor.branchIds };
    if (f.status) q.status = f.status;
    if (f.from || f.to) q['slot.date'] = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) };
    const rows = await PartnerLabBookingModel.find(q).sort({ 'slot.startsAt': 1 }).limit(Math.min(f.limit ?? 100, 500)).lean();
    return rows.map((b) => partnerView(b as IPartnerLabBooking));
  }

  // ───────────────────────────── Customer discovery ─────────────────────────────

  async listLabs(f: { city?: string; pincode?: string; visitMode?: VisitMode }) {
    const partners = await PartnerOrgModel.find({ kind: 'lab', isActive: true, 'verification.state': 'verified' })
      .select({ name: 1, logo: 1 }).sort({ name: 1 }).limit(500).lean();
    const ids = partners.map((p) => String(p._id));
    const branchQ: Record<string, unknown> = { partnerId: { $in: ids }, isActive: true };
    if (f.city) branchQ['address.city'] = new RegExp(`^${f.city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    if (f.pincode) branchQ['address.pincode'] = f.pincode;
    if (f.visitMode === 'home') branchQ['services.homeCollection'] = true;
    if (f.visitMode === 'lab') branchQ['services.inLab'] = true;
    const branches = await BranchModel.find(branchQ).select({ partnerId: 1, name: 1, address: 1, phone: 1, services: 1, hours: 1 }).lean();
    return partners
      .map((p) => ({
        partnerId: String(p._id), name: p.name, logo: p.logo, provider: 'partner' as const,
        branches: branches.filter((b) => String(b.partnerId) === String(p._id)).map((b) => ({
          branchId: String(b._id), name: b.name, address: b.address, phone: b.phone,
          homeCollection: !!b.services?.homeCollection, inLab: !!b.services?.inLab, hours: b.hours,
        })),
      }))
      .filter((p) => p.branches.length > 0);
  }

  async labCatalogue(partnerId: string, visitMode?: VisitMode) {
    const p = await PartnerOrgModel.findOne({ _id: partnerId, kind: 'lab', isActive: true, 'verification.state': 'verified' }).lean();
    if (!p) throw err(404, 'LAB_NOT_FOUND', 'This lab is not available');
    const items = await CatalogueItemModel.find({ partnerId, isActive: true, adminDisabled: { $ne: true }, ...(visitMode ? { visitModes: visitMode } : {}) })
      .sort({ name: 1 }).limit(1000).lean();
    return items.map((i) => ({
      itemId: String(i._id), kind: i.kind, name: i.name, code: i.code, description: i.description, preparation: i.preparation,
      sampleType: i.sampleType, includes: i.includes, price: rupees(i.priceMinor), priceMinor: i.priceMinor,
      mrpMinor: i.mrpMinor, visitModes: i.visitModes, reportTatHours: i.reportTatHours,
    }));
  }

  async branchSlots(branchId: string, visitMode: VisitMode, from: string | undefined, days: number, now = new Date()) {
    const b = await BranchModel.findById(branchId).lean();
    const p = b ? await PartnerOrgModel.findOne({ _id: b.partnerId, kind: 'lab', isActive: true, 'verification.state': 'verified' }).lean() : null;
    if (!b || !p || b.isActive === false) throw err(404, 'BRANCH_NOT_AVAILABLE', 'This branch is not available');
    const start = from ?? istDate(now);
    const rows = await listBookableSlots(branchId, visitMode, start, addDays(start, Math.min(Math.max(days, 1), 30) - 1), new Date(now.getTime() + LAB_MIN_LEAD_MS));
    return rows.map((r) => ({ slotId: String(r._id), date: r.date, startTime: r.startTime, endTime: r.endTime, seatsLeft: r.capacity - r.booked }));
  }
}

/** Registers the 'lab_booking' payment context (called once at startup, and by tests). */
export function registerLabBookingPayments(resolve: () => LabBookingService = () => Container.get(LabBookingService)): void {
  registerPaymentContextHandler('lab_booking', {
    process: (record, helpers) => resolve().applyCapture(record, helpers),
    entity: async (record) => {
      const b = await PartnerLabBookingModel.findById(record.contextId).lean();
      return b ? customerView(b as IPartnerLabBooking) : {};
    },
  });
}
