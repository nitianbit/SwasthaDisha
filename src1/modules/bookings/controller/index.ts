import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AppError } from '@/modules/common/types';
import { getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import { BookingService } from '@/modules/bookings/services';
import { AuthRequest } from '@/modules/middleware/auth';
import {
  CancelBookingRequest,
  CreateBookingRequest,
  CreateWellnessPackageBookingRequest,
  CreateSpecialistBookingRequest,
  RescheduleBookingRequest,
  RetryBookingPaymentRequest,
  UpdateBookingRequest,
  BookingQueryParams,
} from '@/modules/bookings/types';

export class BookingController {
  private bookingService: BookingService;

  constructor() {
    this.bookingService = Container.get(BookingService);
  }

  private requireBookingActor(req: AuthRequest) {
    const actor = req.user;
    if (
      !actor ||
      typeof actor._id !== 'string' ||
      actor._id.trim().length === 0 ||
      typeof actor.userType !== 'string' ||
      actor.userType.trim().length === 0
    ) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    return actor;
  }

  private resolveBookingOwnerScope(req: AuthRequest): string | undefined {
    const actor = this.requireBookingActor(req);
    const userId = req.query.userId as string | undefined;
    if (actor.userType === 'user') {
      if (userId !== undefined && userId !== actor._id) {
        throw new AppError({
          status: 403,
          code: 'FORBIDDEN',
          message: 'Access to bookings owned by another user is not permitted',
        });
      }
      return actor._id;
    }

    return userId;
  }

  private resolveHRBookingReadScope(req: AuthRequest): string | undefined {
    if (req.user?.userType !== 'hr') {
      return undefined;
    }

    const corporateId = req.user.corporateId;
    if (
      typeof corporateId !== 'string' ||
      !/^[0-9a-fA-F]{24}$/.test(corporateId)
    ) {
      throw new AppError({
        status: 403,
        code: 'HR_CORPORATE_REQUIRED',
        message: 'HR account must be linked to a corporate',
      });
    }

    const requestedCorporateId = req.query.corporateId;
    const forUser: unknown = req.query.forUser;
    if (
      (requestedCorporateId !== undefined && requestedCorporateId !== corporateId) ||
      (forUser !== undefined && forUser !== false && forUser !== 'false')
    ) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'HR can only access bookings from their own corporate',
      });
    }

    return corporateId;
  }

  private getHRCorporateId(req: AuthRequest): string | undefined {
    return req.user?.userType === 'hr' ? req.user.corporateId : undefined;
  }

  private resolveBookingUserId(req: AuthRequest): string {
    if (req.user?.userType === 'admin') {
      return ((req.body.userId as string | undefined) || req.user!._id);
    }

    if (req.user?.userType === 'pharmacy') {
      const userId = req.body.userId as string | undefined;
      if (!userId) {
        throw new AppError({
          status: 400,
          code: 'USER_ID_REQUIRED',
          message: 'userId is required when a pharmacy creates a booking',
        });
      }

      return userId;
    }

    return req.user!._id;
  }

  private resolveBookingPharmacyId(req: AuthRequest): string | undefined {
    if (req.user?.userType === 'pharmacy') {
      return req.user.pharmacyId || req.user._id;
    }

    if (req.user?.userType === 'admin') {
      return req.body.pharmacyId as string | undefined;
    }

    return undefined;
  }

  private ensureHRReadOnly(req: AuthRequest): void {
    if (req.user?.userType !== 'hr') {
      return;
    }

    throw new AppError({
      status: 403,
      code: 'FORBIDDEN',
      message: 'HR has view-only access to bookings',
    });
  }

  private async ensureHRCanAccessBooking(
    req: AuthRequest,
    bookingId: string
  ): Promise<void> {
    if (req.user?.userType !== 'hr') {
      return;
    }

    const hrCorporateId = this.getHRCorporateId(req);
    if (!hrCorporateId) {
      throw new AppError({
        status: 403,
        code: 'HR_CORPORATE_REQUIRED',
        message: 'HR account must be linked to a corporate',
      });
    }

    const booking = await this.bookingService.getById(bookingId);
    if (booking.corporateId !== hrCorporateId) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'HR can only access bookings from their own corporate',
      });
    }
  }

  createBooking = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    this.ensureHRReadOnly(req);
    const userId = this.resolveBookingUserId(req);

    const data: CreateBookingRequest = {
      ...req.body,
      userId,
      pharmacyId: this.resolveBookingPharmacyId(req),
      corporateId:
        req.user?.userType === 'admin'
          ? req.body.corporateId
          : req.user?.corporateId || req.body.corporateId,
      doctorName:
        (req.body.doctorName as string | undefined) ||
        (req.body.doctor_name as string | undefined),
      packageName:
        (req.body.packageName as string | undefined) ||
        (req.body.package_name as string | undefined),
    };
    const result = await this.bookingService.createBooking(data);

    res.status(201).json({
      success: true,
      message: result.paymentRequired
        ? 'Booking created and payment initiated successfully'
        : 'Booking created successfully',
      data: result,
    });
  };

  createWellnessPackageBooking = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    this.ensureHRReadOnly(req);
    const userId = this.resolveBookingUserId(req);

    const data: CreateWellnessPackageBookingRequest = {
      ...req.body,
      userId,
      pharmacyId: this.resolveBookingPharmacyId(req),
      corporateId:
        req.user?.userType === 'admin'
          ? req.body.corporateId
          : req.user?.corporateId || req.body.corporateId,
      packageName:
        (req.body.packageName as string | undefined) ||
        (req.body.package_name as string | undefined),
    };
    const result = await this.bookingService.createWellnessPackageBooking(data);

    res.status(201).json({
      success: true,
      message: result.paymentRequired
        ? 'Wellness package booking created and payment initiated successfully'
        : 'Wellness package booking created successfully',
      data: result,
    });
  };

  createSpecialistBooking = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    this.ensureHRReadOnly(req);
    const userId = this.resolveBookingUserId(req);

    const data: CreateSpecialistBookingRequest = {
      ...req.body,
      userId,
      pharmacyId: this.resolveBookingPharmacyId(req),
      corporateId:
        req.user?.userType === 'admin'
          ? req.body.corporateId
          : req.user?.corporateId || req.body.corporateId,
      doctorName:
        (req.body.doctorName as string | undefined) ||
        (req.body.doctor_name as string | undefined),
    };
    const result = await this.bookingService.createSpecialistBooking(data);

    res.status(201).json({
      success: true,
      message: result.paymentRequired
        ? 'Specialist booking created and payment initiated successfully'
        : 'Specialist booking created successfully',
      data: result,
    });
  };

  getById = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const userId = this.resolveBookingOwnerScope(req);
    const { id } = req.params;
    await this.ensureHRCanAccessBooking(req, id);
    const result = await this.bookingService.getById(id, userId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getPaymentDetails = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const { id } = req.params;
    await this.ensureHRCanAccessBooking(req, id);
    const result = await this.bookingService.getPaymentDetails(id, {
      _id: req.user!._id,
      userType: req.user!.userType,
      corporateId: req.user?.corporateId,
      pharmacyId: req.user?.pharmacyId,
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getAll = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const requiredCorporateId = this.resolveHRBookingReadScope(req);
    const effectiveUserId =
      req.user?.userType === 'admin'
        ? (req.query.userId as string | undefined)
        : req.user?.userType === 'hr'
          ? (req.query.userId as string | undefined)
        : req.user?.userType === 'pharmacy'
          ? undefined
          : req.user?._id;

    const queryParams: BookingQueryParams = {
      userId: effectiveUserId,
      pharmacyId:
        req.user?.userType === 'pharmacy'
          ? (req.user?.pharmacyId || req.user?._id)
          : (req.query.pharmacyId as string | undefined),
      dependentId: req.query.dependentId as string,
      corporateId:
        this.getHRCorporateId(req) || (req.query.corporateId as string),
      bookingType: req.query.bookingType as
        | 'package'
        | 'consultation'
        | 'second-opinion'
        | 'surgery',
      wellnessPackageId: req.query.wellnessPackageId as string,
      specialistId: req.query.specialistId as string,
      status: req.query.status as any,
      paymentStatus: req.query.paymentStatus as any,
      bookingDateFrom: req.query.bookingDateFrom as string | undefined,
      bookingDateTo: req.query.bookingDateTo as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      limit: req.query.limit
        ? parseInt(req.query.limit as string)
        : undefined,
      sortBy: req.query.sortBy as string,
      sortOrder: req.query.sortOrder as 'asc' | 'desc',
      forUser: req.query.forUser === 'true',
    };

    const result = requiredCorporateId === undefined
      ? await this.bookingService.getAll(queryParams)
      : await this.bookingService.getAll(queryParams, requiredCorporateId);

    if (result.total !== undefined) {
      // Paginated response
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
      // Non-paginated response
      res.status(200).json({
        success: true,
        data: result.data,
      });
    }
  };

  update = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const userId = this.resolveBookingOwnerScope(req);
    this.ensureHRReadOnly(req);
    const { id } = req.params;
    const data: UpdateBookingRequest = req.body;
    const result = req.user?.userType === 'user'
      ? await this.bookingService.updateCustomerNotes(id, data, userId)
      : await this.bookingService.update(id, data, userId);

    res.status(200).json({
      success: true,
      message: 'Booking updated successfully',
      data: result,
    });
  };

  delete = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const userId = this.resolveBookingOwnerScope(req);
    this.ensureHRReadOnly(req);
    const { id } = req.params;
    await this.bookingService.delete(id, userId);

    res.status(200).json({
      success: true,
      message: 'Booking deleted successfully',
    });
  };

  getByUserId = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const actor = this.requireBookingActor(req);
    const requestedUserId = req.query.userId;
    if (
      actor.userType === 'user' &&
      (req.params.userId !== actor._id ||
        (requestedUserId !== undefined &&
          (typeof requestedUserId !== 'string' ||
            requestedUserId.trim() !== actor._id)))
    ) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Access to bookings owned by another user is not permitted',
      });
    }

    const requiredCorporateId = this.resolveHRBookingReadScope(req);
    const { userId } = req.params;
    const effectiveUserId = actor.userType === 'user' ? actor._id : userId;
    const result =
      req.user?.userType === 'hr'
        ? (
            await this.bookingService.getAll({
              userId,
              corporateId: this.getHRCorporateId(req),
            }, requiredCorporateId)
          ).data
        : await this.bookingService.getByUserId(effectiveUserId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  getUpcomingBookings = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const requiredCorporateId = this.resolveHRBookingReadScope(req);
    if (req.user?.userType === 'hr') {
      const result = await this.bookingService.getAll({
        corporateId: this.getHRCorporateId(req),
        bookingDateFrom: getTodayYyyymmdd(),
      }, requiredCorporateId);

      res.status(200).json({
        success: true,
        data: result.data.filter(
          (booking) => booking.status === 'pending' || booking.status === 'confirmed'
        ),
      });
      return;
    }

    const effectiveUserId =
      req.user?.userType === 'admin'
        ? (req.query.userId as string | undefined)
        : req.user?._id;

    const result = await this.bookingService.getUpcomingBookings(effectiveUserId);

    res.status(200).json({
      success: true,
      data: result,
    });
  };

  retryPayment = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    this.ensureHRReadOnly(req);
    const { id } = req.params;
    const data: RetryBookingPaymentRequest = req.body;
    const result = await this.bookingService.retryBookingPayment(id, {
      _id: req.user!._id,
      userType: req.user!.userType,
      corporateId: req.user?.corporateId,
      pharmacyId: req.user?.pharmacyId,
    }, {
      useWalletBalance: data.useWalletBalance,
      couponCode: data.couponCode,
    });

    res.status(200).json({
      success: true,
      message: result.paymentRequired
        ? 'Booking payment initiated successfully'
        : 'Booking payment completed successfully',
      data: result,
    });
  };

  cancelBooking = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    this.ensureHRReadOnly(req);
    const { id } = req.params;
    const data: CancelBookingRequest = req.body;
    const result = await this.bookingService.cancelBooking(id, data, {
      _id: req.user!._id,
      userType: req.user!.userType,
    });

    res.status(200).json({
      success: true,
      message: 'Booking cancelled successfully',
      data: result,
    });
  };

  rescheduleBooking = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    this.ensureHRReadOnly(req);
    const { id } = req.params;
    const data: RescheduleBookingRequest = req.body;
    const result = await this.bookingService.rescheduleBooking(id, data, {
      _id: req.user!._id,
      userType: req.user!.userType,
    });

    res.status(200).json({
      success: true,
      message: 'Booking rescheduled successfully',
      data: result,
    });
  };
}
