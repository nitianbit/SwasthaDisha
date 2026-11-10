import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin } from '@/modules/middleware/auth';
import { BlogController } from '@/modules/blogs/controller';
import {
  blogCategoryQuerySchema,
  blogQuerySchema,
  categoryIdParamSchema,
  createBlogCategorySchema,
  createBlogSchema,
  idParamSchema,
  publicBlogQuerySchema,
  slugParamSchema,
  updateBlogCategorySchema,
  updateBlogSchema,
} from '@/modules/blogs/validation';

const blogController = new BlogController();

const blogRouter = Router();
const publicBlogRouter = Router();

blogRouter.post(
  '/categories',
  requireAdmin,
  validate(createBlogCategorySchema, 'body'),
  catchAsync(blogController.createCategory)
);

blogRouter.get(
  '/categories',
  validate(blogCategoryQuerySchema, 'query'),
  catchAsync(blogController.getAllCategories)
);

blogRouter.get(
  '/categories/:categoryId',
  validate(categoryIdParamSchema, 'params'),
  catchAsync(blogController.getCategoryById)
);

blogRouter.put(
  '/categories/:categoryId',
  requireAdmin,
  validate(categoryIdParamSchema, 'params'),
  validate(updateBlogCategorySchema, 'body'),
  catchAsync(blogController.updateCategory)
);

blogRouter.delete(
  '/categories/:categoryId',
  requireAdmin,
  validate(categoryIdParamSchema, 'params'),
  catchAsync(blogController.deleteCategory)
);

blogRouter.post(
  '/',
  requireAdmin,
  validate(createBlogSchema, 'body'),
  catchAsync(blogController.createBlog)
);

blogRouter.get(
  '/',
  validate(blogQuerySchema, 'query'),
  catchAsync(blogController.getAllBlogs)
);

blogRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(blogController.getBlogById)
);

blogRouter.put(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(updateBlogSchema, 'body'),
  catchAsync(blogController.updateBlog)
);

blogRouter.delete(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(blogController.deleteBlog)
);

publicBlogRouter.get(
  '/',
  validate(publicBlogQuerySchema, 'query'),
  catchAsync(blogController.getPublicBlogs)
);

publicBlogRouter.get(
  '/:slug',
  validate(slugParamSchema, 'params'),
  catchAsync(blogController.getPublicBlogBySlug)
);

export { blogRouter, publicBlogRouter };
export default blogRouter;
