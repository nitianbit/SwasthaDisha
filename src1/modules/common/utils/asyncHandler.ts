import { Request, Response, NextFunction } from 'express';
import logger from '@/services/logger';

// For controller methods
export const catchAsync = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
};

// For functions
export const wrapAsync = <T extends (...args: any[]) => Promise<any>>(
  fn: T
): T => {
  return ((...args: any[]) => {
    return fn(...args).catch((err: any) => {
      // Centralized error handling
      logger.error(`Async error: ${err.message}`, { code: err.code });
      throw err;
    });
  }) as T;
};
