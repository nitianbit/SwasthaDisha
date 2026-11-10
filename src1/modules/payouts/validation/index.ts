import Joi from 'joi';

const objectIdSchema = Joi.string()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({
    'string.pattern.base': 'Invalid ID format',
  });

const specialistBodySchema = Joi.object({
  specialist_id: objectIdSchema.optional(),
  consultant_id: objectIdSchema.optional(),
}).custom((value, helpers) => {
  if (!value.specialist_id && !value.consultant_id) {
    return helpers.error('any.custom', {
      message: 'Either specialist_id or consultant_id is required',
    });
  }
  return value;
});

export const payoutActivitySummarySchema = Joi.object({
  fromDate: Joi.number().integer().optional(),
  tillDate: Joi.number().integer().optional(),
  sortBy: Joi.string().optional(),
  sortAsc: Joi.boolean().optional(),
  isConsultant: Joi.boolean().optional(),
});

export const payoutGridQuerySchema = Joi.object({
  search: Joi.string().trim().optional(),
});

export const fetchPayoutBillingsSchema = specialistBodySchema.concat(
  Joi.object({
    year: Joi.number().integer().min(2000).max(3000).required(),
  })
);

export const calculatePayoutBillingsSchema = specialistBodySchema.concat(
  Joi.object({
    months: Joi.array()
      .items(Joi.number().integer().min(200001).max(300012))
      .min(1)
      .required(),
  })
);

export const calculatePayoutBillingsByYearSchema = specialistBodySchema.concat(
  Joi.object({
    year: Joi.number().integer().min(2000).max(3000).required(),
  })
);

export const createPayoutDisbursalSchema = specialistBodySchema.concat(
  Joi.object({
    billing_ids: Joi.array().items(objectIdSchema.required()).min(1).required(),
    disbursal_amount: Joi.number().positive().required(),
    disbursal_date: Joi.number().integer().optional(),
    extra_details: Joi.object({
      notes: Joi.string().trim().optional(),
      receipts: Joi.array().items(Joi.string().trim()).optional(),
    })
      .unknown(true)
      .optional(),
  })
);

export const payoutDisbursalHistorySchema = specialistBodySchema;

export const updatePayoutDisbursalSchema = Joi.object({
  _id: objectIdSchema.required(),
  extra_details: Joi.object().unknown(true).required(),
});

export const getPayoutInvoiceSchema = specialistBodySchema.concat(
  Joi.object({
    month: Joi.number().integer().min(200001).max(300012).required(),
  })
);

export const getPayoutReceiptSchema = Joi.object({
  disbursal_id: objectIdSchema.required(),
});

export const createAllPayoutsSchema = Joi.object({
  month: Joi.number().integer().min(200001).max(300012).required(),
});
