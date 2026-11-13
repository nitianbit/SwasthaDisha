import Joi from 'joi';

export const PROFILE_SELF_FORBIDDEN_FIELDS = [
  'isActive', 'isVerified', 'isCorporateEmailVerified', 'corporateId', 'isCorporateUser',
] as const;

const emergencyContactSchema = Joi.object({
  name: Joi.string().optional(),
  phone: Joi.string().optional(),
  relationship: Joi.string().optional(),
});

export const createUserSchema = Joi.object({
  email: Joi.string().email().optional().messages({
    'string.email': 'Email must be a valid email address',
  }),
  corporateEmail: Joi.string().email().optional().messages({
    'string.email': 'Corporate email must be a valid email address',
  }),
  phone: Joi.string().optional().messages({
    'string.empty': 'Phone cannot be empty',
  }),
  userType: Joi.string().valid('user').required().messages({
    'any.only': 'User type must be user',
    'any.required': 'User type is required',
  }),
  name: Joi.string().optional(),
  profilePictureUrl: Joi.string()
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
    }),
  // User-specific fields (for regular app users)
  dateOfBirth: Joi.string().pattern(/^\d{8}$/).optional().messages({
    'string.pattern.base': 'Date of birth must be in YYYYMMDD format',
  }),
  gender: Joi.string().valid('Male', 'Female', 'Other').optional(),
  bloodGroup: Joi.string().valid('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-').optional(),
  height: Joi.number().min(0).max(300).optional(),
  weight: Joi.number().min(0).max(500).optional(),
  emergencyContact: emergencyContactSchema.optional(),
  // Address fields
  address: Joi.string().optional(),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
  city: Joi.string().optional(),
  state: Joi.string().optional(),
  pincode: Joi.string().optional(),
  country: Joi.string().optional(),
  // Corporate association
  corporateId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid corporate ID format',
    }),
  // Status fields
  isActive: Joi.boolean().optional(),
  isVerified: Joi.boolean().optional(),
  isCorporateEmailVerified: Joi.boolean().optional(),
}).or('email', 'phone').messages({
  'object.missing': 'Either email or phone must be provided',
});

export const updateUserSchema = Joi.object({
  email: Joi.string().trim().lowercase().email().optional().messages({
    'string.email': 'Email must be a valid email address',
  }),
  corporateEmail: Joi.string().email().optional().messages({
    'string.email': 'Corporate email must be a valid email address',
  }),
  phone: Joi.string().pattern(/^[0-9]{10}$/).optional().messages({
    'string.empty': 'Phone cannot be empty',
    'string.pattern.base': 'Phone must be exactly 10 digits',
  }),
  userType: Joi.string().valid('user').optional().messages({
    'any.only': 'User type must be user',
  }),
  name: Joi.string().optional(),
  profilePictureUrl: Joi.string()
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
    }),
  // User-specific fields (for regular app users)
  dateOfBirth: Joi.string().pattern(/^\d{8}$/).optional().messages({
    'string.pattern.base': 'Date of birth must be in YYYYMMDD format',
  }),
  gender: Joi.string().valid('Male', 'Female', 'Other').optional(),
  bloodGroup: Joi.string().valid('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-').optional(),
  height: Joi.number().min(0).max(300).optional(),
  weight: Joi.number().min(0).max(500).optional(),
  emergencyContact: emergencyContactSchema.optional(),
  // Address fields
  address: Joi.string().optional(),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
  city: Joi.string().optional(),
  state: Joi.string().optional(),
  pincode: Joi.string().optional(),
  country: Joi.string().optional(),
  // Corporate association
  corporateId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid corporate ID format',
    }),
  // Corporate user flag
  isCorporateUser: Joi.boolean().optional(),
  // Status fields
  isActive: Joi.boolean().optional(),
  isVerified: Joi.boolean().optional(),
  isCorporateEmailVerified: Joi.boolean().optional(),
});

export const userQuerySchema = Joi.object({
  userType: Joi.string().optional(),
  name: Joi.string().optional(),
  email: Joi.string().optional(),
  phone: Joi.string().optional(),
  corporateId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid corporate ID format',
    }),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
  sortBy: Joi.string().valid('createdAt', 'updatedAt', 'userType').optional(),
  sortOrder: Joi.string().valid('asc', 'desc').optional(),
  forUser: Joi.string().valid('true', 'false').optional(),
});

export const idParamSchema = Joi.object({
  id: Joi.string().required().messages({
    'string.empty': 'User ID is required',
    'any.required': 'User ID is required',
  }),
});
