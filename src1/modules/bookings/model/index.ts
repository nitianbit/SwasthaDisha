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
    // Phase 3d (§25.7.3): the code of the doctor's recommended tests printed on this prescription (server-written).
    recommendationCode: {
      type: String,
      trim: true,
    },
    // Assisted booking phase 0 (D15): the server-made dispensing copy (no diagnosis). Only `url` is ever answered: the
    // hash of the content it shows and its time are internal (select: false; the assisted module selects them).
    dispensingCopy: {
      type: new Schema({ url: { type: String }, hash: { type: String, select: false }, at: { type: Date, select: false } }, { _id: false }),
      default: undefined,
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
    // Capacity and benefits this booking holds (A2a), taken in the creation transaction and given back once by the
    // cancellation transaction. Absent on bookings created before A2a (see bookings/holds.ts for how those are reconciled).
    holds: {
      type: new Schema({
        version: { type: Number, required: true, enum: [1] },
        heldSlotId: { type: String, default: null },
        followUpParentId: { type: String, default: null },
      }, { _id: false }),
      default: undefined,
    },
    // Payment record whose post-payment follow-up (reminders/meeting/email) finished; replays resume until set.
    postPaymentCompletedFor: { type: String },
    // Client key of the create request (W3b): a resent create answers with this booking instead of booking again.
    createRequestKey: { type: String },
    // The validated payment terms of the create, stored with the insert: an interrupted creation is finished with
    // exactly these (never with a resent request's body).
    createTerms: {
      type: new Schema({
        basePrice: { type: Number, required: true },
        discountAmount: { type: Number, required: true },
        couponCode: { type: String },
        useWalletBalance: { type: Boolean, required: true },
      }, { _id: false }),
      default: undefined,
    },
    // Wallet money applied to this booking (rupees); see common/utils/bookingWalletFunding.ts.
    walletFunding: {
      type: new Schema({
        total: { type: Number, required: true, min: 0 },
        revision: { type: Number, required: true, min: 0, default: 0 },
        closed: { type: Boolean, default: false },
        captures: {
          type: [new Schema({ recordId: { type: String, required: true }, amount: { type: Number, required: true, min: 0 },
            state: { type: String, required: true, enum: ['applied', 'returned'] } }, { _id: false })],
          default: [],
        },
        updatedAt: { type: Date },
      }, { _id: false }),
      default: undefined,
    },
    status: {
      type: String,
      // Q4: 'no_show' — the patient did not attend a paid consultation (no refund).
      enum: ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'],
      default: 'pending',
      index: true,
    },
    // Q14: the current no-show (who marked it, when); moved into noShows when the booking is rescheduled after it.
    noShow: {
      type: new Schema({ at: { type: Date, required: true }, by: { type: String, required: true }, byKind: { type: String, required: true } }, { _id: false }),
      default: undefined,
    },
    // Q14: no-shows that were rescheduled (at most one: noShowReschedules ≤ 1); a second no-show is final.
    noShows: {
      type: [new Schema({
        at: { type: Date }, by: { type: String }, byKind: { type: String },
        rescheduledAt: { type: Date, required: true }, rescheduledBy: { type: String, required: true }, rescheduledByKind: { type: String, required: true },
        fromSlotId: { type: String }, fromDate: { type: String }, fromTime: { type: String }, toSlotId: { type: String, required: true },
        requestKey: { type: String, required: true }, requestHash: { type: String, required: true },
      }, { _id: false })],
      default: undefined,
    },
    noShowReschedules: { type: Number },
    // Q16a: an admin cancelled this moved no-show; refund false = the money stays (nobody earns it).
    // Q16a: the appointment before the first customer reschedule (history; never overwritten).
    originalAppointment: {
      type: new Schema({ bookingDate: { type: String, required: true }, bookingTime: { type: String, required: true } }, { _id: false }),
      default: undefined,
    },
    // Q16a: set when a customer moved the booking AFTER its refund deadline had passed; that closed window still applies.
    refundLock: {
      type: new Schema({ bookingDate: { type: String, required: true }, bookingTime: { type: String, required: true }, movedAt: { type: Date, required: true } },
        { _id: false }),
      default: undefined,
    },
    noShowCancel: {
      type: new Schema({ at: { type: Date, required: true }, by: { type: String, required: true }, refund: { type: Boolean, required: true },
        forfeitedAmount: { type: Number, min: 0 } }, { _id: false }),
      default: undefined,
    },
    // Assisted booking (§5.1): written on assisted rows; readers derive it for older rows (clinic_desk / self).
    source: { type: String, enum: ['self', 'pharmacy_assisted', 'lab_assisted', 'doctor_assisted', 'clinic_desk', 'lab_desk'] },
    // Assisted booking (§5.1, P5): the earning rule frozen at create (provider-borne coupon, cut 0 until phase 4).
    earningRule: { type: String, enum: ['provider_coupon_v2'] },
    // r32 (4c, §26.7): a SELF booking made while EARNING_RULE_V2_FOR_ALL was on: its split (the assisted split's shape, cut 0).
    earningSplit: { type: Schema.Types.Mixed },
    // Assisted booking phase 1a (§5.1, §17): booker, consent, language, identity, join, funding (wallet), split. The
    // shape is assisted/types AssistedBlock; written only by the assisted writers.
    assisted: { type: Schema.Types.Mixed },
    // Q3 §7a: which system pays this booking's provider — the legacy monthly payouts or the new ledger. Exclusive.
    settlementSystem: {
      type: String,
      enum: ['legacy', 'ledger', 'clinic'],
      default: 'legacy',
    },
    // Q6: an appointment a clinic's front desk booked; the clinic collects the fee (its own invoice), never us.
    clinicDesk: {
      type: new Schema({
        partnerId: { type: String, required: true },
        branchId: { type: String, required: true },
        createdBy: { type: String, required: true },
        arrivedAt: { type: Date },
        /** Exactly once per desk member + request key (unique below), with the request's content hash. */
        requestKey: { type: String },
        requestHash: { type: String },
      }, { _id: false }),
      default: undefined,
    },
    // Q6: the clinic and branch an in-clinic booking belongs to, frozen at admission and moved only by an admitted
    // reschedule (never inferred later from a slot, whose branch may change once its seat is free).
    clinicVisit: {
      type: new Schema({ partnerId: { type: String, required: true }, branchId: { type: String, required: true } }, { _id: false }),
      default: undefined,
    },
    // Q4b: 'instant' consultations come from an accepted InstantRequest (money held there, not on this booking).
    bookingKind: { type: String, enum: ['scheduled', 'instant'] },
    instantRequestId: { type: String },
    // Q13: the doctor's extensions of an instant consultation; a keyed extension is applied once (the doctor guard serializes them).
    instantExtensions: {
      type: [new Schema({ requestKey: { type: String }, minutes: { type: Number, required: true }, endTime: { type: Date, required: true },
        at: { type: Date, required: true } }, { _id: false })],
      default: undefined,
    },
    // Q4 §7a: the doctor's settlement account at creation (ledger bookings only); earnings never re-derive it.
    settlement: {
      settlementAccountId: { type: String },
      beneficiaryName: { type: String },
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
    // Machine-readable reason of a cancellation the system made (D2: 'payment_timeout').
    cancellationCause: { type: String },
    // Unpaid-booking expiry sweep (D2): next time this booking is examined after an inconclusive gateway check.
    expiryNextAt: { type: Date },
    expiryChecks: { type: Number },
    virtualMeeting: {
      type: virtualMeetingSchema,
    },
    // r10g: the Meet retry of a paid call/video booking left without a link (meet/retry.ts): attempts, next try, the
    // retry lease, when it was alerted and when a link was made. Written only by that retry.
    meetRetry: { type: Schema.Types.Mixed, default: undefined },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for better query performance
bookingSchema.index({ userId: 1, status: 1 });
// Unpaid-booking expiry sweep (D2): pending, unpaid, due first.
bookingSchema.index({ status: 1, paymentStatus: 1, expiryNextAt: 1, createdAt: 1 });
// One booking per customer and create key; bookings without a key are not constrained (W3b).
bookingSchema.index({ userId: 1, createRequestKey: 1 }, { unique: true, partialFilterExpression: { createRequestKey: { $type: 'string' } } });
bookingSchema.index({ userId: 1, bookingDate: 1 });
bookingSchema.index({ pharmacyId: 1, status: 1 });
bookingSchema.index({ pharmacyId: 1, bookingDate: 1 });
// Assisted booking phase 0: the booking pharmacy's list, newest first (cursor <createdAt ms>_<id>).
bookingSchema.index({ pharmacyId: 1, createdAt: -1, _id: -1 });
// Assisted booking phase 1a (§5.1, §15): the booker's list, the short reference and the exactly-once request key.
bookingSchema.index({ 'assisted.bookedBy.kind': 1, 'assisted.bookedBy.id': 1, createdAt: -1 });
bookingSchema.index({ 'assisted.shortRef': 1 }, { unique: true, partialFilterExpression: { 'assisted.shortRef': { $type: 'string' } } });
bookingSchema.index({ 'assisted.requestKey': 1 }, { unique: true, partialFilterExpression: { 'assisted.requestKey': { $type: 'string' } } });
bookingSchema.index({ corporateId: 1, status: 1 });
bookingSchema.index({ corporateId: 1, bookingDate: 1 });
bookingSchema.index({ bookingType: 1, status: 1 });
bookingSchema.index({ wellnessPackageId: 1, status: 1 });
bookingSchema.index({ specialistId: 1, status: 1 });
bookingSchema.index({ specialistId: 1, settlementSystem: 1, bookingType: 1, bookingDate: 1 });
bookingSchema.index({ 'clinicDesk.partnerId': 1, bookingDate: 1 });
bookingSchema.index({ 'clinicVisit.partnerId': 1, bookingDate: 1 });
bookingSchema.index({ 'clinicDesk.requestKey': 1 }, { unique: true, partialFilterExpression: { 'clinicDesk.requestKey': { $type: 'string' } } });
bookingSchema.index({ instantRequestId: 1 }, { unique: true, partialFilterExpression: { instantRequestId: { $type: 'string' } } });
bookingSchema.index({ slotId: 1, status: 1 }); // Index for slot-based queries
bookingSchema.index({ bookingDate: 1, bookingTime: 1 });
bookingSchema.index({ status: 1, paymentStatus: 1 });

const BookingModel: Model<IBooking> = model<IBooking>('Booking', bookingSchema);

export default BookingModel;
