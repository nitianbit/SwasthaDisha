import Joi from 'joi';

export const createHealthCheckSchema = Joi.object({
  systolicBP: Joi.number().min(0).max(300).optional(),
  diastolicBP: Joi.number().min(0).max(200).optional(),
  fastingSugar: Joi.number().min(0).optional(),
  postMealSugar: Joi.number().min(0).optional(),
  hba1c: Joi.number().min(0).max(20).optional(),
  notes: Joi.string().trim().max(1000).optional(),
}).or('systolicBP', 'diastolicBP', 'fastingSugar', 'postMealSugar', 'hba1c');

export const updateHealthCheckSchema = Joi.object({
  systolicBP: Joi.number().min(0).max(300).optional(),
  diastolicBP: Joi.number().min(0).max(200).optional(),
  fastingSugar: Joi.number().min(0).optional(),
  postMealSugar: Joi.number().min(0).optional(),
  hba1c: Joi.number().min(0).max(20).optional(),
  notes: Joi.string().trim().max(1000).optional(),
}).min(1);

export const orderIdParamSchema = Joi.object({
  orderId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required().messages({
    'string.pattern.base': 'Invalid orderId format',
  }),
});
