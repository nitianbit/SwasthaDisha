import Joi from 'joi';

const scaledResponseSchema = Joi.alternatives()
  .try(
    Joi.boolean(),
    Joi.number().integer().min(0).max(5)
  )
  .optional();

const objectIdSchema = Joi.string()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({
    'string.pattern.base': 'Invalid ID format',
  });

const profileSchema = Joi.object({
  age: Joi.number().integer().min(1).max(120).optional(),
  gender: Joi.string().valid('Male', 'Female', 'Other').optional(),
  heightCm: Joi.number().min(50).max(300).optional(),
  weightKg: Joi.number().min(10).max(500).optional(),
  city: Joi.string().trim().optional(),
  state: Joi.string().trim().optional(),
  pincode: Joi.string().trim().optional(),
}).optional();

const lifestyleSchema = Joi.object({
  smoking: scaledResponseSchema,
  alcohol: scaledResponseSchema,
  exerciseDaysPerWeek: Joi.number().integer().min(0).max(7).optional(),
  sleepHours: Joi.number().min(0).max(24).optional(),
  stressLevel: Joi.number().integer().min(0).max(5).optional(),
  waterIntakeLitres: Joi.number().min(0).max(20).optional(),
}).optional();

const medicalHistorySchema = Joi.object({
  diabetes: Joi.boolean().optional(),
  hypertension: Joi.boolean().optional(),
  thyroidDisorder: Joi.boolean().optional(),
  heartDisease: Joi.boolean().optional(),
  kidneyDisease: Joi.boolean().optional(),
  liverDisease: Joi.boolean().optional(),
  asthmaOrCopd: Joi.boolean().optional(),
  pcos: Joi.boolean().optional(),
  pregnancy: Joi.boolean().optional(),
  currentMedications: Joi.array().items(Joi.string().trim()).optional(),
}).optional();

const familyHistorySchema = Joi.object({
  diabetes: Joi.boolean().optional(),
  hypertension: Joi.boolean().optional(),
  heartDisease: Joi.boolean().optional(),
  stroke: Joi.boolean().optional(),
  thyroid: Joi.boolean().optional(),
  cancer: Joi.boolean().optional(),
  kidneyDisease: Joi.boolean().optional(),
}).optional();

const symptomsSchema = Joi.object({
  fatigue: scaledResponseSchema,
  frequentUrination: scaledResponseSchema,
  excessiveThirst: scaledResponseSchema,
  unexplainedWeightGain: scaledResponseSchema,
  unexplainedWeightLoss: scaledResponseSchema,
  chestPain: scaledResponseSchema,
  breathlessness: scaledResponseSchema,
  headache: scaledResponseSchema,
  dizziness: scaledResponseSchema,
  swelling: scaledResponseSchema,
  irregularPeriods: scaledResponseSchema,
  heavyBleeding: scaledResponseSchema,
  hairFall: scaledResponseSchema,
  constipation: scaledResponseSchema,
  digestiveIssues: scaledResponseSchema,
}).optional();

const vitalsSchema = Joi.object({
  systolicBp: Joi.number().min(50).max(300).optional(),
  diastolicBp: Joi.number().min(30).max(200).optional(),
  fastingSugar: Joi.number().min(20).max(600).optional(),
  postMealSugar: Joi.number().min(20).max(700).optional(),
  hba1c: Joi.number().min(1).max(20).optional(),
  heartRate: Joi.number().min(20).max(250).optional(),
  spo2: Joi.number().min(40).max(100).optional(),
}).optional();

export const submitHealthAssessmentSchema = Joi.object({
  dependentId: objectIdSchema.optional(),
  profile: profileSchema,
  lifestyle: lifestyleSchema,
  medicalHistory: medicalHistorySchema,
  familyHistory: familyHistorySchema,
  symptoms: symptomsSchema,
  vitals: vitalsSchema,
  concerns: Joi.array().items(Joi.string().trim()).optional(),
  goals: Joi.array().items(Joi.string().trim()).optional(),
  notes: Joi.string().trim().max(2000).optional(),
})
  .min(1)
  .messages({
    'object.min': 'At least one assessment input field must be provided',
  });

export const healthAssessmentQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
});

export const healthAssessmentIdParamSchema = Joi.object({
  id: objectIdSchema.required().messages({
    'any.required': 'ID is required',
  }),
});
