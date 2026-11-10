import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin } from '@/modules/middleware/auth';
import { PayoutController } from '@/modules/payouts/controller';
import {
  calculatePayoutBillingsByYearSchema,
  calculatePayoutBillingsSchema,
  createAllPayoutsSchema,
  createPayoutDisbursalSchema,
  fetchPayoutBillingsSchema,
  getPayoutInvoiceSchema,
  getPayoutReceiptSchema,
  payoutActivitySummarySchema,
  payoutDisbursalHistorySchema,
  payoutGridQuerySchema,
  updatePayoutDisbursalSchema,
} from '@/modules/payouts/validation';

const payoutRouter = Router();
const payoutController = new PayoutController();

payoutRouter.use(requireAdmin);

payoutRouter.post(
  '/activity-summary-all',
  validate(payoutActivitySummarySchema, 'body'),
  catchAsync(payoutController.activitySummaryAll)
);

payoutRouter.post(
  '/billings',
  validate(fetchPayoutBillingsSchema, 'body'),
  catchAsync(payoutController.fetchBillings)
);

payoutRouter.post(
  '/billings/calculate',
  validate(calculatePayoutBillingsSchema, 'body'),
  catchAsync(payoutController.calculateBillings)
);

payoutRouter.post(
  '/billings/calculate-year',
  validate(calculatePayoutBillingsByYearSchema, 'body'),
  catchAsync(payoutController.calculateBillingsByYear)
);

payoutRouter.post(
  '/billings/get-invoice',
  validate(getPayoutInvoiceSchema, 'body'),
  catchAsync(payoutController.getInvoice)
);

payoutRouter.post(
  '/billings/get-receipt',
  validate(getPayoutReceiptSchema, 'body'),
  catchAsync(payoutController.getReceipt)
);

payoutRouter.post(
  '/disbursal',
  validate(createPayoutDisbursalSchema, 'body'),
  catchAsync(payoutController.createDisbursal)
);

payoutRouter.post(
  '/disbursal/history',
  validate(payoutDisbursalHistorySchema, 'body'),
  catchAsync(payoutController.getDisbursalHistory)
);

payoutRouter.patch(
  '/disbursal/update',
  validate(updatePayoutDisbursalSchema, 'body'),
  catchAsync(payoutController.updateDisbursal)
);

payoutRouter.get(
  '/grid',
  validate(payoutGridQuerySchema, 'query'),
  catchAsync(payoutController.grid)
);

payoutRouter.post(
  '/create-all',
  validate(createAllPayoutsSchema, 'body'),
  catchAsync(payoutController.createAll)
);

export default payoutRouter;
