import Joi from 'joi';

// Common schemas
const userIdSchema = Joi.string().trim().min(1).required().messages({
  'string.empty': 'User ID is required',
  'any.required': 'User ID is required',
});

const notificationTypeSchema = Joi.string()
  .valid(
    'login',
    'booking_created',
    'booking_confirmed',
    'booking_cancelled',
    'wallet_credit',
    'wallet_debit',
    'payment_success',
    'payment_failed',
    'reminder',
    'general',
    'specialist_login',
    'specialist_new_booking',
    'specialist_upcoming_appointment',
    'specialist_appointment_cancelled',
    'specialist_appointment_confirmed',
    'specialist_appointment_completed',
    'specialist_general'
  )
  .required()
  .messages({
    'any.only':
      'Notification type is invalid',
    'any.required': 'Notification type is required',
  });

const titleSchema = Joi.string().trim().min(1).max(200).required().messages({
  'string.empty': 'Title is required',
  'string.min': 'Title must be at least 1 character',
  'string.max': 'Title must not exceed 200 characters',
  'any.required': 'Title is required',
});

const messageSchema = Joi.string().trim().min(1).max(1000).required().messages({
  'string.empty': 'Message is required',
  'string.min': 'Message must be at least 1 character',
  'string.max': 'Message must not exceed 1000 characters',
  'any.required': 'Message is required',
});

const dataSchema = Joi.object().optional().messages({
  'object.base': 'Data must be an object',
});

const referenceTypeSchema = Joi.string().trim().optional();

const referenceIdSchema = Joi.string().trim().optional();

const isReadSchema = Joi.boolean().optional();

// Create Notification schema
export const createNotificationSchema = Joi.object({
  userId: userIdSchema,
  type: notificationTypeSchema,
  title: titleSchema,
  message: messageSchema,
  data: dataSchema,
  referenceType: referenceTypeSchema,
  referenceId: referenceIdSchema,
});

const objectIdSchema = Joi.string()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({ 'string.pattern.base': 'Invalid ID format' });

// Create general / broadcast notification (optional userIds, optional corporateId, or all users)
export const createGeneralNotificationSchema = Joi.object({
  userIds: Joi.array()
    .items(objectIdSchema)
    .min(1)
    .optional()
    .messages({
      'array.min': 'userIds must not be empty when provided',
    }),
  corporateId: objectIdSchema.optional(),
  type: notificationTypeSchema,
  title: titleSchema,
  message: messageSchema,
  data: dataSchema,
  referenceType: referenceTypeSchema,
  referenceId: referenceIdSchema,
});

// Update Notification schema
export const updateNotificationSchema = Joi.object({
  isRead: isReadSchema,
}).min(1).messages({
  'object.min': 'At least one field must be provided for update',
});

// Notification Query params schema
export const notificationQuerySchema = Joi.object({
  userId: Joi.string().trim().optional(),
  type: Joi.string()
    .valid(
      'login',
      'booking_created',
      'booking_confirmed',
      'booking_cancelled',
      'wallet_credit',
      'wallet_debit',
      'payment_success',
      'payment_failed',
      'reminder',
      'general',
      'specialist_login',
      'specialist_new_booking',
      'specialist_upcoming_appointment',
      'specialist_appointment_cancelled',
      'specialist_appointment_confirmed',
      'specialist_appointment_completed',
      'specialist_general'
    )
    .optional()
    .messages({
      'any.only': 'Notification type is invalid',
    }),
  isRead: Joi.string().valid('true', 'false').optional(),
  referenceType: Joi.string().trim().optional(),
  referenceId: Joi.string().trim().optional(),
  page: Joi.number().integer().min(1).optional().messages({
    'number.base': 'Page must be a number',
    'number.integer': 'Page must be an integer',
    'number.min': 'Page must be at least 1',
  }),
  limit: Joi.number().integer().min(1).max(100).optional().messages({
    'number.base': 'Limit must be a number',
    'number.integer': 'Limit must be an integer',
    'number.min': 'Limit must be at least 1',
    'number.max': 'Limit must not exceed 100',
  }),
  sortBy: Joi.string()
    .valid('type', 'isRead', 'createdAt', 'updatedAt')
    .optional()
    .messages({
      'any.only': 'sortBy must be one of: type, isRead, createdAt, updatedAt',
    }),
  sortOrder: Joi.string().valid('asc', 'desc').optional().messages({
    'any.only': 'sortOrder must be either "asc" or "desc"',
  }),
});

// Params schema for ID
export const idParamSchema = Joi.object({
  id: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid ID format',
      'any.required': 'ID is required',
    }),
});

// Params schema for userId
export const userIdParamSchema = Joi.object({
  userId: userIdSchema,
});
