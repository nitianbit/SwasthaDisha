import { Service } from 'typedi';
import { SlotRepository } from '@/modules/slots/repository';
import {
  ISlot,
  CreateSlotRequest,
  UpdateSlotRequest,
  SlotQueryParams,
} from '@/modules/slots/types';
import { AppError } from '@/modules/common/types';
import { getTodayYyyymmdd, compareYyyymmdd } from '@/modules/common/utils/dateUtils';

@Service()
export class SlotService {
  constructor(private slotRepository: SlotRepository) {}

  private parseTimeToMinutes(time: string): number {
    const match = time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);

    if (!match) {
      throw new AppError({
        status: 400,
        code: 'INVALID_TIME_FORMAT',
        message: 'Time must be in h:mm AM/PM format',
      });
    }

    const hours12 = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const meridiem = match[3].toUpperCase();

    if (hours12 < 1 || hours12 > 12 || minutes < 0 || minutes > 59) {
      throw new AppError({
        status: 400,
        code: 'INVALID_TIME_FORMAT',
        message: 'Invalid time value provided',
      });
    }

    let hours24 = hours12 % 12;
    if (meridiem === 'PM') {
      hours24 += 12;
    }

    return hours24 * 60 + minutes;
  }

  private formatMinutesToTime(totalMinutes: number): string {
    const hours24 = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const meridiem = hours24 >= 12 ? 'PM' : 'AM';
    const hours12 = hours24 % 12 || 12;

    return `${hours12}:${minutes.toString().padStart(2, '0')} ${meridiem}`;
  }

  async create(data: CreateSlotRequest): Promise<ISlot[]> {
    // Validate that either specialistId or wellnessPackageId is provided
    if (!data.specialistId && !data.wellnessPackageId) {
      throw new AppError({
        status: 400,
        code: 'MISSING_REFERENCE',
        message: 'Either specialistId or wellnessPackageId must be provided',
      });
    }

    // Validate that both are not provided
    if (data.specialistId && data.wellnessPackageId) {
      throw new AppError({
        status: 400,
        code: 'INVALID_REFERENCE',
        message: 'Cannot provide both specialistId and wellnessPackageId',
      });
    }

    // Set slotType based on provided reference
    if (data.specialistId) {
      data.slotType = 'consultation';
    } else if (data.wellnessPackageId) {
      data.slotType = 'wellnessPackage';
    }

    // Validate date is not in the past
    const today = getTodayYyyymmdd();
    if (compareYyyymmdd(data.date, today) < 0) {
      throw new AppError({
        status: 400,
        code: 'INVALID_DATE',
        message: 'Slot date cannot be in the past',
      });
    }

    const rangeStartMinutes = this.parseTimeToMinutes(data.startTime);
    const rangeEndMinutes = this.parseTimeToMinutes(data.endTime);

    if (rangeEndMinutes <= rangeStartMinutes) {
      throw new AppError({
        status: 400,
        code: 'INVALID_TIME_RANGE',
        message: 'End time must be greater than start time',
      });
    }

    const totalRangeMinutes = rangeEndMinutes - rangeStartMinutes;

    if (!data.duration) {
      data.duration = totalRangeMinutes;
    }

    if (data.duration > totalRangeMinutes) {
      throw new AppError({
        status: 400,
        code: 'INVALID_DURATION',
        message: 'Duration cannot be greater than the selected time range',
      });
    }

    // Set defaults
    if (data.isAvailable === undefined) {
      data.isAvailable = true;
    }
    if (data.currentBookings === undefined) {
      data.currentBookings = 0;
    }
    if (data.maxBookings === undefined) {
      data.maxBookings = 1;
    }

    if (data.isActive === undefined) {
      data.isActive = true;
    }

    const slotsToCreate: CreateSlotRequest[] = [];

    for (
      let slotStartMinutes = rangeStartMinutes;
      slotStartMinutes + data.duration <= rangeEndMinutes;
      slotStartMinutes += data.duration
    ) {
      const slotEndMinutes = slotStartMinutes + data.duration;

      slotsToCreate.push({
        ...data,
        startTime: this.formatMinutesToTime(slotStartMinutes),
        endTime: this.formatMinutesToTime(slotEndMinutes),
        duration: data.duration,
      });
    }

    return this.slotRepository.insertMany(slotsToCreate);
  }

  async getById(id: string): Promise<ISlot> {
    const slot = await this.slotRepository.findById(id);

    if (!slot) {
      throw new AppError({
        status: 404,
        code: 'SLOT_NOT_FOUND',
        message: 'Slot not found',
      });
    }

    return slot;
  }

  async getAll(
    queryParams: SlotQueryParams = {}
  ): Promise<{
    data: ISlot[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    // If pagination params are provided, use pagination
    if (queryParams.page && queryParams.limit) {
      const result = await this.slotRepository.findWithPagination(
        queryParams,
        queryParams.page,
        queryParams.limit
      );
      // Filter to only available slots (currentBookings < maxBookings)
      return result;
    }

    // Otherwise return all matching records, but filter to only available slots
    let data: ISlot[];

    if (queryParams.specialistId) {
      data = await this.slotRepository.findBySpecialistId(
        queryParams.specialistId,
        queryParams.date
      );
    } else if (queryParams.wellnessPackageId) {
      data = await this.slotRepository.findByWellnessPackageId(
        queryParams.wellnessPackageId,
        queryParams.date
      );
    } else if (queryParams.dateFrom && queryParams.dateTo) {
      data = await this.slotRepository.findByDateRange(
        queryParams.dateFrom,
        queryParams.dateTo,
        queryParams.specialistId,
        queryParams.wellnessPackageId
      );
    } else if (
      queryParams.isAvailable !== undefined &&
      queryParams.isAvailable
    ) {
      data = await this.slotRepository.findAvailableSlots(
        queryParams.specialistId,
        queryParams.wellnessPackageId,
        queryParams.date
      );
    } else {
      const filter: any = {};

      if (queryParams.specialistId) {
        filter.specialistId = queryParams.specialistId;
      }

      if (queryParams.wellnessPackageId) {
        filter.wellnessPackageId = queryParams.wellnessPackageId;
      }

      if (queryParams.slotType) {
        filter.slotType = queryParams.slotType;
      }

      if (queryParams.date) {
        filter.date = queryParams.date;
      }

      // By default, only return available slots unless explicitly requested otherwise
      if (queryParams.isAvailable !== undefined) {
        filter.isAvailable = queryParams.isAvailable;
      } else {
        filter.isAvailable = true; // Default to only available slots
      }

      if (queryParams.isActive !== undefined) {
        filter.isActive = queryParams.isActive;
      } else {
        filter.isActive = true; // Default to only active slots
      }

      // Only return slots with available capacity (currentBookings < maxBookings)
      // Only add this filter if we're filtering for available slots
      if (filter.isAvailable !== false) {
        filter.$expr = { $lt: ['$currentBookings', '$maxBookings'] };
      }

      const sort: any = {};
      if (queryParams.sortBy) {
        sort[queryParams.sortBy] = queryParams.sortOrder === 'desc' ? -1 : 1;
      } else {
        sort.date = 1;
        sort.startTime = 1;
      }

      data = await this.slotRepository.findAll(filter, { sort });
    }

    // Additional client-side filter to ensure only available slots are returned
    // (in case MongoDB $expr didn't work or for extra safety)
    data = data.filter(
      (slot) => slot.isAvailable && slot.isActive && slot.currentBookings && slot.maxBookings && slot.currentBookings < slot.maxBookings
    );

    return { data };
  }

  async update(id: string, data: UpdateSlotRequest): Promise<ISlot> {
    const slot = await this.slotRepository.findById(id);

    if (!slot) {
      throw new AppError({
        status: 404,
        code: 'SLOT_NOT_FOUND',
        message: 'Slot not found',
      });
    }

    // Validate date if being updated
    if (data.date) {
      const today = getTodayYyyymmdd();
      if (compareYyyymmdd(data.date, today) < 0) {
        throw new AppError({
          status: 400,
          code: 'INVALID_DATE',
          message: 'Slot date cannot be in the past',
        });
      }
    }

    // Validate booking count doesn't exceed max
    if (
      data.currentBookings !== undefined &&
      slot.maxBookings !== undefined &&
      data.currentBookings > slot.maxBookings
    ) {
      throw new AppError({
        status: 400,
        code: 'INVALID_BOOKING_COUNT',
        message: 'Current bookings cannot exceed max bookings',
      });
    }

    // Update availability based on booking count
    if (data.currentBookings !== undefined && slot.maxBookings !== undefined) {
      data.isAvailable = data.currentBookings < slot.maxBookings;
    }

    const updated = await this.slotRepository.update({ _id: id }, data);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update slot',
      });
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    const slot = await this.slotRepository.findById(id);

    if (!slot) {
      throw new AppError({
        status: 404,
        code: 'SLOT_NOT_FOUND',
        message: 'Slot not found',
      });
    }

    await this.slotRepository.delete({ _id: id });
  }

  async getBySpecialistId(
    specialistId: string,
    date?: string
  ): Promise<ISlot[]> {
    return this.slotRepository.findBySpecialistId(specialistId, date);
  }

  async getByWellnessPackageId(
    wellnessPackageId: string,
    date?: string
  ): Promise<ISlot[]> {
    return this.slotRepository.findByWellnessPackageId(
      wellnessPackageId,
      date
    );
  }

  async getAvailableSlots(
    specialistId?: string,
    wellnessPackageId?: string,
    date?: string
  ): Promise<ISlot[]> {
    return this.slotRepository.findAvailableSlots(
      specialistId,
      wellnessPackageId,
      date
    );
  }

  async incrementBookingCount(id: string): Promise<ISlot> {
    const slot = await this.slotRepository.findById(id);

    if (!slot) {
      throw new AppError({
        status: 404,
        code: 'SLOT_NOT_FOUND',
        message: 'Slot not found',
      });
    }

    if (
      slot.currentBookings !== undefined &&
      slot.maxBookings !== undefined &&
      slot.currentBookings >= slot.maxBookings
    ) {
      throw new AppError({
        status: 400,
        code: 'SLOT_FULL',
        message: 'Slot is already fully booked',
      });
    }

    const updated = await this.slotRepository.incrementBookingCount(id);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to increment booking count',
      });
    }

    // Update availability if slot is now full
    if (
      updated.currentBookings !== undefined &&
      updated.maxBookings !== undefined &&
      updated.currentBookings >= updated.maxBookings
    ) {
      await this.slotRepository.update({ _id: id }, { isAvailable: false });
      updated.isAvailable = false;
    }

    return updated;
  }

  async decrementBookingCount(id: string): Promise<ISlot> {
    const slot = await this.slotRepository.findById(id);

    if (!slot) {
      throw new AppError({
        status: 404,
        code: 'SLOT_NOT_FOUND',
        message: 'Slot not found',
      });
    }

    if (
      slot.currentBookings === undefined ||
      slot.currentBookings <= 0
    ) {
      throw new AppError({
        status: 400,
        code: 'INVALID_OPERATION',
        message: 'Cannot decrement booking count below 0',
      });
    }

    const updated = await this.slotRepository.decrementBookingCount(id);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to decrement booking count',
      });
    }

    // Update availability if slot is now available
    if (
      updated.currentBookings !== undefined &&
      updated.maxBookings !== undefined &&
      updated.currentBookings < updated.maxBookings
    ) {
      await this.slotRepository.update({ _id: id }, { isAvailable: true });
      updated.isAvailable = true;
    }

    return updated;
  }
}
