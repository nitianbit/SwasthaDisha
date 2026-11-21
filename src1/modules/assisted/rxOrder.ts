import { Types } from 'mongoose';
import BookingModel from '@/modules/bookings/model';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import { AppError } from '@/modules/common/types';
import { bindServerFile, uploadPathOf } from '@/modules/file/access';
import { ensureDispensingCopy } from '@/modules/assisted/dispensingCopy';
import { hasPrescription, rxWindowOpenFor } from '@/modules/assisted/rxAccess';
import type { CreateOrderRequest, IPharmacyOrder } from '@/modules/pharmacyOrders/types';

/**
 * Assisted booking phase 0 (§9.3, decision 9): "Create medicine order" from the prescription of a booking this pharmacy
 * made. `POST /api/v1/pharmacy-orders` with `prescriptionFromBookingId` + `requestKey`. The server checks the booking,
 * the S3 consented link, the prescription and the 90-day window; binds the dispensing copy itself (never a client value,
 * so the uploader rule is unchanged); P9 review, stock and payment then apply as for any order.
 */
export const RX_ORDER_KEY = /^[A-Za-z0-9_-]{8,64}$/;

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const notFound = () => err(404, 'BOOKING_NOT_FOUND', 'Booking not found');
const lower = (v: unknown) => String(v ?? '').toLowerCase();

export interface RxOrderTerms {
  bookingId: string;
  customerId: string;
  fileUrl: string;
  bindingExpiresAt: Date;
}

/** Request shape checks that need no read (400s). */
export function assertRxOrderRequest(data: CreateOrderRequest): string {
  const key = typeof data.requestKey === 'string' ? data.requestKey.trim() : '';
  if (!RX_ORDER_KEY.test(key)) throw err(400, 'REQUEST_KEY_REQUIRED', 'An order from a prescription needs a requestKey');
  if (data.buyerPharmacyId) throw err(400, 'LINKED_ORDER_REQUIRES_USER', 'Consultation or diagnostic linked orders require customerId, not buyerPharmacyId');
  if (Array.isArray(data.prescriptionUrls) && data.prescriptionUrls.length) {
    throw err(400, 'PRESCRIPTION_SOURCE_CONFLICT', "An order from a booking's prescription carries that prescription only; send no prescriptionUrls");
  }
  return key;
}

/**
 * The checks, in order: the booking is this pharmacy's (any other or a missing one: 404 BOOKING_NOT_FOUND, also when the
 * sent customerId / linkedConsultationId name another), the customer's link to this pharmacy has the patient's consent
 * (S3: 403 CUSTOMER_NOT_LINKED / CUSTOMER_CONSENT_REQUIRED), a prescription exists (409 PRESCRIPTION_NOT_READY), the
 * 90-day window is open (403 PRESCRIPTION_ACCESS_EXPIRED), and the dispensing copy exists or is made now (503
 * DISPENSING_COPY_UNAVAILABLE when the PDF cannot be written).
 */
export async function prepareRxOrder(pharmacyId: string, data: CreateOrderRequest): Promise<RxOrderTerms> {
  const bookingId = data.prescriptionFromBookingId;
  if (typeof bookingId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(bookingId) || !Types.ObjectId.isValid(pharmacyId)) throw notFound();
  const b = await BookingModel.findOne({ _id: bookingId, pharmacyId: { $eq: pharmacyId } }).lean() as Record<string, any> | null;
  if (!b) throw notFound();
  if (data.customerId !== undefined && lower(data.customerId) !== lower(b.userId)) throw notFound();
  if (data.linkedConsultationId !== undefined && lower(data.linkedConsultationId) !== lower(b._id)) throw notFound();
  const link = Types.ObjectId.isValid(String(b.userId))
    ? await PharmacyCustomerModel.findOne({ pharmacyId: new Types.ObjectId(pharmacyId), userId: new Types.ObjectId(String(b.userId)) })
      .select({ consent: 1 }).lean()
    : null;
  if (!link) throw err(403, 'CUSTOMER_NOT_LINKED', 'This customer is not linked to your pharmacy');
  if (link.consent !== 'patient_agreed' && link.consent !== 'customer_order') {
    throw err(403, 'CUSTOMER_CONSENT_REQUIRED', "The patient's agreement to this link is not recorded; link the customer again with the patient's consent");
  }
  if (b.bookingType !== 'consultation' || !hasPrescription(b.prescription)) {
    throw err(409, 'PRESCRIPTION_NOT_READY', 'This booking has no prescription yet');
  }
  const window = await rxWindowOpenFor(b);
  if (!window.open || !window.until) {
    throw err(403, 'PRESCRIPTION_ACCESS_EXPIRED', 'The prescription of this booking is available to the pharmacy for 90 days after the consultation');
  }
  let fileUrl: string | null;
  try {
    fileUrl = await ensureDispensingCopy(b);
  } catch {
    throw err(503, 'DISPENSING_COPY_UNAVAILABLE', 'The prescription copy could not be prepared; try again');
  }
  if (!fileUrl) throw err(409, 'PRESCRIPTION_NOT_READY', 'This booking has no prescription yet');
  return { bookingId: String(b._id), customerId: String(b.userId), fileUrl, bindingExpiresAt: window.until };
}

/** Binds the order's dispensing copy (idempotent; a replay repairs a first attempt that stopped before binding). */
export async function bindRxOrderFile(order: Pick<IPharmacyOrder, '_id' | 'prescriptionFromBooking'> | null | undefined): Promise<void> {
  const rx = order?.prescriptionFromBooking;
  const path = uploadPathOf(rx?.fileUrl);
  if (!order?._id || !rx || !path) return;
  await bindServerFile(path, 'pharmacy_order', { model: 'PharmacyOrder', resourceId: order._id, field: 'prescriptionUrls' },
    { expiresAt: new Date(rx.bindingExpiresAt), keepIfDispensed: true });
}
