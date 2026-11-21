import Joi from 'joi';

export const createPharmacyCustomerSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200).required(),
  phone: Joi.string().pattern(/^[0-9]{10}$/).required().messages({
    'string.pattern.base': 'Phone must be exactly 10 digits',
    'any.required': 'Phone is required',
  }),
  age: Joi.number().integer().min(0).max(150).optional(),
  diseaseNotes: Joi.string().trim().max(1000).optional(),
  chronicCondition: Joi.boolean().optional(),
  recurringMedicine: Joi.boolean().optional(),
  recurringIntervalDays: Joi.number().integer().min(1).optional(),
  // S3: the partner confirms the patient agreed to be linked. Optional for now: the released pharmacy app does not send
  // it (a missing value is recorded as 'not_recorded'); `false` is refused by the service.
  consent: Joi.boolean().optional(),
});

export const updateCustomerNotesSchema = Joi.object({
  diseaseNotes: Joi.string().trim().max(1000).optional(),
  chronicCondition: Joi.boolean().optional(),
  recurringMedicine: Joi.boolean().optional(),
  recurringIntervalDays: Joi.number().integer().min(1).optional(),
  preferredFollowUpDate: Joi.string().pattern(/^\d{8}$/).optional().messages({
    'string.pattern.base': 'preferredFollowUpDate must be YYYYMMDD',
  }),
  pharmacyNotes: Joi.string().trim().max(1000).optional(),
}).min(1);

export const userIdParamSchema = Joi.object({
  userId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required().messages({
    'string.pattern.base': 'Invalid userId format',
  }),
});

/** Assisted booking (§17.4): PUT /pharmacy-customers/:id/typed-name. */
export const typedNameSchema = Joi.object({
  typedName: Joi.string().trim().min(1).max(200).required(),
});
