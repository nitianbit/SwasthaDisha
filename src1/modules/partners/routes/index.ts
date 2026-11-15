import 'reflect-metadata';
import { RequestHandler, Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin, requireOperationalPartner, requirePartnerPermission } from '@/modules/middleware/auth';
import type { PartnerPermission } from '@/modules/partners/types';
import {
  createPartnerSchema,
  updatePartnerSchema,
  updateMyPartnerSchema,
  partnerQuerySchema,
  partnerIdParamSchema,
  addMemberSchema,
  updateMemberPermissionsSchema,
  createBranchSchema,
  updateBranchSchema,
  memberIdParamSchema,
  branchIdParamSchema,
} from '@/modules/partners/validation';
import {
  adminCreatePartner,
  adminListPartners,
  adminGetPartner,
  adminUpdatePartner,
  adminVerifyPartner,
  adminSuspendPartner,
  attachAdminActor,
  attachMemberActor,
  getMyPartner,
  updateMyPartner,
  listMembers,
  getMember,
  addMember,
  removeMember,
  updateMemberPermissions,
  listBranches,
  getBranch,
  createBranch,
  updateBranch,
  deactivateBranch,
  listAudit,
} from '@/modules/partners/controller';

/** Admission for one workspace route: who may call it and which permission (if any) a member needs. */
export type WorkspaceGuard = (...perms: PartnerPermission[]) => RequestHandler[];

const memberGuard: WorkspaceGuard = (...perms) =>
  perms.length > 0 ? [requirePartnerPermission(...perms), attachMemberActor] : [requireOperationalPartner, attachMemberActor];

/** Admins act with owner authority on the partner named in the URL. */
const adminGuard: WorkspaceGuard = () => [requireAdmin, attachAdminActor];

/**
 * The partner workspace (profile, staff, branches; later packets add catalogue, invoices, bookings, finance). Registered
 * twice: for a partner's own members, and for platform admins managing any partner.
 */
export function registerWorkspaceRoutes(r: Router, guard: WorkspaceGuard): void {
  r.get('/me', ...guard(), catchAsync(getMyPartner));
  r.put('/me', ...guard(), validate(updateMyPartnerSchema, 'body'), catchAsync(updateMyPartner));

  r.get('/members', ...guard('staff.manage'), catchAsync(listMembers));
  r.get('/members/:memberId', ...guard('staff.manage'), validate(memberIdParamSchema, 'params'), catchAsync(getMember));
  r.post('/members', ...guard('staff.manage'), validate(addMemberSchema, 'body'), catchAsync(addMember));
  r.delete('/members/:memberId', ...guard('staff.manage'), validate(memberIdParamSchema, 'params'), catchAsync(removeMember));
  r.put('/members/:memberId/permissions', ...guard('staff.manage'), validate(memberIdParamSchema, 'params'),
    validate(updateMemberPermissionsSchema, 'body'), catchAsync(updateMemberPermissions));

  r.get('/audit', ...guard('staff.manage'), catchAsync(listAudit));

  r.get('/branches', ...guard('branches.manage'), catchAsync(listBranches));
  r.get('/branches/:branchId', ...guard('branches.manage'), validate(branchIdParamSchema, 'params'), catchAsync(getBranch));
  r.post('/branches', ...guard('branches.manage'), validate(createBranchSchema, 'body'), catchAsync(createBranch));
  r.put('/branches/:branchId', ...guard('branches.manage'), validate(branchIdParamSchema, 'params'),
    validate(updateBranchSchema, 'body'), catchAsync(updateBranch));
  r.delete('/branches/:branchId', ...guard('branches.manage'), validate(branchIdParamSchema, 'params'), catchAsync(deactivateBranch));
}

const partnerRouter = Router();

// ── Admin: partner accounts ──
partnerRouter.post('/admin', requireAdmin, validate(createPartnerSchema, 'body'), catchAsync(adminCreatePartner));
partnerRouter.get('/admin', requireAdmin, validate(partnerQuerySchema, 'query'), catchAsync(adminListPartners));
partnerRouter.get('/admin/:partnerId', requireAdmin, validate(partnerIdParamSchema, 'params'), catchAsync(adminGetPartner));
partnerRouter.put('/admin/:partnerId', requireAdmin, validate(partnerIdParamSchema, 'params'),
  validate(updatePartnerSchema, 'body'), catchAsync(adminUpdatePartner));
partnerRouter.post('/admin/:partnerId/verify', requireAdmin, validate(partnerIdParamSchema, 'params'), catchAsync(adminVerifyPartner));
partnerRouter.post('/admin/:partnerId/suspend', requireAdmin, validate(partnerIdParamSchema, 'params'), catchAsync(adminSuspendPartner));

// ── Admin: everything a partner's owner can do, for any partner ──
const adminWorkspaceRouter = Router({ mergeParams: true });
registerWorkspaceRoutes(adminWorkspaceRouter, adminGuard);
partnerRouter.use('/admin/:partnerId/workspace', adminWorkspaceRouter);

// ── Partner members: their own partner ──
registerWorkspaceRoutes(partnerRouter, memberGuard);

export default partnerRouter;
