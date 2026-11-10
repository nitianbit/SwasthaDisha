import axios, { AxiosError, AxiosInstance } from 'axios';
import { Service } from 'typedi';

import { CONFIG } from '@/config/config';
import { AppError } from '@/modules/common/types';
import logger from '@/services/logger';

export interface LabstackProvider {
  lsProviderId?: string;
  providerId?: string;
  id?: string;
  lsId?: string | number;
  name?: string;
  fullName?: string;
  providerName?: string;
  email?: string;
  mobile?: string;
  [key: string]: unknown;
}

export interface LabstackSlot {
  /**
   * LabStack "getAppointmentSlots" returns provider-level entries with a `timing[]`.
   * We flatten those timings into one "slot" per start/end pair.
   */
  externalProviderId: string;
  date: string; // YYYYMMDD
  startTime24h: string; // "HH:MM"
  endTime24h?: string; // "HH:MM"
  startTimeDisplay: string; // "h:mm AM/PM"
  endTimeDisplay?: string; // "h:mm AM/PM"
  providerName?: string;
  raw: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LabstackConsultationBookingInput {
  bookingDate: string;
  bookingTime: string;
  consultationMode: 'chat' | 'call' | 'video' | 'in-person';
  specialistName?: string;
  specialistEmail?: string;
  specialistPhone?: string;
  primaryConcern?: string;
  userUniqueId: string;
  firstName: string;
  lastName?: string;
  email?: string;
  mobile?: string;
  gender?: string;
  dateOfBirth?: string;
  age?: string;
  referenceId?: string;
  pincode?: string;
  city?: string;
  state?: string;
  addressLine?: string;
  /** Full address; used in preference to addressLine for LabStack `address` when set */
  address?: string;
  selectedProviderId?: string;
  /**
   * Optional hint from client. Since LabStack slots are timings, this can be either:
   * - a display time like "9:00 AM"
   * - or a 24h time like "09:00"
   */
  selectedSlotTime?: string;
}

export interface LabstackConsultationBookingResult {
  externalBookingId?: string;
  externalProviderId?: string;
  externalSlotTime?: string;
  externalStatus?: string;
  meetingLink?: string;
  payload: Record<string, unknown>;
}

export interface LabstackGetConsultationProvidersInput {
  specialistName?: string;
  userUniqueId?: string;
  pincode?: string;
}

export interface LabstackGetConsultationSlotsInput {
  providerId: string;
  bookingDate: string;
  pincode?: string;
  latitude?: string;
  longitude?: string;
}

export interface LabstackProviderSearchInput {
  providerType?: string;
  appointmentType?: string;
  speciality?: string;
  subSpeciality?: string;
  preferredGender?: string;
  userUniqueId?: string;
  pincode?: string;
  latitude?: string;
  longitude?: string;
}

export interface LabstackGenericSlotInput {
  providerType?: string;
  appointmentType: string;
  externalProviderId: string;
  bookingDate: string;
  pincode?: string;
  latitude?: string;
  longitude?: string;
}

export interface LabstackNetworkListInput {
  pincode?: string;
  latitude?: number;
  longitude?: number;
}

export interface LabstackServiceabilityInput {
  packageIds?: string[];
  testIds?: string[];
  pincode?: string;
  latitude?: number;
  longitude?: number;
}

export interface LabstackDiagnosticsSlotInput {
  bookingDate: string; // YYYYMMDD
  pincode?: string;
  latitude?: number;
  longitude?: number;
  packageIds?: string[];
  testIds?: string[];
}

export interface LabstackDiagnosticsSlot {
  externalProviderId: string;
  labId?: string;
  date: string; // YYYYMMDD
  startTime24h: string; // "HH:MM"
  endTime24h?: string; // "HH:MM"
  startTimeDisplay: string; // "h:mm AM/PM"
  endTimeDisplay?: string; // "h:mm AM/PM"
  raw: Record<string, unknown>;
}

export interface LabstackDiagnosticsOrderInput {
  orderType: string;
  appointment: string;
  name: string;
  mobile?: string;
  email?: string;
  gender?: string;
  age?: string;
  pincode?: string;
  unitFloorBuilding?: string;
  locality?: string;
  city?: string;
  state?: string;
  latitude?: number;
  longitude?: number;
  address?: string;
  packageIds?: string[];
  testIds?: string[];
  labId?: string;
  uniqueId: string;
  referenceId?: string;
  notes?: string;
  altContact?: string;
}

export interface LabstackDiagnosticsOrderResult {
  externalBookingId?: string;
  externalStatus?: string;
  payload: Record<string, unknown>;
}

export interface LabstackCampListInput {
  startDate?: string;
  endDate?: string;
}

export interface LabstackCampOrderInput {
  campLsId: string;
  orderType?: string;
  appointment: string;
  name: string;
  mobile: string;
  gender: string;
  packageIds?: string[];
  testIds?: string[];
  uniqueId?: string;
  referenceId?: string;
  isVip?: boolean;
  labId?: string;
  notes?: string;
  email?: string;
  dateOfBirth?: string;
  age?: string;
  altContact?: string;
  mainUserUniqueId?: string;
  relationship?: string;
  pincode?: string;
}

export interface LabstackCampOrderResult {
  externalBookingId?: string;
  externalStatus?: string;
  payload: Record<string, unknown>;
}

export interface LabstackAppointmentLifecycleResult {
  externalBookingId?: string;
  externalStatus?: string;
  payload: Record<string, unknown>;
}

export interface LabstackOrderLifecycleResult {
  externalBookingId?: string;
  externalStatus?: string;
  payload: Record<string, unknown>;
}

export interface LabstackAppointmentDetailsResult {
  externalBookingId?: string;
  payload: Record<string, unknown>;
}

export interface LabstackDocumentResult {
  payload: Record<string, unknown>;
}

export interface LabstackOrderReportResult {
  payload: Record<string, unknown>;
}

export interface LabstackOrderDetailsResult {
  externalBookingId?: string;
  payload: Record<string, unknown>;
}

type LabstackApiStatus = 'success' | 'failure';

interface LabstackGetAppointmentSlotsResponse {
  status?: LabstackApiStatus;
  message?: string;
  date?: string; // YYYY-MM-DD
  slots?: Array<Record<string, unknown>>;
  groupSlots?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

@Service()
export class LabstackService {
  private client: AxiosInstance;

  constructor() {
    const userId = CONFIG.LABSTACK_USER_ID;
    const password = CONFIG.LABSTACK_PASSWORD;
    const apiKey = CONFIG.LABSTACK_API_KEY;

    if (!userId || !password || !apiKey) {
      throw new AppError({
        status: 500,
        code: 'LABSTACK_CONFIG_MISSING',
        message: 'LabStack configuration is missing',
      });
    }

    const authHeader = Buffer.from(`${userId}:${password}`).toString('base64');
    const normalizedBaseUrl = (CONFIG.LABSTACK_BASE_URL || '').replace(/\/+$/, '');
    const baseURL = normalizedBaseUrl.endsWith('/api')
      ? normalizedBaseUrl
      : `${normalizedBaseUrl}/api`;

    this.client = axios.create({
      baseURL,
      timeout: 15000,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Basic ${authHeader}`,
        'ls-api-key': apiKey,
        'x-api-key': apiKey,
      },
    });

    this.client.interceptors.request.use((requestConfig) => {
      const locationLog = this.getLocationLogFields(
        requestConfig.params,
        requestConfig.data
      );

      if (locationLog.hasLocation) {
        logger.info('[Labstack] API called with location', {
          method: requestConfig.method?.toUpperCase(),
          url: requestConfig.url,
          pincode: locationLog.pincode,
          latitude: locationLog.latitude,
          longitude: locationLog.longitude,
        });
      }

      return requestConfig;
    });
  }

  async createConsultationBooking(
    input: LabstackConsultationBookingInput
  ): Promise<LabstackConsultationBookingResult> {
    const appointmentType = this.getAppointmentType(input.consultationMode);
    const meetingType = input.consultationMode === 'call' ? 'AUDIO_ONLY' : 'VIDEO';

    const providerResponseData = await this.fetchConsultationProviders({
      specialistName: input.specialistName,
      pincode: input.pincode,
    });
    const providers = providerResponseData.providers;
    if (!providers.length) {
      throw new AppError({
        status: 400,
        code: 'LABSTACK_PROVIDER_NOT_FOUND',
        message: 'No LabStack provider found for this consultation',
      });
    }

    const provider = this.pickProvider(input, providers);
    const providerId = this.getFirstString(provider, ['lsProviderId', 'providerId', 'id','lsId']);

    if (!providerId) {
      throw new AppError({
        status: 400,
        code: 'LABSTACK_PROVIDER_ID_MISSING',
        message: 'LabStack provider ID is missing in provider response',
      });
    }

    const slotResponseData = await this.fetchConsultationSlots({
      providerId,
      bookingDate: input.bookingDate,
      pincode: input.pincode,
      consultationMode: input.consultationMode,
    });
    const slots = slotResponseData.slots;
    if (!slots.length) {
      throw new AppError({
        status: 400,
        code: 'LABSTACK_SLOT_NOT_FOUND',
        message: 'No LabStack slot found for this provider and date',
      });
    }

    const slot = this.pickSlot(input, slots);
    const appointmentIso = this.toAppointmentIsoDatetime(
      input.bookingDate,
      slot.startTime24h
    );
    const unitFloorBuilding = this.distinctAddressPart(input.addressLine, [
      input.address,
    ]);
    const address = this.limitProviderAddress(
      input.address?.trim() || input.addressLine?.trim() || undefined
    );

    const appointmentDetails: Record<string, unknown> = {
      lsProviderId: Number(providerId),
      // LabStack default procedure for DOCTOR consultation is typically 1.
      lsProcedureId: 1,
      appointmentType,
      appointment: appointmentIso,
      notes: input.primaryConcern,
      uniqueId: input.userUniqueId,
      referenceId: input.referenceId,
      name: this.joinName(input.firstName, input.lastName),
      email: input.email,
      mobile: input.mobile,
      gender: input.gender,
      dateOfBirth: this.toIsoBirthDate(input.dateOfBirth),
      age: input.age,
      unitFloorBuilding,
      address,
      city: input.city,
      state: input.state,
      pincode: input.pincode,
      meetingType,
    };

    // Different LabStack tenants validate either flat fields or nested appointmentDetails.
    const bookingPayload: Record<string, unknown> = {
      ...appointmentDetails,
      appointmentDetails,
    };

    Object.keys(bookingPayload).forEach((key) => {
      if (
        bookingPayload[key] === undefined ||
        bookingPayload[key] === null ||
        bookingPayload[key] === ''
      ) {
        delete bookingPayload[key];
      }
    });

    logger.info('[Labstack] sending consultation booking payload', {
      endpoint: '/v1.0/appointment/bookAppointment',
      payload: bookingPayload,
    });

    const bookingResponse = await this.requestOrThrow(() =>
      this.client.post('/v1.0/appointment/bookAppointment', bookingPayload),
      'LABSTACK_BOOK_APPOINTMENT_FAILED'
    );

    const bookingData = bookingResponse.data || {};
    const appointmentObj = (bookingData?.appointment ||
      bookingData?.appointmentDetails ||
      bookingData?.data?.appointment) as Record<string, unknown> | undefined;

    return {
      externalBookingId:
        this.getFirstString(appointmentObj || (bookingData as any), [
          'appointmentId',
          'lsAppointmentId',
          'id',
          'referenceId',
        ]) || this.getFirstString(bookingData as any, ['appointmentId', 'id', 'referenceId']),
      externalProviderId: providerId,
      externalSlotTime: slot.startTime24h,
      externalStatus: this.getFirstString(appointmentObj || (bookingData as any), [
        'appointmentStatus',
        'status',
      ]),
      meetingLink: this.getFirstString(appointmentObj || (bookingData as any), [
        'meetingLink',
        'meetingUrl',
        'joinUrl',
      ]),
      payload: {
        providerResponse: providerResponseData.raw,
        selectedProvider: provider,
        slotResponse: slotResponseData.raw,
        selectedSlot: slot,
        bookingRequest: bookingPayload,
        bookingResponse: bookingData,
      },
    };
  }

  async getConsultationProviders(
    input: LabstackGetConsultationProvidersInput
  ): Promise<{ providers: LabstackProvider[]; raw: unknown }> {
    return this.fetchConsultationProviders(input);
  }

  async getConsultationSlots(
    input: LabstackGetConsultationSlotsInput
  ): Promise<{ slots: LabstackSlot[]; raw: unknown }> {
    return this.fetchConsultationSlots({
      providerId: input.providerId,
      bookingDate: input.bookingDate,
      pincode: input.pincode,
      latitude: input.latitude,
      longitude: input.longitude,
      consultationMode: 'chat',
    });
  }

  async getProviderTypes(input: {
    appointmentType?: string;
    pincode?: string;
  }): Promise<string[]> {
    const result = await this.getProviders({
      providerType: 'DOCTOR',
      appointmentType: input.appointmentType || 'ONLINE',
      pincode: input.pincode,
    });

    const set = new Set<string>();
    result.providers.forEach((provider) => {
      const providerType = this.getFirstString(provider, ['providerType', 'type']);
      if (providerType) {
        set.add(providerType.toUpperCase());
      }
    });

    if (set.size === 0) {
      return ['DOCTOR'];
    }

    return Array.from(set);
  }

  async getProviders(
    input: LabstackProviderSearchInput
  ): Promise<{ providers: LabstackProvider[]; raw: unknown }> {
    const providerResponse = await this.client.get(
      '/v1.0/availability/getProviders',
      {
        params: {
          providerType: this.normalizeProviderType(input.providerType),
          appointmentType: input.appointmentType || 'ONLINE',
          speciality: input.speciality,
          subSpeciality: input.subSpeciality,
          preferredGender: input.preferredGender,
          userUniqueId: input.userUniqueId,
          pincode: input.pincode,
          latitude: input.latitude,
          longitude: input.longitude,
        },
      }
    );

    return {
      providers: this.extractProviders(providerResponse.data),
      raw: providerResponse.data,
    };
  }

  async getGenericSlots(
    input: LabstackGenericSlotInput
  ): Promise<{ slots: LabstackSlot[]; raw: unknown }> {
    return this.fetchConsultationSlots({
      providerId: input.externalProviderId,
      bookingDate: input.bookingDate,
      pincode: input.pincode,
      latitude: input.latitude,
      longitude: input.longitude,
      consultationMode:
        input.appointmentType === 'CENTER_VISIT' ? 'in-person' : 'chat',
      providerType: input.providerType,
      appointmentType: input.appointmentType,
    });
  }

  async getPackages(
    input: LabstackNetworkListInput = {}
  ): Promise<{ packages: Record<string, unknown>[]; raw: unknown }> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.3/network/getPackages', {
          params: {
            pincode: input.pincode,
            latitude: input.latitude,
            longitude: input.longitude,
          },
        }),
      'LABSTACK_GET_PACKAGES_FAILED'
    );

    return {
      packages: this.extractNetworkItems(response.data, ['packages']),
      raw: response.data,
    };
  }

  async getPackageById(
    packageId: string,
    input: LabstackNetworkListInput = {}
  ): Promise<{ packageItem?: Record<string, unknown>; raw: unknown }> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.3/network/getPackage', {
          params: {
            packageId,
            pincode: input.pincode,
            latitude: input.latitude,
            longitude: input.longitude,
          },
        }),
      'LABSTACK_GET_PACKAGE_DETAILS_FAILED'
    );

    return {
      packageItem: this.extractNetworkItem(response.data, ['package', 'packages']),
      raw: response.data,
    };
  }

  async getPackagePreparations(
    packageId: string
  ): Promise<{ preparations: Record<string, unknown>[]; raw: unknown }> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.3/network/getPackagePreparations', {
          params: { packageId },
        }),
      'LABSTACK_GET_PACKAGE_PREPARATIONS_FAILED'
    );

    return {
      preparations: this.extractNetworkItems(response.data, [
        'preparations',
        'packagePreparations',
        'instructions',
      ]),
      raw: response.data,
    };
  }

  async getTests(
    _input: LabstackNetworkListInput = {}
  ): Promise<{ tests: Record<string, unknown>[]; raw: unknown }> {
    const response = await this.requestOrThrow(
      () => this.client.get('/v1.3/network/getTests'),
      'LABSTACK_GET_TESTS_FAILED'
    );

    return {
      tests: this.extractNetworkItems(response.data, ['tests']),
      raw: response.data,
    };
  }

  async getTestById(
    testId: string,
    input: LabstackNetworkListInput = {}
  ): Promise<{ testItem?: Record<string, unknown>; raw: unknown }> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.3/network/getTest', {
          params: {
            testId,
            pincode: input.pincode,
            latitude: input.latitude,
            longitude: input.longitude,
          },
        }),
      'LABSTACK_GET_TEST_DETAILS_FAILED'
    );

    return {
      testItem: this.extractNetworkItem(response.data, ['test', 'tests']),
      raw: response.data,
    };
  }

  async getLabs(
    input: LabstackNetworkListInput = {}
  ): Promise<{ labs: Record<string, unknown>[]; raw: unknown }> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.3/network/getLabs', {
          params: {
            pincode: input.pincode,
          },
        }),
      'LABSTACK_GET_LABS_FAILED'
    );

    return {
      labs: this.extractNetworkItems(response.data, ['labs']),
      raw: response.data,
    };
  }

  async getDiagnosticsSlots(
    input: LabstackDiagnosticsSlotInput
  ): Promise<{ slots: LabstackDiagnosticsSlot[]; raw: unknown }> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.3/availability/getSlots', {
          params: {
            date: this.toIsoDate(input.bookingDate),
            pincode: input.pincode,
            latitude: input.latitude,
            longitude: input.longitude,
            packageIds: this.joinCsv(input.packageIds),
            testIds: this.joinCsv(input.testIds),
          },
        }),
      'LABSTACK_GET_DIAGNOSTICS_SLOTS_FAILED'
    );

    return {
      slots: this.flattenDiagnosticsSlots(response.data, input.bookingDate),
      raw: response.data,
    };
  }

  async placeDiagnosticsOrder(
    input: LabstackDiagnosticsOrderInput
  ): Promise<LabstackDiagnosticsOrderResult> {
    const unitFloorBuilding = this.distinctAddressPart(input.unitFloorBuilding, [
      input.address,
      input.locality,
    ]);
    const locality = this.distinctAddressPart(input.locality, [
      input.address,
      input.unitFloorBuilding,
    ]);
    const payload: Record<string, unknown> = {
      orderType: input.orderType,
      appointment: input.appointment,
      name: input.name,
      mobile: input.mobile,
      email: input.email,
      gender: input.gender,
      age: input.age,
      pincode: input.pincode,
      unitFloorBuilding,
      locality,
      city: input.city,
      state: input.state,
      latitude: input.latitude,
      longitude: input.longitude,
      address: this.limitProviderAddress(input.address),
      packageIds: input.packageIds,
      testIds: input.testIds,
      labId: input.labId,
      uniqueId: input.uniqueId,
      referenceId: input.referenceId,
      notes: input.notes,
      altContact: input.altContact,
    };

    Object.keys(payload).forEach((key) => {
      const value = payload[key];
      if (
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0)
      ) {
        delete payload[key];
      }
    });

    logger.info('[Labstack] sending diagnostics booking payload', {
      endpoint: '/v1.3/order/placeOrder',
      payload,
    });

    const response = await this.requestOrThrow(
      () => this.client.post('/v1.3/order/placeOrder', payload),
      'LABSTACK_PLACE_ORDER_FAILED'
    );

    const body = (response.data || {}) as Record<string, unknown>;
    const nestedData =
      body.data && typeof body.data === 'object'
        ? (body.data as Record<string, unknown>)
        : undefined;
    const orderObj =
      body.order && typeof body.order === 'object'
        ? (body.order as Record<string, unknown>)
        : nestedData?.order && typeof nestedData.order === 'object'
          ? (nestedData.order as Record<string, unknown>)
          : undefined;

    return {
      externalBookingId:
        this.getFirstString(orderObj || {}, ['orderId', 'referenceId', 'id']) ||
        this.getFirstString(body, ['orderId', 'referenceId', 'id']) ||
        this.getFirstString(nestedData || {}, ['orderId', 'referenceId', 'id']),
      externalStatus:
        this.getFirstString(orderObj || {}, ['orderStatus', 'status']) ||
        this.getFirstString(body, ['orderStatus', 'status']) ||
        this.getFirstString(nestedData || {}, ['orderStatus', 'status']),
      payload: {
        bookingRequest: payload,
        bookingResponse: body,
      },
    };
  }

  async getCamps(
    input: LabstackCampListInput = {}
  ): Promise<{ camps: Record<string, unknown>[]; raw: unknown }> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.3/camp/getCamps', {
          params: {
            startDate: input.startDate,
            endDate: input.endDate,
          },
        }),
      'LABSTACK_GET_CAMPS_FAILED'
    );

    return {
      camps: this.extractNetworkItems(response.data, ['camps']),
      raw: response.data,
    };
  }

  async getCampDetails(
    campLsId: string
  ): Promise<{ campDetails?: Record<string, unknown>; raw: unknown }> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.3/camp/getCampDetails', {
          params: { campLsId },
        }),
      'LABSTACK_GET_CAMP_DETAILS_FAILED'
    );

    const body = (response.data || {}) as Record<string, unknown>;
    return {
      campDetails:
        body.campDetails && typeof body.campDetails === 'object'
          ? (body.campDetails as Record<string, unknown>)
          : undefined,
      raw: response.data,
    };
  }

  async getCampSlots(
    campLsId: string
  ): Promise<{ slotsByDate: Record<string, unknown>[]; raw: unknown }> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.3/camp/getCampSlots', {
          params: { campLsId },
        }),
      'LABSTACK_GET_CAMP_SLOTS_FAILED'
    );

    return {
      slotsByDate: this.extractNetworkItems(response.data, ['slotsByDate']),
      raw: response.data,
    };
  }

  async placeCampOrder(
    input: LabstackCampOrderInput
  ): Promise<LabstackCampOrderResult> {
    const payload: Record<string, unknown> = {
      campLsId: input.campLsId,
      orderType: 'CAMP',
      isVip: input.isVip,
      referenceId: input.referenceId,
      packageIds: input.packageIds,
      testIds: input.testIds,
      labId: input.labId,
      pincode: input.pincode,
      appointment: input.appointment,
      notes: input.notes,
      uniqueId: input.uniqueId,
      name: input.name,
      email: input.email,
      dateOfBirth: input.dateOfBirth,
      age: input.age,
      gender: input.gender,
      mobile: input.mobile,
      altContact: input.altContact,
      mainUserUniqueId: input.mainUserUniqueId,
      relationship: input.relationship,
    };

    Object.keys(payload).forEach((key) => {
      const value = payload[key];
      if (
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0)
      ) {
        delete payload[key];
      }
    });

    logger.info('[Labstack] sending camp order payload', {
      endpoint: '/v1.3/camp/placeOrder',
      payload,
    });
    console.log('[Labstack] sending camp order payload', {
      endpoint: '/v1.3/camp/placeOrder',
      payload,
    });

    const response = await this.requestOrThrow(
      () => this.client.post('/v1.3/camp/placeCampOrder', payload),
      'LABSTACK_PLACE_CAMP_ORDER_FAILED'
    );

    const body = (response.data || {}) as Record<string, unknown>;
    const nestedData =
      body.data && typeof body.data === 'object'
        ? (body.data as Record<string, unknown>)
        : undefined;
    const orderObj =
      body.order && typeof body.order === 'object'
        ? (body.order as Record<string, unknown>)
        : nestedData?.order && typeof nestedData.order === 'object'
          ? (nestedData.order as Record<string, unknown>)
          : undefined;

    return {
      externalBookingId:
        this.getFirstString(orderObj || {}, ['orderId', 'referenceId', 'id']) ||
        this.getFirstString(body, ['orderId', 'referenceId', 'id']) ||
        this.getFirstString(nestedData || {}, ['orderId', 'referenceId', 'id']),
      externalStatus:
        this.getFirstString(orderObj || {}, ['orderStatus', 'status']) ||
        this.getFirstString(body, ['orderStatus', 'status']) ||
        this.getFirstString(nestedData || {}, ['orderStatus', 'status']),
      payload: {
        bookingRequest: payload,
        bookingResponse: body,
      },
    };
  }

  async cancelAppointment(input: {
    appointmentId: string;
    reason?: string;
  }): Promise<LabstackAppointmentLifecycleResult> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.0/appointment/cancelAppointment', {
          params: {
            appointmentId: input.appointmentId,
            reason: input.reason,
          },
        }),
      'LABSTACK_CANCEL_APPOINTMENT_FAILED'
    );

    return this.mapAppointmentLifecycleResponse(response.data, input.appointmentId);
  }

  async cancelOrder(input: {
    orderId: string;
    reason?: string;
  }): Promise<LabstackOrderLifecycleResult> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.3/order/cancelOrder', {
          params: {
            orderId: input.orderId,
            reason: input.reason,
          },
        }),
      'LABSTACK_CANCEL_ORDER_FAILED'
    );

    return this.mapOrderLifecycleResponse(response.data, input.orderId);
  }

  async rescheduleAppointment(input: {
    appointmentId: string;
    appointmentTime: string;
  }): Promise<LabstackAppointmentLifecycleResult> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.0/appointment/rescheduleAppointment', {
          params: {
            appointmentId: input.appointmentId,
            appointmentTime: input.appointmentTime,
          },
        }),
      'LABSTACK_RESCHEDULE_APPOINTMENT_FAILED'
    );

    return this.mapAppointmentLifecycleResponse(response.data, input.appointmentId);
  }

  async rescheduleOrder(input: {
    orderId: string;
    appointment: string;
  }): Promise<LabstackOrderLifecycleResult> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.3/order/rescheduleOrder', {
          params: {
            orderId: input.orderId,
            appointment: input.appointment,
          },
        }),
      'LABSTACK_RESCHEDULE_ORDER_FAILED'
    );

    return this.mapOrderLifecycleResponse(response.data, input.orderId);
  }

  async getAppointmentDetails(input: {
    appointmentId: string;
  }): Promise<LabstackAppointmentDetailsResult> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.0/appointment/getAppointmentDetails', {
          params: {
            appointmentId: input.appointmentId,
          },
        }),
      'LABSTACK_GET_APPOINTMENT_DETAILS_FAILED'
    );

    const body = (response.data || {}) as Record<string, unknown>;
    const nestedData =
      body.data && typeof body.data === 'object'
        ? (body.data as Record<string, unknown>)
        : undefined;
    const appointmentObj =
      body.appointment && typeof body.appointment === 'object'
        ? (body.appointment as Record<string, unknown>)
        : nestedData?.appointment && typeof nestedData.appointment === 'object'
          ? (nestedData.appointment as Record<string, unknown>)
          : undefined;

    return {
      externalBookingId:
        this.getFirstString(appointmentObj || body, [
          'appointmentId',
          'lsAppointmentId',
          'id',
          'referenceId',
        ]) ||
        this.getFirstString(nestedData || {}, [
          'appointmentId',
          'lsAppointmentId',
          'id',
          'referenceId',
        ]) ||
        input.appointmentId,
      payload: body,
    };
  }

  async getDocument(input: {
    appointmentId: string;
    documentId: string;
  }): Promise<LabstackDocumentResult> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.0/appointment/getDocument', {
          params: {
            appointmentId: input.appointmentId,
            documentId: input.documentId,
          },
        }),
      'LABSTACK_GET_DOCUMENT_FAILED'
    );

    return {
      payload: (response.data || {}) as Record<string, unknown>,
    };
  }

  async getOrderReport(input: {
    orderId: string;
    reportId: string;
  }): Promise<Buffer> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.3/order/getReport', {
          params: {
            orderId: input.orderId,
            reportId: input.reportId,
          },
          responseType: 'arraybuffer',
        }),
      'LABSTACK_GET_ORDER_REPORT_FAILED'
    );

    return Buffer.from(response.data);
  }

  async getOrderDetails(input: {
    orderId: string;
  }): Promise<LabstackOrderDetailsResult> {
    logger.info('[Labstack][getOrderDetails] calling upstream API', {
      method: 'GET',
      endpoint: '/v1.3/order/getOrderDetails',
      params: {
        orderId: input.orderId,
      },
    });

    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.3/order/getOrderDetails', {
          params: {
            orderId: input.orderId,
          },
        }),
      'LABSTACK_GET_ORDER_DETAILS_FAILED'
    );

    const body = (response.data || {}) as Record<string, unknown>;
    const orderDetails =
      body.orderDetails && typeof body.orderDetails === 'object'
        ? (body.orderDetails as Record<string, unknown>)
        : undefined;

    return {
      externalBookingId:
        this.getFirstString(orderDetails || body, [
          'orderId',
          'lsOrderId',
          'id',
          'referenceId',
        ]) || input.orderId,
      payload: body,
    };
  }

  async checkServiceability(
    input: LabstackServiceabilityInput
  ): Promise<Record<string, unknown>> {
    const response = await this.requestOrThrow(
      () =>
        this.client.get('/v1.3/availability/checkServiceability', {
          params: {
            pincode: input.pincode,
            latitude: input.latitude,
            longitude: input.longitude,
            packageIds: this.joinCsv(input.packageIds),
            testIds: this.joinCsv(input.testIds),
          },
        }),
      'LABSTACK_CHECK_SERVICEABILITY_FAILED'
    );

    return (response.data || {}) as Record<string, unknown>;
  }

  private getAppointmentType(
    consultationMode: LabstackConsultationBookingInput['consultationMode']
  ): 'ONLINE' | 'CENTER_VISIT' {
    return consultationMode === 'in-person' ? 'CENTER_VISIT' : 'ONLINE';
  }

  private async fetchConsultationProviders(input: {
    specialistName?: string;
    userUniqueId?: string;
    pincode?: string;
    providerType?: string;
    appointmentType?: string;
  }): Promise<{ providers: LabstackProvider[]; raw: unknown }> {
    const providerResponse = await this.requestOrThrow(
      () =>
        this.client.get('/v1.0/availability/getProviders', {
          params: {
            providerType: this.normalizeProviderType(input.providerType || 'DOCTOR'),
            appointmentType: input.appointmentType || 'ONLINE',
            speciality: input.specialistName,
            pincode: input.pincode,
          },
        }),
      'LABSTACK_GET_PROVIDERS_FAILED'
    );

    return {
      providers: this.extractProviders(providerResponse.data),
      raw: providerResponse.data,
    };
  }

  private extractProviders(responseData: unknown): LabstackProvider[] {
    if (Array.isArray(responseData)) {
      return responseData as LabstackProvider[];
    }
    if (!responseData || typeof responseData !== 'object') {
      return [];
    }

    const direct = (responseData as any)?.providers;
    if (Array.isArray(direct)) {
      return direct as LabstackProvider[];
    }

    const nested = (responseData as any)?.data?.providers;
    if (Array.isArray(nested)) {
      return nested as LabstackProvider[];
    }

    // Fallback: some APIs return `data: []`
    const dataArr = (responseData as any)?.data;
    if (Array.isArray(dataArr)) {
      return dataArr as LabstackProvider[];
    }

    return [];
  }

  private extractNetworkItems(
    responseData: unknown,
    preferredKeys: string[]
  ): Record<string, unknown>[] {
    if (Array.isArray(responseData)) {
      return responseData.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && !Array.isArray(item)
      );
    }

    if (!responseData || typeof responseData !== 'object') {
      return [];
    }

    const source = responseData as Record<string, unknown>;

    for (const key of preferredKeys) {
      const direct = source[key];
      if (Array.isArray(direct)) {
        return direct.filter(
          (item): item is Record<string, unknown> =>
            !!item && typeof item === 'object' && !Array.isArray(item)
        );
      }
    }

    const data = source.data;
    if (Array.isArray(data)) {
      return data.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && !Array.isArray(item)
      );
    }

    if (data && typeof data === 'object') {
      const nestedData = data as Record<string, unknown>;
      for (const key of preferredKeys) {
        const value = nestedData[key];
        if (Array.isArray(value)) {
          return value.filter(
            (item): item is Record<string, unknown> =>
              !!item && typeof item === 'object' && !Array.isArray(item)
          );
        }
      }
    }

    return [];
  }

  private extractNetworkItem(
    responseData: unknown,
    preferredKeys: string[]
  ): Record<string, unknown> | undefined {
    const items = this.extractNetworkItems(responseData, preferredKeys);
    if (items.length > 0) {
      return items[0];
    }

    if (!responseData || typeof responseData !== 'object') {
      return undefined;
    }

    const source = responseData as Record<string, unknown>;

    for (const key of preferredKeys) {
      const direct = source[key];
      if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
        return direct as Record<string, unknown>;
      }
    }

    const data = source.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const nestedData = data as Record<string, unknown>;
      for (const key of preferredKeys) {
        const value = nestedData[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return value as Record<string, unknown>;
        }
      }

      if (preferredKeys.includes('package') || preferredKeys.includes('test')) {
        return nestedData;
      }
    }

    // Some v1.3 detail APIs return the entity directly at root:
    // { status: "success", packageId: "...", packageName: "...", ... }
    // or { status: "success", testId/lsTestId: "...", testName: "...", ... }
    const wantsPackage = preferredKeys.includes('package');
    const wantsTest = preferredKeys.includes('test');
    const looksLikePackage =
      typeof source.packageId === 'string' || typeof source.packageName === 'string';
    const looksLikeTest =
      typeof source.testId === 'string' ||
      typeof source.lsTestId === 'string' ||
      typeof source.testName === 'string';

    if ((wantsPackage && looksLikePackage) || (wantsTest && looksLikeTest)) {
      return source;
    }

    return undefined;
  }

  private async fetchConsultationSlots(input: {
    providerId: string;
    bookingDate: string;
    pincode?: string;
    latitude?: string;
    longitude?: string;
    consultationMode: LabstackConsultationBookingInput['consultationMode'];
    providerType?: string;
    appointmentType?: string;
  }): Promise<{ slots: LabstackSlot[]; raw: unknown }> {
    const slotResponse = await this.requestOrThrow(
      () =>
        this.client.get('/v1.0/availability/getAppointmentSlots', {
          params: {
            providerType: this.normalizeProviderType(input.providerType || 'DOCTOR'),
            appointmentType:
              input.appointmentType || this.getAppointmentType(input.consultationMode),
            lsProviderId: input.providerId,
            date: this.toIsoDate(input.bookingDate),
            pincode: input.pincode,
            latitude: input.latitude,
            longitude: input.longitude,
          },
        }),
      'LABSTACK_GET_SLOTS_FAILED'
    );

    return {
      slots: this.flattenAppointmentSlots(slotResponse.data, input.providerId, input.bookingDate),
      raw: slotResponse.data,
    };
  }

  private flattenAppointmentSlots(
    responseData: unknown,
    externalProviderId: string,
    bookingDateYyyymmdd: string
  ): LabstackSlot[] {
    const raw = (responseData || {}) as LabstackGetAppointmentSlotsResponse;
    const providerEntries = Array.isArray(raw?.slots) ? raw.slots : [];
    const flattened: LabstackSlot[] = [];

    for (const entry of providerEntries) {
      const providerName = this.getFirstString(entry, ['providerName', 'name']);
      const timings = (entry as any)?.timing;
      if (!Array.isArray(timings) || timings.length === 0) {
        continue;
      }

      for (const t of timings) {
        const start24 = this.getFirstString(t, ['startTime']);
        const end24 = this.getFirstString(t, ['endTime']);
        if (!start24) {
          continue;
        }

        flattened.push({
          externalProviderId,
          date: bookingDateYyyymmdd,
          startTime24h: start24,
          endTime24h: end24,
          startTimeDisplay: this.toAmPm(start24),
          endTimeDisplay: end24 ? this.toAmPm(end24) : undefined,
          providerName,
          raw: { entry, timing: t },
        });
      }
    }

    return flattened;
  }

  private flattenDiagnosticsSlots(
    responseData: unknown,
    bookingDateYyyymmdd: string
  ): LabstackDiagnosticsSlot[] {
    const entries = this.extractUnknownArray(responseData, ['slots', 'data', 'labs']);
    const slots: LabstackDiagnosticsSlot[] = [];

    for (const entry of entries) {
      const externalProviderId =
        this.getFirstString(entry, ['labId', 'lsLabId', 'providerId', 'id']) ||
        'labstack';

      const labId = this.getFirstString(entry, ['labId', 'lsLabId', 'id']);
      const timings = (entry as Record<string, unknown>).timing;

      if (Array.isArray(timings) && timings.length > 0) {
        for (const timing of timings) {
          let start24: string | undefined;
          let end24: string | undefined;
          let timingRaw: Record<string, unknown> | string;

          if (typeof timing === 'string') {
            const normalizedTiming = this.normalizeTime(timing);
            start24 = normalizedTiming
              ? this.tryParseTo24h(normalizedTiming)
              : undefined;
            timingRaw = timing;
          } else if (timing && typeof timing === 'object') {
            const timingObj = timing as Record<string, unknown>;
            start24 =
              this.getFirstString(timingObj, ['startTime', 'start']) ||
              this.tryParseTo24h(
                this.normalizeTime(this.getFirstString(timingObj, ['slot', 'time'])) || ''
              );
            end24 = this.getFirstString(timingObj, ['endTime', 'end']);
            timingRaw = timingObj;
          } else {
            continue;
          }

          if (!start24) {
            continue;
          }

          slots.push({
            externalProviderId,
            labId,
            date: bookingDateYyyymmdd,
            startTime24h: start24,
            endTime24h: end24,
            startTimeDisplay: this.toAmPm(start24),
            endTimeDisplay: end24 ? this.toAmPm(end24) : undefined,
            raw: { entry, timing: timingRaw },
          });
        }
        continue;
      }

      const directTime =
        this.getFirstString(entry, ['startTime', 'time', 'slotTime']) ||
        this.getFirstString(entry, ['slot']);
      const normalizedDirectTime = this.normalizeTime(directTime);
      if (!normalizedDirectTime) {
        continue;
      }
      const start24 = this.tryParseTo24h(normalizedDirectTime);
      const end24 = this.getFirstString(entry, ['endTime']);

      slots.push({
        externalProviderId,
        labId,
        date: bookingDateYyyymmdd,
        startTime24h: start24,
        endTime24h: end24,
        startTimeDisplay: this.toAmPm(start24),
        endTimeDisplay: end24 ? this.toAmPm(end24) : undefined,
        raw: entry,
      });
    }

    return slots;
  }

  private pickProvider(
    input: LabstackConsultationBookingInput,
    providers: LabstackProvider[]
  ): LabstackProvider {
    const bySelectedId = input.selectedProviderId
      ? providers.find(
          (provider) =>
            this.getFirstString(provider, ['lsProviderId', 'providerId', 'id','lsId']) ===
            input.selectedProviderId
        )
      : undefined;
    if (bySelectedId) {
      return bySelectedId;
    }

    const normalizedSpecialistName = this.normalize(input.specialistName);
    const byName = normalizedSpecialistName
      ? providers.find((provider) => {
          const providerName = this.normalize(
            this.getFirstString(provider, ['name', 'fullName', 'providerName'])
          );
          return providerName ? providerName.includes(normalizedSpecialistName) : false;
        })
      : undefined;
    if (byName) {
      return byName;
    }

    const normalizedEmail = this.normalize(input.specialistEmail);
    const byEmail = normalizedEmail
      ? providers.find((provider) => this.normalize(provider.email) === normalizedEmail)
      : undefined;
    if (byEmail) {
      return byEmail;
    }

    const normalizedPhone = this.normalizeDigits(input.specialistPhone);
    const byPhone = normalizedPhone
      ? providers.find(
          (provider) => this.normalizeDigits(provider.mobile) === normalizedPhone
        )
      : undefined;
    if (byPhone) {
      return byPhone;
    }

    return providers[0];
  }

  private pickSlot(
    input: LabstackConsultationBookingInput,
    slots: LabstackSlot[]
  ): LabstackSlot {
    const selectedTime = input.selectedSlotTime || input.bookingTime;
    const normalized = this.normalizeTime(selectedTime);
    if (normalized) {
      const selected24h = this.tryParseTo24h(normalized);
      const byTime = slots.find((slot) => slot.startTime24h === selected24h);
      if (byTime) {
        return byTime;
      }

      throw new AppError({
        status: 400,
        code: 'LABSTACK_SLOT_NOT_FOUND',
        message: `Requested slot ${selectedTime} is not available`,
      });
    }

    // Fallback: first available slot
    return slots[0];
  }

  private getFirstString(
    source: Record<string, unknown>,
    keys: string[]
  ): string | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
      if (typeof value === 'number') {
        return String(value);
      }
    }

    return undefined;
  }

  private normalize(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }

    const normalized = value.trim().toLowerCase();
    return normalized || undefined;
  }

  private normalizeDigits(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }

    const normalized = value.replace(/\D/g, '');
    return normalized || undefined;
  }

  private normalizeTime(value?: string): string | undefined {
    const normalized = this.normalize(value);
    if (!normalized) {
      return undefined;
    }

    return normalized.replace(/\s+/g, '');
  }

  private joinCsv(values?: string[]): string | undefined {
    if (!values || !values.length) {
      return undefined;
    }
    const normalized = values.map((value) => value.trim()).filter(Boolean);
    return normalized.length ? normalized.join(',') : undefined;
  }

  private extractUnknownArray(
    responseData: unknown,
    keys: string[]
  ): Record<string, unknown>[] {
    if (Array.isArray(responseData)) {
      return responseData.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && !Array.isArray(item)
      );
    }

    if (!responseData || typeof responseData !== 'object') {
      return [];
    }

    const source = responseData as Record<string, unknown>;
    for (const key of keys) {
      const value = source[key];
      if (Array.isArray(value)) {
        return value.filter(
          (item): item is Record<string, unknown> =>
            !!item && typeof item === 'object' && !Array.isArray(item)
        );
      }
    }

    const nestedData = source.data;
    if (nestedData && typeof nestedData === 'object' && !Array.isArray(nestedData)) {
      const nested = nestedData as Record<string, unknown>;
      for (const key of keys) {
        const value = nested[key];
        if (Array.isArray(value)) {
          return value.filter(
            (item): item is Record<string, unknown> =>
              !!item && typeof item === 'object' && !Array.isArray(item)
          );
        }
      }
    }

    return [];
  }

  private toIsoDate(yyyymmdd: string): string {
    if (!/^\d{8}$/.test(yyyymmdd)) {
      return yyyymmdd;
    }

    return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  }

  private toAppointmentIsoDatetime(yyyymmdd: string, hhmm24: string): string {
    const isoDate = this.toIsoDate(yyyymmdd);
    // LabStack expects local appointment datetime without a timezone suffix.
    return `${isoDate}T${hhmm24}:00.000`;
  }

  private toIsoBirthDate(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }

    const trimmed = value.trim();
    if (/^\d{8}$/.test(trimmed)) {
      return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
    }

    return trimmed;
  }

  private joinName(firstName: string, lastName?: string): string {
    const name = `${firstName || ''} ${lastName || ''}`.trim();
    return name || 'Patient';
  }

  private toAmPm(hhmm24: string): string {
    const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm24.trim());
    if (!match) {
      return hhmm24;
    }
    let h = parseInt(match[1], 10);
    const m = match[2];
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${ampm}`;
  }

  private tryParseTo24h(value: string): string {
    // Accept "09:15" or "9:15"
    const hhmm = /^(\d{1,2}):(\d{2})$/.exec(value);
    if (hhmm) {
      const h = Math.max(0, Math.min(23, parseInt(hhmm[1], 10)));
      const m = Math.max(0, Math.min(59, parseInt(hhmm[2], 10)));
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    // Accept "9:15am", "9:15am", "9:15pm"
    const ampm = /^(\d{1,2}):(\d{2})(am|pm)$/.exec(value);
    if (ampm) {
      let h = parseInt(ampm[1], 10);
      const m = parseInt(ampm[2], 10);
      const suffix = ampm[3];
      if (suffix === 'am') {
        if (h === 12) h = 0;
      } else {
        if (h !== 12) h += 12;
      }
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    // Fallback: return as-is (might already be "HH:MM")
    return value;
  }

  private normalizeProviderType(providerType?: string): string {
    if (!providerType || !providerType.trim()) {
      return 'Doctor';
    }

    const normalized = providerType.trim().toLowerCase().replace(/[_-]+/g, ' ');
    const map: Record<string, string> = {
      doctor: 'Doctor',
      dentist: 'Dentist',
      nutritionist: 'Nutritionist',
      'health coach': 'Health Coach',
      psychologist: 'Psychologist',
      'mental health counsellor': 'Mental Health Counsellor',
      physiotherapist: 'Physiotherapist',
      chiropractor: 'Chiropractor',
      'speech therapist': 'Speech Therapist',
      audiologist: 'Audiologist',
      audiometrist: 'Audiometrist',
      optometrist: 'Optometrist',
      optician: 'Optician',
      nurse: 'Nurse',
      'care taker': 'Care Taker',
      phlebotomist: 'Phlebotomist',
      'phlebo runner': 'Phlebo Runner',
    };

    return map[normalized] || providerType;
  }

  private async requestOrThrow<T>(
    fn: () => Promise<T>,
    code: string
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status || 500;
      const data = axiosError.response?.data;
      logger.error('[Labstack] request failed', {
        code,
        status,
        message: axiosError.message,
        responseData: data,
      });
      const messageFromBody =
        typeof data === 'string'
          ? data
          : ((data as Record<string, unknown> | undefined)?.message ||
              (data as Record<string, unknown> | undefined)?.error);

      throw new AppError({
        status,
        code,
        message:
          typeof messageFromBody === 'string' && messageFromBody
            ? `LabStack error: ${messageFromBody}`
            : axiosError.message || 'LabStack request failed',
      });
    }
  }

  private getLocationLogFields(
    params?: unknown,
    data?: unknown
  ): {
    hasLocation: boolean;
    pincode?: unknown;
    latitude?: unknown;
    longitude?: unknown;
  } {
    const paramRecord =
      params && typeof params === 'object' && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : {};
    const dataRecord =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
    const pincode = paramRecord.pincode ?? dataRecord.pincode;
    const latitude = paramRecord.latitude ?? dataRecord.latitude;
    const longitude = paramRecord.longitude ?? dataRecord.longitude;

    return {
      hasLocation:
        pincode !== undefined || latitude !== undefined || longitude !== undefined,
      pincode,
      latitude,
      longitude,
    };
  }

  private distinctAddressPart(
    value?: string,
    comparisons: Array<string | undefined> = []
  ): string | undefined {
    const normalized = value?.trim();
    if (!normalized) {
      return undefined;
    }

    const lowered = normalized.toLowerCase();
    const hasDuplicate = comparisons.some((item) => {
      const comparison = item?.trim();
      return comparison ? comparison.toLowerCase() === lowered : false;
    });

    return hasDuplicate ? undefined : normalized;
  }

  private limitProviderAddress(
    value?: string,
    maxLength = 200
  ): string | undefined {
    const normalized = value?.trim();
    if (!normalized) {
      return undefined;
    }

    return normalized.length > maxLength
      ? normalized.slice(0, maxLength)
      : normalized;
  }

  private mapAppointmentLifecycleResponse(
    responseData: unknown,
    fallbackAppointmentId: string
  ): LabstackAppointmentLifecycleResult {
    const body = (responseData || {}) as Record<string, unknown>;
    const nestedData =
      body.data && typeof body.data === 'object'
        ? (body.data as Record<string, unknown>)
        : undefined;
    const appointmentObj =
      body.appointment && typeof body.appointment === 'object'
        ? (body.appointment as Record<string, unknown>)
        : nestedData?.appointment && typeof nestedData.appointment === 'object'
          ? (nestedData.appointment as Record<string, unknown>)
          : undefined;

    return {
      externalBookingId:
        this.getFirstString(appointmentObj || body, [
          'appointmentId',
          'lsAppointmentId',
          'id',
          'referenceId',
        ]) ||
        this.getFirstString(nestedData || {}, [
          'appointmentId',
          'lsAppointmentId',
          'id',
          'referenceId',
        ]) ||
        fallbackAppointmentId,
      externalStatus:
        this.getFirstString(appointmentObj || body, [
          'appointmentStatus',
          'status',
        ]) ||
        this.getFirstString(nestedData || {}, [
          'appointmentStatus',
          'status',
        ]),
      payload: body,
    };
  }

  private mapOrderLifecycleResponse(
    responseData: unknown,
    fallbackOrderId: string
  ): LabstackOrderLifecycleResult {
    const body = (responseData || {}) as Record<string, unknown>;
    const nestedData =
      body.data && typeof body.data === 'object'
        ? (body.data as Record<string, unknown>)
        : undefined;
    const orderObj =
      body.order && typeof body.order === 'object'
        ? (body.order as Record<string, unknown>)
        : nestedData?.order && typeof nestedData.order === 'object'
          ? (nestedData.order as Record<string, unknown>)
          : undefined;

    return {
      externalBookingId:
        this.getFirstString(orderObj || body, [
          'orderId',
          'referenceId',
          'id',
        ]) ||
        this.getFirstString(nestedData || {}, [
          'orderId',
          'referenceId',
          'id',
        ]) ||
        fallbackOrderId,
      externalStatus:
        this.getFirstString(orderObj || body, [
          'orderStatus',
          'status',
        ]) ||
        this.getFirstString(nestedData || {}, [
          'orderStatus',
          'status',
        ]),
      payload: body,
    };
  }
}
