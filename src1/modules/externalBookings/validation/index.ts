import Joi from 'joi';

const integrationSchema = Joi.string()
  .valid('labstack', 'healthians')
  .default('labstack');

export const providerTypesQuerySchema = Joi.object({
  integration: integrationSchema.optional(),
  appointmentType: Joi.string().trim().optional(),
  pincode: Joi.string().trim().optional(),
});

export const externalPackagesQuerySchema = Joi.object({
  integration: integrationSchema.optional(),
  pincode: Joi.string().trim().optional(),
  latitude: Joi.number().optional(),
  longitude: Joi.number().optional(),
})
  .custom((value, helpers) => {
    if (
      (value.latitude !== undefined && value.longitude === undefined) ||
      (value.longitude !== undefined && value.latitude === undefined)
    ) {
      return helpers.error('any.custom', {
        message: 'latitude and longitude must be provided together',
      });
    }
    return value;
  })
  .messages({
    'any.custom': '{{#message}}',
  });

export const externalPackageQuerySchema = Joi.object({
  integration: integrationSchema.optional(),
  packageId: Joi.string().trim().required(),
  pincode: Joi.string().trim().optional(),
  latitude: Joi.number().optional(),
  longitude: Joi.number().optional(),
})
  .custom((value, helpers) => {
    if (
      (value.latitude !== undefined && value.longitude === undefined) ||
      (value.longitude !== undefined && value.latitude === undefined)
    ) {
      return helpers.error('any.custom', {
        message: 'latitude and longitude must be provided together',
      });
    }
    return value;
  })
  .messages({
    'any.custom': '{{#message}}',
  });

export const externalTestsQuerySchema = Joi.object({
  integration: integrationSchema.optional(),
  id: Joi.string().trim().optional(),
  pincode: Joi.string().trim().optional(),
  latitude: Joi.number().optional(),
  longitude: Joi.number().optional(),
  search: Joi.string().trim().optional(),
})
  .custom((value, helpers) => {
    if (
      (value.latitude !== undefined && value.longitude === undefined) ||
      (value.longitude !== undefined && value.latitude === undefined)
    ) {
      return helpers.error('any.custom', {
        message: 'latitude and longitude must be provided together',
      });
    }
    return value;
  })
  .messages({
    'any.custom': '{{#message}}',
  });

export const externalTestQuerySchema = Joi.object({
  integration: integrationSchema.optional(),
  testId: Joi.string().trim().required(),
  pincode: Joi.string().trim().optional(),
  latitude: Joi.number().optional(),
  longitude: Joi.number().optional(),
})
  .custom((value, helpers) => {
    if (
      (value.latitude !== undefined && value.longitude === undefined) ||
      (value.longitude !== undefined && value.latitude === undefined)
    ) {
      return helpers.error('any.custom', {
        message: 'latitude and longitude must be provided together',
      });
    }
    return value;
  })
  .messages({
    'any.custom': '{{#message}}',
  });

export const externalLabsQuerySchema = Joi.object({
  integration: integrationSchema.optional(),
  labId: Joi.string().trim().optional(),
  pincode: Joi.string().trim().optional(),
  city: Joi.string().trim().optional(),
  search: Joi.string().trim().optional(),
});

export const externalServiceabilityQuerySchema = Joi.object({
  integration: integrationSchema.optional(),
  pincode: Joi.string().trim().optional(),
  latitude: Joi.number().optional(),
  longitude: Joi.number().optional(),
  packageIds: Joi.alternatives()
    .try(
      Joi.array().items(Joi.string().trim().min(1)).min(1),
      Joi.string().trim().min(1)
    )
    .optional(),
  testIds: Joi.alternatives()
    .try(
      Joi.array().items(Joi.string().trim().min(1)).min(1),
      Joi.string().trim().min(1)
    )
    .optional(),
})
  .custom((value, helpers) => {
    if (
      (value.latitude !== undefined && value.longitude === undefined) ||
      (value.longitude !== undefined && value.latitude === undefined)
    ) {
      return helpers.error('any.custom', {
        message: 'latitude and longitude must be provided together',
      });
    }

    const hasPincode = Boolean(value.pincode && String(value.pincode).trim());
    const hasLatLng =
      value.latitude !== undefined && value.longitude !== undefined;
    if (!hasPincode && !hasLatLng) {
      return helpers.error('any.custom', {
        message: 'Provide pincode or latitude/longitude',
      });
    }

    if (!value.packageIds && !value.testIds) {
      return helpers.error('any.custom', {
        message: 'At least one of packageIds or testIds is required',
      });
    }

    return value;
  })
  .messages({
    'any.custom': '{{#message}}',
  });

export const externalPackagePreparationsQuerySchema = Joi.object({
  integration: integrationSchema.optional(),
  packageId: Joi.string().trim().required(),
});

export const externalDiagnosticsSlotsQuerySchema = Joi.object({
  integration: integrationSchema.optional(),
  bookingDate: Joi.string()
    .pattern(/^\d{8}$/)
    .required()
    .messages({
      'string.pattern.base': 'bookingDate must be in YYYYMMDD format',
    }),
  labId: Joi.string().trim().optional(),
  pincode: Joi.string().trim().optional(),
  latitude: Joi.number().optional(),
  longitude: Joi.number().optional(),
  packageIds: Joi.alternatives()
    .try(
      Joi.array().items(Joi.string().trim().min(1)).min(1),
      Joi.string().trim().min(1)
    )
    .optional(),
  testIds: Joi.alternatives()
    .try(
      Joi.array().items(Joi.string().trim().min(1)).min(1),
      Joi.string().trim().min(1)
    )
    .optional(),
});

export const createExternalDiagnosticsBookingSchema = Joi.object({
  userId: Joi.string().trim().optional(),
  dependentId: Joi.string().trim().optional(),
  corporateId: Joi.string().trim().optional(),
  integration: integrationSchema.optional(),
  orderType: Joi.string().trim().required(),
  bookingDate: Joi.string()
    .pattern(/^\d{8}$/)
    .required()
    .messages({
      'string.pattern.base': 'bookingDate must be in YYYYMMDD format',
    }),
  bookingTime: Joi.string().trim().required(),
  patientName: Joi.string().trim().required(),
  patientEmail: Joi.string().trim().email().optional(),
  patientPhone: Joi.string().trim().optional(),
  doctorName: Joi.string().trim().optional(),
  doctor_name: Joi.string().trim().optional(),
  labName: Joi.string().trim().optional(),
  lab_name: Joi.string().trim().optional(),
  patientGender: Joi.string().trim().optional(),
  patientAge: Joi.string().trim().optional(),
  patientDateOfBirth: Joi.string()
    .trim()
    .pattern(/^\d{8}$/)
    .optional()
    .messages({
      'string.pattern.base': 'patientDateOfBirth must be in YYYYMMDD format',
    }),
  customerRelation: Joi.string().trim().optional(),
  pincode: Joi.string().trim().optional(),
  city: Joi.string().trim().optional(),
  state: Joi.string().trim().optional(),
  stateId: Joi.number().integer().optional(),
  cityId: Joi.number().integer().optional(),
  zoneId: Joi.number().integer().optional(),
  locality: Joi.string().trim().optional(),
  addressLine: Joi.string().trim().optional(),
  address: Joi.string().trim().optional(),
  labAddress: Joi.string().trim().optional(),
  lab_address: Joi.string().trim().optional(),
  landmark: Joi.string().trim().optional(),
  latitude: Joi.number().optional(),
  longitude: Joi.number().optional(),
  altEmail: Joi.string().trim().email().optional(),
  hardCopy: Joi.number().integer().valid(0).optional(),
  applicationNumber: Joi.string().trim().optional(),
  customerRemarks: Joi.string().trim().optional(),
  paymentOption: Joi.string().trim().valid('cod', 'prepaid').optional(),
  isPpmcBooking: Joi.number().integer().valid(0, 1).optional(),
  packageIds: Joi.array().items(Joi.string().trim().min(1)).optional(),
  testIds: Joi.array().items(Joi.string().trim().min(1)).optional(),
  packageNames: Joi.array().items(Joi.string().trim().min(1)).optional(),
  package_name: Joi.alternatives()
    .try(Joi.array().items(Joi.string().trim().min(1)), Joi.string().trim().min(1))
    .optional(),
  package_names: Joi.alternatives()
    .try(Joi.array().items(Joi.string().trim().min(1)), Joi.string().trim().min(1))
    .optional(),
  testNames: Joi.array().items(Joi.string().trim().min(1)).optional(),
  test_name: Joi.alternatives()
    .try(Joi.array().items(Joi.string().trim().min(1)), Joi.string().trim().min(1))
    .optional(),
  test_names: Joi.alternatives()
    .try(Joi.array().items(Joi.string().trim().min(1)), Joi.string().trim().min(1))
    .optional(),
  stmId: Joi.string().trim().optional(),
  labId: Joi.string().trim().optional(),
  notes: Joi.string().trim().optional(),
  altContact: Joi.string().trim().optional(),
  meta: Joi.object().unknown(true).optional(),
  couponCode: Joi.string().trim().uppercase().optional(),
  useWalletBalance: Joi.boolean().optional(),
})
  .custom((value, helpers) => {
    const hasPackages = Array.isArray(value.packageIds) && value.packageIds.length > 0;
    const hasTests = Array.isArray(value.testIds) && value.testIds.length > 0;
    if (!hasPackages && !hasTests) {
      return helpers.error('any.custom', {
        message: 'At least one of packageIds or testIds is required',
      });
    }
    return value;
  })
  .messages({
    'any.custom': '{{#message}}',
  });

export const externalSpecialistsQuerySchema = Joi.object({
  integration: integrationSchema.optional(),
  providerType: Joi.string().trim().required(),
  appointmentType: Joi.string().trim().required(),
  speciality: Joi.string().trim().optional(),
  subSpeciality: Joi.string().trim().optional(),
  preferredGender: Joi.string().trim().optional(),
  pincode: Joi.string().trim().optional(),
  latitude: Joi.string().trim().optional(),
  longitude: Joi.string().trim().optional(),
});

export const externalSlotsQuerySchema = Joi.object({
  integration: integrationSchema.optional(),
  providerType: Joi.string().trim().optional(),
  appointmentType: Joi.string().trim().required(),
  externalProviderId: Joi.string().trim().required(),
  bookingDate: Joi.string()
    .pattern(/^\d{8}$/)
    .required()
    .messages({
      'string.pattern.base': 'bookingDate must be in YYYYMMDD format',
    }),
  pincode: Joi.string().trim().optional(),
  latitude: Joi.string().trim().optional(),
  longitude: Joi.string().trim().optional(),
})
  .custom((value, helpers) => {
    if (
      (value.latitude !== undefined && value.longitude === undefined) ||
      (value.longitude !== undefined && value.latitude === undefined)
    ) {
      return helpers.error('any.custom', {
        message: 'latitude and longitude must be provided together',
      });
    }
    return value;
  })
  .messages({
    'any.custom': '{{#message}}',
  });

export const createExternalBookingSchema = Joi.object({
  userId: Joi.string().trim().optional(),
  dependentId: Joi.string().trim().optional(),
  corporateId: Joi.string().trim().optional(),
  integration: integrationSchema.optional(),
  providerType: Joi.string().trim().required(),
  appointmentType: Joi.string().trim().required(),
  externalProviderId: Joi.string().trim().optional(),
  bookingDate: Joi.string()
    .pattern(/^\d{8}$/)
    .required()
    .messages({
      'string.pattern.base': 'bookingDate must be in YYYYMMDD format',
    }),
  bookingTime: Joi.string().trim().optional(),
  selectedSlotTime: Joi.string().trim().required(),
  patientName: Joi.string().trim().required(),
  patientEmail: Joi.string().trim().email().optional(),
  patientPhone: Joi.string().trim().optional(),
  doctorName: Joi.string().trim().optional(),
  doctor_name: Joi.string().trim().optional(),
  labName: Joi.string().trim().optional(),
  lab_name: Joi.string().trim().optional(),
  patientGender: Joi.string().trim().optional(),
  patientDateOfBirth: Joi.string()
    .trim()
    .pattern(/^(\d{8}|\d{4}-\d{2}-\d{2})$/)
    .optional()
    .messages({
      'string.pattern.base':
        'patientDateOfBirth must be in YYYYMMDD or YYYY-MM-DD format',
    }),
  patientAge: Joi.string().trim().optional(),
  primaryConcern: Joi.string().trim().optional(),
  consultationMode: Joi.string().valid('chat', 'call', 'video', 'in-person').optional(),
  notes: Joi.string().trim().optional(),
  pincode: Joi.string().trim().optional(),
  city: Joi.string().trim().optional(),
  state: Joi.string().trim().optional(),
  addressLine: Joi.string().trim().optional(),
  address: Joi.string().trim().optional(),
  meta: Joi.object().unknown(true).optional(),
  couponCode: Joi.string().trim().uppercase().optional(),
  useWalletBalance: Joi.boolean().optional(),
});

export const externalBookingListQuerySchema = Joi.object({
  userId: Joi.string().trim().optional(),
  corporateId: Joi.string().trim().optional(),
  integration: integrationSchema.optional(),
  providerType: Joi.string().trim().optional(),
  appointmentType: Joi.string().trim().optional(),
  patientName: Joi.string().trim().optional(),
  bookingDateFrom: Joi.string().pattern(/^\d{8}$/).optional(),
  bookingDateTo: Joi.string().pattern(/^\d{8}$/).optional(),
  status: Joi.string()
    .trim()
    .valid(
      'created',
      'pending',
      'pending_payment',
      'confirmed',
      'completed',
      'cancelled',
      'rescheduled',
      'report_delivered'
    )
    .optional(),
  paymentStatus: Joi.string()
    .trim()
    .valid('pending', 'paid', 'cancelled', 'refunded')
    .optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
});

export const externalBookingIdParamSchema = Joi.object({
  id: Joi.string().trim().required(),
});

export const externalReportDocumentQuerySchema = Joi.object({
  documentId: Joi.string().trim().required(),
});

export const externalDiagnosticsReportQuerySchema = Joi.object({
  reportId: Joi.string().trim().required(),
});

export const retryExternalPaymentBodySchema = Joi.object({
  useWalletBalance: Joi.boolean().optional(),
  couponCode: Joi.string().trim().uppercase().optional(),
});

export const cancelExternalBookingSchema = Joi.object({
  cancellationReason: Joi.string().trim().optional(),
  reason: Joi.string().trim().optional(),
});

export const rescheduleExternalBookingSchema = Joi.object({
  bookingDate: Joi.string()
    .pattern(/^\d{8}$/)
    .required()
    .messages({
      'string.pattern.base': 'bookingDate must be in YYYYMMDD format',
    }),
  selectedSlotTime: Joi.string().trim().required(),
});

export const rescheduleExternalDiagnosticsBookingSchema = Joi.object({
  bookingDate: Joi.string()
    .pattern(/^\d{8}$/)
    .required()
    .messages({
      'string.pattern.base': 'bookingDate must be in YYYYMMDD format',
    }),
  bookingTime: Joi.string().trim().required(),
});
