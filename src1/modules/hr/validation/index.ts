import Joi from 'joi';

// Common schemas
const employeeIdSchema = Joi.string()
  .trim()
  .min(1)
  .max(50)
  .required()
  .messages({
    'string.empty': 'Employee ID is required',
    'string.min': 'Employee ID must be at least 1 character',
    'string.max': 'Employee ID must not exceed 50 characters',
    'any.required': 'Employee ID is required',
  });

const firstNameSchema = Joi.string().trim().min(1).max(100).required().messages({
  'string.empty': 'First name is required',
  'string.min': 'First name must be at least 1 character',
  'string.max': 'First name must not exceed 100 characters',
  'any.required': 'First name is required',
});

const lastNameSchema = Joi.string().trim().min(1).max(100).required().messages({
  'string.empty': 'Last name is required',
  'string.min': 'Last name must be at least 1 character',
  'string.max': 'Last name must not exceed 100 characters',
  'any.required': 'Last name is required',
});

const emailSchema = Joi.string().email().optional().messages({
  'string.email': 'Email must be a valid email address',
});

const phoneSchema = Joi.string()
  .pattern(/^\d{10}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Phone must be exactly 10 digits',
  });

const dateSchema = Joi.string()
  .pattern(/^\d{8}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Date must be in YYYYMMDD format (e.g., 20250215)',
  });

const genderSchema = Joi.string()
  .valid('male', 'female', 'other')
  .optional()
  .messages({
    'any.only': 'Gender must be one of: male, female, other',
  });

const employmentStatusSchema = Joi.string()
  .valid('active', 'inactive', 'terminated', 'on-leave')
  .optional()
  .messages({
    'any.only': 'Employment status must be one of: active, inactive, terminated, on-leave',
  });

const employmentTypeSchema = Joi.string()
  .valid('full-time', 'part-time', 'contract', 'intern')
  .optional()
  .messages({
    'any.only': 'Employment type must be one of: full-time, part-time, contract, intern',
  });

const corporateIdSchema = Joi.string()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Invalid corporate ID format',
  });

const profilePictureUrlSchema = Joi.string()
  .trim()
  .optional()
  .custom((value, helpers) => {
    if (!value) return value; // Optional field
    // Allow full URIs (http://, https://) or relative paths starting with /
    if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/')) {
      return value;
    }
    return helpers.error('string.custom', {
      message: 'Profile picture URL must be a valid URI (http://, https://) or a relative path starting with /',
    });
  });

const documentSchema = Joi.object({
  type: Joi.string().trim().min(1).required().messages({
    'string.empty': 'Document type is required',
    'any.required': 'Document type is required',
  }),
  url: Joi.string()
  .trim()
  .required()
  .messages({
    'any.required': 'Document URL is required',
    'string.empty': 'Document URL cannot be empty',
  }),
  fileName: Joi.string().trim().optional(),
  uploadedAt: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Upload date must be in YYYYMMDD format',
    }),
});

// Create HR schema
export const createHRSchema = Joi.object({
  employeeId: employeeIdSchema,
  userId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid user ID format',
    }),
  firstName: firstNameSchema,
  lastName: lastNameSchema,
  email: emailSchema,
  phone: phoneSchema,
  alternatePhone: phoneSchema,
  dateOfBirth: dateSchema,
  gender: genderSchema,
  address: Joi.string().trim().optional(),
  city: Joi.string().trim().optional(),
  state: Joi.string().trim().optional(),
  pincode: Joi.string().trim().optional(),
  country: Joi.string().trim().optional(),
  department: Joi.string().trim().optional(),
  designation: Joi.string().trim().optional(),
  employmentType: employmentTypeSchema,
  joiningDate: dateSchema,
  leavingDate: dateSchema,
  employmentStatus: employmentStatusSchema,
  reportingManager: Joi.string().trim().optional(),
  corporateId: corporateIdSchema,
  emergencyContactName: Joi.string().trim().optional(),
  emergencyContactPhone: phoneSchema,
  emergencyContactRelation: Joi.string().trim().optional(),
  profilePictureUrl: profilePictureUrlSchema,
  documents: Joi.array().items(documentSchema).optional(),
  isActive: Joi.boolean().optional(),
  notes: Joi.string().trim().optional(),
}).custom((value, helpers) => {
  // Validate that leavingDate >= joiningDate if both are provided
  if (value.joiningDate && value.leavingDate) {
    if (value.joiningDate.localeCompare(value.leavingDate) > 0) {
      return helpers.error('any.custom', {
        message: 'Leaving date cannot be earlier than joining date',
      });
    }
  }
  return value;
});

// Update HR schema
export const updateHRSchema = Joi.object({
  userId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid user ID format',
    }),
  firstName: firstNameSchema.optional(),
  lastName: lastNameSchema.optional(),
  email: emailSchema,
  phone: phoneSchema,
  alternatePhone: phoneSchema,
  dateOfBirth: dateSchema,
  gender: genderSchema,
  address: Joi.string().trim().optional(),
  city: Joi.string().trim().optional(),
  state: Joi.string().trim().optional(),
  pincode: Joi.string().trim().optional(),
  country: Joi.string().trim().optional(),
  department: Joi.string().trim().optional(),
  designation: Joi.string().trim().optional(),
  employmentType: employmentTypeSchema,
  joiningDate: dateSchema,
  leavingDate: dateSchema,
  employmentStatus: employmentStatusSchema,
  reportingManager: Joi.string().trim().optional(),
  corporateId: corporateIdSchema,
  emergencyContactName: Joi.string().trim().optional(),
  emergencyContactPhone: phoneSchema,
  emergencyContactRelation: Joi.string().trim().optional(),
  profilePictureUrl: profilePictureUrlSchema,
  documents: Joi.array().items(documentSchema).optional(),
  isActive: Joi.boolean().optional(),
  notes: Joi.string().trim().optional(),
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update',
  })
  .custom((value, helpers) => {
    // Validate that leavingDate >= joiningDate if both are provided
    if (value.joiningDate && value.leavingDate) {
      if (value.joiningDate.localeCompare(value.leavingDate) > 0) {
        return helpers.error('any.custom', {
          message: 'Leaving date cannot be earlier than joining date',
        });
      }
    }
    return value;
  });

// HR Query params schema
export const hrQuerySchema = Joi.object({
  employeeId: Joi.string().trim().optional(),
  firstName: Joi.string().trim().optional(),
  lastName: Joi.string().trim().optional(),
  email: Joi.string().trim().optional(),
  userId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid user ID format',
    }),
  department: Joi.string().trim().optional(),
  designation: Joi.string().trim().optional(),
  employmentType: Joi.string()
    .valid('full-time', 'part-time', 'contract', 'intern')
    .optional()
    .messages({
      'any.only': 'Employment type must be one of: full-time, part-time, contract, intern',
    }),
  employmentStatus: Joi.string()
    .valid('active', 'inactive', 'terminated', 'on-leave')
    .optional()
    .messages({
      'any.only': 'Employment status must be one of: active, inactive, terminated, on-leave',
    }),
  corporateId: corporateIdSchema,
  reportingManager: Joi.string().trim().optional(),
  isActive: Joi.string().valid('true', 'false').optional(),
  joiningDateFrom: dateSchema,
  joiningDateTo: dateSchema,
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
    .valid('employeeId', 'firstName', 'lastName', 'joiningDate', 'department', 'createdAt', 'updatedAt')
    .optional()
    .messages({
      'any.only':
        'sortBy must be one of: employeeId, firstName, lastName, joiningDate, department, createdAt, updatedAt',
    }),
  sortOrder: Joi.string().valid('asc', 'desc').optional().messages({
    'any.only': 'sortOrder must be either "asc" or "desc"',
  }),
}).custom((value, helpers) => {
  // Validate date ranges
  if (
    value.joiningDateFrom &&
    value.joiningDateTo &&
    value.joiningDateFrom.localeCompare(value.joiningDateTo) > 0
  ) {
    return helpers.error('any.custom', {
      message: 'Joining date from cannot be greater than joining date to',
    });
  }
  return value;
});

export const hrCorporateOverviewQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).optional().messages({
    'number.base': 'Limit must be a number',
    'number.integer': 'Limit must be an integer',
    'number.min': 'Limit must be at least 1',
    'number.max': 'Limit must not exceed 100',
  }),
  dateFrom: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'dateFrom must be in YYYYMMDD format',
    }),
  dateTo: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'dateTo must be in YYYYMMDD format',
    }),
}).custom((value, helpers) => {
  if (
    value.dateFrom &&
    value.dateTo &&
    value.dateFrom.localeCompare(value.dateTo) > 0
  ) {
    return helpers.error('any.custom', {
      message: 'dateFrom cannot be greater than dateTo',
    });
  }
  return value;
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

export const corporateIdParamSchema = Joi.object({
  corporateId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid corporate ID format',
      'any.required': 'corporateId is required',
    }),
});

// Params schema for employeeId
export const employeeIdParamSchema = Joi.object({
  employeeId: employeeIdSchema,
});
