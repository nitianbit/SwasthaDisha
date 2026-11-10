import { Service } from 'typedi';
import { Model } from 'mongoose';
import AppVersionSettingsModel from '@/modules/appVersions/model';
import { BaseRepository } from '@/modules/common/repository';
import {
  IAppVersionSettings,
  UpdateAppVersionSettingsRequest,
} from '@/modules/appVersions/types';

const DEFAULT_KEY = 'default';

@Service()
export class AppVersionsRepository extends BaseRepository<IAppVersionSettings> {
  constructor() {
    super(AppVersionSettingsModel as Model<IAppVersionSettings>);
  }

  async findSettings(): Promise<IAppVersionSettings | null> {
    return this.findOne({ key: DEFAULT_KEY });
  }

  async upsertSettings(
    payload: UpdateAppVersionSettingsRequest
  ): Promise<IAppVersionSettings> {
    const result = await AppVersionSettingsModel.findOneAndUpdate(
      { key: DEFAULT_KEY },
      {
        $set: {
          android: payload.android,
          ios: payload.ios,
        },
        $setOnInsert: {
          key: DEFAULT_KEY,
        },
      },
      {
        new: true,
        upsert: true,
      }
    ).lean();

    return result as IAppVersionSettings;
  }
}
