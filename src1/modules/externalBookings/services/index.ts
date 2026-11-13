import fs from 'fs';
import path from 'path';
import { Service } from 'typedi';
import { ExternalBookingLocalOperations, publicExternalBooking } from './localOperations';
import { bookingMoneyPaise } from '@/modules/bookings/services/localOperations';
import { enforceUserCancellationWindow } from '@/modules/common/utils/cancellationWindow';

import { CONFIG } from '@/config/config';
import {
  LabstackProvider,
  LabstackService,
} from '@/modules/bookings/services/labstack';
import { HealthiansService } from '@/modules/bookings/services/healthians';
import { CouponService } from '@/modules/coupon/services';
import { PaymentService } from '@/modules/payment/services';
import { PaymentRepository } from '@/modules/payment/repository';
import { EmailService } from '@/modules/email/services';
import UserModel from '@/modules/user/model';
import { UserRepository } from '@/modules/user/repository';
import { computeDiagnosticsOrderAmount } from '@/modules/externalBookings/services/diagnosticsPricing';
import {
  buildExternalBookingEmailContent,
  ExternalBookingEmailTemplate,
} from '@/modules/externalBookings/emailTemplates';
import { getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import { AppError } from '@/modules/common/types';
import {
  WalletRepository,
  WalletTransactionRepository,
} from '@/modules/wallet/repository';
import { ExternalBookingRepository } from '@/modules/externalBookings/repository';
import logger from '@/services/logger';
import { ExternalCatalogItemRepository } from '@/modules/externalCatalogItems/repository';
import {
  ExternalCatalogItemType,
  IExternalCatalogItem,
} from '@/modules/externalCatalogItems/types';
import {
  CustomerDiagnosticsProgress,
  CustomerDiagnosticsHistoryPage,
  CancelExternalBookingRequest,
  CreateExternalDiagnosticsBookingRequest,
  CreateExternalBookingRequest,
  ExternalBookingPaymentDetailsResponse,
  ExternalDiagnosticsSlotsQuery,
  ExternalBookingListQuery,
  ExternalBookingReportDetails,
  ExternalBookingSavedReportsResponse,
  ExternalLabsQuery,
  ExternalPackageQuery,
  ExternalPackagesQuery,
  ExternalPackagePreparationsQuery,
  ExternalServiceabilityQuery,
  ExternalSlotsQuery,
  ExternalSpecialistsQuery,
  ExternalTestQuery,
  ExternalTestsQuery,
  IExternalBooking,
  IExternalLab,
  IExternalPackage,
  IExternalSpecialist,
  IExternalTest,
  ExternalBookingPaymentInitResponse,
  ExternalIntegration,
  ProviderTypesQuery,
  RescheduleExternalBookingRequest,
  RescheduleExternalDiagnosticsBookingRequest,
} from '@/modules/externalBookings/types';

type ExternalBookingActor = {
  _id: string;
  corporateId?: string;
  userType: string;
};

type ExternalBookingKind = 'doctor' | 'diagnostics';

export interface ExternalBookingWebhookSyncResult {
  matched: boolean;
  action:
    | 'ignored'
    | 'updated'
    | 'cancelled'
    | 'completed'
    | 'rescheduled';
  reason?: string;
  externalBookingId?: string;
  normalizedStatus?: string;
  booking?: IExternalBooking;
}

export interface ExternalDiagnosticsReportDocumentResult {
  integration: ExternalIntegration;
  fileUrl?: string;
  fileName?: string;
  payload?: Record<string, unknown>;
}

@Service()
export class ExternalBookingService {
  private readonly localOperations = new ExternalBookingLocalOperations();

  private readonly defaultIntegration: ExternalIntegration =
    CONFIG.EXTERNAL_BOOKING_DEFAULT_INTEGRATION || 'labstack';

  constructor(
    private externalBookingRepository: ExternalBookingRepository,
    private labstackService: LabstackService,
    private healthiansService: HealthiansService,
    private couponService: CouponService,
    private paymentService: PaymentService,
    private paymentRepository: PaymentRepository,
    _walletRepository: WalletRepository,
    private walletTransactionRepository: WalletTransactionRepository,
    private userRepository: UserRepository,
    private emailService: EmailService,
    private externalCatalogItemRepository: ExternalCatalogItemRepository
  ) {}

  private resolveIntegration(
    integration?: string | null
  ): ExternalIntegration {
    const resolved = (integration || this.defaultIntegration) as ExternalIntegration;
    this.ensureSupportedIntegration(resolved);
    return resolved;
  }

  private getDiagnosticsProviderClient(integration: ExternalIntegration) {
    return integration === 'healthians'
      ? this.healthiansService
      : this.labstackService;
  }

  private async sendExternalBookingEmailNotification(
    booking: IExternalBooking,
    template: ExternalBookingEmailTemplate,
    options: { oldBookingDate?: string; oldBookingTime?: string } = {}
  ): Promise<void> {
    try {
      const recipients = new Set<string>();
      if (booking.patientEmail?.trim()) {
        recipients.add(booking.patientEmail.trim());
      }

      const user = await this.userRepository.findById(booking.userId);
      if (user?.email?.trim()) {
        recipients.add(user.email.trim());
      }

      if (!recipients.size) {
        return;
      }

      const content = buildExternalBookingEmailContent({
        booking,
        template,
        oldBookingDate: options.oldBookingDate,
        oldBookingTime: options.oldBookingTime,
        userName: booking.patientName || user?.name,
      });

      await this.emailService.sendEmail({
        to: Array.from(recipients),
        subject: content.subject,
        textBody: content.textBody,
        htmlBody: content.htmlBody,
      });
    } catch (error) {
      logger.error('[ExternalBooking] failed to send lifecycle email', {
        bookingId: booking._id,
        template,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async markExternalBookingConfirmationPending(booking: IExternalBooking, _message: string): Promise<IExternalBooking> {
    // The attempt adapter already persisted the unknown result. Never rewrite a concurrent cancellation.
    const current = await this.externalBookingRepository.findById(String(booking._id));
    if (!current) throw new AppError({ status: 404, code: 'EXTERNAL_BOOKING_NOT_FOUND', message: 'External booking not found' });
    return publicExternalBooking(current as IExternalBooking);
  }

  private isRecoverablePaidBookingTimeout(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes('timeout') || message.includes('status code 5');
  }

  private async recoverPaidExternalBookingIfNeeded(
    booking: IExternalBooking,
    paymentRecordId?: string
  ): Promise<ExternalBookingPaymentInitResponse | null> {
    if (!paymentRecordId) {
      return null;
    }

    const paymentRecord = await this.paymentRepository.findById(paymentRecordId);
    if (!paymentRecord || paymentRecord.context !== 'external_booking') {
      return null;
    }

    if (paymentRecord.status !== 'paid') {
      return null;
    }

    logger.info('[ExternalBooking] paid booking recovery check', {
      bookingId: booking._id,
      paymentTransactionId: paymentRecord._id,
      bookingStatus: booking.status,
      bookingPaymentStatus: booking.paymentStatus,
      paymentStatus: paymentRecord.status,
      isProcessed: paymentRecord.isProcessed,
    });

    try {
      const recovered = await this.paymentService.recoverExternalBookingPayment(
        paymentRecord
      );
      logger.info('[ExternalBooking] paid booking recovery success', {
        bookingId: booking._id,
        paymentTransactionId: paymentRecord._id,
      });
      return {
        booking: recovered.entity as IExternalBooking,
        paymentRequired: false,
        walletDeductedAmount: Number(
          paymentRecord.notes?.walletDeductedAmount ?? 0
        ),
        fulfillmentState: await this.localOperations.fulfillmentState(String(booking._id)),
      };
    } catch (error) {
      if (!this.isRecoverablePaidBookingTimeout(error)) {
        logger.error('[ExternalBooking] paid booking recovery failed', {
          bookingId: booking._id,
          paymentTransactionId: paymentRecord._id,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const pendingBooking =
        await this.markExternalBookingConfirmationPending(
          booking,
          error instanceof Error ? error.message : String(error)
        );

      return {
        booking: pendingBooking,
        paymentRequired: false,
        walletDeductedAmount: Number(
          paymentRecord.notes?.walletDeductedAmount ?? 0
        ),
        fulfillmentState: 'pending_confirmation',
      };
    }
  }

  private async deductWalletForExternal(params: {
    userId: string; externalBookingId: string; setupToken: string; amountToDeductFromWallet: number; useWalletBalance?: boolean;
  }): Promise<number> {
    if (!params.useWalletBalance || params.amountToDeductFromWallet <= 0) return 0;
    return this.localOperations.debitWallet(params.externalBookingId, params.userId, params.setupToken, params.amountToDeductFromWallet);
  }

  /** Shared by create (pay now) and retry-payment (pay later). */
  private buildExternalPaymentOrderNotes(
    kind: ExternalBookingKind,
    booking: Pick<IExternalBooking, 'appointmentType' | 'providerType'>
  ): Record<string, unknown> {
    if (kind === 'diagnostics') {
      return {
        flow: 'external_diagnostics',
        orderType: booking.appointmentType,
      };
    }
    return {
      flow: 'external_consultation',
      appointmentType: booking.appointmentType,
      providerType: booking.providerType,
    };
  }

  private async finalizeExternalPaymentSettlement(params: {
    userId: string; bookingId: string; grossAmount: number; discountAmount: number; couponCode?: string;
    walletAlreadyApplied: number; attemptUseWalletBalance?: boolean; orderNotes: Record<string, unknown>;
  }): Promise<ExternalBookingPaymentInitResponse> {
    const setup = await this.localOperations.beginSetup(params.bookingId, { _id: params.userId, userType: 'user' });
    const token = setup.localEffects!.setupToken!;
    let failed = true;
    let linked: IExternalBooking;
    let payment: Awaited<ReturnType<PaymentService['createDirectPaidTransaction']>>;
    let response: ExternalBookingPaymentInitResponse;
    try {
      const gross = bookingMoneyPaise(params.grossAmount) - bookingMoneyPaise(params.discountAmount);
      const prior = setup.localEffects!.walletDebitedPaise;
      if (gross < prior) throw new AppError({ status: 409, code: 'EXTERNAL_BOOKING_RECONCILIATION_REQUIRED', message: 'Existing wallet funding exceeds this price' });
      const extra = await this.deductWalletForExternal({ userId: params.userId, externalBookingId: params.bookingId,
        setupToken: token, amountToDeductFromWallet: (gross - prior) / 100, useWalletBalance: params.attemptUseWalletBalance });
      const wallet = prior + bookingMoneyPaise(extra);
      const payable = (gross - wallet) / 100;
      const notes = { ...params.orderNotes, walletDeductedAmount: wallet / 100, grossAmount: params.grossAmount,
        discountAmount: params.discountAmount, payableAfterCoupon: gross / 100 };
      if (payable <= 0) {
        payment = await this.paymentService.createDirectPaidTransaction({ userId: params.userId, context: 'external_booking',
          contextId: params.bookingId, baseAmount: params.grossAmount, discountAmount: params.discountAmount,
          finalAmount: 0, couponCode: params.couponCode, isProcessed: false, notes });
        linked = await this.localOperations.attachPayment(params.bookingId, token, payment._id!);
        response = { booking: publicExternalBooking(linked), paymentRequired: false, walletDeductedAmount: wallet / 100 };
      } else {
        const order = await this.paymentService.createOrder({ userId: params.userId, context: 'external_booking',
          contextId: params.bookingId, baseAmount: params.grossAmount, discountAmount: params.discountAmount,
          finalAmount: payable, couponCode: params.couponCode, notes });
        payment = order.paymentRecord;
        linked = await this.localOperations.attachPayment(params.bookingId, token, payment._id!);
        response = { booking: publicExternalBooking(linked), paymentRequired: true, walletDeductedAmount: wallet / 100,
          payment: { paymentTransactionId: payment._id!, razorpayOrderId: order.razorpayOrder.id,
            razorpayKeyId: order.razorpayKeyId, amount: payable, currency: order.razorpayOrder.currency,
            baseAmount: params.grossAmount, discountAmount: params.discountAmount, couponCode: params.couponCode,
            walletDeductedAmount: wallet / 100 } };
      }
      failed = false;
    } finally { await this.localOperations.endSetup(params.bookingId, token, failed); }
    if (!response.paymentRequired) {
      const recovered = await this.paymentService.recoverExternalBookingPayment(payment!);
      response.booking = publicExternalBooking(recovered.entity as IExternalBooking);
      response.fulfillmentState = await this.localOperations.fulfillmentState(params.bookingId);
    }
    return response;
  }

  private async settleExternalBookingPayment(params: {
    userId: string;
    savedBookingId: string;
    kind: ExternalBookingKind;
    grossAmount: number;
    corporateId?: string;
    couponCode?: string;
    useWalletBalance?: boolean;
    orderNotes: Record<string, unknown>;
  }): Promise<ExternalBookingPaymentInitResponse> {
    const savedBooking = await this.externalBookingRepository.findById(
      params.savedBookingId
    );

    if (!savedBooking) {
      throw new AppError({
        status: 404,
        code: 'EXTERNAL_BOOKING_NOT_FOUND',
        message: 'External booking not found',
      });
    }

    const couponResult = await this.validateExternalBookingCoupon({
      booking: savedBooking,
      actor: {
        _id: params.userId,
        corporateId: params.corporateId,
        userType: 'user',
      },
      kind: params.kind,
      grossAmount: params.grossAmount,
      couponCode: params.couponCode,
    });

    return this.finalizeExternalPaymentSettlement({
      userId: params.userId,
      bookingId: params.savedBookingId,
      grossAmount: params.grossAmount,
      discountAmount: couponResult.discountAmount,
      couponCode: couponResult.couponCode,
      walletAlreadyApplied: 0,
      attemptUseWalletBalance: params.useWalletBalance,
      orderNotes: params.orderNotes,
    });
  }

  private async validateExternalBookingCoupon(params: {
    booking: IExternalBooking;
    actor: ExternalBookingActor;
    kind: ExternalBookingKind;
    grossAmount: number;
    couponCode?: string;
  }): Promise<{ discountAmount: number; couponCode?: string }> {
    if (!params.couponCode || params.grossAmount <= 0) {
      return { discountAmount: 0 };
    }

    const bookingType =
      params.kind === 'doctor' ? 'external_specialist' : 'external_diagnostics';
    const targetId = params.booking.externalProviderId;
    const bookingMeta =
      params.booking.meta &&
      typeof params.booking.meta === 'object' &&
      !Array.isArray(params.booking.meta)
        ? (params.booking.meta as Record<string, unknown>)
        : {};
    const packageIds = Array.isArray(bookingMeta.packageIds)
      ? bookingMeta.packageIds
          .map((item) => String(item).trim())
          .filter(Boolean)
      : undefined;
    const testIds = Array.isArray(bookingMeta.testIds)
      ? bookingMeta.testIds
          .map((item) => String(item).trim())
          .filter(Boolean)
      : undefined;

    const couponValidation = await this.couponService.validateCoupon({
      code: params.couponCode,
      userId: params.booking.userId,
      bookingType,
      bookingId: targetId,
      packageIds,
      testIds,
      dependentId: params.booking.dependentId,
      corporateId: params.actor.corporateId,
      purchaseAmount: params.grossAmount,
    });

    if (!couponValidation.isValid || !couponValidation.coupon) {
      throw new AppError({
        status: 400,
        code: 'INVALID_COUPON',
        message: couponValidation.message || 'Coupon is not valid',
      });
    }

    return {
      discountAmount: (() => {
        const raw = couponValidation.discountAmount ?? 0;
        const rounded = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 100) : NaN;
        if (!Number.isSafeInteger(rounded) || rounded < 0 || rounded > bookingMoneyPaise(params.grossAmount)) {
          throw new AppError({ status: 409, code: 'EXTERNAL_BOOKING_RECONCILIATION_REQUIRED', message: 'Calculated external coupon amount is invalid' });
        }
        return rounded / 100;
      })(),
      couponCode: couponValidation.coupon.code,
    };
  }

  async retryExternalBookingPayment(
    id: string,
    actor: ExternalBookingActor,
    kind: ExternalBookingKind,
    options: { useWalletBalance?: boolean; couponCode?: string } = {}
  ): Promise<ExternalBookingPaymentInitResponse> {
    const booking = await this.getAccessibleBooking(id, actor, kind);

    logger.info('[ExternalBooking] retry-payment requested', {
      bookingId: booking._id,
      userId: booking.userId,
      kind,
      status: booking.status,
      paymentStatus: booking.paymentStatus,
      paymentTransactionId: booking.paymentTransactionId,
      useWalletBalance: options.useWalletBalance,
      couponCode: options.couponCode,
    });

    if (booking.status === 'cancelled') {
      throw new AppError({
        status: 400,
        code: 'EXTERNAL_BOOKING_CANCELLED',
        message: 'Cannot retry payment for a cancelled external booking',
      });
    }

    if (booking.paymentStatus === 'paid') {
      const recovered = await this.recoverPaidExternalBookingIfNeeded(
        booking,
        booking.paymentTransactionId
      );
      if (recovered) {
        return recovered;
      }

      throw new AppError({
        status: 400,
        code: 'EXTERNAL_BOOKING_ALREADY_PAID',
        message: 'External booking is already paid',
      });
    }

    if (booking.status !== 'pending_payment') {
      throw new AppError({
        status: 400,
        code: 'EXTERNAL_BOOKING_NOT_AWAITING_PAYMENT',
        message:
          'Payment retry is only available for bookings awaiting payment',
      });
    }

    let grossAmount = Number(booking.price) || 0;
    let walletAlreadyApplied = 0;

    if (booking.paymentTransactionId) {
      const previous = await this.paymentRepository.findById(
        booking.paymentTransactionId
      );

      if (previous) {
        if (previous.status === 'paid') {
          const recovered = await this.recoverPaidExternalBookingIfNeeded(
            booking,
            previous._id
          );
          if (recovered) {
            return recovered;
          }

          throw new AppError({
            status: 400,
            code: 'EXTERNAL_BOOKING_ALREADY_PAID',
            message: 'External booking is already paid',
          });
        }

        if (previous.baseAmount > 0) {
          grossAmount = previous.baseAmount;
        }
        walletAlreadyApplied = Number(
          previous.notes?.walletDeductedAmount ?? 0
        );
      }
    }

    if (grossAmount <= 0) {
      throw new AppError({
        status: 400,
        code: 'NO_PAYMENT_REQUIRED',
        message: 'No payment is required for this external booking',
      });
    }

    const orderNotes = {
      ...this.buildExternalPaymentOrderNotes(kind, booking),
      retryOfExternalBookingId: id,
    };

    const couponResult = await this.validateExternalBookingCoupon({
      booking,
      actor,
      kind,
      grossAmount,
      couponCode: options.couponCode,
    });

    return this.finalizeExternalPaymentSettlement({
      userId: booking.userId,
      bookingId: id,
      grossAmount,
      discountAmount: couponResult.discountAmount,
      couponCode: couponResult.couponCode,
      walletAlreadyApplied,
      attemptUseWalletBalance: options.useWalletBalance,
      orderNotes,
    });
  }

  async getProviderTypes(query: ProviderTypesQuery): Promise<string[]> {
    const integration = this.resolveIntegration(query.integration);
    const client =
      integration === 'healthians' ? this.healthiansService : this.labstackService;
    return client.getProviderTypes({
      appointmentType: query.appointmentType,
      pincode: query.pincode,
    });
  }

  async getPackages(query: ExternalPackagesQuery): Promise<IExternalPackage[]> {
    const integration = this.resolveIntegration(query.integration);
    const client = this.getDiagnosticsProviderClient(integration) as any;
    const response = await client.getPackages({
      pincode: query.pincode,
      latitude: query.latitude,
      longitude: query.longitude,
    });
    const mapped = response.packages.map((item: Record<string, unknown>) =>
      this.mapPackage(item, integration)
    );
    return this.enrichPackages(mapped, integration);
  }

  async getPackage(query: ExternalPackageQuery): Promise<Record<string, unknown>> {
    const integration = this.resolveIntegration(query.integration);
    const client = this.getDiagnosticsProviderClient(integration) as any;
    const details =
      integration === 'healthians'
        ? await client.getPackageById(query.packageId, {
            pincode: query.pincode,
            latitude: query.latitude,
            longitude: query.longitude,
          })
        : await client.getPackageById(query.packageId, {
            latitude: query.latitude,
            longitude: query.longitude,
          });

    const responsePayload =
      integration === 'healthians'
        ? (() => {
      const packageItem =
        details.packageItem &&
        typeof details.packageItem === 'object' &&
        !Array.isArray(details.packageItem)
          ? (details.packageItem as Record<string, unknown>)
          : {};

      return {
        integration,
        ...packageItem,
        id: query.packageId,
      };
          })()
        : {
            integration,
            ...((details.raw || {}) as Record<string, unknown>),
          };

    return this.enrichCatalogDetail(
      responsePayload,
      integration,
      'package',
      this.mapPackage(responsePayload, integration)
    );
  }

  async getTests(query: ExternalTestsQuery): Promise<IExternalTest[]> {
    const integration = this.resolveIntegration(query.integration);
    const client = this.getDiagnosticsProviderClient(integration) as any;

    let mapped: IExternalTest[] = [];
    if (query.id?.trim()) {
      const details =
        integration === 'healthians'
          ? await client.getTestById(query.id.trim(), {
              pincode: query.pincode,
              latitude: query.latitude,
              longitude: query.longitude,
            })
          : await client.getTestById(query.id.trim(), {
              latitude: query.latitude,
              longitude: query.longitude,
            });
      if (details.testItem) {
        mapped = [this.mapTest(details.testItem, integration)];
      }
    } else {
      const response = await client.getTests({
        pincode: query.pincode,
        latitude: query.latitude,
        longitude: query.longitude,
      });
      mapped = response.tests.map((item: Record<string, unknown>) =>
        this.mapTest(item, integration)
      );
    }

    if (query.search?.trim()) {
      const term = query.search.trim().toLowerCase();
      mapped = mapped.filter(
        (test) =>
          test.name.toLowerCase().includes(term) ||
          test.id.toLowerCase().includes(term) ||
          (test.category || '').toLowerCase().includes(term)
      );
    }

    return this.enrichTests(mapped, integration);
  }

  async getTest(query: ExternalTestQuery): Promise<Record<string, unknown>> {
    const integration = this.resolveIntegration(query.integration);
    const client = this.getDiagnosticsProviderClient(integration) as any;
    const details =
      integration === 'healthians'
        ? await client.getTestById(query.testId, {
            pincode: query.pincode,
            latitude: query.latitude,
            longitude: query.longitude,
          })
        : await client.getTestById(query.testId, {
            latitude: query.latitude,
            longitude: query.longitude,
          });

    const responsePayload =
      integration === 'healthians'
        ? (() => {
      const testItem =
        details.testItem &&
        typeof details.testItem === 'object' &&
        !Array.isArray(details.testItem)
          ? (details.testItem as Record<string, unknown>)
          : {};

      return {
        integration,
        ...testItem,
        id: query.testId,
      };
          })()
        : {
            integration,
            ...((details.raw || {}) as Record<string, unknown>),
          };

    return this.enrichCatalogDetail(
      responsePayload,
      integration,
      'test',
      this.mapTest(responsePayload, integration)
    );
  }

  async getLabs(query: ExternalLabsQuery): Promise<IExternalLab[]> {
    const integration = this.resolveIntegration(query.integration);
    const client = this.getDiagnosticsProviderClient(integration) as any;
    const response = await client.getLabs({
      pincode: query.pincode,
      latitude: undefined,
      longitude: undefined,
    });
    let mapped = response.labs.map((item: Record<string, unknown>) =>
      this.mapLab(item, integration)
    );

    if (query.labId?.trim()) {
      const labId = query.labId.trim();
      mapped = mapped.filter((lab: IExternalLab) => {
        const metaLabId =
          lab.meta && typeof lab.meta === 'object'
            ? this.getFirstString(lab.meta, ['labId', 'lsLabId', 'id'])
            : undefined;
        return lab.id === labId || metaLabId === labId;
      });
    }

    if (query.city?.trim()) {
      const cityTerm = query.city.trim().toLowerCase();
      mapped = mapped.filter(
        (lab: IExternalLab) => (lab.city || '').trim().toLowerCase() === cityTerm
      );
    }

    if (query.search?.trim()) {
      const term = query.search.trim().toLowerCase();
      mapped = mapped.filter(
        (lab: IExternalLab) =>
          lab.name.toLowerCase().includes(term) ||
          lab.id.toLowerCase().includes(term) ||
          (lab.city || '').toLowerCase().includes(term) ||
          (lab.state || '').toLowerCase().includes(term)
      );
    }

    return mapped;
  }

  async getServiceability(
    query: ExternalServiceabilityQuery
  ): Promise<Record<string, unknown>> {
    const integration = this.resolveIntegration(query.integration);
    const client = this.getDiagnosticsProviderClient(integration) as any;
    return client.checkServiceability({
      pincode: query.pincode,
      latitude: query.latitude,
      longitude: query.longitude,
      packageIds: query.packageIds,
      testIds: query.testIds,
    });
  }

  async getPackagePreparations(
    query: ExternalPackagePreparationsQuery
  ): Promise<Record<string, unknown>> {
    const integration = this.resolveIntegration(query.integration);
    if (integration === 'healthians') {
      return {
        packageId: query.packageId,
        preparations: [],
        raw: {},
      };
    }
    const response = await this.labstackService.getPackagePreparations(query.packageId);

    return {
      packageId: query.packageId,
      preparations: response.preparations,
      raw: response.raw,
    };
  }

  async getDiagnosticsSlots(
    query: ExternalDiagnosticsSlotsQuery
  ): Promise<Record<string, unknown>> {
    const integration = this.resolveIntegration(query.integration);
    const client = this.getDiagnosticsProviderClient(integration) as any;
    const response = await client.getDiagnosticsSlots({
      bookingDate: query.bookingDate,
      pincode: query.pincode,
      latitude: query.latitude,
      longitude: query.longitude,
      packageIds: query.packageIds,
      testIds: query.testIds,
    });

    if (
      integration !== 'healthians' &&
      response.raw &&
      typeof response.raw === 'object' &&
      !Array.isArray(response.raw)
    ) {
      return query.labId
        ? this.filterDiagnosticsSlotResponse(
            response.raw as Record<string, unknown>,
            query.labId,
            integration
          )
        : {
            integration,
            ...(response.raw as Record<string, unknown>),
          };
    }

    const filteredSlots =
      query.labId && integration !== 'healthians'
        ? response.slots.filter(
            (slot: { labId?: string; externalProviderId: string }) =>
              String(slot.labId || slot.externalProviderId) === query.labId
          )
        : query.labId && integration === 'healthians'
          ? this.filterHealthiansDiagnosticsSlotsByLabId(
              response.slots,
              query.labId
            )
          : response.slots;

    const normalizedSlots = filteredSlots.map(
      (slot: {
        externalProviderId: string;
        date: string;
        startTime24h: string;
        endTime24h?: string;
        startTimeDisplay: string;
        raw?: Record<string, unknown>;
      }) => ({
        id:
          this.getFirstString(slot.raw || {}, [
            'stm_id',
            'slot_id',
            'id',
          ]) ||
          `${slot.externalProviderId}-${slot.date}-${slot.startTime24h}`,
        integration,
        bookingDate: query.bookingDate,
        externalProviderId: slot.externalProviderId,
        labId:
          this.getFirstString(slot.raw || {}, ['zone_id', 'lab_id', 'id']) ||
          slot.externalProviderId,
        startTime: slot.startTime24h,
        endTime: slot.endTime24h,
        displayTime: slot.startTimeDisplay,
        available:
          this.getFirstNumber(slot.raw || {}, [
            'free_count_slot_count',
            'available_count',
          ]) !== 0,
        meta: slot.raw || {},
      })
    );

    return {
      integration,
      status: 'success',
      date: query.bookingDate,
      message: `Found ${normalizedSlots.length} Slots`,
      slots: normalizedSlots,
      raw:
        integration === 'healthians' &&
        response.raw &&
        typeof response.raw === 'object' &&
        !Array.isArray(response.raw)
          ? (response.raw as Record<string, unknown>)
          : undefined,
    };
  }

  async getSpecialists(
    query: ExternalSpecialistsQuery,
    _userId?: string
  ): Promise<IExternalSpecialist[]> {
    const integration = this.resolveIntegration(query.integration);
    const providerResponse =
      integration === 'healthians'
        ? await this.healthiansService.getProviders({
            speciality: query.speciality || query.providerType,
          })
        : await this.labstackService.getProviders({
            providerType: query.providerType,
            appointmentType: query.appointmentType,
            speciality: query.speciality,
            subSpeciality: query.subSpeciality,
            preferredGender: query.preferredGender,
            pincode: query.pincode,
            latitude: query.latitude,
            longitude: query.longitude,
          });

    return providerResponse.providers.map((provider) =>
      this.mapProviderToSpecialist(provider, query, integration)
    );
  }

  async getSlots(query: ExternalSlotsQuery): Promise<Record<string, unknown>> {
    const integration = this.resolveIntegration(query.integration);
    const slotResponse =
      integration === 'healthians'
        ? await this.healthiansService.getGenericSlots({
            externalProviderId: query.externalProviderId,
            bookingDate: query.bookingDate,
          })
        : await this.labstackService.getGenericSlots({
            providerType: query.providerType,
            appointmentType: query.appointmentType,
            externalProviderId: query.externalProviderId,
            bookingDate: query.bookingDate,
            pincode: query.pincode,
            latitude: query.latitude,
            longitude: query.longitude,
          });
    if (
      integration !== 'healthians' &&
      slotResponse.raw &&
      typeof slotResponse.raw === 'object' &&
      !Array.isArray(slotResponse.raw)
    ) {
      return this.filterProviderSlotResponse(
            slotResponse.raw as Record<string, unknown>,
            query.externalProviderId,
            integration
          );
    }

    const filteredSlots =
      integration === 'healthians'
        ? this.filterHealthiansGenericSlotsByProviderId(
            slotResponse.slots,
            query.externalProviderId
          )
        : slotResponse.slots.filter(
            (slot) => String(slot.externalProviderId) === query.externalProviderId
          );

    return {
      integration,
      status: 'success',
      date: query.bookingDate,
      message: `Found ${filteredSlots.length} Slots`,
      slots: filteredSlots,
      raw:
        integration === 'healthians' &&
        slotResponse.raw &&
        typeof slotResponse.raw === 'object' &&
        !Array.isArray(slotResponse.raw)
          ? (slotResponse.raw as Record<string, unknown>)
          : undefined,
    };
  }

  async createBooking(
    data: CreateExternalBookingRequest
  ): Promise<ExternalBookingPaymentInitResponse> {
    const integration = this.resolveIntegration(data.integration);

    const effectiveSlotTime = data.selectedSlotTime || data.bookingTime;
    if (!effectiveSlotTime) {
      throw new AppError({
        status: 400,
        code: 'EXTERNAL_SLOT_TIME_REQUIRED',
        message: 'selectedSlotTime is required',
      });
    }

    const fixedPrice = CONFIG.EXTERNAL_CONSULTATION_FIXED_PRICE ?? 0;
    const paymentRequired = fixedPrice > 0;

    console.log('[ExternalBooking][createBooking] consultation payment decision', {
      configuredFixedPrice: CONFIG.EXTERNAL_CONSULTATION_FIXED_PRICE,
      fixedPrice,
      paymentRequired,
      providerType: data.providerType,
      appointmentType: data.appointmentType,
      consultationMode: data.consultationMode,
      externalProviderId: data.externalProviderId,
      bookingDate: data.bookingDate,
      selectedSlotTime: effectiveSlotTime,
      userId: data.userId,
    });

    if (paymentRequired && !data.externalProviderId?.trim()) {
      throw new AppError({
        status: 400,
        code: 'EXTERNAL_PROVIDER_REQUIRED',
        message: 'externalProviderId is required for paid external consultation',
      });
    }

    const draft = this.buildConsultationBookingDraft(data, effectiveSlotTime, integration, {
      paymentRequired,
      fixedPrice,
    });
    const saved = await this.localOperations.createDraft(draft);

    if (paymentRequired) {
      return this.settleExternalBookingPayment({
        userId: data.userId,
        savedBookingId: String(saved._id),
        kind: 'doctor',
        grossAmount: fixedPrice,
        corporateId: data.corporateId,
        couponCode: data.couponCode,
        useWalletBalance: data.useWalletBalance,
        orderNotes: this.buildExternalPaymentOrderNotes('doctor', {
          appointmentType: data.appointmentType,
          providerType: data.providerType,
        }),
      });
    }

    const admission = await this.localOperations.beginProvider(String(saved._id));
    try {
      const booking = await this.applyLabstackConsultationToDraft(
        saved as IExternalBooking,
        data,
        effectiveSlotTime,
        integration,
        admission.token!
      );
      await this.sendExternalBookingEmailNotification(
        booking,
        'ORDER_SCHEDULED'
      );
      return {
        booking: publicExternalBooking(booking),
        paymentRequired: false,
        walletDeductedAmount: 0,
      };
    } catch (err) {
      logger.error('[ExternalBooking] final consultation booking failed', {
        bookingId: saved._id,
        integration,
        providerId: data.externalProviderId,
        bookingDate: data.bookingDate,
        bookingTime: effectiveSlotTime,
        pincode: data.pincode,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.localOperations.failProvider(String(saved._id), admission.token!, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private buildConsultationBookingDraft(
    data: CreateExternalBookingRequest,
    effectiveSlotTime: string,
    integration: ExternalIntegration,
    opts: { paymentRequired: boolean; fixedPrice: number }
  ): IExternalBooking {
    const meta: Record<string, unknown> = {
      primaryConcern: data.primaryConcern,
      notes: data.notes,
      requestMeta: data.meta,
      consultationMode: data.consultationMode || 'chat',
      patientGender: data.patientGender,
      patientAge: data.patientAge,
      patientDateOfBirth: data.patientDateOfBirth,
      pincode: data.pincode,
      city: data.city,
      state: data.state,
      addressLine: data.addressLine,
      address: data.address,
    };
    if (opts.paymentRequired) {
      meta.pendingLabstack = true;
    }

    return {
      userId: data.userId,
      dependentId: data.dependentId,
      corporateId: data.corporateId,
      integration,
      providerType: data.providerType,
      appointmentType: data.appointmentType,
      externalProviderId: opts.paymentRequired
        ? data.externalProviderId!.trim()
        : data.externalProviderId?.trim() || '',
      bookingDate: data.bookingDate,
      bookingTime: effectiveSlotTime,
      patientName: data.patientName,
      patientEmail: data.patientEmail,
      patientPhone: data.patientPhone,
      doctorName: data.doctorName?.trim() || undefined,
      labName: data.labName?.trim() || undefined,
      address: data.address?.trim(),
      status: opts.paymentRequired ? 'pending_payment' : 'pending',
      ...(opts.paymentRequired
        ? {
            paymentStatus: 'pending' as const,
            price: opts.fixedPrice,
          }
        : {}),
      meta,
    };
  }

  private async applyLabstackConsultationToDraft(
    draft: IExternalBooking,
    data: CreateExternalBookingRequest,
    effectiveSlotTime: string,
    integration: ExternalIntegration,
    providerToken: string
  ): Promise<IExternalBooking> {
    await this.localOperations.assertProviderAttempt(String(draft._id), providerToken);
    const splitName = this.splitName(data.patientName);
    const uniqueId = this.buildLabstackUniqueId({
      name: data.patientName,
      mobile: data.patientPhone,
      email: data.patientEmail,
      userId: data.userId,
    });

    const result =
      integration === 'healthians'
        ? await this.healthiansService.createConsultationBooking({
          bookingDate: data.bookingDate,
          bookingTime: effectiveSlotTime,
          userUniqueId: uniqueId,
          firstName: splitName.firstName,
          lastName: splitName.lastName,
          email: data.patientEmail,
          mobile: data.patientPhone,
          gender: data.patientGender,
          age: data.patientAge,
          dateOfBirth: data.patientDateOfBirth,
          selectedProviderId: data.externalProviderId,
          selectedSlotTime: effectiveSlotTime,
        })
        : await this.labstackService.createConsultationBooking({
          bookingDate: data.bookingDate,
          bookingTime: effectiveSlotTime,
          consultationMode: data.consultationMode || 'chat',
          userUniqueId: uniqueId,
          referenceId: String(draft._id),
          firstName: splitName.firstName,
          lastName: splitName.lastName,
          email: data.patientEmail,
          mobile: data.patientPhone,
          gender: data.patientGender,
          age: data.patientAge,
          dateOfBirth: data.patientDateOfBirth,
          primaryConcern: data.primaryConcern,
          selectedProviderId: data.externalProviderId,
          selectedSlotTime: effectiveSlotTime,
          pincode: data.pincode,
          city: data.city,
          state: data.state,
          addressLine: data.addressLine,
          address: data.address,
        });

    const priorMeta =
      draft.meta && typeof draft.meta === 'object' && !Array.isArray(draft.meta)
        ? (draft.meta as Record<string, unknown>)
        : {};

    const updated = await this.localOperations.recordProviderResult(
      String(draft._id), providerToken,
      {
        externalProviderId:
          result.externalProviderId || data.externalProviderId || '',
        externalBookingId: result.externalBookingId,
        externalSlotRef: result.externalSlotTime,
        meetingLink: result.meetingLink,
        price: draft.price ?? 0,
        paymentStatus: draft.paymentStatus || 'paid',
        status: result.externalStatus,
        meta: {
          ...priorMeta,
          externalPayload: result.payload,
        },
      }
    );

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'EXTERNAL_BOOKING_UPDATE_FAILED',
        message: 'Failed to update external booking after Labstack confirmation',
      });
    }

    return updated as IExternalBooking;
  }

  async createDiagnosticsBooking(
    data: CreateExternalDiagnosticsBookingRequest
  ): Promise<ExternalBookingPaymentInitResponse> {
    const integration = this.resolveIntegration(data.integration);

    const payableTotal = await computeDiagnosticsOrderAmount(
      this.getDiagnosticsProviderClient(integration),
      this.externalCatalogItemRepository,
      integration,
      data.labId,
      data.packageIds,
      data.testIds,
      {
        pincode: data.pincode,
        latitude: data.latitude,
        longitude: data.longitude,
      }
    );
    const paymentRequired = payableTotal > 0;

    const draft = this.buildDiagnosticsDraft(data, integration, {
      paymentRequired,
      total: payableTotal,
    });
    const saved = await this.localOperations.createDraft(draft);
    const prepared = saved;

    if (paymentRequired) {
      return this.settleExternalBookingPayment({
        userId: data.userId,
        savedBookingId: String(prepared._id),
        kind: 'diagnostics',
        grossAmount: payableTotal,
        corporateId: data.corporateId,
        couponCode: data.couponCode,
        useWalletBalance: data.useWalletBalance,
        orderNotes: this.buildExternalPaymentOrderNotes('diagnostics', {
          appointmentType: data.orderType,
          providerType: '',
        }),
      });
    }

    const admission = await this.localOperations.beginProvider(String(prepared._id));
    try {
      const booking = await this.applyDiagnosticsOrderToDraft(
        prepared as IExternalBooking,
        data,
        integration,
        admission.token!
      );
      await this.sendExternalBookingEmailNotification(
        booking,
        'ORDER_SCHEDULED'
      );
      return {
        booking: publicExternalBooking(booking),
        paymentRequired: false,
        walletDeductedAmount: 0,
      };
    } catch (err) {
      logger.error('[ExternalBooking] final diagnostics booking failed', {
        bookingId: prepared._id,
        integration,
        labId: data.labId,
        bookingDate: data.bookingDate,
        bookingTime: data.bookingTime,
        pincode: data.pincode,
        latitude: data.latitude,
        longitude: data.longitude,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.localOperations.failProvider(String(prepared._id), admission.token!, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private buildDiagnosticsDraft(
    data: CreateExternalDiagnosticsBookingRequest,
    integration: ExternalIntegration,
    opts: { paymentRequired: boolean; total: number }
  ): IExternalBooking {
    const labAddress = data.labAddress?.trim();
    const bookingAddress = labAddress || data.address;
    const normalizedAddress = this.normalizeLabstackAddressFields({
      unitFloorBuilding: data.addressLine,
      locality: data.locality,
      address: bookingAddress ?? data.addressLine,
      city: data.city,
      state: data.state,
      pincode: data.pincode,
      requireMinimumLength: false,
    });
    const requestMeta =
      data.meta && typeof data.meta === 'object' && !Array.isArray(data.meta)
        ? (data.meta as Record<string, unknown>)
        : {};

    const meta: Record<string, unknown> = {
      packageIds: data.packageIds,
      testIds: data.testIds,
      stmId: data.stmId,
      vendorBillingUserId: data.userId,
      labId: data.labId,
      notes: data.notes,
      requestMeta,
      patientGender: data.patientGender,
      patientAge: data.patientAge,
      patientDateOfBirth: data.patientDateOfBirth,
      customerRelation: data.customerRelation,
      pincode: data.pincode,
      city: data.city,
      state: data.state,
      stateId:
        data.stateId ??
        this.getFirstNumber(requestMeta, ['state_id', 'stateId']),
      cityId:
        data.cityId ??
        this.getFirstNumber(requestMeta, ['city_id', 'cityId']),
      zoneId:
        data.zoneId ??
        this.getFirstNumber(requestMeta, ['zone_id', 'zoneId', 'selectedZoneId']),
      locality: normalizedAddress.locality ?? data.locality,
      addressLine: normalizedAddress.unitFloorBuilding ?? data.addressLine,
      address: labAddress || normalizedAddress.address || bookingAddress,
      labAddress,
      landmark: data.landmark,
      latitude: data.latitude,
      longitude: data.longitude,
      altContact: data.altContact,
      altEmail: data.altEmail,
      hardCopy: data.hardCopy,
      applicationNumber: data.applicationNumber,
      customerRemarks: data.customerRemarks,
      paymentOption: data.paymentOption,
      isPpmcBooking: data.isPpmcBooking,
    };
    if (opts.paymentRequired && integration === 'healthians') {
      meta.pendingHealthians = true;
    } else if (opts.paymentRequired) {
      meta.pendingLabstack = true;
    }

    return {
      userId: data.userId,
      dependentId: data.dependentId,
      corporateId: data.corporateId,
      integration,
      providerType: 'DIAGNOSTICS',
      appointmentType: data.orderType,
      externalProviderId:
        data.labId?.trim() || (integration === 'healthians' ? 'healthians' : 'labstack'),
      externalSlotRef: data.stmId?.trim() || undefined,
      bookingDate: data.bookingDate,
      bookingTime: data.bookingTime,
      patientName: data.patientName,
      patientEmail: data.patientEmail,
      patientPhone: data.patientPhone,
      doctorName: data.doctorName?.trim() || undefined,
      labName: data.labName?.trim() || undefined,
      packageNames: data.packageNames?.map((item) => item.trim()).filter(Boolean),
      testNames: data.testNames?.map((item) => item.trim()).filter(Boolean),
      address: labAddress || normalizedAddress.address || bookingAddress?.trim(),
      status: opts.paymentRequired ? 'pending_payment' : 'pending',
      ...(opts.paymentRequired
        ? {
            paymentStatus: 'pending' as const,
            price: opts.total,
          }
        : {}),
      meta,
    };
  }



  private async applyDiagnosticsOrderToDraft(
    draft: IExternalBooking,
    data: CreateExternalDiagnosticsBookingRequest,
    integration: ExternalIntegration,
    providerToken: string
  ): Promise<IExternalBooking> {
    await this.localOperations.assertProviderAttempt(String(draft._id), providerToken);
    if (integration === 'healthians' && data.stmId?.trim()) {
      await this.healthiansService.freezeDiagnosticsSlot({ stmId: data.stmId.trim(), vendorBillingUserId: data.userId });
    }
    const uniqueId = this.buildLabstackUniqueId({
      name: data.patientName,
      mobile: data.patientPhone,
      email: data.patientEmail,
      userId: data.userId,
    });

    const appointment = this.toIsoDateTime(data.bookingDate, data.bookingTime);
    const labAddress = data.labAddress?.trim();
    const bookingAddress = labAddress || data.address;
    const addressFields = this.normalizeLabstackAddressFields({
      unitFloorBuilding: data.addressLine,
      locality: data.locality,
      address: bookingAddress ?? data.addressLine,
      city: data.city,
      state: data.state,
      pincode: data.pincode,
    });


    const priorMeta =
      draft.meta && typeof draft.meta === 'object' && !Array.isArray(draft.meta)
        ? (draft.meta as Record<string, unknown>)
        : {};

    const result =
      integration === 'healthians'
        ? await this.healthiansService.placeDiagnosticsOrder({
            orderType: data.orderType,
            appointment,
            name: data.patientName,
            mobile: data.patientPhone,
            email: data.patientEmail,
            gender: data.patientGender,
            age: data.patientAge,
            dateOfBirth: data.patientDateOfBirth,
            customerRelation: data.customerRelation,
            pincode: data.pincode,
            city: data.city,
            state: data.state,
            stateId: priorMeta.stateId as number | undefined,
            cityId: priorMeta.cityId as number | undefined,
            zoneId: priorMeta.zoneId as number | undefined,
            latitude: data.latitude,
            longitude: data.longitude,
            slotId: data.stmId,
            billingUserId: data.userId,
            address: addressFields.address,
            subLocality:
              addressFields.locality ||
              addressFields.unitFloorBuilding ||
              data.locality ||
              data.address,
            landmark: data.landmark,
            packageIds: data.packageIds,
            testIds: data.testIds,
            uniqueId,
            notes: data.notes,
            altContact: data.altContact,
            altEmail: data.altEmail,
            hardCopy: data.hardCopy,
            vendorBookingId: String(draft._id),
            discountedPrice: draft.price ?? 0,
            paymentOption: data.paymentOption,
            applicationNumber: data.applicationNumber,
            customerRemarks: data.customerRemarks,
            isPpmcBooking: data.isPpmcBooking,
          })
        : await this.labstackService.placeDiagnosticsOrder({
      orderType: data.orderType,
      appointment,
      name: data.patientName,
      mobile: data.patientPhone,
      email: data.patientEmail,
      gender: data.patientGender,
      age: data.patientAge,
      pincode: data.pincode,
      unitFloorBuilding: addressFields.unitFloorBuilding,
      locality: addressFields.locality,
      city: data.city,
      state: data.state,
      latitude: data.latitude,
      longitude: data.longitude,
      address: addressFields.address,
      packageIds: data.packageIds,
      testIds: data.testIds,
      labId: data.labId,
      uniqueId,
      referenceId: String(draft._id),
      notes: data.notes,
      altContact: data.altContact,
    });

    const providerLabMeta =
      integration === 'labstack'
        ? this.extractLabstackLabLocationMeta(result.payload)
        : {};

    const updated = await this.localOperations.recordProviderResult(
      String(draft._id), providerToken,
      {
        externalProviderId:
          data.labId?.trim() || (integration === 'healthians' ? 'healthians' : 'labstack'),
        externalBookingId: result.externalBookingId,
        externalSlotRef: data.stmId?.trim() || draft.externalSlotRef || data.bookingTime,
        price: draft.price ?? 0,
        paymentStatus: draft.paymentStatus || 'paid',
        status: result.externalStatus,
        meta: {
          ...priorMeta,
          pendingHealthians: undefined,
          pendingLabstack: undefined,
          ...providerLabMeta,
          externalPayload: result.payload,
        },
      }
    );

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'EXTERNAL_BOOKING_UPDATE_FAILED',
        message: 'Failed to update external diagnostics booking after Labstack',
      });
    }

    return updated as IExternalBooking;
  }

  private extractLabstackLabLocationMeta(
    payload: Record<string, unknown>
  ): Record<string, unknown> {
    const bookingResponse =
      payload.bookingResponse &&
      typeof payload.bookingResponse === 'object' &&
      !Array.isArray(payload.bookingResponse)
        ? (payload.bookingResponse as Record<string, unknown>)
        : undefined;
    const bookingOrder =
      bookingResponse?.order &&
      typeof bookingResponse.order === 'object' &&
      !Array.isArray(bookingResponse.order)
        ? (bookingResponse.order as Record<string, unknown>)
        : undefined;

    const labAddress =
      (bookingOrder
        ? this.getFirstString(bookingOrder, ['labAddress'])
        : undefined) ||
      (bookingResponse
        ? this.getFirstString(bookingResponse, ['labAddress'])
        : undefined);
    const labLat =
      (bookingOrder
        ? this.getFirstNumber(bookingOrder, ['labLatitude', 'labLat'])
        : undefined) ??
      (bookingResponse
        ? this.getFirstNumber(bookingResponse, ['labLatitude', 'labLat'])
        : undefined);
    const labLong =
      (bookingOrder
        ? this.getFirstNumber(bookingOrder, ['labLongitude', 'labLong'])
        : undefined) ??
      (bookingResponse
        ? this.getFirstNumber(bookingResponse, ['labLongitude', 'labLong'])
        : undefined);

    return {
      ...(labAddress ? { labAddress } : {}),
      ...(labLat !== undefined ? { labLat } : {}),
      ...(labLong !== undefined ? { labLong } : {}),
    };
  }

  private async finishRequestedCancellation(requested: IExternalBooking): Promise<IExternalBooking> {
    const effects = requested.localEffects!;
    const id = String(requested._id);
    if (effects.providerAttempted && !effects.providerCancelAck) {
      if (!effects.providerCompleted || !requested.externalBookingId) {
        throw new AppError({ status: 409, code: 'EXTERNAL_CANCELLATION_PENDING', message: 'Provider outcome is unknown; cancellation needs reconciliation' });
      }
      const result = await this.cancelProviderIfDiscoveredLater(requested, requested.externalBookingId,
        String(requested.meta?.cancellationReason || 'Cancelled by user'));
      if (!this.providerCancellationAcknowledged(requested, requested.externalBookingId, result)) {
        throw new AppError({ status: 409, code: 'EXTERNAL_CANCELLATION_PENDING', message: 'Provider cancellation acknowledgement is pending' });
      }
      await this.localOperations.acknowledgeProviderCancellation(id, effects.cancelToken!, requested.externalBookingId);
    }
    const settled = await this.localOperations.settleCancelled(id, requested.userId);
    await this.sendExternalBookingEmailNotification(settled, 'CANCELED');
    return publicExternalBooking(settled);
  }

  async cancelBooking(id: string, actor: ExternalBookingActor, data: CancelExternalBookingRequest, _kind: ExternalBookingKind): Promise<IExternalBooking> {
    const reason = data.cancellationReason?.trim() || data.reason?.trim() || 'Cancelled by user';
    const requested = await this.localOperations.requestCancellation(id, actor, reason,
      booking => enforceUserCancellationWindow([{ bookingDate: booking.bookingDate, bookingTime: booking.bookingTime }], actor.userType));
    return this.finishRequestedCancellation(requested);
  }

  private async getAccessibleBookingIgnoringKind(
    id: string,
    actor: ExternalBookingActor
  ): Promise<IExternalBooking> {
    const booking = await this.externalBookingRepository.findById(id);

    if (!booking) {
      throw new AppError({
        status: 404,
        code: 'EXTERNAL_BOOKING_NOT_FOUND',
        message: 'External booking not found',
      });
    }

    if (actor.userType !== 'admin' && booking.userId !== actor._id) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'You are not allowed to modify this booking',
      });
    }

    return booking;
  }

  /**
   * Cancels unpaid external bookings older than 30 minutes: optional LabStack cancel,
   * wallet refund for debits tied to this booking, then DB update.
   */
  async cancelStaleUnpaidExternalBookings(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    const [staleUnpaid, stalePaidPending] = await Promise.all([
      this.externalBookingRepository.findStaleUnpaidPending(cutoff),
      this.externalBookingRepository.findStalePaidPendingConfirmation(cutoff),
    ]);

    for (const raw of staleUnpaid) {
      const booking = raw as IExternalBooking;
      const meta = booking.meta as Record<string, unknown> | undefined;
      if (meta?.paymentTimeoutCancelledAt) {
        continue;
      }

      try {
        logger.info('[ExternalBooking] stale unpaid booking cancellation start', {
          bookingId: booking._id,
          paymentTransactionId: booking.paymentTransactionId,
          createdAt: booking.createdAt,
          status: booking.status,
          paymentStatus: booking.paymentStatus,
        });
        await this.processStaleUnpaidExternalBookingCancellation(booking);
      } catch (error) {
        console.error(
          '[ExternalBooking] payment-timeout cancel failed',
          booking._id,
          error
        );
      }
    }

    for (const raw of stalePaidPending) {
      const booking = raw as IExternalBooking;
      const meta = booking.meta as Record<string, unknown> | undefined;
      if (meta?.paymentConfirmationTimedOutAt) {
        continue;
      }

      try {
        logger.info('[ExternalBooking] stale paid confirmation timeout start', {
          bookingId: booking._id,
          paymentTransactionId: booking.paymentTransactionId,
          createdAt: booking.createdAt,
          status: booking.status,
          paymentStatus: booking.paymentStatus,
        });
        await this.processStalePaidConfirmationTimeout(booking);
      } catch (error) {
        console.error(
          '[ExternalBooking] confirmation-timeout cancel failed',
          booking._id,
          error
        );
      }
    }
  }

  private async processStaleUnpaidExternalBookingCancellation(booking: IExternalBooking, reason = 'Payment not completed within 30 minutes'): Promise<void> {
    const requested = await this.localOperations.requestSystemCancellation(String(booking._id), reason, 'unpaid_timeout');
    await this.finishRequestedCancellation(requested);
  }

  private async processStalePaidConfirmationTimeout(booking: IExternalBooking): Promise<void> {
    const requested = await this.localOperations.requestSystemCancellation(String(booking._id), 'Booking confirmation not received within 30 minutes', 'confirmation_timeout');
    await this.finishRequestedCancellation(requested);
  }

  private providerCancellationAcknowledged(booking: IExternalBooking, expectedId: string, result: {
    externalBookingId?: string; externalStatus?: string; payload: unknown;
  }): boolean {
    const record = (value: unknown): Record<string, unknown> =>
      value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const raw = record(result.payload); const data = record(raw.data);
    const records = booking.integration === 'healthians' ? [raw, data]
      : [raw, data, record(raw.appointment), record(raw.order), record(data.appointment), record(data.order)];
    const statuses = booking.integration === 'healthians' ? ['status', 'booking_status']
      : ['status', 'appointmentStatus', 'orderStatus'];
    const ids = booking.integration === 'healthians' ? ['booking_id', 'bookingId', 'id']
      : ['appointmentId', 'lsAppointmentId', 'orderId', 'referenceId', 'id'];
    const cancelled = (value: unknown) => typeof value === 'string' && ['cancelled', 'canceled'].includes(value.trim().toLowerCase());
    if (!cancelled(result.externalStatus) || (result.externalBookingId !== undefined && result.externalBookingId !== expectedId)) return false;
    if ([raw, data].some(item => item.success === false || item.status === false || item.status === 0 ||
        (typeof item.status === 'string' && ['false', '0', 'failed', 'failure', 'error', 'rejected'].includes(item.status.toLowerCase())) ||
        (booking.integration === 'healthians' && item.resCode !== undefined && item.resCode !== 'RES0001'))) return false;
    for (const item of records) for (const key of ids) {
      if (item[key] !== undefined && (typeof item[key] !== 'string' && typeof item[key] !== 'number' || String(item[key]) !== expectedId)) return false;
    }
    return records.some(item => statuses.some(key => cancelled(item[key])));
  }

  private async cancelProviderIfDiscoveredLater(
    booking: IExternalBooking,
    externalBookingId: string,
    reason: string
  ): Promise<{
    externalBookingId?: string;
    externalStatus?: string;
    payload: unknown;
  }> {
    const kind: ExternalBookingKind =
      booking.providerType === 'DIAGNOSTICS' ? 'diagnostics' : 'doctor';

    const result =
      booking.integration === 'healthians'
        ? await this.healthiansService.cancelBooking({
            bookingId: externalBookingId,
            vendorBillingUserId: this.getHealthiansVendorBillingUserId(booking),
            reason,
            uniqueId: this.getHealthiansVendorCustomerId(booking),
          })
        : kind === 'diagnostics'
          ? await this.labstackService.cancelOrder({
              orderId: externalBookingId,
              reason,
            })
          : await this.labstackService.cancelAppointment({
              appointmentId: externalBookingId,
              reason,
            });

    return {
      externalBookingId: result.externalBookingId,
      externalStatus: result.externalStatus,
      payload: result.payload,
    };
  }

  async rescheduleBooking(
    id: string,
    actor: ExternalBookingActor,
    data:
      | RescheduleExternalBookingRequest
      | RescheduleExternalDiagnosticsBookingRequest,
    kind: ExternalBookingKind
  ): Promise<IExternalBooking> {
    const booking = await this.getAccessibleBooking(id, actor, kind);
    const externalAppointmentId = this.getExternalAppointmentId(booking);

    if (
      !externalAppointmentId &&
      booking.status === 'pending_payment' &&
      (kind === 'doctor' || kind === 'diagnostics')
    ) {
      const effectiveBookingTime = this.getEffectiveBookingTime(data);
      return publicExternalBooking(await this.localOperations.rescheduleDraft(id, actor, data.bookingDate, effectiveBookingTime));
    }

    if (!externalAppointmentId) {
      throw new AppError({
        status: 400,
        code: 'EXTERNAL_BOOKING_ID_MISSING',
        message: 'External booking ID is missing',
      });
    }

    const effectiveBookingTime = this.getEffectiveBookingTime(data);
    const oldBookingDate = booking.bookingDate;
    const oldBookingTime = booking.bookingTime;
    const appointment = this.toIsoDateTime(data.bookingDate, effectiveBookingTime);
    const healthiansSlotId =
      booking.integration === 'healthians'
        ? await this.resolveHealthiansRescheduleSlotId(
            booking,
            data.bookingDate,
            effectiveBookingTime,
            kind
          )
        : undefined;

    const admission = await this.localOperations.beginReschedule(id, actor, externalAppointmentId);
    let updated: IExternalBooking;
    try {
      const result =
      booking.integration === 'healthians'
        ? await this.healthiansService.rescheduleBooking({
            bookingId: externalAppointmentId,
            slotId: healthiansSlotId || effectiveBookingTime,
            uniqueId: booking.userId,
            reason:
              (data as RescheduleExternalBookingRequest).selectedSlotTime
                ? 'Rescheduled by user'
                : 'Rescheduled by user',
          })
        : kind === 'diagnostics'
          ? await this.labstackService.rescheduleOrder({
              orderId: externalAppointmentId,
              appointment,
            })
          : await this.labstackService.rescheduleAppointment({
              appointmentId: externalAppointmentId,
              appointmentTime: appointment,
            });

      updated = await this.localOperations.recordProviderResult(id, admission.token, {
        bookingDate: data.bookingDate, bookingTime: effectiveBookingTime,
        externalBookingId: result.externalBookingId || booking.externalBookingId || externalAppointmentId,
        externalSlotRef: effectiveBookingTime, status: result.externalStatus || 'rescheduled',
        meta: { externalPayload: result.payload },
      });
    } catch (error) {
      await this.localOperations.failProvider(id, admission.token, error instanceof Error ? error.message : String(error));
      throw error;
    }

    await this.sendExternalBookingEmailNotification(updated, 'RESCHEDULED', {
      oldBookingDate,
      oldBookingTime,
    });

    return publicExternalBooking(updated);
  }

  private diagnosticsCustomerId(actor: unknown): unknown {
    if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
      throw new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Authentication is required' });
    }
    const principal = actor as Record<string, unknown>;
    if (principal.userType !== 'user') {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Individual customer access is required' });
    }
    return principal._id;
  }

  async getCustomerDiagnosticsProgress(actor: unknown, id: unknown): Promise<CustomerDiagnosticsProgress> {
    const customerId = this.diagnosticsCustomerId(actor);
    return this.externalBookingRepository.findCustomerDiagnosticsProgress(id, customerId);
  }

  async getCustomerDiagnosticsHistory(actor: unknown, query: unknown): Promise<CustomerDiagnosticsHistoryPage> {
    return this.externalBookingRepository.findCustomerDiagnosticsHistory(this.diagnosticsCustomerId(actor), query);
  }

  async getBookingById(id: string, actor: ExternalBookingActor): Promise<IExternalBooking> {
    const booking = await this.externalBookingRepository.findOwnedLocalBooking(id, actor);
    return this.sanitizeBookingForList(booking);
  }

  async listBookings(query: ExternalBookingListQuery): Promise<{
    data: IExternalBooking[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    if (query.page && query.limit) {
      const result = await this.externalBookingRepository.findWithPagination(
        query,
        query.page,
        query.limit
      );
      const bookingsWithCorporateId = await this.attachCorporateIdsToBookings(
        result.data
      );

      return {
        ...result,
        data: bookingsWithCorporateId.map((booking) =>
          this.sanitizeBookingForList(booking)
        ),
      };
    }

    const filter: Record<string, unknown> = {};

    if (query.userId) {
      filter.userId = { $eq: query.userId };
      filter.$expr = { $eq: [{ $type: '$userId' }, 'string'] };
    }
    if (query.corporateId) {
      filter.corporateId = query.corporateId;
    }
    if (query.integration) {
      filter.integration = this.resolveIntegration(query.integration);
    }
    if (query.providerType) {
      filter.providerType = query.providerType;
    }
    if (query.appointmentType) {
      filter.appointmentType = query.appointmentType;
    }
    if (query.patientName) {
      filter.patientName = query.patientName;
    }
    if (query.status) {
      filter.status = query.status;
    }
    if (query.paymentStatus) {
      filter.paymentStatus = query.paymentStatus;
    }
    if (query.bookingDateFrom || query.bookingDateTo) {
      filter.bookingDate = {} as Record<string, string>;
      if (query.bookingDateFrom) {
        (filter.bookingDate as Record<string, string>).$gte = query.bookingDateFrom;
      }
      if (query.bookingDateTo) {
        (filter.bookingDate as Record<string, string>).$lte = query.bookingDateTo;
      }
    }

    const data = await this.externalBookingRepository.findAll(filter, {
      sort: { bookingDate: -1, createdAt: -1 },
    });
    const bookingsWithCorporateId = await this.attachCorporateIdsToBookings(data);

    return {
      data: bookingsWithCorporateId.map((booking) =>
        this.sanitizeBookingForList(booking)
      ),
    };
  }

  async getPaymentDetails(
    id: string,
    actor: ExternalBookingActor
  ): Promise<ExternalBookingPaymentDetailsResponse> {
    const booking = await this.getAccessibleBookingIgnoringKind(id, actor);

    const paymentRecord = booking.paymentTransactionId
      ? await this.paymentRepository.findById(booking.paymentTransactionId)
      : null;

    const walletTransactions =
      await this.walletTransactionRepository.findByReference(
        'external_booking',
        booking._id!
      );
    const invalidHistory = (): never => {
      throw new AppError({ status: 409, code: 'EXTERNAL_BOOKING_RECONCILIATION_REQUIRED', message: 'Booking payment history requires reconciliation' });
    };
    const validatePayment = (payment: NonNullable<typeof paymentRecord>): void => {
      if (!/^[a-f\d]{24}$/i.test(String(payment._id)) || payment.userId !== booking.userId ||
          payment.context !== 'external_booking' || payment.contextId !== String(booking._id) || payment.currency !== 'INR' ||
          !['razorpay', 'internal'].includes(payment.paymentGateway) || !['created', 'paid', 'failed', 'refunded'].includes(payment.status)) invalidHistory();
      const finalPaise = bookingMoneyPaise(payment.finalAmount);
      const basePaise = bookingMoneyPaise(payment.baseAmount);
      const discountPaise = bookingMoneyPaise(payment.discountAmount);
      if (discountPaise > basePaise || finalPaise > basePaise - discountPaise ||
          (payment.finalAmountPaise !== undefined && payment.finalAmountPaise !== finalPaise)) invalidHistory();
    };
    if (booking.paymentTransactionId && (!paymentRecord || String(paymentRecord._id) !== booking.paymentTransactionId)) invalidHistory();
    if (paymentRecord) validatePayment(paymentRecord);
    if (walletTransactions.some(transaction => transaction.userId !== booking.userId || transaction.referenceType !== 'external_booking' ||
        transaction.referenceId !== String(booking._id))) invalidHistory();
    const paymentAttempts = await this.paymentRepository.findAll({ context: 'external_booking', contextId: String(booking._id), userId: booking.userId }, { limit: 129 });
    if (paymentAttempts.length > 128) invalidHistory();
    const uniquePayments = new Map<string, typeof paymentAttempts[number]>();
    for (const attempt of paymentAttempts) {
      validatePayment(attempt);
      const id = String(attempt._id);
      const prior = uniquePayments.get(id);
      if (prior && (prior.finalAmount !== attempt.finalAmount || prior.status !== attempt.status || prior.paymentGateway !== attempt.paymentGateway)) invalidHistory();
      uniquePayments.set(id, attempt);
    }
    if (paymentRecord && !uniquePayments.has(String(paymentRecord._id))) invalidHistory();

    const walletDebitTransactions = walletTransactions.filter(
      (transaction) =>
        transaction.transactionType === 'debit' &&
        transaction.status === 'completed'
    );
    const walletRefundTransactions = walletTransactions.filter(
      (transaction) =>
        transaction.transactionType === 'refund' &&
        transaction.status === 'completed'
    );

    const usedPaise = walletDebitTransactions.reduce((sum, transaction) => sum + bookingMoneyPaise(transaction.amount), 0);
    const refundedPaise = walletRefundTransactions.reduce((sum, transaction) => sum + bookingMoneyPaise(transaction.amount), 0);
    const chargedPaise = [...uniquePayments.values()].reduce((sum, attempt) =>
      sum + (attempt.paymentGateway === 'razorpay' && ['paid', 'refunded'].includes(attempt.status) ? bookingMoneyPaise(attempt.finalAmount) : 0), 0);
    if (![usedPaise, refundedPaise, usedPaise + chargedPaise].every(Number.isSafeInteger)) {
      throw new AppError({ status: 409, code: 'EXTERNAL_BOOKING_RECONCILIATION_REQUIRED', message: 'Booking payment totals exceed the supported range' });
    }
    const amountUsedFromWallet = usedPaise / 100;
    const amountRefunded = refundedPaise / 100;
    const amountChargedToRazorpay = chargedPaise / 100;

    const externalPaymentRecord = paymentRecord;

    return {
      booking: {
        _id: booking._id,
        userId: booking.userId,
        integration: booking.integration,
        providerType: booking.providerType,
        appointmentType: booking.appointmentType,
        bookingDate: booking.bookingDate,
        bookingTime: booking.bookingTime,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        price: Number(booking.price || 0),
        paymentTransactionId: booking.paymentTransactionId,
        externalBookingId: booking.externalBookingId,
      },
      payment: externalPaymentRecord
        ? {
            paymentTransactionId: externalPaymentRecord._id!,
            paymentGateway: externalPaymentRecord.paymentGateway,
            paymentStatus: externalPaymentRecord.status,
            couponCode: externalPaymentRecord.couponCode,
            baseAmount: externalPaymentRecord.baseAmount,
            discountAmount: externalPaymentRecord.discountAmount,
            finalAmount: externalPaymentRecord.finalAmount,
            currency: externalPaymentRecord.currency,
            razorpayOrderId: externalPaymentRecord.razorpayOrderId,
            razorpayPaymentId: externalPaymentRecord.razorpayPaymentId,
            paidAt: externalPaymentRecord.paidAt,
            createdAt: externalPaymentRecord.createdAt,
            updatedAt: externalPaymentRecord.updatedAt,
          }
        : null,
      wallet: {
        amountUsed: amountUsedFromWallet,
        transactions: walletDebitTransactions.map((transaction) => ({
          _id: transaction._id,
          amount: transaction.amount,
          status: transaction.status,
          transactionDate: transaction.transactionDate,
          createdAt: transaction.createdAt,
        })),
      },
      refund: {
        destination: refundedPaise > 0 ? 'internal_wallet' : null,
        amountRefunded,
        transactions: walletRefundTransactions.map((transaction) => ({
          _id: transaction._id,
          amount: transaction.amount,
          status: transaction.status,
          transactionDate: transaction.transactionDate,
          createdAt: transaction.createdAt,
        })),
      },
      summary: {
        couponCode: externalPaymentRecord?.couponCode,
        amountChargedToRazorpay,
        amountUsedFromWallet,
        amountRefunded,
        actualAmountPaid: (chargedPaise + usedPaise) / 100,
        paidAt: externalPaymentRecord?.paidAt,
      },
    };
  }

  async getSavedReports(
    id: string,
    actor: ExternalBookingActor
  ): Promise<ExternalBookingSavedReportsResponse> {
    const booking = await this.getAccessibleBookingIgnoringKind(id, actor);
    const existingReports = Array.isArray(booking.report)
      ? booking.report.filter(
          (url): url is string => typeof url === 'string' && url.trim().length > 0
        )
      : [];

    if (existingReports.length) {
      return {
        booking: {
          _id: booking._id,
          userId: booking.userId,
          providerType: booking.providerType,
          appointmentType: booking.appointmentType,
          status: booking.status,
          externalBookingId: booking.externalBookingId,
        },
        report: existingReports,
        source: 'cached',
      };
    }

    if (booking.status !== 'report_delivered') {
      throw new AppError({
        status: 400,
        code: 'REPORT_NOT_READY',
        message: 'Reports are not available for this booking yet',
      });
    }

    if (booking.providerType !== 'DIAGNOSTICS') {
      throw new AppError({
        status: 400,
        code: 'REPORT_FETCH_UNSUPPORTED',
        message:
          'Report fallback is currently supported only for diagnostics bookings',
      });
    }

    const fetchedReports = await this.persistReportsOnDeliveredWebhook(booking, {});
    if (!fetchedReports.length) {
      throw new AppError({
        status: 404,
        code: 'REPORT_NOT_FOUND',
        message: 'No reports were found for this booking',
      });
    }

    const priorMeta =
      booking.meta && typeof booking.meta === 'object' && !Array.isArray(booking.meta)
        ? (booking.meta as Record<string, unknown>)
        : {};
    const nextMeta: Record<string, unknown> = {
      ...priorMeta,
      reportDeliveredAt:
        (priorMeta.reportDeliveredAt as string | undefined) ||
        new Date().toISOString(),
      reportSync: {
        savedAt: new Date().toISOString(),
        reportCount: fetchedReports.length,
        reportUrls: fetchedReports,
        source: 'fallback_api',
      },
    };

    await this.externalBookingRepository.update(
      { _id: String(booking._id) },
      { report: fetchedReports, meta: nextMeta }
    );

    return {
      booking: {
        _id: booking._id,
        userId: booking.userId,
        providerType: booking.providerType,
        appointmentType: booking.appointmentType,
        status: booking.status,
        externalBookingId: booking.externalBookingId,
      },
      report: fetchedReports,
      source: 'fetched',
    };
  }

  async getBookingReport(
    id: string,
    actor: ExternalBookingActor,
    kind: ExternalBookingKind
  ): Promise<ExternalBookingReportDetails> {
    const booking = await this.getAccessibleBooking(id, actor, kind);
    const externalAppointmentId = this.getExternalAppointmentId(booking);

    if (!externalAppointmentId) {
      throw new AppError({
        status: 400,
        code: 'EXTERNAL_BOOKING_ID_MISSING',
        message: 'External booking ID is missing',
      });
    }

    const result =
      booking.integration === 'healthians'
        ? {
            externalBookingId: externalAppointmentId,
            payload: await this.healthiansService.getBookingStatus({
              bookingId: externalAppointmentId,
            }),
          }
        : await this.labstackService.getAppointmentDetails({
            appointmentId: externalAppointmentId,
          });

    return {
      booking: this.sanitizeBookingForList(booking),
      externalBookingId: result.externalBookingId || externalAppointmentId,
      details: result.payload,
      documents: this.extractReportDocuments(result.payload),
      notes: this.extractReportNotes(result.payload),
    };
  }

  async getBookingReportDocument(
    id: string,
    actor: ExternalBookingActor,
    kind: ExternalBookingKind,
    documentId: string
  ): Promise<Record<string, unknown>> {
    const booking = await this.getAccessibleBooking(id, actor, kind);
    const externalAppointmentId = this.getExternalAppointmentId(booking);

    if (!externalAppointmentId) {
      throw new AppError({
        status: 400,
        code: 'EXTERNAL_BOOKING_ID_MISSING',
        message: 'External booking ID is missing',
      });
    }

    const result =
      booking.integration === 'healthians'
        ? {
            payload: await this.healthiansService.getCustomerReport({
              bookingId: externalAppointmentId,
              uniqueId: booking.userId,
            }),
          }
        : await this.labstackService.getDocument({
            appointmentId: externalAppointmentId,
            documentId,
          });

    return result.payload;
  }

  async getDiagnosticsBookingReport(
    id: string,
    actor: ExternalBookingActor
  ): Promise<Record<string, unknown>[]> {
    const booking = await this.getAccessibleBooking(id, actor, 'diagnostics');
    const externalOrderId = this.getExternalAppointmentId(booking);

    if (!externalOrderId) {
      throw new AppError({
        status: 400,
        code: 'EXTERNAL_BOOKING_ID_MISSING',
        message: 'External booking ID is missing',
      });
    }

    if (booking.integration === 'healthians') {
      const reportPayload = await this.healthiansService.getCustomerReport({
        bookingId: externalOrderId,
        vendorBillingUserId: this.getHealthiansVendorBillingUserId(booking),
        uniqueId: this.getHealthiansVendorCustomerId(booking),
        allowPartialReport: 1,
      });

      return this.mapHealthiansDiagnosticsReportDocuments(
        reportPayload,
        String(booking._id)
      );
    }

    logger.info('[ExternalBooking][getDiagnosticsBookingReport] resolved upstream call', {
      routeBookingId: id,
      actorId: actor._id,
      bookingIntegration: booking.integration,
      bookingProviderType: booking.providerType,
      externalOrderId,
      upstreamService: 'labstack',
      upstreamMethod: 'getOrderDetails',
      upstreamEndpoint: '/v1.3/order/getOrderDetails',
    });

    const result = await this.labstackService.getOrderDetails({
      orderId: externalOrderId,
    });

    const payload = result.payload;
    const orderDetails =
      payload.orderDetails && typeof payload.orderDetails === 'object'
        ? (payload.orderDetails as Record<string, unknown>)
        : payload;

    return this.extractReportDocuments(orderDetails).map((document) =>
      this.mapDiagnosticsReportDocument(document, String(booking._id))
    );
  }

  async getDiagnosticsBookingReportPdf(
    id: string,
    actor: ExternalBookingActor,
    reportId: string
  ): Promise<ExternalDiagnosticsReportDocumentResult> {
    const booking = await this.getAccessibleBooking(id, actor, 'diagnostics');
    const externalOrderId = this.getExternalAppointmentId(booking);

    if (!externalOrderId) {
      throw new AppError({
        status: 400,
        code: 'EXTERNAL_BOOKING_ID_MISSING',
        message: 'External booking ID is missing',
      });
    }

    if (booking.integration === 'healthians') {
      const reportPayload = await this.healthiansService.getCustomerReport({
        bookingId: externalOrderId,
        vendorBillingUserId: this.getHealthiansVendorBillingUserId(booking),
        uniqueId: this.getHealthiansVendorCustomerId(booking),
        allowPartialReport: 1,
      });
      const reportUrl = this.extractHealthiansReportUrl(reportPayload);
      if (!reportUrl) {
        throw new AppError({
          status: 404,
          code: 'HEALTHIANS_REPORT_URL_MISSING',
          message: 'Healthians report URL is missing',
        });
      }

      const pdfBuffer = await this.healthiansService.downloadSignedReport(
        reportUrl
      );
      const { fileName, fileUrl } = this.persistDiagnosticsReportPdf(
        booking,
        reportId || 'healthians-report',
        pdfBuffer
      );

      return {
        integration: booking.integration,
        fileName,
        fileUrl,
        payload: reportPayload,
      };
    }

    const pdfBuffer = await this.labstackService.getOrderReport({
      orderId: externalOrderId,
      reportId,
    });

    const { fileName, fileUrl } = this.persistDiagnosticsReportPdf(
      booking,
      reportId,
      pdfBuffer
    );

    return {
      integration: booking.integration,
      fileName,
      fileUrl,
    };
  }

  private persistDiagnosticsReportPdf(
    booking: IExternalBooking,
    reportId: string,
    pdfBuffer: Buffer,
    options: { stableFileName?: boolean } = {}
  ): { fileName: string; fileUrl: string } {
    const uploadDir = CONFIG.UPLOAD_DIR || path.join(process.cwd(), 'files');
    const bookingId = String(booking._id);
    const safeReportId = String(reportId || 'report').replace(/[^a-zA-Z0-9_-]/g, '_');
    const reportDir = path.join(uploadDir, 'external-bookings', bookingId);
    fs.mkdirSync(reportDir, { recursive: true });

    const fileName = options.stableFileName
      ? `diagnostics-report-${safeReportId}.pdf`
      : `diagnostics-report-${safeReportId}-${Date.now()}.pdf`;
    const filePath = path.join(reportDir, fileName);
    fs.writeFileSync(filePath, pdfBuffer);

    return {
      fileName,
      fileUrl: `/api/static/external-bookings/${bookingId}/${fileName}`,
    };
  }

  private mergeReportUrls(
    existing: string[] | undefined,
    next: string[]
  ): string[] | undefined {
    const merged = [
      ...(Array.isArray(existing) ? existing : []),
      ...next,
    ].filter((url): url is string => typeof url === 'string' && url.trim().length > 0);

    return merged.length ? Array.from(new Set(merged)) : undefined;
  }

  private async persistReportsOnDeliveredWebhook(
    booking: IExternalBooking,
    payload: Record<string, unknown>
  ): Promise<string[]> {
    if (booking.providerType !== 'DIAGNOSTICS') {
      return Array.isArray(booking.report) ? booking.report : [];
    }

    const externalOrderId = this.getExternalAppointmentId(booking);
    if (!externalOrderId) {
      return Array.isArray(booking.report) ? booking.report : [];
    }

    if (booking.integration === 'healthians') {
      const reportPayload = await this.healthiansService.getCustomerReport({
        bookingId: externalOrderId,
        vendorBillingUserId: this.getHealthiansVendorBillingUserId(booking),
        uniqueId: this.getHealthiansVendorCustomerId(booking),
        allowPartialReport: 1,
      });
      const reportUrl = this.extractHealthiansReportUrl(reportPayload);
      if (!reportUrl) {
        return Array.isArray(booking.report) ? booking.report : [];
      }

      const pdfBuffer = await this.healthiansService.downloadSignedReport(reportUrl);
      const { fileUrl } = this.persistDiagnosticsReportPdf(
        booking,
        'healthians-full-report',
        pdfBuffer,
        { stableFileName: true }
      );

      return this.mergeReportUrls(booking.report, [fileUrl]) || [];
    }

    const payloadObjects = this.extractReportDocuments(payload);
    const reportIds = Array.from(
      new Set(
        payloadObjects
          .map((document) => this.extractDiagnosticsReportId(document))
          .filter((reportId): reportId is string => Boolean(reportId))
      )
    );

    let effectiveReportIds: string[] = reportIds;
    if (!reportIds.length) {
      const detailsResult = await this.labstackService.getOrderDetails({
        orderId: externalOrderId,
      });
      const payloadData = detailsResult.payload;
      const orderDetails =
        payloadData.orderDetails && typeof payloadData.orderDetails === 'object'
          ? (payloadData.orderDetails as Record<string, unknown>)
          : payloadData;
      effectiveReportIds = Array.from(
        new Set(
          this.extractReportDocuments(orderDetails)
            .map((document) => this.extractDiagnosticsReportId(document))
            .filter((reportId): reportId is string => Boolean(reportId))
        )
      );
    }

    if (!effectiveReportIds.length) {
      return Array.isArray(booking.report) ? booking.report : [];
    }

    const storedUrls: string[] = [];
    for (const reportId of effectiveReportIds) {
      const pdfBuffer = await this.labstackService.getOrderReport({
        orderId: externalOrderId,
        reportId,
      });
      const { fileUrl } = this.persistDiagnosticsReportPdf(
        booking,
        reportId,
        pdfBuffer,
        { stableFileName: true }
      );
      storedUrls.push(fileUrl);
    }

    return this.mergeReportUrls(booking.report, storedUrls) || [];
  }


  async syncBookingFromWebhook(payload: Record<string, unknown>): Promise<ExternalBookingWebhookSyncResult> {
    const externalBookingId = this.extractWebhookExternalBookingId(payload);
    if (!externalBookingId) return { matched: false, action: 'ignored', reason: 'external_booking_id_missing' };
    const booking = await this.externalBookingRepository.findByExternalReference(externalBookingId);
    if (!booking) return { matched: false, action: 'ignored', reason: 'external_booking_not_found', externalBookingId };
    // This public callback has no verified provider-authentication contract. Observations confer no state or money authority.
    const observed = this.normalizeWebhookStatus(this.extractWebhookStatus(payload));
    const updated = await this.externalBookingRepository.update({ _id: String(booking._id), userId: { $eq: booking.userId },
      $expr: { $eq: [{ $type: '$userId' }, 'string'] } }, { $set: {
      'meta.lastUntrustedProviderObservation': { externalBookingId: externalBookingId.slice(0, 512), status: observed?.slice(0, 128), receivedAt: new Date().toISOString() },
      'meta.providerEventReconciliationRequired': true,
    } });
    return { matched: true, action: 'updated', reason: 'provider_authentication_unproven', externalBookingId,
      normalizedStatus: observed, booking: publicExternalBooking((updated || booking) as IExternalBooking) };
  }

  private ensureSupportedIntegration(integration: string): void {
    if (integration !== 'labstack' && integration !== 'healthians') {
      throw new AppError({
        status: 400,
        code: 'UNSUPPORTED_INTEGRATION',
        message: `Integration ${integration} is not supported`,
      });
    }
  }

  private async getAccessibleBooking(
    id: string,
    actor: ExternalBookingActor,
    kind: ExternalBookingKind
  ): Promise<IExternalBooking> {
    const booking = await this.externalBookingRepository.findById(id);

    if (!booking) {
      throw new AppError({
        status: 404,
        code: 'EXTERNAL_BOOKING_NOT_FOUND',
        message: 'External booking not found',
      });
    }

    const isDiagnostics = booking.providerType === 'DIAGNOSTICS';
    if (kind === 'doctor' && isDiagnostics) {
      throw new AppError({
        status: 400,
        code: 'INVALID_BOOKING_KIND',
        message: 'This booking belongs to diagnostics flow',
      });
    }

    if (kind === 'diagnostics' && !isDiagnostics) {
      throw new AppError({
        status: 400,
        code: 'INVALID_BOOKING_KIND',
        message: 'This booking belongs to doctor flow',
      });
    }

    if (actor.userType !== 'admin' && booking.userId !== actor._id) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'You are not allowed to modify this booking',
      });
    }

    return booking;
  }

  private mapProviderToSpecialist(
    provider: LabstackProvider,
    query: ExternalSpecialistsQuery,
    integration: ExternalIntegration
  ): IExternalSpecialist {
    const id =
      this.getFirstString(provider, ['lsProviderId', 'providerId', 'id', 'lsId','doctor_id']) ||
      this.fallbackId(provider);

    return {
      id,
      integration,
      providerType: query.providerType,
      appointmentType: query.appointmentType,
      name:
        this.getFirstString(provider, ['providerName', 'name', 'fullName']) ||
        'Specialist',
      rating: this.getFirstNumber(provider, ['rating']),
      specialization:
        this.getFirstString(provider, ['speciality', 'specialization', 'subSpeciality']) ||
        query.speciality,
      degree: this.getFirstString(provider, ['degree', 'qualification']),
      experienceYears: this.getFirstNumber(provider, ['experienceYears', 'experience']),
      languages: this.getStringArray(provider, ['languages', 'language']),
      profilePictureUrl: this.getFirstString(provider, ['photo', 'profilePicture', 'profilePictureUrl']),
      consultationModes: this.deriveModes(query.appointmentType),
      city: this.getFirstString(provider, ['city']),
      state: this.getFirstString(provider, ['state']),
      pincode: this.getFirstString(provider, ['pincode']),
      fee: this.getFirstNumber(provider, ['consultationFee', 'fee']),
      meta: provider,
    };
  }

  private deriveModes(appointmentType: string): string[] {
    switch (appointmentType) {
      case 'ONLINE':
        return ['chat', 'call'];
      case 'CENTER_VISIT':
        return ['in-person'];
      case 'HOME_VISIT':
        return ['home-visit'];
      default:
        return ['chat', 'call', 'in-person'];
    }
  }

  private filterProviderSlotResponse(
    rawResponse: Record<string, unknown>,
    externalProviderId: string,
    integration: ExternalIntegration
  ): Record<string, unknown> {
    const response = { ...rawResponse };
    const slots = this.filterObjectArrayByCandidateIds(
      response.slots,
      externalProviderId,
      ['lsProviderId', 'providerId', 'lsId', 'id']
    );
    const groupSlots = this.filterObjectArrayByCandidateIds(
      response.groupSlots,
      externalProviderId,
      ['lsProviderId', 'providerId', 'lsId', 'id']
    );

    response.slots = slots;
    if (Array.isArray(response.groupSlots)) {
      response.groupSlots = groupSlots;
    }

    return this.withUpdatedSlotMessage(response, slots.length, integration);
  }

  private filterDiagnosticsSlotResponse(
    rawResponse: Record<string, unknown>,
    labId: string,
    integration: ExternalIntegration
  ): Record<string, unknown> {
    const response = { ...rawResponse };
    const slots = this.filterObjectArrayByCandidateIds(
      response.slots,
      labId,
      ['lsLabId', 'labId', 'id']
    );

    response.slots = slots;

    return this.withUpdatedSlotMessage(response, slots.length, integration);
  }

  private filterHealthiansDiagnosticsSlotsByLabId<
    T extends { labId?: string; externalProviderId: string; raw?: Record<string, unknown> }
  >(slots: T[], labId: string): T[] {
    const filtered = slots.filter((slot) => {
      const candidates = [
        slot.labId,
        slot.externalProviderId,
        this.getFirstString(slot.raw || {}, ['zone_id', 'lab_id', 'id']),
      ]
        .map((value) => (value !== undefined && value !== null ? String(value) : ''))
        .filter(Boolean);

      return candidates.includes(labId);
    });

    return filtered.length ? filtered : slots;
  }

  private filterHealthiansGenericSlotsByProviderId<
    T extends { externalProviderId: string; raw?: Record<string, unknown> }
  >(slots: T[], externalProviderId: string): T[] {
    const filtered = slots.filter((slot) => {
      const candidates = [
        slot.externalProviderId,
        this.getFirstString(slot.raw || {}, [
          'doctor_id',
          'provider_id',
          'providerId',
          'lsProviderId',
          'id',
        ]),
      ]
        .map((value) => (value !== undefined && value !== null ? String(value) : ''))
        .filter(Boolean);

      return candidates.includes(externalProviderId);
    });

    return filtered.length ? filtered : slots;
  }

  private filterObjectArrayByCandidateIds(
    value: unknown,
    expectedId: string,
    keys: string[]
  ): Record<string, unknown>[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter(
      (item): item is Record<string, unknown> =>
        !!item &&
        typeof item === 'object' &&
        this.matchesCandidateId(item as Record<string, unknown>, expectedId, keys)
    );
  }

  private matchesCandidateId(
    source: Record<string, unknown>,
    expectedId: string,
    keys: string[]
  ): boolean {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && String(value) === expectedId) {
        return true;
      }
    }

    return false;
  }

  private withUpdatedSlotMessage(
    response: Record<string, unknown>,
    slotCount: number,
    integration: ExternalIntegration
  ): Record<string, unknown> {
    const updated: Record<string, unknown> = { integration, ...response };
    const existingMessage =
      typeof updated.message === 'string' ? updated.message : undefined;

    if (existingMessage && /found\s+\d+\s+slots/i.test(existingMessage)) {
      updated.message = existingMessage.replace(
        /found\s+\d+\s+slots/i,
        `Found ${slotCount} Slots`
      );
    } else {
      updated.message = `Found ${slotCount} Slots`;
    }

    return updated;
  }

  private mapPackage(
    source: Record<string, unknown>,
    integration: ExternalIntegration
  ): IExternalPackage {
    return {
      id:
        this.getFirstString(source, [
          'deal_id',
          'product_type_id',
          'lsPackageId',
          'packageId',
          'id',
          'code',
          'packageCode',
        ]) || this.fallbackId(source),
      integration,
      name:
        this.getFirstString(source, [
          'packageName',
          'name',
          'title',
          'displayName',
        ]) || 'Package',
      price: this.getFirstNumber(source, [
        'price',
        'mrp',
        'offerPrice',
        'discountedPrice',
        'amount',
      ]),
      category: this.getFirstString(source, [
        'category',
        'categoryName',
        'type',
      ]),
      meta: source,
    };
  }

  private async enrichPackages(
    packages: IExternalPackage[],
    integration: ExternalIntegration
  ): Promise<IExternalPackage[]> {
    const metadataMap = await this.getCatalogMetadataMap(
      integration,
      'package',
      packages.map((item) => item.id)
    );

    return packages.map((item) =>
      this.applyCatalogMetadataToPackage(item, metadataMap.get(item.id))
    );
  }

  private mapTest(
    source: Record<string, unknown>,
    integration: ExternalIntegration
  ): IExternalTest {
    return {
      id:
        this.getFirstString(source, ['lsId',
          'deal_id',
          'product_type_id',
          'lsTestId',
          'testId',
          'id',
          'code',
          'testCode',
        ]) || this.fallbackId(source),
      integration,
      name:
        this.getFirstString(source, [
          'testName',
          'name',
          'title',
          'displayName',
        ]) || 'Test',
      price: this.getFirstNumber(source, [
        'minMrp',
        'price',
        'mrp',
        'offerPrice',
        'discountedPrice',
        'amount',
      ]),
      category: this.getFirstString(source, [
        'category',
        'categoryName',
        'department',
        'type',
      ]),
      meta: source,
    };
  }

  private async enrichTests(
    tests: IExternalTest[],
    integration: ExternalIntegration
  ): Promise<IExternalTest[]> {
    const metadataMap = await this.getCatalogMetadataMap(
      integration,
      'test',
      tests.map((item) => item.id)
    );

    return tests.map((item) =>
      this.applyCatalogMetadataToTest(item, metadataMap.get(item.id))
    );
  }

  private async enrichCatalogDetail(
    details: Record<string, unknown>,
    integration: ExternalIntegration,
    itemType: ExternalCatalogItemType,
    mappedItem: IExternalPackage | IExternalTest
  ): Promise<Record<string, unknown>> {
    const metadataMap = await this.getCatalogMetadataMap(integration, itemType, [
      mappedItem.id,
    ]);
    const metadata = metadataMap.get(mappedItem.id);
    const enriched =
      itemType === 'package'
        ? this.applyCatalogMetadataToPackage(
            mappedItem as IExternalPackage,
            metadata
          )
        : this.applyCatalogMetadataToTest(mappedItem as IExternalTest, metadata);

    return {
      ...details,
      ...enriched,
    };
  }

  private async getCatalogMetadataMap(
    integration: ExternalIntegration,
    itemType: ExternalCatalogItemType,
    externalItemIds: string[]
  ): Promise<Map<string, IExternalCatalogItem>> {
    const metadata = await this.externalCatalogItemRepository.findByExternalIds(
      integration,
      itemType,
      externalItemIds
    );

    return new Map(
      metadata.map((item) => [item.externalItemId, item] as const)
    );
  }

  private applyCatalogMetadataToPackage(
    item: IExternalPackage,
    metadata?: IExternalCatalogItem
  ): IExternalPackage {
    if (!metadata) {
      return item;
    }

    return {
      ...item,
      name: metadata.name?.trim() || item.name,
      customPrice: metadata.customPrice ?? item.customPrice,
      image: metadata.image?.trim() || item.image,
      coverImage: metadata.coverImage?.trim() || item.coverImage,
    };
  }

  private applyCatalogMetadataToTest(
    item: IExternalTest,
    metadata?: IExternalCatalogItem
  ): IExternalTest {
    if (!metadata) {
      return item;
    }

    return {
      ...item,
      name: metadata.name?.trim() || item.name,
      customPrice: metadata.customPrice ?? item.customPrice,
      image: metadata.image?.trim() || item.image,
      coverImage: metadata.coverImage?.trim() || item.coverImage,
    };
  }

  private mapLab(
    source: Record<string, unknown>,
    integration: ExternalIntegration
  ): IExternalLab {
    return {
      id:
        this.getFirstString(source, ['lsLabId', 'labId', 'id']) ||
        this.fallbackId(source),
      integration,
      name: this.getFirstString(source, ['labName', 'name']) || 'Lab',
      city: this.getFirstString(source, ['city']),
      state: this.getFirstString(source, ['state']),
      pincode: this.getFirstString(source, ['pincode', 'zipCode']),
      phone: this.getFirstString(source, ['mobile', 'phone', 'contactNo']),
      address: this.getFirstString(source, [
        'address',
        'addressLine',
        'fullAddress',
      ]),
      meta: source,
    };
  }

  private splitName(name: string): { firstName: string; lastName?: string } {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return { firstName: 'Patient' };
    }
    if (parts.length === 1) {
      return { firstName: parts[0] };
    }

    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(' '),
    };
  }

  private getFirstString(
    source: Record<string, unknown>,
    keys: string[]
  ): string | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
      if (typeof value === 'number') {
        return String(value);
      }
    }

    return undefined;
  }

  private getFirstNumber(
    source: Record<string, unknown>,
    keys: string[]
  ): number | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'number') {
        return value;
      }
      if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }
      }
    }

    return undefined;
  }

  private getStringArray(
    source: Record<string, unknown>,
    keys: string[]
  ): string[] | undefined {
    for (const key of keys) {
      const value = source[key];
      if (Array.isArray(value)) {
        const mapped = value
          .map((item) => (typeof item === 'string' ? item.trim() : undefined))
          .filter((item): item is string => Boolean(item));
        return mapped.length ? mapped : undefined;
      }
      if (typeof value === 'string' && value.trim()) {
        const parts = value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        return parts.length ? parts : undefined;
      }
    }

    return undefined;
  }

  private fallbackId(source: Record<string, unknown>): string {
    return `ls-${Buffer.from(JSON.stringify(source)).toString('base64').slice(0, 12)}`;
  }

  private buildLabstackUniqueId(input: {
    name?: string;
    mobile?: string;
    email?: string;
    userId?: string;
  }): string {
    const mobile = input.mobile?.trim();
    const name = input.name?.trim().replace(/\s+/g, '-');

    if (mobile && name) {
      return `${mobile}-${name}`;
    }

    if (mobile) {
      return mobile;
    }

    if (input.email?.trim()) {
      return input.email.trim();
    }

    return input.userId ? `usr-${input.userId}` : 'usr-anonymous';
  }

  private normalizeLabstackAddressFields(input: {
    unitFloorBuilding?: string;
    locality?: string;
    address?: string;
    city?: string;
    state?: string;
    pincode?: string;
    requireMinimumLength?: boolean;
  }): {
    unitFloorBuilding?: string;
    locality?: string;
    address?: string;
  } {
    const address = this.buildProviderAddress([
      input.unitFloorBuilding,
      input.address,
      input.locality,
      input.city,
      input.state,
      input.pincode,
    ]);

    if (input.requireMinimumLength !== false && address && address.length < 25) {
      throw new AppError({
        status: 400,
        code: 'LABSTACK_ADDRESS_TOO_SHORT',
        message:
          'Full address is too short for diagnostics booking. Include unit/building, address, locality, city, and state.',
      });
    }

    const unitFloorBuilding = this.distinctAddressPart(
      input.unitFloorBuilding,
      [address, input.locality]
    );
    const locality = this.distinctAddressPart(input.locality, [
      address,
      input.unitFloorBuilding,
    ]);

    return {
      unitFloorBuilding,
      locality,
      address: address ? this.limitProviderAddress(address) : undefined,
    };
  }

  private buildProviderAddress(parts: Array<string | undefined>): string | undefined {
    const uniqueParts: string[] = [];

    for (const part of parts) {
      const normalized = part?.trim();
      if (!normalized) {
        continue;
      }

      const lowered = normalized.toLowerCase();
      if (uniqueParts.some((item) => item.toLowerCase() === lowered)) {
        continue;
      }

      uniqueParts.push(normalized);
    }

    if (uniqueParts.length === 0) {
      return undefined;
    }

    return uniqueParts.join(', ');
  }

  private distinctAddressPart(
    value?: string,
    comparisons: Array<string | undefined> = []
  ): string | undefined {
    const normalized = value?.trim();
    if (!normalized) {
      return undefined;
    }

    const lowered = normalized.toLowerCase();
    const hasDuplicate = comparisons.some((item) => {
      const comparison = item?.trim();
      return comparison ? comparison.toLowerCase() === lowered : false;
    });

    return hasDuplicate ? undefined : normalized;
  }

  private limitProviderAddress(value: string, maxLength = 200): string {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }

  private getEffectiveBookingTime(
    data:
      | RescheduleExternalBookingRequest
      | RescheduleExternalDiagnosticsBookingRequest
  ): string {
    if ('selectedSlotTime' in data) {
      return data.selectedSlotTime.trim();
    }

    return data.bookingTime.trim();
  }

  private async resolveHealthiansRescheduleSlotId(
    booking: IExternalBooking,
    bookingDate: string,
    bookingTime: string,
    kind: ExternalBookingKind
  ): Promise<string | undefined> {
    if (kind === 'doctor') {
      if (!booking.externalProviderId?.trim()) {
        return undefined;
      }

      const slotResponse = await this.healthiansService.getGenericSlots({
        externalProviderId: booking.externalProviderId.trim(),
        bookingDate,
      });
      const matched = slotResponse.slots.find(
        (slot) => slot.startTime24h === bookingTime
      );

      return matched
        ? this.getFirstString(matched.raw || {}, ['slot_id', 'id', 'stm_id'])
        : undefined;
    }

    const meta =
      booking.meta && typeof booking.meta === 'object' && !Array.isArray(booking.meta)
        ? (booking.meta as Record<string, unknown>)
        : {};
    const packageIds = Array.isArray(meta.packageIds)
      ? (meta.packageIds as unknown[]).map((x) => String(x))
      : undefined;
    const testIds = Array.isArray(meta.testIds)
      ? (meta.testIds as unknown[]).map((x) => String(x))
      : undefined;

    const slotResponse = await this.healthiansService.getDiagnosticsSlots({
      bookingDate,
      pincode: meta.pincode as string | undefined,
      latitude: meta.latitude as number | undefined,
      longitude: meta.longitude as number | undefined,
      packageIds,
      testIds,
    });
    const matched = slotResponse.slots.find(
      (slot) => slot.startTime24h === bookingTime
    );

    return matched
      ? this.getFirstString(matched.raw || {}, ['slot_id', 'id', 'stm_id'])
      : undefined;
  }

  private getExternalAppointmentId(booking: IExternalBooking): string | undefined {
    if (booking.externalBookingId?.trim()) {
      return booking.externalBookingId.trim();
    }

    const meta = booking.meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return undefined;
    }

    const root = meta as Record<string, unknown>;
    const externalPayload =
      root.externalPayload && typeof root.externalPayload === 'object'
        ? (root.externalPayload as Record<string, unknown>)
        : undefined;
    const bookingResponse =
      externalPayload?.bookingResponse &&
      typeof externalPayload.bookingResponse === 'object'
        ? (externalPayload.bookingResponse as Record<string, unknown>)
        : undefined;
    const order =
      bookingResponse?.order && typeof bookingResponse.order === 'object'
        ? (bookingResponse.order as Record<string, unknown>)
        : undefined;
    const appointment =
      bookingResponse?.appointment && typeof bookingResponse.appointment === 'object'
        ? (bookingResponse.appointment as Record<string, unknown>)
        : undefined;

    return this.getFirstString(
      order ||
        appointment ||
        bookingResponse ||
        externalPayload ||
        root,
      ['orderId', 'appointmentId', 'lsAppointmentId', 'referenceId', 'id']
    );
  }

  private toIsoDateTime(yyyymmdd: string, time: string): string {
    const date = /^\d{8}$/.test(yyyymmdd)
      ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
      : yyyymmdd;

    const normalized = time.trim();
    const hhmmMatch = /^(\d{1,2}):(\d{2})$/.exec(normalized);
    if (hhmmMatch) {
      const hh = String(Math.min(23, Math.max(0, Number(hhmmMatch[1])))).padStart(2, '0');
      const mm = String(Math.min(59, Math.max(0, Number(hhmmMatch[2])))).padStart(2, '0');
      return `${date}T${hh}:${mm}:00.000`;
    }

    const ampmMatch = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(normalized);
    if (ampmMatch) {
      let hh = Number(ampmMatch[1]);
      const mm = String(Math.min(59, Math.max(0, Number(ampmMatch[2])))).padStart(2, '0');
      const isPm = ampmMatch[3].toUpperCase() === 'PM';
      if (isPm && hh !== 12) {
        hh += 12;
      }
      if (!isPm && hh === 12) {
        hh = 0;
      }
      return `${date}T${String(hh).padStart(2, '0')}:${mm}:00.000`;
    }

    return `${date}T00:00:00.000`;
  }

  private sanitizeBookingForList(booking: IExternalBooking): IExternalBooking {
    const bookingRecord = booking as IExternalBooking & Record<string, unknown>;
    const { meta, localEffects: _internal, __v: _version, ...rest } = bookingRecord;
    const sanitized: IExternalBooking = {
      ...(rest as IExternalBooking),
    };

    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return sanitized;
    }

    const summarizedMeta = this.summarizeBookingMeta(
      meta as Record<string, unknown>
    );

    if (summarizedMeta && Object.keys(summarizedMeta).length) {
      sanitized.meta = summarizedMeta;
    }

    return sanitized;
  }

  private async attachCorporateIdsToBookings(
    bookings: IExternalBooking[]
  ): Promise<IExternalBooking[]> {
    const missingCorporateIdUserIds = Array.from(
      new Set(
        bookings
          .filter((booking) => !booking.corporateId && booking.userId)
          .map((booking) => booking.userId)
      )
    );

    if (!missingCorporateIdUserIds.length) {
      return bookings;
    }

    const users = await UserModel.find({ _id: { $in: missingCorporateIdUserIds } })
      .select('_id corporateId')
      .lean();

    const corporateIdByUserId = new Map<string, string>();
    for (const user of users) {
      if (user?._id && user.corporateId) {
        corporateIdByUserId.set(String(user._id), String(user.corporateId));
      }
    }

    return bookings.map((booking) =>
      booking.corporateId
        ? booking
        : {
            ...booking,
            corporateId: corporateIdByUserId.get(String(booking.userId)),
          }
    );
  }

  private extractReportDocuments(
    details: Record<string, unknown>
  ): Record<string, unknown>[] {
    return this.collectDocumentArrays(details, [
      'documents',
      'document',
      'files',
      'reports',
      'attachments',
      'prescriptions',
    ]);
  }

  private mapDiagnosticsReportDocument(
    document: Record<string, unknown>,
    bookingId: string
  ): Record<string, unknown> {
    const reportId = this.extractDiagnosticsReportId(document);
    if (!reportId) {
      return document;
    }

    return {
      ...document,
      reportId,
      link: `/api/v1/external-bookings/diagnostics/bookings/${bookingId}/report/document?reportId=${encodeURIComponent(
        reportId
      )}`,
    };
  }

  private mapHealthiansDiagnosticsReportDocuments(
    payload: Record<string, unknown>,
    bookingId: string
  ): Record<string, unknown>[] {
    const data =
      payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
        ? (payload.data as Record<string, unknown>)
        : payload;
    const reportUrl = this.getFirstString(data, ['report_url', 'reportUrl']);

    if (!reportUrl) {
      return [];
    }

    return [
      {
        reportId: 'healthians-full-report',
        type: Number(data.full_report || 0) === 1 ? 'FULL' : 'PARTIAL',
        verifiedAt: this.getFirstString(data, ['verified_at', 'verifiedAt']),
        includeTest: Array.isArray(data.includeTest) ? data.includeTest : undefined,
        link: `/api/v1/external-bookings/diagnostics/bookings/${bookingId}/report/document?reportId=healthians-full-report`,
      },
    ];
  }

  private extractHealthiansReportUrl(
    payload: Record<string, unknown>
  ): string | undefined {
    const data =
      payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
        ? (payload.data as Record<string, unknown>)
        : payload;

    return this.getFirstString(data, ['report_url', 'reportUrl']);
  }

  private getHealthiansVendorBillingUserId(
    booking: IExternalBooking
  ): string | undefined {
    const meta =
      booking.meta && typeof booking.meta === 'object' && !Array.isArray(booking.meta)
        ? (booking.meta as Record<string, unknown>)
        : undefined;

    return this.getFirstString(meta || {}, ['vendorBillingUserId']) || booking.userId;
  }

  private getHealthiansVendorCustomerId(
    booking: IExternalBooking
  ): string | undefined {
    const meta =
      booking.meta && typeof booking.meta === 'object' && !Array.isArray(booking.meta)
        ? (booking.meta as Record<string, unknown>)
        : undefined;
    const externalPayload =
      meta?.externalPayload &&
      typeof meta.externalPayload === 'object' &&
      !Array.isArray(meta.externalPayload)
        ? (meta.externalPayload as Record<string, unknown>)
        : undefined;
    const bookingRequest =
      externalPayload?.bookingRequest &&
      typeof externalPayload.bookingRequest === 'object' &&
      !Array.isArray(externalPayload.bookingRequest)
        ? (externalPayload.bookingRequest as Record<string, unknown>)
        : undefined;
    const customers = Array.isArray(bookingRequest?.customer)
      ? (bookingRequest?.customer as Record<string, unknown>[])
      : undefined;
    const firstCustomer =
      customers && customers[0] && typeof customers[0] === 'object'
        ? customers[0]
        : undefined;

    return (
      this.getFirstString(meta || {}, ['vendorCustomerId']) ||
      this.getFirstString(bookingRequest || {}, ['vendor_customer_id']) ||
      this.getFirstString(firstCustomer || {}, ['vendor_customer_id', 'customer_id']) ||
      booking.userId
    );
  }

  private extractDiagnosticsReportId(
    document: Record<string, unknown>
  ): string | undefined {
    const directReportId = this.getFirstString(document, [
      'reportId',
      'report_id',
      'id',
    ]);
    if (directReportId) {
      return directReportId;
    }

    const link = this.getFirstString(document, ['link', 'url', 'href']);
    if (!link) {
      return undefined;
    }

    try {
      const parsed = new URL(link);
      return parsed.searchParams.get('reportId') || undefined;
    } catch (_error) {
      const match = link.match(/[?&]reportId=([^&]+)/);
      return match?.[1] ? decodeURIComponent(match[1]) : undefined;
    }
  }

  private extractReportNotes(
    details: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    const objects = this.collectNestedObjects(details);

    for (const obj of objects) {
      const keys = [
        'chiefComplaints',
        'doctorNotes',
        'followUpAdvice',
        'medication',
        'labTests',
      ].filter((key) => obj[key] !== undefined);

      if (!keys.length) {
        continue;
      }

      return keys.reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = obj[key];
        return acc;
      }, {});
    }

    return undefined;
  }

  private summarizeBookingMeta(
    meta: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    const { externalPayload, ...metaWithoutPayload } = meta;
    const summary: Record<string, unknown> = { ...metaWithoutPayload };

    if (
      !externalPayload ||
      typeof externalPayload !== 'object' ||
      Array.isArray(externalPayload)
    ) {
      return Object.keys(summary).length ? summary : undefined;
    }

    const payload = externalPayload as Record<string, unknown>;
    const bookingResponse =
      payload.bookingResponse &&
      typeof payload.bookingResponse === 'object' &&
      !Array.isArray(payload.bookingResponse)
        ? (payload.bookingResponse as Record<string, unknown>)
        : undefined;
    const order =
      bookingResponse?.order &&
      typeof bookingResponse.order === 'object' &&
      !Array.isArray(bookingResponse.order)
        ? (bookingResponse.order as Record<string, unknown>)
        : undefined;
    const appointment =
      bookingResponse?.appointment &&
      typeof bookingResponse.appointment === 'object' &&
      !Array.isArray(bookingResponse.appointment)
        ? (bookingResponse.appointment as Record<string, unknown>)
        : undefined;
    const selectedProvider =
      payload.selectedProvider &&
      typeof payload.selectedProvider === 'object' &&
      !Array.isArray(payload.selectedProvider)
        ? (payload.selectedProvider as Record<string, unknown>)
        : undefined;

    const providerName = this.getFirstString(
      selectedProvider || appointment || {},
      ['name', 'providerName']
    );
    const labName = this.getFirstString(order || {}, ['labName']);
    const preparations = this.getStringArray(order || {}, ['preparations']);

    if (providerName) {
      summary.providerName = providerName;
    }
    if (labName) {
      summary.labName = labName;
    }
    if (preparations?.length) {
      summary.preparations = preparations;
    }

    return Object.keys(summary).length ? summary : undefined;
  }

  private collectDocumentArrays(
    value: unknown,
    keys: string[]
  ): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];

    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') {
        return;
      }

      if (Array.isArray(node)) {
        node.forEach((item) => walk(item));
        return;
      }

      const record = node as Record<string, unknown>;
      keys.forEach((key) => {
        const candidate = record[key];
        if (!Array.isArray(candidate)) {
          return;
        }

        candidate.forEach((item) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            results.push(item as Record<string, unknown>);
            return;
          }

          if (typeof item === 'string' && item.trim()) {
            results.push({ value: item.trim() });
          }
        });
      });

      Object.values(record).forEach((nested) => walk(nested));
    };

    walk(value);
    return results;
  }

  private collectNestedObjects(value: unknown): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];

    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') {
        return;
      }

      if (Array.isArray(node)) {
        node.forEach((item) => walk(item));
        return;
      }

      const record = node as Record<string, unknown>;
      out.push(record);
      Object.values(record).forEach((nested) => walk(nested));
    };

    walk(value);
    return out;
  }

  private extractWebhookExternalBookingId(
    payload: Record<string, unknown>
  ): string | undefined {
    const objects = this.collectWebhookObjects(payload);

    for (const candidate of objects) {
      const id = this.getFirstString(candidate, [
        'orderId',
        'appointmentId',
        'externalBookingId',
        'lsAppointmentId',
        'referenceId',
        'bookingId',
        'id',
      ]);

      if (id) {
        return id;
      }
    }

    return undefined;
  }

  private extractWebhookStatus(
    payload: Record<string, unknown>
  ): string | undefined {
    const objects = this.collectWebhookObjects(payload);

    for (const candidate of objects) {
      const status = this.getFirstString(candidate, [
        'appointmentStatus',
        'orderStatus',
        'bookingStatus',
        'status',
        'event',
        'eventType',
        'action',
        'type',
      ]);
      if (status) {
        return status;
      }
    }

    return undefined;
  }

  private normalizeWebhookStatus(status?: string): string | undefined {
    const value = (status || '').trim().toLowerCase();
    if (!value) {
      return undefined;
    }

    if (
      value.includes('phlebo') ||
      value.includes('phlebotomist') ||
      value.includes('sample collector') ||
      value.includes('collector assigned')
    ) {
      return 'phlebo_assigned';
    }

    if (
      value.includes('report') &&
      (value.includes('deliver') ||
        value.includes('ready') ||
        value.includes('available') ||
        value.includes('generated'))
    ) {
      return 'report_delivered';
    }

    if (
      value.includes('cancel') ||
      value === 'rejected' ||
      value === 'failed'
    ) {
      return 'cancelled';
    }

    if (
      value.includes('reschedul') ||
      value.includes('updated') ||
      value.includes('modified')
    ) {
      return 'rescheduled';
    }

    if (
      value.includes('complete') ||
      value.includes('done') ||
      value.includes('fulfilled') ||
      value === 'closed'
    ) {
      return 'completed';
    }

    if (
      value.includes('confirm') ||
      value.includes('booked') ||
      value.includes('schedule')
    ) {
      return 'confirmed';
    }

    if (
      value.includes('pending') ||
      value.includes('initiated') ||
      value.includes('created')
    ) {
      return 'pending';
    }

    return value;
  }

  private collectWebhookObjects(
    payload: Record<string, unknown>
  ): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const visited = new Set<unknown>();

    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') {
        return;
      }
      if (visited.has(value)) {
        return;
      }
      visited.add(value);

      if (!Array.isArray(value)) {
        out.push(value as Record<string, unknown>);
      }

      if (Array.isArray(value)) {
        value.forEach((item) => visit(item));
        return;
      }

      Object.values(value as Record<string, unknown>).forEach((nested) => {
        if (nested && typeof nested === 'object') {
          visit(nested);
        }
      });
    };

    visit(payload);
    return out;
  }


}
