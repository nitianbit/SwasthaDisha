import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { SpecialistService } from '@/modules/specialists/services';
import { SpecialistPortalService } from '@/modules/specialistPortal/services';
import { AuthRequest } from '@/modules/middleware/auth';
import {
  CreateSpecialistRequest,
  UpdateSpecialistRequest,
  SpecialistQueryParams,
} from '@/modules/specialists/types';

export class SpecialistController {
  private specialistService: SpecialistService;
  private specialistPortalService: SpecialistPortalService;

  constructor() {
    this.specialistService = Container.get(SpecialistService);
    this.specialistPortalService = Container.get(SpecialistPortalService);
  }

  private specialistId(req: AuthRequest): string {
    return req.user?.specialistId || req.user?._id || '';
  }

  create = async (req: Request, res: Response, _next: NextFunction) => {
    const {
      corporate_id,
      ...data
    }: CreateSpecialistRequest & {
      corporate_id?: string;
    } = req.body;
    const result = await this.specialistService.create(data, corporate_id);

    res.status(201).json({
      success: true,
      message: 'Specialist created successfully',
      data: result,
    });
  };

  getById = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.specialistService.getById(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAll = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const queryParams: SpecialistQueryParams = {
      name: req.query.name as string,
      email: req.query.email as string,
      specialization: req.query.specialization as string,
      isActive:
        req.query.isActive !== undefined
          ? req.query.isActive === 'true'
          : undefined,
      isVerified:
        req.query.isVerified !== undefined
          ? req.query.isVerified === 'true'
          : undefined,
      minRating: req.query.minRating
        ? parseFloat(req.query.minRating as string)
        : undefined,
      maxRating: req.query.maxRating
        ? parseFloat(req.query.maxRating as string)
        : undefined,
      minExperience: req.query.minExperience
        ? parseInt(req.query.minExperience as string)
        : undefined,
      maxExperience: req.query.maxExperience
        ? parseInt(req.query.maxExperience as string)
        : undefined,
      language: req.query.language as string,
      search: req.query.search as string,
      city: req.query.city as string,
      state: req.query.state as string,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      limit: req.query.limit
        ? parseInt(req.query.limit as string)
        : undefined,
      sortBy: req.query.sortBy as string,
      sortOrder: req.query.sortOrder as 'asc' | 'desc',
      forUser: req.query.forUser === 'true',
    };

    const result = await this.specialistService.getAll(queryParams, req.user);

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
    const data: UpdateSpecialistRequest = req.body;
    const result = await this.specialistService.update(id, data);

    res.status(200).json({
      success: true,
      message: 'Specialist updated successfully',
      data: result,
    });
  };

  delete = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    await this.specialistService.delete(id);

    res.status(200).json({
      success: true,
      message: 'Specialist deleted successfully',
    });
  };

  getBySpecialization = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const { specialization } = req.params;
    const result = await this.specialistService.getBySpecialization(
      specialization
    );

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getVerifiedSpecialists = async (
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const result = await this.specialistService.getVerifiedSpecialists();

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getMyProfile = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.specialistPortalService.getProfile(
      this.specialistId(req)
    );
    res.status(200).json({
      success: true,
      message: 'Profile retrieved successfully',
      data,
    });
  };

  updateMyProfile = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.specialistPortalService.updateProfile(
      this.specialistId(req),
      req.body
    );
    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data,
    });
  };

  listMySlots = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const date = req.query.date as string | undefined;
    const data = await this.specialistPortalService.listSlots(
      this.specialistId(req),
      date
    );
    res.status(200).json({
      success: true,
      message: 'Slots retrieved successfully',
      data,
    });
  };

  createMySlot = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const slots = await this.specialistPortalService.createSlot(
      this.specialistId(req),
      req.body
    );
    res.status(201).json({
      success: true,
      message: 'Slots created successfully',
      data: slots,
    });
  };

  updateMySlot = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const slot = await this.specialistPortalService.updateSlot(
      this.specialistId(req),
      req.params.id,
      req.body
    );
    res.status(200).json({
      success: true,
      message: 'Slot updated successfully',
      data: slot,
    });
  };

  deleteMySlot = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    await this.specialistPortalService.deleteSlot(
      this.specialistId(req),
      req.params.id
    );
    res.status(200).json({
      success: true,
      message: 'Slot deleted successfully',
    });
  };

  listMyAppointments = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const q = req.query as Record<string, string | undefined>;
    const view = q.view as 'day' | 'month' | 'all';
    const page = q.page ? parseInt(q.page, 10) : undefined;
    const limit = q.limit ? parseInt(q.limit, 10) : undefined;

    const result = await this.specialistPortalService.listAppointments(
      this.specialistId(req),
      {
        view,
        date: q.date,
        yearMonth: q.yearMonth,
        page,
        limit,
      }
    );

    res.status(200).json({
      success: true,
      message: 'Appointments retrieved successfully',
      data: result.data,
      meta: {
        total: result.total,
        ...(result.page !== undefined && { page: result.page }),
        ...(result.totalPages !== undefined && {
          totalPages: result.totalPages,
        }),
      },
    });
  };

  getMyAppointmentById = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.specialistPortalService.getAppointmentById(
      this.specialistId(req),
      req.params.id
    );

    res.status(200).json({
      success: true,
      message: 'Appointment retrieved successfully',
      data,
    });
  };

  updateMyAppointmentStatus = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const booking = await this.specialistPortalService.updateAppointmentStatus(
      this.specialistId(req),
      req.params.id,
      req.body.status
    );
    res.status(200).json({
      success: true,
      message: 'Appointment status updated',
      data: booking,
    });
  };

  createMyAppointmentPrescription = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const booking = await this.specialistPortalService.createAppointmentPrescription(
      this.specialistId(req),
      req.params.id,
      req.body
    );
    res.status(200).json({
      success: true,
      message: 'Prescription generated successfully',
      data: booking,
    });
  };

  getMyPatientHistory = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.specialistPortalService.getPatientHistory(
      this.specialistId(req),
      req.params.userId
    );
    res.status(200).json({
      success: true,
      message: 'Patient history retrieved successfully',
      data,
    });
  };

  getMyStats = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const query = {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    };
    const data = await this.specialistService.getConsultationStats(
      this.specialistId(req),
      query
    );
    res.status(200).json({
      success: true,
      message: 'Specialist stats retrieved successfully',
      data,
    });
  };

  getStatsById = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const query = {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    };
    const data = await this.specialistService.getConsultationStats(
      req.params.id,
      query
    );
    res.status(200).json({
      success: true,
      message: 'Specialist stats retrieved successfully',
      data,
    });
  };

}
