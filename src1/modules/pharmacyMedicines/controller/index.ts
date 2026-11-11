import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { MedicineService } from '@/modules/pharmacyMedicines/services';
import { AuthRequest } from '@/modules/middleware/auth';
import {
  CreateMedicineRequest,
  UpdateMedicineRequest,
  MedicineQueryParams,
  NearbyMedicineQueryParams,
} from '@/modules/pharmacyMedicines/types';

export class MedicineController {
  private medicineService: MedicineService;

  constructor() {
    this.medicineService = Container.get(MedicineService);
  }

  create = async (req: Request, res: Response, _next: NextFunction) => {
    const data: CreateMedicineRequest = req.body;
    const result = await this.medicineService.create(data);
    res.status(201).json({ success: true, message: 'Medicine created successfully', data: result });
  };

  getById = async (req: Request, res: Response, _next: NextFunction) => {
    const result = await this.medicineService.getById(req.params.id);
    res.status(200).json({ success: true, data: result });
  };

  getAll = async (req: Request, res: Response, _next: NextFunction) => {
    const q = req.query as Record<string, string | undefined>;

    const queryParams: MedicineQueryParams = {
      name: q.name,
      genericName: q.genericName,
      brandName: q.brandName,
      category: q.category,
      dosageForm: q.dosageForm as any,
      manufacturer: q.manufacturer,
      prescriptionRequired: q.prescriptionRequired !== undefined ? q.prescriptionRequired === 'true' : undefined,
      isActive: q.isActive !== undefined ? q.isActive === 'true' : undefined,
      search: q.search,
      page: q.page ? parseInt(q.page) : undefined,
      limit: q.limit ? parseInt(q.limit) : undefined,
      sortBy: q.sortBy,
      sortOrder: q.sortOrder as 'asc' | 'desc' | undefined,
    };

    const result = await this.medicineService.getAll(queryParams);

    if (result.total !== undefined) {
      res.status(200).json({
        success: true,
        data: result.data,
        pagination: { page: result.page!, limit: queryParams.limit!, total: result.total, totalPages: result.totalPages! },
      });
    } else {
      res.status(200).json({ success: true, data: result.data });
    }
  };

  getNearby = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const q = req.query as Record<string, string | undefined>;
    const queryParams: NearbyMedicineQueryParams = {
      latitude: q.latitude ? parseFloat(q.latitude) : 0,
      longitude: q.longitude ? parseFloat(q.longitude) : 0,
      radiusKm: q.radiusKm ? parseFloat(q.radiusKm) : undefined,
      search: q.search,
      page: q.page ? parseInt(q.page) : 1,
      limit: q.limit ? parseInt(q.limit) : 20,
    };

    const includeWholesalePrice =
      req.user?.userType === 'pharmacy' || req.user?.userType === 'admin';
    const result = await this.medicineService.getNearbyAvailableMedicines(
      queryParams,
      includeWholesalePrice
    );

    res.status(200).json({
      success: true,
      data: result.data,
      pagination: {
        page: result.page,
        limit: queryParams.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  };

  update = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const data: UpdateMedicineRequest = req.body;
    const result = await this.medicineService.update(req.params.id, data, req.user?.userType);
    res.status(200).json({ success: true, message: 'Medicine updated successfully', data: result });
  };

  delete = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    await this.medicineService.delete(req.params.id, req.user?._id, req.body?.reason);
    res.status(200).json({ success: true, message: 'Medicine archived successfully' });
  };
}
