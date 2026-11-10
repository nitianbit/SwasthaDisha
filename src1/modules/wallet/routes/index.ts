import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
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

// Create wallet
walletRouter.post(
  '/',
  validate(createWalletSchema, 'body'),
  catchAsync(walletController.create)
);

// Get all wallets (with optional query params)
// Supports: ?userId=xxx&isActive=true&page=1&limit=10
walletRouter.get(
  '/',
  validate(walletQuerySchema, 'query'),
  catchAsync(walletController.getAll)
);

// Get wallet by user ID
walletRouter.get(
  '/user/:userId',
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
  validate(createWalletTransactionSchema, 'body'),
  catchAsync(walletController.addTransaction)
);

// Get transactions by user ID
// Supports: ?transactionType=credit&status=completed&referenceType=booking&page=1&limit=10
walletRouter.get(
  '/user/:userId/transactions',
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
