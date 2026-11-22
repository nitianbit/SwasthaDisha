import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { PharmacyWalletService, walletView } from '@/modules/pharmacyWallet/services';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';
import { ADMIN_TOPUP_KEY } from '@/modules/pharmacyWallet/validation';

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
      // r6: a malformed id is a 400 (it used to reach the database and fail as a 500).
      if (typeof pharmacyId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(pharmacyId)) {
        throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'pharmacyId must be a pharmacy id' });
      }
      return pharmacyId;
    }

    return req.user?.pharmacyId || '';
  }

  getWallet = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = this.resolvePharmacyId(req);
    const shouldCreate = req.user?.userType !== 'admin';
    const result = await this.service.getWallet(pharmacyId, shouldCreate);
    res.status(200).json({ success: true, data: result ? walletView(result) : result });
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
    // Review of fb4063c7 (4): an admin credit needs an Idempotency-Key (a resent form never credits twice). No released
    // client calls this admin route; the pharmacy app's own top-up (above) is unaffected.
    const key = req.header('Idempotency-Key')?.trim();
    if (!key) {
      throw new AppError({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'An Idempotency-Key header is required for an admin top-up' });
    }
    if (!ADMIN_TOPUP_KEY.test(key)) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Idempotency-Key must be 8 to 100 letters, digits, _ or -' });
    }
    const result = await this.service.topup(pharmacyId, req.body, key, String(req.user?._id ?? ''));
    // r6: the same wallet shape as GET /pharmacy-wallet (adds withdrawableMinor, frozen, receivableMinor).
    res.status(200).json({ success: true, message: 'Wallet topped up', data: result ? walletView(result) : result });
  };

  /** r7: GET /pharmacy-wallet/topups/admin/by-key/:key?pharmacyId= (admin): `credited` with the row and wallet, or `not_found`. */
  adminTopupByKey = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = this.resolvePharmacyId(req);
    const key = String(req.params.key ?? '').trim();
    if (!ADMIN_TOPUP_KEY.test(key)) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'key must be the Idempotency-Key of the top-up (8 to 100 letters, digits, _ or -)' });
    }
    const result = await this.service.adminTopupByKey(pharmacyId, key);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json({ success: true, data: result });
  };

  /** POST /pharmacy-wallet/topups/:paymentTransactionId/check (assisted booking phase 1a, §17.6). */
  checkTopup = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const result = await this.service.checkTopup(req.user?.pharmacyId || '', req.params.paymentTransactionId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json({ success: true, data: result });
  };

  payConsultation = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const result = await this.service.payConsultation(pharmacyId, req.body);
    res.status(200).json({ success: true, message: 'Consultation payment successful', data: result });
  };
}
