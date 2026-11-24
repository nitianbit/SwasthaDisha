import Joi from 'joi';

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);
const bookerKind = Joi.string().valid('pharmacy', 'lab', 'doctor');
const category = Joi.string().valid('consultation', 'lab_test', 'lab_package');
const calendarDay = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);

export const rulesQuerySchema = Joi.object({ bookerKind: bookerKind.required(), bookerId: objectId.required() });
export const ruleParamSchema = Joi.object({ bookerKind: bookerKind.required(), bookerId: objectId.required(), category: category.required() });
export const ruleBodySchema = Joi.object({
  basis: Joi.string().valid('percent', 'fixed').required(),
  percentBasisPoints: Joi.number().integer().min(1).max(5000),
  fixedMinor: Joi.number().integer().min(1),
  capMinor: Joi.number().integer().min(1),
  isActive: Joi.boolean().required(),
  expectedVersion: Joi.number().integer().min(0).required(),
  reason: Joi.string().trim().min(1).max(500).required(),
});
export const statementQuerySchema = Joi.object({ before: Joi.string().max(60), limit: Joi.number().integer().min(1).max(200), from: calendarDay, to: calendarDay });
