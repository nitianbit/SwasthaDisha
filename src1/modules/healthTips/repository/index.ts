import { Service } from 'typedi';
import { Model } from 'mongoose';
import HealthTipModel from '@/modules/healthTips/model';
import { IHealthTip, HealthTipQueryParams } from '@/modules/healthTips/types';
import { BaseRepository } from '@/modules/common/repository';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class HealthTipRepository extends BaseRepository<IHealthTip> {
  constructor() {
    super(HealthTipModel as Model<IHealthTip>);
  }

  async findByCategory(category: string): Promise<IHealthTip[]> {
    return this.findAll({ category, isActive: true }, { sort: { order: 1 } });
  }

  async findActiveTips(): Promise<IHealthTip[]> {
    return this.findAll({ isActive: true }, { sort: { order: 1 } });
  }

  async findByIdWithModel(id: string) {
    return HealthTipModel.findById(id);
  }

  async updateOrder(id: string, order: number): Promise<IHealthTip | null> {
    return this.update({ _id: id }, { order });
  }

  async findWithPagination(
    filter: HealthTipQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{ data: IHealthTip[]; total: number; page: number; totalPages: number }> {
    const query: any = {};
    
    if (filter.title) {
      query.title = buildContainsRegex(filter.title);
    }

    if (filter.category) {
      query.category = buildContainsRegex(filter.category);
    }
    
    if (filter.isActive !== undefined) {
      query.isActive = filter.isActive;
    }

    const skip = (page - 1) * limit;
    const sort: any = {};
    
    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.order = 1;
    }

    const [data, total] = await Promise.all([
      this.findAll(query, { skip, limit, sort }),
      HealthTipModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }
}
