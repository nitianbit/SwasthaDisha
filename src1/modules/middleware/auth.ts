import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { CONFIG } from '@/config/config';
import { AppError } from '@/modules/common/types';
import PharmacyModel from '@/modules/pharmacies/model';

export interface AuthRequest extends Request {
  user?: {
    _id: string;
    phone?: string;
    email?: string;
    corporateId?: string;
    specialistId?: string;
    pharmacyId?: string;
    userType: string;
  };
}

const decodeAuthToken = (authHeader?: string): AuthRequest['user'] | null => {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  const decoded = jwt.verify(token, CONFIG.JWT_SECRET_KEY) as AuthRequest['user'];
  return decoded;
};

export const authenticate = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void => {
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
      next();
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
  } catch (error) {
    next(error);
  }
};

export const authenticateOptional = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      next();
      return;
    }

    req.user = decodeAuthToken(authHeader) || undefined;
    next();
  } catch (error) {
    next(error);
  }
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

const assertOperationalPharmacy = async (req: AuthRequest): Promise<void> => {
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
