import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import {
  requireAdminOrOperationalPharmacy,
  requireOperationalPharmacy,
} from '@/modules/middleware/auth';
import { InventoryController } from '@/modules/pharmacyInventory/controller';
import {
  createInventoryItemSchema,
  manualReserveReleaseSchema,
  inventoryQuerySchema,
  idParamSchema,
} from '@/modules/pharmacyInventory/validation';

const pharmacyInventoryRouter = Router();
const inventoryController = new InventoryController();

// Add medicine to pharmacy inventory
pharmacyInventoryRouter.post(
  '/',
  requireOperationalPharmacy,
  validate(createInventoryItemSchema, 'body'),
  catchAsync(inventoryController.addItem)
);

// List inventory for a pharmacy
pharmacyInventoryRouter.get(
  '/',
  validate(inventoryQuerySchema, 'query'),
  catchAsync(inventoryController.getByPharmacy)
);

// Low stock alerts
pharmacyInventoryRouter.get(
  '/low-stock',
  requireAdminOrOperationalPharmacy,
  validate(inventoryQuerySchema, 'query'),
  catchAsync(inventoryController.getLowStock)
);

// Adjustment history for a pharmacy
pharmacyInventoryRouter.get(
  '/adjustments',
  requireAdminOrOperationalPharmacy,
  validate(inventoryQuerySchema, 'query'),
  catchAsync(inventoryController.getAdjustmentHistory)
);

// Manually reserve stock in bulk
pharmacyInventoryRouter.post(
  '/reserve',
  requireOperationalPharmacy,
  validate(manualReserveReleaseSchema, 'body'),
  catchAsync(inventoryController.manualReserveStock)
);

// Manually release stock in bulk
pharmacyInventoryRouter.post(
  '/release',
  requireOperationalPharmacy,
  validate(manualReserveReleaseSchema, 'body'),
  catchAsync(inventoryController.manualReleaseStock)
);

// Get inventory item by ID
pharmacyInventoryRouter.get(
  '/:id',
  requireAdminOrOperationalPharmacy,
  validate(idParamSchema, 'params'),
  catchAsync(inventoryController.getItem)
);

export default pharmacyInventoryRouter;
