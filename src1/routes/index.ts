import { requestKeyRouter } from '@/modules/requestKeys';
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
import partnerDirectoryRouter from '@/modules/partnerDirectory/routes';
import partnerWorkspaceRouter, { customerBillsRouter, customerLabRouter, customerLabBookingRouter, settlementAdminRouter } from '@/modules/partners/routes';
import { registerLabBookingPayments } from '@/modules/partners/services/labBookings';
import { registerInstantPayments } from '@/modules/doctors/services/instant';
import { instantRouter } from '@/modules/doctors/routes';
import slotRouter from '@/modules/slots/routes';
import corporateRouter from '@/modules/corporates/routes';
import fileRouter, { privateDocumentHeaders } from '@/modules/file/routes';
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
import pharmacyBookingRouter from '@/modules/assisted/routes';
import { adminAssistedRouter, pharmacyAssistedRouter } from '@/modules/assisted/routes/phase1a';
import orderHealthCheckRouter from '@/modules/orderHealthChecks/routes';
import pharmacyWalletRouter from '@/modules/pharmacyWallet/routes';
import pharmacyInventoryImportRouter from '@/modules/pharmacyInventoryImports/routes';
import pharmacySubscriptionRouter from '@/modules/pharmacySubscriptions/routes';
import patientTrackingRouter from '@/modules/patientTracking/routes';
import pharmacyTrackingRouter from '@/modules/pharmacyTracking/routes';
import pharmacyCartRouter from '@/modules/pharmacyCart/routes';
import pharmacySupplierRouter from '@/modules/pharmacySuppliers/routes';
import { FileController } from '@/modules/file/controller';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { authenticate, authenticateOptional, denyRoles } from '@/modules/middleware';

export const configureRoutes = (app: Express): void => {
  // Q3: payment verification for partner-lab bookings is dispatched through the payment context registry.
  registerLabBookingPayments();
  registerInstantPayments();
  // Simple static file serving - /api/static/*path
  // This allows direct access to files: base_url/api/static/bookings/12345/document.pdf
  const fileController = new FileController();
  // D1: a public file is served to anyone; any other file needs a token and passes the one access decision.
  app.get('/api/static/*', authenticateOptional, catchAsync(fileController.serveFile));

  // API v1 routes
  app.use('/api/v1/auth', authRouterV1);
  app.use('/api/v1/users', authenticate, denyRoles('partner'), userRouter);
  app.use('/api/v1/addresses', authenticate, denyRoles('partner'), addressRouter);
  app.use('/api/v1/health-tips', authenticate, denyRoles('partner'), healthTipRouter);
  app.use('/api/v1/news', newsRouter);
  app.use('/api/v1/wellness-packages', authenticate, denyRoles('partner'), wellnessPackageRouter);
  app.use('/api/v1/dependents', authenticate, denyRoles('partner'), dependentRouter);
  app.use('/api/v1/specialists', authenticate, denyRoles('partner'), specialistRouter);
  app.use('/api/v1/bookings', authenticate, denyRoles('partner'), bookingRouter);
  app.use('/api/v1/meet', meetRouter);
  app.use('/api/v1/partners', authenticate, partnerDirectoryRouter);
  // Q: operational lab/clinic partners (accounts, members, branches); separate from the display directory above.
  app.use('/api/v1/partner-workspace', authenticate, partnerWorkspaceRouter);
  app.use('/api/v1/bills', authenticate, denyRoles('partner'), customerBillsRouter);
  app.use('/api/v1/partner-labs', authenticate, denyRoles('partner'), customerLabRouter);
  app.use('/api/v1/lab-bookings', authenticate, denyRoles('partner'), customerLabBookingRouter);
  app.use('/api/v1/instant', authenticate, denyRoles('partner'), instantRouter);
  // Q5: admin payouts and statements for every settlement account.
  app.use('/api/v1/settlements', authenticate, denyRoles('partner'), settlementAdminRouter);
  app.use('/api/v1/slots', authenticate, denyRoles('partner'), slotRouter);
  app.use('/api/v1/corporates', authenticate, denyRoles('partner'), corporateRouter);
  app.use('/api/v1/file', privateDocumentHeaders, authenticate, fileRouter);
  app.use('/api/v1/banners', authenticate, denyRoles('partner'), bannerRouter);
  app.use('/api/v1/wallet', authenticate, denyRoles('partner'), walletRouter);
  app.use('/api/v1/coupons', authenticate, denyRoles('partner'), couponRouter);
  app.use('/api/v1/notifications', authenticate, denyRoles('partner'), notificationRouter);
  app.use('/api/v1/hr', authenticate, denyRoles('partner'), hrRouter);
  app.use('/api/v1/payments', authenticate, denyRoles('partner'), paymentRouter);
  app.use('/api/v1/admins', authenticate, denyRoles('partner'), adminRouter);
  app.use('/api/v1/dashboard', authenticate, denyRoles('partner'), dashboardRouter);
  app.use('/api/v1/fcm', authenticate, denyRoles('partner'), fcmRouter);
  app.use('/api/v1/referrals', authenticate, denyRoles('partner'), referralRouter);
  app.use('/api/v1/health-assessments', authenticate, denyRoles('partner'), healthAssessmentRouter);
  app.use('/api/v1/payouts', authenticate, denyRoles('partner'), payoutRouter);
  app.use('/api/v1/blogs', authenticate, denyRoles('partner'), blogRouter);
  app.use('/api/v1/public/blogs', publicBlogRouter);
  app.use('/api/v1/external-catalog-items', authenticate, denyRoles('partner'), externalCatalogItemRouter);
  app.use('/api/v1/app-versions', appVersionsRouter);
  app.use('/api/v1/camps', authenticate, denyRoles('partner'), campRouter);
  app.use('/api/v1/pharmacies', authenticateOptional, publicPharmacyRouter);
  app.use('/api/v1/pharmacies', authenticate, denyRoles('partner'), pharmacyRouter);
  app.use('/api/v1/pharmacy-medicines', authenticate, denyRoles('partner'), pharmacyMedicineRouter);
  app.use('/api/v1/pharmacy-inventory', authenticate, denyRoles('partner'), pharmacyInventoryRouter);
  app.use('/api/v1/pharmacy-cart', authenticate, denyRoles('partner'), pharmacyCartRouter);
  app.use('/api/v1/pharmacy-customers', authenticate, denyRoles('partner'), pharmacyCustomerRouter);
  app.use('/api/v1/pharmacy-orders', authenticate, denyRoles('partner'), pharmacyOrderRouter);
  // Assisted booking phase 0: the consultations a pharmacy booked, in the booker view (prescription without diagnosis).
  app.use('/api/v1/pharmacy-bookings', authenticate, denyRoles('partner'), pharmacyBookingRouter);
  // Assisted booking phase 1a (§17.6): the pharmacy's assisted bookings and the admin tools.
  app.use('/api/v1/pharmacy-assisted', authenticate, denyRoles('partner'), pharmacyAssistedRouter);
  app.use('/api/v1/admin', authenticate, denyRoles('partner'), adminAssistedRouter);
  app.use('/api/v1/pharmacy-suppliers', authenticate, denyRoles('partner'), pharmacySupplierRouter);
  app.use('/api/v1/pharmacy-orders/:orderId/health-check', authenticate, denyRoles('partner'), orderHealthCheckRouter);
  app.use('/api/v1/pharmacy-wallet', authenticate, denyRoles('partner'), pharmacyWalletRouter);
  app.use('/api/v1/pharmacy-inventory-imports', authenticate, denyRoles('partner'), pharmacyInventoryImportRouter);
  app.use('/api/v1/pharmacy-subscriptions', authenticate, denyRoles('partner'), pharmacySubscriptionRouter);
  app.use('/api/v1/patient-tracking', authenticate, denyRoles('partner'), patientTrackingRouter);
  app.use('/api/v1/pharmacy-tracking', authenticate, denyRoles('partner'), pharmacyTrackingRouter);
  app.use('/api/v1/external-bookings', authenticate, denyRoles('partner'), externalBookingRouter);
  app.use('/api/v1/webhooks', webhookRouter);
  // D4: abandon an unresolved once-only request key (admission fence; scoped to the caller).
  app.use('/api/v1/request-keys', authenticate, requestKeyRouter);
  
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
