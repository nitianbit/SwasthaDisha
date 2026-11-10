import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { authenticate, requireAdmin } from '@/modules/middleware/auth';
import { NewsController } from '@/modules/news/controller';
import {
  createNewsSchema,
  updateNewsSchema,
  newsQuerySchema,
  idParamSchema,
} from '@/modules/news/validation';

const newsRouter = Router();

const newsController = new NewsController();

newsRouter.post(
  '/',
  authenticate,
  requireAdmin,
  validate(createNewsSchema, 'body'),
  catchAsync(newsController.create)
);

newsRouter.get(
  '/',
  validate(newsQuerySchema, 'query'),
  catchAsync(newsController.getAll)
);

newsRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(newsController.getById)
);

newsRouter.put(
  '/:id',
  authenticate,
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(updateNewsSchema, 'body'),
  catchAsync(newsController.update)
);

newsRouter.delete(
  '/:id',
  authenticate,
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(newsController.delete)
);

export default newsRouter;
