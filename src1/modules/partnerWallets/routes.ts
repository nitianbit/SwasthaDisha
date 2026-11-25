import 'reflect-metadata';
import { Router, type NextFunction, type Response } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { AppError } from '@/modules/common/types';
import {
  requireAdmin, requireAnyPartnerPermission, requireAnyPartnerPermissionUnverified, requirePartnerPermission, requirePartnerPermissionUnverified,
  requireSpecialist, type AuthRequest,
} from '@/modules/middleware/auth';
import { requireEligibleDoctor } from '@/modules/specialists/eligibility';
import { DOCTOR, LAB, type PartnerOwner } from '@/modules/partnerWallets/ledger';
import PartnerModel from '@/modules/partners/model';
import type { PartnerPermission } from '@/modules/partners/types';
import { reconcilePaymentSchema, verifyPaymentSchema } from '@/modules/payment/validation';
import { freezeSchema } from '@/modules/assisted/validation';
import { ADMIN_TOPUP_KEY } from '@/modules/pharmacyWallet/validation';
import * as svc from '@/modules/partnerWallets/service';
import { adminKeyParamSchema, adminLabTopupSchema, walletTopupSchema, pageQuerySchema } from '@/modules/partnerWallets/validation';

/**
 * r13 (round 2d, §24.7.3) and r20 (round 3a, §25.4.2) routes.
 * - `/api/v1/partner-workspace/assisted/*`: members of a LAB holding `wallet.view` / `wallet.manage` (owners hold all).
 *   A new top-up also needs an operational (active, verified) lab. Reads, the top-up check, verify and reconcile work
 *   for any active member of an active lab, verified or not: a paid top-up is the lab's own money (§19.8 item b).
 * - `/api/v1/specialists/me/assisted/*` (r20): the doctor's own wallet.
 * - `/api/v1/admin/{labs|doctors}/:id/wallet*`: admins (writes behind the admin tools switch).
 */
const fail = (status: number, code: string, message: string) => new AppError({ status, code, message });

/**
 * A lab member holding `perm` (owners hold all), through the shared partner guards: `operational` (a new top-up) needs a
 * verified lab, the rest admit an unverified one (2d D5). The workspace must be a lab's (404 WALLET_NOT_FOUND otherwise).
 */
const labOnly = catchAsync(async (req: AuthRequest, _res: Response, next: NextFunction) => {
  const partner = await PartnerModel.findById(req.user!.partnerId).select('kind').lean();
  if (partner?.kind !== 'lab') throw fail(404, 'WALLET_NOT_FOUND', 'This workspace has no lab wallet');
  next();
});
const labMember = (perm: PartnerPermission | PartnerPermission[], opts: { operational?: boolean } = {}) => {
  // 2e: several permissions mean any one of them (the service then checks the one its record needs).
  const any = Array.isArray(perm);
  const perms = any ? perm : [perm];
  const guard = opts.operational ? (any ? requireAnyPartnerPermission : requirePartnerPermission)
    : (any ? requireAnyPartnerPermissionUnverified : requirePartnerPermissionUnverified);
  return [guard(...perms), labOnly];
};

const memberOf = (req: AuthRequest): svc.LabMember => ({ partnerId: String(req.user!.partnerId).toLowerCase(), memberId: String(req.user!.memberId) });
const send = (res: Response, data: unknown, extra: Record<string, unknown> = {}) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).json({ success: true, data, ...extra });
};
const listed = (res: Response, r: { items: unknown[]; nextCursor: string | null }) => send(res, r.items, { pagination: { nextCursor: r.nextCursor } });
const pageOf = (req: AuthRequest) => req.query as { cursor?: string; limit?: number };

/** Mounted at `/api/v1/partner-workspace/assisted` (2e adds its lab-booker routes here). */
export const labWalletWorkspaceRouter = Router();
const labOf = (req: AuthRequest) => memberOf(req).partnerId;
labWalletWorkspaceRouter.get('/wallet', ...labMember('wallet.view'), catchAsync(async (req: AuthRequest, res) => send(res, await svc.walletOf(LAB, labOf(req)))));
labWalletWorkspaceRouter.get('/wallet/entries', ...labMember('wallet.view'), validate(pageQuerySchema, 'query'),
  catchAsync(async (req: AuthRequest, res) => listed(res, await svc.entriesOf(LAB, labOf(req), pageOf(req)))));
labWalletWorkspaceRouter.get('/wallet/topups', ...labMember('wallet.view'), validate(pageQuerySchema, 'query'),
  catchAsync(async (req: AuthRequest, res) => listed(res, await svc.topupsOf(LAB, labOf(req), pageOf(req)))));
labWalletWorkspaceRouter.post('/wallet/topups', ...labMember('wallet.manage', { operational: true }), validate(walletTopupSchema, 'body'),
  catchAsync(async (req: AuthRequest, res) => send(res, await svc.createTopup(LAB, labOf(req), memberOf(req).memberId, req.body))));
labWalletWorkspaceRouter.post('/wallet/topups/:paymentTransactionId/check', ...labMember('wallet.view'),
  catchAsync(async (req: AuthRequest, res) => send(res, await svc.checkLabTopup(LAB, memberOf(req), req.params.paymentTransactionId))));
// 2e: the same two routes settle a card payment of a consultation the lab booked (members with `assisted.book`).
labWalletWorkspaceRouter.post('/payments/verify', ...labMember(['wallet.manage', 'assisted.book']), validate(verifyPaymentSchema, 'body'),
  catchAsync(async (req: AuthRequest, res) => send(res, await svc.verifyLabPayment(LAB, memberOf(req), req.body))));
labWalletWorkspaceRouter.post('/payments/reconcile', ...labMember(['wallet.manage', 'assisted.book']), validate(reconcilePaymentSchema, 'body'),
  catchAsync(async (req: AuthRequest, res) => send(res, await svc.reconcileLabPayment(LAB, memberOf(req), String(req.body.paymentTransactionId)))));

/**
 * r20 (§25.4.2): the doctor's own wallet, mounted at `/api/v1/specialists/me/assisted`. Reads and new top-ups need an
 * eligible doctor (S5, DR3); the top-up check does not (a paid top-up is always credited). Verify and reconcile are the
 * existing `/api/v1/payments` routes.
 */
export const doctorWalletRouter = Router();
const doctorOf = (req: AuthRequest) => String(req.user?.specialistId || req.user?._id || '').toLowerCase();
const eligibleDoctor = [requireSpecialist, catchAsync(requireEligibleDoctor)];
doctorWalletRouter.get('/wallet', ...eligibleDoctor, catchAsync(async (req: AuthRequest, res) => send(res, await svc.walletOf(DOCTOR, doctorOf(req)))));
doctorWalletRouter.get('/wallet/entries', ...eligibleDoctor, validate(pageQuerySchema, 'query'),
  catchAsync(async (req: AuthRequest, res) => listed(res, await svc.entriesOf(DOCTOR, doctorOf(req), pageOf(req)))));
doctorWalletRouter.post('/wallet/topups', ...eligibleDoctor, validate(walletTopupSchema, 'body'),
  catchAsync(async (req: AuthRequest, res) => send(res, await svc.createTopup(DOCTOR, doctorOf(req), doctorOf(req), req.body))));
doctorWalletRouter.post('/wallet/topups/:paymentTransactionId/check', requireSpecialist,
  catchAsync(async (req: AuthRequest, res) => send(res, await svc.checkDoctorTopup(DOCTOR, doctorOf(req), req.params.paymentTransactionId))));

const adminId = (req: AuthRequest) => String(req.user?._id ?? '');
/** The admin wallet tools of one owner kind: mounted at `/api/v1/admin/labs` (LAB) and `/api/v1/admin/doctors` (DOCTOR). */
function adminWalletRouter(owner: PartnerOwner): Router {
  const r = Router();
  r.get('/:id/wallet', requireAdmin, catchAsync(async (req: AuthRequest, res) => send(res, await svc.adminWallet(owner, req.params.id))));
  r.get('/:id/wallet/entries', requireAdmin, validate(pageQuerySchema, 'query'),
    catchAsync(async (req: AuthRequest, res) => listed(res, await svc.adminEntries(owner, req.params.id, pageOf(req)))));
  r.get('/:id/wallet/lots', requireAdmin, catchAsync(async (req: AuthRequest, res) => send(res, await svc.adminLots(owner, req.params.id))));
  r.post('/:id/wallet/topup', requireAdmin, validate(adminLabTopupSchema, 'body'), catchAsync(async (req: AuthRequest, res) => {
    // As the pharmacy admin top-up (review of fb4063c7, 4; r8 B5): an Idempotency-Key is required, 8–100 letters, digits, _ or -.
    const key = req.header('Idempotency-Key')?.trim();
    if (!key) throw fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header is required for an admin top-up');
    if (!ADMIN_TOPUP_KEY.test(key)) throw fail(400, 'VALIDATION_ERROR', 'Idempotency-Key must be 8 to 100 letters, digits, _ or -');
    send(res, await svc.adminWalletTopup(owner, adminId(req), req.params.id, key, req.body));
  }));
  r.get('/:id/wallet/topups/by-key/:key', requireAdmin, validate(adminKeyParamSchema, 'params'),
    catchAsync(async (req: AuthRequest, res) => send(res, await svc.adminWalletTopupByKey(owner, req.params.id, req.params.key))));
  r.put('/:id/wallet/freeze', requireAdmin, validate(freezeSchema, 'body'),
    catchAsync(async (req: AuthRequest, res) => send(res, await svc.adminWalletFreeze(owner, adminId(req), req.params.id, req.body.frozen === true,
      String(req.body.reason).trim()))));
  return r;
}
export const adminLabWalletRouter = adminWalletRouter(LAB);
export const adminDoctorWalletRouter = adminWalletRouter(DOCTOR);
