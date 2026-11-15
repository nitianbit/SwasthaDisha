import { model, Schema } from 'mongoose';

/**
 * O1: fixed-window counters for OTP sending and checking, shared by every API instance (MongoDB, atomic `$inc`).
 * A key never contains a phone number or email: identities are HMAC'd with a key derived from the server secret.
 * See `hit` in ../throttle for how calls are counted.
 */
export interface ThrottleRow { _id: string; count: number; expireAt: Date }
const schema = new Schema<ThrottleRow>({
  _id: { type: String, required: true },
  count: { type: Number, required: true },
  expireAt: { type: Date, required: true },
}, { collection: 'otp_throttles', versionKey: false, strict: 'throw', autoIndex: false, autoCreate: false });
schema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
export const OtpThrottleModel = model<ThrottleRow>('OtpThrottle', schema);

