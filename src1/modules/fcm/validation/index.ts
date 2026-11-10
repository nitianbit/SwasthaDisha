import Joi from 'joi';

export const saveFcmTokenSchema = Joi.object({
  token: Joi.string().trim().required().messages({
    'string.empty': 'FCM token is required',
    'any.required': 'FCM token is required',
  }),
  platform: Joi.string().valid('android', 'ios', 'web').optional().messages({
    'any.only': 'Platform must be one of: android, ios, web',
  }),
  deviceId: Joi.string().trim().optional(),
});

export const sendTestNotificationSchema = Joi.object({
  userId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid user ID format',
      'any.required': 'userId is required',
    }),
});
