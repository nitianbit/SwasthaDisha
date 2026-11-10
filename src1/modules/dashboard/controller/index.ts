import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AuthRequest } from '@/modules/middleware/auth';
import { DashboardService } from '@/modules/dashboard/services';
import { DashboardAnalyticsQueryParams } from '@/modules/dashboard/types';

export class DashboardController {
  private dashboardService: DashboardService;

  constructor() {
    this.dashboardService = Container.get(DashboardService);
  }

  getAnalytics = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const query: DashboardAnalyticsQueryParams = {
      dateFrom: req.query.dateFrom as string,
      dateTo: req.query.dateTo as string,
    };

    const result = await this.dashboardService.getAnalytics(query);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getPharmacyOperationsHealth = async (
    _req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const result = await this.dashboardService.getPharmacyOperationsHealth();
    res.status(200).json({ success: true, data: result });
  };
}
