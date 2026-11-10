import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { SlotService } from '@/modules/slots/services';
import {
  CreateSlotRequest,
  UpdateSlotRequest,
  SlotQueryParams,
} from '@/modules/slots/types';

export class SlotController {
  private slotService: SlotService;

  constructor() {
    this.slotService = Container.get(SlotService);
  }

  create = async (req: Request, res: Response, _next: NextFunction) => {
    const data: CreateSlotRequest = req.body;
    const result = await this.slotService.create(data);

    res.status(201).json({
      success: true,
      message: 'Slots created successfully',
      data: result,
    });
  };

  getById = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.slotService.getById(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAll = async (req: Request, res: Response, _next: NextFunction) => {
    const queryParams: SlotQueryParams = {
      specialistId: req.query.specialistId as string,
      wellnessPackageId: req.query.wellnessPackageId as string,
      slotType: req.query.slotType as 'consultation' | 'wellnessPackage',
      date: req.query.date as string | undefined,
      dateFrom: req.query.dateFrom as string | undefined,
      dateTo: req.query.dateTo as string | undefined,
      isAvailable:
        req.query.isAvailable !== undefined
          ? req.query.isAvailable === 'true'
          : undefined,
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

    const result = await this.slotService.getAll(queryParams);

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
    const data: UpdateSlotRequest = req.body;
    const result = await this.slotService.update(id, data);

    res.status(200).json({
      success: true,
      message: 'Slot updated successfully',
      data: result,
    });
  };

  delete = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    await this.slotService.delete(id);

    res.status(200).json({
      success: true,
      message: 'Slot deleted successfully',
    });
  };

  getBySpecialistId = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const { specialistId } = req.params;
    const date = req.query.date as string | undefined;
    const result = await this.slotService.getBySpecialistId(specialistId, date);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getByWellnessPackageId = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const { wellnessPackageId } = req.params;
    const date = req.query.date as string | undefined;
    const result = await this.slotService.getByWellnessPackageId(
      wellnessPackageId,
      date
    );

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAvailableSlots = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const specialistId = req.query.specialistId as string | undefined;
    const wellnessPackageId = req.query.wellnessPackageId as
      | string
      | undefined;
    const date = req.query.date as string | undefined;
    const result = await this.slotService.getAvailableSlots(
      specialistId,
      wellnessPackageId,
      date
    );

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  incrementBookingCount = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const { id } = req.params;
    const result = await this.slotService.incrementBookingCount(id);

    res.status(200).json({
      success: true,
      message: 'Booking count incremented successfully',
      data: result,
    });
  };

  decrementBookingCount = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const { id } = req.params;
    const result = await this.slotService.decrementBookingCount(id);

    res.status(200).json({
      success: true,
      message: 'Booking count decremented successfully',
      data: result,
    });
  };
}
