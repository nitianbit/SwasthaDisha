import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AuthRequest } from '@/modules/middleware/auth';
import { ReferralService } from '@/modules/referral/services';
import {
  ApplyReferralRequest,
  ReferralTransactionQueryParams,
} from '@/modules/referral/types';

export class ReferralController {
  private referralService: ReferralService;

  constructor() {
    this.referralService = Container.get(ReferralService);
  }

  getCode = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const result = await this.referralService.getReferralCode(req.user!._id);

    res.status(200).json({
      success: true,
      message: 'Referral code retrieved successfully',
      data: result,
    });
  };

  getEarnings = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const queryParams = this.getReferralTransactionQueryParams(req);
    const result = await this.referralService.getReferralEarnings(
      req.user!._id,
      queryParams
    );

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getTransactions = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const queryParams = this.getReferralTransactionQueryParams(req);
    const result = await this.referralService.getReferralTransactions(
      req.user!._id,
      queryParams
    );

    if (result.total !== undefined) {
      res.status(200).json({
        success: true,
        data: result.data,
        summary: {
          totalEarned: result.totalEarned,
          totalTransactions: result.totalTransactions,
        },
        pagination: {
          page: result.page!,
          limit: queryParams.limit!,
          total: result.total,
          totalPages: result.totalPages!,
        },
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: result.data,
      summary: {
        totalEarned: result.totalEarned,
        totalTransactions: result.totalTransactions,
      },
    });
  };

  apply = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const referredUserId = req.user!._id;
    const data: ApplyReferralRequest = req.body;

    const result = await this.referralService.applyReferral(
      referredUserId,
      data
    );

    res.status(200).json({
      success: true,
      message: 'Referral applied successfully',
      data: result,
    });
  };

  private getReferralTransactionQueryParams(
    req: AuthRequest
  ): ReferralTransactionQueryParams {
    return {
      transactionDateFrom: req.query.transactionDateFrom as string,
      transactionDateTo: req.query.transactionDateTo as string,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
      sortBy: req.query.sortBy as string,
      sortOrder: req.query.sortOrder as 'asc' | 'desc',
    };
  }
}
