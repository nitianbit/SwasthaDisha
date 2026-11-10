import { randomInt } from 'node:crypto';
import { CONFIG } from '@/config/config';
import {
  SendCorporateEmailVerificationOTPRequest,
  SendEmailVerificationOTPRequest,
  SendOTPRequest,
  VerifyCorporateEmailVerificationOTPRequest,
  VerifyEmailVerificationOTPRequest,
  VerifyOTPRequest,
} from '@/modules/auth/types';
import { CorporateRepository } from '@/modules/corporates/repository';
import { AppError } from '@/modules/common/types';
import { OTPService } from '@/modules/otp/services';
import { AdminRepository } from '@/modules/admin/repository';
import { IAdmin } from '@/modules/admin/types';
import { HRRepository } from '@/modules/hr/repository';
import { IHR } from '@/modules/hr/types';
import { UserRepository } from '@/modules/user/repository';
import { IUser } from '@/modules/user/types';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { ISpecialist } from '@/modules/specialists/types';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { IPharmacy } from '@/modules/pharmacies/types';
import { WalletService } from '@/modules/wallet/services';
import { NotificationService } from '@/modules/notification/services';
import { EmailService } from '@/modules/email/services';
import { SMSService } from '@/modules/sms/services';
import jwt from 'jsonwebtoken';
import { Service } from 'typedi';

@Service()
export class AuthService {
  constructor(
    private userRepository: UserRepository,
    private adminRepository: AdminRepository,
    private hrRepository: HRRepository,
    private specialistRepository: SpecialistRepository,
    private pharmacyRepository: PharmacyRepository,
    private corporateRepository: CorporateRepository,
    private otpService: OTPService,
    private walletService: WalletService,
    private notificationService: NotificationService,
    private emailService: EmailService,
    private smsService: SMSService
  ) {}

  private normalizeEmail(email?: string): string | undefined {
    return email?.trim().toLowerCase();
  }

  private async ensureEmailAvailableAcrossUserFields(
    email: string,
    excludeUserId?: string
  ): Promise<void> {
    const existingUser = await this.userRepository.findByAnyEmail(
      email,
      'user',
      excludeUserId
    );

    if (existingUser) {
      throw new AppError({
        status: 400,
        code: 'EMAIL_ALREADY_IN_USE',
        message: 'Email is already in use by another user',
      });
    }
  }

  private buildSpecialistSignupPayload(data: SendOTPRequest): ISpecialist {
    const normalizedEmail = data.email?.trim().toLowerCase();
    const normalizedPhone = data.phone?.trim();

    return {
      name: 'demoName',
      phone: normalizedPhone,
      email: normalizedEmail,
      isActive: true,
      isVerified: false,
    };
  }

  private buildPharmacySignupPayload(data: SendOTPRequest): IPharmacy {
    const normalizedEmail = data.email?.trim().toLowerCase();
    const normalizedPhone = data.phone?.trim();

    return {
      name: 'Demo',
      phone: normalizedPhone!,
      email: normalizedEmail,
      isActive: true,
      isVerified: false,
      walletEnabled: false,
      pickupAvailable: false,
      deliveryAvailable: false,
    };
  }

  async sendOTP(data: SendOTPRequest): Promise<{ message: string }> {
    // Generate OTP (example - implement your OTP generation logic)
    const otp = randomInt(100000, 1000000).toString();

    // Find identity record based on userType
    let userRecord: IUser | IAdmin | ISpecialist | IHR | IPharmacy | null;
    if (data.userType === 'admin') {
      userRecord = await this.adminRepository.findByPhoneOrEmail({
        phone: data.phone,
        email: data.email,
      });
    } else if (data.userType === 'hr') {
      userRecord = await this.hrRepository.findByPhoneOrEmail({
        phone: data.phone,
        email: data.email,
      });
    } else if (data.userType === 'specialist') {
      userRecord = await this.specialistRepository.findByPhoneOrEmail({
        phone: data.phone,
        email: data.email,
      });
    } else if (data.userType === 'pharmacy') {
      userRecord = data.phone
        ? await this.pharmacyRepository.findByPhone(data.phone)
        : await this.pharmacyRepository.findByEmail(data.email!);
    } else {
      userRecord = await this.userRepository.findByPhoneOrEmail(
        { phone: data.phone, email: data.email },
        'user'
      );
    }

    let userId: string;
    if (!userRecord) {
      if (data.userType === 'admin') {
        throw new AppError({
          status: 404,
          code: 'ADMIN_NOT_FOUND',
          message: 'Admin not found',
        });
      }
      if (data.userType === 'hr') {
        throw new AppError({
          status: 404,
          code: 'HR_NOT_FOUND',
          message: 'HR not found',
        });
      }
      if (data.userType === 'pharmacy') {
        const newPharmacy = await this.pharmacyRepository.save(
          this.buildPharmacySignupPayload(data)
        );
        userId = newPharmacy._id!;
      } else if (data.userType === 'specialist') {
        const newSpecialist = await this.specialistRepository.save(
          this.buildSpecialistSignupPayload(data)
        );
        userId = newSpecialist._id!;
      }
      else {
        const newUser = await this.userRepository.save({
          phone: data.phone,
          email: data.email,
          userType: 'user',
          createdSource: 'self_signup',
          otpVerified: false,
        });
        userId = newUser._id!;
      }
    } else {
      if (data.userType === 'admin' && userRecord.isActive === false) {
        throw new AppError({
          status: 403,
          code: 'ADMIN_INACTIVE',
          message: 'Admin account is inactive',
        });
      }
      if (
        data.userType === 'specialist' &&
        (userRecord as ISpecialist).isActive === false
      ) {
        throw new AppError({
          status: 403,
          code: 'SPECIALIST_INACTIVE',
          message: 'Specialist account is inactive',
        });
      }
      if (data.userType === 'hr' && (userRecord as IHR).isActive === false) {
        throw new AppError({
          status: 403,
          code: 'HR_INACTIVE',
          message: 'HR account is inactive',
        });
      }
      if (data.userType === 'pharmacy' && (userRecord as IPharmacy).isActive === false) {
        throw new AppError({
          status: 403,
          code: 'PHARMACY_INACTIVE',
          message: 'Pharmacy account is inactive',
        });
      }
      userId = userRecord._id!;
    }

    // Create OTP record using OTP service
    const target = data.phone ? 'phone' : 'email';
    const targetValue = data.phone?.trim() || data.email?.trim().toLowerCase();
    await this.otpService.createOTP({
      userId,
      otp,
      target,
      targetValue,
    });

    const expiryMinutes = CONFIG.OTP_EXPIRY_MINUTES;
    if (target === 'phone' && data.phone) {
      const smsContent = this.smsService.buildSMSContent('otp', {
        otp,
        expiryMinutes,
      });
      await this.smsService.sendSMS({
        to: data.phone,
        text: smsContent.text,
        templateId: smsContent.templateId,
      });
    } else if (target === 'email' && data.email) {
      const normalizedEmail = data.email.trim().toLowerCase();
      await this.emailService.sendEmail({
        to: [normalizedEmail],
        subject: 'MyEwaCare OTP Verification',
        textBody: `Your OTP for verification on MyEwaCare is ${otp}. This OTP is valid for ${expiryMinutes} minutes. Do not share this OTP with anyone.`,
      });
    }

    return { message: 'OTP sent successfully' };
  }

  verifyOTP = async (data: VerifyOTPRequest): Promise<{
    message: string;
    accessToken: string;
    userData: {
      _id: string;
      phone?: string;
      email?: string;
      corporateId?: string;
      specialistId?: string;
      pharmacyId?: string;
      userType: string;
    }
  }> => {
    // Find identity record based on userType
    let userRecord: IUser | IAdmin | ISpecialist | IHR | IPharmacy | null;
    if (data.userType === 'admin') {
      userRecord = await this.adminRepository.findByPhoneOrEmail({
        phone: data.phone,
        email: data.email,
      });
    } else if (data.userType === 'hr') {
      userRecord = await this.hrRepository.findByPhoneOrEmail({
        phone: data.phone,
        email: data.email,
      });
    } else if (data.userType === 'specialist') {
      userRecord = await this.specialistRepository.findByPhoneOrEmail({
        phone: data.phone,
        email: data.email,
      });
    } else if (data.userType === 'pharmacy') {
      userRecord = data.phone
        ? await this.pharmacyRepository.findByPhone(data.phone)
        : await this.pharmacyRepository.findByEmail(data.email!);
    } else {
      userRecord = await this.userRepository.findByPhoneOrEmail(
        { phone: data.phone, email: data.email },
        'user'
      );
    }

    if (!userRecord) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    if (
      'userType' in userRecord &&
      userRecord.userType === 'admin' &&
      userRecord.isActive === false
    ) {
      throw new AppError({
        status: 403,
        code: 'ADMIN_INACTIVE',
        message: 'Admin account is inactive',
      });
    }

    if (
      data.userType === 'specialist' &&
      (userRecord as ISpecialist).isActive === false
    ) {
      throw new AppError({
        status: 403,
        code: 'SPECIALIST_INACTIVE',
        message: 'Specialist account is inactive',
      });
    }
    if (data.userType === 'hr' && (userRecord as IHR).isActive === false) {
      throw new AppError({
        status: 403,
        code: 'HR_INACTIVE',
        message: 'HR account is inactive',
      });
    }
    if (data.userType === 'pharmacy' && (userRecord as IPharmacy).isActive === false) {
      throw new AppError({
        status: 403,
        code: 'PHARMACY_INACTIVE',
        message: 'Pharmacy account is inactive',
      });
    }

    // Verify OTP using OTP service
    const target = data.phone ? 'phone' : 'email';
    await this.otpService.verifyOTP({
      userId: userRecord._id!,
      otp: data.otp,
      target,
    });

    // Create wallet for regular users (not admins) if it doesn't exist
    // getByUserId will auto-create the wallet if it doesn't exist
    if (
      'userType' in userRecord &&
      userRecord.userType === 'user'
    ) {
      await this.userRepository.update(
        { _id: userRecord._id! },
        { otpVerified: true, isVerified: true }
      );
      await this.walletService.getByUserId(userRecord._id!);
    }

    // Create login notification
    try {
      if ('userType' in userRecord && userRecord.userType === 'user') {
        await this.notificationService.createLoginNotification(userRecord._id!);
      } else if (data.userType === 'specialist') {
        await this.notificationService.createSpecialistLoginNotification(
          userRecord._id!
        );
      }
    } catch (error) {
      // Don't fail login if notification creation fails
      console.error('Failed to create login notification:', error);
    }

    const id = userRecord._id!;
    let tokenPayload: {
      _id: string;
      phone?: string;
      email?: string;
      corporateId?: string;
      specialistId?: string;
      pharmacyId?: string;
      userType: string;
    };

    if (data.userType === 'pharmacy') {
      const pharmacy = userRecord as IPharmacy;
      tokenPayload = {
        _id: id,
        pharmacyId: id,
        phone: pharmacy.phone,
        email: pharmacy.email,
        userType: 'pharmacy',
      };
    } else if (data.userType === 'specialist') {
      tokenPayload = {
        _id: id,
        specialistId: id,
        phone: userRecord.phone,
        email: userRecord.email,
        userType: 'specialist',
      };
    } else if (data.userType === 'hr') {
      const hr = userRecord as IHR;
      tokenPayload = {
        _id: id,
        phone: hr.phone,
        email: hr.email,
        ...(hr.corporateId ? { corporateId: hr.corporateId } : {}),
        userType: 'hr',
      };
    } else if (
      'userType' in userRecord &&
      userRecord.userType === 'admin'
    ) {
      tokenPayload = {
        _id: id,
        phone: userRecord.phone,
        email: userRecord.email,
        userType: 'admin',
      };
    } else {
      const u = userRecord as IUser;
      tokenPayload = {
        _id: id,
        phone: u.phone,
        email: u.email,
        ...(u.corporateId ? { corporateId: u.corporateId } : {}),
        userType: 'user',
      };
    }

    const accessToken = jwt.sign(tokenPayload, CONFIG.JWT_SECRET_KEY, {
      expiresIn: '30d', // Token expires in 30 days
    });

    return {
      message: 'OTP verified successfully',
      accessToken,
      userData: tokenPayload,
    };
  };

  async sendEmailVerificationOTP(
    userId: string,
    data: SendEmailVerificationOTPRequest
  ): Promise<{ message: string }> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    const normalizedEmail = this.normalizeEmail(data.email)!;
    await this.ensureEmailAvailableAcrossUserFields(normalizedEmail, userId);

    if (data.isCorporateUser) {
      if (user.corporateId) {
        await this.verifyEmailDomain(normalizedEmail, user.corporateId);
      } else {
        const emailDomain = normalizedEmail.split('@')[1]?.toLowerCase();

        if (emailDomain) {
          const corporate = await this.corporateRepository.findOne({
            domain: emailDomain,
            isActive: true,
          } as any);

          if (!corporate) {
            throw new AppError({
              status: 400,
              code: 'CORPORATE_NOT_FOUND',
              message: `No corporate found for domain`,
            });
          }
        }
      }
    }

    const otp = randomInt(100000, 1000000).toString();
    await this.otpService.createOTP({
      userId,
      otp,
      target: 'email',
      targetValue: normalizedEmail,
    });

    await this.emailService.sendEmail({
      to: [normalizedEmail],
      subject: 'Email Verification OTP',
      textBody: `Your OTP for email verification on MyEwaCare is ${otp}. This OTP is valid for ${CONFIG.OTP_EXPIRY_MINUTES} minutes. Do not share this OTP with anyone.`,
    });

    return { message: 'Email verification OTP sent successfully' };
  }

  async verifyEmailVerificationOTP(
    userId: string,
    data: VerifyEmailVerificationOTPRequest
  ): Promise<{ message: string; user: Partial<IUser>; accessToken: string }> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    const normalizedEmail = this.normalizeEmail(data.email);
    const verifiedOTP = await this.otpService.verifyOTP({
      userId,
      otp: data.otp,
      target: 'email',
      targetValue: normalizedEmail,
    });

    const verifiedEmail = verifiedOTP.targetValue?.trim().toLowerCase();
    if (!verifiedEmail) {
      throw new AppError({
        status: 400,
        code: 'EMAIL_VERIFICATION_NOT_INITIATED',
        message: 'Please request email verification OTP first',
      });
    }

    let corporateIdToSet = user.corporateId;

    if (data.isCorporateUser) {
      // Apply corporate domain check for users already linked to a corporate profile
      if (user.corporateId) {
        await this.verifyEmailDomain(verifiedEmail, user.corporateId);
      } else {
        const emailDomain = verifiedEmail.split('@')[1]?.toLowerCase();
        if (emailDomain) {
          const corporate = await this.corporateRepository.findOne({
            domain: emailDomain,
            isActive: true,
          } as any);

          if (!corporate) {
            throw new AppError({
              status: 400,
              code: 'CORPORATE_NOT_FOUND',
              message: `No corporate found for domain`,
            });
          }

          if (corporate._id) {
            corporateIdToSet = corporate._id.toString();
          }
        }
      }
    }

    await this.ensureEmailAvailableAcrossUserFields(verifiedEmail, userId);

    const updateData: any = {
      email: verifiedEmail,
      isVerified: true,
    };
    if (data.isCorporateUser) {
      updateData.corporateEmail = verifiedEmail;
      updateData.isCorporateEmailVerified = true;
    }
    if (corporateIdToSet) {
      updateData.corporateId = corporateIdToSet;
    }

    const updatedUser = await this.userRepository.update(
      { _id: userId } as any,
      updateData
    );

    if (!updatedUser) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update user email',
      });
    }

    const tokenPayload = {
      _id: updatedUser._id!,
      phone: updatedUser.phone,
      email: updatedUser.email,
      ...(updatedUser.corporateId && { corporateId: updatedUser.corporateId }),
      userType: updatedUser.userType!,
    };

    const accessToken = jwt.sign(tokenPayload, CONFIG.JWT_SECRET_KEY, {
      expiresIn: '30d',
    });

    return {
      message: 'Email verified successfully',
      accessToken,
      user: updatedUser,
    };
  }

  async sendCorporateEmailVerificationOTP(
    userId: string,
    data: SendCorporateEmailVerificationOTPRequest
  ): Promise<{ message: string }> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    const normalizedEmail = this.normalizeEmail(data.corporateEmail)!;
    if (normalizedEmail === this.normalizeEmail(user.email)) {
      throw new AppError({
        status: 400,
        code: 'EMAILS_MUST_DIFFER',
        message: 'Personal email and corporate email must be different',
      });
    }

    await this.ensureEmailAvailableAcrossUserFields(normalizedEmail, userId);

    const emailDomain = normalizedEmail.split('@')[1]?.toLowerCase();
    if (!emailDomain) {
      throw new AppError({
        status: 400,
        code: 'INVALID_CORPORATE_EMAIL',
        message: 'Corporate email must be valid',
      });
    }

    const corporate = await this.corporateRepository.findOne({
      domain: emailDomain,
      isActive: true,
    } as any);

    if (!corporate) {
      throw new AppError({
        status: 400,
        code: 'CORPORATE_NOT_FOUND',
        message: 'No corporate found for domain',
      });
    }

    const otp = randomInt(100000, 1000000).toString();
    await this.otpService.createOTP({
      userId,
      otp,
      target: 'email',
      targetValue: normalizedEmail,
    });

    await this.emailService.sendEmail({
      to: [normalizedEmail],
      subject: 'Corporate Email Verification OTP',
      textBody: `Your OTP for corporate email verification on MyEwaCare is ${otp}. This OTP is valid for ${CONFIG.OTP_EXPIRY_MINUTES} minutes. Do not share this OTP with anyone.`,
    });

    return { message: 'Corporate email verification OTP sent successfully' };
  }

  async verifyCorporateEmailVerificationOTP(
    userId: string,
    data: VerifyCorporateEmailVerificationOTPRequest
  ): Promise<{ message: string; user: Partial<IUser>; accessToken: string }> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    const normalizedEmail = this.normalizeEmail(data.corporateEmail);
    const verifiedOTP = await this.otpService.verifyOTP({
      userId,
      otp: data.otp,
      target: 'email',
      targetValue: normalizedEmail,
    });

    const verifiedCorporateEmail = this.normalizeEmail(verifiedOTP.targetValue);
    if (!verifiedCorporateEmail) {
      throw new AppError({
        status: 400,
        code: 'CORPORATE_EMAIL_VERIFICATION_NOT_INITIATED',
        message: 'Please request corporate email verification OTP first',
      });
    }

    if (verifiedCorporateEmail === this.normalizeEmail(user.email)) {
      throw new AppError({
        status: 400,
        code: 'EMAILS_MUST_DIFFER',
        message: 'Personal email and corporate email must be different',
      });
    }

    await this.ensureEmailAvailableAcrossUserFields(
      verifiedCorporateEmail,
      userId
    );

    const emailDomain = verifiedCorporateEmail.split('@')[1]?.toLowerCase();
    const corporate = emailDomain
      ? await this.corporateRepository.findOne({
          domain: emailDomain,
          isActive: true,
        } as any)
      : null;

    if (!corporate || !corporate._id) {
      throw new AppError({
        status: 400,
        code: 'CORPORATE_NOT_FOUND',
        message: 'No corporate found for domain',
      });
    }

    const updatedUser = await this.userRepository.update(
      { _id: userId } as any,
      {
        corporateEmail: verifiedCorporateEmail,
        isCorporateEmailVerified: true,
        corporateId: corporate._id.toString(),
      } as any
    );

    if (!updatedUser) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update corporate email',
      });
    }

    const tokenPayload = {
      _id: updatedUser._id!,
      phone: updatedUser.phone,
      email: updatedUser.email,
      ...(updatedUser.corporateId && { corporateId: updatedUser.corporateId }),
      userType: updatedUser.userType!,
    };

    const accessToken = jwt.sign(tokenPayload, CONFIG.JWT_SECRET_KEY, {
      expiresIn: '30d',
    });

    return {
      message: 'Corporate email verified successfully',
      accessToken,
      user: updatedUser,
    };
  }

  private async verifyEmailDomain(email: string, corporateId?: string): Promise<void> {
    if (!corporateId) return;

    const corporate = await this.corporateRepository.findById(corporateId);
    if (!corporate || !corporate.domain) return;

    const emailDomain = email.split('@')[1]?.toLowerCase();
    if (emailDomain !== corporate.domain.toLowerCase()) {
      throw new AppError({
        status: 400,
        code: 'EMAIL_DOMAIN_MISMATCH',
        message: `Email domain does not match corporate domain. Expected @${corporate.domain}`,
      });
    }
  }
}
