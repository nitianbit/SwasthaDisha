import { publicNoShowView } from '@/modules/bookings/utils/noShowView';
import { withPatientNames } from '@/modules/bookings/utils/patientNames';
import { bookerView, bookerViews, withBookerBooking } from '@/modules/assisted/bookerView';
import 'reflect-metadata';
import BookingModel from '@/modules/bookings/model';
import { rebindStored, withFiles } from '@/modules/file/access';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AppError } from '@/modules/common/types';
import { istTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import { BookingService } from '@/modules/bookings/services';
import { DependentService } from '@/modules/dependents/services';
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
  private dependentService: DependentService;

  constructor() {
    this.bookingService = Container.get(BookingService);
    this.dependentService = Container.get(DependentService);
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

  /** Assisted booking phase 0: the booking pharmacy's id when the caller is a pharmacy (its answers use the booker view). */
  private bookerPharmacyOf(req: AuthRequest): string | undefined {
    return req.user?.userType === 'pharmacy' ? String(req.user.pharmacyId || req.user._id) : undefined;
  }

  /** A pharmacy's create / retry / reconcile answers: the strict booker view of the booking inside (review finding 4). */
  private async bookerAnswerFor<T>(req: AuthRequest, value: T): Promise<T> {
    const pharmacyId = this.bookerPharmacyOf(req);
    return pharmacyId ? withBookerBooking(value, pharmacyId) : value;
  }

  private async assertCustomerDependentOwner(req: AuthRequest): Promise<void> {
    const actor = this.requireBookingActor(req);
    // S3: a pharmacy's dependentId must belong to the customer it books for (its link to that customer is checked by
    // gatePharmacyBookingCreate). Admins are not checked here.
    const ownerId: unknown = actor.userType === 'user' ? actor._id : actor.userType === 'pharmacy' ? req.body.userId : undefined;
    if (typeof ownerId !== 'string' || ownerId.length === 0) return;
    const dependentId = req.body.dependentId;
    if (dependentId === undefined) return;
    if (typeof dependentId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(dependentId)) {
      throw new AppError({ status: 404, code: 'DEPENDENT_NOT_FOUND', message: 'Dependent not found' });
    }
    const dependent = await this.dependentService.getById(dependentId, ownerId);
    if (dependent.isActive === false) {
      throw new AppError({ status: 404, code: 'DEPENDENT_NOT_FOUND', message: 'Dependent not found' });
    }
  }

  /**
   * D1: only `createSpecialistBooking` (consultation / second-opinion) replays a keyed resend. When the same owner + key
   * already exists it returns the stored booking from its stored terms and changes no attachment, so the request's
   * attachments are not re-checked (a pre-D1 request carrying a legacy document can still finish); instead the stored
   * booking's bindings are repaired for the files this actor uploaded (a first attempt whose binding failed after the
   * save is healed by its retry). Every other create - package and surgery inserts included - checks and binds normally.
   */
  private async createWithFiles<T>(req: AuthRequest, data: { userId?: unknown; requestKey?: unknown }, replays: boolean,
    create: () => Promise<T>): Promise<T> {
    const key = typeof data.requestKey === 'string' ? data.requestKey.trim() : '';
    const prior = replays && key && data.userId != null
      ? await BookingModel.findOne({ userId: { $eq: data.userId }, createRequestKey: { $eq: key } }).select({ _id: 1 }).lean()
      : null;
    if (prior) {
      const result = await create();
      const id = (result as { booking?: { _id?: unknown } } | null)?.booking?._id ?? prior._id;
      await rebindStored(req.user, 'Booking', id);
      return result;
    }
    return withFiles(req.user, 'Booking', data, undefined, create,
      (r) => (r as { booking?: { _id?: unknown } } | null)?.booking?._id ?? (r as { _id?: unknown } | null)?._id);
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

  /**
   * S2: a specialist sees only bookings with its own specialistId and a pharmacy only bookings with its own pharmacyId.
   * Customers, admins and HR keep their own rules (undefined here); every other role is refused.
   */
  private resolveStaffBookingScope(req: AuthRequest): { specialistId: string } | { pharmacyId: string } | undefined {
    const actor = this.requireBookingActor(req);
    if (actor.userType === 'user' || actor.userType === 'admin' || actor.userType === 'hr') return undefined;
    if (actor.userType === 'specialist') return { specialistId: String(actor.specialistId || actor._id) };
    if (actor.userType === 'pharmacy') return { pharmacyId: String(actor.pharmacyId || actor._id) };
    throw new AppError({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Access to this booking resource is not permitted',
    });
  }

  private resolveGenericBookingWriteScope(req: AuthRequest): string | undefined {
    const userId = this.resolveBookingOwnerScope(req);
    this.ensureHRReadOnly(req);
    if (req.user?.userType !== 'user' && req.user?.userType !== 'admin') {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Access to this booking resource is not permitted',
      });
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

  /**
   * HR stays within its corporate (403); a specialist or pharmacy gets 404 for a booking that is not its own (S2). A
   * specialist also reaches a booking it made as the customer (its own id is the booking's userId) (S3).
   */
  private async ensureCanReadBooking(req: AuthRequest, bookingId: string): Promise<void> {
    await this.ensureHRCanAccessBooking(req, bookingId);
    const staffScope = this.resolveStaffBookingScope(req);
    if (staffScope) {
      await this.bookingService.assertInOwnerScope(bookingId, staffScope, 'specialistId' in staffScope ? req.user!._id : undefined);
    }
  }

  createBooking = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    this.ensureHRReadOnly(req);
    await this.assertCustomerDependentOwner(req);
    const userId = this.resolveBookingUserId(req);

    const data: CreateBookingRequest = {
      ...req.body,
      userId,
      pharmacyId: this.resolveBookingPharmacyId(req),
      corporateId:
        req.user?.userType === 'admin'
          ? req.body.corporateId
          : req.user?.corporateId,
      doctorName:
        (req.body.doctorName as string | undefined) ||
        (req.body.doctor_name as string | undefined),
      packageName:
        (req.body.packageName as string | undefined) ||
        (req.body.package_name as string | undefined),
    };
    const result = await this.createWithFiles(req, data, data.bookingType === 'consultation' || data.bookingType === 'second-opinion',
      () => this.bookingService.createBooking(data));

    res.status(201).json({
      success: true,
      message: result.paymentRequired
        ? 'Booking created and payment initiated successfully'
        : 'Booking created successfully',
      data: await this.bookerAnswerFor(req, publicNoShowView(result)),
    });
  };

  createWellnessPackageBooking = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    this.ensureHRReadOnly(req);
    await this.assertCustomerDependentOwner(req);
    const userId = this.resolveBookingUserId(req);

    const data: CreateWellnessPackageBookingRequest = {
      ...req.body,
      userId,
      pharmacyId: this.resolveBookingPharmacyId(req),
      corporateId:
        req.user?.userType === 'admin'
          ? req.body.corporateId
          : req.user?.corporateId,
      packageName:
        (req.body.packageName as string | undefined) ||
        (req.body.package_name as string | undefined),
    };
    const result = await this.createWithFiles(req, data, false, () => this.bookingService.createWellnessPackageBooking(data));

    res.status(201).json({
      success: true,
      message: result.paymentRequired
        ? 'Wellness package booking created and payment initiated successfully'
        : 'Wellness package booking created successfully',
      data: await this.bookerAnswerFor(req, publicNoShowView(result)),
    });
  };

  createSpecialistBooking = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    this.ensureHRReadOnly(req);
    await this.assertCustomerDependentOwner(req);
    const userId = this.resolveBookingUserId(req);

    const data: CreateSpecialistBookingRequest = {
      ...req.body,
      userId,
      pharmacyId: this.resolveBookingPharmacyId(req),
      corporateId:
        req.user?.userType === 'admin'
          ? req.body.corporateId
          : req.user?.corporateId,
      doctorName:
        (req.body.doctorName as string | undefined) ||
        (req.body.doctor_name as string | undefined),
    };
    const result = await this.createWithFiles(req, data, true, () => this.bookingService.createSpecialistBooking(data));

    res.status(201).json({
      success: true,
      message: result.paymentRequired
        ? 'Specialist booking created and payment initiated successfully'
        : 'Specialist booking created successfully',
      data: await this.bookerAnswerFor(req, publicNoShowView(result)),
    });
  };

  getById = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const userId = this.resolveBookingOwnerScope(req);
    const { id } = req.params;
    await this.ensureCanReadBooking(req, id);
    const result = await this.bookingService.getById(id, userId);
    // Q15: admins see the patient's name as on the admin list rows; other callers see the booking unchanged.
    const row = req.user?.userType === 'admin' ? (await withPatientNames([result as any]))[0] as unknown as typeof result : result;
    // Assisted booking phase 0 (§9.2): a pharmacy reads its bookings only in the booker view.
    const pharmacyId = this.bookerPharmacyOf(req);

    res.status(200).json({
      success: true,
      data: pharmacyId ? await bookerView(row as never, pharmacyId, { copies: 'inline' }) : publicNoShowView(row),
    });
  };

  getPaymentDetails = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const { id } = req.params;
    await this.ensureCanReadBooking(req, id);
    const result = await this.bookingService.getPaymentDetails(id, {
      _id: req.user!._id,
      userType: req.user!.userType,
      corporateId: req.user?.corporateId,
      pharmacyId: req.user?.pharmacyId,
    });

    // payment-details: its booking part is ten payment fields only (no clinical data), for the pharmacy's payment flow.
    res.status(200).json({
      success: true,
      data: publicNoShowView(result),
    });
  };

  getAll = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const requiredCorporateId = this.resolveHRBookingReadScope(req);
    const staffScope = this.resolveStaffBookingScope(req);
    const effectiveUserId =
      req.user?.userType === 'admin'
        ? (req.query.userId as string | undefined)
        : req.user?.userType === 'hr'
          ? (req.query.userId as string | undefined)
        : staffScope
          ? (req.query.userId as string | undefined) // S2: only narrows the specialist's / pharmacy's own bookings
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
      ownerScope: staffScope,
    };

    const result = requiredCorporateId === undefined
      ? await this.bookingService.getAll(queryParams)
      : await this.bookingService.getAll(queryParams, requiredCorporateId);
    // Q15: admin rows name the patient (family member or account holder); other callers see the rows unchanged.
    const rows = req.user?.userType === 'admin' ? await withPatientNames(result.data as any[]) as unknown as typeof result.data : result.data;
    // Assisted booking phase 0 (§9.2): a pharmacy lists its bookings only in the booker view.
    const pharmacyId = this.bookerPharmacyOf(req);
    const view = pharmacyId ? await bookerViews(rows as never[], pharmacyId) as unknown as typeof rows : publicNoShowView(rows);

    if (result.total !== undefined) {
      // Paginated response
      res.status(200).json({
        success: true,
        data: view,
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
        data: view,
      });
    }
  };

  update = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const userId = this.resolveGenericBookingWriteScope(req);
    const { id } = req.params;
    const data: UpdateBookingRequest = req.body;
    const result = await withFiles(req.user, 'Booking', data, id, () => (req.user?.userType === 'user'
      ? this.bookingService.updateCustomerNotes(id, data, userId)
      : this.bookingService.update(id, data, userId)));

    res.status(200).json({
      success: true,
      message: 'Booking updated successfully',
      data: publicNoShowView(result),
    });
  };

  delete = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const userId = this.resolveGenericBookingWriteScope(req);
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
    const staffScope = this.resolveStaffBookingScope(req);
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
        : staffScope
          ? (await this.bookingService.getAll({ userId, ownerScope: staffScope })).data
          : await this.bookingService.getByUserId(effectiveUserId);
    const pharmacyId = this.bookerPharmacyOf(req);

    res.status(200).json({
      success: true,
      data: pharmacyId ? await bookerViews(result as never[], pharmacyId) : publicNoShowView(result),
    });
  };

  getUpcomingBookings = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const actor = this.requireBookingActor(req);
    const requiredCorporateId = this.resolveHRBookingReadScope(req);
    if (actor.userType === 'hr') {
      const result = await this.bookingService.getAll({
        corporateId: this.getHRCorporateId(req),
        bookingDateFrom: istTodayYyyymmdd(), // Q16d: upcoming from the IST date
      }, requiredCorporateId);

      res.status(200).json({
        success: true,
        data: publicNoShowView(result.data.filter(
          (booking) => booking.status === 'pending' || booking.status === 'confirmed'
        )),
      });
      return;
    }

    const effectiveUserId =
      actor.userType === 'admin'
        ? (req.query.userId as string | undefined)
        : actor._id;

    const result = await this.bookingService.getUpcomingBookings(effectiveUserId);

    res.status(200).json({
      success: true,
      data: publicNoShowView(result),
    });
  };

  reconcilePayments = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    this.ensureHRReadOnly(req);
    await this.ensureCanReadBooking(req, req.params.id);
    const result = await this.bookingService.reconcileBookingPayments(req.params.id, {
      _id: req.user!._id, userType: req.user!.userType, pharmacyId: req.user?.pharmacyId,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    // Q16d (F6): the same view as every other booking route (no desk, settlement or no-show internals).
    res.status(200).json({ success: true, data: await this.bookerAnswerFor(req, publicNoShowView(result)) });
  };

  retryPayment = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    this.ensureHRReadOnly(req);
    const { id } = req.params;
    await this.ensureCanReadBooking(req, id);
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
      data: await this.bookerAnswerFor(req, publicNoShowView(result)),
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
      data: publicNoShowView(result),
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
      data: publicNoShowView(result),
    });
  };
}
