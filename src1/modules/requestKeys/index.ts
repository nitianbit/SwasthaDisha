import type { ClientSession } from 'mongoose';
import { Router, type Response } from 'express';
import { AppError } from '@/modules/common/types';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import type { AuthRequest } from '@/modules/middleware/auth';
import { assertOperationalPharmacy } from '@/modules/middleware/auth';
import { RequestKeyModel } from './model';
import { CustomerReturnModel } from '@/modules/pharmacyInventory/model/customerReturn';
import { SupplierReturnModel } from '@/modules/pharmacyInventory/model/supplierReturn';
import BookingModel from '@/modules/bookings/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { InstantRequestModel } from '@/modules/doctors/model/instant';
import { rebindStored } from '@/modules/file/access';

/**
 * D4 admission fence for once-only operations (customer return, supplier return, booking create). A client whose page
 * was reloaded before it learnt the outcome of a request can only make a NEW request after the old key is either found
 * (it was performed) or abandoned here (it can never be performed). No time-based guess is involved.
 */
export type OnceOnlyKind = 'customer_return' | 'supplier_return' | 'booking_create' | 'pharmacy_checkout' | 'lab_booking_create' | 'instant_request_create'
  /** Assisted booking phase 0: a pharmacy's medicine order from a booking's prescription (pharmacy-owned). */
  | 'pharmacy_rx_order'
  /** r36 (WQ50): a pharmacy's keyed in-store sale (pharmacy-owned). */
  | 'pharmacy_sale';

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
/** Q9: the record a used key produced, in the caller's scope (exact key). */
async function recordFor(kind: OnceOnlyKind, owner: string, key: string) {
  return kind === 'pharmacy_rx_order' ? rxOrderFor(owner, key)
    : kind === 'pharmacy_sale' ? saleFor(owner, key)
    : kind === 'customer_return' ? CustomerReturnModel.findOne({ pharmacyId: owner, requestKey: key }).lean()
    : kind === 'supplier_return' ? SupplierReturnModel.findOne({ pharmacyId: owner, requestKey: key }).lean()
    : kind === 'pharmacy_checkout'
      ? PharmacyOrderModel.findOne({ customerId: { $eq: owner }, checkoutRequestKey: { $eq: key } }).select({ _id: 1, status: 1, paymentStatus: 1 }).lean()
    : kind === 'instant_request_create'
      ? InstantRequestModel.findOne({ userId: { $eq: owner }, createRequestKey: { $eq: key } }).select({ _id: 1, status: 1, paymentStatus: 1 }).lean()
    : kind === 'lab_booking_create'
      ? PartnerLabBookingModel.findOne({ userId: { $eq: owner }, createRequestKey: { $eq: key } }).select({ _id: 1, status: 1, paymentStatus: 1 }).lean()
    : BookingModel.findOne({ userId: { $eq: owner }, createRequestKey: { $eq: key } }).select({ _id: 1, status: 1, paymentStatus: 1 }).lean();
}

const ALL_KINDS: OnceOnlyKind[] = ['customer_return', 'supplier_return', 'booking_create', 'pharmacy_checkout', 'lab_booking_create', 'instant_request_create',
  'pharmacy_rx_order', 'pharmacy_sale'];
const rxOrderFor = (pharmacyId: string, key: string) => (/^[0-9a-fA-F]{24}$/.test(pharmacyId)
  ? PharmacyOrderModel.findOne({ pharmacyId: { $eq: pharmacyId }, 'prescriptionFromBooking.requestKey': { $eq: key } })
    .select({ _id: 1, status: 1, paymentStatus: 1 }).lean()
  : Promise.resolve(null));
const saleFor = (pharmacyId: string, key: string) => (/^[0-9a-fA-F]{24}$/.test(pharmacyId)
  ? PharmacyOrderModel.findOne({ pharmacyId: { $eq: pharmacyId }, 'saleRequest.requestKey': { $eq: key } }).select({ _id: 1, status: 1, paymentStatus: 1 }).lean()
  : Promise.resolve(null));
const CUSTOMER_KINDS: OnceOnlyKind[] = ['booking_create', 'pharmacy_checkout', 'lab_booking_create', 'instant_request_create'];

async function ownerFor(req: AuthRequest, kind: OnceOnlyKind): Promise<string> {
  const user = req.user;
  if (CUSTOMER_KINDS.includes(kind)) {
    if (user?.userType !== 'user') throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    return String(user._id);
  }
  if (user?.userType !== 'pharmacy') throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
  await assertOperationalPharmacy(req);
  return String(req.user!.pharmacyId ?? user._id);
}

/**
 * Q9: GET /api/v1/request-keys/lookup?kind&key — read-only: 'used' (with the record), 'abandoned', or 'unknown' (not
 * performed and not abandoned: the request may still be in flight, so the client may only resend the same request or
 * abandon the key). Never changes anything.
 */
requestKeyRouter.get('/lookup', catchAsync(async (req: AuthRequest, res: Response) => {
  const kind = req.query.kind as OnceOnlyKind;
  const key = typeof req.query.key === 'string' ? req.query.key.trim() : '';
  if (!KEY.test(key) || !ALL_KINDS.includes(kind)) throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'kind and key are required' });
  const owner = await ownerFor(req, kind);
  const row = await RequestKeyModel.findOne({ scope: scopeOf(kind, owner), key }).lean();
  if (row?.state === 'abandoned') { res.status(200).json({ success: true, data: { state: 'abandoned' } }); return; }
  const record = row?.state === 'used' ? await recordFor(kind, owner, key) : null;
  res.status(200).json({ success: true, data: record ? { state: 'used', record } : { state: 'unknown' } });
}));

requestKeyRouter.post('/abandon', catchAsync(async (req: AuthRequest, res: Response) => {
  const kind = req.body?.kind as OnceOnlyKind;
  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  if (!KEY.test(key) || !ALL_KINDS.includes(kind)) {
    throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'kind and key are required' });
  }
  const user = req.user;
  let owner: string;
  if (kind === 'booking_create' || kind === 'pharmacy_checkout' || kind === 'lab_booking_create' || kind === 'instant_request_create') {
    if (user?.userType !== 'user') throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    owner = String(user._id);
  } else {
    if (user?.userType !== 'pharmacy') throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    await assertOperationalPharmacy(req);
    owner = String(req.user!.pharmacyId ?? user._id);
  }
  const state = await abandonRequestKey(scopeOf(kind, owner), key);
  if (state === 'abandoned') { res.status(200).json({ success: true, data: { state } }); return; }
  // Used: the record was written in the same transaction as the claim, so it exists; return it (exact key, caller's
  // scope) so the client can always resolve the request, however far back it is in any list.
  const record = await recordFor(kind, owner, key); // r36b: the lookup's one reader (it was a copy)
  // P9: the customer's prescription files of a checkout whose first request died before binding are bound now.
  if (kind === 'pharmacy_checkout' && record?._id) await rebindStored(user, 'PharmacyOrder', record._id);
  res.status(200).json({ success: true, data: { state, record } });
}));
