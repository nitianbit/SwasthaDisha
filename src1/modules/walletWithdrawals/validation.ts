import Joi from 'joi';
import { ASSISTED_KEY } from '@/modules/assisted/consultations';

/** Round 4d (§26.8.2): withdrawal requests and admin steps. Amounts are integer paise; the minimum is checked by the service (400). */
const key = Joi.string().pattern(ASSISTED_KEY);
const version = Joi.number().integer().min(0);
export const withdrawableQuerySchema = Joi.object({ amountMinor: Joi.number().integer().min(1).max(100_000_000) });
export const withdrawalRequestSchema = Joi.object({
  amountMinor: Joi.number().integer().min(1).max(100_000_000).required(),
  requestKey: key.required(),
  detailsVersion: version.required(),
});
export const withdrawalListQuerySchema = Joi.object({
  state: Joi.string().valid('requested', 'cancelled', 'rejected', 'paid', 'voided'),
  cursor: Joi.string().pattern(/^\d{1,15}_[0-9a-fA-F]{24}$/),
  limit: Joi.number().integer().min(1).max(50),
});
export const withdrawalIdParamSchema = Joi.object({ id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required() });
export const withdrawalKeyParamSchema = Joi.object({ key: key.required() });
export const withdrawalCancelSchema = Joi.object({ expectedVersion: version.required() });
export const withdrawalRejectSchema = Joi.object({ reason: Joi.string().trim().min(3).max(500).required(), expectedVersion: version.required() });
export const withdrawalPaidSchema = Joi.object({
  method: Joi.string().valid('bank_transfer', 'upi').required(),
  reference: Joi.string().trim().min(4).max(64).required(),
  paidOn: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  note: Joi.string().trim().max(500).allow(''),
  detailsVersion: version.required(),
  expectedVersion: version.required(),
  requestKey: key.required(),
});
/** §26.8.4: the admin's Recover of a disputed top-up. */
export const recoverSchema = Joi.object({ reason: Joi.string().trim().min(3).max(500).required(), requestKey: key.required() });
