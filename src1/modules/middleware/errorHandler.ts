import { Request, Response, NextFunction } from 'express';
import { CustomError } from '@/modules/common/types';
import logger from '@/services/logger';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';

export const errorHandler = (
  err: CustomError,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  // TODO: here add logger.error
  logger.error(err.message, {});

  if (isDuplicateKeyError(err)) {
    return res.status(409).json({
      error: 409,
      message: 'This record already exists. Please refresh and try again.',
      code: 'DUPLICATE_RESOURCE',
    });
  }

  // if no status or message in error use default 500 code and message
  const statusCode = err.status ?? 500;
  const message = err.message || 'Something went wrong.';

  // returns error status code and message
  return res.status(statusCode).json({
    error: statusCode,
    message: message,
    code: err?.code,
  });
};
