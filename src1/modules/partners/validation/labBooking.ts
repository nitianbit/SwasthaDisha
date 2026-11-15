import Joi from 'joi';

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);
const date = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/);
const visitMode = Joi.string().valid('home', 'lab');
const window = Joi.object({ start: hhmm.required(), end: hhmm.required() });
const day = Joi.array().items(window).max(12);

export const slotTemplateSchema = Joi.object({
  slotMinutes: Joi.number().integer().min(5).max(480).required(),
  capacity: Joi.number().integer().min(1).max(500).required(),
  days: Joi.object({ mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day }).required(),
});
export const slotTemplateParamSchema = Joi.object({ branchId: objectId.required(), visitMode: visitMode.required() });
export const manualSlotSchema = Joi.object({
  branchId: objectId.required(), visitMode: visitMode.required(), date: date.required(),
  startTime: hhmm.required(), endTime: hhmm.required(), capacity: Joi.number().integer().min(1).max(500).required(),
});
export const slotIdParamSchema = Joi.object({ slotId: objectId.required() });
export const slotCapacitySchema = Joi.object({ capacity: Joi.number().integer().min(0).max(500).required() });
export const partnerSlotsQuerySchema = Joi.object({ branchId: objectId.required(), visitMode: visitMode.required(), from: date.required(), to: date.required() });

export const labBookingIdParamSchema = Joi.object({ bookingId: objectId.required() });
export const partnerLabBookingQuerySchema = Joi.object({
  status: Joi.string().valid('pending_payment', 'confirmed', 'sample_collected', 'visited', 'processing', 'report_ready', 'completed', 'cancelled', 'no_show'),
  branchId: objectId, from: date, to: date, limit: Joi.number().integer().min(1).max(500),
});
export const assignCollectorSchema = Joi.object({
  memberId: objectId, name: Joi.string().trim().min(1).max(120).required(), phone: Joi.string().pattern(/^[0-9]{10}$/),
});
export const rejectSchema = Joi.object({ reason: Joi.string().trim().min(3).max(500).required() });
export const labRescheduleSchema = Joi.object({ slotId: objectId.required(), reason: Joi.string().trim().min(3).max(500).required() });
export const uploadReportsSchema = Joi.object({ files: Joi.array().items(Joi.string().trim().max(500)).min(1).max(10).required() });
export const releaseReportSchema = Joi.object({ file: Joi.string().trim().max(500).required(), signerMemberId: objectId });

export const createLabBookingSchema = Joi.object({
  partnerId: objectId.required(),
  branchId: objectId.required(),
  visitMode: visitMode.required(),
  slotId: objectId.required(),
  itemIds: Joi.array().items(objectId).min(1).max(20).unique().required(),
  patient: Joi.object({
    kind: Joi.string().valid('self', 'dependent').required(),
    dependentId: objectId.when('kind', { is: 'dependent', then: Joi.required(), otherwise: Joi.forbidden() }),
  }).required(),
  address: Joi.object({
    line1: Joi.string().trim().min(3).max(200).required(), line2: Joi.string().trim().max(200).allow(''),
    city: Joi.string().trim().min(2).max(80).required(), state: Joi.string().trim().max(80),
    pincode: Joi.string().pattern(/^[1-9][0-9]{5}$/).required(), landmark: Joi.string().trim().max(120).allow(''),
  }).when('visitMode', { is: 'home', then: Joi.required(), otherwise: Joi.forbidden() }),
  couponCode: Joi.string().trim().max(40),
  useWalletBalance: Joi.boolean(),
  requestKey: Joi.string().pattern(/^[A-Za-z0-9_-]{8,64}$/).required(),
});
export const payAgainSchema = Joi.object({ useWalletBalance: Joi.boolean() });
export const customerCancelSchema = Joi.object({ note: Joi.string().trim().max(500) });
export const acceptRescheduleSchema = Joi.object({ version: Joi.number().integer().min(1).required() });
export const labsQuerySchema = Joi.object({ city: Joi.string().trim().max(80), pincode: Joi.string().pattern(/^[1-9][0-9]{5}$/), visitMode });
export const labCatalogueParamSchema = Joi.object({ partnerId: objectId.required() });
export const labCatalogueQuerySchema = Joi.object({ visitMode });
export const branchSlotsParamSchema = Joi.object({ branchId: objectId.required() });
export const branchSlotsQuerySchema = Joi.object({ visitMode: visitMode.required(), from: date, days: Joi.number().integer().min(1).max(30) });
