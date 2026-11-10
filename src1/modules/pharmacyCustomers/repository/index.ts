import { Service } from 'typedi';
import { Model, Types } from 'mongoose';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import { IPharmacyCustomer, PharmacyCustomerQueryParams } from '@/modules/pharmacyCustomers/types';
import { BaseRepository } from '@/modules/common/repository';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class PharmacyCustomerRepository extends BaseRepository<IPharmacyCustomer> {
  constructor() {
    super(PharmacyCustomerModel as Model<IPharmacyCustomer>);
  }

  async findByPharmacyAndUser(pharmacyId: string, userId: string): Promise<IPharmacyCustomer | null> {
    return this.findOne({ pharmacyId, userId });
  }

  async findWithPagination(
    params: PharmacyCustomerQueryParams,
    page: number = 1,
    limit: number = 20
  ): Promise<{ data: IPharmacyCustomer[]; total: number; page: number; totalPages: number }> {
    const skip = (page - 1) * limit;
    const pipeline: any[] = [
      { $match: { pharmacyId: new Types.ObjectId(params.pharmacyId) } },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    ];

    if (params.search) {
      const search = buildContainsRegex(params.search);
      pipeline.push({
        $match: {
          $or: [
            { pharmacyNotes: search },
            { diseaseNotes: search },
            { 'user.name': search },
            { 'user.phone': search },
            { 'user.email': search },
          ],
        },
      });
    }

    pipeline.push(
      { $sort: { createdAt: -1 } },
      { $project: { userId: { _id: '$user._id', name: '$user.name', phone: '$user.phone', email: '$user.email' }, pharmacyId: 1, diseaseNotes: 1, chronicCondition: 1, recurringMedicine: 1, recurringIntervalDays: 1, preferredFollowUpDate: 1, pharmacyNotes: 1, createdByRole: 1, createdById: 1, createdAt: 1, updatedAt: 1 } },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limit }],
          metadata: [{ $count: 'total' }],
        },
      }
    );

    const [result] = await PharmacyCustomerModel.aggregate(pipeline);
    const data = (result?.data || []) as IPharmacyCustomer[];
    const total = result?.metadata?.[0]?.total ?? 0;

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async isLinked(pharmacyId: string, userId: string): Promise<boolean> {
    const doc = await this.findOne({ pharmacyId, userId });
    return !!doc;
  }
}
