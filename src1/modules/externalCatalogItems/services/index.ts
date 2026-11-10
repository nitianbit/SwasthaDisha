import { Service } from 'typedi';
import { AppError } from '@/modules/common/types';
import { ExternalCatalogItemRepository } from '@/modules/externalCatalogItems/repository';
import {
  CreateExternalCatalogItemRequest,
  ExternalCatalogItemQueryParams,
  IExternalCatalogItem,
  UpdateExternalCatalogItemRequest,
} from '@/modules/externalCatalogItems/types';

@Service()
export class ExternalCatalogItemService {
  constructor(
    private externalCatalogItemRepository: ExternalCatalogItemRepository
  ) {}

  async create(
    data: CreateExternalCatalogItemRequest
  ): Promise<IExternalCatalogItem> {
    const existing = await this.externalCatalogItemRepository.findOne({
      integration: data.integration,
      itemType: data.itemType,
      externalItemId: data.externalItemId,
    });

    if (existing) {
      throw new AppError({
        status: 409,
        code: 'EXTERNAL_CATALOG_ITEM_EXISTS',
        message: 'External catalog item metadata already exists',
      });
    }

    return this.externalCatalogItemRepository.save(data);
  }

  async getById(id: string): Promise<IExternalCatalogItem> {
    const item = await this.externalCatalogItemRepository.findById(id);

    if (!item) {
      throw new AppError({
        status: 404,
        code: 'EXTERNAL_CATALOG_ITEM_NOT_FOUND',
        message: 'External catalog item metadata not found',
      });
    }

    return item;
  }

  async getAll(queryParams: ExternalCatalogItemQueryParams = {}): Promise<{
    data: IExternalCatalogItem[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    if (queryParams.page && queryParams.limit) {
      return this.externalCatalogItemRepository.findWithPagination(
        queryParams,
        queryParams.page,
        queryParams.limit
      );
    }

    const filter: Record<string, unknown> = {};
    if (queryParams.integration) {
      filter.integration = queryParams.integration;
    }
    if (queryParams.itemType) {
      filter.itemType = queryParams.itemType;
    }
    if (queryParams.externalItemId) {
      filter.externalItemId = queryParams.externalItemId;
    }
    if (typeof queryParams.pinned === 'boolean') {
      filter.pinned = queryParams.pinned;
    }
    if (typeof queryParams.isActive === 'boolean') {
      filter.isActive = queryParams.isActive;
    }

    const data = await this.externalCatalogItemRepository.findAll(filter, {
      sort: { updatedAt: -1, createdAt: -1 },
    });

    return { data };
  }

  async update(
    id: string,
    data: UpdateExternalCatalogItemRequest
  ): Promise<IExternalCatalogItem> {
    const existing = await this.externalCatalogItemRepository.findById(id);

    if (!existing) {
      throw new AppError({
        status: 404,
        code: 'EXTERNAL_CATALOG_ITEM_NOT_FOUND',
        message: 'External catalog item metadata not found',
      });
    }

    const updated = await this.externalCatalogItemRepository.update(
      { _id: id },
      data
    );

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update external catalog item metadata',
      });
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    const existing = await this.externalCatalogItemRepository.findById(id);

    if (!existing) {
      throw new AppError({
        status: 404,
        code: 'EXTERNAL_CATALOG_ITEM_NOT_FOUND',
        message: 'External catalog item metadata not found',
      });
    }

    await this.externalCatalogItemRepository.delete({ _id: id });
  }
}
