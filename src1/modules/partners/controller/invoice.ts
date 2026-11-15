import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AuthRequest } from '@/modules/middleware/auth';
import { InvoiceService } from '@/modules/partners/services/invoice';
import MemberModel from '@/modules/partners/model/member';

const service = () => Container.get(InvoiceService);

async function callerPartnerId(req: AuthRequest): Promise<string> {
  const memberId = req.user!.memberId!;
  const member = await MemberModel.findById(memberId).select('partnerId').lean();
  return String((member as any)?.partnerId);
}

export const createInvoice = async (req: Request, res: Response, _next: NextFunction) => {
  const partnerId = await callerPartnerId(req as AuthRequest);
  const data = await service().createInvoice({
    partnerId,
    branchId: req.body.branchId,
    customer: req.body.customer,
    doctorId: req.body.doctorId,
    items: req.body.items,
    idempotencyKey: req.body.idempotencyKey,
    createdBy: (req as AuthRequest).user!._id,
  });
  res.status(201).json({ success: true, data });
};

export const recordPayment = async (req: Request, res: Response, _next: NextFunction) => {
  const result = await service().recordPayment(
    req.params.invoiceId,
    req.body,
    (req as AuthRequest).user!._id
  );
  res.status(200).json({ success: true, data: result });
};

export const cancelInvoice = async (req: Request, res: Response, _next: NextFunction) => {
  const result = await service().cancelInvoice(
    req.params.invoiceId,
    req.body.reason,
    (req as AuthRequest).user!._id
  );
  res.status(200).json({ success: true, data: result });
};

export const getInvoice = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().getInvoiceWithEvents(req.params.invoiceId);
  res.status(200).json({ success: true, data });
};

export const listPartnerInvoices = async (req: Request, res: Response, _next: NextFunction) => {
  const partnerId = await callerPartnerId(req as AuthRequest);
  const state = req.query.state as string | undefined;
  const data = await service().listPartnerInvoices(partnerId, state);
  res.status(200).json({ success: true, data });
};

export const listCustomerBills = async (req: Request, res: Response, _next: NextFunction) => {
  const userId = (req as AuthRequest).user!._id;
  const data = await service().listCustomerBills(userId);
  res.status(200).json({ success: true, data });
};
