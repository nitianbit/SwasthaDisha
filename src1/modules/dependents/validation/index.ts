import Joi from 'joi';

// Common schemas
const userIdSchema = Joi.string().trim().min(1).required().messages({
  'string.empty': 'User ID is required',
  'any.required': 'User ID is required',
});

const nameSchema = Joi.string().trim().min(1).max(200).required().messages({
  'string.empty': 'Name is required',
  'string.min': 'Name must be at least 1 character',
  'string.max': 'Name must not exceed 200 characters',
  'any.required': 'Name is required',
});

const relationshipSchema = Joi.string()
  .valid(
    'Me',
    'Father',
    'Mother',
    'Spouse',
    'wife',
    'Wife',
    'husband',
    'Husband',
    'Son',
    'Daughter',
    'Brother',
    'Sister',
    'Friend',
    'Grandfather',
    'Grandmother',
    'Other'
  )
  .required()
  .messages({
    'any.only':
      'Relationship must be one of: Me, Father, Mother, Spouse, wife, Wife, husband, Husband, Son, Daughter, Brother, Sister, Friend, Grandfather, Grandmother, Other',
    'any.required': 'Relationship is required',
  });

const ageSchema = Joi.number().integer().min(0).max(150).optional().messages({
  'number.base': 'Age must be a number',
  'number.integer': 'Age must be an integer',
  'number.min': 'Age must be at least 0',
  'number.max': 'Age must not exceed 150',
});

const genderSchema = Joi.string()
  .valid('Male', 'Female', 'Other')
  .optional()
  .messages({
    'any.only': 'Gender must be one of: Male, Female, Other',
  });

const phoneSchema = Joi.string()
  .pattern(/^[0-9]{10}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Phone must be exactly 10 digits',
  });

const emailSchema = Joi.string().email().optional().messages({
  'string.email': 'Email must be a valid email address',
});

const dateOfBirthSchema = Joi.string()
  .pattern(/^\d{8}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Date of birth must be in YYYYMMDD format (e.g., 19900115)',
  });

const bloodGroupSchema = Joi.string()
  .valid('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')
  .optional()
  .messages({
    'any.only':
      'Blood group must be one of: A+, A-, B+, B-, AB+, AB-, O+, O-',
  });

const addressSchema = Joi.string().trim().optional();

const isActiveSchema = Joi.boolean().optional();

// Create Dependent schema
export const createDependentSchema = Joi.object({
  userId: userIdSchema,
  name: nameSchema,
  relationship: relationshipSchema,
  age: ageSchema,
  gender: genderSchema,
  phone: phoneSchema,
  email: emailSchema,
  dateOfBirth: dateOfBirthSchema,
  bloodGroup: bloodGroupSchema,
  address: addressSchema,
  isActive: isActiveSchema,
});

// Update Dependent schema (all fields optional except at least one must be present)
export const updateDependentSchema = Joi.object({
  name: nameSchema.optional(),
  relationship: relationshipSchema.optional(),
  age: ageSchema,
  gender: genderSchema,
  phone: phoneSchema,
  email: emailSchema,
  dateOfBirth: dateOfBirthSchema,
  bloodGroup: bloodGroupSchema,
  address: addressSchema,
  isActive: isActiveSchema,
}).min(1).messages({
  'object.min': 'At least one field must be provided for update',
});

// Query params schema
export const dependentQuerySchema = Joi.object({
  userId: Joi.string().trim().optional(),
  relationship: Joi.string()
    .valid(
      'Me',
      'Father',
      'Mother',
      'Spouse',
      'wife',
      'Wife',
      'husband',
      'Husband',
      'Son',
      'Daughter',
      'Brother',
      'Sister',
      'Friend',
      'Grandfather',
      'Grandmother',
      'Other'
    )
    .optional(),
  isActive: Joi.string().valid('true', 'false').optional(),
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
    .valid('name', 'relationship', 'createdAt', 'updatedAt')
    .optional()
    .messages({
      'any.only':
        'sortBy must be one of: name, relationship, createdAt, updatedAt',
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
