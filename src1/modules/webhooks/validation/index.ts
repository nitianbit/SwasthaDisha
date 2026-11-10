import Joi from 'joi';

const objectWithUnknowns = Joi.object().unknown(true);
const identifierKeys = [
  'appointmentId',
  'orderId',
  'externalBookingId',
  'referenceId',
  'bookingId',
  'id',
] as const;
const statusKeys = [
  'appointmentStatus',
  'orderStatus',
  'bookingStatus',
  'status',
  'event',
  'eventType',
  'action',
  'type',
] as const;

const hasRecognizableWebhookField = (value: unknown): boolean => {
  const visited = new Set<unknown>();

  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') {
      return false;
    }
    if (visited.has(node)) {
      return false;
    }
    visited.add(node);

    if (Array.isArray(node)) {
      return node.some((item) => walk(item));
    }

    const record = node as Record<string, unknown>;
    const hasKnownField = [...identifierKeys, ...statusKeys].some((key) =>
      Object.prototype.hasOwnProperty.call(record, key)
    );

    if (hasKnownField) {
      return true;
    }

    return Object.values(record).some((item) => walk(item));
  };

  return walk(value);
};

const nullableStringOrNumber = Joi.alternatives().try(
  Joi.string().trim().allow(''),
  Joi.number(),
  Joi.valid(null)
);
const nullableTrimmedString = Joi.alternatives().try(
  Joi.string().trim().allow(''),
  Joi.valid(null)
);

export const labstackBookingStatusWebhookSchema = Joi.object({
  appointmentId: nullableStringOrNumber,
  orderId: nullableStringOrNumber,
  externalBookingId: nullableStringOrNumber,
  appointmentStatus: nullableTrimmedString,
  orderStatus: nullableTrimmedString,
  bookingStatus: nullableTrimmedString,
  status: nullableTrimmedString,
  event: nullableTrimmedString,
  eventType: nullableTrimmedString,
  action: nullableTrimmedString,
  type: nullableTrimmedString,
  appointmentType: nullableTrimmedString,
  appointmentDate: nullableTrimmedString,
  appointmentTime: nullableTrimmedString,
  bookingDate: nullableTrimmedString,
  bookingTime: nullableTrimmedString,
  referenceId: nullableStringOrNumber,
  cancellationReason: nullableTrimmedString,
  reason: nullableTrimmedString,
  providerDetails: objectWithUnknowns,
  patientDetails: objectWithUnknowns,
  documents: Joi.array().items(objectWithUnknowns),
  data: objectWithUnknowns,
  appointment: Joi.alternatives().try(
    Joi.string().trim().allow(''),
    objectWithUnknowns,
    Joi.valid(null)
  ),
  order: objectWithUnknowns,
})
  .unknown(true)
  .custom((value, helpers) => {
    if (!hasRecognizableWebhookField(value)) {
      return helpers.error('any.invalid');
    }
    return value;
  }, 'LabStack webhook payload validation')
  .messages({
    'any.invalid':
      'Webhook payload must include at least one recognizable webhook identifier or status field',
  });
