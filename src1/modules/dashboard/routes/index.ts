import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin } from '@/modules/middleware/auth';
import { DashboardController } from '@/modules/dashboard/controller';
import { dashboardAnalyticsQuerySchema } from '@/modules/dashboard/validation';

const dashboardRouter = Router();
const dashboardController = new DashboardController();

dashboardRouter.get(
  '/pharmacy-operations-health',
  requireAdmin,
  catchAsync(dashboardController.getPharmacyOperationsHealth)
);

// Admin dashboard analytics
dashboardRouter.get(
  '/analytics',
  requireAdmin,
  validate(dashboardAnalyticsQuerySchema, 'query'),
  catchAsync(dashboardController.getAnalytics)
);

export default dashboardRouter;
