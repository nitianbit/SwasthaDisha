import { Service } from 'typedi';
import { Model } from 'mongoose';
import PharmacyModel from '@/modules/pharmacies/model';
import { IPharmacy, PharmacyQueryParams } from '@/modules/pharmacies/types';
import { BaseRepository } from '@/modules/common/repository';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class PharmacyRepository extends BaseRepository<IPharmacy> {
  constructor() {
    super(PharmacyModel as Model<IPharmacy>);
  }

  buildFilterFromParams(filter: PharmacyQueryParams = {}): any {
    const query: any = {};

    if (filter.name) {
      query.name = buildContainsRegex(filter.name);
    }

    if (filter.city) {
      query.city = buildContainsRegex(filter.city);
    }

    if (filter.state) {
      query.state = buildContainsRegex(filter.state);
    }

    if (filter.pincode) {
      query.pincode = filter.pincode;
    }

    if (filter.isVerified !== undefined) {
      query.isVerified = filter.isVerified;
    }

    if (filter.isActive !== undefined) {
      query.isActive = filter.isActive;
    }

    if (filter.pickupAvailable !== undefined) {
      query.pickupAvailable = filter.pickupAvailable;
    }

    if (filter.deliveryAvailable !== undefined) {
      query.deliveryAvailable = filter.deliveryAvailable;
    }

    if (filter.search) {
      query.$text = { $search: filter.search };
    }

    return query;
  }

  buildSortFromParams(filter: PharmacyQueryParams = {}): any {
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.createdAt = -1;
    }

    if (filter.search) {
      sort.score = { $meta: 'textScore' };
    }

    return sort;
  }

  async findWithPagination(
    filter: PharmacyQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{
    data: IPharmacy[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const query = this.buildFilterFromParams(filter);
    const skip = (page - 1) * limit;
    const sort = this.buildSortFromParams(filter);

    const [data, total] = await Promise.all([
      PharmacyModel.find(query).sort(sort).skip(skip).limit(limit).lean(),
      PharmacyModel.countDocuments(query),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async findNearby(params: PharmacyQueryParams): Promise<{
    data: IPharmacy[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const {
      latitude,
      longitude,
      radiusKm = 10,
      page = 1,
      limit = 20,
    } = params;

    if (latitude === undefined || longitude === undefined) {
      return { data: [], total: 0, page, totalPages: 0 };
    }

    const query = this.buildFilterFromParams(params);
    const skip = (page - 1) * limit;
    query.latitude = { $type: 'number' };
    query.longitude = { $type: 'number' };

    // Great-circle distance (spherical law of cosines), so longitude scale
    // is correct at every latitude and pagination happens after distance sort.
    const toRadians = Math.PI / 180;
    const distanceExpression = {
      $multiply: [
        6371,
        {
          $acos: {
            $min: [
              1,
              {
                $max: [
                  -1,
                  {
                    $add: [
                      {
                        $multiply: [
                          { $sin: { $multiply: ['$latitude', toRadians] } },
                          Math.sin(latitude * toRadians),
                        ],
                      },
                      {
                        $multiply: [
                          { $cos: { $multiply: ['$latitude', toRadians] } },
                          Math.cos(latitude * toRadians),
                          {
                            $cos: {
                              $multiply: [
                                { $subtract: ['$longitude', longitude] },
                                toRadians,
                              ],
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    };

    const [result] = await PharmacyModel.aggregate([
      { $match: query },
      { $addFields: { _distanceKm: distanceExpression } },
      { $match: { _distanceKm: { $lte: radiusKm } } },
      { $sort: { _distanceKm: 1, createdAt: -1 } },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limit }],
          metadata: [{ $count: 'total' }],
        },
      },
    ]);
    const data = (result?.data || []) as IPharmacy[];
    const total = result?.metadata?.[0]?.total ?? 0;

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findByPhone(phone: string): Promise<IPharmacy | null> {
    return this.findOne({ phone: phone.trim() });
  }

  async findByEmail(email: string): Promise<IPharmacy | null> {
    return this.findOne({ email: email.trim().toLowerCase() });
  }
}
