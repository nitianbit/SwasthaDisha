import Joi from 'joi';

// Common schemas
const userIdSchema = Joi.string().trim().min(1).required().messages({
  'string.empty': 'User ID is required',
  'any.required': 'User ID is required',
});
const optionalUserIdSchema = Joi.string().trim().min(1).optional().messages({
  'string.empty': 'User ID cannot be empty',
});
const optionalPharmacyIdSchema = Joi.string()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Invalid pharmacy ID format',
  });

const dependentIdSchema = Joi.string().trim().optional();

const corporateIdSchema = Joi.string()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Invalid corporate ID format',
  });

const bookingDateSchema = Joi.string()
  .pattern(/^\d{8}$/)
  .required()
  .messages({
    'string.pattern.base': 'Booking date must be in YYYYMMDD format (e.g., 20250215)',
    'any.required': 'Booking date is required',
  });

const bookingTimeSchema = Joi.string().trim().required().messages({
  'string.empty': 'Booking time is required',
  'any.required': 'Booking time is required',
});

const serviceModeSchema = Joi.string()
  .valid('in-person', 'pickup', 'chat', 'call', 'video')
  .required()
  .messages({
    'any.only': 'Service mode must be one of: in-person, pickup, chat, call, video',
    'any.required': 'Service mode is required',
  });

const consultationModeSchema = Joi.string()
  .valid('chat', 'call', 'video', 'in-person')
  .required()
  .messages({
    'any.only': 'Consultation mode must be one of: chat, call, video, in-person',
    'any.required': 'Consultation mode is required',
  });

const serviceAddressSchema = Joi.object({
  addressLine: Joi.string().trim().min(1).required().messages({
    'string.empty': 'Address line is required',
    'any.required': 'Address line is required',
  }),
  city: Joi.string().trim().min(1).required().messages({
    'string.empty': 'City is required',
    'any.required': 'City is required',
  }),
  pincode: Joi.string().trim().min(1).required().messages({
    'string.empty': 'Pincode is required',
    'any.required': 'Pincode is required',
  }),
  state: Joi.string().trim().optional(),
}).optional();

const documentSchema = Joi.object({
  type: Joi.string()
    .valid('report', 'prescription', 'other')
    .required()
    .messages({
      'any.only': 'Document type must be one of: report, prescription, other',
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
});

const documentsSchema = Joi.array().items(documentSchema).optional().messages({
  'array.base': 'Documents must be an array',
});

const fileUrlsSchema = Joi.array()
  .items(
    Joi.string().trim().required().messages({
      'string.empty': 'File URL cannot be empty',
      'any.required': 'File URL is required',
    })
  )
  .min(1)
  .optional()
  .messages({
    'array.base': 'File URLs must be an array',
    'array.min': 'At least one file URL is required',
  });

const prescriptionSchema = Joi.object({
  fileUrls: fileUrlsSchema,
  message: Joi.string().trim().optional(),
  diagnosis: Joi.string().trim().optional(),
  advice: Joi.string().trim().optional(),
  medicines: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().trim().required().messages({
          'string.empty': 'Medicine name is required',
          'any.required': 'Medicine name is required',
        }),
        dosage: Joi.string().trim().optional(),
        frequency: Joi.string().trim().optional(),
        instructions: Joi.string().trim().optional(),
        duration: Joi.string().trim().optional(),
      })
    )
    .optional(),
  testsAdvised: Joi.array().items(Joi.string().trim().min(1)).optional(),
  prescribedAt: Joi.string().trim().optional(),
  prescribedBySpecialistId: Joi.string().trim().optional(),
  prescribedBySpecialistName: Joi.string().trim().optional(),
})
  .or('fileUrls', 'message', 'diagnosis', 'advice', 'medicines', 'testsAdvised')
  .optional()
  .messages({
    'object.missing':
      'Prescription must include at least one file URL, message, diagnosis, advice, medicines, or testsAdvised',
  });

const reportSchema = Joi.object({
  fileUrls: fileUrlsSchema,
  message: Joi.string().trim().optional(),
})
  .or('fileUrls', 'message')
  .optional()
  .messages({
    'object.missing': 'Report must include at least one file URL or message',
  });

const followUpSchema = Joi.object({
  isFollowUp: Joi.boolean().optional(),
  parentConsultationId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid parent consultation ID format',
    }),
  eligibilityExpiresAt: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Follow-up eligibility expiry must be in YYYYMMDD format',
    }),
  benefitUsed: Joi.boolean().optional(),
  completedAt: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Follow-up completion date must be in YYYYMMDD format',
    }),
})
  .custom((value, helpers) => {
    if (value.isFollowUp === true && !value.parentConsultationId) {
      return helpers.error('any.custom', {
        message: 'parentConsultationId is required when isFollowUp is true',
      });
    }

    return value;
  })
  .optional()
  .messages({
    'any.custom': '{{#message}}',
  });

const contactNoSchema = Joi.string()
  .pattern(/^\d{10}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Contact number must be exactly 10 digits',
  });

const alternateContactNoSchema = Joi.string()
  .pattern(/^\d{10}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Alternate contact number must be exactly 10 digits',
  });

const notesSchema = Joi.string().trim().optional();
const useWalletBalanceSchema = Joi.boolean().optional();

const slotIdSchema = Joi.string()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .required()
  .messages({
    'string.pattern.base': 'Invalid slot ID format',
    'any.required': 'Slot ID is required',
  });

const optionalSlotIdSchema = Joi.string()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .optional()
  .messages({
    'string.pattern.base': 'Invalid slot ID format',
  });

// Create General Booking schema
export const createBookingSchema = Joi.object({
  bookingType: Joi.string()
    .valid('package', 'consultation', 'second-opinion', 'surgery')
    .required()
    .messages({
      'any.only': 'Booking type must be one of: package, consultation, second-opinion, surgery',
      'any.required': 'Booking type is required',
    }),
  userId: optionalUserIdSchema,
  pharmacyId: optionalPharmacyIdSchema,
  dependentId: dependentIdSchema,
  corporateId: corporateIdSchema,
  wellnessPackageId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid wellness package ID format',
    }),
  packageName: Joi.string().trim().optional(),
  package_name: Joi.string().trim().optional(),
  specialistId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid specialist ID format',
    }),
  doctorName: Joi.string().trim().optional(),
  doctor_name: Joi.string().trim().optional(),
  primaryConcern: Joi.string().trim().optional(),
  consultationMode: consultationModeSchema.optional(),
  slotId: optionalSlotIdSchema,
  bookingDate: bookingDateSchema,
  bookingTime: bookingTimeSchema,
  serviceMode: serviceModeSchema.optional(),
  serviceAddress: serviceAddressSchema,
  documents: documentsSchema,
  prescription: prescriptionSchema,
  report: reportSchema,
  followUp: followUpSchema,
  contactNo: contactNoSchema,
  alternateContactNo: alternateContactNoSchema,
  couponCode: Joi.string().trim().uppercase().optional(),
  useWalletBalance: useWalletBalanceSchema,
  notes: notesSchema,
})
  .custom((value, helpers) => {
  if (value.bookingType === 'package') {
    if (!value.wellnessPackageId) {
      return helpers.error('any.custom', { message: 'Wellness package ID is required for package booking' });
    }
    if (!value.slotId) {
      return helpers.error('any.custom', { message: 'Slot ID is required for package booking' });
    }
    if (!value.serviceMode) {
      return helpers.error('any.custom', { message: 'Service mode is required for package booking' });
    }
  }

  if (value.bookingType === 'consultation' || value.bookingType === 'second-opinion') {
    if (!value.specialistId) {
      return helpers.error('any.custom', { message: 'Specialist ID is required for consultation booking' });
    }
    if (!value.primaryConcern) {
      return helpers.error('any.custom', { message: 'Primary concern is required for consultation booking' });
    }
    if (!value.consultationMode) {
      return helpers.error('any.custom', { message: 'Consultation mode is required for consultation booking' });
    }
    if (!value.slotId) {
      return helpers.error('any.custom', { message: 'Slot ID is required for consultation booking' });
    }
  }

  // Surgery bookings intentionally do not validate slotId/specialistId/wellnessPackageId.
    return value;
  })
  .messages({
    'any.custom': '{{#message}}',
  });

// Create Wellness Package Booking schema
export const createWellnessPackageBookingSchema = Joi.object({
  userId: optionalUserIdSchema,
  pharmacyId: optionalPharmacyIdSchema,
  dependentId: dependentIdSchema,
  corporateId: corporateIdSchema,
  wellnessPackageId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid wellness package ID format',
      'any.required': 'Wellness package ID is required',
    }),
  packageName: Joi.string().trim().optional(),
  package_name: Joi.string().trim().optional(),
  slotId: slotIdSchema,
  bookingDate: bookingDateSchema,
  bookingTime: bookingTimeSchema,
  serviceMode: serviceModeSchema,
  serviceAddress: serviceAddressSchema,
  documents: documentsSchema,
  prescription: prescriptionSchema,
  report: reportSchema,
  followUp: followUpSchema,
  contactNo: contactNoSchema,
  alternateContactNo: alternateContactNoSchema,
  couponCode: Joi.string().trim().uppercase().optional(),
  useWalletBalance: useWalletBalanceSchema,
  notes: notesSchema,
});

// Create Specialist Booking schema
export const createSpecialistBookingSchema = Joi.object({
  userId: optionalUserIdSchema,
  pharmacyId: optionalPharmacyIdSchema,
  dependentId: dependentIdSchema,
  corporateId: corporateIdSchema,
  specialistId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid specialist ID format',
      'any.required': 'Specialist ID is required',
    }),
  doctorName: Joi.string().trim().optional(),
  doctor_name: Joi.string().trim().optional(),
  primaryConcern: Joi.string().trim().min(1).required().messages({
    'string.empty': 'Primary concern is required',
    'any.required': 'Primary concern is required',
  }),
  consultationMode: consultationModeSchema,
  slotId: slotIdSchema,
  bookingDate: bookingDateSchema,
  bookingTime: bookingTimeSchema,
  serviceAddress: serviceAddressSchema,
  documents: documentsSchema,
  prescription: prescriptionSchema,
  report: reportSchema,
  followUp: followUpSchema,
  contactNo: contactNoSchema,
  alternateContactNo: alternateContactNoSchema,
  couponCode: Joi.string().trim().uppercase().optional(),
  useWalletBalance: useWalletBalanceSchema,
  notes: notesSchema,
});

// Update Booking schema
export const updateBookingSchema = Joi.object({
  corporateId: corporateIdSchema,
  slotId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid slot ID format',
    }),
  bookingDate: bookingDateSchema.optional(),
  bookingTime: bookingTimeSchema.optional(),
  serviceMode: serviceModeSchema.optional(),
  serviceAddress: serviceAddressSchema,
  documents: documentsSchema,
  prescription: prescriptionSchema,
  report: reportSchema,
  followUp: followUpSchema,
  primaryConcern: Joi.string().trim().optional(),
  consultationMode: consultationModeSchema.optional(),
  contactNo: contactNoSchema,
  alternateContactNo: alternateContactNoSchema,
  status: Joi.string()
    .valid('pending', 'confirmed', 'completed', 'cancelled')
    .optional()
    .messages({
      'any.only':
        'Status must be one of: pending, confirmed, completed, cancelled',
    }),
  paymentStatus: Joi.string()
    .valid('pending', 'paid', 'failed', 'refunded')
    .optional()
    .messages({
      'any.only':
        'Payment status must be one of: pending, paid, failed, refunded',
    }),
  notes: notesSchema,
  cancellationReason: Joi.string().trim().optional(),
}).min(1).messages({
  'object.min': 'At least one field must be provided for update',
});

export const cancelBookingSchema = Joi.object({
  cancellationReason: Joi.string().trim().optional(),
});

export const rescheduleBookingSchema = Joi.object({
  slotId: slotIdSchema,
  bookingDate: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Booking date must be in YYYYMMDD format (e.g., 20250215)',
    }),
  bookingTime: Joi.string().trim().optional(),
  serviceMode: serviceModeSchema.optional(),
  serviceAddress: serviceAddressSchema,
  consultationMode: consultationModeSchema.optional(),
  notes: notesSchema,
});

export const retryPaymentBodySchema = Joi.object({
  useWalletBalance: useWalletBalanceSchema,
  couponCode: Joi.string().trim().uppercase().optional(),
});

// Query params schema
export const bookingQuerySchema = Joi.object({
  userId: Joi.string().trim().optional(),
  pharmacyId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  dependentId: Joi.string().trim().optional(),
  corporateId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid corporate ID format',
    }),
  bookingType: Joi.string()
    .valid('package', 'consultation', 'second-opinion', 'surgery')
    .optional()
    .messages({
      'any.only': 'Booking type must be one of: package, consultation, second-opinion, surgery',
    }),
  wellnessPackageId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid wellness package ID format',
    }),
  specialistId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid specialist ID format',
    }),
  status: Joi.string()
    .valid('pending', 'confirmed', 'completed', 'cancelled')
    .optional()
    .messages({
      'any.only':
        'Status must be one of: pending, confirmed, completed, cancelled',
    }),
  paymentStatus: Joi.string()
    .valid('pending', 'paid', 'failed', 'refunded')
    .optional()
    .messages({
      'any.only':
        'Payment status must be one of: pending, paid, failed, refunded',
    }),
  bookingDateFrom: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Booking date from must be in YYYYMMDD format (e.g., 20250215)',
    }),
  bookingDateTo: Joi.string()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Booking date to must be in YYYYMMDD format (e.g., 20250215)',
    }),
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
      'bookingDate',
      'createdAt',
      'updatedAt',
      'price',
      'status',
      'paymentStatus'
    )
    .optional()
    .messages({
      'any.only':
        'sortBy must be one of: bookingDate, createdAt, updatedAt, price, status, paymentStatus',
    }),
  sortOrder: Joi.string().valid('asc', 'desc').optional().messages({
    'any.only': 'sortOrder must be either "asc" or "desc"',
  }),
  forUser: Joi.string().valid('true', 'false').optional(),
}).custom((value, helpers) => {
  // Validate that bookingDateFrom <= bookingDateTo if both are provided
  if (
    value.bookingDateFrom &&
    value.bookingDateTo &&
    value.bookingDateFrom.localeCompare(value.bookingDateTo) > 0
  ) {
    return helpers.error('any.custom', {
      message: 'Booking date from cannot be greater than booking date to',
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

// Params schema for userId
export const userIdParamSchema = Joi.object({
  userId: userIdSchema,
});
