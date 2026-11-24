import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { canonicalMobile } from '@/modules/common/utils/phone';
import UserModel from '@/modules/user/model';
import DependentModel from '@/modules/dependents/model';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import { CouponModel } from '@/modules/coupon/model';
import { CouponRedemptionModel } from '@/modules/coupon/model/redemption';
import type { PharmacyActor } from '@/modules/assisted/consultations';
import { customerPhoneIndexReady } from '@/modules/partners/services/customerResolver';
import { hitLookup } from '@/modules/assisted/limits';
import { AssistedLinkModel } from '@/modules/assisted/model/links';

/**
 * r11 (§24.3): the patient steps an assisted lab booking shares with the 1a consultation create — the family member of
 * the phone's account, the account of a new number (opened only in the booking transaction), the pharmacy-customer
 * link with consent and the typed name, and the coupon redemption row.
 *
 * ASSUMED (r11 build): §24.3 asks to MOVE these helpers out of `consultations.ts`. They are copied here instead, because
 * another branch (r10g) is removing the booking limits inside those very functions; moving them now would collide. The
 * lab copies already follow the owner's 23 Nov answer (no new-account cap). Unify the two after r10g is merged.
 */
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const lower = (v: unknown) => String(v ?? '').toLowerCase();
export const cleanName = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ');
export const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type AssistedPatientInput =
  | { relation: 'self'; name: string }
  | { dependentId: string }
  | { relation: string; name: string; gender?: 'Male' | 'Female' | 'Other'; dateOfBirth?: string };

/** The patient part of a request hash (the same shape the 1a hash uses). */
export function patientIdentity(p: AssistedPatientInput) {
  if ('dependentId' in p) return { dependentId: lower(p.dependentId) };
  return { relation: p.relation, name: cleanName(p.name), gender: (p as { gender?: string }).gender ?? null,
    dateOfBirth: (p as { dateOfBirth?: string }).dateOfBirth ?? null };
}

/** A family member named by id must belong to the account of this phone (checked before any account is created). */
export async function assertDependentOfPhone(dependentId: string, phone: string): Promise<{ name: string }> {
  const notFound = () => err(404, 'DEPENDENT_NOT_FOUND', 'Family member not found');
  if (!Types.ObjectId.isValid(dependentId)) throw notFound();
  const dep = await DependentModel.findOne({ _id: dependentId, isActive: true }).select({ userId: 1, name: 1 }).lean() as { userId?: string; name?: string } | null;
  if (!dep?.userId || !Types.ObjectId.isValid(String(dep.userId))) throw notFound();
  const u = await UserModel.findOne({ _id: dep.userId, userType: 'user' }).select({ phone: 1 }).lean() as { phone?: string } | null;
  if (!u?.phone || canonicalMobile(u.phone) !== canonicalMobile(phone)) throw notFound();
  return { name: cleanName(dep.name) };
}

/**
 * In the booking transaction: a new number's account is inserted (typed name, language, never signed in); an existing
 * account only gets an empty `preferredLanguage` filled. A number whose account appeared meanwhile aborts with
 * ACCOUNT_OPENED_MEANWHILE (the caller books again on it). Owner, 23 Nov: no new-account cap on lab bookings.
 */
export async function openOrPrepareAccountIn(a: { phone: string; newUserId: string | null; existingId: string | null; holderTyped: string;
  preferredLanguage: string; /** r12: the lab desk opens accounts as `lab_desk`. */ createdSource?: 'assisted_booking' | 'lab_desk' }, s: ClientSession): Promise<void> {
  if (a.existingId) {
    await UserModel.updateOne({ _id: a.existingId, $or: [{ preferredLanguage: { $exists: false } }, { preferredLanguage: null }, { preferredLanguage: '' }] },
      { $set: { preferredLanguage: a.preferredLanguage } }, { session: s });
    return;
  }
  if (await UserModel.exists({ phone: a.phone, userType: 'user' }).session(s)) throw err(409, 'ACCOUNT_OPENED_MEANWHILE', 'Please try again');
  await UserModel.create([{ _id: a.newUserId, phone: a.phone, userType: 'user', createdSource: a.createdSource ?? 'assisted_booking', otpVerified: false,
    ...(a.holderTyped ? { name: a.holderTyped } : {}), preferredLanguage: a.preferredLanguage }], { session: s });
}

/** §17.4 / S3: the pharmacy's link to the account holder, with consent and the first typed name. */
export async function linkPharmacyCustomerIn(actor: PharmacyActor, userId: string, typedName: string, s: ClientSession): Promise<void> {
  const pid = new Types.ObjectId(actor.pharmacyId);
  const uid = new Types.ObjectId(userId);
  const link = await PharmacyCustomerModel.findOne({ pharmacyId: pid, userId: uid }).session(s).lean() as Record<string, any> | null;
  const consent = { consent: 'patient_agreed', consentRecordedAt: new Date(), consentRecordedById: lower(actor.actorId) };
  if (!link) {
    await PharmacyCustomerModel.create([{ pharmacyId: pid, userId: uid, createdByRole: 'pharmacy', ...consent, ...(typedName ? { typedName } : {}) }], { session: s });
    return;
  }
  const set: Record<string, unknown> = {};
  // A link the customer made by ordering (`customer_order`) keeps that record: the pharmacy's tick never replaces it.
  if (link.consent !== 'patient_agreed' && link.consent !== 'customer_order') Object.assign(set, consent);
  if (typedName && !(typeof link.typedName === 'string' && link.typedName.trim())) set.typedName = typedName;
  if (Object.keys(set).length) await PharmacyCustomerModel.updateOne({ _id: link._id }, { $set: set }, { session: s });
}

/**
 * r12 (§17.4 for labs): the lab's link to the account holder, with consent and the FIRST typed name (never overwritten).
 * An upsert: concurrent first bookings of one patient conflict inside their transactions and are retried, never duplicated.
 */
export async function linkLabIn(l: { partnerId: string; userId: string; typedName: string; recordedById: string; at: Date }, s: ClientSession): Promise<void> {
  const key = { bookerKind: 'lab' as const, bookerId: lower(l.partnerId), userId: lower(l.userId) };
  await AssistedLinkModel.updateOne(key, { $setOnInsert: { ...key, consent: 'patient_agreed', consentRecordedAt: l.at, consentRecordedById: l.recordedById,
    ...(l.typedName ? { typedName: l.typedName } : {}) } }, { upsert: true, session: s });
  if (l.typedName) {
    await AssistedLinkModel.updateOne({ ...key, $or: [{ typedName: { $exists: false } }, { typedName: null }, { typedName: '' }] },
      { $set: { typedName: l.typedName } }, { session: s });
  }
}

/** §5.7: the redemption row and the guarded total count, in the booking transaction (r11: any booking and payer kind). */
export async function redeemCouponIn(c: { code: string; discountMinor: number },
  ctx: { bookingKind: 'booking' | 'lab_booking'; payerKind: 'pharmacy' | 'lab' | 'doctor'; bookingId: string; patientUserId: string; dependentId?: string; payerId: string },
  s: ClientSession): Promise<void> {
  const r = await CouponModel.updateOne({ code: c.code, isActive: true,
    $or: [{ totalUsageLimit: { $exists: false } }, { totalUsageLimit: null }, { $expr: { $lt: ['$currentUsageCount', '$totalUsageLimit'] } }] },
  { $inc: { currentUsageCount: 1 } }, { session: s });
  if (r.modifiedCount !== 1) throw err(409, 'COUPON_EXHAUSTED', 'This coupon has been fully used');
  await CouponRedemptionModel.create([{ couponCode: c.code, patientUserId: ctx.patientUserId, ...(ctx.dependentId ? { dependentId: ctx.dependentId } : {}),
    bookingKind: ctx.bookingKind, bookingId: lower(ctx.bookingId), payerKind: ctx.payerKind, payerId: ctx.payerId, discountMinor: c.discountMinor,
    state: 'counted', at: new Date() }], { session: s });
}

/**
 * D4: a discount spread over lines in proportion to their prices, in whole paise, the remainder going to the largest
 * fractional parts (earlier line first on a tie). Σ result = discount (when Σ prices > 0).
 */
export function spreadByPrice(prices: number[], discount: number): number[] {
  const total = prices.reduce((a, p) => a + p, 0);
  if (!(total > 0) || !(discount > 0)) return prices.map(() => 0);
  const exact = prices.map((p) => (discount * p) / total);
  const out = exact.map((x) => Math.floor(x));
  let left = discount - out.reduce((a, x) => a + x, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) { if (left <= 0) break; out[o.i]! += 1; left -= 1; }
  return out;
}

/**
 * r12: the patient of an assisted or desk booking, prepared BEFORE the transaction (review 4 of 1a: every refusable step
 * runs before any account is opened and answers the same for a known and an unknown number). A family member named by
 * id must belong to the phone's account; one named by relation and name reuses an active one with the same name and
 * relation, else is created in the transaction with a pre-chosen id. Shared by the pharmacy lab create (2a) and the
 * lab desk (2c).
 */
export interface PreparedPatient {
  phone: string;
  /** The account the booking is for: the existing one, or the id a new one opens with. */
  userId: string;
  existingId: string | null;
  newUserId: string | null;
  created: boolean;
  /** The account holder's name as the partner typed it (the link's typed name; a new account's name). */
  holderTyped: string;
  dependentId?: string;
  newDependent?: Record<string, unknown>;
  /** The family member's or the typed self name (a family member chosen by id: their own name, `chosenById`). */
  patientName: string;
  chosenById: boolean;
}

export async function preparePatient(input: { phone: string; patient: AssistedPatientInput; holderName?: string; preferredLanguage: string }): Promise<PreparedPatient> {
  if (!(await customerPhoneIndexReady())) throw err(503, 'CUSTOMER_LINKING_UNAVAILABLE', 'Customer linking is not available yet; try again later');
  const phone = input.phone;
  const p = input.patient;
  const known = 'dependentId' in p ? await assertDependentOfPhone(String(p.dependentId), phone) : null;
  const existing = await UserModel.findOne({ phone, userType: 'user' }).select({ _id: 1 }).lean() as { _id: unknown } | null;
  const newUserId = existing ? null : new Types.ObjectId().toHexString();
  const userId = existing ? String(existing._id) : newUserId!;
  const holderTyped = 'dependentId' in p ? cleanName(input.holderName) : p.relation === 'self' ? cleanName(p.name) : cleanName(input.holderName);
  const out: PreparedPatient = { phone, userId, existingId: existing ? String(existing._id) : null, newUserId, created: !existing, holderTyped,
    patientName: '', chosenById: !!known };
  if ('dependentId' in p) { out.dependentId = lower(p.dependentId); out.patientName = known!.name; return out; }
  out.patientName = cleanName(p.name);
  if (p.relation === 'self') return out;
  const same = existing ? await DependentModel.findOne({ userId, isActive: true, relationship: p.relation,
    name: { $regex: `^${escapeRx(out.patientName)}$`, $options: 'i' } }).select({ _id: 1 }).lean() as { _id: unknown } | null : null;
  if (same) { out.dependentId = String(same._id); return out; }
  out.dependentId = new Types.ObjectId().toHexString();
  const q = p as { gender?: string; dateOfBirth?: string };
  out.newDependent = { _id: out.dependentId, userId, name: out.patientName, relationship: p.relation, isActive: true,
    preferredLanguage: input.preferredLanguage, ...(q.gender ? { gender: q.gender } : {}), ...(q.dateOfBirth ? { dateOfBirth: q.dateOfBirth.replace(/-/g, '') } : {}) };
  return out;
}

/** In the booking transaction: the account of a new number (or the language of an existing one), then the family member. */
export async function writePatientIn(pp: PreparedPatient, opts: { preferredLanguage: string; createdSource?: 'assisted_booking' | 'lab_desk' }, s: ClientSession): Promise<void> {
  await openOrPrepareAccountIn({ phone: pp.phone, newUserId: pp.newUserId, existingId: pp.existingId, holderTyped: pp.holderTyped,
    preferredLanguage: opts.preferredLanguage, createdSource: opts.createdSource }, s);
  if (pp.newDependent) await DependentModel.create([pp.newDependent], { session: s });
  else if (pp.dependentId && !(await DependentModel.exists({ _id: pp.dependentId, userId: pp.userId, isActive: true }).session(s))) {
    throw err(404, 'DEPENDENT_NOT_FOUND', 'Family member not found');
  }
}

/**
 * Every lookup, and every create that is not a same-content replay, names a phone: it counts against the organisation's
 * hourly lookup limit (the one limit the owner kept) and is audited by the caller with ids only. Returns the account.
 */
export async function countPhoneUse(orgKey: string, phone: string, audit: (seen: { exists: boolean; userId?: string }) => Promise<void>)
  : Promise<{ _id: unknown; name?: string } | null> {
  await hitLookup(orgKey);
  const user = await UserModel.findOne({ phone, userType: 'user' }).select({ _id: 1, name: 1 }).lean() as { _id: unknown; name?: string } | null;
  await audit({ exists: !!user, ...(user ? { userId: String(user._id) } : {}) });
  return user;
}
