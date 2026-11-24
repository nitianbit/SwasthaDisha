import Joi from 'joi';

/**
 * Phase 3d (§25.7.4), r16b: the lookup body — the code as printed (`ABCD-EFGH`; checked by the service) and the
 * patient's mobile number. In the body (as `/patients/lookup`), so neither reaches an access log's request line.
 */
export const recommendationLookupSchema = Joi.object({
  code: Joi.string().trim().min(1).max(20).required(),
  phone: Joi.string().trim().max(20).required(),
});
