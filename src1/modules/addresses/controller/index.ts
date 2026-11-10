import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AddressService } from '@/modules/addresses/services';
import { AuthRequest } from '@/modules/middleware/auth';
import {
  CreateAddressRequest,
  UpdateAddressRequest,
  AddressQueryParams,
} from '@/modules/addresses/types';

export class AddressController {
  private addressService: AddressService;

  constructor() {
    this.addressService = Container.get(AddressService);
  }

  create = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const data: CreateAddressRequest = req.body;
    const address = await this.addressService.create(data, req.user);

    res.status(201).json({
      success: true,
      message: 'Address created successfully',
      data: { address },
    });
  };

  getById = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const requestedUserId = req.query.userId as string | undefined;
    const address = await this.addressService.getById(id, req.user, requestedUserId);

    res.status(200).json({
      success: true,
      message: 'Address retrieved successfully',
      data: { address },
    });
  };

  getAll = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const queryParams: AddressQueryParams = {
      userId: req.query.userId as string | undefined,
      type: req.query.type as 'Home' | 'Work' | 'Other' | undefined,
      isDefault:
        req.query.isDefault !== undefined
          ? req.query.isDefault === 'true'
          : undefined,
      isActive:
        req.query.isActive !== undefined
          ? req.query.isActive === 'true'
          : undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      sortBy: req.query.sortBy as string | undefined,
      sortOrder: req.query.sortOrder as 'asc' | 'desc' | undefined,
    };

    const result = await this.addressService.getAll(queryParams, req.user);

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

  update = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const data: UpdateAddressRequest = req.body;
    const requestedUserId = req.query.userId as string | undefined;
    const address = await this.addressService.update(id, data, req.user, requestedUserId);

    res.status(200).json({
      success: true,
      message: 'Address updated successfully',
      data: { address },
    });
  };

  delete = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const requestedUserId = req.query.userId as string | undefined;
    await this.addressService.delete(id, req.user, requestedUserId);

    res.status(200).json({
      success: true,
      message: 'Address deleted successfully',
    });
  };
}
