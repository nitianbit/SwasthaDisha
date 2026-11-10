import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { PharmacySubscriptionService } from '@/modules/pharmacySubscriptions/services';
import { AuthRequest } from '@/modules/middleware/auth';

export class PharmacySubscriptionController {
  private service: PharmacySubscriptionService;

  constructor() {
    this.service = Container.get(PharmacySubscriptionService);
  }

  create = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const result = await this.service.create(pharmacyId, req.body, req.user?._id || '');
    res.status(201).json({ success: true, message: 'Subscriptions created', data: result });
  };

  list = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const q = req.query as Record<string, string | undefined>;
    const pharmacyId = req.user?.pharmacyId || q.pharmacyId || '';
    const result = await this.service.getAll({
      pharmacyId,
      userId: q.userId,
      medicineId: q.medicineId,
      isActive: q.isActive !== undefined ? q.isActive === 'true' : undefined,
      page: q.page ? parseInt(q.page) : 1,
      limit: q.limit ? parseInt(q.limit) : 20,
    });
    res.status(200).json({
      success: true,
      data: result.data,
      pagination: { page: result.page, limit: 20, total: result.total, totalPages: result.totalPages },
    });
  };

  update = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const result = await this.service.update(req.params.id, pharmacyId, req.body);
    res.status(200).json({ success: true, message: 'Subscription updated', data: result });
  };

  pause = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const result = await this.service.pause(req.params.id, pharmacyId, req.body.pausedUntil);
    res.status(200).json({ success: true, message: 'Subscription paused', data: result });
  };

  delete = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    await this.service.delete(req.params.id, pharmacyId);
    res.status(200).json({ success: true, message: 'Subscription deleted' });
  };
}
