import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { CorporateService } from '@/modules/corporates/services';
import { AuthRequest } from '@/modules/middleware/auth';
import {
  CreateCorporateRequest,
  UpdateCorporateRequest,
  CorporateQueryParams,
} from '@/modules/corporates/types';

export class CorporateController {
  private corporateService: CorporateService;

  constructor() {
    this.corporateService = Container.get(CorporateService);
  }

  create = async (req: Request, res: Response, _next: NextFunction) => {
    const data: CreateCorporateRequest = req.body;
    const result = await this.corporateService.create(data);

    res.status(201).json({
      success: true,
      message: 'Corporate created successfully',
      data: result,
    });
  };

  getById = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.corporateService.getById(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAll = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const queryParams: CorporateQueryParams = {
      name: req.query.name as string,
      companyName: req.query.companyName as string,
      email: req.query.email as string,
      contactPerson: req.query.contactPerson as string,
      industry: req.query.industry as string,
      city: req.query.city as string,
      state: req.query.state as string,
      country: req.query.country as string,
      isActive:
        req.query.isActive !== undefined
          ? req.query.isActive === 'true'
          : undefined,
      isVerified:
        req.query.isVerified !== undefined
          ? req.query.isVerified === 'true'
          : undefined,
      search: req.query.search as string,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      limit: req.query.limit
        ? parseInt(req.query.limit as string)
        : undefined,
      sortBy: req.query.sortBy as string,
      sortOrder: req.query.sortOrder as 'asc' | 'desc',
    };

    const result = await this.corporateService.getAll(queryParams, req.user);

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
    const data: UpdateCorporateRequest = req.body;
    const result = await this.corporateService.update(id, data);

    res.status(200).json({
      success: true,
      message: 'Corporate updated successfully',
      data: result,
    });
  };

  delete = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    await this.corporateService.delete(id);

    res.status(200).json({
      success: true,
      message: 'Corporate deleted successfully',
    });
  };

  getByIndustry = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const { industry } = req.params;
    const result = await this.corporateService.getByIndustry(industry);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getVerifiedCorporates = async (
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const result = await this.corporateService.getVerifiedCorporates();

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getSpecialists = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.corporateService.getSpecialists(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  addSpecialist = async (req: Request, res: Response, _next: NextFunction) => {
    const { id, specialistId } = req.params;
    const result = await this.corporateService.addSpecialist(id, specialistId);

    res.status(200).json({
      success: true,
      message: 'Specialist added to corporate',
      data: result,
    });
  };

  removeSpecialist = async (req: Request, res: Response, _next: NextFunction) => {
    const { id, specialistId } = req.params;
    const result = await this.corporateService.removeSpecialist(id, specialistId);

    res.status(200).json({
      success: true,
      message: 'Specialist removed from corporate',
      data: result,
    });
  };

  getWellnessPackages = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.corporateService.getWellnessPackages(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  addWellnessPackage = async (req: Request, res: Response, _next: NextFunction) => {
    const { id, packageId } = req.params;
    const result = await this.corporateService.addWellnessPackage(id, packageId);

    res.status(200).json({
      success: true,
      message: 'Wellness package added to corporate',
      data: result,
    });
  };

  removeWellnessPackage = async (req: Request, res: Response, _next: NextFunction) => {
    const { id, packageId } = req.params;
    const result = await this.corporateService.removeWellnessPackage(id, packageId);

    res.status(200).json({
      success: true,
      message: 'Wellness package removed from corporate',
      data: result,
    });
  };
}
