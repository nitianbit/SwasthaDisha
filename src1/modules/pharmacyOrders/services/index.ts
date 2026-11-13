import { Service } from 'typedi';
import { ClientSession, startSession, Types } from 'mongoose';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacyCustomerService } from '@/modules/pharmacyCustomers/services';
import { InventoryService } from '@/modules/pharmacyInventory/services';
import { PaymentService } from '@/modules/payment/services';
import { BookingRepository } from '@/modules/bookings/repository';
import { ExternalBookingRepository } from '@/modules/externalBookings/repository';
import { PharmacyOrderSideEffectService } from '@/modules/pharmacyOrders/services/sideEffects';
import { MedicineRepository } from '@/modules/pharmacyMedicines/repository';
import {
  IPharmacyOrder,
  PharmacyRecoveryReceipt,
  PharmacyRecoveryWorklistPage,
  IOrderItem,
  CreateOrderRequest,
  MarkOrderPaidRequest,
  UpdateOrderRequest,
  UpdateOrderStatusRequest,
  OrderQueryParams,
  OrderStatus,
  PrescriptionReview,
  PrescriptionReviewRequest,
} from '@/modules/pharmacyOrders/types';
import { AppError } from '@/modules/common/types';
import { assertPrescriptionCommerceAvailable } from '@/modules/pharmacyOrders/prescriptionCommerce';
import { createHash } from 'node:crypto';

/** Fingerprint of the exact ordered document list a pharmacist reviewed (bounded evidence, any list size). */
export function prescriptionDocumentSetSha256(urls: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(urls)).digest('hex');
}
import logger from '@/services/logger';

const TERMINAL_STATUSES: OrderStatus[] = ['completed', 'abandoned', 'cancelled', 'rejected'];
const PRESCRIPTION_GATED_STATUSES: OrderStatus[] = [
  'packed',
  'ready_for_pickup',
  'out_for_delivery',
  'completed',
];
const UNPAID_ORDER_ABANDON_WINDOW_MS = 35 * 60 * 1000;
const ALLOWED_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  placed: ['accepted', 'rejected', 'cancelled', 'abandoned'],
  accepted: ['packed', 'cancelled'],
  packed: ['ready_for_pickup', 'out_for_delivery', 'cancelled'],
  ready_for_pickup: ['completed'],
  out_for_delivery: ['completed'],
  completed: [],
  abandoned: [],
  cancelled: [],
  rejected: [],
};

type PricedOrderItem = CreateOrderRequest['items'][number] & {
  unitPrice: number;
  medicineName: string;
  hsnCode?: string;
  gstPercent: number;
  prescriptionRequired: boolean | undefined;
};
type NonPrescriptionOrderItem = PricedOrderItem & { prescriptionRequired: false };

function computeTotals(items: NonPrescriptionOrderItem[]) {
  let subtotalPaise = 0;
  let discountTotalPaise = 0;
  let taxTotalPaise = 0;
  const computed = items.map((item) => {
    const unitPricePaise = Math.round(item.unitPrice * 100);
    const lineSubtotalPaise = unitPricePaise * item.orderedQty;
    const discountPaise = Math.round((item.discount ?? 0) * 100);
    if (discountPaise > lineSubtotalPaise) {
      throw new AppError({
        status: 400,
        code: 'INVALID_ITEM_DISCOUNT',
        message: `Discount cannot exceed subtotal for medicine ${item.medicineId}`,
      });
    }
    const lineTotalPaise = lineSubtotalPaise - discountPaise;
    // Inventory prices are treated as GST-inclusive to preserve current payable totals.
    const taxPaise = item.gstPercent > 0
      ? Math.round((lineTotalPaise * item.gstPercent) / (100 + item.gstPercent))
      : 0;
    subtotalPaise += lineSubtotalPaise;
    discountTotalPaise += discountPaise;
    taxTotalPaise += taxPaise;
    return {
      medicineId: item.medicineId,
      medicineName: item.medicineName,
      orderedQty: item.orderedQty,
      reservedQty: item.orderedQty,
      billedQty: 0,
      freeQty: item.freeQty ?? 0,
      unitPrice: item.unitPrice,
      discount: discountPaise / 100,
      lineTotal: lineTotalPaise / 100,
      hsnCode: item.hsnCode,
      gstPercent: item.gstPercent,
      taxAmount: taxPaise / 100,
      unitPricePaise,
      discountPaise,
      taxPaise,
      lineTotalPaise,
      prescriptionRequired: item.prescriptionRequired,
      recurring: item.recurring ?? false,
      subscriptionFrequency: item.subscriptionFrequency,
      subscriptionIntervalDays: item.subscriptionIntervalDays,
      subscriptionNextRefillDate: item.subscriptionNextRefillDate,
      subscriptionReminderChannel: item.subscriptionReminderChannel,
      itemStatus: 'active' as const,
    };
  });
  const grandTotalPaise = subtotalPaise - discountTotalPaise;
  return {
    items: computed,
    subtotal: subtotalPaise / 100,
    discountTotal: discountTotalPaise / 100,
    taxTotal: taxTotalPaise / 100,
    grandTotal: grandTotalPaise / 100,
    subtotalPaise,
    discountTotalPaise,
    taxTotalPaise,
    grandTotalPaise,
  };
}

@Service()
export class PharmacyOrderService {
  constructor(
    private orderRepo: PharmacyOrderRepository,
    private customerService: PharmacyCustomerService,
    private inventoryService: InventoryService,
    private paymentService: PaymentService,
    private bookingRepository: BookingRepository,
    private externalBookingRepository: ExternalBookingRepository,
    private sideEffectService: PharmacyOrderSideEffectService,
    private medicineRepository: MedicineRepository
  ) {}

  private buildInventoryItems(items: Array<{ medicineId: string; orderedQty: number }>) {
    return items.map((item) => ({
      medicineId: String(item.medicineId),
      quantity: item.orderedQty,
    }));
  }

  private buildInventoryDelta(
    previousItems: Array<{ medicineId: unknown; orderedQty: number; itemStatus?: string }>,
    nextItems: Array<{ medicineId: unknown; orderedQty: number; itemStatus?: string }>
  ): {
    toConsume: Array<{ medicineId: string; quantity: number }>;
    toReturn: Array<{ medicineId: string; quantity: number }>;
  } {
    const previousMap = new Map<string, number>();
    const nextMap = new Map<string, number>();

    for (const item of previousItems) {
      if (item.itemStatus && item.itemStatus !== 'active') {
        continue;
      }
      const medicineId = String(item.medicineId);
      previousMap.set(medicineId, (previousMap.get(medicineId) || 0) + item.orderedQty);
    }

    for (const item of nextItems) {
      if (item.itemStatus && item.itemStatus !== 'active') {
        continue;
      }
      const medicineId = String(item.medicineId);
      nextMap.set(medicineId, (nextMap.get(medicineId) || 0) + item.orderedQty);
    }

    const medicineIds = new Set([...previousMap.keys(), ...nextMap.keys()]);
    const toConsume: Array<{ medicineId: string; quantity: number }> = [];
    const toReturn: Array<{ medicineId: string; quantity: number }> = [];

    for (const medicineId of medicineIds) {
      const previousQty = previousMap.get(medicineId) || 0;
      const nextQty = nextMap.get(medicineId) || 0;

      if (nextQty > previousQty) {
        toConsume.push({ medicineId, quantity: nextQty - previousQty });
      } else if (previousQty > nextQty) {
        toReturn.push({ medicineId, quantity: previousQty - nextQty });
      }
    }

    return { toConsume, toReturn };
  }

  private async applyInventoryDelta(
    pharmacyId: string,
    delta: {
      toConsume: Array<{ medicineId: string; quantity: number }>;
      toReturn: Array<{ medicineId: string; quantity: number }>;
    },
    session?: ClientSession
  ): Promise<void> {
    if (delta.toConsume.length) {
      await this.inventoryService.consumeAvailableStockBulk(pharmacyId, delta.toConsume, session);
    }

    if (delta.toReturn.length) {
      try {
        await this.inventoryService.returnStockBulk(pharmacyId, delta.toReturn, session);
      } catch (error) {
        if (delta.toConsume.length) {
          await this.inventoryService.returnStockBulk(pharmacyId, delta.toConsume, session).catch(() => undefined);
        }
        throw error;
      }
    }
  }

  private async releaseOrderInventory(
    pharmacyId: string,
    items: IOrderItem[],
    session: ClientSession
  ): Promise<void> {
    const batchItems = items
      .filter((item) => item.itemStatus === 'active' && item.batchAllocations?.length)
      .map((item) => ({
        medicineId: String(item.medicineId),
        batchAllocations: item.batchAllocations,
      }));
    if (batchItems.length) {
      await this.inventoryService.releaseOrderStockBulk(pharmacyId, batchItems, session);
    }

    const legacyItems = items
      .filter((item) => item.itemStatus === 'active' && !item.batchAllocations?.length)
      .map((item) => ({ medicineId: String(item.medicineId), quantity: item.orderedQty }));
    if (legacyItems.length) {
      await this.inventoryService.returnStockBulk(pharmacyId, legacyItems, session);
    }
  }

  private async consumeOrderInventory(
    pharmacyId: string,
    items: IOrderItem[],
    session: ClientSession
  ): Promise<void> {
    const batchItems = items
      .filter((item) => item.itemStatus === 'active' && item.batchAllocations?.length)
      .map((item) => ({
        medicineId: String(item.medicineId),
        batchAllocations: item.batchAllocations,
      }));
    if (batchItems.length) {
      await this.inventoryService.consumeOrderReservedStockBulk(pharmacyId, batchItems, session);
    }
  }

  private async runOrderInventoryTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(async () => {
        result = await work(session);
      });

      if (result === undefined) {
        throw new AppError({
          status: 500,
          code: 'ORDER_INVENTORY_TRANSACTION_FAILED',
          message: 'Failed to complete order and inventory update',
        });
      }

      return result;
    } finally {
      await session.endSession();
    }
  }

  // Compensation for payment-setup failures after the order/stock transaction
  // committed: keep the order visible as abandoned and return its stock in one
  // transaction. Best-effort — if this also fails, the stale-unpaid-order
  // sweep (abandonStaleUnpaidOrders) picks the order up later.
  private async abandonOrderAfterPaymentSetupFailure(
    pharmacyId: string,
    order: IPharmacyOrder,
    _inventoryItems: Array<{ medicineId: string; quantity: number }>
  ): Promise<void> {
    const failureNote = 'Payment setup failed; order was abandoned and stock returned automatically';
    const priorNotes = order.notes?.trim();

    await this.runOrderInventoryTransaction(async (session) => {
      const updated = await this.orderRepo.update(
        { _id: order._id, status: 'placed' },
        {
          status: 'abandoned',
          paymentStatus: 'failed',
          notes: priorNotes ? `${priorNotes}\n${failureNote}` : failureNote,
        },
        { new: true, session }
      );

      if (updated && order.items.length) {
        await this.releaseOrderInventory(pharmacyId, order.items, session);
      }

      return updated ?? order;
    }).catch(() => undefined);
  }

  private hasRecurringItems(
    items: Array<{
      recurring?: boolean;
    }>
  ): boolean {
    return items.some((item) => item.recurring);
  }

  private generateOrderNumber(): string {
    const now = new Date();
    const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
      now.getDate()
    ).padStart(2, '0')}`;
    const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `PO-${datePart}-${randomPart}`;
  }

  private resolvePaymentPayer(data: {
    customerId?: string;
    buyerPharmacyId?: string;
    createdById: string;
  }): { payerUserId: string; payerPharmacyId?: string } {
    if (data.customerId) {
      return {
        payerUserId: data.customerId,
      };
    }

    return {
      payerUserId: data.createdById,
      payerPharmacyId: data.buyerPharmacyId,
    };
  }

  private validateOrderParty(data: CreateOrderRequest): void {
    const hasCustomer = Boolean(data.customerId);
    const hasBuyerPharmacy = Boolean(data.buyerPharmacyId);

    if (!hasCustomer && !hasBuyerPharmacy) {
      throw new AppError({
        status: 400,
        code: 'ORDER_PARTY_REQUIRED',
        message: 'Either customerId or buyerPharmacyId is required',
      });
    }

    if (hasCustomer && hasBuyerPharmacy) {
      throw new AppError({
        status: 400,
        code: 'MULTIPLE_ORDER_PARTIES_NOT_ALLOWED',
        message: 'Provide either customerId or buyerPharmacyId, not both',
      });
    }
  }

  private ensureLinkedOrderAllowed(data: {
    customerId?: string;
    buyerPharmacyId?: string;
    linkedConsultationId?: string;
    linkedDiagnosticOrderId?: string;
  }): void {
    if (data.buyerPharmacyId && (data.linkedConsultationId || data.linkedDiagnosticOrderId)) {
      throw new AppError({
        status: 400,
        code: 'LINKED_ORDER_REQUIRES_USER',
        message: 'Consultation or diagnostic linked orders require customerId, not buyerPharmacyId',
      });
    }
  }

  private async validateLinkedReferences(
    customerId: string | undefined,
    data: Pick<CreateOrderRequest, 'linkedConsultationId' | 'linkedDiagnosticOrderId'>
  ): Promise<void> {
    if (data.linkedConsultationId) {
      const consultation = await this.bookingRepository.findById(data.linkedConsultationId);
      if (!consultation || consultation.bookingType !== 'consultation') {
        throw new AppError({
          status: 404,
          code: 'CONSULTATION_NOT_FOUND',
          message: 'Consultation booking not found',
        });
      }
      if (customerId && String(consultation.userId) !== String(customerId)) {
        throw new AppError({
          status: 400,
          code: 'CONSULTATION_USER_MISMATCH',
          message: 'Consultation booking must belong to the same user as the pharmacy order',
        });
      }
    }

    if (data.linkedDiagnosticOrderId) {
      const diagnosticBooking = await this.externalBookingRepository.findById(data.linkedDiagnosticOrderId);
      if (!diagnosticBooking || diagnosticBooking.appointmentType !== 'diagnostics') {
        throw new AppError({
          status: 404,
          code: 'DIAGNOSTIC_BOOKING_NOT_FOUND',
          message: 'Diagnostic booking not found',
        });
      }
      if (customerId && String(diagnosticBooking.userId) !== String(customerId)) {
        throw new AppError({
          status: 400,
          code: 'DIAGNOSTIC_USER_MISMATCH',
          message: 'Diagnostic booking must belong to the same user as the pharmacy order',
        });
      }
    }
  }

  private async resolveOrderItemsPricing(
    pharmacyId: string,
    buyerPharmacyId: string | undefined,
    items: CreateOrderRequest['items'],
    allowPriceOverride = true
  ): Promise<PricedOrderItem[]> {
    const pricedItems: PricedOrderItem[] = [];

    for (const item of items) {
      const inventoryItem = await this.inventoryService.getInventoryByMedicine(pharmacyId, item.medicineId);
      const medicine = await this.medicineRepository.findById(item.medicineId);
      if (!medicine || medicine.isActive === false || medicine.archivedAt) {
        throw new AppError({
          status: 404,
          code: 'MEDICINE_NOT_AVAILABLE',
          message: `Medicine ${item.medicineId} is not available`,
        });
      }
      const preferredPrice =
        buyerPharmacyId ? inventoryItem.wholesalePrice : inventoryItem.retailPrice;
      const fallbackPrice =
        buyerPharmacyId ? inventoryItem.retailPrice : inventoryItem.wholesalePrice;
      const unitPrice = allowPriceOverride && item.unitPrice !== undefined
        ? item.unitPrice
        : preferredPrice ?? fallbackPrice;

      if (unitPrice === undefined) {
        throw new AppError({
          status: 400,
          code: 'PRICE_NOT_AVAILABLE',
          message: `Price not available in inventory for medicine ${item.medicineId}`,
        });
      }

      pricedItems.push({
        ...item,
        medicineName: medicine.name,
        unitPrice,
        hsnCode: medicine.hsnCode,
        gstPercent: medicine.gstPercent ?? 0,
        prescriptionRequired: medicine.prescriptionRequired,
      });
    }

    return pricedItems;
  }

  private assertNewCommerceForOrder(order: IPharmacyOrder, expectedOrderId: string): Promise<void> {
    return assertPrescriptionCommerceAvailable({
      kind: 'stored_order',
      order,
      expectedOrderId,
      readMedicines: ids => this.medicineRepository.findAll(
        { _id: { $in: ids } },
        { select: '_id prescriptionRequired isActive archivedAt' }
      ),
    });
  }

  private assertUniqueMedicines(items: CreateOrderRequest['items']): void {
    const seen = new Set<string>();
    for (const item of items) {
      const medicineId = String(item.medicineId);
      if (seen.has(medicineId)) {
        throw new AppError({
          status: 400,
          code: 'DUPLICATE_ORDER_MEDICINE',
          message: `Medicine ${medicineId} can appear only once in an order`,
        });
      }
      seen.add(medicineId);
    }
  }

  private assertPrescriptionProvided(
    items: PricedOrderItem[],
    prescriptionUrls?: string[]
  ): 'not_required' | 'pending' {
    const required = items.filter((item) => item.prescriptionRequired);
    if (required.length && !prescriptionUrls?.length) {
      throw new AppError({
        status: 422,
        code: 'PRESCRIPTION_REQUIRED',
        message: `Prescription is required for one or more medicines: ${required
          .map((item) => item.medicineName)
          .join(', ')}`,
      });
    }
    return required.length ? 'pending' : 'not_required';
  }

  private async queueSubscriptionSyncSafely(
    orderId: string,
    trigger:
      | 'order_created'
      | 'order_updated'
      | 'payment_completed'
      | 'status_changed'
      | 'order_marked_paid'
      | 'order_abandoned'
  ): Promise<void> {
    try {
      await this.sideEffectService.queueSubscriptionSync(orderId, trigger);
    } catch (error) {
      logger.error('Failed to queue pharmacy order subscription sync', {
        orderId,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async queueNotificationSafely(
    orderId: string,
    trigger:
      | 'order_created'
      | 'order_updated'
      | 'payment_completed'
      | 'status_changed'
      | 'order_marked_paid'
      | 'order_abandoned'
  ): Promise<void> {
    try {
      await this.sideEffectService.queueNotification(orderId, trigger);
    } catch (error) {
      logger.error('Failed to queue pharmacy order notification', {
        orderId,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async create(
    pharmacyId: string,
    data: CreateOrderRequest,
    createdById: string,
    createdByRole: string,
    options: { allowPriceOverride?: boolean } = {}
  ): Promise<{
    order: IPharmacyOrder;
    paymentRequired: boolean;
    payment?: {
      paymentTransactionId: string;
      razorpayOrderId?: string;
      razorpayKeyId?: string;
      amount: number;
      currency: string;
      baseAmount: number;
      discountAmount: number;
    };
  }> {
    this.validateOrderParty(data);
    this.assertUniqueMedicines(data.items);

    const recurringItems = data.items.filter((item) => item.recurring);
    if (recurringItems.length && !data.customerId) {
      throw new AppError({
        status: 400,
        code: 'CUSTOMER_ID_REQUIRED_FOR_SUBSCRIPTION',
        message: 'customerId is required when recurring items are included',
      });
    }

    await this.validateLinkedReferences(data.customerId, data);
    this.ensureLinkedOrderAllowed(data);

    const pricedItems = await this.resolveOrderItemsPricing(
      pharmacyId,
      data.buyerPharmacyId,
      data.items,
      options.allowPriceOverride ?? true
    );
    await assertPrescriptionCommerceAvailable({
      kind: 'new_items',
      items: pricedItems,
      prescriptionUrls: data.prescriptionUrls,
    });
    // Only explicit canonical false values survive the shared guard.
    const admittedItems = pricedItems as NonPrescriptionOrderItem[];
    if (data.customerId) {
      await this.customerService.ensureLinked(
        pharmacyId,
        data.customerId,
        createdById,
        createdByRole
      );
    }

    const { payerUserId, payerPharmacyId } = this.resolvePaymentPayer({
      customerId: data.customerId,
      buyerPharmacyId: data.buyerPharmacyId,
      createdById,
    });
    const prescriptionStatus = this.assertPrescriptionProvided(admittedItems, data.prescriptionUrls);
    const {
      items,
      subtotal,
      discountTotal,
      taxTotal,
      grandTotal,
      subtotalPaise,
      discountTotalPaise,
      taxTotalPaise,
      grandTotalPaise,
    } = computeTotals(admittedItems);
    const inventoryItems = this.buildInventoryItems(items);

    // Create the order and consume stock as one unit: either both are
    // committed or neither is, so no orphan order or lost stock on failure.
    const savedOrder = await this.runOrderInventoryTransaction(async (session) => {
      const allocations = await this.inventoryService.reserveOrderStockBulk(
        pharmacyId,
        inventoryItems,
        session
      );
      const reservedItems = items.map((item) => ({
        ...item,
        batchAllocations: allocations.get(String(item.medicineId)) || [],
      }));
      const created = await this.orderRepo.save(
        {
          orderNumber: this.generateOrderNumber(),
          pharmacyId,
          orderType: data.orderType,
          status: 'placed',
          customerId: data.customerId,
          buyerPharmacyId: data.buyerPharmacyId,
          createdById,
          createdByRole,
          items: reservedItems,
          subtotal,
          discountTotal,
          taxTotal,
          grandTotal,
          subtotalPaise,
          discountTotalPaise,
          taxTotalPaise,
          grandTotalPaise,
          paymentMode: data.paymentMode,
          paymentStatus: grandTotal <= 0 ? 'paid' : 'pending',
          deliveryMode: data.deliveryMode,
          deliveryAddress: data.deliveryAddress,
          isWalkIn: data.isWalkIn ?? false,
          prescriptionUrls: data.prescriptionUrls ?? [],
          prescriptionStatus,
          notes: data.notes,
          linkedConsultationId: data.linkedConsultationId,
          linkedDiagnosticOrderId: data.linkedDiagnosticOrderId,
        },
        { session }
      );

      return created;
    });

    let order = savedOrder;

    if (grandTotal <= 0) {
      let paymentRecord;
      try {
        paymentRecord = await this.paymentService.createDirectPaidTransaction({
          userId: createdById,
          payerUserId,
          payerPharmacyId,
          context: 'pharmacy_order',
          contextId: String(savedOrder._id),
          baseAmount: subtotal,
          discountAmount: discountTotal,
          finalAmount: 0,
          notes: {
            reason: 'zero_payable_amount',
            orderChannel: savedOrder.orderType,
            orderType: savedOrder.orderType,
          },
        });
      } catch (error) {
        await this.abandonOrderAfterPaymentSetupFailure(pharmacyId, savedOrder, inventoryItems);
        throw error;
      }

      const paidOrder = await this.orderRepo.update(
        { _id: savedOrder._id },
        {
          status: 'accepted',
          paymentStatus: 'paid',
          paymentTransactionId: paymentRecord._id!,
        }
      );
      order = paidOrder || order;

      await this.queueNotificationSafely(String(order._id), 'order_created');
      if (data.customerId && recurringItems.length) {
        await this.queueSubscriptionSyncSafely(String(order._id), 'payment_completed');
      }

      return {
        order,
        paymentRequired: false,
        payment: {
          paymentTransactionId: paymentRecord._id!,
          amount: 0,
          currency: paymentRecord.currency,
          baseAmount: subtotal,
          discountAmount: discountTotal,
        },
      };
    }

    if (data.paymentMode === 'online_payment') {
      let createdPaymentOrder;
      try {
        createdPaymentOrder = await this.paymentService.createOrder({
          userId: createdById,
          payerUserId,
          payerPharmacyId,
          context: 'pharmacy_order',
          contextId: String(savedOrder._id),
          baseAmount: subtotal,
          discountAmount: discountTotal,
          finalAmount: grandTotal,
          notes: {
            orderChannel: savedOrder.orderType,
            orderType: savedOrder.orderType,
            pharmacyId,
          },
        });
      } catch (error) {
        await this.abandonOrderAfterPaymentSetupFailure(pharmacyId, savedOrder, inventoryItems);
        throw error;
      }

      const orderWithPayment = await this.orderRepo.update(
        { _id: savedOrder._id },
        { paymentTransactionId: createdPaymentOrder.paymentRecord._id! }
      );
      order = orderWithPayment || order;

      await this.queueNotificationSafely(String(order._id), 'order_created');

      return {
        order,
        paymentRequired: true,
        payment: {
          paymentTransactionId: createdPaymentOrder.paymentRecord._id!,
          razorpayOrderId: createdPaymentOrder.razorpayOrder.id,
          razorpayKeyId: createdPaymentOrder.razorpayKeyId,
          amount: grandTotal,
          currency: createdPaymentOrder.razorpayOrder.currency,
          baseAmount: subtotal,
          discountAmount: discountTotal,
        },
      };
    }

    await this.queueNotificationSafely(String(order._id), 'order_created');

    return {
      order,
      paymentRequired: false,
    };
  }

  private async customerRecovery(actor: unknown, id: unknown, create: boolean): Promise<PharmacyRecoveryReceipt | null> {
    if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
      throw new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Authentication is required' });
    }
    const principal = actor as Record<string, unknown>;
    if (principal.userType !== 'user') {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Individual customer access is required' });
    }
    const customerId = principal._id;
    if (typeof customerId !== 'string' || !/^[0-9a-f]{24}$/.test(customerId)) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
    if (typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id)) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid pharmacy order ID' });
    }
    const session = await startSession();
    const attempt: { candidate: PharmacyRecoveryReceipt | null | undefined; completed: boolean; transaction: unknown } = {
      candidate: undefined, completed: false, transaction: undefined,
    };
    try {
      // Driver4 withTransaction returns the commit response, never this callback's DTO.
      await session.withTransaction(async () => {
        attempt.candidate = undefined;
        attempt.completed = false;
        attempt.transaction = undefined;
        attempt.candidate = create
          ? await this.orderRepo.requestCustomerRecovery(id, customerId, session)
          : await this.orderRepo.getCustomerRecovery(id, customerId, session);
        attempt.transaction = (session as unknown as { transaction?: unknown }).transaction;
        attempt.completed = true;
      }, { readConcern: { level: 'snapshot' } });
      const transaction = (session as unknown as { transaction?: { state?: unknown } }).transaction;
      if (!attempt.completed || attempt.candidate === undefined || transaction !== attempt.transaction || transaction?.state !== 'TRANSACTION_COMMITTED') {
        throw new AppError({ status: 503, code: 'PHARMACY_RECOVERY_UNAVAILABLE', message: 'Pharmacy recovery is unavailable' });
      }
      return attempt.candidate;
    } finally {
      await session.endSession();
    }
  }

  async requestCustomerRecovery(actor: unknown, id: unknown): Promise<PharmacyRecoveryReceipt> {
    const receipt = await this.customerRecovery(actor, id, true);
    if (!receipt) throw new AppError({ status: 503, code: 'PHARMACY_RECOVERY_UNAVAILABLE', message: 'Pharmacy recovery is unavailable' });
    return receipt;
  }

  async getCustomerRecovery(actor: unknown, id: unknown): Promise<PharmacyRecoveryReceipt | null> {
    return this.customerRecovery(actor, id, false);
  }

  async getRecoveryRequests(pharmacyId: unknown, query: unknown): Promise<PharmacyRecoveryWorklistPage> {
    return this.orderRepo.findRecoveryRequests(pharmacyId, query);
  }

  async getById(id: string, requesterId: string, requesterRole: string): Promise<IPharmacyOrder> {
    const order = await this.orderRepo.findById(id);
    if (!order) {
      throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    }

    const isAdmin = requesterRole === 'admin';
    const isPharmacy = requesterRole === 'pharmacy' && String(order.pharmacyId) === requesterId;
    const isBuyerPharmacy =
      requesterRole === 'pharmacy' && String(order.buyerPharmacyId) === requesterId;
    const isCustomer = requesterRole === 'user' && String(order.customerId) === requesterId;

    if (!isAdmin && !isPharmacy && !isBuyerPharmacy && !isCustomer) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }

    return order;
  }

  async getAll(
    filter: OrderQueryParams,
    page = 1,
    limit = 20,
    requesterRole: string,
    requesterId: string
  ): Promise<{ data: IPharmacyOrder[]; total: number; page: number; totalPages: number }> {
    if (requesterRole === 'pharmacy') {
      filter.viewerPharmacyId = requesterId;
      delete filter.pharmacyId;
    } else if (requesterRole === 'user') {
      filter.customerId = requesterId;
      delete filter.pharmacyId;
      delete filter.buyerPharmacyId;
      delete filter.viewerPharmacyId;
    } else if (requesterRole !== 'admin') {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }

    return this.orderRepo.findWithPagination(filter, page, limit);
  }

  async update(id: string, pharmacyId: string, data: UpdateOrderRequest): Promise<IPharmacyOrder> {
    if (typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id)) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid pharmacy order ID' });
    }
    const order = await this.orderRepo.findById(id);
    if (!order) {
      throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    }
    if (
      typeof pharmacyId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(pharmacyId) ||
      String(order.pharmacyId) !== pharmacyId
    ) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
    if (TERMINAL_STATUSES.includes(order.status)) {
      throw new AppError({ status: 400, code: 'ORDER_TERMINAL', message: 'Cannot update a completed/cancelled order' });
    }

    const partyFields = ['customerId', 'buyerPharmacyId', 'orderType'] as const;
    const changesOrderParty = partyFields.some((field) => Object.prototype.hasOwnProperty.call(data, field));
    if (changesOrderParty && Object.prototype.hasOwnProperty.call(order, 'recoveryRequest')) {
      throw new AppError({
        status: 409,
        code: 'ORDER_RECOVERY_PARTY_LOCKED',
        message: 'Order party details are locked after a recovery request',
      });
    }

    const financialFields: Array<keyof UpdateOrderRequest> = [
      'orderType',
      'customerId',
      'buyerPharmacyId',
      'items',
      'deliveryAddress',
      'paymentMode',
      'deliveryMode',
      'isWalkIn',
      'linkedConsultationId',
      'linkedDiagnosticOrderId',
    ];
    const changesFinancialData = financialFields.some((field) => data[field] !== undefined);
    const financialEditAllowed =
      order.status === 'placed' &&
      order.paymentStatus === 'pending' &&
      !order.paymentTransactionId;
    if (changesFinancialData && !financialEditAllowed) {
      throw new AppError({
        status: 409,
        code: 'ORDER_FINANCIALS_LOCKED',
        message: 'Order items and financial details are locked after payment initiation or order acceptance',
      });
    }

    const enrichesCommerce = Reflect.ownKeys(data).some(key => key !== 'notes');
    if (enrichesCommerce) {
      await this.assertNewCommerceForOrder(order, id);
      if (!data.items) {
        await assertPrescriptionCommerceAvailable({
          kind: 'new_items',
          items: order.items,
          prescriptionUrls: data.prescriptionUrls !== undefined ? data.prescriptionUrls : order.prescriptionUrls,
        });
      }
    }

    const nextCustomerId =
      data.customerId !== undefined
        ? data.customerId
        : order.customerId
          ? String(order.customerId)
          : undefined;
    const nextBuyerPharmacyId =
      data.buyerPharmacyId !== undefined
        ? data.buyerPharmacyId
        : order.buyerPharmacyId
          ? String(order.buyerPharmacyId)
          : undefined;
    const nextOrderType = data.orderType ?? order.orderType;
    const hasExistingRecurring = this.hasRecurringItems(order.items);
    const hasRequestedRecurring = data.items ? this.hasRecurringItems(data.items) : false;

    if (hasRequestedRecurring && !nextCustomerId) {
      throw new AppError({
        status: 400,
        code: 'CUSTOMER_ID_REQUIRED_FOR_SUBSCRIPTION',
        message: 'customerId is required when recurring items are included',
      });
    }

    this.validateOrderParty({
      orderType: nextOrderType,
      customerId: nextCustomerId,
      buyerPharmacyId: nextBuyerPharmacyId,
      items:
        data.items ||
        order.items.map((item) => ({
          medicineId: String(item.medicineId),
          medicineName: item.medicineName,
          orderedQty: item.orderedQty,
          unitPrice: item.unitPrice,
          discount: item.discount,
          freeQty: item.freeQty,
          recurring: item.recurring,
          subscriptionFrequency: item.subscriptionFrequency,
          subscriptionIntervalDays: item.subscriptionIntervalDays,
          subscriptionNextRefillDate: item.subscriptionNextRefillDate,
          subscriptionReminderChannel: item.subscriptionReminderChannel,
        })),
    });

    const nextLinkedConsultationId =
      data.linkedConsultationId !== undefined
        ? data.linkedConsultationId
        : order.linkedConsultationId
          ? String(order.linkedConsultationId)
          : undefined;
    const nextLinkedDiagnosticOrderId =
      data.linkedDiagnosticOrderId !== undefined
        ? data.linkedDiagnosticOrderId
        : order.linkedDiagnosticOrderId;

    await this.validateLinkedReferences(nextCustomerId, {
      linkedConsultationId: nextLinkedConsultationId,
      linkedDiagnosticOrderId: nextLinkedDiagnosticOrderId,
    });
    this.ensureLinkedOrderAllowed({
      customerId: nextCustomerId,
      buyerPharmacyId: nextBuyerPharmacyId,
      linkedConsultationId: nextLinkedConsultationId,
      linkedDiagnosticOrderId: nextLinkedDiagnosticOrderId,
    });

    let updatePayload: Record<string, unknown> = {
      ...data,
      ...(Object.prototype.hasOwnProperty.call(data, 'customerId') ? { customerId: nextCustomerId } : {}),
      ...(Object.prototype.hasOwnProperty.call(data, 'buyerPharmacyId') ? { buyerPharmacyId: nextBuyerPharmacyId } : {}),
      ...(Object.prototype.hasOwnProperty.call(data, 'orderType') ? { orderType: nextOrderType } : {}),
    };

    const shouldRepriceItems = Boolean(data.items);

    if (shouldRepriceItems) {
      const incomingItems = data.items as CreateOrderRequest['items'];
      this.assertUniqueMedicines(incomingItems);
      const pricedItems = await this.resolveOrderItemsPricing(
        pharmacyId,
        nextBuyerPharmacyId,
        incomingItems
      );
      const nextPrescriptionUrls = data.prescriptionUrls !== undefined ? data.prescriptionUrls : order.prescriptionUrls;
      await assertPrescriptionCommerceAvailable({
        kind: 'new_items',
        items: pricedItems,
        prescriptionUrls: nextPrescriptionUrls,
      });
      const admittedItems = pricedItems as NonPrescriptionOrderItem[];
      const totals = computeTotals(admittedItems);
      const prescriptionStatus = this.assertPrescriptionProvided(admittedItems, nextPrescriptionUrls);
      updatePayload = {
        ...updatePayload,
        items: totals.items,
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        taxTotal: totals.taxTotal,
        grandTotal: totals.grandTotal,
        subtotalPaise: totals.subtotalPaise,
        discountTotalPaise: totals.discountTotalPaise,
        taxTotalPaise: totals.taxTotalPaise,
        grandTotalPaise: totals.grandTotalPaise,
        prescriptionStatus,
      };
    } else if (
      data.prescriptionUrls !== undefined &&
      order.items.some((item) => item.prescriptionRequired) &&
      data.prescriptionUrls.length === 0
    ) {
      throw new AppError({
        status: 422,
        code: 'PRESCRIPTION_REQUIRED',
        message: 'Prescription is required for one or more medicines',
      });
    }

    if (nextCustomerId && String(order.customerId || '') !== nextCustomerId) {
      await this.customerService.ensureLinked(pharmacyId, nextCustomerId, pharmacyId, 'pharmacy');
    }

    const nextItemsForInventory = (updatePayload.items as IPharmacyOrder['items'] | undefined) || order.items;
    const usesBatchReservations = order.items.some((item) => item.batchAllocations?.length);
    const inventoryDelta = shouldRepriceItems && !usesBatchReservations
      ? this.buildInventoryDelta(order.items, nextItemsForInventory)
      : { toConsume: [], toReturn: [] };

    const updateFilter = {
      _id: new Types.ObjectId(id),
      pharmacyId: { $eq: new Types.ObjectId(pharmacyId) },
      $expr: { $and: [
        { $eq: [{ $type: '$_id' }, 'objectId'] },
        { $eq: [{ $type: '$pharmacyId' }, 'objectId'] },
      ] },
      ...(changesOrderParty ? { recoveryRequest: { $exists: false } } : {}),
    };

    try {
      const updated = await this.runOrderInventoryTransaction(async (session) => {
        if (shouldRepriceItems && usesBatchReservations) {
          await this.releaseOrderInventory(pharmacyId, order.items, session);
          const nextItems = updatePayload.items as IOrderItem[];
          const allocations = await this.inventoryService.reserveOrderStockBulk(
            pharmacyId,
            this.buildInventoryItems(nextItems),
            session
          );
          updatePayload.items = nextItems.map((item) => ({
            ...item,
            reservedQty: item.orderedQty,
            batchAllocations: allocations.get(String(item.medicineId)) || [],
          }));
        } else if (inventoryDelta.toConsume.length || inventoryDelta.toReturn.length) {
          await this.applyInventoryDelta(pharmacyId, inventoryDelta, session);
        }

        const updatedOrder = await this.orderRepo.update(updateFilter, updatePayload, { new: true, session });
        if (!updatedOrder) {
          throw new AppError({
            status: 409,
            code: 'ORDER_UPDATE_CONFLICT',
            message: 'Order changed before the update could be completed',
          });
        }
        return updatedOrder;
      });

      if ((hasExistingRecurring || hasRequestedRecurring) && nextCustomerId) {
        await this.queueSubscriptionSyncSafely(id, 'order_updated');
      }

      return updated;
    } catch (error) {
      throw error;
    }
  }

  async updateStatus(
    id: string,
    pharmacyId: string,
    payload: UpdateOrderStatusRequest
  ): Promise<IPharmacyOrder> {
    const order = await this.orderRepo.findById(id);
    if (!order) {
      throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    }
    if (String(order.pharmacyId) !== pharmacyId) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
    if (TERMINAL_STATUSES.includes(order.status)) {
      throw new AppError({ status: 400, code: 'ORDER_TERMINAL', message: 'Order is already in a terminal state' });
    }

    if (!ALLOWED_STATUS_TRANSITIONS[order.status].includes(payload.status)) {
      throw new AppError({
        status: 409,
        code: 'INVALID_ORDER_STATUS_TRANSITION',
        message: `Order cannot move from ${order.status} to ${payload.status}`,
      });
    }

    if (
      ['packed', 'ready_for_pickup', 'out_for_delivery'].includes(payload.status) &&
      order.paymentMode !== 'cash_on_delivery' &&
      order.paymentStatus !== 'paid'
    ) {
      throw new AppError({
        status: 409,
        code: 'ORDER_PAYMENT_REQUIRED',
        message: 'Payment must be completed before this order can progress',
      });
    }
    if (payload.status === 'completed' && order.paymentStatus !== 'paid') {
      throw new AppError({
        status: 409,
        code: 'ORDER_PAYMENT_REQUIRED',
        message: 'Payment must be completed before the order can be completed',
      });
    }

    const requiresPrescriptionCheck = PRESCRIPTION_GATED_STATUSES.includes(payload.status);
    if (
      requiresPrescriptionCheck &&
      order.prescriptionStatus !== 'approved' &&
      order.prescriptionStatus !== 'not_required'
    ) {
      throw new AppError({
        status: 409,
        code: 'ORDER_PRESCRIPTION_APPROVAL_REQUIRED',
        message: 'Prescription approval is required before the order can be completed',
      });
    }

    const inventoryItems = this.buildInventoryItems(
      order.items.filter((item) => item.itemStatus === 'active')
    );
    const shouldReturnInventory = ['abandoned', 'cancelled', 'rejected'].includes(payload.status);

    const updated = await this.runOrderInventoryTransaction(async (session) => {
      const nextOrder = await this.orderRepo.update(
        {
          _id: id,
          status: order.status,
          ...(requiresPrescriptionCheck
            ? { prescriptionStatus: order.prescriptionStatus }
            : {}),
        },
        { status: payload.status, ...(payload.notes ? { notes: payload.notes } : {}) },
        { new: true, session }
      );

      if (!nextOrder) {
        throw new AppError({ status: 500, code: 'UPDATE_FAILED', message: 'Failed to update status' });
      }

      if (shouldReturnInventory && inventoryItems.length) {
        await this.releaseOrderInventory(pharmacyId, order.items, session);
      }

      if (payload.status === 'completed') {
        await this.consumeOrderInventory(pharmacyId, order.items, session);
      }

      return nextOrder;
    });

    if (!updated) {
      throw new AppError({ status: 500, code: 'UPDATE_FAILED', message: 'Failed to update status' });
    }

    await this.queueSubscriptionSyncSafely(id, 'status_changed');
    if (updated.customerId) {
      await this.queueNotificationSafely(id, 'status_changed');
    }

    return updated;
  }

  /**
   * Pharmacist approves or rejects a pending prescription on the pharmacy's own order.
   * - The pharmacist must name the exact prescription documents reviewed; if the order's documents differ, the
   *   review is refused so nobody approves documents they did not see.
   * - Approve: prescriptionStatus -> approved; the order can then be packed/dispatched via the normal status flow.
   * - Reject: placed -> rejected, accepted -> cancelled; reserved stock is released in the same transaction.
   *   Paid/authorized money is NOT moved here: the review records refundRequired=true for finance to settle.
   * All writes are compare-and-set on the state that was read (status, payment, prescription and documents).
   */
  async reviewPrescription(id: string, pharmacyId: string, data: PrescriptionReviewRequest): Promise<IPharmacyOrder> {
    if (typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id)) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid order ID' });
    }
    const order = await this.orderRepo.findById(id);
    if (!order) throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (!pharmacyId || String(order.pharmacyId) !== pharmacyId) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
    if (TERMINAL_STATUSES.includes(order.status)) {
      throw new AppError({ status: 409, code: 'ORDER_TERMINAL', message: 'Order is already in a terminal state' });
    }
    if (order.prescriptionStatus !== 'pending') {
      throw new AppError({ status: 409, code: 'PRESCRIPTION_NOT_PENDING', message: 'This order has no prescription awaiting review' });
    }
    if (!['placed', 'accepted'].includes(order.status)) {
      // Packing/dispatch already requires approval, so a pending prescription can only be on placed/accepted.
      throw new AppError({ status: 409, code: 'ORDER_STATE_INCONSISTENT', message: 'Order state does not allow prescription review' });
    }
    const urls = Array.isArray(order.prescriptionUrls) ? order.prescriptionUrls.map(String) : [];
    const reviewed = data.reviewedPrescriptionUrls;
    if (reviewed.length !== urls.length || reviewed.some((url, i) => url !== urls[i])) {
      throw new AppError({ status: 409, code: 'PRESCRIPTION_CHANGED', message: 'Prescription documents changed; reload the order and review again' });
    }
    const approve = data.decision === 'approve';
    if (approve && !urls.length) {
      throw new AppError({ status: 409, code: 'PRESCRIPTION_REQUIRED', message: 'There is no prescription document to approve' });
    }
    const reason = data.reason?.trim();
    if (!approve && !reason) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'A reason is required to reject a prescription' });
    }

    const paymentStatus = order.paymentStatus ?? 'pending';
    const review: PrescriptionReview = {
      decision: approve ? 'approved' : 'rejected',
      pharmacistName: data.pharmacistName.trim(),
      pharmacistRegistrationNumber: data.pharmacistRegistrationNumber.trim(),
      ...(reason ? { reason } : {}),
      reviewedDocumentSetSha256: prescriptionDocumentSetSha256(urls),
      reviewedDocumentCount: urls.length,
      reviewedByPharmacyId: pharmacyId,
      reviewedAt: new Date(),
      orderStatusAtReview: order.status,
      paymentStatusAtReview: paymentStatus,
      refundRequired: !approve && ['paid', 'partially_paid', 'authorized'].includes(paymentStatus),
    };
    const fence = {
      _id: id,
      pharmacyId: order.pharmacyId,
      status: order.status,
      prescriptionStatus: 'pending',
      prescriptionUrls: { $eq: [...urls] },
      prescriptionReview: { $exists: false },
      ...(order.paymentStatus === undefined ? { paymentStatus: { $exists: false } } : { paymentStatus: order.paymentStatus }),
    };
    const stateChanged = () => new AppError({ status: 409, code: 'ORDER_STATE_CHANGED', message: 'Order changed while it was being reviewed; reload and try again' });

    if (approve) {
      const updated = await this.orderRepo.update(fence, { $set: { prescriptionStatus: 'approved', prescriptionReview: review } }, { new: true });
      if (!updated) throw stateChanged();
      if (updated.customerId) await this.queueNotificationSafely(id, 'order_updated');
      return updated;
    }

    const nextStatus: OrderStatus = order.status === 'placed' ? 'rejected' : 'cancelled';
    const rejectNote = `Prescription rejected by pharmacist: ${reason}`;
    const priorNotes = order.notes?.trim();
    const updated = await this.runOrderInventoryTransaction(async (session) => {
      const next = await this.orderRepo.update(fence, {
        $set: { prescriptionStatus: 'rejected', prescriptionReview: review, status: nextStatus,
          notes: priorNotes ? `${priorNotes}\n${rejectNote}` : rejectNote },
      }, { new: true, session });
      if (!next) throw stateChanged();
      await this.releaseOrderInventory(pharmacyId, order.items, session);
      return next;
    });
    await this.queueSubscriptionSyncSafely(id, 'status_changed');
    if (updated.customerId) await this.queueNotificationSafely(id, 'status_changed');
    return updated;
  }

  async markPaid(
    id: string,
    payload: {
      userType: string;
      pharmacyId?: string;
      userId: string;
      data: MarkOrderPaidRequest;
    }
  ): Promise<IPharmacyOrder> {
    const order = await this.orderRepo.findById(id);
    if (!order) {
      throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    }

    const isAdmin = payload.userType === 'admin';
    const isOwningPharmacy =
      payload.userType === 'pharmacy' && payload.pharmacyId && String(order.pharmacyId) === payload.pharmacyId;

    if (!isAdmin && !isOwningPharmacy) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }

    if (!order.paymentMode || !['cash_on_delivery', 'in_store_payment'].includes(order.paymentMode)) {
      throw new AppError({
        status: 400,
        code: 'MARK_PAID_NOT_ALLOWED',
        message: 'Only cash on delivery or in-store payment orders can be marked paid manually',
      });
    }

    if (order.paymentStatus === 'paid') {
      throw new AppError({
        status: 400,
        code: 'ORDER_ALREADY_PAID',
        message: 'This order is already marked as paid',
      });
    }

    if (order.paymentStatus === 'refunded') {
      throw new AppError({
        status: 400,
        code: 'ORDER_ALREADY_REFUNDED',
        message: 'A refunded order cannot be marked as paid',
      });
    }

    if (TERMINAL_STATUSES.includes(order.status)) {
      throw new AppError({
        status: 409,
        code: 'ORDER_TERMINAL',
        message: `A ${order.status} order cannot be marked as paid`,
      });
    }

    // A pharmacist-approved prescription order is already reviewed; recording its cash/in-store payment is not new
    // prescription commerce. Every other order keeps the prospective-commerce gate.
    const pharmacistApproved = order.prescriptionStatus === 'approved' && order.prescriptionReview?.decision === 'approved';
    if (!pharmacistApproved) await this.assertNewCommerceForOrder(order, id);

    const paidAt =
      payload.data.paidDate && payload.data.paidTime
        ? new Date(
            `${payload.data.paidDate.slice(0, 4)}-${payload.data.paidDate.slice(4, 6)}-${payload.data.paidDate.slice(
              6,
              8
            )}T${payload.data.paidTime}:00`
          )
        : new Date();

    if (Number.isNaN(paidAt.getTime())) {
      throw new AppError({
        status: 400,
        code: 'INVALID_PAID_AT',
        message: 'Invalid payment date or time',
      });
    }

    const existingNotes = order.notes?.trim();
    const paymentNote = payload.data.notes?.trim();
    const mergedNotes = paymentNote ? (existingNotes ? `${existingNotes}\n${paymentNote}` : paymentNote) : order.notes;

    const updated = await this.orderRepo.update(
      {
        _id: id,
        paymentStatus: { $nin: ['paid', 'refunded'] },
        // Exact observed status: the write below derives status from this read, so a concurrent status change
        // (e.g. accepted -> packed) must fail the compare-and-set rather than be overwritten with a stale value.
        status: { $eq: order.status, $nin: TERMINAL_STATUSES },
      },
      {
        paymentStatus: 'paid',
        paymentSource: payload.data.paymentSource?.trim() || order.paymentMode,
        paidAt,
        status: order.status === 'placed' ? 'accepted' : order.status,
        ...(mergedNotes !== undefined ? { notes: mergedNotes } : {}),
      }
    );

    if (!updated) {
      throw new AppError({
        status: 409,
        code: 'ORDER_PAYMENT_STATE_CHANGED',
        message: 'Order payment state changed while this request was being processed',
      });
    }

    await this.queueSubscriptionSyncSafely(id, 'order_marked_paid');
    if (updated.customerId) {
      await this.queueNotificationSafely(id, 'order_marked_paid');
    }

    return updated;
  }

  async linkHealthCheck(orderId: string, healthCheckId: string): Promise<void> {
    await this.orderRepo.update({ _id: orderId }, { linkedHealthCheckId: healthCheckId });
  }

  async abandonStaleUnpaidOrders(): Promise<void> {
    const cutoff = new Date(Date.now() - UNPAID_ORDER_ABANDON_WINDOW_MS);
    const staleOrders = await this.orderRepo.findStalePendingOnlineOrders(cutoff);

    for (const order of staleOrders) {
      const priorNotes = order.notes?.trim();
      const timeoutNote = 'Order auto-abandoned after 35 minutes because payment was not completed in time';
      const inventoryItems = this.buildInventoryItems(
        order.items.filter((item) => item.itemStatus === 'active')
      );

      const markedAbandoned = await this.runOrderInventoryTransaction(async (session) => {
        const nextOrder = await this.orderRepo.update(
          { _id: order._id, status: 'placed', paymentStatus: 'pending' },
          {
            status: 'abandoned',
            notes: priorNotes ? `${priorNotes}\n${timeoutNote}` : timeoutNote,
          },
          { new: true, session }
        );

        if (!nextOrder) {
          return null;
        }

        if (inventoryItems.length) {
          await this.releaseOrderInventory(String(order.pharmacyId), order.items, session);
        }

        return nextOrder;
      });

      if (!markedAbandoned) {
        continue;
      }

      await this.queueSubscriptionSyncSafely(String(order._id), 'order_abandoned');
      if (markedAbandoned.customerId) {
        await this.queueNotificationSafely(String(order._id), 'order_abandoned');
      }
    }
  }
}
