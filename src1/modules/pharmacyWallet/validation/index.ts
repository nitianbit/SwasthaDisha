import Joi from 'joi';

export const topupSchema = Joi.object({
  pharmacyId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  amount: Joi.number().min(1).required().messages({
    'any.required': 'amount is required',
    'number.min': 'amount must be at least 1',
  }),
  notes: Joi.string().trim().max(500).optional(),
});

/** r8 B5: the admin top-up Idempotency-Key (header and by-key `:key`): 8 to 100 letters, digits, `_` or `-`. */
export const ADMIN_TOPUP_KEY = /^[A-Za-z0-9_-]{8,100}$/;
