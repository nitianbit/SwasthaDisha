import { Service } from 'typedi';

import { LabstackService } from '@/modules/bookings/services/labstack';
import { AppError } from '@/modules/common/types';
import { ExternalBookingRepository } from '@/modules/externalBookings/repository';
import { UserRepository } from '@/modules/user/repository';
import {
  sampleCampDetails,
  sampleCamps,
  sampleCampSlots,
} from '@/modules/camps/testData';
import {
  BulkCampOrderResult,
  BulkPlaceCampOrderRequest,
  CampListQuery,
  ICamp,
  ICampDetails,
  ICampSlot,
  PlaceCampOrderRequest,
} from '@/modules/camps/types';

const toStringValue = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
};

const toNumberValue = (value: unknown): number | undefined => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return undefined;
};

const toStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => toStringValue(item))
    .filter((item): item is string => Boolean(item));
};

const toContactList = (value: unknown) => {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    const contact =
      item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    return {
      name: toStringValue(contact.name),
      mobile: toStringValue(contact.mobile),
      altMobile:
        typeof contact.altMobile === 'string' || contact.altMobile === null
          ? contact.altMobile
          : undefined,
      email:
        typeof contact.email === 'string' || contact.email === null
          ? contact.email
          : undefined,
    };
  });
};

const deriveBookingDate = (appointment: string): string => {
  const date = new Date(appointment);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 10).replace(/-/g, '');
  }

  return appointment.slice(0, 10).replace(/-/g, '');
};

const deriveBookingTime = (appointment: string): string => {
  const date = new Date(appointment);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(11, 16);
  }

  const match = appointment.match(/T?(\d{2}:\d{2})/);
  return match?.[1] || appointment;
};

@Service()
export class CampService {
  constructor(
    private labstackService: LabstackService,
    private externalBookingRepository: ExternalBookingRepository,
    private userRepository: UserRepository
  ) {}

  async getCamps(query: CampListQuery): Promise<ICamp[]> {
    if (query.test) {
      return sampleCamps;
    }

    const response = await this.labstackService.getCamps(query);
    return response.camps.map((camp) => this.mapCamp(camp));
  }

  async getCampDetails(campLsId: string): Promise<ICampDetails> {
    if (sampleCampDetails[campLsId]) {
      return sampleCampDetails[campLsId];
    }

    const response = await this.labstackService.getCampDetails(campLsId);
    if (!response.campDetails) {
      throw new AppError({
        status: 404,
        code: 'CAMP_NOT_FOUND',
        message: 'Camp details not found',
      });
    }

    return this.mapCampDetails(response.campDetails);
  }

  async getCampSlots(campLsId: string): Promise<ICampSlot[]> {
    if (sampleCampSlots[campLsId]) {
      return sampleCampSlots[campLsId];
    }

    const response = await this.labstackService.getCampSlots(campLsId);
    return response.slotsByDate.flatMap((slotGroup) => {
      const date = toStringValue(slotGroup.date) || '';
      const rawSlots = Array.isArray(slotGroup.slots) ? slotGroup.slots : [];

      return rawSlots
        .map((slot) =>
          slot && typeof slot === 'object'
            ? (slot as Record<string, unknown>)
            : undefined
        )
        .filter((slot): slot is Record<string, unknown> => Boolean(slot))
        .map((slot) => ({
          date,
          time: toStringValue(slot.time) || '',
        }))
        .filter((slot) => slot.date && slot.time);
    });
  }

  async placeCampOrder(data: PlaceCampOrderRequest) {
    const result = sampleCampDetails[data.campLsId]
      ? this.buildSampleCampOrderResult(data)
      : await this.labstackService.placeCampOrder({
          campLsId: data.campLsId,
          orderType: data.orderType || 'CENTER_VISIT',
          appointment: data.appointment,
          name: data.name,
          mobile: data.mobile,
          gender: data.gender,
          packageIds: data.packageIds,
          testIds: data.testIds,
          uniqueId: data.uniqueId || data.userId,
          referenceId: data.referenceId,
          isVip: data.isVip,
          labId: data.labId,
          pincode: data.pincode,
          notes: data.notes,
          email: data.email,
          dateOfBirth: data.dateOfBirth,
          age: data.age,
          altContact: data.altContact,
          mainUserUniqueId: data.mainUserUniqueId,
          relationship: data.relationship,
        });

    const booking = await this.externalBookingRepository.save({
      userId: data.userId,
      corporateId: data.corporateId,
      integration: 'labstack',
      providerType: 'CAMP',
      appointmentType: data.orderType || 'CENTER_VISIT',
      externalProviderId: data.campLsId,
      externalBookingId: result.externalBookingId,
      externalSlotRef: data.appointment,
      bookingDate: deriveBookingDate(data.appointment),
      bookingTime: deriveBookingTime(data.appointment),
      patientName: data.name,
      patientEmail: data.email,
      patientPhone: data.mobile,
      labName: data.labName || data.labId,
      packageNames: data.packageIds,
      testNames: data.testIds,
      price: 0,
      status: result.externalStatus || 'confirmed',
      meta: {
        campLsId: data.campLsId,
        orderType: data.orderType || 'CENTER_VISIT',
        labId: data.labId,
        pincode: data.pincode,
        isVip: data.isVip,
        paymentRequired: false,
        notes: data.notes,
        appointment: data.appointment,
        externalPayload: result.payload,
      },
    });

    return {
      booking,
      external: result,
    };
  }

  async bulkPlaceCampOrders(
    data: BulkPlaceCampOrderRequest
  ): Promise<BulkCampOrderResult> {
    const created: BulkCampOrderResult['created'] = [];
    const failed: BulkCampOrderResult['failed'] = [];

    for (const row of data.rows) {
      try {
        const mobile = this.normalizeMobile(row.mobile);
        if (!mobile) {
          throw new Error('Mobile number is required and must be 10 digits');
        }

        const user = await this.userRepository.findByPhone(mobile, 'user');
        const matchedUser = user as
          | {
              _id?: unknown;
              name?: string;
              gender?: string;
              dateOfBirth?: string;
              email?: string;
              corporateEmail?: string;
              corporateId?: string;
              pincode?: string;
            }
          | null;

        if (!matchedUser?._id) {
          throw new Error('User not found for this phone number');
        }

        const userId = String(matchedUser._id);
        const name = row.name?.trim() || matchedUser.name?.trim();
        if (!name) {
          throw new Error('User name is missing');
        }

        const gender = this.normalizeGender(row.gender || matchedUser.gender);
        if (!gender) {
          throw new Error('User gender is missing');
        }

        const age = row.age?.trim();
        const dateOfBirth = this.normalizeDateOfBirth(
          row.dateOfBirth || matchedUser.dateOfBirth
        );
        if (!age && !dateOfBirth) {
          throw new Error('User dateOfBirth or uploaded age is required');
        }

        const result = await this.placeCampOrder({
          campLsId: data.campLsId,
          orderType: data.orderType || 'CENTER_VISIT',
          appointment: data.appointment,
          userId,
          corporateId:
            data.corporateId ||
            matchedUser.corporateId ||
            undefined,
          name,
          mobile,
          gender,
          packageIds: data.packageIds,
          testIds: data.testIds,
          uniqueId: row.uniqueId?.trim() || userId,
          referenceId: row.referenceId?.trim(),
          isVip: data.isVip,
          labId: data.labId,
          pincode: data.pincode || matchedUser.pincode,
          labName: data.labName,
          notes: data.notes,
          email:
            row.email?.trim() ||
            matchedUser.email?.trim() ||
            matchedUser.corporateEmail?.trim(),
          dateOfBirth,
          age,
          altContact: this.normalizeMobile(row.altContact),
          mainUserUniqueId: row.mainUserUniqueId?.trim(),
          relationship: row.relationship?.trim(),
        });

        created.push({
          rowNumber: row.rowNumber,
          bookingId: (result.booking as { _id?: unknown })._id
            ? String((result.booking as { _id?: unknown })._id)
            : undefined,
          externalBookingId: result.external.externalBookingId,
          mobile,
          name,
        });
      } catch (error: any) {
        failed.push({
          rowNumber: row.rowNumber,
          mobile: row.mobile,
          name: row.name,
          error: error?.message || 'Camp order failed',
        });
      }
    }

    return {
      totalRows: data.rows.length,
      createdCount: created.length,
      failedCount: failed.length,
      created,
      failed,
    };
  }

  private mapCamp(camp: Record<string, unknown>): ICamp {
    return {
      campLsId: toStringValue(camp.campLsId) || '',
      corporateName: toStringValue(camp.corporateName),
      dates: toStringArray(camp.dates),
      numOrders: toNumberValue(camp.numOrders),
      labName: toStringValue(camp.labName),
      labLogo:
        typeof camp.labLogo === 'string' || camp.labLogo === null
          ? camp.labLogo
          : undefined,
      lsLabId: toStringValue(camp.lsLabId) || toNumberValue(camp.lsLabId),
      lsChainId:
        camp.lsChainId === null
          ? null
          : toStringValue(camp.lsChainId) || toNumberValue(camp.lsChainId),
      campStatus: toStringValue(camp.campStatus),
      meta: {
        raw: camp,
      },
    };
  }

  private mapCampDetails(camp: Record<string, unknown>): ICampDetails {
    return {
      ...this.mapCamp(camp),
      orders: Array.isArray(camp.orders)
        ? camp.orders
            .map((item) => toStringValue(item) || toNumberValue(item))
            .filter((item): item is string | number => item !== undefined)
        : undefined,
      address: toStringValue(camp.address),
      locality:
        typeof camp.locality === 'string' || camp.locality === null
          ? camp.locality
          : undefined,
      city: toStringValue(camp.city),
      state: toStringValue(camp.state),
      pincode: toStringValue(camp.pincode),
      phlebos: toContactList(camp.phlebos),
      labCoordinators: toContactList(camp.labCoordinators),
      labEscalators: toContactList(camp.labEscalators),
      notes: toStringValue(camp.notes),
    };
  }

  private buildSampleCampOrderResult(data: PlaceCampOrderRequest) {
    const externalBookingId = `SAMPLE_CAMP_${Date.now()}_${data.mobile}`;
    return {
      externalBookingId,
      externalStatus: 'confirmed',
      payload: {
        bookingRequest: data,
        bookingResponse: {
          status: 'success',
          order: {
            orderId: externalBookingId,
            orderStatus: 'confirmed',
          },
        },
      },
    };
  }

  private normalizeMobile(value?: string): string | undefined {
    if (!value) return undefined;
    const digits = String(value).replace(/\D/g, '');
    const normalized = digits.length > 10 ? digits.slice(-10) : digits;
    return /^[1-9]\d{9}$/.test(normalized) ? normalized : undefined;
  }

  private normalizeGender(value?: string): string | undefined {
    const normalized = value?.trim().toUpperCase();
    if (!normalized) return undefined;
    if (['M', 'MALE'].includes(normalized)) return 'MALE';
    if (['F', 'FEMALE'].includes(normalized)) return 'FEMALE';
    if (['O', 'OTHER'].includes(normalized)) return 'OTHER';
    return normalized;
  }

  private normalizeDateOfBirth(value?: string): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    if (/^\d{8}$/.test(trimmed)) {
      return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
    }
    return trimmed;
  }
}
