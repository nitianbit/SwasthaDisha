import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { WalletService } from '@/modules/wallet/services';
import { AuthRequest } from '@/modules/middleware/auth';
import {
  CreateWalletRequest,
  UpdateWalletRequest,
  CreateWalletTransactionRequest,
  InitiateWalletRechargeRequest,
  WalletQueryParams,
  WalletTransactionQueryParams,
} from '@/modules/wallet/types';

export class WalletController {
  private walletService: WalletService;

  constructor() {
    this.walletService = Container.get(WalletService);
  }

  create = async (req: Request, res: Response, _next: NextFunction) => {
    const data: CreateWalletRequest = req.body;
    const result = await this.walletService.create(data);

    res.status(201).json({
      success: true,
      message: 'Wallet created successfully',
      data: result,
    });
  };

  getByUserId = async (req: Request, res: Response, _next: NextFunction) => {
    const { userId } = req.params;
    const result = await this.walletService.getByUserId(userId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getById = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.walletService.getById(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAll = async (req: Request, res: Response, _next: NextFunction) => {
    const queryParams: WalletQueryParams = {
      userId: req.query.userId as string,
      isActive:
        req.query.isActive !== undefined
          ? req.query.isActive === 'true'
          : undefined,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      limit: req.query.limit
        ? parseInt(req.query.limit as string)
        : undefined,
      sortBy: req.query.sortBy as string,
      sortOrder: req.query.sortOrder as 'asc' | 'desc',
    };

    const result = await this.walletService.getAll(queryParams);

    if (result.total !== undefined) {
      res.status(200).json({
        success: true,
        data: result.data,
        pagination: {
          page: result.page!,
          limit: queryParams.limit!,
          total: result.total,
          totalPages: result.totalPages!,
        },
      });
    } else {
      res.status(200).json({
        success: true,
        data: result.data,
      });
    }
  };

  update = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const data: UpdateWalletRequest = req.body;
    const result = await this.walletService.update(id, data);

    res.status(200).json({
      success: true,
      message: 'Wallet updated successfully',
      data: result,
    });
  };

  addTransaction = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const data: CreateWalletTransactionRequest = req.body;
    const result = await this.walletService.addTransaction(data);

    res.status(201).json({
      success: true,
      message: 'Transaction added successfully',
      data: result,
    });
  };

  getTransactions = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const { userId } = req.params;
    const queryParams: WalletTransactionQueryParams = {
      transactionType: req.query.transactionType as any,
      status: req.query.status as any,
      referenceType: req.query.referenceType as string,
      referenceId: req.query.referenceId as string,
      transactionDateFrom: req.query.transactionDateFrom as string,
      transactionDateTo: req.query.transactionDateTo as string,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      limit: req.query.limit
        ? parseInt(req.query.limit as string)
        : undefined,
      sortBy: req.query.sortBy as string,
      sortOrder: req.query.sortOrder as 'asc' | 'desc',
    };

    const result = await this.walletService.getTransactions(userId, queryParams);

    if (result.total !== undefined) {
      res.status(200).json({
        success: true,
        data: result.data,
        pagination: {
          page: result.page!,
          limit: queryParams.limit!,
          total: result.total,
          totalPages: result.totalPages!,
        },
      });
    } else {
      res.status(200).json({
        success: true,
        data: result.data,
      });
    }
  };

  getTransactionById = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const { id } = req.params;
    const result = await this.walletService.getTransactionById(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  initiateRecharge = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const userId =
      req.user?.userType === 'admin'
        ? ((req.body.userId as string | undefined) || req.user!._id)
        : req.user!._id;

    const data: InitiateWalletRechargeRequest = {
      ...req.body,
      userId,
    };
    const result = await this.walletService.initiateRecharge(data);

    res.status(200).json({
      success: true,
      message: 'Wallet recharge payment initiated successfully',
      data: result,
    });
  };

}
