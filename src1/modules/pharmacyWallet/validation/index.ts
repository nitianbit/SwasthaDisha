import Joi from 'joi';

export const topupSchema = Joi.object({
  pharmacyId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  amount: Joi.number().min(1).required().messages({
    'any.required': 'amount is required',
    'number.min': 'amount must be at least 1',
  }),
  notes: Joi.string().trim().max(500).optional(),
});
