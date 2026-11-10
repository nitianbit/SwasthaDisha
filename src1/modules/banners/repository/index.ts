import { Service } from 'typedi';
import { Model } from 'mongoose';
import BannerModel from '@/modules/banners/model';
import { IBanner, BannerQueryParams } from '@/modules/banners/types';
import { BaseRepository } from '@/modules/common/repository';
import { getTodayYyyymmdd, compareYyyymmdd } from '@/modules/common/utils/dateUtils';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class BannerRepository extends BaseRepository<IBanner> {
  constructor() {
    super(BannerModel as Model<IBanner>);
  }

  async findByBannerType(bannerType: string): Promise<IBanner[]> {
    const today = getTodayYyyymmdd();
    const query: any = {
      bannerType,
      isActive: true,
    };

    // Filter by date range if applicable
    const banners = await this.findAll(query, { sort: { createdAt: -1 } });
  
    // Filter banners that are within date range
    return banners.filter((banner) => {
      if (banner.startDate && compareYyyymmdd(today, banner.startDate) < 0) {
        return false; // Banner hasn't started yet
      }
      if (banner.endDate && compareYyyymmdd(today, banner.endDate) > 0) {
        return false; // Banner has expired
      }
      return true;
    });
  }

  async findActiveBanners(): Promise<IBanner[]> {
    const today = getTodayYyyymmdd();
    const query: any = {
      isActive: true,
    };

    const banners = await this.findAll(query, { sort: { createdAt: -1 } });
    
    // Filter banners that are within date range
    return banners.filter((banner) => {
      if (banner.startDate && compareYyyymmdd(today, banner.startDate) < 0) {
        return false; // Banner hasn't started yet
      }
      if (banner.endDate && compareYyyymmdd(today, banner.endDate) > 0) {
        return false; // Banner has expired
      }
      return true;
    });
  }

  async findByTarget(target: string, targetId?: string): Promise<IBanner[]> {
    const today = getTodayYyyymmdd();
    const query: any = {
      target,
      isActive: true,
    };

    if (targetId) {
      query.targetId = targetId;
    }

    const banners = await this.findAll(query, { sort: { createdAt: -1 } });
    
    // Filter banners that are within date range
    return banners.filter((banner) => {
      if (banner.startDate && compareYyyymmdd(today, banner.startDate) < 0) {
        return false; // Banner hasn't started yet
      }
      if (banner.endDate && compareYyyymmdd(today, banner.endDate) > 0) {
        return false; // Banner has expired
      }
      return true;
    });
  }

  async findByCorporateId(corporateId: string): Promise<IBanner[]> {
    const today = getTodayYyyymmdd();
    const query: any = {
      corporateId,
      isActive: true,
    };

    const banners = await this.findAll(query, { sort: { createdAt: -1 } });
    
    // Filter banners that are within date range
    return banners.filter((banner) => {
      if (banner.startDate && compareYyyymmdd(today, banner.startDate) < 0) {
        return false; // Banner hasn't started yet
      }
      if (banner.endDate && compareYyyymmdd(today, banner.endDate) > 0) {
        return false; // Banner has expired
      }
      return true;
    });
  }

  async findWithPagination(
    filter: BannerQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{ data: IBanner[]; total: number; page: number; totalPages: number }> {
    const query: any = {};
    
    if (filter.title) {
      query.title = buildContainsRegex(filter.title);
    }

    if (filter.bannerType) {
      query.bannerType = filter.bannerType;
    }
    
    if (filter.target) {
      query.target = buildContainsRegex(filter.target);
    }
    
    if (filter.targetId) {
      query.targetId = filter.targetId;
    }
    
    if (filter.forUser) {
      // For user lists, only return banners not tied to any corporate
      query.corporateId = { $exists: false };
    } else if (filter.corporateId) {
      query.corporateId = filter.corporateId;
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
      BannerModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }
}
