import { Service } from 'typedi';
import { Model, Types } from 'mongoose';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import { IPharmacyCustomer, PharmacyCustomerQueryParams } from '@/modules/pharmacyCustomers/types';
import { BaseRepository } from '@/modules/common/repository';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';
import { pharmacyFacingHolderNames } from '@/modules/assisted/names';

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
      // Assisted booking (§6.2, §17.4): a pharmacy searches its customers by the name IT typed and the phone only,
      // never by the account's own name or email.
      pipeline.push({
        $match: {
          $or: [
            { typedName: search },
            { 'user.phone': search },
          ],
        },
      });
    }

    pipeline.push(
      { $sort: { createdAt: -1 } },
      { $project: { userId: { _id: '$user._id', accountName: '$user.name', phone: '$user.phone' }, typedName: 1, pharmacyId: 1, diseaseNotes: 1, chronicCondition: 1, recurringMedicine: 1, recurringIntervalDays: 1, preferredFollowUpDate: 1, pharmacyNotes: 1, createdByRole: 1, createdById: 1, consent: 1, createdAt: 1, updatedAt: 1 } },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limit }],
          metadata: [{ $count: 'total' }],
        },
      }
    );

    const [result] = await PharmacyCustomerModel.aggregate(pipeline);
    // §17.4: the response shape stays (`userId.name`, `userId.email`), but the name is the typed one (or the account
    // name masked, "Rina D.") and the email is never shown.
    const rows = (result?.data || []) as any[];
    // The phase 0 names rule (typed name, else an account this pharmacy opened and the holder never took over, else masked).
    const names = await pharmacyFacingHolderNames(rows.map((row) => row.userId?._id), params.pharmacyId);
    const data = rows.map((row) => {
      const { accountName: _a, ...user } = row.userId ?? {};
      return { ...row, userId: { ...user, name: user._id ? names.get(String(user._id).toLowerCase()) ?? null : null, email: null } };
    }) as IPharmacyCustomer[];
    const total = result?.metadata?.[0]?.total ?? 0;

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async isLinked(pharmacyId: string, userId: string): Promise<boolean> {
    const doc = await this.findOne({ pharmacyId, userId });
    return !!doc;
  }
}
