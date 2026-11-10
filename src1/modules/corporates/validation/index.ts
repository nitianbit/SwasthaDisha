import Joi from 'joi';

// Common schemas
const nameSchema = Joi.string().trim().min(1).max(200).required().messages({
  'string.empty': 'Name is required',
  'string.min': 'Name must be at least 1 character',
  'string.max': 'Name must not exceed 200 characters',
  'any.required': 'Name is required',
});

const companyNameSchema = Joi.string().trim().max(200).optional().messages({
  'string.max': 'Company name must not exceed 200 characters',
});

const emailSchema = Joi.string().email().optional().messages({
  'string.email': 'Email must be a valid email address',
});

const phoneSchema = Joi.string()
  .pattern(/^[0-9]{10}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Phone must be exactly 10 digits',
  });

const contactPersonSchema = Joi.string().trim().optional();

const addressSchema = Joi.string().trim().optional();

const citySchema = Joi.string().trim().optional();

const stateSchema = Joi.string().trim().optional();

const pincodeSchema = Joi.string().trim().optional();

const countrySchema = Joi.string().trim().optional();

const logoUrlSchema = Joi.string()
  .trim()
  .optional()
  .custom((value, helpers) => {
    if (!value) return value; // Optional field
    // Allow full URIs (http://, https://) or relative paths starting with /
    if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/')) {
      return value;
    }
    return helpers.error('string.custom', {
      message: 'Logo URL must be a valid URI (http://, https://) or a relative path starting with /',
    });
  });

const websiteSchema = Joi.string().uri().trim().optional().messages({
  'string.uri': 'Website must be a valid URI',
});

const domainSchema = Joi.string()
  .trim()
  .pattern(/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Domain must be a valid domain name (e.g., example.com)',
  });

const industrySchema = Joi.string().trim().optional();

const employeeCountSchema = Joi.number().integer().min(0).optional().messages({
  'number.base': 'Employee count must be a number',
  'number.integer': 'Employee count must be an integer',
  'number.min': 'Employee count must be at least 0',
});

const descriptionSchema = Joi.string().trim().optional();

const isActiveSchema = Joi.boolean().optional();

const isVerifiedSchema = Joi.boolean().optional();

const specialistIdsSchema = Joi.array()
  .items(
    Joi.string()
      .pattern(/^[0-9a-fA-F]{24}$/)
      .messages({
        'string.pattern.base': 'Each specialist ID must be a valid MongoDB ObjectId',
      })
  )
  .optional()
  .messages({
    'array.base': 'Specialist IDs must be an array',
  });

const wellnessPackageIdsSchema = Joi.array()
  .items(
    Joi.string()
      .pattern(/^[0-9a-fA-F]{24}$/)
      .messages({
        'string.pattern.base': 'Each wellness package ID must be a valid MongoDB ObjectId',
      })
  )
  .optional()
  .messages({
    'array.base': 'Wellness package IDs must be an array',
  });

// Create Corporate schema
export const createCorporateSchema = Joi.object({
  name: nameSchema,
  companyName: companyNameSchema,
  email: emailSchema,
  phone: phoneSchema,
  contactPerson: contactPersonSchema,
  address: addressSchema,
  city: citySchema,
  state: stateSchema,
  pincode: pincodeSchema,
  country: countrySchema,
  logoUrl: logoUrlSchema,
  website: websiteSchema,
  domain: domainSchema,
  industry: industrySchema,
  employeeCount: employeeCountSchema,
  description: descriptionSchema,
  specialistIds: specialistIdsSchema,
  wellnessPackageIds: wellnessPackageIdsSchema,
  isActive: isActiveSchema,
  isVerified: isVerifiedSchema,
});

// Update Corporate schema (all fields optional except at least one must be present)
export const updateCorporateSchema = Joi.object({
  name: nameSchema.optional(),
  companyName: companyNameSchema,
  email: emailSchema,
  phone: phoneSchema,
  contactPerson: contactPersonSchema,
  address: addressSchema,
  city: citySchema,
  state: stateSchema,
  pincode: pincodeSchema,
  country: countrySchema,
  logoUrl: logoUrlSchema,
  website: websiteSchema,
  domain: domainSchema,
  industry: industrySchema,
  employeeCount: employeeCountSchema,
  description: descriptionSchema,
  specialistIds: specialistIdsSchema,
  wellnessPackageIds: wellnessPackageIdsSchema,
  isActive: isActiveSchema,
  isVerified: isVerifiedSchema,
}).min(1).messages({
  'object.min': 'At least one field must be provided for update',
});

// Query params schema
export const corporateQuerySchema = Joi.object({
  name: Joi.string().trim().optional(),
  companyName: Joi.string().trim().optional(),
  email: Joi.string().trim().optional(),
  contactPerson: Joi.string().trim().optional(),
  industry: Joi.string().trim().optional(),
  city: Joi.string().trim().optional(),
  state: Joi.string().trim().optional(),
  country: Joi.string().trim().optional(),
  isActive: Joi.string().valid('true', 'false').optional(),
  isVerified: Joi.string().valid('true', 'false').optional(),
  search: Joi.string().trim().optional(),
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
    .valid('name', 'companyName', 'industry', 'city', 'createdAt', 'updatedAt')
    .optional()
    .messages({
      'any.only':
        'sortBy must be one of: name, companyName, industry, city, createdAt, updatedAt',
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

// Params schema for industry
export const industryParamSchema = Joi.object({
  industry: Joi.string().trim().min(1).required().messages({
    'string.empty': 'Industry is required',
    'any.required': 'Industry is required',
  }),
});
