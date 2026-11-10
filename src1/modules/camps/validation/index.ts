import Joi from 'joi';

const stringArraySchema = Joi.alternatives()
  .try(
    Joi.array().items(Joi.string().trim().min(1)).min(1),
    Joi.string().trim().min(1)
  )
  .optional();

export const campListQuerySchema = Joi.object({
  startDate: Joi.string().trim().optional(),
  endDate: Joi.string().trim().optional(),
  test: Joi.boolean().truthy('true').falsy('false').optional(),
});

export const campLsIdParamSchema = Joi.object({
  campLsId: Joi.string().trim().required(),
});

export const placeCampOrderSchema = Joi.object({
  campLsId: Joi.string().trim().required(),
  orderType: Joi.string().trim().optional(),
  userId: Joi.string().trim().required(),
  corporateId: Joi.string().trim().optional(),
  appointment: Joi.string().trim().required(),
  name: Joi.string().trim().required(),
  mobile: Joi.string().trim().pattern(/^[1-9]\d{9}$/).required(),
  gender: Joi.string().trim().required(),
  packageIds: stringArraySchema,
  testIds: stringArraySchema,
  uniqueId: Joi.string().trim().optional(),
  referenceId: Joi.string().trim().optional(),
  isVip: Joi.boolean().optional(),
  labId: Joi.string().trim().optional(),
  pincode: Joi.string().trim().optional(),
  labName: Joi.string().trim().optional(),
  notes: Joi.string().trim().optional(),
  email: Joi.string().trim().email().optional(),
  dateOfBirth: Joi.string().trim().optional(),
  age: Joi.string().trim().optional(),
  altContact: Joi.string().trim().pattern(/^[1-9]\d{9}$/).optional(),
  mainUserUniqueId: Joi.string().trim().optional(),
  relationship: Joi.string().trim().optional(),
  })
  .custom((value, helpers) => {
    const packageIds = Array.isArray(value.packageIds)
      ? value.packageIds
      : value.packageIds
        ? [value.packageIds]
        : [];
    const testIds = Array.isArray(value.testIds)
      ? value.testIds
      : value.testIds
        ? [value.testIds]
        : [];

    if (!value.dateOfBirth && !value.age) {
      return helpers.error('any.custom', {
        message: 'Either dateOfBirth or age is required',
      });
    }

    return {
      ...value,
      packageIds,
      testIds,
    };
  })
  .messages({
    'any.custom': '{{#message}}',
  });
