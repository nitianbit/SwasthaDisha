import Joi from 'joi';
import { labBookingSchema } from '@/modules/assisted/validation';
import { assignCollectorSchema } from '@/modules/partners/validation/labBooking';

/**
 * r12 (§24.6.2): the lab desk create — the pharmacy lab create's fields (2a) without the lab, coupon, price and payment
 * method; plus an optional slot (absent on a lab visit = a walk-in), the collector of a home collection and the price
 * fence on the lab's own total. Refusals the service owns (consent, address and slot rules) keep their own codes.
 */
const shared = (k: string) => labBookingSchema.extract(k);
export const deskBookingSchema = Joi.object({
  requestKey: shared('requestKey'),
  phone: shared('phone'),
  patient: shared('patient'),
  holderName: shared('holderName'),
  consent: shared('consent'),
  preferredLanguage: shared('preferredLanguage'),
  branchId: shared('branchId'),
  visitMode: shared('visitMode'),
  slotId: shared('slotId').optional(),
  itemIds: shared('itemIds'),
  address: shared('address'),
  collector: assignCollectorSchema.fork(['expectedVersion'], (x) => x.forbidden()),
  acceptedTotalMinor: Joi.number().integer().min(0).required(),
  notes: shared('notes'),
});
