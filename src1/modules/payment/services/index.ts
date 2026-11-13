import crypto from 'crypto';
import { advanceRefillOnPayment } from '@/modules/pharmacySubscriptions/refillCycle';
import BookingModel from '@/modules/bookings/model';
import { recordGatewayCapture, refundAndClose } from '@/modules/common/utils/bookingWalletFunding';
import ExternalBookingModel from '@/modules/externalBookings/model';
import { ClientSession, startSession } from 'mongoose';
import Razorpay from 'razorpay';
import { Service } from 'typedi';
import { CONFIG } from '@/config/config';
import { AppError } from '@/modules/common/types';
import { PaymentRepository } from '@/modules/payment/repository';
import { BookingRepository } from '@/modules/bookings/repository';
import { ExternalBookingRepository } from '@/modules/externalBookings/repository';
import { LabstackService } from '@/modules/bookings/services/labstack';
import { HealthiansService } from '@/modules/bookings/services/healthians';
import { completeExternalBookingAfterPayment } from '@/modules/externalBookings/services/externalBookingPaymentFinalize';
import {
  WalletRepository,
  WalletTransactionRepository,
} from '@/modules/wallet/repository';
import {
  PharmacyWalletRepository,
  PharmacyWalletTransactionRepository,
} from '@/modules/pharmacyWallet/repository';
import { CouponService } from '@/modules/coupon/services';
import { getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import { BookingReminderScheduler } from '@/modules/bookings/services/bookingReminderScheduler';
import logger from '@/services/logger';
import { UserRepository } from '@/modules/user/repository';
import { EmailService } from '@/modules/email/services';
import { IBooking } from '@/modules/bookings/types';
import { IExternalBooking } from '@/modules/externalBookings/types';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { IPharmacyOrder } from '@/modules/pharmacyOrders/types';
import { assertPrescriptionCommerceAvailable } from '@/modules/pharmacyOrders/prescriptionCommerce';
import { MedicineRepository } from '@/modules/pharmacyMedicines/repository';
import { InventoryService } from '@/modules/pharmacyInventory/services';
import { PharmacyOrderSideEffectService } from '@/modules/pharmacyOrders/services/sideEffects';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { SlotRepository } from '@/modules/slots/repository';
import {
  buildPaidBookingEmailContent,
  syncBookingMeet,
} from '@/modules/meet/service';
import {
  buildExternalBookingEmailContent,
  ExternalBookingEmailTemplate,
} from '@/modules/externalBookings/emailTemplates';
import { buildBookingLifecyclePatch } from '@/modules/bookings/utils/lifecycle';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import {
  CreatePaymentOrderRequest,
  CreateDirectPaidTransactionRequest,
  IPaymentRecord,
  VerifyPaymentRequest,
} from '@/modules/payment/types';

interface RazorpayOrderResponse {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

interface RazorpayPaymentDetails {
  id: string;
  order_id?: string;
  amount: number;
  currency: string;
  status: string;
}

const PHARMACY_ORDER_PAYMENT_WINDOW_MS = 30 * 60 * 1000;
const PHARMACY_ORDER_PAYMENT_TIMEOUT_NOTE =
  'Payment window expired after 30 minutes. Please create a new order.';
const PHARMACY_ORDER_LATE_REFUND_NOTE =
  'Late payment was refunded to wallet because the 30-minute payment window expired.';

@Service()
export class PaymentService {
  private razorpayClient?: Razorpay;

  constructor(
    private paymentRepository: PaymentRepository,
    private bookingRepository: BookingRepository,
    private walletRepository: WalletRepository,
    private walletTransactionRepository: WalletTransactionRepository,
    private couponService: CouponService,
    private bookingReminderScheduler: BookingReminderScheduler,
    private externalBookingRepository: ExternalBookingRepository,
    private labstackService: LabstackService,
    private healthiansService: HealthiansService,
    private pharmacyOrderRepository: PharmacyOrderRepository,
    private inventoryService: InventoryService,
    private pharmacyOrderSideEffectService: PharmacyOrderSideEffectService,
    private specialistRepository: SpecialistRepository,
    private slotRepository: SlotRepository,
    private userRepository: UserRepository,
    private emailService: EmailService,
    private pharmacyWalletRepository: PharmacyWalletRepository,
    private pharmacyWalletTransactionRepository: PharmacyWalletTransactionRepository,
    private medicineRepository: MedicineRepository
  ) {}

  private async runPharmacyPaymentCoreTransaction<T>(
    work: (session: ClientSession) => Promise<T>
  ): Promise<T> {
    const session = await startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(async () => {
        result = await work(session);
      });

      if (result === undefined) {
        throw new AppError({
          status: 500,
          code: 'PHARMACY_PAYMENT_TRANSACTION_FAILED',
          message: 'Failed to complete pharmacy payment processing',
        });
      }

      return result;
    } finally {
      await session.endSession();
    }
  }

  private async incrementCouponUsageAfterProcessing(paymentRecord: IPaymentRecord): Promise<void> {
    if (!paymentRecord.couponCode) {
      return;
    }

    const coupon = await this.couponService.getByCode(paymentRecord.couponCode);
    await this.couponService.incrementUsage(coupon._id!);
  }

  private appendOrderNote(existingNotes: string | undefined, note: string): string {
    const normalized = existingNotes?.trim();
    if (!normalized) {
      return note;
    }

    if (normalized.includes(note)) {
      return normalized;
    }

    return `${normalized}\n${note}`;
  }

  private isPharmacyOrderPaymentWindowExpired(order: IPharmacyOrder): boolean {
    // Refill orders wait for the customer's payment until their own deadline (P7).
    if (order.refill?.paymentDueBy) {
      return Date.now() > new Date(order.refill.paymentDueBy).getTime();
    }
    if (!order.createdAt) {
      return false;
    }

    const createdAtMs = new Date(order.createdAt).getTime();
    if (Number.isNaN(createdAtMs)) {
      return false;
    }

    return Date.now() - createdAtMs > PHARMACY_ORDER_PAYMENT_WINDOW_MS;
  }

  private async queuePharmacyOrderSubscriptionSyncSafely(
    orderId: string,
    trigger: 'payment_completed' | 'order_abandoned'
  ): Promise<void> {
    try {
      await this.pharmacyOrderSideEffectService.queueSubscriptionSync(orderId, trigger);
    } catch (error) {
      logger.error('Failed to queue pharmacy order subscription sync after payment flow', {
        orderId,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async queuePharmacyOrderNotificationSafely(
    orderId: string,
    trigger: 'payment_completed' | 'order_abandoned'
  ): Promise<void> {
    try {
      await this.pharmacyOrderSideEffectService.queueNotification(orderId, trigger);
    } catch (error) {
      logger.error('Failed to queue pharmacy order notification after payment flow', {
        orderId,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleTimedOutPharmacyOrderPayment(
    order: IPharmacyOrder,
    paymentRecord: IPaymentRecord
  ): Promise<{
    paymentRecord: IPaymentRecord;
    entity: unknown;
  }> {
    const batchInventoryItems = order.items
      .filter((item) => item.itemStatus === 'active' && item.batchAllocations?.length)
      .map((item) => ({
        medicineId: String(item.medicineId),
        batchAllocations: item.batchAllocations,
      }));
    const legacyInventoryItems = order.items
      .filter((item) => item.itemStatus === 'active' && !item.batchAllocations?.length)
      .map((item) => ({ medicineId: String(item.medicineId), quantity: item.orderedQty }));

    const refundAmount = await this.refundAbandonedPharmacyOrderToWallet(order, paymentRecord, {
      skipPaymentStateUpdate: true,
    });

    const { updatedOrder, updatedPayment } = await this.runPharmacyPaymentCoreTransaction(
      async (session) => {
        const inventoryWasAlreadyReleased = ['abandoned', 'cancelled', 'rejected'].includes(order.status);
        const nextOrder =
          inventoryWasAlreadyReleased
            ? ((await this.pharmacyOrderRepository.findById(String(order._id), session)) as IPharmacyOrder | null) ||
              order
            : ((await this.pharmacyOrderRepository.update(
                { _id: order._id },
                {
                  status: 'abandoned',
                  paymentTransactionId: paymentRecord._id!,
                  notes: this.appendOrderNote(order.notes, PHARMACY_ORDER_PAYMENT_TIMEOUT_NOTE),
                },
                { new: true, session }
              )) as IPharmacyOrder | null);

        if (!nextOrder) {
          throw new AppError({
            status: 500,
            code: 'PHARMACY_ORDER_UPDATE_FAILED',
            message: 'Failed to abandon pharmacy order after payment timeout',
          });
        }

        if (!inventoryWasAlreadyReleased && batchInventoryItems.length) {
          // Allocations as written in this transaction (a staff batch swap may have changed them since `order` was read).
          await this.inventoryService.releaseOrderStockBulk(
            String(nextOrder.pharmacyId),
            nextOrder.items
              .filter((item) => item.itemStatus === 'active' && item.batchAllocations?.length)
              .map((item) => ({ medicineId: String(item.medicineId), batchAllocations: item.batchAllocations })),
            session
          );
        }
        if (!inventoryWasAlreadyReleased && legacyInventoryItems.length) {
          await this.inventoryService.returnStockBulk(
            String(nextOrder.pharmacyId),
            legacyInventoryItems,
            session
          );
        }

        const orderAfterRefund =
          ((await this.pharmacyOrderRepository.update(
            { _id: nextOrder._id },
            {
              paymentStatus: refundAmount > 0 ? 'refunded' : nextOrder.paymentStatus,
              paymentTransactionId: paymentRecord._id!,
              notes: this.appendOrderNote(nextOrder.notes, PHARMACY_ORDER_LATE_REFUND_NOTE),
            },
            { new: true, session }
          )) as IPharmacyOrder | null) || nextOrder;

        const paymentAfterRefund =
          ((await this.paymentRepository.update(
            { _id: paymentRecord._id! },
            { status: 'refunded', isProcessed: true },
            { new: true, session }
          )) as IPaymentRecord | null) || paymentRecord;

        return {
          updatedOrder: orderAfterRefund,
          updatedPayment: paymentAfterRefund,
        };
      }
    );

    await this.queuePharmacyOrderSubscriptionSyncSafely(String(updatedOrder._id), 'order_abandoned');
    if (updatedOrder.customerId) {
      await this.queuePharmacyOrderNotificationSafely(String(updatedOrder._id), 'order_abandoned');
    }

    return {
      paymentRecord: updatedPayment,
      entity: updatedOrder,
    };
  }

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
      logger.error('Failed to send paid booking email notification', {
        bookingId: booking._id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sendExternalBookingEmailNotification(
    booking: IExternalBooking,
    template: ExternalBookingEmailTemplate
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
        userName: booking.patientName || user?.name,
      });

      await this.emailService.sendEmail({
        to: Array.from(recipients),
        subject: content.subject,
        textBody: content.textBody,
        htmlBody: content.htmlBody,
      });
    } catch (error) {
      logger.error('Failed to send external booking lifecycle email', {
        bookingId: booking._id,
        template,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildLifecyclePatch(
    current: IBooking['lifecycle'],
    updates: Parameters<typeof buildBookingLifecyclePatch>[1]
  ) {
    return buildBookingLifecyclePatch(current, updates);
  }

  private getRazorpayCredentials(): { keyId: string; keySecret: string } {
    if (!CONFIG.RAZORPAY_KEY_ID || !CONFIG.RAZORPAY_KEY_SECRET) {
      throw new AppError({
        status: 500,
        code: 'RAZORPAY_NOT_CONFIGURED',
        message: 'Razorpay credentials are not configured',
      });
    }

    return {
      keyId: CONFIG.RAZORPAY_KEY_ID,
      keySecret: CONFIG.RAZORPAY_KEY_SECRET,
    };
  }

  private getRazorpayClient(): Razorpay {
    if (this.razorpayClient) {
      return this.razorpayClient;
    }

    const { keyId, keySecret } = this.getRazorpayCredentials();
    this.razorpayClient = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });

    return this.razorpayClient;
  }

  private buildRazorpayReceipt(data: CreatePaymentOrderRequest): string {
    const contextCode =
      data.context === 'wallet_recharge'
        ? 'wr'
        : data.context === 'external_booking'
          ? 'eb'
          : data.context === 'pharmacy_order'
            ? 'po'
          : 'bk';
    const contextId = String(data.contextId || '');
    const userId = String(data.userId || '');
    const contextIdSuffix =
      contextId.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'ctx';
    const userIdSuffix =
      userId.replace(/[^a-zA-Z0-9]/g, '').slice(-6) || 'usr';
    const timeCode = Date.now().toString(36);
    const rawReceipt = `ewa_${contextCode}_${contextIdSuffix}_${userIdSuffix}_${timeCode}`;

    return rawReceipt.length <= 40 ? rawReceipt : rawReceipt.slice(0, 40);
  }

  private getPaymentPayerUserId(data: { payerUserId?: string; userId: string }): string {
    return data.payerUserId || data.userId;
  }

  private async assertNewPharmacyPaymentAllowed(
    data: Pick<CreatePaymentOrderRequest, 'context' | 'contextId'>
  ): Promise<void> {
    if (data.context !== 'pharmacy_order') return;
    const order = typeof data.contextId === 'string' && /^[0-9a-fA-F]{24}$/.test(data.contextId)
      ? await this.pharmacyOrderRepository.findById(data.contextId)
      : null;
    await assertPrescriptionCommerceAvailable({
      kind: 'stored_order',
      order,
      expectedOrderId: data.contextId,
      readMedicines: ids => this.medicineRepository.findAll(
        { _id: { $in: ids } },
        { select: '_id prescriptionRequired isActive archivedAt' }
      ),
    });
  }

  async createOrder(data: CreatePaymentOrderRequest): Promise<{
    paymentRecord: IPaymentRecord;
    razorpayOrder: {
      id: string;
      amount: number;
      currency: string;
      status: string;
    };
    razorpayKeyId: string;
  }> {
    if (data.finalAmount < 0) {
      throw new AppError({
        status: 400,
        code: 'INVALID_PAYMENT_AMOUNT',
        message: 'Final payment amount cannot be negative',
      });
    }

    const currency = (data.currency || 'INR').toUpperCase();
    const amountInPaise = Math.round(data.finalAmount * 100);

    if (amountInPaise <= 0) {
      throw new AppError({
        status: 400,
        code: 'INVALID_PAYMENT_AMOUNT',
        message: 'Payment amount must be greater than zero',
      });
    }

    await this.assertNewPharmacyPaymentAllowed(data);

    const { keyId } = this.getRazorpayCredentials();
    const razorpayClient = this.getRazorpayClient();

    const orderPayload = {
      amount: amountInPaise,
      currency,
      receipt: this.buildRazorpayReceipt(data),
      notes: {
        context: data.context,
        contextId: data.contextId.toString(),
        userId: data.userId,
      },
    };

    let razorpayOrder: RazorpayOrderResponse;
    try {
      const order = await razorpayClient.orders.create(orderPayload);
      razorpayOrder = {
        id: order.id,
        amount: Number(order.amount),
        currency: order.currency,
        status: order.status,
      };
    } catch (error: any) {
      throw new AppError({
        status: 502,
        code: 'RAZORPAY_ORDER_CREATION_FAILED',
        message:
          error?.error?.description ||
          error?.description ||
          'Failed to create Razorpay order',
      });
    }

    const paymentRecord = await this.paymentRepository.save({
      userId: data.userId,
      payerUserId: this.getPaymentPayerUserId(data),
      payerPharmacyId: data.payerPharmacyId,
      context: data.context,
      contextId: data.contextId,
      baseAmount: data.baseAmount,
      discountAmount: data.discountAmount || 0,
      finalAmount: data.finalAmount,
      baseAmountPaise: Math.round(data.baseAmount * 100),
      discountAmountPaise: Math.round((data.discountAmount || 0) * 100),
      finalAmountPaise: amountInPaise,
      currency,
      paymentGateway: 'razorpay',
      couponCode: data.couponCode,
      razorpayOrderId: razorpayOrder.id,
      status: 'created',
      isProcessed: false,
      notes: data.notes,
    });

    return {
      paymentRecord,
      razorpayOrder: {
        id: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        status: razorpayOrder.status,
      },
      razorpayKeyId: keyId,
    };
  }

  async createDirectPaidTransaction(
    data: CreateDirectPaidTransactionRequest
  ): Promise<IPaymentRecord> {
    await this.assertNewPharmacyPaymentAllowed(data);
    const currency = (data.currency || 'INR').toUpperCase();
    const baseAmountPaise = Math.round(data.baseAmount * 100);
    const discountAmountPaise = Math.round((data.discountAmount || 0) * 100);
    const finalAmountPaise = Math.round(data.finalAmount * 100);

    return this.paymentRepository.save({
      userId: data.userId,
      payerUserId: this.getPaymentPayerUserId(data),
      payerPharmacyId: data.payerPharmacyId,
      context: data.context,
      contextId: data.contextId,
      baseAmount: data.baseAmount,
      discountAmount: data.discountAmount || 0,
      finalAmount: data.finalAmount,
      baseAmountPaise,
      discountAmountPaise,
      finalAmountPaise,
      currency,
      paymentGateway: 'internal',
      couponCode: data.couponCode,
      status: 'paid',
      isProcessed: data.isProcessed ?? true,
      paidAt: new Date(),
      notes: data.notes,
    });
  }

  private async getPaymentRecordForVerification(
    data: VerifyPaymentRequest
  ): Promise<IPaymentRecord> {
    const paymentRecord = await this.paymentRepository.findById(
      data.paymentTransactionId
    );

    if (!paymentRecord) {
      throw new AppError({
        status: 404,
        code: 'PAYMENT_RECORD_NOT_FOUND',
        message: 'Payment record not found',
      });
    }

    const belongsToRequester =
      (paymentRecord.payerUserId || paymentRecord.userId) === data.userId;
    let pharmacyCanVerify = false;

    if (
      !belongsToRequester &&
      data.requesterUserType === 'pharmacy' &&
      data.requesterPharmacyId &&
      (paymentRecord.context === 'booking' || paymentRecord.context === 'pharmacy_order')
    ) {
      if (paymentRecord.context === 'booking') {
        const booking = await this.bookingRepository.findById(paymentRecord.contextId);
        pharmacyCanVerify =
          !!booking &&
          String(booking.pharmacyId) === String(data.requesterPharmacyId);
      } else {
        const order = await this.pharmacyOrderRepository.findById(paymentRecord.contextId);
        pharmacyCanVerify =
          !!order &&
          String(order.pharmacyId) === String(data.requesterPharmacyId);
      }
    }

    if (!belongsToRequester && !pharmacyCanVerify) {
      throw new AppError({
        status: 404,
        code: 'PAYMENT_RECORD_NOT_FOUND',
        message: 'Payment record not found',
      });
    }

    if (paymentRecord.razorpayOrderId !== data.razorpayOrderId) {
      throw new AppError({
        status: 400,
        code: 'PAYMENT_ORDER_MISMATCH',
        message: 'Razorpay order ID does not match',
      });
    }

    return paymentRecord;
  }

  private handleExistingRecordStatus(paymentRecord: IPaymentRecord): void {
    if (paymentRecord.status === 'paid') {
      return;
    }

    if (paymentRecord.status === 'failed') {
      throw new AppError({
        status: 400,
        code: 'PAYMENT_FAILED',
        message: 'Payment is already marked as failed',
      });
    }

    if (paymentRecord.status === 'refunded') {
      throw new AppError({
        status: 400,
        code: 'PAYMENT_REFUNDED',
        message: 'Payment is already marked as refunded',
      });
    }
  }

  private async validateSignature(
    data: VerifyPaymentRequest,
    paymentRecord: IPaymentRecord
  ): Promise<void> {
    const { keySecret } = this.getRazorpayCredentials();

    const generatedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(`${data.razorpayOrderId}|${data.razorpayPaymentId}`)
      .digest('hex');

    if (generatedSignature !== data.razorpaySignature) {
      await this.paymentRepository.update(
        // A settled (paid/refunded) record is never rewritten by a later bad or replayed verify (milestone E10).
        { _id: paymentRecord._id, status: { $nin: ['paid', 'refunded'] } },
        {
          status: 'failed',
          razorpayPaymentId: data.razorpayPaymentId,
          razorpaySignature: data.razorpaySignature,
        }
      );

      throw new AppError({
        status: 400,
        code: 'PAYMENT_SIGNATURE_INVALID',
        message: 'Invalid Razorpay payment signature',
      });
    }
  }

  private async fetchRazorpayPayment(
    razorpayPaymentId: string
  ): Promise<RazorpayPaymentDetails> {
    const razorpayClient = this.getRazorpayClient();

    try {
      const payment = await razorpayClient.payments.fetch(razorpayPaymentId);
      return {
        id: payment.id,
        order_id: payment.order_id,
        amount: Number(payment.amount),
        currency: payment.currency,
        status: payment.status,
      };
    } catch (error: any) {
      throw new AppError({
        status: 502,
        code: 'RAZORPAY_PAYMENT_FETCH_FAILED',
        message:
          error?.error?.description ||
          error?.description ||
          'Failed to verify payment with Razorpay',
      });
    }
  }

  private validateRazorpayPaymentForRecord(
    paymentRecord: IPaymentRecord,
    data: VerifyPaymentRequest,
    razorpayPayment: RazorpayPaymentDetails
  ): void {
    if (razorpayPayment.order_id !== data.razorpayOrderId) {
      throw new AppError({
        status: 400,
        code: 'PAYMENT_ORDER_MISMATCH',
        message: 'Razorpay payment does not belong to the provided order',
      });
    }

    const expectedAmountInPaise =
      paymentRecord.finalAmountPaise ?? Math.round(paymentRecord.finalAmount * 100);
    if (razorpayPayment.amount !== expectedAmountInPaise) {
      throw new AppError({
        status: 400,
        code: 'PAYMENT_AMOUNT_MISMATCH',
        message: 'Razorpay payment amount does not match expected amount',
      });
    }

    if (
      razorpayPayment.currency.toUpperCase() !==
      paymentRecord.currency.toUpperCase()
    ) {
      throw new AppError({
        status: 400,
        code: 'PAYMENT_CURRENCY_MISMATCH',
        message: 'Razorpay payment currency does not match expected currency',
      });
    }
  }

  private async handleGatewayTerminalStatus(
    paymentRecord: IPaymentRecord,
    data: VerifyPaymentRequest,
    razorpayPayment: RazorpayPaymentDetails
  ): Promise<void> {
    if (razorpayPayment.status === 'failed') {
      await this.paymentRepository.update(
        { _id: paymentRecord._id, status: { $nin: ['paid', 'refunded'] } },
        {
          status: 'failed',
          isProcessed: true,
          razorpayPaymentId: data.razorpayPaymentId,
          razorpaySignature: data.razorpaySignature,
        }
      );

      throw new AppError({
        status: 400,
        code: 'PAYMENT_FAILED',
        message: 'Razorpay payment failed',
      });
    }

    if (razorpayPayment.status === 'refunded') {
      await this.paymentRepository.update(
        { _id: paymentRecord._id, status: { $nin: ['paid', 'refunded'] } },
        {
          status: 'refunded',
          isProcessed: true,
          razorpayPaymentId: data.razorpayPaymentId,
          razorpaySignature: data.razorpaySignature,
        }
      );

      throw new AppError({
        status: 400,
        code: 'PAYMENT_REFUNDED',
        message: 'Razorpay payment is already refunded',
      });
    }

    if (razorpayPayment.status !== 'captured') {
      throw new AppError({
        status: 400,
        code: 'PAYMENT_NOT_COMPLETED',
        message: `Razorpay payment is not completed. Current status: ${razorpayPayment.status}`,
      });
    }
  }

  private async markPaymentAsPaid(
    paymentRecord: IPaymentRecord,
    data: VerifyPaymentRequest
  ): Promise<IPaymentRecord> {
    const updated = await this.paymentRepository.update(
      { _id: paymentRecord._id, status: { $nin: ['paid', 'refunded'] } },
      {
        status: 'paid',
        razorpayPaymentId: data.razorpayPaymentId,
        razorpaySignature: data.razorpaySignature,
        paidAt: new Date(),
      }
    );

    if (!updated) {
      // Already paid (concurrent verify): that is the answer. Refunded (e.g. a returned capture): never revived.
      const current = await this.paymentRepository.findById(paymentRecord._id!);
      if (current?.status === 'paid') return current;
      throw new AppError({ status: 409, code: 'PAYMENT_CHANGED', message: 'Payment changed; refresh before retrying' });
    }

    return updated;
  }

  async verifyAndMarkPaid(data: VerifyPaymentRequest): Promise<IPaymentRecord> {
    const paymentRecord = await this.getPaymentRecordForVerification(data);

    if (paymentRecord.status === 'paid') {
      return paymentRecord;
    }

    this.handleExistingRecordStatus(paymentRecord);
    await this.validateSignature(data, paymentRecord);

    const razorpayPayment = await this.fetchRazorpayPayment(
      data.razorpayPaymentId
    );
    this.validateRazorpayPaymentForRecord(paymentRecord, data, razorpayPayment);
    await this.handleGatewayTerminalStatus(paymentRecord, data, razorpayPayment);

    return this.markPaymentAsPaid(paymentRecord, data);
  }

  async markAsProcessed(paymentRecordId: string): Promise<void> {
    await this.paymentRepository.update(
      { _id: paymentRecordId },
      { isProcessed: true }
    );
  }

  async markAsProcessedIfNotProcessed(paymentRecordId: string): Promise<boolean> {
    const updated = await this.paymentRepository.update(
      { _id: paymentRecordId, isProcessed: false },
      { isProcessed: true }
    );
    return !!updated;
  }

  private async finalizePaymentProcessing(
    paymentRecord: IPaymentRecord
  ): Promise<IPaymentRecord> {
    const finalized = await this.markAsProcessedIfNotProcessed(paymentRecord._id!);
    if (finalized && paymentRecord.couponCode) {
      const coupon = await this.couponService.getByCode(paymentRecord.couponCode);
      await this.couponService.incrementUsage(coupon._id!);
    }

    const processedPayment = await this.paymentRepository.findById(paymentRecord._id!);
    return processedPayment || paymentRecord;
  }

  private shouldFulfillExternalBooking(
    paymentRecord: IPaymentRecord,
    module?: string
  ): boolean {
    if (paymentRecord.context === 'wallet_recharge') {
      return false;
    }
    if (paymentRecord.context === 'external_booking') {
      return true;
    }
    return module === 'external-bookings';
  }

  private async buildAlreadyProcessedResponse(
    paymentRecord: IPaymentRecord,
    module?: string
  ): Promise<{
    context: 'booking' | 'wallet_recharge' | 'external_booking' | 'pharmacy_order';
    paymentRecord: IPaymentRecord;
    entity: unknown;
  }> {
    if (this.shouldFulfillExternalBooking(paymentRecord, module)) {
      const external = await this.externalBookingRepository.findById(
        paymentRecord.contextId
      );
      return {
        context: 'external_booking',
        paymentRecord,
        entity: external || {},
      };
    }

    if (paymentRecord.context === 'booking') {
      const booking = await this.bookingRepository.findById(paymentRecord.contextId);
      return {
        context: 'booking',
        paymentRecord,
        entity: booking || {},
      };
    }

    if (paymentRecord.context === 'pharmacy_order') {
      const order = await this.pharmacyOrderRepository.findById(paymentRecord.contextId);
      return {
        context: 'pharmacy_order',
        paymentRecord,
        entity: order || {},
      };
    }

    if (this.isPharmacyWalletRecharge(paymentRecord)) {
      const wallet = await this.pharmacyWalletRepository.findByPharmacy(
        paymentRecord.payerPharmacyId!
      );
      return {
        context: 'wallet_recharge',
        paymentRecord,
        entity: wallet || {},
      };
    }

    const wallet = await this.walletRepository.findByUserId(paymentRecord.userId);
    return {
      context: 'wallet_recharge',
      paymentRecord,
      entity: wallet || {},
    };
  }

  private async processBookingPayment(
    paymentRecord: IPaymentRecord
  ): Promise<{
    paymentRecord: IPaymentRecord;
    entity: unknown;
  }> {
    const booking = await this.bookingRepository.findById(paymentRecord.contextId);

    if (!booking || booking.userId !== paymentRecord.userId) {
      throw new AppError({
        status: 404,
        code: 'BOOKING_NOT_FOUND',
        message: 'Booking not found for this payment',
      });
    }

    // Apply this captured payment to the booking exactly once, or return it to the wallet if the booking is
    // cancelled/closed or already paid by another payment. Same transaction as the booking money ledger, so it cannot
    // race a cancellation refund or an excess return into paying twice (bookingWalletFunding.ts).
    const thisRecord = String(paymentRecord._id);
    const capture = await recordGatewayCapture({
      model: BookingModel, kind: 'booking', bookingId: String(booking._id), userId: booking.userId, recordId: thisRecord,
      amount: Number(paymentRecord.finalAmount || 0),
      gross: Math.max(0, Number(paymentRecord.baseAmount || 0) - Number(paymentRecord.discountAmount || 0)),
      legacyFunded: Number(paymentRecord.notes?.walletDeductedAmount || 0),
      applicable: (b) => b.status !== 'cancelled' && !['paid', 'refunded'].includes(String(b.paymentStatus))
        || (b.paymentStatus === 'paid' && String(b.paymentTransactionId) === thisRecord),
      applyPatch: {
        paymentStatus: 'paid',
        paymentTransactionId: thisRecord,
        status: booking.status === 'pending' ? 'confirmed' : booking.status,
        lifecycle: this.buildLifecyclePatch(booking.lifecycle, {
          paid: { amount: Number(paymentRecord.finalAmount || booking.price || 0) },
          confirmed: booking.status === 'pending' ? true : undefined,
        }),
      },
      wallets: this.walletRepository,
    });
    const updatedBooking = await this.bookingRepository.findById(paymentRecord.contextId);
    if (capture.state === 'returned') {
      const refunded = (await this.paymentRepository.update({ _id: paymentRecord._id! }, { status: 'refunded', isProcessed: true })) || paymentRecord;
      return { paymentRecord: refunded as IPaymentRecord, entity: updatedBooking || booking };
    }
    if (!updatedBooking) {
      return { paymentRecord: await this.finalizePaymentProcessing(paymentRecord), entity: booking };
    }
    // Money is applied exactly once above; the follow-up work below is resumed on replay until it has completed
    // (a crash after the capture must not leave a paid consultation without reminders/meeting/email).
    if ((updatedBooking as IBooking & { postPaymentCompletedFor?: string }).postPaymentCompletedFor === thisRecord) {
      return { paymentRecord: await this.finalizePaymentProcessing(paymentRecord), entity: updatedBooking };
    }

    let bookingForResponse = updatedBooking;
    if (updatedBooking.status === 'confirmed') {
      await this.bookingReminderScheduler.scheduleBookingReminders(updatedBooking);
      bookingForResponse = await syncBookingMeet({
        booking: updatedBooking,
        bookingRepository: this.bookingRepository,
        userRepository: this.userRepository,
        specialistRepository: this.specialistRepository,
        slotRepository: this.slotRepository,
      });
    }

    await this.sendPaidBookingEmailNotification(bookingForResponse as IBooking);
    await this.bookingRepository.update({ _id: updatedBooking._id }, { $set: { postPaymentCompletedFor: thisRecord } } as never);

    const finalizedPayment = await this.finalizePaymentProcessing(paymentRecord);
    return {
      paymentRecord: finalizedPayment,
      entity: bookingForResponse,
    };
  }

  private async processPharmacyOrderPayment(
    paymentRecord: IPaymentRecord
  ): Promise<{
    paymentRecord: IPaymentRecord;
    entity: unknown;
  }> {
    let order = await this.pharmacyOrderRepository.findById(paymentRecord.contextId);

    if (!order) {
      throw new AppError({
        status: 404,
        code: 'PHARMACY_ORDER_NOT_FOUND',
        message: 'Pharmacy order not found for this payment',
      });
    }

    if (['abandoned', 'cancelled', 'rejected'].includes(order.status)) {
      return this.handleTimedOutPharmacyOrderPayment(order as IPharmacyOrder, paymentRecord);
    }

    if (
      order.paymentMode === 'online_payment' &&
      order.paymentStatus === 'pending' &&
      this.isPharmacyOrderPaymentWindowExpired(order as IPharmacyOrder)
    ) {
      return this.handleTimedOutPharmacyOrderPayment(order as IPharmacyOrder, paymentRecord);
    }

    if (order.paymentMode === 'online_payment' && order.paymentStatus === 'pending') {
      const claimedOrder = await this.pharmacyOrderRepository.update(
        { _id: order._id, status: 'placed', paymentStatus: 'pending' },
        {
          paymentStatus: 'authorized',
          paymentTransactionId: paymentRecord._id!,
        }
      );

      if (claimedOrder) {
        order = claimedOrder;
      } else {
        const latestOrder = await this.pharmacyOrderRepository.findById(paymentRecord.contextId);
        if (!latestOrder) {
          throw new AppError({
            status: 404,
            code: 'PHARMACY_ORDER_NOT_FOUND',
            message: 'Pharmacy order not found for this payment',
          });
        }
        order = latestOrder;
        if (['abandoned', 'cancelled', 'rejected'].includes(order.status)) {
          return this.handleTimedOutPharmacyOrderPayment(order as IPharmacyOrder, paymentRecord);
        }

        if (
          order.paymentMode === 'online_payment' &&
          order.paymentStatus === 'pending' &&
          this.isPharmacyOrderPaymentWindowExpired(order as IPharmacyOrder)
        ) {
          return this.handleTimedOutPharmacyOrderPayment(order as IPharmacyOrder, paymentRecord);
        }
      }
    }

    // Re-read after the authorization claim. A cancellation racing with the
    // gateway callback must be refunded, never revived as a paid order.
    const latestBeforePaymentCommit = await this.pharmacyOrderRepository.findById(
      paymentRecord.contextId
    );
    if (
      latestBeforePaymentCommit &&
      ['abandoned', 'cancelled', 'rejected'].includes(latestBeforePaymentCommit.status)
    ) {
      return this.handleTimedOutPharmacyOrderPayment(
        latestBeforePaymentCommit as IPharmacyOrder,
        paymentRecord
      );
    }
    if (latestBeforePaymentCommit) order = latestBeforePaymentCommit;

    const { updatedOrder, updatedPayment, paymentProcessingClaimed } =
      await this.runPharmacyPaymentCoreTransaction(async (session) => {
        const nextOrder = await this.pharmacyOrderRepository.update(
          {
            _id: order._id,
            status: { $nin: ['abandoned', 'cancelled', 'rejected', 'completed'] },
            paymentStatus: { $in: ['pending', 'authorized'] },
          },
          {
            status: order.status === 'placed' ? 'accepted' : order.status,
            paymentStatus: 'paid',
            paymentTransactionId: paymentRecord._id!,
          },
          { new: true, session }
        );

        if (!nextOrder) {
          throw new AppError({
            status: 500,
            code: 'PHARMACY_ORDER_UPDATE_FAILED',
            message: 'Failed to update pharmacy order payment status',
          });
        }
        // Paid refill order: its subscription moves to the next cycle in this same transaction.
        await advanceRefillOnPayment(nextOrder as IPharmacyOrder, session);

        const processedPayment = await this.paymentRepository.update(
          { _id: paymentRecord._id!, isProcessed: false },
          { isProcessed: true },
          { new: true, session }
        );

        const latestPayment =
          processedPayment ||
          ((await this.paymentRepository.findById(paymentRecord._id!, session)) as IPaymentRecord | null) ||
          paymentRecord;

        return {
          updatedOrder: nextOrder,
          updatedPayment: latestPayment,
          paymentProcessingClaimed: Boolean(processedPayment),
        };
      });

    if (!updatedOrder) {
      throw new AppError({
        status: 500,
        code: 'PHARMACY_ORDER_UPDATE_FAILED',
        message: 'Failed to update pharmacy order payment status',
      });
    }

    await this.queuePharmacyOrderSubscriptionSyncSafely(String(updatedOrder._id), 'payment_completed');
    if (updatedOrder.customerId) {
      await this.queuePharmacyOrderNotificationSafely(String(updatedOrder._id), 'payment_completed');
    }

    if (paymentProcessingClaimed) {
      await this.incrementCouponUsageAfterProcessing(updatedPayment);
    }

    return {
      paymentRecord: updatedPayment,
      entity: updatedOrder,
    };
  }

  private async processExternalBookingPayment(
    paymentRecord: IPaymentRecord
  ): Promise<{
    paymentRecord: IPaymentRecord;
    entity: unknown;
  }> {
    const thisRecord = String(paymentRecord._id);
    const capture = (applicable: (b: { status?: string; paymentStatus?: string; paymentTransactionId?: string }) => boolean) => recordGatewayCapture({
      model: ExternalBookingModel, kind: 'external_booking', bookingId: String(paymentRecord.contextId), userId: paymentRecord.userId,
      recordId: thisRecord, amount: Number(paymentRecord.finalAmount || 0),
      gross: Math.max(0, Number(paymentRecord.baseAmount || 0) - Number(paymentRecord.discountAmount || 0)),
      legacyFunded: Number(paymentRecord.notes?.walletDeductedAmount || 0), applicable, wallets: this.walletRepository,
    });
    const returned = async (entity: unknown) => {
      const refunded = (await this.paymentRepository.update({ _id: paymentRecord._id! }, { status: 'refunded', isProcessed: true })) || paymentRecord;
      return { paymentRecord: refunded as IPaymentRecord, entity };
    };

    // Not payable (cancelled/closed/refunded, or already paid through another record): never fulfil; return it.
    const current = (await this.externalBookingRepository.findById(paymentRecord.contextId)) as IExternalBooking | null;
    const payableOrOurs = (b: { status?: string; paymentStatus?: string; paymentTransactionId?: string; walletFunding?: { closed?: boolean } }) =>
      !b.walletFunding?.closed && b.status !== 'cancelled' && !['refunded', 'cancelled'].includes(String(b.paymentStatus))
      && !(b.paymentStatus === 'paid' && b.paymentTransactionId && String(b.paymentTransactionId) !== thisRecord);
    if (current && !payableOrOurs(current as never)) {
      const r = await capture(() => false);
      if (r.state === 'returned') return returned(current);
    }

    const updatedExternal = await this.finalizeExternalBookingPayment(
      paymentRecord,
    );

    // The payment only counts if it is the one the booking ended up paid with (another capture may have won while
    // this one was in flight, or the booking was cancelled meanwhile); otherwise it goes back to the wallet once.
    const applied = await capture((b) => b.paymentStatus === 'paid' && String(b.paymentTransactionId) === thisRecord && b.status !== 'cancelled');
    if (applied.state === 'returned') return returned(updatedExternal);
    if ((updatedExternal as { postPaymentCompletedFor?: string } | null)?.postPaymentCompletedFor === thisRecord) {
      return { paymentRecord: await this.finalizePaymentProcessing(paymentRecord), entity: updatedExternal };
    }

    await this.sendExternalBookingEmailNotification(
      updatedExternal as IExternalBooking,
      'ORDER_SCHEDULED'
    );
    await this.externalBookingRepository.update({ _id: paymentRecord.contextId }, { $set: { postPaymentCompletedFor: thisRecord } } as never);
    const finalizedPayment = await this.finalizePaymentProcessing(paymentRecord);
    return {
      paymentRecord: finalizedPayment,
      entity: updatedExternal,
    };
  }

  async recoverExternalBookingPayment(
    paymentRecord: IPaymentRecord
  ): Promise<{
    paymentRecord: IPaymentRecord;
    entity: unknown;
  }> {
    logger.info('[Payment][external] recover fulfillment requested', {
      paymentTransactionId: paymentRecord._id,
      bookingId: paymentRecord.contextId,
      paymentStatus: paymentRecord.status,
      isProcessed: paymentRecord.isProcessed,
    });
    return this.processExternalBookingPayment(paymentRecord);
  }

  async finalizeExternalBookingPayment(
    paymentRecord: IPaymentRecord
  ): Promise<unknown> {
    return completeExternalBookingAfterPayment(
      paymentRecord,
      this.externalBookingRepository,
      this.labstackService,
      this.healthiansService
    );
  }

  private isRecoverableExternalFulfillmentError(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes('timeout') || message.includes('status code 5');
  }

  private async markExternalBookingConfirmationPending(
    paymentRecord: IPaymentRecord,
    error: unknown
  ): Promise<unknown> {
    logger.error('[Payment][external] fulfillment pending after verify', {
      paymentTransactionId: paymentRecord._id,
      bookingId: paymentRecord.contextId,
      paymentStatus: paymentRecord.status,
      isProcessed: paymentRecord.isProcessed,
      error: error instanceof Error ? error.message : String(error),
    });
    const booking = await this.externalBookingRepository.findById(paymentRecord.contextId);
    if (!booking) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    const priorMeta =
      booking.meta && typeof booking.meta === 'object' && !Array.isArray(booking.meta)
        ? { ...(booking.meta as Record<string, unknown>) }
        : {};

    const updated = await this.externalBookingRepository.update(
      { _id: paymentRecord.contextId },
      {
        status: 'pending',
        paymentStatus: 'paid',
        paymentTransactionId: paymentRecord._id!,
        meta: {
          ...priorMeta,
          paymentConfirmationPendingAt:
            (priorMeta.paymentConfirmationPendingAt as string | undefined) ||
            new Date().toISOString(),
          paymentConfirmationError:
            error instanceof Error ? error.message : String(error),
        },
      }
    );

    if (updated) {
      await this.sendExternalBookingEmailNotification(
        updated as IExternalBooking,
        'CREATED'
      );
    }

    return updated;
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

  private isPharmacyWalletRecharge(paymentRecord: IPaymentRecord): boolean {
    return (
      paymentRecord.context === 'wallet_recharge' &&
      Boolean(paymentRecord.payerPharmacyId) &&
      paymentRecord.notes?.flow === 'pharmacy_wallet_recharge'
    );
  }

  private async ensurePharmacyWalletRechargeTransaction(
    paymentRecord: IPaymentRecord
  ): Promise<unknown> {
    const pharmacyId = paymentRecord.payerPharmacyId!;
    await this.pharmacyWalletRepository.upsertWallet(pharmacyId);

    try {
      return await this.runPharmacyPaymentCoreTransaction(async (session) => {
        const existingTransaction = await this.pharmacyWalletTransactionRepository.findOne(
          {
            pharmacyId,
            referenceType: 'wallet_recharge',
            referenceId: paymentRecord._id!,
            status: 'completed',
          },
          session
        );
        if (existingTransaction) {
          return this.pharmacyWalletRepository.findOne({ pharmacyId }, session);
        }

        const amountPaise =
          paymentRecord.baseAmountPaise ?? Math.round(paymentRecord.baseAmount * 100);
        const updated = await this.pharmacyWalletRepository.atomicCredit(
          pharmacyId,
          amountPaise / 100,
          session
        );
        if (!updated) {
          throw new AppError({
            status: 500,
            code: 'PHARMACY_WALLET_CREDIT_FAILED',
            message: 'Failed to credit pharmacy wallet after payment',
          });
        }

        const balanceAfterPaise = updated.balancePaise ?? Math.round(updated.balance * 100);
        const balanceBeforePaise = balanceAfterPaise - amountPaise;
        await this.pharmacyWalletTransactionRepository.save(
          {
            pharmacyId,
            walletId: String(updated._id),
            transactionType: 'credit',
            amount: amountPaise / 100,
            amountPaise,
            balanceBefore: balanceBeforePaise / 100,
            balanceAfter: balanceAfterPaise / 100,
            balanceBeforePaise,
            balanceAfterPaise,
            status: 'completed',
            referenceType: 'wallet_recharge',
            referenceId: paymentRecord._id!,
            description: 'Pharmacy wallet recharge via Razorpay',
            notes: paymentRecord.razorpayPaymentId,
            transactionDate: getTodayYyyymmdd(),
          },
          { session }
        );

        return updated;
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const wallet = await this.pharmacyWalletRepository.findByPharmacy(pharmacyId);
        if (wallet) return wallet;
      }
      throw error;
    }
  }

  private async ensureWalletRechargeTransaction(paymentRecord: IPaymentRecord): Promise<unknown> {
    let wallet = await this.getOrCreateActiveWallet(paymentRecord.userId);

    const existingTransaction = await this.walletTransactionRepository.findOne({
      userId: paymentRecord.userId,
      referenceType: 'wallet_recharge',
      referenceId: paymentRecord._id!,
      status: 'completed',
    });

    if (!existingTransaction) {
      const posted = await this.walletRepository.postEntry({
        userId: paymentRecord.userId,
        walletId: wallet._id!,
        transactionType: 'credit',
        amount: paymentRecord.baseAmount,
        referenceType: 'wallet_recharge',
        referenceId: paymentRecord._id!,
        operationKey: `wallet_recharge:${paymentRecord._id}`,
        description: `Wallet recharge via Razorpay${paymentRecord.couponCode ? ` (coupon: ${paymentRecord.couponCode})` : ''}`,
        notes: paymentRecord.razorpayPaymentId,
        transactionDate: getTodayYyyymmdd(),
      });
      wallet = posted?.wallet || wallet;
    }

    return wallet;
  }

  private getExternalBookingMeta(
    booking: Pick<IExternalBooking, 'meta'>
  ): Record<string, unknown> {
    return booking.meta &&
      typeof booking.meta === 'object' &&
      !Array.isArray(booking.meta)
      ? { ...(booking.meta as Record<string, unknown>) }
      : {};
  }

  private getExternalAppointmentId(booking: IExternalBooking): string | undefined {
    if (booking.externalBookingId?.trim()) {
      return booking.externalBookingId.trim();
    }

    const root = this.getExternalBookingMeta(booking);
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
      bookingResponse?.appointment &&
      typeof bookingResponse.appointment === 'object'
        ? (bookingResponse.appointment as Record<string, unknown>)
        : undefined;

    const source = order || appointment || bookingResponse || externalPayload || root;
    const candidates = ['orderId', 'appointmentId', 'lsAppointmentId', 'referenceId', 'id'];

    for (const key of candidates) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }

    return undefined;
  }

  private async refundExternalBookingAmountToWallet(
    booking: IExternalBooking,
    paymentRecord: IPaymentRecord
  ): Promise<number> {
    const referenceId = String(booking._id!);

    // Legacy: a refund posted before the booking ledger existed (no operation key) settles it.
    const legacyRefund = await this.walletTransactionRepository.findOne({
      userId: booking.userId,
      transactionType: 'refund',
      referenceType: 'external_booking',
      referenceId,
      status: 'completed',
      operationKey: { $exists: false },
    } as never);
    if (legacyRefund) {
      return Number(legacyRefund.amount || 0);
    }

    // Everything the booking holds (wallet funding + applied captures), returned once and the booking closed.
    const refundAmount = await refundAndClose({
      model: ExternalBookingModel, kind: 'external_booking', bookingId: referenceId, userId: booking.userId,
      legacyFunded: Number(paymentRecord.notes?.walletDeductedAmount || 0),
      legacyGateway: paymentRecord.status === 'paid' ? Number(paymentRecord.finalAmount || 0) : 0,
      legacyGatewayRecordId: String(paymentRecord._id),
      wallets: this.walletRepository,
    });

    if (paymentRecord.couponCode && paymentRecord.isProcessed) {
      try {
        const coupon = await this.couponService.getByCode(paymentRecord.couponCode);
        await this.couponService.decrementUsage(coupon._id!);
      } catch (error) {
        logger.error('[Payment][external] failed to reverse coupon usage on refund', {
          bookingId: booking._id,
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

    return refundAmount;
  }

  private async refundAbandonedPharmacyOrderToWallet(
    order: IPharmacyOrder,
    paymentRecord: IPaymentRecord,
    options: { skipPaymentStateUpdate?: boolean } = {}
  ): Promise<number> {
    const referenceId = String(order._id!);
    const refundUserId = paymentRecord.payerUserId || paymentRecord.userId;

    const existingRefund = await this.walletTransactionRepository.findOne({
      userId: refundUserId,
      transactionType: 'refund',
      referenceType: 'pharmacy_order',
      referenceId,
      status: 'completed',
    });
    if (existingRefund) {
      return Number(existingRefund.amount || 0);
    }

    const walletDeductedAmount = Number(paymentRecord.notes?.walletDeductedAmount || 0);
    const gatewayPaidAmount =
      paymentRecord.status === 'paid' ? Number(paymentRecord.finalAmount || 0) : 0;
    const refundAmount = walletDeductedAmount + gatewayPaidAmount;

    if (refundAmount > 0) {
      await this.getOrCreateActiveWallet(refundUserId);
      const session = await startSession();
      try {
        await session.withTransaction(async () => {
          const alreadyRefunded = await this.walletTransactionRepository.findOne(
            {
              userId: refundUserId,
              transactionType: 'refund',
              referenceType: 'pharmacy_order',
              referenceId,
              status: 'completed',
            },
            session
          );
          if (alreadyRefunded) return;

          const updatedWallet = await this.walletRepository.atomicCredit(
            refundUserId,
            refundAmount,
            session
          );
          if (!updatedWallet) {
            throw new AppError({
              status: 500,
              code: 'PHARMACY_ORDER_REFUND_FAILED',
              message: 'Refund wallet could not be credited',
            });
          }
          const balanceAfter = updatedWallet.balance;
          await this.walletTransactionRepository.save(
            {
              userId: refundUserId,
              walletId: updatedWallet._id!,
              transactionType: 'refund',
              amount: refundAmount,
              balanceBefore: balanceAfter - refundAmount,
              balanceAfter,
              status: 'completed',
              referenceType: 'pharmacy_order',
              referenceId,
              // Same key as the prescription-rejection refund: one pharmacy-order refund, whichever path wins.
              operationKey: `pharmacy_order_refund:${String(referenceId).toLowerCase()}`,
              description: 'Refund for abandoned pharmacy order',
              transactionDate: getTodayYyyymmdd(),
            },
            { session }
          );
        });
      } catch (error) {
        // A concurrent refund for this order already posted (unique operationKey); this transaction rolled back.
        if (!((error as { code?: number })?.code === 11000 && /operationKey/.test(String((error as Error)?.message)))) throw error;
      } finally {
        await session.endSession();
      }
    }

    if (paymentRecord.couponCode && paymentRecord.isProcessed) {
      try {
        const coupon = await this.couponService.getByCode(paymentRecord.couponCode);
        await this.couponService.decrementUsage(coupon._id!);
      } catch (error) {
        logger.error('[Payment][pharmacy_order] failed to reverse coupon usage on refund', {
          orderId: order._id,
          paymentTransactionId: paymentRecord._id,
          couponCode: paymentRecord.couponCode,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!options.skipPaymentStateUpdate) {
      await this.paymentRepository.update(
        { _id: paymentRecord._id! },
        { status: 'refunded', isProcessed: true }
      );
    }

    return refundAmount;
  }

  private async handleTerminalExternalFulfillmentFailure(
    paymentRecord: IPaymentRecord,
    error: unknown
  ): Promise<{ refunded: boolean; booking?: IExternalBooking }> {
    const booking = (await this.externalBookingRepository.findById(
      paymentRecord.contextId
    )) as IExternalBooking | null;

    if (!booking) {
      return { refunded: false };
    }

    const externalAppointmentId = this.getExternalAppointmentId(booking);
    if (externalAppointmentId) {
      return { refunded: false, booking };
    }

    const priorMeta = this.getExternalBookingMeta(booking);
    const refundAmount = await this.refundExternalBookingAmountToWallet(
      booking,
      paymentRecord
    );

    const updated =
      (await this.externalBookingRepository.update(
        { _id: paymentRecord.contextId },
        {
          status: 'cancelled',
          paymentStatus: refundAmount > 0 ? 'refunded' : 'cancelled',
          paymentTransactionId: paymentRecord._id!,
          meta: {
            ...priorMeta,
            cancellationReason:
              'Booking creation failed after payment confirmation',
            cancelRequestedWhileConfirmationPending: true,
            cancelRequestedAt:
              (priorMeta.cancelRequestedAt as string | undefined) ||
              new Date().toISOString(),
            needsProviderCancelIfDiscovered: true,
            paymentFulfillmentFailedAt: new Date().toISOString(),
            paymentFulfillmentError:
              error instanceof Error ? error.message : String(error),
            ...(refundAmount > 0 ? { paymentFailureWalletRefunded: true } : {}),
          },
        }
      )) || booking;

    await this.sendExternalBookingEmailNotification(
      updated as IExternalBooking,
      'CANCELED'
    );

    return { refunded: refundAmount > 0, booking: updated as IExternalBooking };
  }

  private async processWalletRechargePayment(
    paymentRecord: IPaymentRecord
  ): Promise<{
    paymentRecord: IPaymentRecord;
    entity: unknown;
  }> {
    const wallet = this.isPharmacyWalletRecharge(paymentRecord)
      ? await this.ensurePharmacyWalletRechargeTransaction(paymentRecord)
      : await this.ensureWalletRechargeTransaction(paymentRecord);
    const finalizedPayment = await this.finalizePaymentProcessing(paymentRecord);

    return {
      paymentRecord: finalizedPayment,
      entity: wallet,
    };
  }

  async verifyPaymentAndProcess(data: VerifyPaymentRequest): Promise<{
    context: 'booking' | 'wallet_recharge' | 'external_booking' | 'pharmacy_order';
    paymentRecord: IPaymentRecord;
    entity: unknown;
  }> {
    logger.info('[Payment][verify] request received', {
      paymentTransactionId: data.paymentTransactionId,
      razorpayOrderId: data.razorpayOrderId,
      userId: data.userId,
      module: data.module,
    });
    const paymentRecord = await this.verifyAndMarkPaid(data);

    logger.info('[Payment][verify] payment verified', {
      paymentTransactionId: paymentRecord._id,
      bookingId: paymentRecord.contextId,
      context: paymentRecord.context,
      paymentStatus: paymentRecord.status,
      isProcessed: paymentRecord.isProcessed,
    });

    if (paymentRecord.isProcessed) {
      logger.info('[Payment][verify] already processed, returning existing entity', {
        paymentTransactionId: paymentRecord._id,
        bookingId: paymentRecord.contextId,
      });
      return this.buildAlreadyProcessedResponse(paymentRecord, data.module);
    }

    if (this.shouldFulfillExternalBooking(paymentRecord, data.module)) {
      try {
        logger.info('[Payment][external] fulfillment start after verify', {
          paymentTransactionId: paymentRecord._id,
          bookingId: paymentRecord.contextId,
          paymentStatus: paymentRecord.status,
          isProcessed: paymentRecord.isProcessed,
        });
        const result = await this.processExternalBookingPayment(paymentRecord);
        logger.info('[Payment][external] fulfillment success after verify', {
          paymentTransactionId: result.paymentRecord._id,
          bookingId: paymentRecord.contextId,
          paymentStatus: result.paymentRecord.status,
          isProcessed: result.paymentRecord.isProcessed,
        });
        return {
          context: 'external_booking',
          paymentRecord: result.paymentRecord,
          entity: result.entity,
        };
      } catch (error) {
        if (!this.isRecoverableExternalFulfillmentError(error)) {
          let refunded = false;
          try {
            const handled = await this.handleTerminalExternalFulfillmentFailure(
              paymentRecord,
              error
            );
            refunded = handled.refunded;
          } catch (cleanupError) {
            logger.error('[Payment][external] terminal failure cleanup failed', {
              paymentTransactionId: paymentRecord._id,
              bookingId: paymentRecord.contextId,
              cleanupError:
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError),
            });
          }

          logger.error('[Payment][external] fulfillment failed after verify', {
            paymentTransactionId: paymentRecord._id,
            bookingId: paymentRecord.contextId,
            error: error instanceof Error ? error.message : String(error),
            refundedToWallet: refunded,
          });
          if (refunded) {
            throw new AppError({
              status: 502,
              code: 'EXTERNAL_BOOKING_FULFILLMENT_FAILED_REFUNDED',
              message: `External booking failed after payment and the amount was refunded to wallet. Original error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          }
          throw error;
        }

        const pendingEntity =
          await this.markExternalBookingConfirmationPending(paymentRecord, error);

        return {
          context: 'external_booking',
          paymentRecord,
          entity: pendingEntity || {},
        };
      }
    }

    if (paymentRecord.context === 'booking') {
      const result = await this.processBookingPayment(paymentRecord);

      return {
        context: 'booking',
        paymentRecord: result.paymentRecord,
        entity: result.entity,
      };
    }

    if (paymentRecord.context === 'wallet_recharge') {
      const result = await this.processWalletRechargePayment(paymentRecord);

      return {
        context: 'wallet_recharge',
        paymentRecord: result.paymentRecord,
        entity: result.entity,
      };
    }

    if (paymentRecord.context === 'pharmacy_order') {
      const result = await this.processPharmacyOrderPayment(paymentRecord);

      return {
        context: 'pharmacy_order',
        paymentRecord: result.paymentRecord,
        entity: result.entity,
      };
    }

    throw new AppError({
      status: 400,
      code: 'UNSUPPORTED_PAYMENT_CONTEXT',
      message: 'Unsupported payment context',
    });
  }
}
