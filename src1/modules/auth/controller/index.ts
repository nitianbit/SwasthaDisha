import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AuthService } from '@/modules/auth/services';
import { SendOTPRequest, VerifyOTPRequest } from '@/modules/auth/types';
import { AdminRepository } from '@/modules/admin/repository';
import { HRRepository } from '@/modules/hr/repository';
import { UserRepository } from '@/modules/user/repository';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { AuthRequest } from '@/modules/middleware/auth';

export class AuthController {
  private authService: AuthService;
  private userRepository: UserRepository;
  private adminRepository: AdminRepository;
  private hrRepository: HRRepository;
  private specialistRepository: SpecialistRepository;
  private pharmacyRepository: PharmacyRepository;

  constructor() {
    this.authService = Container.get(AuthService);
    this.userRepository = Container.get(UserRepository);
    this.adminRepository = Container.get(AdminRepository);
    this.hrRepository = Container.get(HRRepository);
    this.specialistRepository = Container.get(SpecialistRepository);
    this.pharmacyRepository = Container.get(PharmacyRepository);
  }

  sendOTP = async (req: Request, res: Response, _next: NextFunction) => {
    const { userType } = req.params;
    const { phone, email } = req.body;

    const data: SendOTPRequest = {
      userType: userType as SendOTPRequest['userType'],
      phone,
      email,
    };

    const result = await this.authService.sendOTP(data);

    res.status(200).json({
      success: true,
      message: result.message,
    });
  };

  verifyOTP = async (req: Request, res: Response, _next: NextFunction) => {
    const { userType } = req.params;
    const { phone, email, otp } = req.body;

    const data: VerifyOTPRequest = {
      userType: userType as VerifyOTPRequest['userType'],
      phone,
      email,
      otp,
    };

    const result = await this.authService.verifyOTP(data);

    return res.status(200).json({
      success: true,
      message: result.message,
      data: {
        token: result.accessToken,
        user: result.userData,
      },
    });
  };

  getProfile = async (req: Request, res: Response, _next: NextFunction) => {
    const authUser = (req as AuthRequest).user;
    if (!authUser?._id) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
      });
    }

    if (authUser.userType === 'admin') {
      const user = await this.adminRepository.findById(authUser._id);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
        });
      }
      return res.status(200).json({
        success: true,
        message: 'Profile retrieved successfully',
        data: { user, userRole: authUser.userType },
      });
    }

    if (authUser.userType === 'specialist') {
      const sid = authUser.specialistId || authUser._id;
      const specialist = await this.specialistRepository.findById(sid);
      if (!specialist) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
        });
      }
      return res.status(200).json({
        success: true,
        message: 'Profile retrieved successfully',
        data: { user: specialist, userRole: authUser.userType },
      });
    }

    if (authUser.userType === 'hr') {
      const hr = await this.hrRepository.findById(authUser._id);
      if (!hr) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
        });
      }
      return res.status(200).json({
        success: true,
        message: 'Profile retrieved successfully',
        data: { user: hr, userRole: authUser.userType },
      });
    }

    if (authUser.userType === 'pharmacy') {
      const pharmacyId = authUser.pharmacyId || authUser._id;
      const pharmacy = await this.pharmacyRepository.findById(pharmacyId);
      if (!pharmacy) {
        return res.status(401).json({
          success: false,
          message: 'Pharmacy not found',
        });
      }
      return res.status(200).json({
        success: true,
        message: 'Profile retrieved successfully',
        data: { user: pharmacy, userRole: 'pharmacy' },
      });
    }

    const user = await this.userRepository.findById(authUser._id);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Profile retrieved successfully',
      data: { user, userRole: authUser.userType },
    });
  };

  sendEmailVerificationOTP = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const userId = req.user?._id;
    const { email, isCorporateUser } = req.body;

    const result = await this.authService.sendEmailVerificationOTP(userId!, {
      email,
      isCorporateUser,
    });

    return res.status(200).json({
      success: true,
      message: result.message,
    });
  };

  verifyEmailVerificationOTP = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const userId = req.user?._id;
    const { otp, email, isCorporateUser } = req.body;

    const result = await this.authService.verifyEmailVerificationOTP(userId!, {
      otp,
      email,
      isCorporateUser,
    });

    return res.status(200).json({
      success: true,
      message: result.message,
      data: {
        token: result.accessToken,
        user: result.user,
      },
    });
  };

  sendCorporateEmailVerificationOTP = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const userId = req.user?._id;
    const { corporateEmail } = req.body;

    const result = await this.authService.sendCorporateEmailVerificationOTP(
      userId!,
      { corporateEmail }
    );

    return res.status(200).json({
      success: true,
      message: result.message,
    });
  };

  verifyCorporateEmailVerificationOTP = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const userId = req.user?._id;
    const { otp, corporateEmail } = req.body;

    const result = await this.authService.verifyCorporateEmailVerificationOTP(
      userId!,
      { otp, corporateEmail }
    );

    return res.status(200).json({
      success: true,
      message: result.message,
      data: {
        token: result.accessToken,
        user: result.user,
      },
    });
  };
}
