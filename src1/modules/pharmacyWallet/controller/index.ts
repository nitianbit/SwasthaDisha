import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { PharmacyWalletService } from '@/modules/pharmacyWallet/services';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';

export class PharmacyWalletController {
  private service: PharmacyWalletService;

  constructor() {
    this.service = Container.get(PharmacyWalletService);
  }

  private resolvePharmacyId(req: AuthRequest): string {
    if (req.user?.userType === 'admin') {
      const pharmacyId = req.query.pharmacyId as string | undefined;
      if (!pharmacyId) {
        throw new AppError({
          status: 400,
          code: 'PHARMACY_ID_REQUIRED',
          message: 'pharmacyId is required for admin wallet queries',
        });
      }
      return pharmacyId;
    }

    return req.user?.pharmacyId || '';
  }

  getWallet = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = this.resolvePharmacyId(req);
    const shouldCreate = req.user?.userType !== 'admin';
    const result = await this.service.getWallet(pharmacyId, shouldCreate);
    res.status(200).json({ success: true, data: result });
  };

  getTransactions = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = this.resolvePharmacyId(req);
    const page = req.query.page ? parseInt(req.query.page as string) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
    const result = await this.service.getTransactions({ pharmacyId, page, limit });
    res.status(200).json({
      success: true,
      data: result.data,
      pagination: { page: result.page, limit, total: result.total, totalPages: result.totalPages },
    });
  };

  topup = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    if (req.user?.userType === 'pharmacy') {
      const result = await this.service.initiateTopupPayment(
        req.user.pharmacyId || '',
        req.user._id,
        req.body
      );
      res.status(200).json({
        success: true,
        message: 'Pharmacy wallet top-up payment initiated',
        data: result,
      });
      return;
    }

    const pharmacyId = req.body.pharmacyId as string;
    if (!pharmacyId) {
      throw new AppError({
        status: 400,
        code: 'PHARMACY_ID_REQUIRED',
        message: 'pharmacyId is required for admin wallet top-up',
      });
    }
    const result = await this.service.topup(
      pharmacyId,
      req.body,
      req.header('Idempotency-Key') || undefined
    );
    res.status(200).json({ success: true, message: 'Wallet topped up', data: result });
  };

  payConsultation = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const result = await this.service.payConsultation(pharmacyId, req.body);
    res.status(200).json({ success: true, message: 'Consultation payment successful', data: result });
  };
}
