import { Schema, model, Model } from 'mongoose';

/**
 * Assisted booking (design §5.7, P3): a coupon used on a partner-paid booking is counted here, keyed to the PATIENT
 * account whoever pays, written in the booking transaction (with the guarded `currentUsageCount` increment) and
 * reversed once in the cancellation transaction. Partner-paid bookings never use the payment-record counting of
 * coupon/usage.ts.
 */
export interface ICouponRedemption {
  couponCode: string;
  patientUserId: string;
  dependentId?: string;
  bookingKind: 'booking' | 'lab_booking' | 'instant_request';
  bookingId: string;
  payerKind: 'pharmacy' | 'lab' | 'doctor';
  payerId: string;
  discountMinor: number;
  state: 'counted' | 'reversed';
  at: Date;
  reversedAt?: Date;
}

const redemptionSchema = new Schema<ICouponRedemption>({
  couponCode: { type: String, required: true, uppercase: true, trim: true },
  patientUserId: { type: String, required: true },
  dependentId: { type: String },
  bookingKind: { type: String, required: true, enum: ['booking', 'lab_booking', 'instant_request'] },
  bookingId: { type: String, required: true },
  payerKind: { type: String, required: true, enum: ['pharmacy', 'lab', 'doctor'] },
  payerId: { type: String, required: true },
  discountMinor: { type: Number, required: true, min: 0 },
  state: { type: String, required: true, enum: ['counted', 'reversed'] },
  at: { type: Date, required: true },
  reversedAt: { type: Date },
}, { versionKey: false, strict: 'throw' });
redemptionSchema.index({ couponCode: 1, bookingKind: 1, bookingId: 1 }, { unique: true });
// The patient's own per-user count (coupon/repository countUserCouponUsage) adds these rows.
redemptionSchema.index({ patientUserId: 1, couponCode: 1, state: 1 });

export const CouponRedemptionModel: Model<ICouponRedemption> = model<ICouponRedemption>('CouponRedemption', redemptionSchema, 'coupon_redemptions');
export default CouponRedemptionModel;
