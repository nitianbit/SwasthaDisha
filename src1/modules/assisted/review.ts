import { unpaidCardBooking } from '@/modules/assisted/views';
import { Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { requestHashOf } from '@/modules/common/utils/canonicalJson';
import { canonicalMobile } from '@/modules/common/utils/phone';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { assertBookingVersion } from '@/modules/bookings/holds';
import BookingModel from '@/modules/bookings/model';
import type { IBooking } from '@/modules/bookings/types';
import DependentModel from '@/modules/dependents/model';
import UserModel from '@/modules/user/model';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { InstantRequestModel } from '@/modules/doctors/model/instant';
import { CouponRedemptionModel } from '@/modules/coupon/model/redemption';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { claimRequestKey } from '@/modules/requestKeys';
import { inTransaction } from '@/modules/partners/services';
import { resolveCustomerByPhone } from '@/modules/partners/services/customerResolver';
import { AssistedAuditEventModel, AssistedReviewItemModel } from '@/modules/assisted/model';
import { assertAdminToolsOn } from '@/modules/assisted/flags';
import { ASSISTED_KEY } from '@/modules/assisted/consultations';
import { assistedEffects, auditIn, bestEffort, sendAssistedNotices } from '@/modules/assisted/support';

/**
 * Assisted booking phase 1a (§17.5, P8): the account holder's "this isn't mine" and the admin's review queue, dismiss
 * and "move booking to another account". Consultations only in 1a (partner-lab bookings get their assisted rows in
 * phase 2; their move and report come with them).
 */
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const notFound = () => err(404, 'BOOKING_NOT_FOUND', 'Booking not found');
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const cleanName = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ');
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** POST /bookings/:id/not-mine — the holder flags an assisted booking; it leaves their lists and is queued for admins. */
export async function reportNotMine(userId: string, bookingId: string, note?: string) {
  assertAdminToolsOn();
  await assertUniqueIndex(AssistedReviewItemModel, { bookingKind: 1, bookingId: 1 });
  if (!/^[0-9a-fA-F]{24}$/.test(String(bookingId))) throw notFound();
  const text = typeof note === 'string' ? note.trim().slice(0, 500) : '';
  const out = await inTransaction(async (s) => {
    const b = await BookingModel.findOne({ _id: bookingId, userId: { $eq: String(userId) } }).session(s).lean() as IBooking | null;
    // r10b: a card-paid booking never confirmed is not the holder's to see (or report).
    if (!b || unpaidCardBooking(b as never)) throw notFound();
    if (!b.assisted) throw err(409, 'NOT_ASSISTED_BOOKING', 'Only a booking made for you by a partner can be reported here');
    if (b.assisted.identity?.disputed) throw err(409, 'ALREADY_REPORTED', 'This booking was already reported');
    const at = new Date();
    const r = await BookingModel.updateOne({ _id: b._id, userId: { $eq: String(userId) }, 'assisted.identity.disputed': { $exists: false } },
      { $set: { 'assisted.identity.disputed': { state: 'open', at } } }, { session: s });
    if (r.modifiedCount !== 1) throw err(409, 'ALREADY_REPORTED', 'This booking was already reported');
    const [item] = await AssistedReviewItemModel.create([{ kind: 'not_mine', bookingKind: 'booking', bookingId: lower(b._id), reportedBy: lower(userId),
      ...(text ? { note: text } : {}), state: 'open', at }], { session: s });
    await auditIn({ actorKind: 'customer', actorId: lower(userId), orgKind: b.assisted.bookedBy.kind, orgId: b.assisted.bookedBy.id, action: 'booking.not_mine',
      bookingId: lower(b._id), detail: { reviewItemId: String(item!._id) } }, s);
    return { booking: b, itemId: String(item!._id) };
  });
  // The booker's "reported as not mine" badge (§6.5); no health details.
  const a = out.booking.assisted!;
  await sendAssistedNotices([{ audience: 'booker', userId: a.bookedBy.id, type: 'general', title: 'Reported as not mine',
    message: `The account holder reported booking Ref ${a.shortRef} as not theirs. The Jansetu team will review it.`, bookingId: String(out.booking._id),
    key: `assisted:${out.booking._id}:not_mine:booker` }]);
  return { reported: true, reviewItemId: out.itemId };
}

/** GET /admin/assisted/review-items?state — the queue with a booking summary (no clinical content). */
export async function listReviewItems(q: { state?: string; limit?: number }) {
  const filter = q.state ? { state: q.state } : {};
  const items = await AssistedReviewItemModel.find(filter).sort({ at: -1 }).limit(Math.min(Math.max(Number(q.limit) || 50, 1), 200)).lean();
  const bookings = await BookingModel.find({ _id: { $in: items.map((i) => i.bookingId).filter((id) => Types.ObjectId.isValid(id)) } })
    .select({ status: 1, bookingDate: 1, bookingTime: 1, userId: 1, dependentId: 1, doctorName: 1, 'assisted.shortRef': 1, 'assisted.bookedBy': 1,
      'assisted.identity': 1, updatedAt: 1 }).lean() as unknown as IBooking[];
  const byId = new Map(bookings.map((b) => [lower(b._id), b]));
  return items.map((i) => {
    const b = byId.get(lower(i.bookingId));
    return { ...i, booking: b ? { _id: String(b._id), status: b.status, bookingDate: b.bookingDate, bookingTime: b.bookingTime, userId: b.userId,
      dependentId: b.dependentId ?? null, doctorName: b.doctorName, shortRef: b.assisted?.shortRef, bookedBy: b.assisted?.bookedBy
        ? { kind: b.assisted.bookedBy.kind, id: b.assisted.bookedBy.id, name: b.assisted.bookedBy.name } : null,
      disputed: b.assisted?.identity?.disputed ?? null, updatedAt: b.updatedAt } : null };
  });
}

/** POST /admin/assisted/review-items/:id/dismiss — not moved: the booking shows in the holder's lists again. */
export async function dismissReviewItem(adminId: string, itemId: string, reason?: string) {
  assertAdminToolsOn();
  if (!/^[0-9a-fA-F]{24}$/.test(String(itemId))) throw err(404, 'REVIEW_ITEM_NOT_FOUND', 'Review item not found');
  return inTransaction(async (s) => {
    const at = new Date();
    const item = await AssistedReviewItemModel.findOneAndUpdate({ _id: itemId, state: 'open' },
      { $set: { state: 'dismissed', resolvedAt: at, resolvedBy: lower(adminId), ...(reason ? { resolution: String(reason).slice(0, 500) } : {}) } },
      { new: true, session: s }).lean();
    if (!item) {
      const exists = await AssistedReviewItemModel.exists({ _id: itemId }).session(s);
      throw exists ? err(409, 'REVIEW_ITEM_CLOSED', 'This item was already resolved') : err(404, 'REVIEW_ITEM_NOT_FOUND', 'Review item not found');
    }
    await BookingModel.updateOne({ _id: item.bookingId, 'assisted.identity.disputed.state': 'open' },
      { $set: { 'assisted.identity.disputed.state': 'dismissed', 'assisted.identity.disputed.resolvedAt': at } }, { session: s });
    const b = await BookingModel.findById(item.bookingId).select({ 'assisted.bookedBy': 1 }).session(s).lean() as IBooking | null;
    await auditIn({ actorKind: 'admin', actorId: lower(adminId), orgKind: b?.assisted?.bookedBy.kind ?? 'pharmacy', orgId: b?.assisted?.bookedBy.id ?? '-',
      action: 'review.dismissed', bookingId: item.bookingId, detail: { reviewItemId: String(item._id) } }, s);
    return item;
  });
}

export interface MoveInput {
  toPhone: string;
  asFamily?: { name: string; relation: string; gender?: 'Male' | 'Female' | 'Other'; dateOfBirth?: string };
  /** §17.4: the typed name for the target account holder on the booker's link (default: the booker's old typed name). */
  holderName?: string;
  reason: string;
  requestKey: string;
  expectedUpdatedAt?: string | Date;
}

const moveHash = (input: MoveInput) => requestHashOf({ toPhone: canonicalMobile(input.toPhone) ?? input.toPhone,
  asFamily: input.asFamily ? { name: cleanName(input.asFamily.name), relation: input.asFamily.relation, gender: input.asFamily.gender ?? null,
    dateOfBirth: input.asFamily.dateOfBirth ?? null } : null, holderName: input.holderName ? cleanName(input.holderName) : null, reason: String(input.reason ?? '').trim() });

/**
 * POST /admin/assisted-bookings/:id/move — moves an assisted booking (completed ones too) to the right account, in one
 * transaction: patient, the booker's link (target ensured; the old one removed when nothing else of this booker uses it),
 * the coupon redemption, `disputed: moved`, a new join link version, the audit. The old holder loses access at once
 * (every customer read checks `userId`). Exactly once per (admin, request key) with a content hash.
 */
export async function moveAssistedBooking(admin: { _id: string }, bookingId: string, input: MoveInput) {
  assertAdminToolsOn();
  if (!ASSISTED_KEY.test(String(input.requestKey ?? ''))) throw err(400, 'REQUEST_KEY_REQUIRED', 'requestKey is required');
  const toPhone = canonicalMobile(input.toPhone);
  if (!toPhone) throw err(400, 'INVALID_PHONE', 'Enter a valid 10-digit mobile number');
  if (!String(input.reason ?? '').trim()) throw err(400, 'VALIDATION_ERROR', 'A reason is required');
  await assertUniqueIndex(RequestKeyModel, { scope: 1, key: 1 });
  if (!/^[0-9a-fA-F]{24}$/.test(String(bookingId))) throw notFound();
  const hash = moveHash(input);
  const adminId = lower(admin._id);
  const replay = (b: IBooking) => {
    const prior = (b.assisted?.moves ?? []).find((m) => m.requestKey === `${adminId}:${input.requestKey}`);
    if (!prior) return null;
    if ((prior as { requestHash?: string }).requestHash !== hash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different move');
    return b;
  };
  const b0 = await BookingModel.findById(bookingId).lean() as IBooking | null;
  if (!b0) throw notFound();
  if (!b0.assisted) throw err(409, 'NOT_ASSISTED_BOOKING', 'Only partner-made bookings are moved with this tool');
  const prior = replay(b0);
  if (prior) return { booking: moveView(prior), replayed: true };
  if (await RequestKeyModel.exists({ scope: `assisted_move:${adminId}`, key: input.requestKey, state: 'abandoned' })) {
    throw err(409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
  }
  const target = await resolveCustomerByPhone(toPhone, 'assisted_booking');
  if (target._id === lower(b0.userId) && !input.asFamily) throw err(409, 'SAME_ACCOUNT', 'The booking is already on this account');
  let dependentId: string | undefined;
  let newDependent: Record<string, unknown> | undefined;
  if (input.asFamily) {
    const name = cleanName(input.asFamily.name);
    const same = await DependentModel.findOne({ userId: target._id, isActive: true, relationship: input.asFamily.relation,
      name: { $regex: `^${escapeRx(name)}$`, $options: 'i' } }).select({ _id: 1 }).lean() as { _id: unknown } | null;
    if (same) dependentId = String(same._id);
    else {
      dependentId = new Types.ObjectId().toHexString();
      newDependent = { _id: dependentId, userId: target._id, name, relationship: input.asFamily.relation, isActive: true,
        ...(b0.assisted.preferredLanguage ? { preferredLanguage: b0.assisted.preferredLanguage } : {}),
        ...(input.asFamily.gender ? { gender: input.asFamily.gender } : {}),
        ...(input.asFamily.dateOfBirth ? { dateOfBirth: input.asFamily.dateOfBirth.replace(/-/g, '') } : {}) };
    }
  }
  if (target.created) {
    const holder = cleanName(input.holderName);
    if (holder) await UserModel.updateOne({ _id: target._id, $or: [{ name: { $exists: false } }, { name: null }, { name: '' }] }, { $set: { name: holder } });
  }
  let moved: IBooking;
  try {
    moved = await inTransaction(async (s) => {
      const b = await BookingModel.findById(bookingId).session(s).lean() as IBooking | null;
      if (!b?.assisted) throw notFound();
      const again = replay(b);
      if (again) return again;
      assertBookingVersion(b, input.expectedUpdatedAt ?? null);
      await claimRequestKey(`assisted_move:${adminId}`, input.requestKey, s);
      if (newDependent) await DependentModel.create([newDependent], { session: s });
      const fromUserId = lower(b.userId);
      const at = new Date();
      const a = b.assisted;
      const set: Record<string, unknown> = { userId: target._id, contactNo: toPhone, 'assisted.identity.disputed': { state: 'moved',
        at: a.identity?.disputed?.at ?? at, resolvedAt: at } };
      const unset: Record<string, 1> = {};
      if (dependentId) set.dependentId = dependentId; else unset.dependentId = 1;
      const r = await BookingModel.updateOne({ _id: b._id, userId: b.userId, updatedAt: b.updatedAt }, {
        $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}),
        // §17.5: an account move kills the old holder's join link.
        ...(a.join ? { $inc: { 'assisted.join.linkVersion': 1 } } : {}),
        $push: { 'assisted.moves': { at, by: adminId, fromUserId, toUserId: target._id, requestKey: `${adminId}:${input.requestKey}`, requestHash: hash } },
      }, { session: s });
      if (r.modifiedCount !== 1) throw Object.assign(err(409, 'BOOKING_CHANGED', 'The booking changed; reload and try again'), { retryable: true });
      // Review: what hangs off the booking follows it — medicine orders made from its prescription (customer, so the
      // order's copy binding and the order itself are readable only by the new holder), and a family member this
      // booking created on the old account (deactivated when nothing else uses it).
      const ordersMoved = fromUserId !== target._id && Types.ObjectId.isValid(fromUserId)
        ? (await PharmacyOrderModel.updateMany({ 'prescriptionFromBooking.bookingId': { $in: [lower(b._id), String(b._id)] },
          customerId: new Types.ObjectId(fromUserId) }, { $set: { customerId: new Types.ObjectId(target._id) } }, { session: s })).modifiedCount : 0;
      const familyDeactivated = b.dependentId && lower(b.dependentId) !== lower(dependentId)
        ? await deactivateBookingDependentIn(String(b._id), lower(b.dependentId), s) : false;
      if (a.bookedBy.kind === 'pharmacy') await moveBookerLinkIn(a.bookedBy.id, String(b._id), fromUserId, target._id, cleanName(input.holderName), s);
      await CouponRedemptionModel.updateMany({ bookingKind: 'booking', bookingId: lower(b._id) },
        dependentId ? { $set: { patientUserId: target._id, dependentId } } : { $set: { patientUserId: target._id }, $unset: { dependentId: 1 } }, { session: s });
      await AssistedReviewItemModel.updateOne({ bookingKind: 'booking', bookingId: lower(b._id), state: 'open' },
        { $set: { state: 'moved', resolvedAt: at, resolvedBy: adminId, resolution: String(input.reason).trim().slice(0, 500) } }, { session: s });
      await auditIn({ actorKind: 'admin', actorId: adminId, orgKind: a.bookedBy.kind, orgId: a.bookedBy.id, action: 'booking.moved', bookingId: lower(b._id),
        requestKey: input.requestKey, detail: { fromUserId, toUserId: target._id, ...(dependentId ? { dependentId, dependentCreated: !!newDependent } : {}),
          ordersMoved, familyDeactivated,
          reason: String(input.reason).trim().slice(0, 500) } }, s);
      return { ...(await BookingModel.findById(b._id).session(s).lean() as IBooking), __fromUserId: fromUserId } as IBooking;
    });
  } catch (e) {
    const raced = await BookingModel.findById(bookingId).lean() as IBooking | null;
    const again = raced ? replay(raced) : null;
    if (!again) throw e;
    return { booking: moveView(again), replayed: true };
  }
  const fromUserId = (moved as IBooking & { __fromUserId?: string }).__fromUserId;
  if (!fromUserId) return { booking: moveView(moved), replayed: true };
  // After the commit: reminders follow the new holder; in-app notices to the old holder, the new holder and the booker
  // (no health details). SMS waits for phase 5.
  const fx = assistedEffects();
  await bestEffort('reminders', async () => { await fx.clearReminders(String(moved._id)); if (moved.status === 'confirmed') await fx.reminders(moved); }, undefined);
  const id = String(moved._id);
  const ref = moved.assisted!.shortRef;
  // r10d: a card booking never paid was never the holders' (they cannot see it): only the booker is told of its move.
  const holdersSee = !unpaidCardBooking(moved as never);
  await sendAssistedNotices([
    ...(!holdersSee ? [] : [
    { audience: 'customer' as const, userId: fromUserId, type: 'general' as const, title: 'A booking was moved off your account',
      message: `Booking Ref ${ref} was moved to the right account after a review.`, bookingId: id, key: `assisted:${id}:moved_off:${fromUserId}` },
    { audience: 'customer' as const, userId: target._id, type: 'general' as const, title: 'A booking was added to your account',
      message: `Booking Ref ${ref} made by ${moved.assisted!.bookedBy.name} is now on your account.`, bookingId: id, key: `assisted:${id}:moved_to:${target._id}` }]),
    { audience: 'booker', userId: moved.assisted!.bookedBy.id, type: 'general', title: 'Booking moved to another account',
      message: `Booking Ref ${ref} was moved to the correct patient account by the Jansetu team.`, bookingId: id, key: `assisted:${id}:moved:booker:${input.requestKey}` },
  ]);
  const { __fromUserId: _f, ...clean } = moved as IBooking & { __fromUserId?: string };
  return { booking: moveView(clean as IBooking), replayed: false };
}

/** The booker's link follows the booking: the target link is ensured; the old one goes when nothing else of this pharmacy uses it. */
async function moveBookerLinkIn(pharmacyId: string, bookingId: string, fromUserId: string, toUserId: string, holderName: string, s: import('mongoose').ClientSession) {
  if (!Types.ObjectId.isValid(pharmacyId)) return;
  const pid = new Types.ObjectId(pharmacyId);
  const old = await PharmacyCustomerModel.findOne({ pharmacyId: pid, userId: new Types.ObjectId(fromUserId) }).session(s).lean() as Record<string, any> | null;
  const existing = await PharmacyCustomerModel.findOne({ pharmacyId: pid, userId: new Types.ObjectId(toUserId) }).session(s).lean() as Record<string, any> | null;
  const typedName = holderName || (old?.typedName as string | undefined) || '';
  if (!existing) {
    await PharmacyCustomerModel.create([{ pharmacyId: pid, userId: new Types.ObjectId(toUserId), createdByRole: 'admin', consent: 'patient_agreed',
      consentRecordedAt: new Date(), consentRecordedById: 'admin_move', ...(typedName ? { typedName } : {}) }], { session: s });
  } else if (typedName && !(typeof existing.typedName === 'string' && existing.typedName.trim())) {
    await PharmacyCustomerModel.updateOne({ _id: existing._id }, { $set: { typedName } }, { session: s });
  }
  // Review: a move within one account (to a family member of the same holder) keeps the link.
  if (!old || fromUserId === toUserId) return;
  const otherBooking = await BookingModel.exists({ _id: { $ne: bookingId }, pharmacyId: { $eq: pharmacyId }, userId: { $eq: fromUserId } }).session(s);
  const order = await PharmacyOrderModel.exists({ pharmacyId: pid, customerId: new Types.ObjectId(fromUserId) }).session(s);
  if (!otherBooking && !order) await PharmacyCustomerModel.deleteOne({ _id: old._id }, { session: s });
}

/**
 * The family member this booking created (audited at create or at an earlier move), deactivated on the old account when
 * no other booking, lab booking or instant request names it (pharmacy orders carry no family member). A family member that existed before the booking is never touched.
 */
async function deactivateBookingDependentIn(bookingId: string, dependentId: string, s: import('mongoose').ClientSession): Promise<boolean> {
  if (!Types.ObjectId.isValid(dependentId)) return false;
  const created = await AssistedAuditEventModel.exists({ bookingId: { $in: [lower(bookingId), bookingId] }, action: { $in: ['booking.created', 'booking.moved'] },
    'detail.dependentId': dependentId, 'detail.dependentCreated': true }).session(s);
  if (!created) return false;
  // Pharmacy orders carry no family member; other bookings, partner-lab bookings and instant requests may.
  const spellings = [dependentId, dependentId.toUpperCase()];
  const used = await BookingModel.exists({ _id: { $ne: bookingId }, dependentId: { $in: spellings } }).session(s)
    || await PartnerLabBookingModel.exists({ 'patient.dependentId': { $in: spellings } }).session(s)
    || await InstantRequestModel.exists({ 'patient.dependentId': { $in: spellings } }).session(s);
  if (used) return false;
  const r = await DependentModel.updateOne({ _id: dependentId, isActive: true }, { $set: { isActive: false } }, { session: s });
  return r.modifiedCount === 1;
}

function moveView(b: IBooking) {
  return { _id: String(b._id), userId: b.userId, dependentId: b.dependentId ?? null, status: b.status, bookingDate: b.bookingDate, bookingTime: b.bookingTime,
    shortRef: b.assisted?.shortRef, disputed: b.assisted?.identity?.disputed ?? null, updatedAt: b.updatedAt };
}
