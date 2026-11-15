import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { authenticate, requireAdmin, requireOperationalPartner, requirePartnerPermission } from '@/modules/middleware/auth';
import {
  createPartnerSchema,
  updatePartnerSchema,
  partnerQuerySchema,
  partnerIdParamSchema,
  addMemberSchema,
  updateMemberPermissionsSchema,
  createBranchSchema,
  updateBranchSchema,
  createCatalogueItemSchema,
  updateCatalogueItemSchema,
  catalogueItemParamSchema,
  createInvoiceSchema,
  recordPaymentSchema,
  cancelInvoiceSchema,
  invoiceParamSchema,
  invoiceQuerySchema,
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
} from '@/modules/partners/controller';
import {
  listCatalogueItems,
  getCatalogueItem,
  createCatalogueItem,
  updateCatalogueItem,
  deactivateCatalogueItem,
  adminDisableCatalogueItem,
} from '@/modules/partners/controller/catalogue';
import {
  createInvoice,
  recordPayment,
  cancelInvoice,
  getInvoice,
  listPartnerInvoices,
  listCustomerBills,
} from '@/modules/partners/controller/invoice';

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
  validate(updatePartnerSchema, 'body'),
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

// ── Catalogue routes ──
partnerRouter.get(
  '/catalogue',
  requirePartnerPermission('catalogue.manage'),
  catchAsync(listCatalogueItems)
);
partnerRouter.get(
  '/catalogue/:itemId',
  requirePartnerPermission('catalogue.manage'),
  validate(catalogueItemParamSchema, 'params'),
  catchAsync(getCatalogueItem)
);
partnerRouter.post(
  '/catalogue',
  requirePartnerPermission('catalogue.manage'),
  validate(createCatalogueItemSchema, 'body'),
  catchAsync(createCatalogueItem)
);
partnerRouter.put(
  '/catalogue/:itemId',
  requirePartnerPermission('catalogue.manage'),
  validate(catalogueItemParamSchema, 'params'),
  validate(updateCatalogueItemSchema, 'body'),
  catchAsync(updateCatalogueItem)
);
partnerRouter.delete(
  '/catalogue/:itemId',
  requirePartnerPermission('catalogue.manage'),
  validate(catalogueItemParamSchema, 'params'),
  catchAsync(deactivateCatalogueItem)
);
partnerRouter.post(
  '/admin/catalogue/:itemId/disable',
  requireAdmin,
  validate(catalogueItemParamSchema, 'params'),
  catchAsync(adminDisableCatalogueItem)
);

// ── Invoice routes ──
partnerRouter.get(
  '/invoices',
  requirePartnerPermission('invoices.create'),
  validate(invoiceQuerySchema, 'query'),
  catchAsync(listPartnerInvoices)
);
partnerRouter.post(
  '/invoices',
  requirePartnerPermission('invoices.create'),
  validate(createInvoiceSchema, 'body'),
  catchAsync(createInvoice)
);
partnerRouter.get(
  '/invoices/:invoiceId',
  requirePartnerPermission('invoices.create'),
  validate(invoiceParamSchema, 'params'),
  catchAsync(getInvoice)
);
partnerRouter.post(
  '/invoices/:invoiceId/pay',
  requirePartnerPermission('payments.record'),
  validate(invoiceParamSchema, 'params'),
  validate(recordPaymentSchema, 'body'),
  catchAsync(recordPayment)
);
partnerRouter.post(
  '/invoices/:invoiceId/cancel',
  requirePartnerPermission('invoices.cancel'),
  validate(invoiceParamSchema, 'params'),
  validate(cancelInvoiceSchema, 'body'),
  catchAsync(cancelInvoice)
);

// ── Customer bills (authenticated customer) ──
partnerRouter.get(
  '/bills',
  authenticate,
  catchAsync(listCustomerBills)
);

export default partnerRouter;
