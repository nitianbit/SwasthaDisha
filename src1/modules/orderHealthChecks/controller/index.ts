import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { OrderHealthCheckService } from '@/modules/orderHealthChecks/services';
import { AuthRequest } from '@/modules/middleware/auth';

export class OrderHealthCheckController {
  private service: OrderHealthCheckService;

  constructor() {
    this.service = Container.get(OrderHealthCheckService);
  }

  create = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const checkedBy = req.user?._id || '';
    const result = await this.service.create(pharmacyId, checkedBy, {
      ...req.body,
      orderId: req.params.orderId,
    });
    res.status(201).json({ success: true, message: 'Health check recorded', data: result });
  };

  update = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const result = await this.service.update(req.params.orderId, pharmacyId, req.body);
    res.status(200).json({ success: true, message: 'Health check updated', data: result });
  };

  getByOrder = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const result = await this.service.getByOrder(
      req.params.orderId,
      req.user?.userType === 'pharmacy'
        ? (req.user?.pharmacyId || '')
        : (req.user?._id || ''),
      req.user?.userType || ''
    );
    res.status(200).json({ success: true, data: result });
  };
}
