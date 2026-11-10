import Joi from 'joi';

export const verifyPaymentSchema = Joi.object({
  paymentTransactionId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid payment transaction ID format',
      'any.required': 'paymentTransactionId is required',
    }),
  razorpayOrderId: Joi.string().trim().required().messages({
    'string.empty': 'razorpayOrderId is required',
    'any.required': 'razorpayOrderId is required',
  }),
  razorpayPaymentId: Joi.string().trim().required().messages({
    'string.empty': 'razorpayPaymentId is required',
    'any.required': 'razorpayPaymentId is required',
  }),
  razorpaySignature: Joi.string().trim().required().messages({
    'string.empty': 'razorpaySignature is required',
    'any.required': 'razorpaySignature is required',
  }),
  module: Joi.string().trim().valid('external-bookings').optional(),
});
