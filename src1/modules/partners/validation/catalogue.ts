import Joi from 'joi';

const objectIdPattern = /^[0-9a-fA-F]{24}$/;

export const createCatalogueItemSchema = Joi.object({
  /** Q10: exactly-once creation. */
  requestKey: Joi.string().pattern(/^[A-Za-z0-9_-]{8,100}$/).optional(),
  kind: Joi.string().valid('test', 'package', 'consultation', 'procedure', 'other').required(),
  name: Joi.string().trim().min(1).max(200).required(),
  code: Joi.string().trim().max(50).optional(),
  description: Joi.string().trim().max(1000).optional(),
  preparation: Joi.string().trim().max(500).optional(),
  sampleType: Joi.string().trim().max(100).optional(),
  includes: Joi.array().items(Joi.string().trim()).optional(),
  priceMinor: Joi.number().integer().min(0).max(100_000_000_00).required(),
  mrpMinor: Joi.number().integer().min(0).max(100_000_000_00).optional(),
  gstRate: Joi.number().valid(0, 5, 12, 18, 28).required(),
  sac: Joi.string().trim().max(20).optional(),
  taxTreatment: Joi.string().valid('taxable', 'exempt').optional(),
  visitModes: Joi.array().items(Joi.string().valid('home', 'lab')).optional(),
  reportTatHours: Joi.number().integer().min(0).optional(),
});

export const updateCatalogueItemSchema = Joi.object({
  /** Q10: only to convert a legacy item into a kind its partner type takes. */
  kind: Joi.string().valid('test', 'package', 'consultation', 'procedure', 'other').optional(),
  name: Joi.string().trim().min(1).max(200).optional(),
  code: Joi.string().trim().max(50).optional(),
  description: Joi.string().trim().max(1000).optional(),
  preparation: Joi.string().trim().max(500).optional(),
  sampleType: Joi.string().trim().max(100).optional(),
  includes: Joi.array().items(Joi.string().trim()).optional(),
  priceMinor: Joi.number().integer().min(0).max(100_000_000_00).optional(),
  mrpMinor: Joi.number().integer().min(0).max(100_000_000_00).optional(),
  gstRate: Joi.number().valid(0, 5, 12, 18, 28).optional(),
  sac: Joi.string().trim().max(20).optional(),
  taxTreatment: Joi.string().valid('taxable', 'exempt').optional(),
  visitModes: Joi.array().items(Joi.string().valid('home', 'lab')).optional(),
  reportTatHours: Joi.number().integer().min(0).optional(),
  /** Q10: optimistic concurrency — the item's updatedAt the editor started from (refused 409 if it changed). */
  expectedUpdatedAt: Joi.date().iso().optional(),
}).min(1);

export const catalogueListQuerySchema = Joi.object({
  kind: Joi.string().valid('test', 'package', 'consultation', 'procedure', 'other').optional(),
  includeInactive: Joi.string().valid('true', 'false').optional(),
  q: Joi.string().trim().min(1).max(60).optional(),
});

export const catalogueKeyParamSchema = Joi.object({ key: Joi.string().pattern(/^[A-Za-z0-9_-]{8,100}$/).required() });

export const catalogueItemParamSchema = Joi.object({
  itemId: Joi.string().pattern(objectIdPattern).required(),
});
