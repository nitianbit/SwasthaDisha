import Joi from 'joi';

const dosageForms = [
  'tablet', 'capsule', 'syrup', 'injection', 'cream',
  'ointment', 'drops', 'inhaler', 'patch', 'powder',
  'solution', 'gel', 'other',
];

const medicineFields = {
  name: Joi.string().trim().min(1).max(300),
  genericName: Joi.string().trim().max(300).optional(),
  brandName: Joi.string().trim().max(300).optional(),
  category: Joi.string().trim().max(100).optional(),
  imageUrl: Joi.string().trim().optional(),
  dosageForm: Joi.string().valid(...dosageForms).optional(),
  strength: Joi.string().trim().max(100).optional(),
  manufacturer: Joi.string().trim().max(200).optional(),
  hsnCode: Joi.string().trim().max(50).optional(),
  gstPercent: Joi.number().min(0).max(100).optional(),
  prescriptionRequired: Joi.boolean().optional(),
  isActive: Joi.boolean().optional(),
};

export const createMedicineSchema = Joi.object({
  ...medicineFields,
  name: medicineFields.name.required().messages({
    'string.empty': 'Name is required',
    'any.required': 'Name is required',
  }),
});

export const updateMedicineSchema = Joi.object(medicineFields)
  .min(1)
  .messages({ 'object.min': 'At least one field must be provided for update' });

export const medicineQuerySchema = Joi.object({
  name: Joi.string().trim().optional(),
  genericName: Joi.string().trim().optional(),
  brandName: Joi.string().trim().optional(),
  category: Joi.string().trim().optional(),
  dosageForm: Joi.string().valid(...dosageForms).optional(),
  manufacturer: Joi.string().trim().optional(),
  prescriptionRequired: Joi.string().valid('true', 'false').optional(),
  isActive: Joi.string().valid('true', 'false').optional(),
  search: Joi.string().trim().optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
  sortBy: Joi.string().valid('name', 'genericName', 'category', 'manufacturer', 'createdAt').optional(),
  sortOrder: Joi.string().valid('asc', 'desc').optional(),
});

export const nearbyMedicineQuerySchema = Joi.object({
  latitude: Joi.number().min(-90).max(90).required().messages({
    'any.required': 'latitude is required',
  }),
  longitude: Joi.number().min(-180).max(180).required().messages({
    'any.required': 'longitude is required',
  }),
  radiusKm: Joi.number().min(0.1).max(200).optional(),
  search: Joi.string().trim().optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
});

export const idParamSchema = Joi.object({
  id: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({ 'string.pattern.base': 'Invalid ID format', 'any.required': 'ID is required' }),
});
