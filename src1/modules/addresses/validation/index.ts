import Joi from 'joi';

const objectIdSchema = Joi.string()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({
    'string.pattern.base': 'Invalid ID format',
  });

const typeSchema = Joi.string().valid('Home', 'Work', 'Other');
const addressSchema = Joi.string().trim().min(3).max(500);
const landmarkSchema = Joi.string().trim().max(200);
const citySchema = Joi.string().trim().min(1).max(100);
const stateSchema = Joi.string().trim().min(1).max(100);
const pincodeSchema = Joi.string().trim().min(3).max(20);
const countrySchema = Joi.string().trim().min(1).max(100);
const latitudeSchema = Joi.number().min(-90).max(90);
const longitudeSchema = Joi.number().min(-180).max(180);

export const createAddressSchema = Joi.object({
  userId: objectIdSchema.optional(),
  type: typeSchema.optional(),
  label: Joi.string().trim().max(100).optional(),
  address: addressSchema.required().messages({
    'any.required': 'Address is required',
  }),
  landmark: landmarkSchema.optional(),
  city: citySchema.required().messages({
    'any.required': 'City is required',
  }),
  state: stateSchema.required().messages({
    'any.required': 'State is required',
  }),
  pincode: pincodeSchema.required().messages({
    'any.required': 'Pincode is required',
  }),
  country: countrySchema.optional(),
  latitude: latitudeSchema.optional(),
  longitude: longitudeSchema.optional(),
  isDefault: Joi.boolean().optional(),
  isActive: Joi.boolean().optional(),
});

export const updateAddressSchema = Joi.object({
  type: typeSchema.optional(),
  label: Joi.string().trim().max(100).optional(),
  address: addressSchema.optional(),
  landmark: landmarkSchema.optional(),
  city: citySchema.optional(),
  state: stateSchema.optional(),
  pincode: pincodeSchema.optional(),
  country: countrySchema.optional(),
  latitude: latitudeSchema.optional(),
  longitude: longitudeSchema.optional(),
  isDefault: Joi.boolean().optional(),
  isActive: Joi.boolean().optional(),
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update',
  });

export const addressQuerySchema = Joi.object({
  userId: objectIdSchema.optional(),
  type: typeSchema.optional(),
  isDefault: Joi.string().valid('true', 'false').optional(),
  isActive: Joi.string().valid('true', 'false').optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
  sortBy: Joi.string()
    .valid('createdAt', 'updatedAt', 'city', 'state', 'pincode', 'isDefault')
    .optional(),
  sortOrder: Joi.string().valid('asc', 'desc').optional(),
});

export const idParamSchema = Joi.object({
  id: objectIdSchema.required().messages({
    'any.required': 'Address ID is required',
  }),
});
