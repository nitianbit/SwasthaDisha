import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { CONFIG } from '@/config/config';
import { AppError } from '@/modules/common/types';
import PharmacyModel from '@/modules/pharmacies/model';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import type { PartnerPermission } from '@/modules/partners/types';
import { admitCustomerToken } from '@/modules/user/credentialGeneration';
import { admitSessionToken } from '@/modules/auth/sessions';
import { admitVersionedToken } from '@/modules/auth/tokenVersion';
import { doctorIsEligible } from '@/modules/specialists/eligibility';

export interface AuthRequest extends Request {
  user?: {
    _id: string;
    phone?: string;
    email?: string;
    corporateId?: string;
    specialistId?: string;
    pharmacyId?: string;
    memberId?: string;
    partnerId?: string;
    userType: string;
    /** Credential generation the token was issued at (customers, pharmacies, doctors, partner members; absent = 0). */
    authVersion?: number;
  };
}

const decodeAuthToken = (authHeader?: string): AuthRequest['user'] | null => {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  const decoded = jwt.verify(token, CONFIG.JWT_SECRET_KEY) as (AuthRequest['user'] & { purpose?: unknown }) | string;
  // Only access tokens authenticate: a token with a purpose (e.g. a Q7 selection ticket), or one without an access
  // identity and a known role, is refused before any route sees it.
  if (typeof decoded !== 'object' || decoded === null || decoded.purpose !== undefined
      || typeof decoded._id !== 'string' || !decoded._id || !ACCESS_ROLES.includes(String(decoded.userType))) {
    throw Object.assign(new Error('Not an access token'), { name: 'JsonWebTokenError' });
  }
  return decoded;
};

/** Roles an access token may carry. */
const ACCESS_ROLES = ['user', 'admin', 'specialist', 'hr', 'pharmacy', 'partner'];

export const authenticate = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authorization token is required',
      });
    }

    try {
      req.user = decodeAuthToken(authHeader) || undefined;
    } catch (error: any) {
      if (error.name === 'TokenExpiredError') {
        throw new AppError({
          status: 401,
          code: 'TOKEN_EXPIRED',
          message: 'Token has expired',
        });
      } else if (error.name === 'JsonWebTokenError') {
        throw new AppError({
          status: 401,
          code: 'INVALID_TOKEN',
          message: 'Invalid token',
        });
      }
      throw error;
    }
    // A customer token is admitted only at the account's current credential generation (signed out everywhere = no).
    await admitCustomerToken(req.user);
    // D4: a web-session token only while its session is live (logout / revocation are immediate).
    await admitSessionToken(req.user);
    // Q1: a partner token is admitted only while its member + parent partner are active.
    await admitPartnerToken(req.user);
    // Q16b: pharmacy, doctor and partner tokens only at the account's current generation (contact change, sign out
    // everywhere).
    await admitVersionedToken(req.user as Record<string, unknown> | undefined);
  } catch (error) {
    next(error);
    return;
  }
  next(); // outside the try: errors from later handlers are not re-reported as authentication failures
};

export const authenticateOptional = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      next();
      return;
    }

    try {
      req.user = decodeAuthToken(authHeader) || undefined;
    } catch (error: any) {
      // D4: an expired or invalid token is a 401 here too (it used to surface as a 500).
      if (error?.name === 'TokenExpiredError') throw new AppError({ status: 401, code: 'TOKEN_EXPIRED', message: 'Token has expired' });
      if (error?.name === 'JsonWebTokenError' || error?.name === 'NotBeforeError') {
        throw new AppError({ status: 401, code: 'INVALID_TOKEN', message: 'Invalid token' });
      }
      throw error;
    }
    await admitCustomerToken(req.user);
    await admitSessionToken(req.user);
    await admitPartnerToken(req.user);
    await admitVersionedToken(req.user as Record<string, unknown> | undefined);
  } catch (error) {
    next(error);
    return;
  }
  next();
};

export const requireAdmin = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void => {
  try {
    if (!req.user) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    if (req.user.userType !== 'admin') {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Admin access is required',
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};

export const requireHR = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void => {
  try {
    if (!req.user) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    if (req.user.userType !== 'hr') {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'HR access is required',
      });
    }

    if (!req.user.corporateId) {
      throw new AppError({
        status: 403,
        code: 'HR_CORPORATE_REQUIRED',
        message: 'HR account must be linked to a corporate',
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};

export const requireAdminOrHR = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void => {
  try {
    if (!req.user) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    if (req.user.userType !== 'admin' && req.user.userType !== 'hr') {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Admin or HR access is required',
      });
    }

    if (req.user.userType === 'hr' && !req.user.corporateId) {
      throw new AppError({
        status: 403,
        code: 'HR_CORPORATE_REQUIRED',
        message: 'HR account must be linked to a corporate',
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};

export const requireSpecialist = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void => {
  try {
    if (!req.user) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    if (req.user.userType !== 'specialist') {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Specialist access is required',
      });
    }

    const specialistId = req.user.specialistId || req.user._id;
    if (!specialistId) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Specialist access is required',
      });
    }

    req.user.specialistId = specialistId;
    next();
  } catch (error) {
    next(error);
  }
};

export const requirePharmacy = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void => {
  try {
    if (!req.user) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    if (req.user.userType !== 'pharmacy') {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Pharmacy access is required',
      });
    }

    const pharmacyId = req.user.pharmacyId || req.user._id;
    if (!pharmacyId) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Pharmacy account must be linked to a pharmacy profile',
      });
    }

    req.user.pharmacyId = pharmacyId;
    next();
  } catch (error) {
    next(error);
  }
};

export const requireAdminOrPharmacy = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void => {
  try {
    if (!req.user) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    if (req.user.userType === 'admin') {
      return next();
    }

    if (req.user.userType === 'pharmacy') {
      const pharmacyId = req.user.pharmacyId || req.user._id;
      if (!pharmacyId) {
        throw new AppError({
          status: 403,
          code: 'FORBIDDEN',
          message: 'Pharmacy account must be linked to a pharmacy profile',
        });
      }

      req.user.pharmacyId = pharmacyId;
      return next();
    }

    throw new AppError({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Admin or pharmacy access is required',
    });
  } catch (error) {
    next(error);
  }
};

export const assertOperationalPharmacy = async (req: AuthRequest): Promise<void> => {
  const pharmacyId = req.user?.pharmacyId || req.user?._id;
  if (!pharmacyId) {
    throw new AppError({
      status: 403,
      code: 'PHARMACY_PROFILE_REQUIRED',
      message: 'Pharmacy account must be linked to a pharmacy profile',
    });
  }

  const pharmacy = await PharmacyModel.findById(pharmacyId)
    .select('_id isActive isVerified archivedAt')
    .lean();

  if (!pharmacy || pharmacy.archivedAt || pharmacy.isActive === false) {
    throw new AppError({
      status: 403,
      code: 'PHARMACY_INACTIVE',
      message: 'This pharmacy account is inactive',
    });
  }

  if (!pharmacy.isVerified) {
    throw new AppError({
      status: 403,
      code: 'PHARMACY_NOT_VERIFIED',
      message: 'Pharmacy verification is required for this operation',
    });
  }

  req.user!.pharmacyId = String(pharmacy._id);
};

/** Pharmacy business operations use this; onboarding/profile routes use requirePharmacy. */
export const requireOperationalPharmacy = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      throw new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Authentication is required' });
    }
    if (req.user.userType !== 'pharmacy') {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Pharmacy access is required' });
    }
    await assertOperationalPharmacy(req);
    next();
  } catch (error) {
    next(error);
  }
};

export const requireAdminOrOperationalPharmacy = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      throw new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Authentication is required' });
    }
    if (req.user.userType === 'admin') {
      next();
      return;
    }
    if (req.user.userType !== 'pharmacy') {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Admin or verified pharmacy access is required',
      });
    }
    await assertOperationalPharmacy(req);
    next();
  } catch (error) {
    next(error);
  }
};

export const requirePartner = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void => {
  try {
    if (!req.user) {
      throw new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Authentication is required' });
    }
    if (req.user.userType !== 'partner') {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Partner access is required' });
    }
    const memberId = req.user.memberId || req.user._id;
    if (!memberId) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Partner membership is required' });
    }
    req.user.memberId = memberId;
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * The request's member is active and its partner exists and is active; `verified` also requires a verified partner (an
 * operational partner). r20: the unverified admission serves routes over a partner's own money (2d D5, §19.8 item b).
 */
async function assertPartnerMember(req: AuthRequest, verified: boolean): Promise<void> {
  const memberId = req.user?.memberId || req.user?._id;
  if (!memberId) {
    throw new AppError({ status: 403, code: 'PARTNER_MEMBERSHIP_REQUIRED', message: 'Partner membership is required' });
  }
  const member = await MemberModel.findById(memberId).select('partnerId isActive role permissions').lean();
  if (!member || member.isActive === false) {
    throw new AppError({ status: 403, code: 'PARTNER_MEMBER_INACTIVE', message: 'Partner membership is inactive' });
  }
  const partner = await PartnerModel.findById(member.partnerId).select('isActive verification.state').lean();
  if (!partner || partner.isActive === false) {
    throw new AppError({ status: 403, code: 'PARTNER_INACTIVE', message: 'Partner is inactive' });
  }
  if (verified && (partner as any).verification?.state !== 'verified') {
    throw new AppError({ status: 403, code: 'PARTNER_NOT_VERIFIED', message: 'Partner verification is required for this operation' });
  }
  req.user!.memberId = String(member._id);
  req.user!.partnerId = String(member.partnerId);
}

export const assertOperationalPartner = (req: AuthRequest): Promise<void> => assertPartnerMember(req, true);

export const requireOperationalPartner = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      throw new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Authentication is required' });
    }
    if (req.user.userType !== 'partner') {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Partner access is required' });
    }
    await assertOperationalPartner(req);
    next();
  } catch (error) {
    next(error);
  }
};

const partnerPermissionGuard = (mode: 'all' | 'any', perms: PartnerPermission[], opts: { verified: boolean } = { verified: true }) => {
  return async (req: AuthRequest, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Authentication is required' });
      }
      if (req.user.userType !== 'partner') {
        throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Partner access is required' });
      }
      await assertPartnerMember(req, opts.verified);
      const member = await MemberModel.findById(req.user.memberId).select('role permissions').lean();
      if (!member) {
        throw new AppError({ status: 403, code: 'PARTNER_MEMBER_NOT_FOUND', message: 'Member not found' });
      }
      if ((member as any).role === 'owner') {
        return next();
      }
      const memberPerms: string[] = (member as any).permissions || [];
      const ok = mode === 'all' ? perms.every((p) => memberPerms.includes(p)) : perms.some((p) => memberPerms.includes(p));
      if (!ok) {
        throw new AppError({ status: 403, code: 'INSUFFICIENT_PERMISSIONS', message: `Missing permissions: ${perms.join(mode === 'all' ? ', ' : ' or ')}` });
      }
      next();
    } catch (error) {
      next(error);
    }
  };
};

/** Every listed permission (owners hold all). */
export const requirePartnerPermission = (...perms: PartnerPermission[]) => partnerPermissionGuard('all', perms);
/** At least one of the listed permissions (owners hold all). */
export const requireAnyPartnerPermission = (...perms: PartnerPermission[]) => partnerPermissionGuard('any', perms);
/** r20: every listed permission, for an active member of an active partner whether verified or not (its own money). */
export const requirePartnerPermissionUnverified = (...perms: PartnerPermission[]) => partnerPermissionGuard('all', perms, { verified: false });

/**
 * r9 (owner decision): a partner member linked to a doctor (`doctorId`: the owner of a doctor's own practice, or a
 * clinic's doctor) works in the clinic workspace only while that doctor is eligible (verified and active, S5
 * `isEligibleDoctor`). Refused at sign-in and on every request of an existing session (403
 * CLINIC_DOCTOR_NOT_VERIFIED); re-verifying the doctor restores access. Members without a `doctorId` are unaffected.
 */
export async function assertMemberDoctorEligible(member: { doctorId?: unknown } | null | undefined): Promise<void> {
  const doctorId = typeof member?.doctorId === 'string' ? member.doctorId.trim() : '';
  if (!doctorId) return;
  if (!(await doctorIsEligible(doctorId.toLowerCase()))) {
    throw new AppError({ status: 403, code: 'CLINIC_DOCTOR_NOT_VERIFIED',
      message: 'Your doctor account is not verified or not active, so this clinic workspace is closed to you; contact Jansetu support' });
  }
}

async function admitPartnerToken(claims: { userType?: string; memberId?: string; _id?: string } | undefined): Promise<void> {
  if (!claims || claims.userType !== 'partner') return;
  const memberId = claims.memberId || claims._id;
  if (!memberId) throw new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Please sign in again' });
  const member = await MemberModel.findById(memberId).select('partnerId isActive doctorId').lean();
  if (!member || (member as any).isActive === false) {
    throw new AppError({ status: 401, code: 'PARTNER_MEMBER_REVOKED', message: 'Partner membership has been revoked' });
  }
  const partner = await PartnerModel.findById((member as any).partnerId).select('isActive').lean();
  if (!partner || (partner as any).isActive === false) {
    throw new AppError({ status: 401, code: 'PARTNER_SUSPENDED', message: 'Partner organisation is inactive' });
  }
  await assertMemberDoctorEligible(member as { doctorId?: unknown });
}

export const denyRoles = (...blocked: string[]) => {
  return (req: AuthRequest, _res: Response, next: NextFunction): void => {
    if (req.user && blocked.includes(req.user.userType)) {
      return next(new AppError({ status: 403, code: 'ROLE_NOT_ALLOWED', message: 'This endpoint is not available for your account type' }));
    }
    next();
  };
};

export const requireAdminOrPartner = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void => {
  try {
    if (!req.user) {
      throw new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Authentication is required' });
    }
    if (req.user.userType === 'admin') {
      return next();
    }
    if (req.user.userType === 'partner') {
      const memberId = req.user.memberId || req.user._id;
      if (!memberId) {
        throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Partner membership is required' });
      }
      req.user.memberId = memberId;
      return next();
    }
    throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Admin or partner access is required' });
  } catch (error) {
    next(error);
  }
};
