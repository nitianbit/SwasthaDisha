import Joi from 'joi';

export const addCartItemSchema = Joi.object({
  pharmacyId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid pharmacyId',
      'any.required': 'pharmacyId is required',
    }),
  medicineId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid medicineId',
      'any.required': 'medicineId is required',
    }),
  quantity: Joi.number().integer().not(0).required().messages({
    'any.required': 'quantity is required',
    'any.invalid': 'quantity cannot be 0',
  }),
});

export const medicineIdParamSchema = Joi.object({
  medicineId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid medicineId',
      'any.required': 'medicineId is required',
    }),
});

export const checkoutCartSchema = Joi.object({
  paymentMode: Joi.string()
    .valid('online_payment', 'in_store_payment', 'cash_on_delivery')
    .required(),
  deliveryMode: Joi.string().valid('pickup', 'delivery').optional(),
  deliveryAddress: Joi.string().trim().optional(),
  prescriptionUrls: Joi.array().items(Joi.string().trim()).optional(),
  notes: Joi.string().trim().max(1000).optional(),
}).custom((value, helpers) => {
  if (value.deliveryMode === 'delivery' && !value.deliveryAddress?.trim()) {
    return helpers.error('any.invalid');
  }
  return value;
}).messages({
  'any.invalid': 'deliveryAddress is required when deliveryMode is delivery',
});
