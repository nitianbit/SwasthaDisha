import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin } from '@/modules/middleware/auth';
import { AdminController } from '@/modules/admin/controller';
import {
  adminIdParamSchema,
  adminQuerySchema,
  updateAdminProfileSchema,
} from '@/modules/admin/validation';

const adminRouter = Router();
const adminController = new AdminController();

adminRouter.use(requireAdmin);

adminRouter.get('/profile', catchAsync(adminController.getMyProfile));

adminRouter.put(
  '/profile',
  validate(updateAdminProfileSchema, 'body'),
  catchAsync(adminController.updateMyProfile)
);

adminRouter.get(
  '/',
  validate(adminQuerySchema, 'query'),
  catchAsync(adminController.getAll)
);

adminRouter.get(
  '/:id',
  validate(adminIdParamSchema, 'params'),
  catchAsync(adminController.getById)
);

export default adminRouter;
