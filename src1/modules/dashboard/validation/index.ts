import Joi from 'joi';

export const dashboardAnalyticsQuerySchema = Joi.object({
  dateFrom: Joi.string()
    .pattern(/^\d{8}$/)
    .required()
    .messages({
      'string.pattern.base': 'dateFrom must be in YYYYMMDD format',
      'any.required': 'dateFrom is required',
    }),
  dateTo: Joi.string()
    .pattern(/^\d{8}$/)
    .required()
    .messages({
      'string.pattern.base': 'dateTo must be in YYYYMMDD format',
      'any.required': 'dateTo is required',
    }),
}).custom((value, helpers) => {
  if (value.dateFrom.localeCompare(value.dateTo) > 0) {
    return helpers.error('any.custom', {
      message: 'dateFrom cannot be greater than dateTo',
    });
  }

  return value;
}).messages({
  'any.custom': '{{#message}}',
});
