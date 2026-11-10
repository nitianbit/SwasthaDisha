import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { HRService } from '@/modules/hr/services';
import { AppError } from '@/modules/common/types';
import { AuthRequest } from '@/modules/middleware/auth';
import {
  CreateHRRequest,
  HRCorporateOverviewQueryParams,
  UpdateHRRequest,
  HRQueryParams,
} from '@/modules/hr/types';

export class HRController {
  private hrService: HRService;

  constructor() {
    this.hrService = Container.get(HRService);
  }

  private getScopedCorporateId(req: AuthRequest, corporateId?: string): string | undefined {
    if (req.user?.userType === 'hr') {
      if (!req.user.corporateId) {
        throw new AppError({
          status: 403,
          code: 'HR_CORPORATE_REQUIRED',
          message: 'HR account must be linked to a corporate',
        });
      }
      if (corporateId && corporateId !== req.user.corporateId) {
        throw new AppError({
          status: 403,
          code: 'FORBIDDEN',
          message: 'HR can only access their own corporate data',
        });
      }
      return req.user.corporateId;
    }

    return corporateId;
  }

  create = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const data: CreateHRRequest = req.body;
    const result = await this.hrService.create(data);

    res.status(201).json({
      success: true,
      message: 'Employee record created successfully',
      data: result,
    });
  };

  getById = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.hrService.getById(id);
    this.getScopedCorporateId(req, result.corporateId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getByEmployeeId = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { employeeId } = req.params;
    const result = await this.hrService.getByEmployeeId(employeeId);
    this.getScopedCorporateId(req, result.corporateId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAll = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const queryParams: HRQueryParams = {
      employeeId: req.query.employeeId as string,
      firstName: req.query.firstName as string,
      lastName: req.query.lastName as string,
      email: req.query.email as string,
      userId: req.query.userId as string,
      department: req.query.department as string,
      designation: req.query.designation as string,
      employmentType: req.query.employmentType as any,
      employmentStatus: req.query.employmentStatus as any,
      corporateId: this.getScopedCorporateId(
        req,
        req.query.corporateId as string | undefined
      ),
      reportingManager: req.query.reportingManager as string,
      isActive:
        req.query.isActive !== undefined
          ? req.query.isActive === 'true'
          : undefined,
      joiningDateFrom: req.query.joiningDateFrom as string,
      joiningDateTo: req.query.joiningDateTo as string,
      search: req.query.search as string,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      limit: req.query.limit
        ? parseInt(req.query.limit as string)
        : undefined,
      sortBy: req.query.sortBy as string,
      sortOrder: req.query.sortOrder as 'asc' | 'desc',
    };

    const result = await this.hrService.getAll(queryParams);

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
    const data: UpdateHRRequest = req.body;
    const result = await this.hrService.update(id, data);

    res.status(200).json({
      success: true,
      message: 'Employee record updated successfully',
      data: result,
    });
  };

  delete = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    await this.hrService.delete(id);

    res.status(200).json({
      success: true,
      message: 'Employee record deleted successfully',
    });
  };

  getByDepartment = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { department } = req.params;
    const result = await this.hrService.getAll({
      department,
      corporateId: this.getScopedCorporateId(req),
    });

    res.status(200).json({
      success: true,
      data: result.data,
    });
  };

  getByEmploymentStatus = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const { status } = req.params;
    const result = await this.hrService.getAll({
      employmentStatus: status as any,
      corporateId: this.getScopedCorporateId(req),
    });

    res.status(200).json({
      success: true,
      data: result.data,
    });
  };

  getByCorporateId = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const corporateId = this.getScopedCorporateId(req, req.params.corporateId)!;
    const result = await this.hrService.getByCorporateId(corporateId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getCorporateOverview = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const corporateId = this.getScopedCorporateId(req, req.params.corporateId)!;
    const query: HRCorporateOverviewQueryParams = {
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      dateFrom: req.query.dateFrom as string | undefined,
      dateTo: req.query.dateTo as string | undefined,
    };
    const result = await this.hrService.getCorporateOverview(corporateId, query);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getByReportingManager = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const { reportingManager } = req.params;
    const result = await this.hrService.getAll({
      reportingManager,
      corporateId: this.getScopedCorporateId(req),
    });

    res.status(200).json({
      success: true,
      data: result.data,
    });
  };
}
