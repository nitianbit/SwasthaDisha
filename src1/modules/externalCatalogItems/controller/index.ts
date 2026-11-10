import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { ExternalCatalogItemService } from '@/modules/externalCatalogItems/services';
import {
  CreateExternalCatalogItemRequest,
  ExternalCatalogItemQueryParams,
  UpdateExternalCatalogItemRequest,
} from '@/modules/externalCatalogItems/types';

export class ExternalCatalogItemController {
  private externalCatalogItemService: ExternalCatalogItemService;

  constructor() {
    this.externalCatalogItemService = Container.get(ExternalCatalogItemService);
  }

  create = async (req: Request, res: Response, _next: NextFunction) => {
    const data: CreateExternalCatalogItemRequest = req.body;
    const result = await this.externalCatalogItemService.create(data);

    res.status(201).json({
      success: true,
      message: 'External catalog item metadata created successfully',
      data: result,
    });
  };

  getById = async (req: Request, res: Response, _next: NextFunction) => {
    const result = await this.externalCatalogItemService.getById(req.params.id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAll = async (req: Request, res: Response, _next: NextFunction) => {
    const queryParams: ExternalCatalogItemQueryParams = {
      integration: req.query.integration as
        | 'labstack'
        | 'healthians'
        | undefined,
      itemType: req.query.itemType as 'package' | 'test' | undefined,
      externalItemId: req.query.externalItemId as string | undefined,
      name: req.query.name as string | undefined,
      pinned:
        req.query.pinned === undefined
          ? undefined
          : String(req.query.pinned) === 'true',
      isActive:
        req.query.isActive === undefined
          ? undefined
          : String(req.query.isActive) === 'true',
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit
        ? parseInt(req.query.limit as string, 10)
        : undefined,
      sortBy: req.query.sortBy as ExternalCatalogItemQueryParams['sortBy'],
      sortOrder: req.query.sortOrder as 'asc' | 'desc' | undefined,
    };

    const result = await this.externalCatalogItemService.getAll(queryParams);

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

  update = async (req: Request, res: Response, _next: NextFunction) => {
    const data: UpdateExternalCatalogItemRequest = req.body;
    const result = await this.externalCatalogItemService.update(req.params.id, data);

    res.status(200).json({
      success: true,
      message: 'External catalog item metadata updated successfully',
      data: result,
    });
  };

  delete = async (req: Request, res: Response, _next: NextFunction) => {
    await this.externalCatalogItemService.delete(req.params.id);

    res.status(200).json({
      success: true,
      message: 'External catalog item metadata deleted successfully',
    });
  };
}
