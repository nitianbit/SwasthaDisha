import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { PatientTrackingService } from '@/modules/patientTracking/services';
import { AuthRequest } from '@/modules/middleware/auth';

export class PatientTrackingController {
  private service: PatientTrackingService;

  constructor() {
    this.service = Container.get(PatientTrackingService);
  }

  getSummary = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const { userId } = req.params;
    const result = await this.service.getSummary(userId, pharmacyId);
    res.status(200).json({ success: true, data: result });
  };

  update = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const { userId } = req.params;
    const result = await this.service.updateSummary(userId, pharmacyId, req.body);

    res.status(200).json({
      success: true,
      message: 'Patient tracking updated',
      data: result,
    });
  };
}
