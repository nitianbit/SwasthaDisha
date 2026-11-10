import { Service } from 'typedi';
import { Model } from 'mongoose';
import PartnerModel from '@/modules/partners/model';
import { IPartner, PartnerQueryParams } from '@/modules/partners/types';
import { BaseRepository } from '@/modules/common/repository';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class PartnerRepository extends BaseRepository<IPartner> {
  constructor() {
    super(PartnerModel as Model<IPartner>);
  }

  async findByIdWithModel(id: string) {
    return PartnerModel.findById(id);
  }

  async findByPartnerType(partnerType: string): Promise<IPartner[]> {
    return this.findAll(
      { partnerType, isActive: true },
      { sort: { order: 1 } }
    );
  }

  async findVerifiedPartners(): Promise<IPartner[]> {
    return this.findAll(
      { isVerified: true, isActive: true },
      { sort: { order: 1 } }
    );
  }

  async findByCity(city: string): Promise<IPartner[]> {
    return this.findAll(
      { city, isActive: true },
      { sort: { order: 1 } }
    );
  }

  async findByState(state: string): Promise<IPartner[]> {
    return this.findAll(
      { state, isActive: true },
      { sort: { order: 1 } }
    );
  }

  async searchPartners(searchTerm: string): Promise<IPartner[]> {
    return PartnerModel.find({
      $text: { $search: searchTerm },
      isActive: true,
    })
      .sort({ score: { $meta: 'textScore' }, order: 1 })
      .lean();
  }

  async findWithPagination(
    filter: PartnerQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{
    data: IPartner[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const query: any = {};

    if (filter.name) {
      query.name = buildContainsRegex(filter.name);
    }

    if (filter.email) {
      query.email = buildContainsRegex(filter.email);
    }

    if (filter.partnerType) {
      query.partnerType = buildContainsRegex(filter.partnerType);
    }

    if (filter.isActive !== undefined) {
      query.isActive = filter.isActive;
    }

    if (filter.isVerified !== undefined) {
      query.isVerified = filter.isVerified;
    }

    if (filter.city) {
      query.city = buildContainsRegex(filter.city);
    }

    if (filter.state) {
      query.state = buildContainsRegex(filter.state);
    }

    if (filter.search) {
      query.$text = { $search: filter.search };
    }

    const skip = (page - 1) * limit;
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

    const [data, total] = await Promise.all([
      PartnerModel.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      PartnerModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async updateOrder(id: string, order: number): Promise<IPartner | null> {
    return this.update({ _id: id }, { order });
  }
}
