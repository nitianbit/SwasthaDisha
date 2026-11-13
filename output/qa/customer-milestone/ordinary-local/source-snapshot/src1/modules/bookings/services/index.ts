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
import { BookingLocalOperations, bookingMoneyPaise } from './localOperations';
import { enforceUserCancellationWindow } from '@/modules/common/utils/cancellationWindow';

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
  private readonly localOperations = new BookingLocalOperations();
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

  private enforceUserCancellationWindow(booking: IBooking, requester: { userType: string }): void {
    enforceUserCancellationWindow([{ bookingDate: booking.bookingDate, bookingTime: booking.bookingTime }], requester.userType);
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
    userId: string; bookingId: string; amountToDeductFromWallet: number;
    useWalletBalance?: boolean; setupToken: string;
  }): Promise<number> {
    if (!params.useWalletBalance || params.amountToDeductFromWallet <= 0) return 0;
    return this.localOperations.debitWallet(params.bookingId, params.userId, params.setupToken, params.amountToDeductFromWallet);
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

    // Coupon percentages are server calculations; normalize once at the new-payment boundary.
    const basePaise = bookingMoneyPaise(params.purchaseAmount);
    const rawDiscount = couponValidation.discountAmount ?? 0;
    const discountPaise = typeof rawDiscount === 'number' && Number.isFinite(rawDiscount) && rawDiscount >= 0
      ? Math.round(rawDiscount * 100) : NaN;
    if (!Number.isSafeInteger(discountPaise) || discountPaise < 0 || discountPaise > basePaise) {
      throw new AppError({ status: 409, code: 'BOOKING_RECONCILIATION_REQUIRED', message: 'Calculated coupon amount is invalid' });
    }
    return {
      discountAmount: discountPaise / 100,
      finalAmount: (basePaise - discountPaise) / 100,
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

  private publicBooking(booking: IBooking): IBooking {
    const { localEffects: _internal, ...visible } = booking;
    return visible;
  }

  private async initializeBookingPayment(
    booking: IBooking, baseAmount: number, discountAmount: number,
    couponCode?: string, useWalletBalance?: boolean
  ): Promise<BookingPaymentInitResponse> {
    const token = booking.localEffects?.setupToken;
    if (!token) throw new AppError({ status: 409, code: 'BOOKING_CHANGED', message: 'Booking setup must be retried' });
    let failed = true;
    let result: BookingPaymentInitResponse;
    try {
      const priorPaise = booking.localEffects!.walletDebitedPaise;
      const grossPaise = bookingMoneyPaise(booking.price);
      if (priorPaise > grossPaise) throw new AppError({ status: 409, code: 'BOOKING_RECONCILIATION_REQUIRED', message: 'Existing wallet funding exceeds this price' });
      const extra = await this.deductWalletForBooking({ userId: booking.userId, bookingId: booking._id!,
        setupToken: token, amountToDeductFromWallet: (grossPaise - priorPaise) / 100, useWalletBalance });
      const walletPaise = priorPaise + bookingMoneyPaise(extra);
      const payable = (grossPaise - walletPaise) / 100;
      const notes = { bookingType: booking.bookingType, walletDeductedAmount: walletPaise / 100 };
      if (payable <= 0) {
        const payment = await this.paymentService.createDirectPaidTransaction({ userId: booking.userId, context: 'booking',
          contextId: booking._id!, baseAmount, discountAmount, finalAmount: 0, couponCode,
          notes: { ...notes, reason: grossPaise === 0 ? 'zero_payable_amount' : 'wallet_covered_amount' } });
        const paid = await this.localOperations.attachPayment(booking._id!, token, payment._id!);
        result = { booking: this.publicBooking(paid), paymentRequired: false, walletDeductedAmount: walletPaise / 100 };
      } else {
        const order = await this.paymentService.createOrder({ userId: booking.userId, context: 'booking',
          contextId: booking._id!, baseAmount, discountAmount, finalAmount: payable, couponCode, notes });
        const pending = await this.localOperations.attachPayment(booking._id!, token, order.paymentRecord._id!);
        result = { booking: this.publicBooking(pending), paymentRequired: true, walletDeductedAmount: walletPaise / 100,
          payment: { paymentTransactionId: order.paymentRecord._id!, razorpayOrderId: order.razorpayOrder.id,
            razorpayKeyId: order.razorpayKeyId, amount: payable, currency: order.razorpayOrder.currency,
            baseAmount, discountAmount, couponCode, walletDeductedAmount: walletPaise / 100 } };
      }
      failed = false;
    } finally {
      // Failed setup leaves known wallet debits/payment rows recoverable and never a permanent token.
      await this.localOperations.endSetup(booking._id!, token, failed);
    }
    try {
      await this.notificationService.createBookingCreatedNotification(booking.userId, booking._id!, {
        bookingType: booking.bookingType, bookingDate: booking.bookingDate, bookingTime: booking.bookingTime,
        price: booking.price, packageName: booking.packageName, specialistName: booking.doctorName,
        consultationMode: booking.consultationMode,
      });
      if (booking.specialistId) await this.notificationService.createSpecialistNewBookingNotification(booking.specialistId, booking._id!, {
        bookingType: booking.bookingType, bookingDate: booking.bookingDate, bookingTime: booking.bookingTime,
        consultationMode: booking.consultationMode, userId: booking.userId,
      });
    } catch (error) { console.error('Failed to create booking notification:', error); }
    if (!result.paymentRequired) {
      await this.bookingReminderScheduler.scheduleBookingReminders(result.booking);
      result.booking = this.publicBooking(await syncBookingMeet({ booking: result.booking, bookingRepository: this.bookingRepository,
        userRepository: this.userRepository, specialistRepository: this.specialistRepository, slotRepository: this.slotRepository }));
      await this.sendPaidBookingEmailNotification(result.booking);
    }
    return result;
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

    const basePrice = wellnessPackage.discountedPrice ?? wellnessPackage.originalPrice;
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
      paymentStatus: 'pending',
      lifecycle: this.buildLifecyclePatch(undefined, {
        created: true,
      }),
      notes: data.notes,
    };

    const savedBooking = await this.localOperations.createDraft(booking);
    return this.initializeBookingPayment(savedBooking, basePrice, discountAmount, couponCode, data.useWalletBalance);
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
      paymentStatus: 'pending',
      lifecycle: this.buildLifecyclePatch(undefined, {
        created: true,
      }),
      notes: data.notes,
    };

    const savedBooking = await this.localOperations.createDraft(booking);
    return this.initializeBookingPayment(savedBooking, basePrice, discountAmount, couponCode, data.useWalletBalance);
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

    const savedBooking = await this.localOperations.createDraft(booking, false);

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
      booking: this.publicBooking(bookingWithMeeting),
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

    return this.publicBooking(booking);
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
      return { data: data.map(booking => this.publicBooking(booking)) };
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

    if (queryParams.bookingDateFrom || queryParams.bookingDateTo) {
      filter.bookingDate = {};
      if (queryParams.bookingDateFrom) filter.bookingDate.$gte = queryParams.bookingDateFrom;
      if (queryParams.bookingDateTo) filter.bookingDate.$lte = queryParams.bookingDateTo;
    }
    const data = await this.bookingRepository.findAll(filter, { sort });

    return { data: data.map(booking => this.publicBooking(booking)) };
  }

  async updateCustomerNotes(
    id: string,
    data: unknown,
    signedOwner: unknown
  ): Promise<IBooking> {
    if (typeof signedOwner !== 'string' || !signedOwner.trim()) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }
    const invalidNotes = () => new AppError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Customer booking updates require notes containing 1 to 2000 characters',
    });
    if (
      !data || typeof data !== 'object' || Array.isArray(data) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(data))
    ) {
      throw invalidNotes();
    }

    const booking = await this.getById(id, signedOwner);
    if (Reflect.ownKeys(data).some(key => key !== 'notes')) {
      throw new AppError({
        status: 422,
        code: 'FORBIDDEN_FIELD',
        message: 'One or more fields cannot be changed through this endpoint',
      });
    }
    const notes = Object.getOwnPropertyDescriptor(data, 'notes')?.value;
    if (typeof notes !== 'string') throw invalidNotes();
    const normalizedNotes = notes.trim();
    if (!normalizedNotes.length || normalizedNotes.length > 2000) throw invalidNotes();

    const eligibleStatuses: IBooking['status'][] = ['pending', 'confirmed'];
    const notEditable = () => new AppError({
      status: 409,
      code: 'CUSTOMER_BOOKING_NOT_EDITABLE',
      message: 'Booking notes cannot be changed in the current state',
    });
    if (!eligibleStatuses.includes(booking.status)) throw notEditable();
    const updated = await this.bookingRepository.update(
      { _id: id, userId: signedOwner, status: { $in: eligibleStatuses } },
      { $set: { notes: normalizedNotes } },
      { new: true, upsert: false }
    );
    if (!updated) throw notEditable();
    return this.publicBooking(updated);
  }

  async update(
    id: string,
    data: UpdateBookingRequest,
    userId?: string
  ): Promise<IBooking> {
    const booking = await this.getById(id, userId);
    if (data.status === 'cancelled' || data.paymentStatus !== undefined || Object.prototype.hasOwnProperty.call(data, 'paymentTransactionId') ||
        data.lifecycle !== undefined || data.followUp !== undefined || data.slotId !== undefined || data.bookingDate !== undefined || data.bookingTime !== undefined) {
      throw new AppError({ status: 409, code: 'DEDICATED_BOOKING_COMMAND_REQUIRED', message: 'Use cancellation, rescheduling or payment commands for this change' });
    }
    if (booking.status === 'cancelled') throw new AppError({ status: 409, code: 'BOOKING_CANCELLED', message: 'Cancelled booking history cannot be rewritten' });


    const lifecyclePatch = this.buildLifecyclePatch(booking.lifecycle, {
      confirmed: data.status === 'confirmed' && booking.status !== 'confirmed' ? true : undefined,
      completed: data.status === 'completed' && booking.status !== 'completed' ? true : undefined,
    });

    if (lifecyclePatch) {
      data.lifecycle = lifecyclePatch;
    }

    const updated = await this.bookingRepository.update({ _id: id, status: booking.status, ...(userId ? { userId: { $eq: userId } } : {}) }, data);

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

    if (
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
    await this.getById(id, userId);
    throw new AppError({ status: 409, code: 'BOOKING_RETENTION_REQUIRED', message: 'Use the cancellation command; booking history must be retained' });
  }

  async getByUserId(userId: string): Promise<IBooking[]> {
    return (await this.bookingRepository.findByUserId(userId)).map(booking => this.publicBooking(booking));
  }

  async getUpcomingBookings(userId?: string): Promise<IBooking[]> {
    return (await this.bookingRepository.findUpcomingBookings(userId)).map(booking => this.publicBooking(booking));
  }

  async cancelBooking(
    bookingId: string, data: { cancellationReason?: string }, requester: { _id: string; userType: string }
  ): Promise<IBooking> {
    const settled = await this.localOperations.cancel(bookingId, requester, data.cancellationReason?.trim() || 'Cancelled by user',
      booking => this.enforceUserCancellationWindow(booking, requester));
    // These idempotent cleanup attempts are outside the financial transaction and retried on the next call.
    try { await this.bookingReminderScheduler.clearBookingReminders(settled._id!); }
    catch (error) { console.error('Cancelled booking reminder cleanup remains pending:', error); }
    try { return this.publicBooking(await cancelBookingMeet({ booking: settled, reason: settled.cancellationReason, bookingRepository: this.bookingRepository })); }
    catch (error) { console.error('Cancelled booking meeting cleanup remains pending:', error); return this.publicBooking(settled); }
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

    const newSlotId = data.slotId;

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

    const updated = await this.localOperations.reschedule(bookingId, requester, updatePayload as unknown as Record<string, unknown>);

    if (updated.status === 'confirmed') {
      await this.bookingReminderScheduler.scheduleBookingReminders(updated);
      return this.publicBooking(await syncBookingMeet({
        booking: updated,
        bookingRepository: this.bookingRepository,
        userRepository: this.userRepository,
        specialistRepository: this.specialistRepository,
        slotRepository: this.slotRepository,
      }));
    }

    return this.publicBooking(updated);
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
    let discountAmount = Math.max(0, baseAmount - booking.price);
    let couponCode = options.couponCode;
    if (booking.paymentTransactionId) {
      const previous = await this.paymentRepository.findById(booking.paymentTransactionId);
      if (previous) {
        if (previous.status === 'paid' || previous.status === 'refunded') throw new AppError({ status: 409, code: 'BOOKING_RECONCILIATION_REQUIRED', message: 'Previous payment must be reconciled before retry' });
        baseAmount = previous.baseAmount;
        if (!couponCode) { discountAmount = previous.discountAmount; couponCode = previous.couponCode; }
      }
    }
    if (options.couponCode) {
      const coupon = await this.resolveRetryBookingCoupon({ booking,
        bookingType: booking.bookingType === 'package' ? 'package' : 'consultation', grossAmount: baseAmount,
        requesterCorporateId: requester.userType === 'admin' ? booking.corporateId : requester.corporateId,
        couponCode: options.couponCode });
      discountAmount = coupon.discountAmount; couponCode = coupon.couponCode;
    }
    const setup = await this.localOperations.beginSetup(bookingId, { _id: requester._id, userType: requester.userType, pharmacyId: requester.pharmacyId });
    setup.price = (bookingMoneyPaise(baseAmount) - bookingMoneyPaise(discountAmount)) / 100;
    return this.initializeBookingPayment(setup, baseAmount, discountAmount, couponCode, options.useWalletBalance);
  }

}
