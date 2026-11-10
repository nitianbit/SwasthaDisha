import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { authenticate, requireAdmin } from '@/modules/middleware/auth';
import { AppVersionsController } from '@/modules/appVersions/controller';
import { updateAppVersionSettingsSchema } from '@/modules/appVersions/validation';

const appVersionsRouter = Router();
const appVersionsController = new AppVersionsController();

appVersionsRouter.get('/', catchAsync(appVersionsController.getSettings));

appVersionsRouter.put(
  '/',
  authenticate,
  requireAdmin,
  validate(updateAppVersionSettingsSchema, 'body'),
  catchAsync(appVersionsController.updateSettings)
);

export default appVersionsRouter;
