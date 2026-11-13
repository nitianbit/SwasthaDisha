import 'reflect-metadata';
import { NextFunction, Response } from 'express';
import { Container } from 'typedi';

import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';
import { ExternalBookingService } from '@/modules/externalBookings/services';
import { DependentService } from '@/modules/dependents/services';
import UserModel from '@/modules/user/model';
import {
  calculateAgeFromDob,
  toLabstackGender,
} from '@/modules/externalBookings/utils/helpers';
import { CONFIG } from '@/config/config';
import logger from '@/services/logger';
import {
  CancelExternalBookingRequest,
  CustomerDiagnosticsHistoryQuery,
  CreateExternalDiagnosticsBookingRequest,
  CreateExternalBookingRequest,
  ExternalIntegration,
  ExternalDiagnosticsSlotsQuery,
  ExternalBookingListQuery,
  ExternalLabsQuery,
  ExternalPackageQuery,
  ExternalPackagePreparationsQuery,
  ExternalPackagesQuery,
  ExternalServiceabilityQuery,
  ExternalSlotsQuery,
  ExternalSpecialistsQuery,
  ExternalTestQuery,
  ExternalTestsQuery,
  ProviderTypesQuery,
  RescheduleExternalBookingRequest,
  RescheduleExternalDiagnosticsBookingRequest,
} from '@/modules/externalBookings/types';

export class ExternalBookingController {
  private externalBookingService: ExternalBookingService;
  private dependentService: DependentService;
  private readonly defaultIntegration: ExternalIntegration =
    CONFIG.EXTERNAL_BOOKING_DEFAULT_INTEGRATION || 'labstack';

  constructor() {
    this.externalBookingService = Container.get(ExternalBookingService);
    this.dependentService = Container.get(DependentService);
  }

  private requireBookingActor(req: AuthRequest) {
    const actor = req.user;
    if (!actor || typeof actor._id !== 'string' || actor._id.trim().length === 0 ||
        typeof actor.userType !== 'string' || actor.userType.trim().length === 0) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }
    return actor;
  }

  private async assertCustomerDependentOwner(req: AuthRequest): Promise<void> {
    const actor = this.requireBookingActor(req);
    if (actor.userType !== 'user') return;

    const dependentId = req.body.dependentId;
    if (dependentId === undefined) {
      return;
    }

    if (
      typeof dependentId !== 'string' ||
      !/^[0-9a-fA-F]{24}$/.test(dependentId)
    ) {
      throw new AppError({
        status: 404,
        code: 'DEPENDENT_NOT_FOUND',
        message: 'Dependent not found',
      });
    }

    const dependent = await this.dependentService.getById(dependentId, actor._id);
    if (dependent.isActive === false) {
      throw new AppError({ status: 404, code: 'DEPENDENT_NOT_FOUND', message: 'Dependent not found' });
    }
  }

  private resolveIntegration(value: unknown): ExternalIntegration {
    const integration = String(value || this.defaultIntegration) as ExternalIntegration;
    return integration === 'healthians' ? 'healthians' : 'labstack';
  }

  private readStringArray(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
      const items = value
        .map((item) =>
          typeof item === 'string' ? item.trim() : String(item || '').trim()
        )
        .filter(Boolean);
      return items.length ? items : undefined;
    }

    if (typeof value === 'string' && value.trim()) {
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }

    return undefined;
  }

  getProviderTypes = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const query: ProviderTypesQuery = {
      integration: this.resolveIntegration(req.query.integration),
      appointmentType: req.query.appointmentType as string | undefined,
      pincode: req.query.pincode as string | undefined,
    };

    const data = await this.externalBookingService.getProviderTypes(query);

    res.status(200).json({
      success: true,
      data,
    });
  };

  getPackages = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const query: ExternalPackagesQuery = {
      integration: this.resolveIntegration(req.query.integration),
      pincode: req.query.pincode as string | undefined,
      latitude: req.query.latitude
        ? Number(req.query.latitude)
        : undefined,
      longitude: req.query.longitude
        ? Number(req.query.longitude)
        : undefined,
    };

    const data = await this.externalBookingService.getPackages(query);

    res.status(200).json({
      success: true,
      data,
    });
  };

  getPackage = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const query: ExternalPackageQuery = {
      integration: this.resolveIntegration(req.query.integration),
      packageId: req.query.packageId as string,
      pincode: req.query.pincode as string | undefined,
      latitude: req.query.latitude
        ? Number(req.query.latitude)
        : undefined,
      longitude: req.query.longitude
        ? Number(req.query.longitude)
        : undefined,
    };

    const data = await this.externalBookingService.getPackage(query);

    res.status(200).json({
      success: true,
      data,
    });
  };

  getTests = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const query: ExternalTestsQuery = {
      integration: this.resolveIntegration(req.query.integration),
      id: req.query.id as string | undefined,
      pincode: req.query.pincode as string | undefined,
      latitude: req.query.latitude
        ? Number(req.query.latitude)
        : undefined,
      longitude: req.query.longitude
        ? Number(req.query.longitude)
        : undefined,
      search: req.query.search as string | undefined,
    };

    const data = await this.externalBookingService.getTests(query);

    res.status(200).json({
      success: true,
      data,
    });
  };

  getTest = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const query: ExternalTestQuery = {
      integration: this.resolveIntegration(req.query.integration),
      testId: req.query.testId as string,
      pincode: req.query.pincode as string | undefined,
      latitude: req.query.latitude
        ? Number(req.query.latitude)
        : undefined,
      longitude: req.query.longitude
        ? Number(req.query.longitude)
        : undefined,
    };

    const data = await this.externalBookingService.getTest(query);

    res.status(200).json({
      success: true,
      data,
    });
  };

  getLabs = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const query: ExternalLabsQuery = {
      integration: this.resolveIntegration(req.query.integration),
      labId: req.query.labId as string | undefined,
      pincode: req.query.pincode as string | undefined,
      city: req.query.city as string | undefined,
      search: req.query.search as string | undefined,
    };

    const data = await this.externalBookingService.getLabs(query);

    res.status(200).json({
      success: true,
      data,
    });
  };

  getServiceability = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const query: ExternalServiceabilityQuery = {
      integration: this.resolveIntegration(req.query.integration),
    };

    if (req.query.pincode) {
      query.pincode = req.query.pincode as string;
    }
    if (req.query.latitude) {
      query.latitude = Number(req.query.latitude);
    }
    if (req.query.longitude) {
      query.longitude = Number(req.query.longitude);
    }

    const packageIds = this.toStringArray(req.query.packageIds);
    if (packageIds?.length) {
      query.packageIds = packageIds;
    }

    const testIds = this.toStringArray(req.query.testIds);
    if (testIds?.length) {
      query.testIds = testIds;
    }

    const data = await this.externalBookingService.getServiceability(query);

    res.status(200).json({
      success: true,
      data,
    });
  };

  getPackagePreparations = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const query: ExternalPackagePreparationsQuery = {
      integration: this.resolveIntegration(req.query.integration),
      packageId: req.query.packageId as string,
    };

    const data = await this.externalBookingService.getPackagePreparations(query);

    res.status(200).json({
      success: true,
      data,
    });
  };

  getDiagnosticsSlots = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const query: ExternalDiagnosticsSlotsQuery = {
      integration: this.resolveIntegration(req.query.integration),
      bookingDate: req.query.bookingDate as string,
      labId: req.query.labId as string | undefined,
      pincode: req.query.pincode as string | undefined,
      latitude: req.query.latitude
        ? Number(req.query.latitude)
        : undefined,
      longitude: req.query.longitude
        ? Number(req.query.longitude)
        : undefined,
      packageIds: this.toStringArray(req.query.packageIds),
      testIds: this.toStringArray(req.query.testIds),
    };

    const data = await this.externalBookingService.getDiagnosticsSlots(query);

    res.status(200).json({
      success: true,
      data,
    });
  };

  getSpecialists = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const query: ExternalSpecialistsQuery = {
      integration: this.resolveIntegration(req.query.integration),
      providerType: req.query.providerType as string,
      appointmentType: req.query.appointmentType as string,
      speciality: req.query.speciality as string | undefined,
      subSpeciality: req.query.subSpeciality as string | undefined,
      preferredGender: req.query.preferredGender as string | undefined,
      pincode: req.query.pincode as string | undefined,
      latitude: req.query.latitude as string | undefined,
      longitude: req.query.longitude as string | undefined,
    };

    const data = await this.externalBookingService.getSpecialists(
      query,
      req.user?._id
    );

    res.status(200).json({
      success: true,
      data,
    });
  };

  getSlots = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const query: ExternalSlotsQuery = {
      integration: this.resolveIntegration(req.query.integration),
      providerType: req.query.providerType as string | undefined,
      appointmentType: req.query.appointmentType as string,
      externalProviderId: req.query.externalProviderId as string,
      bookingDate: req.query.bookingDate as string,
      pincode: req.query.pincode as string | undefined,
      latitude: req.query.latitude as string | undefined,
      longitude: req.query.longitude as string | undefined,
    };

    const data = await this.externalBookingService.getSlots(query);

    res.status(200).json({
      success: true,
      data,
    });
  };

  createBooking = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const actor = this.requireBookingActor(req);
    await this.assertCustomerDependentOwner(req);
    const userId = actor.userType === 'admin'
      ? ((req.body.userId as string | undefined) || actor._id)
      : actor._id;

    const user = await UserModel.findById(userId)
          .select('name email phone dateOfBirth gender address city state pincode')
          .lean();

    const patientDateOfBirth =
      (req.body.patientDateOfBirth as string | undefined) || user?.dateOfBirth;
    const patientAge =
      (req.body.patientAge as string | undefined) ||
      calculateAgeFromDob(patientDateOfBirth);
    const patientGender =
      (req.body.patientGender as string | undefined) ||
      toLabstackGender(user?.gender as string | undefined);

    const data: CreateExternalBookingRequest = {
      ...req.body,
      bookingTime:
        (req.body.selectedSlotTime as string | undefined) ||
        (req.body.bookingTime as string | undefined),
      userId,
      corporateId:
        req.user?.userType === 'admin'
          ? (req.body.corporateId as string | undefined)
          : req.user?.corporateId,
      patientName: (req.body.patientName as string | undefined) || user?.name || 'Patient',
      patientEmail: (req.body.patientEmail as string | undefined) || user?.email,
      patientPhone: (req.body.patientPhone as string | undefined) || user?.phone,
      doctorName:
        (req.body.doctorName as string | undefined) ||
        (req.body.doctor_name as string | undefined),
      labName:
        (req.body.labName as string | undefined) ||
        (req.body.lab_name as string | undefined),
      patientGender,
      patientDateOfBirth,
      patientAge,
      addressLine: (req.body.addressLine as string | undefined) || user?.address,
      address:
        (req.body.address as string | undefined) ||
        (req.body.addressLine as string | undefined) ||
        user?.address,
      city: (req.body.city as string | undefined) || user?.city,
      state: (req.body.state as string | undefined) || user?.state,
      pincode: (req.body.pincode as string | undefined) || user?.pincode,
      integration: this.resolveIntegration(req.body.integration),
    };

    logger.info('[ExternalBooking] frontend consultation booking payload received', {
      userId,
      integration: data.integration,
    });

    const created = await this.externalBookingService.createBooking(data);

    res.status(201).json({
      success: true,
      message: created.paymentRequired
        ? 'External booking created; complete payment to confirm with the provider'
        : 'External booking created successfully',
      data: created,
    });
  };

  createDiagnosticsBooking = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const actor = this.requireBookingActor(req);
    await this.assertCustomerDependentOwner(req);
    const userId = actor.userType === 'admin'
      ? ((req.body.userId as string | undefined) || actor._id)
      : actor._id;

    const user = await UserModel.findById(userId)
          .select('address city state pincode gender')
          .lean();

    const patientGender =
      (req.body.patientGender as string | undefined) ||
      toLabstackGender(user?.gender as string | undefined);
    const labAddress =
      (req.body.labAddress as string | undefined) ||
      (req.body.lab_address as string | undefined);

    const data: CreateExternalDiagnosticsBookingRequest = {
      ...req.body,
      userId,
      corporateId:
        req.user?.userType === 'admin'
          ? (req.body.corporateId as string | undefined)
          : req.user?.corporateId,
      integration: this.resolveIntegration(req.body.integration),
      addressLine:
        (req.body.addressLine as string | undefined) || user?.address,
      address:
        labAddress ||
        (req.body.address as string | undefined) ||
        (req.body.addressLine as string | undefined) ||
        user?.address,
      labAddress,
      doctorName:
        (req.body.doctorName as string | undefined) ||
        (req.body.doctor_name as string | undefined),
      labName:
        (req.body.labName as string | undefined) ||
        (req.body.lab_name as string | undefined),
      packageNames:
        this.readStringArray(req.body.packageNames) ||
        this.readStringArray(req.body.package_names) ||
        this.readStringArray(req.body.package_name),
      testNames:
        this.readStringArray(req.body.testNames) ||
        this.readStringArray(req.body.test_names) ||
        this.readStringArray(req.body.test_name),
      patientGender,
      city: (req.body.city as string | undefined) || user?.city,
      state: (req.body.state as string | undefined) || user?.state,
      pincode: (req.body.pincode as string | undefined) || user?.pincode,
    };

    logger.info('[ExternalBooking] frontend diagnostics booking payload received', {
      userId,
      integration: data.integration,
    });

    const created = await this.externalBookingService.createDiagnosticsBooking(data);

    res.status(201).json({
      success: true,
      message: created.paymentRequired
        ? 'External diagnostics booking created; complete payment to confirm the order'
        : 'External diagnostics booking created successfully',
      data: created,
    });
  };

  retryConsultationPayment = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const result = await this.externalBookingService.retryExternalBookingPayment(
      req.params.id,
      req.user!,
      'doctor',
      {
        useWalletBalance: req.body?.useWalletBalance as boolean | undefined,
        couponCode: req.body?.couponCode as string | undefined,
      }
    );

    res.status(200).json({
      success: true,
      message: result.paymentRequired
        ? 'External booking payment initiated successfully'
        : result.fulfillmentState === 'pending_confirmation'
          ? 'Payment already received. Booking confirmation is pending. Please try again after some time.'
          : 'External booking payment completed successfully',
      data: result,
    });
  };

  retryDiagnosticsBookingPayment = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const result = await this.externalBookingService.retryExternalBookingPayment(
      req.params.id,
      req.user!,
      'diagnostics',
      {
        useWalletBalance: req.body?.useWalletBalance as boolean | undefined,
        couponCode: req.body?.couponCode as string | undefined,
      }
    );

    res.status(200).json({
      success: true,
      message: result.paymentRequired
        ? 'External diagnostics payment initiated successfully'
        : result.fulfillmentState === 'pending_confirmation'
          ? 'Payment already received. Booking confirmation is pending. Please try again after some time.'
          : 'External diagnostics payment completed successfully',
      data: result,
    });
  };

  getCustomerDiagnosticsHistory = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const query: CustomerDiagnosticsHistoryQuery = {
      page: req.query.page === undefined ? 1 : Number(req.query.page),
      limit: req.query.limit === undefined ? 20 : Number(req.query.limit),
    };
    const result = await this.externalBookingService.getCustomerDiagnosticsHistory(req.user, query);
    const body = JSON.stringify({
      success: true,
      data: result.data,
      pagination: { page: result.page, limit: result.limit, total: result.total, totalPages: result.totalPages },
    });
    if (Buffer.byteLength(body, 'utf8') >= 256 * 1024) {
      throw new AppError({ status: 503, code: 'DIAGNOSTICS_PROGRESS_UNAVAILABLE', message: 'Diagnostics booking progress is unavailable' });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).type('application/json').send(body);
  };

  getCustomerDiagnosticsProgress = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const data = await this.externalBookingService.getCustomerDiagnosticsProgress(req.user, req.params.id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json({ success: true, data });
  };

  getBookingReport = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.externalBookingService.getBookingReport(
      req.params.id,
      req.user!,
      'doctor'
    );

    res.status(200).json({
      success: true,
      message: 'External booking report retrieved successfully',
      data,
    });
  };

  getBookingReportDocument = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.externalBookingService.getBookingReportDocument(
      req.params.id,
      req.user!,
      'doctor',
      req.query.documentId as string
    );

    res.status(200).json({
      success: true,
      message: 'External booking report document retrieved successfully',
      data,
    });
  };

  getPaymentDetails = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.externalBookingService.getPaymentDetails(
      req.params.id,
      req.user!
    );

    res.status(200).json({
      success: true,
      message: 'External booking payment details retrieved successfully',
      data,
    });
  };

  getSavedReports = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.externalBookingService.getSavedReports(
      req.params.id,
      req.user!
    );

    res.status(200).json({
      success: true,
      message: 'External booking reports retrieved successfully',
      data,
    });
  };

  getDiagnosticsBookingReport = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.externalBookingService.getDiagnosticsBookingReport(
      req.params.id,
      req.user!
    );

    res.status(200).json({
      success: true,
      message: 'External diagnostics reports retrieved successfully',
      data,
    });
  };

  getDiagnosticsBookingReportDocument = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.externalBookingService.getDiagnosticsBookingReportPdf(
      req.params.id,
      req.user!,
      req.query.reportId as string
    );

    res.status(200).json({
      success: true,
      message: 'External diagnostics report document retrieved successfully',
      data,
    });
  };

  listBookings = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const actor = this.requireBookingActor(req);
    const effectiveUserId = actor.userType === 'admin'
      ? (req.query.userId as string | undefined)
      : actor._id;

    const query: ExternalBookingListQuery = {
      userId: effectiveUserId,
      corporateId: req.query.corporateId as string | undefined,
      integration: req.query.integration === undefined ? undefined : this.resolveIntegration(req.query.integration),
      providerType: req.query.providerType as string | undefined,
      appointmentType: req.query.appointmentType as string | undefined,
      patientName: req.query.patientName as string | undefined,
      bookingDateFrom: req.query.bookingDateFrom as string | undefined,
      bookingDateTo: req.query.bookingDateTo as string | undefined,
      status: req.query.status as
        | 'created'
        | 'pending'
        | 'pending_payment'
        | 'confirmed'
        | 'completed'
        | 'cancelled'
        | 'rescheduled'
        | 'report_delivered'
        | undefined,
      paymentStatus: req.query.paymentStatus as
        | 'pending'
        | 'paid'
        | 'cancelled'
        | 'refunded'
        | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit
        ? parseInt(req.query.limit as string, 10)
        : undefined,
    };

    const result = await this.externalBookingService.listBookings(query);

    if (result.total !== undefined) {
      res.status(200).json({
        success: true,
        data: result.data,
        pagination: {
          page: result.page,
          limit: query.limit,
          total: result.total,
          totalPages: result.totalPages,
        },
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: result.data,
    });
  };

  getById = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const actor = this.requireBookingActor(req);
    const booking = await this.externalBookingService.getBookingById(req.params.id, actor);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json({ success: true, data: booking });
  };

  cancelBooking = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const id = req.params.id;
    const body: CancelExternalBookingRequest = req.body;
    const data = await this.externalBookingService.cancelBooking(
      id,
      req.user!,
      body,
      'doctor'
    );

    res.status(data.status === 'cancelled' ? 200 : 202).json({
      success: true,
      message: data.status === 'cancelled' ? 'External booking cancelled successfully'
        : 'Cancellation requested; it completes once the provider confirms it',
      data,
    });
  };

  reconcileCancellation = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.externalBookingService.reconcileCancellation(req.params.id, req.user!,
      req.body.providerOutcome as 'absent' | 'cancelled');
    res.status(200).json({
      success: true,
      message: data.status === 'cancelled' ? 'External booking cancelled' : 'External booking cancellation is still pending',
      data,
    });
  };

  rescheduleBooking = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const id = req.params.id;
    const body: RescheduleExternalBookingRequest = req.body;
    const data = await this.externalBookingService.rescheduleBooking(
      id,
      req.user!,
      body,
      'doctor'
    );

    res.status(200).json({
      success: true,
      message: 'External booking rescheduled successfully',
      data,
    });
  };

  cancelDiagnosticsBooking = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const id = req.params.id;
    const body: CancelExternalBookingRequest = req.body;
    const data = await this.externalBookingService.cancelBooking(
      id,
      req.user!,
      body,
      'diagnostics'
    );

    res.status(data.status === 'cancelled' ? 200 : 202).json({
      success: true,
      message: data.status === 'cancelled' ? 'External diagnostics booking cancelled successfully'
        : 'Cancellation requested; it completes once the provider confirms it',
      data,
    });
  };

  rescheduleDiagnosticsBooking = async (
    req: AuthRequest,
    res: Response,
    _next: NextFunction
  ) => {
    const id = req.params.id;
    const body: RescheduleExternalDiagnosticsBookingRequest = req.body;
    const data = await this.externalBookingService.rescheduleBooking(
      id,
      req.user!,
      body,
      'diagnostics'
    );

    res.status(200).json({
      success: true,
      message: 'External diagnostics booking rescheduled successfully',
      data,
    });
  };

  private toStringArray(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
      const list = value
        .map((item) => String(item).trim())
        .filter(Boolean);
      return list.length ? list : undefined;
    }

    if (typeof value === 'string') {
      const list = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      return list.length ? list : undefined;
    }

    return undefined;
  }
}
