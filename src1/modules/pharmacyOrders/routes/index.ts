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
  deliveryExceptionSchema,
  stockHoldCancelSchema,
  customerReturnSchema,
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

// Delivery/pickup exceptions: failed delivery, retry, switch to pickup, not collected, refused at the door.
pharmacyOrderRouter.post(
  '/:id/delivery-exception',
  requireOperationalPharmacy,
  validate(idParamSchema, 'params'),
  validate(deliveryExceptionSchema, 'body'),
  catchAsync(controller.recordDeliveryException)
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

// Recall worklist (P3b): swap units off held batches, or cancel (with refund when paid).
pharmacyOrderRouter.post(
  '/:id/reallocate-held-stock',
  requireOperationalPharmacy,
  validate(idParamSchema, 'params'),
  catchAsync(controller.reallocateHeldStock)
);

pharmacyOrderRouter.post(
  '/:id/stock-hold-cancel',
  requireOperationalPharmacy,
  validate(idParamSchema, 'params'),
  validate(stockHoldCancelSchema, 'body'),
  catchAsync(controller.cancelForStockHold)
);

// Customer brings medicines back from a completed order; staff choose restock/discard and the wallet refund.
pharmacyOrderRouter.post(
  '/:id/customer-returns',
  requireOperationalPharmacy,
  validate(idParamSchema, 'params'),
  validate(customerReturnSchema, 'body'),
  catchAsync(controller.recordCustomerReturn)
);

pharmacyOrderRouter.post(
  '/:id/mark-paid',
  requireAdminOrOperationalPharmacy,
  validate(idParamSchema, 'params'),
  validate(markOrderPaidSchema, 'body'),
  catchAsync(controller.markPaid)
);

export default pharmacyOrderRouter;
