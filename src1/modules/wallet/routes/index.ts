import 'reflect-metadata';
import { NextFunction, Response, Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { AppError } from '@/modules/common/types';
import { AuthRequest, requireAdmin } from '@/modules/middleware/auth';
import { WalletController } from '@/modules/wallet/controller';
import {
  createWalletSchema,
  updateWalletSchema,
  walletQuerySchema,
  createWalletTransactionSchema,
  initiateWalletRechargeSchema,
  walletTransactionQuerySchema,
  idParamSchema,
  userIdParamSchema,
} from '@/modules/wallet/validation';

const walletRouter = Router();

const walletController = new WalletController();

const requireOwnWalletOrAdmin = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void => {
  try {
    if (!req.user?._id) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    if (req.user.userType !== 'admin' && req.user._id !== req.params.userId) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Access to another wallet is not permitted',
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Create wallet
walletRouter.post(
  '/',
  requireAdmin,
  validate(createWalletSchema, 'body'),
  catchAsync(walletController.create)
);

// Get all wallets (with optional query params)
// Supports: ?userId=xxx&isActive=true&page=1&limit=10
walletRouter.get(
  '/',
  requireAdmin,
  validate(walletQuerySchema, 'query'),
  catchAsync(walletController.getAll)
);

// Get wallet by user ID
walletRouter.get(
  '/user/:userId',
  requireOwnWalletOrAdmin,
  validate(userIdParamSchema, 'params'),
  catchAsync(walletController.getByUserId)
);

// Get wallet by ID
walletRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(walletController.getById)
);

// Update wallet
walletRouter.put(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(updateWalletSchema, 'body'),
  catchAsync(walletController.update)
);

// Add wallet transaction (credit/debit)
walletRouter.post(
  '/recharge/initiate',
  validate(initiateWalletRechargeSchema, 'body'),
  catchAsync(walletController.initiateRecharge)
);

walletRouter.post(
  '/transactions',
  requireAdmin,
  validate(createWalletTransactionSchema, 'body'),
  catchAsync(walletController.addTransaction)
);

// Get transactions by user ID
// Supports: ?transactionType=credit&status=completed&referenceType=booking&page=1&limit=10
walletRouter.get(
  '/user/:userId/transactions',
  requireOwnWalletOrAdmin,
  validate(userIdParamSchema, 'params'),
  validate(walletTransactionQuerySchema, 'query'),
  catchAsync(walletController.getTransactions)
);

// Get transaction by ID
walletRouter.get(
  '/transactions/:id',
  validate(idParamSchema, 'params'),
  catchAsync(walletController.getTransactionById)
);

export default walletRouter;
