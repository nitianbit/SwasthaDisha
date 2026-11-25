import 'reflect-metadata';
import { Router, type NextFunction, type Response } from 'express';
import Joi from 'joi';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { AppError } from '@/modules/common/types';
import { requireAdmin, type AuthRequest } from '@/modules/middleware/auth';
import {
  adminGrants, adminReads, decideRecordsRequest, holderGrants, holderRequests, requestRecordsAccess, revokeRecordsGrant,
} from '@/modules/recordAccess';

/**
 * r30 (round 3f, §25.9.4) routes. Answers are `{ success, data }` with `Cache-Control: private, no-store`.
 * - Doctor: `POST /api/v1/specialists/me/bookings/:id/records-access/request` (mounted in the specialist router).
 * - Account holder (customer app): `/api/v1/records-access/*`.
 * - Admin: `/api/v1/admin/records-access/*`.
 */
const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);
const idParam = Joi.object({ id: objectId.required() });
const send = (res: Response, data: unknown, status = 200) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(status).json({ success: true, data });
};

/** The doctor's request (guards in the specialist router: a verified, active doctor). 201 when created, 200 otherwise. */
export const doctorRecordsRequest = async (req: AuthRequest, res: Response) => {
  const out = await requestRecordsAccess(String(req.user?.specialistId || req.user?._id || ''), req.params.id);
  send(res, out.data, out.created ? 201 : 200);
};

export const holderRecordsRouter = Router();
holderRecordsRouter.use((req: AuthRequest, _res: Response, next: NextFunction) => {
  if (req.user?.userType !== 'user') throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Only the account holder can do this' });
  next();
});
const holder = (req: AuthRequest) => String(req.user!._id);
holderRecordsRouter.get('/requests', validate(Joi.object({ state: Joi.string().valid('pending', 'approved', 'denied', 'expired', 'replaced') }), 'query'),
  catchAsync(async (req: AuthRequest, res) => send(res, await holderRequests(holder(req), req.query.state as string | undefined))));
holderRecordsRouter.post('/requests/:id/approve', validate(idParam, 'params'),
  catchAsync(async (req: AuthRequest, res) => send(res, await decideRecordsRequest(holder(req), req.params.id, 'approve'))));
holderRecordsRouter.post('/requests/:id/deny', validate(idParam, 'params'),
  catchAsync(async (req: AuthRequest, res) => send(res, await decideRecordsRequest(holder(req), req.params.id, 'deny'))));
holderRecordsRouter.get('/grants', catchAsync(async (req: AuthRequest, res) => send(res, await holderGrants(holder(req)))));
holderRecordsRouter.post('/grants/:id/revoke', validate(idParam, 'params'),
  catchAsync(async (req: AuthRequest, res) => send(res, await revokeRecordsGrant({ kind: 'holder', id: holder(req) }, req.params.id))));

export const adminRecordsRouter = Router();
adminRecordsRouter.use(requireAdmin);
adminRecordsRouter.get('/grants', validate(Joi.object({ holderUserId: objectId, specialistId: objectId, limit: Joi.number().integer().min(1).max(200) }), 'query'),
  catchAsync(async (req: AuthRequest, res) => send(res, await adminGrants(req.query as never))));
adminRecordsRouter.post('/grants/:id/revoke', validate(idParam, 'params'), validate(Joi.object({ reason: Joi.string().trim().min(3).max(500).required() }), 'body'),
  catchAsync(async (req: AuthRequest, res) => send(res, await revokeRecordsGrant({ kind: 'admin', id: String(req.user!._id) }, req.params.id, req.body.reason))));
adminRecordsRouter.get('/reads', validate(Joi.object({ holderUserId: objectId, doctorId: objectId, from: Joi.date().iso(), to: Joi.date().iso(),
  limit: Joi.number().integer().min(1).max(500) }), 'query'),
  catchAsync(async (req: AuthRequest, res) => send(res, await adminReads(req.query as never))));
