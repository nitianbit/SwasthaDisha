import { Express } from 'express';
import authRouterV1 from '@/modules/auth/routes';
import userRouter from '@/modules/user/routes';
import healthTipRouter from '@/modules/healthTips/routes';
import newsRouter from '@/modules/news/routes';
import wellnessPackageRouter from '@/modules/wellnessPackages/routes';
import dependentRouter from '@/modules/dependents/routes';
import addressRouter from '@/modules/addresses/routes';
import specialistRouter from '@/modules/specialists/routes';
import bookingRouter from '@/modules/bookings/routes';
import partnerRouter from '@/modules/partners/routes';
import slotRouter from '@/modules/slots/routes';
import corporateRouter from '@/modules/corporates/routes';
import fileRouter from '@/modules/file/routes';
import bannerRouter from '@/modules/banners/routes';
import walletRouter from '@/modules/wallet/routes';
import couponRouter from '@/modules/coupon/routes';
import notificationRouter from '@/modules/notification/routes';
import hrRouter from '@/modules/hr/routes';
import paymentRouter from '@/modules/payment/routes';
import adminRouter from '@/modules/admin/routes';
import dashboardRouter from '@/modules/dashboard/routes';
import webhookRouter from '@/modules/webhooks/routes';
import fcmRouter from '@/modules/fcm/routes';
import referralRouter from '@/modules/referral/routes';
import externalBookingRouter from '@/modules/externalBookings/routes';
import healthAssessmentRouter from '@/modules/healthAssessments/routes';
import meetRouter from '@/modules/meet/routes';
import payoutRouter from '@/modules/payouts/routes';
import blogRouter, { publicBlogRouter } from '@/modules/blogs/routes';
import externalCatalogItemRouter from '@/modules/externalCatalogItems/routes';
import appVersionsRouter from '@/modules/appVersions/routes';
import campRouter from '@/modules/camps/routes';
import pharmacyRouter, { publicPharmacyRouter } from '@/modules/pharmacies/routes';
import pharmacyMedicineRouter from '@/modules/pharmacyMedicines/routes';
import pharmacyInventoryRouter from '@/modules/pharmacyInventory/routes';
import pharmacyCustomerRouter from '@/modules/pharmacyCustomers/routes';
import pharmacyOrderRouter from '@/modules/pharmacyOrders/routes';
import orderHealthCheckRouter from '@/modules/orderHealthChecks/routes';
import pharmacyWalletRouter from '@/modules/pharmacyWallet/routes';
import pharmacyInventoryImportRouter from '@/modules/pharmacyInventoryImports/routes';
import pharmacySubscriptionRouter from '@/modules/pharmacySubscriptions/routes';
import patientTrackingRouter from '@/modules/patientTracking/routes';
import pharmacyTrackingRouter from '@/modules/pharmacyTracking/routes';
import pharmacyCartRouter from '@/modules/pharmacyCart/routes';
import { FileController } from '@/modules/file/controller';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { authenticate, authenticateOptional } from '@/modules/middleware';

export const configureRoutes = (app: Express): void => {
  // Simple static file serving - /api/static/*path
  // This allows direct access to files: base_url/api/static/bookings/12345/document.pdf
  const fileController = new FileController();
  app.get('/api/static/*', catchAsync(fileController.serveFile));

  // API v1 routes
  app.use('/api/v1/auth', authRouterV1);
  app.use('/api/v1/users', authenticate, userRouter);
  app.use('/api/v1/addresses', authenticate, addressRouter);
  app.use('/api/v1/health-tips', authenticate, healthTipRouter);
  app.use('/api/v1/news', newsRouter);
  app.use('/api/v1/wellness-packages', authenticate, wellnessPackageRouter);
  app.use('/api/v1/dependents', authenticate, dependentRouter);
  app.use('/api/v1/specialists', authenticate, specialistRouter);
  app.use('/api/v1/bookings', authenticate, bookingRouter);
  app.use('/api/v1/meet', meetRouter);
  app.use('/api/v1/partners', authenticate, partnerRouter);
  app.use('/api/v1/slots', authenticate, slotRouter);
  app.use('/api/v1/corporates', authenticate, corporateRouter);
  app.use('/api/v1/file', authenticate, fileRouter);
  app.use('/api/v1/banners', authenticate, bannerRouter);
  app.use('/api/v1/wallet', authenticate, walletRouter);
  app.use('/api/v1/coupons', authenticate, couponRouter);
  app.use('/api/v1/notifications', authenticate, notificationRouter);
  app.use('/api/v1/hr', authenticate, hrRouter);
  app.use('/api/v1/payments', authenticate, paymentRouter);
  app.use('/api/v1/admins', authenticate, adminRouter);
  app.use('/api/v1/dashboard', authenticate, dashboardRouter);
  app.use('/api/v1/fcm', authenticate, fcmRouter);
  app.use('/api/v1/referrals', authenticate, referralRouter);
  app.use('/api/v1/health-assessments', authenticate, healthAssessmentRouter);
  app.use('/api/v1/payouts', authenticate, payoutRouter);
  app.use('/api/v1/blogs', authenticate, blogRouter);
  app.use('/api/v1/public/blogs', publicBlogRouter);
  app.use('/api/v1/external-catalog-items',authenticate, externalCatalogItemRouter);
  app.use('/api/v1/app-versions', appVersionsRouter);
  app.use('/api/v1/camps', authenticate, campRouter);
  app.use('/api/v1/pharmacies', authenticateOptional, publicPharmacyRouter);
  app.use('/api/v1/pharmacies', authenticate, pharmacyRouter);
  app.use('/api/v1/pharmacy-medicines', authenticate, pharmacyMedicineRouter);
  app.use('/api/v1/pharmacy-inventory', authenticate, pharmacyInventoryRouter);
  app.use('/api/v1/pharmacy-cart', authenticate, pharmacyCartRouter);
  app.use('/api/v1/pharmacy-customers', authenticate, pharmacyCustomerRouter);
  app.use('/api/v1/pharmacy-orders', authenticate, pharmacyOrderRouter);
  app.use('/api/v1/pharmacy-orders/:orderId/health-check', authenticate, orderHealthCheckRouter);
  app.use('/api/v1/pharmacy-wallet', authenticate, pharmacyWalletRouter);
  app.use('/api/v1/pharmacy-inventory-imports', authenticate, pharmacyInventoryImportRouter);
  app.use('/api/v1/pharmacy-subscriptions', authenticate, pharmacySubscriptionRouter);
  app.use('/api/v1/patient-tracking', authenticate, patientTrackingRouter);
  app.use('/api/v1/pharmacy-tracking', authenticate, pharmacyTrackingRouter);
  app.use('/api/v1/external-bookings',authenticate, externalBookingRouter);
  app.use('/api/v1/webhooks', webhookRouter);
  
  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.status(200).json({
      success: true,
      message: 'Server is running',
      timestamp: new Date().toISOString(),
    });
  });
  
  // 404 handler
  app.use('*', (_req, res) => {
    res.status(404).json({
      success: false,
      message: 'Route not found',
    });
  });
};

export default configureRoutes;
