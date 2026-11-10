import Joi from 'joi';

export const googleOAuthQuerySchema = Joi.object({
  state: Joi.string().trim().max(500).optional(),
});

export const googleOAuthCallbackQuerySchema = Joi.object({
  code: Joi.string().trim().optional(),
  state: Joi.string().trim().max(500).optional(),
  scope: Joi.string().trim().optional(),
  error: Joi.string().trim().optional(),
});

export const googleOAuthExchangeSchema = Joi.object({
  code: Joi.string().trim().required().messages({
    'string.empty': 'code is required',
    'any.required': 'code is required',
  }),
  redirectUri: Joi.string().trim().uri().optional().messages({
    'string.uri': 'redirectUri must be a valid URI',
  }),
});

export const googleOAuthRefreshTestSchema = Joi.object({
  refreshToken: Joi.string().trim().optional(),
});

export const testGoogleMeetSchema = Joi.object({
  patientEmail: Joi.string().email().required().messages({
    'string.email': 'patientEmail must be a valid email',
    'any.required': 'patientEmail is required',
  }),
  specialistEmail: Joi.string().email().required().messages({
    'string.email': 'specialistEmail must be a valid email',
    'any.required': 'specialistEmail is required',
  }),
  dateYyyymmdd: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'dateYyyymmdd must be YYYYMMDD',
    }),
  startTime: Joi.string().trim().optional().messages({
    'string.empty': 'startTime cannot be empty',
  }),
  durationMinutes: Joi.number().integer().min(5).max(480).optional().messages({
    'number.min': 'durationMinutes must be at least 5',
    'number.max': 'durationMinutes must not exceed 480',
  }),
  summary: Joi.string().trim().max(500).optional(),
});
