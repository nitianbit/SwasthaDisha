import { Service } from 'typedi';
import mongoose, { ClientSession } from 'mongoose';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
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
    partnerId,
    role: 'owner',
    permissions: [...ALL_PERMISSIONS],
    branchIds: [],
    actorKind: 'admin',
  };
}

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
    firstOwner: { phone: string; name: string };
  }): Promise<{ partner: IPartner; owner: IMember }> {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
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
          isActive: true,
          verification: { state: 'pending', documents: [] },
        } as Partial<IPartner>,
        { session }
      );

      const owner = await this.memberRepository.save(
        {
          partnerId: partner._id!,
          phone: data.firstOwner.phone,
          name: data.firstOwner.name,
          role: 'owner' as MemberRole,
          permissions: [...ALL_PERMISSIONS],
          branchIds: [],
          isActive: true,
        } as Partial<IMember>,
        { session }
      );

      await session.commitTransaction();
      return { partner, owner };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
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
  }): Promise<IPartner[]> {
    const query: any = {};
    if (filter.kind) query.kind = filter.kind;
    if (filter.verificationState) query['verification.state'] = filter.verificationState;
    if (filter.isActive !== undefined) query.isActive = filter.isActive;
    return this.partnerRepository.findAll(query, { sort: { name: 1 } });
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

    const updated = await this.partnerRepository.update({ _id: partnerId }, update, { new: true, ...(session ? { session } : {}) } as any);
    if (!updated) {
      throw new AppError({ status: 404, code: 'PARTNER_NOT_FOUND', message: 'Partner not found' });
    }
    return updated;
  }

  async updateOwnProfile(
    actor: PartnerActor,
    data: { name?: string; legalName?: string; contactPhone?: string; contactEmail?: string; logo?: string }
  ): Promise<IPartner> {
    const { name, legalName, contactPhone, contactEmail, logo } = data;
    const fields = { name, legalName, contactPhone, contactEmail, logo };
    return inTransaction(async (session) => {
      const updated = await this.updatePartner(actor.partnerId, fields, session);
      await recordPartnerAudit(actor, 'partner.profile.update', { kind: 'partner', id: actor.partnerId },
        { fields: Object.keys(fields).filter((k) => (fields as any)[k] !== undefined) }, session);
      return updated;
    });
  }

  async verifyPartner(partnerId: string, verifiedBy: string): Promise<IPartner> {
    const updated = await this.partnerRepository.update(
      { _id: partnerId, 'verification.state': 'pending' },
      { 'verification.state': 'verified', 'verification.verifiedAt': new Date(), 'verification.verifiedBy': verifiedBy }
    );
    if (!updated) {
      throw new AppError({ status: 409, code: 'VERIFICATION_STATE_CONFLICT', message: 'Partner is not in pending state' });
    }
    return updated;
  }

  async suspendPartner(partnerId: string): Promise<IPartner> {
    const updated = await this.partnerRepository.update(
      { _id: partnerId, 'verification.state': { $ne: 'suspended' } },
      { 'verification.state': 'suspended', isActive: false }
    );
    if (!updated) {
      throw new AppError({ status: 409, code: 'ALREADY_SUSPENDED', message: 'Partner is already suspended' });
    }
    return updated;
  }

  // ── Member management (actor = admitted member) ──

  async addMember(
    actor: PartnerActor,
    data: { phone: string; name: string; role: MemberRole; permissions: PartnerPermission[]; branchIds?: string[] }
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

    if (data.role === 'owner') {
      return this.addOwner(actor, data);
    }

    try {
      return await inTransaction(async (session) => {
        const member = await this.memberRepository.save({
          partnerId: actor.partnerId,
          phone: data.phone,
          name: data.name,
          role: 'staff',
          permissions: data.permissions,
          branchIds,
          isActive: true,
          invitedBy: actor.memberId,
        } as Partial<IMember>, { session });
        await recordPartnerAudit(actor, 'member.add', { kind: 'member', id: String(member._id) },
          { role: 'staff', permissions: data.permissions, branchIds }, session);
        return member;
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        throw new AppError({ status: 409, code: 'MEMBER_ALREADY_EXISTS', message: 'An active member with this phone already exists for this partner' });
      }
      throw error;
    }
  }

  private async addOwner(actor: PartnerActor, data: { phone: string; name: string }): Promise<IMember> {
    const partnerId = actor.partnerId;
    const partner = await this.getPartnerById(partnerId);

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const updated = await this.partnerRepository.incrementActiveOwnerCount(
        partnerId, partner.activeOwnerCount, session
      );
      if (!updated) {
        throw new AppError({ status: 409, code: 'OWNER_COUNT_CONFLICT', message: 'Owner count changed concurrently, please retry' });
      }

      const member = await this.memberRepository.save(
        {
          partnerId,
          phone: data.phone,
          name: data.name,
          role: 'owner' as MemberRole,
          permissions: [...ALL_PERMISSIONS],
          branchIds: [],
          isActive: true,
          invitedBy: actor.memberId,
        } as Partial<IMember>,
        { session }
      );
      await recordPartnerAudit(actor, 'member.add', { kind: 'member', id: String(member._id) }, { role: 'owner' }, session);

      await session.commitTransaction();
      return member;
    } catch (error: any) {
      await session.abortTransaction();
      if (error?.code === 11000) {
        throw new AppError({ status: 409, code: 'MEMBER_ALREADY_EXISTS', message: 'An active member with this phone already exists for this partner' });
      }
      throw error;
    } finally {
      session.endSession();
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

    if (member.role === 'owner') {
      await this.removeOwner(actor, memberId);
    } else {
      await inTransaction(async (session) => {
        const removed = await this.memberRepository.update(
          { _id: memberId, partnerId: actor.partnerId, role: 'staff', isActive: true },
          { isActive: false },
          { new: true, session } as any
        );
        if (removed) await recordPartnerAudit(actor, 'member.remove', { kind: 'member', id: memberId }, undefined, session);
      });
    }
  }

  private async removeOwner(actor: PartnerActor, memberId: string): Promise<void> {
    const partnerId = actor.partnerId;
    const partner = await this.getPartnerById(partnerId);
    // §3: last-active-owner protection
    if (partner.activeOwnerCount <= 1) {
      throw new AppError({ status: 409, code: 'LAST_OWNER', message: 'Cannot remove the last owner' });
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const updated = await this.partnerRepository.decrementActiveOwnerCount(
        partnerId, partner.activeOwnerCount, session
      );
      if (!updated) {
        throw new AppError({ status: 409, code: 'OWNER_COUNT_CONFLICT', message: 'Owner count changed concurrently, please retry' });
      }
      if (updated.activeOwnerCount < 1) {
        throw new AppError({ status: 409, code: 'LAST_OWNER', message: 'Cannot remove the last owner' });
      }

      const deactivated = await this.memberRepository.update(
        { _id: memberId, partnerId, isActive: true, role: 'owner' },
        { isActive: false },
        { new: true, session } as any
      );
      if (!deactivated) {
        throw new AppError({ status: 409, code: 'MEMBER_STATE_CONFLICT', message: 'Member state changed concurrently, please retry' });
      }
      await recordPartnerAudit(actor, 'member.remove', { kind: 'member', id: memberId }, { role: 'owner' }, session);

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async updateMemberPermissions(actor: PartnerActor, memberId: string, permissions: PartnerPermission[]): Promise<IMember> {
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
        { _id: memberId, partnerId: actor.partnerId, role: 'staff', isActive: true },
        { permissions },
        { new: true, session } as any
      );
      if (!updated) throw memberNotFound();
      await recordPartnerAudit(actor, 'member.permissions', { kind: 'member', id: memberId }, { permissions }, session);
      return updated;
    });
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

  async createBranch(actor: PartnerActor, data: Omit<IBranch, '_id' | 'partnerId' | 'isActive' | 'createdAt' | 'updatedAt'>): Promise<IBranch> {
    if (!hasGlobalScope(actor)) throw scopeExceeded('Branch-scoped staff cannot create new branches');
    await this.getPartnerById(actor.partnerId);
    return inTransaction(async (session) => {
      const branch = await this.branchRepository.save({ ...data, partnerId: actor.partnerId, isActive: true } as Partial<IBranch>, { session });
      await recordPartnerAudit(actor, 'branch.create', { kind: 'branch', id: String(branch._id) }, undefined, session);
      return branch;
    });
  }

  async updateBranch(actor: PartnerActor, branchId: string, data: Partial<IBranch>): Promise<IBranch> {
    await this.getBranch(actor, branchId);
    const { _id, partnerId: _p, isActive: _a, createdAt: _c, updatedAt: _u, ...safeData } = data;
    return inTransaction(async (session) => {
      const updated = await this.branchRepository.update({ _id: branchId, partnerId: actor.partnerId }, safeData, { new: true, session } as any);
      if (!updated) throw branchNotFound();
      await recordPartnerAudit(actor, 'branch.update', { kind: 'branch', id: branchId }, { fields: Object.keys(safeData) }, session);
      return updated;
    });
  }

  async deactivateBranch(actor: PartnerActor, branchId: string): Promise<void> {
    await this.getBranch(actor, branchId);
    await inTransaction(async (session) => {
      const done = await this.branchRepository.update({ _id: branchId, partnerId: actor.partnerId, isActive: true }, { isActive: false }, { new: true, session } as any);
      if (done) await recordPartnerAudit(actor, 'branch.deactivate', { kind: 'branch', id: branchId }, undefined, session);
    });
  }

  /** The partner-wide trail names members and grants on every branch, so only all-branch actors may read it. */
  async listAudit(actor: PartnerActor, limit = 100) {
    if (!hasGlobalScope(actor)) throw scopeExceeded('The activity log is available to owners and all-branch staff only');
    return PartnerAuditEventModel.find({ partnerId: actor.partnerId }).sort({ at: -1 }).limit(Math.min(limit, 500)).lean();
  }

  async listBranches(actor: PartnerActor): Promise<IBranch[]> {
    const all = await this.branchRepository.findActiveByPartner(actor.partnerId);
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
