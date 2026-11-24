import Joi from 'joi';

const objectIdPattern = /^[0-9a-fA-F]{24}$/;
const phonePattern = /^(\+91|91|0)?[0-9]{10}$/;

export const createInvoiceSchema = Joi.object({
  branchId: Joi.string().pattern(objectIdPattern).required(),
  customer: Joi.object({
    name: Joi.string().trim().min(1).max(200).required(),
    phone: Joi.string().pattern(phonePattern).optional(),
    gstin: Joi.string().trim().uppercase().pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/).optional(),
    age: Joi.number().integer().min(0).max(150).optional(),
    gender: Joi.string().valid('male', 'female', 'other').optional(),
    placeOfSupply: Joi.string().pattern(/^[0-9]{2}$/).optional(),
  }).required(),
  doctorId: Joi.string().pattern(objectIdPattern).optional(),
  /** Q14: the clinic appointment (booking id) this bill is for. */
  appointmentId: Joi.string().pattern(objectIdPattern).optional(),
  /** r12 (§24.6.3): the lab desk booking this bill is for (not with appointmentId). */
  labBookingId: Joi.string().pattern(objectIdPattern).optional(),
  items: Joi.array().items(
    Joi.object({
      catalogItemId: Joi.string().pattern(objectIdPattern).optional(),
      description: Joi.string().trim().min(1).max(500).required(),
      hsn: Joi.string().trim().max(20).optional(),
      sac: Joi.string().trim().max(20).optional(),
      qty: Joi.number().integer().min(1).max(10000).required(),
      unitPriceMinor: Joi.number().integer().min(0).max(100_000_000_00).required(),
      discountMinor: Joi.number().integer().min(0).optional(),
      gstRate: Joi.number().valid(0, 5, 12, 18, 28).required(),
    })
  ).min(1).max(100).required(),
  idempotencyKey: Joi.string().trim().min(1).max(100).required(),
}).oxor('appointmentId', 'labBookingId');

const paymentMode = Joi.string().valid('cash', 'upi', 'card', 'bank', 'other');
/**
 * Q14: either `mode` (+ reference) for the whole remaining amount (as before), or `splits` — one or several methods with
 * their amounts in paise (e.g. cash 100000 + upi 200000). A part payment (less than is due) needs the partner's
 * allowPartPayments setting and a `requestKey`.
 */
export const recordPaymentSchema = Joi.object({
  mode: paymentMode.optional(),
  reference: Joi.string().trim().max(200).optional(),
  note: Joi.string().trim().max(500).optional(),
  splits: Joi.array().items(Joi.object({
    mode: paymentMode.required(),
    amountMinor: Joi.number().integer().min(1).max(100_000_000_000_00).required(),
    reference: Joi.string().trim().max(200).optional(),
  })).min(1).max(10).optional(),
  requestKey: Joi.string().pattern(/^[A-Za-z0-9_-]{8,100}$/).optional(),
  expectedLifecycleVersion: Joi.number().integer().min(0).optional(),
}).xor('mode', 'splits').oxor('reference', 'splits');

export const cancelInvoiceSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(500).required(),
  /** Q10: required when the bill was paid. */
  refund: Joi.object({
    mode: Joi.string().valid('cash', 'upi', 'card', 'bank', 'other').required(),
    reference: Joi.string().trim().max(200).optional(),
    note: Joi.string().trim().max(500).optional(),
    /** Q14: when given, it must equal the amount paid (the record always names that amount). */
    amountMinor: Joi.number().integer().min(0).optional(),
  }).optional(),
});

export const invoiceKeyParamSchema = Joi.object({ key: Joi.string().trim().min(1).max(100).required() });

export const invoiceParamSchema = Joi.object({
  invoiceId: Joi.string().pattern(objectIdPattern).required(),
});

/** Q10: a real calendar date, YYYY-MM-DD (2026-02-30 and 2026-99-99 are refused). */
const realDate = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).custom((v: string, h) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : h.error('any.invalid');
}).messages({ 'any.invalid': 'Dates must be real calendar dates (YYYY-MM-DD)', 'string.pattern.base': 'Dates are YYYY-MM-DD' });

export const invoiceQuerySchema = Joi.object({
  state: Joi.string().valid('issued', 'partly_paid', 'paid', 'cancelled').optional(),
  branchId: Joi.string().pattern(objectIdPattern).optional(),
  limit: Joi.number().integer().min(1).max(200).optional(),
  before: Joi.date().iso().optional(),
  /** Q10: exact cursor `<ms>_<id>` (preferred over `before`), dates and search. */
  cursor: Joi.string().max(64).optional(),
  from: realDate.optional(),
  to: realDate.optional(),
  q: Joi.string().trim().max(100).allow('').optional(),
  /** Q14: only the bills of this appointment. */
  appointmentId: Joi.string().pattern(objectIdPattern).optional(),
});

export const invoicePdfQuerySchema = Joi.object({
  version: Joi.number().integer().min(0).optional(),
});
