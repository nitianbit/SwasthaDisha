import Joi from 'joi';

const subscriptionItemSchema = Joi.object({
  medicineId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  medicineName: Joi.string().trim().optional(),
  frequency: Joi.string().trim().optional(),
  intervalDays: Joi.number().integer().min(1).required(),
  nextRefillDate: Joi.string().pattern(/^\d{8}$/).optional(),
  reminderChannel: Joi.string().valid('sms', 'push', 'both', 'none').optional(),
});

export const createSubscriptionSchema = Joi.object({
  userId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  items: Joi.array().items(subscriptionItemSchema).min(1).required(),
});

export const updateSubscriptionSchema = Joi.object({
  intervalDays: Joi.number().integer().min(1).optional(),
  nextRefillDate: Joi.string().pattern(/^\d{8}$/).optional(),
  reminderChannel: Joi.string().valid('sms', 'push', 'both', 'none').optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

export const pauseSubscriptionSchema = Joi.object({
  pausedUntil: Joi.string().pattern(/^\d{8}$/).optional(),
});

export const idParamSchema = Joi.object({
  id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
});
