import { Request, Response, NextFunction } from 'express';
import { CustomError } from '@/modules/common/types';
import logger from '@/services/logger';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';

/** PRICE_CHANGED: the three integer paise amounts, nothing else. */
const priceDetails = (d: Record<string, unknown>) => Object.fromEntries(['priceMinor', 'listMinor', 'discountMinor']
  .filter((k) => Number.isSafeInteger(d[k])).map((k) => [k, d[k]]));

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

  // Assisted booking phase 1a: a limit names itself (`limit`), and a few answers carry safe details (e.g. the current
  // price of a PRICE_CHANGED); both only when the error sets them.
  // Review: only known codes may add fields, and only these fields (never an arbitrary object an error happens to carry).
  const limit = (err as { limit?: unknown }).limit;
  const details = (err as { details?: unknown }).details;
  const extra = {
    ...(err?.code === 'ASSISTED_LIMIT_REACHED' && typeof limit === 'string' ? { limit } : {}),
    ...(err?.code === 'PRICE_CHANGED' && details && typeof details === 'object' ? { details: priceDetails(details as Record<string, unknown>) } : {}),
  };

  // O1: limits tell the client when to try again.
  const retryAfter = (err as { retryAfter?: unknown }).retryAfter;
  if (typeof retryAfter === 'number' && retryAfter > 0) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(err.status ?? 429).json({ error: err.status ?? 429, message: err.message, code: err.code, retryAfter, ...extra });
  }

  // if no status or message in error use default 500 code and message
  const statusCode = err.status ?? 500;
  const message = err.message || 'Something went wrong.';

  // returns error status code and message
  return res.status(statusCode).json({
    error: statusCode,
    message: message,
    code: err?.code,
    ...extra,
  });
};
