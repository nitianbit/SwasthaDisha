import Joi from 'joi';

// Common schemas
const userIdSchema = Joi.string().trim().min(1).required().messages({
  'string.empty': 'User ID is required',
  'any.required': 'User ID is required',
});

const initialBalanceSchema = Joi.number().min(0).optional().messages({
  'number.base': 'Initial balance must be a number',
  'number.min': 'Initial balance must be at least 0',
});

const isActiveSchema = Joi.boolean().optional();

const transactionTypeSchema = Joi.string()
  .valid('credit', 'debit', 'refund', 'cashback', 'promotion')
  .required()
  .messages({
    'any.only': 'Transaction type must be one of: credit, debit, refund, cashback, promotion',
    'any.required': 'Transaction type is required',
  });

const amountSchema = Joi.number().min(0.01).required().messages({
  'number.base': 'Amount must be a number',
  'number.min': 'Amount must be at least 0.01',
  'any.required': 'Amount is required',
});

const referenceTypeSchema = Joi.string().trim().optional(); // e.g., 'booking', 'refund', 'cashback', 'promotion'

const referenceIdSchema = Joi.string().trim().optional();

const descriptionSchema = Joi.string().trim().optional();

const notesSchema = Joi.string().trim().optional();

const transactionDateSchema = Joi.string()
  .pattern(/^\d{8}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Transaction date must be in YYYYMMDD format (e.g., 20250215)',
  });

// Create Wallet schema
export const createWalletSchema = Joi.object({
  userId: userIdSchema,
  initialBalance: initialBalanceSchema,
  isActive: isActiveSchema,
});

// Update Wallet schema
export const updateWalletSchema = Joi.object({
  isActive: isActiveSchema,
}).min(1).messages({
  'object.min': 'At least one field must be provided for update',
});

// Create Wallet Transaction schema
export const createWalletTransactionSchema = Joi.object({
  userId: userIdSchema,
  transactionType: transactionTypeSchema,
  amount: amountSchema,
  referenceType: referenceTypeSchema,
  referenceId: referenceIdSchema,
  description: descriptionSchema,
  notes: notesSchema,
  transactionDate: transactionDateSchema,
});

export const initiateWalletRechargeSchema = Joi.object({
  userId: Joi.string().trim().min(1).optional().messages({
    'string.empty': 'User ID cannot be empty',
  }),
  amount: amountSchema,
  couponCode: Joi.string().trim().uppercase().optional(),
});


// Wallet Query params schema
export const walletQuerySchema = Joi.object({
  userId: Joi.string().trim().optional(),
  isActive: Joi.string().valid('true', 'false').optional(),
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
    .valid('balance', 'createdAt', 'updatedAt')
    .optional()
    .messages({
      'any.only': 'sortBy must be one of: balance, createdAt, updatedAt',
    }),
  sortOrder: Joi.string().valid('asc', 'desc').optional().messages({
    'any.only': 'sortOrder must be either "asc" or "desc"',
  }),
});

// Wallet Transaction Query params schema
export const walletTransactionQuerySchema = Joi.object({
  userId: Joi.string().trim().optional(),
  transactionType: Joi.string()
    .valid('credit', 'debit', 'refund', 'cashback', 'promotion')
    .optional()
    .messages({
      'any.only': 'Transaction type must be one of: credit, debit, refund, cashback, promotion',
    }),
  status: Joi.string()
    .valid('pending', 'completed', 'failed', 'cancelled')
    .optional()
    .messages({
      'any.only': 'Status must be one of: pending, completed, failed, cancelled',
    }),
  referenceType: Joi.string().trim().optional(),
  referenceId: Joi.string().trim().optional(),
  transactionDateFrom: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Transaction date from must be in YYYYMMDD format (e.g., 20250215)',
    }),
  transactionDateTo: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Transaction date to must be in YYYYMMDD format (e.g., 20250215)',
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
}).custom((value, helpers) => {
  // Validate that transactionDateFrom <= transactionDateTo if both are provided
  if (
    value.transactionDateFrom &&
    value.transactionDateTo &&
    value.transactionDateFrom.localeCompare(value.transactionDateTo) > 0
  ) {
    return helpers.error('any.custom', {
      message: 'Transaction date from cannot be greater than transaction date to',
    });
  }
  return value;
});

// Params schema for ID
export const idParamSchema = Joi.object({
  id: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid ID format',
      'any.required': 'ID is required',
    }),
});

// Params schema for userId
export const userIdParamSchema = Joi.object({
  userId: userIdSchema,
});
