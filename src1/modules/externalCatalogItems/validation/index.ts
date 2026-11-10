import Joi from 'joi';

const integrationSchema = Joi.string()
  .trim()
  .valid('labstack', 'healthians')
  .required()
  .messages({
    'any.only': 'Integration must be either labstack or healthians',
    'any.required': 'Integration is required',
  });

const itemTypeSchema = Joi.string()
  .trim()
  .valid('package', 'test')
  .required()
  .messages({
    'any.only': 'Item type must be either package or test',
    'any.required': 'Item type is required',
  });

const externalItemIdSchema = Joi.string().trim().min(1).required().messages({
  'string.empty': 'External item ID is required',
  'any.required': 'External item ID is required',
});

const nameSchema = Joi.string().trim().max(200).optional();

const imageSchema = Joi.string()
  .trim()
  .optional()
  .custom((value, helpers) => {
    if (!value) return value;
    if (
      value.startsWith('http://') ||
      value.startsWith('https://') ||
      value.startsWith('/')
    ) {
      return value;
    }
    return helpers.error('string.custom', {
      message:
        'Image must be a valid URI (http://, https://) or a relative path starting with /',
    });
  });

const priceSchema = Joi.number().min(0).optional().messages({
  'number.min': 'Custom price cannot be negative',
});

const isActiveSchema = Joi.boolean().optional();
const pinnedSchema = Joi.boolean().optional();

export const createExternalCatalogItemSchema = Joi.object({
  integration: integrationSchema,
  itemType: itemTypeSchema,
  externalItemId: externalItemIdSchema,
  name: nameSchema,
  customPrice: priceSchema,
  image: imageSchema,
  coverImage: imageSchema,
  pinned: pinnedSchema,
  isActive: isActiveSchema,
});

export const updateExternalCatalogItemSchema = Joi.object({
  name: nameSchema,
  customPrice: priceSchema,
  image: imageSchema,
  coverImage: imageSchema,
  pinned: pinnedSchema,
  isActive: isActiveSchema,
})
  .min(1)
  .messages({
    'object.min':
      'At least one field must be provided for external catalog item update',
  });

export const externalCatalogItemQuerySchema = Joi.object({
  integration: Joi.string().trim().valid('labstack', 'healthians').optional(),
  itemType: Joi.string().trim().valid('package', 'test').optional(),
  externalItemId: Joi.string().trim().optional(),
  name: Joi.string().trim().optional(),
  pinned: Joi.boolean().optional(),
  isActive: Joi.boolean().optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
  sortBy: Joi.string()
    .valid(
      'createdAt',
      'updatedAt',
      'externalItemId',
      'name',
      'customPrice',
      'pinned'
    )
    .optional(),
  sortOrder: Joi.string().valid('asc', 'desc').optional(),
});

export const externalCatalogItemIdParamSchema = Joi.object({
  id: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid ID format',
      'any.required': 'ID is required',
    }),
});
