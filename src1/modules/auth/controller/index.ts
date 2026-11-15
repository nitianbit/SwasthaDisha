import { hitClient } from '@/modules/otp/throttle';
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
import { MemberRepository } from '@/modules/partners/repository/member';
import { PartnerRepository } from '@/modules/partners/repository';
import { AuthRequest } from '@/modules/middleware/auth';
import { tokenCredentialVersion } from '@/modules/user/credentialGeneration';
import jwt from 'jsonwebtoken';
import { ACCESS_TOKEN_TTL_SECONDS, assertRoleForAudience, createNativeSession, createSession, logoutNativeSession, logoutSession,
  nativeAudience, privateTokenResponse, refreshNativeSession, refreshSession, reissueForCaller, revokeAllSessions,
  sessionAudience } from '@/modules/auth/sessions';

export class AuthController {
  private authService: AuthService;
  private userRepository: UserRepository;
  private adminRepository: AdminRepository;
  private hrRepository: HRRepository;
  private specialistRepository: SpecialistRepository;
  private pharmacyRepository: PharmacyRepository;
  private memberRepository: MemberRepository;
  private partnerRepository: PartnerRepository;

  constructor() {
    this.authService = Container.get(AuthService);
    this.userRepository = Container.get(UserRepository);
    this.adminRepository = Container.get(AdminRepository);
    this.hrRepository = Container.get(HRRepository);
    this.specialistRepository = Container.get(SpecialistRepository);
    this.pharmacyRepository = Container.get(PharmacyRepository);
    this.memberRepository = Container.get(MemberRepository);
    this.partnerRepository = Container.get(PartnerRepository);
  }

  sendOTP = async (req: Request, res: Response, _next: NextFunction) => {
    const { userType } = req.params;
    const { phone, email } = req.body;

    const data: SendOTPRequest = {
      userType: userType as SendOTPRequest['userType'],
      phone,
      email,
      partnerId: req.body.partnerId,
    };

    await hitClient('ip-send', req);
    const result = await this.authService.sendOTP(data);

    res.status(200).json({
      success: true,
      message: result.message,
    });
  };

  verifyOTP = async (req: Request, res: Response, _next: NextFunction) => {
    const { userType } = req.params;
    const { phone, email, otp } = req.body;
    // D4: decided (origin, header, audience, role) BEFORE the single-use OTP is consumed.
    const audience = req.body?.session === 'cookie' ? sessionAudience(req) : null;
    if (audience) assertRoleForAudience(audience, String(userType));
    // N1: likewise for the phone app (header, JSON, app and role) before the OTP is consumed.
    const native = req.body?.session === 'native' ? nativeAudience(req) : null;
    if (native) assertRoleForAudience(native, String(userType));

    const data: VerifyOTPRequest = {
      userType: userType as VerifyOTPRequest['userType'],
      phone,
      email,
      otp,
      partnerId: req.body.partnerId,
    };

    await hitClient('ip-verify', req);
    const result = await this.authService.verifyOTP(data);
    if (result.selection) {
      // Q7: the phone is proven but the person has several workspaces: no session yet, a one-use ticket to choose.
      privateTokenResponse(res);
      return res.status(200).json({ success: true, message: result.message, data: { selectionRequired: true, ...result.selection } });
    }
    return this.signedIn(res, req, result, audience, native);
  };

  /** Q7: the partner chosen after a multi-membership OTP sign-in; answered exactly like a verify (bearer, cookie or native). */
  selectPartner = async (req: Request, res: Response, _next: NextFunction) => {
    const audience = req.body?.session === 'cookie' ? sessionAudience(req) : null;
    if (audience) assertRoleForAudience(audience, 'partner');
    const native = req.body?.session === 'native' ? nativeAudience(req) : null;
    if (native) assertRoleForAudience(native, 'partner');
    await hitClient('ip-verify', req);
    const result = await this.authService.selectPartner({ ticket: req.body.ticket, partnerId: req.body.partnerId });
    return this.signedIn(res, req, result, audience, native);
  };

  private async signedIn(res: Response, req: Request, result: { message: string; accessToken: string; userData: unknown },
    audience: ReturnType<typeof sessionAudience> | null, native: ReturnType<typeof nativeAudience> | null) {
    if (audience) {
      // The same request that consumed the OTP starts the family; the long-lived bearer is not handed out.
      const claims = jwt.decode(result.accessToken) as Record<string, unknown> & { _id: string; userType: string };
      privateTokenResponse(res);
      const token = await createSession(res, audience, claims, new Date(), req);
      return res.status(200).json({ success: true, message: result.message,
        data: { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS, user: result.userData } });
    }

    if (native) {
      const claims = jwt.decode(result.accessToken) as Record<string, unknown> & { _id: string; userType: string };
      privateTokenResponse(res);
      const tokens = await createNativeSession(native, claims, req.body?.previousRefreshToken);
      return res.status(200).json({ success: true, message: result.message, data: { ...tokens, user: result.userData } });
    }

    return res.status(200).json({
      success: true,
      message: result.message,
      data: {
        token: result.accessToken,
        user: result.userData,
      },
    });
  }

  revokeSessions = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const user = req.user;
    if (user?.userType === 'user') {
      const data = await this.authService.revokeSessions(user);
      await revokeAllSessions('user', String(user._id));
      return res.status(200).json({ success: true, message: 'Signed out on all devices', data });
    }
    // D4: staff end every web session of their account (legacy 30-day staff bearer tokens are not revocable).
    if (!user?._id || !['admin', 'pharmacy', 'hr', 'specialist', 'partner'].includes(user.userType)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Access denied' });
    }
    await revokeAllSessions(user.userType, String(user._id));
    return res.status(200).json({ success: true, message: 'Signed out on all devices', data: { signedOutEverywhere: true } });
  };

  refreshSession = async (req: Request, res: Response, _next: NextFunction) => {
    privateTokenResponse(res);
    const data = await refreshSession(req, res);
    return res.status(200).json({ success: true, data });
  };

  /** N1: phone app refresh (refresh token in the body, never a cookie). */
  refreshNativeSession = async (req: Request, res: Response, _next: NextFunction) => {
    privateTokenResponse(res);
    const data = await refreshNativeSession(req);
    return res.status(200).json({ success: true, data });
  };

  logoutNativeSession = async (req: Request, res: Response, _next: NextFunction) => {
    privateTokenResponse(res);
    await logoutNativeSession(req);
    return res.status(200).json({ success: true, data: { signedOut: true } });
  };

  logoutSession = async (req: Request, res: Response, _next: NextFunction) => {
    privateTokenResponse(res);
    await logoutSession(req, res);
    return res.status(200).json({ success: true, data: { signedOut: true } });
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

    if (authUser.userType === 'partner') {
      const memberId = authUser.memberId || authUser._id;
      const member = await this.memberRepository.findById(memberId);
      if (!member) {
        return res.status(401).json({ success: false, message: 'Partner member not found' });
      }
      const partner = await this.partnerRepository.findById(String((member as any).partnerId));
      return res.status(200).json({
        success: true,
        message: 'Profile retrieved successfully',
        data: { user: member, partner, userRole: 'partner' },
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
    }, tokenCredentialVersion(req.user));

    return res.status(200).json({
      success: true,
      message: result.message,
      data: {
        token: reissueForCaller((req as AuthRequest).user as never, result.accessToken),
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
      { otp, corporateEmail },
      tokenCredentialVersion(req.user)
    );

    return res.status(200).json({
      success: true,
      message: result.message,
      data: {
        token: reissueForCaller((req as AuthRequest).user as never, result.accessToken),
        user: result.user,
      },
    });
  };
}
