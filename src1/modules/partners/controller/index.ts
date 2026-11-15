import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AuthRequest } from '@/modules/middleware/auth';
import { PartnerService } from '@/modules/partners/services';
import { PartnerPermission, MemberRole } from '@/modules/partners/types';
import MemberModel from '@/modules/partners/model/member';

const service = () => Container.get(PartnerService);

async function callerMemberContext(req: AuthRequest): Promise<{
  memberId: string;
  partnerId: string;
  role: MemberRole;
  permissions: PartnerPermission[];
}> {
  const memberId = req.user!.memberId!;
  const partnerId = req.user!.partnerId!;
  const member = await MemberModel.findById(memberId).select('role permissions').lean();
  return {
    memberId,
    partnerId,
    role: (member as any)?.role ?? 'staff',
    permissions: ((member as any)?.permissions ?? []) as PartnerPermission[],
  };
}

// ── Admin endpoints ──

export const adminCreatePartner = async (req: Request, res: Response, _next: NextFunction) => {
  const result = await service().createPartner(req.body);
  res.status(201).json({ success: true, data: result });
};

export const adminListPartners = async (req: Request, res: Response, _next: NextFunction) => {
  const filter: any = {};
  if (req.query.kind) filter.kind = req.query.kind;
  if (req.query.verificationState) filter.verificationState = req.query.verificationState;
  if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';
  const data = await service().listPartners(filter);
  res.status(200).json({ success: true, data });
};

export const adminGetPartner = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().getPartnerById(req.params.partnerId);
  res.status(200).json({ success: true, data });
};

export const adminUpdatePartner = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().updatePartner(req.params.partnerId, req.body);
  res.status(200).json({ success: true, data });
};

export const adminVerifyPartner = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().verifyPartner(req.params.partnerId, (req as AuthRequest).user!._id);
  res.status(200).json({ success: true, data });
};

export const adminSuspendPartner = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().suspendPartner(req.params.partnerId);
  res.status(200).json({ success: true, data });
};

// ── Partner self-service endpoints ──

export const getMyPartner = async (req: Request, res: Response, _next: NextFunction) => {
  const { partnerId } = await callerMemberContext(req as AuthRequest);
  const data = await service().getPartnerById(partnerId);
  res.status(200).json({ success: true, data });
};

export const updateMyPartner = async (req: Request, res: Response, _next: NextFunction) => {
  const { partnerId } = await callerMemberContext(req as AuthRequest);
  const data = await service().updatePartner(partnerId, req.body);
  res.status(200).json({ success: true, data });
};

// ── Member endpoints ──

export const listMembers = async (req: Request, res: Response, _next: NextFunction) => {
  const { partnerId } = await callerMemberContext(req as AuthRequest);
  const data = await service().listMembers(partnerId);
  res.status(200).json({ success: true, data });
};

export const getMember = async (req: Request, res: Response, _next: NextFunction) => {
  const { partnerId } = await callerMemberContext(req as AuthRequest);
  const data = await service().getMemberById(partnerId, req.params.memberId);
  res.status(200).json({ success: true, data });
};

export const addMember = async (req: Request, res: Response, _next: NextFunction) => {
  const ctx = await callerMemberContext(req as AuthRequest);
  const data = await service().addMember(
    ctx.partnerId, req.body, ctx.memberId, ctx.role, ctx.permissions
  );
  res.status(201).json({ success: true, data });
};

export const removeMember = async (req: Request, res: Response, _next: NextFunction) => {
  const ctx = await callerMemberContext(req as AuthRequest);
  await service().removeMember(ctx.partnerId, req.params.memberId, ctx.memberId);
  res.status(200).json({ success: true, message: 'Member removed' });
};

export const updateMemberPermissions = async (req: Request, res: Response, _next: NextFunction) => {
  const ctx = await callerMemberContext(req as AuthRequest);
  const data = await service().updateMemberPermissions(
    ctx.partnerId, req.params.memberId, req.body.permissions, ctx.role, ctx.permissions
  );
  res.status(200).json({ success: true, data });
};

// ── Branch endpoints ──

export const listBranches = async (req: Request, res: Response, _next: NextFunction) => {
  const { partnerId } = await callerMemberContext(req as AuthRequest);
  const data = await service().listBranches(partnerId);
  res.status(200).json({ success: true, data });
};

export const getBranch = async (req: Request, res: Response, _next: NextFunction) => {
  const { partnerId } = await callerMemberContext(req as AuthRequest);
  const data = await service().getBranchById(partnerId, req.params.branchId);
  res.status(200).json({ success: true, data });
};

export const createBranch = async (req: Request, res: Response, _next: NextFunction) => {
  const { partnerId } = await callerMemberContext(req as AuthRequest);
  const data = await service().createBranch(partnerId, req.body);
  res.status(201).json({ success: true, data });
};

export const updateBranch = async (req: Request, res: Response, _next: NextFunction) => {
  const { partnerId } = await callerMemberContext(req as AuthRequest);
  const data = await service().updateBranch(partnerId, req.params.branchId, req.body);
  res.status(200).json({ success: true, data });
};

export const deactivateBranch = async (req: Request, res: Response, _next: NextFunction) => {
  const { partnerId } = await callerMemberContext(req as AuthRequest);
  await service().deactivateBranch(partnerId, req.params.branchId);
  res.status(200).json({ success: true, message: 'Branch deactivated' });
};

// ── Admin member/branch endpoints (for admin managing any partner) ──

export const adminListMembers = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().listMembers(req.params.partnerId);
  res.status(200).json({ success: true, data });
};

export const adminListBranches = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().listBranches(req.params.partnerId);
  res.status(200).json({ success: true, data });
};
