import crypto from 'crypto';

import axios, { AxiosError, AxiosInstance } from 'axios';
import { Service } from 'typedi';

import { CONFIG } from '@/config/config';
import { AppError } from '@/modules/common/types';
import logger from '@/services/logger';

type HealthiansApiResponse = Record<string, unknown>;

export interface HealthiansProvider {
  doctor_id?: string;
  id?: string;
  name?: string;
  doctor_name?: string;
  full_name?: string;
  speciality?: string;
  [key: string]: unknown;
}

export interface HealthiansSlot {
  externalProviderId: string;
  date: string;
  startTime24h: string;
  endTime24h?: string;
  startTimeDisplay: string;
  endTimeDisplay?: string;
  raw: Record<string, unknown>;
}

interface PartnerProductsInput {
  pincode?: string;
  latitude?: number;
  longitude?: number;
  productType?: 'profile' | 'package' | 'parameter' | 'test' | string;
  productTypeId?: string;
  start?: string;
  limit?: string;
  testType?: string;
  clientId?: string;
}

@Service()
export class HealthiansService {
  private readonly client: AxiosInstance;

  constructor() {
    const baseURL = (CONFIG.HEALTHIANS_BASE_URL || '').replace(/\/+$/, '');
    if (!baseURL) {
      throw new AppError({
        status: 500,
        code: 'HEALTHIANS_CONFIG_MISSING',
        message: 'Healthians base URL is missing',
      });
    }

    this.client = axios.create({
      baseURL,
      timeout: 20000,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  private get partnerName(): string {
    const partnerName = CONFIG.HEALTHIANS_PARTNER_NAME?.trim();
    if (!partnerName) {
      throw new AppError({
        status: 500,
        code: 'HEALTHIANS_PARTNER_MISSING',
        message: 'Healthians partner name is missing',
      });
    }
    return partnerName;
  }

  private get username(): string {
    const username = CONFIG.HEALTHIANS_USERNAME?.trim();
    if (!username) {
      throw new AppError({
        status: 500,
        code: 'HEALTHIANS_AUTH_MISSING',
        message: 'Healthians username is missing',
      });
    }
    return username;
  }

  private get password(): string {
    const password = CONFIG.HEALTHIANS_PASSWORD?.trim();
    if (!password) {
      throw new AppError({
        status: 500,
        code: 'HEALTHIANS_AUTH_MISSING',
        message: 'Healthians password is missing',
      });
    }
    return password;
  }

  private get checksumKey(): string | undefined {
    const checksumKey = CONFIG.HEALTHIANS_CHECKSUM?.trim();
    return checksumKey || undefined;
  }

  private createChecksum(data: string): string | undefined {
    if (!this.checksumKey) {
      return undefined;
    }

    return crypto.createHmac('sha256', this.checksumKey).update(data).digest('hex');
  }

  private getChecksumHeaders(data: string): Record<string, string> | undefined {
    const checksum = this.createChecksum(data);
    return checksum
      ? {
          checksum,
          'x-checksum': checksum,
        }
      : undefined;
  }

  private async getAccessToken(): Promise<string> {
    const path = `/${this.partnerName}/getAccessToken`;
    try {
      const response = await this.client.get(path, {
        auth: {
          username: this.username,
          password: this.password,
        },
        headers: this.getChecksumHeaders(''),
      });
      const body = (response.data || {}) as Record<string, unknown>;
      const accessToken = this.getFirstString(body, [
        'access_token',
        'token',
        'accessToken',
      ]);

      if (!accessToken) {
        throw new AppError({
          status: 502,
          code: 'HEALTHIANS_TOKEN_MISSING',
          message: 'Healthians access token missing in response',
        });
      }
      return accessToken;
    } catch (error) {
      this.handleAxiosError(error, 'HEALTHIANS_TOKEN_FAILED', {
        method: 'GET',
        path,
      });
    }
  }

  private async post(
    endpoint: string,
    payload?: Record<string, unknown>
  ): Promise<HealthiansApiResponse> {
    const accessToken = await this.getAccessToken();
    const path = `/${this.partnerName}/${endpoint}`;
    const requestData = JSON.stringify(payload || {});
    const locationLog = this.getLocationLogFields(payload || {});

    try {
      if (locationLog.hasLocation) {
        logger.info('[Healthians] API called with location', {
          endpoint,
          path,
          pincode: locationLog.pincode,
          latitude: locationLog.latitude,
          longitude: locationLog.longitude,
        });
      }

      const response = await this.client.post(path, requestData, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...this.getChecksumHeaders(requestData),
        },
      });
      const responseData = (response.data || {}) as HealthiansApiResponse;

      // logger.info('[Healthians] response received', {
      //   endpoint,
      //   path,
      //   status: response.status,
      //   responseData,
      // });

      return responseData;
    } catch (error) {
      this.handleAxiosError(error, `HEALTHIANS_${endpoint.toUpperCase()}_FAILED`, {
        method: 'POST',
        endpoint,
        path,
        payload: payload || {},
      });
    }
  }

  async getSpecialityList(): Promise<{ specialities: Record<string, unknown>[]; raw: unknown }> {
    // const raw = await this.post('getSpecialityList', {});
    const raw={};
    return {
      specialities: this.extractArray(raw, ['specialities', 'specialty', 'data']),
      raw,
    };
  }

  async getSpecialityDoctorList(_input: {
    speciality?: string;
  }): Promise<{ providers: HealthiansProvider[]; raw: unknown }> {
    // const raw = await this.post('getSpecialityDoctorList', {
    //   speciality_key: _input.speciality,
    // });
    const raw={};
    return {
      providers: this.extractArray(raw, ['doctors', 'doctor_list', 'data']) as HealthiansProvider[],
      raw,
    };
  }

  async getProviderTypes(_input: {
    appointmentType?: string;
    pincode?: string;
  }): Promise<string[]> {
    const result = await this.getSpecialityList();
    const types = new Set<string>();
    result.specialities.forEach((item) => {
      const value = this.getFirstString(item, [
        'speciality_key',
        'speciality',
        'speciality_name',
        'name',
      ]);
      if (value) {
        types.add(value);
      }
    });
    return types.size ? Array.from(types) : ['doctor'];
  }

  async getProviders(input: {
    speciality?: string;
  }): Promise<{ providers: HealthiansProvider[]; raw: unknown }> {
    return this.getSpecialityDoctorList({ speciality: input.speciality });
  }

  async getGenericSlots(input: {
    externalProviderId: string;
    bookingDate: string;
  }): Promise<{ slots: HealthiansSlot[]; raw: unknown }> {
    const raw = await this.post('getSlotForDoctor', {
      collection_date: this.toIsoDate(input.bookingDate),
      doctor_id: input.externalProviderId,
    });
    const slots = this.extractArray(raw, ['slots', 'data', 'slot_list']).map((slot) =>
      this.mapDoctorSlot(slot, input.externalProviderId, input.bookingDate)
    );
    return {
      slots: slots.filter(Boolean) as HealthiansSlot[],
      raw,
    };
  }

  async createConsultationBooking(input: {
    bookingDate: string;
    bookingTime: string;
    userUniqueId: string;
    firstName: string;
    lastName?: string;
    email?: string;
    mobile?: string;
    gender?: string;
    dateOfBirth?: string;
    age?: string;
    selectedProviderId?: string;
    selectedSlotTime?: string;
  }): Promise<{
    externalBookingId?: string;
    externalProviderId?: string;
    externalSlotTime?: string;
    externalStatus?: string;
    meetingLink?: string;
    payload: Record<string, unknown>;
  }> {
    if (!input.selectedProviderId) {
      throw new AppError({
        status: 400,
        code: 'HEALTHIANS_PROVIDER_REQUIRED',
        message: 'externalProviderId is required for Healthians consultation',
      });
    }

    const slotResponse = await this.getGenericSlots({
      externalProviderId: input.selectedProviderId,
      bookingDate: input.bookingDate,
    });
    const selectedTime = input.bookingTime || input.selectedSlotTime;
    if (!selectedTime) {
      throw new AppError({
        status: 400,
        code: 'HEALTHIANS_SLOT_TIME_REQUIRED',
        message: 'bookingTime or selectedSlotTime is required for Healthians consultation',
      });
    }
    const slot = this.pickSlot(selectedTime, slotResponse.slots);

    const payload: Record<string, unknown> = {
      customer_id: input.userUniqueId,
      customer_name: [input.firstName, input.lastName].filter(Boolean).join(' ').trim(),
      age: input.age ? Number(input.age) : undefined,
      dob: input.dateOfBirth,
      gender: this.toHealthiansGender(input.gender),
      contact_number: input.mobile,
      email: input.email,
      doctor_id: input.selectedProviderId,
      slot_id:
        this.getFirstString(slot.raw, ['slot_id', 'id','stm_id']) ||
        input.selectedSlotTime ||
        input.bookingTime,
    };
    Object.keys(payload).forEach((k) => {
      if (payload[k] === undefined || payload[k] === null || payload[k] === '') {
        delete payload[k];
      }
    });

    logger.info('[Healthians] sending consultation booking payload', {
      endpoint: 'bookConsultation',
      payload,
    });

    const raw = await this.post('bookConsultation', payload);
    this.assertSuccessfulHealthiansMutation(
      raw,
      'HEALTHIANS_BOOK_CONSULTATION_FAILED',
      'Healthians consultation booking failed'
    );
    const responseData = this.getNestedRecord(raw, ['data']);
    const bookingId =
      this.getFirstString(raw, ['booking_id', 'bookingId', 'id']) ||
      this.getFirstString(responseData || {}, ['booking_id', 'bookingId', 'consultation_id', 'id']);
    return {
      externalBookingId: bookingId,
      externalProviderId: input.selectedProviderId,
      externalSlotTime: slot.startTime24h,
      externalStatus: this.getFirstString(raw, ['status', 'booking_status']) || 'confirmed',
      payload: {
        bookingRequest: payload,
        bookingResponse: raw,
        // slotResponse: slotResponse.raw,
      },
    };
  }

  async getPartnerProducts(
    _input: PartnerProductsInput = {}
  ): Promise<{ products: Record<string, unknown>[]; raw: unknown }> {
    // const raw = await this.post('getPartnerProducts', {
    //   zipcode: input.pincode || '',
    //   lat: input.latitude,
    //   long: input.longitude,
    //   product_type: input.productType || 'profile',
    //   product_type_id: input.productTypeId || '',
    //   start: input.start || '0',
    //   limit: input.limit || '40',
    //   test_type: input.testType || 'pathology',
    //   client_id: input.clientId || '',
    // });
    const raw={};
    return {
      products: this.extractArray(raw, ['products', 'data']),
      raw,
    };
  }

  async getPartnerProductsTest(
    _input: PartnerProductsInput = {}
  ): Promise<{ products: Record<string, unknown>[]; raw: unknown }> {
    // const raw = await this.post('getPartnerProducts', {
    //   zipcode: input.pincode || '',
    //   lat: input.latitude,
    //   long: input.longitude,
    //   // product_type: input.productType || 'profile',
    //   product_type_id: input.productTypeId || '',
    //   start: input.start || '0',
    //   limit: input.limit || '40',
    //    test_type: input.testType || '',
    //   client_id: input.clientId || '',
    // });
    const raw={};
    return {
      products: this.extractArray(raw, ['products', 'data']),
      raw,
    };
  }

  async getPackages(input: {
    pincode?: string;
    latitude?: number;
    longitude?: number;
  } = {}): Promise<{ packages: Record<string, unknown>[]; raw: unknown }> {
    const packageResult = await this.getPartnerProducts({
      pincode: input.pincode,
      latitude: input.latitude,
      longitude: input.longitude,
      productType: 'package',
    });

    const profileResult = await this.getPartnerProducts({
      pincode: input.pincode,
      latitude: input.latitude,
      longitude: input.longitude,
      productType: 'profile',
    });

    const mergedProducts = [
      ...packageResult.products,
      ...profileResult.products,
    ];

    return {
      packages: mergedProducts
        .filter((item) =>
          ['package', 'profile'].includes(
            (this.getFirstString(item, ['deal_type', 'product_type']) || '').toLowerCase()
          )
        )
        .map((item) => this.withVisitSupportFromDistance(item)),
      raw: {
        packageResponse: packageResult.raw,
        profileResponse: profileResult.raw,
      },
    };
  }

  async getPackageById(
    packageId: string,
    input: {
      pincode?: string;
      latitude?: number;
      longitude?: number;
    } = {}
  ): Promise<{
    packageItem?: Record<string, unknown>;
    raw: unknown;
  }> {
    const raw = await this.post('getProductDetails', {
      deal_type: 'package',
      deal_type_id: this.normalizeProductDetailId(packageId),
      zipcode: input.pincode,
      lat: input.latitude,
      long: input.longitude,
    });
    const packageItem = this.extractDetailItem(raw, ['data', 'product_details', 'product']);
    return {
      packageItem: packageItem
        ? this.withVisitSupportFromDistance(packageItem)
        : (raw as Record<string, unknown>),
      raw,
    };
  }

  async getTests(input: {
    pincode?: string;
    latitude?: number;
    longitude?: number;
  } = {}): Promise<{ tests: Record<string, unknown>[]; raw: unknown }> {
    const result = await this.getPartnerProductsTest({
      pincode: input.pincode,
      latitude: input.latitude,
      longitude: input.longitude,
    });
    return {
      tests: result.products
        .filter((item) =>
          ['parameter', 'test', 'pathology','radiology'].includes(
            (this.getFirstString(item, ['deal_type', 'product_type']) || '').toLowerCase()
          )
        )
        .map((item) => this.withVisitSupportFromDistance(item)),
      raw: result.raw,
    };
  }

  async getPackagePriceById(
    packageId: string,
    input: {
      pincode?: string;
      latitude?: number;
      longitude?: number;
    } = {}
  ): Promise<number | undefined> {
    const normalizedId = this.normalizeProductLookupId(packageId);
    const [packageResult, profileResult] = await Promise.all([
      this.getPartnerProducts({
        pincode: input.pincode,
        latitude: input.latitude,
        longitude: input.longitude,
        productType: 'package',
        productTypeId: normalizedId,
      }),
      this.getPartnerProducts({
        pincode: input.pincode,
        latitude: input.latitude,
        longitude: input.longitude,
        productType: 'profile',
        productTypeId: normalizedId,
      }),
    ]);
    // console.log(packageResult, profileResult);
    const matched =
      this.findProductById(packageResult.products, packageId) ||
      this.findProductById(profileResult.products, packageId) ||
      packageResult.products[0] ||
      profileResult.products[0];

    return matched
      ? this.getFirstNumber(matched, [
          'price',
          'offerPrice',
          'discountedPrice',
          'mrp',
          'amount',
        ])
      : undefined;
  }

  async getTestPriceById(
    testId: string,
    input: {
      pincode?: string;
      latitude?: number;
      longitude?: number;
    } = {}
  ): Promise<number | undefined> {
    const normalizedId = this.normalizeProductLookupId(testId);
    const result = await this.getPartnerProductsTest({
      pincode: input.pincode,
      latitude: input.latitude,
      longitude: input.longitude,
      productTypeId: normalizedId,
    });

    const matched =
      this.findProductById(result.products, testId) || result.products[0];

    return matched
      ? this.getFirstNumber(matched, [
          'price',
          'minMrp',
          'offerPrice',
          'discountedPrice',
          'mrp',
          'amount',
        ])
      : undefined;
  }

  async getTestById(
    testId: string,
    input: {
      pincode?: string;
      latitude?: number;
      longitude?: number;
    } = {}
  ): Promise<{ testItem?: Record<string, unknown>; raw: unknown }> {
    const raw = await this.post('getProductDetails', {
      deal_type: 'parameter',
      deal_type_id: this.normalizeProductDetailId(testId),
      zipcode: input.pincode,
      lat: input.latitude,
      long: input.longitude,
    });
    const testItem = this.extractDetailItem(raw, ['data', 'product_details', 'product']);
    return {
      testItem: testItem
        ? this.withVisitSupportFromDistance(testItem)
        : (raw as Record<string, unknown>),
      raw,
    };
  }

  async checkServiceability(input: {
    pincode?: string;
    latitude?: number;
    longitude?: number;
  }): Promise<Record<string, unknown>> {
    const raw = await this.post('checkServiceabilityByLocation_v2', {
      lat: input.latitude,
      long: input.longitude,
      zipcode: input.pincode,
      is_ppmc_booking: 0,
    });
    logger.info('[Healthians] checkServiceability response', {
      pincode: input.pincode,
      latitude: input.latitude,
      longitude: input.longitude,
      responseData: raw,
    });
    return raw;
  }

  async getLabs(input: {
    pincode?: string;
    latitude?: number;
    longitude?: number;
  }): Promise<{ labs: Record<string, unknown>[]; raw: unknown }> {
    const raw = await this.checkServiceability(input);
    const zones = this.extractArray(raw, ['zones', 'zone', 'data']);
    return {
      labs: zones.length ? zones : [raw],
      raw,
    };
  }

  async getDiagnosticsSlots(input: {
    bookingDate: string;
    pincode?: string;
    latitude?: number;
    longitude?: number;
    packageIds?: string[];
    testIds?: string[];
  }): Promise<{ slots: HealthiansSlot[]; raw: unknown }> {
    const serviceabilityRaw = await this.checkServiceability({
      pincode: input.pincode,
      latitude: input.latitude,
      longitude: input.longitude,
    });

    const serviceabilityData =
      serviceabilityRaw &&
      typeof serviceabilityRaw === 'object' &&
      !Array.isArray(serviceabilityRaw) &&
      (serviceabilityRaw as Record<string, unknown>).data &&
      typeof (serviceabilityRaw as Record<string, unknown>).data === 'object' &&
      !Array.isArray((serviceabilityRaw as Record<string, unknown>).data)
        ? ((serviceabilityRaw as Record<string, unknown>).data as Record<string, unknown>)
        : undefined;

    const zoneId = this.getFirstString(serviceabilityData || {}, [
      'zone_id',
      'lab_id',
      'id',
    ]);

    if (!zoneId) {
      return {
        slots: [],
        raw: {
          status: 'success',
          message: 'Slot is not available.',
          slots: [],
          serviceability: serviceabilityRaw,
        },
      };
    }
    const packageIds =
  input.packageIds && input.packageIds.length
    ? input.packageIds
    : input.testIds;
    const payload: Record<string, unknown> = {
      slot_date: this.toIsoDate(input.bookingDate),
      lat: input.latitude,
      long: input.longitude,
      zipcode: input.pincode,
      zone_id: zoneId,
      get_ppmc_slots: 0,
      has_female_patient: 0,
      amount: 0,
      package:
        packageIds && packageIds.length
          ? [{ deal_id: packageIds }]
          : undefined,
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

    const raw = await this.post('getSlotsByLocation', payload);
    const slots = this.extractArray(raw, ['slots', 'data', 'slot_list']).map((slot) =>
      this.mapDiagnosticsSlot(slot, input.bookingDate)
    );
    return {
      slots: slots.filter(Boolean) as HealthiansSlot[],
      raw: {
        ...(raw as Record<string, unknown>),
        selectedZoneId: zoneId,
      },
    };
  }

  async freezeDiagnosticsSlot(input: {
    stmId: string;
    vendorBillingUserId: string;
  }): Promise<Record<string, unknown>> {
    const vendorBillingUserId = input.vendorBillingUserId?.trim();

    if (!vendorBillingUserId) {
      throw new AppError({
        status: 400,
        code: 'HEALTHIANS_VENDOR_BILLING_USER_ID_MISSING',
        message: 'Healthians vendor billing user id is missing',
      });
    }

    return this.post('freezeSlot_v1', {
      slot_id: input.stmId,
      vendor_billing_user_id: vendorBillingUserId,
    });
  }

  private async getZoneIdFromServiceability(input: {
    pincode?: string;
    latitude?: number;
    longitude?: number;
  }): Promise<string | undefined> {
    if (input.latitude === undefined || input.longitude === undefined || !input.pincode) {
      return undefined;
    }

    const raw = await this.checkServiceability(input);
    console.log('Serviceability response for zone id resolution', raw);
    const data = this.getNestedRecord(raw, ['data']);
    const zoneId = this.getFirstString(data || {}, ['zone_id', 'zoneId', 'lab_id', 'id']);

    // logger.info('[Healthians] zone_id resolved from serviceability', {
    //   pincode: input.pincode,
    //   latitude: input.latitude,
    //   longitude: input.longitude,
    //   zoneId,
    //   responseData: raw,
    // });

    return zoneId;
  }

  async placeDiagnosticsOrder(input: {
    orderType: string;
    appointment: string;
    name: string;
    mobile?: string;
    email?: string;
    gender?: string;
    age?: string;
    dateOfBirth?: string;
    customerRelation?: string;
    pincode?: string;
    city?: string;
    state?: string;
    stateId?: number;
    cityId?: number;
    zoneId?: number | string;
    latitude?: number;
    longitude?: number;
    slotId?: string;
    billingUserId?: string;
    address?: string;
    subLocality?: string;
    landmark?: string;
    packageIds?: string[];
    testIds?: string[];
    uniqueId: string;
    notes?: string;
    altContact?: string;
    altEmail?: string;
    hardCopy?: number;
    vendorBookingId?: string;
    discountedPrice?: number;
    paymentOption?: 'cod' | 'prepaid';
    applicationNumber?: string;
    customerRemarks?: string;
    isPpmcBooking?: number;
  }): Promise<{
    externalBookingId?: string;
    externalStatus?: string;
    payload: Record<string, unknown>;
  }> {
    const normalizedGender = this.toHealthiansGender(input.gender);
    const relation = this.toHealthiansRelation(input.customerRelation);
    const slotId = input.slotId ? String(input.slotId).trim() : undefined;
    const zoneId =
      input.zoneId ??
      (await this.getZoneIdFromServiceability({
        pincode: input.pincode,
        latitude: input.latitude,
        longitude: input.longitude,
      }));
    const customerId =
      input.billingUserId?.trim() || input.uniqueId || input.mobile || 'customer';
    const payload: Record<string, unknown> = {
      customer: [
        {
          customer_id: customerId,
          customer_name: input.name,
          relation,
          age: input.age ? Number(input.age) : undefined,
          dob: this.toHealthiansDob(input.dateOfBirth),
          gender: normalizedGender,
          contact_number: input.mobile,
          email: input.email,
          application_number: input.applicationNumber,
          customer_remarks: input.customerRemarks || input.notes,
        },
      ],
      slot: slotId
        ? {
            slot_id: slotId,
          }
        : undefined,
      customer_calling_number: input.mobile,
      billing_cust_name: input.name,
      gender: normalizedGender,
      mobile: input.mobile,
      email: input.email,
      sub_locality: input.subLocality,
      latitude:
        input.latitude !== undefined ? String(input.latitude) : undefined,
      longitude:
        input.longitude !== undefined ? String(input.longitude) : undefined,
      zipcode: input.pincode,
      landmark: input.landmark,
      altmobile: input.altContact,
      altemail: input.altEmail,
      hard_copy: input.hardCopy ?? 0,
      vendor_booking_id: input.vendorBookingId,
      vendor_billing_user_id: input.billingUserId,
      payment_option:  'prepaid',
      discounted_price:
        input.discountedPrice !== undefined
          ? Math.round(input.discountedPrice)
          : 0,
      zone_id: zoneId,
      is_ppmc_booking: input.isPpmcBooking ?? 0,
      address: input.address,
      City: input.city,
      remarks: input.notes,
      package: [
        {
          deal_id: [...(input.packageIds || []), ...(input.testIds || [])],
        },
      ],
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

    logger.info('[Healthians] sending diagnostics booking payload', {
      endpoint: 'createBooking_v3',
      payload,
    });

    const raw = await this.post('createBooking_v3', payload);
    this.assertSuccessfulHealthiansMutation(
      raw,
      'HEALTHIANS_CREATE_BOOKING_FAILED',
      'Healthians diagnostics booking failed',
      {
        endpoint: 'createBooking_v3',
        pincode: input.pincode,
        latitude: input.latitude,
        longitude: input.longitude,
        bookingDate: input.appointment,
        slotId,
        billingUserId: input.billingUserId,
      }
    );
    const responseData = this.getNestedRecord(raw, ['data']);
    return {
      externalBookingId:
        this.getFirstString(raw, ['booking_id', 'bookingId', 'id']) ||
        this.getFirstString(responseData || {}, ['booking_id', 'bookingId', 'id']),
      externalStatus: this.getFirstString(raw, ['status', 'booking_status']) || 'booked',
      payload: {
        bookingRequest: payload,
        bookingResponse: raw,
      },
    };
  }

  async getBookingStatus(input: { bookingId: string }): Promise<Record<string, unknown>> {
    return this.post('getBookingStatus', { booking_id: input.bookingId });
  }

  async cancelBooking(input: {
    bookingId: string;
    vendorBillingUserId?: string;
    reason?: string;
    uniqueId?: string;
  }): Promise<{ externalBookingId?: string; externalStatus?: string; payload: Record<string, unknown> }> {
    const raw = await this.post('cancelBooking', {
      booking_id: input.bookingId,
      vendor_billing_user_id: input.vendorBillingUserId,
      vendor_customer_id: input.uniqueId,
      remarks: input.reason,
    });
    this.assertSuccessfulHealthiansMutation(
      raw,
      'HEALTHIANS_CANCEL_BOOKING_FAILED',
      'Healthians booking cancellation failed'
    );
    return {
      externalBookingId: input.bookingId,
      externalStatus: this.getFirstString(raw, ['status', 'booking_status']) || 'cancelled',
      payload: raw,
    };
  }

  async rescheduleBooking(input: {
    bookingId: string;
    slotId: string;
    uniqueId?: string;
    reason?: string;
  }): Promise<{ externalBookingId?: string; externalStatus?: string; payload: Record<string, unknown> }> {
    const raw = await this.post('rescheduleBookingByCustomer_v1', {
      booking_id: input.bookingId,
      slot: { slot_id: input.slotId },
      customers: input.uniqueId ? [{ vendor_customer_id: input.uniqueId }] : undefined,
      reschedule_reason: input.reason,
    });
    this.assertSuccessfulHealthiansMutation(
      raw,
      'HEALTHIANS_RESCHEDULE_BOOKING_FAILED',
      'Healthians booking reschedule failed'
    );
    const responseData = this.getNestedRecord(raw, ['data']);
    return {
      externalBookingId:
        this.getFirstString(raw, ['new_booking_id', 'booking_id', 'bookingId', 'id']) ||
        this.getFirstString(responseData || {}, ['new_booking_id', 'booking_id', 'bookingId', 'id']) ||
        input.bookingId,
      externalStatus: this.getFirstString(raw, ['status', 'booking_status']) || 'rescheduled',
      payload: raw,
    };
  }

  async getCustomerReport(input: {
    bookingId: string;
    vendorBillingUserId?: string;
    uniqueId?: string;
    allowPartialReport?: 0 | 1;
  }): Promise<Record<string, unknown>> {
    return this.post('getCustomerReport_v2', {
      booking_id: input.bookingId,
      vendor_billing_user_id: input.vendorBillingUserId,
      vendor_customer_id: input.uniqueId,
      allow_partial_report: input.allowPartialReport ?? 1,
    });
  }

  async downloadSignedReport(url: string): Promise<Buffer> {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 20000,
      });
      return Buffer.from(response.data);
    } catch (error) {
      this.handleAxiosError(error, 'HEALTHIANS_REPORT_DOWNLOAD_FAILED');
    }
  }

  private mapDoctorSlot(
    value: Record<string, unknown>,
    externalProviderId: string,
    bookingDate: string
  ): HealthiansSlot | null {
    const start =
      this.getFirstString(value, ['start_time', 'slot_time', 'time', 'start']) ||
      this.getFirstString(value, ['display_time']);
    if (!start) return null;
    const start24 = this.to24h(start);
    const end = this.getFirstString(value, ['end_time', 'end']);
    return {
      externalProviderId,
      date: bookingDate,
      startTime24h: start24,
      endTime24h: end ? this.to24h(end) : undefined,
      startTimeDisplay: this.toAmPm(start24),
      endTimeDisplay: end ? this.toAmPm(this.to24h(end)) : undefined,
      raw: value,
    };
  }

  private mapDiagnosticsSlot(
    value: Record<string, unknown>,
    bookingDate: string
  ): HealthiansSlot | null {
    const start =
      this.getFirstString(value, ['start_time', 'slot_time', 'time', 'start']) ||
      this.getFirstString(value, ['display_time']);
    if (!start) return null;
    const start24 = this.to24h(start);
    const end = this.getFirstString(value, ['end_time', 'end']);
    const providerId = this.getFirstString(value, ['zone_id', 'lab_id', 'id']) || 'healthians';
    return {
      externalProviderId: providerId,
      date: bookingDate,
      startTime24h: start24,
      endTime24h: end ? this.to24h(end) : undefined,
      startTimeDisplay: this.toAmPm(start24),
      endTimeDisplay: end ? this.toAmPm(this.to24h(end)) : undefined,
      raw: value,
    };
  }

  private extractArray(
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
    const data = source.data;
    if (Array.isArray(data)) {
      return data.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && !Array.isArray(item)
      );
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const nested = data as Record<string, unknown>;
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

  private extractDetailItem(
    responseData: unknown,
    keys: string[]
  ): Record<string, unknown> | undefined {
    const items = this.extractArray(responseData, keys);
    if (items.length) {
      return items[0];
    }

    if (!responseData || typeof responseData !== 'object' || Array.isArray(responseData)) {
      return undefined;
    }

    const source = responseData as Record<string, unknown>;
    for (const key of keys) {
      const value = source[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    }

    const data = source.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const nested = data as Record<string, unknown>;
      for (const key of keys) {
        const value = nested[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return value as Record<string, unknown>;
        }
      }
      return nested;
    }

    return undefined;
  }

  private withVisitSupport(
    item: Record<string, unknown>,
    isCenterVisitSupported: boolean,
    isHomeSampleSupported: boolean
  ): Record<string, unknown> {
    return {
      ...item,
      isCenterVisitSupported,
      isHomeSampleSupported,
    };
  }

  private hasDistance(item: Record<string, unknown>): boolean {
    return item.distance !== undefined && item.distance !== null && item.distance !== '';
  }

  private withVisitSupportFromDistance(
    item: Record<string, unknown>
  ): Record<string, unknown> {
    const hasDistance = this.hasDistance(item);
    return this.withVisitSupport(item, hasDistance, !hasDistance);
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

  private getFirstNumber(
    source: Record<string, unknown>,
    keys: string[]
  ): number | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'number' && !Number.isNaN(value)) {
        return value;
      }
      if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }
      }
    }
    return undefined;
  }

  private findProductById(
    products: Record<string, unknown>[],
    requestedId: string
  ): Record<string, unknown> | undefined {
    const normalizedRequestedId = this.normalizeProductLookupId(requestedId);

    return products.find((product) => {
      const dealId = this.getFirstString(product, ['deal_id']);
      const productTypeId = this.getFirstString(product, [
        'product_type_id',
        'deal_type_id',
        'id',
      ]);

      return (
        (dealId && dealId === requestedId) ||
        (productTypeId && productTypeId === normalizedRequestedId)
      );
    });
  }

  private normalizeProductLookupId(value: string): string {
    const normalized = String(value || '').trim();
    if (!normalized) {
      return normalized;
    }

    const directNumber = Number(normalized);
    if (!Number.isNaN(directNumber) && Number.isFinite(directNumber)) {
      return String(directNumber);
    }

    const matched = normalized.match(/(\d+)\s*$/);
    return matched ? matched[1] : normalized;
  }

  private getNestedRecord(
    source: Record<string, unknown>,
    keys: string[]
  ): Record<string, unknown> | undefined {
    for (const key of keys) {
      const value = source[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    }
    return undefined;
  }

  private isHealthiansSuccessStatus(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return value !== 0;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (!normalized) {
        return undefined;
      }
      if (['true', 'success', 'successful', 'confirmed', 'booked', 'rescheduled', 'cancelled'].includes(normalized)) {
        return true;
      }
      if (['false', 'failure', 'failed', 'error'].includes(normalized)) {
        return false;
      }
    }
    return undefined;
  }

  private assertSuccessfulHealthiansMutation(
    raw: HealthiansApiResponse,
    code: string,
    fallbackMessage: string,
    context: Record<string, unknown> = {}
  ): void {
    const responseData = this.getNestedRecord(raw, ['data']);
    const status =
      this.isHealthiansSuccessStatus(raw.status) ??
      this.isHealthiansSuccessStatus(responseData?.status);
    const success =
      this.isHealthiansSuccessStatus(raw.success) ??
      this.isHealthiansSuccessStatus(responseData?.success);
    const resCode =
      this.getFirstString(raw, ['resCode']) ||
      this.getFirstString(responseData || {}, ['resCode']);

    const isFailure =
      status === false ||
      success === false ||
      (resCode !== undefined && resCode !== 'RES0001');

    if (!isFailure) {
      return;
    }

    const message =
      this.getFirstString(raw, ['message', 'error']) ||
      this.getFirstString(responseData || {}, ['message', 'error']) ||
      fallbackMessage;

    logger.error('[Healthians] mutation failed', {
      ...context,
      code,
      message,
      responseData: raw,
    });

    throw new AppError({
      status: 502,
      code,
      message: `Healthians error: ${message}`,
    });
  }

  private getLocationLogFields(
    source: Record<string, unknown>
  ): {
    hasLocation: boolean;
    pincode?: unknown;
    latitude?: unknown;
    longitude?: unknown;
  } {
    const pincode = source.zipcode ?? source.pincode;
    const latitude = source.lat ?? source.latitude;
    const longitude = source.long ?? source.longitude;

    return {
      hasLocation:
        pincode !== undefined || latitude !== undefined || longitude !== undefined,
      pincode,
      latitude,
      longitude,
    };
  }

  private toHealthiansGender(
    value?: string
  ): 'M' | 'F' | undefined {
    const normalized = (value || '').trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    if (['m', 'male'].includes(normalized)) {
      return 'M';
    }
    if (['f', 'female'].includes(normalized)) {
      return 'F';
    }
    return undefined;
  }

  private toHealthiansRelation(value?: string): string {
    const normalized = (value || '').trim().toLowerCase();
    switch (normalized) {
      case '':
      case 'self':
      case 'me':
        return 'Self';
      case 'spouse':
      case 'wife':
      case 'husband':
        return 'Spouse';
      case 'son':
      case 'daughter':
      case 'child':
        return 'Child';
      case 'father':
      case 'mother':
      case 'parent':
        return 'Parent';
      case 'grandfather':
      case 'grandmother':
      case 'grand parent':
      case 'grandparent':
        return 'Grand parent';
      case 'brother':
      case 'sister':
      case 'sibling':
        return 'Sibling';
      case 'friend':
        return 'friend';
      case 'relative':
        return 'Relative';
      case 'neighbour':
      case 'neighbor':
        return 'Neighbour';
      case 'colleague':
        return 'Colleague';
      case 'father in law':
        return 'Father in law';
      case 'mother in law':
        return 'Mother in law';
      default:
        return 'Others';
    }
  }

  private toHealthiansDob(value?: string): string | undefined {
    const normalized = (value || '').trim();
    if (!/^\d{8}$/.test(normalized)) {
      return undefined;
    }
    const year = normalized.slice(0, 4);
    const month = normalized.slice(4, 6);
    const day = normalized.slice(6, 8);
    return `${day}/${month}/${year}`;
  }

  private normalizeProductDetailId(value: string): number | string {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
      return value;
    }

    const direct = Number(trimmed);
    if (!Number.isNaN(direct) && Number.isFinite(direct)) {
      return direct;
    }

    const matched = trimmed.match(/(\d+)\s*$/);
    if (matched) {
      const parsed = Number(matched[1]);
      if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return trimmed;
  }

  private pickSlot(selected: string, slots: HealthiansSlot[]): HealthiansSlot {
    const target = this.to24h(selected);
    const matched = slots.find((slot) => slot.startTime24h === target);
    if (matched) return matched;
    if (slots.length) return slots[0];
    throw new AppError({
      status: 400,
      code: 'HEALTHIANS_SLOT_NOT_FOUND',
      message: 'No Healthians slot available',
    });
  }

  private toIsoDate(yyyymmdd: string): string {
    if (!/^\d{8}$/.test(yyyymmdd)) {
      return yyyymmdd;
    }
    return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  }

  private to24h(value: string): string {
    const normalized = value.trim().toLowerCase().replace(/\s+/g, '');
    const hhmm = /^(\d{1,2}):(\d{2})$/.exec(normalized);
    if (hhmm) {
      const h = Math.max(0, Math.min(23, Number(hhmm[1])));
      const m = Math.max(0, Math.min(59, Number(hhmm[2])));
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    const ampm = /^(\d{1,2}):(\d{2})(am|pm)$/.exec(normalized);
    if (ampm) {
      let h = Number(ampm[1]);
      const m = Math.max(0, Math.min(59, Number(ampm[2])));
      if (ampm[3] === 'pm' && h !== 12) h += 12;
      if (ampm[3] === 'am' && h === 12) h = 0;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    return value;
  }

  private toAmPm(hhmm24: string): string {
    const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm24.trim());
    if (!match) return hhmm24;
    let h = Number(match[1]);
    const m = match[2];
    const ampm = h >= 12 ? 'PM' : 'AM';
    h %= 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${ampm}`;
  }

  private handleAxiosError(
    error: unknown,
    code: string,
    context: Record<string, unknown> = {}
  ): never {
    const axiosError = error as AxiosError;
    const status = axiosError.response?.status || 500;
    const data = axiosError.response?.data;
    logger.error('[Healthians] request failed', {
      ...context,
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
          ? `Healthians error: ${messageFromBody}`
          : axiosError.message || 'Healthians request failed',
    });
  }
}
