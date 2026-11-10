import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { PharmacyService } from '@/modules/pharmacies/services';
import { InventoryService } from '@/modules/pharmacyInventory/services';
import { AuthRequest } from '@/modules/middleware/auth';
import {
  CreatePharmacyRequest,
  UpdatePharmacyRequest,
  PharmacyQueryParams,
  IPharmacy,
  PublicPharmacyDto,
  MedicineAvailabilityQueryParams,
} from '@/modules/pharmacies/types';

export class PharmacyController {
  private pharmacyService: PharmacyService;
  private inventoryService: InventoryService;

  constructor() {
    this.pharmacyService = Container.get(PharmacyService);
    this.inventoryService = Container.get(InventoryService);
  }

  private toPublicPharmacy(pharmacy: IPharmacy): PublicPharmacyDto {
    return {
      _id: pharmacy._id,
      name: pharmacy.name,
      nickname: pharmacy.nickname,
      ownerName: pharmacy.ownerName,
      address: pharmacy.address,
      city: pharmacy.city,
      state: pharmacy.state,
      pincode: pharmacy.pincode,
      latitude: pharmacy.latitude,
      longitude: pharmacy.longitude,
      openingHours: pharmacy.openingHours,
      pickupAvailable: pharmacy.pickupAvailable,
      deliveryAvailable: pharmacy.deliveryAvailable,
      isVerified: pharmacy.isVerified,
      isActive: pharmacy.isActive,
      profilePictureUrl: pharmacy.profilePictureUrl,
      createdAt: pharmacy.createdAt,
      updatedAt: pharmacy.updatedAt,
    };
  }

  private canViewSensitiveDocuments(
    pharmacy: IPharmacy,
    requester?: { userType?: string; _id?: string; pharmacyId?: string }
  ): boolean {
    if (requester?.userType === 'admin') {
      return true;
    }

    if (requester?.userType !== 'pharmacy') {
      return false;
    }

    const requesterPharmacyId = requester.pharmacyId || requester._id;
    return requesterPharmacyId === pharmacy._id;
  }

  create = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const data: CreatePharmacyRequest = req.body;
    const result = await this.pharmacyService.create(data, req.user?.userType);

    res.status(201).json({
      success: true,
      message:
        req.user?.userType === 'pharmacy'
          ? 'Pharmacy created successfully and is pending verification'
          : 'Pharmacy created successfully',
      data: result,
    });
  };

  getById = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.pharmacyService.getAccessibleById(id, req.user);
    const data = this.canViewSensitiveDocuments(result, req.user)
      ? result
      : this.toPublicPharmacy(result);

    res.status(200).json({
      success: true,
      data,
    });
  };

  getAll = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const q = req.query as Record<string, string | undefined>;

    const queryParams: PharmacyQueryParams = {
      name: q.name,
      city: q.city,
      state: q.state,
      pincode: q.pincode,
      isVerified: q.isVerified !== undefined ? q.isVerified === 'true' : undefined,
      isActive: q.isActive !== undefined ? q.isActive === 'true' : undefined,
      pickupAvailable: q.pickupAvailable !== undefined ? q.pickupAvailable === 'true' : undefined,
      deliveryAvailable: q.deliveryAvailable !== undefined ? q.deliveryAvailable === 'true' : undefined,
      search: q.search,
      page: q.page ? parseInt(q.page) : undefined,
      limit: q.limit ? parseInt(q.limit) : undefined,
      latitude: q.latitude ? parseFloat(q.latitude) : undefined,
      longitude: q.longitude ? parseFloat(q.longitude) : undefined,
      radiusKm: q.radiusKm ? parseFloat(q.radiusKm) : undefined,
      sortBy: q.sortBy,
      sortOrder: q.sortOrder as 'asc' | 'desc' | undefined,
    };

    const result = await this.pharmacyService.getAll(queryParams, req.user?.userType);
    const isAdmin = req.user?.userType === 'admin';
    const responseData = isAdmin
      ? result.data
      : result.data.map((pharmacy) => this.toPublicPharmacy(pharmacy));

    if (result.total !== undefined) {
      res.status(200).json({
        success: true,
        data: responseData,
        pagination: {
          page: result.page!,
          limit: queryParams.limit!,
          total: result.total,
          totalPages: result.totalPages!,
        },
      });
    } else {
      res.status(200).json({
        success: true,
        data: responseData,
      });
    }
  };

  getMedicineAvailability = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const q = req.query as Record<string, string | undefined>;
    const params: MedicineAvailabilityQueryParams = {
      medicineId: q.medicineId || '',
      latitude: q.latitude ? parseFloat(q.latitude) : undefined,
      longitude: q.longitude ? parseFloat(q.longitude) : undefined,
      radiusKm: q.radiusKm ? parseFloat(q.radiusKm) : undefined,
      page: q.page ? parseInt(q.page) : 1,
      limit: q.limit ? parseInt(q.limit) : 20,
    };

    const includeWholesalePrice =
      req.user?.userType === 'pharmacy' || req.user?.userType === 'admin';
    const result = await this.inventoryService.findMedicineAvailability(
      params,
      includeWholesalePrice
    );

    res.status(200).json({
      success: true,
      data: result.data,
      pagination: {
        page: result.page,
        limit: params.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  };

  getMyProfile = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const result = await this.pharmacyService.getById(pharmacyId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  updateMyProfile = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const data: UpdatePharmacyRequest = req.body;
    const result = await this.pharmacyService.update(pharmacyId, data);

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: result,
    });
  };

  update = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const data: UpdatePharmacyRequest = req.body;
    const result = await this.pharmacyService.update(id, data);

    res.status(200).json({
      success: true,
      message: 'Pharmacy updated successfully',
      data: result,
    });
  };

  delete = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    await this.pharmacyService.delete(id, req.user?._id, req.body?.reason);

    res.status(200).json({
      success: true,
      message: 'Pharmacy archived successfully',
    });
  };
}
