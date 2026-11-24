import { randomBytes } from 'crypto';
import { Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { requestHashOf } from '@/modules/common/utils/canonicalJson';
import { canonicalMobile } from '@/modules/common/utils/phone';
import { normalizeCouponDiscount } from '@/modules/common/utils/couponMoney';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { bookableUntilOf, isWindowSlot } from '@/modules/common/utils/slotInterval';
import BookingModel from '@/modules/bookings/model';
import type { IBooking } from '@/modules/bookings/types';
import { createBookingWithHolds, isReplayedBooking } from '@/modules/bookings/holds';
import SlotModel from '@/modules/slots/model';
import SpecialistModel from '@/modules/specialists/model';
import UserModel from '@/modules/user/model';
import DependentModel from '@/modules/dependents/model';
import PharmacyModel from '@/modules/pharmacies/model';
import { CouponRedemptionModel } from '@/modules/coupon/model/redemption';
import { CouponService } from '@/modules/coupon/services';
import { CouponRepository } from '@/modules/coupon/repository';
import { PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { postPharmacyMovementIn } from '@/modules/pharmacyWallet/ledger';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { claimRequestKey } from '@/modules/requestKeys';
import { assertPharmacyAssistedOn } from '@/modules/assisted/flags';
import { countPairBookingIn, hitLookup } from '@/modules/assisted/limits';
import { assistedEffects, auditIn, bestEffort, sendAssistedNotices, type AssistedNotice } from '@/modules/assisted/support';
import type { AssistedBlock } from '@/modules/assisted/types';
import { assertCardPaymentAvailable, openCardOrder, type CardPaymentView } from '@/modules/assisted/cardPayments';
import {
  cleanName, linkPharmacyCustomerIn, patientIdentity, preparePatient, redeemCouponIn, writePatientIn, type AssistedPatientInput,
} from '@/modules/assisted/patient';

export type { AssistedPatientInput } from '@/modules/assisted/patient';
import { snapshotCuts } from '@/modules/referralCuts/service';

/**
 * Assisted booking phase 1a (design §6.2–§6.4, §7.1, §17): a PHARMACY books a doctor consultation for a walk-in patient
 * and pays from its Jansetu wallet. Order (§6.2): validate → limits → resolve the account (outside the transaction,
 * idempotent, as the clinic desk) → ONE transaction: request key claim, family member, pharmacy-customer link with the
 * typed name and consent, seat and doctor interval, coupon redemption, wallet debit (lots consumed),
 * the booking with its `assisted` block and split, audit. No payment record is written (P3). Exactly once per (booker,
 * actor, request key) with a content hash.
 */
export const ASSISTED_KEY = /^[A-Za-z0-9_-]{8,100}$/;
const LANGUAGE = /^[a-z]{2,3}$/;
const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new AppError({ status, code, message }), extra);
/**
 * Stage merge (S5b): the slot reservation re-reads the doctor inside the transaction (reserveSlot). A doctor unverified
 * or made inactive after the assisted check answers as that check does: 409 DOCTOR_NOT_AVAILABLE (nothing committed).
 */
export const asDoctorUnavailable = (e: unknown): unknown =>
  (['SPECIALIST_NOT_VERIFIED', 'SPECIALIST_NOT_ACTIVE'].includes(String((e as { code?: string } | null)?.code))
    ? err(409, 'DOCTOR_NOT_AVAILABLE', 'This doctor is not taking bookings') : e);
const lower = (v: unknown) => String(v ?? '').toLowerCase();

export interface PharmacyActor { pharmacyId: string; actorId: string }

export interface AssistedConsultInput {
  requestKey: string;
  phone: string;
  patient: AssistedPatientInput;
  /** §17.4: sets the link's typedName for a family-member booking when the link has none yet. */
  holderName?: string;
  consent: { agreed: boolean; statementVersion: string; statementLanguage: string };
  preferredLanguage: string;
  slotId: string;
  consultationMode: 'video' | 'call' | 'in-person';
  join?: { on: 'partner_device' | 'patient_phone'; phone?: string };
  couponCode?: string;
  /** Price fence (§6.3): what the pharmacy pays, after the coupon, in paise. */
  acceptedPriceMinor: number;
  primaryConcern?: string;
  notes?: string;
  paymentMethod: 'wallet' | 'razorpay';
}

export const storedAssistedKey = (a: PharmacyActor, key: string) => `assisted:pharmacy:${lower(a.pharmacyId)}:${lower(a.actorId)}:${key}`;
export const assistedKeyScope = (a: PharmacyActor) => `assisted_consult_create:${lower(a.pharmacyId)}:${lower(a.actorId)}`;
const orgKey = (pharmacyId: string) => `pharmacy:${lower(pharmacyId)}`;

/** §5.1: 8 characters, RFC 4648 base32 (upper case, no padding). */
export function newShortRef(): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  return Array.from(randomBytes(8)).map((b) => ALPHABET[b & 31]).join('');
}

/** The content a request key is bound to (§6.3): the payment method is excluded (Q3). */
export function assistedRequestHash(input: AssistedConsultInput): string {
  return requestHashOf({
    phone: canonicalMobile(input.phone) ?? input.phone,
    patient: patientIdentity(input.patient),
    holderName: input.holderName ? cleanName(input.holderName) : null,
    service: { slotId: lower(input.slotId), mode: input.consultationMode, join: input.join ? { on: input.join.on, phone: input.join.phone ? canonicalMobile(input.join.phone) : null } : null },
    couponCode: input.couponCode ? input.couponCode.trim().toUpperCase() : null,
    preferredLanguage: input.preferredLanguage,
    primaryConcern: input.primaryConcern?.trim() || null,
    notes: input.notes?.trim() || null,
    acceptedPriceMinor: input.acceptedPriceMinor,
  });
}

/**
 * The answer of a create (and of a replay): the booker's own payment screen sees its funding. Phase 1b: a card booking
 * adds `payment` — the open Razorpay order while the booking waits for it, else null — and its funding's
 * `paymentTransactionId`.
 */
export function assistedReceipt(b: IBooking, replayed: boolean, newAccount: boolean, payment?: CardPaymentView | null) {
  const a = b.assisted!;
  const card = a.funding.method === 'razorpay';
  return {
    booking: {
      _id: String(b._id), status: b.status, paymentStatus: b.paymentStatus, bookingDate: b.bookingDate, bookingTime: b.bookingTime,
      slotId: b.slotId, specialistId: b.specialistId, doctorName: b.doctorName, consultationMode: b.consultationMode,
      userId: b.userId, dependentId: b.dependentId ?? null, source: b.source, price: b.price, originalPrice: b.originalPrice,
      updatedAt: b.updatedAt, createdAt: b.createdAt,
      assisted: { shortRef: a.shortRef, preferredLanguage: a.preferredLanguage, join: a.join ? { on: a.join.on } : undefined,
        bookedBy: { name: a.bookedBy.name } },
    },
    funding: { method: a.funding.method, amountMinor: a.funding.amountMinor, state: a.funding.state, walletEntryId: a.funding.walletEntryId ?? null,
      ...(card ? { paymentTransactionId: a.funding.paymentRecordId ?? null } : {}) },
    split: { listMinor: a.split.listMinor, discountMinor: a.split.discountMinor, couponCode: a.split.couponCode ?? null },
    ...(card ? { payment: payment ?? null } : {}),
    newAccount,
    replayed,
  };
}

/** Phase 1b: a receipt of a card booking carries its open order (made again here after a failed order call). */
async function receiptOf(b: IBooking, replayed: boolean, newAccount: boolean) {
  if (b.assisted?.funding?.method !== 'razorpay') return assistedReceipt(b, replayed, newAccount);
  return assistedReceipt(b, replayed, newAccount, await openCardOrder(b));
}

/** Writers rely on these unique indexes (fail closed: 503 INDEXES_OUTDATED until sync-indexes has run). */
export async function assertAssistedIndexes(withCoupon: boolean): Promise<void> {
  await assertUniqueIndex(BookingModel, { 'assisted.requestKey': 1 });
  await assertUniqueIndex(BookingModel, { 'assisted.shortRef': 1 });
  await assertUniqueIndex(PharmacyWalletTransactionModel, { pharmacyId: 1, operationKey: 1 });
  await assertUniqueIndex(RequestKeyModel, { scope: 1, key: 1 });
  if (withCoupon) await assertUniqueIndex(CouponRedemptionModel, { couponCode: 1, bookingKind: 1, bookingId: 1 });
}

function validate(input: AssistedConsultInput): void {
  if (!input.consent || input.consent.agreed !== true) throw err(400, 'CONSENT_REQUIRED', 'Tick "patient agreed" before booking for the patient');
  if (input.paymentMethod !== 'wallet' && input.paymentMethod !== 'razorpay') {
    throw err(400, 'PAYMENT_METHOD_UNAVAILABLE', 'Assisted bookings are paid from the Jansetu wallet for now');
  }
  if (!ASSISTED_KEY.test(String(input.requestKey ?? ''))) throw err(400, 'REQUEST_KEY_REQUIRED', 'requestKey is required');
  if (!LANGUAGE.test(String(input.preferredLanguage ?? ''))) throw err(400, 'VALIDATION_ERROR', 'preferredLanguage must be a language code');
  if (!canonicalMobile(input.phone)) throw err(400, 'INVALID_PHONE', 'Enter a valid 10-digit mobile number');
  if (input.consultationMode === 'in-person') {
    if (input.join) throw err(400, 'VALIDATION_ERROR', 'An in-clinic consultation has no join choice');
  } else if (!input.join) {
    throw err(400, 'VALIDATION_ERROR', 'Choose where the patient joins the consultation');
  }
  if (input.join?.on === 'patient_phone' && input.join.phone && !canonicalMobile(input.join.phone)) {
    throw err(400, 'INVALID_PHONE', 'Enter a valid 10-digit mobile number for the call');
  }
}

/**
 * §6.3 (decisions 11, B, E): coupons are validated against the PATIENT, with the assisted rules on top. r17: shared by
 * the instant create (no doctor yet for "any doctor"; it also needs the coupon itself, to freeze its terms).
 */
export async function assistedCouponFor(code: string | undefined, ctx: { userId: string; dependentId?: string; doctorId?: string; listMinor: number }) {
  if (!code || !(ctx.listMinor > 0)) return null;
  const repo = new CouponRepository();
  const notForAssisted = () => err(400, 'COUPON_NOT_FOR_ASSISTED', 'This coupon cannot be used on a booking made for a patient');
  const fundedByOf = (c: { fundedBy?: string; corporateIds?: string[] }) => c.fundedBy ?? ((c.corporateIds ?? []).length > 0 ? 'platform' : 'provider');
  // Decided on the coupon itself first: E — a per-user-limited coupon is never used on a partner booking (the patient
  // never sees it); N1 — a platform-funded coupon only when an admin allowed it on partner bookings.
  const known = await repo.findByCode(code);
  if (known && (known.usageLimitPerUser || (fundedByOf(known) === 'platform' && known.partnerUsable !== true))) throw notForAssisted();
  // Then the existing rules, against the PATIENT: account, family member and the account's corporate.
  const patient = await UserModel.findById(ctx.userId).select({ corporateId: 1 }).lean() as { corporateId?: string } | null;
  const v = await new CouponService(repo).validateCoupon({ code, userId: ctx.userId, bookingType: 'consultation', bookingId: ctx.doctorId,
    dependentId: ctx.dependentId, ...(patient?.corporateId ? { corporateId: String(patient.corporateId) } : {}), purchaseAmount: ctx.listMinor / 100 });
  if (!v.isValid || !v.coupon) throw err(400, 'INVALID_COUPON', v.message || 'Invalid coupon code');
  const c = v.coupon;
  if (c.usageLimitPerUser || (fundedByOf(c) === 'platform' && c.partnerUsable !== true)) throw notForAssisted();
  const fundedBy = fundedByOf(c);
  const money = normalizeCouponDiscount(ctx.listMinor / 100, v.discountAmount, 'BOOKING_RECONCILIATION_REQUIRED');
  return { code: c.code, fundedBy: fundedBy as 'provider' | 'platform', discountMinor: Math.round(money.discountAmount * 100), totalUsageLimit: c.totalUsageLimit,
    coupon: c };
}

async function replayOf(storedKey: string, hash: string): Promise<IBooking | null> {
  const prior = await BookingModel.findOne({ 'assisted.requestKey': { $eq: storedKey } }).lean() as IBooking | null;
  if (!prior) return null;
  if (prior.assisted?.requestHash !== hash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different booking');
  return prior;
}

export async function createPharmacyConsultation(actor: PharmacyActor, input: AssistedConsultInput, clock: () => Date = () => new Date(), attempt = 0) {
  assertPharmacyAssistedOn();
  validate(input);
  const phone = canonicalMobile(input.phone)!;
  const storedKey = storedAssistedKey(actor, input.requestKey);
  const hash = assistedRequestHash(input);
  await assertAssistedIndexes(!!input.couponCode);
  // Review of 800dfc0 (item 4): the replay of a booking already made under this key with the same content answers its
  // receipt first and is not counted, so a retried request never meets a 429 instead of its receipt. That answer depends
  // only on this booker's own key and content, never on whether the number has an account.
  const replay = await BookingModel.findOne({ 'assisted.requestKey': { $eq: storedKey } }).lean() as IBooking | null;
  if (replay && replay.assisted?.requestHash === hash) return receiptOf(replay, true, !!replay.assisted?.identity?.newAccount);
  // Phase 1b: card/UPI only while ASSISTED_CARD_PAYMENT_ENABLED is on and the gateway has keys (decided before anything
  // is counted or held, the same answer for every number).
  const card = input.paymentMethod === 'razorpay';
  if (card) await assertCardPaymentAvailable();
  // Review 4: every other create names a phone like a lookup does, so it counts against the lookup limit and is audited
  // (a key reused for other content too: it is counted, then refused below).
  if (attempt === 0) {
    await hitLookup(orgKey(actor.pharmacyId));
    const seen = await UserModel.findOne({ phone, userType: 'user' }).select({ _id: 1 }).lean() as { _id: unknown } | null;
    await auditIn({ actorKind: 'pharmacy', actorId: lower(actor.actorId), orgKind: 'pharmacy', orgId: lower(actor.pharmacyId), action: 'booking.attempted',
      requestKey: input.requestKey, detail: { exists: !!seen, ...(seen ? { userId: String(seen._id) } : {}) } }, null);
  }
  const prior = await replayOf(storedKey, hash);
  if (prior) return receiptOf(prior, true, !!prior.assisted?.identity?.newAccount);
  if (await RequestKeyModel.exists({ scope: assistedKeyScope(actor), key: input.requestKey, state: 'abandoned' })) {
    throw err(409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
  }
  // r10g (owner, 23 Nov): no booking limits besides the hourly lookup limit (P7's daily stop, per-phone, new-account and
  // pending-card limits are removed); the cancellation and same-pair alerts remain alerts only.

  // The service: an active, verified doctor's bookable slot in the chosen mode.
  if (!Types.ObjectId.isValid(input.slotId)) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  const slot = await SlotModel.findById(input.slotId).lean() as Record<string, any> | null;
  if (!slot?.specialistId || slot.isActive === false) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  const sp = await SpecialistModel.findById(slot.specialistId).select({ name: 1, consultationFee: 1, isConsultationFree: 1, isActive: 1, isVerified: 1 })
    .lean() as Record<string, any> | null;
  if (!sp || sp.isActive !== true || sp.isVerified !== true) throw err(409, 'DOCTOR_NOT_AVAILABLE', 'This doctor is not taking bookings');
  const until = bookableUntilOf(slot);
  if (!until || until.getTime() <= clock().getTime()) {
    throw err(409, 'SLOT_STARTED', isWindowSlot(slot) ? 'This session has ended; choose a later one' : 'This slot has already started; choose a later one');
  }
  const pharmacy = await PharmacyModel.findById(actor.pharmacyId).select({ name: 1 }).lean() as { name?: string } | null;
  const listMinor = sp.isConsultationFree === true ? 0 : Math.round(Number(sp.consultationFee || 0) * 100);

  // The patient (review 4: no create is an existence test). Every step that can refuse runs BEFORE any account is
  // counted or opened, and gives the same answer for a known and an unknown number; the account of a new number is
  // opened only inside the booking transaction (a refused or failed booking leaves no account behind).
  const pp = await preparePatient({ phone, patient: input.patient, holderName: input.holderName, preferredLanguage: input.preferredLanguage });
  const customer = { _id: pp.userId, created: pp.created };
  const { dependentId, holderTyped } = pp;

  const coupon = await assistedCouponFor(input.couponCode, { userId: customer._id, dependentId, doctorId: String(slot.specialistId), listMinor });
  const discountMinor = coupon?.discountMinor ?? 0;
  const payMinor = listMinor - discountMinor;
  if (input.acceptedPriceMinor !== payMinor) {
    throw err(409, 'PRICE_CHANGED', 'The price changed; check it with the patient and book again', { details: { priceMinor: payMinor, listMinor, discountMinor } });
  }
  // Phase 1b: a card payment needs an amount (Razorpay refuses 0); a free consultation is booked with the wallet method.
  if (card && payMinor <= 0) throw err(400, 'NOTHING_TO_PAY', 'Nothing to pay for this consultation; book it with paymentMethod "wallet"');
  // provider_coupon_v2 (§8.3, P5): coupon first, then the cut (0 in 1a). Provider-funded: the base is what was paid.
  const baseMinor = coupon?.fundedBy === 'platform' ? listMinor : payMinor;
  const now = clock();
  const shortRef = newShortRef();
  const entryId = new Types.ObjectId();
  // Phase 1b: the card booking's one payment record id, stored on the funding before the order exists.
  const paymentRecordId = card ? new Types.ObjectId().toHexString() : undefined;
  const pharmacyId = lower(actor.pharmacyId);
  // Phase 4a (§26.5.3): the pharmacy's referral cut, snapshotted now (0 while the switch is off or no rule applies).
  const cut = await snapshotCuts({ kind: 'pharmacy', id: pharmacyId, name: pharmacy?.name ?? 'Pharmacy' }, [{ category: 'consultation', baseMinor }]);
  const assisted: AssistedBlock = {
    bookedBy: { kind: 'pharmacy', id: pharmacyId, actorKind: 'pharmacy', actorId: lower(actor.actorId), name: pharmacy?.name ?? 'Pharmacy' },
    consent: { method: 'partner_attested', statementVersion: input.consent.statementVersion, statementLanguage: input.consent.statementLanguage,
      at: now, actorId: lower(actor.actorId) },
    preferredLanguage: input.preferredLanguage,
    identity: { attested: true, newAccount: customer.created },
    ...(input.join ? { join: { on: input.join.on, ...(input.join.phone ? { phone: canonicalMobile(input.join.phone)! } : {}), linkVersion: 1 } } : {}),
    funding: card
      ? { method: 'razorpay', payerKind: 'pharmacy', payerId: pharmacyId, amountMinor: payMinor, state: 'pending', paymentRecordId, refunds: [] }
      : { method: 'wallet', payerKind: 'pharmacy', payerId: pharmacyId, amountMinor: payMinor, state: 'captured',
        ...(payMinor > 0 ? { walletEntryId: String(entryId) } : {}), refunds: [] },
    split: { listMinor, ...(coupon ? { couponCode: coupon.code, couponFundedBy: coupon.fundedBy } : {}), discountMinor, baseMinor,
      cutMinor: cut.totalCutMinor, providerMinor: baseMinor - cut.totalCutMinor, rule: 'provider_coupon_v2', ...(cut.lines[0] ? { referral: cut.lines[0] } : {}) },
    referral: cut.referral,
    shortRef,
    requestKey: storedKey,
    requestHash: hash,
  };
  const at = now.toISOString();
  let booking: IBooking;
  try {
    booking = await createBookingWithHolds({
      bookingType: 'consultation', userId: customer._id, ...(dependentId ? { dependentId } : {}), pharmacyId,
      specialistId: String(slot.specialistId), doctorName: sp.name, slotId: String(slot._id), bookingDate: slot.date, bookingTime: slot.startTime,
      consultationMode: input.consultationMode, serviceMode: input.consultationMode, price: payMinor / 100, originalPrice: listMinor / 100,
      // Phase 1b: a card booking holds its seat as pending payment (expired by the existing sweep after 30 minutes).
      status: card ? 'pending' : 'confirmed', paymentStatus: card ? 'pending' : 'paid', contactNo: phone,
      ...(input.primaryConcern?.trim() ? { primaryConcern: input.primaryConcern.trim() } : {}),
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      source: 'pharmacy_assisted', earningRule: 'provider_coupon_v2', assisted,
      lifecycle: card ? { created: { at, by: pharmacyId } }
        : { created: { at, by: pharmacyId }, paid: { at, by: 'pharmacy_wallet', amount: payMinor / 100 }, confirmed: { at } },
    } as IBooking, async (b, s) => {
      await claimRequestKey(assistedKeyScope(actor), input.requestKey, s);
      await writePatientIn(pp, { preferredLanguage: input.preferredLanguage }, s);
      await linkPharmacyCustomerIn(actor, customer._id, holderTyped, s);
      await countPairBookingIn('pharmacy', pharmacyId, lower(slot.specialistId), s);
      if (coupon) await redeemCouponIn(coupon, { bookingKind: 'booking', payerKind: 'pharmacy', bookingId: String(b._id), patientUserId: customer._id, dependentId, payerId: pharmacyId }, s);
      if (payMinor > 0 && !card) {
        await postPharmacyMovementIn({ pharmacyId, kind: 'booking_debit', amountPaise: payMinor, operationKey: `assisted:${lower(b._id)}:debit`,
          referenceType: 'assisted_booking', referenceId: `${lower(b._id)}:debit`, description: 'Assisted consultation booking', entryId }, s);
      }
      await auditIn({ actorKind: 'pharmacy', actorId: lower(actor.actorId), orgKind: 'pharmacy', orgId: pharmacyId, action: 'booking.created',
        bookingId: String(b._id), requestKey: input.requestKey,
        detail: { doctorId: lower(slot.specialistId), slotId: String(slot._id), amountMinor: payMinor, method: card ? 'razorpay' : 'wallet', accountCreated: customer.created,
          ...(dependentId ? { dependentId, dependentCreated: !!pp.newDependent } : {}), ...(coupon ? { couponCode: coupon.code } : {}) } }, s);
    });
  } catch (e) {
    // A racing identical request may have committed first: answer with its receipt.
    const raced = await replayOf(storedKey, hash);
    if (raced) return receiptOf(raced, true, !!raced.assisted?.identity?.newAccount);
    // Another booking or desk opened this number's account meanwhile: book again once, on that account.
    if ((e as { code?: string }).code === 'ACCOUNT_OPENED_MEANWHILE' && attempt === 0) return createPharmacyConsultation(actor, input, clock, 1);
    throw asDoctorUnavailable(e);
  }
  if (isReplayedBooking(booking)) {
    if (booking.assisted?.requestHash !== hash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different booking');
    return receiptOf(booking, true, !!booking.assisted?.identity?.newAccount);
  }
  // Phase 1b: a card booking opens its Razorpay order now; Meet, reminders and the notices follow its confirmation.
  if (card) return assistedReceipt(booking, false, customer.created, await openCardOrder(booking));
  // After the commit, best effort: Meet (neutral text), reminders, notices to the patient, the doctor and the booker.
  const fx = assistedEffects();
  const withMeet = booking.consultationMode === 'in-person' ? booking : await bestEffort('meet', () => fx.meet(booking), booking);
  await bestEffort('reminders', () => fx.reminders(withMeet), undefined);
  await sendAssistedNotices(await bookedNotices(withMeet));
  const fresh = await BookingModel.findById(booking._id).lean() as IBooking | null;
  return assistedReceipt(fresh ?? withMeet, false, customer.created);
}

const shownDate = (d?: string) => (d && /^\d{8}$/.test(d) ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : String(d ?? ''));

/** §6.5: "booked by <partner>", identity attested by the partner. The booker hears nothing about the family. */
export async function bookedNotices(b: IBooking): Promise<AssistedNotice[]> {
  const a = b.assisted!;
  const dep = b.dependentId && Types.ObjectId.isValid(String(b.dependentId))
    ? await DependentModel.findById(b.dependentId).select({ name: 1 }).lean() as { name?: string } | null : null;
  const id = String(b._id);
  const when = `${shownDate(b.bookingDate)} at ${b.bookingTime}`;
  const forWhom = dep?.name ? ` for ${dep.name}` : '';
  const out: AssistedNotice[] = [{
    audience: 'customer', userId: String(b.userId), type: 'booking_confirmed', title: 'Consultation booked',
    message: `${a.bookedBy.name} booked a consultation${forWhom} with ${b.doctorName ?? 'a doctor'} on ${when}. Ref ${a.shortRef}.`,
    bookingId: id, key: `assisted:${id}:booked:customer`, data: { source: b.source, shortRef: a.shortRef },
  }];
  if (b.specialistId) {
    out.push({ audience: 'doctor', userId: String(b.specialistId), type: 'specialist_new_booking', title: 'New consultation',
      message: `A consultation on ${when} was booked by ${a.bookedBy.name}. Identity attested by the partner, not verified.`,
      bookingId: id, key: `assisted:${id}:booked:doctor`, data: { source: b.source } });
  }
  return out;
}
