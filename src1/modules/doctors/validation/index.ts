import Joi from 'joi';
import { isRealDate } from '@/modules/partners/services/slots';

const ymd = Joi.string().pattern(/^\d{8}$/).custom((v, h) => (isRealDate(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`) ? v : h.error('any.invalid')), 'real calendar date');

const hhmm = Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/);
const window = Joi.object({
  start: hhmm.required(),
  end: hhmm.required(),
  modes: Joi.array().items(Joi.string().valid('chat', 'call', 'video', 'in-person')).min(1).unique().required(),
  branchId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/),
});
const day = Joi.array().items(window).max(12);

export const scheduleTemplateSchema = Joi.object({
  slotMinutes: Joi.number().integer().min(5).max(240).required(),
  days: Joi.object({ mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day }).required(),
  /** Q13: the saved template's updatedAt the editor started from (null = there was none). */
  expectedUpdatedAt: Joi.date().iso().allow(null).optional(),
});
export const leaveSchema = Joi.object({ date: ymd.required() });
export const leaveParamSchema = Joi.object({ date: ymd.required() });

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);
const instantMode = Joi.string().valid('video', 'call', 'chat');
const target = Joi.object({
  kind: Joi.string().valid('specific', 'any').required(),
  doctorId: objectId.when('kind', { is: 'specific', then: Joi.required(), otherwise: Joi.forbidden() }),
});

export const presenceSchema = Joi.object({
  available: Joi.boolean().required(),
  modes: Joi.array().items(instantMode).unique().max(3),
  instantFeeMinor: Joi.number().integer().min(0).max(100_000_000),
  /** Q13: the presence version these terms were decided on (0 = never set); a change made meanwhile is refused. */
  expectedPresenceVersion: Joi.number().integer().min(0).max(1_000_000_000),
});
export const requestIdParamSchema = Joi.object({ requestId: objectId.required() });
export const bookingIdParamSchema = Joi.object({ bookingId: objectId.required() });
export const extendSchema = Joi.object({
  minutes: Joi.number().integer().min(1).max(60).required(),
  /** Q13: the same key with the same minutes extends once. */
  requestKey: Joi.string().pattern(/^[A-Za-z0-9_-]{8,100}$/).optional(),
});
export const onlineDoctorsQuerySchema = Joi.object({ specialization: Joi.string().trim().min(2).max(80).required(), mode: instantMode.required() });
export const quoteQuerySchema = onlineDoctorsQuerySchema.append({ doctorId: objectId });
export const createInstantSchema = Joi.object({
  target: target.required(),
  specialization: Joi.string().trim().min(2).max(80).required(),
  mode: instantMode.required(),
  patient: Joi.object({
    kind: Joi.string().valid('self', 'dependent').required(),
    dependentId: objectId.when('kind', { is: 'dependent', then: Joi.required(), otherwise: Joi.forbidden() }),
  }).required(),
  couponCode: Joi.string().trim().max(40),
  useWalletBalance: Joi.boolean(),
  requestKey: Joi.string().pattern(/^[A-Za-z0-9_-]{8,64}$/).required(),
  /** Q9: price fence (paise). */
  acceptedQuoteMinor: Joi.number().integer().min(0).required(),
  acceptedPayableMinor: Joi.number().integer().min(0).required(),
});
export const payInstantSchema = Joi.object({ useWalletBalance: Joi.boolean() });
export const reofferSchema = Joi.object({ target: target.required() });
export const adminCancelInstantSchema = Joi.object({ reason: Joi.string().trim().min(3).max(500).required() });

/** Q9 */
export const specialitiesQuerySchema = Joi.object({ mode: Joi.string().valid('video', 'call', 'chat').optional() });
export const pageQuerySchema = Joi.object({ page: Joi.number().integer().min(1).optional(), limit: Joi.number().integer().min(1).max(100).optional() });
