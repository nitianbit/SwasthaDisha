import 'reflect-metadata';
import { Response, NextFunction, Request } from 'express';
import { Container } from 'typedi';
import { AuthRequest } from '@/modules/middleware/auth';
import { PayoutService } from '@/modules/payouts/services';

export class PayoutController {
  private payoutService: PayoutService;

  constructor() {
    this.payoutService = Container.get(PayoutService);
  }

  activitySummaryAll = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.payoutService.getActivitySummaryAll(req.body);
    res.status(200).json({
      success: true,
      message: 'Payout activity summary retrieved successfully',
      data,
    });
  };

  fetchBillings = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.payoutService.fetchBillings(req.body);
    res.status(200).json({
      success: true,
      message: 'Payout billings retrieved successfully',
      data,
    });
  };

  calculateBillings = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.payoutService.calculateBillings(req.body);
    res.status(200).json({
      success: true,
      message: 'Payout billings calculated successfully',
      data,
    });
  };

  calculateBillingsByYear = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.payoutService.calculateBillingsByYear(req.body);
    res.status(200).json({
      success: true,
      message: 'Missing yearly payout billings calculated successfully',
      data,
    });
  };

  createDisbursal = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.payoutService.createDisbursal(req.body, {
      _id: req.user!._id,
    });
    res.status(201).json({
      success: true,
      message: 'Disbursal created successfully',
      data,
    });
  };

  getDisbursalHistory = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.payoutService.getDisbursalHistory(req.body);
    res.status(200).json({
      success: true,
      message: 'Disbursal history retrieved successfully',
      data,
    });
  };

  updateDisbursal = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.payoutService.updateDisbursal(req.body);
    res.status(200).json({
      success: true,
      message: 'Disbursal updated successfully',
      data,
    });
  };

  grid = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.payoutService.getGrid(req.query.search as string | undefined);
    res.status(200).json({
      success: true,
      message: 'Payout grid retrieved successfully',
      data,
    });
  };

  createAll = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.payoutService.createAll(req.body);
    res.status(200).json({
      success: true,
      message: 'Bulk payout billing processed successfully',
      data,
    });
  };

  getInvoice = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.payoutService.getInvoice(req.body);
    res.status(200).json({
      success: true,
      message: 'Billing invoice retrieved successfully',
      data,
    });
  };

  getReceipt = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.payoutService.getReceipt(req.body);
    res.status(200).json({
      success: true,
      message: 'Disbursal receipt retrieved successfully',
      data,
    });
  };
}
