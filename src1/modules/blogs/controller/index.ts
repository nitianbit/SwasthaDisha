import 'reflect-metadata';
import { NextFunction, Request, Response } from 'express';
import { Container } from 'typedi';
import { BlogService } from '@/modules/blogs/services';
import {
  BlogCategoryQueryParams,
  BlogQueryParams,
  CreateBlogCategoryRequest,
  CreateBlogRequest,
  PublicBlogQueryParams,
  UpdateBlogCategoryRequest,
  UpdateBlogRequest,
} from '@/modules/blogs/types';

const parseBooleanQuery = (value: unknown): boolean | undefined => {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
};

export class BlogController {
  private blogService: BlogService;

  constructor() {
    this.blogService = Container.get(BlogService);
  }

  createCategory = async (req: Request, res: Response, _next: NextFunction) => {
    const data: CreateBlogCategoryRequest = req.body;
    const result = await this.blogService.createCategory(data);

    res.status(201).json({
      success: true,
      message: 'Blog category created successfully',
      data: result,
    });
  };

  getAllCategories = async (req: Request, res: Response, _next: NextFunction) => {
    const queryParams: BlogCategoryQueryParams = {
      search: req.query.search as string,
      isActive: parseBooleanQuery(req.query.isActive),
    };
    const result = await this.blogService.getAllCategories(queryParams);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getCategoryById = async (req: Request, res: Response, _next: NextFunction) => {
    const result = await this.blogService.getCategoryById(req.params.categoryId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  updateCategory = async (req: Request, res: Response, _next: NextFunction) => {
    const data: UpdateBlogCategoryRequest = req.body;
    const result = await this.blogService.updateCategory(req.params.categoryId, data);

    res.status(200).json({
      success: true,
      message: 'Blog category updated successfully',
      data: result,
    });
  };

  deleteCategory = async (req: Request, res: Response, _next: NextFunction) => {
    await this.blogService.deleteCategory(req.params.categoryId);

    res.status(200).json({
      success: true,
      message: 'Blog category deleted successfully',
    });
  };

  createBlog = async (req: Request, res: Response, _next: NextFunction) => {
    const data: CreateBlogRequest = req.body;
    const result = await this.blogService.createBlog(data);

    res.status(201).json({
      success: true,
      message: 'Blog created successfully',
      data: result,
    });
  };

  getAllBlogs = async (req: Request, res: Response, _next: NextFunction) => {
    const queryParams: BlogQueryParams = {
      search: req.query.search as string,
      categoryId: req.query.categoryId as string,
      status: req.query.status as BlogQueryParams['status'],
      isFeatured: parseBooleanQuery(req.query.isFeatured),
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await this.blogService.getAllBlogs(queryParams);

    if (result.total !== undefined) {
      res.status(200).json({
        success: true,
        data: result.data,
        pagination: {
          page: result.page,
          limit: queryParams.limit,
          total: result.total,
          totalPages: result.totalPages,
        },
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: result.data,
    });
  };

  getBlogById = async (req: Request, res: Response, _next: NextFunction) => {
    const result = await this.blogService.getBlogById(req.params.id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  updateBlog = async (req: Request, res: Response, _next: NextFunction) => {
    const data: UpdateBlogRequest = req.body;
    const result = await this.blogService.updateBlog(req.params.id, data);

    res.status(200).json({
      success: true,
      message: 'Blog updated successfully',
      data: result,
    });
  };

  deleteBlog = async (req: Request, res: Response, _next: NextFunction) => {
    await this.blogService.deleteBlog(req.params.id);

    res.status(200).json({
      success: true,
      message: 'Blog deleted successfully',
    });
  };

  getPublicBlogs = async (req: Request, res: Response, _next: NextFunction) => {
    const queryParams: PublicBlogQueryParams = {
      search: req.query.search as string,
      categorySlug: req.query.categorySlug as string,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };
    const result = await this.blogService.getPublicBlogs(queryParams);

    res.status(200).json({
      success: true,
      data: result.data,
      pagination: {
        page: result.page,
        limit: queryParams.limit || 12,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  };

  getPublicBlogBySlug = async (req: Request, res: Response, _next: NextFunction) => {
    const result = await this.blogService.getPublicBlogBySlug(req.params.slug);

    res.status(200).json({
      success: true,
      data: result,
    });
  };
}
