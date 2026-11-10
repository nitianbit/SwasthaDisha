import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import { AuthRequest } from '@/modules/middleware/auth';
import { MarkOrderPaidRequest, OrderQueryParams } from '@/modules/pharmacyOrders/types';

export class PharmacyOrderController {
  private service: PharmacyOrderService;

  constructor() {
    this.service = Container.get(PharmacyOrderService);
  }

  create = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const result = await this.service.create(
      pharmacyId,
      req.body,
      req.user?._id || '',
      req.user?.userType || 'pharmacy'
    );
    res.status(201).json({ success: true, message: 'Order created', data: result });
  };

  getById = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const result = await this.service.getById(
      req.params.id,
      req.user?.userType === 'pharmacy'
        ? (req.user?.pharmacyId || '')
        : (req.user?._id || ''),
      req.user?.userType || ''
    );
    res.status(200).json({ success: true, data: result });
  };

  getAll = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const q = req.query as Record<string, string | undefined>;
    const isPharmacy = req.user?.userType === 'pharmacy';

    const filter: OrderQueryParams = {
      pharmacyId: isPharmacy ? (req.user?.pharmacyId || '') : q.pharmacyId,
      customerId: q.customerId,
      userId: q.userId,
      buyerPharmacyId: q.buyerPharmacyId,
      viewerPharmacyId: isPharmacy ? (req.user?.pharmacyId || '') : undefined,
      orderType: q.orderType as any,
      orderFor: q.orderFor as 'consultation' | 'diagnostic' | undefined,
      status: q.status as any,
      paymentStatus: q.paymentStatus as any,
    };

    const page = q.page ? parseInt(q.page) : 1;
    const limit = q.limit ? parseInt(q.limit) : 20;

    const result = await this.service.getAll(
      filter,
      page,
      limit,
      req.user?.userType || '',
      req.user?.userType === 'pharmacy'
        ? (req.user?.pharmacyId || '')
        : (req.user?._id || '')
    );
    res.status(200).json({
      success: true,
      data: result.data,
      pagination: { page: result.page, limit, total: result.total, totalPages: result.totalPages },
    });
  };

  update = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const result = await this.service.update(req.params.id, pharmacyId, req.body);
    res.status(200).json({ success: true, message: 'Order updated', data: result });
  };

  updateStatus = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const result = await this.service.updateStatus(req.params.id, pharmacyId, req.body);
    res.status(200).json({ success: true, message: 'Status updated', data: result });
  };

  cancel = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const result = await this.service.updateStatus(req.params.id, pharmacyId, {
      status: 'cancelled',
      notes: req.body?.notes,
    });
    res.status(200).json({ success: true, message: 'Order cancelled', data: result });
  };

  markPaid = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const result = await this.service.markPaid(req.params.id, {
      userType: req.user?.userType || '',
      pharmacyId: req.user?.pharmacyId,
      userId: req.user?._id || '',
      data: req.body as MarkOrderPaidRequest,
    });
    res.status(200).json({ success: true, message: 'Order marked as paid', data: result });
  };
}
