import { Service } from 'typedi';
import { Model } from 'mongoose';
import BranchModel from '@/modules/partners/model/branch';
import { IBranch } from '@/modules/partners/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class BranchRepository extends BaseRepository<IBranch> {
  constructor() {
    super(BranchModel as Model<IBranch>);
  }

  async findActiveByPartner(partnerId: string): Promise<IBranch[]> {
    return this.findAll(
      { partnerId, isActive: true },
      { sort: { name: 1 } }
    );
  }

  async findNearby(
    longitude: number,
    latitude: number,
    maxDistanceMeters: number = 10000
  ): Promise<IBranch[]> {
    return BranchModel.find({
      isActive: true,
      geo: {
        $near: {
          $geometry: { type: 'Point', coordinates: [longitude, latitude] },
          $maxDistance: maxDistanceMeters,
        },
      },
    }).lean();
  }
}
