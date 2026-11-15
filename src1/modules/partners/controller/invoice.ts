import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';
import { InvoiceService } from '@/modules/partners/services/invoice';
import { actorOf } from '@/modules/partners/controller';

const service = () => Container.get(InvoiceService);

const sendPdf = (res: Response, out: { pdf: Buffer; fileName: string }) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${out.fileName}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).send(out.pdf);
};
const versionOf = (req: Request) => (req.query.version === undefined ? undefined : Number(req.query.version));

// ── Partner workspace (members and admins acting as owner) ──

export const createInvoice = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().createInvoice(actorOf(req), req.body);
  res.status(201).json({ success: true, data });
};

export const listPartnerInvoices = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().listInvoices(actorOf(req), {
    state: req.query.state as any,
    branchId: req.query.branchId as string | undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    before: req.query.before ? new Date(String(req.query.before)) : undefined,
  });
  res.status(200).json({ success: true, data });
};

export const getInvoice = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().getInvoice(actorOf(req), req.params.invoiceId);
  res.status(200).json({ success: true, data });
};

export const getInvoicePdf = async (req: Request, res: Response, _next: NextFunction) => {
  sendPdf(res, await service().pdfForActor(actorOf(req), req.params.invoiceId, versionOf(req)));
};

export const recordPayment = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().recordPayment(actorOf(req), req.params.invoiceId, req.body);
  res.status(200).json({ success: true, data });
};

export const cancelInvoice = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().cancelInvoice(actorOf(req), req.params.invoiceId, req.body.reason);
  res.status(200).json({ success: true, data });
};

// ── Customer "Bills" ──

function customerId(req: Request): string {
  const user = (req as AuthRequest).user;
  if (!user || user.userType !== 'user') {
    throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Individual customer access required' });
  }
  return String(user._id);
}

export const listCustomerBills = async (req: Request, res: Response, _next: NextFunction) => {
  const r = await service().listCustomerBills(customerId(req), Number(req.query.page) || 1, Number(req.query.limit) || 20);
  res.status(200).json({ success: true, data: r.items, pagination: { page: r.page, limit: r.limit, total: r.total, totalPages: r.totalPages } });
};

export const getCustomerBill = async (req: Request, res: Response, _next: NextFunction) => {
  const data = await service().getCustomerBill(customerId(req), req.params.invoiceId);
  res.status(200).json({ success: true, data });
};

export const getCustomerBillPdf = async (req: Request, res: Response, _next: NextFunction) => {
  sendPdf(res, await service().pdfForCustomer(customerId(req), req.params.invoiceId, versionOf(req)));
};
