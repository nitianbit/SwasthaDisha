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
    otp: {
      type: String,
      required: true,
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

const OTPModel: Model<IOTP> = model<IOTP>('OTP', otpSchema);

export default OTPModel;
