import Joi from 'joi';

const objectIdPattern = /^[0-9a-fA-F]{24}$/;
const phonePattern = /^[0-9]{10}$/;

export const createInvoiceSchema = Joi.object({
  branchId: Joi.string().pattern(objectIdPattern).optional(),
  customer: Joi.object({
    name: Joi.string().trim().min(1).max(200).required(),
    phone: Joi.string().pattern(phonePattern).optional(),
    gstin: Joi.string().trim().optional(),
    age: Joi.number().integer().min(0).max(150).optional(),
    gender: Joi.string().valid('male', 'female', 'other').optional(),
    placeOfSupply: Joi.string().trim().max(5).optional(),
  }).required(),
  doctorId: Joi.string().pattern(objectIdPattern).optional(),
  items: Joi.array().items(
    Joi.object({
      catalogItemId: Joi.string().pattern(objectIdPattern).optional(),
      description: Joi.string().trim().min(1).max(500).required(),
      hsn: Joi.string().trim().max(20).optional(),
      sac: Joi.string().trim().max(20).optional(),
      qty: Joi.number().integer().min(1).required(),
      unitPriceMinor: Joi.number().integer().min(0).required(),
      discountMinor: Joi.number().integer().min(0).optional(),
      gstRate: Joi.number().valid(0, 5, 12, 18, 28).required(),
    })
  ).min(1).required(),
  idempotencyKey: Joi.string().trim().min(1).max(100).required(),
});

export const recordPaymentSchema = Joi.object({
  mode: Joi.string().valid('cash', 'upi', 'card', 'bank', 'other').required(),
  reference: Joi.string().trim().max(200).optional(),
  note: Joi.string().trim().max(500).optional(),
});

export const cancelInvoiceSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(500).required(),
});

export const invoiceParamSchema = Joi.object({
  invoiceId: Joi.string().pattern(objectIdPattern).required(),
});

export const invoiceQuerySchema = Joi.object({
  state: Joi.string().valid('issued', 'paid', 'cancelled').optional(),
});
