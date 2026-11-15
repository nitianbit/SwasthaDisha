import Joi from 'joi';
import { ALL_PERMISSIONS } from '@/modules/partners/types';

const objectIdPattern = /^[0-9a-fA-F]{24}$/;
const phonePattern = /^[0-9]{10}$/;

export const idParamSchema = Joi.object({
  id: Joi.string().pattern(objectIdPattern).required().messages({
    'string.pattern.base': 'Invalid ID format',
    'any.required': 'ID is required',
  }),
});

export const partnerIdParamSchema = Joi.object({
  partnerId: Joi.string().pattern(objectIdPattern).required(),
});

export const partnerMemberParamSchema = Joi.object({
  partnerId: Joi.string().pattern(objectIdPattern).required(),
  memberId: Joi.string().pattern(objectIdPattern).required(),
});

export const partnerBranchParamSchema = Joi.object({
  partnerId: Joi.string().pattern(objectIdPattern).required(),
  branchId: Joi.string().pattern(objectIdPattern).required(),
});

const dayHoursSchema = Joi.object({
  open: Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).required(),
  close: Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).required(),
});

const addressSchema = Joi.object({
  line1: Joi.string().trim().required(),
  line2: Joi.string().trim().allow('').optional(),
  city: Joi.string().trim().required(),
  state: Joi.string().trim().required(),
  stateCode: Joi.string().trim().required(),
  pincode: Joi.string().trim().required(),
});

export const createPartnerSchema = Joi.object({
  kind: Joi.string().valid('lab', 'clinic').required(),
  name: Joi.string().trim().min(1).max(200).required(),
  legalName: Joi.string().trim().max(200).optional(),
  gstin: Joi.string().trim().optional(),
  pan: Joi.string().trim().optional(),
  contactPhone: Joi.string().pattern(phonePattern).required().messages({
    'string.pattern.base': 'Contact phone must be exactly 10 digits',
  }),
  contactEmail: Joi.string().email().optional(),
  taxRegime: Joi.string().valid('regular', 'composition', 'unregistered').optional(),
  invoiceSeriesPrefix: Joi.string().trim().min(1).max(6).required(),
  solo: Joi.boolean().optional(),
  firstOwner: Joi.object({
    phone: Joi.string().pattern(phonePattern).required().messages({
      'string.pattern.base': 'Owner phone must be exactly 10 digits',
    }),
    name: Joi.string().trim().min(1).max(200).required(),
  }).required(),
});

export const updatePartnerSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200).optional(),
  legalName: Joi.string().trim().max(200).optional(),
  gstin: Joi.string().trim().optional(),
  pan: Joi.string().trim().optional(),
  contactPhone: Joi.string().pattern(phonePattern).optional(),
  contactEmail: Joi.string().email().optional(),
  taxRegime: Joi.string().valid('regular', 'composition', 'unregistered').optional(),
  invoiceSeriesPrefix: Joi.string().trim().min(1).max(6).optional(),
  logo: Joi.string().trim().optional(),
}).min(1);

export const addMemberSchema = Joi.object({
  phone: Joi.string().pattern(phonePattern).required().messages({
    'string.pattern.base': 'Phone must be exactly 10 digits',
  }),
  name: Joi.string().trim().min(1).max(200).required(),
  role: Joi.string().valid('owner', 'staff').required(),
  permissions: Joi.array()
    .items(Joi.string().valid(...ALL_PERMISSIONS))
    .required(),
  branchIds: Joi.array().items(Joi.string().pattern(objectIdPattern)).optional(),
});

export const updateMemberPermissionsSchema = Joi.object({
  permissions: Joi.array()
    .items(Joi.string().valid(...ALL_PERMISSIONS))
    .required(),
});

export const createBranchSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200).required(),
  address: addressSchema.required(),
  geo: Joi.object({
    type: Joi.string().valid('Point').required(),
    coordinates: Joi.array().items(Joi.number()).length(2).required(),
  }).optional(),
  phone: Joi.string().pattern(phonePattern).required(),
  hours: Joi.object({
    mon: dayHoursSchema.optional(),
    tue: dayHoursSchema.optional(),
    wed: dayHoursSchema.optional(),
    thu: dayHoursSchema.optional(),
    fri: dayHoursSchema.optional(),
    sat: dayHoursSchema.optional(),
    sun: dayHoursSchema.optional(),
  }).optional(),
  holidays: Joi.array().items(Joi.string()).optional(),
  services: Joi.object({
    homeCollection: Joi.boolean().optional(),
    inLab: Joi.boolean().optional(),
    inClinic: Joi.boolean().optional(),
  }).optional(),
});

export const updateBranchSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200).optional(),
  address: addressSchema.optional(),
  geo: Joi.object({
    type: Joi.string().valid('Point').required(),
    coordinates: Joi.array().items(Joi.number()).length(2).required(),
  }).optional(),
  phone: Joi.string().pattern(phonePattern).optional(),
  hours: Joi.object({
    mon: dayHoursSchema.optional(),
    tue: dayHoursSchema.optional(),
    wed: dayHoursSchema.optional(),
    thu: dayHoursSchema.optional(),
    fri: dayHoursSchema.optional(),
    sat: dayHoursSchema.optional(),
    sun: dayHoursSchema.optional(),
  }).optional(),
  holidays: Joi.array().items(Joi.string()).optional(),
  services: Joi.object({
    homeCollection: Joi.boolean().optional(),
    inLab: Joi.boolean().optional(),
    inClinic: Joi.boolean().optional(),
  }).optional(),
}).min(1);

export const partnerQuerySchema = Joi.object({
  kind: Joi.string().valid('lab', 'clinic').optional(),
  verificationState: Joi.string().valid('pending', 'verified', 'suspended').optional(),
  isActive: Joi.string().valid('true', 'false').optional(),
});

export * from './catalogue';
export * from './invoice';
