import Joi from 'joi';

const versionPattern = /^\d+(?:\.\d+)*$/;

const versionField = Joi.string()
  .trim()
  .pattern(versionPattern)
  .required()
  .messages({
    'string.empty': 'Version is required',
    'string.pattern.base': 'Version must be numeric and dot-separated, for example 1.0.13',
    'any.required': 'Version is required',
  });

const storeUrlField = Joi.string()
  .trim()
  .uri({ scheme: ['http', 'https'] })
  .required()
  .messages({
    'string.empty': 'Store URL is required',
    'string.uri': 'Store URL must be a valid URL',
    'any.required': 'Store URL is required',
  });

const platformConfigSchema = Joi.object({
  softUpdateVersion: versionField,
  hardUpdateVersion: versionField,
  storeUrl: storeUrlField,
});

export const updateAppVersionSettingsSchema = Joi.object({
  android: platformConfigSchema.required(),
  ios: platformConfigSchema.required(),
});
