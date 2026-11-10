import Joi from 'joi';

export const applyReferralSchema = Joi.object({
  referralCode: Joi.string()
    .trim()
    .min(4)
    .max(32)
    .required()
    .messages({
      'string.empty': 'Referral code is required',
      'string.min': 'Referral code must be at least 4 characters',
      'string.max': 'Referral code must not exceed 32 characters',
      'any.required': 'Referral code is required',
    }),
});

export const referralTransactionQuerySchema = Joi.object({
  transactionDateFrom: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base':
        'Transaction date from must be in YYYYMMDD format (e.g., 20250215)',
    }),
  transactionDateTo: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base':
        'Transaction date to must be in YYYYMMDD format (e.g., 20250215)',
    }),
  page: Joi.number().integer().min(1).optional().messages({
    'number.base': 'Page must be a number',
    'number.integer': 'Page must be an integer',
    'number.min': 'Page must be at least 1',
  }),
  limit: Joi.number().integer().min(1).max(100).optional().messages({
    'number.base': 'Limit must be a number',
    'number.integer': 'Limit must be an integer',
    'number.min': 'Limit must be at least 1',
    'number.max': 'Limit must not exceed 100',
  }),
  sortBy: Joi.string()
    .valid('amount', 'transactionDate', 'createdAt', 'updatedAt')
    .optional()
    .messages({
      'any.only':
        'sortBy must be one of: amount, transactionDate, createdAt, updatedAt',
    }),
  sortOrder: Joi.string().valid('asc', 'desc').optional().messages({
    'any.only': 'sortOrder must be either "asc" or "desc"',
  }),
});
