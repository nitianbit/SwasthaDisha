export interface IPlatformVersionConfig {
  softUpdateVersion: string;
  hardUpdateVersion: string;
  storeUrl: string;
}

export interface IAppVersionSettings {
  _id?: string;
  key: string;
  android: IPlatformVersionConfig;
  ios: IPlatformVersionConfig;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface UpdateAppVersionSettingsRequest {
  android: IPlatformVersionConfig;
  ios: IPlatformVersionConfig;
}
