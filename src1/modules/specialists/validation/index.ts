import Joi from 'joi';

// Common schemas
const nameSchema = Joi.string().trim().min(1).max(200).required().messages({
  'string.empty': 'Name is required',
  'string.min': 'Name must be at least 1 character',
  'string.max': 'Name must not exceed 200 characters',
  'any.required': 'Name is required',
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

const ratingSchema = Joi.number().min(0).max(5).optional().messages({
  'number.base': 'Rating must be a number',
  'number.min': 'Rating must be at least 0',
  'number.max': 'Rating must not exceed 5',
});

const specializationSchema = Joi.string().trim().min(1).messages({
  'string.empty': 'Specialization cannot be empty',
});

const degreeSchema = Joi.string().trim().optional();

const experienceYearsSchema = Joi.number()
  .integer()
  .min(0)
  .max(100)
  .optional()
  .messages({
    'number.base': 'Experience years must be a number',
    'number.integer': 'Experience years must be an integer',
    'number.min': 'Experience years must be at least 0',
    'number.max': 'Experience years must not exceed 100',
  });

const languagesSchema = Joi.array()
  .items(Joi.string().trim())
  .optional()
  .messages({
    'array.base': 'Languages must be an array',
  });

const bioSchema = Joi.string().trim().optional();

const consultationFeeSchema = Joi.number().min(0).optional().messages({
  'number.base': 'Consultation fee must be a number',
  'number.min': 'Consultation fee must be at least 0',
});

const isConsultationFreeSchema = Joi.boolean().optional();

const emailSchema = Joi.string().email().optional().messages({
  'string.email': 'Email must be a valid email address',
});

const phoneSchema = Joi.string()
  .pattern(/^[0-9]{10}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Phone must be exactly 10 digits',
  });

const genderSchema = Joi.string()
  .valid('Male', 'Female', 'Other')
  .optional()
  .messages({
    'any.only': 'Gender must be one of: Male, Female, Other',
  });

const dateOfBirthSchema = Joi.string()
  .pattern(/^\d{8}$/)
  .optional()
  .messages({
    'string.pattern.base': 'dateOfBirth must be in YYYYMMDD format',
  });

const addressSchema = Joi.string().trim().optional();

const citySchema = Joi.string().trim().optional();

const stateSchema = Joi.string().trim().optional();

const pincodeSchema = Joi.string().trim().optional();
const medicalRegistrationNumberSchema = Joi.string().trim().max(100).optional();
const hospitalOrClinicSchema = Joi.string().trim().max(200).optional();
const specialistDocumentSchema = Joi.object({
  type: Joi.string()
    .valid(
      'medical-degree',
      'medical-registration-certificate',
      'aadhaar-or-govt-id',
      'experience-certificate',
      'other'
    )
    .required(),
  url: Joi.string()
    .trim()
    .required()
    .custom((value, helpers) => {
      if (
        value.startsWith('http://') ||
        value.startsWith('https://') ||
        value.startsWith('/')
      ) {
        return value;
      }
      return helpers.error('string.custom', {
        message:
          'Document URL must be a valid URI (http://, https://) or a relative path starting with /',
      });
    }),
  fileName: Joi.string().trim().optional(),
  uploadedAt: Joi.string().pattern(/^\d{8}$/).optional().messages({
    'string.pattern.base': 'uploadedAt must be in YYYYMMDD format',
  }),
  status: Joi.string()
    .valid('pending', 'uploaded', 'verified', 'rejected')
    .optional(),
}).optional();
const specialistAvailabilitySchema = Joi.object({
  workingDays: Joi.array()
    .items(
      Joi.string().valid(
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
        'saturday',
        'sunday'
      )
    )
    .optional(),
  slotDurationMinutes: Joi.number().integer().min(1).optional(),
  morningSlots: Joi.array().items(Joi.string().trim()).optional(),
  eveningSlots: Joi.array().items(Joi.string().trim()).optional(),
  acceptVideoConsultations: Joi.boolean().optional(),
  acceptChatConsultations: Joi.boolean().optional(),
})
  .optional()
  .min(1);

const isActiveSchema = Joi.boolean().optional();

const isVerifiedSchema = Joi.boolean().optional();
const corporateIdSchema = Joi.string()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Invalid corporate ID format',
  });

// Create Specialist schema
export const createSpecialistSchema = Joi.object({
  name: nameSchema,
  profilePictureUrl: profilePictureUrlSchema,
  rating: ratingSchema,
  specialization: specializationSchema.optional(),
  degree: degreeSchema,
  experienceYears: experienceYearsSchema,
  languages: languagesSchema,
  bio: bioSchema,
  consultationFee: consultationFeeSchema,
  isConsultationFree: isConsultationFreeSchema,
  email: emailSchema,
  phone: phoneSchema,
  gender: genderSchema,
  dateOfBirth: dateOfBirthSchema,
  address: addressSchema,
  city: citySchema,
  state: stateSchema,
  pincode: pincodeSchema,
  medicalRegistrationNumber: medicalRegistrationNumberSchema,
  hospitalOrClinic: hospitalOrClinicSchema,
  documents: Joi.array().items(specialistDocumentSchema).optional(),
  availability: specialistAvailabilitySchema,
  isActive: isActiveSchema,
  isVerified: isVerifiedSchema,
  corporate_id: corporateIdSchema,
});

// Update Specialist schema (all fields optional except at least one must be present)
export const updateSpecialistSchema = Joi.object({
  name: nameSchema.optional(),
  profilePictureUrl: profilePictureUrlSchema,
  rating: ratingSchema,
  specialization: specializationSchema.optional(),
  degree: degreeSchema,
  experienceYears: experienceYearsSchema,
  languages: languagesSchema,
  bio: bioSchema,
  consultationFee: consultationFeeSchema,
  isConsultationFree: isConsultationFreeSchema,
  email: emailSchema,
  phone: phoneSchema,
  gender: genderSchema,
  dateOfBirth: dateOfBirthSchema,
  address: addressSchema,
  city: citySchema,
  state: stateSchema,
  pincode: pincodeSchema,
  medicalRegistrationNumber: medicalRegistrationNumberSchema,
  hospitalOrClinic: hospitalOrClinicSchema,
  documents: Joi.array().items(specialistDocumentSchema).optional(),
  availability: specialistAvailabilitySchema,
  isActive: isActiveSchema,
  isVerified: isVerifiedSchema,
}).min(1).messages({
  'object.min': 'At least one field must be provided for update',
});

// Query params schema
export const specialistQuerySchema = Joi.object({
  name: Joi.string().trim().optional(),
  email: Joi.string().trim().optional(),
  specialization: Joi.string().trim().optional(),
  isActive: Joi.string().valid('true', 'false').optional(),
  isVerified: Joi.string().valid('true', 'false').optional(),
  minRating: Joi.number().min(0).max(5).optional().messages({
    'number.base': 'Min rating must be a number',
    'number.min': 'Min rating must be at least 0',
    'number.max': 'Min rating must not exceed 5',
  }),
  maxRating: Joi.number().min(0).max(5).optional().messages({
    'number.base': 'Max rating must be a number',
    'number.min': 'Max rating must be at least 0',
    'number.max': 'Max rating must not exceed 5',
  }),
  minExperience: Joi.number().integer().min(0).optional().messages({
    'number.base': 'Min experience must be a number',
    'number.integer': 'Min experience must be an integer',
    'number.min': 'Min experience must be at least 0',
  }),
  maxExperience: Joi.number().integer().min(0).optional().messages({
    'number.base': 'Max experience must be a number',
    'number.integer': 'Max experience must be an integer',
    'number.min': 'Max experience must be at least 0',
  }),
  language: Joi.string().trim().optional(),
  search: Joi.string().trim().optional(),
  city: Joi.string().trim().optional(),
  state: Joi.string().trim().optional(),
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
    .valid(
      'name',
      'rating',
      'experienceYears',
      'specialization',
      'consultationFee',
      'createdAt',
      'updatedAt'
    )
    .optional()
    .messages({
      'any.only':
        'sortBy must be one of: name, rating, experienceYears, specialization, consultationFee, createdAt, updatedAt',
    }),
  sortOrder: Joi.string().valid('asc', 'desc').optional().messages({
    'any.only': 'sortOrder must be either "asc" or "desc"',
  }),
  forUser: Joi.string().valid('true', 'false').optional(),
}).custom((value, helpers) => {
  // Validate that minRating <= maxRating if both are provided
  if (
    value.minRating !== undefined &&
    value.maxRating !== undefined &&
    value.minRating > value.maxRating
  ) {
    return helpers.error('any.custom', {
      message: 'Min rating cannot be greater than max rating',
    });
  }

  // Validate that minExperience <= maxExperience if both are provided
  if (
    value.minExperience !== undefined &&
    value.maxExperience !== undefined &&
    value.minExperience > value.maxExperience
  ) {
    return helpers.error('any.custom', {
      message: 'Min experience cannot be greater than max experience',
    });
  }

  return value;
});

export const specialistStatsQuerySchema = Joi.object({
  from: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'from must be in YYYYMMDD format',
    }),
  to: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'to must be in YYYYMMDD format',
    }),
}).custom((value, helpers) => {
  if (value.from && value.to && value.from > value.to) {
    return helpers.error('any.custom', {
      message: 'from must be less than or equal to to',
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

// Params schema for specialization
export const specializationParamSchema = Joi.object({
  specialization: Joi.string().trim().min(1).required().messages({
    'string.empty': 'Specialization is required',
    'any.required': 'Specialization is required',
  }),
});
