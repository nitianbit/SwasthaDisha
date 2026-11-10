import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { CouponService } from '@/modules/coupon/services';
import { AuthRequest } from '@/modules/middleware/auth';
import UserModel from '@/modules/user/model';
import logger from '@/services/logger';
import {
  CreateCouponRequest,
  UpdateCouponRequest,
  ValidateCouponRequest,
  CouponQueryParams,
  CouponUsageQueryParams,
} from '@/modules/coupon/types';

export class CouponController {
  private couponService: CouponService;

  constructor() {
    this.couponService = Container.get(CouponService);
  }

  create = async (req: Request, res: Response, _next: NextFunction) => {
    const data: CreateCouponRequest = req.body;
    const result = await this.couponService.create(data);

    res.status(201).json({
      success: true,
      message: 'Coupon created successfully',
      data: result,
    });
  };

  getById = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.couponService.getById(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getByCode = async (req: Request, res: Response, _next: NextFunction) => {
    const { code } = req.params;
    const result = await this.couponService.getByCode(code);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getUsageByCode = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { code } = req.params;
    const requestedCorporateId = req.query.corporateId as string | undefined;
    const queryParams: CouponUsageQueryParams = {
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      corporateId: requestedCorporateId,
    };

    const effectiveCorporateId = req.user?.userType === 'hr'
      ? req.user.corporateId
      : requestedCorporateId;

    if (req.user?.userType === 'hr') {
      const hrCorporateId = req.user.corporateId;

      if (!hrCorporateId) {
        res.status(403).json({
          success: false,
          message: 'HR account must be linked to a corporate',
        });
        return;
      }

      if (requestedCorporateId && requestedCorporateId !== hrCorporateId) {
        res.status(403).json({
          success: false,
          message: 'HR can only access coupon usage for their own corporate',
        });
        return;
      }
    }

    if (effectiveCorporateId) {
      const users = await UserModel.find({ corporateId: effectiveCorporateId })
        .select('_id')
        .lean();
      queryParams.userIds = users.map((user) => String(user._id));
      queryParams.corporateId = effectiveCorporateId;
    }

    const result = await this.couponService.getCouponUsageByCode(code, queryParams);

    res.status(200).json({
      success: true,
      data: {
        couponCode: result.couponCode,
        totalUses: result.totalUses,
        totalUsers: result.totalUsers,
        users: result.users,
      },
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.totalUsers,
        totalPages: result.totalPages,
      },
    });
  };

  getUsageByUserId = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const queryParams: CouponUsageQueryParams = {
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };
    const result = await this.couponService.getCouponUsageByUserId(id, queryParams);

    res.status(200).json({
      success: true,
      data: {
        userId: result.userId,
        totalUses: result.totalUses,
        totalCoupons: result.totalCoupons,
        coupons: result.coupons,
      },
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.totalCoupons,
        totalPages: result.totalPages,
      },
    });
  };

  getAll = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const queryParams: CouponQueryParams = {
      code: req.query.code as string,
      title: req.query.title as string,
      corporateId: req.query.corporateId as string,
      discountType: req.query.discountType as any,
      eligibleFor: req.query.eligibleFor as any,
      applicableTo: req.query.applicableTo as any,
      isActive:
        req.query.isActive !== undefined
          ? req.query.isActive === 'true'
          : undefined,
      startDateFrom: req.query.startDateFrom as string,
      startDateTo: req.query.startDateTo as string,
      endDateFrom: req.query.endDateFrom as string,
      endDateTo: req.query.endDateTo as string,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      limit: req.query.limit
        ? parseInt(req.query.limit as string)
        : undefined,
      sortBy: req.query.sortBy as string,
      sortOrder: req.query.sortOrder as 'asc' | 'desc',
    };

    const result = await this.couponService.getAll(queryParams, req.user);

    if (result.total !== undefined) {
      res.status(200).json({
        success: true,
        data: result.data,
        pagination: {
          page: result.page!,
          limit: queryParams.limit!,
          total: result.total,
          totalPages: result.totalPages!,
        },
      });
    } else {
      res.status(200).json({
        success: true,
        data: result.data,
      });
    }
  };

  update = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const data: UpdateCouponRequest = req.body;
    const result = await this.couponService.update(id, data);

    res.status(200).json({
      success: true,
      message: 'Coupon updated successfully',
      data: result,
    });
  };

  delete = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    await this.couponService.delete(id);

    res.status(200).json({
      success: true,
      message: 'Coupon deleted successfully',
    });
  };

  validate = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const userId =
      req.user?.userType === 'admin'
        ? ((req.body.userId as string | undefined) || req.user!._id)
        : req.user!._id;

    const data: ValidateCouponRequest = {
      ...req.body,
      userId,
      corporateId: req.user?.corporateId,
    };

    logger.info('[Coupon][validate] request received', {
      originalUrl: req.originalUrl,
      rawPayload: req.body,
      normalizedPayload: data,
      authUserId: req.user?._id,
      userType: req.user?.userType,
    });

    const result = await this.couponService.validateCoupon(data);

    const responsePayload = {
      success: result.isValid,
      message: result.message,
      data: {
        isValid: result.isValid,
        coupon: result.coupon,
        discountAmount: result.discountAmount,
        finalAmount: result.finalAmount,
      },
    };

    logger.info('[Coupon][validate] response sent', {
      originalUrl: req.originalUrl,
      couponCode: data.code,
      bookingType: data.bookingType,
      bookingId: data.bookingId,
      packageIds: data.packageIds,
      testIds: data.testIds,
      userId: data.userId,
      responsePayload,
    });

    res.status(200).json(responsePayload);
  };

  getActiveCoupons = async (
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const result = await this.couponService.getActiveCoupons();

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getApplicableCoupons = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const bookingType = req.query.bookingType as
      | 'package'
      | 'consultation'
      | 'second-opinion'
      | 'surgery'
      | 'external_specialist'
      | 'external_diagnostics';
    const bookingId = req.query.bookingId as string | undefined;
    const labId = req.query.labId as string | undefined;
    const packageIds = Array.isArray(req.query.packageIds)
      ? (req.query.packageIds as string[])
      : typeof req.query.packageIds === 'string'
        ? (req.query.packageIds as string)
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined;
    const testIds = Array.isArray(req.query.testIds)
      ? (req.query.testIds as string[])
      : typeof req.query.testIds === 'string'
        ? (req.query.testIds as string)
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined;
    const dependentId = req.query.dependentId as string | undefined;

    logger.info('[Coupon][applicable] request received', {
      originalUrl: req.originalUrl,
      rawQuery: req.query,
      parsedQuery: {
        bookingType,
        bookingId,
        labId,
        couponTargetId:
          bookingType === 'external_diagnostics'
            ? labId || bookingId
            : bookingId,
        packageIds,
        testIds,
        dependentId,
      },
      authUserId: req.user?._id,
      corporateId: req.user?.corporateId,
    });

    if (
      !bookingType ||
      ![
        'package',
        'consultation',
        'second-opinion',
        'surgery',
        'external_specialist',
        'external_diagnostics',
      ].includes(bookingType)
    ) {
      res.status(400).json({
        success: false,
        message:
          'bookingType query parameter is required and must be one of: "package", "consultation", "second-opinion", "surgery", "external_specialist", "external_diagnostics"',
      });
      return;
    }

    const result = await this.couponService.getApplicableCoupons(
      bookingType,
      bookingType === 'external_diagnostics'
        ? labId || bookingId
        : bookingId,
      packageIds,
      testIds,
      { corporateId: req.user?.corporateId, userId: req.user?._id },
      dependentId
    );

    const responsePayload = {
      success: true,
      data: result,
    };

    logger.info('[Coupon][applicable] response sent', {
      originalUrl: req.originalUrl,
      bookingType,
      bookingId,
      labId,
      couponTargetId:
        bookingType === 'external_diagnostics'
          ? labId || bookingId
          : bookingId,
      packageIds,
      testIds,
      dependentId,
      couponCount: result.length,
      couponCodes: result.map((coupon) => coupon.code),
      responsePayload,
    });

    res.status(200).json(responsePayload);
  };

  getByCorporateId = async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.couponService.getByCorporateId(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  };
}
