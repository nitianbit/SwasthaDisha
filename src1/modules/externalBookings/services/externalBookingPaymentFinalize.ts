import { LabstackService } from '@/modules/bookings/services/labstack';
import { HealthiansService } from '@/modules/bookings/services/healthians';
import { ExternalBookingRepository } from '@/modules/externalBookings/repository';
import { IExternalBooking } from '@/modules/externalBookings/types';
import { AppError } from '@/modules/common/types';
import { IPaymentRecord } from '@/modules/payment/types';
import { toDiagnosticsAppointmentIso } from '@/modules/externalBookings/services/diagnosticsPricing';
import logger from '@/services/logger';

function splitPatientName(name: string): { firstName: string; lastName?: string } {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { firstName: 'Patient' };
  }
  if (parts.length === 1) {
    return { firstName: parts[0] };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

function buildLabstackUniqueId(input: {
  name?: string;
  mobile?: string;
  email?: string;
  userId?: string;
}): string {
  const mobile = input.mobile?.trim();
  const name = input.name?.trim().replace(/\s+/g, '-');

  if (mobile && name) {
    return `${mobile}-${name}`;
  }

  if (mobile) {
    return mobile;
  }

  if (input.email?.trim()) {
    return input.email.trim();
  }

  return input.userId ? `usr-${input.userId}` : 'usr-anonymous';
}

function distinctAddressPart(
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

function normalizeLabstackAddressFields(input: {
  unitFloorBuilding?: string;
  locality?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  requireMinimumLength?: boolean;
}): {
  unitFloorBuilding?: string;
  locality?: string;
  address?: string;
} {
  const address = buildProviderAddress([
    input.unitFloorBuilding,
    input.address,
    input.locality,
    input.city,
    input.state,
    input.pincode,
  ]);

  if (input.requireMinimumLength !== false && address && address.length < 25) {
    throw new AppError({
      status: 400,
      code: 'LABSTACK_ADDRESS_TOO_SHORT',
      message:
        'Full address is too short for diagnostics booking. Include unit/building, address, locality, city, and state.',
    });
  }

  const unitFloorBuilding = distinctAddressPart(input.unitFloorBuilding, [
    address,
    input.locality,
  ]);
  const locality = distinctAddressPart(input.locality, [
    address,
    input.unitFloorBuilding,
  ]);

  return {
    unitFloorBuilding,
    locality,
    address: limitProviderAddress(address),
  };
}

function buildProviderAddress(parts: Array<string | undefined>): string | undefined {
  const uniqueParts: string[] = [];

  for (const part of parts) {
    const normalized = part?.trim();
    if (!normalized) {
      continue;
    }

    const lowered = normalized.toLowerCase();
    if (uniqueParts.some((item) => item.toLowerCase() === lowered)) {
      continue;
    }

    uniqueParts.push(normalized);
  }

  if (uniqueParts.length === 0) {
    return undefined;
  }

  return uniqueParts.join(', ');
}

function limitProviderAddress(
  value?: string,
  maxLength = 200
): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function getFirstString(
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

function getFirstNumber(
  source: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function extractLabstackLabLocationMeta(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const bookingResponse =
    payload.bookingResponse &&
    typeof payload.bookingResponse === 'object' &&
    !Array.isArray(payload.bookingResponse)
      ? (payload.bookingResponse as Record<string, unknown>)
      : undefined;
  const bookingOrder =
    bookingResponse?.order &&
    typeof bookingResponse.order === 'object' &&
    !Array.isArray(bookingResponse.order)
      ? (bookingResponse.order as Record<string, unknown>)
      : undefined;

  const labAddress =
    (bookingOrder ? getFirstString(bookingOrder, ['labAddress']) : undefined) ||
    (bookingResponse ? getFirstString(bookingResponse, ['labAddress']) : undefined);
  const labLat =
    (bookingOrder ? getFirstNumber(bookingOrder, ['labLatitude', 'labLat']) : undefined) ??
    (bookingResponse
      ? getFirstNumber(bookingResponse, ['labLatitude', 'labLat'])
      : undefined);
  const labLong =
    (bookingOrder
      ? getFirstNumber(bookingOrder, ['labLongitude', 'labLong'])
      : undefined) ??
    (bookingResponse
      ? getFirstNumber(bookingResponse, ['labLongitude', 'labLong'])
      : undefined);

  return {
    ...(labAddress ? { labAddress } : {}),
    ...(labLat !== undefined ? { labLat } : {}),
    ...(labLong !== undefined ? { labLong } : {}),
  };
}

/** base - discount of the accepted payment attempt, in exact paise (includes the wallet-paid portion). */
function acceptedTotal(record: IPaymentRecord): number {
  const base = Math.round(Number(record.baseAmount ?? 0) * 100);
  const discount = Math.round(Number(record.discountAmount ?? 0) * 100);
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(discount) || base < 0 || discount < 0 || discount > base) {
    throw new AppError({ status: 409, code: 'EXTERNAL_BOOKING_RECONCILIATION_REQUIRED', message: 'Payment amounts are inconsistent' });
  }
  return (base - discount) / 100;
}

export async function completeExternalBookingAfterPayment(
  paymentRecord: IPaymentRecord,
  externalBookingRepository: ExternalBookingRepository,
  labstackService: LabstackService,
  healthiansService: HealthiansService
): Promise<IExternalBooking> {
  logger.info('[ExternalBooking][finalize] start', {
    paymentTransactionId: paymentRecord._id,
    bookingId: paymentRecord.contextId,
    paymentStatus: paymentRecord.status,
    isProcessed: paymentRecord.isProcessed,
  });
  const booking = await externalBookingRepository.findById(paymentRecord.contextId);

  if (!booking || booking.userId !== paymentRecord.userId) {
    throw new AppError({
      status: 404,
      code: 'EXTERNAL_BOOKING_NOT_FOUND',
      message: 'External booking not found for this payment',
    });
  }

  const typed = booking as IExternalBooking;

  if (typed.paymentStatus === 'paid' && typed.externalBookingId) {
    logger.info('[ExternalBooking][finalize] already fulfilled', {
      bookingId: typed._id,
      paymentTransactionId: paymentRecord._id,
      externalBookingId: typed.externalBookingId,
    });
    return typed;
  }

  try {
    if (typed.providerType === 'DIAGNOSTICS') {
      return await completeDiagnosticsAfterPayment(
        typed,
        paymentRecord,
        externalBookingRepository,
        labstackService,
        healthiansService
      );
    }

    return await completeConsultationAfterPayment(
      typed,
      paymentRecord,
      externalBookingRepository,
      labstackService,
      healthiansService
    );
  } catch (error) {
    const meta =
      typed.meta && typeof typed.meta === 'object' && !Array.isArray(typed.meta)
        ? (typed.meta as Record<string, unknown>)
        : {};

    logger.error('[ExternalBooking][finalize] final booking failed', {
      bookingId: typed._id,
      paymentTransactionId: paymentRecord._id,
      integration: typed.integration,
      providerType: typed.providerType,
      externalProviderId: typed.externalProviderId,
      bookingDate: typed.bookingDate,
      bookingTime: typed.bookingTime,
      pincode: meta.pincode,
      latitude: meta.latitude,
      longitude: meta.longitude,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function completeConsultationAfterPayment(
  booking: IExternalBooking,
  paymentRecord: IPaymentRecord,
  externalBookingRepository: ExternalBookingRepository,
  labstackService: LabstackService,
  healthiansService: HealthiansService
): Promise<IExternalBooking> {
  logger.info('[ExternalBooking][finalize][doctor] create start', {
    bookingId: booking._id,
    paymentTransactionId: paymentRecord._id,
    integration: booking.integration,
    providerId: booking.externalProviderId,
    bookingDate: booking.bookingDate,
    bookingTime: booking.bookingTime,
  });
  const effectiveSlotTime = booking.bookingTime;
  const meta = {
    ...(typeof booking.meta === 'object' &&
    booking.meta &&
    !Array.isArray(booking.meta)
      ? (booking.meta as Record<string, unknown>)
      : {}),
  };
  const splitName = splitPatientName(booking.patientName);
  const uniqueId = buildLabstackUniqueId({
    name: booking.patientName,
    mobile: booking.patientPhone,
    email: booking.patientEmail,
    userId: booking.userId,
  });

  const consultationMode = meta.consultationMode as
    | 'chat'
    | 'call'
    | 'in-person'
    | undefined;

  const result =
    booking.integration === 'healthians'
      ? await healthiansService.createConsultationBooking({
          bookingDate: booking.bookingDate,
          bookingTime: effectiveSlotTime,
          userUniqueId: uniqueId,
          firstName: splitName.firstName,
          lastName: splitName.lastName,
          email: booking.patientEmail,
          mobile: booking.patientPhone,
          gender: meta.patientGender as string | undefined,
          age: meta.patientAge as string | undefined,
          dateOfBirth: meta.patientDateOfBirth as string | undefined,
          selectedProviderId: booking.externalProviderId,
          selectedSlotTime: effectiveSlotTime,
        })
      : await labstackService.createConsultationBooking({
          bookingDate: booking.bookingDate,
          bookingTime: effectiveSlotTime,
          consultationMode: consultationMode || 'chat',
          userUniqueId: uniqueId,
          referenceId: String(booking._id),
          firstName: splitName.firstName,
          lastName: splitName.lastName,
          email: booking.patientEmail,
          mobile: booking.patientPhone,
          gender: meta.patientGender as string | undefined,
          age: meta.patientAge as string | undefined,
          dateOfBirth: meta.patientDateOfBirth as string | undefined,
          primaryConcern: meta.primaryConcern as string | undefined,
          selectedProviderId: booking.externalProviderId,
          selectedSlotTime: effectiveSlotTime,
          pincode: meta.pincode as string | undefined,
          city: meta.city as string | undefined,
          state: meta.state as string | undefined,
          addressLine: meta.addressLine as string | undefined,
          address: booking.address,
        });

  const { pendingLabstack: _drop, ...metaRest } = meta;

  const updated = await externalBookingRepository.update(
    { _id: booking._id },
    {
      externalProviderId: result.externalProviderId || booking.externalProviderId,
      externalBookingId: result.externalBookingId,
      externalSlotRef: result.externalSlotTime,
      meetingLink: result.meetingLink,
      status: result.externalStatus,
      paymentStatus: 'paid',
      paymentTransactionId: paymentRecord._id!,
      meta: {
        ...metaRest,
        externalPayload: result.payload,
      },
    }
  );

  if (!updated) {
    throw new AppError({
      status: 500,
      code: 'EXTERNAL_BOOKING_UPDATE_FAILED',
      message: 'Failed to update external booking after payment',
    });
  }

  logger.info('[ExternalBooking][finalize][doctor] create success', {
    bookingId: booking._id,
    paymentTransactionId: paymentRecord._id,
    integration: booking.integration,
    externalBookingId: result.externalBookingId,
    externalStatus: result.externalStatus,
  });

  return updated as IExternalBooking;
}

async function completeDiagnosticsAfterPayment(
  booking: IExternalBooking,
  paymentRecord: IPaymentRecord,
  externalBookingRepository: ExternalBookingRepository,
  labstackService: LabstackService,
  healthiansService: HealthiansService
): Promise<IExternalBooking> {
  logger.info('[ExternalBooking][finalize][diagnostics] place start', {
    bookingId: booking._id,
    paymentTransactionId: paymentRecord._id,
    integration: booking.integration,
    providerId: booking.externalProviderId,
    bookingDate: booking.bookingDate,
    bookingTime: booking.bookingTime,
  });
  const meta = {
    ...(typeof booking.meta === 'object' &&
    booking.meta &&
    !Array.isArray(booking.meta)
      ? (booking.meta as Record<string, unknown>)
      : {}),
  };

  const uniqueId = buildLabstackUniqueId({
    name: booking.patientName,
    mobile: booking.patientPhone,
    email: booking.patientEmail,
    userId: booking.userId,
  });

  const appointment = toDiagnosticsAppointmentIso(
    booking.bookingDate,
    booking.bookingTime
  );
  const addressFields = normalizeLabstackAddressFields({
    unitFloorBuilding: meta.addressLine as string | undefined,
    locality: meta.locality as string | undefined,
    address: booking.address ?? (meta.addressLine as string | undefined),
    city: meta.city as string | undefined,
    state: meta.state as string | undefined,
    pincode: meta.pincode as string | undefined,
  });

  const packageIds = Array.isArray(meta.packageIds)
    ? (meta.packageIds as unknown[]).map((x) => String(x))
    : undefined;
  const testIds = Array.isArray(meta.testIds)
    ? (meta.testIds as unknown[]).map((x) => String(x))
    : undefined;

  // Milestone D8: freeze the Healthians slot at fulfilment, right before the order is placed.
  if (booking.integration === 'healthians' && typeof meta.stmId === 'string' && meta.stmId.trim()) {
    await healthiansService.freezeDiagnosticsSlot({ stmId: meta.stmId.trim(), vendorBillingUserId: booking.userId });
  }

  const result =
    booking.integration === 'healthians'
      ? await healthiansService.placeDiagnosticsOrder({
          orderType: booking.appointmentType,
          appointment,
          name: booking.patientName,
          mobile: booking.patientPhone,
          email: booking.patientEmail,
          gender: meta.patientGender as string | undefined,
          age: meta.patientAge as string | undefined,
          dateOfBirth: meta.patientDateOfBirth as string | undefined,
          customerRelation: meta.customerRelation as string | undefined,
          pincode: meta.pincode as string | undefined,
          city: meta.city as string | undefined,
          state: meta.state as string | undefined,
          stateId: meta.stateId as number | undefined,
          cityId: meta.cityId as number | undefined,
          zoneId: meta.zoneId as number | undefined,
          latitude: meta.latitude as number | undefined,
          longitude: meta.longitude as number | undefined,
          slotId:
            (meta.stmId as string | undefined) || booking.externalSlotRef,
          billingUserId: booking.userId,
          address: addressFields.address,
          subLocality:
            addressFields.locality ||
            addressFields.unitFloorBuilding ||
            booking.address ||
            (meta.addressLine as string | undefined),
          landmark: meta.landmark as string | undefined,
          packageIds,
          testIds,
          uniqueId,
          notes: meta.notes as string | undefined,
          altContact: meta.altContact as string | undefined,
          altEmail: meta.altEmail as string | undefined,
          hardCopy: meta.hardCopy as number | undefined,
          vendorBookingId: String(booking._id),
          // Milestone D9: the accepted post-coupon total of this payment attempt (gateway + wallet portion), not just
          // the gateway part. booking.price stays the gross price on this branch, so it is derived from the record.
          discountedPrice: acceptedTotal(paymentRecord),
          paymentOption:
            (meta.paymentOption as 'cod' | 'prepaid' | undefined) || 'prepaid',
          applicationNumber: meta.applicationNumber as string | undefined,
          customerRemarks: meta.customerRemarks as string | undefined,
          isPpmcBooking: meta.isPpmcBooking as number | undefined,
        })
      : await labstackService.placeDiagnosticsOrder({
        orderType: booking.appointmentType,
        appointment,
        name: booking.patientName,
        mobile: booking.patientPhone,
        email: booking.patientEmail,
        gender: meta.patientGender as string | undefined,
        age: meta.patientAge as string | undefined,
        pincode: meta.pincode as string | undefined,
        unitFloorBuilding: addressFields.unitFloorBuilding,
        locality: addressFields.locality,
        city: meta.city as string | undefined,
        state: meta.state as string | undefined,
        latitude: meta.latitude as number | undefined,
        longitude: meta.longitude as number | undefined,
        address: addressFields.address,
        packageIds,
        testIds,
        labId: typeof meta.labId === 'string' ? meta.labId : undefined,
        uniqueId,
        referenceId: String(booking._id),
      notes: meta.notes as string | undefined,
      altContact: meta.altContact as string | undefined,
      });
  const providerLabMeta =
    booking.integration === 'labstack'
      ? extractLabstackLabLocationMeta(result.payload)
      : {};

  const {
    pendingLabstack: _dropLabstack,
    pendingHealthians: _dropHealthians,
    ...metaRest
  } = meta;

  const updated = await externalBookingRepository.update(
    { _id: booking._id },
    {
      externalProviderId:
        booking.integration === 'healthians'
          ? (booking.externalProviderId || 'healthians')
          : (typeof meta.labId === 'string' && meta.labId.trim()
          ? meta.labId.trim()
          : booking.externalProviderId) || 'labstack',
      externalBookingId: result.externalBookingId,
      externalSlotRef:
        (typeof meta.stmId === 'string' && meta.stmId.trim()) ||
        booking.externalSlotRef ||
        booking.bookingTime,
      status: result.externalStatus,
      paymentStatus: 'paid',
      paymentTransactionId: paymentRecord._id!,
      meta: {
        ...metaRest,
        ...providerLabMeta,
        externalPayload: result.payload,
      },
    }
  );

  if (!updated) {
    throw new AppError({
      status: 500,
      code: 'EXTERNAL_BOOKING_UPDATE_FAILED',
      message: 'Failed to update external diagnostics booking after payment',
    });
  }

  logger.info('[ExternalBooking][finalize][diagnostics] place success', {
    bookingId: booking._id,
    paymentTransactionId: paymentRecord._id,
    integration: booking.integration,
    externalBookingId: result.externalBookingId,
    externalStatus: result.externalStatus,
  });

  return updated as IExternalBooking;
}
