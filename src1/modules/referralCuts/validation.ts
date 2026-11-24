import Joi from 'joi';
import { objectId } from '@/modules/partners/validation/finance';
import { REFERRAL_CATEGORIES } from '@/modules/assisted/types';

/** Phase 4a (§26.5.4): referral rule routes. The statement query is the finance one (`partners/validation/finance.ts`). */
const bookerKind = Joi.string().valid('pharmacy', 'lab', 'doctor');
const category = Joi.string().valid(...REFERRAL_CATEGORIES);

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
