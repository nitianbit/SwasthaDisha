import { Schema, model, Model } from 'mongoose';

/**
 * Phase 3d (ASSISTED_BOOKING_DESIGN.md §5.6, §25.7.1): the tests a doctor recommended in a consultation's prescription,
 * with the code printed on the prescription PDF. One per consultation; the code stays the same when the doctor saves
 * the prescription again (DR11).
 *
 * The person (account and family member) is NOT stored: it is always read from the consultation, so an admin move of
 * the booking (§17.5) moves the recommendation with it.
 *
 * `bookings` is the seam for linking lab bookings to the recommendation (DR16, §25.7.5). No writer exists yet: linking
 * needs rounds 2b, 2c and 3b. Until then `status` is only `open` (r16b: a prescription saved without tests simply
 * carries no code, R3).
 */
export type RecommendationStatus = 'open' | 'partly_booked' | 'booked';

export interface ITestRecommendation {
  _id?: string;
  code: string;
  consultationId: string;
  specialistId: string;
  items: { index: number; name: string }[];
  status: RecommendationStatus;
  bookings: { labBookingId: string; itemIndexes: number[]; byKind: 'customer' | 'pharmacy' | 'lab_desk' | 'doctor'; at: Date; cancelled?: boolean }[];
  version: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const recommendationSchema = new Schema<ITestRecommendation>({
  code: { type: String, required: true },
  consultationId: { type: String, required: true },
  specialistId: { type: String, required: true },
  items: {
    type: [new Schema({ index: { type: Number, required: true, min: 0 }, name: { type: String, required: true, trim: true } }, { _id: false })],
    default: [],
  },
  status: { type: String, required: true, enum: ['open', 'partly_booked', 'booked'] },
  bookings: {
    type: [new Schema({
      labBookingId: { type: String, required: true },
      itemIndexes: { type: [Number], default: [] },
      byKind: { type: String, required: true, enum: ['customer', 'pharmacy', 'lab_desk', 'doctor'] },
      at: { type: Date, required: true },
      cancelled: { type: Boolean },
    }, { _id: false })],
    default: [],
  },
  version: { type: Number, required: true, default: 0 },
}, { timestamps: true, versionKey: false, strict: 'throw' });

recommendationSchema.index({ code: 1 }, { unique: true });
recommendationSchema.index({ consultationId: 1 }, { unique: true });

export const TestRecommendationModel: Model<ITestRecommendation> = model<ITestRecommendation>(
  'TestRecommendation', recommendationSchema, 'test_recommendations');

export default TestRecommendationModel;
