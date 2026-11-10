import { Service } from 'typedi';
import { HealthTipRepository } from '@/modules/healthTips/repository';
import {
  IHealthTip,
  CreateHealthTipRequest,
  UpdateHealthTipRequest,
  HealthTipQueryParams,
} from '@/modules/healthTips/types';
import { AppError } from '@/modules/common/types';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class HealthTipService {
  constructor(private healthTipRepository: HealthTipRepository) {}

  async create(data: CreateHealthTipRequest): Promise<IHealthTip> {
    // If order is not provided, set it to the max order + 1
    if (data.order === undefined) {
      const maxOrderTip = await this.healthTipRepository.findAll(
        {},
        { sort: { order: -1 }, limit: 1 }
      );
      data.order = maxOrderTip.length > 0 ? (maxOrderTip[0].order || 0) + 1 : 1;
    }

    return this.healthTipRepository.save(data);
  }

  async getById(id: string): Promise<IHealthTip> {
    const tip = await this.healthTipRepository.findById(id);
    
    if (!tip) {
      throw new AppError({
        status: 404,
        code: 'HEALTH_TIP_NOT_FOUND',
        message: 'Health tip not found',
      });
    }

    return tip;
  }

  async getAll(queryParams: HealthTipQueryParams = {}): Promise<{
    data: IHealthTip[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    // If pagination params are provided, use pagination
    if (queryParams.page && queryParams.limit) {
      return this.healthTipRepository.findWithPagination(
        queryParams,
        queryParams.page,
        queryParams.limit
      );
    }

    // Otherwise return all matching records
    const filter: any = {};
    
    if (queryParams.title) {
      filter.title = buildContainsRegex(queryParams.title);
    }

    if (queryParams.category) {
      filter.category = buildContainsRegex(queryParams.category);
    }
    
    if (queryParams.isActive !== undefined) {
      filter.isActive = queryParams.isActive;
    }

    const sort: any = {};
    if (queryParams.sortBy) {
      sort[queryParams.sortBy] = queryParams.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.order = 1;
    }

    const data = await this.healthTipRepository.findAll(filter, { sort });
    return { data };
  }

  async update(id: string, data: UpdateHealthTipRequest): Promise<IHealthTip> {
    const tip = await this.healthTipRepository.findById(id);
    
    if (!tip) {
      throw new AppError({
        status: 404,
        code: 'HEALTH_TIP_NOT_FOUND',
        message: 'Health tip not found',
      });
    }

    const updated = await this.healthTipRepository.update({ _id: id }, data);
    
    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update health tip',
      });
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    const tip = await this.healthTipRepository.findById(id);
    
    if (!tip) {
      throw new AppError({
        status: 404,
        code: 'HEALTH_TIP_NOT_FOUND',
        message: 'Health tip not found',
      });
    }

    await this.healthTipRepository.delete({ _id: id });
  }

  async getByCategory(category: string): Promise<IHealthTip[]> {
    return this.healthTipRepository.findByCategory(category);
  }

  async getActiveTips(): Promise<IHealthTip[]> {
    return this.healthTipRepository.findActiveTips();
  }
}
