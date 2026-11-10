import Joi from 'joi';
import {
  updateSlotSchema,
  idParamSchema,
} from '@/modules/slots/validation';
import { updateSpecialistSchema } from '@/modules/specialists/validation';

const dateSchema = Joi.string()
  .pattern(/^\d{8}$/)
  .required()
  .messages({
    'string.pattern.base': 'Date must be in YYYYMMDD format (e.g., 20250215)',
    'any.required': 'Date is required',
  });

const startTimeSchema = Joi.string().trim().required().messages({
  'string.empty': 'Start time is required',
  'any.required': 'Start time is required',
});

const endTimeSchema = Joi.string().trim().required().messages({
  'string.empty': 'End time is required',
  'any.required': 'End time is required',
});

export const specialistCreateSlotSchema = Joi.object({
  date: dateSchema,
  startTime: startTimeSchema,
  endTime: endTimeSchema,
  duration: Joi.number().integer().min(1).optional(),
  isAvailable: Joi.boolean().optional(),
  maxBookings: Joi.number().integer().min(1).optional(),
  currentBookings: Joi.number().integer().min(0).optional(),
  isRecurring: Joi.boolean().optional(),
  recurringPattern: Joi.string()
    .valid('daily', 'weekly', 'monthly')
    .optional(),
  isActive: Joi.boolean().optional(),
});

export { updateSlotSchema as specialistUpdateSlotSchema, idParamSchema };
export { updateSpecialistSchema as specialistProfileUpdateSchema };

export const specialistSlotsQuerySchema = Joi.object({
  date: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Date must be in YYYYMMDD format',
    }),
});

export const specialistAppointmentsQuerySchema = Joi.object({
  view: Joi.string().valid('day', 'month', 'all').required().messages({
    'any.only': 'view must be one of: day, month, all',
    'any.required': 'view is required',
  }),
  date: Joi.when('view', {
    is: 'day',
    then: Joi.string()
      .pattern(/^\d{8}$/)
      .required()
      .messages({
        'string.pattern.base': 'date must be YYYYMMDD when view is day',
        'any.required': 'date is required when view is day',
      }),
    otherwise: Joi.string().pattern(/^\d{8}$/).optional(),
  }),
  yearMonth: Joi.when('view', {
    is: 'month',
    then: Joi.string()
      .pattern(/^\d{6}$/)
      .required()
      .messages({
        'string.pattern.base': 'yearMonth must be YYYYMM when view is month',
        'any.required': 'yearMonth is required when view is month',
      }),
    otherwise: Joi.string().pattern(/^\d{6}$/).optional(),
  }),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
}).custom((value, helpers) => {
  if (value.view === 'all') {
    const page = value.page ?? 1;
    const limit = value.limit ?? 20;
    if (page < 1 || limit < 1) {
      return helpers.error('any.custom', {
        message: 'Invalid pagination',
      });
    }
  }
  return value;
});

export const updateAppointmentStatusSchema = Joi.object({
  status: Joi.string()
    .valid('pending', 'confirmed', 'completed', 'cancelled')
    .required()
    .messages({
      'any.only':
        'status must be one of: pending, confirmed, completed, cancelled',
      'any.required': 'status is required',
    }),
});

export const specialistAppointmentPrescriptionSchema = Joi.object({
  diagnosis: Joi.string().trim().required().messages({
    'string.empty': 'diagnosis is required',
    'any.required': 'diagnosis is required',
  }),
  medicines: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().trim().required().messages({
          'string.empty': 'Medicine name is required',
          'any.required': 'Medicine name is required',
        }),
        dosage: Joi.string().trim().optional(),
        frequency: Joi.string().trim().optional(),
        instructions: Joi.string().trim().optional(),
        duration: Joi.string().trim().optional(),
      })
    )
    .default([]),
  testsAdvised: Joi.array()
    .items(Joi.string().trim().min(1))
    .default([]),
  advice: Joi.string().trim().required().messages({
    'string.empty': 'advice is required',
    'any.required': 'advice is required',
  }),
  message: Joi.string().trim().optional(),
});

export const patientUserIdParamSchema = Joi.object({
  userId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid user ID format',
      'any.required': 'User ID is required',
    }),
});
