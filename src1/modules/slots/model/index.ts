import { Schema, model, Model } from 'mongoose';
import { ISlot } from '@/modules/slots/types';

const slotSchema = new Schema<ISlot>(
  {
    specialistId: {
      type: String,
      index: true,
    },
    wellnessPackageId: {
      type: String,
      index: true,
    },
    date: {
      type: String,
      required: true,
      index: true,
      match: /^\d{8}$/, // YYYYMMDD format
    },
    startTime: {
      type: String,
      required: true,
      trim: true,
    },
    endTime: {
      type: String,
      required: true,
      trim: true,
    },
    duration: {
      type: Number,
      min: 1,
    },
    isAvailable: {
      type: Boolean,
      default: true,
      index: true,
    },
    maxBookings: {
      type: Number,
      min: 1,
      default: 1,
    },
    currentBookings: {
      type: Number,
      min: 0,
      default: 0,
    },
    slotType: {
      type: String,
      enum: ['consultation', 'wellnessPackage'],
      index: true,
    },
    isRecurring: {
      type: Boolean,
      default: false,
    },
    recurringPattern: {
      type: String,
      enum: ['daily', 'weekly', 'monthly'],
      trim: true,
    },
    // Q4: consultation modes this slot offers (absent/empty = any mode, as before).
    serviceModes: [{ type: String, enum: ['chat', 'call', 'video', 'in-person'] }],
    // Q4/Q6: clinic branch the slot is held at (in-person consultations at a partner clinic).
    branchId: { type: String },
    // Q4: 'template' slots are generated from the doctor's weekly template; others were created by hand.
    source: { type: String, enum: ['manual', 'template'], default: 'manual' },
    // Q4: why the slot is not bookable (leave/template change); manual deactivation leaves this empty.
    closedReason: { type: String, enum: ['leave', 'template'] },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for better query performance
slotSchema.index({ specialistId: 1, date: 1, isAvailable: 1 });
slotSchema.index({ wellnessPackageId: 1, date: 1, isAvailable: 1 });
slotSchema.index({ slotType: 1, date: 1, isAvailable: 1 });
slotSchema.index({ date: 1, startTime: 1 });
slotSchema.index({ date: 1, isActive: 1 });
// Q4: one generated slot per doctor, date and start (manual legacy slots are not constrained).
slotSchema.index({ specialistId: 1, date: 1, startTime: 1 }, { unique: true, partialFilterExpression: { source: 'template' } });

// Virtual to check if slot is fully booked
slotSchema.virtual('isFullyBooked').get(function () {
  return (
    this.currentBookings !== undefined &&
    this.maxBookings !== undefined &&
    this.currentBookings >= this.maxBookings
  );
});

const SlotModel: Model<ISlot> = model<ISlot>('Slot', slotSchema);

export default SlotModel;
