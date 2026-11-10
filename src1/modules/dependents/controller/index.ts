import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { DependentService } from '@/modules/dependents/services';
import { AuthRequest } from '@/modules/middleware/auth';
import {
  CreateDependentRequest,
  UpdateDependentRequest,
  DependentQueryParams,
} from '@/modules/dependents/types';

export class DependentController {
  private dependentService: DependentService;

  constructor() {
    this.dependentService = Container.get(DependentService);
  }

  create = async (req: Request, res: Response, _next: NextFunction) => {
    const data: CreateDependentRequest = req.body;
    const result = await this.dependentService.create(data);

    res.status(201).json({
      success: true,
      message: 'Dependent created successfully',
      data: result,
    });
  };

  getById = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const userId = req.query.userId as string | undefined;
    const result = await this.dependentService.getById(id, userId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAll = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const effectiveUserId =
      req.user?.userType === 'admin'
        ? (req.query.userId as string | undefined)
        : req.user?._id;

    const queryParams: DependentQueryParams = {
      userId: effectiveUserId,
      relationship: req.query.relationship as string,
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

    const result = await this.dependentService.getAll(queryParams);

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
    const data: UpdateDependentRequest = req.body;
    const userId = req.query.userId as string | undefined;
    const result = await this.dependentService.update(id, data, userId);

    res.status(200).json({
      success: true,
      message: 'Dependent updated successfully',
      data: result,
    });
  };

  delete = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const userId = req.query.userId as string | undefined;
    await this.dependentService.delete(id, userId);

    res.status(200).json({
      success: true,
      message: 'Dependent deleted successfully',
    });
  };

  getByUserId = async (req: Request, res: Response, _next: NextFunction) => {
    const { userId } = req.params;
    const result = await this.dependentService.getByUserId(userId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getActiveDependents = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const { userId } = req.params;
    const result = await this.dependentService.getActiveDependents(userId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };
}
