import { Container } from 'typedi';
import type { ClientSession } from 'mongoose';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '@/modules/common/types';
import { canonicalMobile } from '@/modules/common/utils/phone';
import type { AuthRequest } from '@/modules/middleware/auth';
import BookingModel from '@/modules/bookings/model';
import { BOOKING_PAYMENT_WINDOW_MS } from '@/modules/bookings/holds';
import type { IBooking } from '@/modules/bookings/types';
import { BookingService } from '@/modules/bookings/services';
import SlotModel from '@/modules/slots/model';
import DependentModel from '@/modules/dependents/model';
import UserModel from '@/modules/user/model';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { abandonRequestKey, claimRequestKey } from '@/modules/requestKeys';
import PartnerOrgModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import { LedgerEntryModel, type ISettlementAccount } from '@/modules/partners/model/settlement';
import type { PartnerActor } from '@/modules/partners/services';
import type { PartnerActorRequest } from '@/modules/partners/controller';
import { range } from '@/modules/partners/services/finance';
import { addDays, isRealDate, istDate } from '@/modules/partners/services/slots';
import { createDeskAppointment, deskKeyScope, deskPatientOf, deskView, mySoloPractice, storedDeskKey, type DeskBookingInput, type DeskClock, type DeskPatientInput } from '@/modules/partners/services/clinic';
import { doctorScopeOf } from '@/modules/doctors/services/schedule';
import { lookupPatientFor } from '@/modules/assisted/labBookings';
import { assistedPublicView, UNPAID_CARD_QUERY } from '@/modules/assisted/views';

/**
 * r39 (§26.23): the doctor's single dashboard (P2) — one appointment list with filters, booking at a clinic he consults
 * at (the clinic desk's own create), an online consultation or follow-up booked for his patient (the patient's own
 * booking create), billing the clinic he owns (the workspace's bill routes with an owner actor) and an earnings
 * breakdown read from his ledger. Another clinic's data is never shown: only his own appointments and his own clinic.
 */
type Row = Record<string, any>;
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const ymd = (iso: string) => iso.replace(/-/g, '');
const MAX_RANGE_DAYS = 31;
const LIST_MAX = 1000;
const clinicNotFound = () => err(404, 'CLINIC_NOT_FOUND', 'Clinic not found');
/** Both spellings of an id (rows written before ids were canonical keep the caller's case). */
const spellings = (id: string) => [...new Set([id, id.toLowerCase()])];

export const doctorIdOf = (req: Request) => lower((req as AuthRequest).user?.specialistId || (req as AuthRequest).user?._id);

// ───────────────────────────── The doctor at a clinic (actors) ─────────────────────────────

type MemberRow = { _id: unknown; partnerId: string; role: string; permissions?: string[]; branchIds?: string[]; doctorBranchIds?: string[] };

/** An active, verified clinic (unknown or inactive: 404; not verified yet: 403 PARTNER_NOT_VERIFIED, as the workspace guard). */
async function admitClinic(partnerId: string): Promise<void> {
  const p = OBJECT_ID.test(partnerId) ? await PartnerOrgModel.findById(partnerId).select({ kind: 1, isActive: 1, 'verification.state': 1 }).lean() as Row | null : null;
  if (!p || p.kind !== 'clinic' || p.isActive === false) throw clinicNotFound();
  if (p.verification?.state !== 'verified') throw err(403, 'PARTNER_NOT_VERIFIED', 'Partner verification is required for this operation');
}

const actorOf = (m: MemberRow, branchIds: string[]): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role as PartnerActor['role'],
  permissions: (m.permissions ?? []) as PartnerActor['permissions'], branchIds });

/**
 * The doctor's membership of a clinic he consults at, as a desk actor limited to the branches he consults at
 * (`doctorScopeOf`). Not linked (or no such clinic): 404 CLINIC_NOT_FOUND.
 */
export async function linkedClinicActor(doctorId: string, clinicId: string): Promise<PartnerActor> {
  if (!OBJECT_ID.test(clinicId)) throw clinicNotFound();
  const m = await MemberModel.findOne({ partnerId: { $in: spellings(clinicId) }, doctorId: { $in: spellings(doctorId) }, isActive: true })
    .select({ partnerId: 1, role: 1, permissions: 1, branchIds: 1, doctorBranchIds: 1 }).lean() as MemberRow | null;
  if (!m) throw clinicNotFound();
  await admitClinic(String(m.partnerId));
  return actorOf(m, doctorScopeOf(m));
}

/**
 * The clinic the doctor OWNS (his owner membership, as his own clinic or practice creates it), with the owner's
 * authority over it — built as `loadPartnerActor` builds a member's. None: 404 CLINIC_NOT_FOUND; more than one: 409
 * CLINIC_CHOICE_REQUIRED (he bills each from the clinic workspace).
 */
export async function ownedClinicActor(doctorId: string): Promise<PartnerActor> {
  const owned = await ownedMembers(doctorId);
  if (!owned.length) throw clinicNotFound();
  if (owned.length > 1) throw severalOwned();
  await admitClinic(String(owned[0]!.partnerId));
  return actorOf(owned[0]!, (owned[0]!.branchIds ?? []).map(String));
}
const severalOwned = () => err(409, 'CLINIC_CHOICE_REQUIRED', 'You own more than one clinic; bill from that clinic\'s workspace');

/** His active owner memberships at active clinics (verified or not). */
async function ownedMembers(doctorId: string): Promise<MemberRow[]> {
  const members = await MemberModel.find({ doctorId: { $in: spellings(doctorId) }, role: 'owner', isActive: true })
    .select({ partnerId: 1, role: 1, permissions: 1, branchIds: 1 }).lean() as MemberRow[];
  const clinics = members.length ? await PartnerOrgModel.find({ _id: { $in: members.map((m) => String(m.partnerId)).filter((x) => OBJECT_ID.test(x)) },
    kind: 'clinic', isActive: { $ne: false } }).select({ _id: 1 }).lean() as Row[] : [];
  return members.filter((m) => clinics.some((c) => lower(c._id) === lower(m.partnerId)));
}

/**
 * r39c: GET /specialists/me/clinic — the clinic he OWNS (any active owner membership with his doctorId; its partner and
 * branches, as before), so a clinic an admin made him owner of shows too; several: 409 CLINIC_CHOICE_REQUIRED (as billing).
 * Owning none, the answer is as before (his own practice by `soloDoctorId`, else null).
 */
export async function myOwnedClinic(doctorId: string) {
  const owned = await ownedMembers(doctorId);
  if (owned.length > 1) throw severalOwned();
  if (!owned.length) return mySoloPractice(doctorId);
  const partner = await PartnerOrgModel.findById(String(owned[0]!.partnerId)).lean() as Row | null;
  if (!partner) return mySoloPractice(doctorId);
  return { partner, branches: await BranchModel.find({ partnerId: String(partner._id) }).lean() };
}

/** r39c: his memberships (any clinic) and the active clinics he owns, for marking his rows. */
export interface DoctorTies { memberIds: Set<string>; ownedClinicIds: Set<string> }
export async function doctorTies(doctorId: string): Promise<DoctorTies> {
  const members = await MemberModel.find({ doctorId: { $in: spellings(doctorId) }, isActive: true }).select({ partnerId: 1 }).lean() as Row[];
  const owned = await ownedMembers(doctorId);
  return { memberIds: new Set(members.map((m) => lower(m._id))), ownedClinicIds: new Set(owned.map((m) => lower(m.partnerId))) };
}
/**
 * r39c: per row — `bookedByMe` (a desk row his own membership created) and, on a desk row at a clinic he owns, `customer:
 * { phone, name }`, the account holder as that clinic's desk list shows it (to bill the visit). Other rows carry no phone.
 */
export async function rowTiesOf(rows: Row[], ties: DoctorTies): Promise<(b: Row) => { bookedByMe: boolean; customer?: { phone: string | null; name: string | null } }> {
  const atOwn = (b: Row) => !!b.clinicDesk && ties.ownedClinicIds.has(lower(b.clinicDesk.partnerId));
  const ids = [...new Set(rows.filter(atOwn).map((b) => String(b.userId ?? '')).filter((x) => OBJECT_ID.test(x)))];
  const users = ids.length ? await UserModel.find({ _id: { $in: ids } }).select({ phone: 1, name: 1 }).lean() as Row[] : [];
  const byId = new Map(users.map((u) => [lower(u._id), u]));
  return (b) => {
    const u = atOwn(b) ? byId.get(lower(b.userId)) : undefined;
    return { bookedByMe: !!b.clinicDesk?.createdBy && ties.memberIds.has(lower(b.clinicDesk.createdBy)),
      ...(atOwn(b) ? { customer: { phone: u?.phone ?? null, name: u?.name ?? null } } : {}) };
  };
}

/** The owned clinic's actor, or null when he owns none he can act for (the Today register then has no bills). */
export const ownedClinicActorOrNull = (doctorId: string) => ownedClinicActor(doctorId)
  .catch((e) => { if (e instanceof AppError && [403, 404, 409].includes(Number(e.status))) return null; throw e; });

/** After requireSpecialist and requireEligibleDoctor: the workspace bill handlers act through this owner actor. */
export const attachDoctorOwnerActor = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    (req as PartnerActorRequest).partnerActor = await ownedClinicActor(doctorIdOf(req));
    next();
  } catch (e) {
    next(e);
  }
};

// ───────────────────────────── One appointment list ─────────────────────────────

export const APPOINTMENT_SOURCES = ['self', 'clinic_desk', 'pharmacy_assisted', 'lab_assisted', 'doctor_assisted', 'instant'] as const;
export type AppointmentSource = typeof APPOINTMENT_SOURCES[number];

/** §5.1: a row without `source` is a desk row or the patient's own; r39: the patient's own instant consultation reads `instant`. */
export function appointmentSourceOf(b: Row): string {
  const s = typeof b.source === 'string' ? b.source : b.clinicDesk ? 'clinic_desk' : 'self';
  return s === 'self' && b.bookingKind === 'instant' ? 'instant' : s;
}
export const clinicIdOf = (b: Row): string | null => {
  const id = b.clinicDesk?.partnerId ?? b.clinicVisit?.partnerId;
  return id ? lower(id) : null;
};
/** r39b: the one rule (list, Today, breakdown): in person is `clinic`; video, call and chat are `online`. */
export const channelOf = (b: Row): 'clinic' | 'online' => (b.consultationMode === 'in-person' ? 'clinic' : 'online');

const SELF_OR_DERIVED = { $or: [{ source: 'self' }, { source: { $exists: false }, clinicDesk: { $exists: false } }] };
/** The same rules as Mongo filters. */
function sourceFilter(s: AppointmentSource): Row {
  if (s === 'clinic_desk') return { $or: [{ source: 'clinic_desk' }, { source: { $exists: false }, clinicDesk: { $exists: true } }] };
  if (s === 'instant') return { $and: [SELF_OR_DERIVED, { bookingKind: 'instant' }] };
  if (s === 'self') return { $and: [SELF_OR_DERIVED, { bookingKind: { $ne: 'instant' } }] };
  return { source: s };
}
const channelFilter = (c: 'clinic' | 'online'): Row => (c === 'clinic' ? { consultationMode: 'in-person' } : { consultationMode: { $ne: 'in-person' } });
/** A clinic's rows as the clinic's own list owns them (a desk row by its desk; another by its visit). */
const clinicFilter = (id: string): Row => ({ $or: [{ 'clinicDesk.partnerId': { $in: spellings(id) } },
  { clinicDesk: { $exists: false }, 'clinicVisit.partnerId': { $in: spellings(id) } }] });

/** The clinics named on rows, `{ id, name }` (names only: never anything else of a clinic). */
export async function clinicNames(rows: Row[]): Promise<Map<string, { id: string; name: string | null }>> {
  const ids = [...new Set(rows.map(clinicIdOf).filter((x): x is string => !!x && OBJECT_ID.test(x)))];
  const ps = ids.length ? await PartnerOrgModel.find({ _id: { $in: ids } }).select({ name: 1 }).lean() as Row[] : [];
  const names = new Map(ps.map((p) => [lower(p._id), p.name ?? null]));
  return new Map(ids.map((id) => [id, { id, name: names.get(id) ?? null }]));
}

export interface AppointmentListQuery {
  from?: string; to?: string; source?: AppointmentSource; clinicId?: string; channel?: 'clinic' | 'online'; mode?: string; status?: string;
}

/**
 * GET /specialists/me/appointments/list?from&to&source&clinicId&channel&mode&status — the doctor's consultations of
 * every source in one list, appointment time order, at most 31 days (`from` default today in India, `to` default
 * `from`); each row as the existing list answers it plus `source` (always resolved), `clinic` ({ id, name } | null) and
 * `channel`. At most 1000 rows (`truncated` says when there were more).
 */
export async function listDoctorAppointments(doctorId: string, q: AppointmentListQuery, now: Date = new Date()) {
  const from = q.from ?? istDate(now);
  const to = q.to ?? from;
  if (!isRealDate(from) || !isRealDate(to) || to < from) throw err(400, 'INVALID_DATE', 'from/to must be real dates, from ≤ to');
  if (to > addDays(from, MAX_RANGE_DAYS - 1)) throw err(400, 'RANGE_TOO_LONG', `At most ${MAX_RANGE_DAYS} days at a time`);
  const and: Row[] = [];
  if (q.source) and.push(sourceFilter(q.source));
  if (q.channel) and.push(channelFilter(q.channel));
  if (q.clinicId) and.push(clinicFilter(q.clinicId));
  const filter: Row = {
    specialistId: { $in: spellings(doctorId) }, bookingType: 'consultation', bookingDate: { $gte: ymd(from), $lte: ymd(to) },
    // r10b: a card-paid assisted booking never confirmed is not the doctor's to see.
    $nor: [UNPAID_CARD_QUERY],
    ...(q.mode ? { consultationMode: q.mode } : {}), ...(q.status ? { status: q.status } : {}), ...(and.length ? { $and: and } : {}),
  };
  const rows = await BookingModel.find(filter).sort({ bookingDate: 1, bookingTime: 1, _id: 1 }).limit(LIST_MAX + 1).lean() as Row[];
  const page = rows.slice(0, LIST_MAX);
  const [clinics, tiesOf] = await Promise.all([clinicNames(page), doctorTies(doctorId).then((t) => rowTiesOf(page, t))]);
  const views = assistedPublicView(page) as Row[];
  const items = page.map((b, i) => {
    const c = clinicIdOf(b);
    return { ...views[i], source: appointmentSourceOf(b), clinic: c ? clinics.get(c) ?? { id: c, name: null } : null, channel: channelOf(b), ...tiesOf(b) };
  });
  return { items, truncated: rows.length > LIST_MAX };
}

// ───────────────────────────── Booking at a clinic he consults at ─────────────────────────────

export interface DoctorClinicBookingInput extends DeskBookingInput { clinicId: string; branchId?: string }

/**
 * POST /specialists/me/clinic-appointments — the doctor books his own in-clinic slot at a clinic he consults at (his own
 * included): the clinic desk's create (`createDeskAppointment`) with his membership as the desk actor, so the row is
 * that clinic's desk appointment (in its reception list, paid at the clinic). Only his own slots (another doctor's, or
 * a slot elsewhere: 409 SLOT_NOT_AVAILABLE; a slot at another clinic: 404 BRANCH_NOT_FOUND from the desk). A new
 * request names a phone like a lookup does: counted against his hourly lookups and audited (a resend of a recorded
 * key is not counted).
 */
export async function bookDoctorClinicAppointment(doctorId: string, input: DoctorClinicBookingInput, clock?: DeskClock) {
  const actor = await linkedClinicActor(doctorId, input.clinicId);
  const slot = OBJECT_ID.test(input.slotId) ? await SlotModel.findById(input.slotId).select({ specialistId: 1, branchId: 1 }).lean() as Row | null : null;
  if (!slot || lower(slot.specialistId) !== doctorId || (input.branchId && lower(slot.branchId) !== lower(input.branchId))) {
    throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  }
  if (!(await BookingModel.exists({ 'clinicDesk.requestKey': { $eq: storedDeskKey(actor, input.requestKey) } }))) {
    // r41: a key he gave up (by-key abandon) is never used, at any clinic (each clinic's own claim refuses it too).
    if (await RequestKeyModel.exists({ scope: doctorDeskScope(doctorId), key: input.requestKey, state: 'abandoned' })) throw abandoned();
    await lookupPatientFor({ kind: 'doctor', specialistId: doctorId }, input.customer.phone, { gated: false });
  }
  const { clinicId: _c, branchId: _b, ...desk } = input;
  return createDeskAppointment(actor, desk, clock);
}

// ───────────────────────────── Online consultation and follow-up ─────────────────────────────

export interface DoctorConsultationInput {
  slotId: string; mode: 'video' | 'call' | 'in-person'; requestKey: string; notes?: string;
  /** A new consultation: the patient (the desk's shape). */
  customer?: { phone: string; name?: string }; patient?: DeskPatientInput;
  /** A follow-up: the completed consultation of his it follows (its patient is the patient). */
  followUpOf?: string;
}

const storedConsultKey = (doctorId: string, key: string) => `doctor:${doctorId}:${key}`;

function consultationView(b: IBooking, replayed: boolean) {
  const owed = b.paymentStatus !== 'paid' && b.status !== 'cancelled' && Number(b.price ?? 0) > 0;
  return {
    booking: { bookingId: String(b._id), bookingDate: b.bookingDate, bookingTime: b.bookingTime, status: b.status, paymentStatus: b.paymentStatus,
      consultationMode: b.consultationMode, fee: b.price ?? 0, source: 'doctor_assisted', dependentId: b.dependentId ?? null,
      followUpOf: b.followUp?.isFollowUp ? String(b.followUp.parentConsultationId ?? '') || null : null },
    // The patient pays in the app (the booking's own payment, as for a booking he made himself) within the booking
    // payment window; unpaid by then, the booking expires and its slot is free again. A follow-up is free.
    payment: { by: 'patient_app', required: owed, payBy: owed && b.createdAt ? new Date(new Date(b.createdAt).getTime() + BOOKING_PAYMENT_WINDOW_MS) : null },
    replayed,
  };
}

/**
 * POST /specialists/me/consultations — the doctor books a consultation with himself for his patient, on one of his
 * own slots: the patient's own booking create (`createSpecialistBooking`) for the patient's account, marked
 * `source: 'doctor_assisted'`. Online (`video` | `call`; an in-person visit is a clinic appointment, 400
 * USE_CLINIC_APPOINTMENT) for a patient named by phone (desk shape), or a free follow-up (`followUpOf`: a completed,
 * paid consultation of his whose follow-up is still open; any mode his slot offers) under the existing follow-up rule.
 * Exactly once per (doctor, request key, patient account): a resend answers the same booking (200; an interrupted create
 * is finished), the key with another slot, mode or follow-up 409.
 */
export async function bookDoctorConsultation(doctorId: string, input: DoctorConsultationInput) {
  const storedKey = storedConsultKey(doctorId, input.requestKey);
  const followUpOf = input.followUpOf ? lower(input.followUpOf) : null;
  if (input.mode === 'in-person' && !followUpOf) throw err(400, 'USE_CLINIC_APPOINTMENT', 'Book an in-person visit as a clinic appointment');
  // The patient's account: a follow-up's is its parent's (a consultation of his only: anything else is the same 404, its
  // existence not revealed); a new patient's is the account of the phone, if one exists (none: no earlier booking).
  let parent: IBooking | null = null;
  let known: string | null = null;
  if (followUpOf) {
    parent = OBJECT_ID.test(followUpOf) ? await BookingModel.findOne({ _id: followUpOf, specialistId: { $in: spellings(doctorId) }, bookingType: 'consultation' })
      .select({ userId: 1, dependentId: 1 }).lean() as IBooking | null : null;
    if (!parent) throw err(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    known = String(parent.userId);
  } else {
    if (!input.customer) throw err(400, 'VALIDATION_ERROR', 'customer is required');
    const phone = canonicalMobile(input.customer.phone);
    if (!phone) throw err(400, 'INVALID_PHONE', 'Enter a valid 10-digit mobile number');
    const u = await UserModel.findOne({ phone, userType: 'user' }).select({ _id: 1 }).lean() as { _id: unknown } | null;
    known = u ? String(u._id) : null;
  }
  const notes = input.notes?.trim() || undefined;
  const create = (userId: string, slot: { _id: unknown; date?: string; startTime?: string }, dependentId?: string, inTx?: (b: IBooking, s: ClientSession) => Promise<void>) =>
    Container.get(BookingService).createSpecialistBooking({
      userId, ...(dependentId ? { dependentId } : {}), specialistId: doctorId, primaryConcern: notes ?? (followUpOf ? 'Follow-up' : 'Booked by your doctor'),
      consultationMode: input.mode as IBooking['consultationMode'] & string, slotId: String(slot._id), bookingDate: slot.date, bookingTime: slot.startTime,
      requestKey: storedKey, ...(followUpOf ? { followUp: { isFollowUp: true, parentConsultationId: followUpOf } } : {}), ...(notes ? { notes } : {}),
    } as never, 'consultation', { source: 'doctor_assisted', ...(inTx ? { inTx } : {}) });
  // r39b: the key is looked up on the unique { userId, createRequestKey } index. A resend with the same content goes through
  // the booking create's own replay, which finishes a create interrupted after its insert (e.g. a free follow-up not yet
  // settled) and answers the booking.
  const prior = known ? await BookingModel.findOne({ userId: { $eq: known }, createRequestKey: { $eq: storedKey } }).lean() as IBooking | null : null;
  if (prior) {
    const priorParent = prior.followUp?.isFollowUp ? lower(prior.followUp.parentConsultationId) : null;
    if (lower(prior.specialistId) !== doctorId || lower(prior.slotId) !== lower(input.slotId) || prior.consultationMode !== input.mode || priorParent !== followUpOf) {
      throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different appointment');
    }
    const out = await create(String(prior.userId), { _id: prior.slotId, date: prior.bookingDate, startTime: prior.bookingTime }, prior.dependentId ?? undefined);
    return consultationView(out.booking as IBooking, true);
  }
  // r41: the key already made a booking of his for another patient (read on { specialistId, createRequestKey }).
  if (await BookingModel.exists({ specialistId: { $in: spellings(doctorId) }, createRequestKey: { $eq: storedKey } })) {
    throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different appointment');
  }
  if (await RequestKeyModel.exists({ scope: doctorConsultScope(doctorId), key: input.requestKey, state: 'abandoned' })) throw abandoned();
  const slot = OBJECT_ID.test(input.slotId) ? await SlotModel.findById(input.slotId).select({ specialistId: 1, date: 1, startTime: 1 }).lean() as Row | null : null;
  if (!slot || lower(slot.specialistId) !== doctorId) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  // r41: the key is claimed in the booking's transaction, so a by-key abandon and this create cannot both win.
  const claim = (s: ClientSession) => claimRequestKey(doctorConsultScope(doctorId), input.requestKey, s);
  if (parent) {
    const out = await create(String(parent.userId), slot as never, parent.dependentId ? String(parent.dependentId) : undefined, (_b, s) => claim(s));
    return consultationView(out.booking as IBooking, false);
  }
  await lookupPatientFor({ kind: 'doctor', specialistId: doctorId }, input.customer!.phone, { gated: false });
  const p = await deskPatientOf({ customer: input.customer!, patient: input.patient }, 'assisted_booking');
  // r39b: a new family member is created inside the booking's transaction, as the desk does.
  const newDependent = p.newDependent;
  const out = await create(String(p.customer._id), slot as never, p.dependentId,
    async (_b, s) => { await claim(s); if (newDependent) await DependentModel.create([newDependent], { session: s }); });
  return consultationView(out.booking as IBooking, false);
}

// ───────────────────────────── r41: his create keys, after a lost answer ─────────────────────────────

/**
 * r41 (§26.23): a doctor whose create answer was lost (a reload) reads the key back or gives it up, as the pharmacy sale
 * (r36): `{ state: 'used', booking, … } | { state: 'abandoned' } | { state: 'unknown' }`, his own keys only (another
 * doctor's key reads `unknown`). An abandoned key is claimed so a later create with it is 409 `REQUEST_ABANDONED`.
 */
const doctorDeskScope = (doctorId: string) => `doctor_clinic_appointment:${lower(doctorId)}`;
const doctorConsultScope = (doctorId: string) => `doctor_consultation:${lower(doctorId)}`;
const abandoned = () => err(409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
export const DOCTOR_KEY = /^[A-Za-z0-9_-]{8,100}$/;
const assertKey = (key: string) => { if (!DOCTOR_KEY.test(String(key ?? ''))) throw err(400, 'VALIDATION_ERROR', 'A valid key is required'); };

/** His active memberships (each clinic's desk keys are stored under the membership that booked). */
const doctorMembers = async (doctorId: string) => MemberModel.find({ doctorId: { $in: spellings(doctorId) }, isActive: true })
  .select({ partnerId: 1 }).lean().exec() as unknown as Promise<{ _id: unknown; partnerId: string }[]>;

/** GET /specialists/me/clinic-appointments/by-key/:key — the appointment his key made at any clinic he consults at. */
export async function clinicAppointmentByKey(doctorId: string, key: string) {
  assertKey(key);
  const members = await doctorMembers(doctorId);
  const keys = members.map((m) => storedDeskKey({ memberId: String(m._id) } as PartnerActor, key));
  // The unique `clinicDesk.requestKey` index.
  const b = keys.length ? await BookingModel.findOne({ 'clinicDesk.requestKey': { $in: keys } }).lean() as IBooking | null : null;
  if (b) return { state: 'used' as const, booking: deskView(b) };
  const k = await RequestKeyModel.findOne({ scope: doctorDeskScope(doctorId), key }).lean();
  return { state: k?.state === 'abandoned' ? 'abandoned' as const : 'unknown' as const };
}

/** POST …/clinic-appointments/by-key/:key/abandon — given up at every clinic he consults at (each clinic's claim and his own). */
export async function abandonClinicAppointmentKey(doctorId: string, key: string) {
  const found = await clinicAppointmentByKey(doctorId, key);
  if (found.state === 'used') return found;
  const members = await doctorMembers(doctorId);
  const states = await Promise.all([abandonRequestKey(doctorDeskScope(doctorId), key),
    ...members.map((m) => abandonRequestKey(deskKeyScope({ partnerId: String(m.partnerId), memberId: String(m._id) } as PartnerActor), key))]);
  return states.every((x) => x === 'abandoned') ? { state: 'abandoned' as const } : clinicAppointmentByKey(doctorId, key);
}

/** GET /specialists/me/consultations/by-key/:key — the consultation his key made (on { specialistId, createRequestKey }). */
export async function consultationByKey(doctorId: string, key: string) {
  assertKey(key);
  const b = await BookingModel.findOne({ specialistId: { $in: spellings(doctorId) }, createRequestKey: { $eq: storedConsultKey(doctorId, key) } })
    .sort({ createdAt: 1, _id: 1 }).lean() as IBooking | null;
  if (b) { const { replayed: _r, ...v } = consultationView(b, true); return { state: 'used' as const, ...v }; }
  const k = await RequestKeyModel.findOne({ scope: doctorConsultScope(doctorId), key }).lean();
  return { state: k?.state === 'abandoned' ? 'abandoned' as const : 'unknown' as const };
}

/** POST …/consultations/by-key/:key/abandon — a key whose consultation never committed can never make one. */
export async function abandonConsultationKey(doctorId: string, key: string) {
  const found = await consultationByKey(doctorId, key);
  if (found.state === 'used') return found;
  const state = await abandonRequestKey(doctorConsultScope(doctorId), key);
  return state === 'abandoned' ? { state } : consultationByKey(doctorId, key);
}

// ───────────────────────────── Earnings breakdown (his ledger) ─────────────────────────────

export type EarningChannel = 'clinic' | 'online' | 'partner' | 'referral' | 'other';
export interface BreakdownQuery { from?: string; to?: string; channel?: EarningChannel; clinicId?: string }
type Sum = { earnedMinor: number; reversedMinor: number; netMinor: number; count: number };
const zero = (): Sum => ({ earnedMinor: 0, reversedMinor: 0, netMinor: 0, count: 0 });

/**
 * r39: `breakdown` on GET /specialists/me/finance — his ledger's earnings and reversals (no second ledger) in the period
 * (`from`/`to`, India dates; default all), by where the money came from: `clinic` (consultations at a clinic, by clinic),
 * `online` (his online and instant consultations, and those he booked himself), `partner` (consultations a pharmacy or
 * lab booked), `referral` (his cut of lab tests he booked), `other`. `channel`/`clinicId` keep only that part. A clinic
 * desk appointment is paid at the clinic (its bill), so it is never in the ledger.
 */
export async function earningsBreakdown(account: ISettlementAccount | null, q: BreakdownQuery) {
  const out = { from: q.from ?? null, to: q.to ?? null, totals: zero(), online: zero(), partner: zero(), referral: zero(), other: zero(),
    clinics: [] as (Sum & { clinicId: string | null; name: string | null })[] };
  if (!account) return out;
  const groups = await LedgerEntryModel.aggregate([
    { $match: { settlementAccountId: String(account._id), kind: { $in: ['earning', 'reversal'] }, ...range(q.from, q.to) } },
    { $group: { _id: { source: '$source', sourceId: '$sourceId' },
      earned: { $sum: { $cond: [{ $eq: ['$kind', 'earning'] }, '$amountMinor', 0] } },
      reversed: { $sum: { $cond: [{ $eq: ['$kind', 'reversal'] }, '$amountMinor', 0] } },
      earnings: { $sum: { $cond: [{ $eq: ['$kind', 'earning'] }, 1, 0] } } } },
  ]) as { _id: { source: string; sourceId: string }; earned: number; reversed: number; earnings: number }[];
  const ids = groups.filter((g) => g._id.source === 'consultation' && OBJECT_ID.test(g._id.sourceId)).map((g) => lower(g._id.sourceId));
  const bookings = new Map<string, Row>();
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await BookingModel.find({ _id: { $in: ids.slice(i, i + 1000) } }).select({ source: 1, clinicDesk: 1, clinicVisit: 1, bookingKind: 1, consultationMode: 1 }).lean() as Row[];
    for (const b of rows) bookings.set(lower(b._id), b);
  }
  const clinics = new Map<string, Sum>();
  for (const g of groups) {
    const b = g._id.source === 'consultation' ? bookings.get(lower(g._id.sourceId)) : undefined;
    const clinicId = b ? clinicIdOf(b) : null;
    const channel: EarningChannel = g._id.source.startsWith('referral_') ? 'referral' : !b ? 'other'
      : ['pharmacy_assisted', 'lab_assisted'].includes(b.source) ? 'partner' : channelOf(b);
    if (q.channel && q.channel !== channel) continue;
    if (q.clinicId && (channel !== 'clinic' || clinicId !== lower(q.clinicId))) continue;
    // An in-person consultation with no clinic (an older visit) is its own `clinicId: null` line.
    const key = clinicId ?? '';
    const parts = [out.totals, channel === 'clinic' ? clinics.get(key) ?? clinics.set(key, zero()).get(key)! : out[channel]];
    for (const s of parts) {
      s.earnedMinor += g.earned; s.reversedMinor += -g.reversed; s.netMinor += g.earned + g.reversed; s.count += g.earnings > 0 ? 1 : 0;
    }
  }
  const names = await clinicNames([...clinics.keys()].filter(Boolean).map((id) => ({ clinicVisit: { partnerId: id } })));
  out.clinics = [...clinics.entries()].map(([key, s]) => ({ clinicId: key || null, name: key ? names.get(key)?.name ?? null : null, ...s }))
    .sort((a, b) => b.netMinor - a.netMinor || String(a.clinicId).localeCompare(String(b.clinicId)));
  return out;
}
