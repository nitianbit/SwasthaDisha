import { Service } from 'typedi';
import { AppVersionsRepository } from '@/modules/appVersions/repository';
import { AppError } from '@/modules/common/types';
import {
  IAppVersionSettings,
  IPlatformVersionConfig,
  UpdateAppVersionSettingsRequest,
} from '@/modules/appVersions/types';

const DEFAULT_SETTINGS: UpdateAppVersionSettingsRequest = {
  android: {
    softUpdateVersion: '0.0.0',
    hardUpdateVersion: '0.0.0',
    storeUrl: 'https://play.google.com/store/apps/details?id=com.nitianbit.MyEwaCare',
  },
  ios: {
    softUpdateVersion: '0.0.0',
    hardUpdateVersion: '0.0.0',
    storeUrl: 'https://apps.apple.com/in/app/myewacare/id6743497584',
  },
};

@Service()
export class AppVersionsService {
  constructor(private appVersionsRepository: AppVersionsRepository) {}

  private compareVersions(current: string, target: string): number {
    const currentParts = current.split('.').map(Number);
    const targetParts = target.split('.').map(Number);
    const maxLength = Math.max(currentParts.length, targetParts.length);

    for (let index = 0; index < maxLength; index += 1) {
      const currentValue = currentParts[index] || 0;
      const targetValue = targetParts[index] || 0;

      if (currentValue < targetValue) return -1;
      if (currentValue > targetValue) return 1;
    }

    return 0;
  }

  private validatePlatformConfig(
    platform: 'android' | 'ios',
    config: IPlatformVersionConfig
  ): void {
    if (this.compareVersions(config.hardUpdateVersion, config.softUpdateVersion) === 1) {
      throw new AppError({
        status: 400,
        code: 'INVALID_APP_VERSION_SETTINGS',
        message: `${platform} hard update version cannot be greater than soft update version`,
      });
    }
  }

  async getSettings(): Promise<IAppVersionSettings> {
    const settings = await this.appVersionsRepository.findSettings();

    if (settings) {
      return settings;
    }

    return this.appVersionsRepository.upsertSettings(DEFAULT_SETTINGS);
  }

  async updateSettings(
    payload: UpdateAppVersionSettingsRequest
  ): Promise<IAppVersionSettings> {
    this.validatePlatformConfig('android', payload.android);
    this.validatePlatformConfig('ios', payload.ios);

    return this.appVersionsRepository.upsertSettings(payload);
  }
}
