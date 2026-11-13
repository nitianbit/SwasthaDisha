import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import {
  requireAdminOrOperationalPharmacy,
  requireOperationalPharmacy,
} from '@/modules/middleware/auth';
import { PharmacyOrderController } from '@/modules/pharmacyOrders/controller';
import {
  createOrderSchema,
  updateOrderSchema,
  updateOrderStatusSchema,
  cancelOrderSchema,
  markOrderPaidSchema,
  prescriptionReviewSchema,
  orderQuerySchema,
  recoveryWorklistQuerySchema,
  idParamSchema,
} from '@/modules/pharmacyOrders/validation';

const pharmacyOrderRouter = Router();
const controller = new PharmacyOrderController();

pharmacyOrderRouter.post(
  '/',
  requireOperationalPharmacy,
  validate(createOrderSchema, 'body'),
  catchAsync(controller.create)
);

pharmacyOrderRouter.get(
  '/',
  validate(orderQuerySchema, 'query'),
  catchAsync(controller.getAll)
);

pharmacyOrderRouter.post(
  '/:id/recovery-request',
  catchAsync(controller.requestCustomerRecovery)
);

pharmacyOrderRouter.get(
  '/:id/recovery-request',
  catchAsync(controller.getCustomerRecovery)
);

pharmacyOrderRouter.get(
  '/recovery-requests',
  requireOperationalPharmacy,
  validate(recoveryWorklistQuerySchema, 'query'),
  catchAsync(controller.getRecoveryRequests)
);

// Admin/finance queue: prescription refunds that did not settle automatically.
pharmacyOrderRouter.get(
  '/prescription-refunds/attention',
  catchAsync(controller.prescriptionRefundsNeedingAttention)
);

pharmacyOrderRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(controller.getById)
);

pharmacyOrderRouter.put(
  '/:id',
  requireOperationalPharmacy,
  validate(idParamSchema, 'params'),
  validate(updateOrderSchema, 'body'),
  catchAsync(controller.update)
);

pharmacyOrderRouter.post(
  '/:id/status',
  requireOperationalPharmacy,
  validate(idParamSchema, 'params'),
  validate(updateOrderStatusSchema, 'body'),
  catchAsync(controller.updateStatus)
);

pharmacyOrderRouter.post(
  '/:id/cancel',
  requireOperationalPharmacy,
  validate(idParamSchema, 'params'),
  validate(cancelOrderSchema, 'body'),
  catchAsync(controller.cancel)
);

// Pharmacist approves/rejects the order's prescription. Queue: GET /?prescriptionStatus=pending
pharmacyOrderRouter.post(
  '/:id/prescription-review',
  requireOperationalPharmacy,
  validate(idParamSchema, 'params'),
  validate(prescriptionReviewSchema, 'body'),
  catchAsync(controller.reviewPrescription)
);

// Retry a wallet refund that did not settle automatically (owning pharmacy or admin).
pharmacyOrderRouter.post(
  '/:id/prescription-refund/retry',
  requireAdminOrOperationalPharmacy,
  validate(idParamSchema, 'params'),
  catchAsync(controller.retryPrescriptionRefund)
);

// The paying customer moves the refunded amount from wallet back to the original card/UPI.
pharmacyOrderRouter.post(
  '/:id/prescription-refund/to-source',
  validate(idParamSchema, 'params'),
  catchAsync(controller.refundPrescriptionToSource)
);

pharmacyOrderRouter.post(
  '/:id/mark-paid',
  requireAdminOrOperationalPharmacy,
  validate(idParamSchema, 'params'),
  validate(markOrderPaidSchema, 'body'),
  catchAsync(controller.markPaid)
);

export default pharmacyOrderRouter;
