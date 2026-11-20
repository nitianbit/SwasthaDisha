import Joi from 'joi';

const REQUEST_KEY = /^[A-Za-z0-9_-]{8,100}$/;

const phoneSchema = Joi.string()
  .pattern(/^[0-9]{10}$/)
  .messages({ 'string.pattern.base': 'Phone must be exactly 10 digits' });

const openingHoursDaySchema = Joi.object({
  open: Joi.string().pattern(/^\d{2}:\d{2}$/).optional().messages({
    'string.pattern.base': 'open must be in HH:MM format',
  }),
  close: Joi.string().pattern(/^\d{2}:\d{2}$/).optional().messages({
    'string.pattern.base': 'close must be in HH:MM format',
  }),
  isClosed: Joi.boolean().optional(),
}).optional();

const openingHoursSchema = Joi.object({
  monday: openingHoursDaySchema,
  tuesday: openingHoursDaySchema,
  wednesday: openingHoursDaySchema,
  thursday: openingHoursDaySchema,
  friday: openingHoursDaySchema,
  saturday: openingHoursDaySchema,
  sunday: openingHoursDaySchema,
}).optional();

export const createPharmacySchema = Joi.object({
  name: Joi.string().trim().min(1).max(200).required().messages({
    'string.empty': 'Name is required',
    'any.required': 'Name is required',
  }),
  nickname: Joi.string().trim().max(100).optional(),
  ownerName: Joi.string().trim().max(200).optional(),
  phone: phoneSchema.required().messages({ 'any.required': 'Phone is required' }),
  email: Joi.string().email().optional().messages({ 'string.email': 'Email must be valid' }),
  address: Joi.string().trim().optional(),
  city: Joi.string().trim().optional(),
  state: Joi.string().trim().optional(),
  pincode: Joi.string().pattern(/^\d{6}$/).optional().messages({
    'string.pattern.base': 'Pincode must be 6 digits',
  }),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
  gstNumber: Joi.string().trim().max(50).optional(),
  drugLicenseNumber: Joi.string().trim().max(100).optional(),
  gstCertificateUrl: Joi.string().trim().optional(),
  drugLicenseDocumentUrl: Joi.string().trim().optional(),
  ownerIdProofUrl: Joi.string().trim().optional(),
  shopFrontPhotoUrl: Joi.string().trim().optional(),
  openingHours: openingHoursSchema,
  pickupAvailable: Joi.boolean().optional(),
  deliveryAvailable: Joi.boolean().optional(),
  isVerified: Joi.boolean().optional(),
  isActive: Joi.boolean().optional(),
  walletEnabled: Joi.boolean().optional(),
  profilePictureUrl: Joi.string().trim().optional(),
  // Q15: exactly once per (admin, key); a repeat with the same content answers with the pharmacy it made.
  requestKey: Joi.string().pattern(REQUEST_KEY).optional(),
});

/** Q15: an optional field an admin may clear by sending null or "" (phone and name stay required). */
const clearable = (s: Joi.StringSchema | Joi.NumberSchema) => s.allow(null, '').optional();

export const updatePharmacySchema = Joi.object({
  name: Joi.string().trim().min(1).max(200).optional(),
  nickname: clearable(Joi.string().trim().max(100)),
  ownerName: clearable(Joi.string().trim().max(200)),
  phone: phoneSchema.optional(),
  email: clearable(Joi.string().trim().email()),
  address: clearable(Joi.string().trim()),
  city: clearable(Joi.string().trim()),
  state: clearable(Joi.string().trim()),
  pincode: clearable(Joi.string().pattern(/^\d{6}$/)),
  latitude: Joi.number().min(-90).max(90).allow(null).optional(),
  longitude: Joi.number().min(-180).max(180).allow(null).optional(),
  gstNumber: clearable(Joi.string().trim().max(50)),
  drugLicenseNumber: clearable(Joi.string().trim().max(100)),
  gstCertificateUrl: clearable(Joi.string().trim()),
  drugLicenseDocumentUrl: clearable(Joi.string().trim()),
  ownerIdProofUrl: clearable(Joi.string().trim()),
  shopFrontPhotoUrl: clearable(Joi.string().trim()),
  openingHours: openingHoursSchema,
  pickupAvailable: Joi.boolean().optional(),
  deliveryAvailable: Joi.boolean().optional(),
  isVerified: Joi.boolean().optional(),
  isActive: Joi.boolean().optional(),
  walletEnabled: Joi.boolean().optional(),
  profilePictureUrl: clearable(Joi.string().trim()),
  // Q15: the version (updatedAt) the editor started from; a stale one is refused (409 RECORD_CHANGED). null = none.
  expectedUpdatedAt: Joi.date().iso().allow(null).optional(),
}).min(1).messages({ 'object.min': 'At least one field must be provided for update' });

/** Q15: GET /pharmacies/by-key/:key and POST .../abandon (admin). */
export const pharmacyKeyParamSchema = Joi.object({ key: Joi.string().pattern(REQUEST_KEY).required() });

export const updateMyPharmacySchema = Joi.object({
  name: Joi.string().trim().min(1).max(200).optional(),
  nickname: Joi.string().trim().max(100).optional(),
  ownerName: Joi.string().trim().max(200).optional(),
  phone: phoneSchema.optional(),
  email: Joi.string().email().optional(),
  address: Joi.string().trim().optional(),
  city: Joi.string().trim().optional(),
  state: Joi.string().trim().optional(),
  pincode: Joi.string().pattern(/^\d{6}$/).optional(),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
  gstNumber: Joi.string().trim().max(50).optional(),
  drugLicenseNumber: Joi.string().trim().max(100).optional(),
  gstCertificateUrl: Joi.string().trim().optional(),
  drugLicenseDocumentUrl: Joi.string().trim().optional(),
  ownerIdProofUrl: Joi.string().trim().optional(),
  shopFrontPhotoUrl: Joi.string().trim().optional(),
  openingHours: openingHoursSchema,
  pickupAvailable: Joi.boolean().optional(),
  deliveryAvailable: Joi.boolean().optional(),
  profilePictureUrl: Joi.string().trim().optional(),
}).min(1).messages({ 'object.min': 'At least one field must be provided for update' });

export const pharmacyQuerySchema = Joi.object({
  name: Joi.string().trim().optional(),
  // Q15 (admins only; ignored for other callers): exact canonical 10-digit phone.
  phone: Joi.string().pattern(/^[0-9]{10}$/).optional().messages({ 'string.pattern.base': 'phone must be exactly 10 digits' }),
  city: Joi.string().trim().optional(),
  state: Joi.string().trim().optional(),
  pincode: Joi.string().trim().optional(),
  isVerified: Joi.string().valid('true', 'false').optional(),
  isActive: Joi.string().valid('true', 'false').optional(),
  pickupAvailable: Joi.string().valid('true', 'false').optional(),
  deliveryAvailable: Joi.string().valid('true', 'false').optional(),
  search: Joi.string().trim().optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
  radiusKm: Joi.number().min(0.1).max(200).optional(),
  sortBy: Joi.string()
    .valid('name', 'city', 'state', 'createdAt', 'updatedAt')
    .optional(),
  sortOrder: Joi.string().valid('asc', 'desc').optional(),
}).custom((value, helpers) => {
  const hasLatitude = value.latitude !== undefined;
  const hasLongitude = value.longitude !== undefined;

  if (hasLatitude !== hasLongitude) {
    return helpers.error('any.custom', {
      message: 'latitude and longitude must be provided together',
    });
  }

  return value;
});

export const medicineAvailabilityQuerySchema = Joi.object({
  medicineId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid medicineId format',
      'any.required': 'medicineId is required',
    }),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
  radiusKm: Joi.number().min(0.1).max(200).optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
}).custom((value, helpers) => {
  const hasLatitude = value.latitude !== undefined;
  const hasLongitude = value.longitude !== undefined;

  if (hasLatitude !== hasLongitude) {
    return helpers.error('any.custom', {
      message: 'latitude and longitude must be provided together',
    });
  }

  return value;
});

export const idParamSchema = Joi.object({
  id: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid ID format',
      'any.required': 'ID is required',
    }),
});
