import 'reflect-metadata';
import { RequestHandler, Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin, requireAnyPartnerPermission, requireOperationalPartner, requirePartnerPermission } from '@/modules/middleware/auth';
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
  createCatalogueItemSchema,
  updateCatalogueItemSchema,
  catalogueItemParamSchema,
} from '@/modules/partners/validation/catalogue';
import {
  createInvoiceSchema,
  recordPaymentSchema,
  cancelInvoiceSchema,
  invoiceParamSchema,
  invoiceQuerySchema,
  invoicePdfQuerySchema,
} from '@/modules/partners/validation/invoice';
import {
  listCatalogueItems,
  getCatalogueItem,
  createCatalogueItem,
  updateCatalogueItem,
  deactivateCatalogueItem,
  adminDisableCatalogueItem,
  adminEnableCatalogueItem,
} from '@/modules/partners/controller/catalogue';
import {
  createInvoice,
  listPartnerInvoices,
  getInvoice,
  getInvoicePdf,
  recordPayment,
  cancelInvoice,
  listCustomerBills,
  getCustomerBill,
  getCustomerBillPdf,
} from '@/modules/partners/controller/invoice';
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

/** Admission for one workspace route: who may call it and which permissions a member needs (all, or any one of). */
export interface WorkspaceGuard {
  (...perms: PartnerPermission[]): RequestHandler[];
  any(...perms: PartnerPermission[]): RequestHandler[];
}

const memberGuard: WorkspaceGuard = Object.assign(
  (...perms: PartnerPermission[]) =>
    perms.length > 0 ? [requirePartnerPermission(...perms), attachMemberActor] : [requireOperationalPartner, attachMemberActor],
  { any: (...perms: PartnerPermission[]) => [requireAnyPartnerPermission(...perms), attachMemberActor] }
);

/** Admins act with owner authority on the partner named in the URL. */
const adminGuard: WorkspaceGuard = Object.assign(
  (..._perms: PartnerPermission[]) => [requireAdmin, attachAdminActor],
  { any: (..._perms: PartnerPermission[]) => [requireAdmin, attachAdminActor] }
);

const INVOICE_READERS: PartnerPermission[] = ['invoices.create', 'invoices.cancel', 'payments.record', 'finance.view'];

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

  // Q2: catalogue (anyone who bills needs to read it) and in-house invoices
  r.get('/catalogue', ...guard.any('catalogue.manage', 'invoices.create'), catchAsync(listCatalogueItems));
  r.get('/catalogue/:itemId', ...guard.any('catalogue.manage', 'invoices.create'), validate(catalogueItemParamSchema, 'params'), catchAsync(getCatalogueItem));
  r.post('/catalogue', ...guard('catalogue.manage'), validate(createCatalogueItemSchema, 'body'), catchAsync(createCatalogueItem));
  r.put('/catalogue/:itemId', ...guard('catalogue.manage'), validate(catalogueItemParamSchema, 'params'),
    validate(updateCatalogueItemSchema, 'body'), catchAsync(updateCatalogueItem));
  r.delete('/catalogue/:itemId', ...guard('catalogue.manage'), validate(catalogueItemParamSchema, 'params'), catchAsync(deactivateCatalogueItem));

  r.get('/invoices', ...guard.any(...INVOICE_READERS), validate(invoiceQuerySchema, 'query'), catchAsync(listPartnerInvoices));
  r.post('/invoices', ...guard('invoices.create'), validate(createInvoiceSchema, 'body'), catchAsync(createInvoice));
  r.get('/invoices/:invoiceId', ...guard.any(...INVOICE_READERS), validate(invoiceParamSchema, 'params'), catchAsync(getInvoice));
  r.get('/invoices/:invoiceId/pdf', ...guard.any(...INVOICE_READERS), validate(invoiceParamSchema, 'params'),
    validate(invoicePdfQuerySchema, 'query'), catchAsync(getInvoicePdf));
  r.post('/invoices/:invoiceId/pay', ...guard('payments.record'), validate(invoiceParamSchema, 'params'),
    validate(recordPaymentSchema, 'body'), catchAsync(recordPayment));
  r.post('/invoices/:invoiceId/cancel', ...guard('invoices.cancel'), validate(invoiceParamSchema, 'params'),
    validate(cancelInvoiceSchema, 'body'), catchAsync(cancelInvoice));
}

const partnerRouter = Router();

// ── Admin: partner accounts ──
partnerRouter.post('/admin', requireAdmin, validate(createPartnerSchema, 'body'), catchAsync(adminCreatePartner));
partnerRouter.get('/admin', requireAdmin, validate(partnerQuerySchema, 'query'), catchAsync(adminListPartners));
partnerRouter.get('/admin/:partnerId', requireAdmin, validate(partnerIdParamSchema, 'params'), catchAsync(adminGetPartner));
partnerRouter.put('/admin/:partnerId', requireAdmin, validate(partnerIdParamSchema, 'params'),
  validate(updatePartnerSchema, 'body'), catchAsync(adminUpdatePartner));
partnerRouter.post('/admin/:partnerId/verify', requireAdmin, validate(partnerIdParamSchema, 'params'), catchAsync(adminVerifyPartner));
partnerRouter.post('/admin/catalogue/:itemId/disable', requireAdmin, validate(catalogueItemParamSchema, 'params'), catchAsync(adminDisableCatalogueItem));
partnerRouter.post('/admin/catalogue/:itemId/enable', requireAdmin, validate(catalogueItemParamSchema, 'params'), catchAsync(adminEnableCatalogueItem));
partnerRouter.post('/admin/:partnerId/suspend', requireAdmin, validate(partnerIdParamSchema, 'params'), catchAsync(adminSuspendPartner));

// ── Admin: everything a partner's owner can do, for any partner ──
const adminWorkspaceRouter = Router({ mergeParams: true });
registerWorkspaceRoutes(adminWorkspaceRouter, adminGuard);
partnerRouter.use('/admin/:partnerId/workspace', adminWorkspaceRouter);

// ── Partner members: their own partner ──
registerWorkspaceRoutes(partnerRouter, memberGuard);

export default partnerRouter;

/** Customer "Bills": in-house invoices linked to the signed-in customer (§6 walk-in linking). */
export const customerBillsRouter = Router();
customerBillsRouter.get('/', catchAsync(listCustomerBills));
customerBillsRouter.get('/:invoiceId', validate(invoiceParamSchema, 'params'), catchAsync(getCustomerBill));
customerBillsRouter.get('/:invoiceId/pdf', validate(invoiceParamSchema, 'params'), validate(invoicePdfQuerySchema, 'query'),
  catchAsync(getCustomerBillPdf));
