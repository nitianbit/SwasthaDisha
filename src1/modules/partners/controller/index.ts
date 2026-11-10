import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { PartnerService } from '@/modules/partners/services';
import {
  CreatePartnerRequest,
  UpdatePartnerRequest,
  PartnerQueryParams,
} from '@/modules/partners/types';

export class PartnerController {
  private partnerService: PartnerService;

  constructor() {
    this.partnerService = Container.get(PartnerService);
  }

  create = async (req: Request, res: Response, _next: NextFunction) => {
    const data: CreatePartnerRequest = req.body;
    const result = await this.partnerService.create(data);

    res.status(201).json({
      success: true,
      message: 'Partner created successfully',
      data: result,
    });
  };

  getById = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.partnerService.getById(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAll = async (req: Request, res: Response, _next: NextFunction) => {
    const queryParams: PartnerQueryParams = {
      name: req.query.name as string,
      email: req.query.email as string,
      partnerType: req.query.partnerType as string,
      isActive:
        req.query.isActive !== undefined
          ? req.query.isActive === 'true'
          : undefined,
      isVerified:
        req.query.isVerified !== undefined
          ? req.query.isVerified === 'true'
          : undefined,
      city: req.query.city as string,
      state: req.query.state as string,
      search: req.query.search as string,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      limit: req.query.limit
        ? parseInt(req.query.limit as string)
        : undefined,
      sortBy: req.query.sortBy as string,
      sortOrder: req.query.sortOrder as 'asc' | 'desc',
    };

    const result = await this.partnerService.getAll(queryParams);

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
    const data: UpdatePartnerRequest = req.body;
    const result = await this.partnerService.update(id, data);

    res.status(200).json({
      success: true,
      message: 'Partner updated successfully',
      data: result,
    });
  };

  delete = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    await this.partnerService.delete(id);

    res.status(200).json({
      success: true,
      message: 'Partner deleted successfully',
    });
  };

  getByPartnerType = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const { partnerType } = req.params;
    const result = await this.partnerService.getByPartnerType(partnerType);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getVerifiedPartners = async (
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const result = await this.partnerService.getVerifiedPartners();

    res.status(200).json({
      success: true,
      data: result,
    });
  };
}
