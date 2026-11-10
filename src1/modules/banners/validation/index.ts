import Joi from 'joi';

// Common schemas
const titleSchema = Joi.string().trim().min(1).max(200).optional().messages({
  'string.empty': 'Title cannot be empty',
  'string.min': 'Title must be at least 1 character',
  'string.max': 'Title must not exceed 200 characters',
});

const descriptionSchema = Joi.string().trim().optional();

const imageUrlSchema = Joi.string()
  .trim()
  .required()
  .custom((value, helpers) => {
    // Allow full URIs (http://, https://) or relative paths starting with /
    if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/')) {
      return value;
    }
    return helpers.error('string.custom', {
      message: 'Image URL must be a valid URI (http://, https://) or a relative path starting with /',
    });
  })
  .messages({
    'any.required': 'Image URL is required',
  });

const linkUrlSchema = Joi.string()
  .trim()
  .optional()
  .custom((value, helpers) => {
    if (!value) return value; // Optional field
    // Allow full URIs (http://, https://) or relative paths starting with /
    if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/')) {
      return value;
    }
    return helpers.error('string.custom', {
      message: 'Link URL must be a valid URI (http://, https://) or a relative path starting with /',
    });
  });

const bannerTypeSchema = Joi.string()
  .valid('home', 'promotional', 'category', 'wellnessPackage', 'specialist','surgery','second-opinion')
  .trim()
  .optional()
  .messages({
    'any.only': 'Invalid banner type',
  }); // Type: 'home', 'promotional', 'category', 'wellnessPackage', 'specialist', etc.

const dateSchema = Joi.string()
  .pattern(/^\d{8}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Date must be in YYYYMMDD format (e.g., 20250215)',
  }); // YYYYMMDD format for startDate/endDate

const targetSchema = Joi.string().trim().optional(); // Entity type: 'wellnessPackage', 'specialist', 'category', 'partner', etc. Used to link banner to specific entity types.

const targetIdSchema = Joi.string().trim().optional(); // ID of the target entity. If target='wellnessPackage', then targetId should be the wellnessPackageId. If target='specialist', then targetId should be the specialistId.

const isActiveSchema = Joi.boolean().optional();

const orderSchema = Joi.number().integer().min(0).optional().messages({
  'number.base': 'Order must be a number',
  'number.integer': 'Order must be an integer',
  'number.min': 'Order must be at least 0',
});

const corporateIdSchema = Joi.string()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Invalid corporate ID format',
  });

// Create Banner schema
// Fields:
// - title: Banner title/heading (optional)
// - description: Optional description text
// - imageUrl: URL of banner image (required, must be valid URI)
// - linkUrl: Optional redirect URL when banner is clicked
// - bannerType: Type of banner ('home', 'promotional', 'category', 'wellnessPackage', 'specialist', etc.)
// - startDate: Optional start date (YYYYMMDD) - banner appears from this date
// - endDate: Optional end date (YYYYMMDD) - banner disappears after this date
// - target: Optional entity type ('wellnessPackage', 'specialist', 'category', 'partner', etc.) - links banner to entity type
// - targetId: Optional ID of target entity - links banner to specific entity (e.g., wellnessPackageId, specialistId)
// - isActive: Whether banner is active (default: true)
// - order: Display order/priority (lower = appears first, auto-assigned if not provided)
export const createBannerSchema = Joi.object({
  title: titleSchema,
  description: descriptionSchema,
  imageUrl: imageUrlSchema,
  linkUrl: linkUrlSchema,
  bannerType: bannerTypeSchema,
  startDate: dateSchema,
  endDate: dateSchema,
  target: targetSchema,
  targetId: targetIdSchema,
  corporateId: corporateIdSchema,
  isActive: isActiveSchema,
  order: orderSchema,
}).custom((value, helpers) => {
  // Validate that startDate <= endDate if both are provided
  if (value.startDate && value.endDate && value.startDate.localeCompare(value.endDate) > 0) {
    return helpers.error('any.custom', {
      message: 'Start date cannot be greater than end date',
    });
  }
  return value;
});

// Update Banner schema (all fields optional except at least one must be present)
export const updateBannerSchema = Joi.object({
  title: titleSchema.optional(),
  description: descriptionSchema,
  imageUrl: imageUrlSchema.optional(),
  linkUrl: linkUrlSchema,
  bannerType: bannerTypeSchema,
  startDate: dateSchema,
  endDate: dateSchema,
  target: targetSchema,
  targetId: targetIdSchema,
  corporateId: corporateIdSchema,
  isActive: isActiveSchema,
  order: orderSchema,
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update',
  })
  .custom((value, helpers) => {
    // Validate dates if both are provided
    if (
      value.startDate &&
      value.endDate &&
      value.startDate.localeCompare(value.endDate) > 0
    ) {
      return helpers.error('any.custom', {
        message: 'Start date cannot be greater than end date',
      });
    }
    return value;
  });

// Query params schema
// Query parameters for filtering banners:
// - bannerType: Filter by banner type ('home', 'promotional', etc.)
// - target: Filter by target entity type ('wellnessPackage', 'specialist', etc.)
// - targetId: Filter by specific target entity ID
// - isActive: Filter by active status ('true' or 'false')
export const bannerQuerySchema = Joi.object({
  title: Joi.string().trim().optional(),
  bannerType: Joi.string()
    .valid('home', 'promotional', 'category', 'wellnessPackage', 'specialist','surgery','second-opinion')
    .trim()
    .optional()
    .messages({
      'any.only': 'Banner type must be one of: home, promotional, category, wellnessPackage, specialist',
    }), // Filter by banner type
  target: Joi.string().trim().optional(), // Filter by target entity type ('wellnessPackage', 'specialist', 'category', etc.)
  targetId: Joi.string().trim().optional(), // Filter by specific target entity ID
  corporateId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid corporate ID format',
    }), // Filter by corporate ID
  isActive: Joi.string().valid('true', 'false').optional(), // Filter by active status
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
    .valid('title', 'order', 'bannerType', 'createdAt', 'updatedAt')
    .optional()
    .messages({
      'any.only':
        'sortBy must be one of: title, order, bannerType, createdAt, updatedAt',
    }),
  sortOrder: Joi.string().valid('asc', 'desc').optional().messages({
    'any.only': 'sortOrder must be either "asc" or "desc"',
  }),
  forUser: Joi.string().valid('true', 'false').optional(),
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

// Params schema for bannerType
export const bannerTypeParamSchema = Joi.object({
  bannerType: Joi.string().trim().min(1).required().messages({
    'string.empty': 'Banner type is required',
    'any.required': 'Banner type is required',
  }),
});
