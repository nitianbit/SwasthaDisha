import Joi from 'joi';

const orderTypes = ['in_store', 'online'];
const orderStatuses = ['placed', 'accepted', 'packed', 'ready_for_pickup', 'out_for_delivery', 'completed', 'abandoned', 'cancelled', 'rejected'];
const paymentModes = ['online_payment', 'in_store_payment', 'cash_on_delivery'];
const paymentStatuses = ['pending', 'authorized', 'paid', 'failed', 'refunded', 'partially_paid'];

const orderItemSchema = Joi.object({
  medicineId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  medicineName: Joi.string().trim().optional(),
  orderedQty: Joi.number().integer().min(1).required(),
  unitPrice: Joi.number().min(0).optional(),
  discount: Joi.number().min(0).optional(),
  freeQty: Joi.number().integer().min(0).optional(),
  recurring: Joi.boolean().optional(),
  subscriptionFrequency: Joi.string().trim().optional(),
  subscriptionIntervalDays: Joi.number().integer().min(1).optional(),
  subscriptionNextRefillDate: Joi.string().pattern(/^\d{8}$/).optional(),
  subscriptionReminderChannel: Joi.string().valid('sms', 'push', 'both', 'none').optional(),
}).custom((value, helpers) => {
  if (value.recurring && !value.subscriptionIntervalDays) {
    return helpers.error('any.invalid');
  }
  return value;
}).messages({
  'any.invalid': 'subscriptionIntervalDays is required when recurring is true',
});

export const createOrderSchema = Joi.object({
  orderType: Joi.string().valid(...orderTypes).required(),
  customerId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  buyerPharmacyId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  items: Joi.array().items(orderItemSchema).min(1).required(),
  paymentMode: Joi.string().valid(...paymentModes).required(),
  deliveryMode: Joi.string().valid('pickup', 'delivery').optional(),
  deliveryAddress: Joi.string().trim().optional(),
  isWalkIn: Joi.boolean().optional(),
  prescriptionUrls: Joi.array().items(Joi.string().trim()).optional(),
  notes: Joi.string().trim().max(1000).optional(),
  linkedConsultationId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  linkedDiagnosticOrderId: Joi.string().trim().optional(),
}).custom((value, helpers) => {
  if (value.deliveryMode === 'delivery' && !value.deliveryAddress?.trim()) {
    return helpers.error('any.invalid');
  }
  return value;
}).messages({
  'any.invalid': 'deliveryAddress is required when deliveryMode is delivery',
});

export const updateOrderSchema = Joi.object({
  orderType: Joi.string().valid(...orderTypes).optional(),
  customerId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  buyerPharmacyId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  items: Joi.array().items(orderItemSchema).min(1).optional(),
  notes: Joi.string().trim().max(1000).optional(),
  deliveryAddress: Joi.string().trim().optional(),
  paymentMode: Joi.string().valid(...paymentModes).optional(),
  deliveryMode: Joi.string().valid('pickup', 'delivery').optional(),
  isWalkIn: Joi.boolean().optional(),
  prescriptionUrls: Joi.array().items(Joi.string().trim()).optional(),
  linkedConsultationId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  linkedDiagnosticOrderId: Joi.string().trim().optional(),
}).min(1).custom((value, helpers) => {
  if (value.deliveryMode === 'delivery' && !value.deliveryAddress?.trim()) {
    return helpers.error('any.invalid');
  }
  return value;
}).messages({
  'any.invalid': 'deliveryAddress is required when deliveryMode is delivery',
});

export const updateOrderStatusSchema = Joi.object({
  status: Joi.string().valid(...orderStatuses).required(),
  notes: Joi.string().trim().max(500).optional(),
});

export const cancelOrderSchema = Joi.object({
  notes: Joi.string().trim().max(500).optional(),
});

export const markOrderPaidSchema = Joi.object({
  paymentSource: Joi.string().trim().max(100).optional(),
  paidDate: Joi.string().pattern(/^\d{8}$/).optional(),
  paidTime: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
  notes: Joi.string().trim().max(500).optional(),
});

export const orderQuerySchema = Joi.object({
  pharmacyId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  customerId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  userId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  buyerPharmacyId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  orderType: Joi.string().valid(...orderTypes).optional(),
  orderFor: Joi.string().valid('consultation', 'diagnostic').optional(),
  status: Joi.string().valid(...orderStatuses).optional(),
  paymentStatus: Joi.string().valid(...paymentStatuses).optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
});

export const idParamSchema = Joi.object({
  id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required().messages({
    'string.pattern.base': 'Invalid ID format',
  }),
});
