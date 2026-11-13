import { Service } from 'typedi';
import { rearmLowStock, rearmStage, sellableQtyExpr } from '@/modules/pharmacyInventory/sellable';
import { ClientSession, Model, PipelineStage, Types } from 'mongoose';
import {
  InventoryItemModel,
  InventoryAdjustmentModel,
  InventoryReservationModel,
} from '@/modules/pharmacyInventory/model';
import {
  IInventoryItem,
  IInventoryAdjustment,
  IInventoryReservation,
  IInventoryBatchAllocation,
  InventoryQueryParams,
  INVENTORY_QUALITY_HOLD_STATUSES,
  InventoryQualityHoldStatus,
  InventoryQualityWorklistPage,
  InventoryQualityWorklistRow,
  PublicInventoryItemDto,
  PublicInventoryQueryParams,
} from '@/modules/pharmacyInventory/types';
import { PharmacyMedicineAvailabilityDto } from '@/modules/pharmacies/types';
import { BaseRepository } from '@/modules/common/repository';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';
import { AppError } from '@/modules/common/types';

@Service()
export class InventoryItemRepository extends BaseRepository<IInventoryItem> {
  constructor() {
    super(InventoryItemModel as Model<IInventoryItem>);
  }

  async findByPharmacyAndMedicine(
    pharmacyId: string,
    medicineId: string,
    session?: ClientSession
  ): Promise<IInventoryItem | null> {
    return this.findOne({ pharmacyId, medicineId }, session);
  }

  async adjustBatchStock(
    pharmacyId: string,
    medicineId: string,
    input: {
      batchNumber: string;
      expiryDate: string;
      quantityDelta: number;
      purchasePrice?: number;
      mrp?: number;
      retailPrice?: number;
      wholesalePrice?: number;
      reorderThreshold?: number;
      rackLocation?: string;
    },
    session: ClientSession
  ): Promise<{
    item: IInventoryItem;
    batchId: string;
    availableQtyBefore: number;
    availableQtyAfter: number;
  } | null> {
    let document = await InventoryItemModel.findOne({ pharmacyId, medicineId }).session(session);

    if (!document) {
      if (input.quantityDelta < 0) {
        return null;
      }
      document = new InventoryItemModel({
        pharmacyId,
        medicineId,
        availableQty: 0,
        reservedQty: 0,
        freeQty: 0,
        batches: [],
        isActive: true,
      });
      document.$session(session);
    }

    const batches = document.batches || [];
    let batch = batches.find(
      (candidate) =>
        candidate.batchNumber === input.batchNumber && candidate.expiryDate === input.expiryDate
    );

    if (!batch) {
      if (input.quantityDelta < 0) {
        return null;
      }
      document.batches!.push({
        batchNumber: input.batchNumber,
        expiryDate: input.expiryDate,
        receivedAt: new Date(),
        availableQty: 0,
        reservedQty: 0,
        freeQty: 0,
        purchasePrice: input.purchasePrice,
        mrp: input.mrp,
        retailPrice: input.retailPrice,
        wholesalePrice: input.wholesalePrice,
        status: 'active',
      });
      batch = document.batches![document.batches!.length - 1];
    }

    const availableQtyBefore = batch.availableQty;
    const availableQtyAfter = availableQtyBefore + input.quantityDelta;
    if (availableQtyAfter < 0 || document.availableQty + input.quantityDelta < 0) {
      return null;
    }

    batch.availableQty = availableQtyAfter;
    batch.purchasePrice = input.purchasePrice ?? batch.purchasePrice;
    batch.mrp = input.mrp ?? batch.mrp;
    batch.retailPrice = input.retailPrice ?? batch.retailPrice;
    batch.wholesalePrice = input.wholesalePrice ?? batch.wholesalePrice;
    if (
      batch.status !== 'recalled' &&
      batch.status !== 'quarantined' &&
      batch.status !== 'expired'
    ) {
      batch.status = availableQtyAfter === 0 && batch.reservedQty === 0 ? 'depleted' : 'active';
      batch.depletedAt = batch.status === 'depleted' ? new Date() : undefined;
    }

    document.availableQty += input.quantityDelta;
    document.reorderThreshold = input.reorderThreshold ?? document.reorderThreshold;
    document.rackLocation = input.rackLocation ?? document.rackLocation;
    document.purchasePrice = input.purchasePrice ?? document.purchasePrice;
    document.retailPrice = input.retailPrice ?? document.retailPrice;
    document.wholesalePrice = input.wholesalePrice ?? document.wholesalePrice;
    document.isActive = true;
    document.markModified('batches');

    const saved = await document.save({ session });
    await rearmLowStock(pharmacyId, medicineId, session);
    return {
      item: saved.toObject() as IInventoryItem,
      batchId: String((batch as any)._id),
      availableQtyBefore,
      availableQtyAfter,
    };
  }

  async reserveBatches(
    pharmacyId: string,
    medicineId: string,
    quantity: number,
    session: ClientSession
  ): Promise<{ item: IInventoryItem; allocations: IInventoryBatchAllocation[] } | null> {
    const document = await InventoryItemModel.findOne({
      pharmacyId,
      medicineId,
      isActive: true,
    }).session(session);
    if (!document) return null;

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const eligible = (document.batches || [])
      .filter(
        (batch) =>
          batch.status === 'active' && batch.expiryDate >= today && batch.availableQty > 0
      )
      .sort((a, b) =>
        a.expiryDate.localeCompare(b.expiryDate) ||
        a.receivedAt.getTime() - b.receivedAt.getTime() ||
        String((a as any)._id).localeCompare(String((b as any)._id))
      );

    if (eligible.reduce((sum, batch) => sum + batch.availableQty, 0) < quantity) {
      return null;
    }

    let remaining = quantity;
    const allocations: IInventoryBatchAllocation[] = [];
    for (const batch of eligible) {
      if (remaining === 0) break;
      const allocated = Math.min(remaining, batch.availableQty);
      batch.availableQty -= allocated;
      batch.reservedQty += allocated;
      allocations.push({
        batchId: String((batch as any)._id),
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        quantity: allocated,
      });
      remaining -= allocated;
    }

    document.availableQty -= quantity;
    document.reservedQty += quantity;
    document.markModified('batches');
    const saved = await document.save({ session });
    return { item: saved.toObject() as IInventoryItem, allocations };
  }

  async releaseBatchAllocations(
    pharmacyId: string,
    medicineId: string,
    allocations: IInventoryBatchAllocation[],
    session: ClientSession
  ): Promise<IInventoryItem | null> {
    const document = await InventoryItemModel.findOne({ pharmacyId, medicineId }).session(session);
    if (!document) return null;

    let total = 0;
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    for (const allocation of allocations) {
      const batch = (document.batches || []).find(
        (candidate) => String((candidate as any)._id) === String(allocation.batchId)
      );
      if (!batch || batch.reservedQty < allocation.quantity) return null;
      batch.reservedQty -= allocation.quantity;
      batch.availableQty += allocation.quantity;
      if (
        batch.status !== 'recalled' &&
        batch.status !== 'quarantined' &&
        batch.status !== 'expired'
      ) {
        batch.status = batch.expiryDate < today ? 'expired' : 'active';
        batch.depletedAt = undefined;
      }
      total += allocation.quantity;
    }

    if (document.reservedQty < total) return null;
    document.reservedQty -= total;
    document.availableQty += total;
    document.markModified('batches');
    const saved = await document.save({ session });
    await rearmLowStock(pharmacyId, medicineId, session);
    return saved.toObject() as IInventoryItem;
  }

  async consumeBatchAllocations(
    pharmacyId: string,
    medicineId: string,
    allocations: IInventoryBatchAllocation[],
    session: ClientSession
  ): Promise<IInventoryItem | null> {
    const document = await InventoryItemModel.findOne({ pharmacyId, medicineId }).session(session);
    if (!document) return null;

    let total = 0;
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    for (const allocation of allocations) {
      const batch = (document.batches || []).find(
        (candidate) => String((candidate as any)._id) === String(allocation.batchId)
      );
      if (
        !batch ||
        batch.status !== 'active' ||
        batch.expiryDate < today ||
        batch.reservedQty < allocation.quantity
      ) return null;
      batch.reservedQty -= allocation.quantity;
      if (batch.availableQty === 0 && batch.reservedQty === 0) {
        batch.status = 'depleted';
        batch.depletedAt = new Date();
      }
      total += allocation.quantity;
    }

    if (document.reservedQty < total) return null;
    document.reservedQty -= total;
    document.markModified('batches');
    const saved = await document.save({ session });
    return saved.toObject() as IInventoryItem;
  }

  async insertMany(items: Partial<IInventoryItem>[]): Promise<IInventoryItem[]> {
    const docs = await InventoryItemModel.insertMany(items, { ordered: true });
    return docs.map((doc) => doc.toObject());
  }

  // Single atomic create-or-update for one pharmacy/medicine pair. Adds
  // quantityDelta to availableQty (clamped at 0) and overwrites only the
  // provided fields, so concurrent saves cannot double-insert or overwrite
  // each other's quantity math. Pipeline update: the upsert base document is
  // built from the filter's equality fields (pharmacyId, medicineId).
  async atomicUpsertItem(
    pharmacyId: string,
    medicineId: string,
    quantityDelta: number,
    fields: Partial<IInventoryItem>,
    session?: ClientSession
  ): Promise<IInventoryItem> {
    const setStage: Record<string, unknown> = {
      availableQty: {
        $max: [0, { $add: [{ $ifNull: ['$availableQty', 0] }, quantityDelta] }],
      },
      reservedQty: { $ifNull: ['$reservedQty', 0] },
      freeQty: { $ifNull: ['$freeQty', 0] },
      reorderThreshold: { $ifNull: ['$reorderThreshold', 0] },
      createdAt: { $ifNull: ['$createdAt', '$$NOW'] },
      updatedAt: '$$NOW',
    };

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        setStage[key] = { $literal: value };
      }
    }

    const item = await InventoryItemModel.findOneAndUpdate(
      {
        pharmacyId: new Types.ObjectId(pharmacyId),
        medicineId: new Types.ObjectId(medicineId),
      },
      [{ $set: setStage }, rearmStage()] as any,
      { new: true, upsert: true, session }
    ).lean();

    return item as IInventoryItem;
  }

  async findQualityHolds(pharmacyId: unknown, query: unknown): Promise<InventoryQualityWorklistPage> {
    if (typeof pharmacyId !== 'string' || !/^[0-9a-f]{24}$/.test(pharmacyId)) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
    const invalidQuery = () => new AppError({
      status: 400, code: 'VALIDATION_ERROR', message: 'Invalid quality worklist query',
    });
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      !!value && typeof value === 'object' && !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).every(key => typeof key === 'string' && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
    if (!isRecord(query)) throw invalidQuery();
    for (const key of Reflect.ownKeys(query)) {
      if (
        typeof key !== 'string' || !['qualityStatus', 'page', 'limit'].includes(key) ||
        !('value' in Object.getOwnPropertyDescriptor(query, key)!)
      ) throw invalidQuery();
    }
    const qualityStatus = Object.getOwnPropertyDescriptor(query, 'qualityStatus')?.value;
    const requestedPage = Object.getOwnPropertyDescriptor(query, 'page')?.value;
    const requestedLimit = Object.getOwnPropertyDescriptor(query, 'limit')?.value;
    const page = requestedPage === undefined ? 1 : requestedPage;
    const limit = requestedLimit === undefined ? 20 : requestedLimit;
    if (
      (qualityStatus !== undefined && !INVENTORY_QUALITY_HOLD_STATUSES.some(status => status === qualityStatus)) ||
      typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > 1000 ||
      typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
    ) throw invalidQuery();
    const statuses = qualityStatus === undefined
      ? [...INVENTORY_QUALITY_HOLD_STATUSES]
      : [qualityStatus as InventoryQualityHoldStatus];
    const skip = (page - 1) * limit;
    const pipeline: PipelineStage[] = [
      {
        $match: {
          pharmacyId: new Types.ObjectId(pharmacyId),
          batches: { $elemMatch: { status: { $in: statuses } } },
          $expr: { $and: [{ $isArray: '$batches' }, { $eq: [{ $type: '$pharmacyId' }, 'objectId'] }] },
        },
      },
      {
        $project: {
          _id: 1, medicineId: 1, isActive: 1, rackLocation: 1,
          batches: {
            $map: {
              input: '$batches', as: 'batch',
              in: {
                _id: '$$batch._id', batchNumber: '$$batch.batchNumber', expiryDate: '$$batch.expiryDate',
                status: '$$batch.status', availableQty: '$$batch.availableQty',
                reservedQty: '$$batch.reservedQty', freeQty: '$$batch.freeQty',
              },
            },
          },
        },
      },
      { $unwind: { path: '$batches', includeArrayIndex: 'batchPosition' } },
      { $match: { 'batches.status': { $in: statuses }, $expr: { $eq: [{ $type: '$batches.status' }, 'string'] } } },
      {
        $facet: {
          metadata: [{ $count: 'total' }],
          data: [
            { $sort: { _id: 1, batchPosition: 1 } },
            { $skip: skip },
            { $limit: limit },
            {
              $lookup: {
                from: 'medicines', let: { medicineId: '$medicineId' },
                pipeline: [
                  { $match: { $expr: { $eq: ['$_id', '$$medicineId'] } } },
                  { $project: { _id: 0, name: 1 } },
                  { $limit: 1 },
                ],
                as: 'medicine',
              },
            },
            {
              $project: {
                _id: 0, inventoryItemId: '$_id', medicineId: 1,
                medicineName: { $arrayElemAt: ['$medicine.name', 0] },
                inventoryIsActive: '$isActive', rackLocation: 1,
                batchId: '$batches._id', batchPosition: 1,
                batchNumberRaw: '$batches.batchNumber', expiryDateRaw: '$batches.expiryDate',
                storedQualityStatus: '$batches.status', availableQty: '$batches.availableQty',
                reservedQty: '$batches.reservedQty', freeQty: '$batches.freeQty',
              },
            },
          ],
        },
      },
    ];
    const result = await InventoryItemModel.aggregate<unknown>(pipeline)
      .option({ maxTimeMS: 2000, allowDiskUse: false }).exec();
    const unavailable = () => new AppError({
      status: 503, code: 'QUALITY_WORKLIST_UNAVAILABLE', message: 'Quality worklist is unavailable',
    });
    if (!Array.isArray(result) || result.length !== 1) throw unavailable();
    const facet = result[0];
    if (
      !isRecord(facet) || Reflect.ownKeys(facet).length !== 2 ||
      !Array.isArray(facet.data) || !Array.isArray(facet.metadata) ||
      facet.metadata.length > 1 || facet.data.length > limit
    ) throw unavailable();
    let total = 0;
    if (facet.metadata.length) {
      const count = facet.metadata[0];
      if (!isRecord(count) || Reflect.ownKeys(count).length !== 1 || typeof count.total !== 'number' || !Number.isSafeInteger(count.total) || count.total < 0) throw unavailable();
      total = count.total;
    }
    if (facet.data.length !== Math.min(limit, Math.max(0, total - skip))) throw unavailable();
    const objectId = (value: unknown): string | null => value instanceof Types.ObjectId ? value.toHexString() : null;
    const text = (value: unknown, max: number): string | null => typeof value === 'string' && value.length <= max ? value : null;
    const quantity = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    const data: InventoryQualityWorklistRow[] = facet.data.map((row: unknown) => {
      if (!isRecord(row)) throw unavailable();
      const inventoryItemId = objectId(row.inventoryItemId);
      const storedQualityStatus = statuses.find(status => status === row.storedQualityStatus);
      if (!inventoryItemId || storedQualityStatus === undefined || typeof row.batchPosition !== 'number' || !Number.isSafeInteger(row.batchPosition) || row.batchPosition < 0) throw unavailable();
      return {
        inventoryItemId, medicineId: objectId(row.medicineId), medicineName: text(row.medicineName, 200),
        inventoryIsActive: typeof row.inventoryIsActive === 'boolean' ? row.inventoryIsActive : null,
        rackLocation: text(row.rackLocation, 100), batchId: objectId(row.batchId), batchPosition: row.batchPosition,
        batchNumberRaw: text(row.batchNumberRaw, 100), expiryDateRaw: text(row.expiryDateRaw, 32),
        storedQualityStatus, availableQty: quantity(row.availableQty), reservedQty: quantity(row.reservedQty), freeQty: quantity(row.freeQty),
      };
    });
    return { data, page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  async findWithPagination(
    filter: InventoryQueryParams,
    page: number = 1,
    limit: number = 20
  ): Promise<{ data: IInventoryItem[]; total: number; page: number; totalPages: number }> {
    const query: any = {};
    if (filter.pharmacyId) query.pharmacyId = new Types.ObjectId(filter.pharmacyId);
    if (filter.medicineId) query.medicineId = new Types.ObjectId(filter.medicineId);
    if (filter.isActive !== undefined) query.isActive = filter.isActive;
    if (filter.lowStock) {
      // Sellable stock (active, unexpired batches), not the raw total (P7c).
      query.$expr = { $lte: [sellableQtyExpr(), '$reorderThreshold'] };
    }

    const skip = (page - 1) * limit;
    const pipeline: any[] = [{ $match: query }];

    if (filter.search) {
      const regex = buildContainsRegex(filter.search);
      pipeline.push(
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
            $or: [
              { 'medicine.name': regex },
              { 'medicine.genericName': regex },
              { 'medicine.brandName': regex },
              { 'medicine.category': regex },
              { 'medicine.manufacturer': regex },
            ],
          },
        }
      );
    }

    const countPipeline = [...pipeline, { $count: 'total' }];
    const dataPipeline = [
      ...pipeline,
      { $sort: { updatedAt: -1 } },
      { $skip: skip },
      { $limit: limit },
    ];

    if (filter.search) {
      dataPipeline.push({
        $addFields: {
          medicineId: {
            _id: '$medicine._id',
            name: '$medicine.name',
            genericName: '$medicine.genericName',
            brandName: '$medicine.brandName',
            dosageForm: '$medicine.dosageForm',
            strength: '$medicine.strength',
          },
        },
      });
      dataPipeline.push({ $project: { medicine: 0 } });
    } else {
      dataPipeline.push({
        $lookup: {
          from: 'medicines',
          localField: 'medicineId',
          foreignField: '_id',
          as: 'medicine',
        },
      });
      dataPipeline.push({ $unwind: { path: '$medicine', preserveNullAndEmptyArrays: true } });
      dataPipeline.push({
        $addFields: {
          medicineId: {
            _id: '$medicine._id',
            name: '$medicine.name',
            genericName: '$medicine.genericName',
            brandName: '$medicine.brandName',
            dosageForm: '$medicine.dosageForm',
            strength: '$medicine.strength',
          },
        },
      });
      dataPipeline.push({ $project: { medicine: 0 } });
    }

    const [data, countResult] = await Promise.all([
      InventoryItemModel.aggregate(dataPipeline),
      InventoryItemModel.aggregate(countPipeline),
    ]);

    const total = countResult[0]?.total ?? 0;

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async findMedicineAvailability(
    {
      medicineId,
      latitude,
      longitude,
      radiusKm,
      page = 1,
      limit = 20,
    }: {
      medicineId: string;
      latitude?: number;
      longitude?: number;
      radiusKm?: number;
      page?: number;
      limit?: number;
    },
    includeWholesalePrice: boolean
  ): Promise<{
    data: PharmacyMedicineAvailabilityDto[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const sellableBatchQuantity = {
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
    };
    const pipeline: any[] = [
      {
        $match: {
          medicineId: new Types.ObjectId(medicineId),
          isActive: true,
        },
      },
      {
        $addFields: {
          sellableAvailableQty: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ['$batches', []] } }, 0] },
              sellableBatchQuantity,
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
    ];

    if (latitude !== undefined && longitude !== undefined) {
      const toRadians = Math.PI / 180;
      pipeline.push({
        $match: {
          'pharmacy.latitude': { $type: 'number' },
          'pharmacy.longitude': { $type: 'number' },
        },
      });
      pipeline.push({
        $addFields: {
          distanceKm: {
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
          },
        },
      });

      if (radiusKm !== undefined) {
        pipeline.push({
          $match: {
            distanceKm: { $lte: radiusKm },
          },
        });
      }
    }

    const projection: Record<string, unknown> = {
      _id: 0,
      pharmacyId: { $toString: '$pharmacy._id' },
      medicineId: { $toString: '$medicine._id' },
      pharmacyName: '$pharmacy.name',
      pharmacyNickname: '$pharmacy.nickname',
      address: '$pharmacy.address',
      city: '$pharmacy.city',
      state: '$pharmacy.state',
      pincode: '$pharmacy.pincode',
      latitude: '$pharmacy.latitude',
      longitude: '$pharmacy.longitude',
      profilePictureUrl: '$pharmacy.profilePictureUrl',
      pickupAvailable: '$pharmacy.pickupAvailable',
      deliveryAvailable: '$pharmacy.deliveryAvailable',
      medicineName: '$medicine.name',
      genericName: '$medicine.genericName',
      brandName: '$medicine.brandName',
      dosageForm: '$medicine.dosageForm',
      strength: '$medicine.strength',
      manufacturer: '$medicine.manufacturer',
      availableQty: '$sellableAvailableQty',
      retailPrice: '$retailPrice',
      distanceKm: '$distanceKm',
    };

    if (includeWholesalePrice) {
      projection.wholesalePrice = '$wholesalePrice';
    }

    const sortStage =
      latitude !== undefined && longitude !== undefined
        ? { distanceKm: 1, retailPrice: 1, updatedAt: -1 }
        : { retailPrice: 1, updatedAt: -1 };

    const countPipeline = [...pipeline, { $count: 'total' }];
    const dataPipeline = [
      ...pipeline,
      { $sort: sortStage },
      { $project: projection },
      { $skip: (page - 1) * limit },
      { $limit: limit },
    ];

    const [data, countResult] = await Promise.all([
      InventoryItemModel.aggregate(dataPipeline),
      InventoryItemModel.aggregate(countPipeline),
    ]);

    const total = countResult[0]?.total ?? 0;
    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findPublicInventoryByPharmacy(
    {
      pharmacyId,
      search,
      page = 1,
      limit = 20,
    }: PublicInventoryQueryParams,
    includeWholesalePrice: boolean
  ): Promise<{
    data: PublicInventoryItemDto[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const pipeline: any[] = [
      {
        $match: {
          pharmacyId: new Types.ObjectId(pharmacyId),
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
            { 'medicine.category': regex },
          ],
        },
      });
    }

    const projection: Record<string, unknown> = {
      _id: 0,
      inventoryItemId: { $toString: '$_id' },
      pharmacyId: { $toString: '$pharmacyId' },
      medicineId: { $toString: '$medicine._id' },
      name: '$medicine.name',
      genericName: '$medicine.genericName',
      brandName: '$medicine.brandName',
      category: '$medicine.category',
      dosageForm: '$medicine.dosageForm',
      strength: '$medicine.strength',
      manufacturer: '$medicine.manufacturer',
      prescriptionRequired: '$medicine.prescriptionRequired',
      availableQty: '$sellableAvailableQty',
      retailPrice: '$retailPrice',
      batchNumber: '$batchNumber',
      expiryDate: '$expiryDate',
    };

    if (includeWholesalePrice) {
      projection.wholesalePrice = '$wholesalePrice';
    }

    const countPipeline = [...pipeline, { $count: 'total' }];
    const dataPipeline = [
      ...pipeline,
      { $sort: { 'medicine.name': 1, retailPrice: 1, updatedAt: -1 } },
      { $project: projection },
      { $skip: (page - 1) * limit },
      { $limit: limit },
    ];

    const [data, countResult] = await Promise.all([
      InventoryItemModel.aggregate(dataPipeline),
      InventoryItemModel.aggregate(countPipeline),
    ]);

    const total = countResult[0]?.total ?? 0;
    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  // Atomically reserves qty: decrements availableQty, increments reservedQty
  async atomicReserve(
    pharmacyId: string,
    medicineId: string,
    qty: number
  ): Promise<IInventoryItem | null> {
    return InventoryItemModel.findOneAndUpdate(
      {
        pharmacyId,
        medicineId,
        isActive: true,
        availableQty: { $gte: qty },
      },
      {
        $inc: { availableQty: -qty, reservedQty: qty },
      },
      { new: true }
    ).lean();
  }

  // Atomically releases reserved qty back to available
  async atomicRelease(
    pharmacyId: string,
    medicineId: string,
    qty: number
  ): Promise<IInventoryItem | null> {
    // Stock change and low-stock re-arm in ONE atomic pipeline write (no caller transaction here).
    return InventoryItemModel.findOneAndUpdate(
      {
        pharmacyId,
        medicineId,
        reservedQty: { $gte: qty },
      },
      [
        { $set: { availableQty: { $add: ['$availableQty', qty] }, reservedQty: { $subtract: ['$reservedQty', qty] } } },
        rearmStage(),
      ] as any,
      { new: true }
    ).lean();
  }

  // Deducts reserved qty (order fulfilled): decrements reservedQty only
  async atomicDeduct(
    pharmacyId: string,
    medicineId: string,
    qty: number
  ): Promise<IInventoryItem | null> {
    return InventoryItemModel.findOneAndUpdate(
      {
        pharmacyId,
        medicineId,
        reservedQty: { $gte: qty },
      },
      {
        $inc: { reservedQty: -qty },
      },
      { new: true }
    ).lean();
  }

  // Returns qty to available (order cancelled after deduct)
  async atomicReturn(
    pharmacyId: string,
    medicineId: string,
    qty: number,
    session?: ClientSession
  ): Promise<IInventoryItem | null> {
    return InventoryItemModel.findOneAndUpdate(
      { pharmacyId, medicineId, isActive: true },
      [{ $set: { availableQty: { $add: ['$availableQty', qty] } } }, rearmStage()] as any,
      { new: true, session }
    ).lean();
  }

  // Deducts available qty directly (used when prepaid order payment succeeds)
  async atomicConsumeAvailable(
    pharmacyId: string,
    medicineId: string,
    qty: number,
    session?: ClientSession
  ): Promise<IInventoryItem | null> {
    return InventoryItemModel.findOneAndUpdate(
      {
        pharmacyId,
        medicineId,
        isActive: true,
        availableQty: { $gte: qty },
      },
      {
        $inc: { availableQty: -qty },
      },
      { new: true, session }
    ).lean();
  }

  // Adds free qty (promotional/bonus units)
  async atomicAddFree(
    pharmacyId: string,
    medicineId: string,
    qty: number
  ): Promise<IInventoryItem | null> {
    return InventoryItemModel.findOneAndUpdate(
      { pharmacyId, medicineId },
      { $inc: { freeQty: qty } },
      { new: true }
    ).lean();
  }
}

@Service()
export class InventoryAdjustmentRepository extends BaseRepository<IInventoryAdjustment> {
  constructor() {
    super(InventoryAdjustmentModel as Model<IInventoryAdjustment>);
  }

  async findByPharmacy(
    pharmacyId: string,
    page: number = 1,
    limit: number = 20
  ): Promise<{ data: IInventoryAdjustment[]; total: number; page: number; totalPages: number }> {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      InventoryAdjustmentModel.find({ pharmacyId })
        .populate('medicineId', 'name genericName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      InventoryAdjustmentModel.countDocuments({ pharmacyId }),
    ]);
    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }
}

@Service()
export class InventoryReservationRepository extends BaseRepository<IInventoryReservation> {
  constructor() {
    super(InventoryReservationModel as Model<IInventoryReservation>);
  }

  async insertMany(items: Partial<IInventoryReservation>[]): Promise<IInventoryReservation[]> {
    const docs = await InventoryReservationModel.insertMany(items, { ordered: true });
    return docs.map((doc) => doc.toObject());
  }

  async findActiveManualByMedicineIds(
    pharmacyId: string,
    medicineIds: string[]
  ): Promise<IInventoryReservation[]> {
    return InventoryReservationModel.find({
      pharmacyId,
      reservationType: 'manual',
      status: 'active',
      remainingQty: { $gt: 0 },
      medicineId: { $in: medicineIds },
    })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
  }
}
