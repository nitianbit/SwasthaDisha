import fs from 'fs';
import path from 'path';
import { Service } from 'typedi';

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
  private static readonly WEBHOOK_TIME_ZONE = 'Asia/Kolkata';

  private readonly defaultIntegration: ExternalIntegration =
    CONFIG.EXTERNAL_BOOKING_DEFAULT_INTEGRATION || 'labstack';

  constructor(
    private externalBookingRepository: ExternalBookingRepository,
    private labstackService: LabstackService,
    private healthiansService: HealthiansService,
    private couponService: CouponService,
    private paymentService: PaymentService,
    private paymentRepository: PaymentRepository,
    private walletRepository: WalletRepository,
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

  private templateForExternalBookingStatus(
    status?: string
  ): ExternalBookingEmailTemplate | undefined {
    const normalized = (status || '').trim().toLowerCase();
    switch (normalized) {
      case 'pending':
        return 'CREATED';
      case 'confirmed':
      case 'booked':
      case 'scheduled':
        return 'ORDER_SCHEDULED';
      case 'rescheduled':
        return 'RESCHEDULED';
      case 'phlebo_assigned':
        return 'PHLEBO_ASSIGNED';
      case 'report_delivered':
        return 'REPORT_DELIVERED';
      case 'cancelled':
      case 'canceled':
        return 'CANCELED';
      default:
        return undefined;
    }
  }

  private async validateWalletIfRequested(
    userId: string,
    useWalletBalance?: boolean
  ): Promise<void> {
    if (!useWalletBalance) {
      return;
    }

    const wallet = await this.walletRepository.findByUserId(userId);
    if (wallet && !wallet.isActive) {
      throw new AppError({
        status: 400,
        code: 'WALLET_INACTIVE',
        message: 'Wallet is not active',
      });
    }
  }

  private async getOrCreateActiveWallet(userId: string) {
    let wallet = await this.walletRepository.findByUserId(userId);

    if (!wallet) {
      wallet = await this.walletRepository.save({
        userId,
        balance: 0,
        isActive: true,
      });
    }

    if (!wallet.isActive) {
      throw new AppError({
        status: 400,
        code: 'WALLET_INACTIVE',
        message: 'Wallet is not active',
      });
    }

    return wallet;
  }

  private async computeExternalBookingRefundAmount(
    booking: IExternalBooking
  ): Promise<number> {
    const id = String(booking._id!);

    if (booking.paymentTransactionId) {
      const paymentRecord = await this.paymentRepository.findById(
        booking.paymentTransactionId
      );
      if (
        paymentRecord &&
        paymentRecord.context === 'external_booking' &&
        String(paymentRecord.contextId) === id
      ) {
        const walletDeductedAmount = Number(
          paymentRecord.notes?.walletDeductedAmount || 0
        );
        const gatewayPaidAmount =
          paymentRecord.status === 'paid'
            ? Number(paymentRecord.finalAmount || 0)
            : 0;
        return walletDeductedAmount + gatewayPaidAmount;
      }
    }

    const txs = await this.walletTransactionRepository.findByReference(
      'external_booking',
      id
    );
    const debits = txs.filter(
      (t) => t.transactionType === 'debit' && t.status === 'completed'
    );
    return debits.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
  }

  /** Wallet (+ paid gateway via payment row) refund; idempotent. */
  private async refundExternalBookingAmountToWallet(
    booking: IExternalBooking
  ): Promise<number> {
    const id = String(booking._id!);

    const existingStandard = await this.walletTransactionRepository.findOne({
      userId: booking.userId,
      transactionType: 'refund',
      referenceType: 'external_booking',
      referenceId: id,
      status: 'completed',
    });
    if (existingStandard) {
      return Number(existingStandard.amount || 0);
    }

    const legacyTimeout = await this.walletTransactionRepository.findOne({
      referenceType: 'external_booking_timeout_refund',
      referenceId: id,
    });
    if (legacyTimeout) {
      return Number(legacyTimeout.amount || 0);
    }

    const paymentRecord = booking.paymentTransactionId
      ? await this.paymentRepository.findById(booking.paymentTransactionId)
      : null;
    const refundAmount = await this.computeExternalBookingRefundAmount(booking);
    if (refundAmount > 0) {
      const wallet = await this.getOrCreateActiveWallet(booking.userId);
      const balanceBefore = wallet.balance;
      const balanceAfter = balanceBefore + refundAmount;

      await this.walletTransactionRepository.save({
        userId: booking.userId,
        walletId: wallet._id!,
        transactionType: 'refund',
        amount: refundAmount,
        balanceBefore,
        balanceAfter,
        status: 'completed',
        referenceType: 'external_booking',
        referenceId: id,
        description: 'Refund for external booking',
        transactionDate: getTodayYyyymmdd(),
      });

      await this.walletRepository.update(
        { _id: wallet._id! },
        { balance: balanceAfter }
      );
    }

    if (booking.paymentTransactionId) {
      if (
        paymentRecord &&
        paymentRecord.context === 'external_booking' &&
        String(paymentRecord.contextId) === id &&
        paymentRecord.status === 'paid'
      ) {
        if (paymentRecord.couponCode && paymentRecord.isProcessed) {
          try {
            const coupon = await this.couponService.getByCode(paymentRecord.couponCode);
            await this.couponService.decrementUsage(coupon._id!);
          } catch (error) {
            logger.error('[ExternalBooking] failed to reverse coupon usage on refund', {
              bookingId: id,
              paymentTransactionId: paymentRecord._id,
              couponCode: paymentRecord.couponCode,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        await this.paymentRepository.update(
          { _id: paymentRecord._id! },
          { status: 'refunded', isProcessed: true }
        );
      }
    }

    return refundAmount;
  }

  private getBookingMeta(
    booking: Pick<IExternalBooking, 'meta'>
  ): Record<string, unknown> {
    return booking.meta &&
      typeof booking.meta === 'object' &&
      !Array.isArray(booking.meta)
      ? { ...(booking.meta as Record<string, unknown>) }
      : {};
  }

  private async markExternalBookingConfirmationPending(
    booking: IExternalBooking,
    message: string
  ): Promise<IExternalBooking> {
    logger.error('[ExternalBooking] marked confirmation pending', {
      bookingId: booking._id,
      paymentTransactionId: booking.paymentTransactionId,
      previousStatus: booking.status,
      previousPaymentStatus: booking.paymentStatus,
      error: message,
    });
    const priorMeta = this.getBookingMeta(booking);

    const updated = await this.externalBookingRepository.update(
      { _id: String(booking._id) },
      {
        status: 'pending',
        paymentStatus: 'paid',
        meta: {
          ...priorMeta,
          paymentConfirmationPendingAt:
            (priorMeta.paymentConfirmationPendingAt as string | undefined) ||
            new Date().toISOString(),
          paymentConfirmationError: message,
        },
      }
    );

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'EXTERNAL_BOOKING_UPDATE_FAILED',
        message: 'Failed to mark external booking confirmation as pending',
      });
    }

    await this.sendExternalBookingEmailNotification(
      updated as IExternalBooking,
      'CREATED'
    );

    return updated as IExternalBooking;
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

    if (paymentRecord.isProcessed) {
      return {
        booking,
        paymentRequired: false,
        walletDeductedAmount: Number(
          paymentRecord.notes?.walletDeductedAmount ?? 0
        ),
        fulfillmentState: 'completed',
      };
    }

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
        fulfillmentState: 'completed',
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
    userId: string;
    externalBookingId: string;
    amountToDeductFromWallet: number;
    useWalletBalance?: boolean;
  }): Promise<number> {
    if (!params.useWalletBalance || params.amountToDeductFromWallet <= 0) {
      return 0;
    }

    const wallet = await this.walletRepository.findByUserId(params.userId);
    if (!wallet) {
      return 0;
    }

    if (!wallet.isActive) {
      throw new AppError({
        status: 400,
        code: 'WALLET_INACTIVE',
        message: 'Wallet is not active',
      });
    }

    const walletDeductedAmount = Math.min(
      wallet.balance,
      params.amountToDeductFromWallet
    );
    if (walletDeductedAmount <= 0) {
      return 0;
    }

    const balanceBefore = wallet.balance;
    const balanceAfter = balanceBefore - walletDeductedAmount;

    await this.walletTransactionRepository.save({
      userId: params.userId,
      walletId: wallet._id!,
      transactionType: 'debit',
      amount: walletDeductedAmount,
      balanceBefore,
      balanceAfter,
      status: 'completed',
      referenceType: 'external_booking',
      referenceId: params.externalBookingId,
      description: 'Wallet used for external booking payment',
      transactionDate: getTodayYyyymmdd(),
    });

    await this.walletRepository.update(
      { _id: wallet._id! },
      { balance: balanceAfter }
    );

    return walletDeductedAmount;
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
    userId: string;
    bookingId: string;
    grossAmount: number;
    discountAmount: number;
    couponCode?: string;
    /** Wallet already debited on a prior attempt (e.g. first create); not debited again */
    walletAlreadyApplied: number;
    attemptUseWalletBalance?: boolean;
    orderNotes: Record<string, unknown>;
  }): Promise<ExternalBookingPaymentInitResponse> {
    await this.validateWalletIfRequested(
      params.userId,
      params.attemptUseWalletBalance
    );

    const discountedAmount = Math.max(0, params.grossAmount - params.discountAmount);

    let extraWallet = 0;
    if (params.attemptUseWalletBalance) {
      const room = Math.max(0, discountedAmount - params.walletAlreadyApplied);
      if (room > 0) {
        extraWallet = await this.deductWalletForExternal({
          userId: params.userId,
          externalBookingId: params.bookingId,
          amountToDeductFromWallet: room,
          useWalletBalance: true,
        });
      }
    }

    const walletTotal = params.walletAlreadyApplied + extraWallet;
    const payableAfterWallet = Math.max(0, discountedAmount - walletTotal);
    const notesWithWallet = {
      ...params.orderNotes,
      walletDeductedAmount: walletTotal,
      grossAmount: params.grossAmount,
      discountAmount: params.discountAmount,
      payableAfterCoupon: discountedAmount,
    };

    if (payableAfterWallet <= 0) {
      const directPaid = await this.paymentService.createDirectPaidTransaction({
        userId: params.userId,
        context: 'external_booking',
        contextId: params.bookingId,
        baseAmount: params.grossAmount,
        discountAmount: params.discountAmount,
        finalAmount: 0,
        couponCode: params.couponCode,
        isProcessed: false,
        notes: {
          ...notesWithWallet,
          reason:
            walletTotal > 0
              ? 'wallet_covered_amount'
              : 'zero_payable_amount',
        },
      });

      await this.externalBookingRepository.update(
        { _id: params.bookingId },
        {
          paymentTransactionId: directPaid._id!,
          paymentStatus: 'paid',
        }
      );

      try {
        const recovered =
          await this.paymentService.recoverExternalBookingPayment(directPaid);

        return {
          booking: recovered.entity as IExternalBooking,
          paymentRequired: false,
          walletDeductedAmount: walletTotal,
          fulfillmentState: 'completed',
        };
      } catch (error) {
        if (!this.isRecoverablePaidBookingTimeout(error)) {
          throw error;
        }

        const latestBooking = await this.externalBookingRepository.findById(
          params.bookingId
        );
        const pendingBooking =
          await this.markExternalBookingConfirmationPending(
            (latestBooking || {
              _id: params.bookingId,
              paymentTransactionId: directPaid._id!,
              paymentStatus: 'paid',
              status: 'pending_payment',
              meta: {},
            }) as IExternalBooking,
            error instanceof Error ? error.message : String(error)
          );

        return {
          booking: pendingBooking,
          paymentRequired: false,
          walletDeductedAmount: walletTotal,
          fulfillmentState: 'pending_confirmation',
        };
      }
    }

    const order = await this.paymentService.createOrder({
      userId: params.userId,
      context: 'external_booking',
      contextId: params.bookingId,
      baseAmount: params.grossAmount,
      discountAmount: params.discountAmount,
      finalAmount: payableAfterWallet,
      couponCode: params.couponCode,
      notes: notesWithWallet,
    });

    const booking = await this.externalBookingRepository.update(
      { _id: params.bookingId },
      { paymentTransactionId: order.paymentRecord._id! }
    );

    if (!booking) {
      throw new AppError({
        status: 500,
        code: 'EXTERNAL_BOOKING_UPDATE_FAILED',
        message: 'Failed to link payment to external booking',
      });
    }

    return {
      booking: booking as IExternalBooking,
      paymentRequired: true,
      walletDeductedAmount: walletTotal,
      payment: {
        paymentTransactionId: order.paymentRecord._id!,
        razorpayOrderId: order.razorpayOrder.id,
        razorpayKeyId: order.razorpayKeyId,
        amount: payableAfterWallet,
        currency: order.razorpayOrder.currency,
        baseAmount: params.grossAmount,
        discountAmount: params.discountAmount,
        couponCode: params.couponCode,
        walletDeductedAmount: walletTotal,
      },
    };
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
      discountAmount: couponValidation.discountAmount || 0,
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
    const saved = await this.externalBookingRepository.save(draft);

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

    try {
      const booking = await this.applyLabstackConsultationToDraft(
        saved as IExternalBooking,
        data,
        effectiveSlotTime,
        integration
      );
      await this.sendExternalBookingEmailNotification(
        booking,
        'ORDER_SCHEDULED'
      );
      return {
        booking,
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
      await this.externalBookingRepository.delete({ _id: String(saved._id) });
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
    integration: ExternalIntegration
  ): Promise<IExternalBooking> {
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

    const updated = await this.externalBookingRepository.update(
      { _id: String(draft._id) },
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
    const saved = await this.externalBookingRepository.save(draft);
    const prepared = await this.freezeHealthiansDiagnosticsSlotIfNeeded(
      saved as IExternalBooking,
      data,
      integration
    );

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

    try {
      const booking = await this.applyDiagnosticsOrderToDraft(
        prepared as IExternalBooking,
        data,
        integration
      );
      await this.sendExternalBookingEmailNotification(
        booking,
        'ORDER_SCHEDULED'
      );
      return {
        booking,
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
      await this.externalBookingRepository.delete({ _id: String(prepared._id) });
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

  private async freezeHealthiansDiagnosticsSlotIfNeeded(
    booking: IExternalBooking,
    data: CreateExternalDiagnosticsBookingRequest,
    integration: ExternalIntegration
  ): Promise<IExternalBooking> {
    if (integration !== 'healthians' || !data.stmId?.trim()) {
      return booking;
    }

    const freezeResponse = await this.healthiansService.freezeDiagnosticsSlot({
      stmId: data.stmId.trim(),
      vendorBillingUserId: data.userId,
    });

    const priorMeta =
      booking.meta && typeof booking.meta === 'object' && !Array.isArray(booking.meta)
        ? (booking.meta as Record<string, unknown>)
        : {};

    const updated = await this.externalBookingRepository.update(
      { _id: String(booking._id) },
      {
        externalSlotRef: data.stmId.trim(),
        meta: {
          ...priorMeta,
          vendorBillingUserId: data.userId,
          frozenHealthiansSlot: {
            stmId: data.stmId.trim(),
            response: freezeResponse,
            frozenAt: new Date().toISOString(),
          },
        },
      }
    );

    return (updated || booking) as IExternalBooking;
  }

  private async applyDiagnosticsOrderToDraft(
    draft: IExternalBooking,
    data: CreateExternalDiagnosticsBookingRequest,
    integration: ExternalIntegration
  ): Promise<IExternalBooking> {
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

    const updated = await this.externalBookingRepository.update(
      { _id: String(draft._id) },
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

  async cancelBooking(
    id: string,
    actor: ExternalBookingActor,
    data: CancelExternalBookingRequest,
    _kind: ExternalBookingKind
  ): Promise<IExternalBooking> {
    const booking = await this.getAccessibleBookingIgnoringKind(id, actor);
    const effectiveKind: ExternalBookingKind =
      booking.providerType === 'DIAGNOSTICS' ? 'diagnostics' : 'doctor';

    const cancellationReason =
      data.cancellationReason?.trim() ||
      data.reason?.trim() ||
      'Cancelled by user';

    if (booking.status === 'cancelled') {
      return booking;
    }

    const cancelledAt = getTodayYyyymmdd();
    const priorMeta =
      booking.meta && typeof booking.meta === 'object' && !Array.isArray(booking.meta)
        ? (booking.meta as Record<string, unknown>)
        : {};

    const externalAppointmentId = this.getExternalAppointmentId(booking);

    if (
      !externalAppointmentId &&
      (booking.status === 'pending_payment' ||
        (booking.status === 'pending' && booking.paymentStatus === 'paid')) &&
      (effectiveKind === 'doctor' || effectiveKind === 'diagnostics')
    ) {
      const deferProviderCancel =
        booking.status === 'pending' && booking.paymentStatus === 'paid';

      const updated = await this.externalBookingRepository.update(
        { _id: id },
        {
          status: 'cancelled',
          paymentStatus: deferProviderCancel ? 'refunded' : 'cancelled',
          meta: {
            ...priorMeta,
            cancellationReason,
            cancelledAt,
            ...(deferProviderCancel
              ? {
                  cancelRequestedWhileConfirmationPending: true,
                  cancelRequestedAt: new Date().toISOString(),
                  needsProviderCancelIfDiscovered: true,
                }
              : {}),
          },
        }
      );

      if (!updated) {
        throw new AppError({
          status: 500,
          code: 'EXTERNAL_BOOKING_UPDATE_FAILED',
          message: 'Failed to cancel pending external booking',
        });
      }

      let finalBooking = updated;
      try {
        const refundedAmount =
          await this.refundExternalBookingAmountToWallet(booking);
        if (refundedAmount > 0 && finalBooking.paymentStatus !== 'refunded') {
          finalBooking =
            (await this.externalBookingRepository.update(
              { _id: id },
              { paymentStatus: 'refunded' }
            )) || finalBooking;
        }
      } catch (error) {
        console.error(
          'Failed to refund cancelled external booking amount to wallet:',
          error
        );
      }

      await this.sendExternalBookingEmailNotification(
        finalBooking as IExternalBooking,
        'CANCELED'
      );

      return finalBooking;
    }

    if (!externalAppointmentId) {
      throw new AppError({
        status: 400,
        code: 'EXTERNAL_BOOKING_ID_MISSING',
        message: 'External booking ID is missing',
      });
    }

    const result =
      booking.integration === 'healthians'
        ? await this.healthiansService.cancelBooking({
            bookingId: externalAppointmentId,
            vendorBillingUserId: this.getHealthiansVendorBillingUserId(booking),
            reason: cancellationReason,
            uniqueId: this.getHealthiansVendorCustomerId(booking),
          })
        : effectiveKind === 'diagnostics'
          ? await this.labstackService.cancelOrder({
              orderId: externalAppointmentId,
              reason: cancellationReason,
            })
          : await this.labstackService.cancelAppointment({
              appointmentId: externalAppointmentId,
              reason: cancellationReason,
            });

    const updated = await this.externalBookingRepository.update(
      { _id: id },
      {
        externalBookingId: booking.externalBookingId || externalAppointmentId,
        status: result.externalStatus || 'cancelled',
        meta: {
          ...priorMeta,
          cancellationReason,
          cancelledAt,
          cancellationResponse: result.payload,
        },
      }
    );

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'EXTERNAL_BOOKING_UPDATE_FAILED',
        message: 'Failed to update external booking after cancellation',
      });
    }

    let finalBooking = updated;
    try {
      const refundedAmount =
        await this.refundExternalBookingAmountToWallet(booking);
      if (refundedAmount > 0 && finalBooking.paymentStatus !== 'refunded') {
        finalBooking =
          (await this.externalBookingRepository.update(
            { _id: id },
            { paymentStatus: 'refunded' }
          )) || finalBooking;
      }
    } catch (error) {
      console.error(
        'Failed to refund cancelled external booking amount to wallet:',
        error
      );
    }

    await this.sendExternalBookingEmailNotification(
      finalBooking as IExternalBooking,
      'CANCELED'
    );

    return finalBooking;
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

  private async processStaleUnpaidExternalBookingCancellation(
    booking: IExternalBooking
  ): Promise<void> {
    const id = String(booking._id);
    const reason = 'Payment not completed within 30 minutes';

    const refundAmount = await this.refundExternalBookingAmountToWallet(booking);

    const externalAppointmentId = this.getExternalAppointmentId(booking);
    let cancellationLabstackResponse: unknown;

    if (externalAppointmentId?.trim()) {
      try {
        const kind: ExternalBookingKind =
          booking.providerType === 'DIAGNOSTICS' ? 'diagnostics' : 'doctor';
        const result =
          booking.integration === 'healthians'
            ? await this.healthiansService.cancelBooking({
                bookingId: externalAppointmentId.trim(),
                vendorBillingUserId: this.getHealthiansVendorBillingUserId(booking),
                reason,
                uniqueId: this.getHealthiansVendorCustomerId(booking),
              })
            : kind === 'diagnostics'
              ? await this.labstackService.cancelOrder({
                  orderId: externalAppointmentId.trim(),
                  reason,
                })
              : await this.labstackService.cancelAppointment({
                  appointmentId: externalAppointmentId.trim(),
                  reason,
                });
        cancellationLabstackResponse = result.payload;
      } catch (err) {
        cancellationLabstackResponse = {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const priorMeta =
      booking.meta && typeof booking.meta === 'object' && !Array.isArray(booking.meta)
        ? (booking.meta as Record<string, unknown>)
        : {};

    await this.externalBookingRepository.update(
      { _id: id },
      {
        status: 'cancelled',
        paymentStatus: 'cancelled',
        meta: {
          ...priorMeta,
          paymentTimeoutCancelledAt: new Date().toISOString(),
          cancellationReason: reason,
          ...(refundAmount > 0 ? { paymentTimeoutWalletRefunded: true } : {}),
          ...(cancellationLabstackResponse !== undefined
            ? { cancellationResponse: cancellationLabstackResponse }
            : {}),
        },
      }
    );
  }

  private async processStalePaidConfirmationTimeout(
    booking: IExternalBooking
  ): Promise<void> {
    const id = String(booking._id);
    const reason = 'Booking confirmation not received within 30 minutes';

    const refundAmount = await this.refundExternalBookingAmountToWallet(booking);
    const priorMeta = this.getBookingMeta(booking);

    await this.externalBookingRepository.update(
      { _id: id },
      {
        status: 'cancelled',
        paymentStatus: refundAmount > 0 ? 'refunded' : 'cancelled',
        meta: {
          ...priorMeta,
          paymentConfirmationTimedOutAt: new Date().toISOString(),
          cancellationReason: reason,
          ...(refundAmount > 0 ? { paymentConfirmationWalletRefunded: true } : {}),
        },
      }
    );
  }

  private async cancelProviderIfDiscoveredLater(
    booking: IExternalBooking,
    externalBookingId: string,
    reason: string
  ): Promise<{
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
      const updated = await this.externalBookingRepository.update(
        { _id: id },
        {
          bookingDate: data.bookingDate,
          bookingTime: effectiveBookingTime,
          externalSlotRef: effectiveBookingTime,
        }
      );

      if (!updated) {
        throw new AppError({
          status: 500,
          code: 'EXTERNAL_BOOKING_UPDATE_FAILED',
          message: 'Failed to reschedule pending external booking',
        });
      }

      return updated;
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

    const updated = await this.externalBookingRepository.update(
      { _id: id },
      {
        bookingDate: data.bookingDate,
        bookingTime: effectiveBookingTime,
        externalBookingId:
          result.externalBookingId ||
          booking.externalBookingId ||
          externalAppointmentId,
        externalSlotRef: effectiveBookingTime,
        status: result.externalStatus || 'rescheduled',
        meta: {
          ...(booking.meta || {}),
          rescheduleRequest: data,
          rescheduleResponse: result.payload,
        },
      }
    );

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'EXTERNAL_BOOKING_UPDATE_FAILED',
        message: 'Failed to update external booking after reschedule',
      });
    }

    await this.sendExternalBookingEmailNotification(updated, 'RESCHEDULED', {
      oldBookingDate,
      oldBookingTime,
    });

    return updated;
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
      filter.userId = query.userId;
    }
    if (query.corporateId) {
      filter.corporateId = query.corporateId;
    }
    if (query.integration) {
      filter.integration = this.resolveIntegration(query.integration);
    } else {
      filter.integration = this.defaultIntegration;
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
    const externalPaymentRecord =
      paymentRecord?.context === 'external_booking' ? paymentRecord : null;

    const walletTransactions =
      await this.walletTransactionRepository.findByReference(
        'external_booking',
        booking._id!
      );

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

    const amountUsedFromWallet = walletDebitTransactions.reduce(
      (sum, transaction) => sum + Number(transaction.amount || 0),
      0
    );
    const amountRefunded = walletRefundTransactions.reduce(
      (sum, transaction) => sum + Number(transaction.amount || 0),
      0
    );
    const amountChargedToRazorpay = externalPaymentRecord
      ? Number(externalPaymentRecord.finalAmount || 0)
      : 0;

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
        actualAmountPaid: amountChargedToRazorpay + amountUsedFromWallet,
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


  async syncBookingFromWebhook(
    payload: Record<string, unknown>
  ): Promise<ExternalBookingWebhookSyncResult> {
    const externalBookingId = this.extractWebhookExternalBookingId(payload);
    if (!externalBookingId) {
      return {
        matched: false,
        action: 'ignored',
        reason: 'external_booking_id_missing',
      };
    }

    const booking =
      await this.externalBookingRepository.findByExternalReference(
        externalBookingId
      );
    if (!booking) {
      return {
        matched: false,
        action: 'ignored',
        reason: 'external_booking_not_found',
        externalBookingId,
      };
    }

    const rawStatus = this.extractWebhookStatus(payload);
    const normalizedStatus = this.normalizeWebhookStatus(rawStatus);
    const appointmentAt = this.extractWebhookAppointmentDateTime(payload);
    const nextBookingDate =
      this.extractWebhookBookingDate(payload) ||
      this.extractYyyymmddFromDateTime(appointmentAt);
    const nextBookingTime =
      this.extractWebhookBookingTime(payload) ||
      this.extractDisplayTimeFromDateTime(appointmentAt);

    const priorMeta =
      booking.meta && typeof booking.meta === 'object' && !Array.isArray(booking.meta)
        ? (booking.meta as Record<string, unknown>)
        : {};

    const nextMeta: Record<string, unknown> = {
      ...priorMeta,
      lastWebhookSync: {
        externalBookingId,
        rawStatus,
        normalizedStatus,
        receivedAt: new Date().toISOString(),
      },
      webhookSyncCount: Number(priorMeta.webhookSyncCount || 0) + 1,
    };

    const phleboName = this.extractWebhookPhleboName(payload);
    const phleboContact = this.extractWebhookPhleboContact(payload);
    if (phleboName) {
      nextMeta.phleboName = phleboName;
    }
    if (phleboContact) {
      nextMeta.phleboContact = phleboContact;
    }

    const updateData: Partial<IExternalBooking> = {
      externalBookingId: booking.externalBookingId || externalBookingId,
      meta: nextMeta,
    };

    let action: ExternalBookingWebhookSyncResult['action'] = 'updated';

    if (nextBookingDate && nextBookingDate !== booking.bookingDate) {
      updateData.bookingDate = nextBookingDate;
      action = 'rescheduled';
    }

    if (nextBookingTime && nextBookingTime !== booking.bookingTime) {
      updateData.bookingTime = nextBookingTime;
      updateData.externalSlotRef = nextBookingTime;
      action = 'rescheduled';
    }

    if (normalizedStatus) {
      updateData.status = normalizedStatus;
      if (normalizedStatus === 'cancelled') {
        action = 'cancelled';
      } else if (normalizedStatus === 'completed') {
        action = 'completed';
      } else if (action !== 'rescheduled') {
        action = 'updated';
      }
    }

    if (normalizedStatus === 'report_delivered') {
      try {
        const reportUrls = await this.persistReportsOnDeliveredWebhook(
          booking as IExternalBooking,
          payload
        );
        if (reportUrls.length) {
          updateData.report = reportUrls;
          nextMeta.reportDeliveredAt = new Date().toISOString();
          nextMeta.reportSync = {
            savedAt: new Date().toISOString(),
            reportCount: reportUrls.length,
            reportUrls,
          };
        }
      } catch (error) {
        nextMeta.reportSync = {
          savedAt: new Date().toISOString(),
          succeeded: false,
          error: error instanceof Error ? error.message : String(error),
        };
        logger.error('[ExternalBooking] failed to persist reports from webhook', {
          bookingId: booking._id,
          externalBookingId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (normalizedStatus === 'cancelled') {
      nextMeta.cancellationReason =
        this.extractWebhookCancellationReason(payload) || 'Cancelled by provider';
      nextMeta.cancelledAt = getTodayYyyymmdd();
    }

    if (priorMeta.needsProviderCancelIfDiscovered) {
      const cancellationReason =
        (priorMeta.cancellationReason as string | undefined) ||
        'Cancelled while booking confirmation was pending';

      try {
        const cancellation = await this.cancelProviderIfDiscoveredLater(
          booking as IExternalBooking,
          externalBookingId,
          cancellationReason
        );

        nextMeta.deferredProviderCancellation = {
          attemptedAt: new Date().toISOString(),
          succeeded: true,
          payload: cancellation.payload,
        };
        nextMeta.needsProviderCancelIfDiscovered = false;
        updateData.status = cancellation.externalStatus || 'cancelled';
        updateData.paymentStatus =
          booking.paymentStatus === 'refunded' ? 'refunded' : 'cancelled';
        nextMeta.cancelledAt =
          (priorMeta.cancelledAt as string | undefined) || getTodayYyyymmdd();
        action = 'cancelled';
      } catch (error) {
        nextMeta.deferredProviderCancellation = {
          attemptedAt: new Date().toISOString(),
          succeeded: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (
      normalizedStatus === 'cancelled' &&
      booking.paymentStatus !== 'refunded' &&
      booking.paymentStatus !== 'cancelled'
    ) {
      const refundAmount =
        await this.refundExternalBookingAmountToWallet(booking);
      updateData.paymentStatus =
        refundAmount > 0 ? 'refunded' : 'cancelled';
    }

    const hasMeaningfulUpdate =
      action !== 'updated' ||
      Boolean(updateData.status) ||
      Boolean(updateData.bookingDate) ||
      Boolean(updateData.bookingTime) ||
      Boolean(updateData.report?.length) ||
      updateData.paymentStatus !== undefined;

    if (!hasMeaningfulUpdate) {
      const refreshed = await this.externalBookingRepository.update(
        { _id: String(booking._id) },
        { meta: nextMeta }
      );

      return {
        matched: true,
        action: 'updated',
        externalBookingId,
        normalizedStatus,
        booking: (refreshed || booking) as IExternalBooking,
      };
    }

    const updated = await this.externalBookingRepository.update(
      { _id: String(booking._id) },
      updateData
    );

    const latestBooking = (updated || booking) as IExternalBooking;
    const template =
      action === 'rescheduled'
        ? 'RESCHEDULED'
        : this.templateForExternalBookingStatus(
            updateData.status || latestBooking.status
          );

    if (template) {
      await this.sendExternalBookingEmailNotification(latestBooking, template, {
        oldBookingDate:
          action === 'rescheduled' ? booking.bookingDate : undefined,
        oldBookingTime:
          action === 'rescheduled' ? booking.bookingTime : undefined,
      });
    }

    return {
      matched: true,
      action,
      externalBookingId,
      normalizedStatus,
      booking: latestBooking,
    };
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
    const { meta, __v: _version, ...rest } = bookingRecord;
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

  private extractWebhookCancellationReason(
    payload: Record<string, unknown>
  ): string | undefined {
    const objects = this.collectWebhookObjects(payload);

    for (const candidate of objects) {
      const reason = this.getFirstString(candidate, [
        'cancellationReason',
        'cancelReason',
        'reason',
        'message',
      ]);
      if (reason) {
        return reason;
      }
    }

    return undefined;
  }

  private extractWebhookAppointmentDateTime(
    payload: Record<string, unknown>
  ): string | undefined {
    const objects = this.collectWebhookObjects(payload);

    for (const candidate of objects) {
      const dateTime = this.getFirstString(candidate, [
        'appointment',
        'appointmentTime',
        'appointmentDateTime',
        'bookingDateTime',
        'scheduledAt',
        'dateTime',
      ]);
      if (dateTime) {
        return dateTime;
      }
    }

    return undefined;
  }

  private extractWebhookBookingDate(
    payload: Record<string, unknown>
  ): string | undefined {
    const objects = this.collectWebhookObjects(payload);

    for (const candidate of objects) {
      const rawDate = this.getFirstString(candidate, [
        'bookingDate',
        'date',
        'appointmentDate',
      ]);

      if (!rawDate) {
        continue;
      }

      const normalized = this.normalizeDateCandidate(rawDate);
      if (normalized) {
        return normalized;
      }
    }

    return undefined;
  }

  private extractWebhookBookingTime(
    payload: Record<string, unknown>
  ): string | undefined {
    const objects = this.collectWebhookObjects(payload);

    for (const candidate of objects) {
      const rawTime = this.getFirstString(candidate, [
        'bookingTime',
        'time',
        'slotTime',
        'appointmentSlot',
      ]);

      if (!rawTime) {
        continue;
      }

      const normalized = this.normalizeTimeCandidate(rawTime);
      if (normalized) {
        return normalized;
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

  private extractWebhookPhleboName(
    payload: Record<string, unknown>
  ): string | undefined {
    const objects = this.collectWebhookObjects(payload);

    for (const candidate of objects) {
      const name = this.getFirstString(candidate, [
        'phleboName',
        'phlebotomistName',
        'collectorName',
        'agentName',
        'executiveName',
        'phlebo_id',
      ]);
      if (name) {
        return name;
      }
    }

    return undefined;
  }

  private extractWebhookPhleboContact(
    payload: Record<string, unknown>
  ): string | undefined {
    const objects = this.collectWebhookObjects(payload);

    for (const candidate of objects) {
      const contact = this.getFirstString(candidate, [
        'phleboPhone',
        'phlebotomistPhone',
        'phleboMobile',
        'phlebotomistMobile',
        'collectorPhone',
        'agentPhone',
        'executivePhone',
      ]);
      if (contact) {
        return contact;
      }
    }

    return undefined;
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

  private normalizeDateCandidate(value: string): string | undefined {
    const trimmed = value.trim();
    if (/^\d{8}$/.test(trimmed)) {
      return trimmed;
    }

    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
    if (match) {
      return `${match[1]}${match[2]}${match[3]}`;
    }

    return undefined;
  }

  private normalizeTimeCandidate(value: string): string | undefined {
    const trimmed = value.trim();
    if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(trimmed)) {
      return trimmed.toUpperCase();
    }

    const hhmm = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (!hhmm) {
      return undefined;
    }

    let hours = Number(hhmm[1]);
    const minutes = hhmm[2];
    const suffix = hours >= 12 ? 'PM' : 'AM';
    if (hours === 0) {
      hours = 12;
    } else if (hours > 12) {
      hours -= 12;
    }

    return `${hours}:${minutes} ${suffix}`;
  }

  private parseWebhookDateTimeToIstParts(
    value?: string
  ): { yyyymmdd: string; displayTime: string } | undefined {
    if (!value) {
      return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    const zonedDate = new Date(trimmed);
    if (!Number.isNaN(zonedDate.getTime())) {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: ExternalBookingService.WEBHOOK_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

      const parts = formatter.formatToParts(zonedDate);
      const year = parts.find((part) => part.type === 'year')?.value;
      const month = parts.find((part) => part.type === 'month')?.value;
      const day = parts.find((part) => part.type === 'day')?.value;
      const hour = parts.find((part) => part.type === 'hour')?.value;
      const minute = parts.find((part) => part.type === 'minute')?.value;

      if (year && month && day && hour && minute) {
        const displayTime = this.normalizeTimeCandidate(`${hour}:${minute}`);
        if (displayTime) {
          return {
            yyyymmdd: `${year}${month}${day}`,
            displayTime,
          };
        }
      }
    }

    const localMatch =
      /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?)?$/.exec(
        trimmed
      );
    if (!localMatch) {
      return undefined;
    }

    const datePart = `${localMatch[1]}${localMatch[2]}${localMatch[3]}`;
    const hour = localMatch[4];
    const minute = localMatch[5];

    if (!hour || !minute) {
      return {
        yyyymmdd: datePart,
        displayTime: '',
      };
    }

    const displayTime = this.normalizeTimeCandidate(`${hour}:${minute}`);
    if (!displayTime) {
      return undefined;
    }

    return {
      yyyymmdd: datePart,
      displayTime,
    };
  }

  private extractYyyymmddFromDateTime(value?: string): string | undefined {
    return this.parseWebhookDateTimeToIstParts(value)?.yyyymmdd;
  }

  private extractDisplayTimeFromDateTime(value?: string): string | undefined {
    const parts = this.parseWebhookDateTimeToIstParts(value);
    return parts?.displayTime || undefined;
  }
}
