import { BookingRepository } from '@/modules/bookings/repository';
import {
  BookingType,
  CreateBookingRequest,
  BookingQueryParams,
  BookingPaymentDetailsResponse,
  IBookingFollowUp,
  IBookingLifecycle,
  CreateSpecialistBookingRequest,
  CreateWellnessPackageBookingRequest,
  IBooking,
  RetryBookingPaymentRequest,
  UpdateBookingRequest,
} from '@/modules/bookings/types';
import { AppError } from '@/modules/common/types';
import {
  addDaysToYyyymmdd,
  compareYyyymmdd,
  getTodayYyyymmdd,
} from '@/modules/common/utils/dateUtils';
import { SpecialistService } from '@/modules/specialists/services';
import { WellnessPackageService } from '@/modules/wellnessPackages/services';
import { NotificationService } from '@/modules/notification/services';
import { SlotService } from '@/modules/slots/services';
import { Service } from 'typedi';
import { CouponService } from '@/modules/coupon/services';
import { PaymentService } from '@/modules/payment/services';
import { PaymentRepository } from '@/modules/payment/repository';
import { BookingReminderScheduler } from '@/modules/bookings/services/bookingReminderScheduler';
import {
  WalletRepository,
  WalletTransactionRepository,
} from '@/modules/wallet/repository';
import { SlotRepository } from '@/modules/slots/repository';
import { UserRepository } from '@/modules/user/repository';
import { EmailService } from '@/modules/email/services';
import {
  buildPaidBookingEmailContent,
  cancelBookingMeet,
  syncBookingMeet,
} from '@/modules/meet/service';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { buildBookingLifecyclePatch } from '@/modules/bookings/utils/lifecycle';

interface BookingPaymentInitResponse {
  booking: IBooking;
  paymentRequired: boolean;
  walletDeductedAmount?: number;
    payment?: {
      paymentTransactionId: string;
      razorpayOrderId: string;
      razorpayKeyId: string;
      amount: number;
    currency: string;
    baseAmount: number;
    discountAmount: number;
    couponCode?: string;
    walletDeductedAmount?: number;
  };
}

@Service()
export class BookingService {
  constructor(
    private bookingRepository: BookingRepository,
    private wellnessPackageService: WellnessPackageService,
    private specialistService: SpecialistService,
    private notificationService: NotificationService,
    private slotService: SlotService,
    private couponService: CouponService,
    private paymentService: PaymentService,
    private paymentRepository: PaymentRepository,
    private bookingReminderScheduler: BookingReminderScheduler,
    private walletRepository: WalletRepository,
    private walletTransactionRepository: WalletTransactionRepository,
    private slotRepository: SlotRepository,
    private specialistRepository: SpecialistRepository,
    private userRepository: UserRepository,
    private emailService: EmailService
  ) {}

  private async sendPaidBookingEmailNotification(booking: IBooking): Promise<void> {
    try {
      const user = await this.userRepository.findById(booking.userId);
      if (!user?.email) {
        return;
      }

      const content = buildPaidBookingEmailContent({
        bookingId: booking._id,
        bookingType: booking.bookingType,
        bookingDate: booking.bookingDate,
        bookingTime: booking.bookingTime,
        userName: user.name,
        consultationMode: booking.consultationMode,
        serviceMode: booking.serviceMode,
        meetJoinUrl: booking.virtualMeeting?.joinUrl,
      });

      await this.emailService.sendEmail({
        to: [user.email],
        subject: content.subject,
        textBody: content.textBody,
        htmlBody: content.htmlBody,
      });
    } catch (error) {
      console.error('Failed to send paid booking email notification:', error);
    }
  }

  private buildDefaultFollowUpState(): IBookingFollowUp {
    return {
      isFollowUp: false,
      benefitUsed: false,
    };
  }

  private buildLifecyclePatch(
    current: IBookingLifecycle | undefined,
    updates: Parameters<typeof buildBookingLifecyclePatch>[1]
  ): IBookingLifecycle | undefined {
    return buildBookingLifecyclePatch(current, updates);
  }

  private parseBookingDateTime(
    bookingDate: string,
    bookingTime: string
  ): Date | null {
    if (!/^\d{8}$/.test(bookingDate)) {
      return null;
    }

    const match = bookingTime.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) {
      return null;
    }

    const [, hourStr, minuteStr, meridiem] = match;
    let hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);

    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
      return null;
    }

    const upperMeridiem = meridiem.toUpperCase();
    if (upperMeridiem === 'AM') {
      hour = hour === 12 ? 0 : hour;
    } else {
      hour = hour === 12 ? 12 : hour + 12;
    }

    const year = parseInt(bookingDate.slice(0, 4), 10);
    const monthIndex = parseInt(bookingDate.slice(4, 6), 10) - 1;
    const day = parseInt(bookingDate.slice(6, 8), 10);

    const parsed = new Date(year, monthIndex, day, hour, minute, 0, 0);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private enforceUserCancellationWindow(
    booking: IBooking,
    requester: { userType: string }
  ): void {
    const appointmentAt = this.parseBookingDateTime(
      booking.bookingDate,
      booking.bookingTime
    );

    if (!appointmentAt) {
      throw new AppError({
        status: 400,
        code: 'INVALID_BOOKING_DATETIME',
        message: 'Booking cannot be cancelled because its appointment time is invalid',
      });
    }

    const cutoffMs = 60 * 60 * 1000;
    const remainingMs = appointmentAt.getTime() - Date.now();

    if (remainingMs <= 0) {
      throw new AppError({
        status: 400,
        code: 'BOOKING_ALREADY_STARTED',
        message: 'Booking cannot be cancelled once the appointment time has passed',
      });
    }

    if (requester.userType !== 'user') {
      return;
    }

    if (remainingMs <= cutoffMs) {
      throw new AppError({
        status: 400,
        code: 'CANCELLATION_WINDOW_CLOSED',
        message:
          'Booking cannot be cancelled within 1 hour of the appointment time',
      });
    }
  }

  private isEligibleForNewFollowUpBenefit(booking: IBooking): boolean {
    return (
      booking.bookingType === 'consultation' &&
      booking.paymentStatus === 'paid' &&
      booking.followUp?.isFollowUp !== true
    );
  }

  private async validateAndPrepareFollowUp(
    data: CreateSpecialistBookingRequest,
    bookingType: Extract<BookingType, 'consultation' | 'second-opinion'>
  ): Promise<{
    basePriceOverride?: number;
    specialistIdOverride?: string;
    followUp?: IBookingFollowUp;
    parentConsultation?: IBooking;
  }> {
    if (!data.followUp?.isFollowUp) {
      return {};
    }

    if (bookingType !== 'consultation') {
      throw new AppError({
        status: 400,
        code: 'INVALID_FOLLOW_UP_BOOKING_TYPE',
        message: 'Follow-up is only available for consultation bookings',
      });
    }

    const parentConsultationId = data.followUp.parentConsultationId;
    if (!parentConsultationId) {
      throw new AppError({
        status: 400,
        code: 'PARENT_CONSULTATION_REQUIRED',
        message: 'Parent consultation ID is required for follow-up bookings',
      });
    }

    const parentConsultation = await this.bookingRepository.findById(
      parentConsultationId
    );

    if (!parentConsultation) {
      throw new AppError({
        status: 404,
        code: 'PARENT_CONSULTATION_NOT_FOUND',
        message: 'Parent consultation booking not found',
      });
    }

    if (parentConsultation.userId !== data.userId) {
      throw new AppError({
        status: 403,
        code: 'INVALID_PARENT_CONSULTATION',
        message: 'Parent consultation does not belong to this user',
      });
    }

    if (parentConsultation.bookingType !== 'consultation') {
      throw new AppError({
        status: 400,
        code: 'INVALID_PARENT_CONSULTATION',
        message: 'Only completed consultation bookings can be used for follow-up',
      });
    }

    if (parentConsultation.followUp?.isFollowUp) {
      throw new AppError({
        status: 400,
        code: 'FOLLOW_UP_CHAIN_NOT_ALLOWED',
        message: 'A follow-up consultation cannot generate another follow-up',
      });
    }

    if (parentConsultation.status !== 'completed') {
      throw new AppError({
        status: 400,
        code: 'PARENT_CONSULTATION_NOT_COMPLETED',
        message: 'Parent consultation must be completed before booking a follow-up',
      });
    }

    if (parentConsultation.paymentStatus !== 'paid') {
      throw new AppError({
        status: 400,
        code: 'PARENT_CONSULTATION_NOT_PAID',
        message: 'Only paid consultations are eligible for follow-up',
      });
    }

    if (parentConsultation.followUp?.benefitUsed) {
      throw new AppError({
        status: 400,
        code: 'FOLLOW_UP_ALREADY_USED',
        message: 'The free follow-up for this consultation has already been used',
      });
    }

    const eligibilityExpiresAt = parentConsultation.followUp?.eligibilityExpiresAt;
    if (!eligibilityExpiresAt) {
      throw new AppError({
        status: 400,
        code: 'FOLLOW_UP_NOT_ENABLED',
        message: 'This consultation is not eligible for follow-up',
      });
    }

    if (compareYyyymmdd(data.bookingDate, eligibilityExpiresAt) > 0) {
      throw new AppError({
        status: 400,
        code: 'FOLLOW_UP_EXPIRED',
        message: 'The free follow-up window for this consultation has expired',
      });
    }

    if (
      parentConsultation.specialistId &&
      data.specialistId !== parentConsultation.specialistId
    ) {
      throw new AppError({
        status: 400,
        code: 'FOLLOW_UP_SPECIALIST_MISMATCH',
        message: 'Follow-up consultation must be booked with the same specialist',
      });
    }

    return {
      basePriceOverride: 0,
      specialistIdOverride: parentConsultation.specialistId,
      followUp: {
        isFollowUp: true,
        parentConsultationId,
      },
      parentConsultation,
    };
  }

  private async activateFollowUpBenefitIfEligible(
    booking: IBooking
  ): Promise<IBooking> {
    if (!this.isEligibleForNewFollowUpBenefit(booking)) {
      return booking;
    }

    const completedAt = getTodayYyyymmdd();
    const followUp: IBookingFollowUp = {
      ...(booking.followUp || {}),
      isFollowUp: false,
      completedAt,
      eligibilityExpiresAt: addDaysToYyyymmdd(completedAt, 14),
      benefitUsed: false,
    };

    const updated = await this.bookingRepository.update(
      { _id: booking._id },
      { followUp }
    );

    return updated || { ...booking, followUp };
  }

  private async deductWalletForBooking(params: {
    userId: string;
    bookingId: string;
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
      referenceType: 'booking',
      referenceId: params.bookingId,
      description: 'Wallet used for booking payment',
      transactionDate: getTodayYyyymmdd(),
    });

    await this.walletRepository.update(
      { _id: wallet._id! },
      { balance: balanceAfter }
    );

    return walletDeductedAmount;
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

  private async refundBookingAmountToWallet(booking: IBooking): Promise<number> {
    const existingRefund = await this.walletTransactionRepository.findOne({
      userId: booking.userId,
      transactionType: 'refund',
      referenceType: 'booking',
      referenceId: booking._id!,
      status: 'completed',
    });

    if (existingRefund) {
      return existingRefund.amount;
    }

    if (!booking.paymentTransactionId) {
      return 0;
    }

    const paymentRecord = await this.paymentRepository.findById(
      booking.paymentTransactionId
    );

    if (!paymentRecord) {
      return 0;
    }

    const walletDeductedAmount = Number(
      paymentRecord.notes?.walletDeductedAmount || 0
    );
    const gatewayPaidAmount =
      paymentRecord.status === 'paid' ? Number(paymentRecord.finalAmount || 0) : 0;
    const refundAmount = walletDeductedAmount + gatewayPaidAmount;

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
        referenceType: 'booking',
        referenceId: booking._id!,
        description: 'Refund for cancelled booking',
        transactionDate: getTodayYyyymmdd(),
      });

      await this.walletRepository.update(
        { _id: wallet._id! },
        { balance: balanceAfter }
      );
    }

    if (paymentRecord.status === 'paid') {
      if (paymentRecord.couponCode) {
        try {
          const coupon = await this.couponService.getByCode(paymentRecord.couponCode);
          await this.couponService.decrementUsage(coupon._id!);
        } catch (error) {
          console.error('Failed to reverse coupon usage for cancelled booking:', error);
        }
      }

      await this.paymentRepository.update(
        { _id: paymentRecord._id! },
        { status: 'refunded', isProcessed: true }
      );
    }

    return refundAmount;
  }

  private async validateBookingDateAndSlot(
    bookingDate: string,
    slotId: string,
    options?: { allowCurrentSlotId?: string }
  ): Promise<void> {
    const today = getTodayYyyymmdd();
    if (compareYyyymmdd(bookingDate, today) < 0) {
      throw new AppError({
        status: 400,
        code: 'INVALID_BOOKING_DATE',
        message: 'Booking date cannot be in the past',
      });
    }

    const slot = await this.slotService.getById(slotId);
    if (
      !slot.isActive ||
      (!slot.isAvailable && slotId !== options?.allowCurrentSlotId)
    ) {
      throw new AppError({
        status: 400,
        code: 'SLOT_NOT_AVAILABLE',
        message: 'Slot is not available for booking',
      });
    }

    if (
      slot.currentBookings &&
      slot.maxBookings &&
      slot.currentBookings >= slot.maxBookings &&
      slotId !== options?.allowCurrentSlotId
    ) {
      throw new AppError({
        status: 400,
        code: 'SLOT_FULL',
        message: 'Slot is already full',
      });
    }
  }

  private async ensureCancelledBookingPaymentStatus(
    booking: IBooking
  ): Promise<IBooking> {
    if (!booking._id || booking.paymentStatus === 'refunded') {
      return booking;
    }

    return (
      (await this.bookingRepository.update(
        { _id: booking._id },
        {
          paymentStatus: 'refunded',
          lifecycle: this.buildLifecyclePatch(booking.lifecycle, {
            refunded: {
              reason: booking.cancellationReason || 'Booking refunded',
            },
          }),
        }
      )) || booking
    );
  }

  private async validateInternalBookingCoupon(params: {
    couponCode?: string;
    userId: string;
    bookingType: 'package' | 'consultation';
    bookingId: string;
    purchaseAmount: number;
    dependentId?: string;
    corporateId?: string;
  }): Promise<{ discountAmount: number; finalAmount: number; couponCode?: string }> {
    if (!params.couponCode || params.purchaseAmount <= 0) {
      return {
        discountAmount: 0,
        finalAmount: params.purchaseAmount,
      };
    }

    const couponValidation = await this.couponService.validateCoupon({
      code: params.couponCode,
      userId: params.userId,
      bookingType: params.bookingType,
      bookingId: params.bookingId,
      dependentId: params.dependentId,
      corporateId: params.corporateId,
      purchaseAmount: params.purchaseAmount,
    });

    if (!couponValidation.isValid || !couponValidation.coupon) {
      throw new AppError({
        status: 400,
        code: 'INVALID_COUPON',
        message: couponValidation.message || 'Invalid coupon code',
      });
    }

    return {
      discountAmount: couponValidation.discountAmount || 0,
      finalAmount: couponValidation.finalAmount ?? params.purchaseAmount,
      couponCode: couponValidation.coupon.code,
    };
  }

  private async resolveRetryBookingCoupon(params: {
    booking: IBooking;
    bookingType: 'package' | 'consultation';
    grossAmount: number;
    requesterCorporateId?: string;
    couponCode?: string;
  }): Promise<{ discountAmount: number; couponCode?: string }> {
    if (!params.couponCode || params.grossAmount <= 0) {
      return { discountAmount: 0 };
    }

    const bookingId =
      params.bookingType === 'package'
        ? params.booking.wellnessPackageId
        : params.booking.specialistId;

    if (!bookingId) {
      throw new AppError({
        status: 400,
        code: 'BOOKING_TARGET_NOT_FOUND',
        message: 'Booking target not found for coupon validation',
      });
    }

    const couponValidation = await this.validateInternalBookingCoupon({
      couponCode: params.couponCode,
      userId: params.booking.userId,
      bookingType: params.bookingType,
      bookingId,
      dependentId: params.booking.dependentId,
      corporateId: params.requesterCorporateId || params.booking.corporateId,
      purchaseAmount: params.grossAmount,
    });

    return {
      discountAmount: couponValidation.discountAmount,
      couponCode: couponValidation.couponCode,
    };
  }

  async createBooking(
    data: CreateBookingRequest
  ): Promise<BookingPaymentInitResponse> {
    if (data.bookingType === 'package') {
      return this.createWellnessPackageBooking(
        data as CreateWellnessPackageBookingRequest
      );
    }

    if (data.bookingType === 'consultation') {
      return this.createSpecialistBooking(
        data as CreateSpecialistBookingRequest,
        'consultation'
      );
    }

    if (data.bookingType === 'second-opinion') {
      return this.createSpecialistBooking(
        data as CreateSpecialistBookingRequest,
        'second-opinion'
      );
    }

    return this.createSurgeryBooking(data);
  }

  async createWellnessPackageBooking(
    data: CreateWellnessPackageBookingRequest
  ): Promise<BookingPaymentInitResponse> {
    const wellnessPackage = await this.wellnessPackageService.getById(
      data.wellnessPackageId
    );

    if (!wellnessPackage.isActive) {
      throw new AppError({
        status: 400,
        code: 'PACKAGE_NOT_ACTIVE',
        message: 'Wellness package is not active',
      });
    }

    await this.validateBookingDateAndSlot(data.bookingDate, data.slotId);

    const basePrice = wellnessPackage.discountedPrice || wellnessPackage.originalPrice;
    const originalPrice = wellnessPackage.originalPrice;

    let discountAmount = 0;
    let finalPrice = basePrice;
    let couponCode: string | undefined;

    if (data.couponCode) {
      const couponResult = await this.validateInternalBookingCoupon({
        couponCode: data.couponCode,
        userId: data.userId,
        bookingType: 'package',
        bookingId: data.wellnessPackageId,
        dependentId: data.dependentId,
        corporateId: data.corporateId,
        purchaseAmount: basePrice,
      });

      discountAmount = couponResult.discountAmount;
      finalPrice = couponResult.finalAmount;
      couponCode = couponResult.couponCode;
    }

    await this.validateWalletIfRequested(data.userId, data.useWalletBalance);

    const booking: IBooking = {
      bookingType: 'package',
      userId: data.userId,
      pharmacyId: data.pharmacyId,
      dependentId: data.dependentId,
      corporateId: data.corporateId,
      wellnessPackageId: data.wellnessPackageId,
      packageName: data.packageName?.trim() || wellnessPackage.name,
      slotId: data.slotId,
      bookingDate: data.bookingDate,
      bookingTime: data.bookingTime,
      serviceMode: data.serviceMode,
      serviceAddress: data.serviceAddress,
      documents: data.documents || [],
      prescription: data.prescription,
      report: data.report,
      followUp: this.buildDefaultFollowUpState(),
      contactNo: data.contactNo,
      alternateContactNo: data.alternateContactNo,
      price: finalPrice,
      originalPrice,
      status: 'pending',
      paymentStatus: finalPrice > 0 ? 'pending' : 'paid',
      lifecycle: this.buildLifecyclePatch(undefined, {
        created: true,
      }),
      notes: data.notes,
    };

    const savedBooking = await this.bookingRepository.save(booking);

    try {
      await this.slotService.incrementBookingCount(data.slotId);
    } catch (error) {
      console.error('Failed to increment slot booking count:', error);
    }

    try {
      await this.notificationService.createBookingCreatedNotification(
        data.userId,
        savedBooking._id!,
        {
          bookingType: 'package',
          bookingDate: data.bookingDate,
          bookingTime: data.bookingTime,
          price: finalPrice,
          packageName: wellnessPackage.name,
        }
      );
    } catch (error) {
      console.error('Failed to create booking notification:', error);
    }

    let walletDeductedAmount = 0;
    if (finalPrice > 0 && data.useWalletBalance) {
      walletDeductedAmount = await this.deductWalletForBooking({
        userId: data.userId,
        bookingId: savedBooking._id!,
        amountToDeductFromWallet: finalPrice,
        useWalletBalance: true,
      });
    }

    const payableAfterWallet = Math.max(0, finalPrice - walletDeductedAmount);

    if (payableAfterWallet <= 0) {
      const directPaidTransaction = await this.paymentService.createDirectPaidTransaction({
        userId: data.userId,
        context: 'booking',
        contextId: savedBooking._id!,
        baseAmount: basePrice,
        discountAmount,
        finalAmount: 0,
        couponCode,
        notes: {
          bookingType: 'package',
          reason: finalPrice <= 0 ? 'zero_payable_amount' : 'wallet_covered_amount',
          walletDeductedAmount,
        },
      });

      const paidBooking = await this.bookingRepository.update(
        { _id: savedBooking._id },
        {
          status: 'confirmed',
          paymentStatus: 'paid',
          paymentTransactionId: directPaidTransaction._id!,
          lifecycle: this.buildLifecyclePatch(savedBooking.lifecycle, {
            paid: { amount: finalPrice },
            confirmed: true,
          }),
        }
      );

      if (couponCode) {
        const coupon = await this.couponService.getByCode(couponCode);
        await this.couponService.incrementUsage(coupon._id!);
      }

      await this.bookingReminderScheduler.scheduleBookingReminders(
        paidBooking || savedBooking
      );
      const bookingWithMeeting = await syncBookingMeet({
        booking: paidBooking || savedBooking,
        bookingRepository: this.bookingRepository,
        userRepository: this.userRepository,
        specialistRepository: this.specialistRepository,
        slotRepository: this.slotRepository,
      });
      await this.sendPaidBookingEmailNotification(bookingWithMeeting);

      return {
        booking: bookingWithMeeting,
        paymentRequired: false,
        walletDeductedAmount,
      };
    }

    const order = await this.paymentService.createOrder({
      userId: data.userId,
      context: 'booking',
      contextId: savedBooking._id!,
      baseAmount: basePrice,
      discountAmount,
      finalAmount: payableAfterWallet,
      couponCode,
      notes: {
        bookingType: 'package',
        walletDeductedAmount,
      },
    });

    const bookingWithOrder = await this.bookingRepository.update(
      { _id: savedBooking._id },
      {
        paymentTransactionId: order.paymentRecord._id!,
        lifecycle: this.buildLifecyclePatch(savedBooking.lifecycle, {
          paymentPending: { amount: payableAfterWallet },
        }),
      }
    );

    return {
      booking: bookingWithOrder || savedBooking,
      paymentRequired: true,
      walletDeductedAmount,
      payment: {
        paymentTransactionId: order.paymentRecord._id!,
        razorpayOrderId: order.razorpayOrder.id,
        razorpayKeyId: order.razorpayKeyId,
        amount: payableAfterWallet,
        currency: order.razorpayOrder.currency,
        baseAmount: basePrice,
        discountAmount,
        couponCode,
        walletDeductedAmount,
      },
    };
  }

  async createSpecialistBooking(
    data: CreateSpecialistBookingRequest,
    bookingType: Extract<BookingType, 'consultation' | 'second-opinion'> = 'consultation'
  ): Promise<BookingPaymentInitResponse> {
    const followUpConfig = await this.validateAndPrepareFollowUp(
      data,
      bookingType
    );

    const specialistId = followUpConfig.specialistIdOverride || data.specialistId;
    const specialist = await this.specialistService.getById(specialistId);

    if (!specialist.isActive) {
      throw new AppError({
        status: 400,
        code: 'SPECIALIST_NOT_ACTIVE',
        message: 'Specialist is not active',
      });
    }

    await this.validateBookingDateAndSlot(data.bookingDate, data.slotId);

    const basePrice = followUpConfig.basePriceOverride !== undefined
      ? followUpConfig.basePriceOverride
      : bookingType === 'second-opinion'
        ? 0
        : specialist.isConsultationFree
          ? 0
          : specialist.consultationFee || 0;

    let discountAmount = 0;
    let finalPrice = basePrice;
    let couponCode: string | undefined;

    if (data.couponCode && basePrice > 0) {
      const couponResult = await this.validateInternalBookingCoupon({
        couponCode: data.couponCode,
        userId: data.userId,
        bookingType: 'consultation',
        bookingId: specialistId,
        dependentId: data.dependentId,
        corporateId: data.corporateId,
        purchaseAmount: basePrice,
      });

      discountAmount = couponResult.discountAmount;
      finalPrice = couponResult.finalAmount;
      couponCode = couponResult.couponCode;
    }

    await this.validateWalletIfRequested(data.userId, data.useWalletBalance);

    const booking: IBooking = {
      bookingType,
      userId: data.userId,
      pharmacyId: data.pharmacyId,
      dependentId: data.dependentId,
      corporateId: data.corporateId,
      specialistId,
      doctorName: data.doctorName?.trim() || specialist.name,
      primaryConcern: data.primaryConcern,
      consultationMode: data.consultationMode,
      slotId: data.slotId,
      bookingDate: data.bookingDate,
      bookingTime: data.bookingTime,
      serviceMode: data.consultationMode === 'in-person' ? 'in-person' : data.consultationMode,
      serviceAddress: data.serviceAddress,
      documents: data.documents || [],
      prescription: data.prescription,
      report: data.report,
      followUp: followUpConfig.followUp || this.buildDefaultFollowUpState(),
      contactNo: data.contactNo,
      alternateContactNo: data.alternateContactNo,
      price: finalPrice,
      status: 'pending',
      paymentStatus: finalPrice > 0 ? 'pending' : 'paid',
      lifecycle: this.buildLifecyclePatch(undefined, {
        created: true,
      }),
      notes: data.notes,
    };

    const savedBooking = await this.bookingRepository.save(booking);

    if (followUpConfig.parentConsultation?._id) {
      await this.bookingRepository.update(
        { _id: followUpConfig.parentConsultation._id },
        {
          followUp: {
            ...(followUpConfig.parentConsultation.followUp || {}),
            isFollowUp: false,
            completedAt: followUpConfig.parentConsultation.followUp?.completedAt,
            eligibilityExpiresAt:
              followUpConfig.parentConsultation.followUp?.eligibilityExpiresAt,
            benefitUsed: true,
          },
        }
      );
    }

    try {
      await this.slotService.incrementBookingCount(data.slotId);
    } catch (error) {
      console.error('Failed to increment slot booking count:', error);
    }

    try {
      await this.notificationService.createBookingCreatedNotification(
        data.userId,
        savedBooking._id!,
        {
          bookingType,
          bookingDate: data.bookingDate,
          bookingTime: data.bookingTime,
          price: finalPrice,
          specialistName: specialist.name,
          consultationMode: data.consultationMode,
        }
      );
    } catch (error) {
      console.error('Failed to create booking notification:', error);
    }

    try {
      await this.notificationService.createSpecialistNewBookingNotification(
        specialistId,
        savedBooking._id!,
        {
          bookingType,
          bookingDate: data.bookingDate,
          bookingTime: data.bookingTime,
          consultationMode: data.consultationMode,
          userId: data.userId,
        }
      );
    } catch (error) {
      console.error('Failed to create specialist booking notification:', error);
    }

    let walletDeductedAmount = 0;
    if (finalPrice > 0 && data.useWalletBalance) {
      walletDeductedAmount = await this.deductWalletForBooking({
        userId: data.userId,
        bookingId: savedBooking._id!,
        amountToDeductFromWallet: finalPrice,
        useWalletBalance: true,
      });
    }

    const payableAfterWallet = Math.max(0, finalPrice - walletDeductedAmount);

    if (payableAfterWallet <= 0) {
      const directPaidTransaction = await this.paymentService.createDirectPaidTransaction({
        userId: data.userId,
        context: 'booking',
        contextId: savedBooking._id!,
        baseAmount: basePrice,
        discountAmount,
        finalAmount: 0,
        couponCode,
        notes: {
          bookingType,
          reason: finalPrice <= 0 ? 'zero_payable_amount' : 'wallet_covered_amount',
          walletDeductedAmount,
        },
      });

      const paidBooking = await this.bookingRepository.update(
        { _id: savedBooking._id },
        {
          status: 'confirmed',
          paymentStatus: 'paid',
          paymentTransactionId: directPaidTransaction._id!,
          lifecycle: this.buildLifecyclePatch(savedBooking.lifecycle, {
            paid: { amount: finalPrice },
            confirmed: true,
          }),
        }
      );

      if (couponCode) {
        const coupon = await this.couponService.getByCode(couponCode);
        await this.couponService.incrementUsage(coupon._id!);
      }

      await this.bookingReminderScheduler.scheduleBookingReminders(
        paidBooking || savedBooking
      );
      const bookingWithMeeting = await syncBookingMeet({
        booking: paidBooking || savedBooking,
        bookingRepository: this.bookingRepository,
        userRepository: this.userRepository,
        specialistRepository: this.specialistRepository,
        slotRepository: this.slotRepository,
      });
      await this.sendPaidBookingEmailNotification(bookingWithMeeting);

      return {
        booking: bookingWithMeeting,
        paymentRequired: false,
        walletDeductedAmount,
      };
    }

    const order = await this.paymentService.createOrder({
      userId: data.userId,
      context: 'booking',
      contextId: savedBooking._id!,
      baseAmount: basePrice,
      discountAmount,
      finalAmount: payableAfterWallet,
      couponCode,
      notes: {
        bookingType,
        walletDeductedAmount,
      },
    });

    const bookingWithOrder = await this.bookingRepository.update(
      { _id: savedBooking._id },
      {
        paymentTransactionId: order.paymentRecord._id!,
        lifecycle: this.buildLifecyclePatch(savedBooking.lifecycle, {
          paymentPending: { amount: payableAfterWallet },
        }),
      }
    );

    return {
      booking: bookingWithOrder || savedBooking,
      paymentRequired: true,
      walletDeductedAmount,
      payment: {
        paymentTransactionId: order.paymentRecord._id!,
        razorpayOrderId: order.razorpayOrder.id,
        razorpayKeyId: order.razorpayKeyId,
        amount: payableAfterWallet,
        currency: order.razorpayOrder.currency,
        baseAmount: basePrice,
        discountAmount,
        couponCode,
        walletDeductedAmount,
      },
    };
  }

  async createSurgeryBooking(
    data: CreateBookingRequest
  ): Promise<BookingPaymentInitResponse> {
    const today = getTodayYyyymmdd();
    if (compareYyyymmdd(data.bookingDate, today) < 0) {
      throw new AppError({
        status: 400,
        code: 'INVALID_BOOKING_DATE',
        message: 'Booking date cannot be in the past',
      });
    }

    const booking: IBooking = {
      bookingType: 'surgery',
      userId: data.userId,
      pharmacyId: data.pharmacyId,
      dependentId: data.dependentId,
      corporateId: data.corporateId,
      wellnessPackageId: data.wellnessPackageId,
      packageName: data.packageName?.trim(),
      specialistId: data.specialistId,
      doctorName: data.doctorName?.trim(),
      primaryConcern: data.primaryConcern,
      consultationMode: data.consultationMode,
      slotId: data.slotId,
      bookingDate: data.bookingDate,
      bookingTime: data.bookingTime,
      serviceMode: data.serviceMode || 'in-person',
      serviceAddress: data.serviceAddress,
      documents: data.documents || [],
      prescription: data.prescription,
      report: data.report,
      followUp: this.buildDefaultFollowUpState(),
      contactNo: data.contactNo,
      alternateContactNo: data.alternateContactNo,
      price: 0,
      status: 'confirmed',
      paymentStatus: 'paid',
      lifecycle: this.buildLifecyclePatch(undefined, {
        created: true,
        paid: { amount: 0 },
        confirmed: true,
      }),
      notes: data.notes,
    };

    const savedBooking = await this.bookingRepository.save(booking);

    try {
      await this.notificationService.createBookingCreatedNotification(
        data.userId,
        savedBooking._id!,
        {
          bookingType: 'surgery',
          bookingDate: data.bookingDate,
          bookingTime: data.bookingTime,
          price: 0,
        }
      );
    } catch (error) {
      console.error('Failed to create booking notification:', error);
    }

    await this.bookingReminderScheduler.scheduleBookingReminders(savedBooking);
    const bookingWithMeeting = await syncBookingMeet({
      booking: savedBooking,
      bookingRepository: this.bookingRepository,
      userRepository: this.userRepository,
      specialistRepository: this.specialistRepository,
      slotRepository: this.slotRepository,
    });
    await this.sendPaidBookingEmailNotification(bookingWithMeeting);

    return {
      booking: bookingWithMeeting,
      paymentRequired: false,
      walletDeductedAmount: 0,
    };
  }

  async getById(id: string, userId?: string): Promise<IBooking> {
    const query: any = { _id: id };

    if (userId) {
      query.userId = userId;
    }

    const booking = await this.bookingRepository.findOne(query);

    if (!booking) {
      throw new AppError({
        status: 404,
        code: 'BOOKING_NOT_FOUND',
        message: 'Booking not found',
      });
    }

    return booking;
  }

  async getPaymentDetails(
    id: string,
    requester: { _id: string; userType: string; corporateId?: string; pharmacyId?: string }
  ): Promise<BookingPaymentDetailsResponse> {
    const booking = await this.getById(id);

    if (
      requester.userType !== 'admin' &&
      !(
        requester.userType === 'pharmacy' &&
        requester.pharmacyId &&
        String(booking.pharmacyId) === String(requester.pharmacyId)
      ) &&
      !(
        requester.userType === 'hr' &&
        requester.corporateId &&
        String(booking.corporateId) === String(requester.corporateId)
      ) &&
      String(booking.userId) !== String(requester._id)
    ) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'You are not allowed to view this booking payment detail',
      });
    }

    const paymentRecord = booking.paymentTransactionId
      ? await this.paymentRepository.findById(booking.paymentTransactionId)
      : null;

    const walletTransactions =
      await this.walletTransactionRepository.findByReference(
        'booking',
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
    const amountChargedToRazorpay = paymentRecord
      ? Number(paymentRecord.finalAmount || 0)
      : 0;

    return {
      booking: {
        _id: booking._id,
        userId: booking.userId,
        bookingType: booking.bookingType,
        bookingDate: booking.bookingDate,
        bookingTime: booking.bookingTime,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        price: booking.price,
        originalPrice: booking.originalPrice,
        paymentTransactionId: booking.paymentTransactionId,
      },
      payment: paymentRecord
        ? {
            paymentTransactionId: paymentRecord._id!,
            paymentGateway: paymentRecord.paymentGateway,
            paymentStatus: paymentRecord.status,
            couponCode: paymentRecord.couponCode,
            baseAmount: paymentRecord.baseAmount,
            discountAmount: paymentRecord.discountAmount,
            finalAmount: paymentRecord.finalAmount,
            currency: paymentRecord.currency,
            razorpayOrderId: paymentRecord.razorpayOrderId,
            razorpayPaymentId: paymentRecord.razorpayPaymentId,
            paidAt: paymentRecord.paidAt,
            createdAt: paymentRecord.createdAt,
            updatedAt: paymentRecord.updatedAt,
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
        couponCode: paymentRecord?.couponCode,
        amountChargedToRazorpay,
        amountUsedFromWallet,
        amountRefunded,
        actualAmountPaid: amountChargedToRazorpay + amountUsedFromWallet,
        paidAt: paymentRecord?.paidAt,
      },
    };
  }

  async getAll(
    queryParams: BookingQueryParams = {},
    requiredCorporateId?: string
  ): Promise<{
    data: IBooking[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    if (requiredCorporateId !== undefined) {
      if (
        typeof requiredCorporateId !== 'string' ||
        !/^[0-9a-fA-F]{24}$/.test(requiredCorporateId)
      ) {
        throw new AppError({
          status: 403,
          code: 'HR_CORPORATE_REQUIRED',
          message: 'HR account must be linked to a corporate',
        });
      }

      const scopedQuery: BookingQueryParams = {
        ...queryParams,
        corporateId: requiredCorporateId,
        forUser: false,
      };
      if (scopedQuery.page && scopedQuery.limit) {
        return this.bookingRepository.findWithPagination(
          scopedQuery,
          scopedQuery.page,
          scopedQuery.limit
        );
      }

      const filter: any = { corporateId: requiredCorporateId };
      let sort: any = { bookingDate: -1, createdAt: -1 };
      if (scopedQuery.userId) {
        filter.userId = scopedQuery.userId;
      } else if (scopedQuery.dependentId) {
        filter.dependentId = scopedQuery.dependentId;
      } else if (scopedQuery.wellnessPackageId) {
        filter.wellnessPackageId = scopedQuery.wellnessPackageId;
        filter.bookingType = 'package';
        sort = { bookingDate: -1 };
      } else if (scopedQuery.specialistId) {
        filter.specialistId = scopedQuery.specialistId;
        filter.bookingType = 'consultation';
        sort = { bookingDate: -1 };
      } else {
        if (scopedQuery.pharmacyId) {
          filter.pharmacyId = scopedQuery.pharmacyId;
        }
        if (scopedQuery.bookingType) {
          filter.bookingType = scopedQuery.bookingType;
        }
        if (scopedQuery.status) {
          filter.status = scopedQuery.status;
        }
        if (scopedQuery.paymentStatus) {
          filter.paymentStatus = scopedQuery.paymentStatus;
        }
        if (scopedQuery.sortBy) {
          sort = {
            [scopedQuery.sortBy]: scopedQuery.sortOrder === 'desc' ? -1 : 1,
          };
        }
      }

      const data = await this.bookingRepository.findAll(filter, { sort });
      return { data };
    }

    if (queryParams.page && queryParams.limit) {
      return this.bookingRepository.findWithPagination(
        queryParams,
        queryParams.page,
        queryParams.limit
      );
    }

    const filter: any = {};

    if (queryParams.userId) {
      filter.userId = queryParams.userId;
    }

    if (queryParams.pharmacyId) {
      filter.pharmacyId = queryParams.pharmacyId;
    }

    if (queryParams.dependentId) {
      filter.dependentId = queryParams.dependentId;
    }

    if (queryParams.forUser) {
      filter.corporateId = { $exists: false };
    } else if (queryParams.corporateId) {
      filter.corporateId = queryParams.corporateId;
    }

    if (queryParams.bookingType) {
      filter.bookingType = queryParams.bookingType;
    }

    if (queryParams.wellnessPackageId) {
      filter.wellnessPackageId = queryParams.wellnessPackageId;
    }

    if (queryParams.specialistId) {
      filter.specialistId = queryParams.specialistId;
    }

    if (queryParams.status) {
      filter.status = queryParams.status;
    }

    if (queryParams.paymentStatus) {
      filter.paymentStatus = queryParams.paymentStatus;
    }

    const sort: any = {};
    if (queryParams.sortBy) {
      sort[queryParams.sortBy] = queryParams.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.bookingDate = -1;
      sort.createdAt = -1;
    }

    let data: IBooking[];

    if (queryParams.userId) {
      data = await this.bookingRepository.findByUserId(queryParams.userId);
    } else if (queryParams.dependentId) {
      data = await this.bookingRepository.findByDependentId(
        queryParams.dependentId
      );
    } else if (queryParams.wellnessPackageId) {
      data = await this.bookingRepository.findByWellnessPackageId(
        queryParams.wellnessPackageId
      );
    } else if (queryParams.specialistId) {
      data = await this.bookingRepository.findBySpecialistId(
        queryParams.specialistId
      );
    } else {
      data = await this.bookingRepository.findAll(filter, { sort });
    }

    return { data };
  }

  async update(
    id: string,
    data: UpdateBookingRequest,
    userId?: string
  ): Promise<IBooking> {
    const booking = await this.getById(id, userId);

    if (data.bookingDate) {
      const today = getTodayYyyymmdd();
      if (compareYyyymmdd(data.bookingDate, today) < 0) {
        throw new AppError({
          status: 400,
          code: 'INVALID_BOOKING_DATE',
          message: 'Booking date cannot be in the past',
        });
      }
    }

    if (data.status === 'cancelled' && booking.status !== 'cancelled') {
      data.cancelledAt = getTodayYyyymmdd();
      data.paymentStatus = 'refunded';
      if (!data.cancellationReason) {
        data.cancellationReason = 'Cancelled by user';
      }
    }

    const lifecyclePatch = this.buildLifecyclePatch(booking.lifecycle, {
      paymentPending:
        data.paymentStatus === 'pending' && booking.paymentStatus !== 'pending'
          ? { amount: booking.price }
          : undefined,
      paid:
        data.paymentStatus === 'paid' && booking.paymentStatus !== 'paid'
          ? { amount: booking.price }
          : undefined,
      confirmed:
        data.status === 'confirmed' && booking.status !== 'confirmed'
          ? true
          : undefined,
      cancelled:
        data.status === 'cancelled' && booking.status !== 'cancelled'
          ? { reason: data.cancellationReason || 'Cancelled by user' }
          : undefined,
      completed:
        data.status === 'completed' && booking.status !== 'completed'
          ? true
          : undefined,
      refunded:
        data.paymentStatus === 'refunded' && booking.paymentStatus !== 'refunded'
          ? {
              reason:
                data.cancellationReason ||
                booking.cancellationReason ||
                'Booking refunded',
            }
          : undefined,
    });

    if (lifecyclePatch) {
      data.lifecycle = lifecyclePatch;
    }

    const updated = await this.bookingRepository.update({ _id: id }, data);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update booking',
      });
    }

    const becameCompleted =
      booking.status !== 'completed' && updated.status === 'completed';

    if (becameCompleted) {
      await this.bookingReminderScheduler.clearBookingReminders(updated._id!);
      const completedBooking = await this.activateFollowUpBenefitIfEligible(
        updated
      );
      const meetingUpdatedBooking = await cancelBookingMeet({
        booking: completedBooking,
        reason: 'Booking completed',
        bookingRepository: this.bookingRepository,
      });
      return meetingUpdatedBooking;
    }

    if (updated.status === 'cancelled' || data.status === 'cancelled') {
      const cancelledBooking =
        await this.ensureCancelledBookingPaymentStatus(updated);
      await this.bookingReminderScheduler.clearBookingReminders(
        cancelledBooking._id!
      );
      const meetingUpdatedBooking = await cancelBookingMeet({
        booking: cancelledBooking,
        reason: data.cancellationReason,
        bookingRepository: this.bookingRepository,
      });
      return meetingUpdatedBooking;
    } else if (
      updated.status === 'confirmed' &&
      (
        data.status !== undefined ||
        data.bookingDate !== undefined ||
        data.bookingTime !== undefined
      )
    ) {
      await this.bookingReminderScheduler.scheduleBookingReminders(updated);
      return syncBookingMeet({
        booking: updated,
        bookingRepository: this.bookingRepository,
        userRepository: this.userRepository,
        specialistRepository: this.specialistRepository,
        slotRepository: this.slotRepository,
      });
    }

    return updated;
  }

  async delete(id: string, userId?: string): Promise<void> {
    const booking = await this.getById(id, userId);
    await this.bookingReminderScheduler.clearBookingReminders(booking._id!);
    await cancelBookingMeet({
      booking,
      reason: 'Booking deleted',
      bookingRepository: this.bookingRepository,
    });

    if (booking.slotId) {
      try {
        const slot = await this.slotRepository.findById(booking.slotId);
        if (slot?.currentBookings && slot.currentBookings > 0) {
          await this.slotService.decrementBookingCount(booking.slotId);
        }
      } catch (error) {
        console.error('Failed to decrement slot booking count:', error);
      }
    }

    await this.bookingRepository.delete({ _id: id });
  }

  async getByUserId(userId: string): Promise<IBooking[]> {
    return this.bookingRepository.findByUserId(userId);
  }

  async getUpcomingBookings(userId?: string): Promise<IBooking[]> {
    return this.bookingRepository.findUpcomingBookings(userId);
  }

  async cancelBooking(
    bookingId: string,
    data: { cancellationReason?: string },
    requester: { _id: string; userType: string }
  ): Promise<IBooking> {
    const booking =
      requester.userType === 'admin'
        ? await this.getById(bookingId)
        : await this.getById(bookingId, requester._id);

    if (booking.status === 'cancelled') {
      return booking;
    }

    this.enforceUserCancellationWindow(booking, requester);

    const updated = await this.bookingRepository.update(
      { _id: bookingId },
      {
        status: 'cancelled',
        paymentStatus: 'refunded',
        cancellationReason: data.cancellationReason || 'Cancelled by user',
        cancelledAt: getTodayYyyymmdd(),
        lifecycle: this.buildLifecyclePatch(booking.lifecycle, {
          cancelled: {
            reason: data.cancellationReason || 'Cancelled by user',
          },
          refunded: {
            reason: data.cancellationReason || 'Cancelled by user',
          },
        }),
      }
    );

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to cancel booking',
      });
    }

    try {
      await this.refundBookingAmountToWallet(booking);
    } catch (error) {
      console.error('Failed to refund cancelled booking amount to wallet:', error);
    }

    if (booking.specialistId) {
      try {
        await this.notificationService.createSpecialistAppointmentCancelledNotification(
          booking.specialistId,
          bookingId,
          {
            bookingType: booking.bookingType,
            bookingDate: booking.bookingDate,
            bookingTime: booking.bookingTime,
            cancellationReason: data.cancellationReason || 'Cancelled by user',
            userId: booking.userId,
          }
        );
      } catch (error) {
        console.error(
          'Failed to create specialist cancellation notification:',
          error
        );
      }
    }

    if (
      booking.followUp?.isFollowUp &&
      booking.followUp.parentConsultationId &&
      booking.status !== 'completed'
    ) {
      try {
        const parentConsultation = await this.bookingRepository.findById(
          booking.followUp.parentConsultationId
        );

        if (parentConsultation) {
          await this.bookingRepository.update(
            { _id: parentConsultation._id },
            {
              followUp: {
                ...(parentConsultation.followUp || {}),
                isFollowUp: false,
                completedAt: parentConsultation.followUp?.completedAt,
                eligibilityExpiresAt:
                  parentConsultation.followUp?.eligibilityExpiresAt,
                benefitUsed: false,
              },
            }
          );
        }
      } catch (error) {
        console.error('Failed to restore parent follow-up benefit:', error);
      }
    }

    const finalBooking = await this.ensureCancelledBookingPaymentStatus(updated);

    await this.bookingReminderScheduler.clearBookingReminders(finalBooking._id!);

    if (booking.slotId) {
      try {
        const slot = await this.slotRepository.findById(booking.slotId);
        if (slot?.currentBookings && slot.currentBookings > 0) {
          await this.slotService.decrementBookingCount(booking.slotId);
        }
      } catch (error) {
        console.error('Failed to decrement slot booking count:', error);
      }
    }

    return cancelBookingMeet({
      booking: finalBooking,
      reason: finalBooking.cancellationReason,
      bookingRepository: this.bookingRepository,
    });
  }

  async rescheduleBooking(
    bookingId: string,
    data: {
      slotId: string;
      bookingDate?: string;
      bookingTime?: string;
      serviceMode?: IBooking['serviceMode'];
      serviceAddress?: IBooking['serviceAddress'];
      consultationMode?: IBooking['consultationMode'];
      notes?: string;
    },
    requester: { _id: string; userType: string }
  ): Promise<IBooking> {
    const booking =
      requester.userType === 'admin'
        ? await this.getById(bookingId)
        : await this.getById(bookingId, requester._id);

    if (booking.status === 'cancelled') {
      throw new AppError({
        status: 400,
        code: 'BOOKING_CANCELLED',
        message: 'Cancelled bookings cannot be rescheduled',
      });
    }

    if (booking.status === 'completed') {
      throw new AppError({
        status: 400,
        code: 'BOOKING_COMPLETED',
        message: 'Completed bookings cannot be rescheduled',
      });
    }

    const nextSlot = await this.slotService.getById(data.slotId);
    const nextBookingDate = data.bookingDate || nextSlot.date;
    const nextBookingTime = data.bookingTime || nextSlot.startTime;

    await this.validateBookingDateAndSlot(nextBookingDate, data.slotId, {
      allowCurrentSlotId: booking.slotId,
    });

    const oldSlotId = booking.slotId;
    const newSlotId = data.slotId;
    const slotChanged = !!newSlotId && newSlotId !== oldSlotId;

    if (slotChanged) {
      await this.slotService.incrementBookingCount(newSlotId);
      try {
        if (oldSlotId) {
          const oldSlot = await this.slotRepository.findById(oldSlotId);
          if (oldSlot?.currentBookings && oldSlot.currentBookings > 0) {
            await this.slotService.decrementBookingCount(oldSlotId);
          }
        }
      } catch (error) {
        await this.slotService.decrementBookingCount(newSlotId);
        throw error;
      }
    }

    const updatePayload: UpdateBookingRequest = {
      slotId: newSlotId,
      bookingDate: nextBookingDate,
      bookingTime: nextBookingTime,
      notes: data.notes ?? booking.notes,
    };

    if (data.serviceMode) {
      updatePayload.serviceMode = data.serviceMode;
    }

    if (data.serviceAddress) {
      updatePayload.serviceAddress = data.serviceAddress;
    }

    if (data.consultationMode) {
      updatePayload.consultationMode = data.consultationMode;
    }

    const updated = await this.bookingRepository.update(
      { _id: bookingId },
      {
        ...updatePayload,
        lifecycle: this.buildLifecyclePatch(booking.lifecycle, {
          rescheduled: true,
        }),
      }
    );

    if (!updated) {
      if (slotChanged) {
        await this.slotService.decrementBookingCount(newSlotId);
        if (oldSlotId) {
          await this.slotService.incrementBookingCount(oldSlotId);
        }
      }

      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to reschedule booking',
      });
    }

    if (updated.status === 'confirmed') {
      await this.bookingReminderScheduler.scheduleBookingReminders(updated);
      return syncBookingMeet({
        booking: updated,
        bookingRepository: this.bookingRepository,
        userRepository: this.userRepository,
        specialistRepository: this.specialistRepository,
        slotRepository: this.slotRepository,
      });
    }

    return updated;
  }

  async retryBookingPayment(
    bookingId: string,
    requester: { _id: string; userType: string; corporateId?: string; pharmacyId?: string },
    options: RetryBookingPaymentRequest = {}
  ): Promise<BookingPaymentInitResponse> {
    const booking = await this.getById(bookingId);

    const canAccess =
      requester.userType === 'admin' ||
      (
        requester.userType === 'pharmacy' &&
        requester.pharmacyId &&
        String(booking.pharmacyId) === String(requester.pharmacyId)
      ) ||
      String(booking.userId) === String(requester._id);

    if (!canAccess) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'You are not allowed to retry payment for this booking',
      });
    }

    if (booking.status === 'cancelled') {
      throw new AppError({
        status: 400,
        code: 'BOOKING_CANCELLED',
        message: 'Cannot retry payment for a cancelled booking',
      });
    }

    if (booking.paymentStatus === 'paid') {
      throw new AppError({
        status: 400,
        code: 'BOOKING_ALREADY_PAID',
        message: 'Booking is already paid',
      });
    }

    let baseAmount = booking.originalPrice ?? booking.price;
    let discountAmount = Math.max(0, (booking.originalPrice ?? booking.price) - booking.price);
    let couponCode = options.couponCode;
    let walletDeductedAmount = 0;

    if (booking.paymentTransactionId) {
      const previousPayment = await this.paymentRepository.findById(
        booking.paymentTransactionId
      );

      if (previousPayment) {
        if (previousPayment.status === 'paid') {
          throw new AppError({
            status: 400,
            code: 'BOOKING_ALREADY_PAID',
            message: 'Booking is already paid',
          });
        }

        baseAmount = previousPayment.baseAmount;
        if (!couponCode) {
          discountAmount = previousPayment.discountAmount;
          couponCode = previousPayment.couponCode;
        }
        walletDeductedAmount = Number(previousPayment.notes?.walletDeductedAmount || 0);
      }
    }

    if (options.couponCode) {
      const bookingCouponType = booking.bookingType === 'package' ? 'package' : 'consultation';
      const couponResult = await this.resolveRetryBookingCoupon({
        booking,
        bookingType: bookingCouponType,
        grossAmount: baseAmount,
        requesterCorporateId:
          requester.userType === 'admin'
            ? booking.corporateId
            : requester.corporateId,
        couponCode: options.couponCode,
      });

      discountAmount = couponResult.discountAmount;
      couponCode = couponResult.couponCode;
    }

    await this.validateWalletIfRequested(
      booking.userId,
      options.useWalletBalance
    );

    const grossAmount = Math.max(0, baseAmount - discountAmount);
    let extraWalletDeductedAmount = 0;
    if (options.useWalletBalance) {
      const walletRoom = Math.max(0, grossAmount - walletDeductedAmount);
      if (walletRoom > 0) {
        extraWalletDeductedAmount = await this.deductWalletForBooking({
          userId: booking.userId,
          bookingId: booking._id!,
          amountToDeductFromWallet: walletRoom,
          useWalletBalance: true,
        });
      }
    }

    const totalWalletDeductedAmount =
      walletDeductedAmount + extraWalletDeductedAmount;
    const payableAfterWallet = Math.max(0, grossAmount - totalWalletDeductedAmount);

    if (payableAfterWallet <= 0) {
      const directPaidTransaction =
        await this.paymentService.createDirectPaidTransaction({
          userId: booking.userId,
          context: 'booking',
          contextId: booking._id!,
          baseAmount,
          discountAmount,
          finalAmount: 0,
          couponCode,
          notes: {
            bookingType: booking.bookingType,
            reason:
              totalWalletDeductedAmount > 0
                ? 'wallet_covered_amount'
                : 'zero_payable_amount',
            retryOfBookingId: booking._id!,
            walletDeductedAmount: totalWalletDeductedAmount,
          },
        });

      const paidBooking = await this.bookingRepository.update(
        { _id: booking._id! },
        {
          paymentStatus: 'paid',
          paymentTransactionId: directPaidTransaction._id!,
          status: booking.status === 'pending' ? 'confirmed' : booking.status,
          lifecycle: this.buildLifecyclePatch(booking.lifecycle, {
            paid: { amount: grossAmount },
            confirmed: booking.status === 'pending' ? true : undefined,
          }),
        }
      );

      if (couponCode) {
        const coupon = await this.couponService.getByCode(couponCode);
        await this.couponService.incrementUsage(coupon._id!);
      }

      const settledBooking = paidBooking || booking;
      if (settledBooking.status === 'confirmed') {
        await this.bookingReminderScheduler.scheduleBookingReminders(
          settledBooking
        );
        const bookingWithMeeting = await syncBookingMeet({
          booking: settledBooking,
          bookingRepository: this.bookingRepository,
          userRepository: this.userRepository,
          specialistRepository: this.specialistRepository,
          slotRepository: this.slotRepository,
        });
        await this.sendPaidBookingEmailNotification(bookingWithMeeting);

        return {
          booking: bookingWithMeeting,
          paymentRequired: false,
          walletDeductedAmount: totalWalletDeductedAmount,
        };
      }

      await this.sendPaidBookingEmailNotification(settledBooking);

      return {
        booking: settledBooking,
        paymentRequired: false,
        walletDeductedAmount: totalWalletDeductedAmount,
      };
    }

    const order = await this.paymentService.createOrder({
      userId: booking.userId,
      context: 'booking',
      contextId: booking._id!,
      baseAmount,
      discountAmount,
      finalAmount: payableAfterWallet,
      couponCode,
      notes: {
        bookingType: booking.bookingType,
        retryOfBookingId: booking._id!,
        walletDeductedAmount: totalWalletDeductedAmount,
      },
    });

    const updatedBooking = await this.bookingRepository.update(
      { _id: booking._id! },
      {
        paymentStatus: 'pending',
        paymentTransactionId: order.paymentRecord._id!,
        lifecycle: this.buildLifecyclePatch(booking.lifecycle, {
          paymentPending: { amount: payableAfterWallet },
        }),
      }
    );

    return {
      booking: updatedBooking || booking,
      paymentRequired: true,
      walletDeductedAmount: totalWalletDeductedAmount,
      payment: {
        paymentTransactionId: order.paymentRecord._id!,
        razorpayOrderId: order.razorpayOrder.id,
        razorpayKeyId: order.razorpayKeyId,
        amount: payableAfterWallet,
        currency: order.razorpayOrder.currency,
        baseAmount,
        discountAmount,
        couponCode,
        walletDeductedAmount: totalWalletDeductedAmount,
      },
    };
  }
}
