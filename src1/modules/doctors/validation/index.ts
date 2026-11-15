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
});
export const leaveSchema = Joi.object({ date: ymd.required() });
export const leaveParamSchema = Joi.object({ date: ymd.required() });
