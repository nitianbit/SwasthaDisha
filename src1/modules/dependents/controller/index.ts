import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { DependentService } from '@/modules/dependents/services';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';
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

  private requireActor(req: AuthRequest): NonNullable<AuthRequest['user']> {
    const actor = req.user;
    if (!actor || typeof actor._id !== 'string' || actor._id.trim().length === 0) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    if (actor.userType !== 'user' && actor.userType !== 'admin') {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Access to dependent resources is not permitted',
      });
    }

    return actor;
  }

  private resolveOwner(req: AuthRequest, requestedOwner?: string): string | undefined {
    const actor = this.requireActor(req);
    if (actor.userType === 'admin') {
      return requestedOwner;
    }

    if (requestedOwner !== undefined && requestedOwner !== actor._id) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Access to dependents owned by another user is not permitted',
      });
    }

    return actor._id;
  }

  authorize = (req: AuthRequest, _res: Response, next: NextFunction): void => {
    try {
      this.requireActor(req);
      next();
    } catch (error) {
      next(error);
    }
  };

  rejectOwnershipChange = async (
    req: AuthRequest,
    _res: Response,
    next: NextFunction
  ): Promise<void> => {
    const userId = this.resolveOwner(req, req.query.userId as string | undefined);
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'userId')) {
      await this.dependentService.getById(req.params.id, userId);
      throw new AppError({
        status: 422,
        code: 'FORBIDDEN_FIELD',
        message: 'Dependent ownership cannot be changed through this endpoint',
      });
    }

    next();
  };

  create = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const actor = this.requireActor(req);
    if (actor.userType === 'user' && req.body.userId !== actor._id) {
      throw new AppError({
        status: 422,
        code: 'FORBIDDEN_FIELD',
        message: 'Dependent owner must match the authenticated user',
      });
    }

    const data: CreateDependentRequest = {
      ...req.body,
      userId: actor.userType === 'admin' ? req.body.userId : actor._id,
    };
    const result = await this.dependentService.create(data);

    res.status(201).json({
      success: true,
      message: 'Dependent created successfully',
      data: result,
    });
  };

  getById = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const userId = this.resolveOwner(req, req.query.userId as string | undefined);
    const result = await this.dependentService.getById(id, userId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAll = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const effectiveUserId = this.resolveOwner(req, req.query.userId as string | undefined);

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

  update = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const data: UpdateDependentRequest = req.body;
    const userId = this.resolveOwner(req, req.query.userId as string | undefined);
    const result = await this.dependentService.update(id, data, userId);

    res.status(200).json({
      success: true,
      message: 'Dependent updated successfully',
      data: result,
    });
  };

  delete = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const userId = this.resolveOwner(req, req.query.userId as string | undefined);
    await this.dependentService.delete(id, userId);

    res.status(200).json({
      success: true,
      message: 'Dependent deleted successfully',
    });
  };

  getByUserId = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const userId = this.resolveOwner(req, req.params.userId) as string;
    const result = await this.dependentService.getByUserId(userId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getActiveDependents = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const userId = this.resolveOwner(req, req.params.userId) as string;
    const result = await this.dependentService.getActiveDependents(userId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };
}
