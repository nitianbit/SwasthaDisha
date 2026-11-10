export interface IOTP {
  _id?: string;
  userId: string; // Reference to User
  otp: string;
  target: 'phone' | 'email';
  targetValue?: string;
  createdAt?: Date;
  expireAt: Date;
  isVerified: boolean;
}

export interface CreateOTPRequest {
  userId: string;
  otp: string;
  target: 'phone' | 'email';
  targetValue?: string;
  expireAt?: Date;
}

export interface VerifyOTPRequest {
  userId: string;
  otp: string;
  target: 'phone' | 'email';
  targetValue?: string;
}
