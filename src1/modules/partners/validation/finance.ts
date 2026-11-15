import Joi from 'joi';

const isoDate = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'Dates are YYYY-MM-DD' });
const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/).messages({ 'string.pattern.base': 'Invalid id' });
const requestKey = Joi.string().pattern(/^[A-Za-z0-9_-]{8,100}$/).required()
  .messages({ 'string.pattern.base': 'requestKey must be 8 to 100 letters, digits, - or _' });

export const statementQuerySchema = Joi.object({
  before: Joi.string().max(64).optional(),
  limit: Joi.number().integer().min(1).max(200).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const csvQuerySchema = Joi.object({ from: isoDate.optional(), to: isoDate.optional() });

export const payoutDetailsSchema = Joi.object({
  method: Joi.string().valid('bank', 'upi').required(),
  accountName: Joi.string().trim().max(120).when('method', { is: 'bank', then: Joi.required(), otherwise: Joi.optional() }),
  accountNumber: Joi.string().trim().max(30).when('method', { is: 'bank', then: Joi.required(), otherwise: Joi.forbidden() }),
  ifsc: Joi.string().trim().max(11).when('method', { is: 'bank', then: Joi.required(), otherwise: Joi.forbidden() }),
  bankName: Joi.string().trim().max(120).when('method', { is: 'bank', then: Joi.optional(), otherwise: Joi.forbidden() }),
  upiId: Joi.string().trim().max(320).when('method', { is: 'upi', then: Joi.required(), otherwise: Joi.forbidden() }),
});

export const accountIdParamSchema = Joi.object({ accountId: objectId.required() });
export const payoutIdParamSchema = Joi.object({ payoutId: objectId.required() });

export const verifyDetailsSchema = Joi.object({ version: Joi.number().integer().min(1).required() });

export const recordPayoutSchema = Joi.object({
  amountMinor: Joi.number().integer().min(1).required(),
  method: Joi.string().valid('bank_transfer', 'upi', 'other').required(),
  reference: Joi.string().trim().min(4).max(64).required(),
  paidOn: isoDate.required(),
  note: Joi.string().trim().max(500).allow('').optional(),
  detailsVersion: Joi.number().integer().min(1).required(),
  requestKey,
});

export const voidPayoutSchema = Joi.object({ reason: Joi.string().trim().min(3).max(500).required() });

export const adjustmentSchema = Joi.object({
  amountMinor: Joi.number().integer().invalid(0).required(),
  reason: Joi.string().trim().min(3).max(500).required(),
  requestKey,
});

export const accountsQuerySchema = Joi.object({
  ownerKind: Joi.string().valid('partner', 'doctor').optional(),
  due: Joi.string().valid('true', 'false').optional(),
  search: Joi.string().trim().max(100).allow('').optional(),
  detailsState: Joi.string().valid('none', 'unverified', 'verified').optional(),
  limit: Joi.number().integer().min(1).max(200).optional(),
  skip: Joi.number().integer().min(0).optional(),
});

export const payoutsQuerySchema = Joi.object({
  accountId: objectId.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  state: Joi.string().valid('recorded', 'voided').optional(),
  limit: Joi.number().integer().min(1).max(500).optional(),
});
