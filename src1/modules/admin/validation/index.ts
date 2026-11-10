import Joi from 'joi';

export const updateAdminProfileSchema = Joi.object({
  name: Joi.string().trim().optional(),
  email: Joi.string().email().optional().messages({
    'string.email': 'Email must be a valid email address',
  }),
  profilePictureUrl: Joi.string().trim().optional(),
  department: Joi.string().trim().optional(),
  employeeId: Joi.string().trim().optional(),
  permissions: Joi.array().items(Joi.string().trim().min(1)).optional(),
  address: Joi.string().trim().optional(),
  city: Joi.string().trim().optional(),
  state: Joi.string().trim().optional(),
  pincode: Joi.string().trim().optional(),
  country: Joi.string().trim().optional(),
  isActive: Joi.boolean().optional(),
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update',
  });

export const adminQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
  search: Joi.string().trim().optional(),
  isActive: Joi.string().valid('true', 'false').optional(),
  sortBy: Joi.string().valid('name', 'email', 'createdAt', 'updatedAt').optional(),
  sortOrder: Joi.string().valid('asc', 'desc').optional(),
});

export const adminIdParamSchema = Joi.object({
  id: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid admin ID format',
      'any.required': 'Admin ID is required',
    }),
});
