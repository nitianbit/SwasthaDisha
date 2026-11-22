import mongoose, { Schema, model, Model } from 'mongoose';

/** S5c: one row per admin close of a consultation; unique per (admin, requestKey) - see bookings/adminClose.ts. */
export interface IBookingAdminClose {
  adminId: string;
  requestKey: string;
  requestHash: string;
  bookingId: string;
  specialistId: string | null;
  reason: string;
  statusBefore: string;
  paymentStatusBefore: string;
  refunded: number;
  closedAt: Date;
}

const closeSchema = new Schema<IBookingAdminClose>({
  adminId: { type: String, required: true },
  requestKey: { type: String, required: true },
  requestHash: { type: String, required: true },
  bookingId: { type: String, required: true, index: true },
  specialistId: { type: String, default: null },
  reason: { type: String, required: true },
  statusBefore: { type: String, required: true },
  paymentStatusBefore: { type: String, required: true },
  refunded: { type: Number, required: true },
  closedAt: { type: Date, required: true },
}, { versionKey: false });
closeSchema.index({ adminId: 1, requestKey: 1 }, { unique: true });

export const BookingAdminCloseModel: Model<IBookingAdminClose> =
  (mongoose.models.BookingAdminClose as Model<IBookingAdminClose>) || model<IBookingAdminClose>('BookingAdminClose', closeSchema);

