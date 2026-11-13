import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import { PrescriptionRefundService } from '@/modules/pharmacyOrders/prescriptionRefund';
import { AuthRequest } from '@/modules/middleware/auth';
import { MarkOrderPaidRequest, OrderQueryParams, PharmacyRecoveryWorklistQuery } from '@/modules/pharmacyOrders/types';
import { AppError } from '@/modules/common/types';

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

  requestCustomerRecovery = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const data = await this.service.requestCustomerRecovery(req.user, req.params.id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json({ success: true, data });
  };

  getCustomerRecovery = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const data = await this.service.getCustomerRecovery(req.user, req.params.id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json({ success: true, data });
  };

  getRecoveryRequests = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const query: PharmacyRecoveryWorklistQuery = {
      page: req.query.page === undefined ? 1 : Number(req.query.page),
      limit: req.query.limit === undefined ? 20 : Number(req.query.limit),
    };
    const result = await this.service.getRecoveryRequests(req.user?.pharmacyId, query);
    const body = JSON.stringify({
      success: true,
      data: result.data,
      pagination: { page: result.page, limit: result.limit, total: result.total, totalPages: result.totalPages },
    });
    if (Buffer.byteLength(body, 'utf8') >= 64 * 1024) {
      throw new AppError({ status: 503, code: 'PHARMACY_RECOVERY_UNAVAILABLE', message: 'Pharmacy recovery is unavailable' });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).type('application/json').send(body);
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
      prescriptionStatus: q.prescriptionStatus as OrderQueryParams['prescriptionStatus'],
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

  reviewPrescription = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const result = await this.service.reviewPrescription(req.params.id, pharmacyId, req.body);
    const approved = result.prescriptionStatus === 'approved';
    res.status(200).json({ success: true, message: approved ? 'Prescription approved' : 'Prescription rejected', data: result });
  };

  retryPrescriptionRefund = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const result = await Container.get(PrescriptionRefundService).retryWalletCredit(req.params.id,
      { userType: req.user?.userType || '', pharmacyId: req.user?.pharmacyId });
    const status = result.prescriptionRefund?.status;
    const message = status === 'wallet_credited' ? 'Refund credited to wallet'
      : status === 'manual_review' ? 'Refund needs manual review by finance; nothing was credited'
      : 'Refund is still pending';
    res.status(200).json({ success: true, message, data: result });
  };

  prescriptionRefundsNeedingAttention = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    if (req.user?.userType !== 'admin') throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Admin access required' });
    const data = await Container.get(PrescriptionRefundService).needsAttention(Number(req.query.limit) || 50);
    res.status(200).json({ success: true, data });
  };

  refundPrescriptionToSource = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.user?.userType !== 'user' || typeof req.user?._id !== 'string') {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Only the customer who paid can request this' });
    }
    const result = await Container.get(PrescriptionRefundService).refundToSource(req.params.id, req.user._id);
    const status = result.prescriptionRefund?.status;
    const [code, message] = status === 'source_refunded' ? [200, 'Refund sent to your original payment method']
      : status === 'source_processing' ? [202, 'Refund is being confirmed with the payment provider; check again shortly']
      : status === 'wallet_credited' ? [200, 'The payment provider did not complete the refund; the amount is in your wallet']
      : [200, 'Refund needs manual review'];
    res.status(code as number).json({ success: true, message, data: { orderId: req.params.id, prescriptionRefund: result.prescriptionRefund } });
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
