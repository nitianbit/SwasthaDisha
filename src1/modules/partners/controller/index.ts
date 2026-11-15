import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AuthRequest } from '@/modules/middleware/auth';
import { PartnerService, PartnerActor, adminActor } from '@/modules/partners/services';
import { PartnerPermission, MemberRole } from '@/modules/partners/types';
import MemberModel from '@/modules/partners/model/member';
import { AppError } from '@/modules/common/types';

const service = () => Container.get(PartnerService);

export type PartnerActorRequest = AuthRequest & { partnerActor?: PartnerActor };

/** Set by attachMemberActor / attachAdminActor; every workspace handler acts only through it. */
export function actorOf(req: Request): PartnerActor {
  const actor = (req as PartnerActorRequest).partnerActor;
  if (!actor) throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Partner access is required' });
  return actor;
}

export const attachMemberActor = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    (req as PartnerActorRequest).partnerActor = await loadPartnerActor(req as AuthRequest);
    next();
  } catch (error) {
    next(error);
  }
};

/** A platform admin manages any partner with owner authority (whatever its verification state). */
export const attachAdminActor = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = (req as AuthRequest).user;
    if (!user || user.userType !== 'admin') {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Admin access is required' });
    }
    const partnerId = String(req.params.partnerId ?? '');
    if (!/^[0-9a-fA-F]{24}$/.test(partnerId)) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid partner id' });
    }
    await service().getPartnerById(partnerId);
    (req as PartnerActorRequest).partnerActor = adminActor(String(user._id), partnerId);
    next();
  } catch (error) {
    next(error);
  }
};

/** The admitted member, re-read from the database (role, permissions and branch scope are never taken from the token). */
export async function loadPartnerActor(req: AuthRequest): Promise<PartnerActor> {
  const memberId = req.user?.memberId;
  const member = memberId
    ? await MemberModel.findById(memberId).select('partnerId role permissions branchIds isActive').lean()
    : null;
  if (!member || member.isActive === false || String(member.partnerId) !== String(req.user?.partnerId)) {
    throw new AppError({ status: 403, code: 'PARTNER_MEMBER_INACTIVE', message: 'Partner membership is inactive' });
  }
  return {
    memberId: String(member._id),
    partnerId: String(member.partnerId),
    role: member.role as MemberRole,
    permissions: (member.permissions ?? []) as PartnerPermission[],
    branchIds: (member.branchIds ?? []).map(String),
  };
}

// ── Admin endpoints ──

export const adminCreatePartner = async (req: Request, res: Response, _next: NextFunction) => {
  const { requestKey, ...body } = req.body;
  const result = await service().createPartner({ ...body, ...(requestKey ? { requestKey, createdBy: String((req as AuthRequest).user!._id) } : {}) });
  res.status(result.replayed ? 200 : 201).json({ success: true, data: { partner: result.partner, owner: result.owner } });
};

export const adminListPartners = async (req: Request, res: Response, _next: NextFunction) => {
  const filter: any = {};
  if (req.query.kind) filter.kind = req.query.kind;
  if (req.query.verificationState) filter.verificationState = req.query.verificationState;
  if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';
  if (typeof req.query.q === 'string') filter.q = req.query.q;
  if (req.query.page !== undefined) filter.page = Number(req.query.page);
  if (req.query.limit !== undefined) filter.limit = Number(req.query.limit);
  const r = await service().listPartners(filter);
  res.status(200).json({ success: true, data: r.items, pagination: { page: r.page, limit: r.limit, total: r.total, totalPages: r.totalPages } });
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

export const adminPartnerByKey = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().findCreatedByKey(String((req as AuthRequest).user!._id), req.params.key);
  if (!data) { res.status(404).json({ error: 404, code: 'PARTNER_NOT_FOUND', message: 'No partner was created with this key' }); return; }
  res.status(200).json({ success: true, data });
};

export const adminAbandonPartnerKey = async (req: Request, res: Response, _next: NextFunction) => {
  res.status(200).json({ success: true, data: await service().abandonCreateKey(String((req as AuthRequest).user!._id), req.params.key) });
};

export const adminReinstatePartner = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().reinstatePartner(req.params.partnerId, String((req as AuthRequest).user!._id));
  res.status(200).json({ success: true, data });
};

// ── Partner self-service endpoints ──

export const getMyPartner = async (req: Request, res: Response, _next: NextFunction) => {
  const actor = actorOf(req);
  const data = await service().getPartnerById(actor.partnerId);
  res.status(200).json({ success: true, data });
};

export const updateMyPartner = async (req: Request, res: Response, _next: NextFunction) => {
  const actor = actorOf(req);
  const data = await service().updateOwnProfile(actor, req.body);
  res.status(200).json({ success: true, data });
};

// ── Member endpoints ──

export const listMembers = async (req: Request, res: Response, _next: NextFunction) => {
  const actor = actorOf(req);
  const data = await service().listMembers(actor);
  res.status(200).json({ success: true, data });
};

export const getMember = async (req: Request, res: Response, _next: NextFunction) => {
  const actor = actorOf(req);
  const data = await service().getMember(actor, req.params.memberId);
  res.status(200).json({ success: true, data });
};

export const addMember = async (req: Request, res: Response, _next: NextFunction) => {
  const actor = actorOf(req);
  const data = await service().addMember(actor, req.body);
  res.status(201).json({ success: true, data });
};

export const removeMember = async (req: Request, res: Response, _next: NextFunction) => {
  const actor = actorOf(req);
  await service().removeMember(actor, req.params.memberId);
  res.status(200).json({ success: true, message: 'Member removed' });
};

export const updateMemberPermissions = async (req: Request, res: Response, _next: NextFunction) => {
  const actor = actorOf(req);
  const data = await service().updateMemberPermissions(actor, req.params.memberId, req.body.permissions, req.body.expectedUpdatedAt);
  res.status(200).json({ success: true, data });
};

export const updateMemberBranches = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().updateMemberBranches(actorOf(req), req.params.memberId, req.body.branchIds, req.body.expectedUpdatedAt);
  res.status(200).json({ success: true, data });
};

// ── Branch endpoints ──

export const listBranches = async (req: Request, res: Response, _next: NextFunction) => {
  const actor = actorOf(req);
  const data = await service().listBranches(actor, req.query.includeInactive === 'true');
  res.status(200).json({ success: true, data });
};

export const getBranch = async (req: Request, res: Response, _next: NextFunction) => {
  const actor = actorOf(req);
  const data = await service().getBranch(actor, req.params.branchId);
  res.status(200).json({ success: true, data });
};

export const createBranch = async (req: Request, res: Response, _next: NextFunction) => {
  const actor = actorOf(req);
  const data = await service().createBranch(actor, req.body);
  res.status(201).json({ success: true, data });
};

export const updateBranch = async (req: Request, res: Response, _next: NextFunction) => {
  const actor = actorOf(req);
  const data = await service().updateBranch(actor, req.params.branchId, req.body);
  res.status(200).json({ success: true, data });
};

export const deactivateBranch = async (req: Request, res: Response, _next: NextFunction) => {
  const actor = actorOf(req);
  await service().deactivateBranch(actor, req.params.branchId);
  res.status(200).json({ success: true, message: 'Branch deactivated' });
};

export const reactivateBranch = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().reactivateBranch(actorOf(req), req.params.branchId);
  res.status(200).json({ success: true, data });
};

export const listAudit = async (req: Request, res: Response, _next: NextFunction) => {
  const actor = actorOf(req);
  const data = await service().listAudit(actor);
  res.status(200).json({ success: true, data });
};
