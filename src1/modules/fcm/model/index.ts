import { Schema, model, Model } from 'mongoose';
import { IFcmToken } from '@/modules/fcm/types';

const fcmTokenSchema = new Schema<IFcmToken>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    userType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    token: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ['android', 'ios', 'web'],
      trim: true,
    },
    deviceId: {
      type: String,
      trim: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    lastUsedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

fcmTokenSchema.index({ userId: 1, isActive: 1 });
fcmTokenSchema.index({ userId: 1, platform: 1 });

const FcmTokenModel: Model<IFcmToken> = model<IFcmToken>(
  'FcmToken',
  fcmTokenSchema
);

export default FcmTokenModel;
