import { UNPAID_CARD_QUERY } from '@/modules/assisted/views';
import { createHash } from 'crypto';
import { istTodayYyyymmdd } from '@/modules/common/utils/istDate';
import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { canonicalMobile } from '@/modules/common/utils/phone';
import { bookableUntilOf, isWindowSlot, slotIntervalOf } from '@/modules/common/utils/slotInterval';
import PartnerOrgModel from '@/modules/partners/model';
import BranchModel from '@/modules/partners/model/branch';
import MemberModel from '@/modules/partners/model/member';
import { ClinicDoctorInviteModel, IClinicDoctorInvite } from '@/modules/partners/model/clinicDoctor';
import { ALL_PERMISSIONS, IBranch, IMember, IPartner } from '@/modules/partners/types';
import {
  PartnerActor, assertBranchInScope, assertScopeWithin, hasGlobalScope, inTransaction, recordPartnerAudit,
} from '@/modules/partners/services';
import { ensureSettlementAccount } from '@/modules/partners/services/settlement';
import { resolveCustomerByPhone } from '@/modules/partners/services/customerResolver';
import { istDate, isRealDate, addDays } from '@/modules/partners/services/slots';
import SpecialistModel from '@/modules/specialists/model';
import { assertBookableDoctor, isEligibleDoctor } from '@/modules/specialists/eligibility';
import SlotModel from '@/modules/slots/model';
import BookingModel from '@/modules/bookings/model';
import UserModel from '@/modules/user/model';
import { IBooking } from '@/modules/bookings/types';
import {
  assertBookingVersion, cancelBookingSettlement, createBookingWithHolds, deskBookingInScope, isReplayedBooking, noShowAllowedFromSlot,
  noShowRescheduleHash, rescheduleWithHolds, type DeskScope,
} from '@/modules/bookings/holds';
import { claimRequestKey, abandonRequestKey } from '@/modules/requestKeys';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import DependentModel from '@/modules/dependents/model';
import { heldIntervalsOverlapping, releaseInterval } from '@/modules/doctors/services/reservations';
import { branchClosedOn, clinicBranchAllowed, doctorScopeOf, expandDoctorSlots, DOCTOR_ROLLING_DAYS } from '@/modules/doctors/services/schedule';
import { WalletRepository } from '@/modules/wallet/repository';
import { Container } from 'typedi';
import type { NotificationType } from '@/modules/notification/types';
import { billsForAppointments } from '@/modules/partners/services/invoice';
import { deskPhoneLookup } from '@/modules/assisted/patient';

/**
 * Q6 — clinics with several doctors, the clinic front desk, and solo practices.
 *
 * - A doctor consults with a clinic only after accepting the clinic's invitation in their own portal; the acceptance
 *   creates the doctor's membership (Q4's clinic authority reads it at every expansion and booking admission).
 * - The front desk books in-clinic appointments on a clinic doctor's slots for walk-in/phone customers. They take the
 *   same seat and doctor interval as an online booking (one shared admission), are paid at the clinic (the clinic's
 *   own Q2 invoice names the doctor) and are therefore settled by neither the legacy payouts nor the ledger
 *   (`settlementSystem: 'clinic'`); online payment is refused for them.
 * - A doctor without a clinic creates a solo practice (a clinic partner they own, one branch); an admin verifies it.
 */

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const MAX_RANGE_DAYS = 31;
const ymd = (iso: string) => iso.replace(/-/g, '');

async function clinicOf(actor: PartnerActor, s?: ClientSession): Promise<IPartner> {
  const p = await PartnerOrgModel.findById(actor.partnerId).session(s ?? null).lean() as IPartner | null;
  if (!p || p.isActive === false) throw err(404, 'PARTNER_NOT_FOUND', 'Partner not found');
  if (p.kind !== 'clinic') throw err(409, 'NOT_A_CLINIC', 'Only clinics work with doctors');
  return p;
}

/** A branch of this clinic offering in-clinic consultations, within the actor's branch scope. */
async function clinicBranch(actor: PartnerActor, branchId: string, s?: ClientSession): Promise<IBranch> {
  if (!Types.ObjectId.isValid(branchId)) throw err(404, 'BRANCH_NOT_FOUND', 'Branch not found');
  const b = await BranchModel.findOne({ _id: branchId, partnerId: actor.partnerId }).session(s ?? null).lean() as IBranch | null;
  if (!b) throw err(404, 'BRANCH_NOT_FOUND', 'Branch not found');
  assertBranchInScope(actor, String(b._id));
  if (b.isActive === false || !b.services?.inClinic) throw err(409, 'BRANCH_NOT_IN_CLINIC', 'This branch does not take in-clinic consultations');
  return b;
}

/** The desk's authority, re-admitted inside every booking transaction: this clinic, the member's branches (empty = all). */
const deskScopeOf = (actor: PartnerActor): DeskScope => ({ partnerId: actor.partnerId, branchIds: hasGlobalScope(actor) ? [] : actor.branchIds.map(String) });

/** A branch-restricted member manages only invitations wholly inside their branches (never an all-branches one). */
const inviteInScope = (actor: PartnerActor, inv: Pick<IClinicDoctorInvite, 'branchIds'>) =>
  hasGlobalScope(actor) || ((inv.branchIds ?? []).length > 0 && inv.branchIds.every((b) => actor.branchIds.includes(String(b))));

const audit = (actor: PartnerActor, action: string, target: { kind: string; id: string }, detail: Record<string, unknown>, s: ClientSession) =>
  recordPartnerAudit(actor, action, target, detail, s);

/** Best effort after a change of clinic authority: the doctor's generated slots follow at once (admission already refuses). */
async function refreshDoctorSlots(doctorId: string): Promise<void> {
  try { await expandDoctorSlots(doctorId, istDate(new Date()), DOCTOR_ROLLING_DAYS); }
  catch (e) { console.error('doctor slot refresh failed', (e as Error)?.message); }
}

// ───────────────────────────── Notifications (Q14) ─────────────────────────────

/** Q14: one in-app notice to the customer (account holder) or the doctor, as ordinary bookings notify today. */
export interface ClinicNotice {
  audience: 'customer' | 'doctor'; userId: string; type: NotificationType; title: string; message: string;
  referenceType: 'booking' | 'clinic_doctor_invite'; referenceId: string; key: string; data?: Record<string, unknown>;
}
export type ClinicNotifier = (n: ClinicNotice) => Promise<void>;

/** Default: the existing in-app notification (NotificationService; doctors receive theirs under their specialist id). */
export const defaultClinicNotifier: ClinicNotifier = async (n) => {
  const { NotificationService } = await import('@/modules/notification/services');
  await Container.get(NotificationService).create({ userId: n.userId, type: n.type, title: n.title, message: n.message,
    referenceType: n.referenceType, referenceId: n.referenceId, idempotencyKey: n.key, data: n.data ?? {} });
};
let clinicNotifier: ClinicNotifier = defaultClinicNotifier;
/** Replaces the sender (tests); returns the previous one. No argument restores the default. */
export function setClinicNotifier(n?: ClinicNotifier): ClinicNotifier {
  const prev = clinicNotifier;
  clinicNotifier = n ?? defaultClinicNotifier;
  return prev;
}

/**
 * Called only after the operation committed. Best effort: a failure is logged by notice kind (never the recipient,
 * phone numbers or patient details) and never fails or undoes the operation.
 */
async function sendClinicNotices(notices: ClinicNotice[]): Promise<void> {
  for (const n of notices) {
    try { await clinicNotifier(n); }
    catch (e) { console.error('clinic notification failed', n.audience, n.type, (e as Error)?.message); }
  }
}

const shownDate = (d?: string) => (d && /^\d{8}$/.test(d) ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : String(d ?? ''));
const placeOf = (clinicName?: string, branchName?: string) => [clinicName, branchName ? `(${branchName})` : ''].filter(Boolean).join(' ');

/** The notices of a desk appointment event, for the account holder and the doctor (names read after the commit). */
async function deskNotices(b: IBooking, event: 'booked' | 'moved' | 'cancelled', extra: { reason?: string } = {}): Promise<ClinicNotice[]> {
  const partnerId = b.clinicDesk?.partnerId ?? b.clinicVisit?.partnerId;
  const branchId = b.clinicDesk?.branchId ?? b.clinicVisit?.branchId;
  const [p, br, dep] = await Promise.all([
    partnerId ? PartnerOrgModel.findById(partnerId).select({ name: 1 }).lean().exec() as Promise<{ name?: string } | null> : null,
    branchId && Types.ObjectId.isValid(String(branchId)) ? BranchModel.findById(branchId).select({ name: 1 }).lean().exec() as Promise<{ name?: string } | null> : null,
    b.dependentId && Types.ObjectId.isValid(String(b.dependentId)) ? DependentModel.findById(b.dependentId).select({ name: 1 }).lean().exec() as Promise<{ name?: string } | null> : null,
  ]);
  const where = placeOf(p?.name, br?.name);
  const when = `${shownDate(b.bookingDate)} at ${b.bookingTime}`;
  const doctor = b.doctorName ? `${b.doctorName}` : 'your doctor';
  const forWhom = dep?.name ? ` for ${dep.name}` : '';
  const id = String(b._id);
  const v = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
  const data = { bookingId: id, bookingDate: b.bookingDate, bookingTime: b.bookingTime, clinicPartnerId: partnerId, branchId, source: 'clinic_desk' };
  const ref = { referenceType: 'booking' as const, referenceId: id, data };
  const out: ClinicNotice[] = [];
  const customer = (type: NotificationType, title: string, message: string, key: string) =>
    out.push({ audience: 'customer', userId: String(b.userId), type, title, message, key, ...ref });
  const doc = (type: NotificationType, title: string, message: string, key: string) => {
    if (b.specialistId) out.push({ audience: 'doctor', userId: String(b.specialistId), type, title, message, key, ...ref });
  };
  if (event === 'booked') {
    customer('booking_confirmed', 'Clinic appointment confirmed', `Your appointment${forWhom} with ${doctor} at ${where} is on ${when}. Pay at the clinic.`,
      `clinic_desk:${id}:booked:customer`);
    doc('specialist_new_booking', 'New clinic appointment', `A new appointment was booked with you at ${where} on ${when}.`, `clinic_desk:${id}:booked:doctor`);
  } else if (event === 'moved') {
    customer('general', 'Clinic appointment moved', `Your appointment${forWhom} with ${doctor} at ${where} is now on ${when}.`,
      `clinic_desk:${id}:moved:${v}:customer`);
    doc('specialist_general', 'Clinic appointment moved', `An appointment with you at ${where} was moved to ${when}.`, `clinic_desk:${id}:moved:${v}:doctor`);
  } else {
    const why = extra.reason ? ` Reason: ${extra.reason}` : '';
    customer('booking_cancelled', 'Clinic appointment cancelled', `Your appointment${forWhom} with ${doctor} at ${where} on ${when} was cancelled by the clinic.${why}`,
      `clinic_desk:${id}:cancelled:customer`);
    doc('specialist_appointment_cancelled', 'Clinic appointment cancelled', `An appointment with you at ${where} on ${when} was cancelled by the clinic.`,
      `clinic_desk:${id}:cancelled:doctor`);
  }
  return out;
}

/** After commit, best effort (building the notices reads names; that failing must not fail the operation either). */
async function notifyDesk(b: IBooking, event: 'booked' | 'moved' | 'cancelled', extra: { reason?: string } = {}): Promise<void> {
  let notices: ClinicNotice[] = [];
  try { notices = await deskNotices(b, event, extra); }
  catch (e) { console.error('clinic notification failed', event, (e as Error)?.message); return; }
  await sendClinicNotices(notices);
}

// ───────────────────────────── Clinic: doctors and invitations ─────────────────────────────

export async function listClinicDoctors(actor: PartnerActor) {
  await clinicOf(actor);
  return clinicDoctorsSeen(actor);
}
/** The clinic's doctors this member sees (a branch-limited member: those of its branches); the caller checked the clinic. */
async function clinicDoctorsSeen(actor: PartnerActor) {
  const members = await MemberModel.find({ partnerId: actor.partnerId, isActive: true, doctorId: { $type: 'string' } }).lean() as IMember[];
  const scopeOf = (m: IMember) => doctorScopeOf(m);
  const visible = hasGlobalScope(actor) ? members
    : members.filter((m) => scopeOf(m).length === 0 || scopeOf(m).some((b) => actor.branchIds.includes(b)));
  const sps = await SpecialistModel.find({ _id: { $in: visible.map((m) => m.doctorId).filter((d) => Types.ObjectId.isValid(String(d))) } })
    .select({ name: 1, specialization: 1, consultationFee: 1, isActive: 1, isVerified: 1 }).lean() as any[];
  const byId = new Map(sps.map((d) => [String(d._id), d]));
  return visible.map((m) => {
    const d = byId.get(String(m.doctorId));
    return { memberId: String(m._id), doctorId: String(m.doctorId), role: m.role, branchIds: scopeOf(m), name: d?.name ?? m.name,
      specialization: d?.specialization, consultationFee: d?.consultationFee, active: !!d && d.isActive !== false && d.isVerified !== false };
  });
}

/**
 * Q14 (owner, 18 Nov 2026): clinics no longer invite doctors — an admin links them after checking (linkDoctor). Members
 * are refused with 403 DOCTOR_LINK_ADMIN_ONLY; an admin is pointed at the direct link (invitations can no longer be accepted).
 */
export async function inviteDoctor(actor: PartnerActor, _input: { doctorId?: string; phone?: string; branchIds?: string[] }): Promise<never> {
  await clinicOf(actor);
  if (actor.actorKind === 'admin') throw err(409, 'USE_DOCTOR_LINK', 'Invitations are retired: link the doctor directly (POST /clinic/doctors)');
  throw err(403, 'DOCTOR_LINK_ADMIN_ONLY', 'Doctors are linked to clinics by the platform team after checking; ask them to add this doctor');
}

/** Q6 (retired by Q14): the clinic asked a doctor (by id or registered phone) to consult at some or all of its branches. Kept for reference only. */
export async function legacyInviteDoctor(actor: PartnerActor, input: { doctorId?: string; phone?: string; branchIds?: string[] }) {
  await clinicOf(actor);
  const branchIds = [...new Set((input.branchIds ?? []).map(String))];
  assertScopeWithin(actor, branchIds);
  for (const b of branchIds) await clinicBranch(actor, b);
  let sp: any = null;
  if (input.doctorId && Types.ObjectId.isValid(input.doctorId)) sp = await SpecialistModel.findById(input.doctorId).lean();
  else if (input.phone) {
    const phone = canonicalMobile(input.phone);
    if (!phone) throw err(400, 'INVALID_PHONE', 'Enter a ten-digit mobile number');
    sp = await SpecialistModel.findOne({ phone: { $in: [phone, `+91${phone}`, `91${phone}`] } }).lean();
  }
  if (!sp || sp.isActive === false || sp.isVerified === false) throw err(404, 'DOCTOR_NOT_FOUND', 'No active, verified doctor with these details');
  const doctorId = String(sp._id);
  if (await MemberModel.exists({ partnerId: actor.partnerId, doctorId, isActive: true })) throw err(409, 'DOCTOR_ALREADY_MEMBER', 'This doctor already consults here');
  const pending = await ClinicDoctorInviteModel.findOne({ partnerId: actor.partnerId, doctorId, state: 'pending' }).lean();
  if (pending) {
    if (!inviteInScope(actor, pending)) throw err(409, 'INVITE_PENDING', 'This doctor already has a pending invitation from your clinic');
    return { invite: pending, doctor: { doctorId, name: sp.name, specialization: sp.specialization }, created: false };
  }
  try {
    const invite = await inTransaction(async (s) => {
      const [inv] = await ClinicDoctorInviteModel.create([{ partnerId: actor.partnerId, doctorId, branchIds, invitedBy: actor.memberId, state: 'pending' }], { session: s });
      await audit(actor, 'clinic.doctor_invited', { kind: 'clinic_doctor_invite', id: String(inv!._id) }, { doctorId, branchIds }, s);
      return inv!.toObject() as IClinicDoctorInvite;
    });
    // Q14: the doctor hears of the invitation in their portal notifications (after the commit, best effort).
    const clinicName = (await PartnerOrgModel.findById(actor.partnerId).select({ name: 1 }).lean().catch(() => null) as { name?: string } | null)?.name;
    await sendClinicNotices([{ audience: 'doctor', userId: doctorId, type: 'specialist_general', title: 'Clinic invitation',
      message: `${clinicName ?? 'A clinic'} invited you to consult with them. Accept or decline it under My clinics.`,
      referenceType: 'clinic_doctor_invite', referenceId: String(invite._id), key: `clinic_invite:${String(invite._id)}:doctor`,
      data: { inviteId: String(invite._id), partnerId: actor.partnerId } }]);
    return { invite, doctor: { doctorId, name: sp.name, specialization: sp.specialization }, created: true };
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
    const raced = await ClinicDoctorInviteModel.findOne({ partnerId: actor.partnerId, doctorId, state: 'pending' }).lean();
    if (!raced) throw e;
    if (!inviteInScope(actor, raced)) throw err(409, 'INVITE_PENDING', 'This doctor already has a pending invitation from your clinic');
    return { invite: raced, doctor: { doctorId, name: sp.name, specialization: sp.specialization }, created: false };
  }
}

export async function listInvites(actor: PartnerActor, state?: IClinicDoctorInvite['state']) {
  await clinicOf(actor);
  const rows = await ClinicDoctorInviteModel.find({ partnerId: actor.partnerId, ...(state ? { state } : {}) }).sort({ createdAt: -1 }).limit(500).lean();
  const visible = rows.filter((i) => inviteInScope(actor, i)).slice(0, 200);
  // Q13: each invitation names the doctor (current display name and speciality only; no contact details).
  const sps = await SpecialistModel.find({ _id: { $in: [...new Set(visible.map((i) => String(i.doctorId)))].filter((d) => Types.ObjectId.isValid(d)) } })
    .select({ name: 1, specialization: 1 }).lean() as { _id: unknown; name?: string; specialization?: string }[];
  const byId = new Map(sps.map((d) => [String(d._id).toLowerCase(), d]));
  return visible.map((i) => {
    const d = byId.get(String(i.doctorId).toLowerCase());
    return { ...i, doctor: { doctorId: String(i.doctorId), name: d?.name ?? null, specialization: d?.specialization ?? null } };
  });
}

export async function revokeInvite(actor: PartnerActor, inviteId: string) {
  await clinicOf(actor);
  if (!Types.ObjectId.isValid(inviteId)) throw err(404, 'INVITE_NOT_FOUND', 'Invitation not found');
  return inTransaction(async (s) => {
    const current = await ClinicDoctorInviteModel.findOne({ _id: inviteId, partnerId: actor.partnerId }).session(s).lean();
    if (!current || !inviteInScope(actor, current)) throw err(404, 'INVITE_NOT_FOUND', 'Invitation not found');
    const inv = await ClinicDoctorInviteModel.findOneAndUpdate({ _id: inviteId, partnerId: actor.partnerId, state: 'pending' },
      { $set: { state: 'revoked', respondedAt: new Date() } }, { new: true, session: s }).lean();
    if (!inv) throw err(409, 'INVITE_NOT_PENDING', 'This invitation is no longer pending');
    await audit(actor, 'clinic.doctor_invite_revoked', { kind: 'clinic_doctor_invite', id: inviteId }, { doctorId: inv.doctorId }, s);
    return inv;
  });
}

// ───────────────────────────── Doctor: clinics and invitations ─────────────────────────────

export async function myClinics(doctorId: string) {
  const members = await MemberModel.find({ doctorId: String(doctorId), isActive: true }).lean() as IMember[];
  const invites = await ClinicDoctorInviteModel.find({ doctorId: String(doctorId), state: 'pending' }).sort({ createdAt: -1 }).lean();
  const partnerIds = [...new Set([...members.map((m) => String(m.partnerId)), ...invites.map((i) => i.partnerId)])];
  const partners = await PartnerOrgModel.find({ _id: { $in: partnerIds } }).select({ name: 1, solo: 1, soloDoctorId: 1, isActive: 1, verification: 1 }).lean() as any[];
  const branches = await BranchModel.find({ partnerId: { $in: partnerIds }, isActive: true, 'services.inClinic': true }).select({ partnerId: 1, name: 1, address: 1 }).lean() as any[];
  const pById = new Map(partners.map((p) => [String(p._id), p]));
  const branchesOf = (pid: string, ids: string[]) => branches.filter((b) => String(b.partnerId) === pid && (ids.length === 0 || ids.includes(String(b._id))))
    .map((b) => ({ branchId: String(b._id), name: b.name, address: b.address }));
  return {
    clinics: members.map((m) => {
      const p = pById.get(String(m.partnerId));
      return { partnerId: String(m.partnerId), name: p?.name, solo: !!p?.solo, verified: p?.verification?.state === 'verified', role: m.role,
        branches: branchesOf(String(m.partnerId), doctorScopeOf(m)) };
    }),
    invites: invites.map((i) => ({ inviteId: String(i._id), partnerId: i.partnerId, clinic: pById.get(i.partnerId)?.name, branches: branchesOf(i.partnerId, i.branchIds),
      createdAt: i.createdAt })),
  };
}

/**
 * The doctor's membership of a clinic (Q6 acceptance; Q14 admin link): created, or the doctor's existing staff record
 * with the same mobile linked (it keeps its workspace access; the clinical scope is exactly `branchIds`).
 */
async function attachDoctorMember(p: { partnerId: string; doctorId: string; phone: string; name?: string; branchIds: string[]; invitedBy: string },
  s: ClientSession): Promise<IMember> {
  const clinic = await PartnerOrgModel.findById(p.partnerId).session(s).lean() as IPartner | null;
  if (!clinic || clinic.isActive === false || clinic.kind !== 'clinic') throw err(409, 'CLINIC_NOT_ACTIVE', 'This clinic is not active');
  if (await MemberModel.exists({ partnerId: p.partnerId, doctorId: p.doctorId, isActive: true }).session(s)) {
    throw err(409, 'DOCTOR_ALREADY_MEMBER', 'This doctor already consults here');
  }
  const samePhone = await MemberModel.findOne({ partnerId: p.partnerId, phone: p.phone, isActive: true }).session(s).lean() as IMember | null;
  if (samePhone) {
    if (samePhone.doctorId) throw err(409, 'PHONE_USED_BY_ANOTHER_DOCTOR', 'This mobile number belongs to another doctor at this clinic');
    const member = await MemberModel.findOneAndUpdate({ _id: samePhone._id, isActive: true, doctorId: { $exists: false } },
      { $set: { doctorId: p.doctorId, doctorBranchIds: p.branchIds } }, { new: true, session: s }).lean() as IMember;
    if (!member) throw err(409, 'MEMBER_CHANGED', 'Please try again');
    return member;
  }
  // Linked doctors sign in to the clinic with their mobile number; a sign-in email is only ever set by the owner's edit.
  const [m] = await MemberModel.create([{ partnerId: p.partnerId, phone: p.phone, name: p.name, role: 'staff', permissions: [], branchIds: p.branchIds,
    doctorId: p.doctorId, doctorBranchIds: p.branchIds, isActive: true, invitedBy: p.invitedBy }], { session: s });
  return m!.toObject() as IMember;
}

/** Q14: the instant-consultation eligibility rule (Q13): stored isActive and isVerified both true (S5b: the shared S5 predicate). */
const eligibleDoctor = isEligibleDoctor;
export const doctorLinkKeyScope = (partnerId: string) => `clinic_doctor_link:${String(partnerId).toLowerCase()}`;

/**
 * Q14 (owner, 18 Nov 2026): an admin links a doctor to a clinic at chosen branches (empty = all) after checking — no
 * acceptance step. Same records an accepted invitation made (an accepted link row, the doctor's membership with
 * doctorBranchIds). Exactly once per (clinic, request key) with a content hash; audited; the doctor is told after commit.
 */
export async function linkDoctor(actor: PartnerActor, input: { doctorId: string; branchIds?: string[]; requestKey: string }) {
  if (actor.actorKind !== 'admin') throw err(403, 'DOCTOR_LINK_ADMIN_ONLY', 'Doctors are linked to clinics by the platform team after checking');
  await clinicOf(actor);
  const branchIds = [...new Set((input.branchIds ?? []).map(String))];
  for (const b of branchIds) await clinicBranch(actor, b);
  const doctorId = String(input.doctorId).toLowerCase();
  const requestHash = createHash('sha256').update(JSON.stringify({ doctorId, branchIds: [...branchIds].sort() })).digest('hex');
  const view = async (link: IClinicDoctorInvite, replayed: boolean) => {
    const sp = await SpecialistModel.findById(link.doctorId).select({ name: 1, specialization: 1 }).lean() as any;
    return { link, doctor: { doctorId: String(link.doctorId), name: sp?.name ?? null, specialization: sp?.specialization ?? null }, memberId: link.memberId, replayed };
  };
  const prior = async () => {
    const l = await ClinicDoctorInviteModel.findOne({ partnerId: actor.partnerId, requestKey: input.requestKey }).lean() as IClinicDoctorInvite | null;
    if (l && l.requestHash !== requestHash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different link');
    return l;
  };
  const before = await prior();
  if (before) return view(before, true);
  const sp = Types.ObjectId.isValid(doctorId) ? await SpecialistModel.findById(doctorId).lean() as any : null;
  if (!sp) throw err(404, 'DOCTOR_NOT_FOUND', 'Doctor not found');
  if (!eligibleDoctor(sp)) throw err(409, 'DOCTOR_NOT_ELIGIBLE', 'Only active, verified doctors can be linked to a clinic');
  const phone = canonicalMobile(sp.phone);
  if (!phone) throw err(409, 'DOCTOR_PHONE_REQUIRED', 'The doctor needs a mobile number on their profile (it is their clinic sign-in)');
  let link: IClinicDoctorInvite;
  try {
    link = await inTransaction(async (s) => {
      await claimRequestKey(doctorLinkKeyScope(actor.partnerId), input.requestKey, s);
      const member = await attachDoctorMember({ partnerId: actor.partnerId, doctorId, phone, name: sp.name, branchIds, invitedBy: actor.memberId }, s);
      // Any invitation still pending for this doctor is superseded by the link.
      await ClinicDoctorInviteModel.updateMany({ partnerId: actor.partnerId, doctorId, state: 'pending' }, { $set: { state: 'revoked', respondedAt: new Date() } }, { session: s });
      const [row] = await ClinicDoctorInviteModel.create([{ partnerId: actor.partnerId, doctorId, branchIds, invitedBy: actor.memberId, state: 'accepted',
        respondedAt: new Date(), memberId: String(member._id), via: 'admin_link', requestKey: input.requestKey, requestHash }], { session: s });
      await audit(actor, 'clinic.doctor_linked', { kind: 'member', id: String(member._id) }, { doctorId, branchIds }, s);
      return row!.toObject() as IClinicDoctorInvite;
    });
  } catch (e) {
    const raced = await prior();
    if (raced) return view(raced, true);
    // Q16a (L8): a concurrent link of the same doctor under another key lost the race on the one-membership index.
    if ((e as { code?: unknown })?.code === 11000) throw err(409, 'DOCTOR_ALREADY_MEMBER', 'This doctor already consults here');
    throw e;
  }
  await refreshDoctorSlots(doctorId);
  const clinicName = (await PartnerOrgModel.findById(actor.partnerId).select({ name: 1 }).lean().catch(() => null) as { name?: string } | null)?.name;
  await sendClinicNotices([{ audience: 'doctor', userId: doctorId, type: 'specialist_general', title: 'Linked to a clinic',
    message: `You can now consult at ${clinicName ?? 'a clinic'}. Its in-clinic slots follow your weekly schedule.`,
    referenceType: 'clinic_doctor_invite', referenceId: String(link._id), key: `clinic_link:${String(link._id)}:doctor`,
    data: { partnerId: actor.partnerId, linkId: String(link._id) } }]);
  return view(link, false);
}

/**
 * Q14: the clinic's owner (or an admin) removes a doctor from the clinic — it only reduces access. A membership that
 * exists only for consulting (staff, no permissions) ends; a staff record the doctor was linked to keeps its workspace
 * access and loses only its doctor link. Q16b: an owner record linked as the doctor loses only the link (by another owner
 * or an admin); a doctor's own practice keeps its doctor.
 */
export async function unlinkDoctor(actor: PartnerActor, doctorId: string) {
  if (actor.role !== 'owner') throw err(403, 'OWNER_REQUIRED', 'Only an owner can remove a doctor from the clinic');
  await clinicOf(actor);
  const out = await inTransaction(async (s) => {
    const m = await MemberModel.findOne({ partnerId: actor.partnerId, doctorId: String(doctorId), isActive: true }).session(s).lean() as IMember | null;
    if (!m) throw err(404, 'DOCTOR_NOT_AT_CLINIC', 'This doctor does not consult here');
    if (m.role === 'owner') {
      // Q16b N1: an owner who is also the clinic's linked doctor loses only the doctor link (the record stays an
      // ordinary owner, removable as any owner), when another owner or an admin does it. A doctor's own practice (the
      // clinic they created: soloDoctorId) keeps its doctor, and an owner cannot unlink themselves.
      const p = await PartnerOrgModel.findById(actor.partnerId).session(s).select({ soloDoctorId: 1 }).lean() as { soloDoctorId?: string } | null;
      if (p?.soloDoctorId && String(p.soloDoctorId).toLowerCase() === String(doctorId).toLowerCase()) {
        throw err(409, 'DOCTOR_IS_OWNER', 'This is the doctor\'s own practice; its doctor cannot be removed');
      }
      if (String(m._id) === String(actor.memberId)) throw err(409, 'DOCTOR_IS_OWNER', 'Another owner or the platform team removes your doctor link');
    }
    const consultOnly = m.role === 'staff' && (m.permissions ?? []).length === 0;
    const r = await MemberModel.updateOne({ _id: m._id, isActive: true, doctorId: m.doctorId },
      consultOnly ? { $set: { isActive: false } } : { $unset: { doctorId: 1, doctorBranchIds: 1 } }, { session: s });
    if (r.modifiedCount !== 1) throw err(409, 'MEMBER_CHANGED', 'Please try again');
    await audit(actor, 'clinic.doctor_unlinked', { kind: 'member', id: String(m._id) }, { doctorId: String(doctorId), membershipEnded: consultOnly }, s);
    return { unlinked: true, membershipEnded: consultOnly };
  });
  await refreshDoctorSlots(String(doctorId));
  await sendClinicNotices([{ audience: 'doctor', userId: String(doctorId), type: 'specialist_general', title: 'Removed from a clinic',
    message: 'A clinic no longer lists you as its doctor; its in-clinic slots are closed.', referenceType: 'clinic_doctor_invite',
    referenceId: String(actor.partnerId), key: `clinic_unlink:${actor.partnerId}:${doctorId}:${Date.now()}`, data: { partnerId: actor.partnerId } }]);
  return out;
}

/** The doctor accepts (membership created, or the doctor's existing staff record linked) or declines, once. */
export async function respondToInvite(doctorId: string, inviteId: string, accept: boolean) {
  if (!Types.ObjectId.isValid(inviteId)) throw err(404, 'INVITE_NOT_FOUND', 'Invitation not found');
  const sp = await SpecialistModel.findById(doctorId).lean() as any;
  if (!sp || sp.isActive === false || sp.isVerified === false) throw err(403, 'SPECIALIST_NOT_ACTIVE', 'Only active, verified doctors can join a clinic');
  const phone = canonicalMobile(sp.phone);
  if (accept && !phone) throw err(409, 'DOCTOR_PHONE_REQUIRED', 'Add a mobile number to your profile first (it is your clinic sign-in)');
  const out = await inTransaction(async (s) => {
    const inv = await ClinicDoctorInviteModel.findOne({ _id: inviteId, doctorId: String(doctorId) }).session(s).lean() as IClinicDoctorInvite | null;
    if (!inv) throw err(404, 'INVITE_NOT_FOUND', 'Invitation not found');
    if (inv.state !== 'pending') throw err(409, 'INVITE_NOT_PENDING', 'This invitation is no longer pending');
    // Q14: invitations can no longer be accepted (an admin links doctors after checking); declining stays possible.
    if (accept) throw err(409, 'INVITE_NO_LONGER_VALID', 'Clinic invitations are no longer used; the platform team links doctors to clinics');
    if (!accept) {
      await ClinicDoctorInviteModel.updateOne({ _id: inviteId, state: 'pending' }, { $set: { state: 'declined', respondedAt: new Date() } }, { session: s });
      return { accepted: false as const, partnerId: inv.partnerId };
    }
    const member = await attachDoctorMember({ partnerId: inv.partnerId, doctorId: String(doctorId), phone: phone!, name: sp.name,
      branchIds: inv.branchIds, invitedBy: inv.invitedBy }, s);
    const done = await ClinicDoctorInviteModel.updateOne({ _id: inviteId, state: 'pending' },
      { $set: { state: 'accepted', respondedAt: new Date(), memberId: String(member._id) } }, { session: s });
    if (done.modifiedCount !== 1) throw err(409, 'INVITE_NOT_PENDING', 'This invitation is no longer pending');
    const self: PartnerActor = { memberId: String(member._id), partnerId: inv.partnerId, role: member.role, permissions: member.permissions as any, branchIds: (member.branchIds ?? []).map(String) };
    await audit(self, 'clinic.doctor_joined', { kind: 'member', id: String(member._id) }, { doctorId: String(doctorId), inviteId }, s);
    return { accepted: true as const, partnerId: inv.partnerId, memberId: String(member._id) };
  });
  return out;
}

/** The doctor stops consulting with a clinic (not their own solo practice / not as an owner). New clinic bookings stop at once. */
export async function leaveClinic(doctorId: string, partnerId: string) {
  const out = await inTransaction(async (s) => {
    const m = await MemberModel.findOne({ partnerId: String(partnerId), doctorId: String(doctorId), isActive: true }).session(s).lean() as IMember | null;
    if (!m) throw err(404, 'MEMBERSHIP_NOT_FOUND', 'You do not consult at this clinic');
    if (m.role === 'owner') throw err(409, 'OWNER_CANNOT_LEAVE', 'An owner cannot leave; transfer ownership first');
    const r = await MemberModel.updateOne({ _id: m._id, isActive: true }, { $set: { isActive: false } }, { session: s });
    if (r.modifiedCount !== 1) throw err(409, 'MEMBER_CHANGED', 'Please try again');
    const self: PartnerActor = { memberId: String(m._id), partnerId: String(partnerId), role: 'staff', permissions: [], branchIds: (m.branchIds ?? []).map(String) };
    await audit(self, 'clinic.doctor_left', { kind: 'member', id: String(m._id) }, { doctorId: String(doctorId) }, s);
    return { left: true };
  });
  await refreshDoctorSlots(String(doctorId));
  return out;
}

// ───────────────────────────── Front desk: slots and appointments ─────────────────────────────

/**
 * Bookable in-clinic slots of a clinic doctor at one branch on one day (seat free, doctor's time not held elsewhere).
 * Q13: slots that have already started are left out (the desk create refuses them with SLOT_STARTED).
 * Q16d (F1): as admission decides — a multi-seat window is offered until it ENDS, a one-patient slot until it starts.
 */
export async function deskSlots(actor: PartnerActor, q: { doctorId: string; branchId: string; date: string }, now = new Date()) {
  await clinicOf(actor);
  await clinicBranch(actor, q.branchId);
  if (!isRealDate(q.date)) throw err(400, 'INVALID_DATE', 'date must be a real date, YYYY-MM-DD');
  if (!(await clinicBranchAllowed(q.doctorId, q.branchId))) throw err(404, 'DOCTOR_NOT_AT_CLINIC', 'This doctor does not consult at this branch');
  // Q16a (M4): nothing is offered on the branch's holiday (admission refuses it too).
  if (await branchClosedOn(String(q.branchId), ymd(q.date))) return [];
  const slots = await SlotModel.find({ specialistId: String(q.doctorId), branchId: String(q.branchId), date: ymd(q.date), isActive: true, isAvailable: true,
    $expr: { $lt: [{ $ifNull: ['$currentBookings', 0] }, { $ifNull: ['$maxBookings', 1] }] } }).lean() as any[];
  const inPerson = slots.filter((s) => !(s.serviceModes?.length) || s.serviceModes.includes('in-person'));
  const windows = inPerson.map((s) => ({ s, w: slotIntervalOf(s) }))
    .filter((x) => { const until = bookableUntilOf(x.s); return !!x.w && !!until && until.getTime() > now.getTime(); });
  if (!windows.length) return [];
  const held = await heldIntervalsOverlapping([String(q.doctorId)], new Date(Math.min(...windows.map((x) => x.w!.start.getTime()))),
    new Date(Math.max(...windows.map((x) => x.w!.end.getTime()))));
  return windows
    .filter(({ s, w }) => Number(s.maxBookings ?? 1) !== 1 || !held.some((h) => h.startTime < w!.end && h.endTime > w!.start))
    .sort((a, b) => a.w!.start.getTime() - b.w!.start.getTime())
    .map(({ s, w }) => ({ slotId: String(s._id), date: q.date, startTime: s.startTime, endTime: s.endTime, startsAt: w!.start,
      seatsLeft: Number(s.maxBookings ?? 1) - Number(s.currentBookings ?? 0) }));
}

/**
 * Q14: who is seen — omitted = the account holder; an existing family member of the account (`dependentId`); or a new
 * family member created under the account with this appointment (an active one with the same name and relation is
 * used as it is, never changed).
 */
export type DeskPatientInput = { dependentId: string } | { name: string; relation: string; gender?: 'Male' | 'Female' | 'Other'; dateOfBirth?: string };
export interface DeskBookingInput { slotId: string; customer: { phone: string; name?: string }; patient?: DeskPatientInput; notes?: string; requestKey: string }

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Q14: the patient choice as part of the desk request identity (absent = as before, so older keys keep their hash). */
function patientIdentity(p?: DeskPatientInput) {
  if (!p) return undefined;
  if ('dependentId' in p) return { dependentId: String(p.dependentId).toLowerCase() };
  return { name: p.name.trim().replace(/\s+/g, ' '), relation: p.relation, gender: p.gender ?? null, dateOfBirth: p.dateOfBirth ?? null };
}
const dependentNotFound = () => err(404, 'DEPENDENT_NOT_FOUND', 'Family member not found');

/** Q14: an existing family member named at the desk must belong to the account of this mobile (checked before any customer is created). */
async function assertDependentOfPhone(dependentId: string, phone: string) {
  if (!Types.ObjectId.isValid(dependentId)) throw dependentNotFound();
  const dep = await DependentModel.findOne({ _id: dependentId, isActive: true }).select({ userId: 1 }).lean() as { userId?: string } | null;
  if (!dep?.userId || !Types.ObjectId.isValid(String(dep.userId))) throw dependentNotFound();
  const u = await UserModel.findOne({ _id: dep.userId, userType: 'user' }).select({ phone: 1 }).lean() as { phone?: string } | null;
  if (!u?.phone || canonicalMobile(u.phone) !== canonicalMobile(phone)) throw dependentNotFound();
}

/**
 * The desk's patient rule (Q14), shared with the doctor's own bookings (r39): the account of this mobile (found or
 * created, never merged; its name filled only while empty) and the family member being seen — an existing one of this
 * account, an active one with the same name and relation, or a new one (`newDependent`, a pre-chosen id the caller
 * creates with its booking). A named family member of another account is 404 DEPENDENT_NOT_FOUND before any account is made.
 */
export async function deskPatientOf(input: { customer: { phone: string; name?: string }; patient?: DeskPatientInput },
  origin: 'clinic_desk' | 'assisted_booking') {
  if (input.patient && 'dependentId' in input.patient) await assertDependentOfPhone(String(input.patient.dependentId), input.customer.phone);
  const customer = await resolveCustomerByPhone(input.customer.phone, origin);
  const name = input.customer.name?.trim();
  if (name) await UserModel.updateOne({ _id: customer._id, $or: [{ name: { $exists: false } }, { name: null }, { name: '' }] }, { $set: { name } });
  // Q14: the family member being seen. A new one is created inside the booking transaction (with a pre-chosen id).
  let dependentId: string | undefined;
  let newDependent: Record<string, unknown> | undefined;
  if (input.patient && 'dependentId' in input.patient) {
    dependentId = String(input.patient.dependentId).toLowerCase();
  } else if (input.patient) {
    const p = input.patient;
    const depName = p.name.trim().replace(/\s+/g, ' ');
    const same = await DependentModel.findOne({ userId: customer._id, isActive: true, relationship: p.relation,
      name: { $regex: `^${escapeRx(depName)}$`, $options: 'i' } }).select({ _id: 1 }).lean() as { _id: unknown } | null;
    if (same) dependentId = String(same._id);
    else {
      dependentId = new Types.ObjectId().toHexString();
      newDependent = { _id: dependentId, userId: customer._id, name: depName, relationship: p.relation, isActive: true,
        ...(p.gender ? { gender: p.gender } : {}), ...(p.dateOfBirth ? { dateOfBirth: ymd(p.dateOfBirth) } : {}) };
    }
  }
  return { customer, dependentId, newDependent };
}

/**
 * r40d: POST /partner-workspace/clinic/patients/lookup { phone } — the reception's lookup before booking, the lab desk's
 * own rule (`deskPhoneLookup`): counted against the clinic's hourly lookup limit (organisation key `clinic:<id>`), audited
 * (`clinic.patient_lookup`, ids only) and answered `{ exists, holderNameMasked }` (a masked name only).
 */
export async function lookupClinicPatient(actor: PartnerActor, rawPhone: unknown) {
  await clinicOf(actor);
  return deskPhoneLookup(`clinic:${String(actor.partnerId).toLowerCase()}`, rawPhone,
    (seen) => recordPartnerAudit(actor, 'clinic.patient_lookup', undefined, seen));
}

/** Q13: request-key scope of desk appointments, per clinic and desk member (claimed in the booking transaction). */
export const deskKeyScope = (actor: PartnerActor) => `clinic_desk_create:${String(actor.partnerId).toLowerCase()}:${String(actor.memberId).toLowerCase()}`;
export const storedDeskKey = (actor: PartnerActor, key: string) => `desk:${actor.memberId}:${key}`;
const samePartner = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * A front-desk appointment: the customer (found or created by phone, never merged or overwritten) gets an in-person
 * consultation on a clinic doctor's slot at this clinic. One admission with online bookings (seat, doctor interval,
 * leave, current clinic authority), exactly once per (desk member, request key), audited in the same transaction.
 */
/** Q13 review: a fixed instant (tests) or a clock read whenever a time decision is made (default: the real clock). */
export type DeskClock = Date | (() => Date);
const clockOf = (c: DeskClock): (() => Date) => (typeof c === 'function' ? c : () => c);

export async function createDeskAppointment(actor: PartnerActor, input: DeskBookingInput, clock: DeskClock = () => new Date()) {
  const readClock = clockOf(clock);
  await clinicOf(actor);
  if (!Types.ObjectId.isValid(input.slotId)) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  const slot = await SlotModel.findById(input.slotId).lean() as any;
  if (!slot?.branchId || !slot.specialistId) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  const branch = await clinicBranch(actor, String(slot.branchId));
  const sp = await SpecialistModel.findById(slot.specialistId).select({ name: 1, consultationFee: 1, isActive: 1, isVerified: 1 }).lean() as any;
  if (!sp) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  // Exactly once per (desk member, request key), whatever customer or slot a repeat names (unique clinicDesk.requestKey).
  const requestKey = storedDeskKey(actor, input.requestKey);
  const patientKey = patientIdentity(input.patient);
  const requestHash = createHash('sha256').update(JSON.stringify({ slotId: String(slot._id).toLowerCase(),
    phone: canonicalMobile(input.customer.phone) ?? input.customer.phone, notes: input.notes?.trim() || null,
    ...(patientKey ? { patient: patientKey } : {}) })).digest('hex');
  // Q13: a slot that has already started is refused, here and again inside the booking transaction.
  const desk: DeskScope = { ...deskScopeOf(actor), refuseStartedClock: readClock };
  const asReceipt = (prior: IBooking) => {
    if (prior.clinicDesk?.requestHash !== requestHash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different appointment');
    // A receipt is shown only while the appointment is still within this desk's branches (it may have been moved).
    if (!deskBookingInScope(prior, desk)) throw err(404, 'BOOKING_NOT_FOUND', 'Appointment not found');
    return prior;
  };
  const replay = async () => {
    const prior = await BookingModel.findOne({ 'clinicDesk.requestKey': requestKey }).lean() as IBooking | null;
    return prior ? asReceipt(prior) : null;
  };
  const prior = await replay();
  if (prior) return { booking: deskView(prior), customer: { userId: String(prior.userId), phone: canonicalMobile(input.customer.phone), created: false },
    patient: await patientView(prior), replayed: true };
  // Q13: refused before a customer is resolved or created (the in-transaction claim and slot admission decide finally).
  if (await RequestKeyModel.exists({ scope: deskKeyScope(actor), key: input.requestKey, state: 'abandoned' })) {
    throw err(409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
  }
  // S5b: as booking create, only a verified, active doctor is booked (400 SPECIALIST_NOT_ACTIVE / SPECIALIST_NOT_VERIFIED),
  // before a customer is resolved or created; slot admission checks it again inside the booking transaction. A receipt
  // of an appointment already made (above) is still answered.
  assertBookableDoctor(sp);
  // Q16d (F1): the admission rule (a multi-seat window until it ENDS, a one-patient slot until it starts).
  const bookableUntil = bookableUntilOf(slot);
  if (!bookableUntil || bookableUntil.getTime() <= readClock().getTime()) {
    throw err(409, 'SLOT_STARTED', isWindowSlot(slot) ? 'This session has ended; choose a later one' : 'This slot has already started; choose a later one');
  }
  const { customer, dependentId, newDependent } = await deskPatientOf(input, 'clinic_desk');
  const fee = Number(sp.consultationFee) > 0 ? Number(sp.consultationFee) : 0;
  let booking: IBooking;
  try {
    // The clinic and branch are admitted (and recorded) on the slot as the booking transaction reads it (deskScope).
    booking = await createBookingWithHolds({
      bookingType: 'consultation', userId: customer._id, specialistId: String(slot.specialistId), doctorName: sp.name, slotId: String(slot._id),
      bookingDate: slot.date, bookingTime: slot.startTime, consultationMode: 'in-person', serviceMode: 'in-person', price: fee, originalPrice: fee,
      status: 'confirmed', paymentStatus: 'pending',
      clinicDesk: { partnerId: actor.partnerId, branchId: String(branch._id), createdBy: actor.memberId, requestKey, requestHash },
      ...(dependentId ? { dependentId } : {}),
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    } as IBooking, async (b, s) => {
      // Q13: the key is claimed with the appointment, so a desk's give-up of a lost answer and this booking cannot both win.
      await claimRequestKey(deskKeyScope(actor), input.requestKey, s);
      // Q14: the family member is the account's, active, as read in this transaction; a new one commits with the booking.
      if (newDependent) await DependentModel.create([newDependent], { session: s });
      else if (dependentId && !(await DependentModel.exists({ _id: dependentId, userId: customer._id, isActive: true }).session(s))) throw dependentNotFound();
      await audit(actor, 'clinic.appointment_booked', { kind: 'booking', id: String(b._id) },
        { doctorId: String(slot.specialistId), branchId: b.clinicDesk?.branchId, slotId: String(slot._id), customerCreated: customer.created,
          ...(dependentId ? { dependentId, dependentCreated: !!newDependent } : {}) }, s);
    }, desk);
  } catch (e: any) {
    // A racing identical request may have committed first (seat taken, or the unique key): answer with its receipt.
    const raced = await replay();
    if (!raced) throw e;
    return { booking: deskView(raced), customer: { userId: String(raced.userId), phone: customer.phone, created: false },
      patient: await patientView(raced), replayed: true };
  }
  if (isReplayedBooking(booking)) {
    const r = asReceipt(booking);
    return { booking: deskView(r), customer: { userId: String(r.userId), phone: customer.phone, created: false },
      patient: await patientView(r), replayed: true };
  }
  // Q14: the customer and the doctor are told, after the commit and best effort.
  await notifyDesk(booking, 'booked');
  return { booking: deskView(booking), customer: { userId: customer._id, phone: customer.phone, created: customer.created },
    patient: await patientView(booking), replayed: false };
}

/**
 * Q14: the person being seen on a desk answer (null = the account holder). Q14 review: it does not say whether the
 * family member was created by this booking (that would tell the desk who is on an account's family list); the audit
 * records it.
 */
async function patientView(b: IBooking) {
  if (!b.dependentId) return null;
  const d = await DependentModel.findById(b.dependentId).select({ name: 1, relationship: 1 }).lean() as { name?: string; relationship?: string } | null;
  return { dependentId: String(b.dependentId), name: d?.name ?? null, relationship: d?.relationship ?? null };
}

function deskView(b: IBooking) {
  return { bookingId: String(b._id), bookingDate: b.bookingDate, bookingTime: b.bookingTime, status: b.status, doctorId: b.specialistId,
    doctorName: b.doctorName, branchId: b.clinicDesk?.branchId, slotId: b.slotId, consultationMode: b.consultationMode, fee: b.price,
    payAtClinic: b.settlementSystem === 'clinic', arrivedAt: b.clinicDesk?.arrivedAt,
    // Q14: the family member being seen (null = the account holder).
    dependentId: b.dependentId ?? null,
    // Q13: the version a desk step names (`expectedUpdatedAt`) to refuse acting on a stale view.
    updatedAt: b.updatedAt };
}

/** Q13: the appointment a desk request key made, within this desk's clinic and branches; null when none (or not visible). */
export async function findDeskByKey(actor: PartnerActor, key: string) {
  await clinicOf(actor);
  const b = await BookingModel.findOne({ 'clinicDesk.requestKey': { $eq: storedDeskKey(actor, key) } }).lean() as IBooking | null;
  if (!b || !samePartner(b.clinicDesk?.partnerId, actor.partnerId)) return null;
  const desk = deskScopeOf(actor);
  if (desk.branchIds.length > 0 && !desk.branchIds.includes(String(b.clinicDesk!.branchId))) return null;
  return deskView(b);
}

/** Q13: give up a desk booking whose answer was lost: abandoned (it can never be made) or used (here it is, when visible). */
export async function abandonDeskKey(actor: PartnerActor, key: string) {
  await clinicOf(actor);
  // An appointment made under this key before claims existed (no claim row) is used, never abandoned.
  const made = await BookingModel.findOne({ 'clinicDesk.requestKey': { $eq: storedDeskKey(actor, key) } }).select({ clinicDesk: 1 }).lean() as IBooking | null;
  if (made && samePartner(made.clinicDesk?.partnerId, actor.partnerId)) return { state: 'used' as const, booking: await findDeskByKey(actor, key) };
  const state = await abandonRequestKey(deskKeyScope(actor), key);
  return state === 'abandoned' ? { state } : { state, booking: await findDeskByKey(actor, key) };
}

/** A desk appointment of this clinic, within the actor's branch scope. */
async function ownDeskBooking(actor: PartnerActor, bookingId: string, s?: ClientSession): Promise<IBooking> {
  if (!Types.ObjectId.isValid(bookingId)) throw err(404, 'BOOKING_NOT_FOUND', 'Appointment not found');
  const b = await BookingModel.findOne({ _id: bookingId, 'clinicDesk.partnerId': actor.partnerId }).session(s ?? null).lean() as IBooking | null;
  if (!b || !deskBookingInScope(b, deskScopeOf(actor))) throw err(404, 'BOOKING_NOT_FOUND', 'Appointment not found');
  return b;
}

/** Write fence for desk mutations: the booking still at the branch it was admitted at (a concurrent move conflicts). */
const atBranch = (b: IBooking) => ({ 'clinicDesk.branchId': String(b.clinicDesk!.branchId) });

/**
 * r40: the clinic's appointments a member reads — desk rows by their own desk clinic (`clinicDesk`), online rows by the
 * clinic of their visit (`clinicVisit`), at the clinic's branches in the member's scope (or one branch). The one filter of
 * the appointment list, the busy blocks and the clinic's Today register. Ownership is the booking's own frozen
 * association, never a slot's current branch; a card-paid assisted booking never confirmed is the booker's alone (r10d).
 */
export async function clinicAppointmentsScope(actor: PartnerActor, branchId?: string): Promise<Record<string, unknown>> {
  let branchIds = (await BranchModel.find({ partnerId: actor.partnerId }).select({ _id: 1 }).lean()).map((b) => String(b._id));
  if (!hasGlobalScope(actor)) branchIds = branchIds.filter((b) => actor.branchIds.includes(b));
  if (branchId) {
    assertBranchInScope(actor, branchId);
    branchIds = branchIds.filter((b) => b === String(branchId));
  }
  return {
    bookingType: 'consultation', $nor: [UNPAID_CARD_QUERY],
    $or: [
      { 'clinicDesk.partnerId': actor.partnerId, 'clinicDesk.branchId': { $in: branchIds } },
      { clinicDesk: { $exists: false }, 'clinicVisit.partnerId': actor.partnerId, 'clinicVisit.branchId': { $in: branchIds } },
    ],
  };
}

/** r40: appointment rows as the clinic sees them (the list's view: the person seen, the contact phone, the bill). */
export async function clinicAppointmentViews(partnerId: string, rows: IBooking[]) {
  const users = await UserModel.find({ _id: { $in: [...new Set(rows.map((r) => String(r.userId)))].filter((u) => Types.ObjectId.isValid(u)) } })
    .select({ name: 1, phone: 1 }).lean() as any[];
  const uById = new Map(users.map((u) => [String(u._id), u]));
  const depIds = [...new Set(rows.map((r) => (r as { dependentId?: string }).dependentId).filter((d): d is string => !!d && Types.ObjectId.isValid(d)))];
  const deps = depIds.length ? await DependentModel.find({ _id: { $in: depIds } }).select({ name: 1, relationship: 1 }).lean() as any[] : [];
  const dById = new Map(deps.map((d) => [String(d._id), d]));
  // Q14: the bill of each appointment (its open bill, else the latest cancelled one).
  const bills = await billsForAppointments(partnerId, rows.map((r) => String(r._id)));
  return rows.map((r) => {
    const account = uById.get(String(r.userId));
    const dep = (r as { dependentId?: string }).dependentId ? dById.get(String((r as { dependentId?: string }).dependentId)) : undefined;
    return {
      ...deskView(r), branchId: r.clinicDesk?.branchId ?? r.clinicVisit?.branchId,
      source: r.clinicDesk ? 'desk' : 'online', paidOnline: r.settlementSystem !== 'clinic' && r.paymentStatus === 'paid',
      // The person being seen (a family member when booked for one); the account holder's mobile is the contact.
      patient: { name: dep?.name ?? account?.name, relationship: dep?.relationship, accountName: dep ? account?.name : undefined, phone: account?.phone,
        dependentId: dep ? String(dep._id) : null },
      bill: bills.get(String(r._id).toLowerCase()) ?? null,
    };
  });
}

type DayViewQuery = { from: string; to: string; doctorId?: string; branchId?: string; status?: string };

/** Clinic appointments (desk and online) at the clinic's branches in scope, for up to 31 days. */
export async function listClinicAppointments(actor: PartnerActor, q: DayViewQuery) {
  await clinicOf(actor);
  assertRange(q);
  return appointmentsIn(actor, q, await clinicAppointmentsScope(actor, q.branchId));
}

/**
 * r40c: the reception's day view in one read of the clinic: the appointment list (`data`, unchanged) and the doctors'
 * busy blocks, side by side, on one scope.
 */
export async function clinicDayView(actor: PartnerActor, q: DayViewQuery) {
  await clinicOf(actor);
  assertRange(q);
  const scope = await clinicAppointmentsScope(actor, q.branchId);
  const [data, busy] = await Promise.all([appointmentsIn(actor, q, scope), busyIn(actor, q, scope)]);
  return { data, busy };
}

async function appointmentsIn(actor: PartnerActor, q: DayViewQuery, scope: Record<string, unknown>) {
  const rows = await BookingModel.find({
    ...scope, bookingDate: { $gte: ymd(q.from), $lte: ymd(q.to) },
    ...(q.status ? { status: q.status } : {}), ...(q.doctorId ? { specialistId: String(q.doctorId) } : {}),
  }).sort({ bookingDate: 1, bookingTime: 1 }).limit(1000).lean() as IBooking[];
  return clinicAppointmentViews(actor.partnerId, rows);
}

function assertRange(q: { from: string; to: string }): void {
  if (!isRealDate(q.from) || !isRealDate(q.to) || q.to < q.from) throw err(400, 'INVALID_DATE', 'from/to must be real dates, from ≤ to');
  if (q.to > addDays(q.from, MAX_RANGE_DAYS - 1)) throw err(400, 'RANGE_TOO_LONG', `At most ${MAX_RANGE_DAYS} days at a time`);
}

/** r40c (C3b): a busy block's grid: its start floored and its end ceiled to 15 minutes. */
const BUSY_GRID_MS = 15 * 60_000;

/**
 * r40 (P3, owner: reception sees a doctor's other work only as "busy"): when each of the clinic's doctors (those the
 * member sees) is taken elsewhere between `from` and `to` (India dates) — the doctor's held intervals (every booking of
 * a doctor holds one: scheduled, in-clinic, instant) that are not appointments of this clinic the member reads here (the
 * list's own scope). Only `{ doctorId, from, to }`: never a patient, a source or a place. r40c (C3b): each block is
 * widened to the 15-minute grid (start floored, end ceiled) and clipped to the asked days before one doctor's overlapping
 * or touching blocks are merged, so neither an instant consultation's odd start, nor a length, nor a place shows through.
 */
async function busyIn(actor: PartnerActor, q: DayViewQuery, scope: Record<string, unknown>) {
  const seen = (await clinicDoctorsSeen(actor)).map((d) => d.doctorId.toLowerCase());
  const doctors = q.doctorId ? seen.filter((d) => d === String(q.doctorId).toLowerCase()) : seen;
  if (!doctors.length) return [];
  const start = new Date(`${q.from}T00:00:00+05:30`);
  const end = new Date(new Date(`${q.to}T00:00:00+05:30`).getTime() + 86_400_000);
  const held = await heldIntervalsOverlapping(doctors, start, end);
  const refIds = [...new Set(held.map((h) => String(h.refId).toLowerCase()))].filter((x) => Types.ObjectId.isValid(x));
  const here = new Set((refIds.length ? await BookingModel.find({ _id: { $in: refIds }, ...scope }).select({ _id: 1 }).lean() : [])
    .map((b) => String(b._id).toLowerCase()));
  const blocks: { doctorId: string; from: Date; to: Date }[] = [];
  for (const h of held) {
    if (here.has(String(h.refId).toLowerCase())) continue;
    const from = new Date(Math.max(Math.floor(h.startTime.getTime() / BUSY_GRID_MS) * BUSY_GRID_MS, start.getTime()));
    const to = new Date(Math.min(Math.ceil(h.endTime.getTime() / BUSY_GRID_MS) * BUSY_GRID_MS, end.getTime()));
    const last = blocks[blocks.length - 1];
    if (last && last.doctorId === h.doctorId && from.getTime() <= last.to.getTime()) {
      if (to > last.to) last.to = to;
    } else blocks.push({ doctorId: h.doctorId, from, to });
  }
  return blocks;
}

/** The patient is at the desk. */
export async function markArrived(actor: PartnerActor, bookingId: string, expectedUpdatedAt?: Date | string | null) {
  return inTransaction(async (s) => {
    const b = await ownDeskBooking(actor, bookingId, s);
    assertBookingVersion(b, expectedUpdatedAt);
    const r = await BookingModel.findOneAndUpdate({ _id: b._id, status: 'confirmed', 'clinicDesk.partnerId': actor.partnerId, ...atBranch(b), 'clinicDesk.arrivedAt': null },
      { $set: { 'clinicDesk.arrivedAt': new Date() } }, { new: true, session: s }).lean() as IBooking | null;
    if (!r) throw err(409, 'BOOKING_STATE_CONFLICT', b.clinicDesk?.arrivedAt ? 'Already marked as arrived' : `A ${b.status} appointment cannot be checked in`);
    await audit(actor, 'clinic.appointment_arrived', { kind: 'booking', id: String(b._id) }, {}, s);
    return deskView(r);
  });
}

/** Seen (completed) or did not come (no-show): the doctor's time is freed; nothing is settled through us. */
export async function closeDeskAppointment(actor: PartnerActor, bookingId: string, outcome: 'completed' | 'no_show', now = new Date(),
  expectedUpdatedAt?: Date | string | null) {
  return inTransaction(async (s) => {
    const b = await ownDeskBooking(actor, bookingId, s);
    if (b.status !== 'confirmed') throw err(409, 'BOOKING_STATE_CONFLICT', `A ${b.status} appointment cannot be closed`);
    assertBookingVersion(b, expectedUpdatedAt);
    // Q16d (F8, owner, assumed): the desk may mark its appointment seen at any time on the appointment's own day (India
    // date), even before the slot time — no platform money is involved. Not on an earlier day.
    if (outcome === 'completed' && /^\d{8}$/.test(String(b.bookingDate ?? '')) && istTodayYyyymmdd(now) < String(b.bookingDate)) {
      throw err(409, 'NOT_STARTED_YET', 'An appointment can be marked seen only on its own day');
    }
    // Q16a: a no-show only 15 minutes after the appointment time. Q16d (F1): in a multi-seat window, 15 minutes after its END.
    const noShowFrom = outcome === 'no_show' ? await noShowAllowedFromSlot(b, s) : null;
    if (outcome === 'no_show' && (!noShowFrom || now < noShowFrom)) throw err(409, 'APPOINTMENT_NOT_STARTED', 'A no-show can be marked 15 minutes after the appointment time (a session: 15 minutes after the session ends)');
    const r = await BookingModel.findOneAndUpdate({ _id: b._id, status: 'confirmed', 'clinicDesk.partnerId': actor.partnerId, ...atBranch(b) },
      { $set: { status: outcome, ...(outcome === 'no_show' ? { noShow: { at: now, by: actor.memberId, byKind: 'clinic' } } : {}) } },
      { new: true, session: s }).lean() as IBooking | null;
    if (!r) throw err(409, 'BOOKING_CHANGED', 'The appointment changed; reload');
    await releaseInterval('scheduled', String(b._id).toLowerCase(), s);
    await audit(actor, outcome === 'completed' ? 'clinic.appointment_completed' : 'clinic.appointment_no_show', { kind: 'booking', id: String(b._id) }, {}, s);
    return deskView(r);
  });
}

/**
 * Q16a (L8): a desk appointment cancelled by its doctor (portal) is written to the clinic's audit trail in the same
 * transaction, as the doctor's member record at that clinic (or the doctor id when there is none).
 */
export async function recordDoctorDeskCancelIn(b: IBooking, requester: { _id: string; userType: string }, reason: string, s: ClientSession): Promise<void> {
  const partnerId = b.clinicDesk?.partnerId;
  if (!partnerId) return;
  const byDoctor = requester.userType === 'specialist';
  const member = byDoctor ? await MemberModel.findOne({ partnerId, doctorId: String(requester._id) }).select({ _id: 1 }).session(s).lean() as { _id: unknown } | null : null;
  const actor: PartnerActor = byDoctor
    ? { memberId: member ? String(member._id) : `doctor:${String(requester._id).toLowerCase()}`, partnerId, role: 'staff', permissions: [], branchIds: [], actorKind: 'member' }
    : { memberId: `admin:${String(requester._id)}`, partnerId, role: 'owner', permissions: [], branchIds: [], actorKind: 'admin' };
  await audit(actor, byDoctor ? 'clinic.appointment_cancelled_by_doctor' : 'clinic.appointment_cancelled', { kind: 'booking', id: String(b._id) },
    { reason, doctorId: b.specialistId }, s);
}

/** Cancelled by the clinic: seat and doctor's time released; no money moves (nothing was taken online). */
export async function cancelDeskAppointment(actor: PartnerActor, bookingId: string, reason: string, expectedUpdatedAt?: Date | string | null) {
  const b = await ownDeskBooking(actor, bookingId);
  const why = String(reason ?? '').trim() || 'Cancelled by the clinic';
  const r = await cancelBookingSettlement({
    expectedUpdatedAt,
    bookingId: String(b._id), requester: { _id: actor.partnerId, userType: 'clinic' }, desk: deskScopeOf(actor), reason: why, cause: 'clinic', cancelledAt: ymd(istDate(new Date())),
    wallets: new WalletRepository(), enforceWindow: () => undefined, lifecycle: (x) => x.lifecycle,
    inTx: (x, s) => audit(actor, 'clinic.appointment_cancelled', { kind: 'booking', id: String(x._id) }, { reason: why }, s),
  });
  if (!r.alreadyCancelled) await notifyDesk(r.booking, 'cancelled', { reason: why });
  return deskView(r.booking);
}

/** Moved to another slot of the same doctor at this clinic (a branch in the actor's scope). */
export async function rescheduleDeskAppointment(actor: PartnerActor, bookingId: string, slotId: string, expectedUpdatedAt?: Date | string | null, clock: DeskClock = () => new Date()) {
  const b = await ownDeskBooking(actor, bookingId);
  if (!Types.ObjectId.isValid(slotId)) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  const slot = await SlotModel.findById(slotId).lean() as any;
  if (!slot?.branchId) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  await clinicBranch(actor, String(slot.branchId));
  const updated = await rescheduleWithHolds({
    bookingId: String(b._id), requester: { _id: actor.memberId, userType: 'admin' }, nextSlotId: String(slot._id),
    // Q13: the target slot must not have started (checked when the move takes a new slot), and the version must match.
    // Q16a re-review (N4): the appointment being moved may have started — desk appointments are not paid through us, so
    // the clinic may move a late patient any time before it marks them completed or no-show.
    desk: { ...deskScopeOf(actor), refuseStartedClock: clockOf(clock) }, expectedUpdatedAt,
    patch: { bookingDate: slot.date },
    inTx: (x, s) => audit(actor, 'clinic.appointment_rescheduled', { kind: 'booking', id: String(x._id) }, { slotId: String(slot._id) }, s),
  });
  await notifyDesk(updated, 'moved');
  return deskView(updated);
}

/**
 * Q14: a desk appointment marked no-show is moved once to a later slot of the same doctor at this clinic and confirmed
 * again (nothing is paid or refunded through us); exactly once per (appointment, request key); a second no-show is final.
 */
export async function rescheduleDeskNoShow(actor: PartnerActor, bookingId: string, input: { slotId: string; requestKey: string; expectedUpdatedAt?: Date | string | null },
  clock: DeskClock = () => new Date()) {
  const b = await ownDeskBooking(actor, bookingId);
  if (!Types.ObjectId.isValid(input.slotId)) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  const slot = await SlotModel.findById(input.slotId).lean() as any;
  if (!slot?.branchId) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  await clinicBranch(actor, String(slot.branchId));
  const desk = { ...deskScopeOf(actor), refuseStartedClock: clockOf(clock) };
  const id = String(b._id).toLowerCase();
  const updated = await rescheduleWithHolds({
    bookingId: id, requester: { _id: actor.memberId, userType: 'admin' }, nextSlotId: String(slot._id), desk, expectedUpdatedAt: input.expectedUpdatedAt,
    patch: { bookingDate: slot.date },
    noShow: { owner: { 'clinicDesk.partnerId': actor.partnerId }, by: actor.memberId, byKind: 'clinic', keyScope: `booking_no_show_reschedule:${id}`,
      requestKey: input.requestKey, requestHash: noShowRescheduleHash(String(slot._id)), startedClock: clockOf(clock) },
    inTx: (x, s) => audit(actor, 'clinic.appointment_no_show_rescheduled', { kind: 'booking', id: String(x._id) }, { slotId: String(slot._id) }, s),
  });
  if (isReplayedBooking(updated)) return { ...deskView(updated), replayed: true };
  await notifyDesk(updated, 'moved');
  return { ...deskView(updated), replayed: false };
}

// ───────────────────────────── Solo practice ─────────────────────────────

export interface SoloPracticeInput {
  name: string; legalName?: string; invoiceSeriesPrefix: string; gstin?: string; pan?: string; contactEmail?: string;
  branch: { name: string; phone: string; address: IBranch['address'] };
  /** Q14: required on POST /specialists/me/clinic (replay by content hash; another clinic 409 DOCTOR_CLINIC_EXISTS). */
  requestKey?: string;
}
const doctorClinicCreatedBy = (doctorId: string) => `doctor:${String(doctorId).toLowerCase()}`;
const soloHash = (input: SoloPracticeInput) => {
  const { requestKey: _k, ...rest } = input;
  return createHash('sha256').update(canonicalStable(rest)).digest('hex');
};
function canonicalStable(v: unknown): string {
  const norm = (x: unknown): unknown => Array.isArray(x) ? x.map(norm)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x as object).sort().filter((k) => (x as any)[k] !== undefined && (x as any)[k] !== null).map((k) => [k, norm((x as any)[k])]))
    : typeof x === 'string' ? x.trim() : x;
  return JSON.stringify(norm(v));
}

/** Q14: the clinic a doctor created with this request key (a lost answer); null when none. */
export async function findDoctorClinicByKey(doctorId: string, key: string) {
  const partner = await PartnerOrgModel.findOne({ soloDoctorId: String(doctorId), createdBy: doctorClinicCreatedBy(doctorId), createRequestKey: { $eq: key } }).lean() as any;
  if (!partner) return null;
  return { partner, branches: await BranchModel.find({ partnerId: String(partner._id) }).lean() };
}

/**
 * A doctor's own practice: a clinic partner (solo) they own, with one in-clinic branch and a settlement account. One per
 * doctor (unique soloDoctorId); a repeat returns it. It starts pending: an admin verifies it (and sets the tax regime)
 * before its in-clinic slots can be booked. The doctor signs in to the workspace with their mobile number.
 */
export async function createSoloPractice(doctorId: string, input: SoloPracticeInput) {
  // Q14: a keyed create (POST /me/clinic) replays its own clinic and refuses a second one; the unkeyed Q6 route keeps
  // answering with the existing practice.
  const requestHash = soloHash(input);
  const answerExisting = (existing: any) => {
    if (!input.requestKey) return { partner: existing, created: false, replayed: true };
    if (existing.createRequestKey === input.requestKey && existing.createdBy === doctorClinicCreatedBy(doctorId)) {
      if (existing.createRequestHash !== requestHash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different clinic');
      return { partner: existing, created: false, replayed: true };
    }
    throw err(409, 'DOCTOR_CLINIC_EXISTS', 'You already have a clinic; ask the platform team to add another');
  };
  const existing = await PartnerOrgModel.findOne({ soloDoctorId: String(doctorId) }).lean();
  if (existing) return answerExisting(existing);
  const sp = await SpecialistModel.findById(doctorId).lean() as any;
  // Q14: the same eligibility rule as instant consultations (stored isActive and isVerified both true).
  if (!eligibleDoctor(sp)) throw err(403, 'SPECIALIST_NOT_ACTIVE', 'Only active, verified doctors can open a practice');
  const phone = canonicalMobile(sp.phone);
  if (!phone) throw err(409, 'DOCTOR_PHONE_REQUIRED', 'Add a mobile number to your profile first (it is your practice sign-in)');
  try {
    return await inTransaction(async (s) => {
      if (input.requestKey) await claimRequestKey(`doctor_clinic_create:${String(doctorId).toLowerCase()}`, input.requestKey, s);
      const [partner] = await PartnerOrgModel.create([{
        kind: 'clinic', name: input.name.trim(), legalName: input.legalName?.trim() || input.name.trim(), gstin: input.gstin, pan: input.pan,
        contact: { phone, email: input.contactEmail ?? sp.email }, taxRegime: 'unregistered', invoiceSeries: { prefix: input.invoiceSeriesPrefix }, activeOwnerCount: 1,
        solo: true, soloDoctorId: String(doctorId), isActive: true, verification: { state: 'pending', documents: [] },
        ...(input.requestKey ? { createdBy: doctorClinicCreatedBy(doctorId), createRequestKey: input.requestKey, createRequestHash: requestHash } : {}),
      }], { session: s });
      const partnerId = String(partner!._id);
      await ensureSettlementAccount('partner', partnerId, input.legalName?.trim() || input.name.trim(), s);
      const branchId = new Types.ObjectId();
      // The doctor owns the clinic (all permissions). Q14 review: no doctorBranchIds — as before Q14, an owner-doctor
      // without them consults at every branch of the clinic, including branches added later.
      // The owner signs in with their mobile number; as owner they can add a sign-in email through the member edit.
      const [owner] = await MemberModel.create([{ partnerId, phone, name: sp.name, role: 'owner', permissions: [...ALL_PERMISSIONS], branchIds: [],
        doctorId: String(doctorId), isActive: true }], { session: s });
      const [branch] = await BranchModel.create([{ _id: branchId, partnerId, name: input.branch.name, phone: input.branch.phone, address: input.branch.address, hours: {},
        holidays: [], services: { homeCollection: false, inLab: false, inClinic: true }, isActive: true }], { session: s });
      const self: PartnerActor = { memberId: String(owner!._id), partnerId, role: 'owner', permissions: [...ALL_PERMISSIONS], branchIds: [] };
      await audit(self, 'clinic.solo_practice_created', { kind: 'partner', id: partnerId }, { doctorId: String(doctorId), branchId: String(branch!._id) }, s);
      return { partner: partner!.toObject(), branch: branch!.toObject(), created: true };
    });
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
    const raced = await PartnerOrgModel.findOne({ soloDoctorId: String(doctorId) }).lean();
    if (!raced) throw e;
    return answerExisting(raced);
  }
}

export async function mySoloPractice(doctorId: string) {
  const partner = await PartnerOrgModel.findOne({ soloDoctorId: String(doctorId) }).lean() as any;
  if (!partner) return null;
  const branches = await BranchModel.find({ partnerId: String(partner._id) }).lean();
  return { partner, branches };
}
