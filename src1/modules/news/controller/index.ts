import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { NewsService } from '@/modules/news/services';
import {
  CreateNewsRequest,
  UpdateNewsRequest,
  NewsQueryParams,
} from '@/modules/news/types';

export class NewsController {
  private newsService: NewsService;

  constructor() {
    this.newsService = Container.get(NewsService);
  }

  create = async (req: Request, res: Response, _next: NextFunction) => {
    const data: CreateNewsRequest = req.body;
    const result = await this.newsService.create(data);

    res.status(201).json({
      success: true,
      message: 'News created successfully',
      data: result,
    });
  };

  getById = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.newsService.getById(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAll = async (req: Request, res: Response, _next: NextFunction) => {
    const queryParams: NewsQueryParams = {
      title: req.query.title as string,
      description: req.query.description as string,
      publishedAt: req.query.publishedAt as string,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      sortBy: req.query.sortBy as string,
      sortOrder: req.query.sortOrder as 'asc' | 'desc',
    };

    const result = await this.newsService.getAll(queryParams);

    if (result.total !== undefined) {
      res.status(200).json({
        success: true,
        data: result.data,
        pagination: {
          page: result.page!,
          limit: queryParams.limit!,
          total: result.total,
          totalPages: result.totalPages!,
        },
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: result.data,
    });
  };

  update = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const data: UpdateNewsRequest = req.body;
    const result = await this.newsService.update(id, data);

    res.status(200).json({
      success: true,
      message: 'News updated successfully',
      data: result,
    });
  };

  delete = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    await this.newsService.delete(id);

    res.status(200).json({
      success: true,
      message: 'News deleted successfully',
    });
  };
}
