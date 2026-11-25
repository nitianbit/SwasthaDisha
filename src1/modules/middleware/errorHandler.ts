import { Request, Response, NextFunction } from 'express';
import { CustomError } from '@/modules/common/types';
import logger from '@/services/logger';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';

/** Known codes may carry these integer paise amounts, nothing else (PRICE_CHANGED; r13: WALLET_LIMIT_REACHED). */
const DETAIL_KEYS = new Map<string, string[]>([
  ['PRICE_CHANGED', ['priceMinor', 'listMinor', 'discountMinor']],
  ['WALLET_LIMIT_REACHED', ['maxBalanceMinor', 'balanceMinor', 'pendingMinor', 'allowedMinor']],
  // r17: QUOTE_CHANGED (partner instant): the quote and the coupon discount.
  ['QUOTE_CHANGED', ['quotedAmountMinor', 'discountMinor']],
  // r32 (§26.8.2): withdrawals — the smallest amount, and what can be withdrawn now.
  ['WITHDRAWAL_BELOW_MINIMUM', ['minimumMinor']],
  ['WITHDRAWAL_ABOVE_AVAILABLE', ['withdrawableNowMinor']],
  // r35 (§26.9): a referral set-off above what is owed or above the referral balance.
  ['SETOFF_ABOVE_AVAILABLE', ['receivableMinor', 'referralDueMinor']],
  // r35 (WQ29): the new quote of a withdrawal whose card fee changed since the screen was loaded.
  ['WITHDRAWAL_QUOTE_CHANGED', ['grossMinor', 'feeMinor', 'transferMinor']],
]);
/** r32: known codes may carry these times (ISO), nothing else (WITHDRAWAL_WEEKLY_LIMIT: when the next request is allowed). */
const DETAIL_TIMES = new Map<string, string[]>([['WITHDRAWAL_WEEKLY_LIMIT', ['nextAllowedAt']]]);
const paiseDetails = (keys: string[], d: Record<string, unknown>) => Object.fromEntries(keys.filter((k) => Number.isSafeInteger(d[k])).map((k) => [k, d[k]]));
const timeDetails = (keys: string[], d: Record<string, unknown>) => Object.fromEntries(keys
  .filter((k) => d[k] instanceof Date && Number.isFinite((d[k] as Date).getTime())).map((k) => [k, (d[k] as Date).toISOString()]));

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
  const detailKeys = DETAIL_KEYS.get(String(err?.code));
  const timeKeys = DETAIL_TIMES.get(String(err?.code));
  const extra = {
    ...(err?.code === 'ASSISTED_LIMIT_REACHED' && typeof limit === 'string' ? { limit } : {}),
    ...(detailKeys && details && typeof details === 'object' ? { details: paiseDetails(detailKeys, details as Record<string, unknown>) } : {}),
    ...(timeKeys && details && typeof details === 'object' ? { details: timeDetails(timeKeys, details as Record<string, unknown>) } : {}),
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
