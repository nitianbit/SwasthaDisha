import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AuthRequest } from '@/modules/middleware/auth';
import { AdminService } from '@/modules/admin/services';
import { AdminQueryParams, UpdateAdminProfileRequest } from '@/modules/admin/types';

export class AdminController {
  private adminService: AdminService;

  constructor() {
    this.adminService = Container.get(AdminService);
  }

  getMyProfile = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const adminId = req.user!._id;
    const result = await this.adminService.getProfile(adminId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  updateMyProfile = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const adminId = req.user!._id;
    const data: UpdateAdminProfileRequest = req.body;
    const result = await this.adminService.updateProfile(adminId, data);

    res.status(200).json({
      success: true,
      message: 'Admin profile updated successfully',
      data: result,
    });
  };

  getById = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.adminService.getById(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAll = async (req: Request, res: Response, _next: NextFunction) => {
    const queryParams: AdminQueryParams = {
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      search: req.query.search as string,
      isActive:
        req.query.isActive !== undefined
          ? req.query.isActive === 'true'
          : undefined,
      sortBy: req.query.sortBy as string,
      sortOrder: req.query.sortOrder as 'asc' | 'desc',
      forUser: req.query.forUser === 'true', // Add forUser
    };

    const result = await this.adminService.getAll(queryParams);

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
}
