import { Service } from 'typedi';
import { Model } from 'mongoose';
import ExternalCatalogItemModel from '@/modules/externalCatalogItems/model';
import { BaseRepository } from '@/modules/common/repository';
import {
  ExternalCatalogIntegration,
  ExternalCatalogItemQueryParams,
  ExternalCatalogItemType,
  IExternalCatalogItem,
} from '@/modules/externalCatalogItems/types';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class ExternalCatalogItemRepository extends BaseRepository<IExternalCatalogItem> {
  constructor() {
    super(ExternalCatalogItemModel as Model<IExternalCatalogItem>);
  }

  async findByExternalIds(
    integration: ExternalCatalogIntegration,
    itemType: ExternalCatalogItemType,
    externalItemIds: string[]
  ): Promise<IExternalCatalogItem[]> {
    const ids = Array.from(
      new Set(externalItemIds.map((id) => id.trim()).filter(Boolean))
    );

    if (!ids.length) {
      return [];
    }

    return this.findAll({
      integration,
      itemType,
      externalItemId: { $in: ids },
      isActive: true,
    });
  }

  async findByExternalId(
    integration: ExternalCatalogIntegration,
    itemType: ExternalCatalogItemType,
    externalItemId: string
  ): Promise<IExternalCatalogItem | null> {
    const normalizedId = externalItemId.trim();
    if (!normalizedId) {
      return null;
    }

    return this.findOne({
      integration,
      itemType,
      externalItemId: normalizedId,
      isActive: true,
    });
  }

  async findWithPagination(
    filter: ExternalCatalogItemQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{
    data: IExternalCatalogItem[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const query: Record<string, unknown> = {};

    if (filter.integration) {
      query.integration = filter.integration;
    }
    if (filter.itemType) {
      query.itemType = filter.itemType;
    }
    if (filter.externalItemId) {
      query.externalItemId = buildContainsRegex(filter.externalItemId);
    }
    if (filter.name) {
      query.name = buildContainsRegex(filter.name);
    }
    if (typeof filter.pinned === 'boolean') {
      query.pinned = filter.pinned;
    }
    if (typeof filter.isActive === 'boolean') {
      query.isActive = filter.isActive;
    }

    const skip = (page - 1) * limit;
    const sort: Record<string, 1 | -1> = {};
    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.updatedAt = -1;
      sort.createdAt = -1;
    }

    const [data, total] = await Promise.all([
      this.findAll(query, { skip, limit, sort }),
      ExternalCatalogItemModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }
}
