import { Service, Container } from 'typedi';
import { createHash } from 'crypto';
import { billsForLabBookings, canonicalJson } from '@/modules/partners/services/invoice';
import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { fundBookingFromWallet, recordGatewayCapture, refundAndCloseIn, runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { claimRequestKey, scopeOf } from '@/modules/requestKeys';
import { undoCouponUsageIn } from '@/modules/coupon/usage';
import { sweepFailure } from '@/modules/common/utils/sweepFailure';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentService, registerPaymentContextHandler } from '@/modules/payment/services';
import type { IPaymentRecord, PaymentContext } from '@/modules/payment/types';
import { CouponService } from '@/modules/coupon/services';
import { WalletRepository } from '@/modules/wallet/repository';
import UserModel from '@/modules/user/model';
import DependentModel from '@/modules/dependents/model';
import PartnerOrgModel from '@/modules/partners/model';
import BranchModel from '@/modules/partners/model/branch';
import MemberModel from '@/modules/partners/model/member';
import CatalogueItemModel from '@/modules/partners/model/catalogueItem';
import { PartnerLabBookingModel, IPartnerLabBooking, LabBookingStatus, ILabBookingSlot, ILabBookingItem } from '@/modules/partners/model/labBooking';
import type { VisitMode } from '@/modules/partners/model/slot';
import { PartnerActor, assertBranchInScope, hasGlobalScope, recordPartnerAudit } from '@/modules/partners/services';
import { ensureSettlementAccount, postLedgerEntry } from '@/modules/partners/services/settlement';
import { takeSeat, releaseSeat, listBookableSlots, istDate, addDays } from '@/modules/partners/services/slots';
import { attachFiles, grantFiles, rebindStored, uploadPathOf } from '@/modules/file/access';
import type { AuthRequest } from '@/modules/middleware/auth';
import { settleAssistedLabFundingIn } from '@/modules/assisted/labRefunds';
import { LAB_NOT_DISPUTED_QUERY, LAB_UNPAID_CARD_QUERY, assistedLabCustomerPart, assistedLabPartnerPart, isUnpaidCardLab } from '@/modules/assisted/labViews';
import { bookerMoneyLine, cancellationRowOf } from '@/modules/assisted/refunds';
import { cardContextOf, kickCardRefunds } from '@/modules/assisted/cardRefunds';
import { auditIn, sendAssistedNotices, type AssistedNotice } from '@/modules/assisted/support';
import { deskCustomerPart, deskLabPart, isDeskRow, isWalkIn } from '@/modules/assisted/deskViews';
import { bookerNoticeUserId } from '@/modules/assisted/bookers';

export const LAB_PAYMENT_WINDOW_MS = 30 * 60_000;

/** Q16a re-review (N6): the end of a booked lab slot — its start plus the slot's own length (HH:mm start → end). */
export function labSlotEnd(slot: { startsAt: Date | string; startTime?: string; endTime?: string }): Date {
  const start = new Date(slot.startsAt);
  const min = (t?: string) => (typeof t === 'string' && /^\d{2}:\d{2}$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : NaN);
  let len = min(slot.endTime) - min(slot.startTime);
  if (!Number.isFinite(len)) len = 0;
  if (len < 0) len += 24 * 60; // a window running past midnight
  return new Date(start.getTime() + len * 60_000);
}
/** Customers may cancel (full refund) until 2 hours before the slot, or any time while a lab reschedule is unanswered. */
export const LAB_CANCEL_CUTOFF_MS = 2 * 3_600_000;
/** r11 (decision 4): the booking partner may cancel an assisted lab booking up to 1 hour before the slot. */
export const BOOKER_CANCEL_CUTOFF_MS = 60 * 60_000;
/** A slot must start at least this long after booking. */
export const LAB_MIN_LEAD_MS = 60 * 60_000;
export const REPORT_UPLOAD_MODULE = 'partner-lab-reports';

const rupees = (paise: number) => Math.round(paise) / 100;
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const notFound = () => err(404, 'LAB_BOOKING_NOT_FOUND', 'Booking not found');
/** Q14: a booking rescheduled after a no-show is never refunded. */
const noShowNotRefundable = () => err(409, 'NO_SHOW_NOT_REFUNDABLE', 'This booking was rescheduled after a no-show and cannot be refunded');
const changed = () => Object.assign(err(409, 'LAB_BOOKING_CHANGED', 'The booking changed meanwhile; reload and try again'), { retryable: true });
/** r12 (§5.5): a lab desk booking is paid at the lab; no payment of it ever runs through Jansetu. */
const payAtLab = () => err(409, 'PAY_AT_LAB', 'This booking is paid at the lab');

export type LabNotifier = (n: { userId: string; type: 'booking_confirmed' | 'booking_cancelled' | 'general'; title: string; message: string;
  bookingId: string; key: string }) => Promise<void>;

/** Default: the existing in-app notification + push (best effort; never fails the operation). */
export const defaultLabNotifier: LabNotifier = async (n) => {
  try {
    const { NotificationService } = await import('@/modules/notification/services');
    await Container.get(NotificationService).create({
      userId: n.userId, type: n.type, title: n.title, message: n.message,
      referenceType: 'partner_lab_booking', referenceId: n.bookingId, idempotencyKey: n.key, data: { bookingId: n.bookingId, bookingKind: 'lab_booking' },
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

/** Whether a branch offers a visit mode (home collection or a lab visit). */
export const branchOffers = (b: { services?: { homeCollection?: boolean; inLab?: boolean } } | null | undefined, visitMode: VisitMode): boolean =>
  !!(visitMode === 'home' ? b?.services?.homeCollection : b?.services?.inLab);

/** The booking's snapshot of a catalogue item (its price, GST and code as booked). */
export const itemSnapshot = (i: Record<string, any>): ILabBookingItem => ({ catalogItemId: String(i._id), kind: i.kind, name: i.name, code: i.code,
  priceMinor: i.priceMinor, mrpMinor: i.mrpMinor, gstRate: i.gstRate, sac: i.sac, reportTatHours: i.reportTatHours });

/**
 * r12: the tests a partner-made booking names (pharmacy 2a, lab desk 2c): this lab's own active items, not disabled by an
 * admin, each offered for the visit mode; returned in the order the request listed them.
 */
export async function admitLabItems(partnerId: string, itemIds: string[], visitMode: VisitMode): Promise<Record<string, any>[]> {
  const ids = [...new Set((itemIds ?? []).map((x) => String(x).toLowerCase()))];
  const items = await CatalogueItemModel.find({ _id: { $in: ids }, partnerId: String(partnerId), isActive: true, adminDisabled: { $ne: true } }).lean() as Record<string, any>[];
  if (items.length !== ids.length) throw err(400, 'CATALOGUE_ITEM_NOT_AVAILABLE', 'A selected test is no longer available');
  if (items.some((i) => !(i.visitModes ?? []).includes(visitMode))) throw err(400, 'VISIT_MODE_NOT_SUPPORTED', 'A selected test is not offered for this visit type');
  const byId = new Map(items.map((i) => [String(i._id).toLowerCase(), i]));
  return ids.map((x) => byId.get(x)!);
}

/** r11: `booker` = the pharmacy that made and paid an assisted booking (§24.4.4). */
type Actor = { kind: 'customer'; userId: string } | { kind: 'partner'; actor: PartnerActor } | { kind: 'system' } | { kind: 'booker'; id: string };
const byOf = (a: Actor) => a.kind === 'customer' ? { by: a.userId, byKind: 'customer' as const }
  : a.kind === 'partner' ? { by: a.actor.memberId, byKind: a.actor.actorKind === 'admin' ? 'admin' as const : 'member' as const }
  : a.kind === 'booker' ? { by: a.id, byKind: 'booker' as const }
  : { by: 'system', byKind: 'system' as const };
type CancelReason = 'timeout' | 'customer' | 'lab_reject' | 'admin_no_show' | 'partner' | 'desk';
/** r11: the refund row's cause of an assisted lab cancellation, by who cancelled it (a desk cancel is never of an assisted row). */
const ASSISTED_CAUSE: Record<Exclude<CancelReason, 'desk'>, string> = { customer: 'patient', lab_reject: 'partner_lab_reject', admin_no_show: 'admin', partner: 'booker', timeout: 'system' };
const isAssisted = (b: { assisted?: unknown } | null | undefined) => !!(b?.assisted && typeof b.assisted === 'object');
const shownSlot = (b: IPartnerLabBooking) => `${b.slot.date} at ${b.slot.startTime}`;
/** r14: the payment context of a row's gateway payments — a partner's card payment of an assisted row, else the customer's. */
const payContextOf = (b: IPartnerLabBooking) => (isAssisted(b) ? cardContextOf('lab_booking') : 'lab_booking' as const);
/** r14: the booker notice's money line, by how this cancellation refunded the partner (card/UPI or wallet). */
const bookerMoney = (b: IPartnerLabBooking) => bookerMoneyLine(cancellationRowOf(b.assisted?.funding));

/**
 * r11: in-app notices to the partner that booked an assisted lab booking (after the commit, best effort; no health
 * details), as afterAssistedCancel tells a consultation's booker.
 */
async function tellBooker(b: IPartnerLabBooking, n: Omit<AssistedNotice, 'audience' | 'userId' | 'bookingId'>): Promise<void> {
  if (!b.assisted?.bookedBy?.id) return;
  await sendAssistedNotices([{ ...n, audience: 'booker', userId: bookerNoticeUserId(b.assisted.bookedBy), bookingId: String(b._id),
    data: { bookingKind: 'lab_booking', shortRef: b.assisted.shortRef, ...(n.data ?? {}) } }]);
}

/** r11b: the patient's own step on an assisted lab booking, audited in its transaction (ids and codes only). */
async function auditPatientIn(b: IPartnerLabBooking, userId: string, action: 'booking.cancelled' | 'booking.reschedule_accepted',
  detail: Record<string, unknown>, s: ClientSession): Promise<void> {
  const by = b.assisted!.bookedBy;
  await auditIn({ actorKind: 'customer', actorId: String(userId).toLowerCase(), orgKind: by.kind, orgId: String(by.id).toLowerCase(), action,
    bookingId: String(b._id).toLowerCase(), detail: { kind: 'lab_booking', ...detail } }, s);
}

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
  // r12 (§24.6.3): a desk row shows its bill (the patient reads it under /bills); read through the partners' bill index.
  const desk = rows.filter((r) => isDeskRow(r));
  const bills = await billsForLabBookings(desk.map((r) => String(r._id)), [...new Set(desk.map((r) => String(r.partnerId)))]);
  return rows.map((r) => ({ ...customerView(r), lab: { name: p.get(String(r.partnerId))?.name },
    branch: b.get(String(r.branchId)) ? { name: b.get(String(r.branchId)).name, address: b.get(String(r.branchId)).address, phone: b.get(String(r.branchId)).phone } : undefined,
    ...(isDeskRow(r) ? { bill: bills.get(String(r._id).toLowerCase()) ?? null } : {}) }));
}
export async function customerViewNamed(b: IPartnerLabBooking): Promise<Record<string, unknown>> { return (await withPlaceNames([b]))[0]!; }

/** What a customer sees: never draft report files; released files as URLs. */
export function customerView(b: IPartnerLabBooking): Record<string, unknown> {
  return deskCustomerPart(assistedLabCustomerPart(plainCustomerView(b), b as never), b as never);
}

function plainCustomerView(b: IPartnerLabBooking): Record<string, unknown> {
  const { walletFunding: _w, createRequestKey: _k, createRequestHash: _h, expiryNextAt: _e, expiryChecks: _c, postPaymentCompletedFor: _p,
    report, settlement: _s, cancellation, reschedule, collector, noShows, ...rest } = b as any;
  return {
    ...rest,
    // Q14: a rescheduled no-show, without staff identifiers or request keys.
    ...(noShows ? { noShows: (noShows as any[]).map((n) => ({ at: n.at, rescheduledAt: n.rescheduledAt, fromSlot: n.fromSlot, toSlot: n.toSlot })) } : {}),
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
  const { walletFunding: _w, createRequestKey: _k, createRequestHash: _h, postPaymentCompletedFor: _p, assisted: _a, ...rest } = b as any;
  return deskLabPart(assistedLabPartnerPart({
    ...rest,
    // r11b: a booker's cancellation records the pharmacy's id in `by`; the lab sees `byKind: 'booker'` (and the booker's
    // name in the assisted part), never that id.
    ...(rest.cancellation?.byKind === 'booker' ? { cancellation: (({ by: _by, ...c }) => c)(rest.cancellation) } : {}),
    report: {
      draftFiles: (b.report?.draftFiles ?? []).map((p) => `/api/static/${p}`),
      releasedFiles: (b.report?.releasedFiles ?? []).map((p) => `/api/static/${p}`),
      releases: b.report?.releases ?? [],
    },
  }, b as never), b as never);
}

/** r12 (§24.6.3): the lab views of desk rows carry their bill (`null` while none); other rows are unchanged. */
export async function withDeskBills(partnerId: string, rows: IPartnerLabBooking[], views: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const desk = rows.filter((r) => isDeskRow(r)).map((r) => String(r._id));
  if (!desk.length) return views;
  const bills = await billsForLabBookings(desk, partnerId);
  return views.map((v, i) => (isDeskRow(rows[i]) ? { ...v, bill: bills.get(String(rows[i]!._id).toLowerCase()) ?? null } : v));
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
    if (!branch || String(branch.partnerId) !== String(partner._id) || branch.isActive === false || !branchOffers(branch, input.visitMode)) {
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
        items: items.map(itemSnapshot),
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
    // r12 (§5.5): no wallet use and no gateway order for a desk row (it is paid at the lab).
    if (isDeskRow(booking)) throw payAtLab();
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
    const b = await this.ownBooking(userId, bookingId);
    // r12 (§5.5): pay-again on a desk row: it is paid at the lab.
    if (isDeskRow(b)) throw payAtLab();
    // r11 (§24.4.4): a partner-paid booking is never paid by the patient.
    if (isAssisted(b)) throw err(409, 'PARTNER_PAID_BOOKING', 'This booking was paid by the partner that booked it');
    return this.resume(b, useWallet, now);
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
      const records = await this.fenceRecords(id, s, payContextOf(b));
      if (records.some((r) => r.status === 'paid') || ((b.walletFunding as any)?.captures ?? []).some((c: any) => c.state === 'applied')) {
        return { expired: false, reason: 'paid' };
      }
      await this.cancelIn(b, records, { reason: 'timeout', actor: { kind: 'system' } }, s, now);
      return { expired: true, booking: b };
    });
    // r14 (C7): a partner's card booking that expired unpaid was never announced to the patient; nobody is told.
    if (out.expired && !isAssisted((out as any).booking)) {
      const b = (out as any).booking as IPartnerLabBooking;
      await this.notify({ userId: b.userId, type: 'booking_cancelled', title: 'Lab booking not completed',
        message: 'Payment was not completed in time, so the booking was released. Any amount taken is back in your wallet.',
        bookingId: id, key: `plb:${id}:cancelled` });
    }
    return { expired: out.expired, reason: (out as any).reason };
  }

  /** Scheduler sweep: reconcile each due booking's payments first; back off while the gateway state is unknown. */
  async expireDue(now = new Date(), limit = 100): Promise<{ examined: number; expired: number; deferred: number; failed: number }> {
    // r12 (§5.5): a desk row (paid at the lab) never expires; it is never pending_payment anyway. Every other row as before.
    const due = await PartnerLabBookingModel.find({
      status: 'pending_payment', paymentStatus: 'pending', paymentDeadline: { $lte: now }, 'settlement.settlementSystem': { $ne: 'lab_desk' },
      $or: [{ expiryNextAt: { $exists: false } }, { expiryNextAt: null }, { expiryNextAt: { $lte: now } }],
    }).sort({ paymentDeadline: 1 }).limit(limit).select({ _id: 1, expiryChecks: 1, 'assisted.bookedBy.kind': 1 }).lean();
    let expired = 0; let deferred = 0; let failed = 0;
    for (const d of due) {
      const id = String(d._id);
      // Q16a: one failing row never stops the sweep; logged by id and error only (no patient data), retried next run.
      try {
        // r14: a partner's card booking is paid under its own context (`assisted_lab_booking`).
        const check = await this.paymentService.reconcileContextPayments(payContextOf(d as IPartnerLabBooking), id).catch(() => ({ unknown: 1 }));
        if (check.unknown > 0) {
          const checks = Number(d.expiryChecks || 0) + 1;
          await PartnerLabBookingModel.updateOne({ _id: id, status: 'pending_payment' },
            { $set: { expiryNextAt: new Date(now.getTime() + Math.min(3_600_000, 60_000 * 2 ** Math.min(checks, 6))), expiryChecks: checks } });
          deferred += 1;
          continue;
        }
        if ((await this.expireUnpaid(id, now)).expired) expired += 1;
      } catch (e) {
        failed += 1;
        sweepFailure('lab unpaid expiry', id, e);
      }
    }
    return { examined: due.length, expired, deferred, failed };
  }

  // ───────────────────────────── Cancellation (customer, lab, timeout) ─────────────────────────────

  /** Writes every unsettled payment record of the booking first: a capture committing earlier is seen, a later one waits. */
  private async fenceRecords(id: string, s: ClientSession, context: PaymentContext = 'lab_booking') {
    await PaymentRecordModel.collection.updateMany({ context, contextId: id, status: { $nin: ['paid', 'refunded'] } },
      { $set: { updatedAt: new Date() } }, { session: s });
    return PaymentRecordModel.find({ context, contextId: id }).session(s).lean() as unknown as Promise<
      { _id: unknown; userId?: string; status?: string; finalAmount?: number }[]>;
  }

  /**
   * One cancellation transaction: status CAS, coupon undo, full refund to the wallet (exactly once, ledger-closed), seat
   * release. Refunds draw only on what the booking holds.
   */
  private async cancelIn(b: IPartnerLabBooking, records: { _id: unknown; userId?: string; status?: string; finalAmount?: number }[],
    c: { reason: CancelReason; note?: string; actor: Actor; refundTo?: 'card' | 'wallet' }, s: ClientSession, now: Date): Promise<number> {
    const id = String(b._id);
    const desk = isDeskRow(b);
    const r = await PartnerLabBookingModel.updateOne({ _id: id, status: b.status, statusVersion: b.statusVersion }, {
      // r12 (§5.5): a desk row was never paid through Jansetu: its payment status stays `pending`.
      $set: { status: 'cancelled', ...(desk ? {} : { paymentStatus: 'refunded' }), 'lifecycle.cancelledAt': now,
        cancellation: { reason: c.reason, note: c.note, ...byOf(c.actor), at: now, ...(c.reason === 'admin_no_show' ? { refund: true } : {}) }, 'reschedule.pending': false },
      $inc: { statusVersion: 1 }, $unset: { expiryNextAt: 1, expiryChecks: 1 },
    }, { session: s });
    if (r.modifiedCount !== 1) throw changed();
    // r12 (§5.5): a desk row refunds nothing (the lab settles any cash itself); its seat (none for a walk-in) is released once.
    if (desk) {
      if (!isWalkIn(b)) await releaseSeat(b.slot.slotId, s);
      if (c.actor.kind === 'partner') {
        await recordPartnerAudit(c.actor.actor, c.reason === 'desk' ? 'lab_desk.cancelled' : c.reason === 'admin_no_show' ? 'lab_booking.no_show_cancelled' : 'lab_booking.reject',
          { kind: 'lab_booking', id }, { note: c.note, refunded: 0, payAtLab: true }, s);
      }
      return 0;
    }
    // r11 (§24.4.4): a partner-paid booking refunds the PARTNER (its wallet, exactly once), never the customer wallet.
    // r14: a card-paid one goes back by its card refund row (to the card; the wallet only on the booker's own choice).
    if (isAssisted(b) && b.assisted?.funding) {
      // A desk row (the only one cancelled with `desk`) returned above.
      const back = await settleAssistedLabFundingIn(b, { cause: ASSISTED_CAUSE[c.reason as Exclude<CancelReason, 'desk'>], keepMoney: false, refundTo: c.refundTo }, s);
      await releaseSeat(b.slot.slotId, s);
      if (c.actor.kind === 'partner') {
        await recordPartnerAudit(c.actor.actor, c.reason === 'admin_no_show' ? 'lab_booking.no_show_cancelled' : 'lab_booking.reject',
          { kind: 'lab_booking', id }, { note: c.note, refunded: back, toPartner: true }, s);
      }
      return back;
    }
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
      await recordPartnerAudit(c.actor.actor, c.reason === 'admin_no_show' ? 'lab_booking.no_show_cancelled' : 'lab_booking.reject',
        { kind: 'lab_booking', id }, { note: c.note, refunded }, s);
    }
    return refunded;
  }

  async customerCancel(userId: string, bookingId: string, note: string | undefined, now = new Date()): Promise<{ booking: Record<string, unknown>; refunded: number }> {
    const id = String(bookingId).toLowerCase();
    const refunded = await runLedgerTransaction(async (s) => {
      const b = await PartnerLabBookingModel.findOne({ _id: id, userId: { $eq: userId }, $nor: [LAB_UNPAID_CARD_QUERY] }).session(s).lean() as IPartnerLabBooking | null;
      if (!b) throw notFound();
      if (!['pending_payment', 'confirmed'].includes(b.status)) throw err(409, 'LAB_BOOKING_NOT_CANCELLABLE', `A ${b.status} booking cannot be cancelled`);
      // r12 (owner, 23 Nov; L12): a desk row is cancellable while confirmed (before the visit or sample), at any time:
      // nothing was paid through Jansetu, so there is no window and nothing to refund.
      if (isDeskRow(b)) return this.cancelIn(b, [], { reason: 'customer', note, actor: { kind: 'customer', userId } }, s, now);
      if ((b.noShows?.length ?? 0) > 0) throw noShowNotRefundable();
      const records = await this.fenceRecords(id, s);
      const captured = b.paymentStatus === 'paid' || records.some((r) => r.status === 'paid');
      if (captured && !b.reschedule?.pending && now.getTime() > new Date(b.slot.startsAt).getTime() - LAB_CANCEL_CUTOFF_MS) {
        throw err(409, 'CANCELLATION_WINDOW_CLOSED', 'Bookings can be cancelled up to 2 hours before the slot');
      }
      const back = await this.cancelIn(b, records, { reason: 'customer', note, actor: { kind: 'customer', userId } }, s, now);
      if (isAssisted(b)) await auditPatientIn(b, userId, 'booking.cancelled', { cause: 'patient' }, s);
      return back;
    });
    const after = await PartnerLabBookingModel.findById(id).lean() as IPartnerLabBooking;
    if (isDeskRow(after)) {
      await this.notify({ userId, type: 'booking_cancelled', title: 'Lab booking cancelled', message: 'Your lab booking was cancelled. Nothing was paid through Jansetu.',
        bookingId: id, key: `plb:${id}:cancelled` });
      // L12: the desk member who booked it is told (in-app, no health details). SMS phase 5: none to the lab.
      await this.tellDeskMember(after, 'Cancelled by the patient', `The patient cancelled the desk booking of ${shownSlot(after)}.`, `labdesk:${id}:cancelled:member`);
      return { booking: customerView(after), refunded: 0 };
    }
    if (isAssisted(after)) {
      // r11 (decision 4): the patient cancelled a partner-paid booking; the refund went to the partner, which is told.
      // SMS phase 5: "Lab test Ref <ref> cancelled; the refund goes to <partner>"
      await kickCardRefunds(id);
      await this.notify({ userId, type: 'booking_cancelled', title: 'Lab booking cancelled',
        message: `Cancelled. The refund goes to ${after.assisted!.bookedBy.name}, who paid for this booking.`, bookingId: id, key: `plb:${id}:cancelled` });
      await tellBooker(after, { type: 'booking_cancelled', title: 'Cancelled by the patient',
        message: `Lab booking Ref ${after.assisted!.shortRef} on ${shownSlot(after)} was cancelled by the patient.${refunded > 0 ? bookerMoney(after) : ''}`,
        key: `assisted:lab:${id}:cancelled:booker`, data: { cause: 'patient' } });
      return { booking: customerView(after), refunded: 0 };
    }
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
      if ((b.noShows?.length ?? 0) > 0) throw noShowNotRefundable();
      this.assertVersion(b, expectedVersion);
      const records = await this.fenceRecords(id, s);
      return this.cancelIn(b, records, { reason: 'lab_reject', note, actor: { kind: 'partner', actor } }, s, now);
    });
    const after = await PartnerLabBookingModel.findById(id).lean() as IPartnerLabBooking;
    if (isDeskRow(after)) {
      // r12: a desk row refunds nothing through Jansetu (paid at the lab). SMS phase 5: "The lab cancelled your lab test"
      await this.notify({ userId: after.userId, type: 'booking_cancelled', title: 'The lab could not take your booking', message: `${note}.`,
        bookingId: id, key: `plb:${id}:cancelled` });
      return { booking: partnerView(after), refunded };
    }
    if (isAssisted(after)) {
      // r11 (L8): the partner that paid is refunded in full; the patient is told without the wallet line.
      // SMS phase 5: "The lab could not take lab test Ref <ref>"
      await kickCardRefunds(id);
      await this.notify({ userId: after.userId, type: 'booking_cancelled', title: 'The lab could not take your booking',
        message: `${note}. ${after.assisted!.bookedBy.name} has been refunded.`, bookingId: id, key: `plb:${id}:cancelled` });
      await tellBooker(after, { type: 'booking_cancelled', title: 'The lab could not take the booking',
        message: `Lab booking Ref ${after.assisted!.shortRef} on ${shownSlot(after)} was refused by the lab.${bookerMoney(after)}`,
        key: `assisted:lab:${id}:cancelled:booker`, data: { cause: 'partner_lab_reject' } });
      return { booking: partnerView(after), refunded };
    }
    await this.notify({ userId: after.userId, type: 'booking_cancelled', title: 'The lab could not take your booking',
      message: `${note}. Your full payment is back in your wallet.`, bookingId: id, key: `plb:${id}:cancelled` });
    return { booking: partnerView(after), refunded };
  }

  /**
   * Q16a (owner, 22 Nov 2026): a lab booking moved after a no-show that the lab cannot attend is cancelled by an ADMIN
   * only, who chooses whether the patient is refunded. With a refund: the ordinary cancellation (coupon undone, full
   * refund to the wallet once). Without: the money stays with the platform (as for a no-show), the coupon stays used and
   * nobody earns it. The seat is released either way; audited in the partner's trail.
   */
  async adminCancelMovedNoShow(adminId: string, bookingId: string, input: { reason: string; refund: boolean }, now = new Date()): Promise<{ booking: Record<string, unknown>; refunded: number }> {
    const id = String(bookingId).toLowerCase();
    if (!Types.ObjectId.isValid(id)) throw notFound();
    const note = String(input.reason ?? '').trim() || 'Cancelled by the Jansetu team';
    const refunded = await runLedgerTransaction(async (s) => {
      const b = await PartnerLabBookingModel.findById(id).session(s).lean() as IPartnerLabBooking | null;
      if (!b) throw notFound();
      if (b.status === 'cancelled') throw err(409, 'ALREADY_CANCELLED', 'This booking is already cancelled');
      if (b.status !== 'confirmed') throw err(409, 'LAB_BOOKING_STATE_CONFLICT', `A ${b.status} booking cannot be cancelled`);
      if (!((b.noShows?.length ?? 0) > 0)) throw err(409, 'BOOKING_NOT_MOVED_NO_SHOW', 'This booking was not moved after a no-show; use the ordinary cancellation');
      const actor: PartnerActor = { memberId: `admin:${adminId}`, partnerId: b.partnerId, role: 'owner', permissions: [], branchIds: [], actorKind: 'admin' };
      if (input.refund === true) {
        const records = await this.fenceRecords(id, s);
        return this.cancelIn(b, records, { reason: 'admin_no_show', note, actor: { kind: 'partner', actor } }, s, now);
      }
      // Q16a re-review (F): kept as FORFEITED — the funding record is closed (no money shown as held; a late capture goes
      // back to the wallet) and the amount kept is recorded on the cancellation.
      const wf = b.walletFunding as { total?: number; revision?: number; captures?: { amount: number; state: string }[] } | undefined;
      // r12: a desk row holds no money here (paid at the lab): nothing is forfeited.
      const forfeitedMinor = isDeskRow(b) ? 0 : isAssisted(b) && b.assisted?.funding ? Number(b.assisted.funding.amountMinor || 0) : wf ? Math.round((Number(wf.total || 0) + (wf.captures ?? []).filter((c) => c.state === 'applied')
        .reduce((a, c) => a + Number(c.amount || 0), 0)) * 100) : Number(b.pricing.payableMinor || 0);
      const r = await PartnerLabBookingModel.updateOne({ _id: id, status: b.status, statusVersion: b.statusVersion }, {
        $set: { status: 'cancelled', 'lifecycle.cancelledAt': now, 'reschedule.pending': false,
          cancellation: { reason: 'admin_no_show', note, ...byOf({ kind: 'partner', actor }), at: now, refund: false, forfeitedMinor },
          ...(wf ? { 'walletFunding.closed': true, 'walletFunding.total': 0, 'walletFunding.revision': Number(wf.revision || 0) + 1, 'walletFunding.updatedAt': now } : {}) },
        $inc: { statusVersion: 1 },
      }, { session: s });
      if (r.modifiedCount !== 1) throw changed();
      // r11 (L9): a partner-paid booking keeps the partner's money too (funding `forfeited`, coupon stays used).
      if (isAssisted(b) && b.assisted?.funding) await settleAssistedLabFundingIn(b, { cause: 'admin', keepMoney: true }, s);
      if (!isWalkIn(b)) await releaseSeat(b.slot.slotId, s);
      await recordPartnerAudit(actor, 'lab_booking.no_show_cancelled', { kind: 'lab_booking', id }, { note, refunded: 0 }, s);
      return 0;
    });
    const after = await PartnerLabBookingModel.findById(id).lean() as IPartnerLabBooking;
    if (isAssisted(after)) {
      await kickCardRefunds(id);
      await this.notify({ userId: after.userId, type: 'booking_cancelled', title: 'Lab booking cancelled', message: `${note}.`, bookingId: id,
        key: `plb:${id}:no_show_admin_cancelled` });
      await tellBooker(after, { type: 'booking_cancelled', title: 'Booking cancelled',
        message: `Lab booking Ref ${after.assisted!.shortRef} was cancelled by the Jansetu team.${refunded > 0 ? bookerMoney(after) : ''}`,
        key: `assisted:lab:${id}:cancelled:booker`, data: { cause: 'admin' } });
      return { booking: partnerView(after), refunded };
    }
    await this.notify({ userId: after.userId, type: 'booking_cancelled', title: 'Lab booking cancelled',
      message: refunded > 0 ? `${note}. ₹${refunded.toFixed(2)} is back in your wallet.` : `${note}.`, bookingId: id, key: `plb:${id}:no_show_admin_cancelled` });
    return { booking: partnerView(after), refunded };
  }

  // ───────────────────────────── Reschedule ─────────────────────────────

  /** Lab moves the booking to another slot of the same branch; the customer may accept, or cancel with a full refund. */
  async labReschedule(actor: PartnerActor, bookingId: string, newSlotId: string, reason: string, now = new Date(), expectedVersion?: number): Promise<Record<string, unknown>> {
    const id = String(bookingId).toLowerCase();
    const after = await runLedgerTransaction(async (s) => {
      const b = await this.scopedBooking(actor, id, s);
      if (b.status !== 'confirmed') throw err(409, 'LAB_BOOKING_STATE_CONFLICT', `A ${b.status} booking cannot be rescheduled`);
      // r12 (L11): a desk walk-in has arrived and holds no seat; there is no time to move.
      if (isWalkIn(b)) throw err(409, 'WALK_IN_NOT_RESCHEDULABLE', 'A walk-in has already arrived; it cannot be rescheduled');
      // Q14 review: a booking moved after a no-show was moved once already. An ordinary proposal would let the customer
      // cancel it for a refund, which a moved no-show never gets, so it is refused.
      if ((b.noShows?.length ?? 0) > 0) {
        throw err(409, 'NO_SHOW_RESCHEDULE_USED', 'This booking was already moved once after a no-show; it cannot be moved again');
      }
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
      message: isAssisted(after) ? `New time: ${after.slot.date} ${after.slot.startTime}. Accept it, or cancel (the refund goes to ${after.assisted!.bookedBy.name}).`
        : isDeskRow(after) ? `New time: ${after.slot.date} ${after.slot.startTime}. Accept it, or cancel.`
        : `New time: ${after.slot.date} ${after.slot.startTime}. Accept it, or cancel for a full refund.`,
      bookingId: id, key: `plb:${id}:reschedule:${after.reschedule.version}` });
    if (isAssisted(after)) {
      // r11 (§24.4.4, L7): the booker may accept the new time for the patient, or cancel for a refund to its wallet.
      // SMS phase 5: "The lab proposed a new time for lab test Ref <ref>: <date time>"
      await tellBooker(after, { type: 'general', title: 'New time proposed',
        message: `The lab proposed a new time for booking Ref ${after.assisted!.shortRef}: ${shownSlot(after)}. Accept it or cancel.`,
        key: `assisted:lab:${id}:reschedule:${after.reschedule.version}:booker` });
    }
    return partnerView(after);
  }

  /**
   * The patient accepts the lab's proposed new time. r11b: on an assisted (partner-paid) booking the accept is audited in
   * its transaction and the partner that booked it is told — the same accept as the booker's (acceptRescheduleAsBooker).
   */
  async acceptReschedule(userId: string, bookingId: string, version: number): Promise<Record<string, unknown>> {
    // r14 (L5): a partner's card booking never paid is not the patient's (the one 404, as on every patient read).
    const updated = await this.acceptRescheduleAsBooker({ userId: { $eq: userId }, $nor: [LAB_UNPAID_CARD_QUERY] }, bookingId, version, async (b, s) => {
      if (isAssisted(b)) await auditPatientIn(b, userId, 'booking.reschedule_accepted', { version: Number(version) }, s);
    });
    if (isAssisted(updated)) {
      await tellBooker(updated, { type: 'general', title: 'The patient accepted the new time',
        message: `The patient accepted the new time for lab booking Ref ${updated.assisted!.shortRef}: ${shownSlot(updated)}.`,
        key: `assisted:lab:${updated._id}:reschedule:${version}:accepted:booker` });
    }
    return customerView(updated);
  }

  /**
   * r11 (owner, 23 Nov; L7): the partner that booked and paid an assisted booking accepts the lab's proposed new time
   * for the patient — its own rows only (`bookerFilter`), audited in the same transaction (`inTx`). Any other booking is
   * the one 404. r11b: the patient's accept is this same accept, with the patient's own-row filter.
   */
  async acceptRescheduleAsBooker(bookerFilter: Record<string, unknown>, bookingId: string, version: number,
    inTx: (b: IPartnerLabBooking, s: ClientSession) => Promise<void>): Promise<IPartnerLabBooking> {
    const id = String(bookingId).toLowerCase();
    if (!Types.ObjectId.isValid(id)) throw notFound();
    return runLedgerTransaction(async (s) => {
      const b = await PartnerLabBookingModel.findOne({ _id: id, ...bookerFilter }).session(s).lean() as IPartnerLabBooking | null;
      if (!b) throw notFound();
      const updated = await PartnerLabBookingModel.findOneAndUpdate(
        { _id: id, ...bookerFilter, status: 'confirmed', 'reschedule.pending': true, 'reschedule.version': version },
        { $set: { 'reschedule.pending': false }, $inc: { statusVersion: 1 } },
        { new: true, session: s }
      ).lean() as IPartnerLabBooking | null;
      if (!updated) {
        if (b.status !== 'confirmed' || !b.reschedule?.pending) throw err(409, 'NO_PENDING_RESCHEDULE', 'There is no new time to accept');
        throw err(409, 'RESCHEDULE_CHANGED', 'The lab changed the time again; review the latest proposal');
      }
      await inTx(updated, s);
      return updated;
    });
  }

  /**
   * r11 (§24.4.4, L6): the partner that booked an assisted booking cancels it — its own rows only (`bookerFilter`),
   * while `confirmed`, never after a no-show; until 1 hour before the slot, or at any time while a lab reschedule is
   * unanswered. `expectedVersion` fences a stale screen. The refund goes to its wallet exactly once (cancelIn), the
   * seat is released, and `inTx` audits in the same transaction. A cancelled row answers `alreadyCancelled`.
   */
  async cancelAsBooker(bookerFilter: Record<string, unknown>, bookerId: string, bookingId: string,
    input: { note?: string; expectedVersion?: number; refundTo?: 'card' | 'wallet' },
    now: Date, inTx: (b: IPartnerLabBooking, s: ClientSession) => Promise<void>): Promise<{ booking: IPartnerLabBooking; refunded: number; alreadyCancelled: boolean }> {
    const id = String(bookingId).toLowerCase();
    if (!Types.ObjectId.isValid(id)) throw notFound();
    const out = await runLedgerTransaction(async (s) => {
      const b = await PartnerLabBookingModel.findOne({ _id: id, ...bookerFilter }).session(s).lean() as IPartnerLabBooking | null;
      if (!b) throw notFound();
      if (b.status === 'cancelled') return { refunded: 0, alreadyCancelled: true };
      // r14: a card booking still waiting for its payment may be cancelled at any time (nothing was paid; its seat is
      // released). A capture landing later is a late capture, returned to the card.
      const unpaidCard = b.status === 'pending_payment' && isUnpaidCardLab(b);
      if (b.status !== 'confirmed' && !unpaidCard) throw err(409, 'LAB_BOOKING_NOT_CANCELLABLE', `A ${b.status} booking cannot be cancelled`);
      if ((b.noShows?.length ?? 0) > 0) throw noShowNotRefundable();
      this.assertVersion(b, input.expectedVersion);
      if (!unpaidCard && !b.reschedule?.pending && now.getTime() > new Date(b.slot.startsAt).getTime() - BOOKER_CANCEL_CUTOFF_MS) {
        throw err(409, 'CANCELLATION_WINDOW_CLOSED', 'Lab bookings can be cancelled up to 1 hour before the slot');
      }
      const refunded = await this.cancelIn(b, [], { reason: 'partner', note: input.note, actor: { kind: 'booker', id: bookerId },
        ...(input.refundTo ? { refundTo: input.refundTo } : {}) }, s, now);
      await inTx(b, s);
      return { refunded, alreadyCancelled: false };
    });
    const after = await PartnerLabBookingModel.findById(id).lean() as IPartnerLabBooking;
    // r14 (C7): a card booking cancelled before its payment was never announced to the patient; nobody is told.
    if (!out.alreadyCancelled && !isUnpaidCardLab(after)) {
      // SMS phase 5: "Lab test Ref <ref> on <date> was cancelled by <partner>"
      await this.notify({ userId: after.userId, type: 'booking_cancelled', title: 'Lab booking cancelled',
        message: `The lab test on ${shownSlot(after)} (Ref ${after.assisted?.shortRef}) was cancelled.${out.refunded > 0 ? ` ${after.assisted?.bookedBy.name} has been refunded.` : ''}`,
        bookingId: id, key: `plb:${id}:cancelled` });
    }
    return { booking: after, refunded: out.refunded, alreadyCancelled: out.alreadyCancelled };
  }

  /**
   * r12 (§24.6.2): the lab desk cancels its own desk booking — desk rows of this lab in the actor's branches only (any
   * other row: the one 404), while `confirmed`; `expectedVersion` fences a stale screen. Nothing is refunded (paid at
   * the lab); the seat is released (none for a walk-in); audited in the same transaction. A cancelled row answers
   * `alreadyCancelled`. The bill, if any, is the lab's to cancel (with its own refund record).
   */
  async cancelDeskBooking(actor: PartnerActor, bookingId: string, input: { note?: string; expectedVersion?: number }, now = new Date())
    : Promise<{ booking: Record<string, unknown>; alreadyCancelled: boolean }> {
    const id = String(bookingId).toLowerCase();
    const out = await runLedgerTransaction(async (s) => {
      const b = await this.scopedBooking(actor, id, s);
      if (!isDeskRow(b)) throw notFound();
      if (b.status === 'cancelled') return { alreadyCancelled: true };
      if (b.status !== 'confirmed') throw err(409, 'LAB_BOOKING_NOT_CANCELLABLE', `A ${b.status} booking cannot be cancelled`);
      this.assertVersion(b, input.expectedVersion);
      await this.cancelIn(b, [], { reason: 'desk', note: input.note, actor: { kind: 'partner', actor } }, s, now);
      return { alreadyCancelled: false };
    });
    const after = await PartnerLabBookingModel.findById(id).lean() as IPartnerLabBooking;
    if (!out.alreadyCancelled) {
      // SMS phase 5: "Your lab test at <lab> on <date time> was cancelled"
      await this.notify({ userId: after.userId, type: 'booking_cancelled', title: 'Lab booking cancelled',
        message: `Your lab booking of ${shownSlot(after)} was cancelled by the lab.`, bookingId: id, key: `plb:${id}:cancelled` });
    }
    return { booking: (await withDeskBills(actor.partnerId, [after], [partnerView(after)]))[0]!, alreadyCancelled: out.alreadyCancelled };
  }

  /** r12 (L12): an in-app notice to the desk member who booked a desk row (members only; an admin has no inbox here). */
  private async tellDeskMember(b: IPartnerLabBooking, title: string, message: string, key: string): Promise<void> {
    const memberId = b.desk?.memberId;
    if (!memberId || !Types.ObjectId.isValid(memberId)) return;
    await this.notify({ userId: memberId, type: 'booking_cancelled', title, message, bookingId: String(b._id), key });
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

  /**
   * A no-show is not refunded (§4). Q14 (owner, 18 Nov 2026): the lab earns nothing for it either — the platform keeps
   * the money; the lab earns only when the booking is completed. Earnings posted before this rule stay as they are.
   */
  async markNoShow(actor: PartnerActor, bookingId: string, now = new Date(), expectedVersion?: number) {
    return this.transition(actor, bookingId, 'no_show', ['confirmed'], 'no_show', { 'lifecycle.noShowAt': now }, { noPendingReschedule: true, slotStarted: now, expectedVersion, notWalkIn: true });
  }

  /**
   * Q14: the lab moves a no-show once to a later slot of the same branch and visit mode (same price, no new payment, no
   * refund); the booking is confirmed again and earns on completion as usual; a second no-show is final. Exactly once
   * per (booking, request key) with a content hash; `expectedVersion` (statusVersion) fences a stale view.
   */
  async rescheduleNoShow(actor: PartnerActor, bookingId: string, input: { slotId: string; requestKey: string; expectedVersion?: number },
    now = new Date()): Promise<Record<string, unknown>> {
    const id = String(bookingId).toLowerCase();
    const requestHash = createHash('sha256').update(JSON.stringify({ slotId: String(input.slotId).toLowerCase() })).digest('hex');
    let replayed = false;
    const after = await runLedgerTransaction(async (s) => {
      replayed = false;
      const b = await this.scopedBooking(actor, id, s);
      const prior = (b.noShows ?? []).find((n) => n.requestKey === input.requestKey);
      if (prior) {
        if (prior.requestHash !== requestHash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different reschedule');
        replayed = true;
        return b;
      }
      if ((b.noShowReschedules ?? 0) >= 1 || (b.noShows?.length ?? 0) >= 1) {
        throw err(409, 'NO_SHOW_RESCHEDULE_USED', 'This booking was already rescheduled once after a no-show; a second no-show is final');
      }
      if (b.status !== 'no_show') throw err(409, 'BOOKING_NOT_NO_SHOW', `A ${b.status} booking is not a no-show`);
      this.assertVersion(b, input.expectedVersion);
      await claimRequestKey(`lab_no_show_reschedule:${id}`, input.requestKey, s);
      if (String(input.slotId) === String(b.slot.slotId)) throw err(409, 'SAME_SLOT', 'Pick a later slot');
      const slot = await takeSeat(input.slotId, { partnerId: b.partnerId, branchId: b.branchId, visitMode: b.visitMode, minStart: now }, s);
      await releaseSeat(b.slot.slotId, s);
      const next: ILabBookingSlot = { slotId: String(slot._id), date: slot.date, startTime: slot.startTime, endTime: slot.endTime, startsAt: slot.startsAt };
      const who = byOf({ kind: 'partner', actor });
      const updated = await PartnerLabBookingModel.findOneAndUpdate({ _id: id, status: 'no_show', statusVersion: b.statusVersion }, {
        $set: { status: 'confirmed', slot: next, noShowReschedules: (b.noShowReschedules ?? 0) + 1, 'reschedule.pending': false },
        $push: { noShows: { at: b.lifecycle?.noShowAt, rescheduledAt: now, by: who.by, byKind: who.byKind, fromSlot: b.slot, toSlot: next,
          requestKey: input.requestKey, requestHash } },
        $unset: { 'lifecycle.noShowAt': 1 },
        $inc: { statusVersion: 1 },
      }, { new: true, session: s }).lean();
      if (!updated) throw changed();
      await recordPartnerAudit(actor, 'lab_booking.no_show_rescheduled', { kind: 'lab_booking', id }, { from: b.slot, to: next }, s);
      return updated as IPartnerLabBooking;
    });
    if (!replayed) {
      await this.notify({ userId: after.userId, type: 'general', title: 'Your missed lab slot has a new time',
        message: `New time: ${after.slot.date} ${after.slot.startTime}.`, bookingId: id, key: `plb:${id}:no_show_rescheduled` });
    }
    return { ...partnerView(after), replayed };
  }

  async startProcessing(actor: PartnerActor, bookingId: string, expectedVersion?: number) {
    return this.transition(actor, bookingId, 'process', ['sample_collected', 'visited'], 'processing', { 'lifecycle.processingAt': new Date() }, { expectedVersion });
  }

  /**
   * Completion posts the partner's earning in the same transaction (§7), commission 0. Q16a (owner, 22 Nov 2026): the
   * coupon is borne by the lab, so the earning is the price after the coupon (`payableMinor`), not the subtotal.
   */
  async complete(actor: PartnerActor, bookingId: string, expectedVersion?: number) {
    return this.transition(actor, bookingId, 'complete', ['report_ready'], 'completed', { 'lifecycle.completedAt': new Date() }, { expectedVersion },
      (b, s) => this.postEarning(actor, b, s));
  }

  /** Earnings only for money actually collected through us (paid bookings), once per booking. */
  private async postEarning(actor: PartnerActor, b: IPartnerLabBooking, s: ClientSession): Promise<void> {
    // r12 (§5.5): a desk row (paid at the lab) never earns through the ledger, so no payout system ever sees it.
    if (isDeskRow(b)) return;
    if (b.paymentStatus !== 'paid') return;
    // r11 (§24.4.4): a partner-paid booking earns its split (provider_coupon_v2, cut 0 in phase 2), once per booking.
    const split = b.assisted?.split;
    if (isAssisted(b) && split?.rule === 'provider_coupon_v2') {
      if (b.assisted?.funding?.state !== 'captured' || !(Number(split.providerMinor) > 0)) return;
      await postLedgerEntry({
        settlementAccountId: b.settlement.settlementAccountId, kind: 'earning', amountMinor: Number(split.providerMinor),
        grossMinor: Number(split.baseMinor), commissionMinor: Number(split.cutMinor || 0), source: 'partner_lab_booking', sourceId: String(b._id),
        by: actor.memberId, byKind: actor.actorKind === 'admin' ? 'admin' : 'system',
      }, s);
      return;
    }
    const amountMinor = Math.max(0, Number(b.pricing.subtotalMinor) - Number(b.pricing.discountMinor || 0));
    if (!(amountMinor > 0)) return; // a fully discounted booking earns nothing (the coupon is never money)
    await postLedgerEntry({
      settlementAccountId: b.settlement.settlementAccountId, kind: 'earning', amountMinor,
      grossMinor: amountMinor, commissionMinor: 0, source: 'partner_lab_booking', sourceId: String(b._id),
      by: actor.memberId, byKind: actor.actorKind === 'admin' ? 'admin' : 'system',
    }, s);
  }

  private async transition(
    actor: PartnerActor, bookingId: string, command: string, from: LabBookingStatus[], to: LabBookingStatus,
    set: Record<string, unknown>, guards: { visitMode?: VisitMode; noPendingReschedule?: boolean; slotStarted?: Date; expectedVersion?: number; notWalkIn?: boolean } = {},
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
      // r12 (L11): a desk walk-in has arrived; it is never a no-show.
      if (guards.notWalkIn && isWalkIn(b)) throw err(409, 'WALK_IN_ARRIVED', 'A walk-in has already arrived; it cannot be marked as not present');
      // Q16a re-review (N6): a no-show only once the arrival window (lab visit or home collection) has ENDED.
      if (guards.slotStarted && guards.slotStarted < labSlotEnd(b.slot)) {
        throw err(409, 'SLOT_NOT_STARTED', 'A no-show can be marked only after the slot has ended');
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
      // Q14 review: a booking can be a no-show twice (once before its one move); the second notice gets its own key (the
      // first keeps the pre-Q14 key).
      const occurrence = command === 'no_show' ? (after.noShows?.length ?? 0) + 1 : 1;
      await this.notify({ userId: after.userId, type: 'general', title: 'Lab booking update', message: messages[command]!,
        bookingId: id, key: `plb:${id}:${command}${occurrence > 1 ? `:${occurrence}` : ''}` });
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
    const saved = await this.attachUpload(actor, id, paths, previous, requestKey);
    if ('replayed' in saved) return saved;
    return partnerView(saved);
  }

  private async attachUpload(actor: PartnerActor, id: string, paths: string[], previous: string[], requestKey?: string): Promise<IPartnerLabBooking | (Record<string, unknown> & { replayed: true })> {
    try {
      return await this.attachUploadOnce(actor, id, paths, previous, requestKey);
    } catch (e) {
      // Q11: the same keyed upload committed meanwhile by a concurrent request: answer with that one (no second copy).
      if (requestKey && (e as AppError)?.code === 'LAB_BOOKING_CHANGED') {
        const now = await PartnerLabBookingModel.findById(id).select({ 'report.uploadKeys': 1 }).lean();
        if ((now?.report?.uploadKeys ?? []).includes(requestKey)) return this.replayUpload(actor, id);
      }
      throw e;
    }
  }

  private attachUploadOnce(actor: PartnerActor, id: string, paths: string[], previous: string[], requestKey?: string): Promise<IPartnerLabBooking> {
    return attachFiles(readerOf(actor), 'PartnerLabBooking',
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
  }

  /**
   * Q11: the answer to a keyed upload that is already recorded. The draft and its key are committed before the file
   * grants are activated, so an activation that failed after that commit is repaired here (bindings of the files this
   * actor has authority over, at the authority of now) before the booking is returned.
   */
  private async replayUpload(actor: PartnerActor, id: string): Promise<Record<string, unknown> & { replayed: true }> {
    await rebindStored(readerOf(actor), 'PartnerLabBooking', id);
    const b = await this.scopedBooking(actor, id);
    return { ...partnerView(b), replayed: true };
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
    if (requestKey && (b.report?.uploadKeys ?? []).includes(requestKey)) return this.replayUpload(actor, id);
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
      if (isAssisted(after) && (before.report?.releases ?? []).length === 0) {
        // r11 (L4): the booker's "report ready" badge, no content; one per booking (first release).
        // SMS phase 5: "Lab report ready, Ref <ref>"
        await tellBooker(after, { type: 'general', title: 'Lab report ready', message: `Lab report ready, Ref ${after.assisted!.shortRef}.`,
          key: `assisted:lab:${id}:report_ready:booker` });
      }
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
    // r14 (L5): a partner's card booking never paid is not the patient's (the one 404).
    const b = await PartnerLabBookingModel.findOne({ _id: bookingId, userId: { $eq: userId }, $nor: [LAB_UNPAID_CARD_QUERY] }).lean();
    if (!b) throw notFound();
    return b as IPartnerLabBooking;
  }

  private async scopedBooking(actor: PartnerActor, bookingId: string, s?: ClientSession): Promise<IPartnerLabBooking> {
    if (!Types.ObjectId.isValid(bookingId)) throw notFound();
    const b = await PartnerLabBookingModel.findById(bookingId).session(s ?? null).lean() as IPartnerLabBooking | null;
    if (!b || b.partnerId !== actor.partnerId) throw notFound();
    if (!hasGlobalScope(actor) && !actor.branchIds.includes(b.branchId)) throw notFound();
    // r14 (L5): a partner's card booking never paid is not the lab's yet (the one 404 on every read and step).
    if (isUnpaidCardLab(b)) throw notFound();
    return b;
  }

  async getForCustomer(userId: string, bookingId: string) {
    return customerViewNamed(await this.ownBooking(userId, bookingId));
  }

  /** Q9: paged, newest first, each with the lab's and branch's names (and the branch's address/phone). */
  async listForCustomer(userId: string, page = 1, limit = 20) {
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const pg = Math.max(Number(page) || 1, 1);
    // r11 (§17.5): an assisted row reported as not mine (still open) leaves the holder's list.
    // r14 (L5): a partner's card booking never paid is left out too.
    const q = { userId: { $eq: userId }, ...LAB_NOT_DISPUTED_QUERY, $nor: [LAB_UNPAID_CARD_QUERY] };
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
    const b = await this.scopedBooking(actor, bookingId);
    return (await withDeskBills(actor.partnerId, [b], [partnerView(b)]))[0]!;
  }

  /** Q11: paged by an exact cursor on (slot.startsAt, _id), soonest first, with the total. */
  async listForPartnerPage(actor: PartnerActor, f: { status?: LabBookingStatus; branchId?: string; from?: string; to?: string; limit?: number; cursor?: string;
    /** r12 (§24.6.6): online (`self`, also rows without a source), pharmacy-booked or desk rows. */ source?: 'self' | 'pharmacy_assisted' | 'lab_desk' }) {
    // r14 (L5): a partner's card booking never paid is not the lab's yet.
    const q: Record<string, unknown> = { partnerId: actor.partnerId, $nor: [LAB_UNPAID_CARD_QUERY] };
    if (f.source) q.source = f.source === 'self' ? { $in: [null, 'self'] } : { $eq: f.source };
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
    return { items: await withDeskBills(actor.partnerId, items, items.map((b) => partnerView(b))), total,
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
    // r14 (L5): a partner's card booking never paid is not the lab's yet.
    const q: Record<string, unknown> = { partnerId: actor.partnerId, $nor: [LAB_UNPAID_CARD_QUERY] };
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
