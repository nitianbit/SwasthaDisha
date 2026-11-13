import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { RefillOrderService } from '@/modules/pharmacySubscriptions/refillOrders';
import { AppError } from '@/modules/common/types';
import { PharmacySubscriptionService } from '@/modules/pharmacySubscriptions/services';
import { AuthRequest } from '@/modules/middleware/auth';

export class PharmacySubscriptionController {
  /** Pharmacy (owning) or the subscribed customer creates the refill order for the due cycle. */
  createRefillOrder = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const result = await Container.get(RefillOrderService).createRefillOrder(req.params.id,
      { _id: String(req.user?._id || ''), userType: req.user?.userType || '', pharmacyId: req.user?.pharmacyId }, req.body);
    res.status(result.created ? 201 : 200).json({ success: true,
      message: result.created ? 'Refill order created; it is confirmed once the customer pays' : 'A refill order for this cycle already exists',
      data: result });
  };

  /** Customer: their active refill subscriptions. */
  mine = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    if (req.user?.userType !== 'user') throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Customer access required' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json({ success: true, data: await Container.get(RefillOrderService).listMine(String(req.user._id)) });
  };

  private service: PharmacySubscriptionService;

  constructor() {
    this.service = Container.get(PharmacySubscriptionService);
  }

  create = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const result = await this.service.create(pharmacyId, req.body, req.user?._id || '');
    res.status(201).json({ success: true, message: 'Subscriptions created', data: result });
  };

  due = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const data = await this.service.getDueRefills(req.user?.pharmacyId, req.query);
    res.status(200).json({ success: true, data });
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
