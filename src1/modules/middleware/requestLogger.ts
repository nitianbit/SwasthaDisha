import type { NextFunction, Request, Response } from 'express';
import logger from '@/services/logger';

/**
 * Logs each request's method and path. r34 (§27.8.3): a join link's path is printed as `/j/:token`, never with its token
 * (Express matches `/j` in any case, so any case is redacted).
 */
export const requestLogger = (req: Request, _res: Response, next: NextFunction): void => {
  logger.info(`${req.method} ${/^\/j\//i.test(req.path) ? '/j/:token' : req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  next();
};
