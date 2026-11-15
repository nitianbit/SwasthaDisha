import { Service } from 'typedi';
import mongoose from 'mongoose';
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
    }
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

    const updated = await this.partnerRepository.update({ _id: partnerId }, update);
    if (!updated) {
      throw new AppError({ status: 404, code: 'PARTNER_NOT_FOUND', message: 'Partner not found' });
    }
    return updated;
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

  // ── Member management ──

  async addMember(
    partnerId: string,
    data: { phone: string; name: string; role: MemberRole; permissions: PartnerPermission[]; branchIds?: string[] },
    invitedByMemberId: string,
    inviterRole: MemberRole,
    inviterPermissions: PartnerPermission[]
  ): Promise<IMember> {
    this.enforceDelegationCeiling(inviterRole, inviterPermissions, data.permissions);

    if (data.branchIds && data.branchIds.length > 0) {
      await this.validateBranchIds(partnerId, data.branchIds);
    }

    const existing = await this.memberRepository.findByPhone(data.phone, partnerId);
    if (existing && existing.isActive) {
      throw new AppError({ status: 409, code: 'MEMBER_ALREADY_EXISTS', message: 'An active member with this phone already exists for this partner' });
    }

    if (data.role === 'owner') {
      return this.addOwner(partnerId, data, invitedByMemberId);
    }

    return this.memberRepository.save({
      partnerId,
      phone: data.phone,
      name: data.name,
      role: data.role,
      permissions: data.permissions,
      branchIds: data.branchIds || [],
      isActive: true,
      invitedBy: invitedByMemberId,
    } as Partial<IMember>);
  }

  private async addOwner(
    partnerId: string,
    data: { phone: string; name: string; permissions: PartnerPermission[] },
    invitedByMemberId: string
  ): Promise<IMember> {
    const partner = await this.partnerRepository.findById(partnerId);
    if (!partner) {
      throw new AppError({ status: 404, code: 'PARTNER_NOT_FOUND', message: 'Partner not found' });
    }

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
          invitedBy: invitedByMemberId,
        } as Partial<IMember>,
        { session }
      );

      await session.commitTransaction();
      return member;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async removeMember(
    partnerId: string,
    memberId: string,
    actorMemberId: string
  ): Promise<void> {
    const member = await this.memberRepository.findById(memberId);
    if (!member || String(member.partnerId) !== String(partnerId)) {
      throw new AppError({ status: 404, code: 'MEMBER_NOT_FOUND', message: 'Member not found in this partner' });
    }
    if (!member.isActive) {
      return;
    }
    if (String(member._id) === String(actorMemberId)) {
      throw new AppError({ status: 400, code: 'CANNOT_REMOVE_SELF', message: 'Cannot remove yourself' });
    }

    if (member.role === 'owner') {
      await this.removeOwner(partnerId, memberId);
    } else {
      await this.memberRepository.update({ _id: memberId }, { isActive: false });
    }
  }

  private async removeOwner(partnerId: string, memberId: string): Promise<void> {
    const partner = await this.partnerRepository.findById(partnerId);
    if (!partner) {
      throw new AppError({ status: 404, code: 'PARTNER_NOT_FOUND', message: 'Partner not found' });
    }
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
      // Double-check: never go below 1 active owner
      if (updated.activeOwnerCount < 1) {
        throw new AppError({ status: 409, code: 'LAST_OWNER', message: 'Cannot remove the last owner' });
      }

      await this.memberRepository.update({ _id: memberId }, { isActive: false });

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async updateMemberPermissions(
    partnerId: string,
    memberId: string,
    permissions: PartnerPermission[],
    actorRole: MemberRole,
    actorPermissions: PartnerPermission[]
  ): Promise<IMember> {
    const member = await this.memberRepository.findById(memberId);
    if (!member || String(member.partnerId) !== String(partnerId) || !member.isActive) {
      throw new AppError({ status: 404, code: 'MEMBER_NOT_FOUND', message: 'Active member not found' });
    }
    if (member.role === 'owner') {
      throw new AppError({ status: 400, code: 'OWNER_PERMS_FIXED', message: 'Owner permissions cannot be restricted' });
    }

    this.enforceDelegationCeiling(actorRole, actorPermissions, permissions);

    const updated = await this.memberRepository.update(
      { _id: memberId },
      { permissions }
    );
    if (!updated) {
      throw new AppError({ status: 404, code: 'MEMBER_NOT_FOUND', message: 'Member not found' });
    }
    return updated;
  }

  async listMembers(partnerId: string): Promise<IMember[]> {
    return this.memberRepository.findActiveByPartner(partnerId);
  }

  async getMemberById(partnerId: string, memberId: string): Promise<IMember> {
    const member = await this.memberRepository.findById(memberId);
    if (!member || String(member.partnerId) !== String(partnerId)) {
      throw new AppError({ status: 404, code: 'MEMBER_NOT_FOUND', message: 'Member not found in this partner' });
    }
    return member;
  }

  // ── Branch management ──

  async createBranch(partnerId: string, data: Omit<IBranch, '_id' | 'partnerId' | 'isActive' | 'createdAt' | 'updatedAt'>): Promise<IBranch> {
    await this.getPartnerById(partnerId);
    return this.branchRepository.save({
      ...data,
      partnerId,
      isActive: true,
    } as Partial<IBranch>);
  }

  async updateBranch(partnerId: string, branchId: string, data: Partial<IBranch>): Promise<IBranch> {
    const branch = await this.branchRepository.findById(branchId);
    if (!branch || String(branch.partnerId) !== String(partnerId)) {
      throw new AppError({ status: 404, code: 'BRANCH_NOT_FOUND', message: 'Branch not found' });
    }
    const { _id, partnerId: _p, isActive: _a, createdAt: _c, updatedAt: _u, ...safeData } = data;
    const updated = await this.branchRepository.update({ _id: branchId }, safeData);
    if (!updated) {
      throw new AppError({ status: 404, code: 'BRANCH_NOT_FOUND', message: 'Branch not found' });
    }
    return updated;
  }

  async deactivateBranch(partnerId: string, branchId: string): Promise<void> {
    const branch = await this.branchRepository.findById(branchId);
    if (!branch || String(branch.partnerId) !== String(partnerId)) {
      throw new AppError({ status: 404, code: 'BRANCH_NOT_FOUND', message: 'Branch not found' });
    }
    await this.branchRepository.update({ _id: branchId }, { isActive: false });
  }

  async listBranches(partnerId: string): Promise<IBranch[]> {
    return this.branchRepository.findActiveByPartner(partnerId);
  }

  async getBranchById(partnerId: string, branchId: string): Promise<IBranch> {
    const branch = await this.branchRepository.findById(branchId);
    if (!branch || String(branch.partnerId) !== String(partnerId)) {
      throw new AppError({ status: 404, code: 'BRANCH_NOT_FOUND', message: 'Branch not found' });
    }
    return branch;
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
    const invalid = branchIds.filter(id => !activeBranchIds.has(id));
    if (invalid.length > 0) {
      throw new AppError({
        status: 400,
        code: 'INVALID_BRANCH_IDS',
        message: `Branch IDs not found in this partner: ${invalid.join(', ')}`,
      });
    }
  }
}
