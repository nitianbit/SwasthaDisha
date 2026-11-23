import Joi from 'joi';
import { PHARMACY_BOOKINGS_MAX_LIMIT } from '@/modules/assisted/services/pharmacyBookings';

const calendarDay = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).custom((value: string, helpers) => {
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : helpers.error('any.invalid');
}).messages({ 'any.invalid': '{{#label}} must be a real date (YYYY-MM-DD)' });

export const pharmacyBookingQuerySchema = Joi.object({
  status: Joi.string().valid('pending', 'confirmed', 'completed', 'cancelled', 'no_show'),
  from: calendarDay,
  to: calendarDay,
  cursor: Joi.string().max(60),
  limit: Joi.number().integer().min(1).max(PHARMACY_BOOKINGS_MAX_LIMIT),
});

// ── Assisted booking phase 1a (§17.6) ──
const key = Joi.string().pattern(/^[A-Za-z0-9_-]{8,100}$/);
const mobile = Joi.string().trim().max(20);
const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);
const relation = Joi.string().valid('Father', 'Mother', 'Spouse', 'Wife', 'Husband', 'Son', 'Daughter', 'Brother', 'Sister', 'Friend',
  'Grandfather', 'Grandmother', 'Other');
const personName = Joi.string().trim().min(1).max(120);

export const lookupSchema = Joi.object({ phone: mobile.required() });

export const doctorQuerySchema = Joi.object({
  speciality: Joi.string().trim().max(100),
  mode: Joi.string().valid('video', 'call', 'in-person'),
  language: Joi.string().trim().max(40),
  date: calendarDay,
  limit: Joi.number().integer().min(1).max(100),
});

/** Stage build: one doctor's bookable slots (GET /pharmacy-assisted/doctors/:doctorId/slots). */
export const doctorSlotsParamSchema = Joi.object({ doctorId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required() });
export const doctorSlotsQuerySchema = Joi.object({
  from: calendarDay,
  days: Joi.number().integer().min(1).max(14),
  mode: Joi.string().valid('video', 'call', 'in-person'),
});

export const consultationSchema = Joi.object({
  requestKey: key.required(),
  phone: mobile.required(),
  patient: Joi.alternatives().try(
    Joi.object({ relation: Joi.string().valid('self').required(), name: personName.required() }),
    Joi.object({ dependentId: objectId.required() }),
    Joi.object({ relation: relation.required(), name: personName.required(), gender: Joi.string().valid('Male', 'Female', 'Other'), dateOfBirth: calendarDay }),
  ).required(),
  holderName: personName,
  consent: Joi.object({
    agreed: Joi.boolean().required(),
    statementVersion: Joi.string().trim().max(40).required(),
    statementLanguage: Joi.string().trim().pattern(/^[a-z]{2,3}$/).required(),
  }), // missing or not agreed: 400 CONSENT_REQUIRED from the service
  preferredLanguage: Joi.string().trim().pattern(/^[a-z]{2,3}$/).required(),
  slotId: objectId.required(),
  consultationMode: Joi.string().valid('video', 'call', 'in-person').required(),
  join: Joi.object({ on: Joi.string().valid('partner_device', 'patient_phone').required(), phone: mobile }),
  couponCode: Joi.string().trim().max(50),
  acceptedPriceMinor: Joi.number().integer().min(0).required(),
  primaryConcern: Joi.string().trim().max(500),
  notes: Joi.string().trim().max(2000),
  paymentMethod: Joi.string().valid('wallet', 'razorpay').required(),
});

export const bookerCancelSchema = Joi.object({ reason: Joi.string().trim().max(500), expectedUpdatedAt: Joi.date().iso() });
export const bookerRescheduleSchema = Joi.object({ slotId: objectId.required(), requestKey: key.required(), expectedUpdatedAt: Joi.date().iso() });
export const keyParamSchema = Joi.object({ key: key.required() });
export const idParamSchema = Joi.object({ id: objectId.required() });

export const moveSchema = Joi.object({
  toPhone: mobile.required(),
  asFamily: Joi.object({ name: personName.required(), relation: relation.required(), gender: Joi.string().valid('Male', 'Female', 'Other'),
    dateOfBirth: calendarDay }),
  holderName: personName,
  reason: Joi.string().trim().min(1).max(500).required(),
  requestKey: key.required(),
  expectedUpdatedAt: Joi.date().iso(),
});
export const dismissSchema = Joi.object({ reason: Joi.string().trim().max(500) });
export const reviewQuerySchema = Joi.object({ state: Joi.string().valid('open', 'moved', 'dismissed'), limit: Joi.number().integer().min(1).max(200) });
export const freezeSchema = Joi.object({ frozen: Joi.boolean().required(), reason: Joi.string().trim().min(1).max(500).required() });
export const notMineSchema = Joi.object({ note: Joi.string().trim().max(500) });
export const lotIdParamSchema = Joi.object({ lotId: objectId.required() });
/** A pharmacy top-up's payment record id, its Razorpay order id or its Razorpay payment id. */
export const paymentIdParamSchema = Joi.object({ paymentId: Joi.alternatives().try(objectId, Joi.string().pattern(/^pay_[A-Za-z0-9]{6,40}$/),
  Joi.string().pattern(/^order_[A-Za-z0-9_]{6,60}$/)).required() });
export const chargebackSchema = Joi.object({ reason: Joi.string().trim().min(1).max(500).required() });
/** r9: POST /admin/wallet-payments/:paymentId/close-compensated. */
export const closeCompensatedSchema = Joi.object({ reason: Joi.string().trim().min(1).max(500).required(), requestKey: key.required() });
