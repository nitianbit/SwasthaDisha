import { Response } from 'express';
import Joi from 'joi';
import mongoose, { Schema, model, Model } from 'mongoose';
import BookingModel from '@/modules/bookings/model';
import { AppError } from '@/modules/common/types';
import { AuthRequest } from '@/modules/middleware/auth';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import logger from '@/services/logger';

/**
 * S5: an admin removes a planted prescription or report from a booking (DELETE /bookings/:id/prescription | /report).
 * The field is unset (for a prescription also its marker lifecycle.prescriptionUploaded, so a pharmacy order can no
 * longer be linked on its strength) and one audit row is written in the same transaction: who, when, why, and the ids
 * and file references that were removed (no medicines, diagnosis or names). The stored files are not deleted.
 */
export type ClearedField = 'prescription' | 'report';

export interface IBookingAdminClear {
  bookingId: string;
  field: ClearedField;
  reason: string;
  adminId: string;
  clearedAt: Date;
  removed: { prescribedBySpecialistId?: string; prescribedAt?: string; markerAt?: string; fileUrls?: string[] };
}

const bookingAdminClearSchema = new Schema<IBookingAdminClear>({
  bookingId: { type: String, required: true, index: true },
  field: { type: String, required: true, enum: ['prescription', 'report'] },
  reason: { type: String, required: true, trim: true },
  adminId: { type: String, required: true },
  clearedAt: { type: Date, required: true },
  removed: {
    type: new Schema({ prescribedBySpecialistId: String, prescribedAt: String, markerAt: String, fileUrls: { type: [String], default: undefined } }, { _id: false }),
    default: {},
  },
}, { versionKey: false });

export const BookingAdminClearModel: Model<IBookingAdminClear> = (mongoose.models.BookingAdminClear as Model<IBookingAdminClear>)
  || model<IBookingAdminClear>('BookingAdminClear', bookingAdminClearSchema);

export const adminClearBodySchema = Joi.object({
  reason: Joi.string().trim().min(3).max(500).required().messages({ 'any.required': 'reason is required' }),
});

export async function clearBookingField(bookingId: string, field: ClearedField, adminId: string, reason: string) {
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
    const [row] = await BookingAdminClearModel.create([{
      bookingId: String(bookingId), field, reason, adminId: String(adminId), clearedAt: new Date(),
      removed: {
        ...(value?.prescribedBySpecialistId ? { prescribedBySpecialistId: String(value.prescribedBySpecialistId) } : {}),
        ...(value?.prescribedAt ? { prescribedAt: String(value.prescribedAt) } : {}),
        ...(marker ? { markerAt: String(marker) } : {}),
        ...(fileUrls?.length ? { fileUrls } : {}),
      },
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
