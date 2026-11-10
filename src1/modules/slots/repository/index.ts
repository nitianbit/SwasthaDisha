import { Service } from 'typedi';
import { Model } from 'mongoose';
import SlotModel from '@/modules/slots/model';
import { ISlot, SlotQueryParams } from '@/modules/slots/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class SlotRepository extends BaseRepository<ISlot> {
  constructor() {
    super(SlotModel as Model<ISlot>);
  }

  async insertMany(docs: Partial<ISlot>[]): Promise<ISlot[]> {
    if (docs.length === 0) {
      return [];
    }

    const result = await SlotModel.insertMany(docs);
    return result.map((doc) => doc.toObject());
  }

  async findByIdWithModel(id: string) {
    return SlotModel.findById(id);
  }

  async findBySpecialistId(
    specialistId: string,
    date?: string
  ): Promise<ISlot[]> {
    const query: any = {
      specialistId,
      isActive: true,
      isAvailable: true,
      $expr: { $lt: ['$currentBookings', '$maxBookings'] }, // Only slots with available capacity
    };
    
    if (date) {
      query.date = date;
    }

    return this.findAll(query, { sort: { date: 1, startTime: 1 } });
  }

  /** All slots for a specialist (including full / inactive) for portal management. */
  async findManagedBySpecialistId(
    specialistId: string,
    date?: string
  ): Promise<ISlot[]> {
    const query: Record<string, unknown> = { specialistId };
    if (date) {
      query.date = date;
    }
    return this.findAll(query, { sort: { date: 1, startTime: 1 } });
  }

  async findByWellnessPackageId(
    wellnessPackageId: string,
    date?: string
  ): Promise<ISlot[]> {
    const query: any = {
      wellnessPackageId,
      isActive: true,
      isAvailable: true,
      $expr: { $lt: ['$currentBookings', '$maxBookings'] }, // Only slots with available capacity
    };
    
    if (date) {
      query.date = date;
    }

    return this.findAll(query, { sort: { date: 1, startTime: 1 } });
  }

  async findAvailableSlots(
    specialistId?: string,
    wellnessPackageId?: string,
    date?: string
  ): Promise<ISlot[]> {
    const query: any = {
      isAvailable: true,
      isActive: true,
      $expr: { $lt: ['$currentBookings', '$maxBookings'] }, // Only slots with available capacity
    };

    if (specialistId) {
      query.specialistId = specialistId;
    }

    if (wellnessPackageId) {
      query.wellnessPackageId = wellnessPackageId;
    }

    if (date) {
      query.date = date;
    }

    return this.findAll(query, { sort: { date: 1, startTime: 1 } });
  }

  async findByDateRange(
    dateFrom: string,
    dateTo: string,
    specialistId?: string,
    wellnessPackageId?: string
  ): Promise<ISlot[]> {
    const query: any = {
      date: {
        $gte: dateFrom,
        $lte: dateTo,
      },
      isActive: true,
      isAvailable: true,
      $expr: { $lt: ['$currentBookings', '$maxBookings'] }, // Only slots with available capacity
    };

    if (specialistId) {
      query.specialistId = specialistId;
    }

    if (wellnessPackageId) {
      query.wellnessPackageId = wellnessPackageId;
    }

    return this.findAll(query, { sort: { date: 1, startTime: 1 } });
  }

  async findWithPagination(
    filter: SlotQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{
    data: ISlot[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const query: any = {};

    if (filter.specialistId) {
      query.specialistId = filter.specialistId;
    }

    if (filter.wellnessPackageId) {
      query.wellnessPackageId = filter.wellnessPackageId;
    }

    if (filter.slotType) {
      query.slotType = filter.slotType;
    }

    if (filter.date) {
      query.date = filter.date;
    }

    if (filter.dateFrom || filter.dateTo) {
      query.date = {};
      if (filter.dateFrom) {
        query.date.$gte = filter.dateFrom;
      }
      if (filter.dateTo) {
        query.date.$lte = filter.dateTo;
      }
    }

    // By default, only return available slots (unless explicitly requested otherwise)
    if (filter.isAvailable !== undefined) {
      query.isAvailable = filter.isAvailable;
    } else {
      query.isAvailable = true; // Default to only available slots
    }

    if (filter.isActive !== undefined) {
      query.isActive = filter.isActive;
    } else {
      query.isActive = true; // Default to only active slots
    }

    // Only return slots with available capacity (currentBookings < maxBookings)
    query.$expr = { $lt: ['$currentBookings', '$maxBookings'] };

    const skip = (page - 1) * limit;
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.date = 1;
      sort.startTime = 1;
    }

    const [data, total] = await Promise.all([
      SlotModel.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      SlotModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async incrementBookingCount(id: string): Promise<ISlot | null> {
    return SlotModel.findByIdAndUpdate(
      id,
      { $inc: { currentBookings: 1 } },
      { new: true }
    ).lean();
  }

  async decrementBookingCount(id: string): Promise<ISlot | null> {
    return SlotModel.findByIdAndUpdate(
      id,
      { $inc: { currentBookings: -1 } },
      { new: true }
    ).lean();
  }
}
