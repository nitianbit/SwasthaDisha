import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { OTPService } from '@/modules/otp/services';
import { CreateOTPRequest, VerifyOTPRequest } from '@/modules/otp/types';

export class OTPController {
  private otpService: OTPService;

  constructor() {
    this.otpService = Container.get(OTPService);
  }

  createOTP = async (req: Request, res: Response, _next: NextFunction) => {
    const { userId, otp, target, targetValue, expireAt } = req.body;

    const data: CreateOTPRequest = {
      userId,
      otp,
      target,
      targetValue,
      expireAt: expireAt ? new Date(expireAt) : undefined,
    };

    const result = await this.otpService.createOTP(data);

    res.status(201).json({
      success: true,
      message: 'OTP created successfully',
      data: {
        otp: result,
      },
    });
  };

  verifyOTP = async (req: Request, res: Response, _next: NextFunction) => {
    const { userId, otp, target } = req.body;

    const data: VerifyOTPRequest = {
      userId,
      otp,
      target,
    };

    const result = await this.otpService.verifyOTP(data);

    res.status(200).json({
      success: true,
      message: 'OTP verified successfully',
      data: {
        otp: result,
      },
    });
  };
}
