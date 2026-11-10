import { model, Model, Schema } from 'mongoose';
import { IExternalBooking } from '@/modules/externalBookings/types';

const externalBookingSchema = new Schema<IExternalBooking>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    dependentId: {
      type: String,
      index: true,
    },
    corporateId: {
      type: String,
      index: true,
    },
    integration: {
      type: String,
      enum: ['labstack', 'healthians'],
      required: true,
      index: true,
    },
    providerType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    appointmentType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    externalProviderId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    externalBookingId: {
      type: String,
      trim: true,
      index: true,
    },
    externalSlotRef: {
      type: String,
      trim: true,
    },
    meetingLink: {
      type: String,
      trim: true,
    },
    bookingDate: {
      type: String,
      required: true,
      match: /^\d{8}$/,
      index: true,
    },
    bookingTime: {
      type: String,
      required: true,
      trim: true,
    },
    patientName: {
      type: String,
      required: true,
      trim: true,
    },
    patientEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    patientPhone: {
      type: String,
      trim: true,
    },
    doctorName: {
      type: String,
      trim: true,
    },
    labName: {
      type: String,
      trim: true,
    },
    packageNames: {
      type: [String],
      default: undefined,
    },
    testNames: {
      type: [String],
      default: undefined,
    },
    address: {
      type: String,
      trim: true,
    },
    report: {
      type: [String],
      default: undefined,
    },
    price: {
      type: Number,
      min: 0,
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'cancelled', 'refunded'],
      trim: true,
      index: true,
    },
    paymentTransactionId: {
      type: String,
      trim: true,
      index: true,
    },
    status: {
      type: String,
      trim: true,
      index: true,
    },
    meta: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

externalBookingSchema.index({ userId: 1, bookingDate: -1, createdAt: -1 });
externalBookingSchema.index({ integration: 1, providerType: 1, appointmentType: 1 });
externalBookingSchema.index({ externalBookingId: 1, integration: 1 });

const ExternalBookingModel: Model<IExternalBooking> = model<IExternalBooking>(
  'ExternalBooking',
  externalBookingSchema
);

export default ExternalBookingModel;
