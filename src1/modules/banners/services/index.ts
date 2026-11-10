import { BannerRepository } from '@/modules/banners/repository';
import {
  BannerQueryParams,
  CreateBannerRequest,
  IBanner,
  UpdateBannerRequest,
} from '@/modules/banners/types';
import { AppError } from '@/modules/common/types';
import { compareYyyymmdd } from '@/modules/common/utils/dateUtils';
import { Service } from 'typedi';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class BannerService {
  constructor(private bannerRepository: BannerRepository) {}

  async create(data: CreateBannerRequest): Promise<IBanner> {
    // Validate date range if both dates are provided
    if (data.startDate && data.endDate) {
      if (compareYyyymmdd(data.startDate, data.endDate) > 0) {
        throw new AppError({
          status: 400,
          code: 'INVALID_DATE_RANGE',
          message: 'Start date cannot be greater than end date',
        });
      }
    }

    // If order is not provided, set it to the max order + 1
    if (data.order === undefined) {
      const maxOrderBanner = await this.bannerRepository.findAll(
        {},
        { sort: { order: -1 }, limit: 1 }
      );
      data.order = maxOrderBanner.length > 0 ? (maxOrderBanner[0].order || 0) + 1 : 1;
    }

    return this.bannerRepository.save(data);
  }

  async getById(id: string): Promise<IBanner> {
    const banner = await this.bannerRepository.findById(id);
    
    if (!banner) {
      throw new AppError({
        status: 404,
        code: 'BANNER_NOT_FOUND',
        message: 'Banner not found',
      });
    }

    return banner;
  }

  async getAll(queryParams: BannerQueryParams = {}): Promise<{
    data: IBanner[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    // If pagination params are provided, use pagination
    if (queryParams.page && queryParams.limit) {
      return this.bannerRepository.findWithPagination(
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

    if (queryParams.bannerType) {
      filter.bannerType = queryParams.bannerType;
    }
    
    if (queryParams.target) {
      filter.target = buildContainsRegex(queryParams.target);
    }
    
    if (queryParams.targetId) {
      filter.targetId = queryParams.targetId;
    }
    
    if (queryParams.corporateId) {
      filter.corporateId = queryParams.corporateId;
    }
    // For admin list with forUser=true, return only banners not tied to any corporate
    if (queryParams.forUser) {
      filter.corporateId = { $exists: false };
    }
    
    if (queryParams.isActive !== undefined) {
      filter.isActive = queryParams.isActive;
    }

    const sort: any = {};
    if (queryParams.sortBy) {
      sort[queryParams.sortBy] = queryParams.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.createdAt = -1;
    }

    const data = await this.bannerRepository.findAll(filter, { sort });
    return { data };
  }

  async update(id: string, data: UpdateBannerRequest): Promise<IBanner> {
    const banner = await this.bannerRepository.findById(id);
    
    if (!banner) {
      throw new AppError({
        status: 404,
        code: 'BANNER_NOT_FOUND',
        message: 'Banner not found',
      });
    }

    // Validate date range if both dates are provided
    const startDate = data.startDate || banner.startDate;
    const endDate = data.endDate || banner.endDate;
    
    if (startDate && endDate) {
      if (compareYyyymmdd(startDate, endDate) > 0) {
        throw new AppError({
          status: 400,
          code: 'INVALID_DATE_RANGE',
          message: 'Start date cannot be greater than end date',
        });
      }
    }

    const updated = await this.bannerRepository.update({ _id: id }, data);
    
    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update banner',
      });
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    const banner = await this.bannerRepository.findById(id);
    
    if (!banner) {
      throw new AppError({
        status: 404,
        code: 'BANNER_NOT_FOUND',
        message: 'Banner not found',
      });
    }

    await this.bannerRepository.delete({ _id: id });
  }

  async getByBannerType(bannerType: string): Promise<IBanner[]> {
    return this.bannerRepository.findByBannerType(bannerType);
  }

  async getActiveBanners(): Promise<IBanner[]> {
    return this.bannerRepository.findActiveBanners();
  }

  async getByTarget(target: string, targetId?: string): Promise<IBanner[]> {
    return this.bannerRepository.findByTarget(target, targetId);
  }

  async getByCorporateId(corporateId: string): Promise<IBanner[]> {
    return this.bannerRepository.findByCorporateId(corporateId);
  }
}
