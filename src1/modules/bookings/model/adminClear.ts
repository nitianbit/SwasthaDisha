import mongoose, { Schema, model, Model } from 'mongoose';

/** S5: one row per admin removal of a booking's prescription or report (bookings/adminClear.ts). */
export type ClearedField = 'prescription' | 'report';

export interface IBookingAdminClear {
  bookingId: string;
  field: ClearedField;
  reason: string;
  adminId: string;
  clearedAt: Date;
  removed: { prescribedBySpecialistId?: string; prescribedAt?: string; markerAt?: string; fileUrls?: string[]; dispensingCopyUrl?: string };
  /**
   * Review of fb4063c7 (1): the upload-dir paths of every file this clear withdrew (full PDFs, the dispensing copy), so
   * a later prescription never makes them readable again (file/access.ts). Rows written before this field have none.
   */
  paths?: string[];
}

const bookingAdminClearSchema = new Schema<IBookingAdminClear>({
  bookingId: { type: String, required: true, index: true },
  field: { type: String, required: true, enum: ['prescription', 'report'] },
  reason: { type: String, required: true, trim: true },
  adminId: { type: String, required: true },
  clearedAt: { type: Date, required: true },
  removed: {
    type: new Schema({ prescribedBySpecialistId: String, prescribedAt: String, markerAt: String, fileUrls: { type: [String], default: undefined },
      dispensingCopyUrl: String }, { _id: false }),
    default: {},
  },
  paths: { type: [String], default: undefined },
}, { versionKey: false });
bookingAdminClearSchema.index({ paths: 1 });

export const BookingAdminClearModel: Model<IBookingAdminClear> = (mongoose.models.BookingAdminClear as Model<IBookingAdminClear>)
  || model<IBookingAdminClear>('BookingAdminClear', bookingAdminClearSchema);

