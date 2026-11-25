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
  // Informational only: the released apps send 'external-bookings' (lab/consultation bookings) or 'pharmacy-wallet'
  // (pharmacy wallet top-up, S6). What a payment pays for is decided from the stored payment record, never from this.
  module: Joi.string().trim().valid('external-bookings', 'pharmacy-wallet').optional(),
});

/** POST /payments/reconcile (W3b): settle a payment from the gateway's own record of the order. */
export const reconcilePaymentSchema = Joi.object({
  paymentTransactionId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
});
