import Joi from 'joi';
import { addressSchema } from '@/modules/partners/validation';

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/).messages({ 'string.pattern.base': 'Invalid id' });
const isoDate = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'Dates are YYYY-MM-DD' });

export const inviteDoctorSchema = Joi.object({
  doctorId: objectId.optional(),
  phone: Joi.string().trim().max(20).optional(),
  branchIds: Joi.array().items(objectId).max(50).default([]),
}).xor('doctorId', 'phone');

export const inviteIdParamSchema = Joi.object({ inviteId: objectId.required() });
export const invitesQuerySchema = Joi.object({ state: Joi.string().valid('pending', 'accepted', 'declined', 'revoked').optional() });

export const deskSlotsQuerySchema = Joi.object({ doctorId: objectId.required(), branchId: objectId.required(), date: isoDate.required() });

export const appointmentsQuerySchema = Joi.object({
  from: isoDate.required(), to: isoDate.required(), doctorId: objectId.optional(), branchId: objectId.optional(),
  status: Joi.string().valid('pending', 'confirmed', 'completed', 'cancelled', 'no_show').optional(),
});

export const deskBookingSchema = Joi.object({
  slotId: objectId.required(),
  customer: Joi.object({ phone: Joi.string().trim().max(20).required(), name: Joi.string().trim().max(120).optional() }).required(),
  notes: Joi.string().trim().max(1000).allow('').optional(),
  requestKey: Joi.string().pattern(/^[A-Za-z0-9_-]{8,100}$/).required(),
});

export const appointmentIdParamSchema = Joi.object({ bookingId: objectId.required() });
/** Q13: the appointment's updatedAt the desk decided on (409 BOOKING_CHANGED otherwise). */
const expectedUpdatedAt = Joi.date().iso().optional();
export const deskStepSchema = Joi.object({ expectedUpdatedAt });
export const deskCancelSchema = Joi.object({ reason: Joi.string().trim().max(500).allow('').optional(), expectedUpdatedAt });
export const deskRescheduleSchema = Joi.object({ slotId: objectId.required(), expectedUpdatedAt });
export const deskKeyParamSchema = Joi.object({ key: Joi.string().pattern(/^[A-Za-z0-9_-]{8,100}$/).required() });

export const partnerIdParamSchema = Joi.object({ partnerId: objectId.required() });

export const soloPracticeSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  legalName: Joi.string().trim().max(160).optional(),
  invoiceSeriesPrefix: Joi.string().trim().uppercase().pattern(/^[A-Z0-9]{1,6}$/).required(),
  gstin: Joi.string().trim().uppercase().pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/).optional(),
  pan: Joi.string().trim().uppercase().pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/).optional(),
  branch: Joi.object({
    name: Joi.string().trim().min(2).max(120).required(),
    phone: Joi.string().trim().pattern(/^[0-9]{10}$/).required(),
    address: addressSchema.required(),
  }).required(),
});
