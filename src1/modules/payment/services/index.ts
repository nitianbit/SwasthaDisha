import crypto from 'crypto';
import { advanceRefillOnPayment } from '@/modules/pharmacySubscriptions/refillCycle';
import BookingModel from '@/modules/bookings/model';
import { recordGatewayCapture, runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { countCouponUsageIn } from '@/modules/coupon/usage';
import PaymentRecordModel from '@/modules/payment/model';
import ExternalBookingModel from '@/modules/externalBookings/model';
import { ClientSession, startSession, Types } from 'mongoose';
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
import { beginProvider, CANCELLATION_REQUESTED, externalRefOf, failProvider, progressCancellation, publicExternalBooking,
  requestCancellation } from '@/modules/externalBookings/services/providerOps';
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
import { doctorExistsIneligible } from '@/modules/specialists/eligibility';
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
  PaymentContext,
  VerifyPaymentRequest,
  isAssistedCardContext,
} from '@/modules/payment/types';
import { publicNoShowView } from '@/modules/bookings/utils/noShowView';

interface RazorpayOrderResponse {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

import { assistedFlags } from '@/modules/assisted/flags';
import { creditTopupIn, topupClosedCompensated, type TopupKind } from '@/modules/pharmacyWallet/walletCore';
import { topupKindOf } from '@/modules/partnerWallets/topupKinds';

const rechargeSweepFrom = () => assistedFlags.rechargeSweepFrom();

interface RazorpayPaymentDetails {
  id: string;
  order_id?: string;
  amount: number;
  currency: string;
  status: string;
  /** Assisted booking phase 1a (P2): Razorpay's fee in paise (GST included), when reported. */
  fee?: number;
}

/** P2: Razorpay `fee` alone (it already includes GST); anything else is "not known yet". */
const feeOf = (raw: unknown): number | undefined => {
  const n = Number(raw);
  return raw !== null && raw !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
};

const PHARMACY_ORDER_PAYMENT_WINDOW_MS = 30 * 60 * 1000;
const PHARMACY_ORDER_PAYMENT_TIMEOUT_NOTE =
  'Payment window expired after 30 minutes. Please create a new order.';
const PHARMACY_ORDER_LATE_REFUND_NOTE =
  'Late payment was refunded to wallet because the 30-minute payment window expired.';

/** A booking payment attempt not yet settled: an open Razorpay order, or paid but not yet applied (interrupted). */
const UNSETTLED_ATTEMPT = {
  paymentGateway: 'razorpay', razorpayOrderId: { $type: 'string' },
  $or: [{ status: 'created' }, { status: 'paid', isProcessed: { $ne: true } }],
};

/** D3: thrown inside the payment commit transaction when the capture was already decided (aborts the transaction). */
class SettlementAlreadyDecided extends Error {}

/** D3: order states that can take a captured payment (pending_cancel records it without moving). */
const PHARMACY_ORDER_PAYABLE_STATUSES: string[] = ['placed', 'accepted', 'packed', 'ready_for_pickup', 'out_for_delivery',
  'delivery_failed', 'pending_cancel'];

/**
 * Q3: booking-like contexts owned by other modules register how a verified payment is applied, so this service does not
 * import them (the lab-booking module registers 'lab_booking'). Checked after the built-in contexts.
 */
export interface PaymentContextHandler {
  /** Applies a paid, not yet processed record exactly once; must call `finalize` (applied) or `markReturned` (returned). */
  process(record: IPaymentRecord, helpers: {
    finalize(record: IPaymentRecord): Promise<IPaymentRecord>;
    markReturned(record: IPaymentRecord): Promise<IPaymentRecord>;
  }): Promise<{ paymentRecord: IPaymentRecord; entity: unknown }>;
  /** The entity shown for an already processed record. */
  entity(record: IPaymentRecord): Promise<unknown>;
  /**
   * r10e (optional): the record is paid (or returned) with `record.razorpayPaymentId`; these are OTHER captured payments
   * Razorpay holds on the same order (an order only "attempted" takes more than one). Returns how many it queued back.
   */
  settleOtherCaptures?(record: IPaymentRecord, captured: { id: string; amount: number; currency: string }[]): Promise<number>;
}
const CONTEXT_HANDLERS = new Map<PaymentContext, PaymentContextHandler>();
export function registerPaymentContextHandler(context: PaymentContext, handler: PaymentContextHandler): void {
  CONTEXT_HANDLERS.set(context, handler);
}

/**
 * Q16a (A): the booking price terms of a paying record — `price` the base minus the coupon discount (what create sets
 * with a coupon). Empty for a record without terms (nothing is rewritten).
 * Q16d (F4): the booking's list price stays in `originalPrice` (a package's record base is its discounted price, not
 * the list price); `originalPrice` is set from the record only when the booking has none.
 */
export function bookingPriceTermsOf(r: { baseAmount?: unknown; discountAmount?: unknown },
  booking?: { originalPrice?: unknown }): { price?: number; originalPrice?: number } {
  const base = Number(r.baseAmount);
  if (r.baseAmount === undefined || r.baseAmount === null || !Number.isFinite(base) || base < 0) return {};
  const discount = Math.max(0, Number(r.discountAmount || 0));
  const hasList = booking?.originalPrice !== undefined && booking?.originalPrice !== null;
  return { ...(hasList ? {} : { originalPrice: base }), price: Math.round(Math.max(0, base - discount) * 100) / 100 };
}

@Service()
export class PaymentService {
  private razorpayClient?: Razorpay;
  /**
   * Stage merge (S6 back-credit script + phase 1a ledger): called with the id of the wallet_recharge credit row a
   * transaction attempt wrote (not on a replay). The S6 script compares it with the committed row to know whether ITS
   * run credited the top-up; an aborted attempt's id never matches the committed row.
   */
  onWalletRechargeCredited?: (entryId: string) => void;

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
    // r13: kept for the constructor's positions (DI and positional callers); top-up credits go through the wallet stores.
    protected pharmacyWalletRepository: PharmacyWalletRepository,
    protected pharmacyWalletTransactionRepository: PharmacyWalletTransactionRepository,
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

  /**
   * D3: the one decision for a pharmacy order capture, stored on its payment record and claimed once from absent:
   * 'applied' (the commit claims it in the transaction that pays the order) or 'returned' (claimed here before any
   * wallet credit). Whichever claims first wins; the other path follows it. A record from before this decision existed
   * is classified once from the order: a live order holding this processed payment, or a closed one whose refund is
   * already an intent (P2), counts as applied; anything else - including a cancelled order that kept a payment with
   * no refund intent - is returned to the wallet.
   */
  private async decidePharmacySettlement(order: IPharmacyOrder, paymentRecord: IPaymentRecord): Promise<'applied' | 'returned'> {
    const current = await PaymentRecordModel.findById(paymentRecord._id).lean() as IPaymentRecord | null;
    if (current?.pharmacySettlement) return current.pharmacySettlement;
    const closed = ['cancelled', 'rejected', 'abandoned'].includes(order.status);
    const holdsThis = String(order.paymentTransactionId ?? '') === String(paymentRecord._id)
      && ['paid', 'partially_paid', 'refunded'].includes(String(order.paymentStatus));
    const want = holdsThis && current?.isProcessed && (!closed || !!order.prescriptionRefund) ? 'applied' : 'returned';
    const claimed = await PaymentRecordModel.findOneAndUpdate({ _id: paymentRecord._id, pharmacySettlement: { $in: [null] } },
      { $set: { pharmacySettlement: want } }, { new: true }).lean() as IPaymentRecord | null;
    const decided = claimed ?? (await PaymentRecordModel.findById(paymentRecord._id).lean() as IPaymentRecord | null);
    return decided?.pharmacySettlement ?? want;
  }

  private async handleTimedOutPharmacyOrderPayment(
    order: IPharmacyOrder,
    paymentRecord: IPaymentRecord
  ): Promise<{
    paymentRecord: IPaymentRecord;
    entity: unknown;
  }> {
    // Decided before any wallet credit, through the capture's one stored decision: an applied payment is never returned.
    const current = ((await this.pharmacyOrderRepository.findById(String(order._id))) as IPharmacyOrder | null) ?? order;
    if (await this.decidePharmacySettlement(current, paymentRecord) === 'applied') {
      const processed = (await this.paymentRepository.update({ _id: paymentRecord._id!, isProcessed: false }, { isProcessed: true }, { new: true }))
        || (await this.paymentRepository.findById(paymentRecord._id!)) || paymentRecord;
      return { paymentRecord: processed as IPaymentRecord, entity: current };
    }
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
        // D3: decided from a fresh read in this transaction, never from the caller's copy. Only an open, unpaid
        // order whose payment window expired is abandoned (with its stock released by that same write); a closed
        // order released its stock already, and any other order (paid through another record, frozen by a
        // cancellation request, progressed) keeps its status and stock - only this capture is refunded.
        const fresh = (await this.pharmacyOrderRepository.findById(String(order._id), session)) as IPharmacyOrder | null;
        if (!fresh) {
          throw new AppError({ status: 404, code: 'PHARMACY_ORDER_NOT_FOUND', message: 'Pharmacy order not found for this payment' });
        }
        const abandonable = ['placed', 'accepted'].includes(fresh.status)
          && ['pending', 'failed', 'authorized', undefined].includes(fresh.paymentStatus);
        const abandoned = abandonable
          ? ((await this.pharmacyOrderRepository.update(
              { _id: fresh._id, status: fresh.status, paymentStatus: fresh.paymentStatus ?? { $exists: false } },
              {
                status: 'abandoned',
                paymentTransactionId: paymentRecord._id!,
                notes: this.appendOrderNote(fresh.notes, PHARMACY_ORDER_PAYMENT_TIMEOUT_NOTE),
              },
              { new: true, session }
            )) as IPharmacyOrder | null)
          : null;
        if (abandonable && !abandoned) {
          throw new AppError({ status: 409, code: 'PHARMACY_ORDER_PAYMENT_STATE_CHANGED', message: 'The order changed while its payment was refunded' });
        }
        const inventoryWasAlreadyReleased = !abandoned;
        const nextOrder = abandoned || fresh;

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
        if (!inventoryWasAlreadyReleased && legacyInventoryItems.length && abandoned) {
          await this.inventoryService.returnStockBulk(
            String(nextOrder.pharmacyId),
            legacyInventoryItems,
            session
          );
        }

        // Marks the order refunded only when no other payment holds it (never a paid / frozen order's state).
        const orderAfterRefund =
          ((await this.pharmacyOrderRepository.update(
            { _id: nextOrder._id, paymentStatus: { $nin: ['paid', 'partially_paid', 'refunded'] } },
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

  /**
   * Review of b378f61 (item 1): read only — the order id Razorpay holds for a payment id, for an admin naming a top-up
   * by a payment id the database never stored. `available: false` when gateway keys are not configured.
   */
  async gatewayOrderIdOfPayment(razorpayPaymentId: string): Promise<{ available: false } | { available: true; orderId: string | null }> {
    let client: Razorpay;
    try { client = this.getRazorpayClient(); } catch { return { available: false }; }
    try {
      const p = await client.payments.fetch(razorpayPaymentId) as { order_id?: unknown };
      return { available: true, orderId: typeof p?.order_id === 'string' && p.order_id ? p.order_id : null };
    } catch (error: any) {
      const status = Number(error?.statusCode ?? error?.status);
      if (status === 400 || status === 404 || error?.error?.code === 'BAD_REQUEST_ERROR') return { available: true, orderId: null };
      throw new AppError({ status: 502, code: 'RAZORPAY_PAYMENT_FETCH_FAILED', message: 'The gateway could not be asked about this payment; try the order id or the record id' });
    }
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
          : data.context === 'lab_booking'
            ? 'lb'
          : data.context === 'instant_request'
            ? 'ic'
          : data.context === 'assisted_booking'
            ? 'ab'
          : data.context === 'assisted_lab_booking'
            ? 'al'
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
      ...(data.recordId ? { _id: data.recordId } : {}),
      userId: data.userId,
      payerUserId: this.getPaymentPayerUserId(data),
      payerPharmacyId: data.payerPharmacyId,
      // r13 (§24.7.2): a partner-paid order (a lab top-up) names the paying partner and member, and its request key.
      ...(data.payerPartnerId ? { payerPartnerId: data.payerPartnerId, payerMemberId: data.payerMemberId } : {}),
      ...(data.requestKey ? { requestKey: data.requestKey, requestHash: data.requestHash } : {}),
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

    const isProcessed = data.isProcessed ?? true;
    const couponCode = typeof data.couponCode === 'string' && data.couponCode.trim() ? data.couponCode : undefined;
    // A processed booking record with a coupon is created and counted in one transaction (coupon/usage.ts); one
    // created unprocessed is counted by the finalizer.
    if (couponCode && data.context === 'booking' && isProcessed) {
      return runLedgerTransaction((session) => this.createDirectPaidBookingRecordIn(data, session));
    }

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
      ...(couponCode && data.context === 'booking' ? { couponUsage: 'pending' as const } : {}),
      status: 'paid',
      isProcessed,
      paidAt: new Date(),
      notes: data.notes,
    });
  }

  /**
   * Inserts a processed, internally paid booking record inside the caller's transaction and counts its coupon in it
   * (coupon/usage.ts). The caller writes the payable booking in the same transaction, which serializes the whole
   * effect with cancellation (A2a).
   */
  async createDirectPaidBookingRecordIn(data: CreateDirectPaidTransactionRequest, session: ClientSession,
    id: Types.ObjectId = new Types.ObjectId()): Promise<IPaymentRecord> {
    if (data.context !== 'booking' && data.context !== 'lab_booking' && data.context !== 'instant_request') {
      throw new AppError({ status: 500, code: 'INVALID_PAYMENT_CONTEXT', message: 'Booking payments only' });
    }
    const couponCode = typeof data.couponCode === 'string' && data.couponCode.trim() ? data.couponCode : undefined;
    await PaymentRecordModel.create([{
      _id: id, userId: data.userId, payerUserId: this.getPaymentPayerUserId(data), payerPharmacyId: data.payerPharmacyId,
      context: data.context, contextId: data.contextId, baseAmount: data.baseAmount, discountAmount: data.discountAmount || 0,
      finalAmount: data.finalAmount, baseAmountPaise: Math.round(data.baseAmount * 100),
      discountAmountPaise: Math.round((data.discountAmount || 0) * 100), finalAmountPaise: Math.round(data.finalAmount * 100),
      currency: (data.currency || 'INR').toUpperCase(), paymentGateway: 'internal',
      ...(couponCode ? { couponCode, couponUsage: 'pending' } : {}), status: 'paid', isProcessed: true, paidAt: new Date(), notes: data.notes,
    }], { session });
    if (couponCode) await countCouponUsageIn(String(id), session);
    return (await PaymentRecordModel.findById(id).session(session).lean()) as unknown as IPaymentRecord;
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
      (paymentRecord.context === 'booking' || paymentRecord.context === 'pharmacy_order' || isAssistedCardContext(paymentRecord.context))
    ) {
      if (isAssistedCardContext(paymentRecord.context)) {
        // Phase 1b (§6.1): an assisted card payment is verified by its paying organisation (the pharmacy), whoever of it acts.
        // r14: consultations and lab bookings alike.
        pharmacyCanVerify = !!paymentRecord.payerPharmacyId
          && String(paymentRecord.payerPharmacyId).toLowerCase() === String(data.requesterPharmacyId).toLowerCase();
      } else if (paymentRecord.context === 'booking') {
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

    // r13 (§24.7.2): a lab top-up is verified by any member of its paying lab (the partner-workspace routes, which admit
    // members holding wallet.manage).
    const topupKind = topupKindOf(paymentRecord);
    const partnerCanVerify = !belongsToRequester && data.requesterUserType === 'partner' && !!data.requesterPartnerId
      && topupKind?.kind === 'lab' && topupKind.ownerOf(paymentRecord) === String(data.requesterPartnerId).toLowerCase();

    if (!belongsToRequester && !pharmacyCanVerify && !partnerCanVerify) {
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
    if (paymentRecord.compensatedAt) throw topupClosedCompensated();
    // r10b: a card dispute recorded on an assisted booking payment (not a top-up); r14: lab bookings too.
    if (paymentRecord.chargebackAt && isAssistedCardContext(paymentRecord.context)) {
      throw new AppError({ status: 409, code: 'PAYMENT_DISPUTED',
        message: 'A card dispute was recorded on this booking payment; it is not applied again. Contact Jansetu support' });
    }
    if (paymentRecord.chargebackAt) {
      throw new AppError({ status: 409, code: 'TOPUP_BLOCKED',
        message: 'This top-up was blocked after a lost card dispute and is not credited; contact Jansetu support' });
    }
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
      // r10b: an assisted card payment's order is never closed by a bad signature (anyone holding the record id could
      // otherwise strand it): the record stays as it is, so a real capture is still verified, reconciled or swept (r14: lab bookings too).
      if (isAssistedCardContext(paymentRecord.context)) {
        throw new AppError({ status: 400, code: 'PAYMENT_SIGNATURE_INVALID', message: 'Invalid Razorpay payment signature' });
      }
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
        fee: feeOf((payment as { fee?: unknown }).fee),
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
      // A top-up blocked after a lost card dispute (`chargebackAt`) or closed as compensated (r9) is never marked paid again.
      { _id: paymentRecord._id, status: { $nin: ['paid', 'refunded'] }, chargebackAt: { $exists: false }, compensatedAt: { $exists: false } },
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

    // r10e: ANOTHER payment captured on an order whose record already holds one (a slow UPI payment and a second "pay
    // now"): proven like any capture (signature, the gateway's own record of it), then returned once, never applied.
    const otherCaptures = CONTEXT_HANDLERS.get(paymentRecord.context)?.settleOtherCaptures;
    if (otherCaptures && ['paid', 'refunded'].includes(paymentRecord.status) && paymentRecord.razorpayPaymentId
        && data.razorpayPaymentId !== paymentRecord.razorpayPaymentId) {
      await this.validateSignature(data, paymentRecord);
      const other = await this.fetchRazorpayPayment(data.razorpayPaymentId);
      this.validateRazorpayPaymentForRecord(paymentRecord, data, other);
      if (other.status !== 'captured') {
        throw new AppError({ status: 400, code: 'PAYMENT_NOT_COMPLETED', message: `Razorpay payment is not completed. Current status: ${other.status}` });
      }
      await otherCaptures(paymentRecord, [{ id: other.id, amount: other.amount, currency: other.currency }]);
      throw new AppError({ status: 409, code: 'DUPLICATE_PAYMENT_REFUNDED',
        message: 'This booking was already paid with another payment; this payment is being refunded to the card or UPI it was made with' });
    }

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

    const paid = await this.markPaymentAsPaid(paymentRecord, data);
    // r10e: a concurrent verify of ANOTHER payment on the same order won the record: this one is returned, not applied.
    if (otherCaptures && paid.razorpayPaymentId && paid.razorpayPaymentId !== data.razorpayPaymentId) {
      await otherCaptures(paid, [{ id: razorpayPayment.id, amount: razorpayPayment.amount, currency: razorpayPayment.currency }]);
      throw new AppError({ status: 409, code: 'DUPLICATE_PAYMENT_REFUNDED',
        message: 'This booking was already paid with another payment; this payment is being refunded to the card or UPI it was made with' });
    }
    return this.rememberGatewayFee(paid, razorpayPayment.fee);
  }

  /** P2: keeps Razorpay's fee on the record (once known; never overwritten). Best effort: the payment stands without it. */
  private async rememberGatewayFee(record: IPaymentRecord, fee: number | undefined): Promise<IPaymentRecord> {
    if (fee === undefined || record.gatewayFeeMinor !== undefined) return record;
    try {
      await PaymentRecordModel.updateOne({ _id: record._id, gatewayFeeMinor: { $exists: false } }, { $set: { gatewayFeeMinor: fee } });
      return { ...record, gatewayFeeMinor: fee };
    } catch {
      return record;
    }
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
    // Processing and the coupon count commit together (coupon/usage.ts): a cancellation either sees the count and
    // undoes it, or voids the record first so it is never counted.
    await runLedgerTransaction(async (session) => {
      const processed = await PaymentRecordModel.updateOne({ _id: paymentRecord._id!, isProcessed: { $ne: true } },
        { $set: { isProcessed: true } }, { session });
      if (processed.modifiedCount === 1) await countCouponUsageIn(String(paymentRecord._id), session);
    });

    const processedPayment = await this.paymentRepository.findById(paymentRecord._id!);
    return processedPayment || paymentRecord;
  }

  /**
   * S6: what a payment is applied to comes only from the stored record's context (set by the server when the order was
   * created). The client's `module` is never consulted: before, `module: 'external-bookings'` on a booking or pharmacy
   * order record sent it down the external-booking path.
   */
  private shouldFulfillExternalBooking(paymentRecord: IPaymentRecord): boolean {
    return paymentRecord.context === 'external_booking';
  }

  private async buildAlreadyProcessedResponse(
    paymentRecord: IPaymentRecord
  ): Promise<{
    context: PaymentContext;
    paymentRecord: IPaymentRecord;
    entity: unknown;
  }> {
    if (this.shouldFulfillExternalBooking(paymentRecord)) {
      const external = await this.externalBookingRepository.findById(
        paymentRecord.contextId
      );
      return {
        context: 'external_booking',
        paymentRecord,
        entity: external || {},
      };
    }

    const handler = CONTEXT_HANDLERS.get(paymentRecord.context);
    if (handler) {
      return { context: paymentRecord.context, paymentRecord, entity: (await handler.entity(paymentRecord)) ?? {} };
    }

    if (paymentRecord.context === 'booking') {
      const booking = await this.bookingRepository.findById(paymentRecord.contextId);
      return {
        context: 'booking',
        paymentRecord,
        entity: publicNoShowView(booking || {}), // Q16a (N7): the customer booking view
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

    const topupKind = topupKindOf(paymentRecord);
    if (topupKind) {
      const wallet = await topupKind.storeFor(paymentRecord as unknown as Record<string, unknown>).findIn(null);
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
    // S5 review: a capture for a booking whose doctor is not verified and active is recorded but not applied - it goes
    // back to the customer's wallet, exactly as a late capture for a cancelled booking does, and the booking stays
    // unconfirmed (its payment window then expires it). Nothing is lost; a capture already applied stays applied.
    const doctorBlocked = !!booking.specialistId && await doctorExistsIneligible(booking.specialistId);
    const capture = await recordGatewayCapture({
      model: BookingModel, kind: 'booking', bookingId: String(booking._id), userId: booking.userId, recordId: thisRecord,
      amount: Number(paymentRecord.finalAmount || 0),
      gross: Math.max(0, Number(paymentRecord.baseAmount || 0) - Number(paymentRecord.discountAmount || 0)),
      legacyFunded: Number(paymentRecord.notes?.walletDeductedAmount || 0),
      applicable: (b) => !doctorBlocked && b.status !== 'cancelled' && !['paid', 'refunded'].includes(String(b.paymentStatus))
        || (b.paymentStatus === 'paid' && String(b.paymentTransactionId) === thisRecord),
      applyPatch: {
        paymentStatus: 'paid',
        paymentTransactionId: thisRecord,
        // Q16a (A): the winning record's terms become the booking's price (a coupon taken at pay-again included), so the
        // earning and the legacy payout follow what the customer was actually charged.
        ...bookingPriceTermsOf(paymentRecord, booking),
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

    // P8 (defence): a payment is applied only to the amount it was taken for. A capture whose amount differs from the
    // order's current total is returned to the wallet, never used to mark a changed order paid.
    if (order.paymentMode === 'online_payment' && order.paymentStatus === 'pending' && !this.paymentCoversOrder(paymentRecord, order as IPharmacyOrder)) {
      logger.warn('[Payment][pharmacy] capture amount differs from the order total; returned', {
        orderId: String(order._id), paymentTransactionId: String(paymentRecord._id) });
      return this.handleTimedOutPharmacyOrderPayment(order as IPharmacyOrder, paymentRecord);
    }

    if (order.paymentMode === 'online_payment' && order.paymentStatus === 'pending') {
      const claimedOrder = await this.pharmacyOrderRepository.update(
        // P8: claimed only at the total that was checked against this payment.
        { _id: order._id, status: 'placed', paymentStatus: 'pending',
          ...(typeof order.grandTotal === 'number' && Number.isFinite(order.grandTotal) ? { grandTotal: order.grandTotal } : {}) },
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

    // D3: the commit writes only the payment (from an explicit list of states that can take one) and never writes a
    // status read earlier; placed → accepted is its own compare-and-set. A frozen order (pending_cancel) records the
    // capture but does not move. If the commit loses to a concurrent change, the order's actual state is routed.
    let commit: { updatedOrder: IPharmacyOrder; updatedPayment: IPaymentRecord; paymentProcessingClaimed: boolean } | null = null;
    const orderObjectId = order._id;
    for (let attempt = 0; attempt < 3 && !commit; attempt++) {
      const outcome = await this.runPharmacyPaymentCoreTransaction(async (session) => {
        const paidOrder = await this.pharmacyOrderRepository.update(
          {
            _id: orderObjectId,
            status: { $in: PHARMACY_ORDER_PAYABLE_STATUSES },
            paymentStatus: { $in: ['pending', 'authorized', 'failed'] },
          },
          { paymentStatus: 'paid', paymentTransactionId: paymentRecord._id! },
          { new: true, session }
        );
        if (!paidOrder) return null;
        const nextOrder = paidOrder.status === 'placed'
          ? ((await this.pharmacyOrderRepository.update({ _id: orderObjectId, status: 'placed' }, { status: 'accepted' }, { new: true, session })) || paidOrder)
          : paidOrder;
        // Paid refill order: its subscription moves to the next cycle in this same transaction - unless the order is
        // frozen by a cancellation request (a rejection of the request advances it then; an approval does not).
        if (nextOrder.status !== 'pending_cancel') await advanceRefillOnPayment(nextOrder as IPharmacyOrder, session);

        // The capture's one decision, in the same transaction as the order write: applied. If it was already decided
        // (returned to the wallet by a late-payment refund), this transaction is abandoned and the order is untouched.
        const processedPayment = await this.paymentRepository.update(
          { _id: paymentRecord._id!, pharmacySettlement: { $in: [null] } },
          { pharmacySettlement: 'applied', isProcessed: true },
          { new: true, session }
        );
        if (!processedPayment) throw new SettlementAlreadyDecided();

        const latestPayment = processedPayment;

        return {
          updatedOrder: nextOrder as IPharmacyOrder,
          updatedPayment: latestPayment,
          paymentProcessingClaimed: Boolean(processedPayment),
        };
      }).catch((error: unknown) => {
        if (error instanceof SettlementAlreadyDecided) return 'decided' as const;
        throw error;
      });
      if (outcome === 'decided') {
        // Already decided elsewhere (returned to the wallet): settle through that decision, never apply it.
        const decidedOrder = await this.pharmacyOrderRepository.findById(paymentRecord.contextId) as IPharmacyOrder | null;
        if (!decidedOrder) throw new AppError({ status: 404, code: 'PHARMACY_ORDER_NOT_FOUND', message: 'Pharmacy order not found for this payment' });
        return this.handleTimedOutPharmacyOrderPayment(decidedOrder, paymentRecord);
      }
      commit = outcome;
      if (commit) break;
      const latest = await this.pharmacyOrderRepository.findById(paymentRecord.contextId) as IPharmacyOrder | null;
      if (!latest) {
        throw new AppError({ status: 404, code: 'PHARMACY_ORDER_NOT_FOUND', message: 'Pharmacy order not found for this payment' });
      }
      // Closed, completed, or already paid/refunded through another record: this capture goes back to the wallet once.
      if (!PHARMACY_ORDER_PAYABLE_STATUSES.includes(latest.status)
        || ['paid', 'partially_paid', 'refunded'].includes(String(latest.paymentStatus))) {
        return this.handleTimedOutPharmacyOrderPayment(latest, paymentRecord);
      }
      // still payable (the commit lost to a concurrent change of state): try it again
    }
    if (!commit) {
      // Left unprocessed: the recovery sweep settles it later.
      throw new AppError({ status: 409, code: 'PHARMACY_ORDER_PAYMENT_STATE_CHANGED', message: 'The order changed while its payment was applied; it will be settled shortly' });
    }
    const { updatedOrder, updatedPayment, paymentProcessingClaimed } = commit;

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
    const bookingId = String(paymentRecord.contextId);
    const returned = async (entity: unknown) => {
      const refunded = (await this.paymentRepository.update({ _id: paymentRecord._id! }, { status: 'refunded', isProcessed: true })) || paymentRecord;
      return { paymentRecord: refunded as IPaymentRecord, entity };
    };

    // 1. The captured payment is applied to the booking (paid + linked) BEFORE any provider work, and only to a booking
    //    that is still payable for it: not cancelled or cancelling, not closed, not paid through another record.
    //    Otherwise it goes back to the wallet once and is never fulfilled (A2b).
    const applied = await recordGatewayCapture({
      model: ExternalBookingModel, kind: 'external_booking', bookingId, userId: paymentRecord.userId,
      recordId: thisRecord, amount: Number(paymentRecord.finalAmount || 0),
      gross: Math.max(0, Number(paymentRecord.baseAmount || 0) - Number(paymentRecord.discountAmount || 0)),
      legacyFunded: Number(paymentRecord.notes?.walletDeductedAmount || 0), wallets: this.walletRepository,
      applicable: (b: { status?: string; paymentStatus?: string; paymentTransactionId?: string }) =>
        !['cancelled', CANCELLATION_REQUESTED].includes(String(b.status)) && !['refunded', 'cancelled'].includes(String(b.paymentStatus))
        && !(b.paymentStatus === 'paid' && b.paymentTransactionId && String(b.paymentTransactionId) !== thisRecord),
      // Awaiting provider confirmation, unless the booking is already fulfilled at the provider (e.g. a pre-A2b crash
      // state replayed): its current status is kept, decided on the snapshot this capture is fenced to.
      applyPatch: (b) => ({ paymentStatus: 'paid', paymentTransactionId: thisRecord,
        ...(externalRefOf(b as IExternalBooking) || !['pending_payment', 'pending', undefined, null, ''].includes(b.status as string)
          ? {} : { status: 'pending' }) }),
    });
    if (applied.state === 'returned') {
      return returned(await this.externalBookingRepository.findById(bookingId));
    }

    // 2. Provider admission: a durable attempt is recorded before the provider call; only it may record the result.
    const admission = await beginProvider(bookingId, thisRecord);
    let updatedExternal: unknown = admission.booking;
    if (admission.token === null) {
      if (admission.reason === 'cancelling') {
        // A cancellation was recorded: it settles (and returns this payment) once the provider side is proven.
        const progressed = await progressCancellation({ bookingId, wallets: this.walletRepository });
        // Return the payment as committed (the settlement may have marked it refunded meanwhile).
        const committed = (await this.paymentRepository.findById(thisRecord)) || paymentRecord;
        return { paymentRecord: committed as IPaymentRecord, entity: publicExternalBooking(progressed.booking) };
      }
      if (admission.reason !== 'fulfilled') {
        // Another attempt is in flight (or this payment is not the booking's): nothing more to do now.
        return { paymentRecord, entity: publicExternalBooking(admission.booking) };
      }
    } else {
      try {
        updatedExternal = await this.finalizeExternalBookingPayment(paymentRecord, admission.token);
      } catch (error) {
        await failProvider(bookingId, admission.token, error);
        throw error;
      }
      const after = updatedExternal as { status?: string };
      if (after?.status === CANCELLATION_REQUESTED) {
        // Cancelled while the provider call ran: the provider booking is now a cancellation obligation.
        return { paymentRecord, entity: publicExternalBooking(updatedExternal as IExternalBooking) };
      }
    }
    updatedExternal = publicExternalBooking(updatedExternal as IExternalBooking);

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

  /** The provider booking for an admitted attempt (`token` from providerOps.beginProvider). */
  async finalizeExternalBookingPayment(paymentRecord: IPaymentRecord, token: string): Promise<unknown> {
    return completeExternalBookingAfterPayment(paymentRecord, this.externalBookingRepository, this.labstackService,
      this.healthiansService, token);
  }

  private isRecoverableExternalFulfillmentError(error: unknown): boolean {
    // A success without a provider reference is not a failure either: confirmation is pending (reconciliation).
    if ((error as { code?: string } | undefined)?.code === 'EXTERNAL_PROVIDER_REFERENCE_MISSING') return true;
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

    // Only notes the pending confirmation on a booking paid through this record and not cancelling: the payment was
    // applied (paid/link/status) by the capture step, and nothing here may re-activate or re-link a booking (A2b).
    const updated = await this.externalBookingRepository.update(
      { _id: paymentRecord.contextId, paymentStatus: 'paid', paymentTransactionId: String(paymentRecord._id),
        status: { $nin: ['cancelled', CANCELLATION_REQUESTED] } } as never,
      { $set: {
        'meta.paymentConfirmationPendingAt': (priorMeta.paymentConfirmationPendingAt as string | undefined) || new Date().toISOString(),
        'meta.paymentConfirmationError': error instanceof Error ? error.message : String(error),
      } } as never
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

  /**
   * The credit of a pharmacy or lab card top-up (r13: one implementation, `walletCore.creditTopupIn`): claimed once in a
   * transaction, then the ledger credit; a lot (with the Razorpay fee) while the kind's switch is on and the lot index
   * exists, otherwise the money is credited non-withdrawable (the conservative side).
   */
  private async ensureTopupCredit(paymentRecord: IPaymentRecord, kind: TopupKind): Promise<unknown> {
    const store = kind.storeFor(paymentRecord as unknown as Record<string, unknown>);
    await store.ensure();
    const lots = await kind.lotsWritable();
    try {
      return await this.runPharmacyPaymentCoreTransaction(async (session) => {
        const credited = await creditTopupIn(kind, paymentRecord, { lots }, session);
        if (credited.entryId) this.onWalletRechargeCredited?.(credited.entryId);
        return credited.wallet;
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const wallet = await store.findIn(null);
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

  /**
   * The provider booking failed and its outcome is proven (failProvider recorded 'rejected': never called or
   * explicitly refused): the server records its own cancellation intent and settles it, returning the money once.
   * An unknown outcome is not settled here; it stays pending until the provider side is proven (A2b).
   */
  private async handleTerminalExternalFulfillmentFailure(
    paymentRecord: IPaymentRecord,
    _error: unknown
  ): Promise<{ refunded: boolean; booking?: IExternalBooking }> {
    const bookingId = String(paymentRecord.contextId);
    const booking = (await this.externalBookingRepository.findById(bookingId)) as IExternalBooking | null;
    if (!booking || this.getExternalAppointmentId(booking)) return { refunded: false, booking: booking ?? undefined };
    await requestCancellation({ bookingId, actor: 'system', reason: 'Booking creation failed after payment confirmation' });
    const progressed = await progressCancellation({ bookingId, wallets: this.walletRepository });
    if (progressed.settled) {
      await this.sendExternalBookingEmailNotification(publicExternalBooking(progressed.booking) as IExternalBooking, 'CANCELED');
    }
    return { refunded: progressed.settled && progressed.refunded > 0, booking: publicExternalBooking(progressed.booking) as IExternalBooking };
  }

  private async processWalletRechargePayment(
    paymentRecord: IPaymentRecord
  ): Promise<{
    paymentRecord: IPaymentRecord;
    entity: unknown;
  }> {
    // r13: a lab top-up must never reach the customer wallet (its payer is a partner member, not a customer).
    const topupKind = topupKindOf(paymentRecord);
    const wallet = topupKind
      ? await this.ensureTopupCredit(paymentRecord, topupKind)
      : await this.ensureWalletRechargeTransaction(paymentRecord);
    const finalizedPayment = await this.finalizePaymentProcessing(paymentRecord);

    return {
      paymentRecord: finalizedPayment,
      entity: wallet,
    };
  }

  /** Every payment Razorpay holds for an order (server-to-server, authenticated with the merchant key). */
  private async fetchOrderPayments(orderId: string): Promise<RazorpayPaymentDetails[]> {
    const razorpayClient = this.getRazorpayClient();
    try {
      const res = (await razorpayClient.orders.fetchPayments(orderId)) as unknown as {
        items?: { id: string; order_id: string; amount: number | string; currency: string; status: string; fee?: unknown }[];
      };
      return (res.items ?? []).map((p) => ({ id: p.id, order_id: p.order_id, amount: Number(p.amount), currency: p.currency, status: p.status,
        fee: feeOf(p.fee) }));
    } catch (error: any) {
      throw new AppError({
        status: 502,
        code: 'RAZORPAY_PAYMENT_FETCH_FAILED',
        message: error?.error?.description || error?.description || 'Failed to check the payment with Razorpay',
      });
    }
  }

  /**
   * Customer-initiated reconciliation (W3b). Settles a payment whose browser-side verification never arrived (closed
   * tab, lost connection, reload): there is no gateway webhook, so without this a captured payment stayed unapplied.
   * The server asks Razorpay for the record's OWN order's payments; a captured one with the expected amount and
   * currency is the proof (no client signature is needed: the answer comes from the gateway itself). It is then marked
   * paid with the same guarded write as verify and processed by the same path (processVerifiedPayment), so late,
   * cancelled or duplicate cases are handled exactly as for verify. Nothing is changed when nothing was captured.
   * Records already failed or refunded are not revived.
   */
  async reconcilePaymentAndProcess(data: { paymentTransactionId: string; userId: string; requesterUserType?: string; requesterPharmacyId?: string;
    requesterPartnerId?: string }):
  Promise<{ state: 'unpaid'; gatewayStatuses: string[] } | ({ state: 'paid' } & Awaited<ReturnType<PaymentService['processVerifiedPayment']>>)> {
    // The order checked is always the record's own (never one supplied by the client); ownership is checked as for verify.
    const own = await this.paymentRepository.findById(data.paymentTransactionId);
    const request = { ...data, razorpayOrderId: own?.razorpayOrderId as string, razorpayPaymentId: '', razorpaySignature: '' } as VerifyPaymentRequest;
    let paymentRecord = await this.getPaymentRecordForVerification(request);
    // r10e: every payment on the order is looked at (not only the first captured one): captures other than the record's
    // are returned by the context (once per payment). A record already paid or returned is checked too.
    const otherCaptures = CONTEXT_HANDLERS.get(paymentRecord.context)?.settleOtherCaptures;
    let orderPayments: RazorpayPaymentDetails[] | null = null;
    const capturedOn = (all: RazorpayPaymentDetails[], orderId: string) => all
      .filter((p) => p.status === 'captured' && p.order_id === orderId && p.currency?.toUpperCase() === paymentRecord.currency?.toUpperCase())
      .map((p) => ({ id: p.id, amount: p.amount, currency: p.currency }));
    if (otherCaptures && ['paid', 'refunded'].includes(paymentRecord.status) && paymentRecord.razorpayPaymentId && paymentRecord.razorpayOrderId) {
      orderPayments = await this.fetchOrderPayments(paymentRecord.razorpayOrderId);
      await otherCaptures(paymentRecord, capturedOn(orderPayments, paymentRecord.razorpayOrderId));
    }
    if (paymentRecord.status !== 'paid') {
      this.handleExistingRecordStatus(paymentRecord);
      const orderId = paymentRecord.razorpayOrderId;
      if (paymentRecord.paymentGateway !== 'razorpay' || !orderId) {
        throw new AppError({ status: 400, code: 'PAYMENT_NOT_RECONCILABLE', message: 'This payment has no gateway order to check' });
      }
      const gatewayPayments = orderPayments ?? await this.fetchOrderPayments(orderId);
      orderPayments = gatewayPayments;
      const captured = gatewayPayments.find((p) => p.status === 'captured' && p.order_id === orderId);
      if (!captured) return { state: 'unpaid', gatewayStatuses: gatewayPayments.map((p) => p.status) };
      this.validateRazorpayPaymentForRecord(paymentRecord, { ...request, razorpayOrderId: orderId, razorpayPaymentId: captured.id }, captured);
      // Compare-and-set on exactly the state read before asking the gateway: a record that turned failed/refunded
      // meanwhile (e.g. a concurrent verify with a bad signature) is never revived.
      const updated = await this.paymentRepository.update(
        { _id: paymentRecord._id, status: paymentRecord.status },
        { status: 'paid', razorpayPaymentId: captured.id, paidAt: new Date() }
      );
      if (!updated) {
        const current = await this.paymentRepository.findById(paymentRecord._id!);
        if (!current) throw new AppError({ status: 404, code: 'PAYMENT_RECORD_NOT_FOUND', message: 'Payment record not found' });
        if (current.status !== 'paid') {
          this.handleExistingRecordStatus(current); // failed / refunded: refused, not revived
          throw new AppError({ status: 409, code: 'PAYMENT_CHANGED', message: 'Payment changed; refresh before retrying' });
        }
        paymentRecord = current; // a concurrent verify or reconcile won: that is the answer
      } else {
        paymentRecord = updated;
      }
      paymentRecord = await this.rememberGatewayFee(paymentRecord, captured.fee);
      logger.info('[Payment][reconcile] captured payment applied from the gateway', {
        paymentTransactionId: paymentRecord._id, razorpayOrderId: orderId, razorpayPaymentId: captured.id,
      });
    }
    const processed = await this.processVerifiedPayment(paymentRecord);
    // r10e: a record that became paid just now: any other capture on its order is returned after its own was settled.
    if (otherCaptures && orderPayments && own?.status === 'created') {
      const fresh = await this.paymentRepository.findById(String(paymentRecord._id));
      if (fresh?.razorpayPaymentId) await otherCaptures(fresh, capturedOn(orderPayments, String(fresh.razorpayOrderId)));
    }
    return { state: 'paid', ...processed };
  }

  /**
   * The booking's current unpaid Razorpay order, for "pay again" to reuse instead of creating another order (W3b): one
   * order captures at most once, so reusing it cannot charge twice. null when it is not reusable.
   */
  async resumableOrder(paymentTransactionId: string): Promise<{
    paymentTransactionId: string; razorpayOrderId: string; razorpayKeyId: string; amount: number; currency: string;
    baseAmount: number; discountAmount: number; couponCode?: string; walletDeductedAmount: number;
  } | null> {
    const r = await this.paymentRepository.findById(paymentTransactionId);
    if (!r || r.status !== 'created' || r.paymentGateway !== 'razorpay' || !r.razorpayOrderId) return null;
    return {
      paymentTransactionId: String(r._id), razorpayOrderId: r.razorpayOrderId, razorpayKeyId: this.getRazorpayCredentials().keyId,
      amount: Number(r.finalAmount), currency: r.currency, baseAmount: Number(r.baseAmount), discountAmount: Number(r.discountAmount),
      couponCode: r.couponCode, walletDeductedAmount: Number(r.notes?.walletDeductedAmount || 0),
    };
  }

  /**
   * Background recovery (W3b): there is no gateway webhook, so unsettled booking payment attempts are checked with
   * Razorpay until they are settled: a capture whose confirmation never arrived is applied (or returned to the wallet
   * if the booking is already paid or closed), and paid-but-unapplied records are resumed. Fair and complete: each
   * attempt carries its own next-check time (first check 10 minutes after creation, then backing off from 5 minutes to
   * at most 24 hours), the due ones are taken oldest-due first, and nothing ages out while it is unresolved.
   */
  async sweepUnsettledBookingPayments(now = new Date(), limit = 100): Promise<{ checked: number; unsettled: number }> {
    const records = await PaymentRecordModel.find({
      // D3: pharmacy order payments too, so a lost browser continuation never strands a capture.
      // Assisted booking phase 1a (§6.4): pharmacy wallet top-ups created from WALLET_RECHARGE_SWEEP_FROM on join the sweep
      // (older captured-but-uncredited ones are on the admin list instead).
      ...UNSETTLED_ATTEMPT,
      createdAt: { $lt: new Date(now.getTime() - 10 * 60_000) },
      $and: [{ $or: [{ recoveryNextAt: { $exists: false } }, { recoveryNextAt: null }, { recoveryNextAt: { $lte: now } }] },
        { $or: [
          // Phase 1b: assisted card payments (a capture is applied once, or refunded to its source when the booking closed);
          // r14: lab bookings too.
          { context: { $in: ['booking', 'pharmacy_order', 'lab_booking', 'instant_request', 'assisted_booking', 'assisted_lab_booking'] } },
          ...(rechargeSweepFrom() ? [{ context: 'wallet_recharge', 'notes.flow': 'pharmacy_wallet_recharge', createdAt: { $gte: rechargeSweepFrom()! } }] : []),
          // r13: lab top-ups always join (every one is new; none predates the sweep).
          { context: 'wallet_recharge', 'notes.flow': 'lab_wallet_recharge' },
        ] }],
    }).sort({ recoveryNextAt: 1, createdAt: 1 }).limit(limit).lean();
    let unsettled = 0;
    for (const r of records) {
      let settled = false;
      try {
        const out = await this.reconcilePaymentAndProcess({ paymentTransactionId: String(r._id), userId: String(r.payerUserId || r.userId) });
        settled = out.state === 'paid';
      } catch {
        settled = false;
      }
      if (!settled) {
        unsettled += 1;
        const checks = Number(r.recoveryChecks || 0) + 1;
        const delay = Math.min(24 * 3_600_000, 5 * 60_000 * 2 ** Math.min(checks - 1, 10));
        await PaymentRecordModel.updateOne({ _id: r._id }, { $set: { recoveryNextAt: new Date(now.getTime() + delay), recoveryChecks: checks } });
      }
    }
    return { checked: records.length, unsettled };
  }

  /**
   * P8: checks every unsettled Razorpay attempt of one pharmacy order with the gateway (as for bookings): a capture
   * whose confirmation never arrived is applied, or returned to the wallet when the order is closed or already paid.
   * `unknown` > 0 means some attempt could not be settled now: no payment may be offered meanwhile.
   */
  async reconcilePharmacyOrderPayments(orderId: string): Promise<{ checked: number; unknown: number }> {
    const records = await PaymentRecordModel.find({ context: 'pharmacy_order', contextId: { $eq: String(orderId) }, ...UNSETTLED_ATTEMPT })
      .sort({ createdAt: 1 }).lean();
    let unknown = 0;
    for (const r of records) {
      try {
        await this.reconcilePaymentAndProcess({ paymentTransactionId: String(r._id), userId: String(r.payerUserId || r.userId) });
      } catch (error) {
        logger.warn('[Payment][reconcile] pharmacy order attempt not settled', {
          orderId, paymentTransactionId: String(r._id), code: (error as { code?: string })?.code,
        });
        unknown += 1;
      }
    }
    return { checked: records.length, unknown };
  }

  /** P8: the payment was taken for exactly the order's current total (in paise). */
  private paymentCoversOrder(record: IPaymentRecord, order: IPharmacyOrder): boolean {
    // Only orders carrying a real total are checked; a legacy order without one keeps the previous behaviour.
    if (!(typeof order.grandTotal === 'number' && Number.isFinite(order.grandTotal) && order.grandTotal > 0)) return true;
    const recordPaise = Number.isFinite(Number(record.finalAmountPaise)) ? Number(record.finalAmountPaise) : Math.round(Number(record.finalAmount) * 100);
    const orderPaise = Number.isFinite(Number(order.grandTotalPaise)) ? Number(order.grandTotalPaise) : Math.round(order.grandTotal * 100);
    return Number.isFinite(recordPaise) && recordPaise === orderPaise;
  }

  /** P8: whether a captured payment would still be applied to this unpaid pharmacy order (else it is returned). */
  pharmacyPaymentWindowOpen(order: IPharmacyOrder): boolean {
    return !this.isPharmacyOrderPaymentWindowExpired(order);
  }

  /**
   * P8: the pharmacy order's linked, still-open Razorpay order, for "pay again" to reuse. Never a second Razorpay order
   * for the same pharmacy order: one order captures at most once, so reusing it cannot charge twice (late-capture
   * refunds are keyed per order). null when the linked record is not an open order for exactly the amount due.
   */
  async resumablePharmacyPayment(order: IPharmacyOrder): Promise<{
    paymentTransactionId: string; razorpayOrderId: string; razorpayKeyId: string; amount: number; currency: string;
    baseAmount: number; discountAmount: number;
  } | null> {
    if (!order.paymentTransactionId) return null;
    const r = await this.paymentRepository.findById(String(order.paymentTransactionId));
    if (!r || r.status !== 'created' || r.paymentGateway !== 'razorpay' || !r.razorpayOrderId) return null;
    if (r.context !== 'pharmacy_order' || String(r.contextId) !== String(order._id)) return null;
    const duePaise = Math.round(Number(order.grandTotal) * 100);
    const recordPaise = Number.isFinite(Number(r.finalAmountPaise)) ? Number(r.finalAmountPaise) : Math.round(Number(r.finalAmount) * 100);
    if (!(duePaise > 0) || recordPaise !== duePaise) return null;
    return {
      paymentTransactionId: String(r._id), razorpayOrderId: r.razorpayOrderId, razorpayKeyId: this.getRazorpayCredentials().keyId,
      amount: Number(r.finalAmount), currency: r.currency, baseAmount: Number(r.baseAmount), discountAmount: Number(r.discountAmount),
    };
  }

  /**
   * Checks EVERY unsettled Razorpay attempt of one booking with the gateway (W3b): a capture on any attempt (also an
   * older order replaced by retry-payment) is applied, or returned to the wallet if the booking is already paid or
   * closed (processVerifiedPayment). Each record is reconciled as its own payer. `unknown` counts attempts that
   * could not be settled now (gateway unreachable, concurrent change): the caller must not start another payment.
   */
  async reconcileBookingPayments(bookingId: string): Promise<{ checked: number; unknown: number }> {
    return this.reconcileContextPayments('booking', bookingId);
  }

  /** reconcileBookingPayments for any booking-like context (every unsettled attempt of one record, each as its own payer). */
  async reconcileContextPayments(context: PaymentContext, bookingId: string): Promise<{ checked: number; unknown: number }> {
    const records = await PaymentRecordModel.find({ context, contextId: { $eq: String(bookingId) }, ...UNSETTLED_ATTEMPT })
      .sort({ createdAt: 1 }).lean();
    let unknown = 0;
    for (const r of records) {
      try {
        await this.reconcilePaymentAndProcess({ paymentTransactionId: String(r._id), userId: String(r.payerUserId || r.userId) });
      } catch (error) {
        logger.warn('[Payment][reconcile] booking attempt not settled', {
          bookingId, paymentTransactionId: String(r._id), code: (error as { code?: string })?.code,
        });
        unknown += 1;
      }
    }
    return { checked: records.length, unknown };
  }

  async verifyPaymentAndProcess(data: VerifyPaymentRequest): Promise<{
    context: PaymentContext;
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
    // `module` is informational (S6): the stored record decides what is credited.
    const result = await this.processVerifiedPayment(paymentRecord);
    // S5 review: the capture was recorded and returned to the wallet (processBookingPayment); the payer is told why.
    if (result.context === 'booking' && result.paymentRecord.status === 'refunded') {
      const booking = await this.bookingRepository.findById(paymentRecord.contextId);
      if (booking?.specialistId && await doctorExistsIneligible(booking.specialistId)) {
        throw new AppError({ status: 400, code: 'SPECIALIST_NOT_VERIFIED',
          message: 'This doctor is not available for booking. Your payment was added to your wallet.' });
      }
    }
    return result;
  }

  /**
   * Everything after a payment record is known to be paid (verify, or reconciliation with the gateway): fulfil the
   * entity once. Shared so both paths apply exactly the same rules.
   */
  private async processVerifiedPayment(paymentRecord: IPaymentRecord): Promise<{
    context: PaymentContext;
    paymentRecord: IPaymentRecord;
    entity: unknown;
  }> {
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
      return this.buildAlreadyProcessedResponse(paymentRecord);
    }

    if (this.shouldFulfillExternalBooking(paymentRecord)) {
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
        // Q16a re-review (N7): the customer booking view (no desk internals, settlement account or request keys).
        entity: publicNoShowView(result.entity),
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

    const contextHandler = CONTEXT_HANDLERS.get(paymentRecord.context);
    if (contextHandler) {
      const result = await contextHandler.process(paymentRecord, {
        finalize: (r) => this.finalizePaymentProcessing(r),
        markReturned: async (r) => ((await this.paymentRepository.update({ _id: r._id! }, { status: 'refunded', isProcessed: true })) || r) as IPaymentRecord,
      });
      return { context: paymentRecord.context, paymentRecord: result.paymentRecord, entity: result.entity };
    }

    throw new AppError({
      status: 400,
      code: 'UNSUPPORTED_PAYMENT_CONTEXT',
      message: 'Unsupported payment context',
    });
  }
}
