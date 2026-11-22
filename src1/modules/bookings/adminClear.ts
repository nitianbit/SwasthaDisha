import { Response } from 'express';
import Joi from 'joi';
import BookingModel from '@/modules/bookings/model';
import { BookingAdminClearModel, type ClearedField } from '@/modules/bookings/model/adminClear';
import { assertIndexBuilt } from '@/modules/common/utils/requiredCollection';
import { AppError } from '@/modules/common/types';
import { AuthRequest } from '@/modules/middleware/auth';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import logger from '@/services/logger';
import { uploadPathOf } from '@/modules/file/access';

/**
 * S5: an admin removes a planted prescription or report from a booking (DELETE /bookings/:id/prescription | /report).
 * The field is unset (for a prescription also its marker lifecycle.prescriptionUploaded, so a pharmacy order can no
 * longer be linked on its strength) and one audit row is written in the same transaction: who, when, why, and the ids
 * and file references that were removed (no medicines, diagnosis or names). The stored files are not deleted.
 */
// The model lives in bookings/model/adminClear.ts so sync-indexes creates its collection and index (production runs
// with autoCreate/autoIndex off).
export { BookingAdminClearModel } from '@/modules/bookings/model/adminClear';
export type { IBookingAdminClear, ClearedField } from '@/modules/bookings/model/adminClear';

export const adminClearBodySchema = Joi.object({
  reason: Joi.string().trim().min(3).max(500).required().messages({ 'any.required': 'reason is required' }),
});

export async function clearBookingField(bookingId: string, field: ClearedField, adminId: string, reason: string) {
  // The audit row is written inside the transaction: its collection must already exist (sync-indexes), else 503.
  await assertIndexBuilt(BookingAdminClearModel, { bookingId: 1 });
  return runLedgerTransaction(async (session) => {
    const booking = await BookingModel.findById(bookingId).select({ prescription: 1, report: 1, 'lifecycle.prescriptionUploaded': 1 })
      .session(session).lean() as { prescription?: Record<string, any>; report?: Record<string, any>; lifecycle?: { prescriptionUploaded?: { at?: string } } } | null;
    if (!booking) throw new AppError({ status: 404, code: 'BOOKING_NOT_FOUND', message: 'Booking not found' });
    const value = booking[field];
    const marker = field === 'prescription' ? booking.lifecycle?.prescriptionUploaded?.at : undefined;
    if (!value && !marker) {
      throw new AppError({ status: 404, code: field === 'prescription' ? 'PRESCRIPTION_NOT_FOUND' : 'REPORT_NOT_FOUND',
        message: `This booking has no ${field}` });
    }
    const unset: Record<string, ''> = { [field]: '' };
    if (field === 'prescription') unset['lifecycle.prescriptionUploaded'] = '';
    await BookingModel.updateOne({ _id: bookingId }, { $unset: unset }, { session });
    const fileUrls = Array.isArray(value?.fileUrls) ? value!.fileUrls.map(String) : undefined;
    // Review of fb4063c7 (1): the assisted dispensing copy goes with the prescription; every withdrawn file is recorded
    // by its upload path so file access keeps refusing it after the doctor saves a new prescription.
    const copyUrl = field === 'prescription' && typeof value?.dispensingCopy?.url === 'string' ? String(value.dispensingCopy.url) : undefined;
    const paths = [...new Set([...(fileUrls ?? []), ...(copyUrl ? [copyUrl] : [])].map((u) => uploadPathOf(u)).filter((x): x is string => !!x))];
    const [row] = await BookingAdminClearModel.create([{
      bookingId: String(bookingId).toLowerCase(), field, reason, adminId: String(adminId), clearedAt: new Date(),
      removed: {
        ...(value?.prescribedBySpecialistId ? { prescribedBySpecialistId: String(value.prescribedBySpecialistId) } : {}),
        ...(value?.prescribedAt ? { prescribedAt: String(value.prescribedAt) } : {}),
        ...(marker ? { markerAt: String(marker) } : {}),
        ...(fileUrls?.length ? { fileUrls } : {}),
        ...(copyUrl ? { dispensingCopyUrl: copyUrl } : {}),
      },
      paths,
    }], { session });
    return row;
  });
}

const clearHandler = (field: ClearedField) => async (req: AuthRequest, res: Response) => {
  if (req.user?.userType !== 'admin') throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Admin access is required' });
  const row = await clearBookingField(req.params.id, field, req.user._id, req.body.reason);
  logger.warn('S5: admin cleared a booking field', { field, bookingId: String(req.params.id), adminId: String(req.user._id), auditId: String(row._id) });
  res.status(200).json({ success: true, message: `Booking ${field} removed`, data: { bookingId: String(req.params.id), cleared: field, auditId: String(row._id) } });
};

export const clearBookingPrescription = clearHandler('prescription');
export const clearBookingReport = clearHandler('report');
