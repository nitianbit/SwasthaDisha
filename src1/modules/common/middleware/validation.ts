import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { AppError } from '../types';

type ValidationSource = 'body' | 'query' | 'params';

/**
 * Validation middleware factory
 * @param schema - Joi validation schema
 * @param source - Where to validate from (body, query, params)
 */
export const validate = (
  schema: Joi.Schema,
  source: ValidationSource = 'body'
) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const errorMessages = error.details.map((detail) => detail.message).join(', ');
      throw new AppError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: errorMessages,
      });
    }

    // Replace req[source] with validated and sanitized value
    req[source] = value;
    next();
  };
};
