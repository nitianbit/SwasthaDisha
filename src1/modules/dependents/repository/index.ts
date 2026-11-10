import { Service } from 'typedi';
import { Model } from 'mongoose';
import DependentModel from '@/modules/dependents/model';
import {
  IDependent,
  DependentQueryParams,
} from '@/modules/dependents/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class DependentRepository extends BaseRepository<IDependent> {
  constructor() {
    super(DependentModel as Model<IDependent>);
  }

  async findByIdWithModel(id: string) {
    return DependentModel.findById(id);
  }

  async findByUserId(userId: string): Promise<IDependent[]> {
    return this.findAll(
      { userId, isActive: true },
      { sort: { createdAt: -1 } }
    );
  }

  async findByUserIdAndRelationship(
    userId: string,
    relationship: string
  ): Promise<IDependent[]> {
    return this.findAll(
      { userId, relationship, isActive: true },
      { sort: { createdAt: -1 } }
    );
  }

  async findActiveDependents(userId: string): Promise<IDependent[]> {
    return this.findAll(
      { userId, isActive: true },
      { sort: { createdAt: -1 } }
    );
  }

  async searchDependents(searchTerm: string, userId?: string): Promise<IDependent[]> {
    const query: any = {
      $text: { $search: searchTerm },
      isActive: true,
    };
    
    if (userId) {
      query.userId = userId;
    }

    return DependentModel.find(query)
      .sort({ score: { $meta: 'textScore' } })
      .lean();
  }

  async findWithPagination(
    filter: DependentQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{
    data: IDependent[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const query: any = {};

    if (filter.userId) {
      query.userId = filter.userId;
    }

    if (filter.relationship) {
      query.relationship = filter.relationship;
    }

    if (filter.isActive !== undefined) {
      query.isActive = filter.isActive;
    }

    if (filter.userId && filter.isActive !== undefined) {
      query.userId = filter.userId;
      query.isActive = filter.isActive;
    }

    const skip = (page - 1) * limit;
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.createdAt = -1;
    }

    // If text search, add text score to sort
    // Note: Text search would need to be handled separately if needed

    const [data, total] = await Promise.all([
      DependentModel.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      DependentModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }
}
