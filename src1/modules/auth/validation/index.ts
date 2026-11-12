import Joi from 'joi';
import { AppError } from '@/modules/common/types';

// Common validation schemas
const phoneSchema = Joi.string()
  .pattern(/^[0-9]{10}$/)
  .messages({
    'string.pattern.base': 'Phone must be exactly 10 digits',
  });

const emailSchema = Joi.string().email().messages({
  'string.email': 'Email must be a valid email address',
});

const userTypeSchema = Joi.string()
  .valid('user', 'admin', 'specialist', 'hr', 'pharmacy')
  .required()
  .messages({
    'any.only': 'userType must be one of: user, admin, specialist, hr, pharmacy',
    'any.required': 'userType is required',
  });

// Send OTP validation schema (body only - userType comes from params)
export const sendOTPSchema = Joi.object({
  phone: phoneSchema.optional(),
  email: emailSchema.optional(),
})
  .or('phone', 'email')
  .messages({
    'object.missing': 'Either phone or email must be provided',
  });

// Verify OTP validation schema (body only - userType comes from params)
export const verifyOTPSchema = Joi.object({
  phone: phoneSchema.optional(),
  email: emailSchema.optional(),
  otp: Joi.string()
    .pattern(/^[0-9]{6}$/)
    .required()
    .messages({
      'string.pattern.base': 'OTP must be exactly 6 digits',
      'any.required': 'OTP is required',
    }),
})
  .or('phone', 'email')
  .messages({
    'object.missing': 'Either phone or email must be provided',
  });

// Individual accounts enroll and authenticate one proved destination at a time.
// The legacy role schemas above keep their existing request contracts.
export const customerSendOTPSchema = Joi.object({
  phone: phoneSchema.optional(),
  email: emailSchema.optional(),
}).xor('phone', 'email');

export const customerVerifyOTPSchema = customerSendOTPSchema.append({
  otp: verifyOTPSchema.extract('otp'),
});

export function selectCustomerLoginContact(
  data: { phone?: unknown; email?: unknown; otp?: unknown },
  verify = false
): { target: 'phone' | 'email'; targetValue: string } {
  const invalid = (): never => {
    throw new AppError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Provide exactly one valid phone or email',
    });
  };
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid();
  const { phone, email, otp } = data;
  if (phone !== undefined && typeof phone !== 'string') invalid();
  if (email !== undefined && typeof email !== 'string') invalid();
  if (verify && typeof otp !== 'string') invalid();

  const candidate = {
    ...(phone !== undefined ? { phone } : {}),
    ...(email !== undefined ? { email: typeof email === 'string' ? email.trim().toLowerCase() : email } : {}),
    ...(verify ? { otp } : {}),
  };
  const schema = verify ? customerVerifyOTPSchema : customerSendOTPSchema;
  const { error, value } = schema.validate(candidate, { convert: false, stripUnknown: false });
  if (error) invalid();
  return value.phone !== undefined
    ? { target: 'phone', targetValue: value.phone }
    : { target: 'email', targetValue: value.email };
}

export const sendEmailVerificationOTPSchema = Joi.object({
  email: emailSchema.required().messages({
    'any.required': 'Email is required',
  }),
  isCorporateUser: Joi.boolean().optional(),
});

export const verifyEmailVerificationOTPSchema = Joi.object({
  email: emailSchema.optional(),
  isCorporateUser: Joi.boolean().optional(),
  otp: Joi.string()
    .pattern(/^[0-9]{6}$/)
    .required()
    .messages({
      'string.pattern.base': 'OTP must be exactly 6 digits',
      'any.required': 'OTP is required',
    }),
});

export const sendCorporateEmailVerificationOTPSchema = Joi.object({
  corporateEmail: emailSchema.required().messages({
    'any.required': 'Corporate email is required',
  }),
});

export const verifyCorporateEmailVerificationOTPSchema = Joi.object({
  corporateEmail: emailSchema.optional(),
  otp: Joi.string()
    .pattern(/^[0-9]{6}$/)
    .required()
    .messages({
      'string.pattern.base': 'OTP must be exactly 6 digits',
      'any.required': 'OTP is required',
    }),
});

// Params validation schema for userType
export const userTypeParamSchema = Joi.object({
  userType: userTypeSchema,
});
