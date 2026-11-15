import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin, requireOperationalPartner, requirePartnerPermission } from '@/modules/middleware/auth';
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
} from '@/modules/partners/validation';
import {
  adminCreatePartner,
  adminListPartners,
  adminGetPartner,
  adminUpdatePartner,
  adminVerifyPartner,
  adminSuspendPartner,
  adminListMembers,
  adminListBranches,
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
  publicListPartners,
} from '@/modules/partners/controller';

const partnerRouter = Router();

// ── Admin routes ──
partnerRouter.post(
  '/admin',
  requireAdmin,
  validate(createPartnerSchema, 'body'),
  catchAsync(adminCreatePartner)
);
partnerRouter.get(
  '/admin',
  requireAdmin,
  validate(partnerQuerySchema, 'query'),
  catchAsync(adminListPartners)
);
partnerRouter.get(
  '/admin/:partnerId',
  requireAdmin,
  validate(partnerIdParamSchema, 'params'),
  catchAsync(adminGetPartner)
);
partnerRouter.put(
  '/admin/:partnerId',
  requireAdmin,
  validate(partnerIdParamSchema, 'params'),
  validate(updatePartnerSchema, 'body'),
  catchAsync(adminUpdatePartner)
);
partnerRouter.post(
  '/admin/:partnerId/verify',
  requireAdmin,
  validate(partnerIdParamSchema, 'params'),
  catchAsync(adminVerifyPartner)
);
partnerRouter.post(
  '/admin/:partnerId/suspend',
  requireAdmin,
  validate(partnerIdParamSchema, 'params'),
  catchAsync(adminSuspendPartner)
);
partnerRouter.get(
  '/admin/:partnerId/members',
  requireAdmin,
  validate(partnerIdParamSchema, 'params'),
  catchAsync(adminListMembers)
);
partnerRouter.get(
  '/admin/:partnerId/branches',
  requireAdmin,
  validate(partnerIdParamSchema, 'params'),
  catchAsync(adminListBranches)
);

// ── Partner self-service routes ──
partnerRouter.get(
  '/me',
  requireOperationalPartner,
  catchAsync(getMyPartner)
);
partnerRouter.put(
  '/me',
  requireOperationalPartner,
  validate(updateMyPartnerSchema, 'body'),
  catchAsync(updateMyPartner)
);

// ── Member routes ──
partnerRouter.get(
  '/members',
  requirePartnerPermission('staff.manage'),
  catchAsync(listMembers)
);
partnerRouter.get(
  '/members/:memberId',
  requirePartnerPermission('staff.manage'),
  catchAsync(getMember)
);
partnerRouter.post(
  '/members',
  requirePartnerPermission('staff.manage'),
  validate(addMemberSchema, 'body'),
  catchAsync(addMember)
);
partnerRouter.delete(
  '/members/:memberId',
  requirePartnerPermission('staff.manage'),
  catchAsync(removeMember)
);
partnerRouter.put(
  '/members/:memberId/permissions',
  requirePartnerPermission('staff.manage'),
  validate(updateMemberPermissionsSchema, 'body'),
  catchAsync(updateMemberPermissions)
);

// ── Branch routes ──
partnerRouter.get(
  '/branches',
  requirePartnerPermission('branches.manage'),
  catchAsync(listBranches)
);
partnerRouter.get(
  '/branches/:branchId',
  requirePartnerPermission('branches.manage'),
  catchAsync(getBranch)
);
partnerRouter.post(
  '/branches',
  requirePartnerPermission('branches.manage'),
  validate(createBranchSchema, 'body'),
  catchAsync(createBranch)
);
partnerRouter.put(
  '/branches/:branchId',
  requirePartnerPermission('branches.manage'),
  validate(updateBranchSchema, 'body'),
  catchAsync(updateBranch)
);
partnerRouter.delete(
  '/branches/:branchId',
  requirePartnerPermission('branches.manage'),
  catchAsync(deactivateBranch)
);

export const publicPartnerRouter = Router();
publicPartnerRouter.get(
  '/directory',
  validate(partnerQuerySchema, 'query'),
  catchAsync(publicListPartners)
);

export default partnerRouter;
