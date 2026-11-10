import { Service } from 'typedi';
import { Model } from 'mongoose';
import AddressModel from '@/modules/addresses/model';
import { BaseRepository } from '@/modules/common/repository';
import { IAddress, AddressQueryParams } from '@/modules/addresses/types';

@Service()
export class AddressRepository extends BaseRepository<IAddress> {
  constructor() {
    super(AddressModel as Model<IAddress>);
  }

  async findByUserId(userId: string): Promise<IAddress[]> {
    return this.findAll({ userId }, { sort: { isDefault: -1, createdAt: -1 } });
  }

  async findDefaultByUserId(userId: string): Promise<IAddress | null> {
    return this.findOne({ userId, isDefault: true, isActive: true });
  }

  async unsetDefaultForUser(userId: string, excludeId?: string): Promise<void> {
    const query: any = { userId, isDefault: true };

    if (excludeId) {
      query._id = { $ne: excludeId };
    }

    await this.updateMany(query, { $set: { isDefault: false } });
  }

  async findWithPagination(
    filter: AddressQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{
    data: IAddress[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const query: any = {};

    if (filter.userId) {
      query.userId = filter.userId;
    }

    if (filter.type) {
      query.type = filter.type;
    }

    if (filter.isDefault !== undefined) {
      query.isDefault = filter.isDefault;
    }

    if (filter.isActive !== undefined) {
      query.isActive = filter.isActive;
    }

    const skip = (page - 1) * limit;
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.isDefault = -1;
      sort.createdAt = -1;
    }

    const [data, total] = await Promise.all([
      AddressModel.find(query).sort(sort).skip(skip).limit(limit).lean(),
      AddressModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }
}
