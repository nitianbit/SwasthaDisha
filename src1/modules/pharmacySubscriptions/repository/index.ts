import { Service } from 'typedi';
import { Model } from 'mongoose';
import PharmacySubscriptionModel from '@/modules/pharmacySubscriptions/model';
import { IPharmacySubscription, SubscriptionQueryParams } from '@/modules/pharmacySubscriptions/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class PharmacySubscriptionRepository extends BaseRepository<IPharmacySubscription> {
  constructor() {
    super(PharmacySubscriptionModel as Model<IPharmacySubscription>);
  }

  async findWithPagination(
    filter: SubscriptionQueryParams,
    page = 1,
    limit = 20
  ): Promise<{ data: IPharmacySubscription[]; total: number; page: number; totalPages: number }> {
    const query: any = {};
    if (filter.pharmacyId) query.pharmacyId = filter.pharmacyId;
    if (filter.userId) query.userId = filter.userId;
    if (filter.medicineId) query.medicineId = filter.medicineId;
    if (filter.isActive !== undefined) query.isActive = filter.isActive;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      PharmacySubscriptionModel.find(query)
        .populate('medicineId', 'name genericName')
        .populate('userId', 'name phone')
        .sort({ nextRefillDate: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PharmacySubscriptionModel.countDocuments(query),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async findBySourceOrderId(sourceOrderId: string): Promise<IPharmacySubscription[]> {
    return PharmacySubscriptionModel.find({ sourceOrderId }).lean();
  }
}
