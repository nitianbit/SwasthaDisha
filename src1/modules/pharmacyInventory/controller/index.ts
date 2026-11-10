import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { InventoryService } from '@/modules/pharmacyInventory/services';
import { PharmacyService } from '@/modules/pharmacies/services';
import { AuthRequest } from '@/modules/middleware/auth';
import {
  CreateInventoryItemsRequest,
  InventoryQueryParams,
  ManualInventoryReservationRequest,
} from '@/modules/pharmacyInventory/types';
import { AppError } from '@/modules/common/types';

type InventoryResponseShape = {
  _id?: string;
  pharmacyId: string;
  medicineId: string;
  availableQty: number;
  reservedQty: number;
  freeQty: number;
  reorderThreshold?: number;
  rackLocation?: string;
  purchasePrice?: number;
  retailPrice?: number;
  wholesalePrice?: number;
  batchNumber?: string;
  expiryDate?: string;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  batches?: unknown[];
};

export class InventoryController {
  private inventoryService: InventoryService;
  private pharmacyService: PharmacyService;

  constructor() {
    this.inventoryService = Container.get(InventoryService);
    this.pharmacyService = Container.get(PharmacyService);
  }

  private sanitizeInventoryItem(req: AuthRequest, item: any): Partial<InventoryResponseShape> {
    if (req.user?.userType === 'admin') {
      if (req.query.includeBatches === 'true') return item;
      const { batches: _batches, ...withoutBatches } = item;
      return withoutBatches;
    }

    if (req.user?.userType === 'user') {
      const medicine = item.medicineId && typeof item.medicineId === 'object'
        ? item.medicineId
        : undefined;

      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const sellableAvailableQty = item.batches?.length
        ? item.batches.reduce(
            (total: number, batch: any) =>
              total + (batch.status === 'active' && batch.expiryDate >= today ? batch.availableQty : 0),
            0
          )
        : item.availableQty;

      return {
        _id: item._id,
        pharmacyId: item.pharmacyId,
        medicineId: medicine?._id || item.medicineId,
        availableQty: sellableAvailableQty,
        retailPrice: item.retailPrice,
        batchNumber: item.batchNumber,
        expiryDate: item.expiryDate,
        isActive: item.isActive,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        medicine: medicine
          ? {
              _id: medicine._id,
              name: medicine.name,
              genericName: medicine.genericName,
              brandName: medicine.brandName,
              dosageForm: medicine.dosageForm,
              strength: medicine.strength,
              manufacturer: medicine.manufacturer,
            }
          : undefined,
      } as Partial<InventoryResponseShape> & { medicine?: Record<string, unknown> };
    }

    return {
      _id: item._id,
      pharmacyId: item.pharmacyId,
      medicineId: item.medicineId,
      availableQty: item.availableQty,
      reservedQty: item.reservedQty,
      freeQty: item.freeQty,
      reorderThreshold: item.reorderThreshold,
      rackLocation: item.rackLocation,
      purchasePrice: item.purchasePrice,
      retailPrice: item.retailPrice,
      wholesalePrice: item.wholesalePrice,
      batchNumber: item.batchNumber,
      expiryDate: item.expiryDate,
      isActive: item.isActive,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      ...(req.query.includeBatches === 'true' ? { batches: item.batches || [] } : {}),
    };
  }

  addItem = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const data: CreateInventoryItemsRequest = {
      items: req.body.items.map((item: Record<string, unknown>) => ({ ...item, pharmacyId })),
    };
    const result = await this.inventoryService.saveItems(
      data,
      req.user?._id || '',
      req.user?.userType || 'pharmacy'
    );
    const responseData = result.map((item) => this.sanitizeInventoryItem(req, item));
    res.status(201).json({
      success: true,
      message: 'Inventory items saved',
      data: responseData,
    });
  };

  getItem = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.userType === 'pharmacy' ? req.user.pharmacyId : undefined;
    const result = await this.inventoryService.getItem(req.params.id, pharmacyId);
    res.status(200).json({ success: true, data: this.sanitizeInventoryItem(req, result) });
  };

  getByPharmacy = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const q = req.query as Record<string, string | undefined>;
    const isAdmin = req.user?.userType === 'admin';
    const isPharmacy = req.user?.userType === 'pharmacy';
    const isUser = req.user?.userType === 'user';
    const pharmacyId = isAdmin
      ? q.pharmacyId
      : isPharmacy
        ? req.user?.pharmacyId
        : q.pharmacyId;
    if (!pharmacyId) {
      throw new AppError({
        status: 400,
        code: 'PHARMACY_ID_REQUIRED',
        message: isPharmacy
          ? 'pharmacyId could not be resolved from pharmacy token'
          : 'pharmacyId is required for this inventory query',
      });
    }

    if (isUser) {
      await this.pharmacyService.getAccessibleById(pharmacyId, req.user);
    }

    const params: InventoryQueryParams = {
      pharmacyId,
      medicineId: q.medicineId,
      isActive: q.isActive !== undefined ? q.isActive === 'true' : undefined,
      lowStock: q.lowStock !== undefined ? q.lowStock === 'true' : undefined,
      search: q.search,
      includeBatches: q.includeBatches === 'true',
      page: q.page ? parseInt(q.page) : 1,
      limit: q.limit ? parseInt(q.limit) : 20,
    };

    const result = await this.inventoryService.getByPharmacy(params);
    res.status(200).json({
      success: true,
      data: result.data.map((item) => this.sanitizeInventoryItem(req, item)),
      pagination: { page: result.page, limit: params.limit, total: result.total, totalPages: result.totalPages },
    });
  };

  manualReserveStock = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const payload: ManualInventoryReservationRequest = req.body;
    const result = await this.inventoryService.manualReserveStock(pharmacyId, payload, {
      userId: req.user?._id,
      userRole: req.user?.userType,
    });
    res.status(200).json({
      success: true,
      message: 'Stock reserved',
      data: result.map((item) => this.sanitizeInventoryItem(req, item)),
    });
  };

  manualReleaseStock = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const payload: ManualInventoryReservationRequest = req.body;
    const result = await this.inventoryService.manualReleaseStock(pharmacyId, payload);
    res.status(200).json({
      success: true,
      message: 'Stock released',
      data: result.map((item) => this.sanitizeInventoryItem(req, item)),
    });
  };

  getLowStock = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId =
      req.user?.userType === 'admin'
        ? ((req.query.pharmacyId as string) || '')
        : (req.user?.pharmacyId || '');
    if (!pharmacyId) {
      throw new AppError({ status: 400, code: 'PHARMACY_ID_REQUIRED', message: 'pharmacyId is required' });
    }
    const page = req.query.page ? parseInt(req.query.page as string) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
    const result = await this.inventoryService.getLowStock(pharmacyId, page, limit);
    res.status(200).json({
      success: true,
      data: result.data.map((item) => this.sanitizeInventoryItem(req, item)),
      pagination: { page: result.page, limit, total: result.total, totalPages: result.totalPages },
    });
  };

  getAdjustmentHistory = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId =
      req.user?.userType === 'admin'
        ? ((req.query.pharmacyId as string) || '')
        : (req.user?.pharmacyId || '');
    if (!pharmacyId) {
      throw new AppError({ status: 400, code: 'PHARMACY_ID_REQUIRED', message: 'pharmacyId is required' });
    }
    const page = req.query.page ? parseInt(req.query.page as string) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
    const result = await this.inventoryService.getAdjustmentHistory(pharmacyId, page, limit);
    res.status(200).json({
      success: true,
      data: result.data,
      pagination: { page: result.page, limit, total: result.total, totalPages: result.totalPages },
    });
  };
}
