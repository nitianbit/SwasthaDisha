import { Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { requestHashOf } from '@/modules/common/utils/canonicalJson';
import { canonicalMobile } from '@/modules/common/utils/phone';
import { istTodayYyyymmdd } from '@/modules/common/utils/istDate';
import { bookableUntilOf, slotIntervalOf } from '@/modules/common/utils/slotInterval';
import { buildBookingLifecyclePatch } from '@/modules/bookings/utils/lifecycle';
import { parseAppointment } from '@/modules/common/utils/cancellationWindow';
import BookingModel from '@/modules/bookings/model';
import type { IBooking } from '@/modules/bookings/types';
import { cancelBookingSettlement, isReplayedBooking, rescheduleWithHolds } from '@/modules/bookings/holds';
import SlotModel from '@/modules/slots/model';
import SpecialistModel from '@/modules/specialists/model';
import UserModel from '@/modules/user/model';
import PharmacyModel from '@/modules/pharmacies/model';
import { WalletRepository } from '@/modules/wallet/repository';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { abandonRequestKey, claimRequestKey } from '@/modules/requestKeys';
import { bookerView } from '@/modules/assisted/bookerView';
import { maskName } from '@/modules/assisted/names';
import { assertPharmacyAssistedOn } from '@/modules/assisted/flags';
import { countBookerCancellationIn, hitLookup } from '@/modules/assisted/limits';
import { assistedBookerFilter } from '@/modules/assisted/refunds';
import { ASSISTED_KEY, assistedKeyScope, storedAssistedKey, type PharmacyActor } from '@/modules/assisted/consultations';
import { assistedEffects, auditIn, bestEffort, sendAssistedNotices, type AssistedNotice } from '@/modules/assisted/support';

/**
 * Assisted booking phase 1a, pharmacy commands besides the create (§6.2, §7.1, §8.7, P7, P9, §17.6): the masked lookup,
 * the nearby doctor list, the booker's cancel (any time before the start, full refund to its wallet) and reschedule
 * (same doctor and price, before the start), and the by-key lookup / abandon of a create (Q13 pattern).
 */
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const notFound = () => err(404, 'BOOKING_NOT_FOUND', 'Booking not found');
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const orgKey = (pharmacyId: string) => `pharmacy:${lower(pharmacyId)}`;

/** POST /pharmacy-assisted/patients/lookup — `{ exists, holderNameMasked }` only; limited and audited. */
export async function lookupPatient(actor: PharmacyActor, rawPhone: unknown) {
  assertPharmacyAssistedOn();
  const phone = canonicalMobile(rawPhone);
  if (!phone) throw err(400, 'INVALID_PHONE', 'Enter a valid 10-digit mobile number');
  await hitLookup(orgKey(actor.pharmacyId));
  const user = await UserModel.findOne({ phone, userType: 'user' }).select({ name: 1 }).lean() as { _id: unknown; name?: string } | null;
  await auditIn({ actorKind: 'pharmacy', actorId: lower(actor.actorId), orgKind: 'pharmacy', orgId: lower(actor.pharmacyId), action: 'patient.lookup',
    detail: { exists: !!user, ...(user ? { userId: String(user._id) } : {}) } }, null);
  return { exists: !!user, holderNameMasked: user ? maskName(user.name) : null };
}

export interface DoctorQuery { speciality?: string; mode?: 'video' | 'call' | 'in-person'; language?: string; date?: string; limit?: number }
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ymd = (iso: string) => iso.replace(/-/g, '');

/**
 * GET /pharmacy-assisted/doctors — any active, verified doctor (decision 9), nearby first: the pharmacy's pincode, then
 * its city; then the requested language, the fee and the next free slot. With `date`, that day's bookable slots.
 */
export async function listDoctors(actor: PharmacyActor, q: DoctorQuery, now: Date = new Date()) {
  assertPharmacyAssistedOn();
  const pharmacy = await PharmacyModel.findById(actor.pharmacyId).select({ city: 1, pincode: 1 }).lean() as { city?: string; pincode?: string } | null;
  const filter: Record<string, unknown> = { isActive: true, isVerified: true };
  if (q.speciality) filter.specialization = { $regex: `^${escapeRx(q.speciality.trim())}$`, $options: 'i' };
  if (q.language) filter.languages = { $regex: `^${escapeRx(q.language.trim())}$`, $options: 'i' };
  const doctors = await SpecialistModel.find(filter).select({ name: 1, specialization: 1, languages: 1, city: 1, pincode: 1, consultationFee: 1,
    isConsultationFree: 1, experienceYears: 1 }).limit(300).lean() as Record<string, any>[];
  if (!doctors.length) return [];
  const today = istTodayYyyymmdd(now);
  const from = q.date ? ymd(q.date) : today;
  const slots = await SlotModel.find({ specialistId: { $in: doctors.map((d) => String(d._id)) }, date: { $gte: from < today ? today : from },
    isActive: true, isAvailable: true, $expr: { $lt: [{ $ifNull: ['$currentBookings', 0] }, { $ifNull: ['$maxBookings', 1] }] } })
    .sort({ date: 1 }).limit(5000).lean() as Record<string, any>[];
  const modeOk = (s: Record<string, any>) => !q.mode || !(s.serviceModes?.length) || s.serviceModes.includes(q.mode);
  const open = slots.filter((s) => modeOk(s) && (bookableUntilOf(s)?.getTime() ?? 0) > now.getTime())
    .map((s) => ({ s, start: slotIntervalOf(s)!.start })).sort((a, b) => a.start.getTime() - b.start.getTime());
  const byDoctor = new Map<string, { s: Record<string, any>; start: Date }[]>();
  for (const x of open) {
    const k = lower(x.s.specialistId);
    if (!byDoctor.has(k)) byDoctor.set(k, []);
    byDoctor.get(k)!.push(x);
  }
  const same = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  const rows = doctors.map((d) => {
    const mine = byDoctor.get(lower(d._id)) ?? [];
    const nearby = same(d.pincode, pharmacy?.pincode) ? 'pincode' : same(d.city, pharmacy?.city) ? 'city' : null;
    const speaks = !!q.language && (d.languages ?? []).some((l: string) => same(l, q.language));
    const feeMinor = d.isConsultationFree === true ? 0 : Math.round(Number(d.consultationFee || 0) * 100);
    const view = (x: { s: Record<string, any>; start: Date }) => ({ slotId: String(x.s._id), date: x.s.date, startTime: x.s.startTime, endTime: x.s.endTime,
      startsAt: x.start, modes: x.s.serviceModes?.length ? x.s.serviceModes : ['video', 'call', 'in-person'] });
    return {
      doctorId: String(d._id), name: d.name, specialization: d.specialization, languages: d.languages ?? [], city: d.city ?? null,
      experienceYears: d.experienceYears ?? null, feeMinor, nearby,
      nextSlot: mine[0] ? view(mine[0]) : null,
      ...(q.date ? { slots: mine.filter((x) => x.s.date === ymd(q.date!)).map(view) } : {}),
      _rank: [nearby === 'pincode' ? 0 : nearby === 'city' ? 1 : 2, speaks ? 0 : 1, feeMinor, mine[0]?.start.getTime() ?? Number.MAX_SAFE_INTEGER],
    };
  });
  rows.sort((a, b) => {
    for (let i = 0; i < a._rank.length; i++) if (a._rank[i] !== b._rank[i]) return a._rank[i]! - b._rank[i]!;
    return a.name < b.name ? -1 : 1;
  });
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);
  return rows.slice(0, limit).map(({ _rank: _r, ...row }) => row);
}

async function ownAssisted(actor: PharmacyActor, bookingId: unknown): Promise<IBooking> {
  if (typeof bookingId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(bookingId)) throw notFound();
  const b = await BookingModel.findOne({ _id: bookingId, ...assistedBookerFilter('pharmacy', actor.pharmacyId) }).lean() as IBooking | null;
  if (!b) throw notFound();
  return b;
}

const shownDate = (d?: string) => (d && /^\d{8}$/.test(d) ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : String(d ?? ''));

/** After a cancellation of an assisted booking (any path): reminders, Meet, and who is told (§6.5, §8.7). */
export async function afterAssistedCancel(b: IBooking, by: 'booker' | 'patient' | 'doctor' | 'admin', refunded = true): Promise<IBooking> {
  if (!b.assisted) return b;
  const fx = assistedEffects();
  await bestEffort('reminders', () => fx.clearReminders(String(b._id)), undefined);
  const out = await bestEffort('meet', () => fx.cancelMeet(b, b.cancellationReason || 'Cancelled'), b);
  const id = String(b._id);
  const when = `${shownDate(b.bookingDate)} at ${b.bookingTime}`;
  const a = b.assisted;
  const notices: AssistedNotice[] = [];
  if (by !== 'patient') {
    notices.push({ audience: 'customer', userId: String(b.userId), type: 'booking_cancelled', title: 'Consultation cancelled',
      message: `The consultation on ${when} (Ref ${a.shortRef}) was cancelled.${refunded ? ` ${a.bookedBy.name} has been refunded.` : ''}`, bookingId: id,
      key: `assisted:${id}:cancelled:customer` });
  }
  if (by !== 'booker') {
    // "Cancelled by patient" badge (§6.5): the partner is told; no health details.
    notices.push({ audience: 'booker', userId: a.bookedBy.id, type: 'booking_cancelled', title: by === 'patient' ? 'Cancelled by the patient' : 'Booking cancelled',
      message: `Booking Ref ${a.shortRef} on ${when} was cancelled${by === 'patient' ? ' by the patient' : ''}.${refunded ? ' The amount is back in your Jansetu wallet.' : ''}`,
      bookingId: id, key: `assisted:${id}:cancelled:booker`, data: { cause: by } });
  }
  if (by !== 'doctor' && b.specialistId) {
    notices.push({ audience: 'doctor', userId: String(b.specialistId), type: 'specialist_appointment_cancelled', title: 'Consultation cancelled',
      message: `A consultation on ${when} was cancelled.`, bookingId: id, key: `assisted:${id}:cancelled:doctor` });
  }
  await sendAssistedNotices(notices);
  return out;
}

/** POST /pharmacy-assisted/bookings/:id/cancel — any time before the start (§8.7); full refund to the wallet; P7 count. */
export async function cancelByBooker(actor: PharmacyActor, bookingId: string, input: { reason?: string; expectedUpdatedAt?: string | Date },
  clock: () => Date = () => new Date()) {
  await ownAssisted(actor, bookingId);
  const reason = String(input.reason ?? '').trim() || 'Cancelled by the booking partner';
  const r = await cancelBookingSettlement({
    bookingId, requester: { _id: lower(actor.pharmacyId), userType: 'pharmacy' }, assistedBooker: 'pharmacy', reason, cause: 'booker', cancelledAt: istTodayYyyymmdd(clock()),
    wallets: new WalletRepository(), expectedUpdatedAt: input.expectedUpdatedAt ?? null,
    enforceWindow: (b) => {
      const start = parseAppointment({ bookingDate: String(b.bookingDate ?? ''), bookingTime: String(b.bookingTime ?? '') })?.at;
      if (!start || start.getTime() <= clock().getTime()) throw err(400, 'BOOKING_ALREADY_STARTED', 'The consultation has already started; it can no longer be cancelled');
    },
    lifecycle: (b) => buildBookingLifecyclePatch(b.lifecycle, { cancelled: { reason }, refunded: { reason } }),
    inTx: async (b, s) => {
      await countBookerCancellationIn('pharmacy', lower(actor.pharmacyId), s);
      await auditIn({ actorKind: 'pharmacy', actorId: lower(actor.actorId), orgKind: 'pharmacy', orgId: lower(actor.pharmacyId), action: 'booking.cancelled',
        bookingId: String(b._id), detail: { reason, cause: 'booker' } }, s);
    },
  });
  const booking = r.alreadyCancelled ? r.booking : await afterAssistedCancel(r.booking, 'booker');
  return { booking: await bookerView(booking as never, lower(actor.pharmacyId)), refundedMinor: Math.round(r.refunded * 100), alreadyCancelled: r.alreadyCancelled };
}

/** POST /pharmacy-assisted/bookings/:id/reschedule — P9: same doctor and price, before the start, once per request key. */
export async function rescheduleByBooker(actor: PharmacyActor, bookingId: string, input: { slotId: string; requestKey: string; expectedUpdatedAt?: string | Date },
  clock: () => Date = () => new Date()) {
  if (!ASSISTED_KEY.test(String(input.requestKey ?? ''))) throw err(400, 'REQUEST_KEY_REQUIRED', 'requestKey is required');
  const b = await ownAssisted(actor, bookingId);
  const hash = requestHashOf({ slotId: lower(input.slotId) });
  const replay = (x: IBooking) => {
    const prior = (x.assisted?.reschedules ?? []).find((r) => r.requestKey === input.requestKey);
    if (!prior) return null;
    if (prior.requestHash !== hash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different move');
    return x;
  };
  const prior = replay(b);
  if (prior) return { booking: await bookerView(prior as never, lower(actor.pharmacyId)), replayed: true };
  if (!Types.ObjectId.isValid(input.slotId)) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  const slot = await SlotModel.findById(input.slotId).select({ date: 1 }).lean() as { date?: string } | null;
  if (!slot?.date) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  let updated: IBooking;
  try {
    updated = await rescheduleWithHolds({
      bookingId, requester: { _id: lower(actor.pharmacyId), userType: 'pharmacy' }, assistedBooker: 'pharmacy', nextSlotId: String(input.slotId),
      patch: { bookingDate: slot.date, lifecycle: buildBookingLifecyclePatch(b.lifecycle, { rescheduled: true }) ?? b.lifecycle },
      expectedUpdatedAt: input.expectedUpdatedAt ?? null, refuseStartedSource: clock,
      inTx: async (x, s) => {
        await claimRequestKey(`assisted_reschedule:${lower(actor.pharmacyId)}:${lower(bookingId)}`, input.requestKey, s);
        await BookingModel.updateOne({ _id: x._id }, { $push: { 'assisted.reschedules': { requestKey: input.requestKey, requestHash: hash, at: clock(),
          fromSlotId: b.slotId, toSlotId: lower(input.slotId), by: lower(actor.actorId) } } }, { session: s });
        await auditIn({ actorKind: 'pharmacy', actorId: lower(actor.actorId), orgKind: 'pharmacy', orgId: lower(actor.pharmacyId), action: 'booking.rescheduled',
          bookingId: String(x._id), requestKey: input.requestKey, detail: { fromSlotId: b.slotId, toSlotId: lower(input.slotId) } }, s);
      },
    });
  } catch (e) {
    const raced = await BookingModel.findById(bookingId).lean() as IBooking | null;
    const again = raced ? replay(raced) : null;
    if (!again) throw e;
    return { booking: await bookerView(again as never, lower(actor.pharmacyId)), replayed: true };
  }
  if (isReplayedBooking(updated)) return { booking: await bookerView(updated as never, lower(actor.pharmacyId)), replayed: true };
  const fx = assistedEffects();
  // A move keeps the join link (§6.6): only the Meet event and reminders follow the new slot.
  const withMeet = updated.consultationMode === 'in-person' ? updated : await bestEffort('meet', () => fx.meet(updated), updated);
  await bestEffort('reminders', () => fx.reminders(withMeet), undefined);
  const id = String(updated._id);
  const when = `${shownDate(updated.bookingDate)} at ${updated.bookingTime}`;
  const v = new Date(updated.updatedAt ?? Date.now()).getTime();
  await sendAssistedNotices([
    { audience: 'customer', userId: String(updated.userId), type: 'general', title: 'Consultation moved',
      message: `Your consultation (Ref ${updated.assisted!.shortRef}) is now on ${when}.`, bookingId: id, key: `assisted:${id}:moved:${v}:customer` },
    ...(updated.specialistId ? [{ audience: 'doctor' as const, userId: String(updated.specialistId), type: 'specialist_general' as const,
      title: 'Consultation moved', message: `A consultation with you was moved to ${when}.`, bookingId: id, key: `assisted:${id}:moved:${v}:doctor` }] : []),
  ]);
  const fresh = await BookingModel.findById(id).lean() as IBooking;
  return { booking: await bookerView(fresh as never, lower(actor.pharmacyId)), replayed: false };
}

/** GET /pharmacy-assisted/bookings/by-key/:key — 'used' (with the booking), 'abandoned' or 'unknown' (Q9/Q13). */
export async function findByKey(actor: PharmacyActor, key: string) {
  if (!ASSISTED_KEY.test(String(key ?? ''))) throw err(400, 'VALIDATION_ERROR', 'A valid key is required');
  const b = await BookingModel.findOne({ 'assisted.requestKey': { $eq: storedAssistedKey(actor, key) } }).lean() as IBooking | null;
  if (b) return { state: 'used' as const, booking: await bookerView(b as never, lower(actor.pharmacyId)) };
  const row = await RequestKeyModel.findOne({ scope: assistedKeyScope(actor), key }).lean();
  return { state: row?.state === 'abandoned' ? 'abandoned' as const : 'unknown' as const };
}

/** POST /pharmacy-assisted/bookings/by-key/:key/abandon — abandoned (it can never be booked) or used (here it is). */
export async function abandonByKey(actor: PharmacyActor, key: string) {
  if (!ASSISTED_KEY.test(String(key ?? ''))) throw err(400, 'VALIDATION_ERROR', 'A valid key is required');
  const made = await BookingModel.exists({ 'assisted.requestKey': { $eq: storedAssistedKey(actor, key) } });
  if (made) return findByKey(actor, key);
  const state = await abandonRequestKey(assistedKeyScope(actor), key);
  return state === 'abandoned' ? { state } : findByKey(actor, key);
}
