import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { canonicalMobile } from '@/modules/common/utils/phone';
import UserModel from '@/modules/user/model';
import DependentModel from '@/modules/dependents/model';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import { CouponModel } from '@/modules/coupon/model';
import { CouponRedemptionModel } from '@/modules/coupon/model/redemption';
import { customerPhoneIndexReady } from '@/modules/partners/services/customerResolver';
import type { PharmacyActor } from '@/modules/assisted/consultations';

/**
 * r11 (§24.3): the patient steps every assisted create shares — the family member of the phone's account, the account
 * of a new number (opened only in the booking transaction), the pharmacy-customer link with consent and the typed name,
 * and the coupon redemption row.
 *
 * r17: r10g is merged, so the 1a consultation create now uses these helpers (its private copies are gone), and the
 * patient plan (`planAssistedPatient` / `applyPatientPlanIn`) is shared by the consultation and the instant create. The
 * 2a lab create still has its own copy of the plan; unify it once 3b/3d (which edit that file) are merged.
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

/** The patient of an assisted create, decided before anything is counted, held or opened (§6.2). */
export interface PatientPlan {
  phone: string;
  /** The account the booking is for: the existing one, or the id a new one gets in the booking transaction. */
  customer: { _id: string; created: boolean };
  existingId: string | null;
  newUserId: string | null;
  /** The name the booker typed for the account holder (the link's `typedName`; a new account's name). */
  holderTyped: string;
  dependentId?: string;
  /** A family member to create in the booking transaction (none with this name and relation yet). */
  newDependent?: Record<string, unknown>;
  /** The patient's name as typed, or as the family member is named — never the account name (§25.3 names rule). */
  patientName: string;
}

/**
 * Review 4 (§6.2): every patient step that can refuse, BEFORE any account is counted or opened, with the same answer
 * for a known and an unknown number. A family member named by id must belong to this phone's account; one typed with a
 * name and relation is reused when an active one matches, otherwise created in the transaction.
 */
export async function planAssistedPatient(input: { phone: string; patient: AssistedPatientInput; holderName?: string; preferredLanguage: string }): Promise<PatientPlan> {
  if (!(await customerPhoneIndexReady())) throw err(503, 'CUSTOMER_LINKING_UNAVAILABLE', 'Customer linking is not available yet; try again later');
  const p = input.patient;
  const known = 'dependentId' in p ? await assertDependentOfPhone(String(p.dependentId), input.phone) : null;
  const existing = await UserModel.findOne({ phone: input.phone, userType: 'user' }).select({ _id: 1 }).lean() as { _id: unknown } | null;
  const newUserId = existing ? null : new Types.ObjectId().toHexString();
  const base = {
    phone: input.phone, customer: { _id: existing ? String(existing._id) : newUserId!, created: !existing },
    existingId: existing ? String(existing._id) : null, newUserId,
    holderTyped: 'dependentId' in p ? cleanName(input.holderName) : p.relation === 'self' ? cleanName(p.name) : cleanName(input.holderName),
  };
  if ('dependentId' in p) return { ...base, dependentId: lower(p.dependentId), patientName: known!.name };
  const name = cleanName(p.name);
  if (p.relation === 'self') return { ...base, patientName: name };
  const same = existing ? await DependentModel.findOne({ userId: base.customer._id, isActive: true, relationship: p.relation,
    name: { $regex: `^${escapeRx(name)}$`, $options: 'i' } }).select({ _id: 1 }).lean() as { _id: unknown } | null : null;
  if (same) return { ...base, dependentId: String(same._id), patientName: name };
  const dependentId = new Types.ObjectId().toHexString();
  const q = p as { gender?: string; dateOfBirth?: string };
  return { ...base, dependentId, patientName: name, newDependent: { _id: dependentId, userId: base.customer._id, name, relationship: p.relation, isActive: true,
    preferredLanguage: input.preferredLanguage, ...(q.gender ? { gender: q.gender } : {}), ...(q.dateOfBirth ? { dateOfBirth: q.dateOfBirth.replace(/-/g, '') } : {}) } };
}

/** In the booking transaction: the account (a new number's is opened here), and the family member created or re-checked. */
export async function applyPatientPlanIn(plan: PatientPlan, preferredLanguage: string, s: ClientSession): Promise<void> {
  await openOrPrepareAccountIn({ phone: plan.phone, newUserId: plan.newUserId, existingId: plan.existingId, holderTyped: plan.holderTyped, preferredLanguage }, s);
  if (plan.newDependent) await DependentModel.create([plan.newDependent], { session: s });
  else if (plan.dependentId && !(await DependentModel.exists({ _id: plan.dependentId, userId: plan.customer._id, isActive: true }).session(s))) {
    throw err(404, 'DEPENDENT_NOT_FOUND', 'Family member not found');
  }
}

/**
 * In the booking transaction: a new number's account is inserted (typed name, language, never signed in); an existing
 * account only gets an empty `preferredLanguage` filled. A number whose account appeared meanwhile aborts with
 * ACCOUNT_OPENED_MEANWHILE (the caller books again on it). Owner, 23 Nov: no new-account cap on lab bookings.
 */
export async function openOrPrepareAccountIn(a: { phone: string; newUserId: string | null; existingId: string | null; holderTyped: string;
  preferredLanguage: string }, s: ClientSession): Promise<void> {
  if (a.existingId) {
    await UserModel.updateOne({ _id: a.existingId, $or: [{ preferredLanguage: { $exists: false } }, { preferredLanguage: null }, { preferredLanguage: '' }] },
      { $set: { preferredLanguage: a.preferredLanguage } }, { session: s });
    return;
  }
  if (await UserModel.exists({ phone: a.phone, userType: 'user' }).session(s)) throw err(409, 'ACCOUNT_OPENED_MEANWHILE', 'Please try again');
  await UserModel.create([{ _id: a.newUserId, phone: a.phone, userType: 'user', createdSource: 'assisted_booking', otpVerified: false,
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

/** §5.7: the redemption row and the guarded total count, in the booking transaction (r11: any booking and payer kind). */
export async function redeemCouponIn(c: { code: string; discountMinor: number },
  ctx: { bookingKind: 'booking' | 'lab_booking' | 'instant_request'; payerKind: 'pharmacy' | 'lab' | 'doctor'; bookingId: string; patientUserId: string; dependentId?: string; payerId: string },
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
