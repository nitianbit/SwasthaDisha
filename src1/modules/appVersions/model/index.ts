import { Schema, model, Model } from 'mongoose';
import {
  IAppVersionSettings,
  IPlatformVersionConfig,
} from '@/modules/appVersions/types';

const platformVersionConfigSchema = new Schema<IPlatformVersionConfig>(
  {
    softUpdateVersion: {
      type: String,
      required: true,
      trim: true,
    },
    hardUpdateVersion: {
      type: String,
      required: true,
      trim: true,
    },
    storeUrl: {
      type: String,
      required: true,
      trim: true,
    },
  },
  {
    _id: false,
  }
);

const appVersionSettingsSchema = new Schema<IAppVersionSettings>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'default',
      trim: true,
    },
    android: {
      type: platformVersionConfigSchema,
      required: true,
    },
    ios: {
      type: platformVersionConfigSchema,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

const AppVersionSettingsModel: Model<IAppVersionSettings> = model<IAppVersionSettings>(
  'AppVersionSettings',
  appVersionSettingsSchema
);

export default AppVersionSettingsModel;
