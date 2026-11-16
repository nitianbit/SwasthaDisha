import { createHash } from 'crypto';
import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { canonicalMobile } from '@/modules/common/utils/phone';
import { parseAppointment } from '@/modules/common/utils/cancellationWindow';
import { slotIntervalOf } from '@/modules/common/utils/slotInterval';
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
import SlotModel from '@/modules/slots/model';
import BookingModel from '@/modules/bookings/model';
import UserModel from '@/modules/user/model';
import { IBooking } from '@/modules/bookings/types';
import {
  assertBookingVersion, cancelBookingSettlement, createBookingWithHolds, deskBookingInScope, isReplayedBooking, rescheduleWithHolds, type DeskScope,
} from '@/modules/bookings/holds';
import { claimRequestKey, abandonRequestKey } from '@/modules/requestKeys';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import DependentModel from '@/modules/dependents/model';
import { DoctorReservationModel } from '@/modules/doctors/model/reservation';
import { releaseInterval } from '@/modules/doctors/services/reservations';
import { clinicBranchAllowed, doctorScopeOf, expandDoctorSlots, DOCTOR_ROLLING_DAYS } from '@/modules/doctors/services/schedule';
import { WalletRepository } from '@/modules/wallet/repository';

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

// ───────────────────────────── Clinic: doctors and invitations ─────────────────────────────

export async function listClinicDoctors(actor: PartnerActor) {
  await clinicOf(actor);
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

/** The clinic asks a doctor (by id or registered phone) to consult at some or all of its branches. Idempotent while pending. */
export async function inviteDoctor(actor: PartnerActor, input: { doctorId?: string; phone?: string; branchIds?: string[] }) {
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
    if (!accept) {
      await ClinicDoctorInviteModel.updateOne({ _id: inviteId, state: 'pending' }, { $set: { state: 'declined', respondedAt: new Date() } }, { session: s });
      return { accepted: false as const, partnerId: inv.partnerId };
    }
    const p = await PartnerOrgModel.findById(inv.partnerId).session(s).lean() as IPartner | null;
    if (!p || p.isActive === false || p.kind !== 'clinic') throw err(409, 'CLINIC_NOT_ACTIVE', 'This clinic is not active');
    if (await MemberModel.exists({ partnerId: inv.partnerId, doctorId: String(doctorId), isActive: true }).session(s)) {
      throw err(409, 'DOCTOR_ALREADY_MEMBER', 'You already consult here');
    }
    const samePhone = await MemberModel.findOne({ partnerId: inv.partnerId, phone, isActive: true }).session(s).lean() as IMember | null;
    let member: IMember;
    if (samePhone) {
      if (samePhone.doctorId) throw err(409, 'PHONE_USED_BY_ANOTHER_DOCTOR', 'Your mobile number belongs to another doctor at this clinic');
      // The staff record keeps its workspace access; the doctor's clinical scope is exactly what they accepted.
      member = await MemberModel.findOneAndUpdate({ _id: samePhone._id, isActive: true, doctorId: { $exists: false } },
        { $set: { doctorId: String(doctorId), doctorBranchIds: inv.branchIds } }, { new: true, session: s }).lean() as IMember;
      if (!member) throw err(409, 'MEMBER_CHANGED', 'Please try again');
    } else {
      const [m] = await MemberModel.create([{ partnerId: inv.partnerId, phone, name: sp.name, role: 'staff', permissions: [], branchIds: inv.branchIds,
        doctorId: String(doctorId), doctorBranchIds: inv.branchIds, isActive: true, invitedBy: inv.invitedBy }], { session: s });
      member = m!.toObject() as IMember;
    }
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
 */
export async function deskSlots(actor: PartnerActor, q: { doctorId: string; branchId: string; date: string }, now = new Date()) {
  await clinicOf(actor);
  await clinicBranch(actor, q.branchId);
  if (!isRealDate(q.date)) throw err(400, 'INVALID_DATE', 'date must be a real date, YYYY-MM-DD');
  if (!(await clinicBranchAllowed(q.doctorId, q.branchId))) throw err(404, 'DOCTOR_NOT_AT_CLINIC', 'This doctor does not consult at this branch');
  const slots = await SlotModel.find({ specialistId: String(q.doctorId), branchId: String(q.branchId), date: ymd(q.date), isActive: true, isAvailable: true,
    $expr: { $lt: [{ $ifNull: ['$currentBookings', 0] }, { $ifNull: ['$maxBookings', 1] }] } }).lean() as any[];
  const inPerson = slots.filter((s) => !(s.serviceModes?.length) || s.serviceModes.includes('in-person'));
  const windows = inPerson.map((s) => ({ s, w: slotIntervalOf(s) })).filter((x) => x.w && x.w.start.getTime() > now.getTime());
  if (!windows.length) return [];
  const held = await DoctorReservationModel.find({ doctorId: String(q.doctorId), isActive: true,
    startTime: { $lt: new Date(Math.max(...windows.map((x) => x.w!.end.getTime()))) }, endTime: { $gt: new Date(Math.min(...windows.map((x) => x.w!.start.getTime()))) } }).lean();
  return windows
    .filter(({ s, w }) => Number(s.maxBookings ?? 1) !== 1 || !held.some((h) => h.startTime < w!.end && h.endTime > w!.start))
    .sort((a, b) => a.w!.start.getTime() - b.w!.start.getTime())
    .map(({ s, w }) => ({ slotId: String(s._id), date: q.date, startTime: s.startTime, endTime: s.endTime, startsAt: w!.start,
      seatsLeft: Number(s.maxBookings ?? 1) - Number(s.currentBookings ?? 0) }));
}

export interface DeskBookingInput { slotId: string; customer: { phone: string; name?: string }; notes?: string; requestKey: string }

/** Q13: request-key scope of desk appointments, per clinic and desk member (claimed in the booking transaction). */
export const deskKeyScope = (actor: PartnerActor) => `clinic_desk_create:${String(actor.partnerId).toLowerCase()}:${String(actor.memberId).toLowerCase()}`;
const storedDeskKey = (actor: PartnerActor, key: string) => `desk:${actor.memberId}:${key}`;
const samePartner = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * A front-desk appointment: the customer (found or created by phone, never merged or overwritten) gets an in-person
 * consultation on a clinic doctor's slot at this clinic. One admission with online bookings (seat, doctor interval,
 * leave, current clinic authority), exactly once per (desk member, request key), audited in the same transaction.
 */
export async function createDeskAppointment(actor: PartnerActor, input: DeskBookingInput, now = new Date()) {
  await clinicOf(actor);
  if (!Types.ObjectId.isValid(input.slotId)) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  const slot = await SlotModel.findById(input.slotId).lean() as any;
  if (!slot?.branchId || !slot.specialistId) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  const branch = await clinicBranch(actor, String(slot.branchId));
  const sp = await SpecialistModel.findById(slot.specialistId).select({ name: 1, consultationFee: 1 }).lean() as any;
  if (!sp) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  // Exactly once per (desk member, request key), whatever customer or slot a repeat names (unique clinicDesk.requestKey).
  const requestKey = storedDeskKey(actor, input.requestKey);
  const requestHash = createHash('sha256').update(JSON.stringify({ slotId: String(slot._id).toLowerCase(),
    phone: canonicalMobile(input.customer.phone) ?? input.customer.phone, notes: input.notes?.trim() || null })).digest('hex');
  // Q13: a slot that has already started is refused, here and again inside the booking transaction.
  const desk: DeskScope = { ...deskScopeOf(actor), refuseStartedAt: now };
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
  if (prior) return { booking: deskView(prior), customer: { userId: String(prior.userId), phone: canonicalMobile(input.customer.phone), created: false }, replayed: true };
  // Q13: refused before a customer is resolved or created (the in-transaction claim and slot admission decide finally).
  if (await RequestKeyModel.exists({ scope: deskKeyScope(actor), key: input.requestKey, state: 'abandoned' })) {
    throw err(409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
  }
  const startsAt = slotIntervalOf(slot)?.start;
  if (!startsAt || startsAt.getTime() <= now.getTime()) throw err(409, 'SLOT_STARTED', 'This slot has already started; choose a later one');
  const customer = await resolveCustomerByPhone(input.customer.phone, 'clinic_desk');
  const name = input.customer.name?.trim();
  if (name) await UserModel.updateOne({ _id: customer._id, $or: [{ name: { $exists: false } }, { name: null }, { name: '' }] }, { $set: { name } });
  const fee = Number(sp.consultationFee) > 0 ? Number(sp.consultationFee) : 0;
  let booking: IBooking;
  try {
    // The clinic and branch are admitted (and recorded) on the slot as the booking transaction reads it (deskScope).
    booking = await createBookingWithHolds({
      bookingType: 'consultation', userId: customer._id, specialistId: String(slot.specialistId), doctorName: sp.name, slotId: String(slot._id),
      bookingDate: slot.date, bookingTime: slot.startTime, consultationMode: 'in-person', serviceMode: 'in-person', price: fee, originalPrice: fee,
      status: 'confirmed', paymentStatus: 'pending',
      clinicDesk: { partnerId: actor.partnerId, branchId: String(branch._id), createdBy: actor.memberId, requestKey, requestHash },
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    } as IBooking, async (b, s) => {
      // Q13: the key is claimed with the appointment, so a desk's give-up of a lost answer and this booking cannot both win.
      await claimRequestKey(deskKeyScope(actor), input.requestKey, s);
      await audit(actor, 'clinic.appointment_booked', { kind: 'booking', id: String(b._id) },
        { doctorId: String(slot.specialistId), branchId: b.clinicDesk?.branchId, slotId: String(slot._id), customerCreated: customer.created }, s);
    }, desk);
  } catch (e: any) {
    // A racing identical request may have committed first (seat taken, or the unique key): answer with its receipt.
    const raced = await replay();
    if (!raced) throw e;
    return { booking: deskView(raced), customer: { userId: String(raced.userId), phone: customer.phone, created: false }, replayed: true };
  }
  if (isReplayedBooking(booking)) {
    const r = asReceipt(booking);
    return { booking: deskView(r), customer: { userId: String(r.userId), phone: customer.phone, created: false }, replayed: true };
  }
  return { booking: deskView(booking), customer: { userId: customer._id, phone: customer.phone, created: customer.created }, replayed: false };
}

function deskView(b: IBooking) {
  return { bookingId: String(b._id), bookingDate: b.bookingDate, bookingTime: b.bookingTime, status: b.status, doctorId: b.specialistId,
    doctorName: b.doctorName, branchId: b.clinicDesk?.branchId, slotId: b.slotId, consultationMode: b.consultationMode, fee: b.price,
    payAtClinic: b.settlementSystem === 'clinic', arrivedAt: b.clinicDesk?.arrivedAt,
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

/** Clinic appointments (desk and online) at the clinic's branches in scope, for up to 31 days. */
export async function listClinicAppointments(actor: PartnerActor, q: { from: string; to: string; doctorId?: string; branchId?: string; status?: string }) {
  await clinicOf(actor);
  if (!isRealDate(q.from) || !isRealDate(q.to) || q.to < q.from) throw err(400, 'INVALID_DATE', 'from/to must be real dates, from ≤ to');
  if (q.to > addDays(q.from, MAX_RANGE_DAYS - 1)) throw err(400, 'RANGE_TOO_LONG', `At most ${MAX_RANGE_DAYS} days at a time`);
  let branchIds = (await BranchModel.find({ partnerId: actor.partnerId }).select({ _id: 1 }).lean()).map((b) => String(b._id));
  if (!hasGlobalScope(actor)) branchIds = branchIds.filter((b) => actor.branchIds.includes(b));
  if (q.branchId) {
    assertBranchInScope(actor, q.branchId);
    branchIds = branchIds.filter((b) => b === String(q.branchId));
  }
  const from = ymd(q.from);
  const to = ymd(q.to);
  // Ownership is the booking's own frozen association (desk rows: their clinicDesk only), never a slot's current branch.
  const rows = await BookingModel.find({
    bookingType: 'consultation', bookingDate: { $gte: from, $lte: to }, ...(q.status ? { status: q.status } : {}), ...(q.doctorId ? { specialistId: String(q.doctorId) } : {}),
    $or: [
      { 'clinicDesk.partnerId': actor.partnerId, 'clinicDesk.branchId': { $in: branchIds } },
      { clinicDesk: { $exists: false }, 'clinicVisit.partnerId': actor.partnerId, 'clinicVisit.branchId': { $in: branchIds } },
    ],
  }).sort({ bookingDate: 1, bookingTime: 1 }).limit(1000).lean() as IBooking[];
  const users = await UserModel.find({ _id: { $in: [...new Set(rows.map((r) => String(r.userId)))].filter((u) => Types.ObjectId.isValid(u)) } })
    .select({ name: 1, phone: 1 }).lean() as any[];
  const uById = new Map(users.map((u) => [String(u._id), u]));
  const depIds = [...new Set(rows.map((r) => (r as { dependentId?: string }).dependentId).filter((d): d is string => !!d && Types.ObjectId.isValid(d)))];
  const deps = depIds.length ? await DependentModel.find({ _id: { $in: depIds } }).select({ name: 1, relationship: 1 }).lean() as any[] : [];
  const dById = new Map(deps.map((d) => [String(d._id), d]));
  return rows.map((r) => {
    const account = uById.get(String(r.userId));
    const dep = (r as { dependentId?: string }).dependentId ? dById.get(String((r as { dependentId?: string }).dependentId)) : undefined;
    return {
      ...deskView(r), branchId: r.clinicDesk?.branchId ?? r.clinicVisit?.branchId,
      source: r.clinicDesk ? 'desk' : 'online', paidOnline: r.settlementSystem !== 'clinic' && r.paymentStatus === 'paid',
      // The person being seen (a family member when booked for one); the account holder's mobile is the contact.
      patient: { name: dep?.name ?? account?.name, relationship: dep?.relationship, accountName: dep ? account?.name : undefined, phone: account?.phone },
    };
  });
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
    const at = parseAppointment({ bookingDate: b.bookingDate, bookingTime: b.bookingTime });
    if (outcome === 'no_show' && (!at || now < at.at)) throw err(409, 'APPOINTMENT_NOT_STARTED', 'A no-show can be marked only after the appointment time');
    const r = await BookingModel.findOneAndUpdate({ _id: b._id, status: 'confirmed', 'clinicDesk.partnerId': actor.partnerId, ...atBranch(b) },
      { $set: { status: outcome } }, { new: true, session: s }).lean() as IBooking | null;
    if (!r) throw err(409, 'BOOKING_CHANGED', 'The appointment changed; reload');
    await releaseInterval('scheduled', String(b._id).toLowerCase(), s);
    await audit(actor, outcome === 'completed' ? 'clinic.appointment_completed' : 'clinic.appointment_no_show', { kind: 'booking', id: String(b._id) }, {}, s);
    return deskView(r);
  });
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
  return deskView(r.booking);
}

/** Moved to another slot of the same doctor at this clinic (a branch in the actor's scope). */
export async function rescheduleDeskAppointment(actor: PartnerActor, bookingId: string, slotId: string, expectedUpdatedAt?: Date | string | null, now = new Date()) {
  const b = await ownDeskBooking(actor, bookingId);
  if (!Types.ObjectId.isValid(slotId)) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  const slot = await SlotModel.findById(slotId).lean() as any;
  if (!slot?.branchId) throw err(409, 'SLOT_NOT_AVAILABLE', 'Slot is not available');
  await clinicBranch(actor, String(slot.branchId));
  const updated = await rescheduleWithHolds({
    bookingId: String(b._id), requester: { _id: actor.memberId, userType: 'admin' }, nextSlotId: String(slot._id),
    // Q13: the target slot must not have started (checked when the move takes a new slot), and the version must match.
    desk: { ...deskScopeOf(actor), refuseStartedAt: now }, expectedUpdatedAt,
    patch: { bookingDate: slot.date },
    inTx: (x, s) => audit(actor, 'clinic.appointment_rescheduled', { kind: 'booking', id: String(x._id) }, { slotId: String(slot._id) }, s),
  });
  return deskView(updated);
}

// ───────────────────────────── Solo practice ─────────────────────────────

export interface SoloPracticeInput {
  name: string; legalName?: string; invoiceSeriesPrefix: string; gstin?: string; pan?: string;
  branch: { name: string; phone: string; address: IBranch['address'] };
}

/**
 * A doctor's own practice: a clinic partner (solo) they own, with one in-clinic branch and a settlement account. One per
 * doctor (unique soloDoctorId); a repeat returns it. It starts pending: an admin verifies it (and sets the tax regime)
 * before its in-clinic slots can be booked. The doctor signs in to the workspace with their mobile number.
 */
export async function createSoloPractice(doctorId: string, input: SoloPracticeInput) {
  const existing = await PartnerOrgModel.findOne({ soloDoctorId: String(doctorId) }).lean();
  if (existing) return { partner: existing, created: false };
  const sp = await SpecialistModel.findById(doctorId).lean() as any;
  if (!sp || sp.isActive === false || sp.isVerified === false) throw err(403, 'SPECIALIST_NOT_ACTIVE', 'Only active, verified doctors can open a practice');
  const phone = canonicalMobile(sp.phone);
  if (!phone) throw err(409, 'DOCTOR_PHONE_REQUIRED', 'Add a mobile number to your profile first (it is your practice sign-in)');
  try {
    return await inTransaction(async (s) => {
      const [partner] = await PartnerOrgModel.create([{
        kind: 'clinic', name: input.name.trim(), legalName: input.legalName?.trim() || input.name.trim(), gstin: input.gstin, pan: input.pan,
        contact: { phone, email: sp.email }, taxRegime: 'unregistered', invoiceSeries: { prefix: input.invoiceSeriesPrefix }, activeOwnerCount: 1,
        solo: true, soloDoctorId: String(doctorId), isActive: true, verification: { state: 'pending', documents: [] },
      }], { session: s });
      const partnerId = String(partner!._id);
      await ensureSettlementAccount('partner', partnerId, input.legalName?.trim() || input.name.trim(), s);
      const [owner] = await MemberModel.create([{ partnerId, phone, name: sp.name, role: 'owner', permissions: [...ALL_PERMISSIONS], branchIds: [],
        doctorId: String(doctorId), isActive: true }], { session: s });
      const [branch] = await BranchModel.create([{ partnerId, name: input.branch.name, phone: input.branch.phone, address: input.branch.address, hours: {},
        holidays: [], services: { homeCollection: false, inLab: false, inClinic: true }, isActive: true }], { session: s });
      const self: PartnerActor = { memberId: String(owner!._id), partnerId, role: 'owner', permissions: [...ALL_PERMISSIONS], branchIds: [] };
      await audit(self, 'clinic.solo_practice_created', { kind: 'partner', id: partnerId }, { doctorId: String(doctorId), branchId: String(branch!._id) }, s);
      return { partner: partner!.toObject(), branch: branch!.toObject(), created: true };
    });
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
    const raced = await PartnerOrgModel.findOne({ soloDoctorId: String(doctorId) }).lean();
    if (!raced) throw e;
    return { partner: raced, created: false };
  }
}

export async function mySoloPractice(doctorId: string) {
  const partner = await PartnerOrgModel.findOne({ soloDoctorId: String(doctorId) }).lean() as any;
  if (!partner) return null;
  const branches = await BranchModel.find({ partnerId: String(partner._id) }).lean();
  return { partner, branches };
}
