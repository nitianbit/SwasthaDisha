import { istTodayYyyymmdd } from '@/modules/common/utils/istDate';
import { Service, Container } from 'typedi';
import { createHash } from 'crypto';
import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { fundBookingFromWallet, recordGatewayCapture, refundAndCloseIn, runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { canonicalJson } from '@/modules/partners/services/invoice';
import { claimRequestKey, scopeOf } from '@/modules/requestKeys';
import { undoCouponUsageIn } from '@/modules/coupon/usage';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentService, registerPaymentContextHandler } from '@/modules/payment/services';
import type { IPaymentRecord } from '@/modules/payment/types';
import { CouponService } from '@/modules/coupon/services';
import { WalletRepository } from '@/modules/wallet/repository';
import { WalletModel } from '@/modules/wallet/model';
import { getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import { sweepFailure } from '@/modules/common/utils/sweepFailure';
import UserModel from '@/modules/user/model';
import DependentModel from '@/modules/dependents/model';
import SpecialistModel from '@/modules/specialists/model';
import BookingModel from '@/modules/bookings/model';
import { IBooking } from '@/modules/bookings/types';
import { DoctorPresenceModel, InstantRequestModel, IInstantRequest, InstantMode, MoneySplit } from '@/modules/doctors/model/instant';
import { DoctorReservationModel } from '@/modules/doctors/model/reservation';
import { reserveInterval, moveInterval, releaseInterval, bumpGuard } from '@/modules/doctors/services/reservations';
import { settlementSystemFor } from '@/modules/partners/services/cutover';
import { ensureSettlementAccount } from '@/modules/partners/services/settlement';

export const OFFER_MS = 5 * 60_000;
export const INACTIVITY_MS = 30 * 60_000;
export const PRESENCE_TTL_MS = 2 * 60_000;
export const INSTANT_PAYMENT_WINDOW_MS = 30 * 60_000;
export const CONSULT_MS = 30 * 60_000;

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const notFound = () => err(404, 'INSTANT_REQUEST_NOT_FOUND', 'Request not found');
const changed = () => Object.assign(err(409, 'INSTANT_REQUEST_CHANGED', 'The request changed meanwhile; reload and try again'), { retryable: true });
const rupees = (paise: number) => Math.round(paise) / 100;
const paiseOf = (r: number) => Math.round(Number(r || 0) * 100);
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * §5 funding split at acceptance. Fee is allocated coupon → wallet → gateway; the quote difference is returned gateway
 * first, then wallet, and the unused coupon part is voided (never money). allocated.total + returned.total == funding.total.
 */
export function allocateFunding(f: MoneySplit, feeMinor: number, couponForFeeMinor?: number) {
  if (!Number.isSafeInteger(feeMinor) || feeMinor < 0 || feeMinor > f.totalMinor) throw err(409, 'FEE_ABOVE_QUOTE', 'The fee is above the quoted amount');
  // Q16a: the coupon part is what the coupon gives on the fee actually charged (never more than was held for it).
  const couponMinor = Math.min(f.couponMinor, feeMinor, couponForFeeMinor ?? f.couponMinor);
  const walletMinor = Math.min(f.walletMinor, feeMinor - couponMinor);
  const gatewayMinor = feeMinor - couponMinor - walletMinor;
  if (gatewayMinor > f.gatewayMinor) throw err(500, 'FUNDING_INCONSISTENT', 'The held funding does not cover the fee');
  const allocated = { couponMinor, walletMinor, gatewayMinor, totalMinor: feeMinor };
  const returned = {
    couponVoidedMinor: f.couponMinor - couponMinor, walletMinor: f.walletMinor - walletMinor, gatewayMinor: f.gatewayMinor - gatewayMinor,
    totalMinor: f.totalMinor - feeMinor,
  };
  if (allocated.totalMinor + returned.totalMinor !== f.totalMinor
    || returned.couponVoidedMinor + returned.walletMinor + returned.gatewayMinor !== returned.totalMinor) {
    throw err(500, 'FUNDING_INVARIANT', 'Funding allocation does not add up');
  }
  return { allocated, returned };
}

type CouponTerms = NonNullable<IInstantRequest['couponTerms']>;

/**
 * Q16a (owner, 22 Nov 2026): the coupon's discount on the fee actually charged, in paise. A percentage applies to that
 * fee (capped by the coupon's maximum); a fixed amount never exceeds it; below the coupon's minimum purchase the coupon
 * gives nothing. Requests made before Q16a have no frozen terms: their held coupon part is scaled to the fee.
 */
export function couponDiscountForFee(r: Pick<IInstantRequest, 'couponTerms' | 'discountMinor' | 'quotedAmountMinor'>, feeMinor: number): number {
  if (!(r.discountMinor > 0) || !(feeMinor > 0)) return 0;
  const t = r.couponTerms as CouponTerms | undefined;
  if (!t) return r.quotedAmountMinor > 0 ? Math.min(r.discountMinor, Math.floor((r.discountMinor * feeMinor) / r.quotedAmountMinor)) : 0;
  if (t.minimumPurchaseAmount && feeMinor < paiseOf(t.minimumPurchaseAmount)) return 0;
  let d = t.discountType === 'percentage' ? Math.round((feeMinor * Number(t.discountValue)) / 100) : paiseOf(t.discountValue);
  if (t.discountType === 'percentage' && t.maximumDiscountAmount) d = Math.min(d, paiseOf(t.maximumDiscountAmount));
  return Math.max(0, Math.min(d, feeMinor, r.discountMinor));
}

/** Q16a: the fee a doctor charges at acceptance — never above the fee frozen with their offer, nor above today's fee. */
export function chargedFeeFor(r: Pick<IInstantRequest, 'offerFees' | 'quotedAmountMinor'>, doctorId: string, currentFeeMinor: number): number {
  const frozen = (r.offerFees ?? []).find((o) => o.doctorId === String(doctorId))?.feeMinor;
  // A request offered before Q16a has no frozen fees: the quote is the ceiling (the former rule).
  return Math.min(currentFeeMinor, frozen ?? r.quotedAmountMinor);
}

/**
 * Q16a re-review (C): whether the money the customer put in (quote − coupon) covers this fee once the coupon is computed
 * again on it. A fee below the coupon's minimum gets no coupon and may then cost more than was paid: such a doctor is
 * left out of the offer, and accepting is refused (409 OFFER_NO_LONGER_AFFORDABLE), never a 500.
 */
export function feeAffordable(r: Pick<IInstantRequest, 'couponTerms' | 'discountMinor' | 'quotedAmountMinor'>, feeMinor: number): boolean {
  return feeMinor <= r.quotedAmountMinor && feeMinor - couponDiscountForFee(r, feeMinor) <= r.quotedAmountMinor - r.discountMinor;
}

/**
 * Q16a re-review (D): the frozen fees after a re-offer — a doctor offered before keeps min(earlier frozen fee, current
 * fee); entries of doctors not in this offer are kept (a later re-offer to them keeps their earlier fee too).
 */
export function mergeOfferFees(prior: { doctorId: string; feeMinor: number }[] | undefined, offers: { doctorId: string; feeMinor: number }[]) {
  const before = new Map((prior ?? []).map((o) => [o.doctorId, o.feeMinor]));
  const now = offers.map((o) => ({ doctorId: o.doctorId, feeMinor: Math.min(o.feeMinor, before.get(o.doctorId) ?? o.feeMinor) }));
  const ids = new Set(now.map((o) => o.doctorId));
  return [...(prior ?? []).filter((o) => !ids.has(o.doctorId)), ...now];
}

export type InstantNotifier = (n: { userId: string; userType: 'user' | 'specialist'; title: string; message: string; key: string; data?: Record<string, unknown> }) => Promise<void>;
export const defaultInstantNotifier: InstantNotifier = async (n) => {
  try {
    const { NotificationService } = await import('@/modules/notification/services');
    await Container.get(NotificationService).create({
      userId: n.userId, type: n.userType === 'specialist' ? 'specialist_general' as any : 'general', title: n.title, message: n.message,
      referenceType: 'instant_request', referenceId: String(n.data?.requestId ?? ''), idempotencyKey: n.key, data: n.data,
    });
  } catch (e) {
    console.error('instant consult notification failed', (e as Error)?.message);
  }
};

export interface CreateInstantInput {
  /** Q9: the quote (paise) the customer accepted and what they expect to pay after the coupon; both fence the create. */
  acceptedQuoteMinor?: number;
  acceptedPayableMinor?: number;
  target: { kind: 'specific' | 'any'; doctorId?: string };
  specialization: string;
  mode: InstantMode;
  patient: { kind: 'self' | 'dependent'; dependentId?: string };
  couponCode?: string;
  useWalletBalance?: boolean;
  requestKey: string;
}

export function instantRequestHash(input: CreateInstantInput): string {
  return createHash('sha256').update(canonicalJson({
    target: input.target, specialization: input.specialization.trim().toLowerCase(), mode: input.mode, patient: input.patient, couponCode: input.couponCode,
  })).digest('hex');
}

/** Customer view: no ledger internals, no request hash/key. */
export function requestView(r: IInstantRequest): Record<string, unknown> {
  const { walletFunding: _w, createRequestKey: _k, createRequestHash: _h, expiryNextAt: _e, expiryChecks: _c, offerFees: _f, couponTerms: _t, ...rest } = r as any;
  return rest;
}

const istParts = (at: Date) => {
  const ist = new Date(at.getTime() + 330 * 60_000).toISOString();
  return { date: `${ist.slice(0, 4)}${ist.slice(5, 7)}${ist.slice(8, 10)}`, time: ist.slice(11, 16) };
};

/**
 * Q13 review: the one eligibility rule for instant consultations — the stored flags must be true (a legacy doctor missing
 * either is not eligible), exactly as discovery (`onlineDoctors`) and speciality listing query it.
 */
const isEligibleDoctor = (sp: { isActive?: unknown; isVerified?: unknown } | null | undefined) => !!sp && sp.isActive === true && sp.isVerified === true;

/**
 * Q16a (L7): a doctor is busy for instant consultations when any held interval overlaps [now, now + 30 min) — the
 * window an acceptance reserves — so discovery, quotes, offers and presence never list a doctor who could not accept.
 */
const busyWindow = (now: Date) => ({ isActive: true, startTime: { $lt: new Date(now.getTime() + CONSULT_MS) }, endTime: { $gt: now } });

@Service()
export class InstantConsultService {
  notify: InstantNotifier = defaultInstantNotifier;

  constructor(
    private paymentService: PaymentService,
    private couponService: CouponService,
    private walletRepository: WalletRepository
  ) {}

  // ───────────────────────────── Doctor presence ─────────────────────────────

  async setPresence(doctorId: string, input: { available: boolean; modes?: InstantMode[]; instantFeeMinor?: number; expectedPresenceVersion?: number }, now = new Date()) {
    const sp = await SpecialistModel.findById(doctorId).lean() as any;
    if (!isEligibleDoctor(sp)) throw err(403, 'SPECIALIST_NOT_ACTIVE', 'Only active, verified doctors can take instant consultations');
    const modes = input.modes ?? [];
    if (input.available && modes.length === 0) throw err(400, 'MODES_REQUIRED', 'Choose at least one consultation type');
    const fee = input.instantFeeMinor ?? paiseOf(sp.consultationFee);
    if (!Number.isSafeInteger(fee) || fee < 0) throw err(400, 'INVALID_FEE', 'Invalid fee');
    const update = {
      $set: { available: input.available, modes, instantFeeMinor: fee, specialization: sp.specialization, ...(input.available ? { lastSeenAt: now } : {}) },
      $inc: { presenceVersion: 1 },
      $setOnInsert: { doctorId: String(doctorId) },
    };
    const expected = input.expectedPresenceVersion;
    if (expected === undefined) {
      return DoctorPresenceModel.findOneAndUpdate({ doctorId: String(doctorId) }, update, { upsert: true, new: true }).lean();
    }
    // Q13: an ordered write. Only the version the doctor's terms were decided on may be replaced, so an older request
    // that runs late (its answer lost, newer terms acknowledged since) can never overwrite them: 409 PRESENCE_CHANGED.
    const changed = () => err(409, 'PRESENCE_CHANGED', 'Your availability was changed meanwhile; check it and try again');
    const filter = expected === 0
      ? { doctorId: String(doctorId), $or: [{ presenceVersion: 0 }, { presenceVersion: { $exists: false } }] }
      : { doctorId: String(doctorId), presenceVersion: expected };
    try {
      const done = await DoctorPresenceModel.findOneAndUpdate(filter, update, { upsert: expected === 0, new: true }).lean();
      if (!done) throw changed();
      return done;
    } catch (e: any) {
      if (e?.code === 11000) throw changed(); // version 0 expected, but a row with a newer version exists
      throw e;
    }
  }

  /** The doctor's account as it is now: active and verified, or refused (and taken offline). */
  private async activeDoctor(doctorId: string): Promise<{ name?: string; specialization?: string }> {
    const sp = Types.ObjectId.isValid(doctorId) ? await SpecialistModel.findById(doctorId).select({ name: 1, specialization: 1, isActive: 1, isVerified: 1 }).lean() as any : null;
    if (!isEligibleDoctor(sp)) {
      await DoctorPresenceModel.updateOne({ doctorId: String(doctorId), available: true }, { $set: { available: false }, $inc: { presenceVersion: 1 } });
      throw err(403, 'SPECIALIST_NOT_ACTIVE', 'Only active, verified doctors can take instant consultations');
    }
    return sp;
  }

  /** Refreshes `lastSeenAt` (and the cached speciality) only for an eligible doctor; busy is derived from held intervals, so a heartbeat can never clear it. */
  async heartbeat(doctorId: string, now = new Date()) {
    const sp = await this.activeDoctor(doctorId);
    await DoctorPresenceModel.updateOne({ doctorId: String(doctorId), available: true }, { $set: { lastSeenAt: now, specialization: sp.specialization } });
    return this.presence(doctorId, now);
  }

  /**
   * Q13: the doctor's own presence as the platform sees it. `online` is the one definition every path uses (offers,
   * quotes, discovery, acceptance): an active, verified doctor, switched available with at least one mode, a heartbeat
   * no older than PRESENCE_TTL_MS, and no doctor interval (scheduled, in-clinic or instant) held right now.
   */
  async presence(doctorId: string, now = new Date()) {
    const sp = Types.ObjectId.isValid(doctorId)
      ? await SpecialistModel.findById(doctorId).select({ consultationFee: 1, isActive: 1, isVerified: 1 }).lean() as any : null;
    const eligible = isEligibleDoctor(sp);
    const [p, held] = await Promise.all([
      DoctorPresenceModel.findOne({ doctorId: String(doctorId) }).lean(),
      DoctorReservationModel.findOne({ doctorId: String(doctorId), ...busyWindow(now) }).sort({ endTime: -1 }).lean(),
    ]);
    const lastSeenAt = p?.lastSeenAt ? new Date(p.lastSeenAt) : null;
    const heartbeatExpired = !lastSeenAt || now.getTime() - lastSeenAt.getTime() > PRESENCE_TTL_MS;
    const modes = p?.modes ?? [];
    const feeMinor = p ? p.instantFeeMinor : paiseOf(sp?.consultationFee);
    return {
      doctorId: String(doctorId), eligible, available: !!p?.available, modes, instantFeeMinor: feeMinor, instantFee: rupees(feeMinor),
      presenceVersion: p?.presenceVersion ?? 0,
      feeConfigured: !!p, lastSeenAt, heartbeatExpiresAt: lastSeenAt ? new Date(lastSeenAt.getTime() + PRESENCE_TTL_MS) : null, heartbeatExpired,
      heartbeatTtlSeconds: PRESENCE_TTL_MS / 1000,
      busy: !!held, busyUntil: held ? held.endTime : null, busyWith: held ? { kind: held.kind, bookingId: held.refId } : null,
      online: eligible && !!p?.available && modes.length > 0 && !heartbeatExpired && !held,
    };
  }

  /**
   * Online doctors for a speciality and mode: available, heartbeat within 2 min, active/verified, not holding an interval
   * now. The speciality is the doctor's CURRENT profile (presence only caches it), so a corrected profile takes effect at once.
   */
  async onlineDoctors(f: { specialization: string; mode: InstantMode; maxFeeMinor?: number; onlyDoctorIds?: string[] }, now = new Date()) {
    const presences = await DoctorPresenceModel.find({
      available: true, lastSeenAt: { $gte: new Date(now.getTime() - PRESENCE_TTL_MS) }, modes: f.mode,
      ...(f.maxFeeMinor !== undefined ? { instantFeeMinor: { $lte: f.maxFeeMinor } } : {}),
      ...(f.onlyDoctorIds ? { doctorId: { $in: f.onlyDoctorIds } } : {}),
    }).lean();
    if (!presences.length) return [];
    const ids = presences.map((p) => p.doctorId);
    const [busy, doctors] = await Promise.all([
      DoctorReservationModel.find({ doctorId: { $in: ids }, ...busyWindow(now) }).select({ doctorId: 1 }).lean(),
      SpecialistModel.find({ _id: { $in: ids.filter((i) => Types.ObjectId.isValid(i)) }, isActive: true, isVerified: true,
        specialization: new RegExp(`^\\s*${escapeRx(f.specialization.trim())}\\s*$`, 'i') }).select({ name: 1, rating: 1, specialization: 1 }).lean() as any,
    ]);
    const busyIds = new Set(busy.map((b) => b.doctorId));
    const byId = new Map((doctors as any[]).map((d) => [String(d._id), d]));
    return presences
      .filter((p) => !busyIds.has(p.doctorId) && byId.has(p.doctorId))
      .map((p) => ({ doctorId: p.doctorId, name: byId.get(p.doctorId).name, rating: byId.get(p.doctorId).rating, specialization: byId.get(p.doctorId).specialization,
        modes: p.modes, instantFeeMinor: p.instantFeeMinor, instantFee: rupees(p.instantFeeMinor) }))
      .sort((a, b) => a.instantFeeMinor - b.instantFeeMinor);
  }

  /** §5 price contract: a specific doctor's fee, or for "any available" the highest fee among online doctors right now. */
  async quote(f: { specialization: string; mode: InstantMode; doctorId?: string }, now = new Date()): Promise<{ quotedAmountMinor: number; doctors: number }> {
    const online = await this.onlineDoctors({ specialization: f.specialization, mode: f.mode }, now);
    if (f.doctorId) {
      const d = online.find((x) => x.doctorId === String(f.doctorId));
      if (!d) throw err(409, 'DOCTOR_NOT_ONLINE', 'This doctor is not available right now');
      return { quotedAmountMinor: d.instantFeeMinor, doctors: 1 };
    }
    if (!online.length) throw err(409, 'NO_DOCTOR_ONLINE', 'No doctor of this speciality is online right now');
    return { quotedAmountMinor: Math.max(...online.map((d) => d.instantFeeMinor)), doctors: online.length };
  }

  // ───────────────────────────── Customer: create and pay ─────────────────────────────

  async create(userId: string, input: CreateInstantInput, now = new Date(), account: { corporateId?: string } = {}) {
    if (input.target.kind === 'specific' && !input.target.doctorId) throw err(400, 'DOCTOR_REQUIRED', 'Choose a doctor');
    const hash = instantRequestHash(input);
    const prior = await InstantRequestModel.findOne({ userId: { $eq: userId }, createRequestKey: { $eq: input.requestKey } }).lean();
    if (prior) return this.resume(this.sameRequest(prior as IInstantRequest, hash), !!input.useWalletBalance, now);

    const { quotedAmountMinor } = await this.quote({ specialization: input.specialization, mode: input.mode,
      doctorId: input.target.kind === 'specific' ? input.target.doctorId : undefined }, now);
    const patient = await this.patientOf(userId, input.patient);
    let discountMinor = 0;
    let couponCode: string | undefined;
    let couponDoctorIds: string[] | undefined;
    let couponTerms: CouponTerms | undefined;
    if (input.couponCode && quotedAmountMinor > 0) {
      // The same eligibility context as an ordinary consultation: the resolved patient and the account's corporate.
      const v = await this.couponService.validateCoupon({ code: input.couponCode, userId, bookingType: 'consultation',
        bookingId: input.target.kind === 'specific' ? input.target.doctorId : undefined, purchaseAmount: rupees(quotedAmountMinor),
        dependentId: patient.kind === 'dependent' ? patient.dependentId : undefined, corporateId: account.corporateId });
      if (!v.isValid || !v.coupon) throw err(400, 'INVALID_COUPON', v.message || 'Invalid coupon code');
      discountMinor = Math.min(quotedAmountMinor, paiseOf(v.discountAmount ?? 0));
      couponCode = v.coupon.code;
      // A coupon for named doctors stays bound to them through re-offers and acceptance (frozen with the price).
      if (v.coupon.applicableTo === 'specific') couponDoctorIds = (v.coupon.applicableIds ?? []).map(String);
      // Q16a: frozen so the discount can be computed again on the fee actually charged at acceptance.
      couponTerms = { discountType: v.coupon.discountType === 'percentage' ? 'percentage' : 'fixed', discountValue: Number(v.coupon.discountValue || 0),
        ...(v.coupon.maximumDiscountAmount ? { maximumDiscountAmount: Number(v.coupon.maximumDiscountAmount) } : {}),
        ...(v.coupon.minimumPurchaseAmount ? { minimumPurchaseAmount: Number(v.coupon.minimumPurchaseAmount) } : {}) };
    }

    // Q9: nothing is funded at a price the customer did not accept (a doctor's fee or the coupon may have changed).
    if ((input.acceptedQuoteMinor !== undefined && input.acceptedQuoteMinor !== quotedAmountMinor)
        || (input.acceptedPayableMinor !== undefined && input.acceptedPayableMinor !== quotedAmountMinor - discountMinor)) {
      throw err(409, 'QUOTE_CHANGED', `The price is now ₹${((quotedAmountMinor - discountMinor) / 100).toFixed(2)} (fee ₹${(quotedAmountMinor / 100).toFixed(2)}); review and confirm again`);
    }

    const request = await runLedgerTransaction(async (s) => {
      const again = await InstantRequestModel.findOne({ userId: { $eq: userId }, createRequestKey: { $eq: input.requestKey } }).session(s).lean();
      if (again) return this.sameRequest(again as IInstantRequest, hash);
      await claimRequestKey(scopeOf('instant_request_create', userId), input.requestKey, s);
      const [created] = await InstantRequestModel.create([{
        userId, createRequestKey: input.requestKey, createRequestHash: hash, patient, specialization: input.specialization.trim(), mode: input.mode,
        target: input.target, quotedAmountMinor, couponCode, ...(couponDoctorIds ? { couponDoctorIds } : {}), ...(couponTerms ? { couponTerms } : {}), discountMinor, fundingState: 'awaiting', status: 'pending_payment', statusVersion: 0,
        paymentStatus: 'pending', paymentDeadline: new Date(now.getTime() + INSTANT_PAYMENT_WINDOW_MS), offerGeneration: 0, offeredTo: [],
      }], { session: s });
      return created!.toObject() as IInstantRequest;
    });
    return this.resume(request, !!input.useWalletBalance, now);
  }

  private sameRequest(r: IInstantRequest, hash: string): IInstantRequest {
    if (r.createRequestHash !== hash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different request');
    return r;
  }

  private async patientOf(userId: string, p: CreateInstantInput['patient']) {
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

  /** The one admission for starting/resuming payment (create, its replay, pay again): window open, earlier attempts settled. */
  private async resume(r: IInstantRequest, useWallet: boolean, now: Date) {
    const receipt = (x: IInstantRequest) => ({ request: requestView(x), paymentRequired: false });
    if (r.status !== 'pending_payment' || r.paymentStatus !== 'pending') return receipt(r);
    if (now >= new Date(r.paymentDeadline)) throw err(409, 'INSTANT_PAYMENT_EXPIRED', 'The payment window has closed; start again');
    const id = String(r._id);
    if (await PaymentRecordModel.exists({ context: 'instant_request', contextId: id })) {
      const earlier = await this.paymentService.reconcileContextPayments('instant_request', id);
      if (earlier.unknown > 0) throw err(503, 'PAYMENT_STATE_UNKNOWN', 'An earlier payment is still being checked; try again in a minute');
      r = (await InstantRequestModel.findById(id).lean()) as IInstantRequest;
      if (r.status !== 'pending_payment' || r.paymentStatus !== 'pending') return receipt(r);
      if (r.paymentTransactionId) {
        const open = await this.paymentService.resumableOrder(String(r.paymentTransactionId));
        if (open) return { request: requestView(r), paymentRequired: true, payment: open };
      }
    }
    const due = rupees(r.quotedAmountMinor - r.discountMinor);
    const funded = due > 0
      ? (await fundBookingFromWallet({ model: InstantRequestModel, kind: 'instant_request', bookingId: id, userId: r.userId, gross: due,
        requested: useWallet ? due : 0, legacyFunded: 0, wallets: this.walletRepository })).total
      : 0;
    const remaining = Math.round((due - funded) * 100) / 100;
    const offers = await this.offerTargets(r, now);
    if (remaining <= 0) {
      const held = await runLedgerTransaction(async (s) => {
        const recordId = new Types.ObjectId();
        const x = await InstantRequestModel.findOneAndUpdate(
          { _id: id, status: 'pending_payment', paymentStatus: 'pending', 'walletFunding.closed': { $ne: true },
            $or: [{ paymentTransactionId: { $exists: false } }, { paymentTransactionId: null }, { paymentTransactionId: r.paymentTransactionId ?? '' }] },
          { $set: { paymentStatus: 'paid', paymentTransactionId: String(recordId), ...this.holdPatch(r, paiseOf(funded), 0, offers, now) }, $inc: { statusVersion: 1 } },
          { new: true, session: s }
        ).lean();
        if (!x) throw err(409, 'INSTANT_PAYMENT_STATE_CHANGED', 'This request was paid or changed; reload');
        await this.paymentService.createDirectPaidBookingRecordIn({ userId: r.userId, context: 'instant_request', contextId: id,
          baseAmount: rupees(r.quotedAmountMinor), discountAmount: rupees(r.discountMinor), finalAmount: 0, couponCode: r.couponCode,
          notes: { reason: due <= 0 ? 'zero_payable_amount' : 'wallet_covered_amount', walletDeductedAmount: funded } }, s, recordId);
        return x as IInstantRequest;
      });
      await this.notifyOffer(held);
      return { request: requestView(held), paymentRequired: false };
    }
    const order = await this.paymentService.createOrder({ userId: r.userId, context: 'instant_request', contextId: id,
      baseAmount: rupees(r.quotedAmountMinor), discountAmount: rupees(r.discountMinor), finalAmount: remaining, couponCode: r.couponCode,
      notes: { walletDeductedAmount: funded } });
    const linked = await InstantRequestModel.findOneAndUpdate(
      { _id: id, status: 'pending_payment', paymentStatus: 'pending',
        $or: [{ paymentTransactionId: { $exists: false } }, { paymentTransactionId: null }, { paymentTransactionId: r.paymentTransactionId ?? '' }] },
      { $set: { paymentTransactionId: String(order.paymentRecord._id) } }, { new: true }).lean();
    if (!linked) throw err(409, 'INSTANT_PAYMENT_STATE_CHANGED', 'This request was paid or changed; reload');
    return { request: requestView(linked as IInstantRequest), paymentRequired: true,
      payment: { paymentTransactionId: String(order.paymentRecord._id), razorpayOrderId: order.razorpayOrder.id, razorpayKeyId: order.razorpayKeyId,
        amount: remaining, currency: order.razorpayOrder.currency } };
  }

  /**
   * Doctors the first offer goes to: the chosen one, or every eligible online doctor (fee within the quote, coupon's
   * doctors only). Q16a: each with the fee frozen for this offer (never above the quote the patient paid).
   */
  private async offerTargets(r: Pick<IInstantRequest, 'target' | 'specialization' | 'mode' | 'quotedAmountMinor' | 'couponDoctorIds' | 'couponTerms' | 'discountMinor'>
    & { offerFees?: IInstantRequest['offerFees'] }, now: Date): Promise<{ doctorId: string; feeMinor: number }[]> {
    if (r.target.kind === 'specific') {
      const doctorId = String(r.target.doctorId);
      const p = await DoctorPresenceModel.findOne({ doctorId }).select({ instantFeeMinor: 1 }).lean();
      return mergeOfferFees(r.offerFees, [{ doctorId, feeMinor: Math.min(p?.instantFeeMinor ?? r.quotedAmountMinor, r.quotedAmountMinor) }])
        .filter((o) => o.doctorId === doctorId);
    }
    const prior = new Map((r.offerFees ?? []).map((o) => [o.doctorId, o.feeMinor]));
    // D: a doctor offered before keeps min(earlier frozen, current); C: only doctors the customer's money covers.
    return (await this.onlineDoctors({ specialization: r.specialization, mode: r.mode, maxFeeMinor: r.quotedAmountMinor,
      ...(r.couponDoctorIds ? { onlyDoctorIds: r.couponDoctorIds } : {}) }, now))
      .map((d) => ({ doctorId: d.doctorId, feeMinor: Math.min(d.instantFeeMinor, prior.get(d.doctorId) ?? d.instantFeeMinor) }))
      .filter((o) => feeAffordable(r, o.feeMinor));
  }

  /** The held state: funding recorded (coupon + wallet + gateway == quote) and the first offer generation opened. */
  private holdPatch(r: IInstantRequest, walletMinor: number, gatewayMinor: number, offers: { doctorId: string; feeMinor: number }[], now: Date) {
    const funding = { couponMinor: r.discountMinor, walletMinor, gatewayMinor, totalMinor: r.discountMinor + walletMinor + gatewayMinor };
    return {
      status: 'offered', fundingState: 'held', funding, offerGeneration: 1, offeredTo: offers.map((o) => o.doctorId), offerFees: offers,
      offerExpiresAt: new Date(now.getTime() + OFFER_MS), inactivityRefundAt: new Date(now.getTime() + INACTIVITY_MS),
    };
  }

  async payAgain(userId: string, requestId: string, useWallet: boolean, now = new Date()) {
    return this.resume(await this.own(userId, requestId), useWallet, now);
  }

  /** Payment context handler: a verified capture is applied once (funding held, offers open) or returned to the wallet. */
  async applyCapture(record: IPaymentRecord, helpers: { finalize(r: IPaymentRecord): Promise<IPaymentRecord>; markReturned(r: IPaymentRecord): Promise<IPaymentRecord> }) {
    const r = await InstantRequestModel.findById(record.contextId).lean() as IInstantRequest | null;
    if (!r || r.userId !== record.userId) throw notFound();
    const now = new Date();
    const thisRecord = String(record._id);
    const offers = await this.offerTargets(r, now);
    const gatewayMinor = paiseOf(record.finalAmount);
    const capture = await recordGatewayCapture({
      model: InstantRequestModel, kind: 'instant_request', bookingId: String(r._id), userId: r.userId, recordId: thisRecord,
      amount: Number(record.finalAmount || 0), gross: Math.max(0, Number(record.baseAmount || 0) - Number(record.discountAmount || 0)),
      legacyFunded: Number(record.notes?.walletDeductedAmount || 0),
      applicable: (b: any) => (b.status === 'pending_payment' && b.paymentStatus === 'pending')
        || (b.paymentStatus === 'paid' && String(b.paymentTransactionId) === thisRecord),
      applyPatch: (b: any) => b.status === 'pending_payment'
        ? { paymentStatus: 'paid', paymentTransactionId: thisRecord, statusVersion: Number(b.statusVersion ?? 0) + 1,
          ...this.holdPatch(b, b.quotedAmountMinor - b.discountMinor - gatewayMinor, gatewayMinor, offers, now) }
        : { paymentStatus: 'paid', paymentTransactionId: thisRecord },
      wallets: this.walletRepository,
    });
    const after = await InstantRequestModel.findById(record.contextId).lean() as IInstantRequest;
    if (capture.state === 'returned') return { paymentRecord: await helpers.markReturned(record), entity: requestView(after) };
    if (capture.fresh) await this.notifyOffer(after);
    return { paymentRecord: await helpers.finalize(record), entity: requestView(after) };
  }

  private async notifyOffer(r: IInstantRequest) {
    for (const doctorId of r.offeredTo) {
      await this.notify({ userId: doctorId, userType: 'specialist', title: 'Instant consultation request',
        message: `${r.mode} consultation · ${r.specialization}. Accept within 5 minutes.`,
        key: `instant:${r._id}:offer:${r.offerGeneration}:${doctorId}`, data: { requestId: String(r._id), generation: r.offerGeneration } });
    }
  }

  // ───────────────────────────── Offers: accept, re-offer ─────────────────────────────

  async myOffers(doctorId: string, now = new Date()) {
    await this.activeDoctor(doctorId); // a deactivated doctor no longer sees patient details
    const [rows, presence] = await Promise.all([
      InstantRequestModel.find({ status: 'offered', fundingState: 'held', offeredTo: String(doctorId), offerExpiresAt: { $gt: now } })
        .sort({ offerExpiresAt: 1 }).limit(50).lean(),
      DoctorPresenceModel.findOne({ doctorId: String(doctorId) }).select({ instantFeeMinor: 1 }).lean(),
    ]);
    // Q13: the quote the patient paid (coupon + wallet + gateway) is the ceiling of the fee this doctor may charge.
    // Q16a: the fee frozen with this offer is the doctor's ceiling; accepting charges min(frozen fee, current fee).
    const yourFeeMinor = presence?.instantFeeMinor ?? null;
    return rows.map((r) => {
      const offeredFeeMinor = (r.offerFees ?? []).find((o) => o.doctorId === String(doctorId))?.feeMinor ?? null;
      const chargeFeeMinor = yourFeeMinor === null ? null : chargedFeeFor(r as IInstantRequest, String(doctorId), yourFeeMinor);
      return { requestId: String(r._id), mode: r.mode, specialization: r.specialization, patient: { name: r.patient.name, age: r.patient.age,
        gender: r.patient.gender }, generation: r.offerGeneration, offerExpiresAt: r.offerExpiresAt,
        quotedAmountMinor: r.quotedAmountMinor, quotedAmount: rupees(r.quotedAmountMinor), yourFeeMinor, offeredFeeMinor, chargeFeeMinor,
        feeWithinQuote: chargeFeeMinor !== null && feeAffordable(r as IInstantRequest, chargeFeeMinor) };
    });
  }

  /**
   * §5 accept (atomic): CAS the offer (status offered, funding held, current generation, offered to this doctor, not
   * expired, nobody accepted), doctor eligible now (presence, mode, fee ≤ quote), doctor interval reserved (overlap
   * refused), funding split, quote difference returned to the wallet once, paid consultation booking created and linked —
   * one transaction. First accept wins; every other attempt changes nothing.
   */
  async accept(doctorId: string, requestId: string, now = new Date()) {
    if (!Types.ObjectId.isValid(requestId)) throw notFound();
    const id = String(requestId).toLowerCase();
    // Q13: accepting again (a lost answer, a double tap) is answered with this doctor's own booking, never "taken".
    const replay = async () => {
      const r = await InstantRequestModel.findById(id).lean() as IInstantRequest | null;
      if (!r || r.acceptedBy !== String(doctorId) || !r.bookingId) return null;
      const booking = await BookingModel.findOne({ _id: r.bookingId, specialistId: String(doctorId) }).lean() as IBooking | null;
      return booking ? { request: requestView(r), booking, replayed: true } : null;
    };
    const prior = await replay();
    if (prior) return prior;
    let out: { request: IInstantRequest; booking: IBooking };
    try {
      out = await this.acceptIn(doctorId, id, now);
    } catch (e) {
      // A concurrent accept by this same doctor committed first: answer with it.
      const raced = await replay();
      if (raced) return raced;
      throw e;
    }
    await this.afterAccept(out.request, out.booking, now);
    return { request: requestView(out.request), booking: out.booking, replayed: false };
  }

  private async acceptIn(doctorId: string, id: string, now: Date): Promise<{ request: IInstantRequest; booking: IBooking }> {
    return runLedgerTransaction(async (s) => {
      const r = await InstantRequestModel.findById(id).session(s).lean() as IInstantRequest | null;
      if (!r || !r.offeredTo.includes(String(doctorId))) throw notFound();
      if (r.status !== 'offered' || r.fundingState !== 'held' || r.acceptedBy) throw err(409, 'OFFER_NO_LONGER_AVAILABLE', 'This request was taken, refunded or withdrawn');
      if (!r.offerExpiresAt || now >= new Date(r.offerExpiresAt)) throw err(409, 'OFFER_EXPIRED', 'This offer has expired');
      const presence = await DoctorPresenceModel.findOne({ doctorId: String(doctorId) }).session(s).lean();
      if (!presence?.available || !presence.lastSeenAt || now.getTime() - new Date(presence.lastSeenAt).getTime() > PRESENCE_TTL_MS
        || !presence.modes.includes(r.mode)) {
        throw err(409, 'DOCTOR_NOT_AVAILABLE', 'Go online for this consultation type to accept');
      }
      const sp = await SpecialistModel.findById(doctorId).session(s).lean() as any;
      if (!isEligibleDoctor(sp)) throw err(403, 'SPECIALIST_NOT_ACTIVE', 'Doctor account is not active');
      if (String(sp.specialization ?? '').trim().toLowerCase() !== r.specialization.trim().toLowerCase()) {
        throw err(409, 'SPECIALIZATION_MISMATCH', 'This request is for another speciality');
      }
      if (r.couponDoctorIds && !r.couponDoctorIds.includes(String(doctorId))) {
        throw err(409, 'COUPON_NOT_FOR_DOCTOR', "The patient's coupon is for other doctors");
      }
      // Q16a (owner, 22 Nov 2026): the fee frozen with the offer is the ceiling (a fee raised after the offer cannot be
      // charged); a lower current fee is charged as it is. The coupon is computed again on the fee charged.
      const fee = chargedFeeFor(r, String(doctorId), presence.instantFeeMinor);
      if (fee > r.quotedAmountMinor) throw err(409, 'FEE_ABOVE_QUOTE', 'Your fee is above what this patient paid');
      // Q16a re-review (C): below the coupon's minimum the fee may cost more than the patient paid: refused, never a 500.
      if (!feeAffordable(r, fee)) throw err(409, 'OFFER_NO_LONGER_AFFORDABLE', "What the patient paid does not cover your fee for this request");
      const { allocated, returned } = allocateFunding(r.funding as MoneySplit, fee, couponDiscountForFee(r, fee));

      const bookingId = new Types.ObjectId();
      await reserveInterval({ doctorId: String(doctorId), kind: 'instant', refId: String(bookingId), start: now, end: new Date(now.getTime() + CONSULT_MS) }, s);

      const wf = (r.walletFunding ?? { total: 0, revision: 0, closed: false, captures: [] }) as any;
      const taken = await InstantRequestModel.findOneAndUpdate(
        { _id: id, status: 'offered', fundingState: 'held', offerGeneration: r.offerGeneration, offeredTo: String(doctorId),
          offerExpiresAt: { $gt: now }, acceptedBy: { $exists: false }, statusVersion: r.statusVersion },
        { $set: { status: 'accepted', fundingState: 'allocated', allocated, returned, refunded: { walletMinor: 0, gatewayMinor: 0, totalMinor: 0 },
          acceptedBy: String(doctorId), acceptedFeeMinor: fee, bookingId: String(bookingId),
          // The allocation now owns the money: the funding ledger is closed (a late capture is returned to the wallet).
          walletFunding: { ...wf, total: 0, revision: Number(wf.revision ?? 0) + 1, closed: true, updatedAt: now } },
          $inc: { statusVersion: 1 } },
        { new: true, session: s }
      ).lean() as IInstantRequest | null;
      if (!taken) throw err(409, 'OFFER_NO_LONGER_AVAILABLE', 'This request was taken, refunded or withdrawn');

      const back = returned.walletMinor + returned.gatewayMinor;
      if (back > 0) await this.creditWallet(r.userId, back, `instant_request_return:${id}`, 'Instant consultation: quote difference returned', id, s);
      // Q16a: a coupon that gives nothing on the fee charged (below its minimum purchase) was not used: its count is undone.
      if (r.discountMinor > 0 && allocated.couponMinor === 0) {
        const records = await PaymentRecordModel.find({ context: 'instant_request', contextId: id }).session(s).lean();
        await undoCouponUsageIn(records.map((x) => String(x._id)), s);
      }

      const { date, time } = istParts(now);
      const settlementSystem = settlementSystemFor(now);
      const account = settlementSystem === 'ledger' ? await ensureSettlementAccount('doctor', String(doctorId), sp.name || 'Doctor', s) : null;
      const [booking] = await BookingModel.create([{
        _id: bookingId, bookingType: 'consultation', bookingKind: 'instant', instantRequestId: id, userId: r.userId,
        ...(r.patient.kind === 'dependent' ? { dependentId: r.patient.dependentId } : {}),
        specialistId: String(doctorId), doctorName: sp.name, consultationMode: r.mode, serviceMode: r.mode, bookingDate: date, bookingTime: time,
        price: rupees(fee - allocated.couponMinor), originalPrice: rupees(fee), status: 'confirmed', paymentStatus: 'paid',
        paymentTransactionId: r.paymentTransactionId, settlementSystem, ...(account ? { settlement: { settlementAccountId: String(account._id), beneficiaryName: account.beneficiaryName } } : {}),
      }], { session: s });
      return { request: taken, booking: booking!.toObject() as IBooking };
    });
  }

  /** After commit, best effort: Meet link for call/video (the window comes from the instant reservation) and notifications. */
  private async afterAccept(r: IInstantRequest, booking: IBooking, _now: Date) {
    try {
      const [{ syncBookingMeet }, { BookingRepository }, { UserRepository }, { SpecialistRepository }, { SlotRepository }] = await Promise.all([
        import('@/modules/meet/service'), import('@/modules/bookings/repository'), import('@/modules/user/repository'), import('@/modules/specialists/repository'),
        import('@/modules/slots/repository'),
      ]);
      await syncBookingMeet({ booking, bookingRepository: new BookingRepository(), userRepository: new UserRepository(),
        specialistRepository: new SpecialistRepository(), slotRepository: new SlotRepository() });
    } catch (e) {
      console.error('instant consult meet link failed', (e as Error)?.message);
    }
    await this.notify({ userId: r.userId, userType: 'user', title: 'Your doctor is joining', message: 'A doctor accepted your consultation.',
      key: `instant:${r._id}:accepted`, data: { requestId: String(r._id), bookingId: String(booking._id) } });
  }

  /** "No accept in time": the customer offers again (another doctor, or any available) within the paid quote. */
  async reoffer(userId: string, requestId: string, target: { kind: 'specific' | 'any'; doctorId?: string }, now = new Date()) {
    const r = await this.own(userId, requestId);
    if (r.status !== 'offered' || r.fundingState !== 'held') throw err(409, 'REQUEST_NOT_OPEN', 'This request is no longer waiting for a doctor');
    // Q16a: each re-offered doctor's fee is frozen again with the new offer.
    let offers: { doctorId: string; feeMinor: number }[];
    if (target.kind === 'specific') {
      if (!target.doctorId) throw err(400, 'DOCTOR_REQUIRED', 'Choose a doctor');
      if (r.couponDoctorIds && !r.couponDoctorIds.includes(String(target.doctorId))) {
        throw err(409, 'COUPON_NOT_FOR_DOCTOR', 'Your coupon is for other doctors; choose one of them or ask for a refund');
      }
      const online = await this.onlineDoctors({ specialization: r.specialization, mode: r.mode, maxFeeMinor: r.quotedAmountMinor }, now);
      const d = online.find((x) => x.doctorId === String(target.doctorId));
      const fee = d ? Math.min(d.instantFeeMinor, (r.offerFees ?? []).find((o) => o.doctorId === d.doctorId)?.feeMinor ?? d.instantFeeMinor) : 0;
      if (!d || !feeAffordable(r, fee)) throw err(409, 'DOCTOR_NOT_ONLINE', 'This doctor is not available within your paid amount');
      offers = [{ doctorId: d.doctorId, feeMinor: fee }];
    } else {
      offers = await this.offerTargets({ ...r, target }, now);
      if (!offers.length) throw err(409, 'NO_DOCTOR_ONLINE', 'No doctor is online within your paid amount right now');
    }
    const offeredTo = offers.map((o) => o.doctorId);
    const updated = await InstantRequestModel.findOneAndUpdate(
      { _id: r._id, userId: { $eq: userId }, status: 'offered', fundingState: 'held', offerGeneration: r.offerGeneration, statusVersion: r.statusVersion },
      { $set: { target, offeredTo, offerFees: mergeOfferFees(r.offerFees, offers), offerExpiresAt: new Date(now.getTime() + OFFER_MS), inactivityRefundAt: new Date(now.getTime() + INACTIVITY_MS) },
        $inc: { offerGeneration: 1, statusVersion: 1 } },
      { new: true }
    ).lean() as IInstantRequest | null;
    if (!updated) throw changed();
    await this.notifyOffer(updated);
    return requestView(updated);
  }

  /** The customer is still on the screen: the inactivity refund moves 30 minutes out. */
  async activity(userId: string, requestId: string, now = new Date()) {
    const r = await InstantRequestModel.findOneAndUpdate(
      { _id: requestId, userId: { $eq: userId }, status: 'offered', fundingState: 'held' },
      [{ $set: { inactivityRefundAt: { $max: ['$inactivityRefundAt', new Date(now.getTime() + INACTIVITY_MS)] } } }],
      { new: true }
    ).lean();
    if (!r) throw err(409, 'REQUEST_NOT_OPEN', 'This request is no longer waiting for a doctor');
    return requestView(r as IInstantRequest);
  }

  // ───────────────────────────── Refunds ─────────────────────────────

  async requestRefund(userId: string, requestId: string) {
    await this.own(userId, requestId);
    return this.refundHeld(requestId, 'customer');
  }

  /**
   * Refund of held funding (before any acceptance): held → refunded is a CAS that excludes acceptance (which needs
   * held). Everything the request holds goes back to the wallet exactly once; the coupon count is undone.
   */
  private async refundHeld(requestId: string, reason: 'customer' | 'inactivity', now = new Date()) {
    const id = String(requestId).toLowerCase();
    const out = await runLedgerTransaction(async (s) => {
      const r = await InstantRequestModel.findById(id).session(s).lean() as IInstantRequest | null;
      if (!r) throw notFound();
      if (r.status !== 'offered' || r.fundingState !== 'held') throw err(409, 'REQUEST_NOT_REFUNDABLE', 'A doctor already accepted, or it was refunded');
      if (reason === 'inactivity' && (!r.inactivityRefundAt || now < new Date(r.inactivityRefundAt))) return { refunded: 0, request: r, skipped: true };
      const records = await this.fenceRecords(id, s);
      const done = await InstantRequestModel.updateOne({ _id: id, status: 'offered', fundingState: 'held', statusVersion: r.statusVersion },
        { $set: { status: 'refunded', fundingState: 'refunded', paymentStatus: 'refunded', refundReason: reason,
          // Q9: what went back is recorded on the request (the held wallet + gateway parts; the coupon is voided, never money).
          refunded: { walletMinor: r.funding?.walletMinor ?? 0, gatewayMinor: r.funding?.gatewayMinor ?? 0,
            totalMinor: (r.funding?.walletMinor ?? 0) + (r.funding?.gatewayMinor ?? 0) } }, $inc: { statusVersion: 1 } }, { session: s });
      if (done.modifiedCount !== 1) throw changed();
      await undoCouponUsageIn(records.map((x) => String(x._id)), s);
      const refunded = await this.returnAll(r, records, s);
      return { refunded, request: r, skipped: false };
    });
    if (!out.skipped) {
      await this.notify({ userId: out.request.userId, userType: 'user', title: 'Consultation request refunded',
        message: `₹${out.refunded.toFixed(2)} is back in your wallet.`, key: `instant:${id}:refunded`, data: { requestId: id } });
    }
    return { refunded: out.refunded, skipped: out.skipped };
  }

  private async fenceRecords(id: string, s: ClientSession) {
    await PaymentRecordModel.collection.updateMany({ context: 'instant_request', contextId: id, status: { $nin: ['paid', 'refunded'] } },
      { $set: { updatedAt: new Date() } }, { session: s });
    return PaymentRecordModel.find({ context: 'instant_request', contextId: id }).session(s).lean() as unknown as Promise<
      { _id: unknown; userId?: string; status?: string; finalAmount?: number }[]>;
  }

  private async returnAll(r: IInstantRequest, records: { _id: unknown; userId?: string; status?: string; finalAmount?: number }[], s: ClientSession) {
    const id = String(r._id);
    const paid = records.filter((x) => String(x.userId) === r.userId && x.status === 'paid');
    const refunded = await refundAndCloseIn({ model: InstantRequestModel, kind: 'instant_request', bookingId: id, userId: r.userId,
      legacyFunded: 0, legacyGateway: 0, paidRecords: paid.map((x) => ({ recordId: String(x._id), amount: Number(x.finalAmount || 0) })),
      wallets: this.walletRepository }, s);
    const ledger = await InstantRequestModel.findById(id).select({ walletFunding: 1 }).session(s).lean() as any;
    const back = new Set(((ledger?.walletFunding?.captures ?? []) as any[]).filter((c) => c.state === 'returned').map((c) => String(c.recordId).toLowerCase()));
    const settled = paid.filter((x) => !(Number(x.finalAmount || 0) > 0) || back.has(String(x._id).toLowerCase())).map((x) => x._id);
    if (settled.length) await PaymentRecordModel.updateMany({ _id: { $in: settled }, status: 'paid' }, { $set: { status: 'refunded' } }, { session: s });
    return refunded;
  }

  private async creditWallet(userId: string, minor: number, key: string, description: string, refId: string, s: ClientSession) {
    const wallet = await WalletModel.findOneAndUpdate({ userId }, { $setOnInsert: { userId, balance: 0, isActive: true } }, { upsert: true, new: true, session: s }).lean();
    await this.walletRepository.postEntry({ userId, walletId: (wallet as any)._id, transactionType: 'refund', amount: rupees(minor),
      referenceType: 'instant_request', referenceId: refId, operationKey: key, description, transactionDate: getTodayYyyymmdd() } as any, s);
  }

  /**
   * After acceptance: the doctor (or an admin) cancels the consultation before it is completed. Only the allocation is
   * refundable — wallet and gateway parts back to the wallet, once; the coupon part is voided, never money.
   */
  async cancelAccepted(bookingId: string, requester: { _id: string; userType: 'specialist' | 'admin' }, reason: string) {
    if (!Types.ObjectId.isValid(bookingId)) throw err(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    const id = String(bookingId).toLowerCase();
    const out = await runLedgerTransaction(async (s) => {
      const b = await BookingModel.findOne({ _id: id, bookingKind: 'instant',
        ...(requester.userType === 'admin' ? {} : { specialistId: { $eq: requester._id } }) }).session(s).lean() as IBooking | null;
      if (!b) throw err(404, 'BOOKING_NOT_FOUND', 'Booking not found');
      if (b.status !== 'confirmed') throw err(409, 'BOOKING_STATE_CONFLICT', `A ${b.status} consultation cannot be cancelled`);
      const r = await InstantRequestModel.findOne({ _id: b.instantRequestId, bookingId: id }).session(s).lean() as IInstantRequest | null;
      if (!r || r.fundingState !== 'allocated' || !r.allocated) throw err(409, 'FUNDING_STATE_CONFLICT', 'The consultation funding is not in an allocated state');
      const byAdmin = requester.userType === 'admin';
      const done = await BookingModel.updateOne({ _id: id, status: 'confirmed' },
        { $set: { status: 'cancelled', paymentStatus: 'refunded', cancellationReason: reason, cancellationCause: byAdmin ? 'admin' : 'doctor', cancelledAt: istTodayYyyymmdd() } }, { session: s });
      if (done.modifiedCount !== 1) throw changed();
      const already = r.refunded ?? { walletMinor: 0, gatewayMinor: 0, totalMinor: 0 };
      const wallet = r.allocated.walletMinor - already.walletMinor;
      const gateway = r.allocated.gatewayMinor - already.gatewayMinor;
      const upd = await InstantRequestModel.updateOne({ _id: r._id, statusVersion: r.statusVersion, fundingState: 'allocated' },
        { $set: { fundingState: 'refunded', status: 'refunded', refundReason: byAdmin ? 'admin_cancelled' : 'doctor_cancelled',
          refunded: { walletMinor: already.walletMinor + wallet, gatewayMinor: already.gatewayMinor + gateway, totalMinor: already.totalMinor + wallet + gateway } },
          $inc: { statusVersion: 1 } }, { session: s });
      if (upd.modifiedCount !== 1) throw changed();
      if (wallet + gateway > 0) await this.creditWallet(r.userId, wallet + gateway, `instant_request_refund:${r._id}`,
        byAdmin ? 'Instant consultation cancelled by the Jansetu team' : 'Instant consultation cancelled by the doctor', String(r._id), s);
      const records = await PaymentRecordModel.find({ context: 'instant_request', contextId: String(r._id) }).session(s).lean();
      await undoCouponUsageIn(records.map((x) => String(x._id)), s);
      await releaseInterval('instant', id, s);
      return { userId: r.userId, refunded: rupees(wallet + gateway) };
    });
    await this.notify({ userId: out.userId, userType: 'user', title: 'Consultation cancelled', message: `${reason}. ₹${out.refunded.toFixed(2)} is back in your wallet.`,
      key: `instant-booking:${id}:cancelled`, data: { bookingId: id } });
    return out;
  }

  /**
   * The doctor keeps the consultation going: its interval is extended (refused if it would overlap another booking).
   * Read and computed inside the doctor-guarded transaction, so concurrent extensions add up and never overwrite.
   */
  async extend(doctorId: string, bookingId: string, minutes: number, now = new Date(), requestKey?: string) {
    if (!(Number.isInteger(minutes) && minutes > 0 && minutes <= 60)) throw err(400, 'INVALID_MINUTES', 'Extend by 1–60 minutes');
    if (!Types.ObjectId.isValid(bookingId)) throw err(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    const refId = String(bookingId).toLowerCase();
    return runLedgerTransaction(async (s) => {
      await bumpGuard(String(doctorId), s);
      const b = await BookingModel.findOne({ _id: refId, specialistId: String(doctorId), bookingKind: 'instant' }).session(s).lean() as IBooking | null;
      if (!b) throw err(404, 'BOOKING_NOT_FOUND', 'Booking not found');
      // Q13: a keyed extension happens once. The doctor guard serializes every extension of this doctor, so the
      // recorded keys read here are complete; the same key with the same minutes answers with the current hold.
      if (requestKey) {
        const prior = (b.instantExtensions ?? []).find((x) => x.requestKey === requestKey);
        if (prior) {
          if (prior.minutes !== minutes) throw err(409, 'REQUEST_KEY_REUSED', 'This request key was already used for a different extension');
          const held = await DoctorReservationModel.findOne({ refId, kind: 'instant' }).session(s).lean();
          return { ...(held ?? {}), extension: prior, replayed: true };
        }
      }
      if (b.status !== 'confirmed') throw err(404, 'BOOKING_NOT_FOUND', 'Booking not found');
      const cur = await DoctorReservationModel.findOne({ refId, kind: 'instant', isActive: true }).session(s).lean();
      if (!cur) throw err(409, 'RESERVATION_NOT_ACTIVE', 'The consultation is no longer held');
      const end = new Date(Math.max(new Date(cur.endTime).getTime(), now.getTime()) + minutes * 60_000);
      const moved = await moveInterval({ doctorId: String(doctorId), kind: 'instant', refId, start: cur.startTime, end }, s);
      const extension = { ...(requestKey ? { requestKey } : {}), minutes, endTime: end, at: now };
      const r = await BookingModel.updateOne({ _id: refId, status: 'confirmed' }, { $push: { instantExtensions: extension } }, { session: s });
      if (r.modifiedCount !== 1) throw changed();
      return { ...moved, extension, replayed: false };
    });
  }

  /** Q13: one of the doctor's instant consultations with the interval it holds now (a lost extend answer is checked here). */
  async doctorInstantBooking(doctorId: string, bookingId: string, now = new Date()) {
    if (!Types.ObjectId.isValid(bookingId)) throw err(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    const id = String(bookingId).toLowerCase();
    const b = await BookingModel.findOne({ _id: id, specialistId: String(doctorId), bookingKind: 'instant' }).lean() as IBooking | null;
    if (!b) throw err(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    const [held, r] = await Promise.all([
      DoctorReservationModel.findOne({ refId: id, kind: 'instant' }).lean(),
      b.instantRequestId ? InstantRequestModel.findById(b.instantRequestId).select({ patient: 1, acceptedFeeMinor: 1 }).lean() : null,
    ]);
    return {
      bookingId: id, instantRequestId: b.instantRequestId, status: b.status, consultationMode: b.consultationMode, bookingDate: b.bookingDate,
      bookingTime: b.bookingTime, feeMinor: r?.acceptedFeeMinor ?? paiseOf(Number(b.originalPrice ?? 0)),
      patient: r ? { name: r.patient.name, age: r.patient.age, gender: r.patient.gender } : null,
      held: held ? { startTime: held.startTime, endTime: held.endTime, isActive: held.isActive, current: held.isActive && now < new Date(held.endTime) } : null,
      extensions: (b.instantExtensions ?? []).map((x) => ({ requestKey: x.requestKey, minutes: x.minutes, endTime: x.endTime, at: x.at })),
      updatedAt: b.updatedAt,
    };
  }

  // ───────────────────────────── Sweeps ─────────────────────────────

  /** Unpaid requests past their window (reconciled first; deferred while the gateway state is unknown). */
  async expireUnpaid(now = new Date(), limit = 100) {
    const due = await InstantRequestModel.find({ status: 'pending_payment', paymentStatus: 'pending', paymentDeadline: { $lte: now },
      $or: [{ expiryNextAt: { $exists: false } }, { expiryNextAt: null }, { expiryNextAt: { $lte: now } }] }).limit(limit).lean();
    let expired = 0; let deferred = 0; let failed = 0;
    for (const d of due) {
      const id = String(d._id);
      // Q16a: one failing row never stops the sweep; it is logged by id and error only (no patient data) and retried next run.
      try {
        const check = await this.paymentService.reconcileContextPayments('instant_request', id).catch(() => ({ unknown: 1 }));
        if (check.unknown > 0) {
          const checks = Number(d.expiryChecks || 0) + 1;
          await InstantRequestModel.updateOne({ _id: id, status: 'pending_payment' }, { $set: { expiryNextAt: new Date(now.getTime() + Math.min(3_600_000, 60_000 * 2 ** Math.min(checks, 6))), expiryChecks: checks } });
          deferred += 1;
          continue;
        }
        const ok = await runLedgerTransaction(async (s) => {
          const r = await InstantRequestModel.findById(id).session(s).lean() as IInstantRequest | null;
          if (!r || r.status !== 'pending_payment' || r.paymentStatus !== 'pending' || now < new Date(r.paymentDeadline)) return false;
          const records = await this.fenceRecords(id, s);
          if (records.some((x) => x.status === 'paid')) return false;
          const done = await InstantRequestModel.updateOne({ _id: id, status: 'pending_payment', statusVersion: r.statusVersion },
            { $set: { status: 'expired_unpaid', fundingState: 'refunded', paymentStatus: 'refunded' }, $inc: { statusVersion: 1 }, $unset: { expiryNextAt: 1, expiryChecks: 1 } }, { session: s });
          if (done.modifiedCount !== 1) throw changed();
          await undoCouponUsageIn(records.map((x) => String(x._id)), s);
          await this.returnAll(r, records, s);
          return true;
        });
        if (ok) expired += 1;
      } catch (e) {
        failed += 1;
        sweepFailure('instant unpaid expiry', id, e);
      }
    }
    return { examined: due.length, expired, deferred, failed };
  }

  /** Held funding nobody accepted and the customer left unanswered for 30 minutes since the last offer/activity. */
  async refundInactive(now = new Date(), limit = 100) {
    const due = await InstantRequestModel.find({ status: 'offered', fundingState: 'held', inactivityRefundAt: { $lte: now } }).select({ _id: 1 }).limit(limit).lean();
    let refunded = 0; let failed = 0;
    for (const d of due) {
      try {
        const r = await this.refundHeld(String(d._id), 'inactivity', now);
        if (!r.skipped) refunded += 1;
      } catch (e: any) {
        if (['REQUEST_NOT_REFUNDABLE', 'INSTANT_REQUEST_CHANGED'].includes(e?.code)) continue;
        failed += 1;
        sweepFailure('instant inactivity refund', String(d._id), e);
      }
    }
    return { examined: due.length, refunded, failed };
  }

  // ───────────────────────────── Reads ─────────────────────────────

  private async own(userId: string, requestId: string): Promise<IInstantRequest> {
    if (!Types.ObjectId.isValid(requestId)) throw notFound();
    const r = await InstantRequestModel.findOne({ _id: requestId, userId: { $eq: userId } }).lean();
    if (!r) throw notFound();
    return r as IInstantRequest;
  }

  async getForCustomer(userId: string, requestId: string) { return requestView(await this.own(userId, requestId)); }

  /** Q9: paged, newest first. */
  async listForCustomer(userId: string, page = 1, limit = 20) {
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const pg = Math.max(Number(page) || 1, 1);
    const q = { userId: { $eq: userId } };
    const [rows, total] = await Promise.all([
      InstantRequestModel.find(q).sort({ createdAt: -1, _id: -1 }).skip((pg - 1) * lim).limit(lim).lean(),
      InstantRequestModel.countDocuments(q),
    ]);
    return { items: rows.map((r) => requestView(r as IInstantRequest)), page: pg, limit: lim, total, totalPages: Math.max(1, Math.ceil(total / lim)) };
  }

  /** Q9: the specialities customers can ask for (active, verified doctors' current profiles), with how many are online now. */
  async specialities(mode?: InstantMode, now = new Date()) {
    const all = (await SpecialistModel.distinct('specialization', { isActive: { $ne: false }, isVerified: { $ne: false } }) as unknown[])
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
    const fresh = await DoctorPresenceModel.find({ available: true, lastSeenAt: { $gte: new Date(now.getTime() - PRESENCE_TTL_MS) }, ...(mode ? { modes: mode } : {}) })
      .select({ doctorId: 1 }).lean();
    const ids = fresh.map((p) => p.doctorId).filter((i) => Types.ObjectId.isValid(i));
    const [busy, docs] = await Promise.all([
      DoctorReservationModel.find({ doctorId: { $in: ids }, ...busyWindow(now) }).select({ doctorId: 1 }).lean(),
      SpecialistModel.find({ _id: { $in: ids }, isActive: true, isVerified: true }).select({ specialization: 1 }).lean() as any,
    ]);
    const busyIds = new Set(busy.map((b) => b.doctorId));
    const online = new Map<string, number>();
    for (const d of docs as any[]) {
      if (busyIds.has(String(d._id)) || typeof d.specialization !== 'string') continue;
      const k = d.specialization.trim().toLowerCase();
      online.set(k, (online.get(k) ?? 0) + 1);
    }
    const seen = new Map<string, string>();
    for (const s of all) if (!seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
    return [...seen.entries()].map(([k, name]) => ({ specialization: name, onlineNow: online.get(k) ?? 0 }))
      .sort((a, b) => b.onlineNow - a.onlineNow || a.specialization.localeCompare(b.specialization));
  }
}

/** Registers the 'instant_request' payment context (at route setup and in tests). */
export function registerInstantPayments(resolve: () => InstantConsultService = () => Container.get(InstantConsultService)): void {
  registerPaymentContextHandler('instant_request', {
    process: (record, helpers) => resolve().applyCapture(record, helpers),
    entity: async (record) => {
      const r = await InstantRequestModel.findById(record.contextId).lean();
      return r ? requestView(r as IInstantRequest) : {};
    },
  });
}
