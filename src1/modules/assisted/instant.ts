import { Types } from 'mongoose';
import { Container } from 'typedi';
import { AppError } from '@/modules/common/types';
import { requestHashOf } from '@/modules/common/utils/canonicalJson';
import { canonicalMobile } from '@/modules/common/utils/phone';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import BookingModel from '@/modules/bookings/model';
import UserModel from '@/modules/user/model';
import PharmacyModel from '@/modules/pharmacies/model';
import SpecialistModel from '@/modules/specialists/model';
import { CouponRedemptionModel } from '@/modules/coupon/model/redemption';
import { PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { abandonRequestKey, claimRequestKey } from '@/modules/requestKeys';
import { InstantRequestModel, type IInstantRequest, type InstantMode } from '@/modules/doctors/model/instant';
import { InstantConsultService, couponTermsOf } from '@/modules/doctors/services/instant';
import { assertPharmacyInstantOn } from '@/modules/assisted/flags';
import { hitLookup } from '@/modules/assisted/limits';
import { auditIn } from '@/modules/assisted/support';
import { pharmacyFacingHolderNames } from '@/modules/assisted/names';
import { assistedBookerFilter } from '@/modules/assisted/refunds';
import { postBookerMovementIn } from '@/modules/assisted/bookerWallet';
import { ASSISTED_KEY, assistedCouponFor, newShortRef, type PharmacyActor } from '@/modules/assisted/consultations';
import {
  applyPatientPlanIn, cleanName, linkPharmacyCustomerIn, patientIdentity, planAssistedPatient, redeemCouponIn, type AssistedPatientInput,
} from '@/modules/assisted/patient';
import type { InstantAssistedBlock } from '@/modules/assisted/types';

/**
 * Assisted booking round 3e (ASSISTED_BOOKING_DESIGN.md §25.8, §7.7): a PHARMACY books an instant "Consult now"
 * consultation for a walk-in patient and pays from its wallet (DR18: wallet only in phase 3; DR19: video or call).
 *
 * The request is the customer instant request of Q4b (presence, quote, 5-minute offers, re-offer, first accept wins,
 * the inactivity refund), with an `assisted` block and the booker's money as the `partner` part of its funding. The
 * instant service does every step after the create; this module adds the partner's create (§6.2 order, ONE
 * transaction), its own-rows reads, by-key / abandon, and the scoped commands. Labs join after 2d + 2e
 * (`postBookerMovementIn` is the payer seam).
 */
const LANGUAGE = /^[a-z]{2,3}$/;
const LIST_MAX = 50;
const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new AppError({ status, code, message }), extra);
const notFound = () => err(404, 'INSTANT_REQUEST_NOT_FOUND', 'Request not found');
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const instant = () => Container.get(InstantConsultService);

type Target = { kind: 'any' } | { kind: 'specific'; doctorId: string };

export interface AssistedInstantInput {
  requestKey: string;
  phone: string;
  patient: AssistedPatientInput;
  holderName?: string;
  consent: { agreed: boolean; statementVersion: string; statementLanguage: string };
  preferredLanguage: string;
  specialization: string;
  mode: 'video' | 'call';
  target: Target;
  join: { on: 'partner_device' | 'patient_phone'; phone?: string };
  couponCode?: string;
  /** Price fence (§6.3): the quote and what the booker pays after the coupon, both in paise. */
  acceptedQuoteMinor: number;
  acceptedPayableMinor: number;
  primaryConcern?: string;
  paymentMethod: 'wallet' | 'razorpay';
}

/** §25.8.5: stored `assisted_instant:<kind>:<orgId>:<actorId>:<key>`, claimed in `assisted_instant_create:<kind>:<orgId>:<actorId>`. */
export const storedInstantKey = (a: PharmacyActor, key: string) => `assisted_instant:pharmacy:${lower(a.pharmacyId)}:${lower(a.actorId)}:${key}`;
export const instantKeyScope = (a: PharmacyActor) => `assisted_instant_create:pharmacy:${lower(a.pharmacyId)}:${lower(a.actorId)}`;
const orgKey = (pharmacyId: string) => `pharmacy:${lower(pharmacyId)}`;
const doctorIdOf = (t: Target) => (t.kind === 'specific' ? lower(t.doctorId) : undefined);

/** §25.8.5: the content a key is bound to (never the payment method). */
export function instantAssistedHash(input: AssistedInstantInput): string {
  return requestHashOf({
    phone: canonicalMobile(input.phone) ?? input.phone,
    patient: patientIdentity(input.patient),
    holderName: input.holderName ? cleanName(input.holderName) : null,
    service: { specialization: String(input.specialization ?? '').trim().toLowerCase(), mode: input.mode,
      target: input.target?.kind === 'specific' ? { kind: 'specific', doctorId: lower(input.target.doctorId) } : { kind: 'any' },
      join: input.join ? { on: input.join.on, phone: input.join.phone ? canonicalMobile(input.join.phone) : null } : null },
    couponCode: input.couponCode ? input.couponCode.trim().toUpperCase() : null,
    preferredLanguage: input.preferredLanguage,
    primaryConcern: input.primaryConcern?.trim() || null,
    acceptedQuoteMinor: input.acceptedQuoteMinor,
    acceptedPayableMinor: input.acceptedPayableMinor,
  });
}

/** §25.8.5: every unique index the create relies on (fail closed: 503 INDEXES_OUTDATED until sync-indexes has run). */
export async function assertInstantIndexes(withCoupon: boolean): Promise<void> {
  await assertUniqueIndex(InstantRequestModel, { 'assisted.requestKey': 1 });
  await assertUniqueIndex(InstantRequestModel, { 'assisted.shortRef': 1 });
  await assertUniqueIndex(InstantRequestModel, { userId: 1, createRequestKey: 1 });
  await assertUniqueIndex(PharmacyWalletTransactionModel, { pharmacyId: 1, operationKey: 1 });
  await assertUniqueIndex(RequestKeyModel, { scope: 1, key: 1 });
  if (withCoupon) await assertUniqueIndex(CouponRedemptionModel, { couponCode: 1, bookingKind: 1, bookingId: 1 });
}

function validate(input: AssistedInstantInput): void {
  if (!input.consent || input.consent.agreed !== true) throw err(400, 'CONSENT_REQUIRED', 'Tick "patient agreed" before booking for the patient');
  // Q2 / DR18: wallet only in phase 3 (a card would need partial card refunds of the quote difference).
  if (input.paymentMethod !== 'wallet') throw err(400, 'PAYMENT_METHOD_UNAVAILABLE', 'Consult now for patients is paid from the Jansetu wallet');
  if (!ASSISTED_KEY.test(String(input.requestKey ?? ''))) throw err(400, 'REQUEST_KEY_REQUIRED', 'requestKey is required');
  if (!LANGUAGE.test(String(input.preferredLanguage ?? ''))) throw err(400, 'VALIDATION_ERROR', 'preferredLanguage must be a language code');
  if (!canonicalMobile(input.phone)) throw err(400, 'INVALID_PHONE', 'Enter a valid 10-digit mobile number');
  // DR19: video or call only, never chat.
  if (input.mode !== 'video' && input.mode !== 'call') throw err(400, 'VALIDATION_ERROR', 'Consult now for patients is a video or phone call');
  if (!String(input.specialization ?? '').trim()) throw err(400, 'VALIDATION_ERROR', 'Choose a speciality');
  if (input.target?.kind === 'specific' && !(input.target as { doctorId?: string }).doctorId) throw err(400, 'DOCTOR_REQUIRED', 'Choose a doctor');
  if (!input.join) throw err(400, 'VALIDATION_ERROR', 'Choose where the patient joins the consultation');
  if (input.join.on === 'patient_phone' && input.join.phone && !canonicalMobile(input.join.phone)) {
    throw err(400, 'INVALID_PHONE', 'Enter a valid 10-digit mobile number for the call');
  }
}

async function replayOf(storedKey: string, hash: string): Promise<IInstantRequest | null> {
  const prior = await InstantRequestModel.findOne({ 'assisted.requestKey': { $eq: storedKey } }).lean() as IInstantRequest | null;
  if (!prior) return null;
  if (prior.assisted?.requestHash !== hash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different request');
  return prior;
}

/** POST /pharmacy-assisted/instant/requests — 201 (replay 200) with the booker view and its funding. */
export async function createPharmacyInstant(actor: PharmacyActor, input: AssistedInstantInput, clock: () => Date = () => new Date(), attempt = 0) {
  assertPharmacyInstantOn();
  validate(input);
  const phone = canonicalMobile(input.phone)!;
  const pharmacyId = lower(actor.pharmacyId);
  const storedKey = storedInstantKey(actor, input.requestKey);
  const hash = instantAssistedHash(input);
  await assertInstantIndexes(!!input.couponCode);
  // §25.3 patient order: the replay of this booker's own key and content answers first and is not counted.
  const replay = await InstantRequestModel.findOne({ 'assisted.requestKey': { $eq: storedKey } }).lean() as IInstantRequest | null;
  if (replay && replay.assisted?.requestHash === hash) return instantReceipt(replay, pharmacyId, true);
  if (attempt === 0) {
    await hitLookup(orgKey(pharmacyId));
    const seen = await UserModel.findOne({ phone, userType: 'user' }).select({ _id: 1 }).lean() as { _id: unknown } | null;
    await auditIn({ actorKind: 'pharmacy', actorId: lower(actor.actorId), orgKind: 'pharmacy', orgId: pharmacyId, action: 'booking.attempted',
      requestKey: input.requestKey, detail: { kind: 'instant_request', exists: !!seen, ...(seen ? { userId: String(seen._id) } : {}) } }, null);
  }
  const prior = await replayOf(storedKey, hash);
  if (prior) return instantReceipt(prior, pharmacyId, true);
  if (await RequestKeyModel.exists({ scope: instantKeyScope(actor), key: input.requestKey, state: 'abandoned' })) {
    throw err(409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
  }

  // Every check that can refuse, the same answer for a known and an unknown number (review 4).
  const now = clock();
  const svc = instant();
  const specialization = input.specialization.trim();
  const doctorId = doctorIdOf(input.target);
  const { quotedAmountMinor } = await svc.quote({ specialization, mode: input.mode, doctorId }, now);
  const plan = await planAssistedPatient({ phone, patient: input.patient, holderName: input.holderName, preferredLanguage: input.preferredLanguage });
  const coupon = await assistedCouponFor(input.couponCode, { userId: plan.customer._id, dependentId: plan.dependentId, doctorId, listMinor: quotedAmountMinor });
  const discountMinor = coupon?.discountMinor ?? 0;
  const payMinor = quotedAmountMinor - discountMinor;
  if (input.acceptedQuoteMinor !== quotedAmountMinor || input.acceptedPayableMinor !== payMinor) {
    throw err(409, 'QUOTE_CHANGED', 'The price changed; check it with the patient and book again', { details: { quotedAmountMinor, discountMinor } });
  }
  const couponDoctorIds = coupon?.coupon.applicableTo === 'specific' ? (coupon.coupon.applicableIds ?? []).map(String) : undefined;
  const couponTerms = coupon ? couponTermsOf(coupon.coupon) : undefined;
  const target = doctorId ? { kind: 'specific' as const, doctorId } : { kind: 'any' as const };
  const offers = await svc.offerTargets({ target, specialization, mode: input.mode, quotedAmountMinor, discountMinor,
    ...(couponDoctorIds ? { couponDoctorIds } : {}), ...(couponTerms ? { couponTerms } : {}) }, now);
  if (!offers.length) throw err(409, 'NO_DOCTOR_ONLINE', 'No doctor of this speciality is online right now');
  const pharmacy = await PharmacyModel.findById(pharmacyId).select({ name: 1 }).lean() as { name?: string } | null;

  const requestId = new Types.ObjectId().toHexString();
  const entryId = new Types.ObjectId();
  const assisted: InstantAssistedBlock = {
    bookedBy: { kind: 'pharmacy', id: pharmacyId, actorKind: 'pharmacy', actorId: lower(actor.actorId), name: pharmacy?.name ?? 'Pharmacy' },
    consent: { method: 'partner_attested', statementVersion: input.consent.statementVersion, statementLanguage: input.consent.statementLanguage,
      at: now, actorId: lower(actor.actorId) },
    preferredLanguage: input.preferredLanguage,
    identity: { attested: true, newAccount: plan.customer.created },
    join: { on: input.join.on, ...(input.join.phone ? { phone: canonicalMobile(input.join.phone)! } : {}), linkVersion: 1 },
    funding: { method: 'wallet', payerKind: 'pharmacy', payerId: pharmacyId, amountMinor: payMinor, state: 'held',
      ...(payMinor > 0 ? { walletEntryId: String(entryId) } : {}), refunds: [] },
    ...(coupon ? { couponFundedBy: coupon.fundedBy } : {}),
    ...(input.primaryConcern?.trim() ? { primaryConcern: input.primaryConcern.trim() } : {}),
    referral: null,
    shortRef: newShortRef(),
    requestKey: storedKey,
    requestHash: hash,
  };
  let request: IInstantRequest;
  try {
    request = await runLedgerTransaction(async (s) => {
      const again = await InstantRequestModel.findOne({ 'assisted.requestKey': { $eq: storedKey } }).session(s).lean() as IInstantRequest | null;
      if (again) return again;
      await claimRequestKey(instantKeyScope(actor), input.requestKey, s);
      await applyPatientPlanIn(plan, input.preferredLanguage, s);
      await linkPharmacyCustomerIn(actor, plan.customer._id, plan.holderTyped, s);
      if (coupon) {
        await redeemCouponIn(coupon, { bookingKind: 'instant_request', payerKind: 'pharmacy', bookingId: requestId, patientUserId: plan.customer._id,
          dependentId: plan.dependentId, payerId: pharmacyId }, s);
      }
      // §25.8.1: paid from the start (never `pending_payment`); the held funding is coupon + the partner's money.
      const [created] = await InstantRequestModel.create([{
        _id: requestId, userId: plan.customer._id, createRequestKey: storedKey, createRequestHash: hash,
        patient: plan.dependentId ? { kind: 'dependent', dependentId: plan.dependentId, name: plan.patientName } : { kind: 'self', name: plan.patientName },
        specialization, mode: input.mode, target, quotedAmountMinor, ...(coupon ? { couponCode: coupon.code } : {}),
        ...(couponDoctorIds ? { couponDoctorIds } : {}), ...(couponTerms ? { couponTerms } : {}), discountMinor,
        statusVersion: 1, paymentStatus: 'paid', paymentDeadline: now, source: 'pharmacy_assisted', assisted,
        ...svc.holdPatch({ discountMinor }, 0, 0, offers, now, payMinor),
      }], { session: s });
      if (payMinor > 0) {
        await postBookerMovementIn({ payerKind: 'pharmacy', payerId: pharmacyId, kind: 'booking_debit', amountPaise: payMinor,
          operationKey: `assisted_instant:${requestId}:debit`, referenceType: 'assisted_instant', referenceId: `${requestId}:debit`,
          description: 'Instant consultation for a patient', entryId }, s);
      }
      await auditIn({ actorKind: 'pharmacy', actorId: lower(actor.actorId), orgKind: 'pharmacy', orgId: pharmacyId, action: 'booking.created',
        bookingId: requestId, requestKey: input.requestKey,
        detail: { kind: 'instant_request', specialization, mode: input.mode, ...(doctorId ? { doctorId } : {}), amountMinor: payMinor, method: 'wallet',
          accountCreated: plan.customer.created, ...(plan.dependentId ? { dependentId: plan.dependentId, dependentCreated: !!plan.newDependent } : {}),
          ...(coupon ? { couponCode: coupon.code } : {}) } }, s);
      return created!.toObject() as IInstantRequest;
    });
  } catch (e) {
    // A racing identical request may have committed first: answer with its receipt.
    const raced = await replayOf(storedKey, hash);
    if (raced) return instantReceipt(raced, pharmacyId, true);
    if ((e as { code?: string }).code === 'ACCOUNT_OPENED_MEANWHILE' && attempt === 0) return createPharmacyInstant(actor, input, clock, 1);
    throw e;
  }
  if (String(request._id) !== requestId) {
    if (request.assisted?.requestHash !== hash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different request');
    return instantReceipt(request, pharmacyId, true);
  }
  // After the commit: the offers go out (SMS phase 5: nothing to the patient until a doctor accepts).
  await svc.notifyOffer(request);
  return instantReceipt(request, pharmacyId, false);
}

async function instantReceipt(r: IInstantRequest, pharmacyId: string, replayed: boolean) {
  const f = r.assisted!.funding;
  return { request: await bookerInstantView(r, pharmacyId), funding: { method: f.method, amountMinor: f.amountMinor, state: f.state, walletEntryId: f.walletEntryId ?? null },
    newAccount: !!r.assisted?.identity?.newAccount, replayed };
}

// ───────────────────────────── The booker view ─────────────────────────────

type Row = Record<string, any>;
const sumOf = (rows: InstantAssistedBlock['funding']['refunds'], kinds: string[]) =>
  rows.filter((x) => kinds.includes(x.kind)).reduce((a, x) => a + Number(x.amountMinor || 0), 0);

/**
 * §25.8.3 booker instant view: the request's state and fences, the patient's typed / family name and the holder's name
 * by the pharmacy names rule (§17.4), the ref and join choice, and the booker's OWN money (paid, returned, refunded).
 * Never the request keys, the doctor fees offered, or the patient's account data.
 */
export async function bookerInstantViews(rows: IInstantRequest[], pharmacyId: string): Promise<Row[]> {
  const bookingIds = rows.map((r) => r.bookingId).filter((id): id is string => !!id && Types.ObjectId.isValid(id));
  const [holders, bookings] = await Promise.all([
    pharmacyFacingHolderNames(rows.map((r) => r.userId), pharmacyId),
    bookingIds.length ? BookingModel.find({ _id: { $in: bookingIds } }).select({ doctorName: 1 }).lean() as unknown as Promise<Row[]> : Promise.resolve([] as Row[]),
  ]);
  const doctorBy = new Map(bookings.map((b) => [String(b._id), b.doctorName as string | undefined]));
  return rows.map((r) => {
    const a = r.assisted!;
    const refunds = a.funding.refunds ?? [];
    return {
      _id: String(r._id), status: r.status, statusVersion: r.statusVersion, mode: r.mode, specialization: r.specialization, target: r.target,
      offerGeneration: r.offerGeneration, offerExpiresAt: r.offerExpiresAt ?? null, inactivityRefundAt: r.inactivityRefundAt ?? null,
      offeredCount: (r.offeredTo ?? []).length, acceptedDoctorName: r.bookingId ? doctorBy.get(String(r.bookingId)) ?? null : null,
      bookingId: r.bookingId ?? null, patientName: r.patient?.name ?? null, holder: holders.get(String(r.userId)) ?? null,
      assisted: { shortRef: a.shortRef, join: { on: a.join?.on }, preferredLanguage: a.preferredLanguage,
        ...(a.identity?.disputed ? { disputed: { state: a.identity.disputed.state } } : {}) },
      money: { quotedAmountMinor: r.quotedAmountMinor, discountMinor: r.discountMinor, paidMinor: a.funding.amountMinor,
        returnedMinor: sumOf(refunds, ['quote_return']), refundedMinor: sumOf(refunds, ['refund', 'cancel_refund']) },
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  });
}

export async function bookerInstantView(r: IInstantRequest, pharmacyId: string): Promise<Row> {
  return (await bookerInstantViews([r], pharmacyId))[0]!;
}

// ───────────────────────────── Booker reads and commands ─────────────────────────────

/** The booker's own request, else the uniform 404 (another pharmacy's, a customer's own, or none). */
async function ownInstant(actor: PharmacyActor, requestId: unknown): Promise<IInstantRequest> {
  if (!Types.ObjectId.isValid(String(requestId ?? ''))) throw notFound();
  const r = await InstantRequestModel.findOne({ _id: String(requestId), ...assistedBookerFilter('pharmacy', actor.pharmacyId) }).lean() as IInstantRequest | null;
  if (!r?.assisted) throw notFound();
  return r;
}

export async function getInstantForPharmacy(actor: PharmacyActor, requestId: string) {
  return bookerInstantView(await ownInstant(actor, requestId), lower(actor.pharmacyId));
}

/** GET /pharmacy-assisted/instant/requests — own rows, newest first, cursor `<createdAt ms>_<id>`, at most 50 a page. */
export async function listInstantForPharmacy(actor: PharmacyActor, q: { status?: string; cursor?: string; limit?: number }) {
  const limit = Math.min(Math.max(Number(q.limit) || 20, 1), LIST_MAX);
  const filter: Record<string, unknown> = { ...assistedBookerFilter('pharmacy', actor.pharmacyId), ...(q.status ? { status: q.status } : {}) };
  const m = /^(\d{1,15})_([0-9a-fA-F]{24})$/.exec(String(q.cursor ?? ''));
  if (q.cursor && !m) throw err(400, 'VALIDATION_ERROR', 'Invalid cursor');
  const page = m ? { ...filter, $or: [{ createdAt: { $lt: new Date(Number(m[1])) } }, { createdAt: new Date(Number(m[1])), _id: { $lt: new Types.ObjectId(m[2]) } }] } : filter;
  const [total, rows] = await Promise.all([
    InstantRequestModel.countDocuments(filter),
    InstantRequestModel.find(page).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean() as unknown as Promise<IInstantRequest[]>,
  ]);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: await bookerInstantViews(items, lower(actor.pharmacyId)), total,
    nextCursor: rows.length > limit && last ? `${new Date(last.createdAt!).getTime()}_${String(last._id)}` : null };
}

/** GET /pharmacy-assisted/instant/requests/by-key/:key — 'used' (with the request), 'abandoned' or 'unknown' (Q13). */
export async function findInstantByKey(actor: PharmacyActor, key: string) {
  if (!ASSISTED_KEY.test(String(key ?? ''))) throw err(400, 'VALIDATION_ERROR', 'A valid key is required');
  const r = await InstantRequestModel.findOne({ 'assisted.requestKey': { $eq: storedInstantKey(actor, key) } }).lean() as IInstantRequest | null;
  if (r) return { state: 'used' as const, request: await bookerInstantView(r, lower(actor.pharmacyId)) };
  const row = await RequestKeyModel.findOne({ scope: instantKeyScope(actor), key }).lean();
  return { state: row?.state === 'abandoned' ? 'abandoned' as const : 'unknown' as const };
}

/** POST /pharmacy-assisted/instant/requests/by-key/:key/abandon — abandoned (it can never be made) or used (here it is). */
export async function abandonInstantByKey(actor: PharmacyActor, key: string) {
  if (!ASSISTED_KEY.test(String(key ?? ''))) throw err(400, 'VALIDATION_ERROR', 'A valid key is required');
  if (await InstantRequestModel.exists({ 'assisted.requestKey': { $eq: storedInstantKey(actor, key) } })) return findInstantByKey(actor, key);
  const state = await abandonRequestKey(instantKeyScope(actor), key);
  return state === 'abandoned' ? { state } : findInstantByKey(actor, key);
}

/** POST …/instant/requests/:id/reoffer — "Offer again" (any online doctor, or a chosen one) within the paid quote. */
export async function reofferInstantByBooker(actor: PharmacyActor, requestId: string, input: { target: Target; expectedStatusVersion: number }, clock: () => Date = () => new Date()) {
  const r = await ownInstant(actor, requestId);
  const target = input.target?.kind === 'specific' ? { kind: 'specific' as const, doctorId: lower(input.target.doctorId) } : { kind: 'any' as const };
  const updated = await instant().reofferOwned(r, target, clock(), input.expectedStatusVersion);
  await auditIn({ actorKind: 'pharmacy', actorId: lower(actor.actorId), orgKind: 'pharmacy', orgId: lower(actor.pharmacyId), action: 'instant.reoffered',
    bookingId: String(r._id), detail: { target: target.kind, ...(target.kind === 'specific' ? { doctorId: target.doctorId } : {}) } }, null);
  return getInstantForPharmacy(actor, String((updated as { _id?: unknown })._id ?? r._id));
}

/** POST …/instant/requests/:id/activity — the booker's screen heartbeat: the inactivity refund moves 30 minutes out. */
export async function instantActivityByBooker(actor: PharmacyActor, requestId: string, clock: () => Date = () => new Date()) {
  const r = await ownInstant(actor, requestId);
  return bookerInstantView(await instant().activityOwned(r, clock()), lower(actor.pharmacyId));
}

/** POST …/instant/requests/:id/refund — "Cancel and refund" before any doctor accepted: everything back, lots restored. */
export async function refundInstantByBooker(actor: PharmacyActor, requestId: string, input: { expectedStatusVersion: number }, clock: () => Date = () => new Date()) {
  const r = await ownInstant(actor, requestId);
  const out = await instant().refundAsBooker(r, input.expectedStatusVersion, async (s) => {
    await auditIn({ actorKind: 'pharmacy', actorId: lower(actor.actorId), orgKind: 'pharmacy', orgId: lower(actor.pharmacyId), action: 'booking.cancelled',
      bookingId: String(r._id), detail: { kind: 'instant_request', cause: 'booker' } }, s);
  }, clock());
  return { refundedMinor: Math.round(out.refunded * 100), request: await getInstantForPharmacy(actor, requestId) };
}

// ───────────────────────────── Discovery: specialities, doctors, quote ─────────────────────────────

/** GET …/instant/specialities?mode — the specialities with how many eligible doctors are online now. */
export async function instantSpecialitiesForPharmacy(_actor: PharmacyActor, mode?: InstantMode) {
  assertPharmacyInstantOn();
  return instant().specialities(mode);
}

/**
 * GET …/instant/doctors?speciality&mode — eligible online doctors, nearest first: the pharmacy's pincode, then its
 * city, then the lower fee (§25.8.3). `nearby` says which matched.
 */
export async function instantDoctorsForPharmacy(actor: PharmacyActor, q: { speciality: string; mode: InstantMode }) {
  assertPharmacyInstantOn();
  const online = await instant().onlineDoctors({ specialization: q.speciality, mode: q.mode });
  if (!online.length) return [];
  const [pharmacy, places] = await Promise.all([
    PharmacyModel.findById(lower(actor.pharmacyId)).select({ pincode: 1, city: 1 }).lean() as unknown as Promise<{ pincode?: string; city?: string } | null>,
    SpecialistModel.find({ _id: { $in: online.map((d) => d.doctorId) } }).select({ pincode: 1, city: 1 }).lean() as unknown as Promise<Row[]>,
  ]);
  const placeBy = new Map(places.map((p) => [String(p._id), p]));
  const same = (a?: unknown, b?: unknown) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  const nearbyOf = (id: string) => {
    const p = placeBy.get(id);
    return same(p?.pincode, pharmacy?.pincode) ? 'pincode' as const : same(p?.city, pharmacy?.city) ? 'city' as const : null;
  };
  const rank = (n: 'pincode' | 'city' | null) => (n === 'pincode' ? 0 : n === 'city' ? 1 : 2);
  return online.map((d) => ({ doctorId: d.doctorId, name: d.name, specialization: d.specialization, modes: d.modes, instantFeeMinor: d.instantFeeMinor,
    nearby: nearbyOf(d.doctorId) }))
    .sort((a, b) => rank(a.nearby) - rank(b.nearby) || a.instantFeeMinor - b.instantFeeMinor);
}

/** GET …/instant/quote?speciality&mode&doctorId — the price contract (409 NO_DOCTOR_ONLINE / DOCTOR_NOT_ONLINE). */
export async function instantQuoteForPharmacy(_actor: PharmacyActor, q: { speciality: string; mode: InstantMode; doctorId?: string }) {
  assertPharmacyInstantOn();
  return instant().quote({ specialization: q.speciality, mode: q.mode, ...(q.doctorId ? { doctorId: lower(q.doctorId) } : {}) });
}
