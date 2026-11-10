import Joi from 'joi';

// Common schemas
const titleSchema = Joi.string().trim().min(1).max(200).required().messages({
  'string.empty': 'Title is required',
  'string.min': 'Title must be at least 1 character',
  'string.max': 'Title must not exceed 200 characters',
  'any.required': 'Title is required',
});

const descriptionSchema = Joi.string().trim().min(1).required().messages({
  'string.empty': 'Description is required',
  'string.min': 'Description must be at least 1 character',
  'any.required': 'Description is required',
});

const shortDescriptionSchema = Joi.string().trim().max(500).optional().messages({
  'string.max': 'Short description must not exceed 500 characters',
});

const iconSchema = Joi.string().trim().optional();

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

const categorySchema = Joi.string().trim().optional();

const isActiveSchema = Joi.boolean().optional();

const orderSchema = Joi.number().integer().min(0).optional().messages({
  'number.base': 'Order must be a number',
  'number.integer': 'Order must be an integer',
  'number.min': 'Order must be at least 0',
});

// Create HealthTip schema
export const createHealthTipSchema = Joi.object({
  title: titleSchema,
  description: descriptionSchema,
  shortDescription: shortDescriptionSchema,
  icon: iconSchema,
  imageUrl: imageUrlSchema,
  category: categorySchema,
  isActive: isActiveSchema,
  order: orderSchema,
});

// Update HealthTip schema (all fields optional except at least one must be present)
export const updateHealthTipSchema = Joi.object({
  title: titleSchema.optional(),
  description: descriptionSchema.optional(),
  shortDescription: shortDescriptionSchema,
  icon: iconSchema,
  imageUrl: imageUrlSchema,
  category: categorySchema,
  isActive: isActiveSchema,
  order: orderSchema,
}).min(1).messages({
  'object.min': 'At least one field must be provided for update',
});

// Query params schema
export const healthTipQuerySchema = Joi.object({
  title: Joi.string().trim().optional(),
  category: Joi.string().trim().optional(),
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
    .valid('title', 'order', 'createdAt', 'updatedAt')
    .optional()
    .messages({
      'any.only': 'sortBy must be one of: title, order, createdAt, updatedAt',
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

// Params schema for category
export const categoryParamSchema = Joi.object({
  category: Joi.string().trim().min(1).required().messages({
    'string.empty': 'Category is required',
    'any.required': 'Category is required',
  }),
});
