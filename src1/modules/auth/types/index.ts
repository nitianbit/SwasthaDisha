import { IAdmin } from '@/modules/admin/types';
import { IHR } from '@/modules/hr/types';
import { IUser } from '@/modules/user/types';

export type IAuth = IUser | IAdmin | IHR;

export interface SendOTPRequest {
  userType: 'user' | 'admin' | 'specialist' | 'hr' | 'pharmacy';
  phone?: string;
  email?: string;
}

export interface VerifyOTPRequest {
  userType: 'user' | 'admin' | 'specialist' | 'hr' | 'pharmacy';
  phone?: string;
  email?: string;
  otp: string;
}

export interface SendEmailVerificationOTPRequest {
  email: string;
  isCorporateUser?: boolean;
}

export interface VerifyEmailVerificationOTPRequest {
  otp: string;
  email?: string;
  isCorporateUser?: boolean;
}

export interface SendCorporateEmailVerificationOTPRequest {
  corporateEmail: string;
}

export interface VerifyCorporateEmailVerificationOTPRequest {
  otp: string;
  corporateEmail?: string;
}
