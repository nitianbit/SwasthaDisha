import 'reflect-metadata';
import { Router, type RequestHandler, type Response } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin, type AuthRequest } from '@/modules/middleware/auth';
import * as svc from '@/modules/walletWithdrawals/service';
import * as v from '@/modules/walletWithdrawals/validation';

/**
 * Round 4d (§26.8.2) routes. The owner routes are mounted on each owner's wallet router (one definition for the three):
 * the pharmacy's `/api/v1/pharmacy-assisted/wallet/…` (operational pharmacy), the lab's
 * `/api/v1/partner-workspace/assisted/wallet/…` (wallet.view to read, wallet.manage to act) and the doctor's
 * `/api/v1/specialists/me/assisted/wallet/…` (eligible doctor). Admins: `/api/v1/admin/wallet-withdrawals`.
 */
const send = (res: Response, data: unknown, status = 200, extra: Record<string, unknown> = {}) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(status).json({ success: true, data, ...extra });
};

export interface OwnerGuards { read: RequestHandler[]; act: RequestHandler[]; request: RequestHandler[] }
export function mountWithdrawalRoutes(r: Router, g: OwnerGuards, ownerOf: (req: AuthRequest) => svc.WithdrawalOwner): void {
  r.get('/wallet/withdrawable', ...g.read, validate(v.withdrawableQuerySchema, 'query'),
    catchAsync(async (req: AuthRequest, res) => send(res, await svc.withdrawableOf(ownerOf(req), { amountMinor: Number(req.query.amountMinor) || undefined }))));
  r.post('/wallet/withdrawals', ...g.request, validate(v.withdrawalRequestSchema, 'body'), catchAsync(async (req: AuthRequest, res) => {
    const out = await svc.requestWithdrawal(ownerOf(req), req.body);
    send(res, out, out.replayed ? 200 : 201);
  }));
  r.get('/wallet/withdrawals', ...g.read, validate(v.withdrawalListQuerySchema, 'query'), catchAsync(async (req: AuthRequest, res) => {
    const out = await svc.listOwn(ownerOf(req), req.query as never);
    send(res, out.items, 200, { pagination: { nextCursor: out.nextCursor } });
  }));
  r.get('/wallet/withdrawals/by-key/:key', ...g.read, validate(v.withdrawalKeyParamSchema, 'params'),
    catchAsync(async (req: AuthRequest, res) => send(res, await svc.ownByKey(ownerOf(req), req.params.key))));
  r.post('/wallet/withdrawals/by-key/:key/abandon', ...g.act, validate(v.withdrawalKeyParamSchema, 'params'),
    catchAsync(async (req: AuthRequest, res) => send(res, await svc.abandonOwnKey(ownerOf(req), req.params.key))));
  r.get('/wallet/withdrawals/:id', ...g.read, validate(v.withdrawalIdParamSchema, 'params'),
    catchAsync(async (req: AuthRequest, res) => send(res, await svc.getOwn(ownerOf(req), req.params.id))));
  r.post('/wallet/withdrawals/:id/cancel', ...g.act, validate(v.withdrawalIdParamSchema, 'params'), validate(v.withdrawalCancelSchema, 'body'),
    catchAsync(async (req: AuthRequest, res) => send(res, await svc.cancelOwn(ownerOf(req), req.params.id, Number(req.body.expectedVersion)))));
}

/** `/api/v1/admin/wallet-withdrawals` — the queue (oldest first), a detail, reject, paid, void. */
export const adminWithdrawalRouter = Router();
adminWithdrawalRouter.use(requireAdmin);
const adminId = (req: AuthRequest) => String(req.user?._id ?? '');
adminWithdrawalRouter.get('/', validate(v.withdrawalListQuerySchema, 'query'), catchAsync(async (req: AuthRequest, res) => {
  const out = await svc.adminList(req.query as never);
  send(res, out.items, 200, { pagination: { nextCursor: out.nextCursor } });
}));
adminWithdrawalRouter.get('/:id', validate(v.withdrawalIdParamSchema, 'params'), catchAsync(async (req: AuthRequest, res) => send(res, await svc.adminGet(req.params.id))));
adminWithdrawalRouter.post('/:id/reject', validate(v.withdrawalIdParamSchema, 'params'), validate(v.withdrawalRejectSchema, 'body'),
  catchAsync(async (req: AuthRequest, res) => send(res, await svc.adminReject(adminId(req), req.params.id, req.body))));
adminWithdrawalRouter.post('/:id/paid', validate(v.withdrawalIdParamSchema, 'params'), validate(v.withdrawalPaidSchema, 'body'),
  catchAsync(async (req: AuthRequest, res) => send(res, await svc.adminPaid(adminId(req), req.params.id, req.body))));
adminWithdrawalRouter.post('/:id/void', validate(v.withdrawalIdParamSchema, 'params'), validate(v.withdrawalRejectSchema, 'body'),
  catchAsync(async (req: AuthRequest, res) => send(res, await svc.adminVoid(adminId(req), req.params.id, req.body))));
