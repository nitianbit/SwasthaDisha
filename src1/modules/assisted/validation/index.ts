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
