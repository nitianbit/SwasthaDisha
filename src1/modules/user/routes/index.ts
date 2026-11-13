import { validate } from '@/modules/common/middleware/validation';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { UserController } from '@/modules/user/controller';
import {
  createUserSchema,
  idParamSchema,
  userQuerySchema,
} from '@/modules/user/validation';
import { Router } from 'express';
import 'reflect-metadata';


const userRouter = Router();

const userController = new UserController();

// Create user
userRouter.post(
  '/',
  validate(createUserSchema, 'body'),
  catchAsync(userController.create)
);

// Get all users
userRouter.get(
  '/',
  validate(userQuerySchema, 'query'),
  catchAsync(userController.getAll)
);

// Get user by ID
userRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(userController.getById)
);

// Update user
userRouter.put(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(userController.update)
);

// Delete user
userRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(userController.delete)
);

export default userRouter;
