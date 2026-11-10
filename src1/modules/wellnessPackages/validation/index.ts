import Joi from 'joi';

// Test category schema
const testCategorySchema = Joi.object({
  categoryName: Joi.string().trim().min(1).required().messages({
    'string.empty': 'Category name is required',
    'any.required': 'Category name is required',
  }),
  categoryTestsCount: Joi.number().integer().min(0).required().messages({
    'number.base': 'Category tests count must be a number',
    'number.integer': 'Category tests count must be an integer',
    'number.min': 'Category tests count must be at least 0',
    'any.required': 'Category tests count is required',
  }),
  subTests: Joi.array().items(Joi.string().trim()).default([]).messages({
    'array.base': 'Sub tests must be an array',
  }),
});

// Common schemas
const nameSchema = Joi.string().trim().min(1).max(200).required().messages({
  'string.empty': 'Name is required',
  'string.min': 'Name must be at least 1 character',
  'string.max': 'Name must not exceed 200 characters',
  'any.required': 'Name is required',
});

const descriptionSchema = Joi.string().trim().optional();

const bookingProcedureSchema = Joi.string().trim().optional();

const imageUrlSchema = Joi.string()
  .trim()
  .optional()
  .custom((value, helpers) => {
    if (!value) return value; // Optional field
    // Allow full URIs (http://, https://) or relative paths starting with /
    if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/')) {
      return value;
    }
    return helpers.error('string.custom', {
      message: 'Image URL must be a valid URI (http://, https://) or a relative path starting with /',
    });
  });

const originalPriceSchema = Joi.number().min(0).required().messages({
  'number.base': 'Original price must be a number',
  'number.min': 'Original price must be at least 0',
  'any.required': 'Original price is required',
});

const discountedPriceSchema = Joi.number().min(0).required().messages({
  'number.base': 'Discounted price must be a number',
  'number.min': 'Discounted price must be at least 0',
  'any.required': 'Discounted price is required',
});

const totalTestsCountSchema = Joi.number().integer().min(0).optional().messages({
  'number.base': 'Total tests count must be a number',
  'number.integer': 'Total tests count must be an integer',
  'number.min': 'Total tests count must be at least 0',
});

const hasFreeDoctorConsultationSchema = Joi.boolean().optional();

const testsIncludedSchema = Joi.array()
  .items(testCategorySchema)
  .min(1)
  .required()
  .messages({
    'array.base': 'Tests included must be an array',
    'array.min': 'At least one test category must be included',
    'any.required': 'Tests included is required',
  });

const categorySchema = Joi.string().trim().optional();

const isActiveSchema = Joi.boolean().optional();

const isPopularSchema = Joi.boolean().optional();

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

// Create WellnessPackage schema
export const createWellnessPackageSchema = Joi.object({
  name: nameSchema,
  description: descriptionSchema,
  bookingProcedure: bookingProcedureSchema,
  imageUrl: imageUrlSchema,
  originalPrice: originalPriceSchema,
  discountedPrice: discountedPriceSchema,
  totalTestsCount: totalTestsCountSchema,
  hasFreeDoctorConsultation: hasFreeDoctorConsultationSchema,
  testsIncluded: testsIncludedSchema,
  category: categorySchema,
  isActive: isActiveSchema,
  isPopular: isPopularSchema,
  order: orderSchema,
  corporate_id: corporateIdSchema,
}).custom((value, helpers) => {
  // Validate that discountedPrice <= originalPrice
  if (value.discountedPrice > value.originalPrice) {
    return helpers.error('any.custom', {
      message: 'Discounted price cannot be greater than original price',
    });
  }
  return value;
});

// Update WellnessPackage schema (all fields optional except at least one must be present)
export const updateWellnessPackageSchema = Joi.object({
  name: nameSchema.optional(),
  description: descriptionSchema,
  bookingProcedure: bookingProcedureSchema,
  imageUrl: imageUrlSchema,
  originalPrice: originalPriceSchema.optional(),
  discountedPrice: discountedPriceSchema.optional(),
  totalTestsCount: totalTestsCountSchema,
  hasFreeDoctorConsultation: hasFreeDoctorConsultationSchema,
  testsIncluded: Joi.array().items(testCategorySchema).optional().messages({
    'array.base': 'Tests included must be an array',
  }),
  category: categorySchema,
  isActive: isActiveSchema,
  isPopular: isPopularSchema,
  order: orderSchema,
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update',
  })
  .custom((value, helpers) => {
    // Validate prices if both are provided
    if (
      value.discountedPrice !== undefined &&
      value.originalPrice !== undefined &&
      value.discountedPrice > value.originalPrice
    ) {
      return helpers.error('any.custom', {
        message: 'Discounted price cannot be greater than original price',
      });
    }
    return value;
  });

// Query params schema
export const wellnessPackageQuerySchema = Joi.object({
  name: Joi.string().trim().optional(),
  category: Joi.string().trim().optional(),
  isActive: Joi.string().valid('true', 'false').optional(),
  isPopular: Joi.string().valid('true', 'false').optional(),
  search: Joi.string().trim().optional(),
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
    .valid('name', 'order', 'originalPrice', 'discountedPrice', 'createdAt', 'updatedAt')
    .optional()
    .messages({
      'any.only':
        'sortBy must be one of: name, order, originalPrice, discountedPrice, createdAt, updatedAt',
    }),
  sortOrder: Joi.string().valid('asc', 'desc').optional().messages({
    'any.only': 'sortOrder must be either "asc" or "desc"',
  }),
  minPrice: Joi.number().min(0).optional().messages({
    'number.base': 'Min price must be a number',
    'number.min': 'Min price must be at least 0',
  }),
  maxPrice: Joi.number().min(0).optional().messages({
    'number.base': 'Max price must be a number',
    'number.min': 'Max price must be at least 0',
  }),
  forUser: Joi.string().valid('true', 'false').optional(),
}).custom((value, helpers) => {
  // Validate that minPrice <= maxPrice if both are provided
  if (
    value.minPrice !== undefined &&
    value.maxPrice !== undefined &&
    value.minPrice > value.maxPrice
  ) {
    return helpers.error('any.custom', {
      message: 'Min price cannot be greater than max price',
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

// Params schema for category
export const categoryParamSchema = Joi.object({
  category: Joi.string().trim().min(1).required().messages({
    'string.empty': 'Category is required',
    'any.required': 'Category is required',
  }),
});
