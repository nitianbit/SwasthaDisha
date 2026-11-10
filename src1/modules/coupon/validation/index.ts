import Joi from 'joi';

// Common schemas
const codeSchema = Joi.string()
  .trim()
  .min(3)
  .max(50)
  .pattern(/^[A-Z0-9]+$/)
  .required()
  .messages({
    'string.empty': 'Coupon code is required',
    'string.min': 'Coupon code must be at least 3 characters',
    'string.max': 'Coupon code must not exceed 50 characters',
    'string.pattern.base': 'Coupon code must contain only uppercase letters and numbers',
    'any.required': 'Coupon code is required',
  });

const titleSchema = Joi.string().trim().max(200).optional().messages({
  'string.max': 'Title must not exceed 200 characters',
});

const descriptionSchema = Joi.string().trim().optional();

const discountTypeSchema = Joi.string()
  .valid('percentage', 'fixed')
  .required()
  .messages({
    'any.only': 'Discount type must be either "percentage" or "fixed"',
    'any.required': 'Discount type is required',
  });

const discountValueSchema = Joi.number().min(0.01).required().messages({
  'number.base': 'Discount value must be a number',
  'number.min': 'Discount value must be at least 0.01',
  'any.required': 'Discount value is required',
});

const minimumPurchaseAmountSchema = Joi.number().min(0).optional().messages({
  'number.base': 'Minimum purchase amount must be a number',
  'number.min': 'Minimum purchase amount must be at least 0',
});

const maximumDiscountAmountSchema = Joi.number().min(0).optional().messages({
  'number.base': 'Maximum discount amount must be a number',
  'number.min': 'Maximum discount amount must be at least 0',
});

const eligibleForSchema = Joi.string()
  .valid('all', 'specialist', 'package', 'external_specialist', 'external_diagnostics')
  .optional()
  .messages({
    'any.only':
      'Eligible for must be one of: all, specialist, package, external_specialist, external_diagnostics',
  });

const forUserSchema = Joi.string().valid('self', 'all').optional().messages({
  'any.only': 'forUser must be one of: self, all',
});

const applicableToSchema = Joi.string()
  .valid('all', 'wellnessPackage', 'consultation', 'specific')
  .required()
  .messages({
    'any.only':
      'Applicable to must be one of: all, wellnessPackage, consultation, specific',
    'any.required': 'Applicable to is required',
  });

const applicableIdsSchema = Joi.array()
  .items(Joi.string().trim().min(1))
  .optional()
  .messages({
    'array.base': 'Applicable IDs must be an array',
  });

const applicablePackageIdsSchema = Joi.array()
  .items(Joi.string().trim().min(1))
  .optional()
  .messages({
    'array.base': 'Applicable package IDs must be an array',
  });

const applicableTestIdsSchema = Joi.array()
  .items(Joi.string().trim().min(1))
  .optional()
  .messages({
    'array.base': 'Applicable test IDs must be an array',
  });

const isBothRequiredSchema = Joi.boolean().optional();

const dateSchema = Joi.string()
  .pattern(/^\d{8}$/)
  .required()
  .messages({
    'string.pattern.base': 'Date must be in YYYYMMDD format (e.g., 20250215)',
    'any.required': 'Date is required',
  });

const usageLimitPerUserSchema = Joi.number().integer().min(1).optional().messages({
  'number.base': 'Usage limit per user must be a number',
  'number.integer': 'Usage limit per user must be an integer',
  'number.min': 'Usage limit per user must be at least 1',
});

const totalUsageLimitSchema = Joi.number().integer().min(1).optional().messages({
  'number.base': 'Total usage limit must be a number',
  'number.integer': 'Total usage limit must be an integer',
  'number.min': 'Total usage limit must be at least 1',
});

const isActiveSchema = Joi.boolean().optional();

const corporateIdsSchema = Joi.array()
  .items(
    Joi.string()
      .pattern(/^[0-9a-fA-F]{24}$/)
      .messages({
        'string.pattern.base': 'Each corporate ID must be a valid MongoDB ObjectId',
      })
  )
  .optional()
  .messages({
    'array.base': 'corporateIds must be an array',
  });

const userIdsSchema = Joi.array()
  .items(
    Joi.string()
      .pattern(/^[0-9a-fA-F]{24}$/)
      .messages({
        'string.pattern.base': 'Each user ID must be a valid MongoDB ObjectId',
      })
  )
  .optional()
  .messages({
    'array.base': 'userIds must be an array',
  });

// Create Coupon schema
export const createCouponSchema = Joi.object({
  code: codeSchema,
  title: titleSchema,
  description: descriptionSchema,
  corporateIds: corporateIdsSchema,
  userIds: userIdsSchema,
  discountType: discountTypeSchema,
  discountValue: discountValueSchema,
  minimumPurchaseAmount: minimumPurchaseAmountSchema,
  maximumDiscountAmount: maximumDiscountAmountSchema,
  eligibleFor: eligibleForSchema,
  forUser: forUserSchema,
  applicableTo: applicableToSchema,
  applicableIds: applicableIdsSchema,
  applicablePackageIds: applicablePackageIdsSchema,
  applicableTestIds: applicableTestIdsSchema,
  isBothRequired: isBothRequiredSchema,
  startDate: dateSchema,
  endDate: dateSchema,
  usageLimitPerUser: usageLimitPerUserSchema,
  totalUsageLimit: totalUsageLimitSchema,
  isActive: isActiveSchema,
})
  .custom((value, helpers) => {
    // Validate that endDate >= startDate
    if (value.startDate && value.endDate) {
      if (value.startDate.localeCompare(value.endDate) > 0) {
        return helpers.error('any.custom', {
          message: 'End date cannot be earlier than start date',
        });
      }
    }

    // Validate maximumDiscountAmount for percentage discounts
    if (value.discountType === 'percentage' && value.discountValue > 100) {
      return helpers.error('any.custom', {
        message: 'Percentage discount cannot exceed 100%',
      });
    }

    // Validate applicableIds is required when applicableTo is 'specific'
    if (
      value.applicableTo === 'specific' &&
      (!value.applicableIds || value.applicableIds.length === 0) &&
      (!value.applicablePackageIds || value.applicablePackageIds.length === 0) &&
      (!value.applicableTestIds || value.applicableTestIds.length === 0)
    ) {
      return helpers.error('any.custom', {
        message:
          'Applicable IDs, applicable package IDs, or applicable test IDs are required when applicableTo is "specific"',
      });
    }

    return value;
  })
  .messages({
    'any.custom': 'Validation error',
  });

// Update Coupon schema
export const updateCouponSchema = Joi.object({
  title: titleSchema,
  description: descriptionSchema,
  corporateIds: corporateIdsSchema,
  userIds: userIdsSchema,
  discountType: discountTypeSchema.optional(),
  discountValue: discountValueSchema.optional(),
  minimumPurchaseAmount: minimumPurchaseAmountSchema,
  maximumDiscountAmount: maximumDiscountAmountSchema,
  eligibleFor: eligibleForSchema,
  forUser: forUserSchema,
  applicableTo: applicableToSchema.optional(),
  applicableIds: applicableIdsSchema,
  applicablePackageIds: applicablePackageIdsSchema,
  applicableTestIds: applicableTestIdsSchema,
  isBothRequired: isBothRequiredSchema,
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  usageLimitPerUser: usageLimitPerUserSchema,
  totalUsageLimit: totalUsageLimitSchema,
  isActive: isActiveSchema,
})
  .min(1)
  .custom((value, helpers) => {
    // Validate that endDate >= startDate if both are provided
    if (value.startDate && value.endDate) {
      if (value.startDate.localeCompare(value.endDate) > 0) {
        return helpers.error('any.custom', {
          message: 'End date cannot be earlier than start date',
        });
      }
    }

    // Validate maximumDiscountAmount for percentage discounts
    if (value.discountType === 'percentage' && value.discountValue && value.discountValue > 100) {
      return helpers.error('any.custom', {
        message: 'Percentage discount cannot exceed 100%',
      });
    }

    // Validate applicableIds is required when applicableTo is 'specific'
    if (
      value.applicableTo === 'specific' &&
      (!value.applicableIds || value.applicableIds.length === 0) &&
      (!value.applicablePackageIds || value.applicablePackageIds.length === 0) &&
      (!value.applicableTestIds || value.applicableTestIds.length === 0)
    ) {
      return helpers.error('any.custom', {
        message:
          'Applicable IDs, applicable package IDs, or applicable test IDs are required when applicableTo is "specific"',
      });
    }

    return value;
  })
  .messages({
    'object.min': 'At least one field must be provided for update',
    'any.custom': 'Validation error',
  });

// Validate Coupon schema
export const validateCouponSchema = Joi.object({
  code: codeSchema,
  userId: Joi.string().trim().min(1).optional().messages({
    'string.empty': 'User ID cannot be empty',
  }),
  bookingType: Joi.string()
    .valid(
      'package',
      'consultation',
      'second-opinion',
      'surgery',
      'wallet_recharge',
      'external_specialist',
      'external_diagnostics'
    )
    .required()
    .messages({
      'any.only':
        'Booking type must be one of: package, consultation, second-opinion, surgery, wallet_recharge, external_specialist, external_diagnostics',
      'any.required': 'Booking type is required',
  }),
  bookingId: Joi.string().trim().optional(),
  packageIds: Joi.array().items(Joi.string().trim().min(1)).optional(),
  testIds: Joi.array().items(Joi.string().trim().min(1)).optional(),
  dependentId: Joi.string().trim().optional(),
  purchaseAmount: Joi.number().min(0).required().messages({
    'number.base': 'Purchase amount must be a number',
    'number.min': 'Purchase amount must be at least 0',
    'any.required': 'Purchase amount is required',
  }),
});

// Coupon Query params schema
export const couponQuerySchema = Joi.object({
  code: Joi.string().trim().optional(),
  title: Joi.string().trim().optional(),
  corporateId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid corporate ID format',
    }),
  discountType: Joi.string()
    .valid('percentage', 'fixed')
    .optional()
    .messages({
      'any.only': 'Discount type must be either "percentage" or "fixed"',
    }),
  eligibleFor: Joi.string()
    .valid('all', 'specialist', 'package', 'external_specialist', 'external_diagnostics')
    .optional()
    .messages({
      'any.only':
        'Eligible for must be one of: all, specialist, package, external_specialist, external_diagnostics',
    }),
  applicableTo: Joi.string()
    .valid('all', 'wellnessPackage', 'consultation', 'specific')
    .optional()
    .messages({
      'any.only':
        'Applicable to must be one of: all, wellnessPackage, consultation, specific',
    }),
  isActive: Joi.string().valid('true', 'false').optional(),
  startDateFrom: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Start date from must be in YYYYMMDD format (e.g., 20250215)',
    }),
  startDateTo: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Start date to must be in YYYYMMDD format (e.g., 20250215)',
    }),
  endDateFrom: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'End date from must be in YYYYMMDD format (e.g., 20250215)',
    }),
  endDateTo: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'End date to must be in YYYYMMDD format (e.g., 20250215)',
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
    .valid('code', 'discountValue', 'startDate', 'endDate', 'createdAt', 'updatedAt')
    .optional()
    .messages({
      'any.only':
        'sortBy must be one of: code, discountValue, startDate, endDate, createdAt, updatedAt',
    }),
  sortOrder: Joi.string().valid('asc', 'desc').optional().messages({
    'any.only': 'sortOrder must be either "asc" or "desc"',
  }),
}).custom((value, helpers) => {
  // Validate date ranges
  if (
    value.startDateFrom &&
    value.startDateTo &&
    value.startDateFrom.localeCompare(value.startDateTo) > 0
  ) {
    return helpers.error('any.custom', {
      message: 'Start date from cannot be greater than start date to',
    });
  }

  if (
    value.endDateFrom &&
    value.endDateTo &&
    value.endDateFrom.localeCompare(value.endDateTo) > 0
  ) {
    return helpers.error('any.custom', {
      message: 'End date from cannot be greater than end date to',
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

// Params schema for code
export const codeParamSchema = Joi.object({
  code: codeSchema,
});

export const couponUsageQuerySchema = Joi.object({
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
  corporateId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'corporateId must be a valid MongoDB ObjectId',
    }),
});
