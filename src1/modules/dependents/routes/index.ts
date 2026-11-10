import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { DependentController } from '@/modules/dependents/controller';
import {
  createDependentSchema,
  updateDependentSchema,
  dependentQuerySchema,
  idParamSchema,
  userIdParamSchema,
} from '@/modules/dependents/validation';

const dependentRouter = Router();

const dependentController = new DependentController();

// Create dependent
dependentRouter.post(
  '/',
  validate(createDependentSchema, 'body'),
  catchAsync(dependentController.create)
);

// Get all dependents (with optional query params)
// Supports: ?userId=xxx&relationship=Father&isActive=true&page=1&limit=10
dependentRouter.get(
  '/',
  validate(dependentQuerySchema, 'query'),
  catchAsync(dependentController.getAll)
);

// Get dependents by userId
dependentRouter.get(
  '/user/:userId',
  validate(userIdParamSchema, 'params'),
  catchAsync(dependentController.getByUserId)
);

// Get active dependents by userId
dependentRouter.get(
  '/user/:userId/active',
  validate(userIdParamSchema, 'params'),
  catchAsync(dependentController.getActiveDependents)
);

// Get dependent by ID (optionally filter by userId in query)
dependentRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(dependentQuerySchema, 'query'),
  catchAsync(dependentController.getById)
);

// Update dependent (optionally filter by userId in query)
dependentRouter.put(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updateDependentSchema, 'body'),
  validate(dependentQuerySchema, 'query'),
  catchAsync(dependentController.update)
);

// Delete dependent (optionally filter by userId in query)
dependentRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(dependentQuerySchema, 'query'),
  catchAsync(dependentController.delete)
);

export default dependentRouter;
