import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { authenticate, requireAdmin } from '@/modules/middleware/auth';
import { ExternalCatalogItemController } from '@/modules/externalCatalogItems/controller';
import {
  createExternalCatalogItemSchema,
  externalCatalogItemIdParamSchema,
  externalCatalogItemQuerySchema,
  updateExternalCatalogItemSchema,
} from '@/modules/externalCatalogItems/validation';

const externalCatalogItemRouter = Router();
const externalCatalogItemController = new ExternalCatalogItemController();

externalCatalogItemRouter.post(
  '/',
  authenticate,
  requireAdmin,
  validate(createExternalCatalogItemSchema, 'body'),
  catchAsync(externalCatalogItemController.create)
);

externalCatalogItemRouter.get(
  '/',
  authenticate,
  requireAdmin,
  validate(externalCatalogItemQuerySchema, 'query'),
  catchAsync(externalCatalogItemController.getAll)
);

externalCatalogItemRouter.get(
  '/:id',
  authenticate,
  requireAdmin,
  validate(externalCatalogItemIdParamSchema, 'params'),
  catchAsync(externalCatalogItemController.getById)
);

externalCatalogItemRouter.put(
  '/:id',
  authenticate,
  requireAdmin,
  validate(externalCatalogItemIdParamSchema, 'params'),
  validate(updateExternalCatalogItemSchema, 'body'),
  catchAsync(externalCatalogItemController.update)
);

externalCatalogItemRouter.delete(
  '/:id',
  authenticate,
  requireAdmin,
  validate(externalCatalogItemIdParamSchema, 'params'),
  catchAsync(externalCatalogItemController.delete)
);

export default externalCatalogItemRouter;
