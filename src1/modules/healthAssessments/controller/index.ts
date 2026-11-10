import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AuthRequest } from '@/modules/middleware/auth';
import { HealthAssessmentService } from '@/modules/healthAssessments/services';
import {
  HealthAssessmentListQueryParams,
  SubmitHealthAssessmentRequest,
} from '@/modules/healthAssessments/types';

export class HealthAssessmentController {
  private healthAssessmentService: HealthAssessmentService;

  constructor() {
    this.healthAssessmentService = Container.get(HealthAssessmentService);
  }

  getQuestionnaire = async (
    _req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const result = this.healthAssessmentService.getQuestionnaire();

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  submit = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const data: SubmitHealthAssessmentRequest = req.body;
    const result = await this.healthAssessmentService.submitAssessment(
      req.user!,
      data
    );

    res.status(201).json({
      success: true,
      message: 'Health assessment completed successfully',
      data: result,
    });
  };

  getMine = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const queryParams: HealthAssessmentListQueryParams = {
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await this.healthAssessmentService.getMyAssessments(
      req.user!._id,
      queryParams
    );

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

  getById = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.healthAssessmentService.getAssessmentById(
      req.user!._id,
      id
    );

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getMissingOfferings = async (
    _req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const result = await this.healthAssessmentService.getMissingOfferings();

    res.status(200).json({
      success: true,
      data: result,
    });
  };
}
