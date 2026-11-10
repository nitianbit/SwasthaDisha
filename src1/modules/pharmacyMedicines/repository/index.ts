import { Service } from 'typedi';
import { ClientSession, Model } from 'mongoose';
import MedicineModel from '@/modules/pharmacyMedicines/model';
import {
  IMedicine,
  MedicineQueryParams,
  NearbyMedicineDto,
  NearbyMedicineQueryParams,
} from '@/modules/pharmacyMedicines/types';
import { BaseRepository } from '@/modules/common/repository';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';
import { buildMedicineNameKey } from '@/modules/pharmacyMedicines/services/nameKeyMigration';
import { InventoryItemModel } from '@/modules/pharmacyInventory/model';

@Service()
export class MedicineRepository extends BaseRepository<IMedicine> {
  constructor() {
    super(MedicineModel as Model<IMedicine>);
  }

  async findByNormalizedName(name: string, session?: ClientSession): Promise<IMedicine[]> {
    const normalizedName = name.trim();
    const nameKey = buildMedicineNameKey(normalizedName);

    const query = MedicineModel.find({
      $or: [
        { nameKey },
        { name: new RegExp(`^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      ],
    });
    if (session) query.session(session);
    return query.lean();
  }

  buildFilterFromParams(filter: MedicineQueryParams = {}): any {
    const query: any = {};

    if (filter.name) query.name = buildContainsRegex(filter.name);
    if (filter.genericName) query.genericName = buildContainsRegex(filter.genericName);
    if (filter.brandName) query.brandName = buildContainsRegex(filter.brandName);
    if (filter.category) query.category = buildContainsRegex(filter.category);
    if (filter.dosageForm) query.dosageForm = filter.dosageForm;
    if (filter.manufacturer) query.manufacturer = buildContainsRegex(filter.manufacturer);
    if (filter.prescriptionRequired !== undefined) query.prescriptionRequired = filter.prescriptionRequired;
    if (filter.isActive !== undefined) query.isActive = filter.isActive;
    if (filter.search) {
      const regex = buildContainsRegex(filter.search);
      query.$or = [
        { name: regex },
        { genericName: regex },
        { brandName: regex },
        { category: regex },
        { manufacturer: regex },
      ];
    }

    return query;
  }

  buildSortFromParams(filter: MedicineQueryParams = {}): any {
    if (filter.sortBy) {
      return { [filter.sortBy]: filter.sortOrder === 'desc' ? -1 : 1 };
    }
    return { name: 1 };
  }

  async findWithPagination(
    filter: MedicineQueryParams = {},
    page: number = 1,
    limit: number = 20
  ): Promise<{ data: IMedicine[]; total: number; page: number; totalPages: number }> {
    const query = this.buildFilterFromParams(filter);
    const sort = this.buildSortFromParams(filter);
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      MedicineModel.find(query).sort(sort).skip(skip).limit(limit).lean(),
      MedicineModel.countDocuments(query),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async findNearbyAvailableMedicines(
    params: NearbyMedicineQueryParams,
    includeWholesalePrice: boolean
  ): Promise<{ data: NearbyMedicineDto[]; total: number; page: number; totalPages: number }> {
    const {
      latitude,
      longitude,
      radiusKm = 10,
      search,
      page = 1,
      limit = 20,
    } = params;

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
                          { $sin: { $multiply: ['$pharmacy.latitude', toRadians] } },
                          Math.sin(latitude * toRadians),
                        ],
                      },
                      {
                        $multiply: [
                          { $cos: { $multiply: ['$pharmacy.latitude', toRadians] } },
                          Math.cos(latitude * toRadians),
                          {
                            $cos: {
                              $multiply: [
                                { $subtract: ['$pharmacy.longitude', longitude] },
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

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const pipeline: any[] = [
      {
        $match: {
          isActive: true,
        },
      },
      {
        $addFields: {
          sellableAvailableQty: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ['$batches', []] } }, 0] },
              {
                $sum: {
                  $map: {
                    input: { $ifNull: ['$batches', []] },
                    as: 'batch',
                    in: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ['$$batch.status', 'active'] },
                            { $gte: ['$$batch.expiryDate', today] },
                          ],
                        },
                        '$$batch.availableQty',
                        0,
                      ],
                    },
                  },
                },
              },
              '$availableQty',
            ],
          },
        },
      },
      { $match: { sellableAvailableQty: { $gt: 0 } } },
      {
        $lookup: {
          from: 'pharmacies',
          localField: 'pharmacyId',
          foreignField: '_id',
          as: 'pharmacy',
        },
      },
      { $unwind: '$pharmacy' },
      {
        $match: {
          'pharmacy.isActive': true,
          'pharmacy.isVerified': true,
          'pharmacy.latitude': { $type: 'number' },
          'pharmacy.longitude': { $type: 'number' },
        },
      },
      {
        $lookup: {
          from: 'medicines',
          localField: 'medicineId',
          foreignField: '_id',
          as: 'medicine',
        },
      },
      { $unwind: '$medicine' },
      {
        $match: {
          'medicine.isActive': true,
        },
      },
      {
        $addFields: {
          distanceKm: distanceExpression,
        },
      },
      {
        $match: {
          distanceKm: { $lte: radiusKm },
        },
      },
    ];

    if (search) {
      const regex = buildContainsRegex(search);
      pipeline.push({
        $match: {
          $or: [
            { 'medicine.name': regex },
            { 'medicine.genericName': regex },
            { 'medicine.brandName': regex },
            { 'medicine.manufacturer': regex },
          ],
        },
      });
    }

    const groupStage: any = {
      _id: '$medicine._id',
      name: { $first: '$medicine.name' },
      genericName: { $first: '$medicine.genericName' },
      brandName: { $first: '$medicine.brandName' },
      category: { $first: '$medicine.category' },
      dosageForm: { $first: '$medicine.dosageForm' },
      strength: { $first: '$medicine.strength' },
      manufacturer: { $first: '$medicine.manufacturer' },
      prescriptionRequired: { $first: '$medicine.prescriptionRequired' },
      pharmacyIds: { $addToSet: '$pharmacy._id' },
      totalAvailableQty: { $sum: '$sellableAvailableQty' },
      minRetailPrice: { $min: '$retailPrice' },
      nearestDistanceKm: { $min: '$distanceKm' },
    };

    if (includeWholesalePrice) {
      groupStage.minWholesalePrice = { $min: '$wholesalePrice' };
    }

    pipeline.push({ $group: groupStage });
    pipeline.push({
      $addFields: {
        medicineId: { $toString: '$_id' },
        pharmacyCount: { $size: '$pharmacyIds' },
      },
    });

    const projection: any = {
      _id: 0,
      medicineId: 1,
      name: 1,
      genericName: 1,
      brandName: 1,
      category: 1,
      dosageForm: 1,
      strength: 1,
      manufacturer: 1,
      prescriptionRequired: 1,
      pharmacyCount: 1,
      totalAvailableQty: 1,
      minRetailPrice: 1,
      nearestDistanceKm: 1,
    };

    if (includeWholesalePrice) {
      projection.minWholesalePrice = 1;
    }

    const countPipeline = [...pipeline, { $count: 'total' }];
    const dataPipeline = [
      ...pipeline,
      { $sort: { nearestDistanceKm: 1, name: 1 } },
      { $project: projection },
      { $skip: (page - 1) * limit },
      { $limit: limit },
    ];

    const [data, countResult] = await Promise.all([
      InventoryItemModel.aggregate(dataPipeline),
      InventoryItemModel.aggregate(countPipeline),
    ]);

    const total = countResult[0]?.total ?? 0;
    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }
}
