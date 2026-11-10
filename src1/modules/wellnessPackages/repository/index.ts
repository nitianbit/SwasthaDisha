import { Service } from 'typedi';
import { Model } from 'mongoose';
import WellnessPackageModel from '@/modules/wellnessPackages/model';
import {
  IWellnessPackage,
  WellnessPackageQueryParams,
} from '@/modules/wellnessPackages/types';
import { BaseRepository } from '@/modules/common/repository';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class WellnessPackageRepository extends BaseRepository<IWellnessPackage> {
  constructor() {
    super(WellnessPackageModel as Model<IWellnessPackage>);
  }

  buildFilterFromParams(filter: WellnessPackageQueryParams = {}): any {
    const query: any = {};

    if (filter.name) {
      query.name = buildContainsRegex(filter.name);
    }

    if (filter.category) {
      query.category = buildContainsRegex(filter.category);
    }

    if (filter.isActive !== undefined) {
      query.isActive = filter.isActive;
    }

    if (filter.isPopular !== undefined) {
      query.isPopular = filter.isPopular;
    }

    if (filter.minPrice !== undefined || filter.maxPrice !== undefined) {
      query.discountedPrice = {};
      if (filter.minPrice !== undefined) {
        query.discountedPrice.$gte = filter.minPrice;
      }
      if (filter.maxPrice !== undefined) {
        query.discountedPrice.$lte = filter.maxPrice;
      }
    }

    if (filter.search) {
      query.$text = { $search: filter.search };
    }

    return query;
  }

  buildSortFromParams(filter: WellnessPackageQueryParams = {}): any {
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.order = 1;
    }

    // If text search, add text score to sort
    if (filter.search) {
      sort.score = { $meta: 'textScore' };
    }

    return sort;
  }

  async findByIdWithModel(id: string) {
    return WellnessPackageModel.findById(id);
  }

  async findPopularPackages(): Promise<IWellnessPackage[]> {
    return this.findAll(
      { isPopular: true, isActive: true },
      { sort: { order: 1 } }
    );
  }

  async findByCategory(category: string): Promise<IWellnessPackage[]> {
    return this.findAll(
      { category, isActive: true },
      { sort: { order: 1 } }
    );
  }

  async findActivePackages(): Promise<IWellnessPackage[]> {
    return this.findAll({ isActive: true }, { sort: { order: 1 } });
  }

  async searchPackages(searchTerm: string): Promise<IWellnessPackage[]> {
    return WellnessPackageModel.find({
      $text: { $search: searchTerm },
      isActive: true,
    })
      .sort({ order: 1 })
      .lean();
  }

  async findWithPagination(
    filter: WellnessPackageQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{
    data: IWellnessPackage[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const query = this.buildFilterFromParams(filter);

    const skip = (page - 1) * limit;
    const sort = this.buildSortFromParams(filter);

    const [data, total] = await Promise.all([
      WellnessPackageModel.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      WellnessPackageModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async updateOrder(id: string, order: number): Promise<IWellnessPackage | null> {
    return this.update({ _id: id }, { order });
  }
}
