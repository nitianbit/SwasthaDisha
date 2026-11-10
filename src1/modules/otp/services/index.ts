import { Service } from 'typedi';
import { OTPRepository } from '@/modules/otp/repository';
import { IOTP, CreateOTPRequest, VerifyOTPRequest } from '@/modules/otp/types';
import { AppError } from '@/modules/common/types';

@Service()
export class OTPService {
  constructor(private otpRepository: OTPRepository) {}

  async createOTP(data: CreateOTPRequest): Promise<IOTP> {
    // Invalidate any existing unverified OTPs for this user and target
    const existingOTP = await this.otpRepository.findByUserIdAndTarget(
      data.userId,
      data.target,
      false,
      data.targetValue
    );

    if (existingOTP) {
      // Delete the existing OTP
      await this.otpRepository.delete({ _id: existingOTP._id });
    }

    // Create expiry date (10 minutes from now if not provided)
    const expireAt = data.expireAt || new Date(Date.now() + 10 * 60 * 1000);

    const otp = await this.otpRepository.save({
      userId: data.userId,
      otp: data.otp,
      target: data.target,
      targetValue: data.targetValue,
      expireAt,
      isVerified: false,
    });

    return otp;
  }

  async verifyOTP(data: VerifyOTPRequest): Promise<IOTP> {
    const otpRecord = await this.otpRepository.findByUserIdAndOTP(
      data.userId,
      data.otp,
      data.target,
      data.targetValue
    );

    if (!otpRecord) {
      throw new AppError({
        status: 404,
        code: 'OTP_NOT_FOUND',
        message: 'OTP not found',
      });
    }

    // Check if already verified
    if (otpRecord.isVerified) {
      throw new AppError({
        status: 400,
        code: 'OTP_ALREADY_VERIFIED',
        message: 'OTP has already been verified',
      });
    }

    // Check expiry
    if (
      !(otpRecord.expireAt instanceof Date) ||
      !Number.isFinite(otpRecord.expireAt.getTime()) ||
      otpRecord.expireAt <= new Date()
    ) {
      throw new AppError({
        status: 400,
        code: 'OTP_EXPIRED',
        message: 'OTP has expired',
      });
    }

    // Verify the OTP matches
    if (otpRecord.otp !== data.otp) {
      throw new AppError({
        status: 400,
        code: 'INVALID_OTP',
        message: 'Invalid OTP',
      });
    }

    if (
      typeof otpRecord.targetValue !== 'string' ||
      otpRecord.targetValue.trim() === '' ||
      (data.targetValue !== undefined && data.targetValue !== otpRecord.targetValue)
    ) {
      throw new AppError({
        status: 400,
        code: 'OTP_UNAVAILABLE',
        message: 'OTP is no longer available; request a new OTP',
      });
    }

    const observedExpiry = new Date(otpRecord.expireAt.getTime());
    const verifiedOTP = await this.otpRepository.markAsVerified(
      otpRecord._id!,
      { ...data, targetValue: otpRecord.targetValue },
      observedExpiry,
      new Date()
    );

    if (!verifiedOTP) {
      throw new AppError({
        status: 400,
        code: 'OTP_UNAVAILABLE',
        message: 'OTP is no longer available; request a new OTP',
      });
    }

    if (
      !(verifiedOTP.expireAt instanceof Date) ||
      !Number.isFinite(verifiedOTP.expireAt.getTime()) ||
      verifiedOTP.expireAt <= new Date()
    ) {
      throw new AppError({
        status: 400,
        code: 'OTP_EXPIRED',
        message: 'OTP has expired',
      });
    }

    return verifiedOTP;
  }

  async getLatestOTP(
    userId: string,
    target: 'phone' | 'email'
  ): Promise<IOTP | null> {
    return this.otpRepository.findByUserIdAndTarget(userId, target, false);
  }
}
