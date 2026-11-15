import Joi from 'joi';

// Common schemas
const nameSchema = Joi.string().trim().min(1).max(200).required().messages({
  'string.empty': 'Name is required',
  'string.min': 'Name must be at least 1 character',
  'string.max': 'Name must not exceed 200 characters',
  'any.required': 'Name is required',
});

const logoUrlSchema = Joi.string()
  .trim()
  .optional()
  .custom((value, helpers) => {
    if (!value) return value; // Optional field
    // Allow full URIs (http://, https://) or relative paths starting with /
    if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/')) {
      return value;
    }
    return helpers.error('string.custom', {
      message: 'Logo URL must be a valid URI (http://, https://) or a relative path starting with /',
    });
  });

const descriptionSchema = Joi.string().trim().optional();

const websiteSchema = Joi.string().uri().trim().optional().messages({
  'string.uri': 'Website must be a valid URI',
});

const emailSchema = Joi.string().email().optional().messages({
  'string.email': 'Email must be a valid email address',
});

const phoneSchema = Joi.string()
  .pattern(/^[0-9]{10}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Phone must be exactly 10 digits',
  });

const addressSchema = Joi.string().trim().optional();

const citySchema = Joi.string().trim().optional();

const stateSchema = Joi.string().trim().optional();

const pincodeSchema = Joi.string().trim().optional();

const partnerTypeSchema = Joi.string().trim().optional();

const isActiveSchema = Joi.boolean().optional();

const isVerifiedSchema = Joi.boolean().optional();

const orderSchema = Joi.number().integer().min(0).optional().messages({
  'number.base': 'Order must be a number',
  'number.integer': 'Order must be an integer',
  'number.min': 'Order must be at least 0',
});

// Create Partner schema
export const createPartnerSchema = Joi.object({
  name: nameSchema,
  logoUrl: logoUrlSchema,
  description: descriptionSchema,
  website: websiteSchema,
  email: emailSchema,
  phone: phoneSchema,
  address: addressSchema,
  city: citySchema,
  state: stateSchema,
  pincode: pincodeSchema,
  partnerType: partnerTypeSchema,
  isActive: isActiveSchema,
  isVerified: isVerifiedSchema,
  order: orderSchema,
});

// Update Partner schema (all fields optional except at least one must be present)
export const updatePartnerSchema = Joi.object({
  name: nameSchema.optional(),
  logoUrl: logoUrlSchema,
  description: descriptionSchema,
  website: websiteSchema,
  email: emailSchema,
  phone: phoneSchema,
  address: addressSchema,
  city: citySchema,
  state: stateSchema,
  pincode: pincodeSchema,
  partnerType: partnerTypeSchema,
  isActive: isActiveSchema,
  isVerified: isVerifiedSchema,
  order: orderSchema,
}).min(1).messages({
  'object.min': 'At least one field must be provided for update',
});

// Query params schema
export const partnerQuerySchema = Joi.object({
  name: Joi.string().trim().optional(),
  email: Joi.string().trim().optional(),
  partnerType: Joi.string().trim().optional(),
  isActive: Joi.string().valid('true', 'false').optional(),
  isVerified: Joi.string().valid('true', 'false').optional(),
  city: Joi.string().trim().optional(),
  state: Joi.string().trim().optional(),
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
    .valid('name', 'order', 'partnerType', 'createdAt', 'updatedAt')
    .optional()
    .messages({
      'any.only':
        'sortBy must be one of: name, order, partnerType, createdAt, updatedAt',
    }),
  sortOrder: Joi.string().valid('asc', 'desc').optional().messages({
    'any.only': 'sortOrder must be either "asc" or "desc"',
  }),
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

// Params schema for partnerType
export const partnerTypeParamSchema = Joi.object({
  partnerType: Joi.string().trim().min(1).required().messages({
    'string.empty': 'Partner type is required',
    'any.required': 'Partner type is required',
  }),
});
