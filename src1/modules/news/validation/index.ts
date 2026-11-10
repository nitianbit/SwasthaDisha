import Joi from 'joi';

const titleSchema = Joi.string().trim().min(1).max(200).required().messages({
  'string.empty': 'Title is required',
  'any.required': 'Title is required',
});

const descriptionSchema = Joi.string().trim().min(1).required().messages({
  'string.empty': 'Description is required',
  'any.required': 'Description is required',
});

const imageSchema = Joi.string()
  .trim()
  .optional()
  .custom((value, helpers) => {
    if (!value) return value;
    if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/')) {
      return value;
    }
    return helpers.error('string.custom', {
      message: 'Image must be a valid URI (http://, https://) or a relative path starting with /',
    });
  });

const linkSchema = Joi.string()
  .trim()
  .uri({ scheme: ['http', 'https'] })
  .optional()
  .messages({
    'string.uri': 'Link must be a valid URL',
  });

const publishedAtSchema = Joi.string()
  .pattern(/^\d{8}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Published date must be in YYYYMMDD format',
  });

export const createNewsSchema = Joi.object({
  title: titleSchema,
  description: descriptionSchema,
  image: imageSchema,
  link: linkSchema,
  publishedAt: publishedAtSchema,
});

export const updateNewsSchema = Joi.object({
  title: titleSchema.optional(),
  description: descriptionSchema.optional(),
  image: imageSchema,
  link: linkSchema,
  publishedAt: publishedAtSchema,
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update',
  });

export const newsQuerySchema = Joi.object({
  title: Joi.string().trim().optional(),
  description: Joi.string().trim().optional(),
  publishedAt: publishedAtSchema,
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
  sortBy: Joi.string().valid('title', 'publishedAt', 'createdAt', 'updatedAt').optional(),
  sortOrder: Joi.string().valid('asc', 'desc').optional(),
});

export const idParamSchema = Joi.object({
  id: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid ID format',
      'any.required': 'ID is required',
    }),
});
