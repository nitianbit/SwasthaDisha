import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { HealthTipService } from '@/modules/healthTips/services';
import {
  CreateHealthTipRequest,
  UpdateHealthTipRequest,
  HealthTipQueryParams,
} from '@/modules/healthTips/types';

export class HealthTipController {
  private healthTipService: HealthTipService;

  constructor() {
    this.healthTipService = Container.get(HealthTipService);
  }

  create = async (req: Request, res: Response, _next: NextFunction) => {
    const data: CreateHealthTipRequest = req.body;
    const result = await this.healthTipService.create(data);

    res.status(201).json({
      success: true,
      message: 'Health tip created successfully',
      data: result,
    });
  };

  getById = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.healthTipService.getById(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAll = async (req: Request, res: Response, _next: NextFunction) => {
    const queryParams: HealthTipQueryParams = {
      title: req.query.title as string,
      category: req.query.category as string,
      isActive:
        req.query.isActive !== undefined
          ? req.query.isActive === 'true'
          : undefined,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      limit: req.query.limit
        ? parseInt(req.query.limit as string)
        : undefined,
      sortBy: req.query.sortBy as string,
      sortOrder: req.query.sortOrder as 'asc' | 'desc',
    };

    const result = await this.healthTipService.getAll(queryParams);

    if (result.total !== undefined) {
      // Paginated response
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
    } else {
      // Non-paginated response
      res.status(200).json({
        success: true,
        data: result.data,
      });
    }
  };

  update = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const data: UpdateHealthTipRequest = req.body;
    const result = await this.healthTipService.update(id, data);

    res.status(200).json({
      success: true,
      message: 'Health tip updated successfully',
      data: result,
    });
  };

  delete = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    await this.healthTipService.delete(id);

    res.status(200).json({
      success: true,
      message: 'Health tip deleted successfully',
    });
  };

  getByCategory = async (req: Request, res: Response, _next: NextFunction) => {
    const { category } = req.params;
    const result = await this.healthTipService.getByCategory(category);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getActiveTips = async (_req: Request, res: Response, _next: NextFunction) => {
    const result = await this.healthTipService.getActiveTips();

    res.status(200).json({
      success: true,
      data: result,
    });
  };
}
