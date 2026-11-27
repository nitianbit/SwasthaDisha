import type { ProfessionalKind } from '@/modules/partners/types';
import { claimRequestKey, abandonRequestKey } from '@/modules/requestKeys';
import { createHash } from 'crypto';
import BranchModel from '@/modules/partners/model/branch';
import MemberModel from '@/modules/partners/model/member';
import PartnerModel from '@/modules/partners/model';
import { Service } from 'typedi';
import mongoose, { ClientSession, isValidObjectId } from 'mongoose';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import { ScheduleGuardModel } from '@/modules/partners/model/slot';
import { ensureSettlementAccount } from '@/modules/partners/services/settlement';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import {
  IPartner,
  IMember,
  IBranch,
  PartnerPermission,
  ALL_PERMISSIONS,
  PartnerKind,
  TaxRegime,
  MemberRole,
} from '@/modules/partners/types';
import { AppError } from '@/modules/common/types';

/** The admitted member making a request; always loaded from the database, never from the request body. */
export interface PartnerActor {
  memberId: string;
  partnerId: string;
  role: MemberRole;
  permissions: PartnerPermission[];
  /** Empty = every branch of the partner. */
  branchIds: string[];
  /** 'admin': a platform admin acting with owner authority on this partner (memberId is `admin:<adminId>`). */
  actorKind?: 'member' | 'admin';
}

export function adminActor(adminId: string, partnerId: string): PartnerActor {
  return {
    memberId: `admin:${adminId}`,
    // Q16b: the canonical (lowercase) id, as members' actors carry it, so an admin URL's spelling never makes rows
    // under a second spelling of the partner.
    partnerId: canonicalPartnerId(partnerId),
    role: 'owner',
    permissions: [...ALL_PERMISSIONS],
    branchIds: [],
    actorKind: 'admin',
  };
}

/** ObjectId hex lower-cased (the form String(partner._id) has); anything else unchanged. */
export const canonicalPartnerId = (id: string): string => (/^[0-9a-fA-F]{24}$/.test(String(id)) ? String(id).toLowerCase() : String(id));

const scopeExceeded = (message: string) => new AppError({ status: 403, code: 'BRANCH_SCOPE_EXCEEDED', message });
const memberNotFound = () => new AppError({ status: 404, code: 'MEMBER_NOT_FOUND', message: 'Member not found in this partner' });
const branchNotFound = () => new AppError({ status: 404, code: 'BRANCH_NOT_FOUND', message: 'Branch not found' });

export function hasGlobalScope(actor: Pick<PartnerActor, 'role' | 'branchIds'>): boolean {
  return actor.role === 'owner' || actor.branchIds.length === 0;
}

/** A restricted actor may only hand out a non-empty scope inside its own (empty would mean every branch). */
export function assertScopeWithin(actor: Pick<PartnerActor, 'role' | 'branchIds'>, target: string[]): void {
  if (hasGlobalScope(actor)) return;
  if (target.length === 0) throw scopeExceeded('A branch-restricted member cannot grant access to all branches');
  const outside = target.filter((b) => !actor.branchIds.includes(String(b)));
  if (outside.length > 0) throw scopeExceeded('Cannot grant access to branches outside your own scope');
}

export function assertBranchInScope(actor: Pick<PartnerActor, 'role' | 'branchIds'>, branchId: string): void {
  if (hasGlobalScope(actor)) return;
  if (!actor.branchIds.includes(String(branchId))) throw scopeExceeded('Operation not allowed for this branch');
}

/** A restricted actor sees/manages only staff whose whole scope lies inside its own; never owners or global staff. */
export function memberInScope(actor: Pick<PartnerActor, 'role' | 'branchIds'>, member: Pick<IMember, 'role' | 'branchIds'>): boolean {
  if (hasGlobalScope(actor)) return true;
  if (member.role === 'owner') return false;
  const scope = (member.branchIds ?? []).map(String);
  return scope.length > 0 && scope.every((b) => actor.branchIds.includes(b));
}

/** Audit trail (§8): who did what to which record. Written in the operation's transaction when it has one. */
export async function recordPartnerAudit(
  actor: PartnerActor,
  action: string,
  target?: { kind: string; id: string },
  detail?: Record<string, unknown>,
  session?: ClientSession
): Promise<void> {
  const isAdmin = actor.actorKind === 'admin';
  await PartnerAuditEventModel.create([{
    partnerId: actor.partnerId,
    actorKind: isAdmin ? 'admin' : 'member',
    actorId: isAdmin ? actor.memberId.replace(/^admin:/, '') : actor.memberId,
    action,
    targetKind: target?.kind,
    targetId: target?.id,
    detail,
    at: new Date(),
  }], session ? { session } : {});
}

/** Runs `fn` in one transaction (retried on transient conflicts): a mutation and its audit commit or roll back together. */
export async function inTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } finally {
    await session.endSession();
  }
}

/** A branch's holidays/services/active state shape both of its generated schedules: bump their guards in the change. */
async function ensureBranchScheduleGuards(branchId: string): Promise<void> {
  for (const mode of ['lab', 'home']) {
    try { await ScheduleGuardModel.updateOne({ key: `partner-slots:${branchId}:${mode}` }, { $setOnInsert: { key: `partner-slots:${branchId}:${mode}`, version: 0 } }, { upsert: true }); }
    catch (e: any) { if (e?.code !== 11000) throw e; }
  }
}
async function bumpBranchScheduleGuards(branchId: string, session: ClientSession): Promise<void> {
  await ScheduleGuardModel.updateMany({ key: { $in: [`partner-slots:${branchId}:lab`, `partner-slots:${branchId}:home`] } }, { $inc: { version: 1 } }, { session });
}

/**
 * Q8: after a clinic branch reopens or its partner is reinstated, the doctors whose weekly windows name those branches
 * are expanded again (the guarded doctor expansion: booked holds and manual closures are kept). Best effort per doctor.
 */
async function refreshDoctorsAt(branchIds: string[]): Promise<void> {
  if (!branchIds.length) return;
  const { DoctorScheduleTemplateModel } = await import('@/modules/doctors/model/schedule');
  const { expandDoctorSlots, DOCTOR_ROLLING_DAYS } = await import('@/modules/doctors/services/schedule');
  const { istDate } = await import('@/modules/partners/services/slots');
  const or = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => ({ [`days.${d}.branchId`]: { $in: branchIds } }));
  const templates = await DoctorScheduleTemplateModel.find({ isActive: true, $or: or }).select({ doctorId: 1 }).lean() as { doctorId: string }[];
  for (const t of templates) {
    try { await expandDoctorSlots(t.doctorId, istDate(new Date()), DOCTOR_ROLLING_DAYS); }
    catch (e) { console.error('doctor slot refresh failed', (e as Error)?.message); }
  }
}

/** Q10: request-key scope of an admin's partner creations. */
export const partnerCreateScope = (adminId: string) => `partner_create:${String(adminId).toLowerCase()}`;

/** Q10: the fence an edit adds when the editor sent the version (updatedAt) it started from. */
const versionFence = (expected?: Date | string) => (expected ? { updatedAt: new Date(expected) } : {});
const recordChanged = () => new AppError({ status: 409, code: 'RECORD_CHANGED', message: 'Someone else changed this meanwhile; reload and review' });

/** A member's sign-in email: trimmed and lower-cased; empty = none. */
export const normalizeMemberEmail = (email?: string | null): string | undefined => {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return e || undefined;
};
const emailInUse = () => new AppError({ status: 409, code: 'EMAIL_IN_USE', message: 'Another active member of this partner already signs in with this email' });
/** A duplicate-key error raised by the member email index (rather than the phone index). */
const isEmailDuplicate = (e: any) => e?.code === 11000 && (!!e?.keyPattern?.email || /email_1_partnerId_1/.test(String(e?.message ?? '')));
async function assertMemberEmailFree(partnerId: string, email: string | undefined, exceptMemberId?: string, session?: ClientSession): Promise<void> {
  if (!email) return;
  const q = MemberModel.exists({ partnerId, email, isActive: true, ...(exceptMemberId ? { _id: { $ne: exceptMemberId } } : {}) });
  if (session) q.session(session);
  if (await q) throw emailInUse();
}

const ownerEmailAdminOnly = () => new AppError({ status: 403, code: 'OWNER_EMAIL_ADMIN_ONLY',
  message: "An owner's sign-in email can be set or changed only by the Jansetu team" });
const useDoctorUnlink = () => new AppError({ status: 409, code: 'USE_DOCTOR_UNLINK',
  message: 'This member is a doctor of the clinic: remove the doctor from the clinic instead (owner or admin)' });

type EmailChange = 'set' | 'changed' | 'removed';
const maskEmail = (e?: string) => {
  if (!e) return '';
  const [local, domain] = e.split('@');
  return `${(local ?? '').slice(0, 2)}***@${domain ?? ''}`;
};

/**
 * Q16b (owner, 22 Nov): a member is told when their sign-in email is set, changed or removed — an in-app notification
 * (GET /partner-workspace/me/notifications) and, when an SMS sender and its DLT template (SMS_TEMPLATE_ID_MEMBER_EMAIL)
 * are configured, an SMS to the member's phone. After the commit, best effort: a failure never affects the change.
 */
export async function notifyMemberEmailChange(member: Pick<IMember, '_id' | 'partnerId' | 'phone' | 'email' | 'name'>, actor: PartnerActor, change: EmailChange): Promise<void> {
  const by = actor.actorKind === 'admin' ? 'the Jansetu team' : 'an owner of your workspace';
  let partnerName = 'your workspace';
  try {
    const p = await PartnerModel.findById(String(member.partnerId)).select({ name: 1 }).lean() as { name?: string } | null;
    if (p?.name) partnerName = p.name;
  } catch { /* the name is only for the text */ }
  const what = change === 'removed' ? 'was removed' : `is now ${maskEmail(member.email)}`;
  const message = `Your sign-in email for ${partnerName} ${what} (changed by ${by}). If you did not expect this, tell your workspace owner or Jansetu support.`;
  try {
    const { Container } = await import('typedi');
    const { NotificationService } = await import('@/modules/notification/services');
    await Container.get(NotificationService).create({ userId: String(member._id), type: 'general', title: 'Your sign-in email changed', message,
      referenceType: 'partner_member', referenceId: String(member._id), data: { partnerId: String(member.partnerId), change } } as never);
  } catch (e) { console.error('member email notification failed', (e as Error)?.message); }
  try {
    const { CONFIG } = await import('@/config/config');
    if (!CONFIG.SMS_TEMPLATE_ID_MEMBER_EMAIL || !CONFIG.SMS_API_BASE_URL || !CONFIG.SMS_USERNAME || !CONFIG.SMS_PASSWORD || !CONFIG.SMS_FROM || !member.phone) return;
    const { Container } = await import('typedi');
    const { SMSService } = await import('@/modules/sms/services');
    const sms = Container.get(SMSService);
    const content = sms.buildSMSContent('member_email', { supplierName: partnerName.slice(0, 30), change });
    await sms.sendSMS({ to: member.phone, text: content.text, templateId: content.templateId });
  } catch (e) { console.error('member email SMS failed', (e as Error)?.message); }
}

@Service()
export class PartnerService {
  constructor(
    private partnerRepository: PartnerRepository,
    private memberRepository: MemberRepository,
    private branchRepository: BranchRepository
  ) {}

  async createPartner(data: {
    kind: PartnerKind;
    name: string;
    legalName?: string;
    gstin?: string;
    pan?: string;
    contactPhone: string;
    contactEmail?: string;
    taxRegime?: TaxRegime;
    invoiceSeriesPrefix: string;
    solo?: boolean;
    firstOwner: { phone: string; name: string; email?: string };
    /** Q8: admin create is exactly once per (admin, requestKey); a repeat with other content is refused. */
    requestKey?: string;
    createdBy?: string;
    /** Q16b: the admin creating it (audited as the actor); defaults to createdBy. */
    adminId?: string;
  }): Promise<{ partner: IPartner; owner: IMember; replayed?: boolean }> {
    const { requestKey, createdBy, adminId: _a, ...content } = data;
    // Canonical (key-order independent) so an identical retry with reordered fields is the same request.
    const { canonicalJson } = await import('@/modules/partners/services/invoice');
    const requestHash = requestKey ? createHash('sha256').update(canonicalJson(content)).digest('hex') : undefined;
    const replay = async () => {
      if (!requestKey || !createdBy) return null;
      const p = await PartnerModel.findOne({ createdBy, createRequestKey: requestKey }).lean() as (IPartner & { createRequestHash?: string }) | null;
      if (!p) return null;
      if (p.createRequestHash !== requestHash) throw new AppError({ status: 409, code: 'REQUEST_KEY_REUSED', message: 'This request key was already used for a different partner' });
      const owner = await MemberModel.findOne({ partnerId: String(p._id), role: 'owner' }).sort({ createdAt: 1 }).lean() as IMember;
      return { partner: p as IPartner, owner, replayed: true };
    };
    const prior = await replay();
    if (prior) return prior;
    try {
      return await this.createPartnerOnce(data, requestHash);
    } catch (e: any) {
      if (e?.code !== 11000) throw e;
      const raced = await replay();
      if (!raced) throw e;
      return raced;
    }
  }

  private async createPartnerOnce(data: Parameters<PartnerService['createPartner']>[0], requestHash?: string): Promise<{ partner: IPartner; owner: IMember }> {
    return inTransaction(async (session) => {
      // Q10: claimed with the partner, so an admin's abandon of a lost create and this create cannot both win.
      if (data.requestKey && data.createdBy) await claimRequestKey(partnerCreateScope(data.createdBy), data.requestKey, session);
      const partner = await this.partnerRepository.save(
        {
          kind: data.kind,
          name: data.name,
          legalName: data.legalName,
          gstin: data.gstin,
          pan: data.pan,
          contact: { phone: data.contactPhone, email: data.contactEmail },
          taxRegime: data.taxRegime || 'unregistered',
          invoiceSeries: { prefix: data.invoiceSeriesPrefix },
          activeOwnerCount: 1,
          solo: data.solo,
          ...(data.requestKey && data.createdBy ? { createdBy: data.createdBy, createRequestKey: data.requestKey, createRequestHash: requestHash } : {}),
          isActive: true,
          verification: { state: 'pending', documents: [] },
        } as Partial<IPartner>,
        { session }
      );

      // §7a: a partner gets its settlement account when it is created.
      await ensureSettlementAccount('partner', String(partner._id), data.legalName || data.name, session);

      const owner = await this.memberRepository.save(
        {
          partnerId: partner._id!,
          phone: data.firstOwner.phone,
          ...(normalizeMemberEmail(data.firstOwner.email) ? { email: normalizeMemberEmail(data.firstOwner.email) } : {}),
          name: data.firstOwner.name,
          role: 'owner' as MemberRole,
          permissions: [...ALL_PERMISSIONS],
          branchIds: [],
          isActive: true,
        } as Partial<IMember>,
        { session }
      );
      // Q16b: admin partner actions are audited in their transaction, with the admin as actor.
      await recordPartnerAudit(adminActor(data.adminId ?? data.createdBy ?? 'unknown', String(partner._id)), 'partner.create',
        { kind: 'partner', id: String(partner._id) }, { kind: data.kind, ownerMemberId: String(owner._id), solo: !!data.solo }, session);

      return { partner, owner };
    });
  }

  /** Q10: what an admin's create key produced (their own keys only); null when nothing was created under it. */
  async findCreatedByKey(adminId: string, key: string): Promise<{ partner: IPartner; owner: IMember } | null> {
    const p = await PartnerModel.findOne({ createdBy: adminId, createRequestKey: key }).lean() as IPartner | null;
    if (!p) return null;
    const owner = await MemberModel.findOne({ partnerId: String(p._id), role: 'owner' }).sort({ createdAt: 1 }).lean() as IMember;
    return { partner: p, owner };
  }

  /** Q10: give up a lost create: abandoned (it can never be created) or used (here is the partner). */
  async abandonCreateKey(adminId: string, key: string): Promise<{ state: 'abandoned' | 'used'; partner?: IPartner }> {
    // A partner created under this key before claims existed (Q8 rows without a claim) is reconciled first.
    const existing = await this.findCreatedByKey(adminId, key);
    if (existing) return { state: 'used', partner: existing.partner };
    const state = await abandonRequestKey(partnerCreateScope(adminId), key);
    if (state === 'abandoned') return { state };
    return { state, partner: (await this.findCreatedByKey(adminId, key))?.partner };
  }

  async getPartnerById(id: string): Promise<IPartner> {
    const partner = await this.partnerRepository.findById(id);
    if (!partner) {
      throw new AppError({ status: 404, code: 'PARTNER_NOT_FOUND', message: 'Partner not found' });
    }
    return partner;
  }

  async listPartners(filter: {
    kind?: PartnerKind;
    verificationState?: string;
    isActive?: boolean;
    q?: string;
    page?: number;
    limit?: number;
  }): Promise<{ items: IPartner[]; page: number; limit: number; total: number; totalPages: number }> {
    const query: any = {};
    if (filter.kind) query.kind = filter.kind;
    if (filter.verificationState) query['verification.state'] = filter.verificationState;
    if (filter.isActive !== undefined) query.isActive = filter.isActive;
    if (filter.q?.trim()) query.name = { $regex: filter.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
    const page = Math.max(Number(filter.page) || 1, 1);
    const [items, total] = await Promise.all([
      PartnerModel.find(query).sort({ name: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean().then((r) => r as unknown as IPartner[]),
      PartnerModel.countDocuments(query),
    ]);
    return { items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async updatePartner(
    partnerId: string,
    data: {
      name?: string;
      legalName?: string;
      gstin?: string;
      pan?: string;
      contactPhone?: string;
      contactEmail?: string;
      taxRegime?: TaxRegime;
      invoiceSeriesPrefix?: string;
      logo?: string;
      allowPartPayments?: boolean;
      expectedUpdatedAt?: Date | string;
    },
    session?: ClientSession
  ): Promise<IPartner> {
    const update: any = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.legalName !== undefined) update.legalName = data.legalName;
    if (data.gstin !== undefined) update.gstin = data.gstin;
    if (data.pan !== undefined) update.pan = data.pan;
    if (data.contactPhone !== undefined) update['contact.phone'] = data.contactPhone;
    if (data.contactEmail !== undefined) update['contact.email'] = data.contactEmail;
    if (data.taxRegime !== undefined) update.taxRegime = data.taxRegime;
    if (data.invoiceSeriesPrefix !== undefined) update['invoiceSeries.prefix'] = data.invoiceSeriesPrefix;
    if (data.logo !== undefined) update.logo = data.logo;
    if (data.allowPartPayments !== undefined) update.allowPartPayments = data.allowPartPayments;

    const updated = await this.partnerRepository.update({ _id: partnerId, ...versionFence(data.expectedUpdatedAt) }, update, { new: true, ...(session ? { session } : {}) } as any);
    if (!updated) {
      if (data.expectedUpdatedAt && await PartnerModel.exists({ _id: partnerId })) throw recordChanged();
      throw new AppError({ status: 404, code: 'PARTNER_NOT_FOUND', message: 'Partner not found' });
    }
    return updated;
  }

  /** Q16b: the admin edit (PUT /partner-workspace/admin/:partnerId), audited with the admin as actor in its transaction. */
  async adminUpdatePartner(partnerId: string, data: Parameters<PartnerService['updatePartner']>[1], adminId: string): Promise<IPartner> {
    const id = canonicalPartnerId(partnerId);
    return inTransaction(async (session) => {
      const updated = await this.updatePartner(id, data, session);
      const { expectedUpdatedAt: _e, ...fields } = data;
      await recordPartnerAudit(adminActor(adminId, id), 'partner.update', { kind: 'partner', id },
        { fields: Object.keys(fields).filter((k) => (fields as Record<string, unknown>)[k] !== undefined) }, session);
      return updated;
    });
  }

  async updateOwnProfile(
    actor: PartnerActor,
    data: { name?: string; legalName?: string; contactPhone?: string; contactEmail?: string; logo?: string; allowPartPayments?: boolean; expectedUpdatedAt?: Date | string }
  ): Promise<IPartner> {
    // Q8: the partner's public identity and contact are the owners' to change (admins act as owner).
    if (actor.role !== 'owner') throw new AppError({ status: 403, code: 'OWNER_REQUIRED', message: 'Only an owner can change the partner profile' });
    const { name, legalName, contactPhone, contactEmail, logo, allowPartPayments } = data;
    const fields = { name, legalName, contactPhone, contactEmail, logo, allowPartPayments };
    return inTransaction(async (session) => {
      const updated = await this.updatePartner(actor.partnerId, { ...fields, expectedUpdatedAt: data.expectedUpdatedAt }, session);
      await recordPartnerAudit(actor, 'partner.profile.update', { kind: 'partner', id: actor.partnerId },
        { fields: Object.keys(fields).filter((k) => (fields as any)[k] !== undefined) }, session);
      return updated;
    });
  }

  /** Pending -> verified (admin), audited with the admin as actor in the same transaction. */
  async verifyPartner(partnerId: string, verifiedBy: string): Promise<IPartner> {
    const id = canonicalPartnerId(partnerId);
    return inTransaction(async (session) => {
      const updated = await this.partnerRepository.update(
        { _id: id, 'verification.state': 'pending' },
        { 'verification.state': 'verified', 'verification.verifiedAt': new Date(), 'verification.verifiedBy': verifiedBy },
        { new: true, session } as any
      );
      if (!updated) {
        throw new AppError({ status: 409, code: 'VERIFICATION_STATE_CONFLICT', message: 'Partner is not in pending state' });
      }
      await recordPartnerAudit(adminActor(verifiedBy, id), 'partner.verify', { kind: 'partner', id }, undefined, session);
      return updated;
    });
  }

  /**
   * Admin: the partner stops (inactive, state suspended). Q16b: the state it replaced (pending or verified) is kept, so a
   * reinstate restores exactly that; audited with the admin as actor in the same transaction.
   */
  async suspendPartner(partnerId: string, adminId = 'unknown'): Promise<IPartner> {
    const id = canonicalPartnerId(partnerId);
    return inTransaction(async (session) => {
      const current = await PartnerModel.findById(id).session(session).select({ verification: 1 }).lean() as IPartner | null;
      if (!current) throw new AppError({ status: 404, code: 'PARTNER_NOT_FOUND', message: 'Partner not found' });
      const before = current.verification?.state;
      if (before === 'suspended') throw new AppError({ status: 409, code: 'ALREADY_SUSPENDED', message: 'Partner is already suspended' });
      const updated = await this.partnerRepository.update(
        { _id: id, 'verification.state': before },
        { 'verification.state': 'suspended', 'verification.stateBeforeSuspension': before === 'verified' ? 'verified' : 'pending', isActive: false },
        { new: true, session } as any
      );
      if (!updated) throw new AppError({ status: 409, code: 'ALREADY_SUSPENDED', message: 'Partner is already suspended' });
      await recordPartnerAudit(adminActor(adminId, id), 'partner.suspend', { kind: 'partner', id }, { previousState: before }, session);
      return updated;
    });
  }

  /**
   * Q8: a suspended partner becomes active again (admin), audited with the admin as actor. Q16b: it returns to the state
   * the suspension replaced (a partner suspended while pending is pending again, never verified by reinstating); a
   * partner suspended before that state was recorded returns to pending (an admin verifies it again). Verification
   * details (who verified it, when) are left as they were.
   */
  async reinstatePartner(partnerId: string, adminId: string): Promise<IPartner> {
    const id = canonicalPartnerId(partnerId);
    return inTransaction(async (session) => {
      const current = await PartnerModel.findOne({ _id: id, 'verification.state': 'suspended' }).session(session).select({ verification: 1 }).lean() as IPartner | null;
      if (!current) throw new AppError({ status: 409, code: 'NOT_SUSPENDED', message: 'Only a suspended partner can be reinstated' });
      const restored = current.verification?.stateBeforeSuspension === 'verified' ? 'verified' : 'pending';
      const updated = await PartnerModel.findOneAndUpdate(
        { _id: id, 'verification.state': 'suspended' },
        { $set: { 'verification.state': restored, isActive: true }, $unset: { 'verification.stateBeforeSuspension': 1 } },
        { new: true, session }
      ).lean() as IPartner | null;
      if (!updated) throw new AppError({ status: 409, code: 'NOT_SUSPENDED', message: 'Only a suspended partner can be reinstated' });
      await recordPartnerAudit(adminActor(adminId, id), 'partner.reinstate', { kind: 'partner', id }, { restoredState: restored }, session);
      return updated;
    }).then(async (updated) => {
      // Clinic authority is valid again: the doctors' generated in-clinic slots at its branches follow at once.
      const branchIds = (await BranchModel.find({ partnerId: id }).select({ _id: 1 }).lean()).map((b) => String(b._id));
      await refreshDoctorsAt(branchIds);
      return updated;
    });
  }

  // ── Member management (actor = admitted member) ──

  async addMember(
    actor: PartnerActor,
    data: { phone: string; email?: string; name: string; role: MemberRole; permissions: PartnerPermission[]; branchIds?: string[] }
  ): Promise<IMember> {
    if (data.role === 'owner' && actor.role !== 'owner') {
      throw new AppError({ status: 403, code: 'OWNER_REQUIRED', message: 'Only an owner can add another owner' });
    }
    this.enforceDelegationCeiling(actor.role, actor.permissions, data.permissions);

    const branchIds = data.role === 'owner' ? [] : (data.branchIds ?? []).map(String);
    if (data.role !== 'owner') assertScopeWithin(actor, branchIds);
    if (branchIds.length > 0) await this.validateBranchIds(actor.partnerId, branchIds);

    const existing = await this.memberRepository.findOne({ phone: data.phone, partnerId: actor.partnerId, isActive: true });
    if (existing) {
      throw new AppError({ status: 409, code: 'MEMBER_ALREADY_EXISTS', message: 'An active member with this phone already exists for this partner' });
    }
    const email = normalizeMemberEmail(data.email);
    // A sign-in email is an identity: only an owner (or an admin acting as owner) sets it, on add as on edit (otherwise a
    // staff manager could remove a member and add them back with an email of their choosing).
    if (email && actor.role !== 'owner') {
      throw new AppError({ status: 403, code: 'OWNER_REQUIRED', message: 'Only an owner can set a member\'s sign-in email' });
    }
    // Q16b (owner, 22 Nov): an owner's sign-in email is set by the Jansetu team only (an owner could otherwise sign in as
    // the new owner with an address of their own).
    if (email && data.role === 'owner' && actor.actorKind !== 'admin') throw ownerEmailAdminOnly();
    await assertMemberEmailFree(actor.partnerId, email);

    if (data.role === 'owner') {
      return this.addOwner(actor, { ...data, email });
    }

    try {
      return await inTransaction(async (session) => {
        const member = await this.memberRepository.save({
          partnerId: actor.partnerId,
          phone: data.phone,
          ...(email ? { email } : {}),
          name: data.name,
          role: 'staff',
          permissions: data.permissions,
          branchIds,
          isActive: true,
          invitedBy: actor.memberId,
        } as Partial<IMember>, { session });
        await recordPartnerAudit(actor, 'member.add', { kind: 'member', id: String(member._id) },
          { role: 'staff', permissions: data.permissions, branchIds, ...(email ? { email: true } : {}) }, session);
        return member;
      }).then(async (member) => {
        if (email) await notifyMemberEmailChange(member, actor, 'set');
        return member;
      });
    } catch (error: any) {
      if (isEmailDuplicate(error)) throw emailInUse();
      if (error?.code === 11000) {
        throw new AppError({ status: 409, code: 'MEMBER_ALREADY_EXISTS', message: 'An active member with this phone already exists for this partner' });
      }
      throw error;
    }
  }

  /**
   * An owner joins: the owner counter and the member row change together. Q16b: in the retrying transaction helper,
   * reading the counter inside it, so concurrent owner changes are retried (never a raw WriteConflict 500).
   */
  private async addOwner(actor: PartnerActor, data: { phone: string; name: string; email?: string }): Promise<IMember> {
    const partnerId = actor.partnerId;
    await this.getPartnerById(partnerId);
    try {
      const member = await inTransaction(async (session) => {
        const partner = await PartnerModel.findById(partnerId).session(session).select({ activeOwnerCount: 1 }).lean() as IPartner | null;
        if (!partner) throw new AppError({ status: 404, code: 'PARTNER_NOT_FOUND', message: 'Partner not found' });
        const updated = await this.partnerRepository.incrementActiveOwnerCount(partnerId, partner.activeOwnerCount, session);
        if (!updated) {
          throw new AppError({ status: 409, code: 'OWNER_COUNT_CONFLICT', message: 'Owner count changed concurrently, please retry' });
        }
        const created = await this.memberRepository.save(
          {
            partnerId,
            phone: data.phone,
            ...(data.email ? { email: data.email } : {}),
            name: data.name,
            role: 'owner' as MemberRole,
            permissions: [...ALL_PERMISSIONS],
            branchIds: [],
            isActive: true,
            invitedBy: actor.memberId,
          } as Partial<IMember>,
          { session }
        );
        await recordPartnerAudit(actor, 'member.add', { kind: 'member', id: String(created._id) }, { role: 'owner', ...(data.email ? { email: true } : {}) }, session);
        return created;
      });
      if (data.email) await notifyMemberEmailChange(member, actor, 'set');
      return member;
    } catch (error: any) {
      if (isEmailDuplicate(error)) throw emailInUse();
      if (error?.code === 11000) {
        throw new AppError({ status: 409, code: 'MEMBER_ALREADY_EXISTS', message: 'An active member with this phone already exists for this partner' });
      }
      throw error;
    }
  }

  async removeMember(actor: PartnerActor, memberId: string): Promise<void> {
    const member = await this.memberRepository.findById(memberId);
    if (!member || String(member.partnerId) !== String(actor.partnerId)) throw memberNotFound();
    if (String(member._id) === String(actor.memberId)) {
      throw new AppError({ status: 400, code: 'CANNOT_REMOVE_SELF', message: 'Cannot remove yourself' });
    }
    if (member.role === 'owner' && actor.role !== 'owner') {
      throw new AppError({ status: 403, code: 'OWNER_REQUIRED', message: 'Only an owner can remove another owner' });
    }
    if (!memberInScope(actor, member)) throw memberNotFound();
    if (!member.isActive) return;
    // Q16b: a clinic's doctor leaves only through DELETE /clinic/doctors/:doctorId (owner or admin; it refreshes the
    // doctor's slots, tells the doctor and is audited as a doctor unlink), never as plain staff removal.
    if (member.doctorId) throw useDoctorUnlink();

    if (member.role === 'owner') {
      await this.removeOwner(actor, memberId);
    } else {
      await inTransaction(async (session) => {
        const removed = await this.memberRepository.update(
          // The doctor link is re-checked on the row written (a doctor linked meanwhile is refused, not removed).
          { _id: memberId, partnerId: actor.partnerId, role: 'staff', isActive: true, doctorId: { $exists: false } },
          { isActive: false },
          { new: true, session } as any
        );
        if (removed) { await recordPartnerAudit(actor, 'member.remove', { kind: 'member', id: memberId }, undefined, session); return; }
        if (await MemberModel.exists({ _id: memberId, isActive: true, doctorId: { $type: 'string' } }).session(session)) throw useDoctorUnlink();
      });
    }
  }

  /** Q16b: like addOwner, one retrying transaction that reads the owner counter inside it (§3 last-owner protection). */
  private async removeOwner(actor: PartnerActor, memberId: string): Promise<void> {
    const partnerId = actor.partnerId;
    await inTransaction(async (session) => {
      const partner = await PartnerModel.findById(partnerId).session(session).select({ activeOwnerCount: 1 }).lean() as IPartner | null;
      if (!partner) throw new AppError({ status: 404, code: 'PARTNER_NOT_FOUND', message: 'Partner not found' });
      if (partner.activeOwnerCount <= 1) {
        throw new AppError({ status: 409, code: 'LAST_OWNER', message: 'Cannot remove the last owner' });
      }
      const updated = await this.partnerRepository.decrementActiveOwnerCount(partnerId, partner.activeOwnerCount, session);
      if (!updated) {
        throw new AppError({ status: 409, code: 'OWNER_COUNT_CONFLICT', message: 'Owner count changed concurrently, please retry' });
      }
      if (updated.activeOwnerCount < 1) {
        throw new AppError({ status: 409, code: 'LAST_OWNER', message: 'Cannot remove the last owner' });
      }
      const deactivated = await this.memberRepository.update(
        { _id: memberId, partnerId, isActive: true, role: 'owner', doctorId: { $exists: false } },
        { isActive: false },
        { new: true, session } as any
      );
      if (!deactivated) {
        throw new AppError({ status: 409, code: 'MEMBER_STATE_CONFLICT', message: 'Member state changed concurrently, please retry' });
      }
      await recordPartnerAudit(actor, 'member.remove', { kind: 'member', id: memberId }, { role: 'owner' }, session);
    });
  }

  async updateMemberPermissions(actor: PartnerActor, memberId: string, permissions: PartnerPermission[], expectedUpdatedAt?: Date | string): Promise<IMember> {
    if (actor.role !== 'owner') {
      throw new AppError({ status: 403, code: 'OWNER_REQUIRED', message: 'Only an owner can change member permissions' });
    }
    const member = await this.memberRepository.findById(memberId);
    if (!member || String(member.partnerId) !== String(actor.partnerId) || !member.isActive) throw memberNotFound();
    if (member.role === 'owner') {
      throw new AppError({ status: 400, code: 'OWNER_PERMS_FIXED', message: 'Owner permissions cannot be restricted' });
    }

    return inTransaction(async (session) => {
      const updated = await this.memberRepository.update(
        { _id: memberId, partnerId: actor.partnerId, role: 'staff', isActive: true, ...versionFence(expectedUpdatedAt) },
        { permissions },
        { new: true, session } as any
      );
      if (!updated) { if (expectedUpdatedAt && await MemberModel.exists({ _id: memberId, isActive: true }).session(session)) throw recordChanged(); throw memberNotFound(); }
      await recordPartnerAudit(actor, 'member.permissions', { kind: 'member', id: memberId }, { permissions }, session);
      return updated;
    });
  }

  /**
   * A member's sign-in email (null or empty removes it). It is a sign-in identity, so like permissions only an owner
   * changes it (admins act as owner); Q16b: an owner's email only an admin (403 OWNER_EMAIL_ADMIN_ONLY), and the member
   * is told of every set, change or removal. Unique among the partner's active members (409
   * EMAIL_IN_USE). Optimistic fence with `expectedUpdatedAt`. Audited (whether set or removed, not the address).
   */
  async updateMemberEmail(actor: PartnerActor, memberId: string, email: string | null | undefined, expectedUpdatedAt?: Date | string): Promise<IMember> {
    if (actor.role !== 'owner') {
      throw new AppError({ status: 403, code: 'OWNER_REQUIRED', message: 'Only an owner can change a member\'s sign-in email' });
    }
    const normalized = normalizeMemberEmail(email);
    try {
      const result = await inTransaction(async (session) => {
        const current = await MemberModel.findOne({ _id: memberId, partnerId: actor.partnerId, isActive: true }).session(session).lean() as IMember | null;
        if (!current) throw memberNotFound();
        // Q16b (owner, 22 Nov): an owner's sign-in email — another owner's or one's own — is changed by an admin only.
        if (current.role === 'owner' && actor.actorKind !== 'admin') throw ownerEmailAdminOnly();
        if (expectedUpdatedAt && new Date(current.updatedAt as Date).getTime() !== new Date(expectedUpdatedAt).getTime()) throw recordChanged();
        await assertMemberEmailFree(actor.partnerId, normalized, memberId, session);
        const updated = await MemberModel.findOneAndUpdate({ _id: memberId, partnerId: actor.partnerId, isActive: true, updatedAt: current.updatedAt },
          normalized ? { $set: { email: normalized } } : { $unset: { email: 1 } }, { new: true, session }).lean() as IMember | null;
        if (!updated) throw recordChanged();
        await recordPartnerAudit(actor, 'member.email', { kind: 'member', id: memberId }, { email: normalized ? 'set' : 'removed' }, session);
        // A previous email that is changed or removed ends the member's web and phone-app sessions, in this transaction
        // (the change is saved only together with the revocation). A first email ends nothing: those sessions were
        // opened with the phone, which still works. Q16b: revokeAllSessions also advances the member's token generation,
        // so a bearer token from before ends with the sessions.
        const previous = current.email ?? undefined;
        if (previous && previous !== normalized) {
          const { revokeAllSessions } = await import('@/modules/auth/sessions');
          await revokeAllSessions('partner', String(memberId), 'sign_in_email_changed', session);
        }
        return { updated, change: (previous === normalized ? null : !previous ? 'set' : normalized ? 'changed' : 'removed') as EmailChange | null };
      });
      // Q16b: the member hears of it (after the commit, best effort; never affects the change).
      if (result.change) await notifyMemberEmailChange(result.updated, actor, result.change);
      return result.updated;
    } catch (error: any) {
      if (isEmailDuplicate(error)) throw emailInUse();
      throw error;
    }
  }

  /**
   * Q8: which branches a staff member works at (empty = all). The delegation ceiling applies as when adding staff: the
   * actor must see the member and may only hand out a scope within their own (a restricted actor never grants "all").
   * Owners always cover every branch. A doctor's consultation scope (doctorBranchIds) is not changed here.
   */
  async updateMemberBranches(actor: PartnerActor, memberId: string, branchIds: string[], expectedUpdatedAt?: Date | string): Promise<IMember> {
    const member = await this.memberRepository.findById(memberId);
    if (!member || String(member.partnerId) !== String(actor.partnerId) || !member.isActive || !memberInScope(actor, member)) throw memberNotFound();
    if (member.role === 'owner') throw new AppError({ status: 400, code: 'OWNER_SCOPE_FIXED', message: 'Owners always cover every branch' });
    if (String(member._id) === actor.memberId) throw new AppError({ status: 403, code: 'SELF_SCOPE_CHANGE', message: 'You cannot change your own branch access' });
    const scope = [...new Set(branchIds.map(String))];
    assertScopeWithin(actor, scope);
    if (scope.length > 0) await this.validateBranchIds(actor.partnerId, scope);
    return inTransaction(async (session) => {
      // Re-admitted on every attempt: the target as this transaction reads it must still be visible to the actor, and the
      // write is bound to exactly that scope (a concurrent move makes it a conflict, never a silent move back).
      const current = await MemberModel.findOne({ _id: memberId, partnerId: actor.partnerId, role: 'staff', isActive: true }).session(session).lean() as IMember | null;
      if (!current || !memberInScope(actor, current)) throw memberNotFound();
      if (expectedUpdatedAt && new Date(current.updatedAt as Date).getTime() !== new Date(expectedUpdatedAt).getTime()) throw recordChanged();
      const updated = await this.memberRepository.update(
        { _id: memberId, partnerId: actor.partnerId, role: 'staff', isActive: true, branchIds: current.branchIds ?? [] }, { branchIds: scope }, { new: true, session } as any);
      if (!updated) throw memberNotFound();
      await recordPartnerAudit(actor, 'member.branches', { kind: 'member', id: memberId }, { branchIds: scope }, session);
      return updated;
    });
  }

  /**
   * Q11: a member's professional registration (who may sign reports/prescriptions under it). Owners only (admins act as
   * owner): it is the legal identity reports are released under. Empty registration removes it. Audited.
   */
  async setMemberProfessional(actor: PartnerActor, memberId: string,
    professional: { kind: ProfessionalKind; registrationNumber: string } | null, expectedUpdatedAt?: Date | string): Promise<IMember> {
    if (actor.role !== 'owner') throw new AppError({ status: 403, code: 'OWNER_REQUIRED', message: 'Only an owner can record professional registrations' });
    return inTransaction(async (session) => {
      const current = await MemberModel.findOne({ _id: memberId, partnerId: actor.partnerId, isActive: true }).session(session).lean() as IMember | null;
      if (!current) throw memberNotFound();
      if (expectedUpdatedAt && new Date(current.updatedAt as Date).getTime() !== new Date(expectedUpdatedAt).getTime()) throw recordChanged();
      const updated = await MemberModel.findOneAndUpdate({ _id: memberId, partnerId: actor.partnerId, isActive: true, updatedAt: current.updatedAt },
        professional ? { $set: { professional: { kind: professional.kind, registrationNumber: professional.registrationNumber.trim() } } } : { $unset: { professional: 1 } },
        { new: true, session }).lean() as IMember | null;
      if (!updated) throw recordChanged();
      await recordPartnerAudit(actor, 'member.professional', { kind: 'member', id: memberId },
        professional ? { kind: professional.kind, registrationNumber: professional.registrationNumber.trim() } : { removed: true }, session);
      return updated;
    });
  }

  /** Q11: the signed-in member's own record (role, permissions, branches, professional registration). */
  async getOwnMember(actor: PartnerActor): Promise<IMember> {
    // An admin acting as owner (memberId `admin:<id>`) has no member record in this partner.
    if (actor.actorKind === 'admin' || !isValidObjectId(actor.memberId)) {
      throw new AppError({ status: 404, code: 'NO_MEMBER_RECORD', message: 'An admin acting for this partner has no staff record here' });
    }
    const m = await MemberModel.findOne({ _id: actor.memberId, partnerId: actor.partnerId, isActive: true }).lean() as IMember | null;
    if (!m) throw memberNotFound();
    return m;
  }

  /** Q16b: the signed-in member's own in-app notifications (newest first). Admins acting as owner have none here. */
  async listOwnNotifications(actor: PartnerActor, limit = 50) {
    if (actor.actorKind === 'admin' || !isValidObjectId(actor.memberId)) {
      throw new AppError({ status: 404, code: 'NO_MEMBER_RECORD', message: 'An admin acting for this partner has no staff record here' });
    }
    const { default: NotificationModel } = await import('@/modules/notification/model');
    return NotificationModel.find({ userId: String(actor.memberId) }).sort({ createdAt: -1 }).limit(Math.min(Math.max(limit, 1), 100)).lean();
  }

  async listMembers(actor: PartnerActor): Promise<IMember[]> {
    const all = await this.memberRepository.findActiveByPartner(actor.partnerId);
    return all.filter((m) => memberInScope(actor, m));
  }

  async getMember(actor: PartnerActor, memberId: string): Promise<IMember> {
    const member = await this.memberRepository.findById(memberId);
    if (!member || String(member.partnerId) !== String(actor.partnerId)) throw memberNotFound();
    if (!memberInScope(actor, member)) throw memberNotFound();
    return member;
  }

  async listMembersForPartner(partnerId: string): Promise<IMember[]> {
    return this.memberRepository.findActiveByPartner(partnerId);
  }

  // ── Branch management (actor = admitted member) ──

  /**
   * Q16b: with a `requestKey` the create is exactly once per (partner, key): a resend answers with the branch it made
   * (`replayed`), other content under the same key is refused (409 REQUEST_KEY_REUSED); the unique (partnerId,
   * createRequestKey) index holds one branch per key whatever the race (run `npm run sync-indexes`).
   */
  async createBranch(actor: PartnerActor, input: Omit<IBranch, '_id' | 'partnerId' | 'isActive' | 'createdAt' | 'updatedAt'> & { requestKey?: string }): Promise<IBranch & { replayed?: boolean }> {
    if (!hasGlobalScope(actor)) throw scopeExceeded('Branch-scoped staff cannot create new branches');
    const { requestKey, createRequestKey: _k, createRequestHash: _h, ...data } = input;
    const partnerId = canonicalPartnerId(actor.partnerId);
    const { canonicalJson } = await import('@/modules/partners/services/invoice');
    const requestHash = requestKey ? createHash('sha256').update(canonicalJson(data)).digest('hex') : undefined;
    const replay = async () => {
      if (!requestKey) return null;
      const prior = await BranchModel.findOne({ partnerId, createRequestKey: { $eq: requestKey, $type: 'string' } }).select('+createRequestHash').lean() as IBranch | null;
      if (!prior) return null;
      if (prior.createRequestHash !== requestHash) throw new AppError({ status: 409, code: 'REQUEST_KEY_REUSED', message: 'This request key was already used for a different branch' });
      const { createRequestHash: _x, ...shown } = prior;
      return { ...shown, replayed: true };
    };
    const prior = await replay();
    if (prior) return prior;
    await this.getPartnerById(partnerId);
    try {
      return await inTransaction(async (session) => {
        const branch = await this.branchRepository.save({ ...data, partnerId, isActive: true,
          ...(requestKey ? { createRequestKey: requestKey, createRequestHash: requestHash } : {}) } as Partial<IBranch>, { session });
        await recordPartnerAudit(actor, 'branch.create', { kind: 'branch', id: String(branch._id) }, undefined, session);
        const { createRequestHash: _x, ...shown } = branch as IBranch;
        return shown as IBranch;
      });
    } catch (e: any) {
      if (e?.code !== 11000) throw e;
      const raced = await replay();
      if (!raced) throw e;
      return raced;
    }
  }

  async updateBranch(actor: PartnerActor, branchId: string, data: Partial<IBranch> & { expectedUpdatedAt?: Date | string }): Promise<IBranch> {
    await this.getBranch(actor, branchId);
    const { _id, partnerId: _p, isActive: _a, createdAt: _c, updatedAt: _u, expectedUpdatedAt, ...safeData } = data;
    const shapesSlots = 'holidays' in safeData || 'services' in safeData;
    if (shapesSlots) await ensureBranchScheduleGuards(branchId);
    return inTransaction(async (session) => {
      if (shapesSlots) await bumpBranchScheduleGuards(branchId, session);
      const updated = await this.branchRepository.update({ _id: branchId, partnerId: actor.partnerId, ...versionFence(expectedUpdatedAt) }, safeData, { new: true, session } as any);
      if (!updated) { if (expectedUpdatedAt && await BranchModel.exists({ _id: branchId }).session(session)) throw recordChanged(); throw branchNotFound(); }
      await recordPartnerAudit(actor, 'branch.update', { kind: 'branch', id: branchId }, { fields: Object.keys(safeData) }, session);
      return updated;
    }).then(async (updated) => {
      // Holidays and services decide which slots exist: bring the branch's generated slots in line now.
      if (shapesSlots) await (await import('@/modules/partners/services/slots')).expandBranchTemplates(branchId);
      return updated;
    });
  }

  async deactivateBranch(actor: PartnerActor, branchId: string): Promise<void> {
    await this.getBranch(actor, branchId);
    await ensureBranchScheduleGuards(branchId);
    await inTransaction(async (session) => {
      await bumpBranchScheduleGuards(branchId, session);
      const done = await this.branchRepository.update({ _id: branchId, partnerId: actor.partnerId, isActive: true }, { isActive: false }, { new: true, session } as any);
      if (done) await recordPartnerAudit(actor, 'branch.deactivate', { kind: 'branch', id: branchId }, undefined, session);
    });
    await (await import('@/modules/partners/services/slots')).expandBranchTemplates(branchId);
  }

  /** Q8: a deactivated branch opens again (all-branch actors, like creating one); its generated slots follow. */
  async reactivateBranch(actor: PartnerActor, branchId: string): Promise<IBranch> {
    if (!hasGlobalScope(actor)) throw scopeExceeded('Branch-scoped staff cannot reopen branches');
    await this.getBranch(actor, branchId);
    await ensureBranchScheduleGuards(branchId);
    const updated = await inTransaction(async (session) => {
      await bumpBranchScheduleGuards(branchId, session);
      const done = await this.branchRepository.update({ _id: branchId, partnerId: actor.partnerId, isActive: false }, { isActive: true }, { new: true, session } as any);
      if (!done) throw new AppError({ status: 409, code: 'BRANCH_ALREADY_ACTIVE', message: 'This branch is already open' });
      await recordPartnerAudit(actor, 'branch.reactivate', { kind: 'branch', id: branchId }, undefined, session);
      return done;
    });
    await (await import('@/modules/partners/services/slots')).expandBranchTemplates(branchId);
    await refreshDoctorsAt([branchId]);
    return updated;
  }

  /** The partner-wide trail names members and grants on every branch, so only all-branch actors may read it. */
  async listAudit(actor: PartnerActor, limit = 100) {
    if (!hasGlobalScope(actor)) throw scopeExceeded('The activity log is available to owners and all-branch staff only');
    return PartnerAuditEventModel.find({ partnerId: actor.partnerId }).sort({ at: -1 }).limit(Math.min(limit, 500)).lean();
  }

  async listBranches(actor: PartnerActor, includeInactive = false): Promise<IBranch[]> {
    // Q8: closed branches are listed (to reopen them) only for those who manage branches.
    const canManage = actor.role === 'owner' || actor.permissions.includes('branches.manage');
    const all = includeInactive && canManage
      ? await BranchModel.find({ partnerId: actor.partnerId }).sort({ name: 1 }).lean() as IBranch[]
      : await this.branchRepository.findActiveByPartner(actor.partnerId);
    return hasGlobalScope(actor) ? all : all.filter((b) => actor.branchIds.includes(String(b._id)));
  }

  async getBranch(actor: PartnerActor, branchId: string): Promise<IBranch> {
    const branch = await this.branchRepository.findById(branchId);
    if (!branch || String(branch.partnerId) !== String(actor.partnerId)) throw branchNotFound();
    assertBranchInScope(actor, branchId);
    return branch;
  }

  async listBranchesForPartner(partnerId: string): Promise<IBranch[]> {
    return this.branchRepository.findActiveByPartner(partnerId);
  }

  // ── Private helpers ──

  // §3: delegation ceiling — a member can only grant permissions they themselves hold
  private enforceDelegationCeiling(
    actorRole: MemberRole,
    actorPermissions: PartnerPermission[],
    targetPermissions: PartnerPermission[]
  ): void {
    if (actorRole === 'owner') return;
    const overreach = targetPermissions.filter(p => !actorPermissions.includes(p));
    if (overreach.length > 0) {
      throw new AppError({
        status: 403,
        code: 'DELEGATION_CEILING',
        message: `Cannot grant permissions you do not hold: ${overreach.join(', ')}`,
      });
    }
  }

  private async validateBranchIds(partnerId: string, branchIds: string[]): Promise<void> {
    const branches = await this.branchRepository.findActiveByPartner(partnerId);
    const activeBranchIds = new Set(branches.map(b => String(b._id)));
    const invalid = branchIds.filter(id => !activeBranchIds.has(String(id)));
    if (invalid.length > 0) {
      throw new AppError({
        status: 400,
        code: 'INVALID_BRANCH_IDS',
        message: `Branch IDs not found in this partner: ${invalid.join(', ')}`,
      });
    }
  }
}
