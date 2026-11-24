import Joi from 'joi';

/** Phase 3d (§25.7.4): the code as printed (`ABCD-EFGH`; checked by the service) and the patient's mobile number. */
export const recommendationParamSchema = Joi.object({ code: Joi.string().trim().min(1).max(20).required() });
export const recommendationQuerySchema = Joi.object({ phone: Joi.string().trim().max(20).required() });
