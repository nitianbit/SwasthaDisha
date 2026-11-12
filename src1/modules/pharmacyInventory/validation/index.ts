import Joi from 'joi';
import { INVENTORY_QUALITY_HOLD_STATUSES } from '@/modules/pharmacyInventory/types';

const adjustmentReasons = ['purchase', 'return', 'damage', 'expiry', 'correction', 'transfer', 'other'];

const createInventoryItemBodySchema = Joi.object({
  medicineId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required().messages({
    'string.pattern.base': 'Invalid medicineId',
    'any.required': 'medicineId is required',
  }),
  quantity: Joi.number().integer().not(0).optional().messages({
    'number.base': 'quantity must be a number',
    'any.invalid': 'quantity cannot be 0',
  }),
  reorderThreshold: Joi.number().integer().min(0).optional(),
  rackLocation: Joi.string().trim().max(100).optional(),
  purchasePrice: Joi.number().min(0).optional(),
  mrp: Joi.number().min(0).optional(),
  retailPrice: Joi.number().min(0).optional(),
  wholesalePrice: Joi.number().min(0).optional(),
  batchNumber: Joi.string().trim().max(100).optional(),
  expiryDate: Joi.string().pattern(/^\d{8}$/).optional().messages({
    'string.pattern.base': 'expiryDate must be in YYYYMMDD format',
  }),
  reason: Joi.string().valid(...adjustmentReasons).optional().messages({
    'any.only': `reason must be one of: ${adjustmentReasons.join(', ')}`,
  }),
  notes: Joi.string().trim().max(500).optional(),
}).custom((value, helpers) => {
  if (value.quantity && (!value.batchNumber || !value.expiryDate)) {
    return helpers.error('any.custom', {
      message: 'batchNumber and expiryDate are required when quantity is provided',
    });
  }
  return value;
});

export const createInventoryItemSchema = Joi.object({
  items: Joi.array().items(createInventoryItemBodySchema).min(1).required().messages({
    'any.required': 'items is required',
    'array.min': 'At least one inventory item is required',
  }),
});

export const reserveReleaseSchema = Joi.object({
  quantity: Joi.number().integer().min(1).required().messages({
    'any.required': 'quantity is required',
    'number.min': 'quantity must be at least 1',
  }),
});

export const manualReserveReleaseSchema = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        medicineId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required().messages({
          'string.pattern.base': 'Invalid medicineId',
          'any.required': 'medicineId is required',
        }),
        quantity: Joi.number().integer().min(1).required().messages({
          'any.required': 'quantity is required',
          'number.min': 'quantity must be at least 1',
        }),
      })
    )
    .min(1)
    .required()
    .messages({
      'any.required': 'items is required',
      'array.min': 'At least one item is required',
    }),
  reason: Joi.string().trim().max(100).optional(),
  notes: Joi.string().trim().max(500).optional(),
});

export const inventoryQuerySchema = Joi.object({
  pharmacyId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  medicineId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  isActive: Joi.string().valid('true', 'false').optional(),
  lowStock: Joi.string().valid('true', 'false').optional(),
  search: Joi.string().trim().optional(),
  includeBatches: Joi.string().valid('true', 'false').optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
});

export const qualityWorklistQuerySchema = Joi.object({
  qualityStatus: Joi.string().valid(...INVENTORY_QUALITY_HOLD_STATUSES).optional(),
  page: Joi.number().integer().min(1).max(1000).optional(),
  limit: Joi.number().integer().min(1).max(50).optional(),
  pharmacyId: Joi.forbidden(),
});

export const idParamSchema = Joi.object({
  id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required().messages({
    'string.pattern.base': 'Invalid ID format',
    'any.required': 'ID is required',
  }),
});
