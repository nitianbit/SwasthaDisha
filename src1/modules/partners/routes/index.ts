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
  updateMemberBranchesSchema,
  branchListQuerySchema,
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
import * as lab from '@/modules/partners/controller/labBooking';
import * as fin from '@/modules/partners/controller/finance';
import * as clinic from '@/modules/partners/controller/clinic';
import * as clinicV from '@/modules/partners/validation/clinic';
import * as finV from '@/modules/partners/validation/finance';
import * as labV from '@/modules/partners/validation/labBooking';
import {
  adminCreatePartner,
  adminListPartners,
  adminGetPartner,
  adminUpdatePartner,
  adminVerifyPartner,
  adminSuspendPartner,
  adminReinstatePartner,
  updateMemberBranches,
  reactivateBranch,
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
  r.put('/members/:memberId/branches', ...guard('staff.manage'), validate(memberIdParamSchema, 'params'),
    validate(updateMemberBranchesSchema, 'body'), catchAsync(updateMemberBranches));

  r.get('/audit', ...guard('staff.manage'), catchAsync(listAudit));

  // Q8: any member may read their branches (names are needed to scope staff, bookings, invoices); closed ones only for branch managers.
  r.get('/branches', ...guard(), validate(branchListQuerySchema, 'query'), catchAsync(listBranches));
  r.get('/branches/:branchId', ...guard(), validate(branchIdParamSchema, 'params'), catchAsync(getBranch));
  r.post('/branches', ...guard('branches.manage'), validate(createBranchSchema, 'body'), catchAsync(createBranch));
  r.put('/branches/:branchId', ...guard('branches.manage'), validate(branchIdParamSchema, 'params'),
    validate(updateBranchSchema, 'body'), catchAsync(updateBranch));
  r.delete('/branches/:branchId', ...guard('branches.manage'), validate(branchIdParamSchema, 'params'), catchAsync(deactivateBranch));
  r.post('/branches/:branchId/reactivate', ...guard('branches.manage'), validate(branchIdParamSchema, 'params'), catchAsync(reactivateBranch));

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

  // Q3: lab slots (server-owned) and online lab bookings
  r.get('/slots', ...guard.any('slots.manage', 'bookings.view', 'bookings.manage'), validate(labV.partnerSlotsQuerySchema, 'query'), catchAsync(lab.getPartnerSlots));
  r.put('/branches/:branchId/slot-templates/:visitMode', ...guard('slots.manage'), validate(labV.slotTemplateParamSchema, 'params'),
    validate(labV.slotTemplateSchema, 'body'), catchAsync(lab.putSlotTemplate));
  r.post('/slots', ...guard('slots.manage'), validate(labV.manualSlotSchema, 'body'), catchAsync(lab.postManualSlot));
  r.put('/slots/:slotId/capacity', ...guard('slots.manage'), validate(labV.slotIdParamSchema, 'params'), validate(labV.slotCapacitySchema, 'body'),
    catchAsync(lab.putSlotCapacity));
  r.post('/slots/:slotId/close', ...guard('slots.manage'), validate(labV.slotIdParamSchema, 'params'), catchAsync(lab.closeSlot));
  r.post('/slots/:slotId/reopen', ...guard('slots.manage'), validate(labV.slotIdParamSchema, 'params'), catchAsync(lab.reopenSlot));

  const LAB_READERS: PartnerPermission[] = ['bookings.view', 'bookings.manage', 'reports.upload', 'reports.release'];
  const id = validate(labV.labBookingIdParamSchema, 'params');
  r.get('/lab-bookings', ...guard.any(...LAB_READERS), validate(labV.partnerLabBookingQuerySchema, 'query'), catchAsync(lab.listLabBookings));
  r.get('/lab-bookings/:bookingId', ...guard.any(...LAB_READERS), id, catchAsync(lab.getLabBooking));
  r.post('/lab-bookings/:bookingId/assign', ...guard('bookings.manage'), id, validate(labV.assignCollectorSchema, 'body'), catchAsync(lab.assignCollector));
  r.post('/lab-bookings/:bookingId/collect', ...guard('bookings.manage'), id, catchAsync(lab.markCollected));
  r.post('/lab-bookings/:bookingId/visit', ...guard('bookings.manage'), id, catchAsync(lab.markVisited));
  r.post('/lab-bookings/:bookingId/no-show', ...guard('bookings.manage'), id, catchAsync(lab.markNoShow));
  r.post('/lab-bookings/:bookingId/process', ...guard('bookings.manage'), id, catchAsync(lab.startProcessing));
  r.post('/lab-bookings/:bookingId/complete', ...guard('bookings.manage'), id, catchAsync(lab.completeLabBooking));
  r.post('/lab-bookings/:bookingId/reject', ...guard('bookings.manage'), id, validate(labV.rejectSchema, 'body'), catchAsync(lab.rejectLabBooking));
  r.post('/lab-bookings/:bookingId/reschedule', ...guard('bookings.manage'), id, validate(labV.labRescheduleSchema, 'body'), catchAsync(lab.rescheduleLabBooking));
  r.post('/lab-bookings/:bookingId/reports', ...guard('reports.upload'), id, catchAsync(lab.uploadLabReports));
  r.post('/lab-bookings/:bookingId/reports/release', ...guard('reports.release'), id, validate(labV.releaseReportSchema, 'body'), catchAsync(lab.releaseLabReport));

  // Q6: clinic — doctors (by invitation the doctor accepts), front-desk appointments on clinic doctors' slots.
  const appt = validate(clinicV.appointmentIdParamSchema, 'params');
  r.get('/clinic/doctors', ...guard.any('staff.manage', 'bookings.view', 'bookings.manage', 'invoices.create'), catchAsync(clinic.clinicDoctors));
  r.get('/clinic/doctor-invites', ...guard('staff.manage'), validate(clinicV.invitesQuerySchema, 'query'), catchAsync(clinic.clinicInvites));
  r.post('/clinic/doctor-invites', ...guard('staff.manage'), validate(clinicV.inviteDoctorSchema, 'body'), catchAsync(clinic.inviteDoctor));
  r.delete('/clinic/doctor-invites/:inviteId', ...guard('staff.manage'), validate(clinicV.inviteIdParamSchema, 'params'), catchAsync(clinic.revokeInvite));
  r.get('/clinic/slots', ...guard.any('bookings.view', 'bookings.manage'), validate(clinicV.deskSlotsQuerySchema, 'query'), catchAsync(clinic.deskSlots));
  r.get('/clinic/appointments', ...guard.any('bookings.view', 'bookings.manage'), validate(clinicV.appointmentsQuerySchema, 'query'), catchAsync(clinic.clinicAppointments));
  r.post('/clinic/appointments', ...guard('bookings.manage'), validate(clinicV.deskBookingSchema, 'body'), catchAsync(clinic.bookDesk));
  r.post('/clinic/appointments/:bookingId/arrived', ...guard('bookings.manage'), appt, catchAsync(clinic.deskArrived));
  r.post('/clinic/appointments/:bookingId/complete', ...guard('bookings.manage'), appt, catchAsync(clinic.deskComplete));
  r.post('/clinic/appointments/:bookingId/no-show', ...guard('bookings.manage'), appt, catchAsync(clinic.deskNoShow));
  r.post('/clinic/appointments/:bookingId/cancel', ...guard('bookings.manage'), appt, validate(clinicV.deskCancelSchema, 'body'), catchAsync(clinic.deskCancel));
  r.post('/clinic/appointments/:bookingId/reschedule', ...guard('bookings.manage'), appt, validate(clinicV.deskRescheduleSchema, 'body'), catchAsync(clinic.deskReschedule));

  // Q5: finance — balance, statement (+CSV), payouts; the payout destination is set by an owner (verified by an admin).
  r.get('/finance', ...guard('finance.view'), catchAsync(fin.partnerFinance));
  r.get('/finance/statement', ...guard('finance.view'), validate(finV.statementQuerySchema, 'query'), catchAsync(fin.partnerStatement));
  r.get('/finance/statement.csv', ...guard('finance.view'), validate(finV.csvQuerySchema, 'query'), catchAsync(fin.partnerStatementCsv));
  r.get('/finance/payouts', ...guard('finance.view'), catchAsync(fin.partnerPayouts));
  r.get('/finance/events', ...guard('finance.view'), catchAsync(fin.partnerEvents));
  r.put('/finance/payout-details', ...guard(), validate(finV.payoutDetailsSchema, 'body'), catchAsync(fin.putPartnerPayoutDetails));
}

const partnerRouter = Router();

// ── Admin: partner accounts ──
partnerRouter.post('/admin', requireAdmin, validate(createPartnerSchema, 'body'), catchAsync(adminCreatePartner));
partnerRouter.get('/admin', requireAdmin, validate(partnerQuerySchema, 'query'), catchAsync(adminListPartners));
// Static admin paths before /admin/:partnerId (which would otherwise capture them).
partnerRouter.get('/admin/lab-bookings', requireAdmin, catchAsync(lab.adminListLabBookings));
partnerRouter.get('/admin/:partnerId', requireAdmin, validate(partnerIdParamSchema, 'params'), catchAsync(adminGetPartner));
partnerRouter.put('/admin/:partnerId', requireAdmin, validate(partnerIdParamSchema, 'params'),
  validate(updatePartnerSchema, 'body'), catchAsync(adminUpdatePartner));
partnerRouter.post('/admin/:partnerId/verify', requireAdmin, validate(partnerIdParamSchema, 'params'), catchAsync(adminVerifyPartner));
partnerRouter.post('/admin/catalogue/:itemId/disable', requireAdmin, validate(catalogueItemParamSchema, 'params'), catchAsync(adminDisableCatalogueItem));
partnerRouter.post('/admin/catalogue/:itemId/enable', requireAdmin, validate(catalogueItemParamSchema, 'params'), catchAsync(adminEnableCatalogueItem));
partnerRouter.post('/admin/:partnerId/suspend', requireAdmin, validate(partnerIdParamSchema, 'params'), catchAsync(adminSuspendPartner));
partnerRouter.post('/admin/:partnerId/reinstate', requireAdmin, validate(partnerIdParamSchema, 'params'), catchAsync(adminReinstatePartner));

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


/** Customer discovery of partner labs (shown next to Healthians/LabStack in the app). */
export const customerLabRouter = Router();
customerLabRouter.get('/', validate(labV.labsQuerySchema, 'query'), catchAsync(lab.listLabs));
customerLabRouter.get('/branches/:branchId/slots', validate(labV.branchSlotsParamSchema, 'params'), validate(labV.branchSlotsQuerySchema, 'query'),
  catchAsync(lab.branchSlots));
customerLabRouter.get('/:partnerId/catalogue', validate(labV.labCatalogueParamSchema, 'params'), validate(labV.labCatalogueQuerySchema, 'query'),
  catchAsync(lab.labCatalogue));

/** Customer partner-lab bookings: create + pay, pay again, cancel, accept a new time, view (released reports only). */
export const customerLabBookingRouter = Router();
customerLabBookingRouter.post('/', validate(labV.createLabBookingSchema, 'body'), catchAsync(lab.createLabBooking));
customerLabBookingRouter.get('/', catchAsync(lab.myLabBookings));
customerLabBookingRouter.get('/:bookingId', validate(labV.labBookingIdParamSchema, 'params'), catchAsync(lab.myLabBooking));
customerLabBookingRouter.post('/:bookingId/pay', validate(labV.labBookingIdParamSchema, 'params'), validate(labV.payAgainSchema, 'body'),
  catchAsync(lab.payLabBookingAgain));
customerLabBookingRouter.post('/:bookingId/cancel', validate(labV.labBookingIdParamSchema, 'params'), validate(labV.customerCancelSchema, 'body'),
  catchAsync(lab.cancelMyLabBooking));
customerLabBookingRouter.post('/:bookingId/accept-reschedule', validate(labV.labBookingIdParamSchema, 'params'),
  validate(labV.acceptRescheduleSchema, 'body'), catchAsync(lab.acceptLabReschedule));

/**
 * Q5 admin finance across every settlement account (partners and doctors): the payout queue, statements, verifying
 * payout destinations, recording/voiding transfers and adjustments. Mounted at /api/v1/settlements (admins only).
 */
export const settlementAdminRouter = Router();
const acc = validate(finV.accountIdParamSchema, 'params');
settlementAdminRouter.use(requireAdmin);
settlementAdminRouter.get('/accounts', validate(finV.accountsQuerySchema, 'query'), catchAsync(fin.adminAccounts));
settlementAdminRouter.get('/accounts/:accountId', acc, catchAsync(fin.adminAccount));
settlementAdminRouter.get('/accounts/:accountId/statement', acc, validate(finV.statementQuerySchema, 'query'), catchAsync(fin.adminStatement));
settlementAdminRouter.get('/accounts/:accountId/statement.csv', acc, validate(finV.csvQuerySchema, 'query'), catchAsync(fin.adminStatementCsv));
settlementAdminRouter.get('/accounts/:accountId/payouts', acc, catchAsync(fin.adminAccountPayouts));
settlementAdminRouter.get('/accounts/:accountId/history', acc, catchAsync(fin.adminHistory));
settlementAdminRouter.get('/accounts/:accountId/events', acc, catchAsync(fin.adminEvents));
settlementAdminRouter.put('/accounts/:accountId/payout-details', acc, validate(finV.payoutDetailsSchema, 'body'), catchAsync(fin.adminPutPayoutDetails));
settlementAdminRouter.post('/accounts/:accountId/payout-details/verify', acc, validate(finV.verifyDetailsSchema, 'body'), catchAsync(fin.adminVerifyPayoutDetails));
settlementAdminRouter.post('/accounts/:accountId/payouts', acc, validate(finV.recordPayoutSchema, 'body'), catchAsync(fin.adminRecordPayout));
settlementAdminRouter.post('/accounts/:accountId/adjustments', acc, validate(finV.adjustmentSchema, 'body'), catchAsync(fin.adminAdjustment));
settlementAdminRouter.get('/payouts', validate(finV.payoutsQuerySchema, 'query'), catchAsync(fin.adminPayouts));
settlementAdminRouter.post('/payouts/:payoutId/void', validate(finV.payoutIdParamSchema, 'params'), validate(finV.voidPayoutSchema, 'body'), catchAsync(fin.adminVoidPayout));
