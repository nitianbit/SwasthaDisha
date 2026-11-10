import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { WellnessPackageService } from '@/modules/wellnessPackages/services';
import { AuthRequest } from '@/modules/middleware/auth';
import {
  CreateWellnessPackageRequest,
  UpdateWellnessPackageRequest,
  WellnessPackageQueryParams,
} from '@/modules/wellnessPackages/types';

export class WellnessPackageController {
  private wellnessPackageService: WellnessPackageService;

  constructor() {
    this.wellnessPackageService = Container.get(WellnessPackageService);
  }

  create = async (req: Request, res: Response, _next: NextFunction) => {
    const {
      corporate_id,
      ...data
    }: CreateWellnessPackageRequest & {
      corporate_id?: string;
    } = req.body;
    const result = await this.wellnessPackageService.create(data, corporate_id);

    res.status(201).json({
      success: true,
      message: 'Wellness package created successfully',
      data: result,
    });
  };

  getById = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.wellnessPackageService.getById(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAll = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const queryParams: WellnessPackageQueryParams = {
      name: req.query.name as string,
      category: req.query.category as string,
      isActive:
        req.query.isActive !== undefined
          ? req.query.isActive === 'true'
          : undefined,
      isPopular:
        req.query.isPopular !== undefined
          ? req.query.isPopular === 'true'
          : undefined,
      search: req.query.search as string,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      limit: req.query.limit
        ? parseInt(req.query.limit as string)
        : undefined,
      sortBy: req.query.sortBy as string,
      sortOrder: req.query.sortOrder as 'asc' | 'desc',
      minPrice: req.query.minPrice
        ? parseFloat(req.query.minPrice as string)
        : undefined,
      maxPrice: req.query.maxPrice
        ? parseFloat(req.query.maxPrice as string)
        : undefined,
      forUser: req.query.forUser === 'true',
    };

    const result = await this.wellnessPackageService.getAll(queryParams, req.user);

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
    const data: UpdateWellnessPackageRequest = req.body;
    const result = await this.wellnessPackageService.update(id, data);

    res.status(200).json({
      success: true,
      message: 'Wellness package updated successfully',
      data: result,
    });
  };

  delete = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    await this.wellnessPackageService.delete(id);

    res.status(200).json({
      success: true,
      message: 'Wellness package deleted successfully',
    });
  };

}
