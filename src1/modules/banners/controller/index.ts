import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { BannerService } from '@/modules/banners/services';
import {
  CreateBannerRequest,
  UpdateBannerRequest,
  BannerQueryParams,
  BannerType,
} from '@/modules/banners/types';
import { AuthRequest } from '@/modules/middleware/auth';

export class BannerController {
  private bannerService: BannerService;

  constructor() {
    this.bannerService = Container.get(BannerService);
  }

  create = async (req: Request, res: Response, _next: NextFunction) => {
    const data: CreateBannerRequest = req.body;
    const result = await this.bannerService.create(data);

    res.status(201).json({
      success: true,
      message: 'Banner created successfully',
      data: result,
    });
  };

  getById = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.bannerService.getById(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAll = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const isAdmin = req.user?.userType === 'admin';
    const queryParams: BannerQueryParams = {
      title: req.query.title as string,
      bannerType: req.query.bannerType
        ? (req.query.bannerType as BannerType)
        : undefined,
      target: req.query.target as string,
      targetId: req.query.targetId as string,
      corporateId: req.query.corporateId as string,
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
      forUser: req.query.forUser === 'true' || (!isAdmin && !req.user?.corporateId),
    };

    // For non-admin callers, automatically scope by their corporateId (if present),
    // unless forUser=true is explicitly requested (admin use-case).
    if (!isAdmin && req.user?.corporateId && !queryParams.forUser) {
      queryParams.corporateId = req.user.corporateId;
    }

    const result = await this.bannerService.getAll(queryParams);

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
    const data: UpdateBannerRequest = req.body;
    const result = await this.bannerService.update(id, data);

    res.status(200).json({
      success: true,
      message: 'Banner updated successfully',
      data: result,
    });
  };

  delete = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    await this.bannerService.delete(id);

    res.status(200).json({
      success: true,
      message: 'Banner deleted successfully',
    });
  };

  getByBannerType = async (req: Request, res: Response, _next: NextFunction) => {
    const { bannerType } = req.params;
    const result = await this.bannerService.getByBannerType(bannerType);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getActiveBanners = async (_req: Request, res: Response, _next: NextFunction) => {
    const result = await this.bannerService.getActiveBanners();

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getByTarget = async (req: Request, res: Response, _next: NextFunction) => {
    const { target } = req.params;
    const targetId = req.query.targetId as string | undefined;
    const result = await this.bannerService.getByTarget(target, targetId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getByCorporateId = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.bannerService.getByCorporateId(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };
}
