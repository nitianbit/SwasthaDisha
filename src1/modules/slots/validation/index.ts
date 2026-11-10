import Joi from 'joi';

// Common schemas
const dateSchema = Joi.string()
  .pattern(/^\d{8}$/)
  .required()
  .messages({
    'string.pattern.base': 'Date must be in YYYYMMDD format (e.g., 20250215)',
    'any.required': 'Date is required',
  });

const startTimeSchema = Joi.string().trim().required().messages({
  'string.empty': 'Start time is required',
  'any.required': 'Start time is required',
});

const endTimeSchema = Joi.string().trim().required().messages({
  'string.empty': 'End time is required',
  'any.required': 'End time is required',
});

const durationSchema = Joi.number().integer().min(1).optional().messages({
  'number.base': 'Duration must be a number',
  'number.integer': 'Duration must be an integer',
  'number.min': 'Duration must be at least 1 minute',
});

const isAvailableSchema = Joi.boolean().optional();

const maxBookingsSchema = Joi.number().integer().min(1).optional().messages({
  'number.base': 'Max bookings must be a number',
  'number.integer': 'Max bookings must be an integer',
  'number.min': 'Max bookings must be at least 1',
});

const currentBookingsSchema = Joi.number()
  .integer()
  .min(0)
  .optional()
  .messages({
    'number.base': 'Current bookings must be a number',
    'number.integer': 'Current bookings must be an integer',
    'number.min': 'Current bookings must be at least 0',
  });

const slotTypeSchema = Joi.string()
  .valid('consultation', 'wellnessPackage')
  .optional()
  .messages({
    'any.only': 'Slot type must be one of: consultation, wellnessPackage',
  });

const isRecurringSchema = Joi.boolean().optional();

const recurringPatternSchema = Joi.string()
  .valid('daily', 'weekly', 'monthly')
  .optional()
  .messages({
    'any.only': 'Recurring pattern must be one of: daily, weekly, monthly',
  });

const isActiveSchema = Joi.boolean().optional();

// Create Slot schema
export const createSlotSchema = Joi.object({
  specialistId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid specialist ID format',
    }),
  wellnessPackageId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid wellness package ID format',
    }),
  date: dateSchema,
  startTime: startTimeSchema,
  endTime: endTimeSchema,
  duration: durationSchema,
  isAvailable: isAvailableSchema,
  maxBookings: maxBookingsSchema,
  currentBookings: currentBookingsSchema,
  slotType: slotTypeSchema,
  isRecurring: isRecurringSchema,
  recurringPattern: recurringPatternSchema,
  isActive: isActiveSchema,
})
  .xor('specialistId', 'wellnessPackageId')
  .messages({
    'object.missing':
      'Either specialistId or wellnessPackageId must be provided',
    'object.unknown': 'Cannot provide both specialistId and wellnessPackageId',
  });

// Update Slot schema (all fields optional except at least one must be present)
export const updateSlotSchema = Joi.object({
  date: dateSchema.optional(),
  startTime: startTimeSchema.optional(),
  endTime: endTimeSchema.optional(),
  duration: durationSchema,
  isAvailable: isAvailableSchema,
  maxBookings: maxBookingsSchema,
  currentBookings: currentBookingsSchema,
  isRecurring: isRecurringSchema,
  recurringPattern: recurringPatternSchema,
  isActive: isActiveSchema,
}).min(1).messages({
  'object.min': 'At least one field must be provided for update',
});

// Query params schema
export const slotQuerySchema = Joi.object({
  specialistId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid specialist ID format',
    }),
  wellnessPackageId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid wellness package ID format',
    }),
  slotType: Joi.string()
    .valid('consultation', 'wellnessPackage')
    .optional()
    .messages({
      'any.only': 'Slot type must be one of: consultation, wellnessPackage',
    }),
  date: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Date must be in YYYYMMDD format (e.g., 20250215)',
    }),
  dateFrom: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Date from must be in YYYYMMDD format (e.g., 20250215)',
    }),
  dateTo: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Date to must be in YYYYMMDD format (e.g., 20250215)',
    }),
  isAvailable: Joi.string().valid('true', 'false').optional(),
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
    .valid('date', 'startTime', 'endTime', 'createdAt', 'updatedAt')
    .optional()
    .messages({
      'any.only':
        'sortBy must be one of: date, startTime, endTime, createdAt, updatedAt',
    }),
  sortOrder: Joi.string().valid('asc', 'desc').optional().messages({
    'any.only': 'sortOrder must be either "asc" or "desc"',
  }),
}).custom((value, helpers) => {
  // Validate that dateFrom <= dateTo if both are provided
  if (
    value.dateFrom &&
    value.dateTo &&
    value.dateFrom.localeCompare(value.dateTo) > 0
  ) {
    return helpers.error('any.custom', {
      message: 'Date from cannot be greater than date to',
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

// Params schema for specialistId
export const specialistIdParamSchema = Joi.object({
  specialistId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid specialist ID format',
      'any.required': 'Specialist ID is required',
    }),
});

// Params schema for wellnessPackageId
export const wellnessPackageIdParamSchema = Joi.object({
  wellnessPackageId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid wellness package ID format',
      'any.required': 'Wellness package ID is required',
    }),
});
