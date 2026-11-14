import type { ClientSession } from 'mongoose';
import { Router, type Response } from 'express';
import { AppError } from '@/modules/common/types';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import type { AuthRequest } from '@/modules/middleware/auth';
import { assertOperationalPharmacy } from '@/modules/middleware/auth';
import { RequestKeyModel } from './model';

/**
 * D4 admission fence for once-only operations (customer return, supplier return, booking create). A client whose page
 * was reloaded before it learnt the outcome of a request can only make a NEW request after the old key is either found
 * (it was performed) or abandoned here (it can never be performed). No time-based guess is involved.
 */
export type OnceOnlyKind = 'customer_return' | 'supplier_return' | 'booking_create';

/**
 * Inside the operation's transaction: refuses a key that was abandoned, and claims it as used. The claim is written in
 * the same transaction as the operation, so a concurrent abandon conflicts and only one of the two can commit.
 */
export async function claimRequestKey(scope: string, key: string, session: ClientSession): Promise<void> {
  const existing = await RequestKeyModel.findOne({ scope, key }).session(session).lean();
  if (existing?.state === 'abandoned') {
    throw new AppError({ status: 409, code: 'REQUEST_ABANDONED', message: 'This request was cancelled before it was recorded; make a new one' });
  }
  if (existing) return;
  await RequestKeyModel.create([{ scope, key, state: 'used', at: new Date() }], { session });
}

/** Abandons a key unless it was already used. Returns the key's final state. */
export async function abandonRequestKey(scope: string, key: string): Promise<'abandoned' | 'used'> {
  try {
    const r = await RequestKeyModel.updateOne({ scope, key }, { $setOnInsert: { scope, key, state: 'abandoned', at: new Date() } }, { upsert: true });
    if (r.upsertedCount === 1) return 'abandoned';
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
  }
  const row = await RequestKeyModel.findOne({ scope, key }).lean();
  return row?.state === 'used' ? 'used' : 'abandoned';
}

export const scopeOf = (kind: OnceOnlyKind, ownerId: string) => `${kind}:${ownerId.toLowerCase()}`;

const KEY = /^[A-Za-z0-9_-]{8,64}$/;

/** POST /api/v1/request-keys/abandon {kind, key}: scoped to the caller (pharmacy for returns, customer for bookings). */
export const requestKeyRouter = Router();
requestKeyRouter.post('/abandon', catchAsync(async (req: AuthRequest, res: Response) => {
  const kind = req.body?.kind as OnceOnlyKind;
  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  if (!KEY.test(key) || !['customer_return', 'supplier_return', 'booking_create'].includes(kind)) {
    throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'kind and key are required' });
  }
  const user = req.user;
  let owner: string;
  if (kind === 'booking_create') {
    if (user?.userType !== 'user') throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    owner = String(user._id);
  } else {
    if (user?.userType !== 'pharmacy') throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    await assertOperationalPharmacy(req);
    owner = String(req.user!.pharmacyId ?? user._id);
  }
  const state = await abandonRequestKey(scopeOf(kind, owner), key);
  res.status(200).json({ success: true, data: { state } });
}));
