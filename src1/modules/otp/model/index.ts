import { Schema, model, Model } from 'mongoose';
import { IOTP } from '@/modules/otp/types';

const otpSchema = new Schema<IOTP>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    } as any,
    // Legacy rows only (created before O1): the code in plain text. New rows store `otpHash` instead.
    otp: {
      type: String,
    },
    // O1: HMAC of the code bound to the user and destination; the code itself is never stored.
    otpHash: {
      type: String,
    },
    // O1: checks made against this code (right or wrong); at OTP_MAX_ATTEMPTS the code is burnt.
    attempts: {
      type: Number,
      default: 0,
    },
    target: {
      type: String,
      enum: ['phone', 'email'],
      required: true,
    },
    targetValue: {
      type: String,
      trim: true,
      lowercase: true,
    },
    expireAt: {
      type: Date,
      default: () => new Date(Date.now() + 10 * 60 * 1000), // 10 minutes from now
      required: true,
      index: { expireAfterSeconds: 0 }, // TTL index for automatic deletion
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    collection: 'OTP',
  }
);

// Compound index for efficient queries
otpSchema.index({ userId: 1, target: 1, isVerified: 1 });
otpSchema.index({ userId: 1, otp: 1 });
// O1: the latest pending code of one destination.
otpSchema.index({ userId: 1, target: 1, targetValue: 1, isVerified: 1, _id: -1 });

const OTPModel: Model<IOTP> = model<IOTP>('OTP', otpSchema);

export default OTPModel;
