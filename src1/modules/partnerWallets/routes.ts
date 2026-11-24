import 'reflect-metadata';
import { Router, type NextFunction, type Response } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { AppError } from '@/modules/common/types';
import { assertOperationalPartner, requireAdmin, type AuthRequest } from '@/modules/middleware/auth';
import MemberModel from '@/modules/partners/model/member';
import PartnerModel from '@/modules/partners/model';
import type { PartnerPermission } from '@/modules/partners/types';
import { reconcilePaymentSchema, verifyPaymentSchema } from '@/modules/payment/validation';
import { freezeSchema } from '@/modules/assisted/validation';
import { ADMIN_TOPUP_KEY } from '@/modules/pharmacyWallet/validation';
import * as svc from '@/modules/partnerWallets/service';
import { adminKeyParamSchema, adminLabTopupSchema, labTopupSchema, pageQuerySchema } from '@/modules/partnerWallets/validation';

/**
 * r13 (round 2d, §24.7.3) routes.
 * - `/api/v1/partner-workspace/assisted/*`: members of a LAB holding `wallet.view` / `wallet.manage` (owners hold all).
 *   A new top-up also needs an operational (active, verified) lab. Reads, the top-up check, verify and reconcile work
 *   for any active member of an active lab, verified or not: a paid top-up is the lab's own money (§19.8 item b).
 * - `/api/v1/admin/labs/:partnerId/wallet*`: admins (writes behind the admin tools switch).
 */
const fail = (status: number, code: string, message: string) => new AppError({ status, code, message });

/** A member of a lab holding `perm` (2e: or any one of several; the service then checks the one its record needs). */
const labMember = (perm: PartnerPermission | PartnerPermission[], opts: { operational?: boolean } = {}) =>
  catchAsync(async (req: AuthRequest, _res: Response, next: NextFunction) => {
    if (!req.user) throw fail(401, 'UNAUTHORIZED', 'Authentication is required');
    if (req.user.userType !== 'partner') throw fail(403, 'FORBIDDEN', 'Partner access is required');
    if (opts.operational) await assertOperationalPartner(req);
    const member = await MemberModel.findById(req.user.memberId || req.user._id).select('partnerId isActive role permissions').lean();
    if (!member || member.isActive === false) throw fail(403, 'PARTNER_MEMBER_INACTIVE', 'Partner membership is inactive');
    const partner = await PartnerModel.findById(member.partnerId).select('kind isActive').lean();
    if (!partner || partner.isActive === false) throw fail(403, 'PARTNER_INACTIVE', 'Partner is inactive');
    if (partner.kind !== 'lab') throw fail(404, 'WALLET_NOT_FOUND', 'This workspace has no lab wallet');
    const perms = Array.isArray(perm) ? perm : [perm];
    if (member.role !== 'owner' && !perms.some((p) => (member.permissions ?? []).includes(p))) {
      throw fail(403, 'INSUFFICIENT_PERMISSIONS', `Missing permissions: ${perms.join(' or ')}`);
    }
    req.user.memberId = String(member._id);
    req.user.partnerId = String(member.partnerId).toLowerCase();
    next();
  });

const memberOf = (req: AuthRequest): svc.LabMember => ({ partnerId: String(req.user!.partnerId), memberId: String(req.user!.memberId) });
const send = (res: Response, data: unknown, extra: Record<string, unknown> = {}) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).json({ success: true, data, ...extra });
};
const listed = (res: Response, r: { items: unknown[]; nextCursor: string | null }) => send(res, r.items, { pagination: { nextCursor: r.nextCursor } });
const pageOf = (req: AuthRequest) => req.query as { cursor?: string; limit?: number };

/** Mounted at `/api/v1/partner-workspace/assisted`. 2e's lab-booker routes share the prefix from the workspace router (`assisted/routes/labBooker.ts`). */
export const labWalletWorkspaceRouter = Router();
labWalletWorkspaceRouter.get('/wallet', labMember('wallet.view'), catchAsync(async (req: AuthRequest, res) => send(res, await svc.walletOf(memberOf(req).partnerId))));
labWalletWorkspaceRouter.get('/wallet/entries', labMember('wallet.view'), validate(pageQuerySchema, 'query'),
  catchAsync(async (req: AuthRequest, res) => listed(res, await svc.entriesOf(memberOf(req).partnerId, pageOf(req)))));
labWalletWorkspaceRouter.get('/wallet/topups', labMember('wallet.view'), validate(pageQuerySchema, 'query'),
  catchAsync(async (req: AuthRequest, res) => listed(res, await svc.topupsOf(memberOf(req).partnerId, pageOf(req)))));
labWalletWorkspaceRouter.post('/wallet/topups', labMember('wallet.manage', { operational: true }), validate(labTopupSchema, 'body'),
  catchAsync(async (req: AuthRequest, res) => send(res, await svc.createLabTopup(memberOf(req), req.body))));
labWalletWorkspaceRouter.post('/wallet/topups/:paymentTransactionId/check', labMember('wallet.view'),
  catchAsync(async (req: AuthRequest, res) => send(res, await svc.checkLabTopup(memberOf(req), req.params.paymentTransactionId))));
// 2e: the same two routes settle a card payment of a consultation the lab booked (members with `assisted.book`).
labWalletWorkspaceRouter.post('/payments/verify', labMember(['wallet.manage', 'assisted.book']), validate(verifyPaymentSchema, 'body'),
  catchAsync(async (req: AuthRequest, res) => send(res, await svc.verifyLabPayment(memberOf(req), req.body))));
labWalletWorkspaceRouter.post('/payments/reconcile', labMember(['wallet.manage', 'assisted.book']), validate(reconcilePaymentSchema, 'body'),
  catchAsync(async (req: AuthRequest, res) => send(res, await svc.reconcileLabPayment(memberOf(req), String(req.body.paymentTransactionId)))));

const adminId = (req: AuthRequest) => String(req.user?._id ?? '');
/** Mounted at `/api/v1/admin/labs`. */
export const adminLabWalletRouter = Router();
adminLabWalletRouter.get('/:partnerId/wallet', requireAdmin, catchAsync(async (req: AuthRequest, res) => send(res, await svc.adminWallet(req.params.partnerId))));
adminLabWalletRouter.get('/:partnerId/wallet/entries', requireAdmin, validate(pageQuerySchema, 'query'),
  catchAsync(async (req: AuthRequest, res) => listed(res, await svc.adminEntries(req.params.partnerId, pageOf(req)))));
adminLabWalletRouter.get('/:partnerId/wallet/lots', requireAdmin, catchAsync(async (req: AuthRequest, res) => send(res, await svc.adminLots(req.params.partnerId))));
adminLabWalletRouter.post('/:partnerId/wallet/topup', requireAdmin, validate(adminLabTopupSchema, 'body'), catchAsync(async (req: AuthRequest, res) => {
  // As the pharmacy admin top-up (review of fb4063c7, 4; r8 B5): an Idempotency-Key is required, 8–100 letters, digits, _ or -.
  const key = req.header('Idempotency-Key')?.trim();
  if (!key) throw fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header is required for an admin top-up');
  if (!ADMIN_TOPUP_KEY.test(key)) throw fail(400, 'VALIDATION_ERROR', 'Idempotency-Key must be 8 to 100 letters, digits, _ or -');
  send(res, await svc.adminLabTopup(adminId(req), req.params.partnerId, key, req.body));
}));
adminLabWalletRouter.get('/:partnerId/wallet/topups/by-key/:key', requireAdmin, validate(adminKeyParamSchema, 'params'),
  catchAsync(async (req: AuthRequest, res) => send(res, await svc.adminLabTopupByKey(req.params.partnerId, req.params.key))));
adminLabWalletRouter.put('/:partnerId/wallet/freeze', requireAdmin, validate(freezeSchema, 'body'),
  catchAsync(async (req: AuthRequest, res) => send(res, await svc.adminLabFreeze(adminId(req), req.params.partnerId, req.body.frozen === true, String(req.body.reason).trim()))));
