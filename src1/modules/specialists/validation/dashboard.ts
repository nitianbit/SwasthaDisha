import Joi from 'joi';
import { deskBookingSchema, deskPatientSchema } from '@/modules/partners/validation/clinic';
import { APPOINTMENT_SOURCES } from '@/modules/specialists/dashboard';

/** r39 (§26.23): the doctor's dashboard requests. */
const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/).messages({ 'string.pattern.base': 'Invalid id' });
const isoDate = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'Dates are YYYY-MM-DD' });
const requestKey = Joi.string().pattern(/^[A-Za-z0-9_-]{8,100}$/);

export const appointmentListQuerySchema = Joi.object({
  from: isoDate, to: isoDate, source: Joi.string().valid(...APPOINTMENT_SOURCES), clinicId: objectId, channel: Joi.string().valid('clinic', 'online'),
  mode: Joi.string().valid('video', 'call', 'chat', 'in-person'), status: Joi.string().valid('pending', 'confirmed', 'completed', 'cancelled', 'no_show'),
});

/** The clinic desk's booking body, at a clinic he consults at (`branchId`, optional, must be the slot's). */
export const doctorClinicBookingSchema = deskBookingSchema.keys({ clinicId: objectId.required(), branchId: objectId.optional() });

/** A new consultation names the patient (`customer`, optional `patient`); a follow-up names the consultation it follows. */
export const doctorConsultationSchema = Joi.object({
  slotId: objectId.required(), mode: Joi.string().valid('video', 'call', 'in-person').required(), requestKey: requestKey.required(),
  notes: Joi.string().trim().max(1000).allow('').optional(),
  customer: Joi.object({ phone: Joi.string().trim().max(20).required(), name: Joi.string().trim().max(120).optional() }),
  patient: deskPatientSchema.optional(),
  followUpOf: objectId,
}).xor('customer', 'followUpOf').without('followUpOf', ['patient']);

/** GET /me/finance: `breakdown=1` and its filter (other query keys are ignored, as before). */
export const doctorFinanceQuerySchema = Joi.object({
  /** r39b: the breakdown is computed only when asked (`breakdown=1`). */
  breakdown: Joi.boolean().truthy('1').falsy('0'),
  from: isoDate, to: isoDate, channel: Joi.string().valid('clinic', 'online', 'partner', 'referral', 'other'), clinicId: objectId,
});
