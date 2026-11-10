import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { PharmacyTrackingService } from '@/modules/pharmacyTracking/services';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';

export class PharmacyTrackingController {
  private service: PharmacyTrackingService;

  constructor() {
    this.service = Container.get(PharmacyTrackingService);
  }

  private resolvePharmacyId(req: AuthRequest): string {
    if (req.user?.userType === 'admin') {
      const pharmacyId = req.params.pharmacyId || '';
      if (!pharmacyId) {
        throw new AppError({
          status: 400,
          code: 'PHARMACY_ID_REQUIRED',
          message: 'pharmacyId is required for admin tracking queries',
        });
      }
      return pharmacyId;
    }

    return req.user?.pharmacyId || '';
  }

  getSummary = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = this.resolvePharmacyId(req);
    const result = await this.service.getSummary(pharmacyId);
    res.status(200).json({ success: true, data: result });
  };
}
