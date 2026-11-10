import {
  IBooking,
  IDocument,
  IBookingFollowUp,
  IBookingLifecycle,
  IBookingPrescription,
  IBookingReport,
  IServiceAddress,
  IVirtualMeeting
} from '@/modules/bookings/types';
import { model, Model, Schema } from 'mongoose';

const documentSchema = new Schema<IDocument>(
  {
    type: {
      type: String,
      enum: ['report', 'prescription', 'other'],
      required: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    fileName: {
      type: String,
      trim: true,
    },
  },
  { _id: false }
);

const serviceAddressSchema = new Schema<IServiceAddress>(
  {
    addressLine: {
      type: String,
      required: true,
      trim: true,
    },
    city: {
      type: String,
      required: true,
      trim: true,
    },
    pincode: {
      type: String,
      required: true,
      trim: true,
    },
    state: {
      type: String,
      trim: true,
    },
  },
  { _id: false }
);

const prescriptionSchema = new Schema<IBookingPrescription>(
  {
    fileUrls: {
      type: [String],
      default: [],
    },
    message: {
      type: String,
      trim: true,
    },
    diagnosis: {
      type: String,
      trim: true,
    },
    advice: {
      type: String,
      trim: true,
    },
    medicines: {
      type: [
        new Schema(
          {
            name: {
              type: String,
              required: true,
              trim: true,
            },
            dosage: {
              type: String,
              trim: true,
            },
            frequency: {
              type: String,
              trim: true,
            },
            instructions: {
              type: String,
              trim: true,
            },
            duration: {
              type: String,
              trim: true,
            },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    testsAdvised: {
      type: [String],
      default: [],
    },
    prescribedAt: {
      type: String,
      trim: true,
    },
    prescribedBySpecialistId: {
      type: String,
      trim: true,
    },
    prescribedBySpecialistName: {
      type: String,
      trim: true,
    },
  },
  { _id: false }
);

const reportSchema = new Schema<IBookingReport>(
  {
    fileUrls: {
      type: [String],
      default: [],
    },
    message: {
      type: String,
      trim: true,
    },
  },
  { _id: false }
);

const followUpSchema = new Schema<IBookingFollowUp>(
  {
    isFollowUp: {
      type: Boolean,
      default: false,
    },
    parentConsultationId: {
      type: String,
      trim: true,
      index: true,
    },
    eligibilityExpiresAt: {
      type: String,
      match: /^\d{8}$/,
    },
    benefitUsed: {
      type: Boolean,
      default: false,
    },
    completedAt: {
      type: String,
      match: /^\d{8}$/,
    },
  },
  { _id: false }
);

const virtualMeetingSchema = new Schema<IVirtualMeeting>(
  {
    provider: {
      type: String,
      enum: ['google_meet'],
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'cancelled', 'failed'],
      required: true,
    },
    joinUrl: {
      type: String,
      trim: true,
    },
    meetingCode: {
      type: String,
      trim: true,
    },
    calendarEventId: {
      type: String,
      trim: true,
    },
    startDateTime: {
      type: String,
      trim: true,
    },
    endDateTime: {
      type: String,
      trim: true,
    },
    error: {
      type: String,
      trim: true,
    },
    createdAt: {
      type: Date,
    },
    updatedAt: {
      type: Date,
    },
    cancelledAt: {
      type: Date,
    },
  },
  { _id: false }
);

const bookingLifecycleEventSchema = new Schema(
  {
    at: {
      type: String,
      trim: true,
    },
    by: {
      type: String,
      trim: true,
    },
    amount: {
      type: Number,
      min: 0,
    },
    reason: {
      type: String,
      trim: true,
    },
  },
  { _id: false }
);

const bookingLifecycleSchema = new Schema<IBookingLifecycle>(
  {
    created: {
      type: bookingLifecycleEventSchema,
    },
    paymentPending: {
      type: bookingLifecycleEventSchema,
    },
    paid: {
      type: bookingLifecycleEventSchema,
    },
    confirmed: {
      type: bookingLifecycleEventSchema,
    },
    rescheduled: {
      type: bookingLifecycleEventSchema,
    },
    cancelled: {
      type: bookingLifecycleEventSchema,
    },
    completed: {
      type: bookingLifecycleEventSchema,
    },
    prescriptionUploaded: {
      type: bookingLifecycleEventSchema,
    },
    refunded: {
      type: bookingLifecycleEventSchema,
    },
  },
  { _id: false }
);

const bookingSchema = new Schema<IBooking>(
  {
    bookingType: {
      type: String,
      enum: ['package', 'consultation', 'second-opinion', 'surgery'],
      required: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    pharmacyId: {
      type: String,
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
    wellnessPackageId: {
      type: String,
      index: true,
    },
    packageName: {
      type: String,
      trim: true,
    },
    specialistId: {
      type: String,
      index: true,
    },
    doctorName: {
      type: String,
      trim: true,
    },
    primaryConcern: {
      type: String,
      trim: true,
    },
    consultationMode: {
      type: String,
      enum: ['chat', 'call', 'video', 'in-person'],
    },
    slotId: {
      type: String,
      index: true,
    },
    bookingDate: {
      type: String,
      required: true,
      index: true,
      match: /^\d{8}$/, // YYYYMMDD format
    },
    bookingTime: {
      type: String,
      required: true,
      trim: true,
    },
    serviceMode: {
      type: String,
      enum: ['in-person', 'pickup', 'chat', 'call', 'video'],
      required: true,
      index: true,
    },
    serviceAddress: {
      type: serviceAddressSchema,
    },
    documents: {
      type: [documentSchema],
      default: [],
    },
    prescription: {
      type: prescriptionSchema,
    },
    report: {
      type: reportSchema,
    },
    followUp: {
      type: followUpSchema,
    },
    contactNo: {
      type: String,
      trim: true,
      match: /^\d{10}$/, // Exactly 10 digits
    },
    alternateContactNo: {
      type: String,
      trim: true,
      match: /^\d{10}$/, // Exactly 10 digits
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    originalPrice: {
      type: Number,
      min: 0,
    },
    paymentTransactionId: {
      type: String,
      trim: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'completed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
      index: true,
    },
    lifecycle: {
      type: bookingLifecycleSchema,
    },
    notes: {
      type: String,
      trim: true,
    },
    cancellationReason: {
      type: String,
      trim: true,
    },
    cancelledAt: {
      type: String,
      match: /^\d{8}$/, // YYYYMMDD format
    },
    virtualMeeting: {
      type: virtualMeetingSchema,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for better query performance
bookingSchema.index({ userId: 1, status: 1 });
bookingSchema.index({ userId: 1, bookingDate: 1 });
bookingSchema.index({ pharmacyId: 1, status: 1 });
bookingSchema.index({ pharmacyId: 1, bookingDate: 1 });
bookingSchema.index({ corporateId: 1, status: 1 });
bookingSchema.index({ corporateId: 1, bookingDate: 1 });
bookingSchema.index({ bookingType: 1, status: 1 });
bookingSchema.index({ wellnessPackageId: 1, status: 1 });
bookingSchema.index({ specialistId: 1, status: 1 });
bookingSchema.index({ slotId: 1, status: 1 }); // Index for slot-based queries
bookingSchema.index({ bookingDate: 1, bookingTime: 1 });
bookingSchema.index({ status: 1, paymentStatus: 1 });

const BookingModel: Model<IBooking> = model<IBooking>('Booking', bookingSchema);

export default BookingModel;
