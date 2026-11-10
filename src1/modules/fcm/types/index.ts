export type DevicePlatform = 'android' | 'ios' | 'web';

export interface IFcmToken {
  _id?: string;
  userId: string;
  userType: string;
  token: string;
  platform?: DevicePlatform;
  deviceId?: string;
  isActive: boolean;
  lastUsedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface SaveFcmTokenRequest {
  token: string;
  platform?: DevicePlatform;
  deviceId?: string;
}
