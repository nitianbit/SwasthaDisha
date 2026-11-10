import Joi from 'joi';

export const createOTPSchema = Joi.object({
  userId: Joi.string().required().messages({
    'string.empty': 'User ID is required',
    'any.required': 'User ID is required',
  }),
  otp: Joi.string().length(6).required().messages({
    'string.empty': 'OTP is required',
    'string.length': 'OTP must be 6 digits',
    'any.required': 'OTP is required',
  }),
  target: Joi.string().valid('phone', 'email').required().messages({
    'any.only': 'Target must be either phone or email',
    'any.required': 'Target is required',
  }),
  targetValue: Joi.string().optional(),
  expireAt: Joi.date().optional(),
});

export const verifyOTPSchema = Joi.object({
  userId: Joi.string().required().messages({
    'string.empty': 'User ID is required',
    'any.required': 'User ID is required',
  }),
  otp: Joi.string().required().messages({
    'string.empty': 'OTP is required',
    'any.required': 'OTP is required',
  }),
  target: Joi.string().valid('phone', 'email').required().messages({
    'any.only': 'Target must be either phone or email',
    'any.required': 'Target is required',
  }),
});
