import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AppError } from '@/modules/common/types';
import { AuthRequest } from '@/modules/middleware/auth';
import { UserService } from '@/modules/user/services';
import { CreateUserRequest, UpdateUserRequest, UserQueryParams } from '@/modules/user/types';

import { PROFILE_SELF_FORBIDDEN_FIELDS } from '@/modules/user/validation';

export class UserController {
  private userService: UserService;

  constructor() {
    this.userService = Container.get(UserService);
  }

  private getHRCorporateId(req: AuthRequest): string | undefined {
    return req.user?.userType === 'hr' ? req.user.corporateId : undefined;
  }

  private async ensureHRCanAccessUser(req: AuthRequest, userId: string) {
    if (req.user?.userType !== 'hr') {
      return;
    }

    const hrCorporateId = this.getHRCorporateId(req);
    if (!hrCorporateId) {
      throw new AppError({
        status: 403,
        code: 'HR_CORPORATE_REQUIRED',
        message: 'HR account must be linked to a corporate',
      });
    }

    const user = await this.userService.getById(userId);
    if (user.corporateId !== hrCorporateId) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'HR can only access users from their own corporate',
      });
    }
  }

  private assertUserRouteActor(req: AuthRequest, targetId?: string): void {
    if (!req.user?._id) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    if (req.user.userType === 'admin') {
      return;
    }

    if (req.user.userType === 'hr') {
      if (!req.user.corporateId) {
        throw new AppError({
          status: 403,
          code: 'HR_CORPORATE_REQUIRED',
          message: 'HR account must be linked to a corporate',
        });
      }
      return;
    }

    if (
      req.user.userType === 'user' &&
      targetId !== undefined &&
      req.user._id === targetId
    ) {
      return;
    }

    throw new AppError({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Access to this user resource is not permitted',
    });
  }

  private assertNoSelfPrivilegeFields(req: AuthRequest): void {
    if (req.user?.userType !== 'user') {
      return;
    }

    const body = req.body ?? {};
    for (const field of PROFILE_SELF_FORBIDDEN_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        throw new AppError({
          status: 422,
          code: 'FORBIDDEN_FIELD',
          message: 'One or more fields cannot be changed through this endpoint',
        });
      }
    }
  }

  private assertHRListScope(req: AuthRequest): void {
    if (req.user?.userType === 'hr' && req.query.forUser === 'true') {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'HR can only access users from their own corporate',
      });
    }
  }

  create = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    this.assertUserRouteActor(req);
    const data: CreateUserRequest = {
      ...req.body,
      corporateId: this.getHRCorporateId(req) || req.body.corporateId,
    };
    const user = await this.userService.create(data);

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: { user },
    });
  };

  getById = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    this.assertUserRouteActor(req, id);
    await this.ensureHRCanAccessUser(req, id);
    const user = await this.userService.getById(id);

    res.status(200).json({
      success: true,
      message: 'User retrieved successfully',
      data: { user },
    });
  };

  update = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    this.assertUserRouteActor(req, id);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Profile update must be an object' });
    }
    this.assertNoSelfPrivilegeFields(req);
    await this.ensureHRCanAccessUser(req, id);
    const data: UpdateUserRequest = { ...req.body };
    const hrCorporateId = this.getHRCorporateId(req);
    if (hrCorporateId) data.corporateId = hrCorporateId;
    const user = await this.userService.update(id, data, req.user!);

    res.status(200).json({
      success: true,
      message: 'User updated successfully',
      data: { user },
    });
  };

  getAll = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    this.assertUserRouteActor(req);
    this.assertHRListScope(req);
    const queryParams: UserQueryParams = {
      userType: req.query.userType as 'user' | undefined,
      name: req.query.name as string,
      email: req.query.email as string,
      phone: req.query.phone as string,
      corporateId:
        this.getHRCorporateId(req) || (req.query.corporateId as string),
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      sortBy: req.query.sortBy as string,
      sortOrder: req.query.sortOrder as 'asc' | 'desc',
      forUser: req.query.forUser === 'true',
    };
    const users = await this.userService.findAll(queryParams);

    res.status(200).json({
      success: true,
      message: 'Users retrieved successfully',
      data: { users },
    });
  };

  delete = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    this.assertUserRouteActor(req, id);
    await this.ensureHRCanAccessUser(req, id);
    await this.userService.delete(id);

    res.status(200).json({
      success: true,
      message: 'User deleted successfully',
    });
  };
}
